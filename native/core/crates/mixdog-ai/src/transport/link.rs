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
use super::ws;
use super::ws::ConnectError;
use super::ws::Message;
use super::ws::WsConnection;

#[async_trait]
pub trait BodyStream: Send {
    /// The next body chunk; `None` at a clean end of body. A fault is the
    /// transport fact that ended the body.
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>>;
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
        let mut body = Vec::new();
        // A whole-body read is never a stream of content: a `Unary` body already
        // ends at its own total, and the error body of a `Stream` response ends at
        // the dispatcher ceiling (Node `http-agent.mjs:414` `bodyTimeout`).
        let drained = NODE_DISPATCHER
            .liveness
            .bound_head(async {
                while let Some(chunk) = self.body.next().await {
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
            .map_err(|expired| deadline_error(expired, DeliveryState::Accepted))?;
        drained?;
        Ok(ErrorResponse {
            status: Some(self.status),
            headers: self.headers,
            body,
        })
    }
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

/// The two per-request choices of an HTTP exchange: how long it may take and what a redirect does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exchange {
    pub liveness: Liveness,
    pub redirect: Redirect,
}

impl Exchange {
    pub const fn new(liveness: Liveness, redirect: Redirect) -> Self {
        Self { liveness, redirect }
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
        Ok(Self {
            clients: Clients::Fixed(link_builder(schedule, http2_only).build()?),
        })
    }

    /// Every request follows the network proxy policy: it asks the route of
    /// its origin and rides the client of that route (direct, or one proxy); a
    /// change of the setting retires the clients, so no pooled connection
    /// opened under the old setting is reused.
    pub fn routed(schedule: &KeepaliveSchedule, http2_only: bool, policy: Arc<NetworkProxy>) -> Self {
        let clients = RoutedClients::new(policy, routed_builder(*schedule, http2_only));
        Self { clients: Clients::Routed(clients) }
    }

    #[allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]
    async fn builder(&self, request: &WireRequest) -> Result<reqwest::RequestBuilder, ProviderError> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = format!("invalid HTTP method {}", request.method);
            error
        })?;
        let client = match &self.clients {
            Clients::Fixed(client) => client.clone(),
            Clients::Routed(routed) => routed.client_for(&request.url).await.map_err(proxy_error)?,
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
pub(crate) fn deadline_error(expired: Expired, delivery: DeliveryState) -> ProviderError {
    let mut error = ProviderError::transport(TransportFault::Io { os_code: None }, delivery);
    error.message = format!("request timed out after {}ms", expired.after.as_millis());
    error
}

/// A `Unary` body ends at the exchange deadline; the stream below it keeps no timer.
struct DeadlineBody {
    inner: Box<dyn BodyStream>,
    until: tokio::time::Instant,
}

#[async_trait]
impl BodyStream for DeadlineBody {
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

/// `fetch` rejects a redirect under `redirect: 'error'` as a network error.
fn redirect_refused(status: reqwest::StatusCode) -> ProviderError {
    let mut error = ProviderError::transport(
        TransportFault::Io { os_code: None },
        DeliveryState::Ambiguous,
    );
    error.message = format!("unexpected redirect (HTTP {})", status.as_u16());
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
    answer: impl std::future::Future<Output = Result<reqwest::Response, ProviderError>>,
) -> Result<HttpResponse, ProviderError> {
    let liveness = exchange.liveness;
    let started = tokio::time::Instant::now();
    let response = liveness
        .bound_head(answer)
        .await
        .map_err(|expired| deadline_error(expired, DeliveryState::Ambiguous))??;
    let mut response = response_of(response);
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
        settle(exchange, self.hops(request, exchange.redirect)).await
    }
}

impl ReqwestLink {
    /// Sends `request` and applies the redirect policy to each answer.
    async fn hops(
        &self,
        mut request: WireRequest,
        redirect: Redirect,
    ) -> Result<reqwest::Response, ProviderError> {
        for _ in 0..=MAX_REDIRECTS {
            let builder = self.builder(&request).await?.body(request.body.clone());
            let raw = builder
                .send()
                .await
                .map_err(|err| provider_error_from_reqwest(&err))?;
            if !is_redirect(raw.status()) {
                return Ok(raw);
            }
            match redirect {
                Redirect::Manual => return Ok(raw),
                Redirect::Error => return Err(redirect_refused(raw.status())),
                Redirect::Follow => {
                    let location = raw
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok());
                    // No usable `Location`: the answer is the response, as in fetch.
                    let Some(next) = location.and_then(|l| next_hop(&request, raw.status(), l))
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
        error.message = format!("more than {MAX_REDIRECTS} redirects");
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
        let builder = self
            .builder(&request)
            .await?
            .body(reqwest::Body::wrap_stream(stream));
        let answer = async {
            let raw = builder
                .send()
                .await
                .map_err(|err| provider_error_from_reqwest(&err))?;
            if redirect == Redirect::Error && is_redirect(raw.status()) {
                return Err(redirect_refused(raw.status()));
            }
            Ok(raw)
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
}

impl KeepaliveDialer {
    pub fn new(schedule: KeepaliveSchedule) -> Self {
        Self { schedule, policy: None }
    }

    /// Every dial follows the network proxy policy.
    pub fn routed(schedule: KeepaliveSchedule, policy: Arc<NetworkProxy>) -> Self {
        Self { schedule, policy: Some(policy) }
    }
}

#[async_trait]
impl WsDial for KeepaliveDialer {
    async fn dial(
        &self,
        request: Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        let (connection, response) = ws::connect_via(request, &self.schedule, self.policy.as_deref()).await?;
        Ok((Box::new(connection), response))
    }
}
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

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
        assert_eq!(error.message, "request timed out after 600000ms");
    }
}
