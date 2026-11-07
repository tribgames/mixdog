//! The running snapshot cleanups of settled turns (Node `side-checkouts.mjs`
//! `removeTurnSnapshots` and its `snapshotCleanups` map). A turn that made read-only snapshots
//! starts [`SnapshotCleanups::release`] when it settles: the removal retries, with a doubling
//! delay, the ones a command still runs in. A deleted session stops its cleanups
//! ([`SnapshotCleanups::cancel`], the `CancelSnapshotCleanups` hook of the worktree
//! maintenance) and so does the runtime's teardown ([`SnapshotCleanups::dispose`]); what is left
//! is the prune's and the startup reconcile's.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use mixdog_scm::worktree::manager::Worktrees;
use tokio::task::JoinHandle;

use super::worktree_maintenance::CancelSnapshotCleanups;

#[derive(Default)]
pub struct SnapshotCleanups {
    /// Cleanup id → (its session, its stop).
    running: Mutex<HashMap<u64, (String, CancellationToken)>>,
    next: AtomicU64,
    disposed: AtomicBool,
}

impl SnapshotCleanups {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, (String, CancellationToken)>> {
        self.running.lock().expect("snapshot cleanups")
    }

    /// The cleanups still running.
    pub fn running(&self) -> usize {
        self.lock().len()
    }

    /// `session_id`'s turn settled: removes the snapshots it made, off the caller. `retry_ms` is
    /// the first retry delay (`None`: the engine's own). `None` back once the runtime is disposed.
    pub fn release(self: &Arc<Self>, worktrees: Arc<Worktrees>, session_id: &str, retry_ms: Option<u64>) -> Option<JoinHandle<()>> {
        let cancel = CancellationToken::new();
        let key = {
            // Under the lock, so a dispose that follows sees this cleanup.
            let mut running = self.lock();
            if self.disposed.load(Ordering::SeqCst) {
                return None;
            }
            let key = self.next.fetch_add(1, Ordering::Relaxed);
            running.insert(key, (session_id.to_owned(), cancel.clone()));
            key
        };
        let (this, session) = (self.clone(), session_id.to_owned());
        Some(mixdog_rt::spawn("worktree.snapshot-cleanup", TaskClass::Work, async move {
            if let Err(error) = worktrees.release_turn_snapshots(&session, retry_ms, &cancel).await {
                // Cancelled, or the engine failed: the rest is the maintenance's.
                tracing::debug!(?error, session, "turn snapshot cleanup ended early");
            }
            this.lock().remove(&key);
        }))
    }

    /// Stops the cleanups of `session_id` (every session's when `None`).
    pub fn cancel(&self, session_id: Option<&str>) {
        for (owner, stop) in self.lock().values() {
            if session_id.is_none_or(|id| id == owner.as_str()) {
                stop.cancel();
            }
        }
    }

    /// Runtime teardown: no cleanup runs on and none starts.
    pub fn dispose(&self) {
        let running = self.lock();
        self.disposed.store(true, Ordering::SeqCst);
        for (_, stop) in running.values() {
            stop.cancel();
        }
    }

    /// The hook `WorktreeMaintenance::new` takes.
    pub fn cancel_hook(self: &Arc<Self>) -> CancelSnapshotCleanups {
        let this = self.clone();
        Arc::new(move |session_id| this.cancel(session_id))
    }
}

#[cfg(test)]
#[path = "worktree_snapshots_tests.rs"]
mod tests;
