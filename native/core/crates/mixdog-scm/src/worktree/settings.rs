//! Worktree settings, persisted at agent config `worktree`. Defaults live in code; the stored
//! section holds only what the user changed.

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::error::ScmFailure;

/// Repository size that asks for confirmation by default: 2 GiB (`settings.mjs:32`).
pub const DEFAULT_SIZE_WARN_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettings {
    /// `branch` (new tasks use the project folder's branch) or `worktree`.
    pub new_task_default: String,
    /// Ref prefix of created branches, ending with `/`; empty names the branch after the task.
    pub branch_prefix: String,
    /// Repository size that asks for confirmation; 0 never asks.
    pub size_warn_bytes: u64,
    /// Remove clean, merged worktrees when their session ends. The settings below apply only
    /// while it is on.
    pub auto_cleanup: bool,
    /// Keep at most this many managed worktrees (oldest activity cleaned first); 0 keeps any.
    pub max_worktrees: u64,
    /// Clean up worktrees unused this many days; 0 never.
    pub unused_days: u64,
    /// Archiving a session makes its worktrees disposable.
    pub cleanup_archived: bool,
    /// Cleanup deletes a removed worktree's branch when Mixdog created it and git considers it
    /// merged; off keeps every branch.
    pub delete_branch: bool,
}

impl Default for WorktreeSettings {
    fn default() -> Self {
        Self {
            new_task_default: "branch".into(),
            branch_prefix: String::new(),
            size_warn_bytes: DEFAULT_SIZE_WARN_BYTES,
            auto_cleanup: true,
            max_worktrees: 15,
            unused_days: 30,
            cleanup_archived: true,
            delete_branch: false,
        }
    }
}

const MAX_WORKTREES_LIMIT: u64 = 1000;
const UNUSED_DAYS_LIMIT: u64 = 3650;

fn valid_prefix(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let Some(body) = value.strip_suffix('/') else {
        return false;
    };
    value.len() <= 64
        && !value.contains("..")
        && !value.to_lowercase().contains(".lock/")
        && body.split('/').all(|part| {
            let mut chars = part.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

/// Why `value` cannot be stored for `key`, or `None`.
fn field_error(key: &str, value: &Value) -> Option<String> {
    let non_negative = || value.as_u64().is_none().then(|| "must be a non-negative integer".to_owned());
    let bounded = |limit: u64| {
        (!value.as_u64().is_some_and(|n| n <= limit)).then(|| format!("must be an integer from 0 to {limit}"))
    };
    match key {
        "newTaskDefault" => (!matches!(value.as_str(), Some("branch" | "worktree")))
            .then(|| "must be one of branch, worktree".to_owned()),
        "branchPrefix" => (!value.as_str().is_some_and(valid_prefix))
            .then(|| "must be empty or a ref path ending with \"/\", e.g. \"mixdog/\"".to_owned()),
        "sizeWarnBytes" => non_negative(),
        "maxWorktrees" => bounded(MAX_WORKTREES_LIMIT),
        "unusedDays" => bounded(UNUSED_DAYS_LIMIT),
        "autoCleanup" | "cleanupArchived" | "deleteBranch" => (!value.is_boolean()).then(|| "must be a boolean".to_owned()),
        _ => Some("is not a worktree setting".to_owned()),
    }
}

fn merge(settings: &mut WorktreeSettings, key: &str, value: &Value) {
    match key {
        "newTaskDefault" => settings.new_task_default = value.as_str().unwrap_or_default().to_owned(),
        "branchPrefix" => settings.branch_prefix = value.as_str().unwrap_or_default().to_owned(),
        "sizeWarnBytes" => settings.size_warn_bytes = value.as_u64().unwrap_or_default(),
        "maxWorktrees" => settings.max_worktrees = value.as_u64().unwrap_or_default(),
        "unusedDays" => settings.unused_days = value.as_u64().unwrap_or_default(),
        "autoCleanup" => settings.auto_cleanup = value.as_bool().unwrap_or_default(),
        "cleanupArchived" => settings.cleanup_archived = value.as_bool().unwrap_or_default(),
        "deleteBranch" => settings.delete_branch = value.as_bool().unwrap_or_default(),
        _ => {}
    }
}

/// Effective settings from the stored section; an invalid stored value falls back to its
/// default so a hand edit never breaks boot.
pub fn normalize(stored: &Value) -> WorktreeSettings {
    let mut settings = WorktreeSettings::default();
    if let Some(map) = stored.as_object() {
        for (key, value) in map {
            if field_error(key, value).is_none() {
                merge(&mut settings, key, value);
            }
        }
    }
    settings
}

/// Applies a user patch strictly: unknown keys and invalid values are refused.
pub fn apply_patch(current: &Value, patch: &Value) -> Result<WorktreeSettings, ScmFailure> {
    let map = patch
        .as_object()
        .filter(|map| !map.is_empty())
        .ok_or_else(|| ScmFailure::invalid("worktree", "at least one setting"))?;
    for (key, value) in map {
        if let Some(error) = field_error(key, value) {
            return Err(ScmFailure::invalid(format!("worktree.{key}"), error));
        }
    }
    let mut settings = normalize(current);
    for (key, value) in map {
        merge(&mut settings, key, value);
    }
    Ok(settings)
}

/// Where the settings come from: the config actor, read at use time.
#[async_trait::async_trait]
pub trait SettingsSource: Send + Sync {
    async fn worktree_settings(&self) -> WorktreeSettings;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn invalid_stored_values_fall_back_and_patches_are_strict() {
        let settings = normalize(&json!({"maxWorktrees": 5, "unusedDays": -1, "branchPrefix": "bad"}));
        assert_eq!((settings.max_worktrees, settings.unused_days), (5, 30));
        assert_eq!(settings.branch_prefix, "");
        assert!(apply_patch(&json!({}), &json!({"branchPrefix": "mixdog/"})).is_ok());
        assert!(apply_patch(&json!({}), &json!({"maxWorktrees": 5000})).is_err());
        assert!(apply_patch(&json!({}), &json!({"nope": 1})).is_err());
        assert!(apply_patch(&json!({}), &json!({})).is_err());
    }
}
