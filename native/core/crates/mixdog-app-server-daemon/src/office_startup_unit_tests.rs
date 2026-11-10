//! The sweep's own rules (one at a time, a bound on an unanswered host, none after one that did not finish), against a stand-in
//! host. What the sweep removes is Node's recording, replayed in `compose/office_startup_tests.rs`.

use std::sync::atomic::AtomicUsize;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtWorkerId;
use mixdog_core_api::domain::ext::ExtWorkerStatus;
use mixdog_core_session::session::runtime_hooks::NoRuntimeHooks;
use tokio::sync::mpsc;

use super::*;

/// The failure path of every wait below; no passing run comes near it.
const WAIT: Duration = Duration::from_secs(30);

/// A call the host took: it answers what the test sends, and reports when the core lets go of it.
struct Taken {
    frames: mpsc::UnboundedReceiver<ExtFrame>,
    dropped: mpsc::UnboundedSender<()>,
}

#[async_trait]
impl EventSource<ExtFrame> for Taken {
    async fn next(&mut self) -> Option<ExtFrame> {
        self.frames.recv().await
    }
}

impl Drop for Taken {
    fn drop(&mut self) {
        let _ = self.dropped.send(());
    }
}

struct Host {
    /// `None` for a host that cannot start.
    taken: Option<mpsc::UnboundedSender<mpsc::UnboundedSender<ExtFrame>>>,
    asked: mpsc::UnboundedSender<()>,
    dropped: mpsc::UnboundedSender<()>,
    count: AtomicUsize,
}

impl ExtPool for Host {
    fn call(&self, _: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        self.count.fetch_add(1, Ordering::AcqRel);
        let _ = self.asked.send(());
        let Some(taken) = &self.taken else {
            return Err(ExtError::Unavailable { reason: "no host on this machine".to_owned() });
        };
        let (answer, frames) = mpsc::unbounded_channel();
        let _ = taken.send(answer);
        Ok(Box::new(Taken { frames, dropped: self.dropped.clone() }))
    }

    fn status(&self) -> Vec<ExtWorkerStatus> {
        Vec::new()
    }

    fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
        Ok(())
    }
}

struct Rig {
    hooks: Arc<OfficeStartup>,
    host: Arc<Host>,
    taken: mpsc::UnboundedReceiver<mpsc::UnboundedSender<ExtFrame>>,
    asked: mpsc::UnboundedReceiver<()>,
    dropped: mpsc::UnboundedReceiver<()>,
}

fn rig(host_starts: bool) -> Rig {
    mixdog_rt::testing::tokens();
    let (taken_tx, taken) = mpsc::unbounded_channel();
    let (asked_tx, asked) = mpsc::unbounded_channel();
    let (dropped_tx, dropped) = mpsc::unbounded_channel();
    let host = Arc::new(Host { taken: host_starts.then_some(taken_tx), asked: asked_tx, dropped: dropped_tx, count: AtomicUsize::new(0) });
    let hooks = OfficeStartup::new(Arc::new(NoRuntimeHooks), host.clone(), "unused".to_owned());
    Rig { hooks, host, taken, asked, dropped }
}

fn thread(name: &str) -> ThreadId {
    ThreadId::from(name)
}

#[tokio::test]
async fn sessions_starting_during_a_sweep_ask_the_host_once_and_a_start_after_it_sweeps_again() {
    let mut rig = rig(true);
    let mut completed = completions().subscribe();
    rig.hooks.started(&thread("a"));
    let answer = tokio::time::timeout(WAIT, rig.taken.recv()).await.expect("the first session start asked the host for no sweep within 30 s").unwrap();
    rig.hooks.started(&thread("b"));
    rig.hooks.started(&thread("c"));
    answer.send(ExtFrame::Done(Ok(serde_json::Value::Null))).unwrap();
    tokio::time::timeout(WAIT, completed.recv()).await.expect("the sweep did not end within 30 s of the host's answer").unwrap();
    assert_eq!(rig.host.count.load(Ordering::Acquire), 1, "the sessions that started during the sweep asked the host again");

    rig.hooks.started(&thread("d"));
    tokio::time::timeout(WAIT, rig.taken.recv()).await.expect("a session start after a finished sweep asked the host for none within 30 s").unwrap();
    assert_eq!(rig.host.count.load(Ordering::Acquire), 2);
}

#[tokio::test(start_paused = true)]
async fn a_sweep_the_host_never_answers_is_let_go_at_its_limit_and_no_other_is_started() {
    let mut rig = rig(true);
    rig.hooks.started(&thread("a"));
    let _unanswered = tokio::time::timeout(WAIT, rig.taken.recv()).await.expect("the session start asked the host for no sweep within 30 s").unwrap();
    tokio::time::advance(SWEEP_LIMIT - Duration::from_millis(1)).await;
    assert!(rig.dropped.try_recv().is_err(), "the call was let go before its limit");
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::time::timeout(WAIT, rig.dropped.recv()).await.expect("the unanswered call was not let go at its limit").unwrap();

    rig.hooks.started(&thread("b"));
    assert_eq!(rig.hooks.sweeps.0.load(Ordering::Acquire), GIVEN_UP, "a session start after a sweep that did not finish began another");
    assert_eq!(rig.host.count.load(Ordering::Acquire), 1);
}

/// The real pool takes the call and, when its worker cannot start, answers it with an error (`mixdog-exthost` pool.rs `fail`).
#[tokio::test]
async fn a_host_that_answers_the_sweep_with_an_error_is_asked_once_in_a_core_run() {
    let mut rig = rig(true);
    rig.hooks.started(&thread("a"));
    let answer = tokio::time::timeout(WAIT, rig.taken.recv()).await.expect("the session start asked the host for no sweep within 30 s").unwrap();
    answer.send(ExtFrame::Done(Err(ExtError::Unavailable { reason: "extension worker failed to start".to_owned() }))).unwrap();
    tokio::time::timeout(WAIT, rig.dropped.recv()).await.expect("the sweep did not end within 30 s of the host's error").unwrap();

    rig.hooks.started(&thread("b"));
    assert_eq!(rig.hooks.sweeps.0.load(Ordering::Acquire), GIVEN_UP, "a session start after a sweep the host failed began another");
    assert_eq!(rig.host.count.load(Ordering::Acquire), 1);
}

/// A start that arrives while a sweep is failing must not begin one in the gap between its failure and its end.
#[test]
fn a_start_cannot_begin_between_a_sweeps_failure_and_its_end() {
    let sweeps = Sweeps::default();
    assert!(sweeps.begin());
    assert!(!sweeps.begin(), "a second sweep began while one ran");
    sweeps.end(false);
    assert!(!sweeps.begin(), "a sweep began after one that did not finish");

    let sweeps = Sweeps::default();
    assert!(sweeps.begin());
    sweeps.end(true);
    assert!(sweeps.begin(), "no sweep began after one that finished");
}

#[tokio::test]
async fn a_host_that_cannot_start_is_asked_once_in_a_core_run() {
    let mut rig = rig(false);
    rig.hooks.started(&thread("a"));
    tokio::time::timeout(WAIT, rig.asked.recv()).await.expect("the session start asked the host for no sweep within 30 s").unwrap();
    // The refusal is taken in the same poll that asked, so the next start sees it.
    rig.hooks.started(&thread("b"));
    assert_eq!(rig.hooks.sweeps.0.load(Ordering::Acquire), GIVEN_UP, "a session start after a refused sweep began another");
    assert_eq!(rig.host.count.load(Ordering::Acquire), 1);
}
