//! Background-task reconcile for a worker turn (Node `agent-tool/job-task-reconcile.mjs`,
//! spawn and send alike). A turn marks its task terminal from three windows:
//!
//! 1. its terminal result: the worker produced its final answer. Reconciling here, not after
//!    the session save, keeps a slow post-result step from stranding the task in `running`; an
//!    empty or abnormal finish is a failure, so the card reads `error: …`;
//! 2. a throw: no terminal result exists, so only the outer reject path would notify; the
//!    owner gets a failure notification instead of a task stuck in `running`;
//! 3. the finally net: a post-result step (the session save) that hung or threw after a
//!    terminal result already existed.
//!
//! Every call is idempotent (the first terminal state wins, so the outer reject path cannot
//! notify twice) and reporting on a turn never breaks it.
//!
//! Not ported: the progress watchdog's partial handoff (`reconcileJobWatchdogPartial`). It
//! reconciles a turn the watchdog aborted on silence; nothing aborts a turn on silence here.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use serde_json::Map;
use serde_json::Value;

use super::early::EarlyNotice;
use super::result::WorkerResult;
use super::result::completion_value;
use super::review::TurnReview;
use super::seams::TurnError;
use super::seams::TurnResult;
use crate::agent_tool::board::Completion;
use crate::agent_tool::board::JobBoard;
use crate::agent_tool::board::JobSnapshot;
use crate::agent_tool::scope::Scope;
use mixdog_tools::orch::agent::TaskResult;

/// How a worker turn ended, as the runner tracks it (`finalStatus`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FinalStatus {
    Idle,
    Error,
    Cancelled,
}

impl FinalStatus {
    pub fn word(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

/// The job a turn runs under: its row on the board and what the flow keeps beside it
/// (`_terminalResultValue`, `_earlyCompletionNotified`).
pub struct JobHandle {
    board: JobBoard,
    task_id: String,
    operation: String,
    host_pid: Option<u64>,
    terminal: Mutex<Option<WorkerResult>>,
    early_notified: AtomicBool,
    slot: std::sync::OnceLock<std::sync::Arc<dyn crate::env::Yielder>>,
}

impl JobHandle {
    pub fn new(board: JobBoard, task_id: String, operation: String, host_pid: Option<u64>) -> Self {
        Self { board, task_id, operation, host_pid, terminal: Mutex::new(None), early_notified: AtomicBool::new(false), slot: std::sync::OnceLock::new() }
    }

    /// The admitted slot the job's turn hands back around provider requests.
    pub fn set_slot(&self, slot: std::sync::Arc<dyn crate::env::Yielder>) {
        let _ = self.slot.set(slot);
    }

    pub fn slot(&self) -> Option<std::sync::Arc<dyn crate::env::Yielder>> {
        self.slot.get().cloned()
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    pub fn host_pid(&self) -> Option<u64> {
        self.host_pid
    }

    pub fn snapshot(&self) -> Option<JobSnapshot> {
        self.board.get(&self.task_id, &Scope::default())
    }

    pub fn status(&self) -> Option<String> {
        self.snapshot().map(|s| s.status)
    }

    pub fn is_cancelled(&self) -> bool {
        self.status().as_deref() == Some("cancelled")
    }

    /// Why the run ended, when its ender said.
    pub fn terminal_reason(&self) -> Option<String> {
        self.snapshot().and_then(|s| s.terminal_reason)
    }

    pub fn terminal_value(&self) -> Option<WorkerResult> {
        self.terminal.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_terminal_value(&self, value: WorkerResult) {
        *self.terminal.lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
    }

    pub(crate) fn mark_early_notified(&self) {
        self.early_notified.store(true, Ordering::SeqCst);
    }

    pub(crate) fn early_notified(&self) -> bool {
        self.early_notified.load(Ordering::SeqCst)
    }
}

/// `reconcileJobTerminalResult`.
pub fn reconcile_terminal_result(job: &JobHandle, value: &WorkerResult) {
    let completion = match &value.error {
        Some(error) => Completion {
            result: Some(value.task_result()),
            error: Some(error.clone()),
            terminal_reason: Some("agent-empty-final".to_owned()),
            ..Completion::new("failed")
        },
        None => Completion {
            result: Some(value.task_result()),
            terminal_reason: Some("agent-terminal-result".to_owned()),
            ..Completion::new("completed")
        },
    };
    job.board.reconcile(&job.task_id, completion);
}

/// `reconcileJobCancelled`: the cancelled turn stopped; the owner's single `cancelled`
/// notification goes out carrying what the turn produced (header-only when nothing).
pub fn reconcile_cancelled(job: &JobHandle, identity: &Map<String, Value>, content: &str) {
    let result = (!content.is_empty()).then(|| {
        let mut value = identity.clone();
        value.insert("content".into(), Value::String(content.to_owned()));
        TaskResult::Json(Value::Object(value))
    });
    job.board.settle_cancelled(&job.task_id, result);
}

/// `reconcileJobStreamStalled`: a turn that threw. A failure after answers the turn went on past
/// reports them with the failure. Skipped once a terminal result exists.
pub fn reconcile_failed(job: &JobHandle, error: &TurnError, identity: &Map<String, Value>) {
    if job.terminal_value().is_some() {
        return;
    }
    let report = error.carried_report.as_deref().filter(|r| !r.is_empty());
    let result = report.map(|report| {
        let mut value = identity.clone();
        value.insert("content".into(), Value::String(report.to_owned()));
        TaskResult::Json(Value::Object(value))
    });
    job.board.reconcile(
        &job.task_id,
        Completion { result, error: Some(error.message.clone()), terminal_reason: Some("agent-stream-stalled".to_owned()), ..Completion::new("failed") },
    );
}

/// `reconcileJobFinally`.
pub fn reconcile_finally(job: &JobHandle, status: FinalStatus) {
    let Some(value) = job.terminal_value() else { return };
    let failed = status == FinalStatus::Error;
    job.board.reconcile(
        &job.task_id,
        Completion {
            result: Some(value.task_result()),
            error: if failed { value.error.clone() } else { None },
            terminal_reason: Some("agent-finally-reconcile".to_owned()),
            ..Completion::new(if failed { "failed" } else { "completed" })
        },
    );
}

/// What `terminalResultHook` closes over.
pub struct TerminalHook {
    pub job: Arc<JobHandle>,
    pub review: Option<Arc<TurnReview>>,
    pub identity: Map<String, Value>,
    pub canonical: bool,
    pub agent: String,
    pub early: Arc<EarlyNotice>,
    pub notify_context: super::notify::NotifyContext,
}

impl TerminalHook {
    /// The turn's `onTerminalResult`: close the turn review, record the completion value on the
    /// job, send the early owner preview and reconcile the task (window 1).
    pub fn call(&self, terminal: &TurnResult) {
        if let Some(review) = &self.review {
            review.complete();
        }
        let value = completion_value(&self.identity, terminal, self.canonical, &self.agent);
        self.job.set_terminal_value(value.clone());
        // A cancelled job reports once, as `cancelled`, when its turn settles.
        if self.job.is_cancelled() {
            return;
        }
        self.early.notify(&self.job, &value, &self.notify_context);
        reconcile_terminal_result(&self.job, &value);
    }
}
