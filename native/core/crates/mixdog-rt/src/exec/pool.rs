//! Lane executors: dedicated thread pools with a bounded FIFO queue, and the thread-per-job
//! lane (RL §7.1). Lanes never share threads.

use std::io;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::sync::Arc;
use std::sync::mpsc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::AcqRel;
use std::sync::atomic::Ordering::Acquire;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Instant;

use crossbeam_channel::Receiver;
use crossbeam_channel::Sender;
use crossbeam_channel::TrySendError;
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
        priority_failures: &Arc<AtomicU64>,
    ) -> io::Result<Self> {
        Self::pooled_with(
            kind,
            priority,
            threads,
            queue,
            priority_failures,
            set_current_thread,
        )
    }

    fn pooled_with(
        kind: LaneKind,
        priority: Priority,
        threads: usize,
        queue: usize,
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
        let (ready_tx, ready_rx) = mpsc::channel();
        for index in 0..threads {
            let rx = rx.clone();
            let worker_stats = stats.clone();
            let failures = priority_failures.clone();
            let ready = ready_tx.clone();
            std::thread::Builder::new()
                .name(format!("mixdog-{}-{index}", kind.name()))
                .spawn(move || worker(&rx, &worker_stats, priority, apply, &failures, &ready))?;
            stats.live.fetch_add(1, Relaxed);
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
        Ok(Self {
            kind,
            priority,
            stats,
            priority_failures: priority_failures.clone(),
            shape: Shape::Pooled {
                tx,
                capacity: queue,
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
            Shape::Pooled { tx, .. } => match tx.try_send(job) {
                Ok(()) => true,
                Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
            },
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
            .fetch_update(AcqRel, Acquire, |live| (live < max_live).then_some(live + 1));
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

    pub(crate) fn snapshot(&self) -> LaneSnapshot {
        let (queue_depth, capacity) = match &self.shape {
            Shape::Pooled { tx, capacity } => (tx.len(), *capacity),
            Shape::PerJob { max_live, .. } => (0, *max_live),
        };
        LaneSnapshot {
            kind: self.kind,
            threads: self.stats.live.load(Relaxed),
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

fn worker(
    rx: &Receiver<QueuedJob>,
    stats: &LaneStats,
    priority: Priority,
    apply: ApplyPriority,
    failures: &AtomicU64,
    ready: &mpsc::Sender<io::Result<()>>,
) {
    if let Err(e) = apply(priority) {
        failures.fetch_add(1, Relaxed);
        let _ = ready.send(Err(e));
        return;
    }
    let _ = ready.send(Ok(()));
    for job in rx.iter() {
        stats.freed.notify_waiters();
        run_job(stats, job);
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

    #[test]
    fn pooled_lane_that_cannot_take_its_priority_fails_to_start() {
        let failures = Arc::new(AtomicU64::new(0));
        let err = LaneExec::pooled_with(
            LaneKind::CpuBulk,
            Priority::BelowNormal,
            2,
            4,
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
