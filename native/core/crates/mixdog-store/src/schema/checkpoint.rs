//! Checkpoint state (FORMAT.md §6): everything an open needs besides the frames after the
//! checkpoint, bounded by the header and the open sets, never by history length.
//! History-dependent positions (every compaction, every log file) live in the index.

use serde::Deserialize;
use serde::Serialize;

use super::record::Base;
use super::record::Header;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointState {
    /// The session's `log_id`; a state read from a blob names the log it belongs to.
    pub log_id: String,
    /// Ordinal of the checkpoint frame itself. The state folds every frame with a smaller
    /// ordinal and nothing else.
    pub covers_ordinal: u64,
    pub history_rev: u64,
    /// Non-superseded history rows, and those of them that are visible.
    pub rows: u64,
    pub visible_rows: u64,
    /// Fork lineage, copied from the `session` frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Base>,
    /// A fork's lineage view end after a `rewind` into the base range: base rows with
    /// ordinal ≥ `base_cut` are gone for this session. Absent: the view ends at
    /// `base.end_ordinal_exclusive`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_cut: Option<u64>,
    /// The newest non-superseded `compacted` frame: the model-context start. A rewind
    /// past it takes the next one from the index (`compactions`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<FramePos>,
    /// `run` ids with `started` and no terminal phase.
    pub runs: Vec<OpenRun>,
    /// Approvals `requested` and not yet `decided`/`expired`.
    pub approvals: Vec<PendingApproval>,
    /// Queue entries enqueued and not dequeued, in enqueue order.
    pub queue: Vec<QueuedEntry>,
    /// The folded header (every key).
    pub header: Header,
}

/// Location of one frame: one positioned read returns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FramePos {
    pub ordinal: u64,
    pub file_no: u32,
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenRun {
    pub rid: String,
    pub started: FramePos,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingApproval {
    pub aid: String,
    pub rid: String,
    pub requested: FramePos,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueuedEntry {
    pub qid: String,
    pub enqueued: FramePos,
}
