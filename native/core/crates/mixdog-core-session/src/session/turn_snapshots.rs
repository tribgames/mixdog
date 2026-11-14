//! What a session does with the read-only snapshots its turns made (Node
//! `workspace/side-checkouts.mjs`, one instance per session runtime):
//! - **Turn settle.** `settleTurn` calls `turn.releaseWorkspace()` for every admitted turn,
//!   right after the turn's snapshot finish and without waiting for it
//!   (`turn-run/turn-settle.mjs:97`). The release starts `removeTurnSnapshots` for that turn's
//!   snapshots. The removal retries the ones a command still runs in, `snapshotRetryMs` (2 s)
//!   doubling to at most 2^5 times it, and leaves the rest for the prune.
//! - **Runtime end.** The runtime's teardown (`dispose`) stops its cleanups. So does a cleanup
//!   attempt that finds its session closed or no longer hosted there.
//!
//! Here one [`SnapshotCleanups`] serves every thread:
//! - [`TurnSnapshots::turn_settled`] runs where the thread's run ends;
//! - [`TurnSnapshots::runtime_stopped`] runs when the thread's actor stops (unload, close,
//!   delete), stopping that thread's cleanups as its runtime's `dispose` would;
//! - [`TurnSnapshots::dispose`] runs at core shutdown, once the threads were told to stop and
//!   their ingests were waited for.
//!
//! A turn that made no snapshot finds nothing in the engine's ledger, so its release does no
//! work.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_scm::worktree::manager::Worktrees;

use super::worktree::SnapshotCleanups;

pub trait TurnSnapshots: Send + Sync {
    /// The turn that settles next did not complete (it failed or was stopped): said on `SessionDeps.snapshots` itself, right before
    /// `turn_settled`. A decorator that holds another `TurnSnapshots` forwards it when the one it holds needs it.
    fn turn_aborted(&self, _thread: &ThreadId) {}

    /// `turn.releaseWorkspace()`: the settled turn's snapshots are removed, off the caller.
    fn turn_settled(&self, thread: &ThreadId);
    /// The thread's runtime ended: its cleanups stop (the runtime's `dispose`).
    fn runtime_stopped(&self, thread: &ThreadId);
    /// Core shutdown: no cleanup runs on and none starts (`dispose`).
    fn dispose(&self);
}

/// [`TurnSnapshots`] over the worktree engine and the process's one [`SnapshotCleanups`] (the
/// same `Arc` whose `cancel_hook()` the worktree maintenance takes).
pub struct WorktreeTurnSnapshots {
    cleanups: Arc<SnapshotCleanups>,
    worktrees: Arc<Worktrees>,
}

impl WorktreeTurnSnapshots {
    pub fn new(cleanups: Arc<SnapshotCleanups>, worktrees: Arc<Worktrees>) -> Self {
        Self { cleanups, worktrees }
    }
}

impl TurnSnapshots for WorktreeTurnSnapshots {
    fn turn_settled(&self, thread: &ThreadId) {
        // `snapshotRetryMs` is the engine's own 2 s; the cleanup is not awaited.
        let _ = self.cleanups.release(self.worktrees.clone(), thread.as_str(), None);
    }

    fn runtime_stopped(&self, thread: &ThreadId) {
        self.cleanups.cancel(Some(thread.as_str()));
    }

    fn dispose(&self) {
        self.cleanups.dispose();
    }
}
