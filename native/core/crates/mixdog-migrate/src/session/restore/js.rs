//! The JavaScript value and string operations the ported restore rules use.

use mixdog_js::JsRegex;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

pub use crate::json::js_truthy as truthy;

pub fn re(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

/// `String(value || fallback)`.
pub fn or_str(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(value) if truthy(Some(value)) => value_to_string(value),
        _ => fallback.to_owned(),
    }
}

/// `String(value ?? '')`.
pub fn string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `value?.[key]` as a string comparison operand (`=== 'text'`).
pub fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub use mixdog_protocol::text_class::split_lines;

/// `value.replace(/\s+/g, ' ')`.
pub fn collapse_spaces(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if mixdog_js::is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// The first match of `pattern` replaced (a `replace` without the `g` flag).
pub fn replace_first(pattern: &JsRegex, value: &str, with: &str) -> String {
    match pattern.find(value) {
        Some(range) => format!("{}{with}{}", &value[..range.start], &value[range.end..]),
        None => value.to_owned(),
    }
}

/// An object under construction where a JavaScript `undefined` value leaves the key out.
#[derive(Default)]
pub struct Obj(pub Map<String, Value>);

impl Obj {
    pub fn put(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.to_owned(), value.into());
        self
    }

    /// `key: value || undefined`.
    pub fn non_empty(mut self, key: &str, value: &str) -> Self {
        if !value.is_empty() {
            self.0.insert(key.to_owned(), Value::String(value.to_owned()));
        }
        self
    }

    pub fn maybe(mut self, key: &str, value: Option<Value>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.to_owned(), value);
        }
        self
    }
}
