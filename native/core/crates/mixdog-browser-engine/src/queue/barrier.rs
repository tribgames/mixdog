//! Owner: s4-engine-queue
//! How one command waits for the work ahead of it on its queue key, and how its own completion is recorded for the commands
//! after it (`command-queue-barrier.ts`). Reads overlap each other; a write also outlasts the reads already in flight.
//!
//! Every command holds a [`CancellationToken`] that fires when it is done (its [`Admission`] dropped, finished or not). A
//! write's place on its key is every token it waited for plus its own, so a caller that cancels while still behind an older
//! mutation leaves the key representing that mutation until it has settled.

use std::collections::HashMap;
use std::future::Future;
use std::future::poll_fn;
use std::pin::pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::task::Poll;

use mixdog_rt::CancelView;
use mixdog_rt::CancellationToken;

pub(super) enum Either<A, B> {
    Left(A),
    Right(B),
}

/// Whichever of the two is ready first (the left one when both are).
pub(super) async fn race<A: Future, B: Future>(left: A, right: B) -> Either<A::Output, B::Output> {
    let mut left = pin!(left);
    let mut right = pin!(right);
    poll_fn(|cx| {
        if let Poll::Ready(done) = left.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(done));
        }
        if let Poll::Ready(done) = right.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(done));
        }
        Poll::Pending
    })
    .await
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    /// The tail of the writes on a key: what a later command waits for.
    chains: HashMap<String, Vec<CancellationToken>>,
    /// Reads in flight per key, which a write must outlast.
    reads: HashMap<String, Vec<(u64, CancellationToken)>>,
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    /// Forgets what is done on `key`.
    fn sweep(&mut self, key: &str) {
        if let Some(deps) = self.chains.get_mut(key) {
            deps.retain(|token| !token.is_cancelled());
            if deps.is_empty() {
                self.chains.remove(key);
            }
        }
        if let Some(reads) = self.reads.get_mut(key) {
            reads.retain(|(_, token)| !token.is_cancelled());
            if reads.is_empty() {
                self.reads.remove(key);
            }
        }
    }
}

/// The chains and in-flight reads of every queue key.
#[derive(Clone, Default)]
pub struct Ledger {
    inner: Arc<Mutex<Inner>>,
}

/// The place of one command on its key. Dropping it records the command as done.
pub struct Admission {
    ledger: Ledger,
    key: String,
    /// What the command waits for before it starts.
    barrier: Vec<CancellationToken>,
    done: CancellationToken,
}

/// The wait was ended by the command's cancellation, whose reason the view carries.
#[derive(Debug, PartialEq, Eq)]
pub struct BarrierCancelled;

impl Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes a place on `key` behind the work already there (`queueBarrier`) and records it for the commands after it
    /// (`trackQueueTail`). A read waits for the writes ahead of it; a write also for the reads in flight.
    pub fn admit(&self, key: &str, read_only: bool) -> Admission {
        let mut inner = lock(&self.inner);
        inner.sweep(key);
        let mut barrier = inner.chains.get(key).cloned().unwrap_or_default();
        if !read_only {
            barrier.extend(inner.reads.get(key).into_iter().flatten().map(|(_, token)| token.clone()));
        }
        let done = CancellationToken::new();
        if read_only {
            inner.next_id += 1;
            let id = inner.next_id;
            inner.reads.entry(key.to_string()).or_default().push((id, done.clone()));
        } else {
            let mut tail = barrier.clone();
            tail.push(done.clone());
            inner.chains.insert(key.to_string(), tail);
        }
        Admission { ledger: self.clone(), key: key.to_string(), barrier, done }
    }

    /// Whether `key` still has work in flight or ahead of it.
    pub fn is_busy(&self, key: &str) -> bool {
        let mut inner = lock(&self.inner);
        inner.sweep(key);
        inner.chains.contains_key(key) || inner.reads.contains_key(key)
    }
}

impl Admission {
    /// Resolves when everything ahead is done (`waitForBarrier`); `Err` when `cancel` fires first, which is checked first.
    pub async fn wait(&self, cancel: &CancelView) -> Result<(), BarrierCancelled> {
        let ahead = async {
            for token in &self.barrier {
                token.cancelled().await;
            }
        };
        match race(cancel.cancelled(), ahead).await {
            Either::Left(()) => Err(BarrierCancelled),
            Either::Right(()) => Ok(()),
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.done.cancel();
        lock(&self.ledger.inner).sweep(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_rt::CancelSource;

    #[test]
    fn a_read_waits_for_writes_and_a_write_for_everything() {
        let ledger = Ledger::new();
        let write = ledger.admit("k", false);
        let read_a = ledger.admit("k", true);
        let read_b = ledger.admit("k", true);
        let write_2 = ledger.admit("k", false);
        assert_eq!(write.barrier.len(), 0);
        assert_eq!(read_a.barrier.len(), 1, "behind the write only");
        assert_eq!(read_b.barrier.len(), 1, "the reads overlap each other");
        assert_eq!(write_2.barrier.len(), 1 + 2, "the chain (the write) and both reads");
        assert!(ledger.admit("other", false).barrier.is_empty());
    }

    #[test]
    fn a_settled_key_is_forgotten() {
        let ledger = Ledger::new();
        let write = ledger.admit("k", false);
        let read = ledger.admit("k", true);
        assert!(ledger.is_busy("k"));
        drop(write);
        assert!(ledger.is_busy("k"), "the read behind it is still in flight");
        drop(read);
        assert!(!ledger.is_busy("k"));
        assert!(lock(&ledger.inner).chains.is_empty());
        assert!(lock(&ledger.inner).reads.is_empty());
    }

    #[tokio::test]
    async fn a_cancelled_waiter_leaves_the_older_mutation_represented() {
        let ledger = Ledger::new();
        let older = ledger.admit("k", false);
        let source = CancelSource::new();
        let waiting = ledger.admit("k", false);
        source.cancel("fixture cancelled");
        assert_eq!(waiting.wait(&source.view()).await, Err(BarrierCancelled));
        drop(waiting);
        assert!(ledger.is_busy("k"), "the older mutation has not settled");
        let next = ledger.admit("k", false);
        assert_eq!(next.barrier.len(), 1, "the older mutation is still what the next command waits for");
        let live = CancelSource::new();
        let release = async {
            drop(older);
        };
        let (waited, ()) = tokio::join!(next.wait(&live.view()), release);
        assert_eq!(waited, Ok(()));
    }
}
