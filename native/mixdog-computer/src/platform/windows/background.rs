//! Input delivered to one window as messages, without taking the foreground
//! or moving the person's pointer. A target that cannot take messages is
//! refused before anything is sent.

use super::native::{self, hwnd, wid};
use crate::keys::Mod;
use crate::observer::Shared;
use crate::platform::{window_id, Background, Wid};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::Win32::Foundation::{GetLastError, SetLastError, ERROR_ACCESS_DENIED, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, ScreenToClient, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, GetDpiForWindow, PhysicalToLogicalPointForPerMonitorDPI, MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::Input::KeyboardAndMouse::MapVirtualKeyW;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetGUIThreadInfo, GetParent, GetWindowLongW, SendMessageTimeoutW,
    SetWindowLongW, GUITHREADINFO, GWL_EXSTYLE, SMTO_ABORTIFHUNG, SMTO_BLOCK,
};

const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_CHAR: u32 = 0x0102;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MBUTTONUP: u32 = 0x0208;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_MOUSEHWHEEL: u32 = 0x020E;
const MK_LBUTTON: usize = 0x1;
const MK_RBUTTON: usize = 0x2;
const MK_SHIFT: usize = 0x4;
const MK_CONTROL: usize = 0x8;
const MK_MBUTTON: usize = 0x10;
const WS_EX_NOACTIVATE: i32 = 0x0800_0000;

/// A failed message delivery, and whether the system proved nothing arrived.
#[derive(Debug)]
struct MsgError {
    text: String,
    not_delivered: bool,
    hung: bool,
    gone: bool,
}

impl MsgError {
    fn plain(text: impl Into<String>) -> MsgError {
        MsgError {
            text: text.into(),
            not_delivered: false,
            hung: false,
            gone: false,
        }
    }
}

type Msg<T = ()> = Result<T, MsgError>;

fn send(target: Wid, message: u32, wparam: usize, lparam: isize) -> Msg<usize> {
    let mut result = 0usize;
    // SAFETY: the call can fail without setting an error, so it is cleared first.
    let sent = unsafe {
        SetLastError(Default::default());
        SendMessageTimeoutW(
            hwnd(target),
            message,
            WPARAM(wparam),
            LPARAM(lparam),
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            1000,
            Some(&mut result),
        )
    };
    if sent.0 != 0 {
        return Ok(result);
    }
    let error = unsafe { GetLastError() };
    Err(match error.0 {
        0 | 1460 => MsgError {
            hung: true,
            ..MsgError::plain("background_target_hung|native window message timed out")
        },
        code if code == ERROR_ACCESS_DENIED.0 => MsgError {
            not_delivered: true,
            ..MsgError::plain(
                "background_blocked_uipi|Windows integrity isolation blocked the native message",
            )
        },
        code => MsgError::plain(format!(
            "background_message_rejected|native window message failed with Win32 error {code}"
        )),
    })
}

/// One message to a window, for callers outside the background routes.
pub fn send_value(target: Wid, message: u32, wparam: usize, lparam: isize) -> Result<usize, String> {
    send(target, message, wparam, lparam).map_err(|error| error.text)
}

/// Binds a release to the window's process and thread: a destroyed window's
/// handle may be reused, and cleanup must never reach its successor.
fn bound(target: Wid, release: impl Fn() -> Msg + 'static) -> impl Fn() -> Msg {
    let (pid, thread) = native::pid_thread(target);
    move || {
        let (now_pid, now_thread) = native::pid_thread(target);
        if pid == 0 || thread == 0 || !native::is_window(target) || (now_pid, now_thread) != (pid, thread) {
            return Err(MsgError {
                gone: true,
                ..MsgError::plain("background_target_gone|the target window closed before it acknowledged a background input release")
            });
        }
        release()
    }
}

const RELEASE_ATTEMPTS: u32 = 3;
const RELEASE_ATTEMPT_MS: u64 = 1000;

/// A busy target times a release out without saying whether it landed; a
/// release is harmless to send again, so a timeout gets up to three attempts
/// about a second apart. A target gone before any release reached it holds
/// nothing; gone after an unanswered one, the release stays unconfirmed.
fn confirm_release(release: &dyn Fn() -> Msg) -> Result<(), String> {
    for attempt in 1..=RELEASE_ATTEMPTS {
        let started = std::time::Instant::now();
        match release() {
            Ok(()) => return Ok(()),
            Err(error) if error.gone => {
                return if attempt > 1 {
                    Err(format!("input_cleanup_unconfirmed: {}", error.text))
                } else {
                    Ok(())
                };
            }
            Err(error) if error.hung && attempt < RELEASE_ATTEMPTS => {
                let rest = Duration::from_millis(RELEASE_ATTEMPT_MS).saturating_sub(started.elapsed());
                std::thread::sleep(rest);
            }
            Err(_) => {
                return Err(
                    "input_cleanup_unconfirmed: background input release was not acknowledged"
                        .into(),
                )
            }
        }
    }
    unreachable!("the loop returns on its last attempt")
}

/// A press and its release as one guarded unit: whatever happens in between,
/// the release is sent and acknowledged unless the press provably never landed.
fn with_release(
    press: impl FnOnce() -> Msg,
    held: impl FnOnce() -> Msg,
    release: &dyn Fn() -> Msg,
) -> Result<(), String> {
    let mut release_required = true;
    let outcome = (|| {
        match press() {
            Ok(()) => {}
            Err(error) => {
                if error.not_delivered {
                    release_required = false;
                }
                return Err(error.text);
            }
        }
        held().map_err(|error| error.text)
    })();
    if release_required {
        confirm_release(release)?;
    }
    outcome
}

fn point_param(x: i32, y: i32) -> isize {
    (((y & 0xFFFF) << 16) | (x & 0xFFFF)) as isize
}

fn client_point(target: Wid, x: i32, y: i32) -> Msg<POINT> {
    let mut point = POINT { x, y };
    // SAFETY: point is a valid in/out pointer.
    if unsafe { ScreenToClient(hwnd(target), &mut point) }.as_bool() {
        Ok(point)
    } else {
        Err(MsgError::plain(
            "background_message_rejected|could not map point into target window",
        ))
    }
}

/// The point a target's own pointer messages carry: a window that is not
/// per-monitor aware reads its messages in its own DPI, as the system converts
/// real input for it.
fn message_point(target: Wid, x: i32, y: i32) -> Msg<POINT> {
    let physical = client_point(target, x, y)?;
    let (mut monitor_dpi, mut unused) = (0u32, 0u32);
    // SAFETY: both are valid out pointers.
    let read = unsafe {
        GetDpiForMonitor(
            MonitorFromWindow(hwnd(target), MONITOR_DEFAULTTONEAREST),
            MDT_EFFECTIVE_DPI,
            &mut monitor_dpi,
            &mut unused,
        )
    };
    if read.is_err() || monitor_dpi == 0 {
        return Err(MsgError::plain(
            "background_message_rejected|could not read the target monitor DPI",
        ));
    }
    let window_dpi = unsafe { GetDpiForWindow(hwnd(target)) } as f64;
    Ok(POINT {
        x: (physical.x as f64 * window_dpi / monitor_dpi as f64).round() as i32,
        y: (physical.y as f64 * window_dpi / monitor_dpi as f64).round() as i32,
    })
}

fn is_chromium(class: &str) -> bool {
    class.eq_ignore_ascii_case("Chrome_RenderWidgetHostHWND")
        || class
            .get(.."Chrome_WidgetWin".len())
            .is_some_and(|head| head.eq_ignore_ascii_case("Chrome_WidgetWin"))
}

fn belongs_to_top(top: Wid, candidate: Wid) -> bool {
    if !native::is_window(top) || !native::is_window(candidate) {
        return false;
    }
    if candidate != top && native::root_of(candidate) != top {
        return false;
    }
    let (top_pid, candidate_pid) = (native::pid_of(top), native::pid_of(candidate));
    top_pid != 0 && top_pid == candidate_pid
}

/// The window a pointer message at the screen point goes to: the deepest
/// same-process child under it, refusing surfaces that read pointers only from
/// the system input stack.
fn message_target_at(top: Wid, x: i32, y: i32) -> Msg<Wid> {
    if !native::is_window(top) {
        return Err(MsgError::plain(
            "stale_target|native message target is stale or invalid",
        ));
    }
    match native::rect(top) {
        Some(bounds) if x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom => {}
        _ => {
            return Err(MsgError::plain(
                "target_mismatch|native message point is outside the exact target window",
            ))
        }
    }
    let mut current = top;
    for _ in 0..32 {
        let Some(child) = native::child_at(current, x, y) else {
            break;
        };
        let surface = native::class_name(child);
        if surface == "Microsoft.UI.Content.DesktopChildSiteBridge"
            || surface == "Windows.UI.Core.CoreWindow"
        {
            return Err(MsgError::plain("background_unsupported|this WinUI or UWP surface ignores posted pointer messages; use a semantic ref or explicit foreground delivery; no input sent"));
        }
        if !belongs_to_top(top, child) {
            break;
        }
        current = child;
    }
    Ok(current)
}

fn pointer_flags(modifiers: &[Mod]) -> Msg<usize> {
    let mut flags = 0;
    for modifier in modifiers {
        match modifier {
            Mod::Ctrl => flags |= MK_CONTROL,
            Mod::Shift => flags |= MK_SHIFT,
            other => {
                return Err(MsgError::plain(format!(
                    "background_unsupported|background pointer messages support only ctrl/shift modifiers; use explicit foreground delivery for {}",
                    format!("{other:?}").to_lowercase()
                )))
            }
        }
    }
    Ok(flags)
}

fn mouse_click(target: Wid, point: isize, modifiers: usize, down: u32, up: u32, button: usize) -> Result<(), String> {
    let release = bound(target, move || {
        send(target, up, modifiers, point).map(|_| ())
    });
    with_release(
        || send(target, down, modifiers | button, point).map(|_| ()),
        || Ok(()),
        &release,
    )
}

// --- keyboard ------------------------------------------------------------------

fn supports_keyboard_class(class: &str) -> bool {
    !(["ApplicationFrameWindow", "Windows.UI.Core.CoreWindow", "WinUIDesktopWin32WindowClass", "Microsoft.UI.Content.DesktopChildSiteBridge"]
        .iter()
        .any(|name| name.eq_ignore_ascii_case(class))
        || is_chromium(class))
}

/// The deepest child of `top` that holds keyboard focus on any of its threads.
fn focused_descendant(top: Wid) -> Msg<Wid> {
    struct Search {
        top: Wid,
        threads: Vec<u32>,
    }
    unsafe extern "system" fn visit(child: windows::Win32::Foundation::HWND, state: LPARAM) -> windows::core::BOOL {
        let search = &mut *(state.0 as *mut Search);
        if belongs_to_top(search.top, wid(child)) {
            search.threads.push(native::pid_thread(wid(child)).1);
        }
        windows::core::BOOL(1)
    }
    let mut search = Search {
        top,
        threads: vec![native::pid_thread(top).1],
    };
    // SAFETY: the callback runs only during this call.
    let _ = unsafe {
        EnumChildWindows(Some(hwnd(top)), Some(visit), LPARAM(&mut search as *mut Search as isize))
    };
    search.threads.sort_unstable();
    search.threads.dedup();
    let mut candidates: Vec<(Wid, u32)> = Vec::new();
    for thread in search.threads.into_iter().filter(|thread| *thread != 0) {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: info is initialised with its size.
        if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_err() || !belongs_to_top(top, wid(info.hwndFocus)) {
            continue;
        }
        let focus = wid(info.hwndFocus);
        let (mut current, mut depth) = (focus, 0u32);
        while current != top && current != 0 && depth < 64 {
            current = wid(unsafe { GetParent(hwnd(current)) }.unwrap_or_default());
            depth += 1;
        }
        if current == top {
            candidates.push((focus, depth));
        }
    }
    let (mut selected, mut selected_depth, mut ambiguous) = (top, 0u32, false);
    for (window, depth) in candidates {
        if depth < selected_depth {
            continue;
        }
        if depth > selected_depth {
            selected = window;
            selected_depth = depth;
            ambiguous = false;
        } else if selected != window {
            ambiguous = true;
        }
    }
    if ambiguous {
        return Err(MsgError::plain(
            "background_target_ambiguous|multiple focused child windows; use an exact native ref",
        ));
    }
    Ok(selected)
}

fn keyboard_target(top: Wid) -> Msg<Wid> {
    if !native::is_window(top) {
        return Err(MsgError::plain(
            "stale_target|background keyboard target is stale or invalid",
        ));
    }
    let focused = focused_descendant(top)?;
    if !supports_keyboard_class(&native::class_name(focused)) {
        return Err(MsgError::plain("background_unsupported|focused renderer does not accept posted keyboard input; no input sent"));
    }
    // An inactive Tk window keeps its focus to itself; keys sent to its frame
    // are discarded without an error.
    if focused == top && native::class_name(top).starts_with("Tk") {
        return Err(MsgError::plain("background_unsupported|this Tk window has no focused control while inactive, so background keys would be discarded; use explicit foreground delivery; no input sent"));
    }
    Ok(focused)
}

fn named_virtual_key(name: &str) -> Msg<u16> {
    let key = match name {
        "BACKSPACE" | "BS" => 0x08,
        "TAB" => 0x09,
        "ENTER" | "RETURN" => 0x0D,
        "ESC" | "ESCAPE" => 0x1B,
        "SPACE" => 0x20,
        "PGUP" | "PRIOR" => 0x21,
        "PGDN" | "NEXT" => 0x22,
        "END" => 0x23,
        "HOME" => 0x24,
        "LEFT" => 0x25,
        "UP" => 0x26,
        "RIGHT" => 0x27,
        "DOWN" => 0x28,
        "INSERT" | "INS" => 0x2D,
        "DELETE" | "DEL" => 0x2E,
        "PLUS" => 0xBB,
        "MINUS" => 0xBD,
        "SHIFT" => 0x10,
        "CTRL" | "CONTROL" => 0x11,
        "ALT" | "MENU" => 0x12,
        "CAPSLOCK" => 0x14,
        "NUMLOCK" => 0x90,
        "SCROLLLOCK" => 0x91,
        "LWIN" | "WIN" => 0x5B,
        "APPS" => 0x5D,
        "PRTSC" | "PRINTSCREEN" => 0x2C,
        "PAUSE" => 0x13,
        other => match other
            .strip_prefix('F')
            .and_then(|digits| digits.parse::<u16>().ok())
            .filter(|number| (1..=24).contains(number))
        {
            Some(number) => 0x6F + number,
            None => {
                return Err(MsgError::plain(format!(
                    "background_unsupported|background keyboard does not support key token {{{other}}}"
                )))
            }
        },
    };
    Ok(key)
}

#[derive(Debug, PartialEq)]
enum Stroke {
    Char(char),
    Key(u16),
}

/// The whole stream is validated before any target is resolved or key sent.
fn parse_keys(keys: &str) -> Msg<Vec<Stroke>> {
    let chars: Vec<char> = keys.chars().collect();
    let mut strokes = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let glyph = chars[index];
        if glyph == '\r' || glyph == '\n' {
            if glyph == '\r' && chars.get(index + 1) == Some(&'\n') {
                index += 1;
            }
            strokes.push(Stroke::Key(0x0D));
        } else if glyph == '{' {
            if chars[index..].starts_with(&['{', '{', '}']) {
                strokes.push(Stroke::Char('{'));
                index += 2;
            } else if chars[index..].starts_with(&['{', '}', '}']) {
                strokes.push(Stroke::Char('}'));
                index += 2;
            } else {
                let Some(length) = chars[index + 1..].iter().position(|c| *c == '}') else {
                    return Err(MsgError::plain("background_unsupported|unclosed background key token"));
                };
                let mut token: String = chars[index + 1..index + 1 + length].iter().collect::<String>().trim().to_uppercase();
                let mut repeat = 1;
                if let Some((name, count)) = token.rsplit_once(' ') {
                    if let Some(count) = count.parse::<u32>().ok().filter(|count| (1..=100).contains(count)) {
                        repeat = count;
                        token = name.to_string();
                    }
                }
                let key = named_virtual_key(&token)?;
                if key == 0x5B {
                    return Err(MsgError::plain("background_unsupported|the Windows key needs the real keyboard; use explicit foreground delivery"));
                }
                strokes.extend((0..repeat).map(|_| Stroke::Key(key)));
                index += length + 1;
            }
        } else if "^%+~()#".contains(glyph) {
            // A stream that is nothing but the symbol means the character itself.
            if chars.len() == 1 {
                strokes.push(Stroke::Char(glyph));
            } else {
                return Err(MsgError::plain("background_unsupported|background keyboard does not support SendKeys modifiers/groups; use explicit foreground delivery"));
            }
        } else {
            strokes.push(Stroke::Char(glyph));
        }
        index += 1;
    }
    Ok(strokes)
}

fn extended_virtual_key(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2D | 0x2E)
}

/// The character a physical press of these keys makes: a sent key never passes
/// the target's translate loop, and edit controls act on Enter, Tab,
/// Backspace, Escape and Space only through it.
fn translated_character(vk: u16) -> Option<usize> {
    match vk {
        0x08 => Some(0x08),
        0x09 => Some(0x09),
        0x0D => Some(0x0D),
        0x1B => Some(0x1B),
        0x20 => Some(0x20),
        _ => None,
    }
}

fn background_virtual_key(target: Wid, vk: u16) -> Result<(), String> {
    // SAFETY: a plain table lookup.
    let scan = unsafe { MapVirtualKeyW(vk as u32, windows::Win32::UI::Input::KeyboardAndMouse::MAP_VIRTUAL_KEY_TYPE(0)) } as isize;
    let state = 1 | (scan << 16) | if extended_virtual_key(vk) { 1 << 24 } else { 0 };
    let released = state | (0xC000_0000u32 as i32 as isize);
    // Tk derives the editing action from the key itself and repeats it for the
    // character, so it receives the key alone.
    let translated = if native::class_name(target).starts_with("Tk") {
        None
    } else {
        translated_character(vk)
    };
    let release = bound(target, move || {
        send(target, WM_KEYUP, vk as usize, released).map(|_| ())
    });
    with_release(
        || {
            send(target, WM_KEYDOWN, vk as usize, state)?;
            if let Some(character) = translated {
                send(target, WM_CHAR, character, state)?;
            }
            Ok(())
        },
        || Ok(()),
        &release,
    )
}

fn background_char(target: Wid, glyph: char) -> Msg {
    let mut units = [0u16; 2];
    for unit in glyph.encode_utf16(&mut units).iter() {
        send(target, WM_CHAR, *unit as usize, 1)?;
    }
    Ok(())
}

// --- keeping the target inactive ---------------------------------------------------

/// Roots whose no-activate bit this host added, with the holds still needing
/// it. Only the last holder clears the bit.
static HOLDERS: Mutex<Option<HashMap<Wid, usize>>> = Mutex::new(None);

fn ledger_append(kind: char, root: Wid) {
    let Some(path) = std::env::var_os("MIXDOG_COMPUTER_INACTIVE_LEDGER").filter(|path| !path.is_empty()) else {
        return;
    };
    let class = native::class_name(root).replace(['\t', '\r', '\n'], " ");
    let line = format!("{kind}\t{root:x}\t{}\t{class}\n", native::pid_of(root));
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
        let _ = file.sync_data();
    }
}

fn ledger_configured() -> bool {
    std::env::var_os("MIXDOG_COMPUTER_INACTIVE_LEDGER").is_some_and(|path| !path.is_empty())
}

fn inactive_root(handle: Wid) -> Wid {
    if !native::is_window(handle) {
        return 0;
    }
    match native::root_of(handle) {
        0 => handle,
        root => root,
    }
}

fn ex_style(root: Wid) -> i32 {
    // SAFETY: plain value arguments.
    unsafe { GetWindowLongW(hwnd(root), GWL_EXSTYLE) }
}

/// Background input must not raise its target over the window the person is
/// in: a no-activate top level declines activation while the click, key or
/// accessibility call still lands. Returns the root to release, or 0 when
/// there is nothing to release (already foreground or non-activatable, or the
/// window refused the style).
pub fn hold_inactive(handle: Wid) -> Wid {
    let root = inactive_root(handle);
    if root == 0 {
        return 0;
    }
    let mut guard = HOLDERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let holders = guard.get_or_insert_with(HashMap::new);
    if let Some(count) = holders.get_mut(&root) {
        *count += 1;
        return root;
    }
    if root == native::foreground() || ex_style(root) & WS_EX_NOACTIVATE != 0 {
        return 0;
    }
    // A bit that cannot be recorded is never written: a killed host could not
    // clear it, so delivery goes on unprotected instead.
    if !ledger_configured() {
        return 0;
    }
    ledger_append('+', root);
    // SAFETY: plain value arguments.
    unsafe { SetWindowLongW(hwnd(root), GWL_EXSTYLE, ex_style(root) | WS_EX_NOACTIVATE) };
    if ex_style(root) & WS_EX_NOACTIVATE == 0 {
        ledger_append('-', root);
        return 0;
    }
    holders.insert(root, 1);
    root
}

/// Ends one hold; the last holder clears the bit and reads it back.
pub fn release_inactive(root: Wid) -> Result<(), String> {
    if root == 0 {
        return Ok(());
    }
    let mut guard = HOLDERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let holders = guard.get_or_insert_with(HashMap::new);
    let Some(count) = holders.get_mut(&root) else {
        return Ok(());
    };
    if *count > 1 {
        *count -= 1;
        return Ok(());
    }
    if !native::is_window(root) {
        holders.remove(&root);
        ledger_append('-', root);
        return Ok(());
    }
    // SAFETY: plain value arguments.
    unsafe { SetWindowLongW(hwnd(root), GWL_EXSTYLE, ex_style(root) & !WS_EX_NOACTIVATE) };
    if ex_style(root) & WS_EX_NOACTIVATE != 0 {
        *count = 0;
        return Err("input_cleanup_unconfirmed: the background target could not be made activatable again".into());
    }
    holders.remove(&root);
    ledger_append('-', root);
    Ok(())
}

pub struct WinBackground {
    shared: Arc<Shared>,
}

impl WinBackground {
    pub fn new(shared: Arc<Shared>) -> WinBackground {
        WinBackground { shared }
    }

    /// Runs one delivery with the target held inactive, then gives the person
    /// their window back if the target still raised itself and nobody touched
    /// the input meanwhile.
    pub fn while_inactive<T>(
        &self,
        top: Wid,
        deliver: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let root = inactive_root(top);
        let before = native::foreground();
        let sequence = self.shared.foreign_sequence();
        let held = hold_inactive(top);
        let outcome = deliver();
        std::thread::sleep(Duration::from_millis(50));
        self.recover_foreground(root, before, sequence);
        let released = release_inactive(held);
        let value = outcome?;
        released?;
        Ok(value)
    }

    /// A target that refused the style, or raised itself anyway, gives the
    /// person's window back: at most two attempts, each only while the target
    /// still holds the foreground and no person's input arrived since delivery began.
    fn recover_foreground(&self, root: Wid, before: Wid, sequence: i64) {
        if root == 0 || !native::is_window(before) || before == root || native::is_owned_by(before, root) || native::root_of(before) == root {
            return;
        }
        for attempt in 0..2 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(12));
            }
            let current = native::foreground();
            let target_holds = current == root
                || native::root_of(current) == root
                || native::is_owned_by(current, root)
                || native::shares_process(current, root);
            if !target_holds || self.shared.foreign_sequence() != sequence {
                return;
            }
            native::try_focus_attached(before);
        }
    }
}

impl Background for WinBackground {
    fn validate(&self, window: Wid, action: &str) -> Result<(), String> {
        if !native::is_window(window) {
            return Err("stale_target|background input window is stale".into());
        }
        if (action == "key" || action == "type") && !supports_keyboard_class(&native::class_name(window)) {
            return Err("background_unsupported|target renderer does not accept posted keyboard input; use semantic value input or explicit foreground delivery; no input sent".into());
        }
        Ok(())
    }

    fn pointer(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        kind: &str,
        modifiers: &[Mod],
    ) -> Result<String, String> {
        self.while_inactive(window, || {
            let target = message_target_at(window, x, y).map_err(|error| error.text)?;
            let p = message_point(target, x, y).map_err(|error| error.text)?;
            let point = point_param(p.x, p.y);
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            if !["move", "right", "middle", "click", "double", "triple", "press", "release"].contains(&kind) {
                return Err(format!("background_unsupported|unknown background pointer action: {kind}"));
            }
            // The message target is often a renderer child whose own class says
            // nothing about the host, so the top level decides too.
            if (kind == "double" || kind == "triple")
                && (is_chromium(&native::class_name(target)) || is_chromium(&native::class_name(window)))
            {
                return Err("background_unsupported|target renderer ignores a posted double-click; use explicit foreground delivery; no input sent".into());
            }
            send(target, WM_MOUSEMOVE, flags, point).map_err(|error| error.text)?;
            match kind {
                "move" => {}
                "press" => {
                    send(target, WM_LBUTTONDOWN, flags | MK_LBUTTON, point).map_err(|error| error.text)?;
                }
                "release" => {
                    send(target, WM_LBUTTONUP, flags, point).map_err(|error| error.text)?;
                }
                "right" => mouse_click(target, point, flags, WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON)?,
                "middle" => mouse_click(target, point, flags, WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON)?,
                _ => {
                    mouse_click(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)?;
                    if kind == "double" || kind == "triple" {
                        std::thread::sleep(Duration::from_millis(20));
                        mouse_click(target, point, flags, WM_LBUTTONDBLCLK, WM_LBUTTONUP, MK_LBUTTON)?;
                    }
                    if kind == "triple" {
                        std::thread::sleep(Duration::from_millis(20));
                        mouse_click(target, point, flags, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)?;
                    }
                }
            }
            Ok(window_id(target))
        })
    }

    fn wheel(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        clicks: i32,
        horizontal: bool,
        modifiers: &[Mod],
    ) -> Result<String, String> {
        self.while_inactive(window, || {
            let target = message_target_at(window, x, y).map_err(|error| error.text)?;
            // Chromium reroutes a wheel message to whatever window is on top at
            // its point, so the target would never scroll; refuse before sending.
            if (is_chromium(&native::class_name(target)) || is_chromium(&native::class_name(window)))
                && native::window_at_point(x, y) != window
            {
                return Err("background_unsupported|the scroll point is covered by another window, so a background wheel would be dropped or reach that window; no input sent".into());
            }
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            let client = message_point(target, x, y).map_err(|error| error.text)?;
            send(target, WM_MOUSEMOVE, flags, point_param(client.x, client.y)).map_err(|error| error.text)?;
            // The host's positive clicks scroll the content down or right; the
            // wheel's positive delta scrolls up, but right for the horizontal wheel.
            let notches = if horizontal { clicks } else { -clicks };
            let delta = (notches * 120).clamp(-12000, 12000);
            let packed = (((delta & 0xFFFF) as usize) << 16) | flags;
            let mut screen = POINT { x, y };
            // SAFETY: screen is a valid in/out pointer.
            if !unsafe { PhysicalToLogicalPointForPerMonitorDPI(Some(hwnd(target)), &mut screen) }.as_bool() {
                return Err("background_message_rejected|could not map point into target window DPI".to_string());
            }
            send(
                target,
                if horizontal { WM_MOUSEHWHEEL } else { WM_MOUSEWHEEL },
                packed,
                point_param(screen.x, screen.y),
            )
            .map_err(|error| error.text)?;
            Ok(window_id(target))
        })
    }

    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        if points.len() < 2 {
            return Err("drag path requires at least two points".into());
        }
        self.while_inactive(window, || {
            let target = message_target_at(window, points[0].0, points[0].1).map_err(|error| error.text)?;
            for (x, y) in &points[1..] {
                message_target_at(window, *x, *y).map_err(|error| error.text)?;
            }
            let start = message_point(target, points[0].0, points[0].1).map_err(|error| error.text)?;
            let flags = pointer_flags(modifiers).map_err(|error| error.text)?;
            send(target, WM_MOUSEMOVE, flags, point_param(start.x, start.y)).map_err(|error| error.text)?;
            let last = std::rc::Rc::new(std::cell::Cell::new(start));
            let release = bound(target, {
                let last = last.clone();
                move || {
                    let point = last.get();
                    send(target, WM_LBUTTONUP, flags, point_param(point.x, point.y)).map(|_| ())
                }
            });
            with_release(
                || send(target, WM_LBUTTONDOWN, flags | MK_LBUTTON, point_param(start.x, start.y)).map(|_| ()),
                || {
                    for pair in points.windows(2) {
                        let ((from_x, from_y), (to_x, to_y)) = (pair[0], pair[1]);
                        for step in 1..=12 {
                            let x = from_x + (to_x - from_x) * step / 12;
                            let y = from_y + (to_y - from_y) * step / 12;
                            let point = message_point(target, x, y)?;
                            last.set(point);
                            send(target, WM_MOUSEMOVE, flags | MK_LBUTTON, point_param(point.x, point.y))?;
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    }
                    Ok(())
                },
                &release,
            )?;
            Ok(window_id(target))
        })
    }

    fn keys(&self, window: Wid, keys: &str) -> Result<String, String> {
        let strokes = parse_keys(keys).map_err(|error| error.text)?;
        self.while_inactive(window, || {
            let target = keyboard_target(window).map_err(|error| error.text)?;
            for stroke in strokes {
                match stroke {
                    Stroke::Char(glyph) => background_char(target, glyph).map_err(|error| error.text)?,
                    Stroke::Key(vk) => background_virtual_key(target, vk)?,
                }
            }
            Ok(window_id(target))
        })
    }

    fn text(&self, window: Wid, text: &str) -> Result<String, String> {
        self.while_inactive(window, || {
            let target = keyboard_target(window).map_err(|error| error.text)?;
            for glyph in text.chars() {
                match glyph {
                    '\n' => background_virtual_key(target, 0x0D)?,
                    '\r' => {}
                    other => background_char(target, other).map_err(|error| error.text)?,
                }
            }
            Ok(window_id(target))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_streams_parse_before_any_delivery() {
        let strokes = parse_keys("ab{ENTER 2}{{}").unwrap();
        assert_eq!(
            strokes,
            vec![
                Stroke::Char('a'),
                Stroke::Char('b'),
                Stroke::Key(0x0D),
                Stroke::Key(0x0D),
                Stroke::Char('{'),
            ]
        );
        assert!(parse_keys("^c").is_err());
        assert!(parse_keys("{WIN}").is_err());
        assert!(parse_keys("{NOPE}").is_err());
        assert_eq!(parse_keys("+").unwrap(), vec![Stroke::Char('+')]);
    }

    #[test]
    fn chromium_classes_are_recognised() {
        assert!(is_chromium("Chrome_WidgetWin_1"));
        assert!(is_chromium("Chrome_RenderWidgetHostHWND"));
        assert!(!is_chromium("Notepad"));
    }
}
