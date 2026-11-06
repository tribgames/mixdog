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
use std::sync::Arc;

use bytes::Bytes;
use futures::SinkExt;
use futures::StreamExt;
use futures::stream::SplitSink;
use futures::stream::SplitStream;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_rt::TaskClass;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::Utf8Bytes;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::handshake::server::Response;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::http::header;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as WsCloseCode;
use tokio_util::sync::CancellationToken;

use crate::connection::AcceptedConnection;
use crate::connection::ConnectionOrigin;
use crate::connection::Transport;
use crate::hub::ConnectionHub;
use crate::hub::Pending;
use crate::socket::Incoming;
use crate::socket::SocketClosed;
use crate::socket::SocketRead;
use crate::socket::SocketWrite;

/// The header a bridge sets on the SSH listener to say which paired phone the socket carries
/// (`remote::bridge`); the connection is then a `Relay { peer_id }` connection.
pub const RELAY_PEER_HEADER: &str = "Mixdog-Relay-Peer";

/// `^[0-9a-f-]{8,64}$`, the shape of a relay routing id.
fn is_routing_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// Connections upgraded but not yet taken by the server's accept loop.
const ACCEPT_QUEUE: usize = 16;

/// A media frame's header precedes its payload.
const MEDIA_HEADER_ROOM: usize = mixdog_app_protocol::media::MEDIA_HEADER_LEN;

/// The discovery token a client presents as `Authorization: Bearer <token>`.
#[derive(Clone)]
pub struct BearerAuth {
    token: Arc<[u8]>,
}

impl BearerAuth {
    pub fn new(token: impl AsRef<[u8]>) -> Self {
        Self {
            token: Arc::from(token.as_ref()),
        }
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
    pub async fn bind(
        addr: SocketAddr,
        hub: ConnectionHub,
        auth: BearerAuth,
        origin: ListenerOrigin,
    ) -> Result<Self, ListenError> {
        if !addr.ip().is_loopback() {
            return Err(ListenError::NotLoopback(addr));
        }
        let listener = TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        // A host-role connection may send a media frame; text is bounded by the reader.
        let limits = hub.limits();
        let message_bound = (limits.max_media_frame_bytes as usize + MEDIA_HEADER_ROOM)
            .max(limits.max_inbound_frame_bytes as usize);
        let websocket = WebSocketConfig::default()
            .max_message_size(Some(message_bound))
            .max_frame_size(Some(message_bound));
        let context = Arc::new(Context {
            hub,
            auth,
            origin: origin.into(),
            websocket,
        });
        let (accepted_tx, accepted) = mpsc::channel(ACCEPT_QUEUE);
        let stop = CancellationToken::new();
        mixdog_rt::spawn(
            "transport.ws.accept",
            TaskClass::Control,
            accept_loop(listener, context, accepted_tx, stop.clone()),
        );
        Ok(Self {
            addr,
            accepted,
            stop,
        })
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

async fn accept_loop(
    listener: TcpListener,
    context: Arc<Context>,
    accepted: mpsc::Sender<AcceptedConnection>,
    stop: CancellationToken,
) {
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

async fn upgrade(
    stream: TcpStream,
    pending: Pending,
    context: &Context,
) -> Option<AcceptedConnection> {
    if let Err(error) = stream.set_nodelay(true) {
        tracing::debug!(%error, "set_nodelay failed");
    }
    let screen = |request: &Request, response: Response| {
        screen_upgrade(context, &pending, request, response)
    };
    let upgraded = tokio::select! {
        () = pending.abandoned() => return None,
        result = tokio_tungstenite::accept_hdr_async_with_config(
            stream,
            screen,
            Some(context.websocket),
        ) => result,
    };
    match upgraded {
        Ok(socket) => {
            let (write, read) = socket.split();
            Some(pending.start(WsRead(read), WsWrite(write)))
        }
        Err(error) => {
            tracing::debug!(%error, "websocket upgrade failed");
            None
        }
    }
}

/// The upgrade rules of P §4.1, in order: path, `Origin`, Bearer token, connection limit.
fn screen_upgrade(
    context: &Context,
    pending: &Pending,
    request: &Request,
    response: Response,
) -> Result<Response, ErrorResponse> {
    if request.uri().path() != "/rpc" {
        return Err(refusal(StatusCode::NOT_FOUND, "notFound"));
    }
    if request.headers().contains_key(header::ORIGIN) {
        return Err(refusal(StatusCode::FORBIDDEN, "originRefused"));
    }
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| context.auth.accepts(value));
    if !authorized {
        return Err(refusal(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    if pending.over_limit() {
        return Err(refusal(StatusCode::SERVICE_UNAVAILABLE, "connectionLimit"));
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
                _ => return Err(refusal(StatusCode::BAD_REQUEST, "invalidRelayPeer")),
            }
        }
    }
    Ok(response)
}

fn refusal(status: StatusCode, reason: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(format!("{{\"reason\":\"{reason}\"}}")));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    response
}

struct WsRead(SplitStream<WebSocketStream<TcpStream>>);

impl SocketRead for WsRead {
    async fn next(&mut self) -> Option<Incoming> {
        Some(match self.0.next().await? {
            Ok(Message::Text(text)) => Incoming::Text(text.as_str().to_owned()),
            Ok(Message::Binary(frame)) => Incoming::Binary(frame),
            // The protocol layer answers pings itself, coalescing to one pending pong.
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => Incoming::Activity,
            Ok(Message::Close(_)) => Incoming::Close,
            Err(WsError::Capacity(_)) => Incoming::Fault(CloseCode::FrameTooBig),
            Err(WsError::Utf8(_) | WsError::Protocol(_)) => {
                Incoming::Fault(CloseCode::InvalidFrame)
            }
            Err(_) => return None,
        })
    }
}

struct WsWrite(SplitSink<WebSocketStream<TcpStream>, Message>);

impl SocketWrite for WsWrite {
    async fn text(&mut self, frame: Bytes) -> Result<(), SocketClosed> {
        let Ok(text) = Utf8Bytes::try_from(frame) else {
            // Frames are serialized JSON; anything else is a server bug and ends the connection.
            tracing::error!("outbound text frame is not UTF-8");
            return Err(SocketClosed);
        };
        self.0
            .send(Message::Text(text))
            .await
            .map_err(|_| SocketClosed)
    }

    async fn ping(&mut self) -> Result<(), SocketClosed> {
        self.0
            .send(Message::Ping(Bytes::new()))
            .await
            .map_err(|_| SocketClosed)
    }

    async fn close(&mut self, code: CloseCode) -> Result<(), SocketClosed> {
        let frame = CloseFrame {
            code: WsCloseCode::from(code.code()),
            reason: Utf8Bytes::from_static(code.reason()),
        };
        self.0
            .send(Message::Close(Some(frame)))
            .await
            .map_err(|_| SocketClosed)
    }
}
