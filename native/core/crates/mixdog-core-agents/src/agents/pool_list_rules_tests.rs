//! The Agents pool listing (`agent/pool/list`) over the stored worker rows: which rows are shown, the status each one shows
//! against what this daemon is running, how a finished one ages out of the pane, and the order of the list.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::pool_list::AgentPool;
use super::pool_list::PoolLive;
use super::pool_list::PoolStore;
use super::pool_list::RuntimeEntry;
use super::pool_list::todo_progress;

const NOW: f64 = 1_700_000_000_000.0;
const HOUR: f64 = 3_600_000.0;

struct Store(Value);

#[async_trait]
impl PoolStore for Store {
    async fn agent_index(&self) -> Option<Value> {
        Some(json!({ "workers": self.0 }))
    }
    async fn lead_index(&self) -> Option<Value> {
        None
    }
    async fn headers(&self, ids: &[String]) -> Vec<Option<Map<String, Value>>> {
        ids.iter().map(|_| None).collect()
    }
}

struct Live(HashSet<String>);

impl PoolLive for Live {
    fn now(&self) -> f64 {
        NOW
    }
    fn running(&self) -> HashSet<String> {
        self.0.clone()
    }
    fn awaiting_shell(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn live_session(&self, _: &str) -> Option<Arc<Map<String, Value>>> {
        None
    }
    fn runtime_entry(&self, _: &str) -> Option<RuntimeEntry> {
        None
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, _: Option<&str>) -> f64 {
        0.0
    }
}

async fn listed(workers: Value, running: &[&str]) -> Vec<Value> {
    let live = Live(running.iter().map(|id| (*id).to_owned()).collect());
    AgentPool::new(Arc::new(Store(workers)), Arc::new(live)).list().await.expect("the listing")
}

fn worker(id: &str, tag: &str, status: &str, started_at: f64) -> Value {
    json!({ "sessionId": id, "tag": tag, "agent": "worker", "status": status, "startedAt": started_at })
}

fn shown(rows: &[Value]) -> Vec<(&str, &str)> {
    rows.iter().map(|row| (row["tag"].as_str().expect("tag"), row["status"].as_str().expect("status"))).collect()
}

#[tokio::test]
async fn a_worker_this_daemon_runs_shows_as_running_and_one_it_does_not_run_shows_as_unknown() {
    let rows = listed(json!([worker("sess_a", "alpha", "running", NOW - 2000.0), worker("sess_b", "beta", "running", NOW - 1000.0)]), &["sess_a"]).await;
    assert_eq!(shown(&rows), [("alpha", "running"), ("beta", "unknown")], "a declared run nobody is running can not be called running");
    assert_eq!(rows[0]["sessionId"], "sess_a");
    assert_eq!(rows[0]["turnStartedAt"], Value::Null, "no turn start is known for it");
}

#[tokio::test]
async fn a_finished_worker_stays_in_the_pane_for_an_hour() {
    let finished = |id: &str, tag: &str, status: &str, ago: f64| {
        let mut row = worker(id, tag, status, NOW - 3.0 * HOUR);
        row["updatedAt"] = json!(NOW - ago);
        row
    };
    let rows = listed(
        json!([
            finished("sess_a", "fresh", "completed", HOUR - 1000.0),
            finished("sess_b", "stale", "completed", HOUR + 1000.0),
            finished("sess_c", "broke", "failed", 1000.0),
        ]),
        &[],
    )
    .await;
    assert_eq!(shown(&rows), [("broke", "failed"), ("fresh", "completed")], "the hour-old completion is gone; a failure is shown too");
}

#[tokio::test]
async fn a_failed_worker_shows_why_and_a_row_that_is_not_a_worker_is_not_listed() {
    let mut failed = worker("sess_a", "alpha", "failed", NOW - 5000.0);
    failed["failureReason"] = json!("  out of quota ");
    failed["updatedAt"] = json!(NOW - 1000.0);
    let mut lead = worker("sess_l", "lead-row", "running", NOW);
    lead["agent"] = json!("lead");
    let rows = listed(
        json!([failed, lead, worker("not valid", "bad id", "running", NOW), worker("sess_t", "", "running", NOW), json!("not a row")]),
        &["sess_l", "sess_t"],
    )
    .await;
    assert_eq!(shown(&rows), [("alpha", "failed")]);
    assert_eq!(rows[0]["failureReason"], "out of quota");
}

#[tokio::test]
async fn the_list_is_ordered_by_start_time_then_by_tag() {
    let rows = listed(
        json!([worker("sess_1", "b-late", "running", 3000.0), worker("sess_2", "b-early", "running", 1000.0), worker("sess_3", "a-early", "running", 1000.0)]),
        &["sess_1", "sess_2", "sess_3"],
    )
    .await;
    let tags: Vec<&str> = rows.iter().map(|row| row["tag"].as_str().unwrap()).collect();
    assert_eq!(tags, ["a-early", "b-early", "b-late"]);
}

#[test]
fn the_todo_progress_counts_completed_over_the_tasks_not_abandoned_and_names_the_one_in_progress() {
    let todo = json!({ "phases": [
        { "name": "One", "tasks": [{ "content": "a", "status": "completed" }, { "content": "b  of\n c", "status": "in_progress" }] },
        { "name": "Two", "tasks": [{ "content": "d", "status": "abandoned" }, { "content": "e" }, { "content": "", "status": "pending" }, "junk"] },
        { "name": "Empty", "tasks": [] },
    ] });
    assert_eq!(todo_progress(Some(&todo)), Some(json!({ "completed": 1, "total": 3, "current": "b of c" })));
    assert_eq!(todo_progress(Some(&json!({ "phases": [] }))), None);
    assert_eq!(todo_progress(Some(&json!("text"))), None);
    assert_eq!(todo_progress(None), None);
}
