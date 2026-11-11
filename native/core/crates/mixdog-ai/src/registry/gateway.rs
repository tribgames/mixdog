//! A first-party gateway that serves one account on several wires (Node `WireGatewayProvider`, `OpenCodeGoProvider`,
//! `CommandCodeOAuthProvider`, and the xAI / Muse Code engines of `OpenAICompatProvider`): the Chat engine owns the
//! account, the listing and the routing table; every send goes out on the wire its route names, through that
//! wire's engine (`sendOnRoute`, `wire-route.mjs`).
//!
//! A routed gateway answers one clear "this model is not served on this wire" refusal, before any output, by
//! sending the same request once more on the next wire the model is served on (`sendOnRoute`), and reports the
//! session's new route ([`StreamEvent::WireRerouted`]).

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
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
use crate::providers::compat::profile::Wire;
use crate::providers::compat::responses::CompatResponsesCodec;
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
    codec: CompatResponsesCodec,
}

impl ResponsesEngine {
    pub fn new(account: Arc<CompatAdapter>, codec: CompatResponsesCodec) -> Self {
        Self { account, codec }
    }
}

#[async_trait]
impl ProviderAdapter for ResponsesEngine {
    fn id(&self) -> &ProviderId {
        self.account.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.account.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.account.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.account.attempt_with(&self.codec, request).await
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
    messages_ceiling: Option<Arc<dyn Fn(&str) -> Option<u32> + Send + Sync>>,
}

impl GatewayAdapter {
    /// `engines` serve the wires other than Chat, which is `account` itself.
    pub fn new(account: Arc<CompatAdapter>, engines: Vec<(Wire, Arc<dyn ProviderAdapter>)>, pick: WirePick) -> Self {
        Self { account, engines, pick, session_header: false, messages_ceiling: None }
    }

    pub fn with_messages_ceiling(mut self, ceiling: Arc<dyn Fn(&str) -> Option<u32> + Send + Sync>) -> Self {
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

    /// `sendWireRoute`: the session's pin when it names this provider and model and the model is still offered on
    /// it, else a fresh resolution (a send carrying tools counts as an agent/tool request). With the route, the
    /// rerouted pin it stands on, if any; `None` for a fixed wire.
    async fn route_of(&self, request: &ModelRequest) -> Result<(Wire, Option<Value>, Option<WireRoute>), ProviderError> {
        let routing = match self.pick {
            WirePick::Fixed(wire) => return Ok((wire, None, None)),
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
    async fn attempt_on(&self, wire: Wire, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let engine = self.engine(wire).ok_or_else(|| self.not_routable(&request.model))?;
        let request = self.with_ceiling(wire, request);
        if !self.session_header {
            return engine.attempt(request).await;
        }
        // The conversation's id, else one id for this send (`opencode-go.mjs` `send`).
        let session = request
            .options
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(random_uuid, str::to_owned);
        SEND_HEADERS.scope(vec![("x-opencode-session".into(), session)], engine.attempt(request)).await
    }

    fn engine(&self, wire: Wire) -> Option<Arc<dyn ProviderAdapter>> {
        if wire == Wire::Chat {
            return Some(self.account.clone());
        }
        self.engines.iter().find(|(w, _)| *w == wire).map(|(_, e)| e.clone())
    }
}

#[async_trait]
impl ProviderAdapter for GatewayAdapter {
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
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.account.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.account.models()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.account.wire_routing()
    }
    /// Every gateway lowers a PDF to text (`WireGatewayProvider.nativePdf`, `OpenCodeGoProvider.nativePdf`).
    fn native_pdf(&self) -> bool {
        false
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
        let Some(routing) = route.as_ref().and(self.account.wire_routing()) else {
            return self.attempt_on(wire, lowered(request, lowered_count)).await;
        };
        let refusal = Arc::new(Mutex::new(None));
        let first = REFUSAL.scope(refusal.clone(), self.attempt_on(wire, lowered(request.clone(), lowered_count))).await;
        let error = match first {
            // A send on a rerouted pin reports that route back, as the refusal's send did.
            Ok(inner) => return Ok(Box::new(Rerouted { route: pinned_reroute, inner })),
            Err(error) => error,
        };
        let refused = refusal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if !wire_unsupported(&error, refused.as_ref()) {
            return Err(error);
        }
        let context = WireRouteContext { agent: !request.tools.is_empty(), exclude: vec![wire.as_str().to_owned()], ..WireRouteContext::default() };
        let Some(next) = routing.resolve_wire_route(&request.model, &context).await? else { return Err(error) };
        let Some(next_wire) = Wire::parse(&next.wire).filter(|w| *w != wire) else { return Err(error) };
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
        let inner = self.attempt_on(next_wire, lowered(request, count)).await?;
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
    let base = sdk.base();
    let (mut auth, mut client, mut body, mut own) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        // The codec's own `accept` beside the same one among the gateway's headers is one header.
        if client.contains(&(name.clone(), value.clone())) || own.contains(&(name.clone(), value.clone())) {
            continue;
        }
        match name.as_str() {
            "authorization" | "x-api-key" => auth.push((name, value)),
            "content-type" => body.push((name, value)),
            _ if defaults.contains(&name) => client.push((name, value)),
            _ if base.iter().any(|(n, v)| n.eq_ignore_ascii_case(&name) && *v == value) => {}
            _ => own.push((name, value)),
        }
    }
    // The client's `defaultHeaders` stand in the order the client was given them, wherever the codec wrote them.
    client.sort_by_key(|(name, _)| defaults.iter().position(|d| d == name));
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
}

impl GatewayHttp {
    pub fn new(inner: Arc<dyn HttpSend>) -> Self {
        Self { inner, mirror_key_as_bearer: false, path: None, headers: Vec::new(), plain_system_instruction: false, sdk: None }
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
        let mut response = self.inner.send(request, exchange).await?;
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
        *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Refusal { status: response.status, body });
        response.body = Box::new(Replayed(parts));
        Ok(response)
    }
}

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
