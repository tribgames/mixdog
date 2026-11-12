//! The per-message token meter: the text projection of a message priced by
//! the text estimator, plus an allowance for each image and document it
//! carries, plus 4 per message.
//!
//! Media is priced by the host that owns the attachment store
//! ([`MediaMeter`]): a document's text form and page count come from bytes
//! this crate never reads.

use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::ProviderId;
use mixdog_js::JsRegex;
use serde_json::Value as JsonValue;
use serde_json::json;

use mixdog_js::token_estimate::estimate_tokens;
use crate::message::AgentMessage;

/// Vision models downscale past this, so no image bills above it; also the
/// flat allowance of an image whose size was never learned.
pub const IMAGE_TOKEN_ALLOWANCE: u64 = 1_568;

const OPAQUE_BYTES_PER_TOKEN: f64 = 3.43;
const OPAQUE_WORD: &str = "opaque ";
const PER_MESSAGE_TOKENS: u64 = 4;

/// What one content part costs in a request.
pub struct PartMeter {
    /// The part's text projection (empty when it has none).
    pub text: String,
    /// Allowance for the media the part carries.
    pub tokens: u64,
}

/// Prices the non-text parts a message carries (images, files, documents);
/// implemented by the owner of the attachment store.
///
/// The meter is synchronous, so what it needs from the store is read first: [`Self::prepare`] is
/// awaited with the messages that are about to be measured.
#[async_trait]
pub trait MediaMeter: Send + Sync {
    fn part(&self, part: &ContentPart) -> PartMeter;

    /// Reads from the store what pricing `messages` needs (the facts of the stored attachments
    /// they carry, the text of the stored text attachments). A meter with nothing to read has
    /// nothing to do. `Err` is a read that failed for now (Node's synchronous read throws it out of
    /// the pricing); a blob that is gone for good is priced as gone.
    async fn prepare(&self, messages: &[AgentMessage]) -> Result<(), String> {
        let _ = messages;
        Ok(())
    }
}

/// Pixel size and detail of one image inside a provider-native JSON block.
#[derive(Clone, Debug, PartialEq)]
pub struct JsonImage {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub detail: String,
}

impl JsonImage {
    fn allowance(&self) -> u64 {
        match (self.width, self.height) {
            (Some(w), Some(h)) => IMAGE_TOKEN_ALLOWANCE.min((w * h / 750.0).ceil() as u64),
            _ => IMAGE_TOKEN_ALLOWANCE,
        }
    }
}

fn number_of(value: Option<&JsonValue>) -> Option<f64> {
    let number = match value? {
        JsonValue::Number(n) => n.as_f64()?,
        JsonValue::String(s) => mixdog_js::string_to_number(s),
        _ => return None,
    };
    (number.is_finite() && number > 0.0).then_some(number)
}

fn first_dimension(values: &[Option<&JsonValue>]) -> Option<f64> {
    values.iter().find_map(|value| number_of(*value))
}

fn string_field<'a>(block: &'a JsonValue, key: &str) -> Option<&'a str> {
    block.get(key).and_then(JsonValue::as_str)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|s| !s.is_empty())
}

/// Whether a provider-native block is an image (inline, URL, file id or file
/// URI), the way the media normalizer reads one.
fn block_is_image(block: &JsonValue) -> bool {
    let kind = string_field(block, "type");
    let source = block.get("source").filter(|s| s.is_object());
    let inline = block.get("inlineData").or_else(|| block.get("inline_data"));
    if kind == Some("image") {
        if non_empty(string_field(block, "data")).is_some() {
            return true;
        }
        if let Some(source) = source {
            let type_ = string_field(source, "type");
            if type_ == Some("base64") && non_empty(string_field(source, "data")).is_some() {
                return true;
            }
            if type_ == Some("url") && string_field(source, "url").is_some() {
                return true;
            }
            if type_ == Some("file") && non_empty(string_field(source, "file_id")).is_some() {
                return true;
            }
        }
        if non_empty(string_field(block, "uri")).is_some() {
            return true;
        }
    }
    if matches!(kind, Some("image_url" | "input_image")) {
        match block.get("image_url") {
            Some(JsonValue::String(_)) => return true,
            Some(value) if value.get("url").is_some_and(JsonValue::is_string) => return true,
            _ => {}
        }
    }
    if kind == Some("input_image") && non_empty(string_field(block, "file_id")).is_some() {
        return true;
    }
    if inline.is_some_and(|i| non_empty(string_field(i, "data")).is_some()) {
        return true;
    }
    let file_data = block.get("fileData").or_else(|| block.get("file_data"));
    file_data.is_some_and(|f| {
        non_empty(string_field(f, "fileUri")).is_some() || non_empty(string_field(f, "file_uri")).is_some()
    })
}

fn image_of(block: &JsonValue) -> Option<JsonImage> {
    if !block.is_object() || !block_is_image(block) {
        return None;
    }
    let image_url = block.get("image_url").filter(|v| v.is_object());
    let source = block.get("source").filter(|v| v.is_object());
    let inline = block.get("inlineData").or_else(|| block.get("inline_data"));
    let dimensions = block.get("dimensions").filter(|v| v.is_object());
    let dimension = |key: &str| {
        first_dimension(&[
            block.get(key),
            dimensions.and_then(|d| d.get(key)),
            image_url.and_then(|d| d.get(key)),
            source.and_then(|d| d.get(key)),
            inline.and_then(|d| d.get(key)),
        ])
    };
    let detail = [Some(block), image_url, source, inline]
        .into_iter()
        .flatten()
        .find_map(|v| v.get("detail").filter(|d| !d.is_null()))
        .map(|d| match d {
            JsonValue::String(s) => s.to_lowercase(),
            other => mixdog_js::value_to_string(other).to_lowercase(),
        })
        .unwrap_or_else(|| "auto".to_owned());
    Some(JsonImage {
        width: dimension("width"),
        height: dimension("height"),
        detail,
    })
}

/// The images of one provider-native block (or an array/`content` list of
/// blocks).
fn block_images(block: &JsonValue) -> Vec<JsonImage> {
    if let Some(list) = block.as_array() {
        return list.iter().filter_map(image_of).collect();
    }
    if let Some(list) = block.get("content").and_then(JsonValue::as_array) {
        return list.iter().filter_map(image_of).collect();
    }
    image_of(block).into_iter().collect()
}

static OPAQUE_KEY: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static("signature|encrypted|redacted|^data$|^blob$", "i"));
static OPAQUE_VALUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("^[A-Za-z0-9+/_=-]{64,}$", ""));

/// An opaque replay blob priced as the base64 it is: plain words that
/// estimate at exactly chars/4.
fn opaque_projection(length: usize) -> String {
    let tokens = (length as f64 / OPAQUE_BYTES_PER_TOKEN).ceil() as usize;
    let chars = tokens * 4;
    OPAQUE_WORD.repeat(chars.div_ceil(OPAQUE_WORD.len()))[..chars].to_owned()
}

fn strip_opaque_payloads(value: &JsonValue, depth: usize, key_hint: &str) -> JsonValue {
    match value {
        JsonValue::String(s) => {
            if s.len() >= 64 && OPAQUE_KEY.is_match(key_hint) && OPAQUE_VALUE.is_match(s) {
                JsonValue::String(opaque_projection(s.len()))
            } else {
                value.clone()
            }
        }
        JsonValue::Array(items) if depth < 8 => {
            JsonValue::Array(items.iter().map(|v| strip_opaque_payloads(v, depth + 1, key_hint)).collect())
        }
        JsonValue::Object(map) if depth < 8 => JsonValue::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), strip_opaque_payloads(v, depth + 1, k)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn image_stub_text(images: &[JsonImage]) -> String {
    let rows: Vec<JsonValue> = images
        .iter()
        .map(|i| json!({"type": "image", "width": i.width.and_then(serde_json::Number::from_f64), "height": i.height.and_then(serde_json::Number::from_f64), "detail": i.detail}))
        .collect();
    mixdog_js::json_stringify(&JsonValue::Array(rows))
}

/// Provider-native blocks as estimate text: an image as its size stub, any
/// other block as JSON with opaque payloads projected at their measured cost.
pub(crate) fn native_blocks_text(value: &JsonValue) -> String {
    let single = [value.clone()];
    let list: &[JsonValue] = value.as_array().map_or(&single, Vec::as_slice);
    list.iter()
        .map(|block| {
            let images = block_images(block);
            if images.is_empty() {
                mixdog_js::json_stringify(&strip_opaque_payloads(block, 0, ""))
            } else {
                image_stub_text(&images)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// isReasoningBlock.
fn is_reasoning_block(block: &JsonValue) -> bool {
    matches!(block.get("type").and_then(JsonValue::as_str), Some("thinking" | "redacted_thinking" | "reasoning"))
        || block.get("thought") == Some(&JsonValue::Bool(true))
}

fn non_empty_array(value: &JsonValue) -> Option<&Vec<JsonValue>> {
    value.as_array().filter(|a| !a.is_empty())
}

/// Prices messages. `replay_owner` is the provider whose replay envelopes the
/// session sends; another provider's envelope is never replayed.
pub struct MessageMeter<'a> {
    pub media: &'a dyn MediaMeter,
    pub replay_owner: &'a ProviderId,
}

struct Projection {
    text: String,
    /// The provider-replay piece at the end of `text`, when the message has one.
    replay: Option<String>,
    media_tokens: u64,
}

impl MessageMeter<'_> {
    fn replay_items(&self, m: &AgentMessage) -> Option<JsonValue> {
        if m.role() != Role::Assistant {
            return None;
        }
        m.message
            .replay_for(self.replay_owner)
            .map(|r| &r.items)
            .find(|items| non_empty_array(items).is_some())
            .cloned()
    }

    fn projection(&self, m: &AgentMessage) -> Projection {
        let assistant = m.role() == Role::Assistant;
        let assistant_blocks = m.message.assistant_blocks.as_ref().filter(|_| assistant);
        self.projection_with(m, self.replay_items(m), m.message.thinking_blocks.as_ref(), assistant_blocks)
    }

    /// The projection with the replay items and native block lists given instead of the
    /// message's own (the reasoning split prices the message without its reasoning blocks).
    fn projection_with(
        &self,
        m: &AgentMessage,
        replay_items: Option<JsonValue>,
        thinking_blocks: Option<&JsonValue>,
        assistant_blocks: Option<&JsonValue>,
    ) -> Projection {
        let mut media_tokens = 0;
        let mut text = match &m.message.content {
            Content::Text(text) => text.clone(),
            Content::Parts(parts) => parts
                .iter()
                .map(|part| match part {
                    // A text part without text has nothing to read and is
                    // priced as the part itself.
                    ContentPart::Text(text, _) if text.is_empty() => r#"{"type":"text","text":""}"#.to_owned(),
                    ContentPart::Text(text, _) => text.clone(),
                    other => {
                        let meter = self.media.part(other);
                        media_tokens += meter.tokens;
                        meter.text
                    }
                })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        };
        let assistant = m.role() == Role::Assistant;
        if assistant && !m.message.tool_calls.is_empty() {
            let calls: Vec<JsonValue> = m
                .message
                .tool_calls
                .iter()
                .map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments}))
                .collect();
            text.push('\n');
            text.push_str(&mixdog_js::json_stringify(&JsonValue::Array(calls)));
        }
        // Images in the native block lists bill as media whichever form
        // supplies the text.
        for blocks in [assistant_blocks, replay_items.as_ref()].into_iter().flatten() {
            media_tokens += block_images(blocks).iter().map(JsonImage::allowance).sum::<u64>();
        }
        let mut replay = None;
        if let Some(items) = &replay_items {
            let piece = native_blocks_text(items);
            text.push('\n');
            text.push_str(&piece);
            replay = Some(piece);
        } else if assistant {
            for blocks in [thinking_blocks, assistant_blocks].into_iter().flatten() {
                if non_empty_array(blocks).is_some() {
                    text.push('\n');
                    text.push_str(&native_blocks_text(blocks));
                }
            }
        }
        if m.role() == Role::Tool
            && let Some(id) = m.tool_call_id().filter(|id| !id.is_empty())
        {
            text.push('\n');
            text.push_str(id);
        }
        Projection { text, replay, media_tokens }
    }

    fn text_tokens(projection: &Projection) -> u64 {
        match &projection.replay {
            None => estimate_tokens(&projection.text),
            Some(replay) => {
                // The estimator's minimum-cost floors apply to the joined
                // string, so each half is metered on its own and the larger
                // wire projection wins.
                let base_end = projection.text.len() - replay.len() - 1;
                estimate_tokens(&projection.text[..base_end]).max(estimate_tokens(replay))
            }
        }
    }

    /// `messageEstimateText`: the text projection the meter prices (and transcript signatures hash).
    pub fn estimate_text(&self, m: &AgentMessage) -> String {
        self.projection(m).text
    }

    /// messageReasoningBreakdown(m).tokens: what the message's reasoning blocks cost inside its
    /// estimate, capped by the whole-minus-visible difference.
    pub fn reasoning_tokens(&self, m: &AgentMessage) -> u64 {
        if m.role() != Role::Assistant {
            return 0;
        }
        let split = |items: &JsonValue| -> (Vec<JsonValue>, JsonValue) {
            match items.as_array() {
                Some(list) => {
                    let (reasoning, visible): (Vec<_>, Vec<_>) = list.iter().cloned().partition(is_reasoning_block);
                    (reasoning, JsonValue::Array(visible))
                }
                None => (Vec::new(), items.clone()),
            }
        };
        let replay = self.replay_items(m);
        let array_replay = m.message.replay_for(self.replay_owner).any(|r| r.items.is_array());
        let assistant_blocks = m.message.assistant_blocks.as_ref();
        let (mut blocks, mut sent) = (Vec::new(), Vec::new());
        let (mut visible_replay, mut visible_thinking, mut visible_assistant) = (replay.clone(), m.message.thinking_blocks.clone(), assistant_blocks.cloned());
        if array_replay {
            if let Some(items) = &replay {
                let (reasoning, visible) = split(items);
                blocks.extend(reasoning.iter().cloned());
                sent = reasoning;
                visible_replay = Some(visible).filter(|v| non_empty_array(v).is_some());
            } else {
                visible_replay = None;
            }
        } else {
            for slot in [&mut visible_thinking, &mut visible_assistant] {
                if let Some(items) = slot.as_ref() {
                    let (reasoning, visible) = split(items);
                    blocks.extend(reasoning);
                    *slot = Some(visible);
                }
            }
        }
        if blocks.is_empty() {
            return 0;
        }
        if replay.is_none() {
            sent = blocks;
        }
        let priced: u64 = sent.iter().map(|b| estimate_tokens(&native_blocks_text(b))).sum();
        let whole = Self::text_tokens(&self.projection(m)) as i64;
        let visible = Self::text_tokens(&self.projection_with(m, visible_replay, visible_thinking.as_ref(), visible_assistant.as_ref())) as i64;
        priced.min((whole - visible).max(0) as u64)
    }

    /// The one per-message meter.
    pub fn message(&self, m: &AgentMessage) -> u64 {
        let projection = self.projection(m);
        Self::text_tokens(&projection) + projection.media_tokens + PER_MESSAGE_TOKENS
    }

    pub fn messages(&self, messages: &[AgentMessage]) -> u64 {
        messages.iter().map(|m| self.message(m)).sum()
    }
}
