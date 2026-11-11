//! Lane executors: dedicated thread pools with a FIFO queue, and the thread-per-job lane
//! (RL §7.1). Lanes never share threads.
//!
//! A pooled lane keeps `threads` workers warm. An elastic lane (`max_threads` above `threads`,
//! the IO lanes: a thread blocked on a file or pipe uses no processor) starts another worker
//! when a job is queued and no worker is idle, up to `max_threads`; a worker above the warm count
//! ends once idle for `idle_after` (seen by the watchdog's pass). A job that finds every thread
//! busy waits in the lane's one FIFO queue ([`Queue`]), in arrival order; only the queue's far
//! bound refuses, as overload protection.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::io;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::mpsc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;
use std::time::Instant;

use tokio::sync::Notify;

use super::hist::HistSummary;
use super::hist::Histogram;
use super::priority::Priority;
use super::priority::set_current_thread;
use crate::JobRun;
use crate::LaneFull;
use crate::LaneKind;
use crate::QueuedJob;
use crate::lanes::Entered;
use crate::lanes::Ticket;
use crate::lanes::TicketEnd;

/// Applies an OS priority to the calling thread; a seam so tests can make it fail.
type ApplyPriority = fn(Priority) -> io::Result<()>;

/// The stack of every lane thread, set explicitly rather than left to the platform: Rust's
/// default for spawned threads (2 MiB), which every lane job has run on so far (the deepest are
/// serde decodes of session documents on the CPU lanes). It is reserved address space, committed
/// only as touched, so the caps in `exec.rs` cost 2 MiB of reservation per thread at most.
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
    /// Wakes `submit_wait` callers when a queue slot or a thread slot frees up.
    freed: Arc<Notify>,
    /// Threads currently alive on the lane.
    live: AtomicUsize,
    /// Of those, threads whose current job outlived the lane's lease.
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
    /// Jobs in the queue waiting for a thread, admitted or not.
    pub queue_depth: usize,
    /// Of those, `submit_wait` jobs not yet admitted: their callers wait.
    pub waiters: usize,
    /// Jobs a `submit_wait` caller lets ahead of its own before it is admitted (0: admitted when
    /// a thread takes it).
    pub room: usize,
    /// The queue's far bound, on every job it holds: where submissions answer overloaded.
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
    /// `submit_wait`: queued, the caller waits until it is admitted.
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
        let watch = Arc::new(Watch {
            kind,
            threads,
            max_threads,
            limit: max_threads + threads,
            lease,
            idle_after,
            pending: Mutex::new(Pending {
                queue: Queue::new(room, queue),
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
                    return Err(io::Error::new(
                        e.kind(),
                        format!("lane {}: setting {priority:?} priority failed: {e}", kind.name()),
                    ));
                }
                Err(_) => {
                    return Err(io::Error::other(format!(
                        "lane {}: a worker exited before it was ready",
                        kind.name()
                    )));
                }
            }
        }
        let dog = watch.clone();
        std::thread::Builder::new()
            .name(format!("mixdog-{}-watchdog", kind.name()))
            .stack_size(LANE_STACK)
            .spawn(move || watchdog(&dog))?;
        closing.disarm();
        Ok(Self {
            kind,
            stats,
            shape: Shape::Pooled(watch),
        })
    }

    /// A lane whose every job owns a thread for its whole duration (blocking PTY reads),
    /// capped at `max_live` concurrent jobs; the rest wait in a FIFO queue of at most `queue`.
    pub(crate) fn per_job(
        kind: LaneKind,
        priority: Priority,
        max_live: usize,
        queue: usize,
        priority_failures: &Arc<AtomicU64>,
    ) -> io::Result<Self> {
        Self::per_job_with(kind, priority, max_live, queue, priority_failures, set_current_thread)
    }

    fn per_job_with(
        kind: LaneKind,
        priority: Priority,
        max_live: usize,
        queue: usize,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        if max_live == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("lane {} needs a live-job cap of at least one", kind.name()),
            ));
        }
        let stats = Arc::new(LaneStats::new());
        let lane = PerJobLane {
            kind,
            priority,
            apply,
            failures: priority_failures.clone(),
            max_live,
            stats: stats.clone(),
            pending: Mutex::new(PerJobPending { queue: Queue::new(0, queue), live: 0, closed: false }),
        };
        Ok(Self {
            kind,
            stats,
            shape: Shape::PerJob(Arc::new(lane)),
        })
    }

    pub(crate) fn kind(&self) -> LaneKind {
        self.kind
    }

    /// Notified whenever the lane frees a thread slot or recovers a healthy worker.
    pub(crate) fn freed(&self) -> Arc<Notify> {
        self.stats.freed.clone()
    }

    /// Queues `job` (FIFO); it waits there for a thread. Refused only when the queue holds its far
    /// bound or the lane has no healthy worker.
    pub(crate) fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        match self.admit(job, Mode::Queue) {
            Entered::Admitted | Entered::Waiting(_) => Ok(()),
            Entered::Refused(full) => Err(full),
            Entered::ShutDown => Err(LaneFull { lane: self.kind }),
        }
    }

    /// [`Self::submit`] only when a thread takes the job now (an idle one, or one the lane may
    /// still start): never queues behind other work.
    pub(crate) fn try_submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        match self.admit(job, Mode::Now) {
            Entered::Admitted | Entered::Waiting(_) => Ok(()),
            Entered::Refused(full) => Err(full),
            Entered::ShutDown => Err(LaneFull { lane: self.kind }),
        }
    }

    /// A `submit_wait` job, queued in arrival order (see [`Entered`]).
    pub(crate) fn enter(&self, job: QueuedJob) -> Entered {
        self.admit(job, Mode::Wait)
    }

    /// Takes the job of a waiting `ticket` out of the queue unrun.
    pub(crate) fn withdraw(&self, ticket: &Ticket) -> bool {
        let job = match &self.shape {
            Shape::Pooled(watch) => lock(&watch.pending).queue.withdraw(ticket),
            Shape::PerJob(lane) => lock(&lane.pending).queue.withdraw(ticket),
        };
        // Dropped after the queue's lock: its result sender may wake a task.
        job.is_some()
    }

    fn admit(&self, job: QueuedJob, mode: Mode) -> Entered {
        let entered = match &self.shape {
            // A wedged lane has no worker to run the job: refuse it as overloaded.
            Shape::Pooled(watch) if watch.healthy() == 0 => Entered::Refused(LaneFull { lane: self.kind }),
            Shape::Pooled(watch) => watch.enqueue(job, mode),
            Shape::PerJob(lane) => lane.enqueue(job, mode),
        };
        match &entered {
            Entered::Admitted | Entered::Waiting(_) => self.stats.submitted.fetch_add(1, Relaxed),
            Entered::Refused(_) | Entered::ShutDown => self.stats.rejected.fetch_add(1, Relaxed),
        };
        entered
    }

    /// `true` while no worker of the lane is healthy. The thread-per-job lane never is: its
    /// jobs own their threads for as long as the PTY lives.
    pub(crate) fn is_wedged(&self) -> bool {
        match &self.shape {
            Shape::Pooled(watch) => watch.healthy() == 0,
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
        let (queue_depth, waiters, room, capacity, grown, max_threads) = match &self.shape {
            Shape::Pooled(watch) => {
                let pending = lock(&watch.pending);
                let queue = &pending.queue;
                (queue.len(), queue.waiters(), queue.room, queue.bound, live.saturating_sub(watch.threads), watch.max_threads)
            }
            Shape::PerJob(lane) => {
                let pending = lock(&lane.pending);
                let queue = &pending.queue;
                (queue.len(), queue.waiters(), queue.room, queue.bound, 0, lane.max_live)
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
}

pub(crate) fn apply_priority(priority: Priority, failures: &AtomicU64) {
    if set_current_thread(priority).is_err() {
        failures.fetch_add(1, Relaxed);
    }
}

/// Shutdown: every queued job is answered [`crate::JobDropped::ShutDown`] and every waiting
/// `submit_wait` caller `ShutDown`, none left pending; running jobs finish on their threads.
impl Drop for LaneExec {
    fn drop(&mut self) {
        let jobs = match &self.shape {
            Shape::Pooled(watch) => watch.close(),
            Shape::PerJob(lane) => lane.close(),
        };
        for job in jobs {
            job.shut_down();
        }
    }
}

/// A lane's FIFO queue: every job it holds in arrival order, `submit` and `submit_wait` alike.
/// Threads take jobs from the head only, so a job never runs before one that arrived earlier.
/// The first `room` entries are admitted; a `submit_wait` entry behind them carries a
/// [`Ticket`] its caller waits on, settled when the entry comes within `room` of the head (with
/// `room` 0, when a thread takes it). `bound` counts every entry, admitted or waiting.
struct Queue {
    entries: VecDeque<Entry>,
    room: usize,
    bound: usize,
}

struct Entry {
    job: QueuedJob,
    /// The waiting caller, until the entry is admitted.
    ticket: Option<Ticket>,
}

impl Queue {
    fn new(room: usize, bound: usize) -> Self {
        Self { entries: VecDeque::new(), room, bound }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn waiters(&self) -> usize {
        self.entries.iter().filter(|entry| entry.ticket.is_some()).count()
    }

    /// Appends `job` at the tail; `waiting` (`submit_wait`) gets a ticket unless it is admitted at
    /// once. At the bound, entries whose token was cancelled are dropped first (into `dropped`,
    /// for the caller to drop after the lock); still full, the job is handed back.
    fn push(&mut self, job: QueuedJob, waiting: bool, dropped: &mut Vec<QueuedJob>) -> Result<Option<Ticket>, QueuedJob> {
        if self.entries.len() >= self.bound {
            let (kept, cancelled): (VecDeque<Entry>, VecDeque<Entry>) =
                std::mem::take(&mut self.entries).into_iter().partition(|entry| !entry.job.is_cancelled());
            self.entries = kept;
            for entry in cancelled {
                if let Some(ticket) = entry.ticket {
                    ticket.settle(TicketEnd::Withdrawn);
                }
                dropped.push(entry.job);
            }
            for entry in self.entries.iter_mut().take(self.room) {
                if let Some(ticket) = entry.ticket.take() {
                    ticket.settle(TicketEnd::Admitted);
                }
            }
        }
        if self.entries.len() >= self.bound {
            return Err(job);
        }
        let ticket = (waiting && self.entries.len() >= self.room).then(Ticket::new);
        self.entries.push_back(Entry { job, ticket: ticket.clone() });
        Ok(ticket)
    }

    /// The head job for a thread; the entry that comes within `room` of the head is admitted.
    fn pop(&mut self) -> Option<QueuedJob> {
        let Entry { job, ticket } = self.entries.pop_front()?;
        if let Some(ticket) = ticket {
            ticket.settle(TicketEnd::Admitted);
        }
        if let Some(edge) = self.room.checked_sub(1).and_then(|edge| self.entries.get_mut(edge)) {
            if let Some(ticket) = edge.ticket.take() {
                ticket.settle(TicketEnd::Admitted);
            }
        }
        Some(job)
    }

    /// Takes a waiting entry out. Waiting entries lie behind the admitted ones, so no other entry's
    /// admission changes.
    fn withdraw(&mut self, ticket: &Ticket) -> Option<QueuedJob> {
        let index = self.entries.iter().position(|entry| entry.ticket.as_ref().is_some_and(|t| t.same(ticket)))?;
        let entry = self.entries.remove(index)?;
        ticket.settle(TicketEnd::Withdrawn);
        Some(entry.job)
    }

    /// Empties the queue: each waiting caller's ticket ends with `end`; the jobs are handed back.
    fn take_all(&mut self, end: TicketEnd) -> Vec<QueuedJob> {
        self.entries
            .drain(..)
            .map(|entry| {
                if let Some(ticket) = entry.ticket {
                    ticket.settle(end);
                }
                entry.job
            })
            .collect()
    }
}

/// The thread-per-job lane: each job owns a thread for its whole duration, at most `max_live`
/// at once; a thread that ends its job takes the next queued one.
struct PerJobLane {
    kind: LaneKind,
    priority: Priority,
    apply: ApplyPriority,
    failures: Arc<AtomicU64>,
    max_live: usize,
    stats: Arc<LaneStats>,
    pending: Mutex<PerJobPending>,
}

struct PerJobPending {
    queue: Queue,
    /// Threads alive; counted here, under the queue's lock, so the cap is decided in one place.
    live: usize,
    closed: bool,
}

impl PerJobLane {
    fn enqueue(self: &Arc<Self>, job: QueuedJob, mode: Mode) -> Entered {
        let mut dropped = Vec::new();
        let mut pending = lock(&self.pending);
        if pending.closed {
            drop(pending);
            job.shut_down();
            return Entered::ShutDown;
        }
        if pending.live < self.max_live && pending.queue.len() == 0 {
            pending.live += 1;
            self.stats.live.fetch_add(1, Relaxed);
            drop(pending);
            self.start(job);
            return Entered::Admitted;
        }
        if mode == Mode::Now {
            return Entered::Refused(LaneFull { lane: self.kind });
        }
        let entered = match pending.queue.push(job, mode == Mode::Wait, &mut dropped) {
            Ok(Some(ticket)) => Entered::Waiting(ticket),
            Ok(None) => Entered::Admitted,
            Err(refused) => {
                dropped.push(refused);
                Entered::Refused(LaneFull { lane: self.kind })
            }
        };
        drop(pending);
        drop(dropped);
        entered
    }

    /// Runs `job` on a new thread, which then serves the queue until it is empty. The thread's
    /// slot is already counted.
    fn start(self: &Arc<Self>, job: QueuedJob) {
        let lane = self.clone();
        let started = std::thread::Builder::new()
            .name(format!("mixdog-{}", self.kind.name()))
            .stack_size(LANE_STACK)
            .spawn(move || {
                if (lane.apply)(lane.priority).is_err() {
                    // The job is dropped unrun, so its handle resolves `JobDropped`; the next one
                    // gets a thread of its own.
                    lane.failures.fetch_add(1, Relaxed);
                    lane.stats.priority_failed.fetch_add(1, Relaxed);
                    drop(job);
                    if let Some(next) = lane.next() {
                        lane.start(next);
                    }
                    return;
                }
                let mut job = job;
                loop {
                    run_job(&lane.stats, job);
                    match lane.next() {
                        Some(next) => job = next,
                        None => return,
                    }
                }
            });
        if started.is_err() {
            // The job was dropped with the closure: its handle resolves `JobDropped`.
            self.end_thread(&mut lock(&self.pending));
        }
    }

    /// The next queued job for a thread that ended its own, or `None` once the queue is empty
    /// (the thread's slot is then released).
    fn next(&self) -> Option<QueuedJob> {
        let mut pending = lock(&self.pending);
        if let Some(job) = pending.queue.pop() {
            return Some(job);
        }
        self.end_thread(&mut pending);
        None
    }

    fn end_thread(&self, pending: &mut PerJobPending) {
        pending.live -= 1;
        self.stats.live.fetch_sub(1, Relaxed);
        self.stats.freed.notify_waiters();
    }

    fn close(&self) -> Vec<QueuedJob> {
        let mut pending = lock(&self.pending);
        pending.closed = true;
        pending.queue.take_all(TicketEnd::ShutDown)
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
            watch.close();
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

/// The job lease of one pooled lane (F1). A worker registers each job it runs; the watchdog
/// marks a worker `wedged` once its job has gone `lease` without [`job_progress`] and starts a
/// replacement worker while the lane has fewer than `limit` threads. The wedged job is
/// never abandoned: it keeps running and its handle resolves when it ends, because its effect
/// may still happen. A lane with no healthy (non-wedged) worker refuses work and drops what is
/// still queued (never run), so no caller waits on a lane nothing serves. A wedged worker that
/// finally returns rejoins as healthy, or exits when the lane already has `threads` healthy
/// workers.
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
    fn healthy(&self) -> usize {
        self.stats
            .live
            .load(Relaxed)
            .saturating_sub(self.stats.wedged.load(Relaxed))
    }

    /// Starts one worker past boot, the one place that decides it: under the queue's lock
    /// (`_pending`), so the check and the count are one step and no two starts take the last
    /// slot. `grow`: a worker for waiting work (healthy workers below `max_threads`); otherwise a
    /// replacement for a wedged one. Either way the lane never holds more than `limit` threads.
    fn start_worker(self: &Arc<Self>, _pending: &MutexGuard<'_, Pending>, grow: bool) -> bool {
        if self.stats.live.load(Relaxed) >= self.limit || (grow && self.healthy() >= self.max_threads) {
            return false;
        }
        self.spawn_worker(None).is_ok()
    }

    /// Starts one worker (called with the queue's lock held). `ready` reports the priority result
    /// of a lane's first workers.
    fn spawn_worker(
        self: &Arc<Self>,
        ready: Option<mpsc::Sender<io::Result<()>>>,
    ) -> io::Result<()> {
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

    fn begin(&self, id: usize) {
        let progress = Arc::new(AtomicU64::new(0));
        PROGRESS.set(Some(progress.clone()));
        lock(&self.running).insert(
            id,
            Running {
                progress,
                seen: 0,
                since: Instant::now(),
                wedged: false,
            },
        );
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
        let wedged = self.stats.wedged.fetch_sub(1, Relaxed) - 1;
        let surplus = self.stats.live.load(Relaxed) - wedged > self.max_threads;
        if surplus {
            self.stats.live.fetch_sub(1, Relaxed);
        }
        drop(running);
        // The lane may accept work again.
        self.stats.freed.notify_waiters();
        surplus
    }

    fn sweep(self: &Arc<Self>, now: Instant) {
        let mut running = lock(&self.running);
        let mut tripped = false;
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
            tripped = true;
            // Spawned before the wedge is counted, so the lane never looks dead in between.
            // A failed spawn leaves the lane short of workers, which `healthy` then reports.
            // Lock order: `running`, then `pending` (nothing takes them the other way).
            let _ = self.start_worker(&lock(&self.pending), false);
            self.stats.wedged.fetch_add(1, Relaxed);
        }
        drop(running);
        if self.healthy() == 0 {
            // Nothing will run these: dropping them resolves their handles `JobDropped`, and
            // waiting callers are answered `Wedged`.
            let dropped = lock(&self.pending).queue.take_all(TicketEnd::Wedged);
            drop(dropped);
        }
        if tripped {
            // Parked `submit_wait` callers re-check the lane.
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
            .filter(|(id, since)| !pending.retiring.contains(*id) &&now.saturating_duration_since(**since) >= self.idle_after)
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

    /// Queues `job` at the tail, starting a worker when none is idle and the lane may grow. In
    /// [`Mode::Now`], refuses unless a worker takes it at once.
    fn enqueue(self: &Arc<Self>, job: QueuedJob, mode: Mode) -> Entered {
        let refused = Entered::Refused(LaneFull { lane: self.kind });
        let mut dropped = Vec::new();
        let mut pending = lock(&self.pending);
        if pending.closed {
            drop(pending);
            job.shut_down();
            return Entered::ShutDown;
        }
        let idle = pending.idle.len().saturating_sub(pending.retiring.len());
        let wants_thread = pending.queue.len() + 1 > idle;
        if mode == Mode::Now
            && wants_thread
            && (self.stats.live.load(Relaxed) >= self.limit || self.healthy() >= self.max_threads)
        {
            return refused;
        }
        let entered = match pending.queue.push(job, mode == Mode::Wait, &mut dropped) {
            Ok(Some(ticket)) => Entered::Waiting(ticket),
            Ok(None) => Entered::Admitted,
            Err(job) => {
                dropped.push(job);
                refused
            }
        };
        if wants_thread && !matches!(entered, Entered::Refused(_)) {
            // A failed start leaves the job queued for the workers there are.
            let _ = self.start_worker(&pending, true);
        }
        drop(pending);
        drop(dropped);
        self.available.notify_one();
        entered
    }

    /// The lane was dropped: idle workers end, busy ones once their job returns. The queue is
    /// handed back for the caller to answer.
    fn close(&self) -> Vec<QueuedJob> {
        let jobs = {
            let mut pending = lock(&self.pending);
            pending.closed = true;
            pending.queue.take_all(TicketEnd::ShutDown)
        };
        self.available.notify_all();
        *lock(&self.stopped) = true;
        self.wake.notify_all();
        jobs
    }

    /// The next job for worker `id`, or `None` when it is to end (idle above the warm count past
    /// `idle_after`, or the lane closed with nothing queued).
    fn next_job(&self, id: usize) -> Option<QueuedJob> {
        let mut pending = lock(&self.pending);
        loop {
            if let Some(job) = pending.queue.pop() {
                pending.idle.remove(&id);
                pending.retiring.remove(&id);
                return Some(job);
            }
            if pending.retiring.remove(&id) || pending.closed {
                pending.idle.remove(&id);
                return None;
            }
            pending.idle.entry(id).or_insert_with(Instant::now);
            pending = self.available.wait(pending).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

fn worker(watch: &Arc<Watch>, id: usize, ready: Option<&mpsc::Sender<io::Result<()>>>) {
    if let Err(e) = (watch.apply)(watch.priority) {
        watch.failures.fetch_add(1, Relaxed);
        match ready {
            Some(ready) => {
                let _ = ready.send(Err(e));
            }
            None => {
                watch.stats.live.fetch_sub(1, Relaxed);
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
    watch.stats.live.fetch_sub(1, Relaxed);
    watch.stats.freed.notify_waiters();
}

/// The lane's watchdog thread: one sweep every quarter lease (every half idle time on an elastic
/// lane, whichever is shorter) until the lane is dropped.
fn watchdog(watch: &Arc<Watch>) {
    let tick = (watch.lease / 4).min(watch.idle_after / 2).max(Duration::from_millis(1));
    loop {
        let (stopped, _) = watch
            .wake
            .wait_timeout_while(lock(&watch.stopped), tick, |stopped| !*stopped)
            .unwrap_or_else(PoisonError::into_inner);
        if *stopped {
            return;
        }
        drop(stopped);
        watch.sweep(Instant::now());
    }
}

/// A tool call's lane job that waited this long in its queue is logged once ([`slow_wait_line`]),
/// into the daemon's log. Healthy queue waits stay far below it (the service bounds `S` of
/// RL §12.2 are 25-40 ms), so a loaded machine does not fill the log; a call stuck behind
/// unrelated long work (seconds to minutes) always crosses it.
pub(crate) const SLOW_WAIT: Duration = Duration::from_millis(250);

/// The line of a tool call's job that waited past [`SLOW_WAIT`]: the tool, the lane, the wait
/// and the time the job then ran.
pub(crate) fn slow_wait_line(tool: &str, lane: LaneKind, waited: Duration, ran: Duration) -> String {
    format!("[lane-wait] tool={tool} lane={} waited={}ms ran={}ms", lane.name(), waited.as_millis(), ran.as_millis())
}

/// Runs one dequeued job. A cancelled job is dropped unrun (RL §7.1); a panicking job resolves
/// its handle with `JobDropped` and leaves the thread serving the next one.
fn run_job(stats: &LaneStats, job: QueuedJob) {
    let waited = job.enqueued_at().elapsed();
    stats.queue_wait.record(waited);
    let slow = if waited >= SLOW_WAIT { job.tool().map(|tool| (tool, job.lane())) } else { None };
    let started = Instant::now();
    let outcome = catch_unwind(AssertUnwindSafe(move || job.run()));
    if let Some((tool, lane)) = slow {
        crate::node_stderr!("{}", slow_wait_line(tool, lane, waited, started.elapsed()));
    }
    match outcome {
        Ok(JobRun::Completed) => {
            stats.service.record(started.elapsed());
            stats.completed.fetch_add(1, Relaxed);
        }
        Ok(JobRun::DroppedCancelled) => {
            stats.dropped_cancelled.fetch_add(1, Relaxed);
        }
        Err(_) => {
            stats.panicked.fetch_add(1, Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn refuse(_: Priority) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    /// A job that reports `7` through the returned receiver; dropped unrun, the receiver
    /// disconnects.
    fn job(lane: LaneKind) -> (QueuedJob, mpsc::Receiver<i32>) {
        let (tx, rx) = mpsc::channel();
        let run = Box::new(move |_: crate::lanes::Answer| {
            let _ = tx.send(7);
        });
        (QueuedJob::new(lane, CancellationToken::new(), run), rx)
    }

    /// A job that reports how it was answered: run, or told its lane shut down.
    fn answering_job(lane: LaneKind) -> (QueuedJob, mpsc::Receiver<crate::lanes::Answer>) {
        let (tx, rx) = mpsc::channel();
        let run = Box::new(move |answer: crate::lanes::Answer| {
            let _ = tx.send(answer);
        });
        (QueuedJob::new(lane, CancellationToken::new(), run), rx)
    }

    /// A job that signals `started`, then blocks until `release` is sent or dropped, then
    /// sends on the returned channel: its late "effect". The channel disconnects without a
    /// message if the job is dropped unrun.
    fn blocking_job(
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> (QueuedJob, mpsc::Receiver<()>) {
        let (done_tx, done_rx) = mpsc::channel();
        let run = Box::new(move |_: crate::lanes::Answer| {
            started.send(()).unwrap();
            let _ = release.recv_timeout(TEST_WAIT);
            done_tx.send(()).unwrap();
        });
        (
            QueuedJob::new(LaneKind::CpuBulk, CancellationToken::new(), run),
            done_rx,
        )
    }

    /// Like [`blocking_job`], but after `step` is received it reports progress and signals
    /// `progressed`, then blocks on `release`.
    fn advancing_job(
        started: mpsc::Sender<()>,
        step: mpsc::Receiver<()>,
        progressed: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> QueuedJob {
        let run = Box::new(move |_: crate::lanes::Answer| {
            started.send(()).unwrap();
            step.recv_timeout(TEST_WAIT).expect("the test steps the advancing job");
            job_progress();
            progressed.send(()).unwrap();
            let _ = release.recv_timeout(TEST_WAIT);
        });
        QueuedJob::new(LaneKind::CpuBulk, CancellationToken::new(), run)
    }

    const LEASE: Duration = Duration::from_secs(3600);

    /// The deadline of every wait in these tests.
    const TEST_WAIT: Duration = Duration::from_secs(60);

    fn started(rx: &mpsc::Receiver<()>) {
        rx.recv_timeout(TEST_WAIT).expect("the held job starts on a lane thread");
    }

    /// Far enough past every job's start for its lease to have expired, without sleeping.
    fn after_lease() -> Instant {
        Instant::now() + LEASE
    }

    #[test]
    fn wedged_workers_are_replaced_then_the_lane_refuses_and_drops_its_queue() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::pooled_with(
            LaneKind::CpuBulk,
            Priority::Normal,
            1,
            4,
            4,
            LEASE,
            &failures,
            |_| Ok(()),
        )
        .unwrap();
        let (started_tx, started_rx) = mpsc::channel();

        // Job A takes the only worker and never returns.
        let (release_a, a_gate) = mpsc::channel::<()>();
        let (a, a_done) = blocking_job(started_tx.clone(), a_gate);
        lane.submit(a).unwrap();
        started(&started_rx);

        // Lease expiry: a replacement worker takes over the lane. A is not abandoned: it is
        // still running, neither finished nor dropped.
        lane.sweep(after_lease());
        assert_eq!(a_done.try_recv(), Err(mpsc::TryRecvError::Empty));
        assert!(!lane.is_wedged());
        assert_eq!(lane.snapshot().wedged, 1);
        let (queued, rx) = job(LaneKind::CpuBulk);
        lane.submit(queued).unwrap();
        assert_eq!(rx.recv_timeout(TEST_WAIT), Ok(7));

        // Job B wedges the replacement too: no healthy worker is left.
        let (release_b, b_gate) = mpsc::channel::<()>();
        let (b, b_done) = blocking_job(started_tx, b_gate);
        lane.submit(b).unwrap();
        started(&started_rx);
        let (c, c_rx) = job(LaneKind::CpuBulk);
        lane.submit(c).unwrap();
        lane.sweep(after_lease());
        assert!(lane.is_wedged());
        // The queued job never ran and is dropped, not left waiting; new work is refused at
        // once.
        assert!(c_rx.recv_timeout(TEST_WAIT).is_err());
        let (d, _d_rx) = job(LaneKind::CpuBulk);
        assert_eq!(lane.submit(d), Err(LaneFull { lane: LaneKind::CpuBulk }));

        // The stuck jobs return late: their effects happened, and the lane comes back.
        drop(release_a);
        drop(release_b);
        assert_eq!(a_done.recv_timeout(TEST_WAIT), Ok(()));
        assert_eq!(b_done.recv_timeout(TEST_WAIT), Ok(()));
        let freed = lane.freed();
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(async {
                // A returning stuck job notifies `freed`; registered before each check.
                loop {
                    let notified = freed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if !lane.is_wedged() {
                        break;
                    }
                    notified.await;
                }
            });
        let (e, e_rx) = job(LaneKind::CpuBulk);
        lane.submit(e).unwrap();
        assert_eq!(e_rx.recv_timeout(TEST_WAIT), Ok(7));
    }

    /// The lease still works on an elastic lane: the watchdog counts a stuck worker wedged and
    /// starts a replacement, and the lane keeps serving.
    #[test]
    fn an_elastic_lanes_wedged_worker_is_replaced_and_the_lane_keeps_serving() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::elastic_with(LaneKind::InteractiveIo, Priority::Normal, 1, 2, 4, 4, LEASE, Duration::MAX, &failures, |_| Ok(()))
            .unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        let (stuck, stuck_done) = blocking_job(started_tx, gate);
        lane.submit(stuck).unwrap();
        started(&started_rx);
        lane.sweep(after_lease());
        let snapshot = lane.snapshot();
        assert_eq!((snapshot.wedged, snapshot.threads), (1, 2));
        assert!(!lane.is_wedged());
        let (queued, rx) = job(LaneKind::InteractiveIo);
        lane.submit(queued).unwrap();
        assert_eq!(rx.recv_timeout(TEST_WAIT), Ok(7));
        drop(release);
        assert_eq!(stuck_done.recv_timeout(TEST_WAIT), Ok(()));
    }

    #[test]
    fn a_job_that_reports_progress_keeps_its_lease() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::pooled_with(
            LaneKind::CpuBulk,
            Priority::Normal,
            1,
            4,
            4,
            LEASE,
            &failures,
            |_| Ok(()),
        )
        .unwrap();
        let base = Instant::now();
        let (started_tx, started_rx) = mpsc::channel();
        let (step_tx, step_rx) = mpsc::channel();
        let (progressed_tx, progressed_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        lane.submit(advancing_job(started_tx, step_rx, progressed_tx, release_rx))
            .unwrap();
        started(&started_rx);

        // Three quarters of the lease with no progress: still within it. The sweep notes the
        // time at which it last saw the job's progress counter.
        lane.sweep(base + LEASE * 3 / 4);
        assert_eq!(lane.snapshot().wedged, 0);

        // The job advances: its lease restarts at the next sweep, so another three quarters
        // later (1.5 leases after it started) it is still healthy.
        step_tx.send(()).unwrap();
        progressed_rx.recv_timeout(TEST_WAIT).expect("the job reports progress");
        lane.sweep(base + LEASE * 3 / 4);
        lane.sweep(base + LEASE * 3 / 2);
        assert_eq!(lane.snapshot().wedged, 0);

        // A full lease with no further progress wedges it.
        lane.sweep(base + LEASE * 7 / 4 + Duration::from_secs(1));
        assert_eq!(lane.snapshot().wedged, 1);
        drop(release_tx);
    }

    #[test]
    fn pooled_lane_that_cannot_take_its_priority_fails_to_start() {
        let failures = Arc::new(AtomicU64::new(0));
        let err = LaneExec::pooled_with(
            LaneKind::CpuBulk,
            Priority::BelowNormal,
            2,
            4,
            4,
            LEASE,
            &failures,
            refuse,
        )
        .err()
        .expect("start must fail");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains("cpu-bulk"));
        assert!(failures.load(Relaxed) >= 1);
    }

    #[test]
    fn per_job_lane_drops_a_job_whose_thread_cannot_take_the_priority() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::per_job_with(
            LaneKind::PtyIo,
            Priority::Normal,
            2,
            4,
            &failures,
            refuse,
        )
        .unwrap();
        let (queued, rx) = job(LaneKind::PtyIo);
        lane.submit(queued).unwrap();
        // The submitter sees the failure: the result channel closes without a value.
        assert!(rx.recv_timeout(TEST_WAIT).is_err());
        assert_eq!(failures.load(Relaxed), 1);
        assert_eq!(lane.snapshot().priority_failed, 1);
        assert_eq!(lane.snapshot().completed, 0);
    }

    /// Only a tool call's job past the threshold is logged, once, naming the tool, the lane, the
    /// wait and the run time. Enqueue times are set, not waited for: one far enough in the past,
    /// one in the future (its wait reads as zero).
    #[test]
    fn a_tool_calls_job_that_waited_past_the_threshold_is_logged_once() {
        let stats = LaneStats::new();
        let (lines, _guard) = crate::node_log::capture();
        let long_ago = Instant::now().checked_sub(SLOW_WAIT * 3).expect("an instant before the threshold");
        let ahead = Instant::now() + Duration::from_secs(3600);
        run_job(&stats, QueuedJob::queued_at(LaneKind::SpawnIo, Some("shell"), long_ago, Box::new(|_: crate::lanes::Answer| {})));
        run_job(&stats, QueuedJob::queued_at(LaneKind::SpawnIo, Some("shell"), ahead, Box::new(|_: crate::lanes::Answer| {})));
        run_job(&stats, QueuedJob::queued_at(LaneKind::MaintenanceIo, None, long_ago, Box::new(|_: crate::lanes::Answer| {})));
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0].2;
        assert!(line.starts_with("[lane-wait] tool=shell lane=io-spawn waited="), "{line}");
        let waited: u128 = line.split("waited=").nth(1).and_then(|rest| rest.split("ms").next()).unwrap().parse().unwrap();
        assert!(waited >= SLOW_WAIT.as_millis() * 3, "{line}");
        assert!(line.contains("ms ran=") && line.ends_with("ms"), "{line}");
        assert_eq!(stats.completed.load(Relaxed), 3);
    }

    #[test]
    fn per_job_lane_runs_the_job_when_the_priority_applies() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::per_job(LaneKind::PtyIo, Priority::Normal, 2, 4, &failures).unwrap();
        let (queued, rx) = job(LaneKind::PtyIo);
        lane.submit(queued).unwrap();
        assert_eq!(rx.recv_timeout(TEST_WAIT), Ok(7));
        assert_eq!(failures.load(Relaxed), 0);
    }

    /// The lane shuts down with jobs queued and a `submit_wait` caller waiting: every queued job
    /// is answered that the lane shut down and the waiter's ticket ends `ShutDown`, none left
    /// pending while the running job still holds the only thread. Both lane shapes.
    #[test]
    fn a_lane_that_shuts_down_answers_every_queued_job_and_waiter() {
        use crate::lanes::Answer;
        let failures = Arc::new(AtomicU64::new(0));
        let pooled = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 4, LEASE, &failures, |_| Ok(())).unwrap();
        let per_job = LaneExec::per_job_with(LaneKind::PtyIo, Priority::Normal, 1, 4, &failures, |_| Ok(())).unwrap();
        for (lane, kind) in [(pooled, LaneKind::CpuBulk), (per_job, LaneKind::PtyIo)] {
            let (started_tx, started_rx) = mpsc::channel();
            let (release, gate) = mpsc::channel::<()>();
            let (held_tx, held_done) = mpsc::channel();
            let holder = QueuedJob::new(
                kind,
                CancellationToken::new(),
                Box::new(move |_: crate::lanes::Answer| {
                    started_tx.send(()).unwrap();
                    let _ = gate.recv_timeout(TEST_WAIT);
                    held_tx.send(()).unwrap();
                }),
            );
            lane.submit(holder).unwrap();
            started(&started_rx);
            let (queued, queued_answer) = answering_job(kind);
            lane.submit(queued).unwrap();
            let (waiting, waiting_answer) = answering_job(kind);
            let Entered::Waiting(ticket) = lane.enter(waiting) else { panic!("the waiter's job waits behind the queued one") };
            assert_eq!(lane.snapshot().waiters, 1);

            drop(lane);
            assert_eq!(queued_answer.recv_timeout(TEST_WAIT), Ok(Answer::ShutDown), "the queued job is answered");
            assert_eq!(ticket.end(), Some(TicketEnd::ShutDown), "the waiter is answered");
            assert_eq!(waiting_answer.recv_timeout(TEST_WAIT), Ok(Answer::ShutDown), "the waiter's job never runs");
            drop(release);
            assert_eq!(held_done.recv_timeout(TEST_WAIT), Ok(()), "the running job finishes on its thread");
        }
    }

    /// Admission is arrival: a waiter behind another is admitted only after it, and a cancelled
    /// head waiter's job is taken out without running while those behind keep their order.
    #[test]
    fn waiters_are_admitted_and_run_in_arrival_order_and_a_withdrawn_head_never_runs() {
        use crate::lanes::Answer;
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::pooled_with(LaneKind::CpuBulk, Priority::Normal, 1, 1, 8, LEASE, &failures, |_| Ok(())).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        let (holder, _held_done) = blocking_job(started_tx, gate);
        lane.submit(holder).unwrap();
        started(&started_rx);
        let (order_tx, order) = mpsc::channel();
        let entered: Vec<_> = (0..4)
            .map(|n| {
                let order = order_tx.clone();
                let job = QueuedJob::new(
                    LaneKind::CpuBulk,
                    CancellationToken::new(),
                    Box::new(move |answer: crate::lanes::Answer| {
                        if answer == Answer::Run {
                            order.send(n).unwrap();
                        }
                    }),
                );
                lane.enter(job)
            })
            .collect();
        // The first is admitted (room 1); the three behind it wait.
        assert!(matches!(entered[0], Entered::Admitted));
        let tickets: Vec<Ticket> =
            entered[1..].iter().map(|e| if let Entered::Waiting(t) = e { t.clone() } else { panic!("waits") }).collect();
        assert_eq!(lane.snapshot().waiters, 3);
        // The head waiter withdraws; the others keep their places.
        assert!(lane.withdraw(&tickets[0]));
        assert_eq!(tickets[0].end(), Some(TicketEnd::Withdrawn));
        assert!(tickets[1..].iter().all(|t| t.end().is_none()));
        drop(release);
        let ran: Vec<usize> = (0..3).map(|_| order.recv_timeout(TEST_WAIT).expect("a queued job runs")).collect();
        assert_eq!(ran, [0, 2, 3], "arrival order, the withdrawn job never runs");
        assert_eq!(tickets[1].end(), Some(TicketEnd::Admitted));
        assert_eq!(tickets[2].end(), Some(TicketEnd::Admitted));
    }
}
