//! The reply module of the browser engine. Submodules are filled by the tasks named on their first line.

#[allow(clippy::module_inception, reason = "Preserve the established public module path and diagnostic/test names without renaming its implementation module")]
pub mod reply;
pub mod snapshot_format;
pub mod screenshot;
pub mod dialog_text;
pub mod tabs_text;
pub mod downloads_text;
