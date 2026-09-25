//! Per-session state the host keeps across requests: the refs the last
//! capture handed out, focus bookkeeping, and input this session still holds.

use crate::a11y::Element;
use crate::platform::Wid;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

pub struct RefRecord {
    pub element: Rc<dyn Element>,
    pub window_id: String,
    pub generation: i64,
    pub identity: String,
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
    /// Foreground key streams held down, in press order.
    pub held_keys: Vec<String>,
}

impl Session {
    /// Retires every ref handed out so far.
    pub fn invalidate_refs(&mut self) {
        self.refs.clear();
        self.generation += 1;
    }
}
