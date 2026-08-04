use serde::{Deserialize, Serialize};

use super::{
    AudioEngineConfig, BinaryPayload, GraphTransactionRequest, GraphUpdate,
    MidiRecordingStartConfig, MidiSyncPreferences, MixerParameterPreview, ParameterCommand,
    ParameterGesture, PluginAudioMode, PluginAuxInputConfiguration, PluginEditorAction,
    PluginEditorAppearance, PluginEditorContext, PluginEditorPreference, PrepareGraphRequest,
    RecordingStartConfig, RoundTripLatencyMeasurementRequest, RpcRequestMeta, TransportControl,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequest {
    pub request_id: u64,
    pub command: ControlCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorityRequest {
    pub request_id: u64,
    pub command: PriorityCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PriorityCommand {
    Heartbeat,
    Shutdown,
    ParameterWake,
    ParameterBoundary { command: ParameterCommand },
    ReleaseLeases { lease_ids: Vec<u64> },
    TelemetryPageReady { epoch: u64, generation: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlCommand {
    Ping,
    BenchmarkEcho {
        payload: BinaryPayload,
    },
    RunAudioBenchmark {
        plugin_instance_ids: Vec<String>,
    },
    Shutdown,
    ListAudioBackends,
    ListAudioDevices {
        backend: String,
    },
    StartAudioEngine {
        config: AudioEngineConfig,
    },
    StopAudioEngine,
    AudioEngineSnapshot,
    StartRoundTripLatencyMeasurement {
        request: RoundTripLatencyMeasurementRequest,
    },
    RoundTripLatencyMeasurementSnapshot,
    UpdateGraph {
        update: GraphUpdate,
    },
    PrepareGraph {
        meta: RpcRequestMeta,
        request: PrepareGraphRequest,
    },
    ActivateGraph {
        meta: RpcRequestMeta,
        request: GraphTransactionRequest,
    },
    AbortGraph {
        meta: RpcRequestMeta,
        request: GraphTransactionRequest,
    },
    GraphDeploymentSnapshot {
        meta: RpcRequestMeta,
    },
    PreviewMixerParameter {
        preview: MixerParameterPreview,
    },
    MixerSnapshot,
    CompiledGraphSnapshot,
    ClearMeterClips,
    Transport {
        command: TransportControl,
    },
    TransportSnapshot,
    MidiInputSnapshot,
    ConfigureMidiInput {
        preferences: MidiSyncPreferences,
    },
    StartRecording {
        config: RecordingStartConfig,
    },
    StopRecording,
    StartMidiRecording {
        config: MidiRecordingStartConfig,
    },
    StopMidiRecording,
    RecordingWaveform {
        start_frame: i64,
        end_frame: i64,
        max_buckets: u32,
    },
    LoadPlugin {
        instance_id: String,
        module_path: String,
        class_id: String,
        plugin_kind: String,
        audio_mode: PluginAudioMode,
        #[serde(default)]
        active_aux_inputs: Vec<PluginAuxInputConfiguration>,
        sample_rate: f64,
        component_state: BinaryPayload,
        controller_state: BinaryPayload,
        #[serde(default)]
        ara_factory_class_id: Option<String>,
        #[serde(default)]
        ara_document_state: BinaryPayload,
    },
    UnloadPlugin {
        instance_id: String,
    },
    PluginParameters {
        instance_id: String,
    },
    SetPluginParameter {
        instance_id: String,
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    },
    SavePluginState {
        instance_id: String,
    },
    OpenPluginEditor {
        instance_id: String,
        preference: PluginEditorPreference,
        #[serde(default)]
        context: PluginEditorContext,
    },
    ConfigurePluginEditorAppearance {
        appearance: PluginEditorAppearance,
    },
    ApplyPluginEditorAction {
        instance_id: String,
        action: PluginEditorAction,
    },
    ResolvePluginSidechainRoute {
        request_id: u64,
        instance_id: String,
        accepted: bool,
        warning: Option<String>,
    },
    ClosePluginEditor {
        instance_id: String,
    },
}
