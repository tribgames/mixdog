//! The AppKit calls this backend needs: the frontmost application,
//! activation, screen geometry, the pasteboard, and running applications.

use super::ffi::{CGPoint, CGRect, CGSize};
use objc2::encode::{Encode, Encoding};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

// SAFETY: these layouts are the C structs whose Objective-C encodings follow.
unsafe impl Encode for CGPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
// SAFETY: as above.
unsafe impl Encode for CGSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
// SAFETY: as above.
unsafe impl Encode for CGRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
}

fn string_of(object: *mut AnyObject) -> String {
    if object.is_null() {
        return String::new();
    }
    // SAFETY: the caller passes an NSString instance.
    unsafe { (*(object as *const NSString)).to_string() }
}

pub fn frontmost_pid() -> i32 {
    // SAFETY: plain AppKit queries on shared singletons.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return 0;
        }
        msg_send![app, processIdentifier]
    }
}

fn running_application(pid: i32) -> *mut AnyObject {
    // SAFETY: returns nil when no such application runs.
    unsafe { msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid] }
}

/// Brings the application forward, ahead of whichever app is active.
pub fn activate(pid: i32) -> bool {
    let app = running_application(pid);
    if app.is_null() {
        return false;
    }
    // NSApplicationActivateIgnoringOtherApps.
    // SAFETY: app is a live NSRunningApplication.
    unsafe { msg_send![app, activateWithOptions: 2usize] }
}

/// The pid of a running application whose bundle lives at `path`.
pub fn running_pid_for_bundle(path: &str) -> Option<(i32, String)> {
    // SAFETY: enumerating NSWorkspace's running applications.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let apps: *mut AnyObject = msg_send![workspace, runningApplications];
        let count: usize = msg_send![apps, count];
        for index in 0..count {
            let app: *mut AnyObject = msg_send![apps, objectAtIndex: index];
            let url: *mut AnyObject = msg_send![app, bundleURL];
            if url.is_null() {
                continue;
            }
            let bundle = string_of(msg_send![url, path]);
            if bundle.trim_end_matches('/') == path.trim_end_matches('/') {
                let pid: i32 = msg_send![app, processIdentifier];
                return Some((pid, string_of(msg_send![app, localizedName])));
            }
        }
    }
    None
}

/// Each screen's frame and visible frame in global top-left coordinates.
pub fn screens() -> Vec<(CGRect, CGRect)> {
    let mut out = Vec::new();
    // SAFETY: NSScreen geometry queries.
    unsafe {
        let list: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if list.is_null() {
            return out;
        }
        let count: usize = msg_send![list, count];
        let mut primary_height = 0.0;
        for index in 0..count {
            let screen: *mut AnyObject = msg_send![list, objectAtIndex: index];
            let frame: CGRect = msg_send![screen, frame];
            let visible: CGRect = msg_send![screen, visibleFrame];
            if index == 0 {
                primary_height = frame.size.height;
            }
            let flip = |rect: CGRect| CGRect {
                origin: CGPoint { x: rect.origin.x, y: primary_height - rect.origin.y - rect.size.height },
                size: rect.size,
            };
            out.push((flip(frame), flip(visible)));
        }
    }
    out
}

const PLAIN_TEXT: &str = "public.utf8-plain-text";

pub fn pasteboard_read() -> String {
    // SAFETY: general pasteboard read.
    unsafe {
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let kind = NSString::from_str(PLAIN_TEXT);
        string_of(msg_send![board, stringForType: &*kind])
    }
}

pub fn pasteboard_write(text: &str) -> bool {
    // SAFETY: general pasteboard write.
    unsafe {
        let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![board, clearContents];
        if text.is_empty() {
            return pasteboard_read().is_empty();
        }
        let kind = NSString::from_str(PLAIN_TEXT);
        let value = NSString::from_str(text);
        let _: bool = msg_send![board, setString: &*value, forType: &*kind];
    }
    pasteboard_read() == text
}
