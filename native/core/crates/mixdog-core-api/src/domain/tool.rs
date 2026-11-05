//! Tool contract (T §1.1–§1.9). The pipeline validates arguments against
//! `ToolSpec::input_schema`, applies the one `ToolPolicy`, hooks and approval,
//! then calls [`Tool::call`]. Success and failure are typed; nothing is
//! classified from result text.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_protocol::BlobDigest;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use super::approval::ActionKind;
use super::approval::ApprovalGate;
use super::common::AbsPath;
use super::fs::FileService;
use super::process::ProcessManager;
use mixdog_protocol::ToolCallId;

/// Tool annotations as published in `tool-schemas.json`.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ToolAnnotations {
    pub title: Option<String>,
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
    pub idempotent_hint: Option<bool>,
    pub open_world_hint: Option<bool>,
    pub compressible: Option<bool>,
    pub compressible_lossless: Option<bool>,
    /// Removed from sub-agent surfaces.
    pub agent_hidden: bool,
}

/// Mutual-exclusion group for scheduling within a turn.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ToolGroup(pub String);

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolSpec {
    pub name: String,
    /// Declared aliases; an unknown name is `UnknownTool`, never fuzzy-matched.
    pub aliases: Vec<String>,
    pub description: String,
    pub input_schema: JsonValue,
    pub annotations: ToolAnnotations,
    pub parallel_safe: bool,
    pub exclusive_with: Vec<ToolGroup>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum SurfaceKind {
    Lead,
    Agent,
    Bot,
    Readonly,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ToolProgress {
    Stage(String),
    Output(Vec<u8>),
    ProcessStarted(ProcessHandle),
}

pub trait ProgressSink: Send + Sync {
    /// Never blocks; a full sink drops progress (results carry the truth).
    fn progress(&self, progress: ToolProgress);
}

/// Lane tokens for tool I/O; the tool runtime owns all three lanes' tool work.
#[derive(Clone, Copy, Debug)]
pub struct ToolIo {
    pub interactive: InteractiveIo,
    pub durability: DurabilityIo,
    pub maintenance: MaintenanceIo,
}

pub struct ToolContext {
    pub call_id: ToolCallId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// Canonical tool name after alias resolution.
    pub tool: String,
    pub cwd: AbsPath,
    pub surface: SurfaceKind,
    /// Child of the run's token.
    pub cancel: CancellationToken,
    /// Per-tool deadline (T §1.7); exceeding it returns partial output with
    /// `DeadlineExceeded{partial}`.
    pub deadline: Option<Instant>,
    pub progress: Arc<dyn ProgressSink>,
    pub io: ToolIo,
    pub approvals: Arc<dyn ApprovalGate>,
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ImageData {
    Bytes(Vec<u8>),
    /// A stored blob.
    Blob(BlobDigest),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ToolPart {
    Text(String),
    Image { mime: String, data: ImageData },
    Json(JsonValue),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AttachmentRef(pub String);

/// A user message the tool appends after its result (`Skill`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FollowUpMessage {
    pub text: String,
    pub meta: Option<String>,
}

/// Content-addressed cut point; renders to the existing marker templates.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TruncationNote {
    pub shown: u64,
    pub total: u64,
    pub next_offset: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ToolOutput {
    pub parts: Vec<ToolPart>,
    pub attachments: Vec<AttachmentRef>,
    pub follow_up_messages: Vec<FollowUpMessage>,
    pub truncation: Option<TruncationNote>,
    /// A mutation may or may not have happened.
    pub outcome_unknown: bool,
}

/// Closed error-code set (T §1.9). Each renders to today's model text.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ToolErrorCode {
    InvalidArgs { field: String, reason: String },
    NotFound { target: String },
    NotText { reason: String },
    TooLarge { limit: u64, actual: u64 },
    PermissionDenied,
    ApprovalRequired { approval_id: u64 },
    DeniedByPolicy { rule: String },
    DeniedByHook,
    Stale { expected: String, actual: String },
    Conflict { matches: u32 },
    Cancelled,
    DeadlineExceeded { partial: bool },
    Unavailable { capability: String, reason: String },
    UnknownTool,
    OutcomeUnknown,
    Io { os_code: Option<i32> },
    Internal { incident_id: String },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message_for_model: String,
    /// Set when a write may have happened before the failure.
    pub outcome_unknown: bool,
    /// Partial output kept with `DeadlineExceeded{partial: true}`.
    pub partial: Option<ToolOutput>,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message_for_model: impl Into<String>) -> Self {
        Self {
            code,
            message_for_model: message_for_model.into(),
            outcome_unknown: false,
            partial: None,
        }
    }
}

pub type ToolOutcome = Result<ToolOutput, ToolError>;

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> &ToolSpec;

    /// Typed outbound classification for the policy (replaces the name list):
    /// the action kind this call performs outside the machine, if any.
    fn outbound_kind(&self, _args: &JsonValue) -> Option<ActionKind> {
        None
    }

    /// Arguments are already schema-validated. Cooperative cancellation:
    /// observe `ctx.cancel`; a mutation either completes atomically or rolls
    /// back, and a call cancelled after commit returns its completed result.
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome;
}
