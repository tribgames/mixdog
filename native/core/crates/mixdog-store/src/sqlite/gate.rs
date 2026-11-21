use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use rusqlite::Connection;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::Ack;
use super::Command;
use super::DbError;
use super::ReadPool;

/// Where the repairs a start owes stand ([`super::SqliteStore::repairs`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairReport {
    /// The sessions owed a repair when the index was opened.
    pub owed: usize,
    /// Those repaired since.
    pub repaired: usize,
    /// Those still to repair, the one being repaired included.
    pub pending: usize,
    /// Those owing a sensitive rewrite, not projected: each is repaired when it is released.
    pub left: Vec<String>,
    /// Those whose repair failed, each with its reason: unavailable until the next start.
    pub failed: Vec<(String, String)>,
    /// From the open to the moment nothing was left to repair; `None` while repairs are pending.
    pub elapsed: Option<Duration>,
}

/// How the repair of one session ended.
pub(super) enum Repaired {
    Done,
    /// It owes a sensitive rewrite: nothing of its log was projected ([`Recovery::release`]).
    Left,
    Failed(String),
}

/// The recovery work set of an open: the sessions owed a repair, each unavailable until its own repair ended.
struct Work {
    owed: usize,
    repaired: usize,
    /// Still to repair, the one being repaired included. Only [`Recovery::release`] adds to it.
    pending: BTreeSet<String>,
    /// Asked for by an access that waits, oldest first: repaired before the rest.
    asked: VecDeque<String>,
    /// Released from `left`: repaired whatever the withheld set says.
    forced: HashSet<String>,
    left: BTreeSet<String>,
    failed: BTreeMap<String, String>,
    /// Repairs may run: the withheld set is committed, or an access asked.
    started: bool,
    /// No repair runs any more (the store closed, or the repairs ended without an outcome): what is pending stays so.
    ended: bool,
    /// A verdict changed what the repair thread goes by: it is to be woken.
    nudge: bool,
    opened: Instant,
    elapsed: Option<Duration>,
    #[cfg(test)]
    order: Vec<String>,
}

enum Verdict {
    Clear,
    Wait,
    Refused(DbError),
}

impl Work {
    /// Whether an access that concerns `sessions` may proceed; a session it has to wait for is asked for.
    fn verdict<'a>(&mut self, sessions: impl IntoIterator<Item = &'a str>) -> Verdict {
        let mut wait = false;
        for session in sessions {
            if let Some(why) = self.failed.get(session) {
                return Verdict::Refused(DbError::Write(why.clone()));
            }
            if self.pending.contains(session) {
                if self.ended {
                    return Verdict::Refused(DbError::Stopped);
                }
                if !self.asked.iter().any(|asked| asked == session) {
                    self.asked.push_back(session.to_owned());
                    self.nudge = true;
                }
                self.nudge |= !std::mem::replace(&mut self.started, true);
                wait = true;
            }
        }
        if wait { Verdict::Wait } else { Verdict::Clear }
    }
}

/// The work set, awaited by tasks (`version`) and waited for by lane jobs and the repair thread (`changed`).
pub(super) struct Recovery {
    work: Mutex<Work>,
    changed: Condvar,
    version: watch::Sender<u64>,
    /// Nothing is pending and nothing failed: every access proceeds without taking the lock.
    clear: AtomicBool,
    /// How many accesses found a session of theirs recovering and waited, counted where both ways to wait pass.
    #[cfg(test)]
    waiters: watch::Sender<usize>,
}

impl Recovery {
    fn lock(&self) -> MutexGuard<'_, Work> {
        self.work.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// After a change made under `work`: every waiter looks again.
    fn tell(&self, work: MutexGuard<'_, Work>) {
        self.clear.store(work.pending.is_empty() && work.failed.is_empty(), Ordering::SeqCst);
        drop(work);
        self.version.send_modify(|version| *version += 1);
        self.changed.notify_all();
    }

    /// For code already inside a lane job: blocks its thread until the repair of each of `sessions` ended. The repairs
    /// run on a thread of their own and reach the index through their [`Repairer`], so a job blocked here never holds
    /// them up.
    fn wait_here(&self, sessions: &[&str]) -> Result<(), DbError> {
        if self.clear.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut work = self.lock();
        #[cfg(test)]
        let mut counted = false;
        loop {
            match work.verdict(sessions.iter().copied()) {
                Verdict::Clear => return Ok(()),
                Verdict::Refused(why) => return Err(why),
                Verdict::Wait => {}
            }
            #[cfg(test)]
            if !std::mem::replace(&mut counted, true) {
                self.waiters.send_modify(|n| *n += 1);
            }
            if std::mem::take(&mut work.nudge) {
                self.changed.notify_all();
            }
            work = self.changed.wait(work).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Resolves once the repair of each of `sessions` ended, with the failure of the first that failed.
    fn waited(self: &Arc<Self>, sessions: &[&str]) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        let waiting = (!self.clear.load(Ordering::SeqCst)).then(|| (self.clone(), sessions.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()));
        async move {
            let Some((recovery, sessions)) = waiting else { return Ok(()) };
            let mut version = recovery.version.subscribe();
            #[cfg(test)]
            let mut counted = false;
            loop {
                version.borrow_and_update();
                let verdict = {
                    let mut work = recovery.lock();
                    let verdict = work.verdict(sessions.iter().map(String::as_str));
                    if std::mem::take(&mut work.nudge) {
                        recovery.changed.notify_all();
                    }
                    verdict
                };
                match verdict {
                    Verdict::Clear => return Ok(()),
                    Verdict::Refused(why) => return Err(why),
                    Verdict::Wait => {}
                }
                #[cfg(test)]
                if !std::mem::replace(&mut counted, true) {
                    recovery.waiters.send_modify(|n| *n += 1);
                }
                version.changed().await.map_err(|_| DbError::Stopped)?;
            }
        }
    }

    /// Resolves once no repair is pending: `Ok` when none failed, else the first failure. Asking starts the repairs.
    fn all(self: &Arc<Self>) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        let recovery = self.clone();
        async move {
            let mut version = recovery.version.subscribe();
            loop {
                version.borrow_and_update();
                let outcome = {
                    let mut work = recovery.lock();
                    if work.pending.is_empty() {
                        Some(work.failed.values().next().map_or(Ok(()), |why| Err(DbError::Write(why.clone()))))
                    } else if work.ended {
                        Some(Err(DbError::Stopped))
                    } else {
                        if !std::mem::replace(&mut work.started, true) {
                            recovery.changed.notify_all();
                        }
                        None
                    }
                };
                if let Some(outcome) = outcome {
                    return outcome;
                }
                version.changed().await.map_err(|_| DbError::Stopped)?;
            }
        }
    }

    fn start(&self) {
        let mut work = self.lock();
        work.started = true;
        self.tell(work);
    }

    fn end(&self) {
        let mut work = self.lock();
        work.ended = true;
        self.tell(work);
    }

    /// `session` is about to be released from the withheld set: when its repair was left for that, it is owed again, next,
    /// and projected whatever the set says (its rewrite is done). `true` when the caller has a repair to wait for.
    fn release(&self, session: &str) -> bool {
        let mut work = self.lock();
        if !work.left.remove(session) {
            return false;
        }
        work.pending.insert(session.to_owned());
        work.forced.insert(session.to_owned());
        work.asked.push_front(session.to_owned());
        work.started = true;
        work.elapsed = None;
        self.tell(work);
        true
    }
}

/// The index's pool and writer channel, with the recovery work set every access that names a session passes.
pub(super) struct Gate {
    pool: Arc<ReadPool>,
    sender: mpsc::Sender<Command>,
    recovery: Arc<Recovery>,
}

/// The repairs' own way into the index, and their turn order. Dropped with a repair still pending (the store closed, the
/// process-end seam of a test), every access to a pending session fails as with a stopped writer.
pub(super) struct Repairer {
    pub(super) pool: Arc<ReadPool>,
    pub(super) sender: mpsc::Sender<Command>,
    recovery: Arc<Recovery>,
}

impl Repairer {
    /// Blocks until a session is to be repaired: one an access waits for, oldest request first, else the first in id
    /// order; with it, whether it is repaired whatever the withheld set says. `None` once nothing is left to repair or
    /// to wait for, or the store closed.
    pub(super) fn next(&self) -> Option<(String, bool)> {
        let mut work = self.recovery.lock();
        loop {
            if work.ended {
                return None;
            }
            if work.started {
                while let Some(asked) = work.asked.pop_front() {
                    if work.pending.contains(&asked) {
                        let forced = work.forced.remove(&asked);
                        return Some((asked, forced));
                    }
                }
                if let Some(first) = work.pending.first().cloned() {
                    let forced = work.forced.remove(&first);
                    return Some((first, forced));
                }
                if work.left.is_empty() {
                    return None;
                }
            }
            work = self.recovery.changed.wait(work).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The repair of `session` ended: every access that waited for it proceeds, or fails with its reason.
    pub(super) fn settle(&self, session: &str, outcome: Repaired) {
        let mut work = self.recovery.lock();
        if !work.pending.remove(session) {
            return;
        }
        #[cfg(test)]
        work.order.push(session.to_owned());
        match outcome {
            Repaired::Done => work.repaired += 1,
            Repaired::Left => drop(work.left.insert(session.to_owned())),
            Repaired::Failed(why) => drop(work.failed.insert(session.to_owned(), why)),
        }
        if work.pending.is_empty() {
            work.elapsed = Some(work.opened.elapsed());
        }
        self.recovery.tell(work);
    }
}

impl Drop for Repairer {
    fn drop(&mut self) {
        self.recovery.end();
    }
}

impl Gate {
    /// The gate of a store that owes `owed` their repair; with any, the [`Repairer`] whose thread repairs them.
    pub(super) fn new(pool: Arc<ReadPool>, sender: mpsc::Sender<Command>, owed: Vec<String>) -> (Gate, Option<Repairer>) {
        let opened = Instant::now();
        let recovery = Arc::new(Recovery {
            clear: AtomicBool::new(owed.is_empty()),
            work: Mutex::new(Work {
                owed: owed.len(),
                repaired: 0,
                elapsed: owed.is_empty().then(|| opened.elapsed()),
                pending: owed.into_iter().collect(),
                asked: VecDeque::new(),
                forced: HashSet::new(),
                left: BTreeSet::new(),
                failed: BTreeMap::new(),
                started: false,
                ended: false,
                nudge: false,
                opened,
                #[cfg(test)]
                order: Vec::new(),
            }),
            changed: Condvar::new(),
            version: watch::Sender::new(0),
            #[cfg(test)]
            waiters: watch::Sender::new(0),
        });
        let repairer = (!recovery.clear.load(Ordering::SeqCst)).then(|| Repairer { pool: pool.clone(), sender: sender.clone(), recovery: recovery.clone() });
        (Gate { pool, sender, recovery }, repairer)
    }

    /// Resolves once no repair is pending ([`Recovery::all`]).
    pub(super) fn reconciled(&self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        self.recovery.all()
    }

    /// Resolves once the repair of each of `sessions` ended.
    pub(super) fn recovered(&self, sessions: &[&str]) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        self.recovery.waited(sessions)
    }

    /// The repairs may run from here: the withheld set of this start is committed.
    pub(super) fn start_repairs(&self) {
        self.recovery.start();
    }

    /// [`Recovery::release`].
    pub(super) fn release(&self, session: &str) -> bool {
        self.recovery.release(session)
    }

    /// The sessions the index cannot answer for: those whose repair is pending, left or failed.
    pub(super) fn unavailable(&self) -> HashSet<String> {
        if self.recovery.clear.load(Ordering::SeqCst) {
            return HashSet::new();
        }
        let work = self.recovery.lock();
        work.pending.iter().chain(&work.left).chain(work.failed.keys()).cloned().collect()
    }

    pub(super) fn report(&self) -> RepairReport {
        let work = self.recovery.lock();
        RepairReport {
            owed: work.owed,
            repaired: work.repaired,
            pending: work.pending.len(),
            left: work.left.iter().cloned().collect(),
            failed: work.failed.iter().map(|(session, why)| (session.clone(), why.clone())).collect(),
            elapsed: work.elapsed,
        }
    }

    /// The number of accesses that waited for a repair so far.
    #[cfg(test)]
    pub(super) fn waiters(&self) -> watch::Receiver<usize> {
        self.recovery.waiters.subscribe()
    }

    /// The sessions whose repair ended, in that order.
    #[cfg(test)]
    pub(super) fn order(&self) -> Vec<String> {
        self.recovery.lock().order.clone()
    }

    /// A read as a job on the read lane, submitted once the repair of each of `sessions` (those it concerns) ended; at
    /// once when it names none.
    pub(super) fn read<T: Send + 'static>(
        &self,
        sessions: &[&str],
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        let (recovered, pool) = (self.recovery.waited(sessions), self.pool.clone());
        async move {
            recovered.await?;
            pool.run(f).await
        }
    }

    /// A read that also touches files, of no session in particular: the job gets the lane proof, and is submitted at once.
    pub(super) fn read_in_lane<T: Send + 'static>(
        &self,
        f: impl FnOnce(&InLane<InteractiveIo>, &Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.pool.run_in_lane(f)
    }

    /// A read on the calling thread, of no session in particular, for code already inside a lane job.
    pub(super) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        self.pool.with(f)
    }

    /// [`with`](Self::with) for a read that concerns `sessions`: blocks the job until the repair of each ended.
    pub(super) fn with_of<T>(&self, sessions: &[&str], f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        self.recovery.wait_here(sessions)?;
        self.pool.with(f)
    }

    /// The writer's channel, for code that feeds the writer from its own thread: blocks it until the repair of each of
    /// `sessions` ended.
    pub(super) fn feed(&self, sessions: &[&str]) -> Result<&mpsc::Sender<Command>, DbError> {
        self.recovery.wait_here(sessions)?;
        Ok(&self.sender)
    }

    /// A writer request, sent once the repair of each of `sessions` (those it concerns) ended; resolves with the writer's
    /// answer.
    pub(super) async fn ask(&self, sessions: &[&str], make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        answered(self.queue(sessions, make).await?).await
    }

    /// [`ask`](Self::ask) in two steps: resolves once the request is in the writer's channel, with the channel of the writer's
    /// answer (see [`answered`]). The writer takes requests in the order they were queued.
    pub(super) async fn queue(&self, sessions: &[&str], make: impl FnOnce(Ack) -> Command) -> Result<oneshot::Receiver<Result<(), DbError>>, DbError> {
        self.recovery.waited(sessions).await?;
        let (ack, answer) = oneshot::channel();
        self.sender.send(make(ack)).map_err(|_| DbError::Stopped)?;
        Ok(answer)
    }

    /// The repairs end, the writer is told to stop at once and `join_writer` waits for it, then the pool closes. Not gated:
    /// a close ends the store whatever the repairs are doing.
    pub(super) fn close(&self, join_writer: impl FnOnce()) {
        self.recovery.end();
        let _ = self.sender.send(Command::Close);
        join_writer();
        self.pool.close();
    }
}

impl Drop for Gate {
    fn drop(&mut self) {
        self.recovery.end();
    }
}

/// The writer's answer to a request [`Gate::queue`] sent: [`DbError::Stopped`] when the writer stopped without answering it.
pub(super) async fn answered(answer: oneshot::Receiver<Result<(), DbError>>) -> Result<(), DbError> {
    answer.await.map_err(|_| DbError::Stopped)?
}
