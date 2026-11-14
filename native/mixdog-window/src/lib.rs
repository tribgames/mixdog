//! Keeps a Windows 11 Mica window painted active while another window has
//! the focus.
//!
//! DWM drops a window's Mica backdrop to its inactive fallback as soon as the
//! window's non-client area is deactivated (DefWindowProc's WM_NCACTIVATE
//! with a false wParam). Two calls do that when another window takes the
//! focus: the WM_NCACTIVATE message, which this subclass answers as an
//! activation before Chromium or DefWindowProc see it, and Chromium itself,
//! which calls DefWindowProc(WM_NCACTIVATE, false) directly while it handles
//! WM_ACTIVATE (HWNDMessageHandler::PaintAsActiveChanged). That one never
//! passes through a window procedure, so the frame is set active again as soon
//! as Chromium's WM_ACTIVATE handling returns, inside the same message,
//! before DWM composes or anything paints. WM_ACTIVATE itself and the focus
//! change reach Chromium unchanged.
//!
//! The window procedure is native on purpose: a window procedure that calls
//! into JavaScript runs Windows' modal move and size loops, and the browser's
//! tasks inside them, on the FFI callback stack, where a V8 garbage collection
//! aborts the process. The three window functions are plain calls that
//! register no callback.
//!
//! The module also owns the foreground-lock lease thread of the Computer Use
//! bridge host (foreground_lease.rs). That thread reports to JavaScript only
//! through a queued Node-API threadsafe call, never from a window procedure.
//!
//! The library is a Node-API module (mixdog_window.node): Node-API is
//! ABI-stable across Electron versions, and the loader needs no FFI library.
//! The Windows imports (comctl32, user32, kernel32) are raw-dylib, so there are no
//! import libraries and the build needs no Windows SDK.
#![cfg(windows)]

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;

mod foreground_lease;

type Hwnd = isize;
type SubclassProc = unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize;

const WM_ACTIVATE: u32 = 0x0006;
const WM_NCDESTROY: u32 = 0x0082;
const WM_NCACTIVATE: u32 = 0x0086;
const WA_INACTIVE: usize = 0;
const SUBCLASS_ID: usize = 0x4d49_4341; // 'MICA'

#[link(name = "comctl32", kind = "raw-dylib")]
extern "system" {
    fn SetWindowSubclass(hwnd: Hwnd, proc: SubclassProc, id: usize, data: usize) -> i32;
    fn RemoveWindowSubclass(hwnd: Hwnd, proc: SubclassProc, id: usize) -> i32;
    fn DefSubclassProc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
}

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    fn IsIconic(hwnd: Hwnd) -> i32;
    fn IsWindow(hwnd: Hwnd) -> i32;
    fn DefWindowProcW(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
}

/// WM_NCACTIVATE as an activation: the low word says active; the high word
/// (set around minimize and restore) is kept.
fn as_active(wparam: usize) -> usize {
    (wparam & !0xffff) | 1
}

unsafe extern "system" fn keep_active(
    hwnd: Hwnd,
    message: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    match message {
        // A minimized window's activation change goes through unchanged.
        WM_NCACTIVATE if IsIconic(hwnd) == 0 => DefSubclassProc(hwnd, message, as_active(wparam), lparam),
        WM_ACTIVATE if wparam & 0xffff == WA_INACTIVE => {
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            // Handling it may have minimized or destroyed the window.
            if IsWindow(hwnd) != 0 && IsIconic(hwnd) == 0 {
                // -1: the frame state changes without painting the native
                // caption over the custom title bar.
                DefWindowProcW(hwnd, WM_NCACTIVATE, 1, -1);
            }
            result
        }
        // Remove the subclass with the window's last message, then forward it.
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, keep_active, SUBCLASS_ID);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, message, wparam, lparam),
    }
}

/// An HWND from JavaScript: a bigint, as `BrowserWindow.getNativeWindowHandle`
/// yields it (64-bit on both supported architectures).
fn window(hwnd: &BigInt) -> Hwnd {
    hwnd.get_u64().1 as Hwnd
}

/// Subclasses `hwnd`. Must be called on the thread that owns the window.
/// Installing twice replaces the first installation.
#[napi]
pub fn install(hwnd: BigInt) -> bool {
    unsafe { SetWindowSubclass(window(&hwnd), keep_active, SUBCLASS_ID, 0) != 0 }
}

/// Removes the subclass from `hwnd`; false when it is not installed, for
/// example because the window was already destroyed. Owning thread only.
#[napi]
pub fn uninstall(hwnd: BigInt) -> bool {
    unsafe { RemoveWindowSubclass(window(&hwnd), keep_active, SUBCLASS_ID) != 0 }
}

/// Paints the frame and backdrop active; not SetFocus/SetForegroundWindow.
/// -1 as lParam: the frame state changes without painting the native caption
/// over the custom title bar. Owning thread only.
#[napi]
pub fn activate(hwnd: BigInt) {
    unsafe {
        DefWindowProcW(window(&hwnd), WM_NCACTIVATE, 1, -1);
    }
}
