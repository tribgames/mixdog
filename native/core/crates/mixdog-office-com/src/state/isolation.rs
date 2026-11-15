//! `Enforce-BackgroundIsolation` and `Session-Response` (`office-com-session-host.ps1`).
//!
//! A background session's windows, and those of the chart Excel its slides started, are hidden after every action; the
//! foreground the user had is given back when an owned window took it; and an owned window that stays visible, or the
//! foreground left in an owned process, is an error that fails the action.

use super::Mode;
use super::SessionState;
use super::ownership_text;
use crate::office::Env;
use crate::platform::Platform;
use crate::ps::ObjectKind;
use crate::ps::Value;

/// How many times the owned windows are hidden and counted again.
const PASSES: u32 = 20;
/// The pause after hiding, and after giving the foreground back.
const SETTLE_MS: u32 = 25;

/// `Window-ProcessId`: the process of a window, 0 for no window.
pub fn window_process_id(platform: &dyn Platform, hwnd: i64) -> i32 {
    if hwnd == 0 { 0 } else { platform.process_id_for_window(hwnd) }
}

/// `Background-OwnedProcessIds`: the session's application and the chart Excel applications it tracks.
fn owned_process_ids(state: &SessionState) -> Vec<i32> {
    let mut ids: Vec<i32> = Vec::new();
    if state.app_pid > 0 {
        ids.push(state.app_pid);
    }
    if state.format == "pptx" {
        for &id in state.chart_excel.process_ids() {
            if id > 0 && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

fn truth(value: bool) -> &'static str {
    if value { "True" } else { "False" }
}

/// `Enforce-BackgroundIsolation`: `None` for a session that is not a background one.
pub fn enforce_background_isolation(state: &mut SessionState, env: &Env<'_>) -> Result<Option<Value>, String> {
    if state.mode != Mode::Background {
        return Ok(None);
    }
    let platform = env.platform;
    let process_ids = owned_process_ids(state);
    let foreground_before = state.foreground_before_action;
    let mut observed: Vec<Value> = Vec::new();
    let mut hidden: i32 = 0;
    let mut visible: i32 = 0;
    for attempt in 0..PASSES {
        visible = 0;
        for &process_id in &process_ids {
            if attempt == 0 {
                observed.extend(platform.visible_window_descriptions_for_process(process_id).into_iter().map(Value::String));
            }
            visible += platform.visible_window_count_for_process(process_id);
        }
        if visible == 0 {
            break;
        }
        for &process_id in &process_ids {
            hidden += platform.hide_visible_windows_for_process(process_id);
        }
        platform.sleep(SETTLE_MS);
    }
    let foreground_current = platform.foreground_window();
    let owned_foreground = process_ids.contains(&window_process_id(platform, foreground_current));
    let mut focus_restored = false;
    if owned_foreground && foreground_before != 0 && foreground_current != foreground_before {
        focus_restored = platform.restore_foreground_window(foreground_before);
        platform.sleep(SETTLE_MS);
    }
    let foreground_after = platform.foreground_window();
    let owned_foreground_remaining = process_ids.contains(&window_process_id(platform, foreground_after));
    state.background_isolation_checks += 1;
    state.background_hidden_windows += hidden;
    if focus_restored {
        state.background_focus_restorations += 1;
    }
    if visible > 0 || owned_foreground_remaining {
        return Err(format!(
            "Background Office isolation failed: {visible} owned window(s) remain visible and ownedForeground={}.",
            truth(owned_foreground_remaining)
        ));
    }
    Ok(Some(Value::object(
        ObjectKind::Ordered,
        vec![
            ("strict", Value::Bool(true)),
            ("isolatedProcess", Value::Bool(state.isolated_process)),
            ("checks", Value::Int(state.background_isolation_checks)),
            ("hiddenWindows", Value::Int(state.background_hidden_windows)),
            ("focusRestorations", Value::Int(state.background_focus_restorations)),
            ("observedVisibleWindows", Value::Array(observed)),
            ("foregroundBefore", Value::Long(foreground_before)),
            ("foregroundAfter", Value::Long(foreground_after)),
            ("visibleOwnedWindows", Value::Int(visible)),
            ("ownedForeground", Value::Bool(owned_foreground_remaining)),
        ],
    )))
}

/// `Session-Response`: the common fields of an answer, the isolation report of a background session, then the action's
/// own fields in their order (a field the action names again replaces the one here, in place).
pub fn session_response(state: &mut SessionState, env: &Env<'_>, fields: &Value) -> Result<Value, String> {
    let isolation = enforce_background_isolation(state, env)?;
    let mut result = Value::object(
        ObjectKind::Ordered,
        vec![
            ("ok", Value::Bool(true)),
            ("session", Value::string(&state.id)),
            ("mode", Value::string(state.mode.as_str())),
            ("backend", Value::string(crate::session::BACKEND)),
            ("ownership", Value::string(ownership_text(state.ownership))),
            ("ownsApplication", Value::Bool(state.owns_application)),
            ("appPid", Value::Int(state.app_pid)),
            ("windowHwnd", Value::Long(state.window_hwnd)),
            ("documentId", Value::string(&state.document_id)),
        ],
    );
    if let Value::Object(object) = &mut result {
        if let Some(report) = isolation {
            object.set("backgroundIsolation", report);
        }
        if let Value::Object(extra) = fields {
            for (key, value) in &extra.entries {
                object.set(key, value.clone());
            }
        }
    }
    Ok(result)
}
