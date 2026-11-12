//! Node's stale worker-row cases (`fixtures/stale-rows-cases`, `record-stale-rows-cases.mjs`): the recorded rows in the
//! store, the registry refreshed (`transitionStaleNonterminalRows`) under the recorded config's reap window
//! (`agent_terminal_reap_ms`) and what this process holds live; the rows kept, the tombstones left and each scan
//! decision (`blocks_scan`, no tombstones) against Node's.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use std::collections::HashMap;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use mixdog_agent::compact::settings::agent_terminal_reap_ms;
use serde_json::json;

use super::*;

#[derive(Default)]
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
        let at = maps.iter().position(|(id, _)| id == session);
        match (at, worker) {
            (Some(i), Some(m)) => maps[i].1 = m,
            (Some(i), None) => {
                maps.remove(i);
            }
            (None, Some(m)) => maps.insert(0, (session.to_owned(), m)),
            (None, None) => {}
        }
    }
    /// This store never stops listing a session's map: nothing is kept apart.
    fn keep(&self, session: &str, worker: Option<Row>) {
        self.write(session, worker);
    }
    fn kept(&self, _: &str) -> bool {
        false
    }
}

/// What each session is doing in this process (`isSessionTurnInFlight`, `hasPendingMessages`, the runtime's stage).
struct Live(HashMap<String, String>);

impl LiveSessions for Live {
    fn loaded(&self) -> Vec<String> {
        Vec::new()
    }
    fn header(&self, _: &str) -> Option<Row> {
        None
    }
    fn running(&self, session: &str) -> bool {
        self.0.get(session).is_some_and(|s| s == "turn")
    }
    fn has_live_work(&self, session: &str) -> bool {
        self.running(session) || self.0.get(session).is_some_and(|s| s == "queued")
    }
    fn runtime_stage(&self, session: &str) -> Option<String> {
        self.0.get(session).filter(|s| *s == "streaming").cloned()
    }
}

struct Reap(Value);

impl ReapWindow for Reap {
    fn terminal_reap_ms(&self, provider: &str) -> f64 {
        agent_terminal_reap_ms(self.0.get("autoClear"), provider)
    }
}

struct Fixed(AtomicI64);

impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/stale-rows-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn every_recorded_stale_row_case_keeps_and_tombstones_what_node_did() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let now = golden["now"].as_i64().unwrap();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let name = case["case"].as_str().unwrap();
        let store = Arc::new(Store::default());
        for row in case["rows"].as_array().unwrap() {
            store.write(row["sessionId"].as_str().unwrap(), Some(row.as_object().unwrap().clone()));
        }
        let live = case["live"].as_object().map(|l| l.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default();
        let registry = AgentRegistry::new(store.clone(), Arc::new(Live(live)), Arc::new(Reap(case["config"].clone())), Arc::new(Fixed(AtomicI64::new(now))));
        registry.refresh_tags_from_sessions(false, &Scope::default()).await;
        let maps = store.0.lock().unwrap().clone();
        // The index as the registry reads it (Node rewrites its file from that view, so a Lead row drops out there).
        let mut workers: Vec<String> = registry.lock().all_rows(now as f64).iter().map(|row| clean(row.get("sessionId"))).collect();
        workers.sort();
        let mut tombstoned: Vec<String> =
            maps.iter().filter_map(|(id, m)| m.get("tombstone").map(|t| format!("{}:{id}", clean(t.get("tag"))))).collect();
        tombstoned.sort();
        let mut got = json!({ "workers": workers, "tombstoned": tombstoned });
        if let Some(sessions) = case["sessions"].as_array() {
            let st = registry.lock();
            let none = HashMap::new();
            let blocked: Vec<bool> = sessions.iter().map(|s| registry.blocks_scan(&st, s.as_object().unwrap(), s["agentTag"].as_str().unwrap(), &none)).collect();
            got["blocked"] = json!(blocked);
        }
        if got != case["recorded"] {
            failures.push(format!("{name}:\n  want {}\n  got  {got}", case["recorded"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
    // Every case of the test file is replayed here or named in the manifest.
    let mut names: std::collections::BTreeSet<&str> = cases.iter().map(|c| c["case"].as_str().unwrap()).collect();
    names.extend(excluded.keys().map(String::as_str));
    assert_eq!(names.len(), 7);
}
