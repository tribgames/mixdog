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
//! The count is for the process: one process owns a data dir (`daemon-owner.lock`), and a test process with several data
//! dirs only sees a version move more often than it had to. A session has an entry only while an operation on it runs.
//! What a session at rest answers is its stripe's floor, a value drawn from one process-wide counter each time an
//! operation ends on a session of the stripe (the shape's floor when an operation that may reshape ends): a version a
//! reader holds is therefore never answered again once an operation began after it, however long the entry was gone, and
//! a read of a session that was never written inserts nothing. Sessions sharing a stripe only see a version move more
//! often than it had to.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::Path;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Striped so appends of different sessions rarely share a lock; the tables only ever hold the operations running at once,
/// so 256 keeps each lock cold without the count mattering to memory.
const STRIPES: usize = 256;

/// The operations running on one session.
#[derive(Default)]
struct Entry {
    writing: u32,
    reshaping: u32,
}

#[derive(Default)]
struct Stripe {
    running: HashMap<String, Entry>,
    /// The version and the shape's version of every session of the stripe with nothing running.
    version: u64,
    shape: u64,
}

struct Stripes {
    stripes: Vec<Mutex<Stripe>>,
    /// Told each time an operation that may reshape ends on the stripe ([`shape_past`]).
    reshaped: Vec<tokio::sync::Notify>,
}

fn stripes() -> &'static Stripes {
    static ALL: OnceLock<Stripes> = OnceLock::new();
    ALL.get_or_init(|| Stripes { stripes: (0..STRIPES).map(|_| Mutex::default()).collect(), reshaped: (0..STRIPES).map(|_| tokio::sync::Notify::new()).collect() })
}

fn stripe_of(session: &str) -> usize {
    let mut hasher = DefaultHasher::new();
    session.hash(&mut hasher);
    (hasher.finish() as usize) % STRIPES
}

fn lock(stripe: usize) -> MutexGuard<'static, Stripe> {
    stripes().stripes[stripe].lock().unwrap_or_else(PoisonError::into_inner)
}

fn next() -> u64 {
    static CLOCK: AtomicU64 = AtomicU64::new(1);
    CLOCK.fetch_add(1, Ordering::Relaxed)
}

/// An operation that may change a session's log, from before its first write to after its last (a rollback included).
#[must_use = "the operation is over when this is dropped"]
pub struct Writing {
    session: String,
    stripe: usize,
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
    let stripe = stripe_of(session);
    let session = session.to_owned();
    lock(stripe).running.entry(session.clone()).or_default().writing += 1;
    Writing { session, stripe, reshapes: false }
}

impl Writing {
    /// The operation may change the shape of the session's history. Called before it writes.
    pub fn reshape(&mut self) {
        if self.reshapes {
            return;
        }
        self.reshapes = true;
        let mut stripe = lock(self.stripe);
        let entry = stripe.running.get_mut(&self.session).expect("an operation keeps its session's entry");
        entry.reshaping += 1;
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        let mut stripe = lock(self.stripe);
        let entry = stripe.running.get_mut(&self.session).expect("an operation keeps its session's entry");
        entry.writing -= 1;
        entry.reshaping -= u32::from(self.reshapes);
        let over = entry.writing == 0;
        if over {
            stripe.running.remove(&self.session);
            stripe.version = next();
        }
        if self.reshapes {
            stripe.shape = next();
        }
        drop(stripe);
        if self.reshapes {
            stripes().reshaped[self.stripe].notify_waiters();
        }
    }
}

/// Resolves once no operation that may change the shape of `session`'s history runs and the shape's version is not
/// `seen`: with `None`, once the log is at rest; with the version a reader took, once an operation that may have changed
/// what it read has ended, whether it succeeded or rolled back. What a reader folds while such an operation runs may be
/// frames that are never acknowledged (written and not yet synced, then cut): it reads again after this.
pub async fn shape_past(session: &str, seen: Option<u64>) {
    let index = stripe_of(session);
    let reshaped = &stripes().reshaped[index];
    loop {
        let told = reshaped.notified();
        tokio::pin!(told);
        told.as_mut().enable();
        if shape_settled(session).is_some_and(|shape| Some(shape) != seen) {
            return;
        }
        told.await;
    }
}

/// The version of `session`'s log, or `None` while an operation on it runs (what is read then may be between two states).
pub fn settled(session: &str) -> Option<u64> {
    let stripe = lock(stripe_of(session));
    (!stripe.running.contains_key(session)).then_some(stripe.version)
}

/// The version of the shape of `session`'s history, or `None` while an operation that may change it runs.
pub fn shape_settled(session: &str) -> Option<u64> {
    let stripe = lock(stripe_of(session));
    (stripe.running.get(session).is_none_or(|entry| entry.reshaping == 0)).then_some(stripe.shape)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A version read while nothing writes is the same until an operation begins; while one runs there is none, nested
    /// operations included; after it the version is another one, and a session written is not another session's.
    #[test]
    fn a_version_holds_until_an_operation_begins() {
        let session = "log-epoch-test-a";
        let other = (0..).map(|n| format!("log-epoch-test-b{n}")).find(|name| stripe_of(name) != stripe_of(session)).unwrap();
        let other = other.as_str();
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
        let reshaped = shape_settled(session).expect("nothing writes");
        assert!(reshaped > shape);
        drop(writing(session));
        assert!(shape_settled(session).expect("nothing writes") > reshaped);
    }

    /// A session at rest holds no entry, however it was read or written, and its version still moves past what a reader held.
    #[test]
    fn a_session_at_rest_holds_nothing_and_its_version_still_moves() {
        let session = "log-epoch-test-rest";
        let held = (settled(session).expect("nothing writes"), shape_settled(session).expect("nothing writes"));
        assert!(!lock(stripe_of(session)).running.contains_key(session));
        drop(writing(session));
        assert!(lock(stripe_of(session)).running.is_empty() || !lock(stripe_of(session)).running.contains_key(session));
        let after = (settled(session).expect("nothing writes"), shape_settled(session).expect("nothing writes"));
        assert!(after.0 > held.0 && after.1 > held.1);
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
