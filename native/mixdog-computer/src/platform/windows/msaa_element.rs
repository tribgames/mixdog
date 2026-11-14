//! An MSAA node as an accessibility element (MixMsaa.cs:81-132, the node a
//! ref holds): reads, the default action and value writes.

use super::background::{hold_inactive, release_inactive};
use super::msaa::{state_text, AccNode, MsaaNode};
use crate::a11y::{Element, Stale};
use crate::platform::Wid;
use crate::protocol::Obj;
use std::cell::RefCell;
use windows::Win32::UI::Accessibility::IAccessible;

/// The node a snapshot read, which every read of the element refreshes
/// (MixMsaaNode.Refresh) so a ref sees the control as it is now.
pub struct MsaaElement<A = IAccessible> {
    node: RefCell<MsaaNode<A>>,
    hold: Hold,
}

/// How a write keeps its window non-activatable; a test swaps in one that
/// touches no window.
struct Hold {
    acquire: fn(Wid) -> Wid,
    release: fn(Wid) -> Result<(), String>,
}

impl<A: AccNode> MsaaElement<A> {
    pub fn new(node: MsaaNode<A>) -> Self {
        Self::with_hold(
            node,
            Hold {
                acquire: hold_inactive,
                release: release_inactive,
            },
        )
    }

    fn with_hold(node: MsaaNode<A>, hold: Hold) -> Self {
        Self {
            node: RefCell::new(node),
            hold,
        }
    }

    /// Reads `field` of the node after a refresh; a failed refresh leaves the
    /// last read in place.
    fn live<T>(&self, field: impl FnOnce(&MsaaNode<A>) -> T) -> T {
        let mut node = self.node.borrow_mut();
        node.refresh();
        field(&node)
    }

    /// Runs one write on a refreshed node with its window held
    /// non-activatable, as UIA actions are: a legacy host may raise itself
    /// while it answers (MixMsaaNode.DoDefaultAction, SetValue).
    fn act<T>(&self, write: impl FnOnce(&MsaaNode<A>) -> Result<T, String>) -> Result<T, String> {
        let mut node = self.node.borrow_mut();
        if !node.refresh() {
            return Err("MSAA element is stale".into());
        }
        let held = (self.hold.acquire)(node.window);
        let outcome = write(&node);
        node.refresh();
        let released = (self.hold.release)(held);
        let value = outcome?;
        released?;
        Ok(value)
    }
}

impl<A: AccNode + 'static> Element for MsaaElement<A> {
    /// Get-MsaaIdentity: MSAA has no runtime id, so the role and name stand
    /// in.
    fn identity(&self) -> String {
        self.live(|node| format!("{}|{}", node.control_type(), node.name))
    }
    /// The role and name the snapshot read: no refresh, so handing out refs
    /// makes no cross-process call outside the snapshot's deadline.
    fn observed_identity(&self) -> String {
        let node = self.node.borrow();
        format!("{}|{}", node.control_type(), node.name)
    }
    fn window(&self) -> Wid {
        self.node.borrow().window
    }
    fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let mut node = self.node.borrow_mut();
        node.refresh()
            .then(|| (node.x as f64, node.y as f64, node.w as f64, node.h as f64))
    }
    fn enabled(&self) -> bool {
        self.live(|node| node.enabled())
    }
    /// The node still answers and has an area (Get-RefRecord's Refresh).
    fn alive(&self) -> bool {
        self.node.borrow_mut().refresh()
    }
    /// DoDefaultAction: the control's default action, when it has one.
    fn press(&self) -> Result<(), String> {
        self.act(MsaaNode::do_default_action)
    }
    fn can_press(&self) -> bool {
        self.live(|node| !node.default_action.trim().is_empty())
    }
    fn toggle_state(&self) -> Option<String> {
        None
    }
    fn expand_state(&self) -> Option<String> {
        None
    }
    fn set_expanded(&self, _: bool) -> Result<(), String> {
        Err("element cannot expand or collapse".into())
    }
    fn value(&self) -> Option<String> {
        self.live(|node| Some(node.value.clone()))
    }
    /// Get-MsaaObservation's CanSetValue: an edit or a combo box.
    fn settable(&self) -> bool {
        self.live(|node| matches!(node.control_type(), "Edit" | "ComboBox") && !node.read_only())
    }
    fn set_value(&self, text: &str) -> Result<(), String> {
        self.act(|node| node.acc.put_value(node.child, text))
    }
    fn can_select(&self) -> bool {
        false
    }
    fn select(&self) -> Result<(), String> {
        Err("element is not selectable".into())
    }
    fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
        Ok(None)
    }
    fn structure(&self) -> Obj {
        Obj::new()
    }
    fn source(&self) -> &'static str {
        "msaa"
    }
    fn default_action(&self) -> Option<String> {
        self.live(|node| {
            (!node.default_action.trim().is_empty()).then(|| node.default_action.clone())
        })
    }
    fn read_only(&self) -> bool {
        self.live(|node| node.read_only())
    }
    /// The node's PROTECTED state, read now; unreadable counts as protected.
    fn masked(&self) -> bool {
        self.node.borrow().is_protected()
    }
    fn control_type(&self) -> String {
        self.live(|node| node.control_type().to_string())
    }
    fn name(&self) -> String {
        self.live(|node| node.name.clone())
    }
    fn offscreen(&self) -> bool {
        self.live(|node| node.offscreen())
    }
    /// MixMsaaNode.ObservableState: empty when the node cannot be read.
    fn observable_state(&self) -> Option<String> {
        let mut node = self.node.borrow_mut();
        Some(if node.refresh() {
            format!("value={}|state={}", node.value, state_text(node.state))
        } else {
            String::new()
        })
    }
    /// Get-RefRecord's MSAA wording (input-refs.ps1:104-117).
    fn stale_message(&self, kind: Stale) -> Option<&'static str> {
        Some(match kind {
            Stale::Target => "is stale or its MSAA target changed",
            Stale::Identity => "no longer identifies the same element",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::windows::msaa::{Child, Reading};
    use std::rc::Rc;

    /// An accessible object that answers from a reading the test changes.
    #[derive(Clone)]
    struct Fake(Rc<RefCell<Option<Reading>>>, Rc<RefCell<Vec<String>>>);

    impl AccNode for Fake {
        fn identity(&self) -> usize {
            1
        }
        fn read(&self, _: i32) -> Option<Reading> {
            self.0.borrow().clone()
        }
        fn state(&self, _: i32) -> Option<u32> {
            self.0.borrow().as_ref().map(|reading| reading.state)
        }
        fn child_count(&self) -> Option<i32> {
            None
        }
        fn do_default_action(&self, child: i32) -> Result<(), String> {
            self.1.borrow_mut().push(format!("do {child}"));
            Ok(())
        }
        fn put_value(&self, child: i32, value: &str) -> Result<(), String> {
            self.1.borrow_mut().push(format!("put {child} {value}"));
            self.0.borrow_mut().as_mut().ok_or("gone")?.value = value.into();
            Ok(())
        }
        fn children(&self, _: i32, _: usize) -> Result<Vec<Child<Self>>, String> {
            Ok(Vec::new())
        }
    }

    fn button(name: &str) -> Reading {
        Reading {
            x: 10,
            y: 20,
            w: 30,
            h: 40,
            name: name.into(),
            role: 0x2B,
            default_action: "Press".into(),
            ..Reading::default()
        }
    }

    fn element(reading: Reading) -> (MsaaElement<Fake>, Rc<RefCell<Option<Reading>>>) {
        let (element, cell, _) = logged(reading);
        (element, cell)
    }

    /// An element whose calls are logged and whose window is never touched.
    fn logged(
        reading: Reading,
    ) -> (MsaaElement<Fake>, Rc<RefCell<Option<Reading>>>, Rc<RefCell<Vec<String>>>) {
        let cell = Rc::new(RefCell::new(Some(reading)));
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut node = MsaaNode::new(Fake(cell.clone(), log.clone()), 0, "0/1".into(), 7, "hwnd:0x7");
        node.refresh();
        let hold = Hold {
            acquire: |_| 0,
            release: |_| Ok(()),
        };
        (MsaaElement::with_hold(node, hold), cell, log)
    }

    #[test]
    fn the_identity_is_the_role_and_name_read_now() {
        let (element, cell) = element(button("OK"));
        assert_eq!(element.identity(), "Button|OK");
        assert_eq!(element.source(), "msaa");
        assert_eq!(element.window(), 7);
        cell.replace(Some(button("Cancel")));
        assert_eq!(element.identity(), "Button|Cancel");
        assert_eq!(
            element.stale_message(Stale::Identity),
            Some("no longer identifies the same element")
        );
    }

    #[test]
    fn a_node_that_cannot_be_read_is_not_alive() {
        let (element, cell) = element(button("OK"));
        assert!(element.alive());
        assert_eq!(element.bounds(), Some((10.0, 20.0, 30.0, 40.0)));
        cell.replace(None);
        assert!(!element.alive());
        assert_eq!(element.bounds(), None);
        // The last read stays.
        assert_eq!(element.name(), "OK");
        assert_eq!(
            element.stale_message(Stale::Target),
            Some("is stale or its MSAA target changed")
        );
        // An area of nothing is as dead as no answer.
        cell.replace(Some(Reading { w: 0, ..button("OK") }));
        assert!(!element.alive());
    }

    #[test]
    fn the_read_side_follows_the_state_flags() {
        let (element, cell) = element(Reading {
            role: 0x2A,
            state: 0x40,
            ..button("")
        });
        assert!(element.read_only() && !element.settable());
        assert!(element.can_press());
        assert_eq!(element.default_action().as_deref(), Some("Press"));
        assert!(!element.masked() && !element.offscreen() && element.enabled());
        cell.replace(Some(Reading {
            role: 0x2A,
            state: 0x1 | 0x2000_0000 | 0x10000,
            default_action: " ".into(),
            ..button("")
        }));
        assert!(element.settable() && !element.read_only());
        assert!(element.masked() && element.offscreen() && !element.enabled());
        assert!(!element.can_press() && element.default_action().is_none());
    }

    #[test]
    fn press_runs_the_default_action_of_a_readable_node() {
        let (element, _, log) = logged(button("OK"));
        assert_eq!(element.press(), Ok(()));
        assert_eq!(*log.borrow(), ["do 0"]);
    }

    #[test]
    fn press_refuses_a_stale_node_and_one_without_a_default_action() {
        let (element, cell, log) = logged(button("OK"));
        cell.replace(None);
        assert_eq!(element.press(), Err("MSAA element is stale".into()));
        cell.replace(Some(Reading { default_action: "  ".into(), ..button("OK") }));
        assert_eq!(element.press(), Err("MSAA element exposes no default action".into()));
        assert!(log.borrow().is_empty());
    }

    #[test]
    fn set_value_writes_and_reads_the_value_back() {
        let (element, _, log) = logged(Reading { role: 0x2A, ..button("") });
        assert_eq!(element.set_value("hi"), Ok(()));
        assert_eq!(*log.borrow(), ["put 0 hi"]);
        assert_eq!(element.value().as_deref(), Some("hi"));
        let (gone, cell, _) = logged(Reading { role: 0x2A, ..button("") });
        cell.replace(None);
        assert_eq!(gone.set_value("x"), Err("MSAA element is stale".into()));
    }

    #[test]
    fn the_observable_state_is_the_value_and_the_state_text() {
        let (element, cell, _) = logged(Reading { value: "v".into(), ..button("OK") });
        assert_eq!(element.observable_state().as_deref(), Some("value=v|state=normal"));
        cell.replace(None);
        assert_eq!(element.observable_state().as_deref(), Some(""));
    }
}
