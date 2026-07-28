impl NativeMixerRuntime {
    fn handle_command(&mut self, command: EngineCommand) -> Option<Box<NativeMixerRuntime>> {
        match command {
            EngineCommand::LoadMixer(mut runtime) => {
                let position = runtime.transport.position_frames.load(Ordering::Relaxed);
                runtime.metronome.reposition(
                    &runtime.tempo_map,
                    runtime.sample_rate,
                    position,
                    true,
                );
                return Some(runtime);
            }
            EngineCommand::Preview(preview) => {
                let result = match preview.parameter {
                    RealtimeParameter::ChannelGain => self
                        .graph
                        .channel_index(preview.id())
                        .and_then(|index| {
                            self.graph.preview_channel_gain(index, preview.value).ok()
                        }),
                    RealtimeParameter::ChannelPan => self
                        .graph
                        .channel_index(preview.id())
                        .and_then(|index| {
                            self.graph.preview_channel_pan(index, preview.value).ok()
                        }),
                    RealtimeParameter::SendLevel => self
                        .graph
                        .send_index(preview.id())
                        .and_then(|index| {
                            self.graph.preview_send_level(index, preview.value).ok()
                        }),
                };
                let _ = result;
            }
            EngineCommand::Transport(action, position) => match action {
                TransportAction::Play => {
                    let position = self.transport.position_frames.load(Ordering::Relaxed);
                    self.chase_notes(position);
                    self.transport
                        .state
                        .store(TRANSPORT_PLAYING, Ordering::Relaxed);
                }
                TransportAction::Pause => {
                    self.all_notes_off();
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                }
                TransportAction::Stop => {
                    self.all_notes_off();
                    self.graph.clear_delays();
                    for plugin in self.plugins_by_channel.iter_mut().flatten() {
                        plugin.bypass_delay.clear();
                    }
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                    self.transport.position_frames.store(0, Ordering::Relaxed);
                    self.midi_cursor = 0;
                    self.metronome
                        .reposition(&self.tempo_map, self.sample_rate, 0, true);
                }
                TransportAction::Seek => {
                    self.transport
                        .position_frames
                        .store(position, Ordering::Relaxed);
                    self.chase_notes(position);
                }
                TransportAction::Record => {
                    let position = self.transport.position_frames.load(Ordering::Relaxed);
                    self.chase_notes(position);
                    self.transport
                        .state
                        .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                }
            },
            EngineCommand::ClearMeterClips => {
                self.held_peaks.fill([0.0, 0.0]);
                self.held_until.fill([0, 0]);
                for meter in &self.meter_bank.channels {
                    meter.clear_clip();
                }
            }
        }
        None
    }

    fn render_frame(&mut self, input: InputFrame) -> (HardwareOutputFrame, bool) {
        let state = self.transport.state.load(Ordering::Relaxed);
        let position = self.transport.position_frames.load(Ordering::Relaxed);
        self.channel_sources.fill([0.0, 0.0]);
        let mut has_monitor = false;
        for (channel_index, route) in self.monitor_input_routes.iter().enumerate() {
            if let Some([left, right]) = route {
                has_monitor = true;
                self.channel_sources[channel_index] = [input[*left], input[*right]];
            }
        }
        if state == TRANSPORT_STOPPED && !has_monitor {
            return ([0.0; MAX_OUTPUT_CHANNELS], false);
        }
        let mut stream_underrun = false;
        if state != TRANSPORT_STOPPED {
            for clip in &mut self.clips {
                let Some(relative) = position.checked_sub(clip.start_frame) else {
                    continue;
                };
                let relative = relative as usize;
                if relative >= clip.length_frames {
                    continue;
                }
                let is_streaming = matches!(&clip.samples, ClipSamples::Streaming(_));
                if let Some(sample) = clip.sample_at(relative) {
                    let target = &mut self.channel_sources[clip.channel_index];
                    target[0] += sample[0];
                    target[1] += sample[1];
                } else if is_streaming {
                    stream_underrun = true;
                }
            }
            while self
                .midi_events
                .get(self.midi_cursor)
                .is_some_and(|event| event.frame <= position)
            {
                let event = self.midi_events[self.midi_cursor];
                if event.frame == position {
                    self.dispatch_midi_event(event);
                }
                self.midi_cursor += 1;
            }
            let metronome_events =
                self.metronome
                    .events_at(&self.tempo_map, self.sample_rate, position);
            for event in metronome_events.into_iter().flatten() {
                self.dispatch_midi_event(event);
            }
        }
        let context = self.process_context(position, state);
        let sources = &self.channel_sources;
        let input_widths = &self.channel_input_widths;
        let plugins = &mut self.plugins_by_channel;
        let generation = self.generation;
        let mut process_plugins = |channel_index: usize, mut frame: StereoFrame| {
            let mut width = input_widths[channel_index];
            for plugin in &mut plugins[channel_index] {
                crate::crash_marker::mark(
                    generation,
                    plugin.marker_index,
                    crate::crash_marker::STAGE_PROCESS,
                );
                frame = plugin.process(frame, &mut width, &context);
                crate::crash_marker::clean(generation);
            }
            match width {
                SignalWidth::Mono => [frame[0], frame[0]],
                SignalWidth::Stereo => frame,
            }
        };
        let result = self
            .graph
            .process_channel_sources(sources, &mut process_plugins);
        let next = if state == TRANSPORT_STOPPED {
            position
        } else {
            let next = position.saturating_add(1);
            self.transport
                .position_frames
                .store(next, Ordering::Relaxed);
            next
        };
        if state == TRANSPORT_PLAYING
            && self.content_end_frame > 0
            && !self.has_infinite_tail
            && self.tail_end_frame.is_some_and(|end| next >= end)
        {
            self.all_notes_off();
            self.transport
                .state
                .store(TRANSPORT_STOPPED, Ordering::Relaxed);
        }
        (result, stream_underrun)
    }

    fn process_context(&self, frame: u64, state: u32) -> ProcessContext {
        let tick = self
            .tempo_map
            .frame_to_tick(frame, self.sample_rate)
            .unwrap_or(0);
        let tempo = self
            .tempo_map
            .tempo_events()
            .iter()
            .rev()
            .find(|event| event.tick <= tick)
            .map_or(120.0, |event| event.beats_per_minute);
        let signature = self
            .tempo_map
            .time_signature_events()
            .iter()
            .rev()
            .find(|event| event.tick <= tick)
            .copied()
            .unwrap_or(TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            });
        let bar_ticks = u64::from(MUSICAL_TICKS_PER_QUARTER)
            .saturating_mul(4)
            .saturating_mul(u64::from(signature.numerator))
            / u64::from(signature.denominator);
        let bar_tick = tick
            .saturating_sub(signature.tick)
            .checked_div(bar_ticks)
            .map(|bars| signature.tick + bars.saturating_mul(bar_ticks))
            .unwrap_or(signature.tick);
        ProcessContext {
            project_time_samples: frame.min(i64::MAX as u64) as i64,
            continuous_time_samples: frame.min(i64::MAX as u64) as i64,
            project_time_quarters: tick as f64 / f64::from(MUSICAL_TICKS_PER_QUARTER),
            bar_position_quarters: bar_tick as f64 / f64::from(MUSICAL_TICKS_PER_QUARTER),
            tempo,
            time_signature_numerator: i32::from(signature.numerator),
            time_signature_denominator: i32::from(signature.denominator),
            playing: state == TRANSPORT_PLAYING,
            recording: state == TRANSPORT_RECORDING,
        }
    }

    fn dispatch_midi_event(&mut self, event: ScheduledMidiEvent) {
        let Some(plugin) = self.plugins_by_channel[event.channel_index]
            .iter_mut()
            .find(|plugin| plugin.is_instrument)
        else {
            return;
        };
        let Some(processor) = plugin.processor.as_mut() else {
            return;
        };
        if event.note_on {
            processor.note_on(event.channel, event.key, event.velocity, event.note_id);
        } else {
            processor.note_off(event.channel, event.key, event.velocity, event.note_id);
        }
        if let Some(active) = self.active_notes.get_mut(event.note_id as usize) {
            *active = event.note_on;
        }
    }

    fn all_notes_off(&mut self) {
        if let Some(event) = self.metronome.release() {
            self.dispatch_midi_event(event);
        }
        for index in 0..self.midi_events.len() {
            let event = self.midi_events[index];
            if event.note_on
                && self
                    .active_notes
                    .get(event.note_id as usize)
                    .copied()
                    .unwrap_or(false)
            {
                self.dispatch_midi_event(ScheduledMidiEvent {
                    note_on: false,
                    velocity: 0,
                    ..event
                });
            }
        }
        self.active_notes.fill(false);
    }

    fn chase_notes(&mut self, position: u64) {
        self.all_notes_off();
        self.active_notes.fill(false);
        self.midi_cursor = self
            .midi_events
            .partition_point(|event| event.frame < position);
        for event in self.midi_events.iter().take(self.midi_cursor) {
            if let Some(active) = self.active_notes.get_mut(event.note_id as usize) {
                *active = event.note_on;
            }
        }
        for index in 0..self.midi_cursor {
            let event = self.midi_events[index];
            if event.note_on
                && self
                    .active_notes
                    .get(event.note_id as usize)
                    .copied()
                    .unwrap_or(false)
            {
                self.dispatch_midi_event(event);
            }
        }
        self.metronome
            .reposition(&self.tempo_map, self.sample_rate, position, true);
    }

    fn publish_peaks(&mut self, elapsed_frames: usize) {
        self.graph.write_meters(&mut self.peak_scratch);
        self.input_peaks.take_all(&mut self.input_peak_scratch);
        for (index, route) in self.input_meter_routes.iter().enumerate() {
            if let Some([left, right]) = route {
                let input = [
                    self.input_peak_scratch[*left],
                    self.input_peak_scratch[*right],
                ];
                self.peak_scratch[index].pre = input;
                self.peak_scratch[index].post = input;
            }
        }
        self.meter_frame_clock = self.meter_frame_clock.saturating_add(elapsed_frames as u64);
        let position = self.meter_frame_clock;
        let hold_frames = u64::from(self.sample_rate) * 3 / 2;
        for (index, peak) in self.peak_scratch.iter().copied().enumerate() {
            for side in 0..2 {
                if peak.post[side] >= self.held_peaks[index][side]
                    || position >= self.held_until[index][side]
                {
                    self.held_peaks[index][side] = peak.post[side];
                    self.held_until[index][side] = position.saturating_add(hold_frames);
                }
            }
            if let Some(meter) = self.meter_bank.channels.get(index) {
                meter.store(
                    ChannelPeak {
                        pre: peak.pre,
                        post: peak.post,
                    },
                    self.held_peaks[index],
                );
            }
        }
    }
}
