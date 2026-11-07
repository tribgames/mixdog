//! The turn gate (`session-service/session-calls/turn-gate.mjs`): the turn starts of a thread
//! against the desktop's idle-only delete. A start is admitted for as long as its intake runs;
//! the delete closes the thread to starts only while none is being admitted, and a start
//! refuses while it is closed.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_core_api::ids::ThreadId;

#[derive(Default)]
struct Gate {
    /// Admissions in flight per thread.
    starting: HashMap<ThreadId, usize>,
    fenced: HashSet<ThreadId>,
}

#[derive(Default)]
pub(crate) struct TurnGate {
    state: Mutex<Gate>,
}

fn lock(gate: &Mutex<Gate>) -> MutexGuard<'_, Gate> {
    gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A turn start of `thread` being admitted; dropping it ends the admission (`enter`'s release).
pub(crate) struct Admission {
    gate: Arc<TurnGate>,
    thread: ThreadId,
}

/// `thread` closed to turn starts; dropping it reopens it (`fence`'s reopen).
pub(crate) struct Fence {
    gate: Arc<TurnGate>,
    thread: ThreadId,
}

impl TurnGate {
    /// Admits a turn start of `thread`; `None` while it is closed to starts (`SessionClosedError`,
    /// "session is being deleted").
    pub(crate) fn enter(self: &Arc<Self>, thread: &ThreadId) -> Option<Admission> {
        let mut state = lock(&self.state);
        if state.fenced.contains(thread) {
            return None;
        }
        *state.starting.entry(thread.clone()).or_default() += 1;
        Some(Admission { gate: self.clone(), thread: thread.clone() })
    }

    /// Closes `thread` to turn starts; `None` while one is being admitted or it is already closed.
    pub(crate) fn fence(self: &Arc<Self>, thread: &ThreadId) -> Option<Fence> {
        let mut state = lock(&self.state);
        if state.starting.contains_key(thread) || !state.fenced.insert(thread.clone()) {
            return None;
        }
        Some(Fence { gate: self.clone(), thread: thread.clone() })
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut state = lock(&self.gate.state);
        if let Some(count) = state.starting.get_mut(&self.thread) {
            *count -= 1;
            if *count == 0 {
                state.starting.remove(&self.thread);
            }
        }
    }
}

impl Drop for Fence {
    fn drop(&mut self) {
        lock(&self.gate.state).fenced.remove(&self.thread);
    }
}
