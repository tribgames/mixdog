//! Wire-level tool-call guards for the Chat Completions request builder:
//! tool-call ids projected onto the wire's id rule, and every assistant
//! `tool_calls` block answered by the tool messages that follow it. History can
//! hold a call whose result never committed (cancel, abort); the endpoint
//! hard-rejects it, and every retry would resend the same unpaired call.

use std::collections::HashMap;

use mixdog_core_api::domain::provider::{Message, Role};
use mixdog_protocol::JsonValue;
use mixdog_protocol::tool_call_ids::{OPENAI_CHAT_IDS, wire_id_map};
use serde_json::json;

/// Body of a result synthesized for a call that never completed.
pub const PAIRING_STUB: &str = "Cancelled";

/// id → wire id for every tool call and result in `messages` that Chat
/// Completions would refuse (`[A-Za-z0-9_.:-]`, up to 40 characters): a valid
/// id passes unchanged, an invalid one becomes a deterministic collision-free
/// stand-in, and a call and its result always map alike.
pub fn wire_tool_call_ids(messages: &[Message]) -> HashMap<String, String> {
    let ids = messages.iter().flat_map(|message| -> Vec<&str> {
        match message.role {
            Role::Assistant => message.tool_calls.iter().map(|call| call.id.as_str()).collect(),
            Role::Tool => message.tool_call_id.as_deref().into_iter().collect(),
            _ => Vec::new(),
        }
    });
    wire_id_map(ids, OPENAI_CHAT_IDS)
}

/// Every assistant `tool_calls` entry is answered by a tool message in the
/// run right after it, and no tool message sits anywhere else. A late or
/// repeated result is dropped; a missing one is stubbed.
pub fn ensure_chat_tool_pairs(messages: Vec<JsonValue>) -> Vec<JsonValue> {
    let role = |m: &JsonValue| m.get("role").and_then(JsonValue::as_str).map(str::to_owned);
    let call_ids = |m: &JsonValue| -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        if role(m).as_deref() != Some("assistant") {
            return ids;
        }
        for call in m.get("tool_calls").and_then(JsonValue::as_array).into_iter().flatten() {
            if let Some(id) = call.get("id").and_then(JsonValue::as_str)
                && !id.is_empty()
                && !ids.iter().any(|known| known == id)
            {
                ids.push(id.to_owned());
            }
        }
        ids
    };
    let mut out = Vec::with_capacity(messages.len());
    let mut i = 0;
    while i < messages.len() {
        let message = &messages[i];
        i += 1;
        if role(message).as_deref() == Some("tool") {
            continue;
        }
        let ids = call_ids(message);
        out.push(message.clone());
        if ids.is_empty() {
            continue;
        }
        let mut end = i;
        while end < messages.len() && role(&messages[end]).as_deref() == Some("tool") {
            end += 1;
        }
        let mut answered: Vec<&str> = Vec::new();
        let mut kept = Vec::new();
        for result in &messages[i..end] {
            let id = result.get("tool_call_id").and_then(JsonValue::as_str);
            if let Some(id) = id
                && !id.is_empty()
                && ids.iter().any(|known| known == id)
                && !answered.contains(&id)
            {
                answered.push(id);
                kept.push(result.clone());
            }
        }
        for id in &ids {
            if !answered.contains(&id.as_str()) {
                out.push(json!({"role": "tool", "tool_call_id": id, "content": PAIRING_STUB}));
            }
        }
        out.extend(kept);
        i = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::provider::{Content, ToolCall};

    fn assistant(ids: &[&str]) -> Message {
        let mut m = Message::new(Role::Assistant, Content::Text(String::new()));
        m.tool_calls = ids
            .iter()
            .map(|id| ToolCall {
                id: (*id).to_owned(),
                name: "t".into(),
                arguments: json!({}),
                native_type: None,
            })
            .collect();
        m
    }

    fn result(id: &str) -> Message {
        let mut m = Message::new(Role::Tool, Content::Text("r".into()));
        m.tool_call_id = Some(id.to_owned());
        m
    }

    #[test]
    fn valid_ids_pass_and_invalid_ones_map_consistently() {
        let long = "x".repeat(60);
        let map = wire_tool_call_ids(&[
            assistant(&["call_1", "toolu/bad id", &long]),
            result("toolu/bad id"),
        ]);
        let to = &map["toolu/bad id"];
        assert!(OPENAI_CHAT_IDS.is_valid(to) && to.starts_with("toolu_bad_id_"), "{to}");
        assert_eq!(map.len(), 2);
        assert!(map.values().all(|wire| OPENAI_CHAT_IDS.is_valid(wire)));
        assert_ne!(map["toolu/bad id"], map[&long]);
        // Node skips a falsy id (`if (call?.id)`), so an empty one stays empty.
        assert!(wire_tool_call_ids(&[assistant(&[""]), result("")]).is_empty());
    }

    #[test]
    fn unpaired_call_gets_a_stub_and_misplaced_result_is_dropped() {
        let out = ensure_chat_tool_pairs(vec![
            json!({"role":"user","content":"hi"}),
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"a"},{"id":"b"}]}),
            json!({"role":"tool","tool_call_id":"b","content":"B"}),
            json!({"role":"tool","tool_call_id":"b","content":"again"}),
            json!({"role":"user","content":"next"}),
            json!({"role":"tool","tool_call_id":"a","content":"late"}),
        ]);
        let shape: Vec<(String, String)> = out
            .iter()
            .map(|m| {
                (
                    m["role"].as_str().unwrap().to_owned(),
                    m.get("tool_call_id").and_then(JsonValue::as_str).unwrap_or("").to_owned(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            [
                ("user".into(), "".into()),
                ("assistant".into(), "".into()),
                ("tool".into(), "a".into()),
                ("tool".into(), "b".into()),
                ("user".into(), "".into()),
            ]
        );
        assert_eq!(out[2]["content"], PAIRING_STUB);
        assert_eq!(out[3]["content"], "B");
    }
}
