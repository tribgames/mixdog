//! Test-only count of the history rows a session's reads touch: index rows paged out of `history` and item frames read back
//! from the log. A test takes the count of one session id, so tests sharing a process do not see each other's reads.

use std::collections::HashMap;
use std::sync::Mutex;

static COUNTS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// `n` more rows of `session` were read.
pub fn add(session: &str, n: usize) {
    *COUNTS.lock().expect("count lock").get_or_insert_default().entry(session.to_owned()).or_default() += n as u64;
}

/// The rows of `session` read since the last call.
pub fn take(session: &str) -> u64 {
    COUNTS.lock().expect("count lock").get_or_insert_default().remove(session).unwrap_or(0)
}
