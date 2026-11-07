//! Project classification of a working directory. The single source is a
//! `.mixdog/project.id` file in the directory or the nearest ancestor holding
//! one; `common` (any case) or an empty file means COMMON. Nothing is inferred
//! from git remotes, names or the process working directory.

use mixdog_js::js_trim;
use mixdog_rt::DurabilityIo;
use std::path::{Path, PathBuf};

use crate::lane::on_lane;

/// A file a crash left NUL-filled holds no data and counts as absent.
fn holds_no_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0')
}

#[allow(clippy::disallowed_methods, reason = "runs inside the lane job of `resolve_project_id`")]
fn find_marker_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if dir.join(".mixdog").join("project.id").try_exists().unwrap_or(false) {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// The project id declared for `cwd`, or None for COMMON. The ancestor walk and the read are
/// one job on `lane`. A walk that never ran is an error: it must not file the call under COMMON.
#[allow(clippy::disallowed_methods, reason = "the whole walk is a lane job")]
pub async fn resolve_project_id(lane: DurabilityIo, cwd: &Path) -> std::io::Result<Option<String>> {
    let cwd = cwd.to_owned();
    on_lane(lane, move || {
        let root = find_marker_root(&cwd)?;
        let raw = std::fs::read_to_string(root.join(".mixdog").join("project.id")).ok()?;
        let content = if holds_no_data(&raw) { "" } else { js_trim(&raw) };
        (!content.is_empty() && content.to_lowercase() != "common").then(|| content.to_owned())
    })
    .await
}

/// Project classification for a call: the explicit `cwd` when given, else the
/// session's own working directory. No directory means COMMON; the process
/// working directory is never consulted.
pub async fn resolve_project_scope(lane: DurabilityIo, explicit_cwd: Option<&str>, session_cwd: Option<&Path>) -> std::io::Result<Option<String>> {
    let cwd = match explicit_cwd.filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => PathBuf::from(cwd),
        None => match session_cwd {
            Some(cwd) => cwd.to_path_buf(),
            None => return Ok(None),
        },
    };
    let absolute = if cwd.is_absolute() {
        cwd
    } else {
        match std::env::current_dir() {
            Ok(here) => here.join(cwd),
            Err(_) => return Ok(None),
        }
    };
    resolve_project_id(lane, &absolute).await
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test builds its marker file on the test thread")]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn a_marker_walk_that_never_ran_is_an_error_not_common() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".mixdog")).unwrap();
        std::fs::write(dir.path().join(".mixdog").join("project.id"), "alpha").unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        assert_eq!(resolve_project_id(lane, dir.path()).await.unwrap(), Some("alpha".to_owned()));
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        assert!(resolve_project_id(lane, dir.path()).await.is_err());
        assert!(resolve_project_scope(lane, dir.path().to_str(), None).await.is_err());
    }
}
