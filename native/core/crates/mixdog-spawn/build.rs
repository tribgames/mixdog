// The release guard of `native/mixdog-spawn/build.rs`, for the core's build of the library (see Cargo.toml).
#[path = "../../build-support/dev_only.rs"]
mod dev_only;

fn main() {
    dev_only::refuse_in_release(&["core-test", "lease-clock", "scripted-shell"]);
}
