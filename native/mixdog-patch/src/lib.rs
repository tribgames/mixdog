//! The patch engine as a library: the same source the `mixdog-patch` binary is built from, so the
//! Rust core applies a patch with the engine Node runs. Nothing here changes the engine; the binary
//! target (`main.rs`) and its release flow are untouched.

// `main.rs` is the engine's root module. Its `fn main` and server loop are the binary's, and
// only the items it declares `pub` are the library's surface.
#[allow(dead_code, reason = "the binary entry point and CLI parsing are unused when linked as a library")]
#[path = "main.rs"]
mod engine;

pub use engine::ENGINE_CONTRACT_MARKER;
pub use engine::ApplyOptions;
pub use engine::ApplyStats;
pub use engine::FailedEntry;
pub use engine::apply_patch_to_base;
