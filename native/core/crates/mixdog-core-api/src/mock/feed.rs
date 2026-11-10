//! A reference `Feed`: the SPEC §4.2 algorithm without the snapshot cache.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_rt::CancellationToken;
use mixdog_rt::CpuInteractive;
use mixdog_rt::LaneToken;

use super::MockLimits;
use crate::error::CoreError;
use crate::feed::AttachDecision;
use crate::feed::AttachMode;
use crate::feed::AttachRequest;
use crate::feed::AttachStart;
use crate::feed::Feed;
use crate::feed::FeedFrame;
use crate::feed::FeedPosition;
use crate::feed::FeedSource;
use crate::feed::FeedView;
use crate::feed::PublishError;
use crate::feed::ResumeFrom;
use crate::feed::ScopedFeed;
use crate::feed::ScopedFeeds;
use crate::feed::Window;
use crate::ids::FeedEpoch;
use crate::ids::FeedId;
use crate::ids::SubscriptionId;
use crate::sink::Lane;
use crate::sink::SnapshotSlot;

pub struct MockFeed {
    shared: Arc<Shared>,
}

struct Shared {
    id: FeedId,
    epoch: FeedEpoch,
    limits: MockLimits,
    cpu: CpuInteractive,
    state: Mutex<State>,
}

struct State {
    /// Set by [`ScopedFeed::close`].
    closed: bool,
    seq: u64,
    view: Arc<dyn FeedView>,
    ring: VecDeque<FeedFrame>,
    ring_used: usize,
    subs: HashMap<SubscriptionId, Subscriber>,
}

struct Subscriber {
    lane: Arc<dyn Lane>,
    window: Window,
}

/// A snapshot to encode after the feed lock is released.
struct Encode {
    slot: SnapshotSlot,
    view: Arc<dyn FeedView>,
    at: FeedPosition,
    window: Window,
}

impl MockFeed {
    /// An empty feed (seq 0) whose initial view is `view`.
    pub fn new(id: FeedId, epoch: FeedEpoch, view: Arc<dyn FeedView>, limits: MockLimits) -> Self {
        Self {
            shared: Arc::new(Shared {
                id,
                epoch,
                limits,
                cpu: mixdog_rt::testing::tokens().cpu_interactive,
                state: Mutex::new(State {
                    closed: false,
                    seq: 0,
                    view,
                    ring: VecDeque::new(),
                    ring_used: 0,
                    subs: HashMap::new(),
                }),
            }),
        }
    }

    pub fn subscribers(&self) -> usize {
        self.shared.lock().subs.len()
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn position(&self, seq: u64) -> FeedPosition {
        FeedPosition {
            epoch: self.epoch.clone(),
            seq,
        }
    }

    /// P §6.3 conditions 1–3; condition 4 (byte fit) is the reservation in `attach`.
    fn replayable(&self, state: &State, resume: &ResumeFrom, window: &Window) -> bool {
        let first_seq = state.ring.front().map_or(state.seq + 1, |frame| frame.seq);
        resume.position.epoch == self.epoch
            && resume.window == *window
            && resume.position.seq <= state.seq
            && resume.position.seq + 1 >= first_seq
    }

    /// Runs after the feed lock is released. A full lane drops the job, and with it the slot,
    /// which lags the lane.
    fn encode(&self, job: Encode) {
        let _ = self.cpu.submit(&CancellationToken::new(), move |lane| {
            let frame = job.view.encode_snapshot(lane, job.at, &job.window);
            job.slot.fill(frame);
        });
    }
}

impl FeedSource for MockFeed {
    fn feed_id(&self) -> FeedId {
        self.shared.id.clone()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let shared = &self.shared;
        let mut state = shared.lock();
        if state.closed {
            return Err(CoreError::ConnectionClosed);
        }
        let seq = state.seq;
        let mut decision = AttachDecision {
            mode: AttachMode::Snapshot,
            epoch: shared.epoch.clone(),
            start_seq: seq + 1,
        };
        let (lane, window, reservation) = match req.start {
            AttachStart::Open {
                lane,
                window,
                resume_from,
            } => {
                if let Some(resume) = &resume_from
                    && shared.replayable(&state, resume, &window)
                {
                    let frames: Vec<&FeedFrame> = state
                        .ring
                        .iter()
                        .filter(|f| f.seq > resume.position.seq)
                        .collect();
                    let total = frames.iter().map(|f| f.bytes.len()).sum();
                    if let Ok(mut reservation) = lane.try_reserve(total) {
                        for frame in frames {
                            let part = reservation
                                .split(frame.bytes.len())
                                .expect("reserved the sum");
                            lane.push(part, frame.bytes.clone());
                        }
                        decision.mode = AttachMode::Replay;
                        decision.start_seq = resume.position.seq + 1;
                    }
                }
                (lane, window, None)
            }
            AttachStart::Recover { reservation } => {
                let Some(subscriber) = state.subs.get(&req.sub) else {
                    return Err(CoreError::ConnectionClosed);
                };
                (
                    subscriber.lane.clone(),
                    subscriber.window.clone(),
                    Some(reservation),
                )
            }
        };
        let mut encode = None;
        if decision.mode == AttachMode::Snapshot {
            match reservation.or_else(|| lane.try_reserve_snapshot(shared.limits.max_snapshot_bytes).ok()) {
                Some(reservation) => {
                    encode = Some(Encode {
                        slot: lane.push_slot(reservation),
                        view: state.view.clone(),
                        at: shared.position(seq),
                        window: window.clone(),
                    });
                }
                None => {
                    lane.lag();
                }
            }
        }
        state.subs.insert(req.sub, Subscriber { lane, window });
        drop(state);

        if let Some(job) = encode {
            shared.encode(job);
        }
        Ok(decision)
    }

    fn detach(&self, sub: SubscriptionId) {
        let removed = self.shared.lock().subs.remove(&sub);
        if let Some(subscriber) = removed {
            subscriber.lane.close();
        }
    }
}

impl Feed for MockFeed {
    fn position(&self) -> FeedPosition {
        let seq = self.shared.lock().seq;
        self.shared.position(seq)
    }

    fn publish(
        &self,
        frames: &[FeedFrame],
        view: Option<Arc<dyn FeedView>>,
    ) -> Result<(), PublishError> {
        let mut state = self.shared.lock();
        for (offset, frame) in frames.iter().enumerate() {
            let expected = state.seq + 1 + offset as u64;
            if frame.seq != expected {
                return Err(PublishError::SeqGap {
                    expected,
                    got: frame.seq,
                });
            }
        }
        let state = &mut *state;
        for frame in frames {
            state.ring.push_back(frame.clone());
            state.ring_used += frame.bytes.len();
            while state.ring_used > self.shared.limits.ring_bytes {
                let evicted = state
                    .ring
                    .pop_front()
                    .expect("ring holds the counted bytes");
                state.ring_used -= evicted.bytes.len();
            }
            state.seq = frame.seq;
            for subscriber in state.subs.values() {
                let lane = &subscriber.lane;
                if lane.is_lagged() {
                    continue;
                }
                match lane.try_reserve(frame.bytes.len()) {
                    Ok(reservation) => lane.push(reservation, frame.bytes.clone()),
                    Err(_) => {
                        lane.lag();
                    }
                }
            }
        }
        if let Some(view) = view {
            state.view = view;
        }
        Ok(())
    }
}

impl ScopedFeed for MockFeed {
    fn close(&self) {
        let mut state = self.shared.lock();
        state.closed = true;
        for (_, subscriber) in state.subs.drain() {
            subscriber.lane.close();
        }
    }

    fn subscribers(&self) -> usize {
        MockFeed::subscribers(self)
    }
}

/// A [`ScopedFeeds`] creating [`MockFeed`]s with the given limits and epochs drawn from a
/// counter.
pub struct MockScopedFeeds {
    limits: MockLimits,
    next_epoch: AtomicU64,
    made: Mutex<HashMap<FeedId, Arc<dyn ScopedFeed>>>,
}

impl MockScopedFeeds {
    pub fn new(limits: MockLimits) -> Self {
        Self {
            limits,
            next_epoch: AtomicU64::new(1),
            made: Mutex::new(HashMap::new()),
        }
    }

    /// The feed last created under `id`, the lookup a subscribing request makes.
    pub fn find(&self, id: &FeedId) -> Option<Arc<dyn ScopedFeed>> {
        self.made
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    /// The ids of the feeds created so far, sorted.
    pub fn ids(&self) -> Vec<FeedId> {
        let mut ids: Vec<FeedId> = self
            .made
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }
}

impl ScopedFeeds for MockScopedFeeds {
    fn create(&self, id: FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed> {
        let epoch = super::epoch(u128::from(self.next_epoch.fetch_add(1, Ordering::Relaxed)));
        let feed: Arc<dyn ScopedFeed> = Arc::new(MockFeed::new(id.clone(), epoch, view, self.limits));
        self.made
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, feed.clone());
        feed
    }
}

/// A subscriber of one feed over a mock connection: what a client sees after `feed/subscribe`.
pub struct FeedTap {
    conn: super::MockConnection,
    /// Every notification already returned: the connection hands each frame out once.
    kept: std::sync::Mutex<Vec<serde_json::Value>>,
    /// The text prefix of this subscriber's frames: its subscription id.
    prefix: String,
}

impl FeedTap {
    /// Subscribes to `feed`: the response is written first, then the snapshot and later frames.
    pub fn attach(feed: &Arc<dyn ScopedFeed>) -> Self {
        Self::attach_as(feed, 1)
    }

    /// `attach` as connection `id`: a second subscriber of the same feed (a client that dials again) needs an id of its own.
    pub fn attach_as(feed: &Arc<dyn ScopedFeed>, id: u64) -> Self {
        use crate::ids::ConnectionId;
        use crate::sink::ConnectionSink;

        let conn = super::MockConnection::new(ConnectionId(id), MockLimits::default());
        let source: Arc<dyn FeedSource> = feed.clone();
        let sub = if id == 1 { "tap".to_owned() } else { format!("tap{id}") };
        let attached = crate::feed::subscribe(&source, SubscriptionId::from(sub.as_str()), Window::Fixed, None, &conn)
            .expect("attach to an open connection");
        conn.send_control_release(bytes::Bytes::from_static(b"{}"), attached.release)
            .expect("connection open");
        Self { conn, kept: std::sync::Mutex::new(Vec::new()), prefix: format!("{sub}:") }
    }

    /// The notifications written to the subscriber, parsed, in order, until `done` holds of them.
    /// Woken by each frame that arrives, never by the clock.
    pub async fn notifications_until(
        &self,
        mut done: impl FnMut(&[serde_json::Value]) -> bool,
    ) -> Vec<serde_json::Value> {
        let before = self.kept.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut seen = before.clone();
        self.conn
            .drain_text_until(|text| {
                seen = before.clone();
                seen.extend(
                    text.iter()
                        .filter_map(|frame| frame.strip_prefix(self.prefix.as_str()))
                        .map(|frame| serde_json::from_str::<serde_json::Value>(frame).expect("a feed frame is JSON")),
                );
                done(&seen)
            })
            .await;
        *self.kept.lock().unwrap_or_else(|e| e.into_inner()) = seen.clone();
        seen
    }
}
