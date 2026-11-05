//! A mock connection with the P §6.5 writer: control lane first, then lanes round-robin one
//! frame per turn; gated lanes, snapshot slots, lag and writer-driven recovery.

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use bytes::Bytes;

use super::MockLimits;
use crate::ids::ConnectionId;
use crate::ids::SubscriptionId;
use crate::sink::BudgetFull;
use crate::sink::ByteBudget;
use crate::sink::ConnectionSink;
use crate::sink::Lane;
use crate::sink::LaneRecovery;
use crate::sink::LaneRelease;
use crate::sink::Reservation;
use crate::sink::SinkClosed;
use crate::sink::SlotFill;
use crate::sink::SnapshotSlot;

/// One frame handed to the socket: `lane` is `None` for the control lane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub lane: Option<SubscriptionId>,
    pub frame: Bytes,
}

pub struct MockConnection {
    shared: Arc<Shared>,
}

struct Shared {
    id: ConnectionId,
    limits: MockLimits,
    budget: Arc<EventBudget>,
    state: Mutex<State>,
}

struct EventBudget {
    free: AtomicUsize,
}

impl EventBudget {
    fn try_take(&self, bytes: usize) -> bool {
        self.free
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |free| {
                free.checked_sub(bytes)
            })
            .is_ok()
    }
}

impl ByteBudget for EventBudget {
    fn release(&self, bytes: usize) {
        self.free.fetch_add(bytes, Ordering::AcqRel);
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    control: VecDeque<(Bytes, Option<SubscriptionId>)>,
    control_used: usize,
    lanes: BTreeMap<SubscriptionId, LaneQueue>,
    last_written: Option<SubscriptionId>,
    lagged: VecDeque<SubscriptionId>,
    recovering: Option<SubscriptionId>,
    next_slot: u64,
}

struct LaneQueue {
    released: bool,
    lagged: bool,
    queue: VecDeque<Entry>,
    recovery: Arc<dyn LaneRecovery>,
}

enum Entry {
    Frame(Bytes, Reservation),
    Slot {
        id: u64,
        frame: Option<Bytes>,
        reservation: Reservation,
    },
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reserve(&self, bytes: usize) -> Option<Reservation> {
        let budget: Arc<dyn ByteBudget> = self.budget.clone();
        self.budget
            .try_take(bytes)
            .then(|| Reservation::new(bytes, budget))
    }
}

impl State {
    fn lag(&mut self, sub: &SubscriptionId) -> usize {
        let Some(lane) = self.lanes.get_mut(sub) else {
            return 0;
        };
        let released = lane
            .queue
            .drain(..)
            .map(|entry| match entry {
                Entry::Frame(_, reservation) => reservation.bytes(),
                Entry::Slot { reservation, .. } => reservation.bytes(),
            })
            .sum();
        lane.lagged = true;
        if !self.lagged.contains(sub) {
            self.lagged.push_back(sub.clone());
        }
        if self.recovering.as_ref() == Some(sub) {
            self.recovering = None;
        }
        released
    }

    /// The next lane in round-robin order after the last written one that can write now.
    fn next_writable(&self) -> Option<SubscriptionId> {
        let writable = |(sub, lane): (&SubscriptionId, &LaneQueue)| {
            let ready = match lane.queue.front() {
                Some(Entry::Frame(..)) => true,
                Some(Entry::Slot { frame, .. }) => frame.is_some(),
                None => false,
            };
            (lane.released && !lane.lagged && ready).then(|| sub.clone())
        };
        let after = self.last_written.clone();
        let tail = self
            .lanes
            .iter()
            .filter(|(sub, _)| after.as_ref().is_some_and(|last| *sub > last))
            .find_map(writable);
        tail.or_else(|| self.lanes.iter().find_map(writable))
    }
}

impl MockConnection {
    pub fn new(id: ConnectionId, limits: MockLimits) -> Self {
        Self {
            shared: Arc::new(Shared {
                id,
                limits,
                budget: Arc::new(EventBudget {
                    free: AtomicUsize::new(limits.event_budget_bytes()),
                }),
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Free bytes of the event budget.
    pub fn event_free(&self) -> usize {
        self.shared.budget.free.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.shared.lock().closed
    }

    /// Runs the writer until nothing can be written, returning the frames in socket order.
    /// Before each write it starts the recovery of the oldest lagged lane once the free event
    /// budget holds `maxSnapshotBytes` (one recovering lane at a time).
    pub fn drain(&self) -> Vec<Written> {
        let mut written = Vec::new();
        loop {
            self.start_recovery();
            let mut state = self.shared.lock();
            if state.closed {
                break;
            }
            if let Some((frame, release)) = state.control.pop_front() {
                state.control_used -= frame.len();
                if let Some(lane) = release.and_then(|sub| state.lanes.get_mut(&sub)) {
                    lane.released = true;
                }
                written.push(Written { lane: None, frame });
                continue;
            }
            let Some(sub) = state.next_writable() else {
                break;
            };
            let entry = state
                .lanes
                .get_mut(&sub)
                .expect("writable lane exists")
                .queue
                .pop_front();
            let frame = match entry {
                Some(Entry::Frame(frame, _reservation)) => frame,
                Some(Entry::Slot {
                    frame: Some(frame), ..
                }) => {
                    if state.recovering.as_ref() == Some(&sub) {
                        state.recovering = None;
                    }
                    frame
                }
                _ => unreachable!("next_writable checked the head"),
            };
            state.last_written = Some(sub.clone());
            written.push(Written {
                lane: Some(sub),
                frame,
            });
        }
        written
    }

    /// [`Self::drain`] rendered as `control:<text>` / `<sub>:<text>`.
    pub fn drain_text(&self) -> Vec<String> {
        self.drain()
            .into_iter()
            .map(|w| {
                let text = String::from_utf8_lossy(&w.frame);
                match w.lane {
                    None => format!("control:{text}"),
                    Some(sub) => format!("{sub}:{text}"),
                }
            })
            .collect()
    }

    fn start_recovery(&self) {
        let (recovery, sub, reservation) = {
            let mut state = self.shared.lock();
            if state.closed || state.recovering.is_some() {
                return;
            }
            let Some(sub) = state.lagged.front().cloned() else {
                return;
            };
            let Some(reservation) = self.shared.reserve(self.shared.limits.max_snapshot_bytes)
            else {
                return;
            };
            state.lagged.pop_front();
            state.recovering = Some(sub.clone());
            let recovery = state.lanes[&sub].recovery.clone();
            (recovery, sub, reservation)
        };
        recovery.recover(sub, reservation);
    }

    fn queue_control(
        &self,
        frame: Bytes,
        release: Option<SubscriptionId>,
    ) -> Result<(), SinkClosed> {
        let mut state = self.shared.lock();
        if state.closed {
            return Err(SinkClosed);
        }
        if state.control_used + frame.len() > self.shared.limits.control_reserve_bytes {
            // Control reserve exhausted: close 4000 slowConsumer.
            *state = State {
                closed: true,
                ..State::default()
            };
            return Err(SinkClosed);
        }
        state.control_used += frame.len();
        state.control.push_back((frame, release));
        Ok(())
    }
}

impl ConnectionSink for MockConnection {
    fn id(&self) -> ConnectionId {
        self.shared.id
    }

    fn send_control(&self, frame: Bytes) -> Result<(), SinkClosed> {
        self.queue_control(frame, None)
    }

    fn send_control_release(&self, frame: Bytes, release: LaneRelease) -> Result<(), SinkClosed> {
        assert_eq!(
            release.connection(),
            self.shared.id,
            "lane release of another connection"
        );
        self.queue_control(frame, Some(release.sub().clone()))
    }

    fn open_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        let mut state = self.shared.lock();
        if state.closed {
            return Err(SinkClosed);
        }
        state.lanes.insert(
            sub.clone(),
            LaneQueue {
                released: false,
                lagged: false,
                queue: VecDeque::new(),
                recovery,
            },
        );
        let lane = Arc::new(MockLane {
            shared: self.shared.clone(),
            sub: sub.clone(),
        });
        Ok((lane, LaneRelease::new(self.shared.id, sub)))
    }
}

struct MockLane {
    shared: Arc<Shared>,
    sub: SubscriptionId,
}

impl Lane for MockLane {
    fn sub(&self) -> SubscriptionId {
        self.sub.clone()
    }

    fn try_reserve(&self, bytes: usize) -> Result<Reservation, BudgetFull> {
        self.shared.reserve(bytes).ok_or(BudgetFull)
    }

    fn push(&self, reservation: Reservation, frame: Bytes) {
        assert!(
            frame.len() <= reservation.bytes(),
            "frame exceeds its reservation"
        );
        let mut state = self.shared.lock();
        if let Some(lane) = state.lanes.get_mut(&self.sub)
            && !lane.lagged
        {
            lane.queue.push_back(Entry::Frame(frame, reservation));
        }
    }

    fn push_slot(&self, reservation: Reservation) -> SnapshotSlot {
        let mut state = self.shared.lock();
        let id = state.next_slot;
        state.next_slot += 1;
        state.lagged.retain(|sub| *sub != self.sub);
        if let Some(lane) = state.lanes.get_mut(&self.sub) {
            lane.lagged = false;
            lane.queue.push_back(Entry::Slot {
                id,
                frame: None,
                reservation,
            });
        }
        SnapshotSlot::new(Box::new(MockSlot {
            shared: Arc::downgrade(&self.shared),
            sub: self.sub.clone(),
            id,
            filled: false,
        }))
    }

    fn lag(&self) -> usize {
        self.shared.lock().lag(&self.sub)
    }

    fn is_lagged(&self) -> bool {
        self.shared
            .lock()
            .lanes
            .get(&self.sub)
            .is_some_and(|lane| lane.lagged)
    }

    fn close(&self) {
        let mut state = self.shared.lock();
        state.lanes.remove(&self.sub);
        state.lagged.retain(|sub| *sub != self.sub);
        if state.recovering.as_ref() == Some(&self.sub) {
            state.recovering = None;
        }
    }
}

struct MockSlot {
    shared: Weak<Shared>,
    sub: SubscriptionId,
    id: u64,
    filled: bool,
}

impl MockSlot {
    /// Runs `f` on the slot's entry if it is still queued.
    fn with_entry(&self, f: impl FnOnce(&mut State, &mut Option<Bytes>, &mut Reservation) -> bool) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let mut state = shared.lock();
        let Some(lane) = state.lanes.get_mut(&self.sub) else {
            return;
        };
        let Some(index) = lane
            .queue
            .iter()
            .position(|entry| matches!(entry, Entry::Slot { id, .. } if *id == self.id))
        else {
            return;
        };
        // Take the entry out so `f` may lag the lane, then put it back unless it lagged.
        let Some(Entry::Slot {
            id,
            mut frame,
            mut reservation,
        }) = lane.queue.remove(index)
        else {
            unreachable!("position matched a slot");
        };
        if f(&mut state, &mut frame, &mut reservation)
            && let Some(lane) = state.lanes.get_mut(&self.sub)
        {
            lane.queue.insert(
                index,
                Entry::Slot {
                    id,
                    frame,
                    reservation,
                },
            );
        }
    }
}

impl SlotFill for MockSlot {
    fn fill(mut self: Box<Self>, bytes: Bytes) {
        self.filled = true;
        let sub = self.sub.clone();
        self.with_entry(|state, frame, reservation| {
            if bytes.len() > reservation.bytes() {
                state.lag(&sub);
                return false;
            }
            reservation.shrink_to(bytes.len());
            *frame = Some(bytes);
            true
        });
    }
}

impl Drop for MockSlot {
    fn drop(&mut self) {
        if !self.filled {
            let sub = self.sub.clone();
            self.with_entry(|state, _, _| {
                state.lag(&sub);
                false
            });
        }
    }
}
