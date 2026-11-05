//! The accessibility tree through UI Automation: one bounded cached read per
//! snapshot, the semantic actions on its elements, and menu paths.

use super::background::{hold_inactive, release_inactive, WinBackground};
use super::native::{self, hwnd};
use crate::a11y::{format_value, normalize_menu_label, Accessibility, Element, MenuOutcome, Node};
use crate::obj;
use crate::observer::Shared;
use crate::platform::{Background, Wid, WindowInfo};
use crate::protocol::Obj;
use serde_json::json;
use std::rc::Rc;
use std::sync::Arc;
use windows::core::{BSTR, Interface};
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData};
use windows::Win32::System::Variant::{VARIANT, VT_EMPTY, VT_UNKNOWN};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenu, GetMenuItemCount, GetMenuItemInfoW, GetMenuStringW, PostMessageW, HMENU, MENUITEMINFOW,
    MF_BYPOSITION, MFS_DISABLED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_SUBMENU,
    WM_COMMAND, WM_INITMENUPOPUP,
};

const CHROMIUM_PREFIX: &str = "Chrome_WidgetWin";

fn role_of(control_type: i32) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Custom",
    }
}

fn control_type_id(role: &str) -> i32 {
    (50000..=50040)
        .find(|id| role_of(*id) == role)
        .unwrap_or(50025)
}

fn text(value: windows::core::Result<BSTR>) -> String {
    value.map(|text| text.to_string()).unwrap_or_default()
}

fn cached_flag(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> bool {
    // SAFETY: a read of a property the cache request carries.
    unsafe { element.GetCachedPropertyValue(id) }
        .ok()
        .and_then(|value| bool::try_from(&value).ok())
        .unwrap_or(false)
}

/// A pattern property the provider actually serves. Some providers serve a
/// pattern while reporting it unavailable, so a supported value proves it.
fn cached_supported(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<VARIANT> {
    // SAFETY: a read of a property the cache request carries.
    let value = unsafe { element.GetCachedPropertyValueEx(id, true) }.ok()?;
    let kind = value.vt();
    (kind != VT_UNKNOWN && kind != VT_EMPTY).then_some(value)
}

fn variant_text(value: &VARIANT) -> String {
    if let Ok(text) = BSTR::try_from(value) {
        return text.to_string();
    }
    if let Ok(number) = i32::try_from(value) {
        return number.to_string();
    }
    if let Ok(number) = f64::try_from(value) {
        return number.to_string();
    }
    if let Ok(flag) = bool::try_from(value) {
        return if flag { "True" } else { "False" }.to_string();
    }
    String::new()
}

#[allow(non_upper_case_globals)]
fn toggle_label(state: ToggleState) -> &'static str {
    match state {
        ToggleState_On => "On",
        ToggleState_Indeterminate => "Indeterminate",
        _ => "Off",
    }
}

#[allow(non_upper_case_globals)]
fn expand_label(state: ExpandCollapseState) -> &'static str {
    match state {
        ExpandCollapseState_Expanded => "Expanded",
        ExpandCollapseState_PartiallyExpanded => "PartiallyExpanded",
        ExpandCollapseState_LeafNode => "LeafNode",
        _ => "Collapsed",
    }
}

fn runtime_key(element: &IUIAutomationElement) -> String {
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

pub struct UiaElement {
    automation: IUIAutomation,
    element: IUIAutomationElement,
    window: Wid,
}

impl UiaElement {
    fn pattern<T: Interface>(&self, id: UIA_PATTERN_ID) -> Option<T> {
        // SAFETY: a plain pattern query on a live element.
        unsafe { self.element.GetCurrentPatternAs::<T>(id) }.ok()
    }

    /// Runs one semantic action with the window held non-activatable: XAML and
    /// Chromium hosts raise themselves while handling an accessibility call.
    fn held<T>(&self, action: impl FnOnce() -> windows::core::Result<T>) -> Result<T, String> {
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
            // An Excel cell echoes a value write it never enters.
            && text(unsafe { self.element.CurrentClassName() }) != "XLSpreadsheetCell"
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
    fn focus(&self) -> Result<(), String> {
        self.held(|| unsafe { self.element.SetFocus() })
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
}

pub struct Uia {
    automation: IUIAutomation,
    background: WinBackground,
}

fn property_condition(automation: &IUIAutomation, id: UIA_PROPERTY_ID, value: VARIANT) -> windows::core::Result<IUIAutomationCondition> {
    // SAFETY: plain factory call.
    unsafe { automation.CreatePropertyCondition(id, &value) }
}

fn any_of(automation: &IUIAutomation, conditions: Vec<IUIAutomationCondition>) -> windows::core::Result<IUIAutomationCondition> {
    let mut iter = conditions.into_iter();
    let mut combined = iter.next().expect("at least one condition");
    for next in iter {
        // SAFETY: plain factory call.
        combined = unsafe { automation.CreateOrCondition(&combined, &next) }?.cast()?;
    }
    Ok(combined)
}

impl Uia {
    pub fn new(shared: Arc<Shared>) -> Result<Uia, String> {
        // SAFETY: COM is initialised on this thread by the desktop.
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("accessibility_unavailable: UI Automation did not start ({})", error.message()))?;
        Ok(Uia {
            automation,
            background: WinBackground::new(shared),
        })
    }

    fn root_of(&self, window: Wid) -> Result<IUIAutomationElement, String> {
        // SAFETY: a plain lookup by window handle.
        unsafe { self.automation.ElementFromHandle(hwnd(window)) }.map_err(|error| {
            format!(
                "window has no UI Automation root: {} ({})",
                crate::platform::window_id(window),
                error.message()
            )
        })
    }

    fn cache(&self) -> windows::core::Result<IUIAutomationCacheRequest> {
        // SAFETY: plain factory and registration calls.
        unsafe {
            let cache = self.automation.CreateCacheRequest()?;
            for id in [
                UIA_NamePropertyId,
                UIA_AutomationIdPropertyId,
                UIA_AcceleratorKeyPropertyId,
                UIA_ControlTypePropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_IsValuePatternAvailablePropertyId,
                UIA_IsTogglePatternAvailablePropertyId,
                UIA_IsSelectionItemPatternAvailablePropertyId,
                UIA_IsExpandCollapsePatternAvailablePropertyId,
                UIA_IsRangeValuePatternAvailablePropertyId,
                UIA_IsInvokePatternAvailablePropertyId,
                UIA_IsScrollPatternAvailablePropertyId,
                UIA_IsTextPatternAvailablePropertyId,
                UIA_IsKeyboardFocusablePropertyId,
                UIA_ClassNamePropertyId,
                UIA_ValueValuePropertyId,
                UIA_ToggleToggleStatePropertyId,
                UIA_SelectionItemIsSelectedPropertyId,
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
                UIA_RangeValueValuePropertyId,
            ] {
                cache.AddProperty(id)?;
            }
            Ok(cache)
        }
    }

    fn node(&self, element: IUIAutomationElement, window: Wid, read_text: bool) -> Option<Node> {
        // SAFETY: cached property reads on an element built with this cache.
        unsafe {
            let rect: RECT = element.CachedBoundingRectangle().ok()?;
            let role = role_of(element.CachedControlType().ok()?.0);
            let mut node = Node {
                element: Rc::new(UiaElement {
                    automation: self.automation.clone(),
                    element: element.clone(),
                    window,
                }),
                role: role.to_string(),
                name: text(element.CachedName()),
                automation_id: text(element.CachedAutomationId()),
                value: String::new(),
                toggle: String::new(),
                selected: String::new(),
                expanded: String::new(),
                range: String::new(),
                accelerator: text(element.CachedAcceleratorKey()),
                can_invoke: false,
                can_set_value: false,
                can_toggle: false,
                can_scroll: false,
                enabled: element.CachedIsEnabled().is_ok_and(|flag| flag.as_bool()),
                offscreen: element.CachedIsOffscreen().is_ok_and(|flag| flag.as_bool()),
                x: rect.left as f64,
                y: rect.top as f64,
                width: (rect.right - rect.left) as f64,
                height: (rect.bottom - rect.top) as f64,
            };
            if let Some(value) = cached_supported(&element, UIA_ValueValuePropertyId) {
                node.value = variant_text(&value);
            }
            if cached_supported(&element, UIA_ValueValuePropertyId).is_some()
                || cached_flag(&element, UIA_IsValuePatternAvailablePropertyId)
            {
                node.can_set_value = text(element.CachedClassName()) != "XLSpreadsheetCell";
            }
            if let Some(value) = cached_supported(&element, UIA_ToggleToggleStatePropertyId) {
                node.toggle = toggle_label(ToggleState(i32::try_from(&value).unwrap_or(0))).to_string();
                node.can_toggle = true;
            } else if cached_flag(&element, UIA_IsTogglePatternAvailablePropertyId) {
                node.can_toggle = true;
            }
            let selectable = cached_flag(&element, UIA_IsSelectionItemPatternAvailablePropertyId);
            if let Some(value) = cached_supported(&element, UIA_SelectionItemIsSelectedPropertyId) {
                node.selected = variant_text(&value);
            }
            if let Some(value) = cached_supported(&element, UIA_ExpandCollapseExpandCollapseStatePropertyId) {
                node.expanded = expand_label(ExpandCollapseState(i32::try_from(&value).unwrap_or(0))).to_string();
            }
            if let Some(value) = cached_supported(&element, UIA_RangeValueValuePropertyId) {
                node.range = variant_text(&value);
            }
            node.can_invoke = selectable || cached_flag(&element, UIA_IsInvokePatternAvailablePropertyId);
            node.can_scroll = cached_flag(&element, UIA_IsScrollPatternAvailablePropertyId);
            // A terminal buffer or document body exposes its content only
            // through TextPattern.
            if read_text
                && !node.can_set_value
                && cached_flag(&element, UIA_IsKeyboardFocusablePropertyId)
                && cached_flag(&element, UIA_IsTextPatternAvailablePropertyId)
            {
                if let Some(visible) = visible_text(&element) {
                    node.value = visible;
                }
            }
            Some(node)
        }
    }
}

/// The on-screen lines of a text surface, newest output last; a long surface
/// is shown from its end.
fn visible_text(element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: plain text-pattern reads.
    unsafe {
        let pattern: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let ranges = pattern.GetVisibleRanges().ok()?;
        let mut lines = Vec::new();
        for index in 0..ranges.Length().ok()? {
            let range = ranges.GetElement(index).ok()?;
            for line in range.GetText(20000).ok()?.to_string().split('\n') {
                let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
                if !line.is_empty() {
                    lines.push(line);
                }
            }
        }
        if lines.is_empty() {
            return None;
        }
        let joined = lines.join("\n");
        let count = joined.chars().count();
        Some(if count > 299 {
            format!("\u{2026}{}", joined.chars().skip(count - 298).collect::<String>())
        } else {
            joined
        })
    }
}

const NONINTERACTIVE: [&str; 15] = [
    "Text", "Custom", "Group", "Pane", "Image", "DataGrid", "DataItem", "Header", "HeaderItem",
    "Table", "ProgressBar", "StatusBar", "ToolBar", "TitleBar", "Separator",
];

impl Accessibility for Uia {
    fn available(&self) -> Result<(), String> {
        Ok(())
    }

    fn snapshot(&self, window: &WindowInfo, include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String> {
        let integrity = native::integrity(window.handle);
        if integrity.higher() {
            return Err(format!(
                "accessibility_blocked_by_integrity: this window runs at {} integrity, above this host ({}), and Windows hides its controls from lower processes; read it with pixels or OCR, and act on frame coordinates with explicit foreground delivery, which asks for elevation",
                integrity.target_name, integrity.own_name
            ));
        }
        let root = self.root_of(window.handle)?;
        let mut roles: Vec<&str> = crate::a11y::INTERACTIVE_ROLES.to_vec();
        if include_noninteractive {
            roles.extend(NONINTERACTIVE);
        }
        let to_error = |error: windows::core::Error| error.message();
        let mut conditions = Vec::new();
        for role in roles {
            conditions.push(
                property_condition(&self.automation, UIA_ControlTypePropertyId, VARIANT::from(control_type_id(role)))
                    .map_err(to_error)?,
            );
        }
        // A focusable text surface is where a terminal or editor takes input,
        // even when its control type reads as static text.
        let text_surface = {
            let has_text = property_condition(&self.automation, UIA_IsTextPatternAvailablePropertyId, VARIANT::from(true)).map_err(to_error)?;
            let focusable = property_condition(&self.automation, UIA_IsKeyboardFocusablePropertyId, VARIANT::from(true)).map_err(to_error)?;
            // SAFETY: plain factory call.
            unsafe { self.automation.CreateAndCondition(&has_text, &focusable) }.map_err(to_error)?
        };
        conditions.push(text_surface);
        let condition = any_of(&self.automation, conditions).map_err(to_error)?;
        let cache = self.cache().map_err(to_error)?;
        // SAFETY: a plain cached search under the window's root.
        let found = unsafe { root.FindAllBuildCache(TreeScope_Descendants, &condition, &cache) }
            .map_err(to_error)?;
        let count = unsafe { found.Length() }.map_err(to_error)?.max(0) as usize;
        let read_text = !window.class_name.starts_with(CHROMIUM_PREFIX);
        let mut nodes = Vec::new();
        for index in 0..count.min(limit) {
            let Ok(element) = (unsafe { found.GetElement(index as i32) }) else {
                continue;
            };
            if let Some(node) = self.node(element, window.handle, read_text) {
                nodes.push(node);
            }
        }
        if count > limit {
            // One past the limit tells the caller the read was cut.
            if let Some(last) = nodes.last().cloned() {
                nodes.push(last);
            }
        }
        Ok(nodes)
    }

    fn focused_masked(&self) -> bool {
        // SAFETY: plain property reads; anything unreadable counts as a password.
        unsafe {
            self.automation
                .GetFocusedElement()
                .and_then(|element| element.CurrentIsPassword())
                .map_or(true, |flag| flag.as_bool())
        }
    }

    fn invoke_menu(
        &self,
        window: &WindowInfo,
        path: &[String],
        authorize: &dyn Fn() -> Result<(), String>,
    ) -> Result<MenuOutcome, String> {
        if let Some(outcome) = classic_menu(window, path, authorize)? {
            return Ok(outcome);
        }
        let mut root: Option<IUIAutomationElement> = None;
        let mut walked: Vec<&str> = Vec::new();
        let mut opened = 0usize;
        let outcome = self.walk_menu(window, path, authorize, &mut root, &mut walked, &mut opened);
        if outcome.is_err() && opened > 0 {
            // Nothing was invoked, so the window returns to the state it had.
            let _ = self.background.keys(window.handle, &"{ESC}".repeat(opened));
        }
        outcome
    }
}

fn menu_candidates(automation: &IUIAutomation, root: &IUIAutomationElement, name: &str, menu_only: bool) -> Vec<IUIAutomationElement> {
    let wanted = normalize_menu_label(name);
    let roles: &[&str] = if menu_only {
        &["MenuItem"]
    } else {
        &["MenuItem", "Button", "SplitButton", "ListItem"]
    };
    let Ok(conditions) = roles
        .iter()
        .map(|role| property_condition(automation, UIA_ControlTypePropertyId, VARIANT::from(control_type_id(role))))
        .collect::<Result<Vec<_>, _>>()
    else {
        return Vec::new();
    };
    let Ok(condition) = any_of(automation, conditions) else {
        return Vec::new();
    };
    // A provider can disappear between capture and invocation; an empty set
    // lets the caller report the path as not found.
    // SAFETY: plain searches and property reads.
    unsafe {
        let Ok(found) = root.FindAll(TreeScope_Descendants, &condition) else {
            return Vec::new();
        };
        let count = found.Length().unwrap_or(0);
        (0..count)
            .filter_map(|index| found.GetElement(index).ok())
            .filter(|element| {
                !element.CurrentIsOffscreen().map_or(true, |flag| flag.as_bool())
                    && normalize_menu_label(&text(element.CurrentName())) == wanted
            })
            .collect()
    }
}

impl Uia {
    fn top_window(&self, element: &IUIAutomationElement) -> Wid {
        // SAFETY: plain tree-walker reads.
        unsafe {
            let walker = self.automation.ControlViewWalker().ok();
            let mut current = Some(element.clone());
            for _ in 0..80 {
                let Some(node) = current else { break };
                let handle = node.CurrentNativeWindowHandle().map(|handle| handle.0 as usize as Wid).unwrap_or(0);
                if handle != 0 {
                    return native::root_of(handle);
                }
                current = walker.as_ref().and_then(|walker| walker.GetParentElement(&node).ok());
            }
        }
        0
    }

    fn walk_menu<'a>(
        &self,
        window: &WindowInfo,
        path: &'a [String],
        authorize: &dyn Fn() -> Result<(), String>,
        root: &mut Option<IUIAutomationElement>,
        walked: &mut Vec<&'a str>,
        opened: &mut usize,
    ) -> Result<MenuOutcome, String> {
        for (index, segment) in path.iter().enumerate() {
            let scope = match root {
                Some(root) => root.clone(),
                None => self.root_of(window.handle)?,
            };
            let mut candidates = menu_candidates(&self.automation, &scope, segment, index > 0);
            if candidates.is_empty() && index > 0 {
                // A submenu may live outside the parent item's subtree, but it
                // must still belong to this window's owned popup chain.
                for popup in native::related_windows(window.handle) {
                    if popup == window.handle || !native::is_owned_by(popup, window.handle) {
                        continue;
                    }
                    if let Ok(popup_root) = self.root_of(popup) {
                        candidates.extend(menu_candidates(&self.automation, &popup_root, segment, true));
                    }
                }
            }
            if candidates.is_empty() {
                // A wrong path and a popup chain that closed under the person's
                // own click fail alike, so the count that separates them travels.
                let owned = native::related_windows(window.handle).len();
                return Err(format!(
                    "menu_path_not_found: no enabled menu entry named '{segment}' after {}; owned_popups={owned}",
                    walked.join(" > ")
                ));
            }
            if candidates.len() > 1 {
                return Err(format!(
                    "menu_path_ambiguous: '{segment}' matched {} entries; use a more exact path",
                    candidates.len()
                ));
            }
            let element = candidates.remove(0);
            let owner = self.top_window(&element);
            if owner != window.handle && !native::is_owned_by(owner, window.handle) {
                return Err("menu_target_mismatch: menu element no longer belongs to the requested window".into());
            }
            authorize()?;
            // SAFETY: plain property read on a live element.
            if !unsafe { element.CurrentIsEnabled() }.map_or(true, |flag| flag.as_bool()) {
                return Err(format!("menu_item_disabled: '{segment}' is disabled"));
            }
            walked.push(segment);
            let last = index == path.len() - 1;
            // SAFETY: plain pattern queries and calls on a live element.
            unsafe {
                if last {
                    if let Ok(invoke) = element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                        authorize()?;
                        invoke.Invoke().map_err(|error| error.message())?;
                        return Ok(MenuOutcome {
                            path: "uia_menu",
                            verified: false,
                            message: format!("invoked menu path: {}", walked.join(" > ")),
                        });
                    }
                    if let Ok(toggle) = element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                        let before = toggle_label(toggle.CurrentToggleState().unwrap_or_default());
                        authorize()?;
                        toggle.Toggle().map_err(|error| error.message())?;
                        let after = toggle_label(toggle.CurrentToggleState().unwrap_or_default());
                        return Ok(MenuOutcome {
                            path: "uia_menu_toggle",
                            verified: before != after,
                            message: format!(
                                "toggled menu path: {} from {before} to {after}",
                                walked.join(" > ")
                            ),
                        });
                    }
                    return Err(format!("menu_item_not_invokable: '{segment}' exposes no menu action"));
                }
                let opened_by_expand = match element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                    Ok(expand) => {
                        if expand.CurrentExpandCollapseState().map_or(true, |state| state != ExpandCollapseState_Expanded) {
                            authorize()?;
                            expand.Expand().map_err(|error| error.message())?;
                        }
                        true
                    }
                    Err(_) => false,
                };
                if !opened_by_expand {
                    match element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                        Ok(invoke) => {
                            authorize()?;
                            invoke.Invoke().map_err(|error| error.message())?;
                        }
                        Err(_) => {
                            return Err(format!(
                                "menu_expand_unavailable: '{segment}' cannot be opened through accessibility"
                            ))
                        }
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
            *opened += 1;
            *root = Some(element);
        }
        unreachable!("a menu path has at least one segment")
    }
}

// --- classic menu bars ----------------------------------------------------------------

struct MenuEntry {
    label: String,
    submenu: HMENU,
    id: u32,
    enabled: bool,
}

fn menu_entries(window: Wid, menu: HMENU, position: usize, announce: bool) -> Vec<MenuEntry> {
    if announce {
        // A submenu is first announced the way an opening menu is, so the app
        // refreshes the enabled state and dynamic items it would show a person.
        super::background::send_value(window, WM_INITMENUPOPUP, menu.0 as usize, (position & 0xFFFF) as isize).ok();
    }
    // SAFETY: plain menu reads; the info struct is sized before each call.
    unsafe {
        let count = GetMenuItemCount(Some(menu)).max(0) as u32;
        let mut entries = Vec::new();
        for index in 0..count {
            let mut info = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE,
                ..Default::default()
            };
            if GetMenuItemInfoW(menu, index, true, &mut info).is_err() || info.fType.0 & MFT_SEPARATOR.0 != 0 {
                continue;
            }
            let mut label = [0u16; 512];
            let length = GetMenuStringW(menu, index, Some(&mut label), MF_BYPOSITION);
            entries.push(MenuEntry {
                label: String::from_utf16_lossy(&label[..length.max(0) as usize]),
                submenu: info.hSubMenu,
                id: info.wID,
                enabled: info.fState.0 & MFS_DISABLED.0 == 0,
            });
        }
        entries
    }
}

/// A classic menu bar answers the whole path from its own menu handles: no
/// level opens on screen, and the chosen item reaches the window as the same
/// command a click sends. `None` means the window has no classic menu or the
/// path does not start on it, so the accessibility route decides.
fn classic_menu(
    window: &WindowInfo,
    path: &[String],
    authorize: &dyn Fn() -> Result<(), String>,
) -> Result<Option<MenuOutcome>, String> {
    // SAFETY: plain lookup.
    let bar = unsafe { GetMenu(hwnd(window.handle)) };
    if bar.0.is_null() {
        return Ok(None);
    }
    let (mut menu, mut position) = (bar, 0usize);
    let mut walked: Vec<&str> = Vec::new();
    for (index, segment) in path.iter().enumerate() {
        let wanted = normalize_menu_label(segment);
        let entries = menu_entries(window.handle, menu, position, index > 0);
        let matches: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| normalize_menu_label(&entry.label) == wanted)
            .map(|(at, _)| at)
            .collect();
        if matches.is_empty() {
            if index == 0 {
                return Ok(None);
            }
            // The level's own entries turn a guessed name into a corrected one.
            let available: Vec<String> = entries
                .iter()
                .map(|entry| normalize_menu_label(&entry.label))
                .filter(|label| !label.is_empty())
                .take(20)
                .collect();
            return Err(format!(
                "menu_path_not_found: no menu entry named '{segment}' after {}; entries: {}",
                walked.join(" > "),
                available.join(", ")
            ));
        }
        if matches.len() > 1 {
            return Err(format!(
                "menu_path_ambiguous: '{segment}' matched {} entries; use a more exact path",
                matches.len()
            ));
        }
        let entry = &entries[matches[0]];
        if !entry.enabled {
            return Err(format!("menu_item_disabled: '{segment}' is disabled"));
        }
        walked.push(segment);
        let has_submenu = !entry.submenu.0.is_null();
        if index < path.len() - 1 {
            if !has_submenu {
                return Err(format!(
                    "menu_path_not_found: '{segment}' opens no submenu for '{}'",
                    path[index + 1]
                ));
            }
            menu = entry.submenu;
            position = matches[0];
            continue;
        }
        if has_submenu {
            return Err(format!(
                "menu_item_not_invokable: '{segment}' opens a submenu; name one of its entries"
            ));
        }
        authorize()?;
        // The notification a person choosing the item produces, without opening
        // any menu on screen.
        // SAFETY: plain post.
        unsafe { PostMessageW(Some(hwnd(window.handle)), WM_COMMAND, windows::Win32::Foundation::WPARAM((entry.id & 0xFFFF) as usize), Default::default()) }
            .map_err(|error| {
                if error.code().0 as u32 & 0xFFFF == 5 {
                    "background_blocked_uipi|Windows integrity isolation blocked the menu command".to_string()
                } else {
                    format!("background_message_rejected|menu command failed: {}", error.message())
                }
            })?;
        return Ok(Some(MenuOutcome {
            path: "win32_menu",
            verified: false,
            message: format!("invoked menu path: {}", walked.join(" > ")),
        }));
    }
    Ok(None)
}
