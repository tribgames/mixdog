//! The model's host process: a real child process (this test binary, started as the host over a
//! scripted model) that dies under a request. The core keeps running, the request answers as a dead
//! worker's does, and the next request is answered by a fresh host without any exit notification.

use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::step_effort::{StepCall, StepInput};

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::host::{HostLaunch, serve_resident};
use crate::effort_judge::input::TurnInput;
use crate::effort_judge::judge::Resident;
use crate::effort_judge::model::{ModelConfig, OrtRuntime};
use crate::effort_judge::worker::Stopper;
use crate::effort_judge::{EffortJudgeModel, JudgeLanes, JudgeTiming, TurnVerdict};

const HOST_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_HOST";
const HANG: Duration = Duration::from_secs(60);
const PATIENT: JudgeTiming = JudgeTiming { warm: HANG, queue: HANG, cold: HANG, retry: HANG };

/// What the host process serves: a turn whose request is "crash" is a native fault (the process is
/// aborted); a step answers its number and its calls' count.
struct Faulting;

impl Resident for Faulting {
    fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError> {
        Ok(vec![f64::from(input.step), input.calls.len() as f64, 0.25, 0.5])
    }
    fn turn_probs(&self, input: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        if input.request == "crash" {
            std::process::abort();
        }
        Ok(vec![0.1, 0.2, 0.3, 0.4])
    }
    fn stopper(&self) -> Stopper {
        Arc::new(|| ())
    }
}

/// The host process's body: runs only when the parent test started this binary for it.
#[test]
fn host_process_body() {
    if std::env::var_os(HOST_ENV).is_none() {
        return;
    }
    let code = serve_resident(|| Ok(Arc::new(Faulting) as Arc<dyn Resident>), std::io::stdin().lock(), std::io::stdout().lock());
    std::process::exit(code);
}

fn judge(dir: &std::path::Path) -> Option<Arc<EffortJudgeModel>> {
    std::fs::write(dir.join("model.onnx"), b"scripted").unwrap();
    std::fs::write(dir.join("tokenizer.json"), b"{}").unwrap();
    let config = ModelConfig { dir: dir.to_owned(), explicit: true, ort_library: OrtRuntime::Library(dir.join("ort")) };
    if !config.runtime_supported() {
        return None;
    }
    let launch = HostLaunch {
        program: std::env::current_exe().unwrap(),
        args: ["--exact", "effort_judge::host_tests::host_process_body", "--nocapture", "--test-threads=1"].map(Into::into).to_vec(),
        env: vec![(HOST_ENV.to_owned(), "1".to_owned())],
    };
    Some(EffortJudgeModel::hosted(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), launch))
}

fn turn(request: &str) -> TurnInput {
    TurnInput { request: request.to_owned(), ..TurnInput::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_and_its_answer_cross_the_host_process_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let Some(judge) = judge(dir.path()) else { return };
    let verdict = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("hello"), PATIENT)).await.expect("a turn");
    assert!(matches!(&verdict, TurnVerdict::Probs { probs, .. } if probs.as_slice() == [0.1, 0.2, 0.3, 0.4]), "{verdict:?}");
    let call = |name: &str| StepCall { name: name.into(), args: "{}".into(), result: "ok".into() };
    let step = StepInput { request: "r".into(), step: 7, plan: "p".into(), calls: vec![call("read"), call("grep")] };
    let probs = mixdog_rt::time::timeout(HANG, judge.probs(step)).await.expect("a step").expect("judged");
    assert_eq!(probs, [7.0, 2.0, 0.25, 0.5]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_dies_under_a_request_leaves_the_core_alive_and_the_next_request_is_answered() {
    let dir = tempfile::tempdir().unwrap();
    let Some(judge) = judge(dir.path()) else { return };
    let first = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("first"), PATIENT)).await.expect("a turn");
    assert!(matches!(&first, TurnVerdict::Probs { .. }), "{first:?}");
    assert!(judge.is_ready());

    // The host aborts under this request; no clock moves, so nothing waits for an exit notification.
    let died = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("crash"), PATIENT)).await.expect("the request is answered when the host dies");
    assert_eq!(died, TurnVerdict::Skipped("effort judge exited".into()));
    assert!(!judge.is_ready(), "the dead host is no model");

    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("next"), PATIENT)).await.expect("the next request");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == [0.1, 0.2, 0.3, 0.4]), "{next:?}");
    assert_eq!(judge.worker().threads().0, Some(2), "a fresh host on a new thread");
}
