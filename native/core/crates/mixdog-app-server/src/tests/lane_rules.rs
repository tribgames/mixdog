//! The call lanes a request is admitted through: control calls never queue; the calls a person waits on queue behind a smaller
//! bound than the rest; one queue per owner, owners served in turn; past a lane's queue (or an owner's fair share) a call is refused
//! with a message naming the lane.

use crate::lanes::CallLanes;
use crate::lanes::Lane;
use crate::lanes::Placed;

fn lane(method: &str) -> Lane {
    crate::server::lane_of(crate::server::method_index().get(method).unwrap_or_else(|| panic!("no method {method}")))
}

/// Dispatches `n` calls of `owner` into `lane`; every one is expected to be seated in the queue.
fn queue(lanes: &mut CallLanes<String>, owner: &str, lane: Lane, label: &str, n: usize) {
    for k in 1..=n {
        let dispatched = lanes.dispatch(owner, lane, format!("{label}{k}"));
        assert!(dispatched.displaced.is_none() && matches!(dispatched.placed, Ok(Placed::Queued)), "{label}{k} is queued");
    }
}

/// Runs the check phases until nothing waits, each started call ending at once: the labels in the order they started.
fn drain(lanes: &mut CallLanes<String>) -> Vec<String> {
    let mut started = Vec::new();
    while lanes.wants_check() {
        for (lane, owner, label) in lanes.check_phase() {
            started.push(label);
            lanes.finished(&owner, lane);
        }
    }
    started
}

#[test]
fn the_normal_lane_refuses_the_call_past_its_queue_for_one_owner() {
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:1", Lane::Normal, "n", 1024);
    let refused = lanes.dispatch("client:1", Lane::Normal, "n1025".to_owned());
    let (label, refusal) = refused.placed.err().expect("the 1025th call is refused");
    assert_eq!((label.as_str(), refusal.message.as_str(), refusal.status), ("n1025", "session service call queue is full", 503));
    assert!(refused.displaced.is_none());
    assert_eq!(lanes.counters(Lane::Normal).queued, 1024);
}

#[test]
fn the_interactive_lane_refuses_past_a_smaller_queue() {
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:1", Lane::Interactive, "i", 512);
    let (_, refusal) = lanes.dispatch("client:1", Lane::Interactive, "i513".to_owned()).placed.err().expect("refused");
    assert_eq!((refusal.message.as_str(), refusal.status), ("session service interactive call queue is full", 503));
}

#[test]
fn the_critical_lane_queues_nothing_even_past_256_calls() {
    let mut lanes = CallLanes::<String>::new();
    for k in 0..300 {
        let placed = lanes.dispatch("client:1", Lane::Critical, format!("c{k}")).placed;
        assert!(matches!(placed, Ok(Placed::Start(_))), "call {k} starts at once");
    }
    let counters = lanes.counters(Lane::Critical);
    assert_eq!((counters.active, counters.queued), (300, 0));
    assert!(!lanes.wants_check());
}

#[test]
fn a_second_owner_takes_a_seat_in_a_full_lane_from_the_largest_borrower() {
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:a", Lane::Normal, "a", 1024);
    let seated = lanes.dispatch("client:b", Lane::Normal, "b1".to_owned());
    assert!(matches!(seated.placed, Ok(Placed::Queued)));
    let (evicted, refusal) = seated.displaced.expect("the borrower's newest call gives way");
    assert_eq!(evicted, "a1024");
    assert_eq!(refusal.message, "session service call queue rebalanced for another client; retry after running work completes");
    assert_eq!(refusal.status, 503);
    assert_eq!(lanes.counters(Lane::Normal).queued, 1024, "the seat was exchanged, not added");
}

#[test]
fn an_owner_past_its_fair_share_while_another_waits_is_refused_with_the_client_queue_message() {
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:b", Lane::Normal, "b", 1);
    // Two owners hold a queue: each may hold half of 1024.
    queue(&mut lanes, "client:a", Lane::Normal, "a", 512);
    let (label, refusal) = lanes.dispatch("client:a", Lane::Normal, "a513".to_owned()).placed.err().expect("refused");
    assert_eq!(label, "a513");
    assert_eq!(refusal.message, "session service call client queue is full; retry after this client's running work completes");
    assert_eq!(refusal.status, 429);
}

#[test]
fn owners_take_turns_one_call_per_check_phase() {
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:a", Lane::Normal, "a", 3);
    queue(&mut lanes, "client:b", Lane::Normal, "b", 2);
    let phase = lanes.check_phase();
    assert_eq!(phase.len(), 1, "a lane that yields starts one call per turn");
    let (lane, owner, label) = phase.into_iter().next().unwrap();
    assert_eq!(label, "a1");
    lanes.finished(&owner, lane);
    assert_eq!(drain(&mut lanes), ["b1", "a2", "b2", "a3"], "the owners alternate while both wait");
}

#[test]
fn an_abort_and_an_approval_start_at_once_ahead_of_the_reads_queued_before_them() {
    assert_eq!(lane("turn/interrupt"), Lane::Critical);
    assert_eq!(lane("thread/approval/answer"), Lane::Critical);
    assert_eq!(lane("config/read"), Lane::Normal);
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:a", lane("config/read"), "read", 5);
    let abort = lanes.dispatch("client:a", lane("turn/interrupt"), "abort".to_owned()).placed;
    assert!(matches!(abort, Ok(Placed::Start(label)) if label == "abort"), "the abort does not wait for the reads");
    assert_eq!(lanes.counters(Lane::Normal).queued, 5);
}

#[test]
fn an_attach_queues_in_the_interactive_lane_behind_the_calls_made_before_it() {
    assert_eq!(lane("thread/resume"), Lane::Interactive);
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "session:t", lane("turn/start"), "send", 2);
    queue(&mut lanes, "session:t", lane("thread/resume"), "attach", 1);
    assert_eq!(drain(&mut lanes), ["send1", "send2", "attach1"]);
}

#[test]
fn closing_the_lanes_refuses_what_waits_and_what_comes_later() {
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:a", Lane::Normal, "n", 2);
    queue(&mut lanes, "client:a", Lane::Interactive, "i", 1);
    let mut refused: Vec<(String, String, u16)> = lanes.close("shutting down").into_iter().map(|(label, r)| (label, r.message, r.status)).collect();
    refused.sort();
    assert_eq!(
        refused,
        [("i1".to_owned(), "shutting down".to_owned(), 503), ("n1".to_owned(), "shutting down".to_owned(), 503), ("n2".to_owned(), "shutting down".to_owned(), 503)]
    );
    let (_, later) = lanes.dispatch("client:a", Lane::Normal, "late".to_owned()).placed.err().expect("a later call is refused");
    assert_eq!((later.message.as_str(), later.status), ("session service call scheduler is closed", 503));
}

#[test]
fn the_calls_a_person_waits_on_are_interactive_and_the_control_calls_never_queue() {
    for method in ["thread/start", "thread/read", "thread/resume", "turn/start", "room/send", "project/list", "project/ensureDirectory", "terminal/ensure", "terminal/focus", "terminal/dispose", "terminal/profiles"] {
        assert_eq!(lane(method), Lane::Interactive, "{method}");
    }
    for method in ["turn/interrupt", "thread/approval/answer", "thread/approval/answerNotification", "thread/unsubscribe", "feed/unsubscribe", "initialize"] {
        assert_eq!(lane(method), Lane::Critical, "{method}");
    }
    assert_eq!(lane("config/read"), Lane::Normal);
}

#[test]
fn a_call_queued_for_its_turn_is_started_in_that_turn_whether_or_not_its_owner_is_still_there() {
    // The scheduler is keyed by an owner's name and holds no liveness: nothing removes a queued call when its client leaves, so the
    // call starts in its turn, between the calls of the owners that stay.
    let mut lanes = CallLanes::<String>::new();
    queue(&mut lanes, "client:gone", Lane::Normal, "g", 2);
    queue(&mut lanes, "client:here", Lane::Normal, "h", 2);
    assert_eq!(drain(&mut lanes), ["g1", "h1", "g2", "h2"]);
}