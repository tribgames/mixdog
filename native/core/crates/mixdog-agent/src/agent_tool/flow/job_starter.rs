//! One agent job as a background task (Node `spawn-flow/job-start.mjs`): the immutable
//! owner/caller notify context, resource admission before any agent work, and status
//! publication at start and after terminal settlement.

use std::future::Future;
use std::sync::Arc;
use std::sync::OnceLock;

use crate::cancel::{AGENT_TASK_CANCEL, Cancel, JOB_CANCELLED};
use mixdog_rt::TaskClass;
use mixdog_tools::orch::agent::TaskResult;

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

fn publish_status_after_tick(changed: Arc<dyn Fn() + Send + Sync>) {
    let check_phase = mixdog_rt::time::check_phase();
    drop(mixdog_rt::spawn("agent-status-changed", TaskClass::Work, async move {
        check_phase.await;
        changed()
    }));
}

/// The job's cancellation: its token aborts, which its admission and its work in flight each answer themselves
/// ([`work_until_cancelled`]).
fn cancel_hook(token: Cancel, status_changed: Arc<dyn Fn() + Send + Sync>) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || {
        token.abort(JOB_CANCELLED);
        publish_status_after_tick(status_changed.clone());
    })
}

/// The job's work until it ends. A cancellation that comes while it is in flight closes the turn the job submitted
/// ([`JobHandle::turns`]), named by its id, and nothing else on the session: before the job submitted a turn and once
/// its turn is over it has nothing there to stop, whatever runs on the session by then. A close that began is carried
/// to its end, also when the work ends first.
///
/// The work is never dropped here: it holds its claim, its review and its row, which it settles itself. A turn that was
/// not submitted ends by the same cancellation ([`JobHandle::cancel`], which the turn's waits race:
/// [`super::turn::TurnRunner`]), and the work returns.
async fn work_until_cancelled<Fut>(work: Fut, cancelled: &Cancel, job: &JobHandle, sessions: &dyn Sessions) -> Fut::Output
where
    Fut: Future,
{
    tokio::pin!(work);
    tokio::select! {
        biased;
        outcome = &mut work => return outcome,
        () = cancelled.cancelled() => {}
    }
    let mut turns = job.turns();
    let mut closed = None;
    loop {
        let next = async { turns.wait_for(|turn| turn.is_some() && *turn != closed).await.ok().and_then(|turn| turn.clone()) };
        let submitted = tokio::select! {
            biased;
            outcome = &mut work => return outcome,
            submitted = next => submitted,
        };
        let Some(turn) = submitted else { return work.await };
        {
            let closing = sessions.close_turn(&turn.session_id, &turn.turn_id, AGENT_TASK_CANCEL);
            tokio::pin!(closing);
            tokio::select! {
                biased;
                outcome = &mut work => {
                    closing.await;
                    return outcome;
                }
                _ = &mut closing => {}
            }
        }
        closed = Some(turn);
    }
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
        let label =
            meta.tag.clone().filter(|t| !t.is_empty()).or_else(|| meta.session_id.clone().filter(|s| !s.is_empty())).unwrap_or_else(|| operation.to_owned());
        let admission_cancel = Cancel::new();
        let session = meta.session_id.clone().filter(|s| !s.is_empty());
        let handle: Arc<OnceLock<Arc<JobHandle>>> = Arc::default();
        let cancel = cancel_hook(admission_cancel.clone(), self.status_changed.clone());
        let (published, announced) = tokio::sync::oneshot::channel::<()>();
        let id = {
            let (board, admission, status_changed, handle) = (self.board.clone(), self.admission.clone(), self.status_changed.clone(), handle.clone());
            let sessions = self.sessions.clone();
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
                    job.set_cancel(admission_cancel.clone());
                    let _ = handle.set(job.clone());
                    async move {
                        let _ = announced.await;
                        let lease = admission.acquire(&label, owner_key.as_deref(), &admission_cancel).await?;
                        job.set_slot(lease.yielder());
                        job.set_stage(super::stages::TurnStage::Admitted);
                        mixdog_rt::time::immediate().await;
                        let outcome = if job.is_cancelled() {
                            Ok(None)
                        } else {
                            work_until_cancelled(run(job.clone(), notify_for_run), &admission_cancel, &job, &*sessions).await
                        };
                        lease.release().await;
                        publish_status_after_tick(status_changed);
                        outcome.map(|value| value.map(|v| TaskResult::Json(v.value)))
                    }
                },
            )?
        };
        let job = handle.get().cloned().ok_or_else(|| "agent job did not start".to_owned())?;
        let turns = self.turns.clone();
        self.board.set_report_appendix(
            &id,
            Arc::new(move |current: Option<&str>| match current.filter(|s| !s.is_empty()).map(str::to_owned).or_else(|| session.clone()) {
                Some(session) => turns.not_done_report(&session),
                None => String::new(),
            }),
        );
        self.board.set_hop(&id, context.hop.as_ref().and_then(|h| h.as_u64()).map_or(0, |h| u32::try_from(h).unwrap_or(u32::MAX)));
        if let Some(call) = non_empty(&context.tool_call_id) {
            self.starts.record(&call, &id);
        }
        (self.status_changed)();
        let _ = published.send(());
        Ok(job)
    }
}
