//! The managed-worktree backend operations the transitions use (Node's `manager.mjs` calls),
//! over `mixdog-scm`'s [`Worktrees`]: the session's retained worktree, lookups by folder,
//! creation with its pre-checks, branch resolution, ownership and the removal guard.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_protocol::DomainErrorDetail;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::locks::path_key;
use mixdog_scm::repo::on_lane;
use mixdog_scm::repo::operation_in_progress;
use mixdog_scm::worktree::errors;
use mixdog_scm::worktree::manager::CreateRequest;
use mixdog_scm::worktree::manager::RepoFacts;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_scm::worktree::measure::DIRTY_CHOICE_PREVIEW;
use mixdog_scm::worktree::merge::parse_status_paths;
use mixdog_scm::worktree::names;
use mixdog_scm::worktree::ownership::Owner;
use mixdog_scm::worktree::registry::WorktreeRecord;
use mixdog_scm::worktree::settings::SettingsSource;
use serde_json::Value;

use super::worktree_state::is_within;
use super::worktree_state::plain;
use super::worktree_state::same_path;

pub(super) struct Ops {
    pub wt: Arc<Worktrees>,
    pub settings: Arc<dyn SettingsSource>,
    pub runtime_token: String,
}

/// A worktree made (or found again) for a session.
pub(super) struct Created {
    pub record: WorktreeRecord,
    /// What happened to the project folder's uncommitted changes: `(mode, count)`.
    pub changes: Option<(&'static str, u64)>,
}

/// A branch resolved to its checkout.
pub(super) struct Resolved {
    pub path: String,
    pub entry: Option<WorktreeRecord>,
    pub reference_added: bool,
    pub repo_common_dir: String,
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or("").trim().to_owned()
}

impl Ops {
    pub fn owner(&self, session_id: &str) -> Owner {
        Owner { session_id: session_id.to_owned(), runtime_token: self.runtime_token.clone(), pid: Some(std::process::id()) }
    }

    /// Blocking disk work as a maintenance-lane job.
    pub async fn on_disk<R: Send + 'static>(
        &self,
        cancel: &CancellationToken,
        job: impl FnOnce() -> R + Send + 'static,
    ) -> Result<R, ScmFailure> {
        on_lane(self.wt.scm().lane, cancel, job).await
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job body")]
    pub async fn exists(&self, path: &str, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        let path = PathBuf::from(path);
        self.on_disk(cancel, move || path.exists()).await
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job body")]
    pub async fn make_dir(&self, path: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let path = PathBuf::from(path);
        self.on_disk(cancel, move || std::fs::create_dir_all(path)).await??;
        Ok(())
    }

    pub async fn inspect(&self, project: &str, cancel: &CancellationToken) -> Result<RepoFacts, ScmFailure> {
        self.wt.inspect_repo(Path::new(project), cancel).await
    }

    pub async fn records(&self, cancel: &CancellationToken) -> Result<Vec<WorktreeRecord>, ScmFailure> {
        let registry = self.wt.registry().clone();
        Ok(self.on_disk(cancel, move || registry.read()).await??.into_values().collect())
    }

    /// The checkout's own branch (a `git branch -m` or switch inside it) in place of the recorded.
    async fn with_branch(&self, mut record: WorktreeRecord, cancel: &CancellationToken) -> Result<WorktreeRecord, ScmFailure> {
        if record.branch.is_some() && record.state == "ready" && record.extra.get("kind").is_none() {
            record.branch = self.wt.checked_out_branch_of(&record, cancel).await?;
        }
        Ok(record)
    }

    /// The worktree retained by `session` (ready first).
    pub async fn session_worktree(&self, session: &str, cancel: &CancellationToken) -> Result<Option<WorktreeRecord>, ScmFailure> {
        if session.is_empty() {
            return Ok(None);
        }
        let owned: Vec<WorktreeRecord> =
            self.records(cancel).await?.into_iter().filter(|r| r.owner_session_id.as_deref() == Some(session)).collect();
        let found = owned.iter().find(|r| r.state == "ready").or(owned.first()).cloned();
        match found {
            Some(record) => Ok(Some(self.with_branch(record, cancel).await?)),
            None => Ok(None),
        }
    }

    /// The managed worktree whose checkout is `path` or contains it.
    pub async fn worktree_containing(&self, path: &str, cancel: &CancellationToken) -> Result<Option<WorktreeRecord>, ScmFailure> {
        if mixdog_js::js_trim(path).is_empty() {
            return Ok(None);
        }
        match self.records(cancel).await?.into_iter().find(|r| is_within(&r.path, path)) {
            Some(record) => Ok(Some(self.with_branch(record, cancel).await?)),
            None => Ok(None),
        }
    }

    pub async fn worktree_by_path(&self, path: &str, cancel: &CancellationToken) -> Result<Option<WorktreeRecord>, ScmFailure> {
        let wanted = path_key(Path::new(path));
        match self.records(cancel).await?.into_iter().find(|r| path_key(Path::new(&r.path)) == wanted) {
            Some(record) => Ok(Some(self.with_branch(record, cancel).await?)),
            None => Ok(None),
        }
    }

    pub async fn claim(&self, entry_id: &str, session: &str, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.wt.claim_owner(entry_id, self.owner(session), cancel).await
    }

    /// Release the live lease; a worktree that vanished has no owner left to release.
    pub async fn release(&self, entry_id: &str, session: &str, forget_reference: bool, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        match self.wt.release_owner(entry_id, self.owner(session), forget_reference, cancel).await {
            Err(failure) if failure.code() == Some(errors::WORKTREE_MISSING) => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// What the removal of a ready worktree would refuse, checked before anything moves.
    pub async fn assert_removable(&self, entry_id: &str, force: bool, session: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let record = self
            .wt
            .record(cancel, entry_id)
            .await?
            .ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let record = self.with_branch(record, cancel).await?;
        let mut others: Vec<String> = record.shared_session_ids.clone();
        others.extend(record.owner_session_id.clone());
        others.retain(|id| id != session);
        others.sort();
        others.dedup();
        if !others.is_empty() {
            return Err(errors::busy_with("workspace-shared", Some(others), None, None));
        }
        if record.state != "ready" || force {
            return Ok(());
        }
        let path = PathBuf::from(&record.path);
        if self.exists(&record.path, cancel).await? {
            if let Ok(repo) = self.wt.scm().open(&path, cancel).await {
                if operation_in_progress(&repo.identity.git_dir).is_some() {
                    return Err(errors::dirty(Some(record.id.clone()), None, None, None));
                }
            }
        }
        let dirty = self.wt.dirty_paths(&record, cancel).await?;
        if !dirty.is_empty() {
            return Err(errors::dirty_files(record.id.clone(), dirty));
        }
        if self.wt.checkout_unmerged_count(&record, cancel).await? > 0 {
            return Err(errors::unmerged(Some(record.id.clone()), None, record.branch.clone(), record.merge_target.clone()));
        }
        Ok(())
    }

    /// The project folder's uncommitted changes (tracked and untracked, ignored excluded).
    async fn uncommitted(&self, top_level: &Path, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let status = self
            .wt
            .scm()
            .git
            .read(cancel, top_level, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
            .await?;
        Ok(parse_status_paths(&status))
    }

    /// A new worktree for `session` on a new branch named after `name_hint`, or the one a
    /// retried transaction already made. `carry` decides the project folder's uncommitted
    /// changes: `ask` refuses while there are any, `leave` keeps them there.
    pub async fn create_for_session(
        &self,
        project: &RepoFacts,
        session: &str,
        tx_id: &str,
        name_hint: &str,
        carry: Option<&str>,
        confirm_large: bool,
        cancel: &CancellationToken,
    ) -> Result<Created, ScmFailure> {
        if mixdog_js::js_trim(tx_id).is_empty() {
            return Err(plain("txId must be a non-empty string."));
        }
        let common = text(&project.common_dir);
        let retried = self.records(cancel).await?.into_iter().find(|r| {
            r.extra.get("txId").and_then(Value::as_str) == Some(tx_id)
                && r.owner_session_id.as_deref() == Some(session)
                && same_path(&r.repo_common_dir, &common)
        });
        if let Some(record) = retried {
            return Ok(Created { record, changes: None });
        }
        let mut pending = Vec::new();
        match carry {
            None => {}
            Some("carry") => {
                return Err(plain("worktree: carrying the project folder's uncommitted changes needs the carry backend of mixdog-scm"));
            }
            Some(_) => pending = self.uncommitted(&project.top_level, cancel).await?,
        }
        if carry == Some("ask") && !pending.is_empty() {
            return Err(ScmFailure::coded(
                "WORKTREE_DIRTY_CHOICE",
                DomainErrorDetail::WorktreeDirtyChoice {
                    count: pending.len() as u64,
                    paths: pending.iter().take(DIRTY_CHOICE_PREVIEW).cloned().collect(),
                },
            ));
        }
        let settings = self.settings.worktree_settings().await;
        let base_commit = match &project.current_branch {
            Some(branch) => first_line(
                &self
                    .wt
                    .scm()
                    .git
                    .read(cancel, &project.top_level, &["rev-parse", "--verify", &format!("refs/heads/{branch}^{{commit}}")])
                    .await?,
            ),
            None => project.head.clone(),
        };
        let root = names::managed_root(self.wt.data_dir(), &project.common_dir);
        self.wt
            .assert_checkout_fits(&project.top_level, &base_commit, 0, &root, settings.size_warn_bytes, confirm_large, cancel)
            .await?;
        let record = self
            .wt
            .create(
                CreateRequest {
                    project_path: project.project_path.clone(),
                    session_id: session.to_owned(),
                    tx_id: tx_id.to_owned(),
                    name_hint: name_hint.to_owned(),
                    base_branch: project.current_branch.clone(),
                    ..CreateRequest::default()
                },
                cancel,
            )
            .await?;
        if let Err(failure) = self.claim(&record.id, session, cancel).await {
            let _ = self.wt.remove(&record.id, true, Some(session), cancel).await;
            return Err(failure);
        }
        let changes = (!pending.is_empty()).then_some(("left", pending.len() as u64));
        Ok(Created { record, changes })
    }

    /// Resolve a branch to its checkout without switching any existing folder: a retried
    /// transaction's worktree, the checkout that already holds the branch, or a new managed
    /// worktree. `create` makes the branch at the project folder's branch.
    pub async fn resolve_branch(
        &self,
        project_path: &str,
        branch: &str,
        create: bool,
        session: &str,
        tx_id: &str,
        confirm_large: bool,
        cancel: &CancellationToken,
    ) -> Result<Resolved, ScmFailure> {
        if mixdog_js::js_trim(branch).is_empty() {
            return Err(plain("branch must be a non-empty string."));
        }
        let repo = self.inspect(project_path, cancel).await?;
        let common = text(&repo.common_dir);
        if !self.wt.valid_branch_name(&repo.project_path, branch, cancel).await? {
            return Err(plain("Invalid branch name."));
        }
        let records = self.records(cancel).await?;
        let transaction = records.iter().find(|r| !tx_id.is_empty() && r.extra.get("txId").and_then(Value::as_str) == Some(tx_id));
        if let Some(t) = transaction {
            if t.owner_session_id.as_deref() != Some(session) || t.branch.as_deref() != Some(branch) || !same_path(&t.repo_common_dir, &common) {
                return Err(errors::revision_conflict(None));
            }
        }
        if let Some(retry) = transaction.filter(|t| t.state == "ready") {
            if !self.exists(&retry.path, cancel).await? {
                return Err(errors::missing(None, None, None));
            }
            self.claim(&retry.id, session, cancel).await?;
            return Ok(Resolved { path: retry.path.clone(), entry: Some(retry.clone()), reference_added: false, repo_common_dir: common });
        }
        let listed = self.wt.scm().git.read(cancel, &repo.project_path, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).await?;
        let exists = listed.lines().any(|l| l.trim() == branch);
        if create && exists {
            return Err(errors::revision_conflict(None));
        }
        if !create && !exists {
            return Err(errors::missing(None, None, None));
        }
        let holder = self
            .wt
            .list_git_worktrees(&repo.project_path, cancel)
            .await?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch) && !w.prunable);
        if let Some(holder) = holder {
            if !self.exists(&holder.path, cancel).await? {
                return Err(errors::missing(None, None, Some(holder.path)));
            }
            let entry = self.worktree_by_path(&holder.path, cancel).await?;
            let claim = match &entry {
                Some(entry) => Some(self.claim(&entry.id, session, cancel).await?),
                None => None,
            };
            let reference_added = claim.is_some_and(|c| c["referenceAdded"] == true);
            return Ok(Resolved { path: holder.path, entry, reference_added, repo_common_dir: common });
        }
        if !create && self.remote_defaults(&repo.project_path, cancel).await?.iter().any(|d| d == branch) {
            return Err(ScmFailure::coded(
                "WORKTREE_DEFAULT_BRANCH",
                DomainErrorDetail::WorktreeDefaultBranch { branch: branch.to_owned() },
            ));
        }
        let settings = self.settings.worktree_settings().await;
        let base_commit = first_line(
            &self
                .wt
                .scm()
                .git
                .read(cancel, &repo.top_level, &["rev-parse", "--verify", &format!("refs/heads/{}^{{commit}}", if create { repo.current_branch.as_deref().unwrap_or(branch) } else { branch })])
                .await?,
        );
        let root = names::managed_root(self.wt.data_dir(), &repo.common_dir);
        self.wt
            .assert_checkout_fits(&repo.top_level, &base_commit, 0, &root, settings.size_warn_bytes, confirm_large, cancel)
            .await?;
        let record = self
            .wt
            .create(
                CreateRequest {
                    project_path: PathBuf::from(project_path),
                    session_id: session.to_owned(),
                    tx_id: tx_id.to_owned(),
                    name_hint: branch.to_owned(),
                    base_branch: if create { repo.current_branch.clone() } else { Some(branch.to_owned()) },
                    branch: Some(branch.to_owned()),
                    existing_branch: !create,
                    start_commit: None,
                    ..CreateRequest::default()
                },
                cancel,
            )
            .await?;
        self.claim(&record.id, session, cancel).await?;
        Ok(Resolved { path: record.path.clone(), entry: Some(record), reference_added: false, repo_common_dir: common })
    }

    /// The local branch names the repository's remotes declare as their default.
    async fn remote_defaults(&self, cwd: &Path, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let listed = self.wt.scm().git.read(cancel, cwd, &["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"]).await?;
        let mut names = Vec::new();
        for line in listed.lines() {
            let mut parts = line.split(' ');
            let (Some(reference), Some(target)) = (parts.next(), parts.next()) else { continue };
            let Some(remote) = reference.strip_suffix("HEAD") else { continue };
            if let Some(name) = target.strip_prefix(remote) {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }
}
