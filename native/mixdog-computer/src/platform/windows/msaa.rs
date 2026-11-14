//! The MSAA (oleacc) tree of a window, for the controls UI Automation leaves
//! out (MixMsaa.cs). msaa-enrichment and msaa-menu read it.

use super::native::hwnd;
use crate::platform::Wid;
use std::collections::HashMap;
use windows::core::{IUnknown, Interface, BSTR};
use windows::Win32::System::Com::IDispatch;
use windows::Win32::System::Variant::{VARIANT, VT_DISPATCH, VT_EMPTY, VT_UNKNOWN};
use windows::Win32::UI::Accessibility::{
    AccessibleChildren, AccessibleObjectFromWindow, GetRoleTextW, GetStateTextW, IAccessible,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenu, CHILDID_SELF, OBJID_CLIENT, OBJID_MENU, STATE_SYSTEM_PROTECTED, STATE_SYSTEM_READONLY,
};

/// The most nodes one walk may be asked for (SnapshotObject).
pub const MAXIMUM: usize = 5000;
const DEPTH_LIMIT: usize = 64;
const BATCH: i32 = 256;
const SELF: i32 = CHILDID_SELF as i32;
// Win32_UI_Controls owns these three names, and the build does not enable it.
const STATE_SYSTEM_UNAVAILABLE: u32 = 0x1;
const STATE_SYSTEM_INVISIBLE: u32 = 0x8000;
const STATE_SYSTEM_OFFSCREEN: u32 = 0x10000;

/// What one read of an accessible object, or of one of its simple children,
/// returns (the properties MixMsaaNode.Refresh reads).
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Reading {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub name: String,
    pub value: String,
    pub description: String,
    pub role: u32,
    pub state: u32,
    pub default_action: String,
}

/// A child slot of an accessible object.
pub(super) enum Child<A> {
    /// A child that is an accessible object of its own.
    Object(A),
    /// A child the container answers for, under this child id.
    Simple(i32),
    /// A slot that names neither.
    Unreadable,
}

/// The part of IAccessible a walk reads; a fake tree stands in for it in
/// tests.
pub(super) trait AccNode: Clone {
    /// Equal for two references to the same object.
    fn identity(&self) -> usize;
    /// The properties of `child` (0 is the object itself); `None` when its
    /// location cannot be read.
    fn read(&self, child: i32) -> Option<Reading>;
    /// The state flags of `child` alone; `None` when they cannot be read.
    fn state(&self, child: i32) -> Option<u32>;
    fn child_count(&self) -> Option<i32>;
    /// Runs the default action of `child` (accDoDefaultAction).
    fn do_default_action(&self, child: i32) -> Result<(), String>;
    /// Writes the value of `child` (put_accValue).
    fn put_value(&self, child: i32, value: &str) -> Result<(), String>;
    /// Up to `count` child slots from `start`; fewer when the object has no
    /// more to give.
    fn children(&self, start: i32, count: usize) -> Result<Vec<Child<Self>>, String>;
}

fn text(value: windows::core::Result<BSTR>) -> String {
    value.map(|text| text.to_string()).unwrap_or_default()
}

/// A numeric property; `None` when the provider gave none.
fn number(value: windows::core::Result<VARIANT>) -> Option<u32> {
    let value = value.ok()?;
    if value.vt() == VT_EMPTY {
        return None;
    }
    u32::try_from(&value).ok()
}

impl AccNode for IAccessible {
    fn identity(&self) -> usize {
        // The IUnknown pointer is the COM identity (MixMsaa.Identity).
        self.cast::<IUnknown>()
            .map_or(self.as_raw() as usize, |unknown| unknown.as_raw() as usize)
    }

    fn read(&self, child: i32) -> Option<Reading> {
        let id = VARIANT::from(child);
        let (mut x, mut y, mut w, mut h) = (0, 0, 0, 0);
        // SAFETY: property reads on a live object; the out pointers are locals.
        unsafe {
            self.accLocation(&mut x, &mut y, &mut w, &mut h, &id).ok()?;
            Some(Reading {
                x,
                y,
                w: w.max(0),
                h: h.max(0),
                name: text(self.get_accName(&id)),
                value: text(self.get_accValue(&id)),
                description: text(self.get_accDescription(&id)),
                role: number(self.get_accRole(&id)).unwrap_or(0),
                state: number(self.get_accState(&id)).unwrap_or(0),
                default_action: text(self.get_accDefaultAction(&id)),
            })
        }
    }

    fn state(&self, child: i32) -> Option<u32> {
        // SAFETY: a property read on a live object.
        number(unsafe { self.get_accState(&VARIANT::from(child)) })
    }

    fn child_count(&self) -> Option<i32> {
        // SAFETY: a property read on a live object.
        unsafe { self.accChildCount() }.ok()
    }

    fn do_default_action(&self, child: i32) -> Result<(), String> {
        // SAFETY: a call on a live object.
        unsafe { self.accDoDefaultAction(&VARIANT::from(child)) }.map_err(|error| error.message())
    }

    fn put_value(&self, child: i32, value: &str) -> Result<(), String> {
        // SAFETY: a call on a live object.
        unsafe { self.put_accValue(&VARIANT::from(child), &BSTR::from(value)) }
            .map_err(|error| error.message())
    }

    fn children(&self, start: i32, count: usize) -> Result<Vec<Child<Self>>, String> {
        let mut slots = vec![VARIANT::default(); count];
        let mut obtained = 0;
        // SAFETY: `slots` is as long as the count passed with it.
        unsafe { AccessibleChildren(self, start, &mut slots, &mut obtained) }
            .map_err(|error| error.to_string())?;
        slots.truncate(usize::try_from(obtained).unwrap_or(0));
        Ok(slots.iter().map(child_of).collect())
    }
}

/// A VT_DISPATCH child is an object, a VT_I4 one a simple child (Traverse).
fn child_of(slot: &VARIANT) -> Child<IAccessible> {
    let kind = slot.vt();
    let object = if kind == VT_DISPATCH {
        IDispatch::try_from(slot).and_then(|object| object.cast::<IAccessible>())
    } else if kind == VT_UNKNOWN {
        IUnknown::try_from(slot).and_then(|object| object.cast::<IAccessible>())
    } else if kind == VT_EMPTY {
        // Traverse turned an empty slot into CHILDID_SELF and listed the
        // container again; an empty slot is unreadable here.
        return Child::Unreadable;
    } else {
        return i32::try_from(slot).map_or(Child::Unreadable, Child::Simple);
    };
    object.map_or(Child::Unreadable, Child::Object)
}

/// One accessible object of a walk (MixMsaaNode): the object or, for a simple
/// child, its container and child id, with what the last refresh read.
#[derive(Clone)]
pub struct MsaaNode<A = IAccessible> {
    pub(super) acc: A,
    pub(super) child: i32,
    /// The path from the root, such as 0/3/1.
    #[allow(dead_code, reason = "msaa-semantic-actions reads it")]
    pub(super) key: String,
    pub(super) window: Wid,
    #[allow(dead_code, reason = "msaa-semantic-actions reads it")]
    pub(super) window_id: String,
    pub(super) name: String,
    pub(super) value: String,
    pub(super) description: String,
    pub(super) role: u32,
    pub(super) state: u32,
    pub(super) default_action: String,
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) w: i32,
    pub(super) h: i32,
}

impl<A: AccNode> MsaaNode<A> {
    pub(super) fn new(acc: A, child: i32, key: String, window: Wid, window_id: &str) -> Self {
        Self {
            acc,
            child,
            key,
            window,
            window_id: window_id.to_string(),
            name: String::new(),
            value: String::new(),
            description: String::new(),
            role: 0,
            state: 0,
            default_action: String::new(),
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        }
    }

    /// Reads the node again; false when it cannot be read or has no area
    /// (MixMsaaNode.Refresh). A failed read leaves the last one in place.
    pub(super) fn refresh(&mut self) -> bool {
        let Some(read) = self.acc.read(self.child) else {
            return false;
        };
        self.x = read.x;
        self.y = read.y;
        self.w = read.w;
        self.h = read.h;
        self.name = read.name;
        self.value = read.value;
        self.description = read.description;
        self.role = read.role;
        self.state = read.state;
        self.default_action = read.default_action;
        self.w > 0 && self.h > 0
    }

    /// Runs the node's default action as last read; refused when it exposes
    /// none (MixMsaaNode.DoDefaultAction, after its refresh).
    pub(super) fn do_default_action(&self) -> Result<(), String> {
        if self.default_action.trim().is_empty() {
            return Err("MSAA element exposes no default action".into());
        }
        self.acc.do_default_action(self.child)
    }

    pub(super) fn enabled(&self) -> bool {
        self.state & STATE_SYSTEM_UNAVAILABLE == 0
    }

    /// The element shows a value it lets nobody edit.
    pub(super) fn read_only(&self) -> bool {
        self.state & STATE_SYSTEM_READONLY != 0
    }

    pub(super) fn offscreen(&self) -> bool {
        self.state & (STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN) != 0
    }

    /// Hidden, not merely scrolled away: a closed drop-down list or a
    /// collapsed dialog section, whose descendants often do not repeat the
    /// flag.
    pub(super) fn invisible(&self) -> bool {
        self.state & STATE_SYSTEM_INVISIBLE != 0
    }

    pub(super) fn control_type(&self) -> &'static str {
        control_type_for_role(self.role)
    }

    /// Whether the node, read now, hides what is typed into it
    /// (MixMsaaNode.IsProtected).
    pub(super) fn is_protected(&self) -> bool {
        protected(self.acc.state(self.child))
    }
}

/// A state that cannot be read counts as protected: only a readable state
/// without PROTECTED is not a password.
fn protected(state: Option<u32>) -> bool {
    state.is_none_or(|state| state & STATE_SYSTEM_PROTECTED != 0)
}

struct Walk<'a, A> {
    window: Wid,
    window_id: &'a str,
    maximum: usize,
    nodes: Vec<MsaaNode<A>>,
    /// Every object met, kept alive for the walk: the address of a released
    /// COM identity can be reused by a different element.
    visited: HashMap<usize, A>,
    complete: bool,
}

impl<A: AccNode> Walk<'_, A> {
    /// Adds the node when it can be read and has an area; returns whether it
    /// is invisible.
    fn add(&mut self, acc: &A, child: i32, key: String) -> bool {
        let mut node = MsaaNode::new(acc.clone(), child, key, self.window, self.window_id);
        let counted = node.refresh();
        let invisible = node.invisible();
        if counted {
            self.nodes.push(node);
        } else {
            self.complete = false;
        }
        invisible
    }

    /// MixMsaa.Traverse.
    fn traverse(&mut self, acc: &A, path: &str, depth: usize, include_self: bool) -> Result<(), String> {
        if depth > DEPTH_LIMIT {
            return Err(format!("MSAA tree depth exceeds {DEPTH_LIMIT}"));
        }
        let identity = acc.identity();
        if self.visited.contains_key(&identity) {
            return Ok(());
        }
        self.visited.insert(identity, acc.clone());
        if include_self {
            if self.nodes.len() >= self.maximum {
                self.complete = false;
                return Ok(());
            }
            if self.add(acc, SELF, path.to_string()) {
                return Ok(());
            }
        }
        let Some(count) = acc.child_count() else {
            self.complete = false;
            return Ok(());
        };
        let mut start = 0;
        while start < count && self.nodes.len() < self.maximum {
            let children = acc.children(start, (count - start).min(BATCH) as usize)?;
            if children.is_empty() {
                self.complete = false;
                break;
            }
            for (index, child) in (start..).zip(&children) {
                if self.nodes.len() >= self.maximum {
                    self.complete = false;
                    break;
                }
                let key = format!("{path}/{index}");
                match child {
                    Child::Object(nested) => self.traverse(nested, &key, depth + 1, true)?,
                    Child::Simple(id) => {
                        self.add(acc, *id, key);
                    }
                    Child::Unreadable => self.complete = false,
                }
            }
            start += children.len() as i32;
        }
        if start < count {
            self.complete = false;
        }
        Ok(())
    }
}

/// The nodes under `root`, which is not one of them, and whether the walk was
/// complete (SnapshotObject).
fn walk<A: AccNode>(
    root: &A,
    window: Wid,
    window_id: &str,
    maximum: usize,
) -> Result<(Vec<MsaaNode<A>>, bool), String> {
    let mut walk = Walk {
        window,
        window_id,
        maximum,
        nodes: Vec::new(),
        visited: HashMap::new(),
        complete: true,
    };
    walk.traverse(root, "0", 0, false)?;
    Ok((walk.nodes, walk.complete))
}

/// SnapshotObject refuses a maximum out of range before asking the window.
fn check_maximum(maximum: usize) -> Result<(), String> {
    if !(1..=MAXIMUM).contains(&maximum) {
        return Err(format!("MSAA maximum must be 1..{MAXIMUM}"));
    }
    Ok(())
}

/// The accessible object `objid` of a window; `Ok(None)` when the window
/// answers without one.
fn object_from_window(window: Wid, objid: i32) -> windows::core::Result<Option<IAccessible>> {
    let mut raw = std::ptr::null_mut();
    // SAFETY: `raw` receives an owned IAccessible reference or stays null.
    unsafe {
        AccessibleObjectFromWindow(hwnd(window), objid as u32, &IAccessible::IID, &mut raw)?;
        Ok((!raw.is_null()).then(|| IAccessible::from_raw(raw)))
    }
}

/// Up to `maximum` nodes under `objid` (OBJID_CLIENT or OBJID_MENU) of
/// `hwnd`, and whether the walk was complete (MixMsaa.SnapshotObject).
pub fn snapshot(
    hwnd: Wid,
    window_id: &str,
    maximum: usize,
    objid: i32,
) -> Result<(Vec<MsaaNode>, bool), String> {
    if hwnd == 0 {
        return Err("MSAA window handle is required".into());
    }
    check_maximum(maximum)?;
    match object_from_window(hwnd, objid).map_err(|error| error.to_string())? {
        Some(root) => walk(&root, hwnd, window_id, maximum),
        None => Ok((Vec::new(), false)),
    }
}

/// The nodes of the window's own menu bar, which is not part of the client
/// tree; none when it has no menu (MixMsaa.MenuSnapshot).
pub fn menu_snapshot(window: Wid, window_id: &str, maximum: usize) -> Result<Vec<MsaaNode>, String> {
    // SAFETY: a plain window read.
    if unsafe { GetMenu(hwnd(window)) }.is_invalid() {
        return Ok(Vec::new());
    }
    snapshot(window, window_id, maximum, OBJID_MENU.0).map(|(nodes, _)| nodes)
}

/// Whether the window's client object is a protected (password) field
/// (MixMsaa.IsProtectedInput): UIA's IsPassword answers only for providers
/// that implement it, and this is the second opinion. A window that cannot be
/// read counts as protected; no window is not one.
pub fn is_protected_input(hwnd: Wid) -> Option<bool> {
    if hwnd == 0 {
        return Some(false);
    }
    let state = object_from_window(hwnd, OBJID_CLIENT.0)
        .ok()
        .flatten()
        .and_then(|client| client.state(SELF));
    Some(protected(state))
}

/// The system's text of a role or state flag, in the user's language.
fn system_text(read: impl FnOnce(&mut [u16]) -> u32) -> Option<String> {
    let mut buffer = [0u16; 128];
    let length = (read(&mut buffer) as usize).min(buffer.len());
    (length > 0).then(|| String::from_utf16_lossy(&buffer[..length]))
}

/// MixMsaa.RoleText.
pub fn role_text(role: u32) -> String {
    // SAFETY: the call writes at most the buffer's length.
    role_text_with(role, |role| system_text(|buffer| unsafe { GetRoleTextW(role, Some(buffer)) }))
}

/// MixMsaa.StateText.
pub fn state_text(state: u32) -> String {
    // SAFETY: the call writes at most the buffer's length.
    state_text_with(state, |flag| system_text(|buffer| unsafe { GetStateTextW(flag, Some(buffer)) }))
}

fn role_text_with(role: u32, lookup: impl Fn(u32) -> Option<String>) -> String {
    lookup(role).unwrap_or_else(|| role.to_string())
}

/// One text per set flag, lowest first; a flag the system has no text for
/// shows as hex.
fn state_text_with(state: u32, lookup: impl Fn(u32) -> Option<String>) -> String {
    if state == 0 {
        return "normal".into();
    }
    (0..32)
        .map(|bit| 1u32 << bit)
        .filter(|flag| state & flag != 0)
        .map(|flag| lookup(flag).unwrap_or_else(|| format!("0x{flag:X}")))
        .collect::<Vec<_>>()
        .join(",")
}

/// The UIA control type an MSAA role (oleacc.h) corresponds to
/// (MixMsaa.ControlTypeForRole).
pub fn control_type_for_role(role: u32) -> &'static str {
    match role {
        0x01 => "TitleBar",
        0x02 => "MenuBar",
        0x03 => "ScrollBar",
        0x09 => "Window",
        0x0A => "Client",
        0x0B => "Menu",
        0x0C => "MenuItem",
        0x0F => "Document",
        0x10 | 0x26 => "Pane",
        0x14 => "Group",
        0x15 => "Separator",
        0x16 => "ToolBar",
        0x17 => "StatusBar",
        0x18 => "Table",
        0x19 => "HeaderItem",
        0x1D => "DataItem",
        0x1E => "Hyperlink",
        0x21 => "List",
        0x22 => "ListItem",
        0x23 => "Tree",
        0x24 => "TreeItem",
        0x25 => "TabItem",
        0x28 => "Image",
        0x29 => "Text",
        0x2A | 0x32 | 0x3F => "Edit",
        0x2B | 0x38 | 0x39 | 0x3A | 0x40 => "Button",
        0x2C => "CheckBox",
        0x2D => "RadioButton",
        0x2E | 0x2F => "ComboBox",
        0x30 => "ProgressBar",
        0x33 => "Slider",
        0x34 => "Spinner",
        0x3C => "Tab",
        0x3E => "SplitButton",
        _ => "Custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// A fake accessible object. Its simple children are read under their
    /// child id; nothing here touches a window.
    #[derive(Default)]
    struct FakeData {
        id: usize,
        own: Option<Reading>,
        own_state: Option<u32>,
        simple: Vec<(i32, Option<Reading>)>,
        /// The count the object claims; `None` fails the read.
        count: Option<i32>,
        children: Vec<FakeChild>,
        asked: RefCell<Vec<(i32, usize)>>,
    }

    #[derive(Clone)]
    enum FakeChild {
        Object(Fake),
        Simple(i32),
        Unreadable,
    }

    #[derive(Clone)]
    struct Fake(Rc<FakeData>);

    impl AccNode for Fake {
        fn identity(&self) -> usize {
            self.0.id
        }
        fn read(&self, child: i32) -> Option<Reading> {
            if child == 0 {
                return self.0.own.clone();
            }
            self.0.simple.iter().find(|(id, _)| *id == child)?.1.clone()
        }
        fn state(&self, _child: i32) -> Option<u32> {
            self.0.own_state
        }
        fn child_count(&self) -> Option<i32> {
            self.0.count
        }
        fn do_default_action(&self, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn put_value(&self, _: i32, _: &str) -> Result<(), String> {
            Err("fake".into())
        }
        fn children(&self, start: i32, count: usize) -> Result<Vec<Child<Self>>, String> {
            self.0.asked.borrow_mut().push((start, count));
            let slots = self.0.children.iter().skip(start as usize).take(count);
            Ok(slots
                .map(|child| match child {
                    FakeChild::Object(object) => Child::Object(object.clone()),
                    FakeChild::Simple(id) => Child::Simple(*id),
                    FakeChild::Unreadable => Child::Unreadable,
                })
                .collect())
        }
    }

    fn fake(data: FakeData) -> Fake {
        Fake(Rc::new(data))
    }

    fn seen(name: &str, state: u32) -> Reading {
        Reading { w: 10, h: 10, name: name.into(), state, ..Reading::default() }
    }

    /// A readable object with these children.
    fn object(id: usize, name: &str, state: u32, children: Vec<Fake>) -> Fake {
        fake(FakeData {
            id,
            own: Some(seen(name, state)),
            count: Some(children.len() as i32),
            children: children.into_iter().map(FakeChild::Object).collect(),
            ..FakeData::default()
        })
    }

    fn node(acc: Fake) -> MsaaNode<Fake> {
        MsaaNode::new(acc, 0, "0".into(), 7, "7")
    }

    fn walked(root: &Fake, maximum: usize) -> (Vec<String>, bool) {
        let (nodes, complete) = walk(root, 7, "7", maximum).unwrap();
        (nodes.iter().map(|node| format!("{} {}", node.key, node.name)).collect(), complete)
    }

    #[test]
    fn role_map_follows_the_table() {
        let expected = [
            (0x01, "TitleBar"),
            (0x02, "MenuBar"),
            (0x03, "ScrollBar"),
            (0x09, "Window"),
            (0x0A, "Client"),
            (0x0B, "Menu"),
            (0x0C, "MenuItem"),
            (0x0F, "Document"),
            (0x10, "Pane"),
            (0x14, "Group"),
            (0x15, "Separator"),
            (0x16, "ToolBar"),
            (0x17, "StatusBar"),
            (0x18, "Table"),
            (0x19, "HeaderItem"),
            (0x1D, "DataItem"),
            (0x1E, "Hyperlink"),
            (0x21, "List"),
            (0x22, "ListItem"),
            (0x23, "Tree"),
            (0x24, "TreeItem"),
            (0x25, "TabItem"),
            (0x26, "Pane"),
            (0x28, "Image"),
            (0x29, "Text"),
            (0x2A, "Edit"),
            (0x2B, "Button"),
            (0x2C, "CheckBox"),
            (0x2D, "RadioButton"),
            (0x2E, "ComboBox"),
            (0x2F, "ComboBox"),
            (0x30, "ProgressBar"),
            (0x32, "Edit"),
            (0x33, "Slider"),
            (0x34, "Spinner"),
            (0x38, "Button"),
            (0x39, "Button"),
            (0x3A, "Button"),
            (0x3C, "Tab"),
            (0x3E, "SplitButton"),
            (0x3F, "Edit"),
            (0x40, "Button"),
        ];
        for role in 0..=0x41 {
            let wanted = expected.iter().find(|(known, _)| *known == role).map_or("Custom", |(_, kind)| kind);
            assert_eq!(control_type_for_role(role), wanted, "role {role:#x}");
        }
    }

    #[test]
    fn state_flags_decode() {
        let read = |state| {
            let mut node = node(object(1, "n", state, Vec::new()));
            assert!(node.refresh());
            node
        };
        let plain = read(0);
        assert!(plain.enabled() && !plain.read_only() && !plain.offscreen() && !plain.invisible());
        assert!(!read(0x1).enabled());
        assert!(read(0x40).read_only());
        let scrolled = read(0x10000);
        assert!(scrolled.offscreen() && !scrolled.invisible());
        let hidden = read(0x8000);
        assert!(hidden.offscreen() && hidden.invisible());
    }

    #[test]
    fn refresh_needs_a_location_and_an_area() {
        let flat = Reading { w: 10, h: 0, role: 0x2B, ..Reading::default() };
        let mut flat = node(fake(FakeData { own: Some(flat), ..FakeData::default() }));
        assert!(!flat.refresh());
        assert_eq!(flat.control_type(), "Button", "what was read is kept");
        assert!(!node(fake(FakeData::default())).refresh());
    }

    #[test]
    fn state_text_names_each_flag() {
        let lookup = |flag: u32| match flag {
            0x1 => Some("unavailable".to_string()),
            0x100000 => Some("focusable".to_string()),
            _ => None,
        };
        assert_eq!(state_text_with(0, lookup), "normal");
        assert_eq!(state_text_with(0x1, lookup), "unavailable");
        assert_eq!(state_text_with(0x100001, lookup), "unavailable,focusable");
        assert_eq!(state_text_with(0x80100040, lookup), "0x40,focusable,0x80000000");
    }

    #[test]
    fn role_text_falls_back_to_the_number() {
        assert_eq!(role_text_with(0x2B, |_| Some("push button".into())), "push button");
        assert_eq!(role_text_with(0x2B, |_| None), "43");
    }

    #[test]
    fn walk_lists_objects_and_simple_children_by_path() {
        let list = fake(FakeData {
            id: 2,
            own: Some(seen("list", 0)),
            simple: vec![(1, Some(seen("first", 0))), (2, Some(seen("second", 0)))],
            count: Some(2),
            children: vec![FakeChild::Simple(1), FakeChild::Simple(2)],
            ..FakeData::default()
        });
        let root = object(1, "client", 0, vec![list, object(3, "ok", 0, Vec::new())]);
        let (nodes, complete) = walk(&root, 7, "7", 100).unwrap();
        assert!(complete);
        let listed: Vec<_> = nodes.iter().map(|node| (node.key.as_str(), node.name.as_str(), node.child)).collect();
        assert_eq!(listed, [("0/0", "list", 0), ("0/0/0", "first", 1), ("0/0/1", "second", 2), ("0/1", "ok", 0)]);
        assert_eq!((nodes[1].window, nodes[1].window_id.as_str()), (7, "7"));
    }

    #[test]
    fn walk_visits_an_object_once() {
        // The inner object lists the root again, and one object has two parents.
        let shared = || object(3, "shared", 0, Vec::new());
        let again = object(1, "client", 0, vec![object(4, "never", 0, Vec::new())]);
        let inner = object(2, "inner", 0, vec![again, shared()]);
        let root = object(1, "client", 0, vec![inner, shared()]);
        assert_eq!(walked(&root, 100), (vec!["0/0 inner".to_string(), "0/0/1 shared".to_string()], true));
    }

    /// A root over a chain of `depth` nested objects.
    fn chain(depth: usize) -> Fake {
        (1..=depth).rev().fold(object(depth + 1, "leaf", 0, Vec::new()), |child, level| {
            object(level, "level", 0, vec![child])
        })
    }

    #[test]
    fn walk_refuses_a_tree_deeper_than_64() {
        let (nodes, complete) = walked(&chain(64), 5000);
        assert_eq!((nodes.len(), complete), (64, true));
        assert_eq!(nodes[63], format!("0{} leaf", "/0".repeat(64)));
        assert_eq!(walk(&chain(65), 7, "7", 5000).err().as_deref(), Some("MSAA tree depth exceeds 64"));
    }

    #[test]
    fn walk_asks_for_children_in_batches_of_256() {
        let root = fake(FakeData {
            id: 1,
            simple: (1..=600).map(|id| (id, Some(seen("item", 0)))).collect(),
            count: Some(600),
            children: (1..=600).map(FakeChild::Simple).collect(),
            ..FakeData::default()
        });
        let (nodes, complete) = walked(&root, 5000);
        assert_eq!((nodes.len(), complete), (600, true));
        assert_eq!(nodes[599], "0/599 item");
        assert_eq!(*root.0.asked.borrow(), [(0, 256), (256, 256), (512, 88)]);
    }

    #[test]
    fn walk_cut_at_the_maximum_is_incomplete() {
        let leaf = |id, name| object(id, name, 0, Vec::new());
        let root = object(1, "client", 0, vec![leaf(2, "a"), leaf(3, "b"), leaf(4, "c")]);
        assert_eq!(walked(&root, 2), (vec!["0/0 a".to_string(), "0/1 b".to_string()], false));
        let (nodes, complete) = walked(&root, 3);
        assert_eq!((nodes.len(), complete), (3, true));
        assert_eq!(check_maximum(0).unwrap_err(), "MSAA maximum must be 1..5000");
        assert!(check_maximum(5001).is_err());
        assert_eq!(check_maximum(5000), Ok(()));
    }

    #[test]
    fn walk_does_not_descend_into_an_invisible_node() {
        let hidden = object(2, "closed list", 0x8000, vec![object(3, "item", 0, Vec::new())]);
        let scrolled = object(4, "scrolled", 0x10000, vec![object(5, "kept", 0, Vec::new())]);
        let root = object(1, "client", 0, vec![hidden, scrolled]);
        let (nodes, complete) = walked(&root, 100);
        assert_eq!(nodes, ["0/0 closed list", "0/1 scrolled", "0/1/0 kept"]);
        assert!(complete);
    }

    #[test]
    fn walk_is_incomplete_after_a_failed_read() {
        let unread = |data: FakeData| {
            let root = object(1, "client", 0, vec![fake(data), object(9, "ok", 0, Vec::new())]);
            let (nodes, complete) = walked(&root, 100);
            assert!(!complete);
            nodes
        };
        let pane = || FakeData { id: 2, own: Some(seen("pane", 0)), ..FakeData::default() };
        // No location: the object is left out, and its children are walked.
        let under = FakeChild::Object(object(3, "under", 0, Vec::new()));
        assert_eq!(
            unread(FakeData { id: 2, count: Some(1), children: vec![under], ..FakeData::default() }),
            ["0/0/0 under", "0/1 ok"]
        );
        // No child count.
        assert_eq!(unread(pane()), ["0/0 pane", "0/1 ok"]);
        // Fewer children than counted.
        assert_eq!(unread(FakeData { count: Some(3), ..pane() }), ["0/0 pane", "0/1 ok"]);
        // A simple child without an area.
        assert_eq!(
            unread(FakeData {
                simple: vec![(5, Some(Reading::default()))],
                count: Some(1),
                children: vec![FakeChild::Simple(5)],
                ..pane()
            }),
            ["0/0 pane", "0/1 ok"]
        );
        // A slot that is neither an object nor a child id.
        assert_eq!(
            unread(FakeData { count: Some(1), children: vec![FakeChild::Unreadable], ..pane() }),
            ["0/0 pane", "0/1 ok"]
        );
    }

    #[test]
    fn protected_input_fails_closed() {
        assert!(protected(None));
        assert!(protected(Some(0x20000000)));
        assert!(protected(Some(0x20100004)));
        assert!(!protected(Some(0)));
        assert!(!protected(Some(0x100004)));
        let state = |own_state| node(fake(FakeData { own_state, ..FakeData::default() })).is_protected();
        assert!(state(None));
        assert!(state(Some(0x20000000)));
        assert!(!state(Some(0x40)));
    }
}
