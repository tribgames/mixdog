//! `TaskReportHost` over scripted stores: the staged pending-work read, the report a payload
//! becomes, the files of a turn, the watch records and the bot-owned work registry.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::chain::{AgentTask, Owed};
use super::follow::{FollowHost, RuntimeView};
use super::host::{AgentRegistry, BotWork, HomeQueue, InFlight, SessionStore, TaskReportHost, TurnArtifacts};
use super::rearm::RearmHost;
use crate::bots::delivery::env::SleepRetry;
use crate::bots::delivery::home::TaskReport;

#[derive(Default)]
struct Home {
    reports: Mutex<Vec<(String, TaskReport)>>,
    fail: bool,
    disowned: Mutex<Vec<String>>,
}

#[async_trait]
impl HomeQueue for Home {
    async fn enqueue_task(&self, agent_id: &str, report: &TaskReport) -> Result<(), String> {
        if self.fail {
            return Err("home unavailable".into());
        }
        self.reports.lock().unwrap().push((agent_id.to_owned(), report.clone()));
        Ok(())
    }
    async fn disown(&self, run_id: &str) -> Result<(), String> {
        self.disowned.lock().unwrap().push(run_id.to_owned());
        Ok(())
    }
    async fn watches(&self) -> Result<Vec<Value>, String> {
        Ok(vec![json!({"runId": "w1"})])
    }
    async fn owned(&self) -> Result<Vec<Value>, String> {
        Ok(vec![json!({"runId": "o1"})])
    }
    async fn watch(&self, _: Value) -> Result<(), crate::bots::delivery::queue::WatchError> {
        Ok(())
    }
    async fn unwatch(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn own(&self, _: Value) -> Result<(), String> {
        Ok(())
    }
    async fn disown_all(&self, _: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    async fn follow(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct Sessions {
    artifacts: Mutex<Option<Result<TurnArtifacts, String>>>,
    taken: bool,
}

#[async_trait]
impl SessionStore for Sessions {
    async fn load_messages(&self, session_id: &str) -> Option<Vec<Value>> {
        (session_id == "known").then(|| vec![json!({"role": "user"})])
    }
    async fn materialize(&self, _session_id: &str) -> Result<Option<Arc<dyn RuntimeView>>, String> {
        Err("can never load".into())
    }
    async fn queued_submission_ids(&self, _session_id: &str) -> Vec<String> {
        vec!["s1".into()]
    }
    async fn notify_completion(&self, _session_id: &str, _text: &str, _meta: &Value) -> bool {
        self.taken
    }
    async fn turn_artifacts(&self, _session_id: &str, _run_id: &str, _runtime: Option<&Arc<dyn RuntimeView>>) -> Result<TurnArtifacts, String> {
        self.artifacts.lock().unwrap().clone().unwrap_or_else(|| Ok(TurnArtifacts::default()))
    }
}

#[derive(Default)]
struct Agents {
    in_flight: InFlight,
    owners: HashSet<String>,
    tasks: Vec<AgentTask>,
    owed: Vec<Owed>,
    pool: Vec<Value>,
    owed_reads: AtomicUsize,
    pool_reads: AtomicUsize,
    settled: AtomicUsize,
}

#[async_trait]
impl AgentRegistry for Agents {
    async fn owed_results(&self, _session_id: &str) -> Vec<Owed> {
        self.owed_reads.fetch_add(1, Ordering::SeqCst);
        self.owed.clone()
    }
    fn in_flight(&self) -> InFlight {
        self.in_flight.clone()
    }
    fn agent_task_owners(&self) -> HashSet<String> {
        self.owners.clone()
    }
    fn agent_tasks(&self) -> Vec<AgentTask> {
        self.tasks.clone()
    }
    async fn stored_workers(&self, _running: &HashSet<String>) -> Vec<Value> {
        self.pool_reads.fetch_add(1, Ordering::SeqCst);
        self.pool.clone()
    }
    async fn settle_restart_failures(&self) -> Result<(), String> {
        self.settled.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn host(home: Arc<Home>, sessions: Sessions, agents: Arc<Agents>) -> (Arc<TaskReportHost>, Arc<BotWork>, Arc<Mutex<Vec<String>>>) {
    let changes: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = Arc::clone(&changes);
    let bot_work = Arc::new(BotWork::new(Arc::new(move |session| sink.lock().unwrap().push(session.to_owned()))));
    (TaskReportHost::new(home, Arc::new(sessions), agents, Arc::clone(&bot_work), Arc::new(SleepRetry)), bot_work, changes)
}

#[tokio::test]
async fn pending_work_reads_the_live_state_before_the_queue_and_the_queue_before_the_pool() {
    let live = Arc::new(Agents { owners: HashSet::from(["lead".to_owned()]), ..Agents::default() });
    let (h, ..) = host(Arc::default(), Sessions::default(), Arc::clone(&live));
    assert!(h.pending_work("lead", None).await);
    assert_eq!((live.owed_reads.load(Ordering::SeqCst), live.pool_reads.load(Ordering::SeqCst)), (0, 0), "the live state decided");

    let queued = Arc::new(Agents { owed: vec![Owed { text: "done".into(), meta: json!({}) }], ..Agents::default() });
    let (h, ..) = host(Arc::default(), Sessions::default(), Arc::clone(&queued));
    assert!(h.pending_work("lead", None).await);
    assert_eq!((queued.owed_reads.load(Ordering::SeqCst), queued.pool_reads.load(Ordering::SeqCst)), (1, 0), "the queue decided");

    let pooled = Arc::new(Agents { pool: vec![json!({"sessionId": "child", "ownerSessionId": "lead", "status": "running"})], ..Agents::default() });
    let (h, ..) = host(Arc::default(), Sessions::default(), Arc::clone(&pooled));
    assert!(h.pending_work("lead", None).await);
    assert!(!h.pending_work("other", None).await);
    assert_eq!(pooled.pool_reads.load(Ordering::SeqCst), 2);

    let idle = Arc::new(Agents::default());
    let (h, ..) = host(Arc::default(), Sessions::default(), idle);
    assert!(!h.pending_work("lead", None).await);
}

#[tokio::test]
async fn a_chain_counts_only_its_own_agent_tasks() {
    let agents = Arc::new(Agents { tasks: vec![AgentTask { task_id: "t1".into(), session_id: Some("child".into()), running: true }], ..Agents::default() });
    let (h, ..) = host(Arc::default(), Sessions::default(), agents);
    assert!(h.pending_work("lead", Some(&HashSet::from(["t1".to_owned()]))).await);
    assert!(!h.pending_work("lead", Some(&HashSet::from(["t2".to_owned()]))).await);
    assert!(!h.pending_work("lead", None).await, "without a chain the tasks are not read");
}

#[tokio::test]
async fn deliver_queues_the_report_the_payload_names_and_surfaces_a_failure() {
    let home = Arc::new(Home::default());
    let (h, ..) = host(Arc::clone(&home), Sessions::default(), Arc::default());
    let payload = json!({
        "runId": "task-1_a1_end", "taskSessionId": "task-1", "title": "T", "status": "completed", "text": "answer", "target": "session",
        "hop": 2, "watchId": "w1", "progressRunId": "task-1_progress_a1", "from": "room:x", "files": [{"path": "a"}], "omitted": 3,
    });
    h.deliver("agent-1", payload).await.unwrap();
    let (agent, report) = home.reports.lock().unwrap()[0].clone();
    assert_eq!(agent, "agent-1");
    assert_eq!((report.run_id.as_str(), report.task_session_id.as_str(), report.status.as_str(), report.text.as_str()), ("task-1_a1_end", "task-1", "completed", "answer"));
    assert_eq!((report.target.as_deref(), report.hop, report.omitted, report.watch_id.as_str()), (Some("session"), 2.0, 3.0, "w1"));
    assert_eq!((report.files.len(), report.progress_run_id.as_str(), report.from.as_str()), (1, "task-1_progress_a1", "room:x"));

    let (h, ..) = host(Arc::new(Home { fail: true, ..Home::default() }), Sessions::default(), Arc::default());
    assert_eq!(h.deliver("agent-1", json!({"runId": "r"})).await.unwrap_err(), "home unavailable");
}

#[tokio::test]
async fn artifact_fields_name_the_files_and_omit_what_is_empty_or_failed() {
    let with = |result| Sessions { artifacts: Mutex::new(Some(result)), ..Sessions::default() };
    let (h, ..) = host(Arc::default(), with(Ok(TurnArtifacts { files: vec![json!({"path": "a"})], omitted: 2.0 })), Arc::default());
    assert_eq!(Value::Object(h.artifact_fields("s", "t", None).await), json!({"files": [{"path": "a"}], "omitted": 2}));
    let (h, ..) = host(Arc::default(), with(Ok(TurnArtifacts { files: vec![json!({"path": "a"})], omitted: 0.0 })), Arc::default());
    assert_eq!(Value::Object(h.artifact_fields("s", "t", None).await), json!({"files": [{"path": "a"}]}));
    let (h, ..) = host(Arc::default(), with(Ok(TurnArtifacts { files: Vec::new(), omitted: 4.0 })), Arc::default());
    assert!(h.artifact_fields("s", "t", None).await.is_empty(), "no files, no fields");
    let (h, ..) = host(Arc::default(), with(Err("unreadable".into())), Arc::default());
    assert!(h.artifact_fields("s", "t", None).await.is_empty(), "a failed collection reports none");
}

#[tokio::test]
async fn the_stores_answer_through_the_host() {
    let home = Arc::new(Home::default());
    let agents = Arc::new(Agents::default());
    let (h, ..) = host(Arc::clone(&home), Sessions { taken: true, ..Sessions::default() }, Arc::clone(&agents));
    assert_eq!(h.load_messages("known").await.map(|m| m.len()), Some(1));
    assert!(h.load_messages("gone").await.is_none());
    assert!(h.deliver_completion("known", "t", &json!({})).await.unwrap());
    assert_eq!(h.queued_submission_ids("known").await, vec!["s1".to_owned()]);
    assert_eq!(h.materialize_session("known").await.err().as_deref(), Some("can never load"));
    assert_eq!(h.list_watches().await.unwrap(), vec![json!({"runId": "w1"})]);
    assert_eq!(h.owned_work().await.unwrap(), vec![json!({"runId": "o1"})]);
    h.disown("w1").await.unwrap();
    assert_eq!(*home.disowned.lock().unwrap(), vec!["w1".to_owned()]);
    h.settle_agent_results().await.unwrap();
    assert_eq!(agents.settled.load(Ordering::SeqCst), 1);
    assert!(!h.is_room_member_session("plain-session"));
}

#[test]
fn bot_work_announces_only_the_first_and_last_work_of_a_bot_in_a_session() {
    let (_, work, changes) = host(Arc::default(), Sessions::default(), Arc::default());
    work.note("r1", "s1", "a1");
    work.note("r1", "s1", "a1");
    work.note("r2", "s1", "a1");
    work.note("r3", "s1", "a2");
    work.note("", "s1", "a1");
    assert_eq!(*changes.lock().unwrap(), vec!["s1".to_owned(), "s1".to_owned()], "a1's first work and a2's");
    assert_eq!(work.by_session(), vec![("s1".to_owned(), vec!["a1".to_owned(), "a2".to_owned()])]);
    work.end("r1");
    assert_eq!(changes.lock().unwrap().len(), 2, "a1 still has r2");
    work.end("r2");
    work.end("missing");
    assert_eq!(changes.lock().unwrap().len(), 3);
    assert_eq!(work.by_session(), vec![("s1".to_owned(), vec!["a2".to_owned()])]);
}
