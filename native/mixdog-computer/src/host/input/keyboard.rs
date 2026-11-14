//! Typing targets, key presses and holds, text entry.

use super::Point;
use crate::a11y::Element;
use crate::host::{sleep_ms, Host, Res};
use crate::keys::{self, Key, KeySink};
use crate::platform::{parse_window_id, window_id, Button, Wid};
use crate::protocol::{Obj, Req};
use serde_json::json;
use std::rc::Rc;

pub(super) struct ForegroundKeys<'a> {
    pub(super) host: &'a Host,
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
    fn resolve_glyph(&self, glyph: char) -> Option<(u16, Vec<keys::Mod>)> {
        self.host.desktop.resolve_glyph(glyph)
    }
}

/// How a background `type` reaches its control.
#[derive(Debug, PartialEq)]
enum TypeRoute {
    Keyboard,
    Value,
    Refuse,
}

/// The route for a ref (Do-Type, runtime-typing.ps1:158-178): posted keys to
/// the ref's exact native child when it takes them, else its own value only
/// where that is not a replacement of what a web editor holds, else a refusal.
/// A child that exists but refuses keys still goes to the keyboard route, which
/// names why. `value_target` is Test-BackgroundValueTarget.
fn type_route(has_native_target: bool, keyboard_ok: bool, value_target: bool) -> TypeRoute {
    if has_native_target && keyboard_ok {
        TypeRoute::Keyboard
    } else if value_target {
        TypeRoute::Value
    } else if has_native_target {
        TypeRoute::Keyboard
    } else {
        TypeRoute::Refuse
    }
}

/// Test-BackgroundValueTarget (input-semantic.ps1:405-428): a settable element
/// outside a Chromium/Electron host (Excel cells are never `settable`); an MSAA
/// ref always qualifies.
fn is_value_target(element: &dyn Element, web_content_host: bool) -> bool {
    element.source() == "msaa" || (element.settable() && !web_content_host)
}

const NO_NATIVE_KEY_TARGET: &str =
    "element has no exact native keyboard target; use explicit foreground delivery";
const NO_NATIVE_TYPE_ROUTE: &str = "element exposes no native keyboard target and no value route that keeps existing text; use set_value to replace its value, or explicit foreground delivery";

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
            // A ref names its exact native child; one without its own window
            // would send to whichever control has focus (Do-Key,
            // runtime-typing.ps1:41-44, :67-77).
            let preferred = element.as_ref().map_or(0, |element| element.native_handle());
            if element.is_some() && preferred == 0 {
                return Ok(self.background_unavailable(
                    "key",
                    NO_NATIVE_KEY_TARGET,
                    id,
                    "background_unsupported",
                    false,
                ));
            }
            let before = element
                .as_ref()
                .and_then(|element| self.observable_state(element, "key"));
            if let Err(error) = self.authorize(req, target) {
                return self.background_failure("key", &error, id, false);
            }
            return match background.keys_to(target, preferred, &keys_text) {
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
            let sink = &mut ForegroundKeys { host: self };
            if down {
                let (modifiers, key) =
                    keys::held_key(&keys_text, &|glyph| sink.resolve_glyph(glyph))?;
                keys::press(&modifiers, key, sink)?;
                self.session(|session| {
                    session.held_keys.retain(|(held, ..)| held != &keys_text);
                    session.held_keys.push((keys_text.clone(), modifiers, key));
                });
                return Ok(());
            }
            // The key this stream was pressed as, not what the layout in front
            // makes of it now.
            let pressed = self.session(|session| {
                let at = session.held_keys.iter().position(|(held, ..)| held == &keys_text)?;
                let (_, modifiers, key) = session.held_keys.remove(at);
                Some((modifiers, key))
            });
            let (modifiers, key) = match pressed {
                Some(pressed) => pressed,
                None => keys::held_key(&keys_text, &|glyph| sink.resolve_glyph(glyph))?,
            };
            keys::lift(&modifiers, key, sink)
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
            let background = match self.background_or_unsupported("type", id.clone()) {
                Ok(background) => background,
                Err(result) => return Ok(result),
            };
            // Keyboard messages to the ref's exact child first; its own value
            // only where that keeps what is there; never UIA SetFocus, which
            // can activate the target (Do-Type, runtime-typing.ps1:158-178).
            let mut preferred = 0;
            if let Some(element) = &element {
                if element.source() != "msaa" {
                    preferred = element.native_handle();
                }
                let keyboard_ok = preferred != 0
                    && background.validate_target(target, preferred, "type", None).is_ok();
                let value_target =
                    is_value_target(element.as_ref(), background.is_web_content_host(target));
                match type_route(preferred != 0, keyboard_ok, value_target) {
                    TypeRoute::Keyboard => {}
                    TypeRoute::Value => {
                        let mut valued = self.background_semantic(req, "type", |host| {
                            host.do_set_value(req, &text)
                        })?;
                        valued.insert("action".into(), json!("type"));
                        return Ok(valued);
                    }
                    TypeRoute::Refuse => {
                        return Ok(self.background_unavailable(
                            "type",
                            NO_NATIVE_TYPE_ROUTE,
                            id,
                            "background_unsupported",
                            false,
                        ))
                    }
                }
            }
            let before = element
                .as_ref()
                .and_then(|element| self.observable_state(element, "type"));
            let mut pointer_completed = false;
            // One hold covers the click, the wait and the text, so the target is
            // never activatable between them (runtime-typing.ps1:190-204).
            let outcome = self.within_scope(background, target, || -> Res<String> {
                if let (Some(x), Some(y)) = (req.int("x"), req.int("y")) {
                    background.pointer(target, x as i32, y as i32, "click", &[])?;
                    pointer_completed = true;
                    sleep_ms(80);
                }
                self.authorize(req, target)?;
                background.text_to(target, preferred, &text)
            });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_route_table() {
        // (has exact child, keyboard accepts it, value target) -> route
        let table = [
            (true, true, true, TypeRoute::Keyboard),
            (true, true, false, TypeRoute::Keyboard),
            // A host that drops posted keys takes the value, unless it is web content.
            (true, false, true, TypeRoute::Value),
            (true, false, false, TypeRoute::Keyboard),
            (false, false, true, TypeRoute::Value),
            (false, false, false, TypeRoute::Refuse),
        ];
        for (native, keyboard, value, route) in table {
            assert_eq!(type_route(native, keyboard, value), route, "{native} {keyboard} {value}");
        }
    }

    #[test]
    fn refusal_texts_match_the_script() {
        assert!(NO_NATIVE_KEY_TARGET.starts_with("element has no exact native keyboard target;"));
        assert!(NO_NATIVE_TYPE_ROUTE.contains("no native keyboard target and no value route that keeps existing text"));
    }
}
