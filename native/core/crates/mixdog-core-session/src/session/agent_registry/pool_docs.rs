//! The two documents the Agents pool reads (`agent-tool/worker-index` `agent-workers.json` and
//! `lead-workers.json`), made from the worker maps the registry holds: the agents' rows and the
//! tombstones their reap left, and the Leads' pool rows, each row as stored. Node's listing reads both index files on every call (`listStoredAgentWorkersAsync`), so the
//! index is reloaded first; this process's writes not stored yet stay applied.

use serde_json::Value;
use serde_json::json;

use super::*;

impl AgentRegistry {
    /// `(agent index, lead index)`: `{ workers, tombstones }` and `{ workers }`, as stored now.
    pub async fn pool_index(&self) -> (Value, Value) {
        self.reload().await;
        let now = self.clock.now_ms() as f64;
        let state = self.lock();
        // A session's map is its Lead row unless the registry reads it as a worker row (`lead_row.rs`).
        let is_lead = |map: &Row| normalize_row(map).is_none();
        // The rows as stored (Node's listing reads both index files as written, `workerRows`), not as the registry
        // normalizes them for its own reads: the tombstone and the release stamp the header map also holds are not rows.
        let stored = |lead: bool| -> Vec<Value> {
            state
                .maps
                .iter()
                .filter(|(_, map)| !clean(map.get("sessionId")).is_empty() && is_lead(map) == lead)
                .map(|(_, map)| {
                    let mut row = map.clone();
                    row.shift_remove("tombstone");
                    row.shift_remove("releasedAt");
                    if released_at(map, now) {
                        row.insert("released".into(), Value::Bool(true));
                    }
                    Value::Object(row)
                })
                .collect()
        };
        let (workers, leads) = (stored(false), stored(true));
        let tombstones: Vec<Value> = state.stored_tombstones(now).into_iter().map(Value::Object).collect();
        (json!({ "workers": workers, "tombstones": tombstones }), json!({ "workers": leads }))
    }
}
