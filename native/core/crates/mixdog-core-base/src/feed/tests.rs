//! The attach conformance scenarios, P §14.4–14.7 and RL G5 with a scripted actor.
//!
//! The scripted actor's state is `key → value`; event `seq` sets key `seq % keys` to `seq`
//! (frame `e <seq> <key> <value>`), so the state at any position is known
//! ([`Model::at`]). A snapshot frame is `s <seq> k=v,…`. A client folds its lane's frames
//! and asserts that every event follows the previous position: no gap without a snapshot,
//! no duplicate.

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

fn cpu() -> CpuInteractive {
    mixdog_rt::testing::tokens().cpu_interactive
}

fn feed_limits(limits: MockLimits) -> FeedLimits {
    FeedLimits {
        ring_bytes: limits.ring_bytes,
        max_snapshot_bytes: limits.max_snapshot_bytes,
    }
}

#[test]
fn passes_the_attach_conformance_scenarios() {
    conformance::run_all(&|limits| {
        Arc::new(CoreFeed::new(
            FeedId::from("app"),
            epoch(9),
            Arc::new(EchoView),
            feed_limits(limits),
            cpu(),
        ))
    });
}

#[test]
fn passes_the_scoped_feed_conformance_scenarios() {
    conformance::run_scoped(&|limits| {
        Arc::new(super::CoreScopedFeeds::new(feed_limits(limits), cpu()))
    });
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

// ── scripted actor ──────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Model(BTreeMap<u64, u64>);

impl Model {
    /// The actor's state after event `seq`.
    fn at(seq: u64, keys: u64) -> Self {
        Model(
            (seq.saturating_sub(keys - 1).max(1)..=seq)
                .map(|s| (s % keys, s))
                .collect(),
        )
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
    fn encode_snapshot(
        &self,
        _lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        window: &Window,
    ) -> Bytes {
        *self
            .encodes
            .0
            .lock()
            .unwrap()
            .entry((self.feed.clone(), at.seq, window.clone()))
            .or_default() += 1;
        let body: Vec<String> = Model::at(at.seq, self.keys)
            .0
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        Bytes::from(format!("s {} {}", at.seq, body.join(",")))
    }
}

struct Actor {
    feed: Arc<CoreFeed>,
    keys: u64,
    seq: u64,
}

impl Actor {
    fn new(name: &str, keys: u64, limits: FeedLimits, encodes: &Arc<Encodes>) -> Self {
        let id = FeedId::from(name);
        let view = Arc::new(ModelView {
            feed: id.clone(),
            keys,
            encodes: encodes.clone(),
        });
        Self {
            feed: Arc::new(CoreFeed::new(id, epoch(42), view, limits, cpu())),
            keys,
            seq: 0,
        }
    }

    /// Publishes events up to `last` (the view encodes from the seq it is asked for).
    fn run_to(&mut self, last: u64) {
        while self.seq < last {
            self.seq += 1;
            let seq = self.seq;
            let frame = FeedFrame {
                seq,
                bytes: Bytes::from(format!("e {seq} {} {seq}", seq % self.keys)),
            };
            self.feed.publish(&[frame], None).unwrap();
        }
    }

    fn state(&self) -> Model {
        Model::at(self.seq, self.keys)
    }
}

/// A client's folded state and position.
#[derive(Clone, Debug, Default)]
struct Client {
    state: Model,
    last: Option<u64>,
}

impl Client {
    fn at(seq: u64, keys: u64) -> Self {
        Self {
            state: Model::at(seq, keys),
            last: Some(seq),
        }
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
                assert_eq!(
                    self.last,
                    Some(seq - 1),
                    "event {seq} must follow the previous position"
                );
                let (key, value) = rest.split_once(' ').unwrap();
                self.state
                    .0
                    .insert(key.parse().unwrap(), value.parse().unwrap());
                self.last = Some(seq);
            }
            other => panic!("unknown frame kind {other}"),
        }
    }

    fn resume_from(&self, epoch: &FeedEpoch, window: &Window) -> Option<ResumeFrom> {
        self.last.map(|seq| ResumeFrom {
            position: FeedPosition {
                epoch: epoch.clone(),
                seq,
            },
            window: window.clone(),
        })
    }
}

/// Subscribes and writes the response; returns the decision.
fn attach(
    feed: &Arc<CoreFeed>,
    conn: &MockConnection,
    sub: &str,
    window: Window,
    resume_from: Option<ResumeFrom>,
) -> AttachDecision {
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = subscribe(
        &source,
        SubscriptionId::from(sub),
        window,
        resume_from,
        conn,
    )
    .unwrap();
    conn.send_control_release(Bytes::from_static(b"resp"), attached.release)
        .unwrap();
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
        clients
            .get_mut(&sub)
            .expect("frames only of live subscriptions")
            .apply(&written.frame);
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
fn resume_case(
    limits: MockLimits,
    other_epoch: bool,
    seq: u64,
    resume_window: Window,
    window: Window,
) -> AttachDecision {
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

    let epoch = if other_epoch {
        FeedEpoch::from("ffffffffffffffffffffffffffffffff")
    } else {
        actor.feed.position().epoch
    };
    let client = Client::at(seq, KEYS);
    let resume_from = ResumeFrom {
        position: FeedPosition { epoch, seq },
        window: resume_window,
    };
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
    MockLimits {
        queue_bytes: 1024 + 96,
        control_reserve_bytes: 1024,
        max_snapshot_bytes: 48,
        ring_bytes: 1 << 20,
    }
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
    assert_eq!(
        (other_epoch.mode, other_epoch.start_seq),
        (AttachMode::Snapshot, 61)
    );

    let evicted = MockLimits {
        ring_bytes: 100,
        ..default
    };
    let outside = resume_case(evicted, false, 20, items.clone(), items.clone());
    assert_eq!(
        (outside.mode, outside.start_seq),
        (AttachMode::Snapshot, 61)
    );

    let beyond_head = resume_case(default, false, 61, items.clone(), items.clone());
    assert_eq!(
        (beyond_head.mode, beyond_head.start_seq),
        (AttachMode::Snapshot, 61)
    );

    let changed_window = resume_case(default, false, 20, items.clone(), fewer);
    assert_eq!(
        (changed_window.mode, changed_window.start_seq),
        (AttachMode::Snapshot, 61)
    );

    let not_fitting = resume_case(small_budget(), false, 20, items.clone(), items.clone());
    assert_eq!(
        (not_fitting.mode, not_fitting.start_seq),
        (AttachMode::Snapshot, 61)
    );

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

#[test]
fn attach_under_load_folds_to_the_actor_state() {
    const EVENTS: u64 = 10_000;
    const CONNECTIONS: u64 = 50;
    const KEYS: u64 = 64;
    let snapshot_bytes = 2048;
    let limits = FeedLimits {
        ring_bytes: 64 << 10,
        max_snapshot_bytes: snapshot_bytes,
    };
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
                    let conn_limits = MockLimits {
                        queue_bytes,
                        control_reserve_bytes: 48 << 10,
                        max_snapshot_bytes: snapshot_bytes,
                        ring_bytes: 0,
                    };
                    let conn = MockConnection::new(ConnectionId(i), conn_limits);
                    let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (i + 1));
                    let mut client = Client::default();
                    let mut current: Option<SubscriptionId> = None;
                    let mut attaches = 0u64;
                    let windows = [Window::LastItems(50), Window::LastItems(20)];
                    let mut window = windows[0].clone();
                    start.wait();
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
                        if finished && current.is_some() {
                            break;
                        }
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
        clients
            .into_iter()
            .map(|client| client.join().unwrap())
            .collect::<Vec<_>>()
    });

    let expected = Model::at(EVENTS, KEYS);
    for (i, (client, attaches)) in clients.iter().enumerate() {
        assert_eq!(client.last, Some(EVENTS), "connection {i}");
        assert_eq!(
            client.state, expected,
            "connection {i} after {attaches} attaches"
        );
    }
    assert!(
        encodes.max_per_key() <= 1,
        "one encode per (feed, S, window)"
    );
}

// ── P §14.6 slow consumer ──────────────────────────────────────────────────────────────

#[test]
fn a_slow_consumer_lags_only_its_own_lanes() {
    let limits = MockLimits {
        queue_bytes: 4096 + 1024,
        control_reserve_bytes: 1024,
        max_snapshot_bytes: 512,
        ring_bytes: 1 << 20,
    };
    let encodes = Arc::new(Encodes::default());
    let mut a = Actor::new("a", KEYS, feed_limits(limits), &encodes);
    let mut b = Actor::new("b", KEYS, feed_limits(limits), &encodes);
    let slow = MockConnection::new(ConnectionId(1), limits);
    let reader = MockConnection::new(ConnectionId(2), limits);
    let mut slow_clients = HashMap::new();
    let mut reader_clients = HashMap::new();
    // Subscription ids are unique across connections.
    for (actor, name) in [(&a, "a"), (&b, "b")] {
        attach(
            &actor.feed,
            &slow,
            &format!("slow-{name}"),
            Window::Fixed,
            None,
        );
        attach(&actor.feed, &reader, name, Window::Fixed, None);
        slow_clients.insert(
            SubscriptionId::from(format!("slow-{name}")),
            Client::default(),
        );
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
    assert_eq!(
        slow.event_free(),
        limits.event_budget_bytes(),
        "lagged lanes hold no bytes"
    );
    for (name, actor) in [("a", &a), ("b", &b)] {
        assert_eq!(
            reader_clients[&SubscriptionId::from(name)].state,
            actor.state()
        );
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

/// A snapshot encode runs after the feed lock is released: while one is in progress, the
/// same feed and every other feed publish and attach.
#[test]
fn a_snapshot_encode_never_blocks_a_publish() {
    struct BlockingView {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl FeedView for BlockingView {
        fn encode_snapshot(
            &self,
            _lane: &InLane<CpuInteractive>,
            at: FeedPosition,
            _window: &Window,
        ) -> Bytes {
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
        Arc::new(BlockingView {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        }),
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
            let frame = FeedFrame {
                seq: 1,
                bytes: Bytes::from_static(b"e 1 1 1"),
            };
            blocked.publish(&[frame], None).unwrap();
            other.run_to(100);
            let reader = MockConnection::new(ConnectionId(2), limits);
            attach(&other.feed, &reader, "y", Window::Fixed, None);
            published_tx.send(()).unwrap();
        });
        published
            .recv_timeout(Duration::from_secs(10))
            .expect("publish and attach proceed during a snapshot encode");
        release.send(()).unwrap();
        attaching.join().unwrap();
    });
    let text: Vec<String> = conn
        .drain_text()
        .into_iter()
        .filter(|w| w.starts_with("x:"))
        .collect();
    assert_eq!(text, ["x:s 0 ", "x:e 1 1 1"]);
}

// ── P §14.7 bounds ─────────────────────────────────────────────────────────────────────

#[test]
fn ring_memory_stays_within_ring_bytes() {
    let ring_bytes = 4096;
    let feed = CoreFeed::new(
        FeedId::from("t"),
        epoch(3),
        Arc::new(EchoView),
        FeedLimits {
            ring_bytes,
            max_snapshot_bytes: 1024,
        },
        cpu(),
    );
    let mut rng = Rng(7);
    for seq in 1..=5000 {
        let len = 1 + (rng.next() % 700) as usize;
        let frame = FeedFrame {
            seq,
            bytes: Bytes::from(vec![b'e'; len]),
        };
        feed.publish(&[frame], None).unwrap();
        assert!(feed.ring_held() <= ring_bytes, "after seq {seq}");
    }
}

// ── RL G5 reconnect storm ──────────────────────────────────────────────────────────────

#[test]
fn reconnect_storm_encodes_each_snapshot_once() {
    const SESSIONS: usize = 10;
    const CLIENTS: usize = 50;
    const KEYS: u64 = 16;
    const HEAD: u64 = 400;
    let limits = MockLimits {
        ring_bytes: 2048,
        ..MockLimits::default()
    };
    let encodes = Arc::new(Encodes::default());
    let mut actors: Vec<Actor> = (0..SESSIONS)
        .map(|s| Actor::new(&format!("t{s}"), KEYS, feed_limits(limits), &encodes))
        .collect();
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
                        let resume_from = ResumeFrom {
                            position: FeedPosition {
                                epoch: epoch.clone(),
                                seq,
                            },
                            window: window.clone(),
                        };
                        attach(feed, &conn, &sub, window.clone(), Some(resume_from));
                        clients.insert(SubscriptionId::from(sub), Client::at(seq, KEYS));
                    }
                    (conn, clients)
                })
            })
            .collect();
        producer.join().unwrap();
        storm
            .into_iter()
            .map(|client| client.join().unwrap())
            .unzip::<_, _, Vec<_>, Vec<_>>()
    });

    let expected = Model::at(HEAD + 40, KEYS);
    for (conn, mut clients) in conns.into_iter().zip(clients) {
        fold(&conn, &mut clients);
        for (sub, client) in clients {
            assert_eq!(client.last, Some(HEAD + 40), "{sub} is live");
            assert_eq!(client.state, expected, "{sub}");
        }
    }
    assert!(
        encodes.max_per_key() <= 1,
        "one encode per (session, S, window)"
    );
    assert!(encodes.total() > 0);
    for feed in &feeds {
        assert_eq!(feed.subscribers(), CLIENTS);
    }
}
