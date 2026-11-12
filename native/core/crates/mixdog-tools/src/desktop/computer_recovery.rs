//! What the model is told to do next when a computer action fails (`computer-bridge/error-recovery.mjs`): the failure's
//! category (the leading code token of its text) names the next action (`capture`, `list`, `diagnose`, `wait_for_user`, `user`,
//! `handoff_user`) and a guidance sentence that keeps it from replaying input that may have been delivered.

use serde_json::Value;

/// The next step a failed computer action calls for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    pub code: String,
    pub next: &'static str,
    pub guidance: String,
}

fn recovery(code: &str, next: &'static str, guidance: impl Into<String>) -> Option<Recovery> {
    Some(Recovery { code: code.to_owned(), next, guidance: guidance.into() })
}

/// `computerErrorCode(text)`: the lower-cased `[a-z][a-z0-9_]{0,79}` before the first `:` or `|`, after a leading `Error:`.
pub fn lead_code(text: &str) -> String {
    let trimmed = mixdog_js::js_trim(text);
    let body = match trimmed.get(..6) {
        Some(head) if head.eq_ignore_ascii_case("Error:") => mixdog_js::js_trim_start(&trimmed[6..]),
        _ => trimmed,
    };
    let Some(end) = body.find([':', '|']) else { return String::new() };
    let head = &body[..end];
    let valid = !head.is_empty() && head.len() <= 80 && head.starts_with(|c: char| c.is_ascii_alphabetic()) && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid { head.to_ascii_lowercase() } else { String::new() }
}

/// The category of an error text: its code token, else the two sentences the host words without one.
fn error_code(message: &str) -> String {
    let text = {
        let trimmed = mixdog_js::js_trim(message);
        match trimmed.get(..6) {
            Some(head) if head.eq_ignore_ascii_case("Error:") => mixdog_js::js_trim_start(&trimmed[6..]).to_owned(),
            _ => trimmed.to_owned(),
        }
    };
    let explicit = lead_code(&text);
    if !explicit.is_empty() {
        return explicit;
    }
    let lower = text.to_lowercase();
    if lower.contains("window_id is stale") || lower.contains("window is stale") {
        return "window_stale".to_owned();
    }
    // `/fresh capture.*first|unknown frame_id/i`: `.` stops at a line end.
    if lower.contains("unknown frame_id") || lower.lines().any(|line| line.find("fresh capture").is_some_and(|at| line[at + "fresh capture".len()..].contains("first"))) {
        return "stale_frame".to_owned();
    }
    String::new()
}

fn target_label(args: &Value) -> String {
    let input = args.get("input");
    let named = |key: &str| input.and_then(|i| i.get(key)).filter(|v| mixdog_js_truthy(v)).map(mixdog_js::value_to_string);
    if let Some(id) = named("window_id") {
        return format!("window {id}");
    }
    if let Some(app) = named("app") {
        return format!("app \"{app}\"");
    }
    "the exact target window".to_owned()
}

fn mixdog_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

const SECRET_HANDOFF: &str = "hand the secret to the user with handoff_user (kind \"secret\", surface \"computer\")";
const STEP_HANDOFF: &str = "hand the step to the user with handoff_user (kind \"takeover\", surface \"computer\", need \"sign_in\")";

fn recapture_lease_guidance(code: &str, target: &str) -> String {
    match code {
        "computer_target_in_use" => format!("Another session owns {target}. Do not retry the stale action; wait for its lease to release, then capture fresh state."),
        "computer_foreground_available_recapture_required" => format!("The foreground lane is now available. Capture {target} again before issuing any input."),
        _ => format!("The target lease is now available. Capture {target} again before issuing any input."),
    }
}

fn timeout_recovery(code: &str, args: &Value, target: &str) -> Option<Recovery> {
    // Reads send no input, so their timeout is a provider budget, not an uncertain mutation.
    let action = args.get("action").map(mixdog_js::value_to_string).unwrap_or_default();
    if ["capture", "list", "diagnose", "verify"].contains(&action.as_str()) {
        return recovery(code, "capture", format!("The read exceeded its bounded budget and sent no input, so no cleanup or user-control guard applies. Capture {target} with mode=\"state\" or \"som\": pixels and OCR stay usable while that window's accessibility provider is slow."));
    }
    recovery(code, "diagnose", format!("The command may have executed before timing out. Do not repeat it or switch delivery modes. Diagnose the host first; cleanup and user-control guards must clear through verified recovery. Then capture {target} and inspect the effect before issuing any new input."))
}

fn foreground_recovery(code: &str, target: &str) -> Option<Recovery> {
    match code {
        "foreground_changed" => recovery(code, "user", "Focus changed during dispatch. Do not pull it back or retry input automatically. Check user control, then obtain fresh state when control is available."),
        "foreground_unavailable" => recovery(code, "user", format!("The system did not grant foreground focus (macOS refuses it while another app is active). Ask the user to activate {target}, or use a foreground click on the window, which activates it; then capture fresh state. Do not substitute background input or repeat the failed gesture.")),
        _ => None,
    }
}

fn recovery_for_code(code: &str, args: &Value) -> Option<Recovery> {
    let target = target_label(args);
    match code {
        "computer_background_cleanup_unconfirmed" => return recovery(code, "user", "The worker stopped, but release of target-local window-message input is unconfirmed. Do not replay input, change delivery, or clear the guard. Ask the user to inspect and recover the affected window; a host restart requires approval and does not itself prove that the application input was released."),
        "ambiguous_window_target" | "window_stale" | "window_target_not_found" => return recovery(code, "list", "List windows and retry with one current exact window_id."),
        "stale_frame" | "stale_target" | "target_mismatch" => return recovery(code, "capture", format!("Capture {target} again and use only the fresh ref, OCR mark, or frame_id.")),
        "computer_target_available_recapture_required" | "computer_foreground_available_recapture_required" | "computer_target_in_use" => return recovery(code, "capture", recapture_lease_guidance(code, &target)),
        "computer_user_control_active" | "computer_user_takeover" => return recovery(code, "wait_for_user", "Computer Use yielded to the user. Call wait_for_user for bounded waiting. The user's Resume on the overlay continues the pause. A foreground action the user's input interrupts yields only that agent (see the user_input_active reply); an explicit Pause/Stop or uncertain cleanup pauses every agent and needs the user. Stop cancels the task. Timeout does not authorize input. After resumed, capture fresh state; never replay interrupted input."),
        "user_input_active" => return recovery(code, "capture", format!("The user's own input interrupted this background action only; the session keeps running and this is not a pause. Do not call wait_for_user for it. Capture {target} again before any further input, and never replay the interrupted input, which may have been partly delivered.")),
        "input_recovery_unconfirmed" => return recovery(code, "wait_for_user", "The desktop state after the action could not be verified, so Computer Use stopped the session and handed the desktop to the user. Do not repeat the mutation. Call wait_for_user: the host resumes by itself once the desktop has been quiet for its interval, or when the user presses Resume. After resumed, capture fresh state and inspect the effect before any new input."),
        "input_observation_unavailable" | "computer_cursor_unavailable" => return recovery(code, "diagnose", "Input or recovery could not be verified. Do not repeat the mutation. Diagnose the exact target and inspect fresh state only when user control is not active."),
        "computer_cleanup_pending" | "computer_abort_cleanup_unconfirmed" | "input_cleanup_unconfirmed" | "privileged_worker_cleanup_unconfirmed" => return recovery(code, "user", "Worker exit and input release are not confirmed. Wait for cleanup; do not replay input or reset the guard. If cleanup remains failed, ask the user to press Ctrl+Alt+Esc (emergency Stop): the host must verify worker exit and release of automation-owned input before recovery. If emergency Stop cannot confirm cleanup, an explicitly approved host restart is required."),
        "foreground_input_not_ready" => return recovery(code, "capture", format!("No input was sent. Foreground delivery needs an observation taken while the user's own input was idle. Let their input settle and capture {target} again, or send this action through background delivery when it supports one.")),
        "saved_login_refused" | "saved_login_changed" | "saved_login_unavailable" => return recovery(code, "handoff_user", format!("Nothing was written. If the refusal lists stored masked labels and the user's account is one of them, use that label; otherwise {SECRET_HANDOFF}. Never type the secret yourself or try another window or field to get past the check.")),
        "saved_login_unconfirmed" => return recovery(code, "handoff_user", format!("The saved value may have been written. Do not call saved_login again for this field and do not type it yourself; {STEP_HANDOFF} to check the field and finish signing in.")),
        "computer_command_timeout" => return timeout_recovery(code, args, &target),
        _ => {}
    }
    if code.starts_with("menu_") {
        return recovery(code, "capture", format!("Capture {target} again; empty accessibility automatically uses OCR. Use a fresh OCR mark or frame point and do not retry the same menu path unchanged."));
    }
    if let Some(found) = foreground_recovery(code, &target) {
        return Some(found);
    }
    if code.starts_with("background_") {
        return recovery(code, "capture", format!("Capture {target} and inspect whether any input was delivered. Consider foreground only if no input was sent and visible control is within the user's scope; never silently change delivery or replay uncertain input."));
    }
    if matches!(code, "pixel_unavailable" | "observation_unavailable") {
        return recovery(code, "capture", format!("Recapture {target}; do not use coordinates until a fresh frame reports pixel_status=\"available\"."));
    }
    None
}

/// `computerToolErrorRecovery(message, args)`: `args` is the call's arguments (`action`, `input`).
pub fn tool_error_recovery(message: &str, args: &Value) -> Option<Recovery> {
    recovery_for_code(&error_code(message), args)
}

/// `formatComputerToolError(message, args)`: the error as the model reads it.
pub fn format_tool_error(message: &str, args: &Value) -> String {
    let text = if message.is_empty() { "computer bridge request failed" } else { message };
    match tool_error_recovery(text, args) {
        Some(found) => format!("Error: {text}\nRecovery: {}", found.guidance),
        None => format!("Error: {text}"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/computer-error-recovery/golden.json");

    fn cases() -> Vec<Value> {
        let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
        golden["cases"].as_array().expect("cases").clone()
    }

    /// `computerToolErrorRecovery` as Node's is for the message and what `{code, next, guidance}` it gives.
    fn recorded(recovery: Option<Recovery>) -> Value {
        recovery.map_or(Value::Null, |r| json!({ "code": r.code, "next": r.next, "guidance": r.guidance }))
    }

    /// Every failure category over every target a call can name: the recovery and the text the model reads, whole.
    #[test]
    fn recovery_and_error_text_equal_the_recorded_node_output() {
        let mut compared = 0;
        for case in cases() {
            let name = case["case"].as_str().expect("name");
            let observed = &case["observed"];
            if let Some(code) = case["input"]["code"].as_str() {
                for row in observed.as_array().expect("rows") {
                    let message = format!("{code}: private window details");
                    assert_eq!(recorded(tool_error_recovery(&message, &row["args"])), row["recovery"], "{name} / {}", row["label"]);
                    assert_eq!(format_tool_error(&message, &row["args"]), row["text"], "{name} / {}", row["label"]);
                    compared += 1;
                }
            } else if name == "separators, prefixes and codeless sentences" {
                let args = json!({ "action": "act", "input": { "window_id": "hwnd:0x1" } });
                for row in observed.as_array().expect("rows") {
                    let message = row["message"].as_str().expect("message");
                    assert_eq!(recorded(tool_error_recovery(message, &args)), row["recovery"], "{message:?}");
                    assert_eq!(format_tool_error(message, &args), row["text"], "{message:?}");
                    compared += 1;
                }
            } else {
                assert_eq!(format_tool_error("", &json!({})), observed["empty"]);
                compared += 1;
            }
        }
        assert!(compared > 100, "{compared}");
    }
}
