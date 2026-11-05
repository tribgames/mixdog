//! The two halves of a connection's socket as the writer and reader tasks see them. The
//! WebSocket listener and the in-process relay channel implement them; the tasks themselves are
//! the same for both (`ConnectionHub::attach`).

use std::future::Future;

use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;

/// The peer is gone: a write or read cannot continue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SocketClosed;

/// One inbound event, already stripped of protocol framing.
#[derive(Debug)]
pub enum Incoming {
    Text(String),
    /// A binary frame; only a host-role connection may send one (X17).
    Binary(Bytes),
    /// A Ping, Pong or any other liveness-only frame.
    Activity,
    /// The peer started the close handshake. The reader keeps reading until `None` so the
    /// protocol layer can finish the handshake.
    Close,
    /// The peer broke the framing rules: the connection closes with this code.
    Fault(CloseCode),
}

pub trait SocketRead: Send + 'static {
    /// The next event; `None` when the stream ended.
    fn next(&mut self) -> impl Future<Output = Option<Incoming>> + Send;
}

pub trait SocketWrite: Send + 'static {
    /// Writes one text frame and returns once the socket has taken it. Waits while the peer
    /// does not read: this is the backpressure the byte budget bounds.
    fn text(&mut self, frame: Bytes) -> impl Future<Output = Result<(), SocketClosed>> + Send;

    /// A transport-level ping.
    fn ping(&mut self) -> impl Future<Output = Result<(), SocketClosed>> + Send;

    /// Sends the close frame; the last call on this socket.
    fn close(&mut self, code: CloseCode) -> impl Future<Output = Result<(), SocketClosed>> + Send;
}
