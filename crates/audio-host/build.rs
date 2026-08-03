fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let info_plist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../build/macos-agent-info.plist");
    println!("cargo:rerun-if-changed={}", info_plist.display());
    // Set LSUIElement in the Mach-O before AppKit creates NSApplication. Applying
    // Accessory later through winit can otherwise allow a transient Dock icon.
    println!(
        "cargo:rustc-link-arg-bin=heron-audio-host=-Wl,-sectcreate,__TEXT,__info_plist,{}",
        info_plist.display()
    );
}
