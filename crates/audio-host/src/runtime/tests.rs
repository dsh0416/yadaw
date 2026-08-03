#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_popup_ownership_replaces_only_the_same_owner() {
        let mut owners = HashMap::new();

        assert_eq!(replace_owned_popup(&mut owners, 1_u8, 10), None);
        assert_eq!(replace_owned_popup(&mut owners, 2, 20), None);
        assert_eq!(replace_owned_popup(&mut owners, 1, 11), Some(10));
        assert_eq!(owners.get(&1), Some(&11));
        assert_eq!(owners.get(&2), Some(&20));
    }

    #[test]
    fn editor_popup_owner_cleanup_is_isolated_and_idempotent() {
        let mut owners = HashMap::from([(1_u8, 10_u8), (2, 20)]);

        assert_eq!(remove_owned_popup(&mut owners, 1), Some(10));
        assert_eq!(remove_owned_popup(&mut owners, 1), None);
        assert_eq!(owners, HashMap::from([(2, 20)]));
    }

    struct TestIngress {
        requests: Option<ipc_channel::ipc::IpcSender<WirePacket>>,
        priority_requests: Option<ipc_channel::ipc::IpcSender<WirePacket>>,
        priority_responses: ipc_channel::ipc::IpcReceiver<WirePacket>,
        inbound_sender: mpsc::Sender<InboundRequest>,
        inbound: mpsc::Receiver<InboundRequest>,
        priority_sender: mpsc::Sender<PriorityIngress>,
        priority: mpsc::Receiver<PriorityIngress>,
        outbound: mpsc::Receiver<OutboundMessage>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl TestIngress {
        fn new(capacity: usize) -> Self {
            let (requests, request_receiver) = ipc::channel().expect("request IPC channel");
            let (priority_requests, priority_request_receiver) =
                ipc::channel().expect("priority request IPC channel");
            let (priority_response_sender, priority_responses) =
                ipc::channel().expect("priority response IPC channel");
            let (inbound_sender, inbound) = mpsc::channel(capacity);
            let (priority_sender, priority) = mpsc::channel(capacity);
            let (outbound_sender, outbound) = mpsc::channel(capacity);
            let audio_engine = Arc::new(engine::AudioEngine::new());
            let metrics = Arc::new(EgressMetrics::default());
            let handle = spawn_ingress(
                IngressChannels {
                    requests: request_receiver,
                    priority_requests: priority_request_receiver,
                    priority_responses: priority_response_sender,
                },
                IngressMailboxes {
                    inbound: inbound_sender.clone(),
                    priority: priority_sender.clone(),
                    outbound: outbound_sender,
                },
                Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(1))),
                Arc::new(Mutex::new(ArenaReceiver::new(1))),
                Liveness {
                    audio_engine,
                    ipc: Arc::new(AtomicU64::new(0)),
                    tokio: Arc::new(AtomicU64::new(0)),
                    winit: Arc::new(AtomicU64::new(0)),
                    egress: metrics,
                },
            )
            .expect("spawn ingress");
            Self {
                requests: Some(requests),
                priority_requests: Some(priority_requests),
                priority_responses,
                inbound_sender,
                inbound,
                priority_sender,
                priority,
                outbound,
                handle: Some(handle),
            }
        }

        fn send_request(&self, request: ControlRequest) {
            let mut leases = LeaseRegistry::with_session_epoch(1);
            let packet = yadaw_ipc_transport::encode_request(request, &mut leases)
                .expect("encode request");
            self.requests
                .as_ref()
                .expect("request sender")
                .send(packet)
                .expect("send request");
        }

        fn send_priority(&self, request: PriorityRequest) {
            let packet = encode_priority(&request).expect("encode priority request");
            self.priority_requests
                .as_ref()
                .expect("priority request sender")
                .send(packet)
                .expect("send priority request");
        }

        fn receive_priority_response(&self) -> PriorityResponse {
            let packet = self
                .priority_responses
                .try_recv_timeout(Duration::from_secs(2))
                .expect("priority response");
            decode_body(&packet.body).expect("decode priority response")
        }
    }

    impl Drop for TestIngress {
        fn drop(&mut self) {
            self.requests.take();
            self.priority_requests.take();
            if let Some(handle) = self.handle.take() {
                handle.join().expect("ingress thread should stop cleanly");
            }
        }
    }

    fn parameter_command(
        target_kind: yadaw_dsp_runtime::protocol::ParameterTargetKind,
        runtime_handle: u32,
        parameter_id: u32,
        normalized: f64,
    ) -> yadaw_dsp_runtime::protocol::ParameterCommand {
        yadaw_dsp_runtime::protocol::ParameterCommand {
            session_epoch: 1,
            sequence: 1,
            target_kind,
            runtime_handle,
            parameter_id,
            target_generation: 1,
            normalized,
            gesture: yadaw_dsp_runtime::protocol::ParameterGesture::Perform,
        }
    }

    async fn receive_ipc_packet(
        receiver: Arc<Mutex<ipc_channel::ipc::IpcReceiver<WirePacket>>>,
    ) -> WirePacket {
        tokio::task::spawn_blocking(move || {
            receiver
                .lock()
                .expect("IPC receiver lock")
                .try_recv_timeout(Duration::from_secs(2))
                .expect("IPC packet")
        })
        .await
        .expect("IPC receiver task")
    }

    #[test]
    fn editor_owner_window_rejects_null_and_invalid_handles() {
        assert_eq!(parse_editor_owner_window("4660"), Ok(4660));
        assert!(parse_editor_owner_window("0").is_err());
        assert!(parse_editor_owner_window("not-a-handle").is_err());
    }

    #[test]
    fn plugin_editor_is_created_hidden_until_native_attachment_is_ready() {
        let attributes = plugin_editor_window_attributes("Lead", "Pro-C", None);
        assert!(!attributes.visible);
        assert_eq!(attributes.title, "Lead — Pro-C — YADAW");
    }

    #[test]
    fn ui_mailbox_always_services_one_request_but_respects_fairness_limits() {
        assert!(should_drain_ui_request(
            0,
            WinitHost::UI_BUDGET.saturating_mul(10)
        ));
        assert!(should_drain_ui_request(
            WinitHost::UI_BATCH - 1,
            WinitHost::UI_BUDGET.saturating_sub(std::time::Duration::from_nanos(1))
        ));
        assert!(!should_drain_ui_request(1, WinitHost::UI_BUDGET));
        assert!(!should_drain_ui_request(
            WinitHost::UI_BATCH,
            std::time::Duration::ZERO
        ));
    }

    #[test]
    fn vst3_controller_requests_are_forwarded_as_typed_runtime_notifications() {
        assert_eq!(
            vst3_host_request_payload(&Vst3HostRequest::DirtyChanged(true)),
            Some(("dirty-changed", "true".to_owned()))
        );
        assert_eq!(
            vst3_host_request_payload(&Vst3HostRequest::OpenEditor {
                view_name: "editor".to_owned(),
            }),
            Some(("open-editor", "editor".to_owned()))
        );
        assert_eq!(
            vst3_host_request_payload(&Vst3HostRequest::ProgramListChanged {
                list_id: 7,
                program_index: 3,
            }),
            Some(("program-list-changed", "7:3".to_owned()))
        );
        assert_eq!(
            vst3_host_request_payload(&Vst3HostRequest::BusActivation {
                media_type: 0,
                direction: 1,
                index: 0,
                active: true,
            }),
            None
        );
    }

    fn graph_meta(epoch: &str, expected_revision: u64) -> RpcRequestMeta {
        RpcRequestMeta {
            protocol_version: IPC_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            target: Some(ResourceRef {
                kind: ResourceKind::AudioEngine,
                id: "engine".to_owned(),
                epoch: epoch.to_owned(),
                generation: 1,
            }),
            expected_revision: Some(expected_revision),
            mutation: Some(yadaw_dsp_runtime::protocol::RpcMutationMeta {
                operation_id: "operation-1".to_owned(),
                idempotency_key: "graph-1".to_owned(),
            }),
        }
    }

    fn graph_request(helper_epoch: &str, base_revision: u64) -> GraphTransactionRequest {
        GraphTransactionRequest {
            helper_epoch: helper_epoch.to_owned(),
            project_graph: ResourceRef {
                kind: ResourceKind::ProjectGraph,
                id: "project-graph".to_owned(),
                epoch: "main-epoch".to_owned(),
                generation: 4,
            },
            base_revision,
        }
    }

    #[test]
    fn graph_transaction_rejects_a_stale_helper_epoch_without_state_change() {
        let state = GraphTransactionState::new(7);
        let meta = graph_meta("6", 0);
        let error = validate_graph_request(&meta, &graph_request("6", 0), "7", 0)
            .expect_err("stale helper epoch must fail");

        assert_eq!(error.code, RpcErrorCode::StaleResource);
        assert_eq!(error.outcome, RpcMutationOutcome::NotCommitted);
        assert_eq!(state.snapshot().committed_revision, 0);
        assert!(state.snapshot().candidate.is_none());
    }

    #[test]
    fn graph_transaction_reports_revision_conflict_before_prepare() {
        let meta = graph_meta("7", 3);
        let error = validate_graph_request(&meta, &graph_request("7", 3), "7", 4)
            .expect_err("stale base revision must fail");

        assert_eq!(error.code, RpcErrorCode::RevisionConflict);
        assert!(matches!(
            error.details,
            Some(RpcErrorDetails::RevisionConflict {
                expected_revision: 3,
                actual_revision: 4,
            })
        ));
    }

    #[test]
    fn graph_abort_is_idempotent_when_no_candidate_exists() {
        let mut state = GraphTransactionState::new(7);

        assert!(!state.abort("operation-1"));
        assert!(!state.abort("operation-1"));
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Empty);
    }

    #[test]
    fn abort_after_commit_preserves_the_committed_operation_outcome() {
        let mut state = GraphTransactionState::new(7);
        let project_graph = graph_request("7", 0).project_graph;
        state.commit("operation-1".to_owned(), project_graph, 1);

        assert!(!state.abort("operation-1"));
        assert!(matches!(
            state.snapshot().last_operation,
            Some(GraphOperationSnapshot {
                outcome: GraphOperationOutcome::Committed,
                ..
            })
        ));
    }

    fn engine_ref(epoch: &str, generation: u32) -> ResourceRef {
        ResourceRef {
            kind: ResourceKind::AudioEngine,
            id: "engine".to_owned(),
            epoch: epoch.to_owned(),
            generation,
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
            tempo_events: vec![],
            time_signature_events: vec![],
        }
    }

    fn mixer_parameter_graph() -> LiveMixerGraph {
        use yadaw_dsp_runtime::protocol::{LiveMixerChannel, LiveMixerSend, LiveMixerSendTap};
        LiveMixerGraph {
            channels: vec![LiveMixerChannel {
                id: "channel-1".into(),
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
                input_channels: Vec::new(),
                hardware_output_channels: Vec::new(),
            }],
            sends: vec![LiveMixerSend {
                id: "send-1".into(),
                source_channel_id: "channel-1".into(),
                target_channel_id: None,
                target_bus: None,
                enabled: true,
                tap: LiveMixerSendTap::Post,
                level_db: 0.0,
            }],
            ..empty_live_graph()
        }
    }

    fn minimal_native_graph(generation: u64) -> engine::NativeMixerGraph {
        use engine::NativeMixerChannel;
        use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
        engine::NativeMixerGraph {
            generation,
            sample_rate: 48_000,
            channels: vec![
                NativeMixerChannel {
                    id: "audio".into(),
                    kind: "audio".into(),
                    system_role: None,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output_index: Some(2),
                    output_bus: None,
                    record_armed: false,
                    input_monitoring: false,
                    input_source: Some("hardware".into()),
                    input_channels: vec![1, 2],
                    hardware_output_channels: vec![],
                    midi_input_port_id: None,
                    midi_input_channel: None,
                },
                NativeMixerChannel {
                    id: "master".into(),
                    kind: "master".into(),
                    system_role: None,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output_index: None,
                    output_bus: None,
                    record_armed: false,
                    input_monitoring: false,
                    input_source: None,
                    input_channels: vec![],
                    hardware_output_channels: vec![],
                    midi_input_port_id: None,
                    midi_input_channel: None,
                },
                NativeMixerChannel {
                    id: "output".into(),
                    kind: "output".into(),
                    system_role: None,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output_index: None,
                    output_bus: None,
                    record_armed: false,
                    input_monitoring: false,
                    input_source: None,
                    input_channels: vec![],
                    hardware_output_channels: vec![1, 2],
                    midi_input_port_id: None,
                    midi_input_channel: None,
                },
            ],
            sends: vec![],
            clips: vec![],
            plugins: vec![],
            midi_clips: vec![],
            tempo_events: vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        }
    }

    fn prepared_candidate(
        operation_id: &str,
        project_graph: ResourceRef,
        base_revision: u64,
        graph_revision: u64,
    ) -> PreparedGraphCandidate {
        let audio_engine = engine::AudioEngine::new();
        let input = audio_engine.begin_graph_build(minimal_native_graph(graph_revision))
            .expect("begin graph build for transaction fixture");
        let built = engine::compile_graph_build(input).expect("compile graph build fixture");
        PreparedGraphCandidate {
            operation_id: operation_id.to_owned(),
            project_graph,
            base_revision,
            graph_revision,
            graph: empty_live_graph(),
            built,
        }
    }

    #[test]
    fn validate_graph_meta_rejects_protocol_mismatch() {
        let mut meta = graph_meta("7", 0);
        meta.protocol_version = IPC_PROTOCOL_VERSION.wrapping_add(1);
        let error = validate_graph_meta(&meta, "7", true).expect_err("protocol must fail");
        assert_eq!(error.code, RpcErrorCode::ProtocolMismatch);
        assert_eq!(error.outcome, RpcMutationOutcome::NotCommitted);
    }

    #[test]
    fn validate_graph_meta_rejects_missing_target() {
        let mut meta = graph_meta("7", 0);
        meta.target = None;
        let error = validate_graph_meta(&meta, "7", true).expect_err("target must be required");
        assert_eq!(error.code, RpcErrorCode::ValidationFailed);
    }

    #[test]
    fn validate_graph_meta_rejects_stale_engine_generation() {
        let mut meta = graph_meta("7", 0);
        meta.target = Some(engine_ref("7", 0));
        let error = validate_graph_meta(&meta, "7", true).expect_err("generation 0 is stale");
        assert_eq!(error.code, RpcErrorCode::StaleResource);
    }

    #[test]
    fn validate_graph_meta_rejects_missing_mutation_when_required() {
        let mut meta = graph_meta("7", 0);
        meta.mutation = None;
        let error = validate_graph_meta(&meta, "7", true).expect_err("mutation required");
        assert_eq!(error.code, RpcErrorCode::ValidationFailed);
        assert!(validate_graph_meta(&meta, "7", false).is_ok());
    }

    #[test]
    fn validate_graph_request_rejects_non_project_graph_target() {
        let meta = graph_meta("7", 0);
        let mut request = graph_request("7", 0);
        request.project_graph.kind = ResourceKind::AudioEngine;
        let error = validate_graph_request(&meta, &request, "7", 0)
            .expect_err("project graph kind must be validated");
        assert_eq!(error.code, RpcErrorCode::ValidationFailed);
    }

    #[test]
    fn validate_graph_request_rejects_expected_revision_mismatch() {
        let mut meta = graph_meta("7", 0);
        meta.expected_revision = Some(1);
        let error = validate_graph_request(&meta, &graph_request("7", 0), "7", 0)
            .expect_err("meta expected revision must match request");
        assert_eq!(error.code, RpcErrorCode::RevisionConflict);
    }

    #[test]
    fn commit_moves_snapshot_from_empty_to_active() {
        let mut state = GraphTransactionState::new(7);
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Empty);
        assert_eq!(state.snapshot().helper_epoch, "7");

        let project_graph = graph_request("7", 0).project_graph;
        state.observe_engine(engine_ref("7", 1));
        state.commit("operation-1".to_owned(), project_graph.clone(), 3);

        let snapshot = state.snapshot();
        assert_eq!(snapshot.status, GraphDeploymentStatus::Active);
        assert_eq!(snapshot.committed_revision, 3);
        assert_eq!(snapshot.committed_project_graph, Some(project_graph));
        assert_eq!(snapshot.engine.id, "engine");
        assert!(matches!(
            snapshot.last_operation,
            Some(GraphOperationSnapshot {
                outcome: GraphOperationOutcome::Committed,
                graph_revision: 3,
                ..
            })
        ));
    }

    #[test]
    fn prepare_marks_snapshot_prepared_and_abort_clears_candidate() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        let project_graph = graph_request("7", 0).project_graph;
        state.prepare(prepared_candidate(
            "operation-1",
            project_graph.clone(),
            0,
            1,
        ));

        let prepared = state.snapshot();
        assert_eq!(prepared.status, GraphDeploymentStatus::Prepared);
        assert_eq!(
            prepared.candidate.as_ref().map(|c| c.operation_id.as_str()),
            Some("operation-1")
        );

        assert!(state.abort("operation-1"));
        let after_abort = state.snapshot();
        assert!(after_abort.candidate.is_none());
        assert_eq!(after_abort.status, GraphDeploymentStatus::Empty);
        assert!(matches!(
            after_abort.last_operation,
            Some(GraphOperationSnapshot {
                outcome: GraphOperationOutcome::NotCommitted,
                graph_revision: 1,
                ..
            })
        ));
    }

    #[test]
    fn abort_after_prepare_with_wrong_operation_id_is_noop() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        state.prepare(prepared_candidate(
            "operation-1",
            graph_request("7", 0).project_graph,
            0,
            1,
        ));

        assert!(!state.abort("operation-other"));
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Prepared);
        assert_eq!(
            state
                .snapshot()
                .candidate
                .as_ref()
                .map(|c| c.operation_id.as_str()),
            Some("operation-1")
        );
    }

    #[test]
    fn take_candidate_requires_matching_operation_id_and_restore_puts_it_back() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        state.prepare(prepared_candidate(
            "operation-1",
            graph_request("7", 0).project_graph,
            0,
            2,
        ));

        assert!(state.take_candidate("operation-other").is_none());
        assert!(state.snapshot().candidate.is_some());

        let candidate = state
            .take_candidate("operation-1")
            .expect("matching operation must take");
        assert!(state.snapshot().candidate.is_none());
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Empty);

        state.restore_candidate(candidate);
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Prepared);
        assert_eq!(
            state
                .snapshot()
                .candidate
                .as_ref()
                .map(|c| c.graph_revision),
            Some(2)
        );
    }

    #[test]
    fn activate_commit_clears_prepared_candidate_path() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        let project_graph = graph_request("7", 0).project_graph;
        state.prepare(prepared_candidate(
            "operation-1",
            project_graph.clone(),
            0,
            1,
        ));
        let candidate = state
            .take_candidate("operation-1")
            .expect("prepared candidate must activate");
        state.commit(
            candidate.operation_id,
            candidate.project_graph,
            candidate.graph_revision,
        );

        let snapshot = state.snapshot();
        assert!(snapshot.candidate.is_none());
        assert_eq!(snapshot.status, GraphDeploymentStatus::Active);
        assert_eq!(snapshot.committed_revision, 1);
        assert_eq!(snapshot.committed_project_graph, Some(project_graph));
    }

    #[test]
    fn double_activate_fails_once_candidate_is_consumed() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        state.prepare(prepared_candidate(
            "operation-1",
            graph_request("7", 0).project_graph,
            0,
            1,
        ));
        let first = state.take_candidate("operation-1");
        assert!(first.is_some());
        assert!(state.take_candidate("operation-1").is_none());
        assert!(!state.abort("operation-1"));
    }

    #[test]
    fn prepare_replaces_an_existing_candidate() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        let project_graph = graph_request("7", 0).project_graph;
        state.prepare(prepared_candidate(
            "operation-1",
            project_graph.clone(),
            0,
            1,
        ));
        state.prepare(prepared_candidate("operation-2", project_graph, 0, 2));

        assert!(state.take_candidate("operation-1").is_none());
        let second = state
            .take_candidate("operation-2")
            .expect("latest prepare must win");
        assert_eq!(second.graph_revision, 2);
    }

    #[test]
    fn observe_legacy_commit_clears_degraded_and_last_operation() {
        let mut state = GraphTransactionState::new(7);
        state.degraded = true;
        state.commit(
            "operation-1".to_owned(),
            graph_request("7", 0).project_graph,
            4,
        );
        state.observe_legacy_commit(9);

        let snapshot = state.snapshot();
        assert_eq!(snapshot.committed_revision, 9);
        assert!(snapshot.committed_project_graph.is_none());
        assert!(snapshot.last_operation.is_none());
        assert_eq!(snapshot.status, GraphDeploymentStatus::Active);
    }

    #[test]
    fn finish_not_committed_records_operation_without_changing_revision() {
        let mut state = GraphTransactionState::new(7);
        state.commit(
            "operation-1".to_owned(),
            graph_request("7", 0).project_graph,
            2,
        );
        state.finish_not_committed("operation-2".to_owned(), 3);

        let snapshot = state.snapshot();
        assert_eq!(snapshot.committed_revision, 2);
        assert_eq!(snapshot.status, GraphDeploymentStatus::Active);
        assert!(matches!(
            snapshot.last_operation,
            Some(GraphOperationSnapshot {
                operation_id,
                outcome: GraphOperationOutcome::NotCommitted,
                graph_revision: 3,
            }) if operation_id == "operation-2"
        ));
    }

    #[test]
    fn degraded_status_wins_over_prepared_and_active() {
        let _guard = engine::GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = GraphTransactionState::new(7);
        state.commit(
            "operation-1".to_owned(),
            graph_request("7", 0).project_graph.clone(),
            1,
        );
        state.degraded = true;
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Degraded);

        state.prepare(prepared_candidate(
            "operation-2",
            graph_request("7", 0).project_graph,
            1,
            2,
        ));
        assert_eq!(state.snapshot().status, GraphDeploymentStatus::Degraded);
    }

    #[test]
    fn graph_busy_error_includes_active_operation_id() {
        let meta = graph_meta("7", 0);
        let error = graph_busy_error(&meta, Some("operation-1".to_owned()));
        assert_eq!(error.code, RpcErrorCode::ResourceBusy);
        assert_eq!(error.retry, RpcRetry::Safe);
        assert!(matches!(
            error.details,
            Some(RpcErrorDetails::ResourceBusy {
                active_operation_id: Some(ref id),
            }) if id == "operation-1"
        ));
    }

    #[test]
    fn successful_validate_graph_request_accepts_matching_revisions() {
        let meta = graph_meta("7", 2);
        let validated = validate_graph_request(&meta, &graph_request("7", 2), "7", 2)
            .expect("matching revisions must validate");
        assert_eq!(validated.engine.epoch, "7");
        assert_eq!(validated.operation_id.as_deref(), Some("operation-1"));
    }

    #[test]
    fn graph_snapshot_can_report_an_observed_revision_ahead_of_commit() {
        let mut state = GraphTransactionState::new(7);
        state.observe_legacy_commit(3);
        let snapshot = state.snapshot_at(5);
        assert_eq!(snapshot.committed_revision, 3);
        assert_eq!(snapshot.observed_revision, 5);
        assert_eq!(snapshot.status, GraphDeploymentStatus::Active);
    }

    #[test]
    fn graph_snapshot_with_engine_reads_published_generation() {
        let engine = engine::AudioEngine::new();
        let state = GraphTransactionState::new(7);
        let snapshot = state.snapshot_with_engine(&engine);
        assert_eq!(snapshot.observed_revision, engine.published_graph_generation());
        assert_eq!(snapshot.status, GraphDeploymentStatus::Empty);
    }

    #[test]
    fn engine_command_rejects_graph_patches_on_the_compat_path() {
        let engine = engine::AudioEngine::new();
        let result = engine_command(
            &engine,
            ControlCommand::UpdateGraph {
                update: GraphUpdate::Patch {
                    base_revision: 1,
                    revision: 2,
                    ops: Vec::new(),
                },
            },
            None,
        )
        .expect("compat path must answer graph patch commands");
        assert!(matches!(result, ControlResult::Error { .. }));
    }

    #[test]
    fn engine_command_returns_compiled_graph_snapshot_for_a_stopped_engine() {
        let engine = engine::AudioEngine::new();
        let result = engine_command(&engine, ControlCommand::CompiledGraphSnapshot, None)
            .expect("compiled graph snapshot must be handled");
        assert!(matches!(
            result,
            ControlResult::CompiledGraphSnapshot { snapshot: None }
        ));
    }

    #[test]
    fn engine_command_snapshots_a_stopped_audio_engine() {
        let engine = engine::AudioEngine::new();
        let result = engine_command(&engine, ControlCommand::AudioEngineSnapshot, None)
            .expect("audio engine snapshot must be handled");
        match result {
            ControlResult::AudioRuntime { runtime } => {
                assert_eq!(runtime.state, "stopped");
            }
            other => panic!("expected audio runtime, got {other:?}"),
        }
    }

    #[test]
    fn runtime_config_validates_each_bound_and_cross_field_constraint() {
        assert!(RuntimeConfig::auto().validate().is_ok());
        assert!(RuntimeConfig {
            worker_threads: 1,
            max_blocking_threads: 2,
            egress_concurrency: 1,
        }
        .validate()
        .is_ok());
        for invalid in [
            RuntimeConfig {
                worker_threads: 0,
                max_blocking_threads: 2,
                egress_concurrency: 1,
            },
            RuntimeConfig {
                worker_threads: 9,
                max_blocking_threads: 2,
                egress_concurrency: 1,
            },
            RuntimeConfig {
                worker_threads: 1,
                max_blocking_threads: 1,
                egress_concurrency: 1,
            },
            RuntimeConfig {
                worker_threads: 1,
                max_blocking_threads: 17,
                egress_concurrency: 1,
            },
            RuntimeConfig {
                worker_threads: 1,
                max_blocking_threads: 2,
                egress_concurrency: 0,
            },
            RuntimeConfig {
                worker_threads: 1,
                max_blocking_threads: 2,
                egress_concurrency: 3,
            },
        ] {
            assert!(invalid.validate().is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn protocol_routing_classifies_commands_and_deadlines_by_owner() {
        assert!(is_vst3_command(&ControlCommand::Ping));
        assert!(is_vst3_command(&ControlCommand::PluginParameters {
            instance_id: "plugin".into(),
        }));
        assert!(!is_vst3_command(&ControlCommand::AudioEngineSnapshot));
        assert!(is_background_io_command(&ControlCommand::ListAudioBackends));
        assert!(is_background_io_command(&ControlCommand::ListAudioDevices {
            backend: "mock".into(),
        }));
        assert!(!is_background_io_command(&ControlCommand::Ping));
        assert_eq!(
            protocol_deadline(&ControlCommand::RunAudioBenchmark {
                plugin_instance_ids: Vec::new(),
            }),
            Duration::from_secs(60)
        );
        assert_eq!(
            protocol_deadline(&ControlCommand::OpenPluginEditor {
                instance_id: "plugin".into(),
                preference: PluginEditorPreference::default(),
                context: PluginEditorContext::default(),
            }),
            Duration::from_secs(15)
        );
        assert_eq!(
            protocol_deadline(&ControlCommand::AudioEngineSnapshot),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn deferred_binary_accepts_inline_and_rejects_unresolved_attachment() {
        let arena = Arc::new(Mutex::new(ArenaReceiver::new(1)));
        let inline = resolve_deferred_binary(BinaryPayload::inline(vec![1, 2, 3]), &arena)
            .expect("inline binary");
        assert_eq!(inline.as_slice(), [1, 2, 3]);

        let error = match resolve_deferred_binary(
            BinaryPayload::Attachment {
                index: 0,
                offset: 0,
                length: 3,
            },
            &arena,
        ) {
            Ok(_) => panic!("attachment should be materialized before the actor"),
            Err(error) => error,
        };
        assert!(error.contains("Node attachment"));
    }

    #[test]
    fn telemetry_transport_state_codes_are_stable() {
        assert_eq!(transport_state_code("stopped"), 0);
        assert_eq!(transport_state_code("playing"), 1);
        assert_eq!(transport_state_code("recording"), 2);
        assert_eq!(transport_state_code("waiting"), 3);
        assert_eq!(transport_state_code("counting-in"), 4);
        assert_eq!(transport_state_code("future-state"), 0);
    }

    #[test]
    fn graph_parameter_handles_refresh_without_retaining_stale_entries() {
        let handles = Mutex::new(GraphParameterHandles::default());
        let graph = mixer_parameter_graph();

        refresh_graph_handles(&handles, &graph);

        let channel_handle = stable_runtime_handle(1, "channel-1");
        let send_handle = stable_runtime_handle(2, "send-1");
        let values = handles.lock().expect("parameter handles");
        assert_eq!(values.channels.get(&channel_handle).map(String::as_str), Some("channel-1"));
        assert_eq!(values.sends.get(&send_handle).map(String::as_str), Some("send-1"));
        assert_ne!(channel_handle, send_handle);
        drop(values);

        refresh_graph_handles(&handles, &empty_live_graph());
        let values = handles.lock().expect("refreshed parameter handles");
        assert!(values.channels.is_empty());
        assert!(values.sends.is_empty());
    }

    #[test]
    fn mixer_parameter_routing_accepts_gain_and_pan_and_rejects_invalid_targets() {
        use yadaw_dsp_runtime::protocol::ParameterTargetKind;
        let audio_engine = engine::AudioEngine::new();
        let handles = Mutex::new(GraphParameterHandles::default());
        refresh_graph_handles(&handles, &mixer_parameter_graph());
        let channel_handle = stable_runtime_handle(1, "channel-1");
        let send_handle = stable_runtime_handle(2, "send-1");

        assert!(matches!(
            mixer_parameter_command(
                &audio_engine,
                &handles,
                parameter_command(ParameterTargetKind::MixerChannel, channel_handle, 0, 0.5),
            ),
            ControlResult::Accepted
        ));
        assert!(matches!(
            mixer_parameter_command(
                &audio_engine,
                &handles,
                parameter_command(ParameterTargetKind::MixerChannel, channel_handle, 1, 0.25),
            ),
            ControlResult::Accepted
        ));
        assert!(matches!(
            mixer_parameter_command(
                &audio_engine,
                &handles,
                parameter_command(ParameterTargetKind::MixerSend, send_handle, 0, 0.75),
            ),
            ControlResult::Accepted
        ));
        for invalid in [
            parameter_command(ParameterTargetKind::MixerChannel, u32::MAX, 0, 0.5),
            parameter_command(ParameterTargetKind::MixerChannel, channel_handle, 99, 0.5),
            parameter_command(ParameterTargetKind::MixerSend, send_handle, 99, 0.5),
            parameter_command(ParameterTargetKind::Plugin, 1, 0, 0.5),
        ] {
            assert!(matches!(
                mixer_parameter_command(&audio_engine, &handles, invalid),
                ControlResult::Error { .. }
            ));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn actor_dispatch_reports_closed_sender_and_dropped_response() {
        let (closed_sender, closed_inbox) = mpsc::channel(1);
        drop(closed_inbox);
        assert!(matches!(
            dispatch_actor_command(&closed_sender, ActorCommand::Control(ControlCommand::Ping))
                .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));

        let (dropped_sender, mut dropped_inbox) = mpsc::channel::<ActorRequest>(1);
        let dropper = tokio::spawn(async move {
            let request = dropped_inbox.recv().await.expect("actor request");
            drop(request.reply);
        });
        assert!(matches!(
            dispatch_actor_command(&dropped_sender, ActorCommand::Control(ControlCommand::Ping))
                .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));
        dropper.await.expect("dropper task");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn engine_and_background_actors_enforce_command_ownership() {
        use yadaw_dsp_runtime::protocol::ParameterTargetKind;
        let audio_engine = Arc::new(engine::AudioEngine::new());
        let handles = Arc::new(Mutex::new(GraphParameterHandles::default()));
        let (engine_sender, engine_inbox) = mpsc::channel(4);
        let engine_task = tokio::spawn(engine_actor(
            engine_inbox,
            Arc::clone(&handles),
            Arc::clone(&audio_engine),
        ));
        assert!(matches!(
            dispatch_actor_command(
                &engine_sender,
                ActorCommand::SyncAraGraph {
                    graph: Some(empty_live_graph()),
                },
            )
            .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));
        assert!(matches!(
            dispatch_actor_command(
                &engine_sender,
                ActorCommand::BuildGraph {
                    graph: minimal_native_graph(1),
                },
            )
            .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));
        assert!(matches!(
            dispatch_actor_command(
                &engine_sender,
                ActorCommand::Parameter(parameter_command(ParameterTargetKind::Plugin, 1, 0, 0.5)),
            )
            .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));
        drop(engine_sender);
        engine_task.await.expect("engine actor task");

        let (unused_engine_sender, unused_engine_inbox) = mpsc::channel(1);
        drop(unused_engine_inbox);
        let (background_sender, background_inbox) = mpsc::channel(4);
        let background_task = tokio::spawn(background_io_actor(
            background_inbox,
            unused_engine_sender,
            WorkerSupervisor::new(),
            audio_engine,
        ));
        assert!(matches!(
            dispatch_actor_command(
                &background_sender,
                ActorCommand::Parameter(parameter_command(
                    ParameterTargetKind::MixerChannel,
                    1,
                    0,
                    0.5,
                )),
            )
            .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));
        assert!(matches!(
            dispatch_actor_command(
                &background_sender,
                ActorCommand::SyncAraGraph { graph: None },
            )
            .await,
            ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
        ));
        drop(background_sender);
        background_task.await.expect("background actor task");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ingress_forwards_normal_requests_and_reports_a_full_mailbox() {
        let mut ingress = TestIngress::new(1);
        ingress.send_request(ControlRequest {
            request_id: 1,
            command: ControlCommand::Ping,
        });
        let received = tokio::time::timeout(Duration::from_secs(2), ingress.inbound.recv())
            .await
            .expect("normal ingress timeout")
            .expect("normal ingress request");
        assert_eq!(received.request.request_id, 1);
        assert!(matches!(received.request.command, ControlCommand::Ping));
        assert!(received.received_leases.is_empty());

        ingress
            .inbound_sender
            .try_send(InboundRequest {
                request: ControlRequest {
                    request_id: 99,
                    command: ControlCommand::Ping,
                },
                received_leases: Vec::new(),
            })
            .expect("fill inbound mailbox");
        ingress.send_request(ControlRequest {
            request_id: 2,
            command: ControlCommand::Ping,
        });
        let busy = tokio::time::timeout(Duration::from_secs(2), ingress.outbound.recv())
            .await
            .expect("busy response timeout")
            .expect("busy response");
        assert!(matches!(
            busy,
            OutboundMessage::Response {
                value: ControlResponse {
                    request_id: 2,
                    result: ControlResult::Busy,
                },
                request_leases,
            } if request_leases.is_empty()
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn priority_ingress_handles_heartbeat_busy_and_acknowledged_shutdown() {
        let mut ingress = TestIngress::new(1);
        ingress.send_priority(PriorityRequest {
            request_id: 1,
            command: PriorityCommand::Heartbeat,
        });
        assert!(matches!(
            ingress.receive_priority_response(),
            PriorityResponse {
                request_id: 1,
                result: PriorityResult::Heartbeat {
                    ipc_generation: 1,
                    ..
                },
            }
        ));

        ingress
            .priority_sender
            .try_send(PriorityIngress::ParameterWake)
            .expect("fill priority mailbox");
        ingress.send_priority(PriorityRequest {
            request_id: 2,
            command: PriorityCommand::ParameterWake,
        });
        assert_eq!(
            ingress.receive_priority_response(),
            PriorityResponse {
                request_id: 2,
                result: PriorityResult::Busy,
            }
        );
        assert!(matches!(
            ingress.priority.try_recv(),
            Ok(PriorityIngress::ParameterWake)
        ));

        ingress.send_priority(PriorityRequest {
            request_id: 3,
            command: PriorityCommand::Shutdown,
        });
        assert_eq!(
            ingress.receive_priority_response(),
            PriorityResponse {
                request_id: 3,
                result: PriorityResult::Accepted,
            }
        );
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), ingress.priority.recv())
                .await
                .expect("shutdown notification timeout"),
            Some(PriorityIngress::Shutdown)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn egress_sends_responses_release_events_and_drains_on_shutdown() {
        let (response_sender, responses) = ipc::channel().expect("response IPC channel");
        let responses = Arc::new(Mutex::new(responses));
        let (event_sender, events) = ipc::channel().expect("event IPC channel");
        let events = Arc::new(Mutex::new(events));
        let (outbound, outbound_inbox) = mpsc::channel(4);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let metrics = Arc::new(EgressMetrics::default());
        let task = tokio::spawn(run_egress(
            outbound_inbox,
            response_sender,
            event_sender,
            EgressArenas {
                responses: Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(1))),
                requests: Arc::new(Mutex::new(ArenaReceiver::new(1))),
            },
            1,
            shutdown_rx,
            Arc::clone(&metrics),
        ));
        outbound
            .send(OutboundMessage::Response {
                value: ControlResponse {
                    request_id: 7,
                    result: ControlResult::Accepted,
                },
                request_leases: vec![11],
            })
            .await
            .expect("queue response");
        let mut response_arena = ArenaReceiver::new(1);
        let (response, attachments, release) = yadaw_ipc_transport::decode_response_to_attachments(
            receive_ipc_packet(Arc::clone(&responses)).await,
            &mut response_arena,
        )
        .expect("decode egress response");
        assert_eq!(response.request_id, 7);
        assert_eq!(response.result, ControlResult::Accepted);
        assert!(attachments.is_empty());
        assert!(release.is_empty());
        let release_event = receive_ipc_packet(Arc::clone(&events)).await;
        assert_eq!(
            decode_body::<HostEvent>(&release_event.body).expect("decode release event"),
            HostEvent::ReleaseLeases {
                lease_ids: vec![11],
            }
        );

        outbound
            .send(OutboundMessage::Event(
                encode_event(&HostEvent::GraphPublished { revision: 4 }, Vec::new())
                    .expect("encode host event"),
            ))
            .await
            .expect("queue host event");
        let event = receive_ipc_packet(Arc::clone(&events)).await;
        assert_eq!(
            decode_body::<HostEvent>(&event.body).expect("decode host event"),
            HostEvent::GraphPublished { revision: 4 }
        );

        outbound
            .try_send(OutboundMessage::Response {
                value: ControlResponse {
                    request_id: 8,
                    result: ControlResult::Pong,
                },
                request_leases: Vec::new(),
            })
            .expect("queue response for shutdown drain");
        shutdown.send(true).expect("signal egress shutdown");
        let (drained, _, _) = yadaw_ipc_transport::decode_response_to_attachments(
            receive_ipc_packet(responses).await,
            &mut response_arena,
        )
        .expect("decode drained response");
        assert_eq!(drained.request_id, 8);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("egress task timeout")
            .expect("egress task");
        assert_eq!(metrics.active.load(Ordering::Acquire), 0);
        assert_eq!(metrics.blocking_jobs.load(Ordering::Acquire), 0);
        assert_eq!(metrics.queue_depth.load(Ordering::Acquire), 0);
        assert!(metrics.batches.load(Ordering::Relaxed) >= 3);
    }
}
