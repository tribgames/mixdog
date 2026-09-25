//! The accessibility tree through the AX API, mapped into the shared role
//! vocabulary.

use super::ffi::*;
use super::windows;
use crate::a11y::{normalize_menu_label, Accessibility, Element, MenuOutcome, Node};
use crate::obj;
use crate::platform::{WindowInfo, Wid};
use crate::protocol::Obj;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

extern "C" {
    fn CFHash(value: core_foundation::base::CFTypeRef) -> usize;
}

const ATTRIBUTES: [&str; 12] = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXPosition", "AXSize", "AXIdentifier", "AXChildren",
    "AXSelected", "AXExpanded",
];

pub fn role_of(role: &str, subrole: &str) -> &'static str {
    match (role, subrole) {
        (_, "AXSecureTextField") => "Edit",
        (_, "AXTabButton") => "TabItem",
        (_, "AXSwitch") | (_, "AXToggle") => "CheckBox",
        ("AXButton", _) | ("AXDisclosureTriangle", _) | ("AXMenuButton", _) | ("AXColorWell", _) => "Button",
        ("AXPopUpButton", _) | ("AXComboBox", _) => "ComboBox",
        ("AXTextField", _) | ("AXTextArea", _) | ("AXSearchField", _) => "Edit",
        ("AXCheckBox", _) => "CheckBox",
        ("AXRadioButton", _) => "RadioButton",
        ("AXList", _) | ("AXTable", _) | ("AXGrid", _) | ("AXBrowser", _) => "List",
        ("AXOutline", _) => "Tree",
        ("AXRow", "AXOutlineRow") => "TreeItem",
        ("AXRow", _) | ("AXCell", _) => "ListItem",
        ("AXMenuItem", _) | ("AXMenuBarItem", _) => "MenuItem",
        ("AXLink", _) => "Hyperlink",
        ("AXSlider", _) => "Slider",
        ("AXIncrementor", _) | ("AXStepper", _) => "Spinner",
        ("AXWebArea", _) => "Document",
        ("AXStaticText", _) | ("AXHeading", _) => "Text",
        ("AXImage", _) => "Image",
        ("AXToolbar", _) => "ToolBar",
        ("AXProgressIndicator", _) | ("AXBusyIndicator", _) => "ProgressBar",
        ("AXSplitter", _) => "Separator",
        ("AXTabGroup", _) => "Tab",
        ("AXScrollArea", _) | ("AXSplitGroup", _) | ("AXLayoutArea", _) => "Pane",
        ("AXWindow", _) | ("AXSheet", _) | ("AXDrawer", _) => "Window",
        ("AXGroup", _) | ("AXRadioGroup", _) => "Group",
        _ => "Custom",
    }
}

fn text_value(value: &CFType) -> Option<String> {
    as_string(value).or_else(|| {
        as_f64(value).map(|number| if number.fract() == 0.0 { format!("{}", number as i64) } else { format!("{number}") })
    })
}

fn toggle_label(value: f64) -> String {
    match value.round() as i64 {
        0 => "Off".into(),
        1 => "On".into(),
        _ => "Indeterminate".into(),
    }
}

fn is_toggle(role: &str, subrole: &str) -> bool {
    role == "AXCheckBox" || subrole == "AXSwitch" || subrole == "AXToggle"
}

pub struct AxElement {
    element: CFType,
    pid: i32,
    window: Wid,
    ax_role: String,
    ax_subrole: String,
}

impl AxElement {
    fn raw(&self) -> core_foundation::base::CFTypeRef {
        self.element.as_CFTypeRef()
    }
    fn attribute(&self, name: &str) -> Option<CFType> {
        ax_copy(self.raw(), name).ok()
    }
    fn press_actions(&self) -> Vec<String> {
        let actions = ax_actions(self.raw());
        ["AXPress", "AXConfirm", "AXPick", "AXOpen"]
            .iter()
            .filter(|name| actions.iter().any(|action| action == *name))
            .map(|name| name.to_string())
            .collect()
    }
    fn scroll_bar(&self, horizontal: bool) -> Option<CFType> {
        self.attribute(if horizontal { "AXHorizontalScrollBar" } else { "AXVerticalScrollBar" })
    }
}

impl Element for AxElement {
    fn identity(&self) -> String {
        // SAFETY: CFHash reads the element's hash, consistent with CFEqual.
        let hash = unsafe { CFHash(self.raw()) };
        format!("{}:{hash:x}:{}", self.pid, self.ax_role)
    }
    fn window(&self) -> Wid {
        self.window
    }
    fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let origin = self.attribute("AXPosition").and_then(|value| as_point(&value))?;
        let size = self.attribute("AXSize").and_then(|value| as_size(&value))?;
        Some((origin.x, origin.y, size.width, size.height))
    }
    fn enabled(&self) -> bool {
        self.attribute("AXEnabled").and_then(|value| as_bool(&value)).unwrap_or(true)
    }
    fn alive(&self) -> bool {
        match ax_copy(self.raw(), "AXRole") {
            Ok(_) => true,
            Err(status) => status != kAXErrorInvalidUIElement,
        }
    }
    fn press(&self) -> Result<(), String> {
        let mut last = kAXErrorCannotComplete;
        for action in self.press_actions() {
            last = ax_perform(self.raw(), &action);
            if last == kAXErrorSuccess {
                return Ok(());
            }
        }
        Err(format!("a11y_action_failed: element exposes no press action (AX error {last})"))
    }
    fn can_press(&self) -> bool {
        !self.press_actions().is_empty()
    }
    fn toggle_state(&self) -> Option<String> {
        if !is_toggle(&self.ax_role, &self.ax_subrole) {
            return None;
        }
        self.attribute("AXValue").and_then(|value| as_f64(&value)).map(toggle_label)
    }
    fn expand_state(&self) -> Option<String> {
        let expanded = if self.ax_role == "AXDisclosureTriangle" {
            self.attribute("AXValue").and_then(|value| as_bool(&value))
        } else {
            self.attribute("AXExpanded").and_then(|value| as_bool(&value))
        }?;
        Some(if expanded { "Expanded" } else { "Collapsed" }.into())
    }
    fn set_expanded(&self, expanded: bool) -> Result<(), String> {
        if ax_settable(self.raw(), "AXExpanded") {
            let status = ax_set(self.raw(), "AXExpanded", &cf_bool(expanded));
            if status == kAXErrorSuccess {
                return Ok(());
            }
        }
        self.press()
    }
    fn value(&self) -> Option<String> {
        self.attribute("AXValue").and_then(|value| text_value(&value))
    }
    fn settable(&self) -> bool {
        !is_toggle(&self.ax_role, &self.ax_subrole) && self.ax_role != "AXRadioButton" && ax_settable(self.raw(), "AXValue")
    }
    fn set_value(&self, text: &str) -> Result<(), String> {
        let numeric = matches!(self.ax_role.as_str(), "AXSlider" | "AXIncrementor" | "AXStepper");
        let value = if numeric {
            let number: f64 = text.trim().parse().map_err(|_| format!("a11y_value_failed: '{text}' is not a number for this control"))?;
            CFNumber::from(number).as_CFType()
        } else {
            CFString::new(text).as_CFType()
        };
        match ax_set(self.raw(), "AXValue", &value) {
            kAXErrorSuccess => Ok(()),
            status => Err(format!("a11y_value_failed: AX error {status}")),
        }
    }
    fn can_select(&self) -> bool {
        ax_settable(self.raw(), "AXSelected")
    }
    fn select(&self) -> Result<(), String> {
        match ax_set(self.raw(), "AXSelected", &cf_bool(true)) {
            kAXErrorSuccess => Ok(()),
            status => Err(format!("a11y_action_failed: selection rejected (AX error {status})")),
        }
    }
    fn focus(&self) -> Result<(), String> {
        match ax_set(self.raw(), "AXFocused", &cf_bool(true)) {
            kAXErrorSuccess => Ok(()),
            status => Err(format!("AX error {status}")),
        }
    }
    fn scroll(&self, horizontal: bool, increments: i32) -> Result<Option<(String, String)>, String> {
        let Some(bar) = self.scroll_bar(horizontal) else { return Ok(None) };
        let read = || ax_copy(bar.as_CFTypeRef(), "AXValue").ok().and_then(|value| as_f64(&value));
        let Some(before) = read() else { return Ok(None) };
        let target = (before + increments as f64 * 0.05).clamp(0.0, 1.0);
        let status = ax_set(bar.as_CFTypeRef(), "AXValue", &CFNumber::from(target).as_CFType());
        if status != kAXErrorSuccess {
            return Ok(None);
        }
        let after = read().unwrap_or(before);
        Ok(Some((format!("{before:.3}"), format!("{after:.3}"))))
    }
    fn structure(&self) -> Obj {
        let mut ancestors = Vec::new();
        let mut parent_id = String::new();
        let mut in_document = false;
        let mut current = self.attribute("AXParent");
        for depth in 0..80 {
            let Some(parent) = current else { break };
            let role = ax_copy(parent.as_CFTypeRef(), "AXRole").ok().and_then(|value| as_string(&value)).unwrap_or_default();
            if role == "AXApplication" {
                break;
            }
            let subrole = ax_copy(parent.as_CFTypeRef(), "AXSubrole").ok().and_then(|value| as_string(&value)).unwrap_or_default();
            let name = ax_copy(parent.as_CFTypeRef(), "AXTitle").ok().and_then(|value| as_string(&value)).unwrap_or_default();
            // SAFETY: CFHash reads the element's hash.
            let id = format!("{}:{:x}:{role}", self.pid, unsafe { CFHash(parent.as_CFTypeRef()) });
            if depth == 0 {
                parent_id = id.clone();
            }
            if role == "AXWebArea" {
                in_document = true;
            }
            ancestors.push(json!({ "runtime_id": id, "role": role_of(&role, &subrole), "name": crate::a11y::format_value(&name, 200) }));
            current = ax_copy(parent.as_CFTypeRef(), "AXParent").ok();
        }
        obj! {
            "runtime_id" => self.identity(),
            "parent_runtime_id" => parent_id,
            "class_name" => if self.ax_subrole.is_empty() { self.ax_role.clone() } else { self.ax_subrole.clone() },
            "has_keyboard_focus" => self.attribute("AXFocused").and_then(|value| as_bool(&value)).unwrap_or(false),
            "in_document" => in_document,
            "ancestors" => ancestors,
        }
    }
    fn range_value(&self) -> Option<String> {
        matches!(self.ax_role.as_str(), "AXSlider" | "AXIncrementor" | "AXProgressIndicator" | "AXScrollBar")
            .then(|| self.value())
            .flatten()
    }
}

pub struct MacAccessibility {
    /// Applications already asked to expose their web content tree.
    enabled_pids: RefCell<HashSet<i32>>,
}

impl MacAccessibility {
    pub fn new() -> MacAccessibility {
        MacAccessibility { enabled_pids: RefCell::new(HashSet::new()) }
    }

    /// Chromium and Electron build their accessibility tree only for a client
    /// that asks; setting the manual flag is that request.
    fn enable_app(&self, pid: i32) {
        if self.enabled_pids.borrow_mut().insert(pid) {
            let app = application(pid);
            ax_set(app.as_CFTypeRef(), "AXManualAccessibility", &cf_bool(true));
        }
    }

    fn node(&self, element: CFType, values: &[Option<CFType>], pid: i32, window: Wid) -> Node {
        let text = |index: usize| values.get(index).and_then(|value| value.as_ref()).and_then(as_string).unwrap_or_default();
        let ax_role = text(0);
        let ax_subrole = text(1);
        let role = role_of(&ax_role, &ax_subrole);
        let raw_value = values.get(4).and_then(|value| value.clone());
        let enabled = values.get(5).and_then(|value| value.as_ref()).and_then(as_bool).unwrap_or(true);
        let origin = values.get(6).and_then(|value| value.as_ref()).and_then(as_point).unwrap_or_default();
        let size = values.get(7).and_then(|value| value.as_ref()).and_then(as_size).unwrap_or_default();
        let selected_flag = values.get(10).and_then(|value| value.as_ref()).and_then(as_bool);
        let expanded_flag = values.get(11).and_then(|value| value.as_ref()).and_then(as_bool);
        let mut name = text(2);
        if name.is_empty() {
            name = text(3);
        }
        let value_text = raw_value.as_ref().and_then(text_value).unwrap_or_default();
        if name.is_empty() && role == "Text" {
            name = value_text.clone();
        }
        let toggle = if is_toggle(&ax_role, &ax_subrole) {
            raw_value.as_ref().and_then(as_f64).map(toggle_label).unwrap_or_default()
        } else {
            String::new()
        };
        let selected = if ax_role == "AXRadioButton" {
            raw_value.as_ref().and_then(as_bool).map(|flag| if flag { "True" } else { "False" }.to_string()).unwrap_or_default()
        } else {
            selected_flag.map(|flag| if flag { "True" } else { "False" }.to_string()).unwrap_or_default()
        };
        let expanded = if ax_role == "AXDisclosureTriangle" {
            raw_value.as_ref().and_then(as_bool)
        } else {
            expanded_flag
        }
        .map(|flag| if flag { "Expanded" } else { "Collapsed" }.to_string())
        .unwrap_or_default();
        let range = if matches!(role, "Slider" | "Spinner" | "ProgressBar") { value_text.clone() } else { String::new() };
        let value = if matches!(role, "Edit" | "ComboBox" | "Document" | "Hyperlink") { value_text } else { String::new() };
        let can_set_value = matches!(role, "Edit" | "ComboBox" | "Slider" | "Spinner") && ax_settable(element.as_CFTypeRef(), "AXValue");
        let can_invoke = matches!(role, "Button" | "CheckBox" | "RadioButton" | "MenuItem" | "Hyperlink" | "TabItem" | "ComboBox" | "SplitButton")
            || (matches!(role, "ListItem" | "TreeItem") && selected_flag.is_some());
        Node {
            element: Rc::new(AxElement { element, pid, window, ax_role: ax_role.clone(), ax_subrole }),
            role: role.to_string(),
            name,
            automation_id: text(8),
            value,
            toggle: toggle.clone(),
            selected,
            expanded,
            range,
            accelerator: String::new(),
            can_invoke,
            can_set_value,
            can_toggle: !toggle.is_empty(),
            can_scroll: ax_role == "AXScrollArea",
            enabled,
            offscreen: false,
            x: origin.x,
            y: origin.y,
            width: size.width,
            height: size.height,
        }
    }
}

fn children_of(values: &[Option<CFType>]) -> Vec<CFType> {
    values.get(9).and_then(|value| value.as_ref()).map(ax_elements).unwrap_or_default()
}

fn menu_children(element: &CFType) -> Vec<CFType> {
    ax_copy(element.as_CFTypeRef(), "AXChildren").map(|value| ax_elements(&value)).unwrap_or_default()
}

fn title_of(element: &CFType) -> String {
    ax_copy(element.as_CFTypeRef(), "AXTitle").ok().and_then(|value| as_string(&value)).unwrap_or_default()
}

fn enabled_of(element: &CFType) -> bool {
    ax_copy(element.as_CFTypeRef(), "AXEnabled").ok().and_then(|value| as_bool(&value)).unwrap_or(true)
}

/// The AXMenu under a menu item, if it opens one.
fn submenu_of(element: &CFType) -> Option<CFType> {
    menu_children(element).into_iter().find(|child| {
        ax_copy(child.as_CFTypeRef(), "AXRole").ok().and_then(|value| as_string(&value)).as_deref() == Some("AXMenu")
    })
}

impl Accessibility for MacAccessibility {
    fn available(&self) -> Result<(), String> {
        if trusted() {
            return Ok(());
        }
        prompt_trust();
        Err("accessibility_permission_required: allow Mixdog under System Settings > Privacy & Security > Accessibility, then retry".into())
    }

    fn snapshot(&self, window: &WindowInfo, _include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String> {
        let pid = window.pid as i32;
        self.enable_app(pid);
        let root = windows::ax_window(pid, window.handle)
            .ok_or_else(|| format!("window has no accessibility root: {} {}", window.id(), window.title))?;
        let attributes: CFArray<CFString> = CFArray::from_CFTypes(&ATTRIBUTES.iter().map(|name| CFString::new(name)).collect::<Vec<_>>());
        let mut nodes = Vec::new();
        let mut stack: Vec<(CFType, u32)> = menu_children(&root.element).into_iter().rev().map(|child| (child, 1)).collect();
        while let Some((element, depth)) = stack.pop() {
            if nodes.len() >= limit {
                break;
            }
            let Some(values) = ax_copy_many(element.as_CFTypeRef(), &attributes) else { continue };
            let children = children_of(&values);
            let node = self.node(element, &values, pid, window.handle);
            if node.role != "Custom" || !node.name.is_empty() {
                nodes.push(node);
            }
            if depth < 64 {
                stack.extend(children.into_iter().rev().map(|child| (child, depth + 1)));
            }
        }
        Ok(nodes)
    }

    fn focused_masked(&self) -> bool {
        if !trusted() {
            return true;
        }
        // SAFETY: returns a +1 system-wide AX element.
        let system = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateSystemWide()) };
        let Ok(focused) = ax_copy(system.as_CFTypeRef(), "AXFocusedUIElement") else { return true };
        let role = ax_copy(focused.as_CFTypeRef(), "AXRole").ok().and_then(|value| as_string(&value)).unwrap_or_default();
        let subrole = ax_copy(focused.as_CFTypeRef(), "AXSubrole").ok().and_then(|value| as_string(&value)).unwrap_or_default();
        role.contains("Secure") || subrole.contains("Secure")
    }

    /// Menus belong to the application's menu bar; each level is matched by
    /// its label and the final item is pressed without opening any menu.
    fn invoke_menu(&self, window: &WindowInfo, path: &[String], authorize: &dyn Fn() -> Result<(), String>) -> Result<MenuOutcome, String> {
        let app = application(window.pid as i32);
        let bar = ax_copy(app.as_CFTypeRef(), "AXMenuBar").map_err(|_| "menu_path_not_found: this application exposes no menu bar".to_string())?;
        let mut items = menu_children(&bar);
        let mut walked: Vec<String> = Vec::new();
        for (index, segment) in path.iter().enumerate() {
            let wanted = normalize_menu_label(segment);
            let matches: Vec<CFType> = items.iter().filter(|item| normalize_menu_label(&title_of(item)) == wanted).cloned().collect();
            if matches.is_empty() {
                let available: Vec<String> = items.iter().map(title_of).filter(|title| !title.trim().is_empty()).take(20).collect();
                return Err(format!(
                    "menu_path_not_found: no menu entry named '{segment}' after {}; entries: {}",
                    walked.join(" > "),
                    available.join(", ")
                ));
            }
            if matches.len() > 1 {
                return Err(format!("menu_path_ambiguous: '{segment}' matched {} entries; use a more exact path", matches.len()));
            }
            let item = &matches[0];
            if !enabled_of(item) {
                return Err(format!("menu_item_disabled: '{segment}' is disabled"));
            }
            walked.push(segment.clone());
            let submenu = submenu_of(item);
            if index + 1 < path.len() {
                let Some(submenu) = submenu else {
                    return Err(format!("menu_path_not_found: '{segment}' opens no submenu for '{}'", path[index + 1]));
                };
                items = menu_children(&submenu);
                continue;
            }
            if submenu.is_some() {
                return Err(format!("menu_item_not_invokable: '{segment}' opens a submenu; name one of its entries"));
            }
            authorize()?;
            let pressed = ["AXPress", "AXPick"].iter().any(|action| ax_perform(item.as_CFTypeRef(), action) == kAXErrorSuccess);
            if !pressed {
                return Err(format!("menu_item_not_invokable: '{segment}' exposes no menu action"));
            }
            return Ok(MenuOutcome { path: "a11y_menu", verified: false, message: format!("invoked menu path: {}", walked.join(" > ")) });
        }
        Err("menu path must have 1..8 segments".into())
    }
}
