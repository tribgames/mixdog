//! Thread, turn and item methods and thread-feed notifications (P §5, §6.3).

use mixdog_protocol::ItemId;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ModelSelection;
use mixdog_protocol::OpId;
use mixdog_protocol::OrchestrationMode;
use mixdog_protocol::PromptContent;
use mixdog_protocol::QueuedId;
use mixdog_protocol::QuotaResume;
use mixdog_protocol::SubmitOptions;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ThreadStatus;
use mixdog_protocol::ThreadSummary;
use mixdog_protocol::ToolApprovalResult;
use mixdog_protocol::Turn;
use mixdog_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;

use super::feed::ResumeWindow;
use super::feed::Subscription;
use super::feed::ThreadResumePosition;

macro_rules! has_op_id {
    ($($ty:ty),* $(,)?) => {$(
        impl crate::common::HasOpId for $ty {
            fn op_id(&self) -> &OpId {
                &self.op_id
            }
        }
    )*};
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ThreadStartKind {
    /// Today's `startProject`: the project's own chat.
    Project,
    /// Today's `startProjectTask`.
    ProjectTask,
    /// Today's `startTask` / `submitNewTask` / `session.create`.
    Task,
    /// The desktop's control session (Node's `ensureControlSession`, created with `desktopSession: null`): it runs in
    /// the task workspace, carries no classification and, while empty, is not listed. Rust name: `ThreadStartKind::Control`.
    Control,
}

/// Today's `DesktopNewTaskDraft`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct NewTaskDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<ModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_mode: Option<OrchestrationMode>,
    /// Today's `DesktopNewTaskWorktree`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct TurnInput {
    pub prompt: PromptContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<SubmitOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadStartParams {
    pub op_id: OpId,
    pub kind: ThreadStartKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<NewTaskDraft>,
    /// Starts the first turn in the same request (today's `submitNewTask`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_input: Option<TurnInput>,
    /// How the session runs; absent is an interactive session (Node's defaults).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<ThreadSessionOptions>,
}

/// The session options Node's `createMixdogSessionRuntime` takes (headless exec sets all of
/// them, `headless-exec.mjs` `createHeadlessSessionRuntime`). Stored in the thread's header.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadSessionOptions {
    /// Node default `interactive`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_profile: Option<ToolProfile>,
    /// Node default `full`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_mode: Option<SessionToolMode>,
    /// Node default none: approvals go to a person. Under `implicit` every approval ask is
    /// denied at once with Node's text, as when no approval UI is wired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<ApprovalMode>,
    /// Node default `false`: the session may not delegate to agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disallow_delegation: Option<bool>,
    /// Node default `true`: finished background work wakes the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_wake_completions: Option<bool>,
    /// The web-search feature switch for this session (`MIXDOG_FEATURE_WEB_SEARCH`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search: Option<bool>,
    /// The memory feature switch for this session (`MIXDOG_FEATURE_MEMORY`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<bool>,
}

/// `normalizeToolProfile`'s value set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ToolProfile {
    Interactive,
    Headless,
    Heartbeat,
}

/// Node's `TOOL_MODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionToolMode {
    Full,
    Readonly,
    Lead,
}

/// Node accepts only `implicit`; anything else means none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    Implicit,
}

/// `thread/notification`: a runtime notification (a finished background task, a channel
/// message) as Node's `runtime.onNotification` delivers it. The delivered text also lands as
/// a `task-notification` user row; this is the live event with its status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadNotificationParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub content: String,
    /// Node's `meta`; `meta.status` is `completed`, `failed`, `cancelled`, `canceled` or
    /// `timed_out` when the notification settles a task.
    pub meta: JsonValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ModelRequestPhase {
    Started,
    Completed,
    Failed,
}

/// `thread/modelRequest/updated`: one provider request of a turn (Node `model.request.*`).
/// Request ids are `model_request_<index>`, the index counting from 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ModelRequestUpdatedParams {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub request_id: String,
    pub request_index: u32,
    pub phase: ModelRequestPhase,
    /// On `completed` and `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub duration_ms: Option<u64>,
    /// Node's usage delta summary of the request, on `completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ToolBatchPhase {
    Started,
    Completed,
}

/// `thread/toolBatch/updated`: the tool calls of one model response run together (Node
/// `tool.batch.*`). Batch ids are `tool_batch_<request index>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ToolBatchUpdatedParams {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub batch_id: String,
    pub phase: ToolBatchPhase,
    /// On `completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration: Option<u32>,
    /// On `completed`: the calls the batch ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calls: Option<u32>,
    /// On `completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadStartResponse {
    pub thread: ThreadSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnStartResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadResumeParams {
    pub thread_id: ThreadId,
    pub window: ResumeWindow,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from: Option<ThreadResumePosition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ThreadResumeResponse {
    pub thread: ThreadSummary,
    pub subscription: Subscription,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdParams {
    pub thread_id: ThreadId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadOpParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<SortDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_term: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadListResponse {
    pub data: Vec<ThreadSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadReadParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<ResumeWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_turns: Option<bool>,
}

/// The runtime projection of one thread (today's `DesktopSessionState` fields,
/// grouped as the thread-feed notifications of P §5.1 carry them).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<ThreadRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<ThreadRoute>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ThreadContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<Vec<JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_resume: Option<QuotaResume>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<ThreadAgents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_jobs: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<ThreadWorkflow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<ThreadApprovals>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_restore: Option<PromptRestore>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_change: Option<ProviderAccountChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_enabled: Option<bool>,
    /// The setup tool's desktop request, from the notice until it is claimed or its claim window
    /// ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_ui_request: Option<SetupUiRequest>,
    /// A group room log's view while the room runs (`thread/roomView/updated`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_view: Option<ThreadRoomView>,
    /// The composer's Up-arrow recall (today's `promptHistoryList`, Node's merged list): the
    /// thread's user prompts over the whole transcript plus the per-folder saved prompt
    /// history of its cwd, newest first, trimmed, at most `PROMPT_HISTORY_LIMIT` (50), one
    /// entry per whitespace-collapsed text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_history_list: Option<Vec<String>>,
}

/// Value of `thread/promptHistory/updated`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PromptHistoryChange {
    /// A prompt was submitted: the client drops any held entry with the same
    /// whitespace-collapsed text, puts `prompt` in front and keeps the first 50.
    Added { prompt: String },
    /// Any other change (rewind, clear, abort): the whole list, newest first.
    Replaced { prompts: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadReadResponse {
    pub thread: ThreadSummary,
    pub state: ThreadState,
    pub items: Vec<ThreadItem>,
    pub has_older: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<Turn>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadTurnsListParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<SortDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items_view: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadTurnsListResponse {
    pub data: Vec<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Opaque cursor, or an item anchor (today's `before`/`after` row reads).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum ItemsCursor {
    Opaque(String),
    #[serde(rename_all = "camelCase")]
    Item {
        /// Always `item`.
        #[serde(rename = "type")]
        kind: String,
        item_id: ItemId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadItemsListParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ItemsCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<SortDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub byte_budget: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadItemsListResponse {
    pub data: Vec<ThreadItem>,
    pub has_older: bool,
    pub has_newer: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadItemsReadParams {
    pub thread_id: ThreadId,
    pub item_ids: Vec<ItemId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ThreadItemsReadResponse {
    pub items: Vec<ThreadItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadPageParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadModelMessagesListParams {
    pub thread_id: ThreadId,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub start: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadFinalAnswerReadParams {
    pub thread_id: ThreadId,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadReadStateUpdateParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub message_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumed_unread: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ThreadSearchParams {
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadNameSetParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadMetadataUpdateParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    /// Today's `setSessionProject`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadDeleteParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    /// Today's `deleteSessionIfIdle` expectation (e.g. `{lastUsedAt}`); not idle → the reply `{deleted: false, reason}`, never an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_idle: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadForkParams {
    /// The source thread; it is never changed.
    pub thread_id: ThreadId,
    pub op_id: OpId,
    /// Inherit into this existing empty thread (today's `inheritFrom`); absent creates a new thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<ModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadClearParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebuild_prompt: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadContinueInModelParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub route: ModelSelection,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadRewindParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub item_id: ItemId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_files: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadCompactStartParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadQueueDeleteParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    /// Absent with `restore`: every queued entry is handed back (today's `restoreQueued` with no id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_id: Option<QueuedId>,
    /// Today's `restoreQueued` submission identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_id: Option<String>,
    /// Hand the entry back to the composer.
    pub restore: bool,
    /// The composer's text when the entry is handed back (today's `restoreQueued` first
    /// argument): the reply's `text` ends with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub goal: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadGoalControlParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    /// Today's `goalControl` action other than set/clear.
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadBackgroundTerminalParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub input: TurnInput,
}

/// `turn/start` answers once the input is a turn or a queued entry (X9).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnStartResponse {
    #[serde(rename_all = "camelCase")]
    Started { turn_id: TurnId },
    #[serde(rename_all = "camelCase")]
    Queued { queued_id: QueuedId },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct TurnInterruptParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// Rewind a submitted prompt only when the composer was empty at cancel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_prompt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_id: Option<String>,
}

/// Fixed C0 reply (R12).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct TurnInterruptResponse {
    /// Always `true`.
    pub cancel_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct TurnSteerParams {
    pub thread_id: ThreadId,
    /// Absent: the core steers the thread's active turn (today's `prioritizeQueued` names none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<TurnId>,
    pub queued_id: QueuedId,
}

/// Fixed C0 reply (R12).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResponse {
    /// Always `true`.
    pub accepted: bool,
    pub queued_id: QueuedId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TurnRetryFailedParams {
    pub thread_id: ThreadId,
    pub op_id: OpId,
    pub turn_key: String,
}

has_op_id!(
    ThreadStartParams,
    ThreadOpParams,
    ThreadClearParams,
    ThreadReadStateUpdateParams,
    ThreadNameSetParams,
    ThreadMetadataUpdateParams,
    ThreadDeleteParams,
    ThreadForkParams,
    ThreadContinueInModelParams,
    ThreadRewindParams,
    ThreadCompactStartParams,
    ThreadQueueDeleteParams,
    ThreadGoalSetParams,
    ThreadGoalControlParams,
    ThreadBackgroundTerminalParams,
    TurnStartParams,
    TurnRetryFailedParams,
);

// ---- thread-feed notification params (P §5.1) ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadSnapshotParams {
    pub thread: ThreadSummary,
    pub state: ThreadState,
    pub items: Vec<ThreadItem>,
    pub has_older: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartedParams {
    pub thread: ThreadSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatusChangedParams {
    pub thread_id: ThreadId,
    pub status: ThreadStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadNameUpdatedParams {
    pub thread_id: ThreadId,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadValueParams {
    pub thread_id: ThreadId,
    pub value: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadQueueChangedParams {
    pub thread_id: ThreadId,
    pub queued: Vec<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TurnNotificationParams {
    pub thread_id: ThreadId,
    pub turn: Turn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ItemNotificationParams {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub item: ThreadItem,
}

/// Deltas are hints; `item/completed` is authoritative.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ItemDeltaParams {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub item_id: ItemId,
    pub delta: String,
    /// Reasoning summary part index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HistoryResetReason {
    Rewind,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadHistoryResetParams {
    pub thread_id: ThreadId,
    pub reason: HistoryResetReason,
    /// Items after this one are discarded; absent for `clear`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_item_id: Option<ItemId>,
    /// `hasOlder` of the thread's transcript after the reset: the only change of
    /// that flag outside a snapshot.
    pub has_older: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum StorageState {
    Ok,
    /// Durability waits under slow storage (R12).
    DurabilityPending,
    /// Outcome of a barrier unknown; the thread is read-only.
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadRuntime {
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub command_busy: bool,
    #[serde(default)]
    pub thinking: Option<JsonValue>,
    #[serde(default)]
    pub spinner: Option<JsonValue>,
    #[serde(default)]
    pub command_status: Option<JsonValue>,
    #[serde(default)]
    pub progress_hint: Option<JsonValue>,
    #[serde(default)]
    pub active_tools: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageState>,
    /// Provider keepalives seen while no content arrives (SPEC §4.9), epoch ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub waiting_on_provider_since: Option<i64>,
    // Node's runtime.clientHostPid: the process hosting the session runtime, which owns its shell jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_host_pid: Option<u32>,
    // Node's toasts: transient notices, empty while none.
    #[serde(default)]
    pub toasts: Vec<JsonValue>,
    // Node's activeToolSummary (active-tool-summary.mjs): count:startedAt of the running Shell, Web Research and Agent calls, null while none.
    #[serde(default)]
    pub active_tool_summary: Option<String>,
    // Node's toolMode: the session's tool surface mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_mode: Option<String>,
    // Node's setupChanged (notification-router.mjs): the last settings change a setup action reported, { action, seq, at }; absent until one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_changed: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadRoute {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_capable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_parameters: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub selected_context_window: Option<i64>,
    // Node's runtime.effort (effectiveEffort || effort || preset.effort): null while the route has none.
    #[serde(default)]
    pub effort: Option<String>,
    // Node's runtime.provider / runtime.model: the selected route, which sessionProvider / sessionModel (the session's own) follow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    // Node's runtime.turnEffort: the effort the Auto judge resolved for the turn in flight, null when none.
    #[serde(default)]
    pub turn_effort: Option<String>,
    // Node's runtime.effortOptions (state.route.effortOptions): the efforts the route's model offers, empty while none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_options: Option<Vec<JsonValue>>,
    // Node's runtime.cwd: the session's working folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    // Node's runtime.session.forkedFrom: the origin id of a session opened as a fork, null otherwise.
    #[serde(default)]
    pub session_forked_from: Option<String>,
    // Node's runtime.systemShell: { source, command, effective }.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_shell: Option<JsonValue>,
    // Node's runtime.webSearchRoute: the configured web-search route, default/default while unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search_route: Option<JsonValue>,
    // Node's autoClear (getAutoClear): the idle auto-clear setting for the route's provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_clear: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadContext {
    #[serde(default)]
    pub context_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_default_percent: Option<f64>,
    // Node's session.contextWindow: the session's window, null while it states none.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub context_window: Option<i64>,
    // Node's displayContextWindow (syncContextDisplayFields): the window the status shows, 0 until known.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub display_context_window: Option<i64>,
    // Node's autoCompactTokenLimit: the compaction trigger, 0 until known.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub auto_compact_token_limit: Option<i64>,
    // Node's stats: the session's usage totals and context measurement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<JsonValue>,
    // Node's runtime.rawContextWindow: the model's window before the effective-percent cut, null while unknown.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number", optional))]
    pub raw_context_window: Option<i64>,
    // Node's runtime.effectiveContextWindowPercent: the share of the raw window the session may use, null while unknown.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number", optional))]
    pub effective_context_window_percent: Option<i64>,
    // Node's compactBoundaryTokens (syncContextDisplayFields): the compaction boundary, 0 until known.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number", optional))]
    pub compact_boundary_tokens: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadAgents {
    #[serde(default)]
    pub agent_workers: Vec<JsonValue>,
    #[serde(default)]
    pub agent_jobs: Vec<JsonValue>,
    // Node's agentScope (agent-tool.mjs statusFor): whose agents the rows are, { sessionId } for a session; null while the status is not ready.
    #[serde(default)]
    pub agent_scope: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadWorkflow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration_mode: Option<OrchestrationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_workflow_switch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_orchestration_mode_switch: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadApprovals {
    // Node's toolApprovalResult: null while no decision has been shown.
    #[serde(default)]
    pub tool_approval_result: Option<ToolApprovalResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_questions: Option<Vec<JsonValue>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PromptRestore {
    pub id: String,
    pub ids: Vec<String>,
    pub text: String,
    pub device: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountChange {
    pub provider: String,
    pub account_id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
}

/// The setup tool's desktop request waiting for a window to claim it (Node's session store
/// `setupUiRequest`): its id, and when the thread took it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SetupUiRequest {
    pub id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: i64,
}

/// A group room's log as its views see it while the room runs (Node `agent-room-views.ts`
/// `decorateRoomSnapshot`, pushed with the room's session state): the client lays it over the
/// room log thread's own fields. Absent when the room has no exchange state and no handed-off
/// questions.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadRoomView {
    /// The room has an exchange state: the log reads busy (so the composer offers stop).
    pub busy: bool,
    /// The speaking member's pending approval, as Node's queue presents it (`toolApproval`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_approval: Option<JsonValue>,
    /// The typing row naming who speaks (`{ kind: 'notice', id, tone: 'info', text, room: { kind:
    /// 'typing', speaker, name } }`), shown after the transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typing: Option<JsonValue>,
    /// The questions of sessions the members handed work to, while they wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_questions: Option<Vec<JsonValue>>,
}

/// Params of the `thread/<section>/updated` notifications: one typed section of the projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionParams<T> {
    pub thread_id: ThreadId,
    pub value: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummaryUpdatedParams {
    pub thread: ThreadSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageUpdatedParams {
    pub thread_id: ThreadId,
    pub usage: JsonValue,
}
