#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::panic_in_result_fn,
        clippy::unwrap_used
    )
)]

mod audio;
mod graph;
mod midi_input;
mod plugin;
mod recording;
mod rpc;
mod transport;
mod wire;

pub use audio::*;
pub use graph::*;
pub use midi_input::*;
pub use plugin::*;
pub use recording::*;
pub use rpc::*;
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
                    target_generation: 7,
                    normalized: 0.25,
                    gesture: ParameterGesture::Perform,
                },
            },
        };
        assert_eq!(
            encoded_hex(&priority),
            concat!(
                "82aa726571756573745f696409a7636f6d6d616e6482a474797065b2706172616d",
                "657465722d626f756e64617279a7636f6d6d616e6488ad73657373696f6e5f6570",
                "6f636803a873657175656e636511ab7461726765745f6b696e64a6706c7567696e",
                "ae72756e74696d655f68616e646c6505ac706172616d657465725f69640bb17461",
                "726765745f67656e65726174696f6e07aa6e6f",
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
    fn graph_transaction_envelopes_round_trip_with_lossless_epochs() {
        let engine = ResourceRef {
            kind: ResourceKind::AudioEngine,
            id: "engine".to_owned(),
            epoch: u64::MAX.to_string(),
            generation: 2,
        };
        let project_graph = ResourceRef {
            kind: ResourceKind::ProjectGraph,
            id: "graph".to_owned(),
            epoch: "main-epoch".to_owned(),
            generation: 4,
        };
        let command = ControlCommand::PrepareGraph {
            meta: RpcRequestMeta {
                protocol_version: IPC_PROTOCOL_VERSION,
                request_id: "request-1".to_owned(),
                target: Some(engine),
                expected_revision: Some(7),
                mutation: Some(RpcMutationMeta {
                    operation_id: "operation-1".to_owned(),
                    idempotency_key: "graph:8".to_owned(),
                }),
            },
            request: PrepareGraphRequest {
                helper_epoch: u64::MAX.to_string(),
                project_graph,
                base_revision: 7,
                graph_revision: 8,
                graph: empty_graph(),
            },
        };

        let bytes = rmp_serde::to_vec_named(&command).expect("graph transaction must encode");
        assert_eq!(
            rmp_serde::from_slice::<ControlCommand>(&bytes).expect("graph transaction must decode"),
            command
        );
    }

    #[test]
    fn session_and_native_output_sample_rates_round_trip() {
        let command = ControlCommand::StartAudioEngine {
            config: AudioEngineConfig {
                backend: "mock".to_owned(),
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

    fn channel(id: &str) -> LiveMixerChannel {
        LiveMixerChannel {
            id: id.into(),
            kind: "audio".into(),
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
            hardware_output_channels: vec![],
        }
    }

    fn send(id: &str) -> LiveMixerSend {
        LiveMixerSend {
            id: id.into(),
            source_channel_id: "audio-1".into(),
            target_channel_id: Some("output".into()),
            target_bus: None,
            enabled: true,
            tap: LiveMixerSendTap::Post,
            level_db: -6.0,
        }
    }

    fn clip(id: &str) -> LiveMixerClip {
        LiveMixerClip {
            id: id.into(),
            channel_id: "audio-1".into(),
            start_frame: 0,
            source_offset_frames: 0,
            length_frames: 48_000,
            path: format!("/assets/{id}.wav"),
        }
    }

    fn plugin(instance_id: &str) -> LivePluginInstance {
        LivePluginInstance {
            instance_id: instance_id.into(),
            channel_id: "audio-1".into(),
            role: "insert".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            latency_samples: 0,
            tail_samples: None,
        }
    }

    fn midi_clip(id: &str) -> LiveMidiClip {
        LiveMidiClip {
            id: id.into(),
            channel_id: "instrument-1".into(),
            start_tick: 0,
            source_offset_ticks: 0,
            length_ticks: 1_920,
            notes: MidiNoteBatch::Inline { notes: vec![] },
            events: MidiEventBatch::Inline { events: vec![] },
        }
    }

    fn empty_graph() -> LiveMixerGraph {
        LiveMixerGraph {
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
        }
    }

    #[test]
    fn upserts_append_new_entries_and_replace_matching_ids_in_place() {
        let mut graph = empty_graph();

        graph.apply_ops(vec![
            GraphOp::UpsertChannel {
                value: channel("audio-1"),
            },
            GraphOp::UpsertChannel {
                value: channel("audio-2"),
            },
            GraphOp::UpsertChannel {
                value: LiveMixerChannel {
                    muted: true,
                    ..channel("audio-1")
                },
            },
        ]);

        assert_eq!(
            graph
                .channels
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["audio-1", "audio-2"]
        );
        assert!(graph.channels[0].muted);
    }

    #[test]
    fn every_collection_supports_upsert_and_remove() {
        let mut graph = empty_graph();

        graph.apply_ops(vec![
            GraphOp::UpsertChannel {
                value: channel("audio-1"),
            },
            GraphOp::UpsertSend { value: send("s-1") },
            GraphOp::UpsertClip { value: clip("c-1") },
            GraphOp::UpsertPlugin {
                value: plugin("p-1"),
            },
            GraphOp::UpsertMidiClip {
                value: midi_clip("m-1"),
            },
        ]);
        assert_eq!(graph.channels.len(), 1);
        assert_eq!(graph.sends.len(), 1);
        assert_eq!(graph.clips.len(), 1);
        assert_eq!(graph.plugins.len(), 1);
        assert_eq!(graph.midi_clips.len(), 1);

        graph.apply_ops(vec![
            GraphOp::RemoveChannel {
                id: "audio-1".into(),
            },
            GraphOp::RemoveSend { id: "s-1".into() },
            GraphOp::RemoveClip { id: "c-1".into() },
            GraphOp::RemovePlugin { id: "p-1".into() },
            GraphOp::RemoveMidiClip { id: "m-1".into() },
        ]);
        assert_eq!(graph, empty_graph());
    }

    #[test]
    fn removing_an_unknown_id_leaves_the_graph_untouched() {
        let mut graph = empty_graph();
        graph.apply_ops(vec![GraphOp::UpsertChannel {
            value: channel("audio-1"),
        }]);
        let before = graph.clone();

        graph.apply_ops(vec![
            GraphOp::RemoveChannel {
                id: "audio-9".into(),
            },
            GraphOp::RemoveSend { id: "s-9".into() },
            GraphOp::RemoveClip { id: "c-9".into() },
            GraphOp::RemovePlugin { id: "p-9".into() },
            GraphOp::RemoveMidiClip { id: "m-9".into() },
        ]);

        assert_eq!(graph, before);
    }

    #[test]
    fn plugins_are_keyed_by_instance_rather_than_channel() {
        let mut graph = empty_graph();

        graph.apply_ops(vec![
            GraphOp::UpsertPlugin {
                value: plugin("p-1"),
            },
            GraphOp::UpsertPlugin {
                value: LivePluginInstance {
                    slot_order: 1,
                    ..plugin("p-2")
                },
            },
            GraphOp::UpsertPlugin {
                value: LivePluginInstance {
                    enabled: false,
                    ..plugin("p-1")
                },
            },
        ]);

        assert_eq!(graph.plugins.len(), 2);
        assert!(!graph.plugins[0].enabled);
        assert_eq!(graph.plugins[1].slot_order, 1);
    }

    #[test]
    fn replacing_the_tempo_map_swaps_both_event_lists() {
        let mut graph = empty_graph();

        graph.apply_ops(vec![GraphOp::ReplaceTempoMap {
            tempo_events: vec![LiveTempoEvent {
                tick: 0,
                beats_per_minute: 90.0,
            }],
            time_signature_events: vec![],
        }]);

        assert_eq!(graph.tempo_events[0].beats_per_minute, 90.0);
        assert!(graph.time_signature_events.is_empty());
    }

    #[test]
    fn an_empty_op_list_is_a_no_op() {
        let mut graph = empty_graph();

        graph.apply_ops(vec![]);

        assert_eq!(graph, empty_graph());
    }

    #[test]
    fn a_graph_update_reports_the_revision_it_produces() {
        assert_eq!(
            GraphUpdate::Replace {
                revision: 7,
                graph: empty_graph(),
            }
            .revision(),
            7
        );
        assert_eq!(
            GraphUpdate::Patch {
                base_revision: 7,
                revision: 8,
                ops: vec![],
            }
            .revision(),
            8
        );
    }

    #[test]
    fn binary_payloads_expose_bytes_only_when_they_are_inline() {
        assert_eq!(BinaryPayload::default(), BinaryPayload::inline(Vec::new()));
        assert_eq!(
            BinaryPayload::inline(vec![1, 2, 3]).as_inline(),
            Some(&[1, 2, 3][..])
        );

        let reference = SharedBlobRef {
            session_epoch: 1,
            region_id: 2,
            region_generation: 3,
            slot: 4,
            allocation_generation: 5,
            offset: 6,
            length: 7,
            lease_id: 8,
        };
        assert_eq!(BinaryPayload::Shared { reference }.as_inline(), None);
        assert_eq!(
            BinaryPayload::Attachment {
                index: 0,
                offset: 0,
                length: 0,
            }
            .as_inline(),
            None
        );
    }

    #[test]
    fn a_frame_is_length_prefixed_in_big_endian() {
        let mut bytes = Vec::new();
        write_message(
            &mut bytes,
            &ControlRequest {
                request_id: 1,
                command: ControlCommand::Ping,
            },
        )
        .unwrap();

        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(length, bytes.len() - 4);
    }

    #[test]
    fn consecutive_frames_are_read_back_in_order() {
        let mut bytes = Vec::new();
        for request_id in 0..3 {
            write_message(
                &mut bytes,
                &ControlRequest {
                    request_id,
                    command: ControlCommand::Ping,
                },
            )
            .unwrap();
        }

        let mut reader = bytes.as_slice();
        for request_id in 0..3 {
            assert_eq!(
                read_message::<ControlRequest>(&mut reader)
                    .unwrap()
                    .request_id,
                request_id
            );
        }
        assert!(reader.is_empty());
    }

    #[test]
    fn a_truncated_frame_is_reported_as_an_io_error() {
        let mut bytes = Vec::new();
        write_message(
            &mut bytes,
            &ControlRequest {
                request_id: 1,
                command: ControlCommand::Ping,
            },
        )
        .unwrap();
        bytes.truncate(bytes.len() - 1);

        assert!(matches!(
            read_message::<ControlRequest>(&mut bytes.as_slice()),
            Err(ProtocolError::Io(_))
        ));
    }

    #[test]
    fn a_frame_that_is_not_the_expected_message_is_reported_as_a_decode_error() {
        let mut bytes = Vec::new();
        write_message(&mut bytes, &"not a control request".to_owned()).unwrap();

        assert!(matches!(
            read_message::<ControlRequest>(&mut bytes.as_slice()),
            Err(ProtocolError::Decode(_))
        ));
    }

    #[test]
    fn a_write_that_fails_midway_surfaces_the_io_error() {
        struct FullDisk;

        impl std::io::Write for FullDisk {
            fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("no space left on device"))
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let error = write_message(
            &mut FullDisk,
            &ControlRequest {
                request_id: 1,
                command: ControlCommand::Ping,
            },
        )
        .expect_err("a failing writer should surface an error");

        assert!(matches!(error, ProtocolError::Io(_)));
        assert!(error.to_string().starts_with("helper protocol I/O failed"));
    }

    #[test]
    fn protocol_errors_describe_themselves() {
        assert_eq!(
            ProtocolError::MessageTooLarge(70_000_000).to_string(),
            "helper message exceeds 64 MiB: 70000000"
        );

        let decode = read_message::<ControlRequest>(&mut [0, 0, 0, 1, 0xc1].as_slice())
            .expect_err("0xc1 is never a valid MessagePack marker");
        assert!(
            decode
                .to_string()
                .starts_with("helper message decoding failed")
        );
    }
}
