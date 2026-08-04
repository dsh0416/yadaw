use super::{
    BlockMidiEvent, NativeMixerRuntime, Ordering, ScheduledMidiEvent, ScheduledMidiEventKind,
    TRANSPORT_PLAYING, TRANSPORT_RECORDING, TRANSPORT_STOPPED,
};

impl NativeMixerRuntime {
    pub(super) fn dispatch_midi_event(&mut self, event: ScheduledMidiEvent, sample_offset: usize) {
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
                processor.note_on(sample_offset, event.channel, key, velocity, note_id);
                if let Some(active) = self.active_notes.get_mut(note_id as usize) {
                    *active = true;
                }
            }
            ScheduledMidiEventKind::NoteOff {
                note_id,
                key,
                velocity,
            } => {
                processor.note_off(sample_offset, event.channel, key, velocity, note_id);
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

    pub(super) fn prepare_live_midi(
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
                .min(frame_count.saturating_sub(1) as u64) as usize;
            self.live_midi_events.push(BlockMidiEvent {
                sample_offset,
                event,
            });
        }
    }

    pub(in crate::runtime) fn handle_external_sync(
        &mut self,
        message: crate::midi_input::RealtimeMidiMessage,
    ) {
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
                    .saturating_mul(heron_dsp_runtime::midi_input::MUSICAL_TICKS_PER_SONG_POSITION);
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
                        heron_dsp_runtime::midi_input::MUSICAL_TICKS_PER_MIDI_CLOCK,
                        Ordering::Relaxed,
                    );
                }
            }
            _ => {}
        }
    }

    pub(super) fn dispatch_live_midi_event(
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
                || route
                    .channel
                    .is_some_and(|channel| channel != event.channel)
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
                    processor.note_on(sample_offset, event.channel, key, velocity, note_id);
                    let active = channel_index * 16 * 128
                        + usize::from(event.channel) * 128
                        + usize::from(key);
                    if let Some(value) = self.live_notes.get_mut(active) {
                        *value = true;
                    }
                }
                RealtimeMidiMessage::NoteOff { key, velocity } => {
                    let note_id = -2 - i32::from(event.channel) * 128 - i32::from(key);
                    processor.note_off(sample_offset, event.channel, key, velocity, note_id);
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
                    processor.sysex(sample_offset, &self.live_sysex_scratch[..sysex_length]);
                }
                RealtimeMidiMessage::Clock { .. }
                | RealtimeMidiMessage::Start
                | RealtimeMidiMessage::Continue
                | RealtimeMidiMessage::Stop
                | RealtimeMidiMessage::SongPosition { .. } => {}
            }
        }
    }

    pub(super) fn all_live_notes_off(&mut self) {
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

    pub(super) fn all_notes_off(&mut self) {
        self.all_live_notes_off();
        if let Some(event) = self.metronome.release() {
            self.dispatch_midi_event(event, 0);
        }
        for index in 0..self.midi_events.len() {
            let event = self.midi_events[index];
            let ScheduledMidiEventKind::NoteOn { note_id, key, .. } = event.kind else {
                continue;
            };
            if self
                .active_notes
                .get(note_id as usize)
                .copied()
                .unwrap_or(false)
            {
                self.dispatch_midi_event(
                    ScheduledMidiEvent {
                        kind: ScheduledMidiEventKind::NoteOff {
                            note_id,
                            key,
                            velocity: 0,
                        },
                        ..event
                    },
                    0,
                );
            }
        }
        self.active_notes.fill(false);
    }

    pub(super) fn chase_notes(&mut self, position: u64) {
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
}
