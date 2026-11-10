//! The desktop panes' git reads and the CLI probes, as the JSON shapes they already receive.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::inspect::history;
use crate::inspect::status::path_text;
use crate::repo::on_lane;

fn to_value(value: impl Serialize) -> Result<Value, ScmFailure> {
    serde_json::to_value(value).map_err(|error| ScmFailure::git(error.to_string()))
}

const FILE_PATCH_LIMIT: usize = 40_000;
const TEXT_LIMIT: usize = 20_000;
const RECENT_SUBJECTS: usize = 12;

fn clip(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text;
    }
    text.chars().take(limit).collect()
}

impl Scm {
    /// `git/status`: a folder outside any repository answers `repository: false`.
    pub async fn git_status(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.git_status_counting(cwd, cancel, true, false).await
    }

    /// `git/status` with the pane's line-stats hints: `skipLineStats` answers without add/delete counts (`line_stats` false),
    /// `reuseLineStats` keeps the counts of the last read while the listed files stand. The reads are `gitStatus`'s own
    /// (`inspect::status::node_status`), kept per directory as Node keeps them.
    pub async fn git_status_counting(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        line_stats: bool,
        reuse_line_stats: bool,
    ) -> Result<Value, ScmFailure> {
        to_value(crate::inspect::status::node_status(&self.git, self.lane, cancel, cwd, !line_stats, reuse_line_stats).await?)
    }
    pub async fn git_branches(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        to_value(history::branches(&self.git, cancel, cwd).await?)
    }

    pub async fn git_log(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        query: &str,
        skip: u32,
        limit: u32,
    ) -> Result<Value, ScmFailure> {
        // git-history.ts gitLog: [] reads as an empty history for any failure but a deadline, a git that cannot start too.
        match history::log(&self.git, cancel, cwd, query, skip, limit).await {
            Err(ScmFailure::Unavailable { .. }) => to_value(Vec::<crate::inspect::history::GitLogEntry>::new()),
            other => to_value(other?),
        }
    }

    pub async fn git_show(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken, hash: &str) -> Result<Value, ScmFailure> {
        to_value(history::show(&self.git, cancel, cwd, hash).await?)
    }

    pub async fn git_show_diff(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        hash: &str,
        path: &str,
    ) -> Result<Value, ScmFailure> {
        to_value(history::show_diff(&self.git, cancel, cwd, hash, path).await?)
    }

    pub async fn git_show_file(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        rev: &str,
        path: &str,
    ) -> Result<Value, ScmFailure> {
        to_value(history::show_file(&self.git, cancel, cwd, rev, path).await?)
    }

    pub async fn git_diff(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        path: &str,
        staged: bool,
        worktree_only: bool,
        untracked: bool,
    ) -> Result<Value, ScmFailure> {
        // gitDiff asks git for the root (cachedGitRoot) before anything else.
        let root = std::path::PathBuf::from(crate::inspect::status::cached_git_root(&self.git, cancel, cwd).await?);
        to_value(history::diff(&self.git, cancel, &root, path, staged, worktree_only, untracked).await?)
    }

    pub async fn git_stash_list(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        to_value(history::stash_list(&self.git, cancel, cwd).await?)
    }

    /// The read-only snapshot the "PR / commit" request sends to the model. Each read that
    /// fails is empty: the context is raw material, not a verdict.
    pub async fn git_request_context(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        paths: &[String],
        base: &str,
    ) -> Result<Value, ScmFailure> {
        let git = &self.git;
        let attempt = |args: Vec<String>| async move {
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            git.run(cancel, cwd, &refs).await.unwrap_or_default()
        };
        let untracked: std::collections::HashSet<String> = if paths.is_empty() {
            Default::default()
        } else {
            let mut args = vec!["ls-files".to_owned(), "--others".into(), "--exclude-standard".into(), "-z".into(), "--".into()];
            args.extend(paths.iter().cloned());
            attempt(args).await.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect()
        };
        let status_short = attempt(vec!["status".into(), "--short".into(), "--branch".into()]);
        let diff_stat = attempt(vec!["diff".into(), "HEAD".into(), "--stat".into()]);
        let subjects = attempt(vec!["log".into(), format!("-{RECENT_SUBJECTS}"), "--format=%s".into()]);
        let branch_commits = async {
            if base.is_empty() {
                String::new()
            } else {
                attempt(vec!["log".into(), "--oneline".into(), format!("{base}..HEAD")]).await
            }
        };
        let branch_diff_stat = async {
            if base.is_empty() {
                String::new()
            } else {
                attempt(vec!["diff".into(), format!("{base}...HEAD"), "--stat".into()]).await
            }
        };
        let untracked = &untracked;
        let file_patches = futures::future::join_all(paths.iter().map(|path| async move {
            let patch = if untracked.contains(&path.replace('\\', "/")) {
                // `diff --no-index` exits 1 when the files differ: its stdout is the answer.
                git.outcome(
                    cancel,
                    cwd,
                    &["diff", "--no-index", "--", "/dev/null", path],
                    &RunOptions::default(),
                )
                .await
                .map(|out| out.stdout_text())
                .unwrap_or_default()
            } else {
                attempt(vec!["diff".into(), "HEAD".into(), "--".into(), path.clone()]).await
            };
            let truncated = patch.chars().count() > FILE_PATCH_LIMIT;
            json!({
                "path": path,
                "patch": if truncated { patch.chars().take(FILE_PATCH_LIMIT).collect::<String>() } else { patch },
                "truncated": truncated,
            })
        }));
        let (status_short, diff_stat, files, subjects, branch_commits, branch_diff_stat, pr) = tokio::join!(
            status_short,
            diff_stat,
            file_patches,
            subjects,
            branch_commits,
            branch_diff_stat,
            self.current_pull_request(cwd, cancel),
        );
        Ok(json!({
            "statusShort": clip(status_short, TEXT_LIMIT),
            "diffStat": clip(diff_stat, TEXT_LIMIT),
            "files": files,
            "recentSubjects": subjects.lines().filter(|l| !l.is_empty()).collect::<Vec<_>>(),
            "branchCommits": clip(branch_commits, TEXT_LIMIT),
            "branchDiffStat": clip(branch_diff_stat, TEXT_LIMIT),
            "pr": pr,
        }))
    }

    /// `refresh` looks again; otherwise the last probe answers, as Node's `resolveGit`.
    pub async fn git_cli_status(self: &Arc<Self>, cancel: &CancellationToken, refresh: bool) -> Result<Value, ScmFailure> {
        let home = process_dir();
        let known = {
            let mut probes = self.cli_probes.lock().expect("cli probes");
            if refresh {
                probes.git = None;
            }
            probes.git.clone()
        };
        let version = match known {
            Some(version) => version,
            None => {
                let found = match self.git.text(cancel, &home, &["--version"], &RunOptions { bare_env: true, read_limit: true, ..RunOptions::default() }).await {
                    Ok(out) => Some(out.trim().strip_prefix("git version ").unwrap_or("").split_whitespace().next().unwrap_or("").to_owned()),
                    Err(ScmFailure::Unavailable { .. }) => None,
                    Err(other) => return Err(other),
                };
                self.cli_probes.lock().expect("cli probes").git = Some(found.clone());
                found
            }
        };
        Ok(match version {
            None => json!({ "installed": false }),
            Some(version) if version.is_empty() => json!({ "installed": true }),
            Some(version) => json!({ "installed": true, "version": version }),
        })
    }

    /// The global identity and default branch, empty where unset.
    pub async fn git_global_config(self: &Arc<Self>, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let home = process_dir();
        let read = |key: &'static str| {
            let git = self.git.clone();
            let home = home.clone();
            let cancel = cancel.clone();
            async move {
                // Exit 1 is "not set"; a git that cannot run reads as empty here, the save
                // path reports the real error when the user acts.
                git.outcome(&cancel, &home, &["config", "--global", "--get", key], &RunOptions { bare_env: true, ..RunOptions::default() })
                    .await
                    .ok()
                    .filter(|out| out.success())
                    .map(|out| out.stdout_text().trim().to_owned())
                    .unwrap_or_default()
            }
        };
        let (name, email, default_branch) =
            tokio::join!(read("user.name"), read("user.email"), read("init.defaultBranch"));
        Ok(json!({ "name": name, "email": email, "defaultBranch": default_branch }))
    }

    pub async fn git_global_config_write(
        self: &Arc<Self>,
        cancel: &CancellationToken,
        key: &str,
        value: &str,
    ) -> Result<Value, ScmFailure> {
        // The key is one of the three (`input.rs`, Node's `requiredGitGlobalConfigKey`) before this runs.
        let home = process_dir();
        let trimmed = mixdog_js::js_trim(value);
        let outcome = if trimmed.is_empty() {
            self.git.outcome(cancel, &home, &["config", "--global", "--unset", key], &RunOptions { bare_env: true, ..RunOptions::default() }).await?
        } else {
            self.git.outcome(cancel, &home, &["config", "--global", key, trimmed], &RunOptions { bare_env: true, ..RunOptions::default() }).await?
        };
        // Unsetting an already-unset key exits 5 (or 1): that outcome is the requested state.
        let unset_ok = trimmed.is_empty() && matches!(outcome.code, Some(1 | 5));
        if !outcome.success() && !unset_ok {
            return Err(ScmFailure::git(outcome.stderr_text().trim().to_owned()));
        }
        self.git_global_config(cancel).await
    }

    /// Whether the folder is a git repository. A folder that is not one is `Ok(false)`; a probe
    /// that did not run (full lane, cancelled) is an error, never that answer.
    pub async fn is_repository(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        on_lane(self.lane, cancel, {
            let cwd = cwd.to_path_buf();
            move || crate::repo::discover(&cwd).is_ok()
        })
        .await
    }

    /// The work tree root of the repository containing `cwd`.
    pub async fn root_of(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let repo = self.open(cwd, cancel).await?;
        Ok(path_text(repo.root()?))
    }
}

/// The folder Node's dependency probes run in: they pass no `cwd`, so a child inherits the process's own.
pub fn process_dir() -> std::path::PathBuf {
    std::env::current_dir().unwrap_or_else(|_| home_dir())
}

/// The user's home folder, where the sign-in terminal starts.
pub fn home_dir() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}
