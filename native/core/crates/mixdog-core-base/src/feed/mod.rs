//! The core's feed (P §6, SPEC §4.2 R4, RL §5.1): one [`CoreFeed`] per thread, the app feed
//! and every scoped feed.
//!
//! A feed holds its byte-bounded ring, its current view, its subscriber lanes and its snapshot
//! flights under one `std::sync::Mutex` that belongs to that feed alone, so nothing one feed
//! does (a slow or lagged consumer, a snapshot encode, a replay) can delay another feed's
//! publish or attach. Under the lock every step is O(1) or O(frames handed over): the
//! snapshot encode runs after the lock is released, on cpu-interactive, single-flighted per
//! `(S, window)` ([`snapshot`]). Lanes never wait: a full connection budget lags the lane
//! (P §6.5) and the writer later recovers it through the same [`FeedSource::attach`].
//!
//! The attach algorithm is the one of `mixdog_core_api::feed` (open and recovery share it):
//! under the lock read `(view, S, ring)`; replay `(resumeFrom.seq, S]` when P §6.3 conditions
//! 1–4 hold, else push a snapshot slot holding the recovery reservation or `maxSnapshotBytes`
//! reserved now, or lag the lane when the budget lacks it; register the lane at `S`. So the
//! wire order per lane is response → replay frames or snapshot at `S` → frames from `S + 1`.

mod ring;
mod scoped;
mod snapshot;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::feed::AttachStart;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::PublishError;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::sink::Lane;
use mixdog_core_api::sink::SnapshotSlot;
use mixdog_rt::CancellationToken;
use mixdog_rt::CpuInteractive;
use mixdog_rt::LaneToken;

pub use self::scoped::CoreScopedFeeds;

use self::ring::Ring;
use self::snapshot::Flight;
use self::snapshot::Lead;
use self::snapshot::SnapshotCache;

/// The per-feed limits of SPEC §3.1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedLimits {
    /// `ringBytes`: 4 MiB per thread feed, 1 MiB for the app feed.
    pub ring_bytes: usize,
    /// `maxSnapshotBytes`: the reservation of every snapshot slot.
    pub max_snapshot_bytes: usize,
}

/// A feed: ring, view and subscriber lanes under one per-feed lock.
pub struct CoreFeed {
    shared: Arc<Shared>,
}

struct Shared {
    id: FeedId,
    epoch: FeedEpoch,
    /// The ordered class ([`FeedSource::ordered`]).
    ordered: bool,
    max_snapshot_bytes: usize,
    cpu: CpuInteractive,
    state: Mutex<State>,
}

struct State {
    seq: u64,
    view: Arc<dyn FeedView>,
    ring: Ring,
    subs: HashMap<SubscriptionId, Subscriber>,
    snapshots: SnapshotCache,
    /// Set by [`CoreFeed::close`]: the answer to every later attach.
    closed: Option<CoreError>,
}

struct Subscriber {
    lane: Arc<dyn Lane>,
    window: Window,
}

/// A snapshot slot to hand to its flight once the feed lock is released.
struct PendingSnapshot {
    slot: SnapshotSlot,
    flight: Arc<Flight>,
    /// Present when this attach leads the flight and must submit the encode.
    encode: Option<Encode>,
}

struct Encode {
    view: Arc<dyn FeedView>,
    at: FeedPosition,
    window: Window,
}

impl CoreFeed {
    /// An empty feed (seq 0) of producer instance `epoch`, whose read model is `view`.
    /// `cpu` runs its snapshot encodes.
    pub fn new(
        id: FeedId,
        epoch: FeedEpoch,
        view: Arc<dyn FeedView>,
        limits: FeedLimits,
        cpu: CpuInteractive,
    ) -> Self {
        Self::with_class(id, epoch, view, limits, cpu, false)
    }

    /// [`Self::new`] for a feed of the ordered class: its subscribers' lanes never drop an event.
    pub fn new_ordered(
        id: FeedId,
        epoch: FeedEpoch,
        view: Arc<dyn FeedView>,
        limits: FeedLimits,
        cpu: CpuInteractive,
    ) -> Self {
        Self::with_class(id, epoch, view, limits, cpu, true)
    }

    fn with_class(
        id: FeedId,
        epoch: FeedEpoch,
        view: Arc<dyn FeedView>,
        limits: FeedLimits,
        cpu: CpuInteractive,
        ordered: bool,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                id,
                epoch,
                ordered,
                max_snapshot_bytes: limits.max_snapshot_bytes,
                cpu,
                state: Mutex::new(State {
                    seq: 0,
                    view,
                    ring: Ring::new(limits.ring_bytes),
                    subs: HashMap::new(),
                    snapshots: SnapshotCache::default(),
                    closed: None,
                }),
            }),
        }
    }

    pub fn subscribers(&self) -> usize {
        self.shared.lock().subs.len()
    }

    /// Ends the feed with its owner (thread unload or close): every later attach answers
    /// `reason`, and every subscription is removed and its lane closed.
    pub fn close(&self, reason: CoreError) {
        let subs = {
            let mut state = self.shared.lock();
            state.closed = Some(reason);
            state.snapshots.clear();
            std::mem::take(&mut state.subs)
        };
        for subscriber in subs.into_values() {
            subscriber.lane.close();
        }
    }

    #[cfg(test)]
    fn ring_held(&self) -> usize {
        self.shared.lock().ring.held()
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Replays `(resume.seq, S]` into `lane` when P §6.3 conditions 1–3 hold and the frames'
    /// bytes fit the connection's free event budget (condition 4).
    fn replay(&self, state: &State, lane: &dyn Lane, resume: &ResumeFrom, window: &Window) -> bool {
        if resume.position.epoch != self.epoch || resume.window != *window {
            return false;
        }
        let Some(replay) = state.ring.after(resume.position.seq, state.seq) else {
            return false;
        };
        let Ok(mut reservation) = lane.try_reserve(replay.bytes) else {
            return false;
        };
        for frame in replay {
            let part = reservation
                .split(frame.bytes.len())
                .expect("the reservation holds the replay's byte sum");
            lane.push(part, frame.bytes.clone());
        }
        true
    }

    /// Submits the leader's encode to cpu-interactive. The job owns the flight's [`Lead`]:
    /// a job that never runs fails the flight, lagging its parked lanes for recovery.
    fn encode(&self, flight: Arc<Flight>, job: Encode) {
        let lead = Lead::new(flight);
        let _ = self.cpu.submit(&CancellationToken::new(), move |lane| {
            let frame = job.view.encode_snapshot(lane, job.at, &job.window);
            lead.finish(frame);
        });
    }
}

impl FeedSource for CoreFeed {
    fn feed_id(&self) -> FeedId {
        self.shared.id.clone()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let shared = &*self.shared;
        let mut state = shared.lock();
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
                if let Some(reason) = &state.closed {
                    return Err(reason.clone());
                }
                if let Some(resume) = &resume_from
                    && shared.replay(&state, lane.as_ref(), resume, &window)
                {
                    decision.mode = AttachMode::Replay;
                    decision.start_seq = resume.position.seq + 1;
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
        let mut pending = None;
        if decision.mode == AttachMode::Snapshot {
            let reservation =
                reservation.or_else(|| lane.try_reserve_snapshot(shared.max_snapshot_bytes).ok());
            match reservation {
                Some(reservation) => {
                    let slot = lane.push_slot(reservation);
                    let (flight, leads) = state.snapshots.flight(seq, &window);
                    let encode = leads.then(|| Encode {
                        view: state.view.clone(),
                        at: FeedPosition {
                            epoch: shared.epoch.clone(),
                            seq,
                        },
                        window: window.clone(),
                    });
                    pending = Some(PendingSnapshot {
                        slot,
                        flight,
                        encode,
                    });
                }
                None => {
                    lane.lag();
                }
            }
        }
        state.subs.insert(req.sub, Subscriber { lane, window });
        drop(state);

        if let Some(PendingSnapshot {
            slot,
            flight,
            encode,
        }) = pending
        {
            flight.join(slot);
            if let Some(job) = encode {
                shared.encode(flight, job);
            }
        }
        Ok(decision)
    }

    fn detach(&self, sub: SubscriptionId) {
        let removed = self.shared.lock().subs.remove(&sub);
        if let Some(subscriber) = removed {
            subscriber.lane.close();
        }
    }

    fn ordered(&self) -> bool {
        self.shared.ordered
    }
}

impl Feed for CoreFeed {
    fn position(&self) -> FeedPosition {
        let seq = self.shared.lock().seq;
        FeedPosition {
            epoch: self.shared.epoch.clone(),
            seq,
        }
    }

    fn publish(
        &self,
        frames: &[FeedFrame],
        view: Option<Arc<dyn FeedView>>,
    ) -> Result<(), PublishError> {
        let mut guard = self.shared.lock();
        let state = &mut *guard;
        for (offset, frame) in frames.iter().enumerate() {
            let expected = state.seq + 1 + offset as u64;
            if frame.seq != expected {
                return Err(PublishError::SeqGap {
                    expected,
                    got: frame.seq,
                });
            }
        }
        for frame in frames {
            state.ring.push(frame.clone());
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
        if !frames.is_empty() {
            state.snapshots.clear();
        }
        if let Some(view) = view {
            state.view = view;
        }
        Ok(())
    }
}
