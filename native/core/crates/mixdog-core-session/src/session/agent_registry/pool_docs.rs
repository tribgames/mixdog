//! The two documents the Agents pool reads (`agent-tool/worker-index` `agent-workers.json` and
//! `lead-workers.json`), made from the worker maps the registry holds: the agents' rows and the
//! tombstones their reap left, and the Leads' pool rows (normalized as `normalizeLeadRows` leaves
//! them). The registry's maps are the index as last loaded with this process's writes, so the
//! documents read as the registry reads.

use serde_json::Value;
use serde_json::json;

use super::*;

impl AgentRegistry {
    /// `(agent index, lead index)`: `{ workers, tombstones }` and `{ workers }`.
    pub fn pool_index(&self) -> (Value, Value) {
        let now = self.clock.now_ms() as f64;
        let state = self.lock();
        let is_lead = |row: &Row| is_lead_pool_agent(row.get("agent"));
        let workers: Vec<Value> = state.all_rows(now).into_iter().filter(|row| !is_lead(row)).map(Value::Object).collect();
        let leads: Vec<Value> = state
            .maps
            .iter()
            .filter(|(_, map)| !clean(map.get("sessionId")).is_empty() && is_lead(map))
            .map(|(id, map)| Value::Object(super::lead_row::normalized(map, id)))
            .collect();
        let tombstones: Vec<Value> = state.stored_tombstones(now).into_iter().map(Value::Object).collect();
        (json!({ "workers": workers, "tombstones": tombstones }), json!({ "workers": leads }))
    }
}
