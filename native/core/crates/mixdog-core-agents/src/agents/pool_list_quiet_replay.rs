//! Node's recording `fixtures/quiet-progress-cases/golden.json` (`record-quiet-progress-cases.mjs`), case 4: the
//! pool rows' turn progress (`withTurnProgress` over `isTurnInFlight`), read when the test runs and decoded with
//! [`Exact`]. The recorded rows go through the listing's last step ([`AgentPool`]'s `with_progress`, which
//! `list` lays over every row) with the recorded runtime entries, and the whole recorded value is compared.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use mixdog_agent::agent_tool::watchdog::{AgentKind, stall_warn_ms};
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::{AgentPool, PoolLive, PoolStore, Row, RuntimeEntry};

fn golden() -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/quiet-progress-cases/golden.json"))
}

/// Node's `runtimeState.get(id)` entry as the daemon's: the liveness record, and the turn's controller (any
/// `controller` that is not aborted) as `controller_live`.
fn runtime_entry(entry: &Value) -> RuntimeEntry {
    let mut liveness = entry.as_object().cloned().unwrap_or_default();
    let controller = liveness.shift_remove("controller");
    RuntimeEntry { liveness, controller_live: controller.is_some_and(|c| c.is_object() && c.get("signal").and_then(|s| s.get("aborted")) != Some(&Value::Bool(true))) }
}

/// The recorder's lookup (`record-quiet-progress-cases.mjs:66`): the recorded entry for `run`, `{ stage: 'idle' }`
/// for any other session; the stall warn point from the watchdog, with no environment override.
struct Live {
    entry: Value,
}

impl PoolLive for Live {
    fn now(&self) -> f64 {
        0.0
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
    fn runtime_entry(&self, session_id: &str) -> Option<RuntimeEntry> {
        Some(runtime_entry(&if session_id == "run" { self.entry.clone() } else { json!({ "stage": "idle" }) }))
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, agent: Option<&str>) -> f64 {
        stall_warn_ms(AgentKind { name: agent, hidden: false, stall_cap_idle_seconds: None }, &|_| None) as f64
    }
}

struct NoStore;

#[async_trait::async_trait]
impl PoolStore for NoStore {
    async fn agent_index(&self) -> Option<Value> {
        None
    }
    async fn lead_index(&self) -> Option<Value> {
        None
    }
    async fn headers(&self, ids: &[String]) -> Vec<Option<Row>> {
        vec![None; ids.len()]
    }
}

#[test]
fn running_pool_rows_carry_their_turn_progress_stage_and_warn_point() {
    let golden = golden();
    let name = "running pool rows carry their turn progress, stage and warn point; settled rows pass through";
    let case = &golden.get("cases").as_array()[4];
    assert_eq!(case.get("case").as_str(), name);
    let want = case.get("observed");
    let entry = want.get("entry").to_plain().unwrap();
    let rows = want.get("rows").to_plain().unwrap();
    let live = Arc::new(Live { entry: entry.clone() });
    let pool = AgentPool::new(Arc::new(NoStore), live.clone());
    let decorated: Vec<Value> =
        rows.as_array().unwrap().iter().map(|row| Value::Object(pool.with_progress(row.as_object().unwrap().clone(), &HashSet::new()))).collect();
    // Node's `decorated[1] === rows[1]`: a settled row comes back as it went in.
    let settled = decorated[1] == rows[1];
    let got = json!({
        "entry": entry,
        "rows": rows,
        "decorated": decorated,
        "settledRowIsTheSameObject": settled,
        "workerWarnSeconds": live.stall_warn_ms(Some("worker")) / 1000.0,
    });
    assert!(Exact::plain(&got) == *want, "{name}: {got}");
}
