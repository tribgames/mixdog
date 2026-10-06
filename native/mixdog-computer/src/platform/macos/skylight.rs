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

use super::ffi::{CGEventPostToPid, CGEventRef, CGPoint};
use std::ffi::{c_void, CStr};
use std::sync::OnceLock;

type PostToPid = unsafe extern "C" fn(i32, *mut c_void);
type SetWindowLocation = unsafe extern "C" fn(CGEventRef, CGPoint);
type GetProcessForPid = unsafe extern "C" fn(i32, *mut [u32; 2]) -> i32;
type PostEventRecordTo = unsafe extern "C" fn(*const [u32; 2], *const u8) -> i32;

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

fn private_post() -> Option<PostToPid> {
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

/// Marks `window` active and key inside its own process without raising it
/// or changing the frontmost app, which keeps the keyboard.
pub fn activate_without_raise(pid: i32, window: u32) {
    static SYMBOLS: OnceLock<Option<(GetProcessForPid, PostEventRecordTo)>> = OnceLock::new();
    let symbols = *SYMBOLS.get_or_init(|| {
        let (psn, post) = (
            lookup(c"GetProcessForPID"),
            lookup(c"SLPSPostEventRecordTo"),
        );
        // SAFETY: both symbols have these signatures.
        (!psn.is_null() && !post.is_null()).then(|| unsafe {
            (
                std::mem::transmute::<*mut c_void, GetProcessForPid>(psn),
                std::mem::transmute::<*mut c_void, PostEventRecordTo>(post),
            )
        })
    });
    let Some((process_for_pid, post_record)) = symbols else {
        return;
    };
    let mut psn = [0u32; 2];
    // SAFETY: psn is a valid out buffer for a process serial number.
    if unsafe { process_for_pid(pid, &mut psn) } != 0 {
        return;
    }
    let record = |fill: &dyn Fn(&mut [u8; 0xf8])| {
        let mut bytes = [0u8; 0xf8];
        bytes[0x04] = 0xf8;
        bytes[0x3c..0x40].copy_from_slice(&window.to_ne_bytes());
        fill(&mut bytes);
        // SAFETY: psn names a live process; bytes is a full event record.
        unsafe { post_record(&psn, bytes.as_ptr()) };
    };
    // Application activated, then the window made key in two steps.
    record(&|bytes| {
        bytes[0x08] = 0x0d;
        bytes[0x8a] = 0x01;
    });
    for step in [0x01, 0x02] {
        record(&|bytes| {
            bytes[0x08] = step;
            bytes[0x3a] = 0x10;
            bytes[0x20..0x30].fill(0xff);
        });
    }
}

/// # Safety
/// `event` must be a live CGEvent.
pub unsafe fn post_to_pid(pid: i32, event: CGEventRef) {
    match private_post() {
        Some(post) => post(pid, event),
        None => CGEventPostToPid(pid, event),
    }
}
