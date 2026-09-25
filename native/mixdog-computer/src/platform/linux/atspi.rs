//! The accessibility tree over AT-SPI's D-Bus interfaces, mapped into the
//! shared role vocabulary.

use crate::a11y::{format_value, normalize_menu_label, Element, MenuOutcome, Node};
use crate::obj;
use crate::platform::{WindowInfo, Wid};
use crate::protocol::Obj;
use serde_json::json;
use std::collections::HashMap;
use std::rc::Rc;
use zbus::blocking::Connection;
use zbus::zvariant::{DynamicType, OwnedObjectPath, OwnedValue, Type, Value};

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const ACTION: &str = "org.a11y.atspi.Action";
const TEXT: &str = "org.a11y.atspi.Text";
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
const VALUE: &str = "org.a11y.atspi.Value";
const SELECTION: &str = "org.a11y.atspi.Selection";
const COLLECTION: &str = "org.a11y.atspi.Collection";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

// AtspiStateType bits.
const STATE_ACTIVE: u32 = 1;
const STATE_CHECKED: u32 = 4;
const STATE_DEFUNCT: u32 = 6;
const STATE_EDITABLE: u32 = 7;
const STATE_ENABLED: u32 = 8;
const STATE_EXPANDABLE: u32 = 9;
const STATE_EXPANDED: u32 = 10;
const STATE_FOCUSED: u32 = 12;
const STATE_PRESSED: u32 = 20;
const STATE_SELECTABLE: u32 = 22;
const STATE_SELECTED: u32 = 23;
const STATE_SENSITIVE: u32 = 24;
const STATE_SHOWING: u32 = 25;
const STATE_INDETERMINATE: u32 = 32;
const STATE_CHECKABLE: u32 = 41;

const ROLE_CHECK_BOX: u32 = 7;
const ROLE_CHECK_MENU_ITEM: u32 = 8;
const ROLE_MENU: u32 = 33;
const ROLE_MENU_BAR: u32 = 34;
const ROLE_MENU_ITEM: u32 = 35;
const ROLE_PASSWORD_TEXT: u32 = 40;
const ROLE_POPUP_MENU: u32 = 41;
const ROLE_RADIO_MENU_ITEM: u32 = 45;
const ROLE_SCROLL_BAR: u32 = 48;
const ROLE_TOGGLE_BUTTON: u32 = 62;

pub fn role_of(role: u32) -> &'static str {
    match role {
        43 | 62 => "Button",
        7 => "CheckBox",
        44 => "RadioButton",
        11 => "ComboBox",
        61 | 40 | 79 | 77 | 76 | 60 => "Edit",
        31 | 98 => "List",
        32 => "ListItem",
        8 | 33 | 35 | 45 | 59 => "MenuItem",
        37 => "TabItem",
        88 => "Hyperlink",
        65 | 66 => "Tree",
        91 => "TreeItem",
        90 | 56 => "DataItem",
        51 => "Slider",
        52 => "Spinner",
        82 | 92 | 93 | 94 | 95 | 96 => "Document",
        29 | 116 | 83 | 73 | 81 => "Text",
        39 | 20 | 85 | 99 | 87 | 109 | 110 => "Group",
        49 | 68 | 53 => "Pane",
        27 | 26 => "Image",
        55 => "Table",
        10 | 57 | 58 | 47 => "HeaderItem",
        71 => "Header",
        42 | 103 => "ProgressBar",
        54 => "StatusBar",
        63 => "ToolBar",
        104 => "TitleBar",
        50 => "Separator",
        23 | 16 | 69 | 2 => "Window",
        34 => "MenuBar",
        38 => "Tab",
        _ => "Custom",
    }
}

fn has(states: &[u32], bit: u32) -> bool {
    states.get((bit / 32) as usize).is_some_and(|word| word & (1 << (bit % 32)) != 0)
}

#[derive(Clone)]
pub struct Atspi {
    bus: Connection,
}

pub type Ref = (String, OwnedObjectPath);

impl Atspi {
    pub fn connect() -> Result<Atspi, String> {
        let session = Connection::session().map_err(|error| format!("accessibility_unavailable: no session bus ({error})"))?;
        // Toolkits build their trees only once an assistive client is announced.
        let _ = session.call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some(PROPERTIES), "Set", &("org.a11y.Status", "IsEnabled", Value::from(true)));
        let address: String = session
            .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
            .map_err(|error| format!("accessibility_unavailable: the AT-SPI bus is not running ({error}); install at-spi2-core"))?
            .body()
            .deserialize()
            .map_err(|error| error.to_string())?;
        let bus = zbus::blocking::connection::Builder::address(address.as_str())
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| format!("accessibility_unavailable: {error}"))?;
        Ok(Atspi { bus })
    }

    fn call<B, R>(&self, node: &Ref, interface: &str, method: &str, body: &B) -> Result<R, String>
    where
        B: serde::Serialize + DynamicType,
        R: for<'d> serde::Deserialize<'d> + Type,
    {
        let reply = self
            .bus
            .call_method(Some(node.0.as_str()), node.1.as_str(), Some(interface), method, body)
            .map_err(|error| error.to_string())?;
        reply.body().deserialize::<R>().map_err(|error| error.to_string())
    }

    fn property(&self, node: &Ref, interface: &str, name: &str) -> Result<OwnedValue, String> {
        self.call(node, PROPERTIES, "Get", &(interface, name))
    }

    fn string_property(&self, node: &Ref, interface: &str, name: &str) -> String {
        self.property(node, interface, name).ok().and_then(|value| String::try_from(value).ok()).unwrap_or_default()
    }

    fn f64_property(&self, node: &Ref, interface: &str, name: &str) -> Option<f64> {
        self.property(node, interface, name).ok().and_then(|value| f64::try_from(value).ok())
    }

    pub fn children(&self, node: &Ref) -> Vec<Ref> {
        self.call::<_, Vec<(String, OwnedObjectPath)>>(node, ACCESSIBLE, "GetChildren", &()).unwrap_or_default()
    }

    pub fn role(&self, node: &Ref) -> Option<u32> {
        self.call(node, ACCESSIBLE, "GetRole", &()).ok()
    }

    pub fn states(&self, node: &Ref) -> Vec<u32> {
        self.call(node, ACCESSIBLE, "GetState", &()).unwrap_or_default()
    }

    fn interfaces(&self, node: &Ref) -> Vec<String> {
        self.call(node, ACCESSIBLE, "GetInterfaces", &()).unwrap_or_default()
    }

    pub fn name(&self, node: &Ref) -> String {
        self.string_property(node, ACCESSIBLE, "Name")
    }

    fn extents(&self, node: &Ref) -> Option<(i32, i32, i32, i32)> {
        self.call(node, COMPONENT, "GetExtents", &(0u32,)).ok()
    }

    fn parent(&self, node: &Ref) -> Option<Ref> {
        let value = self.property(node, ACCESSIBLE, "Parent").ok()?;
        let parent = <(String, OwnedObjectPath)>::try_from(value).ok()?;
        (parent.1.as_str() != "/org/a11y/atspi/null").then_some(parent)
    }

    fn pid_of(&self, bus_name: &str) -> Option<u32> {
        self.bus
            .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetConnectionUnixProcessID", &(bus_name,))
            .ok()?
            .body()
            .deserialize()
            .ok()
    }

    /// The accessible frame for a native window: the window's application,
    /// matched by process, then its frame by title and geometry.
    pub fn frame_for(&self, window: &WindowInfo) -> Result<Ref, String> {
        let root: Ref = ("org.a11y.atspi.Registry".into(), OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root").map_err(|error| error.to_string())?);
        let apps: Vec<Ref> = self.children(&root).into_iter().filter(|app| self.pid_of(&app.0) == Some(window.pid as u32)).collect();
        let mut best: Option<(i64, Ref)> = None;
        for app in &apps {
            for frame in self.children(app) {
                let mut score = 0i64;
                if self.name(&frame) == window.title {
                    score += 1_000_000;
                }
                if let Some((x, y, width, height)) = self.extents(&frame) {
                    let distance = (x - window.x).abs() + (y - window.y).abs() + (width - window.width).abs() + (height - window.height).abs();
                    score -= distance as i64;
                }
                if has(&self.states(&frame), STATE_ACTIVE) && window.focused {
                    score += 1000;
                }
                if best.as_ref().is_none_or(|(current, _)| score > *current) {
                    best = Some((score, frame));
                }
            }
        }
        best.map(|(_, frame)| frame).ok_or_else(|| {
            format!("window has no accessibility root: {} {} (the application exposes no AT-SPI tree)", window.id(), window.title)
        })
    }

    fn actions(&self, node: &Ref) -> Vec<String> {
        self.call::<_, Vec<(String, String, String)>>(node, ACTION, "GetActions", &())
            .map(|actions| actions.into_iter().map(|(name, _, _)| name.to_lowercase()).collect())
            .unwrap_or_default()
    }

    fn do_action(&self, node: &Ref, preferred: &[&str]) -> Result<(), String> {
        let actions = self.actions(node);
        if actions.is_empty() {
            return Err("a11y_action_failed: element exposes no action".into());
        }
        let index = preferred.iter().find_map(|wanted| actions.iter().position(|name| name == wanted)).unwrap_or(0);
        let done: bool = self.call(node, ACTION, "DoAction", &(index as i32,))?;
        done.then_some(()).ok_or_else(|| format!("a11y_action_failed: '{}' was refused", actions[index]))
    }

    /// Whether the focused element under `frame` hides what is typed.
    pub fn focused_masked(&self, frame: &Ref) -> bool {
        let focused_word = 1i32 << STATE_FOCUSED;
        let rule = (vec![focused_word, 0], 1i32, HashMap::<String, String>::new(), 1i32, Vec::<i32>::new(), 1i32, Vec::<String>::new(), 1i32, false);
        match self.call::<_, Vec<(String, OwnedObjectPath)>>(frame, COLLECTION, "GetMatches", &(rule, 0u32, 1i32, true)) {
            Ok(found) => match found.first() {
                Some(node) => self.role(node).is_none_or(|role| role == ROLE_PASSWORD_TEXT),
                None => false,
            },
            Err(_) => true,
        }
    }

    pub fn snapshot(&self, window: &WindowInfo, include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String> {
        let frame = self.frame_for(window)?;
        let mut nodes = Vec::new();
        let mut stack: Vec<(Ref, u32)> = self.children(&frame).into_iter().rev().map(|child| (child, 1)).collect();
        while let Some((node, depth)) = stack.pop() {
            if nodes.len() >= limit {
                break;
            }
            let Some(role_number) = self.role(&node) else { continue };
            let states = self.states(&node);
            if !has(&states, STATE_SHOWING) || has(&states, STATE_DEFUNCT) {
                continue;
            }
            let role = role_of(role_number);
            let emitted = crate::a11y::is_interactive(role) || include_noninteractive || role == "Text";
            if emitted {
                if let Some(built) = self.node(&node, role_number, &states, window.handle) {
                    nodes.push(built);
                }
            }
            if depth < 64 {
                stack.extend(self.children(&node).into_iter().rev().map(|child| (child, depth + 1)));
            }
        }
        Ok(nodes)
    }

    fn node(&self, reference: &Ref, role_number: u32, states: &[u32], window: Wid) -> Option<Node> {
        let (x, y, width, height) = self.extents(reference)?;
        let role = role_of(role_number);
        let interfaces = self.interfaces(reference);
        let name = self.name(reference);
        let element = AtspiElement { atspi: self.clone(), node: reference.clone(), window, role: role_number };
        let toggleable = element.toggleable(states);
        let toggle = if toggleable { toggle_label(states) } else { String::new() };
        let value = if matches!(role, "Edit" | "ComboBox" | "Document") { element.value().unwrap_or_default() } else { String::new() };
        let range = if matches!(role, "Slider" | "Spinner" | "ProgressBar") && interfaces.iter().any(|name| name == VALUE) {
            self.f64_property(reference, VALUE, "CurrentValue").map(|value| format!("{value}")).unwrap_or_default()
        } else {
            String::new()
        };
        let enabled = has(states, STATE_ENABLED) || has(states, STATE_SENSITIVE);
        let can_set_value = (interfaces.iter().any(|name| name == EDITABLE_TEXT) && has(states, STATE_EDITABLE)) || (!range.is_empty() && role != "ProgressBar");
        Some(Node {
            element: Rc::new(element),
            role: role.to_string(),
            name,
            automation_id: String::new(),
            value,
            toggle: toggle.clone(),
            selected: if has(states, STATE_SELECTABLE) { if has(states, STATE_SELECTED) { "True" } else { "False" }.into() } else { String::new() },
            expanded: if has(states, STATE_EXPANDABLE) { if has(states, STATE_EXPANDED) { "Expanded" } else { "Collapsed" }.into() } else { String::new() },
            range,
            accelerator: String::new(),
            can_invoke: interfaces.iter().any(|name| name == ACTION),
            can_set_value,
            can_toggle: toggleable,
            can_scroll: role == "Pane",
            enabled,
            offscreen: false,
            x: x as f64,
            y: y as f64,
            width: width as f64,
            height: height as f64,
        })
    }

    fn menu_bar(&self, frame: &Ref) -> Option<Ref> {
        let mut queue = vec![(frame.clone(), 0)];
        while let Some((node, depth)) = queue.pop() {
            if self.role(&node) == Some(ROLE_MENU_BAR) {
                return Some(node);
            }
            if depth < 5 {
                queue.extend(self.children(&node).into_iter().map(|child| (child, depth + 1)));
            }
        }
        None
    }

    /// The entries one level down from a menu item.
    fn submenu_items(&self, item: &Ref) -> Vec<Ref> {
        let children = self.children(item);
        let nested = children.iter().find(|child| matches!(self.role(child), Some(ROLE_MENU) | Some(ROLE_POPUP_MENU)));
        match nested {
            Some(menu) if self.role(item) != Some(ROLE_MENU) => self.children(menu),
            _ => children,
        }
    }

    fn is_menu_entry(&self, node: &Ref) -> bool {
        matches!(self.role(node), Some(ROLE_MENU) | Some(ROLE_MENU_ITEM) | Some(ROLE_CHECK_MENU_ITEM) | Some(ROLE_RADIO_MENU_ITEM))
    }

    pub fn invoke_menu(&self, window: &WindowInfo, path: &[String], authorize: &dyn Fn() -> Result<(), String>) -> Result<MenuOutcome, String> {
        let frame = self.frame_for(window)?;
        let bar = self.menu_bar(&frame).ok_or_else(|| "menu_path_not_found: this window exposes no menu bar".to_string())?;
        let mut items: Vec<Ref> = self.children(&bar);
        let mut walked: Vec<String> = Vec::new();
        for (index, segment) in path.iter().enumerate() {
            let wanted = normalize_menu_label(segment);
            let matches: Vec<Ref> = items.iter().filter(|item| self.is_menu_entry(item) && normalize_menu_label(&self.name(item)) == wanted).cloned().collect();
            if matches.is_empty() {
                let available: Vec<String> = items.iter().map(|item| self.name(item)).filter(|name| !name.trim().is_empty()).take(20).collect();
                return Err(format!("menu_path_not_found: no menu entry named '{segment}' after {}; entries: {}", walked.join(" > "), available.join(", ")));
            }
            if matches.len() > 1 {
                return Err(format!("menu_path_ambiguous: '{segment}' matched {} entries; use a more exact path", matches.len()));
            }
            let item = &matches[0];
            let states = self.states(item);
            if !(has(&states, STATE_ENABLED) || has(&states, STATE_SENSITIVE)) {
                return Err(format!("menu_item_disabled: '{segment}' is disabled"));
            }
            walked.push(segment.clone());
            let opens = self.role(item) == Some(ROLE_MENU);
            if index + 1 < path.len() {
                if !opens {
                    return Err(format!("menu_path_not_found: '{segment}' opens no submenu for '{}'", path[index + 1]));
                }
                items = self.submenu_items(item);
                continue;
            }
            if opens {
                return Err(format!("menu_item_not_invokable: '{segment}' opens a submenu; name one of its entries"));
            }
            authorize()?;
            self.do_action(item, &["click", "activate", "press"])
                .map_err(|error| format!("menu_item_not_invokable: '{segment}': {error}"))?;
            return Ok(MenuOutcome { path: "a11y_menu", verified: false, message: format!("invoked menu path: {}", walked.join(" > ")) });
        }
        Err("menu path must have 1..8 segments".into())
    }
}

fn toggle_label(states: &[u32]) -> String {
    if has(states, STATE_INDETERMINATE) {
        "Indeterminate".into()
    } else if has(states, STATE_CHECKED) || has(states, STATE_PRESSED) {
        "On".into()
    } else {
        "Off".into()
    }
}

pub struct AtspiElement {
    atspi: Atspi,
    node: Ref,
    window: Wid,
    role: u32,
}

impl AtspiElement {
    fn toggleable(&self, states: &[u32]) -> bool {
        matches!(self.role, ROLE_CHECK_BOX | ROLE_TOGGLE_BUTTON | ROLE_CHECK_MENU_ITEM) || has(states, STATE_CHECKABLE)
    }
    fn has_interface(&self, name: &str) -> bool {
        self.atspi.interfaces(&self.node).iter().any(|interface| interface == name)
    }
}

impl Element for AtspiElement {
    fn identity(&self) -> String {
        format!("{}{}", self.node.0, self.node.1.as_str())
    }
    fn window(&self) -> Wid {
        self.window
    }
    fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        self.atspi.extents(&self.node).map(|(x, y, width, height)| (x as f64, y as f64, width as f64, height as f64))
    }
    fn enabled(&self) -> bool {
        let states = self.atspi.states(&self.node);
        has(&states, STATE_ENABLED) || has(&states, STATE_SENSITIVE)
    }
    fn alive(&self) -> bool {
        self.atspi.role(&self.node).is_some() && !has(&self.atspi.states(&self.node), STATE_DEFUNCT)
    }
    fn press(&self) -> Result<(), String> {
        self.atspi.do_action(&self.node, &["click", "press", "activate", "jump", "toggle", "open"])
    }
    fn can_press(&self) -> bool {
        !self.atspi.actions(&self.node).is_empty()
    }
    fn toggle_state(&self) -> Option<String> {
        let states = self.atspi.states(&self.node);
        self.toggleable(&states).then(|| toggle_label(&states))
    }
    fn expand_state(&self) -> Option<String> {
        let states = self.atspi.states(&self.node);
        has(&states, STATE_EXPANDABLE).then(|| if has(&states, STATE_EXPANDED) { "Expanded" } else { "Collapsed" }.to_string())
    }
    fn set_expanded(&self, _expanded: bool) -> Result<(), String> {
        self.atspi.do_action(&self.node, &["expand or contract", "toggle", "activate", "click"])
    }
    fn value(&self) -> Option<String> {
        if self.has_interface(TEXT) {
            return self.atspi.call::<_, String>(&self.node, TEXT, "GetText", &(0i32, -1i32)).ok();
        }
        self.atspi.f64_property(&self.node, VALUE, "CurrentValue").map(|value| format!("{value}"))
    }
    fn settable(&self) -> bool {
        let interfaces = self.atspi.interfaces(&self.node);
        (interfaces.iter().any(|name| name == EDITABLE_TEXT) && has(&self.atspi.states(&self.node), STATE_EDITABLE))
            || (interfaces.iter().any(|name| name == VALUE) && role_of(self.role) != "ProgressBar")
    }
    fn set_value(&self, text: &str) -> Result<(), String> {
        if self.has_interface(EDITABLE_TEXT) {
            let done: bool = self.atspi.call(&self.node, EDITABLE_TEXT, "SetTextContents", &(text,))?;
            return done.then_some(()).ok_or_else(|| "a11y_value_failed: the text was refused".to_string());
        }
        let number: f64 = text.trim().parse().map_err(|_| format!("a11y_value_failed: '{text}' is not a number for this control"))?;
        self.atspi.call::<_, ()>(&self.node, PROPERTIES, "Set", &(VALUE, "CurrentValue", Value::from(number)))
    }
    fn can_select(&self) -> bool {
        has(&self.atspi.states(&self.node), STATE_SELECTABLE)
    }
    fn select(&self) -> Result<(), String> {
        let parent = self.atspi.parent(&self.node).ok_or("a11y_action_failed: element has no parent to select it in")?;
        let index: i32 = self.atspi.call(&self.node, ACCESSIBLE, "GetIndexInParent", &())?;
        let done: bool = self.atspi.call(&parent, SELECTION, "SelectChild", &(index,))?;
        done.then_some(()).ok_or_else(|| "a11y_action_failed: selection was refused".to_string())
    }
    fn focus(&self) -> Result<(), String> {
        let done: bool = self.atspi.call(&self.node, COMPONENT, "GrabFocus", &())?;
        done.then_some(()).ok_or_else(|| "focus was refused".to_string())
    }
    fn scroll(&self, horizontal: bool, increments: i32) -> Result<Option<(String, String)>, String> {
        let bars: Vec<Ref> = self.atspi.children(&self.node).into_iter().filter(|child| self.atspi.role(child) == Some(ROLE_SCROLL_BAR)).collect();
        for bar in bars {
            let vertical = has(&self.atspi.states(&bar), 29);
            if vertical == horizontal {
                continue;
            }
            let (Some(before), Some(minimum), Some(maximum)) = (
                self.atspi.f64_property(&bar, VALUE, "CurrentValue"),
                self.atspi.f64_property(&bar, VALUE, "MinimumValue"),
                self.atspi.f64_property(&bar, VALUE, "MaximumValue"),
            ) else {
                continue;
            };
            let step = ((maximum - minimum) * 0.05).max(1.0);
            let target = (before + increments as f64 * step).clamp(minimum, maximum);
            self.atspi.call::<_, ()>(&bar, PROPERTIES, "Set", &(VALUE, "CurrentValue", Value::from(target)))?;
            let after = self.atspi.f64_property(&bar, VALUE, "CurrentValue").unwrap_or(before);
            return Ok(Some((format!("{before}"), format!("{after}"))));
        }
        Ok(None)
    }
    fn structure(&self) -> Obj {
        let mut ancestors = Vec::new();
        let mut parent_id = String::new();
        let mut in_document = false;
        let mut current = self.atspi.parent(&self.node);
        for depth in 0..80 {
            let Some(parent) = current else { break };
            let role = self.atspi.role(&parent).unwrap_or(0);
            if role == 75 {
                break;
            }
            let id = format!("{}{}", parent.0, parent.1.as_str());
            if depth == 0 {
                parent_id = id.clone();
            }
            if role_of(role) == "Document" {
                in_document = true;
            }
            ancestors.push(json!({ "runtime_id": id, "role": role_of(role), "name": format_value(&self.atspi.name(&parent), 200) }));
            current = self.atspi.parent(&parent);
        }
        obj! {
            "runtime_id" => self.identity(),
            "parent_runtime_id" => parent_id,
            "class_name" => role_of(self.role),
            "has_keyboard_focus" => has(&self.atspi.states(&self.node), STATE_FOCUSED),
            "in_document" => in_document,
            "ancestors" => ancestors,
        }
    }
    fn range_value(&self) -> Option<String> {
        self.atspi.f64_property(&self.node, VALUE, "CurrentValue").map(|value| format!("{value}"))
    }
}
