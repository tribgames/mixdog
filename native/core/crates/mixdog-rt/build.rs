//! Fails a release-profile build with a development-only feature (native/core/build-support/dev_only.rs): `test-support`, and
//! `virtual-clock` (a replay's clock, `src/virtual_clock.rs`), which every crate that can turn it on forwards here.

#![allow(clippy::disallowed_methods, reason = "a build script runs before any runtime exists")]

#[path = "../../build-support/dev_only.rs"]
mod dev_only;

fn main() {
    dev_only::refuse_in_release(&["test-support", "virtual-clock"]);
}
