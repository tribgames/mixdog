//! Lane executors: dedicated thread pools with a FIFO queue, and the thread-per-job lane
//! (RL §7.1). Lanes never share threads.
//!
//! A pooled lane keeps `threads` workers warm. An elastic lane (`max_threads` above `threads`,
//! the IO lanes: a thread blocked on a file or pipe uses no processor) starts another worker
//! when a job is queued and no worker is idle, up to `max_threads`; a worker above the warm count
//! ends once idle for `idle_after` (seen by the watchdog's pass). A job that finds every thread
//! busy waits in the queue; only the queue's far bound ([`Room`]) refuses, as overload
//! protection.

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
use std::sync::atomic::Ordering::AcqRel;
use std::sync::atomic::Ordering::Acquire;
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
use crate::lanes::Room;

/// Applies an OS priority to the calling thread; a seam so tests can make it fail.
type ApplyPriority = fn(Priority) -> io::Result<()>;

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
    /// Jobs waiting in the queue for a thread (always 0 for the thread-per-job lane).
    pub queue_depth: usize,
    /// Tasks waiting in `submit_wait` because the queue held its far bound.
    pub waiters: usize,
    /// The queue's far bound (where `submit` answers overloaded), or the live-job cap of the
    /// thread-per-job lane.
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
    /// `threads` warm workers, growing to `max_threads`, over one FIFO queue bounded by `room`.
    Pooled {
        room: Room,
        capacity: usize,
        watch: Arc<Watch>,
    },
    /// One thread per job, at most `max_live` at once; no queue.
    PerJob {
        max_live: usize,
        apply: ApplyPriority,
    },
}

pub(crate) struct LaneExec {
    kind: LaneKind,
    priority: Priority,
    stats: Arc<LaneStats>,
    priority_failures: Arc<AtomicU64>,
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
        queue: usize,
        lease: Duration,
        idle_after: Duration,
        priority_failures: &Arc<AtomicU64>,
    ) -> io::Result<Self> {
        Self::elastic_with(kind, priority, threads, max_threads, queue, lease, idle_after, priority_failures, set_current_thread)
    }

    /// A fixed lane: `threads` workers, never more.
    #[cfg(test)]
    fn pooled_with(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        queue: usize,
        lease: Duration,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        Self::elastic_with(kind, priority, threads, threads, queue, lease, Duration::MAX, priority_failures, apply)
    }

    #[allow(clippy::too_many_arguments, reason = "the lane's sizing, one value each")]
    fn elastic_with(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        max_threads: usize,
        queue: usize,
        lease: Duration,
        idle_after: Duration,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        if threads == 0 || queue == 0 || max_threads < threads {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("lane {} needs at least one thread, one queue slot and a cap of at least its warm threads", kind.name()),
            ));
        }
        let stats = Arc::new(LaneStats::new());
        let watch = Arc::new(Watch {
            kind,
            threads,
            max_threads,
            lease,
            idle_after,
            pending: Mutex::new(Pending::default()),
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
            .spawn(move || watchdog(&dog))?;
        closing.disarm();
        Ok(Self {
            kind,
            priority,
            stats,
            priority_failures: priority_failures.clone(),
            shape: Shape::Pooled {
                room: Room::new(queue),
                capacity: queue,
                watch,
            },
        })
    }

    /// A lane whose every job owns a thread for its whole duration (blocking PTY reads),
    /// capped at `max_live` concurrent jobs.
    pub(crate) fn per_job(
        kind: LaneKind,
        priority: Priority,
        max_live: usize,
        priority_failures: &Arc<AtomicU64>,
    ) -> io::Result<Self> {
        Self::per_job_with(kind, priority, max_live, priority_failures, set_current_thread)
    }

    fn per_job_with(
        kind: LaneKind,
        priority: Priority,
        max_live: usize,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        if max_live == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("lane {} needs a live-job cap of at least one", kind.name()),
            ));
        }
        Ok(Self {
            kind,
            priority,
            stats: Arc::new(LaneStats::new()),
            priority_failures: priority_failures.clone(),
            shape: Shape::PerJob { max_live, apply },
        })
    }

    pub(crate) fn kind(&self) -> LaneKind {
        self.kind
    }

    /// Notified whenever the lane frees a queue slot or a thread slot.
    pub(crate) fn freed(&self) -> Arc<Notify> {
        self.stats.freed.clone()
    }

    /// Queues `job` (FIFO); it waits there for a thread. Refused only when the queue holds its far
    /// bound or the lane has no healthy worker.
    pub(crate) fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        self.admit(job, false)
    }

    /// [`Self::submit`] only when a thread takes the job now (an idle one, or one the lane may
    /// still start): never queues behind other work.
    pub(crate) fn try_submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        self.admit(job, true)
    }

    /// The room of a pooled lane's queue.
    pub(crate) fn room(&self) -> Option<Room> {
        match &self.shape {
            Shape::Pooled { room, .. } => Some(room.clone()),
            Shape::PerJob { .. } => None,
        }
    }

    fn admit(&self, mut job: QueuedJob, now_only: bool) -> Result<(), LaneFull> {
        let accepted = match &self.shape {
            // A wedged lane has no worker to run the job: refuse it as overloaded.
            Shape::Pooled { room, watch, .. } => {
                watch.healthy() > 0
                    && (job.holds_room() || room.permits.clone().try_acquire_owned().map(|permit| job.hold_room(permit)).is_ok())
                    && watch.enqueue(job, now_only)
            }
            Shape::PerJob { max_live, apply } => self.spawn_per_job(*max_live, *apply, job),
        };
        if accepted {
            self.stats.submitted.fetch_add(1, Relaxed);
            Ok(())
        } else {
            self.stats.rejected.fetch_add(1, Relaxed);
            Err(LaneFull { lane: self.kind })
        }
    }

    fn spawn_per_job(&self, max_live: usize, apply: ApplyPriority, job: QueuedJob) -> bool {
        let reserved = self
            .stats
            .live
            .try_update(AcqRel, Acquire, |live| (live < max_live).then_some(live + 1));
        if reserved.is_err() {
            return false;
        }
        // Moved into the thread; if the thread cannot start, dropping the closure releases it.
        let guard = LiveGuard(self.stats.clone());
        let priority = self.priority;
        let failures = self.priority_failures.clone();
        std::thread::Builder::new()
            .name(format!("mixdog-{}", self.kind.name()))
            .spawn(move || {
                if apply(priority).is_err() {
                    // The job is dropped unrun, so its handle resolves `JobDropped`.
                    failures.fetch_add(1, Relaxed);
                    guard.0.priority_failed.fetch_add(1, Relaxed);
                    return;
                }
                run_job(&guard.0, job);
            })
            .is_ok()
    }

    /// `true` while no worker of the lane is healthy. The thread-per-job lane never is: its
    /// jobs own their threads for as long as the PTY lives.
    pub(crate) fn is_wedged(&self) -> bool {
        match &self.shape {
            Shape::Pooled { watch, .. } => watch.healthy() == 0,
            Shape::PerJob { .. } => false,
        }
    }

    /// One watchdog pass at `now`: marks workers whose job outlived the lease.
    pub(crate) fn sweep(&self, now: Instant) {
        if let Shape::Pooled { watch, .. } = &self.shape {
            watch.sweep(now);
        }
    }

    pub(crate) fn snapshot(&self) -> LaneSnapshot {
        let live = self.stats.live.load(Relaxed);
        let (queue_depth, capacity, waiters, grown, max_threads) = match &self.shape {
            Shape::Pooled { room, capacity, watch } => (
                lock(&watch.pending).jobs.len(),
                *capacity,
                room.waiters(),
                live.saturating_sub(watch.threads),
                watch.max_threads,
            ),
            Shape::PerJob { max_live, .. } => (0, *max_live, 0, 0, *max_live),
        };
        LaneSnapshot {
            kind: self.kind,
            threads: live,
            wedged: self.stats.wedged.load(Relaxed),
            grown,
            max_threads,
            queue_depth,
            waiters,
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

struct LiveGuard(Arc<LaneStats>);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.live.fetch_sub(1, Relaxed);
        self.0.freed.notify_waiters();
    }
}

pub(crate) fn apply_priority(priority: Priority, failures: &AtomicU64) {
    if set_current_thread(priority).is_err() {
        failures.fetch_add(1, Relaxed);
    }
}

impl Drop for LaneExec {
    fn drop(&mut self) {
        if let Shape::Pooled { watch, .. } = &self.shape {
            watch.close();
        }
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
/// replacement worker while the lane has fewer than `2 * threads` threads. The wedged job is
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
#[derive(Default)]
struct Pending {
    jobs: VecDeque<QueuedJob>,
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

    /// Starts one worker. `ready` reports the priority result of a lane's first workers.
    fn spawn_worker(
        self: &Arc<Self>,
        ready: Option<mpsc::Sender<io::Result<()>>>,
    ) -> io::Result<()> {
        let id = self.next_id.fetch_add(1, Relaxed);
        self.stats.live.fetch_add(1, Relaxed);
        let watch = self.clone();
        std::thread::Builder::new()
            .name(format!("mixdog-{}-{id}", self.kind.name()))
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
            if self.stats.live.load(Relaxed) < self.max_threads + self.threads {
                let _ = self.spawn_worker(None);
            }
            self.stats.wedged.fetch_add(1, Relaxed);
        }
        drop(running);
        if self.healthy() == 0 {
            // Nothing will run these: dropping them resolves their handles `JobDropped`.
            let dropped = std::mem::take(&mut lock(&self.pending).jobs);
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

    /// Queues `job`, starting a worker when none is idle and the lane may grow. With `now_only`,
    /// refuses (dropping the job, `false`) unless a worker takes it at once.
    fn enqueue(self: &Arc<Self>, job: QueuedJob, now_only: bool) -> bool {
        let mut pending = lock(&self.pending);
        if pending.closed {
            return false;
        }
        let idle = pending.idle.len().saturating_sub(pending.retiring.len());
        let waiting = pending.jobs.len() + 1;
        let grow = waiting > idle && self.healthy() < self.max_threads && self.stats.live.load(Relaxed) < self.max_threads + self.threads;
        if now_only && waiting > idle && !grow {
            return false;
        }
        pending.jobs.push_back(job);
        if grow {
            // Under the queue's lock, so two submitters never both start the last allowed worker.
            // A failed start leaves the job queued for the workers there are.
            let _ = self.spawn_worker(None);
        }
        drop(pending);
        self.available.notify_one();
        true
    }

    /// The lane was dropped: idle workers end, busy ones after the queue is empty.
    fn close(&self) {
        lock(&self.pending).closed = true;
        self.available.notify_all();
        *lock(&self.stopped) = true;
        self.wake.notify_all();
    }

    /// The next job for worker `id`, or `None` when it is to end (idle above the warm count past
    /// `idle_after`, or the lane closed with nothing queued).
    fn next_job(&self, id: usize) -> Option<QueuedJob> {
        let mut pending = lock(&self.pending);
        loop {
            if let Some(job) = pending.jobs.pop_front() {
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
    while let Some(mut job) = watch.next_job(id) {
        job.release_room();
        watch.stats.freed.notify_waiters();
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
    use tokio::sync::oneshot;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn refuse(_: Priority) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    /// A job that reports `7` through the returned receiver.
    fn job(lane: LaneKind) -> (QueuedJob, oneshot::Receiver<i32>) {
        let (tx, rx) = oneshot::channel();
        let run = Box::new(move || {
            let _ = tx.send(7);
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
        let run = Box::new(move || {
            started.send(()).unwrap();
            let _ = release.recv();
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
        let run = Box::new(move || {
            started.send(()).unwrap();
            step.recv().unwrap();
            job_progress();
            progressed.send(()).unwrap();
            let _ = release.recv();
        });
        QueuedJob::new(LaneKind::CpuBulk, CancellationToken::new(), run)
    }

    const LEASE: Duration = Duration::from_secs(3600);

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
        started_rx.recv().unwrap();

        // Lease expiry: a replacement worker takes over the lane. A is not abandoned: it is
        // still running, neither finished nor dropped.
        lane.sweep(after_lease());
        assert_eq!(a_done.try_recv(), Err(mpsc::TryRecvError::Empty));
        assert!(!lane.is_wedged());
        assert_eq!(lane.snapshot().wedged, 1);
        let (queued, rx) = job(LaneKind::CpuBulk);
        lane.submit(queued).unwrap();
        assert_eq!(rx.blocking_recv(), Ok(7));

        // Job B wedges the replacement too: no healthy worker is left.
        let (release_b, b_gate) = mpsc::channel::<()>();
        let (b, b_done) = blocking_job(started_tx, b_gate);
        lane.submit(b).unwrap();
        started_rx.recv().unwrap();
        let (c, c_rx) = job(LaneKind::CpuBulk);
        lane.submit(c).unwrap();
        lane.sweep(after_lease());
        assert!(lane.is_wedged());
        // The queued job never ran and is dropped, not left waiting; new work is refused at
        // once.
        assert!(c_rx.blocking_recv().is_err());
        let (d, _d_rx) = job(LaneKind::CpuBulk);
        assert_eq!(lane.submit(d), Err(LaneFull { lane: LaneKind::CpuBulk }));

        // The stuck jobs return late: their effects happened, and the lane comes back.
        drop(release_a);
        drop(release_b);
        assert_eq!(a_done.recv(), Ok(()));
        assert_eq!(b_done.recv(), Ok(()));
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
        assert_eq!(e_rx.blocking_recv(), Ok(7));
    }

    /// The lease still works on an elastic lane: the watchdog counts a stuck worker wedged and
    /// starts a replacement, and the lane keeps serving.
    #[test]
    fn an_elastic_lanes_wedged_worker_is_replaced_and_the_lane_keeps_serving() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::elastic_with(LaneKind::InteractiveIo, Priority::Normal, 1, 2, 4, LEASE, Duration::MAX, &failures, |_| Ok(()))
            .unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        let (stuck, stuck_done) = blocking_job(started_tx, gate);
        lane.submit(stuck).unwrap();
        started_rx.recv().unwrap();
        lane.sweep(after_lease());
        let snapshot = lane.snapshot();
        assert_eq!((snapshot.wedged, snapshot.threads), (1, 2));
        assert!(!lane.is_wedged());
        let (queued, rx) = job(LaneKind::InteractiveIo);
        lane.submit(queued).unwrap();
        assert_eq!(rx.blocking_recv(), Ok(7));
        drop(release);
        assert_eq!(stuck_done.recv(), Ok(()));
    }

    #[test]
    fn a_job_that_reports_progress_keeps_its_lease() {
        let failures = Arc::new(AtomicU64::new(0));
        let lane = LaneExec::pooled_with(
            LaneKind::CpuBulk,
            Priority::Normal,
            1,
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
        started_rx.recv().unwrap();

        // Three quarters of the lease with no progress: still within it. The sweep notes the
        // time at which it last saw the job's progress counter.
        lane.sweep(base + LEASE * 3 / 4);
        assert_eq!(lane.snapshot().wedged, 0);

        // The job advances: its lease restarts at the next sweep, so another three quarters
        // later (1.5 leases after it started) it is still healthy.
        step_tx.send(()).unwrap();
        progressed_rx.recv().unwrap();
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
            &failures,
            refuse,
        )
        .unwrap();
        let (queued, rx) = job(LaneKind::PtyIo);
        lane.submit(queued).unwrap();
        // The submitter sees the failure: the result channel closes without a value.
        assert!(rx.blocking_recv().is_err());
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
        run_job(&stats, QueuedJob::queued_at(LaneKind::SpawnIo, Some("shell"), long_ago, Box::new(|| {})));
        run_job(&stats, QueuedJob::queued_at(LaneKind::SpawnIo, Some("shell"), ahead, Box::new(|| {})));
        run_job(&stats, QueuedJob::queued_at(LaneKind::MaintenanceIo, None, long_ago, Box::new(|| {})));
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
        let lane = LaneExec::per_job(LaneKind::PtyIo, Priority::Normal, 2, &failures).unwrap();
        let (queued, rx) = job(LaneKind::PtyIo);
        lane.submit(queued).unwrap();
        assert_eq!(rx.blocking_recv(), Ok(7));
        assert_eq!(failures.load(Relaxed), 0);
    }
}
