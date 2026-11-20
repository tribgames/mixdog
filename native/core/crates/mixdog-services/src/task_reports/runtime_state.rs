//! The process-global runtime liveness map and its turn-activity read
//! (`runtime/agent/orchestrator/session/manager/runtime-state.mjs`). The session runtime writes an
//! entry per session it runs (`set_entry` / `remove_entry`) and wraps a turn's dispatch in
//! [`RuntimeLiveness::dispatched`]; [`RuntimeLiveness::in_flight_session_activity`] answers which
//! turns are running. The report host's `AgentRegistry::in_flight` and the pool's
//! `PoolLive::running` read it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use mixdog_js::{js_trim, value_to_string};
use serde_json::Value;

use super::host::InFlight;

/// Stages that still own live provider or tool work (`IN_FLIGHT_STAGES`).
pub const IN_FLIGHT_STAGES: [&str; 5] = ["connecting", "requesting", "streaming", "tool_running", "cancelling"];

/// One session's runtime entry (`runtimeState` value): only the fields the activity read looks at.
#[derive(Clone, Debug, Default)]
pub struct RuntimeEntry {
    /// `entry.closed === true`.
    pub closed: bool,
    /// `entry.controller && !entry.controller.signal?.aborted`.
    pub controller_live: bool,
    pub stage: Option<String>,
    /// The entry's session record (`entry.session`): its [`SESSION_FIELDS`](Self::SESSION_FIELDS), as
    /// [`session_of`](Self::session_of) takes them from the session's header.
    pub session: Value,
}

impl RuntimeEntry {
    /// The fields of [`session`](Self::session) the activity read looks at.
    pub const SESSION_FIELDS: [&'static str; 4] = ["owner", "agent", "ownerSessionId", "parentSessionId"];

    /// The session record of an entry for the session with `header`: the [`SESSION_FIELDS`](Self::SESSION_FIELDS) it
    /// holds, and nothing else of it (a live entry keeps no copy of the header's catalogs).
    pub fn session_of(header: &serde_json::Map<String, Value>) -> Value {
        Value::Object(Self::SESSION_FIELDS.iter().filter_map(|key| header.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect())
    }

    /// `isTurnInFlight(entry)`.
    pub fn is_turn_in_flight(&self) -> bool {
        if self.closed {
            return false;
        }
        self.controller_live || self.stage.as_deref().is_some_and(|stage| IN_FLIGHT_STAGES.contains(&stage))
    }
}

/// The runtime map and the dispatched-turn counts.
#[derive(Default)]
pub struct RuntimeLiveness {
    // Ordered, so a read walks the entries the same way every time.
    entries: Mutex<BTreeMap<String, RuntimeEntry>>,
    dispatched: Mutex<HashMap<String, usize>>,
    /// The most recent request of the active turn, not a copy of the session's configured route.
    request_routes: Mutex<HashMap<String, Arc<serde_json::Map<String, Value>>>>,
    /// Told each time a session starts or stops counting as working. The `agentPool` section lists from the working set
    /// and is pushed only when woken: without this a turn that starts or ends after a listing leaves the pool showing the
    /// old set (Node's desktop re-read the pool every 2 s while an agent was active).
    working_changed: OnceLock<Arc<dyn Fn() + Send + Sync>>,
}

/// A turn counted as working until it is dropped (`whileTurnDispatched`).
#[must_use = "the turn counts as dispatched only while the guard lives"]
pub struct Dispatched {
    liveness: Arc<RuntimeLiveness>,
    id: String,
}

impl Drop for Dispatched {
    fn drop(&mut self) {
        let before = self.liveness.working(&self.id);
        {
            let mut counts = self.liveness.dispatched.lock().expect("dispatched turns");
            match counts.get(&self.id).copied() {
                Some(left) if left > 1 => {
                    counts.insert(self.id.clone(), left - 1);
                }
                _ => {
                    counts.remove(&self.id);
                }
            }
        }
        self.liveness.tell_if_moved(&self.id, before);
    }
}

impl RuntimeLiveness {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Binds the one listener told when a session starts or stops counting as working; `false` when one is bound already.
    pub fn bind_working_changed(&self, listener: Arc<dyn Fn() + Send + Sync>) -> bool {
        self.working_changed.set(listener).is_ok()
    }

    /// Whether `id` is in [`in_flight_session_activity`](Self::in_flight_session_activity)'s `working`.
    fn working(&self, id: &str) -> bool {
        if self.dispatched.lock().expect("dispatched turns").contains_key(id) {
            return true;
        }
        self.entries.lock().expect("runtime entries").get(id).is_some_and(RuntimeEntry::is_turn_in_flight)
    }

    fn tell_if_moved(&self, id: &str, before: bool) {
        if self.working(id) != before
            && let Some(listener) = self.working_changed.get()
        {
            listener();
        }
    }

    pub fn set_entry(&self, id: &str, entry: RuntimeEntry) {
        let before = self.working(id);
        self.entries.lock().expect("runtime entries").insert(id.to_owned(), entry);
        self.tell_if_moved(id, before);
    }

    pub fn remove_entry(&self, id: &str) {
        let before = self.working(id);
        self.request_routes.lock().expect("request routes").remove(id);
        self.entries.lock().expect("runtime entries").remove(id);
        self.tell_if_moved(id, before);
    }

    pub fn request_route(&self, id: &str) -> Option<Arc<serde_json::Map<String, Value>>> {
        self.request_routes.lock().expect("request routes").get(id).cloned()
    }

    /// A fallback or effort change can change the row without changing the working set.
    pub fn publish_request_route(&self, id: &str, route: serde_json::Map<String, Value>) {
        {
            let mut routes = self.request_routes.lock().expect("request routes");
            if routes.get(id).is_some_and(|current| **current == route) {
                return;
            }
            routes.insert(id.to_owned(), Arc::new(route));
        }
        if let Some(listener) = self.working_changed.get() {
            listener();
        }
    }

    /// `whileTurnDispatched(id, run)`: `id` counts as working until the guard drops, covering the
    /// gap before the turn's own entry is in flight.
    pub fn dispatched(self: &Arc<Self>, id: &str) -> Dispatched {
        let before = self.working(id);
        *self.dispatched.lock().expect("dispatched turns").entry(id.to_owned()).or_insert(0) += 1;
        self.tell_if_moved(id, before);
        Dispatched { liveness: Arc::clone(self), id: id.to_owned() }
    }

    /// `inFlightSessionActivity()`: `working` holds the ids whose turn is in flight, and
    /// `agent_working` the owner (Lead) ids of every in-flight Agent session.
    pub fn in_flight_session_activity(&self) -> InFlight {
        let mut working: HashSet<String> = self.dispatched.lock().expect("dispatched turns").keys().cloned().collect();
        let mut agent_working = HashSet::new();
        for (id, entry) in self.entries.lock().expect("runtime entries").iter() {
            if !entry.is_turn_in_flight() {
                continue;
            }
            working.insert(id.clone());
            let owner_session_id = js_trim(&text_of(&first_truthy(&entry.session, "ownerSessionId", "parentSessionId"))).to_owned();
            let agent = lower(&entry.session, "agent");
            if !owner_session_id.is_empty() && owner_session_id != *id && (lower(&entry.session, "owner") == "agent" || (!agent.is_empty() && agent != "lead"))
            {
                agent_working.insert(owner_session_id);
            }
        }
        InFlight { working, agent_working }
    }
}

/// JS truthiness of a JSON value.
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `session?.[a] || session?.[b] || ''`.
fn first_truthy(session: &Value, a: &str, b: &str) -> Value {
    [a, b].iter().filter_map(|key| session.get(*key)).find(|value| truthy(value)).cloned().unwrap_or(Value::Null)
}

/// `String(value || '')`.
fn text_of(value: &Value) -> String {
    if truthy(value) { value_to_string(value) } else { String::new() }
}

/// `cleanLower(session?.[key])`.
fn lower(session: &Value, key: &str) -> String {
    let value = session.get(key).cloned().unwrap_or(Value::Null);
    js_trim(&text_of(&value)).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(set: &HashSet<String>) -> Vec<String> {
        let mut names: Vec<String> = set.iter().cloned().collect();
        names.sort();
        names
    }

    fn answer(activity: &InFlight) -> (Vec<String>, Vec<String>) {
        (names(&activity.working), names(&activity.agent_working))
    }

    #[test]
    fn an_entry_removed_or_closed_stops_working() {
        let live = RuntimeLiveness::new();
        live.set_entry(
            "a",
            RuntimeEntry { stage: Some("streaming".into()), session: json!({"owner": "agent", "ownerSessionId": "lead"}), ..RuntimeEntry::default() },
        );
        assert_eq!(answer(&live.in_flight_session_activity()), (vec!["a".to_owned()], vec!["lead".to_owned()]));
        live.set_entry("a", RuntimeEntry { closed: true, stage: Some("streaming".into()), ..RuntimeEntry::default() });
        assert_eq!(answer(&live.in_flight_session_activity()), (vec![], vec![]));
        live.remove_entry("a");
        assert_eq!(answer(&live.in_flight_session_activity()), (vec![], vec![]));
    }

    /// The `agentPool` section is re-listed only when woken: every move of a session into or out of `working` tells the
    /// listener, and a change that leaves `working` as it was (a second dispatch, a stage within the turn) tells nothing.
    #[test]
    fn a_session_starting_or_stopping_work_tells_the_listener() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let live = RuntimeLiveness::new();
        let told = Arc::new(AtomicUsize::new(0));
        let counter = told.clone();
        assert!(live.bind_working_changed(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })));
        let told = || told.load(Ordering::SeqCst);
        let first = live.dispatched("child");
        assert_eq!(told(), 1, "a dispatched turn starts working");
        let second = live.dispatched("child");
        live.set_entry("child", RuntimeEntry { stage: Some("streaming".into()), controller_live: true, ..RuntimeEntry::default() });
        live.set_entry("child", RuntimeEntry { stage: Some("tool_running".into()), controller_live: true, ..RuntimeEntry::default() });
        drop(first);
        assert_eq!(told(), 1, "still working: nothing to tell");
        live.remove_entry("child");
        drop(second);
        assert_eq!(told(), 2, "the last guard ends the work");
        live.set_entry("worker", RuntimeEntry { stage: Some("streaming".into()), ..RuntimeEntry::default() });
        assert_eq!(told(), 3, "an in-flight entry starts working");
        live.set_entry("worker", RuntimeEntry { closed: true, stage: Some("streaming".into()), ..RuntimeEntry::default() });
        assert_eq!(told(), 4, "a closed entry stops working");
    }
}
