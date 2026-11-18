//! The result envelope of an Office tool call and the error of a conflicting transaction (`core/office-core.mjs`).

use std::fmt;

use mixdog_js::json_stringify;
use serde_json::{Map, Value, json};

/// An image block of a tool result: a MIME type and base64 data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolImage {
    pub mime_type: String,
    pub data: String,
}

/// `serializedToolValue(value)`: compact JSON. Results are read by a model, not by eye: indentation adds about a third
/// to every audit, snapshot and review a session returns, and buys the reader nothing the structure does not carry.
pub fn serialized_tool_value(value: &Value) -> String {
    json_stringify(value)
}

/// `toolResult(value, isError, images)`: `{ content: [{ type: 'text', text }, ...image blocks], isError? }`. A string
/// value is the text as it is; anything else is serialised with [`serialized_tool_value`], so key order and number
/// text equal V8's.
pub fn tool_result(value: &Value, is_error: bool, images: &[ToolImage]) -> Value {
    let text = match value {
        Value::String(text) => text.clone(),
        other => serialized_tool_value(other),
    };
    let mut content = vec![json!({ "type": "text", "text": text })];
    content.extend(images.iter().map(|image| {
        json!({ "type": "image", "source": { "type": "base64", "media_type": image.mime_type, "data": image.data } })
    }));
    let mut result = Map::new();
    result.insert("content".to_owned(), Value::Array(content));
    if is_error {
        result.insert("isError".to_owned(), Value::Bool(true));
    }
    Value::Object(result)
}

/// The message of [`OfficeConflictError`].
pub const CONFLICT_MESSAGE: &str = "Office transaction conflict: the document changed outside this transaction";

/// `OfficeConflictError`: the document changed outside the transaction. `details` is the result a caller returns
/// (`ok: false`, `code: 'transaction_conflict'`, the two fingerprints and the external diff).
#[derive(Debug, Clone, PartialEq)]
pub struct OfficeConflictError {
    pub details: Value,
}

impl OfficeConflictError {
    pub fn new(details: Value) -> Self {
        Self { details }
    }

    /// `details.code`.
    pub fn code(&self) -> Option<&str> {
        self.details.get("code").and_then(Value::as_str)
    }
}

impl fmt::Display for OfficeConflictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(CONFLICT_MESSAGE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_is_serialised_compactly_and_a_string_is_kept() {
        let result = tool_result(&json!({ "b": 1, "2": 2, "a": [1.5] }), false, &[]);
        assert_eq!(json_stringify(&result), r#"{"content":[{"type":"text","text":"{\"2\":2,\"b\":1,\"a\":[1.5]}"}]}"#);
        let text = tool_result(&json!("plain"), true, &[]);
        assert_eq!(json_stringify(&text), r#"{"content":[{"type":"text","text":"plain"}],"isError":true}"#);
    }

    #[test]
    fn images_follow_the_text() {
        let image = ToolImage { mime_type: "image/png".into(), data: "AAA=".into() };
        let result = tool_result(&json!({ "ok": true }), false, &[image]);
        assert_eq!(
            json_stringify(&result),
            r#"{"content":[{"type":"text","text":"{\"ok\":true}"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAA="}}]}"#
        );
    }

    #[test]
    fn the_conflict_error_carries_its_details() {
        let error = OfficeConflictError::new(json!({ "ok": false, "code": "transaction_conflict" }));
        assert_eq!(error.to_string(), CONFLICT_MESSAGE);
        assert_eq!(error.code(), Some("transaction_conflict"));
    }
}


impl std::error::Error for OfficeConflictError {}
