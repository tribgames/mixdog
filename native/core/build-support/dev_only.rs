//! The one release guard of the development-only features (test seams, replay controls, crash hooks, counters): each
//! crate that declares such a feature calls [`refuse_in_release`] from its build script with their names, through
//! `#[path = "<relative>/native/core/build-support/dev_only.rs"] mod dev_only;`. `PROFILE` is `release` for the release
//! profile and every profile that inherits it, whatever its name, so an optimised build with debug assertions or a
//! renamed release profile is caught too.

/// Fails the build when the profile inherits `release` and any of `features` (this package's) is on.
pub fn refuse_in_release(features: &[&str]) {
    // Without it Cargo reruns the script on every change in the package; a change of this file rebuilds the script.
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    let package = std::env::var("CARGO_PKG_NAME").unwrap_or_default();
    for feature in features {
        let var = format!("CARGO_FEATURE_{}", feature.to_uppercase().replace('-', "_"));
        if std::env::var_os(var).is_some() {
            println!("cargo::error=feature `{package}/{feature}` is for development builds only: a release-profile build must not have it");
        }
    }
}
