//! Thread, turn and route types (P §5.1). Field sets follow today's
//! `DesktopSessionSummary`, `DesktopModelSelection` and prompt contracts.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::JsonValue;
use crate::ThreadId;
use crate::TurnId;

/// Active-state flags of a loaded thread (Codex flags plus Mixdog's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ThreadActiveFlag {
    WaitingOnApproval,
    WaitingOnUserInput,
    QuotaWaiting,
    GoalActive,
    BackgroundJobs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    #[serde(rename_all = "camelCase")]
    Active {
        active_flags: Vec<ThreadActiveFlag>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    InProgress,
    Completed,
    Interrupted,
    Failed,
}

/// Why a turn failed: an error reason object (`{reason, …}`, P §10) and,
/// for provider failures, the typed upstream detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TurnError {
    pub message: String,
    /// `{reason, …typed fields}` exactly as in JSON-RPC error `data` (P §10).
    pub data: JsonValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_error: Option<ProviderErrorDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProviderErrorDetail {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub kind: String,
    /// Delivery state of the failed attempt (SPEC §4.9).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryState {
    NotSent,
    Ambiguous,
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Turn {
    pub id: TurnId,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<TurnError>,
    /// The model's stop reason of the turn's final answer (Node `result.stopReason`, a provider
    /// string such as `end_turn`); on a completed turn only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Why the turn ended where it did (Node `result.terminationReason`; `refusal` is the one
    /// the headless result treats as an error); on a completed turn only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<String>,
    /// Present only when the read asked for items (`itemsView`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<crate::ThreadItem>>,
}

/// One list row (today's `DesktopSessionSummary`), live on the app feed as
/// `thread/summary/updated`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub preview: String,
    pub title: String,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number")]
    pub message_count: i64,
    pub cwd: String,
    /// Today's `DesktopSessionClassification`.
    pub classification: JsonValue,
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ThreadStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<ThreadId>,
    /// Inherit source (`inheritedFromSessionId` today).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub activity_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number[]")]
    pub incoming_tail: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub compact_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub read_message_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub read_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_working: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_working: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_approval: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_question: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_deleted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handed_by: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_with: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_mode: Option<String>,
    /// Today's `DesktopAgentRoomSummary`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_room: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    /// Today's `RoutineProvenance`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_routine: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub created_at: Option<i64>,
    /// Today's `DesktopSessionWorkspace`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<JsonValue>,
}

/// Today's `DesktopModelSelection`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_parameters: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub context_tokens: Option<i64>,
    /// The Lead's ordered fallback models; `[]` clears, absent keeps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallbacks: Option<Vec<ModelSelection>>,
    /// Compare-and-set: applied only while the target route has no model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_if_empty: Option<bool>,
}

/// One part of a prompt (today's `DesktopPromptContent` array form).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PromptPart {
    /// A text, or a stored text attachment: an `attachmentRef` part has no `text` and names its
    /// `textKind` (`paste` or `file`), as Node's `handoffContent` forwards it.
    #[serde(rename_all = "camelCase")]
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachment_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        size_bytes: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mime_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        /// Base64 bytes; a part that names a stored `attachment_ref` instead has none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        data: Option<String>,
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachment_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        size_bytes: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        data: Option<String>,
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachment_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        size_bytes: Option<u32>,
    },
}

/// Today's `DesktopPromptContent`: a string or an array of parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PromptContent {
    Text(String),
    Parts(Vec<PromptPart>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PromptPriority {
    Now,
    Next,
    Later,
}

/// Today's `DesktopPromptAttachment`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PromptAttachment {
    #[ts(type = "number")]
    pub id: i64,
    /// Always `image` today.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub size_bytes: Option<i64>,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_media_type: Option<String>,
}

/// Today's `DesktopPastedText`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PastedText {
    #[ts(type = "number")]
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub size_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub chars: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Caller options of `turn/start` (today's `DesktopSubmitOptions` without the
/// host-only fields `device`, `hop`, `roomRow`, `origin`; a request carrying
/// any of them is `invalidParams`, P §4.3).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SubmitOptions {
    /// Today's submit `id`: the client's correlation id reused by queue and transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_submission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub submitted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_failed_turn: Option<bool>,
    /// The failed user message a retry replays from the model history (`retryTurnId`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_turn_id: Option<String>,
    /// The failed attempt of that message (`retryAttemptId`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<PromptPriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pasted_images: Option<BTreeMap<String, PromptAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pasted_texts: Option<BTreeMap<String, PastedText>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kickoff: Option<bool>,
    /// The agent tool's `context` of a queued follow-up (`submitAsync` option `context`): kept on
    /// the queue entry as Node keeps it. Host-only: a connection's request carrying it is
    /// `invalidParams`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// The stored files' sizes by `attachmentRef`, which the message's attachment records take
    /// in place of a part's claimed `sizeBytes` (`attachmentBlobSize`). Host-only, like `context`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_sizes: Option<BTreeMap<String, u32>>,
}

/// Today's `DesktopQuotaResume`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuotaResume {
    /// Always `waiting`.
    pub state: String,
    pub turn_key: String,
    pub provider: String,
    pub model: String,
    #[ts(type = "number")]
    pub reset_at: i64,
    #[ts(type = "number")]
    pub attempts: i64,
}

/// Why the core is winding down (LR §5, SPEC R22). Shared by core-api and the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum DrainReason {
    Update,
    Quit,
    Restart,
    NoClients,
}

/// Who issued a call: the connection origin (P §4.1, DS §4.2). Shared by
/// core-api (`PermissionDenied.origin`) and the method table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// Loopback WebSocket (desktop, TUI, CLI on this machine).
    Local,
    /// The same WebSocket through an SSH port forward.
    Ssh,
    /// A paired phone through the E2E relay.
    Relay,
}

/// Structured detail of a coded domain failure, one variant per code that
/// carries details today (worktree, merge, room and schedule refusals). Fields
/// and their optionality are the union over every producer of that code.
/// Shared by core-api and the wire. The error's text is never here: it is the error's own
/// `message`, as Node's `error.message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DomainErrorDetail {
    /// `WORKTREE_BUSY_JOBS`; `reason` picks the refusal text.
    #[serde(rename_all = "camelCase")]
    WorktreeBusyJobs {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        outcome: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        admission: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sessions: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        kept: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        workers: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        jobs: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        shell_jobs: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        starting: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        session_id: Option<String>,
    },
    /// `WORKTREE_DIRTY`: project-dirty, worktree removal and carry refusals; `reason` picks the refusal text.
    #[serde(rename_all = "camelCase")]
    WorktreeDirty {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        operation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        files: Option<DirtyFiles>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        paths: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        max_files: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        max_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        head: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        base_commit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        recovery_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        restored: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cause: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        restore_error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        ignored: Option<Vec<String>>,
    },
    /// `WORKTREE_DIRTY_CHOICE`: the pending changes to carry or leave.
    #[serde(rename_all = "camelCase")]
    WorktreeDirtyChoice {
        #[ts(type = "number")]
        count: u64,
        paths: Vec<String>,
    },
    /// `WORKTREE_TARGET_MISMATCH`.
    #[serde(rename_all = "camelCase")]
    WorktreeTargetMismatch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        current: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        actual: Option<String>,
    },
    /// `WORKTREE_UNMERGED`.
    #[serde(rename_all = "camelCase")]
    WorktreeUnmerged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        commit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        merge_target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        commits: Option<u64>,
    },
    /// `WORKTREE_PROJECT_UNKNOWN`.
    #[serde(rename_all = "camelCase")]
    WorktreeProjectUnknown {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        project_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    /// `WORKTREE_UNSUPPORTED_REPO`.
    #[serde(rename_all = "camelCase")]
    WorktreeUnsupportedRepo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        project_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        line: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rel: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        base_branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        branch: Option<String>,
    },
    /// `WORKTREE_PATH_UNSAFE`.
    #[serde(rename_all = "camelCase")]
    WorktreePathUnsafe {
        entry_id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        links: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        count: Option<u64>,
    },
    /// `WORKTREE_REVISION_CONFLICT`.
    #[serde(rename_all = "camelCase")]
    WorktreeRevisionConflict {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        remaining: Option<Vec<RemovalRemnant>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tx_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        expected_revision: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        revision: Option<u64>,
    },
    /// `WORKTREE_BRANCH_OCCUPIED`; `path` names the holder in the refusal text.
    #[serde(rename_all = "camelCase")]
    WorktreeBranchOccupied {
        branch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        /// `session` or `external` (today's `kind`).
        kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        session_id: Option<String>,
    },
    /// `WORKTREE_MISSING`.
    #[serde(rename_all = "camelCase")]
    WorktreeMissing {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        worktree_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path: Option<String>,
    },
    /// `WORKTREE_FILE_RECOVERY`.
    #[serde(rename_all = "camelCase")]
    WorktreeFileRecovery {
        entry_id: String,
        path: String,
        recovery_root: String,
    },
    /// `WORKTREE_DEFAULT_BRANCH`.
    #[serde(rename_all = "camelCase")]
    WorktreeDefaultBranch { branch: String },
    /// `WORKTREE_DISK_INSUFFICIENT`; the byte counts fill the refusal text.
    #[serde(rename_all = "camelCase")]
    WorktreeDiskInsufficient {
        #[ts(type = "number")]
        required_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        free_bytes: Option<u64>,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    /// `WORKTREE_LARGE_REPO_CONFIRM`; `estimateBytes` fills the prompt.
    #[serde(rename_all = "camelCase")]
    WorktreeLargeRepoConfirm {
        #[ts(type = "number")]
        estimate_bytes: u64,
        #[ts(type = "number")]
        threshold_bytes: u64,
    },
    /// `WORKTREE_PROJECT_MISMATCH`.
    #[serde(rename_all = "camelCase")]
    WorktreeProjectMismatch {
        project_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        worktree_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        worktree_project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        repo_common_dir: Option<String>,
    },
    /// `WORKTREE_REMOVAL_INCOMPLETE`.
    #[serde(rename_all = "camelCase")]
    WorktreeRemovalIncomplete {
        entry_id: String,
        path: String,
        retryable: bool,
        remaining: Vec<RemovalRemnant>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        revision: Option<u64>,
    },
    /// `MERGE_FAILED`.
    #[serde(rename_all = "camelCase")]
    MergeFailed {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        aborted: Option<bool>,
    },
    /// `MERGE_TARGET_DIRTY`.
    #[serde(rename_all = "camelCase")]
    MergeTargetDirty {
        operation: String,
        files: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        count: Option<u64>,
    },
    /// `ROOM_MEMBER_SWITCHED_OFF`: a message names a room member whose bot is switched off
    /// (Node `details: {name}`, the member's display name).
    #[serde(rename_all = "camelCase")]
    RoomMemberSwitchedOff { name: String },
    /// `SCHEDULE_NAME_TAKEN`: another schedule has the name (`name` is the name asked for).
    #[serde(rename_all = "camelCase")]
    ScheduleNameTaken { name: String },
    /// `SCHEDULE_RENAME_RUNNING`: a run of the schedule, or another rename of it, is in flight.
    #[serde(rename_all = "camelCase")]
    ScheduleRenameRunning { name: String },
    /// `SCHEDULE_RENAME_RELOAD_FAILED`: the row moved but the scheduler did not reload (`name`
    /// is the new name). `SCHEDULE_RENAME_UNCERTAIN` carries no detail.
    #[serde(rename_all = "camelCase")]
    ScheduleRenameReloadFailed { name: String },
    /// `MERGE_CONFLICT`: the conflicted files, as git listed them.
    #[serde(rename_all = "camelCase")]
    MergeConflict { files: Vec<String> },
}

/// `files` of `WORKTREE_DIRTY`: a path preview, or a count (carry `too-large`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum DirtyFiles {
    Count(#[ts(type = "number")] u64),
    Paths(Vec<String>),
}

/// One thing a worktree removal left behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RemovalRemnant {
    /// `link`, `registry`, `cleanup` or `error`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum OrchestrationMode {
    None,
    Focused,
    Balanced,
    Swarm,
}
