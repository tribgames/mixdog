//! Real pointer and keyboard input through `SendInput`. Every event carries
//! this host's marker in its extra-info field, so the observer tells it from
//! a person's, and every batch goes through the ownership receipt, so a
//! stopped session releases exactly what this host holds and nothing a
//! person is holding.

mod receipt;

use crate::keys::{glyph_key, Key, Mod, Named};
use crate::platform::Button;
use receipt::{deliver_with, Event, Receipt};
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::AtomicU8;
use std::sync::OnceLock;
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, ERROR_ALREADY_EXISTS,
    HANDLE, INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, OpenProcess, ReleaseMutex, WaitForSingleObject,
    PROCESS_DUP_HANDLE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

/// Virtual-key codes whose events carry the extended-key flag (IsExtendedKey).
fn extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B..=0x5D | 0x6F | 0x90 | 0xA3 | 0xA5)
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
        // Resolved on the layout when the stream was validated
        // (keys::resolve_text_key), and sent as is.
        Key::Vk(vk) => vk,
        Key::Char(glyph) => us_virtual_key(glyph),
    }
}

/// The virtual key that types `glyph`, shifted or not, on a US layout.
fn us_virtual_key(glyph: char) -> u16 {
    match glyph_key(glyph).map_or(glyph, |(base, _)| base) {
        base @ 'a'..='z' => base.to_ascii_uppercase() as u16,
        base @ '0'..='9' => base as u16,
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
    }
}

/// Virtual keys the system leaves unassigned: no keyboard presses one, so the
/// system injecting one is not anyone's input.
pub fn unassigned(vk: u32) -> bool {
    matches!(vk, 0x07 | 0x0A | 0x0B | 0x5E | 0x88..=0x8F | 0x97..=0x9F | 0xB8 | 0xB9 | 0xC1..=0xDA | 0xE0 | 0xE8 | 0xFF)
}

// --- ownership receipt ---------------------------------------------------------

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// The receipt's named mutex (OwnershipLock): one second to take it, and an
/// owner that died holding it counts as gone.
struct NamedMutex(HANDLE);

impl NamedMutex {
    fn open(name: &str) -> Option<NamedMutex> {
        let name = wide(name);
        // SAFETY: the name is NUL-terminated; the handle is closed on drop.
        unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .ok()
            .map(NamedMutex)
    }
}

impl receipt::Lock for NamedMutex {
    fn acquire(&self) -> Result<(), String> {
        // SAFETY: the handle is open for the life of self.
        match unsafe { WaitForSingleObject(self.0, 1000) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(()),
            _ => Err(receipt::BUSY.into()),
        }
    }

    fn release(&self) {
        // SAFETY: called once per successful acquire, on the acquiring thread.
        let _ = unsafe { ReleaseMutex(self.0) };
    }
}

impl Drop for NamedMutex {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by `open` and is closed once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// The file `MIXDOG_COMPUTER_RECEIPT_FILE` names, opened for the section to map; None when the desktop named none
/// (or, without `create`, when it holds none).
fn backing_file(create: bool) -> Option<std::fs::File> {
    let path = std::env::var_os(receipt::FILE_ENV).filter(|path| !path.is_empty())?;
    std::fs::OpenOptions::new().read(true).write(true).create(create).open(path).ok()
}

/// The receipt's shared memory (InitializeOwnership), named by the input
/// marker so the next helper and the abort cleanup reopen it by name.
struct Section {
    marker: i64,
    mapping: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    lock: NamedMutex,
    /// This call created the mapping; no other process held it yet.
    fresh: bool,
}

// SAFETY: the view is shared memory read and written only as atomic bytes,
// and the handles are process-wide kernel handles usable from any thread.
unsafe impl Send for Section {}
unsafe impl Sync for Section {}

impl Section {
    fn name(marker: i64) -> String {
        format!("Local\\MixdogInputOwnership-{marker}")
    }

    /// Creates the section, or opens it when another process already has it.
    fn create(marker: i64) -> Option<Section> {
        Section::map_backed(marker, &Section::name(marker), true, backing_file(true))
    }

    /// Reopens an existing section; when no process holds it any more, the file it was backed by
    /// (a crashed core's) brings it back.
    fn open(marker: i64) -> Option<Section> {
        Section::map(marker, &Section::name(marker), false).or_else(|| {
            let file = backing_file(false)?;
            let section = Section::map_backed(marker, &Section::name(marker), true, Some(file))?;
            // What the person held then says nothing of now.
            section.receipt().begin_observation(&key_down);
            Some(section)
        })
    }

    fn map(marker: i64, name: &str, create: bool) -> Option<Section> {
        let file = if create { backing_file(true) } else { None };
        Section::map_backed(marker, name, create, file)
    }

    fn map_backed(marker: i64, name: &str, create: bool, file: Option<std::fs::File>) -> Option<Section> {
        let lock = NamedMutex::open(&format!("{name}-lock"))?;
        let name = wide(name);
        // SAFETY: the name is NUL-terminated; a mapping without a view is
        // closed here, and a mapped one by Drop.
        unsafe {
            let mapping = if create {
                CreateFileMappingW(
                    file.as_ref().map_or(INVALID_HANDLE_VALUE, |file| HANDLE(file.as_raw_handle())),
                    None,
                    PAGE_READWRITE,
                    0,
                    receipt::SIZE as u32,
                    PCWSTR(name.as_ptr()),
                )
            } else {
                OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(name.as_ptr()))
            }
            .ok()?;
            let fresh = create && GetLastError() != ERROR_ALREADY_EXISTS;
            // A section of another size (another layout) fails to map whole.
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, receipt::SIZE);
            if view.Value.is_null() {
                let _ = CloseHandle(mapping);
                return None;
            }
            Some(Section {
                marker,
                mapping,
                view,
                lock,
                fresh,
            })
        }
    }

    /// Gives the parent process (the core's daemon) a handle on the mapping
    /// and the lock, so the section outlives this helper and the abort run
    /// reopens it by name (InputTransport.cs, the receipt kept by its owner).
    fn keep_in_parent(&self) -> Result<(), String> {
        let parent = super::native::parent_pid(std::process::id());
        if parent == 0 {
            return Err("the parent process is unknown".into());
        }
        // SAFETY: the handles are open for the life of self; the duplicates
        // belong to the parent, which keeps them, and the process handle is
        // closed on every path.
        unsafe {
            let process = OpenProcess(PROCESS_DUP_HANDLE, false, parent)
                .map_err(|error| format!("cannot open the parent process: {error}"))?;
            let mut outcome = Ok(());
            for source in [self.mapping, self.lock.0] {
                let mut copy = HANDLE::default();
                if let Err(error) = DuplicateHandle(
                    GetCurrentProcess(),
                    source,
                    process,
                    &mut copy,
                    0,
                    false,
                    DUPLICATE_SAME_ACCESS,
                ) {
                    outcome = Err(format!("cannot duplicate a handle into the parent: {error}"));
                    break;
                }
            }
            let _ = CloseHandle(process);
            outcome
        }
    }

    fn receipt(&self) -> Receipt<'_, NamedMutex> {
        // SAFETY: the view maps SIZE bytes for the life of self, and AtomicU8
        // has the layout of u8.
        let bytes = unsafe { &*(self.view.Value as *const [AtomicU8; receipt::SIZE]) };
        Receipt::new(bytes, &self.lock)
    }
}

impl Drop for Section {
    fn drop(&mut self) {
        // SAFETY: the view and the mapping were opened by `map` and are released once.
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.mapping);
        }
    }
}

/// The resident host's receipt; the input hook records the person in it.
static SECTION: OnceLock<Section> = OnceLock::new();

/// A person's press or release of a key or button (RecordForeignKey): while
/// they hold it, this host's release of it is refused.
pub fn note_foreign(vk: u32, held: bool) {
    if let Some(section) = SECTION.get() {
        section.receipt().note_person(vk, held);
    }
}

// --- sending -----------------------------------------------------------------

fn key_down(vk: u16) -> bool {
    // SAFETY: a plain key-state read.
    (unsafe { GetAsyncKeyState(vk as i32) }) as u16 & 0x8000 != 0
}

/// Send: hands events to `SendInput` with the marker in their extra info.
fn send_input(events: &[Event], marker: usize) -> Result<u32, String> {
    if events.is_empty() {
        return Ok(0);
    }
    let inputs: Vec<INPUT> = events
        .iter()
        .map(|event| match *event {
            Event::Key { vk, scan, flags } => INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(vk),
                        wScan: scan,
                        dwFlags: KEYBD_EVENT_FLAGS(flags),
                        time: 0,
                        dwExtraInfo: marker,
                    },
                },
            },
            Event::Mouse { flags, dx, dy, data } => INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx,
                        dy,
                        mouseData: data as u32,
                        dwFlags: MOUSE_EVENT_FLAGS(flags),
                        time: 0,
                        dwExtraInfo: marker,
                    },
                },
            },
        })
        .collect();
    // SAFETY: the slice and the struct size describe the same allocation.
    Ok(unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) })
}

/// The scan code the keyboard sends for `vk` under this thread's layout, 0
/// for a key without one.
fn scan_code(vk: u16) -> u16 {
    // SAFETY: a plain table lookup.
    unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16 }
}

/// A virtual-key press or release (MixWin32SendInput AddVk): the virtual key
/// keeps its layout meaning and the scan code rides along for the apps that
/// read it, without the scan-code flag.
fn key_event(vk: u16, down: bool) -> Event {
    let mut flags = if extended(vk) { KEYEVENTF_EXTENDEDKEY.0 } else { 0 };
    if !down {
        flags |= KEYEVENTF_KEYUP.0;
    }
    Event::key(vk, scan_code(vk), flags)
}

fn button_event(button: Button, down: bool) -> Event {
    let (press, release) = match button {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    let flags = if down { press } else { release };
    Event::mouse(flags.0)
}

pub struct Sender {
    marker: usize,
    /// The receipt this host's input is tracked in, or why there is none.
    section: Result<&'static Section, &'static str>,
}

impl Sender {
    pub fn new(marker: i64) -> Sender {
        if SECTION.get().is_none() {
            if let Some(section) = Section::create(marker) {
                // A section another process already holds is kept by it.
                if section.fresh {
                    if let Err(error) = section.keep_in_parent() {
                        eprintln!(
                            "mixdog-computer: input ownership receipt will not outlive this helper: {error}"
                        );
                    }
                }
                section.receipt().begin_observation(&key_down);
                let _ = SECTION.set(section);
            }
        }
        let section = match SECTION.get() {
            Some(section) if section.marker == marker => Ok(section),
            Some(_) => Err("input_cleanup_unconfirmed: input ownership changed"),
            None => Err("input_cleanup_unconfirmed: input ownership receipt is unavailable; no input was sent"),
        };
        Sender {
            marker: marker as usize,
            section,
        }
    }

    /// Deliver through DeliverTracked: checked, and recorded in the receipt.
    fn deliver(&self, events: &[Event]) -> Result<(), String> {
        let receipt = self.section.map_err(String::from)?.receipt();
        let marker = self.marker;
        deliver_with(events, &mut |batch| {
            receipt.deliver_tracked(batch, &mut |batch| send_input(batch, marker), &key_down)
        })
    }

    pub fn key(&self, key: Key, down: bool) -> Result<(), String> {
        let vk = virtual_key(key);
        if vk == 0 {
            return Err(format!("key {key:?} has no virtual key"));
        }
        self.deliver(&[key_event(vk, down)])
    }

    /// SendText: one checked batch per glyph, so a glyph's press is never
    /// left down without its release.
    pub fn text(&self, text: &str) -> Result<(), String> {
        let enter = virtual_key(Key::Named(Named::Enter));
        for glyph in text.chars() {
            if glyph == '\r' {
                continue;
            }
            let events: Vec<Event> = if glyph == '\n' {
                vec![key_event(enter, true), key_event(enter, false)]
            } else {
                let mut units = [0u16; 2];
                glyph
                    .encode_utf16(&mut units)
                    .iter()
                    .flat_map(|&unit| {
                        [
                            Event::key(0, unit, KEYEVENTF_UNICODE.0),
                            Event::key(0, unit, (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP).0),
                        ]
                    })
                    .collect()
            };
            self.deliver(&events)?;
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
        self.deliver(&[Event::Mouse {
            flags: (MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK).0,
            dx,
            dy,
            data: 0,
        }])
    }

    pub fn button(&self, button: Button, down: bool) -> Result<(), String> {
        self.deliver(&[button_event(button, down)])
    }

    /// A key as the remote screen sends it (screen-input-host.ts `k`): its
    /// virtual key with the scan code riding along for apps that read it, or
    /// a scan code alone when `vk` is 0.
    pub fn key_code(&self, vk: u16, scan: u16, extended: bool, down: bool) -> Result<(), String> {
        let mut flags = if extended { KEYEVENTF_EXTENDEDKEY.0 } else { 0 };
        if !down {
            flags |= KEYEVENTF_KEYUP.0;
        }
        if vk == 0 {
            flags |= KEYEVENTF_SCANCODE.0;
        }
        self.deliver(&[Event::key(vk, scan, flags)])
    }

    /// Wheel `units` as Windows counts them (120 a notch): positive scrolls the
    /// content down (or right).
    pub fn wheel_units(&self, units: i32, horizontal: bool) -> Result<(), String> {
        let (flag, data) = if horizontal { (MOUSEEVENTF_HWHEEL, units) } else { (MOUSEEVENTF_WHEEL, -units) };
        self.deliver(&[Event::Mouse { flags: flag.0, dx: 0, dy: 0, data }])
    }

    /// `clicks` are wheel notches: positive scrolls the content down (or right).
    pub fn wheel(&self, clicks: i32, horizontal: bool) -> Result<(), String> {
        let (flag, data) = if horizontal {
            (MOUSEEVENTF_HWHEEL, clicks * 120)
        } else {
            (MOUSEEVENTF_WHEEL, -clicks * 120)
        };
        self.deliver(&[Event::Mouse {
            flags: flag.0,
            dx: 0,
            dy: 0,
            data,
        }])
    }
}

/// Whether any key or button is physically down right now.
pub fn any_held() -> bool {
    receipt::any_held(&key_down)
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

/// ReleaseOwned: lets go of every key and button the named host left down
/// and still owns. What the person holds is untouched.
pub fn release_owned(marker: i64) -> Result<(), String> {
    match Section::open(marker) {
        Some(section) => section
            .receipt()
            .release_owned(&mut |events| send_input(events, marker as usize), &key_down),
        None => release_without_receipt(&key_down),
    }
}

/// With the host's receipt gone nothing says what it held, so nothing is sent:
/// the keys may all come up within two seconds, or the release is unconfirmed.
fn release_without_receipt(keys: &receipt::KeyState<'_>) -> Result<(), String> {
    if receipt::settle(keys) {
        Ok(())
    } else {
        Err("input_cleanup_unconfirmed: ownership receipt is unavailable while input is held".into())
    }
}

#[cfg(test)]
mod tests {
    use super::receipt::Lock;
    use super::*;
    use std::sync::mpsc;

    fn test_name(tag: &str) -> String {
        format!("Local\\MixdogInputOwnershipTest-{}-{tag}", std::process::id())
    }

    #[test]
    fn extended_keys_match_the_sendinput_table() {
        for vk in [0x21, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5] {
            assert!(extended(vk), "{vk:#x} is extended");
        }
        for vk in [0x0D, 0x10, 0x11, 0x12, 0x41, 0xA0, 0xA1, 0xA2, 0xA4] {
            assert!(!extended(vk), "{vk:#x} is not extended");
        }
        assert_eq!(key_event(0xA3, false), Event::key(0xA3, scan_code(0xA3), 0x3));
        assert_eq!(key_event(0x41, true), Event::key(0x41, scan_code(0x41), 0));
    }

    #[test]
    fn a_virtual_key_event_carries_its_scan_code_and_no_scan_code_flag() {
        // Enter, Escape and Space sit on the same keys on every layout (a
        // letter does not: A is scan 0x10 on AZERTY).
        for (vk, scan) in [(0x0Du16, 0x1Cu16), (0x1B, 0x01), (0x20, 0x39)] {
            assert_eq!(key_event(vk, true), Event::key(vk, scan, 0), "{vk:#x}");
            assert_eq!(key_event(vk, false), Event::key(vk, scan, KEYEVENTF_KEYUP.0), "{vk:#x}");
        }
    }

    /// The keys of the C# vectors (K191, K83): a character goes to its US key,
    /// a resolved virtual key is sent unchanged, and {PLUS} stays VK_OEM_PLUS.
    #[test]
    fn characters_and_resolved_keys_name_their_virtual_keys() {
        for (glyph, vk) in [('?', 0xBF), ('/', 0xBF), ('@', 0x32), ('S', 0x53), ('s', 0x53), ('=', 0xBB), ('-', 0xBD)] {
            assert_eq!(us_virtual_key(glyph), vk, "{glyph}");
            assert_eq!(virtual_key(Key::Char(glyph)), vk, "{glyph}");
        }
        assert_eq!(virtual_key(Key::Vk(0x51)), 0x51);
        assert_eq!(virtual_key(crate::keys::named_key("PLUS").unwrap()), 0xBB);
        assert_eq!(virtual_key(crate::keys::named_key("MINUS").unwrap()), 0xBD);
    }

    /// OwnershipLock: a second handle waits one second, then answers busy.
    #[test]
    fn the_ownership_lock_is_busy_while_another_thread_holds_it() {
        let name = test_name("busy-lock");
        let (taken, wait_taken) = mpsc::channel();
        let (done, wait_done) = mpsc::channel::<()>();
        let owner_name = name.clone();
        let owner = std::thread::spawn(move || {
            let mutex = NamedMutex::open(&owner_name).expect("the lock opens");
            mutex.acquire().expect("the lock is free");
            taken.send(()).expect("the test waits");
            let _ = wait_done.recv();
            mutex.release();
        });
        wait_taken.recv().expect("the owner took the lock");
        let second = NamedMutex::open(&name).expect("a second handle opens");
        assert_eq!(second.acquire(), Err(receipt::BUSY.to_string()));
        done.send(()).expect("the owner waits");
        owner.join().expect("the owner ends");
        assert_eq!(second.acquire(), Ok(()));
        second.release();
    }

    /// OwnershipLock: an owner that died holding the lock does not block.
    #[test]
    fn an_abandoned_ownership_lock_counts_as_acquired() {
        let name = test_name("abandoned-lock");
        let survivor = NamedMutex::open(&name).expect("the lock opens");
        let owner_name = name.clone();
        std::thread::spawn(move || {
            let mutex = NamedMutex::open(&owner_name).expect("the lock opens");
            mutex.acquire().expect("the lock is free");
        })
        .join()
        .expect("the owner ends holding the lock");
        assert_eq!(survivor.acquire(), Ok(()));
        survivor.release();
    }

    /// No receipt: keys already up are a clean release, a held key is refused,
    /// and nothing is ever transmitted.
    #[test]
    fn without_a_receipt_a_held_key_is_refused_and_nothing_is_sent() {
        assert_eq!(release_without_receipt(&|_| false), Ok(()));
        assert_eq!(
            release_without_receipt(&|vk| vk == 0x41),
            Err("input_cleanup_unconfirmed: ownership receipt is unavailable while input is held".into())
        );
    }

    /// A reopened section reads the receipt its creator wrote.
    #[test]
    fn a_reopened_section_reads_the_same_receipt() {
        let name = test_name("section");
        let created = Section::map(0, &name, true).expect("the section is created");
        let pressed = created.receipt().deliver_tracked(
            &[key_event(0x41, true)],
            &mut |events| Ok(events.len() as u32),
            &|_| false,
        );
        assert_eq!(pressed, Ok(1));
        let reopened = Section::map(0, &name, false).expect("the section reopens by name");
        let mut released = Vec::new();
        let outcome = reopened.receipt().release_owned(
            &mut |events| {
                released.extend_from_slice(events);
                Ok(1)
            },
            &|_| false,
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(released, vec![key_event(0x41, false)]);
        drop((created, reopened));
        assert!(Section::map(0, &name, false).is_none(), "the section ends with its last handle");
    }

    /// A section backed by a file outlives its handles: the records a crashed core left are read back from the file.
    #[test]
    fn a_file_backed_section_survives_its_last_handle() {
        let path = std::env::temp_dir().join(format!("mixdog-receipt-test-{}", std::process::id()));
        let name = test_name("backed");
        let created = Section::map_backed(0, &name, true, backing_open(&path)).expect("the section is created");
        let pressed = created.receipt().deliver_tracked(&[key_event(0x41, true)], &mut |events| Ok(events.len() as u32), &|_| false);
        assert_eq!(pressed, Ok(1));
        drop(created);
        assert!(Section::map(0, &name, false).is_none(), "no handle is left");
        let again = Section::map_backed(0, &name, true, backing_open(&path)).expect("the file brings the section back");
        let mut released = Vec::new();
        let outcome = again.receipt().release_owned(
            &mut |events| {
                released.extend_from_slice(events);
                Ok(1)
            },
            &|_| false,
        );
        drop(again);
        let _ = std::fs::remove_file(&path);
        assert_eq!(outcome, Ok(()));
        assert_eq!(released, vec![key_event(0x41, false)]);
    }

    fn backing_open(path: &std::path::Path) -> Option<std::fs::File> {
        std::fs::OpenOptions::new().read(true).write(true).create(true).open(path).ok()
    }

    // F23 and F24: keys no application binds. These inject real keystrokes
    // into the desktop, so they run only on a test machine.
    const MARKER: i64 = 7_700_001;
    const F23: u16 = 0x86;
    const F24: u16 = 0x87;
    static KEYBOARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn down(vk: u16) -> bool {
        std::thread::sleep(Duration::from_millis(60));
        key_down(vk)
    }

    /// DS-COMP-3: a stopped session's key is released by a fresh process.
    #[test]
    #[ignore = "live: injects real keystrokes into the desktop"]
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
    #[ignore = "live: injects real keystrokes into the desktop"]
    fn cleanup_leaves_a_key_the_host_never_held() {
        let _keyboard = KEYBOARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let sender = Sender::new(MARKER);
        assert_eq!(send_input(&[key_event(F23, true)], 0), Ok(1));
        assert!(down(F23));
        release_owned(MARKER).unwrap();
        assert!(down(F23), "a key the host never held stays down");
        assert_eq!(send_input(&[key_event(F23, false)], 0), Ok(1));
        sender.key(Key::Named(Named::F(23)), false).unwrap();
        assert!(!down(F23));
    }
}
