use crate::{HostProcessContext, ProcessorLease, processor::AuxiliaryAudioInput};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vst3AuxInputConfig {
    pub bus_index: u32,
    pub channels: u8,
}

#[derive(Clone, Copy)]
pub struct Vst3SidechainBlock<'a> {
    pub bus_index: u32,
    pub frames: &'a [[f32; 2]],
}

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
    sidechain_scratch: Vec<AuxiliaryAudioInput>,
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
        Self::new_with_aux_inputs(
            primary,
            secondary,
            primary_latency,
            secondary_latency,
            maximum_block_frames,
            &[],
        )
    }

    #[must_use]
    pub fn new_with_aux_inputs(
        primary: ProcessorLease,
        secondary: Option<ProcessorLease>,
        primary_latency: u32,
        secondary_latency: u32,
        maximum_block_frames: usize,
        aux_inputs: &[Vst3AuxInputConfig],
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
            sidechain_scratch: aux_inputs
                .iter()
                .map(|input| AuxiliaryAudioInput {
                    bus_index: input.bus_index as usize,
                    channels: input.channels,
                    left: vec![0.0; maximum_block_frames],
                    right: vec![0.0; maximum_block_frames],
                })
                .collect(),
        }
    }

    pub fn process_block(&mut self, frames: &mut [[f32; 2]], context: &HostProcessContext) -> bool {
        self.process_block_with_sidechains(frames, &[], context)
    }

    pub fn process_block_with_sidechains(
        &mut self,
        frames: &mut [[f32; 2]],
        sidechains: &[Vst3SidechainBlock<'_>],
        context: &HostProcessContext,
    ) -> bool {
        self.process_block_with_sidechain_source(
            frames,
            |bus_index| {
                sidechains
                    .iter()
                    .find(|input| input.bus_index == bus_index)
                    .map(|input| input.frames)
            },
            context,
        )
    }

    pub fn process_block_with_sidechain_source<'a>(
        &mut self,
        frames: &mut [[f32; 2]],
        mut source: impl FnMut(u32) -> Option<&'a [[f32; 2]]>,
        context: &HostProcessContext,
    ) -> bool {
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
                fill_sidechain_scratch(
                    &mut self.sidechain_scratch,
                    &mut source,
                    frame_count,
                    Some(0),
                );
                self.auxiliary_input[..frame_count].fill(0.0);
                self.auxiliary_output[..frame_count].fill(0.0);
                if !self.primary.process_block_with_aux(
                    &mut self.input_left[..frame_count],
                    &mut self.auxiliary_input[..frame_count],
                    &mut self.output_left[..frame_count],
                    &mut self.auxiliary_output[..frame_count],
                    &self.sidechain_scratch,
                    context,
                ) {
                    return false;
                }
                fill_sidechain_scratch(
                    &mut self.sidechain_scratch,
                    &mut source,
                    frame_count,
                    Some(1),
                );
                self.auxiliary_input[..frame_count].fill(0.0);
                self.auxiliary_output[..frame_count].fill(0.0);
                if !secondary.process_block_with_aux(
                    &mut self.input_right[..frame_count],
                    &mut self.auxiliary_input[..frame_count],
                    &mut self.output_right[..frame_count],
                    &mut self.auxiliary_output[..frame_count],
                    &self.sidechain_scratch,
                    context,
                ) {
                    for (index, frame) in frames.iter().enumerate() {
                        self.output_right[index] = frame[1];
                    }
                }
            }
            None => {
                fill_sidechain_scratch(&mut self.sidechain_scratch, &mut source, frame_count, None);
                if !self.primary.process_block_with_aux(
                    &mut self.input_left[..frame_count],
                    &mut self.input_right[..frame_count],
                    &mut self.output_left[..frame_count],
                    &mut self.output_right[..frame_count],
                    &self.sidechain_scratch,
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

fn fill_sidechain_scratch<'a>(
    scratch: &mut [AuxiliaryAudioInput],
    source: &mut impl FnMut(u32) -> Option<&'a [[f32; 2]]>,
    frame_count: usize,
    dual_mono_lane: Option<usize>,
) {
    for target in scratch {
        target.left[..frame_count].fill(0.0);
        target.right[..frame_count].fill(0.0);
        let Some(input) =
            source(target.bus_index as u32).and_then(|input| input.get(..frame_count))
        else {
            continue;
        };
        for (index, frame) in input.iter().enumerate() {
            if let Some(lane) = dual_mono_lane {
                target.left[index] = frame[lane];
                target.right[index] = frame[lane];
            } else if target.channels == 1 {
                target.left[index] = (frame[0] + frame[1]) * 0.5;
            } else {
                target.left[index] = frame[0];
                target.right[index] = frame[1];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AuxiliaryAudioInput, SampleDelay, fill_sidechain_scratch};

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
    fn sidechain_scratch_maps_mono_stereo_and_dual_mono_without_allocation() {
        let frames = [[1.0, 3.0], [-1.0, 1.0]];
        let mut scratch = vec![AuxiliaryAudioInput {
            bus_index: 1,
            channels: 1,
            left: vec![0.0; 2],
            right: vec![0.0; 2],
        }];
        fill_sidechain_scratch(
            &mut scratch,
            &mut |bus| (bus == 1).then_some(&frames),
            2,
            None,
        );
        assert_eq!(scratch[0].left, vec![2.0, 0.0]);
        assert_eq!(scratch[0].right, vec![0.0, 0.0]);

        scratch[0].channels = 2;
        fill_sidechain_scratch(&mut scratch, &mut |_| Some(&frames), 2, None);
        assert_eq!(scratch[0].left, vec![1.0, -1.0]);
        assert_eq!(scratch[0].right, vec![3.0, 1.0]);

        fill_sidechain_scratch(&mut scratch, &mut |_| Some(&frames), 2, Some(1));
        assert_eq!(scratch[0].left, vec![3.0, 1.0]);
        assert_eq!(scratch[0].right, vec![3.0, 1.0]);
    }

    #[test]
    fn one_sample_delay_returns_the_previous_input() {
        let mut delay = SampleDelay::new(1);
        assert_eq!(delay.process(3.0), 0.0);
        assert_eq!(delay.process(4.0), 3.0);
        assert_eq!(delay.process(5.0), 4.0);
    }
}
