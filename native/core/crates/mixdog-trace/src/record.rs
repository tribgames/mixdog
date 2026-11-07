//! The rows, as Node builds them. Key order is part of the bytes: a JavaScript spread keeps each
//! key where the source object had it and appends new keys, which is what `serde_json`'s
//! `preserve_order` map does on `insert`.

use serde_json::Map;
use serde_json::Value;

/// JavaScript truthiness of a JSON value (the \!x\ / \x || y\ test).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::Null,
    }
}

/// `value ?? null`.
fn nullish(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `appendAgentTrace`'s row: `{...record, ts, session_id, payload}` minus `sessionId`.
pub fn build_row(record: &Map<String, Value>, now_ms: i64) -> Map<String, Value> {
    let mut ts_number = match record.get("ts") {
        Some(Value::String(text)) if !text.is_empty() => mixdog_js::time::date_parse(text),
        Some(v) if truthy(v) => mixdog_js::to_number(v),
        _ => now_ms as f64,
    };
    if !ts_number.is_finite() {
        ts_number = now_ms as f64;
    }
    let mut row = record.clone();
    row.insert("ts".into(), mixdog_js::json_number(ts_number));
    let session_id = match record.get("session_id") {
        Some(v) if !v.is_null() => v.clone(),
        _ => match record.get("sessionId") {
            Some(v) if truthy(v) => Value::String(mixdog_js::value_to_string(v)),
            _ => Value::String("no-session".into()),
        },
    };
    row.insert("session_id".into(), session_id);
    let payload = match record.get("payload") {
        Some(v) if !v.is_null() => v.clone(),
        _ => Value::Object(Map::new()),
    };
    row.insert("payload".into(), payload);
    row.shift_remove("sessionId");
    row
}

/// The record `logLlmCall(entry, { maintenance })` hands to `appendAgentTrace`.
pub fn usage_record(
    entry: &Map<String, Value>,
    maintenance: bool,
    now_ms: i64,
) -> Map<String, Value> {
    let mut record = Map::new();
    record.insert("ts".into(), or_now(entry.get("ts"), now_ms));
    record.insert("kind".into(), Value::String("usage".into()));
    for (key, value) in entry {
        record.insert(key.clone(), value.clone());
    }
    let payload = match entry.get("payload") {
        Some(v) if !v.is_null() => v.clone(),
        _ => Value::Object(Map::new()),
    };
    record.insert("payload".into(), payload);
    if maintenance {
        record.insert("maintenanceLog".into(), Value::Bool(true));
    }
    record
}

fn or_now(value: Option<&Value>, now_ms: i64) -> Value {
    match value {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::from(now_ms),
    }
}

const RECOVERED_ERROR_MESSAGE_MAX_CHARS: usize = 300;

fn recovered_error_message(value: Option<&Value>) -> Value {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Value::Null;
    };
    let message = mixdog_js::value_to_string(value);
    if mixdog_js::utf16_len(&message) > RECOVERED_ERROR_MESSAGE_MAX_CHARS {
        let mut cut = crate::text::slice_utf16(&message, RECOVERED_ERROR_MESSAGE_MAX_CHARS - 1);
        cut.push('\u{2026}');
        Value::String(cut)
    } else {
        Value::String(message)
    }
}

/// The record `traceAgentCompact(input)` hands to `appendAgentTrace`. `input` holds the named
/// arguments of the JS call (absent = undefined).
pub fn compact_meta_record(input: &Map<String, Value>) -> Map<String, Value> {
    let mut record = Map::new();
    for key in ["sessionId", "iteration"] {
        if let Some(v) = input.get(key) {
            record.insert(key.into(), v.clone());
        }
    }
    record.insert("kind".into(), Value::String("compact_meta".into()));
    for key in ["stage", "trigger"] {
        record.insert(key.into(), or_null(input.get(key)));
    }
    record.insert(
        "compact_changed".into(),
        Value::Bool(input.get("compact_changed").is_some_and(truthy)),
    );
    record.insert(
        "input_prefix_hash".into(),
        or_null(input.get("input_prefix_hash")),
    );
    for key in [
        "before_count",
        "after_count",
        "before_bytes",
        "after_bytes",
        "context_window",
        "budget_tokens",
        "boundary_tokens",
        "target_budget_tokens",
        "reserve_tokens",
        "pressure_tokens",
        "trigger_tokens",
        "message_tokens_est",
        "duration_ms",
    ] {
        record.insert(key.into(), nullish(input.get(key)));
    }
    for key in ["provider", "model", "error", "error_code"] {
        record.insert(key.into(), or_null(input.get(key)));
    }
    let recovered = match input.get("recovered_error") {
        Some(v) if v.is_object() || v.is_array() => {
            let mut object = Map::new();
            object.insert("code".into(), nullish(v.get("code")));
            object.insert("message".into(), recovered_error_message(v.get("message")));
            Value::Object(object)
        }
        _ => Value::Null,
    };
    record.insert("recovered_error".into(), recovered);
    let details = match input.get("details") {
        Some(v) if v.is_object() || v.is_array() => v.clone(),
        _ => Value::Null,
    };
    record.insert("details".into(), details);
    record
}
