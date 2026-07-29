use std::{
    env,
    path::{Path, PathBuf},
};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory is set"));
    let sdk_dir = manifest_dir.join("../../third_party/vst3sdk");
    let ara_api_dir = manifest_dir.join("../../third_party/ARA_SDK/ARA_API");
    let wrapper = manifest_dir.join("wrapper.hpp");
    let ara_bridge = manifest_dir.join("ara_bridge.cpp");
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("output directory is set")).join("bindings.rs");

    if !sdk_dir.join("pluginterfaces/base/funknown.h").is_file() {
        panic!(
            "VST3 SDK is missing at {}; initialize the recursive third_party/vst3sdk submodule",
            sdk_dir.display()
        );
    }
    if !ara_api_dir.join("ARAInterface.h").is_file() {
        panic!(
            "ARA SDK is missing at {}; initialize the recursive third_party/ARA_SDK submodule",
            ara_api_dir.display()
        );
    }

    println!("cargo:rerun-if-changed={}", wrapper.display());
    println!("cargo:rerun-if-changed={}", ara_bridge.display());
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("ara_bridge.hpp").display()
    );
    emit_sdk_reruns(&sdk_dir);
    for path in ["ARAInterface.h", "ARAVST3.h"] {
        println!(
            "cargo:rerun-if-changed={}",
            ara_api_dir.join(path).display()
        );
    }

    let target = env::var("TARGET").expect("Cargo target is set");
    let mut builder = bindgen::Builder::default()
        .header(wrapper.to_string_lossy())
        .clang_arg("-x")
        .clang_arg("c++")
        .clang_arg("-std=c++17")
        .clang_arg(format!("-I{}", sdk_dir.display()))
        .clang_arg(format!("-I{}", ara_api_dir.display()))
        .clang_arg(format!("--target={target}"))
        .enable_cxx_namespaces()
        .vtable_generation(true)
        .layout_tests(true)
        .derive_debug(false)
        .derive_default(false)
        .generate_comments(false)
        .allowlist_type("Steinberg::FUnknown")
        .allowlist_type("Steinberg::IBStream")
        .allowlist_type("Steinberg::IPluginBase")
        .allowlist_type("Steinberg::IPluginFactory.*")
        .allowlist_type("Steinberg::PFactoryInfo")
        .allowlist_type("Steinberg::PClassInfo.*")
        .allowlist_type("Steinberg::ViewRect")
        .allowlist_type("Steinberg::IPlugView.*")
        .allowlist_type("Steinberg::IPlugFrame")
        .allowlist_type("Steinberg::Vst::.*")
        .allowlist_type("ARA::.*")
        .allowlist_var("Steinberg::.*")
        .allowlist_var("ARA::.*")
        .allowlist_type("YadawAraFactoryInfo")
        .allowlist_function("yadaw_ara_.*")
        .opaque_type("std::.*")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()));

    if target.contains("windows-msvc") {
        builder = builder.clang_arg("-fms-extensions");
    }

    let bindings = builder
        .generate()
        .expect("VST3 SDK bindings should be generated");
    bindings
        .write_to_file(output)
        .expect("VST3 SDK bindings should be written");

    let mut bridge = cc::Build::new();
    bridge
        .cpp(true)
        .std("c++17")
        .file(&ara_bridge)
        .include(&manifest_dir)
        .include(&sdk_dir)
        .include(&ara_api_dir)
        .warnings(false);
    bridge.compile("yadaw_ara_bridge");
}

fn emit_sdk_reruns(sdk_dir: &Path) {
    for path in [
        "pluginterfaces/base/funknown.h",
        "pluginterfaces/base/ibstream.h",
        "pluginterfaces/base/ipluginbase.h",
        "pluginterfaces/gui/iplugview.h",
        "pluginterfaces/gui/iplugviewcontentscalesupport.h",
        "pluginterfaces/vst/ivstaudioprocessor.h",
        "pluginterfaces/vst/ivstcomponent.h",
        "pluginterfaces/vst/ivsteditcontroller.h",
        "pluginterfaces/vst/ivstevents.h",
        "pluginterfaces/vst/ivsthostapplication.h",
        "pluginterfaces/vst/ivstmessage.h",
        "pluginterfaces/vst/ivstparameterchanges.h",
    ] {
        println!("cargo:rerun-if-changed={}", sdk_dir.join(path).display());
    }
}
