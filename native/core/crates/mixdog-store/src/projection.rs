//! What the index projects from committed frames (FORMAT.md §8.2): one `ProjectedFrame`
//! per frame, built from the record by `project`, with the fold counters after it. The
//! writer hands a `Projection` to the catalog writer after each successful barrier; the
//! reconcile job builds the same values from frames read back from disk.

use serde_json::Value;

use crate::blobs::BlobPin;
use crate::compaction_view::DropMode;
use crate::message_facets::Facets;
use crate::schema::record::CompactedDropped;
use crate::fold::ResolveBody;
use crate::fold::resolve_slot;
use crate::message_state::MessageRow;
use crate::schema::blob::Slot;
use crate::summary::CatalogHead;
use crate::schema::bounded::Digest;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::ApprovalPhase;
use crate::schema::record::Base;
use crate::schema::record::Anchor;
use crate::schema::record::Form;
use crate::schema::record::ModelSwitchEntry;
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
        /// What a compaction can take out of a model message row (`history.facets`).
        facets: Option<Facets>,
    },
    Amend { iid: String, refs: Vec<Digest>, msg: Option<MessageRow> },
    Rewind { to_ordinal: u64 },
    /// `rows`: the entry iid and catalog contribution of each replacement message, in order.
    Compacted {
        cid: String,
        at: Option<i64>,
        rows: Vec<(String, MessageRow)>,
        /// How the event decides what left the context, and its identities (`Ids` only).
        mode: DropMode,
        dropped: Option<CompactedDropped>,
        /// No divider is listed for it (the record's `silent`).
        silent: bool,
    },
    Run { rid: String, phase: RunPhase },
    Approval { aid: String, rid: String, phase: ApprovalPhase },
    ModelSwitch { anchor: Anchor, entry: ModelSwitchEntry },
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
            FrameKind::Compacted { rows, dropped, .. } => {
                1 + rows.len() + dropped.as_ref().map_or(0, |d| d.message_ids.len() + d.call_ids.len())
            }
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

/// The body of a message slot.
fn message_body(slot: &Slot<Value>, resolve: &mut ResolveBody<'_>) -> Result<Value, String> {
    match slot {
        Slot::Inline(v) => Ok(v.clone()),
        Slot::Blob(_) => resolve_slot(slot, resolve),
    }
}

/// The catalog contribution of a message body slot.
fn message_row(slot: &Slot<Value>, resolve: &mut ResolveBody<'_>) -> Result<MessageRow, String> {
    Ok(MessageRow::of(&message_body(slot, resolve)?))
}

/// The kind and op of a record. `resolve` reads out-of-line message bodies.
pub fn project(record: &Record, resolve: &mut ResolveBody<'_>) -> Result<(FrameKind, Option<ProjectedOp>), String> {
    Ok(match record {
        Record::Session(r) => (FrameKind::Session { base: r.base.clone() }, op(&r.op)),
        Record::Meta(r) => (FrameKind::Other, op(&r.op)),
        Record::Item(r) => {
            let body = if r.form == Form::Message && r.model { Some(message_body(&r.body, resolve)?) } else { None };
            (
                FrameKind::Item {
                    iid: r.iid.as_str().to_owned(),
                    turn: r.turn.as_ref().map(|t| t.as_str().to_owned()),
                    form: r.form,
                    model: r.model,
                    visible: r.visible,
                    refs: r.refs.as_slice().to_vec(),
                    prompt: prompt(r, resolve)?,
                    msg: body.as_ref().map(MessageRow::of),
                    facets: body.as_ref().map(Facets::of),
                },
                op(&r.op),
            )
        }
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
                at: r.at,
                rows: resolve_slot(&r.replacement, resolve)?.iter().map(|e| (e.iid.clone(), MessageRow::of(&e.body))).collect(),
                mode: DropMode::of(r.dropped_count, r.dropped.is_some()),
                dropped: r.dropped.clone(),
                silent: r.silent == Some(true),
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
        Record::ModelSwitch(r) => {
            (FrameKind::ModelSwitch { anchor: r.anchor.clone(), entry: resolve_slot(&r.entry, resolve)? }, op(&r.op))
        }
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
/// 1.4.5 key (`promptHistoryKey`) is not empty. `resolve` reads an out-of-line prompt.
fn prompt(r: &crate::schema::record::ItemRecord, resolve: &mut ResolveBody<'_>) -> Result<Option<String>, String> {
    let Some(slot) = &r.prompt else {
        return Ok(None);
    };
    let full = resolve_slot(slot, resolve)?;
    let text = mixdog_js::js_trim(&full);
    Ok((!crate::title::prompt_history_key(text).is_empty()).then(|| text.to_owned()))
}
