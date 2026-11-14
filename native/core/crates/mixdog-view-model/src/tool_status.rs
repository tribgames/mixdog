//! Terminal-status parsing for tool result surfaces (`shared/tool-status.mjs`).
//!
//! A terminal result status describes the tool's reported outcome; it is not evidence that the tool invocation itself
//! failed. Call-failure accounting belongs to the engine's `isError` / tool-kind envelope fields.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;

static CANCEL_QUALIFIED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^cancel[-_ ](?:unconfirmed|pending)$", ""));
static OFFLOADED_HEAD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[tool output offloaded:", "i"));
static USER_CONTROL_CANCELLATION: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:Error:\s*)?(?:Browser command interrupted by local user input\.|computer_session_aborted:|computer_user_control_active:)",
        "i",
    )
});
static BENIGN_EXIT_OUTCOME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[outcome:\s*(?:no-match|no-change|conflicts)\]\s*$", "im"));
static ENVELOPE_TAG_HEAD: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^<(?:task-notification|task-id|tool-use-id|output-file|status)[\s>]", "i"));
static STATUS_TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<status[^>]*>([\s\S]*?)</status>", "i"));
static STATUS_BRACKET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[status:\s*([^\]]*)\]", "im"));
static STATUS_INLINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:status|state):\s*([^\s·,;]+)", "im"));
static BARE_CANCEL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:cancelled|canceled)$", "i"));
static BARE_INTERRUPT: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^(?:interrupted by (?:user|process restart)|tool execution aborted|\[tool execution was interrupted\])$", "i")
});
static USER_DECLINED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^the user doesn't want to proceed with this tool use\b", "i"));

/// `normalizeToolTerminalStatus`: `running`, `completed`, `failed`, `cancelled` or `denied`; empty for any other text.
pub fn normalize_tool_terminal_status(value: &str) -> &'static str {
    let raw = js_to_lowercase(js_trim(value));
    match raw.as_str() {
        "running" | "pending" | "queued" | "in_progress" | "in-progress" => "running",
        "completed" | "complete" | "done" | "success" | "succeeded" | "ok" => "completed",
        "failed" | "fail" | "error" | "errored" | "timeout" | "timed_out" | "killed" => "failed",
        // `cancel-unconfirmed` is task control's honest answer when a cancel was delivered but the process exit could not be
        // confirmed. It is terminal for the tool call (the detail lives in the body), so it renders as cancelled rather than
        // falling through to nothing and leaving the surface with no status.
        "cancelled" | "canceled" | "cancel" | "cancelling" | "canceling" => "cancelled",
        _ if CANCEL_QUALIFIED.is_match(&raw) => "cancelled",
        "denied" | "deny" | "refused" | "rejected" => "denied",
        _ => "",
    }
}

/// `leadingResultBlock`: the result's first block of non-blank lines (after an offload marker line and the blank lines
/// behind it). Status markers live there: the cancel marker, the shell exit header, a background-task header, a task or
/// agent status line. Command output and fetched documents follow a blank line and can carry `status:` text of their own,
/// which says nothing about the tool call.
pub fn leading_result_block(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut index = 0;
    if OFFLOADED_HEAD.is_match(js_trim(lines.first().copied().unwrap_or_default())) {
        index = 1;
        while index < lines.len() && js_trim(lines[index]).is_empty() {
            index += 1;
        }
    }
    let mut block: Vec<&str> = Vec::new();
    while index < lines.len() && !js_trim(lines[index]).is_empty() {
        block.push(lines[index]);
        index += 1;
    }
    block.join("\n")
}

/// `isUserControlCancellation`: the user taking over the browser or desktop, or the session cancelling a computer command,
/// stops the call on purpose; it is not a failed invocation.
pub fn is_user_control_cancellation(text: &str) -> bool {
    USER_CONTROL_CANCELLATION.is_match(js_trim_start(text))
}

/// `hasBenignExitOutcome`: a non-zero exit the tool itself marked as a signal (search no-match, a `git diff --exit-code`
/// difference, a `git merge-tree` conflict report) rather than a command failure.
pub fn has_benign_exit_outcome(text: &str) -> bool {
    BENIGN_EXIT_OUTCOME.is_match(text)
}

/// The trimmed first group of a match, or empty.
fn group_one<'t>(pattern: &LazyLock<JsRegex>, text: &'t str) -> &'t str {
    pattern.captures(text).and_then(|found| found.get(1)).map(js_trim).unwrap_or_default()
}

/// `toolResultEnvelopeStatus`: the status a task or bridge envelope reports in its leading block. A `<status>` tag only
/// counts when the result opens with the envelope's own tags.
pub fn tool_result_envelope_status(text: &str) -> &'static str {
    let head = leading_result_block(text);
    if ENVELOPE_TAG_HEAD.is_match(js_trim_start(&head)) {
        let tagged = group_one(&STATUS_TAG, &head);
        if !tagged.is_empty() {
            return normalize_tool_terminal_status(tagged);
        }
    }
    let bracketed = group_one(&STATUS_BRACKET, &head);
    if !bracketed.is_empty() {
        return normalize_tool_terminal_status(bracketed);
    }
    normalize_tool_terminal_status(group_one(&STATUS_INLINE, &head))
}

/// `toolResultControlStatus`: bodies the runtime itself writes when a call is stopped or aborted.
pub fn tool_result_control_status(text: &str) -> &'static str {
    if is_user_control_cancellation(text) {
        return "cancelled";
    }
    // Bare control bodies written on cancel/crash (current and earlier forms).
    let trimmed = js_trim(text);
    if BARE_CANCEL.is_match(trimmed) || BARE_INTERRUPT.is_match(trimmed) || USER_DECLINED.is_match(trimmed) {
        return "cancelled";
    }
    ""
}

/// `toolResultTerminalStatus`: the envelope's status, else the control body's.
pub fn tool_result_terminal_status(text: &str) -> &'static str {
    match tool_result_envelope_status(text) {
        "" => tool_result_control_status(text),
        status => status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_normalise() {
        assert_eq!(normalize_tool_terminal_status(" In-Progress "), "running");
        assert_eq!(normalize_tool_terminal_status("OK"), "completed");
        assert_eq!(normalize_tool_terminal_status("timed_out"), "failed");
        assert_eq!(normalize_tool_terminal_status("cancel-unconfirmed"), "cancelled");
        assert_eq!(normalize_tool_terminal_status("Cancel pending"), "cancelled");
        assert_eq!(normalize_tool_terminal_status("rejected"), "denied");
        assert_eq!(normalize_tool_terminal_status("weird"), "");
        assert_eq!(normalize_tool_terminal_status(""), "");
    }

    #[test]
    fn the_status_lives_in_the_leading_block() {
        assert_eq!(tool_result_terminal_status("[status: done]\nrest"), "completed");
        assert_eq!(tool_result_terminal_status("status: failed · x"), "failed");
        assert_eq!(tool_result_terminal_status("<task-notification>\n<status>killed</status>"), "failed");
        assert_eq!(tool_result_terminal_status("[tool output offloaded: f]\n\nstate: running\n\nbody"), "running");
        // Fetched output after a blank line says nothing about the call.
        assert_eq!(tool_result_terminal_status("header\n\nstatus: failed"), "");
        assert_eq!(tool_result_terminal_status("prose <status>done</status>"), "");
    }

    #[test]
    fn control_bodies_read_as_cancelled() {
        assert_eq!(tool_result_terminal_status("Error: computer_session_aborted: x"), "cancelled");
        assert_eq!(tool_result_terminal_status("  Cancelled "), "cancelled");
        assert_eq!(tool_result_terminal_status("Interrupted by process restart"), "cancelled");
        assert_eq!(tool_result_terminal_status("The user doesn't want to proceed with this tool use. x"), "cancelled");
        assert_eq!(tool_result_terminal_status("plain output"), "");
        assert!(has_benign_exit_outcome("out\n[outcome: no-match]\n"));
        assert!(!has_benign_exit_outcome("[outcome: failed]"));
        assert_eq!(leading_result_block("a\nb\n\nc"), "a\nb");
    }
}
