//! The session usage totals of `session-usage-totals.test.mjs` replayed against Node's recording
//! (`fixtures/session-usage-totals/golden.json`, `benchmarks/rust-core/recorders/record-session-usage-totals.mjs`):
//! the helper (`:13`) and the stored pool rows (`:46`) the pool lists over the recorded files.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;

use super::AgentPool;
use super::HEADER_FIELDS;
use super::PoolLive;
use super::PoolStore;
use super::Row;
use super::RuntimeEntry;
use super::usage_totals;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/session-usage-totals/golden.json")).unwrap()
}

#[test]
fn session_usage_totals_equal_node() {
    for case in golden()["cases"].as_array().unwrap() {
        let (usage, tool_calls) = usage_totals(case["session"].as_object());
        let totals = json!({"usage": usage.unwrap_or(Value::Null), "toolCalls": tool_calls.unwrap_or(Value::Null)});
        assert_eq!(totals, case["totals"], "{}", case["session"]);
    }
}

/// The recorded data directory, with nothing live at the recorded clock.
struct Files {
    stored: Value,
}

#[async_trait]
impl PoolStore for Files {
    async fn agent_index(&self) -> Option<Value> {
        self.stored["files"]["agentIndex"].as_str().and_then(|text| serde_json::from_str(text).ok())
    }

    async fn lead_index(&self) -> Option<Value> {
        self.stored["files"]["leadIndex"].as_str().and_then(|text| serde_json::from_str(text).ok())
    }

    async fn headers(&self, session_ids: &[String]) -> Vec<Option<Row>> {
        session_ids
            .iter()
            .map(|id| {
                let text = self.stored["files"]["headers"][id].as_str()?;
                let doc: Row = serde_json::from_str(text).ok()?;
                Some(HEADER_FIELDS.iter().filter_map(|key| doc.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect())
            })
            .collect()
    }
}

impl PoolLive for Files {
    fn now(&self) -> f64 {
        self.stored["now"].as_f64().unwrap()
    }
    fn running(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn awaiting_shell(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn live_session(&self, _: &str) -> Option<Value> {
        None
    }
    fn runtime_entry(&self, _: &str) -> Option<RuntimeEntry> {
        None
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, agent: Option<&str>) -> f64 {
        panic!("no row is working, so no stall point is read ({agent:?})")
    }
}

#[tokio::test]
async fn the_stored_pool_rows_carry_the_totals_as_node_listed_them() {
    let stored = golden()["stored"].clone();
    assert_eq!(stored["syncRows"], stored["rows"], "Node's sync and async listings agree");
    let files = Arc::new(Files { stored: stored.clone() });
    let rows = AgentPool::new(files.clone(), files).list().await.unwrap();
    assert_eq!(Value::Array(rows), stored["rows"]);
}
