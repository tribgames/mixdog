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
    /// What the release's exit flush does (`CorePort::flush_log`).
    flush: Arc<dyn Fn() + Send + Sync>,
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
    fn cut_new_tasks(&self) {
        self.inner.cut_new_tasks();
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
        (self.flush)();
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
    let flushes = Arc::new(AtomicU32::new(0));
    let counted = flushes.clone();
    release_flushing(fault, budgets, flushes, Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }))
}

/// [`release_with`] whose exit flush is `flush`.
fn release_flushing(fault: (&'static str, Fault), budgets: ReleaseBudgets, flushes: Arc<AtomicU32>, flush: Arc<dyn Fn() + Send + Sync>) -> Run {
    let recorder = Arc::new(Recorder::default());
    let root = tempfile::tempdir().unwrap();
    let (unwedge, hold) = mpsc::channel();
    let lifecycle = Lifecycle::with_budgets(
        LifecycleConfig { instance_id: "instance-1".into(), version: "1.4.6".into(), runtime_root: root.path().to_owned() },
        Ports {
            core: Arc::new(Faulty { inner: recorder.clone(), fault, hold: Mutex::new(hold), flush }),
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

/// The two tests below run on the real clock with an ample budget. Under paused time the runtime
/// auto-advances the clock whenever it has nothing to poll, and a step on a plain `std` thread
/// (unlike `spawn_blocking`) does not hold that back: the budget would run out before the thread
/// reported, whatever the step did.
#[tokio::test]
async fn an_async_step_that_ends_inside_its_budget_finished() {
    let (done, finished) = tokio::sync::oneshot::channel::<()>();
    let end = supervise_async("quick", AMPLE, async move {
        let _ = done.send(());
    })
    .await;
    assert_eq!(end, StepEnd::Finished);
    assert!(finished.await.is_ok(), "the step ran to its end");
}

#[tokio::test]
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

/// Writes nothing on its own: a job scheduled on it never runs, so a batch can only reach the disk through a flush.
struct NeverFires;

impl mixdog_core_session::session::gateway_usage::Scheduler for NeverFires {
    fn after(&self, _: u64, _: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

struct Unpriced;

impl mixdog_ai::registry::accounting::UsagePricing for Unpriced {
    fn price_usage(&self, _: &mixdog_ai::catalog::UsageArgs) -> mixdog_ai::catalog::PricedUsage {
        mixdog_ai::catalog::PricedUsage { input: 0.0, cost_usd: None, rates: Default::default() }
    }
}

/// Node writes the last gateway usage batch in `process.on('exit', flushGatewayUsageEventsSync)`
/// (`route-meta.mjs:416`), and `process.exit` runs it on every path the process can end on
/// (`cli.mjs:88`, `process-shutdown.mjs:79,141`): after a stop step over its budget as well. The release
/// procedure's own exit flush (`compose::flush_at_exit`) must do the same: with `closeDataHandles` wedged
/// (the stop steps skipped), the batch recorded before the release is on disk when the process exits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_gateway_usage_batch_is_written_when_a_stop_step_wedged() {
    let data = tempfile::tempdir().unwrap();
    let usage = mixdog_core_session::session::gateway_usage::GatewayUsage::new(
        data.path(),
        mixdog_rt::testing::tokens().durability_io,
        Arc::new(mixdog_core_session::session::SystemClock),
        Arc::new(Unpriced),
        Arc::new(NeverFires),
    );
    let header = serde_json::json!({ "id": "s", "provider": "p", "model": "m" });
    usage.record_ask(&mixdog_core_session::session::gateway_usage::Ask {
        header: header.as_object().unwrap(),
        usage: &mixdog_core_api::domain::provider::Usage { input_tokens: 5, output_tokens: 1, ..Default::default() },
        response_model: "m",
        tool_calls_total: 0,
        message_count: 1,
        estimated_tokens: 0.0,
        turn_effort: None,
        duration_ms: 0.0,
        transport_timing: None,
    });
    let store = data.path().join(mixdog_core_session::session::gateway_usage::STORE_FILE);
    assert!(!store.exists(), "the event is only pending: nothing flushed it yet");
    let log = crate::daemon_log::DaemonLog::new(data.path().join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new());
    let runtime = tokio::runtime::Handle::current();
    let flushes = Arc::new(AtomicU32::new(0));
    let flush: Arc<dyn Fn() + Send + Sync> = {
        let usage = usage.clone();
        Arc::new(move || runtime.block_on(crate::compose::flush_at_exit(&log, &usage)))
    };
    let run = release_flushing(("close_data_handles", Fault::Wedge), budgets("close_data_handles"), flushes, flush);
    tokio::task::spawn_blocking(move || {
        run.recorder.wait_exit();
        assert_eq!(last_exit(run.root.path())["stuckStep"], "closeDataHandles");
    })
    .await
    .unwrap();
    let text = std::fs::read_to_string(&store).unwrap();
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(lines.len(), 1, "{text}");
    assert!(lines[0].contains("\"provider\":\"p\"") && lines[0].contains("\"inputTokens\":5"), "{text}");
}

struct Now;

impl mixdog_agent::env::Clock for Now {
    fn now_ms(&self) -> i64 {
        i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap()
    }
}

/// Node queues a failure row and writes it 1000 ms later or in its `beforeExit`/`exit` hooks (`agent-trace-io.mjs:214-221`), which
/// `process.exit` runs on every ordinary end of the daemon (`daemon.mjs:412`, the shutdown every stop and signal comes to). The
/// recording `fixtures/tool-failures` scenario "a failed call whose row is still queued when the process stops" held Node's 1000 ms
/// timer: nothing was on disk at the stop, and the row was in the file after the exit. The core's release procedure (every stop, a
/// signal and the last client leaving included) ends with `compose::flush_at_exit`: with the core's timer held the same way, the row
/// queued before the release is in the file when the process exits, as Node's row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_row_still_queued_at_the_stop_is_written_by_the_exit_flush_as_node_s() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/tool-failures/golden.json")).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    let index = scenarios.iter().position(|s| s["name"] == "a failed call whose row is still queued when the process stops").unwrap();
    let node_rows = golden["rows"][index].as_array().unwrap();
    let at_stop = &golden["results"][index]["atStop"];
    assert_eq!(at_stop["fileAtStop"], "", "Node had written nothing when it was stopped");
    assert!(!at_stop["heldFlushTimers"].as_array().unwrap().is_empty(), "Node's flush timer was held, not never armed");
    assert_eq!(node_rows.len(), 1);
    let node_row = node_rows[0].as_str().unwrap();
    let row: serde_json::Value = serde_json::from_str(node_row).unwrap();
    // The scenario's one call, the text Node gave the model for it, and the session facts of a Lead run (the replay proves them).
    let call = &scenarios[index]["replies"][0]["calls"][0];
    let tool_kind = match row["tool_kind"].as_str().unwrap() {
        "builtin" => "builtin",
        other => panic!("a tool kind this test does not name: {other}"),
    };
    let failed = mixdog_agent::env::FailedCall {
        iteration: 1,
        tool_name: call["name"].as_str().unwrap().to_owned(),
        tool_kind,
        tool_ms: 0,
        tool_args: call["args"].clone(),
        model: golden["model"].as_str().unwrap().to_owned(),
        result_text: golden["results"][index]["toolMessages"][0][0].as_str().unwrap().to_owned(),
    };
    let data = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = mixdog_core_api::domain::tool::ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io.clone(), maintenance: tokens.maintenance_io.clone() };
    let writer = mixdog_core_run::run_host::failure_log::FailureWriter::register_with_timer_held(data.path(), &|_| None, io, Arc::new(Now));
    let session = format!("<session:{index}>");
    mixdog_agent::env::ToolFailureLog::failed(&mixdog_core_run::run_host::failure_log::RunFailureLog::new(writer, &session, Some("lead"), "<WS>"), failed);
    let file = data.path().join("history").join("tool-failures.jsonl");
    assert!(!file.exists(), "the row is only queued: nothing flushed it yet");
    let usage = mixdog_core_session::session::gateway_usage::GatewayUsage::new(
        data.path(),
        tokens.durability_io,
        Arc::new(mixdog_core_session::session::SystemClock),
        Arc::new(Unpriced),
        Arc::new(NeverFires),
    );
    let log = crate::daemon_log::DaemonLog::new(data.path().join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new());
    let runtime = tokio::runtime::Handle::current();
    let flush: Arc<dyn Fn() + Send + Sync> = Arc::new(move || runtime.block_on(crate::compose::flush_at_exit(&log, &usage)));
    let run = release_flushing(("none", Fault::Wedge), budgets(""), Arc::new(AtomicU32::new(0)), flush);
    tokio::task::spawn_blocking(move || run.recorder.wait_exit()).await.unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 1, "{text}");
    // `ts` and `tool_ms` are each run's own measurements (lib/tool-failure-rows.mjs normalises them on Node's file the same way).
    let written: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    let normalised = lines[0]
        .replacen(&format!("\"ts\":{},", written["ts"].as_i64().unwrap()), "\"ts\":\"<ts>\",", 1)
        .replacen(&format!("\"tool_ms\":{},", written["tool_ms"].as_i64().unwrap()), "\"tool_ms\":\"<ms>\",", 1);
    assert_eq!(normalised, node_row);
}
