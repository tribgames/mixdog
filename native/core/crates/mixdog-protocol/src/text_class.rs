//! Node's text rules for control rows persisted as user messages
//! (`shared/tool-execution-contract.mjs` `isInternalTranscriptDisplayText`,
//! `isTranscriptCancelledStatusText` and what they call, with
//! `task-notification-envelope.mjs` `parseTaskNotification`), ported rule for rule.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;

fn re(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

static NOTIFICATION_FIELD: LazyLock<JsRegex> = LazyLock::new(|| re(r"^<([\w-]+)>([^<]*)<\/\1>$", "gm"));
static SURFACE_TASK: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(\S+) task ", ""));
static BRACKETED_SHELL_STATUS: LazyLock<JsRegex> = LazyLock::new(|| {
    re(
        r"^\[status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled|error|timeout|done|success)\]",
        "im",
    )
});
static BRACKETED_TASK_ID: LazyLock<JsRegex> = LazyLock::new(|| re(r"^\[task_id:\s*\S+\]", "im"));
static BACKGROUND_HEAD: LazyLock<JsRegex> = LazyLock::new(|| re(r"^background task\b", "i"));
static TASK_ID_LINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^task_id:\s*\S+", "im"));
static STATUS_LINE: LazyLock<JsRegex> = LazyLock::new(|| {
    re(r"^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b", "im")
});
static DESCRIPTOR_LINE: LazyLock<JsRegex> = LazyLock::new(|| {
    re(r"^(?:surface|operation|type|target|role|agent|preset|model|effort|fast|notification):\s*", "im")
});
static ASYNC_HEADER: LazyLock<JsRegex> = LazyLock::new(|| re(r"^Async .+ finished\.", "i"));
static CONTEXT: LazyLock<JsRegex> = LazyLock::new(|| {
    re(r"^<(?:system-reminder|skill|memory-context|mcp-instructions|available-deferred-tools|event)\b", "i")
});
static SYNTHETIC: LazyLock<JsRegex> = LazyLock::new(|| {
    re(
        r"^(?:\[mixdog-runtime\]|A previous model worked on this task and produced the compacted handoff summary below\b|Re-attached after compaction\b|Reference files:\s)",
        "i",
    )
});
static USER_INTERRUPT: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^\[request interrupted by user(?: for tool use)?\]$", "i"));
static CANCELLED_STATUS: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^\[request interrupted(?: by process restart)?\]$", "i"));
static RESULT_MARK: LazyLock<JsRegex> = LazyLock::new(|| re(r"\bResult:\s*(?:\r?\n|$)", "i"));
static LOOSE_RESULT_SPLIT: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"\r?\n(?:[ \t]*\r?\n)?Result:[ \t]*\r?\n", "i"));

/// `value.split(/\r?\n/)`.
pub fn split_lines(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(at) = rest.find('\n') {
        let piece = &rest[..at];
        out.push(piece.strip_suffix('\r').unwrap_or(piece));
        rest = &rest[at + 1..];
    }
    out.push(rest);
    out
}

/// The outer fields of a `<task-notification>` envelope.
pub struct TaskNotification {
    pub task_id: String,
    pub tag: String,
    pub surface: String,
    pub status: String,
    pub summary: String,
    pub result: String,
    pub error: String,
}

/// `parseTaskNotification`: only the outer fields; a result may itself hold tags.
pub fn parse_task_notification(text: &str) -> Option<TaskNotification> {
    const OPEN: &str = "<task-notification>\n";
    const CLOSE: &str = "\n</task-notification>";
    let value = js_trim(text);
    if !value.starts_with(OPEN) || !value.ends_with(CLOSE) {
        return None;
    }
    let mut fields_text = if value.len() >= OPEN.len() + CLOSE.len() {
        value[OPEN.len()..value.len() - CLOSE.len()].to_owned()
    } else {
        String::new()
    };
    let mut result = String::new();
    if let Some(start) = fields_text.find("\n<result>\n") {
        let end = fields_text.rfind("\n</result>")?;
        if end < start {
            return None;
        }
        let body_start = start + "\n<result>\n".len();
        result = if end > body_start { fields_text[body_start..end].to_owned() } else { String::new() };
        fields_text = format!("{}{}", &fields_text[..start], &fields_text[end + "\n</result>".len()..]);
    }
    let mut fields: HashMap<String, String> = HashMap::new();
    for caps in NOTIFICATION_FIELD.captures_iter(&fields_text) {
        let decoded = caps
            .get(2)
            .unwrap_or_default()
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&");
        fields.insert(caps.get(1).unwrap_or_default().to_owned(), decoded);
    }
    let field = |name: &str| fields.get(name).cloned().unwrap_or_default();
    let status = field("status");
    let summary = field("summary");
    if field("task-id").is_empty() || !matches!(status.as_str(), "completed" | "failed" | "cancelled") || summary.is_empty()
    {
        return None;
    }
    let surface = if summary.starts_with("Agent \"") {
        "agent".to_owned()
    } else if summary.starts_with("Shell task ") {
        "shell".to_owned()
    } else {
        SURFACE_TASK
            .captures(&summary)
            .and_then(|c| c.get(1))
            .unwrap_or("tool")
            .to_owned()
    };
    Some(TaskNotification {
        task_id: field("task-id"),
        tag: field("tag"),
        surface,
        status,
        summary,
        result,
        error: field("error"),
    })
}

fn is_bracketed_shell_notification_envelope(value: &str) -> bool {
    let value = js_trim(value);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some_and(|n| n.surface == "shell") {
        return true;
    }
    BRACKETED_TASK_ID.is_match(value) && BRACKETED_SHELL_STATUS.is_match(value)
}

/// `isInternalRuntimeNotificationText(text)`.
pub fn is_internal_runtime_notification_text(text: &str) -> bool {
    let value = js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some() || is_bracketed_shell_notification_envelope(value) {
        return true;
    }
    TASK_ID_LINE.is_match(value)
        && STATUS_LINE.is_match(value)
        && (BACKGROUND_HEAD.is_match(value) || DESCRIPTOR_LINE.is_match(value))
}

/// `completionWrapperQuotedLines`: the non-empty lines after the `Result:` separator of an
/// async-completion preamble.
fn completion_wrapper_quoted_lines(text: &str) -> Option<Vec<&str>> {
    let value = js_trim(text);
    let at = value.find("\n\nResult:\n")?;
    let preamble = js_trim(&value[..at]);
    if preamble.is_empty() || !ASYNC_HEADER.is_match(preamble) {
        return None;
    }
    let lines: Vec<&str> = split_lines(&value[at + "\n\nResult:\n".len()..])
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect();
    (!lines.is_empty()).then_some(lines)
}

fn is_model_visible_tool_completion_wrapper(text: &str) -> bool {
    let value = js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some() {
        return true;
    }
    let Some(lines) = completion_wrapper_quoted_lines(value) else {
        return false;
    };
    if !lines.iter().all(|line| line.starts_with("> ")) {
        return false;
    }
    let unquoted: Vec<&str> = lines.iter().map(|line| &line[2..]).collect();
    is_internal_runtime_notification_text(&unquoted.join("\n"))
}

fn is_likely_tool_completion_wrapper(text: &str) -> bool {
    let Some(lines) = completion_wrapper_quoted_lines(text) else {
        return false;
    };
    let quoted = lines.iter().filter(|line| line.starts_with("> ")).count();
    quoted as f64 / lines.len() as f64 >= 0.8
}

/// `isInternalTranscriptDisplayText(text)` with the lenient wrapper guess (restore's use).
pub fn is_internal_transcript_display_text(text: &str) -> bool {
    let value = js_trim(text);
    if value.is_empty() {
        return false;
    }
    if CONTEXT.is_match(value)
        || SYNTHETIC.is_match(value)
        || USER_INTERRUPT.is_match(value)
        || is_internal_runtime_notification_text(value)
        || is_model_visible_tool_completion_wrapper(value)
        || is_likely_tool_completion_wrapper(value)
    {
        return true;
    }
    if ASYNC_HEADER.is_match(value) && !RESULT_MARK.is_match(value) {
        return true;
    }
    let Some(split) = LOOSE_RESULT_SPLIT.find(value) else {
        return false;
    };
    if !ASYNC_HEADER.is_match(js_trim(&value[..split.start])) {
        return false;
    }
    let body: Vec<&str> = split_lines(&value[split.end..])
        .into_iter()
        .map(|line| match line.strip_prefix('>') {
            Some(rest) => match rest.chars().next() {
                Some(c) if mixdog_js::is_js_space(c) => &rest[c.len_utf8()..],
                _ => rest,
            },
            None => line,
        })
        .collect();
    is_internal_runtime_notification_text(js_trim(&body.join("\n")))
}

/// `isTranscriptCancelledStatusText(text)`.
pub fn is_transcript_cancelled_status_text(text: &str) -> bool {
    CANCELLED_STATUS.is_match(js_trim(text))
}
