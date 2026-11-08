//! Lane executors: dedicated thread pools with a bounded FIFO queue, and the thread-per-job
//! lane (RL §7.1). Lanes never share threads.

use std::collections::HashMap;
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

use crossbeam_channel::Receiver;
use crossbeam_channel::Sender;
use tokio::sync::Notify;

use super::hist::HistSummary;
use super::hist::Histogram;
use super::priority::Priority;
use super::priority::set_current_thread;
use crate::JobRun;
use crate::LaneFull;
use crate::LaneKind;
use crate::QueuedJob;

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
    /// Jobs waiting in the queue (always 0 for the thread-per-job lane).
    pub queue_depth: usize,
    /// Queue capacity, or the live-job cap of the thread-per-job lane.
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
    /// `threads` workers over one bounded queue.
    Pooled {
        tx: Sender<QueuedJob>,
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
    pub(crate) fn pooled(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        queue: usize,
        lease: Duration,
        priority_failures: &Arc<AtomicU64>,
    ) -> io::Result<Self> {
        Self::pooled_with(
            kind,
            priority,
            threads,
            queue,
            lease,
            priority_failures,
            set_current_thread,
        )
    }

    fn pooled_with(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        queue: usize,
        lease: Duration,
        priority_failures: &Arc<AtomicU64>,
        apply: ApplyPriority,
    ) -> io::Result<Self> {
        if threads == 0 || queue == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("lane {} needs at least one thread and one queue slot", kind.name()),
            ));
        }
        let (tx, rx) = crossbeam_channel::bounded(queue);
        let stats = Arc::new(LaneStats::new());
        let watch = Arc::new(Watch {
            kind,
            threads,
            lease,
            rx,
            stats: stats.clone(),
            priority,
            apply,
            failures: priority_failures.clone(),
            next_id: AtomicUsize::new(0),
            running: Mutex::new(HashMap::new()),
            stopped: Mutex::new(false),
            wake: Condvar::new(),
        });
        let (ready_tx, ready_rx) = mpsc::channel();
        for _ in 0..threads {
            watch.spawn_worker(Some(ready_tx.clone()))?;
        }
        drop(ready_tx);
        // Returning early drops `tx`, which ends every worker that did start.
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
        Ok(Self {
            kind,
            priority,
            stats,
            priority_failures: priority_failures.clone(),
            shape: Shape::Pooled {
                tx,
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

    pub(crate) fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        let accepted = match &self.shape {
            // A wedged lane has no worker to run the job: refuse it like a full queue.
            Shape::Pooled { tx, watch, .. } => watch.healthy() > 0 && tx.try_send(job).is_ok(),
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
        let (queue_depth, capacity) = match &self.shape {
            Shape::Pooled { tx, capacity, .. } => (tx.len(), *capacity),
            Shape::PerJob { max_live, .. } => (0, *max_live),
        };
        LaneSnapshot {
            kind: self.kind,
            threads: self.stats.live.load(Relaxed),
            wedged: self.stats.wedged.load(Relaxed),
            queue_depth,
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
            *lock(&watch.stopped) = true;
            watch.wake.notify_all();
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
    threads: usize,
    lease: Duration,
    rx: Receiver<QueuedJob>,
    stats: Arc<LaneStats>,
    priority: Priority,
    apply: ApplyPriority,
    failures: Arc<AtomicU64>,
    next_id: AtomicUsize,
    running: Mutex<HashMap<usize, Running>>,
    stopped: Mutex<bool>,
    wake: Condvar,
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
        let surplus = self.stats.live.load(Relaxed) - wedged > self.threads;
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
            if self.stats.live.load(Relaxed) < 2 * self.threads {
                let _ = self.spawn_worker(None);
            }
            self.stats.wedged.fetch_add(1, Relaxed);
        }
        drop(running);
        if self.healthy() == 0 {
            // Nothing will run these: dropping them resolves their handles `JobDropped`.
            while self.rx.try_recv().is_ok() {}
        }
        if tripped {
            // Parked `submit_wait` callers re-check the lane.
            self.stats.freed.notify_waiters();
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
    for job in watch.rx.iter() {
        watch.stats.freed.notify_waiters();
        watch.begin(id);
        run_job(&watch.stats, job);
        if watch.end(id) {
            return;
        }
    }
}

/// The lane's watchdog thread: one sweep every quarter lease until the lane is dropped.
fn watchdog(watch: &Arc<Watch>) {
    let tick = (watch.lease / 4).max(Duration::from_millis(1));
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

/// Runs one dequeued job. A cancelled job is dropped unrun (RL §7.1); a panicking job resolves
/// its handle with `JobDropped` and leaves the thread serving the next one.
fn run_job(stats: &LaneStats, job: QueuedJob) {
    stats.queue_wait.record(job.enqueued_at().elapsed());
    let started = Instant::now();
    match catch_unwind(AssertUnwindSafe(move || job.run())) {
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
