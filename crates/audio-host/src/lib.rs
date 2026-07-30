use std::{error::Error, fmt};

mod ara;
pub mod crash_marker;
pub mod device;
pub mod editor_platform;
pub mod editor_window;
pub mod engine;
pub mod midi_input;
pub mod midi_journal;
pub mod recording;
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
