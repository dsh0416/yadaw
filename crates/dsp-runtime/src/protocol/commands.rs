use serde::{Deserialize, Serialize};

use super::{
    AudioEngineConfig, BinaryPayload, BounceOutputRenderRequest, GraphTransactionRequest,
    GraphUpdate, MidiRecordingStartConfig, MidiSyncPreferences, MixerParameterPreview,
    ParameterCommand, ParameterGesture, PluginAudioMode, PluginAuxInputConfiguration,
    PluginEditorAction, PluginEditorAppearance, PluginEditorContext, PluginEditorPreference,
    PluginLocator, PluginStateEnvelope, PrepareGraphRequest, RecordingStartConfig,
    RoundTripLatencyMeasurementRequest, RpcRequestMeta, TransportControl,
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
    ListApplicationCaptureTargets,
    ApplicationCaptureSnapshot,
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
        request: Box<PrepareGraphRequest>,
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
    StartAssetAudition {
        path: String,
        hardware_outputs: [u32; 2],
    },
    StopAssetAudition,
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
    StartBounceOutput {
        request: Box<BounceOutputRenderRequest>,
    },
    BounceOutputStatus {
        operation_id: String,
    },
    CancelBounceOutput {
        operation_id: String,
    },
    LoadPlugin {
        instance_id: String,
        locator: PluginLocator,
        plugin_kind: String,
        audio_mode: PluginAudioMode,
        #[serde(default)]
        active_aux_inputs: Vec<PluginAuxInputConfiguration>,
        sample_rate: f64,
        state: PluginStateEnvelope,
        #[serde(default)]
        ara_factory_class_id: Option<String>,
    },
    UnloadPlugin {
        instance_id: String,
    },
    PluginParameters {
        instance_id: String,
    },
    SetPluginParameter {
        instance_id: String,
        parameter_key: String,
        value: f64,
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
