//! Admission through the call lanes, on the wire (`call_lanes.rs` replays the lanes themselves against Node's recording): a control
//! call is answered at once while reads wait, and a backlog past the lane's queue is refused with the message Node's lane gives.

use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use serde_json::Value;
use serde_json::json;

use super::Rig;
use super::settle;

fn focus(client: &super::Client, id: i64) {
    client.request(id, "terminal/focus", json!({ "tabId": format!("tab{id}"), "focused": true }));
}

/// The refusal Node's recording has for the 1025th call of one owner in the normal lane.
fn recorded_queue_full() -> String {
    let recording: Value = serde_json::from_str(&mixdog_testkit::fixture!("../../fixtures/session-call-lanes/golden.json")).unwrap();
    let case = recording["cases"].as_array().unwrap().iter().find(|case| case["case"] == "the normal lane refuses past its 1024 queue for one owner").unwrap();
    case["observed"]["refused"][0]["message"].as_str().unwrap().to_owned()
}

// The recorded model-proxy burst and refusal are replayed from the wire through this admission to the real
// `ModelProxyService` in model_proxy_wire.rs.

/// `config/read` is a normal-lane call (Node's `session.list` class): 1024 wait for their turn and the next is refused as Node's
/// lane refuses it; the answer is `{ error: message }` with no status.
#[tokio::test(start_paused = true)]
async fn a_backlog_past_the_lane_queue_is_refused_with_nodes_message() {
    let rig = Rig::routed(super::domain_methods(), vec![("config", &["config/read"])]);
    let client = rig.ready(1, json!({}));
    for id in 1..=1025 {
        client.request(id, "config/read", json!({}));
    }
    let refused = client.drain();
    assert_eq!(refused.len(), 1, "only the one past the queue: {refused:?}");
    assert_eq!(refused[0].body["id"], json!(1025));
    assert_eq!(refused[0].body["error"]["data"]["message"], json!(recorded_queue_full()));
}

/// A stop sent while reads wait their turn is answered before any of them has started (Node's critical lane never queues).
#[tokio::test(start_paused = true)]
async fn a_stop_is_answered_while_reads_wait_in_the_lane() {
    let rig = Rig::routed(super::domain_methods(), vec![("config", &["config/read"])]);
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    thread.set_active_turn(Some(TurnId::from("turn1")));
    let client = rig.ready(1, json!({}));
    for id in 1..=100 {
        client.request(id, "config/read", json!({}));
    }
    client.request(200, "turn/interrupt", json!({ "threadId": "t1", "turnId": "turn1" }));
    // The lane starts one read per turn of the runtime: within ten turns the stop is answered, with most reads still waiting.
    let mut answer = None;
    for _ in 0..10 {
        tokio::task::yield_now().await;
        answer = client.drain().into_iter().find(|wire| wire.body["id"] == json!(200));
        if answer.is_some() {
            break;
        }
    }
    let answer = answer.expect("the stop is answered within ten turns of the runtime").body;
    assert_eq!(answer["result"]["cancelRequested"], json!(true));
    let started = rig.gate("config").log().len();
    assert!(started <= 10, "the stop was answered after {started} of 100 reads had started");
    // The reads still run, one per turn of the lane, and every one is answered.
    rig.gate("config").permits.add_permits(100);
    let rest = client.frames(100).await;
    assert!(rest.iter().all(|wire| wire.body.get("result").is_some()), "{rest:?}");
}

/// The core is told of each started request for as long as its slot is held (`CoreHandle::request_started`): the daemon's lifecycle
/// counts them as Node's `inFlightWork().activeCalls`.
#[tokio::test(start_paused = true)]
async fn a_started_request_is_a_call_in_flight_until_its_slot_is_freed() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    assert_eq!(rig.core.mock.requests_in_flight(), 0);
    for id in 1..=8 {
        focus(&client, id);
    }
    settle().await;
    assert_eq!(rig.gate("terminal").log().len(), 8);
    assert_eq!(rig.core.mock.requests_in_flight(), 8, "every started request is a call in flight");

    rig.gate("terminal").permits.add_permits(8);
    let answered = client.frames(8).await;
    assert!(answered.iter().all(|wire| wire.body.get("result").is_some()));
    assert_eq!(rig.core.mock.requests_in_flight(), 0, "the slots are free before the responses are written");
}
