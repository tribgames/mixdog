//! Accessibility captures and the semantic actions that act on their refs.

mod invoke;
mod observable;
mod predicates;
mod value;

use super::{Host, Res};
use crate::a11y::{
    format_value, integrity_refusal, is_interactive, truncation_warning, Accessibility, Node,
    CANDIDATE_LIMIT,
};
use crate::obj;
use crate::observer::now_ms;
use crate::protocol::{Obj, Req};
use crate::session::RefRecord;
use crate::platform::WindowInfo;
use serde_json::{json, Value};
use std::collections::hash_map::Entry;
use std::collections::HashMap;

const NONINTERACTIVE_ROLES: [&str; 15] = [
    "Text",
    "Custom",
    "Group",
    "Pane",
    "Image",
    "DataGrid",
    "DataItem",
    "Header",
    "HeaderItem",
    "Table",
    "ProgressBar",
    "StatusBar",
    "ToolBar",
    "TitleBar",
    "Separator",
];

/// A short stable digest for continuation tokens.
fn fingerprint(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn node_state(node: &Node) -> String {
    if node.extra.source == MSAA {
        // Format-StructuredObservationState: MSAA's own state text.
        return format_value(&node.extra.native_state, 200);
    }
    let mut parts = Vec::new();
    if !node.toggle.is_empty() {
        parts.push(format!("toggle={}", node.toggle));
    }
    if !node.selected.is_empty() {
        parts.push(format!("selected={}", node.selected));
    }
    if !node.expanded.is_empty() {
        parts.push(format!("expanded={}", node.expanded));
    }
    if !node.range.is_empty() {
        parts.push(format!("range={}", node.range));
    }
    parts.join(";")
}

/// The source of the nodes a second accessibility API adds (MSAA).
const MSAA: &str = "msaa";

/// The source a read names, where "" stands for the desktop's own.
fn source_or(source: &'static str, desktop: &'static str) -> &'static str {
    if source.is_empty() {
        desktop
    } else {
        source
    }
}

/// Whether a view lists the node: an interactive role, a non-interactive one
/// in the wider view, or a focusable text surface in either, where a terminal
/// or editor takes input whatever its role (Snapshot-Window's search
/// condition).
fn in_view(node: &Node, include_noninteractive: bool) -> bool {
    node.extra.text_surface
        || is_interactive(&node.role)
        || (include_noninteractive && NONINTERACTIVE_ROLES.contains(&node.role.as_str()))
}

/// One listed element: its reply object and its text line. `mark` is its
/// number on the page, from 1, and `source` the desktop's, for a node that
/// names none.
fn element_entry(node: &Node, reference: &str, mark: i64, source: &'static str) -> (Obj, String) {
    let cx = (node.x + node.width / 2.0).round() as i64;
    let cy = (node.y + node.height / 2.0).round() as i64;
    let msaa = node.extra.source == MSAA;
    let mut details = Vec::new();
    if msaa {
        details.push(format!("source={MSAA}"));
    }
    if !node.automation_id.is_empty() {
        details.push(format!("id=\"{}\"", format_value(&node.automation_id, 80)));
    }
    if !node.accelerator.is_empty() {
        details.push(format!(
            "accelerator=\"{}\"",
            format_value(&node.accelerator, 40)
        ));
    }
    if !node.extra.access_key.is_empty() {
        details.push(format!(
            "access_key=\"{}\"",
            format_value(&node.extra.access_key, 40)
        ));
    }
    // Help text that only repeats the name tells nothing.
    let help = node.extra.help.trim();
    let help = (!help.eq_ignore_ascii_case(node.name.trim())).then_some(help).filter(|help| !help.is_empty());
    if let Some(help) = help {
        details.push(format!("help=\"{}\"", format_value(help, 120)));
    }
    if !node.value.is_empty() {
        details.push(format!("value=\"{}\"", format_value(&node.value, 120)));
    }
    for (label, value) in [
        ("toggle", &node.toggle),
        ("selected", &node.selected),
        ("expanded", &node.expanded),
        ("range", &node.range),
    ] {
        if !value.is_empty() {
            details.push(format!("{label}={value}"));
        }
    }
    if msaa {
        for (label, value, maximum) in [
            ("role", &node.extra.native_role, 80),
            ("state", &node.extra.native_state, 120),
            ("default_action", &node.extra.default_action, 80),
        ] {
            if !value.is_empty() {
                details.push(format!("{label}=\"{}\"", format_value(value, maximum)));
            }
        }
    }
    let mut actions = Vec::new();
    if node.enabled {
        actions.push("click");
    }
    if node.can_invoke {
        actions.push("invoke");
    }
    if node.can_set_value {
        actions.push("set_value");
    }
    if node.can_toggle {
        actions.push("toggle");
    }
    if node.can_scroll {
        actions.push("scroll");
    }
    let mut element = obj! {
        "mark" => mark,
        "ref" => reference,
        "source" => source_or(node.extra.source, source),
        "role" => node.role.clone(),
        "name" => format_value(&node.name, 200),
        "value" => format_value(&node.value, 300),
        "state" => node_state(node),
        "enabled" => node.enabled,
        "x" => node.x.round() as i64,
        "y" => node.y.round() as i64,
        "width" => node.width.round() as i64,
        "height" => node.height.round() as i64,
        "center_x" => cx,
        "center_y" => cy,
        "actions" => actions,
    };
    if !node.accelerator.is_empty() {
        element.insert(
            "accelerator".into(),
            json!(format_value(&node.accelerator, 40)),
        );
    }
    if !node.extra.access_key.is_empty() {
        element.insert(
            "access_key".into(),
            json!(format_value(&node.extra.access_key, 40)),
        );
    }
    if let Some(help) = help {
        element.insert("help".into(), json!(format_value(help, 120)));
    }
    let disabled = if node.enabled { "" } else { " (disabled)" };
    let detail_text = if details.is_empty() {
        String::new()
    } else {
        format!(" {}", details.join(" "))
    };
    let line = format!(
        "[{reference}] {} \"{}\"{disabled}{detail_text} @{cx},{cy}",
        node.role,
        format_value(&node.name, 80)
    );
    (element, line)
}

/// Whether a capture of the visible part leaves the node out: it is off
/// screen or entirely outside the window.
fn hidden(info: &WindowInfo, node: &Node) -> bool {
    let (x, y, width, height) = (
        info.x as f64,
        info.y as f64,
        info.width as f64,
        info.height as f64,
    );
    node.offscreen
        || node.x + node.width <= x
        || node.x >= x + width
        || node.y + node.height <= y
        || node.y >= y + height
}

/// The key two nodes of one place and name share (Snapshot-Window's
/// DedupeKey).
fn dedupe_key(node: &Node) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        node.x.round(),
        node.y.round(),
        node.width.round(),
        node.height.round(),
        node.name.to_lowercase(),
        node.role.to_lowercase()
    )
}

/// What a capture keeps of the nodes a second API adds (Snapshot-Window's
/// filters, with `role` and `query` lowercased).
struct View<'a> {
    window: &'a WindowInfo,
    visible_only: bool,
    include_noninteractive: bool,
    role: &'a str,
    query: &'a str,
}

/// An MSAA node's capabilities, and a report-view list item's value, which
/// its proxy carries in the description (Get-MsaaObservation).
fn observe_native(node: &mut Node) {
    if node.value.trim().is_empty() && node.role == "ListItem" {
        node.value = node.extra.description.clone();
    }
    node.can_invoke = !node.extra.default_action.trim().is_empty();
    node.can_set_value = matches!(node.role.as_str(), "Edit" | "ComboBox");
}

/// UIA bounds a native control by its window rect and MSAA by its client
/// area, a border apart: the same named control inside that border, a few
/// pixels smaller, is one element.
fn within_border(uia: &Node, native: &Node) -> bool {
    native.x >= uia.x - 1.0
        && native.y >= uia.y - 1.0
        && native.x + native.width <= uia.x + uia.width + 1.0
        && native.y + native.height <= uia.y + uia.height + 1.0
        && uia.width - native.width <= 8.0
        && uia.height - native.height <= 8.0
}

/// Appends the MSAA nodes the view keeps to `found` (Snapshot-Window's MSAA
/// loop, observation.ps1:512-554). `seen` maps each dedupe key to the node
/// that holds it. A node that duplicates one already listed is dropped
/// unless it adds an invoke or value action to it.
fn merge_native(
    found: &mut Vec<Node>,
    seen: &mut HashMap<String, usize>,
    native: Vec<Node>,
    view: &View,
) {
    let identity = |node: &Node| format!("{}|{}", node.name.to_lowercase(), node.role.to_lowercase());
    let mut by_identity: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, node) in found.iter().enumerate() {
        by_identity.entry(identity(node)).or_default().push(index);
    }
    for mut node in native {
        if view.visible_only && hidden(view.window, &node) {
            continue;
        }
        if matches!(node.role.as_str(), "Window" | "Client") {
            continue;
        }
        if !view.include_noninteractive && !is_interactive(&node.role) {
            continue;
        }
        if !view.role.is_empty() && node.role.to_lowercase() != view.role {
            continue;
        }
        observe_native(&mut node);
        let search = format!(
            "{} {} {} {} {} {}",
            node.name,
            node.value,
            node.extra.native_role,
            node.extra.native_state,
            node.extra.default_action,
            node.role
        )
        .to_lowercase();
        if !view.query.is_empty() && !search.contains(view.query) {
            continue;
        }
        let key = dedupe_key(&node);
        let existing = seen.get(&key).copied().or_else(|| {
            by_identity.get(&identity(&node)).and_then(|candidates| {
                candidates
                    .iter()
                    .copied()
                    .find(|index| within_border(&found[*index], &node))
            })
        });
        let adds_capability = existing.is_some_and(|index| {
            (node.can_invoke && !found[index].can_invoke)
                || (node.can_set_value && !found[index].can_set_value)
        });
        if existing.is_some() && !adds_capability {
            continue;
        }
        if existing.is_none() {
            seen.insert(key, found.len());
        }
        found.push(node);
    }
}

/// Ends a bounded snapshot's deadline with the snapshot, however it ends, so
/// no later read inherits it.
struct DeadlineScope<'a>(&'a dyn Accessibility);

impl Drop for DeadlineScope<'_> {
    fn drop(&mut self) {
        self.0.set_deadline(None);
    }
}

impl Host {
    pub(in crate::host) fn accessibility(&self) -> Res<&dyn Accessibility> {
        let a11y = self.desktop.accessibility().ok_or_else(|| {
            format!(
                "accessibility_unavailable: {} exposes no accessibility tree to this host",
                self.desktop.name()
            )
        })?;
        a11y.available()?;
        Ok(a11y)
    }

    /// Assert-AccessibleIntegrity (observation.ps1:273-277): Windows hides
    /// the controls of a window above this host's integrity.
    fn assert_accessible_integrity(&self, handle: crate::platform::Wid) -> Res<()> {
        match self.desktop.integrity(handle).as_ref().and_then(integrity_refusal) {
            Some(refusal) => Err(refusal),
            None => Ok(()),
        }
    }

    pub(in crate::host) fn snapshot_window(&self, req: &Req) -> Res<Obj> {
        let started = now_ms();
        let info = self.resolve_window(req)?;
        let a11y = self.accessibility()?;
        // Refused before the session is touched, so the refs of the capture
        // the caller still holds stay valid.
        self.assert_accessible_integrity(info.handle)?;
        let bounded = req.truthy("bounded");
        // A bounded capture gives every provider read one shared budget
        // (Snapshot-Window's MixUiaDeadline).
        let _deadline = bounded.then(|| {
            a11y.set_deadline(
                req.int("deadline_ms")
                    .filter(|ms| *ms > 0)
                    .map(|ms| ms as u64),
            );
            DeadlineScope(a11y)
        });
        let (expected_continuation, bound_key, generation) = self.session(|session| {
            let expected = session.continuation.take();
            // A ref the request names is read before the refs are retired:
            // the element it points at is marked in the reply by an identity
            // that survives this snapshot's new refs.
            let bound = req
                .str("ref")
                .and_then(|reference| session.refs.get(&reference))
                .map(|record| record.identity.clone())
                .filter(|identity| !identity.is_empty());
            session.invalidate_refs();
            session.marks.clear();
            (expected, bound, session.generation)
        });
        let visible_only = if req.has("visible_only") {
            req.truthy("visible_only")
        } else {
            true
        };
        let include_noninteractive = req.truthy("include_noninteractive");
        let include_structure = req.truthy("include_structure");
        let max = req.int("max_elements").unwrap_or(200);
        if !(1..=1000).contains(&max) {
            return Err("max_elements must be 1..1000".into());
        }
        let max = max as usize;
        let query = req.text("query").trim().to_lowercase();
        let role_filter = req.text("role").trim().to_lowercase();
        let fingerprint = fingerprint(
            &json!([
                info.id(),
                max,
                visible_only,
                include_noninteractive,
                include_structure,
                bounded,
                query,
                role_filter
            ])
            .to_string(),
        );
        let mut offset = 0usize;
        let mut continuation_total = None;
        if let Some(token) = req.str("continuation") {
            let parts: Vec<&str> = token.split(':').collect();
            let parsed = (parts.len() == 4).then(|| {
                (
                    parts[0].parse::<i64>().ok(),
                    parts[1].parse::<usize>().ok(),
                    parts[3].parse::<usize>().ok(),
                )
            });
            let valid = matches!(parsed, Some((Some(token_generation), Some(token_offset), Some(token_total)))
                if token_generation == generation - 1
                    && token_offset <= token_total
                    && expected_continuation.as_deref() == Some(token.as_str())
                    && parts[2] == fingerprint);
            if !valid {
                return Err(
                    "continuation is stale or incompatible; capture the first page again".into(),
                );
            }
            if let Some((_, Some(token_offset), Some(token_total))) = parsed {
                offset = token_offset;
                continuation_total = Some(token_total);
            }
        }
        let find_started = now_ms();
        let mut nodes = a11y.snapshot(&info, include_noninteractive, CANDIDATE_LIMIT + 1)?;
        let find_ms = now_ms() - find_started;
        // A tree past the limit is cut there, with a note, not refused.
        let mut warnings = Vec::new();
        if nodes.len() > CANDIDATE_LIMIT {
            nodes.truncate(CANDIDATE_LIMIT);
            warnings.push(truncation_warning());
        }
        let format_started = now_ms();
        let candidate_count = nodes.len();
        let mut found: Vec<Node> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        for node in nodes {
            if !node.width.is_finite() || node.width <= 0.0 || node.height <= 0.0 {
                continue;
            }
            if !in_view(&node, include_noninteractive) {
                continue;
            }
            if visible_only && hidden(&info, &node) {
                continue;
            }
            if !role_filter.is_empty() && node.role.to_lowercase() != role_filter {
                continue;
            }
            let search = format!(
                "{} {} {} {}",
                node.name, node.automation_id, node.value, node.role
            )
            .to_lowercase();
            if !query.is_empty() && !search.contains(&query) {
                continue;
            }
            if let Entry::Vacant(slot) = seen.entry(dedupe_key(&node)) {
                slot.insert(found.len());
                found.push(node);
            }
        }
        let format_ms = now_ms() - format_started;
        // The second tree is read after the first was filtered: a bounded
        // capture skips it when UIA already supplied the page.
        let msaa_started = now_ms();
        let (native, native_candidates, warning) =
            a11y.enrich(&info, found.len(), bounded, offset + max, candidate_count)?;
        let msaa_snapshot_ms = now_ms() - msaa_started;
        let candidate_count = candidate_count + native_candidates;
        merge_native(
            &mut found,
            &mut seen,
            native,
            &View {
                window: &info,
                visible_only,
                include_noninteractive,
                role: &role_filter,
                query: &query,
            },
        );
        if continuation_total.is_some_and(|total| total != found.len()) {
            return Err("continuation is stale because the observed tree changed; capture the first page again".into());
        }
        let view = if include_noninteractive {
            "all"
        } else {
            "interactive"
        };
        let mut lines = vec![
            format!("Window: {} [{}]", info.title, info.id()),
            format!(
                "Elements: total={} candidates={candidate_count} view={view} offset={offset} max={max} generation={generation}",
                found.len()
            ),
        ];
        warnings.extend(warning);
        for warning in warnings {
            lines.push(format!("Warning: {warning}"));
        }
        let end = found.len().min(offset + max);
        let continuation = (end < found.len())
            .then(|| format!("{generation}:{end}:{fingerprint}:{}", found.len()));
        let mut elements = Vec::new();
        for (index, node) in found.iter().enumerate().take(end).skip(offset) {
            let position = index - offset;
            let reference = format!("s{generation}:e{position}");
            let record = RefRecord::new(node, info.id(), generation);
            let bound = bound_key.as_deref() == Some(record.identity.as_str());
            let mark = position as i64 + 1;
            let (mut element, line) =
                element_entry(node, &reference, mark, self.desktop.element_source());
            // The mark names the element to a later action's element alias.
            self.session(|session| {
                session.refs.insert(reference.clone(), record);
                session.marks.insert(mark, reference.clone());
            });
            if bound {
                element.insert("bound_ref".into(), json!(true));
                element.insert("is_password".into(), json!(node.element.masked()));
            }
            if include_structure {
                for (key, value) in node.element.structure() {
                    element.insert(key, value);
                }
            }
            elements.push(Value::Object(element));
            lines.push(line);
        }
        if found.is_empty() {
            lines.push("(no matching elements found)".into());
        }
        if let Some(token) = &continuation {
            lines.push(format!("Continuation: {token}"));
        }
        self.session(|session| session.continuation = continuation.clone());
        Ok(obj! {
            "text" => lines.join("\n"),
            "window_id" => info.id(),
            "generation" => generation,
            "total_elements" => found.len(),
            "continuation" => continuation,
            "elements" => elements,
            "timings_ms" => json!({
                "a11y_find_ms": find_ms,
                "a11y_format_ms": format_ms,
                "msaa_snapshot_ms": msaa_snapshot_ms,
                "total_ms": now_ms() - started,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a11y::testing::node;
    use crate::a11y::{Element, MenuOutcome};
    use crate::config::Config;
    use crate::keys::Key;
    use crate::observer::Observer;
    use crate::platform::{
        AppEntry, Background, Button, Desktop, Integrity, Launched, Wid, WinState, WindowInfo,
    };
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    pub type Log = Rc<RefCell<Vec<&'static str>>>;

    /// An element of window 1 that answers from its fields and logs the
    /// semantic actions sent to it.
    #[derive(Default)]
    pub struct Part {
        pub role: &'static str,
        pub name: &'static str,
        pub identity: &'static str,
        pub masked: bool,
        pub expand: Cell<Option<&'static str>>,
        pub pressable: bool,
        pub selectable: bool,
        pub log: Log,
    }

    impl Part {
        fn note(&self, action: &'static str) -> Result<(), String> {
            self.log.borrow_mut().push(action);
            Ok(())
        }
    }

    impl Element for Part {
        fn identity(&self) -> String {
            self.identity.into()
        }
        fn window(&self) -> Wid {
            1
        }
        fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
            Some((10.0, 10.0, 20.0, 20.0))
        }
        fn enabled(&self) -> bool {
            true
        }
        fn alive(&self) -> bool {
            true
        }
        fn press(&self) -> Result<(), String> {
            self.note("press")
        }
        fn can_press(&self) -> bool {
            self.pressable
        }
        fn toggle_state(&self) -> Option<String> {
            None
        }
        fn expand_state(&self) -> Option<String> {
            self.expand.get().map(String::from)
        }
        fn set_expanded(&self, expanded: bool) -> Result<(), String> {
            self.expand
                .set(Some(if expanded { "Expanded" } else { "Collapsed" }));
            self.note("expand")
        }
        fn value(&self) -> Option<String> {
            None
        }
        fn settable(&self) -> bool {
            false
        }
        fn set_value(&self, _: &str) -> Result<(), String> {
            Err("fake".into())
        }
        fn can_select(&self) -> bool {
            self.selectable
        }
        fn select(&self) -> Result<(), String> {
            self.note("select")
        }
        fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
            Ok(None)
        }
        fn structure(&self) -> Obj {
            Obj::new()
        }
        fn masked(&self) -> bool {
            self.masked
        }
        fn control_type(&self) -> String {
            self.role.into()
        }
        fn name(&self) -> String {
            self.name.into()
        }
    }

    /// The node a snapshot reads for `part`.
    pub fn part_node(part: Part) -> Node {
        let mut seen = node(part.role, part.name, (10.0, 10.0, 20.0, 20.0));
        seen.element = Rc::new(part);
        seen
    }

    pub fn named(role: &'static str, name: &'static str, identity: &'static str) -> Part {
        Part {
            role,
            name,
            identity,
            ..Part::default()
        }
    }

    /// Window 1, whose accessibility tree is a fixed list of nodes and whose
    /// process ranks above this host while `elevated`.
    struct Screen {
        nodes: Vec<Node>,
        elevated: Rc<Cell<bool>>,
    }

    impl Accessibility for Screen {
        fn available(&self) -> Result<(), String> {
            Ok(())
        }
        fn snapshot(&self, _: &WindowInfo, _: bool, limit: usize) -> Result<Vec<Node>, String> {
            Ok(self.nodes.iter().take(limit).cloned().collect())
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
            Err("fake".into())
        }
    }

    impl Desktop for Screen {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn windows(&self) -> Result<Vec<WindowInfo>, String> {
            Ok(self.info(1).into_iter().collect())
        }
        fn info(&self, handle: Wid) -> Option<WindowInfo> {
            (handle == 1).then(|| WindowInfo {
                handle,
                title: "window 1".into(),
                width: 200,
                height: 200,
                ..Default::default()
            })
        }
        fn foreground(&self) -> Wid {
            1
        }
        fn focus(&self, _: Wid) -> bool {
            false
        }
        fn window_at_point(&self, _: i32, _: i32) -> Wid {
            0
        }
        fn related_windows(&self, _: Wid) -> Vec<Wid> {
            Vec::new()
        }
        fn is_owned_by(&self, _: Wid, _: Wid) -> bool {
            false
        }
        fn integrity(&self, _: Wid) -> Option<Integrity> {
            let elevated = self.elevated.get();
            Some(Integrity {
                own_rid: 0x2000,
                target_rid: if elevated { 0x3000 } else { 0x2000 },
                own_name: "medium",
                target_name: if elevated { "high" } else { "medium" },
            })
        }
        fn move_window(&self, _: Wid, _: i32, _: i32, _: i32, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn set_window_state(&self, _: Wid, _: WinState) -> Result<(), String> {
            Err("fake".into())
        }
        fn close_window(&self, _: Wid) -> Result<bool, String> {
            Err("fake".into())
        }
        fn is_responding(&self, _: Wid) -> bool {
            true
        }
        fn cursor(&self) -> (i32, i32) {
            (0, 0)
        }
        fn move_pointer(&self, _: i32, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn button(&self, _: Button, _: bool, _: i32, _: i32, _: u32) -> Result<(), String> {
            Err("fake".into())
        }
        fn drag_move(&self, _: i32, _: i32) -> Result<(), String> {
            Err("fake".into())
        }
        fn wheel(&self, _: i32, _: i32, _: i32, _: bool) -> Result<(), String> {
            Err("fake".into())
        }
        fn key(&self, _: Key, _: bool) -> Result<(), String> {
            Err("fake".into())
        }
        fn text(&self, _: &str) -> Result<(), String> {
            Err("fake".into())
        }
        fn input_held(&self) -> bool {
            false
        }
        fn background(&self) -> Option<&dyn Background> {
            None
        }
        fn accessibility(&self) -> Option<&dyn Accessibility> {
            Some(self)
        }
        fn clipboard_read(&self) -> Result<String, String> {
            Err("fake".into())
        }
        fn clipboard_write(&self, _: &str) -> Result<bool, String> {
            Err("fake".into())
        }
        fn launch(&self, _: &str, _: Option<&AppEntry>) -> Result<Launched, String> {
            Err("fake".into())
        }
        fn installed_apps(&self) -> Result<Vec<AppEntry>, String> {
            Err("fake".into())
        }
        fn ocr(&self, _: &[u8], _: &str, _: usize) -> Result<Value, String> {
            Err("fake".into())
        }
        fn ocr_status(&self, _: &str) -> Value {
            Value::Null
        }
    }

    /// A host over window 1 with `nodes` as its tree, and the switch that
    /// raises the window above the host's integrity.
    pub fn host(nodes: Vec<Node>) -> (Host, Rc<Cell<bool>>) {
        let elevated = Rc::new(Cell::new(false));
        let screen = Screen {
            nodes,
            elevated: elevated.clone(),
        };
        let host = Host::new(
            Config {
                read_actions: Default::default(),
                retain_ref_actions: Default::default(),
                sequence_settle_ms: 0,
                max_foreground_text: 4000,
                input_marker: 0,
            },
            Box::new(screen),
            Observer::new(),
            Box::new(crate::lease_api::NoLease),
        );
        (host, elevated)
    }

    pub fn snapshot(host: &Host, request: Value) -> Obj {
        host.snapshot_window(&Req(request)).expect("snapshot")
    }

    fn elements(reply: &Obj) -> &Vec<Value> {
        reply["elements"].as_array().expect("elements")
    }

    fn keys(element: &Value) -> Vec<&str> {
        element
            .as_object()
            .expect("element")
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn a_snapshot_marks_only_the_element_its_ref_named() {
        let (host, _) = host(vec![
            part_node(named("Edit", "user", "a")),
            part_node(Part {
                masked: true,
                ..named("Edit", "code", "b")
            }),
        ]);
        snapshot(&host, json!({}));
        let reply = snapshot(&host, json!({ "ref": "s1:e1" }));
        let listed = elements(&reply);
        assert_eq!(listed[0].get("bound_ref"), None);
        assert_eq!(listed[0].get("is_password"), None);
        assert_eq!(listed[1]["ref"], "s2:e1");
        // After the fields every element has.
        assert_eq!(keys(&listed[1])[15..], ["bound_ref", "is_password"]);
        assert_eq!(listed[1]["bound_ref"], true);
        assert_eq!(listed[1]["is_password"], true);
        // The other field, by the ref this capture gave it.
        let reply = snapshot(&host, json!({ "ref": "s2:e0" }));
        let listed = elements(&reply);
        assert_eq!(listed[0]["bound_ref"], true);
        assert_eq!(listed[0]["is_password"], false);
        assert_eq!(listed[1].get("bound_ref"), None);
        // A ref no capture of this session handed out.
        let reply = snapshot(&host, json!({ "ref": "s9:e0" }));
        assert!(elements(&reply)
            .iter()
            .all(|element| element.get("bound_ref").is_none()));
    }

    #[test]
    fn an_element_without_an_identity_is_never_the_bound_one() {
        let (host, _) = host(vec![
            part_node(named("Edit", "one", "")),
            part_node(named("Edit", "two", "")),
        ]);
        snapshot(&host, json!({}));
        let reply = snapshot(&host, json!({ "ref": "s1:e0" }));
        assert!(elements(&reply)
            .iter()
            .all(|element| element.get("bound_ref").is_none()));
    }

    #[test]
    fn a_focusable_text_surface_is_listed_in_every_view() {
        let surface = |role, name| {
            let mut seen = node(role, name, (10.0, 10.0, 20.0, 20.0));
            seen.extra.text_surface = true;
            seen
        };
        let (host, _) = host(vec![
            surface("Text", "buffer"),
            node("Text", "label", (10.0, 10.0, 20.0, 20.0)),
            // A role neither view asks for by name.
            surface("Window", "editor"),
        ]);
        let names = |request: Value| -> Vec<String> {
            elements(&snapshot(&host, request))
                .iter()
                .map(|element| element["name"].as_str().unwrap_or_default().to_string())
                .collect()
        };
        assert_eq!(names(json!({})), ["buffer", "editor"]);
        assert_eq!(
            names(json!({ "include_noninteractive": true })),
            ["buffer", "label", "editor"]
        );
    }

    #[test]
    fn an_access_key_follows_the_accelerator() {
        let mut item = node("MenuItem", "File", (0.0, 0.0, 10.0, 10.0));
        item.automation_id = "file".into();
        item.accelerator = "Ctrl+F".into();
        item.extra.access_key = "Alt+F".into();
        item.value = "open".into();
        let (element, line) = element_entry(&item, "s1:e0", 1, "uia");
        assert_eq!(
            line,
            r#"[s1:e0] MenuItem "File" id="file" accelerator="Ctrl+F" access_key="Alt+F" value="open" @5,5"#
        );
        let keys: Vec<&str> = element.keys().map(String::as_str).collect();
        assert_eq!(keys[15..], ["accelerator", "access_key"]);
        assert_eq!(element["access_key"], "Alt+F");
    }

    #[test]
    fn help_text_shows_where_it_adds_to_the_name() {
        let mut item = node("Button", "Bold", (0.0, 0.0, 10.0, 10.0));
        item.extra.help = "Make the text bold".into();
        let (element, line) = element_entry(&item, "s1:e0", 1, "uia");
        assert_eq!(line, r#"[s1:e0] Button "Bold" help="Make the text bold" @5,5"#);
        assert_eq!(element["help"], "Make the text bold");
        item.extra.help = "bold".into();
        let (element, line) = element_entry(&item, "s1:e0", 1, "uia");
        assert_eq!(line, r#"[s1:e0] Button "Bold" @5,5"#);
        assert!(!element.contains_key("help"));
    }

    #[test]
    fn an_integrity_refusal_leaves_the_last_capture_usable() {
        let (host, elevated) = host(vec![part_node(named("Button", "OK", "a"))]);
        let first = snapshot(&host, json!({}));
        elevated.set(true);
        let error = host.snapshot_window(&Req(json!({}))).unwrap_err();
        assert!(
            error.starts_with("accessibility_blocked_by_integrity: this window runs at high integrity, above this host (medium)"),
            "{error}"
        );
        host.session(|session| {
            assert_eq!(first["generation"], session.generation);
            assert_eq!(session.marks.get(&1).map(String::as_str), Some("s1:e0"));
        });
        assert!(host.ref_record("s1:e0").is_ok());
    }

    #[test]
    fn a_predicate_read_of_an_elevated_window_is_refused_before_its_maximum() {
        let (host, elevated) = host(Vec::new());
        elevated.set(true);
        let error = host
            .window_predicates(&Req(json!({ "max_elements": 0 })))
            .unwrap_err();
        assert!(error.starts_with("accessibility_blocked_by_integrity:"), "{error}");
        elevated.set(false);
        let error = host
            .window_predicates(&Req(json!({ "max_elements": 0 })))
            .unwrap_err();
        assert_eq!(error, "max_elements must be 1..1000");
    }

    #[test]
    fn a_read_past_the_candidate_limit_is_cut_with_a_warning() {
        let (host, _) = host(vec![
            node("Button", "OK", (10.0, 10.0, 20.0, 20.0));
            CANDIDATE_LIMIT + 1
        ]);
        let reply = snapshot(&host, json!({}));
        assert_eq!(reply["total_elements"], json!(1));
        let text = reply["text"].as_str().unwrap();
        assert!(text.contains(&format!("candidates={CANDIDATE_LIMIT} ")), "{text}");
        assert!(text.contains(&format!("Warning: {}", truncation_warning())), "{text}");
    }

    #[test]
    fn marks_name_the_refs_of_the_page_last_captured() {
        let (host, _) = host(vec![
            part_node(named("Button", "one", "a")),
            part_node(named("Button", "two", "b")),
            part_node(named("Button", "three", "c")),
        ]);
        let marks = || -> Vec<(i64, String)> {
            host.session(|session| {
                session
                    .marks
                    .iter()
                    .map(|(mark, reference)| (*mark, reference.clone()))
                    .collect()
            })
        };
        let first = snapshot(&host, json!({ "max_elements": 2 }));
        assert_eq!(marks(), [(1, "s1:e0".to_string()), (2, "s1:e1".to_string())]);
        // Each mark is the one its element shows.
        for element in elements(&first) {
            let shown = (
                element["mark"].as_i64().unwrap_or_default(),
                element["ref"].as_str().unwrap_or_default().to_string(),
            );
            assert!(marks().contains(&shown), "{shown:?}");
        }
        // The next page numbers its own elements from 1 again.
        snapshot(
            &host,
            json!({ "max_elements": 2, "continuation": first["continuation"] }),
        );
        assert_eq!(marks(), [(1, "s2:e0".to_string())]);
    }

    #[test]
    fn a_default_node_extra_adds_no_snapshot_fields() {
        let plain = node("Button", "OK", (0.0, 0.0, 10.0, 10.0));
        let (element, line) = element_entry(&plain, "s1:e0", 1, "uia");
        let keys: Vec<&str> = element.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "mark", "ref", "source", "role", "name", "value", "state", "enabled", "x", "y",
                "width", "height", "center_x", "center_y", "actions",
            ]
        );
        assert_eq!(element["source"], "uia");
        assert_eq!(line, "[s1:e0] Button \"OK\" @5,5");
    }

    #[test]
    fn a_node_that_names_its_source_keeps_it() {
        let mut named = node("Button", "OK", (0.0, 0.0, 10.0, 10.0));
        named.extra.source = "msaa";
        let (element, _) = element_entry(&named, "s1:e0", 1, "uia");
        assert_eq!(element["source"], "msaa");
    }

    /// An MSAA node of window 1 as `Accessibility::enrich` returns it.
    fn native(role: &str, name: &str, bounds: (f64, f64, f64, f64), action: &str) -> Node {
        let mut seen = node(role, name, bounds);
        seen.extra.source = MSAA;
        seen.extra.default_action = action.into();
        seen
    }

    type Row = (String, String, bool, bool);

    /// The nodes `merge_native` leaves after the UIA nodes `listed`, as
    /// (role, name, invoke, set_value).
    fn merged(
        listed: Vec<Node>,
        native: Vec<Node>,
        include_noninteractive: bool,
        role: &str,
        query: &str,
    ) -> Vec<Row> {
        let mut seen = HashMap::new();
        for (index, node) in listed.iter().enumerate() {
            seen.insert(dedupe_key(node), index);
        }
        let mut found = listed;
        let window = WindowInfo {
            width: 200,
            height: 200,
            ..Default::default()
        };
        let view = View {
            window: &window,
            visible_only: true,
            include_noninteractive,
            role,
            query,
        };
        merge_native(&mut found, &mut seen, native, &view);
        found
            .into_iter()
            .map(|node| (node.role, node.name, node.can_invoke, node.can_set_value))
            .collect()
    }

    fn rows(rows: &[(&str, &str, bool, bool)]) -> Vec<Row> {
        rows.iter()
            .map(|(role, name, invoke, set)| (role.to_string(), name.to_string(), *invoke, *set))
            .collect()
    }

    #[test]
    fn an_msaa_node_at_the_place_of_a_uia_one_is_dropped_unless_it_adds_an_action() {
        let uia = || vec![node("Button", "OK", (10.0, 10.0, 20.0, 20.0))];
        // The same place, name and role, and nothing new.
        let same = native("Button", "OK", (10.0, 10.0, 20.0, 20.0), "");
        assert_eq!(
            merged(uia(), vec![same], false, "", ""),
            rows(&[("Button", "OK", false, false)])
        );
        // Its default action is an invoke the UIA node lacks.
        let acts = native("Button", "OK", (10.0, 10.0, 20.0, 20.0), "Press");
        assert_eq!(
            merged(uia(), vec![acts], false, "", ""),
            rows(&[("Button", "OK", false, false), ("Button", "OK", true, false)])
        );
        // A UIA node that already invokes needs no second one.
        let mut invokes = uia();
        invokes[0].can_invoke = true;
        let acts = native("Button", "OK", (10.0, 10.0, 20.0, 20.0), "Press");
        assert_eq!(
            merged(invokes, vec![acts], false, "", ""),
            rows(&[("Button", "OK", true, false)])
        );
        // An edit adds set_value to a UIA edit that lacks it.
        let edit = native("Edit", "Name", (10.0, 40.0, 20.0, 20.0), "");
        assert_eq!(
            merged(vec![node("Edit", "Name", (10.0, 40.0, 20.0, 20.0))], vec![edit], false, "", ""),
            rows(&[("Edit", "Name", false, false), ("Edit", "Name", false, true)])
        );
    }

    #[test]
    fn a_border_inside_a_uia_node_of_the_same_name_is_one_element() {
        let uia = || vec![node("Button", "OK", (10.0, 10.0, 50.0, 24.0))];
        let count = |native: Node| merged(uia(), vec![native], false, "", "").len();
        let inside = |bounds| native("Button", "OK", bounds, "");
        // Inside the window rect, 6 px smaller each way.
        assert_eq!(count(inside((12.0, 12.0, 44.0, 18.0))), 1);
        // One pixel of slack beyond the rect is still inside.
        assert_eq!(count(inside((9.0, 9.0, 52.0, 26.0))), 1);
        // More than 8 px smaller is another control.
        assert_eq!(count(inside((12.0, 12.0, 40.0, 18.0))), 2);
        // Outside the rect, or under another role.
        assert_eq!(count(inside((7.0, 10.0, 50.0, 24.0))), 2);
        assert_eq!(count(native("Edit", "OK", (12.0, 12.0, 44.0, 18.0), "")), 2);
    }

    #[test]
    fn the_views_filters_apply_to_msaa_nodes() {
        let at = (10.0, 10.0, 20.0, 20.0);
        let nodes = || {
            vec![
                native("Window", "dialog", at, ""),
                native("Client", "client", at, ""),
                native("Pane", "pane", (40.0, 10.0, 20.0, 20.0), ""),
                native("Button", "Save", (70.0, 10.0, 20.0, 20.0), "Press"),
                native("Edit", "Name", (100.0, 10.0, 20.0, 20.0), ""),
                native("Button", "away", (500.0, 10.0, 20.0, 20.0), "Press"),
            ]
        };
        let names = |list: Vec<Row>| -> Vec<String> { list.into_iter().map(|row| row.1).collect() };
        // Window and Client never list, a pane only in the wide view, and
        // what is outside the window not at all.
        assert_eq!(names(merged(Vec::new(), nodes(), false, "", "")), ["Save", "Name"]);
        assert_eq!(names(merged(Vec::new(), nodes(), true, "", "")), ["pane", "Save", "Name"]);
        assert_eq!(names(merged(Vec::new(), nodes(), false, "edit", "")), ["Name"]);
        // The query reads the name, the native texts, the default action and
        // the role.
        assert_eq!(names(merged(Vec::new(), nodes(), false, "", "press")), ["Save"]);
        assert_eq!(names(merged(Vec::new(), nodes(), false, "", "edit")), ["Name"]);
        let mut worded = nodes();
        worded[4].extra.native_state = "Focusable".into();
        assert_eq!(names(merged(Vec::new(), worded, false, "", "focusable")), ["Name"]);
        // A node that is off screen is dropped by a visible-only capture.
        let mut off = nodes();
        off[3].offscreen = true;
        assert_eq!(names(merged(Vec::new(), off, false, "", "")), ["Name"]);
    }

    #[test]
    fn an_msaa_list_item_shows_its_description_and_actions_follow_the_role() {
        let mut item = native("ListItem", "report.txt", (10.0, 10.0, 90.0, 18.0), "Double Click");
        item.extra.description = "Size: 3 KB".into();
        let mut valued = native("ListItem", "other", (10.0, 40.0, 90.0, 18.0), "");
        valued.value = "kept".into();
        valued.extra.description = "ignored".into();
        let edit = native("Edit", "Name", (10.0, 70.0, 90.0, 18.0), "");
        let combo = native("ComboBox", "Type", (10.0, 100.0, 90.0, 18.0), "Open");
        let window = WindowInfo {
            width: 200,
            height: 200,
            ..Default::default()
        };
        let view = View {
            window: &window,
            visible_only: true,
            include_noninteractive: false,
            role: "",
            query: "",
        };
        let mut found = Vec::new();
        merge_native(&mut found, &mut HashMap::new(), vec![item, valued, edit, combo], &view);
        let shown: Vec<(&str, bool, bool)> = found
            .iter()
            .map(|node| (node.value.as_str(), node.can_invoke, node.can_set_value))
            .collect();
        assert_eq!(
            shown,
            [
                ("Size: 3 KB", true, false),
                ("kept", false, false),
                ("", false, true),
                ("", true, true),
            ]
        );
    }

    #[test]
    fn an_msaa_node_lists_its_own_role_state_and_action() {
        let mut shown = native("Button", "OK", (0.0, 0.0, 10.0, 10.0), "Press");
        shown.extra.native_role = "push button".into();
        shown.extra.native_state = "focusable".into();
        let (element, line) = element_entry(&shown, "s1:e0", 1, "uia");
        assert_eq!(element["source"], "msaa");
        assert_eq!(element["state"], "focusable");
        assert_eq!(
            line,
            "[s1:e0] Button \"OK\" source=msaa role=\"push button\" state=\"focusable\" default_action=\"Press\" @5,5"
        );
    }
}
