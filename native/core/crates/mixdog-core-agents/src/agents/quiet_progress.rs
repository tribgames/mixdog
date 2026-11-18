//! The quiet state of a running turn (Node `shared/quiet-progress.mjs` and `tui/session/turn-quiet.mjs`): how long the
//! turn has gone without the progress the stall watchdog counts, and what it waits on. The core publishes it as the
//! runtime section's `spinner.quiet` (`run_host/quiet_watch.rs`); a client turns it into its cue and label
//! (`src/tui/spinner-meta.mjs` `quietProgressParts`, `quietProgressLabel`). The pool rows read the same progress stamp and
//! display stage ([`super::AgentPool`]'s `withTurnProgress`). Display only: the watchdog's policy is not read here.

use mixdog_js::to_number_of;
use serde_json::{Map, Value, json};

type Row = Map<String, Value>;

/// `QUIET_PROGRESS_CUE_MS`: a running turn with no counted progress for this long reads quiet.
pub const QUIET_PROGRESS_CUE_MS: f64 = 120_000.0;

/// `MODEL_THINKING_STAGE`.
pub const MODEL_THINKING_STAGE: &str = "model_thinking";

/// `Number(value) || 0`.
fn number(row: &Row, key: &str) -> f64 {
    let value = to_number_of(row.get(key));
    if value.is_nan() { 0.0 } else { value }
}

/// `lastProgressAt(liveness)`: the newest of the stamps the stall watchdog counts.
pub fn last_progress_at(liveness: Option<&Row>) -> f64 {
    let Some(row) = liveness else { return 0.0 };
    number(row, "lastProgressAt").max(number(row, "lastStreamDeltaAt")).max(number(row, "toolStartedAt")).max(number(row, "askStartedAt"))
}

/// `awaitingModelResponse(liveness)`: the request is sent and its headers have not arrived.
pub fn awaiting_model_response(liveness: Option<&Row>) -> bool {
    let Some(row) = liveness.filter(|row| row.get("stage").and_then(Value::as_str) == Some("requesting")) else { return false };
    let sent_at = number(row, "requestSentAt");
    sent_at > 0.0 && !matches!(number(row, "lastTransportAt").partial_cmp(&sent_at), Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater))
}

/// `displayProgressStage(liveness)`: `model_thinking` while the request waits for its headers, else the runtime stage.
pub fn display_progress_stage(liveness: Option<&Row>) -> Option<String> {
    if awaiting_model_response(liveness) {
        return Some(MODEL_THINKING_STAGE.to_owned());
    }
    liveness.and_then(|row| row.get("stage")).and_then(Value::as_str).map(str::to_owned)
}

/// `quietWaitKind(stage)`: what a quiet turn waits on, `""` when unknown.
pub fn quiet_wait_kind(stage: Option<&str>) -> &'static str {
    match stage.unwrap_or("") {
        "connecting" | "requesting" => "provider",
        MODEL_THINKING_STAGE => "thinking",
        "streaming" => "model",
        "tool_running" => "tool",
        "resource_wait" => "slot",
        "cancelling" => "cancel",
        _ => "",
    }
}

/// `quietProgress({ progressAt, stage, tool, now })`: `{ since, wait, tool? }` once the cue window has passed without
/// progress, `None` before. `since` is the frozen progress stamp, so the value is the same for the whole silence.
pub fn quiet_progress(progress_at: f64, stage: Option<&str>, tool: Option<&str>, now: f64) -> Option<Value> {
    let since = if progress_at.is_nan() { 0.0 } else { progress_at };
    if since == 0.0 || now - since < QUIET_PROGRESS_CUE_MS {
        return None;
    }
    let wait = quiet_wait_kind(stage);
    let mut quiet = json!({ "since": mixdog_js::json_number(since), "wait": wait });
    if let (true, Some(tool)) = (wait == "tool", tool.filter(|tool| !tool.is_empty())) {
        quiet["tool"] = json!(tool);
    }
    Some(quiet)
}

/// `turnQuietState(liveness, now, warnMs)`: the quiet state a liveness record implies at `now`, with the warn point.
pub fn turn_quiet_state(liveness: Option<&Row>, now: f64, warn_ms: f64) -> Option<Value> {
    let row = liveness?;
    let tool = row.get("currentTool").and_then(Value::as_str);
    let mut quiet = quiet_progress(last_progress_at(Some(row)), display_progress_stage(Some(row)).as_deref(), tool, now)?;
    quiet["warnMs"] = mixdog_js::json_number(warn_ms);
    Some(quiet)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(value: Value) -> Row {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn a_turn_reads_quiet_only_after_the_cue_window_without_counted_progress() {
        assert_eq!(quiet_progress(1000.0, Some("streaming"), None, 1000.0 + QUIET_PROGRESS_CUE_MS - 1.0), None);
        assert_eq!(quiet_progress(1000.0, Some("streaming"), None, 1000.0 + QUIET_PROGRESS_CUE_MS), Some(json!({ "since": 1000, "wait": "model" })));
        // A turn that never made progress has nothing to measure from.
        assert_eq!(quiet_progress(0.0, Some("streaming"), None, 1e9), None);
        assert_eq!(quiet_progress(f64::NAN, Some("streaming"), None, 1e9), None);
    }

    #[test]
    fn only_a_quiet_tool_wait_names_its_tool() {
        let at = 1_000_000.0;
        assert_eq!(quiet_progress(1.0, Some("tool_running"), Some("bash"), at), Some(json!({ "since": 1, "wait": "tool", "tool": "bash" })));
        assert_eq!(quiet_progress(1.0, Some("tool_running"), Some(""), at), Some(json!({ "since": 1, "wait": "tool" })));
        assert_eq!(quiet_progress(1.0, Some("streaming"), Some("bash"), at), Some(json!({ "since": 1, "wait": "model" })));
    }

    #[test]
    fn each_stage_names_what_a_quiet_turn_waits_on() {
        let kinds: Vec<&str> = ["connecting", "requesting", MODEL_THINKING_STAGE, "streaming", "tool_running", "resource_wait", "cancelling", "idle"]
            .into_iter()
            .map(|stage| quiet_wait_kind(Some(stage)))
            .collect();
        assert_eq!(kinds, ["provider", "provider", "thinking", "model", "tool", "slot", "cancel", ""]);
        assert_eq!(quiet_wait_kind(None), "");
    }

    #[test]
    fn progress_is_counted_from_the_newest_of_the_watchdogs_stamps() {
        let liveness = row(json!({ "lastProgressAt": 10, "lastStreamDeltaAt": 40, "toolStartedAt": 30, "askStartedAt": "20", "lastTransportAt": 99 }));
        assert_eq!(last_progress_at(Some(&liveness)), 40.0);
        assert_eq!(last_progress_at(Some(&row(json!({ "lastProgressAt": "junk" })))), 0.0);
        assert_eq!(last_progress_at(None), 0.0);
    }

    #[test]
    fn a_sent_request_is_model_thinking_until_transport_answers() {
        let waiting = row(json!({ "stage": "requesting", "requestSentAt": 500, "lastTransportAt": 400 }));
        assert!(awaiting_model_response(Some(&waiting)));
        assert_eq!(display_progress_stage(Some(&waiting)).as_deref(), Some(MODEL_THINKING_STAGE));
        let answered = row(json!({ "stage": "requesting", "requestSentAt": 500, "lastTransportAt": 500 }));
        assert!(!awaiting_model_response(Some(&answered)));
        assert_eq!(display_progress_stage(Some(&answered)).as_deref(), Some("requesting"));
        // Not yet sent, or no longer requesting: not waiting for headers.
        assert!(!awaiting_model_response(Some(&row(json!({ "stage": "requesting" })))));
        assert!(!awaiting_model_response(Some(&row(json!({ "stage": "streaming", "requestSentAt": 500 })))));
        assert_eq!(display_progress_stage(None), None);
    }

    #[test]
    fn the_published_quiet_state_carries_the_warn_point_and_stays_frozen_for_a_silence() {
        let liveness = row(json!({ "stage": "tool_running", "lastProgressAt": 1000, "currentTool": "bash" }));
        let quiet = turn_quiet_state(Some(&liveness), 1000.0 + QUIET_PROGRESS_CUE_MS, 300_000.0).unwrap();
        assert_eq!(quiet, json!({ "since": 1000, "wait": "tool", "tool": "bash", "warnMs": 300_000 }));
        let later = turn_quiet_state(Some(&liveness), 1000.0 + 2.0 * QUIET_PROGRESS_CUE_MS, 300_000.0).unwrap();
        assert_eq!(later["since"], quiet["since"]);
        assert_eq!(turn_quiet_state(Some(&liveness), 1000.0 + 1.0, 300_000.0), None);
        assert_eq!(turn_quiet_state(None, 1e9, 1.0), None);
    }
}
