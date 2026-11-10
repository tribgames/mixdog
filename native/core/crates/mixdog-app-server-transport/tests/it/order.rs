//! Write order on one connection (Lead decision 2026-11-11): no text frame is written before a
//! frame queued earlier, except a ping (first) and a lagged lane's recovery snapshot (merged
//! state, which may land later). Node's rule and its recording: `fixtures/frame-order`
//! (`record-frame-order.mjs`). Time here is the hub's tick counter, moved only by
//! `heartbeat_tick`; every wait is on a frame reaching the socket, under a deadline naming it.

use crate::common;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use bytes::Bytes;
use common::Peer;
use common::Wire;
use common::connect;
use common::install_rt;
use common::small_limits;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_core_api::sink::Lane;
use mixdog_core_api::sink::LaneRecovery;
use mixdog_core_api::sink::Reservation;
use mixdog_core_api::sink::SnapshotSlot;
use serde_json::Value;

/// How long one awaited frame may take before the test fails naming it (a failure bound only).
const DEADLINE: Duration = Duration::from_secs(10);

struct NoRecovery;

impl LaneRecovery for NoRecovery {
    fn recover(&self, _: SubscriptionId, _: Reservation) {}
}

/// Opens `name` (ordered or not) and writes its response: the lane is live.
async fn live_lane(peer: &mut Peer, name: &str, ordered: bool, recovery: Arc<dyn LaneRecovery>) -> Arc<dyn Lane> {
    let sink = &peer.connection.sink;
    let sub = SubscriptionId::from(name);
    let (lane, release) = if ordered {
        sink.open_ordered_lane(sub, recovery).unwrap()
    } else {
        sink.open_lane(sub, recovery).unwrap()
    };
    let response = format!("opened {name}");
    sink.send_control_release(Bytes::from(response.clone()), release).unwrap();
    allow_up_to(peer, 1);
    assert_eq!(texts(next_items(peer, 1, &response).await), [response]);
    lane
}

fn push(lane: &Arc<dyn Lane>, text: &str) {
    let reservation = lane.try_reserve(text.len()).expect("room for the frame");
    lane.push(reservation, Bytes::from(text.to_owned()));
}

fn answer(peer: &Peer, text: &str) {
    peer.connection.sink.send_control(Bytes::from(text.to_owned())).unwrap();
}

/// The next `n` wire items, each awaited under [`DEADLINE`].
async fn next_items(peer: &mut Peer, n: usize, what: &str) -> Vec<Wire> {
    let mut items = Vec::new();
    while items.len() < n {
        let item = tokio::time::timeout(DEADLINE, peer.wire.recv())
            .await
            .unwrap_or_else(|_| panic!("{what}: wire item {} of {n} not written within {DEADLINE:?}", items.len() + 1))
            .expect("socket still open");
        items.push(item);
    }
    items
}

/// Everything written until `marker` (the last thing the test queued), inclusive.
async fn until_marker(peer: &mut Peer, marker: &str) -> Vec<Wire> {
    allow_up_to(peer, usize::MAX >> 4);
    let mut items = Vec::new();
    loop {
        let item = next_items(peer, 1, &format!("the marker {marker}")).await.remove(0);
        let done = item == Wire::Text(marker.to_owned());
        items.push(item);
        if done {
            return items;
        }
    }
}

/// Lets at least `n` more writes through (a prompt peer already lets every write through).
fn allow_up_to(peer: &Peer, n: usize) {
    if peer.gate.available_permits() < n {
        peer.allow(n - peer.gate.available_permits());
    }
}

fn texts(wire: Vec<Wire>) -> Vec<String> {
    wire.into_iter()
        .map(|item| match item {
            Wire::Text(text) => text,
            other => panic!("expected a text frame, got {other:?}"),
        })
        .collect()
}

fn hub_and_peer(writable: bool) -> (ConnectionHub, Peer) {
    install_rt();
    let hub = ConnectionHub::new(small_limits()).unwrap();
    let peer = connect(&hub, ConnectionOrigin::Loopback, writable);
    (hub, peer)
}

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/frame-order/golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the frame-order recording")).expect("JSON")
}

/// Node's terminal close (`fixtures/frame-order`, scenario `terminal-dispose`): the activity
/// frame (an ordered-class event, `remote-relay-push-lanes.ts:148-150`) is queued while the call
/// is handled, the answer after it, then the marker's answer. For every recorded mode and run the
/// writer must put on the socket exactly what the phone got, in that order, for a prompt reader
/// and for one that reads nothing until all three are queued.
#[tokio::test]
async fn an_event_of_the_ordered_class_queued_before_an_answer_is_written_before_it() {
    let golden = golden();
    let modes = golden["scenarios"]["terminal-dispose"]["modes"].as_object().expect("modes");
    assert_eq!(modes.len(), 4, "transport and legacy, each prompt and stalled");
    for (mode, recorded) in modes {
        for run in recorded["runs"].as_array().expect("runs") {
            let frames: Vec<String> = run["frames"].as_array().expect("frames").iter().map(Value::to_string).collect();
            let kinds: Vec<&str> = frames
                .iter()
                .map(|frame| {
                    let frame: Value = serde_json::from_str(frame).unwrap();
                    if frame["id"] == run["cause"] || frame["id"] == run["marker"] { "answer" } else { "event" }
                })
                .collect();
            let (_hub, mut peer) = hub_and_peer(mode.ends_with("prompt"));
            let activity = live_lane(&mut peer, "terminal-activity", true, Arc::new(NoRecovery)).await;
            // Queued in Node's queue order: the event during the call, then the answers.
            for (frame, kind) in frames.iter().zip(&kinds) {
                if *kind == "event" {
                    push(&activity, frame);
                } else {
                    answer(&peer, frame);
                }
            }
            let wire = texts(until_marker(&mut peer, frames.last().expect("a marker")).await);
            assert_eq!(wire, frames, "{mode}: the writer's order is not the order Node's phone got");
        }
    }
}

/// An answer queued after feed frames of its own lane and of another lane is written after all of
/// them, in queue order, and so is a later frame after the answer.
#[tokio::test]
async fn an_answer_is_written_after_the_frames_queued_before_it_and_before_later_ones() {
    for writable in [true, false] {
        let (_hub, mut peer) = hub_and_peer(writable);
        let a = live_lane(&mut peer, "a", false, Arc::new(NoRecovery)).await;
        let b = live_lane(&mut peer, "b", true, Arc::new(NoRecovery)).await;
        let mut queued = Vec::new();
        for (lane, text) in [(Some(&a), "a1"), (Some(&b), "b1"), (Some(&a), "a2"), (None, "answer"), (Some(&b), "b2"), (Some(&a), "a3"), (None, "marker")] {
            match lane {
                Some(lane) => push(lane, text),
                None => answer(&peer, text),
            }
            queued.push(text.to_owned());
        }
        assert_eq!(texts(until_marker(&mut peer, "marker").await), queued, "writable={writable}");
    }
}

/// Recovery that pushes the recovery slot and keeps it unfilled until the test fills it.
struct HeldRecovery {
    lane: OnceLock<Arc<dyn Lane>>,
    slots: Mutex<Vec<SnapshotSlot>>,
    asked: tokio::sync::mpsc::UnboundedSender<()>,
}

impl LaneRecovery for HeldRecovery {
    fn recover(&self, _: SubscriptionId, reservation: Reservation) {
        let slot = self.lane.get().expect("lane set").push_slot(reservation);
        self.slots.lock().unwrap().push(slot);
        self.asked.send(()).unwrap();
    }
}

/// D2: an answer does not wait for a lagged lane's recovery snapshot (merged state); frames of other
/// lanes queued before it still go first, and the snapshot follows once it exists.
#[tokio::test]
async fn an_answer_does_not_wait_for_a_lagged_lanes_recovery_snapshot() {
    let (_hub, mut peer) = hub_and_peer(true);
    let (asked, mut asked_rx) = tokio::sync::mpsc::unbounded_channel();
    let recovery = Arc::new(HeldRecovery { lane: OnceLock::new(), slots: Mutex::new(Vec::new()), asked });
    let lagged = live_lane(&mut peer, "lagged", false, recovery.clone()).await;
    let _ = recovery.lane.set(lagged.clone());
    let other = live_lane(&mut peer, "other", false, Arc::new(NoRecovery)).await;
    lagged.lag();
    tokio::time::timeout(DEADLINE, asked_rx.recv())
        .await
        .expect("the writer asks the lagged lane to recover within the deadline")
        .expect("recovery channel open");
    push(&other, "other1");
    answer(&peer, "answer");
    answer(&peer, "marker");
    assert_eq!(texts(until_marker(&mut peer, "marker").await), ["other1", "answer", "marker"]);
    let slot = recovery.slots.lock().unwrap().pop().expect("the recovery slot");
    slot.fill(Bytes::from_static(b"snapshot"));
    assert_eq!(texts(next_items(&mut peer, 1, "the recovery snapshot").await), ["snapshot"]);
}

/// A ping due while the peer reads nothing is written before every text frame already queued.
#[tokio::test]
async fn a_ping_goes_before_the_queued_frames_of_a_stalled_peer() {
    let (hub, mut peer) = hub_and_peer(false);
    peer.allow(1);
    let lane = live_lane_stalled(&mut peer).await;
    let mut queued = Vec::new();
    for (on_lane, text) in [(true, "a1"), (false, "answer"), (true, "a2"), (false, "marker")] {
        if on_lane {
            push(&lane, text);
        } else {
            answer(&peer, text);
        }
        queued.push(Wire::Text(text.to_owned()));
    }
    // The peer has been silent for two ticks: the heartbeat queues a ping.
    hub.heartbeat_tick();
    hub.heartbeat_tick();
    let mut expected = vec![Wire::Ping];
    expected.extend(queued);
    assert_eq!(until_marker(&mut peer, "marker").await, expected);
}

async fn live_lane_stalled(peer: &mut Peer) -> Arc<dyn Lane> {
    let sink = &peer.connection.sink;
    let (lane, release) = sink.open_lane(SubscriptionId::from("a"), Arc::new(NoRecovery)).unwrap();
    sink.send_control_release(Bytes::from_static(b"opened a"), release).unwrap();
    assert_eq!(texts(next_items(peer, 1, "the response opening the lane").await), ["opened a"]);
    lane
}

/// D3: an ordered lane's frames hold the control reserve; once the lane has written something a
/// failed reservation closes the connection with 4000 instead of lagging (dropping) it.
#[tokio::test]
async fn an_ordered_lane_past_the_control_reserve_closes_the_connection() {
    let (_hub, mut peer) = hub_and_peer(false);
    let sink = peer.connection.sink.clone();
    let (lane, release) = sink.open_ordered_lane(SubscriptionId::from("o"), Arc::new(NoRecovery)).unwrap();
    sink.send_control_release(Bytes::from_static(b"opened o"), release).unwrap();
    peer.allow(2);
    push(&lane, "first");
    assert_eq!(texts(next_items(&mut peer, 2, "the response and the first frame").await), ["opened o", "first"]);
    // The peer reads nothing more: 30 KB frames until the 64 KiB reserve refuses one.
    let frame = "o".repeat(30_000);
    let refused = (0..8).find(|_| match lane.try_reserve(frame.len()) {
        Ok(reservation) => {
            lane.push(reservation, Bytes::from(frame.clone()));
            false
        }
        Err(_) => true,
    });
    assert!(refused.is_some(), "the ordered reserve must run out");
    // What a feed does with a failed reservation.
    lane.lag();
    assert_eq!(sink.close_code(), Some(CloseCode::SlowConsumer), "the ordered lane closed the connection rather than lag");
}
