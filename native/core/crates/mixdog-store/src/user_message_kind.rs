//! 1.4.5 `session/compact/user-message-kind.mjs` `isRealTurnMessage` with what it reads:
//! the task-notification envelope and the internal-notification tests of
//! `tool-execution-contract.mjs` / `task-notification-envelope.mjs`.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;
use mixdog_js::value_to_string;
use serde_json::Value;

use crate::session_text::CONTROL_MARKER_RE;
use crate::summary::truthy;

static SUMMARY_TAIL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\nmessages=\d+\s+(?:sha256=|compact_type=)", ""));
static REFERENCE_FILES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Reference files:\s*", "i"));
static SYNTHETIC_CONTROL: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:\[mixdog-runtime\]|\[request interrupted(?: by user(?: for tool use)?| by process restart)?\])(?:\s|$)",
        "i",
    )
});
static FIELD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^<([\w-]+)>([^<]*)<\/\1>$", "gm"));
static SURFACE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\S+) task ", ""));
static TASK_ID_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[task_id:\s*\S+\]", "im"));
static BRACKETED_STATUS: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^\[status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled|error|timeout|done|success)\]",
        "im",
    )
});
static BACKGROUND: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^background task\b", "i"));
static TASK_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^task_id:\s*\S+", "im"));
static STATUS: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b", "im")
});
static TASK_KEYS: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^(?:surface|operation|type|target|role|agent|preset|model|effort|fast|notification):\s*", "im")
});
static ASYNC_HEADER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Async .+ finished\.", "i"));
static RESULT_SPLIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\n\nResult:\n", ""));
static QUOTED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^> ", ""));

const ANCHOR: &str = "A previous model worked on this task and produced the compacted handoff summary below.";
const SYNTHETIC_SOURCES: [&str; 10] = [
    "schedule-result",
    "task-notification",
    "goal-continuation",
    "goal-closeout",
    "compact-context",
    "compact-active-turn-continuation",
    "compact-execution-recovery",
    "max-output-recovery",
    "refusal-recovery",
    "stream-cut-recovery",
];

/// `parseTaskNotification(text)`: the surface of a well-formed envelope.
fn parse_task_notification(text: &str) -> Option<String> {
    const OPEN: &str = "<task-notification>\n";
    const CLOSE: &str = "\n</task-notification>";
    let value = js_trim(text);
    if !value.starts_with(OPEN) || !value.ends_with(CLOSE) {
        return None;
    }
    let end = value.len() - CLOSE.len();
    let mut fields = if OPEN.len() <= end { value[OPEN.len()..end].to_owned() } else { String::new() };
    if let Some(start) = fields.find("\n<result>\n") {
        let end = fields.rfind("\n</result>")?;
        if end < start {
            return None;
        }
        fields = format!("{}{}", &fields[..start], &fields[end + "\n</result>".len()..]);
    }
    let mut map: HashMap<String, String> = HashMap::new();
    for caps in FIELD.captures_iter(&fields) {
        let decode = |v: &str| v.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        map.insert(caps.get(1)?.to_owned(), decode(caps.get(2)?));
    }
    let nonempty = |k: &str| map.get(k).is_some_and(|v| !v.is_empty());
    let status_ok = matches!(map.get("status").map(String::as_str), Some("completed" | "failed" | "cancelled"));
    if !nonempty("task-id") || !status_ok || !nonempty("summary") {
        return None;
    }
    let summary = &map["summary"];
    Some(if summary.starts_with("Agent \"") {
        "agent".into()
    } else if summary.starts_with("Shell task ") {
        "shell".into()
    } else {
        SURFACE.captures(summary).and_then(|c| c.get(1).map(str::to_owned)).filter(|s| !s.is_empty()).unwrap_or_else(|| "tool".into())
    })
}

fn is_bracketed_shell_notification_envelope(text: &str) -> bool {
    let value = js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).as_deref() == Some("shell") {
        return true;
    }
    TASK_ID_LINE.is_match(value) && BRACKETED_STATUS.is_match(value)
}

fn is_internal_runtime_notification_text(text: &str) -> bool {
    let value = js_trim(text);
    if value.is_empty() {
        return false;
    }
    parse_task_notification(value).is_some()
        || is_bracketed_shell_notification_envelope(value)
        || (BACKGROUND.is_match(value) && TASK_ID.is_match(value) && STATUS.is_match(value))
        || (TASK_ID.is_match(value) && STATUS.is_match(value) && TASK_KEYS.is_match(value))
}

fn is_model_visible_tool_completion_wrapper(text: &str) -> bool {
    let value = js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some() {
        return true;
    }
    let Some(split) = RESULT_SPLIT.find(value) else { return false };
    let preamble = js_trim(&value[..split.start]);
    if preamble.is_empty() || !ASYNC_HEADER.is_match(preamble) {
        return false;
    }
    // `split(/\r?\n/)`: a CR before the newline belongs to the separator.
    let lines: Vec<&str> =
        value[split.end..].split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() || !lines.iter().all(|l| QUOTED.is_match(l)) {
        return false;
    }
    let unquoted = lines.iter().map(|l| &l[2..]).collect::<Vec<_>>().join("\n");
    is_internal_runtime_notification_text(&unquoted)
}

fn meta(message: &Value) -> Option<&Value> {
    message.get("meta")
}

fn meta_source(message: &Value) -> Option<&Value> {
    meta(message).and_then(|m| m.get("source"))
}

/// `String(message?.meta?.source || '')`.
fn source_text(message: &Value) -> String {
    let s = meta_source(message);
    if truthy(s) { value_to_string(s.expect("truthy")) } else { String::new() }
}

fn is_imported(message: &Value) -> bool {
    meta_source(message).and_then(Value::as_str) == Some("import")
}

fn is_user(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("user")
}

fn is_summary_message(m: &Value) -> bool {
    if !is_user(m) || is_imported(m) {
        return false;
    }
    source_text(m) == "compact-summary"
        || m.get("content").and_then(Value::as_str).is_some_and(|c| c.starts_with(ANCHOR) && SUMMARY_TAIL.is_match(c))
}

/// `isProtectedContextUserMessage`: a user turn made only of `<system-reminder>` envelopes.
pub fn is_protected_context_user_message(m: &Value) -> bool {
    let (true, Some(content)) = (is_user(m) && !is_imported(m), m.get("content").and_then(Value::as_str)) else {
        return false;
    };
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut content = js_trim(content);
    if !content.to_ascii_lowercase().starts_with(OPEN) {
        return false;
    }
    while content.to_ascii_lowercase().starts_with(OPEN) {
        let Some(at) = content.to_ascii_lowercase().find(CLOSE) else { return true };
        content = js_trim(&content[at + CLOSE.len()..]);
    }
    content.is_empty()
}

fn is_injected_skill_body_message(m: &Value) -> bool {
    if !is_user(m) || is_imported(m) {
        return false;
    }
    if m.get("meta").and_then(Value::as_str) == Some("skill") {
        return true;
    }
    m.get("content").and_then(Value::as_str).is_some_and(|c| js_trim_start(c).starts_with("<skill>"))
}

fn user_message_text(m: &Value) -> String {
    match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match b {
                Value::String(s) => s.clone(),
                other => match other.get("text") {
                    Some(t) if truthy(Some(t)) => value_to_string(t),
                    _ => String::new(),
                },
            })
            .collect(),
        _ => String::new(),
    }
}

/// `isActualUserInstructionMessage`: the human's own instruction, not a summary or a runtime-injected turn.
pub fn is_actual_user_instruction_message(m: &Value) -> bool {
    if !is_user(m) || is_summary_message(m) || is_protected_context_user_message(m) || is_injected_skill_body_message(m) {
        return false;
    }
    let text = user_message_text(m);
    if is_imported(m) {
        return !js_trim(&text).is_empty();
    }
    if REFERENCE_FILES.is_match(js_trim_start(&text)) {
        return false;
    }
    if SYNTHETIC_CONTROL.is_match(js_trim_start(&text))
        || is_internal_runtime_notification_text(&text)
        || is_model_visible_tool_completion_wrapper(&text)
        || SYNTHETIC_SOURCES.contains(&source_text(m).as_str())
    {
        return false;
    }
    !js_trim(&text).is_empty() || m.get("content").and_then(Value::as_array).is_some_and(|a| !a.is_empty())
}

/// `isRealTurnMessage(message)`.
pub fn is_real_turn_message(m: &Value) -> bool {
    if is_summary_message(m) {
        return true;
    }
    if !is_actual_user_instruction_message(m) {
        return false;
    }
    if is_imported(m) {
        return true;
    }
    if m.get("internal") == Some(&Value::Bool(true)) || m.get("synthetic") == Some(&Value::Bool(true)) {
        return false;
    }
    if let Some(meta @ (Value::Object(_) | Value::Array(_))) = meta(m)
        && (meta.get("synthetic") == Some(&Value::Bool(true)) || truthy(meta.get("source")))
    {
        return false;
    }
    !CONTROL_MARKER_RE.is_match(js_trim(&user_message_text(m)))
}
