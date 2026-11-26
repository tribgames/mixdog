//! The core's supervisor of the code graph helper ([`GraphHost`]).
//!
//! One actor, the driver [`GraphHost::new`] returns, serializes every transition of the helper:
//! `Absent -> Starting -> Running -> Retiring -> Absent`, and `Closed` once [`GraphHost::close`] has finished.
//!
//! - Admission: one dispatched demand (a query or a prewarm) at a time; the others wait in a bounded queue, and a call
//!   past its bound is answered [`HostError::Overloaded`] at once. Concurrent first callers share one startup, and a
//!   startup that fails fails the callers waiting for it. Nothing but a demand starts a helper. A startup has no timer:
//!   it ends at the helper's exit, when the last call waiting for it is withdrawn (the helper is killed), or at close.
//! - Cancellation: a queued call is removed alone. Cancelling the dispatched call, or dropping its future, kills its
//!   generation at once; the queued calls go to the next generation, which starts only after the old one has ended.
//! - Failure: a crash, the end of the helper's output, a malformed frame, an incompatible [`Ready`] or a pipe failure
//!   settles the dispatched call once with [`HostError::Transport`] and kills the generation. A dispatched call is never
//!   retried; a call not yet sent has not failed.
//! - End: a generation ends once both its process has been reaped and its output has been read to the end, so every reply
//!   it wrote is taken before its outcome is settled. A helper's death loses only its dispatched call: a root removal it
//!   had not answered is finished by its caller's disk routine after the end, under the same gate, before any next start.
//! - Idle: one deadline, [`HostConfig::idle`] after the last completed demand, armed only while nothing is queued or
//!   dispatched. At expiry the generation takes no more requests, drains and exits; a call arriving meanwhile waits for the
//!   old process to be reaped, so two helpers never write the cache at once. Write notices and status reads do not move it.
//! - Every frame is fenced by its generation and request id.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_rt::time::Instant;
use mixdog_spawn::owned::OwnedChild;
use mixdog_spawn::owned::OwnedCommand;
use mixdog_spawn::owned::OwnedPipes;
use mixdog_spawn::owned::Reaped;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::client::Client;
use crate::client::Events;
use crate::client::LinkEvent;
use crate::clock::Clock;
use crate::clock::RuntimeClock;
use crate::frame;
use crate::wire::Answer;
use crate::wire::Changed;
use crate::wire::FailureKind;
use crate::wire::FileIdentity;
use crate::wire::ForgetRoot;
use crate::wire::Forgot;
use crate::wire::FromWorker;
use crate::wire::MaintenanceResult;
use crate::wire::PROTOCOL_VERSION;
use crate::wire::Prewarm;
use crate::wire::Query;
use crate::wire::Ready;
use crate::wire::Refusal;
use crate::wire::Reply;
use crate::wire::RequestId;
use crate::wire::ToWorker;
use crate::wire::Warmed;
use crate::wire::WorkerFailure;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// How long a helper with nothing to do lives on.
pub const IDLE: Duration = Duration::from_secs(600);
/// The waiting calls a host admits: the bound of the maintenance lane the graph's calls queued on in the core.
pub const QUEUE_CAPACITY: usize = 1024;

pub type Observer = Arc<dyn Fn(&HostEvent) + Send + Sync>;

pub struct HostConfig {
    /// The helper: this executable's `graph-worker`, its cache directory given at launch.
    pub command: OwnedCommand,
    /// Calls that may wait while one is dispatched.
    pub queue_capacity: usize,
    pub idle: Duration,
    /// How long an idle helper may take to drain before it is killed.
    pub drain_limit: Duration,
    pub clock: Arc<dyn Clock>,
    /// Sees every transition, in order, on the actor.
    pub observer: Option<Observer>,
}

impl HostConfig {
    pub fn new(command: OwnedCommand, drain_limit: Duration) -> Self {
        Self { command, queue_capacity: QUEUE_CAPACITY, idle: IDLE, drain_limit, clock: Arc::new(RuntimeClock), observer: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostState {
    Absent,
    Starting,
    Running,
    Retiring,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostStatus {
    pub state: HostState,
    pub generation: Option<u64>,
    pub pid: Option<u32>,
    pub queued: usize,
    pub dispatched: bool,
}

impl HostStatus {
    const ABSENT: Self = Self { state: HostState::Absent, generation: None, pid: None, queued: 0, dispatched: false };
    const CLOSED: Self = Self { state: HostState::Closed, generation: None, pid: None, queued: 0, dispatched: false };
}

/// Whether a prewarm may start a helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// An explicit prewarm: demand, like a query.
    Demand,
    /// The background prewarmer: warms a helper that is starting or running, never starts one.
    IfRunning,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostError {
    /// The queue is full.
    Overloaded,
    /// The caller cancelled.
    Cancelled,
    /// The host is closing or closed.
    Closed,
    /// A background prewarm found no helper to warm.
    NotRunning,
    /// The dispatcher refused the query.
    Refused(Refusal),
    /// The helper failed the request.
    Failed(WorkerFailure),
    /// The helper or its pipes failed; its generation has been killed.
    Transport(TransportError),
    /// The request could not be encoded (it is over the message limit).
    Encode(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::Overloaded => f.write_str("the code graph helper's queue is full"),
            HostError::Cancelled => f.write_str("cancelled"),
            HostError::Closed => f.write_str("the code graph helper is closed"),
            HostError::NotRunning => f.write_str("no code graph helper is running"),
            HostError::Refused(refusal) => f.write_str(&refusal.message),
            HostError::Failed(failure) => f.write_str(&failure.message),
            HostError::Transport(error) => write!(f, "the code graph helper failed: {error}"),
            HostError::Encode(error) => write!(f, "the request could not be sent: {error}"),
        }
    }
}

impl std::error::Error for HostError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// The helper could not be started.
    Launch(String),
    /// The helper exited (its exit code, if it has one).
    Exited(Option<i32>),
    /// The helper's output ended.
    Eof,
    Malformed(String),
    /// The helper speaks another protocol version.
    Incompatible {
        version: u32,
    },
    /// A pipe or its thread failed.
    Pipe(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Launch(error) => write!(f, "it could not be started: {error}"),
            TransportError::Exited(Some(code)) => write!(f, "it exited with code {code}"),
            TransportError::Exited(None) => f.write_str("it was ended"),
            TransportError::Eof => f.write_str("its output ended"),
            TransportError::Malformed(error) => write!(f, "its output is malformed: {error}"),
            TransportError::Incompatible { version } => write!(f, "it speaks protocol {version}, not {PROTOCOL_VERSION}"),
            TransportError::Pipe(error) => write!(f, "its pipe failed: {error}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    /// No helper was running.
    NoChild,
    /// The helper drained and exited by itself.
    Drained,
    /// The helper was killed: it did not drain within the budget, or could not drain.
    Killed,
}

/// How a call ended, as [`HostEvent::Settled`] reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Answered,
    Refused,
    Failed,
    Maintenance,
    Overloaded,
    Cancelled,
    NotRunning,
    Closed,
    Transport,
    Encode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillReason {
    /// The dispatched call was cancelled, or every call waiting for the startup was.
    Cancelled,
    /// The helper or its pipes failed.
    Transport,
    /// An idle helper did not drain within [`HostConfig::drain_limit`].
    DrainLimit,
    /// The host is closing: the helper had not started serving, or did not drain within the budget.
    Close,
}

/// One transition, as the actor makes it. Every call has exactly one `Settled`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostEvent {
    Queued { ticket: u64 },
    Spawned { generation: u64, pid: u32 },
    Ready { generation: u64, pid: u32 },
    Dispatched { generation: u64, ticket: u64, request: RequestId },
    Settled { ticket: u64, outcome: Outcome },
    IdleArmed { generation: u64 },
    Draining { generation: u64, pid: u32 },
    Killed { generation: u64, pid: u32, why: KillReason },
    Reaped { generation: u64, pid: u32, code: Option<i32> },
    Closed { outcome: CloseOutcome },
}

/// The core's handle on the helper. Every method is answered by the driver [`GraphHost::new`] returns, which the caller
/// spawns; it ends once every handle is dropped, and its drop kills a helper still running.
pub struct GraphHost {
    commands: mpsc::UnboundedSender<Command>,
    status: watch::Receiver<HostStatus>,
    tickets: AtomicU64,
}

impl GraphHost {
    pub fn new(config: HostConfig) -> (Self, impl Future<Output = ()> + Send + 'static) {
        let (commands, received) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(HostStatus::ABSENT);
        let actor = Actor {
            command: config.command,
            capacity: config.queue_capacity,
            idle_after: config.idle,
            drain_limit: config.drain_limit,
            clock: config.clock,
            observer: config.observer,
            commands: received,
            events,
            events_tx,
            status: status_tx,
            phase: Phase::Absent,
            queue: VecDeque::new(),
            active: None,
            deferred: VecDeque::new(),
            offline_reply: None,
            generations: 0,
            reference: None,
            launch: None,
            exit: None,
            offline: None,
            idle: None,
            deadline: None,
            closing: None,
            closed: None,
        };
        (Self { commands, status, tickets: AtomicU64::new(0) }, actor.run())
    }

    /// One `code_graph` call. Cancelling `cancel`, or dropping this future, withdraws it: a queued call alone, a
    /// dispatched one with its generation.
    pub async fn query(&self, query: Query, cancel: &CancellationToken) -> Result<Answer, HostError> {
        let (reply, answer) = oneshot::channel();
        self.demand(true, Work::Query { query, reply }, answer, cancel).await
    }

    pub async fn prewarm(&self, prewarm: Prewarm, start: Start, cancel: &CancellationToken) -> Result<Warmed, HostError> {
        let (reply, answer) = oneshot::channel();
        self.demand(start == Start::Demand, Work::Prewarm { prewarm, reply }, answer, cancel).await
    }

    /// Write notices: sent to a helper that is starting or running, ahead of any request admitted after them; dropped when
    /// there is none (a new helper verifies what it reuses from disk).
    pub fn changed(&self, changed: Changed) {
        let _ = self.commands.send(Command::Changed(changed));
    }

    /// Removes one root from the cache: the running helper does it, serialized with its refresh; with no helper, `offline`
    /// does it on the disk while no helper can start. A helper starting or retiring is waited for, and one that ends
    /// before it answers leaves the removal to `offline`. An accepted removal is finished even if this future is dropped.
    pub async fn forget_root<F, Fut>(&self, forget: ForgetRoot, offline: F) -> Result<Forgot, HostError>
    where
        F: FnOnce(ForgetRoot) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Forgot, String>> + Send + 'static,
    {
        let ticket = self.ticket();
        let (reply, answer) = oneshot::channel();
        let offline: Offline = Box::new(move |forget| Box::pin(offline(forget)));
        if self.commands.send(Command::Forget(Removal { ticket, forget, offline, reply: Some(reply) })).is_err() {
            return Err(HostError::Closed);
        }
        self.settled(ticket, answer, &CancellationToken::new()).await
    }

    /// Stops admissions, answers every waiting and dispatched call with [`HostError::Closed`], asks a running helper to
    /// drain, and waits for its end; at `budget` it is killed and reaped. Root removals already accepted are finished
    /// within the budget (by the draining helper, or on the disk once it has ended); past it they answer `Closed`. Later
    /// calls answer the same outcome.
    pub async fn close(&self, budget: Duration) -> CloseOutcome {
        let (reply, outcome) = oneshot::channel();
        if self.commands.send(Command::Close { budget, reply }).is_err() {
            // The driver is gone, and a helper with it.
            return CloseOutcome::NoChild;
        }
        outcome.await.unwrap_or(CloseOutcome::NoChild)
    }

    /// The host now; reading it changes nothing.
    pub fn status(&self) -> HostStatus {
        self.status.borrow().clone()
    }

    /// Waits until the status satisfies `until`.
    pub async fn wait_status(&self, until: impl FnMut(&HostStatus) -> bool) -> HostStatus {
        let mut status = self.status.clone();
        match status.wait_for(until).await {
            Ok(status) => status.clone(),
            Err(_) => HostStatus::CLOSED,
        }
    }

    fn ticket(&self) -> u64 {
        self.tickets.fetch_add(1, Ordering::Relaxed) + 1
    }

    async fn demand<T>(&self, demand: bool, work: Work, answer: oneshot::Receiver<Result<T, HostError>>, cancel: &CancellationToken) -> Result<T, HostError> {
        let ticket = self.ticket();
        if self.commands.send(Command::Demand(Queued { ticket, demand, work })).is_err() {
            return Err(HostError::Closed);
        }
        self.settled(ticket, answer, cancel).await
    }

    async fn settled<T>(&self, ticket: u64, answer: oneshot::Receiver<Result<T, HostError>>, cancel: &CancellationToken) -> Result<T, HostError> {
        let withdraw = Withdraw { commands: &self.commands, ticket: Some(ticket) };
        let result = tokio::select! {
            biased;
            answered = answer => answered.unwrap_or(Err(HostError::Closed)),
            () = cancel.cancelled() => return Err(HostError::Cancelled),
        };
        withdraw.disarm();
        result
    }
}

/// Withdraws its call when dropped before the call was answered.
struct Withdraw<'a> {
    commands: &'a mpsc::UnboundedSender<Command>,
    ticket: Option<u64>,
}

impl Withdraw<'_> {
    fn disarm(mut self) {
        self.ticket = None;
    }
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket {
            let _ = self.commands.send(Command::Abandon { ticket });
        }
    }
}

enum Command {
    Demand(Queued),
    Abandon { ticket: u64 },
    Changed(Changed),
    Forget(Removal),
    Close { budget: Duration, reply: oneshot::Sender<CloseOutcome> },
}

struct Queued {
    ticket: u64,
    /// May start a helper (and completes a demand for the idle deadline).
    demand: bool,
    work: Work,
}

enum Work {
    Query { query: Query, reply: oneshot::Sender<Result<Answer, HostError>> },
    Prewarm { prewarm: Prewarm, reply: oneshot::Sender<Result<Warmed, HostError>> },
}

impl Work {
    fn message(self, id: RequestId) -> (ToWorker, Waiter) {
        match self {
            Work::Query { query, reply } => (ToWorker::Query { id, query }, Waiter::Query(reply)),
            Work::Prewarm { prewarm, reply } => (ToWorker::Prewarm { id, prewarm }, Waiter::Prewarm(reply)),
        }
    }

    fn fail(self, error: HostError) {
        match self {
            Work::Query { reply, .. } => drop(reply.send(Err(error))),
            Work::Prewarm { reply, .. } => drop(reply.send(Err(error))),
        }
    }
}

enum Waiter {
    Query(oneshot::Sender<Result<Answer, HostError>>),
    Prewarm(oneshot::Sender<Result<Warmed, HostError>>),
}

impl Waiter {
    fn fail(self, error: HostError) {
        match self {
            Waiter::Query(reply) => drop(reply.send(Err(error))),
            Waiter::Prewarm(reply) => drop(reply.send(Err(error))),
        }
    }

    /// Whether `reply` answers this request.
    fn fits(&self, reply: &Reply) -> bool {
        matches!(
            (self, reply),
            (_, Reply::Failed { .. })
                | (Waiter::Query(_), Reply::Answer { .. } | Reply::Refused { .. })
                | (Waiter::Prewarm(_), Reply::Maintenance { result: MaintenanceResult::Warmed { .. } })
        )
    }

    /// Answers with `reply`, which [`Self::fits`].
    fn answer(self, reply: Reply) -> Outcome {
        match (self, reply) {
            (waiter, Reply::Failed { failure }) => {
                waiter.fail(HostError::Failed(failure));
                Outcome::Failed
            }
            (Waiter::Query(reply), Reply::Answer { answer }) => {
                drop(reply.send(Ok(answer)));
                Outcome::Answered
            }
            (Waiter::Query(reply), Reply::Refused { refusal }) => {
                drop(reply.send(Err(HostError::Refused(refusal))));
                Outcome::Refused
            }
            (Waiter::Prewarm(reply), Reply::Maintenance { result: MaintenanceResult::Warmed { warmed } }) => {
                drop(reply.send(Ok(warmed)));
                Outcome::Maintenance
            }
            (waiter, _) => {
                waiter.fail(HostError::Transport(TransportError::Malformed("a reply that does not answer its request".to_owned())));
                Outcome::Transport
            }
        }
    }
}

type ForgetReply = oneshot::Sender<Result<Forgot, HostError>>;
type Offline = Box<dyn FnOnce(ForgetRoot) -> BoxFuture<Result<Forgot, String>> + Send>;

struct Removal {
    ticket: u64,
    forget: ForgetRoot,
    offline: Offline,
    /// `None` once its caller withdrew: the removal is still finished.
    reply: Option<ForgetReply>,
}

struct Active {
    ticket: u64,
    request: RequestId,
    demand: bool,
    waiter: Waiter,
}

struct Generation {
    number: u64,
    pid: u32,
    child: OwnedChild,
    client: Option<Client>,
    next_request: RequestId,
    /// Root removals sent and not answered; whatever is left at the generation's end is finished on the disk.
    live: HashMap<RequestId, Removal>,
    /// Requests whose callers were answered without the helper: their replies are accepted and dropped.
    orphans: HashSet<RequestId>,
    /// The process has been reaped, with its exit code if it has one.
    exit_code: Option<Option<i32>>,
    /// The reader has read the helper's output to its end (or there is no reader).
    output_ended: bool,
}

impl Generation {
    fn request(&mut self) -> RequestId {
        let id = self.next_request;
        self.next_request += 1;
        id
    }

    /// Queues `message` for the helper; false when it cannot be.
    fn send(&self, message: &ToWorker) -> Result<bool, frame::FrameError> {
        let bytes = frame::encode(message)?;
        Ok(self.client.as_ref().is_some_and(|client| client.send(bytes)))
    }
}

enum Phase {
    Absent,
    /// The process is being created.
    Launching {
        number: u64,
    },
    /// Created; its [`Ready`] has not come.
    Starting(Generation),
    Running(Generation),
    /// Waiting for the generation's end: asked to drain (`drain`), or killed.
    Retiring {
        generation: Generation,
        drain: Option<RequestId>,
        killed: bool,
    },
    Closed,
}

struct Closing {
    waiters: Vec<oneshot::Sender<CloseOutcome>>,
    outcome: CloseOutcome,
    /// The budget has passed: no more removals are started.
    spent: bool,
}

enum Wake {
    Command(Command),
    Gone,
    Event((u64, LinkEvent)),
    Reaped((u64, Reaped)),
    Launched((u64, io::Result<(OwnedChild, OwnedPipes)>)),
    Offline(Result<Forgot, String>),
    Idle,
    Deadline,
}

struct Actor {
    command: OwnedCommand,
    capacity: usize,
    idle_after: Duration,
    drain_limit: Duration,
    clock: Arc<dyn Clock>,
    observer: Option<Observer>,
    commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedReceiver<(u64, LinkEvent)>,
    events_tx: Events,
    status: watch::Sender<HostStatus>,
    phase: Phase,
    queue: VecDeque<Queued>,
    active: Option<Active>,
    /// Root removals waiting for a helper to finish starting, or for a generation to end.
    deferred: VecDeque<Removal>,
    /// The caller of the removal [`Self::offline`] runs, unless it withdrew.
    offline_reply: Option<(u64, ForgetReply)>,
    generations: u64,
    /// The last completed demand, or the current generation's start: the idle deadline runs from it.
    reference: Option<Instant>,
    launch: Option<BoxFuture<(u64, io::Result<(OwnedChild, OwnedPipes)>)>>,
    exit: Option<BoxFuture<(u64, Reaped)>>,
    /// A removal on the disk with no helper; no helper starts while it runs.
    offline: Option<BoxFuture<Result<Forgot, String>>>,
    idle: Option<BoxFuture<()>>,
    /// A drain's bound, or a close's.
    deadline: Option<(Instant, BoxFuture<()>)>,
    closing: Option<Closing>,
    closed: Option<CloseOutcome>,
}

async fn next<T>(slot: &mut Option<BoxFuture<T>>) -> T {
    match slot {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

async fn next_deadline(slot: &mut Option<(Instant, BoxFuture<()>)>) {
    match slot {
        Some((_, future)) => future.await,
        None => std::future::pending().await,
    }
}

impl Actor {
    async fn run(mut self) {
        loop {
            // A call arriving with the idle deadline is taken first: it keeps the helper.
            let wake = tokio::select! {
                biased;
                command = self.commands.recv() => command.map_or(Wake::Gone, Wake::Command),
                Some(event) = self.events.recv() => Wake::Event(event),
                reaped = next(&mut self.exit) => Wake::Reaped(reaped),
                launched = next(&mut self.launch) => Wake::Launched(launched),
                removed = next(&mut self.offline) => Wake::Offline(removed),
                () = next(&mut self.idle) => Wake::Idle,
                () = next_deadline(&mut self.deadline) => Wake::Deadline,
            };
            match wake {
                Wake::Command(command) => self.command(command),
                // Every handle is gone: the helper goes with the actor (its handle's drop kills it).
                Wake::Gone => return,
                Wake::Event((generation, event)) => self.event(generation, event),
                Wake::Reaped((generation, reaped)) => {
                    self.exit = None;
                    self.reaped(generation, reaped);
                }
                Wake::Launched((generation, launched)) => {
                    self.launch = None;
                    self.launched(generation, launched);
                }
                Wake::Offline(removed) => {
                    self.offline = None;
                    self.offline_done(removed);
                }
                Wake::Idle => {
                    self.idle = None;
                    self.idle_expired();
                }
                Wake::Deadline => {
                    self.deadline = None;
                    self.deadline_passed();
                }
            }
            self.pump();
            self.publish();
        }
    }

    fn emit(&self, event: HostEvent) {
        tracing::debug!(target: "code_graph", ?event, "graph host");
        if let Some(observer) = &self.observer {
            observer(&event);
        }
    }

    fn settle_event(&self, ticket: u64, outcome: Outcome) {
        self.emit(HostEvent::Settled { ticket, outcome });
    }

    fn generation(&self) -> Option<&Generation> {
        match &self.phase {
            Phase::Starting(generation) | Phase::Running(generation) | Phase::Retiring { generation, .. } => Some(generation),
            _ => None,
        }
    }

    fn closing(&self) -> bool {
        self.closing.is_some() || matches!(self.phase, Phase::Closed)
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Demand(queued) => self.admit(queued),
            Command::Abandon { ticket } => self.withdraw(ticket),
            Command::Changed(changed) => self.changed(changed),
            Command::Forget(removal) => self.forget(removal),
            Command::Close { budget, reply } => self.close(budget, reply),
        }
    }

    fn admit(&mut self, queued: Queued) {
        let refusal = if self.closing() {
            Some((HostError::Closed, Outcome::Closed))
        } else if !queued.demand && matches!(self.phase, Phase::Absent | Phase::Retiring { .. }) {
            Some((HostError::NotRunning, Outcome::NotRunning))
        } else if self.queue.len() >= self.capacity {
            Some((HostError::Overloaded, Outcome::Overloaded))
        } else {
            None
        };
        if let Some((error, outcome)) = refusal {
            self.settle_event(queued.ticket, outcome);
            queued.work.fail(error);
            return;
        }
        self.idle = None;
        self.emit(HostEvent::Queued { ticket: queued.ticket });
        self.queue.push_back(queued);
    }

    /// A withdrawn removal loses only its answer: the removal itself is finished.
    fn withdraw(&mut self, ticket: u64) {
        if let Some(at) = self.queue.iter().position(|queued| queued.ticket == ticket) {
            drop(self.queue.remove(at));
            self.settle_event(ticket, Outcome::Cancelled);
            // Nobody waits for this startup any more.
            if self.queue.is_empty() && matches!(self.phase, Phase::Starting(_)) {
                self.kill(KillReason::Cancelled);
            }
        } else if self.active.take_if(|active| active.ticket == ticket).is_some() {
            self.settle_event(ticket, Outcome::Cancelled);
            self.kill(KillReason::Cancelled);
        } else if self.offline_reply.take_if(|(waiting, _)| *waiting == ticket).is_some() {
            self.settle_event(ticket, Outcome::Cancelled);
        } else {
            let generation = match &mut self.phase {
                Phase::Starting(generation) | Phase::Running(generation) | Phase::Retiring { generation, .. } => Some(generation),
                _ => None,
            };
            let live = generation.into_iter().flat_map(|generation| generation.live.values_mut());
            if let Some(removal) = live.chain(self.deferred.iter_mut()).find(|removal| removal.ticket == ticket)
                && removal.reply.take().is_some()
            {
                self.settle_event(ticket, Outcome::Cancelled);
            }
        }
    }

    fn generation_mut(&mut self) -> Option<&mut Generation> {
        match &mut self.phase {
            Phase::Starting(generation) | Phase::Running(generation) | Phase::Retiring { generation, .. } => Some(generation),
            _ => None,
        }
    }

    fn changed(&mut self, changed: Changed) {
        let (Phase::Starting(generation) | Phase::Running(generation)) = &self.phase else { return };
        // Notices too large to send are a change at an unknown location: every root verifies its files again.
        let sent = generation
            .send(&ToWorker::Changed { changed })
            .or_else(|_| generation.send(&ToWorker::Changed { changed: Changed { files: vec![FileIdentity::Unknown] } }));
        if !matches!(sent, Ok(true)) {
            self.fail_generation(TransportError::Pipe("the helper's input is closed".to_owned()));
        }
    }

    fn forget(&mut self, removal: Removal) {
        if self.closing() {
            if let Some(reply) = removal.reply {
                self.settle_event(removal.ticket, Outcome::Closed);
                drop(reply.send(Err(HostError::Closed)));
            }
            return;
        }
        match self.phase {
            Phase::Running(_) => self.send_removal(removal),
            Phase::Absent if self.offline.is_none() => self.start_offline(removal),
            _ => self.deferred.push_back(removal),
        }
    }

    fn send_removal(&mut self, removal: Removal) {
        let Phase::Running(generation) = &mut self.phase else {
            self.deferred.push_front(removal);
            return;
        };
        let id = generation.request();
        match generation.send(&ToWorker::ForgetRoot { id, forget: removal.forget.clone() }) {
            Ok(sent) => {
                generation.live.insert(id, removal);
                if !sent {
                    self.fail_generation(TransportError::Pipe("the helper's input is closed".to_owned()));
                }
            }
            Err(error) => {
                if let Some(reply) = removal.reply {
                    self.settle_event(removal.ticket, Outcome::Encode);
                    drop(reply.send(Err(HostError::Encode(error.to_string()))));
                }
            }
        }
    }

    fn start_offline(&mut self, removal: Removal) {
        let Removal { ticket, forget, offline, reply } = removal;
        self.offline = Some(offline(forget));
        self.offline_reply = reply.map(|reply| (ticket, reply));
    }

    fn offline_done(&mut self, removed: Result<Forgot, String>) {
        let Some((ticket, reply)) = self.offline_reply.take() else { return };
        let outcome = if removed.is_ok() { Outcome::Maintenance } else { Outcome::Failed };
        self.settle_event(ticket, outcome);
        drop(reply.send(removed.map_err(|message| HostError::Failed(WorkerFailure { kind: FailureKind::Io, message }))));
    }

    fn close(&mut self, budget: Duration, reply: oneshot::Sender<CloseOutcome>) {
        if let Some(outcome) = self.closed {
            let _ = reply.send(outcome);
            return;
        }
        let at = self.clock.now() + budget;
        if let Some(closing) = &mut self.closing {
            closing.waiters.push(reply);
            self.arm_deadline(at);
            return;
        }
        self.closing = Some(Closing { waiters: vec![reply], outcome: CloseOutcome::NoChild, spent: false });
        self.idle = None;
        self.fail_queue(&HostError::Closed, Outcome::Closed);
        if let Some(active) = self.active.take() {
            if let Some(generation) = self.generation_mut() {
                generation.orphans.insert(active.request);
            }
            self.settle_event(active.ticket, Outcome::Closed);
            active.waiter.fail(HostError::Closed);
        }
        match self.phase {
            Phase::Running(_) => self.drain(at),
            Phase::Starting(_) => self.kill(KillReason::Close),
            _ => {}
        }
        // The budget, not an idle drain's limit, bounds the drain, the wait for the end and the removals still to finish.
        self.deadline = Some((at, self.clock.sleep_until(at)));
    }

    fn arm_deadline(&mut self, at: Instant) {
        if self.deadline.as_ref().is_some_and(|(armed, _)| *armed <= at) {
            return;
        }
        self.deadline = Some((at, self.clock.sleep_until(at)));
    }

    /// Asks the running generation to drain and exit, killed at `at` if it has not.
    fn drain(&mut self, at: Instant) {
        let mut generation = match std::mem::replace(&mut self.phase, Phase::Absent) {
            Phase::Running(generation) => generation,
            other => {
                self.phase = other;
                return;
            }
        };
        let id = generation.request();
        let sent = generation.send(&ToWorker::DrainAndExit { id });
        self.emit(HostEvent::Draining { generation: generation.number, pid: generation.pid });
        self.phase = Phase::Retiring { generation, drain: Some(id), killed: false };
        match sent {
            Ok(true) => self.arm_deadline(at),
            Ok(false) | Err(_) => self.kill(KillReason::Transport),
        }
    }

    /// Kills the current generation; it ends once it is reaped and its output is read.
    fn kill(&mut self, why: KillReason) {
        let generation = match std::mem::replace(&mut self.phase, Phase::Absent) {
            Phase::Starting(generation) | Phase::Running(generation) | Phase::Retiring { generation, killed: false, .. } => generation,
            other => {
                self.phase = other;
                return;
            }
        };
        generation.child.kill();
        self.emit(HostEvent::Killed { generation: generation.number, pid: generation.pid, why });
        self.idle = None;
        self.phase = Phase::Retiring { generation, drain: None, killed: true };
    }

    /// The generation failed: its dispatched call is answered with `error`, and so are the callers waiting for it to start;
    /// then it is killed. Its root removals wait for its end.
    fn fail_generation(&mut self, error: TransportError) {
        let starting = matches!(self.phase, Phase::Starting(_));
        let error = HostError::Transport(error);
        if let Some(active) = self.active.take() {
            self.settle_event(active.ticket, Outcome::Transport);
            active.waiter.fail(error.clone());
        }
        if starting {
            self.fail_queue(&error, Outcome::Transport);
        }
        self.kill(KillReason::Transport);
    }

    fn fail_queue(&mut self, error: &HostError, outcome: Outcome) {
        for queued in std::mem::take(&mut self.queue) {
            self.settle_event(queued.ticket, outcome);
            queued.work.fail(error.clone());
        }
    }

    /// A killed generation still delivers what it wrote: only its root removals' replies are taken, and failing it again
    /// does nothing.
    fn event(&mut self, number: u64, event: LinkEvent) {
        let Some(generation) = self.generation_mut().filter(|generation| generation.number == number) else { return };
        let ended = matches!(event, LinkEvent::Eof | LinkEvent::Malformed(_));
        generation.output_ended |= ended;
        let exit_code = generation.exit_code;
        match event {
            LinkEvent::Message(FromWorker::Ready { ready }) => self.ready(ready),
            LinkEvent::Message(FromWorker::Reply { id, reply }) => self.reply(id, reply),
            LinkEvent::Eof if matches!(self.phase, Phase::Retiring { .. }) => {}
            LinkEvent::Eof => self.fail_generation(exit_code.map_or(TransportError::Eof, TransportError::Exited)),
            LinkEvent::Malformed(error) => self.fail_generation(TransportError::Malformed(error)),
            LinkEvent::WriteFailed(error) => self.fail_generation(TransportError::Pipe(error)),
        }
        if ended {
            self.try_end();
        }
    }

    fn ready(&mut self, ready: Ready) {
        match std::mem::replace(&mut self.phase, Phase::Absent) {
            Phase::Starting(generation) if ready.version == PROTOCOL_VERSION => {
                self.emit(HostEvent::Ready { generation: generation.number, pid: generation.pid });
                self.reference = Some(self.clock.now());
                self.phase = Phase::Running(generation);
            }
            Phase::Starting(generation) => {
                self.phase = Phase::Starting(generation);
                self.fail_generation(TransportError::Incompatible { version: ready.version });
            }
            other => {
                self.phase = other;
                self.fail_generation(TransportError::Malformed("a second Ready".to_owned()));
            }
        }
    }

    fn reply(&mut self, id: RequestId, reply: Reply) {
        if matches!(self.phase, Phase::Starting(_)) {
            return self.fail_generation(TransportError::Malformed("a reply before Ready".to_owned()));
        }
        if self.active.as_ref().is_some_and(|active| active.request == id) {
            if !self.active.as_ref().is_some_and(|active| active.waiter.fits(&reply)) {
                return self.fail_generation(TransportError::Malformed(format!("reply {id} does not answer its request")));
            }
            let Some(active) = self.active.take() else { return };
            let outcome = active.waiter.answer(reply);
            if active.demand {
                self.reference = Some(self.clock.now());
            }
            return self.settle_event(active.ticket, outcome);
        }
        let draining = matches!(self.phase, Phase::Retiring { drain: Some(drain), .. } if drain == id);
        let Some(generation) = self.generation_mut() else { return };
        if generation.orphans.remove(&id) {
            return;
        }
        if let Some(removal) = generation.live.remove(&id) {
            let (answer, outcome) = match reply {
                Reply::Maintenance { result: MaintenanceResult::Forgot { forgot } } => (Ok(forgot), Outcome::Maintenance),
                Reply::Failed { failure } => (Err(HostError::Failed(failure)), Outcome::Failed),
                _ => {
                    generation.live.insert(id, removal);
                    return self.fail_generation(TransportError::Malformed(format!("reply {id} does not answer its request")));
                }
            };
            if let Some(waiter) = removal.reply {
                self.settle_event(removal.ticket, outcome);
                drop(waiter.send(answer));
            }
            return;
        }
        match reply {
            Reply::DrainAck { ack } if draining => {
                if let Some(failure) = ack.failure {
                    tracing::warn!(target: "code_graph", message = %failure.message, "the code graph helper could not flush every staged write");
                }
            }
            _ => self.fail_generation(TransportError::Malformed(format!("reply {id} answers no request"))),
        }
    }

    fn launch(&mut self) {
        self.generations += 1;
        let number = self.generations;
        let command = self.command.clone();
        self.launch = Some(Box::pin(async move { (number, OwnedChild::spawn(&command).await) }));
        self.phase = Phase::Launching { number };
    }

    fn launched(&mut self, number: u64, launched: io::Result<(OwnedChild, OwnedPipes)>) {
        let (child, pipes) = match launched {
            Ok(started) => started,
            Err(error) => {
                self.phase = Phase::Absent;
                return self.fail_queue(&HostError::Transport(TransportError::Launch(error.to_string())), Outcome::Transport);
            }
        };
        let pid = child.id();
        self.emit(HostEvent::Spawned { generation: number, pid });
        let reaped = child.reaped();
        self.exit = Some(Box::pin(async move { (number, reaped.wait().await) }));
        let client = Client::open(number, pipes, &self.events_tx);
        let opened = client.as_ref().map(|_| ()).map_err(|error| error.to_string());
        self.phase = Phase::Starting(Generation {
            number,
            pid,
            child,
            output_ended: client.is_err(),
            client: client.ok(),
            next_request: 1,
            live: HashMap::new(),
            orphans: HashSet::new(),
            exit_code: None,
        });
        match opened {
            Err(error) => self.fail_generation(TransportError::Pipe(error)),
            Ok(()) if self.closing.is_some() => self.kill(KillReason::Close),
            // Every call that started it has been withdrawn.
            Ok(()) if self.queue.is_empty() => self.kill(KillReason::Cancelled),
            Ok(()) => {}
        }
    }

    fn reaped(&mut self, number: u64, reaped: Reaped) {
        let Some(generation) = self.generation_mut().filter(|generation| generation.number == number) else { return };
        let code = match &reaped {
            Reaped::Exited(status) => status.code(),
            Reaped::Lost(_) => None,
        };
        generation.exit_code = Some(code);
        let pid = generation.pid;
        self.emit(HostEvent::Reaped { generation: number, pid, code });
        self.try_end();
    }

    /// Ends the generation once it has been reaped and its output read to the end: every reply it wrote has been taken,
    /// and the root removals it did not answer go to the front of the deferred ones, to be finished on the disk first.
    /// Output ends only through [`Self::fail_generation`] or a drain, so the generation is retiring here.
    fn try_end(&mut self) {
        if self.generation().is_none_or(|generation| generation.exit_code.is_none() || !generation.output_ended) {
            return;
        }
        let (mut generation, killed) = match std::mem::replace(&mut self.phase, Phase::Absent) {
            Phase::Retiring { generation, killed, .. } => (generation, killed),
            other => {
                self.phase = other;
                return;
            }
        };
        let mut unanswered: Vec<(RequestId, Removal)> = generation.live.drain().collect();
        unanswered.sort_unstable_by_key(|(id, _)| *id);
        for (_, removal) in unanswered.into_iter().rev() {
            self.deferred.push_front(removal);
        }
        self.idle = None;
        self.reference = None;
        match &mut self.closing {
            Some(closing) => closing.outcome = if killed { CloseOutcome::Killed } else { CloseOutcome::Drained },
            None => self.deadline = None,
        }
    }

    fn idle_expired(&mut self) {
        if matches!(self.phase, Phase::Running(_)) && self.active.is_none() && self.queue.is_empty() && self.closing.is_none() {
            let at = self.clock.now() + self.drain_limit;
            self.drain(at);
        }
    }

    fn deadline_passed(&mut self) {
        if let Some(closing) = &mut self.closing {
            closing.spent = true;
        }
        match self.phase {
            Phase::Retiring { killed: false, .. } => {
                self.kill(if self.closing.is_some() { KillReason::Close } else { KillReason::DrainLimit });
            }
            Phase::Launching { .. } if self.closing.is_some() => {
                // The launch's owner thread kills and reaps a child it started for no one.
                self.launch = None;
                self.phase = Phase::Absent;
                if let Some(closing) = &mut self.closing {
                    closing.outcome = CloseOutcome::Killed;
                }
            }
            Phase::Absent if self.closing.is_some() => {
                self.offline = None;
                if let Some((ticket, reply)) = self.offline_reply.take() {
                    self.settle_event(ticket, Outcome::Closed);
                    drop(reply.send(Err(HostError::Closed)));
                }
            }
            _ => {}
        }
    }

    /// Moves the host on after a wake: starts, dispatches, arms the idle deadline, or finishes a close.
    fn pump(&mut self) {
        match self.phase {
            Phase::Absent => self.pump_absent(),
            Phase::Running(_) => self.pump_running(),
            _ => {}
        }
    }

    fn pump_absent(&mut self) {
        if self.offline.is_some() {
            return;
        }
        if !self.closing.as_ref().is_some_and(|closing| closing.spent)
            && let Some(removal) = self.deferred.pop_front()
        {
            return self.start_offline(removal);
        }
        if self.closing.is_some() {
            return self.finish_close();
        }
        // A call that may not start a helper is not served by one it would start.
        for queued in std::mem::take(&mut self.queue) {
            if queued.demand {
                self.queue.push_back(queued);
            } else {
                self.settle_event(queued.ticket, Outcome::NotRunning);
                queued.work.fail(HostError::NotRunning);
            }
        }
        if !self.queue.is_empty() {
            self.launch();
        }
    }

    fn pump_running(&mut self) {
        while matches!(self.phase, Phase::Running(_))
            && let Some(removal) = self.deferred.pop_front()
        {
            self.send_removal(removal);
        }
        while self.active.is_none() && matches!(self.phase, Phase::Running(_)) {
            let Some(queued) = self.queue.pop_front() else { break };
            self.dispatch(queued);
        }
        if self.active.is_none() && self.queue.is_empty() && self.idle.is_none() && self.closing.is_none() {
            self.arm_idle();
        }
    }

    fn dispatch(&mut self, queued: Queued) {
        let Phase::Running(generation) = &mut self.phase else {
            self.queue.push_front(queued);
            return;
        };
        let Queued { ticket, demand, work } = queued;
        let id = generation.request();
        let number = generation.number;
        let (message, waiter) = work.message(id);
        match generation.send(&message) {
            Err(error) => {
                self.settle_event(ticket, Outcome::Encode);
                waiter.fail(HostError::Encode(error.to_string()));
            }
            Ok(sent) => {
                self.active = Some(Active { ticket, request: id, demand, waiter });
                self.emit(HostEvent::Dispatched { generation: number, ticket, request: id });
                if !sent {
                    self.fail_generation(TransportError::Pipe("the helper's input is closed".to_owned()));
                }
            }
        }
    }

    fn arm_idle(&mut self) {
        let Phase::Running(generation) = &self.phase else { return };
        let number = generation.number;
        let at = self.reference.unwrap_or_else(|| self.clock.now()) + self.idle_after;
        self.idle = Some(self.clock.sleep_until(at));
        self.emit(HostEvent::IdleArmed { generation: number });
    }

    fn finish_close(&mut self) {
        let Some(closing) = self.closing.take() else { return };
        for removal in std::mem::take(&mut self.deferred) {
            if let Some(reply) = removal.reply {
                self.settle_event(removal.ticket, Outcome::Closed);
                drop(reply.send(Err(HostError::Closed)));
            }
        }
        self.deadline = None;
        self.phase = Phase::Closed;
        self.closed = Some(closing.outcome);
        for waiter in closing.waiters {
            let _ = waiter.send(closing.outcome);
        }
        self.emit(HostEvent::Closed { outcome: closing.outcome });
    }

    fn publish(&self) {
        let (state, generation, pid) = match &self.phase {
            Phase::Absent => (HostState::Absent, None, None),
            Phase::Launching { number } => (HostState::Starting, Some(*number), None),
            Phase::Starting(generation) => (HostState::Starting, Some(generation.number), Some(generation.pid)),
            Phase::Running(generation) => (HostState::Running, Some(generation.number), Some(generation.pid)),
            Phase::Retiring { generation, .. } => (HostState::Retiring, Some(generation.number), Some(generation.pid)),
            Phase::Closed => (HostState::Closed, None, None),
        };
        let status = HostStatus { state, generation, pid, queued: self.queue.len(), dispatched: self.active.is_some() };
        self.status.send_if_modified(|current| {
            let changed = *current != status;
            if changed {
                *current = status;
            }
            changed
        });
    }
}
