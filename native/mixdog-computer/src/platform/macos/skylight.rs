//! Delivery to one process. The window server's own per-process post reaches
//! apps the public call misses (backgrounded Chromium and Catalyst windows);
//! it is private, so it is looked up at run time and the public call remains
//! the fallback when it is absent.

use super::ffi::{CGEventPostToPid, CGEventRef};
use std::ffi::c_void;
use std::sync::OnceLock;

type PostToPid = unsafe extern "C" fn(i32, *mut c_void);

fn private_post() -> Option<PostToPid> {
    static SYMBOL: OnceLock<Option<PostToPid>> = OnceLock::new();
    *SYMBOL.get_or_init(|| {
        // SAFETY: loading a system framework by path and resolving one symbol.
        unsafe {
            libc::dlopen(c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(), libc::RTLD_LAZY);
            let pointer = libc::dlsym(libc::RTLD_DEFAULT, c"SLEventPostToPid".as_ptr());
            (!pointer.is_null()).then(|| std::mem::transmute::<*mut c_void, PostToPid>(pointer))
        }
    })
}

/// # Safety
/// `event` must be a live CGEvent.
pub unsafe fn post_to_pid(pid: i32, event: CGEventRef) {
    match private_post() {
        Some(post) => post(pid, event),
        None => CGEventPostToPid(pid, event),
    }
}
