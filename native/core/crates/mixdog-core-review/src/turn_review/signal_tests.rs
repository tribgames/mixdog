//! When the core tells clients to read a review again, and what they read then, against Node's recording of the same
//! actions (`fixtures/turn-review-signal`, from `record-turn-review-signal.mjs` at `b6f10295a`).
//!
//! Node's `noteTurnReviewChanged` names no session: its desktop consumer forwards each delivery as the data-less
//! `turn-review-changed` event and every open client rereads the review of the session it shows. The recording holds, per
//! action, each delivery in order with every client's whole reread answer. The replay runs the same actions through the
//! real tools (`edit`, `apply_patch`, `git`), the real turn review over real Git and the real scm service; each delivery
//! must be one `reviewDiff` publication to every open client, exactly the bytes `REVIEW_REREAD`, and each client's reread
//! must answer the recorded answer whole.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and a real git")]

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
use mixdog_protocol::SectionName;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_scm::service::FeatureGate;
use mixdog_scm::service::REVIEW_REREAD;
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

/// What a core's publisher does with a `reviewDiff` section: it keeps every publication, and the threads that clients
/// hold open are its routes.
#[derive(Default)]
struct Clients {
    open: Mutex<Vec<String>>,
    published: Mutex<Vec<(SectionName, Option<String>, SectionChange)>>,
}

impl StatePublisher for Clients {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        self.published.lock().unwrap().push((section, key, change));
    }

    fn open_keys(&self, section: SectionName) -> Vec<String> {
        assert_eq!(section, SectionName::ReviewDiff);
        let mut open = self.open.lock().unwrap().clone();
        open.sort();
        open
    }
}

/// The real turn review over real Git and real tools, and the scm service that publishes its signal.
struct World {
    review: TurnReview,
    shadow: Arc<ShadowRepos>,
    clients: Arc<Clients>,
    state: Arc<ReadState>,
    processes: Arc<mixdog_spawn::LocalProcessManager>,
    // Keeps the service (and so its listener) alive for the scenario.
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
    let clients = Arc::new(Clients::default());
    let service = ScmService::new(
        scm,
        Arc::new(MockScopedFeeds::new(MockLimits::default())),
        clients.clone(),
        Arc::new(Open),
        Arc::new(review.clone()),
        Arc::new(NoHeaders),
    );
    // The composition root's wiring of the tools' read state to the review.
    let state = Arc::new(ReadState::new(None));
    follow_read_state(Arc::new(review.clone()), &state);
    World { review, shadow, clients, state, processes, _service: service }
}

fn plain(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text)
}

fn text_of(outcome: mixdog_core_api::domain::tool::ToolOutcome) -> (bool, String) {
    match outcome {
        Ok(out) => (false, out.parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("")),
        Err(error) => (true, error.message_for_model),
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

/// `<name>` tokens of a recorded value back to the scenario's directories.
fn restore(value: &Value, roots: &HashMap<&str, PathBuf>) -> Value {
    match value {
        Value::String(text) => {
            let mut text = text.clone();
            for (name, root) in roots {
                text = text.replace(&format!("<{name}>"), &plain(root));
            }
            Value::String(text)
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| restore(item, roots)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), restore(item, roots))).collect()),
        other => other.clone(),
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
        replay(scenario).await;
        replayed += 1;
    }
    assert!(replayed > 0, "no recorded scenario for {platform}");
}

async fn replay(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let roots: HashMap<&str, PathBuf> = [("base", base.clone()), ("w1", base.join("w1")), ("w2", base.join("w2")), ("ng", base.join("plain"))].into();
    for root in ["w1", "w2", "ng"] {
        std::fs::create_dir_all(&roots[root]).unwrap();
    }
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let world = world(&data);
    let review = &world.review;
    let at = |spec: &Value| match spec.get("path").and_then(Value::as_str) {
        Some(path) => roots[spec["ws"].as_str().unwrap()].join(path),
        None => roots[spec["ws"].as_str().unwrap()].clone(),
    };
    let mut tokens: HashMap<String, TurnToken> = HashMap::new();
    let mut revisions: HashMap<String, f64> = HashMap::new();
    let mut clients: Vec<(String, String)> = Vec::new();
    let mut calls = 0;
    let mut seen = 0;
    for (index, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
        let want = &scenario["results"][index];
        assert_eq!(want["op"], index);
        let session = op.get("session").and_then(Value::as_str).unwrap_or("");
        let checkpoint = op.get("checkpoint").and_then(Value::as_str).unwrap_or("");
        let ws_text = op.get("ws").and_then(Value::as_str).map(|ws| plain(&roots[ws])).unwrap_or_default();
        let label = format!("{name}: op {index} {op}");
        let kind = op["op"].as_str().unwrap();
        match kind {
            "git" => {
                let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(&roots[op["ws"].as_str().unwrap()]).status().unwrap();
                assert!(status.success());
            }
            "file" | "external" => {
                let target = at(op);
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(target, op["content"]["text"].as_str().unwrap()).unwrap();
            }
            "client" => {
                clients.push((session.to_owned(), op["ws"].as_str().unwrap().to_owned()));
                world.clients.open.lock().unwrap().push(session.to_owned());
            }
            "begin" => {
                let open = TurnOpen { checkpoint_id: checkpoint.to_owned(), continue_turn: false };
                tokens.insert(session.to_owned(), review.begin_turn(&ws_text, session, open).await.expect("a turn"));
            }
            "complete" => assert_eq!(review.complete_turn(session, tokens.get(session)).await, want["completed"], "{label}"),
            "edit" | "patch" | "gitTool" => {
                calls += 1;
                let ctx = context(&world, &roots[op["ws"].as_str().unwrap()], session, calls);
                let outcome = match kind {
                    "edit" => EditTool::new().with_state(world.state.clone()).call(&ctx, serde_json::json!({ "file_path": op["path"], "old_string": op["old"], "new_string": op["new"] })).await,
                    "patch" => ApplyPatchTool::new().with_state(world.state.clone()).call(&ctx, serde_json::json!({ "patch": op["patch"] })).await,
                    _ => GitTool::new().call(&ctx, serde_json::json!({ "command": op["command"] })).await,
                };
                let (is_error, _) = text_of(outcome);
                assert_eq!(is_error, want["text"].as_str().unwrap().starts_with("Error"), "{label}");
            }
            "sessionReview" => {
                let reply = review.session_review_diff(&ws_text, session).await;
                assert_eq!(Value::Object(reply), restore(&want["answer"], &roots), "{label}");
            }
            "revert" => {
                let result = match op.get("file").and_then(Value::as_str) {
                    Some(file) => review.revert_turn_review_file(&ws_text, session, file, checkpoint).await,
                    None => review.revert_turn_review(&ws_text, session, checkpoint).await,
                };
                assert_eq!(result.is_ok(), want["ok"], "{label}");
            }
            "changes" => {
                let read = ChangesRead { checkpoint_id: checkpoint.to_owned(), patch: false, file: None };
                revisions.insert(checkpoint.to_owned(), review.turn_changes(session, read).await.unwrap()["revision"].as_f64().unwrap());
            }
            "undo" | "redo" => {
                let file = op.get("file").and_then(Value::as_str);
                let revision = revisions[checkpoint];
                let result = if kind == "undo" {
                    review.revert_turn_changes(session, checkpoint, file, revision).await
                } else {
                    review.reapply_turn_changes(session, checkpoint, file, revision).await
                };
                assert_eq!(result.is_ok(), want["ok"], "{label}");
                if let Ok(reply) = result {
                    revisions.insert(checkpoint.to_owned(), reply["revision"].as_f64().unwrap());
                }
            }
            other => panic!("{label}: unknown op {other}"),
        }
        // Each delivery is one publication to every open client, then every client rereads, and a reread may raise the next.
        world.shadow.review_signal_settled().await;
        let mut sorted = clients.clone();
        sorted.sort();
        for (nth, delivery) in want["deliveries"].as_array().unwrap().iter().enumerate() {
            assert_eq!(delivery["notification"], serde_json::json!({ "event": "turn-review-changed", "payload": null }));
            let published = world.clients.published.lock().unwrap().clone();            let group = published.get(seen..seen + sorted.len()).unwrap_or_else(|| panic!("{label}: delivery {nth} was never published"));
            let expected: Vec<(SectionName, Option<String>, SectionChange)> =
                sorted.iter().map(|(session, _)| (SectionName::ReviewDiff, Some(session.clone()), SectionChange::Set(Bytes::from_static(REVIEW_REREAD)))).collect();
            assert_eq!(group, expected.as_slice(), "{label}: delivery {nth}");
            seen += sorted.len();
            for (reread, (client, ws)) in delivery["rereads"].as_array().unwrap().iter().zip(&sorted) {
                assert_eq!(reread["session"], *client, "{label}");
                let reply = review.turn_review_diff(&plain(&roots[ws.as_str()]), client, ReviewRead::default()).await;
                assert_eq!(Value::Object(reply), restore(&reread["answer"], &roots), "{label}: delivery {nth}, client {client}");
                world.shadow.review_signal_settled().await;
            }
        }
        assert_eq!(world.clients.published.lock().unwrap().len(), seen, "{label}: more deliveries than Node made");
    }
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
