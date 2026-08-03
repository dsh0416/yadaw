use serde::{Deserialize, Serialize};

use super::BinaryPayload;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingStartConfig {
    pub path: String,
    pub asset_id: String,
    pub originator: String,
    pub origination_date: String,
    pub origination_time: String,
    pub time_reference: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingResult {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub dropout_frames: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingWaveform {
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub start_frame: i64,
    pub end_frame: i64,
    pub frames_per_bucket: u32,
    pub bucket_count: u32,
    pub peaks: BinaryPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingTakeConfig {
    pub path: String,
    pub source_id: String,
    pub clip_id: String,
    pub track_id: String,
    /// Stable MIDI input port id, or `None` for all inputs.
    pub port_id: Option<String>,
    pub channel: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingStartConfig {
    pub takes: Vec<MidiRecordingTakeConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingPreviewNote {
    pub id: u32,
    pub start_tick: u64,
    pub end_tick: u64,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingTakePreview {
    pub clip_id: String,
    pub track_id: String,
    pub notes: Vec<MidiRecordingPreviewNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingPreview {
    pub position_tick: u64,
    pub takes: Vec<MidiRecordingTakePreview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingTakeResult {
    pub path: String,
    pub source_id: String,
    pub clip_id: String,
    pub track_id: String,
    pub event_count: u64,
    pub dropped_events: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiRecordingResult {
    pub takes: Vec<MidiRecordingTakeResult>,
}
