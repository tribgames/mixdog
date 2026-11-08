//! The descendants a command leaves running after its root process ended: listed from the job
//! object (Windows) or process group (Linux), and reported gone by the operating system's own
//! events — the job's "no active processes" message on Windows, one pidfd per member on Linux —
//! never by sampling.
//!
//! `mixdog-tools` implements its `SurvivorWatch` trait over [`ProcessSurvivors`] (the trait
//! lives there, and that crate already depends on this one), method for method:
//! `survivors` → [`ProcessSurvivors::survivors`], `wait_gone` → [`ProcessSurvivors::wait_gone`],
//! `kill` → [`ProcessSurvivors::kill`].

use mixdog_protocol::ProcessHandle;

use crate::contain::Containment;
use crate::manager::LocalProcessManager;

/// Kill-and-observe rounds of a survivor kill before it reports what is left (KILL_ROUNDS of Node).
const KILL_ROUNDS: usize = 3;

/// What a finished command left running.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SurvivorReport {
    /// Whether this process can still signal them.
    pub reachable: bool,
}

/// Survivor observation over one [`LocalProcessManager`]; cheap to clone.
#[derive(Clone)]
pub struct ProcessSurvivors {
    manager: LocalProcessManager,
}

impl ProcessSurvivors {
    pub fn new(manager: LocalProcessManager) -> Self {
        Self { manager }
    }

    /// The survivors of `handle`'s command. `None` when the handle is unknown, its root is still
    /// running, nothing outlived it, or the platform cannot watch them end.
    pub fn survivors(&self, handle: &ProcessHandle) -> Option<SurvivorReport> {
        let proc = self.manager.proc(handle).ok()?;
        if !proc.root_ended() || !proc.containment().watchable() {
            return None;
        }
        proc.containment().remaining().map(|reachable| SurvivorReport { reachable })
    }

    /// Completes when the last survivor has ended (at once if none is left).
    pub async fn wait_gone(&self, handle: &ProcessHandle) {
        if let Ok(proc) = self.manager.proc(handle) {
            proc.containment().wait_empty().await;
        }
    }

    /// Ends them; `true` when a fresh look finds every one gone. This is the cancel's own schedule
    /// (`killShellDescendants`), apart from the passive observation of [`Self::wait_gone`]: the group
    /// gets the gentle stop and its grace, then the forced stop and its wait, then up to three
    /// sweeps (the group again and every observed identity) each followed by a look. Whatever look
    /// finds nothing left settles the kill at once, never at the observer's next re-check.
    pub async fn kill(&self, handle: &ProcessHandle) -> bool {
        let Ok(proc) = self.manager.proc(handle) else {
            return true;
        };
        let containment = proc.containment();
        if containment.remaining().is_none() {
            return true;
        }
        containment.terminate();
        if !containment.gone_within(Containment::TERM_GRACE).await {
            containment.kill();
            containment.gone_within(Containment::SWEEP_WAIT).await;
        }
        for _ in 0..KILL_ROUNDS {
            if containment.remaining().is_none() {
                return true;
            }
            containment.sweep();
            containment.gone_within(Containment::SWEEP_WAIT).await;
        }
        containment.remaining().is_none()
    }
}