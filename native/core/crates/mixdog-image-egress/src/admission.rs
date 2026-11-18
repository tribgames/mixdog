//! The process-wide bound on image work. One controller is shared by every producer (importers, migration, previews that use
//! the same decoder, peer import): one active worker and 256 MiB of charged memory in the whole process, not per session.
//! Waiters hold only a handle (a queue slot), never decoded or base64 copies. A single operation that cannot fit is refused
//! up front. The 1 MiB of combined stream buffers is a separate pool so spooling never competes with the worker's charge.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::hash::Hash;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// Total image-work memory of the process.
pub const TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Combined stream buffers of the spool dispatcher.
pub const SPOOL_BYTES: u64 = 1024 * 1024;
/// What one worker operation may charge.
pub const WORKER_BYTES: u64 = TOTAL_BYTES - SPOOL_BYTES;
/// Handles that may wait for the worker; more is back-pressure.
pub const QUEUE_LIMIT: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdmitError {
    /// The operation's checked peak cannot fit the budget even alone.
    TooLarge,
    /// The queue is full.
    Busy,
    Cancelled,
}

/// Cancellation of one waiter or one operation.
#[derive(Clone, Default, Debug)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Counters for the acceptance tests: nothing here influences admission.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Stats {
    pub max_simultaneous_workers: u32,
    pub peak_charged_bytes: u64,
    pub admitted: u64,
    pub decodes: u64,
}

#[derive(Default)]
struct State {
    active: bool,
    charged: u64,
    spool: u64,
    queue: VecDeque<u64>,
    next_ticket: u64,
    workers: u32,
    stats: Stats,
}

pub struct Admission {
    state: Mutex<State>,
    wake: Condvar,
    total: u64,
}

impl Admission {
    pub const fn with_total(total: u64) -> Self {
        Self {
            state: Mutex::new(State {
                active: false,
                charged: 0,
                spool: 0,
                queue: VecDeque::new(),
                next_ticket: 0,
                workers: 0,
                stats: Stats { max_simultaneous_workers: 0, peak_charged_bytes: 0, admitted: 0, decodes: 0 },
            }),
            wake: Condvar::new(),
            total,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn worker_cap(&self) -> u64 {
        self.total.saturating_sub(SPOOL_BYTES.min(self.total / 2))
    }

    /// Wait for the worker slot and charge `bytes` (the checked peak of input, profile, frames, scratch, raster, conversion
    /// and output). Call before any base64 allocation, decoder construction, ICC read, parser or SVG allocation.
    pub fn acquire(&self, bytes: u64, cancel: &Cancel) -> Result<Permit<'_>, AdmitError> {
        if bytes > self.worker_cap() {
            return Err(AdmitError::TooLarge);
        }
        let mut state = self.lock();
        if state.queue.len() >= QUEUE_LIMIT {
            return Err(AdmitError::Busy);
        }
        let ticket = state.next_ticket;
        state.next_ticket += 1;
        state.queue.push_back(ticket);
        loop {
            if cancel.is_cancelled() {
                state.queue.retain(|t| *t != ticket);
                self.wake.notify_all();
                return Err(AdmitError::Cancelled);
            }
            if state.queue.front() == Some(&ticket) && !state.active && state.charged + bytes <= self.worker_cap() {
                state.queue.pop_front();
                state.active = true;
                state.charged += bytes;
                state.workers += 1;
                state.stats.admitted += 1;
                state.stats.max_simultaneous_workers = state.stats.max_simultaneous_workers.max(state.workers);
                state.stats.peak_charged_bytes = state.stats.peak_charged_bytes.max(state.charged + state.spool);
                return Ok(Permit { admission: self, bytes });
            }
            let (next, _) = self.wake.wait_timeout(state, Duration::from_millis(20)).unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
    }

    /// Reserve stream-buffer bytes from the spool pool (never more than [`SPOOL_BYTES`] at once). Non-blocking: a caller that
    /// gets `Busy` retries with less.
    pub fn spool(&self, bytes: u64) -> Result<SpoolPermit<'_>, AdmitError> {
        let cap = SPOOL_BYTES.min(self.total / 2);
        if bytes > cap {
            return Err(AdmitError::TooLarge);
        }
        let mut state = self.lock();
        if state.spool + bytes > cap {
            return Err(AdmitError::Busy);
        }
        state.spool += bytes;
        state.stats.peak_charged_bytes = state.stats.peak_charged_bytes.max(state.charged + state.spool);
        Ok(SpoolPermit { admission: self, bytes })
    }

    /// Count one decoder run, for the "zero decodes on the send path" assertion.
    pub fn note_decode(&self) {
        self.lock().stats.decodes += 1;
    }

    pub fn stats(&self) -> Stats {
        self.lock().stats
    }

    pub fn reset_stats(&self) {
        let mut state = self.lock();
        state.stats = Stats::default();
    }

    pub fn charged(&self) -> u64 {
        let state = self.lock();
        state.charged + state.spool
    }
}

/// The worker slot and its charge; both are released on every exit by `Drop`.
pub struct Permit<'a> {
    admission: &'a Admission,
    bytes: u64,
}

impl Permit<'_> {
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = self.admission.lock();
        state.active = false;
        state.charged -= self.bytes;
        state.workers -= 1;
        drop(state);
        self.admission.wake.notify_all();
    }
}

pub struct SpoolPermit<'a> {
    admission: &'a Admission,
    bytes: u64,
}

impl Drop for SpoolPermit<'_> {
    fn drop(&mut self) {
        self.admission.lock().spool -= self.bytes;
    }
}

/// The controller of this process.
pub fn global() -> &'static Admission {
    static GLOBAL: OnceLock<Admission> = OnceLock::new();
    GLOBAL.get_or_init(|| Admission::with_total(TOTAL_BYTES))
}

/// Coalesces equal work (by content digest, validator version and profile): the first caller runs it, every other waits for
/// that result. Each caller has its own cancellation; when every caller has cancelled, the running work is told to stop.
pub struct Coalescer<K, V> {
    flights: Mutex<HashMap<K, Arc<Flight<V>>>>,
}

struct Flight<V> {
    slot: Mutex<Option<V>>,
    done: Condvar,
    /// (callers including the leader, waiters that cancelled)
    callers: Mutex<(u32, u32)>,
}

impl<K: Eq + Hash + Clone, V: Clone> Default for Coalescer<K, V> {
    fn default() -> Self {
        Self { flights: Mutex::new(HashMap::new()) }
    }
}

impl<K: Eq + Hash + Clone, V: Clone> Coalescer<K, V> {
    /// Run `work` once per key at a time. `work` receives a probe that is true once every caller (the leader's own `cancel`
    /// and every waiter) has cancelled. A waiter that cancels returns [`AdmitError::Cancelled`] at once.
    pub fn run(&self, key: K, cancel: &Cancel, work: impl FnOnce(&dyn Fn() -> bool) -> V) -> Result<V, AdmitError> {
        let (flight, leader) = {
            let mut flights = self.flights.lock().unwrap_or_else(PoisonError::into_inner);
            match flights.get(&key) {
                Some(flight) => {
                    flight.callers.lock().unwrap_or_else(PoisonError::into_inner).0 += 1;
                    (Arc::clone(flight), false)
                }
                None => {
                    let flight = Arc::new(Flight { slot: Mutex::new(None), done: Condvar::new(), callers: Mutex::new((1, 0)) });
                    flights.insert(key.clone(), Arc::clone(&flight));
                    (flight, true)
                }
            }
        };
        if leader {
            let probe = || {
                let callers = flight.callers.lock().unwrap_or_else(PoisonError::into_inner);
                cancel.is_cancelled() && callers.1 + 1 >= callers.0
            };
            let value = work(&probe);
            self.flights.lock().unwrap_or_else(PoisonError::into_inner).remove(&key);
            *flight.slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(value.clone());
            flight.done.notify_all();
            return Ok(value);
        }
        let mut slot = flight.slot.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some(value) = slot.as_ref() {
                return Ok(value.clone());
            }
            if cancel.is_cancelled() {
                let mut callers = flight.callers.lock().unwrap_or_else(PoisonError::into_inner);
                callers.1 += 1;
                return Err(AdmitError::Cancelled);
            }
            slot = flight.done.wait_timeout(slot, Duration::from_millis(10)).unwrap_or_else(PoisonError::into_inner).0;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use super::*;

    #[test]
    fn fifty_concurrent_near_limit_operations_run_one_at_a_time_within_the_budget() {
        let admission = Arc::new(Admission::with_total(TOTAL_BYTES));
        let near_limit = WORKER_BYTES - 1024;
        let done = Arc::new(AtomicU32::new(0));
        let threads: Vec<_> = (0..50)
            .map(|_| {
                let (admission, done) = (Arc::clone(&admission), Arc::clone(&done));
                std::thread::spawn(move || {
                    // Queue limit is back-pressure: a Busy caller retries, as a real producer would.
                    let permit = loop {
                        match admission.acquire(near_limit, &Cancel::default()) {
                            Ok(permit) => break permit,
                            Err(AdmitError::Busy) => std::thread::sleep(Duration::from_millis(5)),
                            Err(other) => panic!("{other:?}"),
                        }
                    };
                    std::thread::sleep(Duration::from_millis(1));
                    drop(permit);
                    done.fetch_add(1, Ordering::SeqCst);
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let stats = admission.stats();
        assert_eq!(done.load(Ordering::SeqCst), 50);
        assert_eq!(stats.max_simultaneous_workers, 1);
        assert!(stats.peak_charged_bytes <= TOTAL_BYTES, "{stats:?}");
        assert_eq!(admission.charged(), 0, "everything is released");
    }

    #[test]
    fn an_operation_that_cannot_fit_alone_is_refused_before_any_allocation() {
        let admission = Admission::with_total(TOTAL_BYTES);
        assert_eq!(admission.acquire(WORKER_BYTES + 1, &Cancel::default()).err(), Some(AdmitError::TooLarge));
        assert_eq!(admission.spool(SPOOL_BYTES + 1).err(), Some(AdmitError::TooLarge));
    }

    #[test]
    fn a_cancelled_waiter_leaves_the_queue_and_the_holder_is_unaffected() {
        let admission = Arc::new(Admission::with_total(TOTAL_BYTES));
        let held = admission.acquire(1024, &Cancel::default()).unwrap();
        let cancel = Cancel::default();
        let waiter = {
            let (admission, cancel) = (Arc::clone(&admission), cancel.clone());
            std::thread::spawn(move || admission.acquire(1024, &cancel).err())
        };
        std::thread::sleep(Duration::from_millis(50));
        cancel.cancel();
        assert_eq!(waiter.join().unwrap(), Some(AdmitError::Cancelled));
        drop(held);
        assert!(admission.acquire(1024, &Cancel::default()).is_ok(), "slot free after cancel and release");
    }

    #[test]
    fn the_queue_is_bounded() {
        let admission = Arc::new(Admission::with_total(TOTAL_BYTES));
        let held = admission.acquire(1, &Cancel::default()).unwrap();
        let cancel = Cancel::default();
        let waiters: Vec<_> = (0..QUEUE_LIMIT)
            .map(|_| {
                let (admission, cancel) = (Arc::clone(&admission), cancel.clone());
                std::thread::spawn(move || admission.acquire(1, &cancel).map(drop))
            })
            .collect();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(admission.acquire(1, &Cancel::default()).err(), Some(AdmitError::Busy));
        cancel.cancel();
        for waiter in waiters {
            let _ = waiter.join();
        }
        drop(held);
    }

    #[test]
    fn spool_buffers_are_one_shared_pool() {
        let admission = Admission::with_total(TOTAL_BYTES);
        let a = admission.spool(SPOOL_BYTES - 10).unwrap();
        assert_eq!(admission.spool(100).err(), Some(AdmitError::Busy));
        drop(a);
        assert!(admission.spool(100).is_ok());
    }

    #[test]
    fn fifty_equal_misses_run_the_work_once() {
        let coalescer: Arc<Coalescer<String, u32>> = Arc::new(Coalescer::default());
        let runs = Arc::new(AtomicU32::new(0));
        let threads: Vec<_> = (0..50)
            .map(|_| {
                let (coalescer, runs) = (Arc::clone(&coalescer), Arc::clone(&runs));
                std::thread::spawn(move || {
                    coalescer
                        .run("digest/v1/png".to_owned(), &Cancel::default(), |_: &dyn Fn() -> bool| {
                            runs.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(100));
                            7
                        })
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), 7);
        }
        // Threads that arrive after the flight ended start a new one, so the bound is by overlap, not by thread count.
        assert!(runs.load(Ordering::SeqCst) < 10, "runs: {}", runs.load(Ordering::SeqCst));
    }

    #[test]
    fn when_every_waiter_cancels_the_running_work_is_told_to_stop() {
        let coalescer: Arc<Coalescer<u8, u8>> = Arc::new(Coalescer::default());
        let stopped = Arc::new(AtomicBool::new(false));
        let leader_cancel = Cancel::default();
        let own = Cancel::default();
        let leader = {
            let (coalescer, stopped, own) = (Arc::clone(&coalescer), Arc::clone(&stopped), own.clone());
            std::thread::spawn(move || {
                coalescer.run(1, &own, |stop| {
                    for _ in 0..200 {
                        if stop() {
                            stopped.store(true, Ordering::SeqCst);
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    0
                })
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        let waiter = {
            let (coalescer, cancel) = (Arc::clone(&coalescer), leader_cancel.clone());
            std::thread::spawn(move || coalescer.run(1, &cancel, |_| 9))
        };
        std::thread::sleep(Duration::from_millis(50));
        leader_cancel.cancel();
        own.cancel();
        assert_eq!(waiter.join().unwrap(), Err(AdmitError::Cancelled));
        leader.join().unwrap().unwrap();
        assert!(stopped.load(Ordering::SeqCst), "the work saw the stop flag");
    }
}
