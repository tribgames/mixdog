//! Fails every release-profile build with feature `virtual-clock` (a replay's clock, `src/virtual_clock.rs`), whatever else the
//! build enables: `PROFILE` is `release` for the release profile and every profile that inherits it. Each crate that can turn
//! the feature on forwards it here (`mixdog-core-session`, `mixdog-app-server-daemon`, `mixdog-cli`).

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_VIRTUAL_CLOCK").is_some() && std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo::error=feature `virtual-clock` puts the core's clock under a replay's control: a release-profile build must not have it");
    }
}
