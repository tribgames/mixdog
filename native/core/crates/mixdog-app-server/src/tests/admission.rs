//! Admission by request class and its liveness rule (P §7.3, SPEC R6; §14.8).

use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use serde_json::json;

use super::Rig;
use super::reason;
use super::settle;

fn focus(client: &super::Client, id: i64) {
    client.request(id, "terminal/focus", json!({ "tabId": format!("tab{id}") }));
}

#[tokio::test(start_paused = true)]
async fn saturating_a_class_is_answered_at_once_and_retries_ride_on_own_responses() {
    let rig = Rig::gated(&["terminal"]);
    let client = rig.ready(1, json!({}));
    let cap = 8;
    for id in 1..=cap {
        focus(&client, id);
    }
    // Every admitted request is in flight (distinct tabs run side by side).
    settle().await;
    assert_eq!(rig.gate("terminal").log().len(), cap as usize);
    assert!(client.drain().is_empty());

    // One over the cap: answered immediately, not queued.
    focus(&client, 9);
    let refused = client.drain();
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].body["id"], json!(9));
    assert_eq!(refused[0].body["error"]["code"], json!(-32001));
    assert_eq!(
        refused[0].body["error"]["data"],
        json!({ "reason": "inflightLimit", "class": "C2", "limit": 8 })
    );

    // A response to an own outstanding request frees room before it is written, so the retry
    // that response triggers is admitted.
    rig.gate("terminal").permits.add_permits(1);
    let first = client.frames(1).await;
    assert!(first[0].body.get("result").is_some());
    focus(&client, 9);
    settle().await;
    assert!(client.drain().is_empty(), "the retry was admitted and waits");
    assert_eq!(rig.gate("terminal").log().len(), cap as usize + 2);
    rig.gate("terminal").permits.add_permits(cap as usize);
    let rest = client.frames(cap as usize).await;
    assert!(rest.iter().all(|wire| wire.body.get("result").is_some()));
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
    assert_eq!(reason(&client.drain()[0].body), "inflightLimit");

    client.request(20, "turn/interrupt", json!({ "threadId": "t1", "turnId": "turn1" }));
    let reply = client.response(20).await;
    assert_eq!(
        reply["result"],
        json!({ "cancelRequested": true, "turnId": "turn1" })
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
