#![deny(clippy::wildcard_imports)]

use heron_dsp_runtime::protocol::{
    ControlResult, RpcComponent, RpcError, RpcErrorCategory, RpcErrorCode, RpcErrorDetails,
    RpcMutationOutcome, RpcRetry,
};
use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
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

fn plugin_capability_error_result(
    diagnostic: impl fmt::Display,
    field: &'static str,
) -> ControlResult {
    let correlation_id = format!(
        "audio-host-{}",
        ERROR_CORRELATION.fetch_add(1, Ordering::Relaxed)
    );
    eprintln!("audio-host [{correlation_id}]: {diagnostic}");
    ControlResult::Error {
        error: RpcError {
            code: RpcErrorCode::ValidationFailed,
            category: RpcErrorCategory::Validation,
            outcome: RpcMutationOutcome::NotCommitted,
            retry: RpcRetry::Never,
            correlation_id,
            user_message_key: "errors.pluginUnavailable".to_owned(),
            resource: None,
            details: Some(RpcErrorDetails::ValidationFailed {
                field: Some(field.to_owned()),
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
mod clap;
pub use heron_audio_engine::{HostError, HostResult, Status};

pub mod device {
    pub use heron_audio_engine::device::*;
}
pub mod editor_platform;
pub mod engine {
    pub use heron_audio_engine::*;
}
pub mod midi_input {
    pub use heron_audio_engine::midi_input::*;
}
pub mod midi_recording {
    pub use heron_audio_engine::midi_recording::*;
}
pub mod mock {
    pub use heron_audio_engine::mock::*;
}
pub mod recording {
    pub use heron_audio_engine::recording::*;
}
pub mod runtime;
pub mod vst3;
mod vst3_presentation_latency;
pub mod workers;
