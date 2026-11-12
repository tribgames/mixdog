//! What the Node desktop host (`apps/desktop/src/main/computer`) answers on Linux that the helper does not: the `diagnose` report
//! (`observation/inspect.ts`, `diagnose-probes.ts`). The capture of a screen is not here: the desktop's computer host takes and
//! encodes it (`host/computer/capture`), as does the display list (`host/computer/displays`).

use std::sync::Arc;

use mixdog_core_api::domain::process::ProcessManager;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::computer_linux::Env;
use super::computer_linux::Readiness;
use super::computer_linux::State;

/// The session id of the host's window-arrivals worker: every command starts with a read of the windows through it.
pub const ARRIVALS_SESSION_ID: &str = "__computer_window_arrivals__";

// --- diagnose ---

/// A window the helper lists (`normalizeComputerWindowRecords`): its id and whether it has the focus.
pub struct WindowRow {
    pub id: String,
    pub focused: bool,
}

/// The windows of a `list_windows` / `window_snapshot` answer; a row without an id is dropped.
pub fn window_rows(result: &Map<String, Value>) -> Vec<WindowRow> {
    let rows: Vec<&Value> = match result.get("windows") {
        Some(Value::Array(rows)) => rows.iter().collect(),
        Some(row @ Value::Object(_)) => vec![row],
        _ => Vec::new(),
    };
    rows.into_iter()
        .filter_map(|row| {
            let id = match row.get("id")? {
                Value::String(id) => id.clone(),
                Value::Number(id) => id.to_string(),
                _ => return None,
            };
            (!id.is_empty()).then(|| WindowRow { id, focused: row.get("focused") == Some(&json!(true)) })
        })
        .collect()
}

/// What the helper answered to one diagnose probe.
pub type Probe = Result<Map<String, Value>, String>;

pub struct Diagnosis<'a> {
    pub requested_window_id: &'a str,
    pub ocr_language: Option<&'a str>,
    pub windows: Option<Vec<WindowRow>>,
    /// The `accessibility_probe` answer; `None` when there was no target to ask about.
    pub accessibility: Option<Probe>,
    pub ocr: Probe,
    pub input: Probe,
    /// The desktop host's `readDisplays()` answer, as it sent it.
    pub displays: &'a Value,
    pub readiness: &'a Readiness,
    pub observe_only: bool,
}

fn accessibility_report(target: Option<&WindowRow>, probe: Option<&Probe>) -> Map<String, Value> {
    let mut report = Map::new();
    let (Some(target), Some(probe)) = (target, probe) else {
        report.insert("available".into(), Value::Null);
        report.insert("reason".into(), json!("no exact or foreground target was available"));
        return report;
    };
    let mut put = |pairs: Vec<(&str, Value)>| {
        for (key, value) in pairs {
            report.insert(key.into(), value);
        }
    };
    match probe {
        Err(message) => put(vec![
            ("available", json!(false)),
            ("provider_available", json!(false)),
            ("state", json!("error")),
            ("target_window_id", json!(target.id)),
            ("reason", json!(if message.is_empty() { "accessibility probe failed" } else { message })),
        ]),
        Ok(result) if result.get("interactive") == Some(&json!(true)) => put(vec![
            ("available", json!(true)),
            ("provider_available", json!(true)),
            ("state", json!("usable")),
            ("target_window_id", json!(target.id)),
            ("returned_elements", json!(1)),
        ]),
        Ok(_) => put(vec![
            ("available", json!(false)),
            ("provider_available", json!(true)),
            ("state", json!("empty")),
            ("target_window_id", json!(target.id)),
            ("returned_elements", json!(0)),
            ("reason", json!("target exposes no semantic accessibility elements; state capture will use OCR/pixels")),
            ("fallback", json!("ocr_or_pixels")),
        ]),
    }
    report
}

fn ocr_report(probe: &Probe) -> Map<String, Value> {
    let mut report = Map::new();
    match probe {
        Err(message) => {
            report.insert("available".into(), json!(false));
            report.insert("reason".into(), json!(if message.is_empty() { "OCR readiness probe failed" } else { message }));
        }
        Ok(result) => {
            report.insert("available".into(), json!(result.get("available") == Some(&json!(true))));
            report.insert("requested_language".into(), result.get("requested_language").cloned().unwrap_or(Value::Null));
            report.insert("active_language".into(), result.get("active_language").cloned().unwrap_or(Value::Null));
            report.insert("installed_languages".into(), match result.get("installed_languages") {
                Some(list @ Value::Array(_)) => list.clone(),
                _ => json!([]),
            });
        }
    }
    report
}

fn observer_cause(result: &Map<String, Value>) -> Option<(&'static str, &'static str)> {
    if result.get("desktop_ready") == Some(&json!(false)) {
        return Some(("secure_desktop", "foreground input is unavailable while the secure desktop (lock screen or UAC prompt) is active"));
    }
    if result.get("observer_ready") == Some(&json!(true)) {
        return None;
    }
    match result.get("observer_reason").and_then(Value::as_str)? {
        "hooks_unavailable" => Some(("hooks_unavailable", "foreground input is unavailable: the input observation hooks could not be installed")),
        "input_gap" => Some((
            "input_gap",
            "foreground input is paused: input was missed (for example typed into an administrator window) and input observation is recovering; try again after a moment without touching the keyboard or mouse",
        )),
        "monitor_unresponsive" => Some(("monitor_unresponsive", "foreground input is unavailable: the input observer is not responding")),
        _ => None,
    }
}

fn input_report(probe: &Probe) -> Map<String, Value> {
    let mut report = Map::new();
    let empty = Map::new();
    let (result, ok) = match probe {
        Ok(result) => (result, true),
        Err(_) => (&empty, false),
    };
    let flag = |key: &str| result.get(key) == Some(&json!(true));
    let ready = ok && flag("observer_ready") && flag("ready") && result.get("held") == Some(&json!(false));
    report.insert("ready".into(), json!(ready));
    report.insert("observer_ready".into(), json!(flag("observer_ready")));
    report.insert("desktop_ready".into(), json!(flag("desktop_ready")));
    if !ready && ok {
        if let Some((cause, reason)) = observer_cause(result) {
            report.insert("cause".into(), json!(cause));
            report.insert("reason".into(), json!(reason));
        }
    }
    report.insert("input_held".into(), match result.get("held") {
        Some(held @ Value::Bool(_)) => held.clone(),
        _ => Value::Null,
    });
    if let Some(idle) = result.get("idleMs").filter(|idle| idle.is_number()) {
        report.insert("idle_ms".into(), idle.clone());
    }
    if let Err(message) = probe {
        report.insert("error".into(), json!(if message.is_empty() { "input observation probe failed" } else { message }));
    }
    report
}

/// `linuxComputerPermissions`: the string fields summarize the probed capabilities.
fn permissions_report(readiness: &Readiness) -> Value {
    let caps = &readiness.capabilities;
    let input = [&caps.pointer, &caps.keyboard].into_iter().find(|cap| cap.state != State::Ready).unwrap_or(&caps.pointer);
    json!({
        "screen_capture": caps.capture.state,
        "accessibility": caps.accessibility.state,
        "input": input.state,
        "linux": readiness,
    })
}

/// `diagnoseReport` (what the model reads from `diagnose`; the timings Node's canonical text drops are not here).
pub fn diagnose_text(diagnosis: &Diagnosis) -> String {
    let target = match (&diagnosis.windows, diagnosis.requested_window_id) {
        (Some(windows), "") => windows.iter().find(|window| window.focused),
        (Some(windows), id) => windows.iter().find(|window| window.id == id),
        (None, _) => None,
    };
    let accessibility = accessibility_report(target, diagnosis.accessibility.as_ref());
    let ocr = ocr_report(&diagnosis.ocr);
    let input = input_report(&diagnosis.input);
    let input_ready = input.get("ready") == Some(&json!(true));
    let ready = diagnosis.windows.is_some() && (diagnosis.requested_window_id.is_empty() || target.is_some()) && input_ready;
    let mut issues: Vec<String> = Vec::new();
    if diagnosis.windows.is_none() {
        issues.push("window enumeration failed".into());
    }
    if !diagnosis.requested_window_id.is_empty() && target.is_none() {
        issues.push(format!("requested window is unavailable: {}", diagnosis.requested_window_id));
    }
    if !input_ready {
        issues.push(if input.get("input_held") == Some(&json!(true)) {
            "foreground input is unavailable while physical input is held".into()
        } else {
            ["error", "reason"].iter().find_map(|key| input.get(*key).and_then(Value::as_str).filter(|text| !text.is_empty())).unwrap_or("foreground input observation is unavailable").to_owned()
        });
    }
    if accessibility.get("available") == Some(&json!(false)) {
        issues.push(accessibility.get("reason").and_then(Value::as_str).filter(|reason| !reason.is_empty()).unwrap_or("accessibility unavailable").to_owned());
    }
    if diagnosis.ocr_language.is_some_and(|language| !language.is_empty()) && ocr.get("available") != Some(&json!(true)) {
        issues.push(format!("OCR language is unavailable: {}", diagnosis.ocr_language.unwrap_or_default()));
    }
    let windows = diagnosis.windows.as_deref().unwrap_or(&[]);
    let focused = windows.iter().find(|window| window.focused).map(|window| json!(window.id)).unwrap_or(Value::Null);
    let input_mode = if diagnosis.observe_only { "observation_only" } else { "enabled" };
    json!({
        "ok": diagnosis.windows.is_some(),
        "action": "diagnose",
        "platform": "linux",
        "ready": ready,
        "backend": "linux_mixdog_computer_electron",
        "windows": { "available": diagnosis.windows.is_some(), "count": windows.len(), "focused_window_id": focused },
        "capabilities": {
            "exact_window_capture": true,
            "semantic_accessibility": accessibility,
            "ocr": ocr,
            "delivery_modes": ["background", "foreground"],
            "input_mode": input_mode,
            "input_observation": input,
            "input_state": { "user_control_active": false, "cleanup_state": "ready", "reason": "" },
            "focus_cursor_restore": false,
            "focus_recovery": "immediate",
            "cursor_recovery": "restore_position_and_appearance",
            "app_owned_electron_text": true,
            "browser_content_route": "preserve_selected_session",
            "capture_probe": "run capture against an exact target; diagnostics does not expose screen pixels",
        },
        "permissions": permissions_report(diagnosis.readiness),
        "displays": diagnosis.displays,
        "issues": issues,
    })
    .to_string()
}

/// The readiness the diagnose reports: the process's one probe.
pub async fn readiness(manager: Arc<dyn ProcessManager>, env: Env) -> Arc<Readiness> {
    super::computer_linux::probe(manager, env).await
}
