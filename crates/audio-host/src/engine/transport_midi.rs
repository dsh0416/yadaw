struct LivePlugin {
    processor: Option<Vst3ProcessorHandle>,
    audio_mode: PluginAudioMode,
    enabled: bool,
    is_instrument: bool,
    bypass_delay: StereoDelayLine,
    marker_index: usize,
}

impl LivePlugin {
    fn process_block(
        &mut self,
        frames: &mut [StereoFrame],
        width: &mut SignalWidth,
        context: &ProcessContext,
    ) {
        for frame in frames.iter_mut() {
            *frame = self.prepare_input(*frame, *width);
        }
        let output_width = self.output_width();
        if !self.enabled {
            *width = output_width;
            for frame in frames {
                *frame = self.bypass_delay.process(self.passthrough(*frame));
            }
            return;
        }
        let Some(processor) = self.processor.as_mut() else {
            *width = output_width;
            if !self.is_instrument {
                for frame in frames {
                    *frame = self.passthrough(*frame);
                }
            }
            return;
        };
        *width = output_width;
        if !processor.process_block(frames, context) && !self.is_instrument {
            for frame in frames {
                *frame = self.passthrough(*frame);
            }
        }
    }

    fn prepare_input(&self, input: StereoFrame, width: SignalWidth) -> StereoFrame {
        if self.is_instrument {
            return [0.0; 2];
        }
        match self.audio_mode {
            PluginAudioMode::Mono | PluginAudioMode::MonoToStereo => match width {
                SignalWidth::Mono => [input[0], 0.0],
                SignalWidth::Stereo => [(input[0] + input[1]) * 0.5, 0.0],
            },
            PluginAudioMode::Stereo | PluginAudioMode::DualMono => match width {
                SignalWidth::Mono => [input[0], input[0]],
                SignalWidth::Stereo => input,
            },
        }
    }

    fn passthrough(&self, input: StereoFrame) -> StereoFrame {
        match self.audio_mode {
            PluginAudioMode::Mono => [input[0], 0.0],
            PluginAudioMode::MonoToStereo => [input[0], input[0]],
            PluginAudioMode::Stereo | PluginAudioMode::DualMono => input,
        }
    }

    fn output_width(&self) -> SignalWidth {
        match self.audio_mode {
            PluginAudioMode::Mono => SignalWidth::Mono,
            PluginAudioMode::MonoToStereo | PluginAudioMode::Stereo | PluginAudioMode::DualMono => {
                SignalWidth::Stereo
            }
        }
    }
}

#[derive(Clone, Copy)]
enum SignalWidth {
    Mono,
    Stereo,
}

#[derive(Clone, Copy)]
enum ScheduledMidiEventKind {
    NoteOn { note_id: i32, key: u8, velocity: u8 },
    NoteOff { note_id: i32, key: u8, velocity: u8 },
    ControlChange { controller: u8, value: u8 },
    PitchBend { value: u16 },
    ProgramChange { program: u8 },
    ChannelPressure { pressure: u8 },
    PolyPressure { key: u8, pressure: u8 },
    SysEx { offset: u32, length: u32 },
}

impl ScheduledMidiEventKind {
    const fn sort_rank(self) -> u8 {
        match self {
            Self::NoteOff { .. } => 0,
            Self::ControlChange { .. }
            | Self::PitchBend { .. }
            | Self::ProgramChange { .. }
            | Self::ChannelPressure { .. }
            | Self::PolyPressure { .. }
            | Self::SysEx { .. } => 1,
            Self::NoteOn { .. } => 2,
        }
    }
}

#[derive(Clone, Copy)]
struct ScheduledMidiEvent {
    frame: u64,
    channel_index: usize,
    channel: u8,
    kind: ScheduledMidiEventKind,
}

#[derive(Clone, Copy)]
struct LiveMidiRoute {
    port_key: Option<u64>,
    channel: Option<u8>,
    monitoring: bool,
}

#[derive(Clone, Copy)]
struct BlockMidiEvent {
    sample_offset: usize,
    event: crate::midi_input::RealtimeMidiEvent,
}

#[derive(Clone, Copy)]
struct BeatBoundary {
    tick: u64,
    frame: u64,
    accent: bool,
}

#[derive(Clone, Copy)]
struct CountInState {
    virtual_position: u64,
    end_frame: u64,
    record_position: u64,
}

impl CountInState {
    fn one_bar(tempo_map: &TempoMap, sample_rate: u32, record_position: u64) -> Option<Self> {
        let position_tick = tempo_map.frame_to_tick(record_position, sample_rate).ok()?;
        let signatures = tempo_map.time_signature_events();
        let signature_index = signatures
            .partition_point(|event| event.tick <= position_tick)
            .saturating_sub(1);
        let signature = *signatures.get(signature_index)?;
        let beat_ticks =
            u64::from(MUSICAL_TICKS_PER_QUARTER) * 4 / u64::from(signature.denominator);
        let bar_ticks = beat_ticks.checked_mul(u64::from(signature.numerator))?;
        let current_bar_index = position_tick
            .saturating_sub(signature.tick)
            .checked_div(bar_ticks)?;
        let current_bar_start_tick = signature
            .tick
            .checked_add(current_bar_index.checked_mul(bar_ticks)?)?;
        let (start_tick, end_frame) = if let Some(start_tick) = position_tick
            .checked_sub(bar_ticks)
            .filter(|start_tick| *start_tick >= signature.tick)
        {
            // When timeline material exists before the record cursor, use it as
            // a real pre-roll so a muted metronome can still count in from the
            // backing track. The public playhead remains parked at the record
            // position until this range has finished.
            (start_tick, record_position)
        } else {
            // At the beginning of a project there is no earlier timeline to
            // render, so retain a full synthetic bar for the click (or silence).
            let end_tick = current_bar_start_tick.checked_add(bar_ticks)?;
            (
                current_bar_start_tick,
                tempo_map.tick_to_frame(end_tick, sample_rate).ok()?,
            )
        };
        let virtual_position = tempo_map.tick_to_frame(start_tick, sample_rate).ok()?;
        if end_frame <= virtual_position {
            return None;
        }
        Some(Self {
            virtual_position,
            end_frame,
            record_position,
        })
    }

    const fn remaining_frames(self) -> u64 {
        self.end_frame.saturating_sub(self.virtual_position)
    }
}

struct MetronomeScheduler {
    channel_index: Option<usize>,
    next: Option<BeatBoundary>,
    active_key: Option<u8>,
    note_off_frame: Option<u64>,
}

impl MetronomeScheduler {
    fn new(
        channel_index: Option<usize>,
        tempo_map: &TempoMap,
        sample_rate: u32,
        position: u64,
    ) -> Self {
        let mut scheduler = Self {
            channel_index,
            next: None,
            active_key: None,
            note_off_frame: None,
        };
        scheduler.reposition(tempo_map, sample_rate, position, true);
        scheduler
    }

    fn reposition(
        &mut self,
        tempo_map: &TempoMap,
        sample_rate: u32,
        position: u64,
        include_current: bool,
    ) {
        self.active_key = None;
        self.note_off_frame = None;
        self.next = self.channel_index.and_then(|_| {
            Self::boundary_at_or_after(tempo_map, sample_rate, position, include_current)
        });
    }

    fn boundary_at_or_after(
        tempo_map: &TempoMap,
        sample_rate: u32,
        position: u64,
        include_current: bool,
    ) -> Option<BeatBoundary> {
        let position_tick = tempo_map.frame_to_tick(position, sample_rate).ok()?;
        let signatures = tempo_map.time_signature_events();
        let signature_index = signatures.partition_point(|event| event.tick <= position_tick);
        let signature_index = signature_index.saturating_sub(1);
        let signature = *signatures.get(signature_index)?;
        let beat_ticks =
            u64::from(MUSICAL_TICKS_PER_QUARTER) * 4 / u64::from(signature.denominator);
        let relative = position_tick.saturating_sub(signature.tick);
        let beat_index = relative / beat_ticks;
        let mut tick = signature
            .tick
            .saturating_add(beat_index.saturating_mul(beat_ticks));
        let mut frame = tempo_map.tick_to_frame(tick, sample_rate).ok()?;
        if frame < position || (frame == position && !include_current) {
            tick = tick.saturating_add(beat_ticks);
            frame = tempo_map.tick_to_frame(tick, sample_rate).ok()?;
        }

        if let Some(marker) = signatures.get(signature_index + 1)
            && marker.tick > position_tick
        {
            let marker_frame = tempo_map.tick_to_frame(marker.tick, sample_rate).ok()?;
            if marker_frame <= frame {
                return Some(BeatBoundary {
                    tick: marker.tick,
                    frame: marker_frame,
                    accent: true,
                });
            }
        }

        let beat_in_bar = tick
            .saturating_sub(signature.tick)
            .checked_div(beat_ticks)?
            % u64::from(signature.numerator);
        Some(BeatBoundary {
            tick,
            frame,
            accent: beat_in_bar == 0,
        })
    }

    fn events_at(
        &mut self,
        tempo_map: &TempoMap,
        sample_rate: u32,
        position: u64,
    ) -> [Option<ScheduledMidiEvent>; 2] {
        let Some(channel_index) = self.channel_index else {
            return [None, None];
        };
        if self.next.is_some_and(|boundary| boundary.frame < position) {
            self.next = Self::boundary_at_or_after(tempo_map, sample_rate, position, true);
        }
        let beat_due = self.next.is_some_and(|boundary| boundary.frame == position);
        let release_due = self.note_off_frame.is_some_and(|frame| frame <= position);
        let note_off = (release_due || (beat_due && self.active_key.is_some()))
            .then(|| self.note_off_event(channel_index))
            .flatten();

        let note_on = if let Some(boundary) = self.next.filter(|_| beat_due) {
            let key = if boundary.accent {
                METRONOME_ACCENT_NOTE
            } else {
                METRONOME_BEAT_NOTE
            };
            self.active_key = Some(key);
            self.note_off_frame = Some(position.saturating_add(
                u64::from(sample_rate).saturating_mul(METRONOME_NOTE_LENGTH_MS) / 1_000,
            ));
            let after_boundary = tempo_map
                .tick_to_frame(boundary.tick.saturating_add(1), sample_rate)
                .map_or(boundary.frame.saturating_add(1), |frame| {
                    frame.max(boundary.frame.saturating_add(1))
                });
            self.next = Self::boundary_at_or_after(tempo_map, sample_rate, after_boundary, true);
            Some(ScheduledMidiEvent {
                frame: position,
                channel_index,
                channel: 0,
                kind: ScheduledMidiEventKind::NoteOn {
                    note_id: METRONOME_NOTE_ID,
                    key,
                    velocity: if boundary.accent { 127 } else { 100 },
                },
            })
        } else {
            None
        };
        if note_off.is_some() {
            [note_off, note_on]
        } else {
            [note_on, None]
        }
    }

    fn note_off_event(&mut self, channel_index: usize) -> Option<ScheduledMidiEvent> {
        let key = self.active_key.take()?;
        self.note_off_frame = None;
        Some(ScheduledMidiEvent {
            frame: 0,
            channel_index,
            channel: 0,
            kind: ScheduledMidiEventKind::NoteOff {
                note_id: METRONOME_NOTE_ID,
                key,
                velocity: 0,
            },
        })
    }

    fn release(&mut self) -> Option<ScheduledMidiEvent> {
        self.channel_index
            .and_then(|channel_index| self.note_off_event(channel_index))
    }
}
