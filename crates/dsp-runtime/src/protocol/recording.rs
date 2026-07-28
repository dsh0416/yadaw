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
