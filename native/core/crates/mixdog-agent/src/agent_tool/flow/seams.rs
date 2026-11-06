//! What a worker's turn borrows from the session side (WP-SESSION implements these): the
//! session manager's ask, the turn review, the worker rows, the turn stream, resource admission
//! and the owner's inbox. Each is one Node collaborator of `createSpawnRunner`,
//! `createJobStarter` and `createWorkerTurns`; the decisions around them are the port.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use crate::cancel::Cancel;
use crate::env::Yielder;

use crate::response::Termination;

/// What a finished ask hands its caller: the fields the flow reads of Node's result.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TurnResult {
    pub content: String,
    /// The whole report when the ask carried earlier answers (`reportContent`).
    pub report_content: Option<String>,
    /// `terminationReason`: set for an abnormal finish only.
    pub termination: Option<Termination>,
    pub iterations: u32,
    pub tool_calls_total: u64,
    /// `stopReason ?? stop_reason`.
    pub stop_reason: Option<String>,
}

impl TurnResult {
    /// `turnReportText`: the report of earlier answers when the ask carried them, else its content.
    pub fn report_text(&self) -> &str {
        self.report_content.as_deref().unwrap_or(&self.content)
    }
}

/// A turn that threw.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TurnError {
    pub message: String,
    /// `error.carriedReport`: the answers the turn went on past.
    pub carried_report: Option<String>,
    /// `error.partialHandoff`: the text a canonical turn read off its own transcript.
    pub partial_handoff: Option<String>,
}

impl TurnError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), ..Self::default() }
    }
}

/// A tool result message of the turn (`onToolResult`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct ToolResultMessage {
    /// `message.uiDiff`, when it is a string.
    pub ui_diff: Option<String>,
}

pub type NotifyFn = Arc<dyn Fn(&str, &Value) -> bool + Send + Sync>;

/// The callbacks a turn is given (Node `turnHooks`).
#[derive(Clone)]
pub struct TurnHooks {
    pub submission_id: String,
    /// `workerNotifyFn(sessionId)`: tool completions the worker's own tools produce.
    pub notify: NotifyFn,
    pub on_tool_result: Arc<dyn Fn(&ToolResultMessage) + Send + Sync>,
    /// Set for a job's turn only.
    pub on_terminal_result: Option<Arc<dyn Fn(&TurnResult) + Send + Sync>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TurnKind {
    /// A fresh worker's first turn.
    Spawn,
    /// A follow-up turn of a reused worker: a session that runs in-process is first brought to
    /// the current settings and its agent's current permission (`reconcileAgentSession`,
    /// `followAgentPermission`).
    Send,
}

/// One turn to run on a worker session.
#[derive(Clone)]
pub struct TurnRequest {
    pub kind: TurnKind,
    pub session_id: String,
    /// The text; the host combines it with `attachments` (`handoffContent`).
    pub prompt: String,
    pub attachments: Vec<Value>,
    pub context: Option<Value>,
    pub cwd: String,
    /// The trusted text a routine's skill is selected from (`skillSelection`).
    pub skill_selection: Option<String>,
    pub hooks: TurnHooks,
    /// The job's admitted slot, for the loop to hand back during provider requests.
    pub slot: Option<Arc<dyn Yielder>>,
}

/// One assistant row a session gained during a turn, as text: its own content and, when that is
/// blank, the visible text inside its provider replay envelope.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct AssistantText {
    pub content: String,
    pub replay: String,
}

/// The session manager, as a worker's turn uses it.
#[async_trait]
pub trait TurnSessions: Send + Sync {
    /// `session.messages.length` (`resolveHandoffMessageStartIndex`), read from the store.
    async fn message_count(&self, session_id: &str) -> usize;
    /// The assistant rows appended from message index `start` on, read from the store.
    async fn assistant_texts(&self, session_id: &str, start: usize) -> Vec<AssistantText>;
    /// `notDoneReport(session)`: the lines naming what the agent's own todo list leaves undone.
    fn not_done_report(&self, session_id: &str) -> String;
    /// `whileTurnDispatched(sessionId, …)` around the route that runs the turn: the canonical
    /// session runtime when the session has one, else the in-process manager's ask.
    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError>;
    /// `mgr.unloadSessionRuntime`: releases the process-local state of a session whose turn is over.
    fn unload_runtime(&self, session_id: &str, reason: &str);
}

/// `emitSubagentEvent`.
pub trait SubagentEvents: Send + Sync {
    fn start(&self, agent: &str, session_id: &str, tag: &str);
    fn stop(&self, agent: &str, session_id: &str, tag: &str, status: &str);
}

/// One turn's review of the worker's edits, handed to the owner when the turn completes.
pub trait ReviewHandle: Send + Sync {
    /// Idempotent: the first call hands the patches over.
    fn complete(&self, patches: Vec<String>);
}

/// `beginAgentTurnReview`.
pub trait TurnReviews: Send + Sync {
    fn begin(&self, owner_session_id: &str, session_id: &str, tag: &str, agent: &str) -> Box<dyn ReviewHandle>;
}

/// `notifySessionCompletion(owner, text, meta)`: delivers a completion card to an owner session;
/// `false` when it could not.
pub trait OwnerNotify: Send + Sync {
    fn notify(&self, owner_session_id: &str, text: &str, meta: &Value) -> bool;
}

/// The worker's own queue of tool completions (`enqueueCompletionMessage`, `onWorkerCompletionQueued`).
pub trait WorkerInbox: Send + Sync {
    /// Queues the completion for the worker's next model-call boundary; `false` when nothing queued.
    fn enqueue_completion(&self, session_id: &str, text: &str, meta: &Value) -> bool;
    /// A completion was queued: an idle worker is woken so the result reaches it now.
    fn completion_queued(&self, _session_id: &str) {}
}

/// A slot in the agent lane (`resourceAdmission`). Work runs while it is held; the host scopes
/// the lease to the work it admits (`runWithLease`).
#[async_trait]
pub trait Lease: Send {
    async fn release(self: Box<Self>);
    /// The handle the loop hands the slot back through while a provider request is in flight
    /// (`runYielded`).
    fn yielder(&self) -> Arc<dyn Yielder>;
}

#[async_trait]
pub trait Admission: Send + Sync {
    /// Waits for a slot; `cancel` abandons the wait, and its reason is the error.
    async fn acquire(&self, label: &str, owner_key: Option<&str>, cancel: &Cancel) -> Result<Box<dyn Lease>, String>;
}

/// `recordAgentTaskStart`: the tool call that started a job owns it.
pub trait TaskStarts: Send + Sync {
    fn record(&self, tool_call_id: &str, task_id: &str);
}

/// A turn started on a worker session (`onTurnStart`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TurnStart {
    pub turn_id: String,
    pub started_at_ms: i64,
    pub submission_ids: Vec<String>,
}

/// A turn's outcome (`onTurnSettled`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TurnOutcome {
    pub turn_id: String,
    /// `status === 'done'`: the turn finished; otherwise it was stopped or failed.
    pub done: bool,
    pub result: Option<TurnResult>,
}

pub trait TurnListener: Send + Sync {
    fn turn_started(&self, start: TurnStart);
    fn turn_settled(&self, outcome: TurnOutcome);
}

pub type Unobserve = Box<dyn FnOnce() + Send>;

/// The route that runs a worker session's turns (the canonical runtime, else the manager's ask
/// loop), as `observeSessionTurns` reports them.
pub trait TurnSource: Send + Sync {
    /// `None` when that route reports no turns.
    fn observe_session_turns(&self, session_id: &str, listener: Arc<dyn TurnListener>) -> Option<Unobserve>;
}

/// What the session knows of a worker by id.
pub trait SessionNames: Send + Sync {
    fn tag_for_session(&self, session_id: &str) -> Option<String>;
    fn agent(&self, session_id: &str) -> Option<String>;
}

/// A change to a worker's row (`upsertWorkerSessionDeferred`'s patch). Absent fields stay.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct RowUpdate {
    pub status: Option<String>,
    pub stage: Option<String>,
    /// `Some(None)` clears it.
    pub task_id: Option<Option<String>>,
    pub turn_started_at: Option<String>,
    pub finished_at: Option<String>,
    pub failure_reason: Option<String>,
}

pub trait WorkerRows: Send + Sync {
    fn upsert(&self, session_id: &str, tag: Option<&str>, update: RowUpdate);
}
