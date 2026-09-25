//! Window enumeration: CoreGraphics names every window and its stacking;
//! accessibility adds titles, minimized and full-screen state, and focus.

use super::appkit;
use super::ffi::*;
use crate::platform::{WindowInfo, Wid};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;
use std::collections::HashMap;

const kCGWindowListOptionIncludingWindow: u32 = 8;

#[derive(Clone, Debug)]
pub struct CgWindow {
    pub number: u32,
    pub pid: i32,
    pub owner: String,
    pub name: String,
    pub layer: i64,
    pub bounds: CGRect,
    pub onscreen: bool,
    pub alpha: f64,
}

fn read_windows(option: u32, relative: u32) -> Vec<CgWindow> {
    // SAFETY: returns a +1 CFArray of dictionaries, or null.
    let array = unsafe { CGWindowListCopyWindowInfo(option, relative) };
    if array.is_null() {
        return Vec::new();
    }
    // SAFETY: the array came back under the create rule.
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(array) };
    let key = |name: &str| CFString::new(name);
    let (number_key, pid_key, owner_key, name_key, layer_key, bounds_key, onscreen_key, alpha_key) = (
        key("kCGWindowNumber"),
        key("kCGWindowOwnerPID"),
        key("kCGWindowOwnerName"),
        key("kCGWindowName"),
        key("kCGWindowLayer"),
        key("kCGWindowBounds"),
        key("kCGWindowIsOnscreen"),
        key("kCGWindowAlpha"),
    );
    let mut out = Vec::new();
    for item in array.iter() {
        // SAFETY: every entry of this array is a CFDictionary.
        let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(item.as_CFTypeRef() as CFDictionaryRef) };
        let number = dict.find(&number_key).and_then(|value| as_f64(&value)).unwrap_or(0.0) as u32;
        if number == 0 {
            continue;
        }
        let mut bounds = CGRect::default();
        if let Some(value) = dict.find(&bounds_key) {
            // SAFETY: the bounds entry is a CGRect dictionary representation.
            unsafe { CGRectMakeWithDictionaryRepresentation(value.as_CFTypeRef() as CFDictionaryRef, &mut bounds) };
        }
        out.push(CgWindow {
            number,
            pid: dict.find(&pid_key).and_then(|value| as_f64(&value)).unwrap_or(0.0) as i32,
            owner: dict.find(&owner_key).and_then(|value| as_string(&value)).unwrap_or_default(),
            name: dict.find(&name_key).and_then(|value| as_string(&value)).unwrap_or_default(),
            layer: dict.find(&layer_key).and_then(|value| as_f64(&value)).unwrap_or(0.0) as i64,
            bounds,
            onscreen: dict.find(&onscreen_key).and_then(|value| as_bool(&value)).unwrap_or(false),
            alpha: dict.find(&alpha_key).and_then(|value| as_f64(&value)).unwrap_or(1.0),
        });
    }
    out
}

/// On-screen windows, front to back, every layer.
pub fn onscreen() -> Vec<CgWindow> {
    read_windows(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, 0)
}

pub fn all() -> Vec<CgWindow> {
    read_windows(kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, 0)
}

pub fn one(number: Wid) -> Option<CgWindow> {
    if number == 0 || number > u32::MAX as u64 {
        return None;
    }
    read_windows(kCGWindowListOptionIncludingWindow, number as u32).into_iter().find(|window| window.number as u64 == number)
}

/// The accessibility view of one application window.
#[derive(Clone)]
pub struct AxWindow {
    pub element: CFType,
    pub number: u32,
    pub title: String,
    pub subrole: String,
    pub minimized: bool,
    pub fullscreen: bool,
    pub frame: CGRect,
}

fn ax_frame(element: &CFType) -> CGRect {
    let origin = ax_copy(element.as_CFTypeRef(), "AXPosition").ok().and_then(|value| as_point(&value)).unwrap_or_default();
    let size = ax_copy(element.as_CFTypeRef(), "AXSize").ok().and_then(|value| as_size(&value)).unwrap_or_default();
    CGRect { origin, size }
}

pub fn ax_windows(pid: i32, cg: &[CgWindow]) -> Vec<AxWindow> {
    if !trusted() {
        return Vec::new();
    }
    let app = application(pid);
    let Ok(list) = ax_copy(app.as_CFTypeRef(), "AXWindows") else { return Vec::new() };
    let mut out = Vec::new();
    for element in ax_elements(&list) {
        let frame = ax_frame(&element);
        let number = ax_window_number(element.as_CFTypeRef()).or_else(|| {
            cg.iter()
                .find(|window| window.pid == pid && (window.bounds.origin.x - frame.origin.x).abs() < 1.0 && (window.bounds.origin.y - frame.origin.y).abs() < 1.0 && (window.bounds.size.width - frame.size.width).abs() < 1.0 && (window.bounds.size.height - frame.size.height).abs() < 1.0)
                .map(|window| window.number)
        });
        let Some(number) = number else { continue };
        out.push(AxWindow {
            number,
            title: ax_copy(element.as_CFTypeRef(), "AXTitle").ok().and_then(|value| as_string(&value)).unwrap_or_default(),
            subrole: ax_copy(element.as_CFTypeRef(), "AXSubrole").ok().and_then(|value| as_string(&value)).unwrap_or_default(),
            minimized: ax_copy(element.as_CFTypeRef(), "AXMinimized").ok().and_then(|value| as_bool(&value)).unwrap_or(false),
            fullscreen: ax_copy(element.as_CFTypeRef(), "AXFullScreen").ok().and_then(|value| as_bool(&value)).unwrap_or(false),
            frame,
            element,
        });
    }
    out
}

pub fn ax_window(pid: i32, number: Wid) -> Option<AxWindow> {
    let cg = one(number).into_iter().collect::<Vec<_>>();
    ax_windows(pid, &cg).into_iter().find(|window| window.number as u64 == number)
}

/// The focused window of the frontmost application.
pub fn focused_window() -> Wid {
    let pid = appkit::frontmost_pid();
    if pid <= 0 {
        return 0;
    }
    if trusted() {
        let app = application(pid);
        if let Ok(window) = ax_copy(app.as_CFTypeRef(), "AXFocusedWindow") {
            if let Some(number) = ax_window_number(window.as_CFTypeRef()) {
                return number as Wid;
            }
            let frame = ax_frame(&window);
            if let Some(found) = onscreen().into_iter().find(|candidate| candidate.pid == pid && candidate.layer == 0 && candidate.bounds == frame) {
                return found.number as Wid;
            }
        }
    }
    onscreen().into_iter().find(|window| window.pid == pid && window.layer == 0).map_or(0, |window| window.number as Wid)
}

fn fills(rect: &CGRect, area: &CGRect) -> bool {
    (rect.origin.x - area.origin.x).abs() <= 2.0
        && (rect.origin.y - area.origin.y).abs() <= 2.0
        && (rect.size.width - area.size.width).abs() <= 4.0
        && (rect.size.height - area.size.height).abs() <= 4.0
}

pub fn visible_frame_for(rect: &CGRect) -> Option<CGRect> {
    let center = CGPoint { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 };
    let screens = appkit::screens();
    screens
        .iter()
        .find(|(frame, _)| center.x >= frame.origin.x && center.x < frame.origin.x + frame.size.width && center.y >= frame.origin.y && center.y < frame.origin.y + frame.size.height)
        .or(screens.first())
        .map(|(_, visible)| *visible)
}

pub fn to_info(window: &CgWindow, ax: Option<&AxWindow>, focused: Wid) -> WindowInfo {
    let rect = window.bounds;
    let maximized = ax.is_some_and(|ax| ax.fullscreen) || visible_frame_for(&rect).is_some_and(|visible| fills(&rect, &visible));
    let title = if window.name.is_empty() { ax.map(|ax| ax.title.clone()).unwrap_or_default() } else { window.name.clone() };
    let class_name = ax.map(|ax| ax.subrole.clone()).filter(|subrole| !subrole.is_empty()).unwrap_or_else(|| {
        if window.layer == 0 { "AXWindow".into() } else { format!("layer{}", window.layer) }
    });
    let (x, y, width, height) = (rect.origin.x.round() as i32, rect.origin.y.round() as i32, rect.size.width.round() as i32, rect.size.height.round() as i32);
    WindowInfo {
        handle: window.number as Wid,
        title,
        class_name,
        app: window.owner.clone(),
        pid: window.pid as i64,
        parent_pid: crate::platform::parent_pid(window.pid as i64),
        owner: 0,
        focused: window.number as Wid == focused,
        minimized: ax.is_some_and(|ax| ax.minimized),
        maximized,
        x,
        y,
        width,
        height,
        client: (x, y, width, height),
    }
}

/// Ordinary application windows: every on-screen window at the normal layer,
/// then the minimized ones, which only accessibility can name.
pub fn list() -> Vec<WindowInfo> {
    let focused = focused_window();
    let everything = all();
    let mut ax_by_pid: HashMap<i32, Vec<AxWindow>> = HashMap::new();
    let mut ax_for = |pid: i32| -> Vec<AxWindow> { ax_by_pid.entry(pid).or_insert_with(|| ax_windows(pid, &everything)).clone() };
    let mut out = Vec::new();
    for window in onscreen().iter().filter(|window| window.layer == 0 && window.alpha > 0.0 && window.bounds.size.width >= 1.0 && window.bounds.size.height >= 1.0) {
        let ax = ax_for(window.pid);
        out.push(to_info(window, ax.iter().find(|ax| ax.number == window.number), focused));
    }
    for window in everything.iter().filter(|window| window.layer == 0 && !window.onscreen) {
        let ax = ax_for(window.pid);
        if let Some(found) = ax.iter().find(|ax| ax.number == window.number && ax.minimized) {
            out.push(to_info(window, Some(found), focused));
        }
    }
    out
}

pub fn info(handle: Wid) -> Option<WindowInfo> {
    let window = one(handle)?;
    let ax = ax_window(window.pid, handle);
    Some(to_info(&window, ax.as_ref(), focused_window()))
}
