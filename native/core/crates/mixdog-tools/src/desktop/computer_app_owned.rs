//! Mixdog's own windows (`host/computer/appWindows`) and the input the desktop delivers into them (`host/computer/appInput`):
//! what `canUseAppOwnedInput` + `dispatchElectronInput` / `dispatchElectronText` did in the Node host
//! (`host/input-dispatch.ts`, `host/input-dispatch-electron-*.ts`). A window the desktop names takes `key`, `type` and `scroll`
//! steps through its renderer's own input channel, so it is never raised and the user's foreground window stays
//! where it is; any other window, and a desktop that does not serve the two methods, keep the helper path.
//!
//! The list is read together with the internal windows (`computer_internal_windows::filter`) and kept for a short while, the
//! desktop's windows belonging to its process, not to one session.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::ids::Method;
use mixdog_js::utf16_len;
use mixdog_rt::time::Instant;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_command::text;
use super::computer_internal_windows::normalized;

pub(super) const WINDOWS_METHOD: &str = "host/computer/appWindows";
const INPUT_METHOD: &str = "host/computer/appInput";
/// How long a read of the list is trusted: a window is opened or closed in the moments after an action.
const TTL: Duration = Duration::from_millis(500);
/// How long a desktop that answered method-not-found is not asked again: one replaced by a newer build is found within it.
const NOT_SERVED_TTL: Duration = Duration::from_secs(30);
/// What a host that registered no handler answers (`host-connection.ts`: `<method> is not served by this desktop`, -32601).
const NOT_SERVED_SUFFIX: &str = "is not served by this desktop";
/// What an `appInput` answer of -32602 (the window is not app-owned) is as an error.
const NOT_OWNED: &str = "app_input_not_owned: the window is not owned by the desktop";
/// `WHEEL_NOTCH`: CSS pixels one wheel notch scrolls, the step Chromium itself uses.
const WHEEL_NOTCH: f64 = 100.0;

/// A window's physical bounds on its display.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code, reason = "the answer is parsed whole; routing reads the origin")]
pub(super) struct Bounds {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

/// One entry of the `host/computer/appWindows` answer.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code, reason = "the answer is parsed whole; routing reads the origin")]
pub(super) struct AppWindow {
    pub(super) window_id: String,
    /// `main`, `browser_guest` or `aux`.
    pub(super) kind: String,
    pub(super) title: String,
    pub(super) bounds: Bounds,
    pub(super) scale_factor: f64,
    pub(super) display_id: String,
    pub(super) focused: bool,
}

impl AppWindow {
    fn from_json(value: &Value) -> Option<AppWindow> {
        let fields = value.as_object()?;
        let window_id = fields.get("windowId")?.as_str().filter(|id| !normalized(id).is_empty())?.to_string();
        let number = |object: &Map<String, Value>, key: &str| object.get(key).and_then(Value::as_f64).filter(|n| n.is_finite());
        let bounds = fields.get("bounds")?.as_object()?;
        let string = |key: &str| fields.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        Some(AppWindow {
            window_id,
            kind: string("kind"),
            title: string("title"),
            bounds: Bounds { x: number(bounds, "x")?, y: number(bounds, "y")?, width: number(bounds, "width")?, height: number(bounds, "height")? },
            scale_factor: number(fields, "scaleFactor").filter(|scale| *scale > 0.0).unwrap_or(1.0),
            display_id: string("displayId"),
            focused: fields.get("focused").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// What the last read of the list found.
enum Read {
    Never,
    Windows(Instant, HashMap<String, AppWindow>),
    /// The desktop answered method-not-found: an older build, whose windows go through the helper as they always did.
    NotServed(Instant),
}

/// The desktop's own windows, read by `host/computer/appWindows`.
pub(super) struct AppOwnedWindows {
    read: Mutex<Read>,
}

/// The one list of the process: the windows belong to the desktop, not to a session.
pub(super) static APP_OWNED: AppOwnedWindows = AppOwnedWindows::new();

impl AppOwnedWindows {
    pub(super) const fn new() -> Self {
        Self { read: Mutex::new(Read::Never) }
    }

    fn slot(&self) -> MutexGuard<'_, Read> {
        self.read.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads the list again unless it was read within `TTL`, with the answer of `ask` (a `host/computer/appWindows` request). A
    /// failed read names no window, so the helper path serves every window; a desktop that does not serve the method is not
    /// asked again for a while.
    pub(super) async fn refresh_with<F, Fut>(&self, ask: F)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, ComputerError>>,
    {
        let fresh = match &*self.slot() {
            Read::Windows(read, _) => read.elapsed() < TTL,
            Read::NotServed(read) => read.elapsed() < NOT_SERVED_TTL,
            Read::Never => false,
        };
        if fresh {
            return;
        }
        let read = match ask().await {
            Ok(answer) => match answer.get("windows").and_then(Value::as_array) {
                Some(windows) => Read::Windows(
                    Instant::now(),
                    windows.iter().filter_map(AppWindow::from_json).map(|window| (normalized(&window.window_id), window)).collect(),
                ),
                None => Read::Never,
            },
            Err(error) if not_served(&error) => Read::NotServed(Instant::now()),
            Err(_) => Read::Never,
        };
        *self.slot() = read;
    }

    /// `refresh_with` over a request to `desktop`.
    pub(super) async fn refresh(&self, desktop: &dyn HostChannel, cancel: &CancellationToken) {
        self.refresh_with(|| request(desktop, WINDOWS_METHOD, json!({}), cancel)).await;
    }

    pub(super) fn window(&self, window_id: &str) -> Option<AppWindow> {
        match &*self.slot() {
            Read::Windows(_, windows) => windows.get(&normalized(window_id)).cloned(),
            _ => None,
        }
    }

    /// `createInputPreflight`'s refusal of a key the renderer's input table cannot map, found before any step of a sequence is sent:
    /// `Some` for a `key` step the desktop would deliver into the window (`step`'s own `window_id`, else `window_id`) whose keys name
    /// a key with no mapping. The step would refuse the same way at its turn, after the steps before it had run.
    pub(super) fn unmapped_key(&self, step: &Map<String, Value>, window_id: &str) -> Option<ComputerError> {
        let target = Some(text(step, "window_id")).filter(|id| !id.is_empty()).unwrap_or(window_id);
        let Some((_, AppInputOp::Key { keys })) = self.route(step, target) else { return None };
        unmapped_key_name(&keys).map(|name| failed(format!("background_unsupported: key {{{name}}} has no Electron input mapping; no input was sent")))
    }

    /// A window the desktop says it does not own is forgotten until the next read.
    fn forget(&self, window_id: &str) {
        if let Read::Windows(_, windows) = &mut *self.slot() {
            windows.remove(&normalized(window_id));
        }
    }

    /// The window and the input a step of an `act` is delivered as, when the window is the desktop's and the step is one its
    /// renderer takes (`canUseAppOwnedInput`: not foreground delivery, no ref); `None` sends the step to the helper.
    pub(super) fn route(&self, step: &Map<String, Value>, window_id: &str) -> Option<(AppWindow, AppInputOp)> {
        let window = self.window(window_id)?;
        let op = AppInputOp::from_step(step, &window)?;
        Some((window, op))
    }
}

/// Whether an error is the desktop's method-not-found, or its answer that the window is not its own: either way the step goes
/// to the helper, as it did before the desktop served the methods.
pub(super) fn falls_back(error: &ComputerError) -> bool {
    not_served(error) || matches!(error, ComputerError::Failed { message, .. } if message == NOT_OWNED)
}

fn not_served(error: &ComputerError) -> bool {
    matches!(error, ComputerError::Failed { message, .. } if message.ends_with(NOT_SERVED_SUFFIX))
}

/// One `host/computer/*` request. The host's refusal is its own text; -32601 is the text its router writes, and -32602 from
/// `appInput` is the window not being the desktop's.
async fn request(desktop: &dyn HostChannel, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, ComputerError> {
    match desktop.request_scoped(HostCapability::Computer, Method(method), params, cancel).await {
        Ok(value) => Ok(value),
        Err(_) if cancel.is_cancelled() => Err(ComputerError::Cancelled),
        Err(HostError::Rpc { code: -32602, .. }) if method == INPUT_METHOD => Err(failed(NOT_OWNED.into())),
        Err(HostError::Rpc { code: -32601, .. }) => Err(failed(format!("{method} {NOT_SERVED_SUFFIX}"))),
        Err(HostError::Rpc { message, .. }) => Err(failed(message)),
        Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if &*detail == "timedOut" => Err(failed("Error: computer bridge timed out".into())),
        Err(HostError::Core(_)) => Err(failed("Error: computer bridge is not available".into())),
    }
}

fn failed(message: String) -> ComputerError {
    ComputerError::Failed { code: "computer_failed".into(), message }
}

/// `NAMED_KEYS` of `input-electron-keys.ts`: the named keys of the helper's grammar the renderer's key table knows.
const MAPPED_KEY_NAMES: [&str; 16] =
    ["BACKSPACE", "TAB", "ENTER", "ESC", "SPACE", "PGUP", "PGDN", "HOME", "END", "LEFT", "UP", "RIGHT", "DOWN", "DELETE", "PLUS", "MINUS"];

/// `namedKey` over every `{NAME [count]}` of a key sequence in the helper's grammar (`electronKeyPresses`): the first name with no
/// mapping, as the sequence wrote it. A single character is the literal key, whatever the grammar says of it.
fn unmapped_key_name(grammar: &str) -> Option<String> {
    let chars: Vec<char> = grammar.chars().collect();
    if chars.len() == 1 {
        return None;
    }
    let mut index = 0;
    while index < chars.len() {
        while chars.get(index).is_some_and(|c| matches!(c, '^' | '%' | '+' | '#')) {
            index += 1;
        }
        if chars.get(index) == Some(&'{') {
            let end = chars[index..].iter().position(|c| *c == '}').map_or(chars.len(), |offset| index + offset);
            let inside: String = chars[index + 1..end].iter().collect();
            // `^(\S+)(?:\s+(\d+))?$`: the name, and a repeat count after whitespace.
            let name = match inside.split_once(char::is_whitespace) {
                Some((name, count)) if !name.is_empty() && !count.trim_start().is_empty() && count.trim_start().chars().all(|c| c.is_ascii_digit()) => name,
                _ => inside.as_str(),
            };
            let upper = name.to_uppercase();
            let function = upper.strip_prefix('F').and_then(|number| number.parse::<u8>().ok()).is_some_and(|number| (1..=24).contains(&number) && !upper.starts_with("F0") && !upper.contains('+'));
            if !MAPPED_KEY_NAMES.contains(&upper.as_str()) && !function {
                return Some(name.to_owned());
            }
            index = end + 1;
        } else {
            index += 1;
        }
    }
    None
}

/// One input into an app-owned window; its points are physical pixels relative to the window's bounds.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum AppInputOp {
    /// The keys in the helper's grammar, as `normalizeComputerKeySequence` wrote them.
    Key { keys: String },
    Type { text: String, point: Option<(f64, f64)> },
    /// Signed wheel deltas in CSS pixels (`WHEEL_NOTCH` a notch), at a point or the middle of the window, with the step's
    /// `modifiers` text (`ctrl+shift`) held.
    Wheel { point: Option<(f64, f64)>, dx: f64, dy: f64, modifiers: Option<String> },
}

impl AppInputOp {
    /// The input a step is, with its screen-physical points (`computer_frames::map_step`) moved to the window's origin; `None`
    /// for a step the renderer's channel does not take (`canUseAppOwnedInput`: only `type`, `key` and `scroll`; clicks and pointer
    /// moves stay on the helper path).
    fn from_step(step: &Map<String, Value>, window: &AppWindow) -> Option<AppInputOp> {
        if text(step, "delivery") == "foreground" || step.get("ref").is_some_and(|reference| !reference.is_null() && reference.as_str() != Some("")) {
            return None;
        }
        let point = || {
            let (x, y) = (step.get("x")?.as_f64()?, step.get("y")?.as_f64()?);
            Some((x - window.bounds.x, y - window.bounds.y))
        };
        match text(step, "action") {
            "key" => Some(AppInputOp::Key { keys: step.get("keys")?.as_str()?.to_string() }),
            "type" => Some(AppInputOp::Type { text: step.get("text").and_then(Value::as_str).unwrap_or_default().to_string(), point: point() }),
            "scroll" => {
                // `wheelDeltas`: 1..100 notches of `amount ?? dy ?? 3`, up and left negative, a step without a direction signed by `dy`.
                let number = |key: &str| step.get(key).and_then(Value::as_f64);
                let magnitude = number("amount").or_else(|| number("dy")).unwrap_or(3.0).abs().clamp(1.0, 100.0);
                let direction = text(step, "direction");
                let negative = if direction.is_empty() { number("dy").unwrap_or(0.0) < 0.0 } else { matches!(direction, "up" | "left") };
                let delta = if negative { -magnitude } else { magnitude } * WHEEL_NOTCH;
                let horizontal = matches!(direction, "left" | "right");
                let modifiers = Some(text(step, "modifiers")).filter(|modifiers| !modifiers.is_empty()).map(str::to_string);
                Some(AppInputOp::Wheel { point: point(), dx: if horizontal { delta } else { 0.0 }, dy: if horizontal { 0.0 } else { delta }, modifiers })
            }
            _ => None,
        }
    }

    fn params(&self, session: &str, window_id: &str) -> Value {
        let mut params = Map::new();
        params.insert("sessionThreadId".into(), json!(session));
        params.insert("windowId".into(), json!(window_id));
        let mut set = |entries: Vec<(&str, Value)>| {
            for (key, value) in entries {
                params.insert(key.into(), value);
            }
        };
        match self {
            AppInputOp::Key { keys } => set(vec![("op", json!("key")), ("keys", json!(keys))]),
            AppInputOp::Type { text, point } => {
                set(vec![("op", json!("type")), ("text", json!(text))]);
                if let Some((x, y)) = point {
                    set(vec![("x", json!(x)), ("y", json!(y))]);
                }
            }
            AppInputOp::Wheel { point, dx, dy, modifiers } => {
                set(vec![("op", json!("wheel")), ("dx", json!(dx)), ("dy", json!(dy))]);
                if let Some((x, y)) = point {
                    set(vec![("x", json!(x)), ("y", json!(y))]);
                }
                if let Some(modifiers) = modifiers {
                    set(vec![("modifiers", json!(modifiers))]);
                }
            }
        }
        Value::Object(params)
    }

    fn action(&self) -> &'static str {
        match self {
            AppInputOp::Key { .. } => "key",
            AppInputOp::Type { .. } => "type",
            AppInputOp::Wheel { .. } => "scroll",
        }
    }

    /// What a delivered input says it did (`delivered()` of `input-dispatch-electron-input.ts`, the text of `dispatchElectronText`);
    /// `presses` is the count of key presses the desktop sent for a key step.
    fn delivered_text(&self, presses: Option<u64>) -> String {
        match self {
            AppInputOp::Key { .. } => match presses {
                Some(count) => format!("sent {count} key press(es) to app-owned Electron renderer"),
                None => "sent key press(es) to app-owned Electron renderer".into(),
            },
            AppInputOp::Type { text, .. } => format!("typed {} literal characters into app-owned Electron renderer", utf16_len(text)),
            AppInputOp::Wheel { .. } => "sent a wheel event to app-owned Electron renderer".into(),
        }
    }

    fn path(&self) -> &'static str {
        match self {
            AppInputOp::Key { .. } => "electron_key_event",
            AppInputOp::Type { point: Some(_), .. } => "electron_point_focus_insert_text",
            AppInputOp::Type { point: None, .. } => "electron_insert_text",
            AppInputOp::Wheel { .. } => "electron_wheel_event",
        }
    }
}

/// `host/computer/appInput`: one input into the app-owned window, answered as the result of an `act` step. A desktop that does
/// not serve the method, or that does not own the window, is an error `falls_back` names: the step then goes to the helper.
pub(super) async fn app_input(desktop: &dyn HostChannel, session: &str, window_id: &str, op: AppInputOp, cancel: &CancellationToken) -> Result<Value, ComputerError> {
    let answer = match request(desktop, INPUT_METHOD, op.params(session, window_id), cancel).await {
        Ok(answer) => answer,
        Err(error) => {
            if falls_back(&error) && !not_served(&error) {
                APP_OWNED.forget(window_id);
            }
            return Err(error);
        }
    };
    let effect = answer.get("effect").and_then(Value::as_str).unwrap_or_default();
    let mut result = Map::new();
    result.insert("action".into(), json!(op.action()));
    result.insert("path".into(), json!(op.path()));
    result.insert("effect".into(), json!("unverifiable"));
    result.insert("verified".into(), json!(false));
    result.insert("goal_verified".into(), json!(false));
    result.insert("delivery".into(), json!("background"));
    result.insert("window_id".into(), json!(window_id));
    if let Some(evidence) = answer.get("evidence").filter(|evidence| evidence.is_object()) {
        result.insert("evidence".into(), evidence.clone());
    }
    if let Some(cursor) = answer.get("cursor").filter(|cursor| cursor.is_object()) {
        result.insert("cursor".into(), cursor.clone());
    }
    match effect {
        "delivered" if answer.get("delivered").and_then(Value::as_bool) != Some(false) => {
            result.insert("text".into(), json!(op.delivered_text(answer.get("presses").and_then(Value::as_u64))));
            result.insert("delivery_accepted".into(), json!(true));
            // The renderer's process (`webContents.getOSProcessId()`).
            if let Some(pid) = answer.get("pid").filter(|pid| pid.is_u64() || pid.is_i64()) {
                result.insert("pid".into(), pid.clone());
            }
        }
        // `preparatoryClickFailure`: the click that focuses the point before the text was not confirmed, so nothing was typed. The
        // click's own code and words ride along; a click that may have landed leaves `delivery_accepted` unknown (null).
        "click_unconfirmed" => {
            let said = |key: &str| answer.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
            let may_have_executed = answer.get("inputMayHaveExecuted").and_then(Value::as_bool) == Some(true) || answer.get("deliveryAccepted").and_then(Value::as_bool) != Some(false);
            result.insert("action".into(), json!("type"));
            result.insert("code".into(), json!(said("code").unwrap_or("typing_target_unconfirmed")));
            result.insert("text".into(), json!(said("text").unwrap_or("The preparatory click was not confirmed; no text was sent.")));
            result.insert("delivery_accepted".into(), if may_have_executed { Value::Null } else { json!(false) });
            result.insert("input_may_have_executed".into(), json!(may_have_executed));
        }
        // `typingTargetUnconfirmed`: nothing was typed; a click that preceded it may have landed.
        "not_editable" => {
            result.insert("code".into(), json!("typing_target_unconfirmed"));
            result.insert("text".into(), json!("The requested editable target was not confirmed; no text was sent. Observe fresh state before continuing."));
            result.insert("delivery_accepted".into(), json!(false));
            result.insert("path".into(), json!("electron_typing_target_check"));
            if matches!(&op, AppInputOp::Type { point: Some(_), .. }) {
                result.insert("input_may_have_executed".into(), json!(true));
            }
        }
        "window_gone" => return Err(failed("computer_window_gone: the window closed before the input was delivered; no input was sent".into())),
        // A key the renderer's input table has no mapping for (`electronKeyPresses`) or a zoom it cannot read: refused before any
        // input, in the code and words the helper's own grammar refusal has, so the step's row and the sequence's reason read alike.
        "refused" if answer.get("code").and_then(Value::as_str) == Some("background_unsupported") => {
            let said = answer.get("text").and_then(Value::as_str).filter(|text| !text.is_empty());
            return Err(failed(said.unwrap_or("background_unsupported: the window takes no background input of this kind; no input was sent").to_owned()));
        }
        _ => return Err(failed("input_refused: the desktop refused input to this window; no input was sent".into())),
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use async_trait::async_trait;
    use mixdog_rt::time::sleep;

    use super::*;

    type Input = Result<Value, (i64, &'static str)>;

    /// A desktop that answers `appWindows` with one window and `appInput` with `input`, and records what it was asked.
    struct Desk {
        input: Input,
        asked: Mutex<Vec<(&'static str, Value)>>,
        reads: AtomicUsize,
    }

    impl Desk {
        fn new(input: Input) -> Arc<Self> {
            Arc::new(Self { input, asked: Mutex::new(Vec::new()), reads: AtomicUsize::new(0) })
        }
    }

    #[async_trait]
    impl HostChannel for Desk {
        async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            assert_eq!(capability, HostCapability::Computer);
            self.asked.lock().unwrap().push((method.0, params));
            match method.0 {
                WINDOWS_METHOD => {
                    self.reads.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({ "windows": [
                        { "windowId": "hwnd:0xAB", "kind": "main", "title": "Mixdog", "bounds": { "x": 100, "y": 50, "width": 800, "height": 600 }, "scaleFactor": 1.5, "displayId": "0", "focused": true },
                        { "windowId": "", "kind": "aux", "title": "", "bounds": { "x": 0, "y": 0, "width": 1, "height": 1 }, "scaleFactor": 1, "displayId": "0", "focused": false },
                    ] }))
                }
                _ => self.input.clone().map_err(|(code, message)| HostError::Rpc { code, message: message.into(), data: None }),
            }
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    fn delivered() -> Input {
        Ok(json!({ "delivered": true, "effect": "delivered" }))
    }

    async fn known(desk: &Desk) -> AppOwnedWindows {
        let windows = AppOwnedWindows::new();
        windows.refresh(desk, &CancellationToken::new()).await;
        windows
    }

    #[tokio::test(start_paused = true)]
    async fn an_app_owned_window_routes_to_app_input_and_a_native_one_to_the_helper() {
        let desk = Desk::new(delivered());
        let windows = known(&desk).await;
        let step = object(json!({ "action": "type", "text": "héllo", "delivery": "background" }));
        assert!(windows.window("HWND:0xab").is_some());
        let (window, op) = windows.route(&step, "hwnd:0xab").expect("routed");
        assert_eq!(window.title, "Mixdog");
        assert_eq!(op, AppInputOp::Type { text: "héllo".into(), point: None });
        assert!(windows.route(&step, "hwnd:0x10").is_none());
        // Foreground delivery and a ref step are the helper's, as `canUseAppOwnedInput` left them.
        assert!(windows.route(&object(json!({ "action": "key", "keys": "^A", "delivery": "foreground" })), "hwnd:0xab").is_none());
        assert!(windows.route(&object(json!({ "action": "type", "text": "a", "ref": "e1" })), "hwnd:0xab").is_none());
        let reply = app_input(&*desk, "thread-1", "hwnd:0xab", op, &CancellationToken::new()).await.expect("delivered");
        assert_eq!(reply["text"], "typed 5 literal characters into app-owned Electron renderer");
        assert_eq!(reply["delivery_accepted"], true);
        assert_eq!(reply["path"], "electron_insert_text");
        let asked = desk.asked.lock().unwrap();
        assert_eq!(asked[1], (INPUT_METHOD, json!({ "sessionThreadId": "thread-1", "windowId": "hwnd:0xab", "op": "type", "text": "héllo" })));
    }

    #[test]
    fn points_become_window_relative_and_a_wheel_keeps_the_native_workers_amount_rules() {
        let window = AppWindow::from_json(&json!({ "windowId": "hwnd:0x1", "bounds": { "x": 100, "y": 50, "width": 8, "height": 6 } })).unwrap();
        let op = |step: Value| AppInputOp::from_step(&object(step), &window);
        // Clicks and pointer moves are the helper's, as `canUseAppOwnedInput` left them.
        for action in ["click", "double_click", "right_click", "middle_click", "triple_click", "mouse_move"] {
            assert_eq!(op(json!({ "action": action, "x": 130, "y": 90 })), None, "{action}");
        }
        assert_eq!(op(json!({ "action": "scroll", "direction": "up", "amount": 500 })), Some(AppInputOp::Wheel { point: None, dx: 0.0, dy: -10_000.0, modifiers: None }));
        assert_eq!(op(json!({ "action": "scroll", "direction": "left", "x": 110, "y": 60 })), Some(AppInputOp::Wheel { point: Some((10.0, 10.0)), dx: -300.0, dy: 0.0, modifiers: None }));
        // No direction: `dy` gives the amount and the sign; the modifiers ride along.
        assert_eq!(
            op(json!({ "action": "scroll", "dy": -2, "modifiers": "ctrl" })),
            Some(AppInputOp::Wheel { point: None, dx: 0.0, dy: -200.0, modifiers: Some("ctrl".into()) })
        );
        assert_eq!(op(json!({ "action": "key", "keys": "^A", "ref": "" })), Some(AppInputOp::Key { keys: "^A".into() }));
        assert_eq!(op(json!({ "action": "type", "text": "a", "x": 101, "y": 52 })), Some(AppInputOp::Type { text: "a".into(), point: Some((1.0, 2.0)) }));
        assert_eq!(op(json!({ "action": "key_down", "keys": "^A" })), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_desktop_without_the_method_sends_the_step_to_the_helper() {
        let desk = Desk::new(Err((-32601, "unused")));
        let error = app_input(&*desk, "t", "hwnd:0xab", AppInputOp::Key { keys: "^A".into() }, &CancellationToken::new()).await.expect_err("not served");
        assert!(falls_back(&error));
        // An older desktop's list is empty, and it is asked again only after a long while.
        let older = AppOwnedWindows::new();
        older.refresh_with(|| async { Err(failed(format!("{WINDOWS_METHOD} {NOT_SERVED_SUFFIX}"))) }).await;
        assert!(older.window("hwnd:0xab").is_none());
        older.refresh_with(|| async { panic!("asked again within the not-served window") }).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_the_desktop_does_not_own_goes_to_the_helper() {
        let desk = Desk::new(Err((-32602, "invalid params")));
        let error = app_input(&*desk, "t", "hwnd:0xab", AppInputOp::Wheel { point: None, dx: 0.0, dy: 100.0, modifiers: None }, &CancellationToken::new()).await.expect_err("not owned");
        assert!(falls_back(&error));
        assert!(!not_served(&error));
    }

    #[tokio::test(start_paused = true)]
    async fn the_list_is_read_again_after_its_ttl_and_a_failed_read_names_no_window() {
        let desk = Desk::new(delivered());
        let windows = known(&desk).await;
        windows.refresh(&*desk, &CancellationToken::new()).await;
        assert_eq!(desk.reads.load(Ordering::SeqCst), 1);
        sleep(TTL * 2).await;
        windows.refresh(&*desk, &CancellationToken::new()).await;
        assert_eq!(desk.reads.load(Ordering::SeqCst), 2);
        sleep(TTL * 2).await;
        windows.refresh_with(|| async { Err(failed("Error: computer bridge timed out".into())) }).await;
        assert!(!windows.window("hwnd:0xab").is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn the_desktops_effects_are_the_steps_outcomes() {
        let ask = |answer: Value| {
            let desk = Desk::new(Ok(answer));
            async move { app_input(&*desk, "t", "hwnd:0xab", AppInputOp::Type { text: "x".into(), point: Some((1.0, 1.0)) }, &CancellationToken::new()).await }
        };
        let unconfirmed = ask(json!({ "delivered": false, "effect": "not_editable", "evidence": { "editable": false } })).await.expect("a row");
        assert_eq!(unconfirmed["code"], "typing_target_unconfirmed");
        assert_eq!(unconfirmed["delivery_accepted"], false);
        assert_eq!(unconfirmed["input_may_have_executed"], true);
        assert_eq!(unconfirmed["path"], "electron_typing_target_check");
        assert_eq!(unconfirmed["evidence"], json!({ "editable": false }));
        let gone = ask(json!({ "delivered": false, "effect": "window_gone" })).await.expect_err("gone");
        assert!(matches!(&gone, ComputerError::Failed { message, .. } if message.starts_with("computer_window_gone")));
        assert!(!falls_back(&gone));
        assert!(ask(json!({ "delivered": false, "effect": "refused" })).await.is_err());
        let unmappable = ask(json!({ "delivered": false, "effect": "refused", "code": "background_unsupported", "text": "background_unsupported: key {Zork} has no Electron input mapping; no input was sent" })).await.expect_err("refused");
        assert!(matches!(&unmappable, ComputerError::Failed { message, .. } if crate::desktop::computer_recovery::lead_code(message) == "background_unsupported"));
        assert!(!falls_back(&unmappable), "the helper is not tried after a refusal");
    }

    /// `preparatoryClickFailure`: the click's code and words, and whether input may have gone out, are the row's.
    #[tokio::test(start_paused = true)]
    async fn an_unconfirmed_preparatory_click_is_a_row_with_the_clicks_code() {
        let ask = |answer: Value| {
            let desk = Desk::new(Ok(answer));
            async move { app_input(&*desk, "t", "hwnd:0xab", AppInputOp::Type { text: "x".into(), point: Some((1.0, 1.0)) }, &CancellationToken::new()).await.expect("a row") }
        };
        let refused = ask(json!({ "delivered": false, "effect": "click_unconfirmed", "code": "user_input_active", "text": "the person is using the mouse", "deliveryAccepted": false })).await;
        assert_eq!(refused["code"], "user_input_active");
        assert_eq!(refused["text"], "the person is using the mouse");
        assert_eq!(refused["delivery_accepted"], false);
        assert_eq!(refused["input_may_have_executed"], false);
        assert_eq!(refused["action"], "type");
        let unknown = ask(json!({ "delivered": false, "effect": "click_unconfirmed" })).await;
        assert_eq!(unknown["code"], "typing_target_unconfirmed");
        assert_eq!(unknown["text"], "The preparatory click was not confirmed; no text was sent.");
        assert_eq!(unknown["delivery_accepted"], Value::Null);
        assert_eq!(unknown["input_may_have_executed"], true);
    }

    #[tokio::test(start_paused = true)]
    async fn a_delivered_key_row_carries_the_press_count_and_the_renderers_process() {
        let desk = Desk::new(Ok(json!({ "delivered": true, "effect": "delivered", "presses": 2, "pid": 4242 })));
        let reply = app_input(&*desk, "t", "hwnd:0xab", AppInputOp::Key { keys: "^A".into() }, &CancellationToken::new()).await.expect("delivered");
        assert_eq!(reply["text"], "sent 2 key press(es) to app-owned Electron renderer");
        assert_eq!(reply["pid"], 4242);
    }

    #[test]
    fn a_window_entry_needs_an_id_and_bounds() {
        assert!(AppWindow::from_json(&json!({ "windowId": " ", "bounds": { "x": 0, "y": 0, "width": 1, "height": 1 } })).is_none());
        assert!(AppWindow::from_json(&json!({ "windowId": "hwnd:0x1" })).is_none());
        let window = AppWindow::from_json(&json!({ "windowId": "hwnd:0x1", "bounds": { "x": 1, "y": 2, "width": 3, "height": 4 } })).unwrap();
        assert_eq!(window.scale_factor, 1.0);
        assert!(!window.focused);
    }

    #[test]
    fn a_key_the_renderer_cannot_map_is_found_before_any_step_runs() {
        let window = AppWindow::from_json(&json!({ "windowId": "hwnd:0x1", "bounds": { "x": 0, "y": 0, "width": 8, "height": 6 } })).unwrap();
        let owned = AppOwnedWindows::new();
        *owned.slot() = Read::Windows(Instant::now(), HashMap::from([("hwnd:0x1".to_string(), window)]));
        let refused = owned.unmapped_key(&object(json!({ "action": "key", "keys": "^{INSERT}" })), "hwnd:0x1").expect("refused");
        assert!(matches!(&refused, ComputerError::Failed { message, .. } if message == "background_unsupported: key {INSERT} has no Electron input mapping; no input was sent"));
        for keys in ["^a", "%{F4}", "{ENTER 3}", "+{left}", "{F24}", "{", "^{PGDN}{DELETE 2}", "+", "#{PLUS}"] {
            assert!(owned.unmapped_key(&object(json!({ "action": "key", "keys": keys })), "hwnd:0x1").is_none(), "{keys}");
        }
        // The first unmapped name is the one named; F25 and F0 are no function keys.
        assert_eq!(unmapped_key_name("{ENTER}{F25}{HOME}"), Some("F25".into()));
        assert_eq!(unmapped_key_name("{F0}"), Some("F0".into()));
        // A native window and a step the helper takes are not the renderer's to refuse.
        assert!(owned.unmapped_key(&object(json!({ "action": "key", "keys": "{INSERT}" })), "hwnd:0x2").is_none());
        assert!(owned.unmapped_key(&object(json!({ "action": "key", "keys": "{INSERT}", "delivery": "foreground" })), "hwnd:0x1").is_none());
        assert!(owned.unmapped_key(&object(json!({ "action": "type", "text": "{INSERT}" })), "hwnd:0x1").is_none());
    }
}
