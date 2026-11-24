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
mod goaway;
mod h1;
mod pool;

/// The most one part of a decoded body holds.
pub use decode::STEP as DECODED_STEP;

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::OnceLock;
use std::task::Poll;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::TcpKeepalive;
use mixdog_core_api::domain::provider::ConnectionInfo;
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
use decode::Codings;
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

// The head

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
    let text = format!("{} {target} HTTP/1.1\r\nhost: {authority}\r\nconnection: {}\r\n", request.method, if close { "close" } else { "keep-alive" });
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

// What undici refuses to send

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
            "connection" if !value.to_ascii_lowercase().split(',').all(|part| token(part.trim())) => {
                return Err("invalid connection header".into());
            }
            _ => {}
        }
    }
    Ok(())
}

// The client

/// A failed exchange. `replay` says that no byte of the request reached the server whole, so it may be sent again on
/// another connection: the connection was gone before the write, or the write itself failed, or the server refused
/// the stream (`REFUSED_STREAM`). A request the server may have executed is never replayed.
struct Failure {
    error: ProviderError,
    replay: bool,
    /// Sent again on a healthy connection without using the once-only allowance of `replay`: the request never got a stream,
    /// and the peer's own GOAWAY or refusal is why.
    free: bool,
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
    /// What a test runs as each request has its connection ([`NodeClient::tap`]).
    #[cfg(any(test, feature = "test-support"))]
    tap: std::sync::Mutex<Option<Tap>>,
    pool: Arc<Pool>,
    /// A change of the network proxy setting closes every idle connection (`http-agent.mjs` `onProxyRouteChange`).
    _retire: Option<Subscription>,
}

/// Called with each request once it has its connection, before the request is written.
#[cfg(any(test, feature = "test-support"))]
pub type Tap = Box<dyn Fn(&WireRequest) + Send + Sync>;

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

/// `scheme://host:port` of the target, and of the proxy it goes through, without a proxy's userinfo or path: what a log line
/// may say of a route.
fn loggable_route(url: &url::Url, proxy: &Option<String>) -> String {
    let https = url.scheme() == "https";
    let port = url.port_or_known_default().unwrap_or(if https { 443 } else { 80 });
    let target = format!("{}://{}:{port}", url.scheme(), url.host_str().unwrap_or_default());
    let Some(proxy) = proxy else { return target };
    match url::Url::parse(proxy) {
        Ok(p) => format!("{target} via {}://{}:{}", p.scheme(), p.host_str().unwrap_or_default(), p.port_or_known_default().unwrap_or(0)),
        Err(_) => format!("{target} via proxy"),
    }
}

fn tunnel_error(err: TunnelError, surface: Surface) -> ProviderError {
    let (fault, code, message) = match err {
        TunnelError::Dns => (Some(TransportFault::Dns), None, "dns".to_owned()),
        TunnelError::Connect(io) => (Some(fault_from_io(&io, true)), None, io.to_string()),
        TunnelError::Io(io) => (Some(fault_from_io(&io, false)), None, io.to_string()),
        TunnelError::Tls(failure) => (None, Some(tls_code(&failure).to_owned()), failure.error.to_string()),
        TunnelError::Dropped(io) => (None, Some("UND_ERR_SOCKET".to_owned()), io.to_string()),
        TunnelError::TimedOut => (None, Some("UND_ERR_HEADERS_TIMEOUT".to_owned()), "proxy timed out".to_owned()),
        refused @ TunnelError::Refused { .. } => (None, Some(refused.socket_code().unwrap_or("EPROXY").to_owned()), refused.to_string()),
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

fn origin_port(url: &url::Url) -> u16 {
    url.port_or_known_default().unwrap_or(if url.scheme() == "https" { 443 } else { 80 })
}

fn header_pairs(map: &hyper::header::HeaderMap) -> Vec<(String, String)> {
    map.iter().map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())).collect()
}

fn h2_request(request: &WireRequest, url: &url::Url, writer: Writer) -> Result<hyper::http::Request<()>, hyper::http::Error> {
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
    builder.body(())
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

/// The decoder of a response's body (undici's `onHeaders`): none for a body that cannot have codings (`HEAD`, 204,
/// 304) or whose codings leave it as it came. More codings than undici takes fail the fetch, as its `controller.abort`.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn decoding(headers: &[(String, String)], method: &str, status: u16) -> Result<Option<Decoder>, Failure> {
    if method == "HEAD" || matches!(status, 204 | 304) {
        return Ok(None);
    }
    // `headersList.get('content-encoding')`: every line of the header, joined.
    let lines: Vec<&str> = headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case("content-encoding")).map(|(_, value)| value.as_str()).collect();
    let joined = (!lines.is_empty()).then(|| lines.join(", "));
    match Codings::of(joined.as_deref()) {
        Codings::Plain => Ok(None),
        Codings::Decode(decoder) => Ok(Some(decoder)),
        Codings::TooMany(text) => {
            // The provider answered and the response is refused: the reason is the text, not the network failure's `fetch failed`.
            let mut error = ProviderError::transport(TransportFault::TooManyEncodings, DeliveryState::Accepted);
            error.message = text;
            Err(Failure { error, replay: false, free: false })
        }
    }
}

struct H2Body {
    /// Taken only by the drop of a body its reader is done with, to be read off.
    wire: Option<H2Wire>,
    decoder: Option<Decoder>,
    /// The stream has ended (or failed in its decoding); only the decoder's steps are left.
    ended: bool,
    /// The reader is done with the response ([`BodyStream::drain_on_drop`]).
    done: bool,
    /// A read failed (the stream or its connection ended in an error, or it was silent for [`BODY_TIMEOUT`]): the body is not
    /// finished, whatever its reader marks.
    failed: bool,
    /// A read is under way. One its reader cut short (the driver's deadline, a cancel) leaves this set, and fails the body as
    /// `failed` does until a later read completes.
    reading: bool,
    /// The connection's number, as its end is logged under.
    id: u64,
}

/// A response's stream, with the guard that keeps its connection in use while the stream is.
struct H2Wire {
    stream: h2::RecvStream,
    guard: pool::H2Guard,
}

impl H2Body {
    fn new(stream: h2::RecvStream, decoder: Option<Decoder>, id: u64, guard: pool::H2Guard) -> Self {
        Self { wire: Some(H2Wire { stream, guard }), decoder, ended: false, done: false, failed: false, reading: false, id }
    }
}

impl H2Wire {
    /// Reads what is left of a response its reader is done with, releasing each frame, until END_STREAM or the end of the
    /// stream or its connection. A stream silent for [`BODY_TIMEOUT`], the most any read of a body waits, is cancelled after all.
    async fn read_out(mut self) {
        while let Ok(Some(Ok(data))) = mixdog_rt::time::timeout(BODY_TIMEOUT, self.stream.data()).await {
            let _ = self.stream.flow_control().release_capacity(data.len());
        }
    }
}

impl Drop for H2Body {
    /// Dropped before its end, a body is a cancel: h2 resets its stream. One whose reader is done is read to its end instead:
    /// its last frames are already on their way, and h2 counts against the connection each frame that arrives for a stream it
    /// reset, once it has forgotten that stream (`STREAM_CLOSED`, toward its local reset limit) or while it still remembers it
    /// (toward its DATA frame budget). A stream whose END_STREAM is here has nothing left to read, and is not reset.
    fn drop(&mut self) {
        if !self.done || self.ended || self.failed || self.reading || self.wire.as_ref().is_none_or(|wire| wire.stream.is_end_stream()) {
            return;
        }
        if let (Some(wire), Ok(runtime)) = (self.wire.take(), tokio::runtime::Handle::try_current()) {
            runtime.spawn(wire.read_out());
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

    /// The route a log line names carries no proxy credentials, nor the path or query of the proxy URL.
    #[test]
    fn a_logged_route_has_no_proxy_credentials() {
        let target = url::Url::parse("https://api.anthropic.com/v1/messages").unwrap();
        let proxy = Some("http://user:s3cret@proxy.corp:3128/pac?token=abc".to_owned());
        let line = loggable_route(&target, &proxy);
        assert_eq!(line, "https://api.anthropic.com:443 via http://proxy.corp:3128");
        assert!(!line.contains("s3cret") && !line.contains("user") && !line.contains("token"));
        assert_eq!(loggable_route(&target, &Some("not a url user:pw@".to_owned())), "https://api.anthropic.com:443 via proxy");
        assert_eq!(loggable_route(&target, &None), "https://api.anthropic.com:443");
    }

    /// How a response body ends mid-way.
    #[derive(Clone, Copy)]
    enum Cut {
        /// The connection under it ends (the peer's socket is gone).
        Connection,
        /// Only this stream is reset (RST_STREAM); the connection lives.
        Stream,
    }

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
        let request =
            WireRequest { transport: TransportKind::Http1, method: "GET".into(), url: "http://pinned.test/x".into(), headers: Vec::new(), body: Vec::new() };
        let mut response =
            mixdog_rt::time::timeout(WITHIN, client.send(&request, Writer::Fetch, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        while let Some(chunk) = mixdog_rt::time::timeout(WITHIN, response.body.next()).await.expect("the body within 20 s") {
            chunk.unwrap();
        }
        let key = client.key(&url::Url::parse(&request.url).unwrap(), &None);
        assert_eq!(client.pool.idle_count(&key), 0, "not pooled under the old route");
        let read = mixdog_rt::time::timeout(WITHIN, server).await.expect("the peer sees the close within 20 s").unwrap();
        assert_eq!(read, 0, "the peer sees the close");
    }
    /// A response streaming on a pooled HTTP/2 connection until it is cut: the fault the body gives, and how many connections
    /// the pool still offers right after it. The connection's own task is not the pool's here, so only the body can have
    /// taken the connection out.
    async fn cut_body(cut: Cut) -> (TransportFault, usize) {
        let (near, far) = tokio::io::duplex(1 << 16);
        let read_part = Arc::new(tokio::sync::Notify::new());
        let told = read_part.clone();
        let server = tokio::spawn(async move {
            let read_part = told;
            let mut conn = h2::server::handshake(far).await.unwrap();
            let (_request, mut respond) = conn.accept().await.unwrap().unwrap();
            let mut stream = respond.send_response(hyper::http::Response::new(()), false).unwrap();
            stream.send_data(Bytes::from_static(b"part"), false).unwrap();
            match cut {
                Cut::Connection => {
                    // Flushed, then the socket goes with the connection.
                    let _ = mixdog_rt::time::timeout(Duration::from_millis(50), conn.accept()).await;
                }
                Cut::Stream => {
                    // The reset follows what the caller has read, as a later frame, not the head's.
                    tokio::select! {
                        _ = async { while conn.accept().await.is_some() {} } => return,
                        _ = read_part.notified() => {}
                    }
                    stream.send_reset(h2::Reason::CANCEL);
                    while conn.accept().await.is_some() {}
                }
            }
        });
        let (send, connection) = h2::client::handshake(near).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let pool = Arc::new(pool::Pool::default());
        let id = pool.birth();
        let guard = pool.put_h2("k".into(), id, send.clone(), pool.generation());
        let (response, _) = send.ready().await.unwrap().send_request(hyper::http::Request::get("https://k/x").body(()).unwrap(), true).unwrap();
        let response = mixdog_rt::time::timeout(WITHIN, response).await.expect("the head within 20 s").unwrap();
        let mut body = H2Body::new(response.into_body(), None, id, guard);
        let first = mixdog_rt::time::timeout(WITHIN, body.next()).await.expect("a chunk within 20 s");
        assert_eq!(first.unwrap().unwrap(), Bytes::from_static(b"part"));
        read_part.notify_one();
        let fault = mixdog_rt::time::timeout(WITHIN, body.next()).await.expect("the cut within 20 s").unwrap().expect_err("the body was cut");
        let offered = pool.idle_count("k");
        server.abort();
        (fault, offered)
    }
    // The connection under a streaming response ends: the response fails with the connection's own cause, and the pool no
    // longer offers that connection by the time the failure is in the caller's hands, so a retry dials a new one.
    #[tokio::test]
    async fn a_response_cut_by_its_connection_ending_takes_the_connection_out_of_the_pool() {
        let (fault, offered) = cut_body(Cut::Connection).await;
        assert!(!matches!(fault, TransportFault::H2RstStream { .. }), "a connection-level cause, not a stream's: {fault:?}");
        assert_eq!(offered, 0);
    }
    // Two responses stream on one shared HTTP/2 connection when it ends: each fails with the connection's own cause and names
    // the same connection. The first failure has already taken the connection out of the pool, so a retry dispatched in the
    // same burst, before the second response has read its own failure, is offered no connection and dials a new one.
    #[tokio::test]
    async fn a_connection_ending_under_two_streams_fails_both_and_a_retry_in_the_burst_dials_anew() {
        let (near, far) = tokio::io::duplex(1 << 16);
        let server = tokio::spawn(async move {
            let mut conn = h2::server::handshake(far).await.unwrap();
            let mut open = Vec::new();
            for _ in 0..2 {
                let (_request, mut respond) = conn.accept().await.unwrap().unwrap();
                let mut stream = respond.send_response(hyper::http::Response::new(()), false).unwrap();
                stream.send_data(Bytes::from_static(b"part"), false).unwrap();
                open.push(stream);
            }
            // Flushed, then the socket goes with the connection, both streams still open.
            let _ = mixdog_rt::time::timeout(Duration::from_millis(50), conn.accept()).await;
            drop(open);
        });
        let (send, connection) = h2::client::handshake(near).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let pool = Arc::new(pool::Pool::default());
        let id = pool.birth();
        let first_guard = pool.put_h2("k".into(), id, send.clone(), pool.generation());
        let Some(Taken::H2 { id: shared, send: second_send, guard: second_guard }) = pool.checkout("k") else {
            panic!("the live connection is shared by the second request")
        };
        assert_eq!(shared, id);
        let mut bodies = Vec::new();
        for (send, guard) in [(send, first_guard), (second_send, second_guard)] {
            let (response, _) = send.ready().await.unwrap().send_request(hyper::http::Request::get("https://k/x").body(()).unwrap(), true).unwrap();
            let response = mixdog_rt::time::timeout(WITHIN, response).await.expect("the head within 20 s").unwrap();
            let mut body = H2Body::new(response.into_body(), None, id, guard);
            let first = mixdog_rt::time::timeout(WITHIN, body.next()).await.expect("a chunk within 20 s");
            assert_eq!(first.unwrap().unwrap(), Bytes::from_static(b"part"));
            bodies.push(body);
        }
        let mut faults = Vec::new();
        for (n, body) in bodies.iter_mut().enumerate() {
            let fault = mixdog_rt::time::timeout(WITHIN, body.next()).await.expect("the cut within 20 s").unwrap().expect_err("the body was cut");
            if n == 0 {
                assert!(pool.checkout("k").is_none(), "the retry of the first response finds no connection to reuse");
            }
            assert_eq!(body.connection(), Some(ConnectionInfo { id, protocol: "h2" }));
            faults.push(fault);
        }
        assert!(!matches!(faults[0], TransportFault::H2RstStream { .. }), "a connection-level cause, not a stream's: {:?}", faults[0]);
        assert_eq!(faults[0], faults[1], "both streams fail with the connection's one cause");
        server.abort();
    }
    // A reset of one stream says nothing of the connection: the others on it go on, and it stays offered.
    #[tokio::test]
    async fn a_response_reset_alone_leaves_its_connection_in_the_pool() {
        let (fault, offered) = cut_body(Cut::Stream).await;
        assert_eq!(fault, TransportFault::H2RstStream { code: u32::from(h2::Reason::CANCEL) });
        assert_eq!(offered, 1);
    }

    fn h2_frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
        let len = payload.len() as u32;
        let mut out = vec![(len >> 16) as u8, (len >> 8) as u8, len as u8, kind, flags];
        out.extend_from_slice(&stream.to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// When the first connection sends its GOAWAY: after `trigger` requests are complete on it, naming `last` with `code`.
    /// Later connections answer every request. `drain`: the first connection answers the requests at or below `last`.
    #[derive(Clone, Copy)]
    struct Script {
        trigger: usize,
        last: u32,
        code: u32,
        drain: bool,
        /// The first connection ends right after its GOAWAY.
        close: bool,
        /// Connections up to this number refuse each complete request with RST_STREAM(REFUSED_STREAM), no GOAWAY.
        refuse: usize,
        /// The refusal comes on the request's HEADERS, before its DATA.
        refuse_at_headers: bool,
        /// The first connection sends a `103` before it answers or refuses.
        hint: bool,
    }

    impl Script {
        const NONE: Script = Script { trigger: usize::MAX, last: 0, code: 0, drain: false, close: false, refuse: 0, refuse_at_headers: false, hint: false };
    }

    /// (connection number, stream id, request body length) of each complete request the stand-in has seen.
    type Seen = Arc<std::sync::Mutex<Vec<(usize, u32, usize)>>>;

    /// The TLS of an h2 stand-in on `localhost`: its acceptor, which offers h2 alone, and a client configuration trusting it alone.
    fn tls_stand_in() -> (tokio_rustls::TlsAcceptor, Arc<rustls::ClientConfig>) {
        let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let cert = issued.cert.der().clone();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut server = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key)
            .unwrap();
        server.alpn_protocols = vec![b"h2".to_vec()];
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert).unwrap();
        let mut client = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        client.alpn_protocols = ALPN.iter().map(|p| p.to_vec()).collect();
        (tokio_rustls::TlsAcceptor::from(Arc::new(server)), Arc::new(client))
    }

    /// A TLS h2 stand-in written frame by frame, so the GOAWAY's last-stream-id is exact. A complete request on the first
    /// connection is announced on the channel.
    async fn goaway_peer(script: Script) -> (SocketAddr, Arc<rustls::ClientConfig>, Seen, tokio::sync::mpsc::UnboundedReceiver<u32>) {
        let (acceptor, client) = tls_stand_in();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::default();
        let (announce, announced) = tokio::sync::mpsc::unbounded_channel();
        let log = seen.clone();
        tokio::spawn(async move {
            let mut n = 0;
            while let Ok((tcp, _)) = listener.accept().await {
                n += 1;
                let (acceptor, log, announce) = (acceptor.clone(), log.clone(), announce.clone());
                tokio::spawn(async move {
                    let mut tls = acceptor.accept(tcp).await.unwrap();
                    let mut preface = [0u8; 24];
                    tls.read_exact(&mut preface).await.unwrap();
                    tls.write_all(&h2_frame(4, 0, 0, &[])).await.unwrap();
                    let mut lens = std::collections::HashMap::<u32, usize>::new();
                    let mut done = Vec::new();
                    let mut refused = std::collections::HashSet::<u32>::new();
                    loop {
                        let mut head = [0u8; 9];
                        if tls.read_exact(&mut head).await.is_err() {
                            return;
                        }
                        let len = u32::from_be_bytes([0, head[0], head[1], head[2]]) as usize;
                        let stream = u32::from_be_bytes([head[5] & 0x7f, head[6], head[7], head[8]]);
                        let mut payload = vec![0u8; len];
                        if tls.read_exact(&mut payload).await.is_err() {
                            return;
                        }
                        match head[3] {
                            4 if head[4] & 1 == 0 => tls.write_all(&h2_frame(4, 1, 0, &[])).await.unwrap(),
                            1 if script.refuse_at_headers && n <= script.refuse => {
                                refused.insert(stream);
                                if n == 1 {
                                    let _ = announce.send(stream);
                                }
                                let _ = tls.write_all(&h2_frame(3, 0, stream, &7u32.to_be_bytes())).await;
                            }
                            0 => {
                                *lens.entry(stream).or_default() += len;
                                if head[4] & 1 == 0 || refused.contains(&stream) {
                                    continue;
                                }
                                log.lock().unwrap().push((n, stream, lens[&stream]));
                                done.push(stream);
                                let respond = |s: u32| [h2_frame(1, 4, s, &[0x88]), h2_frame(0, 1, s, b"ok")].concat();
                                if script.hint && n == 1 {
                                    // `:status: 103`, a literal with the static table's name.
                                    let _ = tls.write_all(&h2_frame(1, 4, stream, &[0x08, 0x03, b'1', b'0', b'3'])).await;
                                }
                                if n <= script.refuse {
                                    if n == 1 {
                                        let _ = announce.send(stream);
                                    }
                                    let _ = tls.write_all(&h2_frame(3, 0, stream, &7u32.to_be_bytes())).await;
                                } else if n > 1 {
                                    tls.write_all(&respond(stream)).await.unwrap();
                                } else {
                                    let _ = announce.send(stream);
                                    if done.len() == script.trigger {
                                        let mut goaway = script.last.to_be_bytes().to_vec();
                                        goaway.extend_from_slice(&script.code.to_be_bytes());
                                        tls.write_all(&h2_frame(7, 0, 0, &goaway)).await.unwrap();
                                        if script.close {
                                            return;
                                        }
                                        if script.drain {
                                            for s in done.iter().filter(|s| **s <= script.last) {
                                                tls.write_all(&respond(*s)).await.unwrap();
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        (addr, client, seen, announced)
    }

    /// Sends one POST per body length through one client, each started once the stand-in has the one before it complete on
    /// its first connection (so all share it); the results in order, and what the stand-in saw.
    async fn through_goaway(script: Script, lengths: &[usize]) -> (Vec<Result<Vec<u8>, ProviderError>>, Vec<(usize, u32, usize)>) {
        let (addr, tls, seen, mut announced) = goaway_peer(script).await;
        let client = Arc::new(NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls }));
        let mut tasks = Vec::new();
        for len in lengths {
            let (client, len) = (client.clone(), *len);
            tasks.push(tokio::spawn(async move {
                let request = WireRequest {
                    transport: TransportKind::Http1,
                    method: "POST".into(),
                    url: format!("https://localhost:{}/v1/messages", addr.port()),
                    headers: Vec::new(),
                    body: vec![b'x'; len],
                };
                let mut response = client.send(&request, Writer::Fetch, Surface::Fetch).await?;
                assert_eq!(response.status, 200);
                let mut body = Vec::new();
                while let Some(chunk) = response.body.next().await {
                    body.extend_from_slice(&chunk.expect("a drained body"));
                }
                Ok(body)
            }));
            mixdog_rt::time::timeout(WITHIN, announced.recv()).await.expect("the request completes on the first connection within 20 s");
        }
        let mut results = Vec::new();
        for task in tasks {
            results.push(mixdog_rt::time::timeout(WITHIN, task).await.expect("an answer within 20 s").unwrap());
        }
        let seen = seen.lock().unwrap().clone();
        (results, seen)
    }

    fn times(seen: &[(usize, u32, usize)], len: usize) -> usize {
        seen.iter().filter(|(_, _, l)| *l == len).count()
    }

    // Streams 1, 3 and 5 share a connection whose GOAWAY names 3: only the request above it is sent again, on another
    // connection; the two below drain on the first, with no duplicate.
    #[tokio::test]
    async fn only_the_streams_above_a_goaway_cutoff_are_sent_again() {
        let (results, seen) = through_goaway(Script { trigger: 3, last: 3, code: 0, drain: true, close: false, ..Script::NONE }, &[1, 2, 3]).await;
        for result in &results {
            assert_eq!(result.as_ref().unwrap(), b"ok");
        }
        assert_eq!((times(&seen, 1), times(&seen, 2), times(&seen, 3)), (1, 1, 2), "{seen:?}");
        assert!(seen.contains(&(2, 1, 3)), "the excluded request went to a second connection: {seen:?}");
    }

    // A GOAWAY that names 0 excludes the connection's first request, on a connection that was dialled for it.
    #[tokio::test]
    async fn a_first_request_above_the_cutoff_is_sent_again_on_a_new_connection() {
        let (results, seen) = through_goaway(Script { trigger: 1, last: 0, code: 0, drain: false, close: false, ..Script::NONE }, &[3]).await;
        assert_eq!(results[0].as_ref().unwrap(), b"ok");
        assert_eq!(seen, vec![(1, 1, 3), (2, 1, 3)]);
    }

    // After a GOAWAY with an error code the streams below the cutoff fail with the same error as the one above it; only the
    // cutoff tells them apart, so the ones that may have been processed are not sent again.
    #[tokio::test]
    async fn a_stream_below_the_cutoff_that_fails_with_the_goaway_is_not_sent_again() {
        let (results, seen) = through_goaway(Script { trigger: 3, last: 3, code: 11, drain: false, close: true, ..Script::NONE }, &[1, 2, 3]).await;
        for result in &results[..2] {
            assert_eq!(result.as_ref().unwrap_err().delivery, DeliveryState::Ambiguous);
        }
        assert_eq!(results[2].as_ref().unwrap(), b"ok");
        assert_eq!((times(&seen, 1), times(&seen, 2), times(&seen, 3)), (1, 1, 2), "{seen:?}");
    }

    // A response HEADERS, a `103` too, is a sign of processing: a refusal after it is the request's failure, and the peer
    // sees the POST once.
    #[tokio::test]
    async fn a_refusal_after_an_informational_response_is_not_sent_again() {
        let (results, seen) = through_goaway(Script { refuse: 1, hint: true, ..Script::NONE }, &[3]).await;
        assert_eq!(results[0].as_ref().unwrap_err().delivery, DeliveryState::Ambiguous);
        assert_eq!(seen, vec![(1, 1, 3)]);
    }

    #[tokio::test]
    async fn a_goaway_excluding_the_stream_after_an_informational_response_is_not_sent_again() {
        let (results, seen) = through_goaway(Script { trigger: 1, last: 0, hint: true, ..Script::NONE }, &[3]).await;
        assert_eq!(results[0].as_ref().unwrap_err().delivery, DeliveryState::Ambiguous);
        assert_eq!(seen, vec![(1, 1, 3)]);
    }

    async fn drained(mut response: HttpResponse) -> Vec<u8> {
        assert_eq!(response.status, 200);
        let mut body = Vec::new();
        while let Some(chunk) = mixdog_rt::time::timeout(WITHIN, response.body.next()).await.expect("the body within 20 s") {
            body.extend_from_slice(&chunk.expect("a drained body"));
        }
        body
    }

    // The refusal reaches the stream between its HEADERS and its DATA: the body is held until the client has the refusal,
    // so queuing it fails, and the refusal waiting in the response sends the request again; the peer has it once whole.
    #[tokio::test]
    async fn a_refusal_before_the_body_is_queued_is_sent_again() {
        let (addr, tls, seen, _announced) = goaway_peer(Script { refuse: 1, refuse_at_headers: true, ..Script::NONE }).await;
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        let recovered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let found = recovered.clone();
        client.pool.hook(pool::At::Body, || {});
        client.pool.hook(pool::At::Refused, move || found.store(true, std::sync::atomic::Ordering::SeqCst));
        let request = post(addr);
        let response = mixdog_rt::time::timeout(WITHIN, client.send(&request, Writer::Fetch, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        assert_eq!(drained(response).await, b"ok");
        assert!(recovered.load(std::sync::atomic::Ordering::SeqCst), "the failed queue found the refusal in the response");
        assert_eq!(*seen.lock().unwrap(), vec![(2, 1, 3)]);
    }

    /// The connection a request has chosen takes the peer's GOAWAY before the request opens its stream; `warm`: another
    /// request is already on it, so the request reused it. The GOAWAY comes for another stream opened on the connection
    /// meanwhile, and h2 has acted on it once that stream fails with it. What the stand-in saw.
    async fn goaway_before_the_stream(warm: bool) -> Vec<(usize, u32, usize)> {
        let script = if warm { Script { trigger: 2, last: 1, drain: true, ..Script::NONE } } else { Script { trigger: 1, last: 0, ..Script::NONE } };
        let (addr, tls, seen, mut announced) = goaway_peer(script).await;
        let client = Arc::new(NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls }));
        let request = post(addr);
        let url = url::Url::parse(&request.url).unwrap();
        let first = warm.then(|| {
            let (client, first) = (client.clone(), WireRequest { body: vec![b'x'; 1], ..post(addr) });
            tokio::spawn(async move { drained(client.send(&first, Writer::Fetch, Surface::Fetch).await.unwrap()).await })
        });
        if warm {
            mixdog_rt::time::timeout(WITHIN, announced.recv()).await.expect("the first request is on the connection within 20 s");
        }
        let (pool, key, target) = (client.pool.clone(), client.key(&url, &None), url.clone());
        client.pool.gate(pool::At::Stream, async move {
            let Some(Taken::H2 { send, guard, .. }) = pool.checkout(&key) else { panic!("the chosen connection is in the pool") };
            let probe = hyper::http::Request::post(target.as_str()).body(()).unwrap();
            let (response, mut body) = send.ready().await.unwrap().send_request(probe, false).unwrap();
            body.send_data(Bytes::from_static(b"probe"), true).unwrap();
            let goaway = mixdog_rt::time::timeout(WITHIN, response).await.expect("the GOAWAY within 20 s").expect_err("the probe is above the cutoff");
            assert!(goaway.is_go_away() && goaway.is_remote(), "{goaway:?}");
            drop(guard);
        });
        let response = mixdog_rt::time::timeout(WITHIN, client.send(&request, Writer::Fetch, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        assert_eq!(drained(response).await, b"ok");
        if let Some(first) = first {
            assert_eq!(mixdog_rt::time::timeout(WITHIN, first).await.expect("the first answer within 20 s").unwrap(), b"ok");
        }
        seen.lock().unwrap().clone()
    }

    // A request that never got a stream on its reused connection goes to a new one, and the peer has it once.
    #[tokio::test]
    async fn a_goaway_before_the_stream_on_a_reused_connection_sends_the_request_once_elsewhere() {
        assert_eq!(goaway_before_the_stream(true).await, vec![(1, 1, 1), (1, 3, 5), (2, 1, 3)]);
    }

    // On the connection dialled for it too: a request without a stream is not one sent, and needs no allowance to go again.
    #[tokio::test]
    async fn a_goaway_before_the_first_stream_of_a_new_connection_sends_the_request_once_elsewhere() {
        assert_eq!(goaway_before_the_stream(false).await, vec![(1, 1, 5), (2, 1, 3)]);
    }

    #[tokio::test]
    async fn successive_refusals_on_new_connections_are_each_sent_again() {
        let (results, seen) = through_goaway(Script { refuse: 2, ..Script::NONE }, &[3]).await;
        assert_eq!(results[0].as_ref().unwrap(), b"ok");
        assert_eq!(seen, vec![(1, 1, 3), (2, 1, 3), (3, 1, 3)]);
    }

    fn post(addr: SocketAddr) -> WireRequest {
        WireRequest {
            transport: TransportKind::Http1,
            method: "POST".into(),
            url: format!("https://localhost:{}/v1/messages", addr.port()),
            headers: Vec::new(),
            body: vec![b'x'; 3],
        }
    }

    /// Until the stand-in has seen `n` complete requests, at most `WITHIN`.
    async fn attempts(seen: &Seen, n: usize) {
        let counted = mixdog_rt::time::timeout(WITHIN, async {
            while seen.lock().unwrap().len() < n {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(counted.is_ok(), "{n} attempts within 20 s: {:?}", seen.lock().unwrap());
    }

    // A peer that refuses every request is sent to until the request's deadline ends it, with no fixed attempt count.
    #[tokio::test]
    async fn successive_refusals_end_at_the_requests_deadline() {
        let (addr, tls, seen, _announced) = goaway_peer(Script { refuse: usize::MAX, ..Script::NONE }).await;
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        let request = post(addr);
        let mut send = std::pin::pin!(client.send(&request, Writer::Fetch, Surface::Fetch));
        tokio::select! {
            ended = &mut send => panic!("ended before its deadline: {:?}", ended.map(|response| response.status)),
            () = attempts(&seen, 3) => {}
        }
        // The deadline comes now.
        assert!(mixdog_rt::time::timeout(Duration::ZERO, send).await.is_err(), "still being sent when the deadline came");
    }

    // ... or at its cancellation.
    #[tokio::test]
    async fn successive_refusals_end_at_the_requests_cancellation() {
        let (addr, tls, seen, _announced) = goaway_peer(Script { refuse: usize::MAX, ..Script::NONE }).await;
        let client = Arc::new(NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls }));
        let request = post(addr);
        let task = tokio::spawn(async move { client.send(&request, Writer::Fetch, Surface::Fetch).await.map(|_| ()) });
        attempts(&seen, 4).await;
        task.abort();
        let ended = mixdog_rt::time::timeout(WITHIN, task).await.expect("the task ends within 20 s");
        assert!(ended.unwrap_err().is_cancelled());
    }

    /// What the trailing stand-in saw: the connections it accepted, each complete request (connection, stream), each
    /// RST_STREAM the client sent (stream, code), and the GOAWAY the client sent (code, debug data).
    #[derive(Default)]
    struct Trailed {
        connections: usize,
        requests: Vec<(usize, u32)>,
        resets: Vec<(u32, u32)>,
        goaway: Option<(u32, Vec<u8>)>,
    }

    /// How many later requests a stream's closing frames wait behind: more than the reset streams h2 remembers (50), so a
    /// stream the client resets at once is forgotten before they arrive.
    const LAG: usize = 60;

    /// A TLS h2 stand-in that answers each request without a body as a model's stream ends: its head and an event at once,
    /// then a closing event and END_STREAM once `LAG` later requests came, frames already on their way when the reader stopped.
    /// Every DATA frame with a payload holds 256 bytes or more, which h2's DATA frame budget never counts. A request with a
    /// body gets every closing frame still held and is answered whole, or, with `close`, ends the connection.
    async fn trailing_peer(close: bool) -> (SocketAddr, Arc<rustls::ClientConfig>, Arc<std::sync::Mutex<Trailed>>) {
        let (acceptor, client) = tls_stand_in();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Trailed::default()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let n = {
                    let mut seen = log.lock().unwrap();
                    seen.connections += 1;
                    seen.connections
                };
                let (acceptor, log) = (acceptor.clone(), log.clone());
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                    let mut preface = [0u8; 24];
                    if tls.read_exact(&mut preface).await.is_err() || tls.write_all(&h2_frame(4, 0, 0, &[])).await.is_err() {
                        return;
                    }
                    let event = [b'e'; 300];
                    let closing = |stream: u32| [h2_frame(0, 0, stream, &event), h2_frame(0, 1, stream, &[])].concat();
                    let mut held = std::collections::VecDeque::new();
                    loop {
                        let mut head = [0u8; 9];
                        if tls.read_exact(&mut head).await.is_err() {
                            return;
                        }
                        let len = u32::from_be_bytes([0, head[0], head[1], head[2]]) as usize;
                        let stream = u32::from_be_bytes([head[5] & 0x7f, head[6], head[7], head[8]]);
                        let mut payload = vec![0u8; len];
                        if tls.read_exact(&mut payload).await.is_err() {
                            return;
                        }
                        let reply = match (head[3], head[4] & 1 != 0) {
                            (4, false) => h2_frame(4, 1, 0, &[]),
                            // A request whole with its HEADERS: a model's stream, whose closing frames wait.
                            (1, true) => {
                                log.lock().unwrap().requests.push((n, stream));
                                held.push_back(stream);
                                let mut reply = [h2_frame(1, 4, stream, &[0x88]), h2_frame(0, 0, stream, &event)].concat();
                                if held.len() > LAG {
                                    reply.extend(closing(held.pop_front().unwrap()));
                                }
                                reply
                            }
                            // A request whose body ends here.
                            (0, true) => {
                                log.lock().unwrap().requests.push((n, stream));
                                if close {
                                    return;
                                }
                                let mut reply: Vec<u8> = held.drain(..).flat_map(closing).collect();
                                reply.extend([h2_frame(1, 4, stream, &[0x88]), h2_frame(0, 1, stream, b"ok")].concat());
                                reply
                            }
                            (3, _) => {
                                let code = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                                log.lock().unwrap().resets.push((stream, code));
                                continue;
                            }
                            (7, _) => {
                                let code = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]);
                                log.lock().unwrap().goaway = Some((code, payload[8..].to_vec()));
                                return;
                            }
                            _ => continue,
                        };
                        if tls.write_all(&reply).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (addr, client, seen)
    }

    fn get(addr: SocketAddr) -> WireRequest {
        WireRequest { method: "GET".into(), body: Vec::new(), ..post(addr) }
    }

    /// A model's stream on the trailing stand-in, read to its first event; its closing frames are still to come.
    async fn opened(client: &NodeClient, addr: SocketAddr) -> HttpResponse {
        let mut response =
            mixdog_rt::time::timeout(WITHIN, client.send(&get(addr), Writer::Raw, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        let event = mixdog_rt::time::timeout(WITHIN, response.body.next()).await.expect("the event within 20 s");
        assert_eq!(event.unwrap().unwrap().len(), 300);
        response
    }

    /// Until `done` holds, at most `WITHIN`.
    async fn until(what: &str, done: impl Fn() -> bool) {
        let met = mixdog_rt::time::timeout(WITHIN, async {
            while !done() {
                mixdog_rt::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(met.is_ok(), "{what} within 20 s");
    }

    // A model's turn ends at its terminal event, before its stream's last frames. Thousands of such streams on one connection,
    // each read to its END_STREAM off the reader's path, reset none, and the connection serves on; the same streams cancelled
    // reach h2's reset limit well before (`cancelled_streams_still_reset_and_a_local_goaway_logs_its_reason`).
    #[tokio::test]
    async fn thousands_of_finished_streams_reset_none_and_keep_their_connection() {
        let (lines, _capture) = mixdog_rt::node_log::capture();
        let (addr, tls, seen) = trailing_peer(false).await;
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        let mut conn = None;
        for _ in 0..2_000 {
            let mut response = opened(&client, addr).await;
            let id = response.body.connection().expect("an h2 body names its connection").id;
            conn.get_or_insert_with(|| client.pool.conn_state(id).expect("a live connection"));
            response.body.drain_on_drop();
        }
        // Every closing frame still held comes ahead of this answer.
        let tail = mixdog_rt::time::timeout(WITHIN, client.send(&post(addr), Writer::Raw, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        assert_eq!(drained(tail).await, b"ok");
        let conn = conn.expect("the shared connection");
        // Each read-out ends at its END_STREAM: no stream is open on the connection, and none is held by anything still reading.
        until("every read-out ended", || conn.open_streams() == 0 && conn.exchanges() == 0).await;
        let seen = seen.lock().unwrap();
        assert!(seen.resets.is_empty(), "no stream was reset: {:?}", &seen.resets[..seen.resets.len().min(5)]);
        assert!(seen.goaway.is_none());
        assert_eq!(seen.connections, 1);
        assert!(seen.requests.len() == 2_001 && seen.requests.iter().all(|(n, _)| *n == 1));
        let lines: Vec<String> = lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
        assert!(!lines.iter().any(|line| line.contains("goaway")), "{lines:?}");
    }

    // The same streams let go of before their end, as a turn the user stops is: each is reset (CANCEL), and the closing
    // frames that cross the resets of streams h2 no longer remembers count toward its local reset limit, until it ends the
    // connection with a GOAWAY whose reason the log names.
    #[tokio::test]
    async fn cancelled_streams_still_reset_and_a_local_goaway_logs_its_reason() {
        let (lines, _capture) = mixdog_rt::node_log::capture();
        let (addr, tls, seen) = trailing_peer(false).await;
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        let mut streams = 0;
        while seen.lock().unwrap().goaway.is_none() {
            assert!(streams < 2_000, "the reset limit within the streams finished ones keep their connection through");
            streams += 1;
            let Ok(Ok(mut response)) = mixdog_rt::time::timeout(WITHIN, client.send(&get(addr), Writer::Raw, Surface::Fetch)).await else {
                continue;
            };
            let _ = mixdog_rt::time::timeout(WITHIN, response.body.next()).await;
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.resets.first(), Some(&(1, u32::from(h2::Reason::CANCEL))), "a body let go of unfinished is a cancel");
        assert!(seen.resets.iter().any(|(_, code)| *code == u32::from(h2::Reason::STREAM_CLOSED)), "frames crossed forgotten resets");
        let goaway = seen.goaway.as_ref().map(|(code, debug)| (*code, debug.as_slice()));
        assert_eq!(goaway, Some((u32::from(h2::Reason::ENHANCE_YOUR_CALM), &b"too_many_internal_resets"[..])));
        let lines: Vec<String> = lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
        assert!(lines.iter().any(|line| line.contains("protocol=h2 goaway by=local code=11 last_stream_id=0 reason=too_many_internal_resets ")), "{lines:?}");
    }

    // A finished stream's read-out ends with its connection too: the peer ends the connection with the closing frames still
    // held, and nothing is left reading the stream or holding the connection for it.
    #[tokio::test]
    async fn a_finished_streams_read_out_ends_with_its_connection() {
        let (addr, tls, seen) = trailing_peer(true).await;
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        let mut response = opened(&client, addr).await;
        let id = response.body.connection().expect("an h2 body names its connection").id;
        let conn = client.pool.conn_state(id).expect("a live connection");
        response.body.drain_on_drop();
        drop(response);
        assert_eq!((conn.open_streams(), conn.exchanges()), (1, 1), "the stream is read off, not reset");
        let ended = mixdog_rt::time::timeout(WITHIN, client.send(&post(addr), Writer::Raw, Surface::Fetch)).await.expect("an answer within 20 s");
        assert!(ended.is_err(), "the peer ended the connection under the request");
        until("the read-out ended", || conn.exchanges() == 0).await;
        assert!(seen.lock().unwrap().resets.is_empty());
    }

    // A body whose read failed is not finished, marked before the failure or after it: its drop cancels the stream instead of
    // reading off one known to stall. Here the reader's deadline cuts the read short, as the driver's idle deadline does, while
    // the closing frames are held; a body marked without a failed read is read off.
    #[tokio::test]
    async fn a_body_whose_read_failed_is_cancelled_however_it_was_marked() {
        let (addr, tls, seen) = trailing_peer(false).await;
        let client = NodeClient::pinned(KeepaliveSchedule::SPEC.tcp, Pinned { addr, tls });
        for marked_before in [true, false] {
            let mut response = opened(&client, addr).await;
            if marked_before {
                response.body.drain_on_drop();
            }
            let cut = mixdog_rt::time::timeout(Duration::from_millis(50), response.body.next()).await;
            assert!(cut.is_err(), "the stream stalls until the peer sends its closing frames");
            response.body.drain_on_drop();
        }
        let mut response = opened(&client, addr).await;
        response.body.drain_on_drop();
        drop(response);
        // The resets of the first two streams were written before this request, which sends every closing frame still held.
        let tail = mixdog_rt::time::timeout(WITHIN, client.send(&post(addr), Writer::Raw, Surface::Fetch)).await.expect("an answer within 20 s").unwrap();
        assert_eq!(drained(tail).await, b"ok");
        let cancel = u32::from(h2::Reason::CANCEL);
        assert_eq!(seen.lock().unwrap().resets, vec![(1, cancel), (3, cancel)], "the third stream is read off");
    }
}

/// The pin of a process a replay spawns: every connect goes to `REPLAY_PROVIDER_PIN` (the stand-in's address) and
/// trusts the DER certificate at `REPLAY_PROVIDER_PIN_CERT` alone, so the real binary runs against a stand-in
/// provider. Read once; neither set, nothing is pinned. Not `MIXDOG_*`: an exec's boundary removes those from the
/// process before its core builds a client.
#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::disallowed_methods, reason = "read once, when the first client is built; a test-only switch")]
fn pin_from_env() -> Option<Pinned> {
    static PIN: OnceLock<Option<(SocketAddr, Arc<rustls::ClientConfig>)>> = OnceLock::new();
    PIN.get_or_init(|| {
        let addr = std::env::var("REPLAY_PROVIDER_PIN").ok()?;
        let addr: SocketAddr = addr.parse().expect("REPLAY_PROVIDER_PIN is a socket address");
        let cert = std::env::var_os("REPLAY_PROVIDER_PIN_CERT").expect("REPLAY_PROVIDER_PIN_CERT names the stand-in's certificate");
        let der = std::fs::read(cert).expect("the stand-in's certificate");
        let mut roots = rustls::RootCertStore::empty();
        roots.add(rustls::pki_types::CertificateDer::from(der)).expect("a DER certificate");
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = ALPN.iter().map(|p| p.to_vec()).collect();
        Some((addr, Arc::new(config)))
    })
    .as_ref()
    .map(|(addr, tls)| Pinned { addr: *addr, tls: tls.clone() })
}
fn chain_error(err: &(dyn std::error::Error + 'static), delivery: DeliveryState, surface: Surface) -> ProviderError {
    let fault = super::fault::fault_from_chain(err, false);
    let message = surface.text(|| format!("{fault:?}"));
    let mut error = ProviderError::transport(fault, delivery);
    error.message = message;
    error
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
            pinned: pin_from_env(),
            #[cfg(any(test, feature = "test-support"))]
            tap: std::sync::Mutex::new(None),
            pool,
            _retire: retire,
        }
    }

    /// Every connect goes to `addr` and trusts `tls` alone.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pinned(tcp: TcpKeepalive, pinned: Pinned) -> Self {
        Self { pinned: Some(pinned), ..Self::new(tcp, None) }
    }

    /// Runs `tap` with each request once it has its connection (`None`: no longer), as Node's recorder taps the
    /// dispatches of the global dispatcher (`node-wire-capture.mjs` `tapDispatches`).
    #[cfg(any(test, feature = "test-support"))]
    pub fn tap(&self, tap: Option<Tap>) {
        *self.tap.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = tap;
    }

    /// [`Pool::settled`]: every exchange so far has given its connection back, vacated its client or closed it.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn settled(&self) {
        self.pool.settled().await;
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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
        format!("{epoch}|{}|{}://{}:{}", proxy.as_deref().unwrap_or(""), url.scheme(), url.host_str().unwrap_or_default(), origin_port(url))
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn dial(&self, url: &url::Url, proxy: &Option<String>, surface: Surface) -> Result<(Stream, bool), ProviderError> {
        let bare = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
        let tcp_stream = self.connect_tcp(&bare, origin_port(url), proxy, surface).await?;
        if url.scheme() != "https" {
            return Ok((tcp_stream, false));
        }
        self.handshake_tls(bare, tcp_stream, surface).await
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn connect_tcp(&self, host: &str, port: u16, proxy: &Option<String>, surface: Surface) -> Result<Stream, ProviderError> {
        if let Some(addr) = self.pinned_addr() {
            let socket = tcp::connect(addr, &self.tcp).await.map_err(|e| io_error(&e, true, DeliveryState::NotSent, surface))?;
            return Ok(Box::new(socket));
        }
        if let Some(proxy) = proxy {
            return Ok(Box::new(open_proxy_tunnel(proxy, host, port, &self.tcp).await.map_err(|e| tunnel_error(e, surface))?));
        }
        let addrs = tokio::net::lookup_host((host, port)).await.map_err(|_| dns_error(surface))?;
        let mut failure = None;
        for addr in addrs {
            match tcp::connect(addr, &self.tcp).await {
                Ok(socket) => return Ok(Box::new(socket)),
                Err(e) => failure = Some(e),
            }
        }
        Err(failure.map_or_else(|| dns_error(surface), |e| io_error(&e, true, DeliveryState::NotSent, surface)))
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn handshake_tls(&self, host: String, tcp_stream: Stream, surface: Surface) -> Result<(Stream, bool), ProviderError> {
        let config = match self.pinned_tls() {
            Some(config) => config,
            None => tls_config().map_err(|e| io_error(&e, true, DeliveryState::NotSent, surface))?,
        };
        let name = rustls::pki_types::ServerName::try_from(host).map_err(|_| ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent))?;
        let tls = tokio_rustls::TlsConnector::from(config).connect(name, tcp_stream).await.map_err(|e| {
            // A socket reset during the handshake is the socket's fault, as undici reports it (`ECONNRESET`), not TLS's.
            if matches!(e.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) {
                return io_error(&e, false, DeliveryState::NotSent, surface);
            }
            let mut error = ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent);
            error.message = surface.text(|| e.to_string());
            error
        })?;
        let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
        Ok((Box::new(tls), h2))
    }

    /// An HTTP/2 connection over `io`, pooled under `key`, whose end is logged and removed from the pool by its own task.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn open_h2(
        &self,
        io: Stream,
        key: &str,
        url: &url::Url,
        proxy: &Option<String>,
        generation: u64,
        surface: Surface,
    ) -> Result<(u64, h2::client::SendRequest<Bytes>, pool::H2Guard), ProviderError> {
        let id = self.pool.birth();
        let conn = goaway::ConnState::new(id);
        let (send, connection) = h2::client::handshake(goaway::Tapped::new(io, conn.clone())).await.map_err(|e| {
            let mut error = ProviderError::transport(TransportFault::Tls, DeliveryState::NotSent);
            error.message = surface.text(|| e.to_string());
            error
        })?;
        self.pool.track_conn(conn.clone(), id);
        let (pool, origin) = (self.pool.clone(), key.to_owned());
        // The log names the connection by this, never by the pool key, which holds the proxy URL as configured.
        let route = loggable_route(url, proxy);
        tokio::spawn(async move {
            // A failure reaches every request on the connection through h2, each carrying this id
            // (`ProviderError::connection`); this line names what ended the connection itself, in the
            // daemon log, not `tracing`.
            if let Err(error) = connection.await {
                mixdog_rt::node_stderr!(
                    "[http] connection={id} protocol=h2 route={route} ended with an error: {} {}",
                    super::fault::describe_h2_end(&error),
                    conn.counts()
                );
            }
            pool.remove_h2(&origin, id);
            pool.forget_conn(id);
        });
        let guard = self.pool.put_h2(key.to_owned(), id, send.clone(), generation);
        Ok((id, send, guard))
    }

    /// One request, no redirects. A request the protocol proves unprocessed (above the peer's GOAWAY cutoff, or refused,
    /// before any response header) is sent again on another connection; one that provably did not leave whole on a reused
    /// connection is sent again once; one the server may have executed is not.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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
        let flight = self.pool.begin();
        let mut replayed = false;
        loop {
            // Dispatched: the connection is chosen now (or none, and one is dialled).
            let chosen = self.pool.checkout(&key);
            #[cfg(any(test, feature = "test-support"))]
            if let Some(tap) = self.tap.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
                tap(request);
            }
            // undici resumes the client of a request whose body is an iterable of unknown length (a `fetch` body is
            // its stream) one microtask after `dispatch` (`client.js:414` `queueMicrotask(() => resume(this))`), so
            // its socket's validation turn and its write come after those of a request dispatched after it in the
            // same turn; a body-less or raw `undici.request` client resumes inside `dispatch`. A turn is this task's
            // poll: such a request yields once here.
            if writer == Writer::Fetch && !request.body.is_empty() {
                tokio::task::yield_now().await;
            }
            let reused = self.pool.validated(chosen).await;
            let was_reused = matches!(reused, Some(Taken::H1(_) | Taken::H2 { .. }));
            let outcome = match reused {
                Some(Taken::H1(mut conn)) => {
                    conn.flight = Some(flight.clone());
                    self.exchange_h1(conn, &key, request, &url, writer, surface).await
                }
                Some(Taken::H2 { id, send, guard }) => self.exchange_h2(&key, id, send, guard, request, &url, writer, surface).await,
                slot @ (None | Some(Taken::Vacant(_))) => {
                    // A client of the pool connects again in its own place; otherwise a new client is made.
                    let born = match slot {
                        Some(Taken::Vacant(slot)) => slot,
                        _ => self.pool.birth(),
                    };
                    #[cfg(test)]
                    self.pool.at(pool::At::Dial);
                    let dialled = mixdog_rt::time::timeout(CONNECT_TIMEOUT, self.dial(&url, &proxy, surface))
                        .await
                        .map_err(|_| timed_out("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error", DeliveryState::NotSent, surface))??;
                    let (io, h2) = dialled;
                    if h2 {
                        let (id, send, guard) = self.open_h2(io, &key, &url, &proxy, generation, surface).await?;
                        self.exchange_h2(&key, id, send, guard, request, &url, writer, surface).await
                    } else {
                        let mut conn = h1::Conn::open(io, born, generation).await.map_err(|e| chain_error(&e, DeliveryState::NotSent, surface))?;
                        conn.track(&self.pool, &key);
                        conn.flight = Some(flight.clone());
                        self.exchange_h1(conn, &key, request, &url, writer, surface).await
                    }
                }
            };
            match outcome {
                // Proven unprocessed, on a reused connection or a new one: sent again until it is answered, fails otherwise,
                // or the request is cancelled or its deadline drops this future.
                Err(failure) if failure.free || failure.error.delivery == DeliveryState::NotProcessed => {}
                Err(failure) if was_reused && failure.replay && !replayed => replayed = true,
                Err(failure) => return Err(failure.error),
                Ok(response) => return Ok(response),
            }
        }
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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
        conn.ready().await.map_err(|e| Failure { error: chain_error(&e, DeliveryState::NotSent, surface), replay: true, free: false })?;
        super::model_driver::connected();
        // Once the first byte may have left, the request is never sent again: undici fails the request that was running
        // when its socket dies (`client-h1.js` `onHttpSocketClose`) and re-queues only those not yet written. A write
        // error, wherever in the head, the body or the final flush, is therefore the request's error.
        let answered = mixdog_rt::time::timeout(HEADERS_TIMEOUT, conn.exchange(&head, &request.body, &request.method, close)).await;
        let (response, written) = match answered {
            Err(_) => {
                let error = timed_out("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error", DeliveryState::Ambiguous, surface);
                return Err(Failure { error, replay: false, free: false });
            }
            Ok(h1::Exchange::NotWritten(e)) => {
                return Err(Failure { error: io_error(&e, false, DeliveryState::Ambiguous, surface), replay: false, free: false });
            }
            Ok(h1::Exchange::Unanswered(e)) => return Err(Failure { error: chain_error(&e, DeliveryState::Ambiguous, surface), replay: false, free: false }),
            Ok(h1::Exchange::Answered { response, written }) => (response, written),
        };
        let (parts, incoming) = response.into_parts();
        // llhttp refuses a response that frames its body twice (`HPE_UNEXPECTED_CONTENT_LENGTH`); hyper would read it
        // as chunked and keep the connection.
        if parts.headers.contains_key(hyper::header::TRANSFER_ENCODING) && parts.headers.contains_key(hyper::header::CONTENT_LENGTH) {
            let framing = io::Error::new(io::ErrorKind::InvalidData, "Content-Length can't be present with Transfer-Encoding");
            return Err(Failure { error: io_error(&framing, false, DeliveryState::Ambiguous, surface), replay: false, free: false });
        }
        let status = parts.status.as_u16();
        let headers = header_pairs(&parts.headers);
        let find = |name: &str| headers.iter().find(|(known, _)| known == name).map(|(_, value)| value.as_str());
        let tokens = |name: &str| find(name).map(str::to_ascii_lowercase).unwrap_or_default();
        let (connection, old) = (tokens("connection"), parts.version == hyper::Version::HTTP_10);
        let server_closes = connection.split(',').any(|t| t.trim() == "close") || (old && !connection.contains("keep-alive"));
        // `keep-alive: timeout=N` (`client-h1.js` `onHeadersComplete`): the hint less the threshold, at most the maximum.
        let hint = find("keep-alive")
            .and_then(|v| v.split(',').find_map(|part| part.trim().strip_prefix("timeout=")?.trim().parse::<u64>().ok()))
            .map(Duration::from_secs);
        let ttl = hint.map_or(KEEP_ALIVE, |h| h.saturating_sub(KEEP_ALIVE_THRESHOLD).min(KEEP_ALIVE_MAX));
        let decoder = decoding(&headers, &request.method, status)?;
        let reuse = (!close && !server_closes && written).then(|| Reuse { pool: self.pool.clone(), key: key.to_owned(), ttl });
        Ok(HttpResponse { status, headers, body: super::link::replay_counted(url, Box::new(H1Body::new(incoming, conn, decoder, reuse))) })
    }

    #[allow(clippy::too_many_arguments, reason = "one exchange's connection, request and surface")]
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn exchange_h2(
        &self,
        key: &str,
        id: u64,
        send: h2::client::SendRequest<Bytes>,
        // The connection is idle again when this stream and every other has ended (`H2Body` holds the guard).
        mut guard: pool::H2Guard,
        request: &WireRequest,
        url: &url::Url,
        writer: Writer,
        surface: Surface,
    ) -> Result<HttpResponse, Failure> {
        super::model_driver::connected();
        let conn = self.pool.conn_state(id);
        // A connection that errs is no longer offered to the next request. `stream` is the failed stream's number once it has
        // one: before that nothing was written, and after it the protocol must prove the request was not processed.
        let failed = |e: &h2::Error, stream: Option<u32>| {
            self.pool.remove_h2(key, id);
            let fault = super::fault::fault_from_chain(e, false);
            let refusal = e.is_remote() && (e.is_go_away() || e.reason() == Some(h2::Reason::REFUSED_STREAM));
            // Any response HEADERS (a 103 included) is a sign of processing that no later refusal undoes.
            let answered = stream.is_some_and(|stream| conn.as_ref().is_some_and(|conn| conn.answered(stream)));
            let proven = match stream {
                None => false,
                Some(stream) => {
                    !answered
                        && ((e.is_remote() && e.is_reset() && e.reason() == Some(h2::Reason::REFUSED_STREAM))
                            || (e.is_remote() && e.is_go_away() && conn.as_ref().is_some_and(|conn| conn.excluded(stream))))
                }
            };
            let delivery = match (proven, stream) {
                (true, _) => DeliveryState::NotProcessed,
                (false, None) => DeliveryState::NotSent,
                (false, Some(_)) => DeliveryState::Ambiguous,
            };
            let mut error = ProviderError::transport(fault, delivery);
            error.message = surface.text(|| e.to_string());
            error.connection = Some(ConnectionInfo { id, protocol: "h2" });
            mixdog_rt::node_stderr!(
                "[http] connection={id} stream={} protocol=h2 failed: {} headers_received={answered} not_processed={proven} {}",
                stream.map_or_else(|| "none".to_owned(), |s| s.to_string()),
                super::fault::describe_h2_end(e),
                conn.as_ref().map_or_else(String::new, |conn| conn.counts())
            );
            Failure { error, replay: stream.is_none() || proven, free: stream.is_none() && refusal }
        };
        let built = h2_request(request, url, writer).map_err(|e| Failure { error: refused(e.to_string(), surface), replay: false, free: false })?;
        // Reserved before the stream opens: response HEADERS that come before the guard holds the stream are kept for it.
        if let Some(conn) = &conn {
            guard.reserve(conn.clone());
        }
        #[cfg(test)]
        self.pool.pass(pool::At::Stream).await;
        let mut send = send.ready().await.map_err(|e| failed(&e, None))?;
        let (response, mut stream) = send.send_request(built, request.body.is_empty()).map_err(|e| failed(&e, None))?;
        let number = stream.stream_id().as_u32();
        guard.attach(number);
        let mut response = Box::pin(response);
        let mut early = None;
        #[cfg(test)]
        if self.pool.at(pool::At::Body) {
            let _ = std::future::poll_fn(|cx| stream.poll_reset(cx)).await;
        }
        let queued = if request.body.is_empty() { Ok(()) } else { stream.send_data(Bytes::from(request.body.clone()), true) };
        if let Err(e) = queued {
            // A stream the peer already closed refuses the body with a user error (`InactiveStreamId`) that says nothing of
            // why; the remote error that closed it waits in the response. That error decides, and the user error alone never
            // proves anything.
            match std::future::poll_fn(|cx| Poll::Ready(response.as_mut().poll(cx))).await {
                Poll::Ready(Err(remote)) => {
                    #[cfg(test)]
                    self.pool.at(pool::At::Refused);
                    return Err(failed(&remote, Some(number)));
                }
                Poll::Ready(Ok(answer)) => early = Some(answer),
                Poll::Pending => return Err(failed(&e, Some(number))),
            }
        }
        let response = match early {
            Some(answer) => answer,
            None => match mixdog_rt::time::timeout(HEADERS_TIMEOUT, response).await {
                Err(_) => {
                    let error = timed_out("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error", DeliveryState::Ambiguous, surface);
                    return Err(Failure { error, replay: false, free: false });
                }
                Ok(response) => response.map_err(|e| failed(&e, Some(number)))?,
            },
        };
        let status = response.status().as_u16();
        let list = header_pairs(response.headers());
        let decoder = decoding(&list, &request.method, status)?;
        Ok(HttpResponse { status, headers: list, body: super::link::replay_counted(url, Box::new(H2Body::new(response.into_body(), decoder, id, guard))) })
    }
}
#[async_trait]
impl BodyStream for H2Body {
    fn connection(&self) -> Option<ConnectionInfo> {
        Some(ConnectionInfo { id: self.id, protocol: "h2" })
    }

    fn drain_on_drop(&mut self) {
        self.done = true;
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            // The decoder's steps first, one at a time; the stream is read again only when it has nothing left.
            if let Some(decoder) = self.decoder.as_mut() {
                match decoder.step() {
                    Err(_) => {
                        self.decoder = None;
                        self.ended = true;
                        return Some(Err(TransportFault::CorruptBody));
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
            let wire = self.wire.as_mut()?;
            self.reading = true;
            let read = mixdog_rt::time::timeout(BODY_TIMEOUT, wire.stream.data()).await;
            self.reading = false;
            let data = match read {
                Err(_) => {
                    self.failed = true;
                    return Some(Err(TransportFault::Io { os_code: None }));
                }
                Ok(data) => data,
            };
            let Some(data) = data else {
                // The stream ended: the decoder finishes as undici's flush settings finish it.
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
                Err(e) => {
                    // h2 gives every stream of a connection that ended (an I/O error, a GOAWAY, a protocol error) that
                    // connection's own error; only a RST_STREAM is this stream's alone. The connection leaves the pool
                    // here, before the fault reaches the caller and its retry dials, and does not wait for its task.
                    if !e.is_reset() {
                        wire.guard.retire();
                    }
                    // Each stream's own end, with its number: the streams a connection's end took, and which of them a GOAWAY
                    // named (those above its last stream id fail with it at once).
                    mixdog_rt::node_stderr!(
                        "[http] connection={} stream={} protocol=h2 failed: {} headers_received=true {}",
                        self.id,
                        wire.stream.stream_id().as_u32(),
                        super::fault::describe_h2_end(&e),
                        wire.guard.counts()
                    );
                    self.failed = true;
                    return Some(Err(super::fault::fault_from_chain(&e, false)));
                }
            };
            let _ = wire.stream.flow_control().release_capacity(raw.len());
            match self.decoder.as_mut() {
                Some(decoder) => decoder.feed(&raw),
                None if !raw.is_empty() => return Some(Ok(raw)),
                None => {}
            }
        }
    }
}
