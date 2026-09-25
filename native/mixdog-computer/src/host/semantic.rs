//! Accessibility captures and the semantic actions that act on their refs.

use super::windows::effect;
use super::{sleep_ms, Host, Res};
use crate::a11y::{format_value, is_interactive, Accessibility, Element, Node};
use crate::obj;
use crate::observer::now_ms;
use crate::platform::WindowInfo;
use crate::protocol::{Obj, Req};
use crate::session::RefRecord;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::rc::Rc;

const NONINTERACTIVE_ROLES: [&str; 15] = [
    "Text", "Custom", "Group", "Pane", "Image", "DataGrid", "DataItem", "Header", "HeaderItem", "Table", "ProgressBar",
    "StatusBar", "ToolBar", "TitleBar", "Separator",
];
const CANDIDATE_LIMIT: usize = 5000;

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

impl Host {
    fn accessibility(&self) -> Res<&dyn Accessibility> {
        let a11y = self
            .desktop
            .accessibility()
            .ok_or_else(|| format!("accessibility_unavailable: {} exposes no accessibility tree to this host", self.desktop.name()))?;
        a11y.available()?;
        Ok(a11y)
    }

    pub(super) fn snapshot_window(&self, req: &Req) -> Res<Obj> {
        let started = now_ms();
        let info = self.resolve_window(req)?;
        let a11y = self.accessibility()?;
        let (expected_continuation, generation) = self.session(|session| {
            let expected = session.continuation.take();
            session.invalidate_refs();
            (expected, session.generation)
        });
        let visible_only = if req.has("visible_only") { req.truthy("visible_only") } else { true };
        let include_noninteractive = req.truthy("include_noninteractive");
        let include_structure = req.truthy("include_structure");
        let bounded = req.truthy("bounded");
        let max = req.int("max_elements").unwrap_or(200);
        if !(1..=1000).contains(&max) {
            return Err("max_elements must be 1..1000".into());
        }
        let max = max as usize;
        let query = req.text("query").trim().to_lowercase();
        let role_filter = req.text("role").trim().to_lowercase();
        let fingerprint = fingerprint(
            &json!([info.id(), max, visible_only, include_noninteractive, include_structure, bounded, query, role_filter]).to_string(),
        );
        let mut offset = 0usize;
        let mut continuation_total = None;
        if let Some(token) = req.str("continuation") {
            let parts: Vec<&str> = token.split(':').collect();
            let parsed = (parts.len() == 4)
                .then(|| (parts[0].parse::<i64>().ok(), parts[1].parse::<usize>().ok(), parts[3].parse::<usize>().ok()));
            let valid = matches!(parsed, Some((Some(token_generation), Some(token_offset), Some(token_total)))
                if token_generation == generation - 1
                    && token_offset <= token_total
                    && expected_continuation.as_deref() == Some(token.as_str())
                    && parts[2] == fingerprint);
            if !valid {
                return Err("continuation is stale or incompatible; capture the first page again".into());
            }
            if let Some((_, Some(token_offset), Some(token_total))) = parsed {
                offset = token_offset;
                continuation_total = Some(token_total);
            }
        }
        let find_started = now_ms();
        let nodes = a11y.snapshot(&info, include_noninteractive, CANDIDATE_LIMIT + 1)?;
        let find_ms = now_ms() - find_started;
        if nodes.len() > CANDIDATE_LIMIT {
            return Err(format!(
                "accessibility candidate limit exceeded: {} > {CANDIDATE_LIMIT}; narrow the role/query or use the interactive view",
                nodes.len()
            ));
        }
        let format_started = now_ms();
        let candidate_count = nodes.len();
        let mut found: Vec<Node> = Vec::new();
        let mut seen: HashMap<String, ()> = HashMap::new();
        for node in nodes {
            if !node.width.is_finite() || node.width <= 0.0 || node.height <= 0.0 {
                continue;
            }
            let wanted_role = is_interactive(&node.role) || (include_noninteractive && NONINTERACTIVE_ROLES.contains(&node.role.as_str()));
            if !wanted_role {
                continue;
            }
            if visible_only {
                let (x, y, width, height) = (info.x as f64, info.y as f64, info.width as f64, info.height as f64);
                if node.offscreen || node.x + node.width <= x || node.x >= x + width || node.y + node.height <= y || node.y >= y + height {
                    continue;
                }
            }
            if !role_filter.is_empty() && node.role.to_lowercase() != role_filter {
                continue;
            }
            let search = format!("{} {} {} {}", node.name, node.automation_id, node.value, node.role).to_lowercase();
            if !query.is_empty() && !search.contains(&query) {
                continue;
            }
            let key = format!(
                "{}|{}|{}|{}|{}|{}",
                node.x.round(),
                node.y.round(),
                node.width.round(),
                node.height.round(),
                node.name.to_lowercase(),
                node.role.to_lowercase()
            );
            if seen.insert(key, ()).is_some() {
                continue;
            }
            found.push(node);
        }
        let format_ms = now_ms() - format_started;
        if continuation_total.is_some_and(|total| total != found.len()) {
            return Err("continuation is stale because the observed tree changed; capture the first page again".into());
        }
        let view = if include_noninteractive { "all" } else { "interactive" };
        let mut lines = vec![
            format!("Window: {} [{}]", info.title, info.id()),
            format!(
                "Elements: total={} candidates={candidate_count} view={view} offset={offset} max={max} generation={generation}",
                found.len()
            ),
        ];
        let end = found.len().min(offset + max);
        let continuation = (end < found.len()).then(|| format!("{generation}:{end}:{fingerprint}:{}", found.len()));
        let mut elements = Vec::new();
        for (index, node) in found.iter().enumerate().take(end).skip(offset) {
            let position = index - offset;
            let reference = format!("s{generation}:e{position}");
            self.session(|session| {
                session.refs.insert(
                    reference.clone(),
                    RefRecord {
                        element: node.element.clone(),
                        window_id: info.id(),
                        generation,
                        identity: node.element.identity(),
                    },
                );
            });
            let cx = (node.x + node.width / 2.0).round() as i64;
            let cy = (node.y + node.height / 2.0).round() as i64;
            let mut details = Vec::new();
            if !node.automation_id.is_empty() {
                details.push(format!("id=\"{}\"", format_value(&node.automation_id, 80)));
            }
            if !node.accelerator.is_empty() {
                details.push(format!("accelerator=\"{}\"", format_value(&node.accelerator, 40)));
            }
            if !node.value.is_empty() {
                details.push(format!("value=\"{}\"", format_value(&node.value, 120)));
            }
            for (label, value) in [("toggle", &node.toggle), ("selected", &node.selected), ("expanded", &node.expanded), ("range", &node.range)] {
                if !value.is_empty() {
                    details.push(format!("{label}={value}"));
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
                "mark" => position + 1,
                "ref" => reference.clone(),
                "source" => self.desktop.name(),
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
                element.insert("accelerator".into(), json!(format_value(&node.accelerator, 40)));
            }
            if include_structure {
                for (key, value) in node.element.structure() {
                    element.insert(key, value);
                }
            }
            elements.push(Value::Object(element));
            let disabled = if node.enabled { "" } else { " (disabled)" };
            let detail_text = if details.is_empty() { String::new() } else { format!(" {}", details.join(" ")) };
            lines.push(format!(
                "[{reference}] {} \"{}\"{disabled}{detail_text} @{cx},{cy}",
                node.role,
                format_value(&node.name, 80)
            ));
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
                "total_ms": now_ms() - started,
            }),
        })
    }

    /// Read-only predicate state. It leaves refs and generation untouched so
    /// waiting for a condition never invalidates what the caller holds.
    pub(super) fn window_predicates(&self, req: &Req) -> Res<Obj> {
        let info = match self.resolve_window(req) {
            Ok(info) => info,
            Err(error)
                if error.starts_with("window_id is stale or invalid:")
                    || error.starts_with("foreground window not found")
                    || error.starts_with("window not found:") =>
            {
                return Ok(obj! {
                    "text" => "window predicate state: absent",
                    "window_id" => req.str("window_id"),
                    "title" => "",
                    "exists" => false,
                    "returned" => 0,
                    "elements" => Vec::<Value>::new(),
                })
            }
            Err(error) => return Err(error),
        };
        if req.bool_false("include_elements") {
            return Ok(obj! {
                "text" => format!("window predicate state: {}", info.title),
                "window_id" => info.id(),
                "title" => info.title,
                "exists" => true,
                "returned" => 0,
                "elements" => Vec::<Value>::new(),
            });
        }
        let max = req.int("max_elements").unwrap_or(400);
        if !(1..=1000).contains(&max) {
            return Err("max_elements must be 1..1000".into());
        }
        let max = max as usize;
        let a11y = self.accessibility()?;
        let nodes = a11y.snapshot(&info, true, CANDIDATE_LIMIT)?;
        let mut complete = nodes.len() < CANDIDATE_LIMIT;
        let mut observations = Vec::new();
        for node in &nodes {
            if observations.len() >= max {
                complete = false;
                break;
            }
            if node.offscreen || (node.name.trim().is_empty() && node.value.trim().is_empty()) {
                continue;
            }
            if node.name.chars().count() > 200 || node.value.chars().count() > 200 {
                complete = false;
            }
            observations.push(json!({
                "role": node.role,
                "name": format_value(&node.name, 200),
                "value": format_value(&node.value, 200),
                "enabled": node.enabled,
            }));
        }
        Ok(obj! {
            "text" => format!("window predicate state: {}", info.title),
            "window_id" => info.id(),
            "title" => info.title,
            "exists" => true,
            "returned" => observations.len(),
            "text_complete" => complete && !observations.is_empty(),
            "elements" => observations,
        })
    }

    pub(super) fn accessibility_probe(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let a11y = self.accessibility()?;
        let interactive = a11y.snapshot(&info, false, 400)?.iter().any(|node| is_interactive(&node.role));
        if interactive {
            return Ok(obj! { "interactive" => true, "source" => self.desktop.name() });
        }
        Ok(obj! { "interactive" => false })
    }

    pub(super) fn invoke_menu(&self, req: &Req) -> Res<Obj> {
        let info: WindowInfo = self.resolve_window(req)?;
        let path: Vec<String> = req.strings("path").into_iter().filter(|segment| !segment.trim().is_empty()).collect();
        if path.is_empty() || path.len() > 8 {
            return Err("menu path must have 1..8 segments".into());
        }
        let a11y = self.accessibility()?;
        let authorize = || self.authorize(req, info.handle);
        let outcome = a11y.invoke_menu(&info, &path, &authorize)?;
        Ok(self.action_result("invoke_menu", outcome.path, effect(outcome.verified), outcome.verified, &outcome.message, None, "background", Some(info.id())))
    }

    /// The element states an action can visibly change, joined for comparison.
    pub(super) fn observable_state(&self, element: &Rc<dyn Element>, action: &str) -> Option<String> {
        let mut parts = Vec::new();
        if matches!(action, "click" | "double_click" | "right_click" | "middle_click" | "triple_click") {
            if let Some(toggle) = element.toggle_state() {
                parts.push(format!("toggle={toggle}"));
            }
            if let Some(expanded) = element.expand_state() {
                parts.push(format!("expanded={expanded}"));
            }
        }
        if matches!(action, "key" | "type") {
            if let Some(value) = element.value() {
                parts.push(format!("value={value}"));
            }
        }
        if action == "drag" {
            if let Some(range) = element.range_value() {
                parts.push(format!("range={range}"));
            }
        }
        (!parts.is_empty()).then(|| parts.join("|"))
    }

    /// The element's own semantic action: toggle, expand/collapse, press, or
    /// select. With `allow_native_click`, an element that has none returns
    /// `None` so the caller may use a target-bound pointer event instead.
    pub(super) fn do_invoke(&self, req: &Req, allow_native_click: bool) -> Res<Option<Obj>> {
        let reference = req.text("ref");
        let (element, window) = self.ref_record(&reference)?;
        let id = Some(window);
        if !element.enabled() {
            return Ok(Some(self.background_unavailable("invoke", &format!("element {reference} is disabled; no input was sent"), id, "element_disabled", false)));
        }
        if let Some(before) = element.toggle_state() {
            self.authorize_current(0)?;
            element.press()?;
            let after = wait_for_change(&before, || element.toggle_state());
            let verified = after != before;
            let message = format!("activated {reference} through accessibility toggle from {before} to {after}");
            return Ok(Some(self.action_result("invoke", "a11y_toggle", effect(verified), verified, &message, None, "background", id)));
        }
        if let Some(before) = element.expand_state() {
            let expected = if before == "Expanded" { "Collapsed" } else { "Expanded" };
            self.authorize_current(0)?;
            element.set_expanded(expected == "Expanded")?;
            let after = wait_for_change(&before, || element.expand_state());
            let verified = after == expected;
            let message = format!("activated {reference} through accessibility expand/collapse from {before} to {after}");
            return Ok(Some(self.action_result("invoke", "a11y_expand_collapse", effect(verified), verified, &message, None, "background", id)));
        }
        if element.can_press() {
            self.authorize_current(0)?;
            element.press()?;
            return Ok(Some(self.action_result("invoke", "a11y_invoke", "unverifiable", false, &format!("invoked {reference} through accessibility"), None, "background", id)));
        }
        if element.can_select() {
            self.authorize_current(0)?;
            element.select()?;
            return Ok(Some(self.action_result("invoke", "a11y_selection", "unverifiable", false, &format!("selected {reference} through accessibility"), None, "background", id)));
        }
        if allow_native_click {
            return Ok(None);
        }
        let message = format!("element {reference} exposes no semantic toggle/invoke/select action; no physical fallback was attempted");
        Ok(Some(self.background_unavailable("invoke", &message, id, "background_unavailable", false)))
    }

    pub(super) fn do_set_value(&self, req: &Req, text: &str) -> Res<Obj> {
        let reference = req.text("ref");
        let (element, window) = self.ref_record(&reference)?;
        let id = Some(window);
        if !element.settable() {
            let message = format!("element {reference} exposes no settable value; no keystroke fallback was attempted");
            return Ok(self.background_unavailable("set_value", &message, id, "background_unavailable", false));
        }
        self.authorize_current(0)?;
        element.set_value(text)?;
        let mut actual = String::new();
        for _ in 0..8 {
            actual = element.value().unwrap_or_default();
            if actual == text {
                break;
            }
            sleep_ms(25);
        }
        let verified = actual == text;
        let message = format!("set {reference} value through accessibility; readback={verified}");
        Ok(self.action_result("set_value", "a11y_value", effect(verified), verified, &message, None, "background", id))
    }

    pub(super) fn do_toggle(&self, req: &Req) -> Res<Obj> {
        let reference = req.text("ref");
        let (element, window) = self.ref_record(&reference)?;
        if let Some(before) = element.toggle_state() {
            self.authorize_current(0)?;
            element.press()?;
            let after = wait_for_change(&before, || element.toggle_state());
            let verified = after != before;
            let message = format!("toggled {reference} from {before} to {after}");
            return Ok(self.action_result("toggle", "a11y_toggle", effect(verified), verified, &message, None, "background", Some(window)));
        }
        let mut result = self.do_invoke(req, false)?.unwrap_or_default();
        result.insert("action".into(), json!("toggle"));
        Ok(result)
    }
}

fn wait_for_change(before: &str, read: impl Fn() -> Option<String>) -> String {
    let mut after = before.to_string();
    for _ in 0..10 {
        sleep_ms(25);
        if let Some(value) = read() {
            after = value;
        }
        if after != before {
            break;
        }
    }
    after
}
