//! The core's feed (P §6, SPEC §4.2 R4, RL §5.1): one [`CoreFeed`] per thread, the app feed
//! and every scoped feed.
//!
//! A feed holds its byte-bounded ring, its current view, its subscriber lanes and its snapshot
//! flights under one `std::sync::Mutex` that belongs to that feed alone, so nothing one feed
//! does (a slow or lagged consumer, a snapshot encode, a replay) can delay another feed's
//! publish or attach. The snapshot encode runs after the lock is released,
//! on cpu-interactive, single-flighted per
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

use bytes::Bytes;

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
use mixdog_core_api::feed::Grant;
use mixdog_core_api::feed::GrantAsk;
use mixdog_core_api::feed::GrantFence;
use mixdog_core_api::feed::Held;
use mixdog_core_api::feed::PublishError;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::sink::Lane;
use mixdog_core_api::sink::SlotFill;
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
    /// `maxSnapshotBytes`: the reservation of every snapshot slot and the per-feed
    /// budget for cached completed encodings.
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
    /// The seq the view describes: `seq` unless the latest frames were published deferred ([`Feed::publish_deferred`]).
    view_seq: u64,
    ring: Ring,
    /// A client has attached in this epoch, so one may hold a position of it to resume from. Until then the frames the view
    /// already describes have no reader (an attach is served the view and the frames after it), and the ring keeps none of
    /// them: a session nobody watches, a delegated agent's, would otherwise hold a full ring for as long as it is loaded.
    watched: bool,
    subs: HashMap<SubscriptionId, Subscriber>,
    snapshots: SnapshotCache,
    /// Set by [`CoreFeed::close`]: the answer to every later attach.
    closed: Option<CoreError>,
}

struct Subscriber {
    lane: Arc<dyn Lane>,
    window: Window,
    /// The position its lane was attached at: what the lane carries is the replay or the snapshot of that attach, and
    /// every frame after this seq.
    since: u64,
    /// What a positioned subscription holds: each transcript frame is delivered in the form this decides.
    grant: Option<Grant>,
}

/// A snapshot slot to hand to its flight once the feed lock is released.
struct PendingSnapshot {
    slot: SnapshotSlot,
    flight: Arc<Flight>,
    /// Present when this attach leads the flight and must submit the encode.
    encode: Option<Encode>,
}

/// A snapshot slot that hands its lane the view's delivery-time form of the frame ([FeedView::at_delivery]):
/// what depends on delivery time is set on the copy each lane gets, not on the shared encoding.
struct Delivered {
    slot: SnapshotSlot,
    view: Arc<dyn FeedView>,
    /// The version the grant this snapshot installs took, for a positioned subscription.
    version: Option<u64>,
}

impl SlotFill for Delivered {
    fn fill(self: Box<Self>, frame: Bytes) {
        let Delivered { slot, view, version } = *self;
        let frame = view.at_delivery(frame);
        slot.fill(match version {
            Some(version) => view.at_window_version(frame, version),
            None => frame,
        });
    }
}

struct Encode {
    view: Arc<dyn FeedView>,
    at: FeedPosition,
    window: Window,
}

impl CoreFeed {
    /// An empty feed (seq 0) of producer instance `epoch`, whose read model is `view`.
    /// `cpu` runs its snapshot encodes.
    pub fn new(id: FeedId, epoch: FeedEpoch, view: Arc<dyn FeedView>, limits: FeedLimits, cpu: CpuInteractive) -> Self {
        Self::with_class(id, epoch, view, limits, cpu, false)
    }

    /// [`Self::new`] for a feed of the ordered class: its subscribers' lanes never drop an event.
    pub fn new_ordered(id: FeedId, epoch: FeedEpoch, view: Arc<dyn FeedView>, limits: FeedLimits, cpu: CpuInteractive) -> Self {
        Self::with_class(id, epoch, view, limits, cpu, true)
    }

    fn with_class(id: FeedId, epoch: FeedEpoch, view: Arc<dyn FeedView>, limits: FeedLimits, cpu: CpuInteractive, ordered: bool) -> Self {
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
                    view_seq: 0,
                    ring: Ring::new(limits.ring_bytes),
                    watched: false,
                    subs: HashMap::new(),
                    snapshots: SnapshotCache::new(limits.max_snapshot_bytes),
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
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Replays `(resume.seq, S]` into `lane` when P §6.3 conditions 1–3 hold and the frames'
    /// bytes fit the connection's free event budget (condition 4).
    fn replay(&self, state: &State, lane: &dyn Lane, resume: &ResumeFrom, window: &Window) -> bool {
        // A new lane holds no grant the frames could be chosen by: only the lane that holds one carries on.
        if resume.position.epoch != self.epoch || resume.window != *window || matches!(window, Window::Positioned(_)) {
            return false;
        }
        let Some(replay) = state.ring.after(resume.position.seq, state.seq) else {
            return false;
        };
        let Ok(mut reservation) = lane.try_reserve(replay.bytes) else {
            return false;
        };
        for frame in replay {
            let part = reservation.split(frame.bytes.len()).expect("the reservation holds the replay's byte sum");
            lane.push(part, frame.bytes.clone());
        }
        true
    }

    /// Submits the leader's encode to cpu-interactive. The job owns the flight's [`Lead`]:
    /// a job that never runs fails the flight, lagging its parked lanes for recovery.
    fn encode(self: &Arc<Self>, flight: Arc<Flight>, job: Encode) {
        let lead = Lead::new(flight);
        let shared = Arc::downgrade(self);
        let _ = self.cpu.submit(&CancellationToken::new(), move |lane| {
            let frame = job.view.encode_snapshot(lane, job.at, &job.window);
            let waiting = {
                let shared = shared.upgrade();
                let mut state = shared.as_ref().map(|shared| shared.lock());
                // Account for the ready flight before another attach can find it.
                let (flight, waiting) = lead.finish(frame.clone());
                if let Some(state) = &mut state {
                    state.snapshots.retain_completed(&job.window, &flight, frame.len());
                }
                waiting
            };
            for slot in waiting {
                slot.fill(frame.clone());
            }
        });
    }
}

impl FeedSource for CoreFeed {
    fn feed_id(&self) -> FeedId {
        self.shared.id.clone()
    }

    fn position(&self) -> FeedPosition {
        let seq = self.shared.lock().seq;
        FeedPosition { epoch: self.shared.epoch.clone(), seq }
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let shared = &self.shared;
        let mut state = shared.lock();
        let seq = state.seq;
        let mut decision = AttachDecision { mode: AttachMode::Snapshot, epoch: shared.epoch.clone(), start_seq: seq + 1, live_seq: seq + 1 };
        let (lane, window, reservation) = match req.start {
            AttachStart::Open { lane, window, resume_from } => {
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
                (subscriber.lane.clone(), subscriber.window.clone(), Some(reservation))
            }
        };
        let mut pending = None;
        // The snapshot is of the view's newest rows for every subscription of the window, so the grant it installs is
        // the view's too: a recovered lane starts again from it, whatever it held.
        let grant = matches!(window, Window::Positioned(_)).then(|| {
            let ask = state.view.first_grant(&window).unwrap_or(GrantAsk { lineage: 0, ranges: Vec::new(), tail_from: None });
            // A subscription's window version never repeats: a lane recovered at a seq its grant already took a
            // version of takes the next one, and no demand made of an earlier grant names it.
            let version = match state.subs.get(&req.sub).and_then(|held| held.grant.as_ref()) {
                Some(held) => state.view_seq.max(held.version + 1),
                None => state.view_seq,
            };
            ask.granted(version)
        });
        let version = grant.as_ref().map(|grant| grant.version);
        if decision.mode == AttachMode::Snapshot {
            // The view may lag the frames (`publish_deferred`): the snapshot is the view's, at its seq, and the frames after it
            // follow from the ring. A ring that no longer holds them cannot serve the attach now; the lane lags and recovers once
            // the producer swaps a current view in.
            let at = state.view_seq;
            let catch_up = if at < seq { state.ring.after(at, seq) } else { None };
            decision.start_seq = at + 1;
            let reservation =
                if at < seq && catch_up.is_none() { None } else { reservation.or_else(|| lane.try_reserve_snapshot(shared.max_snapshot_bytes).ok()) };
            match reservation {
                Some(reservation) => {
                    let slot = SnapshotSlot::new(Box::new(Delivered { slot: lane.push_slot(reservation), view: state.view.clone(), version }));
                    if let Some(frames) = catch_up {
                        let frames: Vec<Bytes> = frames.map(|frame| frame.for_grant(grant.as_ref()).clone()).collect();
                        match lane.try_reserve(frames.iter().map(Bytes::len).sum()) {
                            Ok(mut reserved) => {
                                for frame in frames {
                                    let part = reserved.split(frame.len()).expect("the reservation holds the catch-up's byte sum");
                                    lane.push(part, frame);
                                }
                            }
                            Err(_) => {
                                lane.lag();
                            }
                        }
                    }
                    let (flight, leads) = state.snapshots.flight(at, &window);
                    let encode =
                        leads.then(|| Encode { view: state.view.clone(), at: FeedPosition { epoch: shared.epoch.clone(), seq: at }, window: window.clone() });
                    pending = Some(PendingSnapshot { slot, flight, encode });
                }
                None => {
                    lane.lag();
                }
            }
        }
        state.subs.insert(req.sub, Subscriber { lane, window, since: decision.start_seq - 1, grant });
        state.watched = true;
        drop(state);

        if let Some(PendingSnapshot { slot, flight, encode }) = pending {
            flight.join(slot);
            if let Some(job) = encode {
                shared.encode(flight, job);
            }
        }
        Ok(decision)
    }

    fn carries(&self, sub: &SubscriptionId, window: &Window, resume: &ResumeFrom) -> Option<AttachDecision> {
        let shared = &self.shared;
        let state = shared.lock();
        let held = state.subs.get(sub)?;
        // A lagged lane carries on too: its recovery snapshot is what the connection is owed next.
        (held.window == *window && resume.window == *window && resume.position.epoch == shared.epoch && (held.since..=state.seq).contains(&resume.position.seq))
            .then(|| AttachDecision::carried(FeedPosition { epoch: shared.epoch.clone(), seq: state.seq }, resume))
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

    fn grant(&self, sub: &SubscriptionId) -> Option<Grant> {
        self.shared.lock().subs.get(sub)?.grant.clone()
    }

    fn regrant(&self, sub: &SubscriptionId, base_version: u64, ask: GrantAsk) -> Result<GrantFence, CoreError> {
        let shared = &self.shared;
        let mut guard = shared.lock();
        let seq = guard.seq;
        let subscriber = guard.subs.get_mut(sub).ok_or(CoreError::ConnectionClosed)?;
        let Some(held) = &subscriber.grant else {
            return Err(CoreError::InvalidParams { path: "subscriptionId".into(), expected: "a positioned subscription".into() });
        };
        let other = |actual: String| CoreError::PreconditionFailed {
            precondition: mixdog_core_api::error::Precondition::Revision { expected: base_version.to_string().into(), actual: actual.into() },
        };
        if held.version != base_version {
            return Err(other(held.version.to_string()));
        }
        let lane = &subscriber.lane;
        // A lane being recovered is owed a snapshot, which installs its own grant: nothing is changed under it.
        if lane.is_lagged() {
            return Err(other("recovering".into()));
        }
        let Ok(reservation) = lane.try_reserve_snapshot(shared.max_snapshot_bytes) else {
            lane.lag();
            return Err(other("recovering".into()));
        };
        let slot = lane.push_slot(reservation);
        let version = (held.version + 1).max(seq);
        subscriber.grant = Some(ask.granted(version));
        Ok(GrantFence { at: FeedPosition { epoch: shared.epoch.clone(), seq }, version, slot })
    }

    fn owner(&self, sub: &SubscriptionId) -> Option<mixdog_core_api::ids::ConnectionId> {
        self.shared.lock().subs.get(sub)?.lane.connection()
    }

    fn frame_budget(&self) -> usize {
        self.shared.max_snapshot_bytes
    }
}

impl Feed for CoreFeed {
    fn publish(&self, frames: &[FeedFrame], view: Option<Arc<dyn FeedView>>) -> Result<(), PublishError> {
        // A no-op publish does not make a deferred view current.
        if frames.is_empty() && view.is_none() {
            return Ok(());
        }
        let mut guard = self.shared.lock();
        let state = &mut *guard;
        Shared::append(state, frames)?;
        // A view swapped with no frame is a new state at the same seq: no snapshot cached of the old view may serve it.
        state.snapshots.clear();
        if let Some(view) = view {
            state.view = view;
        }
        state.view_seq = state.seq;
        if !state.watched {
            state.ring.drop_through(state.view_seq);
        }
        Ok(())
    }

    fn defers(&self) -> bool {
        true
    }

    fn publish_deferred(&self, frames: &[FeedFrame]) -> Result<(), PublishError> {
        let mut guard = self.shared.lock();
        // The view and its cached snapshots stay those of `view_seq`: an attach serves them and replays these frames.
        Shared::append(&mut guard, frames)
    }

    fn rest(&self) {
        let mut guard = self.shared.lock();
        let state = &mut *guard;
        state.ring.rest(state.view_seq);
    }

    fn rebase(&self, rebase: &mut mixdog_core_api::feed::Rebase<'_>) {
        let shared = &self.shared;
        let mut guard = shared.lock();
        let at = FeedPosition { epoch: shared.epoch.clone(), seq: guard.seq };
        for (sub, subscriber) in &mut guard.subs {
            let Some(held) = &subscriber.grant else { continue };
            let version = (held.version + 1).max(at.seq);
            let Some((ask, frame)) = rebase(sub, held, version, &at) else { continue };
            subscriber.grant = Some(ask.granted(version));
            let lane = &subscriber.lane;
            // A lagged lane is told by its recovery's snapshot.
            if lane.is_lagged() {
                continue;
            }
            match lane.try_reserve(frame.len()) {
                Ok(reservation) => lane.push(reservation, frame),
                Err(_) => {
                    lane.lag();
                }
            }
        }
    }

    fn deliver(
        &self,
        lineage: u64,
        ordinal: u64,
        position: &str,
        after: Option<&str>,
        view: Option<Arc<dyn FeedView>>,
        frame: &mut dyn FnMut(Held, &FeedPosition) -> Bytes,
    ) {
        let shared = &self.shared;
        let mut guard = shared.lock();
        let state = &mut *guard;
        let at = FeedPosition { epoch: shared.epoch.clone(), seq: state.seq };
        // One encoding of each form, whoever gets it.
        let mut forms: [Option<Bytes>; 2] = [None, None];
        for subscriber in state.subs.values_mut() {
            let Some(grant) = &mut subscriber.grant else { continue };
            let Some(held) = grant.held(lineage, ordinal) else { continue };
            // What the subscription holds is what it was sent: the record joins the tail's range whether or not its
            // lane takes the frame, and a lane that does not is recovered by a snapshot, which holds it.
            if held == Held::Tail {
                grant.extend_tail(ordinal, position, after);
            }
            let lane = &subscriber.lane;
            if lane.is_lagged() {
                continue;
            }
            let bytes = forms[usize::from(held == Held::Tail)].get_or_insert_with(|| frame(held, &at)).clone();
            match lane.try_reserve(bytes.len()) {
                Ok(reservation) => lane.push(reservation, bytes),
                Err(_) => {
                    lane.lag();
                }
            }
        }
        if let Some(view) = view {
            state.snapshots.clear();
            state.view = view;
            state.view_seq = state.seq;
            if !state.watched {
                state.ring.drop_through(state.view_seq);
            }
        }
    }

    fn held(&self, lineage: u64) -> Vec<mixdog_core_api::feed::GrantRange> {
        let state = self.shared.lock();
        state
            .subs
            .values()
            .filter_map(|subscriber| subscriber.grant.as_ref())
            .filter(|grant| grant.lineage == lineage)
            .flat_map(|grant| grant.ranges.clone())
            .collect()
    }
}

impl Shared {
    /// The frames into the ring and to every live subscriber, after their seqs are checked.
    fn append(state: &mut State, frames: &[FeedFrame]) -> Result<(), PublishError> {
        for (offset, frame) in frames.iter().enumerate() {
            let expected = state.seq + 1 + offset as u64;
            if frame.seq != expected {
                return Err(PublishError::SeqGap { expected, got: frame.seq });
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
                let bytes = frame.for_grant(subscriber.grant.as_ref());
                match lane.try_reserve(bytes.len()) {
                    Ok(reservation) => lane.push(reservation, bytes.clone()),
                    Err(_) => {
                        lane.lag();
                    }
                }
            }
        }
        Ok(())
    }
}
