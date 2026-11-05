//! The webhook HTTP listener (`webhook/listener-lifecycle.mjs`, `webhook.mjs` routing): binds
//! loopback on the configured port or the next seven, answers `GET /` and `POST /webhook/<name>`,
//! and moves bytes between the socket and [`WebhookService`]. The endpoint gate runs before any
//! body byte is read; the body is streamed through [`BodyCollector`], so an over-cap sender gets
//! its 413 at the chunk that crosses the cap and the connection is dropped.
//!
//! The relay tunnel that forwards a public URL to this port is not part of the listener.

use std::io::ErrorKind;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::handler::{BodyCollector, HttpReply, WebhookService};
use super::signature::Headers;
use crate::channels::running::WorkGuard;

/// The port walk after the configured one (`maxPort = basePort + 7`).
const PORT_SPAN: u16 = 7;
/// Node's default header cap is 16 KiB.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Node's default `requestTimeout`: the whole request must arrive within five minutes.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

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
                    tracing::info!("webhook: port {port} already in use, trying {}", port + 1);
                    port += 1;
                }
                Err(e) if e.kind() == ErrorKind::AddrInUse => {
                    return Err(format!("all ports {base_port}-{max_port} in use — webhook server disabled"));
                }
                Err(e) => return Err(format!("listen error: {e}")),
            }
        };
        let port = listener.local_addr().map_err(|e| format!("listen error: {e}"))?.port();
        tracing::info!("webhook: listening on 127.0.0.1:{port}");
        let stop = CancellationToken::new();
        let listening = service.listening();
        let accept = tokio::spawn(accept_loop(listener, service, stop.clone()));
        Ok(Self { port, stop, accept, _listening: listening })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stops accepting and releases the port; requests already in flight finish.
    pub async fn stop(self) {
        self.stop.cancel();
        let _ = self.accept.await;
        tracing::info!("webhook: stopped");
    }
}

async fn accept_loop(listener: TcpListener, service: Arc<WebhookService>, stop: CancellationToken) {
    loop {
        tokio::select! {
            () = stop.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let service = Arc::clone(&service);
                    tokio::spawn(async move { serve(stream, &service).await });
                }
                Err(e) => tracing::warn!("webhook: accept failed: {e}"),
            },
        }
    }
}

struct Request {
    method: String,
    target: String,
    headers: Headers,
}

async fn serve(mut stream: TcpStream, service: &WebhookService) {
    let _ = tokio::time::timeout(REQUEST_TIMEOUT, handle(&mut stream, service)).await;
    let _ = stream.shutdown().await;
}

async fn handle(stream: &mut TcpStream, service: &WebhookService) -> Option<()> {
    let (request, leftover) = read_head(stream).await?;
    let Request { method, target, headers } = request;
    match (method.as_str(), target.as_str()) {
        ("GET", "/") => write_response(stream, 200, "text/plain", b"OK").await,
        ("POST", path) if path.starts_with("/webhook/") => webhook(stream, service, path, headers, leftover).await,
        _ => write_response(stream, 404, "text/plain", b"Not Found").await,
    }
}

async fn webhook(stream: &mut TcpStream, service: &WebhookService, target: &str, headers: Headers, leftover: Vec<u8>) -> Option<()> {
    // The request is work from its first byte, so the core never stops under it.
    let _busy = service.listening();
    let name = match service.precheck(target).await {
        Ok(name) => name,
        Err(reply) => return write_reply(stream, &reply).await,
    };
    let body = match read_body(stream, &headers, leftover).await? {
        Body::Done(bytes) => bytes,
        Body::TooLarge(reply) => return write_reply(stream, &reply).await,
    };
    let reply = service.process(&name, &headers, &body).await;
    write_reply(stream, &reply).await
}

/// The request line and headers, and whatever body bytes arrived with them.
async fn read_head(stream: &mut TcpStream) -> Option<(Request, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > MAX_HEAD_BYTES {
            return None;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = std::str::from_utf8(&buf[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let mut headers = Headers::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim_matches([' ', '\t']);
        // Repeated headers join with ", " as in Node's `req.headers`.
        headers.entry(name.to_ascii_lowercase()).and_modify(|v| {
            v.push_str(", ");
            v.push_str(value);
        }).or_insert_with(|| value.to_string());
    }
    Some((Request { method, target, headers }, buf[end + 4..].to_vec()))
}

enum Body {
    Done(Vec<u8>),
    /// The 413 to send; the connection is dropped after it.
    TooLarge(HttpReply),
}

/// Streams the body through the collector: `Content-Length` or chunked framing. None when the
/// peer vanished or sent a broken frame.
async fn read_body(stream: &mut TcpStream, headers: &Headers, leftover: Vec<u8>) -> Option<Body> {
    let mut collector = BodyCollector::default();
    let chunked = headers.get("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        let mut pending = leftover;
        loop {
            let line_end = loop {
                if let Some(at) = pending.windows(2).position(|w| w == b"\r\n") {
                    break at;
                }
                fill(stream, &mut pending).await?;
            };
            let size_text = std::str::from_utf8(&pending[..line_end]).ok()?.split(';').next()?.trim();
            let size = usize::from_str_radix(size_text, 16).ok()?;
            pending.drain(..line_end + 2);
            if size == 0 {
                break;
            }
            while pending.len() < size + 2 {
                fill(stream, &mut pending).await?;
            }
            if let Err(reply) = collector.push(&pending[..size]) {
                return Some(Body::TooLarge(reply));
            }
            pending.drain(..size + 2);
        }
    } else {
        let mut remaining: usize = headers.get("content-length").map_or(Some(0), |v| v.parse().ok())?;
        let mut feed = |bytes: &[u8], remaining: &mut usize| {
            let take = bytes.len().min(*remaining);
            *remaining -= take;
            collector.push(&bytes[..take])
        };
        if let Err(reply) = feed(&leftover, &mut remaining) {
            return Some(Body::TooLarge(reply));
        }
        let mut chunk = [0u8; 16 * 1024];
        while remaining > 0 {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            if let Err(reply) = feed(&chunk[..n], &mut remaining) {
                return Some(Body::TooLarge(reply));
            }
        }
    }
    collector.finish().map(Body::Done)
}

async fn fill(stream: &mut TcpStream, pending: &mut Vec<u8>) -> Option<()> {
    let mut chunk = [0u8; 16 * 1024];
    let n = stream.read(&mut chunk).await.ok()?;
    if n == 0 {
        return None;
    }
    pending.extend_from_slice(&chunk[..n]);
    Some(())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

async fn write_reply(stream: &mut TcpStream, reply: &HttpReply) -> Option<()> {
    write_response(stream, reply.status, "application/json", &serde_json::to_vec(&reply.body).ok()?).await
}

async fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> Option<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    stream.write_all(head.as_bytes()).await.ok()?;
    stream.write_all(body).await.ok()?;
    stream.flush().await.ok()
}
