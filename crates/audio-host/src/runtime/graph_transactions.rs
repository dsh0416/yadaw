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

    #[cfg(test)]
    pub(super) fn snapshot(&self) -> GraphDeploymentSnapshot {
        self.snapshot_at(self.committed_revision)
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
