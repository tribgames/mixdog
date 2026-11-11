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
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::handler::{BodyCollector, HttpReply, WebhookService};
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
    let handler = service_fn(move |request| {
        let service = Arc::clone(&service);
        async move { Ok::<_, Infallible>(respond(request, &service).await) }
    });
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADERS_TIMEOUT)
        .max_buf_size(MAX_HEAD_BYTES)
        .max_headers(MAX_HEADERS_COUNT)
        .serve_connection(TokioIo::new(Lingering(Some(stream))), handler);
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
struct Lingering(Option<TcpStream>);

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
        if let (Some(stream), Ok(runtime)) = (self.0.take(), tokio::runtime::Handle::try_current()) {
            runtime.spawn(linger(stream));
        }
    }
}

async fn linger(mut stream: TcpStream) {
    let _ = stream.shutdown().await;
    let mut sink = [0u8; 8192];
    let _ = mixdog_rt::time::timeout(LINGER, async { while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {} }).await;
}

type Reply = Response<Full<Bytes>>;

/// `close` ends the connection after the reply: the request body was not (fully) consumed or
/// its framing is broken.
fn reply(status: u16, content_type: &str, body: Vec<u8>, close: bool) -> Reply {
    let mut builder = Response::builder().status(status).header("content-type", content_type);
    if close {
        builder = builder.header("connection", "close");
    }
    builder.body(Full::new(Bytes::from(body))).expect("a reply with a valid status and headers")
}

fn json_reply(reply_body: &HttpReply, close: bool) -> Reply {
    reply(reply_body.status, "application/json", serde_json::to_vec(&reply_body.body).unwrap_or_default(), close)
}

async fn respond(request: Request<Incoming>, service: &WebhookService) -> Reply {
    let (parts, body) = request.into_parts();
    let target = parts.uri.path_and_query().map_or_else(|| "/".to_owned(), |p| p.as_str().to_owned());
    match (parts.method.as_str(), target.as_str()) {
        ("GET", "/") => reply(200, "text/plain", b"OK".to_vec(), false),
        ("POST", path) if path.starts_with("/webhook/") => webhook(service, path, request_headers(&parts.headers), body).await,
        _ => reply(404, "text/plain", b"Not Found".to_vec(), false),
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

async fn webhook(service: &WebhookService, target: &str, headers: Headers, body: Incoming) -> Reply {
    // The request is work from its first byte, so the core never stops under it.
    let _busy = service.listening();
    let name = match service.precheck(target).await {
        Ok(name) => name,
        Err(refusal) => return json_reply(&refusal, false),
    };
    match mixdog_rt::time::timeout(REQUEST_TIMEOUT, collect(body)).await {
        Err(_) => reply(408, "text/plain", b"Request Timeout".to_vec(), true),
        Ok(Err(_)) => reply(400, "text/plain", b"Bad Request".to_vec(), true),
        Ok(Ok(Collected::TooLarge(refusal))) => json_reply(&refusal, true),
        Ok(Ok(Collected::Done(bytes))) => json_reply(&service.process(&name, &headers, &bytes).await, false),
    }
}

enum Collected {
    Done(Vec<u8>),
    /// The 413 to send; the connection is closed after it.
    TooLarge(HttpReply),
}

/// Feeds the body frame by frame; a frame that crosses the cap ends the read at once.
async fn collect(mut body: Incoming) -> Result<Collected, hyper::Error> {
    let mut collector = BodyCollector::default();
    while let Some(frame) = body.frame().await {
        if let Some(data) = frame?.data_ref()
            && let Err(refusal) = collector.push(data)
        {
            return Ok(Collected::TooLarge(refusal));
        }
    }
    Ok(Collected::Done(collector.finish().unwrap_or_default()))
}
