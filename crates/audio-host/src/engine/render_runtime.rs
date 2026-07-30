impl NativeMixerRuntime {
    fn handle_command(&mut self, command: EngineCommand) -> Option<Box<NativeMixerRuntime>> {
        match command {
            EngineCommand::LoadMixer(mut runtime) => {
                self.all_notes_off();
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
                    let mut position = self.transport.position_frames.load(Ordering::Relaxed);
                    // Auto-stop leaves the playhead at/past the finite content tail.
                    // Restart from the beginning so Play after song-end is not a no-op.
                    if self.content_end_frame > 0
                        && !self.has_infinite_tail
                        && self.tail_end_frame.is_some_and(|end| position >= end)
                    {
                        position = 0;
                        self.transport.position_frames.store(0, Ordering::Relaxed);
                    }
                    self.chase_notes(position);
                    if crate::midi_input::external_sync_enabled() {
                        self.transport
                            .clock_source
                            .store(1, Ordering::Relaxed);
                        self.transport.waiting_for.store(1, Ordering::Relaxed);
                        self.transport
                            .state
                            .store(TRANSPORT_WAITING, Ordering::Relaxed);
                    } else {
                        self.transport
                            .state
                            .store(TRANSPORT_PLAYING, Ordering::Relaxed);
                    }
                }
                TransportAction::Pause => {
                    self.all_notes_off();
                    self.transport.waiting_for.store(0, Ordering::Relaxed);
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                }
                TransportAction::Stop => {
                    self.all_notes_off();
                    self.transport.waiting_for.store(0, Ordering::Relaxed);
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
                    let tick = self
                        .tempo_map
                        .frame_to_tick(position, self.sample_rate)
                        .unwrap_or(0);
                    self.transport.position_ticks.store(tick, Ordering::Relaxed);
                    self.chase_notes(position);
                }
                TransportAction::Record => {
                    let position = self.transport.position_frames.load(Ordering::Relaxed);
                    self.chase_notes(position);
                    if crate::midi_input::external_sync_enabled() {
                        self.transport
                            .clock_source
                            .store(1, Ordering::Relaxed);
                        self.transport.waiting_for.store(2, Ordering::Relaxed);
                        self.transport
                            .state
                            .store(TRANSPORT_WAITING, Ordering::Relaxed);
                    } else {
                        self.transport
                            .state
                            .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                    }
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

    fn render_block(
        &mut self,
        inputs: &[InputFrame],
        outputs: &mut [HardwareOutputFrame],
        mut midi_input: Option<&mut crate::midi_input::RealtimeMidiConsumer>,
    ) -> bool {
        if inputs.len() != outputs.len() || outputs.len() > MAX_PLUGIN_BLOCK_FRAMES {
            outputs.fill([0.0; MAX_OUTPUT_CHANNELS]);
            return true;
        }

        if let Some(input) = midi_input.as_deref_mut() {
            self.transport.clock_source.store(
                u32::from(input.external_sync_enabled()),
                Ordering::Relaxed,
            );
            self.prepare_live_midi(outputs.len(), input);
        } else {
            self.live_midi_events.clear();
        }
        let has_monitor = self.monitor_input_routes.iter().any(Option::is_some)
            || self
                .live_midi_routes
                .iter()
                .flatten()
                .any(|route| route.monitoring);
        let mut offset = 0;
        let mut stream_underrun = false;
        while offset < outputs.len() {
            let state = self.transport.state.load(Ordering::Relaxed);
            let position = self.transport.position_frames.load(Ordering::Relaxed);
            let running = matches!(state, TRANSPORT_PLAYING | TRANSPORT_RECORDING);
            if !running && !has_monitor {
                outputs[offset..].fill([0.0; MAX_OUTPUT_CHANNELS]);
                break;
            }

            let mut frame_count = outputs.len() - offset;
            if running {
                frame_count = frame_count.min(self.frames_until_timing_boundary(
                    position,
                    frame_count,
                ));
            }
            if state == TRANSPORT_PLAYING
                && self.transport.clock_source.load(Ordering::Relaxed) == 0
                && self.content_end_frame > 0
                && !self.has_infinite_tail
                && let Some(end) = self.tail_end_frame
            {
                if position >= end {
                    self.all_notes_off();
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                    continue;
                }
                frame_count = frame_count.min((end - position) as usize);
            }

            let end = offset + frame_count;
            stream_underrun |= self.render_segment(
                &inputs[offset..end],
                &mut outputs[offset..end],
                position,
                state,
                offset,
                midi_input.as_deref_mut(),
            );
            offset = end;
            if running {
                let next = position.saturating_add(frame_count as u64);
                self.transport
                    .position_frames
                    .store(next, Ordering::Relaxed);
                if self.transport.clock_source.load(Ordering::Relaxed) == 0 {
                    let tick = self
                        .tempo_map
                        .frame_to_tick(next, self.sample_rate)
                        .unwrap_or(0);
                    self.transport.position_ticks.store(tick, Ordering::Relaxed);
                }
                if state == TRANSPORT_PLAYING
                    && self.transport.clock_source.load(Ordering::Relaxed) == 0
                    && self.content_end_frame > 0
                    && !self.has_infinite_tail
                    && self.tail_end_frame.is_some_and(|end| next >= end)
                {
                    self.all_notes_off();
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                }
            }
        }
        stream_underrun
    }

    fn render_segment(
        &mut self,
        inputs: &[InputFrame],
        outputs: &mut [HardwareOutputFrame],
        position: u64,
        state: u32,
        block_offset: usize,
        midi_input: Option<&mut crate::midi_input::RealtimeMidiConsumer>,
    ) -> bool {
        let frame_count = outputs.len();
        let used_sources = self
            .channel_input_widths
            .len()
            .saturating_mul(frame_count);
        self.channel_source_block[..used_sources].fill([0.0, 0.0]);
        for (channel_index, route) in self.monitor_input_routes.iter().enumerate() {
            if let Some([left, right]) = route {
                let start = channel_index * frame_count;
                for (frame, input) in inputs.iter().enumerate() {
                    self.channel_source_block[start + frame] = [input[*left], input[*right]];
                }
            }
        }

        let mut stream_underrun = false;
        if let Some(input) = midi_input {
            let segment_end = block_offset.saturating_add(frame_count);
            for index in 0..self.live_midi_events.len() {
                let live = self.live_midi_events[index];
                if (block_offset..segment_end).contains(&live.sample_offset) {
                    self.dispatch_live_midi_event(
                        live.event,
                        live.sample_offset - block_offset,
                        input,
                    );
                }
            }
        }
        if matches!(state, TRANSPORT_PLAYING | TRANSPORT_RECORDING) {
            for clip in &mut self.clips {
                for frame in 0..frame_count {
                    let project_frame = position.saturating_add(frame as u64);
                    let Some(relative) = project_frame.checked_sub(clip.start_frame) else {
                        continue;
                    };
                    let relative = relative as usize;
                    if relative >= clip.length_frames {
                        continue;
                    }
                    let is_streaming = matches!(&clip.samples, ClipSamples::Streaming(_));
                    if let Some(sample) = clip.sample_at(relative) {
                        let target =
                            &mut self.channel_source_block[clip.channel_index * frame_count + frame];
                        target[0] += sample[0];
                        target[1] += sample[1];
                    } else if is_streaming {
                        stream_underrun = true;
                    }
                }
            }

            // Dispatch clip MIDI and metronome clicks in per-frame order so a
            // later-frame clip event cannot reach instruments before an
            // earlier-frame metronome click within the same block.
            for frame in 0..frame_count {
                let project_frame = position.saturating_add(frame as u64);
                while self
                    .midi_events
                    .get(self.midi_cursor)
                    .is_some_and(|event| event.frame <= project_frame)
                {
                    let event = self.midi_events[self.midi_cursor];
                    if event.frame == project_frame {
                        self.dispatch_midi_event(event, frame);
                    }
                    self.midi_cursor += 1;
                }
                let metronome_events =
                    self.metronome
                        .events_at(&self.tempo_map, self.sample_rate, project_frame);
                for event in metronome_events.into_iter().flatten() {
                    self.dispatch_midi_event(event, frame);
                }
            }
        }

        let context = self.process_context(position, state);
        let input_widths = &self.channel_input_widths;
        let plugins = &mut self.plugins_by_channel;
        let generation = self.generation;
        let mut process_plugins = |channel_index: usize, frames: &mut [StereoFrame]| {
            let mut width = input_widths[channel_index];
            for plugin in &mut plugins[channel_index] {
                crate::crash_marker::mark(
                    generation,
                    plugin.marker_index,
                    crate::crash_marker::STAGE_PROCESS,
                );
                plugin.process_block(frames, &mut width, &context);
                crate::crash_marker::clean(generation);
            }
            if matches!(width, SignalWidth::Mono) {
                for frame in frames {
                    frame[1] = frame[0];
                }
            }
        };
        if self
            .graph
            .process_channel_source_block(
                &mut self.channel_source_block[..used_sources],
                outputs,
                &mut process_plugins,
            )
            .is_err()
        {
            outputs.fill([0.0; MAX_OUTPUT_CHANNELS]);
            stream_underrun = true;
        }
        stream_underrun
    }

    fn frames_until_timing_boundary(&self, position: u64, maximum: usize) -> usize {
        let end = position.saturating_add(maximum as u64);
        self.tempo_map
            .tempo_events()
            .iter()
            .skip(1)
            .map(|event| event.tick)
            .chain(
                self.tempo_map
                    .time_signature_events()
                    .iter()
                    .skip(1)
                    .map(|event| event.tick),
            )
            .filter_map(|tick| self.tempo_map.tick_to_frame(tick, self.sample_rate).ok())
            .filter(|frame| *frame > position && *frame < end)
            .min()
            .map_or(maximum, |boundary| (boundary - position) as usize)
    }

    fn process_context(&self, frame: u64, state: u32) -> ProcessContext {
        let external = self.transport.clock_source.load(Ordering::Relaxed) == 1;
        let tick = if external {
            self.transport.position_ticks.load(Ordering::Relaxed)
        } else {
            self.tempo_map
                .frame_to_tick(frame, self.sample_rate)
                .unwrap_or(0)
        };
        let nominal_tempo = self
            .tempo_map
            .tempo_events()
            .iter()
            .rev()
            .find(|event| event.tick <= tick)
            .map_or(120.0, |event| event.beats_per_minute);
        let external_tempo =
            f64::from_bits(self.transport.effective_bpm_bits.load(Ordering::Relaxed));
        let tempo = if external && external_tempo.is_finite() {
            external_tempo
        } else {
            nominal_tempo
        };
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

    fn dispatch_midi_event(&mut self, event: ScheduledMidiEvent, sample_offset: usize) {
        let sysex = match event.kind {
            ScheduledMidiEventKind::SysEx { offset, length } => {
                let start = offset as usize;
                let end = start.saturating_add(length as usize);
                self.midi_event_data.get(start..end)
            }
            _ => None,
        };
        let Some(plugin) = self.plugins_by_channel[event.channel_index]
            .iter_mut()
            .find(|plugin| plugin.is_instrument)
        else {
            return;
        };
        let Some(processor) = plugin.processor.as_mut() else {
            return;
        };
        match event.kind {
            ScheduledMidiEventKind::NoteOn {
                note_id,
                key,
                velocity,
            } => {
                processor.note_on(
                    sample_offset,
                    event.channel,
                    key,
                    velocity,
                    note_id,
                );
                if let Some(active) = self.active_notes.get_mut(note_id as usize) {
                    *active = true;
                }
            }
            ScheduledMidiEventKind::NoteOff {
                note_id,
                key,
                velocity,
            } => {
                processor.note_off(
                    sample_offset,
                    event.channel,
                    key,
                    velocity,
                    note_id,
                );
                if let Some(active) = self.active_notes.get_mut(note_id as usize) {
                    *active = false;
                }
            }
            ScheduledMidiEventKind::ControlChange { controller, value } => {
                processor.control_change(sample_offset, event.channel, controller, value);
            }
            ScheduledMidiEventKind::PitchBend { value } => {
                processor.pitch_bend(sample_offset, event.channel, value);
            }
            ScheduledMidiEventKind::ProgramChange { program } => {
                processor.program_change(sample_offset, event.channel, program);
            }
            ScheduledMidiEventKind::ChannelPressure { pressure } => {
                processor.channel_pressure(sample_offset, event.channel, pressure);
            }
            ScheduledMidiEventKind::PolyPressure { key, pressure } => {
                processor.poly_pressure(sample_offset, event.channel, key, pressure);
            }
            ScheduledMidiEventKind::SysEx { .. } => {
                if let Some(bytes) = sysex {
                    processor.sysex(sample_offset, bytes);
                }
            }
        }
    }

    fn prepare_live_midi(
        &mut self,
        frame_count: usize,
        input: &mut crate::midi_input::RealtimeMidiConsumer,
    ) {
        self.live_midi_events.clear();
        if input.take_panic() {
            self.all_live_notes_off();
        }
        if input.take_sync_lost() {
            self.all_notes_off();
            self.transport.waiting_for.store(0, Ordering::Relaxed);
            self.transport
                .state
                .store(TRANSPORT_STOPPED, Ordering::Relaxed);
        }
        let block_origin = crate::midi_input::monotonic_micros()
            .saturating_add(input.presentation_latency_micros());
        let block_duration = (frame_count as u64)
            .saturating_mul(1_000_000)
            .checked_div(u64::from(self.sample_rate))
            .unwrap_or(0);
        let deadline = block_origin.saturating_add(block_duration);
        while self.live_midi_events.len() < self.live_midi_events.capacity() {
            let Some(event) = input.next_before(deadline) else {
                break;
            };
            if matches!(
                event.message,
                crate::midi_input::RealtimeMidiMessage::Clock { .. }
                    | crate::midi_input::RealtimeMidiMessage::Start
                    | crate::midi_input::RealtimeMidiMessage::Continue
                    | crate::midi_input::RealtimeMidiMessage::Stop
                    | crate::midi_input::RealtimeMidiMessage::SongPosition { .. }
            ) {
                self.handle_external_sync(event.message);
                continue;
            }
            let sample_offset = event
                .timestamp_micros
                .saturating_sub(block_origin)
                .saturating_mul(u64::from(self.sample_rate))
                .checked_div(1_000_000)
                .unwrap_or(0)
                .min(frame_count.saturating_sub(1) as u64)
                as usize;
            self.live_midi_events.push(BlockMidiEvent {
                sample_offset,
                event,
            });
        }
    }

    fn handle_external_sync(&mut self, message: crate::midi_input::RealtimeMidiMessage) {
        use crate::midi_input::RealtimeMidiMessage;

        match message {
            RealtimeMidiMessage::Start => {
                self.all_notes_off();
                self.transport.position_frames.store(0, Ordering::Relaxed);
                self.transport.position_ticks.store(0, Ordering::Relaxed);
                self.midi_cursor = 0;
                let next_state = if self.transport.waiting_for.load(Ordering::Relaxed) == 2 {
                    TRANSPORT_RECORDING
                } else {
                    TRANSPORT_PLAYING
                };
                self.transport.waiting_for.store(0, Ordering::Relaxed);
                self.transport.state.store(next_state, Ordering::Relaxed);
            }
            RealtimeMidiMessage::Continue => {
                let next_state = if self.transport.waiting_for.load(Ordering::Relaxed) == 2 {
                    TRANSPORT_RECORDING
                } else {
                    TRANSPORT_PLAYING
                };
                self.transport.waiting_for.store(0, Ordering::Relaxed);
                self.transport.state.store(next_state, Ordering::Relaxed);
            }
            RealtimeMidiMessage::Stop => {
                self.all_notes_off();
                self.transport.waiting_for.store(0, Ordering::Relaxed);
                self.transport
                    .state
                    .store(TRANSPORT_STOPPED, Ordering::Relaxed);
            }
            RealtimeMidiMessage::SongPosition { position } => {
                let tick = u64::from(position)
                    .saturating_mul(yadaw_dsp_runtime::midi_input::MUSICAL_TICKS_PER_SONG_POSITION);
                self.transport.position_ticks.store(tick, Ordering::Relaxed);
                if let Ok(frame) = self.tempo_map.tick_to_frame(tick, self.sample_rate) {
                    self.transport
                        .position_frames
                        .store(frame, Ordering::Relaxed);
                    self.chase_notes(frame);
                }
            }
            RealtimeMidiMessage::Clock { effective_bpm_bits } => {
                let bpm = f64::from_bits(effective_bpm_bits);
                self.transport
                    .effective_bpm_bits
                    .store(effective_bpm_bits, Ordering::Relaxed);
                if bpm.is_finite()
                    && matches!(
                        self.transport.state.load(Ordering::Relaxed),
                        TRANSPORT_PLAYING | TRANSPORT_RECORDING
                    )
                {
                    self.transport.position_ticks.fetch_add(
                        yadaw_dsp_runtime::midi_input::MUSICAL_TICKS_PER_MIDI_CLOCK,
                        Ordering::Relaxed,
                    );
                }
            }
            _ => {}
        }
    }

    fn dispatch_live_midi_event(
        &mut self,
        event: crate::midi_input::RealtimeMidiEvent,
        sample_offset: usize,
        input: &mut crate::midi_input::RealtimeMidiConsumer,
    ) {
        use crate::midi_input::RealtimeMidiMessage;

        let sysex_length = match event.message {
            RealtimeMidiMessage::SysEx { length } => length as usize,
            _ => 0,
        };
        if sysex_length > 0
            && (sysex_length > self.live_sysex_scratch.len()
                || !input.pop_sysex(&mut self.live_sysex_scratch[..sysex_length]))
        {
            self.all_live_notes_off();
            return;
        }
        for channel_index in 0..self.live_midi_routes.len() {
            let Some(route) = self.live_midi_routes[channel_index] else {
                continue;
            };
            if !route.monitoring
                || route.port_key.is_some_and(|key| key != event.port_key)
                || route.channel.is_some_and(|channel| channel != event.channel)
            {
                continue;
            }
            let Some(processor) = self.plugins_by_channel[channel_index]
                .iter_mut()
                .find(|plugin| plugin.is_instrument)
                .and_then(|plugin| plugin.processor.as_mut())
            else {
                continue;
            };
            match event.message {
                RealtimeMidiMessage::NoteOn { key, velocity } => {
                    let note_id = -2 - i32::from(event.channel) * 128 - i32::from(key);
                    processor.note_on(
                        sample_offset,
                        event.channel,
                        key,
                        velocity,
                        note_id,
                    );
                    let active = channel_index * 16 * 128
                        + usize::from(event.channel) * 128
                        + usize::from(key);
                    if let Some(value) = self.live_notes.get_mut(active) {
                        *value = true;
                    }
                }
                RealtimeMidiMessage::NoteOff { key, velocity } => {
                    let note_id = -2 - i32::from(event.channel) * 128 - i32::from(key);
                    processor.note_off(
                        sample_offset,
                        event.channel,
                        key,
                        velocity,
                        note_id,
                    );
                    let active = channel_index * 16 * 128
                        + usize::from(event.channel) * 128
                        + usize::from(key);
                    if let Some(value) = self.live_notes.get_mut(active) {
                        *value = false;
                    }
                }
                RealtimeMidiMessage::PolyPressure { key, pressure } => {
                    processor.poly_pressure(sample_offset, event.channel, key, pressure);
                }
                RealtimeMidiMessage::ControlChange { controller, value } => {
                    processor.control_change(sample_offset, event.channel, controller, value);
                }
                RealtimeMidiMessage::ProgramChange { program } => {
                    processor.program_change(sample_offset, event.channel, program);
                }
                RealtimeMidiMessage::ChannelPressure { pressure } => {
                    processor.channel_pressure(sample_offset, event.channel, pressure);
                }
                RealtimeMidiMessage::PitchBend { value } => {
                    processor.pitch_bend(sample_offset, event.channel, value);
                }
                RealtimeMidiMessage::SysEx { .. } => {
                    processor.sysex(
                        sample_offset,
                        &self.live_sysex_scratch[..sysex_length],
                    );
                }
                RealtimeMidiMessage::Clock { .. }
                | RealtimeMidiMessage::Start
                | RealtimeMidiMessage::Continue
                | RealtimeMidiMessage::Stop
                | RealtimeMidiMessage::SongPosition { .. } => {}
            }
        }
    }

    fn all_live_notes_off(&mut self) {
        for active in 0..self.live_notes.len() {
            if !self.live_notes[active] {
                continue;
            }
            self.live_notes[active] = false;
            let channel_index = active / (16 * 128);
            let within_channel = active % (16 * 128);
            let channel = (within_channel / 128) as u8;
            let key = (within_channel % 128) as u8;
            if let Some(processor) = self.plugins_by_channel[channel_index]
                .iter_mut()
                .find(|plugin| plugin.is_instrument)
                .and_then(|plugin| plugin.processor.as_mut())
            {
                let note_id = -2 - i32::from(channel) * 128 - i32::from(key);
                processor.note_off(0, channel, key, 0, note_id);
            }
        }
    }

    fn all_notes_off(&mut self) {
        self.all_live_notes_off();
        if let Some(event) = self.metronome.release() {
            self.dispatch_midi_event(event, 0);
        }
        for index in 0..self.midi_events.len() {
            let event = self.midi_events[index];
            let ScheduledMidiEventKind::NoteOn {
                note_id,
                key,
                ..
            } = event.kind
            else {
                continue;
            };
            if self
                    .active_notes
                    .get(note_id as usize)
                    .copied()
                    .unwrap_or(false)
                {
                self.dispatch_midi_event(ScheduledMidiEvent {
                    kind: ScheduledMidiEventKind::NoteOff {
                        note_id,
                        key,
                        velocity: 0,
                    },
                    ..event
                }, 0);
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
            match event.kind {
                ScheduledMidiEventKind::NoteOn { note_id, .. } => {
                    if let Some(active) = self.active_notes.get_mut(note_id as usize) {
                        *active = true;
                    }
                }
                ScheduledMidiEventKind::NoteOff { note_id, .. } => {
                    if let Some(active) = self.active_notes.get_mut(note_id as usize) {
                        *active = false;
                    }
                }
                _ => {}
            }
        }
        for index in 0..self.midi_cursor {
            let event = self.midi_events[index];
            let ScheduledMidiEventKind::NoteOn { note_id, .. } = event.kind else {
                continue;
            };
            if self
                    .active_notes
                    .get(note_id as usize)
                    .copied()
                    .unwrap_or(false)
                {
                self.dispatch_midi_event(event, 0);
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
