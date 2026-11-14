//! Single-flight snapshot encodes (P §6.4, RL §7.3, SPEC §4.2).
//!
//! A feed has one epoch, so its cache key `(feed, epoch, S, window)` reduces to `(S, window)`.
//! Every attach that needs the snapshot at `S` for `window` joins one [`Flight`]: the first
//! submits the encode to cpu-interactive, the others park their slots on it, and a flight
//! that already finished fills a slot at once. N subscribers therefore cost one encode.
//!
//! The cache holds flights of the current seq only; a publish drops them (P §6.5 "Snapshot
//! cache"). An in-flight encode keeps its flight alive through the job, and an encoded
//! snapshot stays alive only while lanes hold its bytes.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use bytes::Bytes;
use mixdog_core_api::feed::Window;
use mixdog_core_api::sink::SnapshotSlot;

/// The flights of one seq, under the feed lock.
#[derive(Default)]
pub(super) struct SnapshotCache {
    seq: u64,
    flights: HashMap<Window, Arc<Flight>>,
}

impl SnapshotCache {
    /// The flight for the snapshot at `seq` for `window`, and whether the caller leads it
    /// (must submit its encode). A failed flight is replaced, so a later attach retries.
    pub fn flight(&mut self, seq: u64, window: &Window) -> (Arc<Flight>, bool) {
        if self.seq != seq {
            self.flights.clear();
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

    /// Drops every flight: called when the seq advances, a view is swapped with no frame, or the feed closes.
    pub fn clear(&mut self) {
        if !self.flights.is_empty() {
            self.flights.clear();
        }
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
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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

    /// Stores the encoded snapshot and fills every parked slot (outside the flight lock).
    pub fn finish(&self, frame: Bytes) {
        let previous = std::mem::replace(&mut *self.lock(), FlightState::Ready(frame.clone()));
        if let FlightState::Encoding(waiting) = previous {
            for slot in waiting {
                slot.fill(frame.clone());
            }
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
        Self {
            flight: Some(flight),
        }
    }

    pub fn finish(mut self, frame: Bytes) {
        if let Some(flight) = self.flight.take() {
            flight.finish(frame);
        }
    }
}

impl Drop for Lead {
    fn drop(&mut self) {
        if let Some(flight) = self.flight.take() {
            flight.fail();
        }
    }
}
