//! The staged update the launching binary registers with and calls at start-up. The entry points are fixed here; staging, the
//! download and the swap of the running executable are filled in by the update task (decision D6), and until then there is
//! never anything staged, so no start swaps and no install is started.

use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::PoisonError;

static LIVE_SESSIONS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// A live session of this process (`registerLiveSession`); it unregisters when dropped.
pub struct LiveSession {
    id: String,
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.id);
    }
}

/// `registerLiveSession`: a swap never replaces the executable under a session that runs.
pub fn register_live_session(id: &str) -> LiveSession {
    LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).insert(id.to_owned());
    LiveSession { id: id.to_owned() }
}

/// How many sessions of this process are registered.
pub fn live_sessions() -> usize {
    LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).len()
}

/// What `performPendingSwap` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapOutcome {
    /// No completed staged version is newer than the running one.
    NothingStaged,
    /// The staged version replaced the running executable: the caller starts it again and returns its exit code.
    Swapped,
}

/// `performPendingSwap`: at a clean start, a completed staged version that is newer replaces the running executable.
pub fn perform_pending_swap() -> SwapOutcome {
    SwapOutcome::NothingStaged
}

/// `spawnStagedInstall`: whether a background staging was started (never, until the update task stages).
pub fn spawn_staged_install() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_session_is_counted_until_it_is_dropped() {
        let before = live_sessions();
        let session = register_live_session("staged-update-test-session");
        assert_eq!(live_sessions(), before + 1);
        drop(session);
        assert_eq!(live_sessions(), before);
        assert_eq!(perform_pending_swap(), SwapOutcome::NothingStaged);
        assert!(!spawn_staged_install());
    }
}
