//! Mixdog's own windows (`host/computer/appWindows`) and the input the desktop delivers into them (`host/computer/appInput`):
//! what `canUseAppOwnedInput` + `dispatchElectronInput` / `dispatchElectronText` did in the Node host
//! (`host/input-dispatch.ts`, `host/input-dispatch-electron-*.ts`). A window the desktop names takes `key`, `type`, `scroll`
//! and pointer steps through its renderer's own input channel, so it is never raised and the user's foreground window stays
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
#[allow(dead_code, reason = "the act wiring (s3-18) reads the size; the point math reads the origin")]
pub(super) struct Bounds {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

/// One entry of the `host/computer/appWindows` answer.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code, reason = "the act wiring (s3-18) reads the window's kind, display and focus")]
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
    #[allow(dead_code, reason = "the act wiring (s3-18) refreshes through the backend's channel")]
    pub(super) async fn refresh(&self, desktop: &dyn HostChannel, cancel: &CancellationToken) {
        self.refresh_with(|| request(desktop, WINDOWS_METHOD, json!({}), cancel)).await;
    }

    /// `isAppOwnedWindow`: the desktop named this window at the last read.
    #[allow(dead_code, reason = "the act wiring (s3-18) asks it before routing a step")]
    pub(super) fn is_app_owned(&self, window_id: &str) -> bool {
        self.window(window_id).is_some()
    }

    pub(super) fn window(&self, window_id: &str) -> Option<AppWindow> {
        match &*self.slot() {
            Read::Windows(_, windows) => windows.get(&normalized(window_id)).cloned(),
            _ => None,
        }
    }

    /// A window the desktop says it does not own is forgotten until the next read.
    fn forget(&self, window_id: &str) {
        if let Read::Windows(_, windows) = &mut *self.slot() {
            windows.remove(&normalized(window_id));
        }
    }

    /// The window and the input a step of an `act` is delivered as, when the window is the desktop's and the step is one its
    /// renderer takes (`canUseAppOwnedInput`: not foreground delivery, no ref); `None` sends the step to the helper.
    #[allow(dead_code, reason = "the act wiring (s3-18) routes each step through it")]
    pub(super) fn route(&self, step: &Map<String, Value>, window_id: &str) -> Option<(AppWindow, AppInputOp)> {
        let window = self.window(window_id)?;
        let op = AppInputOp::from_step(step, &window)?;
        Some((window, op))
    }
}

/// Whether an error is the desktop's method-not-found, or its answer that the window is not its own: either way the step goes
/// to the helper, as it did before the desktop served the methods.
#[allow(dead_code, reason = "the act wiring (s3-18) falls back to the helper on it")]
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

/// One input into an app-owned window; its points are physical pixels relative to the window's bounds.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum AppInputOp {
    /// The keys in the helper's grammar, as `normalizeComputerKeySequence` wrote them.
    Key { keys: String },
    Type { text: String, point: Option<(f64, f64)> },
    Click { x: f64, y: f64, button: &'static str, clicks: u8 },
    Move { x: f64, y: f64 },
    /// Signed wheel deltas in CSS pixels (`WHEEL_NOTCH` a notch), at a point or the middle of the window.
    Wheel { point: Option<(f64, f64)>, dx: f64, dy: f64 },
}

impl AppInputOp {
    /// The input a step is, with its screen-physical points (`computer_frames::map_step`) moved to the window's origin; `None`
    /// for a step the renderer's channel does not take.
    fn from_step(step: &Map<String, Value>, window: &AppWindow) -> Option<AppInputOp> {
        if text(step, "delivery") == "foreground" || step.get("ref").is_some_and(|reference| !reference.is_null()) {
            return None;
        }
        let point = || {
            let (x, y) = (step.get("x")?.as_f64()?, step.get("y")?.as_f64()?);
            Some((x - window.bounds.x, y - window.bounds.y))
        };
        let click = |button, clicks| point().map(|(x, y)| AppInputOp::Click { x, y, button, clicks });
        match text(step, "action") {
            "key" => Some(AppInputOp::Key { keys: step.get("keys")?.as_str()?.to_string() }),
            "type" => Some(AppInputOp::Type { text: step.get("text").and_then(Value::as_str).unwrap_or_default().to_string(), point: point() }),
            "click" => click("left", 1),
            "right_click" => click("right", 1),
            "middle_click" => click("middle", 1),
            "double_click" => click("left", 2),
            "triple_click" => click("left", 3),
            "mouse_move" => point().map(|(x, y)| AppInputOp::Move { x, y }),
            "scroll" => {
                // `wheelDeltas`: 1..100 notches, up and left negative.
                let magnitude = step.get("amount").and_then(Value::as_f64).filter(|amount| amount.is_finite()).unwrap_or(3.0).abs().clamp(1.0, 100.0);
                let direction = text(step, "direction");
                let delta = if matches!(direction, "up" | "left") { -magnitude } else { magnitude } * WHEEL_NOTCH;
                let horizontal = matches!(direction, "left" | "right");
                Some(AppInputOp::Wheel { point: point(), dx: if horizontal { delta } else { 0.0 }, dy: if horizontal { 0.0 } else { delta } })
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
            AppInputOp::Click { x, y, button, clicks } => set(vec![("op", json!("click")), ("x", json!(x)), ("y", json!(y)), ("button", json!(button)), ("clicks", json!(clicks))]),
            AppInputOp::Move { x, y } => set(vec![("op", json!("move")), ("x", json!(x)), ("y", json!(y))]),
            AppInputOp::Wheel { point, dx, dy } => {
                set(vec![("op", json!("wheel")), ("dx", json!(dx)), ("dy", json!(dy))]);
                if let Some((x, y)) = point {
                    set(vec![("x", json!(x)), ("y", json!(y))]);
                }
            }
        }
        Value::Object(params)
    }

    fn action(&self) -> &'static str {
        match self {
            AppInputOp::Key { .. } => "key",
            AppInputOp::Type { .. } => "type",
            AppInputOp::Click { .. } => "click",
            AppInputOp::Move { .. } => "mouse_move",
            AppInputOp::Wheel { .. } => "scroll",
        }
    }

    /// What a delivered input says it did (`delivered()` of `input-dispatch-electron-input.ts`, the text of `dispatchElectronText`).
    fn delivered_text(&self) -> String {
        match self {
            AppInputOp::Key { .. } => "sent key press(es) to app-owned Electron renderer".into(),
            AppInputOp::Type { text, .. } => format!("typed {} literal characters into app-owned Electron renderer", utf16_len(text)),
            AppInputOp::Click { .. } => "sent a click to app-owned Electron renderer".into(),
            AppInputOp::Move { .. } => "moved the pointer in app-owned Electron renderer".into(),
            AppInputOp::Wheel { .. } => "sent a wheel event to app-owned Electron renderer".into(),
        }
    }

    fn path(&self) -> &'static str {
        match self {
            AppInputOp::Key { .. } => "electron_key_event",
            AppInputOp::Type { point: Some(_), .. } => "electron_point_focus_insert_text",
            AppInputOp::Type { point: None, .. } => "electron_insert_text",
            AppInputOp::Click { .. } | AppInputOp::Move { .. } => "electron_pointer_event",
            AppInputOp::Wheel { .. } => "electron_wheel_event",
        }
    }
}

/// `host/computer/appInput`: one input into the app-owned window, answered as the result of an `act` step. A desktop that does
/// not serve the method, or that does not own the window, is an error `falls_back` names: the step then goes to the helper.
#[allow(dead_code, reason = "the act wiring (s3-18) sends each routed step through it")]
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
            result.insert("text".into(), json!(op.delivered_text()));
            result.insert("delivery_accepted".into(), json!(true));
        }
        // `typingTargetUnconfirmed`: nothing was typed; a click that preceded it may have landed.
        "not_editable" => {
            result.insert("code".into(), json!("typing_target_unconfirmed"));
            result.insert("text".into(), json!("The requested editable target was not confirmed; no text was sent. Observe fresh state before continuing."));
            result.insert("delivery_accepted".into(), json!(false));
            if matches!(&op, AppInputOp::Type { point: Some(_), .. }) {
                result.insert("input_may_have_executed".into(), json!(true));
            }
        }
        "window_gone" => return Err(failed("computer_window_gone: the window closed before the input was delivered; no input was sent".into())),
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
        assert!(windows.is_app_owned("HWND:0xab"));
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
        assert_eq!(op(json!({ "action": "double_click", "x": 130, "y": 90 })), Some(AppInputOp::Click { x: 30.0, y: 40.0, button: "left", clicks: 2 }));
        assert_eq!(op(json!({ "action": "right_click", "x": 100, "y": 50 })), Some(AppInputOp::Click { x: 0.0, y: 0.0, button: "right", clicks: 1 }));
        assert_eq!(op(json!({ "action": "click" })), None);
        assert_eq!(op(json!({ "action": "scroll", "direction": "up", "amount": 500 })), Some(AppInputOp::Wheel { point: None, dx: 0.0, dy: -10_000.0 }));
        assert_eq!(op(json!({ "action": "scroll", "direction": "left", "x": 110, "y": 60 })), Some(AppInputOp::Wheel { point: Some((10.0, 10.0)), dx: -300.0, dy: 0.0 }));
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
        let error = app_input(&*desk, "t", "hwnd:0xab", AppInputOp::Move { x: 1.0, y: 1.0 }, &CancellationToken::new()).await.expect_err("not owned");
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
        assert!(!windows.is_app_owned("hwnd:0xab"));
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
        assert_eq!(unconfirmed["evidence"], json!({ "editable": false }));
        let gone = ask(json!({ "delivered": false, "effect": "window_gone" })).await.expect_err("gone");
        assert!(matches!(&gone, ComputerError::Failed { message, .. } if message.starts_with("computer_window_gone")));
        assert!(!falls_back(&gone));
        assert!(ask(json!({ "delivered": false, "effect": "refused" })).await.is_err());
    }

    #[test]
    fn a_window_entry_needs_an_id_and_bounds() {
        assert!(AppWindow::from_json(&json!({ "windowId": " ", "bounds": { "x": 0, "y": 0, "width": 1, "height": 1 } })).is_none());
        assert!(AppWindow::from_json(&json!({ "windowId": "hwnd:0x1" })).is_none());
        let window = AppWindow::from_json(&json!({ "windowId": "hwnd:0x1", "bounds": { "x": 1, "y": 2, "width": 3, "height": 4 } })).unwrap();
        assert_eq!(window.scale_factor, 1.0);
        assert!(!window.focused);
    }
}
