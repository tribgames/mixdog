//! Arrival order of one connection's requests whose params may need work before they can be queued (the expansion of blob
//! references reads blobs off the reader's turn, so a later request without one, or with a smaller one, finishes first).
//!
//! A request takes its place when the reader receives it, before any scheduler sees it ([`ArrivalOrder::reserve`]: arrival
//! order on one socket is send order), and keeps it while it waits in a lane and for its blobs. [`Ticket::release`] hands it to
//! the keyed queues only after every request that arrived before it has been released (queued, refused or failed); the hand-offs
//! run in ticket order under the order's lock, which is never held across an await. The wait holds this connection's order
//! alone: other connections' requests and the global queues are not behind it. A ticket is released exactly once on every exit:
//! `release` consumes it, and a ticket dropped unreleased (a request the lane refused or evicted, a task that never ran, a closed
//! connection's work) releases itself with nothing to run. Lanes have no active limit, so a queued earlier request always
//! starts; its own preparation ends when its blobs are read, are missing (refused at once) or its connection is cancelled.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

/// What a released request does: enqueue itself (or nothing, for one that was refused).
pub(crate) type Release = Box<dyn FnOnce() + Send>;

struct Slot {
    id: u64,
    release: Option<Release>,
}

#[derive(Default)]
struct Order {
    next: u64,
    waiting: VecDeque<Slot>,
}

#[derive(Default)]
pub(crate) struct ArrivalOrder {
    order: Mutex<Order>,
}

/// A place in a connection's arrival order, given up exactly once.
pub(crate) struct Ticket {
    order: Arc<ArrivalOrder>,
    id: u64,
    spent: bool,
}

impl ArrivalOrder {
    /// Takes the next place in arrival order.
    pub(crate) fn reserve(self: &Arc<Self>) -> Ticket {
        let mut order = self.order.lock().unwrap_or_else(|e| e.into_inner());
        let id = order.next;
        order.next += 1;
        order.waiting.push_back(Slot { id, release: None });
        Ticket { order: Arc::clone(self), id, spent: false }
    }

    /// The request of `id` is ready (or ended without work): it and every ready request behind it run, in arrival order, as
    /// far as the first one that is not ready. They run under the order's lock, so two releases cannot interleave their
    /// hand-offs; what runs only queues work or answers a refusal.
    fn ready(&self, id: u64, run: Release) {
        let mut order = self.order.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = order.waiting.iter_mut().find(|slot| slot.id == id) {
            slot.release = Some(run);
        }
        while order.waiting.front().is_some_and(|slot| slot.release.is_some()) {
            if let Some(Slot { release: Some(run), .. }) = order.waiting.pop_front() {
                run();
            }
        }
    }
}

impl ArrivalOrder {
    /// The places not yet handed on (test).
    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.order.lock().unwrap_or_else(|e| e.into_inner()).waiting.len()
    }
}

impl Ticket {
    /// Gives the place up: `run` goes when every earlier place has been given up.
    pub(crate) fn release(mut self, run: Release) {
        self.spent = true;
        self.order.ready(self.id, run);
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.spent {
            self.order.ready(self.id, Box::new(|| {}));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn pushed(log: &Arc<Mutex<Vec<&'static str>>>, name: &'static str) -> Release {
        let log = Arc::clone(log);
        Box::new(move || log.lock().unwrap().push(name))
    }

    #[test]
    fn a_later_place_that_is_ready_first_waits_for_the_earlier_one() {
        let log = Arc::default();
        let order = Arc::new(ArrivalOrder::default());
        let (first, second) = (order.reserve(), order.reserve());
        second.release(pushed(&log, "second"));
        assert!(log.lock().unwrap().is_empty());
        first.release(pushed(&log, "first"));
        assert_eq!(*log.lock().unwrap(), ["first", "second"]);
        assert_eq!(order.pending(), 0);
    }

    #[test]
    fn a_place_given_up_without_work_or_dropped_releases_the_ones_behind_it() {
        let log = Arc::default();
        let order = Arc::new(ArrivalOrder::default());
        let (first, second, third) = (order.reserve(), order.reserve(), order.reserve());
        third.release(pushed(&log, "third"));
        second.release(pushed(&log, "second"));
        drop(first); // a refused or evicted request never reaches `release`
        assert_eq!(*log.lock().unwrap(), ["second", "third"]);
    }

    #[test]
    fn one_connections_open_place_delays_no_other_connection() {
        let log = Arc::default();
        let (a, b) = (Arc::new(ArrivalOrder::default()), Arc::new(ArrivalOrder::default()));
        let _open = a.reserve();
        b.reserve().release(pushed(&log, "b"));
        assert_eq!(*log.lock().unwrap(), ["b"]);
    }
}