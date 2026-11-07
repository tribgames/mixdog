//! The removal state machine (Node `manager.mjs` `removeLocked` / `finishDeletion` /
//! `removeAutomatically` / `rollbackCreation`). Every function here runs under the repository's
//! write lock, taken by the caller. A removal is first decided and written down (`state:
//! deleting`, the `deleting` marker with what it needs to be resumed), then finished step by
//! step; what could not be removed stays in `deleting.remaining` and the next pass resumes it.
//! An *automatic* removal is never resumed blindly: what it took apart is put back and the
//! record returns to `ready` with `removalIncomplete`, to be verified afresh.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_protocol::RemovalRemnant;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::repo::on_lane;
use crate::repo::operation_in_progress;
use crate::worktree::activity::Grant;
use crate::worktree::dependencies::dependency_artefacts;
use crate::worktree::errors;
use crate::worktree::housekeeping::remnant;
use crate::worktree::housekeeping::repo_cwd;
use crate::worktree::include;
use crate::worktree::manager::Worktrees;
use crate::worktree::manager::is_snapshot;
use crate::worktree::measure::DIRTY_CHOICE_PREVIEW;
use crate::worktree::measure::covered_by;
use crate::worktree::merge::parse_status_entries;
use crate::worktree::ownership::lease_path;
use crate::worktree::ownership::pid_alive_or_unknown;
use crate::worktree::registry::WorktreeRecord;

/// How long the cleanup's last dirty check under the folder hold may take.
pub const FINAL_DIRTY_CHECK_TIMEOUT: Duration = Duration::from_millis(1_500);
const CACHEDIR_SIGNATURE: &str = "Signature: 8a477f597d28d172789f06886806bc55";
const MIXDOG_LOCK_PREFIX: &str = "mixdog session=";

/// A host cleanup tied to a folder going away (live terminal handles, caches keyed by it). A
/// failure is reported and retried with the deletion; it never keeps the checkout.
#[async_trait]
pub trait RootCleanup: Send + Sync {
    fn name(&self) -> &str;
    async fn run(&self, root: &Path, entry_id: &str) -> Result<(), String>;
}

/// The caller's view, asked again under each removal's folder hold: the sessions live now and
/// the jobs running now.
#[async_trait]
pub trait InUse: Send + Sync {
    async fn in_use(&self, record: &WorktreeRecord) -> bool;
}

pub struct NeverInUse;

#[async_trait]
impl InUse for NeverInUse {
    async fn in_use(&self, _: &WorktreeRecord) -> bool {
        false
    }
}

#[derive(Clone)]
pub struct AutoOptions {
    pub in_use: Arc<dyn InUse>,
    pub preserve_branch: bool,
    pub final_check_timeout: Duration,
}

impl Default for AutoOptions {
    fn default() -> Self {
        Self { in_use: Arc::new(NeverInUse), preserve_branch: false, final_check_timeout: FINAL_DIRTY_CHECK_TIMEOUT }
    }
}

/// What a deletion did.
#[derive(Clone, Debug, Default)]
pub struct Deletion {
    pub removed: bool,
    pub incomplete: bool,
    pub remaining: Vec<RemovalRemnant>,
    pub branch_deleted: bool,
    pub preserved_branch: Option<Value>,
    pub recovery_refs: Vec<String>,
}

impl Deletion {
    fn pending(remaining: Vec<RemovalRemnant>, incomplete: bool) -> Self {
        Self { removed: false, incomplete, remaining, ..Self::default() }
    }

    pub fn to_json(&self) -> Value {
        if !self.removed {
            let mut out = json!({ "removed": false, "retryable": true, "remaining": self.remaining });
            if self.incomplete {
                out["incomplete"] = json!(true);
            }
            return out;
        }
        let mut out = json!({ "removed": true });
        if self.branch_deleted {
            out["branchDeleted"] = json!(true);
        }
        if let Some(preserved) = &self.preserved_branch {
            out["preservedBranch"] = preserved.clone();
        }
        if !self.recovery_refs.is_empty() {
            out["recoveryRefs"] = json!(self.recovery_refs);
        }
        out
    }
}

/// An automatic removal's verdict: removed, or kept with the reason (`dirty`, `unmerged`,
/// `ignored` with `files`/`count`, `in-use`, `changed`, `busy`).
pub enum Auto {
    Removed(Deletion),
    Kept(Value),
}

/// A status that must not rewrite the index: the checkout token compares the index file's stamp
/// across the checks, so the checks themselves may not change it.
fn no_index_refresh() -> crate::git::RunOptions {
    crate::git::RunOptions { extra_env: vec![("GIT_OPTIONAL_LOCKS".into(), "0".into())], ..crate::git::RunOptions::default() }
}

fn kept(reason: &str) -> Value {
    json!({ "reason": reason })
}

fn ignored_keep(paths: &[String]) -> Value {
    json!({ "reason": "ignored", "files": paths.iter().take(DIRTY_CHOICE_PREVIEW).collect::<Vec<_>>(), "count": paths.len() })
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("").trim()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn deleting_flag(record: &WorktreeRecord, key: &str) -> bool {
    record.extra.get("deleting").and_then(|d| d.get(key)).and_then(Value::as_bool).unwrap_or(false)
}

fn set_deleting(record: &mut WorktreeRecord, key: &str, value: Value) {
    let mut deleting = record.extra.get("deleting").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    deleting[key] = value;
    record.extra.insert("deleting".into(), deleting);
}

fn lock_reason_is_ours(lock: &str) -> bool {
    lock.starts_with(MIXDOG_LOCK_PREFIX)
}

/// A refusal that only says "something still runs there" (retry once it ends).
pub(crate) fn snapshot_in_use(failure: &ScmFailure) -> bool {
    use mixdog_protocol::DomainErrorDetail;
    match failure {
        ScmFailure::Coded { code, detail: Some(detail), .. } if *code == errors::WORKTREE_BUSY_JOBS => {
            matches!(&**detail, DomainErrorDetail::WorktreeBusyJobs { reason, .. } if reason == "folder-in-use" || reason == "workspace-admission-unreadable")
        }
        _ => false,
    }
}

impl Worktrees {
    async fn git_try(&self, cancel: &CancellationToken, cwd: &Path, args: &[&str]) -> Result<(bool, String, String), ScmFailure> {
        let out = self.scm().git.outcome(cancel, cwd, args, &crate::git::RunOptions::default()).await?;
        Ok((out.success(), out.stdout_text(), out.stderr_text()))
    }

    pub(crate) async fn lease_alive(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        Ok(self.read_owner_lease(record, cancel).await?.and_then(|lease| lease.owner.pid).is_some_and(|pid| pid_alive_or_unknown(Some(pid))))
    }

    pub(crate) async fn remove_owner_lease(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let path = lease_path(self.data_dir(), record);
        on_lane(self.scm().lane, cancel, move || match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(ScmFailure::from(error)),
            _ => Ok(()),
        })
        .await?
    }

    async fn delete_record(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let id = record.id.clone();
        self.with_registry(cancel, move |registry| registry.delete(&id)).await?;
        self.sizes().forget(Path::new(&record.path));
        Ok(())
    }

    /// The HEAD commit of a branch worktree's checkout, read while it still exists.
    pub(crate) async fn checkout_head_commit(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        let path = PathBuf::from(&record.path);
        if is_snapshot(record) || !path.exists() {
            return Ok(None);
        }
        let (ok, stdout, _) = self.git_try(cancel, &path, &["rev-parse", "--verify", "-q", "HEAD"]).await?;
        Ok(ok.then(|| first_line(&stdout).to_owned()).filter(|oid| !oid.is_empty()))
    }

    /// Holds the folder of a checkout against its consumers (`None`: it is no checkout, or
    /// there is no admission to hold it against). A turn or command already inside refuses.
    pub(crate) async fn hold_folder(&self, record: &WorktreeRecord) -> Result<Option<Grant>, ScmFailure> {
        let Some(activity) = self.activity() else { return Ok(None) };
        if !Path::new(&record.path).join(".git").exists() {
            return Ok(None);
        }
        Ok(Some(activity.hold(&[PathBuf::from(&record.path)], None, false).await?))
    }

    pub(crate) async fn release_folder(&self, grant: Option<Grant>) {
        if let (Some(grant), Some(activity)) = (grant, self.activity()) {
            let _ = grant.release(activity).await;
        }
    }

    /// A snapshot is in use while its holder session is live, or its lease holder runs in
    /// another process.
    pub(crate) async fn snapshot_holder_live(&self, record: &WorktreeRecord, live: &HashSet<String>, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        if record.extra.get("holderSessionId").and_then(Value::as_str).is_some_and(|id| live.contains(id)) {
            return Ok(true);
        }
        Ok(self
            .read_owner_lease(record, cancel)
            .await?
            .and_then(|lease| lease.owner.pid)
            .is_some_and(|pid| pid != std::process::id() && pid_alive_or_unknown(Some(pid))))
    }

    // ----- the checkout step ------------------------------------------------------------

    /// Removes the checkout and its registration; what is still present afterwards.
    async fn remove_checkout(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Vec<RemovalRemnant>, ScmFailure> {
        self.assert_recovery_stores_clear(record, cancel).await?;
        self.assert_managed_path(record, cancel).await?;
        self.assert_no_unrecorded_links(record, cancel).await?;
        let links = include::ledger_of(record);
        let stuck = on_lane(self.scm().lane, cancel, move || include::remove_include_links(&links)).await?;
        if !stuck.is_empty() {
            return Ok(stuck.into_iter().map(|path| remnant("link", Some(&path), None)).collect());
        }
        let (cwd, path) = (repo_cwd(record), PathBuf::from(&record.path));
        if path.exists() {
            // A built-in fsmonitor daemon holds the folder open (Windows) until stopped.
            self.git_try(cancel, &path, &["fsmonitor--daemon", "stop"]).await?;
        }
        if self.registration_for(record, cancel).await?.is_some() {
            self.git_try(cancel, &cwd, &["worktree", "unlock", &record.path]).await?;
            if path.exists() {
                self.git_try(cancel, &cwd, &["worktree", "remove", "--force", &record.path]).await?;
            }
        }
        if path.exists() {
            let error = self.remove_tree(&path, cancel).await?;
            if path.exists() {
                return Ok(vec![remnant("directory", Some(&record.path), Some(error.as_deref().unwrap_or("busy")))]);
            }
        }
        self.prune_registration(record, true, cancel).await?;
        Ok(if self.registration_for(record, cancel).await?.is_some() { vec![remnant("registration", Some(&record.path), None)] } else { Vec::new() })
    }

    /// Puts back what an automatic removal attempt took apart in a checkout that survived: the
    /// recorded include links and Mixdog's worktree lock. Never fails; what could not be put back.
    pub(crate) async fn undo_automatic_attempt(&self, record: &WorktreeRecord, undo: &Value, cancel: &CancellationToken) -> Vec<RemovalRemnant> {
        if undo.is_null() || !Path::new(&record.path).exists() {
            return Vec::new();
        }
        let mut failures = Vec::new();
        if undo.get("links").and_then(Value::as_bool) == Some(true) {
            let links = include::ledger_of(record);
            if let Ok(left) = on_lane(self.scm().lane, cancel, move || include::restore_include_links(&links)).await {
                failures.extend(left.into_iter().map(|(path, error)| remnant("link", Some(&path), Some(&error))));
            }
        }
        if let Some(reason) = undo.get("lock").and_then(Value::as_str) {
            match self.registration_for(record, cancel).await {
                Ok(Some(registration)) if registration.locked.is_none() => {
                    match self.git_try(cancel, &repo_cwd(record), &["worktree", "lock", "--reason", reason, &record.path]).await {
                        Ok((true, ..)) => {}
                        Ok((false, _, stderr)) => failures.push(remnant("lock", Some(&record.path), Some(first_line(&stderr)))),
                        Err(error) => failures.push(remnant("undo", Some(&record.path), Some(&error.to_string()))),
                    }
                }
                Err(error) => failures.push(remnant("undo", Some(&record.path), Some(&error.to_string()))),
                _ => {}
            }
        }
        failures
    }

    /// The automatic cleanup's removal: only `git worktree remove --force` deletes, no recursive
    /// fallback. When git fails or anything is left, it stops and puts back what it took apart.
    async fn remove_checkout_verified(&self, record: &mut WorktreeRecord, cancel: &CancellationToken) -> Result<Vec<RemovalRemnant>, ScmFailure> {
        self.assert_recovery_stores_clear(record, cancel).await?;
        self.assert_managed_path(record, cancel).await?;
        self.assert_no_unrecorded_links(record, cancel).await?;
        let (cwd, path) = (repo_cwd(record), PathBuf::from(&record.path));
        let Some(registration) = self.registration_for(record, cancel).await? else {
            return Ok(if path.exists() { vec![remnant("directory", Some(&record.path), Some("not-registered"))] } else { Vec::new() });
        };
        if path.exists() {
            let lock = registration.locked.clone();
            if lock.as_deref().is_some_and(|reason| !lock_reason_is_ours(reason)) {
                return Ok(vec![remnant("lock", Some(&record.path), Some("external-lock"))]);
            }
            // What this attempt takes apart is written down first, so a failure here or a
            // restart puts it back.
            let undo = json!({ "links": true, "lock": lock });
            set_deleting(record, "undo", undo.clone());
            self.put_record(cancel, record.clone()).await?;
            let links = include::ledger_of(record);
            let unlinked = on_lane(self.scm().lane, cancel, move || include::remove_include_links(&links)).await?;
            if !unlinked.is_empty() {
                let mut out: Vec<RemovalRemnant> = unlinked.into_iter().map(|path| remnant("link", Some(&path), None)).collect();
                out.extend(self.undo_automatic_attempt(record, &undo, cancel).await);
                return Ok(out);
            }
            self.git_try(cancel, &path, &["fsmonitor--daemon", "stop"]).await?;
            if lock.is_some() {
                self.git_try(cancel, &cwd, &["worktree", "unlock", &record.path]).await?;
            }
            let (ok, _, stderr) = match self.git_try(cancel, &cwd, &["worktree", "remove", "--force", &record.path]).await {
                Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                Err(error) => (false, String::new(), error.to_string()),
                Ok(done) => done,
            };
            if !ok || path.exists() {
                let reason = if !stderr.trim().is_empty() { first_line(&stderr).to_owned() } else if ok { "folder left behind".to_owned() } else { "exit non-zero".to_owned() };
                let mut out = vec![remnant("git-remove", Some(&record.path), Some(&reason))];
                out.extend(self.undo_automatic_attempt(record, &undo, cancel).await);
                return Ok(out);
            }
        }
        self.prune_registration(record, true, cancel).await?;
        Ok(if self.registration_for(record, cancel).await?.is_some() { vec![remnant("registration", Some(&record.path), None)] } else { Vec::new() })
    }

    /// Folder-only cleanup never force-removes a checkout or user files.
    async fn remove_checkout_safely(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Vec<RemovalRemnant>, ScmFailure> {
        let registration = self.registration_for(record, cancel).await?;
        if registration.is_none() && !Path::new(&record.path).exists() {
            return Ok(Vec::new());
        }
        self.assert_managed_path(record, cancel).await?;
        self.assert_recovery_stores_clear(record, cancel).await?;
        self.assert_removable(record, cancel).await?;
        let owned_lock = format!("{MIXDOG_LOCK_PREFIX}{}", record.owner_session_id.as_deref().unwrap_or("undefined"));
        let locked = registration.as_ref().and_then(|r| r.locked.clone());
        if locked.as_deref().is_some_and(|reason| reason != owned_lock) {
            return Err(errors::busy_text("The worktree has an external Git lock.".into()));
        }
        self.assert_no_unrecorded_links(record, cancel).await?;
        let links = include::ledger_of(record);
        let left = {
            let links = links.clone();
            on_lane(self.scm().lane, cancel, move || include::remove_include_links(&links)).await?
        };
        let restore = |links: Vec<include::IncludeItem>| async move {
            // A restore that never ran restored nothing: say so, rather than report no failures.
            on_lane(self.scm().lane, cancel, move || include::restore_include_links(&links))
                .await
                .unwrap_or_else(|_| vec![("the linked folders".to_owned(), "the restore did not run".to_owned())])
        };
        if !left.is_empty() {
            let failures: Vec<String> = restore(links).await.into_iter().map(|(path, error)| format!("{path} ({error})")).collect();
            let mut message = "A linked folder in the worktree could not be unlinked.".to_owned();
            if !failures.is_empty() {
                message = format!("{message} Not restored: {}.", failures.join(", "));
            }
            return Err(errors::busy_text(message));
        }
        let cwd = repo_cwd(record);
        let mut unlocked = false;
        let attempt: Result<(), ScmFailure> = async {
            if locked.as_deref() == Some(owned_lock.as_str()) {
                self.scm().git.run(cancel, &cwd, &["worktree", "unlock", &record.path]).await?;
                unlocked = true;
            }
            self.scm().git.run(cancel, &cwd, &["worktree", "remove", &record.path]).await?;
            Ok(())
        }
        .await;
        if let Err(error) = attempt {
            let mut failures: Vec<String> = restore(links).await.into_iter().map(|(path, error)| format!("{path} ({error})")).collect();
            if unlocked && self.registration_for(record, cancel).await?.is_some() {
                if let Err(lock_error) = self.scm().git.run(cancel, &cwd, &["worktree", "lock", "--reason", &owned_lock, &record.path]).await {
                    failures.push(format!("worktree lock ({})", first_line(&lock_error.to_string())));
                }
            }
            return Err(if failures.is_empty() || matches!(error, ScmFailure::Cancelled) {
                error
            } else {
                errors::busy_text(format!("{error} Not restored: {}.", failures.join(", ")))
            });
        }
        Ok(Vec::new())
    }

    // ----- the deletion state machine ----------------------------------------------------

    /// The folder step of a deletion; what is left over goes to `remaining`.
    async fn remove_folder(&self, record: &mut WorktreeRecord, remaining: &mut Vec<RemovalRemnant>, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        self.remove_owner_lease(record, cancel).await?;
        let session_root = match record.extra.get("projectSubdir").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(sub) => Path::new(&record.path).join(sub),
            None => PathBuf::from(&record.path),
        };
        let mut roots = vec![PathBuf::from(&record.path)];
        if session_root != roots[0] {
            roots.push(session_root);
        }
        for cleanup in self.cleanups() {
            for root in &roots {
                if let Err(error) = cleanup.run(root, &record.id).await {
                    remaining.push(RemovalRemnant { kind: "cleanup".into(), path: None, name: Some(cleanup.name().to_owned()), error: Some(error) });
                }
            }
        }
        let left = if deleting_flag(record, "automatic") {
            self.remove_checkout_verified(record, cancel).await?
        } else if deleting_flag(record, "safeOnly") {
            self.remove_checkout_safely(record, cancel).await?
        } else {
            self.remove_checkout(record, cancel).await?
        };
        remaining.extend(left);
        Ok(())
    }

    /// An automatic removal that did not finish is not a decided deletion: the record goes back
    /// to `ready` with `removalIncomplete`, so only a later pass that verifies it afresh tries again.
    pub(crate) async fn keep_incomplete_removal(&self, record: &mut WorktreeRecord, remaining: Vec<RemovalRemnant>, reason: &str, cancel: &CancellationToken) -> Result<Deletion, ScmFailure> {
        record.state = "ready".into();
        record.extra.insert("deleting".into(), Value::Null);
        record.extra.insert("removalIncomplete".into(), json!({ "at": now_ms(), "reason": reason, "remaining": remaining }));
        self.put_record(cancel, record.clone()).await?;
        Ok(Deletion::pending(remaining, true))
    }

    /// Finishes (or resumes) a decided deletion, in order: release the host's handles on the
    /// folder, `git worktree remove` and delete the directory, then the branch Mixdog created,
    /// and a recovery ref for any commit no ref reaches any more.
    pub(crate) async fn finish_deletion(&self, record: &mut WorktreeRecord, cancel: &CancellationToken) -> Result<Deletion, ScmFailure> {
        self.assert_recovery_stores_clear(record, cancel).await?;
        let mut remaining = Vec::new();
        match self.remove_folder(record, &mut remaining, cancel).await {
            Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
            Err(error) => remaining.push(remnant("error", None, Some(&crate::worktree::reconcile::describe(&error)))),
            Ok(()) => {}
        }
        if !remaining.is_empty() && deleting_flag(record, "automatic") {
            return self.keep_incomplete_removal(record, remaining, "git-remove-failed", cancel).await;
        }
        if !remaining.is_empty() {
            set_deleting(record, "remaining", json!(remaining));
            set_deleting(record, "lastAttemptAt", json!(now_ms()));
            self.put_record(cancel, record.clone()).await?;
            return Ok(Deletion::pending(remaining, false));
        }
        let cwd = repo_cwd(record);
        // The folder-only removal promises the branch stays, as does an automatic cleanup with
        // deleteBranch off. Only a record that says Mixdog created the branch deletes it.
        let existing = record.extra.get("existingBranch").and_then(Value::as_bool);
        let branch = match &record.branch {
            Some(_) if deleting_flag(record, "safeOnly") || deleting_flag(record, "preserveBranch") || existing == Some(true) => BranchFate::default(),
            Some(name) if existing == Some(false) => self.delete_created_branch(record, name, cancel).await?,
            Some(name) => self.keep_branch(&cwd, name, cancel).await?,
            None => BranchFate::default(),
        };
        let mut recovery_refs = Vec::new();
        let head_commit = record.extra.get("deleting").and_then(|d| d.get("headCommit")).and_then(Value::as_str).map(str::to_owned);
        let mut commits: Vec<String> = head_commit.into_iter().chain(branch.head.clone()).collect();
        commits.dedup();
        for commit in commits {
            if self.any_ref_contains(&cwd, &commit, cancel).await? {
                continue;
            }
            recovery_refs.push(self.keep_commit(record, &commit, cancel).await?);
        }
        self.delete_record(record, cancel).await?;
        self.prune_empty_repo_root(&record.repo_common_dir, cancel).await?;
        Ok(Deletion {
            removed: true,
            branch_deleted: branch.deleted,
            preserved_branch: branch.preserved,
            recovery_refs,
            ..Deletion::default()
        })
    }

    /// A branch a removal leaves, reported `preserved` unless it is gone or checked out.
    async fn keep_branch(&self, cwd: &Path, name: &str, cancel: &CancellationToken) -> Result<BranchFate, ScmFailure> {
        let Some(head) = self.branch_commit(cwd, name, cancel).await? else { return Ok(BranchFate::default()) };
        let live_holder = self.list_git_worktrees(cwd, cancel).await?.iter().any(|row| row.branch.as_deref() == Some(name) && !row.prunable);
        if live_holder {
            return Ok(BranchFate::default());
        }
        Ok(BranchFate { preserved: Some(json!({ "name": name, "head": head })), ..BranchFate::default() })
    }

    /// After a removal, the recorded branch Mixdog created goes when git's `branch -d` accepts
    /// it, or when its changes are all in the merge reference (head-guarded). A branch checked
    /// out in any worktree stays. Unmerged work stays and is reported `preserved`.
    async fn delete_created_branch(&self, record: &WorktreeRecord, name: &str, cancel: &CancellationToken) -> Result<BranchFate, ScmFailure> {
        let cwd = repo_cwd(record);
        let Some(head) = self.branch_commit(&cwd, name, cancel).await? else { return Ok(BranchFate::default()) };
        let holders: Vec<_> = self.list_git_worktrees(&cwd, cancel).await?.into_iter().filter(|row| row.branch.as_deref() == Some(name)).collect();
        if holders.iter().any(|row| !row.prunable) {
            return Ok(BranchFate::default());
        }
        if !holders.is_empty() {
            self.git_try(cancel, &cwd, &["worktree", "prune"]).await?;
        }
        if self.git_try(cancel, &cwd, &["branch", "-d", "--", name]).await?.0 {
            return Ok(BranchFate { deleted: true, head: Some(head), ..BranchFate::default() });
        }
        if self.unmerged_commit_count(record, Some(&head), cancel).await? == 0 {
            match self.force_delete_branch(&cwd, name, &head, cancel).await {
                Ok(()) => return Ok(BranchFate { deleted: true, head: Some(head), ..BranchFate::default() }),
                Err(ScmFailure::Coded { .. }) => {}
                Err(other) => return Err(other),
            }
        }
        Ok(BranchFate { preserved: Some(json!({ "name": name, "head": head })), ..BranchFate::default() })
    }

    /// True when any ref still reaches `commit`; unknown counts as unreachable (the commit is kept).
    async fn any_ref_contains(&self, cwd: &Path, commit: &str, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        let (ok, stdout, _) = self.git_try(cancel, cwd, &["for-each-ref", "--count=1", "--format=%(refname)", "--contains", commit]).await?;
        Ok(ok && !first_line(&stdout).is_empty())
    }

    /// Keeps `commit` reachable at `refs/mixdog/recovered/<id>/<commit>`, created only where
    /// none is, so nothing is ever overwritten.
    async fn keep_commit(&self, record: &WorktreeRecord, commit: &str, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let cwd = repo_cwd(record);
        let reference = format!("refs/mixdog/recovered/{}/{commit}", record.id);
        let message = format!("mixdog: removed worktree {}", record.id);
        let (made, _, stderr) = self.git_try(cancel, &cwd, &["update-ref", "-m", &message, &reference, commit, ""]).await?;
        if !made {
            let (found, stdout, _) = self.git_try(cancel, &cwd, &["rev-parse", "--verify", "--quiet", &reference]).await?;
            if !(found && first_line(&stdout) == commit) {
                return Err(ScmFailure::git(format!("Could not keep {commit} at {reference}: {}", first_line(&stderr))));
            }
        }
        Ok(reference)
    }

    /// `git branch -D` of the record's branch unless it is gone or checked out; only a failed
    /// creation's rollback calls it. The reason it stayed, if it did.
    async fn delete_branch_if_free(&self, record: &WorktreeRecord, name: &str, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        if record.extra.get("existingBranch").and_then(Value::as_bool) == Some(true) {
            return Ok(Some("pre-existing".into()));
        }
        let cwd = repo_cwd(record);
        if self.branch_commit(&cwd, name, cancel).await?.is_none() {
            return Ok(Some("missing".into()));
        }
        if self.list_git_worktrees(&cwd, cancel).await?.iter().any(|row| row.branch.as_deref() == Some(name)) {
            return Ok(Some("checked-out".into()));
        }
        let (ok, _, stderr) = self.git_try(cancel, &cwd, &["branch", "-D", "--", name]).await?;
        Ok((!ok).then(|| first_line(&stderr).to_owned()))
    }

    /// Undoes an incomplete creation using only the ledger's proof. The record moves to
    /// `recovery` first, so an interruption stays attributable. `(complete, remaining)`.
    pub(crate) async fn rollback_record(&self, record: &mut WorktreeRecord, cause: Option<&str>, cancel: &CancellationToken) -> Result<(bool, Vec<RemovalRemnant>), ScmFailure> {
        record.state = "recovery".into();
        let tx = record.extra.get("txId").cloned().unwrap_or(Value::Null);
        record.extra.insert("recovery".into(), json!({ "txId": tx, "reason": cause.unwrap_or("interrupted creation"), "at": now_ms() }));
        let mut remaining = Vec::new();
        // The filesystem cleanup never waits on the registry: with a full disk this write can
        // fail too, and the checkout must still go.
        if let Err(error) = self.put_record(cancel, record.clone()).await {
            if matches!(error, ScmFailure::Cancelled) {
                return Err(error);
            }
            remaining.push(remnant("registry", None, Some(&error.to_string())));
        }
        let resources = record.extra.get("resources").cloned().unwrap_or(Value::Null);
        let truthy = |key: &str| resources.get(key).is_some_and(|v| !v.is_null() && v != &json!(false) && v != &json!(""));
        let step: Result<(), ScmFailure> = async {
            if truthy("owner") {
                self.remove_owner_lease(record, cancel).await?;
            }
            if truthy("worktree") {
                let left = self.remove_checkout(record, cancel).await?;
                let empty = left.is_empty();
                remaining.extend(left);
                let exact_not_created = record.extra.get("exactBranch").and_then(Value::as_bool) == Some(true) && resources.get("worktree").and_then(Value::as_str) != Some("created");
                if let (true, Some(branch), false, false) = (empty, record.branch.clone(), record.extra.get("existingBranch").and_then(Value::as_bool) == Some(true), exact_not_created) {
                    // The slug was free when this transaction reserved it, so a branch still at
                    // the base commit is the one `worktree add -b` made; one that moved holds
                    // someone's commits and is kept.
                    let tip = self.branch_commit(&repo_cwd(record), &branch, cancel).await?;
                    match tip {
                        Some(tip) if Some(&tip) == record.base_commit.as_ref() => {
                            if let Some(reason) = self.delete_branch_if_free(record, &branch, cancel).await? {
                                remaining.push(RemovalRemnant { kind: "branch".into(), path: None, name: Some(branch), error: Some(reason) });
                            }
                        }
                        Some(_) => remaining.push(RemovalRemnant { kind: "branch".into(), path: None, name: Some(branch), error: Some("moved".into()) }),
                        None => {}
                    }
                }
            }
            Ok(())
        }
        .await;
        match step {
            Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
            Err(error) => remaining.push(remnant("error", None, Some(&error.to_string()))),
            Ok(()) => {}
        }
        if !remaining.iter().any(|item| item.kind != "registry") {
            let done: Result<(), ScmFailure> = async {
                self.delete_record(record, cancel).await?;
                self.prune_empty_repo_root(&record.repo_common_dir, cancel).await
            }
            .await;
            match done {
                Ok(()) => return Ok((true, Vec::new())),
                Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                Err(error) => remaining.push(remnant("registry", None, Some(&error.to_string()))),
            }
        }
        if let Some(recovery) = record.extra.get_mut("recovery") {
            recovery["remaining"] = json!(remaining);
        }
        let _ = self.put_record(cancel, record.clone()).await;
        Ok((false, remaining))
    }

    // ----- the automatic path ------------------------------------------------------------

    /// A cheap fingerprint of what the cleanup's slow checks looked at: HEAD, the index file's
    /// stamp, the folder's own stamp, the branch tip and the merge target's tip.
    pub(crate) async fn checkout_token(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let (cwd, path) = (repo_cwd(record), PathBuf::from(&record.path));
        let (code, paths, _) = self.git_try(cancel, &path, &["rev-parse", "HEAD", "--git-path", "index"]).await?;
        let tip = match &record.branch {
            Some(branch) => self.branch_commit(&cwd, branch, cancel).await?,
            None => None,
        };
        let target = match &record.merge_target {
            Some(branch) => self.branch_commit(&cwd, branch, cancel).await?,
            None => None,
        };
        let mut lines = paths.lines();
        let head = lines.next().unwrap_or("").trim().to_owned();
        let index = lines.next().unwrap_or("").trim().to_owned();
        let index_path = (!index.is_empty()).then(|| path.join(&index));
        let folder = path.clone();
        let stamps = on_lane(self.scm().lane, cancel, move || {
            let stamp = |p: &Path| match std::fs::metadata(p) {
                Ok(meta) => format!("{}:{}", meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos()), meta.len()),
                Err(_) => "none".to_owned(),
            };
            (index_path.as_deref().map_or_else(|| "none".to_owned(), stamp), stamp(&folder))
        })
        .await?;
        Ok(json!([code, head, stamps.0, stamps.1, tip, target]).to_string())
    }

    fn user_status_paths(record: &WorktreeRecord, paths: Vec<String>, roots: &[String]) -> Vec<String> {
        let identity = Self::identity_path(record);
        paths.into_iter().filter(|path| *path != identity && !roots.iter().any(|root| covered_by(root, path))).collect()
    }

    /// Of the ignored status entries, the ones no install or rebuild restores: user data only
    /// this checkout holds. Reproducible and so left out: the identity file, recorded include
    /// items, whole dependency artefacts, `__pycache__` and `CACHEDIR.TAG`-marked folders.
    pub(crate) async fn unreproducible_ignored(&self, record: &WorktreeRecord, entries: Vec<String>, artefacts: Vec<String>, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let roots = self.include_roots(record);
        let identity = Self::identity_path(record);
        let base = PathBuf::from(&record.path);
        on_lane(self.scm().lane, cancel, move || {
            let identity_dir = identity.rsplit_once('/').map_or("", |(dir, _)| dir).to_owned();
            let mut tagged: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
            let mut cache_dir = |dir: &str| {
                *tagged.entry(dir.to_owned()).or_insert_with(|| {
                    let tag = dir.split('/').fold(base.clone(), |p, s| p.join(s)).join("CACHEDIR.TAG");
                    std::fs::read(tag).is_ok_and(|bytes| bytes.starts_with(CACHEDIR_SIGNATURE.as_bytes()))
                })
            };
            let mut kept = Vec::new();
            for entry in entries {
                let path = entry.strip_suffix('/').unwrap_or(&entry).to_owned();
                if path == identity || roots.iter().any(|root| covered_by(root, &path)) {
                    continue;
                }
                if artefacts.iter().any(|a| path == *a || path.starts_with(&format!("{a}/"))) {
                    continue;
                }
                if path == identity_dir {
                    let folder = path.split('/').fold(base.clone(), |p, s| p.join(s));
                    let names: Option<Vec<String>> = std::fs::read_dir(folder).ok().map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect());
                    if names.is_some_and(|n| n.len() == 1 && n[0] == "project.id") {
                        continue;
                    }
                }
                let parts: Vec<&str> = path.split('/').collect();
                let folders: &[&str] = if entry.ends_with('/') { &parts } else { &parts[..parts.len() - 1] };
                if folders.contains(&"__pycache__") {
                    continue;
                }
                let cache = (1..=folders.len()).any(|depth| cache_dir(&folders[..depth].join("/")));
                if !cache {
                    kept.push(path);
                }
            }
            kept
        })
        .await
    }

    /// What keeps `record` from an automatic removal: dirty paths and unreproducible ignored
    /// ones, with the dependency artefacts that decided it.
    pub(crate) async fn automatic_keep_paths(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(Vec<String>, Vec<String>, Vec<String>), ScmFailure> {
        let path = PathBuf::from(&record.path);
        if !path.exists() {
            return Ok((Vec::new(), Vec::new(), Vec::new()));
        }
        // Node runs the two reads together (`Promise.all` in `automaticKeepPaths`).
        let (status, artefacts) = tokio::try_join!(
            self.scm().git.text(cancel, &path, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], &no_index_refresh()),
            dependency_artefacts(self.scm(), cancel, &path),
        )?;
        let (mut changed, mut ignored) = (Vec::new(), Vec::new());
        for (code, entry) in parse_status_entries(&status) {
            if code == "!!" { ignored.push(entry) } else { changed.push(entry) }
        }
        let roots = self.include_roots(record);
        let mut dirty = Self::user_status_paths(record, changed, &roots);
        dirty.extend(self.modified_include_copies(record, cancel).await?);
        let ignored = self.unreproducible_ignored(record, ignored, artefacts.clone(), cancel).await?;
        Ok((dirty, ignored, artefacts))
    }

    /// The cleanup's last word before a removal, under the folder hold: the full status and
    /// the include-copy check again, bounded by `timeout`. `None`: clean. A check that cannot
    /// finish in time is `busy`, never read as clean.
    pub(crate) async fn final_dirty_check(&self, record: &WorktreeRecord, timeout: Duration, artefacts: Vec<String>, cancel: &CancellationToken) -> Result<Option<Value>, ScmFailure> {
        let path = PathBuf::from(&record.path);
        if !path.exists() {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        let child = cancel.child_token();
        let status = tokio::time::timeout(
            timeout,
            self.scm().git.outcome(&child, &path, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], &no_index_refresh()),
        )
        .await;
        let status = match status {
            Err(_) => {
                // The timed-out git is killed before this returns, so none keeps running in the folder.
                child.cancel();
                return Ok(Some(kept("busy")));
            }
            Ok(Err(ScmFailure::Cancelled)) => return Err(ScmFailure::Cancelled),
            Ok(Err(_)) => return Ok(Some(kept("busy"))),
            Ok(Ok(out)) if !out.success() => return Ok(Some(kept("busy"))),
            Ok(Ok(out)) => out.stdout_text(),
        };
        let (mut changed, mut ignored) = (Vec::new(), Vec::new());
        for (code, entry) in parse_status_entries(&status) {
            if code == "!!" { ignored.push(entry) } else { changed.push(entry) }
        }
        let roots = self.include_roots(record);
        if !Self::user_status_paths(record, changed, &roots).is_empty() {
            return Ok(Some(kept("dirty")));
        }
        let left = timeout.saturating_sub(started.elapsed());
        let checks = async { (self.modified_include_copies(record, cancel).await, self.unreproducible_ignored(record, ignored, artefacts, cancel).await) };
        match tokio::time::timeout(left, checks).await {
            Err(_) => Ok(Some(kept("busy"))),
            Ok((Err(ScmFailure::Cancelled), _)) | Ok((_, Err(ScmFailure::Cancelled))) => Err(ScmFailure::Cancelled),
            Ok((Ok(modified), Ok(unreproducible))) => {
                if !modified.is_empty() {
                    Ok(Some(kept("dirty")))
                } else if !unreproducible.is_empty() {
                    Ok(Some(ignored_keep(&unreproducible)))
                } else {
                    Ok(None)
                }
            }
            Ok(_) => Ok(Some(kept("busy"))),
        }
    }

    /// One automatic removal of the ready worktree `record`: the slow checks run before the
    /// folder is held; then, under the hold, the lease and `in_use` again, a cheap token
    /// against the one taken before, and one time-bounded full status. Only then is the
    /// deletion decided, `automatic`.
    pub async fn remove_automatically(&self, record: &mut WorktreeRecord, options: &AutoOptions, cancel: &CancellationToken) -> Result<Auto, ScmFailure> {
        let token = self.checkout_token(record, cancel).await?;
        let (dirty, ignored, artefacts) = self.automatic_keep_paths(record, cancel).await?;
        let unmerged = self.checkout_unmerged_count(record, cancel).await?;
        if !dirty.is_empty() || unmerged > 0 {
            return Ok(Auto::Kept(kept(if dirty.is_empty() { "unmerged" } else { "dirty" })));
        }
        // As assert_removable: an operation in progress keeps the checkout.
        if let Ok(opened) = self.scm().open(Path::new(&record.path), cancel).await {
            if operation_in_progress(&opened.identity.git_dir).is_some() {
                return Ok(Auto::Kept(kept("dirty")));
            }
        }
        if !ignored.is_empty() {
            return Ok(Auto::Kept(ignored_keep(&ignored)));
        }
        let grant = match self.hold_folder(record).await {
            Ok(grant) => grant,
            Err(error) if snapshot_in_use(&error) => return Ok(Auto::Kept(kept("in-use"))),
            Err(error) => return Err(error),
        };
        let outcome = self.remove_under_hold(record, options, &token, artefacts, cancel).await;
        self.release_folder(grant).await;
        outcome
    }

    async fn remove_under_hold(&self, record: &mut WorktreeRecord, options: &AutoOptions, token: &str, artefacts: Vec<String>, cancel: &CancellationToken) -> Result<Auto, ScmFailure> {
        if self.lease_alive(record, cancel).await? || options.in_use.in_use(record).await {
            return Ok(Auto::Kept(kept("in-use")));
        }
        if self.checkout_token(record, cancel).await? != token {
            return Ok(Auto::Kept(kept("changed")));
        }
        // The token misses nested untracked files and unstaged edits: one bounded full status
        // decides. Dirty, slow or failed means kept.
        if let Some(verdict) = self.final_dirty_check(record, options.final_check_timeout, artefacts, cancel).await? {
            return Ok(Auto::Kept(verdict));
        }
        self.assert_recovery_stores_clear(record, cancel).await?;
        let head = self.checkout_head_commit(record, cancel).await?;
        record.state = "deleting".into();
        record.extra.remove("removalIncomplete");
        let mut deleting = json!({ "force": false, "automatic": true, "headCommit": head, "startedAt": now_ms(), "remaining": [] });
        if options.preserve_branch {
            deleting["preserveBranch"] = json!(true);
        }
        record.extra.insert("deleting".into(), deleting);
        self.put_record(cancel, record.clone()).await?;
        Ok(Auto::Removed(self.finish_deletion(record, cancel).await?))
    }

    // ----- the entry points --------------------------------------------------------------

    /// Kept reasons of an automatic removal as the typed refusals a request raises.
    pub(crate) fn automatic_refusal(record: &WorktreeRecord, verdict: &Value) -> ScmFailure {
        let reason = verdict.get("reason").and_then(Value::as_str).unwrap_or("in-use");
        match reason {
            "dirty" => errors::dirty(Some(record.id.clone()), None, None, None),
            "ignored" => {
                let files: Vec<String> = verdict.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
                let mut failure = errors::dirty_files(record.id.clone(), files);
                if let ScmFailure::Coded { message, .. } = &mut failure {
                    *message = Some("The worktree holds ignored files no install restores.".into());
                }
                failure
            }
            "unmerged" => errors::unmerged(Some(record.id.clone()), None, None, None),
            other => errors::busy_with("folder-in-use", None, Some(record.id.clone()), Some(other.to_owned())),
        }
    }

    /// The removal of `current`, under its repository lock. Without a `session_id` the owner is
    /// the acting session, as in Node.
    pub async fn remove_locked(&self, current: &mut WorktreeRecord, request: &RemoveRequest, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        Self::assert_not_shared(current, request.session_id.as_deref().or(current.owner_session_id.as_deref()))?;
        // A deleted session's leftover: the verified automatic path, never forced or recursive.
        if request.automatic && !request.force && current.state == "ready" && !is_snapshot(current) {
            let options = AutoOptions { preserve_branch: request.preserve_branch, ..AutoOptions::default() };
            return match self.remove_automatically(current, &options, cancel).await? {
                Auto::Removed(deletion) => Ok(deletion.to_json()),
                Auto::Kept(verdict) => Err(Self::automatic_refusal(current, &verdict)),
            };
        }
        if current.state == "creating" || current.state == "recovery" {
            let (complete, remaining) = self.rollback_record(current, None, cancel).await?;
            return Ok(if complete { json!({ "removed": true }) } else { json!({ "removed": false, "retryable": true, "remaining": remaining }) });
        }
        // Every deletion attempt of a snapshot, a resumed one included, waits for (refuses on) its consumers.
        let grant = if is_snapshot(current) { self.hold_folder(current).await? } else { None };
        let outcome = self.decide_and_finish_deletion(current, request, cancel).await;
        self.release_folder(grant).await;
        outcome
    }

    /// Marks a ready worktree `deleting` (after its guards), then finishes the deletion.
    async fn decide_and_finish_deletion(&self, current: &mut WorktreeRecord, request: &RemoveRequest, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        if current.state == "ready" {
            self.assert_recovery_stores_clear(current, cancel).await?;
            self.assert_managed_path(current, cancel).await?;
            if !request.force {
                let mut view = current.clone();
                view.branch = self.checked_out_branch_of(current, cancel).await?;
                self.assert_removable(&view, cancel).await?;
            }
            let head = self.checkout_head_commit(current, cancel).await?;
            current.state = "deleting".into();
            current.extra.insert(
                "deleting".into(),
                json!({ "force": request.force, "safeOnly": request.safe_only, "headCommit": head, "startedAt": now_ms(), "remaining": [] }),
            );
            self.put_record(cancel, current.clone()).await?;
        }
        Ok(self.finish_deletion(current, cancel).await?.to_json())
    }

    /// Removes a worktree whose owner is gone, on an explicit request: its retention is read
    /// again under the lock, so an owner that came back or a session the store still keeps it
    /// for refuses. `allow_retained` (the user deleting it from the list): a retained session
    /// no longer protects it; a live owner or another session's shared reference still does.
    pub async fn remove_orphaned(&self, entry_id: &str, force: bool, live: &HashSet<String>, retained: &HashSet<String>, allow_retained: bool, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let record = self.record(cancel, entry_id).await?.ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let opened = self.scm().open(&repo_cwd(&record), cancel).await?;
        let _lock = opened.lock_repository().await?;
        let mut current = self
            .record(cancel, entry_id)
            .await?
            .filter(|r| !is_snapshot(r))
            .ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let (owner_live, _, removable) = self.retention_of(&current, live, retained, cancel).await?;
        if owner_live {
            return Err(errors::busy_with(errors::RefusalReason::WorkspaceLease.wire(), None, Some(entry_id.to_owned()), None));
        }
        let request = RemoveRequest { entry_id: entry_id.to_owned(), force, session_id: current.owner_session_id.clone(), ..RemoveRequest::default() };
        if allow_retained {
            self.assert_recovery_stores_clear(&current, cancel).await?;
            return self.remove_locked(&mut current, &request, cancel).await;
        }
        if !removable {
            self.assert_recovery_stores_clear(&current, cancel).await?;
            let sessions = current.owner_session_id.iter().chain(current.shared_session_ids.iter()).cloned().collect();
            return Err(errors::retained_by(sessions));
        }
        self.remove_locked(&mut current, &request, cancel).await
    }

    /// Removes a managed worktree under the repository lock. `expected` pins the record the
    /// caller selected: one that no longer matches (removed, its slug reused) is left alone and
    /// reported `{removed: false, skipped: true}`.
    pub async fn remove_managed(&self, request: RemoveRequest, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let skipped = json!({ "removed": false, "skipped": true });
        let matches = |record: &WorktreeRecord| {
            request.expected.as_ref().is_none_or(|expected| {
                let kind = record.extra.get("kind").and_then(Value::as_str);
                kind == expected.kind.as_deref()
                    && record.extra.get("txId").and_then(Value::as_str) == expected.tx_id.as_deref()
                    && record.extra.get("holderSessionId").and_then(Value::as_str) == expected.holder_session_id.as_deref()
            })
        };
        let Some(record) = self.record(cancel, &request.entry_id).await? else {
            return if request.expected.is_some() { Ok(skipped) } else { Err(errors::missing(Some(request.entry_id.clone()), None, None)) };
        };
        let opened = self.scm().open(&repo_cwd(&record), cancel).await?;
        let _lock = opened.lock_repository().await?;
        let Some(mut current) = self.record(cancel, &request.entry_id).await?.filter(|r| matches(r)) else {
            return if request.expected.is_none() { Err(errors::missing(Some(request.entry_id.clone()), None, None)) } else { Ok(skipped) };
        };
        self.remove_locked(&mut current, &request, cancel).await
    }

    /// Marks an entry disposable: a reconcile may remove it once clean and merged. A deleted
    /// session's mark carries no archive rule.
    pub async fn mark_disposable(&self, entry_id: &str, disposable: bool, cancel: &CancellationToken) -> Result<WorktreeRecord, ScmFailure> {
        let record = self.record(cancel, entry_id).await?.ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let opened = self.scm().open(&repo_cwd(&record), cancel).await?;
        let _lock = opened.lock_repository().await?;
        let mut current = self.record(cancel, entry_id).await?.ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        current.extra.insert("disposable".into(), json!(disposable));
        current.extra.remove("disposableReason");
        self.put_record(cancel, current.clone()).await?;
        Ok(current)
    }

    /// Marks (or unmarks) every ready managed worktree the sessions own disposable: an archived
    /// session's, so a pass deletes it once clean and merged. Snapshots are left alone.
    pub async fn set_session_worktrees_disposable(&self, session_ids: &HashSet<String>, disposable: bool, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let mut changed = Vec::new();
        if session_ids.is_empty() {
            return Ok(changed);
        }
        for record in self.all_records(cancel).await? {
            if is_snapshot(&record) || !record.owner_session_id.as_ref().is_some_and(|id| session_ids.contains(id)) {
                continue;
            }
            let opened = self.scm().open(&repo_cwd(&record), cancel).await?;
            let _lock = opened.lock_repository().await?;
            let Some(mut current) = self.record(cancel, &record.id).await? else { continue };
            let still_owned = current.owner_session_id.as_ref().is_some_and(|id| session_ids.contains(id));
            let marked = current.extra.get("disposable").and_then(Value::as_bool).unwrap_or(false);
            if current.state != "ready" || !still_owned || marked == disposable {
                continue;
            }
            current.extra.insert("disposable".into(), json!(disposable));
            if disposable {
                current.extra.insert("disposableReason".into(), json!("archived"));
            } else {
                current.extra.remove("disposableReason");
            }
            self.put_record(cancel, current.clone()).await?;
            changed.push(current.id);
        }
        Ok(changed)
    }
}

#[derive(Default)]
struct BranchFate {
    deleted: bool,
    head: Option<String>,
    preserved: Option<Value>,
}

/// Pins the record the caller selected.
#[derive(Clone, Debug, Default)]
pub struct Expected {
    pub kind: Option<String>,
    pub tx_id: Option<String>,
    pub holder_session_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RemoveRequest {
    pub entry_id: String,
    pub force: bool,
    pub session_id: Option<String>,
    /// The branch-row "Remove worktree folder": the branch stays, nothing is forced.
    pub safe_only: bool,
    pub expected: Option<Expected>,
    pub automatic: bool,
    pub preserve_branch: bool,
}
