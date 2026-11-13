//! Fails a release-profile build with a development-only feature (native/core/build-support/dev_only.rs).

#![allow(clippy::disallowed_methods, reason = "a build script runs before any runtime exists")]

#[path = "../../build-support/dev_only.rs"]
mod dev_only;

fn main() {
    dev_only::refuse_in_release(&["crash-gates", "dev-controls", "replay-bytes", "replay-controls", "replay-settled", "terminal-lease-clock", "virtual-clock"]);
    stamp_identity();
}

/// The Windows version resource and icon of `mixdogd.exe`. A Rust binary carries neither, so the core was a nameless
/// row with a generic icon in every process list; with the desktop app's product name and icon it reads as part of
/// Mixdog (the app starts it under the app's own name, `core/Mixdog.exe`, and Task Manager shows the description).
/// Cosmetic: a machine without the resource compiler still builds a working core.
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
