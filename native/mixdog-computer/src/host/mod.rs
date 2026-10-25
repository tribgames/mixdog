//! The resident host: request loop, per-request guards, and the shared
//! pieces every action builds on. Actions live in the sibling modules.

mod input;
mod misc;
mod semantic;
mod windows;

use crate::config::Config;
use crate::keys::Mod;
use crate::obj;
use crate::observer::{now_ms, Observer, Scope};
use crate::platform::{self, parse_window_id, window_id, Button, Desktop, Wid, WindowInfo};
use crate::protocol::{write_line, Obj, Req, POINTER_MARKER, RESPONSE_MARKER};
use crate::session::Session;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::BufRead;
use std::time::Duration;

pub type Res<T> = Result<T, String>;

const GLIDE_WAIT_MS: u64 = 360;
const GLIDE_MIN_WAIT_MS: u64 = 140;
const GLIDE_SPEED_PX_PER_MS: f64 = 1.4;
const GLIDE_SEED_OFFSET: f64 = 140.0;

pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
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
}

pub fn run() {
    let cfg = Config::from_env();
    let observer = Observer::new();
    let desktop = platform::create(observer.shared.clone(), cfg.input_marker);
    let host = Host {
        cfg,
        desktop,
        observer,
        sessions: RefCell::new(HashMap::new()),
        current: RefCell::new("default".into()),
        request: RefCell::new(Req(Value::Null)),
        scope: RefCell::new(Scope::default()),
        dispatch: Cell::new(None),
        feedback: RefCell::new(Feedback::default()),
    };
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        host.serve(&line);
    }
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
    fn serve(&self, line: &str) {
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
        let outcome = match &req {
            Some(req) => {
                let result = self.handle(req);
                self.feedback.borrow_mut().enabled = false;
                self.invalidate_refs_for(req);
                result
            }
            None => Err("invalid request: expected one JSON object".to_string()),
        };
        let mut envelope = obj! { "id" => id };
        match outcome {
            Ok(result) => {
                envelope.insert("ok".into(), json!(true));
                envelope.insert("result".into(), Value::Object(result));
            }
            Err(error) => {
                envelope.insert("ok".into(), json!(false));
                envelope.insert("error".into(), json!(error));
            }
        }
        if wants_feedback {
            let feedback = self.feedback.borrow();
            envelope.insert(
                "pointer_feedback".into(),
                json!({ "generated": feedback.generated, "failed": feedback.failed }),
            );
        }
        write_line(RESPONSE_MARKER, &Value::Object(envelope));
    }

    fn invalidate_refs_for(&self, req: &Req) {
        if !self.cfg.retain_ref_actions.contains(&req.action()) {
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
            let mut scope = self.scope.borrow_mut();
            match (
                req.str("observed_input_monitor_id"),
                req.int("observed_input_user_sequence"),
            ) {
                (Some(generation), Some(sequence)) => {
                    scope.begin_expected(&self.observer, &generation, sequence)?
                }
                _ => scope.begin(&self.observer)?,
            }
        }
        let result = self.dispatch_action(&action, req);
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
            "input_idle_state" => Ok(self.input_idle_state()),
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
            "release_session" => self.release_session(),
            "release_held_input" => self.release_held_input(),
            // This host keeps no no-activate hold across sequence steps.
            "release_sequence_holds" => {
                Ok(obj! { "text" => "sequence holds released", "released" => 0 })
            }
            "release_cursor_theme" => {
                Ok(obj! { "text" => "cursor theme released", "system_theme_restored" => false })
            }
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
        self.resolve_window_parts(
            req.str("window").as_deref(),
            req.str("window_id").as_deref(),
        )
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
        candidate != 0 && candidate == surface
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
        Ok(self.background_unavailable(
            action,
            &detail,
            window,
            code,
            prior_input || code != "background_unsupported",
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
        let event = json!({ "id": feedback.id, "x": x, "y": y, "held": held, "phase": phase });
        drop(feedback);
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
            if dispatch.ready && self.desktop.foreground() != dispatch.target {
                return Err(
                    "foreground_changed: target lost foreground before input dispatch".into(),
                );
            }
        }
        self.scope.borrow().assert_continue(&self.observer)
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
        self.desktop.move_pointer(x, y).map_err(|error| {
            format!("input_delivery_failed: pointer movement was rejected: {error}")
        })
    }

    fn assert_cursor_at(&self, x: i32, y: i32) -> Res<()> {
        self.assert_continue()?;
        let (cx, cy) = self.desktop.cursor();
        if (cx - x).abs() > 1 || (cy - y).abs() > 1 {
            return Err("target_mismatch|cursor did not reach the observed point; no positive pointer input sent".into());
        }
        Ok(())
    }

    fn assert_drag_target(&self, target: Wid, x: i32, y: i32) -> Res<()> {
        let hit = self.desktop.window_at_point(x, y);
        // A target the system refused to activate (macOS grants activation to
        // the frontmost app only, never to this helper) is reached by the
        // pointer gesture itself: the hit test alone proves the press lands on
        // it, and the press is what brings it forward.
        let activated = self.dispatch.get().is_none_or(|dispatch| dispatch.ready);
        if !self.is_window(target)
            || (activated && self.desktop.foreground() != target)
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
    /// ring it last drew.
    fn fg_button(&self, button: Button, down: bool, x: i32, y: i32, clicks: u32) -> Res<()> {
        if down && self.feedback_enabled() {
            self.report_pointer(x, y, false, "prepare");
            sleep_ms(120);
            self.assert_continue()?;
        }
        self.mark_own();
        self.desktop
            .button(button, down, x, y, clicks)
            .map_err(|error| {
                format!("input_delivery_failed: pointer button was rejected: {error}")
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

    fn fg_text(&self, text: &str) -> Res<()> {
        self.assert_continue()?;
        self.mark_own();
        self.desktop.text(text)
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
        self.authorize_current(target)?;
        let previous = self.desktop.foreground();
        self.remember_focus_origin(previous, target);
        self.scope.borrow_mut().begin(&self.observer)?;
        let prior_dispatch = self.dispatch.replace(Some(Dispatch {
            target,
            ready: false,
        }));
        let outcome = self.foreground_body(target, action, pointer_may_activate, previous, body);
        self.dispatch.set(prior_dispatch);
        self.scope.borrow_mut().end();
        outcome
    }

    fn foreground_body(
        &self,
        target: Wid,
        action: &str,
        pointer_may_activate: bool,
        previous: Wid,
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
        let focused = self.desktop.focus(target);
        if !focused && !pointer_may_activate {
            return Ok(self.action_result(
                action,
                "foreground",
                "suspected_noop",
                false,
                "the target window could not be activated; no input was sent",
                Some("foreground_unavailable"),
                "foreground",
                id,
            ));
        }
        if focused && previous != target {
            sleep_ms(120);
        }
        if focused && self.desktop.foreground() != target {
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
        // activates its own target (macOS refuses activation to a process that
        // is not frontmost, so the click is the only way forward there) was
        // otherwise refused before the click that would have activated it.
        self.dispatch.set(Some(Dispatch {
            target,
            ready: focused,
        }));
        mark("activation_ms", &mut phases);
        self.assert_continue()?;
        self.authorize_current(target)?;
        mark("cursor_theme_ms", &mut phases);
        let mut cursor_feedback = obj! { "system_theme_applied" => false, "system_theme_restored" => false, "pointer_moved" => false };
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

    /// A pressable button living in `window`.
    struct Button1 {
        window: Wid,
        log: Log,
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
            true
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
        fn focus(&self) -> Result<(), String> {
            Err("fake".into())
        }
        fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
            Ok(None)
        }
        fn structure(&self) -> Obj {
            Obj::new()
        }
    }

    /// Windows 1 (owner), 2 (owned by 1) and 3 (unrelated); point (50, 50)
    /// lies inside window 2.
    struct Fake {
        foreground: Wid,
        posts: Posts,
        menus: Menus,
        /// While set, looking a window up records foreign input.
        armed: Rc<Cell<bool>>,
        shared: std::sync::Arc<crate::observer::Shared>,
    }

    impl Desktop for Fake {
        fn name(&self) -> &'static str {
            "fake"
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
            self.foreground
        }
        fn focus(&self, _: Wid) -> bool {
            self.posts.0.borrow_mut().push("focus".into());
            false
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
            (0, 0)
        }
        fn move_pointer(&self, _: i32, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn button(&self, _: Button, _: bool, _: i32, _: i32, _: u32) -> Result<(), String> {
            Err("fake".into())
        }
        fn drag_move(&self, _: i32, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn wheel(&self, _: i32, _: i32, _: i32, _: bool) -> Result<(), String> {
            Err("fake".into())
        }
        fn key(&self, _: crate::keys::Key, _: bool) -> Result<(), String> {
            Err("fake".into())
        }
        fn text(&self, _: &str) -> Result<(), String> {
            Err("fake".into())
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
    }

    /// A host whose observer is ready and saw foreign input just now when
    /// `user_active`, and cannot observe input at all otherwise.
    fn setup(foreground: Wid, user_active: bool) -> (Host, Log) {
        build(foreground, user_active, Rc::new(Cell::new(false)))
    }

    fn build(foreground: Wid, user_active: bool, armed: Rc<Cell<bool>>) -> (Host, Log) {
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        let observer = Observer::new();
        let desktop = Fake {
            foreground,
            posts: Posts(log.clone()),
            menus: Menus(log.clone()),
            armed,
            shared: observer.shared.clone(),
        };
        let host = Host {
            cfg: Config {
                read_actions: Default::default(),
                retain_ref_actions: Default::default(),
                sequence_settle_ms: 0,
                max_foreground_text: 4000,
                input_marker: 0,
            },
            desktop: Box::new(desktop),
            observer,
            sessions: RefCell::new(HashMap::new()),
            current: RefCell::new("default".into()),
            request: RefCell::new(Req(Value::Null)),
            scope: RefCell::new(Scope::default()),
            dispatch: Cell::new(None),
            feedback: RefCell::new(Feedback::default()),
        };
        if user_active {
            host.observer.shared.set_ready(true);
            host.observer.shared.record(false);
        }
        (host, log)
    }

    fn add_ref(host: &Host, log: &Log, window: Wid) {
        host.session(|session| {
            session.refs.insert(
                "r1".into(),
                crate::session::RefRecord {
                    element: Rc::new(Button1 {
                        window,
                        log: log.clone(),
                    }),
                    window_id: window_id(window),
                    generation: session.generation,
                    identity: "button".into(),
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
        let started = std::time::Instant::now();
        let error = host.handle(&request).unwrap_err();
        assert!(error.starts_with("user_input_active"), "{error}");
        assert!(started.elapsed() < Duration::from_millis(500));
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
    fn background_input_proceeds_while_the_user_is_active() {
        let (host, log) = setup(3, true);
        assert!(host.observer.foreign_idle_ms() < 1000);
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
}
