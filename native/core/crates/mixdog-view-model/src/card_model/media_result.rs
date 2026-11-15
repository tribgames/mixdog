//! The media tool's JSON job outcome (`shared/tool-card-model/media-result.mjs`). The parse and the summary live with the
//! other result shapes in `results::git_media`; this module adds the call's own terminal status.

use mixdog_js::js_to_lowercase;
use serde_json::Value;

pub use crate::results::git_media::MediaOutcome;
pub use crate::results::git_media::media_result_summary;
pub use crate::results::git_media::parse_media_outcome;
use crate::tool_primitives::field;
use crate::tool_primitives::text_or_empty;

/// `mediaTerminalStatus`: the tool call's own outcome; a read of a failed job still read fine.
pub fn media_terminal_status(args: &Value, text: &str) -> &'static str {
    let Some(outcome) = parse_media_outcome(text) else { return "" };
    if !outcome.ok {
        return "failed";
    }
    if js_to_lowercase(&text_or_empty(field(args, "action"))) == "cancel" {
        return if outcome.canceled || outcome.job_status == "cancelled" { "cancelled" } else { "completed" };
    }
    "completed"
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_call_outcome_is_not_the_job_state() {
        let status = |action: &str, body: &str| media_terminal_status(&json!({ "action": action }), body);
        assert_eq!(status("status", r#"{"ok":true,"status":"failed"}"#), "completed");
        assert_eq!(status("status", r#"{"ok":false}"#), "failed");
        assert_eq!(status("cancel", r#"{"ok":true,"canceled":true}"#), "cancelled");
        assert_eq!(status("cancel", r#"{"ok":true,"status":"running"}"#), "completed");
        assert_eq!(status("CANCEL", r#"{"status":"canceled"}"#), "cancelled");
        assert_eq!(status("status", "not json"), "");
    }
}
