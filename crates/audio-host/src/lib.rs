use std::{
    error::Error,
    fmt,
    sync::atomic::{AtomicU64, Ordering},
};
use yadaw_dsp_runtime::protocol::{
    ControlResult, RpcComponent, RpcError, RpcErrorCategory, RpcErrorCode, RpcErrorDetails,
    RpcMutationOutcome, RpcRetry,
};

static ERROR_CORRELATION: AtomicU64 = AtomicU64::new(1);

fn control_error_result(diagnostic: impl fmt::Display) -> ControlResult {
    let correlation_id = format!(
        "audio-host-{}",
        ERROR_CORRELATION.fetch_add(1, Ordering::Relaxed)
    );
    eprintln!("audio-host [{correlation_id}]: {diagnostic}");
    ControlResult::Error {
        error: RpcError {
            code: RpcErrorCode::InvariantViolation,
            category: RpcErrorCategory::InvariantViolation,
            outcome: RpcMutationOutcome::Quarantined,
            retry: RpcRetry::AfterReconcile,
            correlation_id,
            user_message_key: "errors.audioEngineUnavailable".to_owned(),
            resource: None,
            details: Some(RpcErrorDetails::InvariantViolation {
                component: RpcComponent::AudioHost,
            }),
        },
    }
}

macro_rules! control_error {
    (message: $message:expr $(,)?) => {{
        let diagnostic: String = $message;
        $crate::control_error_result(diagnostic)
    }};
    ($message:ident $(,)?) => {
        $crate::control_error_result($message)
    };
}

mod ara;
pub mod crash_marker;
pub mod device;
pub mod editor_platform;
pub mod editor_window;
pub mod engine;
pub mod midi_input;
pub mod midi_journal;
pub mod mock;
pub mod recording;
pub mod runtime;
pub mod vst3;
pub mod workers;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    GenericFailure,
    InvalidArg,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    status: Status,
    message: String,
}

impl HostError {
    pub fn new(status: Status, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn status(&self) -> Status {
        self.status
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for HostError {}

pub type HostResult<T> = Result<T, HostError>;
