//! Conservative reconcile (daemon startup and the manual prune) and its read-only preview
//! (Node `manager.mjs` `reconcileManagedWorktrees` / `previewManagedWorktreeCleanup`).
//!
//! Always: resumes interrupted deletions, rolls back interrupted creations of no retained
//! session, releases leases of owners that are neither live nor running, prunes stale
//! registrations. `remove_orphans` also removes clean, merged worktrees no stored session
//! retains (or that a deleted session left disposable) and whose owner is not live, never one a
//! session in the store still references. The count/age limits (`maintenance`) add
//! `remove_entry_ids`; favorites and `min_age_ms` exempt those and archived-session marks.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::locks::path_key;
use crate::repo::on_lane;
use crate::worktree::errors;
use crate::worktree::housekeeping::admin_registrations;
use crate::worktree::housekeeping::is_gone;
use crate::worktree::manager::Worktrees;
use crate::worktree::manager::is_snapshot;
use crate::worktree::registry::WorktreeRecord;
use crate::worktree::removal::AutoOptions;
use crate::worktree::removal::Auto;
use crate::worktree::removal::InUse;
use crate::worktree::removal::NeverInUse;
use crate::worktree::removal::snapshot_in_use;

/// The archive and policy rules `cleanup_wants` applies.
#[derive(Clone, Debug, Default)]
pub struct CleanupRules {
    /// Entries the count/age limits selected.
    pub selected: HashSet<String>,
    pub favorites: HashSet<String>,
    pub min_age_ms: i64,
    pub now: i64,
    pub cleanup_archived: bool,
}

#[derive(Clone)]
pub struct ReconcileOptions {
    pub live: HashSet<String>,
    pub retained: HashSet<String>,
    pub remove_orphans: bool,
    pub repo_common_dir: Option<String>,
    pub rules: CleanupRules,
    pub preserve_branch: bool,
    pub max_removals: usize,
    pub in_use: Arc<dyn InUse>,
    pub final_check_timeout: std::time::Duration,
}

impl Default for ReconcileOptions {
    fn default() -> Self {
        Self {
            live: HashSet::new(),
            retained: HashSet::new(),
            remove_orphans: false,
            repo_common_dir: None,
            rules: CleanupRules { cleanup_archived: true, ..CleanupRules::default() },
            preserve_branch: false,
            max_removals: usize::MAX,
            in_use: Arc::new(NeverInUse),
            final_check_timeout: crate::worktree::removal::FINAL_DIRTY_CHECK_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ReconcileReport {
    pub removed: Vec<String>,
    pub recovered: Vec<String>,
    pub kept: Vec<Value>,
    pub leases_released: Vec<String>,
    pub pruned: Vec<String>,
    pub missing: Vec<String>,
    pub errors: Vec<Value>,
}

impl ReconcileReport {
    pub fn to_json(&self) -> Value {
        json!({
            "removed": self.removed, "recovered": self.recovered, "kept": self.kept,
            "leasesReleased": self.leases_released, "pruned": self.pruned,
            "missing": self.missing, "errors": self.errors,
        })
    }
}

/// What Node's `error.message` says: the failure's own text, else its code's contract default.
pub(crate) fn describe(failure: &ScmFailure) -> String {
    if let Some(message) = failure.message() {
        return message.to_owned();
    }
    match failure {
        ScmFailure::Coded { code, detail, .. } => crate::worktree::texts::contract_message(code, detail.as_deref()).map_or_else(|| failure.to_string(), str::to_owned),
        _ => failure.to_string(),
    }
}

/// Whether the automatic pass would try to remove the ready, not-live worktree `record` (the
/// archive and policy rules); the verification (dirty, unmerged, in use) still decides at
/// removal time.
pub fn cleanup_wants(record: &WorktreeRecord, is_retained: bool, rules: &CleanupRules) -> bool {
    let allows = || {
        !record.owner_session_id.iter().chain(record.shared_session_ids.iter()).any(|id| rules.favorites.contains(id))
            && rules.now - record.created_at.max(0) >= rules.min_age_ms
    };
    if !is_retained {
        return true;
    }
    if record.extra.get("disposable").and_then(Value::as_bool) == Some(true) {
        if record.extra.get("disposableReason").and_then(Value::as_str) != Some("archived") {
            return true;
        }
        if rules.cleanup_archived && allows() {
            return true;
        }
    }
    rules.selected.contains(&record.id) && allows()
}

impl Worktrees {
    /// Who keeps `record`: `(owner_live, retained, removable)`. `removable` is what a prune
    /// would remove: neither, or disposable and not live, with no retained recovery data.
    pub async fn retention_of(&self, record: &WorktreeRecord, live: &HashSet<String>, retained: &HashSet<String>, cancel: &CancellationToken) -> Result<(bool, bool, bool), ScmFailure> {
        let snapshot = is_snapshot(record);
        let owner_live = if snapshot {
            self.snapshot_holder_live(record, live, cancel).await?
        } else {
            record.owner_session_id.as_ref().is_some_and(|id| live.contains(id)) || self.lease_alive(record, cancel).await?
        };
        let is_retained = record.owner_session_id.as_ref().is_some_and(|id| retained.contains(id));
        let disposable = record.extra.get("disposable").and_then(Value::as_bool) == Some(true);
        let mut removable = if snapshot {
            !owner_live
        } else {
            record.shared_session_ids.is_empty() && (record.state != "ready" || (!owner_live && (disposable || !is_retained)))
        };
        if removable {
            match self.assert_recovery_stores_clear(record, cancel).await {
                Err(ScmFailure::Coded { code, .. }) if code == errors::WORKTREE_FILE_RECOVERY => removable = false,
                Err(other) => return Err(other),
                Ok(()) => {}
            }
        }
        Ok((owner_live, is_retained, removable))
    }

    /// Repository-wide `git worktree prune`: every registration whose folder is gone is
    /// dropped (git keeps locked ones). Only bookkeeping: no folder is touched.
    async fn prune_stale_registrations(&self, common_dir: &str, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let common = PathBuf::from(common_dir);
        let stale = {
            let common = common.clone();
            on_lane(self.scm().lane, cancel, move || {
                admin_registrations(&common).into_iter().filter(|r| is_gone(&r.worktree_path)).collect::<Vec<_>>()
            })
            .await?
        };
        if stale.is_empty() {
            return Ok(Vec::new());
        }
        let common_text = common.to_string_lossy().into_owned();
        self.scm().git.outcome(cancel, &common, &["--git-dir", &common_text, "worktree", "prune"], &crate::git::RunOptions::default()).await?;
        let gone = on_lane(self.scm().lane, cancel, move || {
            stale.into_iter().filter(|r| !r.admin.exists()).map(|r| r.worktree_path.to_string_lossy().into_owned()).collect::<Vec<_>>()
        })
        .await?;
        Ok(gone)
    }

    /// Read-only counterpart of [`Worktrees::reconcile`]: what a prune with the same options
    /// could act on, from the registry, the retention and the git admin folders alone. A
    /// candidate may still be kept at removal time. Returns the entry ids and the checkout paths
    /// of registrations whose folder is gone.
    pub async fn preview_cleanup(&self, options: &ReconcileOptions, cancel: &CancellationToken) -> Result<(Vec<String>, Vec<String>), ScmFailure> {
        let only = options.repo_common_dir.as_deref().map(|dir| path_key(Path::new(dir)));
        let mut ids = Vec::new();
        let mut repos: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for record in self.all_records(cancel).await? {
            let key = path_key(Path::new(&record.repo_common_dir));
            if only.as_ref().is_some_and(|only| *only != key) {
                continue;
            }
            if seen.insert(key) {
                repos.push(record.repo_common_dir.clone());
            }
            if !record.shared_session_ids.is_empty() {
                continue;
            }
            let (owner_live, is_retained, _) = self.retention_of(&record, &options.live, &options.retained, cancel).await?;
            if is_snapshot(&record) {
                if !owner_live {
                    ids.push(record.id.clone());
                }
            } else if record.state == "deleting" {
                ids.push(record.id.clone());
            } else if record.state == "creating" || record.state == "recovery" {
                if !is_retained {
                    ids.push(record.id.clone());
                }
            } else if !owner_live && (record.extra.contains_key("removalIncomplete") && !record.extra["removalIncomplete"].is_null() || cleanup_wants(&record, is_retained, &options.rules)) {
                ids.push(record.id.clone());
            }
        }
        let mut stale = Vec::new();
        for repo in repos {
            let common = PathBuf::from(&repo);
            let found = on_lane(self.scm().lane, cancel, move || {
                if !common.exists() {
                    return Vec::new();
                }
                admin_registrations(&common)
                    .into_iter()
                    // git keeps a locked registration through prune.
                    .filter(|r| !r.admin.join("locked").exists() && is_gone(&r.worktree_path))
                    .map(|r| r.worktree_path.to_string_lossy().into_owned())
                    .collect()
            })
            .await?;
            stale.extend(found);
        }
        Ok((ids, stale))
    }

    /// The conservative reconcile; see the module docs. One repository at a time, each under
    /// its write lock; a failure of one record or repository is reported, never aborts the rest.
    pub async fn reconcile(&self, options: &ReconcileOptions, cancel: &CancellationToken) -> Result<ReconcileReport, ScmFailure> {
        let mut report = ReconcileReport::default();
        let only = options.repo_common_dir.as_deref().map(|dir| path_key(Path::new(dir)));
        let mut repos: Vec<(String, String, String)> = Vec::new();
        for record in self.all_records(cancel).await? {
            let key = path_key(Path::new(&record.repo_common_dir));
            if only.as_ref().is_some_and(|only| *only != key) || repos.iter().any(|(known, ..)| *known == key) {
                continue;
            }
            repos.push((key, record.repo_common_dir.clone(), record.project_path.clone()));
        }
        let mut budget_used = 0usize;
        for (key, common, project) in repos {
            let present = {
                let common = PathBuf::from(&common);
                on_lane(self.scm().lane, cancel, move || common.exists()).await?
            };
            if !present {
                report.errors.push(json!({ "repoCommonDir": common, "error": "repository missing" }));
                continue;
            }
            let outcome: Result<(), ScmFailure> = async {
                let opened = match self.scm().open(Path::new(&project), cancel).await {
                    Ok(opened) => opened,
                    Err(_) => self.scm().open(Path::new(&common), cancel).await?,
                };
                let _lock = opened.lock_repository().await?;
                let records: Vec<WorktreeRecord> =
                    self.all_records(cancel).await?.into_iter().filter(|r| path_key(Path::new(&r.repo_common_dir)) == key).collect();
                for mut record in records {
                    match self.reconcile_record(&mut record, options, &mut budget_used, &mut report, cancel).await {
                        Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                        Err(error) => report.errors.push(json!({ "id": record.id, "error": describe(&error) })),
                        Ok(()) => {}
                    }
                }
                let pruned = self.prune_stale_registrations(&common, cancel).await?;
                report.pruned.extend(pruned);
                Ok(())
            }
            .await;
            match outcome {
                Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                Err(error) => report.errors.push(json!({ "repoCommonDir": common, "error": describe(&error) })),
                Ok(()) => {}
            }
        }
        Ok(report)
    }

    fn report_deletion(report: &mut ReconcileReport, record: &WorktreeRecord, deletion: &crate::worktree::removal::Deletion) {
        if deletion.removed {
            report.removed.push(record.id.clone());
        } else {
            report.kept.push(json!({
                "id": record.id,
                "reason": if deletion.incomplete { "incomplete" } else { "deleting" },
                "remaining": deletion.remaining,
            }));
        }
    }

    async fn reconcile_record(&self, record: &mut WorktreeRecord, options: &ReconcileOptions, budget_used: &mut usize, report: &mut ReconcileReport, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let is_retained = record.owner_session_id.as_ref().is_some_and(|id| options.retained.contains(id));
        let keep = |report: &mut ReconcileReport, reason: &str| report.kept.push(json!({ "id": record.id, "reason": reason }));
        if !record.shared_session_ids.is_empty() {
            keep(report, "shared");
            return Ok(());
        }
        if record.state == "creating" || record.state == "recovery" {
            if is_retained {
                keep(report, "retained");
                return Ok(());
            }
            // Holding the repository lock proves no creator is still running.
            let (complete, remaining) = self.rollback_record(record, None, cancel).await?;
            if complete {
                report.recovered.push(record.id.clone());
            } else {
                report.kept.push(json!({ "id": record.id, "reason": "recovery", "remaining": remaining }));
            }
            return Ok(());
        }
        if record.state == "deleting" && is_snapshot(record) {
            // An unfinished snapshot deletion: whatever entered the surviving folder since still keeps it.
            let grant = match self.hold_folder(record).await {
                Ok(grant) => grant,
                Err(error) if snapshot_in_use(&error) => {
                    keep(report, "snapshot-in-use");
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            let deletion = self.finish_deletion(record, cancel).await;
            self.release_folder(grant).await;
            Self::report_deletion(report, record, &deletion?);
            return Ok(());
        }
        if record.state == "deleting" && record.extra.get("deleting").and_then(|d| d.get("automatic")).and_then(Value::as_bool) == Some(true) {
            // An automatic removal that was interrupted is never resumed blindly: what it took
            // apart is put back (its recorded undo) and the record is ready again.
            let deleting = record.extra.get("deleting").cloned().unwrap_or(Value::Null);
            let mut not_restored = self.undo_automatic_attempt(record, deleting.get("undo").unwrap_or(&Value::Null), cancel).await;
            let mut remaining: Vec<mixdog_protocol::RemovalRemnant> =
                deleting.get("remaining").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            remaining.append(&mut not_restored);
            let kept_remaining = remaining.clone();
            self.keep_incomplete_removal(record, remaining, "interrupted", cancel).await?;
            report.kept.push(json!({ "id": record.id, "reason": "incomplete", "remaining": kept_remaining }));
            return Ok(());
        }
        if record.state == "deleting" {
            // A decided deletion: its session already left the folder.
            let deletion = self.finish_deletion(record, cancel).await?;
            Self::report_deletion(report, record, &deletion);
            return Ok(());
        }
        if is_snapshot(record) {
            // Read-only and turn-scoped: once its holder is gone it goes, whatever autoCleanup
            // says and whatever was changed in it. A worker or shell still running in it keeps it too.
            let mut grant = None;
            let mut held = false;
            if !self.snapshot_holder_live(record, &options.live, cancel).await? {
                match self.hold_folder(record).await {
                    Ok(taken) => {
                        grant = taken;
                        held = true;
                    }
                    Err(error) if snapshot_in_use(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            if !held {
                keep(report, "snapshot-in-use");
                return Ok(());
            }
            let deleted: Result<crate::worktree::removal::Deletion, ScmFailure> = async {
                self.assert_recovery_stores_clear(record, cancel).await?;
                record.state = "deleting".into();
                record.extra.insert("deleting".into(), json!({ "force": true, "startedAt": now_ms(), "remaining": [] }));
                self.put_record(cancel, record.clone()).await?;
                self.finish_deletion(record, cancel).await
            }
            .await;
            self.release_folder(grant).await;
            Self::report_deletion(report, record, &deleted?);
            return Ok(());
        }
        let lease = self.read_owner_lease(record, cancel).await?;
        let lease_running = lease.as_ref().and_then(|l| l.owner.pid).is_some_and(|pid| crate::worktree::ownership::pid_alive_or_unknown(Some(pid)));
        let owner_live = record.owner_session_id.as_ref().is_some_and(|id| options.live.contains(id)) || lease_running;
        if !owner_live && lease.is_some() {
            self.remove_owner_lease(record, cancel).await?;
            report.leases_released.push(record.id.clone());
        }
        if !Path::new(&record.path).exists() {
            report.missing.push(record.id.clone());
        }
        if options.remove_orphans && !owner_live && cleanup_wants(record, is_retained, &options.rules) {
            // Count, age and archive removals share one budget per pass.
            let archived = record.extra.get("disposableReason").and_then(Value::as_str) == Some("archived");
            let budgeted = is_retained && (options.rules.selected.contains(&record.id) || archived);
            if budgeted && *budget_used >= options.max_removals {
                keep(report, "budget");
                return Ok(());
            }
            let auto = AutoOptions { in_use: options.in_use.clone(), preserve_branch: options.preserve_branch, final_check_timeout: options.final_check_timeout };
            match self.remove_automatically(record, &auto, cancel).await? {
                Auto::Kept(mut verdict) => {
                    verdict["id"] = json!(record.id);
                    report.kept.push(verdict);
                }
                Auto::Removed(deletion) => {
                    Self::report_deletion(report, record, &deletion);
                    if budgeted && deletion.removed {
                        *budget_used += 1;
                    }
                }
            }
        }
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}
