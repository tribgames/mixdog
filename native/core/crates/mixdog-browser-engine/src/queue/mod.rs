//! The queue module of the browser engine. Submodules are filled by the tasks named on their first line.

pub mod barrier;
pub mod key;
#[allow(clippy::module_inception, reason = "Preserve the established public module path and diagnostic/test names without renaming its implementation module")]
pub mod queue;
pub mod user_hold;
pub mod user_wait;
