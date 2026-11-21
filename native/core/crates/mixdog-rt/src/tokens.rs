//! Zero-sized capability tokens. A token is the only way to put work on a lane or start a dedicated thread. Tokens are minted once
//! by [`crate::install`] and handed by the composition root only to the owning modules.
//!
//! While a job runs it receives an [`InLane`] proof for its lane; a dedicated thread receives an [`OnThread`] proof. Proofs are
//! neither `Send` nor `Sync` and only exist as borrowed closure arguments, so lane-bound functions
//! (`fn read_tail(lane: &InLane<InteractiveIo>, …)`) cannot be called from an async task or from another lane.

use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::lanes::Answer;
use crate::lanes::Entered;
use crate::lanes::JobDropped;
use crate::lanes::JobHandle;
use crate::lanes::LaneFull;
use crate::lanes::LaneKind;
use crate::lanes::LaneWedged;
use crate::lanes::QueuedJob;
use crate::lanes::SubmitWaitError;
use crate::lanes::ThreadKind;
use crate::lanes::Ticket;
use crate::lanes::TicketEnd;

mod sealed {
    pub trait Sealed {}
}

/// Proof that the current code runs inside a job of lane `L`.
#[derive(Debug)]
pub struct InLane<L> {
    _lane: PhantomData<(L, *const ())>,
}

impl<L> InLane<L> {
    fn new() -> Self {
        Self { _lane: PhantomData }
    }
}

/// Proof that the current code runs on a dedicated thread of kind `T`.
#[derive(Debug)]
pub struct OnThread<T> {
    _thread: PhantomData<(T, *const ())>,
}

impl<T> OnThread<T> {
    fn new() -> Self {
        Self { _thread: PhantomData }
    }
}

/// A pooled lane. Implemented only by the tokens of this module.
pub trait LaneToken: sealed::Sealed + Copy + Send + Sync + 'static {
    const KIND: LaneKind;

    /// Enqueues `job`. Never blocks the caller: when every thread of the lane is busy (and an
    /// elastic lane is at its cap) the job waits in the lane's FIFO queue, and the wait is on the
    /// returned handle. Only overload protection refuses, at once: a queue at its far bound, or a
    /// wedged lane, answers [`LaneFull`] ("overloaded: <lane>"). A job whose `cancel` token is
    /// cancelled before dequeue is dropped unrun and its handle resolves
    /// `Err(JobDropped::Cancelled)`.
    fn submit<R, F>(self, cancel: &CancellationToken, job: F) -> Result<JobHandle<R>, LaneFull>
    where
        F: FnOnce(&InLane<Self>) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        crate::backend().submit(QueuedJob::new(Self::KIND, cancel.clone(), handing::<Self, R, F>(tx, job)))?;
        Ok(JobHandle::new(rx))
    }

    /// [`submit`](Self::submit) for a producer that must not wait behind other work: a job no
    /// thread can take at once (every thread busy and the lane at its cap) answers [`LaneFull`]
    /// instead of queueing. For best-effort periodic work that would rather skip a turn.
    fn try_submit<R, F>(self, cancel: &CancellationToken, job: F) -> Result<JobHandle<R>, LaneFull>
    where
        F: FnOnce(&InLane<Self>) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        crate::backend().try_submit(QueuedJob::new(Self::KIND, cancel.clone(), handing::<Self, R, F>(tx, job)))?;
        Ok(JobHandle::new(rx))
    }

    /// Like [`submit`](Self::submit), but the caller waits until its job is admitted: until fewer
    /// than the lane's room of jobs are ahead of it. For producers that must not run ahead of
    /// their lane (a loop that would otherwise queue without bound).
    ///
    /// Order is arrival: when the future is first polled the lane takes the job, at the tail of
    /// its one FIFO order, and dispatches it after every job that arrived before it, whatever
    /// order the waiters are woken or polled in. A queue at its far bound (waiting jobs counted)
    /// is not a refusal: the job waits in that order beyond the bound, and each place the queue
    /// frees moves the oldest waiting job inside, under the lane's lock, before any later
    /// submission can take it. The future resolves `Ok` once its job is within the lane's room of
    /// the head (or a thread takes it); a later poll does not move it. Only a backend without an
    /// ordered queue answers `Err(Full)`.
    ///
    /// Cancel-safe: dropping the future before it resolves `Ok` takes its job out unrun (its
    /// captures are released at once), even after the lane admitted it, unless a thread already
    /// took it: a worker may claim and run an admitted job before the caller polls again, and the
    /// first of the claim and the drop wins. Cancelling `cancel` before admission resolves
    /// `Err(Cancelled)`, with no poll or free capacity needed: the lane listens to the token. Once
    /// it resolves `Ok`, the job is queued exactly as after `submit`; dropping the handle does not
    /// withdraw it. On a backend without an ordered queue ([`crate::Backend::enter`]) it retries
    /// `submit` on a wake-up instead, with no order among waiters.
    ///
    /// Bounded even with a token that is never cancelled: a lane with no healthy worker (F1)
    /// resolves `Err(Wedged)` and answers what it holds, a lane that shuts down resolves
    /// `Err(ShutDown)`, and an admitted job that no worker will ever run resolves its handle with
    /// the reason (`JobDropped::Wedged`, `ShutDown`, `Cancelled`). A job that is running when its
    /// lane lease lapses is not abandoned: its handle resolves when it ends.
    fn submit_wait<'a, R, F>(self, cancel: &'a CancellationToken, job: F) -> impl Future<Output = Result<JobHandle<R>, SubmitWaitError>> + Send + 'a
    where
        F: FnOnce(&InLane<Self>) -> R + Send + 'static,
        R: Send + 'static,
    {
        async move {
            let backend = crate::backend();
            if cancel.is_cancelled() {
                return Err(SubmitWaitError::Cancelled);
            }
            let (tx, rx) = oneshot::channel();
            let job = QueuedJob::new(Self::KIND, cancel.clone(), handing::<Self, R, F>(tx, job));
            let job = match backend.enter(job) {
                Ok(Entered::Admitted) => return Ok(JobHandle::new(rx)),
                Ok(Entered::Waiting(ticket)) => return admitted(backend, Self::KIND, cancel, ticket).await.map(|()| JobHandle::new(rx)),
                // Only a plain submission is refused for room.
                Ok(Entered::Wedged | Entered::Refused(_)) => return Err(SubmitWaitError::Wedged(LaneWedged { lane: Self::KIND })),
                Ok(Entered::ShutDown) => return Err(SubmitWaitError::ShutDown(Self::KIND)),
                Err(unordered) => unordered,
            };
            unordered(backend, Self::KIND, cancel, job).await.map(|()| JobHandle::new(rx))
        }
    }
}

/// [`LaneToken::submit_wait`] on a backend without an ordered queue: `submit` retried on each freed slot. A refused attempt
/// drops only its wrapper; the job stays in its slot for the next one.
async fn unordered(backend: &'static dyn crate::Backend, lane: LaneKind, cancel: &CancellationToken, job: QueuedJob) -> Result<(), SubmitWaitError> {
    let submitted = job.enqueued_at();
    let slot = Arc::new(Mutex::new(Some(job)));
    let attempt = || {
        let slot = slot.clone();
        let run = Box::new(move |answer: Answer| {
            if let Some(job) = slot.lock().unwrap_or_else(|p| p.into_inner()).take() {
                job.answer(answer);
            }
        });
        QueuedJob::new(lane, cancel.clone(), run).submitted_at(submitted)
    };
    let Some(freed) = backend.capacity_notify(lane) else {
        return backend.submit(attempt()).map_err(SubmitWaitError::Full);
    };
    loop {
        // Registered before the attempt, so a slot freed in between is not missed.
        let notified = freed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if cancel.is_cancelled() {
            return Err(SubmitWaitError::Cancelled);
        }
        if backend.lane_wedged(lane) {
            return Err(SubmitWaitError::Wedged(LaneWedged { lane }));
        }
        if backend.submit(attempt()).is_ok() {
            return Ok(());
        }
        if cancel.run_until_cancelled(notified).await.is_none() {
            return Err(SubmitWaitError::Cancelled);
        }
    }
}

/// Waits until `ticket`'s job is admitted. The lane decides the ticket's end; a cancelled token
/// withdraws the job here too (the lane's own listener may have done so first).
async fn admitted(backend: &'static dyn crate::Backend, lane: LaneKind, cancel: &CancellationToken, ticket: Ticket) -> Result<(), SubmitWaitError> {
    let mut place = Place { backend, lane, ticket: Some(ticket.clone()) };
    loop {
        if let Some(end) = ticket.end() {
            place.ticket = None;
            return match end {
                TicketEnd::Admitted => Ok(()),
                TicketEnd::Withdrawn => Err(SubmitWaitError::Cancelled),
                TicketEnd::Wedged => Err(SubmitWaitError::Wedged(LaneWedged { lane })),
                TicketEnd::ShutDown => Err(SubmitWaitError::ShutDown(lane)),
            };
        }
        // A job still held is taken out here; one the lane already answered has its ticket's end decided.
        if cancel.run_until_cancelled(ticket.changed()).await.is_none() && backend.withdraw(lane, &ticket) {
            place.ticket = None;
            return Err(SubmitWaitError::Cancelled);
        }
    }
}

/// A registered wait's claim on its job: dropped before the wait resolves `Ok`, it takes the job
/// out unrun if no thread took it yet, admitted or not.
struct Place {
    backend: &'static dyn crate::Backend,
    lane: LaneKind,
    ticket: Option<Ticket>,
}

impl Drop for Place {
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket.take() {
            self.backend.withdraw(self.lane, &ticket);
        }
    }
}

/// The body of a queued job: runs `job` with its lane proof and sends the result, or sends why
/// it never ran.
fn handing<L, R, F>(tx: oneshot::Sender<Result<R, JobDropped>>, job: F) -> Box<dyn FnOnce(Answer) + Send>
where
    L: LaneToken,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
    R: Send + 'static,
{
    Box::new(move |answer: Answer| match answer {
        Answer::Run => {
            let proof = InLane::<L>::new();
            let _ = tx.send(Ok(job(&proof)));
        }
        Answer::ShutDown => {
            let _ = tx.send(Err(JobDropped::ShutDown));
        }
        Answer::Wedged => {
            let _ = tx.send(Err(JobDropped::Wedged));
        }
        Answer::Cancelled => {
            let _ = tx.send(Err(JobDropped::Cancelled));
        }
        Answer::NotStarted => {
            let _ = tx.send(Err(JobDropped::NotStarted));
        }
    })
}

/// A dedicated-thread executor. Implemented only by the tokens of this module.
pub trait ThreadToken: sealed::Sealed + Copy + Send + Sync + 'static {
    const KIND: ThreadKind;

    /// Starts a named OS thread with the priority of [`Self::KIND`].
    fn spawn_thread<T, F>(self, name: &str, body: F) -> std::io::Result<std::thread::JoinHandle<T>>
    where
        F: FnOnce(&OnThread<Self>) -> T + Send + 'static,
        T: Send + 'static,
    {
        std::thread::Builder::new().name(name.to_owned()).spawn(move || {
            crate::backend().enter_thread(Self::KIND);
            body(&OnThread::<Self>::new())
        })
    }
}

macro_rules! lane_token {
    ($(#[$doc:meta])* $name:ident => $kind:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug)]
        pub struct $name {
            _private: (),
        }

        impl $name {
            pub(crate) const fn mint() -> Self {
                Self { _private: () }
            }
        }

        impl sealed::Sealed for $name {}

        impl LaneToken for $name {
            const KIND: LaneKind = LaneKind::$kind;
        }
    };
}

macro_rules! thread_token {
    ($(#[$doc:meta])* $name:ident => $kind:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug)]
        pub struct $name {
            _private: (),
        }

        impl $name {
            pub(crate) const fn mint() -> Self {
                Self { _private: () }
            }
        }

        impl sealed::Sealed for $name {}

        impl ThreadToken for $name {
            const KIND: ThreadKind = ThreadKind::$kind;
        }
    };
}

lane_token!(
    /// cpu-interactive: bounded encodes and decodes on interactive paths.
    CpuInteractive => CpuInteractive
);
lane_token!(
    /// cpu-bulk: history-sized or unbounded CPU work.
    CpuBulk => CpuBulk
);
lane_token!(
    /// io-interactive: byte-bounded read jobs only (RL §7.2).
    InteractiveIo => InteractiveIo
);
lane_token!(
    /// io-durability: writes and fsync; held by `DurabilityTask` and the settings writer.
    DurabilityIo => DurabilityIo
);
lane_token!(
    /// io-maintenance: scans, inspection, backups, GC.
    MaintenanceIo => MaintenanceIo
);
lane_token!(
    /// io-spawn: process creation.
    SpawnIo => SpawnIo
);
lane_token!(
    /// io-pty: PTY I/O.
    PtyIo => PtyIo
);
thread_token!(
    /// The management listener thread.
    ControlThread => Control
);
thread_token!(
    /// Computer-use session threads.
    ComputerThread => Computer
);
thread_token!(
    /// WebRTC video encoder threads.
    MediaThread => WebrtcMedia
);
thread_token!(
    /// SQLite writer threads (one per database).
    SqliteWriterThread => SqliteWriter
);
thread_token!(
    /// The effort judge's thread and the ONNX Runtime threads of its session.
    JudgeThread => EffortJudge
);

/// Every token of the process, minted once by [`crate::install`].
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct LaneTokens {
    pub cpu_interactive: CpuInteractive,
    pub cpu_bulk: CpuBulk,
    pub interactive_io: InteractiveIo,
    pub durability_io: DurabilityIo,
    pub maintenance_io: MaintenanceIo,
    pub spawn_io: SpawnIo,
    pub pty_io: PtyIo,
    pub control_thread: ControlThread,
    pub computer_thread: ComputerThread,
    pub media_thread: MediaThread,
    pub sqlite_writer_thread: SqliteWriterThread,
    pub judge_thread: JudgeThread,
}

impl LaneTokens {
    pub(crate) const fn mint() -> Self {
        Self {
            cpu_interactive: CpuInteractive::mint(),
            cpu_bulk: CpuBulk::mint(),
            interactive_io: InteractiveIo::mint(),
            durability_io: DurabilityIo::mint(),
            maintenance_io: MaintenanceIo::mint(),
            spawn_io: SpawnIo::mint(),
            pty_io: PtyIo::mint(),
            control_thread: ControlThread::mint(),
            computer_thread: ComputerThread::mint(),
            media_thread: MediaThread::mint(),
            sqlite_writer_thread: SqliteWriterThread::mint(),
            judge_thread: JudgeThread::mint(),
        }
    }
}
