//! A virtual keyboard and absolute pointer through the kernel's uinput
//! device. Every Wayland compositor reads it like real hardware, which is
//! why it works where no compositor protocol is shared.

use crate::keys::{Key, Mod, Named};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const EV_ABS: u16 = 3;
const SYN_REPORT: u16 = 0;
const REL_HWHEEL: u16 = 6;
const REL_WHEEL: u16 = 8;
const ABS_X: u16 = 0;
const ABS_Y: u16 = 1;
pub const BTN_LEFT: u16 = 0x110;
pub const BTN_RIGHT: u16 = 0x111;
pub const BTN_MIDDLE: u16 = 0x112;

const UI_SET_EVBIT: libc::c_ulong = 0x4004_5564;
const UI_SET_KEYBIT: libc::c_ulong = 0x4004_5565;
const UI_SET_RELBIT: libc::c_ulong = 0x4004_5566;
const UI_SET_ABSBIT: libc::c_ulong = 0x4004_5567;
const UI_DEV_CREATE: libc::c_ulong = 0x5501;
const UI_DEV_SETUP: libc::c_ulong = 0x405c_5503;
const UI_ABS_SETUP: libc::c_ulong = 0x401c_5504;

#[repr(C)]
struct InputId {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
}

#[repr(C)]
struct Setup {
    id: InputId,
    name: [u8; 80],
    ff_effects_max: u32,
}

#[repr(C)]
struct AbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

#[repr(C)]
struct AbsSetup {
    code: u16,
    info: AbsInfo,
}

#[repr(C)]
struct InputEvent {
    seconds: libc::time_t,
    microseconds: libc::suseconds_t,
    kind: u16,
    code: u16,
    value: i32,
}

pub const PERMISSION_HINT: &str = "input_unavailable: Wayland input needs write access to /dev/uinput; add the udev rule `KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", OPTIONS+=\"static_node=uinput\"`, add your user to the input group, then sign in again";

pub struct Device {
    file: File,
    /// The desktop area the absolute axes span.
    origin: (i32, i32),
}

fn ioctl(file: &File, request: libc::c_ulong, argument: libc::c_ulong) -> Result<(), String> {
    // SAFETY: uinput ioctls on an open uinput descriptor with plain integer
    // or pointer-to-struct arguments of the documented layouts.
    let status = unsafe { libc::ioctl(file.as_raw_fd(), request as _, argument) };
    if status < 0 {
        return Err(format!("input_unavailable: uinput setup failed: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

impl Device {
    /// Creates the device spanning the desktop `(x, y, width, height)`.
    pub fn create(bounds: (i32, i32, i32, i32)) -> Result<Device, String> {
        let file = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open("/dev/uinput")
            .map_err(|_| PERMISSION_HINT.to_string())?;
        for kind in [EV_KEY, EV_REL, EV_ABS, EV_SYN] {
            ioctl(&file, UI_SET_EVBIT, kind as _)?;
        }
        for code in (1u16..=248).chain([BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) {
            ioctl(&file, UI_SET_KEYBIT, code as _)?;
        }
        for code in [REL_WHEEL, REL_HWHEEL] {
            ioctl(&file, UI_SET_RELBIT, code as _)?;
        }
        for (code, maximum) in [(ABS_X, bounds.2 - 1), (ABS_Y, bounds.3 - 1)] {
            ioctl(&file, UI_SET_ABSBIT, code as _)?;
            let setup = AbsSetup { code, info: AbsInfo { value: 0, minimum: 0, maximum: maximum.max(1), fuzz: 0, flat: 0, resolution: 0 } };
            ioctl(&file, UI_ABS_SETUP, &setup as *const AbsSetup as _)?;
        }
        let mut name = [0u8; 80];
        let label = b"Mixdog Computer Use";
        name[..label.len()].copy_from_slice(label);
        let setup = Setup { id: InputId { bustype: 0x06, vendor: 0x6d78, product: 0x0001, version: 1 }, name, ff_effects_max: 0 };
        ioctl(&file, UI_DEV_SETUP, &setup as *const Setup as _)?;
        ioctl(&file, UI_DEV_CREATE, 0)?;
        // The compositor needs a moment to open a new input device.
        std::thread::sleep(std::time::Duration::from_millis(400));
        Ok(Device { file, origin: (bounds.0, bounds.1) })
    }

    fn emit(&self, kind: u16, code: u16, value: i32) -> Result<(), String> {
        let event = InputEvent { seconds: 0, microseconds: 0, kind, code, value };
        // SAFETY: InputEvent is plain data; its bytes are what the kernel reads.
        let bytes = unsafe { std::slice::from_raw_parts(&event as *const InputEvent as *const u8, std::mem::size_of::<InputEvent>()) };
        (&self.file).write_all(bytes).map_err(|error| format!("input_delivery_failed: {error}"))
    }

    fn sync(&self) -> Result<(), String> {
        self.emit(EV_SYN, SYN_REPORT, 0)
    }

    pub fn move_to(&self, x: i32, y: i32) -> Result<(), String> {
        self.emit(EV_ABS, ABS_X, x - self.origin.0)?;
        self.emit(EV_ABS, ABS_Y, y - self.origin.1)?;
        self.sync()
    }

    pub fn key(&self, code: u16, down: bool) -> Result<(), String> {
        self.emit(EV_KEY, code, down as i32)?;
        self.sync()
    }

    pub fn wheel(&self, clicks: i32, horizontal: bool) -> Result<(), String> {
        // The kernel's wheel is positive upward and rightward.
        let (code, value) = if horizontal { (REL_HWHEEL, clicks) } else { (REL_WHEEL, -clicks) };
        for _ in 0..clicks.unsigned_abs() {
            self.emit(EV_REL, code, value.signum())?;
            self.sync()?;
        }
        Ok(())
    }
}

/// The evdev key code for a key on a US layout.
pub fn code(key: Key) -> Result<u16, String> {
    Ok(match key {
        Key::Mod(Mod::Shift) => 42,
        Key::Mod(Mod::Ctrl) => 29,
        Key::Mod(Mod::Alt) => 56,
        Key::Mod(Mod::Super) => 125,
        Key::Named(named) => match named {
            Named::Escape => 1,
            Named::Backspace => 14,
            Named::Tab => 15,
            Named::Enter => 28,
            Named::Space => 57,
            Named::CapsLock => 58,
            Named::NumLock => 69,
            Named::ScrollLock => 70,
            Named::PrintScreen => 99,
            Named::Home => 102,
            Named::Up => 103,
            Named::PageUp => 104,
            Named::Left => 105,
            Named::Right => 106,
            Named::End => 107,
            Named::Down => 108,
            Named::PageDown => 109,
            Named::Insert => 110,
            Named::Delete => 111,
            Named::Pause => 119,
            Named::Apps => 127,
            Named::F(number) => match number {
                1..=10 => 58 + number as u16,
                11 => 87,
                12 => 88,
                13..=24 => 170 + number as u16,
                _ => return Err(format!("invalid_keys: F{number} has no key")),
            },
        },
        Key::Char(glyph) => {
            const ROWS: [(&str, u16); 4] = [("1234567890-=", 2), ("qwertyuiop[]", 16), ("asdfghjkl;'`", 30), ("\\zxcvbnm,./", 43)];
            if glyph == ' ' {
                return Ok(57);
            }
            ROWS.iter()
                .find_map(|(row, first)| row.chars().position(|c| c == glyph).map(|index| first + index as u16))
                .ok_or_else(|| format!("invalid_keys: '{glyph}' has no key on a US layout; use set_value for this text"))?
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn us_layout_codes() {
        assert_eq!(code(Key::Char('a')).unwrap(), 30);
        assert_eq!(code(Key::Char('q')).unwrap(), 16);
        assert_eq!(code(Key::Char('/')).unwrap(), 53);
        assert_eq!(code(Key::Char('\\')).unwrap(), 43);
        assert_eq!(code(Key::Named(Named::F(12))).unwrap(), 88);
        assert_eq!(code(Key::Named(Named::F(13))).unwrap(), 183);
        assert!(code(Key::Char('한')).is_err());
    }

    #[test]
    fn event_layout_matches_the_kernel() {
        assert_eq!(std::mem::size_of::<InputEvent>(), 24);
        assert_eq!(std::mem::size_of::<Setup>(), 92);
        assert_eq!(std::mem::size_of::<AbsSetup>(), 28);
    }
}
