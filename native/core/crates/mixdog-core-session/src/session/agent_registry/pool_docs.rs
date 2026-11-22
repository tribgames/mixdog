//! The two documents the Agents pool reads (`agent-tool/worker-index` `agent-workers.json` and
//! `lead-workers.json`), made from the worker maps the registry holds: the agents' rows and the
//! tombstones their reap left, and the Leads' pool rows, each row as stored. Node's listing reads both index files on every call (`listStoredAgentWorkersAsync`), so the
//! index is reloaded first; this process's writes not stored yet stay applied.

use mixdog_core_agents::agents::SettleFix;
use serde_json::Value;
use serde_json::json;

use super::*;

impl AgentRegistry {
    /// `(agent index, lead index)`: `{ workers, tombstones }` and `{ workers }`, as stored now. `Err` when the stored rows
    /// could not be read whole: the documents would be short of a worker.
    pub async fn pool_index(&self) -> Result<(Value, Value), String> {
        // A worker whose session is held for its sensitive rewrite is answered by the store without its content, and
        // such a map is no row of the documents: the worker would be missing from them. It is held, not gone and not
        // failed, so the documents wait for its rewrite and are made from the rows read after it; a rewrite that failed
        // is their failure.
        loop {
            self.reload().await?;
            let held = self.store.held_workers().await?;
            if held.is_empty() {
                break;
            }
            for session in &held {
                self.store.rewrite_settled(session).await?;
            }
        }
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
        let workers = stored(false);
        // The Leads' rows: those of the Lead index (`lead-workers.json`'s place, `lead_row.rs`), then a migrated header row of a
        // Lead the index holds nothing of.
        let mut leads: Vec<Value> = state.lead_rows.values().flatten().map(|row| Value::Object(row.clone())).collect();
        leads.extend(stored(true).into_iter().filter(|row| !state.lead_rows.contains_key(&clean(row.get("sessionId")))));
        let tombstones: Vec<Value> = state.stored_tombstones(now).iter().map(|row| Value::Object(row.clone())).collect();
        Ok((json!({ "workers": workers, "tombstones": tombstones }), json!({ "workers": leads })))
    }

    /// `PoolStore::settle_identities`: each worker row keeps the settle identity of its outcome as `settledAt`, with the count
    /// of turns started on it ([`STARTED_TURNS`]) it belongs to as `settledTurn`. A whole-row write merges onto the stored row
    /// and a restart settlement clones it, so neither a later scan of the same turn nor the restart moves them; only a new
    /// turn id does, and the identity fixed for that next outcome is always later than the one before.
    pub fn settle_identities(&self, fixes: &[SettleFix]) -> Vec<Value> {
        let now = self.now();
        let mut guard = self.lock();
        let st = &mut *guard;
        fixes
            .iter()
            .map(|fix| {
                let Some(mut map) = st.map(&fix.session_id).filter(|map| normalize_row(map).is_some()).cloned() else { return Value::Null };
                if started_turns(&map) != fix.turns {
                    return Value::Null;
                }
                let held = map.get(SETTLED_AT).filter(|at| stamp_ms(Some(at)) > 0.0).cloned();
                if map.get(SETTLED_TURN).and_then(Value::as_u64) == Some(fix.turns)
                    && let Some(held) = held
                {
                    return held;
                }
                let floor = stamp_ms(held.as_ref());
                let identity = if stamp_ms(Some(&fix.candidate)) > floor { fix.candidate.clone() } else { Value::String(iso(now.max(floor + 1.0))) };
                map.insert(SETTLED_AT.into(), identity.clone());
                map.insert(SETTLED_TURN.into(), Value::from(fix.turns));
                self.persist(st, &fix.session_id, Some(map));
                identity
            })
            .collect()
    }
}

/// How many turns were started on a worker row; a row that never counted one holds none.
const STARTED_TURNS: &str = "startedTurns";
/// The id of the last turn [`STARTED_TURNS`] counted.
const COUNTED_TURN: &str = "countedTurn";
const SETTLED_AT: &str = "settledAt";
const SETTLED_TURN: &str = "settledTurn";

fn started_turns(map: &Row) -> u64 {
    map.get(STARTED_TURNS).and_then(Value::as_u64).unwrap_or(0)
}

/// Counts the turn `turn_id` on the worker row `map`, once per turn id: two turns started in the same millisecond are two
/// turns, and the same start told again is one. Whether it counted.
pub(super) fn count_turn_start(map: &mut Row, turn_id: &str) -> bool {
    if map.get(COUNTED_TURN).and_then(Value::as_str) == Some(turn_id) {
        return false;
    }
    let turns = started_turns(map) + 1;
    map.insert(STARTED_TURNS.into(), Value::from(turns));
    map.insert(COUNTED_TURN.into(), Value::String(turn_id.to_owned()));
    true
}
