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
        let item = mixdog_rt::time::timeout(DEADLINE, peer.wire.recv())
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
    replay_recorded_windows("terminal-dispose", true).await;
}

/// Every other recorded window, queued in Node's queue order on a socket read promptly or withheld
/// until all is queued (the recorder's barrier on Node's socket writes): events after an answer and
/// several never-dropped events in a row (`activity-after-answer`, ordered lane), catalog rows
/// before their answer (`room-rename`, `thread-favorite`, ordered lane: never-droppable rosters,
/// `remote-relay-catalog.ts:89`), and droppable states around an answer (`state-latest-wins`,
/// a droppable lane) come out exactly as Node's phone got them.
#[tokio::test]
async fn every_recorded_window_is_written_in_the_order_nodes_phone_got_it() {
    for (scenario, ordered) in [("activity-after-answer", true), ("room-rename", true), ("thread-favorite", true), ("state-latest-wins", false)] {
        replay_recorded_windows(scenario, ordered).await;
    }
}

/// Queues each recorded run's frames in the order Node's phone got them (events on one lane of the
/// given class, answers on the control lane) and compares the socket's whole output with them.
async fn replay_recorded_windows(scenario: &str, ordered: bool) {
    let golden = golden();
    let modes = golden["scenarios"][scenario]["modes"].as_object().expect("modes");
    assert_eq!(modes.len(), 4, "{scenario}: transport and legacy, each prompt and stalled");
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
            let prompt = mode.ends_with("prompt");
            let (_hub, mut peer) = hub_and_peer(prompt);
            let events = live_lane(&mut peer, scenario, ordered, Arc::new(NoRecovery)).await;
            let queue = |peer: &Peer, frame: &String, kind: &str| {
                if kind == "event" {
                    push(&events, frame);
                } else {
                    answer(peer, frame);
                }
            };
            // Queued in Node's queue order.
            let mut window = frames.iter().zip(&kinds);
            if !prompt {
                // The recorder's barrier on Node's socket write: the writer holds the window's first frame at a
                // socket that takes nothing (confirmed, not assumed) while the rest queues behind it.
                while peer.held.try_recv().is_ok() {}
                let (frame, kind) = window.next().expect("a first frame");
                queue(&peer, frame, kind);
                mixdog_rt::time::timeout(DEADLINE, peer.held.recv())
                    .await
                    .unwrap_or_else(|_| panic!("{scenario} {mode}: the writer did not reach the withheld socket with the window's first frame within {DEADLINE:?}"))
                    .expect("the socket");
            }
            for (frame, kind) in window {
                queue(&peer, frame, kind);
            }
            let wire = texts(until_marker(&mut peer, frames.last().expect("a last frame")).await);
            assert_eq!(wire, frames, "{scenario} {mode}: the writer's order is not the order Node's phone got");
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
    mixdog_rt::time::timeout(DEADLINE, asked_rx.recv())
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

/// What a feed does with one event frame (`CoreFeed::publish`, `mixdog-core-base/src/feed/mod.rs`):
/// reserve its bytes on the lane and push it, or lag the lane when the reservation fails.
fn publish(lane: &Arc<dyn Lane>, frame: Bytes) {
    match lane.try_reserve(frame.len()) {
        Ok(reservation) => lane.push(reservation, frame),
        Err(_) => {
            lane.lag();
        }
    }
}

/// An ordered lane whose first frame (its initial state) the peer has read, so it is live and has
/// written something: from here a failed reservation would close the connection.
async fn ordered_lane_past_its_first_frame(peer: &mut Peer, name: &str) -> Arc<dyn Lane> {
    let lane = live_lane(peer, name, true, Arc::new(NoRecovery)).await;
    publish(&lane, Bytes::from_static(b"initial"));
    allow_up_to(peer, 1);
    assert_eq!(texts(next_items(peer, 1, "the lane's initial frame").await), ["initial"]);
    lane
}

/// `lsp/diagnostics/updated` for one document with 2,000 diagnostics of 300-byte messages, the
/// most `mixdog-workspace/src/lsp.rs:756` forwards (Node: `language-server-process.ts:398`).
fn diagnostics_frame() -> Bytes {
    let diagnostics: Vec<Value> = (0..2000)
        .map(|n| {
            serde_json::json!({
                "range": { "start": { "line": n, "character": 0 }, "end": { "line": n, "character": 80 } },
                "severity": 1, "source": "ts", "code": 2322, "message": "m".repeat(300),
            })
        })
        .collect();
    let frame = serde_json::json!({
        "method": "lsp/diagnostics/updated",
        "params": { "projectPath": "C:/p", "relPath": "src/a.ts", "uri": "file:///C:/p/src/a.ts", "server": "ts", "diagnostics": diagnostics },
    });
    Bytes::from(serde_json::to_vec(&frame).unwrap())
}

/// The reviewer's load: on an idle, reading connection one diagnostics event larger than the whole
/// control reserve is written and the connection stays open (before the fix the ordered event
/// held the 512 KiB control reserve, failed its reservation and closed the connection with 4000).
#[tokio::test]
async fn one_diagnostics_event_larger_than_the_control_reserve_is_written_and_the_connection_stays_open() {
    install_rt();
    let limits = mixdog_app_protocol::limits::Limits::default();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    let lane = ordered_lane_past_its_first_frame(&mut peer, "lsp:C:/p").await;
    let frame = diagnostics_frame();
    assert!(frame.len() as u64 > limits.control_reserve_bytes, "the event exceeds the control reserve");
    publish(&lane, frame.clone());
    answer(&peer, "marker");
    let expected = [String::from_utf8(frame.to_vec()).unwrap(), "marker".to_owned()];
    assert_eq!(texts(until_marker(&mut peer, "marker").await), expected);
    assert_eq!(peer.connection.sink.close_code(), None, "the connection stays open");
}

/// The largest frame each ordered feed can produce, alone on an empty room, is written:
/// - `app`: one section value inline up to `maxItemFieldBytes` (larger values are stubs,
///   `mixdog-core-base/src/state/mod.rs:48-58`), its frame within `maxFrameBytes`;
/// - `lsp:` and `fs:`: no bound in the core (`lsp.rs:756` caps the count at 2,000, not the bytes;
///   `watcher.rs:306-316` batches paths without a count) nor in Node, so a frame one byte larger
///   than the whole ordered room stands for them: an empty room admits it.
#[tokio::test]
async fn the_largest_frame_of_each_ordered_feed_is_written_from_an_empty_room() {
    let limits = mixdog_app_protocol::limits::Limits::default();
    for (feed, bytes) in [("app", limits.max_frame_bytes), ("lsp:C:/p", limits.ordered_queue_bytes + 1), ("fs:w1", limits.ordered_queue_bytes + 1)] {
        let (_hub, mut peer) = hub_and_peer(true);
        let lane = ordered_lane_past_its_first_frame(&mut peer, feed).await;
        let frame = Bytes::from(vec![b'x'; bytes as usize]);
        publish(&lane, frame.clone());
        answer(&peer, "marker");
        let wire = texts(until_marker(&mut peer, "marker").await);
        assert_eq!(wire.len(), 2, "{feed}: the frame and the marker");
        assert!(wire[0].as_bytes() == &frame[..], "{feed}: the frame is written whole");
        assert_eq!(wire[1], "marker");
        assert_eq!(peer.connection.sink.close_code(), None, "{feed}: the connection stays open");
    }
}

/// 1 MiB event frames, each starting with its index, as many as fill the ordered room exactly.
fn room_filling_frames() -> Vec<Bytes> {
    let room = mixdog_app_protocol::limits::Limits::default().ordered_queue_bytes as usize;
    let size = 1 << 20;
    assert_eq!(room % size, 0, "the room is a whole number of frames");
    (0..room / size)
        .map(|index| {
            let mut frame = format!("{index:06}").into_bytes();
            frame.resize(size, b'.');
            Bytes::from(frame)
        })
        .collect()
}

/// A peer that takes no write: ordered events queue until they hold the whole ordered room
/// (8 MiB, Node's leg budget: `admitFrame`, `relay-transport.mjs:301-314`, cuts a leg at
/// `queued > 0 && queued + size > 8 MiB`) and the connection is still open; the next event closes
/// it with 4000. The stall is the socket's write completion withheld, not time.
#[tokio::test]
async fn a_peer_that_does_not_drain_is_closed_at_the_ordered_room_and_not_before() {
    let (_hub, mut peer) = hub_and_peer(false);
    let lane = ordered_lane_past_its_first_frame(&mut peer, "lsp:C:/p").await;
    for (index, frame) in room_filling_frames().into_iter().enumerate() {
        publish(&lane, frame);
        assert_eq!(peer.connection.sink.close_code(), None, "open after {} MiB queued", index + 1);
    }
    publish(&lane, Bytes::from_static(b"one byte past the room"));
    assert_eq!(peer.connection.sink.close_code(), Some(CloseCode::SlowConsumer), "closed once the room is passed");
}

/// With the ordered room full (the peer takes nothing), an answer still queues on the control
/// reserve and a due ping still queues; once the peer drains, the ping goes first, then every
/// event in order, then the answer.
#[tokio::test]
async fn an_answer_and_a_ping_still_queue_when_the_ordered_room_is_full() {
    let (hub, mut peer) = hub_and_peer(false);
    let lane = ordered_lane_past_its_first_frame(&mut peer, "app").await;
    let frames = room_filling_frames();
    for frame in &frames {
        publish(&lane, frame.clone());
    }
    assert!(lane.try_reserve(1).is_err(), "the ordered room is full");
    answer(&peer, "answer");
    hub.heartbeat_tick();
    hub.heartbeat_tick();
    assert_eq!(peer.connection.sink.close_code(), None, "the connection is open");
    let as_text = |frame: &Bytes| Wire::Text(String::from_utf8(frame.to_vec()).unwrap());
    // The test runtime is single-threaded and the test has not yielded since the events were
    // queued, so the writer task has taken none of them yet: the ping goes first.
    let mut expected = vec![Wire::Ping];
    expected.extend(frames.iter().map(as_text));
    expected.push(Wire::Text("answer".to_owned()));
    // Each item by its kind and first 16 characters, so a mismatch prints without 8 MiB of text.
    let short = |wire: &[Wire]| -> Vec<String> {
        wire.iter()
            .map(|item| match item {
                Wire::Text(text) => format!("text {} ({} bytes)", &text[..text.len().min(16)], text.len()),
                other => format!("{other:?}"),
            })
            .collect()
    };
    let wire = until_marker(&mut peer, "answer").await;
    assert_eq!(short(&wire), short(&expected), "in-flight frame, ping, the events in order, the answer");
    assert!(wire == expected, "every frame written whole");
}
