//! The daemon's boot coordinator (`standalone/daemon-boot-coordinator.mjs`): the background lane
//! that opens once a client is ready and recovers the sessions that carry an active Goal after
//! a daemon replacement (`recoverActiveGoals`, `:59`), then starts the quota auto-resume clock
//! (`startQuotaResume`, `daemon.mjs:1132`).
//!
//! The lane opens at the first of: a non-desktop client completing its `initialize` (Node: its
//! registration, the ready boundary of a client with no further handshake), or a desktop's app feed
//! going live (Node: `desktop.ready`, after `desktop.init` and the first state resync). A desktop's
//! registration alone opens nothing (Node warms the keychain on it, a step Rust has no counterpart
//! of: its secrets are read where they are used). The lane runs once however many clients arrive.
//! A recovery that fails ends the lane without starting the quota clock, as Node's rejected
//! `recoverActiveGoals` does; a per-session failure is in the summary and never stops the others.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_app_server::ClientHook;
use mixdog_core_goal::goal::recovery::RecoverySource;
use mixdog_core_goal::goal::recovery::RecoverySummary;
use mixdog_core_goal::goal::recovery::recover_active_goals;
use mixdog_core_session::session::quota_resume_scheduler::QuotaResumeScheduler;
use mixdog_protocol::ConnectionKind;
use mixdog_rt::TaskClass;

/// What the lane does, in its order.
#[async_trait]
pub trait BootSteps: Send + Sync {
    /// `recoverActiveGoals()`.
    async fn recover_goals(&self) -> Result<RecoverySummary, String>;
    /// `startQuotaResume()`.
    fn start_quota_resume(&self) -> Result<(), String>;
}

/// The daemon's steps: Goal recovery through the session layer's source, and the quota clock.
pub struct SessionBootSteps {
    pub recovery: Arc<dyn RecoverySource>,
    pub timer: Arc<QuotaResumeScheduler>,
}

#[async_trait]
impl BootSteps for SessionBootSteps {
    async fn recover_goals(&self) -> Result<RecoverySummary, String> {
        Ok(recover_active_goals(self.recovery.as_ref()).await)
    }

    fn start_quota_resume(&self) -> Result<(), String> {
        self.timer.start();
        Ok(())
    }
}

#[derive(Default)]
struct Lane {
    /// A start is queued (Node's `backgroundScheduled`).
    scheduled: bool,
    /// The lane began (Node's `backgroundPromise`).
    started: bool,
    task: Option<tokio::task::JoinHandle<()>>,
}

pub struct BootCoordinator {
    steps: Arc<dyn BootSteps>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    lane: Mutex<Lane>,
}

impl BootCoordinator {
    pub fn new(steps: Arc<dyn BootSteps>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { steps, log, lane: Mutex::new(Lane::default()) })
    }

    /// `scheduleBackground`.
    fn schedule_background(self: &Arc<Self>) {
        let mut lane = self.lane.lock().unwrap_or_else(PoisonError::into_inner);
        if lane.scheduled || lane.started {
            return;
        }
        lane.scheduled = true;
        let me = self.clone();
        lane.task = Some(mixdog_rt::spawn("boot-background", TaskClass::Work, async move {
            {
                let mut lane = me.lane.lock().unwrap_or_else(PoisonError::into_inner);
                lane.scheduled = false;
                lane.started = true;
            }
            me.background().await;
        }));
    }

    /// `startBackground`.
    async fn background(&self) {
        let summary = match self.steps.recover_goals().await {
            Ok(summary) => summary,
            Err(error) => return (self.log)(&format!("active Goal recovery failed: {error}")),
        };
        (self.log)(&format!(
            "active Goal recovery found={} resumed={} skipped={} failed={}",
            summary.found, summary.resumed, summary.skipped, summary.failed
        ));
        if let Err(error) = self.steps.start_quota_resume() {
            (self.log)(&format!("quota resume start failed (non-fatal): {error}"));
        }
    }

    /// The lane has run to its end (or never opened): for tests and for a stop that waits for it.
    pub async fn settled(&self) {
        let task = self.lane.lock().unwrap_or_else(PoisonError::into_inner).task.take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

/// What the server tells the coordinator: Node's `onClientRegistered` (`clientKind`; a desktop
/// only warms the keychain) and `onDesktopReady`.
#[cfg(test)]
#[path = "boot_coordinator_tests.rs"]
mod tests;

pub struct BootHook(pub Arc<BootCoordinator>);

impl ClientHook for BootHook {
    fn registered(&self, kind: ConnectionKind) {
        if kind != ConnectionKind::Desktop {
            self.0.schedule_background();
        }
    }

    fn desktop_ready(&self) {
        self.0.schedule_background();
    }
}
