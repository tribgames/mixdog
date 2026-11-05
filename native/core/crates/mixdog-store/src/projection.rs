//! What the index projects from committed frames (FORMAT.md §8.2): one `ProjectedFrame`
//! per frame, built from the record by `project`, with the fold counters after it. The
//! writer hands a `Projection` to the catalog writer after each successful barrier; the
//! reconcile job builds the same values from frames read back from disk.

use serde_json::Value;

use crate::blobs::BlobPin;
use crate::fold::ResolveBody;
use crate::fold::resolve_slot;
use crate::message_state::MessageRow;
use crate::schema::blob::Slot;
use crate::summary::CatalogHead;
use crate::schema::bounded::Digest;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::ApprovalPhase;
use crate::schema::record::Base;
use crate::schema::record::Form;
use crate::schema::record::OpRef;
use crate::schema::record::OpState;
use crate::schema::record::Record;
use crate::schema::record::RunPhase;

#[derive(Debug, Clone, PartialEq)]
pub enum FrameKind {
    Session { base: Option<Base> },
    Item {
        iid: String,
        turn: Option<String>,
        form: Form,
        model: bool,
        visible: bool,
        refs: Vec<Digest>,
        /// The trimmed prompt text of a visible `user` message row (prompt history).
        prompt: Option<String>,
        /// The catalog contribution of a model message row.
        msg: Option<MessageRow>,
    },
    Amend { iid: String, refs: Vec<Digest>, msg: Option<MessageRow> },
    Rewind { to_ordinal: u64 },
    /// `rows`: the entry iid and catalog contribution of each replacement message, in order.
    Compacted { cid: String, rows: Vec<(String, MessageRow)> },
    Run { rid: String, phase: RunPhase },
    Approval { aid: String, rid: String, phase: ApprovalPhase },
    /// `meta`, `queue`, `op`, `checkpoint`: nothing beyond the op lookup.
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedOp {
    pub id: String,
    pub method: String,
    pub digest: String,
    pub state: OpState,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedFrame {
    pub pos: FramePos,
    pub frame_len: u64,
    pub kind: FrameKind,
    pub op: Option<ProjectedOp>,
    /// Fold counters after this frame.
    pub history_rev: u64,
    pub rows: u64,
    pub visible_rows: u64,
}

impl ProjectedFrame {
    /// Rows this frame writes to the index, not counting rewind marks (bounded per frame
    /// by `MAX_REFS`).
    pub fn rows(&self) -> usize {
        let own = match &self.kind {
            FrameKind::Item { refs, prompt, msg, .. } => {
                2 + refs.len() + 2 * usize::from(prompt.is_some()) + usize::from(msg.is_some())
            }
            FrameKind::Amend { refs, .. } => 2 + refs.len(),
            FrameKind::Compacted { rows, .. } => 1 + rows.len(),
            FrameKind::Other => 0,
            _ => 1,
        };
        own + usize::from(self.op.is_some())
    }
}

/// The frames of one barrier (or one reconcile read) of one session.
#[derive(Debug)]
pub struct Projection {
    pub session: String,
    pub frames: Vec<ProjectedFrame>,
    /// The session's header side after these frames: the catalog row is rebuilt from it
    /// and the projected message state once the frames are in.
    pub head: CatalogHead,
    /// Kept from blob publication until these frames are in `blob_refs` (SM §9).
    pub pins: Vec<BlobPin>,
}

fn op(op: &Option<OpRef>) -> Option<ProjectedOp> {
    op.as_ref().map(|o| ProjectedOp {
        id: o.id.as_str().to_owned(),
        method: o.method.as_str().to_owned(),
        digest: o.digest.as_str().to_owned(),
        state: OpState::Applied,
    })
}

/// The catalog contribution of a message body slot.
fn message_row(slot: &Slot<Value>, resolve: &mut ResolveBody<'_>) -> Result<MessageRow, String> {
    match slot {
        Slot::Inline(v) => Ok(MessageRow::of(v)),
        Slot::Blob(_) => Ok(MessageRow::of(&resolve_slot(slot, resolve)?)),
    }
}

/// The kind and op of a record. `resolve` reads out-of-line message bodies.
pub fn project(record: &Record, resolve: &mut ResolveBody<'_>) -> Result<(FrameKind, Option<ProjectedOp>), String> {
    Ok(match record {
        Record::Session(r) => (FrameKind::Session { base: r.base.clone() }, op(&r.op)),
        Record::Meta(r) => (FrameKind::Other, op(&r.op)),
        Record::Item(r) => (
            FrameKind::Item {
                iid: r.iid.as_str().to_owned(),
                turn: r.turn.as_ref().map(|t| t.as_str().to_owned()),
                form: r.form,
                model: r.model,
                visible: r.visible,
                refs: r.refs.as_slice().to_vec(),
                prompt: prompt(r),
                msg: if r.form == Form::Message && r.model { Some(message_row(&r.body, resolve)?) } else { None },
            },
            op(&r.op),
        ),
        Record::Amend(r) => (
            FrameKind::Amend {
                iid: r.iid.as_str().to_owned(),
                refs: r.refs.as_slice().to_vec(),
                msg: Some(message_row(&r.body, resolve)?),
            },
            op(&r.op),
        ),
        Record::Rewind(r) => (FrameKind::Rewind { to_ordinal: r.to_ordinal }, op(&r.op)),
        Record::Compacted(r) => (
            FrameKind::Compacted {
                cid: r.cid.as_str().to_owned(),
                rows: resolve_slot(&r.replacement, resolve)?.iter().map(|e| (e.iid.clone(), MessageRow::of(&e.body))).collect(),
            },
            op(&r.op),
        ),
        Record::Run(r) => (
            FrameKind::Run {
                rid: r.rid.as_str().to_owned(),
                phase: r.phase,
            },
            op(&r.op),
        ),
        Record::Approval(r) => (
            FrameKind::Approval {
                aid: r.aid.as_str().to_owned(),
                rid: r.rid.as_str().to_owned(),
                phase: r.phase,
            },
            op(&r.op),
        ),
        Record::Queue(r) => (FrameKind::Other, op(&r.op)),
        Record::Op(r) => {
            let mut o = op(&Some(r.op.clone()));
            if let Some(o) = o.as_mut() {
                o.state = r.state;
            }
            (FrameKind::Other, o)
        }
        Record::Checkpoint(_) => (FrameKind::Other, None),
    })
}

/// The prompt-history text of an item: its `prompt` field, trimmed (JS `trim`), when the
/// 1.4.5 key (`promptHistoryKey`) is not empty.
fn prompt(r: &crate::schema::record::ItemRecord) -> Option<String> {
    let text = mixdog_js::js_trim(r.prompt.as_deref()?);
    (!crate::title::prompt_history_key(text).is_empty()).then(|| text.to_owned())
}
