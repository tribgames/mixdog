//! Which state a session's log is in, counted by the operations that change it.
//!
//! A reader that keeps something it folded from a log (the session store's row reads keep the lineage of an idle thread)
//! has to know the log is still the one it read. The files do not say: a truncation followed by frames of the same length,
//! or a rewrite that replaces the files under their names, leaves the listing, the lengths and the write times as they
//! were. So the operations say it. Every function of this workspace that changes what a session folder holds (a writer's
//! open, which truncates a torn tail; an append with its rollback; a pending rollback run later; the folder's creation;
//! a rewrite's swap and its undo; a damage repair; a purge; a migration's publication and withdrawal) holds a [`Writing`]
//! for as long as it may touch the folder. [`settled`] answers the version of a session nothing is writing: two equal
//! answers mean no such operation began between them, so the bytes are the same.
//!
//! The count is by session id and for the process: one process owns a data dir (`daemon-owner.lock`), and a test process
//! with several data dirs only sees a version move more often than it had to. An entry is never removed, so a folder
//! removed and created again does not start over at a version a reader may still hold.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;

#[derive(Default)]
struct State {
    version: u64,
    writing: u32,
}

type Shared = Arc<Mutex<State>>;

fn of(session: &str) -> Shared {
    static ALL: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();
    let mut all = ALL.get_or_init(Mutex::default).lock().unwrap_or_else(PoisonError::into_inner);
    match all.get(session) {
        Some(state) => state.clone(),
        None => all.entry(session.to_owned()).or_default().clone(),
    }
}

/// An operation that may change a session's log, from before its first write to after its last (a rollback included).
#[must_use = "the operation is over when this is dropped"]
pub struct Writing(Shared);

/// Begins an operation on `session`'s log. The version moves here, before anything is written: what a reader folded
/// from the log before this is not what it holds after, whether or not the operation succeeds.
pub fn writing(session: &str) -> Writing {
    let state = of(session);
    {
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        state.version += 1;
        state.writing += 1;
    }
    Writing(state)
}

/// [`writing`] for the session whose folder is `dir` (`<data>/sessions/<id>`).
pub fn writing_dir(dir: &Path) -> Writing {
    writing(&dir.file_name().unwrap_or_default().to_string_lossy())
}

impl Drop for Writing {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).writing -= 1;
    }
}

/// The version of `session`'s log, or `None` while an operation on it runs (what is read then may be between two states).
pub fn settled(session: &str) -> Option<u64> {
    let state = of(session);
    let state = state.lock().unwrap_or_else(PoisonError::into_inner);
    (state.writing == 0).then_some(state.version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A version read while nothing writes is the same until an operation begins; while one runs there is none, nested
    /// operations included; after it the version is another one, and a session written is not another session's.
    #[test]
    fn a_version_holds_until_an_operation_begins() {
        let (session, other) = ("log-epoch-test-a", "log-epoch-test-b");
        let first = settled(session).expect("nothing writes");
        assert_eq!(settled(session), Some(first));
        let apart = settled(other).expect("nothing writes");
        let outer = writing(session);
        assert_eq!(settled(session), None);
        let inner = writing_dir(Path::new("data/sessions").join(session).as_path());
        drop(outer);
        assert_eq!(settled(session), None, "the inner operation still runs");
        drop(inner);
        let after = settled(session).expect("nothing writes");
        assert!(after > first);
        assert_eq!(settled(other), Some(apart));
    }
}
