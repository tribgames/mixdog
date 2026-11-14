//! A live UI Automation element: the semantic actions on it, and the current
//! reads a ref is checked against.

use super::super::background::{hold_inactive, release_inactive};
use super::super::{msaa, native};
use super::{role_of, text};
use crate::a11y::{format_value, Element};
use crate::obj;
use crate::platform::Wid;
use crate::protocol::Obj;
use serde_json::json;
use windows::core::{BSTR, Interface};
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData};
use windows::Win32::UI::Accessibility::*;

#[allow(non_upper_case_globals)]
pub(super) fn toggle_label(state: ToggleState) -> &'static str {
    match state {
        ToggleState_On => "On",
        ToggleState_Indeterminate => "Indeterminate",
        _ => "Off",
    }
}

#[allow(non_upper_case_globals)]
pub(super) fn expand_label(state: ExpandCollapseState) -> &'static str {
    match state {
        ExpandCollapseState_Expanded => "Expanded",
        ExpandCollapseState_PartiallyExpanded => "PartiallyExpanded",
        ExpandCollapseState_LeafNode => "LeafNode",
        _ => "Collapsed",
    }
}

pub(in crate::platform::windows) fn runtime_key(element: &IUIAutomationElement) -> String {
    // SAFETY: the safe array is read under its lock and destroyed by its owner.
    unsafe {
        let Ok(array) = element.GetRuntimeId() else {
            return String::new();
        };
        let (Ok(lower), Ok(upper)) = (SafeArrayGetLBound(array, 1), SafeArrayGetUBound(array, 1)) else {
            return String::new();
        };
        let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
        if SafeArrayAccessData(array, &mut data).is_err() {
            return String::new();
        }
        let ids = std::slice::from_raw_parts(data as *const i32, (upper - lower + 1).max(0) as usize);
        let key = ids.iter().map(i32::to_string).collect::<Vec<_>>().join(",");
        let _ = SafeArrayUnaccessData(array);
        windows::Win32::System::Ole::SafeArrayDestroy(array).ok();
        key
    }
}

/// The native window that draws the element, 0 when it has none; `None`
/// when the read failed.
fn native_handle_read(element: &IUIAutomationElement) -> Option<Wid> {
    // SAFETY: a plain property read.
    unsafe { element.CurrentNativeWindowHandle() }
        .ok()
        .map(|handle| handle.0 as usize as Wid)
}

pub(in crate::platform::windows) fn native_handle(element: &IUIAutomationElement) -> Wid {
    native_handle_read(element).unwrap_or(0)
}

/// Whether the element hides what is typed into it, read live
/// (Test-FocusMasked, Test-RecordMasked).
pub(super) fn masked(element: &IUIAutomationElement) -> bool {
    // SAFETY: a plain property read.
    let password = unsafe { element.CurrentIsPassword() }.ok().map(|flag| flag.as_bool());
    super::masked(password, || native_handle_read(element), msaa::is_protected_input)
}

/// The top-level window an element lives in (Get-TopWindow): up the control
/// view to the first element whose native window is its own GA_ROOT, else
/// the window of the last element reached.
pub(super) fn top_window(automation: &IUIAutomation, element: &IUIAutomationElement) -> Wid {
    // SAFETY: plain tree-walker reads.
    let walker = unsafe { automation.ControlViewWalker() }.ok();
    let mut current = element.clone();
    for _ in 0..50 {
        let handle = native_handle(&current);
        if handle != 0 && native::root_of(handle) == handle {
            return handle;
        }
        match walker.as_ref().and_then(|walker| unsafe { walker.GetParentElement(&current) }.ok()) {
            Some(parent) => current = parent,
            None => return handle,
        }
    }
    native_handle(&current)
}

pub struct UiaElement {
    pub(super) automation: IUIAutomation,
    pub(super) element: IUIAutomationElement,
    pub(super) window: Wid,
}

impl UiaElement {
    fn pattern<T: Interface>(&self, id: UIA_PATTERN_ID) -> Option<T> {
        // SAFETY: a plain pattern query on a live element.
        unsafe { self.element.GetCurrentPatternAs::<T>(id) }.ok()
    }

    /// Runs one semantic action with the window held non-activatable: XAML and
    /// Chromium hosts raise themselves while handling an accessibility call.
    /// Inside the activation guard the root is already held, so this hold only
    /// counts against it and the guard's release is the one that clears the bit.
    pub(super) fn held<T>(&self, action: impl FnOnce() -> windows::core::Result<T>) -> Result<T, String> {
        let held = hold_inactive(self.window);
        let outcome = action().map_err(|error| error.message());
        let released = release_inactive(held);
        let value = outcome?;
        released?;
        Ok(value)
    }
}

impl Element for UiaElement {
    fn identity(&self) -> String {
        runtime_key(&self.element)
    }
    fn window(&self) -> Wid {
        self.window
    }
    fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        // SAFETY: a plain property read.
        let rect = unsafe { self.element.CurrentBoundingRectangle() }.ok()?;
        Some((
            rect.left as f64,
            rect.top as f64,
            (rect.right - rect.left) as f64,
            (rect.bottom - rect.top) as f64,
        ))
    }
    fn enabled(&self) -> bool {
        unsafe { self.element.CurrentIsEnabled() }.is_ok_and(|flag| flag.as_bool())
    }
    fn alive(&self) -> bool {
        unsafe { self.element.CurrentProcessId() }.is_ok()
    }
    fn press(&self) -> Result<(), String> {
        if let Some(toggle) = self.pattern::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            return self.held(|| unsafe { toggle.Toggle() });
        }
        if let Some(invoke) = self.pattern::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            return self.held(|| unsafe { invoke.Invoke() });
        }
        Err("element exposes no invoke action".into())
    }
    fn can_press(&self) -> bool {
        self.pattern::<IUIAutomationInvokePattern>(UIA_InvokePatternId).is_some()
    }
    fn toggle_state(&self) -> Option<String> {
        let toggle = self.pattern::<IUIAutomationTogglePattern>(UIA_TogglePatternId)?;
        unsafe { toggle.CurrentToggleState() }
            .ok()
            .map(|state| toggle_label(state).to_string())
    }
    fn expand_state(&self) -> Option<String> {
        let pattern = self.pattern::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)?;
        unsafe { pattern.CurrentExpandCollapseState() }
            .ok()
            .map(|state| expand_label(state).to_string())
    }
    fn set_expanded(&self, expanded: bool) -> Result<(), String> {
        let pattern = self
            .pattern::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
            .ok_or("element cannot expand or collapse")?;
        self.held(|| unsafe {
            if expanded {
                pattern.Expand()
            } else {
                pattern.Collapse()
            }
        })
    }
    fn value(&self) -> Option<String> {
        let pattern = self.pattern::<IUIAutomationValuePattern>(UIA_ValuePatternId)?;
        unsafe { pattern.CurrentValue() }.ok().map(|value| value.to_string())
    }
    fn settable(&self) -> bool {
        self.pattern::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_some_and(|pattern| {
                unsafe { pattern.CurrentIsReadOnly() }.is_ok_and(|flag| !flag.as_bool())
            })
            && !self.ignores_value_write()
    }
    fn read_only(&self) -> bool {
        self.pattern::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_some_and(|pattern| unsafe { pattern.CurrentIsReadOnly() }.is_ok_and(|flag| flag.as_bool()))
    }
    fn ignores_value_write(&self) -> bool {
        // An Excel cell echoes a value write it never enters.
        text(unsafe { self.element.CurrentClassName() }) == "XLSpreadsheetCell"
    }
    fn set_value(&self, value: &str) -> Result<(), String> {
        let pattern = self
            .pattern::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok_or("element exposes no value")?;
        let value = BSTR::from(value);
        self.held(|| unsafe { pattern.SetValue(&value) })
    }
    fn can_select(&self) -> bool {
        self.pattern::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .is_some()
    }
    fn select(&self) -> Result<(), String> {
        let pattern = self
            .pattern::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .ok_or("element is not selectable")?;
        self.held(|| unsafe { pattern.Select() })
    }
    fn scroll(&self, horizontal: bool, increments: i32) -> Result<Option<(String, String)>, String> {
        let Some(pattern) = self.pattern::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) else {
            return Ok(None);
        };
        let scrollable = unsafe {
            if horizontal {
                pattern.CurrentHorizontallyScrollable()
            } else {
                pattern.CurrentVerticallyScrollable()
            }
        }
        .is_ok_and(|flag| flag.as_bool());
        if !scrollable {
            return Ok(None);
        }
        let read = || unsafe {
            if horizontal {
                pattern.CurrentHorizontalScrollPercent()
            } else {
                pattern.CurrentVerticalScrollPercent()
            }
        }
        .unwrap_or(0.0);
        let before = read();
        let amount = if increments < 0 {
            ScrollAmount_SmallDecrement
        } else {
            ScrollAmount_SmallIncrement
        };
        for _ in 0..increments.unsigned_abs() {
            let none = ScrollAmount_NoAmount;
            self.held(|| unsafe {
                if horizontal {
                    pattern.Scroll(amount, none)
                } else {
                    pattern.Scroll(none, amount)
                }
            })?;
        }
        let after = read();
        Ok(Some((format!("{before:.3}"), format!("{after:.3}"))))
    }
    fn structure(&self) -> Obj {
        // SAFETY: plain tree-walker reads on live elements.
        unsafe {
            let walker = self.automation.ControlViewWalker().ok();
            let desktop = self.automation.GetRootElement().ok();
            let mut ancestors = Vec::new();
            let mut parent_id = String::new();
            let mut in_document = false;
            let mut current = walker.as_ref().and_then(|walker| walker.GetParentElement(&self.element).ok());
            for depth in 0..80 {
                let Some(parent) = current else { break };
                if desktop
                    .as_ref()
                    .is_some_and(|desktop| self.automation.CompareElements(&parent, desktop).is_ok_and(|same| same.as_bool()))
                {
                    break;
                }
                let id = runtime_key(&parent);
                let role = role_of(parent.CurrentControlType().map(|kind| kind.0).unwrap_or(0));
                if depth == 0 {
                    parent_id = id.clone();
                }
                if role == "Document" {
                    in_document = true;
                }
                ancestors.push(json!({
                    "runtime_id": id,
                    "role": role,
                    "name": format_value(&text(parent.CurrentName()), 200),
                }));
                current = walker.as_ref().and_then(|walker| walker.GetParentElement(&parent).ok());
            }
            obj! {
                "runtime_id" => self.identity(),
                "parent_runtime_id" => parent_id,
                "class_name" => text(self.element.CurrentClassName()),
                "has_keyboard_focus" => self.element.CurrentHasKeyboardFocus().is_ok_and(|flag| flag.as_bool()),
                "in_document" => in_document,
                "ancestors" => ancestors,
            }
        }
    }
    fn range_value(&self) -> Option<String> {
        let pattern = self.pattern::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)?;
        unsafe { pattern.CurrentValue() }.ok().map(|value| value.to_string())
    }
    fn source(&self) -> &'static str {
        "uia"
    }
    fn masked(&self) -> bool {
        masked(&self.element)
    }
    fn native_handle(&self) -> Wid {
        native_handle(&self.element)
    }
    fn control_type(&self) -> String {
        // SAFETY: a plain property read.
        unsafe { self.element.CurrentControlType() }
            .map(|kind| role_of(kind.0).to_string())
            .unwrap_or_default()
    }
    fn name(&self) -> String {
        text(unsafe { self.element.CurrentName() })
    }
    fn automation_id(&self) -> String {
        text(unsafe { self.element.CurrentAutomationId() })
    }
    fn top_window(&self) -> Wid {
        top_window(&self.automation, &self.element)
    }
    fn selected(&self) -> Option<bool> {
        let pattern = self.pattern::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)?;
        unsafe { pattern.CurrentIsSelected() }.ok().map(|flag| flag.as_bool())
    }
    fn scroll_percent(&self) -> Option<(f64, f64)> {
        let pattern = self.pattern::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)?;
        // SAFETY: plain property reads.
        unsafe {
            Some((
                pattern.CurrentHorizontalScrollPercent().ok()?,
                pattern.CurrentVerticalScrollPercent().ok()?,
            ))
        }
    }
    fn offscreen(&self) -> bool {
        // SAFETY: a plain property read; an unreadable element counts as off screen.
        unsafe { self.element.CurrentIsOffscreen() }.map_or(true, |flag| flag.as_bool())
    }
    fn exclusive_selection(&self) -> Result<(), String> {
        super::selection::exclusive(self)
    }
}
