//! The element states an action can visibly change, read before and after
//! a native action to report whether it changed the target.

use crate::a11y::Element;
use crate::host::Host;
use std::rc::Rc;

impl Host {
    /// The element states an action can visibly change, joined for comparison.
    pub(in crate::host) fn observable_state(
        &self,
        element: &Rc<dyn Element>,
        action: &str,
    ) -> Option<String> {
        // An MSAA node reads as one piece (Get-ObservableTargetState).
        if element.source() == "msaa" {
            return element.observable_state();
        }
        let mut parts = Vec::new();
        if matches!(
            action,
            "click" | "double_click" | "right_click" | "middle_click" | "triple_click"
        ) {
            if let Some(toggle) = element.toggle_state() {
                parts.push(format!("toggle={toggle}"));
            }
            if let Some(selected) = element.selected() {
                parts.push(format!("selected={}", if selected { "True" } else { "False" }));
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
        if action == "scroll" {
            if let Some((horizontal, vertical)) = element.scroll_percent() {
                parts.push(format!("scroll={horizontal},{vertical}"));
            }
        }
        let native = self
            .desktop
            .background()
            .and_then(|background| background.native_state(element.native_handle(), action));
        parts.extend(native);
        (!parts.is_empty()).then(|| parts.join("|"))
    }
}

#[cfg(test)]
pub(in crate::host::semantic) mod probe {
    use crate::a11y::testing::node;
    use crate::a11y::{Element, Node};
    use crate::protocol::Obj;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    /// An element of window 1 that answers from its fields, logs the writes
    /// sent to it, and reads as the source it is given.
    pub struct Probe {
        pub source: &'static str,
        pub enabled: Cell<bool>,
        pub read_only: bool,
        pub action: &'static str,
        pub value: RefCell<String>,
        /// What a press or a write fails with.
        pub failure: Option<&'static str>,
        pub toggle: Option<&'static str>,
        pub selected: Option<bool>,
        pub expanded: Option<&'static str>,
        pub scroll: Option<(f64, f64)>,
        pub range: Option<&'static str>,
        /// What a write leaves in the value; the written text when unset.
        pub keeps: Option<&'static str>,
        pub log: RefCell<Vec<String>>,
    }

    impl Default for Probe {
        fn default() -> Self {
            Probe {
                source: "msaa",
                enabled: Cell::new(true),
                read_only: false,
                action: "Press",
                value: RefCell::default(),
                failure: None,
                toggle: None,
                selected: None,
                expanded: None,
                scroll: None,
                range: None,
                keeps: None,
                log: RefCell::default(),
            }
        }
    }

    impl Probe {
        fn note(&self, entry: String) -> Result<(), String> {
            match self.failure {
                Some(error) => Err(error.into()),
                None => {
                    self.log.borrow_mut().push(entry);
                    Ok(())
                }
            }
        }
    }

    impl Element for Rc<Probe> {
        fn identity(&self) -> String {
            "probe".into()
        }
        fn window(&self) -> u64 {
            1
        }
        fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
            Some((10.0, 10.0, 20.0, 20.0))
        }
        fn enabled(&self) -> bool {
            self.enabled.get()
        }
        fn alive(&self) -> bool {
            true
        }
        fn press(&self) -> Result<(), String> {
            self.note("press".into())
        }
        fn can_press(&self) -> bool {
            true
        }
        fn toggle_state(&self) -> Option<String> {
            self.toggle.map(String::from)
        }
        fn expand_state(&self) -> Option<String> {
            self.expanded.map(String::from)
        }
        fn set_expanded(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn value(&self) -> Option<String> {
            Some(self.value.borrow().clone())
        }
        fn settable(&self) -> bool {
            true
        }
        fn set_value(&self, text: &str) -> Result<(), String> {
            self.note(format!("set {text}"))?;
            *self.value.borrow_mut() = self.keeps.unwrap_or(text).into();
            Ok(())
        }
        fn can_select(&self) -> bool {
            false
        }
        fn select(&self) -> Result<(), String> {
            Ok(())
        }
        fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
            Ok(None)
        }
        fn structure(&self) -> Obj {
            Obj::new()
        }
        fn range_value(&self) -> Option<String> {
            self.range.map(String::from)
        }
        fn control_type(&self) -> String {
            "Button".into()
        }
        fn name(&self) -> String {
            "OK".into()
        }
        fn source(&self) -> &'static str {
            self.source
        }
        fn default_action(&self) -> Option<String> {
            Some(self.action.to_string())
        }
        fn read_only(&self) -> bool {
            self.read_only
        }
        fn selected(&self) -> Option<bool> {
            self.selected
        }
        fn scroll_percent(&self) -> Option<(f64, f64)> {
            self.scroll
        }
        fn observable_state(&self) -> Option<String> {
            Some(format!("value={}|state=normal", self.value.borrow()))
        }
    }

    /// The node a snapshot reads for `probe`.
    pub fn probe_node(probe: &Rc<Probe>) -> Node {
        let mut seen = node("Button", "OK", (10.0, 10.0, 20.0, 20.0));
        seen.element = Rc::new(probe.clone());
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::probe::{probe_node, Probe};
    use crate::host::semantic::tests::{host, snapshot};
    use serde_json::json;
    use std::rc::Rc;

    fn state(probe: Probe, action: &str) -> Option<String> {
        let probe = Rc::new(probe);
        let (host, _) = host(vec![probe_node(&probe)]);
        snapshot(&host, json!({}));
        let (element, _) = host.ref_record("s1:e0").expect("ref");
        host.observable_state(&element, action)
    }

    #[test]
    fn a_click_reads_toggle_selected_and_expanded_in_that_order() {
        let probe = || Probe {
            source: "uia",
            toggle: Some("On"),
            selected: Some(false),
            expanded: Some("Collapsed"),
            scroll: Some((0.0, 12.5)),
            range: Some("3"),
            ..Probe::default()
        };
        assert_eq!(state(probe(), "click").as_deref(), Some("toggle=On|selected=False|expanded=Collapsed"));
        assert_eq!(state(probe(), "scroll").as_deref(), Some("scroll=0,12.5"));
        assert_eq!(state(probe(), "drag").as_deref(), Some("range=3"));
        assert_eq!(state(probe(), "key").as_deref(), Some("value="));
        assert_eq!(state(Probe { source: "uia", ..Probe::default() }, "click"), None);
    }

    #[test]
    fn an_msaa_ref_reads_its_value_and_state_whatever_the_action() {
        let probe = Probe { value: "v".to_string().into(), ..Probe::default() };
        assert_eq!(state(probe, "scroll").as_deref(), Some("value=v|state=normal"));
    }
}
