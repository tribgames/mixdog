//! Typing targets, key presses and holds, text entry.

use super::Point;
use crate::a11y::Element;
use crate::host::{sleep_ms, Host, Res};
use crate::keys::{self, Key, KeySink};
use crate::platform::{parse_window_id, window_id, Button, Wid};
use crate::protocol::{Obj, Req};
use serde_json::json;
use std::rc::Rc;

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

impl Host {
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
                (true, Some(x), Some(y)) => Some(Point {
                    x: x as i32,
                    y: y as i32,
                    target: handle,
                }),
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

    fn background_key_target(
        &self,
        req: &Req,
        action: &str,
    ) -> Result<(Wid, Option<Rc<dyn Element>>), Obj> {
        if let Some(reference) = req.str("ref") {
            return match self.ref_record(&reference) {
                Ok((element, window)) => Ok((parse_window_id(&window), Some(element))),
                Err(error) => {
                    Err(self.background_unavailable(action, &error, None, "stale_target", false))
                }
            };
        }
        if req.has("window_id") || req.has("window") {
            return match self.resolve_window(req) {
                Ok(info) => Ok((info.handle, None)),
                Err(error) => {
                    Err(self.background_unavailable(action, &error, None, "stale_target", false))
                }
            };
        }
        Err(self.background_unavailable(
            action,
            &format!("background {action} requires an exact ref or window_id"),
            None,
            "target_required",
            false,
        ))
    }

    pub(in crate::host) fn do_key(&self, req: &Req) -> Res<Obj> {
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
            let before = element
                .as_ref()
                .and_then(|element| self.observable_state(element, "key"));
            if let Err(error) = self.authorize(req, target) {
                return self.background_failure("key", &error, id, false);
            }
            return match background.keys(target, &keys_text) {
                Ok(message_target) => Ok(self.complete_native_action(
                    "key",
                    &message_target,
                    id,
                    before,
                    element.as_ref(),
                    "keys delivered as native key events",
                )),
                Err(error) => self.background_failure("key", &error, id, false),
            };
        }
        let (target, point) = self.typing_target(req, false)?;
        if !self.is_window(target) {
            return Ok(self.action_result(
                "key",
                "none",
                "suspected_noop",
                false,
                "key requires window_id/window or a prior focus_window in this session",
                Some("target_required"),
                "foreground",
                None,
            ));
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
    pub(in crate::host) fn do_key_hold(&self, req: &Req, down: bool) -> Res<Obj> {
        let action = if down { "key_down" } else { "key_up" };
        if !req.delivery_foreground() {
            return Ok(self.background_unavailable(
                action,
                "a held key requires the real keyboard; use explicit foreground delivery",
                None,
                "background_unsupported",
                false,
            ));
        }
        let keys_text = req.text("keys");
        let (target, point) = self.typing_target(req, false)?;
        if !self.is_window(target) {
            let message = format!(
                "{action} requires window_id/window or a prior focus_window in this session"
            );
            return Ok(self.action_result(
                action,
                "none",
                "suspected_noop",
                false,
                &message,
                Some("target_required"),
                "foreground",
                None,
            ));
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

    pub(in crate::host) fn do_type(&self, req: &Req) -> Res<Obj> {
        let text = req.text("text");
        if req.delivery_foreground() && text.encode_utf16().count() > self.cfg.max_foreground_text {
            return Err(format!(
                "input_too_large: foreground text exceeds {} UTF-16 code units",
                self.cfg.max_foreground_text
            ));
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
                    let mut valued = self
                        .background_semantic(req, "type", |host| host.do_set_value(req, &text))?;
                    valued.insert("action".into(), json!("type"));
                    return Ok(valued);
                }
                if let Err(error) = element.focus() {
                    let message = format!("element accepts no settable value and could not take keyboard focus ({error}); use explicit foreground delivery");
                    return Ok(self.background_unavailable(
                        "type",
                        &message,
                        id,
                        "background_unsupported",
                        false,
                    ));
                }
            }
            let background = match self.background_or_unsupported("type", id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            let before = element
                .as_ref()
                .and_then(|element| self.observable_state(element, "type"));
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
                    let message = format!(
                        "typed {} literal characters as native key events",
                        text.chars().count()
                    );
                    Ok(self.complete_native_action(
                        "type",
                        &message_target,
                        id,
                        before,
                        element.as_ref(),
                        &message,
                    ))
                }
                Err(error) => self.background_failure("type", &error, id, pointer_completed),
            };
        }
        let (target, point) = self.typing_target(req, true)?;
        if !self.is_window(target) {
            return Ok(self.action_result(
                "type",
                "none",
                "suspected_noop",
                false,
                "type requires window_id/window or a prior focus_window in this session",
                Some("target_required"),
                "foreground",
                None,
            ));
        }
        let mut body = || -> Res<()> {
            self.focus_typing_point(req, target, &point)?;
            self.report_typing_point(req, &point);
            self.fg_text(&text)
        };
        self.foreground_input(target, "type", false, &mut body)
    }
}
