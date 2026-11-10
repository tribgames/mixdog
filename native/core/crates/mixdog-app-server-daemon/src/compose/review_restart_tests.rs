//! The scenarios of Node's review-signal recording in which the core restarts, replayed against the core as the daemon composes it:
//! composed (`compose`), stopped, and composed again over the same data directory. Each composition draws an epoch of its own for the app
//! feed, and a restarted core rebuilds its turn review from what the first one wrote to the data directory (a sealed turn is read
//! back; a turn that was running is gone with the process, as in Node, which writes a turn's record when it seals). Integration:
//! needs a bundled PostgreSQL runtime (`MIXDOG_PG_RUNTIME`), like the other tests that compose the real core.
//!
//! The core is ended by `ComposedCore::stop` (final barriers, the extension host, the stop steps: what the daemon's release procedure runs). The
//! rest of the daemon's shutdown (`lib.rs` `serve`, `serving.rs` `core_wiring`: the lifecycle's budgets, the connections closed between the
//! barriers and the host, `last-exit.json`, withdrawing discovery) is not run: no server is started here.
#![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded fixture")]

use std::path::Path;

use async_trait::async_trait;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_review::turn_review::TurnReview;
use mixdog_core_review::turn_review::signal_replay::ReplayHost;
use mixdog_core_review::turn_review::signal_replay::replay;
use mixdog_core_session::session::testing::awaiting_for;

/// A composition brings up a Postgres cluster and a stop shuts it down: minutes on a loaded disk, never unbounded.
const LIMIT: std::time::Duration = std::time::Duration::from_secs(180);
use serde_json::Value;

use super::*;

/// What the host has started and not yet seen end. The composition and the stop each run as a task of their own, which a deadline that expires does not drop:
/// the task is still here for the cleanup to wait for, so a half-finished composition (its Postgres is started before the core exists) or a stop that
/// ran over its deadline is ended before the data directory goes.
#[derive(Default)]
struct Held {
    /// A composition under way, with the interrupt that ends its slow waits (and makes it give back what it acquired).
    starting: Option<(tokio::task::JoinHandle<Result<ComposedCore, ComposeError>>, mixdog_rt::CancellationToken)>,
    core: Option<std::sync::Arc<ComposedCore>>,
    /// The stop of `core`, once begun.
    stopping: Option<tokio::task::JoinHandle<()>>,
}

impl Held {
    async fn stop(&mut self) {
        let core = self.core.clone().expect("a core is running");
        let stopping = self.stopping.get_or_insert_with(|| tokio::spawn(async move { core.stop("test").await }));
        awaiting_for(LIMIT, || "the core to stop".to_owned(), &mut *stopping).await.expect("the stop ran to its end");
        self.stopping = None;
        self.core = None;
    }

    /// Ends whatever is still running: a composition is interrupted and waited for (a core it produced is stopped), then a running core is stopped.
    async fn end(&mut self) {
        if let Some((task, interrupt)) = self.starting.as_mut() {
            interrupt.cancel();
            let outcome = awaiting_for(LIMIT, || "the interrupted composition to end".to_owned(), task).await;
            self.starting = None;
            if let Ok(Ok(core)) = outcome {
                self.core = Some(std::sync::Arc::new(core));
            }
        }
        if self.core.is_some() {
            self.stop().await;
        }
    }
}

/// The daemon's composed core, as the replay's host.
struct Composed {
    /// The directory both compositions share (its data holds the runtime and the core's data); the test's own, removed by it after the runtime that ran
    /// the cores has ended.
    dir: std::path::PathBuf,
    held: Held,
    /// The epoch of every app feed this host composed, oldest first.
    epochs: Vec<String>,
}

impl Composed {
    async fn start(dir: &Path) -> Self {
        let mut host = Self { dir: dir.to_owned(), held: Held::default(), epochs: Vec::new() };
        host.compose().await;
        host
    }

    async fn compose(&mut self) {
        let dir = self.dir.clone();
        let tokens = mixdog_rt::testing::tokens();
        let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new());
        let config = tests::config_in(&dir.join("data"), &dir, log, mixdog_rt::CancellationToken::new());
        let interrupt = mixdog_rt::CancellationToken::new();
        let task = tokio::spawn({
            let interrupt = interrupt.clone();
            async move { compose_interruptible(&tokens, config, interrupt).await }
        });
        let (task, _) = self.held.starting.insert((task, interrupt));
        let outcome = awaiting_for(LIMIT, || "the core to compose over the data directory".to_owned(), task).await;
        self.held.starting = None;
        let core = outcome.expect("the composition ran to its end").expect("the core composes");
        let epoch = core.app_feed_core().position().epoch.to_string();
        self.held.core = Some(std::sync::Arc::new(core));
        assert!(!self.epochs.contains(&epoch), "a core composed again over the same data directory drew the epoch of an earlier one: {epoch}");
        self.epochs.push(epoch);
    }

    fn core(&self) -> &ComposedCore {
        self.held.core.as_ref().expect("a core is running")
    }
}

/// Whatever a failed replay (or a deadline) left running is ended here; a core that does not end fails the test with what happened.
impl Drop for Composed {
    fn drop(&mut self) {
        let mut held = std::mem::take(&mut self.held);
        let runtime = tokio::runtime::Handle::current();
        // Off this thread: it may be a runtime worker unwinding, which cannot block_on.
        let ended = std::thread::spawn(move || runtime.block_on(async move { held.end().await })).join();
        if let Err(panic) = ended {
            let text = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned())).unwrap_or_default();
            if std::thread::panicking() {
                eprintln!("the core did not end: {text}");
            } else {
                panic!("the core did not end: {text}");
            }
        }
    }
}

/// The files under `dir` that cannot be removed now (a process or task still holds them).
fn held_files(dir: &Path) -> Vec<String> {
    let mut held = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return held };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            held.extend(held_files(&path));
        } else if std::fs::remove_file(&path).is_err() {
            held.push(path.display().to_string());
        }
    }
    held
}

#[async_trait]
impl ReplayHost for Composed {
    fn review(&self) -> TurnReview {
        (*self.core().real.turn_review).clone()
    }

    fn app_feed(&self) -> std::sync::Arc<dyn ScopedFeed> {
        self.core().app_feed_core().clone()
    }

    async fn call_tool(&self, tool: &str, cwd: &Path, session: &str, call: usize, input: Value) -> ToolOutcome {
        let core = self.core();
        let tool = core.real.tool_pool.iter().find(|candidate| candidate.spec().name == tool).unwrap_or_else(|| panic!("the composed core has no tool {tool}"));
        let tokens = mixdog_rt::testing::tokens();
        let ctx = ToolContext {
            call_id: mixdog_protocol::ToolCallId::from(format!("call-{call}")),
            thread_id: mixdog_protocol::ThreadId::from(session),
            turn_id: mixdog_protocol::TurnId::from("r"),
            tool: "fs".into(),
            cwd: mixdog_core_api::domain::common::AbsPath::new(cwd.to_owned()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: mixdog_rt::CancellationToken::new(),
            deadline: None,
            progress: std::sync::Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: std::sync::Arc::new(MockApprovalGate::default()),
            files: core.file_service.clone(),
            processes: std::sync::Arc::new(core.local_processes().clone()),
            options: Default::default(),
            review: Some(core.real.turn_review.clone()),
        };
        tool.call(&ctx, input).await
    }

    async fn restart(&mut self) {
        self.held.stop().await;
        self.compose().await;
    }

    async fn finish(&mut self) {
        self.held.stop().await;
    }
}

/// The directory the child process works in; set only in the child.
const CHILD_DIR: &str = "MIXDOG_REVIEW_RESTART_DIR";
/// How long the child may run: both compositions, the replay and the stops, each bounded by `LIMIT` at its own wait.
const CHILD_LIMIT: std::time::Duration = std::time::Duration::from_secs(600);

/// The cores are composed and replayed in a child process (this test binary, run for this test alone), and the data directory is removed by the parent
/// once the child has ended. A composed core's SQLite stores stay open until its process ends (they outlive the core's stop and a runtime that is
/// dropped), which on Windows blocks removing their files: only the end of the process that held them makes the removal certain. A child that
/// fails, runs over its limit (it is killed) or leaves the directory not removable fails the test with what is still held.
#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn a_core_composed_again_tells_and_answers_as_node_does() {
    if let Some(dir) = std::env::var_os(CHILD_DIR) {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
        let _one = runtime.block_on(crate::compose_test_support::exclusive());
        runtime.block_on(replay_scenarios_with_restarts(Path::new(&dir)));
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let test = "compose::review_restart_tests::a_core_composed_again_tells_and_answers_as_node_does";
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--ignored", "--nocapture", "--test-threads=1"])
        .env(CHILD_DIR, dir.path())
        .spawn()
        .expect("the child test process starts");
    let (done, ended) = std::sync::mpsc::channel();
    let id = child.id();
    let waiter = std::thread::spawn(move || {
        let status = child.wait();
        let _ = done.send(());
        status
    });
    let outcome = ended.recv_timeout(CHILD_LIMIT);
    if outcome.is_err() {
        kill_tree(id);
    }
    let status = waiter.join().expect("the waiting thread").expect("the child's status");
    let path = dir.path().to_owned();
    let removed = dir.close();
    assert!(outcome.is_ok(), "the child test process ran over {CHILD_LIMIT:?} and was killed ({status})");
    assert!(status.success(), "the child test process failed: {status}");
    if let Err(error) = removed {
        panic!("the data directory {} was not removed after the child ended: {error}; still held: {:?}", path.display(), held_files(&path));
    }
}

/// Ends a process and every process it started (the core's Postgres among them).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).status();
}
async fn replay_scenarios_with_restarts(root: &Path) {
    let golden: Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review-signal/scenarios.json")).unwrap()).unwrap();
    let platform = std::env::consts::OS.replace("windows", "win32");
    let mut replayed = 0;
    for scenario in golden.as_array().unwrap() {
        if scenario["platform"] != platform || !scenario["ops"].as_array().unwrap().iter().any(|op| op["coreRestart"] == true) {
            continue;
        }
        let dir = root.join(format!("scenario-{replayed}"));
        std::fs::create_dir_all(dir.join("data")).unwrap();
        crate::compose_test_support::install(&dir.join("data"));
        let mut host = Composed::start(&dir).await;
        replay(scenario, &mut host).await;
        let restarts = scenario["ops"].as_array().unwrap().iter().filter(|op| op["coreRestart"] == true).count();
        assert_eq!(host.epochs.len(), restarts + 1, "a composition per start");
        assert!(host.held.core.is_none(), "the replay ended the last core");
        replayed += 1;
    }
    assert!(replayed > 0, "no recorded scenario with a restart for {platform}");
}