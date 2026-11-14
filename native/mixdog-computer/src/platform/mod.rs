//! What a desktop must provide. Each operating system implements `Desktop`;
//! the host holds every policy decision and calls only these primitives.

use crate::a11y::Accessibility;
use crate::keys::{Key, Mod};
use crate::lease_api::ForegroundLease;
use crate::observer::Shared;
use crate::protocol::{Obj, Req};
use serde_json::{json, Value};
use std::sync::Arc;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod unsupported;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::lease_now_ms;

/// A native top-level window number: a CGWindowID on macOS, an XID on X11,
/// an HWND on Windows.
pub type Wid = u64;

/// Window ids travel in the same `hwnd:0x…` form on every platform so the
/// host and its capture matching treat them alike.
pub fn window_id(handle: Wid) -> String {
    format!("hwnd:0x{handle:X}")
}

/// `get` refuses a slice that would split a multi-byte character, so
/// non-ASCII input is simply "no prefix" instead of a panic.
fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

pub fn parse_window_id(value: &str) -> Wid {
    let mut raw = value.trim();
    if let Some(rest) = strip_prefix_ignore_case(raw, "hwnd:") {
        raw = rest;
    }
    if let Some(rest) = strip_prefix_ignore_case(raw, "0x") {
        raw = rest;
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
    /// The process that owns the content a hosting frame shows (a packaged
    /// app's frame belongs to the system); 0 when the window hosts none.
    pub content_pid: i64,
}

/// How a window's process ranks against this host's own by integrity level.
pub struct Integrity {
    pub own_rid: i32,
    pub target_rid: i32,
    pub own_name: &'static str,
    pub target_name: &'static str,
}

impl Integrity {
    pub fn known(&self) -> bool {
        self.own_rid > 0 && self.target_rid > 0
    }
    pub fn higher(&self) -> bool {
        self.own_rid > 0 && self.target_rid > self.own_rid
    }
}

/// A window's own rendering, read without touching the screen.
pub struct Surface {
    pub png: Vec<u8>,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// The PrintWindow flags tried, in order ("2" or "2,0"); None when the
    /// surface did not come from PrintWindow (MixWin32.LastPrintWindowFlags).
    pub print_window_flags: Option<&'static str>,
}

/// Whether a window capture's resources were released (Close-WindowCaptureResources,
/// window-capture.ps1:7-18): `confirmed`, `failed` when a Close failed, or
/// `unconfirmed` when a GPU copy was abandoned in flight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cleanup {
    pub status: &'static str,
    pub cancellation: Option<&'static str>,
}

impl Cleanup {
    pub const CONFIRMED: Cleanup = Cleanup {
        status: "confirmed",
        cancellation: None,
    };
}

/// A refused capture: the coded text and what became of its resources.
#[derive(Debug)]
pub struct CaptureFailure {
    pub text: String,
    pub cleanup: Cleanup,
}

/// A refusal before any resource was held releases nothing.
impl From<String> for CaptureFailure {
    fn from(text: String) -> CaptureFailure {
        CaptureFailure {
            text,
            cleanup: Cleanup::CONFIRMED,
        }
    }
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

/// A `capture_backend` this desktop does not know.
pub const UNKNOWN_CAPTURE_BACKEND: &str =
    "capture_source_unavailable|unknown window capture backend";

/// A saved-login step on a desktop without the saved-login worker.
pub const SAVED_LOGIN_UNSUPPORTED: &str =
    "saved_login_refused: saved logins are not supported on this desktop; no input was sent";

/// The reason a saved-login read finds no focused field in the browser.
pub const SAVED_LOGIN_NO_FOCUS: &str =
    "no field of this browser window holds keyboard focus; click the field first";

/// A saved-login refusal: nothing was sent (Stop-SavedLogin,
/// runtime-saved-login.ps1:33-35).
pub fn saved_login_refused(reason: &str) -> String {
    format!("saved_login_refused: {reason}; no input was sent")
}

/// A saved-login target that differs from the checked one (Stop-SavedLoginChanged).
pub fn saved_login_changed(reason: &str) -> String {
    format!("saved_login_changed: {reason} since the check; nothing was written")
}

/// The live image of a browser process, verified afresh: the kernel's path
/// for the open process, its Authenticode organisation (O=), and the process's
/// creation time (FILETIME), which binds later reads to this very process.
pub struct SavedLoginImage {
    pub path: String,
    pub signer: String,
    pub start_time: i64,
}

/// What the focused element of a browser window is, read live
/// (Get-SavedLoginFieldFacts).
pub struct SavedLoginField {
    pub edit: bool,
    pub focused: bool,
    pub enabled: bool,
    pub read_only: bool,
    pub password: bool,
    /// UTF-16 length of the field's value; -1 when it cannot be read.
    pub value_length: i64,
}

/// The focused field of a browser window and the page document holding it.
pub struct SavedLoginFocus {
    pub runtime_id: String,
    pub document_id: String,
    /// The document's own address ("" when unreadable).
    pub document_url: String,
    pub field: SavedLoginField,
}

/// The reads and the one write behind a saved-login fill
/// (runtime-saved-login.ps1). Every refusal is a `saved_login_*` text.
pub trait SavedLoginReads {
    /// Whether `window` is a top-level window (GA_ROOT is itself).
    fn top_level(&self, window: Wid) -> bool;
    /// The image of live process `pid`, or None when it cannot be proven
    /// signed by a trusted chain (VerifiedProcessImage).
    fn verified_image(&self, pid: u32) -> Option<SavedLoginImage>;
    /// Creation time of the live process `pid`; 0 when it is not running.
    fn start_time(&self, pid: u32) -> i64;
    /// The focused field of `window`, whose process is `pid` (Get-SavedLoginTarget).
    fn focus(&self, window: Wid, pid: u32) -> Result<SavedLoginFocus, String>;
    /// The text of every address bar of the browser's own UI in `window`.
    fn address_bars(&self, window: Wid) -> Result<Vec<String>, String>;
    /// The one ValuePattern write of `value` into the focused element
    /// `runtime_id` of process `pid`: `authorize` runs right before it. Err
    /// means nothing was written; Ok says whether the field's length
    /// confirmed the write.
    fn set_value(
        &self,
        pid: u32,
        runtime_id: &str,
        value: &str,
        authorize: &dyn Fn() -> Result<(), String>,
    ) -> Result<bool, String>;
}

/// A native edit selection on a desktop that cannot select by messages.
pub const NO_NATIVE_EDIT_SELECTION: &str =
    "background_unsupported|this desktop cannot select a control's text by native messages; no input sent";

/// A process whose fate the system does not prove (Do-ProcessFate,
/// runtime-saved-login.ps1:330-347).
pub fn unknown_process_fate() -> Value {
    json!({ "state": "unknown", "created": "" })
}

/// Input delivered to one window without taking the foreground or moving the
/// user's pointer. Every method either delivers or refuses before sending.
pub trait Background {
    /// Refuses before any input when this target cannot take background input.
    fn validate(&self, window: Wid, action: &str) -> Result<(), String>;
    fn pointer(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        kind: &str,
        modifiers: &[Mod],
    ) -> Result<String, String>;
    fn wheel(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        clicks: i32,
        horizontal: bool,
        modifiers: &[Mod],
    ) -> Result<String, String>;
    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod])
        -> Result<String, String>;
    fn keys(&self, window: Wid, keys: &str) -> Result<String, String>;
    fn text(&self, window: Wid, text: &str) -> Result<String, String>;

    /// Keys for `preferred`, the exact child control a ref names inside
    /// `window`; 0 means the window's focused control.
    fn keys_to(&self, window: Wid, _preferred: Wid, keys: &str) -> Result<String, String> {
        self.keys(window, keys)
    }
    fn text_to(&self, window: Wid, _preferred: Wid, text: &str) -> Result<String, String> {
        self.text(window, text)
    }
    /// `validate` for the exact child and key stream a step will use.
    fn validate_target(
        &self,
        window: Wid,
        _preferred: Wid,
        action: &str,
        _keys: Option<&str>,
    ) -> Result<(), String> {
        self.validate(window, action)
    }
    /// Keeps `root` inactive across several deliveries; scopes nest.
    fn begin_scope(&self, _root: Wid) -> Result<(), String> {
        Ok(())
    }
    fn end_scope(&self, _root: Wid) -> Result<(), String> {
        Ok(())
    }
    /// Keeps `window` inactive past one call, as a held pointer button
    /// needs; the root to release, 0 when nothing is held.
    fn hold(&self, _window: Wid) -> Result<Wid, String> {
        Ok(0)
    }
    fn release_hold(&self, _root: Wid) -> Result<(), String> {
        Ok(())
    }
    /// Whether `window` renders web content, whose fields only a keyboard
    /// route reaches without replacing their value.
    fn is_web_content_host(&self, _window: Wid) -> bool {
        false
    }
    /// Selects the control's whole text by messages and returns its end
    /// position, -1 when the selection cannot be proved.
    fn select_all(&self, _top: Wid, _preferred: Wid, _has_text: bool) -> Result<i32, String> {
        Err(NO_NATIVE_EDIT_SELECTION.into())
    }
    /// The control's last insertion position, 0 when it is empty; -1 when
    /// the reply is not one position.
    fn text_end(&self, _top: Wid, _preferred: Wid) -> Result<i32, String> {
        Err(NO_NATIVE_EDIT_SELECTION.into())
    }
    /// A native control's own state for `action` (an edit's text, a
    /// button's check); None where it reports none.
    fn native_state(&self, _child: Wid, _action: &str) -> Option<String> {
        None
    }
    /// Whether a hold this request asked for was refused, leaving its
    /// delivery less protected; reading it clears it.
    fn take_activation_unprotected(&self) -> bool {
        false
    }
    /// A refusal for input a standard dialog would not act on.
    fn dialog_refusal(
        &self,
        _top: Wid,
        _preferred: Wid,
        _action: &str,
        _keys: Option<&str>,
    ) -> Option<String> {
        None
    }
}

pub trait Desktop {
    fn name(&self) -> &'static str;
    /// What an accessibility element reports as its source.
    fn element_source(&self) -> &'static str {
        self.name()
    }

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
    /// Whether focus may be sent to `handle`: a window the person can see,
    /// not hidden, cloaked or minimized (Test-VisibleFocusHome).
    fn is_visible_focus_home(&self, handle: Wid) -> bool {
        self.info(handle).is_some_and(|info| !info.minimized)
    }
    /// Whether `candidate` is `surface` itself or drawn inside it.
    fn is_contained(&self, candidate: Wid, surface: Wid) -> bool {
        candidate != 0 && candidate == surface
    }
    /// The window process's integrity against this host's; `None` where the
    /// system has no such boundary.
    fn integrity(&self, _handle: Wid) -> Option<Integrity> {
        None
    }
    /// The window's own rendering; refuses where the platform has none.
    fn window_surface(&self, handle: Wid) -> Result<Surface, String> {
        Err(format!(
            "capture_source_unavailable: {} has no native window surface backend; the composited capture covers {}",
            self.name(),
            window_id(handle)
        ))
    }
    fn move_window(
        &self,
        handle: Wid,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<(), String>;
    fn set_window_state(&self, handle: Wid, state: WinState) -> Result<(), String>;
    fn close_window(&self, handle: Wid) -> Result<bool, String>;
    fn is_responding(&self, handle: Wid) -> bool;
    fn terminate(&self, pid: i64) -> Result<(), String> {
        terminate_pid(pid)
    }

    fn cursor(&self) -> (i32, i32);
    fn move_pointer(&self, x: i32, y: i32) -> Result<(), String>;
    fn button(&self, button: Button, down: bool, x: i32, y: i32, clicks: u32)
        -> Result<(), String>;
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
    /// Who owns the window now, as `pid:thread` (WindowOwnerIdentity): a
    /// reused handle names another owner. Empty when it cannot say.
    fn window_owner_identity(&self, _handle: Wid) -> String {
        String::new()
    }
    /// The process owning a window; 0 for none (ProcessOf).
    fn pid_of(&self, handle: Wid) -> u32 {
        self.info(handle).map_or(0, |info| info.pid as u32)
    }

    fn background(&self) -> Option<&dyn Background>;
    fn accessibility(&self) -> Option<&dyn Accessibility>;

    fn clipboard_read(&self) -> Result<String, String>;
    fn clipboard_write(&self, text: &str) -> Result<bool, String>;
    fn launch(&self, target: &str, app: Option<&AppEntry>) -> Result<Launched, String>;
    fn installed_apps(&self) -> Result<Vec<AppEntry>, String>;
    fn ocr(&self, image: &[u8], language: &str, max_words: usize) -> Result<Value, String>;
    fn ocr_status(&self, language: &str) -> Value;
    /// RGBA pixels encoded for the model: a JPEG of `quality` (PNG when it
    /// cannot be made), or a PNG without one. None where this desktop has no
    /// encoder; the caller then keeps the PNG it holds.
    fn encode_image(
        &self,
        _rgba: &[u8],
        _width: u32,
        _height: u32,
        _quality: Option<u8>,
    ) -> Option<(&'static str, Vec<u8>)> {
        None
    }

    /// The virtual key and modifiers that type `glyph` on the foreground
    /// window's keyboard layout; None leaves the US table to decide.
    fn resolve_glyph(&self, _glyph: char) -> Option<(u16, Vec<Mod>)> {
        None
    }
    /// How far, in pixels, the pointer may land from the point it was sent to.
    fn cursor_tolerance(&self) -> i32 {
        1
    }
    /// The window's rendering through the named capture backend, within
    /// `work_ms` of work.
    fn window_surface_backend(
        &self,
        handle: Wid,
        backend: &str,
        _work_ms: u32,
    ) -> Result<Surface, CaptureFailure> {
        match backend {
            "print_window" => self.window_surface(handle).map_err(CaptureFailure::from),
            _ => Err(UNKNOWN_CAPTURE_BACKEND.to_string().into()),
        }
    }
    /// Runs one background accessibility call on `target` under the
    /// platform's guard against the target taking the foreground, and
    /// returns the guard's facts with the call's result.
    fn guard_semantic(
        &self,
        _target: Wid,
        _request_id: i64,
        _lease: &dyn ForegroundLease,
        op: &mut dyn FnMut() -> Result<Obj, String>,
    ) -> (Result<Obj, String>, Option<Value>) {
        (op(), None)
    }
    /// Whether process `pid`, started at FILETIME `created` (empty: whichever
    /// process has the id now), runs or has ended: {state, created}.
    fn process_fate(&self, _pid: &str, _created: &str) -> Value {
        unknown_process_fate()
    }
    /// The reads behind a saved-login fill; None where this desktop fills none.
    fn saved_login(&self) -> Option<&dyn SavedLoginReads> {
        None
    }
    /// Runs the request in an elevated worker when its target is above this
    /// process's integrity; None when the platform has no such worker.
    fn elevated_run(&self, _req: &Req) -> Option<Result<Obj, String>> {
        None
    }
    /// Starts the cursor-theme watchdog while the caller still has focus work
    /// to do, and drops a held theme the watchdog already ended; whether a
    /// theme is held now.
    fn cursor_theme_reserve(&self) -> Result<bool, String> {
        Ok(false)
    }
    /// Hides the system cursor while the overlay draws the agent's (a held
    /// theme keeps the decoration it began with); whether the cursor is hidden.
    fn cursor_theme_begin(&self, _decorate: bool) -> Result<bool, String> {
        Ok(false)
    }
    /// Restores the system cursors and drops an unused reservation; whether a
    /// theme was held.
    fn cursor_theme_end(&self) -> Result<bool, String> {
        Ok(false)
    }
    /// Lets go of what this process holds outside the input ledger (its own
    /// foreground lock), as the resident host ends.
    fn release_process_holds(&self) {}
}

pub fn create(observer: Arc<Shared>, marker: i64) -> Box<dyn Desktop> {
    #[cfg(target_os = "macos")]
    return Box::new(macos::MacDesktop::new(observer, marker));
    #[cfg(target_os = "linux")]
    return linux::create(observer, marker);
    #[cfg(windows)]
    return Box::new(windows::WinDesktop::new(observer, marker));
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (observer, marker);
        Box::new(unsupported::Unsupported::new(
            "platform_unsupported: this build has no desktop backend",
        ))
    }
}

/// Releases every key and button this process may still hold, from a fresh
/// process after the resident host is gone.
pub fn release_owned_input() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::release_owned_input();
    #[cfg(target_os = "linux")]
    return linux::release_owned_input();
    #[cfg(windows)]
    return windows::release_owned_input();
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    return Ok(());
}

/// The `--elevated-request` worker: vets and serves the one request a UAC
/// launch staged; the process exit code.
pub fn elevated_worker(
    args: &[String],
    validate: fn(&Req) -> Result<(), String>,
    serve: fn(&str) -> Value,
) -> i32 {
    #[cfg(windows)]
    return windows::elevated::worker(args, validate, serve);
    #[cfg(not(windows))]
    {
        let _ = (args, validate, serve);
        eprintln!("mixdog-computer --elevated-request: not available on this platform");
        2
    }
}

/// `--cursor-watchdog <parent_pid>`: the child that keeps the cursor theme and
/// the parent's input receipt, and restores both when the parent is gone;
/// the process exit code.
pub fn cursor_watchdog(parent_pid: &str) -> i32 {
    #[cfg(windows)]
    return windows::cursor_watchdog(parent_pid);
    #[cfg(not(windows))]
    {
        let _ = parent_pid;
        eprintln!("mixdog-computer --cursor-watchdog: only Windows hides the cursor");
        2
    }
}

/// The remote screen's input process (crate::screen_input); the exit code.
#[cfg(windows)]
pub fn screen_input() -> i32 {
    windows::screen_input()
}

/// Undoes the no-activate holds a killed host recorded in its ledger, from a
/// fresh process; nothing to undo where no window is held inactive.
pub fn recover_inactive_ledger() -> Result<(), String> {
    #[cfg(windows)]
    return windows::recover_inactive_ledger();
    #[cfg(not(windows))]
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

#[cfg(windows)]
pub fn terminate_pid(pid: i64) -> Result<(), String> {
    windows::terminate_pid(pid)
}

#[cfg(not(any(unix, windows)))]
pub fn terminate_pid(pid: i64) -> Result<(), String> {
    Err(format!(
        "terminating pid {pid} is not supported on this platform"
    ))
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
        let read = libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if read == size {
            info.pbi_ppid as i64
        } else {
            0
        }
    }
}

#[cfg(windows)]
pub fn parent_pid(pid: i64) -> i64 {
    windows::parent_pid(pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
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

    #[test]
    fn non_ascii_window_ids_do_not_panic() {
        // Byte 5 and byte 2 both fall inside a multi-byte character.
        assert_eq!(parse_window_id("ééé"), 0);
        assert_eq!(parse_window_id("héwnd:0x2A"), 0);
        assert_eq!(parse_window_id("h\u{e9}"), 0);
        assert_eq!(parse_window_id("0\u{e9}"), 0);
        assert_eq!(parse_window_id("hwnd:0x2A"), 0x2a);
    }
}
