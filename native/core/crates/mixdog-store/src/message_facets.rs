//! What a compaction can take out of one model message, as the 1.4.5 transcript shows it:
//! its text row (decided by the message id) and its tool cards (decided by call ids).
//! Read once from the message body when its `item` frame is projected and kept in
//! `history.facets`, so the index classifies a history row with `compaction_view` without
//! reading the log. Ports `hasText`, `toolCallsOf`, `callIdOf` and `resultCallIdOf` of
//! `compaction-archive-capture.mjs`.

use mixdog_js::{js_trim, value_to_string};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::compaction_view::ArchiveRow;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Facets {
    pub role: String,
    /// `hasText(content)`.
    pub text: bool,
    /// The tool calls the message carries or answers, in order, without the empty ids.
    pub calls: Vec<String>,
}

/// JS truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(value || '')`.
fn id_of(value: Option<&Value>) -> String {
    value.filter(|v| truthy(v)).map(value_to_string).unwrap_or_default()
}

fn has_text(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(s)) => !js_trim(s).is_empty(),
        Some(Value::Array(parts)) => parts
            .iter()
            .any(|p| p.get("text").and_then(Value::as_str).is_some_and(|t| !js_trim(t).is_empty())),
        _ => false,
    }
}

impl Facets {
    pub fn of(message: &Value) -> Facets {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("").to_owned();
        let calls = match message.get("toolCalls") {
            Some(Value::Array(a)) => Some(a),
            _ => match message.get("tool_calls") {
                Some(Value::Array(a)) => Some(a),
                _ => None,
            },
        };
        let mut ids: Vec<String> =
            calls.into_iter().flatten().map(|c| id_of(c.get("id"))).filter(|id| !id.is_empty()).collect();
        if role == "tool" {
            let result = match message.get("tool_call_id").filter(|v| truthy(v)) {
                Some(v) => value_to_string(v),
                None => id_of(message.get("toolCallId")),
            };
            if !result.is_empty() {
                ids.push(result);
            }
        }
        Facets { role, text: has_text(message.get("content")), calls: ids }
    }

    /// The transcript rows the message stands for: its text row and one tool card per
    /// call. A message with neither is one row decided by its id alone.
    pub fn rows(&self, iid: &str) -> FacetRows {
        let kind = if matches!(self.role.as_str(), "user" | "assistant") { self.role.as_str() } else { "notice" };
        let text_row = |kind: &str| ArchiveRow {
            kind: kind.into(),
            message_id: Some(iid.to_owned()),
            ..ArchiveRow::default()
        };
        // A user prompt always has its row; a reply only with text; a tool message is
        // its card; any other message is a row of its own.
        let has_text_row = match self.role.as_str() {
            "tool" => false,
            "assistant" => self.text,
            _ => true,
        };
        let calls: Vec<ArchiveRow> = self
            .calls
            .iter()
            .map(|id| ArchiveRow { kind: "tool".into(), call_id: Some(id.clone()), ..ArchiveRow::default() })
            .collect();
        let text = if has_text_row {
            Some(text_row(kind))
        } else if calls.is_empty() {
            Some(text_row(if self.role == "tool" { "tool" } else { kind }))
        } else {
            None
        };
        FacetRows { text, calls }
    }
}

/// The rows one message stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetRows {
    pub text: Option<ArchiveRow>,
    pub calls: Vec<ArchiveRow>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn calls_and_text_follow_the_archive_capture_rules() {
        let a = Facets::of(&json!({"role":"assistant","content":" ","toolCalls":[{"id":"c1"},{"id":""},{"id":7}]}));
        assert_eq!((a.text, a.calls.as_slice()), (false, ["c1".to_owned(), "7".to_owned()].as_slice()));
        let wire = Facets::of(&json!({"role":"assistant","content":[{"type":"text","text":"x"}],"tool_calls":[{"id":"w"}]}));
        assert_eq!((wire.text, wire.calls.as_slice()), (true, ["w".to_owned()].as_slice()));
        let result = Facets::of(&json!({"role":"tool","content":"out","toolCallId":"c1"}));
        assert_eq!(result.calls, ["c1"]);
        assert!(result.rows("t").text.is_none());
        let bare = Facets::of(&json!({"role":"tool","content":"out"}));
        assert_eq!(bare.rows("t").text.unwrap().kind, "tool");
    }
}
