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
use crate::turn_review::TurnReviewApi;
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
    /// This call's options from the caller.
    pub options: CallOptions,
    /// The turn review the edit tools record their committed writes into (`None` where there is none).
    pub review: Option<Arc<dyn TurnReviewApi>>,
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

/// Content-addressed cut point; renders to the existing marker templates
/// (`[<unit> a-b of N; offset:N for more]` for a window, `[output capped at
/// <limit>; …; full output: <path>]` for a cap).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TruncationNote {
    pub shown: u64,
    pub total: u64,
    pub next_offset: Option<u64>,
    pub kind: TruncationKind,
    /// The unit the window counts (`lines`, `rows`, …), as the marker prints it.
    pub unit: String,
    /// The cap that cut the output; `None` for a window no cap shortened.
    pub limit: Option<CapLimit>,
    /// Where the complete output was saved (`full output: <path>`).
    pub full_path: Option<AbsPath>,
}

/// Which marker a cut renders to; the two are never mixed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TruncationKind {
    /// The caller asked for this slice: units `from`-`to` (1-based, inclusive).
    Window { from: u64, to: u64 },
    /// The tool cut the output.
    Cap,
}

/// A cap as the marker prints it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CapLimit {
    /// Printed as `N bytes` below 1 KiB, else `N KB`.
    Bytes(u64),
    /// A ready label (`500 rows`, `200 matches`).
    Label(String),
}

/// `notifyFn(text, meta)` of a call: where the completion of work the call left running goes (a
/// worker turn's own queue). `false` means the receiver declined, and the completion falls back
/// to the owner's default delivery.
#[derive(Clone)]
pub struct ToolNotify(pub Arc<dyn Fn(&str, &JsonValue) -> bool + Send + Sync>);

impl ToolNotify {
    pub fn deliver(&self, text: &str, meta: &JsonValue) -> bool {
        (self.0)(text, meta)
    }
}

impl PartialEq for ToolNotify {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ToolNotify {}

impl std::fmt::Debug for ToolNotify {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ToolNotify")
    }
}

/// What the caller passes with one call besides the model's arguments.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct CallOptions {
    /// Set only in a worker's turn (`AgentTurn.hooks.notify`): background work this call starts
    /// reports its completion here first.
    pub notify: Option<ToolNotify>,
    /// `edit` in a same-anchor batch retry: consume the first of the
    /// `expected` remaining occurrences of `old_string` (Node
    /// `options.editOccurrence`); set only when two or more remain.
    pub edit_occurrence: Option<EditOccurrence>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EditOccurrence {
    pub expected: u32,
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ToolOutput {
    pub parts: Vec<ToolPart>,
    pub attachments: Vec<AttachmentRef>,
    pub follow_up_messages: Vec<FollowUpMessage>,
    pub truncation: Option<TruncationNote>,
    /// A mutation may or may not have happened.
    pub outcome_unknown: bool,
    /// Tool meta carried with the result to the client's tool item, never
    /// model text (`visualize` owner meta, `browser` file-type results);
    /// passed through as the tool returned it.
    pub meta: Option<JsonValue>,
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
    /// `mcp_error` (T §4.5): the MCP server itself reported the failure, either as a JSON-RPC
    /// error (`rpc_code` is its code) or as a result with `isError: true` (`rpc_code` is
    /// `None`). `data` is what the server sent with it (the error's `data`, or the result's
    /// structured content), already scrubbed of secrets.
    McpError {
        server: String,
        rpc_code: Option<i64>,
        data: Option<JsonValue>,
    },
    /// The operation ran and failed (a command, request or action the tool performed). `reason`
    /// is the failure text exactly as today's model text shows it; the model text renders it
    /// verbatim. Not for a capability that is missing (`Unavailable`).
    Failed { reason: String },
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
