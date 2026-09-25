//! The accessibility view every platform maps into: elements carry the same
//! role vocabulary and capabilities on each operating system, so snapshots,
//! refs and predicates read alike wherever they were taken.

use crate::platform::{WindowInfo, Wid};
use crate::protocol::Obj;
use std::rc::Rc;

pub trait Element {
    /// A key that stays equal while this is the same element.
    fn identity(&self) -> String;
    /// The top-level window the element belongs to; 0 when unknown.
    fn window(&self) -> Wid;
    fn bounds(&self) -> Option<(f64, f64, f64, f64)>;
    fn enabled(&self) -> bool;
    /// Whether the element still exists in its application.
    fn alive(&self) -> bool;
    /// The element's default action (press, activate, jump).
    fn press(&self) -> Result<(), String>;
    fn can_press(&self) -> bool;
    fn toggle_state(&self) -> Option<String>;
    fn expand_state(&self) -> Option<String>;
    fn set_expanded(&self, expanded: bool) -> Result<(), String>;
    fn value(&self) -> Option<String>;
    fn settable(&self) -> bool;
    fn set_value(&self, text: &str) -> Result<(), String>;
    fn can_select(&self) -> bool;
    fn select(&self) -> Result<(), String>;
    /// Gives the element keyboard focus inside its application without
    /// activating the application.
    fn focus(&self) -> Result<(), String>;
    /// Scrolls the element's own scroll range; `None` when it has none.
    /// Returns the positions before and after.
    fn scroll(&self, horizontal: bool, increments: i32) -> Result<Option<(String, String)>, String>;
    /// Where the element sits in its tree, for structured captures.
    fn structure(&self) -> Obj;
    fn range_value(&self) -> Option<String> {
        None
    }
}

#[derive(Clone)]
pub struct Node {
    pub element: Rc<dyn Element>,
    pub role: String,
    pub name: String,
    pub automation_id: String,
    pub value: String,
    pub toggle: String,
    pub selected: String,
    pub expanded: String,
    pub range: String,
    pub accelerator: String,
    pub can_invoke: bool,
    pub can_set_value: bool,
    pub can_toggle: bool,
    pub can_scroll: bool,
    pub enabled: bool,
    pub offscreen: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct MenuOutcome {
    pub path: &'static str,
    pub verified: bool,
    pub message: String,
}

pub trait Accessibility {
    /// Refuses with the permission to grant when the platform withholds
    /// accessibility from this process.
    fn available(&self) -> Result<(), String>;
    /// Every element of the window in document order, up to `limit`.
    fn snapshot(&self, window: &WindowInfo, include_noninteractive: bool, limit: usize) -> Result<Vec<Node>, String>;
    /// The element that currently has keyboard focus, if it hides typed text.
    fn focused_masked(&self) -> bool;
    fn invoke_menu(
        &self,
        window: &WindowInfo,
        path: &[String],
        authorize: &dyn Fn() -> Result<(), String>,
    ) -> Result<MenuOutcome, String>;
}

pub const INTERACTIVE_ROLES: [&str; 16] = [
    "Button", "Edit", "CheckBox", "RadioButton", "ComboBox", "List", "ListItem", "MenuItem", "TabItem",
    "Hyperlink", "Tree", "TreeItem", "Slider", "Document", "Spinner", "SplitButton",
];

pub fn is_interactive(role: &str) -> bool {
    INTERACTIVE_ROLES.contains(&role)
}

/// One-line, quote-free, bounded text for observation output.
pub fn format_value(value: &str, maximum: usize) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_break = false;
    for c in value.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            if !in_break {
                text.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            text.push(if c == '"' { '\'' } else { c });
        }
    }
    let text = text.trim();
    if text.encode_utf16().count() > maximum {
        let mut out = String::new();
        let mut units = 0;
        for c in text.chars() {
            units += c.len_utf16();
            if units > maximum {
                break;
            }
            out.push(c);
        }
        return out;
    }
    text.to_string()
}

/// A menu label as a person reads it: no access-key ampersand, no localized
/// "(V)" access key, no accelerator after a tab, no trailing ellipsis.
pub fn normalize_menu_label(label: &str) -> String {
    let text = label.replace('&', "");
    let text = text.split('\t').next().unwrap_or("").to_string();
    let mut out = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '(' && index + 2 < chars.len() && chars[index + 2] == ')' && chars[index + 1].is_ascii_alphanumeric() {
            while out.ends_with(char::is_whitespace) {
                out.pop();
            }
            index += 3;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    let trimmed = out.trim_end();
    let trimmed = trimmed
        .strip_suffix("...")
        .or_else(|| trimmed.strip_suffix('\u{2026}'))
        .unwrap_or(trimmed);
    trimmed.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_single_line_and_bounded() {
        assert_eq!(format_value(" a\r\n\"b\"\tc ", 120), "a 'b' c");
        assert_eq!(format_value("abcdef", 3), "abc");
    }

    #[test]
    fn menu_labels_normalize() {
        assert_eq!(normalize_menu_label("보기(&V)"), "보기");
        assert_eq!(normalize_menu_label("Save &As...\tCtrl+Shift+S"), "save as");
        assert_eq!(normalize_menu_label("Open\u{2026}"), "open");
    }
}
