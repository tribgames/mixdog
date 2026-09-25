//! Input observation. A listen-only event tap sees every mouse and keyboard
//! event and reads the marker this process stamps on its own; without the
//! tap, the system's last-input clock is watched and attributed by time.

use super::ffi::*;
use crate::observer::{now_ms, Shared};
use std::ffi::c_void;
use std::sync::Arc;

struct TapContext {
    shared: Arc<Shared>,
    marker: i64,
    tap: std::sync::atomic::AtomicPtr<c_void>,
}

extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: CGEventRef, user_info: *mut c_void) -> CGEventRef {
    // SAFETY: user_info is the leaked TapContext this tap was created with.
    let context = unsafe { &*(user_info as *const TapContext) };
    if kind == kCGEventTapDisabledByTimeout || kind == kCGEventTapDisabledByUserInput {
        let tap = context.tap.load(std::sync::atomic::Ordering::SeqCst);
        if !tap.is_null() {
            // SAFETY: tap is the live mach port this callback belongs to.
            unsafe { CGEventTapEnable(tap, true) };
        }
        return event;
    }
    // SAFETY: event is the live event being observed.
    let origin = unsafe { CGEventGetIntegerValueField(event, kCGEventSourceUserData) };
    context.shared.record(origin == context.marker);
    event
}

fn mask() -> u64 {
    [
        kCGEventLeftMouseDown,
        kCGEventLeftMouseUp,
        kCGEventRightMouseDown,
        kCGEventRightMouseUp,
        kCGEventMouseMoved,
        kCGEventLeftMouseDragged,
        kCGEventRightMouseDragged,
        kCGEventKeyDown,
        kCGEventKeyUp,
        kCGEventFlagsChanged,
        kCGEventScrollWheel,
        kCGEventOtherMouseDown,
        kCGEventOtherMouseUp,
        kCGEventOtherMouseDragged,
    ]
    .iter()
    .fold(0u64, |mask, kind| mask | (1u64 << kind))
}

pub fn start(shared: Arc<Shared>, marker: i64) {
    std::thread::Builder::new()
        .name("mixdog input observation".into())
        .spawn(move || {
            let context = Box::into_raw(Box::new(TapContext { shared: shared.clone(), marker, tap: Default::default() }));
            // SAFETY: the callback and its leaked context live for the process.
            let tap = unsafe {
                CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask(), on_event, context as *mut c_void)
            };
            if tap.is_null() {
                poll_idle(shared);
                return;
            }
            // SAFETY: context outlives the tap; the run loop owns the source.
            unsafe {
                (*context).tap.store(tap, std::sync::atomic::Ordering::SeqCst);
                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
            }
            shared.set_ready(true);
            // SAFETY: runs this thread's run loop for the life of the process.
            unsafe { CFRunLoopRun() };
            shared.set_ready(false);
        })
        .ok();
}

/// Without a tap: every advance of the HID last-input clock is an input event,
/// this process's own when it falls inside the window it marked.
fn poll_idle(shared: Arc<Shared>) {
    let mut last_seen = 0u64;
    shared.set_ready(true);
    loop {
        // SAFETY: plain HID idle query.
        let idle = unsafe { CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType) };
        let now = now_ms();
        let at = now.saturating_sub((idle.max(0.0) * 1000.0) as u64);
        if at > last_seen + 5 {
            if last_seen != 0 {
                shared.record_untagged(at);
            }
            last_seen = at;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}
