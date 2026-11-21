// The UAC prompt, Explorer properties and process lists take the program name from the
// VERSIONINFO `FileDescription`; a Rust binary ships none. winresource compiles it with
// the MSVC toolchain's `rc.exe` (UTF-8 via code_page 65001); FileVersion/ProductVersion
// come from Cargo.toml's `package.version`.
#[cfg(windows)]
fn main() {
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("FileDescription", "Mixdog 원격 접근")
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("OriginalFilename", "mixdog-secure-desktop.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog");
    if let Err(error) = resource.compile() {
        panic!("mixdog-secure-desktop version resource: {error}");
    }
}

#[cfg(not(windows))]
fn main() {}
