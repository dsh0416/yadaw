#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_rejects_a_stale_native_build() {
        assert!(validate_native_build_fingerprint(NATIVE_BUILD_FINGERPRINT).is_ok());
        assert!(validate_native_build_fingerprint("stale-build").is_err());
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
}
