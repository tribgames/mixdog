//! The managed-worktree maintenance the session runtime drives (Node `worktree-maintenance.mjs`
//! and the daemon's startup reconcile and idle cleanup): the startup reconcile, the periodic
//! cleanup, a deleted session's cleanup and the archive marks. The policy and every removal
//! are `mixdog-scm`'s [`Worktrees`]; this layer supplies what only the session runtime knows:
//! the sessions of this process (each counts as a live owner, read again before each removal)
//! and the stored sessions, favorites, activity and background jobs ([`SessionSource`]).

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_js::json_stringify;
use mixdog_js::slice_utf16;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::CleanupOptions;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::manager::Worktrees;
use serde_json::Value;

/// The ids of every session open in this process.
pub type LiveSessions = Arc<dyn Fn() -> HashSet<String> + Send + Sync>;

/// Stops the snapshot cleanups still retrying for a session (every session's with `None`).
pub type CancelSnapshotCleanups = Arc<dyn Fn(Option<&str>) + Send + Sync>;

pub struct WorktreeMaintenance {
    worktrees: Arc<Worktrees>,
    sessions: Arc<dyn SessionSource>,
    live: LiveSessions,
    cancel_snapshot_cleanups: CancelSnapshotCleanups,
}

fn count(report: &Value, key: &str) -> usize {
    report.get(key).and_then(Value::as_array).map_or(0, Vec::len)
}

fn incomplete_ids(report: &Value) -> Vec<String> {
    report
        .get("kept")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("reason").and_then(Value::as_str) == Some("incomplete"))
        .map(|item| item.get("id").and_then(Value::as_str).unwrap_or("").to_owned())
        .collect()
}

/// The line the daemon logs after the startup reconcile; `None` when nothing happened.
pub fn startup_summary(report: &Value) -> Option<String> {
    let (removed, recovered, pruned) = (count(report, "removed"), count(report, "recovered"), count(report, "pruned"));
    let incomplete = incomplete_ids(report).len();
    let errors = count(report, "errors");
    if removed + recovered + pruned == 0 && incomplete == 0 && errors == 0 {
        return None;
    }
    let mut line = format!("worktree reconcile: removed {removed}, recovered {recovered}, pruned {pruned}, incomplete {incomplete}, errors {errors}");
    if errors > 0 {
        let failures = json_stringify(report.get("errors").unwrap_or(&Value::Null));
        line.push(' ');
        line.push_str(&slice_utf16(&failures, 2000));
    }
    Some(line)
}

/// The line the daemon logs after the periodic cleanup; `None` when nothing happened.
pub fn cleanup_summary(report: &Value) -> Option<String> {
    let (removed, errors) = (count(report, "removed"), count(report, "errors"));
    let incomplete = incomplete_ids(report);
    if removed == 0 && errors == 0 && incomplete.is_empty() {
        return None;
    }
    let ids = if incomplete.is_empty() { String::new() } else { format!(" ({})", incomplete.join(", ")) };
    Some(format!("worktree cleanup: removed {removed}, incomplete {}{ids}, errors {errors}", incomplete.len()))
}

impl WorktreeMaintenance {
    pub fn new(
        worktrees: Arc<Worktrees>,
        sessions: Arc<dyn SessionSource>,
        live: LiveSessions,
        cancel_snapshot_cleanups: CancelSnapshotCleanups,
    ) -> Self {
        Self { worktrees, sessions, live, cancel_snapshot_cleanups }
    }

    /// Every session open here counts as live, read again right before each removal (one that
    /// opened meanwhile keeps its folder).
    fn options(&self) -> CleanupOptions {
        CleanupOptions { live: (self.live)(), current_live: self.live.clone(), ..CleanupOptions::default() }
    }

    /// Daemon startup, off the boot path: resume interrupted deletions and creations, release
    /// stale leases, prune stale registrations; with autoCleanup on, also the automatic
    /// cleanup. Never removes a worktree a session keeps.
    pub async fn reconcile_at_startup(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.worktrees.reconcile_at_startup(&self.sessions, &self.options(), cancel).await
    }

    /// The periodic cleanup (the count/age limits and archive rules once the desktop's
    /// favorites are known), run while no session is mid-turn.
    pub async fn run_cleanup(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.worktrees.run_worktree_cleanup(&self.sessions, &self.options(), cancel).await
    }

    /// After `session_id` was deleted: its snapshots go with it, so no turn cleanup keeps
    /// retrying them, and autoCleanup removes its clean, merged worktree. `None`: it had none.
    pub async fn cleanup_deleted_session(&self, session_id: &str, cancel: &CancellationToken) -> Result<Option<Value>, ScmFailure> {
        (self.cancel_snapshot_cleanups)(Some(session_id));
        self.worktrees.cleanup_deleted_session_worktree(session_id, cancel).await
    }

    /// Archived (or restored) sessions: autoCleanup and cleanupArchived decide whether their
    /// worktrees become disposable.
    pub async fn set_archived_session_worktrees(&self, session_ids: &HashSet<String>, archived: bool, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.worktrees.set_archived_session_worktrees(session_ids, archived, cancel).await
    }
}
