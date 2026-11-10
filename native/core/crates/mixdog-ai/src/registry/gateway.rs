//! A first-party gateway that serves one account on several wires (Node `WireGatewayProvider`, `OpenCodeGoProvider`,
//! `CommandCodeOAuthProvider`, and the xAI / Muse Code engines of `OpenAICompatProvider`): the Chat engine owns the
//! account, the listing and the routing table; every send goes out on the wire its route names, through that
//! wire's engine (`sendOnRoute`, `wire-route.mjs`).
//!
//! A refusal on the routed wire is the provider's error: as for a custom provider's wires (decisions.md, "Removed
//! (text-matching retry)"), the send is never moved to another wire on the wording of a refusal.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::provider::WireRouteContext;
use mixdog_core_api::domain::provider::WireRouting;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

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
    /// it, else a fresh resolution (a send carrying tools counts as an agent/tool request).
    async fn wire_of(&self, request: &ModelRequest) -> Result<Wire, ProviderError> {
        let routing = match self.pick {
            WirePick::Fixed(wire) => return Ok(wire),
            WirePick::Routed => self.account.wire_routing(),
        };
        let Some(routing) = routing else { return Ok(self.account.profile().default_wire) };
        let id = self.account.id().to_string();
        let keep = request
            .options
            .wire_pin
            .as_ref()
            .filter(|pin| pin.provider == id && pin.model == request.model)
            .map(|pin| pin.wire.clone());
        let context = WireRouteContext { agent: !request.tools.is_empty(), keep, ..WireRouteContext::default() };
        let route = routing.resolve_wire_route(&request.model, &context).await?;
        route.and_then(|r| Wire::parse(&r.wire)).ok_or_else(|| self.not_routable(&request.model))
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
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let wire = self.wire_of(&request).await?;
        let engine = self.engine(wire).ok_or_else(|| self.not_routable(&request.model))?;
        let request = match (&self.messages_ceiling, wire) {
            (Some(ceiling), Wire::Messages) if request.options.model_max_output_tokens.is_none() => match ceiling(&request.model) {
                Some(limit) => {
                    let mut owned = (*request).clone();
                    owned.options.model_max_output_tokens = Some(limit);
                    Arc::new(owned)
                }
                None => request,
            },
            _ => request,
        };
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
}

/// A version-4 UUID (`crypto.randomUUID()`).
fn random_uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The transport of a gateway engine: adds the send's own headers ([`SEND_HEADERS`]), copies an `x-api-key` into
/// a bearer `authorization` right after it (Command Code's Messages wire sends the key both ways), and moves a
/// path prefix (OpenCode Go serves `generateContent` under `/v1`, the Gemini codec writes `/v1beta`).
pub struct GatewayHttp {
    inner: Arc<dyn HttpSend>,
    mirror_key_as_bearer: bool,
    path: Option<(&'static str, &'static str)>,
    /// Headers every request of this route carries.
    headers: Vec<(String, String)>,
    /// OpenCode Go's Gemini body (`openCodeGoGeminiBody`): `systemInstruction` is `{ parts }` alone.
    plain_system_instruction: bool,
}

impl GatewayHttp {
    pub fn new(inner: Arc<dyn HttpSend>) -> Self {
        Self { inner, mirror_key_as_bearer: false, path: None, headers: Vec::new(), plain_system_instruction: false }
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
        self.inner.send(request, exchange).await
    }
}
