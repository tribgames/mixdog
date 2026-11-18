//! The macOS executor's port. Every posted event, AX write and action, activation, pasteboard step and `open` of this desktop
//! is a typed operation here, and the code that makes the external call is here: each operation admits one primitive
//! (`generic::Port::admit`), invokes exactly that call, and records its completion. Platform code holds no grant and no closure.
//!
//! A press is one immutable specification ([`MacHold`]) from which the port builds both the posted press event and, later,
//! its release; the press answers an opaque [`MacReceipt`] bound to this port, the scope epoch, the destination and the press.
//! A release consumes one, exactly once: nothing else is ever sent as a release.
//!
//! Boundaries: a posted CGEvent is a local queue submission (the revocation waits for one in progress; its receipt is recorded
//! before its admission ends, so the revocation cleanup sees it). A SkyLight event record, an AX write or action, an
//! activation, a pasteboard step and `open` call into other processes or private code: hand-overs.

use super::generic::{Hold, Port, Slot};
use super::{Boundary, Receipt, Scope};
use crate::platform::macos::ffi::{
    cfstr, kAXErrorCannotComplete, kCGEventSourceUserData, kCGHIDEventTap, AXUIElementPerformAction, AXUIElementRef,
    AXUIElementSetAttributeValue, CGEventPost, CGEventPostToPid, CGEventRef, CGEventSetFlags, CGEventSetIntegerValueField,
};
use crate::platform::macos::input::{self, Route};
use core_foundation::base::{CFRelease, CFType, TCFType};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use std::sync::{Arc, OnceLock};

/// What the macOS port holds: a key, or a button with what its release needs (the release goes where the press went). A
/// specification names the key code or the button; the port derives the press and the release event kinds from it, so no
/// event kind is ever the caller's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MacHold {
    Key { code: u16, pid: i32, flags: u64 },
    Button { button: crate::platform::Button, pid: i32, window: u32, origin: (f64, f64), at: (f64, f64), clicks: u32, flags: u64 },
}

impl Hold for MacHold {
    fn release(&self) -> bool {
        let (event, route, flags) = input::release_event(self);
        post_raw(event, route, flags)
    }

    fn boundary(&self) -> Boundary {
        Boundary::Local
    }
}

/// An accepted press of this port: not cloneable and not constructible outside the port; [`release`] consumes it.
pub(crate) struct MacReceipt(Receipt<MacHold>);

impl MacReceipt {
    /// The press it names (what a caller matches its later release by).
    pub(crate) fn hold(&self) -> &MacHold {
        &self.0.hold
    }
}

static PORT: Slot<MacHold> = Slot::new();
static MARKER: OnceLock<i64> = OnceLock::new();

fn port() -> Result<&'static Arc<Port<MacHold>>, String> {
    PORT.get()
}

pub(crate) fn install(scope: &Scope, marker: i64) {
    let _ = MARKER.set(marker);
    PORT.install(Port::new(scope));
}

/// Whether the executor's scope is closed: a wait reads it to end early; never a fence.
pub(crate) fn revoked() -> bool {
    port().map_or(true, |port| port.revoked())
}

fn free(event: CGEventRef) {
    if !event.is_null() {
        // SAFETY: a +1 event that was never posted.
        unsafe { CFRelease(event as *const _) };
    }
}

/// Raw: stamps, posts and releases one event; false when there was none to post.
fn post_raw(event: CGEventRef, route: Route, flags: u64) -> bool {
    if event.is_null() {
        return false;
    }
    // SAFETY: event is a live +1 CGEvent; it is released exactly once here.
    unsafe {
        CGEventSetIntegerValueField(event, kCGEventSourceUserData, MARKER.get().copied().unwrap_or(0));
        CGEventSetFlags(event, flags);
        match route {
            Route::System => CGEventPost(kCGHIDEventTap, event),
            Route::Process(pid) => match crate::platform::macos::skylight::private_post() {
                Some(post) => post(pid, event),
                None => CGEventPostToPid(pid, event),
            },
        }
        CFRelease(event as *const _);
    }
    true
}

/// One event that holds nothing (motion, a wheel step), built by the caller; a refused one is freed unposted.
pub(crate) fn post(event: CGEventRef, route: Route, flags: u64) -> Result<(), String> {
    let admitted = port().and_then(|port| port.admit(Boundary::Local));
    match admitted {
        Ok(_admitted) => {
            if post_raw(event, route, flags) { Ok(()) } else { Err("input_delivery_failed: the event could not be created".into()) }
        }
        Err(refused) => {
            free(event);
            Err(refused)
        }
    }
}

/// A press of `spec`: the port builds its event (a typed character's press carries `units`), posts it on one admission and
/// records the receipt before that admission ends.
pub(crate) fn press(spec: MacHold, units: Option<&[u16]>) -> Result<MacReceipt, String> {
    let port = port()?;
    let (event, route, flags) = input::press_event(&spec, units);
    let _admitted = match port.admit(Boundary::Local) {
        Ok(admitted) => admitted,
        Err(refused) => {
            free(event);
            return Err(refused);
        }
    };
    if !post_raw(event, route, flags) {
        return Err("input_delivery_failed: the event could not be created".into());
    }
    Ok(MacReceipt(port.record(spec)))
}

/// The release a receipt names (a button at its last accepted point, with the press's own destination), whatever the scope
/// says; nothing when the revocation cleanup already let go of it.
pub(crate) fn release(receipt: MacReceipt) -> Result<(), String> {
    port()?.redeem(&receipt.0)
}

/// An accepted drag moved the point a held button of `pid` is let go at.
pub(crate) fn moved_to(pid: i32, at: (f64, f64)) {
    if let Ok(port) = port() {
        port.update(
            |held| matches!(held, MacHold::Button { pid: owner, .. } if *owner == pid),
            |held| {
                if let MacHold::Button { at: point, .. } = held {
                    *point = at;
                }
            },
        );
    }
}

/// Marks `window` active and key inside `pid` without raising it: three SkyLight event records (the application activated,
/// then the window made key in two steps), each its own hand-over.
pub(crate) fn activate_without_raise(pid: i32, window: u32) {
    let Ok(port) = port() else { return };
    let Some((process_for_pid, post_record)) = crate::platform::macos::skylight::activation_symbols() else { return };
    let mut psn = [0u32; 2];
    // SAFETY: psn is a valid out buffer for a process serial number (a read).
    if unsafe { process_for_pid(pid, &mut psn) } != 0 {
        return;
    }
    let record = |fill: &dyn Fn(&mut [u8; 0xf8])| {
        let mut bytes = [0u8; 0xf8];
        bytes[0x04] = 0xf8;
        bytes[0x3c..0x40].copy_from_slice(&window.to_ne_bytes());
        fill(&mut bytes);
        bytes
    };
    let mut records = vec![record(&|bytes| {
        bytes[0x08] = 0x0d;
        bytes[0x8a] = 0x01;
    })];
    for step in [0x01, 0x02] {
        records.push(record(&|bytes| {
            bytes[0x08] = step;
            bytes[0x3a] = 0x10;
            bytes[0x20..0x30].fill(0xff);
        }));
    }
    for bytes in &records {
        let Ok(_admitted) = port.admit(Boundary::HandOver) else { return };
        // SAFETY: psn names a live process; bytes is a full event record.
        unsafe { post_record(&psn, bytes.as_ptr()) };
    }
}

/// One AX attribute write, handed over (refused once revoked: answered `kAXErrorCannotComplete`).
pub(crate) fn ax_set(element: AXUIElementRef, attribute: &str, value: &CFType) -> i32 {
    let name = cfstr(attribute);
    let Ok(_admitted) = port().and_then(|port| port.admit(Boundary::HandOver)) else { return kAXErrorCannotComplete };
    // SAFETY: element is live; name and value are valid CF objects.
    unsafe { AXUIElementSetAttributeValue(element, name.as_concrete_TypeRef(), value.as_CFTypeRef()) }
}

/// One AX action, handed over, as [`ax_set`].
pub(crate) fn ax_perform(element: AXUIElementRef, action: &str) -> i32 {
    let name = cfstr(action);
    let Ok(_admitted) = port().and_then(|port| port.admit(Boundary::HandOver)) else { return kAXErrorCannotComplete };
    // SAFETY: element is live; name is a CFString.
    unsafe { AXUIElementPerformAction(element, name.as_concrete_TypeRef()) }
}

/// Brings an application forward (NSApplicationActivateIgnoringOtherApps), handed over.
pub(crate) fn activate(pid: i32) -> bool {
    let app = crate::platform::macos::appkit::running_application(pid);
    if app.is_null() {
        return false;
    }
    let Ok(_admitted) = port().and_then(|port| port.admit(Boundary::HandOver)) else { return false };
    // SAFETY: app is a live NSRunningApplication.
    unsafe { msg_send![app, activateWithOptions: 2usize] }
}

/// The general pasteboard cleared, then (for a non-empty `text`) given it: two hand-overs, each admitted. The strings are
/// prepared first; refused between the two, the pasteboard stays cleared.
pub(crate) fn pasteboard_write(text: &str) -> Result<(), String> {
    let port = port()?;
    let kind = NSString::from_str(crate::platform::macos::appkit::PLAIN_TEXT);
    let value = NSString::from_str(text);
    // SAFETY: the shared general pasteboard (a lookup).
    let board: *mut AnyObject = unsafe { msg_send![class!(NSPasteboard), generalPasteboard] };
    {
        let _admitted = port.admit(Boundary::HandOver)?;
        // SAFETY: board is the live general pasteboard.
        let _: isize = unsafe { msg_send![board, clearContents] };
    }
    if !text.is_empty() {
        let _admitted = port.admit(Boundary::HandOver)?;
        // SAFETY: as above; both strings are live.
        let _: bool = unsafe { msg_send![board, setString: &*value, forType: &*kind] };
    }
    Ok(())
}

/// Ends a process (one local signal; the wait for its exit holds nothing).
pub(crate) fn terminate(pid: i64) -> Result<(), String> {
    port()?.terminate(pid)
}

/// `/usr/bin/open` with these arguments, handed over (it hands the request to Launch Services before it exits).
pub(crate) fn open(arguments: &[String]) -> Result<std::io::Result<std::process::Output>, String> {
    let mut command = std::process::Command::new("/usr/bin/open");
    command.args(arguments).stdin(std::process::Stdio::null());
    let _admitted = port()?.admit(Boundary::HandOver)?;
    Ok(command.output())
}
