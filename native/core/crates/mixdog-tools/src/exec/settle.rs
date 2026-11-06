//! The command-settled hook: a finished shell, terminal or git command (and the end of a
//! background shell task) is a boundary for the turn review of the worktree it ran in. Node
//! `tool-exec.mjs` (`noteCommandToolSettled(effectiveToolCwd(...))`) and `background-tasks.mjs`
//! (`completeBackgroundTask`) signal it; `runtime-review-api.mjs` turns it into
//! `noteTurnWorktreeChange(cwd ? [cwd] : null)`.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::turn_review::TurnReviewApi;

/// `onCommandToolSettled((cwd) => noteTurnWorktreeChange(cwd ? [cwd] : null))`. Without a review
/// wired nothing follows the worktree, as when Node's review API is not loaded.
pub(crate) fn note_command_settled(review: Option<&Arc<dyn TurnReviewApi>>, cwd: &str) {
    let Some(review) = review else { return };
    if cwd.is_empty() {
        review.note_change(None);
    } else {
        review.note_change(Some(&[cwd.to_owned()]));
    }
}

/// Notes the settle when dropped — on every exit of the call, a cancelled (dropped) future
/// included, as Node's `finally` does.
pub(crate) struct SettleGuard {
    review: Option<Arc<dyn TurnReviewApi>>,
    cwd: String,
}

impl SettleGuard {
    pub(crate) fn new(review: Option<Arc<dyn TurnReviewApi>>, cwd: String) -> Self {
        Self { review, cwd }
    }
}

impl Drop for SettleGuard {
    fn drop(&mut self) {
        note_command_settled(self.review.as_ref(), &self.cwd);
    }
}

/// `effectiveShellCwd(args, sessionCwd)`: the `cwd` argument (home-expanded, resolved against the
/// session cwd), or the session cwd when it is not a non-blank string. Nothing is checked on disk.
pub(crate) fn effective_shell_cwd(session_cwd: &Path, requested: Option<&str>) -> String {
    let Some(requested) = requested.filter(|r| !mixdog_js::js_trim(r).is_empty()) else {
        return session_cwd.to_string_lossy().into_owned();
    };
    resolve(session_cwd, &expand_home(requested)).to_string_lossy().into_owned()
}

/// `~`, `~/x` (and `~\x` on Windows) name the user's home folder.
fn expand_home(path: &str) -> PathBuf {
    let Some(home) = dirs::home_dir() else { return PathBuf::from(path) };
    if path == "~" {
        return home;
    }
    if path.starts_with("~/") || (cfg!(windows) && path.starts_with("~\\")) {
        return resolve(&home, Path::new(&path[2..]));
    }
    PathBuf::from(path)
}

/// `path.resolve(base, p)`: `p` against the absolute `base`, `.` and `..` folded, no trailing
/// separator.
fn resolve(base: &Path, p: &Path) -> PathBuf {
    let own_prefix = matches!(p.components().next(), Some(Component::Prefix(_)));
    let mut out = PathBuf::new();
    if !own_prefix {
        for part in base.components() {
            if p.has_root() && matches!(part, Component::Normal(_)) {
                break;
            }
            apply(&mut out, part);
        }
    }
    for part in p.components() {
        apply(&mut out, part);
    }
    out
}

fn apply(out: &mut PathBuf, part: Component<'_>) {
    match part {
        Component::Prefix(_) | Component::RootDir => out.push(part.as_os_str()),
        Component::CurDir => {}
        Component::ParentDir => {
            if out.components().any(|c| matches!(c, Component::Normal(_))) {
                out.pop();
            }
        }
        Component::Normal(name) => out.push(name),
    }
}

#[cfg(test)]
pub(crate) use recorder::RecordingReview;

#[cfg(test)]
mod recorder {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_core_api::turn_review::*;

    /// Remembers every `note_change`; the rest of the review is inert.
    #[derive(Default)]
    pub(crate) struct RecordingReview {
        pub notes: Mutex<Vec<Option<Vec<String>>>>,
    }

    #[async_trait]
    impl TurnReviewApi for RecordingReview {
        async fn record_call(&self, _: &str, _: &str, _: &str, _: Vec<CallChange>) {}
        async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<CallChange>) {}
        fn take_call_diff(&self, _: &str) -> Option<String> {
            None
        }
        fn note_change(&self, paths: Option<&[String]>) {
            self.notes.lock().unwrap().push(paths.map(<[String]>::to_vec));
        }
        async fn begin_turn(&self, _: &str, _: &str, _: TurnOpen) -> Option<TurnToken> {
            None
        }
        async fn complete_turn(&self, _: &str, _: Option<&TurnToken>) -> bool {
            false
        }
        fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn AgentReview>> {
            None
        }
        fn forget_session(&self, _: &str) {}
        async fn turn_review_diff(&self, _: &str, _: &str, _: ReviewRead) -> Reply {
            Reply::new()
        }
        async fn session_review_diff(&self, _: &str, _: &str) -> Reply {
            Reply::new()
        }
        async fn session_review_file_patch(&self, _: &str, _: &str, _: &str, _: &str) -> Reply {
            Reply::new()
        }
        async fn turn_review_file_patch(&self, _: &str, _: &str, _: &str) -> Reply {
            Reply::new()
        }
        async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<Reply, ReviewError> {
            Ok(Reply::new())
        }
        async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<Reply, ReviewError> {
            Ok(Reply::new())
        }
        async fn turn_changes(&self, _: &str, _: ChangesRead) -> Result<Reply, ReviewError> {
            Ok(Reply::new())
        }
        async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<Reply, ReviewError> {
            Ok(Reply::new())
        }
        async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<Reply, ReviewError> {
            Ok(Reply::new())
        }
        async fn clear_change_history(&self, _: &str) -> Result<Reply, ReviewError> {
            Ok(Reply::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> PathBuf {
        if cfg!(windows) { PathBuf::from(r"C:\work\repo") } else { PathBuf::from("/work/repo") }
    }

    /// Values from Node's `effectiveShellCwd` (`path.resolve`), checked with posix separators
    /// folded by the host.
    #[test]
    fn the_effective_cwd_resolves_like_node() {
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        let b = base();
        let join = |rest: &str| {
            let sep = std::path::MAIN_SEPARATOR;
            format!("{root}{}", rest.replace('/', &sep.to_string()))
        };
        assert_eq!(effective_shell_cwd(&b, None), b.to_string_lossy());
        assert_eq!(effective_shell_cwd(&b, Some("  ")), b.to_string_lossy());
        assert_eq!(effective_shell_cwd(&b, Some("sub/../x/")), join("work/repo/x"));
        assert_eq!(effective_shell_cwd(&b, Some("./a/./b")), join("work/repo/a/b"));
        assert_eq!(effective_shell_cwd(&b, Some("../../..")), root);
        assert_eq!(effective_shell_cwd(&b, Some("../other")), join("work/other"));
        assert_eq!(effective_shell_cwd(&b, Some("/abs/../z")), join("z"));
        let home = dirs::home_dir().unwrap();
        assert_eq!(effective_shell_cwd(&b, Some("~")), home.to_string_lossy());
        assert_eq!(effective_shell_cwd(&b, Some("~/proj/./x")), home.join("proj").join("x").to_string_lossy());
        // Edge spaces name a different folder: trim only decides blank.
        assert_eq!(effective_shell_cwd(&b, Some(" a ")), join("work/repo/ a "));
    }
}
