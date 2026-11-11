//! Lane and thread kinds, queued jobs and job handles (RL §3, §7.1, §12.2; SPEC R47).

use std::future::Future;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use std::time::Instant;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Dedicated thread pools with a bounded FIFO queue. Lanes never share threads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LaneKind {
    /// Session-open decode and verify, snapshot and history-page encoding, mutation record
    /// and frame encoding. Above-normal priority.
    CpuInteractive,
    /// Compaction, checkpoint materialization, hashing, diffing, search, embeddings, ledger
    /// repair computation, catalog parse. Below-normal priority.
    CpuBulk,
    /// Session-open reads, history pages, UI blob reads, SQLite list/usage reads.
    InteractiveIo,
    /// Session-log group commits, blob writes, atomic settings writes.
    DurabilityIo,
    /// Directory scans, git inspection, backups, integrity hashes, GC, migration checks.
    /// Below-normal priority.
    MaintenanceIo,
    /// Process creation, job-object and process-group setup.
    SpawnIo,
    /// PTY reads and writes (DS §6.4).
    PtyIo,
}

impl LaneKind {
    /// The executor name used in RL §3 and in `queueFull{queue}`.
    pub const fn name(self) -> &'static str {
        match self {
            LaneKind::CpuInteractive => "cpu-interactive",
            LaneKind::CpuBulk => "cpu-bulk",
            LaneKind::InteractiveIo => "io-interactive",
            LaneKind::DurabilityIo => "io-durability",
            LaneKind::MaintenanceIo => "io-maintenance",
            LaneKind::SpawnIo => "io-spawn",
            LaneKind::PtyIo => "io-pty",
        }
    }
}

/// Executors that are dedicated OS threads rather than pooled lanes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThreadKind {
    /// The management listener thread (LR §6.1); answers while the async runtimes stall.
    Control,
    /// One worker thread per computer-use session (DS §11).
    Computer,
    /// One encoder thread per active video track (SPEC §4.7.3), below RT priority.
    WebrtcMedia,
    /// The single write connection of one SQLite database (RL §8).
    SqliteWriter,
    /// The effort judge's own thread (one per judge model, as Node's judge worker) and the ONNX
    /// Runtime threads its session starts.
    EffortJudge,
}

/// The lane's queue is at capacity; the caller answers `overloaded` at once (RL §0.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneFull {
    pub lane: LaneKind,
}

impl std::fmt::Display for LaneFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "lane {} queue full", self.lane.name())
    }
}

impl std::error::Error for LaneFull {}

/// Every worker of the lane is stuck in a job that outlived its lease (F1): the lane accepts no
/// work until a stuck job returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneWedged {
    pub lane: LaneKind,
}

impl std::fmt::Display for LaneWedged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "lane {} wedged", self.lane.name())
    }
}

impl std::error::Error for LaneWedged {}

/// Why [`crate::LaneToken::submit_wait`] gave up without enqueuing the job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitWaitError {
    /// The job's cancellation token was cancelled while waiting for room.
    Cancelled,
    /// The backend cannot signal free capacity, so waiting is impossible.
    Full(LaneFull),
    /// The lane has no healthy worker left, so waiting for room would never end.
    Wedged(LaneWedged),
}

impl std::fmt::Display for SubmitWaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SubmitWaitError::Cancelled => f.write_str("cancelled while waiting for lane capacity"),
            SubmitWaitError::Full(full) => full.fmt(f),
            SubmitWaitError::Wedged(wedged) => wedged.fmt(f),
        }
    }
}

impl std::error::Error for SubmitWaitError {}

/// A job waiting in a lane queue. Created only by [`crate::LaneToken::submit`].
pub struct QueuedJob {
    lane: LaneKind,
    enqueued_at: Instant,
    cancel: CancellationToken,
    run: Box<dyn FnOnce() + Send>,
}

/// What [`QueuedJob::run`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobRun {
    Completed,
    /// The job's token was cancelled before dequeue; the job was dropped unrun.
    DroppedCancelled,
}

impl QueuedJob {
    pub(crate) fn new(
        lane: LaneKind,
        cancel: CancellationToken,
        run: Box<dyn FnOnce() + Send>,
    ) -> Self {
        Self {
            lane,
            enqueued_at: Instant::now(),
            cancel,
            run,
        }
    }

    pub fn lane(&self) -> LaneKind {
        self.lane
    }

    /// Enqueue time, for the queue-wait histogram.
    pub fn enqueued_at(&self) -> Instant {
        self.enqueued_at
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Runs the job on the calling lane thread, or drops it if it was cancelled while queued.
    pub fn run(self) -> JobRun {
        if self.cancel.is_cancelled() {
            return JobRun::DroppedCancelled;
        }
        (self.run)();
        JobRun::Completed
    }
}

/// The job was dropped before producing a result: cancelled at dequeue, discarded unrun by a
/// wedged lane, or it panicked. Except for a panic, the job never ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobDropped;

impl std::fmt::Display for JobDropped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("lane job dropped before completion")
    }
}

impl std::error::Error for JobDropped {}

/// Result of a submitted job. Cancel-safe: dropping the handle does not cancel the job; the
/// job's [`CancellationToken`] does. A running job's handle resolves only when the job ends,
/// however late: a lane lease never abandons a running job, because its effect (a committed
/// write) may still happen and the caller must not be told it did not.
pub struct JobHandle<R> {
    rx: oneshot::Receiver<R>,
}

impl<R> JobHandle<R> {
    pub(crate) fn new(rx: oneshot::Receiver<R>) -> Self {
        Self { rx }
    }
}

impl<R> Future for JobHandle<R> {
    type Output = Result<R, JobDropped>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.rx)
            .poll(cx)
            .map(|r| r.map_err(|_| JobDropped))
    }
}
