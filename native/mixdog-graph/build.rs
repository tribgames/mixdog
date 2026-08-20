// Windows VERSIONINFO for the helper executable.
//
// Task Manager collapses processes into one application row by the image's
// version-resource ProductName combined with the parent/child relationship. A
// Rust binary ships NO version resource at all, so these helpers advertised an
// empty ProductName and listed themselves as separate top-level rows even
// though their parent is a Mixdog session shard. Stamping the same ProductName
// the desktop app uses (electron-builder.yml `productName: Mixdog`) lets them
// join the existing group instead of appearing as unrelated strays.
#[cfg(windows)]
fn main() {
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog Code Graph & Search")
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
fn main() {}
