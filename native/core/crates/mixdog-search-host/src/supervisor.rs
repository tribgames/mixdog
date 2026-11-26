//! The core's supervisor of the search helper ([`SearchHost`]).
//!
//! One actor, the driver [`SearchHost::new`] returns, serializes every transition: a generation is launched, starts,
//! runs, and ends (told to exit, or killed) until it is reaped with its output read to the end; `Closed` once
//! [`SearchHost::close`] has finished.
//!
//! - Streams: every walk and text search is a stream of its own, many at once, each sent as it is opened, in that order,
//!   so the helper's one scheduler admits them in the order the core asked, as the engine's would in the core. A stream
//!   opened while no generation runs waits for one; nothing but a stream starts a helper. Its items come back as the
//!   helper finds them, each answered with a take once the consumer has it ([`crate::wire::ToWorker::Taken`]).
//! - Failure: a crash, the end of the helper's output, a malformed frame, an incompatible [`crate::wire::Ready`] or a pipe
//!   failure answers every stream of that generation once, with the failure of a read (`FsErrorKind::Io`), then its end,
//!   and kills the generation; one that ends before its `Ready` answers the streams waiting for it so too. The next
//!   stream starts a new generation, without waiting for the old one to be reaped. Nothing is resent.
//! - Idle: one deadline, [`HostConfig::idle`] after the last stream was settled, armed only while none is open. At expiry
//!   the helper's input is closed and it exits; one that has not within [`HostConfig::exit_limit`] is killed.
//! - Every frame is fenced by its generation and stream id.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::StreamExt;
use futures::stream::FuturesUnordered;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_core_api::domain::fs::WalkRequest;
use mixdog_graph_host::Clock;
use mixdog_graph_host::RuntimeClock;
use mixdog_spawn::owned::OwnedChild;
use mixdog_spawn::owned::OwnedCommand;
use mixdog_spawn::owned::OwnedPipes;
use mixdog_spawn::owned::Reaped;
use mixdog_workspace::localfs::Searches;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use crate::link::Events;
use crate::link::Link;
use crate::link::LinkEvent;
use crate::stream::Event;
use crate::stream::HostStream;
use crate::stream::Yield;
use crate::stream::settle_lost;
use crate::wire::Found;
use crate::wire::FromWorker;
use crate::wire::PROTOCOL_VERSION;
use crate::wire::Search;
use crate::wire::StreamId;
use crate::wire::ToWorker;
use crate::wire::Walk;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// How long a helper with no stream open lives on: the code graph helper's ([`mixdog_graph_host::IDLE`]), whose agreed
/// retirement this helper's follows.
pub const IDLE: Duration = mixdog_graph_host::IDLE;

pub type Observer = Arc<dyn Fn(&HostEvent) + Send + Sync>;

pub struct HostConfig {
    /// The helper: this executable's `search-worker`.
    pub command: OwnedCommand,
    pub idle: Duration,
    /// How long a helper whose input was closed (idle, or at close) may take to exit before it is killed.
    pub exit_limit: Duration,
    pub clock: Arc<dyn Clock>,
    /// Sees every transition, in order, on the actor.
    pub observer: Option<Observer>,
}

impl HostConfig {
    pub fn new(command: OwnedCommand, exit_limit: Duration) -> Self {
        Self { command, idle: IDLE, exit_limit, clock: Arc::new(RuntimeClock), observer: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostState {
    Absent,
    Starting,
    Running,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostStatus {
    pub state: HostState,
    pub generation: Option<u64>,
    pub pid: Option<u32>,
    /// Streams open: sent, or waiting for a generation.
    pub streams: usize,
    /// Generations told to exit or killed, not yet reaped with their output read.
    pub ending: usize,
}

impl HostStatus {
    const ABSENT: Self = Self { state: HostState::Absent, generation: None, pid: None, streams: 0, ending: 0 };
    const CLOSED: Self = Self { state: HostState::Closed, generation: None, pid: None, streams: 0, ending: 0 };
}

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
    /// The helper exited by itself once its input was closed.
    Exited,
    /// The helper was killed: it was starting, or did not exit within the budget.
    Killed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillReason {
    /// The helper or its pipes failed.
    Transport,
    /// A helper whose input was closed did not exit within [`HostConfig::exit_limit`].
    ExitLimit,
    /// The host is closing: the helper had not started serving, or did not exit within the budget.
    Close,
}

/// One transition, as the actor makes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostEvent {
    Spawned { generation: u64, pid: u32 },
    Ready { generation: u64, pid: u32 },
    /// A stream was sent to the generation.
    Opened { generation: u64, stream: StreamId },
    /// The generation failed; its streams were answered.
    Failed { generation: Option<u64>, error: TransportError },
    IdleArmed { generation: u64 },
    /// The generation's input was closed: it exits.
    Retiring { generation: u64, pid: u32 },
    Killed { generation: u64, pid: u32, why: KillReason },
    Reaped { generation: u64, pid: u32, code: Option<i32> },
    Closed { outcome: CloseOutcome },
}

/// The core's handle on the search helper, the [`Searches`] of its file service. Every method is answered by the driver
/// [`SearchHost::new`] returns, which the caller spawns; it ends once every handle and stream is dropped, and its drop
/// kills a helper still running.
pub struct SearchHost {
    commands: mpsc::UnboundedSender<Command>,
    status: watch::Receiver<HostStatus>,
    streams: AtomicU64,
}

impl SearchHost {
    pub fn new(config: HostConfig) -> (Self, impl Future<Output = ()> + Send + 'static) {
        let (commands, received) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(HostStatus::ABSENT);
        let actor = Actor {
            command: config.command,
            idle_after: config.idle,
            exit_limit: config.exit_limit,
            clock: config.clock,
            observer: config.observer,
            commands: received,
            events,
            events_tx,
            status: status_tx,
            generations: 0,
            current: Current::Absent,
            ending: Vec::new(),
            streams: HashMap::new(),
            pending: VecDeque::new(),
            wakes: FuturesUnordered::new(),
            idle: None,
            closing: None,
            closed: None,
        };
        (Self { commands, status, streams: AtomicU64::new(0) }, actor.run())
    }

    /// `FileService::walk`, run by the helper.
    pub fn walk(&self, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        self.open(Open::Walk(request))
    }

    /// `FileService::search_text`, or `search_summary` when `summary`, run by the helper.
    pub fn search(&self, request: SearchRequest, summary: bool) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        self.open(Open::Search { request, summary })
    }

    /// Stops taking streams, answers every open one as a helper's end answers it, closes a running helper's input and
    /// waits for its exit; at `budget` it is killed. Later calls answer the same outcome.
    pub async fn close(&self, budget: Duration) -> CloseOutcome {
        let (reply, outcome) = oneshot::channel();
        if self.commands.send(Command::Shut { budget, reply }).is_err() {
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

    fn open<T: Yield>(&self, open: Open) -> Box<dyn EventSource<Result<T, FsError>>> {
        let id = self.streams.fetch_add(1, Ordering::Relaxed) + 1;
        let (sink, events) = mpsc::unbounded_channel();
        if let Err(mpsc::error::SendError(Command::Open { sink, .. })) = self.commands.send(Command::Open { id, open, sink }) {
            settle_lost(&sink, false, None);
        }
        Box::new(HostStream::new(id, self.commands.clone(), events))
    }
}

impl Searches for SearchHost {
    fn walk(&self, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        SearchHost::walk(self, request)
    }

    fn search(&self, request: SearchRequest, summary: bool) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        SearchHost::search(self, request, summary)
    }
}

pub(crate) enum Command {
    Open { id: StreamId, open: Open, sink: mpsc::UnboundedSender<Event> },
    /// The stream's consumer took its next item.
    Taken { id: StreamId },
    /// The stream's close.
    Close { id: StreamId },
    /// The stream was dropped.
    Release { id: StreamId },
    /// The host's close.
    Shut { budget: Duration, reply: oneshot::Sender<CloseOutcome> },
}

pub(crate) enum Open {
    Walk(WalkRequest),
    Search { request: SearchRequest, summary: bool },
}

impl Open {
    fn walks(&self) -> bool {
        matches!(self, Open::Walk(_))
    }

    /// The stream's request as it is written now: a deadline crosses as the time left to it.
    fn message(&self, id: StreamId) -> ToWorker {
        match self {
            Open::Walk(request) => ToWorker::Walk { id, walk: Walk::of(request) },
            Open::Search { request, summary } => ToWorker::Search { id, search: Search::of(request, std::time::Instant::now()), summary: *summary },
        }
    }
}

struct Live {
    walks: bool,
    sink: mpsc::UnboundedSender<Event>,
    /// Until it is sent.
    open: Option<Open>,
    /// The generation it was sent to.
    generation: Option<u64>,
    ended: bool,
    /// Its close was sent: it is settled by the helper's answer.
    closing: bool,
}

struct Generation {
    number: u64,
    pid: u32,
    child: OwnedChild,
    /// `None` once the helper's input is closed.
    link: Option<Link>,
    /// The process has been reaped, with its exit code if it has one.
    exit_code: Option<Option<i32>>,
    /// The reader has read the helper's output to its end (or there is no reader).
    output_ended: bool,
    killed: bool,
}

impl Generation {
    /// Queues `message` for the helper; false when it cannot be.
    fn send(&self, message: &ToWorker) -> Result<bool, mixdog_graph_host::frame::FrameError> {
        match &self.link {
            Some(link) => link.send(message),
            None => Ok(false),
        }
    }
}

enum Current {
    Absent,
    /// The process is being created.
    Launching(u64),
    /// Created; its `Ready` has not come.
    Starting(Generation),
    Running(Generation),
}

struct Closing {
    waiters: Vec<oneshot::Sender<CloseOutcome>>,
    outcome: CloseOutcome,
    deadline: BoxFuture<()>,
}

enum Wake {
    Launched(u64, io::Result<(OwnedChild, OwnedPipes)>),
    Reaped(u64, Reaped),
    ExitLimit(u64),
}

enum Turn {
    Command(Command),
    Gone,
    Event((u64, LinkEvent)),
    Wake(Wake),
    Idle,
    CloseDeadline,
}

struct Actor {
    command: OwnedCommand,
    idle_after: Duration,
    exit_limit: Duration,
    clock: Arc<dyn Clock>,
    observer: Option<Observer>,
    commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedReceiver<(u64, LinkEvent)>,
    events_tx: Events,
    status: watch::Sender<HostStatus>,
    generations: u64,
    current: Current,
    /// Generations told to exit or killed, until each is reaped with its output read to the end.
    ending: Vec<Generation>,
    streams: HashMap<StreamId, Live>,
    /// Streams opened while no generation runs, in the order they were opened.
    pending: VecDeque<StreamId>,
    /// Launches, reaps and exit limits.
    wakes: FuturesUnordered<BoxFuture<Wake>>,
    idle: Option<BoxFuture<()>>,
    closing: Option<Closing>,
    closed: Option<CloseOutcome>,
}

async fn next<T>(slot: &mut Option<BoxFuture<T>>) -> T {
    match slot {
        Some(future) => future.await,
        None => std::future::pending().await,
    }
}

async fn close_deadline(closing: &mut Option<Closing>) {
    match closing {
        Some(closing) => (&mut closing.deadline).await,
        None => std::future::pending().await,
    }
}

impl Actor {
    async fn run(mut self) {
        loop {
            // A stream opened with the idle deadline is taken first: it keeps the helper.
            let turn = tokio::select! {
                biased;
                command = self.commands.recv() => command.map_or(Turn::Gone, Turn::Command),
                Some(event) = self.events.recv() => Turn::Event(event),
                Some(wake) = self.wakes.next(), if !self.wakes.is_empty() => Turn::Wake(wake),
                () = next(&mut self.idle) => Turn::Idle,
                () = close_deadline(&mut self.closing) => Turn::CloseDeadline,
            };
            match turn {
                Turn::Command(command) => self.command(command),
                // Every handle and stream is gone: the helper goes with the actor (its handle's drop kills it).
                Turn::Gone => return,
                Turn::Event((generation, event)) => self.event(generation, event),
                Turn::Wake(Wake::Launched(generation, launched)) => self.launched(generation, launched),
                Turn::Wake(Wake::Reaped(generation, reaped)) => self.reaped(generation, &reaped),
                Turn::Wake(Wake::ExitLimit(generation)) => self.exit_limit_passed(generation),
                Turn::Idle => {
                    self.idle = None;
                    self.idle_expired();
                }
                Turn::CloseDeadline => self.close_deadline_passed(),
            }
            self.pump();
            self.publish();
        }
    }

    fn emit(&self, event: HostEvent) {
        tracing::debug!(target: "search_host", ?event, "search host");
        if let Some(observer) = &self.observer {
            observer(&event);
        }
    }

    fn running(&self, number: u64) -> Option<&Generation> {
        match &self.current {
            Current::Running(generation) if generation.number == number => Some(generation),
            _ => None,
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Open { id, open, sink } => self.open(id, open, sink),
            Command::Taken { id } => self.taken(id),
            Command::Close { id } => self.close_stream(id),
            Command::Release { id } => self.release(id),
            Command::Shut { budget, reply } => self.shut(budget, reply),
        }
    }

    fn open(&mut self, id: StreamId, open: Open, sink: mpsc::UnboundedSender<Event>) {
        if self.closing.is_some() || self.closed.is_some() {
            return settle_lost(&sink, false, None);
        }
        self.idle = None;
        self.streams.insert(id, Live { walks: open.walks(), sink, open: Some(open), generation: None, ended: false, closing: false });
        self.pending.push_back(id);
    }

    fn taken(&mut self, id: StreamId) {
        let Some(number) = self.streams.get(&id).and_then(|live| live.generation) else { return };
        self.send_to(number, &ToWorker::Taken { id, items: 1 });
    }

    fn close_stream(&mut self, id: StreamId) {
        let Some(live) = self.streams.get_mut(&id) else { return };
        if live.closing {
            return;
        }
        match live.generation {
            None => {
                self.pending.retain(|waiting| *waiting != id);
                if let Some(live) = self.streams.remove(&id) {
                    let _ = live.sink.send(Event::Closed);
                }
            }
            Some(number) => {
                live.closing = true;
                self.send_to(number, &ToWorker::Close { id });
            }
        }
    }

    fn release(&mut self, id: StreamId) {
        let Some(live) = self.streams.remove(&id) else { return };
        match live.generation {
            None => self.pending.retain(|waiting| *waiting != id),
            // A stream closing is let go of by its close.
            Some(number) if !live.closing => self.send_to(number, &ToWorker::Release { id }),
            Some(_) => {}
        }
    }

    /// Sends `message` to generation `number` if it is the one running; a pipe that takes nothing fails it.
    fn send_to(&mut self, number: u64, message: &ToWorker) {
        let Some(generation) = self.running(number) else { return };
        match generation.send(message) {
            Ok(true) => {}
            Ok(false) => self.fail_generation(TransportError::Pipe("the helper's input is closed".to_owned())),
            Err(error) => self.fail_generation(TransportError::Pipe(error.to_string())),
        }
    }

    fn shut(&mut self, budget: Duration, reply: oneshot::Sender<CloseOutcome>) {
        if let Some(outcome) = self.closed {
            let _ = reply.send(outcome);
            return;
        }
        if let Some(closing) = &mut self.closing {
            closing.waiters.push(reply);
            return;
        }
        self.idle = None;
        self.pending.clear();
        for (_, live) in self.streams.drain() {
            settle_lost(&live.sink, live.ended, None);
        }
        let mut outcome = CloseOutcome::NoChild;
        match std::mem::replace(&mut self.current, Current::Absent) {
            Current::Running(generation) => {
                outcome = CloseOutcome::Exited;
                self.retire(generation);
            }
            Current::Starting(generation) => {
                outcome = CloseOutcome::Killed;
                self.kill(generation, KillReason::Close);
            }
            // The launch's owner thread kills and reaps a child started for no one ([`Self::launched`]).
            Current::Launching(_) => outcome = CloseOutcome::Killed,
            Current::Absent => {}
        }
        let deadline = self.clock.sleep_until(self.clock.now() + budget);
        self.closing = Some(Closing { waiters: vec![reply], outcome, deadline });
    }

    /// Closes the generation's input, so the helper exits; it is killed if it has not within the exit limit.
    fn retire(&mut self, mut generation: Generation) {
        generation.link = None;
        self.emit(HostEvent::Retiring { generation: generation.number, pid: generation.pid });
        let (number, at) = (generation.number, self.clock.now() + self.exit_limit);
        let limit = self.clock.sleep_until(at);
        self.wakes.push(Box::pin(async move {
            limit.await;
            Wake::ExitLimit(number)
        }));
        self.ending.push(generation);
    }

    fn kill(&mut self, mut generation: Generation, why: KillReason) {
        generation.child.kill();
        generation.killed = true;
        generation.link = None;
        self.emit(HostEvent::Killed { generation: generation.number, pid: generation.pid, why });
        self.ending.push(generation);
    }

    /// The current generation failed: every stream it carried is answered as lost, and so are the streams waiting for one
    /// that never ran; then it is killed.
    fn fail_generation(&mut self, error: TransportError) {
        let (generation, started) = match std::mem::replace(&mut self.current, Current::Absent) {
            Current::Running(generation) => (generation, true),
            Current::Starting(generation) => (generation, false),
            other => {
                self.current = other;
                return;
            }
        };
        self.emit(HostEvent::Failed { generation: Some(generation.number), error });
        let number = generation.number;
        let carried: Vec<StreamId> = self.streams.iter().filter(|(_, live)| live.generation == Some(number)).map(|(id, _)| *id).collect();
        let waiting = if started { Vec::new() } else { std::mem::take(&mut self.pending).into() };
        for id in carried.into_iter().chain(waiting) {
            if let Some(live) = self.streams.remove(&id) {
                settle_lost(&live.sink, live.ended, None);
            }
        }
        self.idle = None;
        self.kill(generation, KillReason::Transport);
    }

    /// Generation `number`'s output: messages of the current one are taken; a generation ending keeps only the end of its
    /// output, its streams having been answered.
    fn event(&mut self, number: u64, event: LinkEvent) {
        let ended = matches!(event, LinkEvent::Eof | LinkEvent::Malformed(_));
        let current = match &mut self.current {
            Current::Starting(generation) | Current::Running(generation) if generation.number == number => Some(generation),
            _ => None,
        };
        let Some(generation) = current else {
            if ended && let Some(ending) = self.ending.iter_mut().find(|ending| ending.number == number) {
                ending.output_ended = true;
                self.try_end(number);
            }
            return;
        };
        generation.output_ended |= ended;
        let exit_code = generation.exit_code;
        match event {
            LinkEvent::Message(FromWorker::Ready { ready }) => self.ready(ready.version),
            LinkEvent::Message(message) if matches!(self.current, Current::Starting(_)) => {
                self.fail_generation(TransportError::Malformed(format!("{message:?} before Ready")));
            }
            LinkEvent::Message(FromWorker::Item { id, item }) => self.item(id, item),
            LinkEvent::Message(FromWorker::End { id }) => self.end(id),
            LinkEvent::Message(FromWorker::Closed { id }) => self.closed_stream(id),
            LinkEvent::Eof => self.fail_generation(exit_code.map_or(TransportError::Eof, TransportError::Exited)),
            LinkEvent::Malformed(error) => self.fail_generation(TransportError::Malformed(error)),
            LinkEvent::WriteFailed(error) => self.fail_generation(TransportError::Pipe(error)),
        }
        if ended {
            self.try_end(number);
        }
    }

    fn ready(&mut self, version: u32) {
        match std::mem::replace(&mut self.current, Current::Absent) {
            Current::Starting(generation) if version == PROTOCOL_VERSION => {
                self.emit(HostEvent::Ready { generation: generation.number, pid: generation.pid });
                self.current = Current::Running(generation);
            }
            Current::Starting(generation) => {
                self.current = Current::Starting(generation);
                self.fail_generation(TransportError::Incompatible { version });
            }
            other => {
                self.current = other;
                self.fail_generation(TransportError::Malformed("a second Ready".to_owned()));
            }
        }
    }

    fn item(&mut self, id: StreamId, item: crate::wire::Item) {
        // A stream let go of may still have items on the way.
        let Some(live) = self.streams.get(&id) else { return };
        let read = match item.read() {
            Ok(read) => read,
            Err(error) => return self.fail_generation(TransportError::Malformed(error)),
        };
        let fits = match &read {
            Ok(Found::Entry(_)) => live.walks,
            Ok(Found::Match(_)) => !live.walks,
            Err(_) => true,
        };
        if !fits || live.ended {
            return self.fail_generation(TransportError::Malformed(format!("an item stream {id} cannot have")));
        }
        let _ = live.sink.send(Event::Item(read));
    }

    fn end(&mut self, id: StreamId) {
        let Some(live) = self.streams.get_mut(&id) else { return };
        if live.ended {
            return self.fail_generation(TransportError::Malformed(format!("stream {id} ended twice")));
        }
        live.ended = true;
        let _ = live.sink.send(Event::End);
    }

    fn closed_stream(&mut self, id: StreamId) {
        match self.streams.get(&id).map(|live| live.closing) {
            // Let go of while it closed.
            None => {}
            Some(true) => {
                if let Some(live) = self.streams.remove(&id) {
                    let _ = live.sink.send(Event::Closed);
                }
            }
            Some(false) => self.fail_generation(TransportError::Malformed(format!("stream {id} closed unasked"))),
        }
    }

    fn launch(&mut self) {
        self.generations += 1;
        let number = self.generations;
        let command = self.command.clone();
        self.wakes.push(Box::pin(async move { Wake::Launched(number, OwnedChild::spawn(&command).await) }));
        self.current = Current::Launching(number);
    }

    /// A child launched for a generation no longer wanted is dropped here, which kills it; its owner thread reaps it.
    fn launched(&mut self, number: u64, launched: io::Result<(OwnedChild, OwnedPipes)>) {
        if !matches!(self.current, Current::Launching(launching) if launching == number) {
            return;
        }
        self.current = Current::Absent;
        let (child, pipes) = match launched {
            Ok(started) => started,
            Err(error) => {
                let os_code = error.raw_os_error();
                self.emit(HostEvent::Failed { generation: None, error: TransportError::Launch(error.to_string()) });
                for id in std::mem::take(&mut self.pending) {
                    if let Some(live) = self.streams.remove(&id) {
                        settle_lost(&live.sink, false, os_code);
                    }
                }
                return;
            }
        };
        let pid = child.id();
        self.emit(HostEvent::Spawned { generation: number, pid });
        let reaped = child.reaped();
        self.wakes.push(Box::pin(async move { Wake::Reaped(number, reaped.wait().await) }));
        let link = Link::open(number, pipes, &self.events_tx);
        let opened = link.as_ref().map(|_| ()).map_err(|error| error.to_string());
        self.current = Current::Starting(Generation { number, pid, child, output_ended: link.is_err(), link: link.ok(), exit_code: None, killed: false });
        if let Err(error) = opened {
            self.fail_generation(TransportError::Pipe(error));
        }
    }

    fn reaped(&mut self, number: u64, reaped: &Reaped) {
        let code = match reaped {
            Reaped::Exited(status) => status.code(),
            Reaped::Lost(_) => None,
        };
        let generation = match &mut self.current {
            Current::Starting(generation) | Current::Running(generation) if generation.number == number => Some(generation),
            _ => self.ending.iter_mut().find(|ending| ending.number == number),
        };
        let Some(generation) = generation else { return };
        generation.exit_code = Some(code);
        let pid = generation.pid;
        self.emit(HostEvent::Reaped { generation: number, pid, code });
        self.try_end(number);
    }

    /// Forgets an ending generation once it has been reaped and its output read to its end. A current one ends through
    /// [`Self::fail_generation`] at the end of its output.
    fn try_end(&mut self, number: u64) {
        self.ending.retain(|ending| ending.number != number || ending.exit_code.is_none() || !ending.output_ended);
    }

    fn exit_limit_passed(&mut self, number: u64) {
        let Some(at) = self.ending.iter().position(|ending| ending.number == number && !ending.killed && ending.exit_code.is_none()) else { return };
        let generation = self.ending.swap_remove(at);
        self.kill(generation, if self.closing.is_some() { KillReason::Close } else { KillReason::ExitLimit });
    }

    fn idle_expired(&mut self) {
        if !self.streams.is_empty() || self.closing.is_some() {
            return;
        }
        if let Current::Running(_) = self.current
            && let Current::Running(generation) = std::mem::replace(&mut self.current, Current::Absent)
        {
            self.retire(generation);
        }
    }

    /// The close's budget passed: every generation still ending is killed and the close is done, its processes left to
    /// their reapers.
    fn close_deadline_passed(&mut self) {
        let Some(closing) = &mut self.closing else { return };
        let alive: Vec<usize> = (0..self.ending.len()).filter(|&at| self.ending[at].exit_code.is_none() && !self.ending[at].killed).collect();
        if !alive.is_empty() {
            closing.outcome = CloseOutcome::Killed;
        }
        for at in alive.into_iter().rev() {
            let generation = self.ending.swap_remove(at);
            self.kill(generation, KillReason::Close);
        }
        self.finish_close();
    }

    fn finish_close(&mut self) {
        let Some(closing) = self.closing.take() else { return };
        self.closed = Some(closing.outcome);
        for waiter in closing.waiters {
            let _ = waiter.send(closing.outcome);
        }
        self.emit(HostEvent::Closed { outcome: closing.outcome });
    }

    /// Moves the host on after a turn: launches, sends the waiting streams, arms the idle deadline, or finishes a close.
    fn pump(&mut self) {
        if self.closing.is_some() {
            if matches!(self.current, Current::Absent) && self.ending.iter().all(|ending| ending.exit_code.is_some()) {
                self.finish_close();
            }
            return;
        }
        if self.closed.is_some() {
            return;
        }
        match &self.current {
            Current::Absent if !self.pending.is_empty() => self.launch(),
            Current::Running(generation) => {
                let number = generation.number;
                while self.running(number).is_some()
                    && let Some(id) = self.pending.pop_front()
                {
                    self.dispatch(number, id);
                }
                if self.running(number).is_some() && self.streams.is_empty() && self.idle.is_none() {
                    self.idle = Some(self.clock.sleep_until(self.clock.now() + self.idle_after));
                    self.emit(HostEvent::IdleArmed { generation: number });
                }
            }
            _ => {}
        }
    }

    /// Sends the waiting stream `id` to the running generation `number`.
    fn dispatch(&mut self, number: u64, id: StreamId) {
        let Some(open) = self.streams.get_mut(&id).and_then(|live| live.open.take()) else { return };
        let Some(generation) = self.running(number) else { return };
        match generation.send(&open.message(id)) {
            Ok(sent) => {
                if let Some(live) = self.streams.get_mut(&id) {
                    live.generation = Some(number);
                }
                self.emit(HostEvent::Opened { generation: number, stream: id });
                if !sent {
                    self.fail_generation(TransportError::Pipe("the helper's input is closed".to_owned()));
                }
            }
            // A request too large to write is a stream that could not be read.
            Err(_) => {
                if let Some(live) = self.streams.remove(&id) {
                    settle_lost(&live.sink, false, None);
                }
            }
        }
    }

    fn publish(&self) {
        let (state, generation, pid) = match &self.current {
            _ if self.closed.is_some() => (HostState::Closed, None, None),
            Current::Absent => (HostState::Absent, None, None),
            Current::Launching(number) => (HostState::Starting, Some(*number), None),
            Current::Starting(generation) => (HostState::Starting, Some(generation.number), Some(generation.pid)),
            Current::Running(generation) => (HostState::Running, Some(generation.number), Some(generation.pid)),
        };
        let status = HostStatus { state, generation, pid, streams: self.streams.len(), ending: self.ending.len() };
        self.status.send_if_modified(|current| {
            let changed = *current != status;
            if changed {
                *current = status;
            }
            changed
        });
    }
}
