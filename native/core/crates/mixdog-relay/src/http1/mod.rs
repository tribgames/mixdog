//! The HTTP/1.1 server layer of the relay: what `node:http` and `node:https` give `server.mjs`, with the bytes a client sees
//! of Node (the raw refusals, the head of a response and the order of its parts, keep-alive, 100-continue, the upgrade
//! hand-off). It is written on tokio and httparse rather than taken from a general HTTP server because the relay must hand
//! the raw socket to its own WebSocket layer and answer byte for byte as Node answers.
//!
//! A server is started with [`crate::net::Server`] and a [`Handler`]: `request` runs once per request, concurrently with
//! the others of other connections, and `upgrade` once per request that asks to switch protocols.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf, Bytes};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::logline;

pub mod body;
pub mod conn;
pub mod head;
pub mod response;
pub mod util;

pub use body::{Body, BodyError};
pub use conn::{ConnGuard, ConnHandle, ConnInfo, Lifecycle, Limits, serve_connection};
pub use head::{HeaderValue, Headers};
pub use response::{HIGH_WATER_MARK, HeaderError, ResponseWriter, status_message};

/// What a handler's `request` returns: the work of answering one request.
pub type HandlerFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// The two listeners of a server (`server.on('request')` and `server.on('upgrade')`).
pub trait Handler: Send + Sync + 'static {
    /// Answers a request. A panic in it is answered as `guardedHttpHandler` answers a throw: `[relay] request failed:` on
    /// stderr and a 500, or a destroyed connection when the head has gone. An asynchronous failure is the handler's own to
    /// answer with [`fail_request`]. A response dropped without being ended closes the connection.
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture;

    /// Takes a request that asked for an upgrade, with its socket. A panic here is logged (`guardUpgrades`) and drops the
    /// socket.
    fn upgrade(&self, upgrade: UpgradeRequest);
}

/// An `IncomingMessage` as a handler reads it.
#[derive(Debug)]
pub struct Request {
    pub method: String,
    /// `request.url`: the target as sent, an absolute-form one included.
    pub url: String,
    /// `request.httpVersion`: `1.1` or `1.0`.
    pub http_version: String,
    pub headers: Headers,
    /// `request.socket.remoteAddress`.
    pub remote_address: Option<String>,
    /// `request.socket.encrypted`.
    pub encrypted: bool,
    pub body: Body,
    pub(crate) conn: ConnHandle,
}

impl Request {
    /// `request.socket`.
    pub fn conn(&self) -> &ConnHandle {
        &self.conn
    }

    /// `request.destroy()`: closes the connection.
    pub fn destroy(&self) {
        self.conn.destroy();
    }
}

/// What the WebSocket layer needs of a socket: bytes in and out.
pub trait RawIo: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> RawIo for T {}

/// A request that carries `Connection: upgrade` and an `Upgrade` header (whatever its value), given over with its socket. On
/// TLS the socket is the decrypted stream, as the `TLSSocket` Node hands to its `upgrade` listener.
pub struct UpgradeRequest {
    pub method: String,
    pub url: String,
    pub http_version: String,
    pub headers: Headers,
    pub remote_address: Option<String>,
    pub encrypted: bool,
    /// The bytes already read past the request head.
    pub leftover: Bytes,
    /// The socket, positioned after what the parser has read: `leftover` is not in it any more.
    pub io: Box<dyn RawIo>,
    pub(crate) guard: Option<ConnGuard>,
}

impl UpgradeRequest {
    /// The socket as a stream that reads `leftover` first.
    pub fn into_stream(self) -> PrefixedIo {
        PrefixedIo { prefix: self.leftover, inner: self.io, _guard: self.guard }
    }
}

/// A socket with some bytes in front of it.
pub struct PrefixedIo {
    prefix: Bytes,
    inner: Box<dyn RawIo>,
    _guard: Option<ConnGuard>,
}

impl AsyncRead for PrefixedIo {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let take = self.prefix.len().min(buf.remaining());
            buf.put_slice(&self.prefix[..take]);
            self.prefix.advance(take);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for PrefixedIo {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// `HTTP/1.1 <status> <reason>\r\nConnection: close\r\n\r\n`: the raw answer written before a handshake or a request is
/// accepted, with no other header.
pub fn refusal_bytes(status: u16, reason: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\n\r\n").into_bytes()
}

/// `failRequest(request, response, label)`: the terminator of an asynchronous handler. Logs `[relay] <label> failed:`, ends
/// the response if its head has gone, else answers 500 `Internal error.`; destroys the connection if even that fails.
pub fn fail_request(label: &str, message: &str, response: &mut ResponseWriter) {
    logline::emit(&logline::label_failed(label, message));
    if response.headers_sent() {
        response.end(None);
        return;
    }
    if response.write_head(500, &[("Content-Type", "text/plain; charset=utf-8")]).is_ok() {
        response.end(Some(b"Internal error."));
    } else {
        response.destroy();
    }
}
