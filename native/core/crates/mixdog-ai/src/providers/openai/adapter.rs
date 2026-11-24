#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

// Private names for existing callback/result shapes; representations are unchanged.
type SettingLookup = dyn Fn(&str) -> Option<String> + Send + Sync;

use crate::transport::deadlines::openai_http_response;
use crate::transport::link::Surface;
use crate::transport::link::deadline_error;
use crate::transport::model_driver::Expiry;
use crate::transport::model_driver::ModelAttempt;
use crate::transport::model_driver::ModelCall;
use crate::transport::model_driver::ModelDriver;
use mixdog_core_api::domain::provider::AttemptHandle;
use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::PhaseWindows;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_rt::Expired;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Boundary;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::provider::WsPhase;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use mixdog_rt::CpuBulk;
use mixdog_rt::LaneToken;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_util::sync::CancellationToken;

use super::codec::OpenAiCodec;
use super::config::Route;
use super::config::WireContext;
use super::config::request_scope;
use super::decoder::ResponsesDecoder;
use super::delta;
use super::delta::Chain;
use super::effort::EffortProjection;
use super::effort_retry::{EffortUpdateSupport, SentUpdates};
use super::hedge;
use super::models::OpenAiModels;
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

// Credentials

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
        f.debug_struct("Credential").field("bearer", &"[redacted]").field("account_id", &self.account_id).finish()
    }
}

/// What one request is sent on: its credential, and what the source that served it tells the login behind it by. A
/// rejection hands the whole attempt back, so the source acts on that login and on no other.
#[derive(Clone)]
pub struct Attempt {
    pub credential: Credential,
    /// The source's own; nothing else reads it.
    login: Option<Arc<dyn std::any::Any + Send + Sync>>,
}

impl Attempt {
    /// A credential with no login behind it (an API key).
    pub fn plain(credential: Credential) -> Self {
        Self { credential, login: None }
    }

    /// A credential served under `login`, which [`Self::login`] gives back to the source.
    pub fn served_under(credential: Credential, login: impl std::any::Any + Send + Sync) -> Self {
        Self { credential, login: Some(Arc::new(login)) }
    }

    pub fn login<T: std::any::Any>(&self) -> Option<&T> {
        self.login.as_ref()?.downcast_ref()
    }
}

impl From<Credential> for Attempt {
    fn from(credential: Credential) -> Self {
        Self::plain(credential)
    }
}

impl std::ops::Deref for Attempt {
    type Target = Credential;

    fn deref(&self) -> &Credential {
        &self.credential
    }
}

impl fmt::Debug for Attempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.credential.fmt(f)
    }
}

#[async_trait]
pub trait CredentialSource: Send + Sync {
    async fn current(&self) -> Result<Attempt, ProviderError>;
    /// The server rejected `rejected` with a 401: reload the key or refresh the token of the login that attempt was
    /// served under. `None` when the source still holds what was rejected; the request is sent once more either way.
    async fn after_rejection(&self, rejected: &Attempt) -> Result<Option<Attempt>, ProviderError>;
}

// Per-process request context

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
    retry_pace: Option<Arc<dyn crate::oauth::Pace>>,
    /// Node's `process.env`: the process environment unless a recording gives its own.
    var: Box<SettingLookup>,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            now: Box::new(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))),
            request_id: Box::new(|| rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect()),
            retry_pace: None,
            var: Box::new(|name| std::env::var(name).ok()),
        }
    }
}

/// The values no request carries: clock, request ids, live turn-state tokens,
/// and route/model effort rejections. Shared across adapters in a process.
#[derive(Default)]
pub struct SessionContext {
    states: Mutex<TurnStates>,
    sources: Sources,
    effort_updates: EffortUpdateSupport,
}

impl SessionContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// A context whose clock and request ids are the given ones: the wire
    /// parity recording runs both sides on one fixed clock and id.
    pub fn with_sources(now: impl Fn() -> u64 + Send + Sync + 'static, request_id: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self { sources: Sources { now: Box::new(now), request_id: Box::new(request_id), ..Sources::default() }, ..Self::default() }
    }

    /// The same context reading its settings from `var` instead of the process environment.
    pub fn with_var(mut self, var: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        self.sources.var = Box::new(var);
        self
    }

    /// The send's wait and jitter sources, paired with the clock supplied by
    /// `with_sources` when replaying Node's injected sleep.
    pub fn with_retry_pace(mut self, pace: Arc<dyn crate::oauth::Pace>) -> Self {
        self.sources.retry_pace = Some(pace);
        self
    }

    fn retry_samples(&self) -> mixdog_core_api::domain::retry::JitterSamples {
        self.sources
            .retry_pace
            .as_ref()
            .map_or_else(crate::retry::random_samples, |pace| mixdog_core_api::domain::retry::JitterSamples { step: pace.draw(), advice: pace.draw() })
    }

    async fn retry_wait(&self, delay: Duration) {
        match &self.sources.retry_pace {
            Some(pace) => pace.wait(delay).await,
            None => mixdog_rt::time::sleep(delay).await,
        }
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

// Adapter

#[derive(Clone)]
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
    /// `PROVIDER_HTTP_RESPONSE_TIMEOUT_MS`: Node reads it once, when the provider's modules load.
    http_response_ms: f64,
    /// `PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS` (read once, as the modules load); `None` when `MIXDOG_ENABLE_STREAM_WATCHDOG` turns
    /// the idle watchdog off.
    http_idle_ms: Option<f64>,
    /// `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS` of the HTTP transport.
    http_first_output_ms: f64,
    ws_timers: WsTimers,
}

/// `streamStalledError('Responses WS', …)`: what a stalled socket stream is called, whichever route it serves.
pub(crate) const WS_STREAM_LABEL: &str = "Responses WS";

/// The windows of a Responses WebSocket stream (`openai-ws-watchdogs.mjs`), the same for every route that speaks it:
/// `PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS` (`None` when `MIXDOG_ENABLE_STREAM_WATCHDOG` turns the idle watchdog off), its
/// `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS`, and the no-first-frame window after the request frame.
#[derive(Clone, Copy, Debug)]
pub(crate) struct WsTimers {
    idle_ms: Option<f64>,
    first_output_ms: f64,
    pre_stream_ms: Option<f64>,
}

impl WsTimers {
    pub(crate) fn read(var: &dyn Fn(&str) -> Option<String>) -> Self {
        use crate::providers::google::cache::policy;
        let idle_ms = policy::ws_semantic_idle_ms(var);
        Self { idle_ms, first_output_ms: policy::first_output_ms(var, idle_ms), pre_stream_ms: policy::ws_pre_stream_ms(var) }
    }

    pub(crate) fn windows(&self) -> PhaseWindows {
        let millis = |ms: f64| Duration::from_millis(ms as u64);
        PhaseWindows {
            head: None,
            payload: self.pre_stream_ms.map(millis),
            first_output: self.idle_ms.is_some().then(|| millis(self.first_output_ms)),
            idle: self.idle_ms.map(millis),
            recovery: None,
        }
    }
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
        let models = OpenAiModels::new(codec.with_transport(TransportKind::Http1), links.http.clone(), links.credentials.clone(), links.listing);
        // A socket's closing releases its hold on its turn's state.
        let pool = Arc::new(WsPool::with_events(links.context.clone()));
        let http_response_ms = crate::providers::google::cache::policy::http_response_ms(|name| links.context.var(name));
        let http_idle_ms = crate::providers::google::cache::policy::semantic_idle_ms(|name| links.context.var(name));
        let http_first_output_ms = crate::providers::google::cache::policy::first_output_ms(|name| links.context.var(name), http_idle_ms);
        let ws_timers = WsTimers::read(&|name| links.context.var(name));
        let ws_ping = crate::providers::google::cache::policy::ws_ping(|name| links.context.var(name), KeepaliveSchedule::SPEC.ws);
        let adapter = Self {
            id,
            codec,
            policy: super::policy::retry_policy(),
            keepalive: KeepaliveSchedule { ws: ws_ping, ..KeepaliveSchedule::SPEC },
            http: links.http,
            dial: links.dial,
            credentials: links.credentials,
            context: links.context,
            http_codec,
            pool,
            mode: TransportMode::default(),
            models,
            compress_lane: links.compress_lane,
            http_response_ms,
            http_idle_ms,
            http_first_output_ms,
            ws_timers,
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

    fn http_fallback_enabled(&self) -> bool {
        self.mode.http_fallback()
            && !self
                .context
                .var("MIXDOG_OPENAI_HTTP_FALLBACK")
                .is_some_and(|raw| matches!(raw.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"))
    }

    fn starts_on_http(&self, request: &ModelRequest) -> bool {
        self.codec.transport() != TransportKind::WebSocket
            || (self.mode.http_fallback() && self.codec.route() == Route::Codex && self.context.flag("MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK"))
            || (self.http_fallback_enabled()
                && self.pool.http_active(&request_scope(request).into_iter().chain(request.options.session_id.as_deref()).collect::<Vec<_>>()))
    }

    fn encode(&self, wire: Wire, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let effort = request
            .options
            .effort_projection
            .as_ref()
            .filter(|_| !self.context.effort_updates.is_rejected(self.id.as_str(), &request.model))
            .map(EffortProjection::from);
        self.codec_for(wire).encode_with(request, effort.as_ref())
    }

    fn codec_for(&self, wire: Wire) -> &OpenAiCodec {
        match wire {
            Wire::Ws => &self.codec,
            Wire::Http => self.http_codec.as_ref().unwrap_or(&self.codec),
        }
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
        wire.headers.insert(0, ("Authorization".into(), format!("Bearer {}", credential.bearer)));
        if self.codec.route() == Route::Codex {
            // The WebSocket handshake lists the account right behind the bearer (`openai-ws-pool.mjs:490`), the
            // HTTP request right behind `originator` (`openai-oauth-http-sse.mjs:76`); both send it empty for a token
            // that names no account (`auth.account_id || ''`).
            let account = credential.account_id.clone().unwrap_or_default();
            let at = if wire.transport == TransportKind::WebSocket {
                1
            } else {
                wire.headers.iter().position(|(name, _)| name.eq_ignore_ascii_case("originator")).map_or(wire.headers.len(), |i| i + 1)
            };
            wire.headers.insert(at, ("chatgpt-account-id".into(), account));
        }
        wire
    }

    /// Keeps the turn's `x-codex-turn-state` token for the turn's next request.
    fn remember_turn_state(&self, request: &ModelRequest, token: Option<&str>) {
        if let (Some(token), Some(scope), Some(turn)) =
            (token.filter(|t| !t.is_empty()), request_scope(request), request.options.thread.as_ref().and_then(|t| t.turn.as_ref()))
        {
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

    fn model_call(&self, request: &ModelRequest, ws: bool) -> ModelCall {
        let millis = |ms: f64| Duration::from_millis(ms as u64);
        let oauth = self.codec.route() != Route::ApiKey;
        let (windows, label) = if ws {
            (self.ws_timers.windows(), WS_STREAM_LABEL)
        } else {
            let watching = self.http_idle_ms.is_some();
            let windows = PhaseWindows {
                head: Some(millis(self.http_response_ms)),
                payload: watching.then(|| millis(self.http_first_output_ms)),
                first_output: watching.then(|| millis(self.http_first_output_ms)),
                idle: self.http_idle_ms.map(millis),
                recovery: None,
            };
            (windows, self.codec.http_label())
        };
        // The head's own timeout (`createTimeoutSignal`'s `<label> initial response timed out after <ms>ms`).
        let head = match (ws, oauth) {
            (false, true) => Surface::FetchLabeled("OpenAI OAuth HTTP fallback initial response"),
            (false, false) => Surface::FetchLabeled("OpenAI HTTP fallback initial response"),
            (true, true) => Surface::SocketLabeled("OpenAI OAuth WS initial response"),
            (true, false) => Surface::SocketLabeled("OpenAI WS initial response"),
        };
        ModelCall::new(&request.options.send_identity, windows, Arc::new(move |expiry, delivery, exposure| expired(label, head, expiry, delivery, exposure)))
    }

    async fn open_http(&self, codec: &OpenAiCodec, request: &ModelRequest, wire: WireRequest) -> Result<Opened, ProviderError> {
        let packed = self.compressed(&wire).await;
        let exchange = openai_http_response(codec.route() != Route::ApiKey, self.http_response_ms);
        let identity = &request.options.send_identity;
        // Every submission is an attempt of the driver (the plain re-send of a refused compressed body is another), whose
        // head, first-payload, first-output and idle windows are this route's; the driver enforces them over the body too.
        let call = self.model_call(request, false);
        let driver = ModelDriver::new(self.http.clone());
        // The credential is held and the request is being handed to the transport: its tier is this attempt's.
        identity.note_dispatched_speed_tier(wire_speed(&wire.body));
        let (mut response, mut attempt) = driver.send(&call, packed.clone().unwrap_or_else(|| wire.clone()), exchange).await?;
        // `resendIfEncodingRejected`: a 400/415 of a compressed request is drained and the same request sent plain;
        // the latch is set only when that plain request is accepted (the encoding was the cause).
        if packed.is_some() && matches!(response.status, 400 | 415) {
            let mut body = response.body;
            while let Some(Ok(_)) = body.next().await {}
            drop(body);
            (response, attempt) = driver.send(&call, wire, exchange).await?;
            if response.is_success() {
                ZSTD_LATCHED.store(true, Ordering::Relaxed);
            }
        }
        if response.is_success() {
            let token = header(&response.headers, TURN_STATE_HEADER).map(str::to_owned);
            self.remember_turn_state(request, token.as_deref());
            return Ok(Opened::Stream(
                ResponsesStream::new(Source::Http(response.body), codec.responses_decoder(request)).with_attempt(identity.clone(), attempt),
            ));
        }
        Ok(Opened::Rejected(read_failure(response).await?))
    }

    /// One exchange on a pooled socket. `wire` carries the request frame (and
    /// the handshake headers for a new socket); the frame actually sent is
    /// the delta against the socket's last response when it extends it.
    async fn open_ws(&self, request: &ModelRequest, wire: WireRequest, credential: &Attempt, force_fresh: bool) -> Result<Opened, ProviderError> {
        // Every operation on a socket is an attempt of the driver (a fallback, a refresh resume, a retry included): the head
        // wait counts from here, the acquire and the request frame within it, and the driver bounds each read after it.
        let attempt = self.model_call(request, true).begin();
        let speed = wire_speed(&wire.body);
        let sent = match attempt.bound(self.ws_submit(request, wire, credential, force_fresh)).await {
            // The request frame went out on the socket: only now does this attempt carry its tier.
            Ok(Ok(Submitted::Sent(sent))) => {
                request.options.send_identity.note_dispatched_speed_tier(speed);
                sent
            }
            Ok(Ok(Submitted::Rejected(refusal))) => {
                attempt.fail();
                return Ok(Opened::Rejected(refusal));
            }
            Ok(Err(error)) => {
                attempt.fail();
                return Err(error);
            }
            Err(expiry) => return Err(attempt.error(expiry, DeliveryState::Ambiguous, Exposure::default())),
        };
        let Sent { checkout, body, owner, scope_turn, token, updates } = *sent;
        // The socket took the request: that is this exchange's head, and the first payload is awaited from here.
        attempt.head_received();
        // A refusal on this socket is of the login its upgrade was authorized with, which a reused socket did not get
        // from this request.
        let authenticated = checkout.auth.clone();
        let mut stream = ResponsesStream::socket(checkout, self.codec.responses_decoder(request), request.options.send_identity.clone(), attempt, body);
        stream.credential = authenticated;
        stream.updates = updates;
        // `_captureTurnStateFromEvent` returns at once when the activation gave the socket a token.
        if let Some((scope, turn)) = scope_turn
            && token.is_none()
        {
            stream.turn_state = Some((self.context.clone(), scope, turn, owner));
        }
        // The first frame decides whether the server took the request.
        stream.prime().await;
        Ok(Opened::Stream(stream))
    }

    /// The acquire and the request frame of one WebSocket operation (the driver bounds them together as the head).
    async fn ws_submit(&self, request: &ModelRequest, wire: WireRequest, credential: &Attempt, force_fresh: bool) -> Result<Submitted, ProviderError> {
        let mut body: serde_json::Map<String, Value> =
            serde_json::from_slice(&wire.body).map_err(|_| ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))?;
        body.shift_remove("type");
        body.shift_remove("client_metadata");
        let cache_key = body.get("prompt_cache_key").and_then(Value::as_str).unwrap_or_default().to_owned();
        let identity = credential.account_id.as_deref().unwrap_or(&credential.bearer);
        let compat = Compat::new(&format!("{:?}", self.codec.route()), identity, &cache_key);
        let (key, shared) = match request_scope(request) {
            Some(scope) => (scope.to_owned(), false),
            None => (format!("\0shared:{}:{}", compat.auth, compat.cache_key), true),
        };
        let mut checkout = self.pool.checkout(&key, &compat, shared, force_fresh).await;
        if checkout.socket.is_none() {
            if let Some(refusal) = self.dial_into(&mut checkout, &wire).await? {
                return Ok(Submitted::Rejected(refusal));
            }
            checkout.auth = Some(credential.clone());
        }
        self.send_frame(request, checkout, body).await
    }

    /// One acquire of a new socket for `checkout`; `Some` is the upgrade's refusal.
    async fn dial_into(&self, checkout: &mut Checkout, wire: &WireRequest) -> Result<Option<ErrorResponse>, ProviderError> {
        // One acquire is a hedged race of dial legs under the acquire deadline (`openHedged`).
        ws_request(wire)?;
        let window = hedge::Window::from_settings(|name| self.context.var(name));
        let dialed = match hedge::race(window, || async {
            let handshake = ws_request(wire).map_err(|_| ConnectError::Transport(TransportFault::Io { os_code: None }))?;
            self.dial.dial(handshake).await
        })
        .await
        {
            hedge::Raced::Opened(connected) => Ok(connected),
            hedge::Raced::Failed(error) => Err(error),
            hedge::Raced::TimedOut => {
                let label = if self.codec.route() == Route::ApiKey { "OpenAI WS" } else { "OpenAI OAuth WS" };
                return Err(hedge::acquire_timeout(label, window));
            }
        };
        let (socket, upgrade) = match dialed {
            Ok((socket, upgrade)) => {
                // The ping schedule `MIXDOG_PROVIDER_WS_PING_INTERVAL_MS` and `MIXDOG_PROVIDER_WS_PONG_TIMEOUT_MS`
                // tune replaces the dialer's before the first frame; a link that cannot take it keeps the dialer's.
                let _ = socket.link().arm(&self.keepalive);
                (socket, upgrade)
            }
            Err(ConnectError::Transport(fault)) => {
                let mut error = ProviderError::transport(fault, DeliveryState::NotSent);
                // `ws` reports a connection reset during the upgrade as the request's own error.
                if error.transport == Some(TransportFault::Reset) {
                    error.code = Some("ECONNRESET".into());
                    error.message = "socket hang up".into();
                }
                return Err(error);
            }
            Err(ConnectError::Proxy { code, message }) => {
                // The network proxy policy or the proxy refused: nothing was sent.
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.code = Some(code);
                error.message = message;
                return Err(error);
            }
            Err(ConnectError::Rejected(response)) => {
                let headers = response.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned()))).collect();
                return Ok(Some(ErrorResponse { status: Some(response.status().as_u16()), headers, body: response.into_body().unwrap_or_default() }));
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
        Ok(None)
    }

    async fn send_frame(&self, request: &ModelRequest, checkout: Checkout, body: serde_json::Map<String, Value>) -> Result<Submitted, ProviderError> {
        let framed = delta::compute(self.mode.delta(), &checkout.chain, &body);
        // `_withCodexWsClientMetadata`: the frame activates its turn under the session's pool key, with this socket as
        // the turn state's owner.
        let scope_turn = request_scope(request).zip(self.codec.ws_turn(request));
        let token = scope_turn.as_ref().and_then(|(scope, turn)| self.context.activate(scope, turn, Some(checkout.owner)));
        let frame = self.codec.ws_frame(request, framed.frame, token.as_deref());
        let updates = SentUpdates::of(frame.get("input"));
        let text = serde_json::to_string(&Value::Object(frame)).map_err(|_| ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))?;
        let socket = checkout.socket.as_ref().expect("a checked-out socket");
        socket.send(Message::text(text)).await.map_err(|fault| {
            let mut error = ProviderError::transport(fault, DeliveryState::Ambiguous);
            error.ws_phase = Some(WsPhase::Stream);
            error
        })?;
        let owner = checkout.owner;
        let scope_turn = scope_turn.map(|(scope, turn)| (scope.to_owned(), turn));
        Ok(Submitted::Sent(Box::new(Sent { checkout, body, owner, scope_turn, token, updates })))
    }
}

/// A WebSocket operation's request on the wire: the socket that took it and what the stream built over it needs.
struct Sent {
    checkout: Checkout,
    body: serde_json::Map<String, Value>,
    owner: u64,
    /// The turn's pool scope and turn id, where the response's turn state is to be captured.
    scope_turn: Option<(String, String)>,
    token: Option<String>,
    updates: SentUpdates,
}

enum Submitted {
    Sent(Box<Sent>),
    /// The upgrade was refused: a status, headers and body.
    Rejected(ErrorResponse),
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
fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
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
    let mut request = wire.url.as_str().into_client_request().map_err(|_| invalid("url"))?;
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
    fn release_send(&self, _group: &str) {}
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

    /// One send. WebSocket handshake and stream failures share its bounded
    /// provider recovery; transport switches are decided by that same owner.
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let refresh = Arc::new(RefreshOnce::default());
        let mut auth = AuthRetry::default();
        match self.attempt_once(request.clone(), &refresh, &mut auth).await {
            Err(error) if self.unknown_model(&error) && refresh.take() => {}
            sent => return sent,
        }
        mixdog_rt::node_stderr!("[openai-oauth-ws] unknown model — refreshing catalog + 1 retry");
        self.codec.facts().refresh().await;
        self.attempt_once(request, &refresh, &mut auth).await
    }
}

/// The one catalog refresh a send may spend (`opts._modelRetry`, `openai-oauth.mjs:320`), shared by the refusal that comes
/// before the stream opens and the one inside it.
#[derive(Default)]
struct RefreshOnce(std::sync::atomic::AtomicBool);

impl RefreshOnce {
    /// Takes the refresh: true for the first caller only.
    fn take(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::SeqCst)
    }
}

impl OpenAiAdapter {
    fn unknown_model(&self, error: &ProviderError) -> bool {
        self.codec.route() == Route::Codex
            && crate::providers::rejections::names_unknown_model(error.status, &error.message)
            && !(error.ws_phase == Some(WsPhase::Handshake) && error.status == Some(404))
            && replay_safe(error)
            && error.partial_usage.is_none()
    }

    async fn attempt_once(&self, request: Arc<ModelRequest>, refresh: &Arc<RefreshOnce>, auth: &mut AuthRetry) -> Result<Box<dyn ModelStream>, ProviderError> {
        // `_sendOnce` re-warms before every turn (`openai-oauth.mjs:170`).
        self.preconnect();
        let wire_kind = if self.starts_on_http(&request) { Wire::Http } else { Wire::Ws };
        let wire = self.encode(wire_kind, &request)?;
        let mut send = ResponsesSend {
            adapter: self.clone(),
            retry: mixdog_core_api::domain::retry::RetryState::new(mixdog_core_api::domain::retry::RetryClass::Midstream, request.model.clone()),
            request,
            wire,
            stream: None,
            first_failure: None,
            output_exposed: false,
            reasoning_exposed: false,
            visible_progress: false,
            wire_kind,
            auth: std::mem::take(auth),
            effort_reissued: false,
            refresh: Arc::clone(refresh),
        };
        match send.resume(None, false).await {
            Ok(()) => Ok(Box::new(send)),
            Err(error) => {
                *auth = send.auth;
                Err(error)
            }
        }
    }
}

/// The premium speed a Responses body (or `response.create` frame) asks for: `priority`, `ultrafast` or `fast`; any other
/// tier, `flex` included, groups as standard speed (empty).
fn wire_speed(body: &[u8]) -> &'static str {
    #[derive(serde::Deserialize)]
    struct Sent {
        service_tier: Option<String>,
    }
    match serde_json::from_slice::<Sent>(body) {
        Ok(Sent { service_tier: Some(tier) }) => match tier.as_str() {
            "priority" => "priority",
            "ultrafast" => "ultrafast",
            "fast" => "fast",
            _ => "",
        },
        _ => "",
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wire {
    Ws,
    Http,
}

struct Failed {
    error: ProviderError,
    handshake: bool,
    effort_rejected: bool,
}

impl From<ProviderError> for Failed {
    fn from(error: ProviderError) -> Self {
        let handshake = error.ws_phase == Some(WsPhase::Handshake);
        Self { error, handshake, effort_rejected: false }
    }
}

fn replay_safe(error: &ProviderError) -> bool {
    let exposure = error.exposure;
    !error.unsafe_to_retry && !exposure.text_emitted && !exposure.tool_dispatched && !exposure.tool_input_cut
}

/// A send may renew once, regardless of which transport or response boundary
/// returned the 401. Remember the exact credential used for the replacement.
#[derive(Default)]
struct AuthRetry {
    spent: bool,
    renewed: Option<Attempt>,
}

impl AuthRetry {
    async fn renew(&mut self, source: &dyn CredentialSource, rejected: &Attempt) -> Result<Attempt, ProviderError> {
        self.spent = true;
        let next = source.after_rejection(rejected).await?.unwrap_or_else(|| rejected.clone());
        self.renewed = Some(next.clone());
        Ok(next)
    }
}

// Stream

/// One logical send's handshake and stream ladder. Neither the pool nor the
/// caller owns another WebSocket counter. Replays preserve the full request,
/// not the failed connection's delta chain.
struct ResponsesSend {
    adapter: OpenAiAdapter,
    request: Arc<ModelRequest>,
    wire: WireRequest,
    stream: Option<ResponsesStream>,
    retry: mixdog_core_api::domain::retry::RetryState,
    first_failure: Option<ProviderError>,
    output_exposed: bool,
    reasoning_exposed: bool,
    wire_kind: Wire,
    visible_progress: bool,
    auth: AuthRetry,
    effort_reissued: bool,
    /// The send's one catalog refresh, spent by a refusal before the stream opened or by one inside it.
    refresh: Arc<RefreshOnce>,
}

impl ResponsesSend {
    /// An unknown-model refusal inside the stream (`response.failed` with `model_not_found`, before any output was shown):
    /// the roster is read again and the request, encoded anew from it, is sent once more.
    async fn resend_after_refresh(&mut self) -> Result<(), ProviderError> {
        mixdog_rt::node_stderr!("[openai-oauth-ws] unknown model — refreshing catalog + 1 retry");
        self.adapter.codec.facts().refresh().await;
        self.wire = self.adapter.encode(self.wire_kind, &self.request)?;
        self.resume(None, false).await
    }

    fn note_exposure(&mut self, event: &StreamEvent) {
        self.reasoning_exposed |=
            matches!(event, StreamEvent::ReasoningDelta(text) if !text.is_empty()) || matches!(event, StreamEvent::Progress(ProgressKind::Reasoning));
        self.output_exposed |= matches!(event,
            StreamEvent::TextDelta(text) | StreamEvent::FinalContent(text)
                if !text.is_empty()
        ) || matches!(event, StreamEvent::ToolCallDone(_));
        self.visible_progress |= matches!(event, StreamEvent::Progress(kind) if kind.is_visible());
    }

    /// A failure inside the stream: the credential renewal, the catalog refresh or the reconnect ladder takes it; `Err` is
    /// the send's answer.
    async fn recover_from(&mut self, mut error: ProviderError, effort_rejected: bool, rejected_key: Option<Attempt>) -> Result<(), ProviderError> {
        error.unsafe_to_retry |= self.output_exposed;
        if self.reasoning_exposed {
            // Shown reasoning rules out this send's own reconnect and refresh; whether the cut is replayed
            // is the loop's decision, which can withdraw what was shown (`latchExposure` marks it unsafe
            // and nothing more).
            error.unsafe_to_retry = true;
            error.reauth_required |= error.status == Some(401) && self.auth.spent && error.kind == ErrorKind::Auth;
            return Err(error);
        }
        if error.status == Some(401) {
            if self.auth.spent {
                error.reauth_required |= error.kind == ErrorKind::Auth;
            } else if replay_safe(&error)
                && !self.visible_progress
                && let Some(key) = rejected_key
            {
                if let Err(refresh_error) = self.auth.renew(self.adapter.credentials.as_ref(), &key).await {
                    return Err(if self.adapter.codec.route() == Route::ApiKey || error.partial_usage.is_some() { error } else { refresh_error });
                }
                let sent = &self.request.options.send_identity;
                if error.partial_usage.is_some() && !crate::registry::accounted::handoff_abandoned_usage(&mut error, sent) {
                    return Err(error);
                }
                sent.note_dispatched_speed_tier("");
                if self.wire_kind == Wire::Http {
                    sent.restart_attempts();
                    self.adapter.renew_request_id(self.wire_kind, &mut self.wire);
                }
                return self.resume(None, true).await;
            }
        }
        if self.wire_kind == Wire::Ws && self.adapter.unknown_model(&error) && self.refresh.take() {
            return self.resend_after_refresh().await;
        }
        self.resume(Some(Failed { error, handshake: false, effort_rejected }), false).await
    }

    async fn resume(&mut self, mut failed: Option<Failed>, mut fresh: bool) -> Result<(), ProviderError> {
        loop {
            if let Some(Failed { mut error, handshake, effort_rejected }) = failed.take() {
                error.unsafe_to_retry |= self.output_exposed;
                if effort_rejected {
                    self.reissue_without_effort_updates(error)?;
                    fresh = true;
                } else if self.wire_kind == Wire::Http || error.partial_usage.is_some() {
                    return Err(error);
                } else {
                    fresh |= self.reconnect_after(error, handshake).await?;
                }
            }
            match self.adapter.exchange(self.wire_kind, &self.request, &mut self.wire, fresh, &mut self.auth).await {
                Ok(stream) => {
                    self.stream = Some(stream);
                    return Ok(());
                }
                Err(error) => failed = Some(error),
            }
        }
    }

    /// The endpoint refused the request's effort updates: the send is encoded and begun anew without them, once, and only
    /// while nothing of the response was shown.
    fn reissue_without_effort_updates(&mut self, mut error: ProviderError) -> Result<(), ProviderError> {
        if !replay_safe(&error) || self.visible_progress {
            return Err(error);
        }
        self.adapter.context.effort_updates.mark_rejected(self.adapter.id.as_str(), &self.request.model);
        if self.effort_reissued {
            return Err(error);
        }
        let sent = &self.request.options.send_identity;
        if error.partial_usage.is_some() {
            if !crate::registry::accounted::handoff_abandoned_usage(&mut error, sent) {
                return Err(error);
            }
            sent.note_dispatched_speed_tier("");
        }
        self.effort_reissued = true;
        self.retry = mixdog_core_api::domain::retry::RetryState::new(mixdog_core_api::domain::retry::RetryClass::Midstream, self.request.model.clone());
        self.first_failure = None;
        sent.restart_attempts();
        self.wire_kind = if self.adapter.starts_on_http(&self.request) { Wire::Http } else { Wire::Ws };
        self.wire = self.adapter.encode(self.wire_kind, &self.request)?;
        Ok(())
    }

    /// Falls back to HTTP or waits out the retry the ladder allows; `Ok(true)` when the next exchange is a retry on a fresh
    /// connection, `Ok(false)` when it is the HTTP fallback.
    async fn reconnect_after(&mut self, error: ProviderError, handshake: bool) -> Result<bool, ProviderError> {
        use mixdog_core_api::domain::retry::{RetryDecider, Verdict};

        let decision = crate::retry::StandardRetryDecider.verdict(&error, &self.retry, &self.adapter.policy, self.adapter.context.retry_samples());
        let exhausted = matches!(decision.verdict, Verdict::Exhausted);
        if let Some(fallback) = self.adapter.http_fallback_enabled().then(|| switch::decide(self.adapter.codec.route(), &error, handshake, exhausted)).flatten()
        {
            if fallback.sticky
                && let Some(scope) = request_scope(&self.request)
            {
                self.adapter.pool.mark_http(scope);
            }
            if let Some(wait) = error.retry_after {
                self.adapter.context.retry_wait(wait).await;
            }
            self.wire_kind = Wire::Http;
            // What the fallback answers is not the roster's to refresh (Node's refresh check precedes the fallback).
            self.refresh.take();
            self.wire = self.adapter.encode(Wire::Http, &self.request)?;
            return Ok(false);
        }
        let Verdict::Retry { delay, .. } = decision.verdict else {
            return Err(self.ended_ladder(error, exhausted));
        };
        if !handshake || self.first_failure.is_none() {
            self.first_failure = Some(error.clone());
        }
        self.retry = decision.next;
        self.request.options.send_identity.raise_stage_with(
            "reconnecting",
            crate::retry::stage::reconnecting(
                &error,
                self.retry.count(None).retries,
                self.adapter.policy.midstream.schedule.max_retries,
                delay,
                self.adapter.context.now_unix_ms(),
            ),
        );
        self.adapter.context.retry_wait(delay).await;
        Ok(true)
    }

    /// The error a ladder with no retry left ends on: the first failure replaces a later one that is no more current.
    fn ended_ladder(&mut self, mut error: ProviderError, exhausted: bool) -> ProviderError {
        let current = matches!(error.status, Some(401 | 403 | 426 | 429))
            || switch::too_big_close(&error)
            || error.unsafe_to_retry
            || error.exposure.text_emitted
            || error.exposure.tool_dispatched
            || error.exposure.tool_input_cut
            // A connection retirement must neither mask nor be masked by another failure.
            || [Some(&error), self.first_failure.as_ref()].into_iter().flatten().any(super::error::connection_limit);
        if !current && let Some(first) = self.first_failure.take() {
            error = first;
        }
        // An exposed stream needs the owner's retraction or split-call
        // recovery, not another provider retry. Only a genuinely ended
        // ladder forbids that owner-controlled new request.
        error.recovery_exhausted |= exhausted;
        if exhausted || (!error.exposure.text_emitted && !error.exposure.tool_input_cut && !self.output_exposed) {
            error.should_retry = Some(false);
        }
        error
    }
}

#[async_trait]
impl ModelStream for ResponsesSend {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            let stream = self.stream.as_mut()?;
            let event = stream.next().await?;
            match event {
                Ok(event) => {
                    self.note_exposure(&event);
                    return Some(Ok(event));
                }
                Err(error) => {
                    let effort_rejected = stream.updates.rejected(&error, stream.decoder.failure_param());
                    let rejected_key = stream.credential.take();
                    self.stream = None;
                    if let Err(error) = self.recover_from(error, effort_rejected, rejected_key).await {
                        return Some(Err(error));
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

#[allow(clippy::large_enum_variant, reason = "Keep the live WebSocket checkout and pending frame inline rather than add an allocation to every stream")]
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

/// The failure of `expiry` for a stream labelled `label`: the head is the transport's own timeout (`head`); the first-payload,
/// first-output and idle windows are the stream stall (`streamStalledError`, `stall-policy.mjs:161`: `ESTREAMSTALL`, phase
/// `idle`, unsafe to retry once a tool call was dispatched).
pub(crate) fn expired(label: &str, head: Surface, expiry: Expiry, delivery: DeliveryState, exposure: Exposure) -> ProviderError {
    match expiry.phase {
        AttemptPhase::Connect | AttemptPhase::Head | AttemptPhase::Recovery => {
            let mut err = deadline_error(Expired { after: expiry.window }, delivery, head);
            err.exposure = exposure;
            err
        }
        AttemptPhase::Payload | AttemptPhase::FirstOutput | AttemptPhase::Idle | AttemptPhase::Retired => {
            let mut err = ProviderError::new(ErrorKind::Transient, delivery);
            err.code = Some("ESTREAMSTALL".into());
            err.message = format!("{label} stream timed out after {}ms of inactivity", expiry.window.as_millis());
            mixdog_rt::node_stderr!("[provider-stall] {} (tool dispatched: {})", err.message, exposure.tool_dispatched);
            err.timed_out = true;
            err.timeout_phase = Some(StreamTimeoutPhase::Idle);
            err.exposure = exposure;
            err.unsafe_to_retry = exposure.tool_dispatched;
            err
        }
    }
}

pub(crate) struct ResponsesStream {
    source: Option<Source>,
    /// The exchange runs on a WebSocket: a failure of it is a stream failure of that send (`wsFailurePhase`).
    ws: bool,
    decoder: ResponsesDecoder,
    updates: SentUpdates,
    credential: Option<Attempt>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    /// A pooled socket's request, to anchor its response.
    anchor: Option<Anchor>,
    /// Where a WebSocket response's `x-codex-turn-state` goes (the context, the scope, the turn and the socket that
    /// owns it), until the first one is taken (`_captureTurnStateFromEvent` returns once its entry holds a token).
    turn_state: Option<(Arc<SessionContext>, String, String, u64)>,
    /// The send and the attempt this stream answers: transport health is marked on the send while the attempt is current,
    /// the first payload and the first output (and an item boundary after output) are published on the attempt, whose
    /// deadlines they install (a stale stream changes nothing). The stream runs no timer of its own.
    attempt: Option<(mixdog_core_api::domain::provider::SendIdentity, AttemptHandle)>,
    /// A WebSocket's attempt: the driver wraps the socket's reads, which it cannot do for a body it does not own, under the
    /// deadline of the phase the attempt is in. An HTTP stream's body is the driver's already.
    bound: Option<ModelAttempt>,
    /// A whole protocol record was decoded: the first-output window runs from then.
    payload_seen: bool,
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
    fn new(source: Source, decoder: ResponsesDecoder) -> Self {
        let ws = matches!(source, Source::Ws { .. });
        Self {
            source: Some(source),
            ws,
            decoder,
            updates: SentUpdates::default(),
            credential: None,
            queue: VecDeque::new(),
            failed: None,
            anchor: None,
            turn_state: None,
            attempt: None,
            bound: None,
            payload_seen: false,
        }
    }

    /// The stream of an HTTP exchange: its body is the driver's, and `attempt` is what its boundaries are published on.
    fn with_attempt(mut self, identity: mixdog_core_api::domain::provider::SendIdentity, attempt: AttemptHandle) -> Self {
        self.attempt = Some((identity, attempt));
        self
    }

    /// The response to the request frame `body` a pooled socket took: its reads are bounded by `attempt`, and once it
    /// completes the socket is parked with the chain the next request's delta extends.
    pub(crate) fn socket(
        checkout: Checkout,
        decoder: ResponsesDecoder,
        identity: mixdog_core_api::domain::provider::SendIdentity,
        attempt: ModelAttempt,
        body: serde_json::Map<String, Value>,
    ) -> Self {
        let mut stream = Self::new(Source::Ws { checkout, pending: None }, decoder).with_bound(identity, attempt);
        stream.anchor = Some(Anchor { body, response_id: None, items: Vec::new() });
        stream
    }

    /// The stream of a WebSocket operation: its reads are bounded by `attempt`.
    fn with_bound(mut self, identity: mixdog_core_api::domain::provider::SendIdentity, attempt: ModelAttempt) -> Self {
        self.attempt = Some((identity, attempt.handle().clone()));
        self.bound = Some(attempt);
        self
    }

    /// Transport health (`onStreamDelta('transport')`): a unit of the response arrived. Not a boundary, not a keepalive; a stream
    /// whose attempt a later one replaced or that ended marks nothing.
    fn mark_transport(&self) {
        if let Some((identity, attempt)) = &self.attempt
            && attempt.context().is_some()
        {
            identity.raise_transport();
        }
    }

    /// Reads a WebSocket's first frame ahead of the consumer, under the attempt's first-payload window. A socket that takes the
    /// request and sends nothing fails the stream as a stall, which the send's retry ladder takes.
    pub(crate) async fn prime(&mut self) {
        let (Some(attempt), Some(Source::Ws { checkout, pending })) = (&self.bound, &mut self.source) else { return };
        let Some(socket) = checkout.socket.as_mut() else { return };
        match attempt.bound(socket.recv()).await {
            Ok(first) => *pending = first,
            Err(expiry) => {
                let err = attempt.error(expiry, DeliveryState::Accepted, Exposure::default());
                self.source = None;
                self.failed = Some(err);
            }
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
        if (names(b"response.created") || names(b"response.completed") || names(b"response.done"))
            && let Ok(frame) = serde_json::from_slice::<Value>(unit)
            && let Some(id) = frame.get("response").and_then(|r| r.get("id")).and_then(Value::as_str).filter(|i| !i.is_empty())
        {
            anchor.response_id = Some(id.to_owned());
        }
    }

    /// Queues decoded events; the response's output items are kept for the anchor.
    fn push(&mut self, events: Vec<StreamEvent>) {
        let mut served = None;
        for event in &events {
            match event {
                StreamEvent::ServedModel(model) => served = Some(model),
                // A terminal bundle can queue a tool before its usage. The
                // consumer can cancel while handling that tool.
                StreamEvent::Usage(usage) => crate::registry::accounted::observe_attempt_usage(usage.clone(), served.cloned()),
                _ => {}
            }
            if let (StreamEvent::ReasoningReplay(replay), Some(anchor)) = (event, self.anchor.as_mut())
                && let Value::Array(items) = &replay.items
            {
                anchor.items.clone_from(items);
            }
        }
        self.queue.extend(events);
    }

    fn defer_failure(&mut self, error: ProviderError) {
        // Decoding can produce output and a billed failure in the same read.
        // Publish the bill before yielding the queued output, in case it is the
        // last event the consumer reads before cancelling.
        if let Some(usage) = error.partial_usage.as_deref() {
            crate::registry::accounted::observe_attempt_usage(usage.clone(), error.partial_model.as_deref().map(str::to_owned));
        }
        self.failed = Some(error);
    }

    fn surfaced(&mut self, mut err: ProviderError) -> ProviderError {
        if self.ws {
            err.ws_phase = Some(WsPhase::Stream);
        }
        if let Some(credential) = &self.credential {
            err.message = crate::oauth::scrub::scrub_oauth_secrets(&err.message, &[&credential.bearer]);
        }
        self.decoder.fail(err)
    }

    /// An HTTP body is the driver's: a read that outlives the deadline of the attempt's phase ends with its fault. A
    /// socket's reads are bounded here, under the same deadline.
    async fn read_unit(&mut self) -> Result<Option<Result<Bytes, TransportFault>>, ProviderError> {
        let source = self.source.as_mut().expect("a stream with a source");
        match &self.bound {
            Some(attempt) => attempt.bound(source.next_unit()).await.map_err(|expiry| attempt.error(expiry, DeliveryState::Accepted, self.decoder.exposure())),
            None => Ok(source.next_unit().await),
        }
    }

    fn on_unit(&mut self, unit: &[u8]) {
        self.mark_transport();
        self.note_frame(unit);
        match self.decoder.feed(unit) {
            Ok(events) => {
                self.publish_boundaries(&events);
                self.push(events);
                // A failure held back behind this unit's events surfaces after them, not on the next read.
                if let Err(err) = self.decoder.feed(&[]) {
                    self.source = None;
                    self.defer_failure(err);
                }
            }
            Err(err) => {
                self.source = None;
                self.defer_failure(err);
            }
        }
    }

    /// A whole protocol record (a comment or metadata frame is not one) ends the payload wait and starts the first-output
    /// window; the first output moves the attempt to its idle phase, where output and an item boundary after it renew the
    /// window (keepalives and metadata never do).
    fn publish_boundaries(&mut self, events: &[StreamEvent]) {
        let Some((_, attempt)) = &self.attempt else { return };
        if !self.payload_seen && (self.decoder.payload_seen() || events.iter().any(|e| !matches!(e, StreamEvent::ProviderKeepalive))) {
            self.payload_seen = true;
            attempt.observe(Boundary::FirstProtocolPayload);
        }
        let idle = attempt.context().is_some_and(|ctx| ctx.phase == AttemptPhase::Idle);
        if events.iter().any(crate::providers::idle::output) || (idle && events.iter().any(crate::providers::idle::boundary)) {
            attempt.observe(Boundary::FirstSemanticOutput);
        }
    }

    fn on_fault(&mut self, fault: TransportFault) {
        // A phase deadline of the driver ended an HTTP body: its one failure, as classified above.
        if let Some(Source::Http(body)) = &self.source
            && let Some(timed) = body.expired(self.decoder.exposure())
        {
            self.source = None;
            self.failed = Some(timed);
            return;
        }
        let ending = match &self.source {
            Some(Source::Ws { checkout, .. }) => checkout.socket.as_ref().and_then(|socket| socket.ending()),
            _ => None,
        };
        let connection = match &self.source {
            Some(Source::Http(body)) => body.connection(),
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
        err.connection = connection;
        err.exposure = self.decoder.exposure();
        self.failed = Some(err);
    }

    fn on_end(&mut self) {
        self.source = None;
        match self.decoder.finish() {
            Ok(events) => {
                self.push(events);
                if let Err(err) = self.decoder.feed(&[]) {
                    self.defer_failure(err);
                }
            }
            Err(err) => self.defer_failure(err),
        }
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
                return Some(Err(self.surfaced(err)));
            }
            self.source.as_ref()?;
            // The terminal event ends the attempt; anything after it is dropped.
            if self.decoder.terminal_seen() {
                self.park();
                self.source = None;
                return None;
            }
            match self.read_unit().await {
                Err(err) => {
                    self.source = None;
                    self.failed = Some(err);
                }
                Ok(Some(Ok(unit))) => self.on_unit(&unit),
                Ok(Some(Err(fault))) => self.on_fault(fault),
                Ok(None) => self.on_end(),
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

    // WS1: the turn state of a frame, for every case in `turn_state_frames.json`: an escaped name, any letter case, each carrier.
    #[test]
    fn a_frames_turn_state_is_taken_from_every_carrier() {
        const CASES: &str = include_str!("turn_state_frames.json");
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let rust: Vec<Value> = cases
            .as_array()
            .unwrap()
            .iter()
            .map(|case| {
                let frame = case["frame"].as_str().unwrap();
                serde_json::json!({ "frame": frame, "turnState": frame_turn_state(frame.as_bytes()) })
            })
            .collect();
        assert_eq!(Value::Array(rust), cases);
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

    #[tokio::test]
    async fn a_turn_state_lives_as_long_as_its_socket_and_turn() {
        const SCRIPT: &str = include_str!("turn_state_lifetime.json");
        let node: Value = serde_json::from_str(SCRIPT).unwrap();
        let pool_key = node["pool"].as_str().unwrap();
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
                        // Two sockets live under one key at once here, as the script has them: the checkouts do
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

#[cfg(test)]
mod idle_tests {
    use std::sync::atomic::AtomicUsize;

    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::SendIdentity;

    use super::*;
    use crate::catalog::ListingLookup;
    use crate::providers::idle::testing::Timetable;
    use crate::providers::openai::scripted::ScriptedDial;
    use crate::transport::HttpResponse;
    use crate::transport::link::Exchange;

    struct Creds;

    #[async_trait]
    impl CredentialSource for Creds {
        async fn current(&self) -> Result<Attempt, ProviderError> {
            Ok(Credential { bearer: "fixture-key".into(), account_id: None }.into())
        }
        async fn after_rejection(&self, _: &Attempt) -> Result<Option<Attempt>, ProviderError> {
            Ok(None)
        }
    }

    /// A transport that answers each request's head after `head_after[n]` seconds with a body that delivers `chunks[n]` on its
    /// timetable and then stays silent.
    struct Script {
        head_after: Vec<u64>,
        chunks: Vec<Vec<(u64, &'static str)>>,
        next: AtomicUsize,
    }

    impl Script {
        fn of(head_after: &[u64], chunks: &[&[(u64, &'static str)]]) -> Arc<Self> {
            Arc::new(Self { head_after: head_after.to_vec(), chunks: chunks.iter().map(|c| c.to_vec()).collect(), next: 0.into() })
        }
    }

    #[async_trait]
    impl HttpSend for Script {
        async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            let n = self.next.fetch_add(1, Ordering::SeqCst);
            mixdog_rt::time::sleep(Duration::from_secs(self.head_after[n])).await;
            Ok(HttpResponse { status: 200, headers: Vec::new(), body: Timetable::of(&self.chunks[n]) })
        }
    }

    fn adapter() -> OpenAiAdapter {
        let context = Arc::new(SessionContext::new());
        let config = super::super::config::OpenAiConfig::api_key(false, Arc::new(super::super::config::NoFacts), context.clone());
        OpenAiAdapter::new(
            ProviderId::from("openai"),
            OpenAiCodec::new(config, TransportKind::Http1),
            AdapterLinks {
                http: Script::of(&[], &[]),
                dial: ScriptedDial::with(Vec::new()),
                compress_lane: mixdog_rt::testing::tokens().cpu_bulk,
                credentials: Arc::new(Creds),
                context,
                listing: ListingLookup::new(),
            },
        )
    }

    fn wire() -> WireRequest {
        WireRequest { transport: TransportKind::Http1, method: "POST".into(), url: "http://x.test/".into(), headers: Vec::new(), body: Vec::new() }
    }

    fn request(identity: &SendIdentity) -> ModelRequest {
        ModelRequest {
            model: "m".into(),
            messages: Vec::new(),
            tools: Vec::new(),
            options: RequestOptions { send_identity: identity.clone(), ..RequestOptions::default() },
        }
    }

    fn responses_decoder() -> ResponsesDecoder {
        ResponsesDecoder::new(super::super::decoder::Framing::Sse, Arc::new(SessionContext::default()), ProviderId::from("openai"))
    }

    /// One model submission through the driver, read through the adapter's stream.
    #[allow(clippy::result_large_err, reason = "a test helper")]
    async fn open(adapter: &OpenAiAdapter, script: Arc<Script>, identity: &SendIdentity) -> Result<ResponsesStream, ProviderError> {
        let call = adapter.model_call(&request(identity), false);
        let (response, attempt) = ModelDriver::new(script).send(&call, wire(), openai_http_response(false, 60_000.0)).await?;
        Ok(ResponsesStream::new(Source::Http(response.body), responses_decoder()).with_attempt(identity.clone(), attempt))
    }

    async fn failure(stream: &mut ResponsesStream) -> ProviderError {
        loop {
            match stream.next().await.expect("the window ends the stream") {
                Ok(_) => continue,
                Err(err) => break err,
            }
        }
    }

    const CREATED: &str = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"m\"}}\n\n";
    const TEXT: &str = concat!(
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"m\"}}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"msg_1\",\"delta\":\"hi\"}\n\n",
    );

    /// The head window this route declares (`PROVIDER_HTTP_RESPONSE_TIMEOUT_MS`, 60 s) is the driver's: a head that never comes
    /// expires at it, not at the fallback's 120 s, with the initial-response wording; and every submission is an attempt with a
    /// whole fresh window, so two 50 s heads in a row are both answered.
    #[tokio::test(start_paused = true)]
    async fn the_http_head_window_is_the_declared_one_and_a_resend_gets_a_whole_fresh_window() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let began = tokio::time::Instant::now();
        assert!(open(&adapter, Script::of(&[50], &[&[]]), &identity).await.is_ok());
        assert!(open(&adapter, Script::of(&[50], &[&[]]), &identity).await.is_ok());
        assert_eq!(began.elapsed(), Duration::from_secs(100), "two windows' worth of heads, each inside its own");
        let began = tokio::time::Instant::now();
        let err = open(&adapter, Script::of(&[100_000], &[&[]]), &identity).await.err().expect("the head never comes");
        assert_eq!(began.elapsed(), Duration::from_secs(60));
        assert_eq!(err.code.as_deref(), Some("EPROVIDERTIMEOUT"));
        assert_eq!(err.message, "OpenAI HTTP fallback initial response timed out after 60000ms");
    }

    /// Silence after the head is the first-payload wait, declared as `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS`: longer than the fallback
    /// head window it must survive, and it expires at its own value.
    #[tokio::test(start_paused = true)]
    async fn a_declared_window_longer_than_the_fallback_survives_it_and_expires_at_its_own_value() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let window = adapter.http_first_output_ms as u64;
        assert!(window > PhaseWindows::FALLBACK_HEAD.as_millis() as u64, "the declared window outlasts the fallback head");
        let mut stream = open(&adapter, Script::of(&[0], &[&[]]), &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(began.elapsed(), Duration::from_millis(window));
        assert_eq!(err.code.as_deref(), Some("ESTREAMSTALL"));
        assert_eq!(err.message, format!("OpenAI HTTP fallback stream timed out after {window}ms of inactivity"));
        assert!(stream.next().await.is_none());
    }

    /// Metadata received 100 s into the response does not buy another first-output window.
    #[tokio::test(start_paused = true)]
    async fn payload_then_silence_expires_at_the_original_first_output_deadline() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let window = adapter.http_first_output_ms as u64;
        let mut stream = open(&adapter, Script::of(&[0], &[&[(100, CREATED)]]), &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(began.elapsed(), Duration::from_millis(window));
        assert_eq!(err.message, format!("OpenAI HTTP fallback stream timed out after {window}ms of inactivity"));
    }

    /// Output starts the idle window, which is the declared semantic idle one.
    #[tokio::test(start_paused = true)]
    async fn silence_after_output_expires_at_the_declared_idle_window() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let idle = adapter.http_idle_ms.expect("the watchdog is on") as u64;
        let mut stream = open(&adapter, Script::of(&[0], &[&[(0, TEXT)]]), &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(began.elapsed(), Duration::from_millis(idle));
        assert_eq!(err.message, format!("OpenAI HTTP fallback stream timed out after {idle}ms of inactivity"));
        assert!(err.exposure.text_emitted);
    }

    /// Answers a turn request with the next scripted `(status, body)` and records each request's `content-encoding`; the warm-up
    /// HEAD is answered empty and not counted.
    struct Refusing {
        answers: Mutex<VecDeque<(u16, Box<dyn BodyStream>)>>,
        encodings: Mutex<Vec<Option<String>>>,
    }

    /// A body that delivers its chunks and then ends.
    struct Ending(VecDeque<Bytes>);

    #[async_trait]
    impl BodyStream for Ending {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.pop_front().map(Ok)
        }
    }

    #[async_trait]
    impl HttpSend for Refusing {
        async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            if request.method == "HEAD" {
                return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Ending(VecDeque::new())) });
            }
            self.encodings.lock().unwrap().push(header(&request.headers, "content-encoding").map(str::to_owned));
            let (status, body) = self.answers.lock().unwrap().pop_front().expect("a scripted answer");
            Ok(HttpResponse { status, headers: Vec::new(), body })
        }
    }

    /// A Codex adapter over `http`, and a body large enough to be compressed.
    fn codex(http: Arc<Refusing>) -> (OpenAiAdapter, WireRequest) {
        let context = Arc::new(SessionContext::new());
        let identity =
            super::super::config::CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: "b".into() };
        let config = super::super::config::OpenAiConfig::codex(false, identity, Arc::new(super::super::config::NoFacts), context.clone());
        let adapter = OpenAiAdapter::new(
            ProviderId::from("openai-oauth"),
            OpenAiCodec::new(config, TransportKind::Http1),
            AdapterLinks {
                http,
                dial: ScriptedDial::with(Vec::new()),
                compress_lane: mixdog_rt::testing::tokens().cpu_bulk,
                credentials: Arc::new(Creds),
                context,
                listing: ListingLookup::new(),
            },
        );
        let wire =
            WireRequest { transport: TransportKind::Http1, method: "POST".into(), url: "http://x.test/".into(), headers: Vec::new(), body: vec![b'a'; 20_000] };
        (adapter, wire)
    }

    /// A compressed request the backend refuses with 400 is sent once more plain, whether the refusal's body drains or stalls:
    /// a stalled one ends the cleanup at the refused exchange's own window (its first error), and the plain request, an attempt
    /// of its own with whole windows, arrives and succeeds.
    #[tokio::test(start_paused = true)]
    async fn a_refused_compressed_body_that_stalls_ends_its_cleanup_and_the_plain_request_is_sent() {
        reset_zstd_latch();
        for (label, refusal) in
            [("stalled", Timetable::of(&[(0, "{}")]) as Box<dyn BodyStream>), ("drained", Box::new(Ending([Bytes::from_static(b"{}")].into())))]
        {
            let http = Arc::new(Refusing {
                answers: Mutex::new([(400, refusal), (200, Box::new(Ending([Bytes::from_static(CREATED.as_bytes())].into())) as Box<dyn BodyStream>)].into()),
                encodings: Mutex::default(),
            });
            let (adapter, wire) = codex(http.clone());
            let identity = SendIdentity::default();
            let began = tokio::time::Instant::now();
            let opened = adapter.open_http(&adapter.codec, &request(&identity), wire).await.expect("the plain request is answered");
            assert!(matches!(opened, Opened::Stream(_)), "{label}: the plain request succeeded");
            assert_eq!(*http.encodings.lock().unwrap(), [Some("zstd".to_owned()), None], "{label}: compressed, then plain");
            if label == "stalled" {
                assert_eq!(began.elapsed(), Duration::from_millis(adapter.http_first_output_ms as u64), "the drain ended at the refused attempt's own window");
            } else {
                assert_eq!(began.elapsed(), Duration::ZERO);
            }
            let log = identity.take_boundaries();
            let started = log.iter().filter(|(_, b)| *b == Boundary::AttemptStarted).count();
            assert_eq!(started, 2, "{label}: the resend is an attempt of its own");
            reset_zstd_latch();
        }
    }

    /// A read that carries output and then a failing frame delivers the output and then the failure: the stream does not
    /// end quietly at the failing terminal frame.
    #[tokio::test(start_paused = true)]
    async fn output_read_together_with_a_failing_frame_is_delivered_before_the_failure() {
        let frames = [
            serde_json::json!({ "type": "response.created", "response": { "id": "resp_1", "model": "m" } }),
            serde_json::json!({ "type": "response.output_item.added", "output_index": 0, "item": { "type": "message", "id": "msg_1", "role": "assistant", "content": [] } }),
            serde_json::json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_1", "delta": "partial" }),
            serde_json::json!({ "type": "response.failed", "response": { "id": "resp_1", "status": "failed", "error": { "code": "server_error", "message": "boom" } } }),
        ];
        let chunk: &'static str = Box::leak(frames.iter().map(|f| format!("data: {f}\n\n")).collect::<String>().into_boxed_str());
        let mut stream = ResponsesStream::new(Source::Http(Timetable::of(&[(0, chunk)])), responses_decoder());
        let mut text = String::new();
        let failure = loop {
            match stream.next().await.expect("the failure ends the stream") {
                Ok(StreamEvent::TextDelta(delta)) => text.push_str(&delta),
                Ok(_) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(text, "partial");
        assert!(failure.exposure.text_emitted);
        assert!(stream.next().await.is_none());
    }

    /// A stream whose attempt a later one replaced is stale: its late chunk marks no transport and moves no phase of the
    /// current attempt.
    #[tokio::test(start_paused = true)]
    async fn a_replaced_attempts_late_chunk_changes_nothing() {
        let identity = SendIdentity::default();
        let stale = identity.begin_attempt(PhaseWindows::default(), false);
        let mut stream = ResponsesStream::new(Source::Http(Timetable::of(&[(1, TEXT)])), responses_decoder()).with_attempt(identity.clone(), stale);
        let current = identity.begin_attempt(PhaseWindows::default(), false);
        identity.take_boundaries();
        assert!(matches!(stream.next().await, Some(Ok(_))), "the stale stream still decodes its own bytes");
        assert!(identity.take_boundaries().is_empty(), "no boundary of the stale attempt reaches the send");
        assert!(!identity.take_transport(), "no transport mark either");
        let ctx = identity.attempt_context();
        assert_eq!((ctx.id, ctx.phase), (current.id(), AttemptPhase::Head));
    }
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
fn raise_requesting(identity: &mixdog_core_api::domain::provider::SendIdentity, wire_kind: Wire, resending: bool) {
    match wire_kind {
        Wire::Ws => identity.raise_stage("requesting"),
        Wire::Http => {
            if resending {
                identity.restart_attempts();
            }
            let attempt = identity.next_attempt();
            identity.raise_stage_with(
                "requesting",
                serde_json::json!({ "attempt": attempt + 1, "maxAttempts": super::policy::REQUEST_RETRIES + 1, "retry": attempt > 0 }),
            );
        }
    }
}

impl OpenAiAdapter {
    /// A resend over HTTP is a request of its own, which Node builds anew with a fresh `x-client-request-id`
    /// (`openai-oauth-http-sse.mjs`, once per `sendViaHttpSse`); the WebSocket's resend keeps its headers.
    fn renew_request_id(&self, wire_kind: Wire, wire: &mut WireRequest) {
        if wire_kind == Wire::Ws {
            return;
        }
        for (name, value) in &mut wire.headers {
            if name.eq_ignore_ascii_case("x-client-request-id") {
                *value = self.context.request_id();
            }
        }
    }

    /// The acquisition fixture exercises one exchange, not the send's retry ladder.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn ws_attempt_once(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let mut wire = self.encode(Wire::Ws, &request)?;
        let mut auth = AuthRetry::default();
        let stream = self.exchange(Wire::Ws, &request, &mut wire, false, &mut auth).await.map_err(|failed| failed.error)?;
        Ok(Box::new(stream))
    }

    /// The failure a refused request is: classified, labelled for its wire, its message free of the credential, and whether
    /// the refusal names the effort updates the request carried.
    fn refusal_failure(
        &self,
        wire_kind: Wire,
        request: &ModelRequest,
        wire: &WireRequest,
        rejected: &ErrorResponse,
        http_updates: &SentUpdates,
        auth: &AuthRetry,
    ) -> Failed {
        let mut err = self.codec_for(wire_kind).classify(rejected);
        let handshake = wire_kind == Wire::Ws;
        let effort_rejected = !handshake && request.options.effort_projection.is_some() && rejected.status == Some(400) && {
            let body = serde_json::from_slice::<Value>(&rejected.body).ok();
            let param = body.as_ref().and_then(|b| b.get("error").unwrap_or(b).get("param")).and_then(Value::as_str);
            http_updates.rejected(&err, param)
        };
        // `rejectedToolSchema`: a 400 that names one of the tools this body carried.
        crate::providers::rejections::mark_tool_schema(&mut err, &rejected.body, &crate::providers::rejections::wire_tool_names(&wire.body));
        // `_wsErrLabel` for the upgrade (`openai-ws-handshake.mjs:107`), `httpLabel` for the HTTP/SSE request.
        let label = match (wire_kind, self.codec.route()) {
            (Wire::Ws, Route::Codex) => "OpenAI OAuth WS handshake",
            (Wire::Ws, _) => "OpenAI WS handshake",
            (Wire::Http, Route::Codex) => "OpenAI OAuth HTTP fallback",
            (Wire::Http, _) => "OpenAI HTTP fallback",
        };
        err.message = super::error::http_response_message(label, rejected, &err, self.context.now_unix_ms());
        if rejected.status == Some(401) && auth.spent && err.kind == ErrorKind::Auth {
            err.reauth_required = true;
        }
        if handshake {
            err.ws_phase = Some(WsPhase::Handshake);
        }
        Failed { error: err, handshake, effort_rejected }
    }

    async fn exchange(
        &self,
        wire_kind: Wire,
        request: &Arc<ModelRequest>,
        wire: &mut WireRequest,
        force_fresh: bool,
        auth: &mut AuthRetry,
    ) -> Result<ResponsesStream, Failed> {
        let codec = self.codec_for(wire_kind);
        let public = codec.route() == Route::ApiKey;
        let identity = &request.options.send_identity;
        let mut credential = match auth.renewed.as_ref() {
            Some(key) => key.clone(),
            _ => self.credentials.current().await?,
        };
        let mut http_updates = if wire_kind == Wire::Http && request.options.effort_projection.is_some() {
            let body = serde_json::from_slice::<Value>(&wire.body).ok();
            SentUpdates::of(body.as_ref().and_then(|b| b.get("input")))
        } else {
            SentUpdates::default()
        };
        let mut resending = false;
        loop {
            raise_requesting(identity, wire_kind, resending);
            let authorized = self.authorize(wire.clone(), &credential);
            let opened = match wire_kind {
                // The acquire and the upgrade are the handshake; a failure past the socket is stamped where it happens.
                Wire::Ws => self.open_ws(request, authorized, &credential, force_fresh || resending).await.map_err(|mut error| {
                    error.ws_phase.get_or_insert(WsPhase::Handshake);
                    error
                })?,
                Wire::Http => self.open_http(codec, request, authorized).await?,
            };
            let rejected = match opened {
                Opened::Stream(mut stream) => {
                    stream.credential.get_or_insert(credential);
                    if wire_kind == Wire::Http {
                        stream.updates = std::mem::take(&mut http_updates);
                    }
                    return Ok(stream);
                }
                Opened::Rejected(rejected) => rejected,
            };
            // The credential this request carried is redacted from whatever the refusal echoes of it (the message, the
            // body's error text), the upgrade rejection included.
            let rejected = scrub_refusal(rejected, &credential);
            if rejected.status == Some(401) && !auth.spent {
                // `openai-oauth-dispatch.mjs:205` (HTTP/SSE) and `openai-oauth.mjs:285` (WebSocket).
                if self.codec.route() == Route::Codex {
                    match wire_kind {
                        Wire::Http => mixdog_rt::node_stderr!("[openai-oauth-http] 401 — forcing refresh and retrying once over HTTP/SSE"),
                        Wire::Ws => mixdog_rt::node_stderr!("[openai-oauth-ws] 401 — forcing refresh and retrying once over WS"),
                    }
                }
                match auth.renew(self.credentials.as_ref(), &credential).await {
                    Ok(next) => {
                        credential = next;
                        resending = true;
                        self.renew_request_id(wire_kind, wire);
                        continue;
                    }
                    Err(err) if !public => return Err(err.into()),
                    Err(_) => {}
                }
            }
            return Err(self.refusal_failure(wire_kind, request, wire, &rejected, &http_updates, auth));
        }
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod recovery_tests;
