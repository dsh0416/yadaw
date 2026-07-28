use std::{env, fs, path::PathBuf};

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn hash_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn main() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must provide CARGO_MANIFEST_DIR"),
    );
    let workspace = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .expect("dsp-runtime must remain under workspace/crates");
    let inputs = [
        "Cargo.lock",
        "Cargo.toml",
        "crates/dsp-runtime/Cargo.toml",
        "crates/dsp-runtime/src/protocol/mod.rs",
        "crates/dsp-runtime/src/protocol/audio.rs",
        "crates/dsp-runtime/src/protocol/graph.rs",
        "crates/dsp-runtime/src/protocol/plugin.rs",
        "crates/dsp-runtime/src/protocol/recording.rs",
        "crates/dsp-runtime/src/protocol/transport.rs",
        "crates/dsp-runtime/src/protocol/wire.rs",
        "crates/ipc-transport/Cargo.toml",
        "crates/ipc-transport/src/lib.rs",
        "crates/audio-host-client/Cargo.toml",
        "crates/audio-host-client/src/lib.rs",
        "crates/audio-host/Cargo.toml",
        "crates/audio-host/src/main.rs",
    ];
    let mut hash = FNV_OFFSET_BASIS;
    for relative in inputs {
        let path = workspace.join(relative);
        println!("cargo:rerun-if-changed={}", path.display());
        hash = hash_bytes(hash, relative.as_bytes());
        hash = hash_bytes(
            hash,
            &fs::read(&path).unwrap_or_else(|error| {
                panic!("could not fingerprint {}: {error}", path.display())
            }),
        );
    }
    println!("cargo:rustc-env=YADAW_NATIVE_BUILD_FINGERPRINT={hash:016x}");
}
