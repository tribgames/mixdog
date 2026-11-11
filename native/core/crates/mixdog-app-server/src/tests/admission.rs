//! Admission by request class and its liveness rule (P §7.3, SPEC R6; §14.8).

use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use serde_json::json;

use super::Rig;
use super::settle;

fn focus(client: &super::Client, id: i64) {
    client.request(id, "terminal/focus", json!({ "tabId": format!("tab{id}"), "focused": true }));
}

/// Past its class's cap a request waits its turn and runs when a place frees, as Node queues every session call in its lane
/// with no active cap (`src/standalone/session-transport/call-lanes.mjs:11`, `:58`); `terminal/focus` is Node's interactive
/// `desktop.invoke` `termResize` (`call-lanes.mjs:41`), queued like every other call.
#[tokio::test(start_paused = true)]
async fn saturating_a_class_queues_in_arrival_order() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    let cap = 8;
    for id in 1..=cap + 2 {
        focus(&client, id);
    }
    settle().await;
    assert_eq!(rig.gate("terminal").log().len(), cap as usize, "the cap runs; the rest wait");
    assert!(client.drain().is_empty(), "nothing is refused");

    // Each freed place goes to the oldest waiting request.
    rig.gate("terminal").permits.add_permits(1);
    let first = client.frames(1).await;
    assert!(first[0].body.get("result").is_some());
    settle().await;
    // The first request's end, then the oldest waiting request (the ninth) starts in the place it freed.
    assert_eq!(rig.gate("terminal").log()[cap as usize..], ["end terminal/focus:tab1", "start terminal/focus:tab9"]);
    rig.gate("terminal").permits.add_permits(cap as usize + 1);
    let rest = client.frames(cap as usize + 1).await;
    assert!(rest.iter().all(|wire| wire.body.get("result").is_some()), "{rest:?}");
    let mut answered: Vec<i64> = first.iter().chain(&rest).map(|wire| wire.body["id"].as_i64().unwrap()).collect();
    answered.sort_unstable();
    assert_eq!(answered, (1..=cap + 2).collect::<Vec<_>>());
}

/// Only a backlog past `WAIT_BOUND` waiting requests is refused (`inflightLimit`), as Node refuses past its lane's queue
/// (`src/runtime/shared/fair-call-scheduler.mjs:105`).
#[tokio::test(start_paused = true)]
async fn a_backlog_past_the_bound_is_refused() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    let cap = 8;
    let last = cap + crate::server::WAIT_BOUND as i64 + 1;
    for id in 1..=last {
        focus(&client, id);
    }
    settle().await;
    let refused = client.drain();
    assert_eq!(refused.len(), 1, "only the one past the bound: {refused:?}");
    assert_eq!(refused[0].body["id"], json!(last));
    assert_eq!(
        refused[0].body["error"]["data"],
        json!({ "reason": "inflightLimit", "class": "C2", "limit": 8 })
    );
}

#[tokio::test(start_paused = true)]
async fn control_requests_stay_admitted_while_a_class_is_saturated() {
    let rig = Rig::gated(&["terminal"]);
    let thread = rig
        .core
        .mock
        .directory()
        .insert(ThreadId::from("t1"));
    thread.set_active_turn(Some(TurnId::from("turn1")));
    let client = rig.ready(1, json!({}));
    for id in 1..=8 {
        focus(&client, id);
    }
    focus(&client, 9);
    settle().await;
    assert!(client.drain().is_empty(), "the ninth waits");

    client.request(20, "turn/interrupt", json!({ "threadId": "t1", "turnId": "turn1" }));
    let reply = client.response(20).await;
    assert_eq!(
        reply["result"],
        json!({ "cancelRequested": true, "turnId": "turn1", "aborted": true, "restoreText": "", "pastedImages": null, "pastedTexts": null, "discardPastedImages": null, "discardPastedTexts": null, "restoredSubmissionIds": [] })
    );
}

#[tokio::test(start_paused = true)]
async fn classes_are_counted_apart() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    for id in 1..=8 {
        focus(&client, id);
    }
    // C1 has its own cap, untouched by the saturated C2.
    client.request(30, "project/list", json!({}));
    let reply = client.response(30).await;
    assert!(reply.get("result").is_some(), "{reply}");
}

/// The core is told of each admitted request for as long as its slot is held (`CoreHandle::request_started`): the daemon's lifecycle
/// counts them as Node's `inFlightWork().activeCalls`. A request waiting past the class cap holds no slot yet, so it is no call.
#[tokio::test(start_paused = true)]
async fn an_admitted_request_is_a_call_in_flight_until_its_slot_is_freed() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    assert_eq!(rig.core.mock.requests_in_flight(), 0);
    let cap = 8;
    for id in 1..=cap {
        focus(&client, id);
    }
    settle().await;
    assert_eq!(rig.gate("terminal").log().len(), cap as usize);
    assert_eq!(rig.core.mock.requests_in_flight(), cap as usize, "every admitted request is a call in flight");

    focus(&client, 9);
    settle().await;
    assert_eq!(rig.core.mock.requests_in_flight(), cap as usize, "the waiting one holds no slot");

    rig.gate("terminal").permits.add_permits(cap as usize + 1);
    let answered = client.frames(cap as usize + 1).await;
    assert!(answered.iter().all(|wire| wire.body.get("result").is_some()));
    assert_eq!(rig.core.mock.requests_in_flight(), 0, "the slots are free before the responses are written");
}