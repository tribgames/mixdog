//! The app's client of the secure-desktop helper after authentication (Node: `secure-desktop/client.ts`,
//! `SecureDesktopClient`), over the helper's pipe ([`mixdog_secure_desktop::client::Link`], which dials and runs the
//! mutual challenge-response).
//!
//! - The session view is the helper's hello, kept current by `desktop-changed`; it ends with the connection.
//! - `set_active` and `set_video_run` are written without a wait; nothing is written before authentication.
//! - Bounded sends (`send_input`, `send_grant`, `sas`): settled once the write was handed to the pipe; refused at
//!   once when not connected; failed when the write fails, when the connection ends first, or after the helper's
//!   frame deadline ([`FRAME_DEADLINE_MS`]), past which the helper would drop the peer anyway. There are no input
//!   acknowledgments: "handed to the pipe" is not "executed".
//! - `close` deactivates and ends the connection; sends already handed over settle from their own writes. A connect
//!   still in its handshake is given up and fails at once with "connection closed".
//! - What a pipe reports counts only while its connect is the client's connection: a pipe given up by `close` or
//!   replaced by a later connect may still report, and nothing of it changes the client. Its own close still counts
//!   while no other connect has taken its place. (Node at b6f10295a let a late close of an earlier socket end the
//!   current session; fixed on both sides, `node-fix-helper-stale-socket.patch`.)

use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::time::Duration;

use mixdog_secure_desktop::protocol::FrameHeader;
use mixdog_secure_desktop::protocol::InputEvent;
use mixdog_secure_desktop::protocol::Message;
use serde::Serialize;
use tokio::sync::oneshot;

use super::adapter::HelperService;
use super::adapter::HelperSession;
use super::installer::TimerHandle;
use super::installer::Timers;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::Unsub;
use super::router::BoxFuture;

/// The helper drops a peer whose frame stalls this long (`FRAME_DEADLINE_MS`); a send is bounded by it.
pub(super) const FRAME_DEADLINE_MS: u64 = 10_000;

const NOT_INSTALLED: &str = "secure desktop service is not installed";
const ALREADY_CONNECTED: &str = "already connected";
const NOT_CONNECTED: &str = "not connected";
const CONNECTION_CLOSED: &str = "connection closed";

/// The authenticated session: the helper's hello, its desktop kept current.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct ClientSession {
    pub protocol: u32,
    pub version: String,
    pub session: u32,
    pub desktop: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
}

/// An authenticated pipe to the helper.
pub(super) trait HelperPipe: Send + Sync {
    /// Hands one message to the pipe; `done` gets the write's outcome.
    fn write(&self, message: Message, done: Box<dyn FnOnce(Result<(), String>) + Send>);
    /// Ends the connection after the writes already handed over.
    fn end(&self);
}

/// What the helper sends after authentication, and the end of its pipe.
pub(super) trait PipeEvents: Send + Sync {
    fn desktop_changed(&self, desktop: String, session: u32, locked: Option<bool>);
    fn grant_challenge(&self, challenge: Challenge);
    fn error(&self, code: String, message: String);
    fn frame(&self, header: FrameHeader, pixels: Arc<Vec<u8>>);
    /// The pipe closed (the peer, a failed read, or after `end`).
    fn closed(&self);
}

/// A connect under way: the authenticated pipe and the helper's hello once it is made, and how to give it up before
/// (Node's `connection.end()` during the handshake). A connection made after it was given up is dropped with `done`.
pub(super) struct Dialing {
    pub done: BoxFuture<Result<(Arc<dyn HelperPipe>, ClientSession), String>>,
    pub abort: Box<dyn FnOnce() + Send>,
}

/// Dials the installed helper and authenticates.
pub(super) trait HelperConnector: Send + Sync {
    /// The install state (its secret and pipe name) is readable: the helper is installed.
    fn available(&self) -> bool;
    /// Dials; the pipe reports to `events`, which belong to this connect alone.
    fn connect(&self, events: Arc<dyn PipeEvents>) -> Dialing;
}

type Settle = Arc<Mutex<Option<(oneshot::Sender<Result<(), String>>, Option<TimerHandle>)>>>;

struct State {
    /// Set from the start of a connect until the connection ends.
    connecting: bool,
    /// The connect under way: how to give it up, and its wait, told when it is given up.
    dialing: Option<(Box<dyn FnOnce() + Send>, oneshot::Sender<()>)>,
    /// The number of the latest connect: while `connecting`, the client's connection.
    dials: u64,
    pipe: Option<Arc<dyn HelperPipe>>,
    session: Option<ClientSession>,
    /// Bounded sends still waiting for their write, in the order they were made.
    pending: Vec<(u64, Settle)>,
    sends: u64,
}

struct Inner {
    connector: Arc<dyn HelperConnector>,
    timers: Arc<dyn Timers>,
    deadline_ms: u64,
    state: Mutex<State>,
    desktop_changed: Arc<ListenerSet<HelperSession>>,
    closed: Arc<ListenerSet<()>>,
    challenges: Arc<ListenerSet<Challenge>>,
    errors: Arc<ListenerSet<(String, String)>>,
    frames: Arc<ListenerSet<(FrameHeader, Arc<Vec<u8>>)>>,
    me: Weak<Inner>,
    /// Test only: told the connect's number after each pipe event was taken or ignored.
    #[cfg(test)]
    pipe_event_seen: Mutex<Option<Arc<dyn Fn(u64) + Send + Sync>>>,
}

fn settle(slot: &Settle, outcome: Result<(), String>) {
    let taken = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    if let Some((sender, timer)) = taken {
        if let Some(timer) = timer {
            timer.clear();
        }
        let _ = sender.send(outcome);
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Ends the session and fails every pending send with `reason`.
    fn end_session(&self, reason: &str) {
        let pending = {
            let mut state = self.state();
            state.session = None;
            std::mem::take(&mut state.pending)
        };
        for (_, slot) in pending {
            settle(&slot, Err(reason.to_string()));
        }
    }

    fn send(&self, message: Message) {
        let pipe = self.state().pipe.clone();
        if let Some(pipe) = pipe {
            pipe.write(message, Box::new(|_| {}));
        }
    }

    fn send_bounded(&self, message: Message) -> BoxFuture<Result<(), String>> {
        let Some(pipe) = self.state().pipe.clone() else {
            return Box::pin(async { Err(NOT_CONNECTED.to_string()) });
        };
        let (sender, receiver) = oneshot::channel();
        let slot: Settle = Arc::new(Mutex::new(Some((sender, None))));
        let id = {
            let mut state = self.state();
            state.sends += 1;
            let id = state.sends;
            state.pending.push((id, slot.clone()));
            id
        };
        let me = self.me.clone();
        let release = move || {
            if let Some(inner) = me.upgrade() {
                inner.state().pending.retain(|(held, _)| *held != id);
            }
        };
        let deadline_ms = self.deadline_ms;
        let timed_out = (slot.clone(), release.clone());
        let timer = self.timers.set_timeout(
            Duration::from_millis(deadline_ms),
            Box::new(move || {
                let (slot, release) = timed_out;
                release();
                settle(&slot, Err(format!("input not taken by the helper within {deadline_ms} ms")));
            }),
        );
        if let Some(armed) = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut() {
            armed.1 = Some(timer);
        }
        let written = slot.clone();
        pipe.write(
            message,
            Box::new(move |outcome| {
                release();
                settle(&written, outcome);
            }),
        );
        Box::pin(async move { receiver.await.unwrap_or_else(|_| Err(CONNECTION_CLOSED.to_string())) })
    }
}

/// One connect's pipe events. They arrive from the pipe's own thread: each is an entry into the screen control and
/// runs in its turn, and counts only while its connect is the client's connection (`connecting` with its number);
/// its close also while no connect is (after `close` the pipe's own close still ends what is left). It does not keep
/// the client alive: the client keeps the pipe, and the pipe's event task keeps this.
struct Socket {
    inner: Weak<Inner>,
    dial: u64,
}

impl Socket {
    fn when(&self, counts: impl FnOnce(&State) -> bool, body: impl FnOnce(&Inner)) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        inner.timers.turn().clone().enter(|| {
            let current = counts(&inner.state());
            if current {
                body(&inner);
            }
            #[cfg(test)]
            if let Some(seen) = lock_slot(&inner.pipe_event_seen).clone() {
                seen(self.dial);
            }
        });
    }

    fn current(&self, state: &State) -> bool {
        state.connecting && state.dials == self.dial
    }
}

#[cfg(test)]
fn lock_slot<T>(slot: &Mutex<T>) -> MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PipeEvents for Socket {
    fn desktop_changed(&self, desktop: String, session: u32, locked: Option<bool>) {
        self.when(
            |state| self.current(state),
            |inner| {
                {
                    let mut state = inner.state();
                    if let Some(current) = state.session.as_mut() {
                        current.desktop = desktop.clone();
                        current.session = session;
                        current.locked = locked;
                    }
                }
                inner.desktop_changed.call(&HelperSession { session, desktop, locked });
            },
        );
    }

    fn grant_challenge(&self, challenge: Challenge) {
        self.when(|state| self.current(state), |inner| inner.challenges.call(&challenge));
    }

    fn error(&self, code: String, message: String) {
        self.when(|state| self.current(state), |inner| inner.errors.call(&(code, message)));
    }

    fn frame(&self, header: FrameHeader, pixels: Arc<Vec<u8>>) {
        self.when(|state| self.current(state), |inner| inner.frames.call(&(header, pixels)));
    }

    fn closed(&self) {
        self.when(
            |state| !state.connecting || self.current(state),
            |inner| {
                inner.end_session(CONNECTION_CLOSED);
                inner.closed.call(&());
                let mut state = inner.state();
                state.pipe = None;
                state.connecting = false;
            },
        );
    }
}

/// The helper client: see the module docs.
pub(super) struct HelperClient {
    inner: Arc<Inner>,
}

impl HelperClient {
    pub(super) fn new(connector: Arc<dyn HelperConnector>, timers: Arc<dyn Timers>) -> Self {
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| Inner {
            connector,
            timers,
            deadline_ms: FRAME_DEADLINE_MS,
            state: Mutex::new(State { connecting: false, dialing: None, dials: 0, pipe: None, session: None, pending: Vec::new(), sends: 0 }),
            desktop_changed: ListenerSet::new(),
            closed: ListenerSet::new(),
            challenges: ListenerSet::new(),
            errors: ListenerSet::new(),
            frames: ListenerSet::new(),
            me: me.clone(),
            #[cfg(test)]
            pipe_event_seen: Mutex::new(None),
        });
        Self { inner }
    }

    /// The authenticated session, `None` when not connected.
    pub(super) fn client_session(&self) -> Option<ClientSession> {
        self.inner.state().session.clone()
    }

    /// Test only: `seen` is told each pipe event's connect number once the event was taken or ignored.
    #[cfg(test)]
    pub(super) fn on_pipe_event(&self, seen: Arc<dyn Fn(u64) + Send + Sync>) {
        *lock_slot(&self.inner.pipe_event_seen) = Some(seen);
    }
}

impl HelperService for HelperClient {
    fn available(&self) -> bool {
        self.inner.connector.available()
    }

    fn session(&self) -> Option<HelperSession> {
        self.inner.state().session.as_ref().map(|session| HelperSession {
            session: session.session,
            desktop: session.desktop.clone(),
            locked: session.locked,
        })
    }

    fn connect(&self) -> BoxFuture<Result<(), String>> {
        if !self.inner.connector.available() {
            return Box::pin(async { Err(NOT_INSTALLED.to_string()) });
        }
        let dial = {
            let mut state = self.inner.state();
            if state.connecting {
                return Box::pin(async { Err(ALREADY_CONNECTED.to_string()) });
            }
            state.connecting = true;
            state.dials += 1;
            state.dials
        };
        let Dialing { mut done, abort } = self.inner.connector.connect(Arc::new(Socket { inner: Arc::downgrade(&self.inner), dial }));
        let (give_up, mut given_up) = oneshot::channel();
        self.inner.state().dialing = Some((abort, give_up));
        let inner = self.inner.clone();
        Box::pin(async move {
            // Given up first: `close` ran in a turn before this poll, so a connection made meanwhile is not this
            // client's; it is dropped with `done`.
            let outcome = std::future::poll_fn(|context| {
                if std::pin::Pin::new(&mut given_up).poll(context).is_ready() {
                    return std::task::Poll::Ready(None);
                }
                done.as_mut().poll(context).map(Some)
            })
            .await;
            let Some(outcome) = outcome else {
                return Err(CONNECTION_CLOSED.to_string());
            };
            let mut state = inner.state();
            state.dialing = None;
            match outcome {
                Ok((pipe, hello)) => {
                    state.pipe = Some(pipe);
                    state.session = Some(hello);
                    Ok(())
                }
                Err(error) => {
                    state.connecting = false;
                    Err(error)
                }
            }
        })
    }

    fn on_desktop_changed(&self, listener: Listener<HelperSession>) -> Unsub {
        self.inner.desktop_changed.add(listener)
    }

    fn on_close(&self, listener: Listener<()>) -> Unsub {
        self.inner.closed.add(listener)
    }

    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        self.inner.challenges.add(listener)
    }

    fn on_error(&self, listener: Listener<(String, String)>) -> Unsub {
        self.inner.errors.add(listener)
    }

    fn on_frame(&self, listener: Listener<(FrameHeader, Arc<Vec<u8>>)>) -> Unsub {
        self.inner.frames.add(listener)
    }

    fn set_active(&self, active: bool) {
        self.inner.send(Message::Control { active });
    }

    fn send_input(&self, event: InputEvent) -> BoxFuture<Result<(), String>> {
        self.inner.send_bounded(Message::Input { event })
    }

    fn close(&self) {
        let pipe = {
            let mut state = self.inner.state();
            if let Some((abort, give_up)) = state.dialing.take() {
                // Still in its handshake: given up, with nothing written (Node ends the connection; nothing but
                // the handshake may precede authentication), and the connect fails now.
                state.connecting = false;
                drop(state);
                abort();
                drop(give_up.send(()));
                return;
            }
            state.pipe.clone()
        };
        let Some(pipe) = pipe else {
            return;
        };
        self.set_active(false);
        // Writes already handed over flush before the end; their sends settle from their own writes.
        {
            let mut state = self.inner.state();
            state.session = None;
            state.pipe = None;
            state.connecting = false;
        }
        pipe.end();
    }

    fn set_video_run(&self, epoch: u64) {
        self.inner.send(Message::VideoRun { epoch });
    }

    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), String>> {
        self.inner.send_bounded(Message::Grant { challenge: grant.challenge, epoch: grant.epoch, signature: grant.signature })
    }

    fn sas(&self) -> BoxFuture<Result<(), String>> {
        self.inner.send_bounded(Message::Sas)
    }
}

/// The installed helper's pipe: [`mixdog_secure_desktop::client::Link`] driven by one owner thread (its handle is
/// synchronous, so a blocked read would hold up a write from another thread). Writes reach the thread in order; what
/// the helper sends reaches the client in order, as tasks of the screen control's runtime. The owner thread ends,
/// and the pipe handle with it, when the pipe is ended, when the client is gone, or when the connect was given up.
pub(super) struct LinkConnector {
    available: Arc<dyn Fn() -> bool + Send + Sync>,
    dial: Arc<dyn Fn() -> Result<(Box<dyn LinkIo>, ClientSession), String> + Send + Sync>,
    timers: Arc<dyn Timers>,
}

/// An authenticated link as the owner thread drives it; made on that thread and never leaving it (the pipe handle is
/// not `Send`).
pub(super) trait LinkIo {
    fn write(&mut self, message: Message) -> std::io::Result<()>;
    /// The next event, or `None` when nothing arrived within `wait`; an error once the pipe closed.
    fn next(&mut self, wait: Duration) -> std::io::Result<Option<mixdog_secure_desktop::client::Event>>;
}

impl LinkIo for mixdog_secure_desktop::client::Link {
    fn write(&mut self, message: Message) -> std::io::Result<()> {
        match message {
            Message::Control { active } => self.set_active(active),
            Message::VideoRun { epoch } => self.set_video_run(epoch),
            Message::Grant { challenge, epoch, signature } => self.grant(challenge, epoch, signature),
            Message::Input { event } => self.send_input(event),
            Message::Sas => self.send_sas(),
            other => Err(std::io::Error::other(format!("the client does not send {other:?}"))),
        }
    }

    fn next(&mut self, wait: Duration) -> std::io::Result<Option<mixdog_secure_desktop::client::Event>> {
        mixdog_secure_desktop::client::Link::next(self, wait)
    }
}

impl LinkConnector {
    /// The installed helper, dialled and authenticated by [`mixdog_secure_desktop::client::Link::connect`].
    pub(super) fn installed(timers: Arc<dyn Timers>) -> Self {
        Self {
            available: Arc::new(|| {
                std::fs::read_to_string(mixdog_secure_desktop::paths::state_file())
                    .ok()
                    .and_then(|text| mixdog_secure_desktop::security::InstallState::from_json(&text).ok())
                    .is_some()
            }),
            dial: Arc::new(|| {
                let link = mixdog_secure_desktop::client::Link::connect()?;
                let hello = link.hello().clone();
                let session = ClientSession {
                    protocol: hello.protocol,
                    version: hello.version,
                    session: hello.session,
                    desktop: hello.desktop,
                    locked: hello.locked,
                };
                Ok((Box::new(link) as Box<dyn LinkIo>, session))
            }),
            timers,
        }
    }

    /// Test only: a connector over `dial`, which runs on the owner thread as the real handshake does.
    #[cfg(test)]
    pub(super) fn with(dial: Arc<dyn Fn() -> Result<(Box<dyn LinkIo>, ClientSession), String> + Send + Sync>, timers: Arc<dyn Timers>) -> Self {
        Self { available: Arc::new(|| true), dial, timers }
    }
}

enum PipeCommand {
    Write(Message, Box<dyn FnOnce(Result<(), String>) + Send>),
    End,
}

struct LinkPipe {
    commands: Mutex<std::sync::mpsc::Sender<PipeCommand>>,
}

impl HelperPipe for LinkPipe {
    fn write(&self, message: Message, done: Box<dyn FnOnce(Result<(), String>) + Send>) {
        let sent = self.commands.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).send(PipeCommand::Write(message, done));
        if let Err(std::sync::mpsc::SendError(PipeCommand::Write(_, done))) = sent {
            done(Err(CONNECTION_CLOSED.to_string()));
        }
    }

    fn end(&self) {
        let _ = self.commands.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).send(PipeCommand::End);
    }
}

enum PipeEvent {
    DesktopChanged(String, u32, Option<bool>),
    Challenge(Challenge),
    Error(String, String),
    Frame(FrameHeader, Arc<Vec<u8>>),
    Closed,
}

/// How long the owner thread waits for the helper before it looks for writes again.
const OWNER_WAIT: Duration = Duration::from_millis(5);

fn own_link(mut link: Box<dyn LinkIo>, commands: std::sync::mpsc::Receiver<PipeCommand>, events: tokio::sync::mpsc::UnboundedSender<PipeEvent>) {
    use mixdog_secure_desktop::client::Event;
    loop {
        loop {
            match commands.try_recv() {
                Ok(PipeCommand::Write(message, done)) => done(link.write(message).map_err(|error| error.to_string())),
                Ok(PipeCommand::End) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    drop(link);
                    let _ = events.send(PipeEvent::Closed);
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
            }
        }
        let event = match link.next(OWNER_WAIT) {
            Ok(None) => continue,
            Ok(Some(Event::Frame(header, pixels))) => PipeEvent::Frame(header, Arc::new(pixels)),
            Ok(Some(Event::DesktopChanged { desktop, session, locked })) => PipeEvent::DesktopChanged(desktop, session, locked),
            Ok(Some(Event::Error { code, message })) => PipeEvent::Error(code, message),
            Ok(Some(Event::GrantChallenge { nonce, challenge })) => PipeEvent::Challenge(Challenge { nonce, challenge }),
            Err(_) => {
                let _ = events.send(PipeEvent::Closed);
                return;
            }
        };
        if events.send(event).is_err() {
            return;
        }
    }
}

impl HelperConnector for LinkConnector {
    fn available(&self) -> bool {
        (self.available)()
    }

    fn connect(&self, events: Arc<dyn PipeEvents>) -> Dialing {
        let (connected, answer) = oneshot::channel();
        let (event_sender, mut event_receiver) = tokio::sync::mpsc::unbounded_channel();
        self.timers.spawn(Box::pin(async move {
            while let Some(event) = event_receiver.recv().await {
                match event {
                    PipeEvent::DesktopChanged(desktop, session, locked) => events.desktop_changed(desktop, session, locked),
                    PipeEvent::Challenge(challenge) => events.grant_challenge(challenge),
                    PipeEvent::Error(code, message) => events.error(code, message),
                    PipeEvent::Frame(header, pixels) => events.frame(header, pixels),
                    PipeEvent::Closed => {
                        events.closed();
                        return;
                    }
                }
            }
        }));
        let given_up = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let abort = given_up.clone();
        let dial = self.dial.clone();
        std::thread::spawn(move || match dial() {
            Err(error) => {
                let _ = connected.send(Err(error));
            }
            // Given up while it was being made: the link is dropped here, which closes the pipe.
            Ok(_) if given_up.load(std::sync::atomic::Ordering::SeqCst) => {
                let _ = connected.send(Err(CONNECTION_CLOSED.to_string()));
            }
            Ok((link, session)) => {
                let (commands, receiver) = std::sync::mpsc::channel();
                let pipe: Arc<dyn HelperPipe> = Arc::new(LinkPipe { commands: Mutex::new(commands) });
                if connected.send(Ok((pipe, session))).is_ok() {
                    own_link(link, receiver, event_sender);
                }
            }
        });
        Dialing {
            done: Box::pin(async move { answer.await.unwrap_or_else(|_| Err("the helper connection ended before its handshake".to_string())) }),
            abort: Box::new(move || abort.store(true, std::sync::atomic::Ordering::SeqCst)),
        }
    }
}
