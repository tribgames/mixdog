//! What the Node desktop host (`apps/desktop/src/main/computer`) answers on Linux that the helper does not: the capture of a screen on
//! GNOME Wayland through the Mixdog Shell extension (`host/gnome-helper.ts`, `observation/gnome-shell-capture.ts`,
//! `capture-input-observation.ts`) and the `diagnose` report (`observation/inspect.ts`, `diagnose-probes.ts`).
//!
//! A capture Node can only take through Electron's `desktopCapturer` (every other session) is not here: the core has no Electron.
//! Node fits the shell's PNG to the capture budget and re-encodes it as a JPEG with Chromium; the core has neither a resampler nor an
//! encoder, so the image it returns is the PNG the shell wrote, at the size the shell wrote it.

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::process::ProcessManager;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::computer_linux::Env;
use super::computer_linux::Readiness;
use super::computer_linux::State;
use super::computer_linux::run_short;

/// The session id of the host's window-arrivals worker: every command starts with a read of the windows through it.
pub const ARRIVALS_SESSION_ID: &str = "__computer_window_arrivals__";
/// `gnome-helper.ts` `CALL_TIMEOUT_SECONDS` plus the 5 s its process gets.
const SHOT_LIMIT: Duration = Duration::from_secs(15);
/// The words of every failed pixel read on GNOME: Node reports only the code of the `capture_source_unavailable: …` error.
const PIXEL_UNAVAILABLE_MESSAGE: &str = "exact screen capture unavailable; composited: capture_source_unavailable";

/// Where the shell extension's file is read from and removed (`GnomeShotDeps.read` / `remove`).
pub trait ShotFiles: Send + Sync {
    fn read(&self, path: &str) -> std::io::Result<Vec<u8>>;
    fn remove(&self, path: &str);
}

pub struct SystemFiles;

impl ShotFiles for SystemFiles {
    fn read(&self, path: &str) -> std::io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    fn remove(&self, path: &str) {
        let _ = std::fs::remove_file(path);
    }
}

/// A display as the host reports it (`display-reads.ts`): its bounds are the area the shell is asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    pub id: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub scale_factor: f64,
    pub primary: bool,
}

/// A JavaScript number as JSON: `1`, not `1.0`.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 { json!(value as i64) } else { json!(value) }
}

impl Display {
    fn report(&self, index: usize) -> Value {
        json!({ "index": index, "id": self.id, "primary": self.primary, "scale_factor": number(self.scale_factor), "width": self.width, "height": self.height })
    }
}

pub fn displays_report(displays: &[Display]) -> Value {
    Value::Array(displays.iter().enumerate().map(|(index, display)| display.report(index)).collect())
}

/// The size a PNG declares (its IHDR); `None` for bytes that are no PNG, which Electron reads as an empty image.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    Some((u32::from_be_bytes(bytes[16..20].try_into().ok()?), u32::from_be_bytes(bytes[20..24].try_into().ok()?)))
}

/// What the shell is asked to photograph (`GnomeShotTarget`).
pub enum Target<'a> {
    Stage,
    Area(&'a Display),
}

fn screenshot_args(target: &Target, path: &str) -> Vec<String> {
    let (kind, x, y, width, height) = match target {
        Target::Stage => ("stage", 0, 0, 0, 0),
        Target::Area(display) => ("area", display.x, display.y, display.width, display.height),
    };
    let mut args: Vec<String> = ["call", "--session", "--timeout", "10", "--dest", "org.gnome.Shell", "--object-path", "/io/mixdog/Windows", "--method", "io.mixdog.Windows.Screenshot", "--"]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
    args.extend([format!("'{kind}'"), "0".into(), x.to_string(), y.to_string(), width.to_string(), height.to_string(), format!("'{path}'")]);
    args
}

/// `gnomeShellScreenshot`: the PNG the extension wrote under `XDG_RUNTIME_DIR`, read back and removed. The error is why it could not.
pub async fn screenshot(manager: &dyn ProcessManager, env: &Env, files: &dyn ShotFiles, id: &str, target: &Target<'_>) -> Result<Vec<u8>, String> {
    let runtime = env.get("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()).ok_or("XDG_RUNTIME_DIR is not set")?;
    let path = format!("{}/mixdog-shot-{id}.png", runtime.trim_end_matches('/'));
    let args = screenshot_args(target, &path);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let outcome = match run_short(manager, env, "gdbus", &argv, SHOT_LIMIT).await {
        Some((true, _)) => files.read(&path).map_err(|error| error.to_string()),
        Some((false, _)) => Err("gdbus failed".to_owned()),
        None => Err("gdbus did not run".to_owned()),
    };
    files.remove(&path);
    outcome
}

/// The input observer as a capture reads it (`capture-input-observation.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub ready: bool,
    pub monitor: String,
    pub sequence: u64,
    pub reason: Option<String>,
    pub target_sequence: Option<u64>,
}

fn safe_integer(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|n| *n <= (1 << 53) - 1)
}

/// `createInputObservationReader`'s read of one `input_idle_state` answer; `None` when it is not a usable observation.
pub fn observation_of(result: &Map<String, Value>) -> Option<Observation> {
    let monitor = result.get("monitor").and_then(Value::as_str).filter(|monitor| !monitor.is_empty())?;
    let sequence = safe_integer(result.get("sequence"))?;
    let ready = result.get("observer_ready") == Some(&json!(true));
    let reason = if ready { None } else { result.get("observer_reason").and_then(Value::as_str).filter(|reason| !reason.is_empty()).map(str::to_owned) };
    Some(Observation { ready, monitor: monitor.to_owned(), sequence, reason, target_sequence: safe_integer(result.get("target_sequence")) })
}

const INPUT_GAP_REASON: &str = "input_gap";

/// `foregroundInputState`: whether the two reads that bracket a capture prove the foreground stayed untouched, and why not.
pub fn foreground_state(before: Option<&Observation>, after: Option<&Observation>) -> (bool, Option<&'static str>) {
    let ready = matches!((before, after), (Some(before), Some(after))
        if before.ready && after.ready && before.monitor == after.monitor && after.sequence >= before.sequence
            && after.target_sequence.unwrap_or(after.sequence) <= before.sequence);
    if ready {
        return (true, None);
    }
    let unavailable = |observation: Option<&Observation>| !observation.is_some_and(|o| o.ready) && observation.and_then(|o| o.reason.as_deref()) != Some(INPUT_GAP_REASON);
    let reason = if unavailable(before) || unavailable(after) { "input_observer_unavailable" } else { "user_input_during_capture" };
    (false, Some(reason))
}

fn capture_text(ok: bool, mode: &str, extra: Vec<(&str, Value)>, ready: bool, reason: Option<&str>) -> String {
    let mut text = Map::new();
    text.insert("ok".into(), json!(ok));
    text.insert("action".into(), json!("capture"));
    text.insert("mode".into(), json!(mode));
    for (key, value) in extra {
        text.insert(key.into(), value);
    }
    text.insert("foreground_input_ready".into(), json!(ready));
    if let Some(reason) = reason {
        text.insert("foreground_input_reason".into(), json!(reason));
    }
    Value::Object(text).to_string()
}

/// The reply text of a screen capture that produced a frame.
pub fn frame_text(mode: &str, frame: u64, size: (u32, u32), ready: bool, reason: Option<&str>) -> String {
    let mut text = Map::new();
    text.insert("ok".into(), json!(true));
    text.insert("action".into(), json!("capture"));
    text.insert("mode".into(), json!(mode));
    for (key, value) in [
        ("coordinate_space", json!("frame")),
        ("capture_source", json!("composited")),
        ("total_elements", json!(0)),
        ("returned_elements", json!(0)),
        ("accessibility_status", json!("not_requested")),
        ("pixel_status", json!("available")),
        ("foreground_input_ready", json!(ready)),
    ] {
        text.insert(key.into(), value);
    }
    if let Some(reason) = reason {
        text.insert("foreground_input_reason".into(), json!(reason));
    }
    text.insert("frame_id".into(), json!(format!("frame-{frame}")));
    text.insert("width".into(), json!(size.0));
    text.insert("height".into(), json!(size.1));
    Value::Object(text).to_string()
}

/// The reply text of a screen capture that could not read pixels.
pub fn unavailable_text(mode: &str, ready: bool, reason: Option<&str>) -> String {
    capture_text(
        false,
        mode,
        vec![
            ("coordinate_space", json!("screen")),
            ("total_elements", json!(0)),
            ("returned_elements", json!(0)),
            ("accessibility_status", json!("not_requested")),
            ("pixel_status", json!("unavailable")),
            ("pixel_unavailable", json!({ "code": "pixel_unavailable", "reason": "capture_source_unavailable", "message": PIXEL_UNAVAILABLE_MESSAGE })),
            ("escalation", json!("recapture")),
        ],
        ready,
        reason,
    )
}

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
    pub displays: &'a [Display],
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
        "displays": displays_report(diagnosis.displays),
        "issues": issues,
    })
    .to_string()
}

/// The readiness the diagnose reports: the process's one probe.
pub async fn readiness(manager: Arc<dyn ProcessManager>, env: Env) -> Arc<Readiness> {
    super::computer_linux::probe(manager, env).await
}
