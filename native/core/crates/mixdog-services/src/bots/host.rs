//! The session side of a routine fire, as one seam. A routine is a turn in its owner bot's
//! home thread: queueing it behind the thread's own work, marking it unattended, aborting it
//! and reading the bot and agent definitions all belong to the session core, which implements
//! `RoutineHost`. Everything that decides *whether and how* a fire runs lives in this crate.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::routine::{RoutineKind, RoutineTrigger};

/// Why a bot cannot own or run a routine (routine-owner.mjs `ROUTINE_OWNER_PROBLEMS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerProblem {
    NoMixy,
    OwnerArchived,
    OwnerDeleted,
}

impl OwnerProblem {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoMixy => "no-mixy",
            Self::OwnerArchived => "owner-archived",
            Self::OwnerDeleted => "owner-deleted",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NoMixy => "Create the representative bot first.",
            Self::OwnerArchived => "The bot that owns this routine is deleted (in Archived). Restore it, or pick another bot.",
            Self::OwnerDeleted => "The bot that owns this routine no longer exists. Pick another bot.",
        }
    }
}

/// What the agent definitions say about a would-be executor (routine-executor.mjs `defaultProbe`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExecutorFacts {
    /// A delegatable workflow agent that exists (a built-in slot agent is not one).
    pub listed: bool,
    /// A bot (contact agent), not a workflow sub-agent.
    pub contact: bool,
    pub disabled: bool,
}

/// One routine turn handed to the owner's home thread.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutineTurn {
    /// `routine_<uuid>`: the entry's identity in the thread's queue.
    pub id: String,
    pub session_id: String,
    pub agent_id: String,
    pub kind: RoutineKind,
    pub name: String,
    /// The model-visible prompt: a string, or parts when attachments ride along.
    pub content: Value,
    /// The trusted text skills are selected from; empty selects none.
    pub skill_selection: String,
    /// The marker row the turn shows.
    pub trigger: RoutineTrigger,
}

/// How a routine turn ended.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnSettle {
    /// The turn finished; `result` is the bot's final reply.
    Done { result: String },
    Cancelled,
    /// The bot's chat closed before the turn ran.
    Rejected,
    Failed(String),
    /// A step only a person can do ended the turn; the text says which.
    HumanNeeded(String),
    /// The chat refused the turn.
    NotAccepted,
}

/// A sub-agent run that carries a fire out before the bot relays its report.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutorRun {
    pub agent_id: String,
    pub kind: RoutineKind,
    pub name: String,
    pub owner_agent_id: String,
    pub prompt: String,
    pub skill_selection: String,
    pub cwd: Option<String>,
    /// Inline image/PDF/Office parts of the stored attachments, for the host to turn into
    /// stored references (an executor's prompt admits references only).
    pub attachment_parts: Vec<Value>,
}

/// One run's result, as the owner's thread is asked to show it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryItem {
    pub run_id: String,
    pub kind: RoutineKind,
    pub ok: bool,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
}

/// The state of a live-only run row in the owner's thread.
#[derive(Debug, Clone, PartialEq)]
pub struct AnnouncedRun {
    pub item: DeliveryItem,
    /// `undelivered`: the result could not be queued; the app offers a retry.
    pub state: &'static str,
}

#[async_trait]
pub trait RoutineHost: Send + Sync {
    /// Why `owner_agent_id` (the primary bot when "lead") cannot own or run a routine.
    /// `stored`: asked for a stored routine, itself evidence of its owner. A read fault is
    /// an `Err` and never pauses anything.
    async fn owner_problem(&self, owner_agent_id: &str, stored: bool) -> Result<Option<OwnerProblem>, String>;

    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String>;

    /// Whether the home thread exists and is open.
    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String>;

    /// Whether `session_id` is one of the primary bot's hidden heartbeat sessions.
    fn is_heartbeat_session(&self, session_id: &str) -> bool;

    /// Queues `turn` behind the thread's own work, marks it unattended once it runs, and
    /// resolves when it settles. When `cancel` fires the host drops the queued turn or aborts
    /// the running one and returns promptly.
    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle;

    /// Carries a fire out with a sub-agent, headless and to its end; resolves its final
    /// report. Returns promptly when `cancel` fires.
    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String>;

    /// Queues a finished run's result for the owner's thread; the host keys it by run id, so
    /// queueing one twice is a no-op.
    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String>;

    /// Shows a live-only run row in the owner's thread.
    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String>;
}
