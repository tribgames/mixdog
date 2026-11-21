// Build script: rule bundling (all platforms, `build_rules.rs`) + the Windows
// VERSIONINFO resource.
#[path = "build_rules.rs"]
mod build_rules;

fn bundle_outline_rules() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    build_rules::bundle_outline_rules(&manifest_dir);
}

#[cfg(windows)]
fn main() {
    bundle_outline_rules();
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog")
        .set("OriginalFilename", "mixdog-graph.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog")
        .set_icon("../../apps/desktop/build/mixdog.ico");
    // Resource metadata is cosmetic: a machine without the Windows SDK
    // resource compiler must still produce a working binary, so a failure
    // downgrades to the previous "no version info" behaviour instead of
    // breaking the build.
    if let Err(error) = resource.compile() {
        println!("cargo:warning=mixdog-graph version resource skipped: {error}");
    }
}

#[cfg(not(windows))]
fn main() {
    bundle_outline_rules();
}
