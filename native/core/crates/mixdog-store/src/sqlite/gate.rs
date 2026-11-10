//! The one way into an open index (`SqliteStore`): its read connections and its writer's channel are fields of [`Gate`], private
//! to this module, and every method that hands either out first waits until the reconcile `SqliteStore::open` started (the
//! sessions found dirty at open) has ended. Code in `sqlite` and its other modules cannot reach the pool or the channel around
//! it, so no read sees, and no write changes, a row the reconcile has yet to write, whatever entry a later change adds. Only the
//! reconcile reaches them before it ends, through the one [`Reconciler`] the gate is made with.

use std::future::Future;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::mpsc;

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use rusqlite::Connection;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::Ack;
use super::Command;
use super::DbError;
use super::ReadPool;

/// Where the reconcile stands.
#[derive(Debug, Clone)]
enum Settle {
    Reconciling,
    Done,
    /// It failed to write the index: every access fails with its reason.
    Failed(String),
    /// It ended without an outcome (the process-end seam of a test): every access fails as with a stopped writer.
    Ended,
}

impl Settle {
    fn outcome(&self) -> Option<Result<(), DbError>> {
        match self {
            Settle::Reconciling => None,
            Settle::Done => Some(Ok(())),
            Settle::Failed(why) => Some(Err(DbError::Write(why.clone()))),
            Settle::Ended => Some(Err(DbError::Stopped)),
        }
    }
}

/// The reconcile's state, awaited by tasks (`state`) and waited for by lane jobs (`changed`).
struct Settlement {
    state: watch::Sender<Settle>,
    lock: Mutex<()>,
    changed: Condvar,
    /// How many accesses found the gate closed and waited, counted where both ways to wait pass.
    #[cfg(test)]
    waiters: watch::Sender<usize>,
}

impl Settlement {
    fn set(&self, settle: Settle) {
        let _held = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.state.send_replace(settle);
        self.changed.notify_all();
    }

    /// For code already inside a lane job: blocks its thread. The reconcile is the first job of the read lane (submitted before
    /// the store is returned) and reaches the index through its [`Reconciler`], so a job blocked here never holds it up.
    fn wait_here(&self) -> Result<(), DbError> {
        let mut held = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        #[cfg(test)]
        let mut counted = false;
        loop {
            if let Some(outcome) = self.state.borrow().outcome() {
                return outcome;
            }
            #[cfg(test)]
            if !std::mem::replace(&mut counted, true) {
                self.waiters.send_modify(|n| *n += 1);
            }
            held = self.changed.wait(held).unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn waited(&self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        let mut state = self.state.subscribe();
        #[cfg(test)]
        let waiters = self.waiters.clone();
        async move {
            #[cfg(test)]
            if state.borrow().outcome().is_none() {
                waiters.send_modify(|n| *n += 1);
            }
            let outcome = state.wait_for(|settle| settle.outcome().is_some()).await.map_err(|_| DbError::Stopped)?.outcome();
            outcome.expect("waited for an outcome")
        }
    }
}

/// The index's pool and writer channel behind the reconcile.
pub(super) struct Gate {
    pool: Arc<ReadPool>,
    sender: mpsc::Sender<Command>,
    settlement: Arc<Settlement>,
}

/// The reconcile's own way into the index, before the gate opens; the gate opens with its outcome, or fails every access when
/// it is dropped without one.
pub(super) struct Reconciler {
    pub(super) pool: Arc<ReadPool>,
    pub(super) sender: mpsc::Sender<Command>,
    settlement: Arc<Settlement>,
}

impl Reconciler {
    pub(super) fn finish(self, outcome: Result<(), String>) {
        self.settlement.set(match outcome {
            Ok(()) => Settle::Done,
            Err(why) => Settle::Failed(why),
        });
    }
}

impl Drop for Reconciler {
    fn drop(&mut self) {
        let pending = matches!(*self.settlement.state.borrow(), Settle::Reconciling);
        if pending {
            self.settlement.set(Settle::Ended);
        }
    }
}

impl Gate {
    /// The gate of a store; with `reconcile`, closed until the returned [`Reconciler`] finishes.
    pub(super) fn new(pool: Arc<ReadPool>, sender: mpsc::Sender<Command>, reconcile: bool) -> (Gate, Option<Reconciler>) {
        let settlement = Arc::new(Settlement {
            state: watch::Sender::new(if reconcile { Settle::Reconciling } else { Settle::Done }),
            lock: Mutex::new(()),
            changed: Condvar::new(),
            #[cfg(test)]
            waiters: watch::Sender::new(0),
        });
        let reconciler = reconcile.then(|| Reconciler { pool: pool.clone(), sender: sender.clone(), settlement: settlement.clone() });
        (Gate { pool, sender, settlement }, reconciler)
    }

    /// Resolves once the reconcile has ended: `Ok` when it wrote every row, its failure otherwise.
    pub(super) fn reconciled(&self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        self.settlement.waited()
    }

    /// The number of accesses that waited at the closed gate so far.
    #[cfg(test)]
    pub(super) fn waiters(&self) -> watch::Receiver<usize> {
        self.settlement.waiters.subscribe()
    }

    /// A read as a job on the read lane, submitted once the reconcile has ended.
    pub(super) fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.read_in_lane(move |_, c| f(c))
    }

    /// [`read`](Self::read) for a read that also touches files: the job gets the lane proof.
    pub(super) fn read_in_lane<T: Send + 'static>(
        &self,
        f: impl FnOnce(&InLane<InteractiveIo>, &Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        let (settled, pool) = (self.settlement.waited(), self.pool.clone());
        async move {
            settled.await?;
            pool.run_in_lane(f).await
        }
    }

    /// A read on the calling thread, for code already inside a lane job: blocks it until the reconcile has ended.
    pub(super) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        self.settlement.wait_here()?;
        self.pool.with(f)
    }

    /// A writer request, sent once the reconcile has ended; resolves with the writer's answer.
    pub(super) async fn ask(&self, make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        self.settlement.waited().await?;
        let (ack, answer) = oneshot::channel();
        self.sender.send(make(ack)).map_err(|_| DbError::Stopped)?;
        answer.await.map_err(|_| DbError::Stopped)?
    }

    /// Test teardown: the writer is told to stop at once and `join_writer` waits for it, then the pool closes. Not gated: a
    /// teardown ends the store whatever the reconcile is doing.
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn close(&self, join_writer: impl FnOnce()) {
        let _ = self.sender.send(Command::Close);
        join_writer();
        self.pool.close();
    }
}
