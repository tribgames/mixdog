//! Reasoning text on Chat Completions: where a reply carries it, what is kept
//! for replay, and how a prior turn's reasoning goes back (PW §5.7,
//! `openai-compat-reasoning-field.mjs`). The kept part travels in the
//! assistant message's [`ProviderReplay`] envelope, owned by the provider that
//! produced it.

use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_protocol::{JsonValue, ProviderId};
use serde_json::json;

use super::super::profile::{ChatDialect, ReasoningShape};

/// The key a reply's reasoning arrived on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    ReasoningContent,
    Reasoning,
    Thinking,
    ContentChunks,
}

/// One piece of an array-shaped `content` (Mistral reasoning chunks).
pub enum ContentPiece {
    Text(String),
    Reasoning(String),
}

/// The ordered pieces of a list-shaped `content`, or `None` for the plain
/// string / absent shape.
pub fn content_pieces(content: &JsonValue) -> Option<Vec<ContentPiece>> {
    let chunks = content.as_array()?;
    let mut out = Vec::new();
    for chunk in chunks {
        if let Some(text) = chunk.as_str() {
            out.push(ContentPiece::Text(text.to_owned()));
        } else if chunk.get("type").and_then(JsonValue::as_str) == Some("thinking") {
            out.push(ContentPiece::Reasoning(thinking_text(chunk.get("thinking"))));
        } else if chunk.get("type").and_then(JsonValue::as_str) == Some("text")
            && let Some(text) = chunk.get("text").and_then(JsonValue::as_str)
        {
            out.push(ContentPiece::Text(text.to_owned()));
        }
    }
    Some(out)
}

fn thinking_text(thinking: Option<&JsonValue>) -> String {
    match thinking {
        Some(JsonValue::String(s)) => s.clone(),
        Some(JsonValue::Array(inner)) => inner
            .iter()
            .map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(JsonValue::as_str))
                    .unwrap_or_default()
            })
            .collect(),
        _ => String::new(),
    }
}

fn shape_captures(shape: Option<ReasoningShape>, source: Source) -> bool {
    match shape {
        None => source == Source::ContentChunks,
        Some(shape) => {
            source == Source::ContentChunks
                || source == Source::ReasoningContent
                || (shape.reads_reasoning_alias() && source == Source::Reasoning)
        }
    }
}

/// Whether a reply's reasoning is kept for replay.
pub fn captures(dialect: &ChatDialect, source: Source) -> bool {
    dialect.capture_reasoning
        || dialect.replay_reasoning
        || shape_captures(dialect.reasoning_shape, source)
}

/// The receive key worth recording: `reasoning` (non-default key) or
/// `content_chunks`, per shape; `reasoning_content` is the default.
fn replay_field(shape: Option<ReasoningShape>, source: Source) -> Option<&'static str> {
    match (shape?, source) {
        (ReasoningShape::SameKey, Source::Reasoning) => Some("reasoning"),
        (ReasoningShape::ContentChunks, Source::ContentChunks) => Some("content_chunks"),
        _ => None,
    }
}

/// The envelope a finished reply leaves for the next request.
pub fn envelope(
    owner: &ProviderId,
    dialect: &ChatDialect,
    text: &str,
    source: Source,
    details: &[JsonValue],
) -> ProviderReplay {
    let mut items = json!({ "reasoningContent": text });
    if let Some(field) = replay_field(dialect.reasoning_shape, source) {
        items["reasoningField"] = field.into();
    }
    if !details.is_empty() {
        items["reasoningDetails"] = JsonValue::Array(details.to_vec());
    }
    ProviderReplay {
        owner: owner.clone(),
        items,
    }
}

/// What an assistant message's own envelope says.
pub struct Replayed<'a> {
    pub text: &'a str,
    pub field: Option<&'a str>,
    pub details: Option<&'a Vec<JsonValue>>,
}

pub fn replayed(replay: &ProviderReplay) -> Option<Replayed<'_>> {
    let text = replay.items.get("reasoningContent")?.as_str()?;
    Some(Replayed {
        text,
        field: replay.items.get("reasoningField").and_then(JsonValue::as_str),
        details: replay
            .items
            .get("reasoningDetails")
            .and_then(JsonValue::as_array)
            .filter(|d| !d.is_empty()),
    })
}

/// Assistant content with the prior reasoning as a leading `thinking` chunk.
pub fn content_with_thinking_chunk(content: JsonValue, reasoning: &str) -> JsonValue {
    let thinking = json!({"type": "thinking", "thinking": [{"type": "text", "text": reasoning}]});
    match content {
        JsonValue::Array(mut chunks) => {
            chunks.insert(0, thinking);
            JsonValue::Array(chunks)
        }
        JsonValue::String(text) if !text.is_empty() => {
            json!([thinking, {"type": "text", "text": text}])
        }
        _ => json!([thinking]),
    }
}
