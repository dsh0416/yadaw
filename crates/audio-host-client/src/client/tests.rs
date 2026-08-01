#[cfg(test)]
mod tests {
    use super::*;
    use ipc_channel::ipc::IpcSharedMemory;
    use std::sync::mpsc;
    use yadaw_dsp_runtime::protocol::{
        AudioEngineConfig, BinaryPayload, GraphTransactionRequest, GraphUpdate,
        LiveMixerGraph, LiveTempoEvent, LiveTimeSignatureEvent, MixerParameterPreview,
        MidiSyncPreferences, PluginAudioMode, PluginEditorPreference, PrepareGraphRequest,
        RecordingStartConfig, ResourceKind, ResourceRef, RoundTripLatencyMeasurementRequest,
        RpcRequestMeta, TransportControl,
    };
    use yadaw_ipc_transport::RegionOffer;

    fn empty_live_graph() -> LiveMixerGraph {
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

    fn rpc_meta() -> RpcRequestMeta {
        RpcRequestMeta {
            protocol_version: 1,
            request_id: "req-1".into(),
            target: None,
            expected_revision: None,
            mutation: None,
        }
    }

    fn project_graph_ref() -> ResourceRef {
        ResourceRef {
            kind: ResourceKind::ProjectGraph,
            id: "graph".into(),
            epoch: "1".into(),
            generation: 1,
        }
    }

    #[test]
    fn native_window_handle_requires_one_nonzero_pointer() {
        let handle = 0x1234usize;
        assert_eq!(
            decode_native_window_handle(Some(&handle.to_ne_bytes())).expect("valid handle"),
            Some(handle)
        );
        assert!(decode_native_window_handle(Some(&[])).is_err());
        assert!(decode_native_window_handle(Some(&[1, 2, 3])).is_err());
        assert!(decode_native_window_handle(Some(&0usize.to_ne_bytes())).is_err());
        assert_eq!(decode_native_window_handle(None).expect("no handle"), None);
    }

    #[test]
    fn parse_gesture_accepts_begin_perform_and_end() {
        assert!(matches!(
            parse_gesture("begin").expect("begin"),
            ParameterGesture::Begin
        ));
        assert!(matches!(
            parse_gesture("perform").expect("perform"),
            ParameterGesture::Perform
        ));
        assert!(matches!(
            parse_gesture("end").expect("end"),
            ParameterGesture::End
        ));
    }

    #[test]
    fn parse_gesture_rejects_unknown_values() {
        for value in ["", "BEGIN", "start", "finish", "cancel", "gesture"] {
            let error = parse_gesture(value).expect_err("invalid gesture");
            assert_eq!(error.status, Status::InvalidArg);
            assert!(error.reason.contains("invalid parameter gesture"));
        }
    }

    #[test]
    fn request_deadline_uses_sixty_seconds_for_audio_benchmark() {
        assert_eq!(
            request_deadline(&ControlCommand::RunAudioBenchmark {
                plugin_instance_ids: Vec::new(),
            }),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn request_deadline_uses_fifteen_seconds_for_extended_commands() {
        let extended = [
            ControlCommand::UpdateGraph {
                update: GraphUpdate::Replace {
                    revision: 1,
                    graph: empty_live_graph(),
                },
            },
            ControlCommand::PrepareGraph {
                meta: rpc_meta(),
                request: PrepareGraphRequest {
                    helper_epoch: "1".into(),
                    project_graph: project_graph_ref(),
                    base_revision: 0,
                    graph_revision: 1,
                    graph: empty_live_graph(),
                },
            },
            ControlCommand::ActivateGraph {
                meta: rpc_meta(),
                request: GraphTransactionRequest {
                    helper_epoch: "1".into(),
                    project_graph: project_graph_ref(),
                    base_revision: 0,
                },
            },
            ControlCommand::AbortGraph {
                meta: rpc_meta(),
                request: GraphTransactionRequest {
                    helper_epoch: "1".into(),
                    project_graph: project_graph_ref(),
                    base_revision: 0,
                },
            },
            ControlCommand::LoadPlugin {
                instance_id: "plugin".into(),
                module_path: "fixture.vst3".into(),
                class_id: "fixture".into(),
                plugin_kind: "effect".into(),
                audio_mode: PluginAudioMode::Stereo,
                sample_rate: 48_000.0,
                component_state: BinaryPayload::inline(Vec::new()),
                controller_state: BinaryPayload::inline(Vec::new()),
                ara_factory_class_id: None,
                ara_document_state: BinaryPayload::inline(Vec::new()),
            },
            ControlCommand::UnloadPlugin {
                instance_id: "plugin".into(),
            },
            ControlCommand::SavePluginState {
                instance_id: "plugin".into(),
            },
            ControlCommand::OpenPluginEditor {
                instance_id: "plugin".into(),
                preference: PluginEditorPreference::default(),
            },
            ControlCommand::ClosePluginEditor {
                instance_id: "plugin".into(),
            },
            ControlCommand::BenchmarkEcho {
                payload: BinaryPayload::inline(Vec::new()),
            },
        ];
        for command in &extended {
            assert_eq!(
                request_deadline(command),
                Duration::from_secs(15),
                "{command:?}"
            );
        }
    }

    #[test]
    fn request_deadline_uses_two_seconds_for_ordinary_commands() {
        let ordinary = [
            ControlCommand::Ping,
            ControlCommand::Shutdown,
            ControlCommand::ListAudioBackends,
            ControlCommand::ListAudioDevices {
                backend: "mock".into(),
            },
            ControlCommand::StartAudioEngine {
                config: AudioEngineConfig {
                    backend: "mock".into(),
                    input_device_id: "in".into(),
                    output_device_id: "out".into(),
                    buffer_size: 128,
                    session_sample_rate: Some(48_000),
                },
            },
            ControlCommand::StopAudioEngine,
            ControlCommand::AudioEngineSnapshot,
            ControlCommand::StartRoundTripLatencyMeasurement {
                request: RoundTripLatencyMeasurementRequest {
                    input_channel: 1,
                    output_channel: 1,
                },
            },
            ControlCommand::RoundTripLatencyMeasurementSnapshot,
            ControlCommand::GraphDeploymentSnapshot { meta: rpc_meta() },
            ControlCommand::PreviewMixerParameter {
                preview: MixerParameterPreview {
                    target: "channel".into(),
                    id: "audio-0".into(),
                    parameter: "gainDb".into(),
                    value: -6.0,
                },
            },
            ControlCommand::MixerSnapshot,
            ControlCommand::CompiledGraphSnapshot,
            ControlCommand::ClearMeterClips,
            ControlCommand::Transport {
                command: TransportControl {
                    kind: "play".into(),
                    position_frames: None,
                    loop_enabled: None,
                    loop_start_tick: None,
                    loop_end_tick: None,
                },
            },
            ControlCommand::TransportSnapshot,
            ControlCommand::MidiInputSnapshot,
            ControlCommand::ConfigureMidiInput {
                preferences: MidiSyncPreferences {
                    enabled: false,
                    source_port_id: None,
                    source_port_name: None,
                    input_offsets_ms: Default::default(),
                    control_port_ids: Default::default(),
                    capture_all_controls: false,
                },
            },
            ControlCommand::StartRecording {
                config: RecordingStartConfig {
                    path: "/tmp/rec.wav".into(),
                    asset_id: "asset".into(),
                    originator: "test".into(),
                    origination_date: "2026-07-31".into(),
                    origination_time: "12:00:00".into(),
                    time_reference: 0,
                },
            },
            ControlCommand::StopRecording,
            ControlCommand::StartMidiRecording {
                config: yadaw_dsp_runtime::protocol::MidiRecordingStartConfig { takes: Vec::new() },
            },
            ControlCommand::StopMidiRecording,
            ControlCommand::RecordingWaveform {
                start_frame: 0,
                end_frame: 100,
                max_buckets: 16,
            },
            ControlCommand::PluginParameters {
                instance_id: "plugin".into(),
            },
            ControlCommand::SetPluginParameter {
                instance_id: "plugin".into(),
                parameter_id: 1,
                normalized: 0.5,
                gesture: ParameterGesture::Perform,
            },
        ];
        for command in &ordinary {
            assert_eq!(
                request_deadline(command),
                Duration::from_secs(2),
                "{command:?}"
            );
        }
    }

    #[test]
    fn resolve_runtime_config_accepts_explicit_valid_values() {
        let config = resolve_runtime_config(Some(2), Some(4), Some(2)).expect("valid config");
        assert_eq!(config.worker_threads, 2);
        assert_eq!(config.max_blocking_threads, 4);
        assert_eq!(config.egress_concurrency, 2);
    }

    #[test]
    fn resolve_runtime_config_fills_defaults_within_bounds() {
        let config = resolve_runtime_config(None, None, None).expect("defaults");
        assert!((1..=8).contains(&config.worker_threads));
        assert!((2..=16).contains(&config.max_blocking_threads));
        assert!((1..=4).contains(&config.egress_concurrency));
        assert!(config.egress_concurrency <= config.max_blocking_threads);
        assert_eq!(
            config.max_blocking_threads,
            (config.worker_threads.saturating_mul(2)).clamp(2, 8)
        );
    }

    #[test]
    fn resolve_runtime_config_rejects_out_of_range_and_inconsistent_values() {
        assert!(resolve_runtime_config(Some(0), Some(2), Some(1)).is_err());
        assert!(resolve_runtime_config(Some(9), Some(2), Some(1)).is_err());
        assert!(resolve_runtime_config(Some(1), Some(1), Some(1)).is_err());
        assert!(resolve_runtime_config(Some(1), Some(17), Some(1)).is_err());
        assert!(resolve_runtime_config(Some(1), Some(2), Some(0)).is_err());
        assert!(resolve_runtime_config(Some(1), Some(2), Some(5)).is_err());
        assert!(resolve_runtime_config(Some(1), Some(2), Some(3)).is_err());
    }

    #[test]
    fn failure_helper_preserves_context_and_generic_status() {
        let error = failure("audio-host request", "deadline exceeded");
        assert_eq!(error.status, Status::GenericFailure);
        assert_eq!(error.reason, "audio-host request: deadline exceeded");
    }

    #[test]
    fn router_timeout_falls_back_to_poll_interval_when_nothing_is_pending() {
        let pending = Mutex::new(HashMap::<u64, Pending>::new());
        assert_eq!(router_timeout(&pending), ROUTER_POLL);
    }

    #[test]
    fn expire_pending_and_reject_all_are_noops_for_empty_maps() {
        let pending = Mutex::new(HashMap::<u64, Pending>::new());
        let timeouts = AtomicU64::new(0);
        expire_pending(&pending, &timeouts);
        assert_eq!(timeouts.load(Ordering::Relaxed), 0);
        reject_all(
            &pending,
            failure("audio-host request", "client closed"),
        );
        assert!(pending.lock().expect("pending lock").is_empty());
    }

    #[test]
    fn send_release_leases_encodes_a_priority_release_command() {
        let (sender, receiver) = mpsc::sync_channel(1);
        send_release_leases(&sender, vec![7, 11]);
        let packet = receiver.try_recv().expect("release packet queued");
        let request = decode_body::<PriorityRequest>(&packet.body).expect("priority request");
        assert_eq!(request.request_id, 0);
        match request.command {
            PriorityCommand::ReleaseLeases { lease_ids } => {
                assert_eq!(lease_ids, vec![7, 11]);
            }
            other => panic!("unexpected priority command: {other:?}"),
        }
    }

    #[test]
    fn transport_traffic_separates_inline_and_shared_packets() {
        let traffic = TransportTraffic::default();
        record_packet(
            &WirePacket {
                body: vec![1, 2, 3],
                region_offers: Vec::new(),
            },
            &traffic,
        );
        record_packet(
            &WirePacket {
                body: vec![4],
                region_offers: vec![
                    RegionOffer {
                        session_epoch: 1,
                        region_id: 1,
                        region_generation: 1,
                        capacity: 17,
                        memory: IpcSharedMemory::from_bytes(&[0; 17]),
                    },
                    RegionOffer {
                        session_epoch: 1,
                        region_id: 2,
                        region_generation: 1,
                        capacity: 8,
                        memory: IpcSharedMemory::from_bytes(&[0; 8]),
                    },
                ],
            },
            &traffic,
        );

        assert_eq!(traffic.inline_packets.load(Ordering::Relaxed), 1);
        assert_eq!(traffic.inline_bytes.load(Ordering::Relaxed), 3);
        assert_eq!(traffic.shared_packets.load(Ordering::Relaxed), 1);
        assert_eq!(traffic.shared_regions.load(Ordering::Relaxed), 2);
        assert_eq!(traffic.shared_bytes.load(Ordering::Relaxed), 25);
    }
}
