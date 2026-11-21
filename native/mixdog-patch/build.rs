// ProductName matches electron-builder.yml productName.
#[cfg(windows)]
fn main() {
    if std::env::var_os("CARGO_FEATURE_RESOURCE").is_none() {
        return;
    }
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog")
        .set("OriginalFilename", "mixdog-patch.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog")
        .set_icon("../../apps/desktop/build/mixdog.ico");
    if let Err(error) = resource.compile() {
        println!("cargo:warning=mixdog-patch version resource skipped: {error}");
    }
}

#[cfg(not(windows))]
fn main() {}
