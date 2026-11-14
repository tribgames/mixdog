//! The cached snapshot read: one FindAllBuildCache under the window's root,
//! each element read into a node from its cache, and the visible lines of
//! text surfaces.

use super::super::bounded::Mta;
use super::super::native;
use super::element::{expand_label, toggle_label, UiaElement};
use super::{any_of, control_type_id, property_condition, role_of, root_from, text, Uia};
use crate::a11y::{integrity_refusal, Node, NodeExtra};
use crate::platform::{Wid, WindowInfo};
use std::rc::Rc;
use windows::core::BSTR;
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Variant::{VARIANT, VT_EMPTY, VT_UNKNOWN};
use windows::Win32::UI::Accessibility::*;

pub(super) const CHROMIUM_PREFIX: &str = "Chrome_WidgetWin";

const NONINTERACTIVE: [&str; 15] = [
    "Text", "Custom", "Group", "Pane", "Image", "DataGrid", "DataItem", "Header", "HeaderItem",
    "Table", "ProgressBar", "StatusBar", "ToolBar", "TitleBar", "Separator",
];

pub(super) fn cached_flag(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> bool {
    // SAFETY: a read of a property the cache request carries.
    unsafe { element.GetCachedPropertyValue(id) }
        .ok()
        .and_then(|value| bool::try_from(&value).ok())
        .unwrap_or(false)
}

/// A pattern property the provider actually serves. Some providers serve a
/// pattern while reporting it unavailable, so a supported value proves it.
pub(super) fn cached_supported(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<VARIANT> {
    // SAFETY: a read of a property the cache request carries.
    let value = unsafe { element.GetCachedPropertyValueEx(id, true) }.ok()?;
    let kind = value.vt();
    (kind != VT_UNKNOWN && kind != VT_EMPTY).then_some(value)
}

pub(super) fn variant_text(value: &VARIANT) -> String {
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

impl Uia {
    fn cache(&self) -> windows::core::Result<IUIAutomationCacheRequest> {
        // SAFETY: plain factory and registration calls.
        unsafe {
            let cache = self.automation.CreateCacheRequest()?;
            for id in [
                UIA_NamePropertyId,
                UIA_AutomationIdPropertyId,
                UIA_AcceleratorKeyPropertyId,
                UIA_AccessKeyPropertyId,
                UIA_HelpTextPropertyId,
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

    fn node(&self, element: IUIAutomationElement, window: Wid, read_text: bool) -> Result<Option<Node>, String> {
        // SAFETY: cached property reads on an element built with this cache.
        unsafe {
            let (Ok(rect), Ok(control_type)) = (element.CachedBoundingRectangle(), element.CachedControlType()) else {
                return Ok(None);
            };
            let rect: RECT = rect;
            let role = role_of(control_type.0);
            let text_surface = cached_flag(&element, UIA_IsKeyboardFocusablePropertyId)
                && cached_flag(&element, UIA_IsTextPatternAvailablePropertyId);
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
                extra: NodeExtra {
                    access_key: text(element.CachedAccessKey()),
                    help: text(element.CachedHelpText()),
                    text_surface,
                    ..NodeExtra::default()
                },
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
            if read_text && !node.can_set_value && text_surface {
                if let Some(visible) = self.visible_text(&element)? {
                    node.value = visible;
                }
            }
            Ok(Some(node))
        }
    }

    /// Every element of the window in document order, up to `limit`
    /// (Snapshot-Window's cached FindAll).
    pub(super) fn cached_snapshot(
        &self,
        window: &WindowInfo,
        include_noninteractive: bool,
        limit: usize,
    ) -> Result<Vec<Node>, String> {
        // snapshot_window has refused already; the other callers of this
        // read have not.
        if let Some(refusal) = integrity_refusal(&native::integrity(window.handle)) {
            return Err(refusal);
        }
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
        let (automation, condition, cache) = (Mta::new(self.automation.clone()), Mta::new(condition), Mta::new(cache));
        let handle = window.handle;
        let found = self
            .bounded("the element search", move || {
                let root = root_from(&automation.get(), handle)?;
                // SAFETY: a plain cached search under the window's root.
                unsafe { root.FindAllBuildCache(TreeScope_Descendants, &condition.get(), &cache.get()) }
                    .map(Mta::new)
                    .map_err(|error| error.message())
            })?
            .get();
        let count = unsafe { found.Length() }.map_err(to_error)?.max(0) as usize;
        let read_text = !window.class_name.starts_with(CHROMIUM_PREFIX);
        let mut nodes = Vec::new();
        for index in 0..count.min(limit) {
            let Ok(element) = (unsafe { found.GetElement(index as i32) }) else {
                continue;
            };
            if let Some(node) = self.node(element, window.handle, read_text)? {
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
}

impl Uia {
    /// The on-screen lines of a text surface, each with its whitespace
    /// collapsed (Get-VisibleTextLines); `None` when the provider did not
    /// serve them, an error when the read outlasted the snapshot's deadline
    /// (MixBoundedUia.VisibleText).
    pub(super) fn visible_lines(&self, element: &IUIAutomationElement) -> Result<Option<Vec<String>>, String> {
        let element = Mta::new(element.clone());
        self.bounded("the visible text read", move || Ok(read_visible_lines(&element.get())))
    }

    /// The on-screen lines of a text surface, newest output last; a long
    /// surface is shown from its end.
    fn visible_text(&self, element: &IUIAutomationElement) -> Result<Option<String>, String> {
        Ok(self.visible_lines(element)?.and_then(|lines| cut_visible(&lines)))
    }
}

fn read_visible_lines(element: &IUIAutomationElement) -> Option<Vec<String>> {
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
        Some(lines)
    }
}

fn cut_visible(lines: &[String]) -> Option<String> {
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
