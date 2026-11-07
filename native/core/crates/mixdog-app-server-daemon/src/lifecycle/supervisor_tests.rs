//! The release supervisor: a wedged or panicking release step never keeps the process alive, and
//! the step that wedged is named in `last-exit.json`. No sleeps: the wedged step blocks on a
//! channel nobody sends to, and its budget is zero, so it is over budget the moment it starts.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures use blocking std")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use super::*;
use super::testing::Recorder;

/// A step that cannot be over budget in a test.
const AMPLE: Duration = Duration::from_secs(3600);

#[derive(Clone, Copy)]
enum Fault {
    Wedge,
    Panic,
}

/// Delegates to the recorder except for the step named `fault.0`, which wedges or panics.
struct Faulty {
    inner: Arc<Recorder>,
    fault: (&'static str, Fault),
    hold: Mutex<mpsc::Receiver<()>>,
    flushes: Arc<AtomicU32>,
}

impl Faulty {
    fn at(&self, step: &str) {
        if self.fault.0 != step {
            return;
        }
        match self.fault.1 {
            Fault::Wedge => {
                // Nobody sends: this returns only when the test drops the sender at its end.
                let _ = self.hold.lock().unwrap().recv();
            }
            Fault::Panic => panic!("injected failure in {step}"),
        }
    }
}

impl CorePort for Faulty {
    fn drain_notice(&self, notice: &DrainNotice) {
        self.inner.drain_notice(notice);
    }
    fn health(&self, stalled_ms: u64) {
        self.inner.health(stalled_ms);
    }
    fn cancel_running(&self, running: &[Running]) {
        self.inner.cancel_running(running);
    }
    fn release_decision(&self, pid: u32) {
        self.inner.release_decision(pid);
    }
    fn final_barriers(&self) {
        self.at("final_barriers");
        self.inner.final_barriers();
    }
    fn close_connections(&self) {
        self.at("close_connections");
        self.inner.close_connections();
    }
    fn close_ext_host(&self) {
        self.at("close_ext_host");
        self.inner.close_ext_host();
    }
    fn close_data_handles(&self) {
        self.at("close_data_handles");
        self.inner.close_data_handles();
    }
    fn flush_log(&self) {
        self.flushes.fetch_add(1, Ordering::SeqCst);
    }
}

/// Every budget ample except the one of `step`, which is zero.
fn budgets(step: &str) -> ReleaseBudgets {
    let pick = |name: &str| if name == step { Duration::ZERO } else { AMPLE };
    ReleaseBudgets {
        final_barriers: pick("final_barriers"),
        close_connections: pick("close_connections"),
        close_ext_host: pick("close_ext_host"),
        record_exit: AMPLE,
        withdraw_discovery: AMPLE,
        close_data_handles: pick("close_data_handles"),
    }
}

struct Run {
    recorder: Arc<Recorder>,
    root: tempfile::TempDir,
    flushes: Arc<AtomicU32>,
    /// Dropping it lets a wedged step thread end.
    _unwedge: mpsc::Sender<()>,
}

/// Serves, then drops the only client: an idle core stops and the release runs.
fn release_with(fault: (&'static str, Fault), budgets: ReleaseBudgets) -> Run {
    let recorder = Arc::new(Recorder::default());
    let root = tempfile::tempdir().unwrap();
    let (unwedge, hold) = mpsc::channel();
    let flushes = Arc::new(AtomicU32::new(0));
    let lifecycle = Lifecycle::with_budgets(
        LifecycleConfig { instance_id: "instance-1".into(), version: "1.4.6".into(), runtime_root: root.path().to_owned() },
        Ports {
            core: Arc::new(Faulty { inner: recorder.clone(), fault, hold: Mutex::new(hold), flushes: flushes.clone() }),
            discovery: recorder.clone(),
            exiter: recorder.clone(),
        },
        budgets,
    );
    lifecycle.set_serving().unwrap();
    drop(lifecycle.connection(crate::lifecycle::ClientKind::Session));
    Run { recorder, root, flushes, _unwedge: unwedge }
}

fn last_exit(root: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(root.join(LAST_EXIT_FILE)).unwrap()).unwrap()
}

#[test]
fn a_wedged_release_step_is_named_and_the_process_still_exits() {
    for (step, name) in [
        ("final_barriers", "finalBarriers"),
        ("close_connections", "closeConnections"),
        ("close_ext_host", "closeExtHost"),
        ("close_data_handles", "closeDataHandles"),
    ] {
        let run = release_with((step, Fault::Wedge), budgets(step));
        run.recorder.wait_exit();
        let exit = last_exit(run.root.path());
        assert_eq!(exit["stuckStep"], name, "{step}");
        assert_eq!(exit["reason"], "noClients", "{step}");
        // Node's exit hook writes the queued log tail on a forced exit too: the flush does not depend on the skipped steps.
        assert_eq!(run.flushes.load(Ordering::SeqCst), 1, "the log is flushed once before the exit after {step} wedged");
        let events = run.recorder.events();
        assert!(events.contains(&"withdraw".to_owned()), "discovery is withdrawn after {step} wedged: {events:?}");
        if step != "close_data_handles" {
            assert!(!events.contains(&"close_data_handles".to_owned()), "the closing steps after {step} are skipped: {events:?}");
        }
    }
}

#[test]
fn a_panicking_release_step_does_not_stop_the_release() {
    let run = release_with(("close_connections", Fault::Panic), budgets(""));
    run.recorder.wait_exit();
    let events = run.recorder.events();
    assert!(events.contains(&"close_ext_host".to_owned()), "{events:?}");
    assert!(events.contains(&"close_data_handles".to_owned()), "{events:?}");
    assert!(last_exit(run.root.path()).get("stuckStep").is_none());
}

/// An async step is supervised on its own thread, and its wait is a timer of the runtime: under
/// paused time the budget runs out by itself, with nothing slept.
#[tokio::test(start_paused = true)]
async fn an_async_step_over_its_budget_is_abandoned_at_the_budget() {
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let started = tokio::time::Instant::now();
    let end = supervise_async("held", Duration::from_secs(30), async move {
        let _ = held.await;
    })
    .await;
    assert_eq!(end, StepEnd::OverBudget);
    assert_eq!(started.elapsed(), Duration::from_secs(30));
    // The abandoned step ends when its wait does.
    drop(release);
}

#[tokio::test(start_paused = true)]
async fn an_async_step_that_ends_inside_its_budget_finished() {
    let (done, finished) = tokio::sync::oneshot::channel::<()>();
    let end = supervise_async("quick", AMPLE, async move {
        let _ = done.send(());
    })
    .await;
    assert_eq!(end, StepEnd::Finished);
    assert!(finished.await.is_ok(), "the step ran to its end");
}

#[tokio::test(start_paused = true)]
async fn an_async_step_that_panics_is_reported_and_the_caller_goes_on() {
    let end = supervise_async("broken", AMPLE, async { panic!("injected failure in an async step") }).await;
    assert_eq!(end, StepEnd::Panicked);
}

#[test]
fn a_clean_release_names_no_stuck_step() {
    let run = release_with(("none", Fault::Wedge), budgets(""));
    run.recorder.wait_exit();
    assert!(last_exit(run.root.path()).get("stuckStep").is_none());
}
