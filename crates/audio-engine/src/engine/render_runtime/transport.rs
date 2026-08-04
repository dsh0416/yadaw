use super::{NativeMixerRuntime, Ordering, TRANSPORT_PLAYING};

impl NativeMixerRuntime {
    pub(super) fn playback_loop_frames(&self, state: u32) -> Option<(u64, u64)> {
        if state != TRANSPORT_PLAYING || self.transport.clock_source.load(Ordering::Relaxed) != 0 {
            return None;
        }
        self.configured_loop_frames()
    }

    pub(super) fn configured_loop_frames(&self) -> Option<(u64, u64)> {
        if !self.transport.loop_enabled.load(Ordering::Acquire)
            || !self.transport.loop_has_range.load(Ordering::Acquire)
        {
            return None;
        }
        let start_tick = self.transport.loop_start_tick.load(Ordering::Relaxed);
        let end_tick = self.transport.loop_end_tick.load(Ordering::Relaxed);
        if end_tick <= start_tick {
            return None;
        }
        let start = self
            .tempo_map
            .tick_to_frame(start_tick, self.sample_rate)
            .ok()?;
        let end = self
            .tempo_map
            .tick_to_frame(end_tick, self.sample_rate)
            .ok()?;
        (end > start).then_some((start, end))
    }

    pub(super) fn rewind_playback_loop(&mut self, start_frame: u64) {
        self.all_notes_off();
        self.transport
            .position_frames
            .store(start_frame, Ordering::Relaxed);
        self.transport.position_ticks.store(
            self.transport.loop_start_tick.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        self.chase_notes(start_frame);
    }
}
