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
    /// Process creation, job-object and process-group setup, and the per-call preparation of a
    /// process (its log files, scratch and launcher directories, program lookup).
    SpawnIo,
    /// PTY reads and writes (DS §6.4), and the log drains of shell jobs: blocking I/O that must
    /// own a thread per job so one job's slow device never stalls another's.
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
}

/// The lane is overloaded: its queue holds its far bound of waiting jobs (overload protection,
/// not a busy signal: below that bound a job waits for a thread), or it has no healthy worker
/// left. The caller answers `overloaded` at once (RL §0.2); it is never a closed session, and a
/// job refused this way never ran, so a reply it carried is still the caller's to send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneFull {
    pub lane: LaneKind,
}

impl std::fmt::Display for LaneFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "overloaded: {}", self.lane.name())
    }
}

/// The room of a pooled lane's queue: one permit per job it may hold waiting (its far bound),
/// taken by each queued job until a thread takes the job. [`crate::LaneToken::submit_wait`] waits
/// for a permit in FIFO order (tokio's semaphore is fair), so no waiter starves.
#[derive(Clone)]
pub struct Room {
    pub(crate) permits: std::sync::Arc<tokio::sync::Semaphore>,
    /// Tasks waiting in `submit_wait` for a permit.
    pub(crate) waiters: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl Room {
    pub(crate) fn new(bound: usize) -> Self {
        Self {
            permits: std::sync::Arc::new(tokio::sync::Semaphore::new(bound)),
            waiters: std::sync::Arc::default(),
        }
    }

    pub(crate) fn waiters(&self) -> usize {
        self.waiters.load(std::sync::atomic::Ordering::Relaxed)
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

tokio::task_local! {
    /// The tool whose call the current task runs ([`in_tool_call`]).
    static TOOL_CALL: &'static str;
}

/// Runs `fut` as the body of a call of the tool `name` ([`tool_label`]): a lane job it submits
/// that waits in its queue past the lanes' slow-wait threshold is logged with the tool's name.
pub async fn in_tool_call<F: Future>(name: &'static str, fut: F) -> F::Output {
    TOOL_CALL.scope(name, fut).await
}

/// The process-lifetime copy of a tool name, made once per distinct name (the tool catalog is
/// small), so tagging a call costs a lookup and no allocation.
pub fn tool_label(name: &str) -> &'static str {
    use std::collections::HashSet;
    use std::sync::RwLock;
    static NAMES: RwLock<Option<HashSet<&'static str>>> = RwLock::new(None);
    if let Some(found) = NAMES.read().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|names| names.get(name)) {
        return *found;
    }
    let mut names = NAMES.write().unwrap_or_else(|p| p.into_inner());
    let names = names.get_or_insert_with(HashSet::new);
    if let Some(found) = names.get(name) {
        return *found;
    }
    let label: &'static str = Box::leak(name.to_owned().into_boxed_str());
    names.insert(label);
    label
}

/// A job waiting in a lane queue. Created only by [`crate::LaneToken::submit`].
pub struct QueuedJob {
    lane: LaneKind,
    enqueued_at: Instant,
    /// The tool whose call submitted the job, if a tool call did.
    tool: Option<&'static str>,
    /// The job's place in its lane's [`Room`] while it waits for a thread.
    room: Option<tokio::sync::OwnedSemaphorePermit>,
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
            tool: TOOL_CALL.try_with(|tool| *tool).ok(),
            room: None,
            cancel,
            run,
        }
    }

    /// A job of `tool` enqueued at `enqueued_at`.
    #[cfg(test)]
    pub(crate) fn queued_at(lane: LaneKind, tool: Option<&'static str>, enqueued_at: Instant, run: Box<dyn FnOnce() + Send>) -> Self {
        Self { lane, enqueued_at, tool, room: None, cancel: CancellationToken::new(), run }
    }

    /// The job holds `permit` of its lane's room until a thread takes it.
    pub(crate) fn hold_room(&mut self, permit: tokio::sync::OwnedSemaphorePermit) {
        self.room = Some(permit);
    }

    pub(crate) fn holds_room(&self) -> bool {
        self.room.is_some()
    }

    /// A thread took the job: its place in the room is free for the next.
    pub(crate) fn release_room(&mut self) {
        self.room = None;
    }

    pub fn lane(&self) -> LaneKind {
        self.lane
    }

    /// Enqueue time, for the queue-wait histogram.
    pub fn enqueued_at(&self) -> Instant {
        self.enqueued_at
    }

    /// The tool whose call submitted the job ([`in_tool_call`]).
    pub fn tool(&self) -> Option<&'static str> {
        self.tool
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// The same job with its body wrapped by `wrap` (the replay's clock counts it while it is queued or running).
    #[cfg(feature = "virtual-clock")]
    pub(crate) fn map_run(self, wrap: impl FnOnce(Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send>) -> Self {
        Self { lane: self.lane, enqueued_at: self.enqueued_at, tool: self.tool, room: self.room, cancel: self.cancel, run: wrap(self.run) }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn queued() -> QueuedJob {
        QueuedJob::new(LaneKind::SpawnIo, CancellationToken::new(), Box::new(|| {}))
    }

    #[tokio::test]
    async fn a_job_queued_inside_a_tool_call_names_the_tool_and_others_name_none() {
        let label = tool_label("shell");
        assert!(std::ptr::eq(label, tool_label(&String::from("shell"))), "one copy per name");
        assert_eq!(in_tool_call(label, async { queued().tool() }).await, Some("shell"));
        assert_eq!(queued().tool(), None);
    }
}
