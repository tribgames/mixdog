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
use mixdog_protocol::SubscriptionId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ThreadStatus;
use mixdog_protocol::ThreadSummary;
use mixdog_protocol::ToolApprovalResult;
use mixdog_protocol::Turn;
use mixdog_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;

use super::feed::FeedPosition;
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
    /// On `completed`: the tool calls the response streamed, in stream order, each `{ id, name, arguments }` (Node's
    /// `onAssistantToolCallObserved`, which a headless exec shows as the call's `item.started` before the request's
    /// completion). Absent when the response called no tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<JsonValue>>,
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
    /// `true`: the positioned projection. The subscription holds ranges of the transcript, first the newest rows
    /// `window` asks for with what the running turn depends on, changed with `thread/window/set`; transcript events
    /// reach it as `thread/transcript/changed`. Absent or `false`: the feed as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positioned_window: Option<bool>,
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
    /// Absent: the thread's active turn (Node's `abortSession` named none), or, with none running, the idle stop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// Rewind a submitted prompt only when the composer was empty at cancel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_prompt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_id: Option<String>,
}

/// The C0 reply (R12, amended): what Node's `abortSession` answered. A named or active turn's stop is
/// `cancelRequested: true` with its `turnId`; a thread with no active turn and no turn named is idle
/// (`cancelRequested: false`, no `turnId`), and `submissionId` then hands a queued submission back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct TurnInterruptResponse {
    /// A running turn was cancelled.
    pub cancel_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// Node's `aborted`: the stop took a running turn.
    pub aborted: bool,
    /// The prompt handed back to the composer of the device that cancelled; empty when the prompt stays in the
    /// transcript, or travels to the device that sent it through `thread/promptRestore`.
    pub restore_text: String,
    /// The pasted images and texts of the handed-back prompt, read from the attachment store.
    pub pasted_images: Option<JsonValue>,
    pub pasted_texts: Option<JsonValue>,
    /// The pasted images and texts a queued steering prompt left unrestored, for the client to discard.
    pub discard_pasted_images: Option<JsonValue>,
    pub discard_pasted_texts: Option<JsonValue>,
    /// The submissions (`clientSubmissionId`) the handed-back text came from.
    pub restored_submission_ids: Vec<String>,
    /// The file parts of the handed-back prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<JsonValue>,
    /// An attachment that could not be read back (`N attachment(s) no longer available and dropped.`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// `could-not-stop`: something was under way that the core could not stop. Absent otherwise, including Node's idle reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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

/// "Send now" on a queued message: the turn the user saw running ends taken over by that message, and the message starts
/// the next turn. One command: the thread decides it in one step against the turn that runs and the queue as they are then.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TurnTakeoverParams {
    pub thread_id: ThreadId,
    /// The takeover's own id, the same for every send of it: a repeat is answered the first one's receipt.
    pub op_id: OpId,
    /// The turn the user saw running. Any other turn, the one running now included, is left alone.
    pub turn_id: TurnId,
    /// The queued message: its queue id, or the submission it answers (`clientSubmissionId`).
    pub queued_id: QueuedId,
}

/// The receipt of a takeover: what was decided, and what became of the message. A refusal changed nothing: no turn was
/// stopped, and nothing of the turn running now (its tools, approvals and background jobs) was touched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnTakeoverResponse {
    /// The message is the input of the thread's next turn. The receipt says what the takeover did, never how the named turn
    /// ended: that is read from the turn's own end, whose `cause` is `message` when the takeover is what ended it.
    #[serde(rename_all = "camelCase")]
    #[cfg_attr(feature = "codegen", ts(optional_fields))]
    Accepted {
        /// The turn the request named.
        turn_id: TurnId,
        /// The message's queue id.
        queued_id: QueuedId,
        /// The submission the message answers (`clientSubmissionId`), which the row of the turn it starts carries.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submission_id: Option<String>,
        /// The takeover asked the named turn to stop for the message. False: that turn was already at its end and was left
        /// to finish (taken as the next turn, no interruption).
        interrupt_requested: bool,
        /// Always `successor`.
        message: TakeoverMessage,
        /// The pasted images and texts of the taken-over turn's prompt, which is not handed back, for the client to discard.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        discard_pasted_images: Option<JsonValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        discard_pasted_texts: Option<JsonValue>,
    },
    #[serde(rename_all = "camelCase")]
    Refused {
        /// The turn the request named.
        turn_id: TurnId,
        /// The message as the request named it.
        queued_id: QueuedId,
        reason: TakeoverRefusal,
        message: TakeoverMessage,
    },
}

/// What became of the message a takeover named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TakeoverMessage {
    /// It is the input of the thread's next turn.
    Successor,
    /// It is still queued, as it was.
    Queued,
    /// It is no longer queued: a turn took it as its input, or it was removed or handed back.
    Consumed,
}

/// Why a takeover was refused. The checks run in this order, before anything is changed, and the first that applies is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TakeoverRefusal {
    /// The thread runs no turn.
    NoRunningTurn,
    /// The running turn cannot be taken over now: a compaction is in progress, or the core holds new turns back.
    TurnNotTakeable,
    /// A Stop already claimed the named turn, or withdrew this message.
    StopClaimed,
    /// Another message already took the named turn over.
    TakenOver,
    /// Too late: the message is no longer queued, or the model already read it.
    TooLate,
    /// The named turn is not the one running.
    TurnMismatch,
    /// The message cannot be delivered to the model as it is.
    MessageUndeliverable,
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
    TurnTakeoverParams,
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
    /// On the snapshot of a positioned subscription: the ranges it holds from this snapshot on. `items` are then the
    /// rows no record holds (the running turn's in-progress items and live-only rows), every one of them whatever the
    /// window asked for, and the stored records are in `window.added`. A record shown and not yet stored is in
    /// neither: it arrives as its unit once it is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<SnapshotWindow>,
}

/// The grant a positioned snapshot installs. Its `windowVersion` is at least the snapshot's feed seq and above every
/// version the subscription held before: a subscription's window version never repeats.
///
/// It is the whole truth from the snapshot on, on a first attach, a reconnect and a lag recovery alike: every range
/// id from before is void and every row held under one is dropped, whatever the subscription had asked for. The
/// core keeps no demand across a snapshot; a client that still wants an older range asks again with
/// `thread/window/set` from this `windowVersion`, and until `thread/window/changed` grants it no change in that range
/// reaches it.
///
/// `ranges` names `tail` when the snapshot carries stored records, and `added` holds exactly those: the newest stored
/// records, whole, as a page of them reads. With `followTail` and no range, the first record the subscription is sent
/// makes the range `tail`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SnapshotWindow {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub window_version: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub lineage: u64,
    pub ranges: Vec<WindowRange>,
    pub added: Vec<WindowAdded>,
    pub follow_tail: bool,
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

/// `thread/stage/updated`: a run stage a client shows as its status, not a transcript row (Node's `onStageChange`
/// relayed to the turn's `applyStageChange`: the spinner's mode and verb), with the stage's detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadStageUpdatedParams {
    pub thread_id: ThreadId,
    pub stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<JsonValue>,
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
    /// A group room log's view as it stands once this row has landed: the row and the room's activity are one revision, so a
    /// client folds both before it tells anyone (the view is never sent separately from the row it landed with).
    ///
    /// Absent: the view is unchanged. `null`: the room shows no activity now (the clear travels with its row).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_or_null")]
    #[cfg_attr(feature = "codegen", ts(optional, type = "ThreadRoomView | null"))]
    pub room_view: Option<Option<ThreadRoomView>>,
}

/// A field that is present, `null` included, reads as `Some(..)`: with `default`, only an absent one reads `None`.
fn present_or_null<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// One stored record's rows in the positioned projection, as a page of the record reads: they travel together, oldest
/// first, with the results of the calls they opened, the archived mark, and the dividers that follow the record on its
/// last row (`meta.ext.dividersAfter`). Wherever a unit is sent (a snapshot, a range, a change) it is this one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUnit {
    /// The occurrence: opaque, of one lineage of this thread, the one position its record has, and a
    /// `thread/items/list` cursor in either direction.
    pub position: String,
    pub items: Vec<ThreadItem>,
    /// The occurrence's exact ordinal in its lineage's log order: what a client indexes the units it holds by. A
    /// position is not made of it, and positions are never parsed or compared for order. Absent from a unit that
    /// states none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional, type = "number"))]
    pub ordinal: Option<u64>,
}

/// What a positioned transcript change does to the rows a subscription holds. There is no "replace, or append when
/// missing": a subscription that does not hold `position` is sent no change at all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum TranscriptChange {
    /// A record new to the followed tail: it joins the range `tail` at its newer end. `after` is the position of the
    /// stored record before it (absent: none is known).
    #[serde(rename_all = "camelCase")]
    #[cfg_attr(feature = "codegen", ts(optional_fields))]
    Insert {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
        unit: TranscriptUnit,
    },
    /// The occurrence `unit.position`, whole, as it reads now.
    Replace {
        unit: TranscriptUnit,
    },
    Remove {
        position: String,
    },
}

/// `thread/transcript/changed`: a transcript event of the positioned projection, in one of two forms.
///
/// Without `change` it is a feed frame with a seq of its own: the place of a frame that tells every other
/// subscription a record's rows, with whatever that frame carries beside the transcript. It never carries a row.
///
/// With `change` it is a stored record's unit, sent to the subscriptions whose grants hold the record and to no
/// other, once the record is stored and whenever it then reads differently. It takes no seq of its own: it stands at
/// `atFeedPosition`, as `thread/window/changed` does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadTranscriptChangedParams {
    pub thread_id: ThreadId,
    /// The lineage the change belongs to; ranges of another one do not hold it.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub lineage: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<TranscriptChange>,
    /// Present with `change`: the feed position the change stands at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_feed_position: Option<crate::v2::feed::FeedPosition>,
    /// As on `item/completed`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_or_null")]
    #[cfg_attr(feature = "codegen", ts(optional, type = "ThreadRoomView | null"))]
    pub room_view: Option<Option<ThreadRoomView>>,
}

/// One end of a granted range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowEdge {
    /// More rows lie beyond: `position` continues the range, read on from it or back from it.
    Continuation { position: String },
    /// The transcript ends here.
    End,
}

/// A range of the transcript a subscription holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WindowRange {
    /// Names the range across window versions for as long as it is held.
    pub id: String,
    pub older: WindowEdge,
    pub newer: WindowEdge,
}

/// A range the client wants held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "at", rename_all = "camelCase")]
pub enum WindowRangeWant {
    /// A range it holds, kept as it is.
    Retain { id: String },
    /// `position`'s record and up to `rows` rows older than it.
    Before { position: String, rows: u32 },
    /// `position`'s record and up to `rows` rows newer than it.
    After { position: String, rows: u32 },
    /// `position`'s record with up to `before` rows older and `after` rows newer.
    Around { position: String, before: u32, after: u32 },
}

/// What a subscription wants to hold: demand, which the core grants in `thread/window/changed`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WindowWant {
    #[serde(default)]
    pub ranges: Vec<WindowRangeWant>,
    /// Hold the newest rows and every row that arrives.
    #[serde(default)]
    pub follow_tail: bool,
    /// Occurrences held wherever the ranges are (an open card, a prompt being edited).
    #[serde(default)]
    pub pinned: Vec<String>,
}

/// `thread/window/set`. A range held and not named in `want` is released. The call returning grants nothing and
/// releases nothing: rows are dropped when `thread/window/changed` says so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadWindowSetParams {
    pub thread_id: ThreadId,
    pub subscription_id: SubscriptionId,
    /// The `windowVersion` whose ranges `want` was made from; another version standing refuses the call.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub base_window_version: u64,
    pub request_id: String,
    pub want: WindowWant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadWindowSetResponse {
    pub request_id: String,
}

/// The contents of a range newly held, or of the part of one newly held.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WindowAdded {
    /// The [`WindowRange::id`] the units belong to.
    pub range: String,
    /// Oldest first, as of `atFeedPosition`.
    pub units: Vec<TranscriptUnit>,
}

/// `thread/window/changed`: the ranges a positioned subscription holds from `atFeedPosition` on. It sits in the
/// subscription's lane at that position, as a snapshot does: every frame through it was delivered by the ranges
/// before, every later one by these. Its feed stamp is `atFeedPosition`, which it does not advance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadWindowChangedParams {
    pub thread_id: ThreadId,
    pub subscription_id: SubscriptionId,
    /// The `thread/window/set` this answers; absent when the core changed the ranges (a lineage change).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub window_version: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub lineage: u64,
    pub at_feed_position: FeedPosition,
    /// Every range held now; one held before with the same `id` and not in `added` is unchanged.
    pub ranges: Vec<WindowRange>,
    /// The ids of ranges no longer held. Their rows may be dropped now; no row body is sent for them.
    pub removed: Vec<String>,
    pub added: Vec<WindowAdded>,
    #[serde(default)]
    pub follow_tail: bool,
}

/// `thread/rewindTargets/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadRewindTargetsListParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// A prompt the thread can be rewound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RewindTarget {
    /// The canonical target: `thread/rewind`'s `itemId` takes it, and it names one occurrence (the position the
    /// prompt's row carries in `meta.ext.historyPosition`). A prompt a compaction took out of the model's context is
    /// a target all the same. A rewind that names a position the history no longer holds is refused; one it still
    /// holds is the prompt the reader chose, whatever else moved.
    pub position: String,
    /// The prompt's text, as a rewind to it hands back.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ThreadRewindTargetsListResponse {
    /// Newest first.
    pub data: Vec<RewindTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
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

/// One publication of the session's state as Node's frame publisher made it (`frame-batched-store.mjs`): the changes
/// since the previous `thread/frame` are one state, and `structureRevision` goes up by one when they changed the rows'
/// structure. Only a reader that shows Node's frames (the phone) reads it; the other notifications are unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ThreadFrameParams {
    pub thread_id: ThreadId,
    pub structure_changed: bool,
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
    /// The turn that is running; absent while none is. A turn's end is written once, when the turn closes: an end of
    /// another turn than this one closed a turn that is over, whatever `busy` says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
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
    /// Always sent, `null` before the conversation has a provider (context-state.mjs `routeState`: `runtime.sessionProvider ?? null`).
    #[serde(default)]
    pub session_provider: Option<String>,
    #[serde(default)]
    pub session_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_capable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_auto: Option<bool>,
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
    /// The supervisor is choosing the next speaker (between two members' turns, or before the first): `typing` is then the
    /// hand-off row, which names nobody, so the band keeps its place until the next speaker replaces it or the room finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deciding: Option<bool>,
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
