//! Background pointer input: buttons, the wheel and drags, as messages to the
//! child window under the point.

use super::super::native::{self, hwnd};
use super::{Msg, MsgError, WinBackground, belongs_to_top, confirm_release, drops, is_chromium, refuse_dropped, send, with_release};
use crate::keys::Mod;
use crate::platform::{Wid, window_id};
use crate::port::windows::{Message, MouseButton, Pressed, WinPort};
use std::time::Duration;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow, ScreenToClient};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI, PhysicalToLogicalPointForPerMonitorDPI};

const MK_SHIFT: usize = 0x4;
const MK_CONTROL: usize = 0x8;

fn point_param(x: i32, y: i32) -> isize {
    (((y & 0xFFFF) << 16) | (x & 0xFFFF)) as isize
}

fn client_point(target: Wid, x: i32, y: i32) -> Msg<POINT> {
    let mut point = POINT { x, y };
    // SAFETY: point is a valid in/out pointer.
    if unsafe { ScreenToClient(hwnd(target), &mut point) }.as_bool() {
        Ok(point)
    } else {
        Err(MsgError::plain("background_message_rejected|could not map point into target window"))
    }
}

/// The point a target's own pointer messages carry: a window that is not
/// per-monitor aware reads its messages in its own DPI, as the system converts
/// real input for it.
fn message_point(target: Wid, x: i32, y: i32) -> Msg<POINT> {
    let physical = client_point(target, x, y)?;
    let (mut monitor_dpi, mut unused) = (0u32, 0u32);
    // SAFETY: both are valid out pointers.
    let read = unsafe { GetDpiForMonitor(MonitorFromWindow(hwnd(target), MONITOR_DEFAULTTONEAREST), MDT_EFFECTIVE_DPI, &mut monitor_dpi, &mut unused) };
    if read.is_err() || monitor_dpi == 0 {
        return Err(MsgError::plain("background_message_rejected|could not read the target monitor DPI"));
    }
    let window_dpi = unsafe { GetDpiForWindow(hwnd(target)) } as f64;
    Ok(POINT {
        x: (physical.x as f64 * window_dpi / monitor_dpi as f64).round() as i32,
        y: (physical.y as f64 * window_dpi / monitor_dpi as f64).round() as i32,
    })
}

/// The window a pointer message at the screen point goes to: the deepest
/// same-process child under it, refusing surfaces that read pointers only from
/// the system input stack.
fn message_target_at(top: Wid, x: i32, y: i32) -> Msg<Wid> {
    if !native::is_window(top) {
        return Err(MsgError::plain("stale_target|native message target is stale or invalid"));
    }
    match native::rect(top) {
        Some(bounds) if x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom => {}
        _ => return Err(MsgError::plain("target_mismatch|native message point is outside the exact target window")),
    }
    let mut current = top;
    for _ in 0..32 {
        let Some(child) = native::child_at(current, x, y) else {
            break;
        };
        let surface = native::class_name(child);
        if surface == "Microsoft.UI.Content.DesktopChildSiteBridge" || surface == "Windows.UI.Core.CoreWindow" {
            return Err(MsgError::plain(
                "background_unsupported|this WinUI or UWP surface ignores posted pointer messages; use a semantic ref or explicit foreground delivery; no input sent",
            ));
        }
        if !belongs_to_top(top, child) {
            break;
        }
        current = child;
    }
    Ok(current)
}

fn pointer_flags(modifiers: &[Mod]) -> Msg<usize> {
    let mut flags = 0;
    for modifier in modifiers {
        match modifier {
            Mod::Ctrl => flags |= MK_CONTROL,
            Mod::Shift => flags |= MK_SHIFT,
            other => {
                return Err(MsgError::plain(format!(
                    "background_unsupported|background pointer messages support only ctrl/shift modifiers; use explicit foreground delivery for {}",
                    format!("{other:?}").to_lowercase()
                )));
            }
        }
    }
    Ok(flags)
}

/// One click: the press through the port, and the release its receipt names.
fn mouse_click(port: &WinPort, top: Wid, target: Wid, press: Message) -> Result<(), String> {
    with_release(port, top, target, press, || Ok(()))
}

impl WinBackground {
    pub(super) fn send_pointer(&self, window: Wid, x: i32, y: i32, kind: &str, modifiers: &[Mod]) -> Result<String, String> {
        // A held button is let go of through its receipt alone: no motion, no hold and no recovery ride along.
        if kind == "release" {
            if let Some(released) = self.release_held_button(window) {
                return released;
            }
        }
        let port = &*self.port;
        self.while_inactive(window, || {
            let target = message_target_at(window, x, y).map_err(|error| error.text)?;
            let p = message_point(target, x, y).map_err(|error| error.text)?;
            let point = point_param(p.x, p.y);
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            if !["move", "right", "middle", "click", "double", "triple", "press", "release"].contains(&kind) {
                return Err(format!("background_unsupported|unknown background pointer action: {kind}"));
            }
            refuse_dropped(window, target, if kind == "move" { drops::Kind::Move } else { drops::Kind::Click })?;
            // The message target is often a renderer child whose own class says
            // nothing about the host, so the top level decides too.
            if (kind == "double" || kind == "triple") && (is_chromium(&native::class_name(target)) || is_chromium(&native::class_name(window))) {
                return Err("background_unsupported|target renderer ignores a posted double-click; use explicit foreground delivery; no input sent".into());
            }
            send(port, window, target, Message::MouseMove { flags, point }).map_err(|error| error.text)?;
            let click = |button| Message::ButtonDown { button, flags, point };
            match kind {
                "move" => {}
                "press" => {
                    send(port, window, target, click(MouseButton::Left)).map_err(|error| error.text)?;
                }
                // Nothing of this port's is held here: an ordinary button up the caller asked for.
                "release" => {
                    send(port, window, target, Message::ButtonUp { button: MouseButton::Left, flags, point }).map_err(|error| error.text)?;
                }
                "right" => mouse_click(port, window, target, click(MouseButton::Right))?,
                "middle" => mouse_click(port, window, target, click(MouseButton::Middle))?,
                _ => {
                    mouse_click(port, window, target, click(MouseButton::Left))?;
                    // The gap between the clicks holds nothing: each next press is arbitrated again.
                    if kind == "double" || kind == "triple" {
                        std::thread::sleep(Duration::from_millis(20));
                        mouse_click(port, window, target, Message::DoubleClick { flags, point })?;
                    }
                    if kind == "triple" {
                        std::thread::sleep(Duration::from_millis(20));
                        mouse_click(port, window, target, click(MouseButton::Left))?;
                    }
                }
            }
            Ok(window_id(target))
        })
    }

    /// The left button a press left held in `window`, let go of through its receipt; None when the port holds none there.
    fn release_held_button(&self, window: Wid) -> Option<Result<String, String>> {
        let target = self.port.release_button(window, MouseButton::Left)?;
        Some(match target {
            Ok(reply) => {
                if self.port.wait(&reply, super::REPLY_WAIT).is_some() {
                    Ok(window_id(window))
                } else {
                    confirm_release(&self.port, window, 0, Pressed::Button(MouseButton::Left)).map(|()| window_id(window))
                }
            }
            Err(crate::port::windows::Refusal::Gone) => Ok(window_id(window)),
            Err(refusal) => Err(super::refused(refusal).text),
        })
    }

    pub(super) fn send_wheel(&self, window: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod]) -> Result<String, String> {
        let port = &*self.port;
        self.while_inactive(window, || {
            let target = message_target_at(window, x, y).map_err(|error| error.text)?;
            // Chromium reroutes a wheel message to whatever window is on top at
            // its point, so the target would never scroll; refuse before sending.
            if (is_chromium(&native::class_name(target)) || is_chromium(&native::class_name(window)))
                && native::window_at_point(x, y) != window
            {
                return Err("background_unsupported|the scroll point is covered by another window, so a background wheel would be dropped or reach that window; no input sent".into());
            }
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            let client = message_point(target, x, y).map_err(|error| error.text)?;
            send(port, window, target, Message::MouseMove { flags, point: point_param(client.x, client.y) })
                .map_err(|error| error.text)?;
            // The host's positive clicks scroll the content down or right; the
            // wheel's positive delta scrolls up, but right for the horizontal wheel.
            let notches = if horizontal { clicks } else { -clicks };
            let delta = (notches * 120).clamp(-12000, 12000);
            let packed = (((delta & 0xFFFF) as usize) << 16) | flags;
            let mut screen = POINT { x, y };
            // SAFETY: screen is a valid in/out pointer.
            if !unsafe { PhysicalToLogicalPointForPerMonitorDPI(Some(hwnd(target)), &mut screen) }.as_bool() {
                return Err("background_message_rejected|could not map point into target window DPI".to_string());
            }
            send(port, window, target, Message::Wheel { horizontal, packed, point: point_param(screen.x, screen.y) })
                .map_err(|error| error.text)?;
            Ok(window_id(target))
        })
    }

    pub(super) fn send_drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        if points.len() < 2 {
            return Err("drag path requires at least two points".into());
        }
        let port = &*self.port;
        self.while_inactive(window, || {
            let target = message_target_at(window, points[0].0, points[0].1).map_err(|error| error.text)?;
            for (x, y) in &points[1..] {
                message_target_at(window, *x, *y).map_err(|error| error.text)?;
            }
            refuse_dropped(window, target, drops::Kind::Move)?;
            let start = message_point(target, points[0].0, points[0].1).map_err(|error| error.text)?;
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            send(port, window, target, Message::MouseMove { flags, point: point_param(start.x, start.y) }).map_err(|error| error.text)?;
            let press = Message::ButtonDown { button: MouseButton::Left, flags, point: point_param(start.x, start.y) };
            // Each motion is a submission of its own (the port moves the held button's release point with it); the pause
            // between steps holds nothing. Revoked meanwhile, the next motion is refused and the receipt lets go of the button.
            with_release(port, window, target, press, || {
                for pair in points.windows(2) {
                    let ((from_x, from_y), (to_x, to_y)) = (pair[0], pair[1]);
                    for step in 1..=12 {
                        let x = from_x + (to_x - from_x) * step / 12;
                        let y = from_y + (to_y - from_y) * step / 12;
                        let point = message_point(target, x, y)?;
                        send(port, window, target, Message::MouseMove { flags, point: point_param(point.x, point.y) })?;
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
                Ok(())
            })?;
            Ok(window_id(target))
        })
    }
}
