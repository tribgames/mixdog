//! The recorder's proxy DLL: an `IDispatch` proxy around every Office object the unchanged PowerShell hosts touch, which
//! appends what each call did to the JSON-lines log named by `MIXDOG_COM_RECORDER_LOG` (a variable only this test tool
//! reads), in the format of `mixdog_office_com::com::calllog`.
//!
//! `hook.ps1` loads the DLL with `Add-Type` (P/Invoke) and calls two exports:
//!
//! * [`mixdog_com_recorder_wrap`]: an `IUnknown` of a real Office object in, the proxy's `IUnknown` out (one reference
//!   the caller releases), null when the recorder is off (no log) or the object is not an `IDispatch`. One proxy exists
//!   per COM identity (the `QueryInterface(IUnknown)` pointer), so `[object]::ReferenceEquals` and
//!   `RuntimeHelpers.GetHashCode` on the objects the host holds behave as they do unhooked.
//! * [`mixdog_com_recorder_boundary`]: a marker line (`operation`, `snapshot`, `issues`) with the operation's JSON, so a
//!   log can be cut per operation.
//!
//! What a proxy forwards and what it logs is in [`proxy`]; `IEnumVARIANT` is in [`enumproxy`]. A key a call line carries
//! beyond the format (`"lookups"`: the `GetIDsOfNames` answers since the previous call of the object, with the LCID) is
//! ignored by `CallLog::parse`.
//!
//! The crate is Windows only: elsewhere it is empty.
#![cfg(windows)]

mod enumproxy;
mod proxy;

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_office_com::com::calllog::Boundary;
use mixdog_office_com::com::calllog::Entry;
use mixdog_office_com::com::calllog::entry_line;
use serde_json::Value as Json;

/// The variable that names the log file; a recorder run sets it, nothing else reads it.
pub const LOG_VARIABLE: &str = "MIXDOG_COM_RECORDER_LOG";

const FILE_APPEND_DATA: u32 = 0x0000_0004;
const FILE_SHARE_READ_WRITE: u32 = 0x0000_0003;
const OPEN_ALWAYS: u32 = 4;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
const INVALID_HANDLE_VALUE: isize = -1;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(name: *const u16, access: u32, share: u32, security: *mut c_void, disposition: u32, attributes: u32, template: *mut c_void) -> isize;
    fn WriteFile(file: isize, buffer: *const u8, length: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
}

/// A lock that a panic in another thread does not poison: the log is a diagnostic, never a reason to fail a call.
pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The handle of the log file, opened once for appending (`FILE_APPEND_DATA`: every `WriteFile` lands at the end, as
/// one write, so lines never interleave).
fn log_handle() -> Option<isize> {
    static HANDLE: OnceLock<Option<isize>> = OnceLock::new();
    *HANDLE.get_or_init(|| {
        let path = std::env::var_os(LOG_VARIABLE)?;
        let wide: Vec<u16> = path.encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call; the other arguments are plain values or null.
        let handle = unsafe {
            CreateFileW(wide.as_ptr(), FILE_APPEND_DATA, FILE_SHARE_READ_WRITE, std::ptr::null_mut(), OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut())
        };
        (handle != INVALID_HANDLE_VALUE).then_some(handle)
    })
}

#[cfg(test)]
thread_local! {
    /// The lines a unit test captures instead of writing a file.
    pub(crate) static CAPTURE: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

/// Whether the recorder has anywhere to write.
pub(crate) fn enabled() -> bool {
    #[cfg(test)]
    {
        if CAPTURE.with(|capture| capture.borrow().is_some()) {
            return true;
        }
    }
    log_handle().is_some()
}

/// Appends one line. `build` receives the line's sequence number, assigned under the lock that orders the writes, so the
/// numbers run in the order of the file.
pub(crate) fn emit_with(build: impl FnOnce(u64) -> Json) {
    static ORDER: Mutex<()> = Mutex::new(());
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let _order = locked(&ORDER);
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let mut line = build(seq).to_string();
    #[cfg(test)]
    {
        let captured = CAPTURE.with(|capture| match capture.borrow_mut().as_mut() {
            Some(lines) => {
                lines.push(line.clone());
                true
            }
            None => false,
        });
        if captured {
            return;
        }
    }
    let Some(handle) = log_handle() else { return };
    line.push('\n');
    let mut written = 0u32;
    // SAFETY: `handle` is the open log; `line` is valid for its length; `written` lives through the call.
    unsafe { WriteFile(handle, line.as_ptr(), line.len() as u32, &mut written, std::ptr::null_mut()) };
}

/// A NUL-terminated UTF-16 string as text (null is the empty string).
///
/// # Safety
/// `text` is null or points at a NUL-terminated UTF-16 string.
pub(crate) unsafe fn read_wide(text: *const u16) -> String {
    if text.is_null() {
        return String::new();
    }
    let mut length = 0;
    // SAFETY: the caller guarantees the terminator, so every read before it is inside the string.
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(text, length))
    }
}

/// Wraps a real Office object in the proxy of its COM identity.
///
/// # Safety
/// `unknown` is null or a valid COM interface pointer the caller holds a reference to.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn mixdog_com_recorder_wrap(unknown: *mut c_void) -> *mut c_void {
    if !enabled() {
        return std::ptr::null_mut();
    }
    // SAFETY: forwarded from the caller's guarantee.
    unsafe { proxy::wrap_object(unknown) }
}

/// Writes a boundary marker (`kind` is `operation`, `snapshot` or `issues`; `payload` is the operation's JSON, or null).
///
/// # Safety
/// Each argument is null or a NUL-terminated UTF-16 string.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn mixdog_com_recorder_boundary(kind: *const u16, name: *const u16, payload: *const u16) {
    if !enabled() {
        return;
    }
    // SAFETY: forwarded from the caller's guarantee.
    let (kind, name, payload) = unsafe { (read_wide(kind), read_wide(name), read_wide(payload)) };
    let payload = (!payload.is_empty()).then(|| serde_json::from_str::<Json>(&payload).unwrap_or(Json::String(payload)));
    emit_with(|seq| entry_line(&Entry::Boundary(Boundary { seq, kind, name, payload })));
}
