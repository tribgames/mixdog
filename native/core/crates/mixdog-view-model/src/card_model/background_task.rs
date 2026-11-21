//! The `background task` result envelope: parsing it, merging the tool args into it and rendering its titles and detail rows
//! (`shared/tool-card-model/background-task.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::time::date_parse;
use mixdog_protocol::text_class::{TaskNotification, parse_task_notification};
use mixdog_tui_style::time_format::format_elapsed;
use serde_json::Map;
use serde_json::Value;

use super::agent_surface::titleize_agent_name;
use super::terminal_status::display_terminal_status;
use super::terminal_status::prefix_elapsed;
use crate::errors::err_text::background_task_failure_status_label;
use crate::errors::err_text::is_background_error_only_body;
use crate::tool_primitives::field;
use crate::tool_primitives::first_truthy;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::truthy;

static HEAD_FIELD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([a-zA-Z][\w-]*):\s*(.*)$", ""));
static LIVE_STATUS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(running|pending|queued)$", "i"));
static QUEUED_STATUS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^queued$", "i"));
static DONE_STATUS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(completed|cancelled|canceled)$", "i"));

/// The surfaces whose background task renders as a Shell job.
const SHELL_TASK_SURFACES: [&str; 5] = ["shell", "bash", "bash_session", "shell_command", "task"];

/// `isBackgroundTaskTool`.
pub fn is_background_task_tool(normalized_name: &str) -> bool {
    let name = js_to_lowercase(normalized_name);
    name == "web_search" || SHELL_TASK_SURFACES.contains(&name.as_str())
}

/// The background task a result envelope or the call's own args describe. Fields the call supplies stay as it supplied
/// them.
#[derive(Clone, Debug, PartialEq)]
pub struct BackgroundMeta {
    pub task_id: String,
    pub surface: Value,
    pub operation: Value,
    pub label: Value,
    pub status: String,
    pub started_at: Value,
    pub finished_at: Value,
    pub body: String,
    pub error: Value,
    /// The call's `type` or `action`; an envelope has none.
    pub kind: Option<Value>,
    pub has_response: bool,
}

impl BackgroundMeta {
    /// The object Node builds.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("taskId".to_owned(), Value::from(self.task_id.clone()));
        map.insert("surface".to_owned(), self.surface.clone());
        map.insert("operation".to_owned(), self.operation.clone());
        map.insert("label".to_owned(), self.label.clone());
        map.insert("status".to_owned(), Value::from(self.status.clone()));
        map.insert("startedAt".to_owned(), self.started_at.clone());
        map.insert("finishedAt".to_owned(), self.finished_at.clone());
        map.insert("body".to_owned(), Value::from(self.body.clone()));
        map.insert("error".to_owned(), self.error.clone());
        if let Some(kind) = &self.kind {
            map.insert("type".to_owned(), kind.clone());
        }
        map.insert("hasResponse".to_owned(), Value::Bool(self.has_response));
        Value::Object(map)
    }
}

fn string_value(text: &str) -> Value {
    Value::from(text.to_owned())
}

/// `parseBackgroundTaskResult`: the task a notification envelope or a `background task` header block describes.
pub fn parse_background_task_result(value: &str) -> Option<BackgroundMeta> {
    let text = js_trim(value);
    if text.is_empty() {
        return None;
    }
    if let Some(notification) = parse_task_notification(text) {
        return Some(meta_from_notification(notification));
    }
    parse_header_block(text)
}

fn meta_from_notification(notification: TaskNotification) -> BackgroundMeta {
    let has_response = !notification.result.is_empty() && !is_background_error_only_body(&notification.result, &notification.error, None);
    BackgroundMeta {
        task_id: notification.task_id,
        surface: Value::from(notification.surface),
        operation: string_value(""),
        label: Value::from(notification.tag),
        status: notification.status,
        started_at: string_value(""),
        finished_at: string_value(""),
        body: notification.result,
        error: Value::from(notification.error),
        kind: None,
        has_response,
    }
}

fn parse_header_block(text: &str) -> Option<BackgroundMeta> {
    let all_lines: Vec<&str> = text.split('\n').collect();
    let start = all_lines.iter().position(|line| js_trim(line) == "background task")?;
    let rest = &all_lines[start + 1..];
    let blank = rest.iter().position(|line| js_trim(line).is_empty());
    let head_lines = blank.map_or(rest, |at| &rest[..at]);
    let body = blank.map_or_else(String::new, |at| js_trim(&rest[at + 1..].join("\n")).to_owned());
    let mut fields: Map<String, Value> = Map::new();
    for line in head_lines {
        if let Some(found) = HEAD_FIELD.captures(js_trim(line)) {
            fields.insert(js_to_lowercase(found.get(1).unwrap_or_default()), string_value(js_trim(found.get(2).unwrap_or_default())));
        }
    }
    let text_of = |key: &str| fields.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let pick = |keys: &[&str]| keys.iter().map(|key| text_of(key)).find(|text| !text.is_empty()).unwrap_or_default();
    let status = js_to_lowercase(&text_of("status"));
    let error = text_of("error");
    let has_response = !body.is_empty() && !is_background_error_only_body(&body, &error, None) && !LIVE_STATUS.is_match(&status);
    Some(BackgroundMeta {
        task_id: pick(&["task_id", "taskid"]),
        surface: string_value(&text_of("surface")),
        operation: string_value(&text_of("operation")),
        label: string_value(&text_of("label")),
        status,
        started_at: string_value(&pick(&["started", "startedat"])),
        finished_at: string_value(&pick(&["finished", "finishedat"])),
        body,
        error: string_value(&error),
        kind: None,
        has_response,
    })
}

/// `String(args.a || args.b || '')` kept as the value the call supplied (`''` when none is truthy).
fn supplied(args: &Value, keys: &[&str]) -> Value {
    let picked = first_truthy(args, keys);
    if truthy(picked) { picked.cloned().unwrap_or_else(|| string_value("")) } else { string_value("") }
}

fn background_task_meta_from_args(args: &Value) -> Option<BackgroundMeta> {
    let task_id = js_trim(&text_or_empty(first_truthy(args, &["task_id", "taskId"]))).to_owned();
    if task_id.is_empty() {
        return None;
    }
    Some(BackgroundMeta {
        task_id,
        surface: supplied(args, &["surface"]),
        operation: supplied(args, &["operation"]),
        label: supplied(args, &["label"]),
        status: js_to_lowercase(&text_or_empty(field(args, "status"))),
        started_at: supplied(args, &["startedAt", "started"]),
        finished_at: supplied(args, &["finishedAt", "finished"]),
        body: String::new(),
        error: supplied(args, &["error"]),
        kind: Some(supplied(args, &["type", "action"])),
        has_response: false,
    })
}

/// `resolveBackgroundTaskMeta`: the envelope in the result with the call's args filling what it lacks, else the args alone.
pub fn resolve_background_task_meta(parsed_args: &Value, result_text: &str) -> Option<BackgroundMeta> {
    let Some(mut parsed) = parse_background_task_result(result_text) else { return background_task_meta_from_args(parsed_args) };
    if !truthy(Some(&parsed.error)) && truthy(field(parsed_args, "error")) {
        parsed.error = field(parsed_args, "error").cloned().unwrap_or(Value::Null);
    }
    if parsed.status.is_empty() && truthy(field(parsed_args, "status")) {
        parsed.status = js_to_lowercase(&text_or_empty(field(parsed_args, "status")));
    }
    if !truthy(Some(&parsed.surface)) && truthy(field(parsed_args, "surface")) {
        parsed.surface = field(parsed_args, "surface").cloned().unwrap_or(Value::Null);
    }
    Some(parsed)
}

/// The time between two timestamps as a label, else the fallback.
fn elapsed_between(started: Option<&Value>, finished: Option<&Value>, fallback: &str) -> String {
    let started_ms = date_parse(&text_or_empty(started));
    let finished_ms = date_parse(&text_or_empty(finished));
    if started_ms.is_finite() && finished_ms.is_finite() && finished_ms >= started_ms {
        let elapsed_ms = finished_ms - started_ms;
        return if elapsed_ms >= 1000.0 { format_elapsed(elapsed_ms) } else { String::new() };
    }
    fallback.to_owned()
}

/// `backgroundTaskElapsed` of a task's meta.
pub fn background_task_elapsed(meta: &BackgroundMeta, fallback: &str) -> String {
    elapsed_between(Some(&meta.started_at), Some(&meta.finished_at), fallback)
}

/// `backgroundTaskElapsed` of the call's own args (`startedAt` and `finishedAt` only).
pub fn background_task_args_elapsed(args: &Value, fallback: &str) -> String {
    elapsed_between(field(args, "startedAt"), field(args, "finishedAt"), fallback)
}

fn background_task_display_name(normalized_name: &str, meta: &BackgroundMeta) -> String {
    let own = text_or_empty(Some(&meta.surface));
    let surface = js_to_lowercase(if own.is_empty() { normalized_name } else { &own });
    if surface == "web_search" {
        return "Web Search".to_owned();
    }
    if SHELL_TASK_SURFACES.contains(&surface.as_str()) {
        return "Shell".to_owned();
    }
    titleize_agent_name(if surface.is_empty() { "Task" } else { &surface })
}

/// `taskControlTitle`: task control keeps its own verb whatever surface the task belongs to.
pub fn task_control_title(normalized_name: &str, args: &Value) -> &'static str {
    if js_to_lowercase(normalized_name) != "task" {
        return "";
    }
    match js_to_lowercase(&text_or_empty(first_truthy(args, &["action", "type"]))).as_str() {
        "list" => "List tasks",
        "read" | "status" => "Read task",
        "wait" => "Wait for task",
        "cancel" => "Cancel task",
        _ => "",
    }
}

/// `backgroundTaskResultTitle`.
pub fn background_task_result_title(normalized_name: &str, meta: &BackgroundMeta) -> String {
    let display = background_task_display_name(normalized_name, meta);
    match display.as_str() {
        "Shell" => "Shell output".to_owned(),
        "Web Search" => "Web Search results".to_owned(),
        _ => format!("{display} response"),
    }
}

/// `backgroundTaskActionTitle`.
pub fn background_task_action_title(normalized_name: &str, meta: &BackgroundMeta) -> String {
    let display = background_task_display_name(normalized_name, meta);
    if QUEUED_STATUS.is_match(&meta.status) {
        return format!("Queued {display}");
    }
    if LIVE_STATUS.is_match(&meta.status) {
        let progress = meta.kind.as_ref().is_some_and(|kind| js_to_lowercase(&text_or_empty(Some(kind))) == "progress");
        return if progress { format!("{display} progress") } else { format!("Started {display}") };
    }
    if meta.has_response {
        return background_task_result_title(normalized_name, meta);
    }
    format!("{display} status")
}

/// `backgroundTaskFailureDetail`: the compact failure label of a background task, empty without an error.
pub fn background_task_failure_detail(meta: &BackgroundMeta, parsed_args: &Value) -> String {
    let status = if meta.status.is_empty() { field(parsed_args, "status").cloned() } else { Some(string_value(&meta.status)) };
    let error = if truthy(Some(&meta.error)) { Some(meta.error.clone()) } else { field(parsed_args, "error").cloned() };
    if !truthy(error.as_ref()) {
        return String::new();
    }
    let surface = if truthy(Some(&meta.surface)) { Some(meta.surface.clone()) } else { field(parsed_args, "surface").cloned() };
    background_task_failure_status_label(status.as_ref(), error.as_ref(), &text_or_empty(surface.as_ref()), None)
}

/// `backgroundTaskDetail`: "Running · task_id: T1 · first body line", the elapsed time last.
pub fn background_task_detail(meta: &BackgroundMeta, elapsed: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let status = if QUEUED_STATUS.is_match(&meta.status) { "Queued" } else { display_terminal_status(&meta.status) };
    if !status.is_empty() {
        parts.push(status.to_owned());
    }
    if !meta.task_id.is_empty() {
        parts.push(format!("task_id: {}", meta.task_id));
    }
    let first_body_line = meta.body.split('\n').map(js_trim).find(|line| !line.is_empty()).unwrap_or_default();
    if !first_body_line.is_empty() && LIVE_STATUS.is_match(&meta.status) {
        parts.push(first_body_line.to_owned());
    }
    prefix_elapsed(&parts.join(" \u{b7} "), elapsed)
}

/// `isBackgroundTaskResponseArgs`: the call itself reports a completed background result.
pub fn is_background_task_response_args(normalized_name: &str, args: &Value) -> bool {
    if !is_background_task_tool(normalized_name) {
        return false;
    }
    let kind = js_to_lowercase(&text_or_empty(first_truthy(args, &["type", "action"])));
    let status = js_to_lowercase(&text_or_empty(field(args, "status")));
    if LIVE_STATUS.is_match(&status) {
        return false;
    }
    kind == "result" || kind == "completion" || (DONE_STATUS.is_match(&status) && truthy(field(args, "task_id")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_envelope_block_is_parsed() {
        let text = "noise\nbackground task\nstatus: Running\ntask_id: T-9\nstarted: 2026-01-01T00:00:00Z\n\nline one\nline two";
        let meta = parse_background_task_result(text).expect("an envelope");
        assert_eq!((meta.task_id.as_str(), meta.status.as_str(), meta.body.as_str()), ("T-9", "running", "line one\nline two"));
        assert!(!meta.has_response);
        assert!(parse_background_task_result("plain").is_none());
        let done = parse_background_task_result("background task\nstatus: done\n\nout").expect("an envelope");
        assert!(done.has_response);
    }

    #[test]
    fn the_args_fill_what_the_envelope_lacks() {
        let args = json!({ "status": "Failed", "error": "boom", "surface": "bash", "task_id": "T1" });
        let merged = resolve_background_task_meta(&args, "background task\ntask_id: T1").expect("meta");
        assert_eq!((merged.status.as_str(), merged.error.clone(), merged.surface.clone()), ("failed", json!("boom"), json!("bash")));
        let from_args = resolve_background_task_meta(&args, "no envelope").expect("meta");
        assert_eq!(from_args.kind, Some(json!("")));
        assert!(resolve_background_task_meta(&json!({}), "no envelope").is_none());
    }

    #[test]
    fn titles_and_details() {
        let meta = resolve_background_task_meta(&json!({ "task_id": "T1", "status": "running", "surface": "web_search" }), "").expect("meta");
        assert_eq!(background_task_action_title("web_search", &meta), "Started Web Search");
        assert_eq!(background_task_detail(&meta, "12s"), "Running \u{b7} task_id: T1 \u{b7} 12s");
        let done = parse_background_task_result("background task\nsurface: shell\nstatus: done\n\nout").expect("envelope");
        assert_eq!(background_task_result_title("task", &done), "Shell output");
        assert_eq!(background_task_action_title("task", &done), "Shell output");
        assert_eq!(task_control_title("task", &json!({ "action": "wait" })), "Wait for task");
        assert_eq!(task_control_title("shell", &json!({ "action": "wait" })), "");
    }

    #[test]
    fn elapsed_comes_from_the_timestamps() {
        let meta = resolve_background_task_meta(&json!({ "task_id": "T", "startedAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:00:42Z" }), "")
            .expect("meta");
        assert_eq!(background_task_elapsed(&meta, "fallback"), "42s");
        assert_eq!(background_task_args_elapsed(&json!({ "startedAt": "x" }), "fallback"), "fallback");
        assert_eq!(background_task_args_elapsed(&json!({ "startedAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:00:00Z" }), "f"), "");
    }

    #[test]
    fn response_args_are_recognised() {
        assert!(is_background_task_response_args("bash", &json!({ "type": "result" })));
        assert!(is_background_task_response_args("task", &json!({ "status": "completed", "task_id": "T" })));
        assert!(!is_background_task_response_args("task", &json!({ "status": "running", "type": "result" })));
        assert!(!is_background_task_response_args("read", &json!({ "type": "result" })));
    }
}
