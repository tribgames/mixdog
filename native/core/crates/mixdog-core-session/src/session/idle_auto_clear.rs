//! Idle auto-clear (`tui/session/session-flow/auto-clear.mjs` and `runtime/shared/idle-auto-clear-gate.mjs`): before a
//! user's turn or a completion wake, a thread that has sat idle past its window, with a context of some size, is compacted
//! (never cleared after the compaction: that would discard what the compactor kept). The compaction is awaited for at
//! most a minute, which bounds how long the turn waits, not the compaction.
//!
//! The thread actor drives it (`SessionActor::idle_gate`, in `actor/turn_ops.rs`) on the compaction it already runs for a
//! manual `compact` (trigger `auto_clear`, a reduction required); this module holds the decisions it takes: the window, the
//! context meter and the activity stamp.

use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;

use super::gateway_usage::event::truthy;

/// `AUTO_CLEAR_COMPACT_TIMEOUT_MS`: the bound on the awaited idle compaction. Without one a stalled compaction wedges
/// the thread's command state and suppresses the input drain. Not to be raised to cover compaction worst cases.
pub const AUTO_CLEAR_COMPACT_TIMEOUT_MS: u64 = 60_000;

/// The auto-clear state of the config (`autoClearState()`): `enabled`, `idleMs` and `minContextPercent`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IdleConfig {
    pub enabled: bool,
    pub idle_ms: f64,
    /// `None` is the default, ten percent.
    pub min_context_percent: Option<f64>,
}

/// What `runtime.contextStatus()` reports of a thread's context; a field that is not reported is 0.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContextStatus {
    pub used_tokens: f64,
    pub current_estimated_tokens: f64,
    pub compaction_current_estimated_tokens: f64,
    pub compaction_trigger_tokens: f64,
    pub compaction_auto_compact_token_limit: f64,
    /// `runtime.session.autoCompactTokenLimit`.
    pub session_auto_compact_token_limit: f64,
}

/// `contextUsageBelowThreshold(runtime, minContextPercent)`: a zero is often an unavailable or stale meter field, not a
/// measurement, so it never masks the sibling live estimate; with no usable measure the context counts as below.
fn context_usage_below_threshold(status: &ContextStatus, min_percent: f64) -> bool {
    if !(min_percent > 0.0) {
        return false;
    }
    let used = [status.used_tokens, status.current_estimated_tokens, status.compaction_current_estimated_tokens].into_iter().fold(0.0_f64, |best, n| if n.is_finite() && n > best { n } else { best });
    let trigger = [status.compaction_trigger_tokens, status.compaction_auto_compact_token_limit, status.session_auto_compact_token_limit]
        .into_iter()
        .find(|n| *n != 0.0 && !n.is_nan())
        .unwrap_or(0.0);
    if !used.is_finite() || !trigger.is_finite() || !(used > 0.0 && trigger > 0.0) {
        return true;
    }
    (used / trigger) * 100.0 < min_percent
}

/// `idleAutoClearDue({ cfg, activityAt, at, runtime })`: whether the idle gate clears the thread before a submit at
/// `at`: auto-clear on, idle at least the window since the activity stamp, and a context not below the minimum share of
/// the compaction trigger. The submit gate adds its own transient conditions (busy, queued input, a clear running).
pub fn idle_auto_clear_due(config: &IdleConfig, activity_at: f64, at: f64, status: &ContextStatus) -> bool {
    idle_window_elapsed(config, activity_at, at) && !context_usage_below_threshold(status, config.min_context_percent.unwrap_or(10.0))
}

/// The part of [`idle_auto_clear_due`] that needs no context meter: auto-clear on, and idle at least the window since the
/// activity stamp (0: no model-visible conversation). Cheap, so a start that fails it never reads the meter.
pub fn idle_window_elapsed(config: &IdleConfig, activity_at: f64, at: f64) -> bool {
    config.enabled && activity_at != 0.0 && !(at - activity_at < config.idle_ms)
}

/// `autoClearState()` from the route's `autoClear` value (`getAutoClear`): `enabled`, `idleMs` and `minContextPercent` (null
/// is the default). `None` when the value carries no usable window, which never clears.
pub fn idle_config_of(auto_clear: &Value) -> Option<IdleConfig> {
    let idle_ms = auto_clear.get("idleMs").map(mixdog_js::to_number).filter(|ms| !ms.is_nan())?;
    let min_context_percent = auto_clear.get("minContextPercent").filter(|value| !value.is_null()).map(mixdog_js::to_number);
    Some(IdleConfig { enabled: truthy(auto_clear.get("enabled")), idle_ms, min_context_percent })
}

/// `runtime.contextStatus()` as the gate reads it: `Number(x) || 0` of each meter field (a missing or non-numeric one is 0);
/// the session's own limit rides in `session.autoCompactTokenLimit`.
pub fn context_status_of(status: &Value) -> ContextStatus {
    let number = |value: Option<&Value>| {
        let n = value.map_or(0.0, mixdog_js::to_number);
        if n.is_nan() { 0.0 } else { n }
    };
    let compaction = status.get("compaction");
    ContextStatus {
        used_tokens: number(status.get("usedTokens")),
        current_estimated_tokens: number(status.get("currentEstimatedTokens")),
        compaction_current_estimated_tokens: number(compaction.and_then(|c| c.get("currentEstimatedTokens"))),
        compaction_trigger_tokens: number(compaction.and_then(|c| c.get("triggerTokens"))),
        compaction_auto_compact_token_limit: number(compaction.and_then(|c| c.get("autoCompactTokenLimit"))),
        session_auto_compact_token_limit: number(status.get("session").and_then(|s| s.get("autoCompactTokenLimit"))),
    }
}

/// `timestampMs(value)`: a positive number or a date string as epoch ms, else 0.
fn timestamp_ms(value: Option<&Value>) -> f64 {
    let value = match value {
        None | Some(Value::Null) => return 0.0,
        Some(Value::String(text)) if text.is_empty() => return 0.0,
        Some(value) => value,
    };
    let n = mixdog_js::to_number(value);
    if n.is_finite() && n > 0.0 {
        return n;
    }
    let parsed = mixdog_js::time::date_parse(&value_to_string(value));
    if parsed.is_finite() && parsed > 0.0 { parsed } else { 0.0 }
}

/// `promptContentText(content)`: the text a message carries; `text_of_part` answers the text of an attachment
/// reference part (`None` for any other part).
pub fn prompt_content_text(content: &Value, text_of_part: &dyn Fn(&Value) -> Option<String>) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                _ => match part.get("type").and_then(Value::as_str) {
                    Some("text") => text_of_part(part).unwrap_or_else(|| part_text(part)),
                    Some("image") => "[Image]".to_owned(),
                    Some("file") => "[File]".to_owned(),
                    _ => part_text(part),
                },
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => value_to_string(other),
    }
}

/// `part.text || ''`.
fn part_text(part: &Value) -> String {
    match part.get("text") {
        Some(text) if truthy(Some(text)) => value_to_string(text),
        _ => String::new(),
    }
}

/// `hasModelVisibleConversation(session)`: some message the model sees, not a system reminder or a bare `.` turn.
fn has_model_visible_conversation(messages: &[Value], text_of_part: &dyn Fn(&Value) -> Option<String>) -> bool {
    messages.iter().any(|message| {
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        if !matches!(role, "user" | "assistant" | "tool") {
            return false;
        }
        let text = prompt_content_text(message.get("content").unwrap_or(&Value::Null), text_of_part);
        let text = js_trim(&text);
        if role == "user" && text.starts_with("<system-reminder>") {
            return false;
        }
        if role == "assistant" && text == "." && !message.get("toolCalls").is_some_and(Value::is_array) {
            return false;
        }
        !text.is_empty() || role == "assistant" || role == "tool"
    })
}

/// `sessionActivityTimestamp(session, fallback)`: when the session was last active (0: no model-visible conversation):
/// the latest of its own activity (`lastUsedAt`, else `updatedAt`, else the fallback) and the last successful cache
/// warm (`warm_use_at`, 0 when none). Idleness is measured from the last time the cached prompt was used, and a warm
/// that read the cache without writing used it; the session's own timestamps are never moved.
pub fn session_activity_timestamp(session: &Value, fallback: f64, warm_use_at: f64, text_of_part: &dyn Fn(&Value) -> Option<String>) -> f64 {
    let messages: &[Value] = session.get("messages").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    if !has_model_visible_conversation(messages, text_of_part) {
        return 0.0;
    }
    let own = [timestamp_ms(session.get("lastUsedAt")), timestamp_ms(session.get("updatedAt")), fallback.max(0.0)].into_iter().find(|n| *n != 0.0).unwrap_or(0.0);
    own.max(warm_use_at)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const IDLE: IdleConfig = IdleConfig { enabled: true, idle_ms: 1000.0, min_context_percent: None };

    fn half_full() -> ContextStatus {
        ContextStatus { used_tokens: 500.0, compaction_trigger_tokens: 1000.0, ..ContextStatus::default() }
    }

    #[test]
    fn the_gate_needs_an_enabled_window_an_idle_thread_and_a_context_of_some_size() {
        let at = 10_000.0;
        assert!(idle_auto_clear_due(&IDLE, 5000.0, at, &half_full()));
        assert!(!idle_auto_clear_due(&IdleConfig { enabled: false, ..IDLE }, 5000.0, at, &half_full()));
        assert!(!idle_auto_clear_due(&IDLE, 9500.0, at, &half_full()));
        assert!(!idle_auto_clear_due(&IDLE, 0.0, at, &half_full()));
        // Below the minimum share (ten percent by default) of the trigger: not worth a clear.
        let small = ContextStatus { used_tokens: 50.0, compaction_trigger_tokens: 1000.0, ..ContextStatus::default() };
        assert!(!idle_auto_clear_due(&IDLE, 5000.0, at, &small));
        assert!(idle_auto_clear_due(&IdleConfig { min_context_percent: Some(4.0), ..IDLE }, 5000.0, at, &small));
        // No usable measure counts as below the threshold; a zero meter field does not mask the live estimate.
        assert!(!idle_auto_clear_due(&IDLE, 5000.0, at, &ContextStatus::default()));
        let masked = ContextStatus { used_tokens: 0.0, current_estimated_tokens: 400.0, session_auto_compact_token_limit: 1000.0, ..ContextStatus::default() };
        assert!(idle_auto_clear_due(&IDLE, 5000.0, at, &masked));
        // A zero minimum disables the size check.
        assert!(idle_auto_clear_due(&IdleConfig { min_context_percent: Some(0.0), ..IDLE }, 5000.0, at, &ContextStatus::default()));
    }

    #[test]
    fn the_route_value_and_the_meter_are_read_as_nodes_gate_reads_them() {
        let config = idle_config_of(&json!({ "enabled": true, "idleMs": 120000, "minContextPercent": null })).unwrap();
        assert_eq!(config, IdleConfig { enabled: true, idle_ms: 120_000.0, min_context_percent: None });
        assert_eq!(idle_config_of(&json!({ "enabled": false, "idleMs": "60000", "minContextPercent": 25 })), Some(IdleConfig { enabled: false, idle_ms: 60_000.0, min_context_percent: Some(25.0) }));
        assert_eq!(idle_config_of(&json!({ "enabled": true })), None);
        assert!(idle_window_elapsed(&IDLE, 5000.0, 6000.0), "exactly the window is idle enough");
        assert!(!idle_window_elapsed(&IDLE, 5000.0, 5999.0));
        assert!(!idle_window_elapsed(&IDLE, 0.0, 6000.0));
        let status = context_status_of(&json!({ "usedTokens": "7", "currentEstimatedTokens": null, "compaction": { "currentEstimatedTokens": 3, "triggerTokens": 100, "autoCompactTokenLimit": "x" }, "session": { "autoCompactTokenLimit": 50 } }));
        assert_eq!(
            status,
            ContextStatus { used_tokens: 7.0, current_estimated_tokens: 0.0, compaction_current_estimated_tokens: 3.0, compaction_trigger_tokens: 100.0, compaction_auto_compact_token_limit: 0.0, session_auto_compact_token_limit: 50.0 }
        );
        assert_eq!(context_status_of(&Value::Null), ContextStatus::default());
    }

    #[test]
    fn activity_is_the_latest_use_of_a_session_with_a_visible_conversation() {
        let no_attachments = |_: &Value| -> Option<String> { None };
        let reminder_only = json!({ "lastUsedAt": 500, "messages": [{ "role": "user", "content": "<system-reminder>x</system-reminder>" }, { "role": "assistant", "content": "." }] });
        assert_eq!(session_activity_timestamp(&reminder_only, 9.0, 0.0, &no_attachments), 0.0);
        let session = json!({ "updatedAt": "1970-01-01T00:00:02Z", "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }] });
        assert_eq!(session_activity_timestamp(&session, 9.0, 0.0, &no_attachments), 2000.0);
        assert_eq!(session_activity_timestamp(&session, 9.0, 7000.0, &no_attachments), 7000.0);
        let bare = json!({ "messages": [{ "role": "tool", "content": "" }] });
        assert_eq!(session_activity_timestamp(&bare, 9.0, 0.0, &no_attachments), 9.0);
        let by_attachment = json!({ "lastUsedAt": 4, "messages": [{ "role": "user", "content": [{ "type": "text", "ref": "a" }, { "type": "image" }] }] });
        assert_eq!(prompt_content_text(&by_attachment["messages"][0]["content"], &|part: &Value| part.get("ref").map(|_| "attached".to_owned())), "attached\n[Image]");
        assert_eq!(prompt_content_text(&json!(7), &no_attachments), "7");
    }
}
