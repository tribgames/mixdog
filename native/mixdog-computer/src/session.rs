//! Per-session state the host keeps across requests: the refs the last
//! capture handed out, focus bookkeeping, and input this session still holds.

use crate::a11y::{Element, Node};
use crate::platform::Wid;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

pub struct RefRecord {
    pub element: Rc<dyn Element>,
    pub window_id: String,
    pub generation: i64,
    pub identity: String,
    /// What the caller observed (Get-ElIdentity): the role, name, automation
    /// id and bounds a later action checks the live element against.
    pub role: String,
    pub name: String,
    pub automation_id: String,
    pub bounds: Option<(f64, f64, f64, f64)>,
    /// The tree the element came from; "" is the desktop's own.
    pub source: &'static str,
}

impl RefRecord {
    /// The record of a ref handed out for `node` by snapshot `generation`
    /// (Set-ElRef).
    pub fn new(node: &Node, window_id: String, generation: i64) -> RefRecord {
        RefRecord {
            element: node.element.clone(),
            window_id,
            generation,
            identity: node.element.observed_identity(),
            role: node.role.clone(),
            name: node.name.clone(),
            automation_id: node.automation_id.clone(),
            bounds: Some((node.x, node.y, node.width, node.height)),
            source: node.extra.source,
        }
    }
}

/// Where an abort returns the desktop: the session's first foreground
/// target, the window that had the focus before it, and the cursor then.
#[derive(Clone, Copy)]
pub struct RestorePoint {
    pub target: Wid,
    pub restore: Wid,
    pub cursor_x: i32,
    pub cursor_y: i32,
}

#[derive(Default)]
pub struct Session {
    pub refs: HashMap<String, RefRecord>,
    pub generation: i64,
    pub continuation: Option<String>,
    pub last_focus: Wid,
    pub original_focus: Wid,
    pub original_focus_monitor: String,
    pub original_focus_sequence: Option<i64>,
    /// Background pointer buttons pressed and not yet released, by window id.
    pub held_pointer: BTreeMap<String, (i32, i32)>,
    /// Foreground key streams held down, in press order: the stream and the
    /// modifiers and key it was pressed as, which its release lets go of.
    pub held_keys: Vec<(String, Vec<crate::keys::Mod>, crate::keys::Key)>,
    /// The last snapshot's element marks: mark number -> ref.
    pub marks: BTreeMap<i64, String>,
    /// The inactive scope a sequence keeps open on a window until its last
    /// step, by window.
    pub inactive_scopes: BTreeMap<Wid, u32>,
    /// Top-level windows seen taking the foreground during their own value
    /// write: window -> owner identity (session.ps1 ValueWriteActivators).
    pub value_write_activators: HashMap<Wid, String>,
    /// Recorded at the session's first foreground input.
    pub restore_point: Option<RestorePoint>,
    /// Background pointer releases a target never acknowledged, by window id
    /// with the point they were sent at, sent again at the end of the turn
    /// (MixWin32Message.RetryPendingReleases).
    pub pending_releases: BTreeMap<String, (i32, i32)>,
    /// The root window each held background pointer press keeps inactive, by
    /// window id.
    pub held_pointer_roots: BTreeMap<String, Wid>,
}

impl Session {
    /// Retires every ref handed out so far.
    pub fn invalidate_refs(&mut self) {
        self.refs.clear();
        self.generation += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a11y::testing::node;

    #[test]
    fn a_ref_record_carries_what_its_node_showed() {
        let mut seen = node("Button", "Save", (10.0, 20.0, 30.0, 40.0));
        seen.automation_id = "save".into();
        seen.extra.source = "msaa";
        let record = RefRecord::new(&seen, "hwnd:0x1".into(), 3);
        assert_eq!(record.window_id, "hwnd:0x1");
        assert_eq!(record.generation, 3);
        assert_eq!(record.identity, "inert");
        assert_eq!(record.role, "Button");
        assert_eq!(record.name, "Save");
        assert_eq!(record.automation_id, "save");
        assert_eq!(record.bounds, Some((10.0, 20.0, 30.0, 40.0)));
        assert_eq!(record.source, "msaa");
    }
}
