//! The completion and agent envelopes a 1.4.5 restore turns into tool cards: Node's
//! `transcript-restore/agent-envelope.mjs` (`parseModelVisibleCompletionWrapper`,
//! `completionCardFromExecution`, `parseSyntheticAgentMessage` and what they call), ported
//! rule for rule.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_protocol::text_class::parse_task_notification;
use serde_json::Map;
use serde_json::Value;

use super::js::Obj;
use super::js::or_str;
use super::js::re;
use super::js::replace_first;
use super::js::split_lines;
use super::js::truthy;

/// A parsed envelope: the fields `restoredNotificationToolItem` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub name: String,
    pub label: String,
    pub args: Map<String, Value>,
    pub result: String,
    /// `undefined` when the parser left it unset.
    pub raw_result: Option<String>,
    /// `undefined` when the parser left it unset; the shell form can yield `''`.
    pub is_error: Option<Value>,
}

const CARD_SURFACES: [&str; 3] = ["agent", "shell", "web_search"];

static TERMINAL_ERROR_STATUS: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^(failed|error|timeout|cancelled|canceled|killed|denied)$", "i"));
static AGENT_RESULT_HEAD: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent result\b", "i"));
static AGENT_RESULT_LINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent result[^\n]*(?:\n|$)", "i"));
static SYNTHETIC_TAGS: LazyLock<JsRegex> = LazyLock::new(|| {
    re(
        r"<\/?(?:final-answer|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>",
        "gi",
    )
});
static ATTR: LazyLock<JsRegex> = LazyLock::new(|| re(r#"([a-zA-Z][\w-]*)=("[^"]*"|'[^']*'|\S+)"#, "g"));
static ATTR_QUOTES: LazyLock<JsRegex> = LazyLock::new(|| re(r#"^["']|["']$"#, "g"));
static PROVIDER_MODEL: LazyLock<JsRegex> = LazyLock::new(|| re(r"\s([a-zA-Z0-9_.-]+)\/([^\s]+)\s*$", "i"));
static BACKGROUND_HEAD: LazyLock<JsRegex> = LazyLock::new(|| re(r"^background task\b", "i"));
static FIELD_LINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^([a-zA-Z][\w-]*):\s*(.*)$", ""));
static NON_TERMINAL: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(running|pending|queued)$", "i"));
static ERROR_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| re(r"^error:", "i"));
static BLANK_GAP: LazyLock<JsRegex> = LazyLock::new(|| re(r"\n\s*\n", ""));
static ASYNC_PREAMBLE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^Async \S+.* finished\.$", "i"));
static QUOTED_LINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^> ", ""));
static QUOTE_MARK: LazyLock<JsRegex> = LazyLock::new(|| re(r"^> ?", ""));
static INLINE_STATUS: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(?:status|state):\s*([^\s·,;]+)", "im"));
static ERROR_TOOL_STATUS: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^(failed|error|timeout|cancelled|canceled|killed)$", "i"));
static SHELL_ERROR_STATUS: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^(failed|error|timeout|cancelled|killed)$", "i"));
static JOB_AGENT_TASK: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent task:\s*([^\s]+)", "m"));
static JOB_TASK_ID: LazyLock<JsRegex> = LazyLock::new(|| re(r"^task_id:\s*([^\s]+)", "m"));
static JOB_STATUS: LazyLock<JsRegex> = LazyLock::new(|| re(r"^status:\s*([^\s(]+)", "m"));
static JOB_TYPE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^type:\s*(.+)$", "m"));
static JOB_TARGET: LazyLock<JsRegex> = LazyLock::new(|| re(r"^target:\s*(.+)$", "m"));
static JOB_AGENT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent:\s*(.+)$", "m"));
static JOB_PRESET: LazyLock<JsRegex> = LazyLock::new(|| re(r"^preset:\s*(.+)$", "m"));
static JOB_AGENT_TASK_ANY: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent task:\s*", "im"));
static JOB_AGENT_RESULT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent result\b", "im"));
static JOB_SURFACE_AGENT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^surface:\s*agent\s*$", "im"));
static JOB_PROVIDER: LazyLock<JsRegex> = LazyLock::new(|| re(r"^provider:\s*(.+)$", "m"));
static JOB_MODEL: LazyLock<JsRegex> = LazyLock::new(|| re(r"^model:\s*(.+)$", "m"));
static JOB_PROVIDER_MODEL: LazyLock<JsRegex> = LazyLock::new(|| re(r"^([^/\s]+)\/(.+)$", ""));
static JOB_EFFORT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^effort:\s*(.+)$", "m"));
static JOB_FAST: LazyLock<JsRegex> = LazyLock::new(|| re(r"^fast:\s*(on|off|true|false)$", "m"));
static FAST_ON: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(on|true)$", "i"));
static RESULTISH_ACTION: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(notification|result|completion)$", "i"));
static ERROR_LINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^error:\s*", "i"));
static STRIP_ERROR_PREFIX: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^\s*(?:\[[^\]]*error[^\]]*\]|error)\s*[:-]\s*", "i"));

const RESULT_SPLIT: &str = "\n\nResult:\n";

fn lower(value: &str) -> String {
    value.to_lowercase()
}

/// `textBetweenTag(text, tag)`.
pub fn text_between_tag(text: &str, tag: &str) -> String {
    let pattern = JsRegex::new_static(&format!(r"<{tag}[^>]*>([\s\S]*?)<\/{tag}>"), "i");
    pattern
        .captures(text)
        .map(|c| js_trim(c.get(1).unwrap_or_default()).to_owned())
        .unwrap_or_default()
}

fn strip_synthetic_agent_tags(text: &str) -> String {
    let value = js_trim(text);
    let final_answer = text_between_tag(value, "final-answer");
    if !final_answer.is_empty() {
        return final_answer;
    }
    let task_result = text_between_tag(value, "result");
    if !task_result.is_empty() {
        return task_result;
    }
    let headless = replace_first(&AGENT_RESULT_LINE, value, "");
    js_trim(&SYNTHETIC_TAGS.replace_all_with(&headless, |_| String::new())).to_owned()
}

fn split_bridge_body(text: &str) -> String {
    let value = js_trim(text);
    match BLANK_GAP.find(value) {
        Some(range) => js_trim(&value[range.end..]).to_owned(),
        None => String::new(),
    }
}

fn job_status_text(status: &str, task_id: &str) -> String {
    let mut parts = Vec::new();
    if !status.is_empty() {
        parts.push(format!("status: {status}"));
    }
    if !task_id.is_empty() {
        parts.push(format!("task_id: {task_id}"));
    }
    parts.join(" · ")
}

/// The fallback fields `parseBackgroundTaskEnvelope` hands `parseAgentResultEnvelope`.
#[derive(Default)]
struct Fallback {
    status: String,
    task_id: String,
    tag: String,
    agent: String,
    provider: String,
    model: String,
    preset: String,
    effort: String,
    fast: Option<String>,
}

fn first<'a>(values: &[&'a str]) -> &'a str {
    values.iter().copied().find(|v| !v.is_empty()).unwrap_or("")
}

fn parse_agent_result_envelope(text: &str, fallback: &Fallback) -> Option<Parsed> {
    let value = js_trim(text);
    if !AGENT_RESULT_HEAD.is_match(value) {
        return None;
    }
    let (head, rest) = value.split_once('\n').unwrap_or((value, ""));
    let body = strip_synthetic_agent_tags(rest);
    let mut attrs: HashMap<String, String> = HashMap::new();
    for caps in ATTR.captures_iter(head) {
        let raw = caps.get(2).unwrap_or_default();
        attrs.insert(lower(caps.get(1).unwrap_or_default()), ATTR_QUOTES.replace_all_with(raw, |_| String::new()));
    }
    let attr = |name: &str| attrs.get(name).map(String::as_str).unwrap_or("");
    let provider_model = PROVIDER_MODEL.captures(head);
    let pm = |group: usize| provider_model.as_ref().and_then(|c| c.get(group)).unwrap_or("");
    let agent = first(&[attr("agent"), &fallback.agent]);
    let status = first(&[&fallback.status, attr("status"), "completed"]).to_owned();
    let task_id = first(&[&fallback.task_id, attr("task_id"), attr("taskid")]).to_owned();
    let fast = fallback.fast.clone().or_else(|| attrs.get("fast").cloned());
    let args = Obj::default()
        .put("type", "result")
        .put("status", status.clone())
        .non_empty("task_id", &task_id)
        .non_empty("tag", first(&[&fallback.tag, attr("tag")]))
        .non_empty("agent", agent)
        .non_empty("provider", first(&[&fallback.provider, attr("provider"), pm(1)]))
        .non_empty("model", first(&[&fallback.model, attr("model"), pm(2)]))
        .non_empty("preset", first(&[&fallback.preset, attr("preset")]))
        .non_empty("effort", first(&[&fallback.effort, attr("effort")]))
        .maybe("fast", fast.map(Value::String));
    let result = if body.is_empty() { job_status_text(&status, &task_id) } else { body };
    Some(Parsed {
        name: "agent".into(),
        label: lower(&status),
        args: args.0,
        result,
        raw_result: None,
        is_error: Some(Value::Bool(TERMINAL_ERROR_STATUS.is_match(&status))),
    })
}

fn is_error_tool_status(status: &str) -> bool {
    ERROR_TOOL_STATUS.is_match(js_trim(status))
}

/// `isBackgroundErrorOnlyBody(body, error)`. The `presentErrorText` renderings of `error`
/// are not compared: that presenter is not ported (see the module report).
fn is_background_error_only_body(body: &str, error: &str) -> bool {
    let trimmed = js_trim(body);
    if trimmed.is_empty() {
        return false;
    }
    let err = js_trim(error);
    let lines: Vec<&str> = trimmed.split('\n').map(js_trim).filter(|l| !l.is_empty()).collect();
    if lines.len() != 1 {
        return false;
    }
    let line = lines[0];
    if ERROR_LINE.is_match(line) {
        return true;
    }
    if err.is_empty() {
        return false;
    }
    let stripped = replace_first(&STRIP_ERROR_PREFIX, line, "");
    line == err || line == format!("Error: {err}") || js_trim(&stripped) == err
}

pub fn parse_background_task_envelope(text: &str) -> Option<Parsed> {
    let value = js_trim(text);
    if let Some(n) = parse_task_notification(value) {
        let args = Obj::default()
            .put("type", "result")
            .put("status", n.status.clone())
            .put("task_id", n.task_id.clone())
            .put("surface", n.surface.clone())
            .non_empty("tag", &n.tag)
            .non_empty("label", &n.tag)
            .non_empty("error", &n.error);
        return Some(Parsed {
            name: n.surface.clone(),
            label: n.status.clone(),
            args: args.0,
            result: first(&[&n.result, &n.error, &n.summary]).to_owned(),
            raw_result: Some(value.to_owned()),
            is_error: Some(Value::Bool(is_error_tool_status(&n.status))),
        });
    }
    if !BACKGROUND_HEAD.is_match(value) {
        return None;
    }
    let all_lines: Vec<&str> = value.split('\n').collect();
    let rest = &all_lines[1..];
    let blank = rest.iter().position(|line| js_trim(line).is_empty());
    let head_lines = match blank {
        Some(at) => &rest[..at],
        None => rest,
    };
    let body = match blank {
        Some(at) => js_trim(&rest[at + 1..].join("\n")).to_owned(),
        None => String::new(),
    };
    let mut fields: HashMap<String, String> = HashMap::new();
    for line in head_lines {
        if let Some(caps) = FIELD_LINE.captures(js_trim(line)) {
            fields.insert(
                lower(caps.get(1).unwrap_or_default()),
                js_trim(caps.get(2).unwrap_or_default()).to_owned(),
            );
        }
    }
    let field = |name: &str| fields.get(name).map(String::as_str).unwrap_or("");
    let surface = lower(first(&[field("surface"), field("operation"), "task"]));
    let name = if CARD_SURFACES.contains(&surface.as_str()) { surface.clone() } else { "task".into() };
    let status = lower(field("status"));
    let task_id = first(&[field("task_id"), field("taskid")]).to_owned();
    let error_text = field("error").to_owned();
    let fallback = Fallback {
        status: status.clone(),
        task_id: task_id.clone(),
        tag: first(&[field("tag"), field("label")]).to_owned(),
        agent: field("agent").to_owned(),
        provider: field("provider").to_owned(),
        model: field("model").to_owned(),
        preset: field("preset").to_owned(),
        effort: field("effort").to_owned(),
        fast: fields.get("fast").cloned(),
    };
    if let Some(agent_result) = parse_agent_result_envelope(&body, &fallback) {
        return Some(Parsed { raw_result: Some(value.to_owned()), ..agent_result });
    }
    let error_only_body = is_background_error_only_body(&body, &error_text);
    let result_body = if !body.is_empty() && !error_only_body { body.clone() } else { String::new() };
    let mut envelope_type = first(&[field("operation"), "status"]).to_owned();
    if !body.is_empty() {
        envelope_type = if NON_TERMINAL.is_match(&status) { "progress" } else { "result" }.to_owned();
    }
    let status_line = job_status_text(&status, &task_id);
    let args = Obj::default()
        .put("type", envelope_type)
        .put("status", status.clone())
        .non_empty("task_id", &task_id)
        .put("surface", surface.clone())
        .non_empty("operation", field("operation"))
        .non_empty("label", field("label"))
        .non_empty("tag", field("tag"))
        .non_empty("agent", field("agent"))
        .non_empty("provider", field("provider"))
        .non_empty("model", field("model"))
        .non_empty("preset", field("preset"))
        .non_empty("effort", field("effort"))
        .non_empty("fast", field("fast"))
        .non_empty("error", &error_text)
        .non_empty("startedAt", first(&[field("started"), field("startedat")]))
        .non_empty("finishedAt", first(&[field("finished"), field("finishedat")]));
    let result = if !result_body.is_empty() {
        result_body
    } else if !error_text.is_empty() {
        String::new()
    } else {
        status_line
    };
    let is_error = TERMINAL_ERROR_STATUS.is_match(&status) || ERROR_PREFIX.is_match(&body) || !error_text.is_empty();
    Some(Parsed {
        name,
        label: if status.is_empty() { "notification".into() } else { status },
        args: args.0,
        result,
        raw_result: Some(value.to_owned()),
        is_error: Some(Value::Bool(is_error)),
    })
}

fn unquote_lines(section: &str) -> String {
    let lines: Vec<String> = split_lines(section)
        .into_iter()
        .map(|line| replace_first(&QUOTE_MARK, line, ""))
        .collect();
    js_trim(&lines.join("\n")).to_owned()
}

pub fn parse_model_visible_completion_wrapper(text: &str) -> Option<Parsed> {
    let value = js_trim(text);
    if parse_task_notification(value).is_some() {
        return parse_background_task_envelope(value);
    }
    let at = value.find(RESULT_SPLIT)?;
    if !ASYNC_PREAMBLE.is_match(js_trim(&value[..at])) {
        return None;
    }
    let quoted = &value[at + RESULT_SPLIT.len()..];
    if split_lines(quoted).iter().any(|line| !line.is_empty() && !QUOTED_LINE.is_match(line)) {
        return None;
    }
    let unquoted = unquote_lines(quoted);
    let parsed = parse_synthetic_agent_message(&unquoted)?;
    Some(Parsed { raw_result: Some(unquoted), ..parsed })
}

fn bracket_field(text: &str, name: &str) -> String {
    let pattern = JsRegex::new_static(&format!(r"^\[{name}:\s*([^\]]*)\]"), "mi");
    pattern
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|v| js_trim(v).to_owned())
        .unwrap_or_default()
}

fn tool_result_status(value: &str) -> String {
    let tagged = text_between_tag(value, "status");
    if !tagged.is_empty() {
        return js_trim(&tagged).to_owned();
    }
    let bracketed = bracket_field(value, "status");
    if !bracketed.is_empty() {
        return bracketed;
    }
    INLINE_STATUS
        .captures(value)
        .and_then(|c| c.get(1))
        .map(|v| js_trim(v).to_owned())
        .unwrap_or_default()
}

/// `completionCardFromExecution(execution, text)`.
pub fn completion_card_from_execution(execution: Option<&Value>, text: &str) -> Option<Parsed> {
    if let Some(parsed) = parse_model_visible_completion_wrapper(text) {
        return Some(parsed);
    }
    let exec = execution.filter(|e| e.is_object() || e.is_array());
    let value = js_trim(text);
    if exec.is_none() && value.is_empty() {
        return None;
    }
    let get = |key: &str| exec.and_then(|e| e.get(key));
    let surface = lower(&or_str(get("surface"), "task"));
    let name = if CARD_SURFACES.contains(&surface.as_str()) { surface.clone() } else { "task".into() };
    let status_raw = or_str(get("status"), "");
    let status = lower(&if status_raw.is_empty() { tool_result_status(value) } else { status_raw });
    let body = match value.find(RESULT_SPLIT) {
        Some(at) => unquote_lines(&value[at + RESULT_SPLIT.len()..]),
        None => value.to_owned(),
    };
    let task_id = match get("id") {
        Some(id) if truthy(Some(id)) => Some(id.clone()),
        _ => Some(bracket_field(&body, "task_id")).filter(|t| !t.is_empty()).map(Value::String),
    };
    let args = Obj::default()
        .put("type", "result")
        .non_empty("status", &status)
        .maybe("task_id", task_id)
        .put("surface", surface);
    let is_error = is_error_tool_status(&status) || ERROR_PREFIX.is_match(&body);
    Some(Parsed {
        name,
        label: if status.is_empty() { "notification".into() } else { status },
        args: args.0,
        result: body,
        raw_result: Some(value.to_owned()),
        is_error: Some(Value::Bool(is_error)),
    })
}

struct AgentJob {
    task_id: String,
    status: String,
    kind: String,
    target: String,
    agent: String,
    preset: String,
    provider: String,
    model: String,
    effort: String,
    fast: Option<bool>,
}

/// `parseAgentJob` for a text that is not a task notification.
fn parse_agent_job(value: &str) -> Option<AgentJob> {
    let id = JOB_AGENT_TASK.captures(value).or_else(|| JOB_TASK_ID.captures(value))?;
    let group = |pattern: &JsRegex| -> String {
        pattern
            .captures(value)
            .and_then(|c| c.get(1).map(str::to_owned))
            .unwrap_or_default()
    };
    let is_agent_envelope = JOB_AGENT_TASK_ANY.is_match(value)
        || JOB_AGENT_RESULT.is_match(value)
        || JOB_SURFACE_AGENT.is_match(value);
    let provider_line = if is_agent_envelope { group(&JOB_PROVIDER) } else { String::new() };
    let model_line = if is_agent_envelope { group(&JOB_MODEL) } else { String::new() };
    let model_trimmed = js_trim(&model_line).to_owned();
    let provider_model = JOB_PROVIDER_MODEL.captures(&model_trimmed);
    let pm = |g: usize| provider_model.as_ref().and_then(|c| c.get(g)).unwrap_or("").to_owned();
    let fast = JOB_FAST
        .captures(value)
        .and_then(|c| c.get(1).map(|v| FAST_ON.is_match(v)));
    Some(AgentJob {
        task_id: id.get(1).unwrap_or_default().to_owned(),
        status: lower(&group(&JOB_STATUS)),
        kind: js_trim(&group(&JOB_TYPE)).to_owned(),
        target: js_trim(&group(&JOB_TARGET)).to_owned(),
        agent: js_trim(&group(&JOB_AGENT)).to_owned(),
        preset: js_trim(&group(&JOB_PRESET)).to_owned(),
        provider: js_trim(first(&[&provider_line, &pm(1)])).to_owned(),
        model: js_trim(first(&[&pm(2), &model_line])).to_owned(),
        effort: js_trim(&group(&JOB_EFFORT)).to_owned(),
        fast,
    })
}

/// `agentArgsWithResultMetadata({type, description: 'agent notification'}, job)`.
fn agent_args(kind: &str, job: &AgentJob) -> Map<String, Value> {
    let mut next = Map::new();
    next.insert("type".into(), Value::String(kind.to_owned()));
    next.insert("description".into(), Value::String("agent notification".into()));
    let requested = lower(js_trim(kind));
    if !job.kind.is_empty() {
        if requested.is_empty() || RESULTISH_ACTION.is_match(&requested) {
            next.insert("type".into(), Value::String(job.kind.clone()));
        } else {
            next.insert("jobType".into(), Value::String(job.kind.clone()));
        }
    }
    let mut set = |key: &str, value: &str| {
        if !value.is_empty() {
            next.insert(key.into(), Value::String(value.to_owned()));
        }
    };
    set("status", &job.status);
    set("task_id", &job.task_id);
    set("agent", &job.agent);
    set("preset", &job.preset);
    set("provider", &job.provider);
    set("model", &job.model);
    set("effort", &job.effort);
    if let Some(fast) = job.fast {
        next.insert("fast".into(), Value::Bool(fast));
    }
    if !job.target.is_empty() {
        let target = job.target.split(mixdog_js::is_js_space).next().unwrap_or("");
        if !target.is_empty() && !target.starts_with("sess_") {
            next.insert("tag".into(), Value::String(target.to_owned()));
        }
    }
    next
}

fn agent_job_result_text(value: &str, job: &AgentJob) -> String {
    let value = js_trim(value);
    if value.is_empty() {
        return String::new();
    }
    if !job.task_id.is_empty() {
        let clean = strip_synthetic_agent_tags(&split_bridge_body(value));
        if !clean.is_empty() {
            return clean;
        }
        return job_status_text(&job.status, &job.task_id);
    }
    let stripped = strip_synthetic_agent_tags(value);
    if stripped.is_empty() { value.to_owned() } else { stripped }
}

/// `parseSyntheticAgentMessage(text)`.
pub fn parse_synthetic_agent_message(text: &str) -> Option<Parsed> {
    let value = js_trim(text);
    if value.is_empty() {
        return None;
    }
    if parse_task_notification(value).is_some() {
        return parse_background_task_envelope(value);
    }
    let final_answer = text_between_tag(value, "final-answer");
    if !final_answer.is_empty() {
        let args = Obj::default().put("type", "read").put("description", "agent result");
        return Some(Parsed {
            name: "agent".into(),
            label: "final".into(),
            args: args.0,
            result: final_answer,
            raw_result: None,
            is_error: None,
        });
    }
    if let Some(parsed) = parse_agent_result_envelope(value, &Fallback::default()) {
        return Some(parsed);
    }
    if let Some(parsed) = parse_background_task_envelope(value) {
        return Some(parsed);
    }
    let shell_task_id = bracket_field(value, "task_id");
    if !shell_task_id.is_empty() {
        let status = first(&[&bracket_field(value, "status"), "done"]).to_owned();
        let exit = bracket_field(value, "exit");
        let command = bracket_field(value, "command");
        let is_error = if SHELL_ERROR_STATUS.is_match(&status) {
            Value::Bool(true)
        } else if exit.is_empty() {
            Value::String(String::new())
        } else {
            Value::Bool(exit != "0" && exit != "n/a")
        };
        let args = Obj::default()
            .put("type", "result")
            .put("task_id", shell_task_id)
            .put("command", command);
        return Some(Parsed {
            name: "shell".into(),
            label: status,
            args: args.0,
            result: value.to_owned(),
            raw_result: None,
            is_error: Some(is_error),
        });
    }
    let job = parse_agent_job(value)?;
    if job.task_id.is_empty() {
        return None;
    }
    let label = first(&[&job.status, "notification"]).to_owned();
    let result = agent_job_result_text(value, &job);
    let result = first(&[&result, &job_status_text(&job.status, &job.task_id), "agent notification"]).to_owned();
    let kind = first(&[&job.kind, "notification"]).to_owned();
    Some(Parsed {
        name: "agent".into(),
        args: agent_args(&kind, &job),
        is_error: Some(Value::Bool(TERMINAL_ERROR_STATUS.is_match(&label))),
        label,
        result,
        raw_result: None,
    })
}

/// `restoredNotificationToolItem`'s card fields for `parsed` (the row's id, message id and
/// times come from the row itself).
pub fn card(parsed: Parsed, text: &str, error_label: &JsRegex) -> Value {
    let label = if parsed.label.is_empty() { "notification".to_owned() } else { parsed.label };
    let is_error = parsed
        .is_error
        .unwrap_or_else(|| Value::Bool(error_label.is_match(&label)));
    let name = if parsed.name.is_empty() { "agent".to_owned() } else { parsed.name };
    Obj::default()
        .put("name", name)
        .put("args", Value::Object(parsed.args))
        .put("result", parsed.result)
        .put("rawResult", parsed.raw_result.unwrap_or_else(|| text.to_owned()))
        .put("isError", is_error)
        .0
        .into()
}
