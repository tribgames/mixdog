//! A phone stopping a turn through the server (`turn/interrupt` over a real session thread): the sender of a prompt gets it back in the reply, another device stopping it gets it through the thread's `thread/promptRestore` state, and a stop of an idle thread hands back the queued submission it names.

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
use mixdog_core_session::session::testing::awaiting;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::Client;
use super::Rig;
use super::VERSION;

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
        client.request(
            10,
            "turn/start",
            json!({ "threadId": self.id, "opId": "op-submit", "input": { "prompt": prompt, "options": { "clientSubmissionId": submission } } }),
        );
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
    /// check, so a frame published in between wakes it), under a deadline on the machine's clock that leaves the paused one alone.
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
        awaiting(|| format!("the thread/promptRestore frame (frames seen: {:?})", self.prompt_restores()), wait).await
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

#[tokio::test(start_paused = true)]
async fn the_sender_stopping_gets_the_prompt_back_in_the_reply() {
    let world = World::running().await;
    let sender = world.client(1);
    world.submit(&sender, "draft", "sub1").await;
    let frame = world.interrupt(&sender, json!({})).await;
    let result = &frame["result"];
    assert_eq!((result["aborted"].clone(), result["cancelRequested"].clone()), (json!(true), json!(true)));
    assert_eq!((result["restoreText"].clone(), result["restoredSubmissionIds"].clone()), (json!("draft"), json!(["sub1"])));
    let id = result["restoreId"].as_str().expect("the reply names the hand-back's id");
    assert!(id.starts_with("restore-") && id.ends_with("-sub1"), "{id}");
    assert!(world.prompt_restores().is_empty(), "the sender is told in the reply, not through the state");
}

#[tokio::test(start_paused = true)]
async fn another_device_stopping_publishes_the_prompt_restore_through_the_state() {
    let world = World::running().await;
    let sender = world.client(1);
    let canceller = world.client(2);
    world.submit(&sender, "draft", "sub1").await;

    // The restore is stamped from the thread's clock, which the test sets.
    let clock: u64 = 7777;
    world.session.clock.0.store(clock, std::sync::atomic::Ordering::SeqCst);
    let frame = world.interrupt(&canceller, json!({})).await;
    assert_eq!(
        (frame["result"]["aborted"].clone(), frame["result"]["restoreText"].clone(), frame["result"]["restoredSubmissionIds"].clone()),
        (json!(true), json!(""), json!([]))
    );

    let frames = world.published_prompt_restores().await;
    let want = json!({ "id": "restore-7777-sub1", "ids": ["sub1"], "text": "draft", "device": "desktop-1", "at": 7777 });
    assert_eq!(frames, vec![json!({ "threadId": world.id, "value": want })]);
}

#[tokio::test(start_paused = true)]
async fn an_idle_stop_hands_back_only_the_queued_submission_it_names() {
    let queued = [("sub1".to_owned(), "queued one".to_owned()), ("sub2".to_owned(), "queued two".to_owned())];
    // (what the stop names, the reply's restored ids): nothing named and an id that is not queued hand back nothing.
    for (named, restored) in [(None, json!(null)), (Some("zz"), json!(null)), (Some("sub1"), json!(["sub1"]))] {
        let world = World::idle(&queued).await;
        let client = world.client(1);
        let extra = named.map_or_else(|| json!({}), |id| json!({ "submissionId": id }));
        let frame = world.interrupt(&client, extra).await;
        let result = &frame["result"];
        assert_eq!((result["aborted"].clone(), result["cancelRequested"].clone()), (json!(false), json!(false)), "{named:?}");
        assert!(result.get("turnId").is_none_or(Value::is_null), "an idle stop names no turn");
        let ids = result.get("restoredSubmissionIds").cloned().unwrap_or(Value::Null);
        assert_eq!(if ids == json!([]) { Value::Null } else { ids }, restored, "{named:?}");
        if named == Some("sub1") {
            assert_eq!(result["restoreText"], "queued one");
            // The other submission is still queued: a second stop names it.
            let again = world.interrupt(&client, json!({ "submissionId": "sub2" })).await;
            assert_eq!(again["result"]["restoredSubmissionIds"], json!(["sub2"]));
            let gone = world.interrupt(&client, json!({ "submissionId": "sub1" })).await;
            assert!(gone["result"].get("restoredSubmissionIds").is_none_or(|ids| ids.is_null() || ids == &json!([])), "sub1 left the queue: {gone}");
        }
    }
}
