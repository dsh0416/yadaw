use serde::{Deserialize, Serialize};

use super::{BinaryPayload, SharedBlobRef};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMidiNote {
    pub start_tick: u64,
    pub duration_ticks: u64,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub release_velocity: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMidiClip {
    pub id: String,
    pub channel_id: String,
    pub start_tick: u64,
    pub source_offset_ticks: u64,
    pub length_ticks: u64,
    pub notes: MidiNoteBatch,
    pub events: MidiEventBatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "kebab-case")]
pub enum MidiNoteBatch {
    Inline { notes: Vec<LiveMidiNote> },
    Shared { reference: SharedBlobRef },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMidiEvent {
    pub tick: u64,
    pub channel: Option<u8>,
    pub kind: String,
    pub data: BinaryPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "kebab-case")]
pub enum MidiEventBatch {
    Inline { events: Vec<LiveMidiEvent> },
    Shared { reference: SharedBlobRef },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveTempoEvent {
    pub tick: u64,
    pub beats_per_minute: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveTimeSignatureEvent {
    pub tick: u64,
    pub numerator: u8,
    pub denominator: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransportControl {
    pub kind: String,
    pub position_frames: Option<i64>,
    #[serde(default)]
    pub loop_enabled: Option<bool>,
    #[serde(default)]
    pub loop_start_tick: Option<i64>,
    #[serde(default)]
    pub loop_end_tick: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransportState {
    pub state: String,
    pub position_frames: i64,
    #[serde(default)]
    pub position_ticks: i64,
    pub sample_rate: u32,
    #[serde(default)]
    pub effective_bpm: Option<f64>,
    #[serde(default = "internal_clock_source")]
    pub clock_source: String,
    #[serde(default)]
    pub waiting_for: Option<String>,
    #[serde(default)]
    pub loop_enabled: bool,
    #[serde(default)]
    pub loop_start_tick: Option<i64>,
    #[serde(default)]
    pub loop_end_tick: Option<i64>,
}

fn internal_clock_source() -> String {
    "internal".to_owned()
}
