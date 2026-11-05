//! Text helpers the summary reads transcripts through: message text with a
//! marker per media part, JS-exact middle truncation, and bounded tool-call
//! lines with secrets redacted.

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_js::js_trim;
use serde_json::Value as JsonValue;

use super::redact::is_sensitive_key;
use super::redact::redact_raw_secret_string;
use crate::message::AgentMessage;
use mixdog_core_api::domain::provider::Role;

const TOOL_ARG_STRING_MAX_CHARS: usize = 360;
const TOOL_ARG_ARRAY_MAX_ITEMS: usize = 8;
const TOOL_ARG_MAX_DEPTH: usize = 4;
const TOOL_CALL_ARGS_MAX_CHARS: usize = 260;
const TOOL_CALLS_MAX: usize = 4;

fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Middle-elided text of at most `max_chars` UTF-16 units (CRLF normalized).
pub fn truncate_middle(text: &str, max_chars: usize) -> String {
    let value = text.replace("\r\n", "\n");
    let units: Vec<u16> = value.encode_utf16().collect();
    if max_chars == 0 || units.is_empty() {
        return String::new();
    }
    if units.len() <= max_chars {
        return value;
    }
    if max_chars <= 8 {
        return from_units(&units[..max_chars]);
    }
    let head = (max_chars - 5).div_ceil(2);
    let tail = (max_chars - 5) / 2;
    format!("{} … {}", from_units(&units[..head]), from_units(&units[units.len() - tail..]))
}

fn media_marker(part: &ContentPart) -> String {
    let pdf = |name: &str, mime: &str| {
        if mime.eq_ignore_ascii_case("application/pdf") {
            format!("[PDF: {}]", if name.is_empty() { "document.pdf" } else { name })
        } else {
            format!("[file: {}]", if !name.is_empty() { name } else if !mime.is_empty() { mime } else { "attachment" })
        }
    };
    match part {
        ContentPart::Text(_) => String::new(),
        ContentPart::Image(_) => "[image]".to_owned(),
        ContentPart::File { mime_type, filename, .. } => pdf(js_trim(filename.as_deref().unwrap_or("")), mime_type),
        ContentPart::Document { source, title } => {
            let mime = match source {
                DocumentSource::Base64 { media_type, .. } => media_type.as_str(),
                _ => "application/pdf",
            };
            pdf(js_trim(title.as_deref().unwrap_or("")), mime)
        }
    }
}

/// A content as the summarizer reads it: text parts and a fixed marker per
/// media part, joined by newlines.
pub fn content_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                ContentPart::Text(text) => text.clone(),
                other => media_marker(other),
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

pub fn extract_text(message: &AgentMessage) -> String {
    content_text(&message.message.content)
}

fn js_sorted_keys(map: &serde_json::Map<String, JsonValue>) -> Vec<&String> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_by_key(|k| k.encode_utf16().collect::<Vec<u16>>());
    keys
}

fn normalize_arg_value(value: &JsonValue, key: &str, depth: usize) -> JsonValue {
    if is_sensitive_key(key) {
        return JsonValue::String("[redacted]".to_owned());
    }
    match value {
        JsonValue::String(s) => {
            JsonValue::String(truncate_middle(&redact_raw_secret_string(s), TOOL_ARG_STRING_MAX_CHARS))
        }
        JsonValue::Array(items) => {
            if depth >= TOOL_ARG_MAX_DEPTH {
                return JsonValue::String(format!("[array:{}]", items.len()));
            }
            let mut out: Vec<JsonValue> = items
                .iter()
                .take(TOOL_ARG_ARRAY_MAX_ITEMS)
                .enumerate()
                .map(|(i, item)| normalize_arg_value(item, &i.to_string(), depth + 1))
                .collect();
            if items.len() > TOOL_ARG_ARRAY_MAX_ITEMS {
                out.push(JsonValue::String(format!("+{} more", items.len() - TOOL_ARG_ARRAY_MAX_ITEMS)));
            }
            JsonValue::Array(out)
        }
        JsonValue::Object(map) => {
            if depth >= TOOL_ARG_MAX_DEPTH {
                return JsonValue::String("[object]".to_owned());
            }
            let mut out = serde_json::Map::new();
            for k in js_sorted_keys(map) {
                out.insert(k.clone(), normalize_arg_value(&map[k], k, depth + 1));
            }
            JsonValue::Object(out)
        }
        other => other.clone(),
    }
}

fn stable_arg_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::String(s) => {
            let text = js_trim(s);
            if text.is_empty() {
                return String::new();
            }
            if text.starts_with(['[', '{'])
                && let Ok(parsed) = serde_json::from_str::<JsonValue>(text)
            {
                return mixdog_js::json_stringify(&normalize_arg_value(&parsed, "", 0));
            }
            truncate_middle(&redact_raw_secret_string(text), TOOL_ARG_STRING_MAX_CHARS)
        }
        other => mixdog_js::json_stringify(&normalize_arg_value(other, "", 0)),
    }
}

fn summarize_tool_call(name: &str, arguments: &JsonValue, max_arg_chars: usize) -> String {
    let args = if max_arg_chars == 0 {
        String::new()
    } else {
        let text = stable_arg_json(arguments);
        if text.is_empty() { text } else { truncate_middle(&text, max_arg_chars) }
    };
    if args.is_empty() { name.to_owned() } else { format!("{name}({args})") }
}

/// The argument budget of one transcript line of `per_message_chars`.
pub fn tool_call_arg_budget(per_message_chars: usize) -> usize {
    if per_message_chars == 0 {
        return 0;
    }
    TOOL_CALL_ARGS_MAX_CHARS.min(32.max(per_message_chars / 2))
}

pub fn tool_call_summary(message: &AgentMessage, max_arg_chars: usize) -> String {
    let calls = message.tool_calls();
    if calls.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = calls
        .iter()
        .take(TOOL_CALLS_MAX)
        .map(|c| summarize_tool_call(if c.name.is_empty() { &c.id } else { &c.name }, &c.arguments, max_arg_chars))
        .collect();
    if calls.len() > TOOL_CALLS_MAX {
        lines.push(format!("+{} more", calls.len() - TOOL_CALLS_MAX));
    }
    format!(" tool_calls={}", lines.join(";"))
}

pub fn tool_result_id(message: &AgentMessage) -> String {
    match message.tool_call_id() {
        Some(id) if message.role() == Role::Tool && !id.is_empty() => format!(" tool_result={id}"),
        _ => String::new(),
    }
}

