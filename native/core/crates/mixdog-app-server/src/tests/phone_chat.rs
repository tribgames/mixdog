//! The phone's Chat calls through the server (PH-2): a `turn/interrupt` frame reaching a real session thread and the
//! reply it puts on the wire, against what Node's `abortSession` answered (`fixtures/phone-chat-core/phone-chat-core.json`,
//! recorded by `record-phone-chat-core.mjs`). Each recorded case is replayed on connections that name Node's devices.

use std::sync::Arc;

use mixdog_core_api::CallContext;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig as SessionRig;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::Client;
use super::Rig;
use super::VERSION;

const RECORDED: &str = include_str!("../../../../fixtures/phone-chat-core/phone-chat-core.json");

fn recorded(name: &str) -> Value {
    let all: Value = serde_json::from_str(RECORDED).unwrap();
    all["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap_or_else(|| panic!("no recorded case {name}")).clone()
}

/// Node's device names, as the wire names them: connection 1 is "PC" and connection 2 is "Phone" (`NamedDevices`
/// describes connection n as `desktop-n`).
fn wire_device(node: &str) -> &'static str {
    match node {
        "PC" => "desktop-1",
        "Phone" => "desktop-2",
        other => panic!("no connection stands for the recorded device {other}"),
    }
}

fn connection_of(node: &str) -> u64 {
    if node == "PC" { 1 } else { 2 }
}

struct World {
    /// Held: a thread answers a start only while its directory is alive.
    _directory: Arc<SessionDirectory>,
    server: Rig,
    session: SessionRig,
    id: ThreadId,
}

impl World {
    /// A server over one real session thread whose run waits until it is stopped.
    async fn running() -> Self {
        let session = SessionRig::new();
        session.set_script(Arc::new(|run| {
            Box::pin(async move {
                run.cancel.cancelled().await;
                RunOutcome::Interrupted
            })
        }));
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
        Self::serving(session, &directory, id)
    }

    /// A server over an idle thread that already holds `queued` `(submission id, text)` entries in its durable queue.
    async fn idle(queued: &[(String, String)]) -> Self {
        let session = SessionRig::new();
        let id = ThreadId::from("sess_idle");
        let creator = SessionDirectory::new(session.deps());
        creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
        let entries = queued
            .iter()
            .map(|(qid, text)| {
                serde_json::from_value::<Record>(json!({
                    "k": "queue", "qid": qid, "action": "enqueue",
                    "entry": { "inline": { "message": text, "enqueuedAt": 1, "priority": "next", "options": { "clientSubmissionId": qid } } },
                }))
                .expect("queue record")
            })
            .collect();
        session.store.seed(&id, entries);
        let directory = Arc::new(SessionDirectory::new(session.deps()));
        directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        Self::serving(session, &directory, id)
    }

    fn serving(session: SessionRig, directory: &Arc<SessionDirectory>, id: ThreadId) -> Self {
        let server = Rig::new();
        server.core.load(id.as_str(), directory.handle(&id).expect("loaded"));
        Self { _directory: directory.clone(), server, session, id }
    }

    fn client(&self, connection: u64) -> Client {
        self.server.ready_as(connection, if connection == 1 { "PC" } else { "Phone" }, "desktop")
    }

    async fn submit(&self, client: &Client, prompt: &str, submission: &str) -> Value {
        client
            .request(10, "turn/start", json!({ "threadId": self.id, "opId": "op-submit", "input": { "prompt": prompt, "options": { "clientSubmissionId": submission } } }));
        let frame = client.response(10).await;
        assert_eq!(frame["result"]["kind"], "started", "{frame}");
        frame
    }

    /// `turn/interrupt` as the client sends it for `abortSession`: no turn named.
    async fn interrupt(&self, client: &Client, extra: Value) -> Value {
        let mut params = json!({ "threadId": self.id });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        client.request(11, "turn/interrupt", params);
        client.response(11).await
    }

    /// The first `thread/promptRestore` frames the thread publishes: waits on the feeds' own signal (registered before each
    /// check, so a frame published in between wakes it), under a virtual deadline that fires only when nothing can publish one.
    async fn published_prompt_restores(&self) -> Vec<Value> {
        let published = self.session.feeds.published.clone();
        let wait = async {
            loop {
                let notified = published.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let found = self.prompt_restores();
                if !found.is_empty() {
                    return found;
                }
                notified.await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(60), wait).await.expect("promptRestore was published")
    }

    /// The `thread/promptRestore` state frames the thread published, oldest first.
    fn prompt_restores(&self) -> Vec<Value> {
        let mut found = Vec::new();
        for (_, method, value) in self.session.feeds.frames(self.id.as_str()) {
            if method == "thread/promptRestore" {
                found.push(value);
            }
        }
        found
    }
}

/// Every key Node's reply carries comes back with Node's value; the wire adds `cancelRequested` and `turnId`.
fn assert_node_reply(wire: &Value, node: &Value, name: &str) {
    for (key, want) in node.as_object().unwrap() {
        assert_eq!(&wire[key], want, "{name}: {key} of {wire}");
    }
    // Beyond Node's fields the wire adds `cancelRequested` and `turnId`.
    for (key, value) in wire.as_object().unwrap() {
        if !node.as_object().unwrap().contains_key(key) && !["cancelRequested", "turnId"].contains(&key.as_str()) {
            // Node answers a bare alse (the host maps it to {aborted: false}) where nothing was handed back; the wire spells that out as empty fields.
            assert!(value.is_null() || value == "" || value == &json!([]), "{name}: {key} of {wire} is not in Node's reply");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn the_sender_stopping_gets_the_prompt_back_in_the_wire_reply_as_nodes_abort_session_does() {
    let case = recorded("own device, prompt handed back");
    let world = World::running().await;
    let device = case["submit"]["transcriptMeta"]["device"].as_str().unwrap();
    let sender = world.client(connection_of(device));
    world.submit(&sender, case["prompt"].as_str().unwrap(), case["submit"]["id"].as_str().unwrap()).await;

    let frame = world.interrupt(&sender, json!({})).await;
    assert_node_reply(&frame["result"], &case["result"], "own device");
    assert_eq!(frame["result"]["cancelRequested"], true);
    assert!(world.prompt_restores().is_empty(), "the sender is told in the reply, not through the state");
}

#[tokio::test(start_paused = true)]
async fn another_device_stopping_publishes_prompt_restore_with_nodes_fields() {
    let case = recorded("another device cancels: the prompt travels through the state");
    let world = World::running().await;
    let sender_device = case["submit"]["transcriptMeta"]["device"].as_str().unwrap();
    let canceller_device = case["options"]["device"].as_str().unwrap();
    assert_ne!(sender_device, canceller_device);
    let sender = world.client(connection_of(sender_device));
    let canceller = world.client(connection_of(canceller_device));
    world.submit(&sender, case["prompt"].as_str().unwrap(), case["submit"]["id"].as_str().unwrap()).await;

    let frame = world.interrupt(&canceller, json!({})).await;
    assert_node_reply(&frame["result"], &case["result"], "another device");

    let node = &case["after"]["promptRestore"];
    let frames = world.published_prompt_restores().await;
    // Node's one published restore, whole; the clock (Node's fake 1700000000450, in `at` and in the id `restore-<clock>-<first
    // submission id>`) and the device name (`wire_device`) are the rig's.
    let mut want = node.clone();
    let at = frames[0]["value"]["at"].clone();
    want["id"] = json!(format!("restore-{at}-{}", node["ids"][0].as_str().unwrap()));
    want["at"] = at;
    want["device"] = json!(wire_device(node["device"].as_str().unwrap()));
    assert_eq!(frames.into_iter().map(|mut frame| { frame.as_object_mut().unwrap().remove("threadId"); frame }).collect::<Vec<_>>(), vec![json!({ "value": want })]);
}

#[tokio::test(start_paused = true)]
async fn an_idle_stop_answers_nodes_aborted_false_and_hands_back_the_named_queued_submission() {
    for name in ["nothing queued", "no id names nothing", "an id that is not queued", "a queued submission is handed back by its id"] {
        let case = recorded(name);
        let queued: Vec<(String, String)> =
            case["queue"].as_array().unwrap().iter().map(|entry| (entry["id"].as_str().unwrap().to_owned(), entry["text"].as_str().unwrap().to_owned())).collect();
        let world = World::idle(&queued).await;
        let client = world.client(1);
        let extra = match case["abortOptions"]["submissionId"].as_str() {
            Some(id) => json!({ "submissionId": id }),
            None => json!({}),
        };
        let frame = world.interrupt(&client, extra).await;
        assert_node_reply(&frame["result"], &case["reply"], name);
        assert_eq!(frame["result"]["cancelRequested"], false, "{name}");
        assert!(frame["result"].get("turnId").is_none(), "{name}: an idle stop names no turn");
        // What Node's queue held afterwards is what the thread still holds (a second stop names the entry that is left).
        let left = case["after"]["queued"].as_array().unwrap();
        for (position, entry) in left.iter().enumerate() {
            let id = &entry["id"];
            let again = world.interrupt(&client, json!({ "submissionId": id })).await;
            assert_eq!(again["result"]["restoredSubmissionIds"], json!([id]), "{name}: entry {position} was still queued");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_turn_that_is_not_the_running_one_is_refused_and_a_thread_that_is_not_loaded_is_idle() {
    let world = World::running().await;
    let sender = world.client(1);
    world.submit(&sender, "draft", "sub1").await;
    let wrong = world.interrupt(&sender, json!({ "turnId": "not-the-running-turn" })).await;
    assert!(wrong.get("error").is_some(), "{wrong}");
    assert_eq!(world.interrupt(&sender, json!({})).await["result"]["restoreText"], "draft");

    sender.request(12, "turn/interrupt", json!({ "threadId": "sess_unknown" }));
    let reply = sender.response(12).await;
    assert_eq!((reply["result"]["cancelRequested"].clone(), reply["result"]["aborted"].clone()), (json!(false), json!(false)));
    let _ = VERSION;
}
