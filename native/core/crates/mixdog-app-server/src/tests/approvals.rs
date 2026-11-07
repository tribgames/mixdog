//! Server-request fan-out, re-delivery and decisions (P §8.3–8.5; §14.9 with a mock actor).

use std::collections::HashSet;
use std::sync::Arc;

use bytes::Bytes;
use mixdog_core_api::CoreError;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::Subscribe;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::ControlCall;
use mixdog_core_api::mock::MockThread;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_core_api::thread::Decision;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use serde_json::Value;
use serde_json::json;

use super::Client;
use super::Rig;
use super::VERSION;
use super::Wire;
use super::actor::ActorThread;
use super::actor::ApprovalActor;
use super::reason;
use super::settle;

fn thread(rig: &Rig, id: &str) -> Arc<MockThread> {
    let thread = rig.core.mock.directory().insert(ThreadId::from(id));
    let feed: Arc<dyn FeedSource> = thread.feed().clone();
    thread.set_handler(Arc::new(move |_| {
        Ok(Reply::Subscribe(Subscribe {
            result: json!({}),
            feed: feed.clone(),
            window: Window::LastItems(10),
            resume_from: None,
        }))
    }));
    thread
}

async fn watch(client: &Client, id: i64, thread: &str) {
    client.request(
        id,
        "thread/resume",
        json!({ "threadId": thread, "window": { "lastItems": 10 } }),
    );
    client.response(id).await;
}

fn pending(id: &str, thread: &str, surface: &str, order: u64) -> PendingServerRequest {
    let frame = json!({
        "id": id,
        "method": "item/tool/requestApproval",
        "params": { "threadId": thread },
    });
    PendingServerRequest {
        id: ServerRequestId(id.to_owned()),
        method: Method("item/tool/requestApproval"),
        thread: ThreadId::from(thread),
        surface: ThreadId::from(surface),
        order,
        frame: Bytes::from(frame.to_string()),
    }
}

fn control(frames: Vec<super::Wire>) -> Vec<Value> {
    frames
        .into_iter()
        .filter(|wire| wire.lane.is_none())
        .map(|wire| wire.body)
        .collect()
}

fn ids(frames: &[Value]) -> Vec<&str> {
    frames
        .iter()
        .filter_map(|frame| frame["id"].as_str())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_request_reaches_subscribers_of_its_thread_or_surface_and_inbox_connections() {
    let rig = Rig::new();
    let _t1 = thread(&rig, "t1");
    let _t2 = thread(&rig, "t2");
    let on_thread = rig.ready(1, json!({}));
    watch(&on_thread, 1, "t1").await;
    let on_surface = rig.ready(2, json!({}));
    watch(&on_surface, 1, "t2").await;
    let inbox = rig.ready(3, json!({ "approvalsInbox": true }));
    let bystander = rig.ready(4, json!({}));

    // A sub-agent's request, shown on the chat that spawned it.
    rig.outgoing.publish(pending("ap1", "t1-sub", "t2", 1));
    assert_eq!(ids(&control(on_thread.drain())), Vec::<&str>::new());
    assert_eq!(ids(&control(on_surface.drain())), ["ap1"]);
    assert_eq!(ids(&control(inbox.drain())), ["ap1"]);
    assert!(bystander.drain().is_empty());

    rig.outgoing.publish(pending("ap2", "t1", "t1", 2));
    assert_eq!(ids(&control(on_thread.drain())), ["ap2"]);
    assert_eq!(ids(&control(on_surface.drain())), Vec::<&str>::new());
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_becomes_eligible_later_gets_pending_requests_after_its_attach_response() {
    let rig = Rig::new();
    let _thread = thread(&rig, "t1");
    rig.outgoing.publish(pending("ap1", "t1", "t1", 1));
    rig.outgoing.publish(pending("ap2", "t1", "t1", 2));

    let late = rig.ready(1, json!({}));
    late.request(
        1,
        "thread/resume",
        json!({ "threadId": "t1", "window": { "lastItems": 10 } }),
    );
    let frames = late.frames(3).await;
    let control = control(frames);
    assert_eq!(control.len(), 3);
    assert_eq!(control[0]["id"], json!(1), "the attach response goes first");
    assert_eq!(ids(&control[1..]), ["ap1", "ap2"], "then the pending requests in request order");

    // Delivery is once per connection: another subscription does not repeat it.
    watch(&late, 2, "t1").await;
    assert!(late.drain().is_empty());
}

#[tokio::test]
async fn an_inbox_connection_gets_pending_requests_right_after_initialize() {
    let rig = Rig::new();
    rig.outgoing.publish(pending("ap1", "t1", "t1", 1));
    let phone = rig.connect(1, mixdog_protocol::Origin::Local);
    phone.initialize(VERSION, json!({ "approvalsInbox": true }));
    let control = control(phone.drain());
    assert_eq!(control[0]["id"], json!(0));
    assert_eq!(ids(&control[1..]), ["ap1"]);
}

#[tokio::test(start_paused = true)]
async fn a_decision_goes_to_the_owning_thread_and_only_from_a_connection_that_has_the_request() {
    let rig = Rig::new();
    let owner = thread(&rig, "t1");
    let viewer = rig.ready(1, json!({}));
    watch(&viewer, 1, "t1").await;
    let bystander = rig.ready(2, json!({}));
    rig.outgoing.publish(pending("ap1", "t1", "t1", 1));
    viewer.drain();

    // Not delivered to the bystander: its answer is not a decision.
    bystander.send(json!({ "id": "ap1", "result": { "approved": true } }));
    // An error response does not resolve the request; neither does an unknown id.
    viewer.send(json!({ "id": "ap1", "error": { "code": -32000, "message": "dismissed" } }));
    viewer.send(json!({ "id": "unknown", "result": {} }));
    settle().await;
    assert_eq!(owner.control_calls(), Vec::<ControlCall>::new());

    viewer.send(json!({ "id": "ap1", "result": { "approved": true } }));
    assert_eq!(
        owner.control_calls(),
        [ControlCall::Decide(Decision {
            request: ServerRequestId("ap1".to_owned()),
            connection: ConnectionId(1),
            device: "test".to_owned(),
            connection_kind: ConnectionKind::Desktop,
            result: json!({ "approved": true }),
        })]
    );
}

/// A thread whose control plane is a mock session actor, loaded in the core.
fn actor(rig: &Rig, id: &str) -> Arc<ActorThread> {
    let handle = Arc::new(ActorThread {
        thread: thread(rig, id),
        actor: ApprovalActor::new(id, rig.outgoing.clone()),
    });
    rig.core.load(id, handle.clone());
    handle
}

/// The `serverRequest/resolved` params among the control frames, in arrival order.
fn resolved(frames: Vec<Wire>) -> Vec<Value> {
    control(frames)
        .into_iter()
        .filter(|frame| frame["method"] == json!("serverRequest/resolved"))
        .map(|frame| frame["params"].clone())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_answers_one_wins_and_every_connection_hears_the_winners_device() {
    const CLIENTS: u64 = 8;
    const ROUNDS: usize = 25;
    let kinds = [ConnectionKind::Desktop, ConnectionKind::Phone];
    let rig = Rig::new();
    let owner = actor(&rig, "t1");
    let mut clients = Vec::new();
    for n in 0..CLIENTS {
        let kind = serde_json::to_value(kinds[n as usize % 2]).unwrap();
        let client = rig.ready_as(n + 1, &format!("dev-{n}"), kind.as_str().unwrap());
        watch(&client, 1, "t1").await;
        clients.push(client);
    }

    for round in 0..ROUNDS {
        let id = format!("ap{round}");
        owner.actor.ask(&id, "t1", &[], None);
        for client in &clients {
            assert_eq!(ids(&control(client.drain())), [id.as_str()]);
        }

        // Every connection answers at the same instant, from its own thread.
        let barrier = std::sync::Barrier::new(clients.len());
        std::thread::scope(|scope| {
            for (n, client) in clients.iter().enumerate() {
                let (barrier, id) = (&barrier, &id);
                scope.spawn(move || {
                    barrier.wait();
                    client.send(json!({ "id": id, "result": { "approved": n % 2 == 0 } }));
                });
            }
        });

        // One decision was persisted, and it is the winner's own answer under its own device.
        let records: Vec<_> = owner
            .actor
            .resolutions()
            .into_iter()
            .filter(|(request, _)| request.0 == id)
            .collect();
        assert_eq!(records.len(), 1, "exactly one decision wins {id}");
        let ApprovalResolution::Decided {
            decision,
            device,
            connection_kind,
            ..
        } = &records[0].1
        else {
            panic!("not decided: {records:?}");
        };
        let winner: usize = device.strip_prefix("dev-").unwrap().parse().unwrap();
        assert_eq!(decision.approved, winner.is_multiple_of(2));
        assert_eq!(*connection_kind, kinds[winner % 2]);

        // Everyone, losers included, hears it once, naming that device.
        for client in &clients {
            let heard = resolved(client.drain());
            assert_eq!(heard.len(), 1, "one resolution per connection");
            assert_eq!(heard[0]["threadId"], json!("t1"));
            assert_eq!(heard[0]["requestId"], json!(id));
            let resolution = &heard[0]["resolution"];
            assert_eq!(resolution["kind"], json!("decided"));
            assert_eq!(resolution["device"], json!(device));
            assert_eq!(
                resolution["connectionKind"],
                serde_json::to_value(connection_kind).unwrap()
            );
        }
    }
    assert_eq!(owner.actor.pending(), 0);
}

#[tokio::test(start_paused = true)]
async fn an_invalid_decision_leaves_the_request_pending_and_only_its_sender_hears_of_it() {
    let rig = Rig::new();
    let owner = actor(&rig, "t1");
    let phone = rig.ready_as(1, "phone-a", "phone");
    watch(&phone, 1, "t1").await;
    let desktop = rig.ready_as(2, "desk-b", "desktop");
    watch(&desktop, 1, "t1").await;
    owner
        .actor
        .ask("ap1", "t1", &[ApprovalRemember::Session], None);
    phone.drain();
    desktop.drain();

    // Does not decode; and a scope the request does not offer.
    phone.send(json!({ "id": "ap1", "result": { "approved": "maybe" } }));
    phone.send(json!({ "id": "ap1", "result": { "approved": true, "remember": "always" } }));
    let errors = control(phone.drain());
    assert_eq!(errors.len(), 2);
    for error in &errors {
        assert_eq!(error["method"], json!("error"));
        let data = &error["params"]["error"]["data"];
        assert_eq!(data["reason"], json!("invalidServerRequestResponse"));
        assert_eq!(data["requestId"], json!("ap1"));
    }
    assert!(desktop.drain().is_empty(), "other connections hear nothing");
    assert_eq!(owner.actor.pending(), 1);
    assert!(owner.actor.resolutions().is_empty());

    // An offered scope is a valid decision, and it wins under the sender's device.
    phone.send(json!({ "id": "ap1", "result": { "approved": true, "remember": "session" } }));
    // The other device answers a moment later: a no-op, not an error.
    desktop.send(json!({ "id": "ap1", "result": { "approved": false } }));
    assert_eq!(owner.actor.resolutions().len(), 1);
    for client in [&phone, &desktop] {
        let frames = client.drain();
        assert!(frames.iter().all(|wire| wire.body["method"] != json!("error")));
        let heard = resolved(frames);
        assert_eq!(heard.len(), 1);
        assert_eq!(heard[0]["resolution"]["device"], json!("phone-a"));
        assert_eq!(heard[0]["resolution"]["connectionKind"], json!("phone"));
    }
}

#[tokio::test(start_paused = true)]
async fn a_request_that_outlives_its_expiry_resolves_timed_out_for_everyone() {
    let rig = Rig::new();
    let owner = actor(&rig, "t1");
    let viewer = rig.ready(1, json!({}));
    watch(&viewer, 1, "t1").await;
    let inbox = rig.ready(2, json!({ "approvalsInbox": true }));
    owner.actor.ask("ap1", "t1", &[], Some(100));
    viewer.drain();
    inbox.drain();

    owner.actor.expire(99);
    assert!(viewer.drain().is_empty(), "not yet due");
    assert_eq!(owner.actor.pending(), 1);

    owner.actor.expire(100);
    for client in [&viewer, &inbox] {
        let heard = resolved(client.drain());
        assert_eq!(heard.len(), 1);
        assert_eq!(heard[0]["requestId"], json!("ap1"));
        assert_eq!(heard[0]["resolution"], json!({ "kind": "timedOut", "at": 100 }));
    }

    // Answering afterwards changes nothing, and a late joiner is not offered it.
    viewer.send(json!({ "id": "ap1", "result": { "approved": true } }));
    assert_eq!(owner.actor.resolutions().len(), 1);
    assert!(viewer.drain().is_empty());
    let late = rig.ready(3, json!({ "approvalsInbox": true }));
    assert!(late.drain().is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_abort_resolves_only_the_threads_own_requests() {
    let rig = Rig::new();
    let parent = actor(&rig, "t1");
    let child = actor(&rig, "t1-sub");
    parent.thread.set_active_turn(Some(TurnId::from("turn1")));
    let viewer = rig.ready_as(1, "desk", "desktop");
    watch(&viewer, 1, "t1").await;
    let child_view = rig.ready(2, json!({}));
    watch(&child_view, 1, "t1-sub").await;
    parent.actor.ask("ap1", "t1", &[], None);
    // A sub-agent's request, shown on the chat that spawned it.
    child.actor.ask("ap2", "t1", &[], None);
    assert_eq!(ids(&control(viewer.drain())), ["ap1", "ap2"]);
    child_view.drain();

    viewer.request(2, "turn/interrupt", json!({ "threadId": "t1", "turnId": "turn1" }));
    // The response and the resolution, in whichever order the core produced them.
    let heard = resolved(viewer.frames(2).await);
    assert_eq!(heard.len(), 1, "only the aborted thread's own request resolves");
    assert_eq!(heard[0]["requestId"], json!("ap1"));
    assert_eq!(heard[0]["resolution"]["kind"], json!("interrupted"));
    assert!(resolved(child_view.drain()).is_empty());
    assert_eq!(child.actor.pending(), 1);
    assert!(child.actor.resolutions().is_empty());

    // The delegated copy is still open to an answer from the parent's surface.
    viewer.send(json!({ "id": "ap2", "result": { "approved": true } }));
    let heard = resolved(viewer.drain());
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0]["requestId"], json!("ap2"));
    assert_eq!(heard[0]["resolution"]["kind"], json!("decided"));
    assert_eq!(heard[0]["resolution"]["device"], json!("desk"));
    assert_eq!(child.actor.resolutions().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_core_restart_while_waiting_interrupts_every_open_request() {
    let rig = Rig::new();
    let parent = actor(&rig, "t1");
    let child = actor(&rig, "t1-sub");
    let viewer = rig.ready(1, json!({}));
    watch(&viewer, 1, "t1").await;
    let inbox = rig.ready(2, json!({ "approvalsInbox": true }));
    parent.actor.ask("ap1", "t1", &[], None);
    child.actor.ask("ap2", "t1", &[], None);
    viewer.drain();
    inbox.drain();

    // Recovery of the interrupted turns resolves what the dead core left waiting.
    parent.actor.interrupt();
    child.actor.interrupt();
    for client in [&viewer, &inbox] {
        let heard = resolved(client.drain());
        let kinds: Vec<_> = heard
            .iter()
            .map(|params| {
                (
                    params["requestId"].as_str().unwrap().to_owned(),
                    params["resolution"]["kind"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("ap1".to_owned(), "interrupted".to_owned()),
                ("ap2".to_owned(), "interrupted".to_owned())
            ]
        );
    }
    assert_eq!(parent.actor.pending() + child.actor.pending(), 0);

    // Nothing is left to re-deliver, and a stale answer does nothing.
    let after = rig.ready(3, json!({ "approvalsInbox": true }));
    assert!(after.drain().is_empty());
    viewer.send(json!({ "id": "ap1", "result": { "approved": true } }));
    assert_eq!(parent.actor.resolutions().len(), 1);
}

#[tokio::test]
async fn a_request_published_while_the_handshake_is_unanswered_follows_the_initialize_response() {
    let rig = Rig::new();
    let outgoing = rig.outgoing.clone();
    // The publish lands after `initialize` latched the session and before its response is
    // queued: the connection must not be offered the request yet.
    let phone = rig.connect_hooked(1, move || {
        outgoing.publish(pending("ap1", "t1", "t1", 1));
    });
    phone.initialize(VERSION, json!({ "approvalsInbox": true }));
    let frames = control(phone.drain());
    assert_eq!(frames[0]["id"], json!(0), "the initialize response goes first: {frames:?}");
    assert_eq!(ids(&frames[1..]), ["ap1"], "then the request, once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_publishes_never_overtake_an_initialize_response() {
    const REQUESTS: usize = 200;
    const CONNECTIONS: u64 = 60;
    let rig = Rig::new();
    let clients: Vec<Client> = std::thread::scope(|scope| {
        let publisher = scope.spawn(|| {
            for n in 0..REQUESTS {
                rig.outgoing
                    .publish(pending(&format!("ap{n}"), "t1", "t1", n as u64));
            }
        });
        let clients = (1..=CONNECTIONS)
            .map(|id| {
                let client = rig.connect(id, mixdog_protocol::Origin::Local);
                client.initialize(VERSION, json!({ "approvalsInbox": true }));
                client
            })
            .collect();
        publisher.join().unwrap();
        clients
    });
    for client in &clients {
        let frames = control(client.drain());
        assert_eq!(frames[0]["id"], json!(0), "the response goes first");
        let delivered: HashSet<&str> = ids(&frames[1..]).into_iter().collect();
        assert_eq!(frames.len() - 1, REQUESTS, "every request once");
        assert_eq!(delivered.len(), REQUESTS, "no request twice");
    }
}

#[tokio::test]
async fn a_rejected_response_is_an_error_notification_to_the_sender_only() {
    let rig = Rig::new();
    let sender = rig.ready(1, json!({}));
    let other = rig.ready(2, json!({}));
    rig.outgoing.response_rejected(
        ConnectionId(1),
        CoreError::InvalidServerRequestResponse {
            request_id: ServerRequestId("ap1".to_owned()),
            detail: "unknown decision".into(),
        },
    );
    let frames = control(sender.drain());
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["method"], json!("error"));
    assert!(frames[0].get("id").is_none());
    assert_eq!(reason(&json!({ "error": frames[0]["params"]["error"] })), "invalidServerRequestResponse");
    assert_eq!(frames[0]["params"]["error"]["data"]["requestId"], json!("ap1"));
    assert!(other.drain().is_empty());
}

#[tokio::test(start_paused = true)]
async fn pending_requests_survive_a_disconnect() {
    let rig = Rig::new();
    let owner = thread(&rig, "t1");
    {
        let gone = rig.ready(1, json!({}));
        watch(&gone, 1, "t1").await;
        rig.outgoing.publish(pending("ap1", "t1", "t1", 1));
    }
    let back = rig.ready(2, json!({}));
    back.request(
        1,
        "thread/resume",
        json!({ "threadId": "t1", "window": { "lastItems": 10 } }),
    );
    let control = control(back.frames(2).await);
    assert_eq!(ids(&control[1..]), ["ap1"]);
    back.send(json!({ "id": "ap1", "result": { "approved": false } }));
    assert_eq!(owner.control_calls().len(), 1);
}
