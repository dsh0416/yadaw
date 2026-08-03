use std::{collections::VecDeque, error::Error, fmt};

pub type StereoFrame = [f32; 2];
pub const MAX_BUS_CHANNELS: usize = 256;
pub const MAX_OUTPUT_CHANNELS: usize = 32;
pub type HardwareOutputFrame = [f32; MAX_OUTPUT_CHANNELS];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Audio,
    Instrument,
    Aux,
    Master,
    Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendTap {
    Pre,
    Post,
    PostPan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteTarget {
    Bus(usize),
    Output(usize),
}

#[derive(Debug, Clone)]
pub struct ChannelSpec {
    pub id: String,
    pub kind: ChannelKind,
    pub gain_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub soloed: bool,
    pub output: Option<RouteTarget>,
    pub input_bus: Option<[usize; 2]>,
    pub hardware_output: Option<[usize; 2]>,
}

#[derive(Debug, Clone)]
pub struct SendSpec {
    pub id: String,
    pub source: usize,
    pub target: RouteTarget,
    pub enabled: bool,
    pub tap: SendTap,
    pub level_db: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ChannelPeak {
    pub pre: StereoFrame,
    pub post: StereoFrame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphError {
    MissingMaster,
    MultipleMasters,
    MissingOutput,
    InvalidOutput,
    InvalidSend,
    RoutingCycle,
    InvalidParameter,
    InvalidBlock,
}

impl fmt::Display for GraphError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingMaster => "mixer graph requires one master channel",
            Self::MultipleMasters => "mixer graph contains more than one master channel",
            Self::MissingOutput => "mixer graph requires at least one hardware output channel",
            Self::InvalidOutput => "mixer channel has an invalid output",
            Self::InvalidSend => "mixer send has an invalid source or target",
            Self::RoutingCycle => "mixer routing must not contain a cycle",
            Self::InvalidParameter => "mixer parameter is outside its supported range",
            Self::InvalidBlock => "mixer block shape exceeds the prepared capacity",
        })
    }
}

impl Error for GraphError {}

#[derive(Debug, Clone, Copy)]
struct SmoothedValue {
    current: f32,
    target: f32,
    coefficient: f32,
}

impl SmoothedValue {
    fn new(value: f32, sample_rate: u32) -> Self {
        let smoothing_frames = (sample_rate as f32 * 0.010).max(1.0);
        Self {
            current: value,
            target: value,
            coefficient: 1.0 / smoothing_frames,
        }
    }

    fn set_target(&mut self, value: f32) {
        self.target = value;
    }

    fn next(&mut self) -> f32 {
        self.current += (self.target - self.current) * self.coefficient;
        if (self.current - self.target).abs() < 1.0e-6 {
            self.current = self.target;
        }
        self.current
    }
}

#[derive(Debug, Clone)]
struct ChannelRuntime {
    gain: SmoothedValue,
    pan: SmoothedValue,
    output_delay: StereoDelay,
}

#[derive(Debug, Clone)]
struct SendRuntime {
    gain: SmoothedValue,
    delay: StereoDelay,
}

#[derive(Debug, Clone, Default)]
struct StereoDelay {
    frames: Vec<StereoFrame>,
    cursor: usize,
}

impl StereoDelay {
    fn set_frames(&mut self, frames: usize) {
        self.frames = vec![[0.0; 2]; frames];
        self.cursor = 0;
    }

    fn process(&mut self, input: StereoFrame) -> StereoFrame {
        if self.frames.is_empty() {
            return input;
        }
        let output = self.frames[self.cursor];
        self.frames[self.cursor] = input;
        self.cursor += 1;
        if self.cursor == self.frames.len() {
            self.cursor = 0;
        }
        output
    }

    fn clear(&mut self) {
        self.frames.fill([0.0; 2]);
        self.cursor = 0;
    }
}

pub struct MixerGraph {
    channels: Vec<ChannelSpec>,
    sends: Vec<SendSpec>,
    order: Vec<usize>,
    audible: Vec<bool>,
    output_audible: Vec<bool>,
    send_audible: Vec<bool>,
    channel_runtime: Vec<ChannelRuntime>,
    send_runtime: Vec<SendRuntime>,
    accumulation: Vec<StereoFrame>,
    bus_accumulation: [f32; MAX_BUS_CHANNELS],
    peaks: Vec<ChannelPeak>,
    sends_by_source: Vec<Vec<usize>>,
    master: usize,
    block_capacity: usize,
    block_bus_count: usize,
    block_bus_accumulation: Vec<f32>,
    block_master_gains: Vec<f32>,
    block_master_pans: Vec<f32>,
    block_post_pan: Vec<StereoFrame>,
}

mod graph;
mod runtime;
#[cfg(test)]
mod tests;

pub use graph::{balance_stereo, pan_mono};
