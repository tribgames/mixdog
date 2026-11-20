//! The settle module of the browser engine. Submodules are filled by the tasks named on their first line.

pub mod actionability;
pub mod postcondition;
pub mod reply_wait;
#[allow(clippy::module_inception, reason = "Preserve the established public module path and diagnostic/test names without renaming its implementation module")]
pub mod settle;
