mod audio;
mod graph;
mod midi_input;
mod plugin;
mod recording;
mod transport;
mod wire;

pub use audio::*;
pub use graph::*;
pub use midi_input::*;
pub use plugin::*;
pub use recording::*;
pub use transport::*;
pub use wire::*;

use serde::{Deserialize, Serialize};

/// Unsolicited helper notifications use a separate channel so editor and
/// runtime events cannot head-of-line block control responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEvent {
    Ready,
    ReleaseLeases {
        lease_ids: Vec<u64>,
    },
    TelemetryPageOffer {
        epoch: u64,
        capacity: u32,
    },
    GraphPublished {
        revision: u64,
    },
    RuntimeFailure {
        message: String,
        plugin_instance_id: Option<String>,
        phase: Option<String>,
    },
    PluginRuntime {
        instance_id: String,
        kind: String,
        value: String,
    },
    PluginEditorPreferenceChanged {
        class_id: String,
        preference: PluginEditorPreference,
    },
    MidiInputSnapshot {
        snapshot: MidiInputSnapshot,
    },
}

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
    TelemetryPageReady { epoch: u64 },
}

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
        message: String,
    },
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
    },
    ClosePluginEditor {
        instance_id: String,
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
    RecordingWaveform {
        waveform: RecordingWaveform,
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
        component_state: BinaryPayload,
        controller_state: BinaryPayload,
        ara_document_state: BinaryPayload,
    },
    GraphAccepted {
        revision: u64,
    },
    RevisionMismatch {
        current_revision: u64,
    },
    Busy,
    PluginEditor {
        active_mode: PluginEditorMode,
        open: bool,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded_hex(value: &impl Serialize) -> String {
        rmp_serde::to_vec_named(value)
            .unwrap()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn representative_wire_encodings_remain_byte_compatible() {
        let control = ControlRequest {
            request_id: 42,
            command: ControlCommand::Ping,
        };
        assert_eq!(
            encoded_hex(&control),
            "82aa726571756573745f69642aa7636f6d6d616e6481a474797065a470696e67"
        );

        let priority = PriorityRequest {
            request_id: 9,
            command: PriorityCommand::ParameterBoundary {
                command: ParameterCommand {
                    session_epoch: 3,
                    sequence: 17,
                    target_kind: ParameterTargetKind::Plugin,
                    runtime_handle: 5,
                    parameter_id: 11,
                    normalized: 0.25,
                    gesture: ParameterGesture::Perform,
                },
            },
        };
        assert_eq!(
            encoded_hex(&priority),
            concat!(
                "82aa726571756573745f696409a7636f6d6d616e6482a474797065b2706172616d",
                "657465722d626f756e64617279a7636f6d6d616e6487ad73657373696f6e5f6570",
                "6f636803a873657175656e636511ab7461726765745f6b696e64a6706c7567696e",
                "ae72756e74696d655f68616e646c6505ac706172616d657465725f69640baa6e6f",
                "726d616c697a6564cb3fd0000000000000a767657374757265a7706572666f726d"
            )
        );

        let graph_update = GraphUpdate::Patch {
            base_revision: 4,
            revision: 5,
            ops: vec![GraphOp::RemoveChannel {
                id: "track-1".to_owned(),
            }],
        };
        assert_eq!(
            encoded_hex(&graph_update),
            concat!(
                "84a474797065a57061746368ad626173655f7265766973696f6e04a8726576697369",
                "6f6e05a36f70739182a474797065ae72656d6f76652d6368616e6e656ca26964a7",
                "747261636b2d31"
            )
        );
    }

    #[test]
    fn messagepack_frame_round_trips() {
        let request = ControlRequest {
            request_id: 42,
            command: ControlCommand::UpdateGraph {
                update: GraphUpdate::Replace {
                    revision: 7,
                    graph: LiveMixerGraph {
                        sample_rate: 48_000,
                        channels: vec![],
                        sends: vec![],
                        clips: vec![],
                        plugins: vec![],
                        midi_clips: vec![],
                        tempo_events: vec![LiveTempoEvent {
                            tick: 0,
                            beats_per_minute: 120.0,
                        }],
                        time_signature_events: vec![LiveTimeSignatureEvent {
                            tick: 0,
                            numerator: 4,
                            denominator: 4,
                        }],
                    },
                },
            },
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &request).unwrap();
        assert_eq!(
            read_message::<ControlRequest>(&mut bytes.as_slice()).unwrap(),
            request
        );
    }

    #[test]
    fn session_and_native_output_sample_rates_round_trip() {
        let command = ControlCommand::StartAudioEngine {
            config: AudioEngineConfig {
                backend: "virtual".to_owned(),
                input_device_id: "input".to_owned(),
                output_device_id: "output".to_owned(),
                buffer_size: 128,
                session_sample_rate: Some(44_100),
            },
        };
        let command_bytes = rmp_serde::to_vec_named(&command).unwrap();
        assert_eq!(
            rmp_serde::from_slice::<ControlCommand>(&command_bytes).unwrap(),
            command
        );

        let runtime = AudioRuntime {
            state: "running".to_owned(),
            requested_buffer_size: Some(128),
            sample_rate: Some(44_100),
            input_sample_rate: Some(48_000),
            output_sample_rate: Some(48_000),
            input_buffer_size: Some(128),
            output_buffer_size: Some(128),
            ring_buffer_capacity_frames: Some(512),
            ring_buffer_fill_frames: Some(256),
            input_latency_ms: Some(1.0),
            output_latency_ms: Some(1.0),
            ring_buffer_latency_ms: Some(1.0),
            engine_latency_ms: Some(2.0),
            estimated_round_trip_latency_ms: Some(5.0),
            xruns: 0,
            clock_sync: "shared".to_owned(),
            buffer_fallback: false,
        };
        let runtime_bytes = rmp_serde::to_vec_named(&runtime).unwrap();
        assert_eq!(
            rmp_serde::from_slice::<AudioRuntime>(&runtime_bytes).unwrap(),
            runtime
        );
    }

    #[test]
    fn native_build_fingerprint_is_a_stable_hex_identifier() {
        assert_eq!(NATIVE_BUILD_FINGERPRINT.len(), 16);
        assert!(
            NATIVE_BUILD_FINGERPRINT
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
    }

    #[test]
    fn mixer_send_taps_use_stable_kebab_case_wire_values() {
        for (tap, wire_value) in [
            (LiveMixerSendTap::Pre, "pre"),
            (LiveMixerSendTap::Post, "post"),
            (LiveMixerSendTap::PostPan, "post-pan"),
        ] {
            let bytes = rmp_serde::to_vec(&tap).unwrap();
            assert_eq!(rmp_serde::from_slice::<String>(&bytes).unwrap(), wire_value);
            assert_eq!(
                rmp_serde::from_slice::<LiveMixerSendTap>(&bytes).unwrap(),
                tap
            );
        }

        let unknown = rmp_serde::to_vec(&"unknown").unwrap();
        assert!(rmp_serde::from_slice::<LiveMixerSendTap>(&unknown).is_err());
    }

    #[test]
    fn rejects_oversized_frame_before_allocating() {
        let mut bytes = ((MAX_MESSAGE_BYTES as u32) + 1).to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0; 4]);
        assert!(matches!(
            read_message::<ControlRequest>(&mut bytes.as_slice()),
            Err(ProtocolError::MessageTooLarge(_))
        ));
    }

    #[test]
    fn stable_id_patch_matches_the_equivalent_full_graph() {
        let output = LiveMixerChannel {
            id: "output".into(),
            kind: "output".into(),
            system_role: None,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_channel_id: None,
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            midi_input_port_id: None,
            midi_input_port_name: None,
            midi_input_channel: None,
            input_source: None,
            input_channels: vec![],
            hardware_output_channels: vec![0, 1],
        };
        let mut patched = LiveMixerGraph {
            sample_rate: 48_000,
            channels: vec![output.clone()],
            sends: vec![],
            clips: vec![],
            plugins: vec![],
            midi_clips: vec![],
            tempo_events: vec![LiveTempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![LiveTimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        };
        let audio = LiveMixerChannel {
            id: "audio-1".into(),
            kind: "audio".into(),
            system_role: None,
            gain_db: -3.0,
            pan: 0.25,
            muted: false,
            soloed: false,
            output_channel_id: Some("output".into()),
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            midi_input_port_id: None,
            midi_input_port_name: None,
            midi_input_channel: None,
            input_source: Some("hardware".into()),
            input_channels: vec![],
            hardware_output_channels: vec![],
        };
        patched.apply_ops(vec![
            GraphOp::UpsertChannel {
                value: audio.clone(),
            },
            GraphOp::ReplaceTempoMap {
                tempo_events: vec![
                    LiveTempoEvent {
                        tick: 0,
                        beats_per_minute: 120.0,
                    },
                    LiveTempoEvent {
                        tick: 960,
                        beats_per_minute: 90.0,
                    },
                ],
                time_signature_events: vec![LiveTimeSignatureEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                }],
            },
        ]);
        let mut full = patched.clone();
        full.channels = vec![output, audio];
        assert_eq!(patched, full);
    }
}
