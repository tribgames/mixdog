//! Claude on Vertex AI (`_sendClaude`, vertex-ai.mjs:449-552): the Anthropic Messages request of the API-key route for
//! the provider `vertex-ai` (no beta headers, fast mode or server-side fallback), without its `model`, with Vertex's
//! `anthropic_version` and the betas Vertex takes in the body, sent to `publishers/anthropic/models/M:streamRawPredict`
//! with the Vertex bearer; the answer is Anthropic's SSE stream, billed as the requested publisher model.

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::maas::VertexModel;
use super::serving::claude_needs_interleaved_beta;
use super::serving::claude_pricing_model;
use crate::providers::anthropic::AnthropicDecoder;
use crate::providers::anthropic::CapsLookup;
use crate::providers::anthropic::errors::classify_response;
use crate::providers::anthropic::vertex_body;

/// `VERTEX_ANTHROPIC_VERSION`.
const VERTEX_ANTHROPIC_VERSION: &str = "vertex-2023-10-16";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";
/// Vertex's name of Anthropic's tool-search beta (`VERTEX_CLAUDE_BETAS`).
const TOOL_SEARCH_BETA: &str = "tool-search-tool-2025-10-19";

/// `encodeURIComponent(model)` with `@` kept, over the characters a Vertex model id may hold (`MODEL_ID`).
fn path_id(id: &str) -> String {
    id.replace(':', "%3A")
}

/// The HTTP request of a Claude send to the location base `base`.
pub fn wire(caps: &CapsLookup, request: &ModelRequest, model: &VertexModel, base: &str) -> Result<WireRequest, ProviderError> {
    let (mut body, tool_search) = vertex_body(caps, request, &model.id)?;
    body.shift_remove("model");
    body.insert("anthropic_version".into(), json!(VERTEX_ANTHROPIC_VERSION));
    // `vertexClaudeBetas`: interleaved thinking only for a manual budget with tools on a model that documents it.
    let mut betas = Vec::new();
    let manual = body.get("thinking").and_then(|t| t.get("type")).and_then(Value::as_str) == Some("enabled");
    let tools = body.get("tools").and_then(Value::as_array).is_some_and(|t| !t.is_empty());
    if manual && tools && claude_needs_interleaved_beta(&model.id) {
        betas.push(INTERLEAVED_THINKING_BETA);
    }
    if tool_search {
        betas.push(TOOL_SEARCH_BETA);
    }
    if !betas.is_empty() {
        body.insert("anthropic_beta".into(), json!(betas));
    }
    let body = serde_json::to_vec(&body).map_err(|e| {
        let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
        err.message = e.to_string();
        err
    })?;
    Ok(WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: format!("{base}/publishers/anthropic/models/{}:streamRawPredict", path_id(&model.id)),
        headers: vec![("content-type".into(), "application/json".into())],
        body,
    })
}

/// A refused Claude send: Vertex's error body read as Anthropic's (`applyAnthropicErrorContract` over the body text).
pub fn classify(response: &ErrorResponse) -> ProviderError {
    classify_response(response)
}

/// Anthropic's decoder for the model, every turn billed as the requested publisher model at its location.
pub struct ClaudeDecoder {
    inner: AnthropicDecoder,
    pricing_model: String,
}

pub fn decoder(model: &VertexModel, location: &str, known: std::collections::HashSet<String>) -> ClaudeDecoder {
    ClaudeDecoder {
        // `buildAnthropicTurnResult(parsed, { useModel: model })`; the replay is Anthropic's (`createProviderReplay('anthropic', …)`).
        inner: AnthropicDecoder::for_model(ProviderId::from("anthropic"), &model.id).with_known_tools(known),
        pricing_model: claude_pricing_model(&model.id, location),
    }
}

impl ClaudeDecoder {
    fn map(&self, events: Vec<StreamEvent>) -> Vec<StreamEvent> {
        events
            .into_iter()
            .map(|event| match event {
                StreamEvent::Completed { stop, request_ms, .. } => {
                    StreamEvent::Completed { stop, pricing_model: Some(self.pricing_model.clone()), request_ms }
                }
                other => other,
            })
            .collect()
    }
}

impl WireDecoder for ClaudeDecoder {
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
