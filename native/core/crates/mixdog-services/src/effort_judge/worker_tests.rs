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
use crate::effort_judge::{EffortJudge, EffortJudgeModel, JudgeLanes, JudgeTiming, TurnVerdict};

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
