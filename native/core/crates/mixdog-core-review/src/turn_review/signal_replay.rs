//! The replay of Node's recording of when the core tells clients to read a review again (`fixtures/turn-review-signal`, from
//! `record-turn-review-signal.mjs` at `b6f10295a`), against a core: the one of this crate's tests (`signal_tests`), or the core as
//! the daemon composes it (`mixdog-app-server-daemon`, `compose::review_restart_tests`, which replays the scenarios in which a core
//! restarts). The core is a [`ReplayHost`]: its turn review, its app feed, its tools, and a restart over the same data directory.
//!
//! Node's `noteTurnReviewChanged` names no session: its desktop consumer forwards each delivery as the data-less
//! `turn-review-changed` event and every open window rereads the review of the session it shows. What equals Node's is
//! therefore what the windows do. The recording holds, per action, the deliveries Node made and, from real windows (the
//! product's `TurnReviewBar` behind the real service, main-process client, bridge and preload), every capability request they
//! then made: which window, after how many deliveries, the whole request, the whole answer, and what the bar showed after.
//!
//! The replay runs the same actions through the core's tools (`edit`, `apply_patch`, `git`), its turn review over real Git and its
//! scm service, which publishes through the core's own `StateRuntime`: one app-wide `reviewDiff` frame per tell. The core's answer
//! to each recorded request must be the recorded answer whole, and the core's app-feed frames, taken through the production
//! delivery path (`review-reread-replay.mjs`: the client library, main's protocol connection and section relay, each window's IPC
//! and preload, the renderer's section store and its `TurnReviewBar` panes), must make the windows ask and show exactly what the
//! recording holds, window by window and pane by pane, in Node's order.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::mock::FeedTap;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
use serde_json::Value;

use super::service::TurnReview;

/// A core the recording is replayed against.
#[async_trait]
pub trait ReplayHost: Send + Sync {
    /// The turn review of the core now running.
    fn review(&self) -> TurnReview;
    /// The app feed of the core now running.
    fn app_feed(&self) -> Arc<dyn ScopedFeed>;
    /// One call of the core's own tool `tool` (`edit`, `apply_patch`, `git`), in `cwd` for `session`, as the core wires it to the review.
    async fn call_tool(&self, tool: &str, cwd: &Path, session: &str, call: usize, input: Value) -> ToolOutcome;
    /// The running core stops and another starts over the same data directory: nothing the first held in memory carries over.
    async fn restart(&mut self);
    /// The running core is stopped, and the call returns once the stop has completed: the closing signal after which nothing more is published.
    /// A host whose core is not stopped by the replay leaves it as is.
    async fn finish(&mut self) {}
}

/// Every core a scenario ran against, oldest first (a restarted core is a new one: its own app feed, with an epoch of its own), each
/// with its app feed as a client that subscribed before anything happened sees it (the snapshot, then every frame), and the
/// deliveries the cores made.
struct Eras {
    /// Each with the feed position when it was tapped: a composed core has published before the test subscribes, and the tap sees only what follows.
    feeds: Vec<(Arc<dyn ScopedFeed>, FeedTap, u64)>,
    /// The running core's era and app feed, for the delivery recorder.
    current: Arc<Mutex<Option<(usize, Arc<dyn ScopedFeed>)>>>,
    /// One entry per delivery: the era of the core that made it, and that core's app feed position once the delivery's listeners had all run.
    deliveries: Arc<Mutex<Vec<(usize, u64)>>>,
    stop_recording: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl Eras {
    fn new() -> Self {
        Self { feeds: Vec::new(), current: Arc::default(), deliveries: Arc::default(), stop_recording: None }
    }

    /// The host's running core is a new era: its feed is tapped, and its deliveries are recorded.
    fn begin(&mut self, host: &dyn ReplayHost) {
        let era = self.feeds.len();
        let app = host.app_feed();
        let base = app.position().seq;
        let tap = FeedTap::attach(&app);
        *self.current.lock().unwrap() = Some((era, app.clone()));
        // A listener of the test's own, registered after the core's own: it runs in the same delivery, once the core has published.
        let (current, ends) = (self.current.clone(), self.deliveries.clone());
        self.stop_recording = Some(host.review().on_review_changed(Arc::new(move || {
            let (era, feed) = current.lock().unwrap().clone().expect("a core is running");
            ends.lock().unwrap().push((era, feed.position().seq));
        })));
        self.feeds.push((app, tap, base));
    }

    /// The running core is going away.
    fn end(&mut self) {
        if let Some(stop) = self.stop_recording.take() {
            stop();
        }
    }

    fn delivered(&self) -> usize {
        self.deliveries.lock().unwrap().len()
    }
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

pub async fn replay(scenario: &Value, host: &mut dyn ReplayHost) {
    let name = scenario["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let roots: HashMap<&str, PathBuf> = [("base", base.clone()), ("w1", base.join("w1")), ("w2", base.join("w2")), ("ng", base.join("plain"))].into();
    for root in ["w1", "w2", "ng"] {
        std::fs::create_dir_all(&roots[root]).unwrap();
    }
    let mut eras = Eras::new();
    eras.begin(host);
    let mut review = host.review();
    // The workspace each window pane's session works in.
    let mut panes: Vec<(String, String)> = Vec::new();
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
        let start = eras.delivered();
        let session = op.get("session").and_then(Value::as_str).unwrap_or("");
        let checkpoint = op.get("checkpoint").and_then(Value::as_str).unwrap_or("");
        let ws_text = op.get("ws").and_then(Value::as_str).map(|ws| plain(&roots[ws])).unwrap_or_default();
        let label = format!("{name}: op {index} {op}");
        let kind = op["op"].as_str().unwrap();
        // A core that restarts while the desktop's link to it is down: the one the operation runs against is a new process, composed again
        // over the data the first left. What the first held in memory (its turns, the tokens it handed out) is gone.
        if op["coreRestart"] == true {
            eras.end();
            host.restart().await;
            eras.begin(host);
            review = host.review();
            tokens.clear();
            revisions.clear();
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
            "client" => panes.push((session.to_owned(), op["ws"].as_str().unwrap().to_owned())),
            "begin" => {
                let open = TurnOpen { checkpoint_id: checkpoint.to_owned(), continue_turn: false };
                tokens.insert(session.to_owned(), review.begin_turn(&ws_text, session, open).await.expect("a turn"));
            }
            "complete" => assert_eq!(review.complete_turn(session, tokens.get(session)).await, want["completed"], "{label}"),
            "edit" | "patch" | "gitTool" => {
                calls += 1;
                let (tool, input) = match kind {
                    "edit" => ("edit", serde_json::json!({ "file_path": op["path"], "old_string": op["old"], "new_string": op["new"] })),
                    "patch" => ("apply_patch", serde_json::json!({ "patch": op["patch"] })),
                    _ => ("git", serde_json::json!({ "command": op["command"] })),
                };
                let outcome = host.call_tool(tool, &roots[op["ws"].as_str().unwrap()], session, calls, input).await;
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
        review.review_signal_settled().await;
        // A connection that dials in at the end of this operation (a reconnect of the desktop, an operation run while its link was
        // down, a phone that attaches or whose leg is back) is answered with the core's snapshot of the app feed as it is now
        // (the feed's own encoding), which the replay hands to that client.
        let dials = kind == "coreReconnect" || op["coreLinkDown"] == true || (kind == "client" && op["kind"] == "phone") || (kind == "phoneLink" && op["state"] == "up");
        if dials {
            let feed = host.app_feed();
            let tap = FeedTap::attach_as(&feed, 2 + index as u64);
            let seen = within("the app feed's snapshot for a new subscriber", tap.notifications_until(|seen| !seen.is_empty())).await;
            snapshots.insert(index, seen[0].clone());
        }
        let before = eras.delivered() - start;
        // The windows then read in the order they asked, and a read may raise the next delivery. The requests, and what Node
        // answered each, are the recording's; the core's own answer to each must be that answer whole.
        let mut after_answer = Vec::new();
        for request in want["requests"].as_array().unwrap() {
            let client = request["client"].as_str().unwrap();
            let ws = &panes.iter().find(|(session, _)| session == client).unwrap_or_else(|| panic!("{label}: no window shows {client}")).1;
            assert_eq!(request["request"]["capability"], "getTurnReviewDiff", "{label}");
            let options = &request["request"]["args"][0];
            let read = ReviewRead { known: options["known"].as_str().map(str::to_owned), summary: options["summary"] == true };
            let reply = review.turn_review_diff(&plain(&roots[ws.as_str()]), client, read).await;
            assert_eq!(Value::Object(reply), restore(&request["answer"], &roots), "{label}: the read of {client} after delivery {}", request["after"]);
            review.review_signal_settled().await;
            after_answer.push(eras.delivered() - start);
        }
        assert_eq!(eras.delivered() - start, want["deliveries"].as_u64().unwrap() as usize, "{label}: deliveries");
        made.push((start, before, after_answer));
    }

    // The last core ends before its feed is read, so what it published up to its stop is all there is to look at.
    eras.end();
    host.finish().await;
    // What the core published on the app feed, as a client that subscribed first received it: the snapshot, then the frames,
    // split into the deliveries by the feed position each delivery ended at.
    let mut frames_of_era: Vec<Vec<Value>> = Vec::new();
    let mut snapshot = Value::Null;
    // Each era's frames count from the position its tap's snapshot was taken at, which the snapshot carries: a composed core's boot
    // publications (the provider accounts) may still land between the position read at `begin` and the tap's attach, and those are in the snapshot.
    let mut snapshot_seqs: Vec<u64> = Vec::new();
    for (era, (app, tap, base)) in eras.feeds.iter().enumerate() {
        let first = within(&format!("the snapshot of the app feed of core {era}"), tap.notifications_until(|seen| !seen.is_empty())).await[0].clone();
        assert_eq!(first["method"], "app/snapshot");
        let at = first["feed"]["seq"].as_u64().unwrap_or_else(|| panic!("the app feed snapshot of core {era} carries its position: {first}"));
        assert!(at >= *base, "core {era}: the tap's snapshot at {at} precedes the position {base} read before it attached");
        let published = app.position().seq - at;
        let seen = within(&format!("the snapshot and {published} frames of the app feed of core {era} (snapshot at {at})"), tap.notifications_until(|seen| seen.len() as u64 > published)).await;
        if era == 0 {
            snapshot = first.clone();
        }
        frames_of_era.push(seen[1..].to_vec());
        snapshot_seqs.push(at);
    }
    let mut delivery_frames: Vec<Vec<Value>> = Vec::new();
    let mut from = vec![0usize; frames_of_era.len()];
    for (era, upto) in eras.deliveries.lock().unwrap().iter() {
        let upto = (*upto - snapshot_seqs[*era]) as usize;
        delivery_frames.push(frames_of_era[*era][from[*era]..upto].to_vec());
        from[*era] = upto;
    }
    // Past the last delivery of a core (up to its stop, for the last one the closing signal) no review tell is published: Node's last
    // delivery of the scenario is the recording's last, so a tell made after it is one Node did not make.
    for (era, frames) in frames_of_era.iter().enumerate() {
        let late: Vec<&Value> = frames[from[era]..].iter().filter(|frame| frame["method"] == "review/diff/updated").collect();
        assert!(late.is_empty(), "{name}: core {era} published {} review tell(s) after its last recorded delivery: {late:?}", late.len());
    }
    let rust: Vec<Value> = made
        .iter()
        .enumerate()
        .map(|(index, (start, before, after_answer))| {
            let end = after_answer.last().copied().unwrap_or(*before);
            serde_json::json!({ "before": before, "afterAnswer": after_answer, "deliveries": &delivery_frames[*start..*start + end], "snapshot": snapshots.get(&index) })
        })
        .collect();
    // A composed core also publishes sections that are not the subject (usage, tool modules) on the same feed: their frames take positions and
    // reach the clients (a client folds the feed in order), but what is counted and compared are the review tells.
    let frames_of = |index: usize| rust[index]["deliveries"].as_array().unwrap().iter().flat_map(|delivery| delivery.as_array().unwrap()).filter(|frame| frame["method"] == "review/diff/updated").count();
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
        // Several tells made while the link was down reach the desktop as the one tell of its snapshot, so its pane reads as in a burst.
        if bursts.contains(&index) && scenario["ops"][index]["coreLinkDown"] == true {
            continue;
        }
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
    mixdog_rt::time::timeout(DEADLINE, wait).await.unwrap_or_else(|_| panic!("{what} did not arrive within {DEADLINE:?}"))
}

/// The windows of this checkout (`review-reread-replay.mjs`) given the core's deliveries: what each window asked, when, and showed.
async fn windows_trace(scratch: &Path, input: &Value) -> Value {
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(300);
    // The checkout the running test belongs to, from the manifest directory cargo and nextest give the test process (this
    // crate's tests or mixdog-app-server-daemon's, both four levels below it). Read at run time, not with `env!`: a
    // compiled-in path made this library differ between checkouts, so rustc-slot's cache could not share it, nor
    // anything above it, and a library compiled elsewhere would have run that checkout's scripts.
    // A test binary started by hand has no such variable: then the checkout is the one it was started in.
    const REPLAY: &str = "benchmarks/rust-core/recorders/lib/review-reread-replay.mjs";
    let checkout = match std::env::var_os("CARGO_MANIFEST_DIR") {
        Some(manifest_dir) => Path::new(&manifest_dir).join("../../../..").canonicalize().unwrap(),
        None => {
            let here = std::env::current_dir().expect("a current directory");
            here.ancestors().find(|dir| dir.join(REPLAY).is_file()).map(Path::to_path_buf).unwrap_or_else(|| {
                panic!("CARGO_MANIFEST_DIR is not set (cargo and nextest set it) and {} is not inside a checkout: start the test binary from the checkout it was built from", here.display())
            })
        }
    };
    let checkout = PathBuf::from(plain(&checkout));
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
    let output = mixdog_rt::time::timeout(DEADLINE, child).await.unwrap_or_else(|_| panic!("the windows replay (review-reread-replay.mjs) did not finish within {DEADLINE:?}")).expect("node starts");
    assert!(output.status.success(), "the windows replay failed: {}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| panic!("the windows replay answered no trace ({error}): {}", String::from_utf8_lossy(&output.stdout)))
}
