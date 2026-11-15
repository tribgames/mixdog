//! One upgraded connection, with what the relay relies on from `ws`'s `WebSocket` (`lib/websocket.js`): `send` with a
//! flush callback and `bufferedAmount`, ping and pong with the automatic pong, `close` with its timeout, `terminate`, the
//! order of the events, `pause` and `resume`, and the raw tap the relay installs on the transport (`prependListener('data')`
//! in `trackLegIngress`).
//!
//! A socket is two tasks over the split transport. The writer drains a queue, so `send` never blocks and
//! `buffered_amount` is what the queue still holds. The reader reads one chunk at a time, only while no holder gates
//! it, hands the chunk to the tap and then to the frame parser, and turns what the parser finds into events.

use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::codec::{
    FrameError, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, Receiver, ReceiverError, ReceiverEvent, close_payload,
    frame_header,
};

/// The size of one read from the transport (Node reads sockets in chunks of up to 64 KiB).
const READ_CHUNK: usize = 64 * 1024;
/// A frame up to this size is written as one buffer (header and payload), as a corked pair of writes leaves it.
const COALESCE_LIMIT: usize = 64 * 1024;

const HOLD_PAUSE: u8 = 1;
const HOLD_UPLINK: u8 = 2;
const HOLD_INGRESS: u8 = 4;
const HOLD_START: u8 = 8;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn wait_true(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|value| *value).await;
}

/// The byte stream under a WebSocket: a TCP stream, a TLS stream over one, or a test pipe.
pub trait Transport: AsyncRead + AsyncWrite + Unpin + Send + 'static {
    /// `socket.setNoDelay()`: called once, when the connection is upgraded.
    fn set_no_delay(&self) {}
}

impl Transport for TcpStream {
    fn set_no_delay(&self) {
        let _ = TcpStream::set_nodelay(self, true);
    }
}

impl Transport for tokio_rustls::server::TlsStream<TcpStream> {
    fn set_no_delay(&self) {
        let _ = self.get_ref().0.set_nodelay(true);
    }
}

impl Transport for tokio::io::DuplexStream {}

/// `readyState` of `ws`, without CONNECTING: a socket is only handed out once it is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ReadyState {
    Open = 1,
    Closing = 2,
    Closed = 3,
}

impl ReadyState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Open,
            2 => Self::Closing,
            _ => Self::Closed,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Open => "OPEN",
            Self::Closing => "CLOSING",
            Self::Closed => "CLOSED",
        }
    }
}

/// Why a write was not made: the error `ws` hands the send callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    NotOpen(ReadyState),
    Destroyed,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOpen(state) => write!(f, "WebSocket is not open: readyState {} ({})", *state as u8, state.name()),
            Self::Destroyed => f.write_str("The socket was destroyed before the frame was written"),
        }
    }
}

impl std::error::Error for SendError {}

/// The callback of `send`, `ping` and `pong`: called once, from the writer task or a fresh task, when the frame was
/// accepted by the transport or could not be written. It must not block.
pub type FlushCallback = Box<dyn FnOnce(Result<(), SendError>) + Send + 'static>;

/// What a socket reports, in the order `ws` emits it. `Close` is last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsEvent {
    Message {
        data: Bytes,
        is_binary: bool,
    },
    Ping(Bytes),
    Pong(Bytes),
    /// A protocol error of the peer; the socket answers it with a close frame and the `Close` event follows.
    Error(ReceiverError),
    /// The connection is finished. `code` is 1006 unless the peer's close frame was read.
    Close {
        code: u16,
        reason: Bytes,
    },
}

/// The two parties that can stop the relay reading a leg. Each holds and releases on its own; the transport is read
/// again only when neither holds (and `pause` was not called), as `legPausedUplink` and `legPausedIngress` do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    Uplink,
    Ingress,
}

impl Holder {
    fn bit(self) -> u8 {
        match self {
            Self::Uplink => HOLD_UPLINK,
            Self::Ingress => HOLD_INGRESS,
        }
    }
}

/// The read gate of a socket: a set of holds, shared with the reader task.
#[derive(Clone)]
pub struct Gate {
    tx: Arc<watch::Sender<u8>>,
    // Keeps the channel open for `send_if_modified` while no task is subscribed.
    _keep: Arc<watch::Receiver<u8>>,
}

impl Gate {
    fn new(initial: u8) -> Self {
        let (tx, rx) = watch::channel(initial);
        Self { tx: Arc::new(tx), _keep: Arc::new(rx) }
    }

    fn set(&self, bit: u8, on: bool) {
        self.tx.send_if_modified(|value| {
            let next = if on { *value | bit } else { *value & !bit };
            let changed = next != *value;
            *value = next;
            changed
        });
    }

    fn subscribe(&self) -> watch::Receiver<u8> {
        self.tx.subscribe()
    }

    /// Stop reading until `release` of the same holder (and of every other one).
    pub fn hold(&self, holder: Holder) {
        self.set(holder.bit(), true);
    }

    pub fn release(&self, holder: Holder) {
        self.set(holder.bit(), false);
    }

    pub fn is_held(&self, holder: Holder) -> bool {
        *self.tx.borrow() & holder.bit() != 0
    }
}

/// An observer of the raw bytes of the connection. Each chunk read from the transport reaches it before the parser, the
/// handshake's leftover bytes first. It may hold the gate: the chunk in hand is still parsed, the next read waits.
pub trait RawTap: Send {
    fn chunk(&mut self, bytes: &[u8], gate: &Gate);
}

enum Out {
    Frame {
        head: [u8; 10],
        head_len: usize,
        payload: Bytes,
        on_flushed: Option<FlushCallback>,
    },
    /// `socket.end()`: close the write side once everything before it was written.
    End,
}

#[derive(Default)]
struct Core {
    close_frame_sent: bool,
    close_frame_received: bool,
    /// A receiver error was emitted (`_receiver._writableState.errorEmitted`).
    errored: bool,
    close_code: Option<u16>,
    close_message: Bytes,
    close_timer: Option<JoinHandle<()>>,
}

struct Inner {
    ready: AtomicU8,
    buffered: AtomicUsize,
    gate: Gate,
    out: mpsc::UnboundedSender<Out>,
    destroy: watch::Sender<bool>,
    events: mpsc::UnboundedSender<WsEvent>,
    core: Mutex<Core>,
    tap: Mutex<Option<Box<dyn RawTap>>>,
    close_timeout: Duration,
    auto_pong: bool,
}

impl Inner {
    fn ready(&self) -> ReadyState {
        ReadyState::from_u8(self.ready.load(Ordering::SeqCst))
    }

    fn set_ready(&self, state: ReadyState) {
        self.ready.store(state as u8, Ordering::SeqCst);
    }

    fn destroy(&self) {
        self.destroy.send_replace(true);
    }

    fn end(&self) {
        let _ = self.out.send(Out::End);
    }

    fn begin(&self) {
        self.gate.set(HOLD_START, false);
    }

    fn fail_later(callback: Option<FlushCallback>, error: SendError) {
        if let Some(callback) = callback {
            tokio::spawn(async move { callback(Err(error)) });
        }
    }

    /// `sendAfterClose`: the bytes are counted as buffered for good, and the callback is told the socket is not open.
    fn send_after_close(&self, length: usize, callback: Option<FlushCallback>) {
        self.buffered.fetch_add(length, Ordering::SeqCst);
        Self::fail_later(callback, SendError::NotOpen(self.ready()));
    }

    fn enqueue(&self, opcode: u8, payload: Bytes, on_flushed: Option<FlushCallback>) {
        let (head, head_len) = frame_header(opcode, true, payload.len());
        let size = head_len + payload.len();
        self.buffered.fetch_add(size, Ordering::SeqCst);
        if let Err(mpsc::error::SendError(item)) = self.out.send(Out::Frame { head, head_len, payload, on_flushed }) {
            self.buffered.fetch_sub(size, Ordering::SeqCst);
            if let Out::Frame { on_flushed, .. } = item {
                Self::fail_later(on_flushed, SendError::Destroyed);
            }
        }
    }

    fn send_frame(&self, opcode: u8, payload: Bytes, callback: Option<FlushCallback>) {
        if self.ready() == ReadyState::Open {
            self.enqueue(opcode, payload, callback);
        } else {
            self.send_after_close(payload.len(), callback);
        }
    }

    fn send_control(&self, opcode: u8, data: Bytes, callback: Option<FlushCallback>) -> Result<(), FrameError> {
        if self.ready() != ReadyState::Open {
            self.send_after_close(data.len(), callback);
            return Ok(());
        }
        if data.len() > 125 {
            return Err(FrameError::ControlTooLong);
        }
        self.enqueue(opcode, data, callback);
        Ok(())
    }

    fn close(self: &Arc<Self>, code: Option<u16>, reason: &[u8]) -> Result<(), FrameError> {
        match self.ready() {
            ReadyState::Closed => return Ok(()),
            ReadyState::Closing => {
                let end = {
                    let core = lock(&self.core);
                    core.close_frame_sent && (core.close_frame_received || core.errored)
                };
                if end {
                    self.end();
                }
                return Ok(());
            }
            ReadyState::Open => {}
        }
        let payload = close_payload(code, reason)?;
        let socket = Arc::clone(self);
        self.enqueue(
            OP_CLOSE,
            Bytes::from(payload),
            Some(Box::new(move |result| {
                if result.is_err() {
                    return;
                }
                let end = {
                    let mut core = lock(&socket.core);
                    core.close_frame_sent = true;
                    core.close_frame_received || core.errored
                };
                if end {
                    socket.end();
                }
            })),
        );
        self.set_ready(ReadyState::Closing);
        let socket = Arc::clone(self);
        let timeout = self.close_timeout;
        let timer = tokio::spawn(async move {
            mixdog_rt::time::sleep(timeout).await;
            socket.destroy();
        });
        if let Some(previous) = lock(&self.core).close_timer.replace(timer) {
            previous.abort();
        }
        Ok(())
    }

    fn on_event(self: &Arc<Self>, event: ReceiverEvent) {
        match event {
            ReceiverEvent::Message { data, binary } => {
                let _ = self.events.send(WsEvent::Message { data, is_binary: binary });
            }
            ReceiverEvent::Ping(data) => {
                if self.auto_pong {
                    self.send_frame(OP_PONG, data.clone(), None);
                }
                let _ = self.events.send(WsEvent::Ping(data));
            }
            ReceiverEvent::Pong(data) => {
                let _ = self.events.send(WsEvent::Pong(data));
            }
            ReceiverEvent::Conclude { code, reason } => {
                {
                    let mut core = lock(&self.core);
                    core.close_frame_received = true;
                    core.close_message = reason.clone();
                    core.close_code = Some(code);
                }
                let _ = if code == 1005 { self.close(None, &[]) } else { self.close(Some(code), &reason) };
            }
        }
    }

    fn on_receiver_error(self: &Arc<Self>, error: ReceiverError) {
        lock(&self.core).errored = true;
        let _ = self.close(Some(error.status_code), &[]);
        let _ = self.events.send(WsEvent::Error(error));
    }

    /// What follows the end of the read side: `socketOnEnd` when the peer finished it, then `socketOnClose`.
    async fn finish(self: &Arc<Self>, peer_ended: bool, writer_done: &mut watch::Receiver<bool>) {
        if peer_ended {
            self.set_ready(ReadyState::Closing);
            self.end();
            let mut destroyed = self.destroy.subscribe();
            tokio::select! {
                () = wait_true(writer_done) => {}
                () = wait_true(&mut destroyed) => {}
            }
        }
        self.destroy();
        let (code, reason) = {
            let mut core = lock(&self.core);
            if let Some(timer) = core.close_timer.take() {
                timer.abort();
            }
            (core.close_code.unwrap_or(1006), core.close_message.clone())
        };
        self.set_ready(ReadyState::Closed);
        let _ = self.events.send(WsEvent::Close { code, reason });
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(write: &mut W, head: &[u8], payload: &[u8]) -> std::io::Result<()> {
    if payload.len() <= COALESCE_LIMIT {
        let mut frame = Vec::with_capacity(head.len() + payload.len());
        frame.extend_from_slice(head);
        frame.extend_from_slice(payload);
        write.write_all(&frame).await?;
    } else {
        write.write_all(head).await?;
        write.write_all(payload).await?;
    }
    write.flush().await
}

async fn run_writer<W: AsyncWrite + Unpin>(
    mut write: W,
    mut queue: mpsc::UnboundedReceiver<Out>,
    inner: Arc<Inner>,
    done: watch::Sender<bool>,
) {
    let mut destroyed = inner.destroy.subscribe();
    loop {
        let item = tokio::select! {
            biased;
            () = wait_true(&mut destroyed) => None,
            item = queue.recv() => item,
        };
        let Some(item) = item else { break };
        match item {
            Out::End => {
                tokio::select! {
                    _ = write.shutdown() => {}
                    () = wait_true(&mut destroyed) => {}
                }
                break;
            }
            Out::Frame { head, head_len, payload, on_flushed } => {
                let size = head_len + payload.len();
                let written = tokio::select! {
                    result = write_frame(&mut write, &head[..head_len], &payload) => result.is_ok(),
                    () = wait_true(&mut destroyed) => false,
                };
                inner.buffered.fetch_sub(size, Ordering::SeqCst);
                if let Some(callback) = on_flushed {
                    callback(if written { Ok(()) } else { Err(SendError::Destroyed) });
                }
                if !written {
                    inner.destroy();
                    break;
                }
            }
        }
    }
    // Whatever is still queued fails, as writes to a destroyed stream do.
    queue.close();
    while let Ok(item) = queue.try_recv() {
        if let Out::Frame { head_len, payload, on_flushed, .. } = item {
            inner.buffered.fetch_sub(head_len + payload.len(), Ordering::SeqCst);
            if let Some(callback) = on_flushed {
                callback(Err(SendError::Destroyed));
            }
        }
    }
    let _ = done.send(true);
}

async fn run_reader<R: AsyncRead + Unpin>(
    mut read: R,
    head: Bytes,
    inner: Arc<Inner>,
    max_payload: u64,
    mut writer_done: watch::Receiver<bool>,
    on_close: Box<dyn FnOnce() + Send>,
) {
    let mut receiver = Receiver::new(max_payload);
    let mut gate = inner.gate.subscribe();
    let mut destroyed = inner.destroy.subscribe();
    let mut parsing = true;
    let mut pending = Some(head).filter(|bytes| !bytes.is_empty());
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut peer_ended = false;
    'read: loop {
        loop {
            let held = *gate.borrow_and_update();
            if held == 0 {
                break;
            }
            tokio::select! {
                biased;
                () = wait_true(&mut destroyed) => break 'read,
                changed = gate.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
            }
        }
        let chunk = match pending.take() {
            Some(head) => head,
            None => {
                tokio::select! {
                    biased;
                    () = wait_true(&mut destroyed) => break 'read,
                    count = read.read(&mut buffer) => match count {
                        Ok(0) => {
                            peer_ended = true;
                            break 'read;
                        }
                        Ok(count) => Bytes::copy_from_slice(&buffer[..count]),
                        Err(_) => break 'read,
                    },
                }
            }
        };
        if let Some(tap) = lock(&inner.tap).as_mut() {
            tap.chunk(&chunk, &inner.gate);
        }
        if parsing {
            let mut found = Vec::new();
            let outcome = receiver.feed(chunk, &mut found);
            for event in found {
                inner.on_event(event);
            }
            match outcome {
                Err(error) => {
                    parsing = false;
                    inner.on_receiver_error(error);
                }
                Ok(()) => parsing = !receiver.finished(),
            }
        }
    }
    inner.finish(peer_ended, &mut writer_done).await;
    on_close();
}

/// The options of one connection.
pub(super) struct SocketConfig {
    pub max_payload: u64,
    pub close_timeout: Duration,
    pub auto_pong: bool,
}

/// Start the tasks of a connection whose 101 answer was written. `head` is what the HTTP layer had read past the request.
pub(super) fn spawn<S: Transport>(
    io: S,
    head: Bytes,
    config: &SocketConfig,
    on_close: Box<dyn FnOnce() + Send>,
) -> (WebSocket, WsEvents) {
    io.set_no_delay();
    let (read, write) = tokio::io::split(io);
    let (out, queue) = mpsc::unbounded_channel();
    let (events, event_rx) = mpsc::unbounded_channel();
    let (destroy, _) = watch::channel(false);
    let (done_tx, done_rx) = watch::channel(false);
    let inner = Arc::new(Inner {
        ready: AtomicU8::new(ReadyState::Open as u8),
        buffered: AtomicUsize::new(0),
        // Reading starts when the owner first takes an event, so a tap installed right after the upgrade sees every byte.
        gate: Gate::new(HOLD_START),
        out,
        destroy,
        events,
        core: Mutex::new(Core::default()),
        tap: Mutex::new(None),
        close_timeout: config.close_timeout,
        auto_pong: config.auto_pong,
    });
    tokio::spawn(run_writer(write, queue, Arc::clone(&inner), done_tx));
    tokio::spawn(run_reader(read, head, Arc::clone(&inner), config.max_payload, done_rx, on_close));
    let events = WsEvents { rx: event_rx, inner: Arc::clone(&inner), finished: false };
    (WebSocket { inner }, events)
}

/// The events of a socket. The first call to `next` (or dropping it) starts the reading of the connection.
pub struct WsEvents {
    rx: mpsc::UnboundedReceiver<WsEvent>,
    inner: Arc<Inner>,
    finished: bool,
}

impl WsEvents {
    /// The next event; `None` after `Close`.
    pub async fn next(&mut self) -> Option<WsEvent> {
        if self.finished {
            return None;
        }
        self.inner.begin();
        let event = self.rx.recv().await;
        if matches!(event, Some(WsEvent::Close { .. }) | None) {
            self.finished = true;
        }
        event
    }
}

impl Drop for WsEvents {
    fn drop(&mut self) {
        self.inner.begin();
    }
}

/// An open connection. Clones are handles to the same socket; dropping them does not close it.
#[derive(Clone)]
pub struct WebSocket {
    inner: Arc<Inner>,
}

impl WebSocket {
    pub fn ready_state(&self) -> ReadyState {
        self.inner.ready()
    }

    pub fn is_open(&self) -> bool {
        self.inner.ready() == ReadyState::Open
    }

    /// `bufferedAmount`: the bytes of frames queued and not yet accepted by the transport.
    pub fn buffered_amount(&self) -> usize {
        self.inner.buffered.load(Ordering::SeqCst)
    }

    /// Send a text message. The text must be UTF-8: it is not checked again. The callback runs when the frame was
    /// written (or could not be).
    pub fn send_text(&self, text: impl Into<Bytes>, on_flushed: Option<FlushCallback>) {
        self.inner.send_frame(OP_TEXT, text.into(), on_flushed);
    }

    pub fn send_binary(&self, data: impl Into<Bytes>, on_flushed: Option<FlushCallback>) {
        self.inner.send_frame(OP_BINARY, data.into(), on_flushed);
    }

    /// A ping of at most 125 bytes; the pong comes as an event.
    pub fn ping(&self, data: impl Into<Bytes>, on_flushed: Option<FlushCallback>) -> Result<(), FrameError> {
        self.inner.send_control(OP_PING, data.into(), on_flushed)
    }

    pub fn pong(&self, data: impl Into<Bytes>, on_flushed: Option<FlushCallback>) -> Result<(), FrameError> {
        self.inner.send_control(OP_PONG, data.into(), on_flushed)
    }

    /// Send a close frame and wait for the peer's, at most the close timeout (30 s), then destroy the connection. A code
    /// that may not be sent, or a reason over 123 bytes, is an error and nothing is sent. `reason` is UTF-8 bytes.
    pub fn close(&self, code: u16, reason: impl AsRef<[u8]>) -> Result<(), FrameError> {
        self.inner.begin();
        self.inner.close(Some(code), reason.as_ref())
    }

    /// Destroy the connection at once: the peer sees it drop with no close frame, and `Close` carries 1006.
    pub fn terminate(&self) {
        if self.inner.ready() == ReadyState::Closed {
            return;
        }
        self.inner.set_ready(ReadyState::Closing);
        self.inner.destroy();
        self.inner.begin();
    }

    /// `pause()`: stop reading until `resume`.
    pub fn pause(&self) {
        if self.inner.ready() != ReadyState::Closed {
            self.inner.gate.set(HOLD_PAUSE, true);
        }
    }

    pub fn resume(&self) {
        if self.inner.ready() != ReadyState::Closed {
            self.inner.gate.set(HOLD_PAUSE, false);
        }
    }

    pub fn is_paused(&self) -> bool {
        *self.inner.gate.tx.borrow() & HOLD_PAUSE != 0
    }

    /// The read gate: holds of the uplink backlog and of ingress admission, independent of each other and of `pause`.
    pub fn gate(&self) -> &Gate {
        &self.inner.gate
    }

    /// Install the raw tap (replacing a previous one).
    pub fn set_raw_tap(&self, tap: Box<dyn RawTap>) {
        *lock(&self.inner.tap) = Some(tap);
    }
}
