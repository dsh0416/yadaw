use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioEngineConfig {
    pub backend: String,
    pub input_device_id: String,
    pub output_device_id: String,
    pub buffer_size: u32,
    pub session_sample_rate: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioBackend {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub default_sample_rate: Option<u32>,
    pub min_buffer_size: Option<u32>,
    pub max_buffer_size: Option<u32>,
    pub channel_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioRuntime {
    pub state: String,
    pub requested_buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
    pub input_sample_rate: Option<u32>,
    pub output_sample_rate: Option<u32>,
    pub input_buffer_size: Option<u32>,
    pub output_buffer_size: Option<u32>,
    pub ring_buffer_capacity_frames: Option<u32>,
    pub ring_buffer_fill_frames: Option<u32>,
    pub input_latency_ms: Option<f64>,
    pub output_latency_ms: Option<f64>,
    pub ring_buffer_latency_ms: Option<f64>,
    pub engine_latency_ms: Option<f64>,
    pub estimated_round_trip_latency_ms: Option<f64>,
    pub xruns: u32,
    pub clock_sync: String,
    pub buffer_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationCaptureLogicalTarget {
    pub platform: String,
    #[serde(default)]
    pub bundle_identifier: Option<String>,
    pub executable_path: String,
    pub executable_name: String,
    pub include_process_tree: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationCaptureTargetDescriptor {
    pub runtime_id: String,
    pub process_id: u32,
    pub display_name: String,
    pub executable_path: String,
    pub logical_target: ApplicationCaptureLogicalTarget,
    pub channel_count: u32,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationCaptureSnapshot {
    pub runtime_id: String,
    pub process_id: Option<u32>,
    pub display_name: String,
    pub executable_path: String,
    pub logical_target: ApplicationCaptureLogicalTarget,
    pub channel_count: u32,
    pub status: String,
    pub dropout_frames: u64,
    pub overflow_frames: u64,
    pub underflow_frames: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoundTripLatencyMeasurementRequest {
    pub input_channel: u32,
    pub output_channel: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundTripLatencyMeasurement {
    pub status: String,
    pub input_channel: Option<u32>,
    pub output_channel: Option<u32>,
    pub measured_round_trip_latency_ms: Option<f64>,
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioBenchmarkScenario {
    pub id: String,
    pub label: String,
    pub description: String,
    pub sample_rate: u32,
    pub block_size: u32,
    pub tracks: u32,
    pub buses: u32,
    pub sends: u32,
    pub plugins: u32,
    pub elapsed_ms: f64,
    pub audio_duration_ms: f64,
    pub average_block_ms: f64,
    pub p95_block_ms: f64,
    pub p99_block_ms: f64,
    pub max_block_ms: f64,
    pub buffer_budget_ms: f64,
    pub p99_deadline_utilization_percent: f64,
    pub deadline_misses: u32,
    pub measured_blocks: u32,
    pub realtime_factor: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioBenchmarkReport {
    pub duration_ms: f64,
    pub overall_realtime_factor: f64,
    pub worst_p99_deadline_utilization_percent: f64,
    pub scenarios: Vec<AudioBenchmarkScenario>,
}
