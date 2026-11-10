//! The recording of when the core tells clients to read a review again (`fixtures/turn-review-signal`), replayed against the core of
//! this crate's tests: the real turn review over real Git and real tools, and the scm service that publishes its signal through the
//! core's own publisher (`StateRuntime`: the feed state that numbers and encodes each section notification on the app feed). The
//! replay itself is `signal_replay`; the scenarios in which a core restarts are replayed against the core as the daemon composes it
//! (`mixdog-app-server-daemon`, `compose::review_restart_tests`). `listeners.json` records the listener registry (subscribe,
//! unsubscribe, removal and addition during a delivery).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and a real git")]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::epoch;
use mixdog_core_base::state::StateRuntime;
use mixdog_core_base::state::empty_view;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_scm::service::FeatureGate;
use mixdog_scm::service::ScmService;
use mixdog_scm::service::ThreadWorktrees;
use mixdog_scm::worktree::review_bases::CapturedBases;
use mixdog_tools::fs::ApplyPatchTool;
use mixdog_tools::fs::EditTool;
use mixdog_tools::fs::ReadState;
use mixdog_tools::git::GitTool;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::disk::LaneDisk;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::scm_ports::ScmGit;
use super::scm_ports::ScmWorktrees;
use super::seams::follow_read_state;
use super::service::Config;
use super::service::TurnReview;
use super::shadow::ShadowRepos;
use super::signal_replay::ReplayHost;
use super::signal_replay::replay;

struct Open;

#[async_trait]
impl FeatureGate for Open {
    async fn github_enabled(&self) -> bool {
        true
    }
}

struct NoHeaders;

#[async_trait]
impl ThreadWorktrees for NoHeaders {
    async fn cwd(&self, _: &ThreadId) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
}

/// The real turn review over real Git and real tools, and the scm service that publishes its signal through the core's own
/// publisher (`StateRuntime`: the feed state that numbers and encodes each section notification on the app feed).
struct World {
    review: TurnReview,
    shadow: Arc<ShadowRepos>,
    app: Arc<MockFeed>,
    state: Arc<ReadState>,
    processes: Arc<mixdog_spawn::LocalProcessManager>,
    // The scm service (and so its listener on the review).
    _service: Arc<ScmService>,
}

fn world(data: &Path) -> World {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes.clone(), tokens.maintenance_io, data.join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(LaneDisk::new(tokens));
    let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm.clone()));
    let shadow = Arc::new(ShadowRepos::new(data.join("turn-worktree-snapshots-v1"), git.clone(), disk.clone()));
    let review = TurnReview::new(Config::default(), tokens.cpu_interactive, data, disk, git, Arc::new(ScmWorktrees::new(shadow.clone())), Arc::new(CapturedBases::new()));
    // The composition root's wiring of the tools' read state to the review.
    let state = Arc::new(ReadState::new(None));
    follow_read_state(Arc::new(review.clone()), &state);
    let (id, at) = (FeedId::from("app"), epoch(1));
    let app = Arc::new(MockFeed::new(id.clone(), at.clone(), empty_view(&id, &at), MockLimits::default()));
    let runtime = StateRuntime::new(app.clone());
    let service = ScmService::new(scm, Arc::new(MockScopedFeeds::new(MockLimits::default())), runtime.publisher.clone(), Arc::new(Open), Arc::new(review.clone()), Arc::new(NoHeaders));
    World { review, shadow, app, state, processes, _service: service }
}

#[async_trait]
impl ReplayHost for World {
    fn review(&self) -> TurnReview {
        self.review.clone()
    }

    fn app_feed(&self) -> Arc<dyn ScopedFeed> {
        self.app.clone()
    }

    async fn call_tool(&self, tool: &str, cwd: &Path, session: &str, call: usize, input: Value) -> ToolOutcome {
        let ctx = context(self, cwd, session, call);
        match tool {
            "edit" => EditTool::new().with_state(self.state.clone()).call(&ctx, input).await,
            "apply_patch" => ApplyPatchTool::new().with_state(self.state.clone()).call(&ctx, input).await,
            "git" => GitTool::new().call(&ctx, input).await,
            other => panic!("this core has no tool {other}"),
        }
    }

    async fn restart(&mut self) {
        panic!("a restart is replayed against the composed core (mixdog-app-server-daemon, compose::review_restart_tests)");
    }
}
fn context(world: &World, cwd: &Path, session: &str, call: usize) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from(format!("call-{call}")),
        thread_id: ThreadId::from(session),
        turn_id: TurnId::from("r"),
        tool: "fs".into(),
        cwd: AbsPath::new(cwd.to_owned()).unwrap(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
        processes: world.processes.clone(),
        options: Default::default(),
        review: Some(Arc::new(world.review.clone())),
    }
}


#[tokio::test]
async fn the_core_tells_clients_to_reread_as_node_does() {
    let golden: Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review-signal/scenarios.json")).unwrap()).unwrap();
    let platform = std::env::consts::OS.replace("windows", "win32");
    let mut replayed = 0;
    for scenario in golden.as_array().unwrap() {
        if scenario["platform"] != platform {
            continue;
        }
        // A scenario in which the core restarts needs a core that composes again over its data directory.
        if scenario["ops"].as_array().unwrap().iter().any(|op| op["coreRestart"] == true) {
            continue;
        }
        let data = tempfile::tempdir().unwrap();
        replay(scenario, &mut world(data.path())).await;
        replayed += 1;
    }
    assert!(replayed > 0, "no recorded scenario for {platform}");
}
/// One recorded listener scenario's functions, handles and call log. What a listener does when it runs is the recording's data.
struct Script {
    shadow: Arc<ShadowRepos>,
    does: HashMap<String, Vec<Value>>,
    fns: Mutex<HashMap<String, Arc<dyn Fn() + Send + Sync>>>,
    handles: Mutex<HashMap<String, Arc<dyn Fn() -> bool + Send + Sync>>>,
    calls: Mutex<Vec<String>>,
}

impl Script {
    fn subscribe(&self, name: &str, handle: &str) {
        let listener = self.fns.lock().unwrap()[name].clone();
        let unsubscribe = self.shadow.on_review_changed(listener);
        self.handles.lock().unwrap().insert(handle.to_owned(), unsubscribe);
    }

    fn unsubscribe(&self, handle: &str) -> bool {
        let unsubscribe = self.handles.lock().unwrap()[handle].clone();
        unsubscribe()
    }

    fn ran(&self, name: &str) {
        self.calls.lock().unwrap().push(name.to_owned());
        for action in &self.does[name] {
            match action["do"].as_str().unwrap() {
                "unsubscribe" => {
                    self.unsubscribe(action["handle"].as_str().unwrap());
                }
                "subscribe" => self.subscribe(action["fn"].as_str().unwrap(), action["handle"].as_str().unwrap()),
                "signal" => self.shadow.raise_review_signal(),
                "throw" => panic!("{name} threw"),
                other => panic!("unknown action {other}"),
            }
        }
    }
}

/// `onTurnReviewChanged` / `noteTurnReviewChanged` against Node's recording of the same scripts: which listeners run, in what
/// order, when an unsubscribe finds its listener, and what a listener that changes the registry mid-delivery does to the delivery
/// under way. The ops run in one task on the multi-thread runtime, with no yield between them but `drain`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listeners_come_and_go_as_in_node() {
    let golden: Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review-signal/listeners.json")).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for scenario in golden.as_array().unwrap() {
        let world = world(dir.path());
        let script = Arc::new(Script {
            shadow: world.shadow.clone(),
            does: scenario["fns"].as_object().unwrap().iter().map(|(name, body)| (name.clone(), body["does"].as_array().unwrap().clone())).collect(),
            fns: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
        });
        for name in script.does.keys() {
            let (runs, named) = (script.clone(), name.clone());
            script.fns.lock().unwrap().insert(name.clone(), Arc::new(move || runs.ran(&named)));
        }
        let scenario = scenario.clone();
        let running = script.clone();
        let shadow = world.shadow.clone();
        let results = tokio::spawn(async move {
            let mut results = Vec::new();
            for (index, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
                running.calls.lock().unwrap().clear();
                let mut answered = None;
                match op["op"].as_str().unwrap() {
                    "subscribe" => running.subscribe(op["fn"].as_str().unwrap(), op["handle"].as_str().unwrap()),
                    "unsubscribe" => answered = Some(running.unsubscribe(op["handle"].as_str().unwrap())),
                    "signal" => shadow.raise_review_signal(),
                    "drain" => shadow.review_signal_settled().await,
                    other => panic!("unknown op {other}"),
                }
                let mut result = serde_json::json!({ "op": index, "calls": running.calls.lock().unwrap().clone() });
                if let Some(answer) = answered {
                    result["answered"] = answer.into();
                }
                results.push(result);
            }
            (scenario, results)
        })
        .await
        .unwrap();
        let (scenario, results) = results;
        assert_eq!(Value::Array(results), scenario["results"], "{}", scenario["name"]);
    }
}

/// A wait for a delivery that never ends fails by assertion, naming what it waited for, once its deadline passes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_delivery_that_never_ends_fails_the_wait() {
    let dir = tempfile::tempdir().unwrap();
    let world = world(dir.path());
    let (release, held) = std::sync::mpsc::channel::<()>();
    let held = Mutex::new(held);
    world.shadow.on_review_changed(Arc::new(move || {
        // Held until the test lets go; an error means the test is over.
        let _ = held.lock().unwrap().recv();
    }));
    let shadow = world.shadow.clone();
    let outcome = tokio::spawn(async move {
        shadow.raise_review_signal();
        shadow.review_signal_settled_within(std::time::Duration::from_millis(200)).await;
    })
    .await;
    let failure = outcome.expect_err("the wait must fail while a listener never returns").into_panic();
    let message = failure.downcast_ref::<String>().expect("the failure names what was awaited");
    assert!(message.contains("onTurnReviewChanged listeners did not finish within"), "{message}");
    release.send(()).unwrap();
    world.shadow.review_signal_settled().await;
}

/// A burst of signals within one task is one delivery to every listener registered by then, on the multi-thread
/// runtime production uses.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_is_one_delivery_to_every_listener_including_a_late_one() {
    let dir = tempfile::tempdir().unwrap();
    let world = world(dir.path());
    let early = Arc::new(AtomicUsize::new(0));
    let counter = early.clone();
    world.shadow.on_review_changed(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    for round in 1..=300 {
        let late = Arc::new(AtomicUsize::new(0));
        let shadow = world.shadow.clone();
        let counter = late.clone();
        tokio::spawn(async move {
            shadow.raise_review_signal();
            shadow.on_review_changed(Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }));
            shadow.raise_review_signal();
            shadow.raise_review_signal();
        })
        .await
        .unwrap();
        world.shadow.review_signal_settled().await;
        assert_eq!(late.load(Ordering::SeqCst), 1, "round {round}: a listener registered during the burst");
        assert_eq!(early.load(Ordering::SeqCst), round, "round {round}: one delivery for the burst");
    }
}
