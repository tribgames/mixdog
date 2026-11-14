//! The resident host: request loop, per-request guards, and the shared
//! pieces every action builds on. Actions live in the sibling modules.

mod cursor;
mod elevated;
pub use elevated::worker as elevated_worker;
mod frame;
mod frame_quality;
mod input;
mod lease;
mod marks;
mod misc;
mod protection;
mod saved_login;
mod semantic;
mod stdin;
mod targets;
mod windows;

use crate::config::Config;
use cursor::ThemeRun;
use crate::keys::Mod;
use crate::lease_api::ForegroundLease;
use crate::obj;
use crate::observer::{now_ms, Observer, Scope};
use crate::platform::{self, parse_window_id, window_id, Button, Desktop, Wid, WindowInfo};
use crate::protocol::{write_line, Obj, Req, POINTER_MARKER, RESPONSE_MARKER};
use crate::session::{RestorePoint, Session};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;

pub type Res<T> = Result<T, String>;

const GLIDE_WAIT_MS: u64 = 360;
const GLIDE_MIN_WAIT_MS: u64 = 140;
const GLIDE_SPEED_PX_PER_MS: f64 = 1.4;
const GLIDE_SEED_OFFSET: f64 = 140.0;

pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// An input error the platform already coded passes through as it is (the
/// worker threw the receipt's own text, MixNativeInput.Deliver); a bare one
/// is named by `context`. A release never passes through as a retryable
/// delivery failure.
fn coded_or(error: String, context: &str) -> String {
    let cleanup = error.starts_with("input_cleanup_unconfirmed:");
    let delivery = error.starts_with("input_delivery_failed:");
    if cleanup || (delivery && !context.starts_with("input_cleanup_unconfirmed:")) {
        error
    } else {
        format!("{context}: {error}")
    }
}

#[derive(Default)]
struct Feedback {
    id: i64,
    enabled: bool,
    generated: i64,
    failed: i64,
    last: Option<(i32, i32)>,
    last_wait_ms: u64,
}

/// The target a foreground action dispatches to: every input it sends is
/// re-authorized, and once dispatch starts the target must keep the foreground.
#[derive(Clone, Copy)]
struct Dispatch {
    target: Wid,
    ready: bool,
    /// The window that kept the foreground when the target refused activation
    /// and the pointer gesture itself is to activate it
    /// (MixWin32.BeginPointerActivation).
    holder: Option<Wid>,
}

impl Dispatch {
    /// DispatchAuthorization's foreground rule (input-guard.ps1:103-110): the
    /// target holds it, or, while a pointer activation is pending, the window
    /// that kept it (HoldsForActivation). Any third window stops the input.
    /// Before the activation attempt nothing is demanded yet. A dialog or popup
    /// the target owns (`owned`) counts as the target: an action may open one
    /// and the keys that follow belong to it.
    fn holds(&self, foreground: Wid, owned: impl Fn(Wid) -> bool) -> bool {
        if foreground == self.target || (self.ready && owned(foreground)) {
            return true;
        }
        match self.holder {
            Some(holder) => foreground == holder,
            None => !self.ready,
        }
    }
}

pub struct Host {
    cfg: Config,
    desktop: Box<dyn Desktop>,
    observer: Observer,
    sessions: RefCell<HashMap<String, Session>>,
    current: RefCell<String>,
    request: RefCell<Req>,
    scope: RefCell<Scope>,
    dispatch: Cell<Option<Dispatch>>,
    feedback: RefCell<Feedback>,
    /// The desktop host's foreground-lock lease channel.
    lease: Box<dyn ForegroundLease>,
    /// What a failed request still reports under `result`, such as a capture's
    /// unconfirmed cleanup (runtime.ps1:255-264).
    error_result: RefCell<Option<Obj>>,
    /// Set when a resource this host used could not be confirmed released:
    /// the host exits once that request's reply is out.
    retire_after_reply: Cell<bool>,
    /// The activation guard's facts for the request being served.
    activation_facts: RefCell<Option<Value>>,
    /// Windows whose last unnamed-backend capture needed Windows Graphics
    /// Capture, with the process that owned them: the next one asks it first.
    wgc_windows: RefCell<HashMap<Wid, i64>>,
}

pub fn run() {
    let cfg = Config::from_env();
    let observer = Observer::new();
    let desktop = platform::create(observer.shared.clone(), cfg.input_marker);
    Host::new(cfg, desktop, observer, lease::from_env()).serve_lines(stdin::Router::stdin());
}

/// Reports what this desktop can do, for diagnostics and packaging checks.
pub fn probe() -> i32 {
    let observer = Observer::new();
    let desktop = platform::create(observer.shared.clone(), crate::config::input_marker());
    sleep_ms(300);
    let accessibility = desktop.accessibility().map(|a11y| match a11y.available() {
        Ok(()) => "ready".to_string(),
        Err(error) => error,
    });
    let windows = desktop.windows().map(|list| list.len());
    let report = json!({
        "platform": desktop.name(),
        "windows": windows.as_ref().ok(),
        "windows_error": windows.err(),
        "observer_ready": observer.read().ready,
        "accessibility": accessibility,
        "background": desktop.background().is_some(),
    });
    println!("{report}");
    0
}

impl Host {
    fn new(
        cfg: Config,
        desktop: Box<dyn Desktop>,
        observer: Observer,
        lease: Box<dyn ForegroundLease>,
    ) -> Host {
        Host {
            cfg,
            desktop,
            observer,
            sessions: RefCell::new(HashMap::new()),
            current: RefCell::new("default".into()),
            request: RefCell::new(Req(Value::Null)),
            scope: RefCell::new(Scope::default()),
            dispatch: Cell::new(None),
            feedback: RefCell::new(Feedback::default()),
            lease,
            error_result: RefCell::new(None),
            retire_after_reply: Cell::new(false),
            activation_facts: RefCell::new(None),
            wgc_windows: RefCell::new(HashMap::new()),
        }
    }

    /// Answers each request line in turn until the input ends, or until a
    /// reply asked this host to retire.
    fn serve_lines(&self, requests: stdin::Router) {
        for line in requests {
            self.serve(&line);
            if self.retire_after_reply.get() {
                break;
            }
        }
        // The input ended (the core died) or this host retires: nothing it
        // holds may outlive it, the way --screen-input lets go on EOF.
        self.release_on_exit();
    }

    /// Lets go of every key, button, no-activate hold, the cursor theme and
    /// this process's own foreground lock, in every session; each step runs
    /// whatever the earlier ones answered.
    fn release_on_exit(&self) {
        let keys: Vec<String> = self.sessions.borrow().keys().cloned().collect();
        let previous = self.current.borrow().clone();
        for key in keys {
            self.current.replace(key);
            let _ = self.release_held_input();
        }
        self.current.replace(previous);
        let _ = self.desktop.cursor_theme_end();
        self.desktop.release_process_holds();
    }

    fn serve(&self, line: &str) {
        write_line(RESPONSE_MARKER, &self.reply(line));
    }

    fn reply(&self, line: &str) -> Value {
        let parsed: Result<Value, _> = serde_json::from_str(line);
        let (id, req) = match parsed {
            Ok(value @ Value::Object(_)) => {
                let req = Req(value);
                (req.int("id").unwrap_or(0), Some(req))
            }
            _ => (0, None),
        };
        let wants_feedback = req
            .as_ref()
            .is_some_and(|req| req.bool_true("pointer_feedback"));
        {
            let mut feedback = self.feedback.borrow_mut();
            feedback.id = id;
            feedback.enabled = wants_feedback;
            feedback.generated = 0;
            feedback.failed = 0;
        }
        self.activation_facts.replace(None);
        protection::begin(self);
        let outcome = match &req {
            Some(req) => {
                let mut result = self.handle(req);
                self.feedback.borrow_mut().enabled = false;
                self.invalidate_refs_for(req);
                if let Ok(result) = &mut result {
                    protection::annotate(self, req, result);
                }
                result
            }
            None => Err("invalid request: expected one JSON object".to_string()),
        };
        let error_result = self.error_result.take();
        let mut envelope = obj! { "id" => id };
        match outcome {
            Ok(result) => {
                envelope.insert("ok".into(), json!(true));
                envelope.insert("result".into(), Value::Object(result));
            }
            Err(error) => {
                envelope.insert("ok".into(), json!(false));
                envelope.insert("error".into(), json!(error));
                if let Some(result) = error_result {
                    envelope.insert("result".into(), Value::Object(result));
                }
            }
        }
        if wants_feedback {
            let feedback = self.feedback.borrow();
            envelope.insert(
                "pointer_feedback".into(),
                json!({ "generated": feedback.generated, "failed": feedback.failed }),
            );
        }
        Value::Object(envelope)
    }

    /// A sequence step whose later step addresses a ref of the same
    /// observation keeps the refs (Invalidate-RefsForRequest, runtime.ps1:45-52).
    fn invalidate_refs_for(&self, req: &Req) {
        if !req.bool_true("retain_refs") && !self.cfg.retain_ref_actions.contains(&req.action()) {
            self.session(|session| session.invalidate_refs());
        }
    }

    fn handle(&self, req: &Req) -> Res<Obj> {
        let session_key = req.str("session_id").unwrap_or_else(|| "default".into());
        self.sessions
            .borrow_mut()
            .entry(session_key.clone())
            .or_default();
        *self.current.borrow_mut() = session_key;
        let resolved = marks::resolve(self, req)?;
        let req = resolved.as_ref().unwrap_or(req);
        *self.request.borrow_mut() = req.clone();
        self.authorize(req, 0)?;
        let action = req.action();
        let read = self.cfg.is_read(&action);
        if req.truthy("read_only") && !read {
            return Err(format!("read_only run: '{action}' is a mutation"));
        }
        // Activating a window is foreground input whatever the delivery says.
        let input_scope = (req.delivery_foreground() || action == "focus_window") && !read;
        if input_scope {
            // Only input that can reach this action counts against it: input
            // into the target window's process, and any pointer input once
            // foreground input drives the shared pointer (runtime.ps1:79-89).
            let target = parse_window_id(&req.text("window_id"));
            let process = if target == 0 { 0 } else { self.desktop.pid_of(target) };
            let pointer = req.delivery_foreground() && action != "focus_window";
            let mut scope = self.scope.borrow_mut();
            match (
                req.str("observed_input_monitor_id"),
                req.int("observed_input_user_sequence"),
            ) {
                (Some(generation), Some(sequence)) => scope.begin_expected_for(
                    &self.observer,
                    &generation,
                    sequence,
                    process,
                    pointer,
                )?,
                _ => scope.begin_for(&self.observer, process, pointer)?,
            }
        }
        let routed = if input_scope {
            elevated::route(self, req)
        } else {
            None
        };
        let result = routed.unwrap_or_else(|| self.dispatch_action(&action, req));
        if input_scope {
            self.scope.borrow_mut().end();
        }
        result
    }

    fn dispatch_action(&self, action: &str, req: &Req) -> Res<Obj> {
        match action {
            "sequence_step" => self.sequence_step(req),
            "list_windows" => self.list_windows(),
            "window_snapshot" => self.window_snapshot(),
            "related_windows" => self.related_windows(req),
            "snapshot" | "find" => self.snapshot_window(req),
            "invoke" => {
                if req.delivery_foreground() {
                    self.click_family(req, "click")
                } else {
                    self.background_semantic(req, "release", |host| {
                        host.do_invoke(req, false).map(Option::unwrap_or_default)
                    })
                }
            }
            "set_value" => self.background_semantic(req, "type", |host| {
                host.do_set_value(req, &req.text("text"))
            }),
            "toggle" => self.background_semantic(req, "release", |host| host.do_toggle(req)),
            "click" => self.click_family(req, "click"),
            "double_click" => self.click_family(req, "double"),
            "right_click" => self.click_family(req, "right"),
            "middle_click" => self.click_family(req, "middle"),
            "triple_click" => self.click_family(req, "triple"),
            "mouse_move" => self.click_family(req, "move"),
            "mouse_down" => self.click_family(req, "press"),
            "mouse_up" => self.click_family(req, "release"),
            "wait" => self.do_wait(req),
            "drag" => self.do_drag(req),
            "scroll" => self.do_scroll(req),
            "focus_window" => self.do_focus(req),
            "window_bounds" => self.window_bounds(req),
            "window_capture" => self.window_capture(req),
            "validate_background_input" => self.validate_background_input(req),
            "window_predicates" => self.window_predicates(req),
            "accessibility_probe" => self.accessibility_probe(req),
            "invoke_menu" => self.invoke_menu(req),
            "window_integrity" => self.window_integrity(req),
            "input_recovery_state" => self.input_recovery_state(req),
            "input_idle_state" => Ok(self.input_idle_state(req)),
            "restore_input_state" => self.restore_input_state(req),
            "move_window" => self.move_window(req),
            "key" => self.do_key(req),
            "key_down" => self.do_key_hold(req, true),
            "key_up" => self.do_key_hold(req, false),
            "type" => self.do_type(req),
            "window_state" => self.window_state(req),
            "close_window" => self.close_window(req),
            "terminate_process" => self.terminate_process(req),
            "ocr_image" => self.ocr_image(req),
            "ocr_status" => Ok(self.ocr_status(req)),
            "clipboard_read" => self.clipboard_read(),
            "clipboard_write" => self.clipboard_write(req),
            "launch" => self.launch(req),
            "list_installed_apps" => self.list_installed_apps(req),
            "list_apps" => self.list_apps(req),
            "process_fate" => self.process_fate(req),
            "saved_login_check" | "saved_login_type" => self.saved_login(action, req),
            "release_session" => self.release_session_state(req),
            "release_held_input" => self.release_held_input(),
            "release_sequence_holds" => self.release_sequence_holds(),
            "release_cursor_theme" => self.release_cursor_theme(),
            other => Err(format!("unknown action: {other}")),
        }
    }

    // --- shared state ------------------------------------------------------

    fn session<R>(&self, f: impl FnOnce(&mut Session) -> R) -> R {
        let key = self.current.borrow().clone();
        let mut sessions = self.sessions.borrow_mut();
        f(sessions.entry(key).or_default())
    }

    fn current_request(&self) -> Req {
        self.request.borrow().clone()
    }

    // --- authorization -----------------------------------------------------

    /// The host's grant for this request: an expiry, and when present, the one
    /// window and process identity the input may reach.
    fn authorize(&self, req: &Req, actual: Wid) -> Res<()> {
        if let Some(expires) = req.int("authorization_expires_at") {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or(i64::MAX);
            if now >= expires {
                return Err(
                    "computer_policy_expired: authorization expired before native dispatch".into(),
                );
            }
        }
        if let Some(pid) = req.int("authorization_pid") {
            let expected = parse_window_id(&req.text("authorization_window_id"));
            let requested = parse_window_id(&req.text("window_id"));
            if expected == 0 || requested != expected || (actual != 0 && actual != expected) {
                return Err(
                    "computer_policy_denied: native target is outside the authorization".into(),
                );
            }
            match self.desktop.info(expected) {
                Some(info) if info.pid == pid => {}
                _ => {
                    return Err(
                        "computer_policy_denied: native target process identity changed".into(),
                    )
                }
            }
        }
        Ok(())
    }

    fn authorize_current(&self, actual: Wid) -> Res<()> {
        let req = self.current_request();
        self.authorize(&req, actual)
    }

    // --- windows -------------------------------------------------------------

    fn resolve_window(&self, req: &Req) -> Res<WindowInfo> {
        let (title, id) = (req.str("window"), req.str("window_id"));
        if let (None, None, Some(app)) = (&title, &id, req.str("app")) {
            if let Some(found) = targets::resolve_app(self, &app) {
                return found;
            }
        }
        self.resolve_window_parts(title.as_deref(), id.as_deref())
    }

    fn resolve_window_parts(&self, title: Option<&str>, id: Option<&str>) -> Res<WindowInfo> {
        if let Some(id) = id {
            let handle = parse_window_id(id);
            return self
                .desktop
                .info(handle)
                .filter(|_| handle != 0)
                .ok_or_else(|| format!("window_id is stale or invalid: {id}"));
        }
        let Some(title) = title else {
            let handle = self.desktop.foreground();
            return self
                .desktop
                .info(handle)
                .filter(|_| handle != 0)
                .ok_or_else(|| "foreground window not found".to_string());
        };
        let wanted = title.to_lowercase();
        let windows = self.desktop.windows()?;
        let exact: Vec<&WindowInfo> = windows.iter().filter(|info| info.title == title).collect();
        if exact.len() == 1 {
            return Ok(exact[0].clone());
        }
        if exact.len() > 1 {
            let ids: Vec<String> = exact.iter().map(|info| info.id()).collect();
            return Err(format!(
                "window title is ambiguous: {title} (ids: {}); use window_id",
                ids.join(" | ")
            ));
        }
        let partial: Vec<&WindowInfo> = windows
            .iter()
            .filter(|info| !info.title.is_empty() && info.title.to_lowercase().contains(&wanted))
            .collect();
        if partial.len() == 1 {
            return Ok(partial[0].clone());
        }
        if partial.len() > 1 {
            let candidates: Vec<String> = partial
                .iter()
                .map(|info| format!("{} {}", info.id(), info.title))
                .collect();
            return Err(format!(
                "window title is ambiguous: {title} (matches: {}); use window_id",
                candidates.join(" | ")
            ));
        }
        Err(format!("window not found: {title}"))
    }

    fn is_window(&self, handle: Wid) -> bool {
        self.desktop.is_window(handle)
    }

    /// Whether `candidate` is `surface` itself or drawn inside it.
    fn is_contained(&self, candidate: Wid, surface: Wid) -> bool {
        self.desktop.is_contained(candidate, surface)
    }

    fn allowed_point_target(&self, candidate: Wid, selected: Wid, allowed: &[String]) -> bool {
        if candidate == selected || self.is_contained(candidate, selected) {
            return true;
        }
        if self.desktop.is_owned_by(candidate, selected) {
            return allowed.iter().any(|id| parse_window_id(id) == candidate);
        }
        false
    }

    fn remember_focus_origin(&self, previous: Wid, target: Wid) {
        let snapshot = self.observer.read();
        self.session(|session| {
            if session.original_focus != 0 || previous == target {
                return;
            }
            session.original_focus = previous;
            if snapshot.ready {
                session.original_focus_monitor = snapshot.generation.clone();
                session.original_focus_sequence = Some(snapshot.sequence);
            }
        });
    }

    // --- results -------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn action_result(
        &self,
        action: &str,
        path: &str,
        effect: &str,
        verified: bool,
        message: &str,
        code: Option<&str>,
        delivery: &str,
        window: Option<String>,
    ) -> Obj {
        let accepted = code.is_none() && path != "none" && effect != "suspected_noop";
        obj! {
            "text" => message,
            "action" => action,
            "path" => path,
            "effect" => effect,
            "verified" => verified,
            "delivery_accepted" => accepted,
            "goal_verified" => verified,
            "code" => code,
            "delivery" => delivery,
            "window_id" => window,
        }
    }

    fn background_unavailable(
        &self,
        action: &str,
        message: &str,
        window: Option<String>,
        code: &str,
        may_have_executed: bool,
    ) -> Obj {
        let mut result = self.action_result(
            action,
            "none",
            "suspected_noop",
            false,
            message,
            Some(code),
            "background",
            window,
        );
        if may_have_executed {
            result.insert("delivery_accepted".into(), Value::Null);
            result.insert("effect".into(), json!("unverifiable"));
            result.insert("input_may_have_executed".into(), json!(true));
        }
        result
    }

    /// A failed background delivery, classified by the code its error names.
    fn background_failure(
        &self,
        action: &str,
        error: &str,
        window: Option<String>,
        prior_input: bool,
    ) -> Res<Obj> {
        if error.contains("input_cleanup_unconfirmed:") {
            return Err("input_cleanup_unconfirmed: background input release was not acknowledged; do not replay input".into());
        }
        let mut code = "background_unavailable";
        let mut detail = error.to_string();
        for candidate in [
            "background_target_hung",
            "background_blocked_uipi",
            "background_message_rejected",
            "background_target_ambiguous",
            "background_unsupported",
            "focus_required",
            "dialog_key_unsupported",
            "target_mismatch",
            "stale_target",
        ] {
            let marker = format!("{candidate}|");
            if let Some(at) = error.find(&marker) {
                code = candidate;
                detail = error[at + marker.len()..].trim_matches('"').to_string();
                break;
            }
        }
        // Only a complete preflight refusal proves that no input was attempted
        // (Native-BackgroundFailure, input-semantic.ps1:249-276); the dialog
        // refusals (input/background-dialog-input.ts:38-65) are such refusals.
        let refused = matches!(
            code,
            "background_unsupported" | "focus_required" | "dialog_key_unsupported"
        );
        Ok(self.background_unavailable(
            action,
            &detail,
            window,
            code,
            prior_input || !refused,
        ))
    }

    // --- pointer feedback ----------------------------------------------------

    fn report_pointer(&self, x: i32, y: i32, held: bool, phase: &str) {
        let mut feedback = self.feedback.borrow_mut();
        if !feedback.enabled {
            return;
        }
        feedback.generated += 1;
        let (dx, dy) = match feedback.last {
            Some((px, py)) => ((x - px) as f64, (y - py) as f64),
            None => (GLIDE_SEED_OFFSET, GLIDE_SEED_OFFSET),
        };
        let travel = (dx * dx + dy * dy).sqrt() / GLIDE_SPEED_PX_PER_MS;
        feedback.last_wait_ms = (travel.round() as u64).clamp(GLIDE_MIN_WAIT_MS, GLIDE_WAIT_MS);
        feedback.last = Some((x, y));
        let id = feedback.id;
        drop(feedback);
        // What the desktop's overlay needs of the request besides the point
        // (classifyWorkerRequest: the delivery and the target window).
        let request = self.request.borrow();
        let mode = if request.delivery_foreground() { "foreground" } else { "background" };
        let event = json!({
            "id": id, "x": x, "y": y, "held": held, "phase": phase,
            "mode": mode, "window_id": request.str("window_id"),
        });
        drop(request);
        write_line(POINTER_MARKER, &event);
    }

    fn report_current_pointer(&self, phase: &str) {
        let (x, y) = self.desktop.cursor();
        self.report_pointer(x, y, false, phase);
    }

    fn pointer_failed(&self) {
        self.feedback.borrow_mut().failed += 1;
    }

    fn feedback_enabled(&self) -> bool {
        self.feedback.borrow().enabled
    }

    fn last_glide_wait_ms(&self) -> u64 {
        self.feedback.borrow().last_wait_ms
    }

    // --- input observation and guarded dispatch ------------------------------

    /// Every input a foreground action sends passes here first: the grant still
    /// holds, the target still has the foreground, and nobody else has touched
    /// the mouse or keyboard since the action began.
    fn assert_continue(&self) -> Res<()> {
        if let Some(dispatch) = self.dispatch.get() {
            self.authorize_current(dispatch.target)?;
            let foreground = self.desktop.foreground();
            if !dispatch.holds(foreground, |window| self.owned_by_target(window, dispatch.target)) {
                return Err(
                    "foreground_changed: target lost foreground before input dispatch".into(),
                );
            }
        }
        self.scope.borrow().assert_continue(&self.observer)
    }

    /// A dialog or popup of the target's own process whose owner chain reaches
    /// the target; a window of another process is never the target's.
    fn owned_by_target(&self, window: Wid, target: Wid) -> bool {
        let process = self.desktop.pid_of(target);
        process != 0
            && self.desktop.pid_of(window) == process
            && self.desktop.is_owned_by(window, target)
    }

    /// The target, or a window it owns, has the foreground.
    fn target_or_owned_in_front(&self, target: Wid) -> bool {
        let foreground = self.desktop.foreground();
        foreground == target || self.owned_by_target(foreground, target)
    }

    fn mark_own(&self) {
        self.observer.shared.mark_own_input(250);
    }

    fn physical_idle_ms(&self) -> u64 {
        if !self.observer.read().ready {
            return i32::MAX as u64;
        }
        self.observer.foreign_idle_ms().min(i32::MAX as u64)
    }

    fn fg_move(&self, x: i32, y: i32) -> Res<()> {
        self.assert_continue()?;
        self.mark_own();
        self.desktop
            .move_pointer(x, y)
            .map_err(|error| coded_or(error, "input_delivery_failed: pointer movement was rejected"))
    }

    /// AssertCursorPosition (MixWin32Foreground.cs:160-168), within the miss
    /// this desktop's pointer placement is allowed: none on Windows.
    fn assert_cursor_at(&self, x: i32, y: i32) -> Res<()> {
        self.assert_continue()?;
        let (cx, cy) = self.desktop.cursor();
        let tolerance = self.desktop.cursor_tolerance();
        if (cx - x).abs() > tolerance || (cy - y).abs() > tolerance {
            return Err("target_mismatch|cursor did not reach the observed point; no positive pointer input sent".into());
        }
        Ok(())
    }

    fn assert_drag_target(&self, target: Wid, x: i32, y: i32) -> Res<()> {
        let hit = self.desktop.window_at_point(x, y);
        // A target the system refused to activate (the Windows foreground
        // lock; macOS grants activation to the frontmost app only) is reached
        // by the pointer gesture itself, and the press is what brings it
        // forward: until then the window that kept the foreground may hold it,
        // and no other (AssertDragTarget, MixWin32Foreground.cs:202-211).
        let foreground = self.desktop.foreground();
        let held = match self.dispatch.get() {
            Some(dispatch) => dispatch.holds(foreground, |window| self.owned_by_target(window, dispatch.target)),
            None => foreground == target,
        };
        if !self.is_window(target)
            || !held
            || (hit != target && !self.is_contained(hit, target))
        {
            return Err(
                "target_mismatch|drag target changed; observe fresh state before retrying".into(),
            );
        }
        Ok(())
    }

    /// Moves the real pointer to the point in visible steps, checking the
    /// target and the user at every step.
    fn glide(&self, target: Wid, x: i32, y: i32) -> Res<()> {
        self.assert_continue()?;
        let (sx, sy) = self.desktop.cursor();
        let distance = (((x - sx) as f64).powi(2) + ((y - sy) as f64).powi(2)).sqrt();
        let steps = ((distance * 0.25).clamp(240.0, 650.0) / 16.0)
            .ceil()
            .max(1.0) as i32;
        for step in 1..=steps {
            self.assert_continue()?;
            self.assert_drag_target(target, x, y)?;
            let t = (step as f64 / steps as f64).clamp(0.0, 1.0);
            let eased = t * t * (3.0 - 2.0 * t);
            let px = (sx as f64 + (x - sx) as f64 * eased).round() as i32;
            let py = (sy as f64 + (y - sy) as f64 * eased).round() as i32;
            self.fg_move(px, py)?;
            let (ax, ay) = self.desktop.cursor();
            self.report_pointer(ax, ay, false, "move");
            sleep_ms(16);
        }
        self.assert_continue()?;
        self.assert_drag_target(target, x, y)?;
        self.assert_cursor_at(x, y)
    }

    /// Each press is announced, shown held, and shown released, so the overlay
    /// plays the press and ripple at the point instead of keeping the travel
    /// ring it last drew. Every press is guarded, a release never is
    /// (MixWin32.mouse_event, MixWin32.cs:102-112); a release that failed
    /// reports as cleanup, never as a delivery the caller may retry.
    fn fg_button(&self, button: Button, down: bool, x: i32, y: i32, clicks: u32) -> Res<()> {
        if down {
            self.assert_continue()?;
            if self.feedback_enabled() {
                self.report_pointer(x, y, false, "prepare");
                sleep_ms(120);
                self.assert_continue()?;
            }
        }
        self.mark_own();
        self.desktop
            .button(button, down, x, y, clicks)
            .map_err(|error| {
                coded_or(
                    error,
                    if down {
                        "input_delivery_failed: pointer button was rejected"
                    } else {
                        "input_cleanup_unconfirmed: pointer button release failed"
                    },
                )
            })?;
        self.report_pointer(x, y, down, if down { "press" } else { "release" });
        Ok(())
    }

    /// Presses and releases `button` `count` times at the point.
    fn fg_click(&self, button: Button, x: i32, y: i32, count: u32) -> Res<()> {
        self.fg_move(x, y)?;
        sleep_ms(40);
        for press in 1..=count {
            if press > 1 {
                sleep_ms(if count == 3 { 60 } else { 80 });
            }
            self.assert_cursor_at(x, y)?;
            self.fg_button(button, true, x, y, press)?;
            self.fg_button(button, false, x, y, press)?;
        }
        Ok(())
    }

    fn fg_key(&self, key: crate::keys::Key, down: bool) -> Res<()> {
        self.assert_continue()?;
        self.mark_own();
        self.desktop.key(key, down)
    }

    /// SendText (MixWin32SendInput.cs:57-77): each glyph is its own guarded
    /// dispatch, so typing stops at the next glyph once the person touches the
    /// input, the target loses the foreground, or the grant expires.
    fn fg_text(&self, text: &str) -> Res<()> {
        let mut glyph = [0u8; 4];
        for character in text.chars() {
            self.assert_continue()?;
            self.mark_own();
            self.desktop.text(character.encode_utf8(&mut glyph))?;
        }
        Ok(())
    }

    /// Get-ForegroundRefusal (input-guard.ps1:68-87): a window above this
    /// host's integrity that holds the foreground can be neither displaced nor
    /// typed into, so a foreground action refuses before anything moves.
    fn foreground_refusal(&self, action: &str, target: Wid) -> Option<Obj> {
        let holder = self.desktop.foreground();
        if holder == target || !self.is_window(holder) {
            return None;
        }
        let level = self
            .desktop
            .integrity(holder)
            .filter(|level| level.known() && level.higher())?;
        let title = self
            .desktop
            .info(holder)
            .map(|info| info.title)
            .unwrap_or_default();
        Some(self.action_result(
            action,
            "foreground",
            "suspected_noop",
            false,
            &format!(
                "the foreground belongs to '{title}', which runs at {} integrity above this host ({}); Windows lets a lower process neither take the foreground from it nor type into it, so no input was sent. Ask the user to switch away from that window.",
                level.target_name, level.own_name
            ),
            Some("foreground_unavailable"),
            "foreground",
            Some(window_id(target)),
        ))
    }

    /// The session's first foreground input records where an abort returns
    /// the desktop (the recovery state of host/lifecycle-abort.ts:38-55): its
    /// target, the focus the session started from, and the cursor before
    /// anything moved. Answers the point only when this call recorded it.
    fn record_restore_point(&self, target: Wid, previous: Wid) -> Option<Value> {
        let original = self.session(|session| {
            session
                .restore_point
                .is_none()
                .then_some(session.original_focus)
        })?;
        let restore = if self.is_window(original) {
            original
        } else {
            previous
        };
        let (cursor_x, cursor_y) = self.desktop.cursor();
        let point = RestorePoint {
            target,
            restore: if self.is_window(restore) { restore } else { 0 },
            cursor_x,
            cursor_y,
        };
        self.session(|session| session.restore_point = Some(point));
        let restore_id = if point.restore != 0 {
            window_id(point.restore)
        } else {
            String::new()
        };
        Some(json!({
            "target_window_id": window_id(point.target),
            "restore_window_id": restore_id,
            "cursor_x": point.cursor_x,
            "cursor_y": point.cursor_y,
        }))
    }

    /// Runs `body` with the pointer modifiers held, releasing them however it ends.
    fn with_modifiers(&self, modifiers: &[Mod], body: impl FnOnce() -> Res<()>) -> Res<()> {
        let mut pressed = Vec::new();
        let mut outcome = Ok(());
        for modifier in modifiers {
            match self.fg_key(crate::keys::Key::Mod(*modifier), true) {
                Ok(()) => pressed.push(*modifier),
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            }
        }
        if outcome.is_ok() {
            outcome = body();
        }
        let mut release_failed = false;
        for modifier in pressed.iter().rev() {
            self.mark_own();
            if self
                .desktop
                .key(crate::keys::Key::Mod(*modifier), false)
                .is_err()
            {
                release_failed = true;
            }
        }
        if release_failed {
            return Err("input_cleanup_unconfirmed: pointer modifier release failed".into());
        }
        outcome
    }

    /// The whole foreground protocol around one input body: wait for the user
    /// to pause, bring the exact target forward, dispatch under observation,
    /// and report what can and cannot be known about the result.
    fn foreground_input(
        &self,
        target: Wid,
        action: &str,
        pointer_may_activate: bool,
        body: &mut dyn FnMut() -> Res<()>,
    ) -> Res<Obj> {
        if !self.is_window(target) {
            return Ok(self.action_result(
                action,
                "foreground",
                "suspected_noop",
                false,
                &format!("{action} target window is invalid"),
                Some("target_required"),
                "foreground",
                None,
            ));
        }
        if let Some(refusal) = self.foreground_refusal(action, target) {
            return Ok(refusal);
        }
        self.authorize_current(target)?;
        let previous = self.desktop.foreground();
        self.remember_focus_origin(previous, target);
        self.scope.borrow_mut().begin(&self.observer)?;
        let restore_point = self.record_restore_point(target, previous);
        let prior_dispatch = self.dispatch.replace(Some(Dispatch {
            target,
            ready: false,
            holder: None,
        }));
        let mut theme = ThemeRun::default();
        let mut outcome = self.foreground_body(
            target,
            action,
            pointer_may_activate,
            previous,
            &mut theme,
            body,
        );
        self.theme_finish(&theme, &mut outcome);
        // Ends the pointer activation with the action that began it
        // (EndPointerActivation).
        self.dispatch.set(prior_dispatch);
        self.scope.borrow_mut().end();
        self.report_restore_point(restore_point, &mut outcome);
        outcome
    }

    /// Puts a restore point this action recorded on its reply. A failed first
    /// input moved the desktop too: its reply carries the point under
    /// `result` like any other.
    fn report_restore_point(&self, point: Option<Value>, outcome: &mut Res<Obj>) {
        let Some(point) = point else { return };
        match outcome {
            Ok(result) => {
                result.insert("restore_point".into(), point);
            }
            Err(_) => {
                self.error_result
                    .borrow_mut()
                    .get_or_insert_with(Obj::new)
                    .insert("restore_point".into(), point);
            }
        }
    }

    fn foreground_body(
        &self,
        target: Wid,
        action: &str,
        pointer_may_activate: bool,
        previous: Wid,
        theme: &mut ThemeRun,
        body: &mut dyn FnMut() -> Res<()>,
    ) -> Res<Obj> {
        let id = Some(window_id(target));
        let input_continues = self.current_request().bool_true("input_continues");
        let mut phase_clock = now_ms();
        let mut phases = obj! {};
        let mut mark = |name: &str, phases: &mut Obj| {
            let now = now_ms();
            phases.insert(name.into(), json!(now - phase_clock));
            phase_clock = now;
        };
        self.assert_continue()?;
        // The watchdog takes a moment to start; it runs alongside activation
        // and the focus settle instead of after them, and a refused action
        // drops it unused (input-guard.ps1:114-118).
        theme.held_before = self.desktop.cursor_theme_reserve()?;
        let focused = self.desktop.focus(target);
        if !focused && !pointer_may_activate {
            // The refusal names the Windows cause there (input-guard.ps1:137).
            let refused = if self.desktop.name() == "windows" {
                "Windows foreground lock prevented target activation; no input was sent"
            } else {
                "the target window could not be activated; no input was sent"
            };
            return Ok(self.action_result(
                action,
                "foreground",
                "suspected_noop",
                false,
                refused,
                Some("foreground_unavailable"),
                "foreground",
                id,
            ));
        }
        if focused && previous != target {
            sleep_ms(120);
        }
        if focused && !self.target_or_owned_in_front(target) {
            return Ok(self.action_result(
                action,
                "foreground",
                "suspected_noop",
                false,
                "foreground changed before input dispatch; no input was sent",
                Some("foreground_changed"),
                "foreground",
                id,
            ));
        }
        // Held to the foreground only once it has it. A pointer gesture that
        // activates its own target (the Windows foreground lock and macOS
        // refuse activation to a process that is not frontmost, so the click
        // is the only way forward) may start while the window that kept the
        // foreground still holds it (input-guard.ps1:147-150).
        self.dispatch.set(Some(Dispatch {
            target,
            ready: focused,
            holder: (!focused).then(|| self.desktop.foreground()),
        }));
        mark("activation_ms", &mut phases);
        self.assert_continue()?;
        self.authorize_current(target)?;
        self.theme_acquire(theme, action)?;
        self.assert_continue()?;
        mark("cursor_theme_ms", &mut phases);
        let mut cursor_feedback = obj! { "system_theme_applied" => theme.applied, "system_theme_restored" => false, "pointer_moved" => false };
        if matches!(action, "key" | "type" | "key_down" | "key_up") {
            let masked = self
                .desktop
                .accessibility()
                .is_none_or(|a11y| a11y.focused_masked());
            cursor_feedback.insert("focus_masked".into(), json!(masked));
        }
        let before = self.desktop.cursor();
        self.assert_continue()?;
        body()?;
        theme.body_completed = true;
        mark("dispatch_ms", &mut phases);
        let after = self.desktop.cursor();
        cursor_feedback.insert("pointer_moved".into(), json!(before != after));
        self.mark_own();
        if !input_continues {
            sleep_ms(240);
        }
        mark("settle_ms", &mut phases);
        let current = self.desktop.foreground();
        self.session(|session| {
            if current != previous && current != 0 {
                session.last_focus = current;
            } else if current == target {
                session.last_focus = target;
            }
        });
        let path = if focused {
            "foreground_sendinput"
        } else {
            "foreground_pointer_activation"
        };
        let mut result = self.action_result(action, path, "unverifiable", false, &format!("{action} input dispatched; inspect the fresh capture before treating it as complete"), None, "foreground", id);
        result.insert(
            "injection_tick".into(),
            json!(self.observer.read().own_tick),
        );
        result.insert("cursor_feedback".into(), Value::Object(cursor_feedback));
        result.insert("foreground_phase_ms".into(), Value::Object(phases));
        Ok(result)
    }
}

/// Pointer modifiers as the host names them: "ctrl+shift".
pub fn parse_modifiers(value: &str) -> Res<Vec<Mod>> {
    let mut modifiers = Vec::new();
    for part in value.to_lowercase().split('+') {
        let modifier = match part.trim() {
            "" => continue,
            "ctrl" | "control" => Mod::Ctrl,
            "shift" => Mod::Shift,
            "alt" | "option" => Mod::Alt,
            "win" | "super" | "cmd" | "command" | "meta" => Mod::Super,
            other => {
                return Err(format!(
                    "unknown modifier: {other} (use ctrl, shift, alt, {})",
                    super_name()
                ))
            }
        };
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }
    Ok(modifiers)
}

fn super_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "super"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    type Log = Rc<RefCell<Vec<String>>>;

    struct Posts(Log);

    impl Posts {
        fn note(&self, what: &str) -> Result<String, String> {
            self.0.borrow_mut().push(what.into());
            Ok("fake".into())
        }
    }

    impl platform::Background for Posts {
        fn validate(&self, _: Wid, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn pointer(&self, _: Wid, _: i32, _: i32, kind: &str, _: &[Mod]) -> Result<String, String> {
            self.note(kind)
        }
        fn wheel(
            &self,
            _: Wid,
            _: i32,
            _: i32,
            _: i32,
            _: bool,
            _: &[Mod],
        ) -> Result<String, String> {
            self.note("wheel")
        }
        fn drag(&self, _: Wid, _: &[(i32, i32)], _: &[Mod]) -> Result<String, String> {
            self.note("drag")
        }
        fn keys(&self, _: Wid, _: &str) -> Result<String, String> {
            self.note("keys")
        }
        fn text(&self, _: Wid, _: &str) -> Result<String, String> {
            self.note("text")
        }
    }

    struct Menus(Log);

    impl crate::a11y::Accessibility for Menus {
        fn available(&self) -> Result<(), String> {
            Ok(())
        }
        fn snapshot(
            &self,
            _: &WindowInfo,
            _: bool,
            _: usize,
        ) -> Result<Vec<crate::a11y::Node>, String> {
            Err("fake".into())
        }
        fn focused_masked(&self) -> bool {
            false
        }
        fn invoke_menu(
            &self,
            _: &WindowInfo,
            _: &[String],
            _: &dyn Fn() -> Result<(), String>,
        ) -> Result<crate::a11y::MenuOutcome, String> {
            self.0.borrow_mut().push("menu".into());
            Ok(crate::a11y::MenuOutcome {
                path: "menu",
                verified: false,
                message: "fake".into(),
            })
        }
    }

    /// A button living in `window`, pressable unless it is only a surface.
    struct Button1 {
        window: Wid,
        log: Log,
        pressable: bool,
    }

    impl crate::a11y::Element for Button1 {
        fn identity(&self) -> String {
            "button".into()
        }
        fn window(&self) -> Wid {
            self.window
        }
        fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
            Some((0.0, 0.0, 10.0, 10.0))
        }
        fn enabled(&self) -> bool {
            true
        }
        fn alive(&self) -> bool {
            true
        }
        fn press(&self) -> Result<(), String> {
            self.log.borrow_mut().push("press".into());
            Ok(())
        }
        fn can_press(&self) -> bool {
            self.pressable
        }
        fn toggle_state(&self) -> Option<String> {
            None
        }
        fn expand_state(&self) -> Option<String> {
            None
        }
        fn set_expanded(&self, _: bool) -> Result<(), String> {
            Err("fake".into())
        }
        fn value(&self) -> Option<String> {
            None
        }
        fn settable(&self) -> bool {
            false
        }
        fn set_value(&self, _: &str) -> Result<(), String> {
            Err("fake".into())
        }
        fn can_select(&self) -> bool {
            false
        }
        fn select(&self) -> Result<(), String> {
            Err("fake".into())
        }
        fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
            Ok(None)
        }
        fn structure(&self) -> Obj {
            Obj::new()
        }
    }

    /// What a scripted desktop does once its log reaches a length.
    #[derive(Clone, Copy)]
    enum Trip {
        /// The person touches the mouse or keyboard.
        UserInput,
        /// This window takes the foreground.
        Foreground(Wid),
    }

    /// How the fake desktop behaves. The default refuses activation and
    /// rejects every input.
    #[derive(Default)]
    struct Script {
        foreground: Cell<Wid>,
        /// Input is delivered and logged instead of rejected.
        live: Cell<bool>,
        /// `focus` gives the window the foreground.
        activates: Cell<bool>,
        cursor: Cell<(i32, i32)>,
        /// Pointer placement allows no miss, as on Windows.
        exact_cursor: Cell<bool>,
        /// The window that runs above this host's integrity.
        elevated: Cell<Wid>,
        /// What a button release fails with.
        release_error: Cell<Option<&'static str>>,
        /// What a button press fails with.
        press_error: Cell<Option<&'static str>>,
        /// The platform the desktop names; "fake" when unset.
        name: Cell<&'static str>,
        /// Windows 1-3 belong to process 100 * n instead of an unknown one.
        pids: Cell<bool>,
        trip: Cell<Option<(usize, Trip)>>,
        /// The desktop keeps a cursor theme (otherwise the platform default: none).
        themes: Cell<bool>,
        /// Every theme call, in order.
        theme_log: RefCell<Vec<String>>,
        /// The held theme, and whether it blanks the cursors.
        theme_held: Cell<Option<bool>>,
        /// What ending the theme fails with.
        theme_end_error: Cell<Option<&'static str>>,
        /// The watchdog refuses the lease, after the person touched the
        /// input when this is true.
        theme_refused: Cell<Option<bool>>,
    }

    /// Windows 1 (owner), 2 (owned by 1) and 3 (unrelated); point (50, 50)
    /// lies inside window 2, point (90, 90) inside window 3.
    struct Fake {
        script: Rc<Script>,
        posts: Posts,
        menus: Menus,
        /// While set, looking a window up records foreign input.
        armed: Rc<Cell<bool>>,
        shared: std::sync::Arc<crate::observer::Shared>,
    }

    impl Fake {
        /// Logs what the desktop did, then runs the scripted trip when due.
        fn note(&self, what: &str) {
            let length = {
                let mut log = self.posts.0.borrow_mut();
                log.push(what.into());
                log.len()
            };
            match self.script.trip.get() {
                Some((at, Trip::UserInput)) if at == length => self.shared.record(false),
                Some((at, Trip::Foreground(window))) if at == length => {
                    self.script.foreground.set(window)
                }
                _ => {}
            }
        }

        fn deliver(&self, what: &str) -> Result<(), String> {
            if !self.script.live.get() {
                return Err("fake".into());
            }
            self.note(what);
            Ok(())
        }
    }

    impl Desktop for Fake {
        fn name(&self) -> &'static str {
            match self.script.name.get() {
                "" => "fake",
                name => name,
            }
        }
        fn windows(&self) -> Result<Vec<WindowInfo>, String> {
            Ok([1, 2, 3].iter().filter_map(|w| self.info(*w)).collect())
        }
        fn info(&self, handle: Wid) -> Option<WindowInfo> {
            if self.armed.get() {
                self.shared.record(false);
            }
            [1, 2, 3].contains(&handle).then(|| WindowInfo {
                handle,
                title: format!("window {handle}"),
                ..Default::default()
            })
        }
        fn foreground(&self) -> Wid {
            self.script.foreground.get()
        }
        fn pid_of(&self, handle: Wid) -> u32 {
            if self.script.pids.get() && [1, 2, 3].contains(&handle) {
                handle as u32 * 100
            } else {
                0
            }
        }
        fn focus(&self, handle: Wid) -> bool {
            let activates = self.script.activates.get();
            if activates {
                self.script.foreground.set(handle);
            }
            self.note("focus");
            activates
        }
        fn integrity(&self, handle: Wid) -> Option<platform::Integrity> {
            (handle != 0 && handle == self.script.elevated.get()).then_some(platform::Integrity {
                own_rid: 0x2000,
                target_rid: 0x3000,
                own_name: "Medium",
                target_name: "High",
            })
        }
        fn cursor_tolerance(&self) -> i32 {
            if self.script.exact_cursor.get() {
                0
            } else {
                1
            }
        }
        fn window_at_point(&self, x: i32, y: i32) -> Wid {
            match (x, y) {
                (50, 50) => 2,
                (90, 90) => 3,
                _ => 0,
            }
        }
        fn related_windows(&self, _: Wid) -> Vec<Wid> {
            Vec::new()
        }
        fn is_owned_by(&self, candidate: Wid, owner: Wid) -> bool {
            (candidate, owner) == (2, 1)
        }
        fn move_window(&self, _: Wid, _: i32, _: i32, _: i32, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn set_window_state(&self, _: Wid, _: platform::WinState) -> Result<(), String> {
            Err("fake".into())
        }
        fn close_window(&self, _: Wid) -> Result<bool, String> {
            Err("fake".into())
        }
        fn is_responding(&self, _: Wid) -> bool {
            true
        }
        fn cursor(&self) -> (i32, i32) {
            self.script.cursor.get()
        }
        fn move_pointer(&self, x: i32, y: i32) -> Result<(), String> {
            self.deliver("move")?;
            self.script.cursor.set((x, y));
            Ok(())
        }
        fn button(&self, _: Button, down: bool, _: i32, _: i32, _: u32) -> Result<(), String> {
            match (self.script.release_error.get(), self.script.press_error.get()) {
                (Some(error), _) if !down => Err(error.into()),
                (_, Some(error)) if down => Err(error.into()),
                _ => self.deliver(if down { "down" } else { "up" }),
            }
        }
        fn drag_move(&self, x: i32, y: i32) -> Result<(), String> {
            self.deliver("drag")?;
            self.script.cursor.set((x, y));
            Ok(())
        }
        fn wheel(&self, _: i32, _: i32, _: i32, _: bool) -> Result<(), String> {
            self.deliver("wheel")
        }
        fn key(&self, _: crate::keys::Key, _: bool) -> Result<(), String> {
            self.deliver("key")
        }
        fn text(&self, text: &str) -> Result<(), String> {
            self.deliver(&format!("text:{text}"))
        }
        fn input_held(&self) -> bool {
            false
        }
        fn background(&self) -> Option<&dyn platform::Background> {
            Some(&self.posts)
        }
        fn accessibility(&self) -> Option<&dyn crate::a11y::Accessibility> {
            Some(&self.menus)
        }
        fn clipboard_read(&self) -> Result<String, String> {
            Err("fake".into())
        }
        fn clipboard_write(&self, _: &str) -> Result<bool, String> {
            Err("fake".into())
        }
        fn launch(
            &self,
            _: &str,
            _: Option<&platform::AppEntry>,
        ) -> Result<platform::Launched, String> {
            Err("fake".into())
        }
        fn installed_apps(&self) -> Result<Vec<platform::AppEntry>, String> {
            Err("fake".into())
        }
        fn ocr(&self, _: &[u8], _: &str, _: usize) -> Result<Value, String> {
            Err("fake".into())
        }
        fn ocr_status(&self, _: &str) -> Value {
            Value::Null
        }
        fn cursor_theme_reserve(&self) -> Result<bool, String> {
            if !self.script.themes.get() {
                return Ok(false);
            }
            self.script.theme_log.borrow_mut().push("reserve".into());
            Ok(self.script.theme_held.get().is_some())
        }
        fn cursor_theme_begin(&self, decorate: bool) -> Result<bool, String> {
            if !self.script.themes.get() {
                return Ok(false);
            }
            self.script.theme_log.borrow_mut().push(format!("begin:{decorate}"));
            if let Some(touched) = self.script.theme_refused.get() {
                if touched {
                    self.shared.record(false);
                }
                return Err("computer_cursor_unavailable: theme activation was not confirmed; no input sent".into());
            }
            let held = self.script.theme_held.get().unwrap_or(decorate);
            self.script.theme_held.set(Some(held));
            Ok(held)
        }
        fn cursor_theme_end(&self) -> Result<bool, String> {
            if !self.script.themes.get() {
                return Ok(false);
            }
            self.script.theme_log.borrow_mut().push("end".into());
            if let Some(error) = self.script.theme_end_error.get() {
                return Err(error.into());
            }
            Ok(self.script.theme_held.take().is_some())
        }
    }

    /// A host whose observer is ready and saw foreign input just now when
    /// `user_active`, and cannot observe input at all otherwise.
    fn setup(foreground: Wid, user_active: bool) -> (Host, Log) {
        build(foreground, user_active, Rc::new(Cell::new(false)))
    }

    fn build(foreground: Wid, user_active: bool, armed: Rc<Cell<bool>>) -> (Host, Log) {
        let (host, log, _) = scripted(foreground, armed);
        if user_active {
            host.observer.shared.set_ready(true);
            host.observer.shared.record(false);
        }
        (host, log)
    }

    /// A host on a desktop that activates windows and delivers input, with an
    /// observer that is ready and has seen nobody.
    fn live(foreground: Wid) -> (Host, Log, Rc<Script>) {
        let (host, log, script) = scripted(foreground, Rc::new(Cell::new(false)));
        script.live.set(true);
        script.activates.set(true);
        host.observer.shared.set_ready(true);
        (host, log, script)
    }

    fn scripted(foreground: Wid, armed: Rc<Cell<bool>>) -> (Host, Log, Rc<Script>) {
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        let observer = Observer::new();
        let script = Rc::new(Script::default());
        script.foreground.set(foreground);
        let desktop = Fake {
            script: script.clone(),
            posts: Posts(log.clone()),
            menus: Menus(log.clone()),
            armed,
            shared: observer.shared.clone(),
        };
        let host = Host::new(
            Config {
                read_actions: Default::default(),
                retain_ref_actions: Default::default(),
                sequence_settle_ms: 0,
                max_foreground_text: 4000,
                input_marker: 0,
            },
            Box::new(desktop),
            observer,
            Box::new(crate::lease_api::NoLease),
        );
        (host, log, script)
    }

    fn type_request(text: &str) -> Req {
        Req(json!({
            "action": "type", "delivery": "foreground", "window_id": "hwnd:0x3", "text": text,
        }))
    }

    fn add_ref(host: &Host, log: &Log, window: Wid) {
        add_element(host, log, window, true);
    }

    fn add_element(host: &Host, log: &Log, window: Wid, pressable: bool) {
        host.session(|session| {
            session.refs.insert(
                "r1".into(),
                crate::session::RefRecord {
                    element: Rc::new(Button1 {
                        window,
                        log: log.clone(),
                        pressable,
                    }),
                    window_id: window_id(window),
                    generation: session.generation,
                    identity: "button".into(),
                    role: "Button".into(),
                    name: String::new(),
                    automation_id: String::new(),
                    bounds: Some((0.0, 0.0, 10.0, 10.0)),
                    source: "",
                },
            );
        });
    }

    fn run(host: &Host, request: Value) -> Obj {
        host.handle(&Req(request)).expect("action result")
    }

    fn code(result: &Obj) -> Option<&str> {
        result.get("code").and_then(Value::as_str)
    }

    #[test]
    fn stale_observation_refuses_foreground_input_without_waiting() {
        let (host, log) = setup(3, true);
        let observed = host.observer.read();
        // The user touches the keyboard after the capture.
        host.observer.shared.record(false);
        let request = Req(json!({
            "action": "click", "delivery": "foreground", "window_id": "hwnd:0x3",
            "x": 90, "y": 90,
            "observed_input_monitor_id": observed.generation,
            "observed_input_user_sequence": observed.sequence,
        }));
        // Refused at admission (`Scope::begin_expected`), before
        // `dispatch_action`, the only caller of every `sleep_ms` wait. Had the
        // action started, the fake desktop would have failed the first input
        // with `input_delivery_failed`, or the scope would have reported the
        // mid-action "interrupted this action" message instead.
        let error = host.handle(&request).unwrap_err();
        assert_eq!(
            error,
            "user_input_active: observation was superseded by external input"
        );
        assert!(log.borrow().is_empty());
    }

    fn focus_request(observed: Option<&crate::observer::Snapshot>) -> Req {
        let mut request = json!({ "action": "focus_window", "window_id": "hwnd:0x3" });
        if let Some(observed) = observed {
            request["observed_input_monitor_id"] = json!(observed.generation);
            request["observed_input_user_sequence"] = json!(observed.sequence);
        }
        Req(request)
    }

    #[test]
    fn focus_with_a_stale_observation_activates_nothing() {
        let (host, log) = setup(1, true);
        let observed = host.observer.read();
        host.observer.shared.record(false);
        let error = host.handle(&focus_request(Some(&observed))).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        assert!(log.borrow().is_empty());
        // The delivery field does not exempt it.
        let mut request = focus_request(Some(&observed));
        request.0["delivery"] = json!("background");
        let error = host.handle(&request).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        assert!(log.borrow().is_empty());
    }

    #[test]
    fn focus_interrupted_before_activation_activates_nothing() {
        let armed = Rc::new(Cell::new(false));
        let (host, log) = build(1, true, armed.clone());
        let observed = host.observer.read();
        // Admitted on a current token; input arrives while the window resolves.
        armed.set(true);
        let error = host.handle(&focus_request(Some(&observed))).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        assert!(log.borrow().is_empty());
        // Without input in between, the same request reaches the activation.
        armed.set(false);
        let observed = host.observer.read();
        host.handle(&focus_request(Some(&observed))).unwrap();
        assert_eq!(*log.borrow(), ["focus"]);
    }

    #[test]
    fn typing_stops_at_the_next_glyph_once_the_person_touches_the_input() {
        let (host, log, script) = live(3);
        // The activation, then three glyphs: the person moves the mouse.
        script.trip.set(Some((4, Trip::UserInput)));
        let error = host.handle(&type_request("abcdef")).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        assert_eq!(*log.borrow(), ["focus", "text:a", "text:b", "text:c"]);
    }

    #[test]
    fn typing_stops_at_the_next_glyph_once_the_target_loses_the_foreground() {
        let (host, log, script) = live(3);
        script.trip.set(Some((3, Trip::Foreground(2))));
        let error = host.handle(&type_request("abcdef")).unwrap_err();
        assert!(error.starts_with("foreground_changed"), "{error}");
        assert_eq!(*log.borrow(), ["focus", "text:a", "text:b"]);
        // A key stream's literal text is typed under the same guard.
        let (host, log, script) = live(3);
        script.trip.set(Some((2, Trip::Foreground(2))));
        let keys = Req(json!({
            "action": "key", "delivery": "foreground", "window_id": "hwnd:0x3", "keys": "abc",
        }));
        let error = host.handle(&keys).unwrap_err();
        assert!(error.starts_with("foreground_changed"), "{error}");
        assert_eq!(*log.borrow(), ["focus", "text:a"]);
    }

    /// A foreground click at (90, 90) in window 3, as the pointer actions run it.
    fn click_window_3(host: &Host) -> Res<Obj> {
        let mut body = || {
            host.glide(3, 90, 90)?;
            host.fg_click(Button::Left, 90, 90, 1)
        };
        host.foreground_input(3, "click", true, &mut body)
    }

    /// A click in window 3 as the request `request` describes it, with the
    /// overlay presenting the arrow when `overlay`.
    fn themed_click(host: &Host, overlay: bool, request: Value) -> Res<Obj> {
        host.feedback.borrow_mut().enabled = overlay;
        *host.request.borrow_mut() = Req(request);
        click_window_3(host)
    }

    fn themed(foreground: Wid) -> (Host, Rc<Script>) {
        let (host, _, script) = live(foreground);
        script.themes.set(true);
        (host, script)
    }

    #[test]
    fn no_theme_decorates_without_an_overlay_that_draws_the_arrow() {
        let (host, script) = themed(3);
        let clicked = themed_click(&host, false, json!({ "action": "click", "delivery": "foreground" })).unwrap();
        assert_eq!(*script.theme_log.borrow(), ["reserve", "begin:false", "end"]);
        let feedback = clicked.get("cursor_feedback").expect("the cursor feedback");
        assert_eq!(feedback.get("system_theme_applied"), Some(&json!(false)));
        assert_eq!(feedback.get("system_theme_restored"), Some(&json!(false)));
        assert_eq!(script.theme_held.get(), None);
    }

    #[test]
    fn an_overlay_hides_the_cursor_for_a_pointer_action_and_hands_it_back() {
        let (host, script) = themed(3);
        let clicked = themed_click(&host, true, json!({ "action": "click", "delivery": "foreground" })).unwrap();
        assert_eq!(*script.theme_log.borrow(), ["reserve", "begin:true", "end"]);
        let feedback = clicked.get("cursor_feedback").expect("the cursor feedback");
        assert_eq!(feedback.get("system_theme_applied"), Some(&json!(true)));
        assert_eq!(feedback.get("system_theme_restored"), Some(&json!(true)));
        assert_eq!(script.theme_held.get(), None);
        assert!(clicked.contains_key("foreground_phase_ms"));
    }

    #[test]
    fn a_key_action_takes_a_quiet_lease_unless_a_sequence_continues_into_pointer_input() {
        let (host, script) = themed(3);
        host.feedback.borrow_mut().enabled = true;
        *host.request.borrow_mut() = Req(json!({ "action": "key", "delivery": "foreground" }));
        let mut run = cursor::ThemeRun::default();
        host.theme_acquire(&mut run, "key").unwrap();
        assert_eq!(*script.theme_log.borrow(), ["begin:false"]);
        script.theme_held.set(None);
        script.theme_log.borrow_mut().clear();
        *host.request.borrow_mut() = Req(json!({ "action": "key", "delivery": "foreground", "input_continues": true }));
        host.theme_acquire(&mut run, "key").unwrap();
        assert_eq!(*script.theme_log.borrow(), ["begin:true"]);
    }

    #[test]
    fn a_sequence_and_a_held_pointer_keep_the_theme_and_the_next_action_reuses_it() {
        let (host, script) = themed(3);
        let first = json!({ "action": "click", "delivery": "foreground", "input_continues": true });
        let clicked = themed_click(&host, true, first).unwrap();
        assert_eq!(script.theme_held.get(), Some(true), "kept for the next step");
        assert_eq!(clicked["cursor_feedback"]["system_theme_restored"], json!(false));
        // The next step finds the lease held, and ends it as the last step.
        let last = themed_click(&host, true, json!({ "action": "click", "delivery": "foreground" })).unwrap();
        assert_eq!(*script.theme_log.borrow(), ["reserve", "begin:true", "reserve", "begin:true", "end"]);
        assert_eq!(last["cursor_feedback"]["system_theme_restored"], json!(true));
        assert_eq!(script.theme_held.get(), None);
        // hold_pointer keeps a decorated lease the same way; release_cursor_theme ends it.
        let held = themed_click(&host, true, json!({ "action": "mouse_down", "delivery": "foreground", "hold_pointer": true })).unwrap();
        assert_eq!(held["cursor_feedback"]["system_theme_restored"], json!(false));
        assert_eq!(script.theme_held.get(), Some(true));
        let released = run(&host, json!({ "action": "release_cursor_theme" }));
        assert_eq!(released.get("system_theme_restored"), Some(&json!(true)));
        assert_eq!(script.theme_held.get(), None);
    }

    #[test]
    fn a_refusal_before_any_input_hands_the_theme_straight_back() {
        let (host, script) = themed(1);
        script.elevated.set(1);
        // The elevated holder refuses before the reservation is made.
        let refused = host.foreground_input(3, "click", false, &mut || Ok(())).unwrap();
        assert_eq!(code(&refused), Some("foreground_unavailable"));
        assert!(script.theme_log.borrow().is_empty());
        // A refused activation, after the reservation, drops it unused.
        script.elevated.set(0);
        script.activates.set(false);
        let refused = host.foreground_input(3, "click", false, &mut || Ok(())).unwrap();
        assert_eq!(code(&refused), Some("foreground_unavailable"));
        assert_eq!(*script.theme_log.borrow(), ["reserve", "end"]);
    }

    #[test]
    fn a_lease_the_persons_input_stopped_names_that_input_and_not_the_theme() {
        let (host, script) = themed(3);
        let click = json!({ "action": "click", "delivery": "foreground" });
        script.theme_refused.set(Some(false));
        let refused = themed_click(&host, true, click.clone()).unwrap_err();
        assert!(refused.starts_with("computer_cursor_unavailable:"), "{refused}");
        script.theme_refused.set(Some(true));
        let refused = themed_click(&host, true, click).unwrap_err();
        assert!(refused.starts_with("user_input_active:"), "{refused}");
    }

    #[test]
    fn a_restoration_the_watchdog_did_not_confirm_fails_the_action() {
        let (host, script) = themed(3);
        script.theme_end_error.set(Some("input_cleanup_unconfirmed: cursor watchdog did not confirm restoration"));
        let error = themed_click(&host, true, json!({ "action": "click", "delivery": "foreground" })).unwrap_err();
        assert_eq!(error, "input_cleanup_unconfirmed: cursor watchdog did not confirm restoration");
    }

    #[test]
    fn releasing_a_session_lets_go_of_input_and_then_the_theme() {
        let (host, script) = themed(3);
        script.theme_held.set(Some(true));
        let released = run(&host, json!({ "action": "release_session" }));
        assert_eq!(released.get("text"), Some(&json!("computer session released")));
        assert_eq!(*script.theme_log.borrow(), ["end"]);
        assert_eq!(script.theme_held.get(), None);
        script.theme_held.set(Some(true));
        script.theme_end_error.set(Some("input_cleanup_unconfirmed: cursor watchdog did not confirm restoration"));
        let failed = host.handle(&Req(json!({ "action": "release_session" }))).unwrap_err();
        assert!(failed.starts_with("input_cleanup_unconfirmed"), "{failed}");
    }

    #[test]
    fn a_pending_pointer_activation_holds_only_for_the_window_that_kept_the_foreground() {
        // Window 1 keeps the foreground: the click itself activates window 3.
        let (host, log, script) = live(1);
        script.activates.set(false);
        let clicked = click_window_3(&host).unwrap();
        assert_eq!(clicked.get("path"), Some(&json!("foreground_pointer_activation")));
        assert_eq!(log.borrow()[log.borrow().len() - 2..], ["down", "up"]);
        assert!(host.dispatch.get().is_none());
        // A third window comes forward between two glide steps.
        let (host, log, script) = live(1);
        script.activates.set(false);
        script.trip.set(Some((3, Trip::Foreground(2))));
        let error = click_window_3(&host).unwrap_err();
        assert!(error.starts_with("foreground_changed"), "{error}");
        assert_eq!(*log.borrow(), ["focus", "move", "move"]);
        // The drag check refuses it too, and accepts the holder and the target.
        let pending = |holder| {
            host.dispatch.set(Some(Dispatch { target: 3, ready: false, holder: Some(holder) }));
            host.assert_drag_target(3, 90, 90)
        };
        assert_eq!(
            pending(1).unwrap_err(),
            "target_mismatch|drag target changed; observe fresh state before retrying"
        );
        assert_eq!(pending(2), Ok(()));
        script.foreground.set(3);
        assert_eq!(pending(1), Ok(()));
    }

    #[test]
    fn an_elevated_foreground_window_refuses_before_anything_moves() {
        let (host, log, script) = live(1);
        script.elevated.set(1);
        let text = "the foreground belongs to 'window 1', which runs at High integrity above this host (Medium); Windows lets a lower process neither take the foreground from it nor type into it, so no input was sent. Ask the user to switch away from that window.";
        let typed = host.handle(&type_request("a")).unwrap();
        assert_eq!(code(&typed), Some("foreground_unavailable"));
        assert_eq!(typed.get("text"), Some(&json!(text)));
        assert_eq!(typed.get("window_id"), Some(&json!(window_id(3))));
        assert_eq!(typed.get("restore_point"), None);
        let clicked = click_window_3(&host).unwrap();
        assert_eq!(code(&clicked), Some("foreground_unavailable"));
        let focused = host.handle(&focus_request(None)).unwrap();
        assert_eq!(code(&focused), Some("foreground_unavailable"));
        assert_eq!(focused.get("action"), Some(&json!("focus_window")));
        assert_eq!(focused.get("text"), Some(&json!(text)));
        assert!(log.borrow().is_empty());
        // The elevated window as the target itself is not refused here.
        script.elevated.set(3);
        assert_eq!(code(&host.handle(&focus_request(None)).unwrap()), None);
    }

    #[test]
    fn a_window_the_target_owns_holds_the_foreground_for_it_once_it_is_in_front() {
        let owned = |window: Wid| window == 9;
        let ready = Dispatch { target: 3, ready: true, holder: None };
        assert!(ready.holds(3, owned));
        assert!(ready.holds(9, owned), "a dialog the target owns");
        assert!(!ready.holds(2, owned), "any other window stops the input");
        let pending = Dispatch { target: 3, ready: false, holder: Some(1) };
        assert!(!pending.holds(9, owned), "the pending activation keeps its holder");
        // An owned window of another process (or of an unknown one) is not the target's.
        let (host, _, script) = live(1);
        assert!(!host.owned_by_target(2, 1), "no process known");
        script.pids.set(true);
        assert!(!host.owned_by_target(2, 1), "window 2 runs in another process than window 1");
    }

    #[test]
    fn focus_is_confirmed_only_when_the_target_keeps_the_foreground() {
        let (host, log, script) = live(1);
        // Another window takes the foreground while the focus settles.
        script.trip.set(Some((1, Trip::Foreground(2))));
        let moved = host.handle(&focus_request(None)).unwrap();
        assert_eq!(code(&moved), Some("foreground_changed"));
        assert_eq!(
            moved.get("text"),
            Some(&json!("the foreground moved away from window 3 before focus settled"))
        );
        assert_eq!(host.session(|session| session.last_focus), 0);
        // The person touches the input while it settles.
        script.trip.set(Some((2, Trip::UserInput)));
        let error = host.handle(&focus_request(None)).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        script.trip.set(None);
        let focused = host.handle(&focus_request(None)).unwrap();
        assert_eq!(focused.get("effect"), Some(&json!("confirmed")));
        assert_eq!(host.session(|session| session.last_focus), 3);
        assert_eq!(*log.borrow(), ["focus", "focus", "focus"]);
    }

    #[test]
    fn a_refused_activation_names_the_foreground_lock_on_windows_only() {
        let (host, _, script) = live(1);
        script.activates.set(false);
        let refused = host.handle(&type_request("a")).unwrap();
        assert_eq!(code(&refused), Some("foreground_unavailable"));
        // The fake desktop is not Windows.
        assert_eq!(
            refused.get("text"),
            Some(&json!("the target window could not be activated; no input was sent"))
        );
        script.name.set("windows");
        let refused = host.handle(&type_request("a")).unwrap();
        assert_eq!(code(&refused), Some("foreground_unavailable"));
        assert_eq!(
            refused.get("text"),
            Some(&json!(
                "Windows foreground lock prevented target activation; no input was sent"
            ))
        );
    }

    #[test]
    fn the_cursor_must_reach_the_point_within_the_desktops_tolerance() {
        let (host, _, script) = live(3);
        script.cursor.set((91, 90));
        assert_eq!(host.assert_cursor_at(90, 90), Ok(()));
        script.exact_cursor.set(true);
        assert_eq!(
            host.assert_cursor_at(90, 90).unwrap_err(),
            "target_mismatch|cursor did not reach the observed point; no positive pointer input sent"
        );
        script.cursor.set((90, 90));
        assert_eq!(host.assert_cursor_at(90, 90), Ok(()));
    }

    #[test]
    fn a_press_is_refused_after_input_from_the_person_without_feedback() {
        let (host, log, _) = live(3);
        // The person moves the mouse in the pause before a drag's press.
        let mut body = || {
            host.observer.shared.record(false);
            host.fg_button(Button::Left, true, 90, 90, 1)
        };
        let error = host.foreground_input(3, "drag", true, &mut body).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        assert_eq!(*log.borrow(), ["focus"]);
    }

    #[test]
    fn input_from_the_person_before_a_drag_press_sends_no_press() {
        let (host, log, script) = live(3);
        // The glide from (0, 0) to (90, 90) is 15 moves after the focus; the
        // person moves the mouse right after the last, in the pause before
        // the press.
        script.trip.set(Some((16, Trip::UserInput)));
        let mut body = || host.fg_drag_path(3, &[(90, 90), (90, 90)], Button::Left);
        let error = host.foreground_input(3, "drag", true, &mut body).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        let log = log.borrow();
        assert_eq!(log.iter().filter(|what| *what == "move").count(), 15, "{log:?}");
        assert!(!log.iter().any(|what| what == "down"), "{log:?}");
    }

    #[test]
    fn a_failed_release_reports_as_cleanup_and_a_failed_press_as_delivery() {
        let (host, _, script) = live(3);
        let release = || host.fg_button(Button::Left, false, 90, 90, 1).unwrap_err();
        script.release_error.set(Some("fake"));
        assert_eq!(release(), "input_cleanup_unconfirmed: pointer button release failed: fake");
        let unaccepted = "input_cleanup_unconfirmed: native input release was not accepted";
        script.release_error.set(Some(unaccepted));
        assert_eq!(release(), unaccepted);
        // The whole click fails with the release's code.
        let error = host.fg_click(Button::Left, 0, 0, 1).unwrap_err();
        assert_eq!(error, unaccepted);
        // A press the platform already coded keeps its code.
        script.release_error.set(None);
        let held = "input_cleanup_unconfirmed: native input was not fully delivered";
        script.press_error.set(Some(held));
        assert_eq!(host.fg_button(Button::Left, true, 90, 90, 1).unwrap_err(), held);
        let failed = "input_delivery_failed: native input was not delivered";
        script.press_error.set(Some(failed));
        assert_eq!(host.fg_button(Button::Left, true, 90, 90, 1).unwrap_err(), failed);
        // A release never passes as a retryable delivery failure.
        script.release_error.set(Some(failed));
        assert_eq!(
            release(),
            format!("input_cleanup_unconfirmed: pointer button release failed: {failed}")
        );
        script.release_error.set(None);
        script.press_error.set(None);
        script.live.set(false);
        assert_eq!(
            host.fg_button(Button::Left, true, 90, 90, 1).unwrap_err(),
            "input_delivery_failed: pointer button was rejected: fake"
        );
    }

    #[test]
    fn input_idle_state_counts_only_input_that_reached_the_target() {
        let (host, _, script) = live(1);
        script.pids.set(true);
        let idle = |target: Option<Wid>| {
            let request = match target {
                Some(target) => json!({ "input_target_window_id": window_id(target) }),
                None => json!({}),
            };
            host.input_idle_state(&Req(request))
        };
        let state = idle(Some(3));
        for key in [
            "ready", "observer_ready", "observer_reason", "desktop_ready", "monitor", "sequence",
            "target_sequence", "idleMs", "held",
        ] {
            assert!(state.contains_key(key), "{key}");
        }
        assert_eq!(state["ready"], json!(true));
        // The person moves the mouse over another app: not input into the
        // target (ReadFor reads without the pointer scope).
        host.observer.shared.record_event(false, 0, true, &[999]);
        let state = idle(Some(3));
        assert_eq!(state["sequence"], json!(1));
        assert_eq!(state["target_sequence"], json!(0));
        // A key into the target's process is.
        host.observer.shared.record_event(false, 0, false, &[300]);
        let state = idle(Some(3));
        assert_eq!(state["target_sequence"], json!(2));
        // An unknown or absent target is reached by all input.
        host.observer.shared.record_event(false, 0, true, &[999]);
        assert_eq!(idle(None)["target_sequence"], json!(3));
        assert_eq!(idle(Some(77))["target_sequence"], json!(3));
    }

    #[test]
    fn a_first_focus_window_reports_the_restore_point() {
        let (host, _, script) = live(1);
        script.cursor.set((4, 5));
        let focused = run(&host, json!({ "action": "focus_window", "window_id": "hwnd:0x3" }));
        assert_eq!(focused.get("verified"), Some(&json!(true)), "{focused:?}");
        assert_eq!(
            focused.get("restore_point"),
            Some(&json!({
                "target_window_id": window_id(3),
                "restore_window_id": window_id(1),
                "cursor_x": 4,
                "cursor_y": 5,
            }))
        );
        let typed = host.handle(&type_request("a")).unwrap();
        assert_eq!(typed.get("restore_point"), None);
    }

    #[test]
    fn the_restore_point_is_reported_by_the_first_foreground_input_only() {
        let (host, _, script) = live(1);
        script.cursor.set((7, 9));
        let first = host.handle(&type_request("a")).unwrap();
        assert_eq!(
            first.get("restore_point"),
            Some(&json!({
                "target_window_id": window_id(3),
                "restore_window_id": window_id(1),
                "cursor_x": 7,
                "cursor_y": 9,
            }))
        );
        script.cursor.set((20, 20));
        let second = host.handle(&type_request("a")).unwrap();
        assert_eq!(second.get("restore_point"), None);
        // A released session starts over.
        run(&host, json!({ "action": "release_session" }));
        script.foreground.set(3);
        let again = host.handle(&type_request("a")).unwrap();
        assert_eq!(
            again.get("restore_point"),
            Some(&json!({
                "target_window_id": window_id(3),
                "restore_window_id": window_id(3),
                "cursor_x": 20,
                "cursor_y": 20,
            }))
        );
    }

    #[test]
    fn a_failed_first_foreground_input_still_reports_its_restore_point() {
        let (host, _, script) = live(1);
        script.trip.set(Some((2, Trip::UserInput)));
        let request = r#"{"id":7,"action":"type","delivery":"foreground","window_id":"hwnd:0x3","text":"ab"}"#;
        let reply = host.reply(request);
        assert_eq!(reply["ok"], json!(false), "{reply}");
        assert_eq!(
            reply["result"]["restore_point"],
            json!({
                "target_window_id": window_id(3),
                "restore_window_id": window_id(1),
                "cursor_x": 0,
                "cursor_y": 0,
            })
        );
        script.trip.set(None);
        let reply = host.reply(request);
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(reply["result"].get("restore_point"), None);
    }

    #[test]
    fn background_input_proceeds_while_the_user_is_active() {
        let (host, log) = setup(3, true);
        // `setup(.., true)` recorded one foreign input event: the user is active.
        assert_eq!(host.observer.read().sequence, 1);
        let click = json!({
            "action": "click", "delivery": "background", "window_id": "hwnd:0x3",
            "x": 90, "y": 90,
        });
        assert_eq!(code(&run(&host, click)), None);
        let text = json!({
            "action": "type", "delivery": "background", "window_id": "hwnd:0x3", "text": "a",
        });
        assert_eq!(code(&run(&host, text)), None);
        add_ref(&host, &log, 3);
        let invoke = json!({ "action": "invoke", "delivery": "background", "ref": "r1" });
        assert_eq!(code(&run(&host, invoke)), None);
        assert_eq!(*log.borrow(), ["click", "text", "press"]);
    }

    #[test]
    fn retain_refs_keeps_the_refs_for_a_later_step() {
        let (host, log) = setup(3, false);
        add_ref(&host, &log, 3);
        let kept = host.reply(r#"{"id":1,"action":"wait","duration":0,"retain_refs":true}"#);
        assert_eq!(kept["ok"], json!(true), "{kept}");
        assert!(host.ref_record("r1").is_ok());
        host.reply(r#"{"id":2,"action":"wait","duration":0}"#);
        let error = host.ref_record("r1").err().expect("the ref is retired");
        assert!(error.starts_with("ref r1 is stale"), "{error}");
        // Only an explicit true keeps them.
        add_ref(&host, &log, 3);
        host.reply(r#"{"id":3,"action":"wait","duration":0,"retain_refs":"false"}"#);
        assert!(host.ref_record("r1").is_err());
    }

    #[test]
    fn an_error_result_is_reported_under_result_of_a_failed_reply() {
        let (host, _) = setup(3, false);
        let cleanup = obj! { "capture_cleanup" => json!({ "status": "unconfirmed" }) };
        host.error_result.replace(Some(cleanup.clone()));
        let reply = host.reply(r#"{"id":4,"action":"no_such_action"}"#);
        assert_eq!(
            reply,
            json!({
                "id": 4,
                "ok": false,
                "error": "unknown action: no_such_action",
                "result": { "capture_cleanup": { "status": "unconfirmed" } },
            })
        );
        assert!(host.error_result.borrow().is_none());
        // A successful reply keeps its own result and drops the value.
        host.error_result.replace(Some(cleanup));
        let reply = host.reply(r#"{"id":5,"action":"wait","duration":0}"#);
        assert_eq!(reply["result"], json!({ "text": "waited 0s" }));
        assert!(host.error_result.borrow().is_none());
    }

    #[test]
    fn the_end_of_input_releases_the_theme_and_the_process_holds() {
        let (host, log, script) = scripted(3, Rc::new(Cell::new(false)));
        script.themes.set(true);
        script.live.set(true);
        host.sessions.borrow_mut().entry("other".into()).or_default().held_keys.push((
            "a".into(),
            Vec::new(),
            crate::keys::Key::Char('a'),
        ));
        host.serve_lines(stdin::Router::new(std::io::Cursor::new("")));
        assert!(script.theme_log.borrow().iter().any(|entry| entry == "end"));
        // The key held in a session that was not current was let go.
        assert!(log.borrow().iter().any(|entry| entry == "key"));
        assert!(host.sessions.borrow()["other"].held_keys.is_empty());
        assert_eq!(*host.current.borrow(), "default");
    }

    #[test]
    fn retire_after_reply_ends_the_request_loop_after_that_reply() {
        let input = concat!(
            "{\"id\":1,\"action\":\"wait\",\"duration\":0,\"session_id\":\"first\"}\n",
            "\n",
            "{\"id\":2,\"action\":\"wait\",\"duration\":0,\"session_id\":\"second\"}\n",
        );
        let (serving, _) = setup(3, false);
        serving.serve_lines(stdin::Router::new(std::io::Cursor::new(input)));
        assert!(serving.sessions.borrow().contains_key("first"));
        assert!(serving.sessions.borrow().contains_key("second"));
        let (retiring, _) = setup(3, false);
        retiring.retire_after_reply.set(true);
        retiring.serve_lines(stdin::Router::new(std::io::Cursor::new(input)));
        assert!(retiring.sessions.borrow().contains_key("first"));
        assert!(!retiring.sessions.borrow().contains_key("second"));
    }

    #[test]
    fn the_new_platform_defaults_keep_todays_behaviour() {
        let (host, log) = setup(3, false);
        let desktop = &*host.desktop;
        assert_eq!(desktop.resolve_glyph('a'), None);
        assert_eq!(
            desktop
                .window_surface_backend(3, "print_window", 1500)
                .err()
                .map(|failure| failure.text),
            desktop.window_surface(3).err()
        );
        assert_eq!(
            desktop
                .window_surface_backend(3, "wgc", 1500)
                .err()
                .map(|failure| failure.text)
                .as_deref(),
            Some(platform::UNKNOWN_CAPTURE_BACKEND)
        );
        let mut calls = 0;
        let (result, facts) = desktop.guard_semantic(3, 9, &crate::lease_api::NoLease, &mut || {
            calls += 1;
            Ok(obj! { "text" => "done" })
        });
        assert_eq!((calls, result, facts), (1, Ok(obj! { "text" => "done" }), None));
        assert_eq!(desktop.process_fate("42", ""), json!({ "state": "unknown", "created": "" }));
        assert!(desktop.saved_login().is_none());
        assert!(desktop.elevated_run(&Req(json!({}))).is_none());
        assert_eq!(desktop.cursor_theme_reserve(), Ok(false));
        assert_eq!(desktop.cursor_theme_begin(true), Ok(false));
        assert_eq!(desktop.cursor_theme_end(), Ok(false));

        let background = desktop.background().expect("the fake posts input");
        assert_eq!(background.keys_to(3, 7, "a"), Ok("fake".to_string()));
        assert_eq!(background.text_to(3, 7, "a"), Ok("fake".to_string()));
        assert_eq!(*log.borrow(), ["keys", "text"]);
        assert_eq!(background.validate_target(3, 7, "key", Some("{ENTER}")), Ok(()));
        assert_eq!(background.begin_scope(3), Ok(()));
        assert_eq!(background.end_scope(3), Ok(()));
        assert_eq!(background.hold(3), Ok(0));
        assert_eq!(background.release_hold(3), Ok(()));
        assert!(!background.is_web_content_host(3));
        let unsupported = Err(platform::NO_NATIVE_EDIT_SELECTION.to_string());
        assert_eq!(background.select_all(3, 7, true), unsupported);
        assert_eq!(background.text_end(3, 7), unsupported);
        assert_eq!(background.native_state(7, "type"), None);
        assert!(!background.take_activation_unprotected());
        assert_eq!(background.dialog_refusal(3, 0, "key", Some("{ENTER}")), None);
    }

    #[test]
    fn a_guarded_ref_click_keeps_its_native_fallback() {
        // The person is in window 1; the ref's window 3 is behind it, so the
        // semantic call runs through the desktop's activation guard.
        let (host, log) = setup(1, false);
        add_element(&host, &log, 3, true);
        let click = json!({ "action": "click", "delivery": "background", "ref": "r1" });
        let pressed = run(&host, click.clone());
        assert_eq!(pressed.get("path"), Some(&json!("a11y_invoke")));
        assert_eq!(*log.borrow(), ["press"]);
        assert!(host.activation_facts.borrow().is_none());
        // An element with no semantic action leaves the click to the native route.
        log.borrow_mut().clear();
        add_element(&host, &log, 3, false);
        let clicked = run(&host, click);
        assert_eq!(clicked.get("path"), Some(&json!(input::NATIVE_MESSAGE)), "{clicked:?}");
        assert_eq!(*log.borrow(), ["click"]);
    }

    #[test]
    fn dialog_refusals_are_preflight_refusals() {
        let (host, _) = setup(3, false);
        for code in ["focus_required", "dialog_key_unsupported"] {
            let error = format!("{code}|the dialog would discard it; no input was sent");
            let result = host.background_failure("key", &error, None, false).unwrap();
            assert_eq!(result.get("code"), Some(&json!(code)));
            assert_eq!(
                result.get("text"),
                Some(&json!("the dialog would discard it; no input was sent"))
            );
            assert_eq!(result.get("input_may_have_executed"), None);
            assert_eq!(result.get("delivery_accepted"), Some(&json!(false)));
        }
    }

    #[test]
    fn the_new_actions_answer_as_before() {
        let (host, _) = setup(3, false);
        let held = run(&host, json!({ "action": "release_sequence_holds" }));
        assert_eq!(Value::Object(held), json!({ "text": "sequence holds released", "released": 0 }));
        let theme = run(&host, json!({ "action": "release_cursor_theme" }));
        assert_eq!(
            Value::Object(theme),
            json!({ "text": "cursor theme released", "system_theme_restored": false })
        );
        let fate = run(&host, json!({ "action": "process_fate", "pid": "42", "created": "" }));
        assert_eq!(Value::Object(fate), json!({ "state": "unknown", "created": "" }));
        let refused = host
            .handle(&Req(json!({ "action": "saved_login_type", "field": "password" })))
            .unwrap_err();
        assert_eq!(refused, platform::SAVED_LOGIN_UNSUPPORTED);
        // The fake has no catalogue: list_apps answers its running windows,
        // one unnamed app, and an empty catalogue's total.
        let apps = run(&host, json!({ "action": "list_apps" }));
        let listed: Value = serde_json::from_str(apps["text"].as_str().unwrap_or_default())
            .expect("list_apps answers JSON text");
        assert_eq!(listed["apps"][0]["window_count"], json!(3));
        assert_eq!(listed["installed_total"], json!(0));
        assert_eq!(listed.get("installed"), None);
    }

    #[test]
    fn a_named_app_never_resolves_to_the_foreground_window() {
        // Window 3 is in front; the fake's windows carry only titles.
        let (host, log) = setup(3, false);
        let act = |request: Value| host.handle(&Req(request));
        // The fake's windows have no bounds, so the refusal names the target.
        assert_eq!(
            act(json!({ "action": "window_bounds", "app": "window 1" })),
            Err("window has no capturable bounds: hwnd:0x1".to_string())
        );
        let kill = act(json!({ "action": "terminate_process", "app": "window 1" }))
            .expect("a confirmation request");
        assert_eq!(kill.get("window_id"), Some(&json!("hwnd:0x1")));
        for action in ["close_window", "terminate_process", "snapshot", "window_capture"] {
            assert_eq!(
                act(json!({ "action": action, "app": "Notepad", "confirm": "terminate", "text": "a" })),
                Err("window_target_not_found: no visible window matched app \"Notepad\"".to_string()),
                "{action}"
            );
            let ambiguous = act(json!({ "action": action, "app": "window", "text": "a" })).unwrap_err();
            assert!(ambiguous.starts_with("ambiguous_window_target: app \"window\" matched 3 windows (hwnd:0x1 "), "{ambiguous}");
        }
        assert!(log.borrow().is_empty());
        // An exact window still wins over the app's name.
        let exact = act(json!({ "action": "terminate_process", "app": "Notepad", "window_id": "hwnd:0x2" }))
            .expect("a confirmation request");
        assert_eq!(exact.get("window_id"), Some(&json!("hwnd:0x2")));
    }
}
