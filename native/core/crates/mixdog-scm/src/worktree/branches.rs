//! The project folder's branches: who holds each, the coordinated checkout, the merge of a
//! worktree or any branch into the folder's branch, and the one guarded path of every merge,
//! folder cleanup and branch deletion (`manage_project_branch`).
//!
//! The session layer supplies admission (which sessions and workers use an affected folder)
//! through [`FolderAdmission`]; this module owns the git and ref validation.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::locks::path_key;
use crate::worktree::errors;
use crate::worktree::manager::GitWorktree;
use crate::worktree::manager::RepoFacts;
use crate::worktree::manager::Worktrees;
use crate::worktree::manager::entry_json;
use crate::worktree::merge::parse_status_paths;
use crate::worktree::ownership::pid_alive_or_unknown;

/// What admitting the affected folders produced: the sessions that retain them. Dropping it
/// ends the admission.
pub struct Admitted {
    pub retained_session_ids: Vec<String>,
    pub hold: Option<Box<dyn Send>>,
}

/// Admission of a folder-changing action: refuses while a session turn, worker or background
/// shell uses an affected folder (`WORKTREE_BUSY_JOBS`).
#[async_trait]
pub trait FolderAdmission: Send + Sync {
    async fn admit(&self, folders: &[PathBuf], removing: bool) -> Result<Admitted, ScmFailure>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckoutRequest {
    pub project_path: PathBuf,
    pub branch: Option<String>,
    pub create: bool,
    pub remote: bool,
    pub start_point: Option<String>,
    pub detach: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProjectBranchState {
    pub branch: String,
    pub commit: String,
    pub target: Option<String>,
    pub target_commit: Option<String>,
    pub path: Option<String>,
    pub worktree_id: Option<String>,
    /// `project`, `managed`, `external` or `free`.
    pub kind: &'static str,
}

impl ProjectBranchState {
    pub fn to_json(&self) -> Value {
        json!({
            "branch": self.branch,
            "commit": self.commit,
            "target": self.target,
            "targetCommit": self.target_commit,
            "path": self.path,
            "worktreeId": self.worktree_id,
            "kind": self.kind,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ManageRequest {
    pub project_path: PathBuf,
    pub branch: String,
    /// `merge`, `remove-worktree` or `delete-branch`.
    pub action: String,
    pub commit: String,
    pub target: Option<String>,
    pub target_commit: Option<String>,
    pub confirmed: bool,
    pub force: bool,
}

fn same(left: &str, right: &str) -> bool {
    path_key(Path::new(left)) == path_key(Path::new(right))
}

impl Worktrees {
    pub async fn valid_branch_name(&self, cwd: &Path, branch: &str, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        if branch.trim().is_empty() || branch.starts_with('-') {
            return Ok(false);
        }
        self.scm().git.succeeds(cancel, cwd, &["check-ref-format", "--branch", branch]).await
    }

    async fn local_branch_commits(&self, cwd: &Path, cancel: &CancellationToken) -> Result<Vec<(String, String)>, ScmFailure> {
        let text = self
            .scm()
            .git
            .run(cancel, cwd, &["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads/"])
            .await?;
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| match line.split_once('\t') {
                Some((name, at)) => (name.to_owned(), at.to_owned()),
                None => (line.to_owned(), String::new()),
            })
            .collect())
    }

    /// Local branches of the project and who holds each.
    pub async fn branch_occupancy(
        &self,
        project: &Path,
        session_id: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let facts = self.inspect_repo(project, cancel).await?;
        let commits = self.local_branch_commits(&facts.project_path, cancel).await?;
        let worktrees = self.list_git_worktrees(&facts.project_path, cancel).await?;
        let common = facts.common_dir.to_string_lossy().into_owned();
        let managed: Vec<_> = self
            .all_records(cancel)
            .await?
            .into_iter()
            .filter(|r| same(&r.repo_common_dir, &common))
            .collect();
        let top = facts.top_level.to_string_lossy().into_owned();
        let occupancy: Vec<Value> = commits
            .iter()
            .map(|(branch, _)| {
                // A prunable registration (its folder is gone) holds nothing.
                let Some(holder) = worktrees.iter().find(|w| w.branch.as_deref() == Some(branch) && !w.prunable) else {
                    return json!({ "branch": branch, "kind": "free" });
                };
                if same(&holder.path, &top) {
                    return json!({ "branch": branch, "kind": "current", "path": holder.path });
                }
                match managed.iter().find(|r| same(&r.path, &holder.path)).and_then(|r| r.owner_session_id.clone()) {
                    Some(owner) => json!({ "branch": branch, "kind": "session", "sessionId": owner, "path": holder.path }),
                    None => json!({ "branch": branch, "kind": "external", "path": holder.path }),
                }
            })
            .collect();
        let committed_at: serde_json::Map<String, Value> = commits
            .iter()
            .filter(|(_, at)| !at.is_empty())
            .map(|(name, at)| (name.clone(), json!(at)))
            .collect();
        let retained = session_id
            .and_then(|id| managed.iter().find(|r| r.owner_session_id.as_deref() == Some(id) && r.state == "ready"));
        Ok(json!({
            "branches": commits.iter().map(|(name, _)| name).collect::<Vec<_>>(),
            "occupancy": occupancy,
            "committedAt": committed_at,
            "retainedWorktree": retained.map(entry_json),
        }))
    }

    /// The full id of the commit an object id (4–64 hex) names. Object names only
    /// (`--disambiguate`): a branch or tag spelled like a hex id never shadows the commit.
    async fn commit_by_id(&self, cwd: &Path, value: &str, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let id = value.trim();
        if id.len() < 4 || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ScmFailure::invalid("commit", "a commit id"));
        }
        let git = &self.scm().git;
        let listed = git
            .outcome(cancel, cwd, &["rev-parse", &format!("--disambiguate={id}")], &RunOptions::default())
            .await?;
        let mut commits: Vec<String> = Vec::new();
        for candidate in listed.stdout_text().split_whitespace() {
            let peeled = git
                .outcome(cancel, cwd, &["rev-parse", "--verify", "--quiet", &format!("{candidate}^{{commit}}")], &RunOptions::default())
                .await?;
            let found = peeled.stdout_text().lines().next().unwrap_or("").trim().to_owned();
            if peeled.success() && !commits.contains(&found) {
                commits.push(found);
            }
        }
        match commits.len() {
            1 => Ok(commits.remove(0)),
            0 => Err(ScmFailure::invalid("commit", format!("an existing commit, not {id}"))),
            _ => Err(ScmFailure::invalid("commit", format!("an unambiguous commit, {id} is ambiguous"))),
        }
    }

    /// A git command whose failure reads as Node's `gitFailure` (`git <args> failed (exit N): <diagnostic>`,
    /// code `GIT_FAILED`) rather than git's bare stderr.
    async fn checked_git(&self, cancel: &CancellationToken, cwd: &Path, args: &[&str]) -> Result<String, ScmFailure> {
        let out = self.scm().git.outcome(cancel, cwd, args, &RunOptions::default()).await?;
        if out.success() {
            return Ok(out.stdout_text().to_string());
        }
        let stderr = out.stderr_text().trim().to_owned();
        let stdout = out.stdout_text().trim().to_owned();
        let detail = if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { "no diagnostic".to_owned() };
        let code = out.code.map_or("null".to_owned(), |code| code.to_string());
        Err(ScmFailure::refused("GIT_FAILED", format!("git {} failed (exit {code}): {detail}", args.join(" "))))
    }

    /// `WORKTREE_DIRTY` (`project-dirty`) while the project folder has uncommitted tracked
    /// changes. Nothing is carried: `git switch` keeps compatible uncommitted changes, which
    /// would silently move them onto the other commit.
    async fn assert_project_folder_clean(&self, facts: &RepoFacts, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let status = self
            .scm()
            .git
            .read(cancel, &facts.top_level, &["status", "--porcelain=v1", "-z", "--untracked-files=no"])
            .await?;
        let dirty = parse_status_paths(&status);
        if dirty.is_empty() { Ok(()) } else { Err(errors::project_dirty(dirty)) }
    }

    async fn detach_project_folder(&self, project: &Path, commit_id: &str, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let facts = self.inspect_repo(project, cancel).await?;
        let repo = self.scm().open(&facts.project_path, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let commit = self.commit_by_id(&facts.project_path, commit_id, cancel).await?;
        let head = self.scm().git.run(cancel, &facts.project_path, &["rev-parse", "HEAD"]).await?.trim().to_owned();
        if head == commit && self.scm().checked_out_branch(cancel, &facts.project_path).await?.is_none() {
            return Ok(json!({ "branch": null, "changed": false, "commit": commit, "detached": true }));
        }
        self.assert_project_folder_clean(&facts, cancel).await?;
        self.checked_git(cancel, &facts.project_path, &["switch", "--detach", &commit]).await?;
        repo.touched();
        Ok(json!({ "branch": null, "changed": true, "commit": commit, "detached": true }))
    }

    async fn find_by_path(&self, path: &str, cancel: &CancellationToken) -> Result<Option<crate::worktree::registry::WorktreeRecord>, ScmFailure> {
        Ok(self.all_records(cancel).await?.into_iter().find(|r| same(&r.path, path)))
    }

    /// Coordinated checkout in the project folder. A branch checked out in any other worktree
    /// is `WORKTREE_BRANCH_OCCUPIED`, a folder with uncommitted tracked changes is
    /// `WORKTREE_DIRTY` (`project-dirty`): nothing is carried to the other branch. `remote`
    /// checks out the local branch of a remote-tracking `origin/x` (created to track it);
    /// `start_point` (with `create`) starts the new branch at that commit; `detach` (alone)
    /// checks that commit out detached.
    pub async fn checkout_project_branch(&self, request: CheckoutRequest, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        if let Some(detach) = &request.detach {
            if request.branch.is_some() || request.create || request.remote || request.start_point.is_some() {
                return Err(ScmFailure::invalid("detach", "alone, without branch, create, remote or startPoint"));
            }
            return self.detach_project_folder(&request.project_path, detach, cancel).await;
        }
        let requested = request
            .branch
            .clone()
            .filter(|b| !b.trim().is_empty())
            .ok_or_else(|| ScmFailure::invalid("branch", "a branch name"))?;
        if request.create && request.remote {
            return Err(ScmFailure::invalid("create", "exclusive with remote"));
        }
        if request.start_point.as_deref().is_some_and(|s| s.trim().is_empty()) || (request.start_point.is_some() && !request.create) {
            return Err(ScmFailure::invalid("startPoint", "a commit, with create"));
        }
        let facts = self.inspect_repo(&request.project_path, cancel).await?;
        let repo = self.scm().open(&facts.project_path, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let cwd = facts.project_path.clone();
        let git = &self.scm().git;
        let start = match &request.start_point {
            Some(point) => Some(self.commit_by_id(&cwd, point, cancel).await?),
            None => None,
        };
        let mut branch = requested.clone();
        let mut tracking: Option<String> = None;
        if request.remote {
            let tip = git
                .outcome(cancel, &cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{requested}^{{commit}}")], &RunOptions::default())
                .await?;
            if !tip.success() {
                return Err(ScmFailure::invalid("branch", format!("an existing remote branch, not {requested}")));
            }
            branch = requested.split_once('/').map_or(requested.clone(), |(_, rest)| rest.to_owned());
            if self.branch_commit(&cwd, &branch, cancel).await?.is_none() {
                tracking = Some(requested.clone());
            }
        }
        if !self.valid_branch_name(&cwd, &branch, cancel).await? {
            return Err(ScmFailure::invalid("branch", format!("a valid branch name, not {branch}")));
        }
        let current = self.scm().checked_out_branch(cancel, &cwd).await?;
        if current.as_deref() == Some(branch.as_str()) && !request.create {
            return Ok(json!({ "branch": branch, "changed": false, "commit": facts.head }));
        }
        let mut holder: Option<GitWorktree> = self
            .list_git_worktrees(&cwd, cancel)
            .await?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch.as_str()) && !same(&w.path, &facts.top_level.to_string_lossy()));
        // A stale (prunable) unmanaged registration: drop exactly that one and go on.
        if holder.as_ref().is_some_and(|h| h.prunable) {
            let path = holder.as_ref().map(|h| h.path.clone()).unwrap_or_default();
            if self.find_by_path(&path, cancel).await?.is_none() {
                git.outcome(cancel, &cwd, &["worktree", "prune"], &RunOptions::default()).await?;
                holder = None;
            }
        }
        if let Some(holder) = holder {
            let record = self.find_by_path(&holder.path, cancel).await?;
            let owner = record.and_then(|r| r.owner_session_id);
            return Err(errors::branch_occupied(
                branch,
                Some(holder.path),
                Some(if owner.is_some() { "session" } else { "external" }),
                owner,
            ));
        }
        self.assert_project_folder_clean(&facts, cancel).await?;
        let mut args: Vec<&str> = vec!["switch", &branch];
        if request.create {
            args = vec!["switch", "-c", &branch];
            if let Some(start) = &start {
                args.push(start);
            }
        } else if let Some(tracking) = &tracking {
            args = vec!["switch", "-c", &branch, "--track", tracking];
        }
        self.checked_git(cancel, &cwd, &args).await?;
        let head = git.run(cancel, &cwd, &["rev-parse", "HEAD"]).await?.trim().to_owned();
        repo.touched();
        let mut out = json!({ "branch": branch, "changed": true, "commit": head });
        if let Some(tracking) = tracking {
            out["tracking"] = json!(tracking);
        }
        Ok(out)
    }

    /// Merges a worktree's branch into the project folder's checked-out `target`. `project_path`
    /// (when given) is the destination the caller guarded and the user confirmed: a record of
    /// another project folder is `WORKTREE_PROJECT_MISMATCH`.
    pub async fn merge_worktree_into_project(
        &self,
        entry_id: &str,
        target: &str,
        confirmed: bool,
        project_path: Option<&Path>,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let missing = || errors::missing(Some(entry_id.to_owned()), None, None);
        let found = self.record(cancel, entry_id).await?.filter(|r| r.state == "ready").ok_or_else(missing)?;
        let repo = self.scm().open(Path::new(&found.project_path), cancel).await?;
        let _lock = repo.lock_repository().await?;
        let mut current = self.record(cancel, entry_id).await?.filter(|r| r.state == "ready").ok_or_else(missing)?;
        if let Some(project) = project_path {
            if !same(&current.project_path, &project.to_string_lossy()) {
                return Err(errors::project_mismatch(current.id.clone(), current.project_path.clone(), project.to_string_lossy().into_owned()));
            }
        }
        let source = self.checked_out_branch_of(&current, cancel).await?.ok_or_else(missing)?;
        let result = self
            .scm()
            .merge_branch_into_checkout(cancel, Path::new(&current.project_path), &source, Some(target), confirmed, None)
            .await?;
        if result.merged && current.merge_target.as_deref() != Some(target) {
            current.merge_target = Some(target.to_owned());
            self.put_record(cancel, current).await?;
        }
        repo.touched();
        Ok(result.to_json())
    }

    /// Merges any local branch `source` into the project folder's `target` (the source-control
    /// dock), with the same preflight and `--no-ff` backend as a worktree merge.
    pub async fn merge_branch_into_project(
        &self,
        project: &Path,
        source: &str,
        target: &str,
        confirmed: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let facts = self.inspect_repo(project, cancel).await?;
        let repo = self.scm().open(&facts.project_path, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let result = self
            .scm()
            .merge_branch_into_checkout(cancel, &facts.project_path, source, Some(target), confirmed, None)
            .await?;
        repo.touched();
        Ok(result.to_json())
    }

    async fn inspect_branch(&self, project: &Path, branch: &str, cancel: &CancellationToken) -> Result<(RepoFacts, ProjectBranchState), ScmFailure> {
        let facts = self.inspect_repo(project, cancel).await?;
        if !self.valid_branch_name(&facts.project_path, branch, cancel).await? {
            return Err(ScmFailure::invalid("branch", "a valid local branch name"));
        }
        let commit = self
            .branch_commit(&facts.project_path, branch, cancel)
            .await?
            .ok_or_else(errors::branch_missing)?;
        let holder = self
            .list_git_worktrees(&facts.project_path, cancel)
            .await?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch) && !w.prunable);
        let record = match &holder {
            Some(h) => self.find_by_path(&h.path, cancel).await?,
            None => None,
        };
        let target = facts.current_branch.clone();
        let target_commit = match &target {
            Some(t) => self.branch_commit(&facts.project_path, t, cancel).await?,
            None => None,
        };
        let kind = match &holder {
            Some(h) if same(&h.path, &facts.top_level.to_string_lossy()) => "project",
            Some(_) if record.is_some() => "managed",
            Some(_) => "external",
            None => "free",
        };
        let state = ProjectBranchState {
            branch: branch.to_owned(),
            commit,
            target,
            target_commit,
            path: holder.map(|h| h.path),
            worktree_id: record.map(|r| r.id),
            kind,
        };
        Ok((facts, state))
    }

    pub async fn inspect_project_branch(&self, project: &Path, branch: &str, cancel: &CancellationToken) -> Result<ProjectBranchState, ScmFailure> {
        let facts = self.inspect_repo(project, cancel).await?;
        let repo = self.scm().open(&facts.project_path, cancel).await?;
        let _lock = repo.lock_repository().await?;
        Ok(self.inspect_branch(project, branch, cancel).await?.1)
    }

    /// A merge confirmed by its target branch only (the dock, a session merging its own
    /// checkout): the identities inspected now are the confirmed ones, and the merge then takes
    /// the one guarded path.
    pub async fn merge_confirmed_target(
        &self,
        project: &Path,
        branch: &str,
        target: Option<&str>,
        admission: &dyn FolderAdmission,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        let state = self.inspect_project_branch(project, branch, cancel).await?;
        let Some(current) = state.target.clone() else {
            return Err(errors::unsupported_repo(Some(project.to_string_lossy().into_owned()), None));
        };
        if target.is_some_and(|t| t != current) {
            let message = format!("The project folder is now on \"{current}\"; confirm the merge again.");
            return Err(errors::target_mismatch_text(message, target.map(str::to_owned), Some(current), None, None));
        }
        self.manage_project_branch(
            ManageRequest {
                project_path: project.to_path_buf(),
                branch: branch.to_owned(),
                action: "merge".into(),
                commit: state.commit,
                target: state.target,
                target_commit: state.target_commit,
                confirmed: true,
                force: false,
            },
            admission,
            cancel,
        )
        .await
    }

    /// The one guarded path of every merge, folder cleanup and branch deletion.
    pub async fn manage_project_branch(
        &self,
        request: ManageRequest,
        admission: &dyn FolderAdmission,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        if !request.confirmed {
            return Err(errors::confirm_required());
        }
        if !matches!(request.action.as_str(), "merge" | "remove-worktree" | "delete-branch") {
            // Node throws a plain TypeError here, not an input-shape refusal.
            return Err(ScmFailure::git("Unknown branch action."));
        }
        let removing = request.action == "remove-worktree";
        let (initial_facts, initial) = self.inspect_branch(&request.project_path, &request.branch, cancel).await?;
        let mut folders: Vec<PathBuf> = Vec::new();
        if request.action == "merge" {
            folders.push(initial_facts.top_level.clone());
            folders.extend(initial.path.as_deref().map(PathBuf::from));
        } else if removing {
            folders.extend(initial.path.as_deref().map(PathBuf::from));
        }
        folders.dedup();
        let admitted = admission.admit(&folders, removing).await?;
        let repo = self.scm().open(&initial_facts.project_path, cancel).await?;
        let _lock = repo.lock_repository().await?;
        let (facts, state) = self.inspect_branch(&request.project_path, &request.branch, cancel).await?;
        if state.commit != request.commit
            || state.path != initial.path
            || (!removing && (state.target != request.target || state.target_commit != request.target_commit))
        {
            return Err(errors::branch_revision_conflict());
        }
        let record = match &state.worktree_id {
            Some(id) => self.record(cancel, id).await?,
            None => None,
        };
        if let Some(record) = &record {
            let own = std::process::id();
            let leases = self.leases_of(record, cancel).await?;
            if leases
                .iter()
                .any(|l| pid_alive_or_unknown(l.owner.pid) && (removing || l.owner.pid != Some(own)))
            {
                return Err(errors::busy(errors::RefusalReason::WorkspaceLease));
            }
        }
        let git = &self.scm().git;
        let project = facts.project_path.clone();
        if removing {
            let Some(record) = record.filter(|r| {
                state.kind == "managed" && Path::new(&r.path).exists() && (r.state == "ready" || (r.state == "deleting" && r.extra.get("deleting").and_then(|d| d.get("safeOnly")) == Some(&Value::Bool(true))))
            }) else {
                return Err(errors::path_unsafe(
                    state.worktree_id.clone().unwrap_or_default(),
                    state.path.clone().unwrap_or_default(),
                    Some("Only an unused Mixdog-managed worktree can be removed."),
                ));
            };
            let mut users: Vec<String> = Vec::new();
            for id in record.owner_session_id.iter().chain(record.shared_session_ids.iter()) {
                if admitted.retained_session_ids.contains(id) && !users.contains(id) {
                    users.push(id.clone());
                }
            }
            if !users.is_empty() {
                return Err(errors::retained_by(users));
            }
            // Node's `assertWorktreeRemovable({ entryId })` leaves `sessionId` undefined, which
            // defaults to the owner: only other sessions' references refuse.
            Self::assert_not_shared(&record, record.owner_session_id.as_deref())?;
            self.assert_removable(&record, cancel).await?;
            drop(_lock);
            return self.remove(&record.id, false, None, cancel).await;
        }
        let Some(target) = request.target.clone().filter(|t| *t != request.branch) else {
            return Err(errors::target_mismatch_text("Select a different source branch.".to_owned(), None, None, None, None));
        };
        if request.action == "delete-branch" {
            if state.path.is_some() {
                return Err(errors::branch_checkout_held());
            }
            let common = facts.common_dir.to_string_lossy().into_owned();
            let held = self
                .all_records(cancel)
                .await?
                .into_iter()
                .any(|r| r.branch.as_deref() == Some(request.branch.as_str()) && same(&r.repo_common_dir, &common));
            if held {
                return Err(errors::branch_retained());
            }
            let target_commit = request.target_commit.clone().unwrap_or_default();
            let merged = git
                .outcome(cancel, &project, &["merge-base", "--is-ancestor", &request.commit, &target_commit], &RunOptions::default())
                .await?;
            if merged.success() {
                self.checked_git(cancel, &project, &["branch", "-d", "--", &request.branch]).await?;
                repo.touched();
                return Ok(json!({ "deleted": true, "branch": request.branch }));
            }
            if !request.force {
                return Err(errors::branch_unmerged(request.commit.clone(), &target));
            }
            // Unmerged work the user confirmed dropping: only while the branch is still at the
            // commit the user saw.
            self.force_delete_branch(&project, &request.branch, &request.commit, cancel).await?;
            repo.touched();
            return Ok(json!({ "deleted": true, "branch": request.branch, "forced": true }));
        }
        if let Some(source_path) = &state.path {
            let source = Path::new(source_path);
            let operation = self
                .scm()
                .open(source, cancel)
                .await
                .ok()
                .and_then(|r| crate::repo::operation_in_progress(&r.identity.git_dir));
            let dirty = match &record {
                Some(record) => self.dirty_paths(record, cancel).await?,
                None => self.scm().uncommitted_paths(cancel, source).await?,
            };
            if operation.is_some() || !dirty.is_empty() {
                return Err(errors::merge_source_dirty(
                    operation.map_or("", crate::repo::operation_verb),
                    dirty.len() as u64,
                ));
            }
        }
        let merged = self
            .scm()
            .merge_branch_into_checkout(cancel, &project, &request.branch, Some(&target), true, None)
            .await?;
        // A managed worktree remembers where it was merged (its later removal checks against it).
        if merged.merged {
            if let Some(id) = &state.worktree_id {
                if let Some(mut current) = self.record(cancel, id).await? {
                    if current.merge_target.as_deref() != Some(target.as_str()) {
                        current.merge_target = Some(target.clone());
                        self.put_record(cancel, current).await?;
                    }
                }
            }
        }
        repo.touched();
        Ok(merged.to_json())
    }

    /// Deletes a branch with unmerged work the user confirmed dropping, as `git branch -D`
    /// does, but only while it still is at `expected_head`.
    pub async fn force_delete_branch(&self, cwd: &Path, name: &str, expected_head: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let git = &self.scm().git;
        let checked_out = |rows: Vec<GitWorktree>| rows.iter().any(|w| w.branch.as_deref() == Some(name));
        if checked_out(self.list_git_worktrees(cwd, cancel).await?) {
            return Err(errors::branch_occupied(name.to_owned(), None, None, None));
        }
        let reference = format!("refs/heads/{name}");
        if !git.succeeds(cancel, cwd, &["update-ref", "-d", &reference, expected_head]).await? {
            return Err(errors::revision_conflict(None));
        }
        if checked_out(self.list_git_worktrees(cwd, cancel).await?) {
            // A checkout appeared meanwhile: put the branch back.
            git.outcome(cancel, cwd, &["update-ref", &reference, expected_head, ""], &RunOptions::default()).await?;
            return Err(errors::branch_occupied(name.to_owned(), None, None, None));
        }
        // As `git branch -D` does; a stale section is harmless.
        git.outcome(cancel, cwd, &["config", "--remove-section", &format!("branch.{name}")], &RunOptions::default()).await?;
        Ok(())
    }
}
