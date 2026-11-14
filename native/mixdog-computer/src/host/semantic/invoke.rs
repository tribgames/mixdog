//! The semantic actions that press an element: invoke, toggle, and menu
//! paths.

use crate::host::windows::effect;
use crate::host::{sleep_ms, Host, Res};
use crate::a11y::Element;
use crate::platform::WindowInfo;
use crate::protocol::{Obj, Req};
use serde_json::json;

/// The expand states an invoke flips; LeafNode is the fourth, and flips
/// nothing.
const EXPANDABLE_STATES: [&str; 3] = ["Collapsed", "PartiallyExpanded", "Expanded"];

impl Host {
    /// The path prefix and tree name that semantic results word themselves
    /// with: Windows reports UIA (uia_invoke, "through UIA") as the PowerShell
    /// worker did, other platforms the generic accessibility wording.
    pub(in crate::host) fn semantic_words(&self) -> (&'static str, &'static str) {
        if self.desktop.element_source() == "uia" {
            ("uia", "UIA")
        } else {
            ("a11y", "accessibility")
        }
    }

    pub(in crate::host) fn invoke_menu(&self, req: &Req) -> Res<Obj> {
        let info: WindowInfo = self.resolve_window(req)?;
        let path: Vec<String> = req
            .strings("path")
            .into_iter()
            .filter(|segment| !segment.trim().is_empty())
            .collect();
        if path.is_empty() || path.len() > 8 {
            return Err("menu path must have 1..8 segments".into());
        }
        let a11y = self.accessibility()?;
        let authorize = || self.authorize(req, info.handle);
        let outcome = a11y.invoke_menu(&info, &path, &authorize)?;
        Ok(self.action_result(
            "invoke_menu",
            outcome.path,
            effect(outcome.verified),
            outcome.verified,
            &outcome.message,
            None,
            "background",
            Some(info.id()),
        ))
    }

    /// The element's own semantic action: toggle, expand/collapse, press, or
    /// select. With `allow_native_click`, an element that has none returns
    /// `None` so the caller may use a target-bound pointer event instead.
    pub(in crate::host) fn do_invoke(
        &self,
        req: &Req,
        allow_native_click: bool,
    ) -> Res<Option<Obj>> {
        let reference = req.text("ref");
        let (element, window) = self.ref_record(&reference)?;
        let id = Some(window);
        if element.source() == "msaa" {
            return self.invoke_msaa(&reference, &*element, id, allow_native_click);
        }
        let (prefix, tree) = self.semantic_words();
        if !element.enabled() {
            return Ok(Some(self.background_unavailable(
                "invoke",
                &format!("element {reference} is disabled; no input was sent"),
                id,
                "element_disabled",
                false,
            )));
        }
        if let Some(before) = element.toggle_state() {
            self.authorize_current(0)?;
            element.press()?;
            let after = wait_for_change(&before, || element.toggle_state());
            let verified = after != before;
            let message = format!(
                "activated {reference} through {tree} toggle from {before} to {after}"
            );
            return Ok(Some(self.action_result(
                "invoke",
                &format!("{prefix}_toggle"),
                effect(verified),
                verified,
                &message,
                None,
                "background",
                id,
            )));
        }
        // A leaf node has nothing to expand: it is invoked, else selected
        // (Do-Invoke's ExpandCollapse branch).
        let expandable = element
            .expand_state()
            .filter(|state| EXPANDABLE_STATES.contains(&state.as_str()));
        if let Some(before) = expandable {
            let expected = if before == "Expanded" {
                "Collapsed"
            } else {
                "Expanded"
            };
            self.authorize_current(0)?;
            element.set_expanded(expected == "Expanded")?;
            let after = wait_for_change(&before, || element.expand_state());
            let verified = after == expected;
            let message = format!("activated {reference} through {tree} expand/collapse from {before} to {after}");
            return Ok(Some(self.action_result(
                "invoke",
                &format!("{prefix}_expand_collapse"),
                effect(verified),
                verified,
                &message,
                None,
                "background",
                id,
            )));
        }
        if element.can_press() {
            self.authorize_current(0)?;
            element.press()?;
            return Ok(Some(self.action_result(
                "invoke",
                &format!("{prefix}_invoke"),
                "unverifiable",
                false,
                &format!("invoked {reference} through {tree}"),
                None,
                "background",
                id,
            )));
        }
        if element.can_select() {
            self.authorize_current(0)?;
            element.select()?;
            return Ok(Some(self.action_result(
                "invoke",
                &format!("{prefix}_selection"),
                "unverifiable",
                false,
                &format!("selected {reference} through {tree}"),
                None,
                "background",
                id,
            )));
        }
        if allow_native_click {
            return Ok(None);
        }
        let message = format!("element {reference} exposes no semantic toggle/invoke/select action; no physical fallback was attempted");
        Ok(Some(self.background_unavailable(
            "invoke",
            &message,
            id,
            "background_unavailable",
            false,
        )))
    }

    /// An MSAA ref's default action (Do-Invoke, the msaa branch). An element
    /// with no default action yields `None` under `allow_native_click`, so
    /// the pointer route runs.
    fn invoke_msaa(
        &self,
        reference: &str,
        element: &dyn Element,
        id: Option<String>,
        allow_native_click: bool,
    ) -> Res<Option<Obj>> {
        if !element.enabled() {
            return Ok(Some(self.background_unavailable(
                "invoke",
                &format!("element {reference} is disabled; no input was sent"),
                id,
                "element_disabled",
                false,
            )));
        }
        let action = element.default_action().unwrap_or_default();
        if allow_native_click && action.trim().is_empty() {
            return Ok(None);
        }
        self.authorize_current(0)?;
        Ok(Some(match element.press() {
            Ok(()) => self.action_result(
                "invoke",
                "msaa_default_action",
                "unverifiable",
                false,
                &format!("invoked {reference} through MSAA default action: {action}"),
                None,
                "background",
                id,
            ),
            Err(error) => self.background_unavailable(
                "invoke",
                &format!("MSAA default action failed for {reference}: {error}"),
                id,
                "msaa_action_failed",
                true,
            ),
        }))
    }

    pub(in crate::host) fn do_toggle(&self, req: &Req) -> Res<Obj> {
        let reference = req.text("ref");
        let (element, window) = self.ref_record(&reference)?;
        if let Some(before) = element.toggle_state() {
            self.authorize_current(0)?;
            element.press()?;
            let after = wait_for_change(&before, || element.toggle_state());
            let verified = after != before;
            let message = format!("toggled {reference} from {before} to {after}");
            return Ok(self.action_result(
                "toggle",
                &format!("{}_toggle", self.semantic_words().0),
                effect(verified),
                verified,
                &message,
                None,
                "background",
                Some(window),
            ));
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

#[cfg(test)]
mod tests {
    use crate::host::semantic::observable::probe::{probe_node, Probe};
    use crate::host::semantic::tests::{host, named, part_node, snapshot, Log, Part};
    use std::rc::Rc;
    use crate::protocol::{Obj, Req};
    use serde_json::json;
    use std::cell::Cell;

    /// Invokes the one tree item of a window, in expand state `expand`.
    fn invoke(expand: &'static str, pressable: bool, selectable: bool) -> (Obj, Log) {
        let log = Log::default();
        let (host, _) = host(vec![part_node(Part {
            expand: Cell::new(Some(expand)),
            pressable,
            selectable,
            log: log.clone(),
            ..named("TreeItem", "key", "a")
        })]);
        snapshot(&host, json!({}));
        let result = host
            .do_invoke(&Req(json!({ "ref": "s1:e0" })), false)
            .expect("invoke")
            .expect("a semantic result");
        (result, log)
    }

    #[test]
    fn a_leaf_node_is_invoked_or_selected_instead_of_expanded() {
        let (result, log) = invoke("LeafNode", false, true);
        assert_eq!(result["path"], "a11y_selection");
        assert_eq!(*log.borrow(), ["select"]);
        let (result, log) = invoke("LeafNode", true, true);
        assert_eq!(result["path"], "a11y_invoke");
        assert_eq!(*log.borrow(), ["press"]);
        // With neither, nothing is sent.
        let (result, log) = invoke("LeafNode", false, false);
        assert_eq!(result["code"], "background_unavailable");
        assert!(log.borrow().is_empty());
    }

    #[test]
    fn a_collapsed_node_still_expands() {
        let (result, log) = invoke("Collapsed", true, true);
        assert_eq!(result["path"], "a11y_expand_collapse");
        assert_eq!(result["verified"], true);
        assert_eq!(*log.borrow(), ["expand"]);
        let (result, _) = invoke("PartiallyExpanded", true, true);
        assert_eq!(result["path"], "a11y_expand_collapse");
    }

    /// Invokes the one MSAA element of a window, `allow_native_click` as given.
    fn invoke_msaa(probe: Probe, allow_native_click: bool) -> (Option<Obj>, Rc<Probe>) {
        let probe = Rc::new(probe);
        let (host, _) = host(vec![probe_node(&probe)]);
        snapshot(&host, json!({}));
        let result = host
            .do_invoke(&Req(json!({ "ref": "s1:e0" })), allow_native_click)
            .expect("invoke");
        (result, probe)
    }

    #[test]
    fn a_disabled_msaa_element_is_refused_before_anything_is_sent() {
        let probe = Probe { enabled: Cell::new(false), ..Probe::default() };
        let (result, probe) = invoke_msaa(probe, true);
        let result = result.expect("a result");
        assert_eq!(result["code"], "element_disabled");
        assert!(probe.log.borrow().is_empty());
    }

    #[test]
    fn an_msaa_element_without_a_default_action_leaves_the_click_to_the_pointer() {
        let (result, probe) = invoke_msaa(Probe { action: " ", ..Probe::default() }, true);
        assert!(result.is_none() && probe.log.borrow().is_empty());
        // Without that allowance the press runs and reports its own error.
        let (result, _) = invoke_msaa(Probe { action: " ", failure: Some("MSAA element exposes no default action"), ..Probe::default() }, false);
        assert_eq!(result.expect("a result")["code"], "msaa_action_failed");
    }

    #[test]
    fn an_msaa_press_reports_the_default_action() {
        let (result, probe) = invoke_msaa(Probe::default(), false);
        let result = result.expect("a result");
        assert_eq!(result["path"], "msaa_default_action");
        assert_eq!(result["text"], "invoked s1:e0 through MSAA default action: Press");
        assert_eq!(result["verified"], false);
        assert_eq!(*probe.log.borrow(), ["press"]);
    }

    #[test]
    fn a_failed_msaa_press_may_have_run() {
        let (result, _) = invoke_msaa(Probe { failure: Some("boom"), ..Probe::default() }, false);
        let result = result.expect("a result");
        assert_eq!(result["code"], "msaa_action_failed");
        assert_eq!(result["text"], "MSAA default action failed for s1:e0: boom");
        assert_eq!(result["delivery_accepted"], serde_json::Value::Null);
        assert_eq!(result["input_may_have_executed"], true);
    }

    #[test]
    fn a_toggle_of_an_msaa_element_is_its_default_action() {
        let probe = Rc::new(Probe::default());
        let (host, _) = host(vec![probe_node(&probe)]);
        snapshot(&host, json!({}));
        let result = host.do_toggle(&Req(json!({ "ref": "s1:e0" }))).expect("toggle");
        assert_eq!((result["action"].as_str(), result["path"].as_str()), (Some("toggle"), Some("msaa_default_action")));
        assert_eq!(*probe.log.borrow(), ["press"]);
    }
}
