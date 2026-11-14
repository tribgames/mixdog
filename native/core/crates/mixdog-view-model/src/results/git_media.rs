//! The two result shapes the summaries read that belong to their own tools: a git result's exit header and error line
//! (`tool-card-model/git-result.mjs`), and the media tool's JSON job outcome (`tool-card-model/media-result.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use serde_json::Value;

use crate::tool_primitives::field;
use crate::tool_primitives::text_or_empty;
use crate::tool_status::normalize_tool_terminal_status;

static GIT_EXIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:^(?:## [^\n]+\n)?|\n## [^\n]+\n)exit ([1-9]\d*)\r?(?:\n|$)", ""));
static GIT_ERROR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:^|\n)error: command failed: [^\n]+|^error: [^\n]+", ""));

/// `gitResultExitCode`: only command result headers, not arbitrary lines in a patch, carry exits.
pub fn git_result_exit_code(text: &str) -> Option<f64> {
    GIT_EXIT.captures(text).and_then(|found| found.get(1)).map(string_to_number)
}

/// `gitResultError`: the error line of a git result, or empty.
pub fn git_result_error(text: &str) -> String {
    GIT_ERROR.find(text).map(|range| js_trim(&text[range]).to_owned()).unwrap_or_default()
}

/// The media tool's JSON job outcome: `{ ok, job, status, error, canceled }`.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaOutcome {
    pub ok: bool,
    pub job: String,
    /// The job's own state, normalised (`running`, `completed`, `failed`, `cancelled`, ...), not the call's.
    pub job_status: &'static str,
    pub error: String,
    pub canceled: bool,
}

/// `parseMediaOutcome`.
pub fn parse_media_outcome(text: &str) -> Option<MediaOutcome> {
    let body = js_trim(text);
    if !body.starts_with('{') {
        return None;
    }
    let parsed = mixdog_js::json_parse(body).ok()?;
    if !parsed.is_object() {
        return None;
    }
    Some(MediaOutcome {
        ok: field(&parsed, "ok") != Some(&Value::Bool(false)),
        job: text_or_empty(field(&parsed, "job")),
        job_status: normalize_tool_terminal_status(&text_or_empty(field(&parsed, "status"))),
        error: field(&parsed, "error").and_then(Value::as_str).map(|error| js_trim(error).to_owned()).unwrap_or_default(),
        canceled: field(&parsed, "canceled") == Some(&Value::Bool(true)),
    })
}

/// `mediaResultSummary`: a failed job's error, a cancelled one, or the state a status read inspected.
pub fn media_result_summary(args: &Value, text: &str) -> Option<String> {
    let outcome = parse_media_outcome(text)?;
    if !outcome.ok {
        return Some(if outcome.error.is_empty() { "Failed".to_owned() } else { outcome.error });
    }
    let action = js_to_lowercase(&text_or_empty(field(args, "action")));
    if action == "cancel" && (outcome.canceled || outcome.job_status == "cancelled") {
        return Some("Cancelled".to_owned());
    }
    if action == "status" || action == "cancel" {
        let word = match outcome.job_status {
            "running" => "running",
            "completed" => "done",
            "failed" => "failed",
            "cancelled" => "cancelled",
            _ => return None,
        };
        return Some(format!("Job {word}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn git_exit_and_error() {
        assert_eq!(git_result_exit_code("## main\nexit 128\nfatal"), Some(128.0));
        assert_eq!(git_result_exit_code("exit 0\n"), None);
        assert_eq!(git_result_exit_code("body\n## x\nexit 2"), Some(2.0));
        assert_eq!(git_result_exit_code("a line\nexit 5\n"), None);
        assert_eq!(git_result_error("out\nerror: command failed: git x \nmore"), "error: command failed: git x");
        assert_eq!(git_result_error("error: bad thing\nrest"), "error: bad thing");
        assert_eq!(git_result_error("fine"), "");
    }

    #[test]
    fn media_outcomes() {
        let args = json!({ "action": "Status" });
        assert_eq!(media_result_summary(&args, r#"{"ok":true,"status":"completed"}"#), Some("Job done".to_owned()));
        assert_eq!(media_result_summary(&args, r#"{"ok":false,"error":" nope "}"#), Some("nope".to_owned()));
        assert_eq!(media_result_summary(&args, r#"{"ok":false}"#), Some("Failed".to_owned()));
        assert_eq!(media_result_summary(&json!({ "action": "cancel" }), r#"{"canceled":true}"#), Some("Cancelled".to_owned()));
        assert_eq!(media_result_summary(&json!({ "action": "generate" }), r#"{"status":"running"}"#), None);
        assert_eq!(media_result_summary(&args, "[1]"), None);
        assert_eq!(media_result_summary(&args, "not json"), None);
        assert_eq!(parse_media_outcome(r#"{"job":7,"status":"error"}"#).map(|o| (o.job, o.job_status)), Some(("7".to_owned(), "failed")));
    }
}
