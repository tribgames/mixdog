//! Stored tool-call argument compaction and restoration (`loop/stored-tool-args.mjs`).
//!
//! A long `command` or `script` argument is stored in the assistant turn as a marker with a head and tail preview, so a
//! huge shell body does not ride every later request. Mutation bodies (`content`, `old_string`, `new_string`, `patch`,
//! `rewrite`) are never collapsed after the fact (`deferBodies`): a later sweep would rewrite a prefix the provider has
//! already cached. A FAILED call restores its full command text (its own draft, to correct and retry).

use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::JsonValue;
use sha2::Digest;
use sha2::Sha256;

use crate::message::AgentMessage;

/// One budget for a stored long command (the codex truncation budget), counted in UTF-16 units as the length was.
const LIMIT: usize = 10_000;
const PREVIEW_HEAD: usize = 360;
const PREVIEW_TAIL: usize = 160;
/// Deeper than this a value is only counted (`[n items]` / `{...}`).
const MAX_DEPTH: usize = 6;

fn is_long_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("command") || key.eq_ignore_ascii_case("script")
}

fn is_body_key(key: &str) -> bool {
    ["content", "old_string", "new_string", "patch", "rewrite"].iter().any(|body| key.eq_ignore_ascii_case(body))
}

/// The first `units` UTF-16 units of `value`, never cutting a character.
fn head_units(value: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, ch) in value.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return &value[..at];
        }
    }
    value
}

/// The last `units` UTF-16 units of `value`, never cutting a character.
fn tail_units(value: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, ch) in value.char_indices().rev() {
        used += ch.len_utf16();
        if used > units {
            return &value[at + ch.len_utf8()..];
        }
    }
    value
}

fn compact_string(value: &str, key: &str) -> String {
    let length = value.encode_utf16().count();
    if !is_long_key(key) || length <= LIMIT {
        return value.to_owned();
    }
    let digest = Sha256::digest(value.as_bytes());
    let hash: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    let head = head_units(value, PREVIEW_HEAD).replace("\r\n", "\n");
    let tail = tail_units(value, PREVIEW_TAIL).replace("\r\n", "\n");
    format!("[mixdog compacted {key}: {length} chars, sha256:{hash}; do not copy]\n{head}\n... [middle omitted from stored tool-call args] ...\n{tail}")
}

fn compact_value(value: &JsonValue, key: &str, depth: usize) -> JsonValue {
    match value {
        JsonValue::String(text) => JsonValue::String(compact_string(text, key)),
        JsonValue::Array(items) if depth >= MAX_DEPTH => JsonValue::String(format!("[{} items]", items.len())),
        JsonValue::Object(_) if depth >= MAX_DEPTH => JsonValue::String("{...}".to_owned()),
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(|item| compact_value(item, key, depth + 1)).collect()),
        JsonValue::Object(map) => JsonValue::Object(map.iter().map(|(k, v)| (k.clone(), compact_value(v, k, depth + 1))).collect()),
        other => other.clone(),
    }
}

/// `compactToolCallsForHistory(calls, { deferBodies: true })`: the calls as the assistant turn stores them.
pub(crate) fn compact_calls(calls: &[ToolCall]) -> Vec<ToolCall> {
    calls.iter().map(|call| ToolCall { arguments: compact_value(&call.arguments, "", 0), ..call.clone() }).collect()
}

/// The stored tree with every long command/script field taken from the original; every other field stays as stored.
fn restore_value(stored: &JsonValue, original: Option<&JsonValue>, key: &str) -> JsonValue {
    if is_body_key(key) {
        return stored.clone();
    }
    if is_long_key(key)
        && let Some(text @ JsonValue::String(_)) = original
    {
        return text.clone();
    }
    match (stored, original) {
        (JsonValue::Array(items), Some(JsonValue::Array(originals))) => {
            JsonValue::Array(items.iter().enumerate().map(|(i, item)| restore_value(item, originals.get(i), key)).collect())
        }
        (JsonValue::Object(map), Some(JsonValue::Object(originals))) => {
            JsonValue::Object(map.iter().map(|(k, v)| (k.clone(), restore_value(v, originals.get(k), k))).collect())
        }
        _ => stored.clone(),
    }
}

/// `restoreToolCallBodyForId`: the stored assistant turn gets the full command text of ONE failed call back.
pub(crate) fn restore_call_body(assistant: &mut AgentMessage, originals: &[ToolCall], call_id: &str) {
    if call_id.is_empty() {
        return;
    }
    let Some(original) = originals.iter().find(|call| call.id == call_id) else { return };
    let Some(stored) = assistant.message.tool_calls.iter_mut().find(|call| call.id == call_id) else { return };
    if !stored.arguments.is_object() || !original.arguments.is_object() {
        return;
    }
    stored.arguments = restore_value(&stored.arguments, Some(&original.arguments), "");
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn call(id: &str, arguments: JsonValue) -> ToolCall {
        ToolCall { id: id.to_owned(), name: "bash".to_owned(), arguments, native_type: None }
    }

    #[test]
    fn a_long_command_is_stored_as_a_marker_with_a_head_and_tail_and_a_short_one_is_kept() {
        let long = format!("{}{}", "a".repeat(400), "z".repeat(10_000));
        let stored = compact_calls(&[call("c1", json!({ "command": long, "timeout": 5 })), call("c2", json!({ "command": "ls" }))]);
        let text = stored[0].arguments["command"].as_str().unwrap();
        assert!(text.starts_with("[mixdog compacted command: 10400 chars, sha256:"));
        assert!(text.contains("; do not copy]\n"));
        assert!(text.contains("\n... [middle omitted from stored tool-call args] ...\n"));
        assert!(text.ends_with(&"z".repeat(160)));
        assert_eq!(stored[0].arguments["timeout"], json!(5));
        assert_eq!(stored[1].arguments["command"], json!("ls"));
    }

    #[test]
    fn a_mutation_body_is_never_collapsed() {
        let body = "p".repeat(20_000);
        let stored = compact_calls(&[call("c1", json!({ "patch": body, "content": body }))]);
        assert_eq!(stored[0].arguments["patch"].as_str().unwrap().len(), 20_000);
        assert_eq!(stored[0].arguments["content"].as_str().unwrap().len(), 20_000);
    }

    #[test]
    fn a_value_deeper_than_the_limit_is_counted_and_not_kept() {
        let deep = json!({ "a": { "b": { "c": { "d": { "e": { "f": [1, 2, 3] } } } } } });
        let stored = compact_calls(&[call("c1", deep)]);
        assert_eq!(stored[0].arguments["a"]["b"]["c"]["d"]["e"]["f"], json!("[3 items]"));
    }

    #[test]
    fn a_failed_call_gets_its_full_command_back_and_only_that_call() {
        let long = "x".repeat(12_000);
        let originals = [call("c1", json!({ "command": long, "cwd": "/w" })), call("c2", json!({ "command": long }))];
        let mut assistant = AgentMessage::assistant("", compact_calls(&originals));
        restore_call_body(&mut assistant, &originals, "c1");
        assert_eq!(assistant.message.tool_calls[0].arguments["command"].as_str().unwrap().len(), 12_000);
        assert!(assistant.message.tool_calls[1].arguments["command"].as_str().unwrap().starts_with("[mixdog compacted"));
        restore_call_body(&mut assistant, &originals, "nope");
    }

    #[test]
    fn the_preview_never_cuts_a_character() {
        let text = "é".repeat(500);
        assert_eq!(head_units(&text, 360).chars().count(), 360);
        assert_eq!(tail_units(&text, 160).chars().count(), 160);
        assert_eq!(head_units("😀😀", 3), "😀");
    }
}
