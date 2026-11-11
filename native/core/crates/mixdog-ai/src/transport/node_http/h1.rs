//! HTTP/1.1 over `hyper`'s connection-level client, used for what no library gives and what every library does well.
//!
//! The request is written by hand (`super::head`): hyper lowercases every header name, and Node writes the
//! provider's names in their own letter case (`OpenAI-Beta`, `session_id`), which no hyper API can set. Everything
//! after the request is hyper's: the response head is parsed with a bounded size and a bounded header count, the framing
//! (`content-length`, chunked, until close) is strict, and whether the connection can serve another request is
//! hyper's own rule. The two meet in [`ReadOnly`]: hyper believes it sent the request and reads the response from the
//! socket, while the bytes it "writes" are dropped.

use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Empty;
use hyper::body::Body;
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use mixdog_core_api::domain::provider::TransportFault;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::ReadBuf;
use tokio::io::ReadHalf;
use tokio::io::WriteHalf;
use tokio::sync::Notify;

use super::Stream;
use super::decode::Decoder;
use super::pool::Flight;
use super::pool::Pool;
use crate::transport::fault::fault_from_chain;
use crate::transport::fault::fault_from_io;
use crate::transport::link::BodyStream;

/// `maxHeaderSize`: Node's default for the head of a response (`--max-http-header-size`, 16 KiB).
const MAX_HEAD: usize = 16 * 1024;
/// How many header lines hyper reserves room for; more is "message header too large".
const MAX_HEADERS: usize = 128;
/// `bodyTimeout` of the agent (`http-agent.mjs` `llmAgentOptions`): the longest a body may be silent.
pub const BODY_TIMEOUT: Duration = Duration::from_secs(600);

/// Whether hyper's last read of the socket found nothing: it reads only once it has decoded all it holds, so then the
/// message can go on only with bytes still to come from the network.
#[derive(Default)]
struct Starved {
    waiting: AtomicBool,
    /// A read found nothing.
    notify: Notify,
}

/// The read half of the connection, handed to hyper in place of the whole: what hyper writes goes nowhere.
struct ReadOnly(ReadHalf<Stream>, Arc<Starved>);

impl AsyncRead for ReadOnly {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let read = Pin::new(&mut self.0).poll_read(cx, buf);
        let waiting = read.is_pending();
        self.1.waiting.store(waiting, Ordering::SeqCst);
        if waiting {
            self.1.notify.notify_waiters();
        }
        read
    }
}

impl AsyncWrite for ReadOnly {
    fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// One HTTP/1.1 connection: hyper reads it, the request bytes go out through `write`.
pub struct Conn {
    send: http1::SendRequest<Empty<Bytes>>,
    write: WriteHalf<Stream>,
    /// The number of the undici client this connection is the socket of: the order of the pool's list.
    pub born: u64,
    /// The pool's route generation when the connection opened ([super::pool::Pool::generation]).
    pub generation: u64,
    /// The pool and key whose client stays in the pool, socketless, when this connection ends ([`Conn::track`]).
    slot: Option<(Weak<Pool>, String)>,
    /// The exchange on this connection, settled with what comes of the connection.
    pub flight: Option<Flight>,
    starved: Arc<Starved>,
}

/// An ended connection leaves its client in the pool: undici's pool keeps a client whose socket closed and connects it
/// again for the next request it is given (`pool.js` `kGetDispatcher` takes the first client not waiting for `drain`), so
/// that request dials in the old client's place in the pool's order rather than taking a newer idle socket. The client
/// is free once the socket's close has been handled, after the check phase of the turn it ended in.
impl Drop for Conn {
    fn drop(&mut self) {
        let Some((pool, key)) = self.slot.take() else { return };
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let (born, generation, flight) = (self.born, self.generation, self.flight.take());
        let check = mixdog_rt::time::immediate();
        tokio::spawn(async move {
            check.await;
            if let Some(pool) = pool.upgrade() {
                pool.vacate(key, born, generation);
            }
            drop(flight);
        });
    }
}

impl Conn {
    /// From now on the end of this connection leaves its client in `pool` under `key` ([`Pool::vacate`]).
    pub fn track(&mut self, pool: &Arc<Pool>, key: &str) {
        self.slot = Some((Arc::downgrade(pool), key.to_owned()));
    }

    /// The connection ends with its client taken for another socket: the client's number.
    pub fn into_slot(mut self) -> u64 {
        self.slot = None;
        self.born
    }

    pub async fn open(io: Stream, born: u64, generation: u64) -> Result<Self, hyper::Error> {
        let (read, write) = tokio::io::split(io);
        let starved = Arc::new(Starved::default());
        let (send, connection) = http1::Builder::new()
            .max_buf_size(MAX_HEAD)
            .max_headers(MAX_HEADERS)
            .handshake::<_, Empty<Bytes>>(TokioIo::new(ReadOnly(read, starved.clone())))
            .await?;
        tokio::spawn(async move {
            // An error here reaches the request in flight through hyper (its send_request future fails with it);
            // one on an idle connection has no request to reach and is logged, as the reqwest client's driver was.
            if let Err(error) = connection.await {
                tracing::debug!(%error, "http/1.1 connection ended with an error");
            }
        });
        Ok(Self { send, write, born, generation, slot: None, flight: None, starved })
    }

    /// The connection has ended (the peer closed it, or hyper found it unusable).
    pub fn is_closed(&self) -> bool {
        self.send.is_closed()
    }

    /// Waits until hyper can take a request: `Err` is a connection that is gone.
    pub async fn ready(&mut self) -> Result<(), hyper::Error> {
        self.send.ready().await
    }

    /// Writes the request and reads the answer, both at once: a server that answers before it has read the whole body
    /// (a 401, a 413) is heard, as it is by undici, which parses the response while it is still writing.
    ///
    /// hyper is told what it needs to frame the answer to a request it did not write: the method (a `HEAD` has no
    /// body) and `connection: close`. It is never told `Expect` (refused before the socket, `check_headers`) or a
    /// `CONNECT` (refused in `NodeClient::send`), the two requests whose answers hyper frames differently.
    pub async fn exchange(&mut self, head: &[u8], body: &[u8], method: &str, close: bool) -> Exchange {
        let Self { send, write, .. } = self;
        let mut request = hyper::Request::builder().method(method).uri("/");
        if close {
            request = request.header("connection", "close");
        }
        let request = request.body(Empty::<Bytes>::new()).expect("a request hyper reads no more of than its method");
        let response = send.send_request(request);
        tokio::pin!(response);
        let written = async {
            write.write_all(head).await?;
            write.write_all(body).await?;
            write.flush().await
        };
        tokio::pin!(written);
        let answer = |result: Result<hyper::Response<Incoming>, hyper::Error>, written: bool| match result {
            Ok(response) => Exchange::Answered { response, written },
            Err(error) => Exchange::Unanswered(error),
        };
        tokio::select! {
            biased;
            outcome = &mut written => match outcome {
                Ok(()) => answer((&mut response).await, true),
                // An answer already in hand outranks the failed write: undici has parsed what arrived before the
                // socket's error is seen. A read error beside it does not: the write's is the request's error.
                Err(error) => match mixdog_rt::time::timeout(Duration::ZERO, &mut response).await {
                    Ok(result @ Ok(_)) => answer(result, false),
                    _ => Exchange::NotWritten(error),
                },
            },
            result = &mut response => answer(result, false),
        }
    }
}

/// What came of writing a request and reading its answer.
pub enum Exchange {
    /// The answer's head. `written` is false when it came before the whole request was out: the connection cannot
    /// serve another request.
    Answered { response: hyper::Response<Incoming>, written: bool },
    /// The write failed and nothing answered.
    NotWritten(io::Error),
    /// The request was out and the answer failed or never came whole.
    Unanswered(hyper::Error),
}
pub struct Reuse {
    pub pool: Arc<Pool>,
    pub key: String,
    pub ttl: Duration,
}

/// The most of a body read off the socket and not yet taken by the caller: Node's bundled fetch pushes the body into a
/// Readable whose `push` returns false once it holds the stream's high-water mark (64 KiB on Node 22), and undici then
/// pauses its parser (`client-h1.js` `onBody` -> `ERROR.PAUSED`), so the socket is not read until the caller takes some.
const BODY_BUFFER: usize = 64 * 1024;

/// The most read off the socket into memory while undici's parser is paused: a Node socket keeps reading until its
/// readable buffer holds its high-water mark (`net.Socket` `readableHighWaterMark`, 16 KiB on Node v22.20.0).
const SOCKET_BUFFER: usize = 16 * 1024;

/// What the socket gave and the caller has not taken yet.
#[derive(Default)]
struct Received {
    chunks: VecDeque<Bytes>,
    buffered: usize,
    /// How the message ended: `Ok` parsed to its end, `Err` the fault that ended it.
    end: Option<Result<(), TransportFault>>,
    /// The caller let the body go.
    dropped: bool,
    /// The connection stays out of the pool until the body is dropped ([`BodyStream::hold_connection`]).
    held: bool,
}

struct Shared {
    received: Mutex<Received>,
    /// A chunk or the end has arrived.
    arrived: Notify,
    /// The caller took a chunk.
    room: Notify,
    /// The caller let the body go.
    gone: Notify,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, Received> {
        self.received.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A response body read off its socket as it arrives, as undici reads it: the connection's life follows the network's
/// end of the message, not the caller's reading. The task that reads it ([`read_message`]) gives the connection back to
/// the pool once the message has been read to its end (undici `onMessageComplete`, `client-h1.js:785`), whether or not
/// the caller has taken the body; it pauses while [`BODY_BUFFER`] is held untaken; and a body dropped before its end
/// ends the connection with it (fetch's `cancel`: `onAborted` -> `connection.destroy()`) unless the end is already in
/// what the socket has read ([`ends_without_the_network`]).
pub struct H1Body {
    shared: Arc<Shared>,
    decoder: Option<Decoder>,
    /// The caller has had the end (or the fault) of the message.
    done: bool,
}

impl H1Body {
    /// Starts reading the message; `reuse` is where its connection goes once the message is whole (`None`: the exchange
    /// ends the connection, undici's `!shouldKeepAlive`).
    pub fn new(incoming: Incoming, conn: Conn, decoder: Option<Decoder>, reuse: Option<Reuse>) -> Self {
        // A message without a body (a `HEAD`, a 204, `Content-Length: 0`) ended with its head: dropping the body at once
        // leaves the connection to the reader.
        let received = Received { end: incoming.is_end_stream().then_some(Ok(())), ..Received::default() };
        let shared = Arc::new(Shared {
            received: Mutex::new(received),
            arrived: Notify::new(),
            room: Notify::new(),
            gone: Notify::new(),
        });
        tokio::spawn(read_message(incoming, conn, reuse, shared.clone()));
        Self { shared, decoder, done: false }
    }

    /// The failure ends the body.
    fn fail(&mut self, fault: TransportFault) -> Option<Result<Bytes, TransportFault>> {
        self.done = true;
        self.decoder = None;
        Some(Err(fault))
    }

    /// The next raw chunk; `None` at the message's end, or the fault that ended it.
    async fn take(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            let arrived = self.shared.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            {
                let mut received = self.shared.lock();
                if let Some(chunk) = received.chunks.pop_front() {
                    received.buffered -= chunk.len();
                    drop(received);
                    self.shared.room.notify_one();
                    return Some(Ok(chunk));
                }
                match &received.end {
                    Some(Ok(())) => return None,
                    Some(Err(fault)) => return Some(Err(fault.clone())),
                    None => {}
                }
            }
            arrived.await;
        }
    }
}

/// Reads the message off the socket into `shared` and, at its end, lets the connection go: back to the pool one check
/// phase later when `reuse` says it serves another request (`client-h1.js:846` `setImmediate(client[kResume])`: until
/// then the client has not emitted `drain` and the pool passes it over), closed otherwise.
async fn read_message(mut incoming: Incoming, conn: Conn, reuse: Option<Reuse>, shared: Arc<Shared>) {
    // What the socket has read that the paused parser has not handed to the body yet, and the end it read: Node's socket
    // keeps reading into its own buffer while undici's parser is paused, and the parser reaches the message's end only
    // once it resumes and has handed on everything before it.
    let mut socket: VecDeque<Bytes> = VecDeque::new();
    let mut socket_bytes = 0;
    let mut socket_end = false;
    let starved = conn.starved.clone();
    let end = loop {
        let room = shared.room.notified();
        tokio::pin!(room);
        room.as_mut().enable();
        let gone = shared.gone.notified();
        tokio::pin!(gone);
        gone.as_mut().enable();
        let (dropped, paused) = {
            let received = shared.lock();
            (received.dropped, received.buffered >= BODY_BUFFER)
        };
        if dropped {
            // A paused parser parses nothing more (`client-h1.js` `pause`), so a cancel then finds the message
            // unfinished whatever the socket holds.
            let parsed = !paused && socket.is_empty();
            if parsed && (socket_end || ends_without_the_network(&mut incoming, &starved).await) {
                break Ok(());
            }
            break Err(TransportFault::Io { os_code: None });
        }
        let (paused, moved, ended) = {
            let mut received = shared.lock();
            let mut moved = false;
            while received.buffered < BODY_BUFFER {
                let Some(chunk) = socket.pop_front() else { break };
                socket_bytes -= chunk.len();
                received.buffered += chunk.len();
                received.chunks.push_back(chunk);
                moved = true;
            }
            let paused = received.buffered >= BODY_BUFFER;
            // The end is known with the last chunk, under the same lock: a caller that takes that chunk and lets the
            // body go finds the message ended (undici completes the message in the same `execute` that pushed it).
            let ended = !paused && socket_end && socket.is_empty();
            if ended {
                received.end = Some(Ok(()));
            }
            (paused, moved, ended)
        };
        if moved || ended {
            shared.arrived.notify_one();
        }
        if ended {
            break Ok(());
        }
        if socket_end || socket_bytes >= SOCKET_BUFFER {
            tokio::select! {
                () = &mut room => {}
                () = &mut gone => {}
            }
            continue;
        }
        let frame = if paused {
            tokio::select! {
                () = &mut room => continue,
                () = &mut gone => continue,
                frame = incoming.frame() => Ok(frame),
            }
        } else {
            // undici's `bodyTimeout` runs while its parser is not paused (`onParserTimeout`).
            tokio::select! {
                () = &mut gone => continue,
                frame = mixdog_rt::time::timeout(BODY_TIMEOUT, incoming.frame()) => frame,
            }
        };
        match frame {
            Err(_) => break network_end(Err(TransportFault::Io { os_code: None })),
            Ok(None) => socket_end = network_end(true),
            // A socket error destroys the request at once, whatever the parser holds (`client-h1.js` `onHttpSocketError`).
            Ok(Some(Err(e))) => break network_end(Err(fault_from_chain(&e, false))),
            Ok(Some(Ok(frame))) => {
                let Ok(raw) = frame.into_data() else { continue };
                if raw.is_empty() {
                    continue;
                }
                socket_bytes += raw.len();
                socket.push_back(raw);
                // The frame that ends the message is parsed with its last bytes (hyper's chunked or length decoder).
                if incoming.is_end_stream() {
                    socket_end = network_end(true);
                }
            }
        }
    };
    let whole = end.is_ok();
    if !whole {
        shared.lock().end = Some(end);
        shared.arrived.notify_one();
    }
    match reuse {
        Some(Reuse { pool, key, ttl }) if whole => {
            loop {
                let gone = shared.gone.notified();
                tokio::pin!(gone);
                gone.as_mut().enable();
                let waiting = {
                    let received = shared.lock();
                    received.held && !received.dropped
                };
                if !waiting {
                    break;
                }
                gone.await;
            }
            mixdog_rt::time::immediate().await;
            pool.put_h1(key, conn, ttl);
        }
        _ => drop(conn),
    }
}

/// The network's end of a message (its last byte read off the socket, or the fault that ended it), whether or not the
/// caller has read it: real I/O a replay's clock does not wait for, so a replay waits for this line before advancing past
/// it. Nothing without `mixdog-rt`'s `virtual-clock` feature.
fn network_end<T>(end: T) -> T {
    mixdog_rt::replay_event("h1 message read off the socket");
    end
}

/// After the caller let the body go: whether the message ends from what the socket has already read. undici parses
/// each socket read whole (`client-h1.js` `execute`), so a caller that cancels on a chunk finds the message complete if
/// its end came in the same read, and destroys the socket otherwise (`onAborted`). hyper decodes the bytes it holds only
/// as the body is taken, so they are taken here until the message ends, or hyper has to read the socket again and finds
/// nothing there ([`Starved`]): the end would need the network.
async fn ends_without_the_network(incoming: &mut Incoming, starved: &Starved) -> bool {
    loop {
        if incoming.is_end_stream() {
            return true;
        }
        let hungry = starved.notify.notified();
        tokio::pin!(hungry);
        hungry.as_mut().enable();
        let starving = async {
            if !starved.waiting.load(Ordering::SeqCst) {
                hungry.await;
            }
        };
        tokio::select! {
            biased;
            frame = incoming.frame() => match frame {
                None => return true,
                Some(Err(_)) => return false,
                Some(Ok(_)) => {}
            },
            () = starving => return false,
        }
    }
}

impl Drop for H1Body {
    /// A body let go before its message ended leaves the reader to finish what the socket already holds; one whose
    /// message has ended leaves the reader to give the connection back.
    fn drop(&mut self) {
        self.shared.lock().dropped = true;
        self.shared.gone.notify_one();
    }
}

#[async_trait]
impl BodyStream for H1Body {
    fn hold_connection(&mut self) {
        self.shared.lock().held = true;
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            // What the decoder can hand on from what it holds comes first, one step at a time; the next raw chunk is
            // taken only when it has nothing left.
            if let Some(decoder) = self.decoder.as_mut() {
                match decoder.step() {
                    Err(e) => return self.fail(fault_from_io(&e, false)),
                    Ok(Some(step)) => return Some(Ok(Bytes::from(step))),
                    Ok(None) if self.done => {
                        self.decoder = None;
                        return None;
                    }
                    Ok(None) => {}
                }
            }
            if self.done {
                return None;
            }
            match self.take().await {
                None => {
                    self.done = true;
                    match self.decoder.as_mut() {
                        // The body is over: the steps left, and how the stream finishes, are taken at the top of the loop.
                        Some(decoder) => decoder.end(),
                        None => return None,
                    }
                }
                Some(Err(fault)) => return self.fail(fault),
                Some(Ok(raw)) => match self.decoder.as_mut() {
                    Some(decoder) => decoder.feed(&raw),
                    None => return Some(Ok(raw)),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::*;

    // H4: a server that answers while the body is still being written is heard, and the half-written connection is
    // reported as such (`written: false`), which keeps it out of the pool. The pipe holds 64 bytes, so the write of the
    // 1 MiB body cannot finish before the answer.
    #[tokio::test]
    async fn an_answer_before_the_whole_body_is_written_is_the_answer_and_not_a_complete_exchange() {
        let (near, mut far) = tokio::io::duplex(64);
        let mut conn = Conn::open(Box::new(near), 0, 0).await.unwrap();
        let server = tokio::spawn(async move {
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                far.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            far.write_all(b"HTTP/1.1 413 Payload Too Large\r\ncontent-length: 0\r\n\r\n").await.unwrap();
            far // kept open, unread
        });
        let body = vec![b'x'; 1 << 20];
        let outcome = mixdog_rt::time::timeout(Duration::from_secs(20), conn.exchange(b"POST / HTTP/1.1\r\ncontent-length: 1048576\r\n\r\n", &body, "POST", false))
            .await
            .expect("the answer arrives while the write is pending");
        match outcome {
            Exchange::Answered { response, written } => {
                assert_eq!(response.status(), 413);
                assert!(!written, "the request was not whole when the answer came");
            }
            _ => panic!("the answer is the outcome"),
        }
        drop(server);
    }

    // H4: hyper cannot write the head Node writes: it lowercases every header name (the provider's `OpenAI-Beta`,
    // `session_id` keep their case in Node's recording) and writes no `connection` line unless it is given one. This
    // pins what the difference is, so that the hand-written head stays only as long as hyper cannot do it.
    #[tokio::test]
    async fn hyper_writes_the_providers_header_names_in_lower_case_and_the_head_here_does_not() {
        let (near, mut far) = tokio::io::duplex(1 << 16);
        let (mut send, connection) = http1::handshake::<_, http_body_util::Full<Bytes>>(TokioIo::new(near)).await.unwrap();
        tokio::spawn(connection);
        let request = hyper::Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header("host", "chatgpt.com")
            .header("OpenAI-Beta", "responses=v1")
            .header("session_id", "s")
            .body(http_body_util::Full::new(Bytes::from_static(b"{}")))
            .unwrap();
        tokio::spawn(send.send_request(request));
        let mut written = vec![0u8; 512];
        let n = mixdog_rt::time::timeout(Duration::from_secs(20), far.read(&mut written)).await.expect("hyper's request within 20 s").unwrap();
        let hyper_head = String::from_utf8(written[..n].to_vec()).unwrap();
        let wire = mixdog_core_api::domain::provider::WireRequest {
            transport: mixdog_core_api::domain::keepalive::TransportKind::Http1,
            method: "POST".into(),
            url: "https://chatgpt.com/v1/responses".into(),
            headers: vec![("OpenAI-Beta".into(), "responses=v1".into()), ("session_id".into(), "s".into())],
            body: b"{}".to_vec(),
        };
        let (ours, _) = super::super::head(&wire, &url::Url::parse(&wire.url).unwrap(), super::super::Writer::Raw);
        let ours = String::from_utf8(ours).unwrap();
        assert!(hyper_head.contains("openai-beta: responses=v1\r\n") && !hyper_head.contains("OpenAI-Beta"), "{hyper_head:?}");
        assert!(ours.contains("OpenAI-Beta: responses=v1\r\n") && ours.contains("session_id: s\r\n"), "{ours:?}");
        assert!(ours.contains("connection: keep-alive\r\n") && !hyper_head.contains("connection:"), "{hyper_head:?}");
    }
}