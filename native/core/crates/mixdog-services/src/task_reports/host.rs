//! The host the report watchers run over (`createAgentTaskSessions` of `agent-task-sessions.mjs`):
//! `FollowHost` and `RearmHost` in terms of the session directory and the agent registry. The
//! stores themselves are two seams - [`SessionStore`] (the stored sessions, their runtimes and
//! steering queue, the notification bus) and [`AgentRegistry`] (the queued agent results, the
//! in-flight work, the stored workers, the background agent tasks) - the daemon fills; everything
//! the Node module decides over them is here: the three-stage `taskSessionPendingWork`, the
//! report a payload becomes in the bot's home, the files of a turn, the bot-owned work registry
//! and the watch records.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::room_member_of_session;
use serde_json::{Map, Value};

use super::chain::{AgentTask, Owed, Pending, pending_work_of};
use super::follow::{FollowHost, RuntimeView};
use super::rearm::RearmHost;
use crate::bots::delivery::env::RetryTimer;
use crate::bots::delivery::home::{AgentHomeDelivery, TaskReport};
use crate::bots::delivery::queue::WatchError;

/// The files a turn produced (`turnArtifacts`): `omitted` counts those left out of the list.
#[derive(Clone, Debug, Default)]
pub struct TurnArtifacts {
    pub files: Vec<Value>,
    pub omitted: f64,
}

/// The session directory: stored sessions, their live runtimes and the notification bus.
#[async_trait]
pub trait SessionStore: Send + Sync + 'static {
    /// `loadSession(id)`'s `messages`; `None` when the session is gone.
    async fn load_messages(&self, session_id: &str) -> Option<Vec<Value>>;
    /// `service().materializeSession`: the session's runtime; it fails when the session can never load.
    async fn materialize(&self, session_id: &str) -> Result<Option<Arc<dyn RuntimeView>>, String>;
    /// The submission ids still queued (durably) for the session after a restart.
    async fn queued_submission_ids(&self, session_id: &str) -> Vec<String>;
    /// `notifySessionCompletion`: whether a session runtime took the queued result.
    async fn notify_completion(&self, session_id: &str, text: &str, meta: &Value) -> bool;
    /// The files turn `run_id` produced, from its live runtime when one is given, else its stored record.
    async fn turn_artifacts(&self, session_id: &str, run_id: &str, runtime: Option<&Arc<dyn RuntimeView>>) -> Result<TurnArtifacts, String>;
}

/// The agent registry and the process state `pendingWork` reads.
#[async_trait]
pub trait AgentRegistry: Send + Sync + 'static {
    /// The agent results queued for the session that no turn has taken yet (`owedAgentResults`).
    async fn owed_results(&self, session_id: &str) -> Vec<Owed>;
    /// `inFlightSessionActivity()`: the sessions with a turn running, and those an agent runs in.
    fn in_flight(&self) -> InFlight;
    /// `activeBackgroundTaskSessionIds({ surface: 'agent' })`.
    fn agent_task_owners(&self) -> HashSet<String>;
    /// This process's agent tasks (`listBackgroundTasks({ surface: 'agent' })`).
    fn agent_tasks(&self) -> Vec<AgentTask>;
    /// `listStoredAgentWorkersAsync({ runningSessionIds })`: the pool rows.
    async fn stored_workers(&self, running: &HashSet<String>) -> Vec<Value>;
    /// `settleRestartFailures`: the agents the restart killed become queued failure results.
    async fn settle_restart_failures(&self) -> Result<(), String>;
}

#[derive(Clone, Debug, Default)]
pub struct InFlight {
    pub working: HashSet<String>,
    pub agent_working: HashSet<String>,
}

/// `bot-owned-work.mjs`: the live work in a session that a bot sent, by run id in noting order.
pub struct BotWork {
    works: Mutex<Vec<(String, String, String)>>,
    on_change: Arc<dyn Fn(&str) + Send + Sync>,
}

impl BotWork {
    /// `on_change(session_id)` is `emitSessionBotWorkChange`.
    pub fn new(on_change: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        Self { works: Mutex::default(), on_change }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(String, String, String)>> {
        self.works.lock().expect("bot work")
    }

    fn count(works: &[(String, String, String)], session_id: &str, agent_id: &str) -> usize {
        works.iter().filter(|(_, s, a)| s == session_id && a == agent_id).count()
    }

    pub fn note(&self, run_id: &str, session_id: &str, agent_id: &str) {
        if run_id.is_empty() || session_id.is_empty() || agent_id.is_empty() {
            return;
        }
        let first = {
            let mut works = self.lock();
            if works.iter().any(|(r, ..)| r == run_id) {
                return;
            }
            works.push((run_id.to_owned(), session_id.to_owned(), agent_id.to_owned()));
            Self::count(&works, session_id, agent_id) == 1
        };
        if first {
            (self.on_change)(session_id);
        }
    }

    pub fn end(&self, run_id: &str) {
        let gone = {
            let mut works = self.lock();
            let Some(at) = works.iter().position(|(r, ..)| r == run_id) else { return };
            let (_, session, agent) = works.remove(at);
            (Self::count(&works, &session, &agent) == 0).then_some(session)
        };
        if let Some(session) = gone {
            (self.on_change)(&session);
        }
    }

    /// `botWorkBySession`: every session with owned work and the bots owning it, each once.
    pub fn by_session(&self) -> Vec<(String, Vec<String>)> {
        let mut out: Vec<(String, Vec<String>)> = Vec::new();
        for (_, session, agent) in self.lock().iter() {
            match out.iter_mut().find(|(s, _)| s == session) {
                Some((_, agents)) => {
                    if !agents.contains(agent) {
                        agents.push(agent.clone());
                    }
                }
                None => out.push((session.clone(), vec![agent.clone()])),
            }
        }
        out
    }
}

/// What reaches the bot's home: the report a `deliver` payload carries (`enqueueTask`).
pub fn report_of(payload: &Value) -> TaskReport {
    let text = |key: &str| payload.get(key).filter(|v| !v.is_null()).map_or_else(String::new, mixdog_js::value_to_string);
    let number = |key: &str| mixdog_js::to_number_of(payload.get(key));
    let finite = |n: f64| if n.is_nan() { 0.0 } else { n };
    TaskReport {
        run_id: text("runId"),
        task_session_id: text("taskSessionId"),
        title: text("title"),
        status: text("status"),
        text: text("text"),
        target: payload.get("target").and_then(Value::as_str).map(str::to_owned),
        files: payload.get("files").and_then(Value::as_array).cloned().unwrap_or_default(),
        omitted: finite(number("omitted")),
        hop: finite(number("hop")),
        watch_id: text("watchId"),
        watch_ids: payload.get("watchIds").and_then(Value::as_array).map(|ids| ids.iter().map(mixdog_js::value_to_string).collect()).unwrap_or_default(),
        progress_run_id: text("progressRunId"),
        from: text("from"),
        progress_watch_id: text("progressWatchId"),
        answer_id: text("answerId"),
    }
}

/// The bot home's delivery queue and the watch records it keeps (`agent-home-delivery.mjs`).
#[async_trait]
pub trait HomeQueue: Send + Sync + 'static {
    async fn enqueue_task(&self, agent_id: &str, report: &TaskReport) -> Result<(), String>;
    async fn disown(&self, run_id: &str) -> Result<(), String>;
    async fn watches(&self) -> Result<Vec<Value>, String>;
    async fn owned(&self) -> Result<Vec<Value>, String>;
    /// `watches.add`: the durable watch of a reporting turn, stored before the turn can start.
    async fn watch(&self, watch: Value) -> Result<(), WatchError>;
    /// `watches.remove`: the watch of a turn that was never taken.
    async fn unwatch(&self, run_id: &str) -> Result<(), String>;
    /// `watches.own`: the durable record of a bot's work that reports nothing.
    async fn own(&self, work: Value) -> Result<(), String>;
    /// `watches.disown(ids)`: the records of the work one turn ended, in one write.
    async fn disown_all(&self, run_ids: Vec<String>) -> Result<(), String>;
    /// `watches.follow(runId, submissionId)`: the watch of `run_id` follows the turn submitted as
    /// `submission_id`.
    async fn follow(&self, run_id: &str, submission_id: &str) -> Result<(), String>;
}

#[async_trait]
impl HomeQueue for Arc<AgentHomeDelivery> {
    async fn enqueue_task(&self, agent_id: &str, report: &TaskReport) -> Result<(), String> {
        AgentHomeDelivery::enqueue_task(self, agent_id, report).await.map(|_| ())
    }
    async fn disown(&self, run_id: &str) -> Result<(), String> {
        self.disown_task(vec![run_id.to_owned()]).await
    }
    async fn watch(&self, watch: Value) -> Result<(), WatchError> {
        self.watch_task(watch).await
    }
    async fn unwatch(&self, run_id: &str) -> Result<(), String> {
        self.unwatch_task(run_id).await
    }
    async fn own(&self, work: Value) -> Result<(), String> {
        self.own_task(work).await
    }
    async fn disown_all(&self, run_ids: Vec<String>) -> Result<(), String> {
        self.disown_task(run_ids).await
    }
    async fn watches(&self) -> Result<Vec<Value>, String> {
        self.task_watches().await
    }
    async fn owned(&self) -> Result<Vec<Value>, String> {
        self.owned_tasks().await
    }
    async fn follow(&self, run_id: &str, submission_id: &str) -> Result<(), String> {
        self.follow_task(run_id, submission_id).await
    }
}

/// The host of the report watchers over one daemon's stores.
pub struct TaskReportHost {
    home: Arc<dyn HomeQueue>,
    sessions: Arc<dyn SessionStore>,
    agents: Arc<dyn AgentRegistry>,
    bot_work: Arc<BotWork>,
    timer: Arc<dyn RetryTimer>,
}

impl TaskReportHost {
    pub fn new(home: Arc<dyn HomeQueue>, sessions: Arc<dyn SessionStore>, agents: Arc<dyn AgentRegistry>, bot_work: Arc<BotWork>, timer: Arc<dyn RetryTimer>) -> Arc<Self> {
        Arc::new(Self { home, sessions, agents, bot_work, timer })
    }

    /// The bot home's queue and watch records.
    pub fn home(&self) -> &Arc<dyn HomeQueue> {
        &self.home
    }
}

#[async_trait]
impl FollowHost for TaskReportHost {
    async fn load_messages(&self, session_id: &str) -> Option<Vec<Value>> {
        self.sessions.load_messages(session_id).await
    }

    async fn owed_results(&self, session_id: &str) -> Vec<Owed> {
        self.agents.owed_results(session_id).await
    }

    async fn deliver_completion(&self, session_id: &str, text: &str, meta: &Value) -> Result<bool, String> {
        Ok(self.sessions.notify_completion(session_id, text, meta).await)
    }

    /// `taskSessionPendingWork`: the live state first, then the queued results, then the stored pool.
    fn timer(&self) -> Arc<dyn RetryTimer> {
        Arc::clone(&self.timer)
    }

    async fn pending_work(&self, session_id: &str, task_ids: Option<&HashSet<String>>) -> bool {
        let InFlight { working, agent_working } = self.agents.in_flight();
        let mut pending = Pending {
            agent_working,
            agent_task_owners: self.agents.agent_task_owners(),
            agent_tasks: if task_ids.is_some() { self.agents.agent_tasks() } else { Vec::new() },
            working,
            ..Pending::default()
        };
        if pending_work_of(session_id, &pending, task_ids) {
            return true;
        }
        pending.owed = self.agents.owed_results(session_id).await;
        if pending_work_of(session_id, &pending, task_ids) {
            return true;
        }
        pending.pool = self.agents.stored_workers(&pending.working).await;
        pending_work_of(session_id, &pending, task_ids)
    }
}

#[async_trait]
impl RearmHost for TaskReportHost {
    async fn deliver(&self, agent_id: &str, payload: Value) -> Result<(), String> {
        self.home.enqueue_task(agent_id, &report_of(&payload)).await
    }

    async fn disown(&self, run_id: &str) -> Result<(), String> {
        self.home.disown(run_id).await
    }

    async fn materialize_session(&self, session_id: &str) -> Result<Option<Arc<dyn RuntimeView>>, String> {
        self.sessions.materialize(session_id).await
    }

    async fn queued_submission_ids(&self, session_id: &str) -> Vec<String> {
        self.sessions.queued_submission_ids(session_id).await
    }

    /// `artifactFields`: `{ files, omitted? }`, none when the turn produced no files; a failed
    /// collection is logged and reports none.
    async fn artifact_fields(&self, session_id: &str, turn_id: &str, runtime: Option<&Arc<dyn RuntimeView>>) -> Map<String, Value> {
        let mut fields = Map::new();
        match self.sessions.turn_artifacts(session_id, turn_id, runtime).await {
            Ok(TurnArtifacts { files, omitted }) if !files.is_empty() => {
                fields.insert("files".into(), Value::Array(files));
                if omitted != 0.0 {
                    fields.insert("omitted".into(), mixdog_js::json_number(omitted));
                }
            }
            Ok(_) => {}
            Err(error) => mixdog_rt::node_stderr!("mixdog task sessions: collecting the files of {session_id} failed: {error}"),
        }
        fields
    }

    fn note_bot_work(&self, run_id: &str, session_id: &str, agent_id: &str) {
        self.bot_work.note(run_id, session_id, agent_id);
    }

    fn end_bot_work(&self, run_id: &str) {
        self.bot_work.end(run_id);
    }

    fn is_room_member_session(&self, session_id: &str) -> bool {
        room_member_of_session(session_id).is_some()
    }

    async fn list_watches(&self) -> Result<Vec<Value>, String> {
        self.home.watches().await
    }

    async fn owned_work(&self) -> Result<Vec<Value>, String> {
        self.home.owned().await
    }

    async fn settle_agent_results(&self) -> Result<(), String> {
        self.agents.settle_restart_failures().await
    }
}
