//! `ProviderAdapter` of the OpenAI Responses routes (`openai`,
//! `openai-oauth`) over HTTP/SSE or WebSocket. One attempt: encode, add the
//! credential, send, hand back the decoded stream. Retrying is above the
//! adapter. Two repeats happen inside an attempt, both decided from the
//! response head or the first frame, before any output exists:
//!
//! - a 401 asks the credential source to reload or refresh once and replays;
//! - a 400 whose structured `param` points at a mid-conversation effort
//!   update replays once without the updates.
//!
//! The HTTP exchange is the shared [`HttpSend`] seam and the socket is the
//! shared [`WsDial`] seam.

#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

use crate::transport::deadlines::MODEL_STREAM_FETCH;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use mixdog_rt::CpuBulk;
use mixdog_rt::LaneToken;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_util::sync::CancellationToken;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use super::codec::OpenAiCodec;
use super::config::Route;
use super::config::WireContext;
use super::config::request_scope;
use super::effort::EffortProjection;
use super::effort_retry::without_effort_updates;
use super::models::OpenAiModels;
use super::delta;
use super::delta::Chain;
use super::pool::Checkout;
use super::pool::Compat;
use super::pool::WsPool;
use super::switch;
use super::switch::TransportMode;
use crate::catalog::ListingLookup;
use crate::transport::link::BodyStream;
use crate::transport::link::HttpSend;
use crate::transport::link::WsDial;
use crate::transport::ws::ConnectError;
use crate::transport::ws::Message;
use crate::transport::ws::WsEnding;

const TURN_STATE_HEADER: &str = "x-codex-turn-state";
/// Turn-state scopes kept; the oldest is dropped beyond this.
const MAX_TURN_STATE_SCOPES: usize = 4096;
/// A failure body is read up to this many bytes for classification.
const ERROR_BODY_LIMIT: usize = 1024 * 1024;
/// `REQ_COMPRESSION_MIN_BYTES`: a smaller request body is never compressed.
const ZSTD_MIN_BYTES: usize = 8 * 1024;
/// zstd's default level, which `zlib.zstdCompress` uses.
const ZSTD_LEVEL: i32 = 3;
/// `_openaiReqZstdLatch`: set once a request the backend refused (400/415) as compressed was accepted plain, after which
/// no body of this process is compressed (Node's latch is module-wide, so it outlives the provider that set it).
static ZSTD_LATCHED: AtomicBool = AtomicBool::new(false);

/// The latch as a new process has it (`createCompressionLatch(...).reset`, `request-compression.mjs:23-25`).
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_zstd_latch() {
    ZSTD_LATCHED.store(false, Ordering::Relaxed);
}

/// `CODEX_BACKEND_ORIGIN` (`openai-codex-endpoints.mjs:10`), the one origin the Codex route warms.
const CODEX_BACKEND_ORIGIN: &str = "https://chatgpt.com";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// What one attempt authenticates with.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    /// API key or access token.
    pub bearer: String,
    /// `chatgpt-account-id` of a subscription token.
    pub account_id: Option<String>,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("bearer", &"[redacted]")
            .field("account_id", &self.account_id)
            .finish()
    }
}

#[async_trait]
pub trait CredentialSource: Send + Sync {
    async fn current(&self) -> Result<Credential, ProviderError>;
    /// The server rejected `rejected` with a 401: reload the key or refresh
    /// the token. `None` when there is nothing newer to try.
    async fn after_rejection(&self, rejected: &Credential) -> Result<Option<Credential>, ProviderError>;
}

// ---------------------------------------------------------------------------
// Per-process request context
// ---------------------------------------------------------------------------

/// One scope's turn state (`openai-turn-state.mjs` `_turnStateByScope`): the logical turn, the token its responses
/// issued, and the WebSocket connection that owns it while it is open.
struct TurnState {
    turn: String,
    value: Option<String>,
    owner: Option<u64>,
}

#[derive(Default)]
struct TurnStates {
    by_scope: HashMap<String, TurnState>,
    order: VecDeque<String>,
}

/// Where the clock and the request ids come from: the system, or (a recording
/// that must equal another's byte for byte) a fixed source.
struct Sources {
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    request_id: Box<dyn Fn() -> String + Send + Sync>,
    /// Node's `process.env`: the process environment unless a recording gives its own.
    var: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            now: Box::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            }),
            request_id: Box::new(|| rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect()),
            var: Box::new(|name| std::env::var(name).ok()),
        }
    }
}

/// The values the codec and decoder read that no request carries: the clock,
/// request ids, and the `x-codex-turn-state` tokens of live turns. One per
/// process; the adapter writes the tokens its responses issue.
#[derive(Default)]
pub struct SessionContext {
    states: Mutex<TurnStates>,
    sources: Sources,
}

impl SessionContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// A context whose clock and request ids are the given ones: the wire
    /// parity recording runs both sides on one fixed clock and id.
    pub fn with_sources(now: impl Fn() -> u64 + Send + Sync + 'static, request_id: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self { states: Mutex::default(), sources: Sources { now: Box::new(now), request_id: Box::new(request_id), ..Sources::default() } }
    }

    /// The same context reading its settings from `var` instead of the process environment.
    pub fn with_var(mut self, var: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        self.sources.var = Box::new(var);
        self
    }

    /// `activateCodexTurnState` (`openai-turn-state.mjs:15`): the token of `turn` in `scope` for a request about to go
    /// out. Another turn starts the scope afresh, with no token; one live connection (`owner`) holds the turn's token,
    /// and a different connection gets none until the owner closes. An HTTP request (`owner: None`) reads it freely.
    pub fn activate(&self, scope: &str, turn: &str, owner: Option<u64>) -> Option<String> {
        // `cleanString` trims each value.
        let (scope, turn) = (scope.trim(), turn.trim());
        if scope.is_empty() || turn.is_empty() {
            return None;
        }
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        Self::activate_locked(&mut states, scope, turn, owner)
    }

    fn activate_locked(states: &mut TurnStates, scope: &str, turn: &str, owner: Option<u64>) -> Option<String> {
        if let Some(current) = states.by_scope.get_mut(scope)
            && current.turn == turn
        {
            if owner.is_some() && current.owner.is_some() && current.owner != owner {
                return None;
            }
            if owner.is_some() && current.owner.is_none() {
                current.owner = owner;
            }
            return current.value.clone();
        }
        // `_ensureCapacity`: the oldest scope goes when the map is full and this one is new.
        if !states.by_scope.contains_key(scope) {
            if states.by_scope.len() >= MAX_TURN_STATE_SCOPES
                && let Some(oldest) = states.order.pop_front()
            {
                states.by_scope.remove(&oldest);
            }
            states.order.push_back(scope.to_owned());
        }
        states.by_scope.insert(scope.to_owned(), TurnState { turn: turn.to_owned(), value: None, owner });
        None
    }

    /// `captureCodexTurnState` (`openai-turn-state.mjs:33`): the first token a turn is issued wins for the whole turn;
    /// a connection that does not own the turn cannot set it. True when the turn holds a token afterwards (Node returns
    /// it, and a socket stops looking for one).
    fn capture(&self, scope: &str, turn: &str, token: &str, owner: Option<u64>) -> bool {
        let (scope, turn, token) = (scope.trim(), turn.trim(), token.trim());
        if scope.is_empty() || turn.is_empty() || token.is_empty() {
            return false;
        }
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        Self::activate_locked(&mut states, scope, turn, owner);
        let Some(current) = states.by_scope.get_mut(scope).filter(|c| c.turn == turn) else { return false };
        if owner.is_some() && current.owner.is_some() && current.owner != owner {
            return false;
        }
        if owner.is_some() && current.owner.is_none() {
            current.owner = owner;
        }
        current.value.get_or_insert_with(|| token.to_owned());
        true
    }

    /// `retireCodexTurnStateOwner` (`openai-turn-state.mjs:50`): the owning connection closed; a replacement may adopt
    /// the turn's token.
    pub fn retire(&self, scope: &str, owner: u64) {
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(current) = states.by_scope.get_mut(scope)
            && current.owner == Some(owner)
        {
            current.owner = None;
        }
    }

    /// `clearCodexTurnStateScope`: the session's sockets were closed (`closeOpenaiWsPoolForSession`).
    pub fn clear_scope(&self, scope: &str) {
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        states.by_scope.remove(scope);
        states.order.retain(|s| s != scope);
    }
}

impl super::pool::SocketEvents for SessionContext {
    fn closed(&self, key: &str, owner: u64) {
        self.retire(key, owner);
    }

    fn session_closed(&self, key: &str) {
        self.clear_scope(key);
    }
}

impl WireContext for SessionContext {
    fn request_id(&self) -> String {
        (self.sources.request_id)()
    }

    fn now_unix_ms(&self) -> u64 {
        (self.sources.now)()
    }

    fn var(&self, name: &str) -> Option<String> {
        (self.sources.var)(name)
    }

    /// The HTTP request's read (`openai-oauth-http-sse.mjs:93`: `activateCodexTurnState(poolKey, turnId)`, no owner).
    fn turn_state(&self, scope: &str, turn_id: &str) -> Option<String> {
        self.activate(scope, turn_id, None)
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct OpenAiAdapter {
    id: ProviderId,
    codec: OpenAiCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    dial: Arc<dyn WsDial>,
    credentials: Arc<dyn CredentialSource>,
    context: Arc<SessionContext>,
    /// The HTTP/SSE twin of a WebSocket codec, for the transport switch.
    http_codec: Option<OpenAiCodec>,
    pool: Arc<WsPool>,
    mode: TransportMode,
    models: OpenAiModels,
    compress_lane: CpuBulk,
}

/// The seams and sources an adapter runs on.
pub struct AdapterLinks {
    pub http: Arc<dyn HttpSend>,
    pub dial: Arc<dyn WsDial>,
    /// The lane the HTTP/SSE request body's compression runs on.
    pub compress_lane: CpuBulk,
    pub credentials: Arc<dyn CredentialSource>,
    /// The same context the codec's config was built with.
    pub context: Arc<SessionContext>,
    /// The catalog tables the model listing's enrichment and sanitizer read
    /// (the handle `CatalogService::with_listing_lookup` publishes into).
    pub listing: ListingLookup,
}

impl OpenAiAdapter {
    /// `codec.transport()` (`Http1` or `WebSocket`) selects the wire; moving
    /// between them is a decision above the adapter.
    pub fn new(id: ProviderId, codec: OpenAiCodec, links: AdapterLinks) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        let http_codec = (codec.transport() == TransportKind::WebSocket).then(|| codec.with_transport(TransportKind::Http1));
        let models = OpenAiModels::new(
            codec.with_transport(TransportKind::Http1),
            links.http.clone(),
            links.credentials.clone(),
            links.listing,
        );
        // A socket's closing releases its hold on its turn's state.
        let pool = Arc::new(WsPool::with_events(links.context.clone()));
        let adapter = Self {
            id,
            codec,
            policy: super::policy::retry_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            http: links.http,
            dial: links.dial,
            credentials: links.credentials,
            context: links.context,
            http_codec,
            pool,
            mode: TransportMode::default(),
            models,
            compress_lane: links.compress_lane,
        };
        // The provider's constructor warms the socket (`openai-oauth.mjs:106`).
        adapter.preconnect();
        adapter
    }

    /// The transport policy of a WebSocket codec (default `auto`).
    pub fn with_mode(mut self, mode: TransportMode) -> Self {
        self.mode = mode;
        self
    }

    /// `preconnect(CODEX_BACKEND_ORIGIN)` (`shared/llm/http-agent.mjs:496-527`): a fire-and-forget HEAD that lands a
    /// kept-alive socket, gated by a TTL of `MIXDOG_LLM_KEEPALIVE_MS` (60 s) less 10 s, at least 5 s. Any failure only
    /// clears the stamp so the next call warms again; nothing is surfaced.
    fn preconnect(&self) {
        if self.codec.route() != Route::Codex {
            return;
        }
        crate::transport::preconnect::preconnect(&self.http, CODEX_BACKEND_ORIGIN, self.context.now_unix_ms(), self.context.var("MIXDOG_LLM_KEEPALIVE_MS"));
    }

    fn authorize(&self, mut wire: WireRequest, credential: &Credential) -> WireRequest {
        wire.headers
            .insert(0, ("Authorization".into(), format!("Bearer {}", credential.bearer)));
        if self.codec.route() == Route::Codex {
            // The WebSocket handshake lists the account right behind the bearer (`openai-ws-pool.mjs:490`), the
            // HTTP request right behind `originator` (`openai-oauth-http-sse.mjs:76`); both send it empty for a token
            // that names no account (`auth.account_id || ''`).
            let account = credential.account_id.clone().unwrap_or_default();
            let at = if wire.transport == TransportKind::WebSocket {
                1
            } else {
                wire.headers
                    .iter()
                    .position(|(name, _)| name.eq_ignore_ascii_case("originator"))
                    .map_or(wire.headers.len(), |i| i + 1)
            };
            wire.headers.insert(at, ("chatgpt-account-id".into(), account));
        }
        wire
    }

    /// Keeps the turn's `x-codex-turn-state` token for the turn's next request.
    fn remember_turn_state(&self, request: &ModelRequest, token: Option<&str>) {
        if let (Some(token), Some(scope), Some(turn)) = (
            token.filter(|t| !t.is_empty()),
            request_scope(request),
            request.options.thread.as_ref().and_then(|t| t.turn.as_ref()),
        ) {
            let _ = self.context.capture(scope, turn.as_str(), token, None);
        }
    }

    /// `encodeRequestBody`: the Codex backend takes a zstd request body, so a body of at least 8 KiB is compressed (off
    /// the main lanes) unless the request already names an encoding or the latch is set. A compression that cannot
    /// run sends the plain body.
    async fn compressed(&self, wire: &WireRequest) -> Option<WireRequest> {
        if self.codec.route() != Route::Codex
            || ZSTD_LATCHED.load(Ordering::Relaxed)
            || self.context.var("MIXDOG_OPENAI_REQ_ZSTD").as_deref() == Some("0")
            || wire.body.len() < ZSTD_MIN_BYTES
            || wire.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-encoding"))
        {
            return None;
        }
        let raw = wire.body.clone();
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let job = self.compress_lane.submit_wait(&cancel, move |_| zstd::stream::encode_all(raw.as_slice(), ZSTD_LEVEL)).await.ok()?;
        let body = job.await.ok()?.ok()?;
        let mut request = wire.clone();
        request.body = body;
        request.headers.push(("Content-Encoding".into(), "zstd".into()));
        Some(request)
    }

    async fn open_http(
        &self,
        codec: &OpenAiCodec,
        request: &ModelRequest,
        wire: WireRequest,
    ) -> Result<Opened, ProviderError> {
        let packed = self.compressed(&wire).await;
        let mut response = self.http.send(packed.clone().unwrap_or_else(|| wire.clone()), MODEL_STREAM_FETCH).await?;
        // `resendIfEncodingRejected`: a 400/415 of a compressed request is drained and the same request sent plain;
        // the latch is set only when that plain request is accepted (the encoding was the cause).
        if packed.is_some() && matches!(response.status, 400 | 415) {
            let mut body = response.body;
            while body.next().await.is_some() {}
            drop(body);
            response = self.http.send(wire, MODEL_STREAM_FETCH).await?;
            if response.is_success() {
                ZSTD_LATCHED.store(true, Ordering::Relaxed);
            }
        }
        if response.is_success() {
            let token = header(&response.headers, TURN_STATE_HEADER).map(str::to_owned);
            self.remember_turn_state(request, token.as_deref());
            return Ok(Opened::Stream(ResponsesStream::new(Source::Http(response.body), codec.decoder(request))));
        }
        Ok(Opened::Rejected(read_failure(response).await?))
    }

    /// One exchange on a pooled socket. `wire` carries the request frame (and
    /// the handshake headers for a new socket); the frame actually sent is
    /// the delta against the socket's last response when it extends it.
    async fn open_ws(
        &self,
        request: &ModelRequest,
        wire: WireRequest,
        credential: &Credential,
    ) -> Result<Opened, ProviderError> {
        let mut body: serde_json::Map<String, Value> = serde_json::from_slice(&wire.body)
            .map_err(|_| ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))?;
        body.shift_remove("type");
        body.shift_remove("client_metadata");
        let cache_key = body.get("prompt_cache_key").and_then(Value::as_str).unwrap_or_default().to_owned();
        let identity = credential.account_id.as_deref().unwrap_or(&credential.bearer);
        let compat = Compat::new(&format!("{:?}", self.codec.route()), identity, &cache_key);
        let (key, shared) = match request_scope(request) {
            Some(scope) => (scope.to_owned(), false),
            None => (format!("\0shared:{}:{}", compat.auth, compat.cache_key), true),
        };
        let mut checkout = self.pool.checkout(&key, &compat, shared, false).await;
        if checkout.socket.is_none() {
            let handshake = ws_request(&wire)?;
            let (socket, upgrade) = match self.dial.dial(handshake).await {
                Ok(connected) => connected,
                Err(ConnectError::Transport(fault)) => {
                    return Err(ProviderError::transport(fault, DeliveryState::NotSent));
                }
                Err(ConnectError::Proxy { code, message }) => {
                    // The network proxy policy or the proxy refused: nothing was sent.
                    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                    error.code = Some(code);
                    error.message = message;
                    return Err(error);
                }
                Err(ConnectError::Rejected(response)) => {
                    let headers = response
                        .headers()
                        .iter()
                        .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
                        .collect();
                    return Ok(Opened::Rejected(ErrorResponse {
                        status: Some(response.status().as_u16()),
                        headers,
                        body: response.into_body().unwrap_or_default(),
                    }));
                }
            };
            // The upgrade answer's headers are not read for a turn state: Node takes it from the response's events
            // alone (`openai-ws-stream/socket-handlers.mjs:93`, `_captureTurnStateFromEvent`).
            drop(upgrade);
            if !checkout.attach(socket) {
                // `_bindPoolOwner` throws this from the acquire; no request was sent.
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = "OpenAI OAuth WS ownership changed during acquire".into();
                return Err(error);
            }
        }
        let framed = delta::compute(self.mode.delta(), &checkout.chain, &body);
        // `_withCodexWsClientMetadata`: the frame activates its turn under the session's pool key, with this socket as
        // the turn state's owner.
        let scope_turn = request_scope(request).zip(self.codec.ws_turn(request));
        let token = scope_turn.as_ref().and_then(|(scope, turn)| self.context.activate(scope, turn, Some(checkout.owner)));
        let frame = self.codec.ws_frame(request, framed.frame, token.as_deref());
        let text = serde_json::to_string(&Value::Object(frame))
            .map_err(|_| ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))?;
        let socket = checkout.socket.as_ref().expect("a checked-out socket");
        socket
            .send(Message::text(text))
            .await
            .map_err(|fault| ProviderError::transport(fault, DeliveryState::Ambiguous))?;
        let owner = checkout.owner;
        let mut stream = ResponsesStream::new(Source::Ws { checkout, pending: None }, self.codec.decoder(request));
        stream.anchor = Some(Anchor { body, response_id: None, items: Vec::new() });
        stream.ledger = Some((self.pool.clone(), key, self.mode.http_fallback()));
        // `_captureTurnStateFromEvent` returns at once when the activation gave the socket a token.
        if let Some((scope, turn)) = scope_turn
            && token.is_none()
        {
            stream.turn_state = Some((self.context.clone(), scope.to_owned(), turn, owner));
        }
        // The first frame decides whether the server took the request.
        stream.prime().await;
        Ok(Opened::Stream(stream))
    }
}

/// The request a pooled socket's response answers, for the next delta.
struct Anchor {
    body: serde_json::Map<String, Value>,
    response_id: Option<String>,
    items: Vec<Value>,
}

/// The outcome of opening one exchange.
#[allow(clippy::large_enum_variant, reason = "built once per attempt and matched immediately")]
enum Opened {
    Stream(ResponsesStream),
    /// A non-success response head: a status, headers and body.
    Rejected(ErrorResponse),
}

/// The request's mid-conversation effort updates in the provider's form: the projection the
/// agent set on the request's options (`EffortAdapter::attempt_with`).
fn effort_of(request: &ModelRequest) -> Option<EffortProjection> {
    request.options.effort_projection.as_ref().map(EffortProjection::from)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

async fn read_failure(response: crate::transport::link::HttpResponse) -> Result<ErrorResponse, ProviderError> {
    let status = response.status;
    let headers = response.headers.clone();
    let mut body = Vec::new();
    let mut stream = response.body;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) if body.len() < ERROR_BODY_LIMIT => body.extend_from_slice(&bytes),
            Ok(_) => {}
            Err(fault) => return Err(ProviderError::transport(fault, DeliveryState::Accepted)),
        }
    }
    Ok(ErrorResponse { status: Some(status), headers, body })
}

fn ws_request(wire: &WireRequest) -> Result<Request, ProviderError> {
    let invalid = |what: &str| {
        let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
        err.message = format!("invalid WebSocket request: {what}");
        err
    };
    let mut request = wire
        .url
        .as_str()
        .into_client_request()
        .map_err(|_| invalid("url"))?;
    request.extensions_mut().insert(crate::transport::ws::CallerHeaders(wire.headers.clone()));
    for (name, value) in &wire.headers {
        request.headers_mut().append(
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid("header name"))?,
            HeaderValue::from_str(value).map_err(|_| invalid("header value"))?,
        );
    }
    Ok(request)
}

#[async_trait]
impl ProviderAdapter for OpenAiAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(&self.models)
    }

    /// The session ended: its parked sockets and transport state go.
    fn release_session(&self, session_id: &str) {
        self.pool.release_session(session_id);
    }

    /// `disposeTransportScope`: the scope's sockets are closed with `transport_scope_disposed`.
    fn release_transport_scope(&self, scope: &str) {
        self.pool.release_scope(scope, "transport_scope_disposed");
    }

    /// One attempt. On a WebSocket codec in `auto` mode the attempt may move
    /// to HTTP/SSE inside itself, as Node's send does ([`switch`]): at once
    /// for a refused upgrade, a 426 or a server close 1009, and when the
    /// session's WebSocket budget is spent (the sixth attempt goes straight to
    /// HTTP/SSE rather than trying a sixth socket). A switch of an `openai-oauth`
    /// session and every 1009 stay switched for the session.
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        // `_sendOnce` re-warms before every turn (`openai-oauth.mjs:170`).
        self.preconnect();
        let route = self.codec.route();
        let scope = request_scope(&request).map(str::to_owned);
        let keys: Vec<&str> = scope.iter().map(String::as_str).chain(request.options.session_id.as_deref()).collect();
        let switching = self.mode.http_fallback();
        if self.codec.transport() != TransportKind::WebSocket || (switching && self.pool.http_active(&keys)) {
            return self.run(Wire::Http, &request).await.map_err(|failed| failed.error);
        }
        if switching
            && let Some(key) = scope.as_deref()
            && self.pool.budget_spent(key, switch::WS_ATTEMPTS)
        {
            if route == Route::Codex {
                self.pool.mark_http(key);
            }
            self.pool.ws_ok(key);
            return self.run(Wire::Http, &request).await.map_err(|failed| failed.error);
        }
        match self.run(Wire::Ws, &request).await {
            Ok(stream) => Ok(stream),
            Err(failed) => {
                if let Some(key) = scope.as_deref() {
                    self.pool.ws_failed(key, switch::eligible(&failed.error));
                }
                let Some(fallback) = switching.then(|| switch::decide(route, &failed.error, failed.handshake, false)).flatten()
                else {
                    return Err(failed.error);
                };
                if fallback.sticky
                    && let Some(key) = scope.as_deref()
                {
                    self.pool.mark_http(key);
                }
                // A transport switch does not outrun the server's retry deadline.
                if let Some(wait) = failed.error.retry_after {
                    mixdog_rt::time::sleep(wait).await;
                }
                self.run(Wire::Http, &request).await.map_err(|failed| failed.error)
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wire {
    Ws,
    Http,
}

/// A failed attempt; `handshake` when the WebSocket upgrade itself was refused.
/// `refusal` with the credential its request carried redacted from its body.
fn scrub_refusal(mut refusal: ErrorResponse, credential: &Credential) -> ErrorResponse {
    let text = String::from_utf8_lossy(&refusal.body);
    let clean = crate::oauth::scrub::scrub_oauth_secrets(&text, &[&credential.bearer]);
    if clean != text {
        refusal.body = clean.into_bytes();
    }
    refusal
}

struct Failed {
    error: ProviderError,
    handshake: bool,
}

impl From<ProviderError> for Failed {
    fn from(error: ProviderError) -> Self {
        Self { error, handshake: false }
    }
}

impl OpenAiAdapter {
    /// The exchange on one wire with the credential repeats of an attempt.
    async fn run(&self, wire_kind: Wire, request: &Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, Failed> {
        let codec = match wire_kind {
            Wire::Ws => &self.codec,
            Wire::Http => self.http_codec.as_ref().unwrap_or(&self.codec),
        };
        let mut wire = codec.encode_with(request, effort_of(request).as_ref())?;
        let mut credential = self.credentials.current().await?;
        let mut refreshed = false;
        let mut stripped = false;
        loop {
            let authorized = self.authorize(wire.clone(), &credential);
            let opened = match wire_kind {
                Wire::Ws => self.open_ws(request, authorized, &credential).await?,
                Wire::Http => self.open_http(codec, request, authorized).await?,
            };
            let refused = matches!(opened, Opened::Rejected(_));
            let handshake = wire_kind == Wire::Ws && refused;
            let rejected = match opened {
                Opened::Stream(stream) => match stream.first_frame_failure() {
                    Some(failure) if !stripped && without_effort_updates(&wire, &failure).is_some() => failure,
                    _ => return Ok(Box::new(stream)),
                },
                Opened::Rejected(rejected) => rejected,
            };
            // The credential this request carried is redacted from whatever the refusal echoes of it (the message, the
            // body's error text), the upgrade rejection included.
            let rejected = scrub_refusal(rejected, &credential);
            if rejected.status == Some(401) && !refreshed {
                refreshed = true;
                if let Some(next) = self.credentials.after_rejection(&credential).await? {
                    credential = next;
                    continue;
                }
            }
            if !stripped && let Some(next) = without_effort_updates(&wire, &rejected) {
                stripped = true;
                wire = next;
                continue;
            }
            let mut err = codec.classify(&rejected);
            // `_wsErrLabel` for the upgrade (`openai-ws-handshake.mjs:107`), `httpLabel` for the HTTP/SSE request.
            let label = match (wire_kind, self.codec.route()) {
                (Wire::Ws, Route::Codex) => "OpenAI OAuth WS handshake",
                (Wire::Ws, _) => "OpenAI WS handshake",
                (Wire::Http, Route::Codex) => "OpenAI OAuth HTTP fallback",
                (Wire::Http, _) => "OpenAI HTTP fallback",
            };
            if refused {
                err.message = super::error::http_response_message(label, &rejected, &err, self.context.now_unix_ms());
            }
            if rejected.status == Some(401) && refreshed && err.kind == ErrorKind::Auth {
                err.reauth_required = true;
            }
            return Err(Failed { error: err, handshake });
        }
    }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

enum Source {
    Http(Box<dyn BodyStream>),
    Ws {
        checkout: Checkout,
        /// The first frame, read before the stream was handed out.
        pending: Option<Result<Message, TransportFault>>,
    },
}

impl Source {
    /// The next transport unit: a body chunk, or one WebSocket message.
    async fn next_unit(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self {
            Self::Http(body) => body.next().await,
            Self::Ws { checkout, pending } => loop {
                let item = match pending.take() {
                    Some(item) => Some(item),
                    None => checkout.socket.as_mut()?.recv().await,
                };
                match item? {
                    Ok(Message::Text(text)) => return Some(Ok(Bytes::copy_from_slice(text.as_bytes()))),
                    Ok(Message::Binary(bytes)) => return Some(Ok(Bytes::copy_from_slice(&bytes))),
                    Ok(_) => {}
                    Err(fault) => return Some(Err(fault)),
                }
            },
        }
    }
}

struct ResponsesStream {
    source: Option<Source>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    /// A pooled socket's request, to anchor its response.
    anchor: Option<Anchor>,
    /// The pool and session a failed exchange is recorded on, and whether the
    /// session may switch transports.
    ledger: Option<(Arc<WsPool>, String, bool)>,
    /// Where a WebSocket response's `x-codex-turn-state` goes (the context, the scope, the turn and the socket that
    /// owns it), until the first one is taken (`_captureTurnStateFromEvent` returns once its entry holds a token).
    turn_state: Option<(Arc<SessionContext>, String, String, u64)>,
}

/// `_captureTurnStateFromEvent`'s carriers (`turn-state-headers.mjs:41-46`), in its order: the event's headers, the
/// response's, the response metadata's, the event metadata's. A header name matches in any letter case; a string
/// value is taken when not empty, a number or boolean as its text, a list by its first non-empty string.
fn event_turn_state(event: &Value) -> Option<String> {
    let carriers = [event.get("headers"), event.pointer("/response/headers"), event.pointer("/response/metadata/headers"), event.pointer("/metadata/headers")];
    carriers.into_iter().flatten().filter_map(Value::as_object).find_map(|headers| {
        headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case(TURN_STATE_HEADER)).find_map(|(_, value)| match value {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            Value::Array(items) => items.iter().filter_map(Value::as_str).find(|s| !s.is_empty()).map(str::to_owned),
            _ => None,
        })
    })
}

/// The turn state of one frame, read from the parsed event as Node reads its decoded keys (`socket-handlers.mjs:93`).
/// The parse is skipped only for a frame that cannot hold the name: one with no escape at all (a JSON string then
/// writes every character of the name literally) and no literal occurrence of it in any letter case.
fn frame_turn_state(unit: &[u8]) -> Option<String> {
    let may_name = unit.contains(&b'\\') || unit.windows(TURN_STATE_HEADER.len()).any(|w| w.eq_ignore_ascii_case(TURN_STATE_HEADER.as_bytes()));
    may_name.then(|| serde_json::from_slice::<Value>(unit).ok()).flatten().as_ref().and_then(event_turn_state)
}

impl ResponsesStream {
    fn new(source: Source, decoder: Box<dyn WireDecoder>) -> Self {
        Self { source: Some(source), decoder, queue: VecDeque::new(), failed: None, anchor: None, ledger: None, turn_state: None }
    }

    /// Reads a WebSocket's first frame ahead of the consumer.
    async fn prime(&mut self) {
        if let Some(Source::Ws { checkout, pending }) = &mut self.source
            && let Some(socket) = checkout.socket.as_mut()
        {
            *pending = socket.recv().await;
        }
    }

    /// Notes what a frame says about the response it belongs to.
    fn note_frame(&mut self, unit: &[u8]) {
        // A token the turn refuses this socket (another one owns it) leaves the socket looking, as Node's entry keeps a
        // null `turnState` then.
        if let Some((context, scope, turn, owner)) = &self.turn_state
            && let Some(token) = frame_turn_state(unit)
            && context.capture(scope, turn, &token, Some(*owner))
        {
            self.turn_state = None;
        }
        let Some(anchor) = self.anchor.as_mut() else {
            return;
        };
        let names = |needle: &[u8]| unit.windows(needle.len()).any(|w| w == needle);
        if names(b"response.created") || names(b"response.completed") || names(b"response.done") {
            if let Ok(frame) = serde_json::from_slice::<Value>(unit)
                && let Some(id) = frame.get("response").and_then(|r| r.get("id")).and_then(Value::as_str).filter(|i| !i.is_empty())
            {
                anchor.response_id = Some(id.to_owned());
            }
        }
    }

    /// Queues decoded events; the response's output items are kept for the anchor.
    fn push(&mut self, events: Vec<StreamEvent>) {
        for event in &events {
            if let (StreamEvent::ReasoningReplay(replay), Some(anchor)) = (event, self.anchor.as_mut())
                && let Value::Array(items) = &replay.items
            {
                anchor.items.clone_from(items);
            }
        }
        self.queue.extend(events);
    }

    /// The response completed on a pooled socket: it keeps the anchor.
    fn park(&mut self) {
        let Some(Source::Ws { checkout, .. }) = self.source.take() else {
            return;
        };
        let mut chain = Chain::default();
        if let Some(anchor) = self.anchor.take()
            && let Some(id) = anchor.response_id
        {
            chain.anchor(&id, &anchor.body, &anchor.items);
        }
        checkout.finish(chain);
    }

    /// A pooled exchange failed with `error`: count it, and keep the session
    /// on HTTP/SSE when the server refused the frame itself.
    fn record_failure(&self, error: &ProviderError) {
        let Some((pool, key, switching)) = &self.ledger else {
            return;
        };
        pool.ws_failed(key, switch::eligible(error));
        if *switching && switch::too_big_close(error) {
            pool.mark_http(key);
        }
    }

    /// The first frame as a failed response, when it is an `error` frame.
    fn first_frame_failure(&self) -> Option<ErrorResponse> {
        let Some(Source::Ws { pending: Some(Ok(Message::Text(text))), .. }) = &self.source else {
            return None;
        };
        let frame: Value = serde_json::from_str(text.as_str()).ok()?;
        if frame.get("type").and_then(Value::as_str) != Some("error") {
            return None;
        }
        Some(ErrorResponse {
            status: frame.get("status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()),
            headers: Vec::new(),
            body: serde_json::to_vec(&frame).ok()?,
        })
    }
}

impl Drop for ResponsesStream {
    /// The consumer let go of the response. Before its terminal event that is a cancel (the user's, or a stall
    /// watchdog's): `onAbort` closes the socket with `4002 aborted`. After it, the socket goes back to the pool as on
    /// the next read. A failed exchange has no source left.
    fn drop(&mut self) {
        if self.decoder.terminal_seen() {
            self.park();
        } else if let Some(Source::Ws { checkout, .. }) = self.source.as_mut() {
            checkout.abandon(4002, "aborted");
        }
    }
}

#[async_trait]
impl ModelStream for ResponsesStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(Ok(event));
            }
            if let Some(err) = self.failed.take() {
                return Some(Err(err));
            }
            let source = self.source.as_mut()?;
            // The terminal event ends the attempt; anything after it is dropped.
            if self.decoder.terminal_seen() {
                self.park();
                self.source = None;
                return None;
            }
            match source.next_unit().await {
                Some(Ok(unit)) => {
                    self.note_frame(&unit);
                    match self.decoder.feed(&unit) {
                        Ok(events) => self.push(events),
                        Err(err) => {
                            self.record_failure(&err);
                            self.source = None;
                            self.failed = Some(err);
                        }
                    }
                }
                Some(Err(fault)) => {
                    let ending = match &self.source {
                        Some(Source::Ws { checkout, .. }) => checkout.socket.as_ref().and_then(|socket| socket.ending()),
                        _ => None,
                    };
                    self.source = None;
                    // What `ws` emitted first, as `socket-handlers.mjs` takes it: a close is `wsClosedError(code,
                    // reason)` (`onClose`), a refused frame `ws`'s own error, its message and code (`onError`).
                    let mut err = match ending {
                        Some(WsEnding::Close { code, reason }) => super::error::ws_closed(code, &reason, DeliveryState::Accepted),
                        Some(WsEnding::Violation { message, code, .. }) => {
                            let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                            err.message = message;
                            err.code = Some(code.to_owned());
                            err
                        }
                        None => ProviderError::transport(fault, DeliveryState::Accepted),
                    };
                    err.exposure = self.decoder.exposure();
                    self.record_failure(&err);
                    self.failed = Some(err);
                }
                None => {
                    self.source = None;
                    match self.decoder.finish() {
                        Ok(events) => self.push(events),
                        Err(err) => {
                            self.record_failure(&err);
                            self.failed = Some(err);
                        }
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    /// A leaf: `next` awaits nothing after the wire's terminal event (`park` is synchronous).
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    // WS1: the turn state of a frame is what Node's `_captureTurnStateFromEvent` takes from the parsed event, for every
    // frame Node's recording holds (`turn-state-capture.mjs`): an escaped name, any letter case, each carrier.
    #[test]
    fn a_frames_turn_state_is_what_nodes_capture_takes() {
        const RECORDING: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/turn-state-frames.json"));
        const CAPTURE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/turn-state-capture.mjs"));
        let node: Value = serde_json::from_str(RECORDING).unwrap();
        assert_eq!(node["manifest"]["exact"], true);
        assert_eq!(node["manifest"]["nodeCommit"], "b6f10295a");
        let sha: String = ring::digest::digest(&ring::digest::SHA256, CAPTURE).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(node["manifest"]["harness"]["turn-state-capture.mjs"], sha.as_str(), "turn-state-capture.mjs changed since the recording");
        let rust: Vec<Value> = node["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| {
                let frame = case["frame"].as_str().unwrap();
                serde_json::json!({ "frame": frame, "turnState": frame_turn_state(frame.as_bytes()) })
            })
            .collect();
        assert_eq!(Value::Array(rust), node["cases"]);
    }

    struct Held;

    impl mixdog_core_api::domain::keepalive::TransportKeepalive for Held {
        fn kind(&self) -> TransportKind {
            TransportKind::WebSocket
        }
        fn arm(&self, _: &KeepaliveSchedule) -> Result<(), TransportFault> {
            Ok(())
        }
        fn liveness(&self) -> mixdog_core_api::domain::keepalive::LinkLiveness {
            mixdog_core_api::domain::keepalive::LinkLiveness::Alive
        }
        fn may_start_response(&self) -> bool {
            true
        }
    }

    #[async_trait]
    impl crate::transport::link::WsSocket for Held {
        async fn send(&self, _: Message) -> Result<(), TransportFault> {
            Ok(())
        }
        async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
            None
        }
        fn link(&self) -> Arc<dyn mixdog_core_api::domain::keepalive::TransportKeepalive> {
            Arc::new(Held)
        }
    }

    // WS2: a turn state lives as Node's does (`turn-state-lifetime-capture.mjs`): one live socket owns its turn's
    // token, another socket under the same pool key gets none until the owner closes, a frame of another turn starts
    // the scope afresh, the HTTP route keys the turn as given while a socket keys its v7 form, and the session's end
    // clears the scope. Sockets are opened and closed through the pool, whose closing retires the owner.
    #[tokio::test]
    async fn a_turn_state_lives_as_long_as_nodes() {
        const RECORDING: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/turn-state-lifetime.json"));
        const CAPTURE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/turn-state-lifetime-capture.mjs"));
        let node: Value = serde_json::from_str(RECORDING).unwrap();
        assert_eq!(node["manifest"]["exact"], true);
        assert_eq!(node["manifest"]["nodeCommit"], "b6f10295a");
        let sha: String = ring::digest::digest(&ring::digest::SHA256, CAPTURE).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(node["manifest"]["harness"]["turn-state-lifetime-capture.mjs"], sha.as_str(), "turn-state-lifetime-capture.mjs changed since the recording");
        let pool_key = node["manifest"]["pool"].as_str().unwrap();
        let context = Arc::new(SessionContext::default());
        let pool = Arc::new(WsPool::with_events(context.clone()));
        let compat = Compat::new("Codex", "account", "cache");
        // Each open socket: its checkout and the turn its last frame named.
        let mut sockets: HashMap<u64, (Checkout, String)> = HashMap::new();
        let mut rust = Vec::new();
        for step in node["steps"].as_array().unwrap() {
            let mut out = step.clone();
            let turn = step["turn"].as_str().unwrap_or_default();
            match step["do"].as_str().unwrap() {
                "frame" => {
                    let n = step["socket"].as_u64().unwrap();
                    if !sockets.contains_key(&n) {
                        // Two sockets live under one key at once here, as Node's recording has them: the checkouts do
                        // not take the session's ownership (that would hold the second back until the first closed).
                        let mut checkout = pool.checkout(pool_key, &compat, true, true).await;
                        assert!(checkout.attach(Box::new(Held)));
                        sockets.insert(n, (checkout, String::new()));
                    }
                    let (checkout, last) = sockets.get_mut(&n).unwrap();
                    *last = super::super::client_meta::codex_uuid_v7(turn);
                    out["sent"] = json_of(context.activate(pool_key, last, Some(checkout.owner)));
                }
                "event" => {
                    let (checkout, last) = &sockets[&step["socket"].as_u64().unwrap()];
                    let _ = context.capture(pool_key, last, step["token"].as_str().unwrap(), Some(checkout.owner));
                }
                "close" => drop(sockets.remove(&step["socket"].as_u64().unwrap())),
                "http" => out["sent"] = json_of(context.turn_state(pool_key, turn)),
                "answer" => {
                    let _ = context.capture(pool_key, turn, step["token"].as_str().unwrap(), None);
                }
                "session-closed" => pool.release_session(pool_key),
                other => panic!("{other}"),
            }
            rust.push(out);
        }
        assert_eq!(Value::Array(rust), node["steps"]);
    }

    fn json_of(token: Option<String>) -> Value {
        token.map_or(Value::Null, Value::String)
    }
}

