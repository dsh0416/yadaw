use serde::{Deserialize, Serialize};

pub const IPC_PROTOCOL_VERSION: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceKind {
    DesktopSession,
    ApplicationSettings,
    ProjectSession,
    ProjectGraph,
    PluginInstance,
    Asset,
    RecordingSession,
    AudioHost,
    AudioEngine,
    GraphDeployment,
    Transport,
    MidiRuntime,
    ProjectWorker,
    OfflineWorker,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub kind: ResourceKind,
    pub id: String,
    pub epoch: String,
    pub generation: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcMutationMeta {
    pub operation_id: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequestMeta {
    pub protocol_version: u8,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ResourceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutation: Option<RpcMutationMeta>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcErrorCode {
    ValidationFailed,
    ProtocolMismatch,
    RevisionConflict,
    StaleResource,
    ResourceBusy,
    OperationCancelled,
    ResourceUnavailable,
    TransportUnavailable,
    OperationTimeoutUnknown,
    DependencyFailed,
    InvariantViolation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcErrorCategory {
    Validation,
    Conflict,
    StaleResource,
    Busy,
    Cancelled,
    Unavailable,
    TimeoutUnknown,
    DependencyFailed,
    InvariantViolation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcMutationOutcome {
    NotCommitted,
    Unknown,
    Quarantined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcRetry {
    Never,
    Safe,
    AfterReconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcComponent {
    Main,
    Preload,
    ProjectWorker,
    AudioHost,
    OfflineWorker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcStaleReason {
    Missing,
    EpochMismatch,
    GenerationMismatch,
    ParentInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RpcErrorDetails {
    ValidationFailed {
        #[serde(skip_serializing_if = "Option::is_none")]
        field: Option<String>,
    },
    ProtocolMismatch {
        expected_version: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        received_version: Option<u8>,
    },
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    StaleResource {
        reason: RpcStaleReason,
    },
    ResourceBusy {
        #[serde(skip_serializing_if = "Option::is_none")]
        active_operation_id: Option<String>,
    },
    OperationCancelled {
        committed: bool,
    },
    ResourceUnavailable {
        component: RpcComponent,
        dispatched: bool,
    },
    TransportUnavailable {
        component: RpcComponent,
        dispatched: bool,
    },
    OperationTimeoutUnknown {
        dispatched: bool,
    },
    DependencyFailed {
        dependency: ResourceRef,
    },
    InvariantViolation {
        component: RpcComponent,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: RpcErrorCode,
    pub category: RpcErrorCategory,
    pub outcome: RpcMutationOutcome,
    pub retry: RpcRetry,
    pub correlation_id: String,
    pub user_message_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<ResourceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<RpcErrorDetails>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcWarning {
    pub code: String,
    pub user_message_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<ResourceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RpcTrue;

impl Serialize for RpcTrue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for RpcTrue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected true"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RpcFalse;

impl Serialize for RpcFalse {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for RpcFalse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            Err(serde::de::Error::custom("expected false"))
        } else {
            Ok(Self)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcSuccess<T> {
    ok: RpcTrue,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_revision: Option<u64>,
    pub value: T,
    pub warnings: Vec<RpcWarning>,
}

impl<T> RpcSuccess<T> {
    #[must_use]
    pub fn new(
        request_id: String,
        operation_id: Option<String>,
        resource_revision: Option<u64>,
        value: T,
        warnings: Vec<RpcWarning>,
    ) -> Self {
        Self {
            ok: RpcTrue,
            request_id,
            operation_id,
            resource_revision,
            value,
            warnings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcFailure {
    ok: RpcFalse,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub error: RpcError,
}

impl RpcFailure {
    #[must_use]
    pub fn new(request_id: String, operation_id: Option<String>, error: RpcError) -> Self {
        Self {
            ok: RpcFalse,
            request_id,
            operation_id,
            error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcResult<T> {
    Success(RpcSuccess<T>),
    Failure(RpcFailure),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEvent<T> {
    pub protocol_version: u8,
    pub source_epoch: String,
    pub sequence: u64,
    pub resource_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub payload: T,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desktop_ref() -> ResourceRef {
        ResourceRef {
            kind: ResourceKind::DesktopSession,
            id: "desktop".to_owned(),
            epoch: "18446744073709551615".to_owned(),
            generation: 3,
        }
    }

    fn mutation_meta() -> RpcRequestMeta {
        RpcRequestMeta {
            protocol_version: IPC_PROTOCOL_VERSION,
            request_id: "request-7".to_owned(),
            target: Some(desktop_ref()),
            expected_revision: Some(11),
            mutation: Some(RpcMutationMeta {
                operation_id: "operation-9".to_owned(),
                idempotency_key: "open:C:/music/demo.yadaw".to_owned(),
            }),
        }
    }

    #[test]
    fn request_json_matches_the_typescript_snapshot() {
        assert_eq!(
            serde_json::to_string(&mutation_meta()).expect("snapshot must serialize"),
            concat!(
                "{\"protocolVersion\":2,\"requestId\":\"request-7\",\"target\":{\"kind\":",
                "\"desktop-session\",\"id\":\"desktop\",\"epoch\":\"18446744073709551615\",",
                "\"generation\":3},\"expectedRevision\":11,\"mutation\":{\"operationId\":",
                "\"operation-9\",\"idempotencyKey\":\"open:C:/music/demo.yadaw\"}}"
            )
        );
    }

    #[test]
    fn result_json_matches_the_typescript_snapshots() {
        let success = RpcResult::Success(RpcSuccess::new(
            "request-7".to_owned(),
            Some("operation-9".to_owned()),
            None,
            serde_json::json!({ "projectId": "project-1" }),
            vec![],
        ));
        assert_eq!(
            serde_json::to_string(&success).expect("success must serialize"),
            concat!(
                "{\"ok\":true,\"requestId\":\"request-7\",\"operationId\":\"operation-9\",",
                "\"value\":{\"projectId\":\"project-1\"},\"warnings\":[]}"
            )
        );

        let failure: RpcResult<()> = RpcResult::Failure(RpcFailure::new(
            "request-7".to_owned(),
            Some("operation-9".to_owned()),
            RpcError {
                code: RpcErrorCode::RevisionConflict,
                category: RpcErrorCategory::Conflict,
                outcome: RpcMutationOutcome::NotCommitted,
                retry: RpcRetry::AfterReconcile,
                correlation_id: "correlation-2".to_owned(),
                user_message_key: "errors.revisionConflict".to_owned(),
                resource: Some(desktop_ref()),
                details: Some(RpcErrorDetails::RevisionConflict {
                    expected_revision: 11,
                    actual_revision: 12,
                }),
            },
        ));
        assert_eq!(
            serde_json::to_string(&failure).expect("failure must serialize"),
            concat!(
                "{\"ok\":false,\"requestId\":\"request-7\",\"operationId\":\"operation-9\",",
                "\"error\":{\"code\":\"revision-conflict\",\"category\":\"conflict\",\"outcome\":",
                "\"not-committed\",\"retry\":\"after-reconcile\",\"correlationId\":",
                "\"correlation-2\",\"userMessageKey\":\"errors.revisionConflict\",\"resource\":",
                "{\"kind\":\"desktop-session\",\"id\":\"desktop\",\"epoch\":",
                "\"18446744073709551615\",\"generation\":3},\"details\":{\"type\":",
                "\"revision-conflict\",\"expectedRevision\":11,\"actualRevision\":12}}}"
            )
        );
    }

    #[test]
    fn messagepack_round_trips_representative_envelopes() {
        let meta = mutation_meta();
        let bytes = rmp_serde::to_vec_named(&meta).expect("request must encode");
        assert_eq!(
            rmp_serde::from_slice::<RpcRequestMeta>(&bytes).expect("request must decode"),
            meta
        );
    }

    #[test]
    fn result_discriminants_reject_the_wrong_boolean() {
        let invalid_success = r#"{"ok":false,"requestId":"request-1","value":7,"warnings":[]}"#;
        assert!(serde_json::from_str::<RpcSuccess<u32>>(invalid_success).is_err());

        let invalid_failure = r#"{"ok":true,"requestId":"request-1","error":{"code":"resource-busy","category":"busy","outcome":"not-committed","retry":"safe","correlationId":"c","userMessageKey":"errors.busy"}}"#;
        assert!(serde_json::from_str::<RpcFailure>(invalid_failure).is_err());
    }
}
