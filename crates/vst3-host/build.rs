fn main() {
    println!("cargo:rerun-if-changed=src/attach_guard.cpp");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    if target_os.as_deref() == Ok("windows") {
        let sdk = std::env::var_os("VST3_SDK_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../third_party/vst3sdk")
            });
        cc::Build::new()
            .cpp(true)
            .include(sdk)
            .file("src/attach_guard.cpp")
            .flag_if_supported("/EHsc")
            .warnings(true)
            .compile("heron_vst3_attach_guard");
    }

    if target_os.as_deref() == Ok("macos") {
        let info_plist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../build/macos-agent-info.plist");
        println!("cargo:rerun-if-changed={}", info_plist.display());
        // A scanned plug-in may initialize AppKit, so the probe must be an
        // agent before any third-party bundle entry point runs.
        println!(
            "cargo:rustc-link-arg-bin=heron-vst3-probe=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            info_plist.display()
        );
    }
}
