//! Fails a release-profile build with a development-only feature (native/core/build-support/dev_only.rs).

#![allow(clippy::disallowed_methods, reason = "a build script runs before any runtime exists")]

#[path = "../../build-support/dev_only.rs"]
mod dev_only;

fn main() {
    dev_only::refuse_in_release(&["crash-gates", "dev-controls", "replay-bytes", "replay-controls", "replay-settled", "terminal-lease-clock", "virtual-clock"]);
}
