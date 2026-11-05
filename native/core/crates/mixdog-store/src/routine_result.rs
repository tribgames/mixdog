//! 1.4.5 `session/routine-result.mjs`, the part the summary reads: whether a message is a
//! routine result, its provenance marker and its notice line.

use mixdog_js::js_trim;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::summary::truthy;

const ROUTINE_RESULT_SOURCE: &str = "schedule-result";

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

pub fn is_routine_result_message(message: &Value) -> bool {
    role(message) == Some("user")
        && message.get("meta").and_then(|m| m.get("source")).and_then(Value::as_str) == Some(ROUTINE_RESULT_SOURCE)
}

/// `String(value || '')`.
fn text_or_empty(v: Option<&Value>) -> String {
    if truthy(v) { value_to_string(v.expect("truthy")) } else { String::new() }
}

/// `${value}` (an absent property prints `undefined`).
fn template(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `normalizeRoutineProvenance(value)`: the canonical object or null.
pub fn normalize_routine_provenance(value: &Value) -> Value {
    let Some(o) = value.as_object() else { return Value::Null };
    let name = match o.get("name") {
        Some(Value::String(s)) => js_trim(s),
        _ => "",
    };
    let kind = o.get("kind").and_then(Value::as_str);
    let status = o.get("status").and_then(Value::as_str);
    if name.is_empty() || !matches!(kind, Some("schedule" | "webhook")) || !matches!(status, Some("ok" | "failed")) {
        return Value::Null;
    }
    let mut out = Map::new();
    out.insert("kind".into(), json!(kind));
    out.insert("name".into(), json!(name));
    out.insert("status".into(), json!(status));
    for key in ["summary", "error"] {
        if let Some(Value::String(s)) = o.get(key)
            && !s.is_empty()
        {
            out.insert(key.into(), json!(s));
        }
    }
    Value::Object(out)
}

fn routine(message: &Value) -> Option<&Map<String, Value>> {
    message.get("meta")?.get("routine")?.as_object()
}

/// `routineProvenance(message)`.
pub fn routine_provenance(message: &Value) -> Value {
    if !is_routine_result_message(message) {
        return Value::Null;
    }
    let empty = Map::new();
    let routine = routine(message).unwrap_or(&empty);
    let kind = routine.get("kind").and_then(Value::as_str);
    if kind == Some("task") {
        return Value::Null;
    }
    let failed = routine.get("status").and_then(Value::as_str) == Some("failed");
    let summary = text_or_empty(routine.get("summary"));
    let mut v = json!({
        "kind": if kind == Some("webhook") { "webhook" } else { "schedule" },
        "name": routine.get("name").cloned().unwrap_or(Value::Null),
        "status": if failed { "failed" } else { "ok" },
    });
    v[if failed { "error" } else { "summary" }] = json!(summary);
    normalize_routine_provenance(&v)
}

/// `routineResultNotice(message).text`.
pub fn routine_result_notice_text(message: &Value) -> String {
    let empty = Map::new();
    let routine = routine(message).unwrap_or(&empty);
    let positive = |k: &str| routine.get(k).is_some_and(|v| to_number(v) > 0.0);
    if positive("omitted") {
        return format!("⏱ Routine results omitted: {}", template(routine.get("omitted")));
    }
    if positive("relayFailed") {
        return format!("⚠ Task results not relayed: {} — they are shown above", template(routine.get("relayFailed")));
    }
    if routine.get("kind").and_then(Value::as_str) == Some("task") {
        let session = routine.get("target").and_then(Value::as_str) == Some("session");
        let status = routine.get("status");
        let what = match status.and_then(Value::as_str) {
            Some("started") => "started".to_owned(),
            Some("blocked") => "waiting for confirmation".to_owned(),
            _ => template(status),
        };
        let summary = routine.get("summary");
        let tail = if truthy(summary) { format!(" — {}", template(summary)) } else { String::new() };
        return format!(
            "🛠 {} {what} · {}{tail}",
            if session { "Session" } else { "Agent task" },
            template(routine.get("name"))
        );
    }
    let webhook = routine.get("kind").and_then(Value::as_str) == Some("webhook");
    let name = text_or_empty(routine.get("name"));
    let failed = routine.get("status").and_then(Value::as_str) == Some("failed");
    let summary = text_or_empty(routine.get("summary"));
    let detail = if failed {
        if summary.is_empty() { "Failed".to_owned() } else { format!("Failed: {summary}") }
    } else {
        summary
    };
    let tail = if detail.is_empty() { String::new() } else { format!(" — {detail}") };
    format!("{} · {name}{tail}", if webhook { "🔗 Webhook" } else { "⏱ Schedule" })
}
