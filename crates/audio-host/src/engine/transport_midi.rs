struct LivePlugin {
    processor: Option<Vst3ProcessorHandle>,
    audio_mode: PluginAudioMode,
    enabled: bool,
    is_instrument: bool,
    bypass_delay: StereoDelayLine,
    marker_index: usize,
}

impl LivePlugin {
    fn process(
        &mut self,
        input: StereoFrame,
        width: &mut SignalWidth,
        context: &ProcessContext,
    ) -> StereoFrame {
        let prepared = self.prepare_input(input, *width);
        let output_width = self.output_width();
        if !self.enabled {
            *width = output_width;
            return self.bypass_delay.process(self.passthrough(prepared));
        }
        let failure_output = if self.is_instrument {
            [0.0; 2]
        } else {
            self.passthrough(prepared)
        };
        let Some(processor) = self.processor.as_mut() else {
            *width = output_width;
            return failure_output;
        };
        *width = output_width;
        processor
            .process_frame(prepared, context)
            .unwrap_or(failure_output)
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
struct ScheduledMidiEvent {
    frame: u64,
    channel_index: usize,
    note_id: i32,
    channel: u8,
    key: u8,
    velocity: u8,
    note_on: bool,
}

#[derive(Clone, Copy)]
struct BeatBoundary {
    tick: u64,
    frame: u64,
    accent: bool,
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
                note_id: METRONOME_NOTE_ID,
                channel: 0,
                key,
                velocity: if boundary.accent { 127 } else { 100 },
                note_on: true,
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
            note_id: METRONOME_NOTE_ID,
            channel: 0,
            key,
            velocity: 0,
            note_on: false,
        })
    }

    fn release(&mut self) -> Option<ScheduledMidiEvent> {
        self.channel_index
            .and_then(|channel_index| self.note_off_event(channel_index))
    }
}
