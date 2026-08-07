use serde::{Deserialize, Serialize};

use super::{
    ApplicationCaptureSnapshot, ApplicationCaptureTargetDescriptor, AudioBackend,
    AudioBenchmarkReport, AudioDeviceList, AudioRuntime, BinaryPayload, BounceJobStatus,
    CompiledAudioGraphSnapshot, GraphTransactionValue, MidiInputSnapshot, MidiRecordingResult,
    MixerChannelMeter, PluginEditorMode, PluginEditorToolbarState, PluginParameter,
    PluginStateEnvelope, RecordingResult, RecordingWaveform, RoundTripLatencyMeasurement, RpcError,
    RpcResult, TransportState,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorityResponse {
    pub request_id: u64,
    pub result: PriorityResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PriorityResult {
    Heartbeat {
        ipc_generation: u64,
        tokio_generation: u64,
        winit_generation: u64,
        callback_generation: u64,
        transport_state: String,
        egress_active: u64,
        egress_queue_depth: u64,
        egress_queue_high_water: u64,
        egress_batches: u64,
        blocking_jobs: u64,
        arena_regions: u64,
        arena_capacity_bytes: u64,
        arena_used_bytes: u64,
        arena_high_water_bytes: u64,
        arena_offers: u64,
        arena_busy: u64,
        arena_quarantined_regions: u64,
        arena_copied_bytes: u64,
    },
    Accepted,
    Busy,
    Error {
        error: RpcError,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlResponse {
    pub request_id: u64,
    pub result: ControlResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlResult {
    Pong,
    BenchmarkEcho {
        payload: BinaryPayload,
    },
    AudioBenchmark {
        report: AudioBenchmarkReport,
    },
    Heartbeat {
        ipc_generation: u64,
        tokio_generation: u64,
        winit_generation: u64,
        callback_generation: u64,
        transport_state: String,
    },
    Accepted,
    AudioBackends {
        backends: Vec<AudioBackend>,
    },
    AudioDevices {
        devices: AudioDeviceList,
    },
    ApplicationCaptureTargets {
        targets: Vec<ApplicationCaptureTargetDescriptor>,
    },
    ApplicationCaptures {
        captures: Vec<ApplicationCaptureSnapshot>,
    },
    AudioRuntime {
        runtime: AudioRuntime,
    },
    RoundTripLatencyMeasurement {
        measurement: RoundTripLatencyMeasurement,
    },
    MixerSnapshot {
        meters: Vec<MixerChannelMeter>,
    },
    CompiledGraphSnapshot {
        snapshot: Option<CompiledAudioGraphSnapshot>,
    },
    TransportSnapshot {
        transport: TransportState,
    },
    MidiInputSnapshot {
        midi_input: MidiInputSnapshot,
    },
    RecordingStopped {
        recording: RecordingResult,
    },
    MidiRecordingStopped {
        #[serde(rename = "midi_recording")]
        recording: MidiRecordingResult,
    },
    RecordingWaveform {
        waveform: RecordingWaveform,
    },
    BounceOutput {
        status: BounceJobStatus,
    },
    PluginLoaded {
        runtime_handle: u32,
        latency_samples: u32,
        tail_samples: Option<u32>,
    },
    PluginParameters {
        parameters: Vec<PluginParameter>,
    },
    PluginState {
        state: PluginStateEnvelope,
    },
    GraphAccepted {
        revision: u64,
    },
    GraphTransaction {
        result: Box<RpcResult<GraphTransactionValue>>,
    },
    RevisionMismatch {
        current_revision: u64,
    },
    Busy,
    PluginEditor {
        active_mode: PluginEditorMode,
        open: bool,
    },
    PluginEditorToolbar {
        state: PluginEditorToolbarState,
    },
    Error {
        error: RpcError,
    },
}
