//! The reply of a memory tool call and its JSON envelope. Callers have always
//! seen the keys in one order — `text`, the call's own fields, then `content`
//! and `isError` (an error puts `isError` before `content`) — so the envelope
//! is assembled by hand rather than through a map that would sort them.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolReply {
    pub text: String,
    /// Extra top-level fields, each already serialised to JSON.
    pub fields: Vec<(&'static str, String)>,
    pub is_error: bool,
}

impl ToolReply {
    pub fn ok(text: impl Into<String>) -> Self {
        Self { text: text.into(), fields: Vec::new(), is_error: false }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self { text: text.into(), fields: Vec::new(), is_error: true }
    }

    pub fn with_field<T: Serialize>(mut self, key: &'static str, value: &T) -> Self {
        let json = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
        self.fields.push((key, json));
        self
    }

    /// The JSON text of the call result.
    pub fn envelope(&self) -> String {
        let text = serde_json::to_string(&self.text).unwrap_or_default();
        let content = format!("[{{\"type\":\"text\",\"text\":{text}}}]");
        let mut out = format!("{{\"text\":{text}");
        if self.is_error {
            out.push_str(",\"isError\":true");
        }
        for (key, json) in &self.fields {
            out.push_str(&format!(",\"{key}\":{json}"));
        }
        out.push_str(&format!(",\"content\":{content}"));
        if !self.is_error {
            out.push_str(",\"isError\":false");
        }
        out.push('}');
        out
    }
}
