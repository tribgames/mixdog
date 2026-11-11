//! Replay of `native/core/fixtures/memory-service-lifecycle` (memory-service-lifecycle.test.mjs, 18 cases, and the quit
//! stop of memory-daemon-lifecycle.mjs as case 18) against
//! `MemoryStack` (`memory/boot.rs`): the stack is built with `MemoryStack::start`, a memory request's database use
//! (`stack.db().client()`, what every recall and ingest goes through) opens it, `MemoryStack::stop` stops it.
//!
//! The core's memory runs in the daemon's process, as Node's does in the product (`INTEGRATED_DAEMON_HOST`,
//! `runtime/memory/index.mjs:569`: no listener, `ready(null)`, case 7). What a client of memory observes, and what it
//! is in the core:
//! - Node's `initialize` (the runtime acquisition) is the stack's opening; its scripted endpoint is the PostgreSQL
//!   install (`PgRuntimeSource::Install`), scripted as Node's was (logs its entry where Node's did, held at a gate,
//!   failing with the recorded text, or handing over the bundled runtime from `MIXDOG_PG_RUNTIME` so the opening goes
//!   on to a real private cluster).
//! - `init()`'s outcome is the outcome of a memory request's use; `state.initialized` is `MemoryStack::is_open`,
//!   `state.stopping` is `MemoryStack::is_stopping`.
//! - `stopBackgroundWork` and `shutdown` are the stop's background-work stop and storage release, observed and failed
//!   through the development-only `StopSeam` (`background-stopped`, `storage-released`).
//! - The next start after a stop is the next core's stack over the same profile (the core never reopens a stopped
//!   stack: a use after the stop is refused with the supervisor's text, `memory/tests/boot.rs`).
//!
//! Declared, with no in-process counterpart (MANIFEST `declared`): the listener and the port advert (`listen`,
//! `advertise`, `withdraw`, `close`, `listener-closing`; cases 4, 6, 10, 12, 13, 17 are about them alone), `start` and
//! `error` (log lines, `index.mjs:578,580`), `ready` (a log line and the idle timer, `index.mjs:582-588`; readiness is
//! `state.initialized`), `state.hasInitPromise` (read only by the HTTP router, `http-router.mjs:36`), the calls of the
//! stop a failed initialization runs on itself (`memory-service-lifecycle.mjs:55-59`; the core releases a partly
//! opened cluster inside the opening and runs no stop), case 2's `secondStopIsTheSamePromise` (the core's stop has one
//! caller, the host's shutdown) and case 16's middle step (the request drain is the listener's).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, object, same, string};
use crate::memory::boot::{MemoryBoot, MemoryStack, PgInstall, PgRuntimeSource};
use crate::memory::error::MemoryError;
use crate::memory::runtime::RuntimeFlags;
use crate::memory::sensitive::SensitiveStore;
use crate::memory::tests::awaiting::{awaiting, awaiting_for};

const SET: &str = "memory-service-lifecycle";
const OPENING: std::time::Duration = std::time::Duration::from_secs(120);

#[test]
fn every_recorded_case_has_a_replay() {
    assert_case_count(&golden(SET), 19);
}

/// What the core does where Node's recorded call is, or `None` where the core has no owner for it (declared above).
fn core_call(call: &Exact) -> Option<&'static str> {
    let name = match call {
        Exact::String(name) => name.as_str(),
        Exact::Array(items) => items[0].as_str(),
        other => panic!("a recorded call is a name or [name, value]: {other:?}"),
    };
    match name {
        "initialize" => Some("initialize"),
        "acquired" => Some("acquired"),
        "stop-background" | "workers-stopped" | "workers-stop-throws" => Some("background-stopped"),
        "shutdown" | "storage-closed" => Some("storage-released"),
        "start" | "listen" | "advertise" | "withdraw" | "close" | "listener-closing" | "error" | "ready" => None,
        other => panic!("a recorded call this replay has no mapping for: {other}"),
    }
}

/// A recorded step as the core is compared with it: `label` (the recorder's description) and the declared keys left
/// out, `state` without `hasInitPromise`, `calls` through [`core_call`]; with `auto_stop`, the calls after the failed
/// initialization's `error` are its own stop's (declared).
fn expected(step: &Exact, declared: &[&str], auto_stop: bool) -> Exact {
    let Exact::Object(entries) = step else { panic!("a step is an object") };
    let mut out = Vec::new();
    for (key, value) in entries {
        if key == "label" || declared.contains(&key.as_str()) {
            continue;
        }
        let value = match key.as_str() {
            "state" => object(vec![("initialized", value.get("initialized").clone()), ("stopping", value.get("stopping").clone())]),
            "calls" => {
                let mut calls = Vec::new();
                for call in value.as_array() {
                    let is_error = matches!(call, Exact::Array(items) if items[0].as_str() == "error");
                    if is_error && auto_stop {
                        break;
                    }
                    calls.extend(core_call(call).map(string));
                }
                Exact::Array(calls)
            }
            _ => value.clone(),
        };
        out.push((key.clone(), value));
    }
    Exact::Object(out)
}

fn error(error: &MemoryError) -> Exact {
    let name = if matches!(error, MemoryError::Shutdown(_)) { "AggregateError" } else { "Error" };
    Exact::Error { name: name.to_owned(), message: error.message(), code: None, cause: None, props: Vec::new() }
}

fn outcome(used: &Result<(), MemoryError>) -> Exact {
    match used {
        Ok(()) => panic!("the use succeeded where the recording has an outcome"),
        Err(e) => object(vec![("error", error(e))]),
    }
}

/// One scripted install entry, as Node's scripted `initialize` of that case.
struct Plan {
    logs_entry: bool,
    gate: Option<tokio::sync::oneshot::Receiver<()>>,
    logs_acquired: bool,
    fails: Option<&'static str>,
}

impl Plan {
    fn opens() -> Self {
        Self { logs_entry: true, gate: None, logs_acquired: false, fails: None }
    }
    fn fails(text: &'static str) -> Self {
        Self { fails: Some(text), ..Self::opens() }
    }
}

/// A profile directory whose cluster, if any, is stopped and removed on every path.
struct Profile {
    dir: tempfile::TempDir,
}

impl Drop for Profile {
    fn drop(&mut self) {
        let pgdata = self.dir.path().join("pgdata");
        if !pgdata.join("postmaster.pid").exists() {
            return;
        }
        let bin = runtime().join("bin");
        let mut stop = std::process::Command::new(bin.join(if cfg!(windows) { "pg_ctl.exe" } else { "pg_ctl" }));
        stop.args(["stop", "-m", "immediate", "-w", "-t", "30", "-D"]).arg(&pgdata).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let _ = stop.status();
    }
}

fn runtime() -> PathBuf {
    PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME is unset: it names the bundled PostgreSQL runtime these replays open"))
}

struct Harness {
    stack: Arc<MemoryStack>,
    log: Arc<Mutex<Vec<&'static str>>>,
    installs: Arc<AtomicUsize>,
    cancel: Arc<Mutex<Option<tokio_util::sync::CancellationToken>>>,
    /// Whether no stop step had ended when the held install was released.
    clear_at_acquire: Arc<Mutex<Option<bool>>>,
    calls_seen: usize,
    steps_seen: usize,
}

impl Harness {
    async fn over(profile: &Profile, plans: Vec<Plan>) -> Self {
        let plans = Arc::new(Mutex::new(VecDeque::from(plans)));
        let log = Arc::new(Mutex::new(Vec::new()));
        let installs = Arc::new(AtomicUsize::new(0));
        let cancel = Arc::new(Mutex::new(None));
        let clear_at_acquire = Arc::new(Mutex::new(None));
        let me: Arc<OnceLock<Weak<MemoryStack>>> = Arc::new(OnceLock::new());
        let install: PgInstall = {
            let (log, installs, cancel, clear, me) = (log.clone(), installs.clone(), cancel.clone(), clear_at_acquire.clone(), me.clone());
            Arc::new(move |token: tokio_util::sync::CancellationToken| {
                installs.fetch_add(1, Ordering::SeqCst);
                let plan = plans.lock().unwrap().pop_front().expect("a scripted install for every entry");
                *cancel.lock().unwrap() = Some(token);
                if plan.logs_entry {
                    log.lock().unwrap().push("initialize");
                }
                let (log, clear, me) = (log.clone(), clear.clone(), me.clone());
                Box::pin(async move {
                    if let Some(gate) = plan.gate {
                        let _ = gate.await;
                    }
                    if plan.logs_acquired {
                        let stack = me.get().and_then(Weak::upgrade).expect("the stack");
                        *clear.lock().unwrap() = Some(stack.stop_seam().steps().is_empty());
                        log.lock().unwrap().push("acquired");
                    }
                    match plan.fails {
                        Some(text) => Err(MemoryError::Rejected(text.to_owned())),
                        None => Ok(runtime()),
                    }
                })
            })
        };
        let stack = MemoryStack::start(MemoryBoot {
            data_dir: profile.dir.path().to_owned(),
            pg_runtime: PgRuntimeSource::Install(install),
            embedder: None,
            embedding_provider: None,
            flags: RuntimeFlags::default(),
            progress: None,
            sensitive: Arc::new(SensitiveStore::default()),
            lane: mixdog_rt::testing::tokens().durability_io,
            maintenance: mixdog_rt::testing::tokens().maintenance_io,
            transcripts: None,
            cycles: None,
            backfill: None,
            processes: crate::tidy::process::Processes::for_tests(),
            cancel: tokio_util::sync::CancellationToken::new(),
        })
        .await
        .expect("the stack is built without a database");
        me.set(Arc::downgrade(&stack)).expect("one stack");
        Self { stack, log, installs, cancel, clear_at_acquire, calls_seen: 0, steps_seen: 0 }
    }

    /// A memory request's use of the database.
    fn use_db(&self) -> impl std::future::Future<Output = Result<(), MemoryError>> + Send + 'static {
        let db = self.stack.db();
        async move { db.client().await.map(drop) }
    }

    fn state(&self) -> Exact {
        object(vec![("initialized", Exact::Bool(self.stack.is_open())), ("stopping", Exact::Bool(self.stack.is_stopping()))])
    }

    /// The core's calls since the last step: the install's, then the stop's steps.
    fn calls(&mut self) -> Exact {
        let log = self.log.lock().unwrap().clone();
        let steps = self.stack.stop_seam().steps();
        let calls = log[self.calls_seen..].iter().chain(&steps[self.steps_seen..]).map(|call| string(*call)).collect();
        (self.calls_seen, self.steps_seen) = (log.len(), steps.len());
        Exact::Array(calls)
    }

    /// The install's calls since the last step, without the stop's steps.
    fn install_calls(&mut self) -> Exact {
        let log = self.log.lock().unwrap().clone();
        let calls = log[self.calls_seen..].iter().map(|call| string(*call)).collect();
        self.calls_seen = log.len();
        Exact::Array(calls)
    }

    async fn stop(&self) -> Result<(), MemoryError> {
        // The product's stop gives PostgreSQL 6 s (`PG_STOP_TIMEOUT`, Node's); its shutdown checkpoint flushes the schema the opening wrote,
        // which on a loaded disk took longer (three of eighteen stops, 2026-11-11). A checkpoint taken here leaves the stop's own small.
        if self.stack.is_open() {
            let db = self.stack.db();
            let checkpoint = async move { db.client().await?.batch_execute("CHECKPOINT").await.map_err(MemoryError::from) };
            awaiting_for(OPENING, "the checkpoint before the stop", checkpoint).await.expect("the checkpoint before the stop");
        }
        awaiting_for(OPENING, "the stop", self.stack.stop()).await
    }
}

/// `entries` in the key order of `expected` (key order is not a value); a key on one side only fails.
fn step(expected: &Exact, entries: Vec<(&str, Exact)>) -> Exact {
    let Exact::Object(want) = expected else { panic!("a step is an object") };
    let have: Vec<&str> = entries.iter().map(|(k, _)| *k).collect();
    let keys: Vec<&str> = want.iter().map(|(k, _)| k.as_str()).collect();
    let mut sorted_have = have.clone();
    let mut sorted_keys = keys.clone();
    sorted_have.sort_unstable();
    sorted_keys.sort_unstable();
    assert_eq!(sorted_have, sorted_keys, "the step's compared keys");
    let mut entries = entries;
    object(keys.iter().map(|key| {
        let at = entries.iter().position(|(k, _)| k == key).expect("key");
        entries.remove(at)
    }).collect())
}

fn compare(name: &str, at: usize, expected: Exact, actual: Exact) {
    same(&format!("{name}: step {at}"), &expected, &actual);
}

fn bool(value: bool) -> Exact {
    Exact::Bool(value)
}

fn steps(c: &Exact) -> &[Exact] {
    c.get("steps").as_array()
}

/// The case is about the listener or the port advert alone: the core has no owner for any of it (declared in the manifest).
fn listener_only(index: usize, name: &str) {
    let g = golden(SET);
    let c = case(&g, index, name);
    let manifest = Exact::load(super::fixture(SET, "MANIFEST.json"));
    let declared = manifest
        .get("declared")
        .as_array()
        .iter()
        .any(|d| d.try_get("case").is_some_and(|c| c.as_f64() as usize == index) && d.try_get("step").is_none() && d.try_get("what").is_none());
    assert!(declared, "{name}: the manifest declares the case");
    assert!(!steps(c).is_empty());
}

#[test]
fn a_late_listener_result_cannot_re_advertise_or_report_ready_after_stop() {
    listener_only(4, "a late listener result cannot re-advertise or report ready after stop (test line 131)");
}

#[test]
fn listener_failure_waits_for_runtime_acquisition_and_preserves_the_bind_error() {
    listener_only(6, "listener failure waits for runtime acquisition and preserves the bind error (test line 161)");
}

#[test]
fn service_shutdown_closes_a_real_listener_while_runtime_initialization_is_pending() {
    listener_only(10, "service shutdown closes a real listener while runtime initialization is pending (test line 216)");
}

#[test]
fn shutdown_releases_independent_resources_after_withdraw_fails() {
    listener_only(12, "shutdown releases independent resources after withdraw fails (test line 250)");
}

#[test]
fn shutdown_releases_independent_resources_after_close_listener_fails() {
    listener_only(13, "shutdown releases independent resources after closeListener fails (test line 250)");
}

#[test]
fn multiple_shutdown_failures_remain_available_after_every_cleanup_is_attempted() {
    listener_only(17, "multiple shutdown failures remain available after every cleanup is attempted (test line 310)");
}

/// Case 2: an install held at a gate that it does not leave for the stop's cancel.
#[tokio::test(flavor = "current_thread")]
async fn shutdown_waits_for_in_flight_acquisition_before_releasing_its_resources() {
    let name = "shutdown waits for in-flight acquisition before releasing its resources (test line 90)";
    let g = golden(SET);
    let c = case(&g, 2, name);
    let profile = Profile { dir: tempfile::tempdir().expect("dir") };
    let (gate, held) = tokio::sync::oneshot::channel();
    let mut h = Harness::over(&profile, vec![Plan { gate: Some(held), logs_acquired: true, ..Plan::opens() }]).await;
    let using = tokio::spawn(h.use_db());
    awaiting("the install to be entered", async {
        while h.installs.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let stack = h.stack.clone();
    let stopping = tokio::spawn(async move { stack.stop().await });
    awaiting("the stop to begin", async {
        while !h.stack.is_stopping() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let aborted = h.cancel.lock().unwrap().as_ref().is_some_and(tokio_util::sync::CancellationToken::is_cancelled);
    let during = awaiting("a use during the stop", h.use_db()).await;
    let shutdown_yet = h.stack.stop_seam().steps().contains(&"storage-released");
    let first = &steps(c)[0];
    let actual = step(&expected(first, &["secondStopIsTheSamePromise"], false), vec![
        ("signalAbortedAtStop", bool(aborted)),
        ("initDuringStop", outcome(&during)),
        ("shutdownCalledYet", bool(shutdown_yet)),
        ("state", h.state()),
        ("calls", h.calls()),
    ]);
    compare(name, 0, expected(first, &["secondStopIsTheSamePromise"], false), actual);
    gate.send(()).expect("the install waits at its gate");
    let used = awaiting("the use of the stopped opening", using).await.expect("the use");
    let stopped = awaiting("the stop", stopping).await.expect("the stop");
    stopped.expect("the stop of an opening that never opened");
    let acquired_first = h.clear_at_acquire.lock().unwrap().expect("the install was released");
    let second = &steps(c)[1];
    let actual = step(&expected(second, &[], false), vec![
        ("initOutcome", outcome(&used)),
        ("acquiredBeforeShutdown", bool(acquired_first)),
        ("state", h.state()),
        ("calls", h.calls()),
    ]);
    compare(name, 1, expected(second, &[], false), actual);
}

/// Case 3: a use and the stop in the same turn: the opening task is launched by the use and runs only after the stop began.
#[tokio::test(flavor = "current_thread")]
async fn same_tick_shutdown_cancels_queued_acquisition_instead_of_starting_it() {
    let name = "same-tick shutdown cancels queued acquisition instead of starting it (test line 121)";
    let g = golden(SET);
    let c = case(&g, 3, name);
    let profile = Profile { dir: tempfile::tempdir().expect("dir") };
    let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
    let mut using = Box::pin(h.use_db());
    assert!(futures::poll!(&mut using).is_pending(), "the use launched the opening");
    let stopped = h.stop().await;
    stopped.expect("a stop with nothing opened");
    let used = awaiting("the use", using).await;
    let only = &steps(c)[0];
    let actual = step(&expected(only, &[], false), vec![("initOutcome", outcome(&used)), ("state", h.state()), ("calls", h.calls())]);
    compare(name, 0, expected(only, &[], false), actual);
    assert_eq!(c.get("initializeCalled"), &bool(h.installs.load(Ordering::SeqCst) > 0), "{name}: initializeCalled");
    assert!(c.try_get("listenCalled").is_some(), "{name}: listenCalled is declared (no listener)");
}

/// Case 5: the runtime acquisition fails; the next use is the next acquisition.
#[tokio::test(flavor = "current_thread")]
async fn runtime_failure_during_a_pending_http_bind_is_handled_and_releases_both_owners() {
    let name = "runtime failure during a pending HTTP bind is handled and releases both owners (test line 142)";
    let g = golden(SET);
    let c = case(&g, 5, name);
    let profile = Profile { dir: tempfile::tempdir().expect("dir") };
    let mut h = Harness::over(&profile, vec![Plan::fails("database unavailable")]).await;
    let used = awaiting("the use", h.use_db()).await;
    let only = &steps(c)[0];
    let injected = used.as_ref().err().is_some_and(|e| e.message() == "database unavailable");
    let actual = step(&expected(only, &[], true), vec![
        ("initOutcome", outcome(&used)),
        ("errorIsTheInjectedObject", bool(injected)),
        ("state", h.state()),
        ("calls", h.calls()),
    ]);
    compare(name, 0, expected(only, &[], true), actual);
    h.stop().await.expect("stop");
}

mod pg {
    use super::*;

    /// The product's cluster takes the first free port from its default (`pg/cluster.rs` `free_port`); two stacks opening at once in
    /// one test binary can both find the same port free. One real stack at a time here, as the nextest group `pg-cluster` runs them.
    static ONE_CLUSTER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    pub(super) async fn one_cluster() ->tokio::sync::MutexGuard<'static, ()> {
        awaiting_for(std::time::Duration::from_secs(600), "this binary's other real-cluster lifecycle case", ONE_CLUSTER.lock()).await
    }

    /// Opens the stack through `uses` concurrent uses (all must succeed).
    async fn open(h: &Harness) {
        awaiting_for(OPENING, "the opening", h.use_db()).await.expect("the stack opens");
    }

    /// The stop step of a case: the stop's result as the step records it.
    async fn stop_step(h: &mut Harness, name: &str, at: usize, recorded: &Exact, injected: Option<&str>) {
        let stopped = h.stop().await;
        // The failure-loop test's endpoints (cases 12-15) write the cleanups to `cleanupOrder`, not to `calls`: the stop's steps are compared there.
        let calls = if recorded.try_get("cleanupOrder").is_some() { h.install_calls() } else { h.calls() };
        let mut entries = vec![("state", h.state()), ("calls", calls)];
        if let Some(text) = injected {
            let err = stopped.as_ref().expect_err("the stop reports the injected failure");
            entries.push(("error", error(err)));
            entries.push(("errorIsTheInjectedObject", bool(err.message() == text)));
        } else {
            stopped.expect("the stop");
        }
        if recorded.try_get("cleanupOrder").is_some() {
            // Every cleanup the core owns was attempted, in order, whatever failed.
            let order: Vec<Exact> = h.stack.stop_seam().steps().into_iter().map(|s| string(match s {
                "background-stopped" => "stopBackgroundWork",
                _ => "shutdown",
            })).collect();
            entries.push(("cleanupOrder", Exact::Array(order)));
        }
        let want = expected(recorded, &[], false);
        let want = match want.try_get("cleanupOrder") {
            // withdraw and closeListener are the listener's (declared).
            Some(order) => {
                let kept: Vec<Exact> = order.as_array().iter().filter(|o| !matches!(o.as_str(), "withdraw" | "closeListener")).cloned().collect();
                let Exact::Object(mut entries) = want else { unreachable!() };
                for (key, value) in &mut entries {
                    if key == "cleanupOrder" {
                        *value = Exact::Array(kept.clone());
                    }
                }
                Exact::Object(entries)
            }
            None => want,
        };
        compare(name, at, want.clone(), step(&want, entries));
    }

    fn init_step(h: &mut Harness, name: &str, at: usize, recorded: &Exact) {
        let want = expected(recorded, &[], false);
        compare(name, at, want.clone(), step(&want, vec![("state", h.state()), ("calls", h.calls())]));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_initialization_opens_each_owner_and_publishes_readiness_once() {
        let name = "concurrent initialization opens each owner and publishes readiness once (test line 57)";
        let g = golden(SET);
        let c = case(&g, 0, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
        let (one, two) = awaiting_for(OPENING, "two concurrent uses", futures::future::join(h.use_db(), h.use_db())).await;
        let shared = h.installs.load(Ordering::SeqCst) == 1;
        one.expect("the first use");
        two.expect("the second use");
        open(&h).await;
        let first = &steps(c)[0];
        let want = expected(first, &[], false);
        compare(name, 0, want.clone(), step(&want, vec![("sameInitPromiseWhilePending", bool(shared)), ("state", h.state()), ("calls", h.calls())]));
        stop_step(&mut h, name, 1, &steps(c)[1], None).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_bound_port_is_advertised_before_runtime_readiness_but_ready_waits_for_both() {
        let name = "the bound port is advertised before runtime readiness, but ready waits for both (test line 73)";
        let g = golden(SET);
        let c = case(&g, 1, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let (gate, held) = tokio::sync::oneshot::channel();
        let mut h = Harness::over(&profile, vec![Plan { logs_entry: false, gate: Some(held), ..Plan::opens() }]).await;
        let using = tokio::spawn(h.use_db());
        awaiting("the install to be entered", async {
            while h.installs.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        init_step(&mut h, name, 0, &steps(c)[0]);
        gate.send(()).expect("the install waits at its gate");
        awaiting_for(OPENING, "the opening", using).await.expect("the use").expect("the stack opens");
        init_step(&mut h, name, 1, &steps(c)[1]);
        stop_step(&mut h, name, 2, &steps(c)[2], None).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn integrated_or_secondary_startup_reports_a_null_port_without_advertising() {
        let name = "integrated or secondary startup reports a null port without advertising (test line 178)";
        let g = golden(SET);
        let c = case(&g, 7, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
        open(&h).await;
        init_step(&mut h, name, 0, &steps(c)[0]);
        stop_step(&mut h, name, 1, &steps(c)[1], None).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn initialization_can_restart_after_shutdown_and_after_a_failed_acquisition() {
        let name = "initialization can restart after shutdown and after a failed acquisition (test line 185)";
        let g = golden(SET);
        let c = case(&g, 8, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::fails("first attempt failed"), Plan::opens()]).await;
        let used = awaiting("the first use", h.use_db()).await;
        let err = used.as_ref().expect_err("the first acquisition fails");
        let first = &steps(c)[0];
        let want = expected(first, &[], true);
        compare(name, 0, want.clone(), step(&want, vec![
            ("error", error(err)),
            ("errorIsTheInjectedObject", bool(err.message() == "first attempt failed")),
            ("state", h.state()),
            ("calls", h.calls()),
        ]));
        open(&h).await;
        init_step(&mut h, name, 1, &steps(c)[1]);
        stop_step(&mut h, name, 2, &steps(c)[2], None).await;
        // The next start: the next core's stack over the same profile.
        let mut next = Harness::over(&profile, vec![Plan::opens()]).await;
        open(&next).await;
        init_step(&mut next, name, 3, &steps(c)[3]);
        stop_step(&mut next, name, 4, &steps(c)[4], None).await;
        let attempts = h.installs.load(Ordering::SeqCst) + next.installs.load(Ordering::SeqCst);
        assert_eq!(c.get("attempts"), &Exact::Number(attempts as f64), "{name}: attempts");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn explicit_shutdown_reports_cleanup_failures_and_clears_readiness() {
        let name = "explicit shutdown reports cleanup failures and clears readiness (test line 203)";
        let g = golden(SET);
        let c = case(&g, 9, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
        open(&h).await;
        init_step(&mut h, name, 0, &steps(c)[0]);
        h.stack.stop_seam().fail_storage("database close failed");
        stop_step(&mut h, name, 1, &steps(c)[1], Some("database close failed")).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_stops_workers_before_waiting_for_requests_that_depend_on_those_workers() {
        let name = "shutdown stops workers before waiting for requests that depend on those workers (test line 234)";
        let g = golden(SET);
        let c = case(&g, 11, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
        open(&h).await;
        init_step(&mut h, name, 0, &steps(c)[0]);
        let stopping = &steps(c)[1];
        h.stop().await.expect("the stop");
        let order: Vec<Exact> = h.stack.stop_seam().steps().into_iter().map(|s| string(match s {
            "background-stopped" => "workers-stopped",
            _ => "storage-closed",
        })).collect();
        // `listener-closing` in the recorded order is the listener's (declared).
        let mut want = expected(stopping, &[], false);
        if let Exact::Object(entries) = &mut want {
            for (key, value) in entries {
                if key == "order" {
                    *value = Exact::Array(value.as_array().iter().filter(|o| o.as_str() != "listener-closing").cloned().collect());
                }
            }
        }
        compare(name, 1, want.clone(), step(&want, vec![("order", Exact::Array(order)), ("state", h.state()), ("calls", h.calls())]));
    }

    async fn failing_step(index: usize, name: &str, injected: &str, background: bool) {
        let g = golden(SET);
        let c = case(&g, index, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
        open(&h).await;
        init_step(&mut h, name, 0, &steps(c)[0]);
        if background {
            h.stack.stop_seam().fail_background(injected);
        } else {
            h.stack.stop_seam().fail_storage(injected);
        }
        stop_step(&mut h, name, 1, &steps(c)[1], Some(injected)).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_releases_independent_resources_after_stop_background_work_fails() {
        failing_step(14, "shutdown releases independent resources after stopBackgroundWork fails (test line 250)", "stopBackgroundWork failed", true).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_releases_independent_resources_after_shutdown_fails() {
        failing_step(15, "shutdown releases independent resources after shutdown fails (a further shape: the test loop has three steps) (test line 250)", "shutdown failed", false).await;
    }

    /// Case 16: the worker stop fails; storage is still released and the stop reports the worker's failure. The middle step (the request drain still
    /// open) is the listener's (declared); the last is compared after the stop.
    #[tokio::test(flavor = "current_thread")]
    async fn failed_worker_shutdown_still_drains_active_requests_before_storage_closes() {
        let name = "failed worker shutdown still drains active requests before storage closes (test line 282)";
        let g = golden(SET);
        let c = case(&g, 16, name);
        let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
        let profile = Profile { dir: tempfile::tempdir().expect("dir") };
        let mut h = Harness::over(&profile, vec![Plan::opens()]).await;
        open(&h).await;
        init_step(&mut h, name, 0, &steps(c)[0]);
        h.stack.stop_seam().fail_background("worker termination failed");
        let stopped = h.stop().await;
        let err = stopped.as_ref().expect_err("the stop reports the worker's failure");
        // The core's stop runs the steps of the declared middle step (`workers-stop-throws`) and of the last one in one call: its calls are compared in
        // order, the first recorded step's calls against the stop's first calls, the last step's against the rest.
        let Exact::Array(calls) = h.calls() else { panic!("calls are an array") };
        let middle = expected(&steps(c)[1], &[], false).get("calls").clone();
        let split = middle.as_array().len().min(calls.len());
        compare(name, 1, object(vec![("calls", middle)]), object(vec![("calls", Exact::Array(calls[..split].to_vec()))]));
        let want = expected(&steps(c)[2], &[], false);
        let storage_closed = h.stack.stop_seam().steps().contains(&"storage-released");
        compare(name, 2, want.clone(), step(&want, vec![
            ("error", error(err)),
            ("errorIsTheInjectedObject", bool(err.message() == "worker termination failed")),
            ("storageClosed", bool(storage_closed)),
            ("state", h.state()),
            ("calls", Exact::Array(calls[split..].to_vec())),
        ]));
    }

    /// Case 18: at quit the memory stop fails; the lines the host's quit stop writes to the memory worker's stderr against what Node's memory
    /// process wrote. Only `[memory-service]` lines are compared (the core's own owners, scripted in Node, may write theirs); the "client grace
    /// elapsed" line, `exitCodes` and `calls` are declared in the manifest.
    #[tokio::test(flavor = "current_thread")]
    async fn at_quit_the_last_client_leaves_and_the_memory_stop_fails() {
        use mixdog_rt::node_log::{Channel, Origin};
        let name = "at quit the last client leaves and the memory stop fails: what the memory process writes (memory-daemon-lifecycle.mjs:60-74)";
        let g = golden(SET);
        let c = case(&g, 18, name);
        for quit in c.get("quits").as_array() {
            let failing = quit.get("failing").as_str();
            let _one = crate::memory::replays::service_lifecycle::pg::one_cluster().await;
            let profile = Profile { dir: tempfile::tempdir().expect("dir") };
            let h = Harness::over(&profile, vec![Plan::opens()]).await;
            open(&h).await;
            // The recorder's scripted endpoints: the same failure texts.
            match failing {
                "storage" => h.stack.stop_seam().fail_storage("database close failed"),
                "worker stop and storage" => {
                    h.stack.stop_seam().fail_background("worker termination failed");
                    h.stack.stop_seam().fail_storage("database close failed");
                }
                other => panic!("{name}: a recorded failure this replay does not inject: {other}"),
            }
            let db = h.stack.db();
            let checkpoint = async move { db.client().await?.batch_execute("CHECKPOINT").await.map_err(MemoryError::from) };
            awaiting_for(OPENING, "the checkpoint before the stop", checkpoint).await.expect("the checkpoint before the stop");
            let (lines, guard) = mixdog_rt::node_log::capture();
            awaiting_for(OPENING, "the quit stop", h.stack.stop_for_quit()).await;
            drop(guard);
            let written: Vec<Exact> = lines
                .lock()
                .unwrap()
                .iter()
                .filter(|(origin, channel, line)| *origin == Origin::MemoryWorker && *channel == Channel::Stderr && line.starts_with("[memory-service] "))
                .map(|(_, _, line)| string(mixdog_rt::node_log::bare(line)))
                .collect();
            let want: Vec<Exact> = quit
                .get("logs")
                .as_array()
                .iter()
                .filter(|line| !line.as_str().starts_with("[memory-service] daemon client grace elapsed"))
                .cloned()
                .collect();
            same(&format!("{name}: {failing}"), &Exact::Array(want), &Exact::Array(written));
        }
    }
}
