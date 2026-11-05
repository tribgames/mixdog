//! Secret redaction for what compaction keeps or sends: `key: value` pairs in
//! raw strings, and tool-call arguments of messages kept verbatim.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use serde_json::Value as JsonValue;

use crate::message::AgentMessage;

const KEY_WORD: &str =
    "(?:api[_-]?key|authorization|auth|cookie|credential|passwd|password|refresh[_-]?token|secret|token)";
const CAMEL_WORD: &str =
    "(?:Api[_-]?Key|Authorization|Auth|Cookie|Credential|Passwd|Password|Refresh[_-]?Token|Secret|Token)";
const REDACTED: &str = "[redacted]";

static KEY: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(&format!(r"(?:^|[_-]){KEY_WORD}(?:$|[_-])"), "i"));
static KEY_CAMEL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(&format!("[a-z0-9]{CAMEL_WORD}s?$"), ""));

/// One raw-pair matcher. `from_start` begins a search at index 0 and may open at the start of
/// the text; `after` is the same pattern for a search resumed past index 0 (`lastIndex > 0`
/// in Node), where `^` can no longer match, so it is searched on the remaining slice.
struct RawKey {
    from_start: JsRegex,
    after: JsRegex,
}

impl RawKey {
    fn new(body: &str, flags: &str) -> Self {
        Self {
            from_start: JsRegex::new_static(&format!(r#"((?:^|[\s,{{(?&])["']?{body}["']?\s*[:=]\s*)"#), flags),
            after: JsRegex::new_static(&format!(r#"((?:[\s,{{(?&])["']?{body}["']?\s*[:=]\s*)"#), flags),
        }
    }

    /// `exec` with `lastIndex = search`: the matched range in `text`.
    fn find_at(&self, text: &str, search: usize) -> Option<std::ops::Range<usize>> {
        if search == 0 {
            return self.from_start.find(text);
        }
        self.after.find(&text[search..]).map(|r| search + r.start..search + r.end)
    }
}

/// The two raw-pair matchers: any-case sensitive words with an optional
/// prefix/suffix segment, and case-sensitive camelCase keys.
static RAW_KEYS: LazyLock<[RawKey; 2]> = LazyLock::new(|| {
    let full = format!("(?:[A-Za-z0-9_-]*[_-])?{KEY_WORD}(?:[_-][A-Za-z0-9_-]*)?");
    [RawKey::new(&full, "i"), RawKey::new(&format!("[A-Za-z0-9_-]*[a-z0-9]{CAMEL_WORD}"), "")]
});
static HEADER_STYLE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r":\s*$", ""));

pub fn is_sensitive_key(key: &str) -> bool {
    KEY.is_match(key) || KEY_CAMEL.is_match(key)
}

/// Redacts `key: value` / `key=value` secret pairs inside a raw string,
/// consuming the whole value after the key (scheme words, quoted values with
/// spaces, `;`-separated cookie pairs) so no fragment survives.
pub fn redact_raw_secret_string(text: &str) -> String {
    let mut value = text.to_owned();
    for key in RAW_KEYS.iter() {
        let mut out = String::with_capacity(value.len());
        let mut last = 0;
        let mut search = 0;
        while let Some(found) = key.find_at(&value, search) {
            let prefix_end = found.end;
            out.push_str(&value[last..prefix_end]);
            let rest = &value[prefix_end..];
            let mut end = prefix_end;
            let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\''));
            if let Some(quote) = quote {
                end += 1;
                match value[end..].find(quote) {
                    Some(close) => end += close + 1,
                    None => end = value.len(),
                }
            } else {
                let header = HEADER_STYLE.is_match(&value[found.clone()]);
                let stop = |c: char| {
                    if header {
                        matches!(c, ',' | ')' | '}' | '\n')
                    } else {
                        matches!(c, ',' | ')' | '}') || is_js_space(c)
                    }
                };
                end += rest.find(stop).unwrap_or(rest.len());
            }
            out.push_str(REDACTED);
            last = end;
            search = end;
        }
        out.push_str(&value[last..]);
        value = out;
    }
    value
}

/// Redaction-only walk of an argument value: shape and key order stay;
/// returns whether anything changed.
fn redact_value(value: &mut JsonValue, key: &str) -> bool {
    if is_sensitive_key(key) {
        let changed = value.as_str() != Some(REDACTED);
        *value = JsonValue::String(REDACTED.to_owned());
        return changed;
    }
    match value {
        JsonValue::String(text) => {
            let redacted = redact_raw_secret_string(text);
            let changed = redacted != *text;
            *text = redacted;
            changed
        }
        JsonValue::Array(items) => items.iter_mut().fold(false, |changed, item| redact_value(item, "") | changed),
        JsonValue::Object(map) => map.iter_mut().fold(false, |changed, (k, v)| redact_value(v, k) | changed),
        _ => false,
    }
}

/// A tool call's arguments with secrets redacted, shape kept (a string stays
/// a string); `None` when nothing changed, so the original stays byte-exact.
fn redact_arguments(arguments: &JsonValue) -> Option<JsonValue> {
    match arguments {
        JsonValue::String(raw) => {
            let trimmed = js_trim(raw);
            if trimmed.starts_with(['[', '{'])
                && let Ok(mut parsed) = serde_json::from_str::<JsonValue>(trimmed)
            {
                return redact_value(&mut parsed, "").then(|| JsonValue::String(mixdog_js::json_stringify(&parsed)));
            }
            let redacted = redact_raw_secret_string(raw);
            (redacted != *raw).then_some(JsonValue::String(redacted))
        }
        JsonValue::Object(_) | JsonValue::Array(_) => {
            let mut copy = arguments.clone();
            redact_value(&mut copy, "").then_some(copy)
        }
        _ => None,
    }
}

/// Messages kept verbatim through compaction with the secrets of their tool
/// calls redacted; structure, order and pairing are untouched.
pub fn redact_tool_call_secrets(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    messages
        .iter()
        .map(|m| {
            let mut m = m.clone();
            for call in &mut m.message.tool_calls {
                if let Some(redacted) = redact_arguments(&call.arguments) {
                    call.arguments = redacted;
                }
            }
            m
        })
        .collect()
}
