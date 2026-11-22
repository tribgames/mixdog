use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
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
    /// A fork whose base is held for its rewrite: it is repaired once that base is.
    LeftFor(String),
    Failed(String),
}

/// What a read needs the index to hold whole before its answer is one ([`Gate::read_exact`]). A value the read would
/// give (no row, an empty list, a free tag, nothing that refers to a session) is an answer only over the sessions named
/// here, each with its complete projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Need {
    /// These sessions: a named one, or a fork with the bases it reads.
    Sessions(Vec<String>),
    /// Every session that could hold a worker row or be agent-only ([`Work::workers`]).
    Workers,
    /// Every session owed its rows at open.
    All,
}

impl Need {
    pub(crate) fn of(sessions: &[&str]) -> Need {
        Need::Sessions(sessions.iter().map(|session| (*session).to_owned()).collect())
    }
}

/// Why a gated read has no answer. None of them says the data is not there.
#[derive(Debug, thiserror::Error)]
pub enum ProjectionError {
    /// The store stopped with a session of the read still to repair.
    #[error("index writer stopped")]
    Stopped,
    /// The repair of a session the read rests on failed in this start: it is not tried again before the next.
    #[error("index recovery failed for {session}: {reason}")]
    Failed { session: String, reason: String },
    #[error(transparent)]
    Read(#[from] DbError),
}

impl From<ProjectionError> for DbError {
    fn from(error: ProjectionError) -> DbError {
        match error {
            ProjectionError::Stopped => DbError::Stopped,
            ProjectionError::Failed { session, reason } => DbError::Recovery { session, reason },
            ProjectionError::Read(error) => error,
        }
    }
}

/// The recovery work set of an open. A session owed its rows is queued, running, held or failed, and ready only once its
/// repair committed its complete projection; a session owed nothing is ready.
struct Work {
    owed: usize,
    repaired: usize,
    /// Queued or running. A release and a base that settled are all that add to it.
    pending: BTreeSet<String>,
    /// Those of `pending` a repair thread holds.
    running: HashSet<String>,
    /// Requested by an access that waits, oldest first: repaired before every other.
    asked: VecDeque<String>,
    /// Every session requested so far, and what their repairs needed first.
    requested: HashSet<String>,
    /// The sessions that could hold a worker row: what [`Need::Workers`] waits for, and what the repairs take after the
    /// requested ones. Fixed at open: a member held, released or failed stays one.
    workers: BTreeSet<String>,
    /// `workers` still to take, in their order.
    worker_queue: VecDeque<String>,
    /// The bases the repair of a worker candidate needed first.
    worker_needs: HashSet<String>,
    /// The rest of a rebuild, in its order.
    queue: VecDeque<String>,
    /// Released from `held`: repaired whatever the withheld set says.
    forced: HashSet<String>,
    /// Held for a sensitive rewrite, or a fork of one that is: not projected, and not ready.
    held: BTreeSet<String>,
    /// The forks held for each held base.
    waits_on: BTreeMap<String, BTreeSet<String>>,
    failed: BTreeMap<String, String>,
    /// How often each session changed state, and how often any did, and any of `workers`: what a read was certified at.
    revs: HashMap<String, u64>,
    generation: u64,
    worker_generation: u64,
    /// Repairs may run: the withheld set is committed, or an access asked.
    started: bool,
    /// A withheld set was committed: the opener runs the rewrites that release what is held.
    withholds: bool,
    /// Whether an access that waits starts the repairs ([`super::RepairStart`]).
    starts_on_wait: bool,
    /// No repair runs any more (the store closed, or the repairs ended without an outcome): what is pending stays so.
    ended: bool,
    /// The store closed: every gated access is refused.
    closed: bool,
    /// A verdict changed what the repair thread goes by: it is to be woken.
    nudge: bool,
    opened: Instant,
    elapsed: Option<Duration>,
    #[cfg(test)]
    order: Vec<String>,
    #[cfg(test)]
    taken: Vec<String>,
}

enum Verdict {
    /// Every session of the need is ready: the stamp of their states ([`Work::stamp`]).
    Clear(u64),
    Wait,
    Refused(ProjectionError),
}

impl Work {
    /// `session` changed state.
    fn moved(&mut self, session: &str) {
        *self.revs.entry(session.to_owned()).or_default() += 1;
        self.generation += 1;
        if self.workers.contains(session) {
            self.worker_generation += 1;
        }
    }

    /// What moves whenever a session of `need` changes state.
    fn stamp(&self, need: &Need) -> u64 {
        match need {
            Need::Sessions(sessions) => sessions.iter().filter_map(|session| self.revs.get(session)).sum(),
            Need::Workers => self.worker_generation,
            Need::All => self.generation,
        }
    }

    fn request(&mut self, session: &str) {
        if self.requested.insert(session.to_owned()) {
            self.asked.push_back(session.to_owned());
            self.nudge = true;
        }
    }

    /// The one verdict of every gated access: wait while a session of `need` is queued, running or held; with none
    /// pending, the failure of one that failed; else clear. A queued session a named read waits for is requested.
    fn verdict(&mut self, need: &Need) -> Verdict {
        if self.closed {
            return Verdict::Refused(ProjectionError::Stopped);
        }
        let (queued, held) = match need {
            Need::Sessions(sessions) => {
                (sessions.iter().any(|session| self.pending.contains(session)), sessions.iter().find(|session| self.held.contains(*session)).cloned())
            }
            Need::Workers => {
                (self.workers.iter().any(|session| self.pending.contains(session)), self.workers.iter().find(|session| self.held.contains(*session)).cloned())
            }
            Need::All => (!self.pending.is_empty(), self.held.first().cloned()),
        };
        if queued || (held.is_some() && self.withholds) {
            if self.ended {
                return Verdict::Refused(ProjectionError::Stopped);
            }
            if let Need::Sessions(sessions) = need {
                for session in sessions {
                    if self.pending.contains(session) {
                        self.request(session);
                    }
                }
            }
            self.nudge |= self.start_on_wait();
            return Verdict::Wait;
        }
        if let Some(session) = held {
            // An opener that committed no withheld set runs no rewrite: nothing would ever release the session.
            return Verdict::Refused(ProjectionError::Failed { session, reason: "it is held for a sensitive rewrite this open does not run".to_owned() });
        }
        let failed = match need {
            Need::Sessions(sessions) => sessions.iter().find_map(|session| self.failed.get_key_value(session)),
            Need::Workers => self.failed.iter().find(|(session, _)| self.workers.contains(*session)),
            Need::All => self.failed.iter().next(),
        };
        match failed {
            Some((session, reason)) => Verdict::Refused(ProjectionError::Failed { session: session.clone(), reason: reason.clone() }),
            None => Verdict::Clear(self.stamp(need)),
        }
    }

    /// `session` failed, and with it every fork held for it, and theirs. How many failed.
    fn fail(&mut self, session: String, why: String) -> usize {
        let mut failing = vec![(session, why)];
        let mut count = 0;
        while let Some((session, why)) = failing.pop() {
            for fork in self.waits_on.remove(&session).unwrap_or_default() {
                if self.held.remove(&fork) {
                    let reason = format!("{fork}: its base {session} was not recovered ({why})");
                    failing.push((fork, reason));
                }
            }
            self.moved(&session);
            self.failed.insert(session, why);
            count += 1;
        }
        count
    }

    /// Where the writer takes a repair's work for `session`: 0 for a requested session and what it needs first, 1 for a
    /// worker candidate and what it needs first, 2 for the rest of a rebuild.
    fn rank(&self, session: &str) -> u8 {
        if self.requested.contains(session) {
            0
        } else if self.workers.contains(session) || self.worker_needs.contains(session) {
            1
        } else {
            2
        }
    }

    /// A waiter's start of the repairs: `true` when this call started them.
    fn start_on_wait(&mut self) -> bool {
        self.starts_on_wait && !std::mem::replace(&mut self.started, true)
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
        self.clear.store(work.pending.is_empty() && work.held.is_empty() && work.failed.is_empty() && !work.closed, Ordering::SeqCst);
        drop(work);
        self.version.send_modify(|version| *version += 1);
        self.changed.notify_all();
    }

    /// For code already inside a lane job: blocks its thread until `need` is certified, and returns the stamp it was
    /// certified at. The lock is not held while it waits, and the caller holds no read transaction yet. The repairs run on
    /// threads of their own and reach the index through their [`Repairer`], so a job blocked here never holds them up.
    fn admit_here(&self, need: &Need) -> Result<u64, ProjectionError> {
        let mut work = self.lock();
        #[cfg(test)]
        let mut counted = false;
        loop {
            match work.verdict(need) {
                Verdict::Clear(stamp) => return Ok(stamp),
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

    /// [`admit_here`](Self::admit_here) for a task: the same verdict, awaited.
    fn admitted(self: &Arc<Self>, need: Need) -> impl Future<Output = Result<u64, ProjectionError>> + Send + 'static {
        let recovery = self.clone();
        async move {
            let mut version = recovery.version.subscribe();
            #[cfg(test)]
            let mut counted = false;
            loop {
                version.borrow_and_update();
                let verdict = {
                    let mut work = recovery.lock();
                    let verdict = work.verdict(&need);
                    if std::mem::take(&mut work.nudge) {
                        recovery.changed.notify_all();
                    }
                    verdict
                };
                match verdict {
                    Verdict::Clear(stamp) => return Ok(stamp),
                    Verdict::Refused(why) => return Err(why),
                    Verdict::Wait => {}
                }
                #[cfg(test)]
                if !std::mem::replace(&mut counted, true) {
                    recovery.waiters.send_modify(|n| *n += 1);
                }
                version.changed().await.map_err(|_| ProjectionError::Stopped)?;
            }
        }
    }

    fn stamp(&self, need: &Need) -> u64 {
        self.lock().stamp(need)
    }

    /// The withheld set of this start is committed.
    fn start(&self) {
        let mut work = self.lock();
        work.started = true;
        work.withholds = true;
        self.tell(work);
    }

    fn end(&self) {
        let mut work = self.lock();
        work.ended = true;
        self.tell(work);
    }

    fn close(&self) {
        let mut work = self.lock();
        work.ended = true;
        work.closed = true;
        self.tell(work);
    }

    /// `session` is about to be released from the withheld set: when its repair was held for that, it is queued again,
    /// next, and projected whatever the set says (its rewrite is done). It goes from held to queued with no state between
    /// in which a read is admitted. `true` when the caller has a repair to wait for.
    fn release(&self, session: &str) -> bool {
        let mut work = self.lock();
        if !work.held.remove(session) {
            return false;
        }
        work.pending.insert(session.to_owned());
        work.forced.insert(session.to_owned());
        work.requested.insert(session.to_owned());
        work.asked.push_front(session.to_owned());
        work.started = true;
        work.elapsed = None;
        work.moved(session);
        self.tell(work);
        true
    }

    /// The rewrite `session` was held for failed: it settles as failed, with the forks held for it, and every waiter is
    /// woken. `false` when it was not held.
    fn fail_held(&self, session: &str, why: String) -> bool {
        let mut work = self.lock();
        if !work.held.remove(session) {
            return false;
        }
        work.fail(session.to_owned(), why);
        self.tell(work);
        true
    }
}

/// A read snapshot of `c` that `need` was certified for at `stamp`: `None` when a session of it changed state before the
/// snapshot was taken, so the certificate is not one of this snapshot.
fn certified_snapshot<'c>(c: &'c Connection, recovery: &Recovery, need: &Need, stamp: u64) -> Result<Option<rusqlite::Transaction<'c>>, DbError> {
    let snapshot = c.unchecked_transaction()?;
    // A deferred transaction takes its snapshot with the first statement that reads the file.
    snapshot.prepare_cached("SELECT count(*) FROM meta WHERE key = ''")?.query_row([], |_| Ok(()))?;
    Ok((recovery.stamp(need) == stamp).then_some(snapshot))
}

/// The index's pool and writer channel, with the recovery work set every access passes.
pub(super) struct Gate {
    pool: Arc<ReadPool>,
    sender: mpsc::Sender<Command>,
    recovery: Arc<Recovery>,
}

/// Where the writer takes a repair's work for a session ([`Work::rank`]): read at each dispatch, so a session requested
/// after its work was handed over still goes first.
pub(super) struct Ranks(Arc<Recovery>);

impl Ranks {
    pub(super) fn of(&self, session: &str) -> u8 {
        self.0.lock().rank(session)
    }
}

/// What a repair finds of the base its fork reads ([`Repairer::take_or_wait`]).
pub(super) enum Base {
    /// Pending, and no thread holds it: this thread repairs it now, whatever the withheld set says when `true`.
    Take(bool),
    Ready,
    Held,
    Failed(String),
    Stopped,
}

/// The repairs' own way into the index, and their turn order; shared by the repair threads. Dropped with a repair still
/// pending (the store closed, the process-end seam of a test), every access to a pending session fails as with a stopped
/// writer.
pub(super) struct Repairer {
    pub(super) pool: Arc<ReadPool>,
    pub(super) sender: mpsc::Sender<Command>,
    recovery: Arc<Recovery>,
    /// Told of every repair that ended, for a rebuild's progress.
    progress: Option<Arc<super::RebuildProgress>>,
}

impl Repairer {
    /// Blocks until a session is to be repaired that no other repair thread holds: a requested one, oldest request first;
    /// else the next worker candidate; else the next of the rebuild's order, else the first in id order. With it, whether
    /// it is repaired whatever the withheld set says. Each thread holds one session, so the rest of a rebuild is never
    /// handed to the writer ahead of a session requested later. `None` once nothing is left to repair or to wait for, or
    /// the store closed.
    pub(super) fn next(&self) -> Option<(String, bool)> {
        let mut work = self.recovery.lock();
        loop {
            if work.ended {
                return None;
            }
            if work.started {
                let Work { asked, worker_queue, queue, pending, running, .. } = &mut *work;
                let mut taken = None;
                for order in [asked, worker_queue, queue] {
                    while let Some(next) = order.pop_front() {
                        if pending.contains(&next) && !running.contains(&next) {
                            taken = Some(next);
                            break;
                        }
                    }
                    if taken.is_some() {
                        break;
                    }
                }
                let taken = taken.or_else(|| work.pending.iter().find(|session| !work.running.contains(*session)).cloned());
                if let Some(session) = taken {
                    work.running.insert(session.clone());
                    #[cfg(test)]
                    work.taken.push(session.clone());
                    let forced = work.forced.remove(&session);
                    return Some((session, forced));
                }
                if work.pending.is_empty() && work.held.is_empty() {
                    return None;
                }
            }
            work = self.recovery.changed.wait(work).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// For the repair of `fork`, whose row waits for `base`'s rows: what `base` is, waiting while another thread repairs
    /// it. A base taken here ranks with the fork that needs it.
    pub(super) fn take_or_wait(&self, base: &str, fork: &str) -> Base {
        let mut work = self.recovery.lock();
        loop {
            if work.ended {
                return Base::Stopped;
            }
            if let Some(why) = work.failed.get(base) {
                return Base::Failed(why.clone());
            }
            if work.held.contains(base) {
                return Base::Held;
            }
            if !work.pending.contains(base) {
                return Base::Ready;
            }
            if work.requested.contains(fork) {
                work.requested.insert(base.to_owned());
            }
            if work.workers.contains(fork) || work.worker_needs.contains(fork) {
                work.worker_needs.insert(base.to_owned());
            }
            if work.running.insert(base.to_owned()) {
                return Base::Take(work.forced.remove(base));
            }
            work = self.recovery.changed.wait(work).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The repairs stop here with what is pending left so (a test's process end).
    pub(super) fn end(&self) {
        self.recovery.end();
    }

    /// The repair of `session` ended, its last transaction committed: every access that waited for it proceeds, or fails
    /// with its reason. A failed one is not tried again in this start; its debt in the index is the next start's.
    pub(super) fn settle(&self, session: &str, outcome: Repaired) {
        let mut work = self.recovery.lock();
        work.running.remove(session);
        let outcome = match outcome {
            Repaired::LeftFor(base) if work.held.contains(&base) => Repaired::LeftFor(base),
            Repaired::LeftFor(base) => match work.failed.get(&base) {
                Some(why) => Repaired::Failed(format!("{session}: its base {base} was not recovered ({why})")),
                // The base was released meanwhile: the fork stays queued, and is repaired again behind it.
                None => {
                    if work.pending.contains(session) {
                        work.asked.push_front(session.to_owned());
                    }
                    self.recovery.tell(work);
                    return;
                }
            },
            other => other,
        };
        if !work.pending.remove(session) {
            return;
        }
        #[cfg(test)]
        work.order.push(session.to_owned());
        match outcome {
            Repaired::Done => {
                work.repaired += 1;
                work.moved(session);
                // A fork held for this base goes from held to queued, next.
                for fork in work.waits_on.remove(session).unwrap_or_default() {
                    if work.held.remove(&fork) {
                        work.pending.insert(fork.clone());
                        work.moved(&fork);
                        work.asked.push_front(fork);
                    }
                }
                if let Some(progress) = &self.progress {
                    progress.advance();
                }
            }
            Repaired::Left => {
                work.held.insert(session.to_owned());
                work.moved(session);
            }
            Repaired::LeftFor(base) => {
                work.held.insert(session.to_owned());
                work.waits_on.entry(base).or_default().insert(session.to_owned());
                work.moved(session);
            }
            Repaired::Failed(why) => {
                let failed = work.fail(session.to_owned(), why);
                if let Some(progress) = &self.progress {
                    for _ in 0..failed {
                        progress.fail();
                    }
                }
            }
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
    /// The gate of a store that owes `owed` their repair: `workers` (in their order) may hold a worker row, `queue` is the
    /// order of the rest. With any owed, the [`Repairer`] the repair threads share, which tells `progress` of each repair
    /// that ends.
    pub(super) fn new(
        pool: Arc<ReadPool>,
        sender: mpsc::Sender<Command>,
        owed: Vec<String>,
        workers: Vec<String>,
        queue: Vec<String>,
        progress: Option<Arc<super::RebuildProgress>>,
        start: super::RepairStart,
    ) -> (Gate, Option<Repairer>) {
        let opened = Instant::now();
        let pending: BTreeSet<String> = owed.into_iter().collect();
        let recovery = Arc::new(Recovery {
            clear: AtomicBool::new(pending.is_empty()),
            work: Mutex::new(Work {
                owed: pending.len(),
                repaired: 0,
                elapsed: pending.is_empty().then(|| opened.elapsed()),
                asked: VecDeque::new(),
                requested: HashSet::new(),
                worker_queue: workers.iter().filter(|session| pending.contains(*session)).cloned().collect(),
                workers: workers.into_iter().collect(),
                worker_needs: HashSet::new(),
                queue: queue.into(),
                running: HashSet::new(),
                pending,
                forced: HashSet::new(),
                held: BTreeSet::new(),
                waits_on: BTreeMap::new(),
                failed: BTreeMap::new(),
                revs: HashMap::new(),
                generation: 0,
                worker_generation: 0,
                started: false,
                withholds: false,
                starts_on_wait: start == super::RepairStart::FirstWait,
                ended: false,
                closed: false,
                nudge: false,
                opened,
                #[cfg(test)]
                order: Vec::new(),
                #[cfg(test)]
                taken: Vec::new(),
            }),
            changed: Condvar::new(),
            version: watch::Sender::new(0),
            #[cfg(test)]
            waiters: watch::Sender::new(0),
        });
        let repairer =
            (!recovery.clear.load(Ordering::SeqCst)).then(|| Repairer { pool: pool.clone(), sender: sender.clone(), recovery: recovery.clone(), progress });
        (Gate { pool, sender, recovery }, repairer)
    }

    /// The one gated read. `query` runs once every session of `need` is ready, on a read snapshot taken after that was
    /// certified: the verdict and the snapshot are a pair, and a session of `need` that changed state before the snapshot
    /// was taken has the read certified again. While a session of `need` is queued, running or held it waits, holding
    /// neither the gate's lock nor a read transaction; with none pending, the failure of one that failed is the answer; a
    /// stopped store answers [`ProjectionError::Stopped`]. Asking requests the queued sessions it names.
    pub(super) fn read_exact<T: Send + 'static>(
        &self,
        need: Need,
        query: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, ProjectionError>> + Send + 'static {
        self.read_exact_in_lane(need, move |_, c| query(c))
    }

    /// [`read_exact`](Self::read_exact) for a read that also touches files: the job gets the lane proof.
    pub(super) fn read_exact_in_lane<T: Send + 'static>(
        &self,
        need: Need,
        query: impl FnOnce(&InLane<InteractiveIo>, &Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, ProjectionError>> + Send + 'static {
        let (recovery, pool) = (self.recovery.clone(), self.pool.clone());
        async move {
            // Nothing is owed and nothing failed: every session is ready, and stays so.
            if recovery.clear.load(Ordering::SeqCst) {
                return Ok(pool.run_in_lane(query).await?);
            }
            let mut query = Some(query);
            loop {
                let stamp = recovery.admitted(need.clone()).await?;
                let (certifier, of) = (recovery.clone(), need.clone());
                let run = query.take().expect("a query that did not run is handed back");
                let read = pool.run_in_lane(move |lane, c| {
                    let Some(snapshot) = certified_snapshot(c, &certifier, &of, stamp)? else { return Ok(Err(run)) };
                    let out = run(lane, &snapshot)?;
                    snapshot.commit()?;
                    Ok(Ok(out))
                });
                match read.await? {
                    Ok(out) => return Ok(out),
                    Err(run) => query = Some(run),
                }
            }
        }
    }

    /// [`read_exact`](Self::read_exact) on the calling thread, for code already inside a lane job: the same verdict,
    /// waited for on the job's thread.
    pub(super) fn with_exact<T>(&self, need: &Need, query: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, ProjectionError> {
        if self.recovery.clear.load(Ordering::SeqCst) {
            return Ok(self.pool.with(query)?);
        }
        let mut query = Some(query);
        loop {
            let stamp = self.recovery.admit_here(need)?;
            let run = query.take().expect("a query that did not run is handed back");
            let read = self.pool.with(|c| {
                let Some(snapshot) = certified_snapshot(c, &self.recovery, need, stamp)? else { return Ok(Err(run)) };
                let out = run(&snapshot)?;
                snapshot.commit()?;
                Ok(Ok(out))
            })?;
            match read {
                Ok(out) => return Ok(out),
                Err(run) => query = Some(run),
            }
        }
    }

    /// Resolves once `need` is certified, with the gate's verdict and no read: for a caller that waits for it before work
    /// of its own (a deferred purge, a report).
    pub(super) fn settled(&self, need: Need) -> impl Future<Output = Result<(), ProjectionError>> + Send + 'static {
        let admitted = (!self.recovery.clear.load(Ordering::SeqCst)).then(|| self.recovery.admitted(need));
        async move {
            match admitted {
                Some(admitted) => admitted.await.map(|_| ()),
                None => Ok(()),
            }
        }
    }

    /// The verdict on `need` now, without waiting: `Ok(false)` while a session of it is still to repair. For a caller
    /// that defers rather than waits.
    pub(super) fn settled_now(&self, need: &Need) -> Result<bool, ProjectionError> {
        if self.recovery.clear.load(Ordering::SeqCst) {
            return Ok(true);
        }
        let mut work = self.recovery.lock();
        let verdict = work.verdict(need);
        if std::mem::take(&mut work.nudge) {
            self.recovery.changed.notify_all();
        }
        match verdict {
            Verdict::Clear(_) => Ok(true),
            Verdict::Wait => Ok(false),
            Verdict::Refused(why) => Err(why),
        }
    }

    /// The repairs may run from here: the withheld set of this start is committed.
    pub(super) fn start_repairs(&self) {
        self.recovery.start();
    }

    /// [`Recovery::release`].
    pub(super) fn release(&self, session: &str) -> bool {
        self.recovery.release(session)
    }

    /// [`Recovery::fail_held`].
    pub(super) fn fail_held(&self, session: &str, why: String) -> bool {
        self.recovery.fail_held(session, why)
    }

    /// The sessions the index cannot answer for: those whose repair is pending, held or failed. Read before the rows it
    /// qualifies: a session only ever leaves this set, so one not in it was ready before the rows were read.
    pub(super) fn unavailable(&self) -> HashSet<String> {
        if self.recovery.clear.load(Ordering::SeqCst) {
            return HashSet::new();
        }
        let work = self.recovery.lock();
        work.pending.iter().chain(&work.held).chain(work.failed.keys()).cloned().collect()
    }

    pub(super) fn report(&self) -> RepairReport {
        let work = self.recovery.lock();
        RepairReport {
            owed: work.owed,
            repaired: work.repaired,
            pending: work.pending.len(),
            left: work.held.iter().cloned().collect(),
            failed: work.failed.iter().map(|(session, why)| (session.clone(), why.clone())).collect(),
            elapsed: work.elapsed,
        }
    }

    /// Moves at every change of the work set: a repair ended, one was released, the repairs stopped.
    pub(super) fn changes(&self) -> watch::Receiver<u64> {
        self.recovery.version.subscribe()
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

    /// The sessions the repair threads took, in the order they were handed out.
    #[cfg(test)]
    pub(super) fn taken(&self) -> Vec<String> {
        self.recovery.lock().taken.clone()
    }

    /// A read of what is no projection of a log (the withheld set, the debts a start owes, a row's bare presence for a
    /// caller that falls back to the record): it rests on no session's rows being whole, and is not gated.
    pub(super) fn manifest<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, DbError> + Send + 'static,
    ) -> impl Future<Output = Result<T, DbError>> + Send + 'static {
        self.pool.run(f)
    }

    /// [`manifest`](Self::manifest) on the calling thread, for code already inside a lane job.
    pub(super) fn manifest_here<T>(&self, f: impl FnOnce(&Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        self.pool.with(f)
    }

    /// The writer's channel, for code that feeds the writer from its own thread: blocks it until `sessions` are ready.
    pub(super) fn feed(&self, sessions: &[&str]) -> Result<&mpsc::Sender<Command>, DbError> {
        if !self.recovery.clear.load(Ordering::SeqCst) {
            self.recovery.admit_here(&Need::of(sessions))?;
        }
        Ok(&self.sender)
    }

    /// A writer request, sent once `sessions` (those it concerns) are ready; resolves with the writer's answer.
    pub(super) async fn ask(&self, sessions: &[&str], make: impl FnOnce(Ack) -> Command) -> Result<(), DbError> {
        answered(self.queue(sessions, make).await?).await
    }

    /// [`ask`](Self::ask) in two steps: resolves once the request is in the writer's channel, with the channel of the writer's
    /// answer (see [`answered`]). The writer takes requests in the order they were queued.
    pub(super) async fn queue(&self, sessions: &[&str], make: impl FnOnce(Ack) -> Command) -> Result<oneshot::Receiver<Result<(), DbError>>, DbError> {
        if !sessions.is_empty() {
            self.settled(Need::of(sessions)).await?;
        }
        self.send(make)
    }

    /// A writer request sent at once, whatever the recovery holds: one that concerns no session's rows, and the work the
    /// sensitive rewriter does on a session held for it (it is the one that makes the session ready, and never waits for
    /// that at the gate).
    pub(super) fn send(&self, make: impl FnOnce(Ack) -> Command) -> Result<oneshot::Receiver<Result<(), DbError>>, DbError> {
        let (ack, answer) = oneshot::channel();
        self.sender.send(make(ack)).map_err(|_| DbError::Stopped)?;
        Ok(answer)
    }

    /// The pool and the writer's channel, for the work the rewriter does itself on a session held for it.
    pub(super) fn private(&self) -> (Arc<ReadPool>, mpsc::Sender<Command>) {
        (self.pool.clone(), self.sender.clone())
    }

    /// The repairs' turn order, for the writer.
    pub(super) fn ranks(&self) -> Ranks {
        Ranks(self.recovery.clone())
    }

    /// The repairs end, the writer is told to stop at once and `join_writer` waits for it, then the pool closes. Not gated:
    /// a close ends the store whatever the repairs are doing.
    pub(super) fn close(&self, join_writer: impl FnOnce()) {
        self.recovery.close();
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
