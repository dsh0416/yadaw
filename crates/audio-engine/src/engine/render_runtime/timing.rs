use super::{
    MUSICAL_TICKS_PER_QUARTER, NativeMixerRuntime, Ordering, ProcessContext, TRANSPORT_PLAYING,
    TRANSPORT_RECORDING, TimeSignatureEvent,
};

impl NativeMixerRuntime {
    pub(in crate::runtime) fn frames_until_timing_boundary(
        &self,
        position: u64,
        maximum: usize,
    ) -> usize {
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

    pub(in crate::runtime) fn process_context(&self, frame: u64, state: u32) -> ProcessContext {
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
}
