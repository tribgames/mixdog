//! The C0 control plane of a thread (RL §5.3, D-L1, SPEC R10–R12): what RT-C reads and
//! touches without the actor. The actor republishes the cell when the run, the queue or the
//! set of decidable approvals changes (from its projected state), and RT-C answers abort,
//! steer and decisions from it at once; the actor's control lane carries the follow-up.

use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use arc_swap::ArcSwap;
use arc_swap::ArcSwapOption;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::thread::Decision;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use super::seams::RunOutcome;
use super::view::SessionView;

/// Messages of the actor's control lane, polled before everything else.
pub(crate) enum Ctl {
    /// The run's token is already cancelled; the actor resolves the run's own requests.
    Abort { turn: TurnId },
    /// Steer entries were pushed into the active run's steer queue.
    Steer,
    Decide(Decision),
    RunEnded { turn: TurnId, outcome: RunOutcome },
    /// The user's "Retry storage" (SM §8 `PendingRollback`).
    RetryStorage,
    /// A tool-policy input outside the thread changed (a setting, a connector policy).
    RefreshSurface,
}

/// The active run as RT-C sees it.
pub(crate) struct ActiveRun {
    pub turn: TurnId,
    pub cancel: CancellationToken,
    /// Queue entries marked steer, waiting for the run's next model-call boundary.
    pub steers: Mutex<VecDeque<QueuedId>>,
}

pub(crate) struct ControlCell {
    pub thread: ThreadId,
    pub run: ArcSwapOption<ActiveRun>,
    /// Queue entries that exist (projected).
    pub queued: ArcSwap<HashSet<String>>,
    /// Approval ids that accept a decision.
    pub approvals: ArcSwap<HashSet<u64>>,
    /// The acked view (thread/read, resume results).
    pub view: ArcSwap<SessionView>,
    pub ctl_tx: mpsc::Sender<Ctl>,
    pub steer_cap: usize,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ControlCell {
    fn not_active(&self, turn: Option<&TurnId>) -> CoreError {
        CoreError::TurnNotActive {
            thread_id: self.thread.clone(),
            turn_id: turn.cloned(),
        }
    }

    fn send(&self, ctl: Ctl) -> Result<(), CoreError> {
        self.ctl_tx.try_send(ctl).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => CoreError::QueueFull {
                queue: "control".into(),
            },
            mpsc::error::TrySendError::Closed(_) => CoreError::ThreadClosing {
                thread_id: self.thread.clone(),
            },
        })
    }

    /// `turn/interrupt` → `{cancelRequested: true, turnId}` (R12). The run stops at its next
    /// poll; its `run{interrupted}` record follows through the control reserve.
    pub fn interrupt(&self, turn: &TurnId) -> Result<Value, CoreError> {
        let run = self.run.load_full();
        let Some(run) = run.filter(|run| &run.turn == turn) else {
            return Err(self.not_active(Some(turn)));
        };
        self.send(Ctl::Abort { turn: turn.clone() })?;
        run.cancel.cancel();
        Ok(json!({ "cancelRequested": true, "turnId": turn }))
    }

    /// `turn/steer{expectedTurnId, queuedId}` → `{accepted: true, queuedId}` (R10, R12).
    pub fn steer(&self, expected: &TurnId, queued: QueuedId) -> Result<Value, CoreError> {
        let run = self.run.load_full();
        let Some(run) = run.filter(|run| &run.turn == expected) else {
            return Err(self.not_active(Some(expected)));
        };
        if !self.queued.load().contains(queued.as_str()) {
            return Err(CoreError::QueuedEntryNotFound {
                thread_id: self.thread.clone(),
                queued_id: queued,
            });
        }
        {
            let mut steers = lock(&run.steers);
            if !steers.contains(&queued) {
                if steers.len() >= self.steer_cap {
                    return Err(CoreError::QueueFull {
                        queue: "steer".into(),
                    });
                }
                steers.push_back(queued.clone());
            }
        }
        self.send(Ctl::Steer)?;
        Ok(json!({ "accepted": true, "queuedId": queued }))
    }

    /// A server-request response. A request that is not decidable (unknown, resolved or
    /// resolving) is a no-op: its `serverRequest/resolved` reaches every connection anyway.
    pub fn decide(&self, decision: Decision) -> Result<(), CoreError> {
        let decidable = crate::approvals::parse_id(&decision.request)
            .is_some_and(|aid| self.approvals.load().contains(&aid.0));
        if !decidable {
            return Ok(());
        }
        self.send(Ctl::Decide(decision))
    }

    pub fn publish_run(&self, run: Option<Arc<ActiveRun>>) {
        self.run.store(run);
    }
}
