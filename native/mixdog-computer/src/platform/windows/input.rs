//! Real pointer and keyboard input through `SendInput`. Every event carries
//! this host's marker in its extra-info field, so the observer tells it from
//! a person's, and the ownership table records what this host holds so a
//! stopped session releases exactly that and nothing a person is holding.

use crate::keys::{Key, Mod, Named};
use crate::platform::Button;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

/// Virtual-key codes whose events carry the extended-key flag.
fn extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B..=0x5D | 0x6F | 0x90)
}

pub fn virtual_key(key: Key) -> u16 {
    match key {
        Key::Mod(Mod::Shift) => 0x10,
        Key::Mod(Mod::Ctrl) => 0x11,
        Key::Mod(Mod::Alt) => 0x12,
        Key::Mod(Mod::Super) => 0x5B,
        Key::Named(named) => match named {
            Named::Backspace => 0x08,
            Named::Tab => 0x09,
            Named::Enter => 0x0D,
            Named::Escape => 0x1B,
            Named::Space => 0x20,
            Named::PageUp => 0x21,
            Named::PageDown => 0x22,
            Named::End => 0x23,
            Named::Home => 0x24,
            Named::Left => 0x25,
            Named::Up => 0x26,
            Named::Right => 0x27,
            Named::Down => 0x28,
            Named::Insert => 0x2D,
            Named::Delete => 0x2E,
            Named::CapsLock => 0x14,
            Named::NumLock => 0x90,
            Named::ScrollLock => 0x91,
            Named::Apps => 0x5D,
            Named::PrintScreen => 0x2C,
            Named::Pause => 0x13,
            Named::F(number) => 0x6F + number as u16,
        },
        // A key named by the unshifted US-layout character it types.
        Key::Char(glyph) => match glyph {
            'a'..='z' => glyph.to_ascii_uppercase() as u16,
            '0'..='9' => glyph as u16,
            ' ' => 0x20,
            '-' => 0xBD,
            '=' => 0xBB,
            '[' => 0xDB,
            ']' => 0xDD,
            '\\' => 0xDC,
            ';' => 0xBA,
            '\'' => 0xDE,
            ',' => 0xBC,
            '.' => 0xBE,
            '/' => 0xBF,
            '`' => 0xC0,
            _ => 0,
        },
    }
}

/// Virtual keys the system leaves unassigned: no keyboard presses one, so the
/// system injecting one is not anyone's input.
pub fn unassigned(vk: u32) -> bool {
    matches!(vk, 0x07 | 0x0A | 0x0B | 0x5E | 0x88..=0x8F | 0x97..=0x9F | 0xB8 | 0xB9 | 0xC1..=0xDA | 0xE0 | 0xE8 | 0xFF)
}

// --- ownership ---------------------------------------------------------------

const OWNED_SLOTS: usize = 256;
/// Slots 1..=5 double as the mouse buttons (VK_LBUTTON, VK_RBUTTON,
/// VK_MBUTTON, VK_XBUTTON1/2), as `GetAsyncKeyState` numbers them.
struct Ownership {
    view: *mut u8,
}

// SAFETY: the view is process-wide shared memory of plain bytes.
unsafe impl Send for Ownership {}
unsafe impl Sync for Ownership {}

fn mapping_name(marker: i64) -> Vec<u16> {
    format!("Local\\MixdogInputOwnership-{marker}\0")
        .encode_utf16()
        .collect()
}

impl Ownership {
    fn create(marker: i64) -> Option<Ownership> {
        let name = mapping_name(marker);
        // SAFETY: the name is NUL-terminated; the mapping stays open for the process.
        unsafe {
            let mapping = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                OWNED_SLOTS as u32,
                windows::core::PCWSTR(name.as_ptr()),
            )
            .ok()?;
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, OWNED_SLOTS);
            if view.Value.is_null() {
                let _ = CloseHandle(mapping);
                return None;
            }
            Some(Ownership {
                view: view.Value as *mut u8,
            })
        }
    }

    fn set(&self, slot: usize, held: bool) {
        if slot > 0 && slot < OWNED_SLOTS {
            // SAFETY: slot is inside the mapped view.
            unsafe { self.view.add(slot).write_volatile(held as u8) };
        }
    }

    fn get(&self, slot: usize) -> bool {
        // SAFETY: slot is inside the mapped view.
        slot < OWNED_SLOTS && unsafe { self.view.add(slot).read_volatile() } != 0
    }
}

static OBSERVING_FOREIGN: AtomicBool = AtomicBool::new(false);

/// A person's press of a key or button this host also holds takes the hold
/// over: the host must not release what the person now holds.
pub fn note_foreign(slot: usize) {
    if OBSERVING_FOREIGN.load(Ordering::Relaxed) {
        if let Some(table) = TABLE.get() {
            table.set(slot, false);
        }
    }
}

static TABLE: std::sync::OnceLock<Ownership> = std::sync::OnceLock::new();

// --- sending -----------------------------------------------------------------

fn deliver(inputs: &[INPUT]) -> Result<(), String> {
    // SAFETY: the slice and the struct size describe the same allocation.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(format!(
            "SendInput accepted {sent} of {} events ({})",
            inputs.len(),
            std::io::Error::last_os_error()
        ))
    }
}

pub struct Sender {
    marker: usize,
}

impl Sender {
    pub fn new(marker: i64) -> Sender {
        if let Some(table) = Ownership::create(marker) {
            let _ = TABLE.set(table);
            OBSERVING_FOREIGN.store(true, Ordering::Relaxed);
        }
        Sender {
            marker: marker as usize,
        }
    }

    fn key_event(&self, vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: self.marker,
                },
            },
        }
    }

    fn mouse_event(&self, flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: self.marker,
                },
            },
        }
    }

    fn track(&self, slot: usize, held: bool) {
        if let Some(table) = TABLE.get() {
            table.set(slot, held);
        }
    }

    pub fn key(&self, key: Key, down: bool) -> Result<(), String> {
        let vk = virtual_key(key);
        if vk == 0 {
            return Err(format!("key {key:?} has no virtual key"));
        }
        let mut flags = if extended(vk) {
            KEYEVENTF_EXTENDEDKEY
        } else {
            KEYBD_EVENT_FLAGS(0)
        };
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        deliver(&[self.key_event(vk, 0, flags)])?;
        self.track(vk as usize, down);
        Ok(())
    }

    pub fn text(&self, text: &str) -> Result<(), String> {
        for glyph in text.chars() {
            if glyph == '\r' {
                continue;
            }
            if glyph == '\n' {
                self.key(Key::Named(Named::Enter), true)?;
                self.key(Key::Named(Named::Enter), false)?;
            } else {
                let mut units = [0u16; 2];
                let units = glyph.encode_utf16(&mut units);
                let mut events = Vec::with_capacity(units.len() * 2);
                for unit in units.iter() {
                    events.push(self.key_event(0, *unit, KEYEVENTF_UNICODE));
                    events.push(self.key_event(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
                deliver(&events)?;
            }
            // Chromium and WinUI can drop a tight Unicode batch that SendInput
            // accepted; brief pacing keeps literal order across async queues.
            std::thread::sleep(Duration::from_millis(4));
        }
        Ok(())
    }

    pub fn move_to(&self, x: i32, y: i32) -> Result<(), String> {
        if super::native::cursor() == (x, y) {
            return Ok(());
        }
        // SAFETY: metrics queries take plain values.
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width < 2 || height < 2 {
            return Err("the virtual screen has no extent".into());
        }
        let dx = ((x - left) as f64 * 65535.0 / (width - 1) as f64).round() as i32;
        let dy = ((y - top) as f64 * 65535.0 / (height - 1) as f64).round() as i32;
        deliver(&[self.mouse_event(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            dx,
            dy,
            0,
        )])
    }

    pub fn button(&self, button: Button, down: bool) -> Result<(), String> {
        let (press, release, slot) = match button {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 2),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 4),
        };
        deliver(&[self.mouse_event(if down { press } else { release }, 0, 0, 0)])?;
        self.track(slot, down);
        Ok(())
    }

    /// `clicks` are wheel notches: positive scrolls the content down (or right).
    pub fn wheel(&self, clicks: i32, horizontal: bool) -> Result<(), String> {
        let (flag, delta) = if horizontal {
            (MOUSEEVENTF_HWHEEL, clicks * 120)
        } else {
            (MOUSEEVENTF_WHEEL, -clicks * 120)
        };
        deliver(&[self.mouse_event(flag, 0, 0, delta)])
    }
}

/// Whether any key or button is physically down right now.
pub fn any_held() -> bool {
    (1..256).any(|vk| unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000 != 0)
}

/// Whether the input desktop is open to this process (not locked, no secure prompt).
pub fn desktop_ready() -> bool {
    // SAFETY: a plain open; the handle is closed at once.
    match unsafe { OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS) } {
        Ok(desktop) => {
            let _ = unsafe { CloseDesktop(desktop) };
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const MARKER: i64 = 7_700_001;
    // F23 and F24: keys no application binds. Tests share the one keyboard.
    const F23: u16 = 0x86;
    const F24: u16 = 0x87;
    static KEYBOARD: Mutex<()> = Mutex::new(());

    fn down(vk: u16) -> bool {
        std::thread::sleep(Duration::from_millis(60));
        (unsafe { GetAsyncKeyState(vk as i32) }) as u16 & 0x8000 != 0
    }

    /// DS-COMP-3: a stopped session's key is released by a fresh process.
    #[test]
    fn cleanup_releases_a_key_the_host_held() {
        let _keyboard = KEYBOARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let sender = Sender::new(MARKER);
        sender.key(Key::Named(Named::F(24)), true).unwrap();
        assert!(down(F24), "the host holds the key");
        release_owned(MARKER).unwrap();
        assert!(!down(F24), "the cleanup released it");
    }

    /// DS-COMP-3: what a person holds is not the host's to release.
    #[test]
    fn cleanup_leaves_a_key_the_host_never_held() {
        let _keyboard = KEYBOARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let sender = Sender::new(MARKER);
        let foreign = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(F23),
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    ..Default::default()
                },
            },
        };
        deliver(&[foreign]).unwrap();
        assert!(down(F23));
        release_owned(MARKER).unwrap();
        assert!(down(F23), "a key the host never held stays down");
        let mut up = foreign;
        up.Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
        deliver(&[up]).unwrap();
        sender.key(Key::Named(Named::F(23)), false).unwrap();
        assert!(!down(F23));
    }
}

/// Releases every key and button the named host left down and still owns.
/// Held state the person took over is untouched.
pub fn release_owned(marker: i64) -> Result<(), String> {
    let name = mapping_name(marker);
    // SAFETY: the name is NUL-terminated; handles and the view are released below.
    unsafe {
        let mapping = OpenFileMappingW(
            FILE_MAP_ALL_ACCESS.0,
            false,
            windows::core::PCWSTR(name.as_ptr()),
        )
        .ok();
        let view = mapping
            .map(|mapping| MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, OWNED_SLOTS))
            .filter(|view| !view.Value.is_null());
        // With the host's table gone nothing says what it held, so what is
        // down among the buttons and modifiers is released, as on the other
        // desktops; with it, only what the host still owns.
        let table = view.map(|view| Ownership {
            view: view.Value as *mut u8,
        });
        let sender = Sender {
            marker: marker as usize,
        };
        let mut failure = None;
        for slot in 1..OWNED_SLOTS {
            let owned = match &table {
                Some(table) => table.get(slot),
                None => matches!(slot, 1 | 2 | 4 | 0x10 | 0x11 | 0x12 | 0x5B | 0x5C),
            };
            if !owned {
                continue;
            }
            let down = GetAsyncKeyState(slot as i32) as u16 & 0x8000 != 0;
            if down {
                let sent = match slot {
                    1 => deliver(&[sender.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0)]),
                    2 => deliver(&[sender.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0)]),
                    4 => deliver(&[sender.mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0)]),
                    vk => {
                        let flags = if extended(vk as u16) {
                            KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP
                        } else {
                            KEYEVENTF_KEYUP
                        };
                        deliver(&[sender.key_event(vk as u16, 0, flags)])
                    }
                };
                if let Err(error) = sent {
                    failure.get_or_insert(error);
                    continue;
                }
            }
            if let Some(table) = &table {
                table.set(slot, false);
            }
        }
        if let Some(view) = view {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: view.Value });
        }
        if let Some(mapping) = mapping {
            let _ = CloseHandle(mapping);
        }
        match failure {
            Some(error) => Err(format!(
                "input_cleanup_unconfirmed: native input release was not accepted ({error})"
            )),
            None => Ok(()),
        }
    }
}
