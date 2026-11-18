//! Delivery to one process. The window server's own per-process post reaches
//! apps the public call misses (backgrounded Chromium and Catalyst windows);
//! it is private, so it is looked up at run time and the public call remains
//! the fallback when it is absent.
//!
//! A pointer event posted to an inactive app is still only a "first mouse":
//! AppKit spends it activating the window, which a posted event never does,
//! so the click is lost. Telling the app its window is active and key, the
//! way the window server tells it on a real click, lets the click land while
//! the app stays behind the user's frontmost one.

use super::ffi::{CGEventRef, CGPoint};
use std::ffi::{c_void, CStr};
use std::sync::OnceLock;

pub(crate) type PostToPid = unsafe extern "C" fn(i32, *mut c_void);
type SetWindowLocation = unsafe extern "C" fn(CGEventRef, CGPoint);
pub(crate) type GetProcessForPid = unsafe extern "C" fn(i32, *mut [u32; 2]) -> i32;
pub(crate) type PostEventRecordTo = unsafe extern "C" fn(*const [u32; 2], *const u8) -> i32;

fn lookup(name: &CStr) -> *mut c_void {
    static SKYLIGHT: OnceLock<()> = OnceLock::new();
    SKYLIGHT.get_or_init(|| {
        // SAFETY: loading a system framework by path.
        unsafe {
            libc::dlopen(
                c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
                libc::RTLD_LAZY,
            );
        }
    });
    // SAFETY: resolving one symbol by name.
    unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }
}

/// The private per-process post, resolved (a lookup; the port makes the call).
pub(crate) fn private_post() -> Option<PostToPid> {
    static SYMBOL: OnceLock<Option<PostToPid>> = OnceLock::new();
    *SYMBOL.get_or_init(|| {
        let pointer = lookup(c"SLEventPostToPid");
        // SAFETY: the symbol has this signature.
        (!pointer.is_null())
            .then(|| unsafe { std::mem::transmute::<*mut c_void, PostToPid>(pointer) })
    })
}

/// # Safety
/// `event` must be a live CGEvent.
pub unsafe fn set_window_location(event: CGEventRef, point: CGPoint) {
    static SYMBOL: OnceLock<Option<SetWindowLocation>> = OnceLock::new();
    let set = *SYMBOL.get_or_init(|| {
        let pointer = lookup(c"CGEventSetWindowLocation");
        // SAFETY: the symbol has this signature.
        (!pointer.is_null())
            .then(|| unsafe { std::mem::transmute::<*mut c_void, SetWindowLocation>(pointer) })
    });
    if let Some(set) = set {
        set(event, point);
    }
}

/// Marks `window` active and key inside its own process without raising it or changing the frontmost app, which keeps the
/// keyboard: three event records, each posted by the executor's port on its own admission.
pub fn activate_without_raise(pid: i32, window: u32) {
    crate::port::macos::activate_without_raise(pid, window);
}

/// The symbols an activation record needs, resolved (a lookup; the port makes the calls).
pub(crate) fn activation_symbols() -> Option<(GetProcessForPid, PostEventRecordTo)> {
    static SYMBOLS: OnceLock<Option<(GetProcessForPid, PostEventRecordTo)>> = OnceLock::new();
    *SYMBOLS.get_or_init(|| {
        let (psn, post) = (lookup(c"GetProcessForPID"), lookup(c"SLPSPostEventRecordTo"));
        // SAFETY: both symbols have these signatures.
        (!psn.is_null() && !post.is_null()).then(|| unsafe {
            (
                std::mem::transmute::<*mut c_void, GetProcessForPid>(psn),
                std::mem::transmute::<*mut c_void, PostEventRecordTo>(post),
            )
        })
    })
}
