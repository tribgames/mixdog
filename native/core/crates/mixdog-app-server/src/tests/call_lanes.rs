//! The call lanes against Node's recording (`fixtures/session-call-lanes`, `record-session-call-lanes.mjs`: the real
//! `createCallLanes` of `call-lanes.mjs` on the real fair scheduler). Every case is replayed from the calls it recorded; the order
//! the calls start in, the refusals (in the order they were raised, with message and status) and the counters read right after the
//! enqueue and after everything settled are compared whole. A call's lane is the one Node's `callLane` recorded for its name.

use serde_json::Value;
use serde_json::json;

use crate::lanes::CallLanes;
use crate::lanes::Counters;
use crate::lanes::Lane;
use crate::lanes::Placed;

fn recording() -> Value {
    serde_json::from_str(&mixdog_testkit::fixture!("../../fixtures/session-call-lanes/golden.json")).expect("the recording")
}

fn case(name: &str) -> Value {
    recording()["cases"].as_array().unwrap().iter().find(|case| case["case"] == name).unwrap_or_else(|| panic!("no case {name}")).clone()
}

fn lane_named(name: &str) -> Lane {
    match name {
        "critical" => Lane::Critical,
        "interactive" => Lane::Interactive,
        "normal" => Lane::Normal,
        other => panic!("a lane Node does not have: {other}"),
    }
}

/// Node's `callLane(name, args)` for each call the transport routes, as recorded.
fn lane_of_call(name: &str, args: Value) -> Lane {
    let classified = case("callLane classifies every call name the transport routes");
    let entry = classified["observed"].as_array().unwrap().iter().find(|entry| entry["name"] == name && entry["args"] == args).unwrap_or_else(|| panic!("{name} {args} was not classified"));
    lane_named(entry["lane"].as_str().unwrap())
}

fn counters(lanes: &CallLanes<String>) -> Value {
    let one = |Counters { active, queued, queue_max }: Counters| json!({ "active": active, "queued": queued, "queueMax": queue_max });
    json!({ "critical": one(lanes.counters(Lane::Critical)), "interactive": one(lanes.counters(Lane::Interactive)), "normal": one(lanes.counters(Lane::Normal)) })
}

/// The recorded calls, as `(owner, call name, label)`.
fn calls(observed: &Value) -> Vec<(String, String, String)> {
    observed["calls"].as_array().unwrap().iter().map(|call| (call[0].as_str().unwrap().to_owned(), call[1].as_str().unwrap().to_owned(), call[2].as_str().unwrap().to_owned())).collect()
}

fn refused(call: &str, message: &str, status: u16) -> Value {
    json!({ "call": call, "message": message, "statusCode": status })
}

/// Node's `burst`: every call enqueued in one turn, the immediate starts run and end, then the check phases until nothing waits.
fn replay(observed: &Value) -> Value {
    let mut lanes = CallLanes::<String>::new();
    let (mut started, mut refusals, mut immediate) = (Vec::new(), Vec::new(), Vec::new());
    for (owner, name, label) in calls(observed) {
        let lane = lane_of_call(&name, json!({}));
        let dispatched = lanes.dispatch(&owner, lane, label.clone());
        if let Some((evicted, refusal)) = dispatched.displaced {
            refusals.push(refused(&evicted, &refusal.message, refusal.status));
        }
        match dispatched.placed {
            Ok(Placed::Start(label)) => immediate.push((owner, lane, label)),
            Ok(Placed::Queued) => {}
            Err((label, refusal)) => refusals.push(refused(&label, &refusal.message, refusal.status)),
        }
    }
    let after_enqueue = counters(&lanes);
    for (owner, lane, label) in immediate {
        started.push(label);
        lanes.finished(&owner, lane);
    }
    while lanes.wants_check() {
        for (lane, owner, label) in lanes.check_phase() {
            started.push(label);
            lanes.finished(&owner, lane);
        }
    }
    json!({ "calls": observed["calls"], "afterEnqueue": after_enqueue, "started": started, "refused": refusals, "afterSettled": counters(&lanes) })
}

fn replays(name: &str) {
    let recorded = case(name);
    assert_eq!(replay(&recorded["observed"]), recorded["observed"], "{name}");
}

#[test]
fn the_normal_lane_refuses_past_its_queue_for_one_owner() {
    replays("the normal lane refuses past its 1024 queue for one owner");
}

#[test]
fn a_second_owner_takes_a_seat_in_a_full_lane_from_the_largest_borrower() {
    replays("a second owner takes a seat in a full normal lane from the largest borrower");
}

#[test]
fn an_owner_past_its_fair_share_is_refused_with_the_client_queue_message() {
    replays("an owner past its fair share while another waits is refused with the client queue message");
}

#[test]
fn owners_take_turns_in_the_schedulers_order() {
    replays("owners take turns in the order the fair scheduler picks them");
}

/// A cancel and an approval answer arriving while reads are queued start at once, ahead of every queued read.
#[test]
fn an_abort_and_an_approval_start_ahead_of_the_reads_queued_before_them() {
    replays("an abort and an approval start at once ahead of the reads queued before them");
}

#[test]
fn the_critical_lane_queues_nothing() {
    replays("the critical lane queues nothing, even past 256 calls");
}

#[test]
fn the_interactive_lane_refuses_past_its_queue() {
    replays("the interactive lane refuses past its 512 queue for one owner");
}

/// The route passes no abort signal, so a call queued for a client that has gone still starts, in its turn.
#[test]
fn a_call_queued_for_a_gone_owner_still_starts() {
    replays("a call queued by an owner that has gone away still starts (the route passes no abort signal)");
}

#[test]
fn closing_the_lanes_refuses_what_waits_and_what_comes_later() {
    let recorded = case("closing the lanes refuses every queued call and any later one");
    let observed = &recorded["observed"];
    let mut lanes = CallLanes::<String>::new();
    let mut started = Vec::new();
    for (owner, name, label) in calls(observed) {
        match lanes.dispatch(&owner, lane_of_call(&name, json!({})), label).placed {
            Ok(Placed::Queued) => {}
            Ok(Placed::Start(label)) => started.push(label),
            Err(_) => panic!("nothing is refused before the close"),
        }
    }
    let refusals: Vec<Value> = lanes.close(observed["closeReason"].as_str().unwrap()).into_iter().map(|(label, refusal)| refused(&label, &refusal.message, refusal.status)).collect();
    let later = match lanes.dispatch("session:A", Lane::Normal, "late".to_owned()).placed {
        Err((_, refusal)) => json!({ "message": refusal.message, "statusCode": refusal.status }),
        Ok(_) => json!("started"),
    };
    assert_eq!(json!({ "calls": observed["calls"], "closeReason": observed["closeReason"], "started": started, "refused": refusals, "later": later }), *observed);
}

/// Node's lane of each routed call name is the lane the core gives the method the name became: the control calls never queue, the
/// calls a person waits on are interactive. The attach calls (Node's interactive `session.subscribe`) are the exception `lane_of`
/// documents: they run where they arrive.
#[test]
fn the_methods_the_node_calls_became_take_their_lanes() {
    let lane = |method: &str| crate::server::lane_of(crate::server::method_index().get(method).unwrap_or_else(|| panic!("no method {method}")));
    let term = |operation: &str| json!({ "method": operation });
    for (method, node_call, args) in [
        ("turn/interrupt", "session.abort", json!({})),
        ("thread/approval/answer", "session.approve", json!({})),
        ("thread/approval/answerNotification", "session.approve", json!({})),
        ("thread/unsubscribe", "session.unsubscribe", json!({})),
        ("feed/unsubscribe", "session.unsubscribe", json!({})),
        ("thread/start", "session.create", json!({})),
        ("thread/read", "session.read", json!({})),
        ("turn/start", "session.submit", json!({})),
        ("project/list", "project.list", json!({})),
        ("project/ensureDirectory", "project.ensureDirectory", json!({})),
        ("terminal/ensure", "desktop.invoke", term("termEnsure")),
        ("terminal/focus", "desktop.invoke", term("termResize")),
        ("terminal/dispose", "desktop.invoke", term("termDispose")),
        ("terminal/profiles", "desktop.invoke", term("termProfiles")),
        ("config/read", "session.list", json!({})),
    ] {
        assert_eq!(lane(method), lane_of_call(node_call, args), "{method} is Node's {node_call}");
    }
}
