//! `runtime/shared/quiet-progress.mjs`: the quiet-time cue of a running turn. How long it has gone without the progress the
//! stall watchdog counts, and what it is waiting on. Display only: the watchdog's abort policy is never read or changed
//! here. The spinner, the live status line and the agent rows share it, so every surface says the same thing.

use mixdog_js::json_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use super::coerce::field;
use super::coerce::number_or_zero;

/// A running turn with no counted progress for this long reads "quiet". Lenient on purpose: effort-mode models can think
/// for minutes without a single semantic delta, so the cue stays neutral text; only the watchdog's own warn point
/// escalates it.
pub const QUIET_PROGRESS_CUE_MS: f64 = 120_000.0;

/// The stage a provider reports once its request is on the wire and the response headers are still pending. The runtime
/// keeps the turn in `requesting` and records the send time (`requestSentAt`); the display stage reads "model thinking"
/// from that record.
pub const MODEL_THINKING_STAGE: &str = "model_thinking";

/// `lastProgressAt(liveness)`: the newest progress stamp of a runtime liveness entry or progress snapshot, the signals the
/// stall watchdog counts (stage changes, semantic stream deltas, tool starts, the turn start).
pub fn last_progress_at(liveness: Option<&Value>) -> f64 {
    let Some(liveness) = liveness.filter(|value| value.is_object()) else { return 0.0 };
    ["lastProgressAt", "lastStreamDeltaAt", "toolStartedAt", "askStartedAt"]
        .iter()
        .map(|key| number_or_zero(liveness.get(*key)))
        .fold(f64::NEG_INFINITY, f64::max)
}

/// `awaitingModelResponse(liveness)`: the request is sent, the response headers (transport) not yet received.
pub fn awaiting_model_response(liveness: Option<&Value>) -> bool {
    let Some(liveness) = liveness.filter(|value| value.is_object()) else { return false };
    if liveness.get("stage").and_then(Value::as_str) != Some("requesting") {
        return false;
    }
    let sent_at = number_or_zero(liveness.get("requestSentAt"));
    sent_at > 0.0 && !(number_or_zero(liveness.get("lastTransportAt")) >= sent_at)
}

/// `displayProgressStage(liveness)`: `model_thinking` while the request waits for its headers, otherwise the runtime stage.
pub fn display_progress_stage(liveness: Option<&Value>) -> Option<String> {
    if awaiting_model_response(liveness) {
        return Some(MODEL_THINKING_STAGE.to_owned());
    }
    field(liveness, "stage").and_then(Value::as_str).map(str::to_owned)
}

/// `quietWaitKind(stage)`: what a quiet turn waits on, from its runtime stage (empty when unknown).
pub fn quiet_wait_kind(stage: &str) -> &'static str {
    match stage {
        "connecting" | "requesting" => "provider",
        MODEL_THINKING_STAGE => "thinking",
        "streaming" => "model",
        "tool_running" => "tool",
        "resource_wait" => "slot",
        "cancelling" => "cancel",
        _ => "",
    }
}

/// `quietProgress({ progressAt, stage, tool, now })`: the quiet state of a running turn at `now`, or `None` while it is
/// not quiet. `since` is the frozen progress stamp, so the value stays identical for the whole silence and publishing it
/// costs one update per silence.
pub fn quiet_progress(progress_at: f64, stage: &str, tool: Option<&str>, now: f64) -> Option<Value> {
    let since = if progress_at.is_nan() { 0.0 } else { progress_at };
    if since == 0.0 || now - since < QUIET_PROGRESS_CUE_MS {
        return None;
    }
    let wait = quiet_wait_kind(stage);
    let mut map = Map::new();
    map.insert("since".into(), json_number(since));
    map.insert("wait".into(), Value::String(wait.to_owned()));
    if let Some(tool) = tool.filter(|tool| wait == "tool" && !tool.is_empty()) {
        map.insert("tool".into(), Value::String(tool.to_owned()));
    }
    Some(Value::Object(map))
}

/// The display parts of a quiet state at a moment.
#[derive(Clone, Debug, PartialEq)]
pub struct QuietProgressParts {
    pub quiet_ms: f64,
    /// Whole quiet minutes.
    pub minutes: f64,
    pub wait: String,
    pub tool: String,
    /// The silence reached the watchdog's warn point.
    pub escalated: bool,
}

/// `quietProgressParts(quiet, now, warnMs)`: `warn_ms` 0 means none.
pub fn quiet_progress_parts(quiet: Option<&Value>, now: f64, warn_ms: f64) -> Option<QuietProgressParts> {
    let since = number_or_zero(field(quiet, "since"));
    if since == 0.0 {
        return None;
    }
    let quiet_ms = (now - since).max(0.0);
    if quiet_ms < QUIET_PROGRESS_CUE_MS {
        return None;
    }
    let wait = match field(quiet, "wait") {
        Some(value) if super::coerce::truthy(Some(value)) => value_to_string(value),
        _ => String::new(),
    };
    Some(QuietProgressParts {
        quiet_ms,
        minutes: (quiet_ms / 60_000.0).floor(),
        wait,
        tool: field(quiet, "tool").and_then(Value::as_str).unwrap_or_default().to_owned(),
        escalated: warn_ms > 0.0 && quiet_ms >= warn_ms,
    })
}

/// `quietProgressLabel(parts)`: the lowercase English cue, `quiet for 2m - waiting on provider`.
pub fn quiet_progress_label(parts: Option<&QuietProgressParts>) -> String {
    let Some(parts) = parts else { return String::new() };
    let wait = match parts.wait.as_str() {
        "tool" => format!("running {}", if parts.tool.is_empty() { "a tool" } else { &parts.tool }),
        "provider" => "waiting on provider".to_owned(),
        "thinking" => "model thinking".to_owned(),
        "model" => "waiting on model".to_owned(),
        "slot" => "waiting for a slot".to_owned(),
        "cancel" => "stopping".to_owned(),
        _ => String::new(),
    };
    let head = format!("quiet for {}m", mixdog_js::number_to_string(parts.minutes));
    if wait.is_empty() { head } else { format!("{head} \u{b7} {wait}") }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_newest_progress_stamp_wins() {
        let liveness = json!({ "lastProgressAt": 10, "lastStreamDeltaAt": 30, "toolStartedAt": 20, "askStartedAt": "5" });
        assert_eq!(last_progress_at(Some(&liveness)), 30.0);
        assert_eq!(last_progress_at(Some(&json!({}))), 0.0);
        assert_eq!(last_progress_at(None), 0.0);
        assert_eq!(last_progress_at(Some(&json!("x"))), 0.0);
    }

    #[test]
    fn a_sent_request_without_headers_is_model_thinking() {
        let waiting = json!({ "stage": "requesting", "requestSentAt": 100, "lastTransportAt": 50 });
        assert!(awaiting_model_response(Some(&waiting)));
        assert_eq!(display_progress_stage(Some(&waiting)).as_deref(), Some("model_thinking"));
        let answered = json!({ "stage": "requesting", "requestSentAt": 100, "lastTransportAt": 100 });
        assert!(!awaiting_model_response(Some(&answered)));
        assert_eq!(display_progress_stage(Some(&answered)).as_deref(), Some("requesting"));
        assert!(!awaiting_model_response(Some(&json!({ "stage": "streaming", "requestSentAt": 100 }))));
        assert_eq!(display_progress_stage(Some(&json!({ "stage": 4 }))), None);
        assert_eq!(display_progress_stage(None), None);
    }

    #[test]
    fn stages_map_to_what_the_turn_waits_on() {
        assert_eq!(quiet_wait_kind("connecting"), "provider");
        assert_eq!(quiet_wait_kind("requesting"), "provider");
        assert_eq!(quiet_wait_kind("model_thinking"), "thinking");
        assert_eq!(quiet_wait_kind("streaming"), "model");
        assert_eq!(quiet_wait_kind("tool_running"), "tool");
        assert_eq!(quiet_wait_kind("resource_wait"), "slot");
        assert_eq!(quiet_wait_kind("cancelling"), "cancel");
        assert_eq!(quiet_wait_kind("idle"), "");
    }

    #[test]
    fn a_turn_is_quiet_after_two_minutes_without_progress() {
        assert_eq!(quiet_progress(1000.0, "streaming", None, 1000.0 + 119_999.0), None);
        assert_eq!(quiet_progress(0.0, "streaming", None, 1_000_000.0), None);
        assert_eq!(quiet_progress(1000.0, "streaming", None, 121_000.0), Some(json!({ "since": 1000, "wait": "model" })));
        assert_eq!(quiet_progress(1000.0, "tool_running", Some("shell"), 121_000.0), Some(json!({ "since": 1000, "wait": "tool", "tool": "shell" })));
        assert_eq!(quiet_progress(1000.0, "streaming", Some("shell"), 121_000.0), Some(json!({ "since": 1000, "wait": "model" })));
    }

    #[test]
    fn parts_count_whole_minutes_and_escalate_at_the_warn_point() {
        let quiet = json!({ "since": 1000, "wait": "tool", "tool": "shell" });
        assert_eq!(quiet_progress_parts(Some(&quiet), 100_000.0, 0.0), None);
        let parts = quiet_progress_parts(Some(&quiet), 1000.0 + 200_000.0, 0.0).expect("quiet");
        assert_eq!((parts.minutes, parts.quiet_ms, parts.escalated), (3.0, 200_000.0, false));
        assert_eq!((parts.wait.as_str(), parts.tool.as_str()), ("tool", "shell"));
        assert!(quiet_progress_parts(Some(&quiet), 1000.0 + 200_000.0, 150_000.0).expect("quiet").escalated);
        assert_eq!(quiet_progress_parts(Some(&json!({})), 500_000.0, 0.0), None);
        assert_eq!(quiet_progress_parts(None, 500_000.0, 0.0), None);
    }

    #[test]
    fn the_label_reads_the_wait() {
        let at =
            |wait: &str, tool: &str| QuietProgressParts { quiet_ms: 130_000.0, minutes: 2.0, wait: wait.to_owned(), tool: tool.to_owned(), escalated: false };
        assert_eq!(quiet_progress_label(Some(&at("provider", ""))), "quiet for 2m \u{b7} waiting on provider");
        assert_eq!(quiet_progress_label(Some(&at("thinking", ""))), "quiet for 2m \u{b7} model thinking");
        assert_eq!(quiet_progress_label(Some(&at("tool", "shell"))), "quiet for 2m \u{b7} running shell");
        assert_eq!(quiet_progress_label(Some(&at("tool", ""))), "quiet for 2m \u{b7} running a tool");
        assert_eq!(quiet_progress_label(Some(&at("", ""))), "quiet for 2m");
        assert_eq!(quiet_progress_label(Some(&at("cancel", ""))), "quiet for 2m \u{b7} stopping");
        assert_eq!(quiet_progress_label(None), "");
    }
}
