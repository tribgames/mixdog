//! `worktreeNameError` (`worktrees/contract.mjs`): what a worktree name may not be. A task session's create reads it, and so does the
//! terminal program's `--worktree <name>` before anything starts.

use serde_json::Value;

/// `WORKTREE_NAME_MAX_LENGTH`.
const WORKTREE_NAME_MAX_LENGTH: usize = 64;

/// `worktreeNameError(name)`: why `name` cannot be a worktree slug.
pub fn worktree_name_error(name: &Value) -> Option<String> {
    let Some(name) = name.as_str().filter(|n| !n.is_empty()) else {
        return Some("a name is required".into());
    };
    if mixdog_js::utf16_len(name) > WORKTREE_NAME_MAX_LENGTH {
        return Some(format!("at most {WORKTREE_NAME_MAX_LENGTH} characters"));
    }
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !first_ok || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Some("use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit".into());
    }
    if name.contains("..") || name.ends_with('.') || name.to_lowercase().ends_with(".lock") {
        return Some("not a valid git branch component".into());
    }
    None
}
