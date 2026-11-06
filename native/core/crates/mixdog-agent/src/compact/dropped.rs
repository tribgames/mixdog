//! The ids a compaction took out of the model context (Node
//! `compactionArchiveProjection` + `droppedIdentitySummary`): the stable ids of
//! the messages whose text left, and the tool calls that left, in `before`
//! order. The log keeps every pre-compaction item; these ids tell the store
//! which rows to show as archived.

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_js::js_trim;
use mixdog_protocol::message_class::messages_shown;
use mixdog_protocol::message_class::user_text::UserText;
use serde_json::Value;

use super::execution_tail::MessageRows;
use crate::env::Dropped;
use crate::message::AgentMessage;

/// The session's sensitive-value redaction of stored rows (Node `_messagesForDisk`), applied
/// before the transcript decides what a row shows. The composition implements it over the
/// sensitive store.
pub trait Redactor: Send + Sync {
    fn redact(&self, rows: Vec<Value>) -> Vec<Value>;
}

/// The stored row of a kept message that lost part of itself: Node's projection copy keeps
/// every field of the row but `toolCalls`, re-adding only the lost calls, and holds the text
/// only when it was lost.
fn lost_part_row(mut row: Value, lost_text: bool, lost_calls: &[ToolCall]) -> Value {
    let Some(fields) = row.as_object_mut() else {
        return row;
    };
    let calls = fields.remove("toolCalls").or_else(|| fields.remove("tool_calls"));
    if !lost_text {
        fields.insert("content".into(), Value::String(String::new()));
    }
    if !lost_calls.is_empty() {
        let kept = calls.as_ref().and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let lost: Vec<Value> = kept
            .iter()
            .filter(|call| call.get("id").and_then(Value::as_str).is_some_and(|id| lost_calls.iter().any(|l| l.id == id)))
            .cloned()
            .collect();
        fields.insert("toolCalls".into(), Value::Array(lost));
    }
    row
}

/// What left the context, as the archive projection holds it.
struct Projection {
    /// Dropped messages, and for a kept message that lost something, the lost part.
    messages: Vec<AgentMessage>,
    /// The stored row of each projected message, as the store keeps it on disk.
    rows: Vec<Value>,
    text_ids: Vec<String>,
}

fn has_text(content: &Content) -> bool {
    match content {
        Content::Text(text) => !js_trim(text).is_empty(),
        Content::Parts(parts) => {
            parts.iter().any(|part| matches!(part, ContentPart::Text(text) if !js_trim(text).is_empty()))
        }
    }
}

fn push_unique(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|existing| existing == id) {
        list.push(id.to_owned());
    }
}

/// Node's `droppedMessages` (messages with an id absent from `after`) and `droppedIdentities`,
/// reported only when the transcript shows a row for what left (`prepareCompactionArchive`
/// returns null otherwise, so Node reports 0 and null). The rows are redacted first and then
/// classified by the transcript's own visibility rule.
pub fn dropped_summary(
    before: &[AgentMessage],
    after: &[AgentMessage],
    stored: &dyn MessageRows,
    redactor: &dyn Redactor,
    text: &mut UserText<'_>,
) -> (u64, Option<Dropped>) {
    let projection = projection(before, after, stored);
    let rows = redactor.redact(projection.rows.clone());
    if !messages_shown(&rows, text).into_iter().any(|shown| shown) {
        return (0, None);
    }
    let count = before
        .iter()
        .filter_map(|m| m.message_id.as_deref().filter(|id| !id.is_empty()))
        .filter(|id| !after.iter().any(|copy| copy.message_id.as_deref() == Some(*id)))
        .count();
    (count as u64, Some(identities(&projection)))
}

/// `droppedIdentitySummary`: the ids whose text rows left, and the calls that left.
fn identities(projection: &Projection) -> Dropped {
    let mut call_ids: Vec<String> = Vec::new();
    for message in &projection.messages {
        for call in message.tool_calls().iter().map(|call: &ToolCall| call.id.as_str()).filter(|c| !c.is_empty()) {
            push_unique(&mut call_ids, call);
        }
        if message.message.role == Role::Tool
            && let Some(result) = message.message.tool_call_id.as_deref().filter(|r| !r.is_empty())
        {
            push_unique(&mut call_ids, result);
        }
    }
    let mut message_ids: Vec<String> = Vec::new();
    for id in &projection.text_ids {
        push_unique(&mut message_ids, id);
    }
    Dropped { message_ids, call_ids }
}

/// `compactionArchiveProjection`, in `before` order.
fn projection(before: &[AgentMessage], after: &[AgentMessage], stored: &dyn MessageRows) -> Projection {
    let mut messages = Vec::new();
    let mut rows = Vec::new();
    let mut text_ids = Vec::new();
    for message in before {
        let Some(id) = message.message_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let copies: Vec<&AgentMessage> =
            after.iter().filter(|copy| copy.message_id.as_deref() == Some(id)).collect();
        if copies.is_empty() {
            messages.push(message.clone());
            rows.push(stored.row(message));
            text_ids.push(id.to_owned());
            continue;
        }
        let lost: Vec<ToolCall> = message
            .tool_calls()
            .iter()
            .filter(|call| !call.id.is_empty())
            .filter(|call| !copies.iter().any(|copy| copy.tool_calls().iter().any(|k| k.id == call.id)))
            .cloned()
            .collect();
        let lost_text =
            has_text(&message.message.content) && !copies.iter().any(|copy| has_text(&copy.message.content));
        if lost.is_empty() && !lost_text {
            continue;
        }
        if lost_text {
            text_ids.push(id.to_owned());
        }
        let mut part = message.clone();
        if !lost_text {
            part.message.content = Content::Text(String::new());
        }
        rows.push(lost_part_row(stored.row(message), lost_text, &lost));
        part.message.tool_calls = lost;
        messages.push(part);
    }
    Projection { messages, rows, text_ids }
}
