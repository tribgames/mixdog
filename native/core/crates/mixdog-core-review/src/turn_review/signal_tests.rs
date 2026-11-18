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
#[cfg(node_twin)]
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::FeedTap;
use mixdog_core_api::turn_review::TurnReviewApi;
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
#[cfg(node_twin)]
use mixdog_tools::fs::ApplyPatchTool;
use mixdog_tools::fs::EditTool;
use mixdog_tools::fs::ReadState;
#[cfg(node_twin)]
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
#[cfg(node_twin)]
use super::signal_replay::ReplayHost;
#[cfg(node_twin)]
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
    World {
        review,
        shadow,
        app,
        state,
        processes,
        _service: service,
    }
}

#[cfg(node_twin)]
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


#[cfg(node_twin)]
const SLICES: usize = 3;

/// The recorded scenarios this platform replays here: its own, without those in which the core restarts (those need a core
/// that composes again over its data directory).
#[cfg(node_twin)]
fn replayable(golden: &Value) -> Vec<&Value> {
    let platform = std::env::consts::OS.replace("windows", "win32");
    golden
        .as_array()
        .unwrap()
        .iter()
        .filter(|scenario| scenario["platform"] == platform)
        .filter(|scenario| !scenario["ops"].as_array().unwrap().iter().any(|op| op["coreRestart"] == true))
        .collect()
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


#[cfg(node_twin)]
fn signal_golden() -> Value {
    serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review-signal/scenarios.json")).unwrap()).unwrap()
}
/// Replays the replayable scenarios whose position is `slice` modulo `SLICES`.
#[cfg(node_twin)]
async fn replay_slice(slice: usize) {
    let golden = signal_golden();
    let mut replayed = 0;
    for (position, scenario) in replayable(&golden).into_iter().enumerate() {
        if position % SLICES != slice {
            continue;
        }
        let data = tempfile::tempdir().unwrap();
        replay(scenario, &mut world(data.path())).await;
        replayed += 1;
    }
    assert!(REGISTERED_SIGNAL_SLICES.contains(&slice));
    assert_eq!(replayed, (0..replayable(&golden).len()).filter(|position| position % SLICES == slice).count(), "executed scenarios");
    println!("slice {slice}: {replayed} scenarios replayed");
}
#[cfg(node_twin)]
macro_rules! registered_the_core_tells_clients_to_reread_as_node_does {
    ($($name:ident => $slice:expr),* $(,)?) => {
        const REGISTERED_SIGNAL_SLICES: &[usize] = &[$($slice),*];
        $(#[tokio::test]
        async fn $name() { replay_slice($slice).await; })*
    };
}
#[cfg(node_twin)]
#[test]
fn the_slices_replay_every_recorded_scenario_of_this_platform_once() {
    let golden = signal_golden();
    let total = replayable(&golden).len();
    assert_eq!(REGISTERED_SIGNAL_SLICES, &(0..SLICES).collect::<Vec<_>>());
    let covered: usize = REGISTERED_SIGNAL_SLICES.iter().map(|slice| (0..total).filter(|position| position % SLICES == *slice).count()).sum();
    println!("{total} scenarios in {SLICES} slices");
    assert!(total > 0, "no recorded scenario for this platform");
    assert_eq!(covered, total);
}
/// `onTurnReviewChanged` / `noteTurnReviewChanged` against Node's recording of the same scripts: which listeners run, in what
/// order, when an unsubscribe finds its listener, and what a listener that changes the registry mid-delivery does to the delivery
/// under way. The ops run in one task on the multi-thread runtime, with no yield between them but `drain`.
#[cfg(node_twin)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listeners_come_and_go_as_in_node() {
    let golden: Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review-signal/listeners.json")).unwrap()).unwrap();
    for scenario in golden.as_array().unwrap() {
        assert_eq!(Value::Array(play(scenario).await), scenario["results"], "{}", scenario["name"]);
    }
}

/// One listener script run on a fresh core: each op's name, the listeners it ran and, for an unsubscribe, whether it found its
/// listener. The ops run in one task on the multi-thread runtime, with no yield between them but `drain`.
async fn play(scenario: &Value) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
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
    let (scenario, running, shadow) = (scenario.clone(), script.clone(), world.shadow.clone());
    tokio::spawn(async move {
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
        results
    })
    .await
    .unwrap()
}

#[cfg(node_twin)]
registered_the_core_tells_clients_to_reread_as_node_does! {
    the_core_tells_clients_to_reread_as_node_does_slice_0 => 0,
    the_core_tells_clients_to_reread_as_node_does_slice_1 => 1,
    the_core_tells_clients_to_reread_as_node_does_slice_2 => 2,
}

/// Listeners hear each delivery in the order they subscribed, and one that unsubscribed hears no more; a second unsubscribe
/// of the same handle finds nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listeners_are_called_in_subscription_order_until_they_unsubscribe() {
    let dir = tempfile::tempdir().unwrap();
    let world = world(dir.path());
    let calls = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let listener = |name: &'static str| {
        let calls = calls.clone();
        Arc::new(move || calls.lock().unwrap().push(name)) as Arc<dyn Fn() + Send + Sync>
    };
    let _first = world.shadow.on_review_changed(listener("first"));
    let second = world.shadow.on_review_changed(listener("second"));
    let _third = world.shadow.on_review_changed(listener("third"));

    world.shadow.raise_review_signal();
    world.shadow.review_signal_settled().await;
    assert_eq!(*calls.lock().unwrap(), ["first", "second", "third"]);

    assert!(second(), "the first unsubscribe finds its listener");
    assert!(!second(), "the second finds nothing");
    calls.lock().unwrap().clear();
    world.shadow.raise_review_signal();
    world.shadow.review_signal_settled().await;
    assert_eq!(*calls.lock().unwrap(), ["first", "third"]);
}

/// A review change tells an attached client to read the review again: one `reviewDiff` section frame reaches the app feed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_review_signal_reaches_an_attached_client_as_a_review_diff_frame() {
    let dir = tempfile::tempdir().unwrap();
    let world = world(dir.path());
    let feed: Arc<dyn ScopedFeed> = world.app.clone();
    let tap = FeedTap::attach(&feed);
    world.shadow.raise_review_signal();
    world.shadow.review_signal_settled().await;
    let frames = tap.notifications_until(|seen| seen.iter().any(|frame| frame.to_string().contains("reviewDiff"))).await;
    assert!(frames.iter().any(|frame| frame.to_string().contains("reviewDiff")), "{frames:?}");
}

/// A file edited through the real edit tool inside a turn of a Git workspace tells clients to read the review again: the core's own
/// listeners are called, and one `reviewDiff` section frame reaches an attached app feed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: a real directory and a real git")]
async fn an_edit_inside_a_turn_of_a_git_workspace_calls_the_review_listeners_and_publishes_a_review_diff_frame() {
    let dir = tempfile::tempdir().unwrap();
    // The path a person names: the canonical one without Windows' verbatim prefix, which the write guard reads as a share.
    let workspace = std::path::PathBuf::from(dir.path().canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\\?\")).join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&workspace).status().unwrap().success());
    std::fs::write(workspace.join("a.txt"), "one\ntwo\n").unwrap();
    let world = world(&dir.path().join("data"));
    let feed: Arc<dyn ScopedFeed> = world.app.clone();
    let tap = FeedTap::attach(&feed);
    let called = Arc::new(AtomicUsize::new(0));
    let counted = called.clone();
    let _stop = world.review.on_review_changed(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    let cwd = workspace.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    world.review.begin_turn(&cwd, "s1", mixdog_core_api::turn_review::TurnOpen { checkpoint_id: "c1".into(), continue_turn: false }).await.expect("a turn");
    let ctx = context(&world, &workspace, "s1", 1);
    let outcome = EditTool::new().with_state(world.state.clone()).call(&ctx, serde_json::json!({ "file_path": workspace.join("a.txt"), "old_string": "one", "new_string": "uno" })).await;
    assert!(outcome.is_ok(), "{outcome:?}");
    world.review.review_signal_settled().await;
    assert_eq!(std::fs::read_to_string(workspace.join("a.txt")).unwrap(), "uno\ntwo\n");
    assert!(called.load(Ordering::SeqCst) >= 1, "the edit raised no review signal");
    let frames = tap.notifications_until(|seen| seen.iter().any(|frame| frame.to_string().contains("reviewDiff"))).await;
    assert!(frames.iter().any(|frame| frame.to_string().contains("reviewDiff")), "{frames:?}");
}

/// A completed turn's change is listed, undone and applied again, file contents and all, each answering the revision the next must name.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: a real directory and a real git")]
async fn a_completed_turns_change_is_listed_undone_and_applied_again() {
    let dir = tempfile::tempdir().unwrap();
    // The path a person names: the canonical one without Windows' verbatim prefix, which the write guard reads as a share.
    let workspace = std::path::PathBuf::from(dir.path().canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\\?\")).join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&workspace).status().unwrap().success());
    let file = workspace.join("a.txt");
    std::fs::write(&file, "one\ntwo\n").unwrap();
    let world = world(&dir.path().join("data"));
    let cwd = workspace.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    let token = world.review.begin_turn(&cwd, "s1", mixdog_core_api::turn_review::TurnOpen { checkpoint_id: "c1".into(), continue_turn: false }).await.expect("a turn");
    let ctx = context(&world, &workspace, "s1", 1);
    let outcome = EditTool::new().with_state(world.state.clone()).call(&ctx, serde_json::json!({ "file_path": file, "old_string": "one", "new_string": "uno" })).await;
    assert!(outcome.is_ok(), "{outcome:?}");
    assert!(world.review.complete_turn("s1", Some(&token)).await);

    let read = mixdog_core_api::turn_review::ChangesRead { checkpoint_id: "c1".into(), patch: false, file: None };
    let listed = world.review.turn_changes("s1", read).await.unwrap();
    assert!(serde_json::Value::Object(listed.clone()).to_string().contains("a.txt"), "{listed:?}");
    let revision = listed["revision"].as_f64().expect("a revision");

    let undone = world.review.revert_turn_changes("s1", "c1", None, revision).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo\n", "the turn's edit is undone");
    let revision = undone["revision"].as_f64().expect("the undo answers the next revision");
    world.review.reapply_turn_changes("s1", "c1", None, revision).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "uno\ntwo\n", "the turn's edit is applied again");
}

fn scenario(fns: Value, ops: Value) -> Value {
    serde_json::json!({ "fns": fns, "ops": ops })
}

fn calls_of(results: &[Value]) -> Vec<(Vec<String>, Option<bool>)> {
    results.iter().map(|r| (r["calls"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_owned()).collect(), r["answered"].as_bool())).collect()
}

/// Subscribers hear the signals that were delivered while they were subscribed; a burst before the drain is one delivery; a second
/// unsubscribe of the same handle finds nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bursts_unsubscribes_and_late_subscribers_are_delivered_as_recorded_for_the_listener_registry() {
    let results = play(&scenario(
        serde_json::json!({ "a": { "does": [] }, "b": { "does": [] } }),
        serde_json::json!([
            { "op": "signal" }, { "op": "drain" },
            { "op": "subscribe", "fn": "a", "handle": "ha" }, { "op": "subscribe", "fn": "b", "handle": "hb" },
            { "op": "signal" }, { "op": "signal" }, { "op": "drain" },
            { "op": "unsubscribe", "handle": "ha" }, { "op": "unsubscribe", "handle": "ha" },
            { "op": "signal" }, { "op": "drain" },
            { "op": "subscribe", "fn": "a", "handle": "ha" }, { "op": "signal" }, { "op": "unsubscribe", "handle": "hb" }, { "op": "drain" }
        ]),
    ))
    .await;
    let calls = calls_of(&results);
    assert_eq!(calls[0].0, Vec::<String>::new(), "no listener, nothing to call");
    assert_eq!(calls[6].0, ["a", "b"], "two signals before the drain are one delivery");
    assert_eq!((calls[7].1, calls[8].1), (Some(true), Some(false)), "the second unsubscribe finds nothing");
    assert_eq!(calls[10].0, ["b"]);
    assert_eq!(calls[14].0, ["a"], "b unsubscribed between the signal and its delivery");
}

/// A function registered twice is one registration: either handle removes it, and an old handle removes the new registration.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_function_registered_twice_is_one_registration() {
    let results = play(&scenario(
        serde_json::json!({ "a": { "does": [] }, "b": { "does": [] } }),
        serde_json::json!([
            { "op": "subscribe", "fn": "a", "handle": "h1" }, { "op": "subscribe", "fn": "a", "handle": "h2" }, { "op": "subscribe", "fn": "b", "handle": "hb" },
            { "op": "signal" }, { "op": "drain" },
            { "op": "unsubscribe", "handle": "h1" }, { "op": "signal" }, { "op": "drain" },
            { "op": "unsubscribe", "handle": "h2" }, { "op": "subscribe", "fn": "a", "handle": "h3" }, { "op": "unsubscribe", "handle": "h1" },
            { "op": "signal" }, { "op": "drain" }
        ]),
    ))
    .await;
    let calls = calls_of(&results);
    assert_eq!(calls[4].0, ["a", "b"], "a is called once");
    assert_eq!(calls[5].1, Some(true));
    assert_eq!(calls[7].0, ["b"]);
    assert_eq!(calls[8].1, Some(false));
    assert_eq!(calls[10].1, Some(true), "the old handle removes the new registration of the same function");
    assert_eq!(calls[12].0, ["b"]);
}

/// A delivery runs over the listeners as they were when it began, except that one removed meanwhile is skipped and one added is
/// called at the end.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listeners_removed_and_added_during_a_delivery_change_the_delivery_under_way() {
    let results = play(&scenario(
        serde_json::json!({
            "first": { "does": [{ "do": "unsubscribe", "handle": "second" }, { "do": "subscribe", "fn": "added", "handle": "added" }] },
            "second": { "does": [] },
            "third": { "does": [{ "do": "unsubscribe", "handle": "third" }] },
            "added": { "does": [] },
            "x": { "does": [] },
            "mover": { "does": [{ "do": "unsubscribe", "handle": "x" }, { "do": "subscribe", "fn": "x", "handle": "x" }, { "do": "unsubscribe", "handle": "once" }] },
            "once": { "does": [] }
        }),
        serde_json::json!([
            { "op": "subscribe", "fn": "first", "handle": "first" }, { "op": "subscribe", "fn": "second", "handle": "second" },
            { "op": "subscribe", "fn": "third", "handle": "third" }, { "op": "subscribe", "fn": "x", "handle": "x" },
            { "op": "subscribe", "fn": "mover", "handle": "mover" }, { "op": "subscribe", "fn": "once", "handle": "once" },
            { "op": "signal" }, { "op": "drain" }, { "op": "signal" }, { "op": "drain" }
        ]),
    ))
    .await;
    let calls = calls_of(&results);
    assert_eq!(calls[7].0, ["first", "third", "x", "mover", "added", "x"], "second and once were removed before their turn; x re-added by mover is called again; added joins at the end");
    assert_eq!(calls[9].0, ["first", "mover", "added", "x"], "third removed itself");
}

/// A listener that throws does not stop the others; one that signals again causes another delivery.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_listener_that_throws_does_not_stop_the_delivery_and_one_that_signals_causes_another() {
    let results = play(&scenario(
        serde_json::json!({
            "a": { "does": [] }, "boom": { "does": [{ "do": "throw" }] },
            "echo": { "does": [{ "do": "unsubscribe", "handle": "hecho" }, { "do": "signal" }] }, "late": { "does": [] }
        }),
        serde_json::json!([
            { "op": "subscribe", "fn": "a", "handle": "ha" }, { "op": "subscribe", "fn": "boom", "handle": "hboom" }, { "op": "subscribe", "fn": "echo", "handle": "hecho" },
            { "op": "signal" }, { "op": "unsubscribe", "handle": "ha" }, { "op": "subscribe", "fn": "late", "handle": "hlate" },
            { "op": "signal" }, { "op": "drain" }, { "op": "unsubscribe", "handle": "hecho" }, { "op": "signal" }, { "op": "drain" }
        ]),
    ))
    .await;
    let calls = calls_of(&results);
    assert_eq!(calls[7].0, ["boom", "echo", "late", "boom", "late"], "a removed before its delivery; echo's signal is a second delivery without echo");
    assert_eq!(calls[8].1, Some(false), "echo had already removed itself");
    assert_eq!(calls[10].0, ["boom", "late"]);
}
