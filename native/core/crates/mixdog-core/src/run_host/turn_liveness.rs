//! The writer of the runtime liveness map (`runtime-state.mjs`: the session runtime sets an entry per
//! session it runs and wraps a turn's dispatch in `whileTurnDispatched`). The pool's `running`, the
//! thread list's `working` / `agentWorking` and the report host's `in_flight` read the map; this is
//! its only writer. One [`TurnLiveness`] lives for one run: the dispatched count from the start of
//! the drive, and an entry that follows the run's stage and cancel state until the guard drops.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_services::task_reports::runtime_state::Dispatched;
use mixdog_services::task_reports::runtime_state::RuntimeEntry;
use mixdog_services::task_reports::runtime_state::RuntimeLiveness;
use serde_json::Value;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[must_use = "the run counts as live only while the guard lives"]
pub struct TurnLiveness {
    liveness: Arc<RuntimeLiveness>,
    id: String,
    /// Set under the lock when the guard drops, so a late update of the follower cannot bring the entry back.
    closed: Arc<Mutex<bool>>,
    _dispatched: Dispatched,
}

impl TurnLiveness {
    /// Counts `thread` as dispatched and publishes its entry; `session` is the session record
    /// (`owner`, `agent`, `ownerSessionId`, `parentSessionId`), `cancel` the run's controller.
    pub fn begin(liveness: &Arc<RuntimeLiveness>, thread: &ThreadId, session: Value, mut progress: watch::Receiver<RunProgress>, cancel: CancellationToken) -> Self {
        let id = thread.as_str().to_owned();
        let closed = Arc::new(Mutex::new(false));
        let publish = {
            let (liveness, id, closed) = (liveness.clone(), id.clone(), closed.clone());
            move |stage: Option<String>, cancel: &CancellationToken| {
                let closed = closed.lock().unwrap_or_else(PoisonError::into_inner);
                if !*closed {
                    liveness.set_entry(&id, RuntimeEntry { closed: false, controller_live: !cancel.is_cancelled(), stage, session: session.clone() });
                }
            }
        };
        publish(progress.borrow().stage(), &cancel);
        drop(mixdog_rt::spawn("turn-liveness", mixdog_rt::TaskClass::Work, async move {
            // Ends when the run's progress sender is dropped (the drive is over).
            while progress.changed().await.is_ok() {
                publish(progress.borrow().stage(), &cancel);
            }
        }));
        Self { liveness: liveness.clone(), _dispatched: liveness.dispatched(&id), id, closed }
    }
}

impl Drop for TurnLiveness {
    fn drop(&mut self) {
        let mut closed = self.closed.lock().unwrap_or_else(PoisonError::into_inner);
        *closed = true;
        self.liveness.remove_entry(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::env::Clock;
    use mixdog_core_run::run_host::progress::ProgressPublisher;

    use super::*;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_000
        }
    }

    async fn working(liveness: &RuntimeLiveness, id: &str, want: bool) {
        for _ in 0..1_000 {
            if liveness.in_flight_session_activity().working.contains(id) == want {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("{id} never became working = {want}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_run_is_working_while_its_stage_is_in_flight_and_gone_when_the_guard_drops() {
        let liveness = RuntimeLiveness::new();
        let (tx, rx) = watch::channel(RunProgress::default());
        let publisher = ProgressPublisher::new(tx, Arc::new(Fixed));
        let thread = ThreadId::from("t1");
        let guard = TurnLiveness::begin(&liveness, &thread, serde_json::json!({ "owner": "user" }), rx, CancellationToken::new());
        // The dispatched count covers the gap before any stage: the turn is working at once.
        assert!(liveness.in_flight_session_activity().working.contains("t1"));
        publisher.ask_start();
        publisher.stage("streaming");
        working(&liveness, "t1", true).await;
        drop(guard);
        working(&liveness, "t1", false).await;
        assert!(liveness.in_flight_session_activity().agent_working.is_empty());
    }
}