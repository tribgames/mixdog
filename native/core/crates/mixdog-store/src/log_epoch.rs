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
//! A reader that keeps only the shape of a session's history (its lineage, its cut of the base and its history revision,
//! and that the session is not deleted) holds the same thing after an append of records that change none of these, which
//! is nearly every append. Those appends are an [`appending`] operation: they move the version and not the shape's, which
//! [`shape_settled`] answers.
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
    /// The version of the history's shape, and the operations running that may change it.
    shape: u64,
    reshaping: u32,
    /// Told each time the last such operation ends ([`shape_past`]).
    reshaped: Arc<tokio::sync::Notify>,
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
pub struct Writing {
    state: Shared,
    reshapes: bool,
}

/// Begins an operation on `session`'s log that may change anything in it, the shape of its history included. The
/// versions move here, before anything is written: what a reader folded from the log before this is not what it holds
/// after, whether or not the operation succeeds.
pub fn writing(session: &str) -> Writing {
    let mut writing = appending(session);
    writing.reshape();
    writing
}

/// [`writing`] for the session whose folder is `dir` (`<data>/sessions/<id>`).
pub fn writing_dir(dir: &Path) -> Writing {
    writing(&dir.file_name().unwrap_or_default().to_string_lossy())
}

/// Begins an append to the log of the session whose folder is `dir`. The version moves; the shape's moves only once the
/// append is known to change it ([`Writing::reshape`]).
pub fn appending_dir(dir: &Path) -> Writing {
    appending(&dir.file_name().unwrap_or_default().to_string_lossy())
}

fn appending(session: &str) -> Writing {
    let state = of(session);
    {
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        state.version += 1;
        state.writing += 1;
    }
    Writing { state, reshapes: false }
}

impl Writing {
    /// The operation may change the shape of the session's history. Called before it writes.
    pub fn reshape(&mut self) {
        if self.reshapes {
            return;
        }
        self.reshapes = true;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.shape += 1;
        state.reshaping += 1;
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.writing -= 1;
        state.reshaping -= u32::from(self.reshapes);
        if self.reshapes && state.reshaping == 0 {
            state.reshaped.notify_waiters();
        }
    }
}

/// Resolves once no operation that may change the shape of `session`'s history runs and the shape's version is not
/// `seen`: with `None`, once the log is at rest; with the version a reader took, once an operation that may have changed
/// what it read has ended, whether it succeeded or rolled back. What a reader folds while such an operation runs may be
/// frames that are never acknowledged (written and not yet synced, then cut): it reads again after this.
pub async fn shape_past(session: &str, seen: Option<u64>) {
    let state = of(session);
    let reshaped = state.lock().unwrap_or_else(PoisonError::into_inner).reshaped.clone();
    loop {
        let told = reshaped.notified();
        tokio::pin!(told);
        told.as_mut().enable();
        {
            let state = state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.reshaping == 0 && Some(state.shape) != seen {
                return;
            }
        }
        told.await;
    }
}

/// The version of `session`'s log, or `None` while an operation on it runs (what is read then may be between two states).
pub fn settled(session: &str) -> Option<u64> {
    let state = of(session);
    let state = state.lock().unwrap_or_else(PoisonError::into_inner);
    (state.writing == 0).then_some(state.version)
}

/// The version of the shape of `session`'s history, or `None` while an operation that may change it runs.
pub fn shape_settled(session: &str) -> Option<u64> {
    let state = of(session);
    let state = state.lock().unwrap_or_else(PoisonError::into_inner);
    (state.reshaping == 0).then_some(state.shape)
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

    /// An append moves the version and leaves the shape's version settled where it was, until the append is found to
    /// change the shape: from then to its end there is none, and after it another one.
    #[test]
    fn an_append_moves_the_shape_only_once_it_reshapes() {
        let dir = Path::new("data/sessions/log-epoch-test-shape");
        let session = "log-epoch-test-shape";
        let (version, shape) = (settled(session).expect("nothing writes"), shape_settled(session).expect("nothing writes"));
        let append = appending_dir(dir);
        assert_eq!((settled(session), shape_settled(session)), (None, Some(shape)));
        drop(append);
        assert!(settled(session).expect("nothing writes") > version);
        assert_eq!(shape_settled(session), Some(shape));
        let mut rewind = appending_dir(dir);
        rewind.reshape();
        rewind.reshape();
        assert_eq!(shape_settled(session), None);
        drop(rewind);
        assert_eq!(shape_settled(session), Some(shape + 1));
        drop(writing(session));
        assert_eq!(shape_settled(session), Some(shape + 2));
    }

    /// A wait for the shape ends when the operation that may change it does, not before, and at once when the shape is
    /// already another one than the reader's; an append that leaves the shape alone ends no wait.
    #[tokio::test]
    async fn a_wait_for_the_shape_ends_with_the_operation_that_may_change_it() {
        let session = "log-epoch-test-wait";
        let shape = shape_settled(session).expect("nothing writes");
        shape_past(session, None).await;
        let mut same = std::pin::pin!(shape_past(session, Some(shape)));
        assert!(futures_pending(same.as_mut()).await, "nothing changed the shape");
        drop(appending(session));
        assert!(futures_pending(same.as_mut()).await, "an append that reshapes nothing ended");
        let rewind = writing(session);
        let mut rest = std::pin::pin!(shape_past(session, None));
        assert!(futures_pending(rest.as_mut()).await, "the operation still runs");
        assert!(futures_pending(same.as_mut()).await, "the operation still runs");
        drop(rewind);
        rest.await;
        same.await;
    }

    async fn futures_pending(mut wait: std::pin::Pin<&mut impl Future<Output = ()>>) -> bool {
        std::future::poll_fn(|cx| std::task::Poll::Ready(wait.as_mut().poll(cx).is_pending())).await
    }
}
