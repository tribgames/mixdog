//! The box-wide ingress pool: the reservations legs hold, the FIFO of legs parked for one, and the counters
//! (`ingressReservedBytes`, `ingressPeakBytes`, `ingressDeferrals`, `ingressWaiting` of `lib/relay-transport.mjs`).
//!
//! Everything the pool owns sits behind ONE `std` mutex and no section of it awaits, which is the relay-wide lock discipline:
//! the decision of one leg and the wake-up of the next are taken in the same section, so two legs can never both take the last
//! room. A leg's own flags that the sweep reads (`holding`, `waiting`, progress) are atomics written inside that section.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};

use mixdog_rt::time::Instant;

use super::super::policy::{INGRESS_FREE_WINDOW_BYTES, INGRESS_RESERVATION_BYTES, MAX_INGRESS_BYTES};
use super::{LegShared, lock};
use crate::ws::Holder;

/// The ingress decision for ONE leg, taken while its message is still arriving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    /// Keep reading: the message is inside the free window, or the leg already holds its reservation.
    Read,
    /// Charge this leg's worst case to the box pool.
    Reserve,
    /// Park the leg until the pool has room for it.
    Wait,
}

/// The inputs of [`admit_ingress`], with `admitIngress`'s defaults.
#[derive(Debug, Clone, Copy)]
pub struct AdmitQuery {
    pub pending: usize,
    pub holding: bool,
    pub window: usize,
    pub reservation: usize,
    pub reserved: usize,
    pub ceiling: usize,
}

impl Default for AdmitQuery {
    fn default() -> Self {
        Self {
            pending: 0,
            holding: false,
            window: INGRESS_FREE_WINDOW_BYTES,
            reservation: INGRESS_RESERVATION_BYTES,
            reserved: 0,
            ceiling: MAX_INGRESS_BYTES,
        }
    }
}

/// `admitIngress`. A leg that already holds its reservation reads to the end regardless: that is what keeps the pool free of
/// half-received frames waiting on each other.
pub fn admit_ingress(query: &AdmitQuery) -> Admit {
    if query.holding || query.pending <= query.window {
        Admit::Read
    } else if query.reserved.saturating_add(query.reservation) > query.ceiling {
        Admit::Wait
    } else {
        Admit::Reserve
    }
}

/// The counters of the pool (`relayIngressStats`).
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngressStats {
    pub reserved: usize,
    pub peak: usize,
    pub waiting: usize,
    pub deferrals: usize,
}

#[derive(Default)]
pub(super) struct PoolState {
    pub(super) reserved: usize,
    pub(super) peak: usize,
    pub(super) deferrals: usize,
    /// FIFO: the leg that has waited longest takes the next reservation, so a busy box cannot starve one conversation.
    pub(super) waiting: VecDeque<Arc<LegShared>>,
}

impl PoolState {
    pub(super) fn take_reservation(&mut self, leg: &LegShared, now_ms: u64) {
        if leg.holding.load(Ordering::SeqCst) {
            return;
        }
        leg.holding.store(true, Ordering::SeqCst);
        leg.progress_ms.store(now_ms, Ordering::SeqCst);
        self.reserved = self.reserved.saturating_add(leg.limits.reservation);
        self.peak = self.peak.max(self.reserved);
    }

    pub(super) fn park(&mut self, leg: &Arc<LegShared>, now_ms: u64) {
        if leg.waiting.load(Ordering::SeqCst) {
            return;
        }
        leg.waiting.store(true, Ordering::SeqCst);
        leg.waiting_since_ms.store(now_ms, Ordering::SeqCst);
        self.deferrals += 1;
        self.waiting.push_back(Arc::clone(leg));
        leg.gate.hold(Holder::Ingress);
    }

    /// Give the pool back and wake whoever has waited longest for it.
    pub(super) fn release_reservation(&mut self, leg: &LegShared, now_ms: u64) {
        if !leg.holding.load(Ordering::SeqCst) {
            return;
        }
        leg.holding.store(false, Ordering::SeqCst);
        self.reserved = self.reserved.saturating_sub(leg.limits.reservation);
        self.pump(now_ms);
    }

    fn pump(&mut self, now_ms: u64) {
        while let Some(leg) = self.waiting.front().map(Arc::clone) {
            if !leg.waiting.load(Ordering::SeqCst) || !leg.is_open() {
                self.waiting.pop_front();
                leg.waiting.store(false, Ordering::SeqCst);
                continue;
            }
            if self.reserved.saturating_add(leg.limits.reservation) > leg.limits.ceiling {
                return;
            }
            self.waiting.pop_front();
            leg.waiting.store(false, Ordering::SeqCst);
            self.take_reservation(&leg, now_ms);
            leg.gate.release(Holder::Ingress);
        }
    }

    pub(super) fn remove_waiting(&mut self, leg: &Arc<LegShared>) {
        self.waiting.retain(|queued| !Arc::ptr_eq(queued, leg));
    }
}

struct PoolInner {
    epoch: Instant,
    state: Mutex<PoolState>,
}

/// The pool every leg of a relay shares: one per process (the server creates it and hands a clone to each leg).
#[derive(Clone)]
pub struct IngressPool {
    inner: Arc<PoolInner>,
}

impl Default for IngressPool {
    fn default() -> Self {
        Self::new()
    }
}

impl IngressPool {
    pub fn new() -> Self {
        Self { inner: Arc::new(PoolInner { epoch: Instant::now(), state: Mutex::new(PoolState::default()) }) }
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, PoolState> {
        lock(&self.inner.state)
    }

    /// Milliseconds from the pool's creation to `at`: the clock the legs' progress is kept in.
    pub(super) fn ms_at(&self, at: Instant) -> u64 {
        u64::try_from(at.saturating_duration_since(self.inner.epoch).as_millis()).unwrap_or(u64::MAX)
    }

    pub(super) fn now_ms(&self) -> u64 {
        self.ms_at(Instant::now())
    }

    /// `relayIngressStats`.
    #[cfg(any(test, feature = "test-support"))]
    pub fn stats(&self) -> IngressStats {
        let state = self.lock();
        IngressStats { reserved: state.reserved, peak: state.peak, waiting: state.waiting.len(), deferrals: state.deferrals }
    }

    /// `resetRelayIngressStats`: the peak starts again from what is reserved now, and the deferrals from zero.
    #[cfg(any(test, feature = "test-support"))]
    pub fn reset_stats(&self) {
        let mut state = self.lock();
        state.peak = state.reserved;
        state.deferrals = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_reads_inside_the_window_reserves_while_there_is_room_and_waits_without() {
        let base = AdmitQuery::default();
        assert_eq!(admit_ingress(&AdmitQuery { pending: 1024, ..base }), Admit::Read);
        assert_eq!(admit_ingress(&AdmitQuery { pending: 512 * 1024, ..base }), Admit::Reserve);
        assert_eq!(
            admit_ingress(&AdmitQuery { pending: 512 * 1024, reserved: MAX_INGRESS_BYTES - INGRESS_RESERVATION_BYTES, ..base }),
            Admit::Reserve
        );
        assert_eq!(admit_ingress(&AdmitQuery { pending: 512 * 1024, reserved: MAX_INGRESS_BYTES, ..base }), Admit::Wait);
        // A leg that holds its reservation reads to the end.
        assert_eq!(
            admit_ingress(&AdmitQuery { pending: 64 * 1024 * 1024, holding: true, reserved: MAX_INGRESS_BYTES, ..base }),
            Admit::Read
        );
        // The window itself is free.
        assert_eq!(admit_ingress(&AdmitQuery { pending: INGRESS_FREE_WINDOW_BYTES, ..base }), Admit::Read);
        assert_eq!(admit_ingress(&AdmitQuery { pending: INGRESS_FREE_WINDOW_BYTES + 1, ..base }), Admit::Reserve);
    }
}
