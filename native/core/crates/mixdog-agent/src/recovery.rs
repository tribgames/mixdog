//! Recoveries that change the request instead of repeating it, on the typed
//! rejection kinds the adapters classify: a replay block the provider refuses to
//! take back, and a tool schema it refuses. Each is tried once; the deterministic
//! refusal otherwise surfaces. An image is never one of them: no image is removed
//! or replaced by text to get a request through (an image the destination cannot
//! take is refused before sending, with local recovery actions the user picks).

use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::JsonValue;

use crate::env::RunEvent;
use crate::env::Stage;
use crate::env::Tone;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::run::Run;

const MAX_REASON_CHARS: usize = 240;

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

fn has_thinking(blocks: Option<&JsonValue>) -> bool {
    blocks.and_then(JsonValue::as_array).is_some_and(|b| b.iter().any(is_thinking_block))
}

/// Whether the assistant turn carries Anthropic signed thinking, in any of the
/// places a turn records it. Another provider's replay never matches.
pub(crate) fn has_signed_thinking(message: &AgentMessage) -> bool {
    message.role() == Role::Assistant
        && (message.message.thinking_blocks.as_ref().and_then(JsonValue::as_array).is_some_and(|b| !b.is_empty())
            || has_thinking(message.message.assistant_blocks.as_ref())
            || message.message.provider_replay().iter().any(|r| has_thinking(Some(&r.items))))
}

/// A replay-free copy of one assistant message, or `None` when it carries
/// nothing the API could have objected to. Only thinking and empty text blocks
/// are removed; every other recorded form (another provider's envelope,
/// Gemini metadata) stays as it was.
pub(crate) fn without_thinking_replay(message: &AgentMessage) -> Option<AgentMessage> {
    if message.role() != Role::Assistant {
        return None;
    }
    let mut changed = false;
    let mut next = message.message.clone();
    next.clear_recorded_form();
    next.gemini_metadata = message.message.gemini_metadata.clone();
    next.assistant_blocks = message.message.assistant_blocks.clone();
    next.thinking_blocks = message.message.thinking_blocks.clone();
    for envelope in message.message.provider_replay() {
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
        repaired.stored = message.stored.as_ref().map(|row| {
            let mut row = (**row).clone();
            row.shift_remove("thinkingBlocks");
            if let Some(JsonValue::Array(blocks)) = row.get_mut("assistantBlocks") {
                blocks.retain(|b| !is_thinking_block(b) && !is_empty_text_block(b));
            }
            if let Some(JsonValue::Array(items)) = row.get_mut("providerReplay").and_then(|r| r.get_mut("items")) {
                items.retain(|b| !is_thinking_block(b) && !is_empty_text_block(b));
            }
            std::sync::Arc::new(row)
        });
        repaired
    })
}

/// Everything a message puts on the wire, recorded replay included: what a
/// later signature covers.
fn visible(m: &AgentMessage) -> mixdog_core_api::domain::provider::Message {
    crate::project::project_for_wire(std::slice::from_ref(m)).remove(0)
}

/// The trailing tool round: its first message and its newest assistant turn,
/// when that turn made calls.
fn open_round(messages: &[AgentMessage]) -> Option<(usize, usize)> {
    let latest = messages.iter().rposition(|m| m.role() == Role::Assistant)?;
    if messages[latest].tool_calls().is_empty() {
        return None;
    }
    let mut start = latest;
    while start > 0 && matches!(messages[start - 1].role(), Role::Assistant | Role::Tool) {
        start -= 1;
    }
    Some((start, latest))
}

/// After a rewrite of `original` into `messages` (the request that is sent
/// next): signed thinking is kept only before the first difference on the
/// wire, where the prefix it was signed over is unchanged. The trailing tool
/// round is ended when it lost thinking here, or when a signed step of the
/// original's open round is not kept unchanged (omitted or rewritten by an
/// earlier edit). `true` when a turn changed.
pub(crate) fn rebind_thinking(original: &[AgentMessage], messages: &mut Vec<AgentMessage>) -> bool {
    let from = messages
        .iter()
        .zip(original)
        .position(|(kept, was)| visible(kept) != visible(was))
        .unwrap_or(messages.len().min(original.len()));
    // Up to `from` the result is the original message for message; a signed step from there on is gone or changed.
    let round_lost = open_round(original)
        .is_some_and(|(start, latest)| (start.max(from)..=latest).any(|i| has_signed_thinking(&original[i])));
    drop_stale_thinking(messages, from, round_lost, false)
}

/// Repairs a transcript whose request the provider refused over its reasoning
/// replay, in place: signed thinking goes from the newest compaction marker on,
/// or from the whole transcript when there is none, and an open tool round is
/// always ended (the rejection's own index can point past the transcript row
/// it concerns, so the thinking a round would continue from is not trusted).
/// `true` when a turn changed.
pub(crate) fn repair_rejected_thinking(messages: &mut Vec<AgentMessage>) -> bool {
    let from = messages
        .iter()
        .rposition(|m| matches!(m.source, Some(Source::CompactExecutionRecovery | Source::CompactSummary)))
        .unwrap_or(0);
    drop_stale_thinking(messages, from, true, true)
}

/// Drops the signed thinking of every assistant turn from `from` on, in place:
/// those turns follow a prefix that was rewritten, which the signatures are
/// bound to. A turn before `from` keeps its blocks. The trailing tool round is
/// ended (see [`end_open_round`]) when it lost thinking here or `end_round`.
/// `repair`: a send is in progress, so empty text blocks go too and the ended
/// round is continued by a user turn. `true` when a turn changed.
pub(crate) fn drop_stale_thinking(messages: &mut Vec<AgentMessage>, from: usize, end_round: bool, repair: bool) -> bool {
    let mut stripped = Vec::new();
    let mut changed = false;
    for (index, message) in messages.iter_mut().enumerate().skip(from) {
        let had = has_signed_thinking(message);
        if !had && !repair {
            continue;
        }
        if let Some(repaired) = without_thinking_replay(message) {
            *message = repaired;
            changed = true;
            if had {
                stripped.push(index);
            }
        }
    }
    let ended = end_open_round(messages, end_round, &stripped, repair);
    changed || ended
}

/// A tool round whose thinking was dropped can no longer be continued: the
/// API wants the final turn of a round to start with its thinking. It is ended
/// by a context ack after its last tool result, so the next request opens a
/// new turn. `continue_round`: nothing follows the round yet (a send in
/// progress), so the user's continuation closes the new turn as well, since a
/// request must not end on an assistant turn. The round is ended when `force`,
/// or when one of the `stripped` turns is in it. `true` when it was ended.
pub(crate) fn end_open_round(messages: &mut Vec<AgentMessage>, force: bool, stripped: &[usize], continue_round: bool) -> bool {
    let Some((start, latest)) = open_round(messages) else {
        return false;
    };
    if !force && !stripped.iter().any(|index| *index >= start) {
        return false;
    }
    let mut end = latest + 1;
    while messages.get(end).is_some_and(|m| m.role() == Role::Tool) {
        end += 1;
    }
    let ends_here = end == messages.len();
    messages.insert(end, crate::compact::messages::context_ack_message());
    if continue_round && ends_here {
        messages.push(crate::compact::fresh::active_turn_continuation_message());
    }
    true
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn thinking_and_empty_text_blocks_are_dropped_from_the_turn() {
        let mut assistant = AgentMessage::assistant("t", Vec::new());
        assistant.message.assistant_blocks = Some(json!([
            {"type": "thinking", "thinking": "x"},
            {"type": "text", "text": ""},
            {"type": "text", "text": "kept"},
        ]));
        let repaired = without_thinking_replay(&assistant).unwrap();
        assert_eq!(
            repaired.message.assistant_blocks,
            Some(json!([{"type": "text", "text": "kept"}]))
        );
        let clean = AgentMessage::assistant("t", Vec::new());
        assert!(without_thinking_replay(&clean).is_none());
    }

    fn signed_call(id: &str) -> AgentMessage {
        let call = mixdog_core_api::domain::provider::ToolCall {
            id: id.to_owned(),
            name: "read".to_owned(),
            arguments: json!({ "path": "a" }),
            native_type: None,
        };
        let mut assistant = AgentMessage::assistant("", vec![call]);
        assistant.message.thinking_blocks = Some(json!([{"type": "thinking", "thinking": "t", "signature": "sig"}]));
        assistant
    }

    fn result(id: &str) -> AgentMessage {
        AgentMessage::tool_result(id, mixdog_core_api::domain::provider::Content::Text("ok".into()), crate::message::ToolKind::Normal)
    }

    fn recovery_marker() -> AgentMessage {
        AgentMessage::sourced(Source::CompactExecutionRecovery, "reminder")
    }

    /// The Anthropic Messages request these messages become.
    fn wire(messages: &[AgentMessage]) -> serde_json::Value {
        wire_for("claude-sonnet-4-6", messages)
    }

    /// [`wire`] for `model` (a model taking turn-scoped system messages re-sends each turn's reminder).
    fn wire_for(model: &str, messages: &[AgentMessage]) -> serde_json::Value {
        use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor};
        use mixdog_core_api::domain::provider::{ModelRequest, RequestOptions, WireCodec};
        let codec = AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(std::sync::Arc::new(|_: &str| None)));
        let request = ModelRequest {
            model: model.into(),
            messages: messages.iter().map(|m| m.message.clone()).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let wire = codec.encode(&request).expect("encodes");
        serde_json::from_slice(&wire.body).expect("a JSON body")
    }

    fn roles(body: &serde_json::Value) -> Vec<&str> {
        body["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect()
    }

    /// Regression (#371): a turn reminder is re-sent as a system message before the signed turn, so
    /// the `messages.2` a rejection names is that turn although transcript row 2 is its tool result.
    /// With no compaction marker the repair strips every signed block and ends the open round.
    #[test]
    fn a_rejection_after_an_inserted_turn_reminder_still_repairs_the_signed_turn() {
        let mut signed = signed_call("c1");
        signed.message.turn_reminder = Some("<system-reminder>todo</system-reminder>".into());
        let mut messages = vec![AgentMessage::user("go"), signed, result("c1")];
        // A first-party model that takes turn-scoped system messages (`with_turn_reminders`).
        let model = "claude-sonnet-5-5";
        assert_eq!(roles(&wire_for(model, &messages)), ["user", "system", "assistant", "user"]);
        assert_eq!(roles(&wire_for(model, &messages))[2], "assistant", "the reminder shifts the signed turn to messages.2");
        assert!(repair_rejected_thinking(&mut messages));
        assert!(messages.iter().all(|m| !has_signed_thinking(m)));
        let body = wire_for(model, &messages);
        assert!(!body.to_string().contains("\"thinking\""), "{body}");
        assert_eq!(roles(&body).last(), Some(&"user"), "{body}");
        let sent = body["messages"].as_array().unwrap();
        // The turn-scoped layout sends string content as one text block.
        assert_eq!(sent[sent.len() - 2]["content"][0]["text"], ".", "the round is ended: {body}");
    }

    /// The repair always ends an open round, even when the rejected turn carried no signed block.
    #[test]
    fn a_repair_ends_the_open_round_even_without_signed_thinking() {
        let mut messages = vec![
            AgentMessage::user("go"),
            AgentMessage::assistant("", signed_call("c1").message.tool_calls.clone()),
            result("c1"),
        ];
        assert!(repair_rejected_thinking(&mut messages));
        let body = wire(&messages);
        assert_eq!(roles(&body), ["user", "assistant", "user", "assistant", "user"], "{body}");
        assert_eq!(body["messages"][3]["content"], ".", "{body}");
    }

    /// A stuck session whose open tool round holds signed thinking bound to the rewritten prefix: the
    /// rebuilt request carries none, closes the round, and every tool use still meets its result.
    #[test]
    fn a_stuck_open_round_is_rebuilt_as_a_request_anthropic_accepts() {
        let mut messages = vec![recovery_marker(), AgentMessage::user("go"), signed_call("c1"), result("c1")];
        assert!(drop_stale_thinking(&mut messages, 0, false, true));
        let body = wire(&messages);
        assert!(!body.to_string().contains("\"thinking\""), "{body}");
        assert_eq!(roles(&body), ["user", "user", "assistant", "user", "assistant", "user"], "{body}");
        let sent = body["messages"].as_array().unwrap();
        assert_eq!(sent[2]["content"][0]["id"], sent[3]["content"][0]["tool_use_id"]);
        assert_eq!(sent[4]["content"], ".");
    }

    /// Turns before the rewritten prefix are valid as they are; an earlier step of the round
    /// that carried the only thinking still ends the round.
    #[test]
    fn turns_before_the_rewrite_keep_their_thinking() {
        let mut messages = vec![
            AgentMessage::user("first"),
            signed_call("old"),
            result("old"),
            recovery_marker(),
            AgentMessage::user("go"),
            signed_call("c1"),
            result("c1"),
            AgentMessage::assistant("", vec![signed_call("c2").message.tool_calls[0].clone()]),
            result("c2"),
        ];
        assert!(drop_stale_thinking(&mut messages, 3, false, true));
        assert!(messages[1].message.thinking_blocks.is_some(), "the unchanged prefix is intact");
        assert!(messages[5].message.thinking_blocks.is_none());
        let body = wire(&messages);
        assert_eq!(roles(&body).last(), Some(&"user"), "{body}");
        let last_assistant = body["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "assistant").unwrap();
        assert_eq!(last_assistant["content"], ".", "{body}");
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
    /// Drops the reasoning replay a rejection can concern (see
    /// [`repair_rejected_thinking`]), in place, so the fix is persisted and no
    /// turn can poison later requests. `true` when a turn was repaired.
    pub(crate) fn repair_thinking_replay(&mut self) -> bool {
        let repaired_any = repair_rejected_thinking(&mut self.messages);
        if repaired_any {
            self.env.sink.replace(&self.messages, &crate::env::Rewrite::default());
        }
        repaired_any
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
