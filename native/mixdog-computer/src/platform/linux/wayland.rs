//! The Wayland desktop. The compositor names and controls windows, a
//! uinput device carries pointer and keyboard input, and AT-SPI carries the
//! accessibility tree and every semantic action. Wayland lets no client send
//! input to one window, so there is no background pixel route.

use super::atspi::Atspi;
use super::compositor::Compositor;
use super::{apps, uinput};
use crate::a11y::{Accessibility, MenuOutcome, Node};
use crate::keys::{glyph_key, Key, Mod, Named};
use crate::platform::{AppEntry, Background, Button, Desktop, Launched, WinState, WindowInfo, Wid};
use serde_json::Value;
use std::cell::{Cell, RefCell};

pub struct WaylandDesktop {
    compositor: Compositor,
    atspi: RefCell<Option<Atspi>>,
    device: RefCell<Option<uinput::Device>>,
    /// Where this host last put the pointer, for compositors that do not
    /// report the pointer to other programs.
    pointer: Cell<(i32, i32)>,
}

/// The desktop area from the compositor, or the one the desktop app reports.
fn desktop_bounds(compositor: Compositor) -> Option<(i32, i32, i32, i32)> {
    compositor.desktop_bounds().or_else(|| {
        let text = std::env::var("MIXDOG_COMPUTER_DESKTOP_BOUNDS").ok()?;
        let parts: Vec<i32> = text.split(',').filter_map(|part| part.trim().parse().ok()).collect();
        (parts.len() == 4 && parts[2] > 0 && parts[3] > 0).then(|| (parts[0], parts[1], parts[2], parts[3]))
    })
}

impl WaylandDesktop {
    pub fn new() -> WaylandDesktop {
        WaylandDesktop { compositor: Compositor::detect(), atspi: RefCell::new(None), device: RefCell::new(None), pointer: Cell::new((0, 0)) }
    }

    fn atspi(&self) -> Result<Atspi, String> {
        if let Some(atspi) = self.atspi.borrow().as_ref() {
            return Ok(atspi.clone());
        }
        let atspi = Atspi::connect()?;
        *self.atspi.borrow_mut() = Some(atspi.clone());
        Ok(atspi)
    }

    fn with_device<T>(&self, action: impl FnOnce(&uinput::Device) -> Result<T, String>) -> Result<T, String> {
        if self.device.borrow().is_none() {
            let bounds = desktop_bounds(self.compositor)
                .ok_or("input_unavailable: the desktop size is unknown; the desktop app passes it at launch")?;
            *self.device.borrow_mut() = Some(uinput::Device::create(bounds)?);
        }
        action(self.device.borrow().as_ref().expect("device created above"))
    }

    fn list(&self) -> Vec<WindowInfo> {
        self.compositor.windows().unwrap_or_default()
    }

    fn tap(&self, code: u16) -> Result<(), String> {
        self.with_device(|device| {
            device.key(code, true)?;
            device.key(code, false)
        })
    }
}

impl Desktop for WaylandDesktop {
    fn name(&self) -> &'static str {
        "wayland"
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        self.compositor.supported()?;
        Ok(self.list())
    }

    fn info(&self, handle: Wid) -> Option<WindowInfo> {
        self.list().into_iter().find(|window| window.handle == handle)
    }

    fn foreground(&self) -> Wid {
        self.list().into_iter().find(|window| window.focused).map_or(0, |window| window.handle)
    }

    fn focus(&self, handle: Wid) -> bool {
        if self.compositor.focus(handle).is_err() {
            return false;
        }
        for _ in 0..25 {
            if self.foreground() == handle {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    fn window_at_point(&self, x: i32, y: i32) -> Wid {
        self.list()
            .into_iter()
            .filter(|window| !window.minimized)
            .find(|window| x >= window.x && y >= window.y && x < window.x + window.width && y < window.y + window.height)
            .map_or(0, |window| window.handle)
    }

    fn related_windows(&self, handle: Wid) -> Vec<Wid> {
        let windows = self.list();
        let Some(pid) = windows.iter().find(|window| window.handle == handle).map(|window| window.pid) else { return Vec::new() };
        windows.into_iter().filter(|window| window.handle != handle && window.pid == pid).map(|window| window.handle).collect()
    }

    fn is_owned_by(&self, candidate: Wid, owner: Wid) -> bool {
        candidate != owner && candidate != 0 && self.related_windows(owner).contains(&candidate)
    }

    fn move_window(&self, handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        self.compositor.move_window(handle, x, y, width, height)
    }

    fn set_window_state(&self, handle: Wid, state: WinState) -> Result<(), String> {
        self.compositor.set_state(handle, state)
    }

    fn close_window(&self, handle: Wid) -> Result<bool, String> {
        self.compositor.close(handle)
    }

    fn is_responding(&self, handle: Wid) -> bool {
        let Some(pid) = self.info(handle).map(|window| window.pid) else { return false };
        let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|stat| stat[stat.rfind(')')? + 2..].chars().next());
        !matches!(state, Some('T') | Some('Z') | Some('t'))
    }

    fn cursor(&self) -> (i32, i32) {
        self.compositor.cursor().unwrap_or_else(|| self.pointer.get())
    }

    fn move_pointer(&self, x: i32, y: i32) -> Result<(), String> {
        self.with_device(|device| device.move_to(x, y))?;
        self.pointer.set((x, y));
        Ok(())
    }

    fn button(&self, button: Button, down: bool, x: i32, y: i32, _clicks: u32) -> Result<(), String> {
        self.move_pointer(x, y)?;
        let code = match button {
            Button::Left => uinput::BTN_LEFT,
            Button::Right => uinput::BTN_RIGHT,
            Button::Middle => uinput::BTN_MIDDLE,
        };
        self.with_device(|device| device.key(code, down))
    }

    fn drag_move(&self, x: i32, y: i32) -> Result<(), String> {
        self.move_pointer(x, y)
    }

    fn wheel(&self, x: i32, y: i32, clicks: i32, horizontal: bool) -> Result<(), String> {
        self.move_pointer(x, y)?;
        self.with_device(|device| device.wheel(clicks, horizontal))
    }

    fn key(&self, key: Key, down: bool) -> Result<(), String> {
        let code = uinput::code(key)?;
        self.with_device(|device| device.key(code, down))
    }

    /// Characters travel as the keys that type them on a US layout; text a
    /// US layout cannot type goes through set_value instead.
    fn text(&self, text: &str) -> Result<(), String> {
        for c in text.chars() {
            match c {
                '\n' | '\r' => self.tap(uinput::code(Key::Named(Named::Enter))?)?,
                '\t' => self.tap(uinput::code(Key::Named(Named::Tab))?)?,
                _ => {
                    let (base, shifted) = glyph_key(c).ok_or_else(|| format!("invalid_keys: '{c}' cannot be typed through the Wayland input device; use set_value for this text"))?;
                    let code = uinput::code(Key::Char(base))?;
                    let shift = uinput::code(Key::Mod(Mod::Shift))?;
                    self.with_device(|device| {
                        if shifted {
                            device.key(shift, true)?;
                        }
                        let typed = device.key(code, true).and_then(|_| device.key(code, false));
                        if shifted {
                            device.key(shift, false)?;
                        }
                        typed
                    })?;
                }
            }
        }
        Ok(())
    }

    fn input_held(&self) -> bool {
        false
    }

    fn background(&self) -> Option<&dyn Background> {
        None
    }

    fn accessibility(&self) -> Option<&dyn Accessibility> {
        Some(self)
    }

    fn clipboard_read(&self) -> Result<String, String> {
        apps::wayland_clipboard_read()
    }

    fn clipboard_write(&self, text: &str) -> Result<bool, String> {
        apps::wayland_clipboard_write(text)
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

impl Accessibility for WaylandDesktop {
    fn available(&self) -> Result<(), String> {
        self.atspi().map(|_| ())
    }

    fn snapshot(&self, window: &WindowInfo, include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String> {
        self.atspi()?.snapshot(window, include_noninteractive, limit)
    }

    fn focused_masked(&self) -> bool {
        let Ok(atspi) = self.atspi() else { return true };
        let Some(window) = self.info(self.foreground()) else { return true };
        atspi.frame_for(&window).map_or(true, |frame| atspi.focused_masked(&frame))
    }

    fn invoke_menu(&self, window: &WindowInfo, path: &[String], authorize: &dyn Fn() -> Result<(), String>) -> Result<MenuOutcome, String> {
        self.atspi()?.invoke_menu(window, path, authorize)
    }
}
