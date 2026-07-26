use std::{error::Error, fmt};

pub mod crash_marker;
pub mod device;
pub mod engine;
pub mod recording;
pub mod vst3;

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
