//! When the core tells clients a review may read differently, against Node's recording of the same actions
//! (`fixtures/turn-review-signal`, recorded by `record-turn-review-signal.mjs` from `b6f10295a`).
//!
//! Node's `noteTurnReviewChanged` carries no session: after each action the recording holds how many times its one
//! listener ran and which sessions had a turn open. The desktop forwards it as `turn-review-changed` and the open
//! session rereads, so a client with any of those sessions open is told once per run of the listener. The core tells
//! it through the `reviewDiff` section of that session's thread; the replay drives the same actions through the real
//! turn review, shadow repositories and Git and compares, per action and per session, the publications it saw.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and a real git")]

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
use mixdog_protocol::SectionName;
use mixdog_protocol::ThreadId;
use mixdog_scm::service::FeatureGate;
use mixdog_scm::service::ScmService;
use mixdog_scm::service::ThreadWorktrees;
use mixdog_scm::worktree::review_bases::CapturedBases;
use serde_json::Value;

use super::disk::LaneDisk;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::scm_ports::ScmGit;
use super::scm_ports::ScmWorktrees;
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

/// The real turn review over real Git, the scm service that publishes its signal, and what it published.
struct World {
    review: TurnReview,
    shadow: Arc<ShadowRepos>,
    published: Arc<MockStatePublisher>,
    // Keeps the service (and so its listener) alive for the scenario.
    _service: Arc<ScmService>,
}

fn world(data: &Path) -> World {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, data.join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(LaneDisk::new(tokens));
    let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm.clone()));
    let shadow = Arc::new(ShadowRepos::new(data.join("turn-worktree-snapshots-v1"), git.clone(), disk.clone()));
    let review = TurnReview::new(Config::default(), tokens.cpu_interactive, data, disk, git, Arc::new(ScmWorktrees::new(shadow.clone())), Arc::new(CapturedBases::new()));
    let published = Arc::new(MockStatePublisher::default());
    let service = ScmService::new(
        scm,
        Arc::new(MockScopedFeeds::new(MockLimits::default())),
        published.clone(),
        Arc::new(Open),
        Arc::new(review.clone()),
        Arc::new(NoHeaders),
    );
    World { review, shadow, published, _service: service }
}

fn plain(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text)
}

fn content(spec: &Value) -> ReviewContent {
    match spec.get("text") {
        Some(text) => ReviewContent::bytes(text.as_str().unwrap().as_bytes().to_vec()),
        None => ReviewContent::Absent,
    }
}

fn file_paths(reply: &serde_json::Map<String, Value>) -> Value {
    Value::Array(reply["files"].as_array().unwrap().iter().map(|file| file["path"].clone()).collect())
}

#[tokio::test]
async fn the_core_tells_clients_to_reread_at_the_moments_node_signals() {
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
    let roots: HashMap<&str, PathBuf> = [("base", base.clone()), ("w1", base.join("w1")), ("w2", base.join("w2")), ("out", base.join("elsewhere"))].into();
    for root in ["w1", "w2", "out"] {
        std::fs::create_dir_all(&roots[root]).unwrap();
    }
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let world = world(&data);
    let review = &world.review;
    let at = |spec: &Value| match spec.get("path").and_then(Value::as_str) {
        Some(path) if !path.is_empty() => roots[spec["ws"].as_str().unwrap()].join(path),
        _ => roots[spec["ws"].as_str().unwrap()].clone(),
    };
    // `noteCommandToolSettled(cwd)` → `noteTurnWorktreeChange(cwd ? [cwd] : null)`, as `exec/settle.rs` does it.
    let settle = |spec: &Value| {
        if spec.get("cwd").is_some() {
            review.note_change(None);
        } else {
            review.note_change(Some(&[plain(&at(spec))]));
        }
    };
    // The paths Node's cache invalidation handed its listener, with the scenario's directories back in.
    let evidence = |result: &Value| {
        let paths: Vec<String> = result["delivered"]
            .as_array()
            .unwrap()
            .iter()
            .map(|path| {
                let mut text = path.as_str().unwrap().to_owned();
                for (token, root) in &roots {
                    text = text.replace(&format!("<{token}>"), &plain(root));
                }
                text
            })
            .collect();
        review.note_change(Some(&paths));
    };
    let mut tokens: HashMap<String, TurnToken> = HashMap::new();
    let mut revisions: HashMap<String, f64> = HashMap::new();
    let mut seen = 0;
    for (index, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
        let want = &scenario["results"][index];
        assert_eq!(want["op"], index);
        let session = op.get("session").and_then(Value::as_str).unwrap_or("");
        let checkpoint = op.get("checkpoint").and_then(Value::as_str).unwrap_or("");
        let ws_text = op.get("ws").and_then(Value::as_str).map(|ws| plain(&roots[ws])).unwrap_or_default();
        let at_label = format!("{name}: op {index} {op}");
        match op["op"].as_str().unwrap() {
            "git" => {
                let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(&roots[op["ws"].as_str().unwrap()]).status().unwrap();
                assert!(status.success());
            }
            "file" | "external" => {
                let target = at(op);
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(target, op["content"]["text"].as_str().unwrap()).unwrap();
            }
            "begin" => {
                let open = TurnOpen { checkpoint_id: checkpoint.to_owned(), continue_turn: false };
                let token = review.begin_turn(&ws_text, session, open).await;
                tokens.insert(session.to_owned(), token.expect("a turn"));
            }
            "complete" => {
                assert_eq!(review.complete_turn(session, tokens.get(session)).await, want["completed"], "{at_label}");
            }
            "settle" => settle(op),
            "evidence" => evidence(want),
            "burst" => {
                // One synchronous run: no await between the signals.
                for (part, recorded) in op["parts"].as_array().unwrap().iter().zip(want["parts"].as_array().unwrap()) {
                    if part["op"] == "settle" {
                        settle(part);
                    } else {
                        evidence(recorded);
                    }
                }
            }
            "edit" => {
                let target = at(op);
                let before = match std::fs::read(&target) {
                    Ok(bytes) => ReviewContent::bytes(bytes),
                    Err(_) => ReviewContent::Absent,
                };
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                let after = content(&op["content"]);
                match &after {
                    ReviewContent::Bytes(bytes) => std::fs::write(&target, bytes).unwrap(),
                    _ => {
                        let _ = std::fs::remove_file(&target);
                    }
                }
                let change = CallChange { path: plain(&target), new_path: None, before, after };
                review.record_tool_changes(session, &ws_text, vec![change]).await;
            }
            "review" => {
                let reply = review.turn_review_diff(&ws_text, session, ReviewRead::default()).await;
                assert_eq!(file_paths(&reply), want["files"], "{at_label}");
            }
            "sessionReview" => {
                let reply = review.session_review_diff(&ws_text, session).await;
                assert_eq!(file_paths(&reply), want["files"], "{at_label}");
            }
            "revert" => {
                let result = match op.get("file").and_then(Value::as_str) {
                    Some(file) => review.revert_turn_review_file(&ws_text, session, file, checkpoint).await,
                    None => review.revert_turn_review(&ws_text, session, checkpoint).await,
                };
                assert_eq!(result.is_ok(), want["ok"], "{at_label}");
            }
            "changes" => {
                let read = ChangesRead { checkpoint_id: checkpoint.to_owned(), patch: false, file: None };
                revisions.insert(checkpoint.to_owned(), review.turn_changes(session, read).await.unwrap()["revision"].as_f64().unwrap());
            }
            kind @ ("undo" | "redo") => {
                let file = op.get("file").and_then(Value::as_str);
                let revision = revisions[checkpoint];
                let result = if kind == "undo" {
                    review.revert_turn_changes(session, checkpoint, file, revision).await
                } else {
                    review.reapply_turn_changes(session, checkpoint, file, revision).await
                };
                assert_eq!(result.is_ok(), want["ok"], "{at_label}");
                if let Ok(reply) = result {
                    revisions.insert(checkpoint.to_owned(), reply["revision"].as_f64().unwrap());
                }
            }
            other => panic!("{at_label}: unknown op {other}"),
        }
        world.shadow.review_signal_delivered().await;
        // What the action published: per thread, one `reviewDiff` update per run of Node's listener, for each session
        // that had a turn open and for no other.
        let published = world.published.published();
        let mut told: BTreeMap<String, usize> = BTreeMap::new();
        for (section, key, change) in &published[seen..] {
            assert_eq!(*section, SectionName::ReviewDiff, "{at_label}");
            assert!(matches!(change, SectionChange::Set(_)), "{at_label}");
            *told.entry(key.clone().expect("a thread key")).or_default() += 1;
        }
        seen = published.len();
        let fires = want["fires"].as_u64().unwrap() as usize;
        let expected: BTreeMap<String, usize> = if fires == 0 {
            BTreeMap::new()
        } else {
            want["sessions"].as_array().unwrap().iter().map(|s| (s.as_str().unwrap().to_owned(), fires)).collect()
        };
        assert_eq!(told, expected, "{at_label}");
    }
}
