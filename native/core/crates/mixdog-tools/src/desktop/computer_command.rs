//! The tool contract (`computer-bridge/action-schema.mjs`): the rules beyond the tool's JSON schema
//! (`validateComputerToolArgs`) and the helper command a tool call becomes (`toComputerHostCommand`).

use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::computer_keys;

/// The delivery of a call that names none.
pub(super) const DEFAULT_DELIVERY: &str = "background";

fn has(input: &Map<String, Value>, key: &str) -> bool {
    input.contains_key(key)
}

pub(super) fn text<'a>(input: &'a Map<String, Value>, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The rules beyond the tool's JSON schema (`validateComputerToolArgs`, minus the schema
/// itself and the per-step rules of `act.actions`, which the helper enforces on each step).
pub(super) fn validate(action: ComputerAction, input: &Map<String, Value>) -> Result<(), String> {
    let name = action.wire_name();
    for field in ["window_id", "app", "frame_id"] {
        if let Some(Value::String(value)) = input.get(field)
            && js_trim(value).is_empty()
        {
            return Err(format!("Computer Use {name} {field} must not be empty"));
        }
    }
    if matches!(action, ComputerAction::Act | ComputerAction::Window | ComputerAction::Menu | ComputerAction::Verify | ComputerAction::SavedLogin)
        && ["window_id", "app"].iter().filter(|key| has(input, key)).count() != 1
    {
        return Err(format!("Computer Use {name} requires exactly one of window_id or app"));
    }
    match action {
        ComputerAction::Capture => capture_error(input),
        ComputerAction::List => list_error(input),
        ComputerAction::Menu => menu_error(input),
        ComputerAction::Verify => verify_error(input),
        ComputerAction::Act => {
            if input.get("actions").and_then(Value::as_array).is_none_or(Vec::is_empty) {
                Err("Computer Use action \"act\" requires input field(s): actions".into())
            } else {
                Ok(())
            }
        }
        ComputerAction::Window => window_error(input),
        ComputerAction::Clipboard => clipboard_error(input),
        ComputerAction::Launch => launch_error(input),
        ComputerAction::SavedLogin => saved_login_error(input),
        ComputerAction::Diagnose | ComputerAction::WaitForUser => Ok(()),
    }
}

fn capture_error(input: &Map<String, Value>) -> Result<(), String> {
    let mode = input.get("mode").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("state");
    let targets = ["window_id", "app", "screen"].iter().filter(|key| has(input, key)).count();
    let include_ocr = input.get("include_ocr") == Some(&Value::Bool(true));
    let err = |message: &str| Err(format!("Computer Use {message}"));
    if targets > 1 {
        return err("capture accepts at most one of window_id, app, or screen");
    }
    if mode == "zoom" && (!has(input, "frame_id") || !has(input, "region")) {
        return err("capture mode=\"zoom\" requires input field(s): frame_id, region");
    }
    if mode == "zoom" && targets > 0 {
        return err("capture mode=\"zoom\" accepts frame_id and region instead of a window, app, or screen target");
    }
    if mode != "zoom" && (has(input, "frame_id") || has(input, "region")) {
        return err("capture frame_id/region requires mode=\"zoom\"");
    }
    if mode == "ax" && include_ocr {
        return err("capture include_ocr is unavailable with mode=\"ax\"");
    }
    if mode == "zoom" && has(input, "ocr_language") && !include_ocr {
        return err("capture mode=\"zoom\" reads text only with include_ocr");
    }
    if mode == "ax" && has(input, "image_output") {
        return err("capture image_output requires a mode that returns pixels");
    }
    if has(input, "screen") && mode != "vision" {
        return err("capture screen requires mode=\"vision\"");
    }
    Ok(())
}

fn list_error(input: &Map<String, Value>) -> Result<(), String> {
    let history = text(input, "kind") == "history";
    if has(input, "limit") && !history {
        return Err("Computer Use list limit applies to kind=\"history\"".into());
    }
    if has(input, "query") && history {
        return Err("Computer Use list query applies to kind=\"windows\" or kind=\"apps\"".into());
    }
    Ok(())
}

fn menu_error(input: &Map<String, Value>) -> Result<(), String> {
    let bad = input
        .get("path")
        .and_then(Value::as_array)
        .is_some_and(|path| path.iter().any(|segment| segment.as_str().is_none_or(|s| js_trim(s).is_empty())));
    if bad { Err("Computer Use menu path segments must be non-empty labels".into()) } else { Ok(()) }
}

fn verify_error(input: &Map<String, Value>) -> Result<(), String> {
    const ALLOWED: [&str; 4] = ["present", "absent", "title_contains", "window_exists"];
    for (index, predicate) in input.get("expect").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let n = index + 1;
        let Some(predicate) = predicate.as_object() else {
            return Err(format!("Computer Use verify predicate {n} must be an object"));
        };
        let extras: Vec<&str> = predicate.keys().map(String::as_str).filter(|k| !ALLOWED.contains(k)).collect();
        if !extras.is_empty() {
            return Err(format!("Computer Use verify predicate {n} does not accept field(s): {}", extras.join(", ")));
        }
        if predicate.len() != 1 {
            return Err(format!("Computer Use verify predicate {n} takes exactly one condition"));
        }
        let (key, value) = predicate.iter().next().ok_or_else(|| format!("Computer Use verify predicate {n} takes exactly one condition"))?;
        if key == "window_exists" {
            if !value.is_boolean() {
                return Err(format!("Computer Use verify predicate {n} window_exists must be a boolean"));
            }
        } else {
            let Some(value) = value.as_str() else {
                return Err(format!("Computer Use verify predicate {n} text must be a string"));
            };
            if js_trim(value).is_empty() {
                return Err(format!("Computer Use verify predicate {n} text must not be empty"));
            }
        }
    }
    Ok(())
}

fn window_error(input: &Map<String, Value>) -> Result<(), String> {
    if text(input, "operation") == "move" && !["x", "y", "width", "height"].iter().any(|key| has(input, key)) {
        return Err("Computer Use window operation=\"move\" requires x, y, width, or height".into());
    }
    Ok(())
}

fn clipboard_error(input: &Map<String, Value>) -> Result<(), String> {
    match text(input, "operation") {
        "write" if !has(input, "text") => Err("Computer Use clipboard operation=\"write\" requires input field: text".into()),
        "read" if has(input, "text") => Err("Computer Use clipboard operation=\"read\" does not accept input field: text".into()),
        _ => Ok(()),
    }
}

fn launch_error(input: &Map<String, Value>) -> Result<(), String> {
    let app = match input.get("app") {
        Some(Value::String(app)) => js_trim(app).to_string(),
        _ => String::new(),
    };
    if app.is_empty() {
        return Err("Computer Use launch app must not be empty".into());
    }
    let compile = |pattern: &str, flags: &str| JsRegex::new(pattern, flags);
    let http = compile(r"^https?://", "i")?.is_match(&app);
    if compile(r"[\r\n\0]|javascript:", "i")?.is_match(&app) || (!http && compile(r"&&|\|\|", "")?.is_match(&app)) {
        return Err("Computer Use launch app must be one executable, file, or URL without command syntax".into());
    }
    if !http
        && (compile(r#"(?:^|[\\/"'])\s*(?:cmd|powershell|pwsh|wt|wsl|bash|sh|zsh|fish|nu|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?(?:["'\s]|$)"#, "i")?
            .is_match(&app)
            || compile(r#"\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|appref-ms)(?:["']?\s*)$"#, "i")?.is_match(&app))
    {
        return Err("Computer Use launch blocks shells, script hosts, and shortcut files; use an exact non-shell executable, document, or URL".into());
    }
    Ok(())
}

fn saved_login_error(input: &Map<String, Value>) -> Result<(), String> {
    if js_trim(&text(input, "savedAccount")).is_empty() {
        return Err("Computer Use saved_login savedAccount must not be empty".into());
    }
    Ok(())
}

/// One `act.actions` entry as the host sequence step it becomes (`toHostSequenceStep`), its keys in the helper's grammar;
/// refused when the guards block it under the call's delivery.
fn host_step(step: &Value, frame_id: Option<&Value>, delivery: &str) -> Result<Value, ComputerError> {
    let Some(step) = step.as_object() else { return Ok(step.clone()) };
    let mut out = step.clone();
    let kind = out.shift_remove("type").unwrap_or(Value::Null);
    let mut action = kind.clone();
    match kind.as_str() {
        Some("click") => {
            action = match text(step, "button") {
                "right" => json!("right_click"),
                "middle" => json!("middle_click"),
                _ => json!("click"),
            };
            out.shift_remove("button");
        }
        Some("move") => action = json!("mouse_move"),
        Some("set_value") => {
            if let Some(value) = out.shift_remove("value") {
                out.insert("text".into(), value);
            }
        }
        _ => {}
    }
    out.insert("action".into(), action);
    computer_keys::normalize_step(&mut out, delivery)?;
    if let Some(frame) = frame_id
        && ["x", "y", "to_x", "to_y", "waypoints"].iter().any(|key| has(step, key))
    {
        out.insert("frame_id".into(), frame.clone());
    }
    Ok(Value::Object(out))
}

/// The helper command a tool call becomes (`toComputerHostCommand`).
pub(super) fn host_command(action: ComputerAction, input: &Map<String, Value>) -> Result<Map<String, Value>, ComputerError> {
    let mut command = input.clone();
    let set = |command: &mut Map<String, Value>, name: &str| {
        command.insert("action".into(), json!(name));
    };
    match action {
        ComputerAction::List => {
            let name = match text(input, "kind") {
                "apps" => "list_apps",
                "history" => "list_history",
                _ => "list_windows",
            };
            set(&mut command, name);
            command.shift_remove("kind");
        }
        ComputerAction::Capture => {
            if text(input, "mode") == "zoom" {
                set(&mut command, "zoom");
                command.shift_remove("mode");
            } else {
                set(&mut command, "capture");
            }
        }
        ComputerAction::Menu => set(&mut command, "invoke_menu"),
        ComputerAction::Act => {
            set(&mut command, "sequence");
            let delivery = input.get("delivery").cloned().unwrap_or_else(|| json!(DEFAULT_DELIVERY));
            command.insert("delivery".into(), delivery);
            let frame = input.get("frame_id").filter(|frame| frame.as_str().is_none_or(|f| !f.is_empty()));
            let step_delivery = input.get("delivery").and_then(Value::as_str).unwrap_or(DEFAULT_DELIVERY);
            let steps =
                input.get("actions").and_then(Value::as_array).into_iter().flatten().map(|step| host_step(step, frame, step_delivery)).collect::<Result<Vec<Value>, _>>()?;
            command.insert("steps".into(), Value::Array(steps));
            if let Some(mode) = input.get("observe").filter(|m| m.as_str().is_none_or(|m| !m.is_empty())) {
                command.insert("capture_after_mode".into(), mode.clone());
            }
            for key in ["observe", "actions", "frame_id"] {
                command.shift_remove(key);
            }
        }
        ComputerAction::Window => {
            let operation = text(input, "operation");
            let name = match operation {
                "focus" => "focus_window",
                "move" => "move_window",
                "close" => "close_window",
                "terminate" => "terminate_process",
                _ => {
                    command.insert("state".into(), json!(operation));
                    "window_state"
                }
            };
            set(&mut command, name);
            command.shift_remove("operation");
        }
        ComputerAction::Clipboard => {
            set(&mut command, if text(input, "operation") == "write" { "clipboard_write" } else { "clipboard_read" });
            command.shift_remove("operation");
        }
        ComputerAction::SavedLogin => {
            set(&mut command, "fill_saved_login");
            if let Some(account) = command.shift_remove("savedAccount") {
                command.insert("saved_account".into(), account);
            }
            command.insert("delivery".into(), json!("foreground"));
        }
        other => set(&mut command, other.wire_name()),
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn tool_calls_become_the_host_commands_node_sends() {
        let list = host_command(ComputerAction::List, &input(json!({"kind":"apps","query":"x"}))).unwrap();
        assert_eq!(Value::Object(list), json!({"action":"list_apps","query":"x"}));
        let window = host_command(ComputerAction::Window, &input(json!({"operation":"minimize","window_id":"w"}))).unwrap();
        assert_eq!(Value::Object(window), json!({"action":"window_state","state":"minimize","window_id":"w"}));
        let act = host_command(
            ComputerAction::Act,
            &input(json!({"window_id":"w","observe":"ax","frame_id":"f","actions":[
                {"type":"click","button":"right","x":1,"y":2},
                {"type":"set_value","value":"v","ref":"e1"},
                {"type":"move","x":3,"y":4}]})),
        )
        .unwrap();
        assert_eq!(
            Value::Object(act),
            json!({"action":"sequence","window_id":"w","delivery":"background","capture_after_mode":"ax","steps":[
                {"action":"right_click","x":1,"y":2,"frame_id":"f"},
                {"action":"set_value","text":"v","ref":"e1"},
                {"action":"mouse_move","x":3,"y":4,"frame_id":"f"}]})
        );
        let login = host_command(ComputerAction::SavedLogin, &input(json!({"savedAccount":"a","app":"b"}))).unwrap();
        assert_eq!(Value::Object(login), json!({"action":"fill_saved_login","saved_account":"a","app":"b","delivery":"foreground"}));
    }

    #[test]
    fn cross_field_rules_match_the_node_messages() {
        let err = |action, value: Value| validate(action, &input(value)).unwrap_err();
        assert_eq!(err(ComputerAction::Window, json!({"operation":"focus"})), "Computer Use window requires exactly one of window_id or app");
        assert_eq!(
            err(ComputerAction::Capture, json!({"mode":"zoom"})),
            "Computer Use capture mode=\"zoom\" requires input field(s): frame_id, region"
        );
        assert_eq!(err(ComputerAction::List, json!({"limit":3})), "Computer Use list limit applies to kind=\"history\"");
        assert!(err(ComputerAction::Launch, json!({"app":"powershell.exe"})).starts_with("Computer Use launch blocks shells"));
        assert!(err(ComputerAction::Launch, json!({"app":"a && b"})).ends_with("without command syntax"));
        assert!(validate(ComputerAction::Launch, &input(json!({"app":"https://example.com/a&&b"}))).is_ok());
        assert!(validate(ComputerAction::Capture, &input(json!({"window_id":"w"}))).is_ok());
    }
}
