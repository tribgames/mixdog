//! Lane executors: dedicated thread pools with a FIFO queue, and the thread-per-job lane. Lanes never share threads.
//!
//! An elastic lane (`max_threads` above `threads`) starts another worker when a job is queued and no worker is idle, up to
//! `max_threads`; a worker above the warm count ends once idle for `idle_after`. A job that finds every thread busy waits in the
//! lane's one FIFO order ([`Queue`]). The queue's far bound refuses only a plain submission, as overload protection; a
//! `submit_wait` job waits in the same order beyond it until a place frees.
//!
//! One lock per lane (`pending`) decides everything about its jobs: their order, admission, which thread takes which, health
//! and shutdown. What it decides is delivered after it is released ([`Answers`]).

use std::collections::HashMap;
use std::collections::HashSet;
use std::future::Future;
use std::io;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::mpsc;
use std::task::Context;
use std::task::Wake;
use std::task::Waker;
use std::time::Duration;
use std::time::Instant;

use tokio::sync::Notify;
use tokio_util::sync::WaitForCancellationFutureOwned;

use super::hist::HistSummary;
use super::hist::Histogram;
use super::priority::Priority;
use super::priority::set_current_thread;
use crate::JobRun;
use crate::LaneFull;
use crate::LaneKind;
use crate::QueuedJob;
use crate::lanes::Answer;
use crate::lanes::Entered;
use crate::lanes::NodeKey;
use crate::lanes::Ticket;
use crate::lanes::TicketEnd;

/// Applies an OS priority to the calling thread; a seam so tests can make it fail.
type ApplyPriority = fn(Priority) -> io::Result<()>;

/// Starts a thread-per-job lane's thread; a seam so tests can make it fail. The body names the
/// lane's startup handoff by key; it never owns the job, so a refused start loses nothing.
type SpawnThread = fn(std::thread::Builder, Box<dyn FnOnce() + Send>) -> io::Result<()>;

fn spawn_thread(builder: std::thread::Builder, body: Box<dyn FnOnce() + Send>) -> io::Result<()> {
    builder.spawn(body).map(drop)
}

/// The stack of every lane thread: Rust's default for spawned threads (2 MiB), the deepest jobs being serde decodes of session
/// documents on the CPU lanes.
pub(crate) const LANE_STACK: usize = 2 * 1024 * 1024;

/// Counters and histograms of one lane.
pub(crate) struct LaneStats {
    submitted: AtomicU64,
    rejected: AtomicU64,
    completed: AtomicU64,
    dropped_cancelled: AtomicU64,
    panicked: AtomicU64,
    /// Jobs dropped unrun because their thread could not take the lane's priority.
    priority_failed: AtomicU64,
    /// Notified when a thread slot frees up or the lane recovers a healthy worker (the unordered
    /// `submit_wait` fallback and tests wait on it).
    freed: Arc<Notify>,
    /// Threads currently alive on the lane. Changed only under the lane's `pending` lock.
    live: AtomicUsize,
    /// Of those, threads whose current job outlived the lane's lease. Changed only under `pending`.
    wedged: AtomicUsize,
    queue_wait: Histogram,
    service: Histogram,
}

impl LaneStats {
    fn new() -> Self {
        Self {
            submitted: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            dropped_cancelled: AtomicU64::new(0),
            panicked: AtomicU64::new(0),
            priority_failed: AtomicU64::new(0),
            freed: Arc::new(Notify::new()),
            live: AtomicUsize::new(0),
            wedged: AtomicUsize::new(0),
            queue_wait: Histogram::new(),
            service: Histogram::new(),
        }
    }
}

/// One lane's counters and latency histograms at one instant.
#[derive(Clone, Copy, Debug)]
pub struct LaneSnapshot {
    pub kind: LaneKind,
    /// Threads alive on the lane.
    pub threads: usize,
    /// Of those, threads stuck in a job that outlived the lane's lease. The lane refuses work
    /// while every thread is in this state.
    pub wedged: usize,
    /// Threads started above the warm count (elastic lanes); 0 for a fixed lane.
    pub grown: usize,
    /// Most threads the lane runs (healthy ones), or the live-job cap of the thread-per-job lane.
    pub max_threads: usize,
    /// Jobs inside the queue's far bound that no thread took yet, admitted or waiting.
    pub queue_depth: usize,
    /// Of those, `submit_wait` jobs not yet admitted: their callers wait.
    pub waiters: usize,
    /// `submit_wait` jobs waiting in the lane's order beyond the far bound; not in `queue_depth`.
    pub outside: usize,
    /// How long the oldest job no thread took yet has waited; zero when none waits.
    pub oldest_wait: Duration,
    /// Jobs a `submit_wait` caller lets ahead of its own before it is admitted (0: admitted when
    /// a thread takes it).
    pub room: usize,
    /// The queue's far bound, on every job inside it: where plain submissions answer overloaded.
    pub capacity: usize,
    pub submitted: u64,
    /// Submissions answered `LaneFull`.
    pub rejected: u64,
    pub completed: u64,
    pub dropped_cancelled: u64,
    pub panicked: u64,
    /// Jobs dropped unrun (their handle resolved `JobDropped`) because the thread could not
    /// take the lane's OS priority.
    pub priority_failed: u64,
    /// Time from enqueue to dequeue, every dequeued job.
    pub queue_wait: HistSummary,
    /// Time inside the job, completed jobs only.
    pub service: HistSummary,
}

enum Shape {
    /// `threads` warm workers, growing to `max_threads`, over one FIFO queue.
    Pooled(Arc<Watch>),
    /// One thread per job, at most `max_live` at once; the rest wait in a FIFO queue.
    PerJob(Arc<PerJobLane>),
}

/// How a submission enters a lane.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// `submit`: queued, the caller does not wait.
    Queue,
    /// `try_submit`: only when a thread takes it at once.
    Now,
    /// `submit_wait`: queued, the caller waits until it is admitted; beyond the far bound too.
    Wait,
}

pub(crate) struct LaneExec {
    kind: LaneKind,
    stats: Arc<LaneStats>,
    shape: Shape,
}

impl LaneExec {
    /// Starts `threads` workers (all up front) over a queue of `queue` jobs. Fails when a
    /// worker cannot take `priority`: a lane must never serve at the wrong priority unseen.
    #[allow(clippy::too_many_arguments, reason = "the lane's sizing, one value each")]
    pub(crate) fn pooled(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        max_threads: usize,
        room: usize,
        queue: usize,
        lease: Duration,
        idle_after: Duration,
        priority_failures: &Arc<AtomicU64>,
    ) -> io::Result<Self> {
        Self::elastic_with(kind, priority, threads, max_threads, room, queue, lease, idle_after, priority_failures, set_current_thread)
    }

    /// A fixed lane: `threads` workers, never more.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments, reason = "the lane's sizing, one value each")]
    fn pooled_with(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        room: usize,
        queue: usize,
        lease: Duration,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        Self::elastic_with(kind, priority, threads, threads, room, queue, lease, Duration::MAX, priority_failures, apply)
    }

    #[allow(clippy::too_many_arguments, reason = "the lane's sizing, one value each")]
    fn elastic_with(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        max_threads: usize,
        room: usize,
        queue: usize,
        lease: Duration,
        idle_after: Duration,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        if threads == 0 || room == 0 || queue < room || max_threads < threads {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "lane {} needs at least one thread, a room of at least one job within its far bound, and a cap of at least its warm threads",
                    kind.name()
                ),
            ));
        }
        let stats = Arc::new(LaneStats::new());
        let watch = Arc::new_cyclic(|me: &Weak<Watch>| {
            let owner: Weak<dyn Reclaim> = me.clone();
            Watch {
                kind,
                threads,
                max_threads,
                limit: max_threads + threads,
                lease,
                idle_after,
                pending: Mutex::new(Pending {
                    queue: Queue::new(room, queue, owner, stats.clone()),
                    idle: HashMap::new(),
                    retiring: HashSet::new(),
                    closed: false,
                }),
                available: Condvar::new(),
                stats: stats.clone(),
                priority,
                apply,
                failures: priority_failures.clone(),
                next_id: AtomicUsize::new(0),
                running: Mutex::new(HashMap::new()),
                stopped: Mutex::new(false),
                wake: Condvar::new(),
            }
        });
        // Returning early closes the queue, which ends every worker that did start.
        let closing = CloseOnError(Some(watch.clone()));
        let (ready_tx, ready_rx) = mpsc::channel();
        for _ in 0..threads {
            let _pending = lock(&watch.pending);
            watch.spawn_worker(Some(ready_tx.clone()))?;
        }
        drop(ready_tx);
        for _ in 0..threads {
            match ready_rx.recv() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    return Err(io::Error::new(e.kind(), format!("lane {}: setting {priority:?} priority failed: {e}", kind.name())));
                }
                Err(_) => {
                    return Err(io::Error::other(format!("lane {}: a worker exited before it was ready", kind.name())));
                }
            }
        }
        let dog = watch.clone();
        std::thread::Builder::new().name(format!("mixdog-{}-watchdog", kind.name())).stack_size(LANE_STACK).spawn(move || watchdog(&dog))?;
        closing.disarm();
        Ok(Self { kind, stats, shape: Shape::Pooled(watch) })
    }

    /// A lane whose every job owns a thread for its whole duration (blocking PTY reads),
    /// capped at `max_live` concurrent jobs; the rest wait in a FIFO queue of at most `queue`.
    pub(crate) fn per_job(kind: LaneKind, priority: Priority, max_live: usize, queue: usize, priority_failures: &Arc<AtomicU64>) -> io::Result<Self> {
        Self::per_job_with(kind, priority, max_live, queue, priority_failures, set_current_thread, spawn_thread)
    }

    fn per_job_with(
        kind: LaneKind,
        priority: Priority,
        max_live: usize,
        queue: usize,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
        spawn: SpawnThread,
    ) -> io::Result<Self> {
        if max_live == 0 || queue == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("lane {} needs a live-job cap and a queue of at least one", kind.name())));
        }
        let stats = Arc::new(LaneStats::new());
        let lane = Arc::new_cyclic(|me: &Weak<PerJobLane>| {
            let owner: Weak<dyn Reclaim> = me.clone();
            PerJobLane {
                kind,
                priority,
                apply,
                spawn,
                failures: priority_failures.clone(),
                max_live,
                stats: stats.clone(),
                pending: Mutex::new(PerJobPending {
                    queue: Queue::new(0, queue, owner, stats.clone()),
                    live: 0,
                    closed: false,
                    starting: HashMap::new(),
                    next_start: 0,
                }),
            }
        });
        Ok(Self { kind, stats, shape: Shape::PerJob(lane) })
    }

    pub(crate) fn kind(&self) -> LaneKind {
        self.kind
    }

    /// Notified whenever the lane frees a thread slot or recovers a healthy worker.
    pub(crate) fn freed(&self) -> Arc<Notify> {
        self.stats.freed.clone()
    }

    /// Queues `job` (FIFO); it waits there for a thread. Refused only when the queue holds its far
    /// bound, the lane has no healthy worker, or it shut down.
    pub(crate) fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        match self.admit(job, Mode::Queue) {
            Entered::Admitted | Entered::Waiting(_) => Ok(()),
            Entered::Refused(full) => Err(full),
            Entered::Wedged | Entered::ShutDown => Err(LaneFull { lane: self.kind }),
        }
    }

    /// [`Self::submit`] only when a thread takes the job now (an idle one, or one the lane may
    /// still start): never queues behind other work.
    pub(crate) fn try_submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        match self.admit(job, Mode::Now) {
            Entered::Admitted | Entered::Waiting(_) => Ok(()),
            Entered::Refused(full) => Err(full),
            Entered::Wedged | Entered::ShutDown => Err(LaneFull { lane: self.kind }),
        }
    }

    /// A `submit_wait` job, taken into the lane's order (beyond the far bound too) (see [`Entered`]).
    pub(crate) fn enter(&self, job: QueuedJob) -> Entered {
        self.admit(job, Mode::Wait)
    }

    /// Takes the job of `ticket` out unrun, admitted or not, unless a thread took it or it was
    /// answered first.
    pub(crate) fn withdraw(&self, ticket: &Ticket) -> bool {
        let mut answers = Answers::default();
        let withdrawn = match &self.shape {
            Shape::Pooled(watch) => lock(&watch.pending).queue.withdraw(ticket.key(), &mut answers),
            Shape::PerJob(lane) => lock(&lane.pending).queue.withdraw(ticket.key(), &mut answers),
        };
        drop(answers);
        withdrawn
    }

    fn admit(&self, job: QueuedJob, mode: Mode) -> Entered {
        let entered = match &self.shape {
            Shape::Pooled(watch) => watch.enqueue(job, mode),
            Shape::PerJob(lane) => lane.enqueue(job, mode),
        };
        let counter = match entered {
            Entered::Admitted | Entered::Waiting(_) => &self.stats.submitted,
            Entered::Refused(_) | Entered::Wedged | Entered::ShutDown => &self.stats.rejected,
        };
        counter.fetch_add(1, Relaxed);
        entered
    }

    /// `true` while no worker of the lane is healthy. The thread-per-job lane never is: its
    /// jobs own their threads for as long as the PTY lives.
    pub(crate) fn is_wedged(&self) -> bool {
        match &self.shape {
            Shape::Pooled(watch) => {
                let _pending = lock(&watch.pending);
                watch.healthy() == 0
            }
            Shape::PerJob(_) => false,
        }
    }

    /// One watchdog pass at `now`: marks workers whose job outlived the lease.
    pub(crate) fn sweep(&self, now: Instant) {
        if let Shape::Pooled(watch) = &self.shape {
            watch.sweep(now);
        }
    }

    pub(crate) fn snapshot(&self) -> LaneSnapshot {
        let live = self.stats.live.load(Relaxed);
        let (queue_depth, waiters, outside, oldest_wait, room, capacity, grown, max_threads) = match &self.shape {
            Shape::Pooled(watch) => {
                let pending = lock(&watch.pending);
                let queue = &pending.queue;
                (
                    queue.len(),
                    queue.waiters(),
                    queue.beyond,
                    queue.oldest_wait(),
                    queue.room,
                    queue.bound,
                    live.saturating_sub(watch.threads),
                    watch.max_threads,
                )
            }
            Shape::PerJob(lane) => {
                let pending = lock(&lane.pending);
                let queue = &pending.queue;
                (queue.len(), queue.waiters(), queue.beyond, queue.oldest_wait(), queue.room, queue.bound, 0, lane.max_live)
            }
        };
        LaneSnapshot {
            kind: self.kind,
            threads: live,
            wedged: self.stats.wedged.load(Relaxed),
            grown,
            max_threads,
            queue_depth,
            waiters,
            outside,
            oldest_wait,
            room,
            capacity,
            submitted: self.stats.submitted.load(Relaxed),
            rejected: self.stats.rejected.load(Relaxed),
            completed: self.stats.completed.load(Relaxed),
            dropped_cancelled: self.stats.dropped_cancelled.load(Relaxed),
            panicked: self.stats.panicked.load(Relaxed),
            priority_failed: self.stats.priority_failed.load(Relaxed),
            queue_wait: self.stats.queue_wait.summary(),
            service: self.stats.service.summary(),
        }
    }

    /// Closes the lane: what it holds is answered `ShutDown` (or `Cancelled`, for a job whose token
    /// was cancelled first) once the lock is released.
    fn close(&self) -> Answers {
        match &self.shape {
            Shape::Pooled(watch) => watch.close(),
            Shape::PerJob(lane) => lane.close(),
        }
    }

    /// The lane's shutdown, run without dropping it.
    #[cfg(test)]
    fn shut_down_now(&self) {
        drop(self.close());
    }

    /// Turns the nodes' token listeners off (or on again) for nodes queued from now on.
    #[cfg(test)]
    fn listening(&self, on: bool) {
        match &self.shape {
            Shape::Pooled(watch) => lock(&watch.pending).queue.listening = on,
            Shape::PerJob(lane) => lock(&lane.pending).queue.listening = on,
        }
    }

    #[cfg(test)]
    fn visits(&self) -> u64 {
        match &self.shape {
            Shape::Pooled(watch) => lock(&watch.pending).queue.visits,
            Shape::PerJob(lane) => lock(&lane.pending).queue.visits,
        }
    }

    #[cfg(test)]
    fn dispatched(&self) -> Vec<u64> {
        match &self.shape {
            Shape::Pooled(watch) => lock(&watch.pending).queue.dispatched.clone(),
            Shape::PerJob(lane) => lock(&lane.pending).queue.dispatched.clone(),
        }
    }
}

pub(crate) fn apply_priority(priority: Priority, failures: &AtomicU64) {
    if set_current_thread(priority).is_err() {
        failures.fetch_add(1, Relaxed);
    }
}

/// Shutdown: every job the lane holds is answered [`crate::JobDropped::ShutDown`] and every
/// waiting `submit_wait` caller `ShutDown`, none left pending; running jobs finish on their threads.
impl Drop for LaneExec {
    fn drop(&mut self) {
        drop(self.close());
    }
}

/// What a lane decided under its lock, delivered once the lock is released: jobs answered unrun, and tickets whose end
/// was decided. Declared before the guard of the lock, it is dropped (delivered) after it.
#[derive(Default)]
struct Answers {
    jobs: Vec<(QueuedJob, Answer)>,
    tickets: Vec<Ticket>,
}

impl Answers {
    fn job(&mut self, job: QueuedJob, answer: Answer) {
        self.jobs.push((job, answer));
    }

    fn settle(&mut self, ticket: Ticket, end: TicketEnd) {
        ticket.decide(end);
        self.tickets.push(ticket);
    }

    fn is_empty(&self) -> bool {
        self.jobs.is_empty() && self.tickets.is_empty()
    }
}

impl Drop for Answers {
    fn drop(&mut self) {
        for ticket in self.tickets.drain(..) {
            ticket.wake();
        }
        for (job, answer) in self.jobs.drain(..) {
            job.answer(answer);
        }
    }
}

/// `answer` for a job taken out unrun, unless its token was cancelled first: then it hears that.
fn unless_cancelled(job: &QueuedJob, answer: Answer) -> Answer {
    if job.is_cancelled() { Answer::Cancelled } else { answer }
}

/// Where a node lies in its lane's order: the admission window at the head (the first `room` jobs), the rest inside the
/// far bound, and the `submit_wait` jobs waiting beyond it. The three are contiguous, in that order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Zone {
    Window,
    Inside,
    Beyond,
}

struct Node {
    job: QueuedJob,
    /// The waiting caller, until its ticket's end is decided.
    ticket: Option<Ticket>,
    zone: Zone,
    prev: Option<u32>,
    next: Option<u32>,
    /// Listens to the job's token while the node is held: its cancellation takes the node out.
    listener: Option<Pin<Box<WaitForCancellationFutureOwned>>>,
    #[cfg(test)]
    seq: u64,
}

struct Slot {
    generation: u32,
    node: Option<Node>,
}

/// A lane's one FIFO order: every job it holds, `submit` and `submit_wait` alike, in arrival order (a job arrives when the
/// lane takes it under its lock); threads take jobs from the head only. The first `room` jobs are admitted; a `submit_wait`
/// job behind them carries a [`Ticket`] decided `Admitted` when it comes within `room` of the head (with `room` 0, when a
/// thread takes it). At most `bound` jobs lie inside the far bound; `submit_wait` jobs beyond it wait in the same order, and
/// each place that frees inside brings the oldest of them in, in the same critical section, before any later submission.
///
/// The order is a doubly linked list over a slab of slots; a [`NodeKey`] names a node by slot and generation, so a stale
/// key never touches the slot's next occupant. Appending, taking the head, moving a boundary by one and unlinking by key
/// are constant work; a cancelled job met at a boundary is taken out once.
struct Queue {
    slots: Vec<Slot>,
    free: Vec<u32>,
    head: Option<u32>,
    tail: Option<u32>,
    first_inside: Option<u32>,
    first_beyond: Option<u32>,
    window: usize,
    inside: usize,
    beyond: usize,
    room: usize,
    bound: usize,
    owner: Weak<dyn Reclaim>,
    stats: Arc<LaneStats>,
    /// Whether nodes listen to their tokens; a test turns it off to reach the decisions' own token checks.
    listening: bool,
    /// Nodes the queue's operations touched, for tests that bound the work done under the lock.
    #[cfg(test)]
    visits: u64,
    #[cfg(test)]
    next_seq: u64,
    /// The arrival number of each job given to a thread, in order.
    #[cfg(test)]
    dispatched: Vec<u64>,
}

impl Queue {
    fn new(room: usize, bound: usize, owner: Weak<dyn Reclaim>, stats: Arc<LaneStats>) -> Self {
        Self {
            slots: Vec::new(),
            free: Vec::new(),
            head: None,
            tail: None,
            first_inside: None,
            first_beyond: None,
            window: 0,
            inside: 0,
            beyond: 0,
            room,
            bound,
            owner,
            stats,
            listening: true,
            #[cfg(test)]
            visits: 0,
            #[cfg(test)]
            next_seq: 0,
            #[cfg(test)]
            dispatched: Vec::new(),
        }
    }

    /// Jobs inside the far bound.
    fn len(&self) -> usize {
        self.window + self.inside
    }

    fn waiters(&self) -> usize {
        let mut waiters = 0;
        let mut at = self.first_inside;
        while let Some(index) = at.filter(|&index| self.node(index).zone == Zone::Inside) {
            waiters += usize::from(self.node(index).ticket.is_some());
            at = self.node(index).next;
        }
        waiters
    }

    fn oldest_wait(&self) -> Duration {
        self.head.map_or(Duration::ZERO, |head| self.node(head).job.enqueued_at().elapsed())
    }

    fn node(&self, index: u32) -> &Node {
        self.slots[index as usize].node.as_ref().expect("a linked node")
    }

    fn node_mut(&mut self, index: u32) -> &mut Node {
        self.slots[index as usize].node.as_mut().expect("a linked node")
    }

    fn in_zone(&self, index: Option<u32>, zone: Zone) -> Option<u32> {
        index.filter(|&index| self.node(index).zone == zone)
    }

    fn holds(&self, key: NodeKey) -> bool {
        self.slots.get(key.index as usize).is_some_and(|slot| slot.generation == key.generation && slot.node.is_some())
    }

    fn visit(&mut self) {
        #[cfg(test)]
        {
            self.visits += 1;
        }
    }

    /// Appends `job` at the tail; a `waiting` (`submit_wait`) job gets a ticket unless it is
    /// admitted at once, and waits beyond the far bound when the queue holds it. A plain job that
    /// finds the queue at its bound is handed back. A job whose token is already cancelled is
    /// answered so (into `answers`) at once.
    fn push(&mut self, job: QueuedJob, waiting: bool, answers: &mut Answers) -> Result<Option<Ticket>, QueuedJob> {
        let inside = self.beyond == 0 && self.len() < self.bound;
        if !inside && !waiting {
            return Err(job);
        }
        let zone = if !inside {
            Zone::Beyond
        } else if self.window < self.room {
            Zone::Window
        } else {
            Zone::Inside
        };
        let index = self.free.pop().unwrap_or_else(|| {
            self.slots.push(Slot { generation: 0, node: None });
            u32::try_from(self.slots.len() - 1).expect("fewer queued jobs than u32::MAX")
        });
        let key = NodeKey { index, generation: self.slots[index as usize].generation };
        let ticket = (waiting && zone != Zone::Window).then(|| Ticket::new(key));
        let listener = self.listening.then(|| Box::pin(job.token().cancelled_owned()));
        #[cfg(test)]
        let seq = {
            self.next_seq += 1;
            self.next_seq
        };
        self.visit();
        self.slots[index as usize].node = Some(Node {
            job,
            ticket: ticket.clone(),
            zone,
            prev: self.tail,
            next: None,
            listener,
            #[cfg(test)]
            seq,
        });
        match self.tail {
            Some(tail) => self.node_mut(tail).next = Some(index),
            None => self.head = Some(index),
        }
        self.tail = Some(index);
        match zone {
            Zone::Window => self.window += 1,
            Zone::Inside => {
                self.inside += 1;
                self.first_inside.get_or_insert(index);
            }
            Zone::Beyond => {
                self.beyond += 1;
                self.first_beyond.get_or_insert(index);
            }
        }
        if !self.listen(key) {
            self.withdraw(key, answers);
        }
        Ok(ticket)
    }

    /// Arms the node's token listener; `false` when the token is already cancelled.
    fn listen(&mut self, key: NodeKey) -> bool {
        let waker = Waker::from(Arc::new(Listener { owner: self.owner.clone(), key }));
        match self.node_mut(key.index).listener.as_mut() {
            Some(listener) => listener.as_mut().poll(&mut Context::from_waker(&waker)).is_pending(),
            None => true,
        }
    }

    /// Unlinks node `index`; the boundary cursors follow. The caller repairs the boundaries when
    /// the node lay inside the far bound.
    fn remove(&mut self, index: u32) -> Node {
        self.visit();
        let slot = &mut self.slots[index as usize];
        let node = slot.node.take().expect("a linked node");
        slot.generation = slot.generation.wrapping_add(1);
        self.free.push(index);
        match node.prev {
            Some(prev) => self.node_mut(prev).next = node.next,
            None => self.head = node.next,
        }
        match node.next {
            Some(next) => self.node_mut(next).prev = node.prev,
            None => self.tail = node.prev,
        }
        match node.zone {
            Zone::Window => self.window -= 1,
            Zone::Inside => {
                self.inside -= 1;
                if self.first_inside == Some(index) {
                    self.first_inside = self.in_zone(node.next, Zone::Inside);
                }
            }
            Zone::Beyond => {
                self.beyond -= 1;
                if self.first_beyond == Some(index) {
                    self.first_beyond = node.next;
                }
            }
        }
        node
    }

    /// Fills the places inside the far bound from beyond it, oldest first, then the admission
    /// window from inside; a cancelled job met at either boundary is taken out and answered so.
    fn repair(&mut self, answers: &mut Answers) {
        loop {
            if self.len() < self.bound
                && let Some(first) = self.first_beyond
            {
                self.visit();
                if self.node(first).job.is_cancelled() {
                    let node = self.remove(first);
                    unrun(&self.stats, node, TicketEnd::Withdrawn, Answer::Cancelled, answers);
                    continue;
                }
                // The first job beyond lies right after the last one inside: it changes zone in place.
                let next = self.node(first).next;
                self.node_mut(first).zone = Zone::Inside;
                self.beyond -= 1;
                self.inside += 1;
                self.first_beyond = next;
                self.first_inside.get_or_insert(first);
                continue;
            }
            if self.window < self.room
                && let Some(first) = self.first_inside
            {
                self.visit();
                if self.node(first).job.is_cancelled() {
                    let node = self.remove(first);
                    unrun(&self.stats, node, TicketEnd::Withdrawn, Answer::Cancelled, answers);
                    continue;
                }
                let next = self.node(first).next;
                let node = self.node_mut(first);
                node.zone = Zone::Window;
                let ticket = node.ticket.take();
                self.inside -= 1;
                self.window += 1;
                self.first_inside = self.in_zone(next, Zone::Inside);
                if let Some(ticket) = ticket {
                    answers.settle(ticket, TicketEnd::Admitted);
                }
                continue;
            }
            return;
        }
    }

    /// The oldest live job for a thread; a waiter is admitted as a thread takes it. A job whose
    /// token was cancelled is answered so instead, never given to a thread.
    fn pop(&mut self, answers: &mut Answers) -> Option<QueuedJob> {
        while let Some(head) = self.head {
            let node = self.remove(head);
            self.repair(answers);
            if node.job.is_cancelled() {
                unrun(&self.stats, node, TicketEnd::Withdrawn, Answer::Cancelled, answers);
                continue;
            }
            #[cfg(test)]
            self.dispatched.push(node.seq);
            if let Some(ticket) = node.ticket {
                answers.settle(ticket, TicketEnd::Admitted);
            }
            return Some(node.job);
        }
        None
    }

    /// Takes the job of `key` out unrun, wherever it lies, and answers it cancelled; `false` when the queue no longer
    /// holds it.
    fn withdraw(&mut self, key: NodeKey, answers: &mut Answers) -> bool {
        if !self.holds(key) {
            return false;
        }
        let node = self.remove(key.index);
        if node.zone != Zone::Beyond {
            self.repair(answers);
        }
        unrun(&self.stats, node, TicketEnd::Withdrawn, Answer::Cancelled, answers);
        true
    }

    /// The listener of `key` saw its token cancelled: the job is taken out, if still held.
    fn reclaim(&mut self, key: NodeKey, answers: &mut Answers) {
        if self.holds(key) && self.node(key.index).job.is_cancelled() {
            self.withdraw(key, answers);
        }
    }

    /// Empties the order: each job is answered `answer` and its waiting ticket ends `end`, or both
    /// cancellation for a job whose token was cancelled first.
    fn take_all(&mut self, end: TicketEnd, answer: Answer, answers: &mut Answers) {
        while let Some(head) = self.head {
            let node = self.remove(head);
            unrun(&self.stats, node, end, answer, answers);
        }
    }
}

/// Answers a node taken out unrun with `end` and `answer`, or with cancellation if its token was cancelled first (counted
/// here, before its handle hears). The ticket of an admitted job was decided already; only its handle hears why.
fn unrun(stats: &LaneStats, node: Node, end: TicketEnd, answer: Answer, answers: &mut Answers) {
    let Node { job, ticket, .. } = node;
    let (end, answer) = if job.is_cancelled() {
        stats.dropped_cancelled.fetch_add(1, Relaxed);
        (TicketEnd::Withdrawn, Answer::Cancelled)
    } else {
        (end, answer)
    };
    if let Some(ticket) = ticket {
        answers.settle(ticket, end);
    }
    answers.job(job, answer);
}

/// A lane that takes out a node whose token was cancelled ([`Queue::listen`]).
trait Reclaim: Send + Sync {
    fn reclaim(&self, key: NodeKey);
}

/// The waker of a node's token listener. A token wakes its listeners after releasing its own locks, on the cancelling
/// thread, which holds no lane lock: the lane takes the node out there, under its lock, with no poll or free capacity
/// needed.
struct Listener {
    owner: Weak<dyn Reclaim>,
    key: NodeKey,
}

impl Wake for Listener {
    fn wake(self: Arc<Self>) {
        if let Some(owner) = self.owner.upgrade() {
            owner.reclaim(self.key);
        }
    }
}

/// The thread-per-job lane: each job owns a thread for its whole duration, at most `max_live`
/// at once; a thread that ends its job takes the next queued one.
struct PerJobLane {
    kind: LaneKind,
    priority: Priority,
    apply: ApplyPriority,
    spawn: SpawnThread,
    failures: Arc<AtomicU64>,
    max_live: usize,
    stats: Arc<LaneStats>,
    pending: Mutex<PerJobPending>,
}

struct PerJobPending {
    queue: Queue,
    /// Threads alive or being started; counted here, under the queue's lock, so the cap is
    /// decided in one place.
    live: usize,
    closed: bool,
    /// The job each start was given, until its thread takes it (or close or a failed start
    /// answers it).
    starting: HashMap<u64, QueuedJob>,
    next_start: u64,
}

impl PerJobLane {
    fn enqueue(self: &Arc<Self>, job: QueuedJob, mode: Mode) -> Entered {
        let mut answers = Answers::default();
        let mut refused = None;
        let mut pending = lock(&self.pending);
        if pending.closed {
            drop(pending);
            job.answer(Answer::ShutDown);
            return Entered::ShutDown;
        }
        let at_once = pending.live < self.max_live && pending.queue.len() == 0;
        let entered = if mode == Mode::Now && !at_once {
            refused = Some(job);
            Entered::Refused(LaneFull { lane: self.kind })
        } else {
            match pending.queue.push(job, mode == Mode::Wait, &mut answers) {
                Ok(ticket) => ticket.map_or(Entered::Admitted, Entered::Waiting),
                Err(job) => {
                    refused = Some(job);
                    Entered::Refused(LaneFull { lane: self.kind })
                }
            }
        };
        let starts = self.dispatch(&mut pending, &mut answers);
        drop(pending);
        drop(answers);
        drop(refused);
        for start in starts {
            self.start(start);
        }
        entered
    }

    /// Gives the oldest live jobs to new threads while the cap allows: each start's slot is counted
    /// and its job held in its handoff, under the lock; the threads are started after it.
    fn dispatch(&self, pending: &mut PerJobPending, answers: &mut Answers) -> Vec<u64> {
        let mut starts = Vec::new();
        while pending.live < self.max_live
            && let Some(job) = pending.queue.pop(answers)
        {
            let start = pending.next_start;
            pending.next_start += 1;
            pending.starting.insert(start, job);
            pending.live += 1;
            self.stats.live.fetch_add(1, Relaxed);
            starts.push(start);
        }
        starts
    }

    /// Starts the thread of handoff `start`; it runs that job, then serves the queue until it is empty.
    fn start(self: &Arc<Self>, start: u64) {
        let lane = self.clone();
        let builder = std::thread::Builder::new().name(format!("mixdog-{}", self.kind.name())).stack_size(LANE_STACK);
        if (self.spawn)(builder, Box::new(move || lane.serve(start))).is_err() {
            self.start_failed(start);
        }
    }

    /// The OS refused the thread of `start`. With no other thread alive or starting, nothing would serve the queue: the
    /// start's job and everything queued are answered that the lane has no healthy worker. Otherwise only the start's job is
    /// answered (it was the oldest), and the other threads serve the rest.
    fn start_failed(&self, start: u64) {
        let mut answers = Answers::default();
        let mut pending = lock(&self.pending);
        let job = pending.starting.remove(&start);
        self.end_thread(&mut pending);
        if pending.live == 0 {
            if let Some(job) = job {
                let answer = unless_cancelled(&job, Answer::Wedged);
                answers.job(job, answer);
            }
            pending.queue.take_all(TicketEnd::Wedged, Answer::Wedged, &mut answers);
        } else if let Some(job) = job {
            let answer = unless_cancelled(&job, Answer::NotStarted);
            answers.job(job, answer);
        }
        drop(pending);
        drop(answers);
        self.stats.freed.notify_waiters();
    }

    /// The body of the thread of `start`: takes its handoff (close may have answered it already), runs it, then the
    /// oldest queued job after each, until the queue is empty.
    fn serve(self: &Arc<Self>, start: u64) {
        let job = lock(&self.pending).starting.remove(&start);
        if (self.apply)(self.priority).is_err() {
            // The job is dropped unrun, so its handle resolves `JobDropped::Dropped`; the slot goes to a thread of the next
            // job's own.
            self.failures.fetch_add(1, Relaxed);
            self.stats.priority_failed.fetch_add(1, Relaxed);
            drop(job);
            let mut answers = Answers::default();
            let mut pending = lock(&self.pending);
            self.end_thread(&mut pending);
            let starts = self.dispatch(&mut pending, &mut answers);
            drop(pending);
            drop(answers);
            for start in starts {
                self.start(start);
            }
            return;
        }
        let mut next = job;
        loop {
            if let Some(job) = next.take() {
                run_job(&self.stats, job);
            }
            next = self.next();
            if next.is_none() {
                return;
            }
        }
    }

    /// The next queued job for a thread that ended its own, or `None` once the queue is empty
    /// (the thread's slot is then released).
    fn next(&self) -> Option<QueuedJob> {
        let mut answers = Answers::default();
        let mut pending = lock(&self.pending);
        if let Some(job) = pending.queue.pop(&mut answers) {
            return Some(job);
        }
        self.end_thread(&mut pending);
        drop(pending);
        drop(answers);
        self.stats.freed.notify_waiters();
        None
    }

    fn end_thread(&self, pending: &mut PerJobPending) {
        pending.live -= 1;
        self.stats.live.fetch_sub(1, Relaxed);
    }

    fn close(&self) -> Answers {
        let mut answers = Answers::default();
        let mut pending = lock(&self.pending);
        pending.closed = true;
        for (_, job) in pending.starting.drain() {
            let answer = unless_cancelled(&job, Answer::ShutDown);
            answers.job(job, answer);
        }
        pending.queue.take_all(TicketEnd::ShutDown, Answer::ShutDown, &mut answers);
        drop(pending);
        answers
    }
}

impl Reclaim for PerJobLane {
    fn reclaim(&self, key: NodeKey) {
        let mut answers = Answers::default();
        lock(&self.pending).queue.reclaim(key, &mut answers);
        drop(answers);
    }
}

/// Closes a lane that failed to start, unless disarmed.
struct CloseOnError(Option<Arc<Watch>>);

impl CloseOnError {
    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for CloseOnError {
    fn drop(&mut self) {
        if let Some(watch) = self.0.take() {
            drop(watch.close());
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

thread_local! {
    /// Progress counter of the job running on this lane thread, if any.
    static PROGRESS: std::cell::RefCell<Option<Arc<AtomicU64>>> = const { std::cell::RefCell::new(None) };
}

/// A running lane job reports that it is still advancing, which restarts its lease. Long jobs
/// (walks, deletes, censuses) call this once per item; it is a no-op outside a pooled-lane job.
pub fn job_progress() {
    PROGRESS.with_borrow(|progress| {
        if let Some(progress) = progress {
            progress.fetch_add(1, Relaxed);
        }
    });
}

/// The job lease of one pooled lane. The watchdog marks a worker `wedged` once its job has gone `lease` without [`job_progress`]
/// and starts a replacement worker while the lane has fewer than `limit` threads. The wedged job is never abandoned: it keeps
/// running and its handle resolves when it ends, because its effect may still happen. A lane with no healthy worker refuses work
/// and answers what it holds (never run), in the same decision under `pending` that saw the last healthy worker go. A wedged
/// worker that returns rejoins as healthy, or exits when the lane already has `threads` healthy workers.
struct Watch {
    kind: LaneKind,
    /// Warm workers, started at boot and never ended for idleness.
    threads: usize,
    /// Most healthy workers: `threads` for a fixed lane.
    max_threads: usize,
    /// Most threads alive, wedged ones included: `max_threads + threads`. Only
    /// [`Watch::start_worker`] starts a thread past boot, under the queue's lock.
    limit: usize,
    lease: Duration,
    /// How long a worker above the warm count may stay idle.
    idle_after: Duration,
    pending: Mutex<Pending>,
    /// Signalled when a job is queued, a worker is told to end, or the lane closes.
    available: Condvar,
    stats: Arc<LaneStats>,
    priority: Priority,
    apply: ApplyPriority,
    failures: Arc<AtomicU64>,
    next_id: AtomicUsize,
    running: Mutex<HashMap<usize, Running>>,
    stopped: Mutex<bool>,
    wake: Condvar,
}

/// The queue of a pooled lane and its idle workers.
struct Pending {
    queue: Queue,
    /// Idle workers and when each became idle.
    idle: HashMap<usize, Instant>,
    /// Idle workers above the warm count told to end.
    retiring: HashSet<usize>,
    /// The lane was dropped: workers end once the queue is empty.
    closed: bool,
}

struct Running {
    /// Bumped by [`job_progress`].
    progress: Arc<AtomicU64>,
    /// `progress` as the last sweep saw it, and the time of the sweep that first saw it.
    seen: u64,
    since: Instant,
    wedged: bool,
}

impl Watch {
    /// Read under `pending`, where every change to the counts is made.
    fn healthy(&self) -> usize {
        self.stats.live.load(Relaxed).saturating_sub(self.stats.wedged.load(Relaxed))
    }

    /// Starts one worker past boot under the queue's lock (`_pending`), so no two starts take the last slot. `grow`: a worker for
    /// waiting work; otherwise a replacement for a wedged one. The lane never holds more than `limit` threads.
    fn start_worker(self: &Arc<Self>, _pending: &MutexGuard<'_, Pending>, grow: bool) -> bool {
        if self.stats.live.load(Relaxed) >= self.limit || (grow && self.healthy() >= self.max_threads) {
            return false;
        }
        self.spawn_worker(None).is_ok()
    }

    /// Starts one worker (called with the queue's lock held). `ready` reports the priority result
    /// of a lane's first workers.
    fn spawn_worker(self: &Arc<Self>, ready: Option<mpsc::Sender<io::Result<()>>>) -> io::Result<()> {
        let id = self.next_id.fetch_add(1, Relaxed);
        self.stats.live.fetch_add(1, Relaxed);
        let watch = self.clone();
        std::thread::Builder::new()
            .name(format!("mixdog-{}-{id}", self.kind.name()))
            .stack_size(LANE_STACK)
            .spawn(move || worker(&watch, id, ready.as_ref()))
            .map(drop)
            .inspect_err(|_| {
                self.stats.live.fetch_sub(1, Relaxed);
            })
    }

    /// With no healthy worker left (and none started), nothing will run what the lane holds: it is answered `Wedged` in the
    /// decision that saw the last one go. Called under `pending` wherever the lane can lose one.
    fn wedge_if_unhealthy(&self, pending: &mut Pending, answers: &mut Answers) {
        if !pending.closed && self.healthy() == 0 {
            pending.queue.take_all(TicketEnd::Wedged, Answer::Wedged, answers);
        }
    }

    fn begin(&self, id: usize) {
        let progress = Arc::new(AtomicU64::new(0));
        PROGRESS.set(Some(progress.clone()));
        lock(&self.running).insert(id, Running { progress, seen: 0, since: Instant::now(), wedged: false });
    }

    /// The worker's job returned. `true` when the worker is surplus and must exit.
    fn end(&self, id: usize) -> bool {
        PROGRESS.set(None);
        let mut running = lock(&self.running);
        let Some(entry) = running.remove(&id) else {
            return false;
        };
        if !entry.wedged {
            return false;
        }
        // Lock order: `running`, then `pending` (nothing takes them the other way).
        let pending = lock(&self.pending);
        let wedged = self.stats.wedged.fetch_sub(1, Relaxed) - 1;
        let surplus = self.stats.live.load(Relaxed) - wedged > self.max_threads;
        if surplus {
            self.stats.live.fetch_sub(1, Relaxed);
        }
        drop(pending);
        drop(running);
        // The lane may accept work again.
        self.stats.freed.notify_waiters();
        surplus
    }

    fn sweep(self: &Arc<Self>, now: Instant) {
        let mut answers = Answers::default();
        let mut running = lock(&self.running);
        let mut tripped = 0;
        for entry in running.values_mut() {
            let progress = entry.progress.load(Relaxed);
            if progress != entry.seen {
                entry.seen = progress;
                entry.since = now;
            }
            if entry.wedged || now.saturating_duration_since(entry.since) < self.lease {
                continue;
            }
            entry.wedged = true;
            tripped += 1;
        }
        if tripped > 0 {
            // Lock order: `running`, then `pending` (nothing takes them the other way).
            let mut pending = lock(&self.pending);
            for _ in 0..tripped {
                // Started before the wedge is counted. A failed start leaves the lane short of workers, which `healthy`
                // then reports.
                let _ = self.start_worker(&pending, false);
                self.stats.wedged.fetch_add(1, Relaxed);
            }
            self.wedge_if_unhealthy(&mut pending, &mut answers);
        }
        drop(running);
        drop(answers);
        if tripped > 0 {
            // Parked fallback `submit_wait` callers re-check the lane.
            self.stats.freed.notify_waiters();
        }
        self.retire_idle(now);
    }

    /// Tells the workers above the warm count that have been idle for `idle_after` at `now` to end.
    fn retire_idle(&self, now: Instant) {
        let mut pending = lock(&self.pending);
        let surplus = self.healthy().saturating_sub(self.threads + pending.retiring.len());
        let expired: Vec<usize> = pending
            .idle
            .iter()
            .filter(|(id, since)| !pending.retiring.contains(*id) && now.saturating_duration_since(**since) >= self.idle_after)
            .map(|(id, _)| *id)
            .take(surplus)
            .collect();
        if expired.is_empty() {
            return;
        }
        pending.retiring.extend(expired);
        drop(pending);
        self.available.notify_all();
    }

    /// Takes `job` at the tail, starting a worker when none is idle and the lane may grow. In
    /// [`Mode::Now`], refuses unless a worker takes it at once. Health is decided here, under the
    /// lock: a lane with no healthy worker answers `Wedged`.
    fn enqueue(self: &Arc<Self>, job: QueuedJob, mode: Mode) -> Entered {
        let refused = Entered::Refused(LaneFull { lane: self.kind });
        let mut answers = Answers::default();
        let mut unqueued = None;
        let mut pending = lock(&self.pending);
        if pending.closed {
            drop(pending);
            job.answer(Answer::ShutDown);
            return Entered::ShutDown;
        }
        if self.healthy() == 0 {
            drop(pending);
            drop(job);
            return Entered::Wedged;
        }
        let idle = pending.idle.len().saturating_sub(pending.retiring.len());
        let wants_thread = pending.queue.len() + 1 > idle;
        let entered = if mode == Mode::Now && wants_thread && (self.stats.live.load(Relaxed) >= self.limit || self.healthy() >= self.max_threads) {
            unqueued = Some(job);
            refused
        } else {
            match pending.queue.push(job, mode == Mode::Wait, &mut answers) {
                Ok(ticket) => {
                    if wants_thread {
                        // A failed start leaves the job queued for the workers there are.
                        let _ = self.start_worker(&pending, true);
                    }
                    ticket.map_or(Entered::Admitted, Entered::Waiting)
                }
                Err(job) => {
                    unqueued = Some(job);
                    refused
                }
            }
        };
        drop(pending);
        drop(answers);
        drop(unqueued);
        self.available.notify_one();
        entered
    }

    /// The lane was dropped: idle workers end, busy ones once their job returns. What it holds is
    /// handed back for the caller to answer after the lock.
    fn close(&self) -> Answers {
        let mut answers = Answers::default();
        {
            let mut pending = lock(&self.pending);
            pending.closed = true;
            pending.queue.take_all(TicketEnd::ShutDown, Answer::ShutDown, &mut answers);
        }
        self.available.notify_all();
        *lock(&self.stopped) = true;
        self.wake.notify_all();
        answers
    }

    /// The next job for worker `id`, or `None` when it is to end (idle above the warm count past
    /// `idle_after`, or the lane closed with nothing queued); its slot is released then.
    fn next_job(&self, id: usize) -> Option<QueuedJob> {
        let mut answers = Answers::default();
        let mut pending = lock(&self.pending);
        loop {
            if let Some(job) = pending.queue.pop(&mut answers) {
                pending.idle.remove(&id);
                pending.retiring.remove(&id);
                return Some(job);
            }
            if pending.retiring.remove(&id) || pending.closed {
                pending.idle.remove(&id);
                self.stats.live.fetch_sub(1, Relaxed);
                return None;
            }
            if !answers.is_empty() {
                // Cancelled jobs met at the head are answered before the worker sleeps.
                drop(pending);
                drop(std::mem::take(&mut answers));
                pending = lock(&self.pending);
                continue;
            }
            pending.idle.entry(id).or_insert_with(Instant::now);
            pending = self.available.wait(pending).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

impl Reclaim for Watch {
    fn reclaim(&self, key: NodeKey) {
        let mut answers = Answers::default();
        lock(&self.pending).queue.reclaim(key, &mut answers);
        drop(answers);
    }
}

fn worker(watch: &Arc<Watch>, id: usize, ready: Option<&mpsc::Sender<io::Result<()>>>) {
    if let Err(e) = (watch.apply)(watch.priority) {
        watch.failures.fetch_add(1, Relaxed);
        match ready {
            Some(ready) => {
                let _ = ready.send(Err(e));
            }
            // A worker started past boot that cannot take the priority never serves: if it was the lane's last hope, the
            // lane has no healthy worker now.
            None => {
                let mut answers = Answers::default();
                let mut pending = lock(&watch.pending);
                watch.stats.live.fetch_sub(1, Relaxed);
                watch.wedge_if_unhealthy(&mut pending, &mut answers);
                drop(pending);
                drop(answers);
            }
        }
        return;
    }
    if let Some(ready) = ready {
        let _ = ready.send(Ok(()));
    }
    while let Some(job) = watch.next_job(id) {
        watch.begin(id);
        run_job(&watch.stats, job);
        if watch.end(id) {
            return;
        }
    }
    watch.stats.freed.notify_waiters();
}

/// The lane's watchdog thread: one sweep every quarter lease (every half idle time on an elastic
/// lane, whichever is shorter) until the lane is dropped.
fn watchdog(watch: &Arc<Watch>) {
    let tick = (watch.lease / 4).min(watch.idle_after / 2).max(Duration::from_millis(1));
    loop {
        let (stopped, _) = watch.wake.wait_timeout_while(lock(&watch.stopped), tick, |stopped| !*stopped).unwrap_or_else(PoisonError::into_inner);
        if *stopped {
            return;
        }
        drop(stopped);
        watch.sweep(Instant::now());
    }
}

/// A tool call's lane job that waited this long in its queue is logged once ([`slow_wait_line`]) into the daemon's log. Healthy
/// waits stay far below it; a call stuck behind unrelated long work always crosses it.
pub(crate) const SLOW_WAIT: Duration = Duration::from_millis(250);

/// The line of a tool call's job that waited past [`SLOW_WAIT`]: the tool, the lane, the wait
/// and the time the job then ran.
pub(crate) fn slow_wait_line(tool: &str, lane: LaneKind, waited: Duration, ran: Duration) -> String {
    format!("[lane-wait] tool={tool} lane={} waited={}ms ran={}ms", lane.name(), waited.as_millis(), ran.as_millis())
}

/// Runs one dequeued job. A cancelled job is answered cancelled unrun (RL §7.1). A panicking job, in a program that unwinds
/// (the relay's `release-relay` profile, the tests), resolves its handle with `JobDropped` and leaves the thread serving the
/// next one; in `mixdogd` (`panic = "abort"`, or [`crate::abort_on_panic`] in a build that unwinds) it ends the process.
fn run_job(stats: &LaneStats, job: QueuedJob) {
    let waited = job.enqueued_at().elapsed();
    stats.queue_wait.record(waited);
    let slow = if waited >= SLOW_WAIT { job.tool().map(|tool| (tool, job.lane())) } else { None };
    let started = Instant::now();
    // Counted before the job is answered: the answer resolves its handle, and whoever awaited it reads the count.
    let cancelled = job.is_cancelled();
    if cancelled {
        stats.dropped_cancelled.fetch_add(1, Relaxed);
    }
    let outcome = catch_unwind(AssertUnwindSafe(move || job.run()));
    if let Some((tool, lane)) = slow {
        crate::node_stderr!("{}", slow_wait_line(tool, lane, waited, started.elapsed()));
    }
    match outcome {
        Ok(JobRun::Completed) => {
            stats.service.record(started.elapsed());
            stats.completed.fetch_add(1, Relaxed);
        }
        // Cancelled between the check above and the run.
        Ok(JobRun::DroppedCancelled) if !cancelled => {
            stats.dropped_cancelled.fetch_add(1, Relaxed);
        }
        Ok(JobRun::DroppedCancelled) => {}
        Err(_) => {
            stats.panicked.fetch_add(1, Relaxed);
        }
    }
}

#[cfg(test)]
mod tests;
