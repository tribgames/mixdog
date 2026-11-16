//! The runner module of the browser engine. Submodules are filled by the tasks named on their first line.

#[allow(clippy::module_inception, reason = "Preserve the established public module path and diagnostic/test names without renaming its implementation module")]
pub mod runner;
pub mod guard;
pub mod task_pages;
pub mod timing_rows;
