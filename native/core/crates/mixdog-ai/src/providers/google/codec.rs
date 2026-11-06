//! The [`WireCodec`] of the Google family: pure translation between a
//! [`ModelRequest`] and the three Gemini-shaped endpoints. Credentials are
//! the adapter's; the codec writes none.

use std::sync::Arc;

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
use super::decode::DecodeDialect;
use super::decode::GeminiDecoder;
use super::decode::UsageStyle;
use super::error::ErrorDialect;
use super::error::vertex_model_access;
use super::error::classify;
use super::request::Dialect;
use super::request::build_request;
use super::request::invalid;
use super::serving::Route;
use super::serving::Tier;
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
        client_version: String,
    },
}

pub struct GoogleCodec {
    target: Target,
    traits: Arc<dyn ModelTraits>,
    provider: ProviderId,
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
        }
    }

    pub fn vertex(place: VertexPlace, traits: Arc<dyn ModelTraits>) -> Self {
        Self {
            target: Target::Vertex { place },
            traits,
            provider: ProviderId::from("vertex-ai"),
        }
    }

    pub fn antigravity(
        origin: impl Into<String>,
        project: impl Into<String>,
        client_version: impl Into<String>,
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
        }
    }

    pub fn target(&self) -> &Target {
        &self.target
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    pub fn traits(&self) -> &dyn ModelTraits {
        self.traits.as_ref()
    }

    fn dialect(&self) -> Dialect {
        let base = Dialect {
            owner: self.provider.clone(),
            system_role: Some("system"),
            function_ids: true,
            family_gated: false,
            replay_same_model: true,
            default_tool_mode: None,
        };
        match self.target {
            Target::Gemini { .. } => base,
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
        let mut error = classify(response, self.error_dialect());
        if let (Target::Vertex { place }, Ok(model)) = (&self.target, self.model_id(&request.model)) {
            let route = Route { publisher: "google", id: model, wire: Wire::Gemini };
            let tier = Tier::requested(request.options.model_parameters.as_ref());
            let chosen = if global { Ok("global".to_owned()) } else { place.choose(&route, tier) };
            if let Ok(location) = chosen {
                let project = place.project_id().unwrap_or("(unknown project)");
                vertex_model_access(&mut error, response, "google", model, project, &location);
            }
        }
        error
    }

    fn error_dialect(&self) -> ErrorDialect {
        ErrorDialect {
            capacity_by_status: matches!(self.target, Target::Antigravity { .. }),
        }
    }

    /// The model id as the endpoint's path names it. Vertex also accepts the
    /// publisher-qualified forms; only Google's own publisher is served here.
    fn model_id<'a>(&self, model: &'a str) -> Result<&'a str, ProviderError> {
        let id = model.strip_prefix("models/").unwrap_or(model);
        if !matches!(self.target, Target::Vertex { .. }) {
            return Ok(id);
        }
        let id = id
            .strip_prefix("publishers/google/models/")
            .or_else(|| id.strip_prefix("google/"))
            .unwrap_or(id);
        if id.contains('/') {
            return Err(invalid(format!("{model} is not a Google-published Vertex AI model")));
        }
        Ok(id)
    }
}

impl WireCodec for GoogleCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let inner = self.build_inner(request)?;
        self.wire(request, &inner, None)
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        self.decoder_impl()
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        classify(response, self.error_dialect())
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
        let (Target::Vertex { place }, Ok(id)) = (&self.target, self.model_id(&request.model)) else {
            return false;
        };
        let route = Route { publisher: "google", id, wire: Wire::Gemini };
        place.falls_back_to_global(&route, Tier::requested(request.options.model_parameters.as_ref()))
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
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
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
                headers.push(("accept".into(), "text/event-stream".into()));
                headers.push(("user-agent".into(), antigravity_user_agent(client_version)));
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

    fn decoder_impl(&self) -> Box<dyn WireDecoder> {
        Box::new(GeminiDecoder::new(DecodeDialect {
            owner: self.provider.clone(),
            envelope: matches!(self.target, Target::Antigravity { .. }),
            usage: match self.target {
                Target::Gemini { .. } => UsageStyle::Inclusive,
                Target::Vertex { .. } => UsageStyle::CacheExclusive,
                Target::Antigravity { .. } => UsageStyle::ToolUseAdded,
            },
            errors: self.error_dialect(),
        }))
    }
}
