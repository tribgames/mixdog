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
use crate::message::AgentMessage;
use crate::run::Run;

pub const IMAGE_STRIP_PLACEHOLDER: &str = "[image removed — the server could not process it; its contents are unavailable. Ask the user to re-attach the image if it is still needed.]";
const MAX_REASON_CHARS: usize = 240;

fn has_image(message: &AgentMessage) -> bool {
    matches!(message.role(), Role::User | Role::Tool)
        && matches!(&message.message.content, Content::Parts(parts)
            if parts.iter().any(|p| matches!(p, ContentPart::Image(_))))
}

/// Index of the first message of the latest turn: the one after the last
/// assistant message.
fn latest_turn_start(messages: &[AgentMessage]) -> usize {
    messages
        .iter()
        .rposition(|m| m.role() == Role::Assistant)
        .map_or(0, |i| i + 1)
}

/// Whether the latest turn carries an inline image a strip could remove.
pub(crate) fn latest_turn_has_images(messages: &[AgentMessage]) -> bool {
    messages[latest_turn_start(messages)..].iter().any(has_image)
}

/// The transcript with the latest turn's images replaced by the placeholder
/// text. A copy: a strip is local to the requests it was decided for.
pub(crate) fn without_latest_images(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    let start = latest_turn_start(messages);
    messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if i < start || !has_image(m) {
                return m.clone();
            }
            let mut stripped = m.clone();
            if let Content::Parts(parts) = &m.message.content {
                stripped.message.content = Content::Parts(
                    parts
                        .iter()
                        .map(|p| match p {
                            ContentPart::Image(_) => {
                                ContentPart::Text(IMAGE_STRIP_PLACEHOLDER.to_owned(), None)
                            }
                            other => other.clone(),
                        })
                        .collect(),
                );
            }
            stripped
        })
        .collect()
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
        }));
        self.dropped_tools.insert(
            name.clone(),
            format!(
                "tool \"{name}\" is unavailable with the current model: the provider rejected its input schema at / ({reason}), so it was left out of the request; no call was sent. Use another tool, or ask the user to fix the tool's schema or disable it."
            ),
        );
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
        let image = || ContentPart::Image(ImageSource::Url("u".into()));
        let old = AgentMessage::user_content(Content::Parts(vec![image()]));
        let fresh = AgentMessage::user_content(Content::Parts(vec![
            ContentPart::Text("look".into(), None),
            image(),
        ]));
        let messages = vec![old.clone(), AgentMessage::assistant("a", Vec::new()), fresh];
        assert!(latest_turn_has_images(&messages));
        let stripped = without_latest_images(&messages);
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