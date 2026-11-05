//! Project classification of a working directory. The single source is a
//! `.mixdog/project.id` file in the directory or the nearest ancestor holding
//! one; `common` (any case) or an empty file means COMMON. Nothing is inferred
//! from git remotes, names or the process working directory.

use mixdog_js::{js_trim};
use std::path::{Path, PathBuf};

/// A file a crash left NUL-filled holds no data and counts as absent.
fn holds_no_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0')
}

async fn find_marker_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if tokio::fs::try_exists(dir.join(".mixdog").join("project.id")).await.unwrap_or(false) {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// The project id declared for `cwd`, or None for COMMON.
pub async fn resolve_project_id(cwd: &Path) -> Option<String> {
    let root = find_marker_root(cwd).await?;
    let raw = tokio::fs::read_to_string(root.join(".mixdog").join("project.id")).await.ok()?;
    let content = if holds_no_data(&raw) { "" } else { js_trim(&raw) };
    (!content.is_empty() && !(content.to_lowercase() == "common")).then(|| content.to_owned())
}

/// Project classification for a call: the explicit `cwd` when given, else the
/// session's own working directory. No directory means COMMON; the process
/// working directory is never consulted.
pub async fn resolve_project_scope(explicit_cwd: Option<&str>, session_cwd: Option<&Path>) -> Option<String> {
    let cwd = match explicit_cwd.filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => PathBuf::from(cwd),
        None => session_cwd?.to_path_buf(),
    };
    let absolute = if cwd.is_absolute() { cwd } else { std::env::current_dir().ok()?.join(cwd) };
    resolve_project_id(&absolute).await
}
