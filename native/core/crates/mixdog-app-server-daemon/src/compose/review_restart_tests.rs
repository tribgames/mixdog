//! The scenarios of Node's review-signal recording in which the core restarts, replayed against the core as the daemon composes it:
//! composed (`compose`), stopped, and composed again over the same data directory. Each composition draws an epoch of its own for the app
//! feed, and a restarted core rebuilds its turn review from what the first one wrote to the data directory (a sealed turn is read
//! back; a turn that was running is gone with the process, as in Node, which writes a turn's record when it seals). Integration:
//! needs a bundled PostgreSQL runtime (`MIXDOG_PG_RUNTIME`), like the other tests that compose the real core.
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

/// The daemon's composed core, as the replay's host.
struct Composed {
    /// The data directory both compositions share; removed when the host is dropped, on a failed replay as on a passed one.
    dir: tempfile::TempDir,
    core: Option<ComposedCore>,
    /// The epoch of every app feed this host composed, oldest first.
    epochs: Vec<String>,
}

impl Composed {
    async fn start() -> Self {
        let mut host = Self { dir: tempfile::tempdir().unwrap(), core: None, epochs: Vec::new() };
        host.compose().await;
        host
    }

    async fn compose(&mut self) {
        let dir = self.dir.path().to_owned();
        let log = crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new());
        let tokens = mixdog_rt::testing::tokens();
        let composing = compose(&tokens, tests::config(&dir, log, mixdog_rt::CancellationToken::new()));
        let core = awaiting_for(LIMIT, || "the core to compose over the data directory".to_owned(), composing).await.expect("the core composes");
        let epoch = core.app_feed_core().position().epoch.to_string();
        assert!(!self.epochs.contains(&epoch), "a core composed again over the same data directory drew the epoch of an earlier one: {epoch}");
        self.epochs.push(epoch);
        self.core = Some(core);
    }

    async fn stop(&mut self) {
        let core = self.core.take().expect("a core is running");
        awaiting_for(LIMIT, || "the core to stop".to_owned(), core.stop("test")).await;
    }

    fn core(&self) -> &ComposedCore {
        self.core.as_ref().expect("a core is running")
    }
}

/// A replay that fails leaves its core running: end it, so its cluster does not outlive the test (the data directory goes with the host).
impl Drop for Composed {
    fn drop(&mut self) {
        let Some(core) = self.core.take() else { return };
        let runtime = tokio::runtime::Handle::current();
        // Off this thread: it may be a runtime worker unwinding, which cannot block_on.
        let _ = std::thread::spawn(move || runtime.block_on(awaiting_for(LIMIT, || "the core to stop after a failed replay".to_owned(), core.stop("test failed")))).join();
    }
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
        self.stop().await;
        self.compose().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
async fn a_core_composed_again_tells_and_answers_as_node_does() {
    let _one = crate::compose_test_support::exclusive().await;
    let golden: Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review-signal/scenarios.json")).unwrap()).unwrap();
    let platform = std::env::consts::OS.replace("windows", "win32");
    let mut replayed = 0;
    for scenario in golden.as_array().unwrap() {
        if scenario["platform"] != platform || !scenario["ops"].as_array().unwrap().iter().any(|op| op["coreRestart"] == true) {
            continue;
        }
        let mut host = Composed::start().await;
        replay(scenario, &mut host).await;
        let restarts = scenario["ops"].as_array().unwrap().iter().filter(|op| op["coreRestart"] == true).count();
        assert_eq!(host.epochs.len(), restarts + 1, "a composition per start");
        host.stop().await;
        replayed += 1;
    }
    assert!(replayed > 0, "no recorded scenario with a restart for {platform}");
}