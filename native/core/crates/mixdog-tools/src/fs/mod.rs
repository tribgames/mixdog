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
#[cfg(node_twin)]
#[cfg(all(test, node_twin))]
mod other_node_cases;
#[cfg(all(test, node_twin))]
mod search_node_cases;
#[cfg(test)]
mod search_paging_tests;
#[cfg(test)]
mod tests;
#[cfg(node_twin)]
#[cfg(all(test, node_twin))]
mod node_cases;

pub use edit::EditTool;
pub use edit::WriteTool;
pub use list::ListTool;
pub use patch::ApplyPatchTool;
pub use read::READ_PDF_MAX_PAGES_PER_CALL;
pub use read::ReadTool;
pub(crate) use read::normalize_input_path;
pub(crate) use read_paths::normalize_error_message;
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
pub use search::glob_result_roots;

/// Resolve a cache dependency by the same path rules as the filesystem tools.
pub fn result_root(cwd: &std::path::Path, path: &str) -> Option<std::path::PathBuf> {
    let cwd = mixdog_core_api::domain::common::AbsPath::new(cwd.to_path_buf())?;
    Some(common::resolve_path(&cwd, path).ok()?.as_path().to_path_buf())
}

/// A read locator that names a file without the executor's coordinate or glob expansion.
pub fn read_result_file(cwd: &std::path::Path, path: &str) -> Option<std::path::PathBuf> {
    let path = read::normalize_input_path(path);
    if common::has_glob_magic(&path) || read::has_line_coordinate(&path) {
        return None;
    }
    result_root(cwd, &path)
}

/// The actual base used by `list`, including its find mode and glob-shaped paths.
pub fn list_result_root(args: &mixdog_protocol::JsonValue) -> Option<String> {
    let raw = common::optional_path_arg(args, "path", |_| String::new()).ok()?.unwrap_or(".");
    let mode = common::arg_str(args, "mode");
    let glob_find = mode != Some("tree")
        && !common::arg_str(args, "name").is_some_and(|name| !name.is_empty())
        && common::has_glob_magic(raw);
    if (mode == Some("find") || glob_find) && list::uses_relative_time(args) {
        return None;
    }
    if glob_find {
        return Some(common::extract_glob_base_directory(raw).0.unwrap_or_else(|| ".".to_owned()));
    }
    Some(raw.to_owned())
}
