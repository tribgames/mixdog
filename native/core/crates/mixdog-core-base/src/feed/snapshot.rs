//! Single-flight snapshot encodes (P §6.4, RL §7.3, SPEC §4.2).
//!
//! A feed has one epoch, so its cache key `(feed, epoch, S, window)` reduces to `(S, window)`.
//! Every attach that needs the snapshot at `S` for `window` joins one [`Flight`]: the first
//! submits the encode to cpu-interactive, the others park their slots on it, and a flight
//! that already finished fills a slot at once. N subscribers therefore cost one encode.
//!
//! The cache holds flights of the current view only (P §6.5 "Snapshot cache"). Pending
//! flights stay shareable until they finish or the view changes. Completed flights share
//! one snapshot's byte budget; evicting one drops only the cache's reference.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use bytes::Bytes;
use mixdog_core_api::feed::Window;
use mixdog_core_api::sink::SnapshotSlot;

/// The flights of one seq, under the feed lock.
pub(super) struct SnapshotCache {
    seq: u64,
    flights: HashMap<Window, Arc<Flight>>,
    completed: VecDeque<(Window, usize)>,
    completed_bytes: usize,
    limit: usize,
}

impl SnapshotCache {
    pub fn new(limit: usize) -> Self {
        Self { seq: 0, flights: HashMap::new(), completed: VecDeque::new(), completed_bytes: 0, limit }
    }

    /// The flight for the snapshot at `seq` for `window`, and whether the caller leads it
    /// (must submit its encode). A failed flight is replaced, so a later attach retries.
    pub fn flight(&mut self, seq: u64, window: &Window) -> (Arc<Flight>, bool) {
        if self.seq != seq {
            self.clear();
            self.seq = seq;
        }
        if let Some(flight) = self.flights.get(window)
            && !flight.failed()
        {
            return (flight.clone(), false);
        }
        let flight = Arc::new(Flight::default());
        self.flights.insert(window.clone(), flight.clone());
        (flight, true)
    }

    pub fn retain_completed(&mut self, window: &Window, flight: &Arc<Flight>, len: usize) {
        // A publish or same-seq view swap may have replaced this flight while it ran.
        if !self.flights.get(window).is_some_and(|current| Arc::ptr_eq(current, flight)) {
            return;
        }
        let charge = len.max(1); // Bound entries even for empty encodings.
        if charge > self.limit {
            self.flights.remove(window);
            return;
        }
        while self.completed_bytes > self.limit - charge {
            let (oldest, bytes) = self.completed.pop_front().expect("charged flights exist");
            self.flights.remove(&oldest);
            self.completed_bytes -= bytes;
        }
        self.completed.push_back((window.clone(), charge));
        self.completed_bytes += charge;
    }

    /// Drops every flight: called when the seq advances, a view is swapped with no frame, or the feed closes.
    pub fn clear(&mut self) {
        self.flights.clear();
        self.completed.clear();
        self.completed_bytes = 0;
    }
}

/// One snapshot encode and the slots waiting for it.
#[derive(Default)]
pub(super) struct Flight {
    state: Mutex<FlightState>,
}

enum FlightState {
    Encoding(Vec<SnapshotSlot>),
    Ready(Bytes),
    /// The encode never ran or did not finish; parked slots were dropped (their lanes lag).
    Failed,
}

impl Default for FlightState {
    fn default() -> Self {
        FlightState::Encoding(Vec::new())
    }
}

impl Flight {
    fn lock(&self) -> MutexGuard<'_, FlightState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn failed(&self) -> bool {
        matches!(*self.lock(), FlightState::Failed)
    }

    /// Fills `slot` now if the snapshot exists, else parks it until the encode finishes.
    /// A failed flight drops the slot, which lags its lane for writer-driven recovery.
    pub fn join(&self, slot: SnapshotSlot) {
        let mut state = self.lock();
        match &mut *state {
            FlightState::Encoding(waiting) => waiting.push(slot),
            FlightState::Ready(frame) => {
                let frame = frame.clone();
                drop(state);
                slot.fill(frame);
            }
            FlightState::Failed => {
                drop(state);
                drop(slot);
            }
        }
    }

    fn ready(&self, frame: Bytes) -> Vec<SnapshotSlot> {
        match std::mem::replace(&mut *self.lock(), FlightState::Ready(frame)) {
            FlightState::Encoding(waiting) => waiting,
            _ => unreachable!("only the pending flight's lead can finish it"),
        }
    }

    /// Marks the flight failed and drops its parked slots.
    pub fn fail(&self) {
        let previous = std::mem::replace(&mut *self.lock(), FlightState::Failed);
        drop(previous);
    }
}

/// Owned by the encode job: a job that is dropped unrun (lane full) or unwinds fails its
/// flight, so no slot waits forever.
pub(super) struct Lead {
    flight: Option<Arc<Flight>>,
}

impl Lead {
    pub fn new(flight: Arc<Flight>) -> Self {
        Self { flight: Some(flight) }
    }

    /// Marks the flight complete, handing back the parked slots for delivery outside the locks.
    pub fn finish(mut self, frame: Bytes) -> (Arc<Flight>, Vec<SnapshotSlot>) {
        let flight = self.flight.take().expect("lead owns the flight");
        let waiting = flight.ready(frame);
        (flight, waiting)
    }
}

impl Drop for Lead {
    fn drop(&mut self) {
        if let Some(flight) = self.flight.take() {
            flight.fail();
        }
    }
}
