//! Terminal status words, their outcome tone, status marker stripping and the ` · <time>` detail conventions
//! (`shared/tool-card-model/terminal-status.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use mixdog_js::to_number_of;
use mixdog_tui_style::time_format::format_elapsed;
use serde_json::Value;

use crate::tool_status::leading_result_block;
use crate::tool_status::normalize_tool_terminal_status;
use crate::tool_status::tool_result_control_status;
use crate::tool_status::tool_result_envelope_status;
use crate::tool_status::tool_result_terminal_status;

static SHELL_STATUS: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"(?:^|\b)status:\s*(running|pending|queued|completed|failed|cancelled|canceled)\b", "im"));
static STATUS_MARKER_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[status:\s*[^\]]*\]\s*$", "i"));
static ELAPSED_MARKER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[elapsed:\s*(\d+)\s*ms\]", "im"));
static QUEUED_HEAD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^queued\b", "i"));

/// `shellResultStatus`: the status the result's leading block reports, lower case; empty when it reports none.
pub fn shell_result_status(value: &str) -> String {
    SHELL_STATUS.captures(&leading_result_block(value)).and_then(|found| found.get(1).map(js_to_lowercase)).unwrap_or_default()
}

/// `normalizeTerminalStatus`.
pub fn normalize_terminal_status(value: &str) -> &'static str {
    normalize_tool_terminal_status(value)
}

/// The inputs of [`derive_tool_outcome_tone`].
#[derive(Clone, Debug)]
pub struct OutcomeToneInput<'a> {
    pub pending: bool,
    pub group_count: f64,
    pub call_failed_count: f64,
    pub exit_failed_count: f64,
    pub terminal_status: &'a str,
    pub partial_mutation: bool,
}

impl Default for OutcomeToneInput<'_> {
    fn default() -> Self {
        Self { pending: false, group_count: 1.0, call_failed_count: 0.0, exit_failed_count: 0.0, terminal_status: "", partial_mutation: false }
    }
}

/// `Number(value) || fallback`.
fn number_or(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// `deriveToolOutcomeTone`: the semantic outcome both surfaces share. A returned command or task failure means the tool
/// transport worked, so it is a warning; red is reserved for a failed invocation. A failed mutation that still committed a
/// diff is partial success.
pub fn derive_tool_outcome_tone(input: &OutcomeToneInput) -> &'static str {
    if input.pending {
        return "running";
    }
    let status = normalize_terminal_status(input.terminal_status);
    if status == "cancelled" || status == "denied" {
        return "warning";
    }
    let count = number_or(input.group_count, 1.0).max(1.0);
    let call_failures = number_or(input.call_failed_count, 0.0).max(0.0);
    if call_failures > 0.0 {
        if input.partial_mutation || (count > 1.0 && call_failures < count) {
            return "warning";
        }
        return "error";
    }
    if status == "failed" || number_or(input.exit_failed_count, 0.0) > 0.0 {
        return "warning";
    }
    "success"
}

/// `displayTerminalStatus`: the word a status is shown as. `exit` is a shell-only pseudo status (the command ran but exited
/// non-zero); it is not a normalised terminal status, so it never colours red.
pub fn display_terminal_status(value: &str) -> &'static str {
    if js_to_lowercase(js_trim(value)) == "exit" {
        return "Exited";
    }
    match normalize_terminal_status(value) {
        "running" => "Running",
        "completed" => "Finished",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        "denied" => "Denied",
        _ => "",
    }
}

/// The words a bare status detail can be, lower case.
fn is_bare_status_word(text: &str) -> bool {
    matches!(js_to_lowercase(text).as_str(), "running" | "finished" | "failed" | "cancelled" | "denied")
}

/// `resultTerminalStatus`.
pub fn result_terminal_status(value: &str) -> &'static str {
    tool_result_terminal_status(value)
}

/// `resultEnvelopeStatus`.
pub fn result_envelope_status(value: &str) -> &'static str {
    tool_result_envelope_status(value)
}

/// `resultControlStatus`.
pub fn result_control_status(value: &str) -> &'static str {
    tool_result_control_status(value)
}

/// `stripLeadingStatusMarkerLines`: the first line goes when it is a `[status: ...]` marker.
pub fn strip_leading_status_marker_lines(lines: &[String]) -> Vec<String> {
    let mut out = lines.to_vec();
    if out.first().is_some_and(|first| STATUS_MARKER_LINE.is_match(js_trim(first))) {
        out.remove(0);
    }
    out
}

/// `stripLeadingStatusMarkerFromText`.
pub fn strip_leading_status_marker_from_text(text: &str) -> String {
    let lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    strip_leading_status_marker_lines(&lines).join("\n")
}

/// `shellResultElapsed`: the `[elapsed: N ms]` marker as a label, when it is a second or more.
pub fn shell_result_elapsed(value: &str) -> String {
    let Some(found) = ELAPSED_MARKER.captures(value) else { return String::new() };
    let elapsed_ms = string_to_number(found.get(1).unwrap_or_default());
    if elapsed_ms.is_finite() && elapsed_ms >= 1000.0 { format_elapsed(elapsed_ms) } else { String::new() }
}

/// `clampFailureCount`: the explicit count within `0..=group_count`, else every call when the item is an error.
pub fn clamp_failure_count(error_count: Option<&Value>, group_count: f64, is_error: bool) -> f64 {
    let explicit = error_count.map_or(f64::NAN, |value| to_number_of(Some(value)));
    if explicit.is_finite() {
        return group_count.min(explicit.floor()).max(0.0);
    }
    if is_error { group_count } else { 0.0 }
}

/// `prefixElapsed`: the elapsed time always goes at the end, ` · ` separated, and is never appended twice.
pub fn prefix_elapsed(detail: &str, elapsed: &str) -> String {
    let text = js_trim(detail);
    let time = js_trim(elapsed);
    if time.is_empty() {
        return text.to_owned();
    }
    if text.ends_with(&format!("\u{b7} {time}")) {
        return text.to_owned();
    }
    if text.is_empty() { time.to_owned() } else { format!("{text} \u{b7} {time}") }
}

/// `mergeTerminalDetail`: the status word and the detail as one row ("Failed · cause").
pub fn merge_terminal_detail(status: &str, detail: &str) -> String {
    let label = display_terminal_status(status);
    let text = js_trim(detail);
    if label.is_empty() {
        return text.to_owned();
    }
    if label == "Finished" && !text.is_empty() {
        return text.to_owned();
    }
    if text.is_empty() {
        return label.to_owned();
    }
    if js_to_lowercase(text).starts_with(&js_to_lowercase(label)) {
        return text.to_owned();
    }
    // A queued job is not yet running; its own word replaces "Running".
    if label == "Running" && QUEUED_HEAD.is_match(text) {
        return text.to_owned();
    }
    // A bare status word (the generic "Failed" of an error without a body) is superseded by the resolved status.
    if is_bare_status_word(text) {
        return label.to_owned();
    }
    format!("{label} \u{b7} {text}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn details_merge_status_and_time() {
        assert_eq!(merge_terminal_detail("failed", "boom"), "Failed \u{b7} boom");
        assert_eq!(merge_terminal_detail("failed", "Failed"), "Failed");
        assert_eq!(merge_terminal_detail("cancelled", "Failed"), "Cancelled");
        assert_eq!(merge_terminal_detail("completed", "3 files"), "3 files");
        assert_eq!(merge_terminal_detail("running", "queued job"), "queued job");
        assert_eq!(merge_terminal_detail("exit", ""), "Exited");
        assert_eq!(merge_terminal_detail("", " x "), "x");
        assert_eq!(prefix_elapsed("done", "12s"), "done \u{b7} 12s");
        assert_eq!(prefix_elapsed("done \u{b7} 12s", "12s"), "done \u{b7} 12s");
        assert_eq!(prefix_elapsed("", "12s"), "12s");
    }

    #[test]
    fn failure_counts_clamp() {
        assert_eq!(clamp_failure_count(Some(&json!(5)), 3.0, false), 3.0);
        assert_eq!(clamp_failure_count(Some(&json!(-2)), 3.0, true), 0.0);
        assert_eq!(clamp_failure_count(None, 3.0, true), 3.0);
        assert_eq!(clamp_failure_count(None, 3.0, false), 0.0);
        assert_eq!(clamp_failure_count(Some(&json!("x")), 2.0, true), 2.0);
    }

    #[test]
    fn markers_and_tones() {
        assert_eq!(strip_leading_status_marker_from_text("[status: done]\nbody"), "body");
        assert_eq!(strip_leading_status_marker_from_text("body\n[status: done]"), "body\n[status: done]");
        assert_eq!(shell_result_status("status: Failed\n\nstatus: running"), "failed");
        assert_eq!(shell_result_elapsed("[elapsed: 12000 ms]\nx"), "12s");
        assert_eq!(shell_result_elapsed("[elapsed: 900 ms]"), "");
        let tone = |status: &'static str, call: f64, exit: f64, count: f64| {
            derive_tool_outcome_tone(&OutcomeToneInput {
                terminal_status: status,
                call_failed_count: call,
                exit_failed_count: exit,
                group_count: count,
                ..OutcomeToneInput::default()
            })
        };
        assert_eq!(tone("completed", 0.0, 0.0, 1.0), "success");
        assert_eq!(tone("failed", 0.0, 0.0, 1.0), "warning");
        assert_eq!(tone("completed", 1.0, 0.0, 1.0), "error");
        assert_eq!(tone("completed", 1.0, 0.0, 3.0), "warning");
        assert_eq!(tone("cancelled", 1.0, 0.0, 1.0), "warning");
        assert_eq!(tone("completed", 0.0, 2.0, 2.0), "warning");
    }
}
