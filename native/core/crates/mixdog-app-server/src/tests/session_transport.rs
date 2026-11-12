//! The Node session transport's client-visible contracts, replayed over the transport harness (`tests/wire.rs`: the
//! server behind its real WebSocket listener, real client connections) over a real session thread:
//! `fixtures/session-transport-call-contract`, `session-transport-state-lanes` and `session-transport-steering-recovery`
//! (recorded by `benchmarks/rust-core/recorders/record-session-transport-*.mjs`). Each test compares every frame each
//! client received, whole and in order, against the frames Node's recorded outcome gives in the core's protocol; the only
//! normalization is the one the manifests declare (`wire::normalized`: generated ids and clock readings). Each test names
//! its recorded case; the manifests list the cases that are not replayed and why.

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
use super::wire::log;
use super::wire::normalized;

fn recording(set: &str) -> Value {
    let path = format!("{}/../../fixtures/{set}/recording.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn case(set: &str, line: u64) -> Value {
    recording(set)["cases"].as_array().unwrap().iter().find(|case| case["testLine"] == line).unwrap_or_else(|| panic!("{set}: no case {line}")).clone()
}

fn named(set: &str, name: &str) -> Value {
    recording(set)["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap_or_else(|| panic!("{set}: no case {name}")).clone()
}

fn step<'a>(case: &'a Value, starts: &str) -> &'a Value {
    case["result"]["steps"].as_array().unwrap().iter().find(|step| step["step"].as_str().unwrap().starts_with(starts)).unwrap_or_else(|| panic!("no step {starts}"))
}

/// The recorded cases of the three sets that no test below replays, each with why (the sets' manifests say the same). A case of a set
/// that is neither replayed nor listed here fails [`every_recorded_case_is_replayed_or_declared`], so a re-recording that adds a case
/// cannot pass unseen. The key is the case's `testLine`, or its name for the one line two cases share.
const NOT_REPLAYED: [(&str, &str, &str); 12] = [
    ("session-transport-call-contract", "15", "Node's OAuth registry answers a flow `register({provider, manualUrl, completeCode})` with a status whose `url` is null and a `manualUrl`, which complete and cancel then settle; the core keeps those answers in fixtures/login-status (replayed by mixdog-core-domains ai_account/tests.rs), and no core sign-in start produces a flow with a null url (`LoginState::Authorize` carries one)"),
    ("session-transport-call-contract", "call-idempotency-is-isolated-per-client-process", "the base commit's defect (one submission run twice); the case replayed is the one recorded with the fix"),
    ("session-transport-call-contract", "320", "Node's `session.configure setRoute` whose runtime then reports another session id is answered under the addressed id (call-route.mjs re-labels the answer); a core thread's id is fixed when its actor is created and no method changes it, so no core answer can carry another id"),
    ("session-transport-call-contract", "369", "Node's answers after that address mismatch (`session.read`, `session.subscribe`, the transitions' `applyResult`) keep the addressed id and move no binding; a core thread's id is fixed when its actor is created and no method changes it, so there is no mismatch to survive"),
    ("session-transport-call-contract", "465", "Node's TUI remote-runtime proxy (`createSession`, `runtime.submit`, `setProgressHint`, `abortAsync`, `newSession` over `session.*` calls, and its mirrored state) has no core counterpart: the only Rust front end, mixdog-cli, is the `exec` command and holds no remote session projection"),
    ("session-transport-state-lanes", "192", "replayed by mixdog-app-server-client tests/it/silent_connection.rs, where the client connection is"),
    ("session-transport-state-lanes", "channel-transport-publishes-the-pinned-remote-session-independently-of-state-file-persistence", "the base commit records the String(null) defect the patch fixes; the case replayed is the one recorded with the fix"),
    ("session-transport-state-lanes", "channel-transport-publishes-the-pinned-remote-session-independently-of-state-file-persistence--with-the-fix", "replayed by mixdog-services channels/tests_runtime.rs, where the channel transport is"),
    ("session-transport-state-lanes", "428", "replayed by mixdog-app-server-daemon late_lifecycle.rs, where the in-daemon transport is"),
    ("session-transport-state-lanes", "446", "replayed by mixdog-app-server-client tests/it/silent_connection.rs, where the client connection is"),
    ("session-transport-state-lanes", "493", "Node's client ends a silent event stream after its liveness timeout (20 ms in the recording) and gives up when reconnects keep failing for 60 ms of wall time (a budget); the core's client has neither: it keeps a silent connection (silent_connection.rs) and its reconnect ladder retries until the client is closed (engine.rs `reconnect`)"),
    ("session-transport-steering-recovery", "90", "Node's TUI keeps `commandBusy` set while its `resume(id, {quiet: true})` waits for the steering restore gate and releases it when the gate resolves; the core's thread restores its durable queue when it opens (case 75), and no Rust front end holds a `commandBusy`"),
];

/// Every case of the three recordings is consumed by a test of this file (named in a `case(set, line)` or `named(set, name)` call)
/// or listed in [`NOT_REPLAYED`] with its reason; a listed case that is consumed is a stale entry.
#[test]
fn every_recorded_case_is_replayed_or_declared() {
    // The replays follow the marker line below; the marker is written here in two pieces so that this text does not hold it.
    let source = include_str!("session_transport.rs");
    let consumers = source.split(concat!("// ---- ", "replays ----")).nth(1).expect("the marker line follows this test");
    for set in ["session-transport-call-contract", "session-transport-state-lanes", "session-transport-steering-recovery"] {
        for recorded in recording(set)["cases"].as_array().unwrap() {
            let (line, name) = (recorded["testLine"].as_u64().unwrap(), recorded["name"].as_str().unwrap());
            let consumed = consumers.contains(&format!("case(\"{set}\", {line})")) || consumers.contains(&format!("named(\"{set}\", \"{name}\")"));
            let declared = NOT_REPLAYED.iter().any(|(declared_set, key, _)| *declared_set == set && (*key == line.to_string() || *key == name));
            assert!(consumed || declared, "{set} case {line} ({name}) is neither replayed nor declared not replayed");
            assert!(!(consumed && declared), "{set} case {line} ({name}) is replayed and also declared not replayed");
        }
    }
}

// ---- replays ----

/// The prompt texts of a Node `full` snapshot's items, in order.
fn node_texts(full: &Value) -> Vec<String> {
    full["items"].as_array().unwrap().iter().map(|item| item["text"].as_str().unwrap().to_owned()).collect()
}

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

/// Compares what a client received, whole and in order, with `expected`, both after the declared normalization
/// (`wire::normalized`; `generated` holds the thread id the core minted).
fn whole(name: &str, frames: &[Value], generated: &[&str], expected: Vec<Value>) {
    let got = normalized(frames, generated);
    log(name, &got);
    let want = normalized(&expected, generated);
    log(&format!("{name}.expected"), &want);
    assert_eq!(got, want, "{name}: every frame the client received");
}

// The frames the core's protocol gives (mixdog-app-protocol v2 thread types) for what Node's recording determines: the
// prompts, answers, refusals and hand-backs come from the recording; the rest of each frame is the core's shape for a
// fresh thread at `/ws`. Generated ids are written as stand-ins (`uuid(n)`, `EPOCH`): only which of them are the same id
// is compared.

const EPOCH: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/// The feed publications a thread started through `thread/start` has made before a wire client attaches to it (the first one, at
/// seq 0, and its frame, which [`World::started_on`] waits for), so the sequence numbers below count from there. The numbers are
/// the core's own feed numbering, not Node's. A thread opened from the store made one fewer (it has no start of its own).
const BEFORE_ATTACH: u64 = 2;

fn uuid(n: u32) -> String {
    format!("00000000-0000-7000-8000-{n:012}")
}

fn meta(thread: &ThreadId) -> Value {
    json!({ "id": thread, "preview": "", "title": "", "updatedAt": 0, "messageCount": 0, "cwd": "/ws", "classification": {}, "projectPath": null })
}

fn runtime(busy: bool) -> Value {
    json!({
        "busy": busy, "commandBusy": false, "thinking": null, "spinner": null, "commandStatus": null, "progressHint": null,
        "activeTools": null, "clientHostPid": 0, "toasts": [], "activeToolSummary": null, "toolMode": "full",
    })
}

/// The runtime of a running turn: busy, its spinner requesting (`turn.mjs` `runTurn`; a first turn's verb, `pickVerb(0)`).
fn running() -> Value {
    let mut value = runtime(true);
    value["spinner"] = json!({ "active": true, "verb": "Architecting", "startedAt": 0, "responseLength": 0, "inputTokens": 0, "outputTokens": 0, "mode": "requesting" });
    value
}

/// A thread's state: `busy` while a turn runs, `history` its prompt history, newest first.
fn state(busy: bool, history: &[&str]) -> Value {
    json!({
        "runtime": if busy { running() } else { runtime(false) },
        // `sessionProvider` / `sessionModel` are always sent, null before the conversation has a provider (`routeState`).
        "route": { "sessionProvider": null, "sessionModel": null, "fast": false, "fastCapable": false, "autoEffort": true, "modelParameters": {}, "effort": null, "turnEffort": null, "effortOptions": [], "cwd": "/ws", "sessionForkedFrom": null },
        "context": {
            "contextPercent": null, "contextWindow": null, "displayContextWindow": 0, "autoCompactTokenLimit": 0,
            "stats": {
                "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "cacheWriteTokens": 0, "promptTokens": 0, "latestInputTokens": 0,
                "latestOutputTokens": 0, "latestCachedTokens": 0, "latestCacheWriteTokens": 0, "latestPromptTokens": 0, "costUsd": 0, "turns": 0,
                "currentContextTokens": null, "currentEstimatedContextTokens": 0, "currentContextSource": "pending", "currentContextUpdatedAt": null, "usageReadout": null,
            },
            "rawContextWindow": null, "effectiveContextWindowPercent": null, "compactBoundaryTokens": 0,
        },
        "queued": [],
        "agents": { "agentWorkers": [], "agentJobs": [], "agentScope": { "clientHostPid": 0 } },
        "workflow": { "orchestrationMode": "balanced", "pendingWorkflowSwitch": false, "pendingOrchestrationModeSwitch": false },
        "approvals": { "toolApprovalResult": null },
        "promptHistoryList": history,
    })
}

fn user_item(id: &str, turn: &str, text: &str) -> Value {
    json!({ "type": "userMessage", "id": id, "content": [{ "type": "text", "text": text }], "displayText": text, "countsForPromptHistory": true, "meta": { "turnId": turn } })
}

fn agent_item(id: &str, turn: &str, text: &str) -> Value {
    json!({ "type": "agentMessage", "id": id, "text": text, "meta": { "turnId": turn, "ext": { "completionVerb": "Mapped", "streaming": false } } })
}

fn answer(id: i64, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

fn started(id: i64, turn: &str) -> Value {
    answer(id, json!({ "kind": "started", "turnId": turn }))
}

fn read(id: i64, thread: &ThreadId, state: Value, items: Vec<Value>) -> Value {
    answer(id, json!({ "thread": meta(thread), "state": state, "items": items, "hasOlder": false }))
}

/// A `thread/resume` answer on the `connection`-th connection and the snapshot that follows it, the feed at `seq`.
fn resumed(connection: u64, id: i64, thread: &ThreadId, seq: u64, state: Value, items: Vec<Value>) -> [Value; 2] {
    let seq = seq + BEFORE_ATTACH;
    let subscription = json!({ "id": format!("c{connection}-1"), "mode": "snapshot", "epoch": EPOCH, "startSeq": seq + 1, "liveSeq": seq + 1 });
    [
        answer(id, json!({ "thread": meta(thread), "subscription": subscription })),
        json!({ "method": "thread/snapshot", "params": { "thread": meta(thread), "state": state, "items": items, "hasOlder": false }, "feed": { "id": thread, "epoch": EPOCH, "seq": seq } }),
    ]
}

fn event(thread: &ThreadId, seq: u64, method: &str, params: Value) -> Value {
    json!({ "method": method, "params": params, "feed": { "id": thread, "epoch": EPOCH, "seq": seq + BEFORE_ATTACH } })
}

/// One turn's frames on a subscribed client, the feed from `seq`: [`turn_start`], `ack` (the submitter's `turn/start`
/// answer, which the submitting client receives after the start), then [`turn_end`] from `seq + 5`.
fn turn_frames(thread: &ThreadId, seq: u64, turn: &str, prompt: (&str, &str), reply: (&str, &str), ack: Option<i64>) -> Vec<Value> {
    let mut frames = turn_start(thread, seq, turn, prompt);
    frames.extend(ack.map(|id| started(id, turn)));
    frames.extend(turn_end(thread, seq + 5, turn, reply));
    frames
}

/// `thread/frame`: one of Node's publications of the session's state to a phone, after the changes of one step
/// (`mixdog-core-session` session/phone_frame.rs); `structure`: whether the rows changed.
fn frame(thread: &ThreadId, seq: u64, structure: bool) -> Value {
    event(thread, seq, "thread/frame", json!({ "threadId": thread, "structureChanged": structure }))
}

/// A turn's start, the feed from `seq`: the prompt item, its history entry, the turn's start, the running runtime and
/// the step's frame.
fn turn_start(thread: &ThreadId, seq: u64, turn: &str, prompt: (&str, &str)) -> Vec<Value> {
    vec![
        event(thread, seq, "item/completed", json!({ "threadId": thread, "turnId": turn, "item": user_item(prompt.0, turn, prompt.1) })),
        event(thread, seq + 1, "thread/promptHistory/updated", json!({ "threadId": thread, "value": { "kind": "added", "prompt": prompt.1 } })),
        event(thread, seq + 2, "turn/started", json!({ "threadId": thread, "turn": { "id": turn, "status": "inProgress", "startedAt": 0 } })),
        event(thread, seq + 3, "thread/runtime/updated", json!({ "threadId": thread, "value": running() })),
        frame(thread, seq + 4, true),
    ]
}

/// A turn's end, the feed from `seq`: `reply`, the answer item, the turn's end, the idle runtime and the one frame the turn's
/// end flushed with all of it (`settleTurn`'s `flushEmit`, after `publishTurnClose` set the runtime idle).
fn turn_end(thread: &ThreadId, seq: u64, turn: &str, reply: (&str, &str)) -> Vec<Value> {
    vec![
        event(thread, seq, "item/completed", json!({ "threadId": thread, "turnId": turn, "item": agent_item(reply.0, turn, reply.1) })),
        event(thread, seq + 1, "turn/completed", json!({ "threadId": thread, "turn": { "id": turn, "status": "completed", "completedAt": 0 } })),
        event(thread, seq + 2, "thread/runtime/updated", json!({ "threadId": thread, "value": runtime(false) })),
        frame(thread, seq + 3, true),
    ]
}

/// The queue's change, the feed from `seq`, and its step's frame (no row changed).
fn queue_changed(thread: &ThreadId, seq: u64, queued: Value) -> [Value; 2] {
    [event(thread, seq, "thread/queue/changed", json!({ "threadId": thread, "queued": queued })), frame(thread, seq + 1, false)]
}

/// The `turn/interrupt` answer of an idle thread handing back `restored` (`(text, submission ids)`), or nothing.
fn stop_answer(id: i64, text: &str, pasted_texts: Value, ids: &[&str]) -> Value {
    answer(
        id,
        json!({
            "cancelRequested": false, "aborted": false, "restoreText": text, "pastedImages": null, "pastedTexts": pasted_texts,
            "discardPastedImages": null, "discardPastedTexts": null, "restoredSubmissionIds": ids,
        }),
    )
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
        let directory = Arc::new(SessionDirectory::new(session.deps()));
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

    /// A server over an idle thread whose durable queue holds `queued` `(submission id, text)` entries.
    async fn idle(queued: &[(&str, &str)]) -> Self {
        Self::idle_on(Rig::new(), queued, Value::Null).await
    }

    /// [`World::idle`] served by `rig`, each entry holding `pasted_texts` (its options' map) unless null.
    async fn idle_on(rig: Rig, queued: &[(&str, &str)], pasted_texts: Value) -> Self {
        let session = SessionRig::new();
        let id = ThreadId::from("sess_idle");
        let creator = SessionDirectory::new(session.deps());
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
        let directory = Arc::new(SessionDirectory::new(session.deps()));
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

fn submitted_prompt(node: &Value) -> String {
    node["result"]["serviceCalls"].as_array().unwrap().iter().find(|call| call["name"] == "session.submit").unwrap()["args"]["prompt"].as_str().unwrap().to_owned()
}

fn resume() -> Value {
    json!({ "window": { "lastItems": 10 } })
}

/// call-contract case 438: a retried `turn/start` with the same op id and payload answers what the first answered and
/// runs once; the thread holds the prompt once, as Node's read did. The client follows the thread so the retry and the read
/// are sent once the run has ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retried_start_with_the_same_op_runs_once() {
    let node = case("session-transport-call-contract", 438);
    let prompt = submitted_prompt(&node);
    assert_eq!(node_texts(&step(&node, "session.read")["ok"]["full"]), [prompt.clone()]);
    let world = World::started(echo()).await;
    let mut client = world.client(1).await;
    world.call(&mut client, 1, "thread/resume", resume()).await;
    world.submit(&mut client, 2, "stable-call-id", &prompt).await;
    client.until("the run's end", |frames| ran(frames, 1)).await;
    world.submit(&mut client, 3, "stable-call-id", &prompt).await;
    world.call(&mut client, 4, "thread/read", json!({})).await;
    let (t, reply) = (uuid(1), format!("re: {prompt}"));
    let items = vec![user_item(&uuid(2), &t, &prompt), agent_item(&format!("a-{t}"), &t, &reply)];
    let mut expected = resumed(1, 1, &world.id, 0, state(false, &[]), vec![]).to_vec();
    expected.extend(turn_frames(&world.id, 1, &t, (&uuid(2), &prompt), (&format!("a-{t}"), &reply), Some(2)));
    expected.extend([started(3, &t), read(4, &world.id, state(false, &[&prompt]), items)]);
    whole("call-contract-438", &client.frames, &[world.id.as_str()], expected);
}

/// call-contract case 507: the same op id with another payload is refused and changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reused_op_with_another_payload_fails_closed() {
    let node = case("session-transport-call-contract", 507);
    assert!(step(&node, "session.submit prompt second")["error"].is_object(), "Node refused it");
    let world = World::started(echo()).await;
    let mut client = world.client(1).await;
    world.call(&mut client, 1, "thread/resume", resume()).await;
    world.submit(&mut client, 2, "conflicting-call-id", "first").await;
    client.until("the run's end", |frames| ran(frames, 1)).await;
    world.submit(&mut client, 3, "conflicting-call-id", "second").await;
    world.call(&mut client, 4, "thread/read", json!({})).await;
    let t = uuid(1);
    let items = vec![user_item(&uuid(2), &t, "first"), agent_item(&format!("a-{t}"), &t, "re: first")];
    let mut expected = resumed(1, 1, &world.id, 0, state(false, &[]), vec![]).to_vec();
    expected.extend(turn_frames(&world.id, 1, &t, (&uuid(2), "first"), (&format!("a-{t}"), "re: first"), Some(2)));
    expected.extend([
        json!({ "id": 3, "error": { "code": -32602, "message": "opIdConflict", "data": { "reason": "opIdConflict", "opId": "conflicting-call-id" } } }),
        read(4, &world.id, state(false, &["first"]), items),
    ]);
    whole("call-contract-507", &client.frames, &[world.id.as_str()], expected);
}

/// call-contract case 243: a viewer that subscribes and then unsubscribes never interrupts the work; the turn ends as
/// it would have, and the client still attached sees its answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsubscribing_never_interrupts_the_running_turn() {
    let node = case("session-transport-call-contract", 243);
    let release = Arc::new(tokio::sync::Notify::new());
    let held = release.clone();
    let answer_text = node_texts(&step(&node, "work finished")["snapshot"]).last().unwrap().clone();
    let reply = answer_text.clone();
    let world = World::started(Arc::new(move |run| {
        let held = held.clone();
        let reply = reply.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            held.notified().await;
            let commit = ItemCommit { iid: ItemId::from("answer"), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": reply }), prompt: None };
            run.port.commit_item(commit).await.expect("commit");
            RunOutcome::Completed(Default::default())
        })
    }))
    .await;
    let mut terminal = world.client(1).await;
    let mut desktop = world.client(2).await;
    world.call(&mut terminal, 1, "thread/resume", resume()).await;
    let prompt = node_texts(&step(&node, "terminal stream reports busy")["snapshot"])[0].clone();
    world.submit(&mut terminal, 2, "durable-submit", &prompt).await;
    world.call(&mut desktop, 1, "thread/resume", resume()).await;
    world.call(&mut desktop, 2, "thread/unsubscribe", json!({})).await;
    release.notify_one();
    terminal.until("the run's end", |frames| ran(frames, 1)).await;
    world.call(&mut terminal, 3, "thread/read", json!({})).await;
    let t = uuid(1);
    let mut expected = resumed(1, 1, &world.id, 0, state(false, &[]), vec![]).to_vec();
    expected.extend(turn_frames(&world.id, 1, &t, (&uuid(2), &prompt), ("answer", &answer_text), Some(2)));
    let items = vec![user_item(&uuid(2), &t, &prompt), agent_item("answer", &t, &answer_text)];
    expected.push(read(3, &world.id, state(false, &[&prompt]), items));
    whole("call-contract-243-terminal", &terminal.frames, &[world.id.as_str()], expected);
    // The viewer attached while the turn ran: its snapshot shows the turn's prompt and the runtime busy (busy from the run's start,
    // as Node's askSession), then its unsubscribe is answered and nothing more reaches it.
    let mut expected = resumed(2, 1, &world.id, 5, state(true, &[&prompt]), vec![user_item(&uuid(2), &t, &prompt)]).to_vec();
    expected.push(answer(2, json!({})));
    whole("call-contract-243-desktop", &desktop.frames, &[world.id.as_str()], expected);
}

/// call-contract case 130, state-lanes case 67: a read or a subscription of a session that does not exist is refused,
/// and nothing is created for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_thread_is_refused_and_nothing_is_created() {
    let read_case = case("session-transport-call-contract", 130);
    let subscribe = case("session-transport-state-lanes", 67);
    assert!(read_case["result"]["outcome"]["error"].is_object() && subscribe["result"]["outcome"]["error"].is_object());
    assert_eq!(subscribe["result"]["runtimeCreations"], 0);
    let (read_id, subscribe_id) = (read_case["input"]["call"][1]["sessionId"].as_str().unwrap().to_owned(), subscribe["input"]["call"][1]["sessionId"].as_str().unwrap().to_owned());
    let session = SessionRig::new();
    let directory = Arc::new(SessionDirectory::new(session.deps()));
    let rig = Rig::new();
    rig.core.serve_threads(directory.clone());
    let wire = Wire::serve(rig).await;
    let mut client = wire.client("PC", "desktop").await;
    client.call(1, "thread/read", json!({ "threadId": read_id })).await;
    client.call(2, "thread/resume", json!({ "threadId": subscribe_id, "window": { "lastItems": 10 } })).await;
    for missing in [&read_id, &subscribe_id] {
        let id = ThreadId::from(missing.as_str());
        assert!(directory.handle(&id).is_none(), "{missing}: no thread was loaded");
        assert!(session.store.records(&id).is_empty(), "{missing}: nothing was written");
    }
    let refused = |id: i64, thread: &str| json!({ "id": id, "error": { "code": -32600, "message": "threadNotFound", "data": { "reason": "threadNotFound", "threadId": thread } } });
    whole("call-contract-130-state-lanes-67", &client.frames, &[], vec![refused(1, &read_id), refused(2, &subscribe_id)]);
}

/// state-lanes case 365: every attached client folds the same items, whichever of them submitted. The terminal's prompt
/// runs; the desktop's, sent while it runs, waits in the thread's queue and runs next (Node's stub runtime answered both
/// at once; the core's thread runs one turn at a time, as Node's runtime does).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_attached_client_folds_the_same_items() {
    let node = case("session-transport-state-lanes", 365);
    let folded = node_texts(&json!({ "items": step(&node, "desktop session.submit")["items"] }));
    let [from_terminal, from_desktop] = [folded[0].as_str(), folded[1].as_str()];
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
    world.submit(&mut terminal, 2, "op-0", from_terminal).await;
    world.submit(&mut desktop, 2, "op-1", from_desktop).await;
    release.notify_one();
    terminal.until("both runs' ends", |frames| ran(frames, 2)).await;
    desktop.until("both runs' ends", |frames| ran(frames, 2)).await;
    let (t1, t2, queued) = (uuid(1), uuid(11), uuid(3));
    for (name, connection, client) in [("terminal", 1, &terminal), ("desktop", 2, &desktop)] {
        let mut expected = resumed(connection, 1, &world.id, 0, state(false, &[]), vec![]).to_vec();
        expected.extend(turn_start(&world.id, 1, &t1, (&uuid(2), from_terminal)));
        if connection == 1 {
            expected.push(started(2, &t1));
        }
        expected.extend(queue_changed(&world.id, 6, json!([{ "id": queued, "text": from_desktop }])));
        if connection == 2 {
            expected.push(answer(2, json!({ "kind": "queued", "queuedId": queued })));
        }
        expected.extend(turn_end(&world.id, 8, &t1, (&format!("a-{t1}"), &format!("re: {from_terminal}"))));
        expected.extend(queue_changed(&world.id, 12, json!([])));
        expected.extend(turn_frames(&world.id, 14, &t2, (&uuid(12), from_desktop), (&format!("a-{t2}"), &format!("re: {from_desktop}")), None));
        whole(&format!("state-lanes-365-{name}"), &client.frames, &[world.id.as_str()], expected);
    }
}

/// state-lanes case 94: a subscribed client receives the session's publications, a read answers the same items, and
/// after it unsubscribes nothing more reaches it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unsubscribed_client_receives_nothing_more() {
    let node = case("session-transport-state-lanes", 94);
    assert_eq!(step(&node, "session.unsubscribe")["ok"]["unsubscribed"], true);
    assert_eq!(step(&node, "external publish after unsubscribe")["newFrames"], json!([]));
    let brief = node_texts(&step(&node, "session.subscribe")["ok"]["full"])[0].clone();
    let world = World::started(echo()).await;
    let mut pane = world.client(1).await;
    let mut other = world.client(2).await;
    world.call(&mut pane, 1, "thread/resume", resume()).await;
    world.submit(&mut pane, 2, "op-brief", &brief).await;
    pane.until("the run's end", |frames| ran(frames, 1)).await;
    world.call(&mut pane, 3, "thread/read", json!({})).await;
    world.call(&mut pane, 4, "thread/unsubscribe", json!({})).await;
    world.call(&mut other, 1, "thread/resume", resume()).await;
    world.submit(&mut other, 2, "op-after", "after").await;
    other.until("the run's end", |frames| ran(frames, 1)).await;
    // The pane's last request is answered after everything published to it so far: a read on the pane after the other
    // client's run ended shows whether anything else reached it.
    world.call(&mut pane, 5, "thread/read", json!({})).await;
    let (t1, t2) = (uuid(1), uuid(11));
    let first = vec![user_item(&uuid(2), &t1, &brief), agent_item(&format!("a-{t1}"), &t1, &format!("re: {brief}"))];
    let mut both = first.clone();
    both.extend([user_item(&uuid(12), &t2, "after"), agent_item(&format!("a-{t2}"), &t2, "re: after")]);
    let mut expected = resumed(1, 1, &world.id, 0, state(false, &[]), vec![]).to_vec();
    expected.extend(turn_frames(&world.id, 1, &t1, (&uuid(2), &brief), (&format!("a-{t1}"), &format!("re: {brief}")), Some(2)));
    expected.extend([
        read(3, &world.id, state(false, &[&brief]), first),
        answer(4, json!({})),
        read(5, &world.id, state(false, &["after", &brief]), both),
    ]);
    whole("state-lanes-94-pane", &pane.frames, &[world.id.as_str()], expected);
}

/// steering-recovery case 14: a submission the thread holds but has not started is handed back by its id with its text,
/// and is gone from the thread afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_submission_is_reclaimed_by_its_id() {
    let node = case("session-transport-steering-recovery", 14);
    let abort = step(&node, "abort(");
    assert_eq!(abort["queuedLength"], 0);
    let id = abort["result"]["restoredSubmissionIds"][0].as_str().unwrap();
    let text = abort["result"]["restoreText"].as_str().unwrap();
    assert_eq!(abort["result"]["aborted"], false);
    let world = World::idle(&[(id, text)]).await;
    let mut client = world.client(1).await;
    world.call(&mut client, 1, "turn/interrupt", json!({ "restorePrompt": true, "submissionId": id })).await;
    world.call(&mut client, 2, "turn/interrupt", json!({ "submissionId": id })).await;
    let expected = vec![stop_answer(1, text, abort["result"]["pastedTexts"].clone(), &[id]), stop_answer(2, "", Value::Null, &[])];
    whole("steering-recovery-14", &client.frames, &[world.id.as_str()], expected);
}

/// steering-recovery case 75: a prompt submitted while a turn runs is kept durably with its submission id, and after a
/// restart the thread hands it back by that id with its text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_submission_keeps_its_id_across_a_restart() {
    let node = case("session-transport-steering-recovery", 75);
    let restored = &node["result"]["restored"][0];
    let (text, submission) = (restored["text"].as_str().unwrap(), restored["submissionId"].as_str().unwrap());
    let world = World::started(until_stopped()).await;
    let mut client = world.client(1).await;
    world.submit(&mut client, 1, "op-run", "running").await;
    let params = json!({ "opId": "op-steer", "input": { "prompt": text, "options": { "clientSubmissionId": submission } } });
    world.call(&mut client, 2, "turn/start", params).await;
    let kept: Vec<Value> = world
        .session
        .store
        .records(&world.id)
        .into_iter()
        .map(|(_, record)| serde_json::to_value(record).unwrap())
        .filter(|record| record["k"] == "queue" && record["action"] == "enqueue")
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(kept[0]["entry"]["inline"]["message"], text);
    assert_eq!(kept[0]["entry"]["inline"]["options"]["clientSubmissionId"], submission);
    whole("steering-recovery-75-before", &client.frames, &[world.id.as_str()], vec![started(1, &uuid(1)), answer(2, json!({ "kind": "queued", "queuedId": uuid(2) }))]);

    let World { directory, session, id, .. } = world;
    drop(directory);
    let restarted = World::reopened(session, id).await;
    let mut client = restarted.client(1).await;
    restarted.call(&mut client, 1, "turn/interrupt", json!({ "restorePrompt": true, "submissionId": submission })).await;
    whole("steering-recovery-75-after", &client.frames, &[restarted.id.as_str()], vec![stop_answer(1, text, Value::Null, &[submission])]);
}

/// steering-recovery case 139: a stop sent while 64 ordinary calls of the same client are held is answered ahead of them,
/// and every call is then answered with no refusal. Node's calls were a settings read its stub runtime held on a gate
/// (`scripts/session-transport/steering-recovery.test.mjs:151-163`); here they are `config/read` (the core's settings
/// read) served by a gate the test releases, answering what Node's read answered (`readOutcomes[n].ok.value`). All 64 start
/// before the stop is sent (`startedBeforeAbort`), each lane turn starting one in request order, and none is refused. Node's
/// abort answer is its stub runtime's (`steering-recovery.test.mjs:198-205`: `aborted: true` with nothing running); the
/// core's idle stop hands back the queued prompt the stub returned, with its pasted text, and answers `aborted: false`, as
/// nothing ran. Node does not order the arrival of the 64 answers (its test collects them by index,
/// `steering-recovery.test.mjs:185`, and the wire tap lists exchanges in request order), so the replay fixes it: the gate opens
/// one call at a time in request order and every frame is compared as it arrived, the stop's answer first as Node's test saw it
/// before it opened the gate (`steering-recovery.test.mjs:164-184`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_is_answered_while_reads_are_in_flight() {
    let node = case("session-transport-steering-recovery", 139);
    let reads = node["result"]["startedBeforeAbort"].as_u64().unwrap() as i64;
    let outcomes = node["result"]["readOutcomes"].as_array().unwrap();
    assert_eq!(outcomes.len() as i64, reads);
    assert!(outcomes.iter().all(|read| read.get("ok").is_some()), "Node answered every read");
    assert_eq!(node["result"]["abortCalls"], 1);
    let options = &node["result"]["abortOptions"][0];
    let abort = &node["result"]["abort"]["ok"];
    let submission = options["submissionId"].as_str().unwrap();
    let rig = Rig::routed(super::domain_methods(), vec![("config", &["config/read"])]);
    let gate = Arc::clone(rig.gate("config"));
    gate.answers.lock().unwrap().extend(outcomes.iter().map(|read| read["ok"]["value"].clone()));
    let world = World::idle_on(rig, &[(submission, abort["restoreText"].as_str().unwrap())], abort["pastedTexts"].clone()).await;
    let mut client = world.client(1).await;
    let mut started = gate.started.subscribe();
    for n in 0..reads {
        client.send(100 + n, "config/read", json!({})).await;
    }
    mixdog_rt::time::timeout(std::time::Duration::from_secs(20), started.wait_for(|count| *count as i64 == reads))
        .await
        .expect("every read to start within 20 s (Node: startedBeforeAbort)")
        .expect("the gate outlives the test");
    let mut stop = options.clone();
    stop["threadId"] = json!(world.id);
    client.send(1, "turn/interrupt", stop).await;
    client.answer(1).await;
    // The gate opens one call at a time in request order, so the answers arrive in the order released.
    for released in 0..reads {
        gate.permits.add_permits(1);
        client.until("the released call's answer", |frames| frames.len() as i64 == released + 2).await;
    }
    let mut expected = vec![stop_answer(1, abort["restoreText"].as_str().unwrap(), abort["pastedTexts"].clone(), &[submission])];
    expected.extend((0..reads).map(|n| answer(100 + n, outcomes[n as usize]["ok"]["value"].clone())));
    whole("steering-recovery-139", &client.frames, &[world.id.as_str()], expected);
}

/// call-contract case 156: the same call id from two client connections. Node, patched so a call id is accepted once per
/// session (`recorders/patches/node-fix-call-id-once-per-session.patch`), accepted the first and gave the second the first
/// one's answer; the core's op ids are scoped to the thread (`mixdog-core-session` session/ops.rs), so both connections get
/// the same answer and the prompt is stored and run once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_op_from_another_connection_is_answered_once() {
    let node = named("session-transport-call-contract", "call-idempotency-is-isolated-per-client-process--with-the-fix");
    let second_answer = step(&node, "second.submit");
    assert_eq!(second_answer["ok"]["revision"], step(&node, "first.submit")["ok"]["revision"], "patched Node answered the retry with the first answer");
    assert_eq!(node_texts(&step(&node, "first.read")["ok"]["full"]).len(), 1, "patched Node ran the submission once");
    let prompt = submitted_prompt(&node);
    let world = World::started(echo()).await;
    let (mut first, mut second) = (world.client(1).await, world.client(2).await);
    let op = "same-process-local-id";
    world.call(&mut first, 1, "thread/resume", resume()).await;
    world.submit(&mut first, 2, op, &prompt).await;
    first.until("the run's end", |frames| ran(frames, 1)).await;
    world.submit(&mut second, 1, op, &prompt).await;
    world.call(&mut first, 3, "thread/read", json!({})).await;
    let (t, reply) = (uuid(1), format!("re: {prompt}"));
    let items = vec![user_item(&uuid(2), &t, &prompt), agent_item(&format!("a-{t}"), &t, &reply)];
    let mut expected = resumed(1, 1, &world.id, 0, state(false, &[]), vec![]).to_vec();
    expected.extend(turn_frames(&world.id, 1, &t, (&uuid(2), &prompt), (&format!("a-{t}"), &reply), Some(2)));
    expected.push(read(3, &world.id, state(false, &[&prompt]), items));
    let mut frames = first.frames.clone();
    frames.extend(second.frames.iter().cloned());
    // Both connections' frames in one list, so the second's turn id is compared as the first's.
    expected.push(started(1, &t));
    whole("call-contract-156", &frames, &[world.id.as_str()], expected);
}

/// state-lanes case 303: a client with no stream while the remote state changes 10000 times receives only the latest when
/// it attaches, as Node kept one pending remote-state frame. The core publishes the binding as `hostState.remoteSession`
/// (`mixdog_core_domains::domains::host::publish_remote_session`, the publisher `compose_flip.rs` wires), whose section keeps
/// the latest value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_state_churn_with_no_reader_leaves_only_the_latest() {
    let node = case("session-transport-state-lanes", 303);
    assert_eq!(node["result"]["pendingQueueFieldPresent"], false);
    let pending: Value = serde_json::from_str(node["result"]["pendingRemoteStateFrame"].as_str().unwrap()).unwrap();
    let latest = pending["params"]["state"].as_str().unwrap().to_owned();
    let count: u64 = latest.trim_start_matches("state-").parse::<u64>().unwrap() + 1;
    let rig = Rig::new();
    let state = mixdog_core_base::state::SectionFeedState::new(rig.core.mock.app().clone());
    for n in 0..count {
        mixdog_core_domains::domains::host::publish_remote_session(&state, true, Some(&format!("state-{n}")), None);
    }
    let wire = Wire::serve(rig).await;
    let mut client = wire.client("PC", "desktop").await;
    client.send(1, "app/subscribe", json!({})).await;
    client.until("the app snapshot", |frames| frames.iter().any(|frame| frame["method"] == "app/snapshot")).await;
    // One publication per change: the feed's sequence and the section's revision count them, and the snapshot holds one value.
    let expected = vec![
        answer(1, json!({ "subscription": { "id": "c1-1", "mode": "snapshot", "epoch": EPOCH, "startSeq": count + 1, "liveSeq": count + 1 } })),
        json!({
            "method": "app/snapshot",
            "params": { "sections": [{ "section": "hostState", "key": "remoteSession", "revision": count, "value": { "enabled": true, "sessionId": latest, "cwd": null } }] },
            "feed": { "id": "app", "epoch": EPOCH, "seq": count },
        }),
    ];
    whole("state-lanes-303", &client.frames, &[], expected);
}

/// state-lanes case 275: a client that was not attached while the session's state grew large receives that state once when it
/// attaches, as Node's returning client received the latest `session-state` frame (of 160 KiB) and not the backlog. The core's
/// feed gives the attaching client a snapshot of the thread as it stands, which holds the large prompt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_attaching_after_a_large_state_receives_it_once() {
    let node = case("session-transport-state-lanes", 275);
    assert_eq!(node["result"]["last"]["revision"], 3);
    let large = node["result"]["last"]["full"]["items"][0]["text"].as_str().unwrap().to_owned();
    assert_eq!(large.len(), 160 * 1024);
    let world = World::started(echo()).await;
    let mut watcher = world.client(1).await;
    world.call(&mut watcher, 1, "thread/resume", resume()).await;
    world.submit(&mut watcher, 2, "op-large", &large).await;
    watcher.until("the run's end", |frames| ran(frames, 1)).await;
    let mut late = world.client(2).await;
    world.call(&mut late, 1, "thread/resume", resume()).await;
    late.until("the snapshot", |frames| frames.iter().any(|frame| frame["method"] == "thread/snapshot")).await;
    let (t, reply) = (uuid(1), format!("re: {large}"));
    let items = vec![user_item(&uuid(2), &t, &large), agent_item(&format!("a-{t}"), &t, &reply)];
    let expected = resumed(2, 1, &world.id, 9, state(false, &[&large]), items).to_vec();
    whole("state-lanes-275", &late.frames, &[world.id.as_str()], expected);
}

/// state-lanes case 48: a tool call's result on a transcript of 2000 rows reaches an attached client as the one changed item and
/// the idle runtime, never the transcript again (Node's patch: `busy: false` and the rows from 1999). The 1999 rows before it are
/// stored rows the thread opened with.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_result_on_a_long_transcript_sends_only_the_changed_item() {
    let node = case("session-transport-state-lanes", 48);
    let patch = &node["result"]["patch"];
    let append = &patch["itemsAppend"];
    assert_eq!(patch["set"], json!({ "busy": false }));
    assert_eq!(append["values"].as_array().unwrap().len(), 1, "Node sent one row");
    let (earlier, result_text) = (append["from"].as_u64().unwrap(), append["values"][0]["text"].as_str().unwrap().to_owned());
    let (ready, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let (committed, held, text) = (ready.clone(), release.clone(), result_text.clone());
    let session = SessionRig::new();
    session.set_script(Arc::new(move |run| {
        let (committed, held, text) = (committed.clone(), held.clone(), text.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "call-1", "name": "read", "arguments": {} }] });
            run.port.commit_item(ItemCommit { iid: ItemId::from("call-row"), role: Some("assistant".into()), model: true, visible: true, body: call, prompt: None }).await.expect("commit the call");
            committed.notify_one();
            held.notified().await;
            let result = json!({ "toolCallId": "call-1", "text": text });
            run.port.commit_item(ItemCommit { iid: ItemId::from("result-row"), role: Some("tool".into()), model: true, visible: true, body: result, prompt: None }).await.expect("commit the result");
            RunOutcome::Completed(Default::default())
        })
    }));
    let id = ThreadId::from("sess_long");
    let creator = SessionDirectory::new(session.deps());
    creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().unwrap(), json!({})).await.expect("create");
    let rows = (0..earlier)
        .map(|n| serde_json::from_value::<Record>(json!({ "k": "item", "iid": format!("row-{n}"), "role": "assistant", "form": "message", "model": true, "visible": true, "refs": [], "body": { "inline": { "text": format!("row-{n}") } } })).unwrap())
        .collect();
    session.store.seed(&id, rows);
    let world = World::reopened_on(Rig::new(), session, id).await;
    let mut client = world.client(1).await;
    world.submit(&mut client, 1, "op-long", "go").await;
    mixdog_rt::time::timeout(std::time::Duration::from_secs(20), ready.notified()).await.expect("the run to commit the tool call within 20 s");
    world.call(&mut client, 2, "thread/resume", resume()).await;
    release.notify_one();
    client.until("the run's end", |frames| ran(frames, 1)).await;
    let t = uuid(1);
    // The window the attach shows: the last ten rows, which are eight of the stored rows, the prompt and the call.
    let mut snapshot_items: Vec<Value> = (earlier - 8..earlier).map(|n| json!({ "type": "agentMessage", "id": format!("row-{n}"), "text": format!("row-{n}"), "meta": {} })).collect();
    // A live card opens with none of its calls done and its result completes it (`openToolCalls`, aggregate-result.mjs:35-45).
    let call = json!({ "type": "toolCall", "id": "call:call-1", "name": "read", "input": {}, "run": { "callId": "call-1", "completedCount": 0, "live": true }, "meta": {} });
    snapshot_items.extend([user_item(&uuid(2), &t, "go"), call]);
    let tool_done = json!({ "type": "toolCall", "id": "call:call-1", "name": "read", "input": {}, "run": { "callId": "call-1", "result": result_text, "completedAt": 0, "completedCount": 1, "live": true }, "meta": {} });
    let mut context = state(false, &[])["context"].clone();
    context["stats"]["turns"] = json!(1);
    let turn_end_item = json!({
        "type": "turnEnd", "id": uuid(3), "status": "done", "elapsedMs": 0, "verb": "Mapped",
        "meta": { "turnId": t, "at": 1000, "ext": { "outputTokens": 0, "thinkingElapsedMs": 0, "toolCount": 1, "completionVerb": "Mapped", "attemptId": uuid(4) } },
    });
    let mut expected = vec![started(1, &t)];
    // Before the attach: the turn's start (five publications, [`turn_start`]) and the call's row with its step's frame. The thread
    // was opened from the store, so it made one publication fewer before them than [`BEFORE_ATTACH`] counts.
    expected.extend(resumed(1, 2, &world.id, 6, state(true, &["go"]), snapshot_items));
    expected[2]["params"]["hasOlder"] = json!(true); // 1991 stored rows lie before the window
    expected.extend([
        event(&world.id, 7, "item/completed", json!({ "threadId": world.id, "turnId": t, "item": tool_done })),
        event(&world.id, 8, "thread/context/updated", json!({ "threadId": world.id, "value": context })),
        event(&world.id, 9, "item/completed", json!({ "threadId": world.id, "turnId": t, "item": turn_end_item })),
        event(&world.id, 10, "turn/completed", json!({ "threadId": world.id, "turn": { "id": t, "status": "completed", "completedAt": 0 } })),
        event(&world.id, 11, "thread/runtime/updated", json!({ "threadId": world.id, "value": runtime(false) })),
        frame(&world.id, 12, true),
    ]);
    whole("state-lanes-48", &client.frames, &[world.id.as_str()], expected);
}

/// call-contract case 82: the session catalog has one route and never rides a session answer: Node's create, read and rename
/// answers carry no `sessions`, and the list answer is the one that does. The core's start, read and rename answers carry no
/// catalog either (`thread/list` is the one route).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_thread_catalog_never_rides_a_thread_answer() {
    let node = case("session-transport-call-contract", 82);
    assert!(step(&node, "session.list")["ok"]["sessions"].is_array(), "Node's list answers the catalog");
    for call in ["session.create", "session.read", "session.configure"] {
        assert!(step(&node, call)["ok"].get("sessions").is_none(), "Node's {call} answer carries no catalog");
    }
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

/// call-contract case 299: a failing read answers as a call error, a read nobody serves is refused, and the answer of a read
/// holds what serialises (Node: `getProfile` threw, `getOutputStyle` was not on the service, `getTheme` answered
/// `{ ok, callback: fn, when: Date(0) }`, of which the function was dropped and the date became its ISO text). The core's
/// counterparts are `config/getProfile`, `config/getOutputStyle` and `config/getTheme`, served here by the stub the recording
/// scripted. Not compared (the manifest says so): the error texts. Node hands the stub's own message ("stub failure") to the
/// caller; the core never does (an internal failure answers an incident id), and an unserved method is
/// `capabilityUnavailable` naming it, not Node's "session action getOutputStyle is unavailable".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_unserved_and_non_serializable_read_answer_as_node_does() {
    let node = case("session-transport-call-contract", 299);
    let (profile, style, theme) = (step(&node, "session.read action getProfile"), step(&node, "session.read action getOutputStyle"), step(&node, "session.read action getTheme"));
    assert!(profile["error"].is_object() && style["error"].is_object() && theme["ok"].is_object());
    let value = theme["ok"]["value"].clone();
    let served = value.clone();
    let rig = Rig::routed(&["config/getProfile", "config/getTheme"], Vec::new());
    rig.core.mock.mock_domain().set_handler(Arc::new(move |req| match req.method.as_str() {
        "config/getProfile" => Err(mixdog_core_api::CoreError::Internal { incident_id: "stub".into() }),
        _ => Ok(Reply::Value(served.clone())),
    }));
    let wire = Wire::serve(rig).await;
    let mut client = wire.client("PC", "desktop").await;
    let samples = super::sample::Samples::new();
    let mut outcomes = Vec::new();
    for (id, method) in [(1, "config/getProfile"), (2, "config/getOutputStyle"), (3, "config/getTheme")] {
        let reply = client.call(id, method, samples.params(method)).await;
        outcomes.push(if reply["error"].is_object() { json!({ "error": true }) } else { json!({ "ok": reply["result"] }) });
    }
    assert_eq!(outcomes, [json!({ "error": true }), json!({ "error": true }), json!({ "ok": value })]);
}
