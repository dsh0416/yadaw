use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginEditorMode {
    Native,
    Parameters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginEditorPreference {
    pub mode: PluginEditorMode,
    pub zoom_percent: u16,
}

impl Default for PluginEditorPreference {
    fn default() -> Self {
        Self {
            mode: PluginEditorMode::Native,
            zoom_percent: 100,
        }
    }
}

impl PluginEditorPreference {
    #[must_use]
    pub const fn is_valid(self) -> bool {
        self.zoom_percent >= 50 && self.zoom_percent <= 400
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginAudioMode {
    Mono,
    MonoToStereo,
    #[default]
    Stereo,
    DualMono,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LivePluginInstance {
    pub instance_id: String,
    pub channel_id: String,
    pub role: String,
    pub slot_order: u32,
    #[serde(default)]
    pub audio_mode: PluginAudioMode,
    pub enabled: bool,
    pub latency_samples: u32,
    pub tail_samples: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterGesture {
    Begin,
    Perform,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterTargetKind {
    Plugin = 1,
    MixerChannel = 2,
    MixerSend = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ParameterCommand {
    pub session_epoch: u64,
    pub sequence: u64,
    pub target_kind: ParameterTargetKind,
    pub runtime_handle: u32,
    pub parameter_id: u32,
    pub target_generation: u32,
    pub normalized: f64,
    pub gesture: ParameterGesture,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginParameter {
    pub id: u32,
    pub title: String,
    pub units: String,
    pub step_count: i32,
    pub default_normalized: f64,
    pub normalized: f64,
    pub formatted: String,
    pub flags: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AraObjectKind {
    AudioSource,
    AudioModification,
    PlaybackRegion,
    Document,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AraAnalysisProgressState {
    Started,
    Updated,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AraArchiveDirection {
    Store,
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AraCallbackFailureCategory {
    InvalidReference,
    QueueOverflow,
    ProviderPanic,
    HostState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AraCallbackEvent {
    AnalysisProgress {
        object_id: String,
        state: AraAnalysisProgressState,
        progress: f32,
    },
    ContentChanged {
        object_kind: AraObjectKind,
        object_id: String,
        start_seconds: Option<f64>,
        duration_seconds: Option<f64>,
        scopes: u32,
    },
    DocumentDataChanged,
    ArchiveProgress {
        direction: AraArchiveDirection,
        progress: f32,
    },
    Quarantined {
        category: AraCallbackFailureCategory,
        recoverable: bool,
    },
}
