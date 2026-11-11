//! Which transcript messages are conversation, what text they contribute, and
//! the stable identity of each. Only real prose is kept: human prompts and
//! model replies, never tool traces, synthetic rows, summaries or runtime
//! notifications. Every rule under-strips rather than delete a person's own
//! words.

use mixdog_js::{js_trim, JsRegex, value_to_string};
use std::sync::LazyLock;


use serde_json::Value;
use sha2::{Digest, Sha256};


const LEADING_NAMED_SECTIONS: [&str; 3] = ["Project Instructions", "Additional context", "Prefetch"];

static SESSION_BLOCK: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^# Session\n(?:(?:Cwd|Model|Workflow): [^\n]*\n)+(?:\n|$)", "")
});

/// `user` / `assistant` for the roles kept from a transcript; None for any other.
pub fn normalize_ingest_role(role: Option<&Value>) -> Option<&'static str> {
    let raw = js_trim(&role.filter(|r| !r.is_null()).map(value_to_string).unwrap_or_default()).to_lowercase();
    match raw.as_str() {
        "user" | "human" => Some("user"),
        "assistant" | "ai" | "model" => Some("assistant"),
        _ => None,
    }
}

/// The first textual block of a message content field.
fn first_text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(text) = item.as_str() {
                    return text.to_owned();
                }
                if item.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(text) = item.get("text").and_then(Value::as_str) {
                        return text.to_owned();
                    }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// Every textual block of a message content field, newline-joined.
pub fn all_text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.as_str(),
                _ if item.get("type").and_then(Value::as_str) == Some("text") => {
                    item.get("text").and_then(Value::as_str).unwrap_or_default()
                }
                _ => "",
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

/// JS `String(number)` for the integer-valued numbers timestamps are.
fn number_string(value: &serde_json::Number) -> String {
    match value.as_f64() {
        Some(n) if n.fract() == 0.0 && n.abs() < 1e21 && !value.is_i64() && !value.is_u64() => format!("{}", n as i128),
        _ => value.to_string(),
    }
}

fn tool_identity_ids(message: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(calls) = message.get("toolCalls").and_then(Value::as_array) {
        for call in calls {
            if truthy(call.get("id")) {
                ids.push(value_to_string(&call["id"]));
            }
        }
    }
    if truthy(message.get("toolCallId")) {
        ids.push(value_to_string(&message["toolCallId"]));
    }
    ids
}

/// A content-derived source reference for a session message, so a re-insert is
/// idempotent across compaction re-indexing. The identity hashes only durable
/// fields: role, tool ids, the message's original timestamp when it has one,
/// and the shaped content. An untimestamped message folds in its ordinal so
/// genuine textual repeats stay distinct rows.
pub fn stable_session_source_ref(session_id: &str, message: &Value, role: &str, content: &str, ordinal: usize) -> String {
    let raw_ts = message.get("ts").filter(|v| !v.is_null()).or_else(|| message.get("timestamp"));
    let original_ts = match raw_ts {
        Some(Value::Number(n)) => number_string(n),
        Some(Value::String(text)) if !js_trim(text).is_empty() => text.clone(),
        _ => String::new(),
    };
    let ordinal_part = if original_ts.is_empty() { ordinal.to_string() } else { String::new() };
    let identity = [role, &original_ts, &ordinal_part, &tool_identity_ids(message).join(","), content].join("\u{0}");
    let digest = Sha256::digest(identity.as_bytes());
    let hex: String = digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect();
    format!("session:{session_id}:{hex}")
}

/// `# <heading>\n<body>` at the very start, up to the next `# ` line or the end.
fn strip_leading_named_section(text: &str, heading: &str) -> String {
    let marker = format!("# {heading}\n");
    let Some(rest) = text.strip_prefix(&marker) else {
        return text.trim_start_matches('\n').to_owned();
    };
    let remaining = rest.find("\n# ").map_or("", |at| &rest[at..]);
    remaining.trim_start_matches('\n').to_owned()
}

fn strip_user_turn_prefix_envelopes(text: &str) -> String {
    let mut out = match SESSION_BLOCK.find(text) {
        Some(block) => format!("{}{}", &text[..block.start], &text[block.end..]),
        None => text.to_owned(),
    };
    for heading in LEADING_NAMED_SECTIONS {
        out = strip_leading_named_section(&out, heading);
    }
    out.strip_prefix("# Task\n").map_or(out.clone(), str::to_owned)
}

/// The prose of one message: its text blocks, never tool traces. A user
/// message loses the deterministic prefix envelopes the session manager adds.
pub fn session_message_content_for_ingest(message: &Value) -> String {
    let base = all_text_content(message.get("content"));
    if base.is_empty() {
        return base;
    }
    if normalize_ingest_role(message.get("role")) == Some("user") {
        return strip_user_turn_prefix_envelopes(&base);
    }
    base
}


/// The row as the shared ingest predicate reads it.
pub fn should_exclude_ingest_message(message: &Value) -> bool {
    use mixdog_agent::compact::ingest::{IngestView, should_exclude_ingest_message as excluded};
    use mixdog_core_api::domain::provider::Role;
    let role = match normalize_ingest_role(message.get("role")) {
        Some("user") => Role::User,
        Some("assistant") => Role::Assistant,
        _ => return !message.is_object(),
    };
    let meta = message.get("meta");
    let meta_source = meta.and_then(|m| m.get("source")).filter(|s| truthy(Some(s))).map(value_to_string).unwrap_or_default();
    let first_text = first_text_content(message.get("content"));
    excluded(&IngestView {
        role,
        first_text: &first_text,
        meta_source: &meta_source,
        skill_body: meta.and_then(Value::as_str) == Some("skill"),
        has_tool_calls: message.get("toolCalls").is_some_and(Value::is_array),
    })
}

#[cfg(test)]
#[path = "ingest_shape_node_cases_tests.rs"]
mod node_cases_tests;

