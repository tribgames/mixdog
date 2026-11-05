//! The legacy replay fields of an assistant message in the form the live writers produce,
//! so the core never reads the legacy ones.
//!
//! * `reasoningItems` (Responses encrypted reasoning, `{id, encrypted_content, summary,
//!   afterText?}`): a message that also carries `providerReplay` holds the same items there
//!   (`response-outcome.mjs`, `openai-ws-response-state.mjs` write both), so the copy is
//!   dropped. Otherwise the items Node's reader replays (`openai-responses-input.mjs`
//!   `pushReasoningItems`: untagged or `type:"reasoning"`) become a reasoning-only
//!   `providerReplay` of the Responses owner, which the core replays around the message
//!   text by `afterText` exactly as that reader did.
//! * A top-level `thoughtParts` moves to `providerMetadata.gemini.thoughtParts`, the slot the
//!   Gemini reader (`gemini-schema.mjs` `geminiThoughtPartsFromMetadata`) reads.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The `providerReplay` owner of the Responses wire family (`createProviderReplay`).
const RESPONSES_OWNER: &str = "openai-responses";

pub fn convert(body: &mut Value) {
    let Some(message) = body.as_object_mut() else {
        return;
    };
    if let Some(items) = message.shift_remove("reasoningItems")
        && !message.contains_key("providerReplay")
    {
        let replayed: Vec<Value> = match items {
            Value::Array(items) => items.into_iter().filter_map(reasoning_item).collect(),
            _ => Vec::new(),
        };
        if !replayed.is_empty() {
            message.insert(
                "providerReplay".into(),
                json!({ "version": 1, "provider": RESPONSES_OWNER, "items": replayed }),
            );
        }
    }
    if let Some(parts) = message.shift_remove("thoughtParts") {
        let metadata = message
            .entry("providerMetadata")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(metadata) = metadata.as_object_mut() {
            let gemini = metadata.entry("gemini").or_insert_with(|| Value::Object(Map::new()));
            if let Some(gemini) = gemini.as_object_mut() {
                gemini.entry("thoughtParts").or_insert(parts);
            }
        }
    }
}

/// An item `pushReasoningItems` accepts, tagged as the reasoning item it replays as.
fn reasoning_item(item: Value) -> Option<Value> {
    let Value::Object(fields) = item else {
        return None;
    };
    match fields.get("type") {
        None | Some(Value::Null) => {
            let mut tagged = Map::new();
            tagged.insert("type".into(), Value::String("reasoning".into()));
            tagged.extend(fields.into_iter().filter(|(k, _)| k != "type"));
            Some(Value::Object(tagged))
        }
        Some(Value::String(kind)) if kind == "reasoning" => Some(Value::Object(fields)),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_items_beside_a_replay_are_dropped() {
        let replay = json!({"version": 1, "provider": "openai-responses", "items": [{"type": "reasoning", "id": "rs"}]});
        let mut body = json!({"role": "assistant", "content": "x", "reasoningItems": [{"id": "rs"}], "providerReplay": replay});
        convert(&mut body);
        assert_eq!(body, json!({"role": "assistant", "content": "x", "providerReplay": replay}));
    }

    #[test]
    fn lone_reasoning_items_become_a_reasoning_replay() {
        let mut body = json!({"role": "assistant", "content": "x", "reasoningItems": [
            {"id": "a", "encrypted_content": "E1", "summary": []},
            {"type": "reasoning", "id": "b", "encrypted_content": "E2", "summary": [], "afterText": true},
            {"type": "message", "id": "m"},
            "junk",
        ]});
        convert(&mut body);
        assert_eq!(
            body,
            json!({"role": "assistant", "content": "x", "providerReplay": {"version": 1, "provider": "openai-responses", "items": [
                {"type": "reasoning", "id": "a", "encrypted_content": "E1", "summary": []},
                {"type": "reasoning", "id": "b", "encrypted_content": "E2", "summary": [], "afterText": true},
            ]}})
        );
    }

    #[test]
    fn top_level_thought_parts_move_under_gemini_metadata() {
        let parts = json!([{"text": "t", "thought": true, "thoughtSignature": "s"}]);
        let mut body = json!({"role": "assistant", "content": "x", "thoughtParts": parts,
            "providerMetadata": {"accountRouting": {"provider": "gemini"}}});
        convert(&mut body);
        assert_eq!(
            body,
            json!({"role": "assistant", "content": "x",
                "providerMetadata": {"accountRouting": {"provider": "gemini"}, "gemini": {"thoughtParts": parts}}})
        );
        let current = body.clone();
        convert(&mut body);
        assert_eq!(body, current, "the current form is left as it is");
    }
}
