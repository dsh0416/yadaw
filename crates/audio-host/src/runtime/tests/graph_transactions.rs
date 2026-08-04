use super::*;

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
    assert_eq!(
        snapshot.observed_revision,
        engine.published_graph_generation()
    );
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
fn graph_parameter_handles_refresh_without_retaining_stale_entries() {
    let handles = Mutex::new(GraphParameterHandles::default());
    let graph = mixer_parameter_graph();

    refresh_graph_handles(&handles, &graph);

    let channel_handle = stable_runtime_handle(1, "channel-1");
    let send_handle = stable_runtime_handle(2, "send-1");
    let values = handles.lock().expect("parameter handles");
    assert_eq!(
        values.channels.get(&channel_handle).map(String::as_str),
        Some("channel-1")
    );
    assert_eq!(
        values.sends.get(&send_handle).map(String::as_str),
        Some("send-1")
    );
    assert_ne!(channel_handle, send_handle);
    drop(values);

    refresh_graph_handles(&handles, &empty_live_graph());
    let values = handles.lock().expect("refreshed parameter handles");
    assert!(values.channels.is_empty());
    assert!(values.sends.is_empty());
}

#[test]
fn mixer_parameter_routing_accepts_gain_and_pan_and_rejects_invalid_targets() {
    use heron_dsp_runtime::protocol::ParameterTargetKind;
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
