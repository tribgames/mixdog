//! The Windows desktop: Win32 windows and `SendInput` for foreground input,
//! window messages for background input, UI Automation for the accessibility
//! tree, the shell for launching, and Windows OCR.

mod background;
mod input;
mod native;
mod observe;
mod shell;
mod uia;

use super::{
    AppEntry, Background, Button, Desktop, Integrity, Launched, Surface, Wid, WinState, WindowInfo,
};
use crate::a11y::Accessibility;
use crate::keys::Key;
use crate::observer::Shared;
use serde_json::Value;
use std::sync::Arc;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

pub fn release_owned_input() -> Result<(), String> {
    input::release_owned(crate::config::input_marker())
}

pub fn terminate_pid(pid: i64) -> Result<(), String> {
    if pid <= 0 || pid > u32::MAX as i64 {
        return Err(format!("invalid pid {pid}"));
    }
    native::terminate(pid as u32)
}

pub fn parent_pid(pid: i64) -> i64 {
    if pid <= 0 || pid > u32::MAX as i64 {
        return 0;
    }
    native::parent_pid(pid as u32) as i64
}

pub struct WinDesktop {
    sender: input::Sender,
    background: background::WinBackground,
    accessibility: Option<uia::Uia>,
}

impl WinDesktop {
    pub fn new(observer: Arc<Shared>, marker: i64) -> WinDesktop {
        // SAFETY: process-wide setup on the thread that serves every request.
        // UI Automation hit-tests and the pointer move in physical pixels, so
        // the host must be per-monitor aware for both sides to agree on a point.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let sender = input::Sender::new(marker);
        observe::start(observer.clone(), marker);
        WinDesktop {
            sender,
            background: background::WinBackground::new(observer.clone()),
            accessibility: uia::Uia::new(observer).ok(),
        }
    }
}

impl Desktop for WinDesktop {
    fn name(&self) -> &'static str {
        "windows"
    }

    fn element_source(&self) -> &'static str {
        "uia"
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        Ok(native::shown_windows(true))
    }

    fn info(&self, handle: Wid) -> Option<WindowInfo> {
        native::info(handle, true)
    }

    fn foreground(&self) -> Wid {
        native::foreground()
    }

    fn focus(&self, handle: Wid) -> bool {
        native::focus(handle)
    }

    fn window_at_point(&self, x: i32, y: i32) -> Wid {
        native::window_at_point(x, y)
    }

    fn related_windows(&self, handle: Wid) -> Vec<Wid> {
        native::related_windows(handle)
    }

    fn is_owned_by(&self, candidate: Wid, owner: Wid) -> bool {
        native::is_owned_by(candidate, owner)
    }

    fn is_contained(&self, candidate: Wid, surface: Wid) -> bool {
        candidate != 0
            && (candidate == surface || native::is_contained_same_process(candidate, surface))
    }

    fn integrity(&self, handle: Wid) -> Option<Integrity> {
        Some(native::integrity(handle))
    }

    fn window_surface(&self, handle: Wid) -> Result<Surface, String> {
        native::window_surface(handle)
    }

    fn move_window(&self, handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        native::move_window(handle, x, y, width, height)
    }

    fn set_window_state(&self, handle: Wid, state: WinState) -> Result<(), String> {
        native::show(handle, state);
        Ok(())
    }

    fn close_window(&self, handle: Wid) -> Result<bool, String> {
        native::close(handle)
    }

    fn is_responding(&self, handle: Wid) -> bool {
        native::is_responding(handle)
    }

    fn cursor(&self) -> (i32, i32) {
        native::cursor()
    }

    fn move_pointer(&self, x: i32, y: i32) -> Result<(), String> {
        self.sender.move_to(x, y)
    }

    fn button(&self, button: Button, down: bool, _x: i32, _y: i32, _clicks: u32) -> Result<(), String> {
        self.sender.button(button, down)
    }

    fn drag_move(&self, x: i32, y: i32) -> Result<(), String> {
        self.sender.move_to(x, y)
    }

    fn wheel(&self, x: i32, y: i32, clicks: i32, horizontal: bool) -> Result<(), String> {
        self.sender.move_to(x, y)?;
        self.sender.wheel(clicks, horizontal)
    }

    fn key(&self, key: Key, down: bool) -> Result<(), String> {
        self.sender.key(key, down)
    }

    fn text(&self, text: &str) -> Result<(), String> {
        self.sender.text(text)
    }

    fn input_held(&self) -> bool {
        input::any_held()
    }

    fn desktop_ready(&self) -> bool {
        input::desktop_ready()
    }

    fn background(&self) -> Option<&dyn Background> {
        Some(&self.background)
    }

    fn accessibility(&self) -> Option<&dyn Accessibility> {
        self.accessibility.as_ref().map(|uia| uia as &dyn Accessibility)
    }

    fn clipboard_read(&self) -> Result<String, String> {
        shell::clipboard_read()
    }

    fn clipboard_write(&self, text: &str) -> Result<bool, String> {
        shell::clipboard_write(text)
    }

    fn launch(&self, target: &str, app: Option<&AppEntry>) -> Result<Launched, String> {
        shell::launch(target, app)
    }

    fn installed_apps(&self) -> Result<Vec<AppEntry>, String> {
        shell::installed_apps()
    }

    fn ocr(&self, image: &[u8], language: &str, max_words: usize) -> Result<Value, String> {
        shell::ocr(image, language, max_words)
    }

    fn ocr_status(&self, language: &str) -> Value {
        shell::ocr_status(language)
    }
}
