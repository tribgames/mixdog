//! The shared outbound seams of every provider package, and their one
//! implementation: an HTTP exchange that returns the response head and a
//! streaming body ([`HttpSend`]), a request-streaming exchange ([`BidiOpen`]),
//! and a WebSocket dial ([`WsDial`]). Connections carry the keepalive
//! schedule; nothing behind these seams measures time between bytes.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::Expired;
use mixdog_rt::Liveness;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;

use crate::netproxy::NetworkProxy;
use crate::netproxy::ProxyConfigError;
use crate::netproxy::RouteError;
use crate::netproxy::RoutedClients;
use crate::netproxy::clients::ClientError;

use super::deadlines::NODE_DISPATCHER;
use super::fault::fault_from_reqwest;
use super::fault::provider_error_from_reqwest;
use super::http::client_builder;
use super::node_http::NodeClient;
#[cfg(any(test, feature = "test-support"))]
use super::node_http::Pinned;
use super::node_http::Writer;
use super::ws;
use super::ws::ConnectError;
use super::ws::Message;
use super::ws::WsConnection;

#[async_trait]
pub trait BodyStream: Send {
    /// The next body chunk; `None` at a clean end of body. A fault is the
    /// transport fact that ended the body.
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>>;

    /// Keeps the connection of a body read to its end out of the pool until this body is dropped: Node's response
    /// returns its socket only after the code that drained it has run on (`resendIfEncodingRejected` resends before
    /// the socket is free, so the resend dials a new one). The default does nothing.
    fn hold_connection(&mut self) {}
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn BodyStream>,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The whole body. A fault mid-body is a transport error with `Accepted`
    /// delivery: the caller holds a status and no content.
    pub async fn read_all(mut self) -> Result<ErrorResponse, ProviderError> {
        let body = drain(&mut self.body).await?;
        Ok(ErrorResponse {
            status: Some(self.status),
            headers: self.headers,
            body,
        })
    }

    /// [`Self::read_all`] with the connection kept out of the pool until the returned body is dropped
    /// ([`BodyStream::hold_connection`]): a Node caller that reads an answer and sends its next request on the same
    /// turn of the event loop finds the answer's socket still busy.
    pub async fn read_all_held(mut self) -> Result<(ErrorResponse, Box<dyn BodyStream>), ProviderError> {
        self.body.hold_connection();
        let body = drain(&mut self.body).await?;
        Ok((ErrorResponse { status: Some(self.status), headers: self.headers, body }, self.body))
    }
}

/// The whole of `body`. A fault mid-body is a transport error with `Accepted` delivery: the caller holds a status and no
/// content.
async fn drain(stream: &mut Box<dyn BodyStream>) -> Result<Vec<u8>, ProviderError> {
    let mut body = Vec::new();
    // A whole-body read is never a stream of content: a `Unary` body already
    // ends at its own total, and the error body of a `Stream` response ends at
    // the dispatcher ceiling (Node `http-agent.mjs:414` `bodyTimeout`).
    let drained = NODE_DISPATCHER
        .liveness
        .bound_head(async {
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => body.extend_from_slice(&bytes),
                    Err(fault) => {
                        return Err(ProviderError::transport(fault, DeliveryState::Accepted));
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(|expired| deadline_error(expired, DeliveryState::Accepted, NODE_DISPATCHER.surface))?;
    drained?;
    Ok(body)
}

/// What the link does with a 3xx answer, chosen per request to match the Node call site
/// (`fetch` follows by default, up to 20 hops; a call site that bears credentials sets
/// `redirect: 'error'` or `'manual'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redirect {
    /// `fetch` default: follow up to 20 redirects. Credentials stay on the origin they were
    /// meant for: `authorization`, `cookie` and `proxy-authorization` are dropped across origins,
    /// and a 301/302 on POST or a 303 becomes a body-less GET, as in the fetch spec.
    Follow,
    /// `redirect: 'error'`: a 3xx is a network error.
    Error,
    /// `redirect: 'manual'`: the 3xx response is returned as is.
    Manual,
}

/// The text a failed exchange reads as, which the Node call site decides: what a connection that
/// never produced a status (refused, unresolved, reset, a restricted port, a refused or endless
/// redirect) is called by the code that issued the request. The typed [`TransportFault`] on the
/// error stays the only thing logic reads; this is the sentence users and logs see.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// A raw `fetch` with no timer of its own: its network errors are `TypeError: fetch failed`, whatever the
    /// cause, and so is a missed undici `headersTimeout` (`HeadersTimeoutError` is the `cause`).
    Fetch,
    /// A raw `fetch` under `AbortSignal.timeout(ms)`: the same `fetch failed` for the network, and the
    /// `TimeoutError` DOMException itself when the timer fires.
    FetchSignal,
    /// A raw `fetch` whose caller aborts a controller on a bare `setTimeout`: `AbortError` when the timer fires.
    FetchAborted,
    /// A raw `fetch` under `createTimeoutSignal(…, label)` (`stall-policy.mjs:384`): the signal's reason, a
    /// `ProviderTimeoutError` `"<label> timed out after <ms>ms"`, is what the fetch rejects with.
    FetchLabeled(&'static str),
    /// The OpenAI / Anthropic SDK: it wraps a connect failure of its fetch as
    /// `APIConnectionError: Connection error.`; its own timer (and an abort at connect) throws
    /// `APIConnectionTimeoutError: Request timed out.`.
    Sdk,
    /// Node's `http2`: a socket error whose text names the resolved address (`connect ECONNREFUSED
    /// 1.2.3.4:443`), which the link cannot know; the fault's own description stands.
    Socket,
    /// Node's `http2` under `providerTimeoutError(label, ms)` (`callCursorUnary`, `cursor-wire-transport.mjs:274`): the
    /// socket's own text for a connection failure, `"<label> timed out after <ms>ms"` when the timer fires.
    SocketLabeled(&'static str),
    /// The Cursor stream's connect timer (`CONNECT_TIMEOUT_MS`, `cursor-wire-transport.mjs:151`, cleared by the response
    /// head). Its `close` cancels the request first, and the request's `aborted` handler (`:230`) ends the stream before
    /// the timer's own error does: `Cursor stream was aborted`, `code: 'stream_aborted'` (`golden/connect_errors.json`
    /// `sites.cursorConnect`).
    SocketConnect,
}

/// `TypeError: fetch failed`, the message of every network error of a raw `fetch`.
pub const FETCH_FAILED: &str = "fetch failed";
/// `APIConnectionError: Connection error.`, the SDK's wrapper of a failed connection.
pub const CONNECTION_ERROR: &str = "Connection error.";
/// `APIConnectionTimeoutError: Request timed out.`, the SDK's timer.
pub const REQUEST_TIMED_OUT: &str = "Request timed out.";
/// `AbortSignal.timeout`'s `TimeoutError` message.
pub const SIGNAL_TIMED_OUT: &str = "The operation was aborted due to timeout";
/// A bare `controller.abort()`'s `AbortError` message.
pub const ABORTED: &str = "This operation was aborted";

impl Surface {
    /// Node's text for a connection failure, `None` where the link has none to give.
    pub const fn connection_text(self) -> Option<&'static str> {
        match self {
            Self::Fetch | Self::FetchSignal | Self::FetchAborted | Self::FetchLabeled(_) => Some(FETCH_FAILED),
            Self::Sdk => Some(CONNECTION_ERROR),
            Self::Socket | Self::SocketLabeled(_) | Self::SocketConnect => None,
        }
    }

    /// Node's text for an exchange that outlived its `after`, `None` where the link has none to give.
    pub fn timeout_text(self, after: std::time::Duration) -> Option<String> {
        match self {
            Self::Fetch => Some(FETCH_FAILED.to_owned()),
            Self::FetchSignal => Some(SIGNAL_TIMED_OUT.to_owned()),
            Self::FetchAborted => Some(ABORTED.to_owned()),
            Self::FetchLabeled(label) | Self::SocketLabeled(label) => Some(format!("{label} timed out after {}ms", after.as_millis())),
            Self::Sdk => Some(REQUEST_TIMED_OUT.to_owned()),
            Self::SocketConnect => Some("Cursor stream was aborted".to_owned()),
            Self::Socket => None,
        }
    }

    /// The text of a failure: Node's, else the link's own `fallback`.
    pub fn text(self, fallback: impl FnOnce() -> String) -> String {
        self.connection_text().map_or_else(fallback, str::to_owned)
    }
}

/// The three per-request choices of an HTTP exchange: how long it may take, what a redirect does,
/// and what a failure to connect reads as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exchange {
    pub liveness: Liveness,
    pub redirect: Redirect,
    pub surface: Surface,
    /// The Node client that writes the request: the global `fetch` (the default) or a raw `undici.request`.
    pub writer: Writer,
}

impl Exchange {
    pub const fn new(liveness: Liveness, redirect: Redirect, surface: Surface) -> Self {
        Self { liveness, redirect, surface, writer: Writer::Fetch }
    }

    /// The call site is a raw `undici.request`, which adds none of `fetch`'s headers.
    pub const fn raw(mut self) -> Self {
        self.writer = Writer::Raw;
        self
    }
}

#[async_trait]
pub trait HttpSend: Send + Sync {
    /// One request under its [`Liveness`]: a `Unary` exchange (head and body)
    /// ends within `total`, a `Stream` gets its head within `head` and its body
    /// has no timer. A failure before a status arrived carries the delivery
    /// state the connection reached (`NotSent` / `Ambiguous`).
    async fn send(
        &self,
        request: WireRequest,
        exchange: Exchange,
    ) -> Result<HttpResponse, ProviderError>;
}

/// Writes request-body frames of an open exchange.
pub trait FrameSink: Send + Sync {
    /// Queues a frame; the fault says why the exchange is gone.
    fn send(&self, frame: Vec<u8>) -> Result<(), TransportFault>;
}

#[async_trait]
pub trait BidiOpen: Send + Sync {
    /// Opens the exchange with `first` queued as the first body frame
    /// (`request.body` is ignored). Dropping the sink ends the request body;
    /// dropping the response aborts the exchange.
    async fn open(
        &self,
        request: WireRequest,
        first: Vec<u8>,
        exchange: Exchange,
    ) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError>;
}

/// The clients behind a [`ReqwestLink`]: one fixed client, or the clients of
/// the network proxy policy, one per route.
enum Clients {
    Fixed(reqwest::Client),
    Routed(RoutedClients),
    /// The Node-equal HTTP/1.1 (and negotiated h2) client of every exchange that is not a request stream.
    Node(NodeClient),
}

/// The shared `reqwest` client as both HTTP seams. Redirects are never
/// followed: the request carries credentials nobody validated the target of.
pub struct ReqwestLink {
    clients: Clients,
}

fn link_builder(schedule: &KeepaliveSchedule, http2_only: bool) -> reqwest::ClientBuilder {
    let mut builder = client_builder(schedule).redirect(reqwest::redirect::Policy::none());
    if http2_only {
        builder = builder.http2_prior_knowledge();
    }
    builder
}

/// The client of one route as [`RoutedClients::new`] asks for it: `None` is the direct client
/// (it ignores the environment's proxy variables), `Some(uri)` the client of that proxy. The
/// one builder of every routed client, so a provider's link and the proxy test connect alike.
pub fn routed_builder(
    schedule: KeepaliveSchedule,
    http2_only: bool,
) -> impl Fn(Option<&str>) -> Result<reqwest::Client, reqwest::Error> + Send + Sync + 'static {
    move |proxy| {
        let builder = link_builder(&schedule, http2_only);
        match proxy {
            Some(uri) => builder.proxy(reqwest::Proxy::all(uri)?),
            None => builder.no_proxy(),
        }
        .build()
    }
}

impl ReqwestLink {
    /// `http2_only` speaks HTTP/2 without negotiation (Connect streams need
    /// it, and so do the h2c peers of tests).
    pub fn new(schedule: &KeepaliveSchedule, http2_only: bool) -> Result<Self, reqwest::Error> {
        if !http2_only {
            return Ok(Self { clients: Clients::Node(NodeClient::new(schedule.tcp, None)) });
        }
        Ok(Self {
            clients: Clients::Fixed(link_builder(schedule, http2_only).build()?),
        })
    }

    /// The Node-equal client with every connect going to `addr` and trusting `tls` alone: what is written is unchanged.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pinned(schedule: &KeepaliveSchedule, addr: std::net::SocketAddr, tls: Arc<rustls::ClientConfig>) -> Self {
        let mut config = (*tls).clone();
        config.alpn_protocols = super::node_http::ALPN.iter().map(|p| p.to_vec()).collect();
        Self { clients: Clients::Node(NodeClient::pinned(schedule.tcp, Pinned { addr, tls: Arc::new(config) })) }
    }

    #[cfg(any(test, feature = "test-support"))]
    /// The link with its client built from `tweak(link_builder)`: a test pins hosts to a loopback server and trusts its
    /// certificate there, and everything else about the client is the production one.
    pub fn with_builder(
        schedule: &KeepaliveSchedule,
        http2_only: bool,
        tweak: impl FnOnce(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self { clients: Clients::Fixed(tweak(link_builder(schedule, http2_only)).build()?) })
    }

    /// Every request follows the network proxy policy: it asks the route of
    /// its origin and rides the client of that route (direct, or one proxy); a
    /// change of the setting retires the clients, so no pooled connection
    /// opened under the old setting is reused.
    pub fn routed(schedule: &KeepaliveSchedule, http2_only: bool, policy: Arc<NetworkProxy>) -> Self {
        if !http2_only {
            return Self { clients: Clients::Node(NodeClient::new(schedule.tcp, Some(policy))) };
        }
        let clients = RoutedClients::new(policy, routed_builder(*schedule, http2_only));
        Self { clients: Clients::Routed(clients) }
    }

    #[allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]
    async fn builder(&self, request: &WireRequest, surface: Surface) -> Result<reqwest::RequestBuilder, ProviderError> {
        if let Some(refused) = restricted_port(&request.url, surface) {
            return Err(refused);
        }
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = format!("invalid HTTP method {}", request.method);
            error
        })?;
        let client = match &self.clients {
            Clients::Fixed(client) => client.clone(),
            Clients::Routed(routed) => routed.client_for(&request.url).await.map_err(proxy_error)?,
            Clients::Node(_) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = "a request stream needs an http2_only link".to_owned();
                return Err(error);
            }
        };
        let mut builder = client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        Ok(builder)
    }
}

/// A request the proxy policy could not route: nothing was sent, and it never
/// goes direct instead.
fn proxy_error(error: ClientError) -> ProviderError {
    let mut failure = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    failure.message = error.to_string();
    if matches!(error, ClientError::Route(RouteError::Config(_))) {
        failure.code = Some(ProxyConfigError::CODE.to_owned());
    }
    failure
}

struct ReqwestBody(reqwest::Response);

#[async_trait]
impl BodyStream for ReqwestBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self.0.chunk().await {
            Ok(Some(bytes)) => Some(Ok(bytes)),
            Ok(None) => None,
            Err(err) => Some(Err(fault_from_reqwest(&err).0)),
        }
    }
}

fn response_of(response: reqwest::Response) -> HttpResponse {
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
        .collect();
    HttpResponse {
        status: response.status().as_u16(),
        headers,
        body: Box::new(ReqwestBody(response)),
    }
}

/// The deadline passed: a transient transport fact (Node: undici
/// `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`, both retried as transient).
pub fn deadline_error(expired: Expired, delivery: DeliveryState, surface: Surface) -> ProviderError {
    let mut error = ProviderError::transport(TransportFault::Io { os_code: None }, delivery);
    error.message = surface
        .timeout_text(expired.after)
        .unwrap_or_else(|| format!("request timed out after {}ms", expired.after.as_millis()));
    // A timer the call armed itself: Node's `TimeoutError` (`AbortSignal.timeout`), `AbortError` (a bare
    // `controller.abort()`) or `ProviderTimeoutError` (`createTimeoutSignal`, which also carries
    // `code: 'EPROVIDERTIMEOUT'`, `stall-policy.mjs:380`).
    error.timed_out = matches!(surface, Surface::FetchSignal | Surface::FetchAborted | Surface::FetchLabeled(_) | Surface::SocketLabeled(_));
    if matches!(surface, Surface::FetchLabeled(_) | Surface::SocketLabeled(_)) {
        error.code = Some("EPROVIDERTIMEOUT".to_owned());
    }
    if matches!(surface, Surface::SocketConnect) {
        error.code = Some("stream_aborted".to_owned());
    }
    error
}

/// A `Unary` body ends at the exchange deadline; the stream below it keeps no timer.
struct DeadlineBody {
    inner: Box<dyn BodyStream>,
    until: tokio::time::Instant,
}

#[async_trait]
impl BodyStream for DeadlineBody {
    fn hold_connection(&mut self) {
        self.inner.hold_connection();
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match tokio::time::timeout_at(self.until, self.inner.next()).await {
            Ok(item) => item,
            Err(_) => Some(Err(TransportFault::Io { os_code: None })),
        }
    }
}

/// Redirects a request may follow before it fails (the fetch spec's limit).
const MAX_REDIRECTS: usize = 20;

fn is_redirect(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// The ports `fetch` refuses to connect to (the WHATWG "bad ports", as the Node runtime's `fetch` lists them:
/// `golden/connect_errors.json` `badPorts`, found by asking it for every loopback port).
const RESTRICTED_PORTS: [u16; 82] = [
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
    111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
    540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
    6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

/// A request to a port `fetch` refuses fails before any connection, as a plain network error with no errno (the end
/// of Node's chain reads "bad port", the call site's text on top): the loop sees an I/O fault, not an unreachable
/// network, so only the provider's own ladder retries it.
pub(crate) fn restricted_port(url: &str, surface: Surface) -> Option<ProviderError> {
    let port = reqwest::Url::parse(url).ok()?.port()?;
    RESTRICTED_PORTS.contains(&port).then(|| {
        let mut error = ProviderError::transport(TransportFault::Io { os_code: None }, DeliveryState::NotSent);
        error.message = surface.text(|| "bad port".to_owned());
        error
    })
}

/// `fetch` rejects a redirect under `redirect: 'error'` as a network error.
fn redirect_refused(status: reqwest::StatusCode, surface: Surface) -> ProviderError {
    let mut error = ProviderError::transport(
        TransportFault::Io { os_code: None },
        DeliveryState::Ambiguous,
    );
    error.message = surface.text(|| format!("unexpected redirect (HTTP {})", status.as_u16()));
    error
}

/// The request a followed redirect sends next, or `None` when the answer names no usable target.
fn next_hop(
    request: &WireRequest,
    status: reqwest::StatusCode,
    location: &str,
) -> Option<WireRequest> {
    let from = reqwest::Url::parse(&request.url).ok()?;
    let to = from.join(location).ok()?;
    let mut next = request.clone();
    if from.origin() != to.origin() {
        next.headers.retain(|(name, _)| {
            !["authorization", "cookie", "proxy-authorization"]
                .iter()
                .any(|dropped| name.eq_ignore_ascii_case(dropped))
        });
    }
    let status = status.as_u16();
    if (status == 303 && request.method != "HEAD")
        || (matches!(status, 301 | 302) && request.method == "POST")
    {
        next.method = "GET".to_owned();
        next.body.clear();
        next.headers
            .retain(|(name, _)| !name.to_ascii_lowercase().starts_with("content-"));
    }
    next.url = to.into();
    Some(next)
}

/// The one place a request meets its [`Exchange`]: the head is bounded for both liveness
/// classes, and a `Unary` body shares the same total.
async fn settle(
    exchange: Exchange,
    answer: impl std::future::Future<Output = Result<HttpResponse, ProviderError>>,
) -> Result<HttpResponse, ProviderError> {
    let liveness = exchange.liveness;
    let started = tokio::time::Instant::now();
    let mut response = liveness
        .bound_head(answer)
        .await
        .map_err(|expired| deadline_error(expired, DeliveryState::Ambiguous, exchange.surface))??;
    if let Some(total) = liveness.total_deadline() {
        response.body = Box::new(DeadlineBody {
            inner: response.body,
            until: started + total,
        });
    }
    Ok(response)
}

#[async_trait]
impl HttpSend for ReqwestLink {
    async fn send(
        &self,
        request: WireRequest,
        exchange: Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        settle(exchange, self.hops(request, exchange)).await
    }
}

impl ReqwestLink {
    /// Sends `request` and applies the redirect policy to each answer.
    async fn hops(
        &self,
        mut request: WireRequest,
        exchange: Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        let Exchange { redirect, surface, writer, .. } = exchange;
        for _ in 0..=MAX_REDIRECTS {
            let raw = match &self.clients {
                Clients::Node(node) => {
                    if let Some(refused) = restricted_port(&request.url, surface) {
                        return Err(refused);
                    }
                    node.send(&request, writer, surface).await?
                }
                _ => {
                    let builder = self.builder(&request, surface).await?.body(request.body.clone());
                    let sent = builder
                        .send()
                        .await
                        .map_err(|err| provider_error_from_reqwest(&err, surface))?;
                    response_of(sent)
                }
            };
            let status = reqwest::StatusCode::from_u16(raw.status).unwrap_or(reqwest::StatusCode::OK);
            if !is_redirect(status) {
                return Ok(raw);
            }
            match redirect {
                Redirect::Manual => return Ok(raw),
                Redirect::Error => return Err(redirect_refused(status, surface)),
                Redirect::Follow => {
                    let location = raw
                        .headers
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("location"))
                        .map(|(_, value)| value.as_str());
                    // No usable `Location`: the answer is the response, as in fetch.
                    let Some(next) = location.and_then(|l| next_hop(&request, status, l))
                    else {
                        return Ok(raw);
                    };
                    request = next;
                }
            }
        }
        let mut error = ProviderError::transport(
            TransportFault::Io { os_code: None },
            DeliveryState::Ambiguous,
        );
        error.message = surface.text(|| format!("more than {MAX_REDIRECTS} redirects"));
        Err(error)
    }
}

struct ChannelSink(mpsc::UnboundedSender<Bytes>);

impl FrameSink for ChannelSink {
    fn send(&self, frame: Vec<u8>) -> Result<(), TransportFault> {
        self.0
            .send(Bytes::from(frame))
            .map_err(|_| TransportFault::Closed)
    }
}

#[async_trait]
impl BidiOpen for ReqwestLink {
    async fn open(
        &self,
        request: WireRequest,
        first: Vec<u8>,
        exchange: Exchange,
    ) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        // A streaming request body cannot be replayed, so a redirect is never followed.
        let redirect = exchange.redirect;
        if redirect == Redirect::Follow {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = "a streaming request body cannot follow a redirect".to_owned();
            return Err(error);
        }
        let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
        let _ = tx.send(Bytes::from(first));
        let stream = futures::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|bytes| (Ok::<_, std::io::Error>(bytes), rx))
        });
        let surface = exchange.surface;
        let builder = self
            .builder(&request, surface)
            .await?
            .body(reqwest::Body::wrap_stream(stream));
        let answer = async {
            let raw = builder
                .send()
                .await
                .map_err(|err| provider_error_from_reqwest(&err, surface))?;
            if redirect == Redirect::Error && is_redirect(raw.status()) {
                return Err(redirect_refused(raw.status(), surface));
            }
            Ok(response_of(raw))
        };
        let response = settle(exchange, answer).await?;
        Ok((response, Arc::new(ChannelSink(tx))))
    }
}

/// An open WebSocket as the adapters use it.
#[async_trait]
pub trait WsSocket: Send {
    async fn send(&self, message: Message) -> Result<(), TransportFault>;
    /// The next data frame, or the one fault that ended the link, then `None`.
    async fn recv(&mut self) -> Option<Result<Message, TransportFault>>;
    fn link(&self) -> Arc<dyn TransportKeepalive>;
    /// What ended the link, as `ws` reports it, once [`recv`](Self::recv) has given the fault.
    fn ending(&self) -> Option<super::ws::WsEnding> {
        None
    }
    /// Closes the socket for good with `code` and `reason`; by default it is dropped.
    fn close(self: Box<Self>, _code: u16, _reason: &str) {}
    /// What closes the socket while it is held elsewhere; `None` when it cannot be closed but by dropping it.
    fn closer(&self) -> Option<super::ws::WsCloser> {
        None
    }
    /// Becomes `true` once the socket is actually closed (`ws`'s `close` event); `None`: it is closed when dropped.
    fn closed(&self) -> Option<tokio::sync::watch::Receiver<bool>> {
        None
    }
}

#[async_trait]
impl WsSocket for WsConnection {
    async fn send(&self, message: Message) -> Result<(), TransportFault> {
        WsConnection::send(self, message).await
    }

    async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        WsConnection::recv(self).await
    }

    fn link(&self) -> Arc<dyn TransportKeepalive> {
        WsConnection::link(self)
    }

    fn ending(&self) -> Option<super::ws::WsEnding> {
        WsConnection::ending(self)
    }

    fn close(self: Box<Self>, code: u16, reason: &str) {
        WsConnection::close(*self, code, reason);
    }

    fn closer(&self) -> Option<super::ws::WsCloser> {
        Some(WsConnection::closer(self))
    }

    fn closed(&self) -> Option<tokio::sync::watch::Receiver<bool>> {
        Some(WsConnection::link(self).closed())
    }
}

#[async_trait]
pub trait WsDial: Send + Sync {
    /// Connects and upgrades. The upgrade response carries the handshake
    /// headers the adapter may read.
    async fn dial(
        &self,
        request: Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError>;
}

/// Dials with the keepalive schedule on the socket and the PING driver.
pub struct KeepaliveDialer {
    schedule: KeepaliveSchedule,
    policy: Option<Arc<NetworkProxy>>,
    #[cfg(any(test, feature = "test-support"))]
    pinned: Option<(std::net::SocketAddr, Arc<rustls::ClientConfig>)>,
}

impl KeepaliveDialer {
    pub fn new(schedule: KeepaliveSchedule) -> Self {
        Self { schedule, policy: None, #[cfg(any(test, feature = "test-support"))] pinned: None }
    }

    /// Every dial goes to `addr` and trusts `tls` alone ([`ws::connect_pinned`]); what is written is unchanged.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pinned(schedule: KeepaliveSchedule, addr: std::net::SocketAddr, tls: Arc<rustls::ClientConfig>) -> Self {
        Self { schedule, policy: None, pinned: Some((addr, tls)) }
    }

    /// Every dial follows the network proxy policy.
    pub fn routed(schedule: KeepaliveSchedule, policy: Arc<NetworkProxy>) -> Self {
        Self { schedule, policy: Some(policy), #[cfg(any(test, feature = "test-support"))] pinned: None }
    }
}

#[async_trait]
impl WsDial for KeepaliveDialer {
    async fn dial(
        &self,
        request: Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        #[cfg(any(test, feature = "test-support"))]
        if let Some((addr, tls)) = &self.pinned {
            let (connection, response) = ws::connect_pinned(request, *addr, &self.schedule, tls.clone()).await?;
            return Ok((Box::new(connection), response));
        }
        let (connection, response) = ws::connect_via(request, &self.schedule, self.policy.as_deref()).await?;
        Ok((Box::new(connection), response))
    }
}
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Every loopback port against the set Node's `fetch` refused when asked for each one (`golden/connect_errors.json`
    /// `badPorts`); the refusal is an I/O fault with Node's text, never a connect fault.
    #[test]
    fn the_ports_fetch_refuses_fail_before_connecting() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../../../fixtures/agent/connect-errors/golden/connect_errors.json")).unwrap();
        let recorded: Vec<u16> = golden["badPorts"].as_array().unwrap().iter().map(|p| p.as_u64().unwrap() as u16).collect();
        let refused: Vec<u16> =
            (1..=u16::MAX).filter(|port| restricted_port(&format!("http://127.0.0.1:{port}/v1"), Surface::Fetch).is_some()).collect();
        assert_eq!(refused, recorded);
        let error = restricted_port("http://127.0.0.1:9/v1", Surface::Fetch).expect("port 9 is refused");
        assert_eq!(error.transport, Some(TransportFault::Io { os_code: None }));
        assert_eq!(error.delivery, DeliveryState::NotSent);
        // The text is the call site's (the golden's chain: `Connection error.` <- `fetch failed` <- `bad port`).
        assert_eq!(error.message, "fetch failed");
        assert_eq!(restricted_port("http://127.0.0.1:9/v1", Surface::Sdk).expect("refused").message, "Connection error.");
        assert!(restricted_port("https://example.com/v1", Surface::Fetch).is_none(), "a default port is never restricted");
    }

    /// A body whose peer holds the connection open and says nothing.
    struct Silent;

    #[async_trait]
    impl BodyStream for Silent {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            std::future::pending().await
        }
    }

    fn head_of(body: Box<dyn BodyStream>) -> HttpResponse {
        HttpResponse {
            status: 200,
            headers: Vec::new(),
            body,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_unary_body_that_never_ends_fails_at_its_total() {
        let total = Duration::from_secs(30);
        let body = DeadlineBody {
            inner: Box::new(Silent),
            until: tokio::time::Instant::now() + total,
        };
        let error = head_of(Box::new(body))
            .read_all()
            .await
            .expect_err("the peer never finishes the body");
        assert_eq!(error.delivery, DeliveryState::Accepted);
        assert_eq!(error.transport, Some(TransportFault::Io { os_code: None }));
    }

    #[tokio::test(start_paused = true)]
    async fn the_error_body_of_a_stream_ends_at_the_dispatcher_ceiling() {
        let error = head_of(Box::new(Silent))
            .read_all()
            .await
            .expect_err("the error body never ends");
        assert_eq!(error.delivery, DeliveryState::Accepted);
        // The ceiling is the dispatcher's own: a raw `fetch`'s `fetch failed`.
        assert_eq!(error.message, "fetch failed");
    }
}
