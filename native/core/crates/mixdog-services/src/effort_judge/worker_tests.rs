//! The judge's own thread: a judgment does not wait for the CPU bulk lane, and judgments of several
//! sessions run one at a time in the order they arrived. The model is a scripted stand-in loaded on
//! the judge's thread (the ONNX model needs the installed runtime).

use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::task::Poll;
use std::time::Duration;

use mixdog_agent::step_effort::{StepEffortJudge, StepInput, StepResult};
use mixdog_rt::{CancellationToken, CpuBulk, InLane, LaneToken};

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::input::TurnInput;
use crate::effort_judge::judge::{Resident, Script};
use crate::effort_judge::ladder::{AutoLadder, StepLadder};
use crate::effort_judge::model::{ModelConfig, OrtRuntime};
use crate::effort_judge::worker::{Alarm, STUCK};
use crate::effort_judge::{EffortJudge, EffortJudgeModel, JudgeLanes, JudgeTiming, TurnVerdict};
use crate::tool_state::StateTick;

const PROBS: [f64; 4] = [0.1, 0.2, 0.3, 0.4];
/// Deadline of a wait that only a hang can outlast.
const HANG: Duration = Duration::from_secs(30);

/// An explicit model folder whose files `available` accepts, trained on steps.
fn installed() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("model.onnx"), b"scripted").unwrap();
    std::fs::write(dir.path().join("tokenizer.json"), b"{}").unwrap();
    std::fs::write(dir.path().join("calibration.json"), br#"{"steps":1}"#).unwrap();
    dir
}

fn config(dir: &Path) -> ModelConfig {
    ModelConfig { dir: dir.to_owned(), explicit: true, ort_library: OrtRuntime::Library(dir.join("ort")) }
}

fn step(request: &str) -> StepInput {
    StepInput { request: request.to_owned(), step: 1, plan: String::new(), calls: Vec::new() }
}

struct Fixed;

impl Resident for Fixed {
    fn probs(&self, _: &StepInput) -> Result<Vec<f64>, JudgeError> {
        Ok(PROBS.to_vec())
    }
    fn turn_probs(&self, _: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        Ok(PROBS.to_vec())
    }
}

/// Every cpu-bulk thread is held by a blocked job and the lane's queue is full: a turn and a step are
/// still judged. The lanes are the real pooled ones (the test backend runs jobs inline), installed for
/// the process, so this test needs a process of its own (nextest).
#[tokio::test(flavor = "multi_thread")]
async fn a_judgment_answers_while_every_cpu_bulk_thread_is_held_and_its_queue_is_full() {
    let mut rt = mixdog_rt::exec::RtConfig::for_cores(4);
    rt.cpu_bulk = mixdog_rt::exec::PoolParams { threads: 1, queue: 1 };
    let (_executors, tokens) = mixdog_rt::exec::boot(rt).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel::<u32>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let hold = |n: u32| {
        let (entered, release) = (entered_tx.clone(), release_rx.clone());
        move |_: &InLane<CpuBulk>| {
            let _ = entered.send(n);
            let _ = release.lock().unwrap().recv();
        }
    };
    let _running = tokens.cpu_bulk.submit(&CancellationToken::new(), hold(1)).expect("the lane takes the first job");
    assert_eq!(entered_rx.recv_timeout(HANG).expect("the first bulk job holds the lane's only thread"), 1);
    let _queued = tokens.cpu_bulk.submit(&CancellationToken::new(), hold(2)).expect("the queue takes one job");
    assert!(tokens.cpu_bulk.submit(&CancellationToken::new(), |_| ()).is_err(), "the lane's queue is full");

    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let script: Script = Arc::new(|| Ok(Arc::new(Fixed) as Arc<dyn Resident>));
    let judge = EffortJudgeModel::scripted(config, JudgeLanes::of(&tokens), script);
    // Waits no healthy judgment comes near: only the lane can make it miss them.
    let timing = JudgeTiming { warm: HANG, queue: HANG, cold: HANG, retry: HANG };
    let turn = tokio::time::timeout(2 * HANG, judge.judge_turn(TurnInput::default(), timing)).await.expect("the turn is judged while cpu-bulk is full");
    assert!(matches!(&turn, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{turn:?}");
    assert!(tokio::time::timeout(HANG, judge.supports_steps()).await.expect("step support is read while cpu-bulk is full"));
    let probs = tokio::time::timeout(HANG, judge.probs(step("s"))).await.expect("the step is judged while cpu-bulk is full").expect("judged");
    assert_eq!(probs, PROBS);
    drop(release_tx);
}

/// Holds each judgment until the test releases it, and logs when each starts and ends.
struct Held {
    log: Mutex<Vec<String>>,
    started: tokio::sync::mpsc::UnboundedSender<String>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl Resident for Held {
    fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError> {
        self.log.lock().unwrap().push(format!("start {}", input.request));
        let _ = self.started.send(input.request.clone());
        self.release.lock().unwrap().recv().expect("the test releases each judgment");
        self.log.lock().unwrap().push(format!("end {}", input.request));
        Ok(PROBS.to_vec())
    }
    fn turn_probs(&self, _: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        Err(JudgeError::Run("only steps are judged here".into()))
    }
}

/// Polls once, so the future takes its place in the judge's queue: `None` while it waits.
fn poll_once<F: Future + Unpin>(future: &mut F) -> Option<F::Output> {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match std::pin::Pin::new(future).poll(&mut cx) {
        Poll::Ready(out) => Some(out),
        Poll::Pending => None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_sessions_judgments_run_one_at_a_time_in_arrival_order() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let (started_tx, mut started) = tokio::sync::mpsc::unbounded_channel();
    let (release, release_rx) = mpsc::channel();
    let held = Arc::new(Held { log: Mutex::default(), started: started_tx, release: Mutex::new(release_rx) });
    let resident = held.clone();
    let script: Script = Arc::new(move || Ok(resident.clone() as Arc<dyn Resident>));
    let model = EffortJudgeModel::scripted(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), script);
    let ladder = Arc::new(AutoLadder { base: "medium".into(), options: vec!["low".into(), "medium".into(), "high".into()] });
    let session = || Arc::new(EffortJudge::new(model.clone(), ladder.clone()));
    let (a, b) = (session(), session());
    let judged = |judge: &Arc<EffortJudge>, request: &'static str| {
        let judge = judge.clone();
        Box::pin(async move { judge.judge(step(request)).await })
    };
    let next_start = async |started: &mut tokio::sync::mpsc::UnboundedReceiver<String>| tokio::time::timeout(HANG, started.recv()).await.expect("a judgment starts").expect("the model lives");

    let a1 = tokio::spawn(judged(&a, "a1"));
    assert_eq!(next_start(&mut started).await, "a1");
    // a1 holds the judge: b1, then a2, take their places behind it.
    let mut b1 = judged(&b, "b1");
    assert!(poll_once(&mut b1).is_none(), "b1 waits while a1 runs");
    let mut a2 = judged(&a, "a2");
    assert!(poll_once(&mut a2).is_none(), "a2 waits while a1 runs");
    let (b1, a2) = (tokio::spawn(b1), tokio::spawn(a2));
    for next in ["b1", "a2"] {
        release.send(()).unwrap();
        assert_eq!(next_start(&mut started).await, next);
    }
    release.send(()).unwrap();
    let want: Option<StepResult> = ladder.resolve(&PROBS);
    assert!(want.is_some());
    for task in [a1, b1, a2] {
        assert_eq!(tokio::time::timeout(HANG, task).await.expect("the judgment answers").unwrap(), want);
    }
    assert_eq!(*held.log.lock().unwrap(), ["start a1", "end a1", "start b1", "end b1", "start a2", "end a2"]);
}

/// The watchdog's clock: time moves only by [`Clock::advance`], which rings every deadline it reaches.
#[derive(Default)]
struct Clock {
    state: Mutex<(Duration, Vec<(Duration, Box<dyn FnOnce() + Send>)>)>,
}

impl Alarm for Clock {
    fn after(&self, delay: Duration, ring: Box<dyn FnOnce() + Send>) {
        let mut state = self.state.lock().unwrap();
        let at = state.0 + delay;
        state.1.push((at, ring));
    }
}

impl Clock {
    fn advance(&self, by: Duration) {
        let due: Vec<_> = {
            let mut state = self.state.lock().unwrap();
            state.0 += by;
            let now = state.0;
            let (due, armed) = std::mem::take(&mut state.1).into_iter().partition(|(at, _)| *at <= now);
            state.1 = armed;
            due
        };
        for (_, ring) in due {
            ring();
        }
    }
}

/// A model the test holds: a judgment whose request starts with "hold" waits for the next release
/// (in the order they started), "boom" panics. Each says on which thread it starts and is dropped.
struct Gated {
    started: tokio::sync::mpsc::UnboundedSender<(String, std::thread::ThreadId)>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
    dropped_on: Arc<Mutex<Vec<std::thread::ThreadId>>>,
}

impl Gated {
    fn judge(&self, request: &str) -> Result<Vec<f64>, JudgeError> {
        let _ = self.started.send((request.to_owned(), std::thread::current().id()));
        if request.starts_with("hold") {
            self.release.lock().unwrap().recv().expect("the test releases each held judgment");
        }
        assert_ne!(request, "boom", "a judgment that panics");
        Ok(PROBS.to_vec())
    }
}

impl Resident for Gated {
    fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError> {
        self.judge(&input.request)
    }
    fn turn_probs(&self, input: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        self.judge(&input.request)
    }
}

impl Drop for Gated {
    fn drop(&mut self) {
        self.dropped_on.lock().unwrap().push(std::thread::current().id());
    }
}

type Threads = (Option<u64>, bool, Option<u64>);

struct Rig {
    judge: Arc<EffortJudgeModel>,
    clock: Arc<Clock>,
    started: tokio::sync::mpsc::UnboundedReceiver<(String, std::thread::ThreadId)>,
    /// Every judgment started, in order.
    log: Vec<String>,
    release: mpsc::Sender<()>,
    loads: Arc<std::sync::atomic::AtomicUsize>,
    dropped_on: Arc<Mutex<Vec<std::thread::ThreadId>>>,
    changes: tokio::sync::watch::Receiver<u64>,
}

/// A judge on the test's clock whose loads make a fresh [`Gated`] model; with `panicking_load`, the
/// first load panics.
fn rig(config: ModelConfig, panicking_load: bool) -> Rig {
    let (started_tx, started) = tokio::sync::mpsc::unbounded_channel();
    let (release, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let loads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let dropped_on = Arc::new(Mutex::new(Vec::new()));
    let (counted, dropped) = (loads.clone(), dropped_on.clone());
    let script: Script = Arc::new(move || {
        let n = counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        assert!(!(panicking_load && n == 1), "load boom");
        Ok(Arc::new(Gated { started: started_tx.clone(), release: release_rx.clone(), dropped_on: dropped.clone() }) as Arc<dyn Resident>)
    });
    let clock = Arc::new(Clock::default());
    let tick = StateTick::default();
    let changes = tick.subscribe();
    let judge = EffortJudgeModel::scripted_on(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), script, clock.clone(), tick);
    Rig { judge, clock, started, log: Vec::new(), release, loads, dropped_on, changes }
}

impl Rig {
    /// The next judgment to start: its request and its thread.
    async fn next_start(&mut self) -> std::thread::ThreadId {
        let (request, thread) = tokio::time::timeout(HANG, self.started.recv()).await.expect("a judgment starts").expect("the model lives");
        self.log.push(request);
        thread
    }

    fn threads(&self) -> Threads {
        self.judge.worker().threads()
    }

    /// Waits, on the judge's state changes, until its threads are `want`.
    async fn threads_become(&mut self, want: Threads) {
        let wait = async {
            loop {
                self.changes.borrow_and_update();
                if self.judge.worker().threads() == want {
                    return;
                }
                self.changes.changed().await.expect("the judge lives");
            }
        };
        tokio::time::timeout(HANG, wait).await.unwrap_or_else(|_| panic!("the judge's threads become {want:?}"));
    }

    fn loads(&self) -> usize {
        self.loads.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn dropped_on(&self) -> Vec<std::thread::ThreadId> {
        self.dropped_on.lock().unwrap().clone()
    }
}

fn turn(request: &str) -> TurnInput {
    TurnInput { request: request.to_owned(), ..TurnInput::default() }
}

/// Waits no healthy judgment comes near.
const PATIENT: JudgeTiming = JudgeTiming { warm: HANG, queue: HANG, cold: HANG, retry: HANG };

const EXITED: &str = "effort judge exited";

/// Node's stuck worker (`judge-client.mjs:181`): a judgment unanswered for `STUCK_MS` gives its thread
/// up; the next judgment runs on a new thread with a freshly loaded model, and the lost thread drops
/// its own model when it returns. Meanwhile the queue is bounded: a job whose caller left is dropped
/// unrun, and one past the bound is answered at once. A second thread that stalls while one is lost
/// is not replaced: every judgment answers at once until one of them returns.
#[tokio::test(flavor = "multi_thread")]
async fn a_stuck_judgment_gives_its_thread_up_at_nodes_watchdog_and_a_fresh_model_takes_over() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, false);
    let judge = rig.judge.clone();

    // s1 holds thread 1; its step's run is cancelled while it runs.
    let first = tokio::spawn({
        let judge = judge.clone();
        async move { judge.probs(step("hold s1")).await }
    });
    let one = rig.next_start().await;
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    // s2 takes the one place behind it; its run is cancelled too, before s2 comes up.
    let mut second = Box::pin(judge.probs(step("s2")));
    assert!(poll_once(&mut second).is_none(), "s2 waits behind s1");
    drop(second);
    // The queue is full: answered at once, as Node answers a turn with no judgment.
    let third = tokio::time::timeout(HANG, judge.probs(step("s3"))).await.expect("a full queue answers at once");
    assert!(matches!(third, Err(JudgeError::Busy)), "{third:?}");
    assert_eq!(
        tokio::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn"),
        TurnVerdict::Skipped("busy".into())
    );

    rig.clock.advance(STUCK - Duration::from_millis(1));
    assert_eq!(rig.threads(), (Some(1), false, None), "not stuck before Node's 10 s");
    assert!(judge.is_ready());
    rig.clock.advance(Duration::from_millis(1));
    assert_eq!(rig.threads(), (None, false, Some(1)), "given up at 10 s");
    assert!(!judge.is_ready());

    // A new thread with a freshly loaded model; the lost thread keeps its own.
    let fourth = tokio::time::timeout(HANG, judge.probs(step("s4"))).await.expect("judged on a new thread");
    assert_eq!(fourth.expect("judged"), PROBS);
    let two = rig.next_start().await;
    assert_ne!(two, one);
    assert_eq!(rig.loads(), 2);
    assert_eq!(rig.threads(), (Some(2), false, Some(1)));

    // Thread 2 stalls while thread 1 is lost: not replaced; its waiter and every later judgment
    // answer at once.
    let fifth = tokio::spawn({
        let judge = judge.clone();
        async move { judge.probs(step("hold s5")).await }
    });
    assert_eq!(rig.next_start().await, two);
    rig.clock.advance(STUCK);
    assert_eq!(rig.threads(), (Some(2), true, Some(1)));
    let fifth = tokio::time::timeout(HANG, fifth).await.expect("the stalled judgment answers at once").unwrap();
    assert!(matches!(fifth, Err(JudgeError::Worker(_))), "{fifth:?}");
    let sixth = tokio::time::timeout(HANG, judge.probs(step("s6"))).await.expect("no judgment, at once");
    assert!(matches!(sixth, Err(JudgeError::Worker(_))), "{sixth:?}");
    assert_eq!(tokio::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn"), TurnVerdict::Skipped(EXITED.into()));
    assert_eq!(rig.loads(), 2);

    // Thread 1 returns: it skips s2, drops its model on itself and ends; the stalled thread 2 is the
    // lost one now, and the next judgment starts thread 3.
    rig.release.send(()).unwrap();
    rig.threads_become((None, false, Some(2))).await;
    assert_eq!(rig.dropped_on(), [one]);
    let seventh = tokio::time::timeout(HANG, judge.probs(step("s7"))).await.expect("judged on thread 3");
    assert_eq!(seventh.expect("judged"), PROBS);
    let three = rig.next_start().await;
    assert!(three != one && three != two);
    assert_eq!(rig.loads(), 3);
    rig.release.send(()).unwrap();
    rig.threads_become((Some(3), false, None)).await;
    assert_eq!(rig.dropped_on(), [one, two]);
    assert_eq!(rig.log, ["hold s1", "s4", "hold s5", "s7"], "s2 was dropped unrun");
    assert!(rig.started.try_recv().is_err());
}

/// A panic in a load is Node's `load-error` (remembered, answered at once); a panic in a judgment is
/// Node's exited worker. Either way the thread is given up and the next load starts a new one.
#[tokio::test(flavor = "multi_thread")]
async fn a_panic_in_a_load_or_a_judgment_answers_at_once_and_a_new_thread_takes_over() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, true);
    let judge = rig.judge.clone();

    let loaded = tokio::time::timeout(HANG, judge.probs(step("s"))).await.expect("a panicking load answers at once");
    assert!(matches!(&loaded, Err(JudgeError::Load(message)) if message == "load boom"), "{loaded:?}");
    assert_eq!(rig.threads(), (None, false, None));
    assert_eq!(
        tokio::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn"),
        TurnVerdict::Skipped("load-error: load boom".into())
    );
    // Past the back-off a turn loads again, on a new thread.
    let retry = JudgeTiming { retry: Duration::ZERO, ..PATIENT };
    let judged = tokio::time::timeout(HANG, judge.judge_turn(turn("t"), retry)).await.expect("a turn");
    assert!(matches!(&judged, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{judged:?}");
    let two = rig.next_start().await;
    assert_eq!((rig.loads(), rig.threads()), (2, (Some(2), false, None)));

    let boom = tokio::time::timeout(HANG, judge.probs(step("boom"))).await.expect("a panicking judgment answers at once");
    assert!(matches!(boom, Err(JudgeError::Worker(_))), "{boom:?}");
    assert_eq!(rig.next_start().await, two);
    assert_eq!(rig.threads(), (None, false, None));
    let after = tokio::time::timeout(HANG, judge.probs(step("s"))).await.expect("judged on a new thread");
    assert_eq!(after.expect("judged"), PROBS);
    let three = rig.next_start().await;
    assert_ne!(three, two);
    assert_eq!((rig.loads(), rig.threads()), (3, (Some(3), false, None)));

    assert_eq!(tokio::time::timeout(HANG, judge.judge_turn(turn("boom"), PATIENT)).await.expect("a turn"), TurnVerdict::Skipped(EXITED.into()));
    assert_eq!(rig.threads(), (None, false, None));
}

/// Node's `shutdownEffortJudge` terminates the worker: the running turn and the one queued behind it
/// answer "effort judge exited". Here the call waits for no thread; the held thread drops its model
/// on itself when its judgment returns, and the next turn loads a new one.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_answers_the_running_and_queued_turns_and_waits_for_no_thread() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, false);
    let judge = rig.judge.clone();

    let first = tokio::spawn({
        let judge = judge.clone();
        async move { judge.judge_turn(turn("hold t1"), PATIENT).await }
    });
    let one = rig.next_start().await;
    let mut second = Box::pin(judge.judge_turn(turn("t2"), PATIENT));
    assert!(poll_once(&mut second).is_none(), "t2 waits behind t1");

    tokio::time::timeout(HANG, judge.shutdown()).await.expect("shutdown waits for no thread");
    assert_eq!(tokio::time::timeout(HANG, first).await.expect("t1 answers at once").unwrap(), TurnVerdict::Skipped(EXITED.into()));
    assert_eq!(tokio::time::timeout(HANG, second).await.expect("t2 answers at once"), TurnVerdict::Skipped(EXITED.into()));
    assert!(!judge.is_ready());
    assert!(rig.dropped_on().is_empty(), "the held thread keeps its model while its judgment runs");

    rig.release.send(()).unwrap();
    rig.threads_become((None, false, None)).await;
    assert_eq!(rig.dropped_on(), [one]);
    let next = tokio::time::timeout(HANG, judge.judge_turn(turn("t3"), PATIENT)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
    assert_ne!(rig.next_start().await, one);
    assert_eq!(rig.loads(), 2);
    assert_eq!(rig.log, ["hold t1", "t3"], "t2 never ran");
}
