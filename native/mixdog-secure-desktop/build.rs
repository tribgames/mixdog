// Windows VERSIONINFO for the bridge executable.
//
// A Rust binary ships no version resource, so the UAC prompt for the elevated
// `install` showed only the bare file name. Windows takes the program name it
// shows there (and in Explorer's properties and process lists) from the
// resource's `FileDescription`; this stamps the product's Korean name.
//
// Same mechanism and crate as the other native tools (mixdog-spawn,
// mixdog-graph, mixdog-patch): winresource writes `resource.rc` into OUT_DIR
// with `#pragma code_page(65001)`, so the UTF-8 strings below survive, and
// compiles it with the Windows SDK `rc.exe` of the MSVC toolchain. The
// resource is linked into the exe here, before packaging signs it.
// FileVersion/ProductVersion come from Cargo.toml's `package.version`.
//
// Unlike those tools, a failure fails the build: without the resource the UAC
// prompt names a bare file instead of the product, so it is not cosmetic here.
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
