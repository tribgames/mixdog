//! One connection: the requests of a keep-alive socket, served one after another as Node serves them.
//!
//! What a client can observe is Node's: raw refusals (`HTTP/1.1 <status> <reason>\r\nConnection: close\r\n\r\n`, nothing
//! else), `Expect: 100-continue` answered before the handler runs, the idle close after `keepAliveTimeout`, the
//! `headersTimeout` and `requestTimeout` refusals, a request body discarded after the answer, and the hand-off of an upgrade
//! with the bytes already read. Requests pipelined behind one another are answered in order, each handled once the one before
//! it is answered.

use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::{Buf, Bytes, BytesMut};
use mixdog_rt::time::{Instant, sleep_until, timeout};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, WriteHalf};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::body::{Pump, Step};
use super::head::{self, HeadError, ParsedHead, Parse};
use super::response::{ResponseMeta, ResponseWriter, has_word, status_message};
use super::{Handler, RawIo, Request, UpgradeRequest, refusal_bytes};
use crate::logline;

/// How long a socket that has been refused or answered with `Connection: close` is read for after its write side is shut,
/// so that a client still sending does not meet a reset that discards the answer.
const LINGER: Duration = Duration::from_secs(1);

/// Node's server timeouts.
#[derive(Debug, Clone)]
pub struct Limits {
    /// `--max-http-header-size`.
    pub max_header_bytes: usize,
    /// `server.keepAliveTimeout`.
    pub keep_alive_timeout: Duration,
    /// `server.keepAliveTimeoutBuffer`: the idle socket is closed this long after `keep_alive_timeout`.
    pub keep_alive_buffer: Duration,
    /// `server.headersTimeout`.
    pub headers_timeout: Duration,
    /// `server.requestTimeout`.
    pub request_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_header_bytes: head::MAX_HEADER_BYTES,
            keep_alive_timeout: Duration::from_secs(5),
            keep_alive_buffer: Duration::from_secs(1),
            headers_timeout: Duration::from_secs(60),
            request_timeout: Duration::from_secs(300),
        }
    }
}

/// What the connection knows of its peer.
#[derive(Debug, Clone)]
pub struct ConnInfo {
    /// `socket.remoteAddress`.
    pub remote_address: Option<String>,
    /// `socket.encrypted`.
    pub encrypted: bool,
}

/// The state a connection shares with its response and its handle.
#[derive(Debug, Default)]
pub(crate) struct Out {
    /// Bytes accepted from the handler, not yet on the socket.
    pub queue: VecDeque<Bytes>,
    pub queued: usize,
    /// The response this state is of; a new response starts a new epoch.
    pub epoch: u64,
    pub head_sent: bool,
    /// The handler ended the response (or the connection answered for it).
    pub ended: bool,
    /// The head said the connection closes after this response (`res._last`).
    pub last: bool,
    /// The ended response is entirely on the socket (`'finish'`).
    pub flushed: bool,
    pub destroyed: bool,
    /// The connection has answered for the handler: nothing the handler writes any more goes out.
    pub sealed: bool,
    /// No request is being received or served.
    pub idle: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Shared {
    out: Mutex<Out>,
    changed: Notify,
}

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Out> {
        self.out.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Wakes everything waiting on a change of the state.
    pub(crate) fn notify(&self) {
        self.changed.notify_waiters();
    }

    /// Waits until `ready` holds of the state.
    pub(crate) async fn wait_for(&self, ready: impl Fn(&Out) -> bool) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if ready(&self.lock()) {
                return;
            }
            notified.await;
        }
    }

    fn begin_response(&self) -> u64 {
        let mut out = self.lock();
        out.epoch += 1;
        out.queue.clear();
        out.queued = 0;
        out.head_sent = false;
        out.ended = false;
        out.last = false;
        out.flushed = false;
        out.sealed = false;
        out.idle = false;
        out.epoch
    }

    fn set_idle(&self, idle: bool) {
        self.lock().idle = idle;
    }

    fn is_destroyed(&self) -> bool {
        self.lock().destroyed
    }

    /// Ends a response the handler left unfinished: what is queued goes out, nothing more, and the connection closes after it
    /// (a destroyed socket whose written bytes are already with the kernel, as the guards of Node leave it).
    fn cut_short(&self) {
        let mut out = self.lock();
        if !out.destroyed && !out.ended {
            out.sealed = true;
            out.ended = true;
            out.last = true;
        }
        drop(out);
        self.notify();
    }

    /// Answers for a handler that cannot (a timeout, a malformed body): the raw refusal when nothing of the response has
    /// gone out, else the connection is destroyed.
    fn refuse_in_flight(&self, status: u16) {
        let mut out = self.lock();
        if !out.destroyed && !out.sealed {
            if out.ended {
                out.destroyed = true;
            } else if out.head_sent {
                out.sealed = true;
                out.ended = true;
                out.last = true;
            } else {
                let raw = Bytes::from(refusal_bytes(status, status_message(status)));
                out.queued += raw.len();
                out.queue.push_back(raw);
                out.sealed = true;
                out.ended = true;
                out.last = true;
            }
        }
        drop(out);
        self.notify();
    }
}

/// The handle on a connection that a request and its response give the handler (`request.socket`).
#[derive(Debug, Clone)]
pub struct ConnHandle {
    shared: Arc<Shared>,
}

impl ConnHandle {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    /// `socket.destroy()`: closes the connection at once, what is queued and what is unread included.
    pub fn destroy(&self) {
        self.shared.lock().destroyed = true;
        self.shared.notify();
    }

    pub fn is_destroyed(&self) -> bool {
        self.shared.is_destroyed()
    }

    /// Resolves once the connection is destroyed.
    pub async fn destroyed(&self) {
        self.shared.wait_for(|out| out.destroyed).await;
    }
}

/// The connections of a server, for closing it.
#[derive(Debug, Default)]
pub struct Lifecycle {
    closing: AtomicBool,
    next: AtomicU64,
    live: Mutex<HashMap<u64, Arc<Shared>>>,
    changed: Notify,
}

impl Lifecycle {
    fn live(&self) -> MutexGuard<'_, HashMap<u64, Arc<Shared>>> {
        self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn register(self: &Arc<Self>, shared: &Arc<Shared>) -> ConnGuard {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.live().insert(id, shared.clone());
        ConnGuard { lifecycle: self.clone(), id }
    }

    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }

    /// `server.close()`: from now on answers say `Connection: close`, and the connections waiting for a request go.
    pub fn begin_close(&self) {
        self.closing.store(true, Ordering::Release);
        for shared in self.live().values() {
            let mut out = shared.lock();
            if out.idle {
                out.destroyed = true;
            }
            drop(out);
            shared.notify();
        }
    }

    /// `server.closeAllConnections()`.
    pub fn destroy_all(&self) {
        for shared in self.live().values() {
            shared.lock().destroyed = true;
            shared.notify();
        }
    }

    /// Resolves when no connection is left, upgraded ones included until their socket is dropped.
    pub async fn closed(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.live().is_empty() {
                return;
            }
            notified.await;
        }
    }
}

/// A connection's place in its server's [`Lifecycle`], given up when the connection (or the upgraded socket) is dropped.
#[derive(Debug)]
pub struct ConnGuard {
    lifecycle: Arc<Lifecycle>,
    id: u64,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.lifecycle.live().remove(&self.id);
        self.lifecycle.changed.notify_waiters();
    }
}

enum Next {
    Head(Box<ParsedHead>, Instant),
    Refuse(u16),
    Close,
}

enum Flow {
    /// Serve the next request.
    Next,
    /// Shut the write side after the answer and close (`destroySoon`).
    Close,
    /// Close at once.
    Destroy,
}

/// The tail of a connection: owns the socket's two halves between responses.
struct Conn<S> {
    rd: tokio::io::ReadHalf<S>,
    wr: Option<WriteHalf<S>>,
    buf: BytesMut,
    shared: Arc<Shared>,
    info: ConnInfo,
    handler: Arc<dyn Handler>,
    limits: Limits,
    lifecycle: Arc<Lifecycle>,
    guard: Option<ConnGuard>,
    /// Responses this connection has finished.
    served: u64,
}

/// Serves the requests of one connection until it closes.
pub async fn serve_connection<S>(io: S, info: ConnInfo, handler: Arc<dyn Handler>, limits: Limits, lifecycle: Arc<Lifecycle>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let shared = Arc::new(Shared::default());
    let guard = lifecycle.register(&shared);
    let (rd, wr) = tokio::io::split(io);
    let conn = Conn { rd, wr: Some(wr), buf: BytesMut::with_capacity(8192), shared, info, handler, limits, lifecycle, guard: Some(guard), served: 0 };
    conn.run().await;
}

impl<S> Conn<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    async fn run(mut self) {
        loop {
            let (head, started) = match self.read_head().await {
                Next::Head(head, started) => (head, started),
                Next::Refuse(status) => {
                    self.close_with(Some(refusal_bytes(status, status_message(status)))).await;
                    return;
                }
                Next::Close => return,
            };
            // A request that asks for an upgrade is handed over (an `upgrade` listener exists); `CONNECT` has no listener and
            // its socket is destroyed.
            if head.upgrade {
                if head.method != "CONNECT" {
                    self.hand_off(*head);
                }
                return;
            }
            match self.serve_request(*head, started).await {
                Flow::Next => self.served += 1,
                Flow::Close => {
                    self.close_with(None).await;
                    return;
                }
                Flow::Destroy => return,
            }
        }
    }

    /// Reads the next request head: the idle and header timeouts, and what Node answers raw.
    async fn read_head(&mut self) -> Next {
        enum Wake {
            Read(std::io::Result<usize>),
            Inactive,
            HeadersTimeout,
            Notified,
        }
        let mut started: Option<Instant> = None;
        loop {
            if !self.buf.is_empty() {
                let at = *started.get_or_insert_with(Instant::now);
                match head::parse(&self.buf, self.limits.max_header_bytes) {
                    Parse::Head(head) => {
                        self.buf.advance(head.head_len);
                        return Next::Head(head, at);
                    }
                    Parse::Refused(HeadError::Overflow) => return Next::Refuse(431),
                    Parse::Refused(HeadError::Malformed) => return Next::Refuse(400),
                    Parse::Partial => {}
                }
            }
            let shared = self.shared.clone();
            let notified = shared.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            shared.set_idle(self.buf.is_empty());
            if shared.is_destroyed() || (self.lifecycle.is_closing() && self.buf.is_empty()) {
                return Next::Close;
            }
            // After a response the socket idles for keepAliveTimeout; before the first request it waits for ever.
            let inactivity = (self.served > 0).then(|| self.limits.keep_alive_timeout + self.limits.keep_alive_buffer);
            let headers_deadline = started.map(|at| at + self.limits.headers_timeout);
            let wake = {
                let read = async {
                    match inactivity {
                        Some(limit) => match timeout(limit, self.rd.read_buf(&mut self.buf)).await {
                            Ok(read) => Wake::Read(read),
                            Err(_) => Wake::Inactive,
                        },
                        None => Wake::Read(self.rd.read_buf(&mut self.buf).await),
                    }
                };
                tokio::select! {
                    wake = read => wake,
                    () = async {
                        match headers_deadline {
                            Some(deadline) => sleep_until(deadline).await,
                            None => std::future::pending::<()>().await,
                        }
                    } => Wake::HeadersTimeout,
                    () = &mut notified => Wake::Notified,
                }
            };
            match wake {
                Wake::Read(Ok(read)) if read > 0 => {}
                // The peer closed: half a head is a bad request, nothing is a quiet end.
                Wake::Read(_) => return if self.buf.is_empty() { Next::Close } else { Next::Refuse(400) },
                Wake::Inactive => return Next::Close,
                Wake::HeadersTimeout => return Next::Refuse(408),
                Wake::Notified => {}
            }
        }
    }

    /// Writes what is left to write (`raw`), shuts the write side and waits a moment for the peer to finish.
    async fn close_with(&mut self, raw: Option<Vec<u8>>) {
        self.shared.set_idle(false);
        let Some(mut wr) = self.wr.take() else { return };
        if let Some(raw) = raw {
            if wr.write_all(&raw).await.is_err() {
                return;
            }
        }
        let _ = wr.flush().await;
        let _ = wr.shutdown().await;
        let mut sink = [0u8; 1024];
        let _ = timeout(LINGER, async {
            while matches!(self.rd.read(&mut sink).await, Ok(read) if read > 0) {}
        })
        .await;
    }

    /// Gives the socket to the upgrade listener with the bytes read past the request head.
    fn hand_off(self, head: ParsedHead) {
        let Self { rd, wr, buf, info, handler, guard, shared, .. } = self;
        let Some(wr) = wr else { return };
        shared.set_idle(false);
        let upgrade = UpgradeRequest {
            method: head.method,
            url: head.target,
            http_version: format!("1.{}", head.minor),
            headers: head.headers,
            remote_address: info.remote_address,
            encrypted: info.encrypted,
            leftover: buf.freeze(),
            io: Box::new(rd.unsplit(wr)) as Box<dyn RawIo>,
            guard,
        };
        // The listener runs outside any request: a panic in it is answered with a dead socket (`guardUpgrades`).
        if let Err(payload) = std::panic::catch_unwind(AssertUnwindSafe(|| handler.upgrade(upgrade))) {
            logline::emit(&logline::websocket_upgrade_failed(&panic_message(payload.as_ref())));
        }
    }

    /// One request: its answers that need no handler, the handler, the response and the rest of the body.
    async fn serve_request(&mut self, head: ParsedHead, started: Instant) -> Flow {
        let ParsedHead { method, target, minor, headers, framing, keep_alive, .. } = head;
        let meta = ResponseMeta {
            head_request: method == "HEAD",
            keep_alive: keep_alive && !self.lifecycle.is_closing(),
            chunked_by_default: minor == 1 || headers.get("te").is_some_and(|te| has_word(te, "chunked")),
            keep_alive_secs: self.limits.keep_alive_timeout.as_secs(),
        };
        let (pump, body) = Pump::new(framing);
        let epoch = self.shared.begin_response();

        // HTTP/1.1 requires Host.
        if minor == 1 && !headers.contains("host") {
            drop(body);
            return self.answer(pump, started, epoch, meta, |response| {
                let _ = response.write_head(400, &[("Connection", "close")]);
                response.end(None);
            })
            .await;
        }
        if minor == 1 {
            if let Some(expect) = headers.get("expect") {
                if has_word(expect, "100-continue") {
                    if let Some(wr) = self.wr.as_mut() {
                        if wr.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.is_err() || wr.flush().await.is_err() {
                            return Flow::Destroy;
                        }
                    }
                } else {
                    drop(body);
                    return self.answer(pump, started, epoch, meta, |response| {
                        let _ = response.write_head(417, &[]);
                        response.end(None);
                    })
                    .await;
                }
            }
        }
        let request = Request {
            method,
            url: target,
            http_version: format!("1.{minor}"),
            headers,
            remote_address: self.info.remote_address.clone(),
            encrypted: self.info.encrypted,
            body,
            conn: ConnHandle::new(self.shared.clone()),
        };
        let response = ResponseWriter::new(self.shared.clone(), epoch, meta.clone());
        let handler = self.handler.clone();
        let join = tokio::spawn(async move { handler.request(request, response).await });
        self.drive(pump, Some(join), started, epoch, &meta).await
    }

    /// Answers a request without the handler.
    async fn answer(&mut self, pump: Pump, started: Instant, epoch: u64, meta: ResponseMeta, fill: impl FnOnce(&mut ResponseWriter)) -> Flow {
        let mut response = ResponseWriter::new(self.shared.clone(), epoch, meta.clone());
        fill(&mut response);
        drop(response);
        self.drive(pump, None, started, epoch, &meta).await
    }

    /// Runs a response to its end: writes what the handler queues, moves the request body, watches the handler, and ends
    /// when the answer is on the socket and the body has been read to its end.
    async fn drive(&mut self, mut pump: Pump, mut join: Option<JoinHandle<()>>, started: Instant, epoch: u64, meta: &ResponseMeta) -> Flow {
        enum Wake {
            Notified,
            Joined(Result<(), tokio::task::JoinError>),
            Pumped(Step),
            RequestTimeout,
        }
        let Some(wr) = self.wr.take() else { return Flow::Destroy };
        let shared = self.shared.clone();
        let mut writer = Some(tokio::spawn(write_task(wr, shared.clone())));
        let deadline = started + self.limits.request_timeout;
        let mut timed_out = false;
        let mut answered = false;
        let mut last = false;
        loop {
            let notified = shared.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let out = shared.lock();
                if out.destroyed {
                    drop(out);
                    if let Some(task) = writer.take() {
                        task.abort();
                    }
                    return Flow::Destroy;
                }
                if out.flushed && !answered {
                    answered = true;
                    last = out.last;
                }
            }
            if answered {
                if let Some(task) = writer.take() {
                    match task.await {
                        Ok(wr) => self.wr = Some(wr),
                        Err(_) => return Flow::Destroy,
                    }
                }
                if last || self.lifecycle.is_closing() {
                    return Flow::Close;
                }
                if pump.is_done() {
                    return Flow::Next;
                }
            }
            let body_pending = !pump.is_done();
            let wake = tokio::select! {
                () = &mut notified => Wake::Notified,
                joined = async {
                    match join.as_mut() {
                        Some(task) => task.await,
                        None => std::future::pending::<Result<(), tokio::task::JoinError>>().await,
                    }
                } => Wake::Joined(joined),
                step = pump.step(&mut self.rd, &mut self.buf), if body_pending => Wake::Pumped(step),
                () = sleep_until(deadline), if body_pending && !timed_out => Wake::RequestTimeout,
            };
            match wake {
                Wake::Notified | Wake::Pumped(Step::Progress | Step::Done) => {}
                Wake::Joined(Ok(())) => join = None,
                Wake::Joined(Err(error)) => {
                    join = None;
                    if error.is_panic() {
                        logline::emit(&logline::request_failed(&panic_message(error.into_panic().as_ref())));
                        self.answer_failure(epoch, meta);
                    }
                }
                Wake::Pumped(Step::Eof) => {
                    // The peer went away with the body unfinished: the handler's body ends in an error.
                    shared.lock().destroyed = true;
                }
                Wake::Pumped(Step::Bad) => shared.refuse_in_flight(400),
                Wake::RequestTimeout => {
                    timed_out = true;
                    shared.refuse_in_flight(408);
                }
            }
        }
    }

    /// `guardedHttpHandler`'s answer to a handler that threw: 500 when nothing is out yet, else the connection goes.
    fn answer_failure(&self, epoch: u64, meta: &ResponseMeta) {
        let (head_sent, ended) = {
            let out = self.shared.lock();
            (out.head_sent, out.ended)
        };
        if ended {
            return;
        }
        if head_sent {
            self.shared.cut_short();
            return;
        }
        let mut response = ResponseWriter::new(self.shared.clone(), epoch, meta.clone());
        let answered = response.write_head(500, &[("Content-Type", "text/plain; charset=utf-8")]).is_ok();
        response.end(Some(b"Internal error."));
        if !answered {
            self.shared.lock().destroyed = true;
            self.shared.notify();
        }
    }
}

enum Pending {
    Chunk(Bytes),
    Finish,
    Idle,
}

/// Writes what the response queues until it is ended and everything is out; gives the write half back.
async fn write_task<W: AsyncWrite + Unpin>(mut wr: W, shared: Arc<Shared>) -> W {
    loop {
        let notified = shared.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let pending = {
            let mut out = shared.lock();
            if out.destroyed {
                return wr;
            }
            match out.queue.pop_front() {
                Some(chunk) => Pending::Chunk(chunk),
                None if out.ended => Pending::Finish,
                None => Pending::Idle,
            }
        };
        match pending {
            Pending::Chunk(chunk) => {
                let written = wr.write_all(&chunk).await.is_ok();
                {
                    let mut out = shared.lock();
                    out.queued = out.queued.saturating_sub(chunk.len());
                    if !written {
                        out.destroyed = true;
                    }
                }
                shared.notify();
                if !written {
                    return wr;
                }
            }
            Pending::Finish => {
                let flushed = wr.flush().await.is_ok();
                {
                    let mut out = shared.lock();
                    if flushed {
                        out.flushed = true;
                    } else {
                        out.destroyed = true;
                    }
                }
                shared.notify();
                return wr;
            }
            Pending::Idle => {
                let _ = wr.flush().await;
                notified.await;
            }
        }
    }
}

/// The message of a panic payload, as `error?.message || error` would show it.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "unknown error".to_owned()
    }
}
