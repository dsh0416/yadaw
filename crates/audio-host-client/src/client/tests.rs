#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use yadaw_dsp_runtime::protocol::{
        AudioEngineConfig, BinaryPayload, ControlResponse, ControlResult, GraphTransactionRequest,
        GraphUpdate, INLINE_BLOB_LIMIT, LiveMixerGraph, LiveTempoEvent, LiveTimeSignatureEvent,
        MidiSyncPreferences, MixerParameterPreview, PluginAudioMode, PluginEditorPreference,
        PrepareGraphRequest, PriorityResult, RecordingStartConfig, ResourceKind, ResourceRef,
        RoundTripLatencyMeasurementRequest, RpcRequestMeta, TransportControl,
    };
    use yadaw_ipc_transport::{RegionOffer, TelemetryWriter, encode_response};

    #[derive(Debug, PartialEq)]
    enum PendingOutcome {
        Resolved {
            bytes: Vec<u8>,
            attachments: Vec<Vec<u8>>,
        },
        Rejected {
            status: Status,
            reason: String,
        },
    }

    struct TestPendingResponder(mpsc::SyncSender<PendingOutcome>);

    impl PendingResponder for TestPendingResponder {
        fn resolve(self: Box<Self>, bytes: Vec<u8>, attachments: Vec<Vec<u8>>) {
            let _ = self.0.send(PendingOutcome::Resolved { bytes, attachments });
        }

        fn reject(self: Box<Self>, error: Error) {
            let _ = self.0.send(PendingOutcome::Rejected {
                status: error.status,
                reason: error.reason.clone(),
            });
        }
    }

    struct RouterThread {
        closing: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl RouterThread {
        fn new(closing: Arc<AtomicBool>, handle: JoinHandle<()>) -> Self {
            Self {
                closing,
                handle: Some(handle),
            }
        }
    }

    impl Drop for RouterThread {
        fn drop(&mut self) {
            self.closing.store(true, Ordering::Release);
            if let Some(handle) = self.handle.take() {
                handle.join().expect("router thread should stop cleanly");
            }
        }
    }

    fn test_pending(deadline: Instant) -> (Pending, mpsc::Receiver<PendingOutcome>) {
        let (sender, receiver) = mpsc::sync_channel(1);
        (
            Pending {
                responder: Box::new(TestPendingResponder(sender)),
                deadline,
            },
            receiver,
        )
    }

    fn packet(body: Vec<u8>) -> WirePacket {
        WirePacket {
            body,
            region_offers: Vec::new(),
        }
    }

    fn wait_for_queued_event(events: &Mutex<VecDeque<Vec<u8>>>) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(event) = events.lock().expect("event queue lock").pop_front() {
                return event;
            }
            assert!(Instant::now() < deadline, "event router did not enqueue an event");
            thread::yield_now();
        }
    }

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
    fn shared_page_negotiation_activates_only_after_two_way_verification() {
        let telemetry_page = create_telemetry_page(64, 33, 1).expect("telemetry page");
        let parameter_page = create_parameter_ring(33, 1).expect("parameter page");
        let telemetry = TelemetryReader::map(telemetry_page).expect("telemetry reader");
        let parameters = ParameterProducer::map(parameter_page).expect("parameter producer");
        let peer_telemetry = yadaw_ipc_transport::TelemetryWriter::open_and_acknowledge(
            telemetry.descriptor(),
        )
        .expect("peer telemetry writer");
        let peer_parameters = yadaw_ipc_transport::ParameterConsumer::open_and_acknowledge(
            parameters.descriptor(),
        )
        .expect("peer parameter consumer");
        let (commands, command_receiver) = ipc::channel().expect("mapping command channel");
        let (event_sender, events) = ipc::channel().expect("mapping event channel");
        let peer = thread::spawn(move || {
            event_sender
                .send(MappingEvent::Mapped {
                    telemetry_generation: 1,
                    parameter_generation: 1,
                })
                .expect("send Mapped");
            assert_eq!(
                command_receiver.recv().expect("receive Activate"),
                MappingCommand::Activate {
                    telemetry_generation: 1,
                    parameter_generation: 1,
                }
            );
            event_sender
                .send(MappingEvent::Active {
                    telemetry_generation: 1,
                    parameter_generation: 1,
                })
                .expect("send Active");
            (peer_telemetry, peer_parameters)
        });

        assert!(negotiate_shared_pages(
            &commands,
            &events,
            &telemetry,
            &parameters,
        ));
        let _peer_mappings = peer.join().expect("peer thread");
    }

    #[test]
    fn shared_page_negotiation_aborts_an_unverified_generation() {
        let telemetry_page = create_telemetry_page(64, 34, 1).expect("telemetry page");
        let parameter_page = create_parameter_ring(34, 1).expect("parameter page");
        let telemetry = TelemetryReader::map(telemetry_page).expect("telemetry reader");
        let parameters = ParameterProducer::map(parameter_page).expect("parameter producer");
        let (commands, command_receiver) = ipc::channel().expect("mapping command channel");
        let (event_sender, events) = ipc::channel().expect("mapping event channel");
        event_sender
            .send(MappingEvent::Mapped {
                telemetry_generation: 2,
                parameter_generation: 1,
            })
            .expect("send invalid Mapped");

        assert!(!negotiate_shared_pages(
            &commands,
            &events,
            &telemetry,
            &parameters,
        ));
        assert_eq!(
            command_receiver.recv().expect("receive Abort"),
            MappingCommand::Abort
        );
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
    fn pending_registration_preserves_the_original_request_on_duplicate_id() {
        let pending = Mutex::new(HashMap::new());
        let (first, first_outcome) = test_pending(Instant::now() + Duration::from_secs(1));
        let (duplicate, duplicate_outcome) =
            test_pending(Instant::now() + Duration::from_secs(1));

        register_pending(&pending, 7, first).expect("register first request");
        let error = register_pending(&pending, 7, duplicate).expect_err("reject duplicate ID");
        resolve_pending(&pending, 7, vec![1, 2, 3], Vec::new());

        assert!(error.reason.contains("duplicate request identifier"));
        assert_eq!(
            first_outcome
                .recv_timeout(Duration::from_secs(1))
                .expect("original responder outcome"),
            PendingOutcome::Resolved {
                bytes: vec![1, 2, 3],
                attachments: Vec::new(),
            }
        );
        assert!(duplicate_outcome.try_recv().is_err());
    }

    #[test]
    fn pending_registration_enforces_the_outbound_capacity() {
        let pending = Mutex::new(HashMap::new());
        let mut responders = Vec::with_capacity(OUTBOUND_CAPACITY);
        for request_id in 0..OUTBOUND_CAPACITY as u64 {
            let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(1));
            register_pending(&pending, request_id, value).expect("register within capacity");
            responders.push(outcome);
        }
        let (overflow, overflow_outcome) = test_pending(Instant::now() + Duration::from_secs(1));

        let error = register_pending(&pending, u64::MAX, overflow)
            .expect_err("reject request beyond capacity");

        assert!(error.reason.contains("too many requests in flight"));
        assert_eq!(
            pending.lock().expect("pending lock").len(),
            OUTBOUND_CAPACITY
        );
        assert!(overflow_outcome.try_recv().is_err());
        reject_all(&pending, failure("test", "cleanup"));
        for outcome in responders {
            assert!(matches!(
                outcome.recv_timeout(Duration::from_secs(1)),
                Ok(PendingOutcome::Rejected { .. })
            ));
        }
    }

    #[test]
    fn queue_failure_rejects_and_removes_the_registered_request() {
        let pending = Mutex::new(HashMap::new());
        let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(1));
        register_pending(&pending, 9, value).expect("register request");
        let (sender, _receiver) = mpsc::sync_channel(1);
        sender.send(packet(vec![0])).expect("fill outbound queue");
        let outbound = Mutex::new(Some(sender));

        queue_pending_request(&pending, &outbound, 9, packet(vec![1]))
            .expect("full queue rejects the promise asynchronously");

        assert!(pending.lock().expect("pending lock").is_empty());
        let rejected = outcome
            .recv_timeout(Duration::from_secs(1))
            .expect("queue rejection");
        assert!(matches!(
            rejected,
            PendingOutcome::Rejected { reason, .. }
                if reason.contains("could not queue audio-host request")
        ));
    }

    #[test]
    fn closed_outbound_rejects_and_removes_the_registered_request() {
        let pending = Mutex::new(HashMap::new());
        let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(1));
        register_pending(&pending, 10, value).expect("register request");

        let error = queue_pending_request(&pending, &Mutex::new(None), 10, packet(vec![1]))
            .expect_err("closed queue returns an error");

        assert!(error.reason.contains("outbound queue: closed"));
        assert!(pending.lock().expect("pending lock").is_empty());
        assert!(matches!(
            outcome.recv_timeout(Duration::from_secs(1)),
            Ok(PendingOutcome::Rejected { reason, .. }) if reason.contains("outbound queue: closed")
        ));
    }

    #[test]
    fn disconnected_outbound_rejects_and_removes_the_registered_request() {
        let pending = Mutex::new(HashMap::new());
        let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(1));
        register_pending(&pending, 11, value).expect("register request");
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);

        queue_pending_request(
            &pending,
            &Mutex::new(Some(sender)),
            11,
            packet(vec![1]),
        )
        .expect("disconnected queue rejects the promise asynchronously");

        assert!(pending.lock().expect("pending lock").is_empty());
        assert!(matches!(
            outcome.recv_timeout(Duration::from_secs(1)),
            Ok(PendingOutcome::Rejected { reason, .. })
                if reason.contains("could not queue audio-host request")
        ));
    }

    #[test]
    fn poisoned_outbound_rejects_and_removes_the_registered_request() {
        let pending = Mutex::new(HashMap::new());
        let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(1));
        register_pending(&pending, 12, value).expect("register request");
        let (sender, _receiver) = mpsc::sync_channel(1);
        let outbound = Arc::new(Mutex::new(Some(sender)));
        let poison_target = Arc::clone(&outbound);
        let poisoner = thread::spawn(move || {
            let _guard = poison_target.lock().expect("outbound lock");
            panic!("poison outbound queue for the test");
        });
        assert!(poisoner.join().is_err());

        let error = queue_pending_request(&pending, &outbound, 12, packet(vec![1]))
            .expect_err("poisoned queue returns an error");

        assert!(error.reason.contains("outbound queue: poisoned"));
        assert!(pending.lock().expect("pending lock").is_empty());
        assert!(matches!(
            outcome.recv_timeout(Duration::from_secs(1)),
            Ok(PendingOutcome::Rejected { reason, .. })
                if reason.contains("outbound queue: poisoned")
        ));
    }

    #[test]
    fn expiry_rejects_only_elapsed_requests_and_counts_each_timeout() {
        let pending = Mutex::new(HashMap::new());
        let (expired, expired_outcome) =
            test_pending(Instant::now() - Duration::from_millis(1));
        let (active, active_outcome) = test_pending(Instant::now() + Duration::from_secs(30));
        register_pending(&pending, 1, expired).expect("register expired request");
        register_pending(&pending, 2, active).expect("register active request");
        let timeouts = AtomicU64::new(0);

        expire_pending(&pending, &timeouts);

        assert_eq!(timeouts.load(Ordering::Relaxed), 1);
        assert!(matches!(
            expired_outcome.recv_timeout(Duration::from_secs(1)),
            Ok(PendingOutcome::Rejected { reason, .. }) if reason.contains("deadline exceeded")
        ));
        assert!(active_outcome.try_recv().is_err());
        assert!(pending.lock().expect("pending lock").contains_key(&2));
        reject_all(&pending, failure("test", "cleanup"));
    }

    #[test]
    fn response_router_resolves_known_response_and_ignores_unknown_id() {
        let (sender, receiver) = ipc::channel().expect("response channel");
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(5));
        register_pending(&pending, 42, value).expect("register response");
        let (priority_outbound, _priority_inbox) = mpsc::sync_channel(4);
        let closing = Arc::new(AtomicBool::new(false));
        let handle = spawn_response_router(
            receiver,
            Arc::clone(&pending),
            priority_outbound,
            Arc::clone(&closing),
            Arc::new(AtomicU64::new(0)),
            Arc::new(TransportTraffic::default()),
            Arc::new(Mutex::new(ArenaReceiver::new(1))),
        )
        .expect("spawn response router");
        let _guard = RouterThread::new(closing, handle);
        let mut leases = LeaseRegistry::with_session_epoch(1);
        sender
            .send(
                encode_response(
                    ControlResponse {
                        request_id: 99,
                        result: ControlResult::Accepted,
                    },
                    &mut leases,
                )
                .expect("encode unknown response"),
            )
            .expect("send unknown response");
        sender
            .send(
                encode_response(
                    ControlResponse {
                        request_id: 42,
                        result: ControlResult::Pong,
                    },
                    &mut leases,
                )
                .expect("encode known response"),
            )
            .expect("send known response");

        let PendingOutcome::Resolved { bytes, attachments } = outcome
            .recv_timeout(Duration::from_secs(2))
            .expect("resolved response")
        else {
            panic!("response should resolve");
        };
        let response = decode_body::<ControlResponse>(&bytes).expect("decode resolved response");
        assert_eq!(response.request_id, 42);
        assert_eq!(response.result, ControlResult::Pong);
        assert!(attachments.is_empty());
        assert!(pending.lock().expect("pending lock").is_empty());
    }

    #[test]
    fn response_router_materializes_shared_payload_and_releases_its_lease() {
        let (sender, receiver) = ipc::channel().expect("response channel");
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (value, outcome) = test_pending(Instant::now() + Duration::from_secs(5));
        register_pending(&pending, 43, value).expect("register response");
        let (priority_outbound, priority_inbox) = mpsc::sync_channel(4);
        let closing = Arc::new(AtomicBool::new(false));
        let handle = spawn_response_router(
            receiver,
            Arc::clone(&pending),
            priority_outbound,
            Arc::clone(&closing),
            Arc::new(AtomicU64::new(0)),
            Arc::new(TransportTraffic::default()),
            Arc::new(Mutex::new(ArenaReceiver::new(7))),
        )
        .expect("spawn response router");
        let _guard = RouterThread::new(closing, handle);
        let payload = vec![0xa5; INLINE_BLOB_LIMIT + 1];
        let mut leases = LeaseRegistry::with_session_epoch(7);
        sender
            .send(
                encode_response(
                    ControlResponse {
                        request_id: 43,
                        result: ControlResult::BenchmarkEcho {
                            payload: BinaryPayload::inline(payload.clone()),
                        },
                    },
                    &mut leases,
                )
                .expect("encode shared response"),
            )
            .expect("send shared response");

        let PendingOutcome::Resolved { bytes, attachments } = outcome
            .recv_timeout(Duration::from_secs(2))
            .expect("resolved shared response")
        else {
            panic!("response should resolve");
        };
        let response = decode_body::<ControlResponse>(&bytes).expect("decode response body");
        let ControlResult::BenchmarkEcho {
            payload: BinaryPayload::Attachment { index, length, .. },
        } = response.result
        else {
            panic!("shared response should become an attachment");
        };
        assert_eq!(index, 0);
        assert_eq!(length, payload.len() as u64);
        assert_eq!(attachments, vec![payload]);
        let release = priority_inbox
            .recv_timeout(Duration::from_secs(2))
            .expect("lease release command");
        let release = decode_body::<PriorityRequest>(&release.body).expect("decode release");
        assert!(matches!(
            release.command,
            PriorityCommand::ReleaseLeases { lease_ids } if lease_ids.len() == 1
        ));
    }

    #[test]
    fn invalid_response_rejects_all_pending_requests() {
        let (sender, receiver) = ipc::channel().expect("response channel");
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (first, first_outcome) = test_pending(Instant::now() + Duration::from_secs(5));
        let (second, second_outcome) = test_pending(Instant::now() + Duration::from_secs(5));
        register_pending(&pending, 1, first).expect("register first response");
        register_pending(&pending, 2, second).expect("register second response");
        let (priority_outbound, _priority_inbox) = mpsc::sync_channel(1);
        let closing = Arc::new(AtomicBool::new(false));
        let handle = spawn_response_router(
            receiver,
            Arc::clone(&pending),
            priority_outbound,
            Arc::clone(&closing),
            Arc::new(AtomicU64::new(0)),
            Arc::new(TransportTraffic::default()),
            Arc::new(Mutex::new(ArenaReceiver::new(1))),
        )
        .expect("spawn response router");
        let _guard = RouterThread::new(closing, handle);

        sender.send(packet(vec![0xc1])).expect("send malformed response");

        for outcome in [first_outcome, second_outcome] {
            assert!(matches!(
                outcome.recv_timeout(Duration::from_secs(2)),
                Ok(PendingOutcome::Rejected { reason, .. })
                    if reason.contains("invalid audio-host response")
            ));
        }
        assert!(pending.lock().expect("pending lock").is_empty());
    }

    #[test]
    fn priority_router_resolves_valid_packet_and_rejects_invalid_packet() {
        let (sender, receiver) = ipc::channel().expect("priority response channel");
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (valid, valid_outcome) = test_pending(Instant::now() + Duration::from_secs(5));
        register_pending(&pending, 7, valid).expect("register priority response");
        let closing = Arc::new(AtomicBool::new(false));
        let handle = spawn_priority_router(
            receiver,
            Arc::clone(&pending),
            Arc::clone(&closing),
            Arc::new(AtomicU64::new(0)),
        )
        .expect("spawn priority router");
        let _guard = RouterThread::new(closing, handle);
        sender
            .send(
                encode_priority(&PriorityResponse {
                    request_id: 7,
                    result: PriorityResult::Accepted,
                })
                .expect("encode priority response"),
            )
            .expect("send priority response");

        let PendingOutcome::Resolved { bytes, attachments } = valid_outcome
            .recv_timeout(Duration::from_secs(2))
            .expect("resolved priority response")
        else {
            panic!("priority response should resolve");
        };
        assert!(attachments.is_empty());
        assert_eq!(
            decode_body::<PriorityResponse>(&bytes).expect("decode priority response"),
            PriorityResponse {
                request_id: 7,
                result: PriorityResult::Accepted,
            }
        );

        let (invalid, invalid_outcome) = test_pending(Instant::now() + Duration::from_secs(5));
        register_pending(&pending, 8, invalid).expect("register invalid response target");
        sender.send(packet(vec![0xc1])).expect("send invalid priority packet");
        assert!(matches!(
            invalid_outcome.recv_timeout(Duration::from_secs(2)),
            Ok(PendingOutcome::Rejected { reason, .. }) if reason.contains("invalid priority response")
        ));
    }

    #[test]
    fn event_router_bounds_fifo_and_keeps_the_newest_events() {
        let (sender, receiver) = ipc::channel().expect("event channel");
        let current_page = create_telemetry_page(64, 1, 1).expect("current telemetry page");
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let (priority_outbound, priority_inbox) = mpsc::sync_channel(1);
        let closing = Arc::new(AtomicBool::new(false));
        let handle = spawn_event_router(
            receiver,
            Arc::new(Mutex::new(LeaseRegistry::new())),
            Arc::new(RwLock::new(
                TelemetryReader::map(current_page).expect("current telemetry reader"),
            )),
            Arc::clone(&events),
            priority_outbound,
            Arc::clone(&closing),
        )
        .expect("spawn event router");
        let _guard = RouterThread::new(closing, handle);
        for revision in 0..=OUTBOUND_CAPACITY as u64 {
            sender
                .send(packet(
                    encode_body(&HostEvent::GraphPublished { revision })
                        .expect("encode graph event"),
                ))
                .expect("send graph event");
        }
        let barrier_page = create_telemetry_page(64, 2, 2).expect("barrier telemetry page");
        let barrier_writer =
            TelemetryWriter::map(barrier_page).expect("barrier telemetry writer");
        let descriptor = barrier_writer.descriptor();
        sender
            .send(packet(
                encode_body(&HostEvent::TelemetryPageOffer {
                    epoch: 2,
                    capacity: 64,
                    descriptor_version: descriptor.descriptor_version(),
                    object_id: descriptor.object_id(),
                    byte_len: descriptor.byte_len(),
                    generation: descriptor.generation(),
                })
                .expect("encode barrier offer"),
            ))
            .expect("send barrier offer");
        priority_inbox
            .recv_timeout(Duration::from_secs(2))
            .expect("event processing barrier");

        let queue = events.lock().expect("event queue lock");
        let first = decode_body::<HostEvent>(queue.front().expect("first event"))
            .expect("decode first event");
        let last =
            decode_body::<HostEvent>(queue.back().expect("last event")).expect("decode last event");
        assert_eq!(first, HostEvent::GraphPublished { revision: 1 });
        assert_eq!(
            last,
            HostEvent::GraphPublished {
                revision: OUTBOUND_CAPACITY as u64,
            }
        );
    }

    #[test]
    fn telemetry_page_activates_only_after_matching_active_event() {
        let (sender, receiver) = ipc::channel().expect("event channel");
        let current_page = create_telemetry_page(64, 10, 1).expect("current telemetry page");
        let telemetry = Arc::new(RwLock::new(
            TelemetryReader::map(current_page).expect("current telemetry reader"),
        ));
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let (priority_outbound, priority_inbox) = mpsc::sync_channel(2);
        let closing = Arc::new(AtomicBool::new(false));
        let handle = spawn_event_router(
            receiver,
            Arc::new(Mutex::new(LeaseRegistry::new())),
            Arc::clone(&telemetry),
            Arc::clone(&events),
            priority_outbound,
            Arc::clone(&closing),
        )
        .expect("spawn event router");
        let _guard = RouterThread::new(closing, handle);
        let next_page = create_telemetry_page(64, 11, 2).expect("next telemetry page");
        let next_writer = TelemetryWriter::map(next_page).expect("next telemetry writer");
        let descriptor = next_writer.descriptor();
        sender
            .send(packet(
                encode_body(&HostEvent::TelemetryPageOffer {
                    epoch: 11,
                    capacity: 64,
                    descriptor_version: descriptor.descriptor_version(),
                    object_id: descriptor.object_id(),
                    byte_len: descriptor.byte_len(),
                    generation: descriptor.generation(),
                })
                .expect("encode telemetry offer"),
            ))
            .expect("send telemetry offer");
        let ready = priority_inbox
            .recv_timeout(Duration::from_secs(2))
            .expect("telemetry ready command");
        assert!(matches!(
            decode_body::<PriorityRequest>(&ready.body)
                .expect("decode telemetry ready")
                .command,
            PriorityCommand::TelemetryPageReady {
                epoch: 11,
                generation: 2,
            }
        ));
        sender
            .send(packet(
                encode_body(&HostEvent::TelemetryPageActive {
                    epoch: 99,
                    generation: 2,
                })
                .expect("encode stale active"),
            ))
            .expect("send stale active");
        sender
            .send(packet(
                encode_body(&HostEvent::GraphPublished { revision: 1 })
                    .expect("encode barrier event"),
            ))
            .expect("send barrier event");
        let _barrier = wait_for_queued_event(&events);
        assert_eq!(telemetry.read().expect("telemetry read lock").epoch(), 10);

        sender
            .send(packet(
                encode_body(&HostEvent::TelemetryPageActive {
                    epoch: 11,
                    generation: 2,
                })
                .expect("encode active event"),
            ))
            .expect("send active event");
        sender
            .send(packet(
                encode_body(&HostEvent::GraphPublished { revision: 2 })
                    .expect("encode activation barrier"),
            ))
            .expect("send activation barrier");
        let _barrier = wait_for_queued_event(&events);
        assert_eq!(telemetry.read().expect("telemetry read lock").epoch(), 11);
    }

    #[test]
    fn egress_thread_forwards_packets_until_the_queue_closes() {
        let (ipc_sender, ipc_receiver) = ipc::channel().expect("IPC channel");
        let (sender, receiver) = mpsc::sync_channel(2);
        let handle = spawn_egress("test-egress", ipc_sender, receiver).expect("spawn egress");
        let expected_body = vec![1, 2, 3];

        sender
            .send(packet(expected_body.clone()))
            .expect("queue packet");
        let received = ipc_receiver
            .try_recv_timeout(Duration::from_secs(2))
            .expect("receive forwarded packet");
        assert_eq!(received.body, expected_body);
        assert!(received.region_offers.is_empty());
        drop(sender);
        handle.join().expect("egress exits after queue closes");
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
        let first_region = yadaw_ipc_transport::SharedMemory::create(
            std::num::NonZeroUsize::new(17).expect("non-zero region"),
            1,
        )
        .expect("first region");
        let second_region = yadaw_ipc_transport::SharedMemory::create(
            std::num::NonZeroUsize::new(8).expect("non-zero region"),
            1,
        )
        .expect("second region");
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
                        descriptor: first_region.descriptor(),
                    },
                    RegionOffer {
                        session_epoch: 1,
                        region_id: 2,
                        region_generation: 1,
                        capacity: 8,
                        descriptor: second_region.descriptor(),
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
