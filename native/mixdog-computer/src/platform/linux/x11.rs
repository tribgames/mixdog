//! The X11 desktop through EWMH: the window manager's client list names the
//! windows, XTest drives the real pointer and keyboard, and synthetic events
//! sent to one window carry background input.

use super::keysym;
use crate::keys::Key;
use crate::platform::{Button, WinState, WindowInfo, Wid};
use std::cell::{Cell, RefCell};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::res::{ClientIdMask, ClientIdSpec, ConnectionExt as _};
use x11rb::protocol::screensaver::ConnectionExt as _;
use x11rb::protocol::xproto::{
    self, Atom, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, InputFocus, MapState, StackMode, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::CURRENT_TIME;

macro_rules! atoms {
    ($($name:ident),* $(,)?) => {
        #[allow(non_snake_case)]
        pub struct Atoms { $(pub $name: Atom,)* }
        impl Atoms {
            pub fn intern(conn: &RustConnection) -> Result<Atoms, String> {
                Ok(Atoms { $($name: conn.intern_atom(false, stringify!($name).as_bytes()).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.atom,)* })
            }
        }
    };
}

atoms!(
    _NET_CLIENT_LIST,
    _NET_CLIENT_LIST_STACKING,
    _NET_ACTIVE_WINDOW,
    _NET_WM_NAME,
    _NET_WM_PID,
    _NET_WM_STATE,
    _NET_WM_STATE_HIDDEN,
    _NET_WM_STATE_MAXIMIZED_VERT,
    _NET_WM_STATE_MAXIMIZED_HORZ,
    _NET_WM_STATE_FULLSCREEN,
    _NET_WM_STATE_ABOVE,
    _NET_FRAME_EXTENTS,
    _NET_CLOSE_WINDOW,
    _NET_MOVERESIZE_WINDOW,
    _NET_WM_PING,
    WM_PROTOCOLS,
    WM_CHANGE_STATE,
    UTF8_STRING,
    CLIPBOARD,
    TARGETS,
    TEXT,
    MIXDOG_SELECTION,
);

pub fn connect() -> Result<(RustConnection, Window), String> {
    let (conn, screen) = x11rb::connect(None).map_err(|error| format!("x11_unavailable: {error}"))?;
    let root = conn.setup().roots.get(screen).map(|screen| screen.root).ok_or("x11_unavailable: no screen")?;
    Ok((conn, root))
}

struct Keymap {
    min: u8,
    per: usize,
    syms: Vec<u32>,
}

impl Keymap {
    fn load(conn: &RustConnection) -> Result<Keymap, String> {
        let setup = conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(|error| error.to_string())?
            .reply()
            .map_err(|error| error.to_string())?;
        Ok(Keymap { min, per: reply.keysyms_per_keycode as usize, syms: reply.keysyms })
    }

    /// The keycode that types `sym`, and whether Shift selects it.
    fn find(&self, sym: u32) -> Option<(u8, bool)> {
        if self.per == 0 {
            return None;
        }
        for level in 0..self.per.min(2) {
            for (index, chunk) in self.syms.chunks(self.per).enumerate() {
                if chunk.get(level) == Some(&sym) {
                    return Some((self.min + index as u8, level == 1));
                }
            }
        }
        None
    }

    /// A keycode with no symbols, free to borrow for characters the layout lacks.
    fn spare(&self) -> Option<u8> {
        self.syms
            .chunks(self.per.max(1))
            .enumerate()
            .rev()
            .find(|(_, chunk)| chunk.iter().all(|sym| *sym == 0))
            .map(|(index, _)| self.min + index as u8)
    }
}

pub struct X11 {
    pub conn: RustConnection,
    pub root: Window,
    pub atoms: Atoms,
    host_pid: i64,
    keymap: RefCell<Keymap>,
    /// A borrowed spare keycode currently remapped, restored after typing.
    borrowed: Cell<Option<u8>>,
    selection_window: Window,
}

fn e<T: std::fmt::Display>(error: T) -> String {
    error.to_string()
}

impl X11 {
    pub fn new() -> Result<X11, String> {
        let (conn, root) = connect()?;
        let atoms = Atoms::intern(&conn)?;
        let keymap = Keymap::load(&conn)?;
        super::mpx::remove_stale(&conn);
        let selection_window = conn.generate_id().map_err(e)?;
        conn.create_window(0, selection_window, root, -1, -1, 1, 1, 0, xproto::WindowClass::INPUT_ONLY, 0, &Default::default())
            .map_err(e)?;
        conn.flush().map_err(e)?;
        Ok(X11 {
            conn,
            root,
            atoms,
            host_pid: std::os::unix::process::parent_id() as i64,
            keymap: RefCell::new(keymap),
            borrowed: Cell::new(None),
            selection_window,
        })
    }

    fn prop32(&self, window: Window, property: Atom, kind: impl Into<Atom>) -> Vec<u32> {
        self.conn
            .get_property(false, window, property, kind, 0, 4096)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().map(|values| values.collect()))
            .unwrap_or_default()
    }

    fn prop_text(&self, window: Window, property: Atom, kind: impl Into<Atom>) -> Vec<u8> {
        self.conn
            .get_property(false, window, property, kind, 0, 16384)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.value)
            .unwrap_or_default()
    }

    fn title(&self, window: Window) -> String {
        let utf8 = self.prop_text(window, self.atoms._NET_WM_NAME, self.atoms.UTF8_STRING);
        let bytes = if utf8.is_empty() { self.prop_text(window, AtomEnum::WM_NAME.into(), AtomEnum::ANY) } else { utf8 };
        String::from_utf8_lossy(&bytes).trim_end_matches('\0').to_string()
    }

    fn class(&self, window: Window) -> (String, String) {
        let bytes = self.prop_text(window, AtomEnum::WM_CLASS.into(), AtomEnum::STRING);
        let mut parts = bytes.split(|byte| *byte == 0).map(|part| String::from_utf8_lossy(part).into_owned());
        (parts.next().unwrap_or_default(), parts.next().unwrap_or_default())
    }

    pub fn pid(&self, window: Window) -> i64 {
        if let Some(pid) = self.prop32(window, self.atoms._NET_WM_PID, AtomEnum::CARDINAL).first() {
            return *pid as i64;
        }
        let spec = ClientIdSpec { client: window, mask: ClientIdMask::LOCAL_CLIENT_PID };
        self.conn
            .res_query_client_ids(&[spec])
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.ids.into_iter().find_map(|id| id.value.first().copied()))
            .map_or(0, |pid| pid as i64)
    }

    fn states(&self, window: Window) -> Vec<Atom> {
        self.prop32(window, self.atoms._NET_WM_STATE, AtomEnum::ATOM)
    }

    /// Managed windows, front to back.
    pub fn clients(&self) -> Vec<Window> {
        let mut list = self.prop32(self.root, self.atoms._NET_CLIENT_LIST_STACKING, AtomEnum::WINDOW);
        if list.is_empty() {
            list = self.prop32(self.root, self.atoms._NET_CLIENT_LIST, AtomEnum::WINDOW);
        }
        list.reverse();
        list
    }

    /// The window's client area in root coordinates.
    fn client_rect(&self, window: Window) -> Option<(i32, i32, i32, i32)> {
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        let origin = self.conn.translate_coordinates(window, self.root, 0, 0).ok()?.reply().ok()?;
        Some((origin.dst_x as i32, origin.dst_y as i32, geometry.width as i32, geometry.height as i32))
    }

    fn frame_rect(&self, window: Window) -> Option<(i32, i32, i32, i32)> {
        let (x, y, width, height) = self.client_rect(window)?;
        let extents = self.prop32(window, self.atoms._NET_FRAME_EXTENTS, AtomEnum::CARDINAL);
        let [left, right, top, bottom] = [0, 1, 2, 3].map(|index| extents.get(index).copied().unwrap_or(0) as i32);
        Some((x - left, y - top, width + left + right, height + top + bottom))
    }

    fn hidden(&self, window: Window, states: &[Atom]) -> bool {
        if states.contains(&self.atoms._NET_WM_STATE_HIDDEN) {
            return true;
        }
        let viewable = self
            .conn
            .get_window_attributes(window)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|attributes| attributes.map_state == MapState::VIEWABLE);
        !viewable
    }

    pub fn info(&self, window: Window, active: Window) -> Option<WindowInfo> {
        let (x, y, width, height) = self.client_rect(window)?;
        let states = self.states(window);
        let (instance, class) = self.class(window);
        let pid = self.pid(window);
        let app = if class.is_empty() {
            std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default().trim().to_string()
        } else {
            class
        };
        Some(WindowInfo {
            handle: window as Wid,
            title: self.title(window),
            class_name: instance,
            app,
            pid,
            parent_pid: crate::platform::parent_pid(pid),
            owner: self.prop32(window, AtomEnum::WM_TRANSIENT_FOR.into(), AtomEnum::WINDOW).first().copied().unwrap_or(0) as Wid,
            focused: window == active,
            minimized: self.hidden(window, &states),
            maximized: states.contains(&self.atoms._NET_WM_STATE_FULLSCREEN)
                || (states.contains(&self.atoms._NET_WM_STATE_MAXIMIZED_VERT) && states.contains(&self.atoms._NET_WM_STATE_MAXIMIZED_HORZ)),
            x,
            y,
            width,
            height,
            client: (x, y, width, height),
        })
    }

    pub fn active(&self) -> Window {
        self.prop32(self.root, self.atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW).first().copied().unwrap_or(0)
    }

    fn client_message(&self, window: Window, kind: Atom, data: [u32; 5]) -> Result<(), String> {
        let event = ClientMessageEvent::new(32, window, kind, data);
        self.conn
            .send_event(false, self.root, EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT, event)
            .map_err(e)?;
        self.conn.flush().map_err(e)
    }

    pub fn focus(&self, window: Window) -> bool {
        let current = self.active();
        let _ = self.client_message(window, self.atoms._NET_ACTIVE_WINDOW, [2, CURRENT_TIME, current, 0, 0]);
        for attempt in 0..30 {
            if self.active() == window {
                return true;
            }
            if attempt == 20 {
                // A window manager that ignores the request still honours a
                // direct raise and input focus.
                let _ = self.conn.configure_window(window, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
                let _ = self.conn.set_input_focus(InputFocus::PARENT, window, CURRENT_TIME);
                let _ = self.conn.flush();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    pub fn window_at_point(&self, x: i32, y: i32) -> Wid {
        for window in self.clients() {
            let states = self.states(window);
            if self.hidden(window, &states) {
                continue;
            }
            // This app's own always-on-top overlays let the pointer through.
            if states.contains(&self.atoms._NET_WM_STATE_ABOVE) && self.pid(window) == self.host_pid {
                continue;
            }
            if let Some((fx, fy, width, height)) = self.frame_rect(window) {
                if x >= fx && y >= fy && x < fx + width && y < fy + height {
                    return window as Wid;
                }
            }
        }
        0
    }

    pub fn move_window(&self, window: Window, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        // Static gravity: the coordinates are the client area's own.
        let flags = 10 | (0xF << 8) | (2 << 12);
        self.client_message(window, self.atoms._NET_MOVERESIZE_WINDOW, [flags, x as u32, y as u32, width as u32, height as u32])?;
        std::thread::sleep(Duration::from_millis(120));
        if self.client_rect(window) != Some((x, y, width, height)) {
            let aux = ConfigureWindowAux::new().x(x).y(y).width(width as u32).height(height as u32);
            self.conn.configure_window(window, &aux).map_err(e)?;
            self.conn.flush().map_err(e)?;
        }
        Ok(())
    }

    pub fn set_state(&self, window: Window, state: WinState) -> Result<(), String> {
        let atoms = &self.atoms;
        match state {
            WinState::Minimize => self.client_message(window, atoms.WM_CHANGE_STATE, [3, 0, 0, 0, 0]),
            WinState::Maximize => self.client_message(window, atoms._NET_WM_STATE, [1, atoms._NET_WM_STATE_MAXIMIZED_VERT, atoms._NET_WM_STATE_MAXIMIZED_HORZ, 2, 0]),
            WinState::Restore => {
                if self.hidden(window, &self.states(window)) {
                    self.client_message(window, atoms._NET_ACTIVE_WINDOW, [2, CURRENT_TIME, 0, 0, 0])?;
                }
                self.client_message(window, atoms._NET_WM_STATE, [0, atoms._NET_WM_STATE_MAXIMIZED_VERT, atoms._NET_WM_STATE_MAXIMIZED_HORZ, 2, 0])?;
                self.client_message(window, atoms._NET_WM_STATE, [0, atoms._NET_WM_STATE_FULLSCREEN, 0, 2, 0])
            }
        }
    }

    pub fn close(&self, window: Window) -> Result<bool, String> {
        self.client_message(window, self.atoms._NET_CLOSE_WINDOW, [CURRENT_TIME, 2, 0, 0, 0])?;
        Ok(true)
    }

    /// Answers to `_NET_WM_PING` within a second; without ping support, a
    /// stopped or dead process is the only unresponsive one.
    pub fn responding(&self, window: Window) -> bool {
        let protocols = self.prop32(window, self.atoms.WM_PROTOCOLS, AtomEnum::ATOM);
        if !protocols.contains(&self.atoms._NET_WM_PING) {
            let pid = self.pid(window);
            let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|stat| {
                let rest = stat[stat.rfind(')')? + 2..].to_string();
                rest.chars().next()
            });
            return !matches!(state, Some('T') | Some('Z') | Some('t'));
        }
        let Ok((conn, root)) = connect() else { return true };
        let listen = xproto::ChangeWindowAttributesAux::new().event_mask(EventMask::SUBSTRUCTURE_NOTIFY);
        if conn.change_window_attributes(root, &listen).is_err() {
            return true;
        }
        let stamp = 0x6d78_u32;
        let ping = ClientMessageEvent::new(32, window, self.atoms.WM_PROTOCOLS, [self.atoms._NET_WM_PING, stamp, window, 0, 0]);
        if conn.send_event(false, window, EventMask::NO_EVENT, ping).is_err() || conn.flush().is_err() {
            return true;
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(1000);
        while std::time::Instant::now() < deadline {
            while let Ok(Some(event)) = conn.poll_for_event() {
                if let Event::ClientMessage(message) = event {
                    let data = message.data.as_data32();
                    if message.type_ == self.atoms.WM_PROTOCOLS && data[0] == self.atoms._NET_WM_PING && data[2] == window {
                        return true;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    pub fn cursor(&self) -> (i32, i32) {
        self.conn
            .query_pointer(self.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map_or((0, 0), |pointer| (pointer.root_x as i32, pointer.root_y as i32))
    }

    fn fake(&self, kind: u8, detail: u8, x: i32, y: i32) -> Result<(), String> {
        self.conn.xtest_fake_input(kind, detail, CURRENT_TIME, self.root, x as i16, y as i16, 0).map_err(e)?;
        self.conn.sync().map_err(e)
    }

    pub fn motion(&self, x: i32, y: i32) -> Result<(), String> {
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, x, y)
    }

    pub fn button(&self, button: u8, down: bool) -> Result<(), String> {
        self.fake(if down { xproto::BUTTON_PRESS_EVENT } else { xproto::BUTTON_RELEASE_EVENT }, button, 0, 0)
    }

    fn key_code(&self, code: u8, down: bool) -> Result<(), String> {
        self.fake(if down { xproto::KEY_PRESS_EVENT } else { xproto::KEY_RELEASE_EVENT }, code, 0, 0)
    }

    /// The keycode for `sym`, borrowing a spare keycode when the layout has none.
    pub(crate) fn code_for(&self, sym: u32) -> Result<(u8, bool), String> {
        if let Some(found) = self.keymap.borrow().find(sym) {
            return Ok(found);
        }
        let spare = self.borrowed.get().or_else(|| self.keymap.borrow().spare()).ok_or("invalid_keys: no spare keycode to type this character")?;
        self.conn.change_keyboard_mapping(1, spare, 2, &[sym, sym]).map_err(e)?;
        self.conn.sync().map_err(e)?;
        self.borrowed.set(Some(spare));
        *self.keymap.borrow_mut() = Keymap::load(&self.conn)?;
        std::thread::sleep(Duration::from_millis(15));
        Ok((spare, false))
    }

    /// Returns a borrowed keycode to having no symbols.
    pub fn restore_borrowed(&self) {
        if let Some(spare) = self.borrowed.take() {
            let _ = self.conn.change_keyboard_mapping(1, spare, 2, &[0, 0]);
            let _ = self.conn.sync();
            if let Ok(keymap) = Keymap::load(&self.conn) {
                *self.keymap.borrow_mut() = keymap;
            }
        }
    }

    pub fn key(&self, key: Key, down: bool) -> Result<(), String> {
        let (code, _) = self.code_for(keysym::of_key(key)?)?;
        self.key_code(code, down)
    }

    pub fn text(&self, text: &str) -> Result<(), String> {
        let result = (|| -> Result<(), String> {
            for c in text.chars() {
                let sym = match c {
                    '\n' | '\r' => keysym::RETURN,
                    '\t' => keysym::TAB,
                    _ => keysym::of_char(c),
                };
                let (code, shift) = self.code_for(sym)?;
                let shift_code = if shift { Some(self.code_for(keysym::SHIFT_L)?.0) } else { None };
                if let Some(shift_code) = shift_code {
                    self.key_code(shift_code, true)?;
                }
                let typed = self.key_code(code, true).and_then(|_| self.key_code(code, false));
                if let Some(shift_code) = shift_code {
                    self.key_code(shift_code, false)?;
                }
                typed?;
            }
            Ok(())
        })();
        self.restore_borrowed();
        result
    }

    pub fn input_held(&self) -> bool {
        let keys = self.conn.query_keymap().ok().and_then(|cookie| cookie.reply().ok()).is_some_and(|reply| reply.keys.iter().any(|byte| *byte != 0));
        let buttons = self
            .conn
            .query_pointer(self.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|pointer| u16::from(pointer.mask) & 0x1F00 != 0);
        keys || buttons
    }

    pub fn screen_active(&self) -> bool {
        self.conn
            .screensaver_query_info(self.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_none_or(|info| info.state != 1)
    }

    /// Reads the clipboard by asking its owner to convert it to UTF-8 text.
    pub fn clipboard_read(&self) -> Result<String, String> {
        let atoms = &self.atoms;
        self.conn
            .convert_selection(self.selection_window, atoms.CLIPBOARD, atoms.UTF8_STRING, atoms.MIXDOG_SELECTION, CURRENT_TIME)
            .map_err(e)?;
        self.conn.flush().map_err(e)?;
        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        while std::time::Instant::now() < deadline {
            match self.conn.poll_for_event().map_err(e)? {
                Some(Event::SelectionNotify(notify)) if notify.requestor == self.selection_window => {
                    if notify.property == x11rb::NONE {
                        return Ok(String::new());
                    }
                    let reply = self
                        .conn
                        .get_property(true, self.selection_window, atoms.MIXDOG_SELECTION, AtomEnum::ANY, 0, 1 << 24)
                        .map_err(e)?
                        .reply()
                        .map_err(e)?;
                    return Ok(String::from_utf8_lossy(&reply.value).into_owned());
                }
                Some(_) => {}
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        Ok(String::new())
    }
}

pub fn button_number(button: Button) -> u8 {
    match button {
        Button::Left => 1,
        Button::Middle => 2,
        Button::Right => 3,
    }
}
