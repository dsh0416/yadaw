use serde::{Deserialize, Serialize};

use super::LiveMixerGraph;

const fn default_include_tail() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BounceChannelMode {
    Stereo,
    Mono,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BounceDither {
    Off,
    Tpdf,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum BounceNormalization {
    Off,
    OverloadProtection,
    TruePeak { target_dbtp: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BounceEncoding {
    WavPcm {
        bits: u16,
        dither: BounceDither,
    },
    WavFloat,
    Flac {
        bits: u16,
        compression: u32,
        dither: BounceDither,
    },
    Mp3Cbr {
        kbps: u16,
    },
    Mp3Vbr {
        quality: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BounceOutputRenderRequest {
    pub operation_id: String,
    pub graph_revision: u64,
    pub graph: LiveMixerGraph,
    pub output_channel_id: String,
    pub start_frame: u64,
    pub end_frame: u64,
    pub target_sample_rate: u32,
    pub channel_mode: BounceChannelMode,
    #[serde(default = "default_include_tail")]
    pub include_tail: bool,
    pub encoding: BounceEncoding,
    pub normalization: BounceNormalization,
    pub scratch_path: String,
    pub encoded_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BounceJobPhase {
    Preparing,
    Rendering,
    Analyzing,
    Encoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BounceJobState {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BounceJobStatus {
    pub operation_id: String,
    pub state: BounceJobState,
    pub phase: BounceJobPhase,
    pub completed_units: u64,
    pub total_units: u64,
    pub sample_peak: Option<f64>,
    pub true_peak: Option<f64>,
    pub normalization_gain: Option<f64>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}
