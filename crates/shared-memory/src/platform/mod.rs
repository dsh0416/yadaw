#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use posix::Mapping;
#[cfg(target_os = "windows")]
pub(crate) use windows::Mapping;

use std::num::NonZeroUsize;

use sha2::{Digest, Sha256};

fn object_key(object_id: [u8; 16], length: NonZeroUsize, generation: u64) -> [u8; 16] {
    let mut digest = Sha256::new();
    digest.update(b"YADAW process-shared mapping v1\0");
    digest.update(object_id);
    digest.update(
        u64::try_from(length.get())
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    digest.update(generation.to_le_bytes());
    let output = digest.finalize();
    let mut key = [0; 16];
    key.copy_from_slice(&output[..16]);
    key
}
