//! Vertex AI's model routes (`vertexRoute`, vertex-ai-models.mjs:231-262) and its open and partner models
//! (`VertexMaasRoute`, vertex-ai-maas.mjs): every publisher but Google's Gemini and Anthropic is sent as Chat
//! Completions on `projects/P/locations/L/endpoints/openapi`, with the Vertex bearer, Vertex's cache-exclusive usage and
//! the `publisher/model` pricing id.

use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::request::invalid;
use super::serving::Route;
use super::serving::Wire;
use super::serving::listed_locations;
use crate::providers::compat::CompatChatCodec;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::CompatProfile;
use crate::providers::compat::chat::ChatDecoder;
use crate::providers::compat::profile::CredentialKind;
use crate::providers::leak::ToolNames;
use crate::providers::leak::body_tool_names;

/// A Vertex model id resolved to its publisher, id and wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VertexModel {
    pub publisher: String,
    pub id: String,
    pub wire: Wire,
}

impl VertexModel {
    pub fn route(&self) -> Route<'_> {
        Route { publisher: &self.publisher, id: &self.id, wire: self.wire }
    }

    /// `vertexPricingModel` of an open model: its catalog rows are keyed `publisher/model`.
    pub fn qualified(&self) -> String {
        format!("{}/{}", self.publisher, self.id)
    }
}

fn valid_publisher(publisher: &str) -> bool {
    let bytes = publisher.as_bytes();
    (1..=63).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || b"._@:-".contains(b))
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// `vertexRoute(model)`: `publishers/P/models/M` or `P/M`, else a `gemini-`, `claude-` or `grok-` id; Anthropic answers
/// rawPredict, Google generateContent except its open models (a `-maas` id or a listed one), every other publisher MaaS.
pub fn vertex_model(model: &str) -> Result<VertexModel, ProviderError> {
    let raw = mixdog_js::js_trim(model);
    if raw.is_empty() {
        return Err(invalid("[vertex-ai] model is required"));
    }
    let parts: Vec<&str> = raw.split('/').collect();
    let path = match parts.as_slice() {
        ["publishers", publisher, "models", id] if !publisher.is_empty() && !id.is_empty() => Some((*publisher, *id)),
        [publisher, id] if !publisher.is_empty() && !id.is_empty() => Some((*publisher, *id)),
        _ => None,
    };
    let (publisher, id) = match path {
        Some((publisher, id)) => (publisher.to_lowercase(), id.to_owned()),
        // `geminiBareModelId`: no `models/` prefix can precede `gemini-`.
        None if starts_with_ignore_case(raw, "gemini-") => ("google".to_owned(), raw.to_owned()),
        None if starts_with_ignore_case(raw, "claude-") => ("anthropic".to_owned(), raw.to_owned()),
        None if starts_with_ignore_case(raw, "grok-") => ("xai".to_owned(), raw.to_owned()),
        None => {
            return Err(invalid(format!(
                "[vertex-ai] cannot determine the publisher of model \"{raw}\"; use \"publisher/model\" (for example \"deepseek-ai/deepseek-v3.2-maas\")"
            )));
        }
    };
    if !valid_publisher(&publisher) || !valid_id(&id) {
        return Err(invalid(format!("[vertex-ai] model \"{raw}\" is invalid")));
    }
    let maas_named = id.len() >= 5 && id[id.len() - 5..].eq_ignore_ascii_case("-maas");
    let wire = if publisher == "anthropic" {
        Wire::Claude
    } else if publisher == "google" && !maas_named && listed_locations(&format!("{publisher}/{id}")).is_none() {
        Wire::Gemini
    } else {
        Wire::Maas
    };
    Ok(VertexModel { publisher, id, wire })
}

/// The Chat Completions engine of one location base (`VertexMaasRoute._engine`): the shared OpenAI-compatible
/// transport with no profile of its own (`vertex-ai` has none) on `<base>/endpoints/openapi`.
fn engine(base: &str) -> CompatChatCodec {
    CompatChatCodec::new(
        CompatProfile::plain("vertex-ai", "", CredentialKind::Keyless),
        CompatConfig { base_url: Some(format!("{base}/endpoints/openapi")), ..CompatConfig::default() },
    )
}

/// The request as the engine sends it: the model is `publisher/model`.
fn engine_request(request: &ModelRequest, model: &VertexModel) -> ModelRequest {
    let mut sent = request.clone();
    sent.model = model.qualified();
    sent
}

/// `MAAS_CHAT_PROFILE.applyParams`: gpt-oss takes `reasoning_effort` low/medium/high, set where the profile hook runs,
/// before the stream fields (openai-compat-chat-send.mjs:127, :145-146).
fn apply_effort(body: &mut serde_json::Map<String, Value>, request: &ModelRequest, model: &VertexModel) {
    if !starts_with_ignore_case(&model.qualified(), "openai/gpt-oss-") {
        return;
    }
    let effort = mixdog_js::js_trim(request.options.effort.as_deref().unwrap_or_default()).to_lowercase();
    if !matches!(effort.as_str(), "low" | "medium" | "high") {
        return;
    }
    let stream = body.shift_remove("stream");
    let options = body.shift_remove("stream_options");
    body.insert("reasoning_effort".into(), effort.into());
    body.extend(stream.map(|v| ("stream".to_owned(), v)));
    body.extend(options.map(|v| ("stream_options".to_owned(), v)));
}

/// The HTTP request of an open-model send to the location base `base`.
pub fn wire(request: &ModelRequest, model: &VertexModel, base: &str) -> Result<WireRequest, ProviderError> {
    let sent = engine_request(request, model);
    let mut wire = engine(base).encode(&sent)?;
    let mut body: serde_json::Map<String, Value> = serde_json::from_slice(&wire.body).unwrap_or_default();
    apply_effort(&mut body, request, model);
    wire.body = serde_json::to_vec(&body).unwrap_or_default();
    Ok(wire)
}

/// `vertexErrorBody`: an error answered as a JSON array of error objects reads as its first entry, when the response
/// says it is JSON; then the engine's classification.
pub fn classify(response: &ErrorResponse) -> ProviderError {
    let json = response
        .headers
        .iter()
        .any(|(name, value)| name.eq_ignore_ascii_case("content-type") && value.to_lowercase().contains("json"));
    let first = json
        .then(|| serde_json::from_slice::<Value>(&response.body).ok())
        .flatten()
        .and_then(|parsed| parsed.as_array().and_then(|items| items.first()).filter(|first| first.get("error").is_some_and(|e| !e.is_null())).cloned());
    match first {
        Some(first) => {
            let unwrapped = ErrorResponse { body: first.to_string().into_bytes(), ..response.clone() };
            engine("").classify(&unwrapped)
        }
        None => engine("").classify(response),
    }
}

/// `toVertexExclusiveUsage` (vertex-ai-maas.mjs:35-48): the input is the uncached remainder.
pub fn exclusive(mut usage: Usage) -> Usage {
    usage.input_tokens = usage.input_tokens.saturating_sub(usage.cache_read_tokens + usage.cache_write_tokens);
    usage
}

/// The engine's decoder with Vertex's usage, the answering model the chunks name, and the `publisher/model` pricing id.
pub struct MaasDecoder {
    inner: ChatDecoder,
    pricing_model: String,
}

pub fn decoder(request: &ModelRequest, model: &VertexModel) -> MaasDecoder {
    let engine = engine("");
    let sent = engine_request(request, model);
    let known = body_tool_names(&engine, &sent, ToolNames::Chat);
    MaasDecoder {
        inner: ChatDecoder::new(engine.profile().clone(), mixdog_protocol::ProviderId::from("vertex-ai"))
            .with_known_tools(known),
        pricing_model: model.qualified(),
    }
}

impl MaasDecoder {
    fn map(&self, events: Vec<StreamEvent>) -> Vec<StreamEvent> {
        events
            .into_iter()
            .map(|event| match event {
                StreamEvent::Usage(usage) => StreamEvent::Usage(exclusive(usage)),
                StreamEvent::Completed { stop, request_ms, .. } => {
                    StreamEvent::Completed { stop, pricing_model: Some(self.pricing_model.clone()), request_ms }
                }
                other => other,
            })
            .collect()
    }
}

impl WireDecoder for MaasDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        let events = self.inner.feed(unit)?;
        Ok(self.map(events))
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        let events = self.inner.finish()?;
        Ok(self.map(events))
    }

    fn terminal_seen(&self) -> bool {
        self.inner.terminal_seen()
    }

    fn exposure(&self) -> Exposure {
        self.inner.exposure()
    }
}
