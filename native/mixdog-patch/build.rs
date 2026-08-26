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
#[cfg(windows)]
fn main() {
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog")
        .set("OriginalFilename", "mixdog-patch.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog")
        .set_icon("../../apps/desktop/build/mixdog.ico");
    // Resource metadata is cosmetic: a machine without the Windows SDK
    // resource compiler must still produce a working binary, so a failure
    // downgrades to the previous "no version info" behaviour instead of
    // breaking the build.
    if let Err(error) = resource.compile() {
        println!("cargo:warning=mixdog-patch version resource skipped: {error}");
    }
}

#[cfg(not(windows))]
fn main() {}
