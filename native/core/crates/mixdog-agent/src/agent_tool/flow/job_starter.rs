//! One agent job as a background task (Node `spawn-flow/job-start.mjs`): the immutable
//! owner/caller notify context, resource admission before any agent work, and status
//! publication at start and after terminal settlement.

use std::future::Future;
use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_rt::TaskClass;
use mixdog_tools::orch::agent::TaskResult;
use crate::cancel::{Cancel, JOB_CANCELLED};

use super::notify::NotifyContext;
use super::reconcile::JobHandle;
use super::result::WorkerResult;
use super::seams::Admission;
use super::seams::TaskStarts;
use super::seams::TurnSessions;
use crate::agent_tool::board::JobBoard;
use crate::agent_tool::board::JobMeta;
use crate::agent_tool::board::JobOwner;
use crate::agent_tool::board::NewJob;
use crate::agent_tool::host::CloseOptions;
use crate::agent_tool::host::Sessions;
use crate::agent_tool::scope::clean_str;

/// The caller of a job, as the tool call that starts it knows it (Node `notifyContext`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct StartContext {
    /// `callerSessionId || sessionId`.
    pub caller_session_id: Option<String>,
    pub owner_session_id: Option<String>,
    /// `clientHostPid`, when positive.
    pub client_host_pid: Option<u64>,
    pub hop: Option<serde_json::Value>,
    /// The model's tool call that starts the job; its result message carries the job's id.
    pub tool_call_id: Option<String>,
}

pub struct JobStarter {
    board: JobBoard,
    sessions: Arc<dyn Sessions>,
    turns: Arc<dyn TurnSessions>,
    admission: Arc<dyn Admission>,
    starts: Arc<dyn TaskStarts>,
    status_changed: Arc<dyn Fn() + Send + Sync>,
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.as_deref().map(clean_str).filter(|s| !s.is_empty())
}

impl JobStarter {
    pub fn new(
        board: JobBoard,
        sessions: Arc<dyn Sessions>,
        turns: Arc<dyn TurnSessions>,
        admission: Arc<dyn Admission>,
        starts: Arc<dyn TaskStarts>,
        status_changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self { board, sessions, turns, admission, starts, status_changed }
    }

    /// `startJob`: registers the job and runs `run` as its work once the agent lane admits it.
    /// What `run` returns completes the job; its failure fails it; a job cancelled before its
    /// work starts runs nothing.
    pub fn start_job<F, Fut>(&self, operation: &str, meta: JobMeta, context: StartContext, run: F) -> Result<Arc<JobHandle>, String>
    where
        F: FnOnce(Arc<JobHandle>, NotifyContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<WorkerResult>, String>> + Send + 'static,
    {
        let caller = non_empty(&context.caller_session_id);
        let owner = non_empty(&context.owner_session_id).or_else(|| caller.clone());
        let notify = NotifyContext {
            caller_session_id: caller.clone(),
            owner_session_id: owner.clone(),
            client_host_pid: context.client_host_pid.filter(|p| *p > 0),
            hop: context.hop.clone(),
        };
        let label = meta.tag.clone().filter(|t| !t.is_empty()).or_else(|| meta.session_id.clone().filter(|s| !s.is_empty())).unwrap_or_else(|| operation.to_owned());
        let admission_cancel = Cancel::new();
        // Read once: the board calls `cancel` and the report appendix with its table locked, so
        // neither may look the row up again.
        let session = meta.session_id.clone().filter(|s| !s.is_empty());
        let cancel: Arc<dyn Fn() + Send + Sync> = {
            let (token, sessions, session, changed) = (admission_cancel.clone(), self.sessions.clone(), session.clone(), self.status_changed.clone());
            Arc::new(move || {
                token.abort(JOB_CANCELLED);
                let (changed, sessions, session) = (changed.clone(), sessions.clone(), session.clone());
                drop(mixdog_rt::spawn("agent-task-cancel", TaskClass::Work, async move {
                    if let Some(session) = session {
                        sessions.close_session(&session, "agent-task-cancel", CloseOptions { tombstone: false, owner_close: false }).await;
                    }
                    changed();
                }));
            })
        };
        let handle: Arc<OnceLock<Arc<JobHandle>>> = Arc::default();
        // The job's work waits for its first status to go out: a caller sees the running card
        // before any agent work begins.
        let (published, announced) = tokio::sync::oneshot::channel::<()>();
        let id = {
            let (board, admission, status_changed, handle) = (self.board.clone(), self.admission.clone(), self.status_changed.clone(), handle.clone());
            let (label, owner_key) = (label.clone(), owner.clone().or_else(|| notify.client_host_pid.map(|p| p.to_string())));
            let notify_for_run = notify.clone();
            let operation_for_run = operation.to_owned();
            self.board.start(
                NewJob {
                    task_id: None,
                    operation: operation.to_owned(),
                    label: Some(label.clone()),
                    owner: JobOwner { caller_session_id: caller, owner_session_id: owner, host_pid: notify.client_host_pid },
                    meta,
                    // Cancellation reaches the owner once, with the worker's partial output.
                    notify_on_cancel: true,
                    cancel: Some(cancel),
                    started_at_ms: None,
                    cwd: None,
                    render: None,
                },
                move |id| {
                    let job = Arc::new(JobHandle::new(board, id.clone(), operation_for_run, notify_for_run.client_host_pid));
                    let _ = handle.set(job.clone());
                    async move {
                        let _ = announced.await;
                        let lease = admission.acquire(&label, owner_key.as_deref(), &admission_cancel).await?;
                        // Yield before doing agent work, so a caller sees the `running` card first.
                        job.set_slot(lease.yielder());
                        tokio::task::yield_now().await;
                        let outcome = if job.is_cancelled() { Ok(None) } else { run(job, notify_for_run).await };
                        lease.release().await;
                        // The board stamps the terminal state in its next continuation; publish after it.
                        drop(mixdog_rt::spawn("agent-status-changed", TaskClass::Work, async move { status_changed() }));
                        outcome.map(|value| value.map(|v| TaskResult::Json(v.value)))
                    }
                },
            )?
        };
        let job = handle.get().cloned().ok_or_else(|| "agent job did not start".to_owned())?;
        // Success, failure or cancellation: the report names what the agent's own todo list
        // leaves undone. The owner never receives the list otherwise.
        if let Some(session) = session {
            let turns = self.turns.clone();
            self.board.set_report_appendix(&id, Arc::new(move || turns.not_done_report(&session)));
        }
        if let Some(call) = non_empty(&context.tool_call_id) {
            self.starts.record(&call, &id);
        }
        (self.status_changed)();
        let _ = published.send(());
        Ok(job)
    }
}
