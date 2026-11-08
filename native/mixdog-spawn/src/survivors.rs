//! The descendants a command leaves running after its root process ended: seen in the job object
//! (Windows) or by identity in the process table (Linux, macOS), and reported gone by the operating
//! system's own events where it has them (the job's "no active processes" message, one pidfd per
//! survivor), by a re-check every 5 s where it has not.
//!
//! `mixdog-tools` implements its `SurvivorWatch` trait over [`ProcessSurvivors`] (the trait
//! lives there, and that crate already depends on this one), method for method:
//! `survivors` → [`ProcessSurvivors::survivors`], `wait_gone` → [`ProcessSurvivors::wait_gone`],
//! `kill` → [`ProcessSurvivors::kill`].

use mixdog_protocol::ProcessHandle;

use crate::contain::Seen;
use crate::manager::LocalProcessManager;

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
    /// running, nothing outlived it, or the platform cannot watch them. A tree that could not be
    /// inspected is reported as survivors that cannot be signalled, never as none: unknown is not
    /// gone.
    pub fn survivors(&self, handle: &ProcessHandle) -> Option<SurvivorReport> {
        let proc = self.manager.proc(handle).ok()?;
        if !proc.root_ended() || !proc.containment().watchable() {
            return None;
        }
        match proc.containment().observe() {
            Seen::Running { reachable } => Some(SurvivorReport { reachable }),
            Seen::Unknown => Some(SurvivorReport { reachable: false }),
            Seen::Gone => None,
        }
    }

    /// Completes when the last survivor has ended (at once if none is left).
    pub async fn wait_gone(&self, handle: &ProcessHandle) {
        if let Ok(proc) = self.manager.proc(handle) {
            proc.containment().wait_gone().await;
        }
    }

    /// Ends them (`killShellDescendants`); `true` when a fresh look finds every one gone. This is the
    /// cancel's own schedule, apart from the passive observation of [`Self::wait_gone`], and a look
    /// that finds nothing left settles it at once.
    pub async fn kill(&self, handle: &ProcessHandle) -> bool {
        match self.manager.proc(handle) {
            Ok(proc) => proc.containment().cancel().await,
            Err(_) => true,
        }
    }
}