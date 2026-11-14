//! The pending-command budget (`host/command-budget.ts`): a command is admitted before anything of it is queued, and one that
//! finds the desktop's 32 pending commands, or its session's 4, taken is refused with nothing sent.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::computer::ComputerError;

/// `createComputerCommandBudget`'s defaults.
const MAXIMUM: usize = 32;
const PER_SESSION: usize = 4;
/// The helper requests in flight across a pool (`requests.inFlight() >= 32`, `worker-pool.ts:270`).
const MAX_IN_FLIGHT: usize = 32;
/// The cap on live helper processes (`MAX_COMPUTER_WORKERS`, `worker-capacity.ts:6`). The Node host also keeps its elevated
/// one-shot launcher slots under this cap (`elevated.slots()`); the Rust helper starts its elevated run itself, so the core
/// holds no such slots to count.
pub const MAX_LIVE_HELPERS: usize = 8;

#[derive(Default)]
struct Counts {
    pending: usize,
    sessions: HashMap<String, usize>,
}

/// The commands pending across every session of one pool, and in each.
#[derive(Default)]
pub struct CommandBudget(Mutex<Counts>);

/// One admitted command; its slot returns when it is dropped, whichever way the command ends.
pub struct CommandSlot {
    budget: Arc<CommandBudget>,
    session: String,
}

impl CommandBudget {
    fn counts(&self) -> std::sync::MutexGuard<'_, Counts> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `acquire`: refused when the desktop or the session has no slot left.
    pub fn acquire(self: &Arc<Self>, session: &str) -> Result<CommandSlot, ComputerError> {
        let mut counts = self.counts();
        let taken = counts.sessions.get(session).copied().unwrap_or(0);
        if counts.pending >= MAXIMUM || taken >= PER_SESSION {
            return Err(ComputerError::Failed {
                code: "computer_capacity_exhausted".into(),
                message: "computer_capacity_exhausted: pending command limit reached; no input was queued".into(),
            });
        }
        counts.pending += 1;
        counts.sessions.insert(session.to_owned(), taken + 1);
        Ok(CommandSlot { budget: self.clone(), session: session.to_owned() })
    }

    /// How many commands `session` has pending now.
    pub fn pending_of(&self, session: &str) -> usize {
        self.counts().sessions.get(session).copied().unwrap_or(0)
    }

    /// Whether `session` has a command pending now.
    pub fn is_pending(&self, session: &str) -> bool {
        self.counts().sessions.contains_key(session)
    }
}

impl Drop for CommandSlot {
    fn drop(&mut self) {
        let mut counts = self.budget.counts();
        counts.pending = counts.pending.saturating_sub(1);
        match counts.sessions.get(&self.session).copied().unwrap_or(1) {
            0 | 1 => {
                counts.sessions.remove(&self.session);
            }
            left => {
                counts.sessions.insert(self.session.clone(), left - 1);
            }
        }
    }
}

/// The refusal of a new helper when `MAX_LIVE_HELPERS` processes are live (`assertComputerWorkerCapacity`).
pub fn workers_live() -> ComputerError {
    ComputerError::Failed {
        code: "computer_capacity_exhausted".into(),
        message: format!("computer_capacity_exhausted: {MAX_LIVE_HELPERS} workers are still live; release an idle session before retrying"),
    }
}

/// The helper processes alive across a pool: resident helpers and the `--abort-cleanup` runs still ending one, counted by
/// process and not by session (`residents.liveCount()`).
#[derive(Default)]
pub struct LiveProcesses(AtomicUsize);

/// One live process; it stops counting when this is dropped.
pub struct LiveProcess(Arc<LiveProcesses>);

impl LiveProcesses {
    pub fn hold(self: &Arc<Self>) -> LiveProcess {
        self.0.fetch_add(1, Ordering::SeqCst);
        LiveProcess(self.clone())
    }

    pub fn count(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }

    /// `assertComputerWorkerCapacity(live)`: refused while `MAX_LIVE_HELPERS` processes are live.
    pub fn assert_room(&self) -> Result<(), ComputerError> {
        if self.count() >= MAX_LIVE_HELPERS { Err(workers_live()) } else { Ok(()) }
    }
}

impl Drop for LiveProcess {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The helper requests in flight across a pool's sessions, from dispatch to the reply (or the helper's end).
#[derive(Default)]
pub struct InFlight(AtomicUsize);

/// One request in flight; it returns when dropped.
pub struct InFlightSlot(Arc<InFlight>);

impl InFlight {
    /// Refused at `MAX_IN_FLIGHT`, before anything is written to a helper.
    pub fn begin(self: &Arc<Self>) -> Result<InFlightSlot, ComputerError> {
        if self.0.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            self.0.fetch_sub(1, Ordering::SeqCst);
            return Err(ComputerError::Failed {
                code: "computer_capacity_exhausted".into(),
                message: "computer_capacity_exhausted: worker request budget exceeded; input was not dispatched".into(),
            });
        }
        Ok(InFlightSlot(self.clone()))
    }
}

impl Drop for InFlightSlot {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A running count of the cleanups a backend has going (`cleanupJobs.has(sessionId)`).
pub struct Tally(Arc<AtomicUsize>);

impl Tally {
    pub fn up(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count.clone())
    }
}

impl Drop for Tally {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(result: Result<CommandSlot, ComputerError>) -> String {
        match result {
            Err(ComputerError::Failed { code, message }) => {
                assert_eq!(code, "computer_capacity_exhausted");
                message
            }
            other => panic!("expected a refusal, got {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn a_session_holds_four_and_the_desktop_thirty_two() {
        let budget = Arc::new(CommandBudget::default());
        let held: Vec<_> = (0..PER_SESSION).map(|_| budget.acquire("a").unwrap()).collect();
        assert_eq!(
            refused(budget.acquire("a")),
            "computer_capacity_exhausted: pending command limit reached; no input was queued"
        );
        let others: Vec<_> = (0..MAXIMUM - PER_SESSION).map(|n| budget.acquire(&format!("s{}", n / PER_SESSION)).unwrap()).collect();
        refused(budget.acquire("late"));
        drop(held);
        assert!(!budget.is_pending("a"));
        budget.acquire("late").expect("a returned slot is free again");
        drop(others);
    }

    #[test]
    fn the_live_processes_are_counted_by_process_and_the_requests_in_flight_are_capped() {
        let live = Arc::new(LiveProcesses::default());
        let held: Vec<_> = (0..MAX_LIVE_HELPERS).map(|_| live.hold()).collect();
        assert!(matches!(live.assert_room(), Err(ComputerError::Failed { ref message, .. })
            if message == "computer_capacity_exhausted: 8 workers are still live; release an idle session before retrying"));
        drop(held);
        assert_eq!(live.count(), 0);
        live.assert_room().expect("room again");
        let flight = Arc::new(InFlight::default());
        let slots: Vec<_> = (0..MAX_IN_FLIGHT).map(|_| flight.begin().unwrap()).collect();
        assert!(matches!(flight.begin(), Err(ComputerError::Failed { ref message, .. })
            if message == "computer_capacity_exhausted: worker request budget exceeded; input was not dispatched"));
        drop(slots);
        flight.begin().expect("a returned slot is free");
    }

    #[test]
    fn a_dropped_slot_returns_once() {
        let budget = Arc::new(CommandBudget::default());
        let first = budget.acquire("a").unwrap();
        let second = budget.acquire("a").unwrap();
        drop(first);
        assert!(budget.is_pending("a"));
        drop(second);
        assert!(!budget.is_pending("a"));
    }
}
