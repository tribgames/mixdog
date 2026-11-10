//! Git mutations (DS §5 `scm::mutate`): every one runs the git CLI under the work tree's
//! write lock and marks the cached inspections stale when it ends. The checks that guard a
//! destructive step (clean work tree, no operation in progress, a commit that is really one)
//! live here once, not per front end.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;

use mixdog_core_api::domain::repo::RepoOperation;

use crate::engine::Repo;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::locks::RepoGuard;
use crate::repo::on_lane;
use crate::repo::operation_in_progress;
use crate::repo::operation_verb;

/// The reset the pane asks for a dirty work tree to confirm.
pub const RESET_DIRTY_CODE: &str = "git-reset-dirty-worktree";

/// Holds the work tree's write lock; the repository's cached inspections go stale when it
/// drops, whether the step succeeded or not.
pub struct WriteScope<'a> {
    repo: &'a Repo,
    _guard: RepoGuard,
}

impl Drop for WriteScope<'_> {
    fn drop(&mut self) {
        self.repo.touched();
    }
}

impl Repo {
    pub async fn write_scope(&self) -> Result<WriteScope<'_>, ScmFailure> {
        Ok(WriteScope {
            repo: self,
            _guard: self.lock_work_tree().await?,
        })
    }

    async fn has_head(&self) -> Result<bool, ScmFailure> {
        self.succeeds(&["rev-parse", "--verify", "HEAD"]).await
    }

    pub fn operation(&self) -> Option<RepoOperation> {
        operation_in_progress(&self.identity.git_dir)
    }

    /// Paths with uncommitted changes. This guards a destructive step, so it never trusts a
    /// cached inspection: the work tree may have changed with no evidence delivered yet.
    pub async fn dirty_paths(&self) -> Result<Vec<String>, ScmFailure> {
        self.touched();
        // `gitStatus(cwd)`: Node's own read of the directory the call was given (git-branches.ts assertCleanWorktree).
        let status = crate::inspect::status::node_status(&self.scm.git, self.scm.lane, &self.cancel, &self.cwd, false, false).await?;
        if !status.repository {
            // git-branches.ts:92: Node reads "no repository" as an empty list.
            return Ok(Vec::new());
        }
        Ok(status.files.iter().map(|file| file.path.clone()).collect())
    }

    async fn assert_no_operation(&self, action: &str) -> Result<(), ScmFailure> {
        if let Some(operation) = self.operation() {
            return Err(ScmFailure::refused(
                "OPERATION_IN_PROGRESS",
                format!(
                    "A {} is already in progress. Continue or abort it before {action}.",
                    operation_verb(operation)
                ),
            ));
        }
        Ok(())
    }

    async fn assert_clean(&self, action: &str) -> Result<(), ScmFailure> {
        let dirty = self.dirty_paths().await?;
        if dirty.is_empty() {
            return Ok(());
        }
        Err(ScmFailure::refused(
            "DIRTY_WORKTREE",
            format!(
                "Uncommitted changes would be overwritten by {action}: {}. Commit or stash them first.",
                dirty.iter().take(10).cloned().collect::<Vec<_>>().join(", ")
            ),
        ))
    }

    async fn conflicted_paths(&self) -> Vec<String> {
        self.run(&["diff", "--name-only", "--diff-filter=U"])
            .await
            .map(|names| {
                names
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn stage(&self, paths: &[String]) -> Result<(), ScmFailure> {
        if paths.is_empty() {
            return Ok(());
        }
        let _scope = self.write_scope().await?;
        let mut args = vec!["add", "-A", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.run(&args).await.map(drop)
    }

    pub async fn unstage(&self, paths: &[String]) -> Result<(), ScmFailure> {
        if paths.is_empty() {
            return Ok(());
        }
        let _scope = self.write_scope().await?;
        let with_head = self.has_head().await?;
        let mut args = if with_head { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-r", "--ignore-unmatch", "--"] };
        args.extend(paths.iter().map(String::as_str));
        match self.run(&args).await {
            // git-mutations.ts:75-79: a git without `restore` falls back to `reset HEAD`.
            Err(_) if with_head => {
                let mut reset = vec!["reset", "HEAD", "--"];
                reset.extend(paths.iter().map(String::as_str));
                self.run(&reset).await.map(drop)
            }
            other => other.map(drop),
        }
    }

    pub async fn apply_patch(&self, path: &str, patch: &str, reverse: bool) -> Result<(), ScmFailure> {
        if patch.trim().is_empty() {
            return Err(ScmFailure::invalid("patch", "a Git patch"));
        }
        let _scope = self.write_scope().await?;
        let include = format!("--include={path}");
        let mut args = vec!["apply", "--cached", "--recount", "--whitespace=nowarn"];
        if reverse {
            args.push("--reverse");
        }
        args.extend([include.as_str(), "-"]);
        let options = RunOptions {
            input: Some(patch.as_bytes().to_vec()),
            ..RunOptions::default()
        };
        self.scm
            .git
            .text(&self.cancel, self.root()?, &args, &options)
            .await
            .map(drop)
    }

    pub async fn ignore(&self, path: &str, scope: &str) -> Result<(), ScmFailure> {
        let by_extension = match scope {
            "file" => false,
            "extension" => true,
            _ => return Err(ScmFailure::invalid("scope", "`file` or `extension`")),
        };
        let normalized = path.replace('\\', "/");
        let normalized = normalized.trim_start_matches('/');
        if normalized.is_empty() || normalized.contains('\0') || normalized.split('/').any(|part| part == "..") {
            return Err(ScmFailure::invalid("path", "a path inside the repository"));
        }
        let pattern = if by_extension {
            let name = normalized.rsplit('/').next().unwrap_or("");
            match name.rfind('.') {
                Some(dot) if dot > 0 && dot + 1 < name.len() => {
                    format!("*{}", escape_ignore_literal(&name[dot..]))
                }
                _ => return Err(ScmFailure::invalid("path", "a file with an extension")),
            }
        } else {
            format!("/{}", escape_ignore_literal(normalized))
        };
        let _scope = self.write_scope().await?;
        // gitIgnore asks git for the repository root each time (git-mutations.ts): the file goes where it names, else beside `cwd`.
        let top = self.run(&["rev-parse", "--show-toplevel"]).await?;
        let ignore_path = if top.trim().is_empty() { self.cwd.join(".gitignore") } else { std::path::PathBuf::from(top.trim()).join(".gitignore") };
        on_lane(self.scm.lane, &self.cancel, move || append_ignore(&ignore_path, &pattern)).await?
    }

    pub async fn commit(&self, message: &str) -> Result<String, ScmFailure> {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err(ScmFailure::invalid("message", "a commit message"));
        }
        let _scope = self.write_scope().await?;
        self.run(&["commit", "-m", trimmed]).await
    }

    pub async fn amend(&self, message: &str) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        let trimmed = message.trim();
        if trimmed.is_empty() {
            self.run(&["commit", "--amend", "--no-edit"]).await
        } else {
            self.run(&["commit", "--amend", "-m", trimmed]).await
        }
    }

    pub async fn undo_last_commit(&self) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        self.run(&["reset", "--soft", "HEAD~1"]).await
    }

    pub async fn stash(&self, message: &str) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        let trimmed = message.trim();
        let mut args = vec!["stash", "push", "-u"];
        if !trimmed.is_empty() {
            args.extend(["-m", trimmed]);
        }
        self.run(&args).await
    }

    pub async fn stash_pop(&self) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        self.run(&["stash", "pop"]).await
    }

    pub async fn stash_apply(&self, reference: &str) -> Result<String, ScmFailure> {
        let reference = stash_ref(reference)?;
        let _scope = self.write_scope().await?;
        self.run(&["stash", "apply", &reference]).await
    }

    pub async fn stash_drop(&self, reference: &str) -> Result<String, ScmFailure> {
        let reference = stash_ref(reference)?;
        let _scope = self.write_scope().await?;
        self.run(&["stash", "drop", &reference]).await
    }

    pub async fn revert_file(&self, path: &str, untracked: bool, mode: &str) -> Result<(), ScmFailure> {
        let whole = match mode {
            "all" => true,
            "worktree" => false,
            _ => return Err(ScmFailure::invalid("mode", "`all` or `worktree`")),
        };
        let _scope = self.write_scope().await?;
        if untracked {
            return self.run(&["clean", "-f", "-d", "--", path]).await.map(drop);
        }
        if !whole {
            // git-mutations.ts:195-200: a git without `restore` falls back to `checkout --`.
            return match self.run(&["restore", "--worktree", "--", path]).await {
                Err(_) => self.run(&["checkout", "--", path]).await.map(drop),
                other => other.map(drop),
            };
        }
        if self.has_head().await? {
            return self
                .run(&["restore", "--source=HEAD", "--staged", "--worktree", "--", path])
                .await
                .map(drop);
        }
        self.run(&["rm", "--cached", "-r", "--ignore-unmatch", "--", path]).await?;
        self.run(&["clean", "-f", "-d", "--", path]).await.map(drop)
    }

    pub async fn push(&self) -> Result<String, ScmFailure> {
        let has_upstream = self
            .succeeds(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .await?;
        if has_upstream {
            self.run(&["push"]).await
        } else {
            self.run(&["push", "-u", "origin", "HEAD"]).await
        }
    }

    async fn remote(&self, args: &[&str]) -> Result<String, ScmFailure> {
        self.scm.git.remote(&self.cancel, self.root()?, args).await
    }

    pub async fn fetch(&self) -> Result<String, ScmFailure> {
        self.remote(&["fetch", "--prune"]).await
    }

    pub async fn pull(&self) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        self.remote(&["pull", "--no-rebase", "--no-edit"]).await
    }

    pub async fn sync(&self) -> Result<String, ScmFailure> {
        let pulled = self.pull().await?;
        let pushed = self.push().await.map_err(crate::git::readable_remote_error)?;
        Ok([pulled, pushed]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// `continue` / `abort` of the operation in progress, by git's own subcommand name.
    pub async fn finish_operation(&self, flag: &str, verb: &str) -> Result<String, ScmFailure> {
        let operation = self.operation().ok_or_else(|| {
            ScmFailure::refused("NO_OPERATION", format!("There is no Git operation to {verb}."))
        })?;
        let _scope = self.write_scope().await?;
        self.run(&[operation_verb(operation), flag]).await
    }

    pub async fn continue_operation(&self) -> Result<String, ScmFailure> {
        self.finish_operation("--continue", "continue").await
    }

    pub async fn abort_operation(&self) -> Result<String, ScmFailure> {
        self.finish_operation("--abort", "abort").await
    }

    /// A user-supplied commit name resolved to exactly one commit id.
    pub async fn checked_commit(&self, value: &str) -> Result<String, ScmFailure> {
        let hash = value.trim();
        if hash.len() < 4 || hash.len() > 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ScmFailure::invalid("hash", "a commit hash"));
        }
        let shadow = self
            .run(&["rev-parse", "--verify", "--quiet", "--symbolic-full-name", hash])
            .await
            .unwrap_or_default();
        if shadow.trim().is_empty() {
            let peeled = format!("{hash}^{{commit}}");
            if let Ok(resolved) = self.run(&["rev-parse", "--verify", "--quiet", &peeled]).await {
                if !resolved.trim().is_empty() {
                    return Ok(resolved.trim().to_owned());
                }
            }
        }
        let disambiguate = format!("--disambiguate={hash}");
        let candidates = self.run(&["rev-parse", &disambiguate]).await.unwrap_or_default();
        let mut commits: Vec<String> = Vec::new();
        for candidate in candidates.split_whitespace() {
            let peeled = format!("{candidate}^{{commit}}");
            if let Ok(found) = self.run(&["rev-parse", "--verify", "--quiet", &peeled]).await {
                let found = found.trim().to_owned();
                if !found.is_empty() && !commits.contains(&found) {
                    commits.push(found);
                }
            }
        }
        match commits.len() {
            1 => Ok(commits.remove(0)),
            0 => Err(ScmFailure::refused(
                "COMMIT_NOT_FOUND",
                format!("No commit named {hash} in this repository."),
            )),
            _ => Err(ScmFailure::refused(
                "COMMIT_AMBIGUOUS",
                format!(
                    "Commit name {hash} is ambiguous: {}.",
                    commits.iter().map(|sha| &sha[..sha.len().min(12)]).collect::<Vec<_>>().join(", ")
                ),
            )),
        }
    }

    async fn parent_count(&self, commit: &str) -> usize {
        self.run(&["rev-list", "--parents", "-n", "1", commit])
            .await
            .map(|row| row.split_whitespace().count().saturating_sub(1))
            .unwrap_or(0)
    }

    pub async fn reset_to_commit(
        &self,
        value: &str,
        mode: &str,
        confirmed_dirty: bool,
    ) -> Result<String, ScmFailure> {
        if !matches!(mode, "soft" | "mixed" | "hard") {
            return Err(ScmFailure::invalid("mode", "`soft`, `mixed` or `hard`"));
        }
        let _scope = self.write_scope().await?;
        let commit = self.checked_commit(value).await?;
        let action = format!("resetting to {}", &commit[..commit.len().min(8)]);
        if mode == "hard" {
            self.assert_clean(&action).await?;
        } else if mode == "mixed" && !confirmed_dirty {
            let dirty = self.dirty_paths().await?;
            if !dirty.is_empty() {
                return Err(ScmFailure::refused(
                    RESET_DIRTY_CODE,
                    format!(
                        "A --mixed reset rewrites the index, so {action} unstages uncommitted work: {}. Confirm the reset to run it anyway.",
                        dirty.iter().take(10).cloned().collect::<Vec<_>>().join(", ")
                    ),
                ));
            }
        }
        let flag = format!("--{mode}");
        self.run(&["reset", &flag, &commit]).await
    }

    async fn sequencer_failure(
        &self,
        operation: RepoOperation,
        verb: &str,
        commit: &str,
        failure: ScmFailure,
    ) -> ScmFailure {
        // git-mutations.ts:321 `sequencerFailure`: a diagnostic naming a conflict counts as one even with no operation in progress.
        if !failure.to_string().to_lowercase().contains("conflict") && self.operation() != Some(operation) {
            return failure;
        }
        let files = self.conflicted_paths().await;
        let listed = if files.is_empty() {
            String::new()
        } else {
            format!(
                " in {} file(s): {}",
                files.len(),
                files.iter().take(10).cloned().collect::<Vec<_>>().join(", ")
            )
        };
        ScmFailure::refused(
            "SEQUENCER_CONFLICT",
            format!(
                "{verb} {} hit conflicts{listed}. Resolve them, then continue or abort the {}.",
                &commit[..commit.len().min(8)],
                operation_verb(operation)
            ),
        )
    }

    pub async fn revert_commit(&self, value: &str) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        let commit = self.checked_commit(value).await?;
        let mainline = self.parent_count(&commit).await > 1;
        let mut args = vec!["revert", "--no-edit"];
        if mainline {
            args.extend(["-m", "1"]);
        }
        args.push(&commit);
        match self.run(&args).await {
            Ok(out) => Ok(out),
            Err(failure) => Err(self
                .sequencer_failure(RepoOperation::Revert, "Reverting", &commit, failure)
                .await),
        }
    }

    pub async fn cherry_pick_commit(&self, value: &str) -> Result<String, ScmFailure> {
        let _scope = self.write_scope().await?;
        let commit = self.checked_commit(value).await?;
        let action = format!("cherry-picking {}", &commit[..commit.len().min(8)]);
        self.assert_no_operation(&action).await?;
        self.assert_clean(&action).await?;
        let mainline = self.parent_count(&commit).await > 1;
        let mut args = vec!["cherry-pick", "--empty=keep"];
        if mainline {
            args.extend(["-m", "1"]);
        }
        args.push(&commit);
        // runCherryPick: a git that does not know `--empty=keep` is asked again with the legacy pair.
        let outcome = match self.run(&args).await {
            Err(failure) if {
                let text = failure.to_string().to_lowercase();
                text.contains("unknown option") || text.contains("usage: git cherry-pick")
            } =>
            {
                let mut legacy = vec!["cherry-pick", "--allow-empty", "--keep-redundant-commits"];
                legacy.extend(&args[2..]);
                self.run(&legacy).await
            }
            other => other,
        };
        match outcome {
            Ok(out) => Ok(out),
            Err(failure) => Err(self
                .sequencer_failure(RepoOperation::CherryPick, "Cherry-picking", &commit, failure)
                .await),
        }
    }

    async fn checked_tag(&self, value: &str) -> Result<String, ScmFailure> {
        let tag = value.trim();
        if tag.is_empty() || tag.starts_with('-') || tag.contains('\0') || tag.contains(['\r', '\n']) {
            return Err(ScmFailure::invalid("value", "a Git tag name"));
        }
        let full = format!("refs/tags/{tag}");
        if !self.succeeds(&["check-ref-format", &full]).await? {
            return Err(ScmFailure::invalid("value", "a valid Git tag name"));
        }
        Ok(tag.to_owned())
    }

    pub async fn create_tag(&self, value: &str, at: &str) -> Result<String, ScmFailure> {
        let tag = self.checked_tag(value).await?;
        let _scope = self.write_scope().await?;
        let commit = self.checked_commit(at).await?;
        self.run(&["tag", &tag, &commit]).await?;
        Ok(format!("Created tag {tag} at {}.", &commit[..commit.len().min(8)]))
    }

    pub async fn delete_tag(&self, value: &str) -> Result<String, ScmFailure> {
        let tag = self.checked_tag(value).await?;
        let _scope = self.write_scope().await?;
        self.run(&["tag", "-d", &tag]).await
    }

    async fn checked_branch(&self, value: &str) -> Result<String, ScmFailure> {
        let branch = value.trim();
        if branch.is_empty() {
            return Err(ScmFailure::invalid("branch", "a Git branch name"));
        }
        self.run(&["check-ref-format", "--branch", branch]).await?;
        Ok(branch.to_owned())
    }

    pub async fn rename_branch(&self, value: &str, next: &str) -> Result<String, ScmFailure> {
        let branch = self.checked_branch(value).await?;
        let next = self.checked_branch(next).await?;
        let _scope = self.write_scope().await?;
        self.run(&["branch", "-m", &branch, &next]).await
    }

    pub async fn delete_branch(&self, value: &str) -> Result<String, ScmFailure> {
        let branch = self.checked_branch(value).await?;
        let _scope = self.write_scope().await?;
        self.run(&["branch", "-d", &branch]).await
    }

    /// NUL-separated names `git ls-files` prints for a pathspec list.
    pub async fn ls_files(&self, extra: &[&str]) -> Result<Vec<String>, ScmFailure> {
        let mut args = vec!["ls-files", "-z"];
        args.extend(extra);
        Ok(nul_records(&self.run(&args).await?).map(str::to_owned).collect())
    }
}

fn stash_ref(reference: &str) -> Result<String, ScmFailure> {
    let value = reference.trim();
    let digits = value
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'));
    match digits {
        Some(n) if !n.is_empty() && n.bytes().all(|byte| byte.is_ascii_digit()) => Ok(value.to_owned()),
        _ => Err(ScmFailure::invalid("ref", "a stash reference like stash@{0}")),
    }
}

fn escape_ignore_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn append_ignore(path: &Path, pattern: &str) -> Result<(), ScmFailure> {
    let current = std::fs::read_to_string(path).unwrap_or_default();
    if current.lines().any(|line| line.trim_end_matches('\r') == pattern) {
        return Ok(());
    }
    let separator = if !current.is_empty() && !current.ends_with('\n') { "\n" } else { "" };
    std::fs::write(path, format!("{current}{separator}{pattern}\n"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_refs_are_validated() {
        assert!(stash_ref("stash@{0}").is_ok());
        assert!(stash_ref("stash@{x}").is_err());
        assert!(stash_ref("HEAD").is_err());
    }

    #[test]
    fn ignore_patterns_escape_glob_characters() {
        assert_eq!(escape_ignore_literal("a[1]*.txt"), "a\\[1\\]\\*.txt");
    }
}
