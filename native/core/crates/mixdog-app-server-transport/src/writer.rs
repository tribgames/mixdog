//! The byte-budgeted connection writer (P §6.5, `mixdog_core_api::sink`).
//!
//! One `Shared` per connection holds the queues under one short `std::sync::Mutex` that only
//! this connection's producers and its writer task touch, so connections never contend with
//! each other. No method of [`ConnectionWriter`] or [`WriterLane`] waits: a full budget is
//! answered by lag, a full control reserve by closing. The writer task ([`write_loop`]) is the
//! only place that awaits a socket.
//!
//! **Write order** (Lead decision 2026-11-11, Node `b6f10295a`: one ordered outbound queue per
//! phone, `remote-relay-delivery.ts:81-155`, `coordinator.ts:1083-1172`). Every text frame takes
//! a connection-wide number when it is queued, and no text frame is written before a frame
//! queued earlier on the connection. Three things are not held to that: a ping (and the close
//! frame), which go first as Node's control domain does; the frames of a lane still waiting for
//! the response that opens it, which follow that response; and a lagged lane's recovery
//! snapshot, which is merged latest-wins state and may land after frames queued while it was
//! being taken.
//!
//! **Ordered class.** Answers, server requests and the frames of ordered lanes (feeds whose
//! events Node's phone path never drops, `remote-relay-push-lanes.ts:103-176`) are never dropped
//! or merged. Answers and server requests hold the control reserve (`controlReserveBytes`), so
//! they and pings (which hold nothing) still queue while events fill their own room. Ordered
//! lanes' frames hold the ordered event room (`orderedQueueBytes`, 8 MiB): an empty room admits
//! one frame of any size (no single event closes a connection; `lsp:` and `fs:` frames have no
//! size bound in the core, nor in Node), and behind it frames queue while the held bytes stay
//! within the room. This is Node's admission for a phone's leg (`admitFrame`,
//! `relay-transport.mjs:301-314`: `queued > 0 && queued + size > budget` cuts the leg, budget
//! 8 MiB, `:198`, `remote-transport.ts:90`). A frame that finds the room passed means the peer has
//! not taken 8 MiB of events: the connection closes with 4000 `slowConsumer`, as Node ends the phone's
//! session rather than drop one (`coordinator.ts:1181`, `remote-relay-delivery.ts:208`). An
//! ordered lane may lag only before anything of it was written (its first snapshot is then taken
//! again); after that a lag closes the connection.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::sink::BudgetFull;
use mixdog_core_api::sink::ByteBudget;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_core_api::sink::Lane;
use mixdog_core_api::sink::LaneRecovery;
use mixdog_core_api::sink::LaneRelease;
use mixdog_core_api::sink::Reservation;
use mixdog_core_api::sink::SinkClosed;
use mixdog_core_api::sink::SlotFill;
use mixdog_core_api::sink::SnapshotSlot;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::append_batch::Appends;
use crate::append_batch::Out;
use crate::connection::ConnectionOrigin;
use crate::socket::SocketWrite;

/// Sizes the writer enforces, from `initialize.limits`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct WriterLimits {
    control_reserve: usize,
    event_budget: usize,
    ordered_queue: usize,
    max_snapshot: usize,
    pub(crate) max_inbound: usize,
    pub(crate) max_media: u64,
}

impl WriterLimits {
    pub(crate) fn new(limits: &Limits) -> Self {
        Self {
            control_reserve: limits.control_reserve_bytes as usize,
            event_budget: limits.event_budget_bytes as usize,
            ordered_queue: limits.ordered_queue_bytes as usize,
            max_snapshot: limits.max_snapshot_bytes as usize,
            max_inbound: limits.max_inbound_frame_bytes as usize,
            max_media: limits.max_media_frame_bytes,
        }
    }
}

/// The shared event budget of a connection. Releasing bytes wakes the writer while a lagged
/// lane waits for room, so recovery never depends on another event arriving.
///
/// Fairness is structural (see [`Shared::take_for`]): every lane is guaranteed its fair share
/// `total / lanes`; room beyond it is borrowed from what other lanes leave unused and is
/// revoked (the borrowing lane lags) the moment a lane within its share needs it.
///
/// **Bound.** Charged bytes (`used`) never exceed `total + slack` (`slack` = `maxSnapshotBytes`,
/// the largest frame the writer can have in flight), at every moment and for any number of
/// lanes and producer-held reservations, because
/// 1. every charge is made through a lane under the state lock and, apart from the guaranteed
///    case, only if it fits in `total`;
/// 2. lagging, revoking or removing a lane *voids* its [`LaneBudget`]: everything the lane
///    holds, queued or in a producer's hands, is returned at once, and reservations of the
///    voided generation return nothing when dropped and are refused when pushed;
/// 3. after a revocation every other lane holds at most its share, so the lane's guaranteed
///    request fits unless the writer's single in-flight frame (charged to the connection,
///    not to a lane, from the moment it is dequeued until the socket took it) is in the way.
struct EventBudget {
    total: usize,
    slack: usize,
    /// Charged bytes. Every transition of the budget (take, release, void, recharge) runs under
    /// this one lock and updates the parent charge and the lane's holding in the same step, so
    /// no observer or concurrent taker can see (or act on) a half-applied transition.
    used: Mutex<usize>,
    wake: Notify,
    lag_waiting: AtomicBool,
}

impl EventBudget {
    fn ledger(&self) -> MutexGuard<'_, usize> {
        self.used
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn free(&self) -> usize {
        self.total.saturating_sub(*self.ledger())
    }

    /// Wakes the writer after bytes returned, while a lagged lane waits for room.
    fn returned(&self) {
        if self.lag_waiting.load(Ordering::Acquire) {
            self.wake.notify_one();
        }
    }

    fn try_take(&self, bytes: usize) -> bool {
        let mut used = self.ledger();
        let fits = *used + bytes <= self.total;
        if fits {
            *used += bytes;
        }
        fits
    }

    /// Takes room owed to a request within a guarantee, even above `total`: the only bytes that
    /// can be in the way are those a revoked lane's socket write still holds, which return on
    /// their own.
    fn force_take(&self, bytes: usize) {
        let mut used = self.ledger();
        *used += bytes;
        self.check_bound(*used);
    }

    fn check_bound(&self, used: usize) {
        debug_assert!(
            used <= self.total + self.slack,
            "charged bytes exceed the event budget plus one in-flight frame"
        );
    }
}

thread_local! {
    /// Set by a voided [`LaneBudget`] when a reservation of it is released on this thread, which
    /// is how a push learns its reservation was revoked (`Reservation` hides its budget).
    static REVOKED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    /// Runs inside a release, after the lane's holding changed and before the parent charge
    /// does, with the ledger lock held: lets a test pause a release midway.
    static MIDWAY: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

/// Set in `held` once the generation is voided; the rest of the word is the byte count.
const VOID: usize = 1 << (usize::BITS - 1);

/// One generation of a lane's holdings: how many bytes the lane holds, so the writer can tell
/// which lanes are borrowing. A lane gets a fresh generation whenever the old one is voided.
struct LaneBudget {
    parent: Arc<EventBudget>,
    /// Bytes held, or [`VOID`] once revoked. Written only with the parent's ledger lock held.
    held: AtomicUsize,
}

impl LaneBudget {
    fn new(parent: Arc<EventBudget>) -> Arc<Self> {
        Arc::new(Self {
            parent,
            held: AtomicUsize::new(0),
        })
    }

    fn held(&self) -> usize {
        let _ledger = self.parent.ledger();
        self.held.load(Ordering::Acquire) & !VOID
    }

    /// The one admission rule for every charge to this lane (a fresh reservation and the
    /// re-charge of a pushed frame): the bytes are admitted if they fit in `total`, or, when
    /// `share` is given, if they keep the lane within its guaranteed share (then even above
    /// `total`, up to the in-flight allowance). A voided generation admits nothing.
    fn take(&self, bytes: usize, share: Option<usize>) -> bool {
        let mut used = self.parent.ledger();
        let held = self.held.load(Ordering::Acquire);
        if held & VOID != 0 {
            return false;
        }
        let fits = *used + bytes <= self.parent.total;
        if !fits && !share.is_some_and(|share| held + bytes <= share) {
            return false;
        }
        *used += bytes;
        self.held.store(held + bytes, Ordering::Release);
        self.parent.check_bound(*used);
        true
    }

    /// Returns everything this generation holds to the parent now. Later releases of its
    /// reservations return nothing.
    fn void(&self) {
        {
            let mut used = self.parent.ledger();
            let held = self.held.swap(VOID, Ordering::AcqRel);
            if held & VOID == 0 {
                *used -= held;
            }
        }
        self.parent.returned();
    }
}

impl ByteBudget for LaneBudget {
    fn release(&self, bytes: usize) {
        let live = {
            let mut used = self.parent.ledger();
            let held = self.held.load(Ordering::Acquire);
            if held & VOID == 0 {
                self.held.store(held - bytes, Ordering::Release);
                #[cfg(test)]
                MIDWAY.with(|hook| {
                    if let Some(hook) = hook.borrow().as_ref() {
                        hook();
                    }
                });
                *used -= bytes;
                true
            } else {
                false
            }
        };
        if live {
            self.parent.returned();
        } else {
            REVOKED.with(|revoked| revoked.set(true));
        }
    }
}

/// Re-charges a pushed frame to `budget`, the lane's current generation, by the same admission
/// rule as [`Shared::take_for`] (`share` is the lane's guaranteed share). `None` if the
/// reservation belongs to a voided generation (revoked: the frame is refused and the lane
/// lags). A live reservation is returned and retaken under the state lock, which every other
/// charge also needs, so only returns can interleave and the retake of at most the same bytes
/// is always admitted.
fn recharge(
    budget: &Arc<LaneBudget>,
    mut reservation: Reservation,
    bytes: usize,
    share: usize,
) -> Option<Reservation> {
    REVOKED.with(|revoked| revoked.set(false));
    reservation.shrink_to(0);
    drop(reservation);
    if REVOKED.with(|revoked| revoked.replace(false)) || !budget.take(bytes, Some(share)) {
        return None;
    }
    let budget: Arc<dyn ByteBudget> = budget.clone();
    Some(Reservation::new(bytes, budget))
}

impl ByteBudget for EventBudget {
    fn release(&self, bytes: usize) {
        *self.ledger() -= bytes;
        self.returned();
    }
}
/// How a connection ends. The writer sends the close frame for `Send` and none for `Peer`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Closing {
    Send(CloseCode),
    /// The peer closed or the socket failed: nothing to send.
    Peer,
}

/// A byte room of the ordered class, held by a frame from queueing until the socket has taken
/// it: the control reserve (`controlReserveBytes`: answers, errors, server requests) or the
/// ordered event room (`orderedQueueBytes`: ordered lanes' frames, which also admits one frame of
/// any size while it holds nothing). An atomic, so a reservation dropped under the state lock
/// never waits on it.
struct OrderedReserve {
    total: usize,
    /// While nothing is held, one frame of any size is admitted (module docs).
    admits_any_head: bool,
    used: AtomicUsize,
}

impl OrderedReserve {
    fn new(total: usize, admits_any_head: bool) -> Arc<Self> {
        Arc::new(Self {
            total,
            admits_any_head,
            used: AtomicUsize::new(0),
        })
    }

    fn try_take(self: &Arc<Self>, bytes: usize) -> Option<Reservation> {
        let (total, any_head) = (self.total, self.admits_any_head);
        self.used
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used + bytes <= total || (any_head && used == 0)).then_some(used + bytes)
            })
            .ok()?;
        let budget: Arc<dyn ByteBudget> = self.clone();
        Some(Reservation::new(bytes, budget))
    }
}

impl ByteBudget for OrderedReserve {
    fn release(&self, bytes: usize) {
        self.used.fetch_sub(bytes, Ordering::AcqRel);
    }
}

/// A queued control frame (an answer, error, server request or connection notification).
struct Queued {
    number: u64,
    frame: Bytes,
    release: Option<SubscriptionId>,
    hold: Reservation,
}

struct LaneQueue {
    sub: SubscriptionId,
    released: bool,
    lagged: bool,
    /// An ordered lane (module docs): its frames hold the ordered reserve.
    ordered: bool,
    /// Something of this lane reached the writer; an ordered lane may no longer lag.
    written: bool,
    queue: VecDeque<Entry>,
    recovery: Arc<dyn LaneRecovery>,
    budget: Arc<LaneBudget>,
}

enum Entry {
    Frame {
        number: u64,
        frame: Bytes,
        reservation: Reservation,
    },
    Slot {
        id: u64,
        number: u64,
        /// Pushed to end a lag: merged state that need not keep its place (module docs).
        recovery: bool,
        frame: Option<Bytes>,
        reservation: Reservation,
    },
}

impl Entry {
    fn number(&self) -> u64 {
        match self {
            Entry::Frame { number, .. } | Entry::Slot { number, .. } => *number,
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Entry::Frame { reservation, .. } | Entry::Slot { reservation, .. } => {
                reservation.bytes()
            }
        }
    }
}

/// What the writer writes next, in queue order.
enum Pick {
    Control,
    Lane(u64),
}

#[derive(Default)]
struct State {
    closing: Option<Closing>,
    control: VecDeque<Queued>,
    /// Pings waiting to be written; they go before every text frame.
    pings: usize,
    /// The number the next queued text frame takes.
    next_number: u64,
    /// Lanes in open order.
    lanes: BTreeMap<u64, LaneQueue>,
    by_sub: HashMap<SubscriptionId, u64>,
    next_serial: u64,
    /// Lagged lanes, oldest lag first.
    lagged: VecDeque<u64>,
    recovering: Option<u64>,
    next_slot: u64,
    /// A `feedRanges` peer's text appends being coalesced ([`crate::append_batch`]).
    appends: Appends<Reservation>,
    /// Frames out of the coalescing, in write order, ahead of anything picked after them.
    ready: VecDeque<Out<Reservation>>,
}

impl State {
    fn lag(&mut self, serial: u64) -> usize {
        self.appends.drop_lane(serial);
        let Some(lane) = self.lanes.get_mut(&serial) else {
            return 0;
        };
        let released = lane.queue.drain(..).map(|entry| entry.bytes()).sum();
        // Producer-held reservations are revoked too: their bytes return now and their push
        // is refused, so a lane's charge never outlives its lag.
        lane.budget.void();
        lane.budget = LaneBudget::new(Arc::clone(&lane.budget.parent));
        lane.lagged = true;
        if !self.lagged.contains(&serial) {
            self.lagged.push_back(serial);
        }
        if self.recovering == Some(serial) {
            self.recovering = None;
        }
        released
    }

    /// Removes a lane and every trace of it; the lane (and its reservations) is returned so
    /// the caller drops it outside the lock.
    fn remove_lane(&mut self, serial: u64) -> Option<LaneQueue> {
        self.appends.drop_lane(serial);
        let lane = self.lanes.remove(&serial)?;
        lane.budget.void();
        if self.by_sub.get(&lane.sub) == Some(&serial) {
            self.by_sub.remove(&lane.sub);
        }
        self.lagged.retain(|s| *s != serial);
        if self.recovering == Some(serial) {
            self.recovering = None;
        }
        Some(lane)
    }

    fn number(&mut self) -> u64 {
        let number = self.next_number;
        self.next_number += 1;
        number
    }

    /// The lowest-numbered text frame that can be written now, unless a frame queued before it
    /// cannot be written yet (an unfilled snapshot): then nothing. Lanes waiting for their
    /// response and lagged lanes take no part; a lagged lane's recovery snapshot holds nothing
    /// back, the frames behind it do.
    fn next_in_order(&self) -> Option<Pick> {
        let mut best = self.control.front().map(|queued| (queued.number, Pick::Control));
        let mut barrier = u64::MAX;
        for (serial, lane) in &self.lanes {
            if !lane.released || lane.lagged {
                continue;
            }
            let mut entries = lane.queue.iter();
            match entries.next() {
                Some(
                    Entry::Frame { number, .. }
                    | Entry::Slot {
                        number,
                        frame: Some(_),
                        ..
                    },
                ) => {
                    if best.as_ref().is_none_or(|(lowest, _)| number < lowest) {
                        best = Some((*number, Pick::Lane(*serial)));
                    }
                }
                Some(Entry::Slot {
                    number,
                    recovery: false,
                    frame: None,
                    ..
                }) => barrier = barrier.min(*number),
                Some(Entry::Slot {
                    recovery: true,
                    frame: None,
                    ..
                }) => {
                    if let Some(next) = entries.next() {
                        barrier = barrier.min(next.number());
                    }
                }
                None => {}
            }
        }
        best.filter(|(number, _)| *number < barrier)
            .map(|(_, pick)| pick)
    }

    fn lag_waiting(&self) -> bool {
        self.recovering.is_none() && !self.lagged.is_empty()
    }
}

/// Per-connection state shared by the sink, its lanes, the socket tasks and the heartbeat.
pub(crate) struct Shared {
    id: ConnectionId,
    origin: ConnectionOrigin,
    /// A lower-rights origin the peer asked for during its upgrade (a bridged phone on the SSH
    /// listener). Set at most once, before the connection starts, so it only ever narrows.
    narrowed: OnceLock<ConnectionOrigin>,
    pub(crate) limits: WriterLimits,
    budget: Arc<EventBudget>,
    /// The control reserve: answers, errors and server requests.
    reserve: Arc<OrderedReserve>,
    /// The ordered event room: frames of ordered lanes.
    ordered_room: Arc<OrderedReserve>,
    state: Mutex<State>,
    clock: Arc<AtomicU64>,
    last_rx: AtomicU64,
    /// Tick of the outstanding ping, 0 when none.
    ping_since: AtomicU64,
    /// Tick at which closing began, 0 while open.
    closing_since: AtomicU64,
    upgraded: AtomicBool,
    /// Cancelled when closing begins, whatever the cause.
    gone: CancellationToken,
    /// Cancelled to stop the socket tasks without waiting for the peer.
    pub(crate) abort: CancellationToken,
    media: OnceLock<Arc<dyn HostMediaSink>>,
    /// The peer announced `feedRanges`: text appends are coalesced ([`crate::append_batch`]).
    appends_on: AtomicBool,
}

impl Shared {
    pub(crate) fn new(
        id: ConnectionId,
        origin: ConnectionOrigin,
        limits: WriterLimits,
        clock: Arc<AtomicU64>,
    ) -> Self {
        let now = clock.load(Ordering::Relaxed);
        Self {
            id,
            origin,
            narrowed: OnceLock::new(),
            limits,
            budget: Arc::new(EventBudget {
                total: limits.event_budget,
                slack: limits.max_snapshot,
                used: Mutex::new(0),
                wake: Notify::new(),
                lag_waiting: AtomicBool::new(false),
            }),
            reserve: OrderedReserve::new(limits.control_reserve, false),
            ordered_room: OrderedReserve::new(limits.ordered_queue, true),
            state: Mutex::new(State::default()),
            clock,
            last_rx: AtomicU64::new(now),
            ping_since: AtomicU64::new(0),
            closing_since: AtomicU64::new(0),
            upgraded: AtomicBool::new(false),
            gone: CancellationToken::new(),
            abort: CancellationToken::new(),
            media: OnceLock::new(),
            appends_on: AtomicBool::new(false),
        }
    }

    /// `frame` (of lane `lane`, none for a control frame) is next in write order: through the coalescing for a `feedRanges` peer.
    fn through(&self, state: &mut State, lane: Option<u64>, frame: Bytes, hold: Reservation) -> Work {
        if !self.appends_on.load(Ordering::Acquire) {
            return Work::Text(frame, hold);
        }
        let out = state.appends.admit(lane, frame, hold, tokio::time::Instant::now());
        state.ready.extend(out);
        match state.ready.pop_front() {
            Some((frame, holds)) => Work::Batch(frame, holds),
            None => Work::Held,
        }
    }

    /// When the coalescing's window ends, if one is open.
    fn appends_due(&self) -> Option<tokio::time::Instant> {
        self.lock().appends.due()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wake(&self) {
        self.budget.wake.notify_one();
    }

    /// Takes `bytes` for lane `serial`, under the state lock.
    ///
    /// Invariant: a request that keeps the lane within its fair share `total / lanes` always
    /// succeeds, whatever the other lanes hold. Only the part of a lane above its share is
    /// borrowed, so the guarantees of all lanes sum to at most `total`; borrowers are lagged
    /// (queue dropped, bytes returned at once) before a lane within its share is refused, and
    /// a lane whose share shrank because a lane opened is lagged by [`Shared::shrink_shares`].
    /// A request above the share may still borrow free room, or revoke borrowers, up to a
    /// snapshot, which a lane must be able to hold to recover.
    fn take_for(&self, state: &mut State, serial: u64, bytes: usize) -> Option<Reservation> {
        let lane_budget = Arc::clone(&state.lanes.get(&serial)?.budget);
        let share = self.share(state);
        let target = lane_budget.held() + bytes;
        let guaranteed = target <= share;
        if !lane_budget.take(bytes, None) {
            if !guaranteed && target > share.max(self.limits.max_snapshot) {
                return None;
            }
            self.revoke_borrowers(state, serial, share);
            if !lane_budget.take(bytes, guaranteed.then_some(share)) {
                return None;
            }
        }
        Some(Reservation::new(bytes, lane_budget))
    }

    fn share(&self, state: &State) -> usize {
        self.limits.event_budget / state.lanes.len().max(1)
    }

    /// Lags every lane other than `except` that holds more than `share`.
    fn revoke_borrowers(&self, state: &mut State, except: u64, share: usize) {
        let over: Vec<u64> = state
            .lanes
            .iter()
            .filter(|(serial, lane)| **serial != except && lane.budget.held() > share)
            .map(|(serial, _)| *serial)
            .collect();
        for serial in over {
            state.lag(serial);
        }
        self.sync_lag_flag(state);
    }

    /// A lane opened, so every share shrank: lanes above their new share lag at once.
    fn shrink_shares(&self, state: &mut State) {
        let share = self.share(state);
        self.revoke_borrowers(state, u64::MAX, share);
    }

    fn sync_lag_flag(&self, state: &State) {
        self.budget
            .lag_waiting
            .store(state.lag_waiting(), Ordering::Release);
    }

    pub(crate) fn mark_upgraded(&self) {
        self.upgraded.store(true, Ordering::Release);
    }

    pub(crate) fn is_upgraded(&self) -> bool {
        self.upgraded.load(Ordering::Acquire)
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.closing_since.load(Ordering::Acquire) != 0
    }

    pub(crate) fn closing(&self) -> Option<Closing> {
        self.lock().closing
    }

    pub(crate) fn media(&self) -> Option<&Arc<dyn HostMediaSink>> {
        self.media.get()
    }

    pub(crate) fn id(&self) -> ConnectionId {
        self.id
    }

    pub(crate) fn origin(&self) -> &ConnectionOrigin {
        self.narrowed.get().unwrap_or(&self.origin)
    }

    /// Takes `origin` instead of the listener's. False when one was taken already.
    pub(crate) fn narrow(&self, origin: ConnectionOrigin) -> bool {
        self.narrowed.set(origin).is_ok()
    }

    /// Any received frame: the peer is alive.
    pub(crate) fn note_rx(&self) {
        self.last_rx
            .store(self.clock.load(Ordering::Relaxed), Ordering::Release);
        self.ping_since.store(0, Ordering::Release);
    }

    /// Starts closing once. With `drain`, control frames already queued are still written
    /// before the close frame; otherwise they are discarded. Lanes are always released.
    pub(crate) fn begin_close(&self, closing: Closing, drain: bool) -> bool {
        let lanes = {
            let mut state = self.lock();
            if state.closing.is_some() {
                return false;
            }
            state.closing = Some(closing);
            if !drain {
                state.control.clear();
                state.pings = 0;
            }
            state.lagged.clear();
            state.recovering = None;
            state.by_sub.clear();
            // Clear on disconnect: no held append or coalesced frame outlives the connection.
            state.appends.clear();
            state.ready.clear();
            let lanes = std::mem::take(&mut state.lanes);
            self.sync_lag_flag(&state);
            lanes
        };
        for lane in lanes.values() {
            lane.budget.void();
        }
        let now = self.clock.load(Ordering::Relaxed);
        self.closing_since.store(now, Ordering::Release);
        self.gone.cancel();
        drop(lanes);
        self.wake();
        true
    }

    fn queue_control(&self, frame: Bytes, release: Option<SubscriptionId>) -> Result<(), SinkClosed> {
        {
            let mut state = self.lock();
            if state.closing.is_some() {
                return Err(SinkClosed);
            }
            if let Some(hold) = self.reserve.try_take(frame.len()) {
                let number = state.number();
                state.control.push_back(Queued {
                    number,
                    frame,
                    release,
                    hold,
                });
                drop(state);
                self.wake();
                return Ok(());
            }
        }
        self.slow_consumer();
        Err(SinkClosed)
    }

    /// The peer reads nothing, not even the ordered class: close, dropping what is queued.
    fn slow_consumer(&self) {
        self.begin_close(Closing::Send(CloseCode::SlowConsumer), false);
    }

    fn queue_ping(&self) -> bool {
        let mut state = self.lock();
        if state.closing.is_some() {
            return false;
        }
        state.pings += 1;
        drop(state);
        self.wake();
        true
    }

    /// One heartbeat tick `t` for this connection (P §4.7).
    pub(crate) fn on_tick(&self, t: u64) {
        let closing_since = self.closing_since.load(Ordering::Acquire);
        if closing_since != 0 {
            // A close that the peer does not complete within a tick is abandoned.
            if closing_since + 1 < t {
                self.abort.cancel();
            }
            return;
        }
        let last_rx = self.last_rx.load(Ordering::Acquire);
        if !self.is_upgraded() {
            if last_rx + 1 < t {
                self.begin_close(Closing::Peer, false);
                self.abort.cancel();
            }
            return;
        }
        let ping = self.ping_since.load(Ordering::Acquire);
        if ping != 0 {
            if ping + 2 <= t {
                self.begin_close(Closing::Send(CloseCode::PeerUnresponsive), false);
            }
        } else if last_rx + 1 < t && self.queue_ping() {
            self.ping_since.store(t, Ordering::Release);
        }
    }

    /// The next thing the writer task does. Pings first; once closing, the control frames still
    /// queued and then the close frame; else recovery of the oldest lagged lane once the budget
    /// holds a snapshot, then the next text frame in queue order ([`State::next_in_order`]).
    fn next_work(&self) -> Work {
        let mut state = self.lock();
        if state.pings > 0 {
            state.pings -= 1;
            return Work::Ping;
        }
        if let Some(closing) = state.closing {
            return match state.control.pop_front() {
                Some(queued) => Work::Text(queued.frame, queued.hold),
                None => Work::Close(closing),
            };
        }
        // What the coalescing let go goes before anything picked after it; a window that ended lets its appends go.
        if self.appends_on.load(Ordering::Acquire) {
            if let Some(out) = state.appends.fire(tokio::time::Instant::now()) {
                state.ready.push_back(out);
            }
            if let Some((frame, holds)) = state.ready.pop_front() {
                return Work::Batch(frame, holds);
            }
        }
        if state.recovering.is_none()
            && let Some(&serial) = state.lagged.front()
            && let Some(reservation) = self.take_for(&mut state, serial, self.limits.max_snapshot)
        {
            state.lagged.pop_front();
            state.recovering = Some(serial);
            self.sync_lag_flag(&state);
            if let Some(lane) = state.lanes.get(&serial) {
                return Work::Recover {
                    recovery: lane.recovery.clone(),
                    sub: lane.sub.clone(),
                    serial,
                    reservation,
                };
            }
        }
        let serial = match state.next_in_order() {
            None => return Work::Idle,
            Some(Pick::Control) => {
                let queued = state.control.pop_front().expect("the pick is the control head");
                if let Some(serial) = queued
                    .release
                    .and_then(|sub| state.by_sub.get(&sub).copied())
                    && let Some(lane) = state.lanes.get_mut(&serial)
                {
                    lane.released = true;
                }
                // The reserve stays charged until the socket has taken the frame.
                return self.through(&mut state, None, queued.frame, queued.hold);
            }
            Some(Pick::Lane(serial)) => serial,
        };
        let lane = state.lanes.get_mut(&serial).expect("the picked lane exists");
        lane.written = true;
        let ordered = lane.ordered;
        let (frame, reservation, was_slot) = match lane.queue.pop_front() {
            Some(Entry::Frame {
                frame, reservation, ..
            }) => (frame, reservation, false),
            Some(Entry::Slot {
                frame: Some(frame),
                reservation,
                ..
            }) => (frame, reservation, true),
            _ => unreachable!("next_in_order checked the head"),
        };
        if was_slot && state.recovering == Some(serial) {
            state.recovering = None;
            self.sync_lag_flag(&state);
        }
        if ordered && !was_slot {
            // An ordered frame holds the ordered reserve, which no lag can void.
            return self.through(&mut state, Some(serial), frame, reservation);
        }
        // From here the frame belongs to the writer, not to the lane: a lag cannot take it
        // back, and it stays charged until the socket has taken it.
        let bytes = reservation.bytes();
        drop(reservation);
        if !self.budget.try_take(bytes) {
            self.budget.force_take(bytes);
        }
        let budget: Arc<dyn ByteBudget> = self.budget.clone();
        self.through(&mut state, Some(serial), frame, Reservation::new(bytes, budget))
    }

    /// After a recovery attach returned: a lane that is still lagged and still the recovering
    /// one got neither a snapshot slot nor a new lag, so the feed refused it; it is removed so
    /// one dead lane cannot hold the connection's single recovery turn.
    fn recovery_returned(&self, serial: u64) {
        let dead = {
            let mut state = self.lock();
            let failed = state.recovering == Some(serial)
                && state.lanes.get(&serial).is_some_and(|lane| lane.lagged);
            let dead = failed.then(|| state.remove_lane(serial)).flatten();
            self.sync_lag_flag(&state);
            dead
        };
        drop(dead);
    }
}

enum Work {
    /// A text frame and the bytes it holds until the socket has taken it.
    Text(Bytes, Reservation),
    /// A frame out of the coalescing (one append, or the appends of a window joined) and what its frames held.
    Batch(Bytes, Vec<Reservation>),
    /// The picked frame was held by the coalescing: pick again.
    Held,
    Ping,
    Recover {
        recovery: Arc<dyn LaneRecovery>,
        sub: SubscriptionId,
        serial: u64,
        reservation: Reservation,
    },
    Close(Closing),
    Idle,
}

/// The writer task: the only code that awaits the socket for outbound frames.
pub(crate) async fn write_loop<W: SocketWrite>(shared: Arc<Shared>, mut socket: W) {
    loop {
        let step = match shared.next_work() {
            Work::Text(frame, hold) => {
                let sent = guarded(&shared, socket.text(frame)).await;
                // The bytes return to the budget when the socket has taken the frame.
                drop(hold);
                sent
            }
            Work::Batch(frame, holds) => {
                let sent = guarded(&shared, socket.text(frame)).await;
                drop(holds);
                sent
            }
            Work::Held => true,
            Work::Ping => guarded(&shared, socket.ping()).await,
            Work::Recover {
                recovery,
                sub,
                serial,
                reservation,
            } => {
                recovery.recover(sub, reservation);
                shared.recovery_returned(serial);
                true
            }
            Work::Close(Closing::Send(code)) => {
                guarded(&shared, socket.close(code)).await;
                return;
            }
            Work::Close(Closing::Peer) => return,
            Work::Idle => match shared.appends_due() {
                // A coalescing window ends on the clock, not on a new frame.
                Some(due) => tokio::select! {
                    () = shared.budget.wake.notified() => true,
                    () = mixdog_rt::time::sleep_until(due) => true,
                    () = shared.abort.cancelled() => false,
                },
                None => tokio::select! {
                    () = shared.budget.wake.notified() => true,
                    () = shared.abort.cancelled() => false,
                },
            },
        };
        if !step {
            // The socket failed or was abandoned: nothing more can be written.
            shared.begin_close(Closing::Peer, false);
            shared.abort.cancel();
            return;
        }
    }
}

/// Runs a socket write unless the connection is abandoned; `false` on failure or abandon.
async fn guarded<F>(shared: &Shared, write: F) -> bool
where
    F: std::future::Future<Output = Result<(), crate::socket::SocketClosed>>,
{
    tokio::select! {
        result = write => result.is_ok(),
        () = shared.abort.cancelled() => false,
    }
}

/// A connection's writer as the server and the feeds see it: the frozen [`ConnectionSink`]
/// plus the transport-owned operations (close, host role, liveness).
#[derive(Clone)]
pub struct ConnectionWriter {
    pub(crate) shared: Arc<Shared>,
}

impl ConnectionWriter {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    pub fn origin(&self) -> &ConnectionOrigin {
        &self.shared.origin
    }

    /// Closes the connection with `code`: control frames queued so far are still written, then
    /// the close frame. New frames are refused with [`SinkClosed`]; lanes are released at once.
    /// Closing twice keeps the first code.
    pub fn close(&self, code: CloseCode) {
        self.shared.begin_close(Closing::Send(code), true);
    }

    /// The code this side closed with, or `None` while open or when the peer closed first.
    pub fn close_code(&self) -> Option<CloseCode> {
        match self.shared.closing() {
            Some(Closing::Send(code)) => Some(code),
            Some(Closing::Peer) | None => None,
        }
    }

    /// Bytes of the event budget not held by any lane or reservation.
    pub fn event_budget_free(&self) -> usize {
        self.shared.budget.free()
    }

    pub fn is_closed(&self) -> bool {
        self.shared.is_closing()
    }

    /// Cancelled as soon as the connection starts closing, for any reason. In-flight work of
    /// the connection ends on it (P §4.4).
    pub fn closed(&self) -> CancellationToken {
        self.shared.gone.clone()
    }

    /// Grants the host media role (X17, `capabilities.host.media`): binary frames of this
    /// connection are validated and handed to `sink`. Without it any binary frame closes the
    /// connection with 1003. Set once; `false` if a role was already set.
    pub fn grant_host_media(&self, sink: Arc<dyn HostMediaSink>) -> bool {
        self.shared.media.set(sink).is_ok()
    }

    /// A coalescing window is open (a replay compares it with Node's pending batch timer).
    #[doc(hidden)]
    pub fn appends_window_open(&self) -> bool {
        self.shared.appends_due().is_some()
    }
}

impl ConnectionSink for ConnectionWriter {
    fn id(&self) -> ConnectionId {
        self.shared.id
    }

    fn send_control(&self, frame: Bytes) -> Result<(), SinkClosed> {
        self.shared.queue_control(frame, None)
    }

    fn coalesce_appends(&self) {
        self.shared.appends_on.store(true, Ordering::Release);
    }

    fn send_control_release(&self, frame: Bytes, release: LaneRelease) -> Result<(), SinkClosed> {
        debug_assert_eq!(
            release.connection(),
            self.shared.id,
            "lane release of another connection"
        );
        self.shared
            .queue_control(frame, Some(release.sub().clone()))
    }

    fn open_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        self.open(sub, recovery, false)
    }

    fn open_ordered_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        self.open(sub, recovery, true)
    }
}

impl ConnectionWriter {
    fn open(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
        ordered: bool,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        let shared = &self.shared;
        let replaced = {
            let mut state = shared.lock();
            if state.closing.is_some() {
                return Err(SinkClosed);
            }
            let replaced = state
                .by_sub
                .get(&sub)
                .copied()
                .and_then(|serial| state.remove_lane(serial));
            let serial = state.next_serial;
            state.next_serial += 1;
            state.by_sub.insert(sub.clone(), serial);
            state.lanes.insert(
                serial,
                LaneQueue {
                    sub: sub.clone(),
                    released: false,
                    lagged: false,
                    ordered,
                    written: false,
                    queue: VecDeque::new(),
                    recovery,
                    budget: LaneBudget::new(Arc::clone(&shared.budget)),
                },
            );
            shared.shrink_shares(&mut state);
            let lane = WriterLane {
                shared: Arc::clone(shared),
                sub: sub.clone(),
                serial,
                ordered,
            };
            (replaced, lane)
        };
        let (replaced, lane) = replaced;
        drop(replaced);
        shared.wake();
        Ok((Arc::new(lane), LaneRelease::new(shared.id, sub)))
    }
}

/// One subscription's ordered lane inside the connection.
pub struct WriterLane {
    shared: Arc<Shared>,
    sub: SubscriptionId,
    serial: u64,
    /// An ordered lane (module docs).
    ordered: bool,
}

impl WriterLane {
    /// Queues a frame of an ordered lane, holding the ordered reserve.
    fn push_ordered(&self, mut reservation: Reservation, frame: Bytes) {
        reservation.shrink_to(frame.len());
        let wake = {
            let mut guard = self.shared.lock();
            let state = &mut *guard;
            let number = state.next_number;
            match state.lanes.get_mut(&self.serial) {
                Some(lane) if !lane.lagged => {
                    lane.queue.push_back(Entry::Frame {
                        number,
                        frame,
                        reservation,
                    });
                    state.next_number += 1;
                    lane.released
                }
                // A lane lagged before anything of it was written: its next snapshot holds this.
                _ => false,
            }
        };
        if wake {
            self.shared.wake();
        }
    }
}

impl Lane for WriterLane {
    fn sub(&self) -> SubscriptionId {
        self.sub.clone()
    }

    /// Takes from the connection's event budget (see [`Shared::take_for`] for what is owed), or
    /// for an ordered lane from the ordered event room.
    fn try_reserve(&self, bytes: usize) -> Result<Reservation, BudgetFull> {
        if self.ordered {
            return self.shared.ordered_room.try_take(bytes).ok_or(BudgetFull);
        }
        self.try_reserve_snapshot(bytes)
    }

    /// Snapshots of every lane, ordered ones included, are merged state on the event budget.
    fn try_reserve_snapshot(&self, bytes: usize) -> Result<Reservation, BudgetFull> {
        let reservation = {
            let mut state = self.shared.lock();
            self.shared.take_for(&mut state, self.serial, bytes)
        };
        // Lanes lagged to make room are waiting for recovery.
        self.shared.wake();
        reservation.ok_or(BudgetFull)
    }

    fn push(&self, reservation: Reservation, frame: Bytes) {
        assert!(
            frame.len() <= reservation.bytes(),
            "frame exceeds its reservation"
        );
        if self.ordered {
            self.push_ordered(reservation, frame);
            return;
        }
        let wake = {
            let mut guard = self.shared.lock();
            let state = &mut *guard;
            let mut revoked = false;
            let share = self.shared.share(state);
            let number = state.next_number;
            let wake = match state.lanes.get_mut(&self.serial) {
                Some(lane) if !lane.lagged => {
                    let len = frame.len();
                    match recharge(&lane.budget, reservation, len, share) {
                        Some(reservation) => {
                            lane.queue.push_back(Entry::Frame {
                                number,
                                frame,
                                reservation,
                            });
                            state.next_number += 1;
                            lane.released
                        }
                        None => {
                            revoked = true;
                            false
                        }
                    }
                }
                // Lagged or closed lane: the frame is discarded and the bytes return at once.
                _ => false,
            };
            if revoked {
                // The frame is lost, so the lane must recover through a snapshot.
                state.lag(self.serial);
                self.shared.sync_lag_flag(&state);
            }
            wake || revoked
        };
        if wake {
            self.shared.wake();
        }
    }

    fn push_slot(&self, reservation: Reservation) -> SnapshotSlot {
        let id = {
            let mut guard = self.shared.lock();
            let state = &mut *guard;
            let id = state.next_slot;
            state.next_slot += 1;
            let serial = self.serial;
            let share = self.shared.share(state);
            let mut revoked = false;
            if let Some(lane) = state.lanes.get_mut(&serial) {
                let bytes = reservation.bytes();
                match recharge(&lane.budget, reservation, bytes, share) {
                    Some(reservation) => {
                        let recovery = lane.lagged;
                        lane.lagged = false;
                        lane.queue.push_back(Entry::Slot {
                            id,
                            number: state.next_number,
                            recovery,
                            frame: None,
                            reservation,
                        });
                        state.next_number += 1;
                        state.lagged.retain(|s| *s != serial);
                    }
                    // Revoked while the snapshot was prepared: the lane stays lagged and takes
                    // another recovery turn; the slot returned below is inert.
                    None => revoked = true,
                }
            }
            if revoked {
                state.lag(serial);
            }
            self.shared.sync_lag_flag(state);
            id
        };
        SnapshotSlot::new(Box::new(WriterSlot {
            shared: Arc::downgrade(&self.shared),
            serial: self.serial,
            id,
            filled: false,
        }))
    }

    /// An ordered lane that has written something closes the connection instead (module docs).
    fn lag(&self) -> usize {
        let released = {
            let mut state = self.shared.lock();
            let live_ordered = state
                .lanes
                .get(&self.serial)
                .is_some_and(|lane| lane.ordered && lane.written);
            if live_ordered {
                None
            } else {
                let released = state.lag(self.serial);
                self.shared.sync_lag_flag(&state);
                Some(released)
            }
        };
        let Some(released) = released else {
            self.shared.slow_consumer();
            return 0;
        };
        self.shared.wake();
        released
    }

    fn is_lagged(&self) -> bool {
        self.shared
            .lock()
            .lanes
            .get(&self.serial)
            .is_some_and(|lane| lane.lagged)
    }

    fn close(&self) {
        let removed = {
            let mut state = self.shared.lock();
            let removed = state.remove_lane(self.serial);
            self.shared.sync_lag_flag(&state);
            removed
        };
        drop(removed);
        self.shared.wake();
    }
}

struct WriterSlot {
    shared: Weak<Shared>,
    serial: u64,
    id: u64,
    filled: bool,
}

impl WriterSlot {
    /// Runs `f` on the slot's entry if it is still queued. The entry is taken out so `f` may
    /// lag the lane, and put back unless `f` answers `false`.
    fn with_entry(&self, f: impl FnOnce(&mut State, &mut Option<Bytes>, &mut Reservation) -> bool) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        {
            let mut state = shared.lock();
            let Some(lane) = state.lanes.get_mut(&self.serial) else {
                return;
            };
            let Some(index) = lane
                .queue
                .iter()
                .position(|entry| matches!(entry, Entry::Slot { id, .. } if *id == self.id))
            else {
                return;
            };
            let Some(Entry::Slot {
                id,
                number,
                recovery,
                mut frame,
                mut reservation,
            }) = lane.queue.remove(index)
            else {
                unreachable!("position matched a slot");
            };
            if f(&mut state, &mut frame, &mut reservation)
                && let Some(lane) = state.lanes.get_mut(&self.serial)
            {
                lane.queue.insert(
                    index,
                    Entry::Slot {
                        id,
                        number,
                        recovery,
                        frame,
                        reservation,
                    },
                );
            }
            shared.sync_lag_flag(&state);
        }
        shared.wake();
    }
}

impl SlotFill for WriterSlot {
    fn fill(mut self: Box<Self>, bytes: Bytes) {
        self.filled = true;
        let serial = self.serial;
        self.with_entry(|state, frame, reservation| {
            if bytes.len() > reservation.bytes() {
                state.lag(serial);
                return false;
            }
            reservation.shrink_to(bytes.len());
            *frame = Some(bytes);
            true
        });
    }
}

impl Drop for WriterSlot {
    fn drop(&mut self) {
        if !self.filled {
            let serial = self.serial;
            self.with_entry(|state, _, _| {
                state.lag(serial);
                false
            });
        }
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn budget(total: usize, slack: usize) -> Arc<EventBudget> {
        Arc::new(EventBudget {
            total,
            slack,
            used: Mutex::new(0),
            wake: Notify::new(),
            lag_waiting: AtomicBool::new(false),
        })
    }

    /// A release paused between the lane's holding and the parent charge cannot be overtaken:
    /// a concurrent charge waits for the whole transition, so the bound holds at every moment.
    #[test]
    fn a_release_paused_midway_cannot_be_overtaken_by_a_charge() {
        let parent = budget(100, 50);
        let lane = LaneBudget::new(Arc::clone(&parent));
        assert!(lane.take(100, None));

        let (paused_tx, paused_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let releaser = {
            let lane = Arc::clone(&lane);
            std::thread::spawn(move || {
                MIDWAY.with(|hook| {
                    *hook.borrow_mut() = Some(Box::new(move || {
                        paused_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                    }));
                });
                lane.release(100);
            })
        };
        paused_rx.recv().unwrap();

        // Another lane is owed 50 bytes above the total (its guarantee). Were the release
        // not atomic it would be admitted now, on top of the not yet returned 100: 150.
        let other = LaneBudget::new(Arc::clone(&parent));
        let (done_tx, done_rx) = mpsc::channel();
        let taker = {
            let other = Arc::clone(&other);
            std::thread::spawn(move || {
                let taken = other.take(50, Some(50));
                done_tx.send(taken).unwrap();
            })
        };
        assert!(
            done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "a charge must wait for the paused release"
        );

        go_tx.send(()).unwrap();
        releaser.join().unwrap();
        assert!(done_rx.recv().unwrap());
        taker.join().unwrap();
        assert_eq!(*parent.ledger(), 50, "the release returned its 100, the charge took 50");
        assert_eq!(lane.held(), 0);
        assert_eq!(other.held(), 50);
    }
}