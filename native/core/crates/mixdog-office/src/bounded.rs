//! The bounded form of a result too long for a model to read (`bounded` of `core/office-core.mjs`), the serialisation the
//! length is counted in, and `stableJson`, the key-sorted serialisation a document's hash is taken over.

use mixdog_js::{js_object_keys, json_number, json_quote, json_stringify, math, slice_utf16, to_number, utf16_len};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::digest::common::entries;

/// The text that follows a cut snapshot.
const TRUNCATION_NOTE: &str = "\n... [office snapshot truncated]";

/// `serializedToolValue`: compact JSON. Results are read by a model, not by eye: indentation adds about a third to every
/// audit, snapshot and review a session returns, and buys the reader nothing the structure does not already carry.
pub fn serialized_tool_value(value: &Value) -> String {
    json_stringify(value)
}

/// `bounded(value, maxChars, length)`: the value itself while its serialisation (or the `length` the caller measured, in
/// UTF-16 units) is within `max_chars`; otherwise its metadata, a summary of its document that tells the caller to retry
/// with half the limit, and the head of the serialisation. A cut inside a surrogate pair leaves U+FFFD where JavaScript
/// keeps the lone high surrogate.
pub fn bounded(value: &Value, max_chars: usize, length: Option<usize>) -> Value {
    let text = serialized_tool_value(value);
    if length.unwrap_or_else(|| utf16_len(&text)) <= max_chars {
        return value.clone();
    }
    let document = value.get("document").and_then(Value::as_object);
    let mut summary = Map::new();
    if let Some(document) = document {
        for (key, item) in entries(document) {
            if matches!(item, Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_)) {
                summary.insert(key.clone(), item.clone());
            }
        }
        if let Some(Value::Object(pagination)) = document.get("pagination") {
            let mut retry = pagination.clone();
            retry.insert("nextCursor".to_owned(), Value::Null);
            retry.insert("retryRequired".to_owned(), Value::Bool(true));
            let limit = pagination.get("limit").filter(|limit| truthy(limit)).map_or(2.0, to_number);
            retry.insert("retryWithLimit".to_owned(), json_number(math::max(1.0, (limit / 2.0).floor())));
            summary.insert("pagination".to_owned(), Value::Object(retry));
        }
    }
    let mut result = Map::new();
    match value {
        Value::Object(map) => {
            for (key, item) in entries(map) {
                if key != "document" {
                    result.insert(key.clone(), item.clone());
                }
            }
        }
        // `Object.entries` of a list: its indices as keys.
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                result.insert(index.to_string(), item.clone());
            }
        }
        _ => {}
    }
    if document.is_some() {
        result.insert("document".to_owned(), Value::Object(summary));
    }
    result.insert("truncated".to_owned(), Value::Bool(true));
    result.insert("preview".to_owned(), Value::String(format!("{}{TRUNCATION_NOTE}", slice_utf16(&text, max_chars))));
    Value::Object(result)
}

/// `stableJson`: JSON with every object's keys sorted (UTF-16 code units), so equal values serialise alike.
pub fn stable_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(stable_json).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = js_object_keys(map);
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let members: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    let mut member = String::new();
                    json_quote(key, &mut member);
                    member.push(':');
                    member.push_str(&stable_json(&map[key.as_str()]));
                    member
                })
                .collect();
            format!("{{{}}}", members.join(","))
        }
        other => json_stringify(other),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_value_within_the_limit_is_returned_whole() {
        let value = json!({ "ok": true });
        assert_eq!(bounded(&value, 100, None), value);
        assert_eq!(bounded(&value, 5, Some(5)), value);
    }

    #[test]
    fn a_long_snapshot_keeps_its_scalars_and_asks_for_half_the_limit() {
        let value = json!({
            "session": "s1",
            "document": { "format": "docx", "title": "T", "paragraphs": [{ "text": "x" }], "pagination": { "limit": 9, "offset": 0, "nextCursor": "c" } }
        });
        let result = bounded(&value, 20, None);
        assert_eq!(result["document"]["format"], "docx");
        assert!(result["document"].get("paragraphs").is_none());
        assert_eq!(result["document"]["pagination"]["retryWithLimit"], 4);
        assert_eq!(result["document"]["pagination"]["nextCursor"], Value::Null);
        assert_eq!(result["document"]["pagination"]["retryRequired"], true);
        assert_eq!(result["truncated"], true);
        let preview = result["preview"].as_str().expect("preview");
        assert!(preview.starts_with("{\"session\":\"s1\",\"doc"));
        assert!(preview.ends_with("\n... [office snapshot truncated]"));
        let keys: Vec<&String> = result.as_object().expect("object").keys().collect();
        assert_eq!(keys, ["session", "document", "truncated", "preview"]);
    }

    #[test]
    fn the_retry_limit_is_never_below_one() {
        let value = json!({ "document": { "pagination": { "limit": 1 } } });
        assert_eq!(bounded(&value, 1, None)["document"]["pagination"]["retryWithLimit"], 1);
        let default_limit = json!({ "document": { "pagination": {} } });
        assert_eq!(bounded(&default_limit, 1, None)["document"]["pagination"]["retryWithLimit"], 1);
    }

    #[test]
    fn the_length_the_caller_measured_decides() {
        let value = json!({ "a": "x".repeat(50) });
        assert_eq!(bounded(&value, 40, Some(10)), value);
        assert_eq!(bounded(&value, 40, None)["truncated"], true);
    }

    #[test]
    fn stable_json_sorts_keys_by_utf16_unit_and_keeps_array_order() {
        let value: Value = serde_json::from_str(r#"{"b":[{"z":1,"a":2}],"a":null,"10":1,"9":2,"😀":0,"￿":1}"#).expect("json");
        assert_eq!(stable_json(&value), "{\"10\":1,\"9\":2,\"a\":null,\"b\":[{\"a\":2,\"z\":1}],\"\u{1F600}\":0,\"\u{ffff}\":1}");
        assert_eq!(stable_json(&json!("x\"y")), "\"x\\\"y\"");
    }
}
