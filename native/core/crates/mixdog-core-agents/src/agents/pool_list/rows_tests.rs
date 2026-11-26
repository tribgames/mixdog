//! What the agent pool lists: the rows a user sees for working, finished and cancelled agents, their usage
//! counters and the progress of a turn in flight.

use std::sync::Mutex;

use super::*;

const NOW: f64 = 10_000_000.0;

#[derive(Default)]
struct Rig {
    workers: Vec<Value>,
    headers: HashMap<String, Row>,
    running: HashSet<String>,
    awaiting: HashSet<String>,
    entries: HashMap<String, RuntimeEntry>,
    routes: Mutex<HashMap<String, Arc<Row>>>,
    /// The settle identities the store fixed: session to `(turns, identity)`, shared by the rigs of one store.
    settled: Arc<Mutex<HashMap<String, (u64, Value)>>>,
}

#[async_trait]
impl PoolStore for Rig {
    async fn agent_index(&self) -> Option<Value> {
        Some(json!({ "workers": self.workers }))
    }
    async fn lead_index(&self) -> Option<Value> {
        None
    }
    async fn headers(&self, ids: &[String]) -> Vec<Option<Row>> {
        ids.iter().map(|id| self.headers.get(id).cloned()).collect()
    }
    async fn settle_identities(&self, fixes: &[SettleFix]) -> Vec<Value> {
        let mut settled = self.settled.lock().unwrap();
        fixes
            .iter()
            .map(|fix| match settled.get(&fix.session_id) {
                Some((turns, identity)) if *turns == fix.turns => identity.clone(),
                _ => {
                    settled.insert(fix.session_id.clone(), (fix.turns, fix.candidate.clone()));
                    fix.candidate.clone()
                }
            })
            .collect()
    }
}

impl PoolLive for Rig {
    fn now(&self) -> f64 {
        NOW
    }
    fn running(&self) -> HashSet<String> {
        self.running.clone()
    }
    fn awaiting_shell(&self) -> HashSet<String> {
        self.awaiting.clone()
    }
    fn live_session(&self, _: &str) -> Option<Arc<Row>> {
        None
    }
    fn request_route(&self, id: &str) -> Option<Arc<Row>> {
        self.routes.lock().unwrap().get(id).cloned()
    }
    fn runtime_entry(&self, id: &str) -> Option<RuntimeEntry> {
        self.entries.get(id).cloned()
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, _: Option<&str>) -> f64 {
        90_000.0
    }
}

fn object(value: Value) -> Row {
    value.as_object().unwrap().clone()
}

async fn list(rig: Rig) -> Vec<Value> {
    let rig = Arc::new(rig);
    AgentPool::new(rig.clone(), rig).list().await.unwrap()
}

fn worker(id: &str, tag: &str, status: &str) -> Value {
    json!({ "sessionId": id, "tag": tag, "agent": "worker", "status": status, "startedAt": 1_000_000, "ownerSessionId": "owner" })
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

#[test]
fn usage_counters_sum_what_the_session_recorded_and_ignore_what_it_never_did() {
    assert_eq!(usage_totals(None), (None, None));
    let (usage, calls) = usage_totals(Some(&object(json!({ "totalInputTokens": 10, "totalOutputTokens": 5, "totalToolCalls": 3 }))));
    let usage = usage.unwrap();
    assert_eq!((number(&usage["inputTokens"]), number(&usage["outputTokens"]), number(&usage["totalTokens"])), (10.0, 5.0, 15.0));
    assert_eq!(number(&calls.unwrap()), 3.0);
    // One recorded counter is enough; the other counts as zero.
    let (usage, calls) = usage_totals(Some(&object(json!({ "totalOutputTokens": 7 }))));
    assert_eq!(number(&usage.unwrap()["totalTokens"]), 7.0);
    assert_eq!(calls, None);
    // A counter that is negative or no number was never recorded.
    assert_eq!(usage_totals(Some(&object(json!({ "totalInputTokens": -1, "totalOutputTokens": "9", "totalToolCalls": -2 })))), (None, None));
}

#[tokio::test]
async fn a_stored_row_carries_the_usage_counters_of_its_session_header() {
    let mut rig = Rig::default();
    rig.workers = vec![worker("s1", "a1", "completed"), worker("s2", "a2", "completed")];
    for row in &mut rig.workers {
        row["finishedAt"] = json!(NOW - 1000.0);
    }
    rig.headers.insert("s1".into(), object(json!({ "totalInputTokens": 100, "totalOutputTokens": 20, "totalToolCalls": 4 })));
    let rows = list(rig).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(number(&rows[0]["usage"]["totalTokens"]), 120.0);
    assert_eq!(number(&rows[0]["toolCalls"]), 4.0);
    assert_eq!((&rows[1]["usage"], &rows[1]["toolCalls"]), (&Value::Null, &Value::Null));
}

#[tokio::test]
async fn a_working_agent_shows_running_and_a_finished_one_stays_listed_for_an_hour_only() {
    let mut rig = Rig::default();
    let mut recent = worker("done_recent", "a1", "completed");
    recent["finishedAt"] = json!(NOW - 60_000.0);
    let mut old = worker("done_old", "a2", "completed");
    old["finishedAt"] = json!(NOW - AGENT_PANE_VISIBLE_MS - 1.0);
    rig.workers = vec![worker("busy", "a3", "running"), recent, old];
    rig.running.insert("busy".into());
    let rows = list(rig).await;
    let shown: Vec<(&str, &str)> = rows.iter().map(|row| (row["tag"].as_str().unwrap(), row["status"].as_str().unwrap())).collect();
    assert_eq!(shown, [("a1", "completed"), ("a3", "running")]);
}

#[tokio::test]
async fn a_row_declared_working_that_nothing_runs_any_more_reads_unknown() {
    let mut rig = Rig::default();
    for stage in ["running", "queued", "starting"] {
        let mut row = worker(stage, stage, stage);
        row["provider"] = json!("openai-oauth");
        row["model"] = json!("gpt-6.2-sol");
        row["fast"] = json!(true);
        rig.workers.push(row);
        rig.headers.insert(stage.into(), object(json!({ "provider": "anthropic-oauth", "model": "claude-sonnet-5-5", "fast": true })));
    }
    let rows = list(rig).await;
    assert_eq!(rows.len(), 3);
    for row in rows {
        assert_eq!((&row["status"], &row["stage"]), (&json!("unknown"), &json!("unknown")));
        assert_eq!((&row["provider"], &row["model"], &row["fast"]), (&Value::Null, &Value::Null, &Value::Null));
    }
}

#[tokio::test]
async fn a_child_route_is_empty_until_send_and_switches_as_one_tuple_on_fallback() {
    let mut queued = worker("queued", "queued", "queued");
    queued["model"] = json!("launch-model");
    queued["fast"] = json!(true);
    let mut running = worker("busy", "busy", "running");
    running["model"] = json!("claude-sonnet-5-5");
    running["effort"] = json!("medium");
    let rig = Arc::new(Rig {
        workers: vec![queued, running],
        headers: HashMap::from([
            ("queued".into(), object(json!({ "provider": "unrelated", "model": "preset", "fast": true }))),
            (
                "busy".into(),
                object(json!({
                    "provider": "openai-oauth", "model": "gpt-6.2-sol", "effort": "high",
                    "fast": true, "effortAuto": true, "modelParameters": { "serviceTier": "ultrafast" },
                })),
            ),
        ]),
        running: HashSet::from(["busy".into(), "queued".into()]),
        entries: HashMap::from([("queued".into(), RuntimeEntry { liveness: object(json!({ "stage": "resource_wait" })), controller_live: true })]),
        ..Rig::default()
    });
    let pool = AgentPool::new(rig.clone(), rig.clone());
    let route_of = |rows: Vec<Value>| {
        let queued = rows.iter().find(|row| row["tag"] == "queued").unwrap();
        assert_eq!(queued["status"], "queued");
        assert_eq!(queued["model"], Value::Null);
        assert_eq!(queued["fast"], Value::Null);
        let busy = rows.iter().find(|row| row["tag"] == "busy").unwrap();
        json!([busy["provider"], busy["model"], busy["effort"], busy["fast"], busy["modelParameters"], busy["routeObserved"], busy["effortAuto"]])
    };
    assert_eq!(route_of(pool.list().await.unwrap()), json!([null, null, null, null, null, null, null]));
    let publish = |route| {
        rig.routes.lock().unwrap().insert("busy".into(), Arc::new(object(route)));
    };
    publish(json!({ "provider": "anthropic-oauth", "model": "claude-sonnet-5-5", "effort": "medium", "fast": false }));
    assert_eq!(route_of(pool.list().await.unwrap()), json!(["anthropic-oauth", "claude-sonnet-5-5", "medium", false, null, true, null]));
    publish(json!({
        "provider": "openai-oauth", "model": "gpt-6.2-sol", "effort": "high",
        "fast": true, "modelParameters": { "serviceTier": "ultrafast" },
    }));
    assert_eq!(route_of(pool.list().await.unwrap()), json!(["openai-oauth", "gpt-6.2-sol", "high", true, { "serviceTier": "ultrafast" }, true, true]),);
}

#[tokio::test]
async fn a_cancelled_agent_shows_cancelled_unless_it_worked_again_after_the_cancel() {
    let mut cancelled = worker("c1", "a1", "cancelled");
    cancelled["cancelledAt"] = json!(NOW - 1000.0);
    let mut resumed = worker("c2", "a2", "running");
    resumed["cancelledAt"] = json!(NOW - 5000.0);
    resumed["turnStartedAt"] = json!(NOW - 1000.0);
    resumed["status"] = json!("cancelled");
    let mut rig = Rig::default();
    rig.workers = vec![cancelled, resumed];
    rig.running.insert("c2".into());
    let rows = list(rig).await;
    let shown: Vec<(&str, &str)> = rows.iter().map(|row| (row["tag"].as_str().unwrap(), row["status"].as_str().unwrap())).collect();
    assert_eq!(shown, [("a1", "cancelled"), ("a2", "running")]);
}

#[tokio::test]
async fn rows_without_a_valid_session_or_tag_are_not_listed_and_the_oldest_comes_first() {
    let mut rig = Rig::default();
    let mut later = worker("s_later", "b", "running");
    later["startedAt"] = json!(2_000_000);
    let mut bad_id = worker("bad id!", "c", "running");
    bad_id["startedAt"] = json!(1);
    let mut no_tag = worker("s_notag", "", "running");
    no_tag["startedAt"] = json!(1);
    rig.workers = vec![later, bad_id, no_tag, worker("s_first", "a", "running")];
    rig.running = ["s_later", "bad id!", "s_notag", "s_first"].map(String::from).into_iter().collect();
    let rows = list(rig).await;
    let tags: Vec<&str> = rows.iter().map(|row| row["tag"].as_str().unwrap()).collect();
    assert_eq!(tags, ["a", "b"]);
}

#[test]
fn a_todo_list_counts_finished_tasks_and_names_the_one_in_progress() {
    let todo = json!({ "phases": [
        { "tasks": [ { "content": "one", "status": "completed" }, { "content": "two\n  words", "status": "in_progress" } ] },
        { "tasks": [ { "content": "three", "status": "pending" }, { "content": "dropped", "status": "abandoned" }, { "content": "", "status": "pending" } ] },
        { "tasks": [] },
    ] });
    let progress = todo_progress(Some(&todo)).unwrap();
    assert_eq!((number(&progress["completed"]), number(&progress["total"])), (1.0, 3.0));
    assert_eq!(progress["current"], "two words");
    assert_eq!(todo_progress(Some(&json!({ "phases": [{ "tasks": [] }] }))), None);
    assert_eq!(todo_progress(None), None);
}

#[tokio::test]
async fn a_turn_in_flight_adds_its_progress_and_a_waiting_agent_says_what_it_waits_on() {
    let mut rig = Rig::default();
    rig.workers = vec![worker("s1", "a1", "running"), worker("s2", "a2", "running"), worker("s3", "a3", "running")];
    rig.running = ["s1", "s2", "s3"].map(String::from).into_iter().collect();
    // The request was sent at 5000 and no transport answered since: the model is thinking.
    rig.entries.insert(
        "s1".into(),
        RuntimeEntry { liveness: object(json!({ "stage": "requesting", "requestSentAt": 5000, "lastProgressAt": 4000 })), controller_live: true },
    );
    rig.awaiting.insert("s2".into());
    let rows = list(rig).await;
    let busy = &rows[0];
    assert_eq!(busy["progressStage"], "model_thinking");
    assert_eq!(number(&busy["progressAt"]), 4000.0);
    assert_eq!(number(&busy["stallWarnMs"]), 90_000.0);
    assert_eq!(rows[1]["awaitingTask"], "background");
    assert!(rows[2].get("progressAt").is_none() && rows[2].get("awaitingTask").is_none());
}

#[tokio::test]
async fn a_settled_row_keeps_the_stored_settle_time_however_many_rows_are_listed_and_a_working_one_has_none() {
    let mut rig = Rig::default();
    for index in 0..600 {
        let mut row = worker(&format!("done_{index}"), &format!("t{index}"), "completed");
        row["finishedAt"] = json!(NOW - 60_000.0 - f64::from(index));
        row["updatedAt"] = json!(NOW - 1_000.0);
        rig.workers.push(row);
    }
    rig.workers.push(worker("busy", "tb", "running"));
    rig.running.insert("busy".into());
    let pool = {
        let rig = Arc::new(rig);
        AgentPool::new(rig.clone(), rig)
    };
    for _ in 0..2 {
        let rows = pool.list().await.unwrap();
        let done = rows.iter().find(|row| row["sessionId"] == "done_599").unwrap();
        assert_eq!(number(&done["settledAt"]), NOW - 60_000.0 - 599.0);
        assert_eq!(done["idleSince"], done["settledAt"]);
        let busy = rows.iter().find(|row| row["sessionId"] == "busy").unwrap();
        assert_eq!((&busy["settledAt"], &busy["idleSince"]), (&Value::Null, &Value::Null));
    }
}

#[tokio::test]
async fn a_settled_outcome_keeps_the_identity_first_listed_until_new_work_settles_under_a_new_one() {
    let settled = Arc::new(Mutex::new(HashMap::new()));
    let listed = |stamps: Value, running: bool| {
        let mut row = worker("c1", "a1", if running { "running" } else { "completed" });
        for (key, value) in stamps.as_object().unwrap() {
            row[key] = value.clone();
        }
        let running = if running { HashSet::from(["c1".into()]) } else { HashSet::new() };
        let rig = Rig { workers: vec![row], running, settled: settled.clone(), ..Rig::default() };
        async move {
            let rows = list(rig).await;
            (rows[0]["settledAt"].clone(), rows[0]["idleSince"].clone())
        }
    };
    // An unstamped outcome is fixed at its updatedAt, the first time it is listed settled.
    let first = json!(NOW - 5_000.0);
    let turn_one = json!({ "startedTurns": 1, "turnStartedAt": NOW - 9_000.0, "updatedAt": NOW - 5_000.0 });
    assert_eq!(listed(turn_one, false).await, (first.clone(), first.clone()));
    // A scan of the same turn that moves updatedAt and fills finishedAt does not move it.
    let rescanned = json!({ "startedTurns": 1, "turnStartedAt": NOW - 9_000.0, "updatedAt": NOW - 1_000.0, "finishedAt": NOW - 2_000.0 });
    assert_eq!(listed(rescanned, false).await, (first.clone(), first.clone()));
    // New work has none; its outcome settles under a later identity.
    let running = json!({ "startedTurns": 2, "turnStartedAt": NOW - 500.0, "updatedAt": NOW - 400.0 });
    assert_eq!(listed(running, true).await, (Value::Null, Value::Null));
    let next = listed(json!({ "startedTurns": 2, "turnStartedAt": NOW - 500.0, "updatedAt": NOW - 50.0, "finishedAt": NOW - 100.0 }), false).await;
    assert_eq!(next, (json!(NOW - 100.0), json!(NOW - 100.0)));
    // A turn whose stamps all predate its start is fixed at the listing's own time.
    let stale = listed(json!({ "startedTurns": 3, "turnStartedAt": NOW - 20.0, "updatedAt": NOW - 30.0 }), false).await;
    assert_eq!(stale.0, json!(iso(NOW).unwrap()));
}

#[tokio::test]
async fn active_turn_keeps_its_origin_across_later_asks_and_replaces_only_settled_turn_stamps() {
    let mut active = worker("s_active", "active", "running");
    active["turnStartedAt"] = json!("2026-03-01T10:00:00.000Z");
    let mut woken = worker("s_woken", "woken", "idle");
    woken["turnStartedAt"] = json!("2026-03-01T09:50:00.000Z");
    woken["finishedAt"] = json!("2026-03-01T09:55:00.000Z");
    let mut rig = Rig::default();
    rig.workers = vec![active, woken];
    rig.running = ["s_active", "s_woken"].map(String::from).into_iter().collect();
    let later_ask = date_parse("2026-03-01T10:00:02.000Z");
    rig.entries.insert("s_active".into(), RuntimeEntry { liveness: object(json!({ "stage": "streaming", "askStartedAt": later_ask })), controller_live: true });
    rig.entries.insert("s_woken".into(), RuntimeEntry { liveness: object(json!({ "stage": "requesting", "askStartedAt": later_ask })), controller_live: true });
    let rows = list(rig).await;
    let by_tag = |tag: &str| rows.iter().find(|row| row["tag"] == tag).unwrap()["turnStartedAt"].clone();
    assert_eq!(by_tag("active"), json!("2026-03-01T10:00:00.000Z"));
    assert_eq!(by_tag("woken"), json!("2026-03-01T10:00:02.000Z"));
}
