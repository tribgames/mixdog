//! When the core tells clients to read a review again, and what they read then, against Node's recording of the same
//! actions (`fixtures/turn-review-signal`, from `record-turn-review-signal.mjs` at `b6f10295a`).
//!
//! Node's `noteTurnReviewChanged` names no session: its desktop consumer forwards each delivery as the data-less
//! `turn-review-changed` event and every open window rereads the review of the session it shows. What equals Node's is
//! therefore what the windows do. The recording holds, per action, the deliveries Node made and, from real windows (the
//! product's `TurnReviewBar` behind the real service, main-process client, bridge and preload), every capability request they
//! then made: which window, after how many deliveries, the whole request, the whole answer, and what the bar showed after.
//!
//! The replay runs the same actions through the real tools (`edit`, `apply_patch`, `git`), the real turn review over real Git
//! and the real scm service, which publishes through the core's own `StateRuntime`: one app-wide `reviewDiff` frame per tell. The
//! core's answer to each recorded request must be the recorded answer whole, and the core's app-feed frames, taken through the
//! production delivery path (`review-reread-replay.mjs`: the client library, main's protocol connection and section relay, each
//! window's IPC and preload, the renderer's section store and its `TurnReviewBar` panes), must make the windows ask and show
//! exactly what the recording holds, window by window and pane by pane, in Node's order. `listeners.json` records the listener
//! registry (subscribe, unsubscribe, removal and addition during a delivery).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and a real git")]

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
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
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::mock::FeedTap;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
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
    scm: Arc<mixdog_scm::engine::Scm>,
    /// Every core this scenario ran against, oldest first (a restarted core is a new one: its own app feed, with an epoch of its own),
    /// each with the app feed as a client that subscribed before anything happened sees it: the snapshot, then every frame.
    eras: Vec<(Arc<MockFeed>, FeedTap)>,
    /// The running core's era and app feed, for the delivery recorder.
    current: Arc<Mutex<(usize, Arc<MockFeed>)>>,
    /// One entry per delivery: the era of the core that made it, and that core's app feed position once the delivery's listeners
    /// had all run.
    deliveries: Arc<Mutex<Vec<(usize, u64)>>>,
    /// The workspace each window pane's session works in.
    panes: Vec<(String, String)>,
    state: Arc<ReadState>,
    processes: Arc<mixdog_spawn::LocalProcessManager>,
    // The running core's scm service (and so its listener) and the delivery recorder's registration.
    service: Option<Arc<ScmService>>,
    stop_recording: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl World {
    fn delivered(&self) -> usize {
        self.deliveries.lock().unwrap().len()
    }

    /// The running core's app feed.
    fn app(&self) -> &Arc<MockFeed> {
        &self.eras.last().expect("a core is running").0
    }

    /// Starts a core: the first one, or a restarted one when another ran before (that one is gone with its listener, and the new
    /// one numbers its feed from the start under an epoch of its own).
    fn start_core(&mut self) {
        if let Some(stop) = self.stop_recording.take() {
            stop();
        }
        self.service = None;
        let era = self.eras.len();
        let (id, at) = (FeedId::from("app"), epoch(1 + era as u128));
        let app = Arc::new(MockFeed::new(id.clone(), at.clone(), empty_view(&id, &at), MockLimits::default()));
        let runtime = StateRuntime::new(app.clone());
        self.service = Some(ScmService::new(self.scm.clone(), Arc::new(MockScopedFeeds::new(MockLimits::default())), runtime.publisher.clone(), Arc::new(Open), Arc::new(self.review.clone()), Arc::new(NoHeaders)));
        let scoped: Arc<dyn ScopedFeed> = app.clone();
        let tap = FeedTap::attach(&scoped);
        *self.current.lock().unwrap() = (era, app.clone());
        // A listener of the test's own, registered after the service's: it runs in the same delivery, once the service has published.
        let (current, ends) = (self.current.clone(), self.deliveries.clone());
        self.stop_recording = Some(self.shadow.on_review_changed(Arc::new(move || {
            let (era, feed) = current.lock().unwrap().clone();
            ends.lock().unwrap().push((era, feed.position().seq));
        })));
        self.eras.push((app, tap));
    }
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
    let (id, at) = (FeedId::from("app"), epoch(0));
    let placeholder = Arc::new(MockFeed::new(id.clone(), at.clone(), empty_view(&id, &at), MockLimits::default()));
    let mut world = World {
        review,
        shadow,
        scm,
        eras: Vec::new(),
        current: Arc::new(Mutex::new((0, placeholder))),
        deliveries: Arc::default(),
        panes: Vec::new(),
        state,
        processes,
        service: None,
        stop_recording: None,
    };
    world.start_core();
    world
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
    let mut world = world(&data);
    let review = world.review.clone();
    let at = |spec: &Value| match spec.get("path").and_then(Value::as_str) {
        Some(path) => roots[spec["ws"].as_str().unwrap()].join(path),
        None => roots[spec["ws"].as_str().unwrap()].clone(),
    };
    let mut tokens: HashMap<String, TurnToken> = HashMap::new();
    let mut revisions: HashMap<String, f64> = HashMap::new();
    let mut calls = 0;
    // Per operation, what the core did that a window can observe: how many deliveries it had made when the operation's own action
    // ended and after each answered request, and (below) the frames of each.
    let mut made: Vec<(usize, usize, Vec<usize>)> = Vec::new();
    // The core's snapshot of the app feed as a connection that dials in at the end of an operation receives it.
    let mut snapshots: HashMap<usize, Value> = HashMap::new();
    for (index, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
        let want = &scenario["results"][index];
        assert_eq!(want["op"], index);
        let start = world.delivered();
        let session = op.get("session").and_then(Value::as_str).unwrap_or("");
        let checkpoint = op.get("checkpoint").and_then(Value::as_str).unwrap_or("");
        let ws_text = op.get("ws").and_then(Value::as_str).map(|ws| plain(&roots[ws])).unwrap_or_default();
        let label = format!("{name}: op {index} {op}");
        let kind = op["op"].as_str().unwrap();
        // A core that restarts while the desktop's link to it is down: the one the operation runs against is a new process.
        if op["coreRestart"] == true {
            world.start_core();
        }
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
            "client" => world.panes.push((session.to_owned(), op["ws"].as_str().unwrap().to_owned())),
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
            // Node has no link to the core to lose, and a phone page's leg is the relay's. Here a connection drops and dials again
            // (below), and nothing happens in the core itself.
            "coreReconnect" | "phoneLink" => {}
            other => panic!("{label}: unknown op {other}"),
        }
        world.shadow.review_signal_settled().await;
        // A connection that dials in at the end of this operation (a reconnect of the desktop, an operation run while its link was
        // down, a phone that attaches or whose leg is back) is answered with the core's snapshot of the app feed as it is now
        // (the feed's own encoding), which the replay hands to that client.
        let dials = kind == "coreReconnect" || op["coreLinkDown"] == true || (kind == "client" && op["kind"] == "phone") || (kind == "phoneLink" && op["state"] == "up");
        if dials {
            let feed: Arc<dyn ScopedFeed> = world.app().clone();
            let tap = FeedTap::attach_as(&feed, 2 + index as u64);
            let seen = within("the app feed's snapshot for a new subscriber", tap.notifications_until(|seen| !seen.is_empty())).await;
            snapshots.insert(index, seen[0].clone());
        }
        let before = world.delivered() - start;
        // The windows then read in the order they asked, and a read may raise the next delivery. The requests, and what Node
        // answered each, are the recording's; the core's own answer to each must be that answer whole.
        let mut after_answer = Vec::new();
        for request in want["requests"].as_array().unwrap() {
            let client = request["client"].as_str().unwrap();
            let ws = &world.panes.iter().find(|(session, _)| session == client).unwrap_or_else(|| panic!("{label}: no window shows {client}")).1;
            assert_eq!(request["request"]["capability"], "getTurnReviewDiff", "{label}");
            let options = &request["request"]["args"][0];
            let read = ReviewRead { known: options["known"].as_str().map(str::to_owned), summary: options["summary"] == true };
            let reply = review.turn_review_diff(&plain(&roots[ws.as_str()]), client, read).await;
            assert_eq!(Value::Object(reply), restore(&request["answer"], &roots), "{label}: the read of {client} after delivery {}", request["after"]);
            world.shadow.review_signal_settled().await;
            after_answer.push(world.delivered() - start);
        }
        assert_eq!(world.delivered() - start, want["deliveries"].as_u64().unwrap() as usize, "{label}: deliveries");
        made.push((start, before, after_answer));
    }

    // What the core published on the app feed, as a client that subscribed first received it: the snapshot, then the frames,
    // split into the deliveries by the feed position each delivery ended at.
    let mut frames_of_era: Vec<Vec<Value>> = Vec::new();
    let mut snapshot = Value::Null;
    for (era, (app, tap)) in world.eras.iter().enumerate() {
        let published = app.position().seq;
        let seen = within(&format!("the snapshot and {published} frames of the app feed of core {era}"), tap.notifications_until(|seen| seen.len() as u64 > published)).await;
        let (first, frames) = seen.split_first().expect("the feed's snapshot comes first");
        assert_eq!(first["method"], "app/snapshot");
        assert!(frames.iter().all(|frame| frame["method"] == "review/diff/updated"), "{name}: the app feed carried something but the tell");
        if era == 0 {
            snapshot = first.clone();
        }
        frames_of_era.push(frames.to_vec());
    }
    let mut delivery_frames: Vec<Vec<Value>> = Vec::new();
    let mut from = vec![0usize; frames_of_era.len()];
    for (era, upto) in world.deliveries.lock().unwrap().iter() {
        delivery_frames.push(frames_of_era[*era][from[*era]..*upto as usize].to_vec());
        from[*era] = *upto as usize;
    }    let rust: Vec<Value> = made
        .iter()
        .enumerate()
        .map(|(index, (start, before, after_answer))| {
            let end = after_answer.last().copied().unwrap_or(*before);
            serde_json::json!({ "before": before, "afterAnswer": after_answer, "deliveries": &delivery_frames[*start..*start + end], "snapshot": snapshots.get(&index) })
        })
        .collect();
    let frames_of = |index: usize| rust[index]["deliveries"].as_array().unwrap().iter().map(|delivery| delivery.as_array().unwrap().len()).sum::<usize>();
    // The relay's pushes that carry a tell: one per frame, except in an operation run while the desktop's connection was down, where
    // the tells made meanwhile reach the windows as the one tell of the connection's snapshot (a whole-store replace), not as a push.
    let pushes_of = |index: usize| if scenario["ops"][index]["coreLinkDown"] == true { 0 } else { frames_of(index) };
    let ops = scenario["ops"].as_array().unwrap().len();
    // The operations in which Node made several deliveries. The rule for them is stated at the check below.
    let bursts: Vec<usize> = (0..ops).filter(|index| scenario["results"][*index]["deliveries"].as_u64().unwrap() > 1).collect();
    let input = |bursts: &[usize]| serde_json::json!({ "ops": scenario["ops"], "recorded": scenario["results"], "snapshot": snapshot, "rust": rust, "bursts": bursts });
    let whole = |index: usize, trace: &Value| {
        let want = &scenario["results"][index];
        assert_eq!(trace["pushes"], pushes_of(index), "{name}: op {index}: pushes of the relay");
        let expected = serde_json::json!({ "op": index, "deliveries": want["deliveries"], "requests": want["requests"], "shows": want["shows"], "pushes": pushes_of(index) });
        assert_eq!(*trace, expected, "{name}: op {index} {}: what the windows asked and showed", scenario["ops"][index]);
    };

    // Tells that arrive apart: exactly Node's trace, and one push of the relay per tell.
    let apart = windows_trace(&base, &input(&[])).await;
    let apart = apart["traces"].as_array().expect("the replay answers a trace per operation");
    assert_eq!(apart.len(), ops, "{name}: a trace per operation");
    for (index, trace) in apart.iter().enumerate() {
        whole(index, trace);
    }

    // Tells that arrive together (the operations in which Node made several): the relay hands tells that reach it together to the
    // windows as one push, so a pane may read fewer times than in Node, and nothing else may differ. The rule, stated once. For every
    // pane that Node read in the operation, the pane's reads are an ordered subsequence of Node's (each of Node's matched at most once,
    // each whole: the request, the answer, and what the pane rendered while waiting for it and after it); its last read is made after
    // the burst's last tell reached it; every state of Node's that a skipped read had (rendered while waiting, rendered after the
    // answer) is a state the pane still renders in the replay, or one it rendered before the operation or ends with; and the panes
    // end as Node's do.
    let together = windows_trace(&base, &input(&bursts)).await;
    let (traces, told) = (together["traces"].as_array().expect("a trace per operation"), together["told"].as_array().expect("the told counts per operation"));
    assert_eq!(traces.len(), ops, "{name}: a trace per operation");
    let mut coalesced = false;
    for (index, trace) in traces.iter().enumerate() {
        if !bursts.contains(&index) {
            // Not a burst, but the state it starts from is the one the bursts before it left: the panes must agree with Node's.
            whole(index, trace);
            continue;
        }
        let want = &scenario["results"][index];
        let label = format!("{name}: burst op {index} {}", scenario["ops"][index]);
        assert_eq!(trace["deliveries"], want["deliveries"], "{label}: deliveries");
        assert_eq!(trace["shows"], want["shows"], "{label}: what the panes render after the burst is what they render in Node after its last read");
        let before = if index == 0 { Value::Null } else { scenario["results"][index - 1]["shows"].clone() };
        let panes: std::collections::BTreeSet<&str> = want["requests"].as_array().unwrap().iter().map(|read| read["client"].as_str().unwrap()).collect();
        for pane in panes {
            let reads_of = |reads: &Value| reads.as_array().unwrap().iter().enumerate().filter(|(_, read)| read["client"] == pane).map(|(at, read)| (at, read.clone())).collect::<Vec<_>>();
            let (node, mine) = (reads_of(&want["requests"]), reads_of(&trace["requests"]));
            assert!(!mine.is_empty(), "{label}: {pane} read nothing after the burst, and Node's pane did");
            let mut kept = vec![false; node.len()];
            let mut next = 0;
            for (_, read) in &mine {
                let at = node[next..].iter().position(|(_, made)| without_after(made) == without_after(read)).unwrap_or_else(|| panic!("{label}: {pane} made a read that is no later read of Node's than the one before it: {read}"));
                kept[next + at] = true;
                next += at + 1;
            }
            let last = mine.last().unwrap().0;
            assert_eq!(told[index][last], frames_of(index), "{label}: the last read of {pane} was made before the burst's last tell reached it");
            let mut rendered = vec![before[pane].clone(), trace["shows"][pane].clone()];
            rendered.extend(mine.iter().flat_map(|(_, read)| [read["waiting"].clone(), read["shown"].clone()]));
            for ((_, read), kept) in node.iter().zip(&kept) {
                for state in [&read["waiting"], &read["shown"]] {
                    assert!(*kept || rendered.contains(state), "{label}: Node's pane {pane} rendered a state in a read the replay skipped that the replay's never renders: {state}");
                }
            }
        }
        coalesced |= trace["pushes"].as_u64().unwrap() < frames_of(index) as u64;
    }
    assert!(bursts.is_empty() || coalesced, "{name}: no burst reached the windows as fewer pushes than frames, so the relay's coalescing was not exercised");
}

/// A read without the count of tells made before it: a read that comes later (the relay handed it the tells together) is stamped
/// with a later count than the Node read it matches.
fn without_after(read: &Value) -> Value {
    let mut read = read.clone();
    read.as_object_mut().unwrap().remove("after");
    read
}
/// A wait for the core's frames that fails by name at its deadline instead of hanging.
async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
    tokio::time::timeout(DEADLINE, wait).await.unwrap_or_else(|_| panic!("{what} did not arrive within {DEADLINE:?}"))
}

/// The windows of this checkout (`review-reread-replay.mjs`) given the core's deliveries: what each window asked, when, and showed.
async fn windows_trace(scratch: &Path, input: &Value) -> Value {
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(300);
    let checkout = PathBuf::from(plain(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().unwrap()));
    let file_url = |path: PathBuf| format!("{}{}", if cfg!(windows) { "file:///" } else { "file://" }, plain(&path).replace('\\', "/"));
    let input_path = scratch.join("review-reread-input.json");
    std::fs::write(&input_path, serde_json::to_vec(input).unwrap()).unwrap();
    let child = tokio::process::Command::new("node")
        .arg("--import")
        .arg(file_url(checkout.join("apps/desktop/scripts/test-env.mjs")))
        .arg("--import")
        .arg(file_url(checkout.join("apps/desktop/scripts/test-tsx.mjs")))
        .arg(checkout.join("benchmarks/rust-core/recorders/lib/review-reread-replay.mjs"))
        .arg(&checkout)
        .arg(&input_path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(DEADLINE, child).await.unwrap_or_else(|_| panic!("the windows replay (review-reread-replay.mjs) did not finish within {DEADLINE:?}")).expect("node starts");
    assert!(output.status.success(), "the windows replay failed: {}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| panic!("the windows replay answered no trace ({error}): {}", String::from_utf8_lossy(&output.stdout)))
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
