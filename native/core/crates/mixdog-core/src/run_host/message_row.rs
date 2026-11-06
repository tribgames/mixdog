//! The stored Node-shaped row of a model message (FORMAT.md §5.2 `item.body`) and the agent's
//! typed message, both ways.
//!
//! Covered: role, text or text/image/file content, `toolCalls`, `toolCallId`, `isError`,
//! `stopReason`, `turnReminder`, `reasoning`, `uiDiff` and the `messageId` (`meta.transcript`).
//! Not covered (listed in the factory's gaps): provider replay envelopes and thinking blocks,
//! `Source`, `ToolKind`, the effort snapshot, native call item types, tool-result media parts.

use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::{Content, ContentPart, ImageSource, BinarySource, Role, StopReason, ToolCall};
use serde_json::{json, Map, Value};

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Developer => "developer",
    }
}

fn role_of(name: &str) -> Option<Role> {
    Some(match name {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        "developer" => Role::Developer,
        _ => return None,
    })
}

/// Node's `stopReason` spelling.
fn stop_name(stop: &StopReason) -> String {
    match stop {
        StopReason::EndTurn => "end_turn".to_owned(),
        StopReason::ToolUse => "tool_use".to_owned(),
        StopReason::MaxTokens => "max_tokens".to_owned(),
        StopReason::StopSequence => "stop_sequence".to_owned(),
        StopReason::ContentFilter => "content_filter".to_owned(),
        StopReason::Refusal => "refusal".to_owned(),
        StopReason::ContinueTurn => "end_turn_false".to_owned(),
        StopReason::Other(value) => value.clone(),
    }
}

fn stop_of(name: &str) -> StopReason {
    match name {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "content_filter" => StopReason::ContentFilter,
        "refusal" => StopReason::Refusal,
        "end_turn_false" => StopReason::ContinueTurn,
        other => StopReason::Other(other.to_owned()),
    }
}

fn part_row(part: &ContentPart) -> Option<Value> {
    Some(match part {
        ContentPart::Text(text, reference) => {
            let mut row = json!({ "type": "text", "text": text });
            if let Some(meta) = reference {
                row["attachmentReference"] = Value::Object(meta.clone());
            }
            row
        }
        ContentPart::Image(ImageSource::Base64 { data, mime_type }) => json!({ "type": "image", "data": data, "mimeType": mime_type }),
        ContentPart::File { source: BinarySource::Base64(data), mime_type, filename, text: None } => {
            let mut row = json!({ "type": "file", "data": data, "mimeType": mime_type });
            if let Some(name) = filename {
                row["filename"] = json!(name);
            }
            row
        }
        _ => return None,
    })
}

fn part_of(row: &Value) -> Option<ContentPart> {
    let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    match row.get("type").and_then(Value::as_str)? {
        "text" => Some(ContentPart::Text(text("text")?, row.get("attachmentReference").and_then(Value::as_object).cloned())),
        "image" => Some(ContentPart::Image(ImageSource::Base64 { data: text("data")?, mime_type: text("mimeType")? })),
        "file" => Some(ContentPart::File { source: BinarySource::Base64(text("data")?), mime_type: text("mimeType")?, filename: text("filename"), text: None }),
        _ => None,
    }
}

/// The stored row of `message`.
pub fn row_of(message: &AgentMessage) -> Value {
    let m = &message.message;
    let mut row = Map::new();
    row.insert("role".into(), json!(role_name(m.role)));
    row.insert(
        "content".into(),
        match &m.content {
            Content::Text(text) => json!(text),
            Content::Parts(parts) => Value::Array(parts.iter().filter_map(part_row).collect()),
        },
    );
    if !m.tool_calls.is_empty() {
        row.insert("toolCalls".into(), Value::Array(m.tool_calls.iter().map(|c| json!({ "id": c.id, "name": c.name, "arguments": c.arguments })).collect()));
    }
    if let Some(id) = &m.tool_call_id {
        row.insert("toolCallId".into(), json!(id));
    }
    if m.is_error {
        row.insert("isError".into(), json!(true));
    }
    if let Some(stop) = &message.stop_reason {
        row.insert("stopReason".into(), json!(stop_name(stop)));
    }
    if let Some(text) = message.turn_reminder.as_ref().filter(|t| !t.is_empty()) {
        row.insert("turnReminder".into(), json!(text));
    }
    if let Some(text) = message.reasoning.as_ref().filter(|t| !t.is_empty()) {
        row.insert("reasoning".into(), json!(text));
    }
    if let Some(diff) = &message.ui_diff {
        row.insert("uiDiff".into(), json!(diff));
    }
    if let Some(id) = &message.message_id {
        row.insert("meta".into(), json!({ "transcript": { "messageId": id } }));
    }
    Value::Object(row)
}

/// The message a stored row holds; `None` for a row of a shape this does not cover (a role it
/// does not know, a content part it cannot hold).
pub fn message_of(row: &Value) -> Option<AgentMessage> {
    let role = role_of(row.get("role")?.as_str()?)?;
    let content = match row.get("content") {
        Some(Value::String(text)) => Content::Text(text.clone()),
        Some(Value::Array(parts)) => Content::Parts(parts.iter().map(part_of).collect::<Option<Vec<_>>>()?),
        None | Some(Value::Null) => Content::Text(String::new()),
        Some(_) => return None,
    };
    let mut message = AgentMessage::user_content(content);
    message.message.role = role;
    for call in row.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
        message.message.tool_calls.push(ToolCall {
            id: call.get("id")?.as_str()?.to_owned(),
            name: call.get("name")?.as_str()?.to_owned(),
            arguments: call.get("arguments").cloned().unwrap_or(Value::Null),
            native_type: None,
        });
    }
    message.message.tool_call_id = row.get("toolCallId").and_then(Value::as_str).map(str::to_owned);
    message.message.is_error = row.get("isError").and_then(Value::as_bool) == Some(true);
    message.stop_reason = row.get("stopReason").and_then(Value::as_str).map(stop_of);
    message.turn_reminder = row.get("turnReminder").and_then(Value::as_str).map(str::to_owned);
    message.reasoning = row.get("reasoning").and_then(Value::as_str).map(str::to_owned);
    message.ui_diff = row.get("uiDiff").and_then(Value::as_str).map(str::to_owned);
    message.message_id = row.pointer("/meta/transcript/messageId").and_then(Value::as_str).map(str::to_owned);
    Some(message)
}

#[cfg(test)]
mod tests {
    use mixdog_agent::message::ToolKind;

    use super::*;

    #[test]
    fn rows_round_trip_through_the_message() {
        let mut call = AgentMessage::assistant("looking", vec![ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({"a": 1}), native_type: None }]);
        call.stop_reason = Some(StopReason::ToolUse);
        call.message_id = Some("msg_1".into());
        let result = AgentMessage::tool_text("c1", "echo:{}", ToolKind::Normal);
        let user = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("see".into(), Some(serde_json::Map::from_iter([("kind".to_owned(), json!("files")), ("files".to_owned(), json!([]))])))]));
        for message in [call, result, user, AgentMessage::user("hi")] {
            let row = row_of(&message);
            let back = message_of(&row).expect("row");
            assert_eq!(row_of(&back), row);
            assert_eq!(back.message.role, message.message.role);
            assert_eq!(back.message.content, message.message.content);
            assert_eq!(back.message.tool_calls, message.message.tool_calls);
            assert_eq!(back.message.tool_call_id, message.message.tool_call_id);
            assert_eq!(back.stop_reason, message.stop_reason);
        }
    }

    #[test]
    fn a_row_of_an_unknown_shape_is_not_a_message() {
        assert!(message_of(&json!({ "role": "narrator", "content": "x" })).is_none());
        assert!(message_of(&json!({ "role": "user", "content": [{ "type": "hologram" }] })).is_none());
    }

    /// A reference part keeps its object as Node stores it, through the row and into the wire
    /// message, whose lowering carries the text only.
    #[test]
    fn a_reference_parts_object_survives_the_row_and_stays_off_the_wire() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let media = golden["pdf_pages"]["info"].as_object().unwrap().clone();
        let files = json!({ "kind": "files", "files": [{ "attachmentRef": "r", "name": "a.pdf", "mimeType": "application/pdf", "sizeBytes": 1, "path": "/p/a.pdf" }] }).as_object().unwrap().clone();
        for meta in [media, files] {
            let message = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("ref".into(), Some(meta.clone()))]));
            let row = row_of(&message);
            assert_eq!(row["content"][0]["attachmentReference"], Value::Object(meta.clone()));
            let back = message_of(&row).unwrap();
            assert_eq!(back.message.content, message.message.content);
            let Content::Parts(parts) = &back.wire().content else { panic!("parts") };
            assert_eq!(parts, &vec![ContentPart::Text("ref".into(), Some(meta))]);
        }
    }}
