use super::{ChannelPeak, NativeMixerRuntime};

impl NativeMixerRuntime {
    pub(in crate::runtime) fn publish_peaks(&mut self, elapsed_frames: usize) {
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
