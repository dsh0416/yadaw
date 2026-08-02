use std::{fmt, num::NonZeroUsize};

use crate::SharedMemoryError;

/// Version of the serializable shared-region descriptor contract.
pub const SHARED_MEMORY_DESCRIPTOR_VERSION: u32 = 1;

/// Opaque identity and mapping metadata sent over the control channel.
///
/// The descriptor contains no process-local pointer or handle. Deserialized
/// values remain untrusted until [`Self::validate`] succeeds.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize, serde::Serialize))]
pub struct SharedMemoryDescriptor {
    descriptor_version: u32,
    object_id: [u8; 16],
    byte_len: u64,
    generation: u64,
}

impl SharedMemoryDescriptor {
    /// Constructs and validates a descriptor received through a non-Serde
    /// boundary.
    ///
    /// # Errors
    ///
    /// Returns [`SharedMemoryError::InvalidDescriptor`] for an unsupported
    /// version, an all-zero object ID, a zero or target-incompatible length, or
    /// generation zero.
    pub fn from_parts(
        descriptor_version: u32,
        object_id: [u8; 16],
        byte_len: u64,
        generation: u64,
    ) -> Result<Self, SharedMemoryError> {
        let descriptor = Self {
            descriptor_version,
            object_id,
            byte_len,
            generation,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    pub(crate) fn new(object_id: [u8; 16], byte_len: NonZeroUsize, generation: u64) -> Self {
        Self {
            descriptor_version: SHARED_MEMORY_DESCRIPTOR_VERSION,
            object_id,
            byte_len: u64::try_from(byte_len.get())
                .expect("supported targets have at most 64-bit usize"),
            generation,
        }
    }

    /// Validates the descriptor and returns a non-zero native mapping length.
    ///
    /// # Errors
    ///
    /// Returns [`SharedMemoryError::InvalidDescriptor`] when any descriptor
    /// invariant is not satisfied on the current target.
    pub fn validate(&self) -> Result<NonZeroUsize, SharedMemoryError> {
        if self.descriptor_version != SHARED_MEMORY_DESCRIPTOR_VERSION {
            return Err(SharedMemoryError::invalid_descriptor(
                "unsupported descriptor version",
            ));
        }
        if self.object_id == [0; 16] {
            return Err(SharedMemoryError::invalid_descriptor(
                "object ID must not be all zero",
            ));
        }
        if self.generation == 0 {
            return Err(SharedMemoryError::invalid_descriptor(
                "generation must not be zero",
            ));
        }
        usize::try_from(self.byte_len)
            .ok()
            .and_then(NonZeroUsize::new)
            .ok_or_else(|| {
                SharedMemoryError::invalid_descriptor(
                    "byte length must be non-zero and fit the target",
                )
            })
    }

    /// Returns the descriptor contract version.
    #[must_use]
    pub const fn descriptor_version(self) -> u32 {
        self.descriptor_version
    }

    /// Returns the opaque mapping identity.
    #[must_use]
    pub const fn object_id(self) -> [u8; 16] {
        self.object_id
    }

    /// Returns the required mapping length.
    #[must_use]
    pub const fn byte_len(self) -> u64 {
        self.byte_len
    }

    /// Returns the transport-owned mapping generation.
    #[must_use]
    pub const fn generation(self) -> u64 {
        self.generation
    }
}

impl fmt::Debug for SharedMemoryDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SharedMemoryDescriptor")
            .field("descriptor_version", &self.descriptor_version)
            .field("object_id", &"<redacted>")
            .field("byte_len", &self.byte_len)
            .field("generation", &self.generation)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_rejects_invalid_boundary_values() {
        let id = [7; 16];
        assert!(SharedMemoryDescriptor::from_parts(2, id, 4096, 1).is_err());
        assert!(SharedMemoryDescriptor::from_parts(1, [0; 16], 4096, 1).is_err());
        assert!(SharedMemoryDescriptor::from_parts(1, id, 0, 1).is_err());
        assert!(SharedMemoryDescriptor::from_parts(1, id, 4096, 0).is_err());
        assert!(SharedMemoryDescriptor::from_parts(1, id, 4096, 1).is_ok());
    }

    #[test]
    fn debug_output_does_not_disclose_the_object_id() {
        let descriptor = SharedMemoryDescriptor::from_parts(1, [0xab; 16], 4096, 3).unwrap();
        let output = format!("{descriptor:?}");
        assert!(output.contains("<redacted>"));
        assert!(!output.contains("171"));
    }
}
