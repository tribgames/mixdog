//! Fails a release-profile build with a development-only feature (native/core/build-support/dev_only.rs).

#![allow(clippy::disallowed_methods, reason = "a build script runs before any runtime exists")]

#[path = "../../build-support/dev_only.rs"]
mod dev_only;

fn main() {
    dev_only::refuse_in_release(&["crash-gates", "dev-controls", "replay-bytes", "replay-controls", "replay-settled", "terminal-lease-clock", "virtual-clock"]);
    if cfg!(windows) && std::env::var_os("CARGO_FEATURE_ALLOC_PROFILE").is_some() {
        println!("cargo:rustc-link-arg-bin=mixdogd=/MAP");
    }
    segment_heap();
    stamp_identity();
}

/// The segment-heap setting exists only as an application manifest, which the linker embeds beside its own default one.
fn segment_heap() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let out = std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR for a build script");
    let path = std::path::Path::new(&out).join("mixdogd.manifest");
    let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <heapType xmlns="http://schemas.microsoft.com/SMI/2020/WindowsSettings">SegmentHeap</heapType>
    </windowsSettings>
  </application>
</assembly>
"#;
    std::fs::write(&path, manifest).unwrap_or_else(|error| panic!("writing the heap manifest {}: {error}", path.display()));
    println!("cargo:rustc-link-arg-bin=mixdogd=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-bin=mixdogd=/MANIFESTINPUT:{}", path.display());
    // The linker would add its default execution-level fragment to an embedded manifest; a binary without a
    // manifest had none, and the heap is the only thing this one changes.
    println!("cargo:rustc-link-arg-bin=mixdogd=/MANIFESTUAC:NO");
}

#[cfg(windows)]
fn stamp_identity() {
    println!("cargo:rerun-if-changed=../../../../apps/desktop/build/mixdog.ico");
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog")
        .set("OriginalFilename", "mixdogd.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog")
        .set_icon("../../../../apps/desktop/build/mixdog.ico");
    if let Err(error) = resource.compile() {
        println!("cargo:warning=mixdogd version resource skipped: {error}");
    }
}

#[cfg(not(windows))]
fn stamp_identity() {}
