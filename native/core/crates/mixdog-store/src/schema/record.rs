//! Session log record kinds (FORMAT.md §5). A frame payload is one `Record` encoded by
//! `serde_json` (compact, key `"k"` first, fields in declaration order, `None` options
//! omitted). Parsing rejects unknown kinds, unknown fields and out-of-bound values; it
//! never checks the encoding itself (the CRC proves the bytes are the writer's).
//!
//! Every field outside the one body slot has a bounded type (`super::bounded`), so the
//! largest record is bounded by the types (FORMAT.md §3.3).

use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;

use super::blob::MAX_REFS;
use super::blob::Slot;
use super::bounded::Digest;
use super::bounded::ID_MAX;
use super::bounded::Id;
use super::bounded::Json;
use super::bounded::LOG_ID_MAX;
use super::bounded::List;
use super::bounded::Name;
use super::bounded::OP_ID_MAX;
use super::bounded::OP_RESULT_MAX;
use super::bounded::SHA256_HEX_MAX;
use super::bounded::Text;
use super::checkpoint::CheckpointState;

pub type LogId = Text<LOG_ID_MAX>;
/// `session/<id>`.
pub type SessionItemKey = Text<{ ID_MAX + 8 }>;

/// The session header: every 1.4.5 header key (the session record minus `messages`),
/// carried as an opaque map.
pub type Header = Map<String, Value>;

/// `session.v` of this format.
pub const SESSION_RECORD_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum Record {
    Session(SessionRecord),
    Meta(MetaRecord),
    Item(ItemRecord),
    Amend(AmendRecord),
    Rewind(RewindRecord),
    Compacted(CompactedRecord),
    Run(RunRecord),
    Approval(ApprovalRecord),
    Queue(QueueRecord),
    Op(OpRecord),
    Checkpoint(CheckpointRecord),
}

/// First frame of file `log.000000`: ordinal 0, or `base.end_ordinal_exclusive` for a fork.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRecord {
    pub v: u32,
    pub id: Id,
    pub log_id: LogId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Base>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    pub header: Slot<Header>,
}

/// Fork lineage: this session's history continues the base session's history before
/// `end_ordinal_exclusive`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Base {
    pub session: Id,
    pub log_id: LogId,
    pub end_ordinal_exclusive: u64,
}

/// Self-identification of a migration target (FORMAT.md §10.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub migration: MigrationOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationOrigin {
    pub manifest_sha256: Text<SHA256_HEX_MAX>,
    pub item_key: SessionItemKey,
    /// `sha256:` digest of the source observable state (FORMAT.md §10.6).
    pub source_digest: Digest,
}

/// One atomic header change (the body of a `meta` record).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetaRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    pub change: Slot<HeaderChange>,
}

/// Keys in `unset` are removed, then `set` is merged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderChange {
    pub set: Header,
    pub unset: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Form {
    /// A model message (`role`, `content`, `toolCalls`, `meta`, … as 1.4.5 stores it).
    Message,
    /// An imported 1.4.5 compaction-archive display item, rendered verbatim. Never
    /// created at runtime; always `model: false`.
    Display,
}

/// One history row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemRecord {
    pub iid: Id,
    /// The run (`rid`) this row belongs to. The input rows of a run are its rows that
    /// precede its `run{phase:"started"}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<Id>,
    /// The message `role`, or the display item's `role` when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Name>,
    pub form: Form,
    /// Part of the model context.
    pub model: bool,
    /// Shown in history pages.
    pub visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<ArchiveTag>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    /// Sorted, unique `sha256:` digests of every blob the record references: attachment
    /// parts of the body and the body slot itself when out of line.
    pub refs: Refs,
    pub body: Slot<Value>,
}

pub type Refs = List<Digest, MAX_REFS>;

/// Where an imported archive row came from; enough to rebuild the 1.4.5 segment line
/// or pending job in meaning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveTag {
    pub seq: u64,
    /// The source `at` number (1.4.5 writes `Date.now()`, or `null` for `NaN`); absent
    /// when the source has none or `null`, which 1.4.5 reads alike.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Number>,
    pub origin: ArchiveOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ArchiveOrigin {
    /// A line of `<id>.compaction-archive.jsonl` (`{"v":1,"seq","id","prev","at","count","bytes","items"}`).
    Segment {
        id: Id,
        #[serde(skip_serializing_if = "Option::is_none")]
        prev: Option<Id>,
        count: u64,
        bytes: u64,
    },
    /// A job of `<id>.compaction-archive.pending` (`{seq, at, divider, clearedThrough, maxBytes, messages}`).
    Pending {
        divider: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        cleared_through: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u64>,
    },
}

/// Replaces the body of row `iid`, keeping its identity and position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AmendRecord {
    pub iid: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    pub refs: Refs,
    pub body: Slot<Value>,
}

/// Supersedes every record with ordinal in `[to_ordinal, this ordinal)`; `history_rev + 1`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RewindRecord {
    pub to_ordinal: u64,
    pub reason: RewindReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindReason {
    Rewind,
    Edit,
    Clear,
}

/// The model context restarts at `replacement`; later `model` rows extend it. History rows
/// are never removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactedRecord {
    pub cid: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_iid: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    pub replacement: Slot<Vec<ReplacementEntry>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplacementEntry {
    pub iid: String,
    pub body: Value,
}

/// Turn lifecycle. `started` is appended only after the run's input rows are durable; on
/// open, a `started` without a terminal phase gets `interrupted` appended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRecord {
    pub rid: Id,
    pub phase: RunPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<Attribution>,
    /// Present iff `phase` is `attempt`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Attempt>,
    /// Milliseconds since the Unix epoch; absent only on imported runs without a source time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Slot<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Started,
    Attempt,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attribution {
    pub provider: Name,
    pub model: Name,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Name>,
    pub route: Name,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<Name>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Name>,
}

/// One provider attempt of a run and how far its request got (SPEC §4.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub n: u32,
    pub delivery: Delivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    NotSent,
    Ambiguous,
    Accepted,
}

/// Approval state; a pending request survives restart. `body` is the request
/// (`requested`) or the decision (`decided`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRecord {
    pub aid: Id,
    pub rid: Id,
    pub phase: ApprovalPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_client: Option<Id>,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Slot<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPhase {
    Requested,
    Decided,
    Expired,
}

/// Pending steer/follow-up/notification messages. `entry` (present iff `enqueue`) is the
/// queued entry in the 1.4.5 pending-spool shape minus `id`:
/// `{message, notificationKind?, mode?, executionId?, execution?, enqueuedAt?}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueRecord {
    pub qid: Id,
    pub action: QueueAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<DequeueReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<OpRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<Slot<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueAction {
    Enqueue,
    Dequeue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DequeueReason {
    Delivered,
    Cancelled,
}

/// A thread-scope op outcome that is not carried by the mutation record applying it
/// (P §9): rejections, fences and external-effect states.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpRecord {
    pub op: OpRef,
    pub state: OpState,
    pub at: i64,
    /// `rejected` → the error; `externalPending`/`externalUnknown` → `{effect, target}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Slot<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpState {
    Applied,
    Rejected,
    Fenced,
    ExternalPending,
    ExternalUnknown,
}

/// The op a mutation record applies (P §9.2: effect and op record are one durable write).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpRef {
    /// Client UUIDv7.
    pub id: Text<OP_ID_MAX>,
    pub method: Name,
    /// `sha256:` digest of the canonical JSON of the params without `opId` (P §9.2).
    pub digest: Digest,
    /// The response result when its encoding is ≤ `OP_RESULT_MAX`; otherwise absent and
    /// reproduced by a read (P §9.2 `resultRef`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Json<OP_RESULT_MAX>>,
}

/// Bounded materialized state (FORMAT.md §6). Never holds rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRecord {
    pub state: Slot<CheckpointState>,
}
