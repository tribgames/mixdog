//! `act`: the helper `sequence` a tool call became, run as `runBoundedSequence` (`host/sequence-runner.ts`) and
//! `executeComputerSequenceSteps` (`input/sequence.ts`): its steps validated before any is sent, sent one at a time with one
//! row each, stopped by a failed or uncertain step or a target transition, its holds released, then a capture of the window
//! the sequence ended on.

use std::time::Duration;

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_app_owned::APP_OWNED;
use super::computer_app_owned::app_input;
use super::computer_app_owned::falls_back;
use super::computer_backend::HelperFailure;
use super::computer_backend::ProcessComputerBackend;
use super::computer_backend::error_text;
use super::computer_command::DEFAULT_DELIVERY;
use super::computer_command::text;
use super::computer_frames;
use super::computer_pixels::read_displays;
use super::computer_pointer::prepare_cursor;
use super::computer_policy;
use super::computer_recovery::lead_code;
use super::computer_reply;
use super::computer_settle;

/// `runBoundedSequence`: a sequence has 1..6 steps and at most 10 s of `wait`.
const MAX_STEPS: usize = 6;
const MAX_TOTAL_WAIT_SECONDS: f64 = 10.0;
/// `createInputPreflight`'s budget.
const PREFLIGHT_TIMEOUT: Duration = Duration::from_millis(2_000);
/// `TAKEOVER_CODES` (`shared/takeover-codes.ts`): a step that ends with one hands the desktop back to the user instead of
/// ending as a failed row.
const TAKEOVER_CODES: &[&str] = &["input_cleanup_unconfirmed"];

/// `POINTER_ACTIONS` (`command-router.ts`): the actions that move or draw the agent's arrow, which the overlay readies first.
const POINTER_ACTIONS: &[&str] = &[
    "invoke", "click", "double_click", "right_click", "middle_click", "triple_click", "mouse_down", "mouse_up", "mouse_move", "drag", "scroll", "type", "key", "key_down",
    "key_up",
];

// `FIRST_STEP_ACTIONS`, `CONTINUATION_STEP_ACTIONS` and `CONTINUATION_REF_STEP_ACTIONS`.
const FIRST_STEP_ACTIONS: &[&str] = &[
    "invoke", "set_value", "click", "right_click", "middle_click", "double_click", "triple_click", "mouse_down", "mouse_up", "mouse_move", "drag", "scroll",
    "type", "key", "key_down", "key_up",
];
const CONTINUATION_STEP_ACTIONS: &[&str] = &["type", "key", "key_down", "key_up", "wait"];
const CONTINUATION_REF_STEP_ACTIONS: &[&str] = &["invoke", "set_value", "click", "right_click", "middle_click", "double_click", "triple_click", "scroll"];
/// What only the call names, and the marks and coordinates of a frame the first step already invalidated.
const ROOT_ONLY_FIELDS: &[&str] = &["window_id", "window", "app", "screen", "session_id", "delivery"];
const CONTINUATION_FRAME_FIELDS: &[&str] = &["element", "frame_id", "x", "y", "to", "to_element", "to_x", "to_y", "waypoints"];
const POINT_STEP_FIELDS: &[&str] = &["action", "ref", "element", "frame_id", "x", "y", "modifiers"];

/// `ALLOWED_STEP_FIELDS`.
fn allowed_fields(action: &str) -> &'static [&'static str] {
    match action {
        "invoke" => &["action", "ref", "modifiers"],
        // A value is written through the element, so it carries a semantic target and its text, never a pixel or a modifier.
        "set_value" => &["action", "ref", "element", "text"],
        "click" | "right_click" | "middle_click" | "double_click" | "triple_click" | "mouse_down" | "mouse_up" | "mouse_move" => POINT_STEP_FIELDS,
        "drag" => &["action", "ref", "element", "to", "to_element", "frame_id", "x", "y", "to_x", "to_y", "waypoints", "button", "modifiers"],
        "scroll" => &["action", "ref", "element", "frame_id", "x", "y", "direction", "amount", "modifiers"],
        "type" => &["action", "ref", "element", "frame_id", "x", "y", "text"],
        "key" | "key_down" | "key_up" => &["action", "ref", "keys"],
        "wait" => &["action", "duration", "quiet"],
        _ => &[],
    }
}

fn has_ref(step: &Value) -> bool {
    step.get("ref").is_some_and(Value::is_string)
}

/// `assertSequenceStep`: one step's shape, the action allowed at its position, no root-only or target fields, and the payload
/// its action needs. Answers the step as an object, or the refusal.
fn assert_step(step: &Value, index: usize) -> Result<&Map<String, Value>, String> {
    let n = index + 1;
    let Some(fields) = step.as_object() else { return Err(format!("sequence step {n} must be an object")) };
    let action = fields.get("action").and_then(Value::as_str).unwrap_or_default();
    if index == 0 {
        if !FIRST_STEP_ACTIONS.contains(&action) {
            return Err("sequence first step must be a supported input action".into());
        }
    } else if CONTINUATION_REF_STEP_ACTIONS.contains(&action) {
        if fields.get("ref").and_then(Value::as_str).is_none_or(str::is_empty) {
            return Err(format!("sequence step {n} {action} requires a ref from the same observation"));
        }
    } else if !CONTINUATION_STEP_ACTIONS.contains(&action) {
        return Err("sequence continuation steps must be type, key, wait, or a ref-addressed input".into());
    }
    let overrides: Vec<&str> = ROOT_ONLY_FIELDS.iter().copied().filter(|field| fields.contains_key(*field)).collect();
    if !overrides.is_empty() {
        return Err(format!("sequence step {n} cannot override root field(s): {}", overrides.join(", ")));
    }
    let extra: Vec<&str> = fields.keys().map(String::as_str).filter(|field| !allowed_fields(action).contains(field)).collect();
    if !extra.is_empty() {
        return Err(format!("sequence step {n} does not accept field(s): {}", extra.join(", ")));
    }
    if index > 0 && CONTINUATION_FRAME_FIELDS.iter().any(|field| fields.contains_key(*field)) {
        return Err(format!("sequence step {n} addresses elements by ref only"));
    }
    if matches!(action, "type" | "set_value") && !fields.get("text").is_some_and(Value::is_string) {
        return Err(format!("sequence step {n} requires string text"));
    }
    // A value is written through the control itself, so a target is mandatory here rather than optional as for a type step.
    if action == "set_value" && !fields.contains_key("ref") && !fields.contains_key("element") {
        return Err(format!("sequence step {n} requires ref or element"));
    }
    if action == "key" && !fields.get("keys").is_some_and(Value::is_string) {
        return Err(format!("sequence step {n} requires string keys"));
    }
    if action == "wait" && !fields.get("duration").and_then(Value::as_f64).is_some_and(|d| d.is_finite() && (0.0..=5.0).contains(&d)) {
        return Err(format!("sequence step {n} requires duration from 0 to 5 seconds"));
    }
    if action == "wait" && fields.get("quiet").is_some_and(|quiet| !quiet.is_boolean()) {
        return Err(format!("sequence step {n} quiet must be a boolean"));
    }
    Ok(fields)
}

/// The host's refusal of a plain message, with the code it leads with.
fn refusal(message: impl Into<String>) -> ComputerError {
    HelperFailure { text: message.into(), result: None }.into_error()
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `validateSteps`: each step as the command it is sent as: the call's window, delivery and session, `input_continues` on every
/// step but the last, `retain_refs` on a step a later ref step outlives, `sequence_continuation` on a later step that addresses a ref.
fn plan(steps: &[Value], window_id: &str, delivery: &str, session_id: &str) -> Result<Vec<Map<String, Value>>, ComputerError> {
    let mut planned = Vec::with_capacity(steps.len());
    let mut total_wait = 0.0;
    for (index, step) in steps.iter().enumerate() {
        let mut command = assert_step(step, index).map_err(refusal)?.clone();
        command.insert("window_id".into(), json!(window_id));
        command.insert("delivery".into(), json!(delivery));
        command.insert("session_id".into(), json!(session_id));
        if index + 1 < steps.len() {
            command.insert("input_continues".into(), json!(true));
        }
        if steps[index + 1..].iter().any(has_ref) {
            command.insert("retain_refs".into(), json!(true));
        }
        // `continuationRef`: a later step with a non-empty ref.
        if index > 0 && step.get("ref").and_then(Value::as_str).is_some_and(|reference| !reference.is_empty()) {
            command.insert("sequence_continuation".into(), json!(true));
        }
        if text(&command, "action") == "wait" {
            total_wait += command.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        }
        planned.push(command);
    }
    if total_wait > MAX_TOTAL_WAIT_SECONDS {
        return Err(refusal("sequence wait steps accept at most 10 total seconds; use verify for longer conditions"));
    }
    Ok(planned)
}

/// What the steps of a sequence came to (`executeComputerSequenceSteps`).
struct Sequence {
    rows: Vec<Value>,
    completed_steps: usize,
    stopped_reason: String,
    final_window_id: String,
    last_transition: Option<Value>,
    /// A step's target refused the no-activate hold, or the foreground lock was unavailable.
    activation_unprotected: bool,
}

/// A step that ended in an error as the result its row is shaped from: a refusal is the step's outcome, not the sequence's.
fn failed_result(action: &str, error: ComputerError) -> Result<Map<String, Value>, ComputerError> {
    let (ComputerError::Failed { message, .. } | ComputerError::InvalidInput { reason: message }) = error else { return Err(error) };
    let code = lead_code(&message);
    let code = if code.is_empty() { "step_failed".to_owned() } else { code };
    let mut result = Map::new();
    result.insert("action".into(), json!(action));
    result.insert("text".into(), json!(message));
    result.insert("effect".into(), json!("unverifiable"));
    // User input interrupts only this step: the row stands, the input may already have landed, and the steps after it never run.
    if code == "user_input_active" {
        result.insert("input_may_have_executed".into(), json!(true));
    }
    result.insert("code".into(), json!(code));
    Ok(result)
}

/// The row of a step that ended in an error carries the sequence's own verdict, not the one a helper reply earns.
fn caught_verdict(row: &mut Value) {
    let recommended = if row["code"] == "user_input_active" { "recapture" } else { "inspect_failed_step" };
    row["verdict"] = json!({ "decision": "escalate", "recommended": recommended });
}

/// A takeover code a step ended with, as the error that reaches the global takeover.
fn takeover(row: &Value) -> Option<ComputerError> {
    let code = TAKEOVER_CODES.iter().copied().find(|code| row["code"] == *code)?;
    let message = row["message"].as_str().unwrap_or_default();
    let message = if message.starts_with(code) { message.to_owned() } else { format!("{code}: {message}") };
    Some(ComputerError::Failed { code: code.into(), message })
}

/// `windowTransitionRetargets`.
fn retargets(transition: &Value) -> bool {
    let listed = |key: &str| transition.get(key).and_then(Value::as_array).is_some_and(|windows| !windows.is_empty());
    listed("opened_windows") || listed("closed_windows") || transition.get("next_target").is_some_and(|next| !next.is_null())
}

/// `input_cleanup_unconfirmed`, once: a hold failure that already leads with the code is not prefixed again.
fn cleanup_unconfirmed(detail: String) -> ComputerError {
    const CODE: &str = "input_cleanup_unconfirmed";
    let message = if detail.starts_with(CODE) { detail } else { format!("{CODE}: {detail}") };
    ComputerError::Failed { code: CODE.into(), message }
}

/// `preflightRefusedReply`: no step ran, and the reply says so step by step so the caller can pick another delivery.
fn preflight_refused(window_id: &str, planned: &[Map<String, Value>], refusal: &ComputerError) -> Value {
    let steps: Vec<Value> = planned
        .iter()
        .enumerate()
        .map(|(index, step)| json!({ "index": index + 1, "action": text(step, "action"), "status": "skipped", "reason": "preflight_refused" }))
        .collect();
    json!({
        "ok": false,
        "action": "act",
        "window_id": window_id,
        "completed": false,
        "completed_steps": 0,
        "total_steps": planned.len(),
        "steps": steps,
        "code": lead_code(&error_text(refusal)),
        "stopped_reason": "preflight_refused",
        "message": error_text(refusal),
        "delivery_accepted": false,
        "input_may_have_executed": false,
        "goal_verified": false,
        "verdict": { "decision": "escalate", "recommended": "select_delivery" },
    })
}

impl ProcessComputerBackend {
    /// `runBoundedSequence`: the window the call names, its steps, and a capture of the window the sequence ended on.
    pub(super) async fn act(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let steps = match command.shift_remove("steps") {
            Some(Value::Array(steps)) => steps,
            _ => Vec::new(),
        };
        let window_id = text(&command, "window_id").to_owned();
        if window_id.is_empty() {
            return Err(refusal("sequence requires exact window_id"));
        }
        if steps.is_empty() || steps.len() > MAX_STEPS {
            return Err(refusal("sequence requires 1..6 steps"));
        }
        let delivery = command.get("delivery").and_then(Value::as_str).unwrap_or(DEFAULT_DELIVERY).to_owned();
        let planned = plan(&steps, &window_id, &delivery, &self.config.session_id)?;
        if delivery != "foreground" {
            self.refresh_app_windows(cancel).await;
        }
        if delivery != "foreground"
            && let Some(refused) = self.preflight(&planned, &window_id, cancel).await?
        {
            return Ok(vec![ToolPart::Text(preflight_refused(&window_id, &planned, &refused).to_string())]);
        }
        let ran = self.run_steps(&planned, &window_id, &delivery, cancel).await;
        // A sequence that stopped early (failed step, target transition, abort) never sends the last step that would end its hold,
        // so every background sequence ends the session's holds itself, before the capture.
        let held = if delivery != "foreground" { self.release_holds(cancel).await? } else { None };
        let sequence = match ran {
            Ok(sequence) => sequence,
            // A target that may still be non-activatable outranks why the steps stopped.
            Err(stopped) => {
                return Err(match held {
                    Some(held) => cleanup_unconfirmed(format!("{held}; the sequence had stopped: {}", error_text(&stopped))),
                    None => stopped,
                });
            }
        };
        let Sequence { rows, completed_steps, stopped_reason, final_window_id, last_transition, activation_unprotected } = sequence;
        let total_steps = planned.len();
        // A hold that may still keep the target non-activatable outranks why the steps stopped and waits for no observation.
        if let Some(held) = held {
            let last_completed = rows.iter().filter(|row| row["ok"] == true).count();
            let last = if last_completed > 0 { format!(" (last completed step {last_completed})") } else { String::new() };
            let stopped = if stopped_reason.is_empty() { String::new() } else { format!(", stopped: {stopped_reason}") };
            return Err(cleanup_unconfirmed(format!("{held}; completed {completed_steps}/{total_steps} steps{last}{stopped}")));
        }
        let completed = completed_steps == total_steps && stopped_reason.is_empty();
        // A window transition or an unfinished sequence earns the whole observation, not a delta.
        let full = !stopped_reason.is_empty() || last_transition.as_ref().is_some_and(retargets);
        let (mut capture_after, observed) = self.observe_after(&command, &final_window_id, full, cancel).await?;
        let unavailable = capture_after.get("ok") == Some(&json!(false));
        let pixel_unavailable = capture_after.get("pixel_status") == Some(&json!("unavailable"));
        let result_code = if !stopped_reason.is_empty() {
            stopped_reason.clone()
        } else if unavailable {
            capture_after.get("code").and_then(Value::as_str).filter(|code| !code.is_empty()).unwrap_or("observation_unavailable").to_owned()
        } else {
            String::new()
        };
        let verdict = if completed && !unavailable {
            let mut verdict = json!({ "decision": "verify_fresh_state" });
            if pixel_unavailable {
                verdict["recommended"] = json!("use_semantic_target");
            }
            verdict
        } else {
            let recommended = if stopped_reason == "target_transition" {
                "switch_target"
            } else if unavailable {
                "recapture"
            } else {
                "inspect_failed_step"
            };
            json!({ "decision": "escalate", "recommended": recommended })
        };
        let successor = final_window_id != window_id;
        capture_after.insert("target_reason".into(), json!(if successor { "sequence_successor" } else { "original_target" }));
        if successor {
            capture_after.insert("previous_window_id".into(), json!(window_id));
        }
        // The reply names the tool's action: the helper's `sequence` is what `act` became.
        let mut payload = Map::new();
        payload.insert("ok".into(), json!(completed && !unavailable));
        if activation_unprotected {
            payload.insert("activation_protection".into(), json!("unavailable"));
        }
        payload.insert("action".into(), json!("act"));
        payload.insert("window_id".into(), json!(window_id));
        payload.insert("completed".into(), json!(completed));
        payload.insert("completed_steps".into(), json!(completed_steps));
        payload.insert("total_steps".into(), json!(total_steps));
        payload.insert("steps".into(), Value::Array(rows));
        if !stopped_reason.is_empty() {
            payload.insert("stopped_reason".into(), json!(stopped_reason));
        }
        if !result_code.is_empty() {
            payload.insert("code".into(), json!(result_code));
        }
        if let Some(transition) = last_transition {
            payload.insert("window_transition".into(), transition);
        }
        payload.insert("goal_verified".into(), json!(false));
        payload.insert("verdict".into(), verdict);
        payload.insert("capture_after".into(), Value::Object(capture_after));
        let mut parts = vec![ToolPart::Text(Value::Object(payload).to_string())];
        parts.extend(observed);
        Ok(parts)
    }

    /// `createInputPreflight`: the background route's refusal of a key or type step, found before any step is sent. `None` when
    /// every step may go (or none needs the route).
    async fn preflight(&self, planned: &[Map<String, Value>], window_id: &str, cancel: &CancellationToken) -> Result<Option<ComputerError>, ComputerError> {
        let native: Vec<Value> = planned
            .iter()
            .filter(|step| matches!(text(step, "action"), "key" | "type"))
            // A step the desktop delivers into its own window never reaches the helper's background route.
            .filter(|step| APP_OWNED.route(step, window_id).is_none())
            .map(|step| {
                let mut row = Map::new();
                for key in ["action", "ref", "keys"] {
                    if let Some(value) = step.get(key).filter(|value| !value.is_null()) {
                        row.insert(key.into(), value.clone());
                    }
                }
                Value::Object(row)
            })
            .collect();
        if native.is_empty() {
            return Ok(None);
        }
        let mut request = Map::new();
        request.insert("action".into(), json!("validate_background_input"));
        request.insert("window_id".into(), json!(window_id));
        request.insert("session_id".into(), json!(self.config.session_id));
        request.insert("read_only".into(), json!(true));
        request.insert("steps".into(), Value::Array(native));
        match self.call_with(request, PREFLIGHT_TIMEOUT, cancel).await {
            Ok(_) => Ok(None),
            // A grammar refusal happens before the first step, not after a possibly completed prefix.
            // The dialog refusals (`backgroundDialogInputError`) are such refusals too.
            Err(error @ ComputerError::Failed { .. }) if matches!(lead_code(&error_text(&error)).as_str(), "background_unsupported" | "focus_required" | "dialog_key_unsupported") => Ok(Some(error)),
            Err(error) => Err(error),
        }
    }

    /// `executeComputerSequenceSteps`: sends each step and shapes its row; stops after a failed, uncertain or retargeting step.
    async fn run_steps(&self, planned: &[Map<String, Value>], window_id: &str, delivery: &str, cancel: &CancellationToken) -> Result<Sequence, ComputerError> {
        let mut sequence = Sequence {
            rows: Vec::new(),
            completed_steps: 0,
            stopped_reason: String::new(),
            final_window_id: window_id.to_owned(),
            last_transition: None,
            activation_unprotected: false,
        };
        for (index, step) in planned.iter().enumerate() {
            let action = text(step, "action").to_owned();
            let (result, caught) = match self.send_step(step.clone(), window_id, delivery, cancel).await {
                Ok(result) => (result, false),
                Err(error) => (failed_result(&action, error)?, true),
            };
            if result.get("activation_protection") == Some(&json!("unavailable")) {
                sequence.activation_unprotected = true;
            }
            let mut row = computer_reply::row(index + 1, &action, &result);
            if caught {
                caught_verdict(&mut row);
            }
            // A step that hands the desktop back to the user is not a step outcome.
            if let Some(error) = takeover(&row) {
                return Err(error);
            }
            let transition = row.get("window_transition").cloned();
            if let Some(next) = transition.as_ref().and_then(|t| t.pointer("/next_target/id")).and_then(Value::as_str) {
                sequence.final_window_id = next.to_owned();
            }
            let retargeted = transition.as_ref().is_some_and(|t| t.get("next_target").is_some_and(|next| !next.is_null()));
            sequence.last_transition = transition;
            let failed = row["ok"] == false;
            if !failed {
                sequence.completed_steps += 1;
            }
            let reason = if failed {
                let named = |value: &Value| value.as_str().filter(|text| !text.is_empty()).map(str::to_owned);
                named(&row["code"]).or_else(|| named(&row["verdict"]["recommended"])).unwrap_or_else(|| "step_failed".into())
            } else if retargeted && index + 1 < planned.len() {
                "target_transition".into()
            } else {
                String::new()
            };
            sequence.rows.push(row);
            if !reason.is_empty() {
                sequence.stopped_reason = reason;
                break;
            }
        }
        for (index, step) in planned.iter().enumerate().skip(sequence.rows.len()) {
            let reason = if sequence.stopped_reason.is_empty() { "prior_step_failed" } else { sequence.stopped_reason.as_str() };
            sequence.rows.push(json!({ "index": index + 1, "action": text(step, "action"), "status": "skipped", "reason": reason }));
        }
        Ok(sequence)
    }

    /// One step through the helper. A background step goes through the helper's `sequence_step`, which reports the windows around
    /// it; any other is the action itself, settled as a single action is.
    async fn send_step(&self, mut step: Map<String, Value>, window_id: &str, delivery: &str, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        // Node admits each step again right before its input transport (`input-dispatch.ts`): observation-only mode turned on
        // mid-sequence refuses the step in the host's words, a failed row that stops the steps left.
        computer_policy::admit(&step, self.observe_only(), &self.frames)?;
        self.assert_display_unchanged(&step, cancel).await?;
        computer_frames::map_step(&self.frames, &mut step)?;
        let action = text(&step, "action").to_owned();
        if POINTER_ACTIONS.contains(&action.as_str()) {
            self.prepare_pointer(&step, &action, window_id, cancel).await?;
        }
        if text(&step, "delivery") != "foreground"
            && let Some(result) = self.app_owned_input(&step, window_id, cancel).await?
        {
            return Ok(result);
        }
        if delivery != "background" {
            let action = text(&step, "action").to_owned();
            let before = computer_settle::before(self, &action, &step, cancel).await?;
            let mut result = self.call(step, cancel).await?;
            computer_settle::after(self, &action, before, &mut result, cancel).await?;
            return Ok(result);
        }
        let mut request = Map::new();
        request.insert("action".into(), json!("sequence_step"));
        request.insert("delivery".into(), json!("background"));
        // The helper retires refs after the outer request, so the outer carries the flag.
        if step.get("retain_refs") == Some(&json!(true)) {
            request.insert("retain_refs".into(), json!(true));
        }
        request.insert("step".into(), Value::Object(step));
        let reply = self.call(request, cancel).await?;
        Ok(computer_settle::sequence_step_result(self, window_id, &reply))
    }

    /// `assertDisplayUnchanged` (`frame-validity.ts`): a step that names a display's frame is refused when the layout the frame was
    /// cut from has changed.
    async fn assert_display_unchanged(&self, step: &Map<String, Value>, cancel: &CancellationToken) -> Result<(), ComputerError> {
        let named = step.get("frame_id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned);
        let pointed = ["x", "y", "to_x", "to_y"].iter().any(|key| step.get(*key).is_some_and(|value| !value.is_null()));
        let frame = match named {
            Some(id) => Some(id),
            None if pointed => self.frames.lookup(None, std::time::Instant::now())?.map(|frame| frame.id),
            None => None,
        };
        if frame.is_none_or(|id| self.frames.display_of(&id).is_none()) {
            return Ok(());
        }
        let desktop = self.desktop()?;
        let displays = read_displays(desktop.as_ref(), cancel).await?;
        self.frames.assert_display_unchanged(&displays)
    }

    /// `recordCursorFeedback` (`input-run-prepare.ts`): the overlay readies the agent's arrow before a pointer action. The action goes
    /// on whatever the answer is; the answer is a row of the session's failure bundle.
    async fn prepare_pointer(&self, step: &Map<String, Value>, action: &str, window_id: &str, cancel: &CancellationToken) -> Result<(), ComputerError> {
        let number = |key: &str| step.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let window = Some(window_id).filter(|id| !id.is_empty());
        let prepared = prepare_cursor(self.desktop().ok(), &self.config.session_id, window, number("x"), number("y"), cancel).await;
        if let Some(files) = &self.files {
            let mut row = Map::new();
            row.insert("action".into(), json!(action));
            row.insert("stage".into(), json!("cursor_preparation"));
            row.insert("code".into(), json!(prepared.code()));
            row.insert("ok".into(), json!(prepared.code() == "ready"));
            files.diagnose(&self.config.session_id, &row);
        }
        if cancel.is_cancelled() { Err(ComputerError::Cancelled) } else { Ok(()) }
    }

    /// `refresh` of the desktop's own windows (`host/computer/appWindows`), before a step is routed by them.
    async fn refresh_app_windows(&self, cancel: &CancellationToken) {
        if let Ok(desktop) = self.desktop() {
            APP_OWNED.refresh(desktop.as_ref(), cancel).await;
        }
    }

    /// `canUseAppOwnedInput` + `dispatchElectronInput`: a `key`, `type` or `scroll` step into a window the desktop owns goes through its
    /// renderer's own input channel, so the window is never raised. `None` sends the step to the helper: any other window or step, a
    /// desktop that does not serve the methods or does not own the window.
    async fn app_owned_input(&self, step: &Map<String, Value>, window_id: &str, cancel: &CancellationToken) -> Result<Option<Map<String, Value>>, ComputerError> {
        let Some((_, op)) = APP_OWNED.route(step, window_id) else { return Ok(None) };
        let Ok(desktop) = self.desktop() else { return Ok(None) };
        match app_input(desktop.as_ref(), &self.config.session_id, window_id, op, cancel).await {
            Ok(Value::Object(result)) => Ok(Some(result)),
            Ok(_) => Ok(None),
            Err(error) if falls_back(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// `releaseSequenceHolds`: ends the no-activate holds the helper kept across the steps. `Some(message)` when it did not
    /// confirm (`sequenceHoldReleaseError`); a cancel is the call's own.
    async fn release_holds(&self, cancel: &CancellationToken) -> Result<Option<String>, ComputerError> {
        let mut request = Map::new();
        request.insert("action".into(), json!("release_sequence_holds"));
        request.insert("session_id".into(), json!(self.config.session_id));
        match self.call(request, cancel).await {
            Ok(_) => Ok(None),
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            Err(error) => {
                let message = error_text(&error);
                Ok(Some(if lead_code(&message).is_empty() { format!("input_cleanup_unconfirmed: sequence holds were not released: {message}") } else { message }))
            }
        }
    }

    /// `captureAfterAction` for the window the sequence ended on: the capture's text as an object, and the parts that go with
    /// it. A capture that cannot be taken is `{ ok: false }` metadata, not an error; a user's input is.
    async fn observe_after(
        &self,
        command: &Map<String, Value>,
        window_id: &str,
        full: bool,
        cancel: &CancellationToken,
    ) -> Result<(Map<String, Value>, Vec<ToolPart>), ComputerError> {
        let mut capture = Map::new();
        capture.insert("action".into(), json!("capture"));
        capture.insert("window_id".into(), json!(window_id));
        if let Some(mode) = command.get("capture_after_mode") {
            capture.insert("mode".into(), mode.clone());
        }
        // `captureAfterAction`: the capture that follows an action sends what changed, unless the whole observation is owed.
        capture.insert("observation_delta".into(), json!(!full));
        match self.capture(capture, "", cancel).await {
            Ok(mut parts) => {
                let metadata = match parts.first() {
                    Some(ToolPart::Text(text)) => serde_json::from_str::<Value>(text).ok().and_then(|value| value.as_object().cloned()),
                    _ => None,
                };
                let (mut metadata, mut parts) = match metadata {
                    Some(metadata) => {
                        parts.remove(0);
                        (metadata, parts)
                    }
                    None => (object(json!({ "ok": true, "action": "capture" })), parts),
                };
                // The same pixels as the frame already delivered for this window: the text is fresh, the earlier image still
                // describes it (`image_unchanged`, `capture-after.ts`).
                let at = parts.iter().position(|part| matches!(part, ToolPart::Image { .. }));
                if let Some(at) = at
                    && let ToolPart::Image { data, .. } = &parts[at]
                    && self.frames.repeats_delivered(window_id, data)
                {
                    parts.remove(at);
                    metadata.insert("image_unchanged".into(), json!(true));
                }
                Ok((metadata, parts))
            }
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            Err(error @ ComputerError::Failed { .. }) if lead_code(&error_text(&error)) == "user_input_active" => Err(error),
            Err(error) => Ok((object(json!({ "ok": false, "window_id": window_id, "error": error_text(&error) })), Vec::new())),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerRequest;

    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use super::super::computer_backend::ComputerConfig;
    use super::super::computer_backend::ComputerShared;
    use super::super::computer_targets::testing::Scripted;
    use super::*;

    fn backend(manager: &Arc<Scripted>) -> ProcessComputerBackend {
        ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone())
    }

    /// A step the helper took, with no window change around it.
    fn quiet_step(request: &Value) -> Value {
        json!({ "step_result": { "text": "ok", "action": request["step"]["action"] }, "windows_before": [], "windows_after": [], "settle_delay_ms": 0 })
    }

    /// A helper that takes everything; `special` answers first for the requests a test scripts.
    fn helper(special: impl Fn(&Value) -> Option<Result<Value, String>> + Send + Sync + 'static) -> Arc<Scripted> {
        Scripted::new(move |request| {
            if let Some(answer) = special(request) {
                return answer;
            }
            Ok(match request["action"].as_str() {
                Some("sequence_step") => quiet_step(request),
                Some("snapshot") => json!({ "text": json!({ "ok": true, "action": "snapshot", "window_id": request["window_id"] }).to_string() }),
                _ => json!({ "text": "ok" }),
            })
        })
    }

    fn act(actions: Value) -> ComputerRequest {
        ComputerRequest { action: ComputerAction::Act, input: json!({ "window_id": "hwnd:0x2", "actions": actions }) }
    }

    fn payload(parts: &[ToolPart]) -> Value {
        let Some(ToolPart::Text(text)) = parts.first() else { panic!("a text part") };
        serde_json::from_str(text).expect("a JSON reply")
    }

    fn sent(manager: &Scripted, action: &str) -> Vec<Value> {
        manager.lines().into_iter().filter(|line| line["action"] == action).collect()
    }

    fn two_keys() -> Value {
        json!([{ "type": "key", "keys": "a" }, { "type": "key", "keys": "b" }])
    }

    /// A refused first step stops the sequence: the second is never sent and its row is skipped, holds are released, and the
    /// reply says why.
    #[tokio::test]
    async fn a_refused_step_skips_the_rest() {
        let manager = helper(|request| (request["action"] == "sequence_step").then(|| Err("background_unsupported|no route".to_owned())));
        let parts = backend(&manager).run(act(two_keys()), CancellationToken::new()).await.unwrap();
        let reply = payload(&parts);
        assert_eq!(sent(&manager, "sequence_step").len(), 1);
        assert_eq!(sent(&manager, "release_sequence_holds").len(), 1);
        assert_eq!(reply["ok"], false);
        assert_eq!((reply["stopped_reason"].clone(), reply["code"].clone()), (json!("background_unsupported"), json!("background_unsupported")));
        assert_eq!(reply["steps"][0]["status"], "failed");
        assert_eq!(reply["steps"][0]["verdict"], json!({ "decision": "escalate", "recommended": "inspect_failed_step" }));
        assert_eq!(reply["steps"][1], json!({ "index": 2, "action": "key", "status": "skipped", "reason": "background_unsupported" }));
        assert_eq!(reply["verdict"], json!({ "decision": "escalate", "recommended": "inspect_failed_step" }));
        assert_eq!(reply["capture_after"]["target_reason"], "original_target");
    }

    /// Observation-only mode turned on after the sequence was admitted refuses the next step in the host's words before it is sent:
    /// its row fails, and the steps left never reach the helper.
    #[tokio::test]
    async fn observation_only_turned_on_mid_sequence_stops_the_steps_left() {
        let observing = Arc::new(AtomicBool::new(false));
        let turned_on = observing.clone();
        let manager = helper(move |request| {
            (request["action"] == "sequence_step").then(|| {
                turned_on.store(true, Ordering::SeqCst);
                Ok(quiet_step(request))
            })
        });
        let setting = observing.clone();
        let shared = ComputerShared { observe_only: Arc::new(move || setting.load(Ordering::SeqCst)), ..ComputerShared::default() };
        let actions = json!([{ "type": "key", "keys": "a" }, { "type": "key", "keys": "b" }, { "type": "key", "keys": "c" }]);
        let parts = backend(&manager).with_shared(shared).run(act(actions), CancellationToken::new()).await.unwrap();
        let reply = payload(&parts);
        assert_eq!(sent(&manager, "sequence_step").len(), 1, "only the step admitted before the change was sent");
        assert_eq!(reply["stopped_reason"], "observation_only");
        assert_eq!(reply["steps"][1]["status"], "failed");
        assert_eq!(reply["steps"][2], json!({ "index": 3, "action": "key", "status": "skipped", "reason": "observation_only" }));
    }

    /// A dialog the step opened (owned by the target) is the successor: the sequence stops there and the capture is of the dialog.
    #[tokio::test]
    async fn a_new_owned_dialog_stops_the_sequence_and_is_captured() {
        let manager = helper(|request| {
            (request["action"] == "sequence_step").then(|| {
                let main = json!({ "id": "hwnd:0x2", "pid": 5, "title": "a.txt - Notepad" });
                let dialog = json!({ "id": "hwnd:0x9", "pid": 5, "owner_id": "hwnd:0x2", "title": "Save As", "focused": true });
                Ok(json!({ "step_result": { "text": "ok", "action": "click" }, "windows_before": [main], "windows_after": [main, dialog], "settle_delay_ms": 0 }))
            })
        });
        let actions = json!([{ "type": "click", "ref": "e1" }, { "type": "type", "text": "name" }]);
        let parts = backend(&manager).run(act(actions), CancellationToken::new()).await.unwrap();
        let reply = payload(&parts);
        assert_eq!(reply["stopped_reason"], "target_transition");
        assert_eq!(reply["steps"][0]["window_transition"]["next_target"]["id"], "hwnd:0x9");
        assert_eq!(reply["steps"][1]["status"], "skipped");
        assert_eq!(reply["verdict"], json!({ "decision": "escalate", "recommended": "switch_target" }));
        assert_eq!((reply["capture_after"]["target_reason"].clone(), reply["capture_after"]["previous_window_id"].clone()), (json!("sequence_successor"), json!("hwnd:0x2")));
        assert_eq!(reply["capture_after"]["window_id"], "hwnd:0x9");
        // observation_delta is the capture's own option (capture-finish.ts), never a field of the helper's snapshot request.
        assert!(sent(&manager, "snapshot").iter().all(|line| line["window_id"] == "hwnd:0x9"));
        assert_eq!(sent(&manager, "sequence_step").len(), 1);
    }

    /// More than 10 s of waits is refused before the helper is asked anything about the steps.
    #[tokio::test]
    async fn a_total_wait_over_ten_seconds_is_refused_before_any_write() {
        let manager = helper(|_| None);
        let actions = json!([{ "type": "key", "keys": "a" }, { "type": "wait", "duration": 5 }, { "type": "wait", "duration": 5 }, { "type": "wait", "duration": 1 }]);
        let error = backend(&manager).run(act(actions), CancellationToken::new()).await.unwrap_err();
        assert_eq!(error, refusal("sequence wait steps accept at most 10 total seconds; use verify for longer conditions"));
        let lines = manager.lines();
        assert!(lines.iter().all(|line| !matches!(line["action"].as_str(), Some("sequence_step" | "validate_background_input" | "release_sequence_holds"))), "{lines:?}");
    }

    /// A step that ends with a takeover code is the sequence's error, and the holds are released even so.
    #[tokio::test]
    async fn an_unconfirmed_cleanup_is_rethrown_and_the_holds_are_released() {
        let manager = helper(|request| (request["action"] == "sequence_step").then(|| Err("input_cleanup_unconfirmed: keys may be held".to_owned())));
        let error = backend(&manager).run(act(two_keys()), CancellationToken::new()).await.unwrap_err();
        assert_eq!(error, ComputerError::Failed { code: "input_cleanup_unconfirmed".into(), message: "input_cleanup_unconfirmed: keys may be held".into() });
        assert_eq!(sent(&manager, "release_sequence_holds").len(), 1);
    }

    /// A release the helper does not confirm outranks the steps, and the capture is never taken.
    #[tokio::test]
    async fn a_failed_hold_release_is_an_unconfirmed_cleanup() {
        let manager = helper(|request| (request["action"] == "release_sequence_holds").then(|| Err("boom".to_owned())));
        let error = backend(&manager).run(act(json!([{ "type": "key", "keys": "a" }])), CancellationToken::new()).await.unwrap_err();
        assert_eq!(
            error,
            ComputerError::Failed {
                code: "input_cleanup_unconfirmed".into(),
                message: "input_cleanup_unconfirmed: sequence holds were not released: boom; completed 1/1 steps (last completed step 1)".into()
            }
        );
        assert!(sent(&manager, "snapshot").is_empty());
    }

    /// `input_continues` is on every step but the last, `retain_refs` on the steps a later ref outlives (and on the envelope), and
    /// `sequence_continuation` on the later step that addresses a ref.
    #[tokio::test]
    async fn each_step_line_carries_its_sequence_flags() {
        let manager = helper(|_| None);
        let actions = json!([{ "type": "click", "ref": "e1" }, { "type": "type", "text": "a" }, { "type": "click", "ref": "e2" }]);
        backend(&manager).run(act(actions), CancellationToken::new()).await.unwrap();
        let lines = sent(&manager, "sequence_step");
        let flags = |line: &Value| ["input_continues", "retain_refs", "sequence_continuation"].map(|key| line["step"][key] == true);
        assert_eq!(lines.iter().map(flags).collect::<Vec<_>>(), vec![[true, true, false], [true, true, false], [false, false, true]]);
        assert_eq!(lines.iter().map(|line| line["retain_refs"] == true).collect::<Vec<_>>(), vec![true, true, false]);
        assert!(lines.iter().all(|line| line["step"]["window_id"] == "hwnd:0x2" && line["step"]["session_id"] == line["session_id"]));
    }

    /// A background route that refuses a step is found by the preflight: no step is sent, and every row says so.
    #[tokio::test]
    async fn a_preflight_refusal_sends_nothing() {
        let manager = helper(|request| (request["action"] == "validate_background_input").then(|| Err("background_unsupported|no route; no input sent".to_owned())));
        let parts = backend(&manager).run(act(two_keys()), CancellationToken::new()).await.unwrap();
        let reply = payload(&parts);
        assert_eq!((reply["ok"].clone(), reply["stopped_reason"].clone()), (json!(false), json!("preflight_refused")));
        assert_eq!(reply["steps"][1]["reason"], "preflight_refused");
        assert!(sent(&manager, "sequence_step").is_empty() && sent(&manager, "release_sequence_holds").is_empty());
    }

    /// A dialog refusal keeps its own code in the reply, and sends nothing else.
    #[tokio::test]
    async fn a_dialog_refusal_is_a_preflight_refusal() {
        let manager = helper(|request| (request["action"] == "validate_background_input").then(|| Err("focus_required|the dialog does not hold keyboard focus; no input was sent".to_owned())));
        let parts = backend(&manager).run(act(two_keys()), CancellationToken::new()).await.unwrap();
        let reply = payload(&parts);
        assert_eq!((reply["stopped_reason"].clone(), reply["code"].clone()), (json!("preflight_refused"), json!("focus_required")));
        assert!(sent(&manager, "sequence_step").is_empty());
    }

    /// `assertSequenceStep`'s refusals.
    #[test]
    fn a_step_must_fit_its_place_in_the_sequence() {
        let refused = |step: Value, index: usize| assert_step(&step, index).unwrap_err();
        assert_eq!(refused(json!({ "action": "wait", "duration": 1 }), 0), "sequence first step must be a supported input action");
        assert_eq!(refused(json!({ "action": "click" }), 1), "sequence step 2 click requires a ref from the same observation");
        assert_eq!(refused(json!({ "action": "key", "keys": "a", "delivery": "foreground" }), 1), "sequence step 2 cannot override root field(s): delivery");
        assert_eq!(refused(json!({ "action": "type", "text": "a", "x": 1 }), 1), "sequence step 2 addresses elements by ref only");
        assert_eq!(refused(json!({ "action": "wait", "duration": 6 }), 1), "sequence step 2 requires duration from 0 to 5 seconds");
        assert_eq!(refused(json!({ "action": "key", "keys": "a", "text": "a" }), 1), "sequence step 2 does not accept field(s): text");
        assert!(assert_step(&json!({ "action": "click", "x": 1, "y": 2, "frame_id": "f" }), 0).is_ok());
        assert!(assert_step(&json!({ "action": "drag", "x": 1, "y": 2, "to_x": 3, "to_y": 4, "button": "right", "frame_id": "f" }), 0).is_ok());
    }

    /// A desktop that keeps what it is asked and answers the methods an `act` meets: the readiness of the arrow, the windows it owns,
    /// the displays and the input into its own window.
    #[derive(Default)]
    struct Desk {
        asked: std::sync::Mutex<Vec<(String, Value)>>,
        displays: std::sync::Mutex<Value>,
    }

    #[async_trait::async_trait]
    impl mixdog_core_api::HostChannel for Desk {
        async fn request(&self, _: mixdog_core_api::HostCapability, method: mixdog_core_api::ids::Method, params: Value) -> Result<Value, mixdog_core_api::HostError> {
            self.asked.lock().unwrap().push((method.0.to_owned(), params));
            Ok(match method.0 {
                "host/computer/cursorPrepare" => json!({"state": "ready"}),
                "host/computer/appInput" => json!({"delivered": true, "effect": "delivered", "presses": 1}),
                "host/computer/displays" => self.displays.lock().unwrap().clone(),
                other => panic!("the act asked the desktop for {other}"),
            })
        }

        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    fn asked(desk: &Desk) -> Vec<String> {
        desk.asked.lock().unwrap().iter().map(|(method, _)| method.clone()).collect()
    }

    /// A key step into a window the desktop owns goes through the desktop's renderer, and is left out of the helper's background
    /// preflight; any other window, and a run with no desktop, keep the helper.
    #[tokio::test]
    async fn a_key_step_into_the_desktops_own_window_goes_through_its_renderer() {
        let desk = Arc::new(Desk::default());
        let own = json!({"windows": [{"windowId": "hwnd:0x777", "kind": "main", "title": "Mixdog", "bounds": {"x": 0, "y": 0, "width": 800, "height": 600}, "scaleFactor": 1.0, "displayId": "1", "focused": true}]});
        // The list is the process's, read again only when it is stale: wait out a read another test made.
        for _ in 0..30 {
            APP_OWNED.refresh_with(|| async { Ok(own.clone()) }).await;
            if APP_OWNED.window("hwnd:0x777").is_some() {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(100)).await;
        }
        let manager = helper(|_| None);
        let with_desk = backend(&manager).with_desktop(desk.clone());
        let step = object(json!({"action": "key", "keys": "^a", "delivery": "background"}));

        let routed = with_desk.app_owned_input(&step, "hwnd:0x777", &CancellationToken::new()).await.unwrap().expect("the renderer took the step");
        assert_eq!((routed["path"].clone(), routed["delivery"].clone()), (json!("electron_key_event"), json!("background")));
        let asked = desk.asked.lock().unwrap().clone();
        assert!(asked.iter().any(|(method, params)| method == "host/computer/appInput" && params["op"] == "key" && params["windowId"] == "hwnd:0x777"), "{asked:?}");

        assert!(with_desk.app_owned_input(&step, "hwnd:0x2", &CancellationToken::new()).await.unwrap().is_none(), "a native window is the helper's");
        assert!(backend(&manager).app_owned_input(&step, "hwnd:0x777", &CancellationToken::new()).await.unwrap().is_none(), "no desktop, no renderer");
        let foreground = object(json!({"action": "key", "keys": "^a", "delivery": "foreground"}));
        assert!(with_desk.app_owned_input(&foreground, "hwnd:0x777", &CancellationToken::new()).await.unwrap().is_none(), "foreground delivery is the helper's");

        let planned = plan(&[json!({"action": "key", "keys": "^a"})], "hwnd:0x777", "background", "s1").unwrap();
        assert!(with_desk.preflight(&planned, "hwnd:0x777", &CancellationToken::new()).await.unwrap().is_none());
        assert!(sent(&manager, "validate_background_input").is_empty(), "the helper was not asked about a step it never sees");
    }

    /// The overlay readies the agent's arrow before a pointer action, with the point the step names and the window it is for; the answer
    /// is a row of the session's failure bundle only when it is not "ready".
    #[tokio::test]
    async fn the_arrow_is_readied_before_a_pointer_step() {
        let desk = Arc::new(Desk::default());
        let manager = helper(|_| None);
        let data = tempfile::tempdir().unwrap();
        let config = ComputerConfig { data_dir: Some(data.path().to_path_buf()), ..ComputerConfig::new("helper", "arrow-1") };
        let with_desk = ProcessComputerBackend::new(config, manager.clone()).with_desktop(desk.clone());
        let click = object(json!({"action": "click", "ref": "e1", "delivery": "background"}));
        with_desk.send_step(click, "hwnd:0x2", "background", &CancellationToken::new()).await.unwrap();
        let sent = desk.asked.lock().unwrap().clone();
        let prepare = sent.iter().find(|(method, _)| method == "host/computer/cursorPrepare").expect("the arrow was readied");
        assert_eq!((prepare.1["sessionThreadId"].clone(), prepare.1["windowId"].clone()), (json!("arrow-1"), json!("hwnd:0x2")));
        assert!(!data.path().join("computer-failures").exists(), "a ready arrow leaves no failure row");

        // A step that is no pointer action asks nothing; a run with no overlay readies nothing and leaves the row.
        let wait = object(json!({"action": "wait", "duration": 0, "delivery": "background"}));
        let before = asked(&desk).len();
        with_desk.send_step(wait, "hwnd:0x2", "background", &CancellationToken::new()).await.unwrap();
        assert_eq!(asked(&desk).len(), before);
        let config = ComputerConfig { data_dir: Some(data.path().to_path_buf()), ..ComputerConfig::new("helper", "arrow-2") };
        let bare = ProcessComputerBackend::new(config, manager.clone());
        bare.send_step(object(json!({"action": "click", "ref": "e1", "delivery": "background"})), "hwnd:0x2", "background", &CancellationToken::new()).await.unwrap();
        assert!(data.path().join("computer-failures").is_dir(), "an arrow that was not readied is a diagnostic row");
    }

    /// A step that names a display's frame is refused when the display layout changed since the frame was taken; a step with no frame
    /// never asks for the layout.
    #[tokio::test]
    async fn a_step_on_a_display_frame_is_refused_when_the_layout_changed() {
        use super::super::computer_frames::DisplaySource;
        use super::super::computer_frames::Frame;
        let desk = Arc::new(Desk::default());
        let display = |width: u32| json!([{"index": 0, "id": "7", "primary": true, "scale_factor": 2.0, "width": width, "height": 750, "x": -3000, "y": 0}]);
        *desk.displays.lock().unwrap() = display(1600);
        let manager = helper(|_| None);
        let with_desk = backend(&manager).with_desktop(desk.clone());
        let shown = Frame {
            id: "frame-d".into(),
            window_id: None,
            related_window_ids: None,
            origin_x: -3000,
            origin_y: 0,
            physical_width: 3000,
            physical_height: 1500,
            capture_width: 1500,
            capture_height: 750,
            idle: None,
        };
        with_desk.frames.remember_display(shown, DisplaySource { display_id: "7".into(), x: -3000, y: 0, width: 3000, height: 1500, scale_factor: 2.0 });

        let click = object(json!({"action": "click", "x": 10, "y": 10, "frame_id": "frame-d", "delivery": "background"}));
        let error = with_desk.send_step(click, "hwnd:0x2", "background", &CancellationToken::new()).await.unwrap_err();
        assert_eq!(error, ComputerError::Failed { code: "stale_frame".into(), message: "stale_frame: display layout changed (frame-d)".into() });
        assert_eq!(asked(&desk), ["host/computer/displays"]);

        let before = asked(&desk).len();
        let wait = object(json!({"action": "wait", "duration": 0, "delivery": "background"}));
        with_desk.send_step(wait, "hwnd:0x2", "background", &CancellationToken::new()).await.unwrap();
        assert_eq!(asked(&desk).len(), before, "a step with no frame leaves the layout alone");
    }

    /// The capture that follows an action asks for the delta: the second `act` on the same window names the rows that did not change.
    #[tokio::test]
    async fn the_capture_after_an_action_is_a_delta_against_the_last_observation() {
        let generation = std::sync::atomic::AtomicUsize::new(0);
        let manager = Scripted::new(move |request| {
            Ok(match request["action"].as_str() {
                Some("sequence_step") => quiet_step(request),
                Some("input_idle_state") => json!({"observer_ready": true, "monitor": "m1", "sequence": 4, "target_sequence": 4}),
                Some("snapshot") => {
                    let generation = generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let rows: Vec<Value> = (0..8)
                        .map(|n| json!({"mark": n + 1, "ref": format!("s{generation}:e{n}"), "role": "Button", "name": format!("Item {n}"), "value": "", "state": "",
                                        "enabled": true, "x": 10, "y": 10 + n * 30, "width": 80, "height": 20, "actions": ["click"]}))
                        .collect();
                    let lines: Vec<String> = rows.iter().map(|row| format!("[{}] Button \"{}\" @50,50", row["ref"].as_str().unwrap(), row["name"].as_str().unwrap())).collect();
                    json!({"text": format!("Window: T [hwnd:0x2]\nElements: total=8 generation={generation}\n{}", lines.join("\n")), "window_id": "hwnd:0x2",
                           "generation": generation, "total_elements": 8, "elements": rows})
                }
                _ => json!({"text": "ok"}),
            })
        });
        let backend = backend(&manager);
        let ask = || ComputerRequest { action: ComputerAction::Act, input: json!({"window_id": "hwnd:0x2", "actions": [{"type": "key", "keys": "a"}], "observe": "ax"}) };
        let text_at = |parts: &[ToolPart], at: usize| match &parts[at] {
            ToolPart::Text(text) => text.clone(),
            other => panic!("a text part, got {other:?}"),
        };
        let first = backend.run(ask(), CancellationToken::new()).await.unwrap();
        assert!(text_at(&first, 1).contains("[s1:e0] Button \"Item 0\"") && !text_at(&first, 1).contains("Elements delta"), "{first:?}");
        let second = backend.run(ask(), CancellationToken::new()).await.unwrap();
        let shown = text_at(&second, 1);
        assert!(shown.contains("Elements delta: ") && !shown.contains("[s2:e0] Button \"Item 0\""), "the rows that did not change are named, not listed: {shown}");
    }
}
