//! The process-global runtime liveness map and its turn-activity read
//! (`runtime/agent/orchestrator/session/manager/runtime-state.mjs`). The session runtime writes an
//! entry per session it runs (`set_entry` / `remove_entry`) and wraps a turn's dispatch in
//! [`RuntimeLiveness::dispatched`]; [`RuntimeLiveness::in_flight_session_activity`] answers which
//! turns are running. The report host's `AgentRegistry::in_flight` and the pool's
//! `PoolLive::running` read it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

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
    /// The entry's session record (`entry.session`): `owner`, `agent`, `ownerSessionId`, `parentSessionId`.
    pub session: Value,
}

impl RuntimeEntry {
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
}

/// A turn counted as working until it is dropped (`whileTurnDispatched`).
#[must_use = "the turn counts as dispatched only while the guard lives"]
pub struct Dispatched {
    liveness: Arc<RuntimeLiveness>,
    id: String,
}

impl Drop for Dispatched {
    fn drop(&mut self) {
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
}

impl RuntimeLiveness {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set_entry(&self, id: &str, entry: RuntimeEntry) {
        self.entries.lock().expect("runtime entries").insert(id.to_owned(), entry);
    }

    pub fn remove_entry(&self, id: &str) {
        self.entries.lock().expect("runtime entries").remove(id);
    }

    /// `whileTurnDispatched(id, run)`: `id` counts as working until the guard drops, covering the
    /// gap before the turn's own entry is in flight.
    pub fn dispatched(self: &Arc<Self>, id: &str) -> Dispatched {
        *self.dispatched.lock().expect("dispatched turns").entry(id.to_owned()).or_insert(0) += 1;
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
            if !owner_session_id.is_empty() && owner_session_id != *id && (lower(&entry.session, "owner") == "agent" || (!agent.is_empty() && agent != "lead")) {
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

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/session-activity/golden.json");

    fn entry_of(spec: &Value) -> RuntimeEntry {
        RuntimeEntry {
            closed: spec.get("closed") == Some(&Value::Bool(true)),
            // The recorded spec names the controller `"live"` or `"aborted"`; Node builds `{ signal: { aborted } }` from it.
            controller_live: spec.get("controller").and_then(Value::as_str) == Some("live"),
            stage: spec.get("stage").and_then(Value::as_str).map(str::to_owned),
            session: spec.get("session").cloned().unwrap_or(Value::Null),
        }
    }

    fn names(set: &HashSet<String>) -> Vec<String> {
        let mut names: Vec<String> = set.iter().cloned().collect();
        names.sort();
        names
    }

    fn strings(value: &Value) -> Vec<String> {
        value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
    }

    fn answer(activity: &InFlight) -> (Vec<String>, Vec<String>) {
        (names(&activity.working), names(&activity.agent_working))
    }

    #[test]
    fn the_in_flight_stages_equal_node() {
        let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
        assert_eq!(strings(&golden["inFlight"]["stages"]), IN_FLIGHT_STAGES.map(str::to_owned));
    }

    #[test]
    fn the_activity_of_every_recorded_case_equals_node() {
        let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
        for case in golden["inFlight"]["cases"].as_array().unwrap() {
            let live = RuntimeLiveness::new();
            for (id, spec) in case["entries"].as_object().unwrap() {
                live.set_entry(id, entry_of(spec));
            }
            let guards: Vec<_> = strings(&case["dispatched"]).iter().map(|id| live.dispatched(id)).collect();
            let expected = |key: &str| (strings(&case[key]["working"]), strings(&case[key]["agentWorking"]));
            assert_eq!(answer(&live.in_flight_session_activity()), expected("during"), "{}", case["name"]);
            drop(guards);
            assert_eq!(answer(&live.in_flight_session_activity()), expected("after"), "{} after", case["name"]);
        }
    }

    #[test]
    fn a_session_dispatched_twice_works_until_both_runs_settle() {
        let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
        let steps = golden["inFlight"]["sequence"].as_array().unwrap();
        let live = RuntimeLiveness::new();
        let (first, second) = (live.dispatched("s"), live.dispatched("s"));
        let expect = |i: usize| (strings(&steps[i]["working"]), strings(&steps[i]["agentWorking"]));
        assert_eq!(answer(&live.in_flight_session_activity()), expect(0));
        drop(first);
        assert_eq!(answer(&live.in_flight_session_activity()), expect(1));
        drop(second);
        assert_eq!(answer(&live.in_flight_session_activity()), expect(2));
        // A run that fails still ends its count: the guard drops on the way out.
        let run = |live: &Arc<RuntimeLiveness>| -> Result<(), &str> {
            let _turn = live.dispatched("t");
            assert_eq!(answer(&live.in_flight_session_activity()), expect(3));
            Err("boom")
        };
        assert_eq!(run(&live), Err("boom"));
        assert_eq!(answer(&live.in_flight_session_activity()), expect(4));
    }

    #[test]
    fn an_entry_removed_or_closed_stops_working() {
        let live = RuntimeLiveness::new();
        live.set_entry("a", RuntimeEntry { stage: Some("streaming".into()), session: json!({"owner": "agent", "ownerSessionId": "lead"}), ..RuntimeEntry::default() });
        assert_eq!(answer(&live.in_flight_session_activity()), (vec!["a".to_owned()], vec!["lead".to_owned()]));
        live.set_entry("a", RuntimeEntry { closed: true, stage: Some("streaming".into()), ..RuntimeEntry::default() });
        assert_eq!(answer(&live.in_flight_session_activity()), (vec![], vec![]));
        live.remove_entry("a");
        assert_eq!(answer(&live.in_flight_session_activity()), (vec![], vec![]));
    }
}