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
    sent_at > 0.0 && !(number(row, "lastTransportAt") >= sent_at)
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
