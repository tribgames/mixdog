//! The report chain reads against `fixtures/memory-jobs/golden.json` (recorded from the Node
//! product) and the follow and re-attach behavior over a scripted host and a paused clock.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use crate::bots::delivery::env::{RetryTimer, SleepRetry};
use serde_json::{Map, Value, json};

use super::chain::*;
use super::follow::*;
use super::rearm::*;
use super::{progress_run_id, turn_report_run_id};

const GOLDEN: &str = include_str!("../../../../fixtures/memory-jobs/golden.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden parses")
}

fn outcome_json(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Open => json!("open"),
        Outcome::Ended { status, text } => json!({"status": status, "text": text}),
    }
}

#[test]
fn the_chain_reads_equal_node() {
    for (name, case) in golden()["chain"].as_object().unwrap() {
        let messages: Vec<Value> = case["messages"].as_array().unwrap().clone();
        let run_id = case["runId"].as_str().unwrap();
        let outcome = submission_outcome(&messages, run_id).as_ref().map_or(Value::Null, outcome_json);
        assert_eq!(outcome, case["outcome"], "{name} outcome");
        let latest = latest_turn_outcome(&messages, run_id).map_or(Value::Null, |(id, outcome, at, ambiguous)| {
            json!({"id": id, "outcome": outcome.as_ref().map_or(Value::Null, outcome_json), "at": mixdog_js::json_number(at), "ambiguous": ambiguous})
        });
        assert_eq!(latest, case["latest"], "{name} latest");
        if let Some(expected) = case.get("submissionIds") {
            let ids: Vec<Vec<String>> = messages.iter().map(submission_ids_of).collect();
            let expected: Vec<Vec<String>> = expected.as_array().unwrap().iter().map(|a| a.as_array().unwrap().iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).collect();
            assert_eq!(ids, expected, "{name} submission ids");
        }
    }
}

fn pending_of(state: &Value) -> Pending {
    let set = |key: &str| -> HashSet<String> { state[key].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect()).unwrap_or_default() };
    Pending {
        agent_working: set("agentWorking"),
        owed: state["owed"].as_array().map(|a| a.iter().map(|o| Owed { text: o["text"].as_str().unwrap().into(), meta: o["meta"].clone() }).collect()).unwrap_or_default(),
        pool: state["pool"].as_array().cloned().unwrap_or_default(),
        agent_task_owners: set("agentTaskOwners"),
        working: set("working"),
        agent_tasks: state["agentTasks"]
            .as_array()
            .map(|a| a.iter().map(|t| AgentTask { task_id: t["taskId"].as_str().unwrap().into(), session_id: t["sessionId"].as_str().map(str::to_owned), running: t["running"].as_bool().unwrap() }).collect())
            .unwrap_or_default(),
    }
}

#[test]
fn pending_agent_work_equals_node() {
    let g = golden();
    for case in g["rowStatus"].as_array().unwrap() {
        assert_eq!(has_pending_agent_work(&case["row"]), case["pending"].as_bool().unwrap(), "{}", case["row"]);
    }
    for case in g["pending"].as_array().unwrap() {
        let state = &case["state"];
        let task_ids: Option<HashSet<String>> = state["taskIds"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect());
        let got = pending_work_of(case["sessionId"].as_str().unwrap(), &pending_of(state), task_ids.as_ref());
        assert_eq!(got, case["pending"].as_bool().unwrap(), "{state}");
    }
    let pool = g["pending"][4]["state"]["pool"].as_array().unwrap().clone();
    let mut owners: Vec<String> = sessions_with_pending_work(&pool).into_iter().collect();
    owners.sort();
    assert_eq!(json!(owners), g["sessionsPending"]);
    for case in g["closure"].as_array().unwrap() {
        let task_ids: HashSet<String> = case["taskIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
        let pending = Pending { pool: pool.clone(), ..Pending::default() };
        let mut sessions: Vec<String> = closure_sessions("lead", &task_ids, &pending).into_iter().collect();
        sessions.sort();
        assert_eq!(json!(sessions), case["sessions"], "{}", case["taskIds"]);
    }
}

#[test]
fn queue_row_names_follow_the_task_sessions() {
    assert_eq!(progress_run_id("s1", "a1"), "s1_progress_a1");
    assert_eq!(turn_report_run_id("s1", "send", "blocked", "ap1", ""), "s1_ap1_blocked");
    assert_eq!(turn_report_run_id("s1", "send", "working", "", "a1"), "s1_progress_a1");
    assert_eq!(turn_report_run_id("s1", "send", "completed", "", "a1"), "s1_a1_end");
    assert_eq!(turn_report_run_id("s1", "send", "completed", "", ""), "send_end");
    assert_eq!(agent_task_id_of_execution("restart:t1").as_deref(), Some("t1"));
    assert_eq!(agent_task_id_of_execution("restart:a:b"), None);
    assert_eq!(agent_task_id_of_execution(" t2 ").as_deref(), Some("t2"));
}

/// A scripted host: the stored session, the queued results and what was delivered.
#[derive(Default)]
struct Mock {
    messages: Mutex<Option<Vec<Value>>>,
    owed: Mutex<Vec<Owed>>,
    pending: Mutex<bool>,
    completions: Mutex<Vec<String>>,
    taken: bool,
    delivered: Mutex<Vec<(String, Value)>>,
    failures: Mutex<usize>,
    disowned: Mutex<Vec<String>>,
    ended: Mutex<Vec<String>>,
    watches: Mutex<Vec<Value>>,
    owned: Mutex<Vec<Value>>,
}

#[async_trait]
impl FollowHost for Mock {
    async fn load_messages(&self, _session_id: &str) -> Option<Vec<Value>> {
        self.messages.lock().unwrap().clone()
    }
    async fn owed_results(&self, _session_id: &str) -> Vec<Owed> {
        self.owed.lock().unwrap().clone()
    }
    async fn deliver_completion(&self, session_id: &str, _text: &str, _meta: &Value) -> Result<bool, String> {
        self.completions.lock().unwrap().push(session_id.to_owned());
        Ok(self.taken)
    }
    async fn pending_work(&self, _session_id: &str, _task_ids: Option<&HashSet<String>>) -> bool {
        *self.pending.lock().unwrap()
    }
    fn timer(&self) -> Arc<dyn RetryTimer> {
        Arc::new(SleepRetry)
    }
}

#[async_trait]
impl RearmHost for Mock {
    async fn deliver(&self, agent_id: &str, payload: Value) -> Result<(), String> {
        let mut failures = self.failures.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err("home unavailable".into());
        }
        self.delivered.lock().unwrap().push((agent_id.to_owned(), payload));
        Ok(())
    }
    async fn disown(&self, run_id: &str) -> Result<(), String> {
        self.disowned.lock().unwrap().push(run_id.to_owned());
        Ok(())
    }
    async fn materialize_session(&self, _session_id: &str) -> Result<Option<Arc<dyn RuntimeView>>, String> {
        Ok(None)
    }
    async fn queued_submission_ids(&self, _session_id: &str) -> Vec<String> {
        Vec::new()
    }
    async fn artifact_fields(&self, _session_id: &str, _turn_id: &str, _runtime: Option<&Arc<dyn RuntimeView>>) -> Map<String, Value> {
        Map::new()
    }
    fn note_bot_work(&self, _run_id: &str, _session_id: &str, _agent_id: &str) {}
    fn end_bot_work(&self, run_id: &str) {
        self.ended.lock().unwrap().push(run_id.to_owned());
    }
    fn is_room_member_session(&self, session_id: &str) -> bool {
        session_id.starts_with("room:")
    }
    async fn list_watches(&self) -> Result<Vec<Value>, String> {
        Ok(self.watches.lock().unwrap().clone())
    }
    async fn owned_work(&self) -> Result<Vec<Value>, String> {
        Ok(self.owned.lock().unwrap().clone())
    }
    async fn settle_agent_results(&self) -> Result<(), String> {
        Ok(())
    }
}

type Finished = Arc<Mutex<Vec<(String, String, String)>>>;
type Interims = Arc<Mutex<Vec<Answer>>>;

fn follow_of(host: Arc<Mock>, run_id: &str, wake_owed: bool, runtime: Option<Arc<dyn RuntimeView>>) -> (Arc<Follow>, Finished, Interims) {
    mixdog_rt::testing::tokens();
    let (finished, interims): (Finished, Interims) = Default::default();
    let (sink, interim_sink) = (Arc::clone(&finished), Arc::clone(&interims));
    let args = FollowArgs {
        session_id: "task-1".into(),
        run_id: run_id.into(),
        runtime,
        immediate: None,
        wake_owed,
        finish: Arc::new(move |status, text, id| {
            sink.lock().unwrap().push((status, text, id));
            Box::pin(async { Ok(()) })
        }),
        interim: Some(Arc::new(move |answer| {
            interim_sink.lock().unwrap().push(answer);
            Box::pin(async { Ok(()) })
        })),
        progressed_through: String::new(),
    };
    (Follow::new(host, args, FINAL_SETTLE, FINAL_POLL), finished, interims)
}

fn conversation(name: &str) -> Vec<Value> {
    golden()["chain"][name]["messages"].as_array().unwrap().clone()
}

async fn settle(time: Duration) {
    tokio::time::sleep(time).await;
    // Let the spawned timer task run its check.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

/// The final report is delivered by the timer task that found the answer final: stopping the
/// follow from there must not cancel the delivery when it yields.
#[tokio::test(start_paused = true)]
async fn a_final_delivery_that_yields_is_not_cancelled_by_the_stop_it_follows() {
    mixdog_rt::testing::tokens();
    let host = Arc::new(Mock { messages: Mutex::new(Some(conversation("simple"))), ..Mock::default() });
    let finished: Finished = Default::default();
    let sink = Arc::clone(&finished);
    let args = FollowArgs {
        session_id: "task-1".into(),
        run_id: "r1".into(),
        runtime: None,
        immediate: None,
        wake_owed: false,
        finish: Arc::new(move |status, text, id| {
            let sink = Arc::clone(&sink);
            Box::pin(async move {
                for _ in 0..5 {
                    tokio::task::yield_now().await;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                sink.lock().unwrap().push((status, text, id));
                Ok(())
            })
        }),
        interim: None,
        progressed_through: String::new(),
    };
    let follow = Follow::new(host, args, FINAL_SETTLE, FINAL_POLL);
    follow.check().await;
    settle(Duration::from_millis(2600)).await;
    settle(Duration::from_millis(100)).await;
    assert_eq!(*finished.lock().unwrap(), vec![("completed".to_owned(), "all done".to_owned(), "r1".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn a_final_answer_is_reported_after_the_quiet_period() {
    let host = Arc::new(Mock { messages: Mutex::new(Some(conversation("simple"))), ..Mock::default() });
    let (follow, finished, _) = follow_of(Arc::clone(&host), "r1", false, None);
    follow.check().await;
    assert!(finished.lock().unwrap().is_empty(), "not final before the quiet period");
    settle(Duration::from_millis(2600)).await;
    assert_eq!(*finished.lock().unwrap(), vec![("completed".to_owned(), "all done".to_owned(), "r1".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn earlier_answers_of_the_chain_go_out_as_progress_and_pending_work_holds_the_report() {
    let host = Arc::new(Mock { messages: Mutex::new(Some(conversation("handedOff"))), ..Mock::default() });
    *host.pending.lock().unwrap() = true;
    let (follow, finished, interims) = follow_of(Arc::clone(&host), "r1", false, None);
    follow.check().await;
    settle(Duration::from_secs(5)).await;
    assert!(finished.lock().unwrap().is_empty(), "agent work is pending");
    let reported: Vec<(String, String)> = interims.lock().unwrap().iter().map(|a| (a.id.clone(), a.text.clone())).collect();
    assert_eq!(reported, vec![("r1".to_owned(), "handing off".to_owned()), ("r2".to_owned(), "final answer".to_owned())]);
    *host.pending.lock().unwrap() = false;
    settle(Duration::from_secs(16)).await;
    settle(Duration::from_millis(2600)).await;
    assert_eq!(*finished.lock().unwrap(), vec![("completed".to_owned(), "final answer".to_owned(), "r2".to_owned())]);
    assert_eq!(interims.lock().unwrap().len(), 2, "no answer is reported twice");
}

struct Busy(Mutex<bool>);

impl RuntimeView for Busy {
    fn busy(&self) -> bool {
        *self.0.lock().unwrap()
    }
    fn queued_ids(&self) -> Vec<String> {
        Vec::new()
    }
    fn subscribe(&self) -> tokio::sync::mpsc::UnboundedReceiver<()> {
        tokio::sync::mpsc::unbounded_channel().1
    }
}

#[tokio::test(start_paused = true)]
async fn a_busy_session_holds_the_report_until_it_idles() {
    let host = Arc::new(Mock { messages: Mutex::new(Some(conversation("simple"))), ..Mock::default() });
    let runtime = Arc::new(Busy(Mutex::new(true)));
    let (follow, finished, _) = follow_of(host, "r1", false, Some(runtime.clone()));
    follow.check().await;
    settle(Duration::from_secs(20)).await;
    assert!(finished.lock().unwrap().is_empty());
    *runtime.0.lock().unwrap() = false;
    follow.check().await;
    settle(Duration::from_millis(2600)).await;
    assert_eq!(finished.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_restarted_watch_fails_once_its_results_are_never_taken() {
    let owed = Owed { text: "result".into(), meta: json!({"type": "agent_task_result"}) };
    let host = Arc::new(Mock { messages: Mutex::new(Some(conversation("simple"))), owed: Mutex::new(vec![owed]), taken: true, ..Mock::default() });
    let (follow, finished, _) = follow_of(Arc::clone(&host), "r1", true, None);
    follow.check().await;
    for _ in 0..4 {
        settle(Duration::from_secs(16)).await;
    }
    assert_eq!(host.completions.lock().unwrap().len(), 3, "delivered a poll apart, at most three times");
    assert_eq!(*finished.lock().unwrap(), vec![("failed".to_owned(), RESUME_FAILED_TEXT.to_owned(), String::new())]);
}

#[tokio::test(start_paused = true)]
async fn a_vanished_session_is_reported_cancelled() {
    let host = Arc::new(Mock::default());
    let (follow, finished, _) = follow_of(host, "r1", false, None);
    follow.check().await;
    settle(Duration::from_millis(2600)).await;
    assert_eq!(*finished.lock().unwrap(), vec![("cancelled".to_owned(), GONE_TEXT.to_owned(), String::new())]);
}

#[tokio::test(start_paused = true)]
async fn failed_reports_are_retried_after_each_delay_and_the_last_failure_is_returned() {
    let host = Arc::new(Mock::default());
    *host.failures.lock().unwrap() = 2;
    deliver_with_retries(host.as_ref(), &REPORT_RETRY_DELAYS, "agent", "task-1", json!({"runId": "x"})).await.unwrap();
    assert_eq!(host.delivered.lock().unwrap().len(), 1);
    *host.failures.lock().unwrap() = 9;
    let error = deliver_with_retries(host.as_ref(), &REPORT_RETRY_DELAYS, "agent", "task-1", json!({"runId": "y"})).await.unwrap_err();
    assert_eq!(error, "home unavailable");
    assert_eq!(*host.failures.lock().unwrap(), 5, "one try and three retries");
}

fn watch(run_id: &str, session: &str, owner: &str) -> Value {
    json!({"runId": run_id, "agentId": "mixy", "homeSessionId": "room:home", "taskSessionId": session, "title": "Fix it", "target": "session", "hop": 2, "owner": owner, "at": 1})
}

#[tokio::test(start_paused = true)]
async fn recovery_reports_a_gone_session_once_and_skips_this_process_s_own_watches() {
    mixdog_rt::testing::tokens();
    let host = Arc::new(Mock::default());
    *host.watches.lock().unwrap() = vec![watch("w1", "task-9", "old-process"), watch("w2", "task-8", "this-process")];
    *host.owned.lock().unwrap() = vec![json!({"runId": "q1", "agentId": "mixy", "taskSessionId": "task-7", "owner": "old-process"})];
    let count = recover_task_watches(host.clone(), "this-process").await;
    assert_eq!(count, 2);
    let delivered = host.delivered.lock().unwrap().clone();
    assert_eq!(delivered.len(), 1, "quiet work reports nothing");
    assert_eq!(
        delivered[0],
        (
            "mixy".to_owned(),
            json!({
                "runId": "w1_end", "taskSessionId": "task-9", "title": "Fix it", "status": "cancelled", "text": GONE_TEXT,
                "target": "session", "hop": 2, "from": "room:home", "watchId": "w1",
            })
        )
    );
    assert_eq!(*host.disowned.lock().unwrap(), vec!["q1".to_owned()]);
    assert_eq!(*host.ended.lock().unwrap(), vec!["w1".to_owned(), "q1".to_owned()]);
}
