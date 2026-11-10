//! WebSocket connections with protocol PING keepalive.
//!
//! One connection is two tasks that never wait on each other or on any other
//! connection: a reader that owns the probe schedule, and a writer that
//! forwards queued frames. The reader pings after `interval` without any
//! inbound frame and declares the link dead when nothing at all arrives within
//! `timeout` of the ping. Any inbound frame (data, ping or pong) proves the
//! link alive, so a busy stream is never probed. Probe failure is a
//! [`TransportFault::KeepaliveExpired`]; it is the only timer here and it never
//! looks at message content.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Instant;

use futures::SinkExt;
use futures::StreamExt;
use futures::stream::SplitSink;
use futures::stream::SplitStream;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::LinkLiveness;
use mixdog_core_api::domain::keepalive::PingKeepalive;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Response;

use crate::netproxy::NetworkProxy;
use crate::netproxy::ProxyConfigError;
use crate::netproxy::RouteError;
use crate::netproxy::tunnel::Conn;
use crate::netproxy::tunnel::TunnelError;
use crate::netproxy::tunnel::tls_code;
use crate::netproxy::tunnel::open_proxy_tunnel;

use base64::Engine;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;

use super::wsio::CLOSE_FLUSH;
use super::wsio::Extension;
use super::wsio::WsIo;
use super::fault::fault_from_io;
use super::fault::fault_from_ws_error;
use super::tcp;

pub use tokio_tungstenite::tungstenite::Message;

type Socket<S> = WebSocketStream<WsIo<S>>;

/// Frames queued toward the socket and the consumer.
const QUEUE: usize = 64;

/// `WS_CLOSE_TERMINATE_MS` (`openai-ws-pool.mjs`): how long a socket closed for good waits for the server's answer
/// before it is terminated.
pub const TERMINATE_AFTER_CLOSE: std::time::Duration = std::time::Duration::from_millis(250);

/// Why [`connect`] did not produce a connection.
#[derive(Debug)]
pub enum ConnectError {
    /// Nothing reached the server: `NotSent` delivery.
    Transport(TransportFault),
    /// The server answered the upgrade with a non-101 response: `Accepted`.
    Rejected(Response<Option<Vec<u8>>>),
    /// The network proxy policy or the proxy refused: nothing reached the server.
    /// code is the failure's code (MIXDOG_PROXY_CONFIG, EPROXY, undici's).
    Proxy { code: String, message: String },
}

/// The first event `ws` emits when a socket ends, the one Node's stream handler acts on (`socket-handlers.mjs`
/// `onClose` / `onError`; every later one finds `outcome.done`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WsEnding {
    /// `close(code, reason)` after the server's close frame; 1005 when the frame carried no code
    /// (`receiver.js` `controlMessage`).
    Close { code: u16, reason: String },
    /// `error`: a frame the receiver refused, with `ws`'s message, its error code and the close code it answers with.
    Violation { message: String, code: &'static str, close_code: u16 },
}

/// Liveness and age of one WebSocket connection, shared with its tasks.
pub struct WsLink {
    opened: Instant,
    schedule: Mutex<KeepaliveSchedule>,
    dead: Mutex<Option<TransportFault>>,
    ending: Mutex<Option<WsEnding>>,
    /// The close a violation started is running: the writer finishes it even after the connection is dropped.
    closing: std::sync::atomic::AtomicBool,
    /// The connection's tasks still running; the socket is closed (`ws`'s `close` event) once both have ended.
    tasks: std::sync::atomic::AtomicUsize,
    gone: tokio::sync::watch::Sender<bool>,
}

/// Held by each of a connection's tasks: the last one to end, finished or aborted, says the socket is closed.
struct TaskAlive(Arc<WsLink>);

impl Drop for TaskAlive {
    fn drop(&mut self) {
        if self.0.tasks.fetch_sub(1, std::sync::atomic::Ordering::AcqRel) == 1 {
            self.0.gone.send_replace(true);
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl WsLink {
    fn new(schedule: KeepaliveSchedule) -> Self {
        Self {
            opened: Instant::now(),
            schedule: Mutex::new(schedule),
            dead: Mutex::new(None),
            ending: Mutex::new(None),
            closing: std::sync::atomic::AtomicBool::new(false),
            tasks: std::sync::atomic::AtomicUsize::new(2),
            gone: tokio::sync::watch::Sender::new(false),
        }
    }

    /// Becomes `true` once the socket is closed: both of its tasks have ended.
    pub fn closed(&self) -> tokio::sync::watch::Receiver<bool> {
        self.gone.subscribe()
    }

    fn ping(&self) -> PingKeepalive {
        locked(&self.schedule).ws
    }

    /// The first fact that ended the link wins.
    fn mark_dead(&self, fault: TransportFault) {
        locked(&self.dead).get_or_insert(fault);
    }

    pub fn fault(&self) -> Option<TransportFault> {
        locked(&self.dead).clone()
    }
}

impl TransportKeepalive for WsLink {
    fn kind(&self) -> TransportKind {
        TransportKind::WebSocket
    }

    /// Replaces the schedule the connection's tasks read. [`connect`] has
    /// already armed the schedule it was given.
    fn arm(&self, schedule: &KeepaliveSchedule) -> Result<(), TransportFault> {
        *locked(&self.schedule) = *schedule;
        Ok(())
    }

    fn liveness(&self) -> LinkLiveness {
        match self.fault() {
            Some(fault) => LinkLiveness::Dead(fault),
            None => LinkLiveness::Alive,
        }
    }

    fn may_start_response(&self) -> bool {
        let max_age = locked(&self.schedule).ws_max_age;
        max_age.is_none_or(|max| self.opened.elapsed() < max)
    }
}

struct AbortOnDrop {
    writer: AbortHandle,
    reader: AbortHandle,
    link: Arc<WsLink>,
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        // A close under way runs to its end or its bound whoever holds the connection: a violation's within ws's
        // closeTimeout (`setCloseTimer`), one the owner asked for until its terminate ([`WsConnection::close`]).
        if !self.link.closing.load(std::sync::atomic::Ordering::Acquire) {
            self.reader.abort();
            self.writer.abort();
        }
    }
}

/// Closes a connection whoever holds it: `socket.close(code, reason)`, then the socket is terminated
/// [`TERMINATE_AFTER_CLOSE`] later unless the server's answer ended it first. The holder keeps reading what arrives
/// until the server's close, as `ws` goes on emitting messages while CLOSING.
#[derive(Clone)]
pub struct WsCloser {
    out: mpsc::Sender<Message>,
    link: Arc<WsLink>,
    writer: AbortHandle,
    reader: AbortHandle,
}

impl WsCloser {
    pub fn close(&self, code: u16, reason: &str) {
        if self.link.closing.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return; // a close is under way already: `ws` sends one close frame
        }
        let frame = tungstenite::protocol::CloseFrame { code: code.into(), reason: reason.to_owned().into() };
        if self.out.try_send(Message::Close(Some(frame))).is_err() {
            // The link is gone already: nothing is sent, and the tasks end now.
            self.writer.abort();
            self.reader.abort();
            return;
        }
        let (writer, reader) = (self.writer.clone(), self.reader.clone());
        mixdog_rt::spawn("ai.ws.terminate", TaskClass::Work, async move {
            tokio::time::sleep(TERMINATE_AFTER_CLOSE).await;
            writer.abort();
            reader.abort();
        });
    }
}

/// An open WebSocket. Dropping it closes the socket.
pub struct WsConnection {
    out: mpsc::Sender<Message>,
    inbound: mpsc::Receiver<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
    ended: bool,
    _tasks: AbortOnDrop,
}

/// Connects with `SO_KEEPALIVE` set before the first byte and PING keepalive
/// running from the first frame. Returns the upgrade response so callers can
/// read its headers.
pub async fn connect(
    request: impl IntoClientRequest,
    schedule: &KeepaliveSchedule,
) -> Result<(WsConnection, Response<Option<Vec<u8>>>), ConnectError> {
    connect_via(request, schedule, None).await
}

/// Opens the socket the upgrade runs on: straight to the server, or, when the
/// network proxy policy names a proxy for it, through a tunnel. A proxy that
/// cannot be reached or refuses the tunnel is an error, never a direct connect.
async fn open_stream(
    host: &str,
    port: u16,
    target: &str,
    schedule: &KeepaliveSchedule,
    policy: Option<&NetworkProxy>,
) -> Result<Conn, ConnectError> {
    if let Some(policy) = policy {
        let route = policy.route_for_url(target).await.map_err(|error| ConnectError::Proxy {
            code: match &error {
                RouteError::Config(_) => ProxyConfigError::CODE.to_owned(),
                RouteError::InvalidTarget(_) => "ERR_INVALID_URL".to_owned(),
            },
            message: error.to_string(),
        })?;
        if let Some(proxy) = route.proxy {
            let bare = host.trim_start_matches('[').trim_end_matches(']');
            return open_proxy_tunnel(&proxy, bare, port, &schedule.tcp).await.map_err(|err| match err {
                TunnelError::Dns => ConnectError::Transport(TransportFault::Dns),
                TunnelError::Connect(io) => ConnectError::Transport(fault_from_io(&io, true)),
                TunnelError::Io(io) => ConnectError::Transport(fault_from_io(&io, false)),
                TunnelError::Tls(failure) => {
                    ConnectError::Proxy { code: tls_code(&failure).to_owned(), message: failure.error.to_string() }
                }
                TunnelError::Dropped(io) => ConnectError::Proxy { code: "UND_ERR_SOCKET".into(), message: io.to_string() },
                TunnelError::TimedOut => ConnectError::Proxy { code: "UND_ERR_HEADERS_TIMEOUT".into(), message: err.to_string() },
                refused @ TunnelError::Refused { .. } => ConnectError::Proxy {
                    code: refused.socket_code().unwrap_or("EPROXY").to_owned(),
                    message: refused.to_string(),
                },
            });
        }
    }
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| ConnectError::Transport(TransportFault::Dns))?;
    let mut failure = TransportFault::Dns;
    for addr in addrs {
        match tcp::connect(addr, &schedule.tcp).await {
            Ok(stream) => return Ok(Conn::Tcp(stream)),
            Err(err) => failure = fault_from_io(&err, true),
        }
    }
    Err(ConnectError::Transport(failure))
}

/// [`connect`] following the network proxy policy of `policy`.
pub async fn connect_via(
    request: impl IntoClientRequest,
    schedule: &KeepaliveSchedule,
    policy: Option<&NetworkProxy>,
) -> Result<(WsConnection, Response<Option<Vec<u8>>>), ConnectError> {
    let request = request
        .into_client_request()
        .map_err(|err| ConnectError::Transport(fault_from_ws_error(&err)))?;
    let uri = request.uri();
    let host = uri
        .host()
        .ok_or(ConnectError::Transport(TransportFault::Dns))?
        .to_owned();
    let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
        Some("wss") => 443,
        _ => 80,
    });
    let target = uri.to_string();
    let stream = open_stream(&host, port, &target, schedule, policy).await?;
    connect_over(request, stream, schedule, None).await
}


/// The upgrade of `request` over the TCP connection to `addr` instead of the one its host names, trusting `tls` alone:
/// the request (url, `Host`, SNI) and everything after the connect are the production path, so a loopback server
/// receives what the real one would. Compiled for tests and the `test-support` feature only.
#[cfg(any(test, feature = "test-support"))]
pub async fn connect_pinned(
    request: tungstenite::handshake::client::Request,
    addr: std::net::SocketAddr,
    schedule: &KeepaliveSchedule,
    tls: Arc<rustls::ClientConfig>,
) -> Result<(WsConnection, Response<Option<Vec<u8>>>), ConnectError> {
    let stream = tcp::connect(addr, &schedule.tcp)
        .await
        .map(Conn::Tcp)
        .map_err(|err| ConnectError::Transport(fault_from_io(&err, true)))?;
    connect_over(request, stream, schedule, Some(tls)).await
}

/// The headers the upgrade is written with, in the caller's order and letter case: the provider's, as the request's
/// extension carries them. `ws` writes them first, then its own, then `Host` (`websocket.js:690`, `:773-779`).
#[derive(Debug, Clone, Default)]
pub struct CallerHeaders(pub Vec<(String, String)>);

/// What `ws` itself puts on an upgrade, in its order (`websocket.js:783-790`), and the names the caller may not set.
const RESERVED: [&str; 6] = ["host", "connection", "upgrade", "sec-websocket-version", "sec-websocket-key", "sec-websocket-extensions"];

/// The upgrade request as `ws` writes it, and the key it carries.
fn upgrade_bytes(request: &tungstenite::handshake::client::Request, key: &str) -> Vec<u8> {
    let uri = request.uri();
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    let fallback;
    let caller = match request.extensions().get::<CallerHeaders>() {
        Some(CallerHeaders(list)) => list,
        None => {
            fallback = request
                .headers()
                .iter()
                .map(|(n, v)| (n.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect::<Vec<_>>();
            &fallback
        }
    };
    let host = uri.host().unwrap_or_default();
    let host = match (uri.port_u16(), uri.scheme_str()) {
        (Some(443), Some("wss")) | (Some(80), Some("ws")) | (None, _) => host.to_owned(),
        (Some(port), _) => format!("{host}:{port}"),
    };
    let mut out = format!("GET {path} HTTP/1.1\r\n");
    for (name, value) in caller.iter().filter(|(n, _)| !RESERVED.contains(&n.to_ascii_lowercase().as_str())) {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\nHost: {host}\r\n\r\n"
    ));
    out.into_bytes()
}

/// The longest response head or rejected body read.
const RESPONSE_LIMIT: usize = 1 << 20;

/// Writes the upgrade over `io` and reads the answer: the 101 response, the bytes already behind it, and what the
/// server accepted of the compression offer. Any other answer is [`ConnectError::Rejected`] with its body.
async fn upgrade<S: AsyncRead + AsyncWrite + Unpin>(
    io: &mut S,
    request: &tungstenite::handshake::client::Request,
) -> Result<(Response<Option<Vec<u8>>>, Vec<u8>, Option<Extension>), ConnectError> {
    let io_fault = |e: std::io::Error| ConnectError::Transport(fault_from_io(&e, false));
    let key = tungstenite::handshake::client::generate_key();
    io.write_all(&upgrade_bytes(request, &key)).await.map_err(io_fault)?;
    io.flush().await.map_err(io_fault)?;
    let mut buf = Vec::new();
    let (status, headers, head_len) = loop {
        let mut chunk = [0u8; 8192];
        let n = io.read(&mut chunk).await.map_err(io_fault)?;
        if n == 0 {
            return Err(ConnectError::Transport(TransportFault::Closed));
        }
        buf.extend_from_slice(&chunk[..n]);
        let mut slots = [httparse::EMPTY_HEADER; 64];
        let mut parsed = httparse::Response::new(&mut slots);
        match parsed.parse(&buf) {
            Ok(httparse::Status::Complete(len)) => {
                let headers = parsed
                    .headers
                    .iter()
                    .map(|h| (h.name.to_owned(), h.value.to_vec()))
                    .collect::<Vec<_>>();
                break (parsed.code.unwrap_or(0), headers, len);
            }
            Ok(httparse::Status::Partial) if buf.len() < RESPONSE_LIMIT => {}
            _ => return Err(ConnectError::Transport(TransportFault::Closed)),
        }
    };
    let mut builder = Response::builder().status(status);
    for (name, value) in &headers {
        builder = builder.header(name.as_str(), value.as_slice());
    }
    let find = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| String::from_utf8_lossy(v).trim().to_owned())
    };
    let mut rest = buf.split_off(head_len);
    if status != 101 {
        let wanted = find("content-length").and_then(|v| v.parse::<usize>().ok());
        while wanted.is_none_or(|n| rest.len() < n) && rest.len() < RESPONSE_LIMIT {
            let mut chunk = [0u8; 8192];
            match io.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => rest.extend_from_slice(&chunk[..n]),
            }
        }
        let response = builder.body(Some(rest)).map_err(|_| ConnectError::Transport(TransportFault::Closed))?;
        return Err(ConnectError::Rejected(response));
    }
    let digest = ring::digest::digest(
        &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
    );
    // Node joins repeated header lines with ", " (`_http_incoming.js` `matchKnownFields`), and `ws` reads the joined value.
    let joined = |name: &str| {
        let values: Vec<String> = headers
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| String::from_utf8_lossy(v).trim().to_owned())
            .collect();
        (!values.is_empty()).then(|| values.join(", "))
    };
    let accepted = joined("sec-websocket-accept") == Some(base64::engine::general_purpose::STANDARD.encode(digest.as_ref()));
    // `ws/lib/websocket.js:965-967`; without a `Connection: upgrade` token Node's parser does not treat the 101 as an
    // upgrade at all and `ws` fails with "Unexpected server response: 101".
    let upgraded = joined("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
        && joined("connection").is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
    // No subprotocol is ever requested, so any answer is unsolicited (`websocket.js:979-985`).
    let unsolicited = joined("sec-websocket-protocol").is_some();
    let extension = Extension::parse(joined("sec-websocket-extensions").as_deref());
    let (true, true, false, Ok(extension)) = (accepted, upgraded, unsolicited, extension) else {
        return Err(ConnectError::Transport(TransportFault::Closed));
    };
    let response = builder.body(None).map_err(|_| ConnectError::Transport(TransportFault::Closed))?;
    rest.shrink_to_fit();
    Ok((response, rest, extension))
}

/// The upgrade of `request` over an already open `stream`, and the connection that follows. `connector` is the TLS
/// configuration of the handshake; `None` is tungstenite's default (the native roots).
async fn connect_over(
    request: tungstenite::handshake::client::Request,
    stream: Conn,
    schedule: &KeepaliveSchedule,
    tls: Option<Arc<rustls::ClientConfig>>,
) -> Result<(WsConnection, Response<Option<Vec<u8>>>), ConnectError> {
    let secure = request.uri().scheme_str() == Some("wss");
    let mut stream = if secure {
        let config = match tls {
            Some(config) => config,
            None => crate::netproxy::tunnel::tls_config().map_err(|e| ConnectError::Transport(fault_from_io(&e, true)))?,
        };
        let host = request.uri().host().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
        let name = rustls::pki_types::ServerName::try_from(host)
            .map_err(|_| ConnectError::Transport(TransportFault::Tls))?;
        let secured = tokio_rustls::TlsConnector::from(config)
            .connect(name, stream)
            .await
            .map_err(|_| ConnectError::Transport(TransportFault::Tls))?;
        MaybeTlsStream::Rustls(secured)
    } else {
        MaybeTlsStream::Plain(stream)
    };
    let (response, early, extension) = upgrade(&mut stream, &request).await?;
    let socket = WebSocketStream::from_raw_socket(
        WsIo::new(stream, early, extension),
        tungstenite::protocol::Role::Client,
        None,
    )
    .await;
    Ok((start(socket, schedule), response.map(|body| body)))
}

/// The connection's reader and writer over an upgraded `socket`.
fn start<S>(socket: Socket<S>, schedule: &KeepaliveSchedule) -> WsConnection
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let link = Arc::new(WsLink::new(*schedule));
    let (sink, stream) = socket.split();
    let (out_tx, out_rx) = mpsc::channel(QUEUE);
    let (in_tx, in_rx) = mpsc::channel(QUEUE);
    let (violation_tx, violation_rx) = tokio::sync::oneshot::channel();
    let (write_alive, read_alive) = (TaskAlive(link.clone()), TaskAlive(link.clone()));
    let writing = write_loop(sink, out_rx, in_tx.clone(), link.clone(), violation_rx);
    let writer = mixdog_rt::spawn("ai.ws.writer", TaskClass::Work, async move {
        let _alive = write_alive;
        writing.await;
    });
    let reading = read_loop(stream, out_tx.clone(), in_tx, link.clone(), writer.abort_handle(), violation_tx);
    let reader = mixdog_rt::spawn("ai.ws.reader", TaskClass::Work, async move {
        let _alive = read_alive;
        reading.await;
    });
    WsConnection {
        out: out_tx,
        inbound: in_rx,
        link: link.clone(),
        ended: false,
        _tasks: AbortOnDrop { writer: writer.abort_handle(), reader: reader.abort_handle(), link },
    }
}

impl WsConnection {
    pub fn link(&self) -> Arc<WsLink> {
        self.link.clone()
    }

    /// What ended the link, as `ws` reports it.
    pub fn ending(&self) -> Option<WsEnding> {
        locked(&self.link.ending).clone()
    }

    /// Closes the socket for good, as Node's pool shuts an entry down (`openai-ws-pool.mjs` `_shutdownEntry`):
    /// `socket.close(code, reason)`, then the socket is terminated [`TERMINATE_AFTER_CLOSE`] later unless the
    /// server's answer ended it first (`_scheduleForcedTerminate`, `WS_CLOSE_TERMINATE_MS`). Whoever held the
    /// connection lets go of it at once.
    pub fn close(self, code: u16, reason: &str) {
        self.closer().close(code, reason);
    }

    /// A client connection over `stream`, upgraded already, without compression.
    #[cfg(test)]
    pub(crate) async fn client_over(stream: tokio::io::DuplexStream) -> Self {
        let socket = WebSocketStream::from_raw_socket(WsIo::new(stream, Vec::new(), None), tungstenite::protocol::Role::Client, None).await;
        start(socket, &KeepaliveSchedule::SPEC)
    }

    /// What closes this connection while another holds it (the pool closing a scope's sockets in use).
    pub fn closer(&self) -> WsCloser {
        WsCloser { out: self.out.clone(), link: self.link.clone(), writer: self._tasks.writer.clone(), reader: self._tasks.reader.clone() }
    }

    /// Queues a frame. Waits only for room in this connection's own queue. A link that has ended refuses it, as `ws`
    /// refuses a send outside OPEN: every path that ends the link marks it before its error is published, so a send
    /// made after the caller heard of the end is never taken for sent.
    pub async fn send(&self, message: Message) -> Result<(), TransportFault> {
        if let Some(fault) = self.link.fault() {
            return Err(fault);
        }
        self.out
            .send(message)
            .await
            .map_err(|_| self.link.fault().unwrap_or(TransportFault::Closed))
    }

    /// The next data frame, or the one fault that ended the link, then `None`.
    /// Pings, pongs and the close handshake are handled here, never shown.
    pub async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        if self.ended {
            return None;
        }
        let item = self.inbound.recv().await;
        if !matches!(item, Some(Ok(_))) {
            self.ended = true;
        }
        item
    }
}

async fn read_loop<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: SplitStream<Socket<S>>,
    to_writer: mpsc::Sender<Message>,
    inbound: mpsc::Sender<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
    writer: AbortHandle,
    violation: tokio::sync::oneshot::Sender<tokio::time::Instant>,
) {
    let end = |fault: TransportFault| {
        link.mark_dead(fault.clone());
        writer.abort();
        fault
    };
    let mut quiet_since = Instant::now();
    let mut pong_deadline: Option<Instant> = None;
    loop {
        let ping = link.ping();
        let wake = pong_deadline.unwrap_or(quiet_since + ping.interval);
        tokio::select! {
            biased;
            item = stream.next() => {
                quiet_since = Instant::now();
                pong_deadline = None;
                let fault = match item {
                    None => TransportFault::Closed,
                    Some(Err(tungstenite::Error::Io(ref io))) if let Some(refused) = super::wsio::violation_of(io) => {
                        // `receiverOnError`: the error is emitted at once; the close frame `ws.close(code)` queued goes
                        // out behind it, and the writer finishes that close within ws's closeTimeout from now.
                        let fault = fault_from_io(io, false);
                        *locked(&link.ending) = Some(WsEnding::Violation { message: refused.text.clone(), code: refused.ws_code, close_code: refused.code });
                        link.closing.store(true, std::sync::atomic::Ordering::Release);
                        link.mark_dead(fault.clone());
                        let _ = violation.send(tokio::time::Instant::now());
                        let _ = inbound.send(Err(fault)).await;
                        return;
                    }
                    Some(Err(err)) => fault_from_ws_error(&err),
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = to_writer.try_send(Message::Pong(payload));
                        continue;
                    }
                    Some(Ok(Message::Pong(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(frame))) => {
                        // `ws` reports an empty close as 1005 (`receiver.js` `controlMessage`), with an empty reason.
                        let (code, reason) = frame.map_or((1005, String::new()), |frame| (u16::from(frame.code), frame.reason.as_str().to_owned()));
                        *locked(&link.ending) = Some(WsEnding::Close { code, reason });
                        let fault = TransportFault::WsClose { code: Some(code) };
                        // The consumer hears of the close at once. The writer lives on until tungstenite has written its
                        // echo of the close frame, which it does on the next read (ws echoes the code,
                        // `receiverOnConclude`); that read ends when the server closes the connection, or at
                        // ws's closeTimeout.
                        link.mark_dead(fault.clone());
                        let _ = inbound.send(Err(fault)).await;
                        let _ = tokio::time::timeout(CLOSE_FLUSH, stream.next()).await;
                        writer.abort();
                        return;
                    }
                    Some(Ok(data)) => {
                        if inbound.send(Ok(data)).await.is_err() {
                            writer.abort();
                            return;
                        }
                        continue;
                    }
                };
                let _ = inbound.send(Err(end(fault))).await;
                return;
            }
            _ = tokio::time::sleep_until(wake.into()) => {
                if pong_deadline.is_some() {
                    let fault = end(TransportFault::KeepaliveExpired {
                        transport: TransportKind::WebSocket,
                    });
                    let _ = inbound.send(Err(fault)).await;
                    return;
                }
                // A full writer queue does not stop the probe clock: the
                // deadline below still ends a peer that stopped reading.
                let _ = to_writer.try_send(Message::Ping(Default::default()));
                pong_deadline = Some(Instant::now() + ping.timeout);
            }
        }
    }
}

async fn write_loop<S: AsyncRead + AsyncWrite + Unpin>(
    mut sink: SplitSink<Socket<S>, Message>,
    mut queued: mpsc::Receiver<Message>,
    inbound: mpsc::Sender<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
    mut violation: tokio::sync::oneshot::Receiver<tokio::time::Instant>,
) {
    // The reader ends without a violation on every other path, and then aborts this task itself.
    let mut watching = true;
    loop {
        let message = tokio::select! {
            biased;
            at = &mut violation, if watching => match at {
                Ok(at) => break close_after_violation(sink, queued, at).await,
                Err(_) => {
                    watching = false;
                    continue;
                }
            },
            message = queued.recv() => message,
        };
        let Some(message) = message else {
            let _ = sink.close().await;
            return;
        };
        // A send can wait on a peer that does not read; a violation found meanwhile ends it and starts the close.
        let sent = tokio::select! {
            biased;
            at = &mut violation, if watching => match at {
                Ok(at) => break close_after_violation(sink, queued, at).await,
                // The reader is gone, and it aborts this task on its way out.
                Err(_) => return,
            },
            sent = sink.send(message) => sent,
        };
        if let Err(err) = sent {
            let fault = fault_from_ws_error(&err);
            link.mark_dead(fault.clone());
            let _ = inbound.send(Err(fault)).await;
            return;
        }
    }
}

/// The close a violation started (`WsIo`'s flush runs it), given up at ws's closeTimeout from `at`; the socket is
/// dropped then (`setCloseTimer`: `socket.destroy()`). Frames queued after the violation are refused.
async fn close_after_violation<S: AsyncRead + AsyncWrite + Unpin>(mut sink: SplitSink<Socket<S>, Message>, queued: mpsc::Receiver<Message>, at: tokio::time::Instant) {
    drop(queued);
    let _ = tokio::time::timeout_at(at + CLOSE_FLUSH, sink.flush()).await;
}
#[cfg(test)]
mod tests {
    use super::*;

    /// Runs [`upgrade`] against a server that answers with `answer(key)` (the lines after the status line).
    async fn upgrade_against(answer: impl Fn(&str) -> String + Send + 'static) -> Result<Option<Extension>, ConnectError> {
        let (mut near, mut far) = tokio::io::duplex(1 << 14);
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            let mut chunk = [0u8; 2048];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = far.read(&mut chunk).await.unwrap();
                seen.extend_from_slice(&chunk[..n]);
            }
            let text = String::from_utf8(seen).unwrap();
            let key = text.lines().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).unwrap().to_owned();
            far.write_all(answer(&key).as_bytes()).await.unwrap();
        });
        let request = "ws://example.test/".into_client_request().unwrap();
        let outcome = tokio::time::timeout(WITHIN, upgrade(&mut near, &request)).await.expect("the upgrade's outcome within 20 s").map(|(_, _, extension)| extension);
        tokio::time::timeout(WITHIN, server).await.expect("the server's answer within 20 s").unwrap();
        outcome
    }

    fn accept_of(key: &str) -> String {
        let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes());
        base64::engine::general_purpose::STANDARD.encode(digest.as_ref())
    }

    fn answer(key: &str, extra: &str) -> String {
        format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n{extra}\r\n", accept_of(key))
    }

    #[tokio::test]
    async fn a_plain_upgrade_is_accepted() {
        assert_eq!(upgrade_against(|k| answer(k, "")).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_101_without_a_connection_upgrade_token_is_refused() {
        let outcome = upgrade_against(|k| answer(k, "").replace("Connection: Upgrade\r\n", "Connection: keep-alive\r\n")).await;
        assert!(outcome.is_err());
        let outcome = upgrade_against(|k| answer(k, "").replace("Connection: Upgrade\r\n", "")).await;
        assert!(outcome.is_err());
        // A token among others is enough, in any case (`Connection: keep-alive, Upgrade`).
        let outcome = upgrade_against(|k| answer(k, "").replace("Connection: Upgrade\r\n", "connection: keep-alive, upgrade\r\n")).await;
        assert!(outcome.is_ok());
    }

    #[tokio::test]
    async fn an_unsolicited_subprotocol_is_refused() {
        let outcome = upgrade_against(|k| answer(k, "Sec-WebSocket-Protocol: chat\r\n")).await;
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn extension_lines_are_read_together() {
        // Two lines are one list to `ws`: the first configuration is used...
        let outcome = upgrade_against(|k| answer(k, "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=10\r\nSec-WebSocket-Extensions: permessage-deflate\r\n")).await;
        assert_eq!(outcome.unwrap().unwrap().client_max_window_bits, 10);
        // ...and a second line that is not the offered extension fails the handshake though the first is fine.
        let outcome = upgrade_against(|k| answer(k, "Sec-WebSocket-Extensions: permessage-deflate\r\nSec-WebSocket-Extensions: x-other\r\n")).await;
        assert!(outcome.is_err());
        // Conflicting repeated parameters are refused.
        let outcome = upgrade_against(|k| answer(k, "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=10; client_max_window_bits=11\r\n")).await;
        assert!(outcome.is_err());
    }

    const WITHIN: std::time::Duration = std::time::Duration::from_secs(20);

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The whole client frames at the start of `raw`, unmasked, in the shape of `ws-close-capture.mjs`; they are taken
    /// off `raw`.
    fn client_frames(raw: &mut Vec<u8>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        loop {
            if raw.len() < 2 {
                return out;
            }
            let masked = raw[1] & 0x80 != 0;
            let (length, head) = match raw[1] & 0x7f {
                126 if raw.len() >= 4 => (usize::from(u16::from_be_bytes([raw[2], raw[3]])), 4),
                127 if raw.len() >= 10 => (usize::try_from(u64::from_be_bytes(raw[2..10].try_into().unwrap())).unwrap(), 10),
                126 | 127 => return out,
                small => (usize::from(small), 2),
            };
            let total = head + if masked { 4 } else { 0 } + length;
            if raw.len() < total {
                return out;
            }
            let mut payload = raw[total - length..total].to_vec();
            if masked {
                let key = [raw[head], raw[head + 1], raw[head + 2], raw[head + 3]];
                payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= key[i % 4]);
            }
            let first = raw[0];
            out.push(serde_json::json!({ "kind": "frame", "fin": first & 0x80 != 0, "rsv": (first >> 4) & 7, "opcode": first & 15, "masked": masked, "hex": hex(&payload) }));
            raw.drain(..total);
        }
    }

    // W6, the close handshake, replayed against `ws`'s own (`ws-close-capture.mjs`, `fixtures/ws-close.json`): for each
    // close frame a server sends, the frames the client writes and its end of the TCP stream, in order. `ws` echoes the
    // code and the reason (`websocket.js` `receiverOnConclude`: `close(code, reason)`; none for an empty close), closes
    // with 1002 or 1007 alone on a close it refuses (`receiver.js` `controlMessage`), and ends its side as soon as its
    // close frame is out (`close`: `_closeFrameSent && _closeFrameReceived` → `socket.end()`). The server here ends its
    // side only after the client's, so the client's end is never an answer to the server's.
    #[tokio::test]
    async fn the_close_handshake_is_what_ws_writes_for_every_recorded_close() {
        mixdog_rt::testing::tokens();
        const RECORDING: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/ws-close.json"));
        const CAPTURE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/ws-close-capture.mjs"));
        let node: serde_json::Value = serde_json::from_str(RECORDING).unwrap();
        assert_eq!(node["manifest"]["exact"], true);
        assert_eq!(node["manifest"]["nodeCommit"], "b6f10295a");
        assert_eq!(node["manifest"]["harness"]["ws-close-capture.mjs"], hex(ring::digest::digest(&ring::digest::SHA256, CAPTURE).as_ref()), "ws-close-capture.mjs changed since the recording");
        let mut rust = Vec::new();
        let mut expected = Vec::new();
        for case in node["cases"].as_array().unwrap() {
            let close = case["frame"].as_str().unwrap();
            let close: Vec<u8> = (0..close.len()).step_by(2).map(|i| u8::from_str_radix(&close[i..i + 2], 16).unwrap()).collect();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0u8; 2048];
                let end = loop {
                    if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break at + 4;
                    }
                    let n = stream.read(&mut chunk).await.unwrap();
                    raw.extend_from_slice(&chunk[..n]);
                };
                let text = String::from_utf8_lossy(&raw[..end]).into_owned();
                raw.drain(..end);
                let key = text.lines().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).unwrap().to_owned();
                stream.write_all(answer(&key, "").as_bytes()).await.unwrap();
                stream.write_all(&close).await.unwrap();
                let mut events = client_frames(&mut raw);
                loop {
                    match stream.read(&mut chunk).await {
                        Ok(0) => {
                            events.push(serde_json::json!({ "kind": "end", "unread": hex(&raw) }));
                            break;
                        }
                        Ok(n) => {
                            raw.extend_from_slice(&chunk[..n]);
                            events.extend(client_frames(&mut raw));
                        }
                        Err(error) => {
                            events.push(serde_json::json!({ "kind": "reset", "error": error.to_string() }));
                            break;
                        }
                    }
                }
                let _ = stream.shutdown().await;
                events
            });
            let request = format!("ws://{addr}/").into_client_request().unwrap();
            let (mut connection, _) = tokio::time::timeout(WITHIN, connect(request, &KeepaliveSchedule::SPEC)).await.expect("the upgrade within 20 s").unwrap();
            // The connection is held: its end on the wire comes from the close handshake, not from a drop.
            let events = tokio::time::timeout(WITHIN, server).await.expect("the client ends its side within 20 s").unwrap();
            // What the owner hears, up to the first error or close: Node's stream handler acts on that one and ignores
            // the rest (`socket-handlers.mjs` `onError` / `onClose` finish the outcome; `if (outcome.done) return`),
            // which is ws's `close(1006, '')` after a receiver error.
            let mut heard = Vec::new();
            loop {
                match tokio::time::timeout(WITHIN, connection.recv()).await.expect("what the owner hears within 20 s") {
                    Some(Ok(Message::Text(text))) => heard.push(serde_json::json!({ "kind": "message", "binary": false, "hex": hex(text.as_bytes()) })),
                    Some(Ok(Message::Binary(data))) => heard.push(serde_json::json!({ "kind": "message", "binary": true, "hex": hex(&data) })),
                    Some(Ok(other)) => panic!("{other:?} is never shown"),
                    Some(Err(_)) => {
                        heard.push(match connection.ending().expect("an ending with the fault") {
                            WsEnding::Close { code, reason } => serde_json::json!({ "kind": "close", "code": code, "reason": reason }),
                            WsEnding::Violation { message, code, .. } => serde_json::json!({ "kind": "error", "message": message, "code": code }),
                        });
                        break;
                    }
                    None => panic!("the link ended without its fault"),
                }
            }
            drop(connection);
            let acted_on = case["heard"].as_array().unwrap();
            let first_end = acted_on.iter().position(|e| e["kind"] != "message").expect("ws ends with a close");
            if acted_on[first_end]["kind"] == "error" {
                assert_eq!(acted_on[first_end + 1..], [serde_json::json!({ "kind": "close", "code": 1006, "reason": "" })], "{}", case["name"]);
            }
            let node_heard = serde_json::Value::Array(acted_on[..=first_end].to_vec());
            rust.push(serde_json::json!({ "name": case["name"], "frame": case["frame"], "events": events, "heard": heard }));
            expected.push(serde_json::json!({ "name": case["name"], "frame": case["frame"], "events": case["events"], "heard": node_heard }));
        }
        assert_eq!(rust, expected);
    }

    // W3, against a peer that never reads: `ws` emits the receiver's error at once (`receiverOnError`), and the socket
    // its close frame cannot leave on is destroyed `closeTimeout` after `close()` (`setCloseTimer`; 30 000 ms,
    // `constants.js` CLOSE_TIMEOUT), though its owner let go of the connection at once. On the paused clock: the error
    // with no time passed, the socket there until the deadline and gone at it.
    #[tokio::test(start_paused = true)]
    async fn a_violation_is_reported_at_once_and_its_close_ends_the_socket_at_ws_close_timeout() {
        mixdog_rt::testing::tokens();
        let (near, mut far) = tokio::io::duplex(4); // four bytes each way: the eight byte close frame does not fit
        let socket = WebSocketStream::from_raw_socket(WsIo::new(near, Vec::new(), Some(Extension::default())), tungstenite::protocol::Role::Client, None).await;
        let mut connection = start(socket, &KeepaliveSchedule::SPEC);
        let begin = tokio::time::Instant::now();
        far.write_all(&[0xa1, 0x01, b'x']).await.unwrap(); // RSV2: 1002
        let got = tokio::time::timeout(WITHIN, connection.recv()).await.expect("the error within 20 s");
        assert!(matches!(got, Some(Err(_))), "{got:?}");
        assert_eq!(begin.elapsed(), std::time::Duration::ZERO, "the error comes at once, not after the close");
        assert_eq!(
            connection.ending(),
            Some(WsEnding::Violation { message: "Invalid WebSocket frame: RSV2 and RSV3 must be clear".into(), code: "WS_ERR_UNEXPECTED_RSV_2_3", close_code: 1002 })
        );
        drop(connection);
        // More than the four bytes the pipe toward the client holds: the client reads nothing while its close is stuck,
        // so this write can only end by failing, when the socket is gone.
        let probe = far.write_all(&[0u8; 5]);
        let gone = tokio::time::timeout(CLOSE_FLUSH + WITHIN, probe).await.expect("the socket gone within 50 s");
        assert!(gone.is_err(), "the write failed because the socket was dropped");
        assert_eq!(begin.elapsed(), CLOSE_FLUSH, "gone at ws's closeTimeout");
        let mut seen = Vec::new();
        tokio::time::timeout(WITHIN, far.read_to_end(&mut seen)).await.expect("what was written within 20 s").unwrap();
        assert_eq!(&seen[..2], [0x88, 0x82], "the close frame was on its way: {seen:02x?}");
        assert_eq!(seen.len(), 4, "only what the pipe could take before the socket went");
    }

    // P2 (recheck): a send made after the caller heard of a violation is refused, though the writer has not yet run
    // (`ws` sets CLOSING in `close()` before it emits the error, and `send` outside OPEN fails). The writer is held: its
    // queue is open with room, and nothing reads it.
    #[tokio::test]
    async fn a_send_after_a_violation_is_refused_while_the_writer_is_held() {
        mixdog_rt::testing::tokens();
        let (near, mut far) = tokio::io::duplex(1 << 10);
        let socket = WebSocketStream::from_raw_socket(WsIo::new(near, Vec::new(), Some(Extension::default())), tungstenite::protocol::Role::Client, None).await;
        let (_sink, stream) = socket.split();
        let link = Arc::new(WsLink::new(KeepaliveSchedule::SPEC));
        let (out_tx, mut out_rx) = mpsc::channel(QUEUE);
        let (in_tx, in_rx) = mpsc::channel(QUEUE);
        let (violation_tx, _violation_rx) = tokio::sync::oneshot::channel();
        let held_writer = tokio::spawn(std::future::pending::<()>());
        let reader = tokio::spawn(read_loop(stream, out_tx.clone(), in_tx, link.clone(), held_writer.abort_handle(), violation_tx));
        let mut connection = WsConnection {
            out: out_tx,
            inbound: in_rx,
            link: link.clone(),
            ended: false,
            _tasks: AbortOnDrop { writer: held_writer.abort_handle(), reader: reader.abort_handle(), link },
        };
        far.write_all(&[0xa1, 0x01, b'x']).await.unwrap(); // RSV2: 1002
        let got = tokio::time::timeout(WITHIN, connection.recv()).await.expect("the error within 20 s");
        assert!(matches!(got, Some(Err(_))), "{got:?}");
        let sent = tokio::time::timeout(WITHIN, connection.send(Message::text("after"))).await.expect("the send's outcome within 20 s");
        assert!(sent.is_err(), "a send after the violation is refused, not queued: {sent:?}");
        assert!(out_rx.try_recv().is_err(), "nothing was queued for the writer");
    }

    // W6, the nonce: `Sec-WebSocket-Key` is 16 bytes from a cryptographically secure generator (tungstenite's
    // `generate_key` draws from `rand`'s OS-seeded ChaCha generator; `ws` uses `crypto.randomBytes(16)`), a fresh one
    // for every upgrade.
    #[tokio::test]
    async fn every_upgrade_carries_a_fresh_sixteen_byte_key() {
        let keys = Arc::new(Mutex::new(Vec::<String>::new()));
        for _ in 0..3 {
            let seen = keys.clone();
            let _ = upgrade_against(move |key| {
                seen.lock().unwrap().push(key.to_owned());
                answer(key, "")
            })
            .await;
        }
        let keys = keys.lock().unwrap();
        for key in keys.iter() {
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(key).unwrap().len(), 16);
        }
        assert!(keys[0] != keys[1] && keys[1] != keys[2] && keys[0] != keys[2], "{keys:?}");
    }
}