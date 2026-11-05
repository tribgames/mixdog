//! Whether Node's `restoreTranscriptRange` shows any row for a stored message, over every role.
//! One call per message; the thread projection's typed facts and the compaction check of
//! what a dropped message would show answer from the same rules.

use std::collections::HashMap;

use mixdog_js::js_trim;
use mixdog_js::to_number;
use serde_json::Value;

use super::is_room_row;
use super::js::str_of;
use super::js::truthy;
use super::user_row;
use super::user_text::UserText;
use super::user_text::tool_result_text;
use crate::tool_visibility::is_hidden_tool_item;
use crate::tool_visibility::is_task_wait;

fn field<'a>(message: &'a Value, path: &str) -> Option<&'a Value> {
    message.pointer(path)
}

/// `restoredContentText`.
fn content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        other => tool_result_text(other),
    }
}

/// A `meta.transcript.completion` that `restoredTranscriptMetadata` keeps: a status and a
/// finite elapsed time.
fn completion(value: &Value) -> Option<&str> {
    let status = value.get("status")?.as_str().filter(|s| !s.is_empty())?;
    to_number(value.get("elapsedMs")?).is_finite().then_some(status)
}

fn is_context_ack(message: &Value) -> bool {
    str_of(message.get("meta").unwrap_or(&Value::Null), "source") == Some("context-ack")
        && message.get("content").and_then(Value::as_str).is_some_and(|c| js_trim(c) == ".")
        && !message.get("toolCalls").is_some_and(Value::is_array)
}

fn calls(message: &Value) -> &[Value] {
    match message.get("tool_calls").or_else(|| message.get("toolCalls")) {
        Some(Value::Array(list)) => list,
        _ => &[],
    }
}

fn call_name(call: &Value) -> String {
    let name = call.pointer("/function/name").filter(|n| truthy(Some(n))).or_else(|| call.get("name").filter(|n| truthy(Some(n))));
    let name = name.map(mixdog_js::value_to_string).unwrap_or_default();
    let name = js_trim(&name);
    if name.is_empty() { "tool".to_owned() } else { name.to_owned() }
}

fn call_args(call: &Value) -> Option<Value> {
    let args = call.pointer("/function/arguments").filter(|a| !a.is_null()).or_else(|| call.get("arguments"))?;
    Some(match args {
        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| args.clone()),
        other => other.clone(),
    })
}

/// A call the transcript draws a card for (`restoredToolCallItems` and the later
/// `isTranscriptHiddenToolItem` once its result is attached).
fn call_shown(call: &Value, results: &HashMap<String, String>) -> bool {
    let name = call_name(call);
    if crate::tool_visibility::is_hidden_control_tool_name(&name) {
        return false;
    }
    if is_task_wait(&name, call_args(call).as_ref()) {
        return false;
    }
    let result = call.get("id").and_then(Value::as_str).and_then(|id| results.get(id)).map_or("", String::as_str);
    !is_hidden_tool_item(&name, result)
}

/// The message's reply text row, its tool cards, or the failed ends and switches it records.
fn assistant_shown(message: &Value, results: &HashMap<String, String>) -> bool {
    let imported = str_of(message.get("meta").unwrap_or(&Value::Null), "source") == Some("import")
        && message.get("content").is_some_and(Value::is_string)
        && field(message, "/meta/importedToolRuns").is_some_and(Value::is_array);
    // An imported message with well-formed runs shows its import row; with none it falls
    // through to the plain rules (the run check is the client's, `ImportedToolRun`).
    if imported && !js_trim(&content_text(message)).is_empty() {
        return true;
    }
    !js_trim(&content_text(message)).is_empty() || calls(message).iter().any(|call| call_shown(call, results))
}

/// The ends and switches `restoreTranscriptRange` adds for any role.
fn events_shown(message: &Value) -> bool {
    if let Some(Value::Array(previous)) = field(message, "/meta/transcript/previousCompletions")
        && previous.iter().any(|value| value.is_object() && completion(value).is_some())
    {
        return true;
    }
    if field(message, "/meta/transcript/completion")
        .filter(|c| c.is_object())
        .and_then(completion)
        == Some("failed")
    {
        return true;
    }
    let list = |key: &str| -> Vec<&Value> {
        match field(message, &format!("/meta/{key}")) {
            Some(Value::Array(list)) => list.iter().collect(),
            _ => Vec::new(),
        }
    };
    let has = |boundary: &Value, key: &str| truthy(boundary.get(key));
    list("sessionInheritances").iter().any(|b| has(b, "sessionId") && has(b, "provider") && has(b, "modelId"))
        || list("modelSwitches").iter().any(|b| has(b, "provider") && has(b, "modelId"))
        || list("workflowSwitches").iter().any(|b| has(b, "to"))
        || list("orchestrationModeSwitches").iter().any(|b| has(b, "to"))
}

/// Whether Node's restore shows a row for `message`. A tool message makes no row of its own
/// (its result fills the call's card); `results` maps call ids to their result text.
pub fn message_shown(message: &Value, text: &mut UserText<'_>, results: &HashMap<String, String>) -> bool {
    if is_room_row(message) {
        return true;
    }
    let body = match message.get("role").and_then(Value::as_str) {
        Some("user") => user_row(message, text).is_visible(),
        Some("assistant") if !is_context_ack(message) => assistant_shown(message, results),
        _ => false,
    };
    body || events_shown(message)
}

/// `message_shown` for each of `messages`, results taken from the tool messages themselves.
pub fn messages_shown(messages: &[Value], text: &mut UserText<'_>) -> Vec<bool> {
    let mut results = HashMap::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        let id = match message.get("tool_call_id") {
            Some(Value::String(id)) if !id.is_empty() => id.as_str(),
            _ => message.get("toolCallId").and_then(Value::as_str).unwrap_or(""),
        };
        if !id.is_empty() {
            results.insert(id.to_owned(), content_text(message));
        }
    }
    messages.iter().map(|message| message_shown(message, text, &results)).collect()
}
