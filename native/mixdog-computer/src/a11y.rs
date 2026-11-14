//! The accessibility view every platform maps into: elements carry the same
//! role vocabulary and capabilities on each operating system, so snapshots,
//! refs and predicates read alike wherever they were taken.

use crate::platform::{Integrity, Wid, WindowInfo};
use crate::protocol::Obj;
use crate::session::RefRecord;
use std::rc::Rc;

/// The most elements one accessibility read may return; a tree past it is cut
/// here and the snapshot says so (`truncation_warning`).
pub const CANDIDATE_LIMIT: usize = 5000;

/// The note a snapshot carries when a tree was cut at `CANDIDATE_LIMIT`.
pub fn truncation_warning() -> String {
    format!("accessibility tree truncated at {CANDIDATE_LIMIT} elements; narrow with role/query or use the interactive view")
}

/// The refusal for a window whose process ranks above this host, which
/// Windows hides the controls of (Assert-AccessibleIntegrity); `None` when
/// the window can be read.
pub fn integrity_refusal(integrity: &Integrity) -> Option<String> {
    integrity.higher().then(|| {
        format!(
            "accessibility_blocked_by_integrity: this window runs at {} integrity, above this host ({}), and Windows hides its controls from lower processes; read it with pixels or OCR, and act on frame coordinates with explicit foreground delivery, which asks for elevation",
            integrity.target_name, integrity.own_name
        )
    })
}

/// Why a ref no longer reaches the element it was handed out for
/// (Get-RefRecord's refusals).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stale {
    /// The element is gone or now belongs to another window.
    Target,
    /// The element is there, but under another role or name.
    Identity,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the ref checks, MSAA refs and value guards that call the defaults after `range_value` are not ported yet"
    )
)]
pub trait Element {
    /// A key that stays equal while this is the same element.
    fn identity(&self) -> String;
    /// The identity as the snapshot observed it, read without asking the
    /// provider again: what a ref records when it is handed out
    /// (Get-MsaaIdentity uses the observed ControlType|Name).
    fn observed_identity(&self) -> String {
        self.identity()
    }
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
    /// Scrolls the element's own scroll range; `None` when it has none.
    /// Returns the positions before and after.
    fn scroll(&self, horizontal: bool, increments: i32)
        -> Result<Option<(String, String)>, String>;
    /// Where the element sits in its tree, for structured captures.
    fn structure(&self) -> Obj;
    fn range_value(&self) -> Option<String> {
        None
    }
    /// The tree the element came from ("uia", "msaa"); "" is the desktop's
    /// own (`Desktop::element_source`).
    fn source(&self) -> &'static str {
        ""
    }
    /// What pressing the element does, as its provider words it.
    fn default_action(&self) -> Option<String> {
        None
    }
    fn read_only(&self) -> bool {
        false
    }
    /// Whether a value write is echoed back on every read without being
    /// entered (an Excel cell, Test-IgnoredValueWrite).
    fn ignores_value_write(&self) -> bool {
        false
    }
    /// Whether the element hides what is typed into it. Anything unknown
    /// counts as masked, as Test-RecordMasked fails closed.
    fn masked(&self) -> bool {
        true
    }
    /// The native window that draws the element; 0 when it has none.
    fn native_handle(&self) -> Wid {
        0
    }
    /// The live role, name and automation id, which a ref's recorded ones
    /// are checked against.
    fn control_type(&self) -> String {
        String::new()
    }
    fn name(&self) -> String {
        String::new()
    }
    fn automation_id(&self) -> String {
        String::new()
    }
    /// The top-level window the element lives in now (Get-TopWindow).
    fn top_window(&self) -> Wid {
        self.window()
    }
    /// Whether it is the selected item; `None` when it cannot be selected.
    fn selected(&self) -> Option<bool> {
        None
    }
    /// The horizontal and vertical scroll percentages; `None` when it has no
    /// scroll range.
    fn scroll_percent(&self) -> Option<(f64, f64)> {
        None
    }
    fn offscreen(&self) -> bool {
        false
    }
    /// The element's whole observable state when its source reads one as a
    /// piece (MSAA's "value=..|state=.."), which replaces the per-pattern
    /// parts.
    fn observable_state(&self) -> Option<String> {
        None
    }
    /// This element's own wording of a refusal, read as
    /// "ref <ref> <message>; take a fresh snapshot/find"; `None` keeps the
    /// shared wording.
    fn stale_message(&self, _kind: Stale) -> Option<&'static str> {
        None
    }
    /// Leaves the element's item the only one selected in its container
    /// before a value write (Select-OwningItemAlone); the error says why the
    /// write would still reach other selected items.
    fn exclusive_selection(&self) -> Result<(), String> {
        Ok(())
    }
}

/// What only some sources report about a node. The defaults add nothing to a
/// snapshot.
#[derive(Default, Clone)]
pub struct NodeExtra {
    /// The tree the node came from; "" is the desktop's own
    /// (`Desktop::element_source`).
    pub source: &'static str,
    /// The provider's own role and state text and default action (MSAA).
    pub native_role: String,
    pub native_state: String,
    pub default_action: String,
    /// MSAA's description, which stands in for an empty list item value.
    pub description: String,
    /// The mnemonic that reaches the element (UIA AccessKey).
    pub access_key: String,
    /// The provider's help text (UIA HelpText).
    pub help: String,
    /// A keyboard-focusable text surface, where a terminal or editor takes
    /// input whatever its role.
    pub text_surface: bool,
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
    pub extra: NodeExtra,
}

/// One text a window predicate can match, already formatted for the reply.
pub struct PredicateObservation {
    pub role: String,
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

/// Get-WindowPredicates' bookkeeping: observations in tree order up to
/// `max`, where a cut or an overlong text leaves the read incomplete.
pub struct PredicateRead {
    pub observations: Vec<PredicateObservation>,
    pub complete: bool,
    max: usize,
}

impl PredicateRead {
    pub fn new(max: usize) -> PredicateRead {
        PredicateRead {
            observations: Vec::new(),
            complete: true,
            max,
        }
    }

    /// Whether `max` is reached; reaching it with more left to read leaves the
    /// read incomplete.
    pub fn full(&mut self) -> bool {
        let full = self.observations.len() >= self.max;
        if full {
            self.complete = false;
        }
        full
    }

    /// Adds a text unless both name and value are blank; one over 200
    /// UTF-16 units (PowerShell's .Length) is cut and leaves the read
    /// incomplete.
    pub fn add(&mut self, role: &str, name: &str, value: &str, enabled: bool) {
        if name.trim().is_empty() && value.trim().is_empty() {
            return;
        }
        if name.encode_utf16().count() > 200 || value.encode_utf16().count() > 200 {
            self.complete = false;
        }
        self.observations.push(PredicateObservation {
            role: role.to_string(),
            name: observation_text(name, 200),
            value: observation_text(value, 200),
            enabled,
        });
    }
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
    fn snapshot(
        &self,
        window: &WindowInfo,
        include_noninteractive: bool,
        limit: usize,
    ) -> Result<Vec<Node>, String>;
    /// The element that currently has keyboard focus, if it hides typed text.
    fn focused_masked(&self) -> bool;
    fn invoke_menu(
        &self,
        window: &WindowInfo,
        path: &[String],
        authorize: &dyn Fn() -> Result<(), String>,
    ) -> Result<MenuOutcome, String>;
    /// Gives the snapshot being read one budget of `deadline_ms` from now for
    /// every provider call (Snapshot-Window's MixUiaDeadline); `None` reads
    /// without one.
    fn set_deadline(&self, _deadline_ms: Option<u64>) {}
    /// The elements a second accessibility API adds to a snapshot
    /// (Snapshot-Window's MSAA enrichment). The first read listed `uia_found`
    /// elements out of `prior` candidates, and `offset_plus_max` sizes a
    /// bounded read. Returns the nodes, the candidates read, and the warning
    /// line when the read was skipped.
    fn enrich(
        &self,
        _window: &WindowInfo,
        _uia_found: usize,
        _bounded: bool,
        _offset_plus_max: usize,
        _prior: usize,
    ) -> Result<(Vec<Node>, usize, Option<String>), String> {
        Ok((Vec::new(), 0, None))
    }
    /// The one element that stands in for a ref's element after its provider
    /// rebuilt the tree (Find-ReboundElement).
    fn rebind(&self, _window: Wid, _record: &RefRecord) -> Option<Rc<dyn Element>> {
        None
    }
    /// The source through which the window exposes an interactive element
    /// ("" is the desktop's own), or `None` when it exposes none
    /// (Probe-WindowAccessibility).
    fn probe(&self, window: &WindowInfo) -> Result<Option<&'static str>, String> {
        let interactive = self
            .snapshot(window, false, 400)?
            .iter()
            .any(|node| is_interactive(&node.role));
        Ok(interactive.then_some(""))
    }
    /// Every name and value a window predicate can match, up to `max`, and
    /// whether the read saw all of them (Get-WindowPredicates).
    fn predicate_read(
        &self,
        window: &WindowInfo,
        max: usize,
    ) -> Result<(Vec<PredicateObservation>, bool), String> {
        let nodes = self.snapshot(window, true, CANDIDATE_LIMIT)?;
        let mut read = PredicateRead::new(max);
        read.complete = nodes.len() < CANDIDATE_LIMIT;
        for node in &nodes {
            if read.full() {
                break;
            }
            if !node.offscreen {
                read.add(&node.role, &node.name, &node.value, node.enabled);
            }
        }
        Ok((read.observations, read.complete))
    }
}

pub const INTERACTIVE_ROLES: [&str; 16] = [
    "Button",
    "Edit",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "List",
    "ListItem",
    "MenuItem",
    "TabItem",
    "Hyperlink",
    "Tree",
    "TreeItem",
    "Slider",
    "Document",
    "Spinner",
    "SplitButton",
];

pub fn is_interactive(role: &str) -> bool {
    INTERACTIVE_ROLES.contains(&role)
}

/// One-line, quote-free, bounded text for observation output.
pub fn format_value(value: &str, maximum: usize) -> String {
    observation_text(value, maximum).replace('"', "'")
}

/// Format-ObservationValue (observation.ps1:90-95): breaks collapsed to one
/// space, trimmed, cut at `maximum` UTF-16 units. Quotes stay, so a predicate
/// matches the text as the window shows it.
fn observation_text(value: &str, maximum: usize) -> String {
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
            text.push(c);
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
// Only the Linux and macOS accessibility backends read menus.
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub fn normalize_menu_label(label: &str) -> String {
    let text = label.replace('&', "");
    let text = text.split('\t').next().unwrap_or("").to_string();
    let mut out = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '('
            && index + 2 < chars.len()
            && chars[index + 2] == ')'
            && chars[index + 1].is_ascii_alphanumeric()
        {
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

/// An element with no tree behind it, and nodes built on it, for tests.
#[cfg(test)]
pub mod testing {
    use super::*;

    pub struct Inert {
        pub window: Wid,
    }

    impl Element for Inert {
        fn identity(&self) -> String {
            "inert".into()
        }
        fn window(&self) -> Wid {
            self.window
        }
        fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
            None
        }
        fn enabled(&self) -> bool {
            true
        }
        fn alive(&self) -> bool {
            true
        }
        fn press(&self) -> Result<(), String> {
            Err("inert".into())
        }
        fn can_press(&self) -> bool {
            false
        }
        fn toggle_state(&self) -> Option<String> {
            None
        }
        fn expand_state(&self) -> Option<String> {
            None
        }
        fn set_expanded(&self, _: bool) -> Result<(), String> {
            Err("inert".into())
        }
        fn value(&self) -> Option<String> {
            None
        }
        fn settable(&self) -> bool {
            false
        }
        fn set_value(&self, _: &str) -> Result<(), String> {
            Err("inert".into())
        }
        fn can_select(&self) -> bool {
            false
        }
        fn select(&self) -> Result<(), String> {
            Err("inert".into())
        }
        fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
            Ok(None)
        }
        fn structure(&self) -> Obj {
            Obj::new()
        }
    }

    /// An enabled, on-screen node of window 1 with no states.
    pub fn node(role: &str, name: &str, bounds: (f64, f64, f64, f64)) -> Node {
        let (x, y, width, height) = bounds;
        Node {
            element: Rc::new(Inert { window: 1 }),
            role: role.into(),
            name: name.into(),
            automation_id: String::new(),
            value: String::new(),
            toggle: String::new(),
            selected: String::new(),
            expanded: String::new(),
            range: String::new(),
            accelerator: String::new(),
            can_invoke: false,
            can_set_value: false,
            can_toggle: false,
            can_scroll: false,
            enabled: true,
            offscreen: false,
            x,
            y,
            width,
            height,
            extra: NodeExtra::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{node, Inert};
    use super::*;

    /// A window whose accessibility tree is a fixed list of nodes.
    struct Tree(Vec<Node>);

    impl Accessibility for Tree {
        fn available(&self) -> Result<(), String> {
            Ok(())
        }
        fn snapshot(&self, _: &WindowInfo, _: bool, limit: usize) -> Result<Vec<Node>, String> {
            Ok(self.0.iter().take(limit).cloned().collect())
        }
        fn focused_masked(&self) -> bool {
            false
        }
        fn invoke_menu(
            &self,
            _: &WindowInfo,
            _: &[String],
            _: &dyn Fn() -> Result<(), String>,
        ) -> Result<MenuOutcome, String> {
            Err("no menu".into())
        }
    }

    #[test]
    fn element_defaults_add_nothing_and_fail_closed() {
        let element = Inert { window: 7 };
        assert_eq!(element.source(), "");
        assert_eq!(element.default_action(), None);
        assert!(!element.read_only());
        assert!(element.masked());
        assert_eq!(element.native_handle(), 0);
        assert_eq!(element.control_type(), "");
        assert_eq!(element.name(), "");
        assert_eq!(element.automation_id(), "");
        assert_eq!(element.top_window(), 7);
        assert_eq!(element.selected(), None);
        assert_eq!(element.scroll_percent(), None);
        assert!(!element.offscreen());
        assert_eq!(element.stale_message(Stale::Target), None);
        assert_eq!(element.stale_message(Stale::Identity), None);
        assert_eq!(element.exclusive_selection(), Ok(()));
    }

    #[test]
    fn accessibility_defaults_read_through_the_snapshot() {
        let window = WindowInfo::default();
        let tree = Tree(vec![node("Text", "label", (0.0, 0.0, 5.0, 5.0))]);
        tree.set_deadline(Some(10));
        let (nodes, candidates, warning) = tree.enrich(&window, 1, true, 200, 1).unwrap();
        assert!(nodes.is_empty() && candidates == 0 && warning.is_none());
        let record = RefRecord::new(&tree.0[0], "hwnd:0x1".into(), 1);
        assert!(tree.rebind(1, &record).is_none());
        assert_eq!(tree.probe(&window), Ok(None));
        let tree = Tree(vec![node("Button", "OK", (0.0, 0.0, 5.0, 5.0))]);
        assert_eq!(tree.probe(&window), Ok(Some("")));
    }

    #[test]
    fn predicate_reads_stop_at_max_and_flag_overlong_text() {
        let window = WindowInfo::default();
        let mut hidden = node("Text", "hidden", (0.0, 0.0, 5.0, 5.0));
        hidden.offscreen = true;
        let tree = Tree(vec![
            hidden,
            node("Text", " ", (0.0, 0.0, 5.0, 5.0)),
            node("Text", "a", (0.0, 0.0, 5.0, 5.0)),
            node("Button", "b", (0.0, 0.0, 5.0, 5.0)),
        ]);
        let (observations, complete) = tree.predicate_read(&window, 5).unwrap();
        let names: Vec<&str> = observations.iter().map(|seen| seen.name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        assert!(complete);
        let (observations, complete) = tree.predicate_read(&window, 1).unwrap();
        assert_eq!(observations.len(), 1);
        assert!(!complete);
        let tree = Tree(vec![node("Text", &"x".repeat(201), (0.0, 0.0, 5.0, 5.0))]);
        let (observations, complete) = tree.predicate_read(&window, 5).unwrap();
        assert_eq!(observations[0].name.chars().count(), 200);
        assert!(observations[0].enabled && observations[0].role == "Text");
        assert!(observations[0].value.is_empty());
        assert!(!complete);
    }

    #[test]
    fn predicate_text_keeps_quotes_and_counts_utf16_units() {
        let mut read = PredicateRead::new(5);
        read.add("Text", "Saved \"draft\"\r\n\tnow", "", true);
        assert_eq!(read.observations[0].name, "Saved \"draft\" now");
        assert!(read.complete);
        // 150 emoji are 300 UTF-16 units: cut to 100 and incomplete.
        read.add("Text", &"\u{1F600}".repeat(150), "", true);
        assert_eq!(read.observations[1].name.chars().count(), 100);
        assert!(!read.complete);
        // Snapshot text still turns quotes.
        assert_eq!(format_value("a \"b\"", 10), "a 'b'");
    }

    #[test]
    fn refusals_name_both_integrity_levels() {
        let rank = |own_rid, target_rid| Integrity {
            own_rid,
            target_rid,
            own_name: "medium",
            target_name: "high",
        };
        assert_eq!(
            integrity_refusal(&rank(0x2000, 0x3000)).unwrap(),
            "accessibility_blocked_by_integrity: this window runs at high integrity, above this host (medium), and Windows hides its controls from lower processes; read it with pixels or OCR, and act on frame coordinates with explicit foreground delivery, which asks for elevation"
        );
        assert_eq!(integrity_refusal(&rank(0x2000, 0x2000)), None);
        // An unknown own level refuses nothing, as Known is required.
        assert_eq!(integrity_refusal(&rank(0, 0x3000)), None);
    }

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
