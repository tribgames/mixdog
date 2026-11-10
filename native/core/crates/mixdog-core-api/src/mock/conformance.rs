//! The attach/publish contract as executable scenarios (SPEC §4.2, P §6.3–6.5).
//!
//! Every `Feed` implementation runs [`run_all`] with a factory that builds an empty feed
//! (seq 0) whose `maxSnapshotBytes` and `ringBytes` are the given limits, and with the inline
//! test executor (`mixdog_rt::testing`) installed. Frames are `evt@<seq>`; the scenarios publish
//! an [`EchoView`] so the snapshot at `S` is `snapshot@S`. A scenario panics on a violation.
//!
//! ```
//! use std::sync::Arc;
//! use mixdog_core_api::ids::FeedId;
//! use mixdog_core_api::mock::{conformance, epoch, EchoView, MockFeed};
//!
//! conformance::run_all(&|limits| {
//!     Arc::new(MockFeed::new(FeedId::from("app"), epoch(9), Arc::new(EchoView), limits))
//! });
//! ```
//!
//! Every `ScopedFeeds` implementation runs [`run_scoped`] with a factory for the given limits:
//!
//! ```
//! use std::sync::Arc;
//! use mixdog_core_api::mock::{conformance, MockScopedFeeds};
//!
//! conformance::run_scoped(&|limits| Arc::new(MockScopedFeeds::new(limits)));
//! ```

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use bytes::Bytes;

use super::EchoView;
use super::MockConnection;
use super::MockLimits;
use super::event;
use crate::error::CoreError;
use crate::feed::AttachMode;
use crate::feed::Attached;
use crate::feed::Feed;
use crate::feed::FeedPosition;
use crate::feed::FeedSource;
use crate::feed::FeedView;
use crate::feed::ResumeFrom;
use crate::feed::ScopedFeed;
use crate::feed::ScopedFeeds;
use crate::feed::Window;
use crate::feed::subscribe;
use crate::ids::ConnectionId;
use crate::ids::FeedEpoch;
use crate::ids::FeedId;
use crate::ids::SubscriptionId;
use crate::sink::BudgetFull;
use crate::sink::ConnectionSink;
use crate::sink::Lane;
use crate::sink::LaneRecovery;
use crate::sink::LaneRelease;
use crate::sink::Reservation;
use crate::sink::SinkClosed;
use crate::sink::SnapshotSlot;

/// Builds an empty feed for the given limits.
pub type FeedFactory<'a> = dyn Fn(MockLimits) -> Arc<dyn Feed> + 'a;

pub fn run_all(make: &FeedFactory) {
    snapshot_then_live(make);
    replay_then_live(make);
    changed_window_snapshots(make);
    other_epoch_snapshots(make);
    evicted_position_snapshots(make);
    replay_beyond_budget_snapshots(make);
    lag_then_recover(make);
    lagged_at_attach(make);
    detach_stops_delivery(make);
    concurrent_attach_is_gapless(make);
}

fn view() -> Option<Arc<dyn FeedView>> {
    Some(Arc::new(EchoView))
}

fn publish(feed: &dyn Feed, seqs: std::ops::RangeInclusive<u64>) {
    let frames: Vec<_> = seqs.map(event).collect();
    feed.publish(&frames, view())
        .expect("contiguous frames publish");
}

fn sub(name: &str) -> SubscriptionId {
    SubscriptionId::from(name)
}

/// Subscribes through [`subscribe`], so lag recovery re-enters the same `attach`.
fn attach(
    feed: &Arc<dyn Feed>,
    conn: &MockConnection,
    name: &str,
    window: Window,
    resume: Option<(FeedEpoch, u64, Window)>,
) -> Attached {
    let resume_from = resume.map(|(epoch, seq, window)| ResumeFrom {
        position: FeedPosition { epoch, seq },
        window,
    });
    let source: Arc<dyn FeedSource> = feed.clone();
    subscribe(&source, sub(name), window, resume_from, conn).expect("attach to an open connection")
}

fn respond(conn: &dyn ConnectionSink, attached: Attached, text: &str) {
    conn.send_control_release(Bytes::from(text.to_owned()), attached.release)
        .expect("connection open");
}

fn epoch_of(feed: &dyn Feed) -> FeedEpoch {
    feed.position().epoch
}

/// The frames of one lane, in socket order. Interleaving between lanes is the writer's.
fn lane(written: &[String], name: &str) -> Vec<String> {
    let prefix = format!("{name}:");
    written
        .iter()
        .filter_map(|w| w.strip_prefix(&prefix).map(str::to_owned))
        .collect()
}

/// Response first, then the snapshot at `S`, then every frame after `S`, including frames
/// published before the response was written.
pub fn snapshot_then_live(make: &FeedFactory) {
    let limits = MockLimits::default();
    let feed = make(limits);
    publish(feed.as_ref(), 1..=3);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = attach(&feed, &conn, "a", Window::LastItems(50), None);
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    assert_eq!(attached.decision.start_seq, 4);
    assert_eq!(attached.decision.epoch, epoch_of(feed.as_ref()));

    publish(feed.as_ref(), 4..=5);
    assert_eq!(
        conn.drain(),
        vec![],
        "a lane is gated until its response is written"
    );
    respond(&conn, attached, "resp");
    publish(feed.as_ref(), 6..=6);
    assert_eq!(
        conn.drain_text(),
        [
            "control:resp",
            "a:snapshot@3",
            "a:evt@4",
            "a:evt@5",
            "a:evt@6"
        ]
    );
}

/// Same epoch, same window, position inside the ring, frames fit: replay from `seq + 1`.
pub fn replay_then_live(make: &FeedFactory) {
    let limits = MockLimits::default();
    let feed = make(limits);
    publish(feed.as_ref(), 1..=4);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let epoch = epoch_of(feed.as_ref());
    let attached = attach(
        &feed,
        &conn,
        "a",
        Window::LastItems(50),
        Some((epoch, 2, Window::LastItems(50))),
    );
    assert_eq!(attached.decision.mode, AttachMode::Replay);
    assert_eq!(attached.decision.start_seq, 3);
    publish(feed.as_ref(), 5..=5);
    respond(&conn, attached, "resp");
    assert_eq!(
        conn.drain_text(),
        ["control:resp", "a:evt@3", "a:evt@4", "a:evt@5"]
    );

    // Resuming exactly at the head replays nothing.
    let attached = attach(
        &feed,
        &conn,
        "b",
        Window::Fixed,
        Some((epoch_of(feed.as_ref()), 5, Window::Fixed)),
    );
    assert_eq!(attached.decision.mode, AttachMode::Replay);
    assert_eq!(attached.decision.start_seq, 6);
    respond(&conn, attached, "resp-b");
    publish(feed.as_ref(), 6..=6);
    let written = conn.drain_text();
    assert_eq!(written[0], "control:resp-b");
    assert_eq!(lane(&written, "a"), ["evt@6"]);
    assert_eq!(lane(&written, "b"), ["evt@6"]);
}

/// A changed window never replays.
pub fn changed_window_snapshots(make: &FeedFactory) {
    let limits = MockLimits::default();
    let feed = make(limits);
    publish(feed.as_ref(), 1..=3);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let epoch = epoch_of(feed.as_ref());
    let attached = attach(
        &feed,
        &conn,
        "a",
        Window::LastItems(100),
        Some((epoch, 1, Window::LastItems(50))),
    );
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    assert_eq!(attached.decision.start_seq, 4);
    respond(&conn, attached, "resp");
    assert_eq!(conn.drain_text(), ["control:resp", "a:snapshot@3"]);
}

/// Another epoch never replays.
pub fn other_epoch_snapshots(make: &FeedFactory) {
    let limits = MockLimits::default();
    let feed = make(limits);
    publish(feed.as_ref(), 1..=3);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let other = FeedEpoch::from(format!("{}x", epoch_of(feed.as_ref())));
    let attached = attach(
        &feed,
        &conn,
        "a",
        Window::Fixed,
        Some((other, 1, Window::Fixed)),
    );
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    respond(&conn, attached, "resp");
    assert_eq!(conn.drain_text(), ["control:resp", "a:snapshot@3"]);
}

/// A position whose next frame left the ring, or beyond the head, snapshots.
pub fn evicted_position_snapshots(make: &FeedFactory) {
    let limits = MockLimits {
        ring_bytes: 3 * event(1).bytes.len(),
        ..MockLimits::default()
    };
    let feed = make(limits);
    publish(feed.as_ref(), 1..=6);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let epoch = epoch_of(feed.as_ref());
    let attached = attach(
        &feed,
        &conn,
        "a",
        Window::Fixed,
        Some((epoch.clone(), 1, Window::Fixed)),
    );
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    respond(&conn, attached, "resp-a");
    let attached = attach(
        &feed,
        &conn,
        "b",
        Window::Fixed,
        Some((epoch.clone(), 7, Window::Fixed)),
    );
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    respond(&conn, attached, "resp-b");
    let attached = attach(
        &feed,
        &conn,
        "c",
        Window::Fixed,
        Some((epoch, 3, Window::Fixed)),
    );
    assert_eq!(
        attached.decision.mode,
        AttachMode::Replay,
        "frames 4..=6 are still in the ring"
    );
    respond(&conn, attached, "resp-c");
    let written = conn.drain_text();
    assert_eq!(
        written[..3],
        ["control:resp-a", "control:resp-b", "control:resp-c"]
    );
    assert_eq!(lane(&written, "a"), ["snapshot@6"]);
    assert_eq!(lane(&written, "b"), ["snapshot@6"]);
    assert_eq!(lane(&written, "c"), ["evt@4", "evt@5", "evt@6"]);
}

/// Limits with a 96-byte event budget and a 48-byte snapshot reservation.
fn small_limits() -> MockLimits {
    MockLimits {
        queue_bytes: 1024 + 96,
        control_reserve_bytes: 1024,
        max_snapshot_bytes: 48,
        ring_bytes: 1 << 20,
    }
}

/// Replay frames that do not fit the free event budget turn the decision into a snapshot.
pub fn replay_beyond_budget_snapshots(make: &FeedFactory) {
    let limits = small_limits();
    let feed = make(limits);
    publish(feed.as_ref(), 1..=40);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let epoch = epoch_of(feed.as_ref());
    let attached = attach(
        &feed,
        &conn,
        "a",
        Window::Fixed,
        Some((epoch, 1, Window::Fixed)),
    );
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    assert_eq!(attached.decision.start_seq, 41);
    respond(&conn, attached, "resp");
    assert_eq!(conn.drain_text(), ["control:resp", "a:snapshot@40"]);
}

/// A lane whose next frame does not fit lags: its unwritten frames are dropped, later frames
/// skip it, and the writer recovers it with a snapshot at the head, followed by live frames.
pub fn lag_then_recover(make: &FeedFactory) {
    let limits = small_limits();
    let feed = make(limits);
    publish(feed.as_ref(), 1..=2);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = attach(&feed, &conn, "a", Window::Fixed, None);
    respond(&conn, attached, "resp");
    assert_eq!(conn.drain_text(), ["control:resp", "a:snapshot@2"]);

    publish(feed.as_ref(), 3..=40);
    assert_eq!(
        conn.event_free(),
        limits.event_budget_bytes(),
        "a lagged lane holds no bytes"
    );
    assert_eq!(conn.drain_text(), ["a:snapshot@40"]);
    publish(feed.as_ref(), 41..=41);
    assert_eq!(conn.drain_text(), ["a:evt@41"]);
}

/// A lane that cannot reserve `maxSnapshotBytes` at attach starts lagged; after its response
/// it is recovered with a snapshot once the writer has freed the bytes. Other lanes keep
/// their frames.
pub fn lagged_at_attach(make: &FeedFactory) {
    let limits = small_limits();
    let feed = make(limits);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = attach(&feed, &conn, "a", Window::Fixed, None);
    respond(&conn, attached, "resp-a");
    let mut head = 0;
    while conn.event_free() >= limits.max_snapshot_bytes {
        head += 1;
        publish(feed.as_ref(), head..=head);
    }

    let attached = attach(&feed, &conn, "b", Window::Fixed, None);
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    assert_eq!(attached.decision.start_seq, head + 1);
    respond(&conn, attached, "resp-b");

    let written = conn.drain_text();
    assert_eq!(written[..2], ["control:resp-a", "control:resp-b"]);
    let mut expected_a = vec!["snapshot@0".to_owned()];
    expected_a.extend((1..=head).map(|seq| format!("evt@{seq}")));
    assert_eq!(lane(&written, "a"), expected_a);
    assert_eq!(lane(&written, "b"), [format!("snapshot@{head}")]);

    publish(feed.as_ref(), head + 1..=head + 1);
    let next = [format!("evt@{}", head + 1)];
    let written = conn.drain_text();
    assert_eq!(lane(&written, "a"), next);
    assert_eq!(lane(&written, "b"), next);
}

/// After `detach` the lane receives nothing and holds no bytes.
pub fn detach_stops_delivery(make: &FeedFactory) {
    let limits = MockLimits::default();
    let feed = make(limits);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = attach(&feed, &conn, "a", Window::Fixed, None);
    respond(&conn, attached, "resp");
    publish(feed.as_ref(), 1..=1);
    feed.detach(sub("a"));
    publish(feed.as_ref(), 2..=2);
    assert_eq!(conn.drain_text(), ["control:resp"]);
    assert_eq!(conn.event_free(), limits.event_budget_bytes());
}

/// Attaches racing a publishing producer each receive exactly the snapshot at their `S` and
/// every frame after it: nothing lost, nothing duplicated.
pub fn concurrent_attach_is_gapless(make: &FeedFactory) {
    const LAST: u64 = 2000;
    const SUBSCRIBERS: usize = 8;
    let limits = MockLimits::default();
    let feed = make(limits);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let start = std::sync::Barrier::new(2);
    let attached: Vec<Attached> = std::thread::scope(|scope| {
        scope.spawn(|| {
            start.wait();
            for seq in 1..=LAST {
                publish(feed.as_ref(), seq..=seq);
            }
        });
        start.wait();
        (0..SUBSCRIBERS)
            .map(|i| {
                std::thread::yield_now();
                attach(&feed, &conn, &format!("s{i}"), Window::Fixed, None)
            })
            .collect()
    });
    let mut starts = Vec::new();
    for (i, attached) in attached.into_iter().enumerate() {
        starts.push(attached.decision.start_seq);
        respond(&conn, attached, &format!("resp-{i}"));
    }
    let written = conn.drain_text();
    for (i, start_seq) in starts.into_iter().enumerate() {
        let mut expected = vec![format!("snapshot@{}", start_seq - 1)];
        expected.extend((start_seq..=LAST).map(|seq| format!("evt@{seq}")));
        assert_eq!(
            lane(&written, &format!("s{i}")),
            expected,
            "subscriber s{i}"
        );
    }
}

/// Builds a scoped-feed factory whose feeds have the given limits.
pub type ScopedFeedsFactory = dyn Fn(MockLimits) -> Arc<dyn ScopedFeeds>;

/// A scoped feed attaches through the one algorithm, so it passes [`run_all`]; then the
/// scoped scenarios.
pub fn run_scoped(make: &ScopedFeedsFactory) {
    run_all(&|limits| {
        let feed: Arc<dyn Feed> =
            make(limits).create(FeedId::from("search:conformance"), Arc::new(EchoView));
        feed
    });
    recreated_feed_snapshots(make);
    scoped_feeds_are_independent(make);
    close_ends_every_subscription(make);
}

/// Subscribes to a scoped feed the way a subscribing method's `Reply::Subscribe` is served.
fn scoped_attach(
    feed: &Arc<dyn ScopedFeed>,
    conn: &dyn ConnectionSink,
    name: &str,
    resume: Option<FeedPosition>,
) -> Result<Attached, CoreError> {
    let source: Arc<dyn FeedSource> = feed.clone();
    let resume_from = resume.map(|position| ResumeFrom {
        position,
        window: Window::Fixed,
    });
    subscribe(&source, sub(name), Window::Fixed, resume_from, conn)
}

/// A feed created again under the same id has a new epoch, so a position in its predecessor
/// snapshots even where the seq would be replayable.
pub fn recreated_feed_snapshots(make: &ScopedFeedsFactory) {
    let limits = MockLimits::default();
    let feeds = make(limits);
    let id = FeedId::from("fs:w1");
    let first = feeds.create(id.clone(), Arc::new(EchoView));
    publish(first.as_ref(), 1..=3);
    let old = first.position();
    first.close();

    let second = feeds.create(id, Arc::new(EchoView));
    publish(second.as_ref(), 1..=5);
    assert_ne!(second.position().epoch, old.epoch);
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = scoped_attach(&second, &conn, "a", Some(old)).expect("open feed attaches");
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    assert_eq!(attached.decision.start_seq, 6);
    respond(&conn, attached, "resp");
    assert_eq!(conn.drain_text(), ["control:resp", "a:snapshot@5"]);
}

/// One scoped feed's burst, slow subscriber and held lock never hold up another feed of the
/// same factory. A probe lane runs `b`'s publish and a `b` attach inside `a`'s publish, that
/// is, while `a`'s lock is held, so feeds sharing a lock deadlock here. The subscriber that
/// cannot keep up with `a`'s burst lags alone and recovers through attach; every other lane
/// receives every frame.
pub fn scoped_feeds_are_independent(make: &ScopedFeedsFactory) {
    let limits = small_limits();
    let roomy = MockLimits {
        queue_bytes: 1 << 20,
        ..limits
    };
    let feeds = make(limits);
    let a = feeds.create(FeedId::from("search:a"), Arc::new(EchoView));
    let b = feeds.create(FeedId::from("search:b"), Arc::new(EchoView));
    let slow = MockConnection::new(ConnectionId(1), limits);
    let fast = Arc::new(MockConnection::new(ConnectionId(2), roomy));
    let probe = ProbeConnection::new(ConnectionId(3), roomy);
    let subscriptions: [(&dyn ConnectionSink, &Arc<dyn ScopedFeed>, &str); 4] = [
        (&slow, &a, "sa"),
        (fast.as_ref(), &a, "fa"),
        (fast.as_ref(), &b, "fb"),
        (&probe, &a, "pa"),
    ];
    for (conn, feed, name) in subscriptions {
        let attached = scoped_attach(feed, conn, name, None).expect("open feed attaches");
        respond(conn, attached, name);
    }
    slow.drain();
    fast.drain();
    probe.inner.drain();

    let late = Arc::new(Mutex::new(None));
    probe.arm({
        let b = b.clone();
        let fast = fast.clone();
        let late = late.clone();
        move || {
            publish(b.as_ref(), 1..=1);
            let attached =
                scoped_attach(&b, fast.as_ref(), "fb-late", None).expect("open feed attaches");
            *late.lock().unwrap_or_else(PoisonError::into_inner) = Some(attached);
        }
    });
    publish(a.as_ref(), 1..=40);
    let attached = late
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .expect("the probe ran inside a's publish");
    respond(fast.as_ref(), attached, "resp-late");

    let all: Vec<String> = (1..=40).map(|seq| format!("evt@{seq}")).collect();
    let written = fast.drain_text();
    assert_eq!(written[0], "control:resp-late");
    assert_eq!(lane(&written, "fa"), all);
    assert_eq!(lane(&written, "fb"), ["evt@1"]);
    assert_eq!(lane(&written, "fb-late"), ["snapshot@1"]);
    assert_eq!(lane(&probe.inner.drain_text(), "pa"), all);
    assert_eq!(slow.drain_text(), ["sa:snapshot@40"]);
}

/// `close` ends every subscription: lanes close and return their bytes, later publishes reach
/// no lane, and a later attach answers `connectionClosed` without registering.
pub fn close_ends_every_subscription(make: &ScopedFeedsFactory) {
    let limits = MockLimits::default();
    let feed = make(limits).create(FeedId::from("fs:w"), Arc::new(EchoView));
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = scoped_attach(&feed, &conn, "a", None).expect("open feed attaches");
    respond(&conn, attached, "resp");
    publish(feed.as_ref(), 1..=1);
    assert_eq!(
        conn.drain_text(),
        ["control:resp", "a:snapshot@0", "a:evt@1"]
    );

    publish(feed.as_ref(), 2..=3);
    feed.close();
    assert_eq!(
        conn.event_free(),
        limits.event_budget_bytes(),
        "closed lanes hold no bytes"
    );
    publish(feed.as_ref(), 4..=4);
    let error = scoped_attach(&feed, &conn, "b", None).expect_err("a closed feed registers nothing");
    assert_eq!(error, CoreError::ConnectionClosed);
    feed.close();
    assert!(conn.drain_text().is_empty());
    assert_eq!(conn.event_free(), limits.event_budget_bytes());
}

type Hook = Box<dyn FnOnce() + Send>;

/// A connection whose lanes run the armed hook inside their next `push`, that is, inside the
/// publishing feed's lock.
struct ProbeConnection {
    inner: MockConnection,
    hook: Arc<Mutex<Option<Hook>>>,
}

impl ProbeConnection {
    fn new(id: ConnectionId, limits: MockLimits) -> Self {
        Self {
            inner: MockConnection::new(id, limits),
            hook: Arc::new(Mutex::new(None)),
        }
    }

    fn arm(&self, hook: impl FnOnce() + Send + 'static) {
        *self.hook.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(hook));
    }
}

impl ConnectionSink for ProbeConnection {
    fn id(&self) -> ConnectionId {
        self.inner.id()
    }

    fn send_control(&self, frame: Bytes) -> Result<(), SinkClosed> {
        self.inner.send_control(frame)
    }

    fn send_control_release(&self, frame: Bytes, release: LaneRelease) -> Result<(), SinkClosed> {
        self.inner.send_control_release(frame, release)
    }

    fn open_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        let (inner, release) = self.inner.open_lane(sub, recovery)?;
        let lane = ProbeLane {
            inner,
            hook: self.hook.clone(),
        };
        Ok((Arc::new(lane), release))
    }
}

struct ProbeLane {
    inner: Arc<dyn Lane>,
    hook: Arc<Mutex<Option<Hook>>>,
}

impl Lane for ProbeLane {
    fn sub(&self) -> SubscriptionId {
        self.inner.sub()
    }

    fn try_reserve(&self, bytes: usize) -> Result<Reservation, BudgetFull> {
        self.inner.try_reserve(bytes)
    }

    fn try_reserve_snapshot(&self, bytes: usize) -> Result<Reservation, BudgetFull> {
        self.inner.try_reserve_snapshot(bytes)
    }

    fn push(&self, reservation: Reservation, frame: Bytes) {
        let hook = self
            .hook
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(hook) = hook {
            hook();
        }
        self.inner.push(reservation, frame);
    }

    fn push_slot(&self, reservation: Reservation) -> SnapshotSlot {
        self.inner.push_slot(reservation)
    }

    fn lag(&self) -> usize {
        self.inner.lag()
    }

    fn is_lagged(&self) -> bool {
        self.inner.is_lagged()
    }

    fn close(&self) {
        self.inner.close()
    }
}
