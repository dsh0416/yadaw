//! Real-time audio engine, device-stream, MIDI, and recording ownership.

#![deny(clippy::wildcard_imports)]

use thiserror::Error;

/// Errors surfaced by the real-time engine control plane.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum EngineError {
    #[error("invalid engine configuration: {0}")]
    InvalidConfiguration(String),
    #[error("audio backend failure: {0}")]
    Backend(String),
    #[error("engine state failure: {0}")]
    State(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    GenericFailure,
    InvalidArg,
}

impl EngineError {
    #[must_use]
    pub fn new(status: Status, message: impl Into<String>) -> Self {
        match status {
            Status::GenericFailure => Self::State(message.into()),
            Status::InvalidArg => Self::InvalidConfiguration(message.into()),
        }
    }

    #[must_use]
    pub const fn status(&self) -> Status {
        match self {
            Self::InvalidConfiguration(_) => Status::InvalidArg,
            Self::Backend(_) | Self::State(_) => Status::GenericFailure,
        }
    }
}

pub type EngineResult<T> = Result<T, EngineError>;
pub type HostError = EngineError;
pub type HostResult<T> = EngineResult<T>;

pub mod crash_marker;
pub mod device;
pub mod midi_input;
pub mod midi_recording;
pub mod mock;
pub mod recording;
mod runtime;

pub use runtime::*;
