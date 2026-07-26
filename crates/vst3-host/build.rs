fn main() {
    println!("cargo:rerun-if-changed=src/attach_guard.cpp");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
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
            .compile("yadaw_vst3_attach_guard");
    }
}
