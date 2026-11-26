//! The attach conformance scenarios, P §14.4–14.7 and RL G5 with a scripted actor.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use bytes::Bytes;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::EchoView;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::conformance;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;

use super::CoreFeed;
use super::FeedLimits;

fn feed_limits(limits: MockLimits) -> FeedLimits {
    FeedLimits { ring_bytes: limits.ring_bytes, max_snapshot_bytes: limits.max_snapshot_bytes }
}

// ── scripted actor ──────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Model(BTreeMap<u64, u64>);

impl Model {
    /// The actor's state after event `seq`.
    fn at(seq: u64, keys: u64) -> Self {
        Model((seq.saturating_sub(keys - 1).max(1)..=seq).map(|s| (s % keys, s)).collect())
    }
}

/// Counts snapshot encodes per `(feed, S, window)`.
#[derive(Default)]
struct Encodes(Mutex<HashMap<(FeedId, u64, Window), usize>>);

impl Encodes {
    fn max_per_key(&self) -> usize {
        self.0.lock().unwrap().values().copied().max().unwrap_or(0)
    }

    fn total(&self) -> usize {
        self.0.lock().unwrap().values().sum()
    }
}

struct ModelView {
    feed: FeedId,
    keys: u64,
    encodes: Arc<Encodes>,
}

impl FeedView for ModelView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, window: &Window) -> Bytes {
        *self.encodes.0.lock().unwrap().entry((self.feed.clone(), at.seq, window.clone())).or_default() += 1;
        let body: Vec<String> = Model::at(at.seq, self.keys).0.iter().map(|(k, v)| format!("{k}={v}")).collect();
        Bytes::from(format!("s {} {}", at.seq, body.join(",")))
    }
}

struct Actor {
    feed: Arc<CoreFeed>,
    keys: u64,
    seq: u64,
}

/// A client's folded state and position.
#[derive(Clone, Debug, Default)]
struct Client {
    state: Model,
    last: Option<u64>,
}

impl Client {
    fn at(seq: u64, keys: u64) -> Self {
        Self { state: Model::at(seq, keys), last: Some(seq) }
    }

    fn apply(&mut self, frame: &[u8]) {
        let text = std::str::from_utf8(frame).unwrap();
        let mut parts = text.splitn(3, ' ');
        let kind = parts.next().unwrap();
        let seq: u64 = parts.next().unwrap().parse().unwrap();
        let rest = parts.next().unwrap_or("");
        match kind {
            "s" => {
                self.state = Model(
                    rest.split(',')
                        .filter(|kv| !kv.is_empty())
                        .map(|kv| {
                            let (k, v) = kv.split_once('=').unwrap();
                            (k.parse().unwrap(), v.parse().unwrap())
                        })
                        .collect(),
                );
                self.last = Some(seq);
            }
            "e" => {
                assert_eq!(self.last, Some(seq - 1), "event {seq} must follow the previous position");
                let (key, value) = rest.split_once(' ').unwrap();
                self.state.0.insert(key.parse().unwrap(), value.parse().unwrap());
                self.last = Some(seq);
            }
            other => panic!("unknown frame kind {other}"),
        }
    }

    fn resume_from(&self, epoch: &FeedEpoch, window: &Window) -> Option<ResumeFrom> {
        self.last.map(|seq| ResumeFrom { position: FeedPosition { epoch: epoch.clone(), seq }, window: window.clone(), positioned: None })
    }
}

/// Subscribes and writes the response; returns the decision.
fn attach(feed: &Arc<CoreFeed>, conn: &MockConnection, sub: &str, window: Window, resume_from: Option<ResumeFrom>) -> AttachDecision {
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = subscribe(&source, SubscriptionId::from(sub), window, resume_from, conn).unwrap();
    conn.send_control_release(Bytes::from_static(b"resp"), attached.release).unwrap();
    attached.decision
}

/// Drains the connection, folding the frames of `sub` into `client`. Returns how many lane
/// frames were snapshots.
fn fold(conn: &MockConnection, clients: &mut HashMap<SubscriptionId, Client>) -> usize {
    let mut snapshots = 0;
    for written in conn.drain() {
        let Some(sub) = written.lane else { continue };
        if written.frame.starts_with(b"s ") {
            snapshots += 1;
        }
        clients.get_mut(&sub).expect("frames only of live subscriptions").apply(&written.frame);
    }
    snapshots
}

fn one(sub: &str, client: Client) -> HashMap<SubscriptionId, Client> {
    HashMap::from([(SubscriptionId::from(sub), client)])
}

// ── P §14.4 resume matrix ───────────────────────────────────────────────────────────────

const KEYS: u64 = 4;

/// The client folded the feed to 20 and left; the actor went on to 60. It resumes from
/// `(epoch, seq, window)` with `window`. Returns the decision after asserting that the
/// folded state equals the actor's and a fresh snapshot's.
fn resume_case(limits: MockLimits, other_epoch: bool, seq: u64, resume_window: Window, window: Window) -> AttachDecision {
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("t", KEYS, feed_limits(limits), &encodes);
    actor.run_to(20);
    let first = MockConnection::new(ConnectionId(1), limits);
    attach(&actor.feed, &first, "old", resume_window.clone(), None);
    let mut old = one("old", Client::default());
    fold(&first, &mut old);
    assert_eq!(old[&SubscriptionId::from("old")].state, actor.state());
    actor.feed.detach(SubscriptionId::from("old"));
    actor.run_to(60);

    let epoch = if other_epoch { FeedEpoch::from("ffffffffffffffffffffffffffffffff") } else { actor.feed.position().epoch };
    let client = Client::at(seq, KEYS);
    let resume_from = ResumeFrom { position: FeedPosition { epoch, seq }, window: resume_window, positioned: None };
    let conn = MockConnection::new(ConnectionId(2), limits);
    let decision = attach(&actor.feed, &conn, "new", window.clone(), Some(resume_from));
    let mut resumed = one("new", client);
    fold(&conn, &mut resumed);

    let fresh_conn = MockConnection::new(ConnectionId(3), limits);
    attach(&actor.feed, &fresh_conn, "fresh", window, None);
    let mut fresh = one("fresh", Client::default());
    fold(&fresh_conn, &mut fresh);

    let resumed = &resumed[&SubscriptionId::from("new")];
    assert_eq!(resumed.state, actor.state());
    assert_eq!(resumed.last, Some(60));
    assert_eq!(resumed.state, fresh[&SubscriptionId::from("fresh")].state);
    decision
}

fn small_budget() -> MockLimits {
    MockLimits { queue_bytes: 1024 + 96, control_reserve_bytes: 1024, max_snapshot_bytes: 48, ring_bytes: 1 << 20 }
}

#[test]
fn resume_matrix() {
    let items = Window::LastItems(50);
    let fewer = Window::LastItems(10);
    let default = MockLimits::default();

    let replay = resume_case(default, false, 20, items.clone(), items.clone());
    // The replayed frames (21..=60) were published while the client was away; live frames start after the head.
    assert_eq!((replay.mode, replay.start_seq, replay.live_seq), (AttachMode::Replay, 21, 61));

    let other_epoch = resume_case(default, true, 20, items.clone(), items.clone());
    assert_eq!((other_epoch.mode, other_epoch.start_seq), (AttachMode::Snapshot, 61));

    let evicted = MockLimits { ring_bytes: 100, ..default };
    let outside = resume_case(evicted, false, 20, items.clone(), items.clone());
    assert_eq!((outside.mode, outside.start_seq), (AttachMode::Snapshot, 61));

    let beyond_head = resume_case(default, false, 61, items.clone(), items.clone());
    assert_eq!((beyond_head.mode, beyond_head.start_seq), (AttachMode::Snapshot, 61));

    let changed_window = resume_case(default, false, 20, items.clone(), fewer);
    assert_eq!((changed_window.mode, changed_window.start_seq), (AttachMode::Snapshot, 61));

    let not_fitting = resume_case(small_budget(), false, 20, items.clone(), items.clone());
    assert_eq!((not_fitting.mode, not_fitting.start_seq), (AttachMode::Snapshot, 61));

    let fitting = resume_case(small_budget(), false, 55, items.clone(), items);
    assert_eq!((fitting.mode, fitting.start_seq), (AttachMode::Replay, 56));
}

// ── P §14.5 atomic attach under load ───────────────────────────────────────────────────

/// xorshift64: a deterministic schedule per client thread.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

// ── P §14.6 slow consumer ──────────────────────────────────────────────────────────────

#[test]
fn a_slow_consumer_lags_only_its_own_lanes() {
    let limits = MockLimits { queue_bytes: 4096 + 1024, control_reserve_bytes: 1024, max_snapshot_bytes: 512, ring_bytes: 1 << 20 };
    let encodes = Arc::new(Encodes::default());
    let mut a = Actor::new("a", KEYS, feed_limits(limits), &encodes);
    let mut b = Actor::new("b", KEYS, feed_limits(limits), &encodes);
    let slow = MockConnection::new(ConnectionId(1), limits);
    let reader = MockConnection::new(ConnectionId(2), limits);
    let mut slow_clients = HashMap::new();
    let mut reader_clients = HashMap::new();
    // Subscription ids are unique across connections.
    for (actor, name) in [(&a, "a"), (&b, "b")] {
        attach(&actor.feed, &slow, &format!("slow-{name}"), Window::Fixed, None);
        attach(&actor.feed, &reader, name, Window::Fixed, None);
        slow_clients.insert(SubscriptionId::from(format!("slow-{name}")), Client::default());
        reader_clients.insert(SubscriptionId::from(name), Client::default());
    }
    fold(&slow, &mut slow_clients);
    fold(&reader, &mut reader_clients);

    // `slow` stops reading; `reader` keeps up.
    for step in 1..=50 {
        a.run_to(step * 20);
        b.run_to(step * 20);
        fold(&reader, &mut reader_clients);
    }
    assert_eq!(slow.event_free(), limits.event_budget_bytes(), "lagged lanes hold no bytes");
    for (name, actor) in [("a", &a), ("b", &b)] {
        assert_eq!(reader_clients[&SubscriptionId::from(name)].state, actor.state());
        assert_eq!(reader_clients[&SubscriptionId::from(name)].last, Some(1000));
    }

    // Resuming yields one snapshot per lagged lane, at the head.
    assert_eq!(fold(&slow, &mut slow_clients), 2);
    a.run_to(1001);
    b.run_to(1001);
    assert_eq!(fold(&slow, &mut slow_clients), 0);
    fold(&reader, &mut reader_clients);
    for (name, actor) in [("a", &a), ("b", &b)] {
        let sub = SubscriptionId::from(format!("slow-{name}"));
        assert_eq!(slow_clients[&sub].state, actor.state());
        assert_eq!(slow_clients[&sub].last, Some(1001));
        assert_eq!(reader_clients[&SubscriptionId::from(name)].last, Some(1001));
    }

    // Control reserve exhaustion closes the connection; the feeds go on for the others.
    while slow.send_control(Bytes::from(vec![b'x'; 256])).is_ok() {}
    assert!(slow.is_closed());
    a.run_to(1002);
    fold(&reader, &mut reader_clients);
    assert_eq!(reader_clients[&SubscriptionId::from("a")].last, Some(1002));
}

// ── RL G5 reconnect storm ──────────────────────────────────────────────────────────────

#[test]
fn reconnect_storm_encodes_each_snapshot_once() {
    const SESSIONS: usize = 10;
    const CLIENTS: usize = 50;
    const KEYS: u64 = 16;
    const HEAD: u64 = 400;
    let limits = MockLimits { ring_bytes: 2048, ..MockLimits::default() };
    let encodes = Arc::new(Encodes::default());
    let mut actors: Vec<Actor> = (0..SESSIONS).map(|s| Actor::new(&format!("t{s}"), KEYS, feed_limits(limits), &encodes)).collect();
    for actor in &mut actors {
        actor.run_to(HEAD);
    }
    let feeds: Vec<Arc<CoreFeed>> = actors.iter().map(|a| a.feed.clone()).collect();
    let epoch = feeds[0].position().epoch;

    // Every client was on every session and dropped at once; each reconnects once from a
    // current position, a stale one still in the ring, or one evicted from it, while the
    // sessions keep publishing.
    let start = Barrier::new(CLIENTS + 1);
    let (conns, clients) = std::thread::scope(|scope| {
        let producer = scope.spawn(|| {
            start.wait();
            for round in 1..=40 {
                for actor in &mut actors {
                    actor.run_to(HEAD + round);
                }
            }
        });
        let storm: Vec<_> = (0..CLIENTS)
            .map(|c| {
                let feeds = &feeds;
                let epoch = &epoch;
                let start = &start;
                scope.spawn(move || {
                    let conn = MockConnection::new(ConnectionId(c as u64), limits);
                    let window = [Window::LastItems(50), Window::LastItems(20)][c % 2].clone();
                    let seq = [HEAD, HEAD - 10, HEAD - 300][c % 3];
                    let mut clients = HashMap::new();
                    start.wait();
                    for (s, feed) in feeds.iter().enumerate() {
                        let sub = format!("c{c}-t{s}");
                        let resume_from = ResumeFrom { position: FeedPosition { epoch: epoch.clone(), seq }, window: window.clone(), positioned: None };
                        attach(feed, &conn, &sub, window.clone(), Some(resume_from));
                        clients.insert(SubscriptionId::from(sub), Client::at(seq, KEYS));
                    }
                    (conn, clients)
                })
            })
            .collect();
        producer.join().unwrap();
        storm.into_iter().map(|client| client.join().unwrap()).unzip::<_, _, Vec<_>, Vec<_>>()
    });

    let expected = Model::at(HEAD + 40, KEYS);
    for (conn, mut clients) in conns.into_iter().zip(clients) {
        fold(&conn, &mut clients);
        for (sub, client) in clients {
            assert_eq!(client.last, Some(HEAD + 40), "{sub} is live");
            assert_eq!(client.state, expected, "{sub}");
        }
    }
    assert!(encodes.max_per_key() <= 1, "one encode per (session, S, window)");
    assert!(encodes.total() > 0);
    for feed in &feeds {
        assert_eq!(feed.subscribers(), CLIENTS);
    }
}

/// A view whose snapshot carries a value of the moment it is delivered: encoded once, set again for each lane.
struct ClockView {
    encodes: Arc<std::sync::atomic::AtomicUsize>,
    now: Arc<std::sync::atomic::AtomicU64>,
}

impl FeedView for ClockView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
        self.encodes.fetch_add(1, Ordering::SeqCst);
        Bytes::from(format!("s {} wait={}", at.seq, self.now.load(Ordering::SeqCst)))
    }

    fn at_delivery(&self, frame: Bytes) -> Bytes {
        let seq = String::from_utf8_lossy(&frame).split(' ').nth(1).unwrap_or("0").to_owned();
        Bytes::from(format!("s {seq} wait={}", self.now.load(Ordering::SeqCst)))
    }
}

fn first_snapshot(conn: &MockConnection) -> String {
    for _ in 0..5_000 {
        for written in conn.drain() {
            if written.frame.starts_with(b"s ") {
                return String::from_utf8(written.frame.to_vec()).unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("no snapshot reached the connection");
}

/// A view that lags its frames (`publish_deferred`, a burst of streaming deltas) still serves a fresh attach: the snapshot is
/// the view's at the seq it was built for and the deferred frames follow it, so the client folds to the actor's state with no
/// gap; once the ring no longer holds them, the attach lags until a current view is swapped in.
#[tokio::test]
async fn a_deferred_view_serves_an_attach_its_snapshot_and_the_frames_after_it() {
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("deferred", KEYS, FeedLimits { ring_bytes: 64 << 10, max_snapshot_bytes: 4096 }, &encodes);
    actor.run_to(10);
    use mixdog_core_api::feed::Feed as _;
    assert!(actor.feed.defers());
    let deferred: Vec<FeedFrame> = (11..=20).map(|seq| FeedFrame::new(seq, Bytes::from(format!("e {seq} {} {seq}", seq % KEYS)))).collect();
    actor.feed.publish_deferred(&deferred).unwrap();
    actor.seq = 20;
    actor.feed.publish(&[], None).unwrap();
    let conn = MockConnection::new(ConnectionId(77), MockLimits::default());
    let decision = attach(&actor.feed, &conn, "a", Window::Fixed, None);
    assert_eq!(decision.mode, AttachMode::Snapshot);
    assert_eq!(decision.start_seq, 11, "the snapshot is the view's, at 10");
    let written = tokio::time::timeout(Duration::from_secs(10), conn.drain_text_until(|written| written.iter().any(|frame| frame == "a:e 20 0 20")))
        .await
        .expect("snapshot and deferred suffix were delivered");
    assert_eq!(
        written,
        [
            "control:resp",
            "a:s 10 0=8,1=9,2=10,3=7",
            "a:e 11 3 11",
            "a:e 12 0 12",
            "a:e 13 1 13",
            "a:e 14 2 14",
            "a:e 15 3 15",
            "a:e 16 0 16",
            "a:e 17 1 17",
            "a:e 18 2 18",
            "a:e 19 3 19",
            "a:e 20 0 20",
        ]
    );
    // A normal publish brings the view current, with nothing left to replay.
    actor.run_to(21);
    let decision = attach(&actor.feed, &conn, "b", Window::Fixed, None);
    assert_eq!(decision.start_seq, 22);
}

/// A feed no client has attached to keeps none of the frames its view already describes: no client holds a position to
/// resume from, and an attach is served the view. From the first attach on, the ring keeps them for a resume.
#[test]
fn a_feed_nobody_watched_keeps_no_frame_its_view_describes() {
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("unwatched", KEYS, FeedLimits { ring_bytes: 64 << 10, max_snapshot_bytes: 4096 }, &encodes);
    actor.run_to(40);
    assert_eq!(actor.feed.ring_held(), 0);
    let conn = MockConnection::new(ConnectionId(78), MockLimits::default());
    let decision = attach(&actor.feed, &conn, "a", Window::Fixed, None);
    assert_eq!((decision.mode, decision.start_seq), (AttachMode::Snapshot, 41));
    let mut clients = one("a", Client::default());
    fold(&conn, &mut clients);
    assert_eq!(clients[&SubscriptionId::from("a")].state.0, actor.state().0);
    actor.feed.detach(SubscriptionId::from("a"));
    actor.run_to(60);
    assert!(actor.feed.ring_held() > 0);
    let resume = ResumeFrom { position: FeedPosition { epoch: actor.feed.position().epoch, seq: 40 }, window: Window::Fixed, positioned: None };
    let decision = attach(&actor.feed, &conn, "b", Window::Fixed, Some(resume));
    assert_eq!((decision.mode, decision.start_seq), (AttachMode::Replay, 41));
}

/// A watched feed whose producer rests holds none of the frames its view describes: the subscriber still attached hears the
/// next frame, one that comes back at the head is told it missed nothing, and one from before is served the view.
#[test]
fn a_resting_feed_keeps_no_frame_its_view_describes_and_serves_the_view_to_an_older_position() {
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("resting", KEYS, FeedLimits { ring_bytes: 64 << 10, max_snapshot_bytes: 4096 }, &encodes);
    let conn = MockConnection::new(ConnectionId(79), MockLimits::default());
    attach(&actor.feed, &conn, "a", Window::Fixed, None);
    actor.run_to(40);
    assert!(actor.feed.ring_held() > 0);
    actor.feed.rest();
    assert_eq!(actor.feed.ring_held(), 0);
    let epoch = actor.feed.position().epoch;
    let at = |seq| ResumeFrom { position: FeedPosition { epoch: epoch.clone(), seq }, window: Window::Fixed, positioned: None };
    let decision = attach(&actor.feed, &conn, "head", Window::Fixed, Some(at(40)));
    assert_eq!((decision.mode, decision.start_seq), (AttachMode::Replay, 41));
    let decision = attach(&actor.feed, &conn, "older", Window::Fixed, Some(at(30)));
    assert_eq!((decision.mode, decision.start_seq), (AttachMode::Snapshot, 41));
    actor.run_to(45);
    let mut clients = HashMap::from([
        (SubscriptionId::from("a"), Client::default()),
        (SubscriptionId::from("head"), Client::at(40, KEYS)),
        (SubscriptionId::from("older"), Client::default()),
    ]);
    fold(&conn, &mut clients);
    for client in clients.values() {
        assert_eq!(client.state, actor.state());
    }
}

/// A feed that rests drops the snapshots encoded of its view with its frames: a resting thread keeps none, and an attach after
/// the rest is served the view encoded again.
#[test]
fn a_resting_feed_drops_the_snapshots_of_its_view() {
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("resting-snapshots", KEYS, FeedLimits { ring_bytes: 64 << 10, max_snapshot_bytes: 4096 }, &encodes);
    actor.run_to(10);
    let conn = MockConnection::new(ConnectionId(80), MockLimits::default());
    let decision = attach(&actor.feed, &conn, "a", Window::Fixed, None);
    assert_eq!(decision.mode, AttachMode::Snapshot);
    let mut clients = one("a", Client::default());
    fold(&conn, &mut clients);
    assert_eq!(actor.feed.snapshots_held(), 1, "the encoded view is cached for the next attach");
    actor.feed.rest();
    assert_eq!(actor.feed.snapshots_held(), 0);
    let decision = attach(&actor.feed, &conn, "b", Window::Fixed, None);
    assert_eq!(decision.mode, AttachMode::Snapshot);
    let mut clients = HashMap::from([(SubscriptionId::from("a"), Client::default()), (SubscriptionId::from("b"), Client::default())]);
    assert_eq!(fold(&conn, &mut clients), 1, "the view is encoded again");
    assert_eq!(clients[&SubscriptionId::from("b")].state, actor.state());
}

fn cpu() -> CpuInteractive {
    mixdog_rt::testing::tokens().cpu_interactive
}
#[test]
fn passes_the_attach_conformance_scenarios() {
    conformance::run_all(&|limits| Arc::new(CoreFeed::new(FeedId::from("app"), epoch(9), Arc::new(EchoView), feed_limits(limits), cpu())));
}
#[test]
fn passes_the_scoped_feed_conformance_scenarios() {
    conformance::run_scoped(&|limits| Arc::new(super::CoreScopedFeeds::new(feed_limits(limits), cpu())));
}
#[test]
fn a_scoped_feed_is_found_by_its_id_while_its_owner_holds_it() {
    use mixdog_core_api::feed::ScopedFeeds;
    let feeds = super::CoreScopedFeeds::new(feed_limits(MockLimits::default()), cpu());
    let id = FeedId::from("login:flow1");
    assert!(feeds.find(&id).is_none());
    let feed = feeds.create(id.clone(), Arc::new(EchoView));
    assert_eq!(feeds.find(&id).expect("live").feed_id(), id);
    assert!(feeds.find(&FeedId::from("login:other")).is_none());
    drop(feed);
    assert!(feeds.find(&id).is_none());
}

#[test]
fn scoped_feed_last_detach_runs_through_registry_find_replacement() {
    use std::sync::atomic::AtomicUsize;

    use mixdog_core_api::feed::ScopedFeeds;

    let limits = MockLimits::default();
    let feeds = super::CoreScopedFeeds::new(feed_limits(limits), cpu());
    let id = FeedId::from("search:s1");
    let detached = Arc::new(AtomicUsize::new(0));
    let owner_feed: Arc<Mutex<Option<Arc<dyn mixdog_core_api::feed::ScopedFeed>>>> = Arc::new(Mutex::new(None));
    let feed = feeds.create_watching_detach(id.clone(), Arc::new(EchoView), {
        let detached = Arc::clone(&detached);
        let owner_feed = Arc::clone(&owner_feed);
        Arc::new(move || {
            detached.fetch_add(1, Ordering::SeqCst);
            // Owner cleanup closes the feed from inside the callback: must not deadlock.
            if let Some(live) = owner_feed.lock().unwrap().take() {
                live.close();
            }
        })
    });
    *owner_feed.lock().unwrap() = Some(feed.clone());

    let initial: Arc<dyn FeedSource> = feed.clone();
    let looked_up = feeds.find(&id).expect("feed/subscribe lookup finds live scoped feed");
    let c1 = MockConnection::new(ConnectionId(1), limits);
    let c2 = MockConnection::new(ConnectionId(2), limits);

    let sub1 = SubscriptionId::from("initial");
    let sub2 = SubscriptionId::from("replacement");
    let _a1 = subscribe(&initial, sub1.clone(), Window::Fixed, None, &c1).unwrap();
    let _a2 = subscribe(&looked_up, sub2.clone(), Window::Fixed, None, &c2).unwrap();
    assert_eq!(feed.subscribers(), 2);

    // Original subscription detaches while replacement from `feed/subscribe` is still attached.
    initial.detach(sub1.clone());
    assert_eq!(feed.subscribers(), 1);
    assert_eq!(detached.load(Ordering::SeqCst), 0);

    // Final subscriber detaches through the `feed/subscribe` source: cleanup fires once.
    looked_up.detach(sub2.clone());
    assert_eq!(feed.subscribers(), 0);
    assert_eq!(detached.load(Ordering::SeqCst), 1);

    // Repeated or unknown detaches do not re-fire cleanup.
    initial.detach(sub1);
    looked_up.detach(sub2);
    looked_up.detach(SubscriptionId::from("never-attached"));
    assert_eq!(detached.load(Ordering::SeqCst), 1);
}
impl Actor {
    fn new(name: &str, keys: u64, limits: FeedLimits, encodes: &Arc<Encodes>) -> Self {
        let id = FeedId::from(name);
        let view = Arc::new(ModelView { feed: id.clone(), keys, encodes: encodes.clone() });
        Self { feed: Arc::new(CoreFeed::new(id, epoch(42), view, limits, cpu())), keys, seq: 0 }
    }

    /// Publishes events up to `last` (the view encodes from the seq it is asked for).
    fn run_to(&mut self, last: u64) {
        while self.seq < last {
            self.seq += 1;
            let seq = self.seq;
            let frame = FeedFrame::new(seq, Bytes::from(format!("e {seq} {} {seq}", seq % self.keys)));
            self.feed.publish(&[frame], None).unwrap();
        }
    }

    fn state(&self) -> Model {
        Model::at(self.seq, self.keys)
    }
}
#[test]
fn attach_under_load_folds_to_the_actor_state() {
    const EVENTS: u64 = 10_000;
    const CONNECTIONS: u64 = 50;
    const KEYS: u64 = 64;
    /// How long a connection may take to fold the last event before the test fails by name (a bound, not a wait).
    const CAUGHT_UP_WITHIN: Duration = Duration::from_secs(120);
    let snapshot_bytes = 2048;
    let limits = FeedLimits { ring_bytes: 64 << 10, max_snapshot_bytes: snapshot_bytes };
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("busy", KEYS, limits, &encodes);
    let feed = actor.feed.clone();
    let epoch = feed.position().epoch;
    let done = AtomicBool::new(false);
    let start = Barrier::new(CONNECTIONS as usize + 1);

    let clients = std::thread::scope(|scope| {
        let producer = scope.spawn(|| {
            start.wait();
            actor.run_to(EVENTS);
            done.store(true, Ordering::Release);
        });
        let clients: Vec<_> = (0..CONNECTIONS)
            .map(|i| {
                let feed = &feed;
                let epoch = &epoch;
                let done = &done;
                let start = &start;
                scope.spawn(move || {
                    // Every fifth connection has a 16 KiB event budget, so it lags and
                    // recovers while the producer runs.
                    let queue_bytes = if i % 5 == 0 { 64 << 10 } else { 8 << 20 };
                    let conn_limits = MockLimits { queue_bytes, control_reserve_bytes: 48 << 10, max_snapshot_bytes: snapshot_bytes, ring_bytes: 0 };
                    let conn = MockConnection::new(ConnectionId(i), conn_limits);
                    let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (i + 1));
                    let mut client = Client::default();
                    let mut current: Option<SubscriptionId> = None;
                    let mut attaches = 0u64;
                    let windows = [Window::LastItems(50), Window::LastItems(20)];
                    let mut window = windows[0].clone();
                    start.wait();
                    let began = std::time::Instant::now();
                    loop {
                        let finished = done.load(Ordering::Acquire);
                        match &current {
                            None => {
                                attaches += 1;
                                let sub = SubscriptionId::from(format!("c{i}-{attaches}"));
                                if rng.next().is_multiple_of(4) {
                                    window = windows[(rng.next() % 2) as usize].clone();
                                }
                                let resume_from = client.resume_from(epoch, &window);
                                attach(feed, &conn, sub.as_str(), window.clone(), resume_from);
                                current = Some(sub);
                            }
                            Some(sub) => {
                                let mut lanes = one(sub.as_str(), client.clone());
                                fold(&conn, &mut lanes);
                                client = lanes.remove(sub).unwrap();
                                if !finished && rng.next().is_multiple_of(8) {
                                    feed.detach(sub.clone());
                                    current = None;
                                }
                            }
                        }
                        // An attach's snapshot is encoded off this thread, so a connection is done only once it has
                        // folded the last event: one that attached after the producer finished has nothing yet.
                        if finished && current.is_some() && client.last == Some(EVENTS) {
                            break;
                        }
                        assert!(
                            began.elapsed() < CAUGHT_UP_WITHIN,
                            "connection {i} did not fold event {EVENTS} within {CAUGHT_UP_WITHIN:?}: last {:?} after {attaches} attaches",
                            client.last
                        );
                        std::thread::yield_now();
                    }
                    let sub = current.unwrap();
                    let mut lanes = one(sub.as_str(), client);
                    fold(&conn, &mut lanes);
                    (lanes.remove(&sub).unwrap(), attaches)
                })
            })
            .collect();
        producer.join().unwrap();
        clients.into_iter().map(|client| client.join().unwrap()).collect::<Vec<_>>()
    });

    let expected = Model::at(EVENTS, KEYS);
    for (i, (client, attaches)) in clients.iter().enumerate() {
        assert_eq!(client.last, Some(EVENTS), "connection {i}");
        assert_eq!(client.state, expected, "connection {i} after {attaches} attaches");
    }
    assert!(encodes.max_per_key() <= 1, "one encode per (feed, S, window)");
}
/// A snapshot encode runs after the feed lock is released: while one is in progress, the
/// same feed and every other feed publish and attach.
#[test]
fn a_snapshot_encode_never_blocks_a_publish() {
    struct BlockingView {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl FeedView for BlockingView {
        fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Bytes::from(format!("s {} ", at.seq))
        }
    }

    let limits = MockLimits::default();
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let blocked = Arc::new(CoreFeed::new(
        FeedId::from("blocked"),
        epoch(1),
        Arc::new(BlockingView { entered: entered_tx, release: Mutex::new(release_rx) }),
        feed_limits(limits),
        cpu(),
    ));
    let encodes = Arc::new(Encodes::default());
    let mut other = Actor::new("other", KEYS, feed_limits(limits), &encodes);
    let conn = MockConnection::new(ConnectionId(1), limits);

    std::thread::scope(|scope| {
        let attaching = scope.spawn(|| attach(&blocked, &conn, "x", Window::Fixed, None));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();

        let (published_tx, published) = mpsc::channel();
        let blocked = &blocked;
        let other = &mut other;
        scope.spawn(move || {
            let frame = FeedFrame::new(1, Bytes::from_static(b"e 1 1 1"));
            blocked.publish(&[frame], None).unwrap();
            other.run_to(100);
            let reader = MockConnection::new(ConnectionId(2), limits);
            attach(&other.feed, &reader, "y", Window::Fixed, None);
            published_tx.send(()).unwrap();
        });
        published.recv_timeout(Duration::from_secs(10)).expect("publish and attach proceed during a snapshot encode");
        release.send(()).unwrap();
        attaching.join().unwrap();
    });
    let text: Vec<String> = conn.drain_text().into_iter().filter(|w| w.starts_with("x:")).collect();
    assert_eq!(text, ["x:s 0 ", "x:e 1 1 1"]);
}
// ── P §14.7 bounds ─────────────────────────────────────────────────────────────────────

#[test]
fn ring_memory_stays_within_ring_bytes() {
    let ring_bytes = 4096;
    let limits = MockLimits { ring_bytes, max_snapshot_bytes: 1024, ..MockLimits::default() };
    let feed = Arc::new(CoreFeed::new(FeedId::from("t"), epoch(3), Arc::new(EchoView), feed_limits(limits), cpu()));
    // The connection's event budget fits the whole stream, so the watcher stays live.
    let watcher = MockConnection::new(ConnectionId(1), limits);
    attach(&feed, &watcher, "watcher", Window::Fixed, None);
    let mut rng = Rng(7);
    for seq in 1..=5000 {
        let len = 1 + (rng.next() % 700) as usize;
        let frame = FeedFrame::new(seq, Bytes::from(vec![b'e'; len]));
        feed.publish(&[frame], None).unwrap();
        let held = feed.ring_held();
        assert!((1..=ring_bytes).contains(&held), "held {held} bytes after seq {seq}");
    }
}
#[tokio::test]
async fn window_churn_evicts_completed_encodings_without_changing_the_snapshot() {
    let limits = MockLimits { max_snapshot_bytes: 32, ..MockLimits::default() };
    let encodes = Arc::new(Encodes::default());
    let mut actor = Actor::new("churn", KEYS, feed_limits(limits), &encodes);
    actor.run_to(4);
    let conn = MockConnection::new(ConnectionId(1), limits);

    // Each reservation fits; holding the completed frames across these windows does not.
    for n in (1..=8).chain(std::iter::once(1)) {
        let decision = attach(&actor.feed, &conn, "a", Window::LastItems(n), None);
        assert_eq!((decision.mode, decision.start_seq), (AttachMode::Snapshot, 5));
        let written = tokio::time::timeout(Duration::from_secs(10), conn.drain_text_until(|written| written.iter().any(|frame| frame.starts_with("a:s "))))
            .await
            .expect("snapshot was delivered");
        assert_eq!(written, ["control:resp", "a:s 4 0=4,1=1,2=2,3=3"]);
        actor.feed.detach(SubscriptionId::from("a"));
    }

    let first = (actor.feed.feed_id(), 4, Window::LastItems(1));
    assert_eq!(encodes.0.lock().unwrap()[&first], 2, "the first window re-encoded");
}

#[test]
fn a_cached_snapshot_is_set_for_the_moment_of_each_delivery() {
    let encodes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let now = Arc::new(std::sync::atomic::AtomicU64::new(100));
    let view = Arc::new(ClockView { encodes: encodes.clone(), now: now.clone() });
    let limits = MockLimits::default();
    let feed = Arc::new(CoreFeed::new(FeedId::from("clock"), epoch(42), view, feed_limits(limits.clone()), cpu()));
    let first = MockConnection::new(ConnectionId(1), limits.clone());
    attach(&feed, &first, "a", Window::Fixed, None);
    assert_eq!(first_snapshot(&first), "s 0 wait=100");
    // Time moves on; a second client attaches at the same sequence and is handed the cached encode, set for its own delivery.
    now.store(40, Ordering::SeqCst);
    let second = MockConnection::new(ConnectionId(2), limits);
    attach(&feed, &second, "b", Window::Fixed, None);
    assert_eq!(first_snapshot(&second), "s 0 wait=40");
    assert_eq!(encodes.load(Ordering::SeqCst), 1, "one encode served both");
}

// ── positioned grants ───────────────────────────────────────────────────────────────────

mod positioned {
    use mixdog_core_api::error::CoreError;
    use mixdog_core_api::feed::GrantAsk;
    use mixdog_core_api::feed::GrantRange;
    use mixdog_core_api::feed::Held;

    use super::*;

    /// A view whose positioned snapshot holds the records 8..=10 of lineage 1 and follows the tail from 11.
    struct TailView;

    impl FeedView for TailView {
        fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
            Bytes::from(format!("snap@{}", at.seq))
        }

        fn at_window_version(&self, frame: Bytes, version: u64) -> Bytes {
            Bytes::from(format!("{}v{version}", String::from_utf8_lossy(&frame)))
        }

        fn first_grant(&self, _window: &Window) -> Option<GrantAsk> {
            Some(GrantAsk { lineage: 1, ranges: vec![GrantRange::of(8, 10)], tail_from: Some(11) })
        }
    }

    fn feed(limits: MockLimits) -> Arc<CoreFeed> {
        Arc::new(CoreFeed::new(FeedId::from("t"), epoch(5), Arc::new(TailView), feed_limits(limits), cpu()))
    }

    /// A frame that tells a record's rows: a positioned subscription gets it with no row.
    fn row(seq: u64) -> FeedFrame {
        FeedFrame { seq, bytes: Bytes::from(format!("legacy@{seq}")), positioned: Some(Bytes::from(format!("progress@{seq}"))) }
    }

    /// The stored record `ordinal` of `lineage`, delivered as it reads.
    fn unit_of(feed: &Arc<CoreFeed>, lineage: u64, ordinal: u64) {
        feed.deliver(lineage, ordinal, &format!("p{ordinal}"), Some("before"), None, &mut |held, at| {
            let how = if held == Held::Tail { "insert" } else { "replace" };
            Bytes::from(format!("{how}#{ordinal}@{}", at.seq))
        });
    }

    fn unit(feed: &Arc<CoreFeed>, ordinal: u64) {
        unit_of(feed, 1, ordinal);
    }

    fn ask(ranges: &[(u64, u64)], tail_from: Option<u64>) -> GrantAsk {
        GrantAsk { lineage: 1, ranges: ranges.iter().map(|(first, last)| GrantRange::of(*first, *last)).collect(), tail_from }
    }

    fn sub(name: &str) -> SubscriptionId {
        SubscriptionId::from(name)
    }

    /// What the connection's lanes were written, without its control frames.
    fn lanes(conn: &MockConnection) -> Vec<String> {
        conn.drain_text().into_iter().filter(|frame| !frame.starts_with("control:")).collect()
    }

    /// Changes `name`'s grant from `base` and fills the fence's slot with `told`; the new version.
    fn regrant(feed: &Arc<CoreFeed>, name: &str, base: u64, to: GrantAsk, told: &str) -> u64 {
        let fence = feed.regrant(&sub(name), base, to).expect("the grant changes");
        fence.slot.fill(Bytes::from(format!("{told}@{}", fence.at.seq)));
        fence.version
    }

    #[test]
    fn a_stored_record_reaches_the_subscriptions_whose_grants_hold_it_and_no_other() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let (a, b, plain) =
            (MockConnection::new(ConnectionId(1), limits), MockConnection::new(ConnectionId(2), limits), MockConnection::new(ConnectionId(3), limits));
        attach(&feed, &a, "a", Window::Positioned(3), None);
        attach(&feed, &b, "b", Window::Positioned(3), None);
        attach(&feed, &plain, "p", Window::LastItems(3), None);
        assert_eq!(lanes(&a), ["a:snap@0v0"]);
        assert_eq!(lanes(&b), ["b:snap@0v0"]);
        assert_eq!(lanes(&plain), ["p:snap@0"]);
        let first = feed.grant(&sub("a")).expect("a positioned subscription holds a grant");
        assert_eq!((first.version, first.spans(), first.tail_from), (0, vec![(8, 10)], Some(11)));
        assert!(feed.grant(&sub("p")).is_none());
        assert_eq!((feed.owner(&sub("a")), feed.owner(&sub("b")), feed.owner(&sub("gone"))), (Some(ConnectionId(1)), Some(ConnectionId(2)), None));

        // A lets go of record 9 and keeps the tail; B keeps it. A frame that tells rows has none for either.
        let released = regrant(&feed, "a", first.version, ask(&[(10, 10)], Some(11)), "released");
        feed.publish(&[row(1), FeedFrame::new(2, Bytes::from_static(b"evt@2"))], None).unwrap();
        unit(&feed, 9);
        unit(&feed, 12);
        assert_eq!(lanes(&a), ["a:released@0", "a:progress@1", "a:evt@2", "a:insert#12@2"], "nothing of the released record, and every seq");
        assert_eq!(lanes(&b), ["b:progress@1", "b:evt@2", "b:replace#9@2", "b:insert#12@2"]);
        assert_eq!(lanes(&plain), ["p:legacy@1", "p:evt@2"], "a subscription that did not opt in keeps today's frames");
        // What the tail was sent is a range the subscription holds: a later change of it replaces.
        let grown = feed.grant(&sub("b")).expect("held");
        assert_eq!((grown.version, grown.tail_from), (first.version, Some(13)), "a record joining the tail is no change of the ranges named");
        let tail = grown.ranges.iter().find(|range| &*range.id == mixdog_core_api::feed::TAIL_RANGE).expect("the tail's range");
        assert_eq!((tail.first, tail.last, &*tail.to), (12, 12, "p12"));
        unit(&feed, 12);
        assert_eq!(lanes(&b), ["b:replace#12@2"]);
        assert_eq!(lanes(&a), ["a:replace#12@2"]);

        // A stops following the tail: a shrink, and its tail does not grow.
        let shrunk = regrant(&feed, "a", released, ask(&[(10, 10)], None), "shrunk");
        unit(&feed, 13);
        assert_eq!(lanes(&a), ["a:shrunk@2"]);
        assert_eq!(lanes(&b), ["b:insert#13@2"]);

        // A pages back over record 9: a later change of it is A's again.
        let paged = regrant(&feed, "a", shrunk, ask(&[(10, 10), (9, 9)], None), "added");
        assert_eq!(feed.grant(&sub("a")).expect("held").spans(), [(9, 9), (10, 10)], "ascending, each as it was asked");
        unit(&feed, 9);
        assert_eq!(lanes(&a), ["a:added@2", "a:replace#9@2"]);
        assert!(released < shrunk && shrunk < paged);
        assert_eq!(feed.held(1).iter().filter(|range| (range.first, range.last) == (9, 9)).count(), 1);
        assert!(feed.held(2).is_empty());

        // An ask made of ranges the subscription no longer holds changes nothing.
        assert!(matches!(feed.regrant(&sub("a"), shrunk, ask(&[], None)), Err(CoreError::PreconditionFailed { .. })));
        assert!(matches!(feed.regrant(&sub("p"), 0, ask(&[], None)), Err(CoreError::InvalidParams { .. })));
        assert_eq!(feed.grant(&sub("a")).expect("held").version, paged);
    }

    #[test]
    fn a_grant_change_lands_at_its_fence_between_what_the_old_grant_was_sent_and_the_new() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        assert_eq!(lanes(&a), ["a:snap@0v0"]);
        // Queued and not yet written when the grant changes: the old grant's unit.
        unit(&feed, 9);
        let fence = feed.regrant(&sub("a"), 0, ask(&[], Some(11))).expect("the grant changes");
        assert_eq!(fence.at.seq, 0);
        // Delivered while the change's message is still being encoded: by the new grant, behind the slot.
        unit(&feed, 9);
        unit(&feed, 11);
        assert_eq!(lanes(&a), ["a:replace#9@0"], "nothing passes the unfilled slot");
        fence.slot.fill(Bytes::from_static(b"changed"));
        assert_eq!(lanes(&a), ["a:changed", "a:insert#11@0"]);
    }

    #[test]
    fn a_subscription_gone_before_its_grant_is_installed_changes_nothing() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let (a, b) = (MockConnection::new(ConnectionId(1), limits), MockConnection::new(ConnectionId(2), limits));
        attach(&feed, &a, "a", Window::Positioned(3), None);
        attach(&feed, &b, "b", Window::Positioned(3), None);
        lanes(&a);
        lanes(&b);
        feed.detach(sub("a"));
        assert!(matches!(feed.regrant(&sub("a"), 0, ask(&[], None)), Err(CoreError::ConnectionClosed)));
        unit(&feed, 9);
        assert!(lanes(&a).is_empty());
        assert_eq!(lanes(&b), ["b:replace#9@0"]);
    }

    #[test]
    fn a_recovered_lane_starts_again_from_the_snapshots_grant_at_a_version_it_never_had() {
        let limits = small_budget();
        let feed = feed(limits);
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        assert_eq!(lanes(&a), ["a:snap@0v0"]);
        // A holds an old range, record 3, and nothing of the tail; two demands at one seq take the versions 1 and 2.
        let paged = regrant(&feed, "a", 0, ask(&[(3, 3)], None), "paged");
        let again = regrant(&feed, "a", paged, ask(&[(3, 3)], None), "again");
        assert_eq!((paged, again), (1, 2));
        unit(&feed, 3);
        assert_eq!(lanes(&a), ["a:paged@0", "a:again@0", "a:replace#3@0"]);
        // More than the connection's event budget holds: the lane lags and is recovered by a snapshot, at feed seq 1.
        feed.publish(&[FeedFrame::new(1, Bytes::from(vec![b'x'; 4096]))], None).unwrap();
        assert!(matches!(feed.regrant(&sub("a"), again, ask(&[(3, 3)], None)), Err(CoreError::PreconditionFailed { .. })), "a lane being recovered");
        assert_eq!(lanes(&a), ["a:snap@1v3"], "the snapshot states the version its grant took");
        // The snapshot's ranges are all it holds, under a version no grant of this subscription had.
        let recovered = feed.grant(&sub("a")).expect("held");
        assert_eq!((recovered.version, recovered.spans(), recovered.tail_from), (3, vec![(8, 10)], Some(11)));
        for stale in [0, paged, again] {
            assert!(matches!(feed.regrant(&sub("a"), stale, ask(&[], None)), Err(CoreError::PreconditionFailed { .. })), "a demand of the grant {stale}");
        }
        unit(&feed, 3);
        unit(&feed, 9);
        assert_eq!(lanes(&a), ["a:replace#9@1"], "the old range is void");
        // Asked again, from the snapshot's version, it is A's once more.
        regrant(&feed, "a", recovered.version, ask(&[(3, 3), (8, 10)], Some(11)), "paged");
        unit(&feed, 3);
        assert_eq!(lanes(&a), ["a:paged@1", "a:replace#3@1"]);
    }

    #[test]
    fn the_ring_counts_every_form_of_a_frame_it_holds() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        // Watched, so the ring keeps what it is given.
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        let (tagged, plain) = (row(1), FeedFrame::new(2, Bytes::from_static(b"evt@2")));
        let held = "legacy@1".len() + "progress@1".len() + "evt@2".len();
        assert_eq!(tagged.held_bytes() + plain.held_bytes(), held);
        feed.publish(&[tagged, plain], None).unwrap();
        assert_eq!(feed.ring_held(), held);
    }

    #[test]
    fn a_lineage_change_rebases_each_grant_and_a_record_of_the_old_lineage_reaches_no_one() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let (a, plain) = (MockConnection::new(ConnectionId(1), limits), MockConnection::new(ConnectionId(2), limits));
        attach(&feed, &a, "a", Window::Positioned(3), None);
        attach(&feed, &plain, "p", Window::LastItems(3), None);
        lanes(&a);
        lanes(&plain);
        // A rewind to record 10: lineage 2 keeps 8..=9, and the tail follows from 10.
        feed.publish(&[FeedFrame::new(1, Bytes::from_static(b"reset@1"))], None).unwrap();
        let mut asked = Vec::new();
        feed.rebase(&mut |sub, held, version, at| {
            asked.push((sub.clone(), held.lineage, at.seq));
            Some((GrantAsk { lineage: 2, ranges: vec![GrantRange::of(8, 9)], tail_from: Some(10) }, Bytes::from(format!("rebased@{version}"))))
        });
        assert_eq!(asked, [(sub("a"), 1, 1)], "only a positioned subscription holds a grant");
        unit_of(&feed, 2, 12);
        unit_of(&feed, 1, 9);
        unit_of(&feed, 2, 9);
        assert_eq!(lanes(&a), ["a:reset@1", "a:rebased@1", "a:insert#12@1", "a:replace#9@1"], "a record of the old lineage is not sent");
        assert_eq!(lanes(&plain), ["p:reset@1"]);
    }

    fn positioned_resume(feed: &Arc<CoreFeed>, seq: u64, window: Window, sub_id: &str, window_version: u64) -> ResumeFrom {
        ResumeFrom {
            position: FeedPosition { epoch: feed.position().epoch, seq },
            window,
            positioned: Some(mixdog_core_api::feed::PositionedResume { subscription_id: SubscriptionId::from(sub_id), window_version }),
        }
    }

    #[test]
    fn positioned_short_drop_replays_missed_frames_and_deliveries_and_continues_grant() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        assert_eq!(lanes(&a), ["a:snap@0v0"]);

        // Client pages up to hold 4..=5 alongside 8..=10 and tail from 11.
        let v1 = regrant(&feed, "a", 0, ask(&[(4, 5), (8, 10)], Some(11)), "paged");
        assert_eq!(v1, 1);
        feed.publish(&[row(1)], None).unwrap();
        unit(&feed, 11);
        assert_eq!(lanes(&a), ["a:paged@0", "a:progress@1", "a:insert#11@1"]);

        // Phone drops at seq 1, windowVersion 1.
        feed.detach(sub("a"));

        // Deliveries standing at seq 1, then frames 2..=3, then deliveries at seq 3.
        unit(&feed, 12);
        unit(&feed, 4);
        unit(&feed, 6); // outside grant; must not be sent
        feed.publish(&[row(2), FeedFrame::new(3, Bytes::from_static(b"evt@3"))], None).unwrap();
        unit(&feed, 13);
        unit(&feed, 12); // replace of the record inserted while disconnected

        let b = MockConnection::new(ConnectionId(2), limits);
        let resume = positioned_resume(&feed, 1, Window::Positioned(3), "a", v1);
        let decision = attach(&feed, &b, "b", Window::Positioned(3), Some(resume));
        assert_eq!((decision.mode, decision.start_seq, decision.live_seq), (AttachMode::Replay, 2, 4));
        assert_eq!(lanes(&b), ["b:insert#11@1", "b:insert#12@1", "b:replace#4@1", "b:progress@2", "b:evt@3", "b:insert#13@3", "b:replace#12@3"]);

        let continued = feed.grant(&sub("b")).expect("continued grant");
        assert_eq!((continued.version, continued.tail_from), (v1, Some(14)));
        assert!(continued.spans().contains(&(4, 5)), "scrolled-up range preserved");
        assert!(continued.spans().contains(&(8, 10)), "initial range preserved");

        // Subsequent regrant at the continued windowVersion succeeds and live deliveries work.
        let v2 = regrant(&feed, "b", v1, ask(&[(4, 5), (8, 10)], Some(14)), "moved");
        assert_eq!(v2, 3);
        unit(&feed, 14);
        unit(&feed, 4);
        assert_eq!(lanes(&b), ["b:moved@3", "b:insert#14@3", "b:replace#4@3"]);
    }

    #[test]
    fn positioned_replay_handles_half_open_previous_sub_and_back_to_back_drops() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        feed.publish(&[row(1)], None).unwrap();
        assert_eq!(lanes(&a), ["a:snap@0v0", "a:progress@1"]);

        // `a` stays half-open in `subs` while deliveries extend its tail at seq 1 and seq 2.
        unit(&feed, 11);
        feed.publish(&[row(2)], None).unwrap();
        unit(&feed, 12);

        let b = MockConnection::new(ConnectionId(2), limits);
        let decision = attach(&feed, &b, "b", Window::Positioned(3), Some(positioned_resume(&feed, 1, Window::Positioned(3), "a", 0)));
        assert_eq!((decision.mode, decision.start_seq, decision.live_seq), (AttachMode::Replay, 2, 3));
        assert_eq!(lanes(&b), ["b:insert#11@1", "b:progress@2", "b:insert#12@2"]);

        // `b` drops before the client folds anything, and more events arrive before reconnect `c`.
        feed.detach(sub("b"));
        feed.publish(&[row(3)], None).unwrap();
        unit(&feed, 13);

        let c = MockConnection::new(ConnectionId(3), limits);
        let decision = attach(&feed, &c, "c", Window::Positioned(3), Some(positioned_resume(&feed, 1, Window::Positioned(3), "b", 0)));
        assert_eq!((decision.mode, decision.start_seq, decision.live_seq), (AttachMode::Replay, 2, 4));
        assert_eq!(lanes(&c), ["c:insert#11@1", "c:progress@2", "c:insert#12@2", "c:progress@3", "c:insert#13@3"]);
    }

    #[test]
    fn positioned_rest_falls_back_when_head_delivery_was_dropped_and_replays_when_head_had_none() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        feed.publish(&[row(1)], None).unwrap();
        // Final turn delivery at seq 1 into a connection that may already have died before rest().
        unit(&feed, 11);
        lanes(&a);

        feed.rest();
        assert_eq!(feed.ring_held(), 0);
        // Reconnecting at seq 1 must fall back to a snapshot rather than silently skipping record 11.
        let b = MockConnection::new(ConnectionId(2), limits);
        let decision = attach(&feed, &b, "b", Window::Positioned(3), Some(positioned_resume(&feed, 1, Window::Positioned(3), "a", 0)));
        assert_eq!((decision.mode, decision.start_seq), (AttachMode::Snapshot, 2));
        assert_eq!(lanes(&b), ["b:snap@1v1"]);

        // When a subsequent frame at seq 3 arrives after the last delivery (seq 2), resting leaves no
        // undelivered record at seq 3, so a client that folded seq 3 can still replay at head.
        feed.publish(&[row(2)], None).unwrap();
        unit(&feed, 12);
        feed.publish(&[row(3)], None).unwrap();
        lanes(&b);
        feed.rest();
        assert_eq!(feed.ring_held(), 0);
        feed.detach(sub("b"));

        let c = MockConnection::new(ConnectionId(3), limits);
        let decision = attach(&feed, &c, "c", Window::Positioned(3), Some(positioned_resume(&feed, 3, Window::Positioned(3), "b", 1)));
        assert_eq!((decision.mode, decision.start_seq, decision.live_seq), (AttachMode::Replay, 4, 4));
        assert!(lanes(&c).is_empty());

        // Detaching before a rest clears the detached grant, so reconnect falls back to snapshot.
        feed.detach(sub("c"));
        feed.rest();
        let d = MockConnection::new(ConnectionId(4), limits);
        let decision = attach(&feed, &d, "d", Window::Positioned(3), Some(positioned_resume(&feed, 3, Window::Positioned(3), "c", 1)));
        assert_eq!((decision.mode, decision.start_seq), (AttachMode::Snapshot, 4));
        assert_eq!(lanes(&d), ["d:snap@3v3"]);
    }

    #[test]
    fn positioned_deliver_encodes_only_forms_needed_by_retained_grants() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let record_deliver = |ordinal: u64| -> Vec<Held> {
            let mut encoded = Vec::new();
            feed.deliver(1, ordinal, &format!("p{ordinal}"), Some("before"), None, &mut |held, at| {
                encoded.push(held);
                let how = if held == Held::Tail { "insert" } else { "replace" };
                Bytes::from(format!("{how}#{ordinal}@{}", at.seq))
            });
            encoded
        };

        // No positioned subscriber yet: nothing encoded.
        assert!(record_deliver(9).is_empty());
        assert!(record_deliver(11).is_empty());

        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        lanes(&a);

        assert!(record_deliver(6).is_empty(), "record outside every grant is not encoded");
        assert_eq!(record_deliver(11), [Held::Tail], "tail append encodes only insert");
        assert_eq!(record_deliver(9), [Held::Range], "range update encodes only replace");

        // Detached grant retains only the form it needs and advances its tail across deliveries.
        feed.detach(sub("a"));
        assert!(record_deliver(6).is_empty());
        assert_eq!(record_deliver(12), [Held::Tail]);
        assert_eq!(record_deliver(12), [Held::Range], "detached grant tracks tail extension so amendment encodes replace");

        // One grant holds 12 as Range (`a` detached) and another holds 12 as Tail (`b` live): both forms encoded once.
        let b = MockConnection::new(ConnectionId(2), limits);
        attach(&feed, &b, "b", Window::Positioned(3), None);
        lanes(&b);
        let both = record_deliver(12);
        assert_eq!(both.len(), 2);
        assert!(both.contains(&Held::Tail) && both.contains(&Held::Range));

        // After all positioned grants are gone and rested, nothing is encoded again.
        feed.detach(sub("b"));
        feed.rest();
        assert!(record_deliver(9).is_empty());
        assert!(record_deliver(13).is_empty());
    }

    #[test]
    fn positioned_deliveries_do_not_reduce_plain_frame_ring_coverage() {
        let limits = MockLimits { ring_bytes: 128, ..MockLimits::default() };
        let feed = feed(limits);
        let p = MockConnection::new(ConnectionId(1), limits);
        let d = MockConnection::new(ConnectionId(2), limits);
        attach(&feed, &p, "p", Window::Positioned(3), None);
        attach(&feed, &d, "d", Window::LastItems(3), None);
        lanes(&p);
        lanes(&d);
        feed.detach(sub("p"));
        feed.detach(sub("d"));

        // 5 frames = 5 * ("legacy@N" + "progress@N") = 90 bytes, fitting within 128 bytes.
        for seq in 1..=5 {
            feed.publish(&[row(seq)], None).unwrap();
        }
        // Push large deliveries that far exceed 128 bytes.
        for ord in 11..=30 {
            feed.deliver(1, ord, &format!("p{ord}"), Some("before"), None, &mut |_, _| Bytes::from(format!("insert#{ord:02}-xxxxxxxxxxxxxxxxxxxxxxxxxxxx")));
        }

        // Plain (desktop) subscriber still replays all 5 frames from seq 0.
        let d2 = MockConnection::new(ConnectionId(3), limits);
        let plain_resume = ResumeFrom { position: FeedPosition { epoch: feed.position().epoch, seq: 0 }, window: Window::LastItems(3), positioned: None };
        let decision = attach(&feed, &d2, "d2", Window::LastItems(3), Some(plain_resume));
        assert_eq!((decision.mode, decision.start_seq, decision.live_seq), (AttachMode::Replay, 1, 6));
        assert_eq!(lanes(&d2), ["d2:legacy@1", "d2:legacy@2", "d2:legacy@3", "d2:legacy@4", "d2:legacy@5"]);

        // Positioned subscriber falls back to snapshot because its delivery ring evicted early deliveries.
        let p2 = MockConnection::new(ConnectionId(4), limits);
        let decision = attach(&feed, &p2, "p2", Window::Positioned(3), Some(positioned_resume(&feed, 0, Window::Positioned(3), "p", 0)));
        assert_eq!(decision.mode, AttachMode::Snapshot);
    }

    #[test]
    fn positioned_fallback_to_snapshot_when_gap_is_not_covered() {
        let limits = MockLimits::default();
        let feed = feed(limits);
        let a = MockConnection::new(ConnectionId(1), limits);
        attach(&feed, &a, "a", Window::Positioned(3), None);
        feed.publish(&[row(1)], None).unwrap();
        lanes(&a);

        // 1. Legacy client without positioned identity falls back to snapshot.
        let legacy = MockConnection::new(ConnectionId(2), limits);
        let decision = attach(
            &feed,
            &legacy,
            "legacy",
            Window::Positioned(3),
            Some(ResumeFrom { position: FeedPosition { epoch: feed.position().epoch, seq: 1 }, window: Window::Positioned(3), positioned: None }),
        );
        assert_eq!(decision.mode, AttachMode::Snapshot);

        // 2. Unknown subscription id falls back.
        let unknown = MockConnection::new(ConnectionId(3), limits);
        let decision = attach(&feed, &unknown, "u", Window::Positioned(3), Some(positioned_resume(&feed, 1, Window::Positioned(3), "missing", 0)));
        assert_eq!(decision.mode, AttachMode::Snapshot);

        // 3. Mismatched window version falls back.
        let v1 = regrant(&feed, "a", 0, ask(&[(8, 10)], Some(11)), "moved");
        assert_eq!(v1, 1);
        let stale_ver = MockConnection::new(ConnectionId(4), limits);
        let decision = attach(&feed, &stale_ver, "sv", Window::Positioned(3), Some(positioned_resume(&feed, 1, Window::Positioned(3), "a", 0)));
        assert_eq!(decision.mode, AttachMode::Snapshot);

        // 4. Changed window size falls back.
        let diff_win = MockConnection::new(ConnectionId(5), limits);
        let decision = attach(&feed, &diff_win, "dw", Window::Positioned(5), Some(positioned_resume(&feed, 1, Window::Positioned(3), "a", v1)));
        assert_eq!(decision.mode, AttachMode::Snapshot);

        // 5. Rebase while disconnected clears detached grants and bumps live version -> falls back.
        feed.detach(sub("a"));
        feed.rebase(&mut |_, _, version, _| {
            Some((GrantAsk { lineage: 2, ranges: vec![GrantRange::of(8, 9)], tail_from: Some(10) }, Bytes::from(format!("rebased@{version}"))))
        });
        let after_rebase = MockConnection::new(ConnectionId(6), limits);
        let decision = attach(&feed, &after_rebase, "ar", Window::Positioned(3), Some(positioned_resume(&feed, 1, Window::Positioned(3), "a", v1)));
        assert_eq!(decision.mode, AttachMode::Snapshot);

        // 6. Ring eviction of a missed delivery or frame falls back.
        let tiny_ring = MockLimits { ring_bytes: 64, ..MockLimits::default() };
        let evicted_feed = self::feed(tiny_ring);
        let e1 = MockConnection::new(ConnectionId(7), tiny_ring);
        attach(&evicted_feed, &e1, "e1", Window::Positioned(3), None);
        lanes(&e1);
        evicted_feed.detach(sub("e1"));
        for seq in 1..=20 {
            evicted_feed.publish(&[row(seq)], None).unwrap();
            unit(&evicted_feed, 10 + seq);
        }
        let e2 = MockConnection::new(ConnectionId(8), tiny_ring);
        let decision = attach(&evicted_feed, &e2, "e2", Window::Positioned(3), Some(positioned_resume(&evicted_feed, 0, Window::Positioned(3), "e1", 0)));
        assert_eq!(decision.mode, AttachMode::Snapshot);

        // 7. Connection event budget too small for replay falls back.
        let tight = small_budget();
        let budget_feed = self::feed(tight);
        let b1 = MockConnection::new(ConnectionId(9), tight);
        attach(&budget_feed, &b1, "b1", Window::Positioned(3), None);
        lanes(&b1);
        budget_feed.detach(sub("b1"));
        for seq in 1..=20 {
            budget_feed.publish(&[FeedFrame::new(seq, Bytes::from(format!("payload-{seq:02}-xxxxxxxx")))], None).unwrap();
        }
        let b2 = MockConnection::new(ConnectionId(10), tight);
        let decision = attach(&budget_feed, &b2, "b2", Window::Positioned(3), Some(positioned_resume(&budget_feed, 0, Window::Positioned(3), "b1", 0)));
        assert_eq!(decision.mode, AttachMode::Snapshot);
    }
}
