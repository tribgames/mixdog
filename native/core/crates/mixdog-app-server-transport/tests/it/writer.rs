//! The writer against the feed contract (P §6.4–6.5, §14.6; RL G6): ordering, gating, lag and
//! recovery, control reserve.

use crate::common;

use std::sync::Arc;

use bytes::Bytes;
use common::Peer;
use common::Wire;
use common::connect;
use common::install_rt;
use common::mock_limits;
use common::small_limits;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::EchoView;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::mock::event;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_core_api::sink::LaneRecovery;
use mixdog_core_api::sink::Reservation;
use tokio::task::yield_now;

fn view() -> Option<Arc<dyn FeedView>> {
    Some(Arc::new(EchoView))
}

fn new_feed(name: &str, limits: &mixdog_app_protocol::limits::Limits) -> Arc<MockFeed> {
    Arc::new(MockFeed::new(
        FeedId::from(name),
        epoch(9),
        Arc::new(EchoView),
        mock_limits(limits),
    ))
}

fn publish(feed: &MockFeed, seqs: std::ops::RangeInclusive<u64>) {
    let frames: Vec<_> = seqs.map(event).collect();
    feed.publish(&frames, view()).expect("contiguous frames");
}

/// A frame of about 60 KB (below `maxFrameBytes`) named `evt@<seq>:…`.
fn big_event(seq: u64) -> FeedFrame {
    let mut text = format!("evt@{seq}:");
    text.push_str(&"x".repeat(60_000));
    FeedFrame {
        seq,
        bytes: Bytes::from(text),
    }
}

fn names(texts: Vec<String>) -> Vec<String> {
    texts
        .into_iter()
        .map(|text| text.split(':').next().unwrap_or_default().to_owned())
        .collect()
}

async fn settle() {
    for _ in 0..20 {
        yield_now().await;
    }
}

fn subscribe_to(
    feed: &Arc<MockFeed>,
    peer: &Peer,
    name: &str,
    window: Window,
    resume_from: Option<ResumeFrom>,
) -> mixdog_core_api::feed::Attached {
    let source: Arc<dyn FeedSource> = feed.clone();
    subscribe(
        &source,
        SubscriptionId::from(name),
        window,
        resume_from,
        &peer.connection.sink,
    )
    .expect("open connection")
}

fn respond(peer: &Peer, attached: mixdog_core_api::feed::Attached, text: &str) {
    peer.connection
        .sink
        .send_control_release(Bytes::from(text.to_owned()), attached.release)
        .expect("connection open");
}

#[tokio::test]
async fn lane_waits_for_its_response_then_snapshot_then_live() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    let feed = new_feed("app", &limits);
    publish(&feed, 1..=3);

    let attached = subscribe_to(&feed, &peer, "a", Window::LastItems(50), None);
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    assert_eq!(attached.decision.start_seq, 4);
    publish(&feed, 4..=5);
    settle().await;
    respond(&peer, attached, "resp");
    publish(&feed, 6..=6);

    assert_eq!(
        peer.take_text(5).await,
        ["resp", "snapshot@3", "evt@4", "evt@5", "evt@6"]
    );
}

#[tokio::test]
async fn resume_in_the_ring_replays_behind_the_response() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    let feed = new_feed("app", &limits);
    publish(&feed, 1..=4);
    let resume = ResumeFrom {
        position: FeedPosition {
            epoch: epoch(9),
            seq: 2,
        },
        window: Window::LastItems(50),
    };

    let attached = subscribe_to(&feed, &peer, "a", Window::LastItems(50), Some(resume));
    assert_eq!(attached.decision.mode, AttachMode::Replay);
    assert_eq!(attached.decision.start_seq, 3);
    publish(&feed, 5..=5);
    respond(&peer, attached, "resp");

    assert_eq!(peer.take_text(4).await, ["resp", "evt@3", "evt@4", "evt@5"]);
}

#[tokio::test]
async fn lanes_share_the_socket_in_queue_order() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let (a, b) = (new_feed("ta", &limits), new_feed("tb", &limits));
    let attached_a = subscribe_to(&a, &peer, "a", Window::Fixed, None);
    let attached_b = subscribe_to(&b, &peer, "b", Window::Fixed, None);
    respond(&peer, attached_a, "ra");
    respond(&peer, attached_b, "rb");
    publish(&a, 1..=3);
    publish(&b, 1..=3);
    settle().await;
    peer.allow(usize::MAX >> 4);

    let texts = peer.take_text(10).await;
    // Queue order: each lane's snapshot (queued at subscribe, gated) right after its response,
    // then every frame in the order it was published, A's before B's.
    let published: Vec<String> = (1..=3).chain(1..=3).map(|seq| format!("evt@{seq}")).collect();
    let mut expected: Vec<String> = ["ra", "snapshot@0", "rb", "snapshot@0"].map(String::from).to_vec();
    expected.extend(published);
    assert_eq!(texts, expected);
}

#[tokio::test]
async fn control_reserve_exhaustion_closes_with_slow_consumer() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();
    // 64 KiB reserve, a peer that reads nothing: at most one frame is in flight at the socket.
    let frame = Bytes::from(vec![b'c'; 30_000]);
    let refused = (0..8).find(|_| sink.send_control(frame.clone()).is_err());
    assert!(refused.is_some(), "the reserve must run out");
    assert_eq!(sink.close_code(), Some(CloseCode::SlowConsumer));
    assert!(sink.send_control(Bytes::from_static(b"late")).is_err());

    peer.allow(usize::MAX >> 4);
    let wire = peer.until_closed().await;
    assert_eq!(wire.last(), Some(&Wire::Close(CloseCode::SlowConsumer)));
    assert!(
        wire.iter().filter(|w| matches!(w, Wire::Text(_))).count() <= 1,
        "queued control frames are dropped, only the one in flight was written"
    );
}

/// One answer larger than the whole control reserve, to a connection that holds nothing of it, is written and the
/// connection stays open: a list or a transcript read of a large profile is one such answer (1,000 thread rows of a
/// real profile are about 900 KiB against the 512 KiB reserve). A second one behind it, unread, still closes.
#[tokio::test]
async fn one_answer_larger_than_the_control_reserve_is_written_and_the_connection_stays_open() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    let sink = peer.connection.sink.clone();
    let answer = Bytes::from(vec![b'a'; limits.control_reserve_bytes as usize + 1]);
    assert!(sink.send_control(answer.clone()).is_ok(), "an empty reserve admits the answer");
    let wire = peer.take_text(1).await;
    assert!(wire[0].as_bytes() == &answer[..], "the answer is written whole");
    assert_eq!(sink.close_code(), None, "the connection stays open");

    let mut stalled = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = stalled.connection.sink.clone();
    assert!(sink.send_control(answer.clone()).is_ok());
    assert!(sink.send_control(answer).is_err(), "nothing of the first was taken");
    assert_eq!(sink.close_code(), Some(CloseCode::SlowConsumer));
    stalled.allow(usize::MAX >> 4);
    assert_eq!(stalled.until_closed().await.last(), Some(&Wire::Close(CloseCode::SlowConsumer)));
}

/// Two large answers a client asked for at once: the second, made while the first is still on its way to the socket, waits
/// for the reserve and is written behind it; the connection stays open (the desktop's first screen asks for a list page
/// and a transcript read together, 300 KiB and 450 KiB against the 512 KiB reserve).
#[tokio::test]
async fn an_answer_made_while_another_is_on_its_way_waits_for_the_reserve() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();
    let size = limits.control_reserve_bytes as usize + 1;
    let (first, second) = (Bytes::from(vec![b'a'; size]), Bytes::from(vec![b'b'; size]));
    assert!(sink.send_answer(first.clone()).await.is_ok(), "an empty reserve admits the answer");
    let mut waiting = sink.send_answer(second.clone());
    assert!(futures::poll!(&mut waiting).is_pending(), "the second waits while the first holds the reserve");
    assert_eq!(sink.close_code(), None, "waiting ends no connection");

    peer.allow(usize::MAX >> 4);
    assert!(waiting.await.is_ok(), "the room the first gave back takes the second");
    let wire = peer.take_text(2).await;
    assert!(wire[0].as_bytes() == &first[..] && wire[1].as_bytes() == &second[..], "both are written, in the order they were made");
    assert_eq!(sink.close_code(), None, "the connection stays open");
}

/// An answer that waits for the reserve ends when the connection does.
#[tokio::test]
async fn an_answer_waiting_for_the_reserve_ends_with_the_connection() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();
    let answer = Bytes::from(vec![b'a'; limits.control_reserve_bytes as usize + 1]);
    assert!(sink.send_answer(answer.clone()).await.is_ok());
    let mut waiting = sink.send_answer(answer.clone());
    assert!(futures::poll!(&mut waiting).is_pending());
    // A frame that may not wait finds the reserve held and closes the connection, as before.
    assert!(sink.send_control(answer).is_err());
    assert!(waiting.await.is_err(), "the waiting answer is told the connection closed");
}

/// A peer that keeps asking and reads nothing: the answers waiting for the reserve hold at most the queue's bytes, and the
/// one past them closes the connection, whatever the peer still sends.
#[tokio::test]
async fn answers_waiting_past_the_queue_bytes_close_with_slow_consumer() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();
    let answer = Bytes::from(vec![b'a'; limits.control_reserve_bytes as usize]);
    assert!(sink.send_answer(answer.clone()).await.is_ok(), "the first holds the reserve");
    let mut waiting = Vec::new();
    let refused = loop {
        let mut next = sink.send_answer(answer.clone());
        match futures::poll!(&mut next) {
            std::task::Poll::Pending => waiting.push(next),
            std::task::Poll::Ready(outcome) => break outcome,
        }
        assert!(waiting.len() as u64 * limits.control_reserve_bytes <= limits.queue_bytes, "the waiting answers are bounded by the queue's bytes");
    };
    assert!(refused.is_err());
    assert_eq!(sink.close_code(), Some(CloseCode::SlowConsumer));
    for answer in waiting {
        assert!(answer.await.is_err(), "every waiting answer ends with the connection");
    }
}

#[tokio::test]
async fn slow_consumer_lags_only_its_own_lanes_and_recovers_one_snapshot_each() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut slow = connect(&hub, ConnectionOrigin::Loopback, false);
    let mut fast = connect(&hub, ConnectionOrigin::Loopback, true);
    let (a, b) = (new_feed("ta", &limits), new_feed("tb", &limits));

    let slow_a = subscribe_to(&a, &slow, "a", Window::Fixed, None);
    let slow_b = subscribe_to(&b, &slow, "b", Window::Fixed, None);
    let fast_a = subscribe_to(&a, &fast, "fa", Window::Fixed, None);
    respond(&slow, slow_a, "slow-ra");
    respond(&slow, slow_b, "slow-rb");
    respond(&fast, fast_a, "fast-ra");
    settle().await;

    // 100 frames of ~60 KB, ~6 MB per feed, against a 512 KiB event budget per connection.
    for seq in 1..=100 {
        a.publish(&[big_event(seq)], view()).unwrap();
        b.publish(&[big_event(seq)], view()).unwrap();
        settle().await;
    }

    // The stalled connection holds nothing: both of its lanes lagged and released everything.
    let event_budget = limits.event_budget_bytes as usize;
    assert_eq!(slow.connection.sink.event_budget_free(), event_budget);
    // The healthy connection saw every frame, in order.
    let texts = names(fast.take_text(102).await);
    let expected: Vec<String> = ["fast-ra".to_owned(), "snapshot@0".to_owned()]
        .into_iter()
        .chain((1..=100).map(|seq| format!("evt@{seq}")))
        .collect();
    assert_eq!(texts, expected);

    // The stalled peer reads again: responses, then one snapshot per lagged lane, then live.
    slow.allow(usize::MAX >> 4);
    let texts = names(slow.take_text(4).await);
    assert_eq!(
        texts,
        ["slow-ra", "slow-rb", "snapshot@100", "snapshot@100"]
    );
    a.publish(&[event(101)], view()).unwrap();
    b.publish(&[event(101)], view()).unwrap();
    assert_eq!(slow.take_text(2).await, ["evt@101", "evt@101"]);
    assert_eq!(slow.connection.sink.event_budget_free(), event_budget);
    assert!(!slow.connection.sink.is_closed());
}

#[tokio::test]
async fn a_burst_on_one_feed_never_lags_a_lane_that_keeps_up() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    // The peer reads nothing during the burst, so the burst's backlog stays queued.
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let (a, b) = (new_feed("ta", &limits), new_feed("tb", &limits));
    let attached_a = subscribe_to(&a, &peer, "a", Window::Fixed, None);
    let attached_b = subscribe_to(&b, &peer, "b", Window::Fixed, None);
    respond(&peer, attached_a, "ra");
    respond(&peer, attached_b, "rb");
    settle().await;

    // 40 frames of ~60 KB on A (2.4 MB against a 512 KiB budget) while B publishes steadily.
    let mut b_seq = 0;
    for seq in 1..=40 {
        a.publish(&[big_event(seq)], view()).unwrap();
        if seq % 8 == 0 {
            b_seq += 1;
            b.publish(&[event(b_seq)], view()).unwrap();
        }
    }
    assert_eq!(b_seq, 5);
    peer.allow(usize::MAX >> 4);

    let wire = names(peer.take_text(2 + 1 + 5 + 1).await);
    // A's queued snapshot@0 went with its lag.
    // B: its snapshot and every frame, in order, never a recovery snapshot.
    // A: lagged by its own backlog and recovered with exactly one snapshot at the head.
    let b_frames: Vec<_> = wire.iter().filter(|t| t.starts_with("evt@") && t.len() < 7).collect();
    assert_eq!(b_frames, ["evt@1", "evt@2", "evt@3", "evt@4", "evt@5"]);
    assert_eq!(wire.iter().filter(|t| *t == "snapshot@40").count(), 1);
    assert_eq!(wire.iter().filter(|t| *t == "snapshot@5").count(), 0);
}

/// What the peer has been sent so far, once the writer has run dry.
async fn drain(peer: &mut Peer) -> Vec<String> {
    for _ in 0..10 {
        settle().await;
    }
    let mut texts = Vec::new();
    while let Ok(wire) = peer.wire.try_recv() {
        if let Wire::Text(text) = wire {
            texts.push(text);
        }
    }
    texts
}

fn small_events<'a>(texts: &'a [String], marker: &str) -> Vec<&'a str> {
    texts
        .iter()
        .map(String::as_str)
        .filter(|t| t.len() < 12 && (t.starts_with("evt@") || *t == marker))
        .collect()
}

#[tokio::test]
async fn a_lane_opened_mid_burst_is_never_lagged_by_the_burst() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let (a, b) = (new_feed("ta", &limits), new_feed("tb", &limits));
    let attached_a = subscribe_to(&a, &peer, "a", Window::Fixed, None);
    respond(&peer, attached_a, "ra");
    settle().await;

    // A alone fills the budget (8 x ~60 KB of 512 KiB), nobody is reading.
    for seq in 1..=8 {
        a.publish(&[big_event(seq)], view()).unwrap();
    }
    assert!(peer.connection.sink.event_budget_free() < 60_006);

    // B opens mid-burst: A is over its new half and lags, B gets all of its room.
    let attached_b = subscribe_to(&b, &peer, "b", Window::Fixed, None);
    respond(&peer, attached_b, "rb");
    for seq in 1..=5 {
        b.publish(&[event(seq)], view()).unwrap();
    }
    settle().await;
    peer.allow(usize::MAX >> 4);

    let texts = drain(&mut peer).await;
    // B: its snapshot, then every frame in order, and never a recovery snapshot.
    assert_eq!(
        small_events(&texts, "snapshot@0"),
        ["snapshot@0", "evt@1", "evt@2", "evt@3", "evt@4", "evt@5"]
    );
    assert_eq!(texts.iter().filter(|t| *t == "snapshot@5").count(), 0);
    // A: the lagged backlog was dropped and replaced by one snapshot.
    assert_eq!(texts.iter().filter(|t| *t == "snapshot@8").count(), 1);
    assert!(texts.iter().all(|t| t.len() < 1000), "no burst frame was written");
    assert_eq!(
        peer.connection.sink.event_budget_free(),
        limits.event_budget_bytes as usize
    );
}

#[tokio::test]
async fn closing_a_lane_mid_burst_widens_the_others_shares() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let (a, b, c) = (
        new_feed("ta", &limits),
        new_feed("tb", &limits),
        new_feed("tc", &limits),
    );
    let attached_a = subscribe_to(&a, &peer, "a", Window::Fixed, None);
    let attached_b = subscribe_to(&b, &peer, "b", Window::Fixed, None);
    let _attached_c = subscribe_to(&c, &peer, "c", Window::Fixed, None);
    respond(&peer, attached_a, "ra");
    respond(&peer, attached_b, "rb");
    settle().await;

    // Three lanes share 512 KiB: ~170 KiB each, so two ~60 KB frames per lane fit.
    for seq in 1..=2 {
        a.publish(&[big_event(seq)], view()).unwrap();
        b.publish(&[big_event(seq)], view()).unwrap();
    }
    let source: Arc<dyn FeedSource> = c.clone();
    source.detach(SubscriptionId::from("c"));
    // Two lanes share it now: ~256 KiB each, so four frames per lane fit without lag.
    for seq in 3..=4 {
        a.publish(&[big_event(seq)], view()).unwrap();
        b.publish(&[big_event(seq)], view()).unwrap();
    }
    settle().await;
    peer.allow(usize::MAX >> 4);

    let texts = drain(&mut peer).await;
    let frames: Vec<_> = names(texts.clone())
        .into_iter()
        .filter(|t| t.starts_with("evt@"))
        .collect();
    assert_eq!(frames.len(), 8);
    for lane in 0..2 {
        let seqs: Vec<_> = frames.iter().skip(lane).step_by(2).collect();
        assert_eq!(seqs, ["evt@1", "evt@2", "evt@3", "evt@4"]);
    }
    assert!(
        !texts.iter().any(|t| t == "snapshot@4"),
        "neither lane needed a recovery snapshot"
    );
    assert_eq!(
        peer.connection.sink.event_budget_free(),
        limits.event_budget_bytes as usize
    );
}

#[tokio::test]
async fn a_blocked_control_write_keeps_its_bytes_charged_to_the_reserve() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();
    // 64 KiB reserve, a peer that reads nothing: the first frame is in flight at the socket.
    let frame = Bytes::from(vec![b'c'; 30_000]);
    sink.send_control(frame.clone()).unwrap();
    settle().await;
    sink.send_control(frame.clone()).unwrap();
    // The refill must not make room for a third: 90,000 > 65,536 bytes of reserve.
    assert!(sink.send_control(frame).is_err());
    assert_eq!(sink.close_code(), Some(CloseCode::SlowConsumer));
}
struct NoRecovery;

impl LaneRecovery for NoRecovery {
    fn recover(&self, _: SubscriptionId, _: Reservation) {}
}

#[tokio::test]
async fn reservations_held_by_producers_cannot_outlive_a_revocation() {
    install_rt();
    let limits = small_limits();
    let budget = limits.event_budget_bytes as usize;
    let hub = ConnectionHub::new(limits).unwrap();
    let peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();

    // A alone holds eight unqueued 60,000-byte reservations: nothing pushed, nothing written.
    let (lane_a, _) = sink
        .open_lane(SubscriptionId::from("a"), Arc::new(NoRecovery))
        .unwrap();
    let mut held: Vec<Reservation> = (0..8).map(|_| lane_a.try_reserve(60_000).unwrap()).collect();
    assert_eq!(sink.event_budget_free(), budget - 480_000);

    // B opens: A is above its new half, so it is revoked, reservations in hand included.
    let (lane_b, _) = sink
        .open_lane(SubscriptionId::from("b"), Arc::new(NoRecovery))
        .unwrap();
    assert!(lane_a.is_lagged());
    assert_eq!(sink.event_budget_free(), budget, "A's hold was not charged on");

    // B reserves its whole share at once; nothing of A's is in the way.
    let share = budget / 2;
    let mut b_held = Vec::new();
    while let Ok(reservation) = lane_b.try_reserve(60_000) {
        b_held.push(reservation);
        assert!(budget - sink.event_budget_free() <= budget, "charged within the budget");
    }
    assert!(b_held.len() >= share / 60_000, "B gets at least its guaranteed share");
    let charged = budget - sink.event_budget_free();
    assert_eq!(charged, b_held.len() * 60_000);

    // A's late push and the drop of its revoked reservations change nothing.
    lane_a.push(held.pop().unwrap(), Bytes::from_static(b"late"));
    drop(held);
    assert_eq!(budget - sink.event_budget_free(), charged);
    drop(b_held);
    assert_eq!(sink.event_budget_free(), budget);
}
#[tokio::test]
async fn a_within_share_frame_is_never_lagged_while_another_frame_is_in_flight() {
    install_rt();
    let limits = small_limits();
    let budget = limits.event_budget_bytes as usize;
    let hub = ConnectionHub::new(limits).unwrap();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, false);
    let sink = peer.connection.sink.clone();
    let (lane_a, release_a) = sink
        .open_lane(SubscriptionId::from("a"), Arc::new(NoRecovery))
        .unwrap();
    let (lane_b, release_b) = sink
        .open_lane(SubscriptionId::from("b"), Arc::new(NoRecovery))
        .unwrap();
    sink.send_control_release(Bytes::from_static(b"ra"), release_a).unwrap();
    sink.send_control_release(Bytes::from_static(b"rb"), release_b).unwrap();
    peer.allow(2);
    assert_eq!(peer.take_text(2).await, ["ra", "rb"]);

    // A frame of A is in flight at the stalled socket; A also holds its whole share.
    let in_flight = 16_000;
    let reservation = lane_a.try_reserve(in_flight).unwrap();
    lane_a.push(reservation, Bytes::from(vec![b'a'; in_flight]));
    settle().await;
    let share = budget / 2;
    let a_held = lane_a.try_reserve(share).unwrap();
    assert!(!lane_a.is_lagged());

    // B takes its whole share in four frames. The charge passes the strict total by the
    // in-flight frame, which is the allowance a within-share request is owed.
    for _ in 0..4 {
        let reservation = lane_b.try_reserve(share / 4).unwrap();
        lane_b.push(reservation, Bytes::from(vec![b'b'; share / 4]));
        assert!(!lane_b.is_lagged(), "a within-share frame must not lag its lane");
    }
    assert!(!lane_a.is_lagged());
    drop(a_held);
    peer.allow(usize::MAX >> 4);
    let texts = drain(&mut peer).await;
    assert_eq!(texts.iter().filter(|t| t.starts_with('b')).count(), 4);
    assert_eq!(sink.event_budget_free(), budget);
}

/// A thread feed's text append at `seq`, as the feed encodes it.
fn append(seq: u64, text: &str) -> FeedFrame {
    let frame = serde_json::json!({
        "method": "item/agentMessage/delta",
        "params": { "threadId": "t", "turnId": "u", "itemId": "answer", "delta": text },
        "feed": { "id": "thread:t", "epoch": epoch(9), "seq": seq },
    });
    FeedFrame { seq, bytes: Bytes::from(frame.to_string()) }
}

fn parsed(text: &str) -> serde_json::Value {
    serde_json::from_str(text).expect("a JSON frame")
}

/// Two clients on one stream: the one that announced `feedRanges` gets the first append at once and the window's appends as one
/// frame standing for their positions (`feed.from`); the other gets every frame as before.
#[tokio::test(start_paused = true)]
async fn only_a_feed_ranges_client_gets_a_window_of_appends_as_one_ranged_frame() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let mut phone = connect(&hub, ConnectionOrigin::Loopback, true);
    let mut older = connect(&hub, ConnectionOrigin::Loopback, true);
    phone.connection.sink.coalesce_appends();
    let feed = new_feed("thread:t", &limits);
    let attached = subscribe_to(&feed, &phone, "p", Window::Fixed, None);
    respond(&phone, attached, "resp");
    let attached = subscribe_to(&feed, &older, "o", Window::Fixed, None);
    respond(&older, attached, "resp");
    assert_eq!(phone.take_text(2).await[0], "resp");
    assert_eq!(older.take_text(2).await[0], "resp");

    let texts = ["응", "답 ", "하", "나"];
    for (at, text) in texts.iter().enumerate() {
        feed.publish(&[append(at as u64 + 1, text)], view()).expect("contiguous frames");
        settle().await;
        tokio::time::advance(std::time::Duration::from_millis(4)).await;
    }

    let first = parsed(&phone.take_text(1).await[0]);
    assert_eq!((first["feed"]["seq"].clone(), first["params"]["delta"].clone()), (serde_json::json!(1), serde_json::json!("응")), "the first append goes at once");
    let window = parsed(&phone.take_text(1).await[0]);
    assert_eq!(window["params"]["delta"], "답 하나", "the window's appends joined");
    assert_eq!((window["feed"]["from"].clone(), window["feed"]["seq"].clone()), (serde_json::json!(2), serde_json::json!(4)));

    let every: Vec<serde_json::Value> = older.take_text(4).await.iter().map(|text| parsed(text)).collect();
    assert_eq!(every.iter().map(|frame| frame["feed"]["seq"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2, 3, 4]);
    assert!(every.iter().all(|frame| frame["feed"].get("from").is_none()), "a client without `feedRanges` never sees a range");
}

/// A client resuming from a position inside a range another client got coalesced is replayed every frame after it, and its own
/// appends are coalesced from there.
#[tokio::test(start_paused = true)]
async fn a_resume_inside_a_coalesced_range_replays_from_the_next_position() {
    install_rt();
    let limits = small_limits();
    let hub = ConnectionHub::new(limits.clone()).unwrap();
    let feed = new_feed("thread:t", &limits);
    feed.publish(&(1..=5).map(|seq| append(seq, &seq.to_string())).collect::<Vec<_>>(), view()).expect("contiguous frames");
    let mut phone = connect(&hub, ConnectionOrigin::Loopback, true);
    phone.connection.sink.coalesce_appends();
    let resume = ResumeFrom { position: FeedPosition { epoch: epoch(9), seq: 3 }, window: Window::LastItems(50) };
    let attached = subscribe_to(&feed, &phone, "p", Window::LastItems(50), Some(resume));
    assert_eq!(attached.decision.mode, AttachMode::Replay);
    respond(&phone, attached, "resp");
    assert_eq!(phone.take_text(1).await, ["resp"]);
    let first = parsed(&phone.take_text(1).await[0]);
    assert_eq!(first["feed"]["seq"], 4, "the replay starts right after the resumed position");
    let next = parsed(&phone.take_text(1).await[0]);
    assert_eq!((next["feed"]["seq"].clone(), next["params"]["delta"].clone()), (serde_json::json!(5), serde_json::json!("5")));
    assert!(next["feed"].get("from").is_none(), "one held append leaves as it came");
}