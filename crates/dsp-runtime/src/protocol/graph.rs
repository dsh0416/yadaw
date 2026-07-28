use serde::{Deserialize, Serialize};

use super::{LiveMidiClip, LivePluginInstance, LiveTempoEvent, LiveTimeSignatureEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LiveMixerSystemRole {
    Metronome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerChannel {
    pub id: String,
    pub kind: String,
    pub system_role: Option<LiveMixerSystemRole>,
    pub gain_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub soloed: bool,
    pub output_channel_id: Option<String>,
    pub output_bus: Option<u32>,
    pub record_armed: bool,
    #[serde(default)]
    pub input_monitoring: bool,
    pub input_source: Option<String>,
    pub input_channels: Vec<u32>,
    pub hardware_output_channels: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LiveMixerSendTap {
    Pre,
    Post,
    PostPan,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerSend {
    pub id: String,
    pub source_channel_id: String,
    pub target_channel_id: Option<String>,
    pub target_bus: Option<u32>,
    pub enabled: bool,
    pub tap: LiveMixerSendTap,
    pub level_db: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMixerClip {
    pub id: String,
    pub channel_id: String,
    pub start_frame: i64,
    pub source_offset_frames: i64,
    pub length_frames: i64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerGraph {
    pub sample_rate: u32,
    pub channels: Vec<LiveMixerChannel>,
    pub sends: Vec<LiveMixerSend>,
    pub clips: Vec<LiveMixerClip>,
    pub plugins: Vec<LivePluginInstance>,
    pub midi_clips: Vec<LiveMidiClip>,
    pub tempo_events: Vec<LiveTempoEvent>,
    pub time_signature_events: Vec<LiveTimeSignatureEvent>,
}

impl LiveMixerGraph {
    pub fn apply_ops(&mut self, ops: Vec<GraphOp>) {
        for op in ops {
            match op {
                GraphOp::UpsertChannel { value } => {
                    upsert_by(&mut self.channels, value, |item| &item.id);
                }
                GraphOp::RemoveChannel { id } => {
                    self.channels.retain(|item| item.id != id);
                }
                GraphOp::UpsertSend { value } => {
                    upsert_by(&mut self.sends, value, |item| &item.id);
                }
                GraphOp::RemoveSend { id } => {
                    self.sends.retain(|item| item.id != id);
                }
                GraphOp::UpsertClip { value } => {
                    upsert_by(&mut self.clips, value, |item| &item.id);
                }
                GraphOp::RemoveClip { id } => {
                    self.clips.retain(|item| item.id != id);
                }
                GraphOp::UpsertPlugin { value } => {
                    upsert_by(&mut self.plugins, value, |item| &item.instance_id);
                }
                GraphOp::RemovePlugin { id } => {
                    self.plugins.retain(|item| item.instance_id != id);
                }
                GraphOp::UpsertMidiClip { value } => {
                    upsert_by(&mut self.midi_clips, value, |item| &item.id);
                }
                GraphOp::RemoveMidiClip { id } => {
                    self.midi_clips.retain(|item| item.id != id);
                }
                GraphOp::ReplaceTempoMap {
                    tempo_events,
                    time_signature_events,
                } => {
                    self.tempo_events = tempo_events;
                    self.time_signature_events = time_signature_events;
                }
            }
        }
    }
}

fn upsert_by<T, F>(values: &mut Vec<T>, value: T, id: F)
where
    F: Fn(&T) -> &str,
{
    if let Some(index) = values
        .iter()
        .position(|candidate| id(candidate) == id(&value))
    {
        values[index] = value;
    } else {
        values.push(value);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum GraphUpdate {
    Replace {
        revision: u64,
        graph: LiveMixerGraph,
    },
    Patch {
        base_revision: u64,
        revision: u64,
        ops: Vec<GraphOp>,
    },
}

impl GraphUpdate {
    #[must_use]
    pub fn revision(&self) -> u64 {
        match self {
            Self::Replace { revision, .. } | Self::Patch { revision, .. } => *revision,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum GraphOp {
    UpsertChannel {
        value: LiveMixerChannel,
    },
    RemoveChannel {
        id: String,
    },
    UpsertSend {
        value: LiveMixerSend,
    },
    RemoveSend {
        id: String,
    },
    UpsertClip {
        value: LiveMixerClip,
    },
    RemoveClip {
        id: String,
    },
    UpsertPlugin {
        value: LivePluginInstance,
    },
    RemovePlugin {
        id: String,
    },
    UpsertMidiClip {
        value: LiveMidiClip,
    },
    RemoveMidiClip {
        id: String,
    },
    ReplaceTempoMap {
        tempo_events: Vec<LiveTempoEvent>,
        time_signature_events: Vec<LiveTimeSignatureEvent>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixerParameterPreview {
    pub target: String,
    pub id: String,
    pub parameter: String,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixerChannelMeter {
    pub channel_id: String,
    pub pre_left: f64,
    pub pre_right: f64,
    pub post_left: f64,
    pub post_right: f64,
    pub held_left: f64,
    pub held_right: f64,
    pub clipped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompiledGraphSignalWidth {
    Mono,
    Stereo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompiledGraphPluginState {
    Active,
    Bypassed,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompiledGraphNodeKind {
    HardwareInput,
    BusInput,
    TimelineInput,
    InstrumentInput,
    Channel,
    Effect,
    Send,
    Master,
    HardwareOutput,
    WidthAdapter,
    PdcDelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompiledGraphEdgeKind {
    Signal,
    MainRoute,
    SendRoute,
    HardwareRoute,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledGraphNode {
    pub id: String,
    pub kind: CompiledGraphNodeKind,
    pub label: String,
    pub channel_id: Option<String>,
    pub plugin_instance_id: Option<String>,
    pub signal_width: CompiledGraphSignalWidth,
    pub latency_samples: u32,
    pub plugin_state: Option<CompiledGraphPluginState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledGraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: CompiledGraphEdgeKind,
    pub signal_width: CompiledGraphSignalWidth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledAudioGraphSnapshot {
    pub graph_revision: u64,
    pub build_generation: u64,
    pub sample_rate: u32,
    pub nodes: Vec<CompiledGraphNode>,
    pub edges: Vec<CompiledGraphEdge>,
}
