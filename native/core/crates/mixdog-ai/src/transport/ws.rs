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

use super::wsio::Extension;
use super::wsio::WsIo;
use super::fault::fault_from_io;
use super::fault::fault_from_ws_error;
use super::tcp;

pub use tokio_tungstenite::tungstenite::Message;

type Socket = WebSocketStream<WsIo<MaybeTlsStream<Conn>>>;

/// Frames queued toward the socket and the consumer.
const QUEUE: usize = 64;

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

/// Liveness and age of one WebSocket connection, shared with its tasks.
pub struct WsLink {
    opened: Instant,
    schedule: Mutex<KeepaliveSchedule>,
    dead: Mutex<Option<TransportFault>>,
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
        }
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

struct AbortOnDrop([AbortHandle; 2]);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        for handle in &self.0 {
            handle.abort();
        }
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
    let link = Arc::new(WsLink::new(*schedule));
    let (sink, stream) = socket.split();
    let (out_tx, out_rx) = mpsc::channel(QUEUE);
    let (in_tx, in_rx) = mpsc::channel(QUEUE);
    let writer = mixdog_rt::spawn(
        "ai.ws.writer",
        TaskClass::Work,
        write_loop(sink, out_rx, in_tx.clone(), link.clone()),
    );
    let reader = mixdog_rt::spawn(
        "ai.ws.reader",
        TaskClass::Work,
        read_loop(stream, out_tx.clone(), in_tx, link.clone(), writer.abort_handle()),
    );
    let connection = WsConnection {
        out: out_tx,
        inbound: in_rx,
        link,
        ended: false,
        _tasks: AbortOnDrop([writer.abort_handle(), reader.abort_handle()]),
    };
    Ok((connection, response.map(|body| body)))
}

impl WsConnection {
    pub fn link(&self) -> Arc<WsLink> {
        self.link.clone()
    }

    /// Queues a frame. Waits only for room in this connection's own queue.
    pub async fn send(&self, message: Message) -> Result<(), TransportFault> {
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

async fn read_loop(
    mut stream: SplitStream<Socket>,
    to_writer: mpsc::Sender<Message>,
    inbound: mpsc::Sender<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
    writer: AbortHandle,
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
                    Some(Err(err)) => fault_from_ws_error(&err),
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = to_writer.try_send(Message::Pong(payload));
                        continue;
                    }
                    Some(Ok(Message::Pong(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(frame))) => TransportFault::WsClose {
                        code: frame.map(|frame| u16::from(frame.code)),
                    },
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

async fn write_loop(
    mut sink: SplitSink<Socket, Message>,
    mut queued: mpsc::Receiver<Message>,
    inbound: mpsc::Sender<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
) {
    while let Some(message) = queued.recv().await {
        if let Err(err) = sink.send(message).await {
            let fault = fault_from_ws_error(&err);
            link.mark_dead(fault.clone());
            let _ = inbound.send(Err(fault)).await;
            return;
        }
    }
    let _ = sink.close().await;
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
        let outcome = upgrade(&mut near, &request).await.map(|(_, _, extension)| extension);
        server.await.unwrap();
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
}
