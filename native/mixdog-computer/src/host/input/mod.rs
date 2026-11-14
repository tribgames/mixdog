//! Pointer and keyboard actions, their background and foreground routes, and
//! the recovery reads the host takes around foreground input.

mod keyboard;
mod pointer;
mod quiet;
mod recovery;
#[cfg(test)]
mod ref_tests;

use super::{sleep_ms, Host, Res};
use crate::a11y::{Element, Stale};
use crate::obj;
use crate::observer::now_ms;
use crate::platform::{parse_window_id, window_id, Wid};
use crate::protocol::{round_half_even, Obj, Req};
use serde_json::{json, Value};
use std::rc::Rc;

/// The native path name background pixel and key input reports.
/// The path of input delivered as window messages: `win32_message` on
/// Windows, as the PowerShell worker reported it.
#[cfg(windows)]
pub(super) const NATIVE_MESSAGE: &str = "win32_message";
#[cfg(not(windows))]
pub(super) const NATIVE_MESSAGE: &str = "native_message";

pub(super) struct Point {
    pub x: i32,
    pub y: i32,
    pub target: Wid,
}

impl Host {
    // --- refs ----------------------------------------------------------------

    /// Get-RefRecord: the element a ref was handed out for, still the control
    /// the caller observed, or why it is not.
    pub(super) fn ref_record(&self, reference: &str) -> Res<(Rc<dyn Element>, String)> {
        let found = self.session(|session| {
            let generation = session.generation;
            session.refs.get(reference).map(|record| {
                (
                    record.element.clone(),
                    record.window_id.clone(),
                    record.generation == generation,
                    record.identity.clone(),
                    record.role.clone(),
                    record.name.clone(),
                    record.source,
                )
            })
        });
        let Some((mut element, window, current, identity, role, name, source)) = found else {
            return Err(format!("ref {reference} is stale, from another session, or unknown; take a fresh snapshot/find"));
        };
        if !current {
            return Err(format!(
                "ref {reference} is stale; take a fresh snapshot/find"
            ));
        }
        let continuation = self.current_request().bool_true("sequence_continuation");
        let refuse = |element: &Rc<dyn Element>, kind: Stale| {
            let wording = element.stale_message(kind).unwrap_or(match kind {
                Stale::Target => "is stale or its target changed",
                Stale::Identity => "no longer identifies the same element",
            });
            format!("ref {reference} {wording}; take a fresh snapshot/find")
        };
        let same = element.alive() && {
            let top = element.top_window();
            top != 0
                && self.is_window(top)
                && window_id(top) == window
                && element.identity() == identity
        };
        if same {
            // An identity survives a relabel in place, so the role and name the
            // caller observed must still hold before any input goes to the element.
            // Only the trees Get-RefRecord reads (UIA, MSAA) report them live;
            // AT-SPI and AX elements do not.
            let checked = matches!(element.source(), "uia" | "msaa");
            let relabelled = element.name() != name && !self.name_is_text(&element);
            if checked && (element.control_type() != role || relabelled) {
                return Err(refuse(&element, Stale::Identity));
            }
        } else {
            // A later step of a sequence acts on what earlier steps left, so
            // only the step the caller aimed from its observation may stand in
            // a rebuilt twin; an MSAA node has none.
            let rebound = (!continuation && source != "msaa")
                .then(|| {
                    self.session(|session| {
                        let record = session.refs.get_mut(reference)?;
                        let rebound = self
                            .desktop
                            .accessibility()?
                            .rebind(parse_window_id(&window), record)?;
                        record.identity = rebound.identity();
                        record.element = rebound.clone();
                        Some(rebound)
                    })
                })
                .flatten();
            match rebound {
                Some(rebound) => element = rebound,
                None => return Err(refuse(&element, Stale::Target)),
            }
        }
        // An earlier step of this sequence may have covered, hidden, or disabled it.
        if continuation && (!element.enabled() || element.offscreen()) {
            return Err(format!(
                "ref {reference} is disabled or off screen after an earlier step; take a fresh snapshot/find"
            ));
        }
        Ok((element, window))
    }

    /// Whether a changed name is the text a native edit holds: a Win32 edit is
    /// named after its own text, which input changes, so that name is not
    /// identity. A relabelled control never reads so.
    fn name_is_text(&self, element: &Rc<dyn Element>) -> bool {
        let handle = element.native_handle();
        handle != 0
            && self
                .desktop
                .background()
                .and_then(|background| background.native_state(handle, "type"))
                .is_some_and(|state| state == format!("native_text={}", element.name()))
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
        let (_, window) = self.ref_record(&reference)?;
        let point = self.show_reference_pointer(&reference, "prepare");
        if point.is_some() {
            sleep_ms(self.last_glide_wait_ms());
        }
        let result = self.guarded_semantic(req, parse_window_id(&window), op)?;
        if let (Some((x, y)), Some(result)) = (point, result.as_ref()) {
            if result.get("delivery_accepted") == Some(&json!(true)) {
                self.report_pointer(x, y, false, effect);
            }
        }
        Ok(result)
    }

    /// A background call to a target the person is not in runs under the
    /// platform's activation guard (Invoke-BackgroundWindow,
    /// input-semantic.ps1:32-141), whose facts the reply reports.
    fn guarded_semantic(
        &self,
        req: &Req,
        target: Wid,
        op: impl FnOnce(&Host) -> Res<Option<Obj>>,
    ) -> Res<Option<Obj>> {
        if req.delivery_foreground() || self.desktop.foreground() == target {
            return op(self);
        }
        // The guard runs an op that answers an object; None (leave the action
        // to the native route) travels beside it.
        let mut op = Some(op);
        let mut declined = false;
        let mut guarded = || -> Res<Obj> {
            let op = op.take().ok_or("the guarded operation already ran")?;
            Ok(op(self)?.unwrap_or_else(|| {
                declined = true;
                Obj::new()
            }))
        };
        // The id of the line being served, which the lease is asked for.
        let request_id = self.feedback.borrow().id;
        let (result, facts) =
            self.desktop
                .guard_semantic(target, request_id, &*self.lease, &mut guarded);
        if facts.is_some() {
            self.activation_facts.replace(facts);
        }
        result.map(|result| (!declined).then_some(result))
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

    /// Runs `body` with `target` kept inactive from its first delivery to its
    /// last: one settle and one foreground recovery when it ends, not one
    /// between deliveries (BeginInactive / EndInactive). A scope that cannot
    /// end cleanly outranks the body's own error.
    pub(in crate::host) fn within_scope<T>(
        &self,
        background: &dyn crate::platform::Background,
        target: Wid,
        body: impl FnOnce() -> Res<T>,
    ) -> Res<T> {
        background.begin_scope(target)?;
        let outcome = body();
        background.end_scope(target)?;
        outcome
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
            let (mut target, mut preferred) = (info.handle, 0);
            let action = step.text("action");
            if let Some(reference) = step.str("ref") {
                let (element, window) = self.ref_record(&reference)?;
                if action == "type" && element.settable() {
                    continue;
                }
                target = parse_window_id(&window);
                // A ref names its exact child, as the typing and key routes use it.
                if element.source() != "msaa" || action == "key" {
                    preferred = element.native_handle();
                }
            }
            // The grammar and the target first, then the dialog (ValidateBackgroundInput,
            // MixWin32Keyboard.cs:305-317; backgroundDialogInputError).
            let keys = step.str("keys");
            background.validate_target(target, preferred, &action, keys.as_deref())?;
            if let Some(refusal) = background.dialog_refusal(target, preferred, &action, keys.as_deref()) {
                return Err(refusal);
            }
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
        // One no-activate hold per target window spans the sequence's steps and
        // the settles between them (sequence.ps1:30-52); the settle and the
        // foreground recovery run once, when the hold ends. A step marked
        // input_continues leaves it for the next step; any other step, a failed
        // one, or the session's held-input cleanup ends it.
        let handle = parse_window_id(&step.text("window_id"));
        let continues = step.bool_true("input_continues");
        self.begin_sequence_hold(handle)?;
        let mut hold_ended = false;
        let outcome = (|| -> Res<Obj> {
            let started = now_ms();
            let before = self.window_snapshot()?;
            let before_ms = now_ms() - started;
            // Handle rechecks the original request's authorization and all input
            // guards. A dispatched step is never retried.
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
            // The last step recovers the foreground before the windows are read back.
            if !continues || result.get("delivery_accepted") == Some(&json!(false)) {
                hold_ended = true;
                self.end_sequence_hold(handle)?;
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
        })();
        // A step the host cannot read back stops its sequence, so its hold ends too.
        let ended = if !hold_ended && (!continues || outcome.is_err()) {
            self.end_sequence_hold(handle)
        } else {
            Ok(())
        };
        ended?;
        outcome
    }

    /// Opens the sequence's hold on `handle` unless it already has one; a hold
    /// another window's earlier steps left behind ends first.
    fn begin_sequence_hold(&self, handle: Wid) -> Res<()> {
        let Some(background) = self.desktop.background() else {
            return Ok(());
        };
        let stale: Vec<Wid> = self.session(|session| {
            let others = session
                .inactive_scopes
                .keys()
                .filter(|window| **window != handle);
            others.copied().collect()
        });
        let mut failure = None;
        for window in stale {
            self.session(|session| session.inactive_scopes.remove(&window));
            if let Err(error) = background.end_scope(window) {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        if self.session(|session| session.inactive_scopes.contains_key(&handle)) {
            return Ok(());
        }
        background.begin_scope(handle)?;
        self.session(|session| session.inactive_scopes.insert(handle, 1));
        Ok(())
    }

    fn end_sequence_hold(&self, handle: Wid) -> Res<()> {
        let Some(background) = self.desktop.background() else {
            return Ok(());
        };
        if self
            .session(|session| session.inactive_scopes.remove(&handle))
            .is_none()
        {
            return Ok(());
        }
        background.end_scope(handle)
    }

    pub(super) fn do_wait(&self, req: &Req) -> Res<Obj> {
        let seconds = req.f64("duration").unwrap_or(1.0);
        if !(0.0..=30.0).contains(&seconds) {
            return Err("wait duration must be 0..30 seconds".into());
        }
        quiet::wait(self, req, seconds)
    }

    /// Ends the no-activate scopes a sequence kept across its steps
    /// (Release-SequenceHolds, sequence.ps1:76-88); every one is ended even
    /// when another fails.
    pub(super) fn release_sequence_holds(&self) -> Res<Obj> {
        let held: Vec<Wid> = self.session(|session| {
            std::mem::take(&mut session.inactive_scopes)
                .into_keys()
                .collect()
        });
        let mut released = 0;
        let mut failure = None;
        for window in held {
            let ended = match self.desktop.background() {
                Some(background) => background.end_scope(window),
                None => Ok(()),
            };
            match ended {
                Ok(()) => released += 1,
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(obj! { "text" => "sequence holds released", "released" => released })
    }
}
