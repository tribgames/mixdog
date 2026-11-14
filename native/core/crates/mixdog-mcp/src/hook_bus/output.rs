//! What a hook handler run reports, how that is read into a verdict, and how the verdicts of an
//! event's handlers fold into one (the Node hook bus, `handlers.mjs` / `event-runner.mjs`).

use std::time::Duration;

use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;

pub const EXIT2_BLOCK_EVENTS: [&str; 14] = [
    "PreToolUse",
    "PermissionRequest",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "Stop",
    "SubagentStop",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "ConfigChange",
    "PostToolBatch",
    "PreCompact",
    "Elicitation",
    "ElicitationResult",
];

pub const TOP_LEVEL_DECISION_EVENTS: [&str; 10] = [
    "PreToolUse",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Stop",
    "SubagentStop",
    "ConfigChange",
    "PreCompact",
];

pub const PLAIN_STDOUT_CONTEXT_EVENTS: [&str; 3] = ["SessionStart", "UserPromptSubmit", "UserPromptExpansion"];

/// Events whose handlers may carry an `if` tool condition.
pub const TOOL_IF_EVENTS: [&str; 5] =
    ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"];

/// Cap on the bytes kept of a handler's output, per stream.
pub const MAX_BUFFER_BYTES: usize = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 10_000;

/// How a handler run ended (`exit_code` 0 = ran, 2 = block, -1 = failed to run).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct HandlerRun {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// The handler could not be started (a spawn or request failure).
    pub spawn_error: Option<String>,
    /// A detached run: nothing was captured.
    pub is_async: bool,
}

impl HandlerRun {
    pub fn failed(stderr: impl Into<String>, timed_out: bool) -> Self {
        Self { exit_code: -1, stderr: stderr.into(), timed_out, ..Self::default() }
    }

    pub fn spawn_failed(message: impl Into<String>) -> Self {
        let message = message.into();
        Self { exit_code: -1, stderr: message.clone(), spawn_error: Some(message), ..Self::default() }
    }
}

/// The text cut at 10000 UTF-16 units, with the original length noted.
pub fn limit_text(text: String) -> String {
    let total = text.encode_utf16().count();
    if total <= MAX_OUTPUT_CHARS {
        return text;
    }
    let kept: String = char::decode_utf16(text.encode_utf16().take(MAX_OUTPUT_CHARS))
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    format!("{kept}\n... [hook output truncated; original {total} chars]")
}

/// `handlerTimeoutS`: the handler's own positive `timeout` (seconds), else the type's or the
/// event's default.
pub fn handler_timeout(handler: &Value, event: &str) -> Duration {
    let own = handler.get("timeout").and_then(Value::as_f64).filter(|t| t.is_finite() && *t > 0.0);
    let kind = handler.get("type").and_then(Value::as_str).unwrap_or_default();
    let seconds = own.unwrap_or(match kind {
        "prompt" => 30.0,
        "agent" => 60.0,
        "mcp_tool" => 600.0,
        _ => match event {
            "UserPromptSubmit" => 30.0,
            "MessageDisplay" => 10.0,
            _ => 600.0,
        },
    });
    Duration::from_millis((seconds * 1000.0).round() as u64)
}

/// A handler's output read for one event.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Parsed {
    pub block: bool,
    /// `continue: false`: the handler asked for the run to stop (a Stop hook's block then does not continue the turn).
    pub prevent_continuation: bool,
    pub reason: Option<String>,
    pub updated_input: Option<Value>,
    pub updated_tool_name: Option<String>,
    pub updated_tool_output: Option<Value>,
    pub additional_context: Option<String>,
    pub ask_reason: Option<String>,
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn plain_object(value: Option<&Value>) -> Option<Value> {
    value.filter(|v| v.is_object()).cloned()
}

/// Reads a run as the event's verdict: exit 2 blocks where the event can be blocked, exit 0
/// carries JSON (`decision`, `continue`, `hookSpecificOutput`) or, for context events, plain text.
pub fn parse_handler_output(run: &HandlerRun, event: &str) -> Parsed {
    let mut out = Parsed::default();
    if run.timed_out || run.spawn_error.is_some() || run.is_async {
        return out;
    }
    if run.exit_code == 2 {
        if EXIT2_BLOCK_EVENTS.contains(&event) {
            out.block = true;
            let stderr = limit_text(js_trim(&run.stderr).to_owned());
            // A Stop block without a reason carries none: the agent loop ignores it with a warning.
            out.reason = if !stderr.is_empty() {
                Some(stderr)
            } else if event == "Stop" {
                None
            } else {
                Some(format!("blocked by {event} hook"))
            };
        }
        return out;
    }
    if run.exit_code != 0 {
        return out;
    }
    let raw = js_trim(&run.stdout);
    if raw.is_empty() {
        return out;
    }
    let plain_context = PLAIN_STDOUT_CONTEXT_EVENTS.contains(&event);
    if !(raw.starts_with('{') || raw.starts_with('[')) {
        if plain_context {
            out.additional_context = Some(limit_text(raw.to_owned()));
        }
        return out;
    }
    let Ok(json) = serde_json::from_str::<Value>(raw) else {
        if plain_context {
            out.additional_context = Some(limit_text(raw.to_owned()));
        }
        return out;
    };
    if !json.is_object() {
        return out;
    }
    if json.get("continue") == Some(&Value::Bool(false)) {
        out.block = true;
        out.prevent_continuation = true;
        let text = non_empty(json.get("stopReason"))
            .or_else(|| non_empty(json.get("reason")))
            .unwrap_or_else(|| format!("stopped by {event} hook"));
        out.reason = Some(limit_text(text));
    }
    // A PreToolUse `permissionDecision` in `hookSpecificOutput` takes precedence over the top-level
    // `decision` (Claude Code and Codex): the top-level block then does not apply.
    let specific_permission = event == "PreToolUse"
        && json
            .get("hookSpecificOutput")
            .filter(|h| h.is_object())
            .filter(|h| h.get("hookEventName").is_none_or(|n| n.is_null() || n.as_str() == Some(event)))
            .and_then(|h| h.get("permissionDecision"))
            .is_some_and(|v| !v.is_null() && v.as_str() != Some(""));
    if json.get("decision").and_then(Value::as_str) == Some("block") && TOP_LEVEL_DECISION_EVENTS.contains(&event) && !specific_permission {
        out.block = true;
        let text = non_empty(json.get("reason")).or_else(|| out.reason.clone().filter(|r| !r.is_empty()));
        out.reason = match text {
            Some(t) => Some(limit_text(t)),
            // A Stop block without a reason stays reasonless so the agent loop ignores it with a warning.
            None if event == "Stop" => None,
            None => Some(format!("blocked by {event} hook")),
        };
    }
    if let Some(text) = json.get("additionalContext").and_then(Value::as_str) {
        out.additional_context = Some(limit_text(text.to_owned()));
    }
    let mut permission_decision: Option<String> = None;
    let specific = json
        .get("hookSpecificOutput")
        .filter(|h| h.is_object())
        .filter(|h| h.get("hookEventName").is_none_or(|n| n.is_null() || n.as_str() == Some(event)));
    if let Some(hso) = specific {
        if let Some(text) = hso.get("additionalContext").and_then(Value::as_str) {
            out.additional_context = Some(limit_text(text.to_owned()));
        }
        if let Some(input) = plain_object(hso.get("updatedInput")) {
            out.updated_input = Some(input);
        }
        if let Some(output) = hso.get("updatedToolOutput").filter(|v| !v.is_null()) {
            out.updated_tool_output = Some(output.clone());
        }
        if let Some(name) = hso.get("updatedToolName").and_then(Value::as_str).map(js_trim).filter(|n| !n.is_empty()) {
            out.updated_tool_name = Some(name.to_owned());
        }
        if let Some(decision) = hso.get("permissionDecision").filter(|v| !v.is_null() && v.as_str() != Some("")) {
            permission_decision = Some(js_string(decision).to_lowercase());
        }
        if let Some(reason) = non_empty(hso.get("permissionDecisionReason")) {
            if out.reason.as_deref().is_none_or(str::is_empty) {
                out.reason = Some(limit_text(reason));
            }
        }
        if event == "PermissionRequest"
            && let Some(decision) = hso.get("decision").filter(|d| d.is_object())
        {
            if js_string(decision.get("behavior").unwrap_or(&Value::Null)).to_lowercase() == "deny" {
                out.block = true;
                if out.reason.as_deref().is_none_or(str::is_empty) {
                    let text = non_empty(decision.get("reason")).unwrap_or_else(|| format!("denied by {event} hook"));
                    out.reason = Some(limit_text(text));
                }
            }
            if let Some(input) = plain_object(decision.get("updatedInput")) {
                out.updated_input = Some(input);
            }
        }
    }
    if event == "PreToolUse" {
        match permission_decision.as_deref() {
            Some("deny") => {
                out.block = true;
                if out.reason.as_deref().is_none_or(str::is_empty) {
                    out.reason = Some(format!("denied by {event} hook"));
                }
            }
            Some("ask") => {
                out.ask_reason = Some(match out.reason.clone().filter(|r| !r.is_empty()) {
                    Some(reason) => reason,
                    None => format!("ask requested by {event} hook"),
                });
            }
            _ => {}
        }
    }
    out
}

fn js_string(value: &Value) -> String {
    value_to_string(value)
}

/// The folded verdict of an event's handlers.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Aggregate {
    pub blocked: bool,
    pub prevent_continuation: bool,
    pub reason: Option<String>,
    pub updated_input: Option<Value>,
    pub updated_tool_name: Option<String>,
    pub updated_tool_output: Option<Value>,
    pub additional_context: Vec<String>,
    pub ask: bool,
    pub ask_reason: Option<String>,
    pub handlers_run: usize,
}

impl Aggregate {
    /// A failed PreToolUse handler denies: the policy check could not be made.
    pub fn fail_closed(&mut self, message: &str) {
        self.blocked = true;
        self.reason = Some(format!("PreToolUse policy check failed: {message}"));
    }

    /// First value wins for rewrites; a block or an ask is recorded once.
    pub fn fold(&mut self, parsed: Parsed) {
        self.prevent_continuation |= parsed.prevent_continuation;
        if let Some(context) = parsed.additional_context.filter(|c| !c.is_empty()) {
            self.additional_context.push(context);
        }
        if self.updated_input.is_none() {
            self.updated_input = parsed.updated_input;
        }
        if self.updated_tool_name.is_none() {
            self.updated_tool_name = parsed.updated_tool_name;
        }
        if self.updated_tool_output.is_none() {
            self.updated_tool_output = parsed.updated_tool_output;
        }
        if let Some(reason) = parsed.ask_reason.filter(|r| !r.is_empty())
            && !self.ask
            && !self.blocked
        {
            self.ask = true;
            self.ask_reason = Some(reason);
        }
        if parsed.block && !self.blocked {
            self.blocked = true;
            self.reason = parsed.reason;
        }
    }
}

/// Why a run is a failure, or `None` when it produced usable output. `kind` names the handler
/// (its shell, `exec`, or its type) and `what` its command or URL.
pub fn run_failure(run: &HandlerRun, kind: &str, what: &str) -> Option<String> {
    if run.timed_out {
        return Some(format!("hook {kind} timed out: {what}"));
    }
    if let Some(error) = &run.spawn_error {
        return Some(format!("hook spawn failed: {error}"));
    }
    if run.exit_code != 0 && run.exit_code != 2 {
        let stderr = js_trim(&run.stderr);
        return Some(if stderr.is_empty() { format!("hook exited {}", run.exit_code) } else { stderr.to_owned() });
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run(code: i32, stdout: &str, stderr: &str) -> HandlerRun {
        HandlerRun { exit_code: code, stdout: stdout.into(), stderr: stderr.into(), ..HandlerRun::default() }
    }

    #[test]
    fn exit_two_blocks_a_blockable_event_with_its_stderr() {
        let parsed = parse_handler_output(&run(2, "", " no way \n"), "PreToolUse");
        assert!(parsed.block);
        assert_eq!(parsed.reason.as_deref(), Some("no way"));
        assert!(!parse_handler_output(&run(2, "", "x"), "SessionStart").block);
        assert_eq!(parse_handler_output(&run(2, "", ""), "PreToolUse").reason.as_deref(), Some("blocked by PreToolUse hook"));
    }

    #[test]
    fn pretool_json_decisions_deny_ask_and_rewrite() {
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"DENY"}}"#;
        let parsed = parse_handler_output(&run(0, deny, ""), "PreToolUse");
        assert!(parsed.block);
        assert_eq!(parsed.reason.as_deref(), Some("denied by PreToolUse hook"));
        let ask = r#"{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"why"}}"#;
        assert_eq!(parse_handler_output(&run(0, ask, ""), "PreToolUse").ask_reason.as_deref(), Some("why"));
        let rewrite = r#"{"hookSpecificOutput":{"updatedInput":{"a":1},"updatedToolName":" t "}}"#;
        let parsed = parse_handler_output(&run(0, rewrite, ""), "PreToolUse");
        assert_eq!((parsed.updated_input, parsed.updated_tool_name), (Some(json!({"a": 1})), Some("t".into())));
        let other_event = r#"{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"deny"}}"#;
        assert!(!parse_handler_output(&run(0, other_event, ""), "PreToolUse").block);
    }

    #[test]
    fn plain_text_is_context_only_for_context_events() {
        assert_eq!(parse_handler_output(&run(0, "hello", ""), "SessionStart").additional_context.as_deref(), Some("hello"));
        assert_eq!(parse_handler_output(&run(0, "hello", ""), "PreToolUse").additional_context, None);
        assert!(parse_handler_output(&run(0, r#"{"decision":"block","reason":"r"}"#, ""), "Stop").block);
        assert!(parse_handler_output(&run(0, r#"{"continue":false}"#, ""), "PreToolUse").block);
        let stopped = parse_handler_output(&run(0, r#"{"continue":false,"decision":"block","reason":"r"}"#, ""), "Stop");
        assert!(stopped.block && stopped.prevent_continuation);
        assert!(!parse_handler_output(&run(0, r#"{"decision":"block","reason":"r"}"#, ""), "Stop").prevent_continuation);
    }

    /// Deliberate difference from Node (owner-approved, B-3): a top-level `decision: "block"` blocks a
    /// PreToolUse call, with a default reason when none is given; `hookSpecificOutput.permissionDecision`
    /// wins over it.
    #[test]
    fn a_top_level_block_stops_a_pretool_call_unless_a_permission_decision_is_given() {
        let with_reason = parse_handler_output(&run(0, r#"{"decision":"block","reason":"nope"}"#, ""), "PreToolUse");
        assert!(with_reason.block);
        assert_eq!(with_reason.reason.as_deref(), Some("nope"));
        let bare = parse_handler_output(&run(0, r#"{"decision":"block"}"#, ""), "PreToolUse");
        assert!(bare.block);
        assert_eq!(bare.reason.as_deref(), Some("blocked by PreToolUse hook"));
        let allowed = r#"{"decision":"block","reason":"x","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#;
        assert!(!parse_handler_output(&run(0, allowed, ""), "PreToolUse").block);
    }

    /// A Stop block without a reason keeps no default reason (the agent loop ignores it with a warning);
    /// PreToolUse keeps its default.
    #[test]
    fn a_stop_block_without_a_reason_has_none() {
        for out in [r#"{"decision":"block"}"#, r#"{"decision":"block","reason":""}"#] {
            let parsed = parse_handler_output(&run(0, out, ""), "Stop");
            assert!(parsed.block && parsed.reason.is_none(), "{out}: {parsed:?}");
        }
        assert!(parse_handler_output(&run(2, "", ""), "Stop").reason.is_none());
        assert_eq!(parse_handler_output(&run(0, r#"{"decision":"block","reason":"r"}"#, ""), "Stop").reason.as_deref(), Some("r"));
        assert_eq!(parse_handler_output(&run(0, r#"{"decision":"block"}"#, ""), "PreToolUse").reason.as_deref(), Some("blocked by PreToolUse hook"));
    }

    #[test]
    fn folding_keeps_the_first_rewrite_and_a_block_beats_a_later_ask() {
        let mut agg = Aggregate::default();
        agg.fold(Parsed { updated_input: Some(json!(1)), ..Parsed::default() });
        agg.fold(Parsed { updated_input: Some(json!(2)), ask_reason: Some("a".into()), ..Parsed::default() });
        assert_eq!((agg.updated_input.clone(), agg.ask), (Some(json!(1)), true));
        agg.fold(Parsed { block: true, reason: Some("b".into()), ..Parsed::default() });
        assert!(agg.blocked && agg.reason.as_deref() == Some("b"));
        let mut blocked_first = Aggregate::default();
        blocked_first.fold(Parsed { block: true, ..Parsed::default() });
        blocked_first.fold(Parsed { ask_reason: Some("x".into()), ..Parsed::default() });
        assert!(!blocked_first.ask);
    }

    #[test]
    fn timeouts_follow_the_handler_then_its_type_then_the_event() {
        assert_eq!(handler_timeout(&json!({"timeout": 2.5}), "Stop"), Duration::from_millis(2500));
        assert_eq!(handler_timeout(&json!({"type": "prompt"}), "Stop"), Duration::from_secs(30));
        assert_eq!(handler_timeout(&json!({"type": "command"}), "UserPromptSubmit"), Duration::from_secs(30));
        assert_eq!(handler_timeout(&json!({"type": "command", "timeout": 0}), "PreToolUse"), Duration::from_secs(600));
    }

    #[test]
    fn long_output_is_cut_with_the_original_length() {
        let text = "x".repeat(10_005);
        let limited = limit_text(text);
        assert!(limited.ends_with("... [hook output truncated; original 10005 chars]"));
    }
}
