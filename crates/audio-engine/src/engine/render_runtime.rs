use super::{
    BlockMidiEvent, ChannelPeak, ClipSamples, CountInState, EngineCommand, HardwareOutputFrame,
    InputFrame, MAX_OUTPUT_CHANNELS, MAX_PLUGIN_BLOCK_FRAMES, MUSICAL_TICKS_PER_QUARTER,
    NativeMixerRuntime, Ordering, ProcessContext, RealtimeParameter, ScheduledMidiEvent,
    ScheduledMidiEventKind, SignalWidth, StereoFrame, TRANSPORT_COUNTING_IN, TRANSPORT_PLAYING,
    TRANSPORT_RECORDING, TRANSPORT_STOPPED, TRANSPORT_WAITING, TimeSignatureEvent, TransportAction,
};

impl NativeMixerRuntime {
    pub(super) fn render_block(
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
            self.external_sync_enabled = input.external_sync_enabled();
            self.transport
                .clock_source
                .store(u32::from(self.external_sync_enabled), Ordering::Relaxed);
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
            let transport_position = self.transport.position_frames.load(Ordering::Relaxed);
            let counting_in = state == TRANSPORT_COUNTING_IN;
            let position = if counting_in {
                let Some(count_in) = self.count_in else {
                    self.transport
                        .state
                        .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                    continue;
                };
                count_in.virtual_position
            } else {
                transport_position
            };
            let running = matches!(state, TRANSPORT_PLAYING | TRANSPORT_RECORDING);
            let advancing = running || counting_in;
            if !advancing && !has_monitor {
                outputs[offset..].fill([0.0; MAX_OUTPUT_CHANNELS]);
                break;
            }

            let playback_loop = self.playback_loop_frames(state);
            if let Some((loop_start, loop_end)) = playback_loop
                && position >= loop_end
            {
                self.rewind_playback_loop(loop_start);
                continue;
            }

            let mut frame_count = outputs.len() - offset;
            if advancing {
                frame_count =
                    frame_count.min(self.frames_until_timing_boundary(position, frame_count));
            }
            if let Some(count_in) = self.count_in.filter(|_| counting_in) {
                frame_count = frame_count
                    .min(usize::try_from(count_in.remaining_frames()).unwrap_or(usize::MAX));
                if frame_count == 0 {
                    let record_position = count_in.record_position;
                    self.count_in = None;
                    self.chase_notes(record_position);
                    self.transport
                        .state
                        .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                    continue;
                }
            }
            if let Some((_, loop_end)) = playback_loop {
                frame_count = frame_count.min((loop_end - position) as usize);
            }
            if state == TRANSPORT_PLAYING
                && self.transport.clock_source.load(Ordering::Relaxed) == 0
                && playback_loop.is_none()
            {
                if position >= self.project_end_frame {
                    self.all_notes_off();
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                    continue;
                }
                frame_count = frame_count.min((self.project_end_frame - position) as usize);
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
            if counting_in {
                let advanced = u64::try_from(frame_count).unwrap_or(u64::MAX);
                let complete = if let Some(count_in) = self.count_in.as_mut() {
                    count_in.virtual_position = count_in.virtual_position.saturating_add(advanced);
                    count_in.virtual_position >= count_in.end_frame
                } else {
                    true
                };
                if complete {
                    let record_position = self
                        .count_in
                        .take()
                        .map_or(transport_position, |value| value.record_position);
                    self.chase_notes(record_position);
                    self.transport
                        .state
                        .store(TRANSPORT_RECORDING, Ordering::Relaxed);
                }
            } else if running {
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
                if let Some((loop_start, loop_end)) = playback_loop
                    && next >= loop_end
                {
                    self.rewind_playback_loop(loop_start);
                    continue;
                }
                if state == TRANSPORT_PLAYING
                    && self.transport.clock_source.load(Ordering::Relaxed) == 0
                    && playback_loop.is_none()
                    && next >= self.project_end_frame
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
        let used_sources = self.channel_input_widths.len().saturating_mul(frame_count);
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
        if matches!(
            state,
            TRANSPORT_PLAYING | TRANSPORT_RECORDING | TRANSPORT_COUNTING_IN
        ) {
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
                        let gain = clip.gain_at(relative);
                        let target = &mut self.channel_source_block
                            [clip.channel_index * frame_count + frame];
                        target[0] += sample[0] * gain;
                        target[1] += sample[1] * gain;
                    } else if is_streaming {
                        stream_underrun = true;
                    }
                }
            }
        }
        if matches!(
            state,
            TRANSPORT_PLAYING | TRANSPORT_RECORDING | TRANSPORT_COUNTING_IN
        ) {
            // Timeline MIDI and metronome clicks remain in per-frame order so
            // accompaniment can provide the count-in without later events
            // overtaking an earlier click in the same block.
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
        let mut process_plugins =
            |channel_index: usize, frames: &mut [StereoFrame], post_pan: &[StereoFrame]| {
                let mut width = input_widths[channel_index];
                for plugin in &mut plugins[channel_index] {
                    crate::crash_marker::mark(
                        generation,
                        plugin.marker_index,
                        crate::crash_marker::STAGE_PROCESS,
                    );
                    plugin.process_block(frames, &mut width, &context, post_pan);
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
}

#[path = "render_runtime/commands.rs"]
mod commands;
#[path = "render_runtime/meter_publication.rs"]
mod meter_publication;
#[path = "render_runtime/midi.rs"]
mod midi;
#[path = "render_runtime/timing.rs"]
mod timing;
#[path = "render_runtime/transport.rs"]
mod transport;
