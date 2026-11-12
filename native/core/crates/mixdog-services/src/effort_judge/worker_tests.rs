//! The judge's own thread: a judgment does not wait for the CPU bulk lane, and judgments of several
//! sessions run one at a time in the order they arrived. The model is a scripted stand-in loaded on
//! the judge's thread (the ONNX model needs the installed runtime).

use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::task::Poll;
use std::thread::ThreadId;
use std::time::Duration;

use mixdog_agent::step_effort::{StepEffortJudge, StepInput, StepResult};
use mixdog_rt::{CancellationToken, CpuBulk, InLane, LaneToken};

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::input::TurnInput;
use crate::effort_judge::judge::{JudgeOptions, KEEP_WARM, RELOAD_WAIT, Resident, Script};
use crate::effort_judge::ladder::{AutoLadder, StepLadder};
use crate::effort_judge::model::{ModelConfig, OrtRuntime};
use crate::effort_judge::worker::{Alarm, STUCK, Stopper, THREADS};
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
    fn stopper(&self) -> Stopper {
        Arc::new(|| ())
    }
}

/// Every cpu-bulk thread is held by a blocked job and the lane's queue is full: a turn and a step are
/// still judged. The lanes are the real pooled ones (the test backend runs jobs inline), installed for
/// the process, so this test needs a process of its own (nextest).
#[tokio::test(flavor = "multi_thread")]
async fn a_judgment_answers_while_every_cpu_bulk_thread_is_held_and_its_queue_is_full() {
    let mut rt = mixdog_rt::exec::RtConfig::for_cores(4);
    rt.cpu_bulk = mixdog_rt::exec::PoolParams::fixed(1, 1, 1);
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
    let turn = mixdog_rt::time::timeout(2 * HANG, judge.judge_turn(TurnInput::default(), timing)).await.expect("the turn is judged while cpu-bulk is full");
    assert!(matches!(&turn, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{turn:?}");
    assert!(mixdog_rt::time::timeout(HANG, judge.supports_steps()).await.expect("step support is read while cpu-bulk is full"));
    let probs = mixdog_rt::time::timeout(HANG, judge.probs(step("s"))).await.expect("the step is judged while cpu-bulk is full").expect("judged");
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
    fn stopper(&self) -> Stopper {
        Arc::new(|| ())
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
    let next_start = async |started: &mut tokio::sync::mpsc::UnboundedReceiver<String>| mixdog_rt::time::timeout(HANG, started.recv()).await.expect("a judgment starts").expect("the model lives");

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
        assert_eq!(mixdog_rt::time::timeout(HANG, task).await.expect("the judgment answers").unwrap(), want);
    }
    assert_eq!(*held.log.lock().unwrap(), ["start a1", "end a1", "start b1", "end b1", "start a2", "end a2"]);
}

/// The watchdog's clock: time moves only by [`Clock::advance`], which rings every deadline it reaches.
#[derive(Default)]
pub(crate) struct Clock {
    state: Mutex<(Duration, Vec<(Duration, Box<dyn FnOnce() + Send>)>)>,
    /// Told whenever a deadline is armed.
    armed: std::sync::Condvar,
    /// When set, the next watchdog to ring says so and waits here before it decides.
    gate: Mutex<Option<(tokio::sync::oneshot::Sender<()>, mpsc::Receiver<()>)>>,
}

impl Alarm for Clock {
    fn after(&self, delay: Duration, ring: Box<dyn FnOnce() + Send>) {
        let mut state = self.state.lock().unwrap();
        let at = state.0 + delay;
        state.1.push((at, ring));
        self.armed.notify_all();
    }

    fn watchdog_rang(&self) {
        let gate = self.gate.lock().unwrap().take();
        if let Some((paused, resume)) = gate {
            paused.send(()).unwrap();
            resume.recv().expect("the test resumes the watchdog");
        }
    }
}

impl Clock {
    /// Blocks until a deadline `delay` after the clock's start is armed, or `within` of real time
    /// has passed (the answer says which).
    pub(crate) fn wait_armed(&self, delay: Duration, within: Duration) -> bool {
        let state = self.state.lock().unwrap();
        let (_state, result) = self.armed.wait_timeout_while(state, within, |state| !state.1.iter().any(|(at, _)| *at == delay)).unwrap();
        !result.timed_out()
    }

    pub(crate) fn advance(&self, by: Duration) {
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

/// What ends a held run: the model's stopper, as ONNX Runtime's terminate flag ends a running one.
#[derive(Default)]
struct Stop {
    stopped: Mutex<bool>,
    wake: std::sync::Condvar,
}

/// A model the test holds: a judgment whose request starts with "hold" runs until the model is
/// stopped and then fails as a terminated run does; "wait" runs until [`Rig::finish_run`], whatever
/// the stopper does; "boom" panics. Each says on which thread it starts and is dropped.
struct Gated {
    started: tokio::sync::mpsc::UnboundedSender<(String, ThreadId)>,
    stop: Arc<Stop>,
    finish: Arc<Mutex<mpsc::Receiver<()>>>,
    dropped_on: Arc<Mutex<Vec<ThreadId>>>,
}

impl Gated {
    fn judge(&self, request: &str) -> Result<Vec<f64>, JudgeError> {
        let _ = self.started.send((request.to_owned(), std::thread::current().id()));
        if request.starts_with("wait") {
            self.finish.lock().unwrap().recv().expect("the test finishes each waiting run");
            if *self.stop.stopped.lock().unwrap() {
                return Err(JudgeError::Run("Exiting due to terminate flag being set to true.".into()));
            }
        }
        if request.starts_with("hold") {
            let mut stopped = self.stop.stopped.lock().unwrap();
            while !*stopped {
                stopped = self.stop.wake.wait(stopped).unwrap();
            }
            return Err(JudgeError::Run("Exiting due to terminate flag being set to true.".into()));
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
    fn stopper(&self) -> Stopper {
        let stop = self.stop.clone();
        Arc::new(move || {
            *stop.stopped.lock().unwrap() = true;
            stop.wake.notify_all();
        })
    }
}

impl Drop for Gated {
    fn drop(&mut self) {
        self.dropped_on.lock().unwrap().push(std::thread::current().id());
    }
}

/// How the rig's model loads behave.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Loads {
    Free,
    /// The first load panics.
    PanicFirst,
    /// Each load waits for [`Rig::finish_load`], which no stopper ends: a runtime cannot stop a load.
    Held,
}

/// (thread taking jobs, threads let go that have not ended).
type Threads = (Option<u64>, usize);

struct Rig {
    judge: Arc<EffortJudgeModel>,
    clock: Arc<Clock>,
    started: tokio::sync::mpsc::UnboundedReceiver<(String, ThreadId)>,
    /// Every judgment started, in order.
    log: Vec<String>,
    load_started: tokio::sync::mpsc::UnboundedReceiver<ThreadId>,
    finish: mpsc::Sender<Result<(), String>>,
    finish_run: mpsc::Sender<()>,
    loads: Arc<AtomicUsize>,
    dropped_on: Arc<Mutex<Vec<ThreadId>>>,
    changes: tokio::sync::watch::Receiver<u64>,
}

/// A judge with Node's waits, every one on the test's clock, whose loads make a fresh [`Gated`] model.
fn rig(config: ModelConfig, mode: Loads) -> Rig {
    let (started_tx, started) = tokio::sync::mpsc::unbounded_channel();
    let (load_started_tx, load_started) = tokio::sync::mpsc::unbounded_channel();
    let (finish, finish_rx) = mpsc::channel::<Result<(), String>>();
    let finish_rx = Mutex::new(finish_rx);
    let (finish_run, run_rx) = mpsc::channel::<()>();
    let run_rx = Arc::new(Mutex::new(run_rx));
    let loads = Arc::new(AtomicUsize::new(0));
    let dropped_on = Arc::new(Mutex::new(Vec::new()));
    let (counted, dropped) = (loads.clone(), dropped_on.clone());
    let script: Script = Arc::new(move || {
        let n = counted.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = load_started_tx.send(std::thread::current().id());
        assert!(!(mode == Loads::PanicFirst && n == 1), "load boom");
        if mode == Loads::Held {
            finish_rx.lock().unwrap().recv().expect("the test finishes each held load").map_err(JudgeError::Load)?;
        }
        Ok(Arc::new(Gated { started: started_tx.clone(), stop: Arc::default(), finish: run_rx.clone(), dropped_on: dropped.clone() }) as Arc<dyn Resident>)
    });
    let clock = Arc::new(Clock::default());
    let tick = StateTick::default();
    let changes = tick.subscribe();
    let options = JudgeOptions { tick, ..JudgeOptions::default() };
    let judge = EffortJudgeModel::scripted_on(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), script, clock.clone(), options);
    Rig { judge, clock, started, log: Vec::new(), load_started, finish, finish_run, loads, dropped_on, changes }
}

impl Rig {
    /// The next judgment to start: its thread.
    async fn next_start(&mut self) -> ThreadId {
        let (request, thread) = mixdog_rt::time::timeout(HANG, self.started.recv()).await.expect("a judgment starts").expect("the model lives");
        self.log.push(request);
        thread
    }

    /// The next load to start: its thread.
    async fn next_load(&mut self) -> ThreadId {
        mixdog_rt::time::timeout(HANG, self.load_started.recv()).await.expect("a load starts").expect("the script lives")
    }

    /// Ends the oldest held load (or the next one) with `outcome`.
    fn finish_load(&self, outcome: Result<(), &str>) {
        self.finish.send(outcome.map_err(str::to_owned)).unwrap();
    }

    /// Ends the oldest "wait" run (or the next one).
    fn finish_run(&self) {
        self.finish_run.send(()).unwrap();
    }

    fn threads(&self) -> Threads {
        self.judge.worker().threads()
    }

    /// Waits, on the judge's state changes, until `done` holds.
    async fn until(&mut self, what: &str, done: impl Fn(&EffortJudgeModel) -> bool) {
        let wait = async {
            loop {
                self.changes.borrow_and_update();
                if done(&self.judge) {
                    return;
                }
                self.changes.changed().await.expect("the judge lives");
            }
        };
        mixdog_rt::time::timeout(HANG, wait).await.unwrap_or_else(|_| panic!("waiting for {what}"));
    }

    /// Waits until the judge's threads are `want`.
    async fn threads_become(&mut self, want: Threads) {
        self.until(&format!("threads {want:?}"), |judge| judge.worker().threads() == want).await;
    }

    fn loads(&self) -> usize {
        self.loads.load(Ordering::SeqCst)
    }

    fn dropped_on(&self) -> Vec<ThreadId> {
        self.dropped_on.lock().unwrap().clone()
    }
}

fn turn(request: &str) -> TurnInput {
    TurnInput { request: request.to_owned(), ..TurnInput::default() }
}

/// Waits no healthy judgment comes near.
const PATIENT: JudgeTiming = JudgeTiming { warm: HANG, queue: HANG, cold: HANG, retry: HANG };

const EXITED: &str = "effort judge exited";

const MS: Duration = Duration::from_millis(1);

/// Node ends a worker whose judgment has not answered for `STUCK_MS` (`judge-client.mjs:182`) and
/// the next turn starts a fresh one. Here the runtime's stop ends the stuck run, its thread drops its
/// model on itself and ends, and the next judgment loads a fresh model on a new thread: ten stalls in
/// a row, each recovered, and the eleventh judgment answers with one thread left.
#[tokio::test(flavor = "multi_thread")]
async fn ten_stuck_judgments_are_each_stopped_at_nodes_watchdog_and_a_fresh_model_answers_the_next() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Free);
    let judge = rig.judge.clone();
    for n in 1..=10u64 {
        let held = tokio::spawn({
            let judge = judge.clone();
            async move { judge.judge_turn(turn("hold"), PATIENT).await }
        });
        let thread = rig.next_start().await;
        rig.clock.advance(STUCK - MS);
        assert_eq!(rig.threads(), (Some(n), 0), "stall {n}: still running before Node's 10 s");
        assert!(!held.is_finished());
        rig.clock.advance(MS);
        assert_eq!(rig.threads().0, None, "stall {n}: let go at 10 s");
        assert_eq!(mixdog_rt::time::timeout(HANG, held).await.expect("the stuck turn answers").unwrap(), TurnVerdict::Skipped(EXITED.into()), "stall {n}");
        rig.threads_become((None, 0)).await;
        assert_eq!(rig.dropped_on().last(), Some(&thread), "stall {n}: the model is dropped on its own thread");
    }
    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
    assert_eq!((rig.loads(), rig.threads()), (11, (Some(11), 0)));
}

/// The watchdog's check and its stop are one decision about one run: a watchdog that rang for the
/// first run and is held before deciding, while that run ends and a second starts on the same
/// thread, stops nothing when it resumes. The second run answers and no model is loaded again.
#[tokio::test(flavor = "multi_thread")]
async fn a_watchdog_that_rings_as_its_run_ends_leaves_the_next_run_alone() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Free);
    let judge = rig.judge.clone();
    let judged = |request: &'static str| {
        let judge = judge.clone();
        tokio::spawn(async move { judge.judge_turn(turn(request), PATIENT).await })
    };

    let first = judged("wait 1");
    rig.next_start().await;
    let (paused_tx, paused) = tokio::sync::oneshot::channel();
    let (resume, resume_rx) = mpsc::channel();
    *rig.clock.gate.lock().unwrap() = Some((paused_tx, resume_rx));
    let clock = rig.clock.clone();
    let ringing = tokio::task::spawn_blocking(move || clock.advance(STUCK));
    mixdog_rt::time::timeout(HANG, paused).await.expect("the first run's watchdog rings").unwrap();

    rig.finish_run();
    let answered = mixdog_rt::time::timeout(HANG, first).await.expect("the first run answers").unwrap();
    assert!(matches!(&answered, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{answered:?}");
    let second = judged("wait 2");
    rig.next_start().await;
    resume.send(()).unwrap();
    mixdog_rt::time::timeout(HANG, ringing).await.expect("the watchdog decides").unwrap();

    assert_eq!(rig.threads(), (Some(1), 0), "the thread still takes jobs");
    rig.finish_run();
    let answered = mixdog_rt::time::timeout(HANG, second).await.expect("the second run answers").unwrap();
    assert!(matches!(&answered, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{answered:?}");
    assert_eq!((rig.loads(), rig.threads()), (1, (Some(1), 0)));
    assert_eq!(rig.log, ["wait 1", "wait 2"]);
}

/// Every way a thread stops being the worker is counted until it ends, and at most [`THREADS`] are
/// alive. A load cannot be stopped: fifty shutdowns during a load that never returns hold two
/// threads, and every load past them answers at once.
#[tokio::test(flavor = "multi_thread")]
async fn fifty_shutdowns_during_loads_that_never_return_hold_at_most_two_threads() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Held);
    let judge = rig.judge.clone();
    for cycle in 0..50 {
        let verdict = tokio::spawn({
            let judge = judge.clone();
            async move { judge.judge_turn(turn("t"), PATIENT).await }
        });
        if cycle < THREADS {
            rig.next_load().await;
        }
        mixdog_rt::time::timeout(HANG, judge.shutdown()).await.expect("shutdown waits for no load");
        assert_eq!(mixdog_rt::time::timeout(HANG, verdict).await.expect("the turn answers at once").unwrap(), TurnVerdict::Skipped("warming".into()), "cycle {cycle}");
        let (current, retiring) = rig.threads();
        assert!(usize::from(current.is_some()) + retiring <= THREADS, "cycle {cycle}: {:?}", rig.threads());
    }
    assert_eq!((rig.loads(), rig.threads()), (THREADS, (None, THREADS)));
    for _ in 0..THREADS {
        rig.finish_load(Ok(()));
    }
    rig.threads_become((None, 0)).await;
    assert_eq!(rig.dropped_on().len(), THREADS, "each late model is dropped on its own thread");
    rig.finish_load(Ok(()));
    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
    assert_eq!((rig.loads(), rig.threads()), (THREADS + 1, (Some(THREADS as u64 + 1), 0)));
}

/// A load still running when the judge shuts down stores nothing when it ends, success or failure,
/// and shutdown answers without waiting for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_load_cut_short_by_shutdown_stores_nothing_and_holds_no_exit() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Held);
    let judge = rig.judge.clone();
    for outcome in [Err("late failure"), Ok(())] {
        let verdict = tokio::spawn({
            let judge = judge.clone();
            async move { judge.judge_turn(turn("t"), PATIENT).await }
        });
        let loader = rig.next_load().await;
        let before = judge.status();
        mixdog_rt::time::timeout(HANG, judge.shutdown()).await.expect("shutdown waits for no load");
        assert_eq!(mixdog_rt::time::timeout(HANG, verdict).await.expect("the turn answers at once").unwrap(), TurnVerdict::Skipped("warming".into()));
        assert_eq!(rig.threads(), (None, 1), "the loading thread is counted, not waited for");
        rig.finish_load(outcome);
        rig.threads_become((None, 0)).await;
        let after = judge.status();
        assert!(!after.ready && after.last_error.is_empty() && before.last_error.is_empty(), "{outcome:?}: {}", after.last_error);
        if outcome.is_ok() {
            assert_eq!(rig.dropped_on(), [loader], "the late model is dropped on its own thread");
        }
    }
    // Nothing was remembered: the next judgment loads without a load-error back-off.
    rig.finish_load(Ok(()));
    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
}

/// Node's waits, each on the judge's clock (`judge-client.mjs` at `bb8c5e3b7`): a model still loading
/// after `COLD_WAIT_MS` answers `warming`; an answer later than `WARM_TIMEOUT_MS` after sending
/// answers `timeout` while its judgment keeps the queue; judgments queue behind it, turns and steps
/// alike, and each answers `busy` after `QUEUE_WAIT_MS` unsent; `STUCK_MS` after sending, the
/// worker is let go and the next judgment loads a fresh model.
#[tokio::test(flavor = "multi_thread")]
async fn nodes_waits_answer_warming_timeout_busy_and_end_the_worker_on_the_judges_clock() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Held);
    let judge = rig.judge.clone();
    let node = JudgeTiming::default();
    assert_eq!((node.cold, node.queue, node.warm, STUCK), (3000 * MS, 1000 * MS, 500 * MS, 10_000 * MS));

    let mut cold = Box::pin(judge.judge_turn(turn("t0"), node));
    assert!(poll_once(&mut cold).is_none());
    rig.next_load().await;
    rig.clock.advance(node.cold - MS);
    assert!(poll_once(&mut cold).is_none(), "loading, inside the cold wait");
    rig.clock.advance(MS);
    assert_eq!(poll_once(&mut cold), Some(TurnVerdict::Skipped("warming".into())));
    rig.finish_load(Ok(()));
    rig.until("the model is ready", EffortJudgeModel::is_ready).await;

    let mut sent = Box::pin(judge.judge_turn(turn("hold t1"), node));
    assert!(poll_once(&mut sent).is_none());
    rig.next_start().await;
    let mut queued_turn = Box::pin(judge.judge_turn(turn("t2"), node));
    let mut queued_step = Box::pin(judge.probs(step("s3")));
    assert!(poll_once(&mut queued_turn).is_none() && poll_once(&mut queued_step).is_none(), "both queue behind t1");
    rig.clock.advance(node.warm - MS);
    assert!(poll_once(&mut sent).is_none());
    rig.clock.advance(MS);
    assert_eq!(poll_once(&mut sent), Some(TurnVerdict::Skipped("timeout".into())));
    rig.clock.advance(node.queue - node.warm - MS);
    assert!(poll_once(&mut queued_turn).is_none() && poll_once(&mut queued_step).is_none(), "t1's judgment still holds the queue");
    rig.clock.advance(MS);
    assert_eq!(poll_once(&mut queued_turn), Some(TurnVerdict::Skipped("busy".into())));
    assert!(matches!(poll_once(&mut queued_step), Some(Err(JudgeError::Busy))));

    rig.clock.advance(STUCK - node.queue - MS);
    assert_eq!(rig.threads(), (Some(1), 0), "the worker runs t1 until Node's 10 s");
    rig.clock.advance(MS);
    rig.threads_become((None, 0)).await;
    rig.finish_load(Ok(()));
    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t4"), node)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
    rig.next_start().await;
    assert_eq!(rig.loads(), 2);
    assert_eq!(rig.log, ["hold t1", "t4"], "t2 and s3 were never sent");
}

/// A panic in a load is Node's `load-error` (remembered, answered at once); a panic in a judgment is
/// Node's exited worker. Either way the thread is let go and the next load starts a new one.
#[tokio::test(flavor = "multi_thread")]
async fn a_panic_in_a_load_or_a_judgment_answers_at_once_and_a_new_thread_takes_over() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::PanicFirst);
    let judge = rig.judge.clone();

    let loaded = mixdog_rt::time::timeout(HANG, judge.probs(step("s"))).await.expect("a panicking load answers at once");
    assert!(matches!(&loaded, Err(JudgeError::Load(message)) if message == "load boom"), "{loaded:?}");
    rig.threads_become((None, 0)).await;
    assert_eq!(
        mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn"),
        TurnVerdict::Skipped("load-error: load boom".into())
    );
    // Past the back-off a turn loads again, on a new thread.
    let retry = JudgeTiming { retry: Duration::ZERO, ..PATIENT };
    let judged = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t"), retry)).await.expect("a turn");
    assert!(matches!(&judged, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{judged:?}");
    let two = rig.next_start().await;
    assert_eq!((rig.loads(), rig.threads()), (2, (Some(2), 0)));

    let boom = mixdog_rt::time::timeout(HANG, judge.probs(step("boom"))).await.expect("a panicking judgment answers at once");
    assert!(matches!(boom, Err(JudgeError::Worker(_))), "{boom:?}");
    assert_eq!(rig.next_start().await, two);
    rig.threads_become((None, 0)).await;
    let after = mixdog_rt::time::timeout(HANG, judge.probs(step("s"))).await.expect("judged on a new thread");
    assert_eq!(after.expect("judged"), PROBS);
    let three = rig.next_start().await;
    assert_ne!(three, two);
    assert_eq!((rig.loads(), rig.threads()), (3, (Some(3), 0)));

    assert_eq!(mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("boom"), PATIENT)).await.expect("a turn"), TurnVerdict::Skipped(EXITED.into()));
    rig.threads_become((None, 0)).await;
}

/// Node's `shutdownEffortJudge` terminates the worker: the running turn and the one queued behind it
/// answer "effort judge exited". Here the call waits for no thread: the running inference is stopped,
/// the thread drops its model on itself and ends, and the next turn loads a new one.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_answers_the_running_and_queued_turns_and_waits_for_no_thread() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Free);
    let judge = rig.judge.clone();

    let first = tokio::spawn({
        let judge = judge.clone();
        async move { judge.judge_turn(turn("hold t1"), PATIENT).await }
    });
    let one = rig.next_start().await;
    let mut second = Box::pin(judge.judge_turn(turn("t2"), PATIENT));
    assert!(poll_once(&mut second).is_none(), "t2 waits behind t1");

    mixdog_rt::time::timeout(HANG, judge.shutdown()).await.expect("shutdown waits for no thread");
    assert_eq!(mixdog_rt::time::timeout(HANG, first).await.expect("t1 answers at once").unwrap(), TurnVerdict::Skipped(EXITED.into()));
    assert_eq!(mixdog_rt::time::timeout(HANG, second).await.expect("t2 answers at once"), TurnVerdict::Skipped(EXITED.into()));
    assert!(!judge.is_ready());
    rig.threads_become((None, 0)).await;
    assert_eq!(rig.dropped_on(), [one]);
    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("t3"), PATIENT)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
    assert_ne!(rig.next_start().await, one);
    assert_eq!(rig.loads(), 2);
    assert_eq!(rig.log, ["hold t1", "t3"], "t2 never ran");
}

/// A judge loaded by one answered turn (its model free to load).
async fn loaded_rig(config: ModelConfig) -> Rig {
    let mut rig = rig(config, Loads::Free);
    let first = mixdog_rt::time::timeout(HANG, rig.judge.judge_turn(turn("t1"), PATIENT)).await.expect("a turn");
    assert!(matches!(&first, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{first:?}");
    rig.threads_become((Some(1), 0)).await;
    rig
}

/// The model is unloaded after `KEEP_WARM` (the embedder's six minutes) without a judgment, to the
/// millisecond on the judge's clock, and a prewarm alone starts the period.
#[tokio::test(flavor = "multi_thread")]
async fn a_model_nobody_judges_with_is_unloaded_after_six_minutes() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Free);
    assert!(mixdog_rt::time::timeout(HANG, rig.judge.prewarm()).await.expect("prewarm"));
    rig.until("the prewarm loaded the model", EffortJudgeModel::is_ready).await;
    rig.clock.advance(KEEP_WARM - MS);
    assert!(rig.judge.is_ready(), "still warm a millisecond before the period ends");
    rig.clock.advance(MS);
    rig.threads_become((None, 0)).await;
    assert!(!rig.judge.is_ready());
    assert_eq!(rig.dropped_on().len(), 1, "the model is dropped with its thread");
    // A judgment after the unload is a cold start: one more load.
    let next = mixdog_rt::time::timeout(HANG, rig.judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{next:?}");
    assert_eq!(rig.loads(), 2);
}

/// Every judgment renews the period: the model of a session that judges every five minutes stays.
#[tokio::test(flavor = "multi_thread")]
async fn a_judgment_restarts_the_idle_period() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let rig = loaded_rig(config).await;
    rig.clock.advance(KEEP_WARM - MS);
    let again = mixdog_rt::time::timeout(HANG, rig.judge.judge_turn(turn("t2"), PATIENT)).await.expect("a turn");
    assert!(matches!(&again, TurnVerdict::Probs { .. }), "{again:?}");
    rig.clock.advance(KEEP_WARM - MS);
    assert!(rig.judge.is_ready(), "five minutes fifty-nine seconds after the last judgment");
    rig.clock.advance(MS);
    assert!(!rig.judge.is_ready());
    assert_eq!(rig.loads(), 1);
}

/// A turn's lease holds the model past the period; when the lease ends the period runs again.
#[tokio::test(flavor = "multi_thread")]
async fn a_turns_lease_keeps_the_model_loaded_until_it_ends() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = loaded_rig(config).await;
    let three = KEEP_WARM / 2;
    rig.clock.advance(three);
    rig.judge.hold_warm();
    assert!(rig.judge.is_held_warm());
    rig.clock.advance(three);
    assert_eq!(rig.threads(), (Some(1), 0), "the period ended at six minutes under the lease");
    rig.clock.advance(three);
    assert!(!rig.judge.is_held_warm(), "the lease ran out at nine minutes");
    assert!(rig.judge.is_ready());
    rig.clock.advance(three - MS);
    assert!(rig.judge.is_ready(), "the period the lease re-armed ends at twelve");
    rig.clock.advance(MS);
    rig.threads_become((None, 0)).await;
}

/// A load in progress and a judgment holding the gate keep the model, however long the period.
#[tokio::test(flavor = "multi_thread")]
async fn a_load_in_progress_or_a_request_in_flight_is_never_unloaded() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Held);
    let judge = rig.judge.clone();
    let turn_during_load = tokio::spawn({
        let judge = judge.clone();
        async move { judge.judge_turn(turn("t1"), PATIENT).await }
    });
    rig.next_load().await;
    rig.clock.advance(KEEP_WARM);
    assert_eq!(mixdog_rt::time::timeout(HANG, turn_during_load).await.expect("the turn gave up waiting").unwrap(), TurnVerdict::Skipped("warming".into()));
    assert_eq!(rig.threads(), (Some(1), 0), "the loading thread is still the judge's");
    rig.finish_load(Ok(()));
    rig.until("the load finished", EffortJudgeModel::is_ready).await;

    let held = judge.hold_turn().await;
    judge.idle_rang(judge.idle_epoch());
    assert!(judge.is_ready(), "a request holds the gate");
    drop(held);
    judge.idle_rang(judge.idle_epoch());
    assert!(!judge.is_ready(), "with nothing in flight the same ring unloads");
}

/// A request that has taken its place when the model is unloaded is answered by a fresh load, not
/// lost, and the retired thread's end does not touch the replacement.
#[tokio::test(flavor = "multi_thread")]
async fn a_request_that_arrives_during_the_unload_is_answered_by_a_fresh_load() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = loaded_rig(config).await;
    let judge = rig.judge.clone();
    let gate = judge.hold_turn().await;
    let mut arriving = Box::pin(judge.judge_turn(turn("arriving"), PATIENT));
    assert!(poll_once(&mut arriving).is_none(), "it has found the model ready and waits for its turn");
    judge.unload_idle(1);
    drop(gate);
    let answered = mixdog_rt::time::timeout(HANG, arriving).await.expect("the request is answered");
    assert!(matches!(&answered, TurnVerdict::Probs { probs, .. } if probs.as_slice() == PROBS), "{answered:?}");
    assert_eq!(rig.loads(), 2);
    rig.threads_become((Some(2), 0)).await;
    let after = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("after"), PATIENT)).await.expect("a turn");
    assert!(matches!(&after, TurnVerdict::Probs { .. }), "{after:?}");
    assert_eq!(rig.loads(), 2, "the replacement keeps answering after the retired thread ended");
}

/// A model that loaded before and was unloaded for being idle makes the next turn wait for the reload
/// (ten seconds), where a first load waits the cold three; a failed reload answers `warming` at ten.
#[tokio::test(flavor = "multi_thread")]
async fn the_turn_after_an_idle_unload_waits_for_the_reload() {
    let dir = installed();
    let config = config(dir.path());
    if !config.runtime_supported() {
        return;
    }
    let mut rig = rig(config, Loads::Held);
    let judge = rig.judge.clone();
    let node = JudgeTiming { warm: HANG, retry: HANG, ..JudgeTiming::default() };
    let first = tokio::spawn({
        let judge = judge.clone();
        async move { judge.judge_turn(turn("t1"), node).await }
    });
    rig.next_load().await;
    rig.finish_load(Ok(()));
    assert!(matches!(mixdog_rt::time::timeout(HANG, first).await.expect("the first turn").unwrap(), TurnVerdict::Probs { .. }));

    rig.clock.advance(KEEP_WARM);
    rig.threads_become((None, 0)).await;
    let mut again = Box::pin(judge.judge_turn(turn("t2"), node));
    assert!(poll_once(&mut again).is_none());
    rig.next_load().await;
    rig.clock.advance(node.cold);
    assert!(poll_once(&mut again).is_none(), "past the cold wait of a first load, the reload is still waited for");
    rig.clock.advance(RELOAD_WAIT - node.cold - MS);
    assert!(poll_once(&mut again).is_none());
    rig.finish_load(Ok(()));
    let answered = mixdog_rt::time::timeout(HANG, again).await.expect("the turn is judged after the reload");
    assert!(matches!(&answered, TurnVerdict::Probs { .. }), "{answered:?}");

    rig.clock.advance(KEEP_WARM);
    rig.threads_become((None, 0)).await;
    let mut slow = Box::pin(judge.judge_turn(turn("t3"), node));
    assert!(poll_once(&mut slow).is_none());
    rig.next_load().await;
    rig.clock.advance(RELOAD_WAIT - MS);
    assert!(poll_once(&mut slow).is_none());
    rig.clock.advance(MS);
    assert_eq!(poll_once(&mut slow), Some(TurnVerdict::Skipped("warming".into())));
}
