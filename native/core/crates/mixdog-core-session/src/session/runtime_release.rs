//! What a settled worker turn leaves in this process once its session is unloaded
//! (`unloadSessionRuntime`, `runtime/agent/orchestrator/session/manager/session-close.mjs:344`).
//!
//! [`SessionTurns::unload_runtime`](super::agent_registry::SessionTurns) already holds the veto
//! (a running turn or a closing thread keeps everything) and forgets the side question
//! (`forgetSideQuestion(id, { cancel: true })`); this is the rest of the Node function:
//! - `releaseSessionReadCaches(id)`: the session's read snapshots leave memory
//!   ([`ReadState::release_session`], the call `SessionClose` makes for the same step);
//! - `releaseWorkerSnapshots(id)`: the read-only snapshots the worker's turn made are removed,
//!   not waited for, a failure only logged (`void releaseWorkerSnapshots(id).catch(() => {})`).
//!
//! - `_clearSessionRuntime(id)`: the session's entry leaves the runtime map
//!   ([`RuntimeLiveness::remove_entry`]; run-host-41's `TurnLiveness` is the entry's writer and
//!   removes it when its run ends, this removes what a run left). `_stopToolActivityHeartbeat`,
//!   the parent-abort listener and `dropMetricSeenState` of that function have no Rust state.
//!
//! Node's order is kept: read caches, runtime entry, worker snapshots.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_rt::TaskClass;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_services::task_reports::runtime_state::RuntimeLiveness;
use mixdog_tools::fs::ReadState;
use tokio_util::sync::CancellationToken;

use super::agent_registry::RuntimeRelease;

pub struct ThreadRuntimeRelease {
    read_state: Arc<ReadState>,
    liveness: Arc<RuntimeLiveness>,
    worktrees: Arc<Worktrees>,
    stop: CancellationToken,
}

impl ThreadRuntimeRelease {
    /// `read_state`: the tools' one [`ReadState`]; `liveness`: the one [`RuntimeLiveness`]
    /// (`TurnPath.liveness`, run-host-41); `worktrees`: the scm engine's `Worktrees`; `stop`: ends a
    /// snapshot removal that is still retrying when the daemon shuts down.
    pub fn new(read_state: Arc<ReadState>, liveness: Arc<RuntimeLiveness>, worktrees: Arc<Worktrees>, stop: CancellationToken) -> Self {
        Self { read_state, liveness, worktrees, stop }
    }
}

/// `releaseWorkerSnapshots(id)` with the engine's own first delay.
async fn release_worker_snapshots(worktrees: &Worktrees, id: &str, stop: &CancellationToken) {
    if let Err(error) = worktrees.release_worker_snapshots(id, None, stop).await {
        tracing::warn!(thread = %id, "[agent-unload] the worker's snapshots were not released: {error:?}");
    }
}

impl RuntimeRelease for ThreadRuntimeRelease {
    fn release(&self, thread: &ThreadId, _reason: &str) {
        self.read_state.release_session(thread.as_str());
        self.liveness.remove_entry(thread.as_str());
        let (worktrees, id, stop) = (self.worktrees.clone(), thread.as_str().to_owned(), self.stop.clone());
        drop(mixdog_rt::spawn("worker-snapshots", TaskClass::Work, async move { release_worker_snapshots(&worktrees, &id, &stop).await }));
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use std::path::PathBuf;

    use mixdog_rt::CancellationToken;

    use super::*;
    use crate::session::worktree::worktree_tests::rig;

    #[tokio::test]
    async fn the_snapshots_a_worker_made_are_removed_when_its_runtime_is_unloaded() {
        let rig = rig();
        let cancel = CancellationToken::new();
        let entry = rig.worktrees.create_worker_snapshot("worker-1", &rig.repo, "HEAD", "tx-1", false, &cancel).await.unwrap();
        let path = PathBuf::from(entry["path"].as_str().unwrap());
        assert!(path.exists());
        release_worker_snapshots(&rig.worktrees, "worker-1", &cancel).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn an_unloaded_session_leaves_the_runtime_map_and_others_stay() {
        use mixdog_services::task_reports::runtime_state::RuntimeEntry;

        let rig = rig();
        let liveness = RuntimeLiveness::new();
        for id in ["worker-1", "worker-2"] {
            liveness.set_entry(id, RuntimeEntry { stage: Some("streaming".into()), ..RuntimeEntry::default() });
        }
        let release = ThreadRuntimeRelease::new(Arc::new(ReadState::new(None)), liveness.clone(), rig.worktrees.clone(), CancellationToken::new());
        release.release(&ThreadId::from("worker-1"), "agent-turn-complete");
        let working = liveness.in_flight_session_activity().working;
        assert!(!working.contains("worker-1"));
        assert!(working.contains("worker-2"));
    }
}
