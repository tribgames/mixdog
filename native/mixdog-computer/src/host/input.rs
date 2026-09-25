//! Pointer and keyboard actions, their background and foreground routes, and
//! the recovery reads the host takes around foreground input.

use super::{parse_modifiers, sleep_ms, Host, Res};
use crate::a11y::Element;
use crate::keys::{self, Key, KeySink, Mod};
use crate::obj;
use crate::observer::now_ms;
use crate::platform::{parse_window_id, window_id, Button, Wid};
use crate::protocol::{round_half_even, Obj, Req};
use serde_json::{json, Value};
use std::rc::Rc;

/// The native path name background pixel and key input reports.
pub(super) const NATIVE_MESSAGE: &str = "native_message";

struct ForegroundKeys<'a> {
    host: &'a Host,
}

impl KeySink for ForegroundKeys<'_> {
    fn down(&mut self, key: Key) -> Result<(), String> {
        self.host.fg_key(key, true)
    }
    fn up(&mut self, key: Key) -> Result<(), String> {
        self.host.mark_own();
        self.host.desktop.key(key, false)
    }
    fn text(&mut self, text: &str) -> Result<(), String> {
        self.host.fg_text(text)
    }
}

pub(super) struct Point {
    pub x: i32,
    pub y: i32,
    pub target: Wid,
}

impl Host {
    // --- refs ----------------------------------------------------------------

    pub(super) fn ref_record(&self, reference: &str) -> Res<(Rc<dyn Element>, String)> {
        let found = self.session(|session| {
            let generation = session.generation;
            session.refs.get(reference).map(|record| {
                (record.element.clone(), record.window_id.clone(), record.generation == generation, record.identity.clone())
            })
        });
        let Some((element, window, current, identity)) = found else {
            return Err(format!("ref {reference} is stale, from another session, or unknown; take a fresh snapshot/find"));
        };
        if !current {
            return Err(format!("ref {reference} is stale; take a fresh snapshot/find"));
        }
        let owner = element.window();
        if !element.alive()
            || element.identity() != identity
            || (owner != 0 && window_id(owner) != window)
            || !self.is_window(parse_window_id(&window))
        {
            return Err(format!("ref {reference} is stale or its target changed; take a fresh snapshot/find"));
        }
        Ok((element, window))
    }

    pub(super) fn el_point(&self, reference: &str, require_topmost: bool) -> Res<Point> {
        let (element, window) = self.ref_record(reference)?;
        let (x, y, width, height) = element
            .bounds()
            .filter(|(_, _, width, height)| *width > 0.0 && *height > 0.0 && width.is_finite())
            .ok_or_else(|| format!("element {reference} has no clickable bounds"))?;
        let px = round_half_even(x + width / 2.0) as i32;
        let py = round_half_even(y + height / 2.0) as i32;
        let top = parse_window_id(&window);
        let at = self.desktop.window_at_point(px, py);
        if require_topmost && top != 0 && at != 0 && at != top && !self.is_contained(at, top) {
            return Err(format!("element {reference} is covered by another window at its click point; call focus_window first"));
        }
        Ok(Point { x: px, y: py, target: top })
    }

    fn point_arg(&self, req: &Req) -> Res<Point> {
        if let Some(reference) = req.str("ref") {
            return self.el_point(&reference, false);
        }
        let (Some(x), Some(y)) = (req.int("x"), req.int("y")) else {
            return Err(format!("{} requires ref or x/y screen coordinates", req.action()));
        };
        let (x, y) = (x as i32, y as i32);
        if req.has("window_id") || req.has("window") {
            let selected = self.resolve_window(req)?;
            let at = self.desktop.window_at_point(x, y);
            if at == selected.handle {
                return Ok(Point { x, y, target: selected.handle });
            }
            if at != 0 && self.is_contained(at, selected.handle) {
                return Ok(Point { x, y, target: at });
            }
            if at != 0 && self.desktop.is_owned_by(at, selected.handle) {
                let allowed = req.strings("allowed_window_ids");
                if allowed.iter().any(|id| parse_window_id(id) == at) {
                    return Ok(Point { x, y, target: at });
                }
            }
            if !req.delivery_foreground() {
                return Ok(Point { x, y, target: selected.handle });
            }
            return Ok(Point { x, y, target: at });
        }
        Ok(Point { x, y, target: self.desktop.window_at_point(x, y) })
    }

    // --- background ----------------------------------------------------------

    fn background_or_unsupported(&self, action: &str, window: Option<String>) -> Result<&dyn crate::platform::Background, Obj> {
        self.desktop.background().ok_or_else(|| {
            self.background_unavailable(
                action,
                &format!("{} offers no background input route; use explicit foreground delivery", self.desktop.name()),
                window,
                "background_unsupported",
                false,
            )
        })
    }

    /// The accessibility result of an action, reported at the point it acted on.
    pub(super) fn background_semantic_opt(
        &self,
        req: &Req,
        effect: &str,
        op: impl FnOnce(&Host) -> Res<Option<Obj>>,
    ) -> Res<Option<Obj>> {
        let reference = req.text("ref");
        self.ref_record(&reference)?;
        let point = self.show_reference_pointer(&reference, "prepare");
        if point.is_some() {
            sleep_ms(self.last_glide_wait_ms());
        }
        let result = op(self)?;
        if let (Some((x, y)), Some(result)) = (point, result.as_ref()) {
            if result.get("delivery_accepted") == Some(&json!(true)) {
                self.report_pointer(x, y, false, effect);
            }
        }
        Ok(result)
    }

    pub(super) fn background_semantic(&self, req: &Req, effect: &str, op: impl FnOnce(&Host) -> Res<Obj>) -> Res<Obj> {
        Ok(self.background_semantic_opt(req, effect, |host| op(host).map(Some))?.unwrap_or_default())
    }

    pub(super) fn show_reference_pointer(&self, reference: &str, phase: &str) -> Option<(i32, i32)> {
        if !self.feedback_enabled() {
            return None;
        }
        match self.el_point(reference, false) {
            Ok(point) => {
                self.report_pointer(point.x, point.y, false, phase);
                Some((point.x, point.y))
            }
            Err(_) => {
                self.pointer_failed();
                None
            }
        }
    }

    fn announce_background_target(&self, x: i32, y: i32) {
        if self.feedback_enabled() {
            self.report_pointer(x, y, false, "prepare");
            sleep_ms(self.last_glide_wait_ms());
        }
    }

    fn complete_native_action(&self, action: &str, message_target: &str, window: Option<String>, before: Option<String>, element: Option<&Rc<dyn Element>>, message: &str) -> Obj {
        let mut changed = false;
        if let (Some(before), Some(element)) = (before, element) {
            sleep_ms(40);
            let after = self.observable_state(element, action);
            changed = after.is_some_and(|after| after != before);
        }
        let suffix = if changed {
            "; target state changed, but the requested goal is not verified"
        } else {
            "; refresh state before treating it as complete"
        };
        let text = format!("{} ({message_target}){suffix}", message);
        let mut result = self.action_result(action, NATIVE_MESSAGE, "unverifiable", false, &text, None, "background", window);
        result.insert("state_changed".into(), json!(changed));
        result
    }

    // --- pointer -------------------------------------------------------------

    pub(super) fn click_family(&self, req: &Req, kind: &str) -> Res<Obj> {
        let action = req.action();
        let foreground = req.delivery_foreground();
        if matches!(kind, "press" | "release") && foreground {
            return Err("background_unsupported|a held pointer button is background-only; no input sent".into());
        }
        let modifiers = parse_modifiers(&req.text("modifiers"))?;
        if req.has("ref") && kind == "click" && !foreground && modifiers.is_empty() {
            if let Some(mut semantic) = self.background_semantic_opt(req, "release", |host| host.do_invoke(req, true))? {
                semantic.insert("action".into(), json!(action));
                return Ok(semantic);
            }
        }
        let point = self.point_arg(req)?;
        let mut target = point.target;
        let element = match req.str("ref") {
            Some(reference) => Some(self.ref_record(&reference)?.0),
            None => None,
        };
        let before = element.as_ref().and_then(|element| self.observable_state(element, &action));
        let allowed = req.strings("allowed_window_ids");
        let mut selected = 0;
        if req.has("window_id") || req.has("window") {
            let info = self.resolve_window(req)?;
            selected = info.handle;
            let owned_allowed = target != info.handle
                && self.desktop.is_owned_by(target, info.handle)
                && self.allowed_point_target(target, info.handle, &allowed);
            if !self.allowed_point_target(target, info.handle, &allowed) && !foreground {
                return Ok(self.action_result(&action, "none", "suspected_noop", false, "frame point is covered by or belongs to a different window", Some("target_mismatch"), "background", Some(info.id())));
            }
            if !owned_allowed {
                target = info.handle;
            }
        }
        if !foreground {
            if element.is_none() && selected == 0 {
                return Ok(self.background_unavailable(&action, "background pixel input requires an exact window_id-bound frame", None, "target_required", false));
            }
            let id = Some(window_id(target));
            let background = match self.background_or_unsupported(&action, id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            self.authorize(req, target)?;
            self.announce_background_target(point.x, point.y);
            return match background.pointer(target, point.x, point.y, kind, &modifiers) {
                Ok(message_target) => {
                    self.report_pointer(point.x, point.y, kind == "press", if kind == "press" { "press" } else { "release" });
                    if matches!(kind, "press" | "release") {
                        self.record_held_pointer(target, point.x, point.y, kind == "press");
                    }
                    let message = format!("{action} delivered as a native pointer event");
                    Ok(self.complete_native_action(&action, &message_target, id, before, element.as_ref(), &message))
                }
                Err(error) => self.background_failure(&action, &error, id, false),
            };
        }
        let reference = req.str("ref");
        let mut body = || -> Res<()> {
            let (x, y) = match &reference {
                Some(reference) => {
                    let point = self.el_point(reference, true)?;
                    (point.x, point.y)
                }
                None => (point.x, point.y),
            };
            if selected != 0 {
                let hit = self.desktop.window_at_point(x, y);
                if !self.allowed_point_target(hit, selected, &allowed) {
                    return Err("target_mismatch|frame point remains covered after exact target focus".into());
                }
            }
            self.glide(target, x, y)?;
            self.with_modifiers(&modifiers, || match kind {
                "click" => self.fg_click(Button::Left, x, y, 1),
                "double" => self.fg_click(Button::Left, x, y, 2),
                "right" => self.fg_click(Button::Right, x, y, 1),
                "middle" => self.fg_click(Button::Middle, x, y, 1),
                "triple" => self.fg_click(Button::Left, x, y, 3),
                _ => {
                    self.fg_move(x, y)?;
                    sleep_ms(16);
                    self.assert_cursor_at(x, y)
                }
            })
        };
        self.foreground_input(target, &action, true, &mut body)
    }

    fn record_held_pointer(&self, target: Wid, x: i32, y: i32, pressed: bool) {
        let id = window_id(target);
        self.session(|session| {
            if pressed {
                session.held_pointer.insert(id, (x, y));
            } else {
                session.held_pointer.remove(&id);
            }
        });
    }

    pub(super) fn do_drag(&self, req: &Req) -> Res<Obj> {
        let modifiers = parse_modifiers(&req.text("modifiers"))?;
        let allowed = req.strings("allowed_window_ids");
        let waypoints = req.list("waypoints");
        if !waypoints.is_empty() {
            if waypoints.len() < 2 {
                return Err("waypoint drag requires at least two points".into());
            }
            if !req.has("window_id") && !req.has("window") {
                return Ok(self.background_unavailable("drag", "waypoint drag requires an exact window_id-bound frame", None, "target_required", false));
            }
            let info = self.resolve_window(req)?;
            let points: Vec<(i32, i32)> = waypoints
                .iter()
                .map(|point| {
                    let point = Req(point.clone());
                    (point.int("x").unwrap_or(0) as i32, point.int("y").unwrap_or(0) as i32)
                })
                .collect();
            return self.drag_points(req, info.handle, &points, &modifiers, &allowed, None);
        }
        if req.has("x") || req.has("y") || req.has("to_x") || req.has("to_y") {
            let (Some(x1), Some(y1), Some(x2), Some(y2)) = (req.int("x"), req.int("y"), req.int("to_x"), req.int("to_y")) else {
                return Err("coordinate drag requires x, y, to_x, and to_y from one frame_id".into());
            };
            if !req.has("window_id") && !req.has("window") {
                return Ok(self.background_unavailable("drag", "coordinate drag requires an exact window_id-bound frame", None, "target_required", false));
            }
            let info = self.resolve_window(req)?;
            let points = [(x1 as i32, y1 as i32), (x2 as i32, y2 as i32)];
            return self.drag_points(req, info.handle, &points, &modifiers, &allowed, None);
        }
        let Some(to) = req.str("to") else {
            return Err("drag requires to (destination ref)".into());
        };
        let reference = req.text("ref");
        let (element, _) = self.ref_record(&reference)?;
        let a = self.el_point(&reference, false)?;
        let b = self.el_point(&to, false)?;
        if a.target != b.target {
            return Ok(self.action_result("drag", "none", "suspected_noop", false, "drag endpoints belong to different windows", Some("target_mismatch"), if req.delivery_foreground() { "foreground" } else { "background" }, None));
        }
        if !req.delivery_foreground() {
            let points = [(a.x, a.y), (b.x, b.y)];
            return self.drag_points(req, a.target, &points, &modifiers, &allowed, Some(&element));
        }
        let target = a.target;
        let mut body = || -> Res<()> {
            let a = self.el_point(&reference, true)?;
            let b = self.el_point(&to, true)?;
            if a.target != target || b.target != target {
                return Err("target_mismatch|drag endpoints changed after focus; no input sent".into());
            }
            self.assert_drag_points(req, target, &[(a.x, a.y), (b.x, b.y)], &allowed)?;
            self.with_modifiers(&modifiers, || self.fg_drag_path(target, &[(a.x, a.y), (b.x, b.y)]))
        };
        self.foreground_input(target, "drag", true, &mut body)
    }

    fn drag_points(&self, req: &Req, target: Wid, points: &[(i32, i32)], modifiers: &[Mod], allowed: &[String], element: Option<&Rc<dyn Element>>) -> Res<Obj> {
        let id = Some(window_id(target));
        if !req.delivery_foreground() {
            let background = match self.background_or_unsupported("drag", id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            self.authorize(req, target)?;
            let before = element.and_then(|element| self.observable_state(element, "drag"));
            self.announce_background_target(points[0].0, points[0].1);
            return match background.drag(target, points, modifiers) {
                Ok(message_target) => {
                    for (x, y) in points {
                        self.report_pointer(*x, *y, true, "drag");
                    }
                    let message = format!("drag delivered through {} points as native pointer events", points.len());
                    Ok(self.complete_native_action("drag", &message_target, id, before, element, &message))
                }
                Err(error) => self.background_failure("drag", &error, id, false),
            };
        }
        let mut body = || -> Res<()> {
            self.assert_drag_points(req, target, points, allowed)?;
            self.with_modifiers(modifiers, || self.fg_drag_path(target, points))
        };
        self.foreground_input(target, "drag", true, &mut body)
    }

    fn assert_drag_points(&self, req: &Req, target: Wid, points: &[(i32, i32)], allowed: &[String]) -> Res<()> {
        self.authorize(req, target)?;
        for (x, y) in points {
            if !self.allowed_point_target(self.desktop.window_at_point(*x, *y), target, allowed) {
                return Err("target_mismatch|drag endpoint is covered or outside the observed target; no input sent".into());
            }
        }
        Ok(())
    }

    /// One physical press that travels through every point, checking that the
    /// target still owns each one; the button is released however it ends.
    fn fg_drag_path(&self, target: Wid, points: &[(i32, i32)]) -> Res<()> {
        if points.len() < 2 {
            return Err("drag path requires at least two points".into());
        }
        for (x, y) in points {
            self.assert_drag_target(target, *x, *y)?;
        }
        let (x0, y0) = points[0];
        self.glide(target, x0, y0)?;
        sleep_ms(60);
        self.assert_drag_target(target, x0, y0)?;
        self.fg_button(Button::Left, true, x0, y0, 1)?;
        let travel = (|| -> Res<()> {
            self.report_pointer(x0, y0, true, "drag");
            sleep_ms(150);
            for leg in 1..points.len() {
                let (fx, fy) = points[leg - 1];
                let (tx, ty) = points[leg];
                for step in 1..=12 {
                    let px = fx + (tx - fx) * step / 12;
                    let py = fy + (ty - fy) * step / 12;
                    self.assert_drag_target(target, px, py)?;
                    self.assert_continue()?;
                    self.mark_own();
                    self.desktop.drag_move(px, py).map_err(|error| format!("input_delivery_failed: drag movement was rejected: {error}"))?;
                    self.report_pointer(px, py, true, "drag");
                    sleep_ms(20);
                    self.assert_cursor_at(px, py)?;
                }
            }
            sleep_ms(80);
            let (lx, ly) = points[points.len() - 1];
            self.assert_drag_target(target, lx, ly)
        })();
        let (cx, cy) = self.desktop.cursor();
        let released = self.fg_button(Button::Left, false, cx, cy, 1);
        travel?;
        released.map_err(|error| format!("input_cleanup_unconfirmed: drag release failed: {error}"))
    }

    pub(super) fn do_scroll(&self, req: &Req) -> Res<Obj> {
        let direction = req.text("direction").to_lowercase();
        let amount = if let Some(amount) = req.int("amount") {
            amount.abs().clamp(1, 100)
        } else if let Some(dy) = req.int("dy") {
            dy.abs().clamp(1, 100)
        } else {
            3
        } as i32;
        let horizontal = matches!(direction.as_str(), "left" | "right");
        let signed = match direction.as_str() {
            "up" | "left" => -amount,
            "down" | "right" => amount,
            _ if req.int("dy").is_some_and(|dy| dy < 0) => -amount,
            _ => amount,
        };
        // Positive clicks move content down/right on the wire the platforms share.
        let clicks = signed;
        let modifiers = parse_modifiers(&req.text("modifiers"))?;
        let foreground = req.delivery_foreground();
        if req.has("x") || req.has("y") {
            let (Some(x), Some(y)) = (req.int("x"), req.int("y")) else {
                return Err("coordinate scroll requires x and y from frame_id".into());
            };
            if !req.has("window_id") && !req.has("window") {
                return Ok(self.background_unavailable("scroll", "coordinate scroll requires an exact window_id-bound frame", None, "target_required", false));
            }
            let info = self.resolve_window(req)?;
            return self.scroll_at(req, info.handle, x as i32, y as i32, clicks, horizontal, &modifiers, &direction, None);
        }
        if let Some(reference) = req.str("ref") {
            let (element, _) = self.ref_record(&reference)?;
            if !foreground && modifiers.is_empty() {
                self.show_reference_pointer(&reference, "scroll");
                let increments = (clicks.abs() * 3).min(30) * clicks.signum();
                self.authorize_current(element.window())?;
                if let Some((before, after)) = element.scroll(horizontal, increments)? {
                    let verified = before != after;
                    let message = format!("scrolled {reference} {direction} {} increments through accessibility", increments.abs());
                    return Ok(self.action_result("scroll", "a11y_scroll", super::windows::effect(verified), verified, &message, None, "background", Some(window_id(element.window()))));
                }
            }
            let point = self.el_point(&reference, false)?;
            if !foreground {
                return self.scroll_at(req, point.target, point.x, point.y, clicks, horizontal, &modifiers, &direction, Some(&element));
            }
            let target = point.target;
            let mut body = || -> Res<()> {
                let focused = self.el_point(&reference, true)?;
                if focused.target != target {
                    return Err("target_mismatch|scroll target changed after focus; no input sent".into());
                }
                self.fg_wheel(target, focused.x, focused.y, clicks, horizontal, &modifiers)
            };
            return self.foreground_input(target, "scroll", true, &mut body);
        }
        if !foreground && !req.has("window_id") && !req.has("window") {
            return Ok(self.background_unavailable("scroll", "background scroll requires an exact ref or window_id", None, "target_required", false));
        }
        let info = self.resolve_window(req)?;
        let x = info.x + info.width / 2;
        let y = info.y + info.height / 2;
        self.scroll_at(req, info.handle, x, y, clicks, horizontal, &modifiers, &direction, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn scroll_at(&self, req: &Req, target: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod], direction: &str, element: Option<&Rc<dyn Element>>) -> Res<Obj> {
        let id = Some(window_id(target));
        if !req.delivery_foreground() {
            let background = match self.background_or_unsupported("scroll", id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            self.authorize(req, target)?;
            let before = element.and_then(|element| self.observable_state(element, "scroll"));
            self.announce_background_target(x, y);
            return match background.wheel(target, x, y, clicks, horizontal, modifiers) {
                Ok(message_target) => {
                    self.report_pointer(x, y, false, "scroll");
                    let message = format!("scrolled {direction} at the point as native wheel events");
                    Ok(self.complete_native_action("scroll", &message_target, id, before, element, &message))
                }
                Err(error) => self.background_failure("scroll", &error, id, false),
            };
        }
        let mut body = || self.fg_wheel(target, x, y, clicks, horizontal, modifiers);
        self.foreground_input(target, "scroll", true, &mut body)
    }

    fn fg_wheel(&self, target: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod]) -> Res<()> {
        self.glide(target, x, y)?;
        self.with_modifiers(modifiers, || {
            self.assert_continue()?;
            self.mark_own();
            self.desktop.wheel(x, y, clicks, horizontal)?;
            self.report_pointer(x, y, false, "scroll");
            Ok(())
        })
    }

    // --- keyboard -------------------------------------------------------------

    /// The window typed input goes to, and the point to click first, if any.
    fn typing_target(&self, req: &Req, with_point: bool) -> Res<(Wid, Option<Point>)> {
        if let Some(reference) = req.str("ref") {
            let point = self.el_point(&reference, false)?;
            return Ok((point.target, Some(point)));
        }
        if req.has("window_id") || req.has("window") {
            let handle = self.resolve_window(req)?.handle;
            let point = match (with_point, req.int("x"), req.int("y")) {
                (true, Some(x), Some(y)) => Some(Point { x: x as i32, y: y as i32, target: handle }),
                _ => None,
            };
            return Ok((handle, point));
        }
        Ok((self.session(|session| session.last_focus), None))
    }

    fn focus_typing_point(&self, req: &Req, target: Wid, point: &Option<Point>) -> Res<()> {
        let Some(point) = point else { return Ok(()) };
        let (x, y, owner) = match req.str("ref") {
            Some(reference) => {
                let fresh = self.el_point(&reference, false)?;
                (fresh.x, fresh.y, fresh.target)
            }
            None => (point.x, point.y, point.target),
        };
        if owner != target {
            return Err("target_mismatch|text target changed after focus; no input sent".into());
        }
        self.glide(target, x, y)?;
        self.fg_click(Button::Left, x, y, 1)?;
        sleep_ms(80);
        Ok(())
    }

    fn report_typing_point(&self, req: &Req, point: &Option<Point>) {
        if point.is_some() {
            self.report_current_pointer("type");
            return;
        }
        if let Some(reference) = req.str("ref") {
            if let Ok(resolved) = self.el_point(&reference, false) {
                self.report_pointer(resolved.x, resolved.y, false, "type");
            }
        }
    }

    fn background_key_target(&self, req: &Req, action: &str) -> Result<(Wid, Option<Rc<dyn Element>>), Obj> {
        if let Some(reference) = req.str("ref") {
            return match self.ref_record(&reference) {
                Ok((element, window)) => Ok((parse_window_id(&window), Some(element))),
                Err(error) => Err(self.background_unavailable(action, &error, None, "stale_target", false)),
            };
        }
        if req.has("window_id") || req.has("window") {
            return match self.resolve_window(req) {
                Ok(info) => Ok((info.handle, None)),
                Err(error) => Err(self.background_unavailable(action, &error, None, "stale_target", false)),
            };
        }
        Err(self.background_unavailable(action, &format!("background {action} requires an exact ref or window_id"), None, "target_required", false))
    }

    pub(super) fn do_key(&self, req: &Req) -> Res<Obj> {
        let keys_text = req.text("keys");
        if !req.delivery_foreground() {
            let (target, element) = match self.background_key_target(req, "key") {
                Ok(found) => found,
                Err(result) => return Ok(result),
            };
            let id = Some(window_id(target));
            let background = match self.background_or_unsupported("key", id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            let before = element.as_ref().and_then(|element| self.observable_state(element, "key"));
            if let Err(error) = self.authorize(req, target) {
                return self.background_failure("key", &error, id, false);
            }
            return match background.keys(target, &keys_text) {
                Ok(message_target) => Ok(self.complete_native_action("key", &message_target, id, before, element.as_ref(), "keys delivered as native key events")),
                Err(error) => self.background_failure("key", &error, id, false),
            };
        }
        let (target, point) = self.typing_target(req, false)?;
        if !self.is_window(target) {
            return Ok(self.action_result("key", "none", "suspected_noop", false, "key requires window_id/window or a prior focus_window in this session", Some("target_required"), "foreground", None));
        }
        let mut body = || -> Res<()> {
            self.focus_typing_point(req, target, &point)?;
            self.report_typing_point(req, &point);
            if keys::is_plain_text(&keys_text) {
                self.fg_text(&keys_text)
            } else {
                keys::send(&keys_text, &mut ForegroundKeys { host: self })
            }
        };
        self.foreground_input(target, "key", false, &mut body)
    }

    /// Holding a key past its command needs the real keyboard.
    pub(super) fn do_key_hold(&self, req: &Req, down: bool) -> Res<Obj> {
        let action = if down { "key_down" } else { "key_up" };
        if !req.delivery_foreground() {
            return Ok(self.background_unavailable(action, "a held key requires the real keyboard; use explicit foreground delivery", None, "background_unsupported", false));
        }
        let keys_text = req.text("keys");
        let (target, point) = self.typing_target(req, false)?;
        if !self.is_window(target) {
            let message = format!("{action} requires window_id/window or a prior focus_window in this session");
            return Ok(self.action_result(action, "none", "suspected_noop", false, &message, Some("target_required"), "foreground", None));
        }
        let mut body = || -> Res<()> {
            self.focus_typing_point(req, target, &point)?;
            self.report_typing_point(req, &point);
            keys::hold(&keys_text, down, &mut ForegroundKeys { host: self })?;
            self.session(|session| {
                session.held_keys.retain(|held| held != &keys_text);
                if down {
                    session.held_keys.push(keys_text.clone());
                }
            });
            Ok(())
        };
        self.foreground_input(target, action, false, &mut body)
    }

    pub(super) fn do_type(&self, req: &Req) -> Res<Obj> {
        let text = req.text("text");
        if req.delivery_foreground() && text.encode_utf16().count() > self.cfg.max_foreground_text {
            return Err(format!("input_too_large: foreground text exceeds {} UTF-16 code units", self.cfg.max_foreground_text));
        }
        if !req.delivery_foreground() {
            let (target, element) = match self.background_key_target(req, "type") {
                Ok(found) => found,
                Err(result) => return Ok(result),
            };
            let id = Some(window_id(target));
            if let Some(element) = &element {
                // Background keys reach the application's focused control, not a
                // named element. A settable element takes the text through its
                // own value instead; any other element is focused first.
                if element.settable() {
                    let mut valued = self.background_semantic(req, "type", |host| host.do_set_value(req, &text))?;
                    valued.insert("action".into(), json!("type"));
                    return Ok(valued);
                }
                if let Err(error) = element.focus() {
                    let message = format!("element accepts no settable value and could not take keyboard focus ({error}); use explicit foreground delivery");
                    return Ok(self.background_unavailable("type", &message, id, "background_unsupported", false));
                }
            }
            let background = match self.background_or_unsupported("type", id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            let before = element.as_ref().and_then(|element| self.observable_state(element, "type"));
            let mut pointer_completed = false;
            let outcome = (|| -> Res<String> {
                if let (Some(x), Some(y)) = (req.int("x"), req.int("y")) {
                    background.pointer(target, x as i32, y as i32, "click", &[])?;
                    pointer_completed = true;
                    sleep_ms(80);
                }
                self.authorize(req, target)?;
                background.text(target, &text)
            })();
            return match outcome {
                Ok(message_target) => {
                    let message = format!("typed {} literal characters as native key events", text.chars().count());
                    Ok(self.complete_native_action("type", &message_target, id, before, element.as_ref(), &message))
                }
                Err(error) => self.background_failure("type", &error, id, pointer_completed),
            };
        }
        let (target, point) = self.typing_target(req, true)?;
        if !self.is_window(target) {
            return Ok(self.action_result("type", "none", "suspected_noop", false, "type requires window_id/window or a prior focus_window in this session", Some("target_required"), "foreground", None));
        }
        let mut body = || -> Res<()> {
            self.focus_typing_point(req, target, &point)?;
            self.report_typing_point(req, &point);
            self.fg_text(&text)
        };
        self.foreground_input(target, "type", false, &mut body)
    }

    // --- preflight and sequences ----------------------------------------------

    pub(super) fn validate_background_input(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let background = self
            .desktop
            .background()
            .ok_or_else(|| format!("background_unsupported|{} offers no background input route; no input sent", self.desktop.name()))?;
        for step in req.list("steps") {
            let step = Req(step);
            let mut target = info.handle;
            if let Some(reference) = step.str("ref") {
                let (element, window) = self.ref_record(&reference)?;
                if step.text("action") == "type" && element.settable() {
                    continue;
                }
                target = parse_window_id(&window);
            }
            background.validate(target, &step.text("action"))?;
        }
        Ok(obj! { "text" => "background input preflight passed", "input_not_dispatched" => true })
    }

    /// One exact-window background step, with the window list around it so the
    /// host can see what the step opened or closed.
    pub(super) fn sequence_step(&self, req: &Req) -> Res<Obj> {
        const ACTIONS: [&str; 15] = [
            "invoke", "set_value", "click", "right_click", "middle_click", "double_click", "triple_click", "mouse_down", "mouse_up",
            "mouse_move", "drag", "scroll", "type", "key", "wait",
        ];
        let step = req.child("step");
        if let Some(step) = &step {
            if matches!(step.action().as_str(), "key_down" | "key_up") {
                return Err("background_unsupported|a held key requires the real keyboard; use explicit foreground delivery".into());
            }
        }
        let Some(step) = step.filter(|step| {
            ACTIONS.contains(&step.action().as_str())
                && step.text("delivery") == "background"
                && req.text("delivery") == "background"
                && step.has("window_id")
                && !step.has("window")
                && step.text("session_id") == req.text("session_id")
                && !step.truthy("read_only")
        }) else {
            return Err("sequence_step_invalid: expected one exact-window background input".into());
        };
        if step.action() == "wait" && !step.f64("duration").is_some_and(|duration| (0.0..=5.0).contains(&duration)) {
            return Err("sequence_step_invalid: wait requires 0..5 seconds".into());
        }
        self.authorize(&step, 0)?;
        let started = now_ms();
        let before = self.window_snapshot()?;
        let before_ms = now_ms() - started;
        let result = self.handle(&step)?;
        let delivered_at = now_ms() - started;
        let delivery_ms = delivered_at - before_ms;
        let settle_ms = self.cfg.sequence_settle_ms;
        let credit_ms = if step.action() == "wait" { settle_ms.min(delivery_ms) } else { 0 };
        let remaining_ms = settle_ms - credit_ms;
        if remaining_ms > 0 {
            sleep_ms(remaining_ms);
        }
        let settled_at = now_ms() - started;
        let after = self.window_snapshot()?;
        let finished_at = now_ms() - started;
        Ok(obj! {
            "step_result" => Value::Object(result),
            "windows_before" => before.get("windows").cloned().unwrap_or(Value::Null),
            "windows_after" => after.get("windows").cloned().unwrap_or(Value::Null),
            "settle_delay_ms" => remaining_ms,
            "timings_ms" => json!({
                "before_windows_ms": before_ms,
                "delivery_ms": delivery_ms,
                "settle_ms": settled_at - delivered_at,
                "settle_credit_ms": credit_ms,
                "after_windows_ms": finished_at - settled_at,
                "backend_ms": finished_at,
            }),
        })
    }

    // --- recovery -------------------------------------------------------------

    pub(super) fn input_idle_state(&self) -> Obj {
        let state = self.observer.read();
        let idle = now_ms().saturating_sub(state.tick);
        obj! {
            "ready" => state.ready && self.desktop.desktop_ready(),
            "observer_ready" => state.ready,
            "monitor" => state.generation,
            "sequence" => state.sequence,
            "idleMs" => idle,
            "held" => self.desktop.input_held(),
        }
    }

    pub(super) fn input_recovery_state(&self, req: &Req) -> Res<Obj> {
        let last_focus = self.session(|session| session.last_focus);
        let target = if req.bool_true("after_input") && req.has("window_id") {
            parse_window_id(&req.text("window_id"))
        } else if let Some(reference) = req.str("ref") {
            parse_window_id(&self.ref_record(&reference)?.1)
        } else if req.has("window_id") || req.has("window") {
            self.resolve_window(req)?.handle
        } else if self.is_window(last_focus) {
            last_focus
        } else {
            0
        };
        let exists = self.is_window(target);
        if target == 0 || (!exists && !req.bool_true("after_input")) {
            return Err("foreground input target is unavailable before dispatch".into());
        }
        let owner = if exists { self.desktop.info(target).map(|info| info.owner_id()).unwrap_or_default() } else { String::new() };
        let foreground = self.desktop.foreground();
        let original = self.session(|session| session.original_focus);
        let restore = if self.is_window(original) { original } else { foreground };
        let restore_owner = self.desktop.info(restore).map(|info| info.owner_id()).unwrap_or_default();
        let (cx, cy) = self.desktop.cursor();
        let evidence = self.observer.read();
        let foreground_pid = self.desktop.info(foreground).map(|info| info.pid).unwrap_or(0);
        let target_pid = self.desktop.info(target).map(|info| info.pid).unwrap_or(-1);
        Ok(obj! {
            "text" => "foreground input recovery state captured",
            "input_observer_ready" => evidence.ready,
            "input_monitor_id" => evidence.generation,
            "input_user_sequence" => evidence.sequence,
            "target_window_id" => window_id(target),
            "target_exists" => exists,
            "target_owner_window_id" => owner,
            "foreground_window_id" => if self.is_window(foreground) { window_id(foreground) } else { String::new() },
            "restore_window_id" => if self.is_window(restore) { window_id(restore) } else { String::new() },
            "restore_owner_window_id" => restore_owner,
            "cursor_x" => cx,
            "cursor_y" => cy,
            "input_tick" => evidence.tick,
            "synthetic_input" => self.physical_idle_ms() == i32::MAX as u64,
            "foreground_within_target" => foreground == target || self.desktop.is_owned_by(foreground, target),
            "foreground_child_process" => exists && foreground != target && foreground_pid != 0 && crate::platform::is_child_process(foreground_pid, target_pid),
        })
    }

    fn assert_recovery_unchanged(&self, req: &Req) -> Res<()> {
        let evidence = self.observer.read();
        let monitor = req.text("expected_input_monitor_id");
        let Some(sequence) = req.int("expected_input_user_sequence") else {
            return Err("input_observation_unavailable: cannot establish the original input observation".into());
        };
        if !evidence.ready || monitor.is_empty() || evidence.generation != monitor {
            return Err("input_observation_unavailable: cannot establish the original input observation".into());
        }
        if evidence.sequence != sequence {
            return Err("user_input_active: desktop input changed; recovery must not override the user".into());
        }
        Ok(())
    }

    pub(super) fn restore_input_state(&self, req: &Req) -> Res<Obj> {
        self.assert_recovery_unchanged(req)?;
        {
            let mut scope = self.scope.borrow_mut();
            scope.begin_expected(&self.observer, &req.text("expected_input_monitor_id"), req.int("expected_input_user_sequence").unwrap_or(-1))?;
        }
        let outcome = self.restore_body(req);
        self.scope.borrow_mut().end();
        outcome
    }

    fn restore_body(&self, req: &Req) -> Res<Obj> {
        let restore_focus = !req.bool_false("restore_focus");
        let mut restore = parse_window_id(&req.text("restore_window_id"));
        let mut restored = if restore_focus { "original" } else { "preserved" };
        if restore_focus && !self.is_window(restore) {
            let owner = parse_window_id(&req.text("restore_owner_window_id"));
            if !self.is_window(owner) {
                return Err("input recovery restore window is stale or invalid".into());
            }
            restore = owner;
            restored = "owner";
        }
        if restore_focus && self.desktop.foreground() != restore {
            self.mark_own();
            self.desktop.focus(restore);
        }
        self.assert_recovery_unchanged(req)?;
        let x = req.int("cursor_x").unwrap_or(0) as i32;
        let y = req.int("cursor_y").unwrap_or(0) as i32;
        self.mark_own();
        self.desktop.move_pointer(x, y)?;
        sleep_ms(30);
        self.assert_recovery_unchanged(req)?;
        self.mark_own();
        self.desktop.move_pointer(x, y)?;
        let foreground = self.desktop.foreground();
        let (cx, cy) = self.desktop.cursor();
        let evidence = self.observer.read();
        let target = parse_window_id(&req.text("window_id"));
        Ok(obj! {
            "input_observer_ready" => evidence.ready,
            "input_monitor_id" => evidence.generation,
            "input_user_sequence" => evidence.sequence,
            "foreground_window_id" => if self.is_window(foreground) { window_id(foreground) } else { String::new() },
            "restored_target" => restored,
            "cursor_x" => cx,
            "cursor_y" => cy,
            "input_tick" => evidence.tick,
            "synthetic_input" => self.physical_idle_ms() == i32::MAX as u64,
            "foreground_within_target" => foreground == target || self.desktop.is_owned_by(foreground, target),
        })
    }

    /// Ends a session: returns focus when nothing else moved it, then
    /// releases every button and key the session still holds.
    pub(super) fn release_session(&self) -> Res<Obj> {
        let current = self.desktop.foreground();
        let observed = self.observer.read();
        let (original, monitor, sequence, last_focus) = self.session(|session| {
            (session.original_focus, session.original_focus_monitor.clone(), session.original_focus_sequence, session.last_focus)
        });
        let mut restored = false;
        if observed.ready
            && monitor == observed.generation
            && sequence == Some(observed.sequence)
            && original != 0
            && current == last_focus
            && self.is_window(original)
        {
            self.mark_own();
            restored = self.desktop.focus(original);
        }
        let pointer = self.release_held_pointer();
        let keys = self.release_held_keys();
        self.session(|session| {
            session.invalidate_refs();
            session.last_focus = 0;
            session.original_focus = 0;
            session.original_focus_monitor.clear();
            session.original_focus_sequence = None;
        });
        pointer?;
        keys?;
        Ok(obj! { "text" => "computer session released", "focus_restored" => restored })
    }

    fn release_held_pointer(&self) -> Res<()> {
        let held: Vec<(String, (i32, i32))> = self.session(|session| std::mem::take(&mut session.held_pointer).into_iter().collect());
        if held.is_empty() {
            return Ok(());
        }
        let Some(background) = self.desktop.background() else {
            return Err("input_cleanup_unconfirmed: a held pointer button could not be released".into());
        };
        let mut failed = false;
        for (id, (x, y)) in held {
            if background.pointer(parse_window_id(&id), x, y, "release", &[]).is_err() {
                failed = true;
            }
        }
        if failed {
            return Err("input_cleanup_unconfirmed: a held pointer button could not be released".into());
        }
        Ok(())
    }

    fn release_held_keys(&self) -> Res<()> {
        let held: Vec<String> = self.session(|session| std::mem::take(&mut session.held_keys));
        let mut failed = false;
        for keys_text in held.iter().rev() {
            let released = keys::held_key(keys_text).and_then(|(modifiers, key)| {
                self.mark_own();
                self.desktop.key(key, false)?;
                for modifier in modifiers.iter().rev() {
                    self.desktop.key(Key::Mod(*modifier), false)?;
                }
                Ok(())
            });
            if released.is_err() {
                failed = true;
            }
        }
        if failed {
            return Err("input_cleanup_unconfirmed: a held key could not be released".into());
        }
        Ok(())
    }

    pub(super) fn do_wait(&self, req: &Req) -> Res<Obj> {
        let seconds = req.f64("duration").unwrap_or(1.0);
        if !(0.0..=30.0).contains(&seconds) {
            return Err("wait duration must be 0..30 seconds".into());
        }
        sleep_ms((seconds * 1000.0) as u64);
        Ok(obj! { "text" => format!("waited {seconds}s") })
    }
}
