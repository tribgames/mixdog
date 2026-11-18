//! Synthesized input. Every event carries this process's marker in its
//! source user-data field so the observer can tell it from the user's, and
//! carries the modifier flags this process holds, since posted events do not
//! inherit them.

use super::ffi::*;
use crate::keys::{Key, KeySink, Mod, Named};
use crate::platform::Button;
use core_foundation::base::CFRelease;
use std::cell::{Cell, RefCell};

pub fn keycode(key: Key) -> Result<u16, String> {
    let code = match key {
        Key::Mod(Mod::Super) => 0x37,
        Key::Mod(Mod::Shift) => 0x38,
        Key::Mod(Mod::Alt) => 0x3A,
        Key::Mod(Mod::Ctrl) => 0x3B,
        // Only a Windows keyboard layout resolves a character to a virtual key.
        Key::Vk(vk) => return Err(format!("invalid_keys: virtual key {vk:#x} has no key here")),
        Key::Named(named) => match named {
            Named::Enter => 0x24,
            Named::Tab => 0x30,
            Named::Space => 0x31,
            Named::Backspace => 0x33,
            Named::Escape => 0x35,
            Named::CapsLock => 0x39,
            Named::Insert => 0x72,
            Named::Home => 0x73,
            Named::PageUp => 0x74,
            Named::Delete => 0x75,
            Named::End => 0x77,
            Named::PageDown => 0x79,
            Named::Left => 0x7B,
            Named::Right => 0x7C,
            Named::Down => 0x7D,
            Named::Up => 0x7E,
            Named::NumLock => 0x47,
            Named::PrintScreen => 0x69,
            Named::ScrollLock => 0x6B,
            Named::Pause => 0x71,
            Named::F(number) => match number {
                1 => 0x7A,
                2 => 0x78,
                3 => 0x63,
                4 => 0x76,
                5 => 0x60,
                6 => 0x61,
                7 => 0x62,
                8 => 0x64,
                9 => 0x65,
                10 => 0x6D,
                11 => 0x67,
                12 => 0x6F,
                13 => 0x69,
                14 => 0x6B,
                15 => 0x71,
                16 => 0x6A,
                17 => 0x40,
                18 => 0x4F,
                19 => 0x50,
                20 => 0x5A,
                _ => return Err(format!("invalid_keys: F{number} has no macOS key")),
            },
            Named::Apps => return Err("invalid_keys: the context-menu key has no macOS key".into()),
        },
        Key::Char(glyph) => match glyph {
            'a' => 0x00,
            's' => 0x01,
            'd' => 0x02,
            'f' => 0x03,
            'h' => 0x04,
            'g' => 0x05,
            'z' => 0x06,
            'x' => 0x07,
            'c' => 0x08,
            'v' => 0x09,
            'b' => 0x0B,
            'q' => 0x0C,
            'w' => 0x0D,
            'e' => 0x0E,
            'r' => 0x0F,
            'y' => 0x10,
            't' => 0x11,
            '1' => 0x12,
            '2' => 0x13,
            '3' => 0x14,
            '4' => 0x15,
            '6' => 0x16,
            '5' => 0x17,
            '=' => 0x18,
            '9' => 0x19,
            '7' => 0x1A,
            '-' => 0x1B,
            '8' => 0x1C,
            '0' => 0x1D,
            ']' => 0x1E,
            'o' => 0x1F,
            'u' => 0x20,
            '[' => 0x21,
            'i' => 0x22,
            'p' => 0x23,
            'l' => 0x25,
            'j' => 0x26,
            '\'' => 0x27,
            'k' => 0x28,
            ';' => 0x29,
            '\\' => 0x2A,
            ',' => 0x2B,
            '/' => 0x2C,
            'n' => 0x2D,
            'm' => 0x2E,
            '.' => 0x2F,
            '`' => 0x32,
            ' ' => 0x31,
            other => return Err(format!("invalid_keys: '{other}' has no macOS key")),
        },
    };
    Ok(code)
}

pub fn flag(modifier: Mod) -> u64 {
    match modifier {
        Mod::Shift => kCGEventFlagMaskShift,
        Mod::Ctrl => kCGEventFlagMaskControl,
        Mod::Alt => kCGEventFlagMaskAlternate,
        Mod::Super => kCGEventFlagMaskCommand,
    }
}

pub fn flags_of(modifiers: &[Mod]) -> u64 {
    modifiers
        .iter()
        .fold(0, |mask, modifier| mask | flag(*modifier))
}

/// Where an event goes: the system input stream, or one process.
#[derive(Clone, Copy)]
pub enum Route {
    System,
    Process(i32),
}

/// One pointer event's delivery: its route, the window a process-routed
/// event names (0 for none) with that window's top-left screen point, and
/// the modifier flags it carries.
#[derive(Clone, Copy)]
pub struct Dest {
    pub route: Route,
    pub window: u32,
    pub origin: CGPoint,
    pub flags: u64,
}

impl Dest {
    pub fn system(flags: u64) -> Dest {
        Dest {
            route: Route::System,
            window: 0,
            origin: CGPoint::default(),
            flags,
        }
    }

    pub fn process(pid: i32, window: u32, origin: CGPoint, flags: u64) -> Dest {
        Dest {
            route: Route::Process(pid),
            window,
            origin,
            flags,
        }
    }
}

/// Names the target window on a process-routed pointer event the way the
/// window server does on a real one: the window under the pointer, the
/// window the event belongs to, and the point inside it. Without these the
/// app has no window to hand the event to and drops it.
///
/// # Safety
/// `event` must be a live CGEvent.
unsafe fn route_to_window(event: CGEventRef, dest: Dest, x: f64, y: f64) {
    if dest.window == 0 {
        return;
    }
    let window = dest.window as i64;
    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer, window);
    CGEventSetIntegerValueField(
        event,
        kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,
        window,
    );
    CGEventSetIntegerValueField(event, kCGEventWindowNumber, window);
    super::skylight::set_window_location(
        event,
        CGPoint {
            x: x - dest.origin.x,
            y: y - dest.origin.y,
        },
    );
}

pub(crate) use crate::port::macos::MacHold;
use crate::port::macos::MacReceipt;

/// 0 for the system input stream.
fn route_pid(route: Route) -> i32 {
    match route {
        Route::System => 0,
        Route::Process(pid) => pid,
    }
}

fn route_of(pid: i32) -> Route {
    if pid == 0 { Route::System } else { Route::Process(pid) }
}

/// The button a press or release kind names; None for any other kind.
fn button_of(kind: u32) -> Option<Button> {
    match kind {
        kCGEventLeftMouseDown | kCGEventLeftMouseUp => Some(Button::Left),
        kCGEventRightMouseDown | kCGEventRightMouseUp => Some(Button::Right),
        kCGEventOtherMouseDown | kCGEventOtherMouseUp => Some(Button::Middle),
        _ => None,
    }
}

/// The flag a modifier key's own press sets.
fn modifier_flag(code: u16) -> u64 {
    match code {
        0x37 => kCGEventFlagMaskCommand,
        0x38 => kCGEventFlagMaskShift,
        0x3A => kCGEventFlagMaskAlternate,
        0x3B => kCGEventFlagMaskControl,
        _ => 0,
    }
}

/// A +1 mouse event at the point, with its click state and its target window.
fn mouse_event(kind: u32, x: f64, y: f64, button: u32, clicks: u32, dest: Dest) -> CGEventRef {
    // SAFETY: creates a +1 mouse event the poster releases.
    let event = unsafe { CGEventCreateMouseEvent(std::ptr::null_mut(), kind, CGPoint { x, y }, button) };
    if !event.is_null() {
        // SAFETY: event is live.
        unsafe {
            CGEventSetIntegerValueField(event, kCGMouseEventClickState, clicks.max(1) as i64);
            route_to_window(event, dest, x, y);
        }
    }
    event
}

/// The press event one specification names, with its route and flags (a typed character's press carries `units`). The same
/// specification is the receipt the port records, so the release [`release_event`] builds is always this press's. Building
/// posts nothing; the port posts it.
pub(crate) fn press_event(spec: &MacHold, units: Option<&[u16]>) -> (CGEventRef, Route, u64) {
    match *spec {
        MacHold::Button { button, pid, window, origin, at, clicks, flags } => {
            // The press kind and number are the button's own: no event kind is part of the specification.
            let (down, _, number) = button_events(button);
            let dest = Dest { route: route_of(pid), window, origin: CGPoint { x: origin.0, y: origin.1 }, flags };
            (mouse_event(down, at.0, at.1, number, clicks, dest), dest.route, flags)
        }
        MacHold::Key { code, pid, flags } => {
            // SAFETY: creates a +1 keyboard event the port posts and releases (or frees when refused).
            let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), code, true) };
            if let (false, Some(units)) = (event.is_null(), units) {
                // SAFETY: event is live and units outlive the call.
                unsafe { CGEventKeyboardSetUnicodeString(event, units.len() as _, units.as_ptr()) };
            }
            (event, route_of(pid), flags)
        }
    }
}

/// The release event a hold names, built from it alone, with its route and flags: a button at its last accepted point with
/// the press's own destination; a key with the press's flags minus the key's own modifier, never a new one. Building posts
/// nothing; the port posts it.
pub(crate) fn release_event(hold: &MacHold) -> (CGEventRef, Route, u64) {
    match *hold {
        MacHold::Button { button, pid, window, origin, at, clicks, flags } => {
            let (_, up, number) = button_events(button);
            let dest = Dest { route: route_of(pid), window, origin: CGPoint { x: origin.0, y: origin.1 }, flags };
            (mouse_event(up, at.0, at.1, number, clicks, dest), dest.route, flags)
        }
        MacHold::Key { code, pid, flags } => {
            // SAFETY: creates a +1 keyboard event the port posts and releases.
            let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), code, false) };
            (event, route_of(pid), flags & !modifier_flag(code))
        }
    }
}

pub struct Poster {
    pub flags: Cell<u64>,
    /// The receipts of this poster's accepted presses: a release consumes the one its key or button matches.
    held: RefCell<Vec<MacReceipt>>,
}

impl Poster {
    /// The executor's port stamps every event with this process's marker.
    pub fn new() -> Poster {
        Poster {
            flags: Cell::new(0),
            held: RefCell::new(Vec::new()),
        }
    }

    /// A press of `spec` through the port; its receipt kept for the release.
    fn press(&self, spec: MacHold, units: Option<&[u16]>) -> Result<(), String> {
        let receipt = crate::port::macos::press(spec, units)?;
        self.held.borrow_mut().push(receipt);
        Ok(())
    }

    /// The release of the press `matches` names: its receipt consumed by the port. Without one this poster holds nothing
    /// there, and nothing is sent.
    fn release(&self, matches: impl Fn(&MacHold) -> bool) -> Result<(), String> {
        let receipt = {
            let mut held = self.held.borrow_mut();
            held.iter().position(|receipt| matches(receipt.hold())).map(|at| held.remove(at))
        };
        receipt.map_or(Ok(()), crate::port::macos::release)
    }

    /// One event that holds nothing, an ordinary submission of the executor's port.
    fn post(&self, event: CGEventRef, route: Route, flags: u64) -> Result<(), String> {
        crate::port::macos::post(event, route, flags)
    }

    /// A pointer event. A press is owned from its post (its receipt kept); a release consumes that receipt (the button at its
    /// last accepted point, with the press's own destination); an accepted drag moves the point a held button is let go at.
    /// All through the executor's port (`crate::port::macos`). The button of a press or release is read from `kind`, and its
    /// number is the button's own (`button` is used only for motion); any other kind than a motion or drag is refused.
    pub fn mouse(
        &self,
        kind: u32,
        x: f64,
        y: f64,
        button: u32,
        clicks: u32,
        dest: Dest,
    ) -> Result<(), String> {
        let pid = route_pid(dest.route);
        match kind {
            kCGEventLeftMouseDown | kCGEventRightMouseDown | kCGEventOtherMouseDown => {
                let spec = MacHold::Button {
                    button: button_of(kind).expect("a press kind"),
                    pid,
                    window: dest.window,
                    origin: (dest.origin.x, dest.origin.y),
                    at: (x, y),
                    clicks,
                    flags: dest.flags,
                };
                self.press(spec, None)
            }
            kCGEventLeftMouseUp | kCGEventRightMouseUp | kCGEventOtherMouseUp => {
                let released = button_of(kind);
                self.release(|held| matches!(*held, MacHold::Button { button, pid: owner, .. } if Some(button) == released && owner == pid))
            }
            kCGEventMouseMoved | kCGEventLeftMouseDragged | kCGEventRightMouseDragged | kCGEventOtherMouseDragged => {
                self.post(mouse_event(kind, x, y, button, clicks, dest), dest.route, dest.flags)?;
                if kind != kCGEventMouseMoved {
                    crate::port::macos::moved_to(pid, (x, y));
                }
                Ok(())
            }
            other => Err(format!("input_delivery_failed: pointer event kind {other} is not offered")),
        }
    }

    /// A key down is owned once posted (its receipt kept); a key up consumes that receipt, and posts the release it names.
    pub fn key(&self, code: u16, down: bool, route: Route, flags: u64) -> Result<(), String> {
        self.key_with(code, down, route, flags, None)
    }

    /// `key`, with the unicode string a typed character's press carries (its release carries none).
    fn key_with(&self, code: u16, down: bool, route: Route, flags: u64, units: Option<&[u16]>) -> Result<(), String> {
        let pid = route_pid(route);
        if !down {
            return self.release(|held| matches!(*held, MacHold::Key { code: key, pid: owner, .. } if key == code && owner == pid));
        }
        self.press(MacHold::Key { code, pid, flags }, units)
    }

    /// Literal characters, independent of the keyboard layout and input method.
    pub fn text(&self, text: &str, route: Route) -> Result<(), String> {
        for c in text.chars() {
            match c {
                '\n' | '\r' => {
                    self.key(0x24, true, route, 0)?;
                    self.key(0x24, false, route, 0)?;
                }
                '\t' => {
                    self.key(0x30, true, route, 0)?;
                    self.key(0x30, false, route, 0)?;
                }
                _ => {
                    let mut units = [0u16; 2];
                    let encoded = c.encode_utf16(&mut units);
                    self.key_with(0, true, route, 0, Some(encoded))?;
                    self.key_with(0, false, route, 0, None)?;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        Ok(())
    }

    pub fn wheel(
        &self,
        x: f64,
        y: f64,
        clicks: i32,
        horizontal: bool,
        dest: Dest,
    ) -> Result<(), String> {
        // Three lines per wheel notch; positive clicks move content down/right.
        let lines = -clicks * 3;
        let (vertical, sideways) = if horizontal { (0, lines) } else { (lines, 0) };
        // SAFETY: creates a +1 scroll event that `post` releases.
        let event = unsafe {
            CGEventCreateScrollWheelEvent2(
                std::ptr::null_mut(),
                kCGScrollEventUnitLine,
                2,
                vertical,
                sideways,
                0,
            )
        };
        if !event.is_null() {
            // SAFETY: event is live.
            unsafe {
                CGEventSetLocation(event, CGPoint { x, y });
                // A process that is not frontmost routes a posted wheel event
                // by the window it names, as it does a click; without one the
                // event reaches the app and scrolls nothing.
                route_to_window(event, dest, x, y);
            }
        }
        self.post(event, dest.route, dest.flags)
    }
}

pub fn button_events(button: Button) -> (u32, u32, u32) {
    match button {
        Button::Left => (
            kCGEventLeftMouseDown,
            kCGEventLeftMouseUp,
            kCGMouseButtonLeft,
        ),
        Button::Right => (
            kCGEventRightMouseDown,
            kCGEventRightMouseUp,
            kCGMouseButtonRight,
        ),
        Button::Middle => (
            kCGEventOtherMouseDown,
            kCGEventOtherMouseUp,
            kCGMouseButtonCenter,
        ),
    }
}

pub fn cursor() -> (f64, f64) {
    // SAFETY: a +1 null-source event only used to read the pointer location.
    unsafe {
        let event = CGEventCreate(std::ptr::null_mut());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let point = CGEventGetLocation(event);
        CFRelease(event as *const _);
        (point.x, point.y)
    }
}

/// Keys routed to one process, holding their own modifier state.
pub struct ProcessKeys<'a> {
    pub poster: &'a Poster,
    pub pid: i32,
    pub flags: u64,
}

impl KeySink for ProcessKeys<'_> {
    fn down(&mut self, key: Key) -> Result<(), String> {
        if let Key::Mod(modifier) = key {
            self.flags |= flag(modifier);
        }
        self.poster
            .key(keycode(key)?, true, Route::Process(self.pid), self.flags)
    }
    fn up(&mut self, key: Key) -> Result<(), String> {
        if let Key::Mod(modifier) = key {
            self.flags &= !flag(modifier);
        }
        self.poster
            .key(keycode(key)?, false, Route::Process(self.pid), self.flags)
    }
    fn text(&mut self, text: &str) -> Result<(), String> {
        self.poster.text(text, Route::Process(self.pid))
    }
}

const MODIFIER_CODES: [u16; 8] = [0x37, 0x38, 0x3A, 0x3B, 0x36, 0x3C, 0x3D, 0x3E];

pub fn input_held() -> bool {
    // SAFETY: plain HID state queries.
    unsafe {
        (0u16..128).any(|code| CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, code))
            || (0u32..3)
                .any(|button| CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, button))
    }
}

/// The cleanup from a fresh process, which holds no receipt of the helper that was stopped: ownership is never inferred from
/// the physical state, so nothing is released. A modifier or button still down is reported unconfirmed (it may be the
/// person's, or the stopped helper's; only a receipt could tell).
pub fn release_held(_marker: i64) -> Result<(), String> {
    let down = MODIFIER_CODES.iter().any(|code| {
        // SAFETY: HID state query.
        unsafe { CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, *code) }
    }) || [Button::Left, Button::Right, Button::Middle].into_iter().any(|button| {
        // SAFETY: HID state query.
        unsafe { CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, button_events(button).2) }
    });
    if down {
        return Err("input_cleanup_unconfirmed: input is still down and no receipt names it as this helper's; nothing was released".into());
    }
    Ok(())
}
