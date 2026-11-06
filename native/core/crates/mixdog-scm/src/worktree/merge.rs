//! Unified merge backend: fold a branch into the branch checked out in a project folder. Shared
//! by the managed worktree merge and the Source Control dock, so both have one semantics:
//! explicit confirmation; the folder on `target` (when given) with no operation in progress and
//! no uncommitted or untracked change; `merge-tree --write-tree` previews the exact commits
//! first and a conflicting merge returns its files without touching the folder; a clean
//! preview merges with `--no-ff --no-edit`, and if that merge still fails (hook, interruption)
//! only the merge this call started is aborted and the failure is raised, never reported as
//! success. The caller holds the repository lock around the whole call.

use std::path::Path;

use mixdog_core_api::domain::repo::RepoOperation;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::repo::operation_in_progress;
use crate::repo::operation_verb;
use crate::worktree::errors;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeResult {
    pub merged: bool,
    pub commit: Option<String>,
    pub target: String,
    pub conflicts: Option<Vec<String>>,
    pub up_to_date: bool,
}

impl MergeResult {
    pub fn to_json(&self) -> serde_json::Value {
        let mut value = serde_json::json!({ "merged": self.merged, "commit": self.commit, "target": self.target });
        if let Some(conflicts) = &self.conflicts {
            value["conflicts"] = serde_json::json!(conflicts);
        }
        if self.up_to_date {
            value["upToDate"] = serde_json::json!(true);
        }
        value
    }
}

/// `(code, path)` of each record of `git status --porcelain=v1 -z` (`!!`: an ignored path);
/// a rename's origin follows its record and is skipped.
pub fn parse_status_entries(text: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut records = nul_records(text);
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let code = &record[..2];
        entries.push((code.to_owned(), record[3..].to_owned()));
        if code.contains('R') || code.contains('C') {
            let _origin = records.next();
        }
    }
    entries
}

/// Changed and untracked paths of a porcelain v1 listing.
pub fn parse_status_paths(text: &str) -> Vec<String> {
    parse_status_entries(text).into_iter().map(|(_, path)| path).collect()
}

impl Scm {
    async fn outcome(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
    ) -> Result<crate::exec::ExecOutput, ScmFailure> {
        self.git.outcome(cancel, cwd, args, &RunOptions::default()).await
    }

    async fn rev_parse(&self, cancel: &CancellationToken, cwd: &Path, rev: &str) -> Result<Option<String>, ScmFailure> {
        let output = self.outcome(cancel, cwd, &["rev-parse", "--verify", "--quiet", rev]).await?;
        Ok(output.success().then(|| output.stdout_text().lines().next().unwrap_or("").trim().to_owned()))
    }

    pub(crate) async fn checked_out_branch(&self, cancel: &CancellationToken, cwd: &Path) -> Result<Option<String>, ScmFailure> {
        let output = self.outcome(cancel, cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
        let name = output.stdout_text().lines().next().unwrap_or("").trim().to_owned();
        Ok((output.success() && !name.is_empty()).then_some(name))
    }

    /// Changed and untracked paths of the folder, for the clean-target checks.
    pub(crate) async fn uncommitted_paths(&self, cancel: &CancellationToken, cwd: &Path) -> Result<Vec<String>, ScmFailure> {
        let args = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];
        let output = self.outcome(cancel, cwd, &args).await?;
        if !output.success() {
            return Err(ScmFailure::git(format!("git status failed: {}", output.stderr_text().trim())));
        }
        Ok(parse_status_paths(&output.stdout_text()))
    }

    pub async fn merge_branch_into_checkout(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        source: &str,
        target: Option<&str>,
        confirmed: bool,
        message: Option<&str>,
    ) -> Result<MergeResult, ScmFailure> {
        if !confirmed {
            return Err(errors::confirm_required());
        }
        let source_name = source.trim();
        if source_name.is_empty() || source_name.starts_with('-') {
            return Err(errors::merge_failed("source-invalid", None, None));
        }
        let current = self.checked_out_branch(cancel, cwd).await?;
        if let Some(target) = target {
            if Some(target) != current.as_deref() {
                let message = format!(
                    "The project folder is on {}, not {target}; reload and try again.",
                    current.as_deref().unwrap_or("a detached HEAD")
                );
                return Err(errors::target_mismatch_text(message, None, None, Some(target.to_owned()), current.clone()));
            }
        }
        let Some(current) = current else {
            return Err(errors::merge_failed("detached-head", None, None));
        };
        let git_dir = crate::repo::discover(cwd)?.git_dir;
        if let Some(operation) = operation_in_progress(&git_dir) {
            return Err(errors::merge_target_dirty(operation_verb(operation), Vec::new(), None));
        }
        let dirty = self.uncommitted_paths(cancel, cwd).await?;
        if !dirty.is_empty() {
            return Err(errors::merge_target_dirty(
                "",
                dirty.iter().take(50).cloned().collect(),
                Some(dirty.len() as u64),
            ));
        }
        let Some(head) = self.rev_parse(cancel, cwd, "HEAD^{commit}").await? else {
            return Err(errors::merge_failed("target-empty", None, None));
        };
        let peeled = format!("{source_name}^{{commit}}");
        let Some(source_commit) = self.rev_parse(cancel, cwd, &peeled).await? else {
            return Err(errors::merge_failed("source-missing", Some(source_name.to_owned()), None));
        };
        if self
            .outcome(cancel, cwd, &["merge-base", "--is-ancestor", &source_commit, &head])
            .await?
            .success()
        {
            return Ok(MergeResult {
                merged: true,
                commit: Some(head),
                target: current,
                conflicts: None,
                up_to_date: true,
            });
        }
        let preview = self
            .outcome(
                cancel,
                cwd,
                &["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", &head, &source_commit],
            )
            .await?;
        if preview.code == Some(1) {
            let mut conflicts: Vec<String> = Vec::new();
            for path in preview.stdout_text().split('\0').skip(1).filter(|p| !p.is_empty()) {
                if !conflicts.iter().any(|known| known == path) {
                    conflicts.push(path.to_owned());
                }
            }
            return Ok(MergeResult {
                merged: false,
                commit: None,
                target: current,
                conflicts: Some(conflicts),
                up_to_date: false,
            });
        }
        if !preview.success() {
            return Err(ScmFailure::git(format!(
                "git merge-tree failed (exit {}): {}",
                preview.code.unwrap_or(-1),
                preview.stderr_text().trim()
            )));
        }
        // Nothing Mixdog runs can move the folder while the caller holds the repository lock;
        // an outside process still could, so verify again.
        if self.rev_parse(cancel, cwd, "HEAD^{commit}").await?.as_deref() != Some(head.as_str())
            || self.checked_out_branch(cancel, cwd).await?.as_deref() != Some(current.as_str())
        {
            let message = "The project folder changed during the merge; try again.".to_owned();
            return Err(errors::target_mismatch_text(message, None, None, Some(current), None));
        }
        let default_message = format!("Merge branch '{source_name}' into {current}");
        let merge_message = message.unwrap_or(&default_message);
        let merged = self
            .outcome(
                cancel,
                cwd,
                &["merge", "--no-ff", "--no-edit", "-m", merge_message, &source_commit],
            )
            .await?;
        if !merged.success() {
            // No operation was in progress before this call, so a MERGE_HEAD now is the merge
            // this call started.
            let started = operation_in_progress(&git_dir) == Some(RepoOperation::Merge);
            let aborted = started
                && self
                    .outcome(cancel, cwd, &["merge", "--abort"])
                    .await?
                    .success();
            return Err(errors::merge_failed("merge-failed", None, Some(aborted)));
        }
        let commit = self.rev_parse(cancel, cwd, "HEAD^{commit}").await?;
        let second_parent = self.rev_parse(cancel, cwd, "HEAD^2").await?;
        if commit.is_none() || commit.as_deref() == Some(head.as_str()) || second_parent.as_deref() != Some(source_commit.as_str()) {
            return Err(errors::merge_failed("unexpected-head", None, None));
        }
        Ok(MergeResult {
            merged: true,
            commit,
            target: current,
            conflicts: None,
            up_to_date: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_paths_skip_a_renames_origin() {
        let paths = parse_status_paths(" M a.txt\0R  new.txt\0old.txt\0?? b.txt\0");
        assert_eq!(paths, ["a.txt", "new.txt", "b.txt"]);
    }
}
