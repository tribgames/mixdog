//! Click, drag and scroll, background and foreground routes.

use crate::a11y::Element;
use crate::host::{parse_modifiers, sleep_ms, Host, Res};
use crate::keys::Mod;
use crate::platform::{window_id, Button, Wid};
use crate::protocol::{Obj, Req};
use serde_json::json;
use std::rc::Rc;

impl Host {
    // --- pointer -------------------------------------------------------------

    pub(in crate::host) fn click_family(&self, req: &Req, kind: &str) -> Res<Obj> {
        let action = req.action();
        let foreground = req.delivery_foreground();
        if matches!(kind, "press" | "release") && foreground {
            return Err(
                "background_unsupported|a held pointer button is background-only; no input sent"
                    .into(),
            );
        }
        let modifiers = parse_modifiers(&req.text("modifiers"))?;
        if req.has("ref") && kind == "click" && !foreground && modifiers.is_empty() {
            if let Some(mut semantic) =
                self.background_semantic_opt(req, "release", |host| host.do_invoke(req, true))?
            {
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
        let before = element
            .as_ref()
            .and_then(|element| self.observable_state(element, &action));
        let allowed = req.strings("allowed_window_ids");
        let mut selected = 0;
        if req.has("window_id") || req.has("window") {
            let info = self.resolve_window(req)?;
            selected = info.handle;
            let owned_allowed = target != info.handle
                && self.desktop.is_owned_by(target, info.handle)
                && self.allowed_point_target(target, info.handle, &allowed);
            if !self.allowed_point_target(target, info.handle, &allowed) && !foreground {
                return Ok(self.action_result(
                    &action,
                    "none",
                    "suspected_noop",
                    false,
                    "frame point is covered by or belongs to a different window",
                    Some("target_mismatch"),
                    "background",
                    Some(info.id()),
                ));
            }
            if !owned_allowed {
                target = info.handle;
            }
        }
        if !foreground {
            if element.is_none() && selected == 0 {
                return Ok(self.background_unavailable(
                    &action,
                    "background pixel input requires an exact window_id-bound frame",
                    None,
                    "target_required",
                    false,
                ));
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
                    self.report_pointer(
                        point.x,
                        point.y,
                        kind == "press",
                        if kind == "press" { "press" } else { "release" },
                    );
                    if matches!(kind, "press" | "release") {
                        self.record_held_pointer(target, point.x, point.y, kind == "press");
                    }
                    let message = format!("{action} delivered as a native pointer event");
                    Ok(self.complete_native_action(
                        &action,
                        &message_target,
                        id,
                        before,
                        element.as_ref(),
                        &message,
                    ))
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
                    return Err(
                        "target_mismatch|frame point remains covered after exact target focus"
                            .into(),
                    );
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

    pub(in crate::host) fn do_drag(&self, req: &Req) -> Res<Obj> {
        let modifiers = parse_modifiers(&req.text("modifiers"))?;
        let allowed = req.strings("allowed_window_ids");
        let waypoints = req.list("waypoints");
        if !waypoints.is_empty() {
            if waypoints.len() < 2 {
                return Err("waypoint drag requires at least two points".into());
            }
            if !req.has("window_id") && !req.has("window") {
                return Ok(self.background_unavailable(
                    "drag",
                    "waypoint drag requires an exact window_id-bound frame",
                    None,
                    "target_required",
                    false,
                ));
            }
            let info = self.resolve_window(req)?;
            let points: Vec<(i32, i32)> = waypoints
                .iter()
                .map(|point| {
                    let point = Req(point.clone());
                    (
                        point.int("x").unwrap_or(0) as i32,
                        point.int("y").unwrap_or(0) as i32,
                    )
                })
                .collect();
            return self.drag_points(req, info.handle, &points, &modifiers, &allowed, None);
        }
        if req.has("x") || req.has("y") || req.has("to_x") || req.has("to_y") {
            let (Some(x1), Some(y1), Some(x2), Some(y2)) =
                (req.int("x"), req.int("y"), req.int("to_x"), req.int("to_y"))
            else {
                return Err(
                    "coordinate drag requires x, y, to_x, and to_y from one frame_id".into(),
                );
            };
            if !req.has("window_id") && !req.has("window") {
                return Ok(self.background_unavailable(
                    "drag",
                    "coordinate drag requires an exact window_id-bound frame",
                    None,
                    "target_required",
                    false,
                ));
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
            return Ok(self.action_result(
                "drag",
                "none",
                "suspected_noop",
                false,
                "drag endpoints belong to different windows",
                Some("target_mismatch"),
                if req.delivery_foreground() {
                    "foreground"
                } else {
                    "background"
                },
                None,
            ));
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
                return Err(
                    "target_mismatch|drag endpoints changed after focus; no input sent".into(),
                );
            }
            self.assert_drag_points(req, target, &[(a.x, a.y), (b.x, b.y)], &allowed)?;
            self.with_modifiers(&modifiers, || {
                self.fg_drag_path(target, &[(a.x, a.y), (b.x, b.y)])
            })
        };
        self.foreground_input(target, "drag", true, &mut body)
    }

    fn drag_points(
        &self,
        req: &Req,
        target: Wid,
        points: &[(i32, i32)],
        modifiers: &[Mod],
        allowed: &[String],
        element: Option<&Rc<dyn Element>>,
    ) -> Res<Obj> {
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
                    let message = format!(
                        "drag delivered through {} points as native pointer events",
                        points.len()
                    );
                    Ok(self.complete_native_action(
                        "drag",
                        &message_target,
                        id,
                        before,
                        element,
                        &message,
                    ))
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

    fn assert_drag_points(
        &self,
        req: &Req,
        target: Wid,
        points: &[(i32, i32)],
        allowed: &[String],
    ) -> Res<()> {
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
                    self.desktop.drag_move(px, py).map_err(|error| {
                        format!("input_delivery_failed: drag movement was rejected: {error}")
                    })?;
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

    pub(in crate::host) fn do_scroll(&self, req: &Req) -> Res<Obj> {
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
                return Ok(self.background_unavailable(
                    "scroll",
                    "coordinate scroll requires an exact window_id-bound frame",
                    None,
                    "target_required",
                    false,
                ));
            }
            let info = self.resolve_window(req)?;
            return self.scroll_at(
                req,
                info.handle,
                x as i32,
                y as i32,
                clicks,
                horizontal,
                &modifiers,
                &direction,
                None,
            );
        }
        if let Some(reference) = req.str("ref") {
            let (element, _) = self.ref_record(&reference)?;
            if !foreground && modifiers.is_empty() {
                self.show_reference_pointer(&reference, "scroll");
                let increments = (clicks.abs() * 3).min(30) * clicks.signum();
                self.authorize_current(element.window())?;
                if let Some((before, after)) = element.scroll(horizontal, increments)? {
                    let verified = before != after;
                    let message = format!(
                        "scrolled {reference} {direction} {} increments through accessibility",
                        increments.abs()
                    );
                    return Ok(self.action_result(
                        "scroll",
                        "a11y_scroll",
                        crate::host::windows::effect(verified),
                        verified,
                        &message,
                        None,
                        "background",
                        Some(window_id(element.window())),
                    ));
                }
            }
            let point = self.el_point(&reference, false)?;
            if !foreground {
                return self.scroll_at(
                    req,
                    point.target,
                    point.x,
                    point.y,
                    clicks,
                    horizontal,
                    &modifiers,
                    &direction,
                    Some(&element),
                );
            }
            let target = point.target;
            let mut body = || -> Res<()> {
                let focused = self.el_point(&reference, true)?;
                if focused.target != target {
                    return Err(
                        "target_mismatch|scroll target changed after focus; no input sent".into(),
                    );
                }
                self.fg_wheel(target, focused.x, focused.y, clicks, horizontal, &modifiers)
            };
            return self.foreground_input(target, "scroll", true, &mut body);
        }
        if !foreground && !req.has("window_id") && !req.has("window") {
            return Ok(self.background_unavailable(
                "scroll",
                "background scroll requires an exact ref or window_id",
                None,
                "target_required",
                false,
            ));
        }
        let info = self.resolve_window(req)?;
        let x = info.x + info.width / 2;
        let y = info.y + info.height / 2;
        self.scroll_at(
            req,
            info.handle,
            x,
            y,
            clicks,
            horizontal,
            &modifiers,
            &direction,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn scroll_at(
        &self,
        req: &Req,
        target: Wid,
        x: i32,
        y: i32,
        clicks: i32,
        horizontal: bool,
        modifiers: &[Mod],
        direction: &str,
        element: Option<&Rc<dyn Element>>,
    ) -> Res<Obj> {
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
                    let message =
                        format!("scrolled {direction} at the point as native wheel events");
                    Ok(self.complete_native_action(
                        "scroll",
                        &message_target,
                        id,
                        before,
                        element,
                        &message,
                    ))
                }
                Err(error) => self.background_failure("scroll", &error, id, false),
            };
        }
        let mut body = || self.fg_wheel(target, x, y, clicks, horizontal, modifiers);
        self.foreground_input(target, "scroll", true, &mut body)
    }

    fn fg_wheel(
        &self,
        target: Wid,
        x: i32,
        y: i32,
        clicks: i32,
        horizontal: bool,
        modifiers: &[Mod],
    ) -> Res<()> {
        self.glide(target, x, y)?;
        self.with_modifiers(modifiers, || {
            self.assert_continue()?;
            self.mark_own();
            self.desktop.wheel(x, y, clicks, horizontal)?;
            self.report_pointer(x, y, false, "scroll");
            Ok(())
        })
    }
}
