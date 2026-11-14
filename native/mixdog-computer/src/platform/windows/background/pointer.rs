//! Background pointer input: buttons, the wheel and drags, as messages to the
//! child window under the point.

use super::super::native::{self, hwnd};
use super::{belongs_to_top, bound, drops, is_chromium, refuse_dropped, send, with_release, Msg, MsgError, WinBackground};
use crate::keys::Mod;
use crate::platform::{window_id, Wid};
use std::time::Duration;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, ScreenToClient, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, GetDpiForWindow, PhysicalToLogicalPointForPerMonitorDPI, MDT_EFFECTIVE_DPI,
};

const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MBUTTONUP: u32 = 0x0208;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_MOUSEHWHEEL: u32 = 0x020E;
const MK_LBUTTON: usize = 0x1;
const MK_RBUTTON: usize = 0x2;
const MK_SHIFT: usize = 0x4;
const MK_CONTROL: usize = 0x8;
const MK_MBUTTON: usize = 0x10;

fn point_param(x: i32, y: i32) -> isize {
    (((y & 0xFFFF) << 16) | (x & 0xFFFF)) as isize
}

fn client_point(target: Wid, x: i32, y: i32) -> Msg<POINT> {
    let mut point = POINT { x, y };
    // SAFETY: point is a valid in/out pointer.
    if unsafe { ScreenToClient(hwnd(target), &mut point) }.as_bool() {
        Ok(point)
    } else {
        Err(MsgError::plain(
            "background_message_rejected|could not map point into target window",
        ))
    }
}

/// The point a target's own pointer messages carry: a window that is not
/// per-monitor aware reads its messages in its own DPI, as the system converts
/// real input for it.
fn message_point(target: Wid, x: i32, y: i32) -> Msg<POINT> {
    let physical = client_point(target, x, y)?;
    let (mut monitor_dpi, mut unused) = (0u32, 0u32);
    // SAFETY: both are valid out pointers.
    let read = unsafe {
        GetDpiForMonitor(
            MonitorFromWindow(hwnd(target), MONITOR_DEFAULTTONEAREST),
            MDT_EFFECTIVE_DPI,
            &mut monitor_dpi,
            &mut unused,
        )
    };
    if read.is_err() || monitor_dpi == 0 {
        return Err(MsgError::plain(
            "background_message_rejected|could not read the target monitor DPI",
        ));
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
        return Err(MsgError::plain(
            "stale_target|native message target is stale or invalid",
        ));
    }
    match native::rect(top) {
        Some(bounds) if x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom => {}
        _ => {
            return Err(MsgError::plain(
                "target_mismatch|native message point is outside the exact target window",
            ))
        }
    }
    let mut current = top;
    for _ in 0..32 {
        let Some(child) = native::child_at(current, x, y) else {
            break;
        };
        let surface = native::class_name(child);
        if surface == "Microsoft.UI.Content.DesktopChildSiteBridge"
            || surface == "Windows.UI.Core.CoreWindow"
        {
            return Err(MsgError::plain("background_unsupported|this WinUI or UWP surface ignores posted pointer messages; use a semantic ref or explicit foreground delivery; no input sent"));
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
                )))
            }
        }
    }
    Ok(flags)
}

fn mouse_click(target: Wid, point: isize, modifiers: usize, down: u32, up: u32, button: usize) -> Result<(), String> {
    let release = bound(target, move || {
        send(target, up, modifiers, point).map(|_| ())
    });
    with_release(
        || send(target, down, modifiers | button, point).map(|_| ()),
        || Ok(()),
        &release,
    )
}

impl WinBackground {
    pub(super) fn send_pointer(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        kind: &str,
        modifiers: &[Mod],
    ) -> Result<String, String> {
        self.while_inactive(window, || {
            let target = message_target_at(window, x, y).map_err(|error| error.text)?;
            let p = message_point(target, x, y).map_err(|error| error.text)?;
            let point = point_param(p.x, p.y);
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            if !["move", "right", "middle", "click", "double", "triple", "press", "release"].contains(&kind) {
                return Err(format!("background_unsupported|unknown background pointer action: {kind}"));
            }
            // A release lets go of what an accepted press holds, so it is never refused.
            if kind != "release" {
                refuse_dropped(window, target, if kind == "move" { drops::Kind::Move } else { drops::Kind::Click })?;
            }
            // The message target is often a renderer child whose own class says
            // nothing about the host, so the top level decides too.
            if (kind == "double" || kind == "triple")
                && (is_chromium(&native::class_name(target)) || is_chromium(&native::class_name(window)))
            {
                return Err("background_unsupported|target renderer ignores a posted double-click; use explicit foreground delivery; no input sent".into());
            }
            send(target, WM_MOUSEMOVE, flags, point).map_err(|error| error.text)?;
            match kind {
                "move" => {}
                "press" => {
                    send(target, WM_LBUTTONDOWN, flags | MK_LBUTTON, point).map_err(|error| error.text)?;
                }
                "release" => {
                    send(target, WM_LBUTTONUP, flags, point).map_err(|error| error.text)?;
                }
                "right" => mouse_click(target, point, flags, WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON)?,
                "middle" => mouse_click(target, point, flags, WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON)?,
                _ => {
                    mouse_click(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)?;
                    if kind == "double" || kind == "triple" {
                        std::thread::sleep(Duration::from_millis(20));
                        mouse_click(target, point, flags, WM_LBUTTONDBLCLK, WM_LBUTTONUP, MK_LBUTTON)?;
                    }
                    if kind == "triple" {
                        std::thread::sleep(Duration::from_millis(20));
                        mouse_click(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)?;
                    }
                }
            }
            Ok(window_id(target))
        })
    }

    pub(super) fn send_wheel(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        clicks: i32,
        horizontal: bool,
        modifiers: &[Mod],
    ) -> Result<String, String> {
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
            send(target, WM_MOUSEMOVE, flags, point_param(client.x, client.y)).map_err(|error| error.text)?;
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
            send(
                target,
                if horizontal { WM_MOUSEHWHEEL } else { WM_MOUSEWHEEL },
                packed,
                point_param(screen.x, screen.y),
            )
            .map_err(|error| error.text)?;
            Ok(window_id(target))
        })
    }

    pub(super) fn send_drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        if points.len() < 2 {
            return Err("drag path requires at least two points".into());
        }
        self.while_inactive(window, || {
            let target = message_target_at(window, points[0].0, points[0].1).map_err(|error| error.text)?;
            for (x, y) in &points[1..] {
                message_target_at(window, *x, *y).map_err(|error| error.text)?;
            }
            refuse_dropped(window, target, drops::Kind::Move)?;
            let start = message_point(target, points[0].0, points[0].1).map_err(|error| error.text)?;
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            send(target, WM_MOUSEMOVE, flags, point_param(start.x, start.y)).map_err(|error| error.text)?;
            let last = std::rc::Rc::new(std::cell::Cell::new(start));
            let release = bound(target, {
                let last = last.clone();
                move || {
                    let point = last.get();
                    send(target, WM_LBUTTONUP, flags, point_param(point.x, point.y)).map(|_| ())
                }
            });
            with_release(
                || send(target, WM_LBUTTONDOWN, flags | MK_LBUTTON, point_param(start.x, start.y)).map(|_| ()),
                || {
                    for pair in points.windows(2) {
                        let ((from_x, from_y), (to_x, to_y)) = (pair[0], pair[1]);
                        for step in 1..=12 {
                            let x = from_x + (to_x - from_x) * step / 12;
                            let y = from_y + (to_y - from_y) * step / 12;
                            let point = message_point(target, x, y)?;
                            last.set(point);
                            send(target, WM_MOUSEMOVE, flags | MK_LBUTTON, point_param(point.x, point.y))?;
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    }
                    Ok(())
                },
                &release,
            )?;
            Ok(window_id(target))
        })
    }
}
