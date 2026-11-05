//! The wording of a worktree refusal for the `git` tool: the desktop's English source strings
//! (`worktree-branch-model.ts` `worktreeFailureText`) and what the caller does next.

use mixdog_protocol::DomainErrorDetail;
use serde_json::Value;
use serde_json::json;

use crate::error::ScmFailure;

/// The desktop's byte size text.
pub fn format_byte_size(bytes: u64) -> String {
    if bytes == 0 {
        return String::new();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut value, mut unit) = (bytes as f64, 0);
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 10.0 || unit == 0 {
        format!("{} {}", value.round() as u64, units[unit])
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

fn refusal_reason_text(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "workspace-retained" => "Sessions still retain this folder. Close or remove those sessions before cleaning it up.",
        "workspace-lease" => "A runtime still holds this folder. Stop its work and release the workspace first.",
        "folder-in-use" => "Sessions or workers still use an affected folder. Finish or move them before continuing.",
        "folder-shell-jobs" => "Background commands still use an affected folder. Wait for them or stop them first.",
        "workspace-admission-unreadable" => "Workspace activity cannot be verified. Nothing was changed.",
        _ => return None,
    })
}

fn merge_failed_reason(reason: &str, source: Option<&str>) -> String {
    match reason {
        "source-invalid" => "A merge source branch is required.".to_owned(),
        "detached-head" => "Check out a branch in the project folder before merging.".to_owned(),
        "target-empty" => "The merge target has no commits.".to_owned(),
        "source-missing" => format!("No branch or commit named {}.", source.unwrap_or("")),
        "unexpected-head" => "git merge reported success but HEAD is not the expected merge commit.".to_owned(),
        "merge-failed" => "The merge could not be completed.".to_owned(),
        other => other.to_owned(),
    }
}

/// The text a surface shows for a coded failure.
pub fn failure_text(code: &str, detail: Option<&DomainErrorDetail>) -> String {
    use DomainErrorDetail as D;
    match (code, detail) {
        ("WORKTREE_DISK_INSUFFICIENT", Some(D::WorktreeDiskInsufficient { required_bytes, free_bytes, .. })) => {
            let required = format_byte_size(*required_bytes);
            let free = format_byte_size(free_bytes.unwrap_or(0));
            if !required.is_empty() && !free.is_empty() {
                format!("Not enough free disk space to create the worktree ({required} needed, {free} free).")
            } else {
                "Not enough free disk space to create the worktree.".to_owned()
            }
        }
        ("WORKTREE_FILE_RECOVERY", _) => "Retained file recovery records block worktree removal, including force. Inspect and explicitly delete them first.".to_owned(),
        ("WORKTREE_BUSY_JOBS", Some(D::WorktreeBusyJobs { reason, .. })) => refusal_reason_text(reason)
            .map(str::to_owned)
            .unwrap_or_else(|| "Background tasks are still running. Wait for them or stop them, then try again.".to_owned()),
        ("WORKTREE_BUSY_JOBS", _) => "Background tasks are still running. Wait for them or stop them, then try again.".to_owned(),
        ("WORKTREE_BRANCH_OCCUPIED", Some(D::WorktreeBranchOccupied { path: Some(path), .. })) if !path.is_empty() => {
            format!("This branch is already checked out in {path}.")
        }
        ("WORKTREE_BRANCH_OCCUPIED", _) => "This branch is already checked out in another worktree.".to_owned(),
        ("WORKTREE_DEFAULT_BRANCH", _) => "The repository's default branch can't be opened in a worktree: the project folder could not switch to it while the worktree exists. Check it out in the project folder, or create a new branch for the worktree.".to_owned(),
        ("WORKTREE_REMOVAL_INCOMPLETE", _) => "The worktree could not be removed completely because a file is still in use. Close it and remove the worktree again.".to_owned(),
        ("WORKTREE_PATH_UNSAFE", _) => "The worktree folder is not a managed worktree of this project, so nothing was deleted.".to_owned(),
        ("WORKTREE_MISSING", _) => "The worktree folder is missing. Pick a project branch to continue.".to_owned(),
        ("WORKTREE_REVISION_CONFLICT", _) => "The workspace changed, so the menu was refreshed. Try again.".to_owned(),
        ("WORKTREE_NOT_IMPLEMENTED", _) => "Worktrees are not available yet.".to_owned(),
        ("WORKTREE_UNSUPPORTED_REPO", _) => "This folder does not support worktrees.".to_owned(),
        ("WORKTREE_DIRTY", Some(D::WorktreeDirty { reason: Some(reason), .. })) if reason == "project-dirty" => {
            "The project folder has uncommitted changes. Commit or stash them before switching branches.".to_owned()
        }
        ("WORKTREE_DIRTY", Some(D::WorktreeDirty { reason: Some(reason), .. })) => reason.clone(),
        ("WORKTREE_DIRTY", _) => "The worktree has uncommitted changes.".to_owned(),
        ("WORKTREE_PROJECT_UNKNOWN", _) => "Project is not available.".to_owned(),
        ("WORKTREE_PROJECT_MISMATCH", _) => "This session keeps a worktree of another project. Remove it before creating a new one here.".to_owned(),
        ("WORKTREE_LARGE_REPO_CONFIRM", _) => "The repository is large; confirm before creating a worktree.".to_owned(),
        ("MERGE_CONFLICT", _) => "Nothing was merged because the branches conflict.".to_owned(),
        ("WORKTREE_UNMERGED", _) => "The worktree branch has commits that are not merged.".to_owned(),
        ("MERGE_TARGET_DIRTY", _) => "The branch to merge into has uncommitted changes. Commit or stash them first.".to_owned(),
        ("WORKTREE_CONFIRM_REQUIRED", _) => "Confirm the merge before it runs.".to_owned(),
        ("WORKTREE_TARGET_MISMATCH", _) => "The project folder switched to another branch. Check the target and merge again.".to_owned(),
        ("MERGE_FAILED", Some(D::MergeFailed { reason, source, .. })) => {
            format!("The merge failed: {}", merge_failed_reason(reason, source.as_deref()))
        }
        ("MERGE_FAILED", _) => "The merge failed.".to_owned(),
        (other, _) => other.to_owned(),
    }
}

/// The text of a merge that would conflict, naming the first five files.
pub fn merge_conflict_text(files: &[String]) -> String {
    if files.is_empty() {
        return "Nothing was merged because the branches conflict.".to_owned();
    }
    format!(
        "Nothing was merged. Conflicting files: {}{}",
        files.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
        if files.len() > 5 { ", …" } else { "" }
    )
}

/// `MERGE_CONFLICT` as the tool's failure JSON. It has no `DomainErrorDetail` variant: a
/// conflicting merge is a result (`merged:false, conflicts`), and this is how a surface that
/// must fail on it words it.
pub fn merge_conflict_json(files: &[String]) -> Value {
    json!({
        "ok": false,
        "code": "MERGE_CONFLICT",
        "error": merge_conflict_text(files),
        "details": { "files": files },
        "next": next_step("MERGE_CONFLICT", None, false),
    })
}

/// What the caller does next, for the refusals that need the user or a retry.
pub fn next_step(code: &str, detail: Option<&DomainErrorDetail>, raw: bool) -> Option<String> {
    use DomainErrorDetail as D;
    Some(match code {
        "WORKTREE_DIRTY_CHOICE" => {
            let count = match detail {
                Some(D::WorktreeDirtyChoice { count, .. }) => count.to_string(),
                _ => "uncommitted".to_owned(),
            };
            format!("Ask the user whether to leave the {count} uncommitted change(s) in the project folder or carry them into the worktree; then call again with carry:\"leave\" or carry:\"carry\".")
        }
        "WORKTREE_LARGE_REPO_CONFIRM" => {
            let size = match detail {
                Some(D::WorktreeLargeRepoConfirm { estimate_bytes, .. }) => format_byte_size(*estimate_bytes),
                _ => String::new(),
            };
            format!(
                "Tell the user the worktree needs about {} and ask to confirm; only on yes call again with confirm_large:true{}.",
                if size.is_empty() { "a lot of disk space".to_owned() } else { size },
                if raw { " (same command)" } else { "" }
            )
        }
        "WORKTREE_REVISION_CONFLICT" => "The workspace changed meanwhile; call again (the workspace is read afresh).".to_owned(),
        "WORKTREE_BUSY_JOBS" => "Nothing was changed; try again once the session and its workers are idle.".to_owned(),
        "WORKTREE_DEFAULT_BRANCH" => "Nothing was created. Work on a new branch instead (worktree_action:\"enter\" with branch and create:true), or ask the user to check the default branch out in the project folder.".to_owned(),
        "MERGE_CONFLICT" => "Nothing was merged or forced. Resolve the conflict in the worktree (merge the target branch into it there), or ask the user.".to_owned(),
        "WORKTREE_DIRTY" | "WORKTREE_UNMERGED" => "Nothing was removed. Commit or merge the work first; force only when the user explicitly asks to discard it.".to_owned(),
        _ => return None,
    })
}

/// A coded worktree failure as the tool's JSON: `{ok:false, code, error, details?, next?}`;
/// `None` for any other failure (those are plain text).
pub fn failure_json(failure: &ScmFailure, raw: bool) -> Option<Value> {
    let ScmFailure::Coded { code, detail, .. } = failure else {
        return None;
    };
    let detail = detail.as_deref();
    let mut out = json!({ "ok": false, "code": code, "error": failure_text(code, detail) });
    if let Some(detail) = detail {
        if let Ok(Value::Object(mut fields)) = serde_json::to_value(detail) {
            fields.remove("type");
            if !fields.is_empty() {
                out["details"] = Value::Object(fields);
            }
        }
    }
    if let Some(next) = next_step(code, detail, raw) {
        out["next"] = json!(next);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::errors;

    #[test]
    fn a_dirty_removal_reads_as_the_desktop_text_with_its_next_step() {
        let failure = errors::dirty(Some("w".into()), None, Some(3), None);
        let out = failure_json(&failure, false).unwrap();
        assert_eq!(out["error"], "The worktree has uncommitted changes.");
        assert_eq!(out["details"]["count"], 3);
        assert!(out["next"].as_str().unwrap().starts_with("Nothing was removed."));
    }

    #[test]
    fn busy_reasons_use_the_shared_text_and_sizes_read_like_the_desktop() {
        let failure = errors::busy(errors::RefusalReason::FolderShellJobs);
        assert_eq!(
            failure_json(&failure, false).unwrap()["error"],
            "Background commands still use an affected folder. Wait for them or stop them first."
        );
        assert_eq!(format_byte_size(1536), "1.5 KB");
        assert_eq!(format_byte_size(20 * 1024 * 1024), "20 MB");
    }
}
