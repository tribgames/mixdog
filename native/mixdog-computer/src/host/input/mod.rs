//! Pointer and keyboard actions, their background and foreground routes, and
//! the recovery reads the host takes around foreground input.

mod keyboard;
mod pointer;
mod recovery;

use super::{sleep_ms, Host, Res};
use crate::a11y::Element;
use crate::obj;
use crate::observer::now_ms;
use crate::platform::{parse_window_id, window_id, Wid};
use crate::protocol::{round_half_even, Obj, Req};
use serde_json::{json, Value};
use std::rc::Rc;

/// The native path name background pixel and key input reports.
pub(super) const NATIVE_MESSAGE: &str = "native_message";

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
                (
                    record.element.clone(),
                    record.window_id.clone(),
                    record.generation == generation,
                    record.identity.clone(),
                )
            })
        });
        let Some((element, window, current, identity)) = found else {
            return Err(format!("ref {reference} is stale, from another session, or unknown; take a fresh snapshot/find"));
        };
        if !current {
            return Err(format!(
                "ref {reference} is stale; take a fresh snapshot/find"
            ));
        }
        let owner = element.window();
        if !element.alive()
            || element.identity() != identity
            || (owner != 0 && window_id(owner) != window)
            || !self.is_window(parse_window_id(&window))
        {
            return Err(format!(
                "ref {reference} is stale or its target changed; take a fresh snapshot/find"
            ));
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
        Ok(Point {
            x: px,
            y: py,
            target: top,
        })
    }

    fn point_arg(&self, req: &Req) -> Res<Point> {
        if let Some(reference) = req.str("ref") {
            return self.el_point(&reference, false);
        }
        let (Some(x), Some(y)) = (req.int("x"), req.int("y")) else {
            return Err(format!(
                "{} requires ref or x/y screen coordinates",
                req.action()
            ));
        };
        let (x, y) = (x as i32, y as i32);
        if req.has("window_id") || req.has("window") {
            let selected = self.resolve_window(req)?;
            let at = self.desktop.window_at_point(x, y);
            if at == selected.handle {
                return Ok(Point {
                    x,
                    y,
                    target: selected.handle,
                });
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
                return Ok(Point {
                    x,
                    y,
                    target: selected.handle,
                });
            }
            return Ok(Point { x, y, target: at });
        }
        Ok(Point {
            x,
            y,
            target: self.desktop.window_at_point(x, y),
        })
    }

    // --- background ----------------------------------------------------------

    fn background_or_unsupported(
        &self,
        action: &str,
        window: Option<String>,
    ) -> Result<&dyn crate::platform::Background, Obj> {
        self.desktop.background().ok_or_else(|| {
            self.background_unavailable(
                action,
                &format!(
                    "{} offers no background input route; use explicit foreground delivery",
                    self.desktop.name()
                ),
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

    pub(super) fn background_semantic(
        &self,
        req: &Req,
        effect: &str,
        op: impl FnOnce(&Host) -> Res<Obj>,
    ) -> Res<Obj> {
        Ok(self
            .background_semantic_opt(req, effect, |host| op(host).map(Some))?
            .unwrap_or_default())
    }

    pub(super) fn show_reference_pointer(
        &self,
        reference: &str,
        phase: &str,
    ) -> Option<(i32, i32)> {
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

    fn complete_native_action(
        &self,
        action: &str,
        message_target: &str,
        window: Option<String>,
        before: Option<String>,
        element: Option<&Rc<dyn Element>>,
        message: &str,
    ) -> Obj {
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
        let mut result = self.action_result(
            action,
            NATIVE_MESSAGE,
            "unverifiable",
            false,
            &text,
            None,
            "background",
            window,
        );
        result.insert("state_changed".into(), json!(changed));
        result
    }

    // --- preflight and sequences ----------------------------------------------

    pub(super) fn validate_background_input(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let background = self.desktop.background().ok_or_else(|| {
            format!(
                "background_unsupported|{} offers no background input route; no input sent",
                self.desktop.name()
            )
        })?;
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
            "invoke",
            "set_value",
            "click",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
            "mouse_down",
            "mouse_up",
            "mouse_move",
            "drag",
            "scroll",
            "type",
            "key",
            "wait",
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
        if step.action() == "wait"
            && !step
                .f64("duration")
                .is_some_and(|duration| (0.0..=5.0).contains(&duration))
        {
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
        let credit_ms = if step.action() == "wait" {
            settle_ms.min(delivery_ms)
        } else {
            0
        };
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

    pub(super) fn do_wait(&self, req: &Req) -> Res<Obj> {
        let seconds = req.f64("duration").unwrap_or(1.0);
        if !(0.0..=30.0).contains(&seconds) {
            return Err("wait duration must be 0..30 seconds".into());
        }
        sleep_ms((seconds * 1000.0) as u64);
        Ok(obj! { "text" => format!("waited {seconds}s") })
    }
}
