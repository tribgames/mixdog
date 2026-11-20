//! The reply module of the browser engine. Submodules are filled by the tasks named on their first line.

pub mod dialog_text;
pub mod downloads_text;
#[allow(clippy::module_inception, reason = "Preserve the established public module path and diagnostic/test names without renaming its implementation module")]
pub mod reply;
pub mod screenshot;
pub mod snapshot_format;
pub mod tabs_text;
