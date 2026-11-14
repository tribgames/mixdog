//! File tools (WP-TOOLS-FS): read, list, glob, find, grep.

pub(crate) mod common;
mod edit;
mod edit_plan;
mod grep_context;
mod hints;
mod list;
mod not_found;
mod patch;
mod patch_guard;
mod patch_hunk;
mod patch_native;
mod patch_parse;
mod advisory;
mod os_error;
mod patch_redirect;
mod patch_review;
mod patch_unified;
mod patch_window;
mod read;
mod read_batch;
mod read_legacy;
mod read_paths;
pub mod read_state;
mod search;
#[cfg(test)]
mod other_node_cases;
#[cfg(test)]
mod search_node_cases;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod node_cases;

pub use edit::EditTool;
pub use edit::WriteTool;
pub use list::ListTool;
pub use patch::ApplyPatchTool;
pub use read::READ_PDF_MAX_PAGES_PER_CALL;
pub use read::ReadTool;
pub(crate) use read::normalize_input_path;
pub use read_state::FileVersion;
pub use read_state::Persistence;
pub use read_state::ReadState;
pub use read_state::SnapshotMeta;
pub use read_state::SnapshotPersist;

/// `err.message` of a failed atomic write of `target` (the step that failed, as Node words it).
pub fn write_failure_message(error: &mixdog_core_api::domain::fs::FsError, target: &std::path::Path) -> String {
    os_error::write_message(error, target)
}

/// `err.message` of a failed `readFileSync(target)`: `ENOENT: no such file or directory, open '<target>'`.
pub fn read_failure_message(error: &mixdog_core_api::domain::fs::FsError, target: &std::path::Path) -> String {
    os_error::read_message(error, target)
}

/// The key a path has in the [`ReadState`] (the file tools' own key).
pub fn read_state_key(path: &std::path::Path) -> String {
    common::fwd(path)
}
pub use search::FindTool;
pub use search::GlobTool;
pub use search::GrepTool;
pub use search::SearchTimer;
