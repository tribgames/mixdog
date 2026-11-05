//! 1.4.5 `runtime-core/session-text.mjs`: the message text and the preview-noise test the
//! summary uses, with `CONTROL_MARKER_RE` (`tool-execution-contract.mjs`) and
//! `isRoutineQuietReply` (`routine-trigger.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;

use crate::summary::truthy;
use crate::title::clean_session_preview;

pub static CONTROL_MARKER_RE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^\[(?:truncated|request interrupted(?: by user(?: for tool use)?| by process restart)?)\]$", "i")
});

static SYNTHETIC: LazyLock<Vec<JsRegex>> = LazyLock::new(|| {
    [
        r"^\[mixdog-runtime\]",
        r"^a previous model worked on this task and produced the compacted handoff summary below\b",
        r"^re-attached after compaction\b",
        r"^the async (?:agent|shell) task\b",
        r"^#\s*permission\b",
        r"^permission:\s*",
        r"^cwd:\s*",
    ]
    .iter()
    .map(|p| JsRegex::new_static(p, "i"))
    .collect()
});

static DEFERRED_TOOLS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<available-deferred-tools>", "i"));

/// `isRoutineQuietReply`.
pub fn is_routine_quiet_reply(text: &str) -> bool {
    js_trim(text) == "ROUTINE_QUIET"
}

/// `sessionMessageText(content)`.
pub fn session_message_text(content: &Value) -> String {
    let parts = match content {
        Value::Null => return String::new(),
        Value::String(s) => return s.clone(),
        Value::Array(a) => Some(a),
        Value::Object(o) => match o.get("content") {
            Some(Value::Array(a)) => Some(a),
            _ => None,
        },
        _ => None,
    };
    if let Some(parts) = parts {
        return parts
            .iter()
            .map(|part| match part {
                Value::String(s) => Value::String(s.clone()),
                Value::Object(o) => match o.get("text") {
                    None | Some(Value::Null) => Value::String(String::new()),
                    Some(t) => t.clone(),
                },
                _ => Value::String(String::new()),
            })
            .filter(|v| truthy(Some(v)))
            .map(|v| value_to_string(&v))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Value::Object(o) = content
        && let Some(Value::String(t)) = o.get("text")
    {
        return t.clone();
    }
    content.to_string()
}

/// `isLateToolAnnouncement`.
fn is_late_tool_announcement(text: &str) -> bool {
    text.contains("connected after this session started") && DEFERRED_TOOLS.is_match(text)
}

/// `isSessionPreviewNoise`.
pub fn is_session_preview_noise(text: &str) -> bool {
    let value = js_trim(text);
    value.is_empty()
        || is_routine_quiet_reply(value)
        || SYNTHETIC.iter().any(|re| re.is_match(value))
        || CONTROL_MARKER_RE.is_match(value)
        || clean_session_preview(value, 160).is_empty()
        || is_late_tool_announcement(value)
}
