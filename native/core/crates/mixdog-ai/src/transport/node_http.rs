//! The HTTP client of every non-streaming-request provider call, written to put on the wire what Node puts there:
//! the global `fetch` of Node 22 (undici 6.21 for the headers it adds, `http-agent.mjs`' undici 8 `Agent` for the
//! bytes it writes) over a kept-alive connection pool. The head is written by hand because no HTTP library keeps a
//! header's letter case or leaves the order to the caller; the response is read with `httparse`.
//!
//! What Node writes, in this order (`client-h1.js` `writeH1`): the request line, `host`, `connection`, the headers
//! `fetch` hands over (the caller's, in the caller's order and letter case, then `accept`, `accept-language`,
//! `sec-fetch-mode`, `user-agent` and `accept-encoding` where the caller set none: `fetch/index.js` 10478, 4143,
//! 10888, 10908), and `content-length` last. A raw `undici.request` (the preconnect) adds none of the `fetch` headers.

use std::collections::HashMap;
use std::io;
use std::io::Write as _;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::TcpKeepalive;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;

use crate::netproxy::NetworkProxy;
use crate::netproxy::tunnel::TunnelError;
use crate::netproxy::tunnel::open_proxy_tunnel;
use crate::netproxy::tunnel::tls_code;

use super::fault::fault_from_io;
use super::link::BodyStream;
use super::link::HttpResponse;
use super::link::Surface;
use super::tcp;

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
    let mut text = format!(
        "{} {target} HTTP/1.1\r\nhost: {authority}\r\nconnection: {}\r\n",
        request.method,
        if close { "close" } else { "keep-alive" }
    );
    for (name, value) in &headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    let expects_payload = matches!(request.method.as_str(), "POST" | "PUT" | "PATCH");
    if !request.body.is_empty() || expects_payload {
        text.push_str(&format!("content-length: {}\r\n", request.body.len()));
    }
    text.push_str("\r\n");
    (text.into_bytes(), close)
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

enum Framing {
    Length(u64),
    Chunked(Chunk),
    UntilClose,
    Empty,
}

enum Chunk {
    Size,
    Data(u64),
    DataEnd,
    Trailer,
}

/// `content-encoding` as `fetch` decodes it (`gzip`, `deflate` (zlib, else raw by the first byte), `br`).
enum Decoder {
    Gzip(flate2::write::GzDecoder<Vec<u8>>),
    Zlib(flate2::write::ZlibDecoder<Vec<u8>>),
    Raw(flate2::write::DeflateDecoder<Vec<u8>>),
    Brotli(Box<brotli::DecompressorWriter<Vec<u8>>>),
    /// `deflate`, not yet told apart.
    Deflate,
}

impl Decoder {
    fn of(encoding: Option<&str>) -> Option<Self> {
        match encoding?.trim().to_ascii_lowercase().as_str() {
            "gzip" | "x-gzip" => Some(Self::Gzip(flate2::write::GzDecoder::new(Vec::new()))),
            "deflate" => Some(Self::Deflate),
            "br" => Some(Self::Brotli(Box::new(brotli::DecompressorWriter::new(Vec::new(), 4096)))),
            _ => None,
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> io::Result<Vec<u8>> {
        if matches!(self, Self::Deflate) {
            *self = if bytes.first().is_some_and(|b| b & 0x0f == 8) {
                Self::Zlib(flate2::write::ZlibDecoder::new(Vec::new()))
            } else {
                Self::Raw(flate2::write::DeflateDecoder::new(Vec::new()))
            };
        }
        match self {
            Self::Gzip(d) => {
                d.write_all(bytes)?;
                d.flush()?;
                Ok(std::mem::take(d.get_mut()))
            }
            Self::Zlib(d) => {
                d.write_all(bytes)?;
                d.flush()?;
                Ok(std::mem::take(d.get_mut()))
            }
            Self::Raw(d) => {
                d.write_all(bytes)?;
                d.flush()?;
                Ok(std::mem::take(d.get_mut()))
            }
            Self::Brotli(d) => {
                d.write_all(bytes)?;
                d.flush()?;
                Ok(std::mem::take(d.get_mut()))
            }
            Self::Deflate => Ok(Vec::new()),
        }
    }
}

struct H1Body {
    io: Option<Stream>,
    buffer: Vec<u8>,
    framing: Framing,
    decoder: Option<Decoder>,
    /// Where the connection goes back to once the body is whole; `None` when the exchange ends it.
    reuse: Option<(Arc<Pool>, String, Duration, u64)>,
    /// Set by [`BodyStream::hold_connection`]: the whole body's connection waits for this body to be dropped.
    hold: bool,
    parked: Option<(Arc<Pool>, String, Idle)>,
}

impl Drop for H1Body {
    fn drop(&mut self) {
        if let Some((pool, key, idle)) = self.parked.take() {
            pool.put(key, idle);
        }
    }
}

impl H1Body {
    /// The body bytes available in `buffer` (framing removed), or `None` when more must be read. `Err` is a framing fault.
    fn take(&mut self) -> io::Result<Option<Vec<u8>>> {
        match &mut self.framing {
            Framing::Empty => Ok(Some(Vec::new())),
            Framing::UntilClose => Ok((!self.buffer.is_empty()).then(|| std::mem::take(&mut self.buffer))),
            Framing::Length(left) => {
                if *left == 0 || self.buffer.is_empty() {
                    return Ok(None);
                }
                let n = (*left as usize).min(self.buffer.len());
                *left -= n as u64;
                Ok(Some(self.buffer.drain(..n).collect()))
            }
            Framing::Chunked(state) => {
                let mut out = Vec::new();
                loop {
                    match state {
                        Chunk::Size => {
                            let Some(end) = self.buffer.windows(2).position(|w| w == b"\r\n") else { break };
                            let line = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
                            let size = u64::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16)
                                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk size"))?;
                            self.buffer.drain(..end + 2);
                            *state = if size == 0 { Chunk::Trailer } else { Chunk::Data(size) };
                        }
                        Chunk::Data(left) => {
                            if self.buffer.is_empty() {
                                break;
                            }
                            let n = (*left as usize).min(self.buffer.len());
                            out.extend(self.buffer.drain(..n));
                            *left -= n as u64;
                            if *left == 0 {
                                *state = Chunk::DataEnd;
                            }
                        }
                        Chunk::DataEnd => {
                            if self.buffer.len() < 2 {
                                break;
                            }
                            self.buffer.drain(..2);
                            *state = Chunk::Size;
                        }
                        Chunk::Trailer => {
                            let Some(end) = self.buffer.windows(2).position(|w| w == b"\r\n") else { break };
                            let empty = end == 0;
                            self.buffer.drain(..end + 2);
                            if empty {
                                self.framing = Framing::Length(0);
                                break;
                            }
                        }
                    }
                }
                Ok((!out.is_empty()).then_some(out))
            }
        }
    }

    fn done(&self) -> bool {
        matches!(self.framing, Framing::Length(0) | Framing::Empty)
    }

    /// The exchange is whole: the connection goes back to the pool.
    fn release(&mut self) {
        if let (Some(io), Some((pool, key, ttl, born))) = (self.io.take(), self.reuse.take())
            && self.buffer.is_empty()
        {
            let idle = Idle::H1 { io, until: Instant::now() + ttl, born };
            if self.hold {
                self.parked = Some((pool, key, idle));
            } else {
                pool.put(key, idle);
            }
        }
    }
}

#[async_trait]
impl BodyStream for H1Body {
    fn hold_connection(&mut self) {
        self.hold = true;
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            match self.take() {
                Err(e) => {
                    self.io = None;
                    return Some(Err(fault_from_io(&e, false)));
                }
                Ok(Some(raw)) if !raw.is_empty() => {
                    let out = match self.decoder.as_mut() {
                        Some(decoder) => match decoder.feed(&raw) {
                            Ok(out) => out,
                            Err(e) => {
                                self.io = None;
                                return Some(Err(fault_from_io(&e, false)));
                            }
                        },
                        None => raw,
                    };
                    if self.done() {
                        self.release();
                    }
                    if out.is_empty() {
                        continue;
                    }
                    return Some(Ok(Bytes::from(out)));
                }
                _ => {}
            }
            if self.done() {
                self.release();
                return None;
            }
            let Some(io) = self.io.as_mut() else { return None };
            let mut chunk = [0u8; 16384];
            match io.read(&mut chunk).await {
                Ok(0) => {
                    self.io = None;
                    return if matches!(self.framing, Framing::UntilClose) {
                        None
                    } else {
                        Some(Err(TransportFault::Closed))
                    };
                }
                Ok(n) => self.buffer.extend_from_slice(&chunk[..n]),
                Err(e) => {
                    self.io = None;
                    return Some(Err(fault_from_io(&e, false)));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The pool and the connect
// ---------------------------------------------------------------------------

enum Idle {
    /// `born` is the connection's creation number: undici's pool hands a request to the first free client in the
    /// order they were created, so the idle list is kept in that order.
    H1 { io: Stream, until: Instant, born: u64 },
    H2(h2::client::SendRequest<Bytes>),
}

#[derive(Default)]
struct Pool {
    idle: Mutex<HashMap<String, Vec<Idle>>>,
    births: std::sync::atomic::AtomicU64,
}

impl Pool {
    fn birth(&self) -> u64 {
        self.births.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn put(&self, key: String, idle: Idle) {
        let mut all = self.idle.lock().unwrap_or_else(PoisonError::into_inner);
        let list = all.entry(key).or_default();
        let at = match &idle {
            Idle::H1 { born, .. } => list.iter().position(|o| matches!(o, Idle::H1 { born: other, .. } if other > born)).unwrap_or(list.len()),
            Idle::H2(_) => list.len(),
        };
        list.insert(at, idle);
    }

    /// An idle connection of `key` that is still within its keep-alive; h2 connections stay shared.
    fn take(&self, key: &str) -> Option<Idle> {
        let mut idle = self.idle.lock().unwrap_or_else(PoisonError::into_inner);
        let list = idle.get_mut(key)?;
        while !list.is_empty() {
            match list.remove(0) {
                Idle::H1 { until, .. } if Instant::now() >= until => {}
                Idle::H2(send) => {
                    let again = send.clone();
                    list.insert(0, Idle::H2(send));
                    return Some(Idle::H2(again));
                }
                other => return Some(other),
            }
        }
        None
    }
}

/// Test pinning: every connect goes to `addr` and trusts `tls` alone.
pub struct Pinned {
    pub addr: SocketAddr,
    pub tls: Arc<rustls::ClientConfig>,
}

pub struct NodeClient {
    tcp: TcpKeepalive,
    policy: Option<Arc<NetworkProxy>>,
    pinned: Option<Pinned>,
    pool: Arc<Pool>,
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

impl NodeClient {
    pub fn new(tcp: TcpKeepalive, policy: Option<Arc<NetworkProxy>>, pinned: Option<Pinned>) -> Self {
        Self { tcp, policy, pinned, pool: Arc::new(Pool::default()) }
    }

    async fn dial(&self, url: &url::Url, surface: Surface) -> Result<(Stream, bool), ProviderError> {
        let host = url.host_str().unwrap_or_default().to_owned();
        let bare = host.trim_start_matches('[').trim_end_matches(']').to_owned();
        let https = url.scheme() == "https";
        let port = url.port_or_known_default().unwrap_or(if https { 443 } else { 80 });
        let tcp_stream: Stream = if let Some(pinned) = &self.pinned {
            let socket = tcp::connect(pinned.addr, &self.tcp).await.map_err(|e| io_error(&e, true, DeliveryState::NotSent, surface))?;
            Box::new(socket)
        } else {
            let proxy = match &self.policy {
                Some(policy) => policy
                    .route_for_url(url.as_str())
                    .await
                    .map_err(|e| {
                        let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                        error.message = e.to_string();
                        error
                    })?
                    .proxy,
                None => None,
            };
            match proxy {
                Some(proxy) => Box::new(
                    open_proxy_tunnel(&proxy, &bare, port, &self.tcp).await.map_err(|e| tunnel_error(e, surface))?,
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
        let config = match &self.pinned {
            Some(pinned) => pinned.tls.clone(),
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

    /// One request, no redirects. A reused connection that fails before it answers is replaced by a new one once.
    pub async fn send(&self, request: &WireRequest, writer: Writer, surface: Surface) -> Result<HttpResponse, ProviderError> {
        let url = url::Url::parse(&request.url).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = e.to_string();
            error
        })?;
        let key = format!("{}://{}", url.scheme(), url.authority());
        loop {
            let reused = self.pool.take(&key);
            let was_reused = reused.is_some();
            let outcome = match reused {
                Some(Idle::H1 { io, born, .. }) => self.exchange_h1(io, born, &key, request, &url, writer, surface).await,
                Some(Idle::H2(send)) => self.exchange_h2(send, request, &url, writer, surface).await,
                None => {
                    let (io, h2) = self.dial(&url, surface).await?;
                    if h2 {
                        let (send, connection) = h2::client::handshake(io).await.map_err(|e| {
                            let mut error = ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent);
                            error.message = surface.text(|| e.to_string());
                            error
                        })?;
                        mixdog_rt::spawn("ai.http.h2", mixdog_rt::TaskClass::Work, async move {
                            let _ = connection.await;
                        });
                        self.pool.put(key.clone(), Idle::H2(send.clone()));
                        self.exchange_h2(send, request, &url, writer, surface).await
                    } else {
                        self.exchange_h1(io, self.pool.birth(), &key, request, &url, writer, surface).await
                    }
                }
            };
            match outcome {
                Err((_, true)) if was_reused => continue,
                Err((error, _)) => return Err(error),
                Ok(response) => return Ok(response),
            }
        }
    }

    /// `Err((error, nothing_came_back))`.
    #[allow(clippy::too_many_arguments, reason = "one exchange's connection, request and surface")]
    async fn exchange_h1(
        &self,
        mut io: Stream,
        born: u64,
        key: &str,
        request: &WireRequest,
        url: &url::Url,
        writer: Writer,
        surface: Surface,
    ) -> Result<HttpResponse, (ProviderError, bool)> {
        let (head, close) = head(request, url, writer);
        let failed = |e: &io::Error, silent: bool| (io_error(e, false, DeliveryState::Ambiguous, surface), silent);
        io.write_all(&head).await.map_err(|e| failed(&e, true))?;
        io.write_all(&request.body).await.map_err(|e| failed(&e, true))?;
        io.flush().await.map_err(|e| failed(&e, true))?;
        let mut buffer: Vec<u8> = Vec::new();
        loop {
            let mut headers = [httparse::EMPTY_HEADER; 128];
            let mut parsed = httparse::Response::new(&mut headers);
            let attempt = parsed.parse(&buffer);
            match attempt {
                Ok(httparse::Status::Complete(used)) => {
                    let status = parsed.code.unwrap_or(0);
                    let list: Vec<(String, String)> = parsed
                        .headers
                        .iter()
                        .map(|h| (h.name.to_owned(), String::from_utf8_lossy(h.value).into_owned()))
                        .collect();
                    buffer.drain(..used);
                    if (100..200).contains(&status) && status != 101 {
                        continue;
                    }
                    return Ok(self.response_h1(io, born, buffer, status, list, key, request, close));
                }
                Ok(httparse::Status::Partial) => {}
                Err(_) => {
                    let error = io::Error::new(io::ErrorKind::InvalidData, "bad response head");
                    return Err(failed(&error, false));
                }
            }
            let mut chunk = [0u8; 16384];
            match io.read(&mut chunk).await {
                Ok(0) => {
                    let error = io::Error::from(io::ErrorKind::UnexpectedEof);
                    return Err(failed(&error, buffer.is_empty()));
                }
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(e) => return Err(failed(&e, buffer.is_empty())),
            }
        }
    }

    #[allow(clippy::too_many_arguments, reason = "the pieces of one parsed response head")]
    fn response_h1(
        &self,
        io: Stream,
        born: u64,
        buffer: Vec<u8>,
        status: u16,
        headers: Vec<(String, String)>,
        key: &str,
        request: &WireRequest,
        close: bool,
    ) -> HttpResponse {
        let find = |name: &str| headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
        let framing = if request.method == "HEAD" || status == 204 || status == 304 || status == 101 {
            Framing::Empty
        } else if find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
            Framing::Chunked(Chunk::Size)
        } else if let Some(length) = find("content-length").and_then(|v| v.trim().parse::<u64>().ok()) {
            Framing::Length(length)
        } else {
            Framing::UntilClose
        };
        let server_closes = find("connection").is_some_and(|v| v.to_ascii_lowercase().contains("close"));
        let reusable = !close && !server_closes && !matches!(framing, Framing::UntilClose);
        // `keep-alive: timeout=N` (`client-h1.js` `onHeadersComplete`): the hint less the threshold, at most the maximum.
        let hint = find("keep-alive")
            .and_then(|v| v.split(',').find_map(|part| part.trim().strip_prefix("timeout=")?.trim().parse::<u64>().ok()))
            .map(Duration::from_secs);
        let ttl = hint.map_or(KEEP_ALIVE, |h| h.saturating_sub(KEEP_ALIVE_THRESHOLD).min(KEEP_ALIVE_MAX));
        let decoder = Decoder::of(find("content-encoding"));
        let body = H1Body {
            io: Some(io),
            buffer,
            framing,
            decoder,
            reuse: reusable.then(|| (self.pool.clone(), key.to_owned(), ttl, born)),
            hold: false,
            parked: None,
        };
        let mut body = body;
        // An empty body is whole already.
        if body.done() {
            body.release();
        }
        HttpResponse { status, headers, body: Box::new(body) }
    }

    async fn exchange_h2(
        &self,
        send: h2::client::SendRequest<Bytes>,
        request: &WireRequest,
        url: &url::Url,
        writer: Writer,
        surface: Surface,
    ) -> Result<HttpResponse, (ProviderError, bool)> {
        let failed = |e: &h2::Error| {
            let fault = super::fault::fault_from_chain(e, false);
            let mut error = ProviderError::transport(fault, DeliveryState::Ambiguous);
            error.message = surface.text(|| e.to_string());
            (error, true)
        };
        let (headers, _) = match writer {
            Writer::Fetch => fetch_headers(&request.headers, true),
            Writer::Raw => (request.headers.clone(), false),
        };
        let mut builder = hyper::http::Request::builder().method(request.method.as_str()).uri(url.as_str());
        for (name, value) in &headers {
            if name.eq_ignore_ascii_case("transfer-encoding") || name.eq_ignore_ascii_case("keep-alive") || name.eq_ignore_ascii_case("upgrade") {
                continue;
            }
            builder = builder.header(name.as_str(), value.as_str());
        }
        let expects_payload = matches!(request.method.as_str(), "POST" | "PUT" | "PATCH");
        if !request.body.is_empty() || expects_payload {
            builder = builder.header("content-length", request.body.len().to_string());
        }
        let built = builder.body(()).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = e.to_string();
            (error, false)
        })?;
        let mut send = send.ready().await.map_err(|e| failed(&e))?;
        let (response, mut stream) = send.send_request(built, request.body.is_empty()).map_err(|e| failed(&e))?;
        if !request.body.is_empty() {
            stream.send_data(Bytes::from(request.body.clone()), true).map_err(|e| failed(&e))?;
        }
        let response = response.await.map_err(|e| failed(&e))?;
        let status = response.status().as_u16();
        let list: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
            .collect();
        let decoder = Decoder::of(list.iter().find(|(n, _)| n == "content-encoding").map(|(_, v)| v.as_str()));
        Ok(HttpResponse { status, headers: list, body: Box::new(H2Body { stream: response.into_body(), decoder }) })
    }
}

struct H2Body {
    stream: h2::RecvStream,
    decoder: Option<Decoder>,
}

#[async_trait]
impl BodyStream for H2Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            let data = self.stream.data().await?;
            let raw = match data {
                Ok(raw) => raw,
                Err(e) => return Some(Err(super::fault::fault_from_chain(&e, false))),
            };
            let _ = self.stream.flow_control().release_capacity(raw.len());
            let out = match self.decoder.as_mut() {
                Some(decoder) => match decoder.feed(&raw) {
                    Ok(out) => Bytes::from(out),
                    Err(e) => return Some(Err(fault_from_io(&e, false))),
                },
                None => raw,
            };
            if !out.is_empty() {
                return Some(Ok(out));
            }
        }
    }
}
