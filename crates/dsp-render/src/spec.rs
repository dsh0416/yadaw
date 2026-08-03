use heron_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderChannelKind {
    Audio,
    Instrument,
    Aux,
    Master,
    Output,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderRoute {
    Channel(String),
    Bus(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderChannelSpec {
    pub id: String,
    pub kind: RenderChannelKind,
    pub gain_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub soloed: bool,
    pub output: Option<RenderRoute>,
    pub input_bus: Option<[usize; 2]>,
    pub hardware_input: Option<[usize; 2]>,
    pub hardware_output: Option<[usize; 2]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderSendTap {
    Pre,
    Post,
    PostPan,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderSendSpec {
    pub id: String,
    pub source_channel_id: String,
    pub target: RenderRoute,
    pub enabled: bool,
    pub tap: RenderSendTap,
    pub level_db: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderClipSpec {
    pub id: String,
    pub source_id: String,
    pub channel_id: String,
    pub start_frame: u64,
    pub source_offset_frames: u64,
    pub length_frames: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPluginSpec {
    pub id: String,
    pub processor_id: String,
    pub channel_id: String,
    pub slot_order: u32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderMidiNote {
    pub start_tick: u64,
    pub duration_ticks: u64,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub release_velocity: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderMidiSpec {
    pub plugin_id: String,
    pub notes: Vec<RenderMidiNote>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderGraphSpec {
    pub sample_rate: u32,
    pub channels: Vec<RenderChannelSpec>,
    pub sends: Vec<RenderSendSpec>,
    pub clips: Vec<RenderClipSpec>,
    pub plugins: Vec<RenderPluginSpec>,
    pub midi: Vec<RenderMidiSpec>,
    pub tempo_events: Vec<TempoEvent>,
    pub time_signature_events: Vec<TimeSignatureEvent>,
}
