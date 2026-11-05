//! The legacy replay fields of an assistant message in the form the live writers produce,
//! so the core never reads the legacy ones.
//!
//! * `reasoningItems` (Responses encrypted reasoning, `{id, encrypted_content, summary,
//!   afterText?}`): a message that also carries `providerReplay` holds the same items there
//!   (`response-outcome.mjs`, `openai-ws-response-state.mjs` write both), so the copy is
//!   dropped. Otherwise the message becomes the ordered `providerReplay` of the Responses
//!   owner holding every item Node's legacy path sends for it ([`legacy_replay`]). An owned
//!   replay takes over the message on the wire (`openai-responses-input.mjs:219-237`), so it
//!   carries the text and calls too; the flattened fields stay for the transcript.
//! * A top-level `thoughtParts` moves to `providerMetadata.gemini.thoughtParts`, the slot the
//!   Gemini reader (`gemini-schema.mjs` `geminiThoughtPartsFromMetadata`) reads.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::json::js_truthy;

/// The `providerReplay` owner of the Responses wire family (`createProviderReplay`).
const RESPONSES_OWNER: &str = "openai-responses";

pub fn convert(body: &mut Value) {
    let Some(message) = body.as_object_mut() else {
        return;
    };
    if let Some(items) = message.shift_remove("reasoningItems")
        && !message.contains_key("providerReplay")
        && let Some(items) = legacy_replay(message, &items)
    {
        message.insert(
            "providerReplay".into(),
            json!({ "version": 1, "provider": RESPONSES_OWNER, "items": items }),
        );
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

/// The `input` items Node's legacy path sends for an assistant `message` with
/// `reasoningItems` and no owned replay, in its order (`openai-responses-input.mjs`, 1.4.5):
/// the items before the text (`pushReasoningItems(m, 'before')`, :240); with tool calls
/// (:241-249) the text message only when the content is not empty, the items after it
/// (:247), then the calls (:248, `pushAssistantToolCalls` :109-135); without (:251-258) the
/// text message always, then the items after it (:259). Options are `buildRequestBody`'s
/// (`openai-responses-payload.mjs:232-240`) for the message's provider: native tool search
/// on, `codexWireParity` unless it is the public `openai` (a message without `accountRouting`
/// is from `openai-oauth`). `None` when no reasoning item survives (Node then sends the
/// message as the core's own lowering does) or the content is not a string (1.4.5 writes a
/// string; any other content keeps the flattened form).
fn legacy_replay(message: &Map<String, Value>, reasoning: &Value) -> Option<Vec<Value>> {
    let reasoning = reasoning.as_array()?;
    let before = reasoning_items(reasoning, false);
    let after = reasoning_items(reasoning, true);
    if before.is_empty() && after.is_empty() {
        return None;
    }
    let text = match message.get("content") {
        None | Some(Value::Null) => "",
        Some(Value::String(text)) => text.as_str(),
        Some(_) => return None,
    };
    let parity = message
        .get("providerMetadata")
        .and_then(|m| m.get("accountRouting"))
        .and_then(|r| r.get("provider"))
        .and_then(Value::as_str)
        != Some("openai");
    let calls = message
        .get("toolCalls")
        .and_then(Value::as_array)
        .filter(|calls| !calls.is_empty());
    let mut items = before;
    if calls.is_none() || !text.is_empty() {
        items.push(wire_message(text, message.get("phase"), parity));
    }
    items.extend(after);
    for call in calls.into_iter().flatten() {
        items.push(call_item(call));
    }
    Some(items)
}

/// `pushReasoningItems` (:179-198) for one side of the text: untagged or `type:"reasoning"`
/// items with a non-empty `encrypted_content`, as `{type, id?, encrypted_content, summary}`.
fn reasoning_items(items: &[Value], after_text: bool) -> Vec<Value> {
    let mut out = Vec::new();
    for item in items {
        let Some(fields) = item.as_object() else {
            continue;
        };
        if (fields.get("afterText") == Some(&Value::Bool(true))) != after_text {
            continue;
        }
        if !matches!(fields.get("type"), None | Some(Value::Null))
            && fields.get("type").and_then(Value::as_str) != Some("reasoning")
        {
            continue;
        }
        let Some(encrypted) = fields.get("encrypted_content").and_then(Value::as_str).filter(|e| !e.is_empty()) else {
            continue;
        };
        let mut tagged = Map::new();
        tagged.insert("type".into(), json!("reasoning"));
        if let Some(id) = fields.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            tagged.insert("id".into(), json!(id));
        }
        tagged.insert("encrypted_content".into(), json!(encrypted));
        let summary = fields.get("summary").filter(|s| s.is_array()).cloned();
        tagged.insert("summary".into(), summary.unwrap_or_else(|| json!([])));
        out.push(Value::Object(tagged));
    }
    out
}

/// `wireMessage('assistant', normalizeContentForOpenAIResponses(text), m.phase)` (:164-176;
/// a string content is `[]` or one `output_text` part, `media-normalization.mjs:1114`).
fn wire_message(text: &str, phase: Option<&Value>, parity: bool) -> Value {
    let mut item = Map::new();
    if parity {
        item.insert("type".into(), json!("message"));
    }
    item.insert("role".into(), json!("assistant"));
    let content = if text.is_empty() { json!([]) } else { json!([{"type": "output_text", "text": text}]) };
    item.insert("content".into(), content);
    if let Some(phase) = phase.filter(|p| matches!(p.as_str(), Some("commentary" | "final_answer"))) {
        item.insert("phase".into(), phase.clone());
    }
    if parity {
        item.insert("internal_chat_message_metadata_passthrough".into(), json!({}));
    }
    Value::Object(item)
}

/// One call of `pushAssistantToolCalls` with native tool search on (:109-135,
/// `custom-tool-wire.mjs` `nativeToolSearchCallInput`, `customToolInputFromArguments`). A
/// field Node sets to `undefined` is absent, as on the wire.
fn call_item(call: &Value) -> Value {
    let field = |key: &str| call.get(key).filter(|v| !v.is_null());
    let native_type = call.get("nativeType").and_then(Value::as_str);
    let arguments = field("arguments");
    let mut item = Map::new();
    if native_type == Some("tool_search_call") {
        item.insert("type".into(), json!("tool_search_call"));
        let id = call.get("id").filter(|id| js_truthy(Some(id))).cloned();
        item.insert("call_id".into(), id.unwrap_or_else(|| json!("")));
        item.insert("execution".into(), json!("client"));
        let arguments = arguments.filter(|a| a.is_object() || a.is_array()).cloned();
        item.insert("arguments".into(), arguments.unwrap_or_else(|| json!({})));
        return Value::Object(item);
    }
    let custom = native_type == Some("custom_tool_call");
    item.insert("type".into(), json!(if custom { "custom_tool_call" } else { "function_call" }));
    if let Some(id) = call.get("id") {
        item.insert("call_id".into(), id.clone());
    }
    let name = call.get("name");
    if let Some(name) = name {
        let name = if !custom && *name == "tool_search" { json!("load_tool") } else { name.clone() };
        item.insert("name".into(), name);
    }
    if let Some(namespace) = call.get("namespace").filter(|n| n.as_str().is_some_and(|n| !n.is_empty())) {
        item.insert("namespace".into(), namespace.clone());
    }
    if custom {
        item.insert("input".into(), Value::String(custom_input(name.and_then(Value::as_str), arguments)));
    } else if let Some(arguments) = call.get("arguments") {
        item.insert("arguments".into(), json!(mixdog_js::json_stringify(arguments)));
    }
    Value::Object(item)
}

/// `customToolInputFromArguments(name, args)`.
fn custom_input(name: Option<&str>, arguments: Option<&Value>) -> String {
    let text = |key: &str| arguments.and_then(|a| a.get(key)).and_then(Value::as_str);
    match arguments {
        Some(Value::String(s)) => s.clone(),
        _ => match (name == Some("apply_patch")).then(|| text("patch")).flatten().or_else(|| text("input")) {
            Some(s) => s.to_owned(),
            None => mixdog_js::json_stringify(arguments.unwrap_or(&json!({}))),
        },
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

    /// `vectors/legacy_reasoning.json` (`vectors/legacy_reasoning.mjs`): the envelope holds
    /// exactly the items, in the order and key order, Node's legacy path sends for the
    /// message; everything else of the message is as stored.
    #[test]
    fn lone_reasoning_items_become_the_items_node_sends() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("vectors/legacy_reasoning.json")).unwrap();
        assert_eq!(cases.len(), 5);
        for case in cases {
            let name = &case["name"];
            let mut body = case["message"].clone();
            convert(&mut body);
            let replay = body.as_object_mut().unwrap().shift_remove("providerReplay").unwrap();
            assert_eq!(replay["version"], 1, "{name}");
            assert_eq!(replay["provider"], RESPONSES_OWNER, "{name}");
            assert_eq!(
                serde_json::to_string(&replay["items"]).unwrap(),
                serde_json::to_string(&case["items"]).unwrap(),
                "{name}"
            );
            let mut stored = case["message"].clone();
            stored.as_object_mut().unwrap().shift_remove("reasoningItems");
            assert_eq!(serde_json::to_string(&body).unwrap(), serde_json::to_string(&stored).unwrap(), "{name}");
        }
    }

    #[test]
    fn lone_items_with_nothing_to_replay_leave_the_flattened_message() {
        let mut body = json!({"role": "assistant", "content": "x", "reasoningItems": [
            {"id": "a", "summary": []},
            {"type": "message", "id": "m", "encrypted_content": "E"},
            "junk",
        ]});
        convert(&mut body);
        assert_eq!(body, json!({"role": "assistant", "content": "x"}));
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
