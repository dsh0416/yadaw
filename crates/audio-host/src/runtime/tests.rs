#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_rejects_a_stale_protocol_or_native_build() {
        assert!(
            validate_native_bootstrap(IPC_PROTOCOL_VERSION, NATIVE_BUILD_FINGERPRINT).is_ok()
        );
        assert!(validate_native_bootstrap(IPC_PROTOCOL_VERSION - 1, NATIVE_BUILD_FINGERPRINT).is_err());
        assert!(validate_native_bootstrap(IPC_PROTOCOL_VERSION, "stale-build").is_err());
    }

    #[test]
    fn editor_owner_window_rejects_null_and_invalid_handles() {
        assert_eq!(parse_editor_owner_window("4660"), Ok(4660));
        assert!(parse_editor_owner_window("0").is_err());
        assert!(parse_editor_owner_window("not-a-handle").is_err());
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
        let input = engine::begin_graph_build(minimal_native_graph(graph_revision))
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
}
