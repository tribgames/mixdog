//! The thread transport as a client sees it, over the transport harness (	ests/wire.rs: the server behind its real WebSocket
//! listener, real client connections) and a real session thread: retried and conflicting op ids, attaching and detaching, a held
//! submission handed back, calls in flight while a stop is sent, the app feed's latest value, and which reads answer or fail.

use std::sync::Arc;

use mixdog_core_api::CallContext;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig as SessionRig;
use mixdog_core_session::session::testing::Script;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::Rig;
use super::wire::Wire;
use super::wire::WireClient;

/// Each run answers `re: <prompt>` and completes.
fn echo() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            let iid = ItemId::from(format!("a-{}", run.turn));
            let body = json!({ "text": format!("re: {text}") });
            run.port.commit_item(ItemCommit { iid, role: Some("assistant".into()), model: true, visible: true, body, prompt: None }).await.expect("commit");
            RunOutcome::Completed(Default::default())
        })
    })
}

/// A run that waits until it is stopped.
fn until_stopped() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    })
}

struct World {
    directory: Arc<SessionDirectory>,
    wire: Wire,
    session: SessionRig,
    id: ThreadId,
}

impl World {
    /// A server over one real session thread whose runs follow `script`.
    async fn started(script: Script) -> Self {
        Self::started_on(Rig::new(), script).await
    }

    /// [`World::started`] served by `rig`.
    async fn started_on(rig: Rig, script: Script) -> Self {
        let session = SessionRig::new();
        session.set_script(script);
        let directory = Arc::new(SessionDirectory::new(session.deps_configured()));
        let reply = directory
            .request(CoreRequest {
                method: Method("thread/start"),
                params: json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }),
                op: Some(OpId::from("op-start")),
                ctx: CallContext::internal("test"),
            })
            .await
            .expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        // The start's own publication arms the thread's frame timer; its frame goes out before any client attaches, so what a
        // client receives does not depend on how soon it attaches.
        let published = session.feeds.published.clone();
        let framed = || session.feeds.frames(id.as_str()).iter().any(|(_, method, _)| method == "thread/frame");
        mixdog_rt::time::timeout(std::time::Duration::from_secs(20), async {
            while !framed() {
                let woken = published.notified();
                if framed() {
                    break;
                }
                woken.await;
            }
        })
        .await
        .expect("the start's frame within 20 s");
        Self::serving(rig, session, directory, id).await
    }

    /// [`World::idle`] served by `rig`, each entry holding `pasted_texts` (its options' map) unless null.
    async fn idle_on(rig: Rig, queued: &[(&str, &str)], pasted_texts: Value) -> Self {
        let session = SessionRig::new();
        let id = ThreadId::from("sess_idle");
        let creator = SessionDirectory::new(session.deps_configured());
        creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().unwrap(), json!({})).await.expect("create");
        let entries = queued
            .iter()
            .map(|(qid, text)| {
                let mut record = json!({
                    "k": "queue", "qid": qid, "action": "enqueue",
                    "entry": { "inline": { "message": text, "enqueuedAt": 1, "priority": "next", "options": { "clientSubmissionId": qid } } },
                });
                if !pasted_texts.is_null() {
                    record["entry"]["inline"]["options"]["pastedTexts"] = pasted_texts.clone();
                }
                serde_json::from_value::<Record>(record).unwrap()
            })
            .collect();
        session.store.seed(&id, entries);
        Self::reopened_on(rig, session, id).await
    }

    /// The thread `id` of `session`'s store, opened by a directory of its own: what a restarted core serves.
    async fn reopened(session: SessionRig, id: ThreadId) -> Self {
        Self::reopened_on(Rig::new(), session, id).await
    }

    async fn reopened_on(rig: Rig, session: SessionRig, id: ThreadId) -> Self {
        let directory = Arc::new(SessionDirectory::new(session.deps_configured()));
        directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        Self::serving(rig, session, directory, id).await
    }

    async fn serving(rig: Rig, session: SessionRig, directory: Arc<SessionDirectory>, id: ThreadId) -> Self {
        rig.core.load(id.as_str(), directory.handle(&id).expect("loaded"));
        Self { directory, wire: Wire::serve(rig).await, session, id }
    }

    async fn client(&self, connection: u64) -> WireClient {
        self.wire.client(if connection == 1 { "PC" } else { "Phone" }, "desktop").await
    }

    async fn call(&self, client: &mut WireClient, id: i64, method: &str, params: Value) -> Value {
        let mut params = params;
        params["threadId"] = json!(self.id);
        client.call(id, method, params).await
    }

    async fn submit(&self, client: &mut WireClient, id: i64, op: &str, prompt: &str) -> Value {
        self.call(client, id, "turn/start", json!({ "opId": op, "input": { "prompt": prompt } })).await
    }
}

/// The thread's runs that have ended on a subscribed client: each run's end publishes the idle runtime once, after its
/// turn's end, and only then does the thread take the next prompt as a new turn rather than queue it.
fn runs_ended(frames: &[Value]) -> usize {
    frames.iter().filter(|frame| frame["method"] == "thread/runtime/updated" && frame["params"]["value"]["busy"] == false).count()
}

/// `runs` runs have ended: the last publication is the frame the last turn's end flushed (`settleTurn`'s `flushEmit`), which
/// carries the idle runtime, so nothing of the turn is still on its way.
fn ran(frames: &[Value], runs: usize) -> bool {
    let last = frames.iter().rev().find(|frame| frame.get("method").is_some());
    runs_ended(frames) == runs && last.is_some_and(|frame| frame["method"] == "thread/frame")
}

fn resume() -> Value {
    json!({ "window": { "lastItems": 10 } })
}

/// The kind and text of every row in a `thread/read` or snapshot answer's `items`.
fn rows(items: &Value) -> Vec<(String, String)> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            let text = item["text"].as_str().or_else(|| item["content"][0]["text"].as_str()).unwrap_or_default();
            (item["type"].as_str().unwrap().to_owned(), text.to_owned())
        })
        .collect()
}

fn user(text: &str) -> (String, String) {
    ("userMessage".to_owned(), text.to_owned())
}

fn agent(text: &str) -> (String, String) {
    ("agentMessage".to_owned(), text.to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retried_start_with_the_same_op_answers_the_same_and_runs_once() {
    let world = World::started(echo()).await;
    let mut client = world.client(1).await;
    world.call(&mut client, 1, "thread/resume", resume()).await;
    let first = world.submit(&mut client, 2, "stable-call-id", "hello").await;
    client.until("the run's end", |frames| ran(frames, 1)).await;
    let retry = world.submit(&mut client, 3, "stable-call-id", "hello").await;
    assert_eq!(first["result"], retry["result"], "the retry is answered what the first was");
    let read = world.call(&mut client, 4, "thread/read", json!({})).await;
    assert_eq!(rows(&read["result"]["items"]), [user("hello"), agent("re: hello")], "the prompt is held once and ran once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reused_op_with_another_payload_is_refused_and_changes_nothing() {
    let world = World::started(echo()).await;
    let mut client = world.client(1).await;
    world.call(&mut client, 1, "thread/resume", resume()).await;
    world.submit(&mut client, 2, "conflicting-call-id", "first").await;
    client.until("the run's end", |frames| ran(frames, 1)).await;
    let refused = world.submit(&mut client, 3, "conflicting-call-id", "second").await;
    assert_eq!(refused["error"]["data"], json!({ "reason": "opIdConflict", "opId": "conflicting-call-id" }));
    let read = world.call(&mut client, 4, "thread/read", json!({})).await;
    assert_eq!(rows(&read["result"]["items"]), [user("first"), agent("re: first")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsubscribing_never_interrupts_the_running_turn() {
    let release = Arc::new(tokio::sync::Notify::new());
    let held = release.clone();
    let world = World::started(Arc::new(move |run| {
        let held = held.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            held.notified().await;
            let commit = ItemCommit {
                iid: ItemId::from("answer"),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "text": "finished" }),
                prompt: None,
            };
            run.port.commit_item(commit).await.expect("commit");
            RunOutcome::Completed(Default::default())
        })
    }))
    .await;
    let mut terminal = world.client(1).await;
    let mut desktop = world.client(2).await;
    world.call(&mut terminal, 1, "thread/resume", resume()).await;
    world.submit(&mut terminal, 2, "durable-submit", "work").await;
    world.call(&mut desktop, 1, "thread/resume", resume()).await;
    assert_eq!(world.call(&mut desktop, 2, "thread/unsubscribe", json!({})).await["result"], json!({}));
    release.notify_one();
    terminal.until("the run's end", |frames| ran(frames, 1)).await;
    let read = world.call(&mut terminal, 3, "thread/read", json!({})).await;
    assert_eq!(rows(&read["result"]["items"]), [user("work"), agent("finished")], "the turn ended as it would have");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_thread_is_refused_and_nothing_is_created_for_it() {
    let session = SessionRig::new();
    let directory = Arc::new(SessionDirectory::new(session.deps_configured()));
    let rig = Rig::new();
    rig.core.serve_threads(directory.clone());
    let wire = Wire::serve(rig).await;
    let mut client = wire.client("PC", "desktop").await;
    let read = client.call(1, "thread/read", json!({ "threadId": "sess_missing" })).await;
    let resume = client.call(2, "thread/resume", json!({ "threadId": "sess_missing_too", "window": { "lastItems": 10 } })).await;
    assert_eq!(read["error"]["message"], "threadNotFound");
    assert_eq!(read["error"]["data"], json!({ "reason": "threadNotFound", "threadId": "sess_missing" }));
    assert_eq!(resume["error"]["data"]["reason"], "threadNotFound");
    for missing in ["sess_missing", "sess_missing_too"] {
        let id = ThreadId::from(missing);
        assert!(directory.handle(&id).is_none(), "{missing}: no thread was loaded");
        assert!(session.store.records(&id).is_empty(), "{missing}: nothing was written");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_attached_client_folds_the_same_items_whichever_of_them_submitted() {
    let release = Arc::new(tokio::sync::Notify::new());
    let held = release.clone();
    let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let echoed = echo();
    let world = World::started(Arc::new(move |run| {
        let (held, first) = (held.clone(), runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0);
        let echoed = echoed.clone();
        Box::pin(async move {
            if first {
                held.notified().await;
            }
            echoed(run).await
        })
    }))
    .await;
    let mut terminal = world.client(1).await;
    let mut desktop = world.client(2).await;
    world.call(&mut terminal, 1, "thread/resume", resume()).await;
    world.call(&mut desktop, 1, "thread/resume", resume()).await;
    world.submit(&mut terminal, 2, "op-0", "from terminal").await;
    let queued = world.submit(&mut desktop, 2, "op-1", "from desktop").await;
    assert_eq!(queued["result"]["kind"], "queued", "the thread runs one turn at a time: the second prompt waits");
    release.notify_one();
    terminal.until("both runs' ends", |frames| ran(frames, 2)).await;
    desktop.until("both runs' ends", |frames| ran(frames, 2)).await;
    let want = [user("from terminal"), agent("re: from terminal"), user("from desktop"), agent("re: from desktop")];
    for client in [&mut terminal, &mut desktop] {
        let read = world.call(client, 9, "thread/read", json!({})).await;
        assert_eq!(rows(&read["result"]["items"]), want);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unsubscribed_client_receives_nothing_more() {
    let world = World::started(echo()).await;
    let mut pane = world.client(1).await;
    let mut other = world.client(2).await;
    world.call(&mut pane, 1, "thread/resume", resume()).await;
    world.submit(&mut pane, 2, "op-brief", "brief").await;
    pane.until("the run's end", |frames| ran(frames, 1)).await;
    world.call(&mut pane, 4, "thread/unsubscribe", json!({})).await;
    let seen = pane.frames.len();
    world.call(&mut other, 1, "thread/resume", resume()).await;
    world.submit(&mut other, 2, "op-after", "after").await;
    other.until("the run's end", |frames| ran(frames, 1)).await;
    // The pane's next answer comes after everything published to it so far.
    let read = world.call(&mut pane, 5, "thread/read", json!({})).await;
    assert_eq!(pane.frames.len(), seen + 1, "only the read's answer reached the pane: {:?}", &pane.frames[seen..]);
    assert_eq!(rows(&read["result"]["items"]), [user("brief"), agent("re: brief"), user("after"), agent("re: after")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_submission_keeps_its_id_across_a_restart() {
    let world = World::started(until_stopped()).await;
    let mut client = world.client(1).await;
    world.submit(&mut client, 1, "op-run", "running").await;
    let params = json!({ "opId": "op-steer", "input": { "prompt": "steer me", "options": { "clientSubmissionId": "sub-9" } } });
    let queued = world.call(&mut client, 2, "turn/start", params).await;
    assert_eq!(queued["result"]["kind"], "queued");
    let kept: Vec<Value> = world
        .session
        .store
        .records(&world.id)
        .into_iter()
        .map(|(_, record)| serde_json::to_value(record).unwrap())
        .filter(|record| record["k"] == "queue" && record["action"] == "enqueue")
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(kept[0]["entry"]["inline"]["message"], "steer me");
    assert_eq!(kept[0]["entry"]["inline"]["options"]["clientSubmissionId"], "sub-9");

    let World { directory, session, id, .. } = world;
    drop(directory);
    let restarted = World::reopened(session, id).await;
    let mut client = restarted.client(1).await;
    let stop = restarted.call(&mut client, 1, "turn/interrupt", json!({ "restorePrompt": true, "submissionId": "sub-9" })).await;
    assert_eq!(stop["result"]["restoreText"], "steer me");
    assert_eq!(stop["result"]["restoredSubmissionIds"], json!(["sub-9"]));
    let again = restarted.call(&mut client, 2, "turn/interrupt", json!({ "submissionId": "sub-9" })).await;
    assert_eq!(again["result"]["restoreText"], "", "the submission is gone once handed back");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_is_answered_ahead_of_sixty_four_reads_in_flight_and_every_read_is_answered() {
    let reads = 64;
    let rig = Rig::routed(super::domain_methods(), vec![("config", &["config/read"])]);
    let gate = Arc::clone(rig.gate("config"));
    gate.answers.lock().unwrap().extend((0..reads).map(|n| json!({ "n": n })));
    let world = World::idle_on(rig, &[("sub1", "queued text")], Value::Null).await;
    let mut client = world.client(1).await;
    let mut started = gate.started.subscribe();
    for n in 0..reads {
        client.send(100 + n, "config/read", json!({})).await;
    }
    mixdog_rt::time::timeout(std::time::Duration::from_secs(20), started.wait_for(|count| *count as i64 == reads))
        .await
        .expect("every read to start within 20 s")
        .expect("the gate outlives the test");
    client.send(1, "turn/interrupt", json!({ "threadId": world.id, "submissionId": "sub1" })).await;
    let stop = client.answer(1).await;
    assert_eq!(stop["result"]["restoreText"], "queued text");
    assert_eq!(client.frames.len(), 1, "the stop is answered while every read is still held");
    for released in 0..reads {
        gate.permits.add_permits(1);
        client.until("the released call's answer", |frames| frames.len() as i64 == released + 2).await;
    }
    let results: Vec<Value> = client.frames[1..].iter().map(|frame| frame["result"].clone()).collect();
    assert_eq!(results, (0..reads).map(|n| json!({ "n": n })).collect::<Vec<_>>(), "no read was refused and each got its own answer");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_op_from_another_connection_is_refused_and_the_prompt_runs_once() {
    let world = World::started(echo()).await;
    let (mut first, mut second) = (world.client(1).await, world.client(2).await);
    world.call(&mut first, 1, "thread/resume", resume()).await;
    let answered = world.submit(&mut first, 2, "same-local-id", "once").await;
    assert_eq!(answered["result"]["kind"], "started", "{answered}");
    first.until("the run's end", |frames| ran(frames, 1)).await;
    // A replay is answered to the audience that began the op: another connection is not that audience.
    let again = world.submit(&mut second, 1, "same-local-id", "once").await;
    assert_eq!(again["error"]["data"]["reason"], "opIdConflict", "{again}");
    let read = world.call(&mut first, 3, "thread/read", json!({})).await;
    assert_eq!(rows(&read["result"]["items"]), [user("once"), agent("re: once")], "the prompt is stored and run once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_state_churn_with_no_reader_leaves_only_the_latest() {
    let rig = Rig::new();
    let state = mixdog_core_base::state::SectionFeedState::new(rig.core.mock.app().clone());
    for n in 0..1000 {
        mixdog_core_domains::domains::host::publish_remote_session(&state, true, Some(&format!("state-{n}")), None);
    }
    let wire = Wire::serve(rig).await;
    let mut client = wire.client("PC", "desktop").await;
    client.send(1, "app/subscribe", json!({})).await;
    client.until("the app snapshot", |frames| frames.iter().any(|frame| frame["method"] == "app/snapshot")).await;
    let snapshots: Vec<&Value> = client.frames.iter().filter(|frame| frame["method"] == "app/snapshot").collect();
    assert_eq!(snapshots.len(), 1);
    let sections = snapshots[0]["params"]["sections"].as_array().unwrap();
    let remote: Vec<&Value> = sections.iter().filter(|section| section["section"] == "hostState" && section["key"] == "remoteSession").collect();
    assert_eq!(remote.len(), 1, "one value per section, not the backlog");
    assert_eq!(remote[0]["value"], json!({ "enabled": true, "sessionId": "state-999", "cwd": null }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_attaching_after_a_large_state_receives_it_once() {
    let large = "x".repeat(160 * 1024);
    let world = World::started(echo()).await;
    let mut watcher = world.client(1).await;
    world.call(&mut watcher, 1, "thread/resume", resume()).await;
    world.submit(&mut watcher, 2, "op-large", &large).await;
    watcher.until("the run's end", |frames| ran(frames, 1)).await;
    let mut late = world.client(2).await;
    world.call(&mut late, 1, "thread/resume", resume()).await;
    late.until("the snapshot", |frames| frames.iter().any(|frame| frame["method"] == "thread/snapshot")).await;
    assert_eq!(late.frames.len(), 2, "the answer and one snapshot: {}", late.frames.len());
    let snapshot = late.frames.iter().find(|frame| frame["method"] == "thread/snapshot").unwrap();
    assert_eq!(rows(&snapshot["params"]["items"]), [user(&large), agent(&format!("re: {large}"))]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_result_on_a_long_transcript_sends_only_the_changed_item() {
    let earlier = 300;
    let (ready, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let (committed, held) = (ready.clone(), release.clone());
    let session = SessionRig::new();
    session.set_script(Arc::new(move |run| {
        let (committed, held) = (committed.clone(), held.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "call-1", "name": "read", "arguments": {} }] });
            run.port
                .commit_item(ItemCommit { iid: ItemId::from("call-row"), role: Some("assistant".into()), model: true, visible: true, body: call, prompt: None })
                .await
                .expect("commit the call");
            committed.notify_one();
            held.notified().await;
            let result = json!({ "toolCallId": "call-1", "text": "the tool output" });
            run.port
                .commit_item(ItemCommit { iid: ItemId::from("result-row"), role: Some("tool".into()), model: true, visible: true, body: result, prompt: None })
                .await
                .expect("commit the result");
            RunOutcome::Completed(Default::default())
        })
    }));
    let id = ThreadId::from("sess_long");
    let creator = SessionDirectory::new(session.deps_configured());
    creator
        .create_with_id(id.clone(), json!({ "cwd": "/ws", "orchestrationMode": "balanced" }).as_object().cloned().unwrap(), json!({}))
        .await
        .expect("create");
    let rows_before = (0..earlier)
        .map(|n| serde_json::from_value::<Record>(json!({ "k": "item", "iid": format!("row-{n}"), "role": "assistant", "form": "message", "model": true, "visible": true, "refs": [], "body": { "inline": { "text": format!("row-{n}") } } })).unwrap())
        .collect();
    session.store.seed(&id, rows_before);
    let world = World::reopened_on(Rig::new(), session, id).await;
    let mut client = world.client(1).await;
    world.submit(&mut client, 1, "op-long", "go").await;
    mixdog_rt::time::timeout(std::time::Duration::from_secs(20), ready.notified()).await.expect("the run to commit the tool call within 20 s");
    // The call's row and the frame its step flushes are published after the commit returns; the attach follows both.
    let published = world.session.feeds.published.clone();
    let shown = || {
        let frames = world.session.feeds.frames(world.id.as_str());
        let row = frames.iter().position(|(_, _, value)| value.to_string().contains("call:call-1"));
        row.is_some_and(|row| frames[row..].iter().any(|(_, method, _)| method == "thread/frame"))
    };
    mixdog_rt::time::timeout(std::time::Duration::from_secs(20), async {
        while !shown() {
            let woken = published.notified();
            if shown() {
                break;
            }
            woken.await;
        }
    })
    .await
    .expect("the call's row published within 20 s");
    let attached = world.call(&mut client, 2, "thread/resume", resume()).await;
    assert_eq!(attached["result"]["thread"]["id"], json!(world.id));
    release.notify_one();
    client.until("the run's end", |frames| ran(frames, 1)).await;
    let snapshots: Vec<&Value> = client.frames.iter().filter(|frame| frame["method"] == "thread/snapshot").collect();
    assert_eq!(snapshots.len(), 1, "the transcript came once, at the attach");
    assert_eq!(snapshots[0]["params"]["hasOlder"], true, "the window holds the last rows, not the whole transcript");
    let attach_at = client.frames.iter().position(|frame| frame["method"] == "thread/snapshot").unwrap();
    let after = &client.frames[attach_at + 1..];
    let completed: Vec<&Value> = after.iter().filter(|frame| frame["method"] == "item/completed").map(|frame| &frame["params"]["item"]).collect();
    let tool: Vec<_> = completed.iter().filter(|item| item["type"] == "toolCall").collect();
    assert_eq!(tool.len(), 1, "the tool result arrives as the one changed card");
    assert_eq!(tool[0]["run"]["result"], "the tool output");
    assert!(!after.iter().any(|frame| frame.to_string().contains("row-0")), "no earlier row is sent again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_thread_catalog_never_rides_a_thread_answer() {
    let world = World::started(echo()).await;
    let mut client = world.client(1).await;
    let read = world.call(&mut client, 1, "thread/read", json!({})).await;
    let renamed = world.call(&mut client, 2, "thread/name/set", json!({ "opId": "op-rename", "title": "renamed" })).await;
    for (call, reply) in [("thread/read", &read), ("thread/name/set", &renamed)] {
        assert!(reply["result"].is_object(), "{call} answered: {reply}");
        let text = reply["result"].to_string();
        assert!(!text.contains("\"sessions\"") && !text.contains("\"threads\""), "{call} carries no catalog: {text}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_read_an_unserved_read_and_a_read_of_plain_data_answer_as_an_error_or_the_data() {
    let rig = Rig::routed(&["config/getProfile", "config/getTheme"], Vec::new());
    rig.core.mock.mock_domain().set_handler(Arc::new(|req| match req.method.as_str() {
        "config/getProfile" => Err(mixdog_core_api::CoreError::Internal { incident_id: "stub".into() }),
        _ => Ok(Reply::Value(json!({ "ok": true, "when": "1970-01-01T00:00:00.000Z" }))),
    }));
    let wire = Wire::serve(rig).await;
    let mut client = wire.client("PC", "desktop").await;
    let failed = client.call(1, "config/getProfile", json!({})).await;
    assert!(failed["error"].is_object(), "a failing read answers as an error: {failed}");
    assert!(!failed.to_string().contains("stub failure"));
    let unserved = client.call(2, "config/getOutputStyle", json!({})).await;
    assert!(unserved["error"].is_object(), "a read nobody serves is refused: {unserved}");
    let theme = client.call(3, "config/getTheme", json!({})).await;
    assert_eq!(theme["result"], json!({ "ok": true, "when": "1970-01-01T00:00:00.000Z" }));
}
