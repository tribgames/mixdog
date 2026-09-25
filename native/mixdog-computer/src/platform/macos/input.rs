//! Synthesized input. Every event carries this process's marker in its
//! source user-data field so the observer can tell it from the user's, and
//! carries the modifier flags this process holds, since posted events do not
//! inherit them.

use super::ffi::*;
use crate::keys::{Key, KeySink, Mod, Named};
use crate::platform::Button;
use core_foundation::base::CFRelease;
use std::cell::Cell;

pub fn keycode(key: Key) -> Result<u16, String> {
    let code = match key {
        Key::Mod(Mod::Super) => 0x37,
        Key::Mod(Mod::Shift) => 0x38,
        Key::Mod(Mod::Alt) => 0x3A,
        Key::Mod(Mod::Ctrl) => 0x3B,
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
            'a' => 0x00, 's' => 0x01, 'd' => 0x02, 'f' => 0x03, 'h' => 0x04, 'g' => 0x05, 'z' => 0x06, 'x' => 0x07,
            'c' => 0x08, 'v' => 0x09, 'b' => 0x0B, 'q' => 0x0C, 'w' => 0x0D, 'e' => 0x0E, 'r' => 0x0F, 'y' => 0x10,
            't' => 0x11, '1' => 0x12, '2' => 0x13, '3' => 0x14, '4' => 0x15, '6' => 0x16, '5' => 0x17, '=' => 0x18,
            '9' => 0x19, '7' => 0x1A, '-' => 0x1B, '8' => 0x1C, '0' => 0x1D, ']' => 0x1E, 'o' => 0x1F, 'u' => 0x20,
            '[' => 0x21, 'i' => 0x22, 'p' => 0x23, 'l' => 0x25, 'j' => 0x26, '\'' => 0x27, 'k' => 0x28, ';' => 0x29,
            '\\' => 0x2A, ',' => 0x2B, '/' => 0x2C, 'n' => 0x2D, 'm' => 0x2E, '.' => 0x2F, '`' => 0x32, ' ' => 0x31,
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
    modifiers.iter().fold(0, |mask, modifier| mask | flag(*modifier))
}

/// Where an event goes: the system input stream, or one process.
#[derive(Clone, Copy)]
pub enum Route {
    System,
    Process(i32),
}

pub struct Poster {
    pub marker: i64,
    pub flags: Cell<u64>,
}

impl Poster {
    pub fn new(marker: i64) -> Poster {
        Poster { marker, flags: Cell::new(0) }
    }

    /// Stamps, posts and releases one event.
    pub fn post(&self, event: CGEventRef, route: Route, flags: u64) -> Result<(), String> {
        if event.is_null() {
            return Err("input_delivery_failed: the event could not be created".into());
        }
        // SAFETY: event is a live +1 CGEvent; it is released exactly once here.
        unsafe {
            CGEventSetIntegerValueField(event, kCGEventSourceUserData, self.marker);
            CGEventSetFlags(event, flags);
            match route {
                Route::System => CGEventPost(kCGHIDEventTap, event),
                Route::Process(pid) => super::skylight::post_to_pid(pid, event),
            }
            CFRelease(event as *const _);
        }
        Ok(())
    }

    pub fn mouse(&self, kind: u32, x: f64, y: f64, button: u32, clicks: u32, route: Route, window: u32, flags: u64) -> Result<(), String> {
        // SAFETY: creates a +1 mouse event that `post` releases.
        let event = unsafe { CGEventCreateMouseEvent(std::ptr::null_mut(), kind, CGPoint { x, y }, button) };
        if !event.is_null() {
            // SAFETY: event is live.
            unsafe {
                CGEventSetIntegerValueField(event, kCGMouseEventClickState, clicks.max(1) as i64);
                if window != 0 {
                    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer, window as i64);
                    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent, window as i64);
                }
            }
        }
        self.post(event, route, flags)
    }

    pub fn key(&self, code: u16, down: bool, route: Route, flags: u64) -> Result<(), String> {
        // SAFETY: creates a +1 keyboard event that `post` releases.
        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), code, down) };
        self.post(event, route, flags)
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
                    for down in [true, false] {
                        // SAFETY: a +1 keyboard event carrying the character; `post` releases it.
                        let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null_mut(), 0, down) };
                        if !event.is_null() {
                            // SAFETY: event is live and units outlive the call.
                            unsafe { CGEventKeyboardSetUnicodeString(event, encoded.len() as _, encoded.as_ptr()) };
                        }
                        self.post(event, route, 0)?;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        Ok(())
    }

    pub fn wheel(&self, x: f64, y: f64, clicks: i32, horizontal: bool, route: Route, flags: u64) -> Result<(), String> {
        // Three lines per wheel notch; positive clicks move content down/right.
        let lines = -clicks * 3;
        let (vertical, sideways) = if horizontal { (0, lines) } else { (lines, 0) };
        // SAFETY: creates a +1 scroll event that `post` releases.
        let event = unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null_mut(), kCGScrollEventUnitLine, 2, vertical, sideways, 0) };
        if !event.is_null() {
            // SAFETY: event is live.
            unsafe { CGEventSetLocation(event, CGPoint { x, y }) };
        }
        self.post(event, route, flags)
    }
}

pub fn button_events(button: Button) -> (u32, u32, u32) {
    match button {
        Button::Left => (kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGMouseButtonLeft),
        Button::Right => (kCGEventRightMouseDown, kCGEventRightMouseUp, kCGMouseButtonRight),
        Button::Middle => (kCGEventOtherMouseDown, kCGEventOtherMouseUp, kCGMouseButtonCenter),
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
        self.poster.key(keycode(key)?, true, Route::Process(self.pid), self.flags)
    }
    fn up(&mut self, key: Key) -> Result<(), String> {
        if let Key::Mod(modifier) = key {
            self.flags &= !flag(modifier);
        }
        self.poster.key(keycode(key)?, false, Route::Process(self.pid), self.flags)
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
            || (0u32..3).any(|button| CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, button))
    }
}

/// Posts a release for every modifier and button still down.
pub fn release_held(marker: i64) -> Result<(), String> {
    let poster = Poster::new(marker);
    let (x, y) = cursor();
    for code in MODIFIER_CODES {
        // SAFETY: HID state query.
        if unsafe { CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, code) } {
            poster.key(code, false, Route::System, 0)?;
        }
    }
    for button in [Button::Left, Button::Right, Button::Middle] {
        let (_, up, number) = button_events(button);
        // SAFETY: HID state query.
        if unsafe { CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, number) } {
            poster.mouse(up, x, y, number, 1, Route::System, 0, 0)?;
        }
    }
    Ok(())
}
