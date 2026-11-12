//! The model's host process: a real child process (this test binary, started as the host over a
//! scripted model) that dies under a request. The core keeps running, the request answers as a dead
//! worker's does, and the next request is answered by a fresh host without any exit notification.

use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::step_effort::{StepCall, StepInput};

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::host::{HostClient, HostLaunch, START_LIMIT, serve_resident};
use crate::effort_judge::worker_tests::Clock;
use crate::effort_judge::input::TurnInput;
use crate::effort_judge::judge::{KEEP_WARM, Resident};
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

/// While this file is absent the host's load never ends (a native load that hangs).
const STALL_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_STALL";
/// Where the host reports: it connects, says its pid, and keeps the connection while it lives.
const REPORT_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_REPORT";
/// Marks the process that plays the daemon in the hard-kill test.
const DAEMON_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_DAEMON";

/// The host process's body: runs only when the parent test started this binary for it.
#[test]
fn host_process_body() {
    if std::env::var_os(HOST_ENV).is_none() {
        return;
    }
    super::host::end_with_parent();
    let load = || {
        use std::io::{Read, Write};
        let _report = std::env::var(REPORT_ENV).ok().map(|addr| {
            let mut report = std::net::TcpStream::connect(addr).expect("the test listens");
            writeln!(report, "{}", std::process::id()).expect("the test reads");
            let mut watcher = report.try_clone().expect("a second handle");
            // The test closing its end ends a host it has no other way to end.
            drop(std::thread::spawn(move || {
                let _ = watcher.read(&mut [0u8; 1]);
                std::process::exit(0);
            }));
            report
        });
        if let Some(marker) = std::env::var_os(STALL_ENV)
            && !std::path::Path::new(&marker).exists()
        {
            loop {
                std::thread::park();
            }
        }
        Ok(Arc::new(Faulting) as Arc<dyn Resident>)
    };
    let code = serve_resident(load, std::io::stdin().lock(), std::io::stdout().lock());
    std::process::exit(code);
}

const REAL_HOST_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_REAL_HOST";
const REAL_DIR_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_REAL_DIR";
const REAL_ORT_ENV: &str = "MIXDOG_TEST_EFFORT_JUDGE_REAL_ORT";

/// The host process of the integration tests that load the real model: the product's host body (`mixdogd effort-judge-host`)
/// over this test binary, which is not `mixdogd`.
#[test]
fn real_host_process_body() {
    if std::env::var_os(REAL_HOST_ENV).is_none() {
        return;
    }
    let path = |name| std::path::PathBuf::from(std::env::var_os(name).expect("the launching test sets it"));
    let config = ModelConfig { dir: path(REAL_DIR_ENV), explicit: true, ort_library: OrtRuntime::Library(path(REAL_ORT_ENV)) };
    let tokens = mixdog_rt::testing::tokens();
    let code = super::host::serve(&config, tokens.judge_thread, std::io::stdin().lock(), std::io::stdout().lock());
    std::process::exit(code);
}

/// A launch of [`real_host_process_body`] over `config`'s model.
pub(crate) fn real_host_launch(config: &ModelConfig) -> HostLaunch {
    let OrtRuntime::Library(library) = &config.ort_library else { panic!("the real host needs a runtime library") };
    HostLaunch {
        program: std::env::current_exe().unwrap(),
        args: ["--exact", "effort_judge::host_tests::real_host_process_body", "--nocapture", "--test-threads=1"].map(Into::into).to_vec(),
        env: vec![
            (REAL_HOST_ENV.to_owned(), "1".to_owned()),
            (REAL_DIR_ENV.to_owned(), config.dir.to_string_lossy().into_owned()),
            (REAL_ORT_ENV.to_owned(), library.to_string_lossy().into_owned()),
        ],
    }
}

fn host_launch(env: Vec<(String, String)>) -> HostLaunch {
    let mut env = env;
    env.push((HOST_ENV.to_owned(), "1".to_owned()));
    HostLaunch {
        program: std::env::current_exe().unwrap(),
        args: ["--exact", "effort_judge::host_tests::host_process_body", "--nocapture", "--test-threads=1"].map(Into::into).to_vec(),
        env,
    }
}

fn config_in(dir: &std::path::Path) -> Option<ModelConfig> {
    std::fs::write(dir.join("model.onnx"), b"scripted").unwrap();
    std::fs::write(dir.join("tokenizer.json"), b"{}").unwrap();
    let config = ModelConfig { dir: dir.to_owned(), explicit: true, ort_library: OrtRuntime::Library(dir.join("ort")) };
    config.runtime_supported().then_some(config)
}

fn judge(dir: &std::path::Path) -> Option<Arc<EffortJudgeModel>> {
    let config = config_in(dir)?;
    Some(EffortJudgeModel::hosted(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), host_launch(Vec::new())))
}

fn turn(request: &str) -> TurnInput {
    TurnInput { request: request.to_owned(), ..TurnInput::default() }
}

/// The daemon of the hard-kill test: starts a host whose load never ends and waits in `start`.
#[tokio::test(flavor = "multi_thread")]
async fn daemon_process_body() {
    if std::env::var_os(DAEMON_ENV).is_none() {
        return;
    }
    let env = [REPORT_ENV, STALL_ENV].map(|name| (name.to_owned(), std::env::var(name).expect("the test sets it"))).to_vec();
    // The host's pipe tasks run on the core's runtime, which this process has to start.
    let _tokens = mixdog_rt::testing::tokens();
    let clock = Clock::default();
    let _ = HostClient::start(&host_launch(env), &tokio::runtime::Handle::current(), &clock);
}

/// What ends the host when its daemon cannot run a destructor: the OS. The host is inside a load
/// (it has reported and is stalled) when its daemon is killed hard.
#[tokio::test(flavor = "multi_thread")]
async fn a_host_ends_with_its_daemon_killed_hard_while_the_host_is_loading() {
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut daemon = tokio::process::Command::new(std::env::current_exe().unwrap());
    daemon
        .args(["--exact", "effort_judge::host_tests::daemon_process_body", "--nocapture", "--test-threads=1"])
        .env(DAEMON_ENV, "1")
        .env(REPORT_ENV, listener.local_addr().unwrap().to_string())
        .env(STALL_ENV, dir.path().join("never"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    daemon.creation_flags(0x0800_0000);
    let mut daemon = daemon.spawn().unwrap();
    let (mut host, _) = mixdog_rt::time::timeout(HANG, listener.accept()).await.expect("the host reports from inside its load").unwrap();
    let mut said = [0u8; 16];
    assert!(host.read(&mut said).await.unwrap() > 0, "the host says its pid");
    daemon.kill().await.expect("the daemon is killed hard");
    let ended = mixdog_rt::time::timeout(HANG, host.read(&mut said)).await.expect("the host is gone within the deadline after its daemon was killed");
    assert!(matches!(ended, Ok(0) | Err(_)), "{ended:?}");
}

/// A host that never becomes ready is killed when its start runs out on the judge's clock, the turn
/// gate is released, and the next judgment starts a fresh host.
#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_never_becomes_ready_is_killed_at_its_limit_and_the_next_judgment_starts_a_new_one() {
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let Some(config) = config_in(dir.path()) else { return };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let marker = dir.path().join("loads");
    let env = vec![(REPORT_ENV.to_owned(), listener.local_addr().unwrap().to_string()), (STALL_ENV.to_owned(), marker.display().to_string())];
    let clock = Arc::new(Clock::default());
    let judge = EffortJudgeModel::hosted_on(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), host_launch(env), clock.clone());
    // No wait of the turn's runs out before the start's limit does.
    let long = Duration::from_secs(24 * 3600);
    let timing = JudgeTiming { warm: long, queue: long, cold: long, retry: long };

    let first = tokio::spawn({
        let judge = judge.clone();
        async move { judge.judge_turn(turn("first"), timing).await }
    });
    let (mut stalled, _) = mixdog_rt::time::timeout(HANG, listener.accept()).await.expect("the first host reports from inside its load").unwrap();
    let mut said = [0u8; 16];
    assert!(stalled.read(&mut said).await.unwrap() > 0, "the host says its pid");
    assert!(clock.wait_armed(START_LIMIT, HANG), "the start's limit is armed on the judge's clock");
    clock.advance(START_LIMIT);

    let verdict = mixdog_rt::time::timeout(HANG, first).await.expect("the waiting turn is answered when the host is killed").unwrap();
    assert!(matches!(verdict, TurnVerdict::Skipped(_)), "{verdict:?}");
    let ended = mixdog_rt::time::timeout(HANG, stalled.read(&mut said)).await.expect("the stalled host was killed");
    assert!(matches!(ended, Ok(0) | Err(_)), "{ended:?}");
    drop(mixdog_rt::time::timeout(HANG, judge.hold_turn()).await.expect("the turn gate was released"));

    // The next load succeeds: no failure was remembered, and no clock moves.
    std::fs::write(&marker, b"").unwrap();
    let next = mixdog_rt::time::timeout(HANG, judge.judge_turn(turn("next"), timing)).await.expect("the next turn");
    assert!(matches!(&next, TurnVerdict::Probs { probs, .. } if probs.as_slice() == [0.1, 0.2, 0.3, 0.4]), "{next:?}");
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

/// A judge whose host is a real process that reports to the test and lives until its judge lets it
/// go; every wait is on the test's clock.
struct Live {
    judge: Arc<EffortJudgeModel>,
    clock: Arc<Clock>,
    listener: tokio::net::TcpListener,
    _dir: tempfile::TempDir,
}

const MS: Duration = Duration::from_millis(1);

async fn live(keep_warm: Duration) -> Option<Live> {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path())?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // The marker exists: the host's load ends.
    let marker = dir.path().join("loads");
    std::fs::write(&marker, b"").unwrap();
    let env = vec![(REPORT_ENV.to_owned(), listener.local_addr().unwrap().to_string()), (STALL_ENV.to_owned(), marker.display().to_string())];
    let clock = Arc::new(Clock::default());
    let judge = EffortJudgeModel::hosted_for(config, JudgeLanes::of(&mixdog_rt::testing::tokens()), host_launch(env), clock.clone(), keep_warm);
    Some(Live { judge, clock, listener, _dir: dir })
}

impl Live {
    /// The next host that started: it connects and says its pid.
    async fn next_host(&self) -> tokio::net::TcpStream {
        use tokio::io::AsyncReadExt;
        let (mut host, _) = mixdog_rt::time::timeout(HANG, self.listener.accept()).await.expect("a host starts and reports").unwrap();
        assert!(host.read(&mut [0u8; 16]).await.unwrap() > 0, "the host says its pid");
        host
    }

    /// No host has started that the test has not taken.
    fn no_host_pending(&self) -> bool {
        crate::effort_judge::worker_tests::poll_once(&mut Box::pin(self.listener.accept())).is_none()
    }

    /// A turn of a session with auto effort on.
    async fn auto_turn(&self) -> TurnVerdict {
        mixdog_rt::time::timeout(HANG, self.judge.judge_turn(turn("t"), PATIENT)).await.expect("a turn")
    }
}

const DECISION: [f64; 4] = [0.1, 0.2, 0.3, 0.4];

fn open(host: &tokio::net::TcpStream) -> bool {
    matches!(host.try_read(&mut [0u8; 1]), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
}

async fn ends(host: &mut tokio::net::TcpStream) {
    use tokio::io::AsyncReadExt;
    let ended = mixdog_rt::time::timeout(HANG, host.read(&mut [0u8; 16])).await.expect("the host ended and its memory went back");
    assert!(matches!(ended, Ok(0) | Err(_)), "{ended:?}");
}

fn decided(verdict: &TurnVerdict) -> bool {
    matches!(verdict, TurnVerdict::Probs { probs, .. } if probs.as_slice() == DECISION)
}

/// No host exists until a turn of a session with auto effort on needs one (building the judge,
/// reading its status and info are no use of it), and none after it has been idle for the period.
#[tokio::test(flavor = "multi_thread")]
async fn no_host_exists_before_the_first_auto_turn_nor_after_the_idle_period() {
    let Some(live) = live(KEEP_WARM).await else { return };
    drop((live.judge.status(), live.judge.info(), live.judge.is_ready(), live.judge.supports_steps().await));
    assert_eq!(live.judge.worker().threads(), (None, 0));
    assert!(live.no_host_pending(), "no host before the first turn");

    assert!(decided(&live.auto_turn().await));
    let mut host = live.next_host().await;
    assert_eq!(live.judge.worker().threads(), (Some(1), 0));
    live.clock.advance(KEEP_WARM - MS);
    assert!(live.judge.is_ready() && open(&host), "a millisecond before the period ends the host lives");
    live.clock.advance(MS);
    ends(&mut host).await;
    assert_eq!(live.judge.worker().threads(), (None, 0));
    assert!(!live.judge.is_ready());
    assert!(live.no_host_pending(), "an idle judge starts nothing");
}

/// A turn one tick before the limit renews the period: the host that answered it lives a whole period more.
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_one_tick_before_the_idle_limit_keeps_the_host() {
    let Some(live) = live(KEEP_WARM).await else { return };
    assert!(decided(&live.auto_turn().await));
    let mut host = live.next_host().await;
    live.clock.advance(KEEP_WARM - MS);
    assert!(decided(&live.auto_turn().await));
    live.clock.advance(KEEP_WARM - MS);
    assert!(live.judge.is_ready() && open(&host), "a period less a tick after the last turn");
    assert!(live.no_host_pending(), "the same host answered both turns");
    live.clock.advance(MS);
    ends(&mut host).await;
}

/// The one setting decides the period.
#[tokio::test(flavor = "multi_thread")]
async fn the_idle_period_is_the_judges_setting() {
    let minute = Duration::from_secs(60);
    let Some(live) = live(minute).await else { return };
    assert!(decided(&live.auto_turn().await));
    let mut host = live.next_host().await;
    live.clock.advance(minute - MS);
    assert!(live.judge.is_ready());
    live.clock.advance(MS);
    ends(&mut host).await;
}

/// A turn after the unload waits for a fresh host and is decided as the first one was.
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_after_the_unload_starts_a_host_and_decides_as_before() {
    let Some(live) = live(KEEP_WARM).await else { return };
    let first = live.auto_turn().await;
    let mut old = live.next_host().await;
    live.clock.advance(KEEP_WARM);
    ends(&mut old).await;
    let again = live.auto_turn().await;
    assert!(decided(&first) && decided(&again), "{first:?} {again:?}");
    let new = live.next_host().await;
    assert!(open(&new));
    assert_eq!(live.judge.worker().threads(), (Some(2), 0));
}

/// A turn that has found the host ready when the unload happens is answered by a fresh host, and
/// no more than one host lives afterwards.
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_arriving_while_the_unload_is_in_progress_keeps_its_decision_and_leaves_one_host() {
    let Some(live) = live(KEEP_WARM).await else { return };
    assert!(decided(&live.auto_turn().await));
    let mut old = live.next_host().await;
    let gate = live.judge.hold_turn().await;
    let mut arriving = Box::pin(live.judge.judge_turn(turn("arriving"), PATIENT));
    assert!(crate::effort_judge::worker_tests::poll_once(&mut arriving).is_none(), "it waits for its turn at the gate");
    live.judge.unload_idle(1);
    drop(gate);
    let answered = mixdog_rt::time::timeout(HANG, arriving).await.expect("the turn is answered");
    assert!(decided(&answered), "{answered:?}");
    ends(&mut old).await;
    let new = live.next_host().await;
    assert!(open(&new) && live.no_host_pending(), "one host, the new one");
    assert_eq!(live.judge.worker().threads(), (Some(2), 0));
}
