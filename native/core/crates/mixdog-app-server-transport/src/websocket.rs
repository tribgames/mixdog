//! The WebSocket listener (P §4.1): `ws://127.0.0.1:<port>/rpc`.
//!
//! - Only a loopback address is ever bound.
//! - The upgrade must carry `Authorization: Bearer <token>`; any request with an `Origin`
//!   header is refused with 403; other paths answer 404; the upgrade past `maxConnections`
//!   answers 503 `{"reason":"connectionLimit"}`.
//! - Frames follow the shared reader/writer tasks: text frames up to `maxInboundFrameBytes`
//!   (1009 above, 1007 for bad JSON), binary only from a host-role connection (1003 otherwise).

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Context as TaskContext;
use std::task::Poll;
use std::task::ready;

use bytes::Bytes;
use futures::SinkExt;
use futures::StreamExt;
use futures::stream::SplitSink;
use futures::stream::SplitStream;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_rt::TaskClass;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::Utf8Bytes;
use tokio_tungstenite::tungstenite::handshake::server::Callback;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::handshake::server::Response;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::http::header;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::Frame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as WsCloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::Data as OpData;
use tokio_tungstenite::tungstenite::protocol::frame::coding::OpCode;
use tokio_util::sync::CancellationToken;

use crate::connection::AcceptedConnection;
use crate::connection::ConnectionOrigin;
use crate::connection::Transport;
use crate::connection::WindowRole;
use crate::hub::ConnectionHub;
use crate::hub::Pending;
use crate::socket::Incoming;
use crate::socket::SocketClosed;
use crate::socket::SocketRead;
use crate::socket::SocketWrite;

/// The header a bridge sets on the SSH listener to say which paired phone the socket carries
/// (`remote::bridge`); the connection is then a `Relay { peer_id }` connection.
pub const RELAY_PEER_HEADER: &str = "Mixdog-Relay-Peer";

/// The header a desktop window sets to name itself; the connection is then a
/// `ConnectionOrigin::Window` one. Valid on both listeners.
pub const WINDOW_HEADER: &str = "Mixdog-Window";

/// The header that says what a window's socket is for: `main` or `server:<connectionId>`.
/// Valid only together with [`WINDOW_HEADER`]; without it the role is `main`.
pub const WINDOW_ROLE_HEADER: &str = "Mixdog-Window-Role";

/// `^[A-Za-z0-9._:-]{1,128}$`, the shape of a window id and of a server connection id.
fn is_window_token(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// The single value of header `name`: `Ok(None)` when absent, `Err` when repeated or not text.
fn single_header<'a>(request: &'a Request, name: &str) -> Result<Option<&'a str>, ()> {
    let mut values = request.headers().get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    match (first.to_str(), values.next()) {
        (Ok(value), None) => Ok(Some(value)),
        _ => Err(()),
    }
}

/// `^[0-9a-f-]{8,64}$`, the shape of a relay routing id.
fn is_routing_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// Connections upgraded but not yet taken by the server's accept loop.
const ACCEPT_QUEUE: usize = 16;

/// A media frame's header precedes its payload.
const MEDIA_HEADER_ROOM: usize = mixdog_app_protocol::media::MEDIA_HEADER_LEN;

/// The longest frame a text message leaves in; a longer message goes in fragments of this size. The socket's write buffer grows
/// to the longest frame it is handed and keeps that capacity for the life of the connection.
pub const TEXT_FRAGMENT_BYTES: usize = 64 * 1024;

/// The discovery token a client presents as `Authorization: Bearer <token>`.
#[derive(Clone)]
pub struct BearerAuth {
    token: Arc<[u8]>,
}

impl BearerAuth {
    pub fn new(token: impl AsRef<[u8]>) -> Self {
        Self { token: Arc::from(token.as_ref()) }
    }

    fn accepts(&self, authorization: &str) -> bool {
        let Some((scheme, presented)) = authorization.split_once(' ') else {
            return false;
        };
        scheme.eq_ignore_ascii_case("Bearer") && constant_time_eq(presented.as_bytes(), &self.token)
    }
}

/// Equality whose time does not depend on where the inputs first differ.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// Which connections a listener accepts: the loopback listener or the one an SSH port
/// forward targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListenerOrigin {
    Loopback,
    SshTunnel,
}

impl From<ListenerOrigin> for ConnectionOrigin {
    fn from(origin: ListenerOrigin) -> Self {
        match origin {
            ListenerOrigin::Loopback => ConnectionOrigin::Loopback,
            ListenerOrigin::SshTunnel => ConnectionOrigin::SshTunnel,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error("refusing to listen on non-loopback address {0}")]
    NotLoopback(SocketAddr),
    #[error("listener I/O error: {0}")]
    Io(#[from] io::Error),
}

struct Context {
    hub: ConnectionHub,
    auth: BearerAuth,
    origin: ConnectionOrigin,
    websocket: WebSocketConfig,
}

pub struct WebSocketListener {
    addr: SocketAddr,
    accepted: mpsc::Receiver<AcceptedConnection>,
    stop: CancellationToken,
}

impl WebSocketListener {
    /// Binds `addr` (loopback only) and starts accepting on RT-C.
    pub async fn bind(addr: SocketAddr, hub: ConnectionHub, auth: BearerAuth, origin: ListenerOrigin) -> Result<Self, ListenError> {
        if !addr.ip().is_loopback() {
            return Err(ListenError::NotLoopback(addr));
        }
        let listener = TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        // A host-role connection may send a media frame; text is bounded by the reader.
        let limits = hub.limits();
        let message_bound = (limits.max_media_frame_bytes as usize + MEDIA_HEADER_ROOM).max(limits.max_inbound_frame_bytes as usize);
        let websocket = WebSocketConfig::default().max_message_size(Some(message_bound)).max_frame_size(Some(message_bound));
        let context = Arc::new(Context { hub, auth, origin: origin.into(), websocket });
        let (accepted_tx, accepted) = mpsc::channel(ACCEPT_QUEUE);
        let stop = CancellationToken::new();
        mixdog_rt::spawn("transport.ws.accept", TaskClass::Control, accept_loop(listener, context, accepted_tx, stop.clone()));
        Ok(Self { addr, accepted, stop })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stops accepting (drain). Connections already accepted are the hub's.
    pub fn close(&self) {
        self.stop.cancel();
    }
}

impl Drop for WebSocketListener {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Transport for WebSocketListener {
    async fn accept(&mut self) -> Option<AcceptedConnection> {
        self.accepted.recv().await
    }
}

async fn accept_loop(listener: TcpListener, context: Arc<Context>, accepted: mpsc::Sender<AcceptedConnection>, stop: CancellationToken) {
    loop {
        let stream = tokio::select! {
            () = stop.cancelled() => return,
            result = listener.accept() => match result {
                Ok((stream, _)) => stream,
                // The peer left before accept completed; the listener is fine.
                Err(error) if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionReset
                ) => continue,
                Err(error) => {
                    tracing::error!(%error, "websocket listener stopped");
                    return;
                }
            },
        };
        let pending = context.hub.admit(context.origin.clone());
        let context = Arc::clone(&context);
        let accepted = accepted.clone();
        mixdog_rt::spawn("transport.ws.upgrade", TaskClass::Control, async move {
            if let Some(connection) = upgrade(stream, pending, &context).await {
                // A closed listener drops the connection, which closes it.
                let _ = accepted.send(connection).await;
            }
        });
    }
}

async fn upgrade(stream: TcpStream, pending: Pending, context: &Context) -> Option<AcceptedConnection> {
    if let Err(error) = stream.set_nodelay(true) {
        tracing::debug!(%error, "set_nodelay failed");
    }
    let screen = UpgradeScreen { context, pending: &pending };
    let upgraded = tokio::select! {
        () = pending.abandoned() => {
            pending.ends_because("abandoned".to_owned());
            return None;
        }
        result = tokio_tungstenite::accept_hdr_async_with_config(
            HeaderAligned::new(stream, context.websocket.read_buffer_size),
            screen,
            Some(context.websocket),
        ) => result,
    };
    match upgraded {
        Ok(mut socket) => {
            socket.get_mut().upgraded();
            let (write, read) = socket.split();
            Some(pending.start(WsRead { stream: read, last: None }, WsWrite(write)))
        }
        // A refusal recorded its reason where it was decided.
        Err(WsError::Http(_)) => None,
        Err(error) => {
            tracing::debug!(%error, "websocket upgrade failed");
            pending.ends_because("handshakeFailed".to_owned());
            None
        }
    }
}

/// The callback owns no connection state; tungstenite fixes its response/error types.
struct UpgradeScreen<'a> {
    context: &'a Context,
    pending: &'a Pending,
}

impl Callback for UpgradeScreen<'_> {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        let pending = self.pending;
        self.screen(request, response).map_err(|refused| {
            pending.ends_because(format!("refused status={} cause={}", refused.status.as_u16(), refused.reason));
            refused.into_response()
        })
    }
}

struct Refusal {
    status: StatusCode,
    reason: &'static str,
}

impl Refusal {
    fn into_response(self) -> ErrorResponse {
        let mut response = ErrorResponse::new(Some(format!("{{\"reason\":\"{}\"}}", self.reason)));
        *response.status_mut() = self.status;
        response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json"));
        response
    }
}

impl UpgradeScreen<'_> {
    /// The upgrade rules of P §4.1, in order: path, Origin, Bearer token, connection limit, then narrowing.
    fn screen(self, request: &Request, response: Response) -> Result<Response, Box<Refusal>> {
        let Self { context, pending } = self;
        if request.uri().path() != "/rpc" {
            return Err(Box::new(refusal(StatusCode::NOT_FOUND, "notFound")));
        }
        if request.headers().contains_key(header::ORIGIN) {
            return Err(Box::new(refusal(StatusCode::FORBIDDEN, "originRefused")));
        }
        let authorized = request.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).is_some_and(|value| context.auth.accepts(value));
        if !authorized {
            return Err(Box::new(refusal(StatusCode::UNAUTHORIZED, "unauthorized")));
        }
        if pending.over_limit() {
            return Err(Box::new(refusal(StatusCode::SERVICE_UNAVAILABLE, "connectionLimit")));
        }
        // A window names itself on either listener. It is judged before the relay header: a socket
        // is one phone or one window, never both, and a bad value is refused, not ignored.
        let window = match single_header(request, WINDOW_HEADER) {
            Ok(value) => value,
            Err(()) => return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "invalidWindow"))),
        };
        let role = match single_header(request, WINDOW_ROLE_HEADER) {
            Ok(value) => value,
            Err(()) => return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "invalidWindowRole"))),
        };
        if let Some(window) = window {
            if !is_window_token(window) {
                return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "invalidWindow")));
            }
            let role = match role {
                None | Some("main") => WindowRole::Main,
                Some(role) => match role.strip_prefix("server:").filter(|id| is_window_token(id)) {
                    Some(id) => WindowRole::Server { connection_id: id.to_owned() },
                    None => return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "invalidWindowRole"))),
                },
            };
            if request.headers().contains_key(RELAY_PEER_HEADER) {
                return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "conflictingNarrowing")));
            }
            pending.narrow_to_window(window.to_owned(), role);
            return Ok(response);
        }
        if role.is_some() {
            return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "invalidWindowRole")));
        }
        // Only the SSH listener is where a bridge brings phones; on the loopback listener the
        // header means nothing. A header that is present but not a single routing id is refused,
        // not ignored: ignoring it would leave the phone with the tunnel's wider rights.
        if context.origin == ConnectionOrigin::SshTunnel {
            let mut values = request.headers().get_all(RELAY_PEER_HEADER).iter();
            if let Some(value) = values.next() {
                let peer = value.to_str().ok().filter(|peer| is_routing_id(peer));
                match (peer, values.next()) {
                    (Some(peer), None) => {
                        pending.narrow_to_relay(peer.to_owned());
                    }
                    _ => return Err(Box::new(refusal(StatusCode::BAD_REQUEST, "invalidRelayPeer"))),
                }
            }
        }
        Ok(response)
    }
}

fn refusal(status: StatusCode, reason: &'static str) -> Refusal {
    Refusal { status, reason }
}

/// The longest frame header: two bytes, an eight-byte length and a mask key.
const LONGEST_HEADER: usize = 14;

/// A connection's stream as tungstenite reads it: what arrives is handed on in the reads the codec asks for, except that a
/// frame whose payload is longer than the codec's read size has its header handed on alone. tungstenite sizes a frame's
/// read buffer as the bytes it holds past the header plus the frame's length: a long frame read together with the start of
/// its payload leaves that much room after it, the small frames that follow fit there, and the buffer grown for the long
/// frame stays the connection's read buffer. Handed its header alone, the codec holds the frame in a buffer of its size and
/// the next frame needs a new one.
struct HeaderAligned<S> {
    stream: S,
    /// Where the bytes handed on stand within their frames; `None` while the stream carries the HTTP upgrade.
    at: Option<FramePosition>,
    /// The codec's read size: a longer payload is a long frame's.
    long: u64,
    /// What a read brought past a long frame's header, handed on by the next reads: at most one read of the codec's.
    ahead: Bytes,
}

enum FramePosition {
    Header { bytes: [u8; LONGEST_HEADER], got: usize },
    Payload { left: u64 },
}

impl FramePosition {
    const START: Self = Self::Header { bytes: [0; LONGEST_HEADER], got: 0 };

    /// Takes as much of `read` as the codec may be handed now: all of it, or up to the end of a header whose payload is
    /// longer than `long`. How many bytes.
    fn take(&mut self, read: &[u8], long: u64) -> usize {
        let mut taken = 0;
        while taken < read.len() {
            match self {
                Self::Header { bytes, got } => {
                    let need = if *got < 2 { 2 } else { header_len(bytes) };
                    let more = (need - *got).min(read.len() - taken);
                    bytes[*got..*got + more].copy_from_slice(&read[taken..taken + more]);
                    *got += more;
                    taken += more;
                    if *got >= 2 && *got == header_len(bytes) {
                        let len = payload_len(bytes);
                        *self = Self::Payload { left: len };
                        if len > long {
                            break;
                        }
                    }
                }
                Self::Payload { left } => {
                    let more = usize::try_from(*left).unwrap_or(usize::MAX).min(read.len() - taken);
                    *left -= more as u64;
                    taken += more;
                    if *left == 0 {
                        *self = Self::START;
                    }
                }
            }
        }
        taken
    }
}

fn header_len(bytes: &[u8]) -> usize {
    let length = match bytes[1] & 0x7f {
        126 => 2,
        127 => 8,
        _ => 0,
    };
    let mask = if bytes[1] & 0x80 == 0 { 0 } else { 4 };
    2 + length + mask
}

fn payload_len(bytes: &[u8]) -> u64 {
    match bytes[1] & 0x7f {
        126 => u64::from(u16::from_be_bytes([bytes[2], bytes[3]])),
        127 => u64::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9]]),
        len => u64::from(len),
    }
}

impl<S> HeaderAligned<S> {
    fn new(stream: S, read_size: usize) -> Self {
        Self { stream, at: None, long: read_size as u64, ahead: Bytes::new() }
    }

    /// A client sends nothing after its upgrade request until the response (RFC 6455 §4.1), so the first byte read after
    /// the upgrade starts a header.
    fn upgraded(&mut self) {
        self.at = Some(FramePosition::START);
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for HeaderAligned<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let Some(at) = &mut this.at else {
            return Pin::new(&mut this.stream).poll_read(cx, buf);
        };
        if !this.ahead.is_empty() {
            let offered = this.ahead.len().min(buf.remaining());
            let taken = at.take(&this.ahead[..offered], this.long);
            buf.put_slice(&this.ahead[..taken]);
            this.ahead = if taken == this.ahead.len() { Bytes::new() } else { this.ahead.slice(taken..) };
            return Poll::Ready(Ok(()));
        }
        let before = buf.filled().len();
        ready!(Pin::new(&mut this.stream).poll_read(cx, buf))?;
        let read = &buf.filled()[before..];
        let taken = at.take(read, this.long);
        if taken < read.len() {
            this.ahead = Bytes::copy_from_slice(&read[taken..]);
            buf.set_filled(before + taken);
        }
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for HeaderAligned<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

struct WsRead {
    stream: SplitStream<WebSocketStream<HeaderAligned<TcpStream>>>,
    /// The payload of the last text or binary frame, a slice of the codec's read buffer. That buffer grows to the longest
    /// frame read, and a buffer nothing else holds is reused for the connection's life; held here while the next frame is
    /// read, the buffer is never the codec's alone, so the codec reads on into a buffer of its usual size and the grown one
    /// goes with the last payload in it.
    last: Option<Bytes>,
}

impl SocketRead for WsRead {
    async fn next(&mut self) -> Option<Incoming> {
        let read = self.stream.next().await?;
        if self.last.as_ref().is_some_and(Bytes::is_unique) {
            self.last = None;
        }
        Some(match read {
            Ok(Message::Text(text)) => {
                self.last = Some(Bytes::from(text.clone()));
                Incoming::Text(text)
            }
            Ok(Message::Binary(frame)) => {
                self.last = Some(frame.clone());
                Incoming::Binary(frame)
            }
            // The protocol layer answers pings itself, coalescing to one pending pong.
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => Incoming::Activity,
            Ok(Message::Close(_)) => Incoming::Close,
            Err(WsError::Capacity(_)) => Incoming::Fault(CloseCode::FrameTooBig),
            Err(WsError::Utf8(_) | WsError::Protocol(_)) => Incoming::Fault(CloseCode::InvalidFrame),
            Err(_) => return None,
        })
    }
}

struct WsWrite(SplitSink<WebSocketStream<HeaderAligned<TcpStream>>, Message>);

impl SocketWrite for WsWrite {
    async fn text(&mut self, frame: Bytes) -> Result<(), SocketClosed> {
        let Ok(text) = std::str::from_utf8(&frame) else {
            // Frames are serialized JSON; anything else is a server bug and ends the connection.
            tracing::error!("outbound text frame is not UTF-8");
            return Err(SocketClosed);
        };
        if text.len() <= TEXT_FRAGMENT_BYTES {
            let text = Utf8Bytes::try_from(frame).map_err(|_| SocketClosed)?;
            return self.0.send(Message::Text(text)).await.map_err(|_| SocketClosed);
        }
        // Each fragment ends on a character boundary, so every one is text on its own too.
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + TEXT_FRAGMENT_BYTES).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let opcode = if start == 0 { OpData::Text } else { OpData::Continue };
            let fragment = Frame::message(frame.slice(start..end), OpCode::Data(opcode), end == text.len());
            self.0.send(Message::Frame(fragment)).await.map_err(|_| SocketClosed)?;
            start = end;
        }
        Ok(())
    }

    async fn ping(&mut self) -> Result<(), SocketClosed> {
        self.0.send(Message::Ping(Bytes::new())).await.map_err(|_| SocketClosed)
    }

    async fn close(&mut self, code: CloseCode) -> Result<(), SocketClosed> {
        let frame = CloseFrame { code: WsCloseCode::from(code.code()), reason: Utf8Bytes::from_static(code.reason()) };
        self.0.send(Message::Close(Some(frame))).await.map_err(|_| SocketClosed)
    }
}

#[cfg(test)]
mod header_aligned_tests {
    use tokio::io::AsyncWriteExt;
    use tokio::io::DuplexStream;
    use tokio_tungstenite::tungstenite::protocol::Role;

    use super::*;

    /// The inner stream, counting its reads that brought bytes.
    struct Counted {
        inner: DuplexStream,
        reads: usize,
    }

    impl AsyncRead for Counted {
        fn poll_read(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            let before = buf.filled().len();
            let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
            if buf.filled().len() > before {
                this.reads += 1;
            }
            polled
        }
    }

    impl AsyncWrite for Counted {
        fn poll_write(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
        }

        fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().inner).poll_flush(cx)
        }

        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
        }
    }

    /// A client's text frame as the wire carries it; a zero mask key leaves the payload as it is.
    fn masked_text(text: &str) -> Vec<u8> {
        let mut frame = vec![0x81];
        match u16::try_from(text.len()) {
            Ok(len @ 0..=125) => frame.push(0x80 | u8::try_from(len).expect("under 126")),
            Ok(len) => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&len.to_be_bytes());
            }
            Err(_) => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(text.len() as u64).to_be_bytes());
            }
        }
        frame.extend_from_slice(&[0; 4]);
        frame.extend_from_slice(text.as_bytes());
        frame
    }

    async fn text(socket: &mut WebSocketStream<HeaderAligned<Counted>>) -> String {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => text.as_str().to_owned(),
            other => panic!("a text message, not {other:?}"),
        }
    }

    /// Small frames reach the codec in the reads it asks for, as many as have arrived in one read; a frame longer than its
    /// read size, whose header is handed on alone, still arrives whole, and so does the frame read behind it.
    #[tokio::test]
    async fn small_frames_are_read_as_they_arrive_and_a_long_frame_arrives_whole() {
        let (mut client, server) = tokio::io::duplex(1024 * 1024);
        let mut stream = HeaderAligned::new(Counted { inner: server, reads: 0 }, WebSocketConfig::default().read_buffer_size);
        stream.upgraded();
        let mut socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;

        client.write_all(&masked_text(&"a".repeat(100))).await.unwrap();
        assert_eq!(text(&mut socket).await, "a".repeat(100));
        assert_eq!(socket.get_ref().stream.reads, 1, "an isolated small frame is one read");

        let burst: Vec<u8> = (0..8).flat_map(|n| masked_text(&format!("frame {n}"))).collect();
        client.write_all(&burst).await.unwrap();
        for n in 0..8 {
            assert_eq!(text(&mut socket).await, format!("frame {n}"));
        }
        assert_eq!(socket.get_ref().stream.reads, 2, "a burst of small frames is one read");

        let long = "b".repeat(200 * 1024);
        let mut both = masked_text(&long);
        both.extend(masked_text("after"));
        client.write_all(&both).await.unwrap();
        assert_eq!(text(&mut socket).await, long);
        assert_eq!(text(&mut socket).await, "after");
    }
}
