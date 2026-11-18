//! A first-party gateway that serves one account on several wires (Node `WireGatewayProvider`, `OpenCodeGoProvider`,
//! `CommandCodeOAuthProvider`, and the xAI / Muse Code engines of `OpenAICompatProvider`): the Chat engine owns the
//! account, the listing and the routing table; every send goes out on the wire its route names, through that
//! wire's engine (`sendOnRoute`, `wire-route.mjs`).
//!
//! A routed gateway answers one clear "this model is not served on this wire" refusal, before any output, by
//! sending the same request once more on the next wire the model is served on (`sendOnRoute`), and reports the
//! session's new route ([`StreamEvent::WireRerouted`]).

// Private names for existing callback/result shapes; representations are unchanged.
type MessagesCeilingLookup = dyn Fn(&str) -> Option<u32> + Send + Sync;

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::MediaSupport;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RetryLine;
use mixdog_core_api::domain::provider::RetryLineStyle;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::provider::WireRoute;
use mixdog_core_api::domain::provider::WireRouteContext;
use mixdog_core_api::domain::provider::WireRouting;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

use crate::transport::BodyStream;

use crate::providers::compat::adapter::CompatAdapter;
use crate::providers::compat::error::opencode_inference_reauth;
use crate::providers::compat::creds::OpenCodeGoCredentials;
use crate::providers::compat::login::opencode_go::{GATEWAY_AUTH_RECOVERY, GATEWAY_CREDENTIAL, OpenCodeGoAuth, RefreshError};
use crate::providers::compat::profile::Wire;
use crate::providers::compat::responses::CompatResponsesCodec;
use crate::providers::compat::xai_transport::{self, XaiSocket};
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

tokio::task_local! {
    /// The headers one gateway send adds to every request its engine makes (OpenCode Go's `x-opencode-session`,
    /// Node's per-send `requestHeaders`).
    static SEND_HEADERS: Vec<(String, String)>;
    /// The refusal one routed attempt received: its status and body, as the typed error Node reads them from.
    static REFUSAL: Arc<Mutex<Option<Refusal>>>;
}

/// An HTTP refusal as it arrived.
#[derive(Clone)]
struct Refusal {
    status: u16,
    headers: Vec<(String, String)>,
    body: Value,
}

// `isWireUnsupportedError` (`wire-route.mjs`): 405 / 501 name the endpoint itself; 400 / 404 / 415 / 422 count
// only when the text says the endpoint or route is unsupported; a typed auth, quota, billing or parameter failure
// never does.
static ENDPOINT_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:endpoints?|routes?)\b|/(?:v1/)?(?:messages|responses|chat/completions)\b|chat completions").unwrap());
static UNSUPPORTED_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bunsupported\b|not (?:be )?(?:supported|available|served|implemented)|(?:does not|doesn't|do not|don't) (?:support|serve)|only (?:available|supported|served)|wrong endpoint|use (?:the )?/?(?:v1/)?(?:messages|responses|chat/completions)\b").unwrap()
});
static NON_WIRE_ERROR_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)auth|permission|forbidden|api_?key|token|quota|billing|credit|balance|payment|insufficient|rate_?limit|too_many|overload|capacity|(?:unsupported|unknown|unrecognized|invalid)_?(?:parameter|param|field|argument|value)|invalid_?(?:request_)?param|context_?length|max_?tokens").unwrap()
});
static NON_WIRE_ERROR_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:unsupported|unknown|unrecognized|unexpected|invalid|extra|not permitted|not allowed)\s+(?:request\s+)?(?:parameters?|params?|fields?|arguments?|propert(?:y|ies)|options?|values?|keys?)\b|\bparameters?\b[^.]{0,40}\b(?:not supported|unsupported|not allowed)|\bquota\b|\bbilling\b|\bcredits?\b|\bbalance\b|\binsufficient\b|rate[ -]?limit|too many requests|unauthori[sz]ed|\bforbidden\b|invalid api key|api key|\bpayment\b|\bsubscription\b").unwrap()
});

/// Whether `error` is a clear "this model is not served on this wire" refusal (Node `isWireUnsupportedError`): the
/// only failure a send answers by switching wire. Read from the refusal's status and body as Node's typed error
/// carries them (`code`, `type`, `param`, `message`); an exposed, aborted, auth or quota failure never qualifies.
fn wire_unsupported(error: &ProviderError, refusal: Option<&Refusal>) -> bool {
    let Some(refusal) = refusal else { return false };    if error.exposure.text_emitted || error.exposure.tool_dispatched || error.unsafe_to_retry || error.reauth_required {
        return false;
    }
    let detail = refusal.body.get("error").filter(|e| e.is_object()).unwrap_or(&refusal.body);
    if detail.get("param").is_some_and(Value::is_string) {
        return false;
    }
    let typed = [detail.get("code"), detail.get("type")].into_iter().flatten().filter_map(Value::as_str).chain(error.code.as_deref());
    if typed.into_iter().any(|t| NON_WIRE_ERROR_TYPE.is_match(t)) {
        return false;
    }
    let text = [Some(error.message.as_str()), detail.get("message").and_then(Value::as_str), refusal.body.get("error").and_then(Value::as_str)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if NON_WIRE_ERROR_TEXT.is_match(&text) {
        return false;
    }
    match refusal.status {
        405 | 501 => true,
        400 | 404 | 415 | 422 => ENDPOINT_WORDS.is_match(&text) && UNSUPPORTED_WORDS.is_match(&text),
        _ => false,
    }
}

/// `lowerHistoryForRoute`: the first `count` assistant turns go without their wire-native replay (provider replay,
/// thinking and assistant blocks, the routing metadata).
fn lowered(request: Arc<ModelRequest>, count: usize) -> Arc<ModelRequest> {
    if count == 0 {
        return request;
    }
    let mut owned = (*request).clone();
    for message in owned.messages.iter_mut().filter(|m| m.role == Role::Assistant).take(count) {
        message.thinking_blocks = None;
        message.assistant_blocks = None;
        message.account_routing = None;
        message.retain_replay(|_| false);
    }
    Arc::new(owned)
}

/// The rerouted attempt's stream: the session's new route first, then the attempt's own events.
struct Rerouted {
    route: Option<Value>,
    inner: Box<dyn ModelStream>,
}

#[async_trait]
impl ModelStream for Rerouted {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if let Some(route) = self.route.take() {
            return Some(Ok(StreamEvent::WireRerouted(route)));
        }
        self.inner.next().await
    }
    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }
    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        self.inner.on_wire_left(left);
    }
}

/// A refused answer's body, read whole and served again as it arrived.
struct Replayed(VecDeque<Result<Bytes, TransportFault>>);

#[async_trait]
impl BodyStream for Replayed {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front()
    }
}

/// The Responses wire of a gateway: the Chat engine's account (key, reload after a 401, redaction) with the
/// Responses codec.
pub struct ResponsesEngine {
    account: Arc<CompatAdapter>,
    codec: Arc<CompatResponsesCodec>,
    xai_socket: Option<XaiSocket>,
}

impl ResponsesEngine {
    pub fn new(account: Arc<CompatAdapter>, codec: CompatResponsesCodec) -> Self {
        Self { account, codec: Arc::new(codec), xai_socket: None }
    }

    /// Only the public xAI provider gets the opt-in socket. The Grok OAuth proxy stays on HTTP.
    pub fn with_xai_websocket(mut self, dial: Arc<dyn crate::transport::WsDial>, configured: Option<String>, env: Arc<dyn super::keys::Environment>) -> Self {
        debug_assert_eq!(self.account.id().as_str(), "xai");
        self.xai_socket = Some(XaiSocket::new(&self.codec, dial, configured, env));
        self
    }
}

#[async_trait]
impl ProviderAdapter for ResponsesEngine {
    fn release_send(&self, group: &str) {
        self.account.release_send(group);
    }
    fn release_session(&self, session_id: &str) {
        if let Some(socket) = self.xai_socket.as_ref() {
            socket.release_session(session_id);
        }
        self.account.release_session(session_id);
    }
    fn id(&self) -> &ProviderId {
        self.account.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.codec.as_ref()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.account.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.account.keepalive()
    }
    /// `compatStreamRetryReporter` of the Responses send: `<name>:responses` (openai-compat-responses.mjs:319, :267;
    /// xAI's own send names the same, openai-compat-xai-send.mjs:154).
    fn retry_line(&self, _model: &str) -> Option<RetryLine> {
        Some(RetryLine { tag: format!("[{}:responses]", self.account.id()), delay: true, style: RetryLineStyle::Attempt })
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let request = self.account.with_default_effort(request);
        if !request.options.send_identity.xai_http_fallback()
            && let Some(socket) = self.xai_socket.as_ref()
            && let Some(fallback) = socket.selection(request.options.xai_responses_transport.as_deref())
        {
            let first = socket.open(&self.account, &request).await;
            let replay = GatewayReplay::XaiHttp { account: self.account.clone(), codec: self.codec.clone(), enabled: fallback };
            return BeforeOutput::open(first, request, replay).await;
        }
        self.account.attempt_with(self.codec.as_ref(), request).await
    }
    /// The account's endpoint and key, the Responses wire's image form.
    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        let mut facts = self.account.image_route(request).await;
        facts.branch = mixdog_image_egress::route::WireBranch::OpenAiResponses;
        facts
    }
}

enum GatewayReplay {
    XaiHttp { account: Arc<CompatAdapter>, codec: Arc<CompatResponsesCodec>, enabled: bool },
    OpenCode { pin: Option<Arc<GoPin>>, engine: Arc<dyn ProviderAdapter>, headers: Vec<(String, String)>, inclusive: bool },
}

struct GoPin {
    auth: OpenCodeGoAuth,
    credentials: Mutex<Arc<OpenCodeGoCredentials>>,
}

impl GoPin {
    fn credential(&self) -> Arc<OpenCodeGoCredentials> {
        self.credentials.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

fn go_auth_error(failure: RefreshError) -> ProviderError {
    let (kind, status, message) = match failure {
        RefreshError::Reauth(message, status) => (ErrorKind::Auth, Some(status), format!("OpenCode sign-in expired: {message}")),
        RefreshError::Failed(message, status) => (ErrorKind::Transient, status, message),
    };
    let mut error = ProviderError::new(kind, DeliveryState::NotSent);
    error.status = status;
    error.reauth_required = kind == ErrorKind::Auth;
    error.message = message;
    error
}

async fn go_scope<T>(credential: Option<Arc<OpenCodeGoCredentials>>, future: impl std::future::Future<Output = T>) -> T {
    match credential {
        Some(credential) => GATEWAY_CREDENTIAL.scope(credential, GATEWAY_AUTH_RECOVERY.scope((), future)).await,
        None => GATEWAY_AUTH_RECOVERY.scope((), future).await,
    }
}

fn preserve_bill(error: &mut ProviderError, request: &ModelRequest) -> bool {
    crate::registry::accounted::attach_observed_usage(error);
    if error.partial_usage.as_deref().is_some_and(|usage| crate::registry::accounting::Facts::from(usage).recordable()) {
        crate::registry::accounted::handoff_abandoned_usage(error, &request.options.send_identity)
    } else {
        true
    }
}

impl GatewayReplay {
    fn is_opencode(&self) -> bool {
        matches!(self, Self::OpenCode { .. })
    }

    fn permits(&self, error: &mut ProviderError, request: &ModelRequest) -> bool {
        if error.unsafe_to_retry || error.reauth_required || error.exposure != Default::default()
            || !error.partial_tool_calls.is_empty()
        {
            return false;
        }
        let eligible = match self {
            Self::XaiHttp { enabled, .. } => *enabled && xai_transport::can_fallback(error),
            Self::OpenCode { pin, .. } => pin.is_some() && error.status == Some(401) && error.kind == ErrorKind::Auth
                && request.options.send_identity.claim_refresh(format!("opencode-go:{}", request.options.send_identity.account().map_or_else(|| "default".into(), |sent| sent.account))),
        };
        eligible && preserve_bill(error, request)
    }

    async fn resend(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        request.options.send_identity.reissue();
        request.options.send_identity.note_dispatched_speed_tier("");
        match self {
            Self::XaiHttp { account, codec, .. } => {
                request.options.send_identity.use_xai_http_fallback();
                account.attempt_with(codec.as_ref(), request).await
            }
            Self::OpenCode { pin, engine, headers, inclusive } => {
                let pin = pin.as_ref().expect("only a pinned sign-in may replay");
                let credential = pin.auth.refresh_pinned(&pin.credential()).await.map_err(go_auth_error)?;
                *pin.credentials.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(credential);
                Self::open_opencode(engine.as_ref(), headers.clone(), request, Some(pin), *inclusive).await.map_err(opencode_inference_reauth)
            }
        }
    }

    async fn open_opencode(engine: &dyn ProviderAdapter, headers: Vec<(String, String)>, request: Arc<ModelRequest>, pin: Option<&Arc<GoPin>>, inclusive: bool) -> Result<Box<dyn ModelStream>, ProviderError> {
        let attempted = go_scope(pin.map(|pin| pin.credential()), SEND_HEADERS.scope(headers, engine.attempt(request))).await;
        if inclusive { crate::registry::inclusive::inclusive_attempt(attempted) } else { attempted }
    }
}

/// Either gateway can replace a failed stream once, but never after any output or tool event escaped it.
struct BeforeOutput {
    inner: Option<Box<dyn ModelStream>>,
    replay: Option<GatewayReplay>,
    request: Arc<ModelRequest>,
    opencode: bool,
    retried: bool,
    exposed: bool,
    pin: Option<Arc<GoPin>>,
    headers: Vec<(String, String)>,
    pending_usage: Option<mixdog_core_api::domain::provider::Usage>,
    pending_model: Option<String>,
    pending: VecDeque<Result<StreamEvent, ProviderError>>,
    left: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl BeforeOutput {
    async fn open(first: Result<Box<dyn ModelStream>, ProviderError>, request: Arc<ModelRequest>, replay: GatewayReplay) -> Result<Box<dyn ModelStream>, ProviderError> {
        let opencode = replay.is_opencode();
        let (pin, headers) = match &replay {
            GatewayReplay::OpenCode { pin, headers, .. } => (pin.clone(), headers.clone()),
            GatewayReplay::XaiHttp { .. } => (None, Vec::new()),
        };
        let (inner, replay, retried) = match first {
            Ok(stream) => (stream, Some(replay), false),
            Err(mut error) => {
                if !replay.permits(&mut error, &request) {
                    return Err(Self::surface(opencode, error));
                }
                (replay.resend(request.clone()).await?, None, true)
            }
        };
        Ok(Box::new(Self { inner: Some(inner), replay, request, opencode, retried, exposed: false, pin, headers, pending_usage: None, pending_model: None, pending: VecDeque::new(), left: None }))
    }

    fn surface(opencode: bool, error: ProviderError) -> ProviderError {
        if opencode { opencode_inference_reauth(error) } else { error }
    }

    fn publish_usage(&mut self) {
        if let Some(model) = self.pending_model.take() {
            self.pending.push_back(Ok(StreamEvent::ServedModel(model)));
        }
        if let Some(usage) = self.pending_usage.take() {
            self.pending.push_back(Ok(StreamEvent::Usage(usage)));
        }
    }
}

fn exposes_output(event: &StreamEvent) -> bool {
    match event {
        StreamEvent::TextDelta(text) | StreamEvent::ReasoningDelta(text) | StreamEvent::ProgressDelta(text) => !text.is_empty(),
        StreamEvent::ToolCallStart { .. } | StreamEvent::ToolCallArgsDelta { .. } | StreamEvent::ToolCallDone(_) => true,
        StreamEvent::ReturnedCalls(calls) => !calls.is_empty(),
        _ => false,
    }
}

#[async_trait]
impl ModelStream for BeforeOutput {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Some(event);
            }
            let inner = self.inner.as_mut()?;
            let step = if self.opencode {
                go_scope(self.pin.as_ref().map(|pin| pin.credential()), SEND_HEADERS.scope(self.headers.clone(), inner.next())).await
            } else {
                inner.next().await
            };
            match step {
                Some(Ok(event)) => {
                    if self.replay.is_some() {
                        match event {
                            StreamEvent::Usage(usage) => {
                                crate::registry::accounted::observe_attempt_usage(usage.clone(), self.pending_model.clone());
                                self.pending_usage = Some(usage);
                                continue;
                            }
                            StreamEvent::ServedModel(model) => {
                                if let Some(usage) = self.pending_usage.as_ref() {
                                    crate::registry::accounted::observe_attempt_usage(usage.clone(), Some(model.clone()));
                                }
                                self.pending_model = Some(model);
                                continue;
                            }
                            _ => {}
                        }
                    }
                    if exposes_output(&event) {
                        self.exposed = true;
                        self.replay = None;
                    }
                    if self.exposed || matches!(event, StreamEvent::Completed { .. }) {
                        self.publish_usage();
                    }
                    self.pending.push_back(Ok(event));
                }
                Some(Err(mut error)) => {
                    error.unsafe_to_retry |= self.exposed;
                    let replay = self.replay.take();
                    let before_output = replay.is_some();
                    if error.partial_usage.is_none() {
                        error.partial_usage = self.pending_usage.take().map(Box::new);
                    }
                    crate::registry::accounted::attach_observed_usage(&mut error);
                    if error.partial_model.is_none() && error.partial_usage.is_some() {
                        error.partial_model = self.pending_model.take().map(String::into_boxed_str);
                    }
                    if let Some(replay) = replay.filter(|replay| replay.permits(&mut error, &self.request)) {
                        self.pending_usage = None;
                        self.pending_model = None;
                        drop(self.inner.take());
                        self.retried = true;
                        match replay.resend(self.request.clone()).await {
                            Ok(mut stream) => {
                                if let Some(left) = self.left.as_ref() {
                                    stream.on_wire_left(left.clone());
                                }
                                self.inner = Some(stream);
                                continue;
                            }
                            Err(error) => return Some(Err(error)),
                        }
                    }
                    return Some(Err(Self::surface(self.opencode && (self.retried || before_output), error)));
                }
                None if self.pending_usage.is_some() => {
                    let mut error = ProviderError::transport(TransportFault::TruncatedStream, inner.delivery());
                    error.partial_usage = self.pending_usage.take().map(Box::new);
                    error.partial_model = self.pending_model.take().map(String::into_boxed_str);
                    return Some(Err(error));
                }
                None => return None,
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.as_ref().map_or(DeliveryState::Accepted, |inner| inner.delivery())
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        if let Some(inner) = self.inner.as_mut() {
            inner.on_wire_left(left.clone());
        }
        self.left = Some(left);
    }
}

/// How a gateway picks the wire of a send.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WirePick {
    /// One wire for every model (xAI by its API mode, Muse Code's Responses).
    Fixed(Wire),
    /// The routing table of the Chat engine's profile (`resolveWireRoute`), the session's pin first.
    Routed,
}

pub struct GatewayAdapter {
    account: Arc<CompatAdapter>,
    engines: Vec<(Wire, Arc<dyn ProviderAdapter>)>,
    pick: WirePick,
    /// OpenCode Go names the conversation on every request (`x-opencode-session`).
    session_header: bool,
    /// The Messages wire's output ceiling for a model (`config.modelMaxOutputTokens(model)`), handed to the Anthropic
    /// request builder when the caller named none (`gatewayMessagesOpts`).
    messages_ceiling: Option<Arc<MessagesCeilingLookup>>,
}

#[async_trait]
impl ProviderAdapter for GatewayAdapter {
    fn release_send(&self, group: &str) {
        for (_, engine) in &self.engines {
            engine.release_send(group);
        }
    }
    fn id(&self) -> &ProviderId {
        self.account.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.account.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        // The Chat engine's retry profile stays the account's loop policy (`wire-gateway.mjs`).
        self.account.retry_policy()
    }
    /// Each wire's engine runs its own ladder (the Messages wire the Anthropic one, anthropic-api-transport.mjs:197; the
    /// Gemini wire `runGeminiStreamAttempts`, opencode-go-gemini.mjs:137, whose attempts are counted by the connection);
    /// the wire is known once an attempt went out on it, so the first failure of a send reads it.
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        match self.wire_of(request).and_then(|wire| self.engines.iter().find(|(w, _)| *w == wire)) {
            Some((_, engine)) => engine.retry_policy_of(request),
            None => self.account.retry_policy(),
        }
    }
    fn send_stages_of(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::SendStages {
        if self.wire_of(request) == Some(Wire::Gemini) {
            // The Gemini engine is `GeminiProvider`'s send (`OpenCodeGoGeminiEngine`): its stages are the direct route's.
            return mixdog_core_api::domain::provider::SendStages {
                preparing: 2,
                each_attempt: true,
                before_recovery: true,
                reconnecting: true,
                ladder_by_connection: true,
                model_thinking: false,
            };
        }
        Default::default()
    }
    /// The send's wire, resolved before its first attempt so the stages it raises ahead of that attempt are its wire's.
    async fn prepare_send(&self, request: &ModelRequest) {
        if let Ok((wire, ..)) = self.route_of(request).await {
            request.options.send_identity.set_wire(wire.as_str());
        }
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.account.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.account.models()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.account.wire_routing()
    }
    /// The images of a send take the form of the wire its model is routed on, as that wire's engine declares it.
    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        if let Ok((wire, ..)) = self.route_of(request).await
            && let Some(engine) = self.engine(wire)
        {
            return engine.image_route(request).await;
        }
        mixdog_image_egress::route::RouteFacts::undeclared(self.account.id().as_str(), &request.model)
    }
    /// Every gateway lowers a PDF to text (`WireGatewayProvider.nativePdf`, `OpenCodeGoProvider.nativePdf`).
    fn native_pdf(&self) -> bool {
        false
    }
    /// The engine the model's route sends on declares what it takes: a Messages engine its own flags (OpenRouter takes
    /// a PDF there, DeepSeek no document at all), the Gemini engine a PDF, the Chat and Responses wires the provider's
    /// own `nativePdf = false`.
    async fn media_support(&self, request: &ModelRequest) -> MediaSupport {
        let text = MediaSupport { native_pdf: false, native_documents: None };
        let Ok((wire, _, _)) = self.route_of(request).await else { return text };
        match wire {
            Wire::Messages | Wire::Gemini => match self.engine(wire) {
                Some(engine) => engine.media_support(request).await,
                None => text,
            },
            _ => text,
        }
    }
    /// The line of the ladder of the wire the send's last attempt went out on; OpenCode Go's Gemini engine writes
    /// `[opencode-go:gemini]` (opencode-go-gemini.mjs:143), with no wait.
    fn retry_line_of(&self, request: &ModelRequest) -> Option<RetryLine> {
        let wire = self.wire_of(request)?;
        match wire {
            Wire::Gemini => Some(RetryLine { tag: "[opencode-go:gemini]".into(), delay: false, style: RetryLineStyle::Attempt }),
            // The Messages engine is an Anthropic provider named for the gateway (`label: this.name`, anthropic.mjs:411).
            Wire::Messages => Some(RetryLine { tag: format!("[{}]", self.account.id()), delay: true, style: RetryLineStyle::Attempt }),
            other => self.engine(other)?.retry_line_of(request),
        }
    }
    /// `canFallbackNonStreaming` of the Chat Completions engine, which every send of this gateway may have gone out on:
    /// the non-streaming re-issue exists on that wire only ([`Self::recover_spent`] refuses any other).
    fn recovers_spent(&self, model: &str, failure: &ProviderError) -> bool {
        // A standalone Chat recovery cannot prove which org the failed Go send used.
        self.account.id().as_str() != "opencode-go-oauth" && self.account.recovers_spent(model, failure)
    }
    /// `recoverCompatNonStreaming` for a send whose last attempt went out on the Chat wire; a send that went out on
    /// another wire ends with its own ladder's failure.
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if self.account.id().as_str() == "opencode-go-oauth" {
            return Err(ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent));
        }
        match self.wire_of(&request) {
            Some(Wire::Chat) => match self.session_headers(&request) {
                Some(headers) => SEND_HEADERS.scope(headers, self.account.recover_spent(request)).await,
                None => self.account.recover_spent(request).await,
            },
            _ => Err(ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent)),
        }
    }
    fn recovery_line(&self, model: &str, failure: &ProviderError) -> Option<String> {
        self.account.recovery_line(model, failure)
    }
    fn begin_loop(&self) {
        self.account.begin_loop();
        for (_, engine) in &self.engines {
            engine.begin_loop();
        }
    }
    fn release_session(&self, session_id: &str) {
        self.account.release_session(session_id);
        for (_, engine) in &self.engines {
            engine.release_session(session_id);
        }
    }
    /// `sendOnRoute`: the send on its route; one clear "unsupported" refusal before any output sends the same request
    /// once more on the next wire the model is served on, with the history written so far lowered.
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let (wire, pinned_reroute, route) = self.route_of(&request).await?;
        let lowered_count = pinned_reroute
            .as_ref()
            .and_then(|r| r.get("loweredAssistantCount"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let go = self.pin_go().await?;
        let Some(routing) = route.as_ref().and(self.account.wire_routing()) else {
            return self.attempt_on(wire, lowered(request, lowered_count), go).await;
        };
        let refusal = Arc::new(Mutex::new(None));
        let first = REFUSAL.scope(refusal.clone(), self.attempt_on(wire, lowered(request.clone(), lowered_count), go.clone())).await;
        let error = match first {
            // A send on a rerouted pin reports that route back, as the refusal's send did.
            Ok(inner) => return Ok(Box::new(Rerouted { route: pinned_reroute, inner })),
            Err(error) => error,
        };
        let refused = refusal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let mut error = self.classify_messages_refusal(wire, error, refused.as_ref());
        if !wire_unsupported(&error, refused.as_ref()) {
            return Err(error);
        }
        let context = WireRouteContext { agent: !request.tools.is_empty(), exclude: vec![wire.as_str().to_owned()], ..WireRouteContext::default() };
        let Some(next) = routing.resolve_wire_route(&request.model, &context).await? else { return Err(error) };
        let Some(next_wire) = Wire::parse(&next.wire).filter(|w| *w != wire) else { return Err(error) };
        if !preserve_bill(&mut error, &request) {
            return Err(error);
        }
        let count = request.messages.iter().filter(|m| m.role == Role::Assistant).count();
        let rerouted = json!({
            "provider": self.account.id().as_str(),
            "model": request.model,
            "wire": next.wire,
            "profileId": next.profile_id,
            "source": "reroute",
            "reroutedFrom": wire.as_str(),
            "reroutedReason": "unsupported",
            "loweredAssistantCount": count,
        });
        let inner = REFUSAL.scope(refusal.clone(), self.attempt_on(next_wire, lowered(request, count), go)).await.map_err(|error| {
            let refused = refusal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
            self.classify_messages_refusal(next_wire, error, refused.as_ref())
        })?;
        Ok(Box::new(Rerouted { route: Some(rerouted), inner }))
    }
}

/// A version-4 UUID (`crypto.randomUUID()`).
fn random_uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The vendor SDK a Node engine sends its model requests through.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sdk {
    /// `openai` 6.49.0 (Chat and Responses).
    OpenAi,
    /// `@anthropic-ai/sdk` 0.137.0 (Messages).
    Anthropic,
}

impl Sdk {
    /// The headers the SDK writes ahead of everything else (`client.buildHeaders`' first source): `accept`, its
    /// `user-agent`, the retry count, the timeout (Anthropic: 600 s), the platform headers of a Node host, and the
    /// Anthropic API version.
    fn base(self) -> Vec<(String, String)> {
        let (agent, package) = match self {
            Self::OpenAi => ("OpenAI/JS 6.49.0", "6.49.0"),
            Self::Anthropic => ("Anthropic/JS 0.137.0", "0.137.0"),
        };
        let mut base = vec![("accept".to_owned(), "application/json".to_owned()), ("user-agent".to_owned(), agent.to_owned())];
        for (name, value) in crate::providers::grok::sdk_headers() {
            match name.as_str() {
                "x-stainless-package-version" => base.push((name, package.to_owned())),
                "x-stainless-lang" if self == Self::Anthropic => {
                    base.push(("x-stainless-timeout".to_owned(), "600".to_owned()));
                    base.push((name, value));
                }
                _ => base.push((name, value)),
            }
        }
        if self == Self::Anthropic {
            // The Anthropic client writes its own headers in the case its `defaultHeaders` spell them
            // (`Accept`, `User-Agent`, `X-Stainless-*`); the OpenAI client's `Headers` lower-cases every name.
            for (name, _) in &mut base {
                *name = anthropic_spelling(name).to_owned();
            }
            base.push(("anthropic-version".to_owned(), "2023-06-01".to_owned()));
        }
        base
    }
}

/// The spelling `@anthropic-ai/sdk` 0.137.0 gives a header of its own.
fn anthropic_spelling(name: &str) -> &str {
    match name {
        "accept" => "Accept",
        "user-agent" => "User-Agent",
        "x-stainless-retry-count" => "X-Stainless-Retry-Count",
        "x-stainless-timeout" => "X-Stainless-Timeout",
        "x-stainless-lang" => "X-Stainless-Lang",
        "x-stainless-package-version" => "X-Stainless-Package-Version",
        "x-stainless-os" => "X-Stainless-OS",
        "x-stainless-arch" => "X-Stainless-Arch",
        "x-stainless-runtime" => "X-Stainless-Runtime",
        "x-stainless-runtime-version" => "X-Stainless-Runtime-Version",
        other => other,
    }
}

/// `buildHeaders` (the SDKs' `internal/headers`): the sources in order, each one replacing a name it sets (in any
/// letter case), which then stands at its place in that source in the spelling that source gave it.
fn build_headers(sources: [Vec<(String, String)>; 5]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for source in sources {
        let mut seen: Vec<String> = Vec::new();
        for (name, value) in source {
            if !seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                out.retain(|(known, _)| !known.eq_ignore_ascii_case(&name));
                seen.push(name.clone());
            }
            out.push((name, value));
        }
    }
    out
}

/// A model request's headers in the order the SDK writes them: its own headers, the auth header, the client's
/// `defaultHeaders` (`defaults`: the gateway's identifying headers and the user's), the body's `content-type`,
/// then the request's own headers.
fn sdk_order(sdk: Sdk, defaults: &[String], headers: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut base = sdk.base();
    let (mut auth, mut client, mut body, mut own) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (spelled, value) in headers {
        let name = spelled.to_ascii_lowercase();
        // A request's own timeout (the non-streaming re-issue's) is the SDK's timeout header, at its place.
        if name == "x-stainless-timeout"
            && let Some(slot) = base.iter_mut().find(|(known, _)| known.eq_ignore_ascii_case(&name))
        {
            slot.1 = value;
            continue;
        }
        // The codec's own `accept` beside the same one among the gateway's headers is one header.
        let same = |(known, held): &(String, String)| known.eq_ignore_ascii_case(&name) && *held == value;
        if client.iter().any(same) || own.iter().any(same) {
            continue;
        }
        match name.as_str() {
            // The auth header keeps the spelling its writer gave it (the SDK's own is lower-case, Vertex AI's is not).
            "authorization" | "x-api-key" => auth.push((spelled, value)),
            "content-type" => body.push((name, value)),
            // A client's `defaultHeaders` keep the spelling the client was given.
            _ if defaults.contains(&name) => client.push((spelled, value)),
            _ if base.iter().any(|(n, v)| n.eq_ignore_ascii_case(&name) && *v == value) => {}
            _ => own.push((name, value)),
        }
    }
    // The client's `defaultHeaders` stand in the order the client was given them, wherever the codec wrote them.
    client.sort_by_key(|(name, _)| defaults.iter().position(|d| d.eq_ignore_ascii_case(name)));
    build_headers([base, auth, client, body, own])
}

/// The transport of a gateway engine: adds the send's own headers ([`SEND_HEADERS`]), copies an `x-api-key` into
/// a bearer `authorization` right after it (Command Code's Messages wire sends the key both ways), moves a path
/// prefix (OpenCode Go serves `generateContent` under `/v1`, the Gemini codec writes `/v1beta`), and writes a model
/// request's headers as the engine's SDK does.
pub struct GatewayHttp {
    inner: Arc<dyn HttpSend>,
    mirror_key_as_bearer: bool,
    path: Option<(&'static str, &'static str)>,
    /// Headers every request of this route carries.
    headers: Vec<(String, String)>,
    /// OpenCode Go's Gemini body (`openCodeGoGeminiBody`): `systemInstruction` is `{ parts }` alone.
    plain_system_instruction: bool,
    /// The SDK the Node engine of this route posts through, with the lower-case names of its client's
    /// `defaultHeaders`.
    sdk: Option<(Sdk, Vec<String>)>,
    /// `originBoundFetch`: a model request never follows a redirect, any 3xx is the send's connection error, so the
    /// gateway's credential can only reach the gateway.
    refuse_redirects: bool,
    /// The engine's own fetch refuses the redirect (no SDK between): the error is the guard's sentence under this
    /// provider label, not a connection error.
    refusal_label: Option<String>,
}

impl GatewayHttp {
    pub fn new(inner: Arc<dyn HttpSend>) -> Self {
        Self { inner, mirror_key_as_bearer: false, path: None, headers: Vec::new(), plain_system_instruction: false, sdk: None, refuse_redirects: false, refusal_label: None }
    }
    pub fn refusing_redirects(mut self) -> Self {
        self.refuse_redirects = true;
        self
    }
    /// `originBoundFetch(origin, fetch, label)` as the engine's own fetch: the guard's error reaches the caller as it is.
    pub fn refusing_redirects_as(mut self, label: &str) -> Self {
        self.refuse_redirects = true;
        self.refusal_label = Some(label.to_owned());
        self
    }
    pub fn through_sdk(mut self, sdk: Sdk, defaults: &[(String, String)]) -> Self {
        self.sdk = Some((sdk, defaults.iter().map(|(name, _)| name.to_ascii_lowercase()).collect()));
        self
    }
    pub fn with_headers(mut self, headers: Vec<(String, String)>) -> Self {
        self.headers = headers;
        self
    }
    pub fn plain_system_instruction(mut self) -> Self {
        self.plain_system_instruction = true;
        self
    }
    pub fn mirroring_key_as_bearer(mut self) -> Self {
        self.mirror_key_as_bearer = true;
        self
    }
    pub fn moving_path(mut self, from: &'static str, to: &'static str) -> Self {
        self.path = Some((from, to));
        self
    }
}

#[async_trait]
impl HttpSend for GatewayHttp {
    async fn send(&self, mut request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        if self.mirror_key_as_bearer
            && let Some(at) = request.headers.iter().position(|(k, _)| k.eq_ignore_ascii_case("x-api-key"))
        {
            let bearer = format!("Bearer {}", request.headers[at].1);
            request.headers.insert(at + 1, ("authorization".into(), bearer));
        }
        if let Some((from, to)) = self.path {
            request.url = request.url.replacen(from, to, 1);
        }
        if self.plain_system_instruction
            && let Ok(mut body) = serde_json::from_slice::<serde_json::Value>(&request.body)
            && let Some(system) = body.get_mut("systemInstruction").and_then(serde_json::Value::as_object_mut)
        {
            system.shift_remove("role");
            request.body = serde_json::to_vec(&body).unwrap_or_default();
        }
        request.headers.extend(self.headers.iter().cloned());
        if let Ok(extra) = SEND_HEADERS.try_with(Clone::clone) {
            request.headers.extend(extra);
        }
        // A listing read is a plain `fetch`; a model request goes through the SDK.
        if let Some((sdk, defaults)) = &self.sdk
            && request.method == "POST"
        {
            request.headers = sdk_order(*sdk, defaults, std::mem::take(&mut request.headers));
        }
        if let Ok(org) = GATEWAY_CREDENTIAL.try_with(|credential| credential.org_id.clone()) {
            let mut org = org.filter(|org| !org.is_empty());
            request.headers.retain_mut(|(name, value)| {
                if !name.eq_ignore_ascii_case("x-org-id") { return true; }
                if let Some(pinned) = org.take() { *value = pinned; true } else { false }
            });
            if let Some(org) = org { request.headers.push(("x-org-id".to_owned(), org)); }
        }
        let guarded = self.refuse_redirects && request.method == "POST";
        let exchange = if guarded { Exchange { redirect: crate::transport::Redirect::Manual, ..exchange } } else { exchange };
        let host = request.url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or_default().to_owned();
        let mut response = self.inner.send(request, exchange).await?;
        if guarded && (300..400).contains(&response.status) {
            if let Some(label) = &self.refusal_label {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.message = format!("[{label}] refusing to follow a redirect from {host}");
                return Err(error);
            }
            // The SDK reports the refused hop as a connection error caused by the guard.
            let mut error = ProviderError::transport(TransportFault::Io { os_code: None }, DeliveryState::Ambiguous);
            error.message = "Connection error.".into();
            return Err(error);
        }
        let Ok(slot) = REFUSAL.try_with(Clone::clone) else { return Ok(response) };
        if response.is_success() {
            return Ok(response);
        }
        // The engine reads the refusal as it arrived; its status and body are kept for the routing decision.
        let mut parts = VecDeque::new();
        let mut bytes = Vec::new();
        while let Some(part) = response.body.next().await {
            if let Ok(chunk) = &part {
                bytes.extend_from_slice(chunk);
            }
            parts.push_back(part);
        }
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Refusal { status: response.status, headers: response.headers.clone(), body });
        response.body = Box::new(Replayed(parts));
        Ok(response)
    }
}

#[cfg(test)]
mod rules_tests;

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use super::*;

    type Left = Arc<dyn Fn() + Send + Sync>;

    /// Keeps the callback it is handed.
    struct Keeps(Arc<Mutex<Option<Left>>>);

    #[async_trait]
    impl ModelStream for Keeps {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            None
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, left: Left) {
            *self.0.lock().unwrap() = Some(left);
        }
    }

    struct Nothing;

    #[async_trait]
    impl HttpSend for Nothing {
        async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            unreachable!("no request goes out")
        }
    }

    struct Key;

    #[async_trait]
    impl crate::providers::key_source::ApiKeySource for Key {
        async fn key(&self) -> Result<String, ProviderError> {
            Ok("fixture-key".into())
        }
        async fn reload(&self) -> Result<String, ProviderError> {
            self.key().await
        }
    }

    fn engine(profile: crate::providers::compat::profile::CompatProfile) -> Arc<CompatAdapter> {
        let codec = crate::providers::compat::chat::CompatChatCodec::new(profile, crate::providers::compat::chat::CompatConfig::default());
        Arc::new(CompatAdapter::new(codec, Arc::new(Nothing), Some(Arc::new(Key))))
    }

    #[test]
    fn xai_configured_effort_is_identical_on_http_and_the_socket() {
        use crate::providers::compat::{CompatChatCodec, CompatConfig, CompatProfile};
        use mixdog_core_api::domain::keepalive::TransportKind;

        let profile = CompatProfile::xai();
        let config = CompatConfig::for_profile(&profile);
        let chat = CompatChatCodec::new(profile.clone(), config.clone());
        let account = CompatAdapter::new(chat, Arc::new(Nothing), None).with_configured_effort(Some("high".into()));
        let http = CompatResponsesCodec::new(profile, config, TransportKind::Http1);
        let socket = http.xai_websocket();
        for (requested, expected) in [(None, "high"), (Some("low"), "low")] {
            let request = account.with_default_effort(Arc::new(ModelRequest {
                model: "grok-4.5".into(), messages: Vec::new(), tools: Vec::new(),
                options: mixdog_core_api::domain::provider::RequestOptions { effort: requested.map(str::to_owned), ..Default::default() },
            }));
            for codec in [&http, &socket] {
                let body: Value = serde_json::from_slice(&codec.encode(&request).unwrap().body).unwrap();
                assert_eq!(body["reasoning"]["effort"], expected);
            }
        }
    }

    #[test]
    fn xai_only_replays_an_unaccounted_pre_output_failure_if_it_was_not_billed() {
        use crate::providers::compat::{CompatConfig, CompatProfile};
        use mixdog_core_api::domain::keepalive::TransportKind;
        use mixdog_core_api::domain::provider::{Usage, UsdTicks};

        let profile = CompatProfile::xai();
        let codec = CompatResponsesCodec::new(profile.clone(), CompatConfig::for_profile(&profile), TransportKind::Http1);
        let replay = GatewayReplay::XaiHttp { account: engine(profile), codec: Arc::new(codec), enabled: true };
        let request = ModelRequest { model: "grok-4.5".into(), messages: Vec::new(), tools: Vec::new(), options: Default::default() };
        let mut failure = ProviderError::transport(TransportFault::Reset, DeliveryState::Accepted);
        assert!(replay.permits(&mut failure, &request));
        failure.partial_usage = Some(Box::new(Usage { cost: Some(UsdTicks(100)), ..Default::default() }));
        assert!(!replay.permits(&mut failure, &request));
        assert_eq!(failure.partial_usage.as_ref().unwrap().cost, Some(UsdTicks(100)));
    }

    #[tokio::test]
    async fn opencode_reissues_each_wire_once_even_when_refresh_returns_the_same_key() {
        use crate::providers::compat::{CompatChatCodec, CompatConfig, CompatProfile};
        use crate::providers::key_source::ApiKeySource;
        use std::sync::atomic::AtomicUsize;

        struct Refusing { requests: AtomicUsize, reloads: AtomicUsize, auth: OpenCodeGoAuth }
        #[async_trait]
        impl HttpSend for Refusing {
            async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
                self.requests.fetch_add(1, Ordering::SeqCst);
                Ok(HttpResponse { status: 401, headers: Vec::new(), body: Box::new(Replayed(VecDeque::new())) })
            }
        }
        #[async_trait]
        impl ApiKeySource for Refusing {
            async fn key(&self) -> Result<String, ProviderError> {
                Ok(GATEWAY_CREDENTIAL.with(|credential| credential.access_token.clone()))
            }
            async fn reload(&self) -> Result<String, ProviderError> {
                self.reloads.fetch_add(1, Ordering::SeqCst);
                self.key().await
            }
            fn opencode_auth(&self) -> Option<&OpenCodeGoAuth> { Some(&self.auth) }
        }

        for wire in [Wire::Chat, Wire::Responses, Wire::Messages, Wire::Gemini] {
            let dir = tempfile::tempdir().unwrap();
            let lanes = mixdog_rt::testing::tokens();
            let file = crate::oauth::CredentialFile::new(dir.path().join("go.json"), crate::oauth::CredentialIo { read: lanes.interactive_io, write: lanes.durability_io });
            file.save(&json!({"access_token":"fixture", "refresh_token":"fixture-refresh", "org_id":"fixture-org"})).await.unwrap();
            let refresh = crate::oauth::http::testing::Scripted::new(&[(200, r#"{"access_token":"fixture", "refresh_token":"updated"}"#)]);
            let auth = OpenCodeGoAuth::new(refresh.clone(), Arc::new(crate::oauth::pace::FakePace::default()), file);
            let boundary = Arc::new(Refusing { requests: AtomicUsize::new(0), reloads: AtomicUsize::new(0), auth });
            let codec = CompatChatCodec::new(CompatProfile::opencode_go(), CompatConfig::default());
            let account = Arc::new(CompatAdapter::new(codec, boundary.clone(), Some(boundary.clone())));
            let gateway = GatewayAdapter::new(account.clone(), vec![(wire, account)], WirePick::Fixed(wire)).with_session_header();
            let request = Arc::new(ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: Default::default() });
            let error = gateway.attempt(request).await.err().expect("second refusal");
            assert_eq!(error.code.as_deref(), Some("invalid_grant"), "{wire:?}");
            assert!(error.reauth_required, "{wire:?}");
            assert_eq!(boundary.requests.load(Ordering::SeqCst), 2, "{wire:?}");
            assert_eq!(boundary.reloads.load(Ordering::SeqCst), 0, "{wire:?}");
            assert_eq!(refresh.seen.lock().unwrap().len(), 1, "{wire:?}");
        }
    }

    #[tokio::test]
    async fn open_code_auth_refusal_does_not_reissue_after_a_tool_is_emitted() {
        use crate::providers::compat::CompatProfile;
        struct ToolThen401(VecDeque<Result<StreamEvent, ProviderError>>);
        #[async_trait]
        impl ModelStream for ToolThen401 {
            async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> { self.0.pop_front() }
            fn delivery(&self) -> DeliveryState { DeliveryState::Accepted }
            fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
        }
        let mut unauthorized = ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted);
        unauthorized.status = Some(401);
        let inner = Box::new(ToolThen401(VecDeque::from([
            Ok(StreamEvent::ToolCallDone(mixdog_core_api::domain::provider::ToolCall {
                id: "once".into(), name: "record".into(), arguments: json!({}), native_type: None,
            })),
            Err(unauthorized),
        ])));
        let account = engine(CompatProfile::opencode_go());
        let dir = tempfile::tempdir().unwrap();
        let lanes = mixdog_rt::testing::tokens();
        let file = crate::oauth::CredentialFile::new(dir.path().join("go.json"), crate::oauth::CredentialIo { read: lanes.interactive_io, write: lanes.durability_io });
        let credentials = serde_json::from_value(json!({"access_token":"fixture", "refresh_token":"fixture-refresh", "org_id":"fixture-org"})).unwrap();
        let pin = Arc::new(GoPin {
            auth: OpenCodeGoAuth::new(Arc::new(Nothing), Arc::new(crate::oauth::pace::FakePace::default()), file),
            credentials: Mutex::new(Arc::new(credentials)),
        });
        let request = Arc::new(ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: Default::default() });
        let mut stream = BeforeOutput::open(Ok(inner), request, GatewayReplay::OpenCode { pin: Some(pin), engine: account, headers: Vec::new(), inclusive: false }).await.unwrap();
        assert!(matches!(stream.next().await, Some(Ok(StreamEvent::ToolCallDone(_)))));
        let error = stream.next().await.unwrap().unwrap_err();
        assert_eq!(error.status, Some(401));
        assert!(!error.reauth_required);
    }

    /// Two sends of one model, one on the Messages wire and one on the Gemini wire, each keep their own ladder, stages
    /// and retry line whichever attempt went out last: the wire is the send's, not the model's.
    #[tokio::test]
    async fn concurrent_sends_of_one_model_keep_their_own_wire() {
        use crate::providers::compat::profile::CompatProfile;
        let messages = engine(CompatProfile::deepseek());
        let gemini = engine(CompatProfile::xai());
        let gateway = GatewayAdapter::new(
            engine(CompatProfile::opencode_go()),
            vec![(Wire::Messages, messages.clone() as Arc<dyn ProviderAdapter>), (Wire::Gemini, gemini.clone() as Arc<dyn ProviderAdapter>)],
            WirePick::Routed,
        );
        let request = |wire: Wire| {
            let request = ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: Default::default() };
            request.options.send_identity.set_wire(wire.as_str());
            request
        };
        let (on_messages, on_gemini) = (request(Wire::Messages), request(Wire::Gemini));
        // The Gemini send's attempt went out last; the Messages send reads its own wire all the same.
        assert!(std::ptr::eq(gateway.retry_policy_of(&on_messages), messages.retry_policy()));
        assert!(std::ptr::eq(gateway.retry_policy_of(&on_gemini), gemini.retry_policy()));
        assert!(!gateway.send_stages_of(&on_messages).ladder_by_connection);
        assert!(gateway.send_stages_of(&on_gemini).ladder_by_connection);
        assert_eq!(gateway.retry_line_of(&on_messages).map(|line| line.tag), Some(format!("[{}]", gateway.id())));
        assert_eq!(gateway.retry_line_of(&on_gemini).map(|line| line.tag), Some("[opencode-go:gemini]".to_owned()));
    }

    /// A spent Chat ladder is re-issued without streaming (`recoverCompatNonStreaming`); a send that went out on
    /// another wire ends with its own ladder's failure, and a failure that showed output is never re-issued.
    #[tokio::test]
    async fn a_spent_chat_ladder_is_recovered_on_the_chat_wire_only() {
        use crate::providers::compat::profile::CompatProfile;
        let gateway = GatewayAdapter::new(
            engine(CompatProfile::openrouter()),
            vec![(Wire::Messages, engine(CompatProfile::deepseek()) as Arc<dyn ProviderAdapter>)],
            WirePick::Routed,
        );
        let transient = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        assert!(gateway.recovers_spent("m", &transient));
        let mut shown = transient.clone();
        shown.exposure.text_emitted = true;
        assert!(!gateway.recovers_spent("m", &shown));
        assert!(!gateway.recovers_spent("m", &ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted)));

        let request = ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: Default::default() };
        request.options.send_identity.set_wire(Wire::Messages.as_str());
        let refused = gateway.recover_spent(Arc::new(request)).await.err().expect("another wire has no re-issue");
        assert_eq!(refused.kind, ErrorKind::Unknown);
        assert_eq!(refused.delivery, DeliveryState::NotSent);
    }

    /// No stream the registry puts under a reroute awaits after the wire today, so the production stacks cannot show
    /// this hand-over; the wrapper is held to it directly.
    #[test]
    fn a_rerouted_stream_hands_the_consumers_callback_to_the_stream_it_wraps() {
        let handed = Arc::new(Mutex::new(None));
        let mut stream = Rerouted { route: None, inner: Box::new(Keeps(Arc::clone(&handed))) };
        let called = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&called);
        stream.on_wire_left(Arc::new(move || flag.store(true, Ordering::SeqCst)));
        let left = handed.lock().unwrap().take().expect("the wrapped stream was handed the callback");
        left();
        assert!(called.load(Ordering::SeqCst), "the callback handed on is the consumer's");
    }
}


impl GatewayAdapter {
    /// `engines` serve the wires other than Chat, which is `account` itself.
    pub fn new(account: Arc<CompatAdapter>, engines: Vec<(Wire, Arc<dyn ProviderAdapter>)>, pick: WirePick) -> Self {
        Self { account, engines, pick, session_header: false, messages_ceiling: None }
    }

    /// The wire the send's last attempt went out on: carried by the send's own identity, never shared between sends.
    fn wire_of(&self, request: &ModelRequest) -> Option<Wire> {
        request.options.send_identity.wire().and_then(Wire::parse)
    }

    pub fn with_messages_ceiling(mut self, ceiling: Arc<MessagesCeilingLookup>) -> Self {
        self.messages_ceiling = Some(ceiling);
        self
    }

    pub fn with_session_header(mut self) -> Self {
        self.session_header = true;
        self
    }

    fn not_routable(&self, model: &str) -> ProviderError {
        let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        err.code = Some("MODEL_NOT_ROUTABLE".into());
        err.message = format!("[{}] model {model} is not routable: no wire it is served on is offered", self.account.id());
        err
    }

    fn classify_messages_refusal(&self, wire: Wire, mut error: ProviderError, refusal: Option<&Refusal>) -> ProviderError {
        if self.account.id().as_str() == "openrouter" && wire == Wire::Messages
            && let Some(refusal) = refusal.filter(|refusal| refusal.status == 402)
        {
            // The gateway's 402 envelope still applies when the model speaks Anthropic Messages.
            let classified = crate::providers::compat::error::classify_parts(self.account.profile(), Some(402), &refusal.headers, &refusal.body, std::time::SystemTime::now());
            error.kind = classified.kind;
            error.retry_after = classified.retry_after;
        }
        error
    }

    /// `sendWireRoute`: the session's pin when it names this provider and model and the model is still offered on
    /// it, else a fresh resolution (a send carrying tools counts as an agent/tool request). With the route, the
    /// rerouted pin it stands on, if any; `None` for a fixed wire.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn route_of(&self, request: &ModelRequest) -> Result<(Wire, Option<Value>, Option<WireRoute>), ProviderError> {
        let routing = match self.pick {
            WirePick::Fixed(wire) => {
                let wire = if self.account.id().as_str() == "xai" {
                    xai_transport::request_wire(request.options.xai_api_mode.as_deref(), wire)
                } else {
                    wire
                };
                return Ok((wire, None, None));
            }
            WirePick::Routed => self.account.wire_routing(),
        };
        let Some(routing) = routing else { return Ok((self.account.profile().default_wire, None, None)) };
        let id = self.account.id().to_string();
        let pin = request.options.wire_pin.as_ref().filter(|pin| pin.provider == id && pin.model == request.model);
        let context = WireRouteContext { agent: !request.tools.is_empty(), keep: pin.map(|p| p.wire.clone()), ..WireRouteContext::default() };
        let route = routing.resolve_wire_route(&request.model, &context).await?;
        let wire = route.as_ref().and_then(|r| Wire::parse(&r.wire)).ok_or_else(|| self.not_routable(&request.model))?;
        let rerouted = match (pin, &route) {
            (Some(pin), Some(route)) if route.source == "pinned" => pin.reroute.clone(),
            _ => None,
        };
        Ok((wire, rerouted, route))
    }

    /// `config.modelMaxOutputTokens(model)` on the Messages wire when the caller named no ceiling.
    fn with_ceiling(&self, wire: Wire, request: Arc<ModelRequest>) -> Arc<ModelRequest> {
        match (&self.messages_ceiling, wire) {
            (Some(ceiling), Wire::Messages) if request.options.model_max_output_tokens.is_none() => match ceiling(&request.model) {
                Some(limit) => {
                    let mut owned = (*request).clone();
                    owned.options.model_max_output_tokens = Some(limit);
                    Arc::new(owned)
                }
                None => request,
            },
            _ => request,
        }
    }

    /// One attempt on `wire`, with the send's own headers.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn attempt_on(&self, wire: Wire, request: Arc<ModelRequest>, go: Option<Arc<GoPin>>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let engine = self.engine(wire).ok_or_else(|| self.not_routable(&request.model))?;
        request.options.send_identity.set_wire(wire.as_str());
        // A reroute is a new route: the images are prepared again for the wire this attempt actually takes.
        let request = crate::registry::egress::prepare(engine.as_ref(), request).await?;
        let request = self.with_ceiling(wire, request);
        let inclusive = wire == Wire::Messages && !crate::registry::accounted::adapter_input_excludes_cache(self);
        if self.account.id().as_str() == "opencode-go-oauth" {
            let headers = self.session_headers(&request).unwrap_or_default();
            let first = GatewayReplay::open_opencode(engine.as_ref(), headers.clone(), request.clone(), go.as_ref(), inclusive).await;
            let replay = GatewayReplay::OpenCode { pin: go, engine, headers, inclusive };
            return BeforeOutput::open(first, request, replay).await;
        }
        let result = match self.session_headers(&request) {
            Some(headers) => SEND_HEADERS.scope(headers, engine.attempt(request)).await,
            None => engine.attempt(request).await,
        };
        // The Messages wire reports input without its cache; this provider's own convention is the declared one.
        if inclusive {
            return crate::registry::inclusive::inclusive_attempt(result);
        }
        result
    }

    async fn pin_go(&self) -> Result<Option<Arc<GoPin>>, ProviderError> {
        let Some(auth) = self.account.opencode_auth() else { return Ok(None) };
        let (auth, credential) = auth.pin().await.map_err(go_auth_error)?;
        Ok(Some(Arc::new(GoPin { auth, credentials: Mutex::new(Arc::new(credential)) })))
    }

    /// OpenCode Go names the conversation on every request: its id, else one id for this send (`opencode-go.mjs`
    /// `send`).
    fn session_headers(&self, request: &ModelRequest) -> Option<Vec<(String, String)>> {
        if !self.session_header {
            return None;
        }
        let session = request
            .options
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(|| request.options.send_identity.get_or_mint(random_uuid), str::to_owned);
        Some(vec![("x-opencode-session".into(), session)])
    }

    fn engine(&self, wire: Wire) -> Option<Arc<dyn ProviderAdapter>> {
        if wire == Wire::Chat {
            return Some(self.account.clone());
        }
        self.engines.iter().find(|(w, _)| *w == wire).map(|(_, e)| e.clone())
    }
}
