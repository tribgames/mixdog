//! The Node session transport's client-visible contracts, replayed through the server over a real session thread:
//! `fixtures/session-transport-call-contract`, `session-transport-state-lanes` and `session-transport-steering-recovery`
//! (recorded by `benchmarks/rust-core/recorders/record-session-transport-*.mjs`). Node's daemon served a scripted
//! runtime, so what is compared is what a client of it saw — answers, refusals, the items each attached client folded,
//! what a later read or stop returns — never the scripted runtime's own values (revisions, `full` snapshots, its call
//! list). Each test names its recorded case; the manifests list the cases that are not replayed and why.

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

use super::Client;
use super::Rig;
use super::reason;

fn recording(set: &str) -> Value {
    let path = format!("{}/../../fixtures/{set}/recording.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn case(set: &str, line: u64) -> Value {
    recording(set)["cases"].as_array().unwrap().iter().find(|case| case["testLine"] == line).unwrap_or_else(|| panic!("{set}: no case {line}")).clone()
}

fn step<'a>(case: &'a Value, starts: &str) -> &'a Value {
    case["result"]["steps"].as_array().unwrap().iter().find(|step| step["step"].as_str().unwrap().starts_with(starts)).unwrap_or_else(|| panic!("no step {starts}"))
}

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

struct World {
    directory: Arc<SessionDirectory>,
    server: Rig,
    session: SessionRig,
    id: ThreadId,
}

impl World {
    /// A server over one real session thread whose runs follow `script`.
    async fn started(script: Script) -> Self {
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
        Self::serving(session, directory, id)
    }

    /// A server over an idle thread whose durable queue holds `queued` `(submission id, text)` entries.
    async fn idle(queued: &[(&str, &str)]) -> Self {
        let session = SessionRig::new();
        let id = ThreadId::from("sess_idle");
        let creator = SessionDirectory::new(session.deps());
        creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().unwrap(), json!({})).await.expect("create");
        let entries = queued
            .iter()
            .map(|(qid, text)| {
                serde_json::from_value::<Record>(json!({
                    "k": "queue", "qid": qid, "action": "enqueue",
                    "entry": { "inline": { "message": text, "enqueuedAt": 1, "priority": "next", "options": { "clientSubmissionId": qid } } },
                }))
                .unwrap()
            })
            .collect();
        session.store.seed(&id, entries);
        Self::reopened(session, id).await
    }

    /// The thread `id` of `session`'s store, opened by a directory of its own: what a restarted core serves.
    async fn reopened(session: SessionRig, id: ThreadId) -> Self {
        let directory = Arc::new(SessionDirectory::new(session.deps()));
        directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        Self::serving(session, directory, id)
    }

    fn serving(session: SessionRig, directory: Arc<SessionDirectory>, id: ThreadId) -> Self {
        let server = Rig::new();
        server.core.load(id.as_str(), directory.handle(&id).expect("loaded"));
        Self { directory, server, session, id }
    }

    fn client(&self, connection: u64) -> Viewer {
        Viewer { client: self.server.ready_as(connection, if connection == 1 { "PC" } else { "Phone" }, "desktop"), kept: std::sync::Mutex::default() }
    }

    async fn call(&self, client: &Viewer, id: i64, method: &str, params: Value) -> Value {
        let mut params = params;
        params["threadId"] = json!(self.id);
        client.client.request(id, method, params);
        client.response(id).await
    }

    async fn submit(&self, client: &Viewer, id: i64, op: &str, prompt: &str) -> Value {
        self.call(client, id, "turn/start", json!({ "opId": op, "input": { "prompt": prompt } })).await
    }

    /// The prompts the thread holds, from a `thread/read`.
    async fn prompts(&self, client: &Viewer, id: i64) -> Vec<String> {
        let read = self.call(client, id, "thread/read", json!({})).await;
        user_texts(&read["result"])
    }
}

/// The user prompts in `value`, in order, each once: the items a client folds from what it was sent.
fn user_texts(value: &Value) -> Vec<String> {
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut stack = vec![value];
    let mut order = Vec::new();
    while let Some(value) = stack.pop() {
        match value {
            Value::Object(map) => {
                if map.get("type").and_then(Value::as_str) == Some("userMessage") {
                    let id = map["id"].as_str().unwrap_or_default().to_owned();
                    let text = map["content"][0]["text"].as_str().unwrap_or_default().to_owned();
                    if !seen.iter().any(|(seen, _)| *seen == id) {
                        seen.push((id, text.clone()));
                        order.push(text);
                    }
                }
                // Visit in document order: push children in reverse.
                let children: Vec<&Value> = map.values().collect();
                stack.extend(children.into_iter().rev());
            }
            Value::Array(items) => stack.extend(items.iter().rev()),
            _ => {}
        }
    }
    order
}

/// A client connection and every frame it was sent, in order (an answer awaited does not drop what came before it).
struct Viewer {
    client: Client,
    kept: std::sync::Mutex<Vec<Value>>,
}

impl Viewer {
    fn take(&self) -> usize {
        let mut kept = self.kept.lock().unwrap();
        kept.extend(self.client.drain().into_iter().map(|wire| wire.body));
        kept.len()
    }

    fn sent(&self) -> Vec<Value> {
        self.take();
        self.kept.lock().unwrap().clone()
    }

    async fn response(&self, id: i64) -> Value {
        let found = sent_until(self, |frames| frames.iter().any(|frame| frame["id"] == json!(id) && frame.get("method").is_none())).await;
        found.into_iter().find(|frame| frame["id"] == json!(id) && frame.get("method").is_none()).unwrap()
    }
}

/// Everything `client` was sent, once `done` holds of it (yielding to the server's tasks in between).
async fn sent_until(client: &Viewer, mut done: impl FnMut(&[Value]) -> bool) -> Vec<Value> {
    for _ in 0..5_000 {
        let frames = client.sent();
        if done(&frames) {
            return frames;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("never done; sent {:?}", client.sent());
}

fn turns_completed(frames: &[Value]) -> Vec<Value> {
    frames.iter().filter(|frame| frame["method"] == "turn/completed").map(|frame| frame["params"]["turn"]["status"].clone()).collect()
}

/// Every key Node's answer carries has Node's value in the core's.
fn has_nodes_fields(core: &Value, node: &Value, name: &str) {
    for (key, want) in node.as_object().unwrap() {
        assert_eq!(&core[key], want, "{name}: {key} of {core}");
    }
}

/// call-contract case 438: a retried `turn/start` with the same op id and payload answers what the first answered and
/// runs once; the thread holds the prompt once, as Node's read did.
#[tokio::test(start_paused = true)]
async fn a_retried_start_with_the_same_op_runs_once() {
    let node = case("session-transport-call-contract", 438);
    let world = World::started(echo()).await;
    let client = world.client(1);
    let prompt = node["result"]["serviceCalls"].as_array().unwrap().iter().find(|call| call["name"] == "session.submit").unwrap()["args"]["prompt"].as_str().unwrap().to_owned();
    let first = world.submit(&client, 1, "stable-call-id", &prompt).await;
    let again = world.submit(&client, 2, "stable-call-id", &prompt).await;
    assert!(first.get("error").is_none(), "{first}");
    assert_eq!(again["result"], first["result"], "the retry answers the first answer");
    let read = node_texts(&step(&node, "session.read")["ok"]["full"]);
    assert_eq!(world.prompts(&client, 3).await, read, "the prompt ran once");
}

/// call-contract case 507: the same op id with another payload is refused and changes nothing.
#[tokio::test(start_paused = true)]
async fn a_reused_op_with_another_payload_fails_closed() {
    let node = case("session-transport-call-contract", 507);
    let world = World::started(echo()).await;
    let client = world.client(1);
    let first = world.submit(&client, 1, "conflicting-call-id", "first").await;
    assert!(first.get("error").is_none(), "{first}");
    let second = world.submit(&client, 2, "conflicting-call-id", "second").await;
    assert!(step(&node, "session.submit prompt second")["error"].is_object(), "Node refused it");
    assert_eq!(reason(&second), "opIdConflict", "{second}");
    let read = node_texts(&step(&node, "session.read")["ok"]["full"]);
    assert_eq!(world.prompts(&client, 3).await, read, "the refused call changed nothing");
}

/// call-contract case 243: a viewer that subscribes and then unsubscribes never interrupts the work; the turn ends as
/// it would have, and the client still attached sees its answer.
#[tokio::test(start_paused = true)]
async fn unsubscribing_never_interrupts_the_running_turn() {
    let node = case("session-transport-call-contract", 243);
    let release = Arc::new(tokio::sync::Notify::new());
    let held = release.clone();
    let answer = node_texts(&step(&node, "work finished")["snapshot"]).last().unwrap().clone();
    let reply = answer.clone();
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
    let terminal = world.client(1);
    let desktop = world.client(2);
    world.call(&terminal, 1, "thread/resume", json!({ "window": { "lastItems": 10 } })).await;
    let prompt = node_texts(&step(&node, "terminal stream reports busy")["snapshot"])[0].clone();
    let started = world.submit(&terminal, 2, "durable-submit", &prompt).await;
    assert_eq!(started["result"]["kind"], "started", "{started}");
    world.call(&desktop, 1, "thread/resume", json!({ "window": { "lastItems": 10 } })).await;
    let left = world.call(&desktop, 2, "thread/unsubscribe", json!({})).await;
    assert_eq!(left["result"], json!({}), "{left}");
    release.notify_one();
    let frames = sent_until(&terminal, |frames| !turns_completed(frames).is_empty()).await;
    assert_eq!(turns_completed(&frames), [json!("completed")], "the turn was not interrupted");
    let read = world.call(&terminal, 3, "thread/read", json!({})).await;
    assert_eq!(user_texts(&read["result"]), [prompt]);
    assert!(read["result"].to_string().contains(&answer), "the answer that landed after the detach: {read}");
}

/// call-contract case 130, state-lanes case 67: a read or a subscription of a session that does not exist is refused,
/// and nothing is created for it.
#[tokio::test(start_paused = true)]
async fn an_unknown_thread_is_refused_and_nothing_is_created() {
    let read = case("session-transport-call-contract", 130);
    let subscribe = case("session-transport-state-lanes", 67);
    assert!(read["result"]["outcome"]["error"].is_object() && subscribe["result"]["outcome"]["error"].is_object());
    assert_eq!(subscribe["result"]["runtimeCreations"], 0);
    let session = SessionRig::new();
    let directory = SessionDirectory::new(session.deps());
    for (method, missing) in [("thread/read", "agent_read_session"), ("thread/resume", "missing_session")] {
        let id = ThreadId::from(missing);
        let params = json!({ "threadId": missing, "window": { "lastItems": 10 } });
        let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") };
        assert!(directory.request(request).await.is_err(), "{method} of an unknown thread is refused");
        assert!(directory.handle(&id).is_none(), "{method}: no thread was loaded");
        assert!(session.store.records(&id).is_empty(), "{method}: nothing was written");
    }
}

/// state-lanes case 365: every attached client folds the same items, whichever of them submitted.
#[tokio::test(start_paused = true)]
async fn every_attached_client_folds_the_same_items() {
    let node = case("session-transport-state-lanes", 365);
    let world = World::started(echo()).await;
    let terminal = world.client(1);
    let desktop = world.client(2);
    world.call(&terminal, 1, "thread/resume", json!({ "window": { "lastItems": 10 } })).await;
    world.call(&desktop, 1, "thread/resume", json!({ "window": { "lastItems": 10 } })).await;
    for (n, (client, prompt)) in [(&terminal, "from terminal"), (&desktop, "from desktop")].into_iter().enumerate() {
        world.submit(client, 2 + n as i64, &format!("op-{n}"), prompt).await;
        sent_until(&terminal, |frames| turns_completed(frames).len() == n + 1).await;
        sent_until(&desktop, |frames| turns_completed(frames).len() == n + 1).await;
    }
    let folded = node_texts(&json!({ "items": step(&node, "desktop session.submit")["items"] }));
    assert_eq!(user_texts(&json!(terminal.sent())), folded, "the terminal's view");
    assert_eq!(user_texts(&json!(desktop.sent())), folded, "the desktop's view");
}

/// state-lanes case 94: a subscribed client receives the session's publications, a read answers the same items, and
/// after it unsubscribes nothing more reaches it.
#[tokio::test(start_paused = true)]
async fn an_unsubscribed_client_receives_nothing_more() {
    let node = case("session-transport-state-lanes", 94);
    assert_eq!(step(&node, "session.unsubscribe")["ok"]["unsubscribed"], true);
    assert_eq!(step(&node, "external publish after unsubscribe")["newFrames"], json!([]));
    let world = World::started(echo()).await;
    let pane = world.client(1);
    let other = world.client(2);
    world.call(&pane, 1, "thread/resume", json!({ "window": { "lastItems": 10 } })).await;
    let brief = node_texts(&step(&node, "session.subscribe")["ok"]["full"])[0].clone();
    world.submit(&pane, 2, "op-brief", &brief).await;
    let frames = sent_until(&pane, |frames| turns_completed(frames).len() == 1).await;
    assert_eq!(user_texts(&json!(frames)), [brief.clone()], "the publication reached the subscribed pane");
    assert_eq!(world.prompts(&pane, 3).await, [brief.clone()], "a read answers what was published");
    let left = world.call(&pane, 4, "thread/unsubscribe", json!({})).await;
    assert_eq!(left["result"], json!({}), "{left}");
    let before = pane.take();
    world.submit(&other, 1, "op-after", "after").await;
    world.call(&other, 2, "thread/resume", json!({ "window": { "lastItems": 10 } })).await;
    sent_until(&other, |frames| user_texts(&json!(frames)).len() == 2).await;
    assert_eq!(pane.take(), before, "nothing reached the unsubscribed pane: {:?}", &pane.sent()[before..]);
}

/// steering-recovery case 14: a submission the thread holds but has not started is handed back by its id with its text,
/// and is gone from the thread afterwards.
#[tokio::test(start_paused = true)]
async fn a_held_submission_is_reclaimed_by_its_id() {
    let node = case("session-transport-steering-recovery", 14);
    let abort = step(&node, "abort(");
    let id = abort["result"]["restoredSubmissionIds"][0].as_str().unwrap();
    let text = abort["result"]["restoreText"].as_str().unwrap();
    let world = World::idle(&[(id, text)]).await;
    let client = world.client(1);
    let stop = world.call(&client, 1, "turn/interrupt", json!({ "restorePrompt": true, "submissionId": id })).await;
    has_nodes_fields(&stop["result"], &abort["result"], "the stop");
    assert_eq!(abort["queuedLength"], 0);
    let again = world.call(&client, 2, "turn/interrupt", json!({ "submissionId": id })).await;
    assert_eq!(again["result"]["restoredSubmissionIds"], json!([]), "nothing of it is left: {again}");
}

/// steering-recovery case 75: a prompt submitted while a turn runs is kept durably with its submission id, and after a
/// restart the thread hands it back by that id with its text.
#[tokio::test(start_paused = true)]
async fn a_queued_submission_keeps_its_id_across_a_restart() {
    let node = case("session-transport-steering-recovery", 75);
    let restored = &node["result"]["restored"][0];
    let (text, submission) = (restored["text"].as_str().unwrap(), restored["submissionId"].as_str().unwrap());
    let world = World::started(until_stopped()).await;
    let client = world.client(1);
    world.submit(&client, 1, "op-run", "running").await;
    let params = json!({ "opId": "op-steer", "input": { "prompt": text, "options": { "clientSubmissionId": submission } } });
    let queued = world.call(&client, 2, "turn/start", params).await;
    assert!(queued.get("error").is_none(), "{queued}");
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

    let restarted = World::reopened(world.session, world.id.clone()).await;
    drop(world.directory);
    let client = restarted.client(1);
    let stop = restarted.call(&client, 1, "turn/interrupt", json!({ "restorePrompt": true, "submissionId": submission })).await;
    assert_eq!(stop["result"]["restoredSubmissionIds"], json!([submission]), "{stop}");
    assert_eq!(stop["result"]["restoreText"], text, "{stop}");
}

/// steering-recovery case 139: a stop sent while many reads of the same thread are in flight is answered at once.
/// Node answered all 64 reads; the core holds at most its in-flight limit of one client's ordinary calls (`Limits`, class
/// C1) and refuses the rest with `inflightLimit` before running them; the stop is not one of them.
#[tokio::test(start_paused = true)]
async fn a_stop_is_answered_while_reads_are_in_flight() {
    let node = case("session-transport-steering-recovery", 139);
    let reads = node["result"]["startedBeforeAbort"].as_u64().unwrap() as i64;
    assert_eq!(node["result"]["readOutcomes"].as_array().unwrap().iter().filter(|read| read.get("ok").is_some()).count() as i64, reads, "Node answered every read");
    let options = &node["result"]["abortOptions"][0];
    let world = World::idle(&[(options["submissionId"].as_str().unwrap(), "queued prompt")]).await;
    let client = world.client(1);
    for n in 0..reads {
        client.client.request(100 + n, "thread/read", json!({ "threadId": world.id }));
    }
    let mut stop = options.clone();
    stop["threadId"] = json!(world.id);
    client.client.request(1, "turn/interrupt", stop);
    let answered = |frames: &[Value]| frames.iter().filter(|frame| frame.get("id").is_some() && frame.get("method").is_none()).count() as i64;
    let frames = sent_until(&client, |frames| answered(frames) == reads + 1).await;
    let stop = frames.iter().find(|frame| frame["id"] == 1).unwrap();
    assert!(stop.get("error").is_none(), "{stop}");
    let refused: Vec<&Value> = frames.iter().filter(|frame| frame["id"].as_i64().is_some_and(|id| id >= 100) && frame.get("error").is_some()).collect();
    assert!(refused.iter().all(|frame| reason(frame) == "inflightLimit"), "{refused:?}");
    assert_eq!(json!(reads - refused.len() as i64), refused[0]["error"]["data"]["limit"], "the reads the core held are its limit");
    assert_eq!(node["result"]["abortCalls"], 1);
}
