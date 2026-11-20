//! What the index projects from committed frames (FORMAT.md §8.2): one `ProjectedFrame`
//! per frame, built from the record by `project`, with the fold counters after it. The
//! writer hands a `Projection` to the catalog writer after each successful barrier; the
//! reconcile job builds the same values from frames read back from disk.

use serde_json::Value;

use crate::compaction_view::DropMode;
use crate::fold::ResolveBody;
use crate::fold::resolve_slot;
use crate::message_facets::Facets;
use crate::message_state::MessageRow;
use crate::schema::blob::Slot;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::Anchor;
use crate::schema::record::ApprovalPhase;
use crate::schema::record::Base;
use crate::schema::record::CompactedDropped;
use crate::schema::record::Form;
use crate::schema::record::ModelSwitchEntry;
use crate::schema::record::OpRef;
use crate::schema::record::OpState;
use crate::schema::record::Record;
use crate::schema::record::RunPhase;
use crate::summary::CatalogHead;

#[derive(Debug, Clone, PartialEq)]
pub enum FrameKind {
    Session {
        base: Option<Base>,
    },
    Item {
        iid: String,
        turn: Option<String>,
        form: Form,
        model: bool,
        visible: bool,
        /// The trimmed prompt text of a visible `user` message row (prompt history).
        prompt: Option<String>,
        /// The catalog contribution of a model message row.
        msg: Option<MessageRow>,
        /// What a compaction can take out of a model message row (`history.facets`).
        facets: Option<Facets>,
        /// The ids other than `iid` by which a client may name a row of this item: the submission id of a user row and the
        /// own id of a display row (`history_alias`). A superset is harmless: the reader checks what it finds.
        aliases: Vec<String>,
    },
    /// `aliases`: the ids the amended body names, added to the row it amends (the original's stay: a superset).
    Amend {
        iid: String,
        msg: Option<MessageRow>,
        aliases: Vec<String>,
    },
    Rewind {
        to_ordinal: u64,
    },
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
    Run {
        rid: String,
        phase: RunPhase,
    },
    Approval {
        aid: String,
        rid: String,
        phase: ApprovalPhase,
    },
    ModelSwitch {
        anchor: Anchor,
        entry: ModelSwitchEntry,
    },
    /// `meta`, `queue`, `op`, `checkpoint`, and a record whose body is lost (FORMAT.md §4.5): nothing beyond the op lookup.
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedOp {
    pub id: String,
    pub method: String,
    pub digest: String,
    pub state: OpState,
}

/// The acceptance of a client submission a frame records: the prompt's `clientSubmissionId` and the answer its send got,
/// `{kind:"started", turnId}` for a prompt row that started its turn, `{kind:"queued", queuedId}` for a queue entry. The
/// index keeps the first per session and id: a later start of the queued prompt, or a requeue, does not replace it.
#[derive(Debug, Clone, PartialEq)]
pub struct Receipt {
    pub submission: String,
    pub answer: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedFrame {
    pub pos: FramePos,
    pub frame_len: u64,
    pub kind: FrameKind,
    pub op: Option<ProjectedOp>,
    /// The submission this frame accepted (`receipt`).
    pub receipt: Option<Receipt>,
    /// Fold counters after this frame.
    pub history_rev: u64,
    pub rows: u64,
    pub visible_rows: u64,
}

impl ProjectedFrame {
    /// Rows this frame writes to the index, not counting rewind marks.
    pub fn rows(&self) -> usize {
        let own = match &self.kind {
            FrameKind::Item { prompt, msg, aliases, .. } => 2 + 2 * usize::from(prompt.is_some()) + usize::from(msg.is_some()) + aliases.len(),
            FrameKind::Amend { aliases, .. } => 2 + aliases.len(),
            FrameKind::Compacted { rows, dropped, .. } => 1 + rows.len() + dropped.as_ref().map_or(0, |d| d.message_ids.len() + d.call_ids.len()),
            FrameKind::Other => 0,
            _ => 1,
        };
        own + usize::from(self.op.is_some()) + usize::from(self.receipt.is_some())
    }
}

/// The out-of-line bodies of a record the projection does not read for rows (a run's detail, an approval's body, a queue
/// entry, an op's detail, a draft, a work stop): the rebuild checks they exist, so a lost one is reported as the session's
/// damage like a lost row body (FORMAT.md §4.5).
pub fn unread_bodies(record: &Record) -> Vec<&crate::schema::blob::BodyBlob> {
    fn slot(slot: &Slot<Value>) -> Option<&crate::schema::blob::BodyBlob> {
        match slot {
            Slot::Blob(blob) => Some(blob),
            Slot::Inline(_) => None,
        }
    }
    match record {
        Record::Run(r) => r.detail.iter().filter_map(slot).collect(),
        Record::Approval(r) => r.body.iter().filter_map(slot).collect(),
        Record::Queue(r) => r.entry.iter().filter_map(slot).collect(),
        Record::Op(r) => r.detail.iter().filter_map(slot).collect(),
        Record::Draft(r) => slot(&r.body).into_iter().collect(),
        Record::WorkStop(r) => r.body.iter().filter_map(slot).collect(),
        _ => Vec::new(),
    }
}

/// The op `record` carries (P §9.2), read without any body: an `op` record's own outcome state, every other op applied.
pub fn record_op(record: &Record) -> Option<ProjectedOp> {
    match record {
        Record::Session(r) => op(&r.op),
        Record::Meta(r) => op(&r.op),
        Record::Item(r) => op(&r.op),
        Record::Amend(r) => op(&r.op),
        Record::Rewind(r) => op(&r.op),
        Record::Compacted(r) => op(&r.op),
        Record::Run(r) => op(&r.op),
        Record::Approval(r) => op(&r.op),
        Record::ModelSwitch(r) => op(&r.op),
        Record::Queue(r) => op(&r.op),
        Record::Op(r) => op(&Some(r.op.clone())).map(|o| ProjectedOp { state: r.state, ..o }),
        Record::Checkpoint(_) | Record::Draft(_) | Record::WorkStop(_) => None,
    }
}

/// The submission `record` accepted, if any: a user prompt row of a turn naming its `meta.transcript.clientSubmissionId`
/// (a row of no turn is a carried copy, an heir's or an import's, not an acceptance), or a queue entry naming its
/// `options.clientSubmissionId`. `resolve` reads an out-of-line body.
pub fn receipt(record: &Record, resolve: &mut ResolveBody<'_>) -> Result<Option<Receipt>, String> {
    let named = |value: Option<&Value>| value.and_then(Value::as_str).map(mixdog_js::js_trim).filter(|id| !id.is_empty()).map(str::to_owned);
    Ok(match record {
        Record::Item(r) if r.form == Form::Message && r.model && r.role.as_ref().is_some_and(|role| role.as_str() == "user") => {
            let Some(turn) = &r.turn else { return Ok(None) };
            let body = message_body(&r.body, resolve)?;
            named(body.pointer("/meta/transcript/clientSubmissionId"))
                .map(|submission| Receipt { submission, answer: serde_json::json!({ "kind": "started", "turnId": turn.as_str() }) })
        }
        Record::Queue(r) if r.action == crate::schema::record::QueueAction::Enqueue => {
            let Some(entry) = &r.entry else { return Ok(None) };
            let entry = message_body(entry, resolve)?;
            named(entry.pointer("/options/clientSubmissionId"))
                .map(|submission| Receipt { submission, answer: serde_json::json!({ "kind": "queued", "queuedId": r.qid.as_str() }) })
        }
        _ => None,
    })
}

/// The frames of one barrier (or one reconcile read) of one session.
#[derive(Debug)]
pub struct Projection {
    pub session: String,
    pub frames: Vec<ProjectedFrame>,
    /// The session's header side after these frames: the catalog row is rebuilt from it
    /// and the projected message state once the frames are in. Shared with the row waiting to be
    /// written: it holds the session's whole header, which is copied once, where it is taken.
    pub head: std::sync::Arc<CatalogHead>,
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

/// The kind and op of a record. `resolve` reads out-of-line message bodies.
pub fn project(record: &Record, resolve: &mut ResolveBody<'_>) -> Result<(FrameKind, Option<ProjectedOp>), String> {
    let kind = match record {
        Record::Session(r) => FrameKind::Session { base: r.base.clone() },
        Record::Item(r) => {
            let body = if r.form == Form::Message && r.model { Some(message_body(&r.body, resolve)?) } else { None };
            let aliases = match (&body, r.form) {
                (Some(body), _) => aliases_of(r.iid.as_str(), body, false),
                (None, Form::Display) => aliases_of(r.iid.as_str(), &message_body(&r.body, resolve)?, true),
                (None, Form::Message) => Vec::new(),
            };
            FrameKind::Item {
                iid: r.iid.as_str().to_owned(),
                turn: r.turn.as_ref().map(|t| t.as_str().to_owned()),
                form: r.form,
                model: r.model,
                visible: r.visible,
                prompt: prompt(r, resolve)?,
                msg: body.as_ref().map(MessageRow::of),
                facets: body.as_ref().map(Facets::of),
                aliases,
            }
        }
        Record::Amend(r) => {
            let body = message_body(&r.body, resolve)?;
            FrameKind::Amend { iid: r.iid.as_str().to_owned(), msg: Some(MessageRow::of(&body)), aliases: aliases_of(r.iid.as_str(), &body, false) }
        }
        Record::Rewind(r) => FrameKind::Rewind { to_ordinal: r.to_ordinal },
        Record::Compacted(r) => FrameKind::Compacted {
            cid: r.cid.as_str().to_owned(),
            at: r.at,
            rows: resolve_slot(&r.replacement, resolve)?.iter().map(|e| (e.iid.clone(), MessageRow::of(&e.body))).collect(),
            mode: DropMode::of(r.dropped_count, r.dropped.is_some()),
            dropped: r.dropped.clone(),
            silent: r.silent == Some(true),
        },
        Record::Run(r) => FrameKind::Run { rid: r.rid.as_str().to_owned(), phase: r.phase },
        Record::Approval(r) => FrameKind::Approval { aid: r.aid.as_str().to_owned(), rid: r.rid.as_str().to_owned(), phase: r.phase },
        Record::ModelSwitch(r) => FrameKind::ModelSwitch { anchor: r.anchor.clone(), entry: resolve_slot(&r.entry, resolve)? },
        Record::Meta(_) | Record::Queue(_) | Record::Op(_) | Record::Checkpoint(_) | Record::Draft(_) | Record::WorkStop(_) => FrameKind::Other,
    };
    Ok((kind, record_op(record)))
}

/// The ids besides `iid` that name a row of the item `body`: a submission id (`clientSubmissionId` of a display row, of a
/// message's `meta.transcript`), and for a `display` row its own `id`.
fn aliases_of(iid: &str, body: &Value, display: bool) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let named = [body.get("clientSubmissionId"), body.pointer("/meta/transcript/clientSubmissionId"), body.get("id").filter(|_| display)];
    for id in named.into_iter().flatten().filter_map(Value::as_str) {
        if !id.is_empty() && id != iid && !found.iter().any(|f| f == id) {
            found.push(id.to_owned());
        }
    }
    found
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
