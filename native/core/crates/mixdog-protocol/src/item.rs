//! Transcript items (P §5.3), tagged by `type`. Shared variants keep the
//! parity shape where the meaning is equal; Mixdog variants are added (X12). Every variant carries `id` and the common `meta`; `ext` holds
//! the remaining attributes of today's transcript row that the client fold
//! needs for field-for-field parity (P §14.12).

use serde::Deserialize;
use serde::Serialize;

use crate::ItemId;
use crate::JsonObject;
use crate::JsonValue;
use crate::MaybeBlob;
use crate::ThreadId;
use crate::TurnId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
    Interrupted,
}

/// Attributes shared by every item (today's `DesktopTranscriptItem` common fields).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ItemMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ItemStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Human-readable model label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Actual route id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The stable message id of the row's message (`meta.transcript.messageId`):
    /// what a compaction's dropped-message ids and a room line's `room.id` name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Delivered into the thread outside any turn (agent-home delivery).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted: Option<bool>,
    /// Remaining row attributes of today's transcript row.
    #[serde(default, skip_serializing_if = "JsonObject::is_empty")]
    pub ext: JsonObject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    Image,
    File,
    Text,
}

/// The picked file behind a resized image: its blob is kept while the record exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AttachmentOriginal {
    pub attachment_ref: String,
    pub mime_type: String,
}

/// One attachment of a user message (`meta.transcript.attachments`, `normalizeMessageAttachments`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct MessageAttachment {
    /// The content hash (64 lowercase hex, no `sha256:` prefix) the attachment store keeps the bytes under.
    pub id: String,
    /// The same hash again: the key the store's census marks as referenced.
    pub attachment_ref: String,
    pub kind: AttachmentKind,
    pub name: String,
    pub mime_type: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<AttachmentOriginal>,
}

/// `id` of an image chip: the paste number or a string id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum ImageChipId {
    Number(i64),
    Text(String),
}

/// Byte-free image metadata of a user row (`images`): its chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ImageChip {
    #[serde(default)]
    pub id: Option<ImageChipId>,
    pub name: String,
    pub mime_type: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ref: Option<String>,
}

/// The stored original of one restored `[Image: …]` line (`imageRefs`); an
/// image without a stored original has no `ref`, so later images keep their slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ImageRef {
    pub line: String,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

/// A bot's emoji reaction on a user message, one per bot, in the order left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct MessageReaction {
    pub agent_id: String,
    pub emoji: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: Option<i64>,
}

/// One tool of an imported run: its name and how many times it ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ImportedTool {
    pub name: String,
    pub count: u32,
}

/// A run of tool use inside an imported assistant message's text. `start`/`end` locate the
/// run's canonical line (`[ran tools: shell ×6, Read ×2]`) in `text` as UTF-16 code-unit
/// offsets, Node's string indices; the client keeps a run only where the text still holds
/// that line, and draws the text around the runs as assistant rows. The calls' results were
/// never imported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct ImportedToolRun {
    pub start: u32,
    pub end: u32,
    pub tools: Vec<ImportedTool>,
}

/// How a turn ended (`turndone.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TurnEndStatus {
    Done,
    Failed,
    /// The turn was interrupted by the user.
    Cancelled,
}

/// What a stored user-role message is (Node's `meta.source`). Absent on `UserRowDetails` means
/// a typed prompt. Everything but a typed prompt, `Import`, `RoutineTrigger` and `Steering`
/// is runtime-written text: a client shows it as the notice or card it stands for and never
/// as the user's own words, and the core never sends such text as a plain prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub enum MessageSource {
    /// Prose imported from another tool; plain text whatever it looks like.
    #[serde(rename = "import")]
    Import,
    /// A routine (schedule or webhook) fire; see `routineTrigger`.
    #[serde(rename = "routine-trigger")]
    RoutineTrigger,
    /// A message delivered into the running turn.
    #[serde(rename = "steering")]
    Steering,
    /// A schedule's result posted into its owner's home thread.
    #[serde(rename = "schedule-result")]
    ScheduleResult,
    /// A held request of an unattended run.
    #[serde(rename = "held-request")]
    HeldRequest,
    /// A delivered task or channel notification.
    #[serde(rename = "task-notification")]
    TaskNotification,
    #[serde(rename = "compact-summary")]
    CompactSummary,
    #[serde(rename = "compact-context")]
    CompactContext,
    #[serde(rename = "compact-active-turn-continuation")]
    CompactActiveTurnContinuation,
    #[serde(rename = "compact-execution-recovery")]
    CompactExecutionRecovery,
    #[serde(rename = "context-ack")]
    ContextAck,
    #[serde(rename = "skill-context")]
    SkillContext,
    #[serde(rename = "goal-continuation")]
    GoalContinuation,
    #[serde(rename = "goal-closeout")]
    GoalCloseout,
    #[serde(rename = "max-output-recovery")]
    MaxOutputRecovery,
    #[serde(rename = "refusal-recovery")]
    RefusalRecovery,
    #[serde(rename = "stream-cut-recovery")]
    StreamCutRecovery,
    #[serde(rename = "content-filter-recovery")]
    ContentFilterRecovery,
    #[serde(rename = "turn-limit")]
    TurnLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RoutineKind {
    Schedule,
    Webhook,
}

/// The routine fire a turn delivered (`routineTrigger`): painted as its marker row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct RoutineTrigger {
    pub kind: RoutineKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HeldRequestStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HeldRunKind {
    Schedule,
    Webhook,
    Room,
}

/// The run that was held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HeldRun {
    pub kind: HeldRunKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// A held request of an unattended run (Node `meta.heldRequest`, `normalizeHeldRequest`). The
/// desktop paints a pending one as an approval card and answers it with `id` through the
/// ordinary approval call; `status` and `device` show how it settled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HeldRequest {
    pub id: String,
    pub status: HeldRequestStatus,
    pub agent_id: String,
    /// `approval` unless the request says otherwise.
    pub kind: String,
    pub tool: String,
    pub target: String,
    pub reason: String,
    /// The outbound text the card may show; never a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<std::collections::BTreeMap<String, String>>,
    /// The remember scopes the request allows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember: Option<Vec<String>>,
    pub run: HeldRun,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

/// Who and what a user row came from, beyond its content.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct UserRowDetails {
    /// What the message is; absent for a typed prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MessageSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_trigger: Option<RoutineTrigger>,
    /// The request of a `held-request` message; the client's row carries it as `heldRequest`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_request: Option<HeldRequest>,
    /// The sender (`lead` for the user's Lead session).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    /// The bot that sent the message (a bot's `session send`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent: Option<String>,
    /// Delivered into the running turn (steering): the row's read mark.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steered: Option<bool>,
    /// Every submission a merged queued batch delivered as this turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub submission_ids: Vec<String>,
    /// The executions a woken batch delivered; `null` keeps the position of an entry that named none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumed_execution_ids: Vec<Option<String>>,
    /// Bot-to-bot chain position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop: Option<u32>,
    /// The bots that handed the message on, sender last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bot_chain: Vec<String>,
    /// A group-room member turn: the newest user row of the room log its prompt shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_row: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageChip>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_refs: Vec<ImageRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<MessageReaction>,
}

/// One category entry of an aggregate tool card header (`categories` / `doneCategories`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AggregateCategory {
    pub key: String,
    pub category: String,
    pub active: String,
    pub done: String,
    pub noun: String,
    pub plural_noun: String,
    pub effect: bool,
    pub count: u32,
}

/// What an aggregate tool card (`aggregate: true`, name `__aggregate__`) adds.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ToolAggregate {
    /// The calls the card folds, in order.
    #[serde(default)]
    pub call_ids: Vec<String>,
    /// First-seen order of the `categories` keys (`args.categoryOrder`).
    #[serde(default)]
    pub category_order: Vec<String>,
    #[serde(default)]
    pub categories: std::collections::BTreeMap<String, AggregateCategory>,
    #[serde(default)]
    pub done_categories: std::collections::BTreeMap<String, AggregateCategory>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub completed_count: u32,
}

/// A result's side channel: a stable code, the missing capability names and, for a
/// `visualize` call run for another session's work, that owner session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ToolMeta {
    pub code: String,
    #[serde(default)]
    pub missing: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_session_id: Option<String>,
}

/// The facts of a tool row shared by every tool-backed item variant
/// (today's `kind: 'tool'` row). `args`, `result` and `rawResult` are the
/// row's display values; the variant's own fields stay the typed call.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ToolRun {
    /// The call id tying the row to its call and result messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<MaybeBlob<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_result: Option<MaybeBlob<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_diff: Option<MaybeBlob<String>>,
    /// The structured side channel of a result (`toolMeta`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_meta: Option<ToolMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<ToolAggregate>,
    /// Built by a live turn's tool cards (`turn-tool-cards.mjs`): the row reads as that turn's card, an `__aggregate__`
    /// even for one call, not as the card a restore rebuilds (`mergeRestoredToolItems` merges only two or more).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
}

/// How a compaction ended (the `status` of its divider row).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub enum CompactionStatus {
    #[serde(rename = "compacted")]
    Compacted,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "no_change")]
    NoChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RoomRowKind {
    User,
    Speech,
    Pass,
    Cap,
    Stopped,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RoomLimit {
    Rounds,
    Messages,
    Usage,
}

/// The usage limit a `cap` line stopped at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RoomUsage {
    pub kind: String,
    pub provider: String,
    pub model: String,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub reset_at: Option<i64>,
}

/// A tool a member used in its turn, as the speech line summarises it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct RoomTool {
    pub name: String,
    pub summary: String,
}

/// A stored file reference of a room line (`parts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct RoomPart {
    #[serde(rename = "type")]
    #[cfg_attr(feature = "codegen", ts(rename = "type"))]
    pub kind: AttachmentKind,
    pub attachment_ref: String,
    /// `paste` | `file`, for a text part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub size_bytes: Option<u64>,
}

/// The payload of a group-room line (`normalizeRoomRow`, the row's `room`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct RoomLine {
    pub kind: RoomRowKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub at: Option<i64>,
    /// The member id of a speech or pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// The member's display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A user line another session sent: its sender session, the sending bot and its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// Addressee ids and their names, index for index.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to_name: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<bool>,
    /// The members a collapsed run of failed passes names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<RoomLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<RoomUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rounds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<RoomTool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<RoomPart>,
}

/// One input element of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text {
        text: String,
    },
    /// An image or file attachment, by content digest.
    #[serde(rename_all = "camelCase")]
    Attachment {
        blob: crate::BlobDescriptor,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        original: Option<crate::BlobDescriptor>,
    },
    /// Pasted text kept out of line (today's `pastedTexts`).
    #[serde(rename_all = "camelCase")]
    PastedText {
        text: MaybeBlob<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        filename: Option<String>,
    },
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadItem {
    #[serde(rename_all = "camelCase")]
    UserMessage {
        id: ItemId,
        content: Vec<UserInput>,
        /// Device that submitted the prompt (host-stamped).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        device: Option<String>,
        /// The client correlation id of the submit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        client_submission_id: Option<String>,
        /// The turn's change-record key (what review reads and reverts address).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        checkpoint_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        applied_skills: Option<Vec<String>>,
        /// The row text Node shows, chips included; the client's `user` row `text`.
        /// Computed at commit (migration: for 1.4.5 history).
        display_text: String,
        /// Whether the prompt belongs in the composer's prompt history.
        /// Computed at commit (migration: for 1.4.5 history).
        counts_for_prompt_history: bool,
        /// Sender, attachments, reactions and the other facts of the row.
        #[serde(default, skip_serializing_if = "UserRowDetails::is_empty_boxed")]
        details: Box<UserRowDetails>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    AgentMessage {
        id: ItemId,
        text: MaybeBlob<String>,
        /// Tool use an imported assistant message recorded (Node `importedToolRuns`); the
        /// client draws each as tool cards. Empty for every other message.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        imported_tool_runs: Vec<ImportedToolRun>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    Reasoning {
        id: ItemId,
        #[serde(default)]
        summary: Vec<String>,
        #[serde(default)]
        content: Vec<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    ContextCompaction {
        id: ItemId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        summary: Option<MaybeBlob<String>>,
        /// How it ended; the divider's label (`Conversation compacted`, `Compact failed`, …) and
        /// stats are `meta.label` and `meta.detail`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        status: Option<CompactionStatus>,
        #[serde(default)]
        meta: ItemMeta,
    },
    #[serde(rename_all = "camelCase")]
    SubAgentActivity {
        id: ItemId,
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        thread_id: Option<ThreadId>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// Every other built-in tool.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: ItemId,
        name: String,
        input: JsonValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        output: Option<MaybeBlob<JsonValue>>,
        /// The tool row's shared facts (call id, display args/result, timing, aggregate).
        #[serde(default, skip_serializing_if = "ToolRun::is_empty_boxed")]
        run: Box<ToolRun>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// The end of a turn (Node's `turndone` row). `cancelled` is the interrupted end: the
    /// cancel line Node renders, with `elapsedMs` 0 when restored from the cancel text.
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        id: ItemId,
        status: TurnEndStatus,
        #[cfg_attr(feature = "codegen", ts(type = "number"))]
        elapsed_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        verb: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        checkpoint_id: Option<String>,
        /// The turn's last assistant row, on a `done` end.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        final_assistant_id: Option<ItemId>,
        /// A `failed` end's reason, details, error kind and quota stop.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        error_details: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        error_kind: Option<JsonObject>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        quota: Option<JsonObject>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// `statusdone` rows and notices.
    #[serde(rename_all = "camelCase")]
    StatusRow {
        id: ItemId,
        kind: String,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// A group-room line. A client builds Node's row from it: a `user` line is a `user` row,
    /// every other kind a `notice` row (tone `info`) whose `room` payload is `room` plus
    /// `id` = `meta.messageId` and `at`. `text` is the line's own words (user and speech
    /// lines; empty otherwise). Files and reactions sit on the line as on a user message.
    #[serde(rename_all = "camelCase")]
    RoomRow {
        id: ItemId,
        room: Box<RoomLine>,
        text: MaybeBlob<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<MessageAttachment>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageChip>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reactions: Vec<MessageReaction>,
        #[serde(default)]
        meta: ItemMeta,
    },
    /// A sub-agent dispatch row.
    #[serde(rename_all = "camelCase")]
    AgentJob {
        id: ItemId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        task_id: Option<String>,
        #[serde(default)]
        meta: ItemMeta,
    },
}

impl UserRowDetails {
    /// `skip_serializing_if` sees the field by reference, so it needs the boxed type.
    #[allow(clippy::borrowed_box)]
    pub fn is_empty_boxed(details: &Box<Self>) -> bool {
        details.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

impl ToolRun {
    #[allow(clippy::borrowed_box)]
    pub fn is_empty_boxed(run: &Box<Self>) -> bool {
        run.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

impl ThreadItem {
    pub fn id(&self) -> &ItemId {
        match self {
            Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::Reasoning { id, .. }
            | Self::ContextCompaction { id, .. }
            | Self::SubAgentActivity { id, .. }
            | Self::ToolCall { id, .. }
            | Self::StatusRow { id, .. }
            | Self::TurnEnd { id, .. }
            | Self::RoomRow { id, .. }
            | Self::AgentJob { id, .. } => id,
        }
    }
}
