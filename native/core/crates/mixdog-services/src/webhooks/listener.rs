//! The webhook HTTP listener (`webhook/listener-lifecycle.mjs`, `webhook.mjs` routing): binds
//! loopback on the configured port or the next seven, answers `GET /` and `POST /webhook/<name>`,
//! and moves bytes between the socket and [`WebhookService`]. HTTP/1.1 framing is hyper's, with
//! Node's server limits: 16 KiB of headers (431 beyond), 60 s to receive them, five minutes for
//! the body, keep-alive and pipelining. The endpoint gate runs before any body byte is read; the
//! body is fed frame by frame through [`BodyCollector`], so an over-cap sender gets its 413 at
//! the frame that crosses the cap and the connection is closed.
//!
//! The relay tunnel that forwards a public URL to this port is not part of the listener.

use std::convert::Infallible;
use std::io::{self, ErrorKind};
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::handler::{BodyCollector, HttpReply, Rejection, WebhookService};
use super::signature::Headers;
use crate::channels::running::WorkGuard;

/// The port walk after the configured one (`maxPort = basePort + 7`).
const PORT_SPAN: u16 = 7;
/// Node's default `maxHeaderSize`.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Node's default `server.maxHeadersCount` (hyper's own default is 100).
const MAX_HEADERS_COUNT: usize = 2000;
/// Node's default `headersTimeout`.
pub(crate) const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
/// Node's default `requestTimeout`: the body must arrive within five minutes.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a connection may keep finishing its request after the listener is stopped. Codex bounds
/// its connection workers' shutdown at 5 s (`app-server-transport/.../remote_control/websocket.rs:86`,
/// `app-server/src/in_process.rs:106`); Node's `server.close()` waits without limit.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

pub struct WebhookListener {
    port: u16,
    stop: CancellationToken,
    accept: JoinHandle<()>,
    _listening: WorkGuard,
}

impl WebhookListener {
    /// Binds `127.0.0.1:base_port`, walking up to `base_port + 7` while a port is in use.
    /// A bound listener holds the service's "listening" work for as long as it lives.
    pub async fn start(service: Arc<WebhookService>, base_port: u16) -> Result<Self, String> {
        let max_port = base_port.saturating_add(PORT_SPAN);
        let mut port = base_port;
        let listener = loop {
            match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
                Ok(listener) => break listener,
                Err(e) if e.kind() == ErrorKind::AddrInUse && port < max_port => {
                    mixdog_rt::node_stderr!("mixdog webhook: port {port} already in use, trying {}", port + 1);
                    port += 1;
                }
                Err(e) if e.kind() == ErrorKind::AddrInUse => {
                    return Err(format!("all ports {base_port}-{max_port} in use — webhook server disabled"));
                }
                Err(e) => return Err(format!("listen error: {e}")),
            }
        };
        let port = listener.local_addr().map_err(|e| format!("listen error: {e}"))?.port();
        mixdog_rt::node_stderr!("mixdog webhook: listening on 127.0.0.1:{port}");
        let stop = CancellationToken::new();
        let listening = service.listening();
        let accept = tokio::spawn(accept_loop(listener, service, stop.clone()));
        Ok(Self { port, stop, accept, _listening: listening })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stops accepting and releases the port; a request already in flight finishes, then its
    /// connection closes.
    pub async fn stop(self) {
        self.stop.cancel();
        let _ = self.accept.await;
        mixdog_rt::node_stderr!("mixdog webhook: stopped");
    }
}

async fn accept_loop(listener: TcpListener, service: Arc<WebhookService>, stop: CancellationToken) {
    loop {
        tokio::select! {
            () = stop.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(serve(stream, Arc::clone(&service), stop.clone()));
                }
                Err(e) => tracing::warn!("webhook: accept failed: {e}"),
            },
        }
    }
}

async fn serve(stream: TcpStream, service: Arc<WebhookService>, stop: CancellationToken) {
    let farewell = Arc::new(Mutex::new(None));
    let handler = {
        let farewell = Arc::clone(&farewell);
        service_fn(move |request| {
            let (service, farewell) = (Arc::clone(&service), Arc::clone(&farewell));
            async move {
                respond(request, &service).await.map_err(|Farewell(bytes)| {
                    *farewell.lock().expect("the farewell slot is never held across a panic") = Some(bytes);
                    Hung
                })
            }
        })
    };
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADERS_TIMEOUT)
        .max_buf_size(MAX_HEAD_BYTES)
        .max_headers(MAX_HEADERS_COUNT)
        .serve_connection(TokioIo::new(Lingering(Some(stream), farewell)), handler);
    tokio::pin!(connection);
    tokio::select! {
        _ = connection.as_mut() => return,
        () = stop.cancelled() => connection.as_mut().graceful_shutdown(),
    }
    let _ = mixdog_rt::time::timeout(SHUTDOWN_GRACE, connection.as_mut()).await;
}

/// How long a closed connection keeps reading and discarding what the peer still sends.
const LINGER: Duration = Duration::from_secs(5);

/// A socket that is half-closed and drained when hyper lets go of it. Closing a socket with
/// unread bytes resets the connection, and a reset throws away the reply the peer has not read
/// yet — a 413 or 400 sent to a sender that is still mid-body would never arrive. The shutdown
/// sends the reply and a FIN first; the read-out lets the sender finish or notice (RFC 9112 §9.6).
struct Lingering(Option<TcpStream>, Arc<Mutex<Option<Vec<u8>>>>);

impl Lingering {
    fn socket(&mut self) -> Pin<&mut TcpStream> {
        Pin::new(self.0.as_mut().expect("the socket is present until the connection is dropped"))
    }
}

impl AsyncRead for Lingering {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        self.socket().poll_read(cx, buf)
    }
}

impl AsyncWrite for Lingering {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        self.socket().poll_write(cx, buf)
    }

    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        self.socket().poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        true
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.socket().poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.socket().poll_shutdown(cx)
    }
}

impl Drop for Lingering {
    fn drop(&mut self) {
        let farewell = self.1.lock().expect("the farewell slot is never held across a panic").take();
        if let (Some(stream), Ok(runtime)) = (self.0.take(), tokio::runtime::Handle::try_current()) {
            runtime.spawn(linger(stream, farewell));
        }
    }
}

async fn linger(mut stream: TcpStream, farewell: Option<Vec<u8>>) {
    if let Some(bytes) = farewell {
        let _ = stream.write_all(&bytes).await;
    }
    let _ = stream.shutdown().await;
    let mut sink = [0u8; 8192];
    let _ = mixdog_rt::time::timeout(LINGER, async { while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {} }).await;
}

/// A reply body of no declared length, which hyper frames as `Transfer-Encoding: chunked`: Node's
/// handler writes its head with `writeHead` before `end(body)`, so it never sends a `Content-Length`.
struct Chunked(Option<Bytes>);

impl Body for Chunked {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        Poll::Ready(self.0.take().map(|bytes| Ok(Frame::data(bytes))))
    }
}

type Reply = Response<Chunked>;

/// What the handler gives instead of a reply when the connection ends with its answer: the
/// bytes go out as they are, then the socket closes (Node answers and then `req.destroy()`s, or
/// its parser answers a bare 400 and ends the connection), and nothing pipelined behind it is served.
struct Farewell(Vec<u8>);

/// The service error that stops hyper once the farewell is stored; hyper writes nothing for it.
#[derive(Debug)]
struct Hung;

impl std::fmt::Display for Hung {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the connection ends with its farewell")
    }
}

impl std::error::Error for Hung {}

/// Node's parser-level answer to a request whose body framing is broken or cut short.
const BARE_BAD_REQUEST: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";

/// Node's `keepAliveTimeout`, announced on every reply that keeps the connection.
const KEEP_ALIVE_HEADERS: &str = "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n";

/// Whether the peer lets the connection stay open: HTTP/1.1 without `Connection: close`.
fn keeps_alive(parts: &hyper::http::request::Parts) -> bool {
    parts.version == hyper::Version::HTTP_11
        && !parts
            .headers
            .get_all(hyper::header::CONNECTION)
            .iter()
            .any(|v| v.to_str().is_ok_and(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case("close"))))
}

/// A reply hyper writes and the connection survives it (`alive`), or carries `Connection: close`.
fn reply(status: u16, content_type: &str, body: Vec<u8>, alive: bool) -> Reply {
    let mut builder = Response::builder().status(status).header("content-type", content_type);
    builder = if alive { builder.header("connection", "keep-alive").header("keep-alive", "timeout=5") } else { builder.header("connection", "close") };
    builder.body(Chunked(Some(Bytes::from(body)))).expect("a reply with a valid status and headers")
}

/// A reply written whole by the connection itself, which ends after it. Its head says what Node's
/// says for the request (`Connection: keep-alive` while the peer allows it), though the socket closes.
fn farewell(status: u16, content_type: &str, body: &[u8], alive: bool) -> Farewell {
    let reason = hyper::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("");
    let connection = if alive { KEEP_ALIVE_HEADERS } else { "Connection: close\r\n" };
    let mut bytes = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nDate: {}\r\n{connection}Transfer-Encoding: chunked\r\n\r\n{:x}\r\n",
        mixdog_rt::utc_now!().format("%a, %d %b %Y %H:%M:%S GMT"),
        body.len(),
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes.extend_from_slice(b"\r\n0\r\n\r\n");
    Farewell(bytes)
}

fn json_body(reply_body: &HttpReply) -> Vec<u8> {
    serde_json::to_vec(&reply_body.body).unwrap_or_default()
}

fn json_reply(reply_body: &HttpReply, alive: bool) -> Reply {
    reply(reply_body.status, HttpReply::CONTENT_TYPE, json_body(reply_body), alive)
}

fn json_farewell(reply_body: &HttpReply, alive: bool) -> Farewell {
    farewell(reply_body.status, HttpReply::CONTENT_TYPE, &json_body(reply_body), alive)
}
async fn respond(request: Request<Incoming>, service: &WebhookService) -> Result<Reply, Farewell> {
    let (parts, body) = request.into_parts();
    let alive = keeps_alive(&parts);
    let target = parts.uri.path_and_query().map_or_else(|| "/".to_owned(), |p| p.as_str().to_owned());
    match (parts.method.as_str(), target.as_str()) {
        ("GET", "/") => Ok(reply(200, "text/plain", b"OK".to_vec(), alive)),
        ("POST", path) if path.starts_with("/webhook/") => webhook(service, path, request_headers(&parts.headers), body, alive).await,
        _ => Ok(reply(404, "text/plain", b"Not Found".to_vec(), alive)),
    }
}

/// Repeated headers join with ", " as in Node's `req.headers`.
fn request_headers(map: &hyper::HeaderMap) -> Headers {
    let mut headers = Headers::new();
    for (name, value) in map {
        let value = String::from_utf8_lossy(value.as_bytes()).trim_matches([' ', '\t']).to_owned();
        headers
            .entry(name.as_str().to_owned())
            .and_modify(|v| {
                v.push_str(", ");
                v.push_str(&value);
            })
            .or_insert(value);
    }
    headers
}

async fn webhook(service: &WebhookService, target: &str, headers: Headers, body: Incoming, alive: bool) -> Result<Reply, Farewell> {
    // The request is work from its first byte, so the core never stops under it.
    let _busy = service.listening();
    let name = match service.precheck(target).await {
        Ok(name) => name,
        Err(Rejection(refusal)) => return Err(json_farewell(&refusal, alive)),
    };
    match mixdog_rt::time::timeout(REQUEST_TIMEOUT, collect(body)).await {
        Err(_) => Ok(reply(408, "text/plain", b"Request Timeout".to_vec(), false)),
        // Node's collection stays pending and its server layer answers a bare 400 (no body, no
        // content type) and closes: a truncated half-closed body, broken chunk framing.
        Ok(Err(_)) => Err(Farewell(BARE_BAD_REQUEST.to_vec())),
        Ok(Ok(Collected::TooLarge(Rejection(refusal)))) => Err(json_farewell(&refusal, alive)),
        Ok(Ok(Collected::Done(bytes))) => Ok(json_reply(&service.process(&name, &headers, &bytes).await, alive)),
    }
}

enum Collected {
    Done(Vec<u8>),
    /// The 413 to send; the connection is closed after it.
    TooLarge(Rejection),
}

/// Feeds the body frame by frame; a frame that crosses the cap ends the read at once.
async fn collect(mut body: Incoming) -> Result<Collected, hyper::Error> {
    let mut collector = BodyCollector::default();
    while let Some(frame) = body.frame().await {
        let frame = match frame {
            Ok(frame) => frame,
            Err(err) => {
                // Nothing is processed or sent for the part of the body that arrived.
                collector.cut_short();
                return Err(err);
            }
        };
        if let Some(data) = frame.data_ref()
            && let Err(refusal) = collector.push(data)
        {
            return Ok(Collected::TooLarge(refusal));
        }
    }
    Ok(Collected::Done(collector.finish().unwrap_or_default()))
}
