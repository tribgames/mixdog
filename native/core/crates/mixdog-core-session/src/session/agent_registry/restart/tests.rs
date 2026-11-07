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

/// `registerFailedTask` against the real background-task table (`fixtures/restart-notify/golden.json`,
/// from `record-restart-notify.mjs`): a lost task with an id is left on the board as failed,
/// acknowledged and un-announced, carrying the row's identity; a row without one registers nothing.
#[test]
fn a_lost_task_resolves_on_the_board_as_node_leaves_it() {
    struct Frozen(i64);
    impl mixdog_agent::env::Clock for Frozen {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }
    let golden: Value = serde_json::from_str(include_str!("../../../../../../fixtures/restart-notify/golden.json")).unwrap();
    let board = JobBoard::new(Arc::new(Frozen(golden["now"].as_i64().unwrap())), None, None);
    for case in golden["cases"].as_array().unwrap() {
        let source = row(&case["row"]);
        register_failed_task(&board, &source);
        let id = clean(source.get("task_id"));
        let found = board.get(&id, &Scope::default());
        let Some(task) = case["task"].as_object() else {
            assert!(found.is_none(), "{}: no task id, no task", case["row"]["sessionId"]);
            continue;
        };
        let found = found.unwrap_or_else(|| panic!("{id} resolves"));
        let text = |key: &str| task["meta"].get(key).and_then(Value::as_str).map(str::to_owned);
        assert_eq!(found.status, task["status"].as_str().unwrap(), "{id}");
        assert_eq!(found.error.as_deref(), task["error"].as_str(), "{id}");
        assert_eq!(found.terminal_reason.as_deref(), task["terminalReason"].as_str(), "{id}");
        assert_eq!(found.operation, task["operation"].as_str().unwrap(), "{id}");
        assert_eq!(found.label.as_deref().filter(|s| !s.is_empty()), task["label"].as_str().filter(|s| !s.is_empty()), "{id}");
        assert_eq!(found.notified, task["notified"] == json!(true), "{id}");
        for (got, key) in [(&found.meta.tag, "tag"), (&found.meta.session_id, "sessionId"), (&found.meta.agent, "agent"), (&found.meta.provider, "provider"), (&found.meta.model, "model"), (&found.meta.preset, "preset"), (&found.meta.effort, "effort")] {
            assert_eq!(got, &text(key).filter(|s| !s.is_empty()), "{id}: meta.{key}");
        }
        register_failed_task(&board, &source);
        assert_eq!(board.list_jobs(&Scope::default()).iter().filter(|j| j.task_id == id).count(), 1, "{id}: registered once");
    }
}
