//! Menu paths: a classic menu bar answered from its own menu handles, else
//! the UI Automation walk that opens one level at a time.

use super::super::background::{hold_inactive, release_inactive};
use super::super::bounded::Mta;
use super::super::msaa::{self, AccNode, MsaaNode, MAXIMUM};
use super::super::native::{self, hwnd};
use super::element::{toggle_label, top_window};
use super::{any_of, control_type_id, property_condition, text, Uia};
use crate::a11y::{normalize_menu_label, MenuOutcome};
use crate::platform::{window_id, Background, Wid, WindowInfo};
use std::collections::HashSet;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::OBJID_CLIENT;
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenu, GetMenuItemCount, GetMenuItemInfoW, GetMenuStringW, PostMessageW, HMENU, MENUITEMINFOW,
    MF_BYPOSITION, MFS_DISABLED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_SUBMENU,
    WM_COMMAND, WM_INITMENUPOPUP,
};

impl Uia {
    pub(super) fn menu(
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
        // Every Invoke, Expand and Toggle of the walk runs with the window held
        // non-activatable (input-menu.ps1:155 runs the walk in the guard).
        let held = hold_inactive(window.handle);
        let outcome = self.walk_menu(window, path, authorize, &mut root, &mut walked, &mut opened);
        if outcome.is_err() && opened > 0 {
            // Nothing was invoked, so the window returns to the state it had;
            // still held, as the PS closes the levels inside the guard.
            let _ = self.background.keys(window.handle, &"{ESC}".repeat(opened));
        }
        let released = release_inactive(held);
        let outcome = outcome?;
        released?;
        Ok(outcome)
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
            // Native applications usually expose menu state through MSAA at
            // once, so that exact path is tried before UIA walks a provider
            // tree (input-menu.ps1 Do-InvokeMenu, Get-MsaaMenuCandidates).
            if let Some(mut node) = self.msaa_candidate(window.handle, segment, index > 0)? {
                walked.push(segment);
                let last = index == path.len() - 1;
                authorize()?;
                // Read again right before the action (MixMsaa.cs DoDefaultAction).
                let invoked = if node.refresh() {
                    node.do_default_action()
                } else {
                    Err("MSAA element is stale".to_string())
                };
                invoked.map_err(|error| {
                    format!("{}: '{segment}' MSAA default action failed: {error}", default_action_code(last))
                })?;
                if last {
                    return Ok(MenuOutcome {
                        path: "msaa_menu",
                        verified: false,
                        message: format!("invoked menu path: {}", walked.join(" > ")),
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(120));
                *opened += 1;
                *root = None;
                continue;
            }
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
            let owner = top_window(&self.automation, &element);
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

impl Uia {
    /// The one enabled, visible MSAA menu entry named `name` among the window's
    /// owned popups and the window itself, when it has a default action; `None`
    /// leaves the level to UIA (Get-MsaaMenuCandidates). Read as one bounded stage.
    fn msaa_candidate(&self, window: Wid, name: &str, menu_only: bool) -> Result<Option<MsaaNode>, String> {
        let wanted = normalize_menu_label(name);
        let segment = name.to_string();
        let read = self.bounded("the MSAA menu", move || {
            let mut windows = native::related_windows(window);
            windows.push(window);
            let (mut seen, mut found) = (HashSet::new(), Vec::new());
            for handle in windows {
                if !native::is_window(handle) {
                    continue;
                }
                let id = window_id(handle);
                // Win32 menu bars belong to OBJID_MENU, not the client tree.
                let nodes = match msaa::menu_snapshot(handle, &id, MAXIMUM) {
                    Ok(nodes) if nodes.is_empty() => {
                        msaa::snapshot(handle, &id, MAXIMUM, OBJID_CLIENT.0).map(|(nodes, _)| nodes)
                    }
                    other => other,
                };
                // A window that cannot be read is skipped, as the PowerShell does.
                if let Ok(nodes) = nodes {
                    found.extend(usable_candidates(nodes, &wanted, menu_only, &mut seen));
                }
            }
            Ok(Mta::new(single(found, &segment, |node| !node.default_action.trim().is_empty())?))
        })?;
        Ok(read.get())
    }
}

/// The error code of a failed default action: the last level names an item
/// that cannot be invoked, an earlier one a menu that cannot be opened.
fn default_action_code(last: bool) -> &'static str {
    if last {
        "menu_item_not_invokable"
    } else {
        "menu_expand_unavailable"
    }
}

/// The nodes that are enabled, on screen, of a menu role (a menu item only
/// below the first level), named `wanted`, and not seen before by label, role,
/// area and default action (the filter of Get-MsaaMenuCandidates).
fn usable_candidates<A: AccNode>(
    nodes: Vec<MsaaNode<A>>,
    wanted: &str,
    menu_only: bool,
    seen: &mut HashSet<String>,
) -> Vec<MsaaNode<A>> {
    nodes
        .into_iter()
        .filter_map(|mut node| {
            if !node.refresh() || !node.enabled() || node.offscreen() {
                return None;
            }
            let role = node.control_type();
            if !["MenuItem", "Button", "SplitButton", "ListItem"].contains(&role) || (menu_only && role != "MenuItem") {
                return None;
            }
            let label = normalize_menu_label(&node.name);
            if label != wanted {
                return None;
            }
            let identity = format!("{label}|{role}|{}|{}|{}|{}|{}", node.x, node.y, node.w, node.h, node.default_action);
            seen.insert(identity).then_some(node)
        })
        .collect()
}

/// The only candidate, when it is usable: several are refused as ambiguous,
/// and a lone one that is not usable leaves the level to UIA.
fn single<T>(mut found: Vec<T>, segment: &str, usable: impl Fn(&T) -> bool) -> Result<Option<T>, String> {
    if found.len() > 1 {
        return Err(format!(
            "menu_path_ambiguous: '{segment}' matched {} entries; use a more exact path",
            found.len()
        ));
    }
    Ok(found.pop().filter(usable))
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
        super::super::background::send_value(window, WM_INITMENUPOPUP, menu.0 as usize, (position & 0xFFFF) as isize).ok();
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

#[cfg(test)]
mod tests {
    use super::super::super::msaa::{Child, Reading};
    use super::*;

    #[derive(Clone)]
    struct Fake(Reading);

    impl AccNode for Fake {
        fn identity(&self) -> usize {
            0
        }
        fn read(&self, _: i32) -> Option<Reading> {
            Some(self.0.clone())
        }
        fn state(&self, _: i32) -> Option<u32> {
            Some(self.0.state)
        }
        fn child_count(&self) -> Option<i32> {
            None
        }
        fn do_default_action(&self, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn put_value(&self, _: i32, _: &str) -> Result<(), String> {
            Err("fake".into())
        }
        fn children(&self, _: i32, _: usize) -> Result<Vec<Child<Self>>, String> {
            Ok(Vec::new())
        }
    }

    const ROLE_MENUITEM: u32 = 0x0C;
    const ROLE_PUSHBUTTON: u32 = 0x2B;
    const STATE_UNAVAILABLE: u32 = 0x1;
    const STATE_INVISIBLE: u32 = 0x8000;

    fn node(name: &str, role: u32, state: u32, x: i32) -> MsaaNode<Fake> {
        let reading = Reading {
            x,
            y: 0,
            w: 40,
            h: 10,
            name: name.into(),
            role,
            state,
            default_action: "Click".into(),
            ..Reading::default()
        };
        MsaaNode::new(Fake(reading), 0, String::new(), 1, "w")
    }

    fn lefts(found: &[MsaaNode<Fake>]) -> Vec<i32> {
        found.iter().map(|node| node.x).collect()
    }

    #[test]
    fn candidates_are_enabled_visible_named_and_of_a_menu_role() {
        let nodes = vec![
            node("&File", ROLE_MENUITEM, 0, 1),
            node("File", ROLE_MENUITEM, STATE_UNAVAILABLE, 2),
            node("File", ROLE_MENUITEM, STATE_INVISIBLE, 3),
            node("Edit", ROLE_MENUITEM, 0, 4),
            node("File", ROLE_PUSHBUTTON, 0, 5),
        ];
        let found = usable_candidates(nodes, "file", false, &mut HashSet::new());
        assert_eq!(lefts(&found), vec![1, 5]);
    }

    #[test]
    fn below_the_first_level_only_menu_items_count() {
        let nodes = vec![node("Save", ROLE_MENUITEM, 0, 1), node("Save", ROLE_PUSHBUTTON, 0, 2)];
        assert_eq!(lefts(&usable_candidates(nodes, "save", true, &mut HashSet::new())), vec![1]);
    }

    #[test]
    fn a_node_seen_by_another_window_is_kept_once() {
        let mut seen = HashSet::new();
        let first = usable_candidates(vec![node("Save", ROLE_MENUITEM, 0, 1)], "save", false, &mut seen);
        assert_eq!(first.len(), 1);
        assert!(usable_candidates(vec![node("Save", ROLE_MENUITEM, 0, 1)], "save", false, &mut seen).is_empty());
        assert_eq!(usable_candidates(vec![node("Save", ROLE_MENUITEM, 0, 9)], "save", false, &mut seen).len(), 1);
    }

    #[test]
    fn several_candidates_are_refused_and_a_lone_unusable_one_is_left_to_uia() {
        assert_eq!(
            single(vec![1, 2], "File", |_| true),
            Err("menu_path_ambiguous: 'File' matched 2 entries; use a more exact path".into())
        );
        assert_eq!(single(vec![1], "File", |_| true), Ok(Some(1)));
        assert_eq!(single(vec![1], "File", |_| false), Ok(None));
        assert_eq!(single(Vec::<u8>::new(), "File", |_| true), Ok(None));
    }

    #[test]
    fn the_error_code_follows_the_level() {
        assert_eq!(default_action_code(true), "menu_item_not_invokable");
        assert_eq!(default_action_code(false), "menu_expand_unavailable");
    }
}
