//! Recoveries that change the request instead of repeating it, on the typed
//! rejection kinds the adapters classify: an image the provider refuses, a
//! replay block it refuses to take back, and a tool schema it refuses. Each is
//! tried once; the deterministic refusal otherwise surfaces.

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::JsonValue;

use crate::env::RunEvent;
use crate::env::Stage;
use crate::env::Tone;
use crate::message::AgentMessage;
use crate::run::Run;

pub const IMAGE_STRIP_PLACEHOLDER: &str = "[image removed — the server could not process it; its contents are unavailable. Ask the user to re-attach the image if it is still needed.]";
const MAX_REASON_CHARS: usize = 240;

/// `partLooksLikeImage`: an inline image, or a stored one (`{type: "image",
/// attachmentRef}` reads back as an image-typed file reference).
fn is_image(part: &ContentPart) -> bool {
    match part {
        ContentPart::Image(_) => true,
        ContentPart::File { mime_type, text: None, .. } => mime_type.starts_with("image/"),
        _ => false,
    }
}

/// Index of the first message of the latest turn: the one after the last
/// assistant message.
fn latest_turn_start(messages: &[AgentMessage]) -> usize {
    messages
        .iter()
        .rposition(|m| m.role() == Role::Assistant)
        .map_or(0, |i| i + 1)
}

/// An image-strip retry (`state.imageStrip`): the images it leaves out of
/// every request until a send succeeds, and whether that success heals them
/// out of the transcript.
#[derive(Clone, Debug)]
pub(crate) struct ImageStrip {
    ids: Vec<ContentPart>,
    pub(crate) persist: bool,
}

/// `stripInlineImages`: the user and tool messages from `start` with every
/// image (only those in `ids`, when given) replaced by the placeholder text,
/// and the distinct images it replaced. A copy.
fn strip_images(
    messages: &[AgentMessage],
    start: usize,
    ids: Option<&[ContentPart]>,
) -> (Vec<AgentMessage>, Vec<ContentPart>) {
    let mut stripped_ids: Vec<ContentPart> = Vec::new();
    let next = messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let Content::Parts(parts) = &m.message.content else { return m.clone() };
            if i < start || !matches!(m.role(), Role::User | Role::Tool) {
                return m.clone();
            }
            let mut changed = false;
            let content = parts
                .iter()
                .map(|p| {
                    if !is_image(p) || ids.is_some_and(|ids| !ids.contains(p)) {
                        return p.clone();
                    }
                    changed = true;
                    if !stripped_ids.contains(p) {
                        stripped_ids.push(p.clone());
                    }
                    ContentPart::Text(IMAGE_STRIP_PLACEHOLDER.to_owned(), None)
                })
                .collect();
            let mut out = m.clone();
            if changed {
                out.message.content = Content::Parts(content);
            }
            out
        })
        .collect();
    (next, stripped_ids)
}

/// `stripInlineImagesFromLatestTurn` + `persistsConfirmedImageRejection`: the
/// strip of the latest turn's images, healed out of the transcript on success
/// only when a confirmed rejection names exactly one distinct image. `None`
/// when the latest turn has no image.
pub(crate) fn latest_turn_strip(messages: &[AgentMessage], error: &ProviderError) -> Option<ImageStrip> {
    let (_, ids) = strip_images(messages, latest_turn_start(messages), None);
    if ids.is_empty() {
        return None;
    }
    let persist = confirmed_image_rejection(error) && ids.len() == 1;
    Some(ImageStrip { ids, persist })
}

/// The transcript with the strip's images replaced by the placeholder text,
/// wherever they occur (`stripInlineImages(messages, { ids })`).
pub(crate) fn with_images_stripped(messages: &[AgentMessage], strip: &ImageStrip) -> Vec<AgentMessage> {
    strip_images(messages, 0, Some(&strip.ids)).0
}

fn error_code(error: &ProviderError) -> String {
    error.code.as_deref().map(|c| c.trim().to_lowercase()).unwrap_or_default()
}

/// `isInvalidImageCode`.
fn is_invalid_image_code(code: &str) -> bool {
    matches!(code, "invalid_image" | "invalid-image")
}

fn says_invalid_image(error: &ProviderError) -> bool {
    error.message.to_lowercase().contains("does not represent a valid image")
}

/// `isImageProcessingError`: a refusal an image explains (413, an invalid-image
/// code, or the 400/500 texts the providers send for an image they cannot read).
/// No adapter classifies these as [`ErrorKind::ImageRejected`], so the status,
/// code and message decide here, as Node's loop decides.
pub(crate) fn is_image_processing_error(error: &ProviderError) -> bool {
    use mixdog_core_api::domain::provider::ErrorKind;
    if error.kind == ErrorKind::ImageRejected || error.status == Some(413) || is_invalid_image_code(&error_code(error)) {
        return true;
    }
    matches!(error.status, Some(400 | 500))
        && (error.message.contains("Could not process image") || says_invalid_image(error))
}

/// `confirmedImageRejection`.
fn confirmed_image_rejection(error: &ProviderError) -> bool {
    error.status == Some(400) && (is_invalid_image_code(&error_code(error)) || says_invalid_image(error))
}

fn is_thinking_block(block: &JsonValue) -> bool {
    matches!(
        block.get("type").and_then(JsonValue::as_str),
        Some("thinking" | "redacted_thinking")
    )
}

fn is_empty_text_block(block: &JsonValue) -> bool {
    block.get("type").and_then(JsonValue::as_str) == Some("text")
        && block.get("text").and_then(JsonValue::as_str).is_none_or(str::is_empty)
}

fn kept_blocks(list: &[JsonValue]) -> Option<Vec<JsonValue>> {
    let kept: Vec<JsonValue> = list
        .iter()
        .filter(|b| !is_thinking_block(b) && !is_empty_text_block(b))
        .cloned()
        .collect();
    (kept.len() != list.len()).then_some(kept)
}

/// A replay-free copy of one assistant message, or `None` when it carries
/// nothing the API could have objected to. `owner` is the provider whose
/// replay envelopes are kept (another provider's are never replayed here).
fn without_thinking_replay(
    message: &AgentMessage,
    owner: &mixdog_protocol::ProviderId,
) -> Option<AgentMessage> {
    if message.role() != Role::Assistant {
        return None;
    }
    let mut changed = false;
    let mut next = Message::new(message.message.role, message.message.content.clone());
    next.cache_tier = message.message.cache_tier;
    next.tool_calls = message.message.tool_calls.clone();
    next.tool_call_id = message.message.tool_call_id.clone();
    next.is_error = message.message.is_error;
    next.phase = message.message.phase;
    next.native_tool_search = message.message.native_tool_search.clone();
    next.source = message.message.source;
    next.assistant_blocks = message.message.assistant_blocks.clone();
    next.thinking_blocks = message.message.thinking_blocks.clone();
    for envelope in message.message.replay_for(owner) {
        let mut envelope = envelope.clone();
        if let Some(items) = envelope.items.as_array().and_then(|i| kept_blocks(i)) {
            changed = true;
            envelope.items = JsonValue::Array(items);
        }
        // An envelope with nothing left has nothing to replay verbatim; the
        // flattened content and tool calls take over.
        if envelope.items.as_array().is_none_or(|i| !i.is_empty()) {
            next.push_replay(envelope);
        }
    }
    if let Some(kept) = message
        .message
        .assistant_blocks
        .as_ref()
        .and_then(JsonValue::as_array)
        .and_then(|b| kept_blocks(b))
    {
        changed = true;
        next.assistant_blocks = (!kept.is_empty()).then_some(JsonValue::Array(kept));
    }
    if next
        .thinking_blocks
        .as_ref()
        .and_then(JsonValue::as_array)
        .is_some_and(|b| !b.is_empty())
    {
        changed = true;
        next.thinking_blocks = None;
    }
    changed.then(|| {
        let mut repaired = message.clone();
        repaired.message = next;
        repaired
    })
}

impl Run {
    /// Drops the reasoning replay from the newest assistant turn that carries
    /// it, in place, so the fix is persisted and the turn cannot poison later
    /// requests. `true` when a turn was repaired.
    pub(crate) fn repair_thinking_replay(&mut self) -> bool {
        let owner = self.provider.id().clone();
        for index in (0..self.messages.len()).rev() {
            if let Some(repaired) = without_thinking_replay(&self.messages[index], &owner) {
                self.messages[index] = repaired;
                self.env.sink.replace(&self.messages, &crate::env::Rewrite::default());
                return true;
            }
        }
        false
    }

    /// The rejected tool of a `ToolSchemaRejected` error, when it names one of
    /// the request's own tools.
    fn rejected_tool(&self, error: &ProviderError) -> Option<String> {
        let name = error.rejected_tool.as_deref()?;
        self.tools.get(name).map(|t| t.spec().name.clone())
    }

    /// Leaves the rejected tool out of this run's later requests and tells the
    /// user once. `true` when a tool was dropped.
    pub(crate) fn drop_rejected_tool(&mut self, error: &ProviderError) -> bool {
        let Some(name) = self.rejected_tool(error) else {
            return false;
        };
        let detail: String = mixdog_js::js_words(&error.message).collect::<Vec<_>>().join(" ");
        let detail: String = detail.chars().take(MAX_REASON_CHARS).collect();
        let reason = format!("the provider rejected it with HTTP 400: {detail}");
        self.emit(RunEvent::Stage(Stage::Notice {
            message: format!(
                "Tool \"{name}\" was excluded from this session's requests: its input schema is invalid at / ({reason}). Fix the tool's schema or disable the tool."
            ),
            tone: Tone::Warn,
        }));
        self.dropped_tools.insert(
            name.clone(),
            format!(
                "tool \"{name}\" is unavailable with the current model: the provider rejected its input schema at / ({reason}), so it was left out of the request; no call was sent. Use another tool, or ask the user to fix the tool's schema or disable it."
            ),
        );
        // The surface is rebuilt around the change (`send-phase.mjs`, `retry_tool_schema_drop`).
        self.fixed_surface = None;
        true
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use mixdog_core_api::domain::provider::ImageSource;

    #[test]
    fn latest_turn_images_become_the_placeholder_and_history_is_untouched() {
        let image = |u: &str| ContentPart::Image(ImageSource::Url(u.into()));
        let old = AgentMessage::user_content(Content::Parts(vec![image("old")]));
        let fresh = AgentMessage::user_content(Content::Parts(vec![
            ContentPart::Text("look".into(), None),
            image("new"),
        ]));
        let messages = vec![old.clone(), AgentMessage::assistant("a", Vec::new()), fresh];
        let error = ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::ImageRejected,
            mixdog_core_api::domain::provider::DeliveryState::Accepted,
        );
        let strip = latest_turn_strip(&messages, &error).unwrap();
        assert!(!strip.persist, "an unconfirmed rejection stays request-local");
        let stripped = with_images_stripped(&messages, &strip);
        assert_eq!(stripped[0], old);
        assert_eq!(
            stripped[2].message.content,
            Content::Parts(vec![
                ContentPart::Text("look".into(), None),
                ContentPart::Text(IMAGE_STRIP_PLACEHOLDER.into(), None),
            ])
        );
    }

    #[test]
    fn thinking_and_empty_text_blocks_are_dropped_from_the_turn() {
        let mut assistant = AgentMessage::assistant("t", Vec::new());
        assistant.message.assistant_blocks = Some(json!([
            {"type": "thinking", "thinking": "x"},
            {"type": "text", "text": ""},
            {"type": "text", "text": "kept"},
        ]));
        let owner = mixdog_protocol::ProviderId::from("p");
        let repaired = without_thinking_replay(&assistant, &owner).unwrap();
        assert_eq!(
            repaired.message.assistant_blocks,
            Some(json!([{"type": "text", "text": "kept"}]))
        );
        let clean = AgentMessage::assistant("t", Vec::new());
        assert!(without_thinking_replay(&clean, &owner).is_none());
    }
}

/// `stripProviderReplayMessage`: the message without provider-native replay state (replay
/// envelopes, thinking and ordered native blocks). It belongs to the provider that produced it; a
/// route change drops it, and what the next provider needs (text, tool calls and their results, in
/// order) stays.
pub fn strip_provider_replay(message: &mixdog_core_api::domain::provider::Message) -> mixdog_core_api::domain::provider::Message {
    use mixdog_core_api::domain::provider::Message;
    if message.provider_replay().is_empty() && message.thinking_blocks.is_none() && message.assistant_blocks.is_none() {
        return message.clone();
    }
    let mut plain = Message::new(message.role, message.content.clone());
    plain.cache_tier = message.cache_tier;
    plain.tool_calls = message.tool_calls.clone();
    plain.tool_call_id = message.tool_call_id.clone();
    plain.is_error = message.is_error;
    plain.phase = message.phase;
    plain.native_tool_search = message.native_tool_search.clone();
    plain.source = message.source;
    plain.turn_reminder = message.turn_reminder.clone();
    plain
}

/// `stripProviderReplayMessages`.
pub fn strip_provider_replay_messages(messages: &[mixdog_core_api::domain::provider::Message]) -> Vec<mixdog_core_api::domain::provider::Message> {
    messages.iter().map(strip_provider_replay).collect()
}

impl Run {
    /// A route change drops every provider-native replay state from the live turn's messages, in
    /// place, so the next provider never gets another one's envelopes.
    pub(crate) fn strip_replay_for_new_route(&mut self) {
        let stripped = strip_provider_replay_messages(&self.messages.iter().map(|m| m.message.clone()).collect::<Vec<_>>());
        for (message, stripped) in self.messages.iter_mut().zip(stripped) {
            message.message = stripped;
        }
        self.env.sink.replace(&self.messages, &crate::env::Rewrite::default());
    }
}