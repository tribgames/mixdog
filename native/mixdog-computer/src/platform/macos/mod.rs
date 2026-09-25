//! The macOS desktop: CoreGraphics windows and events, the AX tree, Vision
//! OCR, and per-process event delivery for background input.

// Apple's constant names are kept as the SDK spells them.
#![allow(non_upper_case_globals)]

mod apps;
mod appkit;
mod ax;
mod ffi;
mod input;
mod observe;
mod ocr;
mod skylight;
mod windows;

use super::{AppEntry, Background, Button, Desktop, Launched, WinState, WindowInfo, Wid};
use crate::a11y::Accessibility;
use crate::keys::{self, Key, Mod};
use crate::observer::Shared;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use ffi::*;
use input::{button_events, flag, flags_of, keycode, Poster, ProcessKeys, Route};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

fn require_trust() -> Result<(), String> {
    if trusted() {
        return Ok(());
    }
    prompt_trust();
    Err("accessibility_permission_required: allow Mixdog under System Settings > Privacy & Security > Accessibility, then retry".into())
}

fn window_pid(handle: Wid) -> Result<i32, String> {
    windows::one(handle)
        .map(|window| window.pid)
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "stale_target|the target window no longer exists; no input sent".to_string())
}

pub fn release_owned_input() -> Result<(), String> {
    input::release_held(crate::config::input_marker())
}

pub struct MacBackground {
    poster: Poster,
}

impl MacBackground {
    fn click(&self, pid: i32, window: u32, x: f64, y: f64, button: Button, count: u32, flags: u64) -> Result<(), String> {
        let (down, up, number) = button_events(button);
        for press in 1..=count {
            self.poster.mouse(down, x, y, number, press, Route::Process(pid), window, flags)?;
            self.poster.mouse(up, x, y, number, press, Route::Process(pid), window, flags)?;
        }
        Ok(())
    }
}

impl Background for MacBackground {
    fn validate(&self, window: Wid, _action: &str) -> Result<(), String> {
        require_trust().map_err(|error| format!("background_unsupported|{error}"))?;
        window_pid(window).map(|_| ())
    }

    fn pointer(&self, window: Wid, x: i32, y: i32, kind: &str, modifiers: &[Mod]) -> Result<String, String> {
        self.validate(window, kind)?;
        let pid = window_pid(window)?;
        let flags = flags_of(modifiers);
        let (fx, fy, number) = (x as f64, y as f64, window as u32);
        match kind {
            "click" => self.click(pid, number, fx, fy, Button::Left, 1, flags)?,
            "double" => self.click(pid, number, fx, fy, Button::Left, 2, flags)?,
            "triple" => self.click(pid, number, fx, fy, Button::Left, 3, flags)?,
            "right" => self.click(pid, number, fx, fy, Button::Right, 1, flags)?,
            "middle" => self.click(pid, number, fx, fy, Button::Middle, 1, flags)?,
            "move" => self.poster.mouse(kCGEventMouseMoved, fx, fy, 0, 1, Route::Process(pid), number, flags)?,
            "press" => self.poster.mouse(kCGEventLeftMouseDown, fx, fy, 0, 1, Route::Process(pid), number, flags)?,
            "release" => self.poster.mouse(kCGEventLeftMouseUp, fx, fy, 0, 1, Route::Process(pid), number, flags)?,
            other => return Err(format!("background_unsupported|pointer kind {other} has no background route; no input sent")),
        }
        Ok(format!("pid {pid}"))
    }

    fn wheel(&self, window: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod]) -> Result<String, String> {
        self.validate(window, "scroll")?;
        let pid = window_pid(window)?;
        self.poster.mouse(kCGEventMouseMoved, x as f64, y as f64, 0, 1, Route::Process(pid), window as u32, 0)?;
        self.poster.wheel(x as f64, y as f64, clicks, horizontal, Route::Process(pid), flags_of(modifiers))?;
        Ok(format!("pid {pid}"))
    }

    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        self.validate(window, "drag")?;
        let pid = window_pid(window)?;
        let flags = flags_of(modifiers);
        let number = window as u32;
        let (x0, y0) = points[0];
        self.poster.mouse(kCGEventLeftMouseDown, x0 as f64, y0 as f64, 0, 1, Route::Process(pid), number, flags)?;
        let travel = (|| -> Result<(), String> {
            for pair in points.windows(2) {
                let ((fx, fy), (tx, ty)) = (pair[0], pair[1]);
                for step in 1..=12 {
                    let x = fx + (tx - fx) * step / 12;
                    let y = fy + (ty - fy) * step / 12;
                    self.poster.mouse(kCGEventLeftMouseDragged, x as f64, y as f64, 0, 1, Route::Process(pid), number, flags)?;
                    std::thread::sleep(std::time::Duration::from_millis(12));
                }
            }
            Ok(())
        })();
        let (lx, ly) = points[points.len() - 1];
        let released = self.poster.mouse(kCGEventLeftMouseUp, lx as f64, ly as f64, 0, 1, Route::Process(pid), number, flags);
        travel?;
        released.map_err(|error| format!("input_cleanup_unconfirmed: background drag release failed: {error}"))?;
        Ok(format!("pid {pid}"))
    }

    fn keys(&self, window: Wid, keys_text: &str) -> Result<String, String> {
        self.validate(window, "key")?;
        let pid = window_pid(window)?;
        if keys::is_plain_text(keys_text) {
            self.poster.text(keys_text, Route::Process(pid))?;
        } else {
            keys::send(keys_text, &mut ProcessKeys { poster: &self.poster, pid, flags: 0 })?;
        }
        Ok(format!("pid {pid}"))
    }

    fn text(&self, window: Wid, text: &str) -> Result<String, String> {
        self.validate(window, "type")?;
        let pid = window_pid(window)?;
        self.poster.text(text, Route::Process(pid))?;
        Ok(format!("pid {pid}"))
    }
}

pub struct MacDesktop {
    poster: Poster,
    accessibility: ax::MacAccessibility,
    background: MacBackground,
    host_pid: i32,
    /// Frames of windows this host maximized, restored on `restore`.
    restore_frames: RefCell<HashMap<Wid, CGRect>>,
}

impl MacDesktop {
    pub fn new(observer: Arc<Shared>, marker: i64) -> MacDesktop {
        observe::start(observer, marker);
        MacDesktop {
            poster: Poster::new(marker),
            accessibility: ax::MacAccessibility::new(),
            background: MacBackground { poster: Poster::new(marker) },
            host_pid: std::os::unix::process::parent_id() as i32,
            restore_frames: RefCell::new(HashMap::new()),
        }
    }

    fn ax_window(&self, handle: Wid) -> Result<windows::AxWindow, String> {
        require_trust()?;
        let pid = window_pid(handle).map_err(|_| format!("window_id is stale or invalid: {}", super::window_id(handle)))?;
        windows::ax_window(pid, handle).ok_or_else(|| format!("window has no accessibility root: {}", super::window_id(handle)))
    }

    fn set_frame(&self, element: &CFType, frame: CGRect) -> Result<(), String> {
        let position = ax_set(element.as_CFTypeRef(), "AXPosition", &ax_point_value(frame.origin));
        let size = ax_set(element.as_CFTypeRef(), "AXSize", &ax_size_value(frame.size));
        // A size change near a screen edge can push the origin; set it again.
        ax_set(element.as_CFTypeRef(), "AXPosition", &ax_point_value(frame.origin));
        if position != kAXErrorSuccess && size != kAXErrorSuccess {
            return Err(format!("the window refused its new frame (AX error {position}/{size})"));
        }
        Ok(())
    }

    fn post_system_mouse(&self, kind: u32, x: i32, y: i32, button: u32, clicks: u32) -> Result<(), String> {
        require_trust()?;
        self.poster.mouse(kind, x as f64, y as f64, button, clicks, Route::System, 0, self.poster.flags.get())
    }
}

impl Desktop for MacDesktop {
    fn name(&self) -> &'static str {
        "macos"
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        Ok(windows::list())
    }

    fn info(&self, handle: Wid) -> Option<WindowInfo> {
        windows::info(handle)
    }

    fn foreground(&self) -> Wid {
        windows::focused_window()
    }

    fn focus(&self, handle: Wid) -> bool {
        let Ok(window) = self.ax_window(handle) else { return false };
        if window.minimized {
            ax_set(window.element.as_CFTypeRef(), "AXMinimized", &cf_bool(false));
        }
        let pid = ax_pid(window.element.as_CFTypeRef());
        appkit::activate(pid);
        ax_perform(window.element.as_CFTypeRef(), "AXRaise");
        ax_set(window.element.as_CFTypeRef(), "AXMain", &cf_bool(true));
        for _ in 0..25 {
            if windows::focused_window() == handle {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    fn window_at_point(&self, x: i32, y: i32) -> Wid {
        let (fx, fy) = (x as f64, y as f64);
        windows::onscreen()
            .into_iter()
            .filter(|window| window.alpha > 0.0 && window.bounds.size.width > 1.0 && window.bounds.size.height > 1.0)
            // This app's own floating overlays let the pointer through.
            .filter(|window| !(window.pid == self.host_pid && window.layer > 0))
            .find(|window| {
                let rect = window.bounds;
                fx >= rect.origin.x && fy >= rect.origin.y && fx < rect.origin.x + rect.size.width && fy < rect.origin.y + rect.size.height
            })
            .map_or(0, |window| window.number as Wid)
    }

    fn related_windows(&self, handle: Wid) -> Vec<Wid> {
        let Some(pid) = windows::one(handle).map(|window| window.pid) else { return Vec::new() };
        windows::onscreen()
            .into_iter()
            .filter(|window| window.pid == pid && window.number as Wid != handle)
            .map(|window| window.number as Wid)
            .collect()
    }

    fn is_owned_by(&self, candidate: Wid, owner: Wid) -> bool {
        if candidate == 0 || owner == 0 || candidate == owner {
            return false;
        }
        match (windows::one(candidate), windows::one(owner)) {
            (Some(candidate), Some(owner)) => candidate.pid == owner.pid,
            _ => false,
        }
    }

    fn move_window(&self, handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        let window = self.ax_window(handle)?;
        let frame = CGRect { origin: CGPoint { x: x as f64, y: y as f64 }, size: CGSize { width: width as f64, height: height as f64 } };
        self.set_frame(&window.element, frame)
    }

    fn set_window_state(&self, handle: Wid, state: WinState) -> Result<(), String> {
        let window = self.ax_window(handle)?;
        let element = window.element.as_CFTypeRef();
        match state {
            WinState::Minimize => {
                ax_set(element, "AXMinimized", &cf_bool(true));
            }
            WinState::Maximize => {
                if window.minimized {
                    ax_set(element, "AXMinimized", &cf_bool(false));
                }
                let visible = windows::visible_frame_for(&window.frame).ok_or("no screen holds this window")?;
                self.restore_frames.borrow_mut().entry(handle).or_insert(window.frame);
                self.set_frame(&window.element, visible)?;
            }
            WinState::Restore => {
                if window.minimized {
                    ax_set(element, "AXMinimized", &cf_bool(false));
                }
                if window.fullscreen {
                    ax_set(element, "AXFullScreen", &cf_bool(false));
                }
                if let Some(frame) = self.restore_frames.borrow_mut().remove(&handle) {
                    self.set_frame(&window.element, frame)?;
                }
            }
        }
        Ok(())
    }

    fn close_window(&self, handle: Wid) -> Result<bool, String> {
        let window = self.ax_window(handle)?;
        let Ok(button) = ax_copy(window.element.as_CFTypeRef(), "AXCloseButton") else { return Ok(false) };
        Ok(ax_perform(button.as_CFTypeRef(), "AXPress") == kAXErrorSuccess)
    }

    /// A hung application stops answering accessibility queries.
    fn is_responding(&self, handle: Wid) -> bool {
        let Ok(pid) = window_pid(handle) else { return false };
        let app = application(pid);
        // SAFETY: shortens the timeout on this one element.
        unsafe { AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), 1.0) };
        !matches!(ax_copy(app.as_CFTypeRef(), "AXRole"), Err(kAXErrorCannotComplete))
    }

    fn cursor(&self) -> (i32, i32) {
        let (x, y) = input::cursor();
        (x.round() as i32, y.round() as i32)
    }

    fn move_pointer(&self, x: i32, y: i32) -> Result<(), String> {
        self.post_system_mouse(kCGEventMouseMoved, x, y, 0, 1)
    }

    fn button(&self, button: Button, down: bool, x: i32, y: i32, clicks: u32) -> Result<(), String> {
        let (down_kind, up_kind, number) = button_events(button);
        self.post_system_mouse(if down { down_kind } else { up_kind }, x, y, number, clicks)
    }

    fn drag_move(&self, x: i32, y: i32) -> Result<(), String> {
        self.post_system_mouse(kCGEventLeftMouseDragged, x, y, kCGMouseButtonLeft, 1)
    }

    fn wheel(&self, x: i32, y: i32, clicks: i32, horizontal: bool) -> Result<(), String> {
        require_trust()?;
        self.poster.wheel(x as f64, y as f64, clicks, horizontal, Route::System, self.poster.flags.get())
    }

    fn key(&self, key: Key, down: bool) -> Result<(), String> {
        require_trust()?;
        if let Key::Mod(modifier) = key {
            let mask = flag(modifier);
            self.poster.flags.set(if down { self.poster.flags.get() | mask } else { self.poster.flags.get() & !mask });
        }
        self.poster.key(keycode(key)?, down, Route::System, self.poster.flags.get())
    }

    fn text(&self, text: &str) -> Result<(), String> {
        require_trust()?;
        self.poster.text(text, Route::System)
    }

    fn input_held(&self) -> bool {
        input::input_held()
    }

    fn desktop_ready(&self) -> bool {
        // SAFETY: returns a +1 dictionary describing the login session, or null.
        let session = unsafe { CGSessionCopyCurrentDictionary() };
        if session.is_null() {
            return false;
        }
        // SAFETY: the dictionary came back under the create rule.
        let session: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(session) };
        let locked = session
            .find(&CFString::new("CGSSessionScreenIsLocked"))
            .and_then(|value| value.downcast::<CFBoolean>())
            .is_some_and(bool::from);
        !locked
    }

    fn background(&self) -> Option<&dyn Background> {
        Some(&self.background)
    }

    fn accessibility(&self) -> Option<&dyn Accessibility> {
        Some(&self.accessibility)
    }

    fn clipboard_read(&self) -> Result<String, String> {
        Ok(appkit::pasteboard_read())
    }

    fn clipboard_write(&self, text: &str) -> Result<bool, String> {
        Ok(appkit::pasteboard_write(text))
    }

    fn launch(&self, target: &str, app: Option<&AppEntry>) -> Result<Launched, String> {
        apps::launch(target, app)
    }

    fn installed_apps(&self) -> Result<Vec<AppEntry>, String> {
        Ok(apps::installed())
    }

    fn ocr(&self, image: &[u8], language: &str, max_words: usize) -> Result<Value, String> {
        ocr::recognize(image, language, max_words)
    }

    fn ocr_status(&self, language: &str) -> Value {
        ocr::status(language)
    }
}
