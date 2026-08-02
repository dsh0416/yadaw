//! Narrow cross-platform ownership wrapper for fixed-size process-shared
//! mappings.
//!
//! This crate owns mapping identity, OS resources, and cleanup. It deliberately
//! exposes no safe byte slice because another process may mutate the mapping at
//! any time. Typed layouts and atomic protocols belong to `yadaw-ipc-transport`.

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("yadaw-shared-memory supports only Linux, macOS, and Windows");

mod descriptor;
mod error;
mod platform;

use std::{fmt, num::NonZeroUsize, ptr::NonNull, sync::Arc};

pub use descriptor::{SHARED_MEMORY_DESCRIPTOR_VERSION, SharedMemoryDescriptor};
pub use error::SharedMemoryError;
use platform::Mapping;

const CREATE_ATTEMPTS: usize = 16;

/// One owned view of a fixed-size process-shared mapping.
///
/// Clones share this process's mapped view and resource lifetime. A peer process
/// opens the same backing object with [`Self::open`] and a serialized
/// [`SharedMemoryDescriptor`].
#[derive(Clone)]
pub struct SharedMemory {
    mapping: Arc<Mapping>,
    descriptor: SharedMemoryDescriptor,
}

impl SharedMemory {
    /// Creates and zero-initializes a fixed-size process-shared mapping.
    ///
    /// `generation` is transport metadata and must be non-zero. It is carried
    /// in the descriptor but interpreted by the typed page protocol.
    ///
    /// # Errors
    ///
    /// Returns an error when the generation is zero, secure object-ID
    /// generation fails, no unique OS object name can be reserved, or the
    /// platform cannot size or map the object.
    pub fn create(byte_len: NonZeroUsize, generation: u64) -> Result<Self, SharedMemoryError> {
        if generation == 0 {
            return Err(SharedMemoryError::invalid_descriptor(
                "generation must not be zero",
            ));
        }
        for _ in 0..CREATE_ATTEMPTS {
            let object_id = random_object_id()?;
            let descriptor = SharedMemoryDescriptor::new(object_id, byte_len, generation);
            match Mapping::create(object_id, byte_len, generation) {
                Ok(mapping) => {
                    return Ok(Self {
                        mapping: Arc::new(mapping),
                        descriptor,
                    });
                }
                Err(SharedMemoryError::NameExhausted) => {}
                Err(error) => return Err(error),
            }
        }
        Err(SharedMemoryError::NameExhausted)
    }

    /// Opens the backing object named by a validated descriptor.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid descriptor, a missing or inaccessible
    /// object, a size mismatch, or a platform mapping failure.
    pub fn open(descriptor: SharedMemoryDescriptor) -> Result<Self, SharedMemoryError> {
        let byte_len = descriptor.validate()?;
        let mapping = Mapping::open(descriptor.object_id(), byte_len, descriptor.generation())?;
        Ok(Self {
            mapping: Arc::new(mapping),
            descriptor,
        })
    }

    /// Returns the serializable identity and mapping metadata.
    #[must_use]
    pub const fn descriptor(&self) -> SharedMemoryDescriptor {
        self.descriptor
    }

    /// Returns the mapped byte length.
    #[must_use]
    pub fn len(&self) -> NonZeroUsize {
        self.descriptor
            .validate()
            .expect("a live mapping always owns a validated descriptor")
    }

    /// Removes the discoverable object name after the peer has opened and
    /// verified its view.
    ///
    /// Existing mappings remain valid. The operation is idempotent, and is a
    /// no-op on Windows where the object name disappears with the last handle.
    ///
    /// # Errors
    ///
    /// Returns an error when POSIX unlink fails for a reason other than an
    /// already-removed name.
    pub fn unlink(&self) -> Result<(), SharedMemoryError> {
        self.mapping.unlink()
    }

    /// Returns the base address of this process's mapped view.
    ///
    /// # Safety
    ///
    /// The caller must keep a `SharedMemory` clone alive for every derived
    /// pointer or reference. It must validate bounds and alignment, initialize
    /// each typed location before concurrent access, use exactly one compatible
    /// type per offset in every process, and synchronize all mutation with a
    /// process-shared atomic protocol. It must never create an aliased mutable
    /// reference or perform non-atomic access concurrent with atomic access.
    #[must_use]
    pub unsafe fn address(&self) -> NonNull<u8> {
        self.mapping.address()
    }
}

impl fmt::Debug for SharedMemory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SharedMemory")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

fn random_object_id() -> Result<[u8; 16], SharedMemoryError> {
    let mut object_id = [0; 16];
    getrandom::fill(&mut object_id).map_err(SharedMemoryError::Random)?;
    if object_id == [0; 16] {
        // This is cryptographically negligible but keeps the descriptor
        // invariant unconditional rather than probabilistic.
        object_id[15] = 1;
    }
    Ok(object_id)
}
