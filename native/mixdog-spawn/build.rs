// Windows VERSIONINFO for the helper executable.
//
// A Rust binary ships NO version resource at all, so this helper was nameless
// in Explorer's properties dialog and in every process list. Stamping the same
// ProductName the desktop app uses (electron-builder.yml `productName: Mixdog`)
// gives it a branded identity wherever Windows reads file metadata.
//
// This does NOT merge the process into the app's Task Manager row: that
// grouping keys off AppUserModelID, which a version resource cannot carry.
// main.rs claims the desktop AUMID at startup to do that.
//
// Every build also refuses the development-only features in a release-profile build
// (native/core/build-support/dev_only.rs).
#[path = "../core/build-support/dev_only.rs"]
mod dev_only;

#[cfg(windows)]
fn main() {
    dev_only::refuse_in_release(&["core-test", "lease-clock", "scripted-shell"]);
    // The script's only other input; without a rerun-if line Cargo reran it (and the resource compiler) on every
    // change in the package.
    println!("cargo::rerun-if-changed=../../apps/desktop/build/mixdog.ico");
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog")
        .set("OriginalFilename", "mixdog-spawn.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog")
        .set_icon("../../apps/desktop/build/mixdog.ico");
    // Resource metadata is cosmetic: a machine without the Windows SDK
    // resource compiler must still produce a working binary, so a failure
    // downgrades to the previous "no version info" behaviour instead of
    // breaking the build.
    if let Err(error) = resource.compile() {
        println!("cargo:warning=mixdog-spawn version resource skipped: {error}");
    }
}

#[cfg(not(windows))]
fn main() {
    dev_only::refuse_in_release(&["core-test", "lease-clock", "scripted-shell"]);
}
