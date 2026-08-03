#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use posix::Mapping;
#[cfg(target_os = "windows")]
pub(crate) use windows::Mapping;

use std::num::NonZeroUsize;

const FNV_OFFSET_BASIS_128: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
const FNV_PRIME_128: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;

/// Compresses descriptor identity into a stable OS-name key.
///
/// This is deliberately a non-cryptographic mixer. The random object ID
/// supplies uniqueness; including length and generation makes an accidentally
/// inconsistent descriptor resolve to a different name even when Darwin's
/// shared-memory metadata rounds lengths to a VM page.
fn object_key(object_id: [u8; 16], length: NonZeroUsize, generation: u64) -> [u8; 16] {
    let mut hash = FNV_OFFSET_BASIS_128;
    update_fnv(&mut hash, b"Heron process-shared mapping v1\0");
    update_fnv(&mut hash, &object_id);
    update_fnv(
        &mut hash,
        &u64::try_from(length.get())
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    update_fnv(&mut hash, &generation.to_le_bytes());
    hash.to_le_bytes()
}

fn update_fnv(hash: &mut u128, bytes: &[u8]) {
    for &byte in bytes {
        *hash ^= u128::from(byte);
        *hash = hash.wrapping_mul(FNV_PRIME_128);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_key_binds_every_descriptor_identity_field() {
        let length = NonZeroUsize::new(4096).unwrap();
        let baseline = object_key([7; 16], length, 3);

        assert_ne!(object_key([8; 16], length, 3), baseline);
        assert_ne!(
            object_key([7; 16], NonZeroUsize::new(4097).unwrap(), 3),
            baseline
        );
        assert_ne!(object_key([7; 16], length, 4), baseline);
    }
}
