//! What a desktop must provide. Each operating system implements `Desktop`;
//! the host holds every policy decision and calls only these primitives.

use crate::a11y::Accessibility;
use crate::keys::{Key, Mod};
use crate::observer::Shared;
use serde_json::Value;
use std::sync::Arc;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod unsupported;

/// A native top-level window number: a CGWindowID on macOS, an XID on X11.
pub type Wid = u64;

/// Window ids travel in the same `hwnd:0x…` form on every platform so the
/// host and its capture matching treat them alike.
pub fn window_id(handle: Wid) -> String {
    format!("hwnd:0x{handle:X}")
}

pub fn parse_window_id(value: &str) -> Wid {
    let mut raw = value.trim();
    if raw.len() >= 5 && raw[..5].eq_ignore_ascii_case("hwnd:") {
        raw = &raw[5..];
    }
    if raw.len() >= 2 && raw[..2].eq_ignore_ascii_case("0x") {
        raw = &raw[2..];
    }
    u64::from_str_radix(raw, 16).unwrap_or(0)
}

#[derive(Clone, Debug, Default)]
pub struct WindowInfo {
    pub handle: Wid,
    pub title: String,
    pub class_name: String,
    pub app: String,
    pub pid: i64,
    pub parent_pid: i64,
    pub owner: Wid,
    pub focused: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// The content area; equal to the frame where the platform cannot tell.
    pub client: (i32, i32, i32, i32),
}

impl WindowInfo {
    pub fn id(&self) -> String {
        window_id(self.handle)
    }
    pub fn owner_id(&self) -> String {
        if self.owner == 0 {
            String::new()
        } else {
            window_id(self.owner)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WinState {
    Minimize,
    Maximize,
    Restore,
}

#[derive(Clone, Debug)]
pub struct AppEntry {
    pub name: String,
    pub app_id: String,
}

pub struct Launched {
    pub route: &'static str,
    pub pid: i64,
    pub app_id: String,
    pub app_hint: String,
}

/// Input delivered to one window without taking the foreground or moving the
/// user's pointer. Every method either delivers or refuses before sending.
pub trait Background {
    /// Refuses before any input when this target cannot take background input.
    fn validate(&self, window: Wid, action: &str) -> Result<(), String>;
    fn pointer(&self, window: Wid, x: i32, y: i32, kind: &str, modifiers: &[Mod]) -> Result<String, String>;
    fn wheel(&self, window: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod]) -> Result<String, String>;
    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String>;
    fn keys(&self, window: Wid, keys: &str) -> Result<String, String>;
    fn text(&self, window: Wid, text: &str) -> Result<String, String>;
}

pub trait Desktop {
    fn name(&self) -> &'static str;

    fn windows(&self) -> Result<Vec<WindowInfo>, String>;
    fn info(&self, handle: Wid) -> Option<WindowInfo>;
    fn is_window(&self, handle: Wid) -> bool {
        handle != 0 && self.info(handle).is_some()
    }
    fn foreground(&self) -> Wid;
    fn focus(&self, handle: Wid) -> bool;
    fn window_at_point(&self, x: i32, y: i32) -> Wid;
    /// The top-level windows that belong with `handle`: its process's other
    /// windows, dialogs and popups.
    fn related_windows(&self, handle: Wid) -> Vec<Wid>;
    /// A popup, sheet or dialog `candidate` that `owner` owns.
    fn is_owned_by(&self, candidate: Wid, owner: Wid) -> bool;
    fn move_window(&self, handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String>;
    fn set_window_state(&self, handle: Wid, state: WinState) -> Result<(), String>;
    fn close_window(&self, handle: Wid) -> Result<bool, String>;
    fn is_responding(&self, handle: Wid) -> bool;
    fn terminate(&self, pid: i64) -> Result<(), String> {
        terminate_pid(pid)
    }

    fn cursor(&self) -> (i32, i32);
    fn move_pointer(&self, x: i32, y: i32) -> Result<(), String>;
    fn button(&self, button: Button, down: bool, x: i32, y: i32, clicks: u32) -> Result<(), String>;
    /// Moves the pointer while the left button is held.
    fn drag_move(&self, x: i32, y: i32) -> Result<(), String>;
    fn wheel(&self, x: i32, y: i32, clicks: i32, horizontal: bool) -> Result<(), String>;
    fn key(&self, key: Key, down: bool) -> Result<(), String>;
    fn text(&self, text: &str) -> Result<(), String>;
    /// Whether any key or pointer button is physically held right now.
    fn input_held(&self) -> bool;
    /// Whether the desktop can take input at all (unlocked, a session exists).
    fn desktop_ready(&self) -> bool {
        true
    }

    fn background(&self) -> Option<&dyn Background>;
    fn accessibility(&self) -> Option<&dyn Accessibility>;

    fn clipboard_read(&self) -> Result<String, String>;
    fn clipboard_write(&self, text: &str) -> Result<bool, String>;
    fn launch(&self, target: &str, app: Option<&AppEntry>) -> Result<Launched, String>;
    fn installed_apps(&self) -> Result<Vec<AppEntry>, String>;
    fn ocr(&self, image: &[u8], language: &str, max_words: usize) -> Result<Value, String>;
    fn ocr_status(&self, language: &str) -> Value;
}

pub fn create(observer: Arc<Shared>, marker: i64) -> Box<dyn Desktop> {
    #[cfg(target_os = "macos")]
    return Box::new(macos::MacDesktop::new(observer, marker));
    #[cfg(target_os = "linux")]
    return linux::create(observer, marker);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (observer, marker);
        Box::new(unsupported::Unsupported::new("platform_unsupported: this build has no desktop backend"))
    }
}

/// Releases every key and button this process may still hold, from a fresh
/// process after the resident host is gone.
pub fn release_owned_input() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::release_owned_input();
    #[cfg(target_os = "linux")]
    return linux::release_owned_input();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Ok(());
}

#[cfg(unix)]
pub fn terminate_pid(pid: i64) -> Result<(), String> {
    if pid <= 0 || pid > i32::MAX as i64 {
        return Err(format!("invalid pid {pid}"));
    }
    // SAFETY: kill takes a plain pid and signal; it has no memory effects here.
    let status = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if status != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    for _ in 0..40 {
        // SAFETY: signal 0 only probes whether the process still exists.
        if unsafe { libc::kill(pid as i32, 0) } != 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn terminate_pid(pid: i64) -> Result<(), String> {
    Err(format!("terminating pid {pid} is not supported on this platform"))
}

/// The process's parent pid, read from the OS process table.
#[cfg(target_os = "linux")]
pub fn parent_pid(pid: i64) -> i64 {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            let rest = &stat[stat.rfind(')')? + 2..];
            rest.split_whitespace().nth(1)?.parse().ok()
        })
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
pub fn parent_pid(pid: i64) -> i64 {
    if pid <= 0 || pid > i32::MAX as i64 {
        return 0;
    }
    // SAFETY: proc_pidinfo fills at most `size` bytes of the zeroed struct.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let read = libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        if read == size {
            info.pbi_ppid as i64
        } else {
            0
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn parent_pid(_pid: i64) -> i64 {
    0
}

/// Whether `child` was started by `parent`.
pub fn is_child_process(child: i64, parent: i64) -> bool {
    child > 0 && parent > 0 && child != parent && parent_pid(child) == parent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids_round_trip() {
        assert_eq!(window_id(0x2a), "hwnd:0x2A");
        assert_eq!(parse_window_id("hwnd:0x2A"), 0x2a);
        assert_eq!(parse_window_id("HWND:0x2a"), 0x2a);
        assert_eq!(parse_window_id("0x10"), 16);
        assert_eq!(parse_window_id("nonsense"), 0);
    }
}
