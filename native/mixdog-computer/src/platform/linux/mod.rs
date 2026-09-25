//! Linux desktops. An X11 session is driven through EWMH, XTest and
//! synthetic events; a Wayland session through the desktop portal. Both read
//! accessibility over AT-SPI.

mod apps;
mod atspi;
mod clipboard;
mod compositor;
mod keysym;
mod mpx;
mod observe;
mod uinput;
mod wayland;
mod x11;

use super::unsupported::Unsupported;
use super::{AppEntry, Background, Button, Desktop, Launched, WinState, WindowInfo, Wid};
use crate::a11y::{Accessibility, MenuOutcome, Node};
use crate::keys::{Key, Mod};
use crate::observer::Shared;
use atspi::Atspi;
use serde_json::Value;
use std::cell::RefCell;
use std::sync::Arc;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::wrapper::ConnectionExt as _;

pub fn wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var("XDG_SESSION_TYPE").map_or(true, |kind| kind == "wayland")
}

pub fn create(observer: Arc<Shared>, _marker: i64) -> Box<dyn Desktop> {
    if wayland_session() {
        observe::start_session_idle(observer);
        return Box::new(wayland::WaylandDesktop::new());
    }
    match x11::X11::new() {
        Ok(x11) => {
            observe::start_x11(observer);
            Box::new(X11Desktop { x11, atspi: RefCell::new(None), mpx: mpx::Mpx })
        }
        Err(error) => Box::new(Unsupported::new(format!(
            "display_unavailable: no X11 display to drive ({error}); run inside a desktop session with DISPLAY set"
        ))),
    }
}

/// Releases modifiers and buttons still down, through XTest, and removes the
/// private input masters of hosts that are gone.
pub fn release_owned_input() -> Result<(), String> {
    if wayland_session() {
        return Ok(());
    }
    let (conn, root) = x11::connect()?;
    mpx::remove_stale(&conn);
    let pointer = conn.query_pointer(root).map_err(|error| error.to_string())?.reply().map_err(|error| error.to_string())?;
    let mask = u16::from(pointer.mask);
    for (bit, button) in [(0x100u16, 1u8), (0x200, 2), (0x400, 3)] {
        if mask & bit != 0 {
            conn.xtest_fake_input(x11rb::protocol::xproto::BUTTON_RELEASE_EVENT, button, x11rb::CURRENT_TIME, root, 0, 0, 0).map_err(|error| error.to_string())?;
        }
    }
    let keymap = conn.query_keymap().map_err(|error| error.to_string())?.reply().map_err(|error| error.to_string())?;
    let modifiers = conn.get_modifier_mapping().map_err(|error| error.to_string())?.reply().map_err(|error| error.to_string())?;
    for code in modifiers.keycodes.iter().copied().filter(|code| *code != 0) {
        if keymap.keys[(code / 8) as usize] & (1 << (code % 8)) != 0 {
            conn.xtest_fake_input(x11rb::protocol::xproto::KEY_RELEASE_EVENT, code, x11rb::CURRENT_TIME, root, 0, 0, 0).map_err(|error| error.to_string())?;
        }
    }
    conn.sync().map_err(|error| error.to_string())
}

pub struct X11Desktop {
    x11: x11::X11,
    atspi: RefCell<Option<Atspi>>,
    mpx: mpx::Mpx,
}

impl Drop for X11Desktop {
    fn drop(&mut self) {
        self.mpx.release(&self.x11);
    }
}

impl X11Desktop {
    fn atspi(&self) -> Result<Atspi, String> {
        if let Some(atspi) = self.atspi.borrow().as_ref() {
            return Ok(atspi.clone());
        }
        let atspi = Atspi::connect()?;
        *self.atspi.borrow_mut() = Some(atspi.clone());
        Ok(atspi)
    }

    fn background_route(&self) -> mpx::MpxRoute<'_> {
        mpx::MpxRoute { mpx: &self.mpx, x11: &self.x11 }
    }
}

impl Desktop for X11Desktop {
    fn name(&self) -> &'static str {
        "x11"
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        let active = self.x11.active();
        Ok(self.x11.clients().into_iter().filter_map(|window| self.x11.info(window, active)).collect())
    }

    fn info(&self, handle: Wid) -> Option<WindowInfo> {
        let window = u32::try_from(handle).ok()?;
        if !self.x11.clients().contains(&window) {
            return None;
        }
        self.x11.info(window, self.x11.active())
    }

    fn foreground(&self) -> Wid {
        self.x11.active() as Wid
    }

    fn focus(&self, handle: Wid) -> bool {
        u32::try_from(handle).is_ok_and(|window| self.x11.focus(window))
    }

    fn window_at_point(&self, x: i32, y: i32) -> Wid {
        self.x11.window_at_point(x, y)
    }

    fn related_windows(&self, handle: Wid) -> Vec<Wid> {
        let Some(pid) = self.info(handle).map(|info| info.pid).filter(|pid| *pid > 0) else { return Vec::new() };
        self.x11
            .clients()
            .into_iter()
            .filter(|window| *window as Wid != handle && self.x11.pid(*window) == pid)
            .map(|window| window as Wid)
            .collect()
    }

    fn is_owned_by(&self, candidate: Wid, owner: Wid) -> bool {
        if candidate == 0 || owner == 0 || candidate == owner {
            return false;
        }
        match (self.info(candidate), self.info(owner)) {
            (Some(candidate), Some(owner_info)) => candidate.owner == owner || (candidate.pid > 0 && candidate.pid == owner_info.pid),
            _ => false,
        }
    }

    fn move_window(&self, handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        self.x11.move_window(handle as u32, x, y, width, height)
    }

    fn set_window_state(&self, handle: Wid, state: WinState) -> Result<(), String> {
        self.x11.set_state(handle as u32, state)
    }

    fn close_window(&self, handle: Wid) -> Result<bool, String> {
        self.x11.close(handle as u32)
    }

    fn is_responding(&self, handle: Wid) -> bool {
        self.x11.responding(handle as u32)
    }

    fn cursor(&self) -> (i32, i32) {
        self.x11.cursor()
    }

    fn move_pointer(&self, x: i32, y: i32) -> Result<(), String> {
        self.x11.motion(x, y)
    }

    fn button(&self, button: Button, down: bool, x: i32, y: i32, _clicks: u32) -> Result<(), String> {
        if self.x11.cursor() != (x, y) {
            self.x11.motion(x, y)?;
        }
        self.x11.button(x11::button_number(button), down)
    }

    fn drag_move(&self, x: i32, y: i32) -> Result<(), String> {
        self.x11.motion(x, y)
    }

    fn wheel(&self, x: i32, y: i32, clicks: i32, horizontal: bool) -> Result<(), String> {
        if self.x11.cursor() != (x, y) {
            self.x11.motion(x, y)?;
        }
        let button = match (horizontal, clicks > 0) {
            (false, true) => 5,
            (false, false) => 4,
            (true, true) => 7,
            (true, false) => 6,
        };
        for _ in 0..clicks.unsigned_abs() {
            self.x11.button(button, true)?;
            self.x11.button(button, false)?;
        }
        Ok(())
    }

    fn key(&self, key: Key, down: bool) -> Result<(), String> {
        let result = self.x11.key(key, down);
        if !down {
            self.x11.restore_borrowed();
        }
        result
    }

    fn text(&self, text: &str) -> Result<(), String> {
        self.x11.text(text)
    }

    fn input_held(&self) -> bool {
        self.x11.input_held()
    }

    fn desktop_ready(&self) -> bool {
        self.x11.screen_active()
    }

    fn background(&self) -> Option<&dyn Background> {
        Some(self)
    }

    fn accessibility(&self) -> Option<&dyn Accessibility> {
        Some(self)
    }

    fn clipboard_read(&self) -> Result<String, String> {
        self.x11.clipboard_read()
    }

    fn clipboard_write(&self, text: &str) -> Result<bool, String> {
        if text.is_empty() {
            self.x11
                .conn
                .set_selection_owner(x11rb::NONE, self.x11.atoms.CLIPBOARD, x11rb::CURRENT_TIME)
                .map_err(|error| error.to_string())?;
            self.x11.conn.flush().map_err(|error| error.to_string())?;
            return Ok(self.x11.clipboard_read()?.is_empty());
        }
        clipboard::own(text.to_string())?;
        Ok(self.x11.clipboard_read()? == text)
    }

    fn launch(&self, target: &str, app: Option<&AppEntry>) -> Result<Launched, String> {
        apps::launch(target, app)
    }

    fn installed_apps(&self) -> Result<Vec<AppEntry>, String> {
        Ok(apps::installed())
    }

    fn ocr(&self, image: &[u8], language: &str, max_words: usize) -> Result<Value, String> {
        apps::ocr(image, language, max_words)
    }

    fn ocr_status(&self, language: &str) -> Value {
        apps::ocr_status(language)
    }
}

impl Background for X11Desktop {
    fn validate(&self, window: Wid, action: &str) -> Result<(), String> {
        self.background_route().validate(window, action)
    }
    fn pointer(&self, window: Wid, x: i32, y: i32, kind: &str, modifiers: &[Mod]) -> Result<String, String> {
        self.background_route().pointer(window, x, y, kind, modifiers)
    }
    fn wheel(&self, window: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod]) -> Result<String, String> {
        self.background_route().wheel(window, x, y, clicks, horizontal, modifiers)
    }
    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        self.background_route().drag(window, points, modifiers)
    }
    fn keys(&self, window: Wid, keys: &str) -> Result<String, String> {
        self.background_route().keys(window, keys)
    }
    fn text(&self, window: Wid, text: &str) -> Result<String, String> {
        self.background_route().text(window, text)
    }
}

impl Accessibility for X11Desktop {
    fn available(&self) -> Result<(), String> {
        self.atspi().map(|_| ())
    }

    fn snapshot(&self, window: &WindowInfo, include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String> {
        self.atspi()?.snapshot(window, include_noninteractive, limit)
    }

    fn focused_masked(&self) -> bool {
        let Ok(atspi) = self.atspi() else { return true };
        let Some(window) = self.info(self.foreground()) else { return true };
        match atspi.frame_for(&window) {
            Ok(frame) => atspi.focused_masked(&frame),
            Err(_) => true,
        }
    }

    fn invoke_menu(&self, window: &WindowInfo, path: &[String], authorize: &dyn Fn() -> Result<(), String>) -> Result<MenuOutcome, String> {
        self.atspi()?.invoke_menu(window, path, authorize)
    }
}
