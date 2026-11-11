//! The [`WireCodec`] of the Google family: pure translation between a
//! [`ModelRequest`] and the three Gemini-shaped endpoints. Credentials are
//! the adapter's; the codec writes none.

use std::sync::Arc;
use std::time::SystemTime;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use mixdog_core_api::domain::provider::GeminiCacheState;

use super::cache::policy::cached_body;
use crate::providers::leak::request_tool_names;
use super::decode::DecodeDialect;
use super::decode::GeminiDecoder;
use super::decode::UsageStyle;
use super::error::ErrorDialect;
use super::error::vertex_model_access;
use super::error::classify;
use super::request::Dialect;
use super::request::build_request;
use super::request::invalid;
use super::claude;
use super::maas;
use super::maas::VertexModel;
use crate::providers::anthropic::CapsLookup;
use crate::providers::leak::ToolNames;
use crate::providers::leak::body_tool_names;
use super::maas::vertex_model;
use super::serving::Route;
use super::serving::Tier;
use super::serving::VertexAccount;
use super::serving::VertexPlace;
use super::serving::Wire;
use super::traits::ModelTraits;

pub const GEMINI_ORIGIN: &str = "https://generativelanguage.googleapis.com";
pub const ANTIGRAVITY_ORIGIN: &str = "https://daily-cloudcode-pa.googleapis.com";

/// Where requests go. Vertex AI and Antigravity are bound to the account and
/// project they were created for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Gemini {
        origin: String,
    },
    /// The account and the location rules; each request's base (a project
    /// and location base, or the express-mode base) is chosen from them.
    Vertex {
        place: VertexPlace,
    },
    Antigravity {
        origin: String,
        project: String,
        client_version: crate::client_versions::Live,
    },
}

pub struct GoogleCodec {
    target: Target,
    traits: Arc<dyn ModelTraits>,
    provider: ProviderId,
    /// The Anthropic catalog's model capabilities, for Claude on Vertex AI ([`Self::with_claude_caps`]).
    claude_caps: CapsLookup,
}

/// `encodeURIComponent` with `@` kept: a version suffix (`claude-…@default`)
/// is a literal `@` in the path.
fn path_segment(id: &str) -> String {
    let mut out = String::new();
    for byte in id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'('
            | b')' | b'@' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The hub client identity Cloud Code Assist expects.
pub(super) fn antigravity_user_agent(client_version: &str) -> String {
    format!("antigravity/hub/{client_version} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)")
}

fn uuid_v4() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

/// `-<n>` where `n` is the first eight bytes of SHA-256 over the first user
/// text, modulo 2^63−1; a random id when the conversation opens with no text.
fn session_id(contents: &[Value]) -> String {
    let text: String = contents
        .iter()
        .find(|c| c["role"] == "user")
        .and_then(|c| c["parts"].as_array())
        .map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return format!("-{}", uuid_v4());
    }
    let digest = Sha256::digest(text.as_bytes());
    let head = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
    format!("-{}", head % 9_223_372_036_854_775_807)
}

impl GoogleCodec {
    pub fn gemini(origin: impl Into<String>, traits: Arc<dyn ModelTraits>) -> Self {
        Self {
            target: Target::Gemini { origin: origin.into() },
            traits,
            provider: ProviderId::from("gemini"),
            claude_caps: Arc::new(|_| None),
        }
    }

    pub fn vertex(place: VertexPlace, traits: Arc<dyn ModelTraits>) -> Self {
        Self {
            target: Target::Vertex { place },
            traits,
            provider: ProviderId::from("vertex-ai"),
            claude_caps: Arc::new(|_| None),
        }
    }

    pub fn antigravity(
        origin: impl Into<String>,
        project: impl Into<String>,
        client_version: impl Into<crate::client_versions::Live>,
        traits: Arc<dyn ModelTraits>,
    ) -> Self {
        Self {
            target: Target::Antigravity {
                origin: origin.into(),
                project: project.into(),
                client_version: client_version.into(),
            },
            traits,
            provider: ProviderId::from("antigravity-oauth"),
            claude_caps: Arc::new(|_| None),
        }
    }

    /// The Anthropic catalog's capabilities, which a Claude request on Vertex AI is built from
    /// (`buildAnthropicApiRequest({ capabilityModel })`).
    pub fn with_claude_caps(mut self, caps: CapsLookup) -> Self {
        self.claude_caps = caps;
        self
    }

    pub fn target(&self) -> &Target {
        &self.target
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    /// The owner of this wire's replay envelopes: Vertex AI's Gemini turns are tagged `gemini` as the Gemini API's are
    /// (`geminiSendResult` names no other provider), so either replays the other's.
    fn replay_owner(&self) -> ProviderId {
        match self.target {
            Target::Vertex { .. } => ProviderId::from("gemini"),
            _ => self.provider.clone(),
        }
    }

    pub fn traits(&self) -> &dyn ModelTraits {
        self.traits.as_ref()
    }

    fn dialect(&self) -> Dialect {
        let base = Dialect {
            owner: self.replay_owner(),
            system_role: Some("system"),
            function_ids: true,
            family_gated: false,
            replay_same_model: true,
            default_tool_mode: None,
            omit_ignored_sampling: false,
        };
        match self.target {
            Target::Gemini { .. } => Dialect { omit_ignored_sampling: true, ..base },
            Target::Vertex { .. } => Dialect {
                system_role: None,
                function_ids: false,
                ..base
            },
            Target::Antigravity { .. } => Dialect {
                system_role: Some("user"),
                family_gated: true,
                replay_same_model: false,
                default_tool_mode: Some("VALIDATED"),
                ..base
            },
        }
    }

    /// A rejected `request`: Vertex rewrites a model-not-enabled answer, the
    /// project and location read from the base it was sent to.
    /// `global` is true when the request was resent there after a 404.
    pub fn classify_for(&self, response: &ErrorResponse, request: &ModelRequest, global: bool) -> ProviderError {
        let maas = self.maas_model(&request.model);
        let claude = self.claude_model(&request.model);
        let mut error = match (&maas, &claude) {
            (Some(_), _) => maas::classify(response),
            (_, Some(_)) => claude::classify(response),
            _ => classify(response, &self.error_dialect(), SystemTime::now()),
        };
        let vertex = match maas.or(claude) {
            Some(model) => Some(model),
            None => self.model_id(&request.model).ok().map(|id| VertexModel { publisher: "google".into(), id: id.to_owned(), wire: Wire::Gemini }),
        };
        if let (Target::Vertex { place }, Some(model)) = (&self.target, vertex) {
            let tier = Tier::requested(request.options.model_parameters.as_ref());
            let chosen = if global { Ok("global".to_owned()) } else { place.choose(&model.route(), tier) };
            if let Ok(location) = chosen {
                let project = place.project_id().unwrap_or("(unknown project)");
                vertex_model_access(&mut error, response, &model.publisher, &model.id, project, &location);
            }
        }
        error
    }

    /// The open model `model` names on Vertex AI, when it names one (`vertexRoute(model).wire === 'maas'`).
    pub fn maas_model(&self, model: &str) -> Option<VertexModel> {
        if !matches!(self.target, Target::Vertex { .. }) {
            return None;
        }
        vertex_model(model).ok().filter(|m| m.wire == Wire::Maas)
    }

    /// The Claude model `model` names on Vertex AI, when it names one (`vertexRoute(model).wire === 'claude'`).
    pub fn claude_model(&self, model: &str) -> Option<VertexModel> {
        if !matches!(self.target, Target::Vertex { .. }) {
            return None;
        }
        vertex_model(model).ok().filter(|m| m.wire == Wire::Claude)
    }

    /// The location a send of a model that is not Google's Gemini goes to: an express key serves Gemini models only.
    fn partner_location(&self, request: &ModelRequest, model: &VertexModel, global: bool) -> Result<(String, String), ProviderError> {
        let Target::Vertex { place } = &self.target else {
            return Err(invalid(format!("{} is not a Google-published Vertex AI model", model.qualified())));
        };
        if place.account == VertexAccount::Express {
            return Err(invalid(format!(
                "[vertex-ai] {} needs a service-account key or the gcloud login: a Vertex AI express mode API key serves Gemini models only",
                model.qualified()
            )));
        }
        let tier = Tier::requested(request.options.model_parameters.as_ref());
        let location = if global { "global".to_owned() } else { place.choose(&model.route(), tier)? };
        let base = place.base(&location)?;
        Ok((location, base))
    }

    /// The HTTP request of an open-model send (`_sendMaas`); `global` sends it to `global`.
    pub fn maas_wire(&self, request: &ModelRequest, model: &VertexModel, global: bool) -> Result<WireRequest, ProviderError> {
        let (_, base) = self.partner_location(request, model, global)?;
        maas::wire(request, model, &base)
    }

    /// The HTTP request of a Claude send (`_sendClaude`); `global` sends it to `global`.
    pub fn claude_wire(&self, request: &ModelRequest, model: &VertexModel, global: bool) -> Result<WireRequest, ProviderError> {
        let (_, base) = self.partner_location(request, model, global)?;
        claude::wire(&self.claude_caps, request, model, &base)
    }

    /// The labels Node's senders give `geminiRestError` and the stream consumer (`gemini.mjs`, `vertex-ai.mjs`), and
    /// the endpoint `antigravityError` names.
    fn error_dialect(&self) -> ErrorDialect {
        match &self.target {
            Target::Gemini { .. } => ErrorDialect::gemini("Gemini REST streamGenerateContent"),
            Target::Vertex { .. } => ErrorDialect::gemini("Vertex AI Gemini streamGenerateContent"),
            Target::Antigravity { origin, .. } => ErrorDialect::antigravity(origin.clone()),
        }
    }

    /// The model id as the endpoint's path names it. Vertex routes the id ([`vertex_model`]); only Google's Gemini
    /// models are sent here, open models through [`Self::maas_wire`].
    fn model_id<'a>(&self, model: &'a str) -> Result<&'a str, ProviderError> {
        if !matches!(self.target, Target::Vertex { .. }) {
            return Ok(model.strip_prefix("models/").unwrap_or(model));
        }
        if vertex_model(model)?.wire != Wire::Gemini {
            return Err(invalid(format!("{model} is not a Google-published Vertex AI model")));
        }
        // The id is the last path segment of the trimmed model.
        let trimmed = mixdog_js::js_trim(model);
        Ok(trimmed.rsplit('/').next().unwrap_or(trimmed))
    }
}

impl WireCodec for GoogleCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        if let Some(model) = self.maas_model(&request.model) {
            return self.maas_wire(request, &model, false);
        }
        if let Some(model) = self.claude_model(&request.model) {
            return self.claude_wire(request, &model, false);
        }
        let inner = self.build_inner(request)?;
        self.wire(request, &inner, None)
    }

    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        self.decoder_at(request, false)
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        classify(response, &self.error_dialect(), SystemTime::now())
    }
}

/// A live explicit cache attached to a Gemini API request.
#[derive(Clone, Copy)]
pub struct Attach<'a> {
    pub name: &'a str,
    pub state: &'a GeminiCacheState,
}

impl GoogleCodec {
    /// The Gemini-shaped request object, before any endpoint envelope.
    pub fn build_inner(&self, request: &ModelRequest) -> Result<Value, ProviderError> {
        self.model_id(&request.model)?;
        build_request(request, &self.dialect(), self.traits.as_ref())
    }

    /// The HTTP request for `inner`; with `cache` the body carries only the
    /// uncached tail and `cachedContent` (the cache holds the rest).
    pub fn wire(
        &self,
        request: &ModelRequest,
        inner: &Value,
        cache: Option<Attach<'_>>,
    ) -> Result<WireRequest, ProviderError> {
        self.wire_at(request, inner, cache, false)
    }

    /// Whether a 404 for `request` is resent once on Vertex's `global` location.
    pub fn falls_back_to_global(&self, request: &ModelRequest) -> bool {
        let (Target::Vertex { place }, Ok(model)) = (&self.target, vertex_model(&request.model)) else {
            return false;
        };
        place.falls_back_to_global(&model.route(), Tier::requested(request.options.model_parameters.as_ref()))
    }

    /// [`Self::wire`]; `global` sends a Vertex request to `global`.
    pub fn wire_at(
        &self,
        request: &ModelRequest,
        inner: &Value,
        cache: Option<Attach<'_>>,
        global: bool,
    ) -> Result<WireRequest, ProviderError> {
        let id = self.model_id(&request.model)?;
        let mut inner = match cache {
            Some(attach) => {
                let contents = inner["contents"].as_array().map(Vec::as_slice).unwrap_or_default();
                cached_body(attach.name, attach.state, contents, inner.get("generationConfig"))
            }
            None => inner.clone(),
        };
        // The Gemini API's own spelling (`geminiApiHeaders`, gemini.mjs:94), which undici keeps on the wire.
        let content_type = if matches!(self.target, Target::Gemini { .. }) { "Content-Type" } else { "content-type" };
        let mut headers = vec![(content_type.to_owned(), "application/json".to_owned())];
        let (url, body) = match &self.target {
            Target::Gemini { origin } => (
                format!("{origin}/v1beta/models/{}:streamGenerateContent?alt=sse", path_segment(id)),
                inner,
            ),
            Target::Vertex { place } => {
                let route = Route { publisher: "google", id, wire: Wire::Gemini };
                let tier = Tier::requested(request.options.model_parameters.as_ref());
                let location = if global { "global".to_owned() } else { place.choose(&route, tier)? };
                let base = place.base(&location)?;
                if let Some(value) = tier.header_value() {
                    headers.push(("x-vertex-ai-llm-shared-request-type".into(), value.into()));
                }
                (
                    format!("{base}/publishers/google/models/{}:streamGenerateContent?alt=sse", path_segment(id)),
                    inner,
                )
            }
            Target::Antigravity { origin, project, client_version } => {
                // antigravity-oauth.mjs:166-172: the bearer leads the head (its slot, filled where the request is
                // authorized), and a Claude model gets the interleaved-thinking beta.
                headers.insert(0, ("authorization".into(), String::new()));
                headers.push(("accept".into(), "text/event-stream".into()));
                headers.push(("user-agent".into(), antigravity_user_agent(&client_version.get())));
                if super::request::antigravity_claude(&id) {
                    headers.push(("anthropic-beta".into(), "interleaved-thinking-2025-05-14".into()));
                }
                let contents = inner["contents"].as_array().cloned().unwrap_or_default();
                inner["sessionId"] = json!(session_id(&contents));
                (
                    format!("{origin}/v1internal:streamGenerateContent?alt=sse"),
                    json!({
                        "project": project,
                        "model": id,
                        "request": inner,
                        "requestType": "agent",
                        "userAgent": "antigravity",
                        "requestId": format!("agent-{}", uuid_v4()),
                    }),
                )
            }
        };
        let body = serde_json::to_vec(&body).map_err(|e| {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            err.message = e.to_string();
            err
        })?;
        Ok(WireRequest {
            transport: TransportKind::Http1,
            method: "POST".into(),
            url,
            headers,
            body,
        })
    }

    /// The decoder of an answer to `request`; `global`: the request was resent to Vertex's `global` location.
    pub fn decoder_at(&self, request: &ModelRequest, global: bool) -> Box<dyn WireDecoder> {
        if let Some(model) = self.maas_model(&request.model) {
            return Box::new(maas::decoder(request, &model));
        }
        if let Some(model) = self.claude_model(&request.model) {
            // The location only prices the answer; a request that cannot be placed was never sent.
            let location = self.partner_location(request, &model, global).map(|(location, _)| location).unwrap_or_default();
            return Box::new(claude::decoder(&model, &location, body_tool_names(self, request, ToolNames::Named)));
        }
        Box::new(GeminiDecoder::new(DecodeDialect {
            owner: self.replay_owner(),
            envelope: matches!(self.target, Target::Antigravity { .. }),
            usage: match self.target {
                Target::Gemini { .. } => UsageStyle::Inclusive,
                Target::Vertex { .. } => UsageStyle::CacheExclusive,
                Target::Antigravity { .. } => UsageStyle::ToolUseAdded,
            },
            errors: self.error_dialect(),
        })
        .with_known_tools(request_tool_names(request))
        .for_model(&request.model))
    }
}
