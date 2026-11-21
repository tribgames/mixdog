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
    /// The effort judge's own thread (one per judge model, as Node's judge worker) and the ONNX
    /// Runtime threads its session starts.
    EffortJudge,
}

/// The lane is overloaded: its queue holds its far bound of waiting jobs, or it has no healthy worker left. The caller answers
/// `overloaded` at once; it is never a closed session, and a job refused this way never ran, so a reply it carried is still the
/// caller's to send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneFull {
    pub lane: LaneKind,
}

impl std::fmt::Display for LaneFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "overloaded: {}", self.lane.name())
    }
}

/// How a [`crate::LaneToken::submit_wait`] job entered its lane ([`crate::Backend::enter`]). From then on the lane owns
/// the job; the caller keeps only its handle and, while it waits, its ticket.
pub enum Entered {
    /// Queued and admitted: fewer than the lane's room of jobs are ahead of it.
    Admitted,
    /// Queued in arrival order, not yet admitted: the caller waits on the ticket. The job keeps
    /// its place, inside the queue's far bound or in the waiting order beyond it, and runs only
    /// after every job that arrived before it.
    Waiting(Ticket),
    /// A plain submission met the queue at its far bound (a `submit_wait` job is never refused
    /// for room).
    Refused(LaneFull),
    /// The lane has no healthy worker to run the job; the job was dropped unrun.
    Wedged,
    /// The lane shut down; the job was answered [`JobDropped::ShutDown`].
    ShutDown,
}

/// What ended a ticket's wait. Decided once, under the lane's lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TicketEnd {
    /// The job came within the lane's room of the head (or a thread took it).
    Admitted,
    /// The job was taken out unrun before admission: its caller withdrew it, or its token was
    /// cancelled.
    Withdrawn,
    /// The lane lost its last healthy worker (or could start no thread); the job was answered
    /// unrun.
    Wedged,
    /// The lane shut down; the job was answered unrun.
    ShutDown,
}

/// A job's node in its lane's queue: its slot and that slot's generation, so a key outliving the
/// node never names the slot's next occupant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NodeKey {
    pub(crate) index: u32,
    pub(crate) generation: u32,
}

const TICKET_WAITING: u8 = 0;

/// A waiting job's place in its lane's queue ([`Entered::Waiting`]). The lane decides its end
/// under its queue's lock, at the moment the job stops waiting, and wakes the waiter after.
#[derive(Clone)]
pub struct Ticket {
    state: std::sync::Arc<TicketState>,
    key: NodeKey,
}

struct TicketState {
    end: std::sync::atomic::AtomicU8,
    /// `notify_one`: a wake before the waiter awaits is kept as a permit, never lost.
    changed: tokio::sync::Notify,
}

impl Ticket {
    pub(crate) fn new(key: NodeKey) -> Self {
        Self { state: std::sync::Arc::new(TicketState { end: std::sync::atomic::AtomicU8::new(TICKET_WAITING), changed: tokio::sync::Notify::new() }), key }
    }

    pub(crate) fn key(&self) -> NodeKey {
        self.key
    }

    /// Decides the ticket's end; the waiter is woken by [`Self::wake`].
    pub(crate) fn decide(&self, end: TicketEnd) {
        self.state.end.store(end as u8 + 1, std::sync::atomic::Ordering::Release);
    }

    pub(crate) fn wake(&self) {
        self.state.changed.notify_one();
    }

    /// `None` while the job waits.
    pub(crate) fn end(&self) -> Option<TicketEnd> {
        match self.state.end.load(std::sync::atomic::Ordering::Acquire) {
            TICKET_WAITING => None,
            1 => Some(TicketEnd::Admitted),
            2 => Some(TicketEnd::Withdrawn),
            3 => Some(TicketEnd::Wedged),
            _ => Some(TicketEnd::ShutDown),
        }
    }

    pub(crate) async fn changed(&self) {
        self.state.changed.notified().await;
    }
}

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

/// Why [`crate::LaneToken::submit_wait`] gave up without enqueuing the job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitWaitError {
    /// The job's cancellation token was cancelled while waiting for room.
    Cancelled,
    /// The backend cannot signal free capacity, so waiting is impossible.
    Full(LaneFull),
    /// The lane has no healthy worker left, so waiting for room would never end.
    Wedged(LaneWedged),
    /// The lane shut down while the job waited; it never ran.
    ShutDown(LaneKind),
}

impl std::fmt::Display for SubmitWaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SubmitWaitError::Cancelled => f.write_str("cancelled while waiting for lane capacity"),
            SubmitWaitError::Full(full) => full.fmt(f),
            SubmitWaitError::Wedged(wedged) => wedged.fmt(f),
            SubmitWaitError::ShutDown(lane) => write!(f, "lane {} shut down", lane.name()),
        }
    }
}

tokio::task_local! {
    /// The tool whose call the current task runs ([`in_tool_call`]).
    static TOOL_CALL: &'static str;
}

/// Runs `fut` as the body of a call of the tool `name` ([`tool_label`]): a lane job it submits
/// that waits in its queue past the lanes' slow-wait threshold is logged with the tool's name.
pub async fn in_tool_call<F: Future>(name: &'static str, fut: F) -> F::Output {
    TOOL_CALL.scope(name, fut).await
}

/// `work` under the tool call of the task that calls this ([`crate::carry_task_locals`]).
pub(crate) fn carry<F: Future>(work: F) -> impl Future<Output = F::Output> {
    crate::within_local(&TOOL_CALL, TOOL_CALL.try_with(|tool| *tool).ok(), work)
}

/// The process-lifetime copy of a tool name, made once per distinct name (the tool catalog is
/// small), so tagging a call costs a lookup and no allocation.
pub fn tool_label(name: &str) -> &'static str {
    use std::collections::HashSet;
    use std::sync::RwLock;
    static NAMES: RwLock<Option<HashSet<&'static str>>> = RwLock::new(None);
    if let Some(found) = NAMES.read().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|names| names.get(name)) {
        return found;
    }
    let mut names = NAMES.write().unwrap_or_else(|p| p.into_inner());
    let names = names.get_or_insert_with(HashSet::new);
    if let Some(found) = names.get(name) {
        return found;
    }
    let label: &'static str = Box::leak(name.to_owned().into_boxed_str());
    names.insert(label);
    label
}

/// A job waiting in a lane queue. Created only by [`crate::LaneToken::submit`].
pub struct QueuedJob {
    lane: LaneKind,
    /// When the job was submitted: its queue wait counts from here, a `submit_wait` caller's wait
    /// for admission included.
    enqueued_at: Instant,
    /// The tool whose call submitted the job, if a tool call did.
    tool: Option<&'static str>,
    cancel: CancellationToken,
    run: Box<dyn FnOnce(Answer) + Send>,
}

/// What a job's body is called for: to run, or to answer why it never will. Only `Run` calls the
/// submitter's closure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Run,
    ShutDown,
    /// The lane has no healthy worker to run the job.
    Wedged,
    /// The job's token was cancelled while it was queued.
    Cancelled,
    /// The thread started for the job could not be created; other threads serve the lane.
    NotStarted,
}

/// What [`QueuedJob::run`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobRun {
    Completed,
    /// The job's token was cancelled before dequeue; the job was dropped unrun.
    DroppedCancelled,
}

impl QueuedJob {
    pub(crate) fn new(lane: LaneKind, cancel: CancellationToken, run: Box<dyn FnOnce(Answer) + Send>) -> Self {
        Self { lane, enqueued_at: Instant::now(), tool: TOOL_CALL.try_with(|tool| *tool).ok(), cancel, run }
    }

    /// The same job, submitted at `at` (a `submit_wait` retry keeps its first attempt's time).
    pub(crate) fn submitted_at(mut self, at: Instant) -> Self {
        self.enqueued_at = at;
        self
    }

    /// A job of `tool` enqueued at `enqueued_at`.
    #[cfg(test)]
    pub(crate) fn queued_at(lane: LaneKind, tool: Option<&'static str>, enqueued_at: Instant, run: Box<dyn FnOnce(Answer) + Send>) -> Self {
        Self { lane, enqueued_at, tool, cancel: CancellationToken::new(), run }
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

    pub(crate) fn token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// The same job with its body wrapped by `wrap` (the replay's clock counts it while it is queued or running).
    #[cfg(feature = "virtual-clock")]
    pub(crate) fn map_run(self, wrap: impl FnOnce(Box<dyn FnOnce(Answer) + Send>) -> Box<dyn FnOnce(Answer) + Send>) -> Self {
        Self { lane: self.lane, enqueued_at: self.enqueued_at, tool: self.tool, cancel: self.cancel, run: wrap(self.run) }
    }

    /// Runs the job on the calling lane thread, or drops it unrun if it was cancelled while queued
    /// (its handle resolves [`JobDropped::Cancelled`]).
    pub fn run(self) -> JobRun {
        if self.cancel.is_cancelled() {
            self.answer(Answer::Cancelled);
            return JobRun::DroppedCancelled;
        }
        (self.run)(Answer::Run);
        JobRun::Completed
    }

    /// Calls the job's body with `answer`; a lane answers a job it will never run this way, after
    /// deciding why under its lock.
    pub(crate) fn answer(self, answer: Answer) {
        (self.run)(answer);
    }
}

/// The job was dropped before producing a result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobDropped {
    /// Its thread could not take the lane's priority, or it panicked. Except for a panic, the
    /// job never ran.
    Dropped,
    /// The job's token was cancelled while it was queued; it never ran.
    Cancelled,
    /// The lane shut down while the job was queued; it never ran.
    ShutDown,
    /// The lane lost its last healthy worker (or could start no thread) while the job was
    /// queued; it never ran.
    Wedged,
    /// The OS refused the thread the lane started for the job, while other threads still serve
    /// the lane; it never ran.
    NotStarted,
}

impl std::fmt::Display for JobDropped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobDropped::Dropped => f.write_str("lane job dropped before completion"),
            JobDropped::Cancelled => f.write_str("lane job cancelled before it ran"),
            JobDropped::ShutDown => f.write_str("lane shut down before the job ran"),
            JobDropped::Wedged => f.write_str("lane has no healthy worker to run the job"),
            JobDropped::NotStarted => f.write_str("lane could not start a thread for the job"),
        }
    }
}

/// Result of a submitted job. Cancel-safe: dropping the handle does not cancel the job; the
/// job's [`CancellationToken`] does. A running job's handle resolves only when the job ends,
/// however late: a lane lease never abandons a running job, because its effect (a committed
/// write) may still happen and the caller must not be told it did not.
pub struct JobHandle<R> {
    rx: oneshot::Receiver<Result<R, JobDropped>>,
}

impl<R> JobHandle<R> {
    pub(crate) fn new(rx: oneshot::Receiver<Result<R, JobDropped>>) -> Self {
        Self { rx }
    }

    /// The outcome if it was already sent, read without waiting and without spending the task's
    /// cooperative budget; `None` while nothing was sent and the job may still send it. A lane
    /// sends a job's known unrun cause before it drops the job's closure, so a reader that holds
    /// what that closure released last reads the cause here, never `None`.
    pub fn try_outcome(&mut self) -> Option<Result<R, JobDropped>> {
        match self.rx.try_recv() {
            Ok(outcome) => Some(outcome),
            Err(oneshot::error::TryRecvError::Closed) => Some(Err(JobDropped::Dropped)),
            Err(oneshot::error::TryRecvError::Empty) => None,
        }
    }
}

impl<R> Future for JobHandle<R> {
    type Output = Result<R, JobDropped>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.rx).poll(cx).map(|r| r.unwrap_or(Err(JobDropped::Dropped)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued() -> QueuedJob {
        QueuedJob::new(LaneKind::SpawnIo, CancellationToken::new(), Box::new(|_: Answer| {}))
    }

    #[tokio::test]
    async fn a_job_queued_inside_a_tool_call_names_the_tool_and_others_name_none() {
        let label = tool_label("shell");
        assert!(std::ptr::eq(label, tool_label(&String::from("shell"))), "one copy per name");
        assert_eq!(in_tool_call(label, async { queued().tool() }).await, Some("shell"));
        assert_eq!(queued().tool(), None);
    }
}

impl std::error::Error for LaneFull {}
impl std::error::Error for LaneWedged {}
impl std::error::Error for SubmitWaitError {}
impl std::error::Error for JobDropped {}
