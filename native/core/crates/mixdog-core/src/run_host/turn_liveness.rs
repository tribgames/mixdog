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
use tokio_util::sync::DropGuard;

#[must_use = "the run counts as live only while the guard lives"]
pub struct TurnLiveness {
    liveness: Arc<RuntimeLiveness>,
    id: String,
    /// Set under the lock when the guard drops, so a late update of the follower cannot bring the entry back.
    closed: Arc<Mutex<bool>>,
    _dispatched: Dispatched,
    /// Ends the follower when the guard drops: the progress sender it watches is the thread's, which outlives the run.
    _stop: DropGuard,
    /// The follower task, for the tests to await.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl TurnLiveness {
    /// Counts `thread` as dispatched and publishes its entry; the entry's session record is
    /// [`RuntimeEntry::session_of`] `header`, `cancel` the run's controller.
    pub fn begin(liveness: &Arc<RuntimeLiveness>, thread: &ThreadId, header: &serde_json::Map<String, Value>, mut progress: watch::Receiver<RunProgress>, cancel: CancellationToken) -> Self {
        let id = thread.as_str().to_owned();
        let closed = Arc::new(Mutex::new(false));
        let session = RuntimeEntry::session_of(header);
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
        let stop = CancellationToken::new();
        let done = stop.clone();
        let watcher = mixdog_rt::spawn("turn-liveness", mixdog_rt::TaskClass::Work, async move {
            // Ends when the guard drops (the drive is over), or when the progress sender is gone.
            loop {
                tokio::select! {
                    _ = done.cancelled() => return,
                    changed = progress.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                publish(progress.borrow().stage(), &cancel);
            }
        });
        #[cfg(not(any(test, feature = "test-support")))]
        drop(watcher);
        Self {
            liveness: liveness.clone(),
            _dispatched: liveness.dispatched(&id),
            id,
            closed,
            _stop: stop.drop_guard(),
            #[cfg(any(test, feature = "test-support"))]
            watcher: Mutex::new(Some(watcher)),
        }
    }

    /// Returns once the follower has published every progress change and ended. It ends when its guard
    /// drops or the run's progress sender is gone; the guard lives while this is awaited, so here it is the sender.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    async fn watcher_ended(&self) {
        let watcher = self.watcher.lock().unwrap_or_else(PoisonError::into_inner).take().expect("awaited once");
        mixdog_core_session::session::testing::awaiting(|| "the follower to publish the last progress and end".to_owned(), watcher).await.unwrap();
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_run_is_working_while_its_stage_is_in_flight_and_gone_when_the_guard_drops() {
        // `begin` spawns its watcher on the lane runtime: installed here as every test of the tree that spawns does.
        let _tokens = mixdog_rt::testing::tokens();
        let liveness = RuntimeLiveness::new();
        let (tx, rx) = watch::channel(RunProgress::default());
        let publisher = ProgressPublisher::new(tx, Arc::new(Fixed));
        let thread = ThreadId::from("t1");
        let header = serde_json::json!({ "owner": "user" });
        let guard = TurnLiveness::begin(&liveness, &thread, header.as_object().expect("a header"), rx, CancellationToken::new());
        // The dispatched count covers the gap before any stage: the turn is working at once.
        assert!(liveness.in_flight_session_activity().working.contains("t1"));
        publisher.ask_start();
        publisher.stage("streaming");
        // The sender is gone, so the follower ends once it has published the stage.
        drop(publisher);
        guard.watcher_ended().await;
        assert!(liveness.in_flight_session_activity().working.contains("t1"));
        drop(guard);
        assert!(!liveness.in_flight_session_activity().working.contains("t1"));
        assert!(liveness.in_flight_session_activity().agent_working.is_empty());
    }

    /// The progress sender a run watches is the thread's (the actor's `ControlCell` holds it for the thread's life), so it
    /// outlives every run: each run's follower ends with its guard and leaves no task, no copy of the session and no hold of
    /// the map behind (Node's `whileTurnDispatched` keeps nothing of a settled turn).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_runs_follower_ends_with_its_guard_while_the_threads_progress_sender_lives_on() {
        let _tokens = mixdog_rt::testing::tokens();
        let liveness = RuntimeLiveness::new();
        let (tx, _rx) = watch::channel(RunProgress::default());
        let publisher = ProgressPublisher::new(tx.clone(), Arc::new(Fixed));
        let thread = ThreadId::from("worker");
        let header = serde_json::json!({ "owner": "agent", "ownerSessionId": "lead", "deferredToolCatalog": [{ "name": "shell" }] });
        for run in 0..3 {
            let guard = TurnLiveness::begin(&liveness, &thread, header.as_object().expect("a header"), tx.subscribe(), CancellationToken::new());
            // The record fields the activity read looks at are carried.
            assert!(liveness.in_flight_session_activity().agent_working.contains("lead"), "run {run}");
            publisher.stage("streaming");
            let watcher = guard.watcher.lock().unwrap_or_else(PoisonError::into_inner).take().expect("the follower");
            drop(guard);
            mixdog_core_session::session::testing::awaiting(|| format!("run {run}'s follower to end with its guard"), watcher).await.unwrap();
            assert_eq!(Arc::strong_count(&liveness), 1, "run {run} left a hold of the map behind");
            assert!(!liveness.in_flight_session_activity().working.contains("worker"), "run {run}");
        }
    }
}