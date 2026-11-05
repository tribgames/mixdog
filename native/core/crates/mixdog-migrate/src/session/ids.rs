//! Item ids of migrated message rows (SM §11.3 rule 2): `meta.transcript.messageId`, else
//! the id 1.4.5 `stampMessageIds(messages, {sessionId})` would assign
//! (`v145:ORCH/session/message-ids.mjs:65-99`), else `pos:<sessionId>:<index>` for a
//! message whose `meta` cannot carry one. A derivation only: never used to merge rows.

use std::collections::HashSet;

use serde_json::Value;
use sha1::Digest as _;
use sha1::Sha1;

use crate::json::hex;
use crate::json::js_to_string;
use crate::json::js_truthy;

const SEED_EDGE_CHARS: usize = 512;

/// `meta.transcript.messageId` when it is a non-empty string.
fn message_id_of(message: &Value) -> Option<&str> {
    let id = message.get("meta")?.as_object()?.get("transcript")?.get("messageId")?;
    id.as_str().filter(|s| !s.is_empty())
}

/// `meta` absent, null or a plain object.
fn can_carry(message: &Value) -> bool {
    let Some(obj) = message.as_object() else {
        return false;
    };
    matches!(obj.get("meta"), None | Some(Value::Null) | Some(Value::Object(_)))
}

/// `boundedText`: UTF-16 code units, edges of 512 and the length between NULs.
fn bounded_text(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= SEED_EDGE_CHARS * 2 {
        return text.to_string();
    }
    format!(
        "{}\u{0}{}\u{0}{}",
        String::from_utf16_lossy(&units[..SEED_EDGE_CHARS]),
        units.len(),
        String::from_utf16_lossy(&units[units.len() - SEED_EDGE_CHARS..])
    )
}

fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

fn bounded_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => bounded_text(s),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| {
                let Some(obj) = part.as_object() else {
                    return match part {
                        // An array is an object without these fields.
                        Value::Array(_) => "part:0".to_string(),
                        other => js_to_string(other),
                    };
                };
                if let Some(Value::String(text)) = obj.get("text") {
                    return format!("t:{}", bounded_text(text));
                }
                let candidates = [
                    obj.get("data"),
                    obj.get("source").and_then(|s| s.get("data")),
                    obj.get("image_url").and_then(|s| s.get("url")),
                    obj.get("url"),
                    obj.get("ref"),
                ];
                let data = candidates.into_iter().find(|v| !nullish(*v)).flatten();
                let len = match data {
                    Some(Value::String(s)) => s.encode_utf16().count(),
                    _ => 0,
                };
                let kind = match obj.get("type") {
                    t if js_truthy(t) => js_to_string(t.expect("truthy")),
                    _ => "part".to_string(),
                };
                format!("{kind}:{len}")
            })
            .collect::<Vec<_>>()
            .join("\u{1}"),
        None | Some(Value::Null) => String::new(),
        Some(Value::Object(_)) => "object".into(),
        Some(Value::Number(_)) => "number".into(),
        Some(Value::Bool(_)) => "boolean".into(),
    }
}

/// `Array.prototype.join` element text (`null`/`undefined` → empty).
fn join_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_to_string(other),
    }
}

fn seeded(session_id: &str, index: usize, message: &Value) -> String {
    let calls = match message.get("toolCalls") {
        Some(Value::Array(a)) => Some(a),
        _ => match message.get("tool_calls") {
            Some(Value::Array(a)) => Some(a),
            _ => None,
        },
    };
    let call_ids = calls
        .map(|calls| {
            calls
                .iter()
                .map(|c| {
                    let id = c.get("id");
                    if js_truthy(id) {
                        js_to_string(id.expect("truthy"))
                    } else {
                        String::new()
                    }
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let tool_call_id = [message.get("toolCallId"), message.get("tool_call_id")]
        .into_iter()
        .find(|v| js_truthy(*v))
        .flatten()
        .map(js_to_string)
        .unwrap_or_default();
    let seed = [
        session_id.to_string(),
        index.to_string(),
        join_text(message.get("role")),
        tool_call_id,
        call_ids,
        bounded_content(message.get("content")),
    ]
    .join("\u{2}");
    format!("msg_{}", &hex(&Sha1::digest(seed.as_bytes()))[..32])
}

/// The item id of every message of `messages`, in order (`stampMessageIds` semantics).
pub fn message_iids(session_id: &str, messages: &[Value]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            if let Some(existing) = message_id_of(message) {
                seen.insert(existing.to_string());
                return existing.to_string();
            }
            if !can_carry(message) {
                return format!("pos:{session_id}:{index}");
            }
            let mut id = seeded(session_id, index, message);
            let mut salt = 1;
            while seen.contains(&id) {
                id = seeded(&format!("{session_id}#{salt}"), index, message);
                salt += 1;
            }
            seen.insert(id.clone());
            id
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_ids_win_and_markers_get_positions() {
        let messages = vec![
            serde_json::json!({"role":"user","content":"a","meta":{"transcript":{"messageId":"m1"}}}),
            serde_json::json!({"role":"user","content":"b","meta":"skill"}),
            serde_json::json!({"role":"user","content":"c"}),
            serde_json::json!({"role":"user","content":"c"}),
        ];
        let ids = message_iids("s", &messages);
        assert_eq!(ids[0], "m1");
        assert_eq!(ids[1], "pos:s:1");
        assert!(ids[2].starts_with("msg_") && ids[2].len() == 36);
        assert_ne!(ids[2], ids[3]);
    }
}
