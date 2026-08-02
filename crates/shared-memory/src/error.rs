use std::io;

use thiserror::Error;

/// Errors produced while validating or mapping a process-shared region.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum SharedMemoryError {
    /// A descriptor does not satisfy the version, identity, size, or generation
    /// invariants required before it can name a mapping.
    #[error("invalid shared-memory descriptor: {reason}")]
    InvalidDescriptor {
        /// Stable diagnostic reason suitable for logs and tests.
        reason: &'static str,
    },

    /// The operating system could not provide random bytes for a new object ID.
    #[error("could not generate a shared-memory object ID: {0}")]
    Random(getrandom::Error),

    /// All bounded attempts to create a collision-free object name failed.
    #[error("could not reserve a unique shared-memory object name")]
    NameExhausted,

    /// A platform mapping operation failed.
    #[error("shared-memory operation `{operation}` failed")]
    Os {
        /// Stable name of the failed platform operation.
        operation: &'static str,
        /// Original operating-system error.
        #[source]
        source: io::Error,
    },
}

impl SharedMemoryError {
    pub(crate) fn invalid_descriptor(reason: &'static str) -> Self {
        Self::InvalidDescriptor { reason }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn os(operation: &'static str) -> Self {
        Self::Os {
            operation,
            source: io::Error::last_os_error(),
        }
    }

    pub(crate) fn os_error(operation: &'static str, source: io::Error) -> Self {
        Self::Os { operation, source }
    }
}
