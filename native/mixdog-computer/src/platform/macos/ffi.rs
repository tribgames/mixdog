//! Raw bindings to CoreGraphics, HIServices accessibility and CoreFoundation
//! run loops, plus small typed readers over them.

#![allow(non_upper_case_globals, non_snake_case, dead_code)]

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionaryRef;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use std::ffi::c_void;

pub type CGEventRef = *mut c_void;
pub type CGEventSourceRef = *mut c_void;
pub type AXUIElementRef = CFTypeRef;
pub type CFMachPortRef = *mut c_void;
pub type CFRunLoopRef = *mut c_void;
pub type CFRunLoopSourceRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

// Event types.
pub const kCGEventLeftMouseDown: u32 = 1;
pub const kCGEventLeftMouseUp: u32 = 2;
pub const kCGEventRightMouseDown: u32 = 3;
pub const kCGEventRightMouseUp: u32 = 4;
pub const kCGEventMouseMoved: u32 = 5;
pub const kCGEventLeftMouseDragged: u32 = 6;
pub const kCGEventRightMouseDragged: u32 = 7;
pub const kCGEventKeyDown: u32 = 10;
pub const kCGEventKeyUp: u32 = 11;
pub const kCGEventFlagsChanged: u32 = 12;
pub const kCGEventScrollWheel: u32 = 22;
pub const kCGEventOtherMouseDown: u32 = 25;
pub const kCGEventOtherMouseUp: u32 = 26;
pub const kCGEventOtherMouseDragged: u32 = 27;
pub const kCGEventTapDisabledByTimeout: u32 = 0xFFFF_FFFE;
pub const kCGEventTapDisabledByUserInput: u32 = 0xFFFF_FFFF;

pub const kCGMouseButtonLeft: u32 = 0;
pub const kCGMouseButtonRight: u32 = 1;
pub const kCGMouseButtonCenter: u32 = 2;

pub const kCGHIDEventTap: u32 = 0;
pub const kCGSessionEventTap: u32 = 1;
pub const kCGHeadInsertEventTap: u32 = 0;
pub const kCGEventTapOptionListenOnly: u32 = 1;

pub const kCGMouseEventClickState: u32 = 1;
pub const kCGKeyboardEventKeycode: u32 = 9;
pub const kCGEventSourceUserData: u32 = 42;
pub const kCGMouseEventWindowUnderMousePointer: u32 = 91;
pub const kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent: u32 = 92;

pub const kCGEventSourceStateCombinedSessionState: i32 = 0;
pub const kCGEventSourceStateHIDSystemState: i32 = 1;
pub const kCGAnyInputEventType: u32 = 0xFFFF_FFFF;

pub const kCGScrollEventUnitLine: u32 = 1;

pub const kCGEventFlagMaskShift: u64 = 0x0002_0000;
pub const kCGEventFlagMaskControl: u64 = 0x0004_0000;
pub const kCGEventFlagMaskAlternate: u64 = 0x0008_0000;
pub const kCGEventFlagMaskCommand: u64 = 0x0010_0000;

pub const kCGWindowListOptionAll: u32 = 0;
pub const kCGWindowListOptionOnScreenOnly: u32 = 1;
pub const kCGWindowListExcludeDesktopElements: u32 = 16;

pub const kAXErrorSuccess: i32 = 0;
pub const kAXErrorInvalidUIElement: i32 = -25202;
pub const kAXErrorCannotComplete: i32 = -25204;
pub const kAXErrorAPIDisabled: i32 = -25211;
pub const kAXValueCGPointType: u32 = 1;
pub const kAXValueCGSizeType: u32 = 2;
pub const kAXValueAXErrorType: u32 = 5;

pub type CGEventTapCallBack = extern "C" fn(proxy: *mut c_void, kind: u32, event: CGEventRef, user_info: *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
    pub fn CGEventCreateMouseEvent(source: CGEventSourceRef, kind: u32, position: CGPoint, button: u32) -> CGEventRef;
    pub fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, keycode: u16, down: bool) -> CGEventRef;
    pub fn CGEventCreateScrollWheelEvent2(source: CGEventSourceRef, units: u32, count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> CGEventRef;
    pub fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: std::os::raw::c_ulong, text: *const u16);
    pub fn CGEventSetFlags(event: CGEventRef, flags: u64);
    pub fn CGEventGetFlags(event: CGEventRef) -> u64;
    pub fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    pub fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    pub fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    pub fn CGEventSetLocation(event: CGEventRef, location: CGPoint);
    pub fn CGEventPost(tap: u32, event: CGEventRef);
    pub fn CGEventPostToPid(pid: i32, event: CGEventRef);
    pub fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    pub fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    pub fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    pub fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
    pub fn CGWarpMouseCursorPosition(point: CGPoint) -> i32;
    pub fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
    pub fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    pub fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> bool;
    pub fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: CGEventTapCallBack, user_info: *mut c_void) -> CFMachPortRef;
    pub fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXIsProcessTrusted() -> bool;
    pub fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    pub fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    pub fn AXUIElementCopyMultipleAttributeValues(element: AXUIElementRef, attributes: CFArrayRef, options: u32, values: *mut CFArrayRef) -> i32;
    pub fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> i32;
    pub fn AXUIElementIsAttributeSettable(element: AXUIElementRef, attribute: CFStringRef, settable: *mut u8) -> i32;
    pub fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> i32;
    pub fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> i32;
    pub fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    pub fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
    pub fn AXValueGetType(value: CFTypeRef) -> u32;
    pub fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    pub fn AXValueCreate(kind: u32, value: *const c_void) -> CFTypeRef;
    pub static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: CFMachPortRef, order: isize) -> CFRunLoopSourceRef;
    pub fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    pub fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    pub fn CFRunLoopRun();
    pub static kCFRunLoopCommonModes: CFStringRef;
}

/// A private HIServices call that names the CGWindowID behind an AX window;
/// resolved at run time so a system without it falls back to geometry.
pub fn ax_window_number(element: AXUIElementRef) -> Option<u32> {
    type GetWindow = unsafe extern "C" fn(AXUIElementRef, *mut u32) -> i32;
    static SYMBOL: std::sync::OnceLock<Option<GetWindow>> = std::sync::OnceLock::new();
    let function = SYMBOL.get_or_init(|| {
        // SAFETY: dlsym with RTLD_DEFAULT looks up an exported symbol by name.
        let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
        // SAFETY: the symbol, when present, has exactly this C signature.
        (!pointer.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, GetWindow>(pointer) })
    });
    let function = (*function)?;
    let mut number = 0u32;
    // SAFETY: element is a live AXUIElement; number is a valid out pointer.
    let status = unsafe { function(element, &mut number) };
    (status == kAXErrorSuccess && number != 0).then_some(number)
}

pub fn cfstr(value: &str) -> CFString {
    CFString::new(value)
}

/// One AX attribute as an owned CF object.
pub fn ax_copy(element: AXUIElementRef, attribute: &str) -> Result<CFType, i32> {
    let name = cfstr(attribute);
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: element is a live AXUIElement, name a CFString, value an out pointer.
    let status = unsafe { AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value) };
    if status != kAXErrorSuccess || value.is_null() {
        return Err(status);
    }
    // SAFETY: a successful copy returns a +1 reference we now own.
    Ok(unsafe { CFType::wrap_under_create_rule(value) })
}

pub fn as_string(value: &CFType) -> Option<String> {
    value.downcast::<CFString>().map(|text| text.to_string())
}

pub fn as_bool(value: &CFType) -> Option<bool> {
    if let Some(flag) = value.downcast::<CFBoolean>() {
        return Some(flag.into());
    }
    value.downcast::<CFNumber>().and_then(|number| number.to_i64()).map(|number| number != 0)
}

pub fn as_f64(value: &CFType) -> Option<f64> {
    if let Some(number) = value.downcast::<CFNumber>() {
        return number.to_f64().or_else(|| number.to_i64().map(|value| value as f64));
    }
    value.downcast::<CFBoolean>().map(|flag| if bool::from(flag) { 1.0 } else { 0.0 })
}

fn ax_value<T: Default>(value: &CFType, kind: u32) -> Option<T> {
    let mut out = T::default();
    // SAFETY: AXValueGetValue writes a value of `kind`, which T matches, into out.
    let ok = unsafe { AXValueGetType(value.as_CFTypeRef()) == kind && AXValueGetValue(value.as_CFTypeRef(), kind, &mut out as *mut T as *mut c_void) };
    ok.then_some(out)
}

pub fn as_point(value: &CFType) -> Option<CGPoint> {
    ax_value(value, kAXValueCGPointType)
}

pub fn as_size(value: &CFType) -> Option<CGSize> {
    ax_value(value, kAXValueCGSizeType)
}

pub fn is_ax_error(value: &CFType) -> bool {
    // SAFETY: AXValueGetType only reads the type tag of an AXValue.
    unsafe { core_foundation::base::CFGetTypeID(value.as_CFTypeRef()) == ax_value_type_id() && AXValueGetType(value.as_CFTypeRef()) == kAXValueAXErrorType }
}

fn ax_value_type_id() -> usize {
    extern "C" {
        fn AXValueGetTypeID() -> usize;
    }
    // SAFETY: returns a constant type id.
    unsafe { AXValueGetTypeID() }
}

pub fn ax_ui_element_type_id() -> usize {
    extern "C" {
        fn AXUIElementGetTypeID() -> usize;
    }
    // SAFETY: returns a constant type id.
    unsafe { AXUIElementGetTypeID() }
}

pub fn ax_elements(value: &CFType) -> Vec<CFType> {
    if !value.instance_of::<CFArray>() {
        return Vec::new();
    }
    // SAFETY: the value is a CFArray; its items are CF objects.
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_get_rule(value.as_CFTypeRef() as CFArrayRef) };
    array
        .iter()
        .filter(|item| item.type_of() == ax_ui_element_type_id())
        .map(|item| item.clone())
        .collect()
}

pub fn ax_set(element: AXUIElementRef, attribute: &str, value: &CFType) -> i32 {
    let name = cfstr(attribute);
    // SAFETY: element is live; name and value are valid CF objects.
    unsafe { AXUIElementSetAttributeValue(element, name.as_concrete_TypeRef(), value.as_CFTypeRef()) }
}

pub fn ax_settable(element: AXUIElementRef, attribute: &str) -> bool {
    let name = cfstr(attribute);
    let mut settable = 0u8;
    // SAFETY: element is live; settable is a valid out pointer.
    let status = unsafe { AXUIElementIsAttributeSettable(element, name.as_concrete_TypeRef(), &mut settable) };
    status == kAXErrorSuccess && settable != 0
}

pub fn ax_perform(element: AXUIElementRef, action: &str) -> i32 {
    let name = cfstr(action);
    // SAFETY: element is live; name is a CFString.
    unsafe { AXUIElementPerformAction(element, name.as_concrete_TypeRef()) }
}

pub fn ax_actions(element: AXUIElementRef) -> Vec<String> {
    let mut names: CFArrayRef = std::ptr::null();
    // SAFETY: element is live; names receives a +1 array on success.
    let status = unsafe { AXUIElementCopyActionNames(element, &mut names) };
    if status != kAXErrorSuccess || names.is_null() {
        return Vec::new();
    }
    // SAFETY: the array was returned under the create rule.
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(names) };
    array.iter().filter_map(|item| as_string(&item)).collect()
}

/// Several attributes in one round trip; a missing one reads as `None`.
pub fn ax_copy_many(element: AXUIElementRef, attributes: &CFArray<CFString>) -> Option<Vec<Option<CFType>>> {
    let mut values: CFArrayRef = std::ptr::null();
    // SAFETY: element is live; attributes is a CFArray of CFStrings.
    let status = unsafe { AXUIElementCopyMultipleAttributeValues(element, attributes.as_concrete_TypeRef(), 0, &mut values) };
    if status != kAXErrorSuccess || values.is_null() {
        return None;
    }
    // SAFETY: returned under the create rule.
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(values) };
    Some(array.iter().map(|item| (!is_ax_error(&item)).then(|| item.clone())).collect())
}

pub fn ax_pid(element: AXUIElementRef) -> i32 {
    let mut pid = 0;
    // SAFETY: element is live; pid is a valid out pointer.
    unsafe { AXUIElementGetPid(element, &mut pid) };
    pid
}

pub fn application(pid: i32) -> CFType {
    // SAFETY: returns a +1 AXUIElement for the pid.
    let element = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) };
    // SAFETY: a bounded timeout keeps a hung application from stalling the host.
    unsafe { AXUIElementSetMessagingTimeout(element.as_CFTypeRef(), 1.5) };
    element
}

pub fn ax_point_value(point: CGPoint) -> CFType {
    // SAFETY: AXValueCreate copies the point and returns a +1 AXValue.
    unsafe { CFType::wrap_under_create_rule(AXValueCreate(kAXValueCGPointType, &point as *const CGPoint as *const c_void)) }
}

pub fn ax_size_value(size: CGSize) -> CFType {
    // SAFETY: AXValueCreate copies the size and returns a +1 AXValue.
    unsafe { CFType::wrap_under_create_rule(AXValueCreate(kAXValueCGSizeType, &size as *const CGSize as *const c_void)) }
}

pub fn cf_bool(value: bool) -> CFType {
    if value {
        CFBoolean::true_value().as_CFType()
    } else {
        CFBoolean::false_value().as_CFType()
    }
}

pub fn trusted() -> bool {
    // SAFETY: a plain query of this process's accessibility trust.
    unsafe { AXIsProcessTrusted() }
}

/// Asks the system to show its accessibility prompt for this app, once.
pub fn prompt_trust() {
    static ASKED: std::sync::Once = std::sync::Once::new();
    ASKED.call_once(|| {
        // SAFETY: kAXTrustedCheckOptionPrompt is an exported CFString constant.
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = core_foundation::dictionary::CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        // SAFETY: options is a valid dictionary for the duration of the call.
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
    });
}
