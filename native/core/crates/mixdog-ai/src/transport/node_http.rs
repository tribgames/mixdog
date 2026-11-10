//! The HTTP client of every non-streaming-request provider call, written to put on the wire what Node puts there:
//! the global `fetch` of Node 22 (undici 6.21 for the headers it adds, `http-agent.mjs`' undici 8 `Agent` for the
//! bytes it writes) over a kept-alive connection pool. The head is written by hand because no HTTP library keeps a
//! header's letter case (`h1` says what hyper cannot do); the response is read by `hyper`'s connection client.
//!
//! What Node writes, in this order (`client-h1.js` `writeH1`): the request line, `host`, `connection`, the headers
//! `fetch` hands over (the caller's, in the caller's order and letter case, then `accept`, `accept-language`,
//! `sec-fetch-mode`, `user-agent` and `accept-encoding` where the caller set none: `fetch/index.js` 10478, 4143,
//! 10888, 10908), and `content-length` last. A raw `undici.request` (the preconnect) adds none of the `fetch` headers.

mod decode;
mod h1;
mod pool;

/// The most one part of a decoded body holds.
pub use decode::STEP as DECODED_STEP;

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::TcpKeepalive;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;

use crate::netproxy::NetworkProxy;
use crate::netproxy::Subscription;
use crate::netproxy::tunnel::TunnelError;
use crate::netproxy::tunnel::open_proxy_tunnel;
use crate::netproxy::tunnel::tls_code;

use super::fault::fault_from_io;
use super::link::BodyStream;
use super::link::HttpResponse;
use super::link::Surface;
use super::tcp;
use decode::Decoder;
use h1::BODY_TIMEOUT;
use h1::H1Body;
use h1::Reuse;
use pool::Pool;
use pool::Taken;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type Stream = Box<dyn Io>;

/// The ALPN list undici offers (`connect.js:98`, `['http/1.1', 'h2']`).
pub const ALPN: [&[u8]; 2] = [b"http/1.1", b"h2"];
/// `keepAliveTimeout` (`http-agent.mjs` `llmAgentOptions`), `keepAliveMaxTimeout`, and undici's
/// `keepAliveTimeoutThreshold` (`client.js`, 2 s) taken off a server's `keep-alive: timeout=` hint.
const KEEP_ALIVE: Duration = Duration::from_secs(60);
const KEEP_ALIVE_MAX: Duration = Duration::from_secs(90);
const KEEP_ALIVE_THRESHOLD: Duration = Duration::from_secs(2);
/// undici's connector timeout for the TCP and TLS handshakes (`connect.js` `timeout`, 10 s), and the agent's
/// `headersTimeout` (`http-agent.mjs`, 600 s); the body's is [`BODY_TIMEOUT`].
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HEADERS_TIMEOUT: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------

/// Which Node client wrote the request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writer {
    /// The global `fetch`: it adds its own headers.
    Fetch,
    /// `undici.request`: the headers as given.
    Raw,
}

/// The header list `fetch` hands to the dispatcher, and whether the caller asked to close the connection. Duplicate
/// names are combined with `, ` at the first one's place (the `Headers` list); `host`, `content-length` and
/// `connection` are the dispatcher's (`core/request.js` `processHeader`).
pub fn fetch_headers(caller: &[(String, String)], https: bool) -> (Vec<(String, String)>, bool) {
    let mut list: Vec<(String, String)> = Vec::new();
    let mut close = false;
    for (name, value) in caller {
        let value = value.trim_matches([' ', '\t']).to_owned();
        match name.to_ascii_lowercase().as_str() {
            "host" | "content-length" => continue,
            "connection" => {
                close |= value.to_ascii_lowercase().split(',').any(|token| token.trim() == "close");
                continue;
            }
            _ => {}
        }
        match list.iter_mut().find(|(known, _)| known.eq_ignore_ascii_case(name)) {
            Some((_, kept)) => {
                kept.push_str(", ");
                kept.push_str(&value);
            }
            None => list.push((name.clone(), value)),
        }
    }
    let has = |list: &[(String, String)], name: &str| list.iter().any(|(known, _)| known.eq_ignore_ascii_case(name));
    if !has(&list, "accept") {
        list.push(("accept".into(), "*/*".into()));
    }
    if !has(&list, "accept-language") {
        list.push(("accept-language".into(), "*".into()));
    }
    match list.iter_mut().find(|(known, _)| known.eq_ignore_ascii_case("sec-fetch-mode")) {
        Some((_, value)) => *value = "cors".into(),
        None => list.push(("sec-fetch-mode".into(), "cors".into())),
    }
    if !has(&list, "user-agent") {
        list.push(("user-agent".into(), "node".into()));
    }
    if has(&list, "range") {
        list.push(("accept-encoding".into(), "identity".into()));
    }
    if !has(&list, "accept-encoding") {
        list.push(("accept-encoding".into(), if https { "br, gzip, deflate" } else { "gzip, deflate" }.into()));
    }
    (list, close)
}

/// `writeH1`'s bytes: the head of `request` for `url`, and whether the connection ends with this exchange.
pub fn head(request: &WireRequest, url: &url::Url, writer: Writer) -> (Vec<u8>, bool) {
    let (headers, mut close) = match writer {
        Writer::Fetch => fetch_headers(&request.headers, url.scheme() == "https"),
        Writer::Raw => {
            let mut close = false;
            let kept = request
                .headers
                .iter()
                .filter(|(name, value)| {
                    if name.eq_ignore_ascii_case("connection") {
                        close |= value.to_ascii_lowercase().contains("close");
                        return false;
                    }
                    !name.eq_ignore_ascii_case("host") && !name.eq_ignore_ascii_case("content-length")
                })
                .cloned()
                .collect();
            (kept, close)
        }
    };
    // `HEAD` ends its connection (`socket[kReset] = true`, `client-h1.js:1312`).
    close |= request.method == "HEAD";
    let mut target = url.path().to_owned();
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    let authority = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };
    let text = format!(
        "{} {target} HTTP/1.1\r\nhost: {authority}\r\nconnection: {}\r\n",
        request.method,
        if close { "close" } else { "keep-alive" }
    );
    // Node writes a header's value as Latin-1 (`check_headers` admits nothing above U+00FF).
    let mut bytes = text.into_bytes();
    for (name, value) in &headers {
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(b": ");
        bytes.extend(value.chars().map(|c| c as u8));
        bytes.extend_from_slice(b"\r\n");
    }
    let expects_payload = matches!(request.method.as_str(), "POST" | "PUT" | "PATCH");
    if !request.body.is_empty() || expects_payload {
        bytes.extend_from_slice(format!("content-length: {}\r\n", request.body.len()).as_bytes());
    }
    bytes.extend_from_slice(b"\r\n");
    (bytes, close)
}

// ---------------------------------------------------------------------------
// What undici refuses to send
// ---------------------------------------------------------------------------

/// `core/request.js` `processHeader`: the names and values the dispatcher accepts. Nothing is written for a request
/// that fails here; a CR, LF or NUL cannot reach the socket, and the headers undici owns (`transfer-encoding`,
/// `keep-alive`, `upgrade`, `expect`) are not the caller's.
pub fn check_headers(headers: &[(String, String)]) -> Result<(), String> {
    let token = |name: &str| !name.is_empty() && hyper::header::HeaderName::from_bytes(name.as_bytes()).is_ok();
    let (mut host, mut length) = (false, false);
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if !token(&lower) {
            return Err("invalid header key".into());
        }
        // `isValidHeaderValue`: tab, printable ASCII and Latin-1; Node writes the value as Latin-1.
        if value.chars().any(|c| !(c == '\t' || ('\u{20}'..='\u{7e}').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c))) {
            return Err(format!("invalid {name} header"));
        }
        match lower.as_str() {
            "host" => {
                if std::mem::replace(&mut host, true) {
                    return Err("duplicate host header".into());
                }
            }
            "content-length" => {
                if std::mem::replace(&mut length, true) {
                    return Err("duplicate content-length header".into());
                }
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("invalid content-length header".into());
                }
            }
            "transfer-encoding" | "keep-alive" | "upgrade" => return Err(format!("invalid {lower} header")),
            "expect" => return Err("expect header not supported".into()),
            "connection" => {
                if !value.to_ascii_lowercase().split(',').all(|part| token(part.trim())) {
                    return Err("invalid connection header".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/// A failed exchange. `replay` says that no byte of the request reached the server whole, so it may be sent again on
/// another connection: the connection was gone before the write, or the write itself failed, or the server refused
/// the stream (`REFUSED_STREAM`). A request the server may have executed is never replayed.
struct Failure {
    error: ProviderError,
    replay: bool,
}

/// Test pinning: every connect goes to `addr` and trusts `tls` alone. Compiled for tests and the `test-support` feature only.
#[cfg(any(test, feature = "test-support"))]
pub struct Pinned {
    pub addr: SocketAddr,
    pub tls: Arc<rustls::ClientConfig>,
}

pub struct NodeClient {
    tcp: TcpKeepalive,
    policy: Option<Arc<NetworkProxy>>,
    #[cfg(any(test, feature = "test-support"))]
    pinned: Option<Pinned>,
    pool: Arc<Pool>,
    /// A change of the network proxy setting closes every idle connection (`http-agent.mjs` `onProxyRouteChange`).
    _retire: Option<Subscription>,
}

fn tls_config() -> Result<Arc<rustls::ClientConfig>, io::Error> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut config = (*crate::netproxy::tunnel::tls_config().map_err(|e| e.to_string())?).clone();
            config.alpn_protocols = ALPN.iter().map(|p| p.to_vec()).collect();
            Ok(Arc::new(config))
        })
        .clone()
        .map_err(io::Error::other)
}

fn tunnel_error(err: TunnelError, surface: Surface) -> ProviderError {
    let (fault, code, message) = match err {
        TunnelError::Dns => (Some(TransportFault::Dns), None, "dns".to_owned()),
        TunnelError::Connect(io) => (Some(fault_from_io(&io, true)), None, io.to_string()),
        TunnelError::Io(io) => (Some(fault_from_io(&io, false)), None, io.to_string()),
        TunnelError::Tls(failure) => (None, Some(tls_code(&failure).to_owned()), failure.error.to_string()),
        TunnelError::Dropped(io) => (None, Some("UND_ERR_SOCKET".to_owned()), io.to_string()),
        TunnelError::TimedOut => (None, Some("UND_ERR_HEADERS_TIMEOUT".to_owned()), "proxy timed out".to_owned()),
        refused @ TunnelError::Refused { .. } => {
            (None, Some(refused.socket_code().unwrap_or("EPROXY").to_owned()), refused.to_string())
        }
    };
    let mut error = match fault {
        Some(fault) => ProviderError::transport(fault, DeliveryState::NotSent),
        None => ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent),
    };
    error.code = code;
    error.message = surface.text(|| message);
    error
}

fn dns_error(surface: Surface) -> ProviderError {
    let mut error = ProviderError::transport(TransportFault::Dns, DeliveryState::NotSent);
    error.message = surface.text(|| format!("{:?}", TransportFault::Dns));
    error
}

fn io_error(err: &io::Error, connecting: bool, delivery: DeliveryState, surface: Surface) -> ProviderError {
    let fault = fault_from_io(err, connecting);
    let message = surface.text(|| format!("{fault:?}"));
    let mut error = ProviderError::transport(fault, delivery);
    error.message = message;
    error
}

fn chain_error(err: &(dyn std::error::Error + 'static), delivery: DeliveryState, surface: Surface) -> ProviderError {
    let fault = super::fault::fault_from_chain(err, false);
    let message = surface.text(|| format!("{fault:?}"));
    let mut error = ProviderError::transport(fault, delivery);
    error.message = message;
    error
}

/// undici's own timeouts (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`): they carry a code and no fault.
fn timed_out(code: &str, text: &str, delivery: DeliveryState, surface: Surface) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, delivery);
    error.code = Some(code.to_owned());
    error.message = surface.text(|| text.to_owned());
    error
}

fn refused(text: String, surface: Surface) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = surface.text(|| text);
    error
}

/// A method `fetch` refuses: its `Request` constructor throws the `TypeError` itself, before any network, so its text is
/// not the `fetch failed` of a network error. The SDK wraps whatever its fetch throws in its own connection error.
fn refused_method(text: String, surface: Surface) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = if surface == Surface::Sdk { surface.text(|| text) } else { text };
    error
}

/// The method written for `method`. `fetch` (`fetch/request.js` of the bundled undici of the runtime the product runs
/// its core under, Electron 43.8.4's Node 24.22.1 with undici 7.30.1; recorded in `parity/fixtures/node-methods.json`)
/// first converts the method as a WebIDL `ByteString` (a character above U+00FF is refused with its UTF-16 index),
/// refuses one that is no token, refuses `CONNECT`, `TRACE` and `TRACK` in any letter case, and writes `DELETE`, `GET`,
/// `HEAD`, `OPTIONS`, `POST` and `PUT` in upper case however they were given, any other (`patch`, `query`) as given.
/// `undici.request` writes the method as given; a `CONNECT` is refused there too, since hyper would read its answer as
/// a tunnel's.
fn request_method(method: &str, writer: Writer) -> Result<String, String> {
    if writer == Writer::Fetch
        && let Some((index, unit)) = method.encode_utf16().enumerate().find(|(_, unit)| *unit > 0xff)
    {
        return Err(format!("Cannot convert argument to a ByteString because the character at index {index} has a value of {unit} which is greater than 255."));
    }
    if hyper::Method::from_bytes(method.as_bytes()).is_err() {
        return Err(format!("'{method}' is not a valid HTTP method."));
    }
    let upper = method.to_ascii_uppercase();
    if matches!(upper.as_str(), "CONNECT" | "TRACE" | "TRACK") {
        return Err(format!("'{method}' HTTP method is unsupported."));
    }
    let normalized = writer == Writer::Fetch && matches!(upper.as_str(), "DELETE" | "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT");
    Ok(if normalized { upper } else { method.to_owned() })
}

impl NodeClient {
    pub fn new(tcp: TcpKeepalive, policy: Option<Arc<NetworkProxy>>) -> Self {
        let pool = Arc::new(Pool::default());
        let retire = policy.as_ref().map(|policy| {
            let weak = Arc::downgrade(&pool);
            policy.on_change(Arc::new(move |_| {
                if let Some(pool) = weak.upgrade() {
                    pool.clear();
                }
            }))
        });
        Self {
            tcp,
            policy,
            #[cfg(any(test, feature = "test-support"))]
            pinned: None,
            pool,
            _retire: retire,
        }
    }

    /// Every connect goes to `addr` and trusts `tls` alone.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pinned(tcp: TcpKeepalive, pinned: Pinned) -> Self {
        Self { pinned: Some(pinned), ..Self::new(tcp, None) }
    }

    /// The address every connect goes to, when a test pinned it.
    #[cfg(any(test, feature = "test-support"))]
    fn pinned_addr(&self) -> Option<SocketAddr> {
        self.pinned.as_ref().map(|pinned| pinned.addr)
    }

    #[cfg(not(any(test, feature = "test-support")))]
    fn pinned_addr(&self) -> Option<SocketAddr> {
        None
    }

    /// The TLS configuration a test pinned, which trusts its own certificate alone.
    #[cfg(any(test, feature = "test-support"))]
    fn pinned_tls(&self) -> Option<Arc<rustls::ClientConfig>> {
        self.pinned.as_ref().map(|pinned| pinned.tls.clone())
    }

    #[cfg(not(any(test, feature = "test-support")))]
    fn pinned_tls(&self) -> Option<Arc<rustls::ClientConfig>> {
        None
    }
    /// The proxy the request goes through, decided before any pooled connection is looked at.
    async fn route(&self, url: &url::Url) -> Result<Option<String>, ProviderError> {
        if self.pinned_addr().is_some() {
            return Ok(None);
        }
        match &self.policy {
            Some(policy) => policy.route_for_url(url.as_str()).await.map(|route| route.proxy).map_err(|e| {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = e.to_string();
                error
            }),
            None => Ok(None),
        }
    }

    /// Everything that routes: the epoch of the proxy setting, the proxy, the origin.
    fn key(&self, url: &url::Url, proxy: &Option<String>) -> String {
        let epoch = self.policy.as_ref().map_or(0, |policy| policy.epoch());
        let https = url.scheme() == "https";
        let port = url.port_or_known_default().unwrap_or(if https { 443 } else { 80 });
        format!("{epoch}|{}|{}://{}:{port}", proxy.as_deref().unwrap_or(""), url.scheme(), url.host_str().unwrap_or_default())
    }

    async fn dial(&self, url: &url::Url, proxy: &Option<String>, surface: Surface) -> Result<(Stream, bool), ProviderError> {
        let host = url.host_str().unwrap_or_default().to_owned();
        let bare = host.trim_start_matches('[').trim_end_matches(']').to_owned();
        let https = url.scheme() == "https";
        let port = url.port_or_known_default().unwrap_or(if https { 443 } else { 80 });
        let tcp_stream: Stream = if let Some(addr) = self.pinned_addr() {
            let socket = tcp::connect(addr, &self.tcp).await.map_err(|e| io_error(&e, true, DeliveryState::NotSent, surface))?;
            Box::new(socket)
        } else {
            match proxy {
                Some(proxy) => Box::new(
                    open_proxy_tunnel(proxy, &bare, port, &self.tcp).await.map_err(|e| tunnel_error(e, surface))?,
                ),
                None => {
                    let addrs = tokio::net::lookup_host((bare.as_str(), port))
                        .await
                        .map_err(|_| dns_error(surface))?;
                    let mut failure = None;
                    let mut connected = None;
                    for addr in addrs {
                        match tcp::connect(addr, &self.tcp).await {
                            Ok(socket) => {
                                connected = Some(socket);
                                break;
                            }
                            Err(e) => failure = Some(e),
                        }
                    }
                    match connected {
                        Some(socket) => Box::new(socket),
                        None => {
                            return Err(failure.map_or_else(
                                || dns_error(surface),
                                |e| io_error(&e, true, DeliveryState::NotSent, surface),
                            ));
                        }
                    }
                }
            }
        };
        if !https {
            return Ok((tcp_stream, false));
        }
        let config = match self.pinned_tls() {
            Some(config) => config,
            None => tls_config().map_err(|e| io_error(&e, true, DeliveryState::NotSent, surface))?,
        };
        let name = rustls::pki_types::ServerName::try_from(bare)
            .map_err(|_| ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent))?;
        let tls = tokio_rustls::TlsConnector::from(config).connect(name, tcp_stream).await.map_err(|e| {
            let mut error = ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent);
            error.message = surface.text(|| e.to_string());
            error
        })?;
        let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
        Ok((Box::new(tls), h2))
    }

    /// One request, no redirects. A request that provably did not leave whole on a reused connection is sent again
    /// on another one, once; one the server may have executed is not.
    pub async fn send(&self, request: &WireRequest, writer: Writer, surface: Surface) -> Result<HttpResponse, ProviderError> {
        let url = url::Url::parse(&request.url).map_err(|e| refused(e.to_string(), surface))?;
        check_headers(&request.headers).map_err(|text| refused(text, surface))?;
        let method = request_method(&request.method, writer).map_err(|text| refused_method(text, surface))?;
        let normalized;
        let request = if method == request.method {
            request
        } else {
            normalized = WireRequest { method, ..request.clone() };
            &normalized
        };
        // Read before the route is decided: a route change from here on retires what this request dials.
        let generation = self.pool.generation();
        let proxy = self.route(&url).await?;
        let key = self.key(&url, &proxy);
        let mut replayed = false;
        loop {
            let reused = self.pool.take(&key).await;
            let was_reused = reused.is_some();
            let outcome = match reused {
                Some(Taken::H1(conn)) => self.exchange_h1(conn, &key, request, &url, writer, surface).await,
                Some(Taken::H2 { id, send, guard }) => self.exchange_h2(&key, id, send, guard, request, &url, writer, surface).await,
                None => {
                    #[cfg(test)]
                    self.pool.at(pool::At::Dial);
                    let dialled = tokio::time::timeout(CONNECT_TIMEOUT, self.dial(&url, &proxy, surface))
                        .await
                        .map_err(|_| timed_out("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error", DeliveryState::NotSent, surface))??;
                    let (io, h2) = dialled;
                    if h2 {
                        let (send, connection) = h2::client::handshake(io).await.map_err(|e| {
                            let mut error = ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent);
                            error.message = surface.text(|| e.to_string());
                            error
                        })?;
                        let id = self.pool.birth();
                        let (pool, origin) = (self.pool.clone(), key.clone());
                        tokio::spawn(async move {
                            // A failure reaches every request on the connection through h2; this one is for the idle
                            // connection, which has none to tell.
                            if let Err(error) = connection.await {
                                tracing::debug!(%error, "http/2 connection ended with an error");
                            }
                            pool.remove_h2(&origin, id);
                        });
                        let guard = self.pool.put_h2(key.clone(), id, send.clone(), generation);
                        self.exchange_h2(&key, id, send, guard, request, &url, writer, surface).await
                    } else {
                        let conn = h1::Conn::open(io, self.pool.birth(), generation)
                            .await
                            .map_err(|e| chain_error(&e, DeliveryState::NotSent, surface))?;
                        self.exchange_h1(conn, &key, request, &url, writer, surface).await
                    }
                }
            };
            match outcome {
                Err(failure) if was_reused && failure.replay && !replayed => replayed = true,
                Err(failure) => return Err(failure.error),
                Ok(response) => return Ok(response),
            }
        }
    }

    async fn exchange_h1(
        &self,
        mut conn: h1::Conn,
        key: &str,
        request: &WireRequest,
        url: &url::Url,
        writer: Writer,
        surface: Surface,
    ) -> Result<HttpResponse, Failure> {
        let (head, close) = head(request, url, writer);
        conn.ready()
            .await
            .map_err(|e| Failure { error: chain_error(&e, DeliveryState::NotSent, surface), replay: true })?;
        // Once the first byte may have left, the request is never sent again: undici fails the request that was running
        // when its socket dies (`client-h1.js` `onHttpSocketClose`) and re-queues only those not yet written. A write
        // error, wherever in the head, the body or the final flush, is therefore the request's error.
        let answered = tokio::time::timeout(HEADERS_TIMEOUT, conn.exchange(&head, &request.body, &request.method, close)).await;
        let (response, written) = match answered {
            Err(_) => {
                let error = timed_out("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error", DeliveryState::Ambiguous, surface);
                return Err(Failure { error, replay: false });
            }
            Ok(h1::Exchange::NotWritten(e)) => return Err(Failure { error: io_error(&e, false, DeliveryState::Ambiguous, surface), replay: false }),
            Ok(h1::Exchange::Unanswered(e)) => return Err(Failure { error: chain_error(&e, DeliveryState::Ambiguous, surface), replay: false }),
            Ok(h1::Exchange::Answered { response, written }) => (response, written),
        };
        let (parts, incoming) = response.into_parts();
        // llhttp refuses a response that frames its body twice (`HPE_UNEXPECTED_CONTENT_LENGTH`); hyper would read it
        // as chunked and keep the connection.
        if parts.headers.contains_key(hyper::header::TRANSFER_ENCODING) && parts.headers.contains_key(hyper::header::CONTENT_LENGTH) {
            let framing = io::Error::new(io::ErrorKind::InvalidData, "Content-Length can't be present with Transfer-Encoding");
            return Err(Failure { error: io_error(&framing, false, DeliveryState::Ambiguous, surface), replay: false });
        }
        let status = parts.status.as_u16();
        let headers: Vec<(String, String)> = parts
            .headers
            .iter()
            .map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned()))
            .collect();
        let find = |name: &str| headers.iter().find(|(known, _)| known == name).map(|(_, value)| value.as_str());
        let tokens = |name: &str| find(name).map(str::to_ascii_lowercase).unwrap_or_default();
        let (connection, old) = (tokens("connection"), parts.version == hyper::Version::HTTP_10);
        let server_closes = connection.split(',').any(|t| t.trim() == "close") || (old && !connection.contains("keep-alive"));
        // `keep-alive: timeout=N` (`client-h1.js` `onHeadersComplete`): the hint less the threshold, at most the maximum.
        let hint = find("keep-alive")
            .and_then(|v| v.split(',').find_map(|part| part.trim().strip_prefix("timeout=")?.trim().parse::<u64>().ok()))
            .map(Duration::from_secs);
        let ttl = hint.map_or(KEEP_ALIVE, |h| h.saturating_sub(KEEP_ALIVE_THRESHOLD).min(KEEP_ALIVE_MAX));
        let bodiless = request.method == "HEAD" || matches!(status, 204 | 304);
        let decoder = if bodiless { None } else { Decoder::of(find("content-encoding")) };
        let reuse = (!close && !server_closes && written).then(|| Reuse { pool: self.pool.clone(), key: key.to_owned(), ttl });
        Ok(HttpResponse { status, headers, body: Box::new(H1Body::new(incoming, conn, decoder, reuse)) })
    }

    #[allow(clippy::too_many_arguments, reason = "one exchange's connection, request and surface")]
    async fn exchange_h2(
        &self,
        key: &str,
        id: u64,
        send: h2::client::SendRequest<Bytes>,
        // The connection is idle again when this stream and every other has ended (`H2Body` holds the guard).
        guard: pool::H2Guard,
        request: &WireRequest,
        url: &url::Url,
        writer: Writer,
        surface: Surface,
    ) -> Result<HttpResponse, Failure> {
        // A connection that errs is no longer offered to the next request.
        let failed = |e: &h2::Error, replay: bool| {
            self.pool.remove_h2(key, id);
            let fault = super::fault::fault_from_chain(e, false);
            let mut error = ProviderError::transport(fault, if replay { DeliveryState::NotSent } else { DeliveryState::Ambiguous });
            error.message = surface.text(|| e.to_string());
            Failure { error, replay: replay || e.reason() == Some(h2::Reason::REFUSED_STREAM) }
        };
        let (headers, _) = match writer {
            Writer::Fetch => fetch_headers(&request.headers, true),
            Writer::Raw => (request.headers.clone(), false),
        };
        let mut builder = hyper::http::Request::builder().method(request.method.as_str()).uri(url.as_str());
        for (name, value) in &headers {
            if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("connection") || name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            builder = builder.header(name.as_str(), value.as_str());
        }
        let expects_payload = matches!(request.method.as_str(), "POST" | "PUT" | "PATCH");
        if !request.body.is_empty() || expects_payload {
            builder = builder.header("content-length", request.body.len().to_string());
        }
        let built = builder.body(()).map_err(|e| Failure { error: refused(e.to_string(), surface), replay: false })?;
        let mut send = send.ready().await.map_err(|e| failed(&e, true))?;
        let (response, mut stream) = send.send_request(built, request.body.is_empty()).map_err(|e| failed(&e, true))?;
        if !request.body.is_empty() {
            stream.send_data(Bytes::from(request.body.clone()), true).map_err(|e| failed(&e, false))?;
        }
        let response = match tokio::time::timeout(HEADERS_TIMEOUT, response).await {
            Err(_) => {
                let error = timed_out("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error", DeliveryState::Ambiguous, surface);
                return Err(Failure { error, replay: false });
            }
            Ok(response) => response.map_err(|e| failed(&e, false))?,
        };
        let status = response.status().as_u16();
        let list: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
            .collect();
        let bodiless = request.method == "HEAD" || matches!(status, 204 | 304);
        let decoder = if bodiless { None } else { Decoder::of(list.iter().find(|(n, _)| n == "content-encoding").map(|(_, v)| v.as_str())) };
        Ok(HttpResponse { status, headers: list, body: Box::new(H2Body { stream: response.into_body(), decoder, ended: false, _guard: guard }) })
    }
}

struct H2Body {
    stream: h2::RecvStream,
    decoder: Option<Decoder>,
    /// The stream has ended (or failed in its decoding); only the decoder's steps are left.
    ended: bool,
    _guard: pool::H2Guard,
}

#[async_trait]
impl BodyStream for H2Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            // The decoder's steps first, one at a time; the stream is read again only when it has nothing left.
            if let Some(decoder) = self.decoder.as_mut() {
                match decoder.step() {
                    Err(e) => {
                        self.decoder = None;
                        self.ended = true;
                        return Some(Err(fault_from_io(&e, false)));
                    }
                    Ok(Some(step)) => return Some(Ok(Bytes::from(step))),
                    Ok(None) if self.ended => {
                        self.decoder = None;
                        return None;
                    }
                    Ok(None) => {}
                }
            }
            if self.ended {
                return None;
            }
            let data = match tokio::time::timeout(BODY_TIMEOUT, self.stream.data()).await {
                Err(_) => return Some(Err(TransportFault::Io { os_code: None })),
                Ok(data) => data,
            };
            let Some(data) = data else {
                // The stream ended: a decoder that did not reach the end of its stream is a truncated body.
                self.ended = true;
                match self.decoder.as_mut() {
                    Some(decoder) => {
                        decoder.end();
                        continue;
                    }
                    None => return None,
                }
            };
            let raw = match data {
                Ok(raw) => raw,
                Err(e) => return Some(Err(super::fault::fault_from_chain(&e, false))),
            };
            let _ = self.stream.flow_control().release_capacity(raw.len());
            match self.decoder.as_mut() {
                Some(decoder) => decoder.feed(&raw),
                None if !raw.is_empty() => return Some(Ok(raw)),
                None => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    use super::*;

    const WITHIN: Duration = Duration::from_secs(20);

    // H2 (recheck): a route change while a request dials retires the connection it dials. Held at the dial, the route
    // changes; the connection serves its request and is then closed, not pooled under the old route.
    #[tokio::test]
    async fn a_route_change_during_the_dial_retires_the_dialled_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").await.unwrap();
            // The client's close shows as the end of the stream; a pooled connection never shows it.
            stream.read(&mut byte).await.unwrap()
        });
        let tls = crate::netproxy::tunnel::tls_config().unwrap();
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        let pool = client.pool.clone();
        client.pool.hook(pool::At::Dial, move || pool.clear());
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: "GET".into(),
            url: "http://pinned.test/x".into(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        let mut response = tokio::time::timeout(WITHIN, client.send(&request, Writer::Fetch, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        while let Some(chunk) = tokio::time::timeout(WITHIN, response.body.next()).await.expect("the body within 20 s") {
            chunk.unwrap();
        }
        let key = client.key(&url::Url::parse(&request.url).unwrap(), &None);
        assert_eq!(client.pool.idle_count(&key), 0, "not pooled under the old route");
        let read = tokio::time::timeout(WITHIN, server).await.expect("the peer sees the close within 20 s").unwrap();
        assert_eq!(read, 0, "the peer sees the close");
    }
}
