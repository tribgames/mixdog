//! Mixy's hidden heartbeat sessions (`mixy-heartbeat.mjs` `wakeMixy`), marked in this process from
//! the session's creation until its close lands (`shared/routine-trigger.mjs`
//! `markHeartbeatSession` / `isHeartbeatSession`). Only the mark counts: the stored fields
//! (source, owner) can be supplied by any session create, so a turn's heartbeat limits and the
//! delegation refusals key on this set and nothing else.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

pub struct HeartbeatSessions {
    marked: Mutex<HashSet<String>>,
}

impl HeartbeatSessions {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { marked: Mutex::new(HashSet::new()) })
    }

    /// `markHeartbeatSession(id)`: an empty id marks nothing.
    pub fn mark(&self, session_id: &str) {
        if !session_id.is_empty() {
            self.marked.lock().unwrap_or_else(PoisonError::into_inner).insert(session_id.to_owned());
        }
    }

    /// `markHeartbeatSession(id, true)`: ending an unmarked session is harmless.
    pub fn unmark(&self, session_id: &str) {
        self.marked.lock().unwrap_or_else(PoisonError::into_inner).remove(session_id);
    }

    /// `isHeartbeatSession(id)`: the id matches exactly (no trimming).
    pub fn is_marked(&self, session_id: &str) -> bool {
        self.marked.lock().unwrap_or_else(PoisonError::into_inner).contains(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `routine-trigger.test.mjs`: "only the in-process mark makes a heartbeat session".
    #[test]
    fn only_the_mark_makes_a_heartbeat_session_set_ended_and_blank_ignored() {
        let sessions = HeartbeatSessions::new();
        let id = "sess_daemon_mark_test";
        assert!(!sessions.is_marked(id));
        sessions.mark(id);
        assert!(sessions.is_marked(id));
        assert!(!sessions.is_marked(&format!("{id} ")), "the id matches exactly");
        assert!(!sessions.is_marked("sess_daemon_other"));
        sessions.unmark(id);
        assert!(!sessions.is_marked(id));
        sessions.unmark(id);
        sessions.mark("");
        assert!(!sessions.is_marked(""), "a blank id is never a heartbeat session");
    }
}
