//! The accessibility tree through UI Automation: one bounded cached read per
//! snapshot, the semantic actions on its elements, and menu paths.

pub(in crate::platform::windows) mod element;
mod enrich;
mod menu;
mod reads;
mod rebind;
mod selection;
mod snapshot;

use super::background::WinBackground;
use super::native::hwnd;
use crate::a11y::{Accessibility, Element, MenuOutcome, Node, PredicateObservation};
use crate::observer::Shared;
use crate::platform::{Wid, WindowInfo};
use crate::session::RefRecord;
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;
use super::bounded::{self, Deadline};
use windows::core::{BSTR, Interface};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

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

/// Whether a field hides what is typed into it (Test-FocusMasked,
/// Test-RecordMasked): UIA's IsPassword first, then MSAA's PROTECTED state of
/// the field's own window, which a legacy edit raises instead. `None` is a
/// read that failed, and anything unreadable counts as a password.
pub(super) fn masked(
    password: Option<bool>,
    native: impl FnOnce() -> Option<Wid>,
    protected: impl Fn(Wid) -> Option<bool>,
) -> bool {
    // The native window is read only once IsPassword said no, as both
    // PowerShell tests do.
    match password {
        Some(false) => match native() {
            Some(0) => false,
            Some(handle) => protected(handle).unwrap_or(true),
            None => true,
        },
        _ => true,
    }
}

pub struct Uia {
    automation: IUIAutomation,
    background: WinBackground,
    /// When the snapshot being read started and the milliseconds it may take
    /// (`Accessibility::set_deadline`).
    deadline: Cell<Option<Deadline>>,
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
            deadline: Cell::new(None),
        })
    }

    /// Runs one provider read against the snapshot's deadline, on a thread of
    /// its own when there is one (MixBoundedUia.Run).
    fn bounded<T: Send + 'static>(
        &self,
        stage: &str,
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        bounded::run(self.deadline.get().as_ref(), stage, work)
    }

    fn root_of(&self, window: Wid) -> Result<IUIAutomationElement, String> {
        root_from(&self.automation, window)
    }
}

/// A window's UI Automation root; the bounded element search looks it up on
/// its own thread, as the window's provider answers it (MixBoundedUia.FindAll).
fn root_from(automation: &IUIAutomation, window: Wid) -> Result<IUIAutomationElement, String> {
    // SAFETY: a plain lookup by window handle.
    unsafe { automation.ElementFromHandle(hwnd(window)) }.map_err(|error| {
        format!(
            "window has no UI Automation root: {} ({})",
            crate::platform::window_id(window),
            error.message()
        )
    })
}

impl Accessibility for Uia {
    fn available(&self) -> Result<(), String> {
        Ok(())
    }

    fn snapshot(&self, window: &WindowInfo, include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String> {
        self.cached_snapshot(window, include_noninteractive, limit)
    }

    fn focused_masked(&self) -> bool {
        // SAFETY: a plain lookup; no focused element counts as a password.
        unsafe { self.automation.GetFocusedElement() }.map_or(true, |element| element::masked(&element))
    }

    fn invoke_menu(
        &self,
        window: &WindowInfo,
        path: &[String],
        authorize: &dyn Fn() -> Result<(), String>,
    ) -> Result<MenuOutcome, String> {
        self.menu(window, path, authorize)
    }

    fn probe(&self, window: &WindowInfo) -> Result<Option<&'static str>, String> {
        self.readiness(window)
    }

    fn predicate_read(
        &self,
        window: &WindowInfo,
        max: usize,
    ) -> Result<(Vec<PredicateObservation>, bool), String> {
        self.predicates(window, max)
    }

    fn rebind(&self, window: Wid, record: &RefRecord) -> Option<Rc<dyn Element>> {
        self.rebound(window, record)
    }

    fn set_deadline(&self, deadline_ms: Option<u64>) {
        self.deadline.set(deadline_ms.map(|budget_ms| Deadline { start: Instant::now(), budget_ms }));
    }

    fn enrich(
        &self,
        window: &WindowInfo,
        uia_found: usize,
        bounded: bool,
        offset_plus_max: usize,
        prior: usize,
    ) -> Result<(Vec<Node>, usize, Option<String>), String> {
        self.enrich_snapshot(window, uia_found, bounded, offset_plus_max, prior)
    }
}

#[cfg(test)]
mod tests {
    use super::masked;

    #[test]
    fn a_field_is_masked_unless_both_reads_say_otherwise() {
        let never = |_| -> Option<bool> { panic!("MSAA is asked only for a native window that UIA calls plain") };
        let unread = || -> Option<crate::platform::Wid> { panic!("the native window is read only for a field UIA calls plain") };
        // An unreadable UIA element.
        assert!(masked(None, unread, never));
        // UIA's IsPassword.
        assert!(masked(Some(true), unread, never));
        // An unreadable native handle.
        assert!(masked(Some(false), || None, never));
        // No native window of its own: UIA's answer stands.
        assert!(!masked(Some(false), || Some(0), never));
        // MSAA's PROTECTED state of the field's own window.
        assert!(masked(Some(false), || Some(7), |handle| (handle == 7).then_some(true)));
        assert!(!masked(Some(false), || Some(7), |_| Some(false)));
        // An unreadable MSAA state.
        assert!(masked(Some(false), || Some(7), |_| None));
    }
}
