use crate::{HostProcessContext, ProcessorLease};

/// Cloneable, allocation-free-after-construction processor endpoint used by
/// the real-time engine. Controller and editor ownership stay in audio-host.
#[derive(Clone)]
pub struct Vst3ProcessorHandle {
    primary: ProcessorLease,
    secondary: Option<ProcessorLease>,
    left_delay: SampleDelay,
    right_delay: SampleDelay,
    input_left: Vec<f32>,
    input_right: Vec<f32>,
    output_left: Vec<f32>,
    output_right: Vec<f32>,
    auxiliary_input: Vec<f32>,
    auxiliary_output: Vec<f32>,
}

#[derive(Clone)]
struct SampleDelay {
    samples: Vec<f32>,
    cursor: usize,
}

impl SampleDelay {
    fn new(delay_samples: u32) -> Self {
        Self {
            samples: vec![0.0; delay_samples as usize],
            cursor: 0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        if self.samples.is_empty() {
            return sample;
        }
        let delayed = self.samples[self.cursor];
        self.samples[self.cursor] = sample;
        self.cursor = (self.cursor + 1) % self.samples.len();
        delayed
    }
}

impl Vst3ProcessorHandle {
    #[must_use]
    pub fn new(
        primary: ProcessorLease,
        secondary: Option<ProcessorLease>,
        primary_latency: u32,
        secondary_latency: u32,
        maximum_block_frames: usize,
    ) -> Self {
        let maximum_latency = primary_latency.max(secondary_latency);
        Self {
            primary,
            secondary,
            left_delay: SampleDelay::new(maximum_latency - primary_latency),
            right_delay: SampleDelay::new(maximum_latency - secondary_latency),
            input_left: vec![0.0; maximum_block_frames],
            input_right: vec![0.0; maximum_block_frames],
            output_left: vec![0.0; maximum_block_frames],
            output_right: vec![0.0; maximum_block_frames],
            auxiliary_input: vec![0.0; maximum_block_frames],
            auxiliary_output: vec![0.0; maximum_block_frames],
        }
    }

    pub fn process_block(&mut self, frames: &mut [[f32; 2]], context: &HostProcessContext) -> bool {
        if frames.len() > self.input_left.len() {
            return false;
        }
        let frame_count = frames.len();
        for (index, frame) in frames.iter().enumerate() {
            self.input_left[index] = frame[0];
            self.input_right[index] = frame[1];
        }
        self.output_left[..frame_count].fill(0.0);
        self.output_right[..frame_count].fill(0.0);

        match &mut self.secondary {
            Some(secondary) => {
                self.auxiliary_input[..frame_count].fill(0.0);
                self.auxiliary_output[..frame_count].fill(0.0);
                if !self.primary.process_block(
                    &mut self.input_left[..frame_count],
                    &mut self.auxiliary_input[..frame_count],
                    &mut self.output_left[..frame_count],
                    &mut self.auxiliary_output[..frame_count],
                    context,
                ) {
                    return false;
                }
                self.auxiliary_input[..frame_count].fill(0.0);
                self.auxiliary_output[..frame_count].fill(0.0);
                if !secondary.process_block(
                    &mut self.input_right[..frame_count],
                    &mut self.auxiliary_input[..frame_count],
                    &mut self.output_right[..frame_count],
                    &mut self.auxiliary_output[..frame_count],
                    context,
                ) {
                    for (index, frame) in frames.iter().enumerate() {
                        self.output_right[index] = frame[1];
                    }
                }
            }
            None => {
                if !self.primary.process_block(
                    &mut self.input_left[..frame_count],
                    &mut self.input_right[..frame_count],
                    &mut self.output_left[..frame_count],
                    &mut self.output_right[..frame_count],
                    context,
                ) {
                    return false;
                }
            }
        }
        for (index, frame) in frames.iter_mut().enumerate() {
            frame[0] = self.left_delay.process(self.output_left[index]);
            frame[1] = self.right_delay.process(self.output_right[index]);
        }
        true
    }

    pub fn note_on(&mut self, offset: usize, channel: u8, key: u8, velocity: u8, id: i32) -> bool {
        self.primary.note_on(
            offset.min(i32::MAX as usize) as i32,
            channel,
            key,
            velocity,
            id,
        )
    }

    pub fn note_off(&mut self, offset: usize, channel: u8, key: u8, velocity: u8, id: i32) -> bool {
        self.primary.note_off(
            offset.min(i32::MAX as usize) as i32,
            channel,
            key,
            velocity,
            id,
        )
    }

    pub fn poly_pressure(&mut self, offset: usize, channel: u8, key: u8, pressure: u8) -> bool {
        self.primary
            .poly_pressure(offset.min(i32::MAX as usize) as i32, channel, key, pressure)
    }

    pub fn control_change(
        &mut self,
        offset: usize,
        channel: u8,
        controller: u8,
        value: u8,
    ) -> bool {
        self.primary.control_change(
            offset.min(i32::MAX as usize) as i32,
            channel,
            controller,
            value,
        )
    }

    pub fn pitch_bend(&mut self, offset: usize, channel: u8, value: u16) -> bool {
        self.primary
            .pitch_bend(offset.min(i32::MAX as usize) as i32, channel, value)
    }

    pub fn channel_pressure(&mut self, offset: usize, channel: u8, pressure: u8) -> bool {
        self.primary
            .channel_pressure(offset.min(i32::MAX as usize) as i32, channel, pressure)
    }

    pub fn program_change(&mut self, offset: usize, channel: u8, program: u8) -> bool {
        self.primary
            .program_change(offset.min(i32::MAX as usize) as i32, channel, program)
    }

    pub fn sysex(&mut self, offset: usize, bytes: &[u8]) -> bool {
        self.primary
            .sysex(offset.min(i32::MAX as usize) as i32, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::SampleDelay;

    #[test]
    fn dual_mono_lane_delay_aligns_the_shorter_processor() {
        let mut delay = SampleDelay::new(2);
        assert_eq!(delay.process(1.0), 0.0);
        assert_eq!(delay.process(2.0), 0.0);
        assert_eq!(delay.process(3.0), 1.0);
    }

    #[test]
    fn zero_sample_delay_is_a_passthrough() {
        let mut delay = SampleDelay::new(0);
        assert_eq!(delay.process(0.5), 0.5);
        assert_eq!(delay.process(-1.0), -1.0);
    }

    #[test]
    fn one_sample_delay_returns_the_previous_input() {
        let mut delay = SampleDelay::new(1);
        assert_eq!(delay.process(3.0), 0.0);
        assert_eq!(delay.process(4.0), 3.0);
        assert_eq!(delay.process(5.0), 4.0);
    }
}
