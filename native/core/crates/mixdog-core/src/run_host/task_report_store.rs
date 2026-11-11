//! The daemon's stores behind the task-report host (`TaskReportHost` over `SessionStore` and
//! `AgentRegistry`, `createAgentTaskSessions`' defaults in `agent-task-sessions.mjs`): the session
//! directory (stored messages, runtimes, the queue, completion delivery, a turn's files) and the
//! agent registry, job board and Agents pool (the pending-work reads, the restart failures).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::flow::seams::OwnerNotify;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_core_agents::agents::AgentPool;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::agent_registry::AgentRegistry as Workers;
use mixdog_core_session::session::agent_registry::flow::SessionCompletions;
use mixdog_core_session::session::pending_read::PendingQueue;
use mixdog_rt::DurabilityIo;
use mixdog_services::task_reports::chain::{AgentTask, Owed};
use mixdog_services::task_reports::follow::RuntimeView;
use mixdog_services::task_reports::host::{AgentRegistry, InFlight, SessionStore, TurnArtifacts};
use serde_json::Value;

use super::room_files::turn_files;

/// [`SessionStore`] over the session directory.
pub struct DirectoryReportSessions {
    pub directory: Arc<SessionDirectory>,
    pub queue: Arc<PendingQueue>,
    pub completions: Arc<SessionCompletions>,
    pub lane: DurabilityIo,
    pub data_dir: PathBuf,
    /// `sensitive_scopes(&[home, mixdog home, data dir])`: files under them are never reported.
    pub scopes: Vec<Vec<String>>,
}

#[async_trait]
impl SessionStore for DirectoryReportSessions {
    async fn load_messages(&self, session_id: &str) -> Option<Vec<Value>> {
        self.directory.session_messages(&ThreadId::from(session_id)).await.ok().flatten()
    }

    async fn materialize(&self, session_id: &str) -> Result<Option<Arc<dyn RuntimeView>>, String> {
        // `materializeSession` of a session that does not exist throws `session <id> is not available`
        // (`session-loads.mjs:118`), the text a send's tool result carries.
        self.directory.report_runtime(&ThreadId::from(session_id)).await.map(Some).map_err(|error| match error {
            mixdog_core_api::CoreError::ThreadNotFound { .. } => format!("session {session_id} is not available"),
            other => format!("{other:?}"),
        })
    }

    async fn queued_submission_ids(&self, session_id: &str) -> Vec<String> {
        self.queue.queued_submission_ids(session_id).await
    }

    async fn notify_completion(&self, session_id: &str, text: &str, meta: &Value) -> bool {
        self.completions.notify(session_id, text, meta)
    }

    async fn turn_artifacts(&self, session_id: &str, run_id: &str, _runtime: Option<&Arc<dyn RuntimeView>>) -> Result<TurnArtifacts, String> {
        let found = turn_files(&self.directory, self.lane, &self.data_dir, &self.scopes, session_id, run_id).await?;
        Ok(TurnArtifacts {
            files: found.get("files").and_then(Value::as_array).cloned().unwrap_or_default(),
            omitted: found.get("omitted").and_then(Value::as_f64).unwrap_or(0.0),
        })
    }
}

/// [`AgentRegistry`] over this daemon's agent state.
pub struct DaemonReportAgents {
    pub directory: Arc<SessionDirectory>,
    pub queue: Arc<PendingQueue>,
    pub board: JobBoard,
    pub pool: Arc<AgentPool>,
    pub workers: Arc<Workers>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
}

#[async_trait]
impl AgentRegistry for DaemonReportAgents {
    async fn owed_results(&self, session_id: &str) -> Vec<Owed> {
        self.queue.owed_results(session_id).await
    }

    fn in_flight(&self) -> InFlight {
        let (working, agent_working) = self.directory.in_flight();
        InFlight { working: working.into_iter().map(|id| id.as_str().to_owned()).collect(), agent_working: agent_working.into_iter().collect() }
    }

    fn agent_task_owners(&self) -> HashSet<String> {
        self.board.running_owners()
    }

    fn agent_tasks(&self) -> Vec<AgentTask> {
        self.board
            .list_jobs(&Scope::default())
            .into_iter()
            .map(|job| AgentTask { task_id: job.task_id, session_id: job.meta.session_id.filter(|id| !id.is_empty()), running: job.status == "running" })
            .collect()
    }

    async fn stored_workers(&self, _running: &HashSet<String>) -> Vec<Value> {
        self.pool.list().await.unwrap_or_default()
    }

    async fn settle_restart_failures(&self) -> Result<(), String> {
        let stamp = mixdog_agent::agent_tool::stamp::iso_from_ms((self.now_ms)());
        mixdog_core_session::session::agent_registry::restart::notify_restart_failures(&self.workers, &*self.directory, &self.board, &stamp).await.map(|_| ()).map_err(|error| error.to_string())
    }
}
