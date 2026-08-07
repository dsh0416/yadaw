use super::{
    ControlResult, GraphCandidateSnapshot, GraphDeploymentSnapshot, GraphDeploymentStatus,
    GraphOperationOutcome, GraphOperationSnapshot, GraphTransactionRequest, GraphTransactionValue,
    IPC_PROTOCOL_VERSION, LiveMixerGraph, ResourceKind, ResourceRef, RpcError, RpcErrorCategory,
    RpcErrorCode, RpcErrorDetails, RpcFailure, RpcMutationOutcome, RpcRequestMeta, RpcResult,
    RpcRetry, RpcSuccess, engine,
};

pub(super) struct PreparedGraphCandidate {
    pub(super) operation_id: String,
    pub(super) project_graph: ResourceRef,
    pub(super) base_revision: u64,
    pub(super) graph_revision: u64,
    pub(super) graph: LiveMixerGraph,
    pub(super) built: engine::CompiledGraphBuild,
}

pub(super) struct GraphTransactionState {
    pub(super) helper_epoch: String,
    pub(super) engine: Option<ResourceRef>,
    pub(super) committed_project_graph: Option<ResourceRef>,
    pub(super) committed_revision: u64,
    pub(super) candidate: Option<PreparedGraphCandidate>,
    pub(super) last_operation: Option<GraphOperationSnapshot>,
    pub(super) degraded: bool,
}

impl GraphTransactionState {
    pub(super) fn new(session_epoch: u64) -> Self {
        Self {
            helper_epoch: session_epoch.to_string(),
            engine: None,
            committed_project_graph: None,
            committed_revision: 0,
            candidate: None,
            last_operation: None,
            degraded: false,
        }
    }

    pub(super) fn snapshot_with_engine(
        &self,
        audio_engine: &engine::AudioEngine,
    ) -> GraphDeploymentSnapshot {
        self.snapshot_at(audio_engine.published_graph_generation())
    }

    pub(super) fn snapshot_at(&self, observed_revision: u64) -> GraphDeploymentSnapshot {
        let status = if self.degraded {
            GraphDeploymentStatus::Degraded
        } else if self.candidate.is_some() {
            GraphDeploymentStatus::Prepared
        } else if self.committed_revision == 0 {
            GraphDeploymentStatus::Empty
        } else {
            GraphDeploymentStatus::Active
        };
        GraphDeploymentSnapshot {
            helper_epoch: self.helper_epoch.clone(),
            engine: self.engine.clone().unwrap_or(ResourceRef {
                kind: ResourceKind::AudioEngine,
                id: "unbound".to_owned(),
                epoch: self.helper_epoch.clone(),
                generation: 0,
            }),
            status,
            committed_project_graph: self.committed_project_graph.clone(),
            committed_revision: self.committed_revision,
            observed_revision,
            candidate: self
                .candidate
                .as_ref()
                .map(|candidate| GraphCandidateSnapshot {
                    operation_id: candidate.operation_id.clone(),
                    project_graph: candidate.project_graph.clone(),
                    base_revision: candidate.base_revision,
                    graph_revision: candidate.graph_revision,
                }),
            last_operation: self.last_operation.clone(),
        }
    }

    pub(super) fn observe_engine(&mut self, engine: ResourceRef) {
        self.engine = Some(engine);
    }

    pub(super) fn observe_legacy_commit(&mut self, revision: u64) {
        self.committed_project_graph = None;
        self.committed_revision = revision;
        self.last_operation = None;
        self.degraded = false;
    }

    pub(super) fn prepare(&mut self, candidate: PreparedGraphCandidate) {
        self.candidate = Some(candidate);
    }

    pub(super) fn take_candidate(&mut self, operation_id: &str) -> Option<PreparedGraphCandidate> {
        if self
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.operation_id == operation_id)
        {
            self.candidate.take()
        } else {
            None
        }
    }

    pub(super) fn restore_candidate(&mut self, candidate: PreparedGraphCandidate) {
        self.candidate = Some(candidate);
    }

    pub(super) fn abort(&mut self, operation_id: &str) -> bool {
        let candidate = self.take_candidate(operation_id);
        if let Some(candidate) = candidate {
            self.last_operation = Some(GraphOperationSnapshot {
                operation_id: operation_id.to_owned(),
                outcome: GraphOperationOutcome::NotCommitted,
                graph_revision: candidate.graph_revision,
            });
            true
        } else {
            false
        }
    }

    pub(super) fn commit(
        &mut self,
        operation_id: String,
        project_graph: ResourceRef,
        graph_revision: u64,
    ) {
        self.committed_project_graph = Some(project_graph);
        self.committed_revision = graph_revision;
        self.last_operation = Some(GraphOperationSnapshot {
            operation_id,
            outcome: GraphOperationOutcome::Committed,
            graph_revision,
        });
        self.degraded = false;
    }

    pub(super) fn finish_not_committed(&mut self, operation_id: String, graph_revision: u64) {
        self.last_operation = Some(GraphOperationSnapshot {
            operation_id,
            outcome: GraphOperationOutcome::NotCommitted,
            graph_revision,
        });
    }
}

#[derive(Debug)]
pub(super) struct ValidatedGraphMeta {
    pub(super) engine: ResourceRef,
    pub(super) operation_id: Option<String>,
}

pub(super) fn graph_correlation(meta: &RpcRequestMeta, suffix: &str) -> String {
    format!("graph-{}-{suffix}", meta.request_id)
}

fn graph_protocol_error(meta: &RpcRequestMeta) -> RpcError {
    RpcError {
        code: RpcErrorCode::ProtocolMismatch,
        category: RpcErrorCategory::Validation,
        outcome: RpcMutationOutcome::NotCommitted,
        retry: RpcRetry::Never,
        correlation_id: graph_correlation(meta, "protocol"),
        user_message_key: "errors.protocolMismatch".to_owned(),
        resource: meta.target.clone(),
        details: Some(RpcErrorDetails::ProtocolMismatch {
            expected_version: IPC_PROTOCOL_VERSION,
            received_version: Some(meta.protocol_version),
        }),
    }
}

pub(super) fn graph_validation_error(meta: &RpcRequestMeta, field: &str) -> RpcError {
    RpcError {
        code: RpcErrorCode::ValidationFailed,
        category: RpcErrorCategory::Validation,
        outcome: RpcMutationOutcome::NotCommitted,
        retry: RpcRetry::Never,
        correlation_id: graph_correlation(meta, "validation"),
        user_message_key: "errors.invalidGraphTransaction".to_owned(),
        resource: meta.target.clone(),
        details: Some(RpcErrorDetails::ValidationFailed {
            field: Some(field.to_owned()),
        }),
    }
}

pub(super) fn graph_stale_error(
    meta: &RpcRequestMeta,
    resource: ResourceRef,
    reason: heron_dsp_runtime::protocol::RpcStaleReason,
) -> RpcError {
    RpcError {
        code: RpcErrorCode::StaleResource,
        category: RpcErrorCategory::StaleResource,
        outcome: RpcMutationOutcome::NotCommitted,
        retry: RpcRetry::AfterReconcile,
        correlation_id: graph_correlation(meta, "stale"),
        user_message_key: "errors.staleResource".to_owned(),
        resource: Some(resource),
        details: Some(RpcErrorDetails::StaleResource { reason }),
    }
}

pub(super) fn graph_conflict_error(meta: &RpcRequestMeta, expected: u64, actual: u64) -> RpcError {
    RpcError {
        code: RpcErrorCode::RevisionConflict,
        category: RpcErrorCategory::Conflict,
        outcome: RpcMutationOutcome::NotCommitted,
        retry: RpcRetry::AfterReconcile,
        correlation_id: graph_correlation(meta, "revision"),
        user_message_key: "errors.revisionConflict".to_owned(),
        resource: meta.target.clone(),
        details: Some(RpcErrorDetails::RevisionConflict {
            expected_revision: expected,
            actual_revision: actual,
        }),
    }
}

pub(super) fn graph_busy_error(
    meta: &RpcRequestMeta,
    active_operation_id: Option<String>,
) -> RpcError {
    RpcError {
        code: RpcErrorCode::ResourceBusy,
        category: RpcErrorCategory::Busy,
        outcome: RpcMutationOutcome::NotCommitted,
        retry: RpcRetry::Safe,
        correlation_id: graph_correlation(meta, "busy"),
        user_message_key: "errors.graphBusy".to_owned(),
        resource: meta.target.clone(),
        details: Some(RpcErrorDetails::ResourceBusy {
            active_operation_id,
        }),
    }
}

pub(super) fn graph_dependency_error(meta: &RpcRequestMeta, dependency: ResourceRef) -> RpcError {
    RpcError {
        code: RpcErrorCode::DependencyFailed,
        category: RpcErrorCategory::DependencyFailed,
        outcome: RpcMutationOutcome::NotCommitted,
        retry: RpcRetry::AfterReconcile,
        correlation_id: graph_correlation(meta, "dependency"),
        user_message_key: "errors.graphDependencyFailed".to_owned(),
        resource: meta.target.clone(),
        details: Some(RpcErrorDetails::DependencyFailed { dependency }),
    }
}

pub(super) fn graph_timeout_error(meta: &RpcRequestMeta) -> RpcError {
    RpcError {
        code: RpcErrorCode::OperationTimeoutUnknown,
        category: RpcErrorCategory::TimeoutUnknown,
        outcome: RpcMutationOutcome::Unknown,
        retry: RpcRetry::AfterReconcile,
        correlation_id: graph_correlation(meta, "activation-timeout"),
        user_message_key: "errors.operationOutcomeUnknown".to_owned(),
        resource: meta.target.clone(),
        details: Some(RpcErrorDetails::OperationTimeoutUnknown { dispatched: true }),
    }
}

pub(super) fn validate_graph_meta(
    meta: &RpcRequestMeta,
    helper_epoch: &str,
    requires_mutation: bool,
) -> Result<ValidatedGraphMeta, Box<RpcError>> {
    if meta.protocol_version != IPC_PROTOCOL_VERSION {
        return Err(Box::new(graph_protocol_error(meta)));
    }
    let Some(engine) = meta.target.clone() else {
        return Err(Box::new(graph_validation_error(meta, "target")));
    };
    if engine.kind != ResourceKind::AudioEngine
        || engine.epoch != helper_epoch
        || engine.generation == 0
    {
        return Err(Box::new(graph_stale_error(
            meta,
            engine,
            heron_dsp_runtime::protocol::RpcStaleReason::EpochMismatch,
        )));
    }
    let operation_id = meta
        .mutation
        .as_ref()
        .map(|mutation| mutation.operation_id.clone());
    if requires_mutation && operation_id.is_none() {
        return Err(Box::new(graph_validation_error(meta, "mutation")));
    }
    Ok(ValidatedGraphMeta {
        engine,
        operation_id,
    })
}

pub(super) fn validate_graph_request(
    meta: &RpcRequestMeta,
    request: &GraphTransactionRequest,
    helper_epoch: &str,
    committed_revision: u64,
) -> Result<ValidatedGraphMeta, Box<RpcError>> {
    let validated = validate_graph_meta(meta, helper_epoch, true)?;
    if request.helper_epoch != helper_epoch {
        return Err(Box::new(graph_stale_error(
            meta,
            validated.engine.clone(),
            heron_dsp_runtime::protocol::RpcStaleReason::EpochMismatch,
        )));
    }
    if request.project_graph.kind != ResourceKind::ProjectGraph {
        return Err(Box::new(graph_validation_error(meta, "projectGraph")));
    }
    if request.base_revision != committed_revision
        || meta.expected_revision != Some(request.base_revision)
    {
        return Err(Box::new(graph_conflict_error(
            meta,
            request.base_revision,
            committed_revision,
        )));
    }
    Ok(validated)
}

pub(super) fn graph_success(
    meta: &RpcRequestMeta,
    resource_revision: u64,
    value: GraphTransactionValue,
) -> ControlResult {
    ControlResult::GraphTransaction {
        result: Box::new(RpcResult::Success(RpcSuccess::new(
            meta.request_id.clone(),
            meta.mutation
                .as_ref()
                .map(|mutation| mutation.operation_id.clone()),
            Some(resource_revision),
            value,
            vec![],
        ))),
    }
}

pub(super) fn graph_failure(
    meta: &RpcRequestMeta,
    error: impl Into<Box<RpcError>>,
) -> ControlResult {
    ControlResult::GraphTransaction {
        result: Box::new(RpcResult::Failure(RpcFailure::new(
            meta.request_id.clone(),
            meta.mutation
                .as_ref()
                .map(|mutation| mutation.operation_id.clone()),
            *error.into(),
        ))),
    }
}

pub(super) async fn wait_for_graph_publication(
    audio_engine: &engine::AudioEngine,
    revision: u64,
) -> bool {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if audio_engine.published_graph_generation() >= revision {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use heron_dsp_runtime::protocol::{RpcMutationMeta, RpcStaleReason};

    fn resource(kind: ResourceKind, epoch: &str, generation: u32) -> ResourceRef {
        ResourceRef {
            kind,
            id: format!("{kind:?}"),
            epoch: epoch.to_owned(),
            generation,
        }
    }

    fn meta() -> RpcRequestMeta {
        RpcRequestMeta {
            protocol_version: IPC_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            target: Some(resource(ResourceKind::AudioEngine, "42", 1)),
            expected_revision: Some(7),
            mutation: Some(RpcMutationMeta {
                operation_id: "operation-1".to_owned(),
                idempotency_key: "graph:8".to_owned(),
            }),
        }
    }

    fn request() -> GraphTransactionRequest {
        GraphTransactionRequest {
            helper_epoch: "42".to_owned(),
            project_graph: resource(ResourceKind::ProjectGraph, "project", 1),
            base_revision: 7,
        }
    }

    #[test]
    fn transaction_state_reports_empty_active_and_degraded_snapshots() {
        let mut state = GraphTransactionState::new(42);
        let empty = state.snapshot_at(0);
        assert_eq!(empty.status, GraphDeploymentStatus::Empty);
        assert_eq!(empty.engine.id, "unbound");

        let engine = resource(ResourceKind::AudioEngine, "42", 1);
        let project = resource(ResourceKind::ProjectGraph, "project", 1);
        state.observe_engine(engine.clone());
        state.commit("operation-1".to_owned(), project.clone(), 8);
        let active = state.snapshot_at(8);
        assert_eq!(active.status, GraphDeploymentStatus::Active);
        assert_eq!(active.engine, engine);
        assert_eq!(active.committed_project_graph, Some(project));
        assert_eq!(
            active.last_operation.unwrap().outcome,
            GraphOperationOutcome::Committed
        );

        state.finish_not_committed("operation-2".to_owned(), 9);
        assert_eq!(
            state.snapshot_at(8).last_operation.unwrap().outcome,
            GraphOperationOutcome::NotCommitted
        );
        assert!(!state.abort("missing"));
        state.degraded = true;
        assert_eq!(state.snapshot_at(7).status, GraphDeploymentStatus::Degraded);

        state.observe_legacy_commit(10);
        let legacy = state.snapshot_at(10);
        assert_eq!(legacy.status, GraphDeploymentStatus::Active);
        assert_eq!(legacy.committed_project_graph, None);
        assert_eq!(legacy.last_operation, None);
    }

    #[test]
    fn graph_error_builders_publish_stable_protocol_semantics() {
        let meta = meta();
        let dependency = resource(ResourceKind::PluginInstance, "project", 2);
        let cases = [
            graph_validation_error(&meta, "target"),
            graph_stale_error(&meta, dependency.clone(), RpcStaleReason::EpochMismatch),
            graph_conflict_error(&meta, 7, 8),
            graph_busy_error(&meta, Some("other-operation".to_owned())),
            graph_dependency_error(&meta, dependency),
            graph_timeout_error(&meta),
        ];

        assert_eq!(graph_correlation(&meta, "busy"), "graph-request-1-busy");
        assert_eq!(cases[0].code, RpcErrorCode::ValidationFailed);
        assert_eq!(cases[1].code, RpcErrorCode::StaleResource);
        assert_eq!(cases[2].category, RpcErrorCategory::Conflict);
        assert_eq!(cases[3].retry, RpcRetry::Safe);
        assert_eq!(cases[4].category, RpcErrorCategory::DependencyFailed);
        assert_eq!(cases[5].outcome, RpcMutationOutcome::Unknown);
        assert!(cases.iter().all(|error| error.details.is_some()));
    }

    #[test]
    fn graph_meta_validation_rejects_each_invalid_boundary() {
        let valid = meta();
        let validated = validate_graph_meta(&valid, "42", true).expect("meta should validate");
        assert_eq!(validated.operation_id.as_deref(), Some("operation-1"));

        let mut invalid = valid.clone();
        invalid.protocol_version = IPC_PROTOCOL_VERSION + 1;
        assert_eq!(
            validate_graph_meta(&invalid, "42", true).unwrap_err().code,
            RpcErrorCode::ProtocolMismatch
        );

        invalid = valid.clone();
        invalid.target = None;
        assert_eq!(
            validate_graph_meta(&invalid, "42", true).unwrap_err().code,
            RpcErrorCode::ValidationFailed
        );

        for target in [
            resource(ResourceKind::ProjectGraph, "42", 1),
            resource(ResourceKind::AudioEngine, "other", 1),
            resource(ResourceKind::AudioEngine, "42", 0),
        ] {
            invalid = valid.clone();
            invalid.target = Some(target);
            assert_eq!(
                validate_graph_meta(&invalid, "42", true).unwrap_err().code,
                RpcErrorCode::StaleResource
            );
        }

        invalid = valid;
        invalid.mutation = None;
        assert_eq!(
            validate_graph_meta(&invalid, "42", true).unwrap_err().code,
            RpcErrorCode::ValidationFailed
        );
        assert!(validate_graph_meta(&invalid, "42", false).is_ok());
    }

    #[test]
    fn graph_request_validation_checks_epoch_kind_and_revision() {
        let meta = meta();
        assert!(validate_graph_request(&meta, &request(), "42", 7).is_ok());

        let mut invalid = request();
        invalid.helper_epoch = "other".to_owned();
        assert_eq!(
            validate_graph_request(&meta, &invalid, "42", 7)
                .unwrap_err()
                .code,
            RpcErrorCode::StaleResource
        );

        invalid = request();
        invalid.project_graph.kind = ResourceKind::PluginInstance;
        assert_eq!(
            validate_graph_request(&meta, &invalid, "42", 7)
                .unwrap_err()
                .code,
            RpcErrorCode::ValidationFailed
        );

        invalid = request();
        invalid.base_revision = 6;
        assert_eq!(
            validate_graph_request(&meta, &invalid, "42", 7)
                .unwrap_err()
                .code,
            RpcErrorCode::RevisionConflict
        );

        let mut mismatched_meta = meta;
        mismatched_meta.expected_revision = Some(6);
        assert_eq!(
            validate_graph_request(&mismatched_meta, &request(), "42", 7)
                .unwrap_err()
                .code,
            RpcErrorCode::RevisionConflict
        );
    }

    #[test]
    fn graph_results_keep_request_and_operation_identity() {
        let meta = meta();
        let snapshot = GraphTransactionState::new(42).snapshot_at(0);
        let success = graph_success(
            &meta,
            0,
            GraphTransactionValue::Snapshot {
                snapshot: snapshot.clone(),
            },
        );
        let failure = graph_failure(&meta, graph_validation_error(&meta, "target"));

        let ControlResult::GraphTransaction { result } = success else {
            panic!("expected graph success result");
        };
        let RpcResult::Success(result) = *result else {
            panic!("expected success envelope");
        };
        assert_eq!(result.request_id, "request-1");
        assert_eq!(result.operation_id.as_deref(), Some("operation-1"));

        let ControlResult::GraphTransaction { result } = failure else {
            panic!("expected graph failure result");
        };
        let RpcResult::Failure(result) = *result else {
            panic!("expected failure envelope");
        };
        assert_eq!(result.error.code, RpcErrorCode::ValidationFailed);
    }
}
