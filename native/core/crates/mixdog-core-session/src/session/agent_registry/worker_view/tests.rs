//! The worker status view against Node's real list and guard
//! (`fixtures/agent/jobs/worker-states.json`, from `benchmarks/rust-core/recorders/record-worker-states.mjs`):
//! each case seeds the worker index with the recorded rows and answers the listed workers'
//! `status`/`stage` and the busy-workers count Node's `createAgentList` and `assertLeadIdle` did.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use serde_json::Value;
use serde_json::json;

use super::*;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/agent/jobs/worker-states.json");

struct Store(Mutex<Vec<(String, Row)>>);

#[async_trait]
impl WorkerStore for Store {
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(self.0.lock().unwrap().clone())
    }

    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(Vec::new())
    }

    async fn header(&self, _: &str) -> Option<Row> {
        None
    }

    async fn is_directory(&self, _: &str) -> bool {
        false
    }

    fn write(&self, session: &str, worker: Option<Row>) {
        let mut maps = self.0.lock().unwrap();
        maps.retain(|(id, _)| id != session);
        if let Some(map) = worker {
            maps.insert(0, (session.to_owned(), map));
        }
    }
}

struct Idle;

impl LiveSessions for Idle {
    fn loaded(&self) -> Vec<String> {
        Vec::new()
    }

    fn header(&self, _: &str) -> Option<Row> {
        None
    }

    fn running(&self, _: &str) -> bool {
        false
    }

    fn has_live_work(&self, _: &str) -> bool {
        false
    }

    fn runtime_stage(&self, _: &str) -> Option<String> {
        None
    }
}

struct Hour;

impl ReapWindow for Hour {
    fn terminal_reap_ms(&self, _: &str) -> f64 {
        3_600_000.0
    }
}

struct At(AtomicI64);

impl Clock for At {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn the_worker_view_equals_nodes_agent_list_and_busy_worker_guard() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let now = golden["now"].as_i64().unwrap();
    let scope = Scope { caller_session_id: Some("lead-a".to_owned()), host_pid: None };
    let by_session = |states: &mut Vec<Value>| states.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
    let mut busy_cases = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let maps = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| (row["sessionId"].as_str().unwrap().to_owned(), row.as_object().unwrap().clone()))
            .collect();
        let registry = AgentRegistry::new(Arc::new(Store(Mutex::new(maps))), Arc::new(Idle), Arc::new(Hour), Arc::new(At(AtomicI64::new(now))));
        let mut got: Vec<Value> = registry
            .worker_states(&scope)
            .await
            .into_iter()
            .map(|w| json!({ "sessionId": w.session_id, "status": w.status, "stage": w.stage }))
            .collect();
        let mut want = case["listed"].as_array().unwrap().clone();
        by_session(&mut got);
        by_session(&mut want);
        assert_eq!(got, want, "{name}: listed");
        assert_eq!(registry.busy_worker_count(&scope).await, case["busy"].as_u64().unwrap(), "{name}: busy");
        busy_cases += usize::from(case["busy"].as_u64().unwrap() > 0);
    }
    assert!(busy_cases > 100, "the golden holds busy cases: {busy_cases}");
}