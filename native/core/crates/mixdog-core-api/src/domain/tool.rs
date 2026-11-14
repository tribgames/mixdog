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
    /// Removed from sub-agent surfaces. `None` is a definition that does not say; `Some(false)` one
    /// that says it outright (both read as not hidden, see [`ToolAnnotations::is_agent_hidden`]).
    pub agent_hidden: Option<bool>,
}

impl ToolAnnotations {
    /// Whether the tool is removed from sub-agent surfaces.
    pub fn is_agent_hidden(&self) -> bool {
        self.agent_hidden == Some(true)
    }

    /// The `annotations` object of a definition, in the order the product's definitions write
    /// it; a key the definition does not have is left out.
    pub fn to_json(&self) -> JsonValue {
        let mut hints = serde_json::Map::new();
        let fields = [
            ("title", self.title.clone().map(JsonValue::String)),
            ("readOnlyHint", self.read_only_hint.map(JsonValue::Bool)),
            ("destructiveHint", self.destructive_hint.map(JsonValue::Bool)),
            ("idempotentHint", self.idempotent_hint.map(JsonValue::Bool)),
            ("openWorldHint", self.open_world_hint.map(JsonValue::Bool)),
            ("agentHidden", self.agent_hidden.map(JsonValue::Bool)),
            ("compressible", self.compressible.map(JsonValue::Bool)),
            ("compressibleLossless", self.compressible_lossless.map(JsonValue::Bool)),
        ];
        for (key, value) in fields {
            if let Some(value) = value {
                hints.insert(key.to_owned(), value);
            }
        }
        JsonValue::Object(hints)
    }
}

/// Mutual-exclusion group for scheduling within a turn.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ToolGroup(pub String);

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolSpec {
    pub name: String,
    /// The definition's own `title`, where it has one (it is not always the annotations' title:
    /// the desktop bridge tools carry only this one).
    pub title: Option<String>,
    /// Declared aliases; an unknown name is `UnknownTool`, never fuzzy-matched.
    pub aliases: Vec<String>,
    pub description: String,
    /// The definition's `trigger`, where it has one: when the model should reach for the tool.
    pub trigger: Option<String>,
    /// `public: false` is a tool the runtime dispatches for other tools (the `web_fetch` transports)
    /// but never lists: it is in no model-visible tool list or schema, whatever the session.
    pub public: bool,
    pub input_schema: JsonValue,
    pub annotations: ToolAnnotations,
    pub parallel_safe: bool,
    pub exclusive_with: Vec<ToolGroup>,
}

impl ToolSpec {
    /// The tool as a definition object a session's catalogs hold: `name`, `title`, `trigger`,
    /// `public` (only `false`), `description`, `inputSchema` and `annotations`, each only where the
    /// definition has it (a definition without hints has no `annotations`).
    pub fn definition(&self) -> JsonValue {
        let mut definition = serde_json::Map::new();
        definition.insert("name".to_owned(), JsonValue::String(self.name.clone()));
        if let Some(title) = &self.title {
            definition.insert("title".to_owned(), JsonValue::String(title.clone()));
        }
        if let Some(trigger) = &self.trigger {
            definition.insert("trigger".to_owned(), JsonValue::String(trigger.clone()));
        }
        if !self.public {
            definition.insert("public".to_owned(), JsonValue::Bool(false));
        }
        definition.insert("description".to_owned(), JsonValue::String(self.description.clone()));
        definition.insert("inputSchema".to_owned(), self.input_schema.clone());
        let hints = self.annotations.to_json();
        if hints.as_object().is_some_and(|hints| !hints.is_empty()) {
            definition.insert("annotations".to_owned(), hints);
        }
        JsonValue::Object(definition)
    }
}

/// A definition's `freeformDescription` and `freeform` (`{ type: "grammar", syntax, definition }`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Freeform {
    pub description: String,
    pub grammar: JsonValue,
}

impl Freeform {
    /// The freeform half of a definition object: its `freeform` where that is an object, with
    /// `freeformDescription` (empty when it has none, so the tool's own description is used).
    pub fn from_definition(definition: &JsonValue) -> Option<Self> {
        let grammar = definition.get("freeform").filter(|grammar| grammar.is_object())?;
        let description = definition.get("freeformDescription").and_then(JsonValue::as_str).unwrap_or_default();
        Some(Self { description: description.to_owned(), grammar: grammar.clone() })
    }

    /// `isResponsesFreeformTool`: a `{ type: "grammar", syntax, definition }` format.
    pub fn is_grammar(&self) -> bool {
        self.grammar.get("type").and_then(JsonValue::as_str) == Some("grammar")
            && self.grammar.get("syntax").is_some_and(JsonValue::is_string)
            && self.grammar.get("definition").is_some_and(JsonValue::is_string)
    }
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
    /// `width`/`height`: the frame's pixel size where the producing tool reports it (the computer tool's capture), else `None`.
    Image { mime: String, data: ImageData, width: Option<u32>, height: Option<u32> },
    Json(JsonValue),
    /// A document the model reads whole (Node's `{ type: 'document', source: { type: 'base64', media_type, data } }`
    /// block: `read`'s answer for a short PDF when the model takes PDFs natively).
    Document { mime: String, data: Vec<u8> },
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
    /// Which of `read`, `grep` and `list` the calling session offers (Node `isOnDeferredToolSurface`). `shell` refuses a
    /// command those tools cover only when the tool that replaces it is among them; `None` is a caller with no session
    /// information (a command is then only noted).
    pub offered_tools: Option<Arc<Vec<String>>>,
    /// The calling session's provider takes a PDF as a native document block (Node `pdfReadModes`' `pdfNativeDocument`):
    /// `read` then answers a short PDF with the document itself, when the model also sees images
    /// (`pdf_page_images`). A caller with no session leaves it `false` and gets the pages as text.
    pub pdf_native_document: bool,
    /// The calling session's model sees images (Node `pdfReadModes`' `pdfPageMode` is `'image'`, else `'ocr'`): only
    /// such a model is answered with a PDF's document block.
    pub pdf_page_images: bool,
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
    /// The tool says this text result is a success, whatever the text reads as (Node `explicitSuccess`, e.g. an MCP
    /// result with `isError: false` whose text starts `Error:`): the batch does not classify it by its wording.
    pub explicit_success: bool,
    /// The tool says this text result is a failure, whatever the text reads as (Node `explicitFailure`).
    pub explicit_failure: bool,
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

/// What the call of a projecting tool stands for ([`Tool::projection`]).
pub trait CallProjection: Send + Sync {
    /// The call `arguments` stand for on `thread`: the target tool and its arguments, or the model
    /// text of why they stand for none (the call is then answered with that text and nothing runs).
    fn project(&self, thread: &ThreadId, arguments: &JsonValue) -> Result<(String, JsonValue), String>;
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> &ToolSpec;

    /// The definition a delegated agent's session is sent where it differs from the Lead's
    /// (`bindAgentOwner`: `git` without the Lead's worktree operations, `task` with the agent's
    /// wait default); `None` where the agent's text is the Lead's.
    fn agent_spec(&self) -> Option<&ToolSpec> {
        None
    }

    /// The custom-tool form of the definition, where it has one: a route that takes raw text for
    /// a tool sends it under this grammar instead of JSON arguments.
    fn freeform(&self) -> Option<&Freeform> {
        None
    }

    /// The definition object ([`ToolSpec::definition`]) with `freeformDescription` and `freeform`
    /// where the tool has them.
    fn definition(&self) -> JsonValue {
        let mut definition = self.spec().definition();
        if let (Some(freeform), Some(keys)) = (self.freeform(), definition.as_object_mut()) {
            keys.insert("freeformDescription".to_owned(), JsonValue::String(freeform.description.clone()));
            keys.insert("freeform".to_owned(), freeform.grammar.clone());
        }
        definition
    }

    /// Typed outbound classification for the policy (replaces the name list):
    /// the action kind this call performs outside the machine, if any.
    fn outbound_kind(&self, _args: &JsonValue) -> Option<ActionKind> {
        None
    }

    /// Set by a tool that is only the name of another tool's call (the bridge's `call_tool`): the
    /// loop replaces such a call by its target before anything judges it, so every layer sees the
    /// target itself (Node `resolveExecutionToolCalls`).
    fn projection(&self) -> Option<&dyn CallProjection> {
        None
    }

    /// Arguments are already schema-validated. Cooperative cancellation:
    /// observe `ctx.cancel`; a mutation either completes atomically or rolls
    /// back, and a call cancelled after commit returns its completed result.
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome;
}
