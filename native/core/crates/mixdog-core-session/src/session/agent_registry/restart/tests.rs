//! The restart settlement against Node's real one (`fixtures/restart-settlement/golden.json`, from
//! `benchmarks/rust-core/recorders/record-restart-settlement.mjs`): the same rows go through
//! recovery and a dead-only sweep, and every resulting row, the owed failures and the stamped rows
//! are compared with what Node left.

use mixdog_agent::compact::settings::agent_terminal_reap_ms;
use serde_json::json;

use super::*;

const GOLDEN: &str = include_str!("../../../../../../fixtures/restart-settlement/golden.json");

struct Probe(u64);

impl ProcessProbe for Probe {
    fn alive(&self, pid: u64) -> bool {
        pid != self.0
    }
}

struct Reap(Value);

impl ReapWindow for Reap {
    fn terminal_reap_ms(&self, provider: &str) -> f64 {
        agent_terminal_reap_ms(self.0.get("autoClear"), provider)
    }
}

fn row(value: &Value) -> Row {
    value.as_object().cloned().unwrap()
}

#[test]
fn recovery_and_the_dead_only_sweep_leave_the_rows_node_leaves() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let probe = Probe(golden["deadPid"].as_u64().unwrap());
    let running: Vec<String> = golden["running"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
    let running = move |id: &str| running.iter().any(|r| r == id);
    for case in golden["cases"].as_array().unwrap() {
        let label = format!("{} deadOnly={}", case["config"], case["deadOnly"]);
        let reap = Reap(golden["configs"][case["config"].as_str().unwrap()].clone());
        let live = Liveness { probe: &probe, own_pid: golden["ownPid"].as_u64().unwrap(), running: &running, reap: &reap, now_ms: golden["now"].as_i64().unwrap() };
        let rows: Vec<(String, Row)> = golden["rows"].as_array().unwrap().iter().map(|r| (r["sessionId"].as_str().unwrap().to_owned(), row(r))).collect();
        let (changed, any) = settle_rows(&rows, case["deadOnly"] == json!(true), &live);
        assert_eq!(any, case["changed"] == json!(true), "{label}: changed");
        let mut after = rows.clone();
        for (session, next) in changed {
            after.iter_mut().find(|(id, _)| *id == session).unwrap().1 = next;
        }
        for (want, (_, got)) in case["after"].as_array().unwrap().iter().zip(&after) {
            assert_eq!(Value::Object(got.clone()), *want, "{label}: {}", want["sessionId"]);
        }
        let pending: Vec<&str> = after.iter().filter(|(_, r)| is_unnotified_restart_failure(r)).map(|(id, _)| id.as_str()).collect();
        let want: Vec<&str> = case["pending"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
        assert_eq!(pending, want, "{label}: owed failures");
        assert_eq!(want, case["stamped"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect::<Vec<_>>(), "{label}: stamped");
    }
}
