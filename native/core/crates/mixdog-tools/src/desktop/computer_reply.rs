//! The tool's reply to a helper action (`buildActionReply`, `host/action-reply.ts`; the rows of `runComputerSequence`,
//! `input/sequence.ts`): what the action did (`effect`, `verified`, `delivery`), the refusal code it carried, and the verdict
//! that tells the model whether to go on, re-observe or escalate.

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::computer_backend::parts_of;
use super::computer_backend::text_of;

/// The reply to a single (not `act`) action: a helper result that names its action is shaped as the action's payload; any
/// other (a read, a plain text) is the helper's text and image.
pub(super) fn single(action: &str, result: &Map<String, Value>) -> Result<Vec<ToolPart>, ComputerError> {
    if result.get("action").and_then(Value::as_str).is_none_or(str::is_empty) {
        return parts_of(result);
    }
    let mut parts = parts_of(result)?;
    let shaped = Value::Object(payload(action, result)).to_string();
    // The payload adds fields to the helper's text: it is held to the same bound.
    if shaped.encode_utf16().count() > MAX_TEXT_CHARS {
        return Err(ComputerError::Failed {
            code: "computer_invalid_reply".into(),
            message: "computer bridge returned invalid or oversized text".into(),
        });
    }
    parts[0] = ToolPart::Text(shaped);
    Ok(parts)
}

/// The longest reply text (`MAX_TEXT_CHARS` of the bridge client).
const MAX_TEXT_CHARS: usize = 1_000_000;

/// The step's own reply as TS parsed it (`sequence-runner.ts`): the action payload when the helper named its action, else the
/// JSON its text carries (a quiet wait's), else a plain message.
fn step_payload(action: &str, result: &Map<String, Value>) -> Map<String, Value> {
    if result.get("action").and_then(Value::as_str).is_some_and(|name| !name.is_empty()) {
        return payload(action, result);
    }
    let text = text_of(result);
    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&text) {
        return parsed;
    }
    let mut plain = Map::new();
    plain.insert("ok".into(), json!(true));
    plain.insert("action".into(), json!(action));
    plain.insert("message".into(), json!(text));
    plain
}

/// `computerCursorFeedback` (`shared/cursor-feedback.ts`): only its boolean facts, and none at all when none remain.
fn cursor_feedback(value: Option<&Value>) -> Option<Value> {
    let given = value?.as_object()?;
    let kept: Map<String, Value> = ["system_theme_applied", "system_theme_restored", "pointer_moved", "focus_masked"]
        .into_iter()
        .filter_map(|key| given.get(key).filter(|value| value.is_boolean()).map(|value| (key.to_string(), value.clone())))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

/// One row of an `act` reply: the step's payload as the sequence reports it.
pub(super) fn row(step_index: usize, action: &str, result: &Map<String, Value>) -> Value {
    let payload = step_payload(action, result);
    let verdict = payload.get("verdict").filter(|verdict| !verdict.is_null());
    let failed = payload.get("ok") == Some(&Value::Bool(false)) || verdict.and_then(|v| v.get("decision")) == Some(&json!("escalate"));
    let uncertain = payload.get("input_may_have_executed") == Some(&Value::Bool(true));
    let status = match (failed, uncertain) {
        (false, _) => "succeeded",
        (true, true) => "uncertain",
        (true, false) => "failed",
    };
    let mut row = Map::new();
    row.insert("index".into(), json!(step_index));
    row.insert("action".into(), json!(action));
    row.insert("ok".into(), json!(!failed));
    row.insert("status".into(), json!(status));
    let text_field = |key: &str| payload.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
    row.insert("effect".into(), json!(text_field("effect").unwrap_or("unverifiable")));
    row.insert("verified".into(), json!(payload.get("verified") == Some(&Value::Bool(true))));
    row.insert("path".into(), json!(text_field("path").unwrap_or("unknown")));
    // delivery_accepted only as the step gave it, a boolean or null; absent when it said nothing.
    if let Some(accepted) = payload.get("delivery_accepted").filter(|value| value.is_boolean() || value.is_null()) {
        row.insert("delivery_accepted".into(), accepted.clone());
    }
    for key in ["input_may_have_executed", "quiet_wait"] {
        if let Some(value) = payload.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    if let Some(feedback) = cursor_feedback(payload.get("cursor_feedback")) {
        row.insert("cursor_feedback".into(), feedback);
    }
    if failed && let Some(message) = payload.get("message").filter(|m| m.as_str().is_some_and(|s| !s.is_empty())) {
        row.insert("message".into(), message.clone());
    }
    if let Some(code) = payload.get("code") {
        row.insert("code".into(), code.clone());
    }
    row.insert("verdict".into(), verdict.cloned().unwrap_or(Value::Null));
    if let Some(transition) = payload.get("window_transition") {
        row.insert("window_transition".into(), transition.clone());
    }
    Value::Object(row)
}

/// `semanticVerdict` and `semanticActionReply`'s payload: `ok` is false exactly when the helper reported a code.
fn payload(action: &str, result: &Map<String, Value>) -> Map<String, Value> {
    let text_field = |key: &str| result.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
    let flag = |key: &str| result.get(key) == Some(&Value::Bool(true));
    let verified = flag("verified");
    let effect = text_field("effect").unwrap_or("unverifiable");
    let code = text_field("code");
    let delivery = text_field("delivery").unwrap_or("background");
    let next_target = result.get("window_transition").and_then(|t| t.get("next_target")).is_some_and(|t| !t.is_null());
    let recommended = recommended_recovery(effect, code, delivery, next_target);
    let decision = if flag("goal_verified") || verified {
        "done"
    } else if effect == "suspected_noop" || code.is_some() {
        "escalate"
    } else {
        "verify_fresh_state"
    };
    let mut verdict = Map::new();
    verdict.insert("decision".into(), json!(decision));
    if let Some(recommended) = recommended {
        verdict.insert("recommended".into(), json!(recommended));
    }
    let mut out = Map::new();
    out.insert("ok".into(), json!(code.is_none()));
    out.insert("action".into(), json!(text_field("action").unwrap_or(action)));
    let message = if result.get("text").is_some_and(Value::is_string) { text_of(result) } else { String::new() };
    out.insert("message".into(), json!(message));
    out.insert("effect".into(), json!(effect));
    out.insert("verified".into(), json!(verified));
    out.insert("delivery_accepted".into(), result.get("delivery_accepted").filter(|v| v.is_boolean()).cloned().unwrap_or(Value::Null));
    out.insert("goal_verified".into(), json!(flag("goal_verified") || verified));
    if flag("input_may_have_executed") {
        out.insert("input_may_have_executed".into(), json!(true));
    }
    // The target refused the no-activate hold, or the foreground lock was unavailable.
    if text_field("activation_protection") == Some("unavailable") {
        out.insert("activation_protection".into(), json!("unavailable"));
    }
    if let Some(value @ Value::Object(_)) = result.get("foreground_lock") {
        out.insert("foreground_lock".into(), value.clone());
    }
    out.insert("path".into(), json!(text_field("path").unwrap_or("unknown")));
    out.insert("delivery".into(), json!(delivery));
    if let Some(feedback) = cursor_feedback(result.get("cursor_feedback")) {
        out.insert("cursor_feedback".into(), feedback);
    }
    if let Some(changed) = result.get("state_changed").filter(|v| v.is_boolean()) {
        out.insert("state_changed".into(), changed.clone());
    }
    if let Some(id) = text_field("window_id") {
        out.insert("window_id".into(), json!(id));
    }
    if let Some(pid) = result.get("pid").and_then(Value::as_i64) {
        out.insert("pid".into(), json!(pid));
    }
    if let Some(hint) = text_field("app_hint") {
        out.insert("app_hint".into(), json!(hint));
    }
    if let Some(value @ Value::Object(_)) = result.get("saved_login") {
        out.insert("saved_login".into(), value.clone());
    }
    if let Some(code) = code {
        out.insert("code".into(), json!(code));
    }
    if let Some(transition @ Value::Object(_)) = result.get("window_transition") {
        out.insert("window_transition".into(), transition.clone());
    }
    if let Some(recommended) = recommended {
        out.insert("escalation".into(), json!(recommended));
    }
    out.insert("verdict".into(), Value::Object(verdict));
    out
}

/// `recommendedRecovery` (`observation/analysis.ts`): where a refused or doubtful action sends the model next.
fn recommended_recovery(effect: &str, code: Option<&str>, delivery: &str, next_target: bool) -> Option<&'static str> {
    if next_target {
        return Some("switch_target");
    }
    match code {
        Some("target_mismatch" | "stale_target" | "stale_frame" | "user_input_active") => return Some("recapture"),
        Some("foreground_unavailable" | "foreground_changed") => return Some("user"),
        // A target class that cannot take posted input is not helped by another observation.
        Some("background_unsupported") => return Some("foreground"),
        _ => {}
    }
    let background_refusal = code.is_some_and(|c| c.starts_with("background_"));
    (delivery == "background" && (effect == "suspected_noop" || background_refusal)).then_some("recapture")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else { panic!("object") };
        map
    }

    fn run(result: Value) -> Value {
        Value::Object(payload("key", &object(result)))
    }

    #[test]
    fn a_confirmed_action_is_done() {
        let p = run(json!({ "action": "key", "effect": "confirmed", "verified": true, "text": "pressed", "delivery": "foreground" }));
        assert_eq!(p["ok"], true);
        assert_eq!(p["verdict"], json!({ "decision": "done" }));
        assert_eq!(p["message"], "pressed");
        assert_eq!(p["path"], "unknown");
    }

    #[test]
    fn an_unverifiable_action_asks_for_fresh_state() {
        let p = run(json!({ "action": "key" }));
        assert_eq!(p["effect"], "unverifiable");
        assert_eq!(p["verified"], false);
        assert_eq!(p["verdict"], json!({ "decision": "verify_fresh_state" }));
        assert_eq!(p["delivery_accepted"], Value::Null);
    }

    #[test]
    fn a_suspected_noop_in_background_escalates_to_recapture() {
        let p = run(json!({ "action": "key", "effect": "suspected_noop" }));
        assert_eq!(p["ok"], true);
        assert_eq!(p["verdict"], json!({ "decision": "escalate", "recommended": "recapture" }));
    }

    #[test]
    fn a_background_refusal_routes_to_foreground() {
        let p = run(json!({ "action": "key", "code": "background_unsupported", "delivery_accepted": false, "effect": "suspected_noop" }));
        assert_eq!(p["ok"], false);
        assert_eq!(p["code"], "background_unsupported");
        assert_eq!(p["escalation"], "foreground");
        assert_eq!(p["verdict"], json!({ "decision": "escalate", "recommended": "foreground" }));
    }

    #[test]
    fn background_unavailable_keeps_input_may_have_executed() {
        let p = run(json!({ "action": "type", "code": "background_unavailable", "input_may_have_executed": true }));
        assert_eq!(p["ok"], false);
        assert_eq!(p["input_may_have_executed"], true);
        assert_eq!(p["verdict"], json!({ "decision": "escalate", "recommended": "recapture" }));
    }

    #[test]
    fn a_terminate_confirmation_is_an_escalation_without_a_route() {
        let p = run(json!({ "action": "close_window", "code": "confirmation_required", "text": "confirm" }));
        assert_eq!(p["ok"], false);
        assert_eq!(p["verdict"], json!({ "decision": "escalate" }));
        assert!(p.get("escalation").is_none());
    }

    #[test]
    fn unavailable_activation_protection_is_reported() {
        let p = run(json!({ "action": "key", "delivery_accepted": true, "delivery": "background", "activation_protection": "unavailable" }));
        assert_eq!(p["activation_protection"], "unavailable");
        assert_eq!(p["delivery_accepted"], true);
    }

    #[test]
    fn a_row_is_uncertain_when_a_failed_step_may_have_landed() {
        let result = object(json!({ "action": "key", "code": "user_input_active", "input_may_have_executed": true, "text": "stop" }));
        let row = row(2, "key", &result);
        assert_eq!(row["index"], 2);
        assert_eq!(row["ok"], false);
        assert_eq!(row["status"], "uncertain");
        assert_eq!(row["message"], "stop");
        assert_eq!(row["code"], "user_input_active");
    }

    #[test]
    fn a_row_keeps_what_a_step_without_an_action_said() {
        // A quiet wait reports its JSON in the text, with no action of its own.
        let quiet = object(json!({ "text": "{\"ok\":true,\"action\":\"wait\",\"quiet_wait\":{\"settled\":true}}" }));
        let quiet_row = row(1, "wait", &quiet);
        assert_eq!(quiet_row["quiet_wait"], json!({ "settled": true }));
        assert_eq!(quiet_row["verdict"], Value::Null);
        assert_eq!((quiet_row["effect"].clone(), quiet_row["path"].clone()), (json!("unverifiable"), json!("unknown")));
        // A plain text step: no verdict, no delivery_accepted.
        let plain = row(2, "wait", &object(json!({ "text": "waited 1s" })));
        assert_eq!(plain["verdict"], Value::Null);
        assert!(plain.get("delivery_accepted").is_none());
        assert_eq!(plain["status"], "succeeded");
    }

    #[test]
    fn cursor_feedback_keeps_only_its_boolean_facts() {
        let p = run(json!({ "action": "click", "cursor_feedback": { "pointer_moved": true, "theme": "x", "focus_masked": "no" } }));
        assert_eq!(p["cursor_feedback"], json!({ "pointer_moved": true }));
        let none = run(json!({ "action": "click", "cursor_feedback": { "theme": "x" } }));
        assert!(none.get("cursor_feedback").is_none());
    }
}
