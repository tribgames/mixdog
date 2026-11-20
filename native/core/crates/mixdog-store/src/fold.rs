//! The session fold (FORMAT.md §5.3, §6.2): header, history counters, model-context start
//! and the open sets, a pure function of the frames.
//!
//! Live-row counting after a rewind: a rewind supersedes the live suffix with ordinal
//! ≥ `to_ordinal`. Rows at or above the *horizon* (the newest checkpoint at open, lowered
//! by every rewind that reaches below it) are held in memory; rows below it are counted
//! from the index `history` table, which the open path has projected through the horizon
//! (`LineageIndex` refuses otherwise). Rows below the horizon are never touched by a rewind
//! of this activation except by the one that lowers it, so that one query is exact.
//!
//! Applying a batch has two phases: `prepare` (before the barrier: index lookups and
//! out-of-line header bodies; may fail and then nothing is written) and `apply` (after a
//! successful barrier; infallible), so memory advances only with durable frames.

use std::cell::RefCell;

use crate::blobs::BlobError;
use crate::blobs::BlobStore;
use crate::schema::blob::BodyBlob;
use crate::schema::blob::Slot;
use crate::schema::bounded::Digest;
use crate::schema::checkpoint::CheckpointState;
use crate::schema::checkpoint::FramePos;
use crate::schema::checkpoint::OpenRun;
use crate::schema::checkpoint::PendingApproval;
use crate::schema::checkpoint::QueuedEntry;
use crate::schema::record::ApprovalPhase;
use crate::schema::record::Base;
use crate::schema::record::Header;
use crate::schema::record::HeaderChange;
use crate::schema::record::QueueAction;
use crate::schema::record::Record;
use crate::schema::record::RunPhase;
use crate::schema::record::SessionRecord;

/// Index lookups the fold needs below its horizon.
pub trait LineageIndex: Send + Sync {
    /// Live (non-superseded) history rows of `session` with ordinal in `[from, to)`:
    /// `(rows, visible rows)`. Fails with `Behind` unless the projection reached `to`.
    fn live_rows(&self, session: &str, from: u64, to: u64) -> Result<(u64, u64), LookupError>;
    /// The newest live `compacted` frame of `session` with ordinal < `before`.
    fn live_compaction_before(&self, session: &str, before: u64) -> Result<Option<FramePos>, LookupError>;
}

#[derive(Debug, thiserror::Error)]
pub enum LookupError {
    /// The index has not projected the frames the lookup needs; reconcile first.
    #[error("index projection at ordinal {projected}, {needed} needed")]
    Behind { projected: u64, needed: u64 },
    #[error(transparent)]
    Db(#[from] crate::sqlite::DbError),
}

#[derive(Debug, thiserror::Error)]
pub enum FoldError {
    #[error("rewind to {to} outside [{start}, {at}]")]
    RewindOutOfRange { to: u64, start: u64, at: u64 },
    #[error("record kind {0} is not valid here")]
    Unexpected(&'static str),
    #[error("model switch at {at} anchored at {anchor}, not an earlier row")]
    AnchorNotBefore { anchor: u64, at: u64 },
    #[error("out-of-line body: {0}")]
    Body(String),
    #[error(transparent)]
    Lookup(#[from] LookupError),
}

/// Reads an out-of-line body slot's bytes.
pub type ResolveBody<'a> = dyn FnMut(&BodyBlob) -> Result<Vec<u8>, String> + 'a;

pub(crate) fn resolve_slot<T: serde::de::DeserializeOwned + Clone>(
    slot: &Slot<T>,
    resolve: &mut ResolveBody<'_>,
) -> Result<T, String> {
    match slot {
        Slot::Inline(v) => Ok(v.clone()),
        Slot::Blob(blob) => {
            let bytes = resolve(blob)?;
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())
        }
    }
}

#[derive(Debug, Clone)]
pub struct Below {
    rows: u64,
    visible: u64,
    compaction: Option<FramePos>,
}

impl Effect {
    /// Whether the record changes the shape of the session's history (`log_epoch`): a rewind moves the history revision
    /// and may cut the base; the delete mark ends the session's reads. The lineage is the session record's, never a
    /// later one's.
    pub(crate) fn reshapes(&self) -> bool {
        match self {
            Effect::Rewind { .. } => true,
            Effect::Header(change) => {
                change.set.iter().any(|(key, _)| key == crate::summary::DELETED)
                    || change.unset.iter().any(|key| key == crate::summary::DELETED)
            }
            _ => false,
        }
    }
}

/// What one record does to the fold, computed by `prepare`.
#[derive(Debug, Clone)]
pub(crate) enum Effect {
    None,
    Header(HeaderChange),
    Item { visible: bool, receipt: Option<String> },
    Rewind { to: u64, below: Option<Below> },
    Compacted,
    RunStarted(String),
    RunEnded(String),
    ApprovalRequested { aid: String, rid: String },
    ApprovalEnded(String),
    Enqueued(String),
    Updated(String),
    Prioritized(String),
    Dequeued { qid: String, delivered: bool },
    /// A user Stop's disposition (`crate::work_stops`).
    WorkStop { sid: String, phase: crate::schema::record::WorkStopPhase, body: Option<serde_json::Value> },
}

#[derive(Debug, Clone)]
pub struct Fold {
    pub session: String,
    pub log_id: String,
    pub base: Option<Base>,
    /// Lineage view end after a rewind into the base range (FORMAT.md §5.3).
    pub base_cut: Option<u64>,
    /// The `session` frame's `control`.
    pub control: bool,
    /// First ordinal of this session's own log.
    pub start_ordinal: u64,
    pub next_ordinal: u64,
    pub history_rev: u64,
    pub rows: u64,
    pub visible_rows: u64,
    pub header: Header,
    pub context: Option<FramePos>,
    pub runs: Vec<OpenRun>,
    pub approvals: Vec<PendingApproval>,
    pub queue: Vec<QueuedEntry>,
    horizon: u64,
    live: Vec<(u64, bool)>,
    compactions: Vec<FramePos>,
    /// Newest live compaction below the horizon.
    context_floor: Option<FramePos>,
}

impl Fold {
    /// The fold right after the `session` frame at `pos`.
    pub fn from_session(record: &SessionRecord, header: Header, pos: FramePos) -> Self {
        Self {
            session: record.id.as_str().to_owned(),
            log_id: record.log_id.as_str().to_owned(),
            base: record.base.clone(),
            base_cut: None,
            control: record.control,
            start_ordinal: pos.ordinal,
            next_ordinal: pos.ordinal + 1,
            history_rev: 0,
            rows: 0,
            visible_rows: 0,
            header,
            context: None,
            runs: Vec::new(),
            approvals: Vec::new(),
            queue: Vec::new(),
            horizon: pos.ordinal,
            live: Vec::new(),
            compactions: Vec::new(),
            context_floor: None,
        }
    }

    /// The fold right after the checkpoint frame whose state is `state`.
    pub fn from_checkpoint(session: &str, state: CheckpointState) -> Self {
        let start = state.base.as_ref().map_or(0, |b| b.end_ordinal_exclusive);
        Self {
            session: session.to_owned(),
            log_id: state.log_id,
            base: state.base,
            base_cut: state.base_cut,
            control: state.control,
            start_ordinal: start,
            next_ordinal: state.covers_ordinal + 1,
            history_rev: state.history_rev,
            rows: state.rows,
            visible_rows: state.visible_rows,
            header: state.header,
            context: state.context,
            runs: state.runs,
            approvals: state.approvals,
            queue: state.queue,
            horizon: state.covers_ordinal,
            live: Vec::new(),
            compactions: Vec::new(),
            context_floor: state.context,
        }
    }

    /// Ordinals below this are counted through the index.
    pub fn horizon(&self) -> u64 {
        self.horizon
    }

    /// The state a checkpoint frame at `covers` (= `next_ordinal`) carries.
    pub fn checkpoint_state(&self) -> CheckpointState {
        CheckpointState {
            log_id: self.log_id.clone(),
            covers_ordinal: self.next_ordinal,
            history_rev: self.history_rev,
            rows: self.rows,
            visible_rows: self.visible_rows,
            base: self.base.clone(),
            base_cut: self.base_cut,
            control: self.control,
            context: self.context,
            runs: self.runs.clone(),
            approvals: self.approvals.clone(),
            queue: self.queue.clone(),
            header: self.header.clone(),
        }
    }

    /// Phase 1 for records that will get ordinals `next_ordinal..`.
    pub(crate) fn prepare<'r>(
        &self,
        records: impl IntoIterator<Item = &'r Record>,
        index: &dyn LineageIndex,
        resolve: &mut ResolveBody<'_>,
    ) -> Result<Vec<Effect>, FoldError> {
        let mut horizon = self.horizon;
        let mut effects = Vec::new();
        for (ordinal, record) in (self.next_ordinal..).zip(records) {
            let effect = match record {
                Record::Session(_) => return Err(FoldError::Unexpected("session")),
                Record::Checkpoint(_) | Record::Amend(_) | Record::Op(_) | Record::Draft(_) => Effect::None,
                Record::Meta(meta) => Effect::Header(resolve_slot(&meta.change, resolve).map_err(FoldError::Body)?),
                Record::Item(item) => Effect::Item {
                    visible: item.visible,
                    receipt: if item.model && item.role.as_ref().is_some_and(|role| role.as_str() == "tool") {
                        crate::completion_receipts::tool_receipt(&resolve_slot(&item.body, resolve).map_err(FoldError::Body)?)
                    } else {
                        None
                    },
                },
                Record::ModelSwitch(switch) => {
                    if switch.anchor.ordinal >= ordinal {
                        return Err(FoldError::AnchorNotBefore { anchor: switch.anchor.ordinal, at: ordinal });
                    }
                    Effect::None
                }
                Record::Rewind(rewind) => {
                    let to = rewind.to_ordinal;
                    // A fork may rewind into its base range: the lineage view is cut.
                    let floor = if self.base.is_some() { 0 } else { self.start_ordinal };
                    if to < floor || to > ordinal {
                        return Err(FoldError::RewindOutOfRange {
                            to,
                            start: self.start_ordinal,
                            at: ordinal,
                        });
                    }
                    // No own row lies below a horizon at or under the log's start (a fork
                    // that rewound into its base range): nothing to look up.
                    let below = if to < horizon && horizon <= self.start_ordinal {
                        horizon = to;
                        Some(Below { rows: 0, visible: 0, compaction: None })
                    } else if to < horizon {
                        let (rows, visible) = index.live_rows(&self.session, to, horizon)?;
                        let compaction = index.live_compaction_before(&self.session, to)?;
                        horizon = to;
                        Some(Below { rows, visible, compaction })
                    } else {
                        None
                    };
                    Effect::Rewind { to, below }
                }
                Record::Compacted(_) => Effect::Compacted,
                Record::Run(run) => match run.phase {
                    RunPhase::Started => Effect::RunStarted(run.rid.as_str().to_owned()),
                    RunPhase::Attempt => Effect::None,
                    RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted => {
                        Effect::RunEnded(run.rid.as_str().to_owned())
                    }
                },
                Record::Approval(a) => match a.phase {
                    ApprovalPhase::Requested => Effect::ApprovalRequested {
                        aid: a.aid.as_str().to_owned(),
                        rid: a.rid.as_str().to_owned(),
                    },
                    ApprovalPhase::Decided | ApprovalPhase::Expired => {
                        Effect::ApprovalEnded(a.aid.as_str().to_owned())
                    }
                },
                Record::Queue(q) => match q.action {
                    QueueAction::Enqueue => Effect::Enqueued(q.qid.as_str().to_owned()),
                    QueueAction::Update => Effect::Updated(q.qid.as_str().to_owned()),
                    QueueAction::Prioritize => Effect::Prioritized(q.qid.as_str().to_owned()),
                    QueueAction::Dequeue => Effect::Dequeued {
                        qid: q.qid.as_str().to_owned(),
                        delivered: q.reason == Some(crate::schema::record::DequeueReason::Delivered),
                    },
                },
                Record::WorkStop(stop) => Effect::WorkStop {
                    sid: stop.sid.as_str().to_owned(),
                    phase: stop.phase,
                    body: stop.body.as_ref().map(|body| resolve_slot(body, resolve)).transpose().map_err(FoldError::Body)?,
                },
            };
            effects.push(effect);
        }
        Ok(effects)
    }

    /// Phase 2: the record at `pos` (= `next_ordinal`) is durable.
    pub(crate) fn apply(&mut self, effect: Effect, pos: FramePos) {
        debug_assert_eq!(pos.ordinal, self.next_ordinal);
        match effect {
            Effect::None => {}
            Effect::Header(change) => {
                for key in &change.unset {
                    self.header.shift_remove(key);
                }
                for (k, v) in change.set {
                    self.header.insert(k, v);
                }
            }
            Effect::Item { visible, receipt } => {
                if let Some(qid) = receipt {
                    crate::completion_receipts::record(&mut self.header, &qid);
                    self.queue.retain(|q| q.qid != qid);
                }
                self.live.push((pos.ordinal, visible));
                self.rows += 1;
                self.visible_rows += u64::from(visible);
            }
            Effect::Rewind { to, below } => {
                self.history_rev += 1;
                if to < self.start_ordinal {
                    self.base_cut = Some(self.base_cut.map_or(to, |c| c.min(to)));
                }
                while self.live.last().is_some_and(|&(o, _)| o >= to) {
                    let (_, visible) = self.live.pop().expect("non-empty");
                    self.rows -= 1;
                    self.visible_rows -= u64::from(visible);
                }
                while self.compactions.last().is_some_and(|c| c.ordinal >= to) {
                    self.compactions.pop();
                }
                if let Some(below) = below {
                    self.rows -= below.rows;
                    self.visible_rows -= below.visible;
                    self.context_floor = below.compaction;
                    self.horizon = to;
                }
                if self.context.is_some_and(|c| c.ordinal >= to) {
                    self.context = self.compactions.last().copied().or(self.context_floor);
                }
                self.runs.retain(|r| r.started.ordinal < to);
                self.approvals.retain(|a| a.requested.ordinal < to);
                self.queue.retain(|q| q.enqueued.ordinal < to && q.updated.is_none_or(|u| u.ordinal < to));
            }
            Effect::Compacted => {
                self.compactions.push(pos);
                self.context = Some(pos);
            }
            Effect::RunStarted(rid) => self.runs.push(OpenRun { rid, started: pos }),
            Effect::RunEnded(rid) => self.runs.retain(|r| r.rid != rid),
            Effect::ApprovalRequested { aid, rid } => {
                self.approvals.push(PendingApproval { aid, rid, requested: pos })
            }
            Effect::ApprovalEnded(aid) => self.approvals.retain(|a| a.aid != aid),
            Effect::Enqueued(qid) => self.queue.push(QueuedEntry { qid, enqueued: pos, updated: None }),
            Effect::Updated(qid) => {
                if let Some(entry) = self.queue.iter_mut().find(|q| q.qid == qid) {
                    entry.updated = Some(pos);
                }
            }
            Effect::Prioritized(qid) => {
                if let Some(at) = self.queue.iter().position(|q| q.qid == qid) {
                    let mut entry = self.queue.remove(at);
                    entry.updated = Some(pos);
                    self.queue.insert(0, entry);
                }
            }
            Effect::Dequeued { qid, delivered } => {
                if delivered && qid.starts_with("completion_") {
                    crate::completion_receipts::record(&mut self.header, &qid);
                }
                self.queue.retain(|q| q.qid != qid);
            }
            Effect::WorkStop { sid, phase, body } => {
                let gone = crate::work_stops::apply(&mut self.header, &sid, phase, body.as_ref());
                self.queue.retain(|q| !gone.contains(&q.qid));
            }
        }
        self.next_ordinal += 1;
    }
}

/// The fold of the frames of a session log read whole from its `session` frame, without
/// an index (every row is in memory): used by tests and by rebuilds.
pub struct NoIndex;

impl LineageIndex for NoIndex {
    fn live_rows(&self, _: &str, _: u64, to: u64) -> Result<(u64, u64), LookupError> {
        Err(LookupError::Behind { projected: 0, needed: to })
    }

    fn live_compaction_before(&self, _: &str, before: u64) -> Result<Option<FramePos>, LookupError> {
        Err(LookupError::Behind { projected: 0, needed: before })
    }
}

/// Notes in `gone` the digest of a body read that failed because the blob is missing or corrupt (FORMAT.md §4.5): what a
/// salvaging read takes as lost. Any other failure (an I/O error that may pass) is no loss and is not noted.
pub(crate) fn note_loss(gone: &RefCell<Vec<Digest>>, digest: &Digest, error: &BlobError) {
    if matches!(error, BlobError::Missing { .. } | BlobError::Corrupt { .. }) {
        gone.borrow_mut().push(digest.clone());
    }
}

/// A body reader over `blobs` that notes its losses in `gone` ([`note_loss`]).
pub(crate) fn noting<'a>(blobs: &'a BlobStore, gone: &'a RefCell<Vec<Digest>>) -> impl FnMut(&BodyBlob) -> Result<Vec<u8>, String> + 'a {
    move |blob| {
        let digest = &blob.descriptor().digest;
        blobs.read_unlaned(digest).map_err(|e| {
            note_loss(gone, digest, &e);
            e.to_string()
        })
    }
}

/// The digests `gone` noted since it was last taken, sorted and unique; `None` when there are none.
pub(crate) fn take_lost(gone: &RefCell<Vec<Digest>>) -> Option<Vec<Digest>> {
    let mut lost = std::mem::take(&mut *gone.borrow_mut());
    lost.sort();
    lost.dedup();
    (!lost.is_empty()).then_some(lost)
}

/// What a salvaging read of a log ([`fold_salvaging`], the index projection) could not read: the records whose
/// out-of-line body is missing or corrupt, by ordinal, with the digests they name.
#[derive(Debug, Default)]
pub(crate) struct Losses {
    /// Records whose change to the header (or the open queue) was lost since the newest checkpoint whose state was read:
    /// a later checkpoint that reads holds what they made, and clears them.
    header: Vec<(u64, Vec<Digest>)>,
    /// The `session` frame's header itself is among `header`.
    session_header: Option<Digest>,
    /// Records the index holds no rows of.
    rows: Vec<(u64, Vec<Digest>)>,
}

impl Losses {
    pub(crate) fn is_empty(&self) -> bool {
        self.header.is_empty() && self.rows.is_empty()
    }

    /// The record at `ordinal` is not projected: its body is gone.
    pub(crate) fn row(&mut self, ordinal: u64, digests: Vec<Digest>) {
        match self.rows.last_mut() {
            Some((last, named)) if *last == ordinal => {
                named.extend(digests);
                named.sort();
                named.dedup();
            }
            _ => self.rows.push((ordinal, digests)),
        }
    }

    /// The blob of the session's own header, when no checkpoint after the `session` frame restored it.
    pub(crate) fn header_missing(&self) -> Option<&Digest> {
        self.session_header.as_ref()
    }

    /// The `damage` text of the session (FORMAT.md §4.5).
    pub(crate) fn describe(&self) -> String {
        let list = |lost: &[(u64, Vec<Digest>)]| {
            lost.iter()
                .map(|(ordinal, digests)| serde_json::json!({"ordinal": ordinal, "digests": digests.iter().map(Digest::as_str).collect::<Vec<_>>()}))
                .collect::<Vec<_>>()
        };
        let lost = serde_json::json!({"header": list(&self.header), "sessionHeader": self.session_header.is_some(), "rows": list(&self.rows)});
        format!("out-of-line bodies missing or corrupt: {lost}")
    }
}

/// One record of a forward read of a log from its `session` frame into `fold` (`None` before that frame) that does
/// not stop at a body whose blob is missing or corrupt (`gone`, noted by `resolve`): a lost `session` header starts the
/// fold with a header holding only the session id, a `meta` change whose body is lost changes nothing, a tool row or a
/// Stop whose body is lost takes no receipt; each is noted in `losses`, and the next checkpoint whose state reads puts
/// back the header and queue it carries. Any other failure is the log's own and is returned. `true` when the record
/// was the `session` frame.
pub(crate) fn fold_salvaging(
    fold: &mut Option<Fold>,
    record: &Record,
    at: FramePos,
    resolve: &mut ResolveBody<'_>,
    gone: &RefCell<Vec<Digest>>,
    losses: &mut Losses,
) -> Result<bool, String> {
    let Some(f) = fold.as_mut() else {
        let Record::Session(session) = record else {
            return Err("the first frame is not a session frame".to_owned());
        };
        let header = match resolve_slot(&session.header, resolve) {
            Ok(header) => header,
            Err(e) => {
                let digests = take_lost(gone).ok_or(e)?;
                losses.session_header = digests.first().cloned();
                losses.header.push((at.ordinal, digests));
                Header::from_iter([("id".to_owned(), serde_json::Value::from(session.id.as_str()))])
            }
        };
        *fold = Some(Fold::from_session(session, header, at));
        return Ok(true);
    };
    if let Record::Checkpoint(checkpoint) = record
        && !losses.header.is_empty()
    {
        if let Ok(state) = resolve_slot(&checkpoint.state, resolve)
            && state.covers_ordinal == at.ordinal
        {
            f.header = state.header;
            f.queue = state.queue;
            losses.header.clear();
            losses.session_header = None;
        }
        take_lost(gone);
    }
    let effect = match f.prepare([record], &NoIndex, resolve) {
        Ok(mut effects) => effects.pop().expect("one effect per record"),
        Err(FoldError::Body(e)) => {
            losses.header.push((at.ordinal, take_lost(gone).ok_or(e)?));
            match record {
                Record::Item(item) => Effect::Item { visible: item.visible, receipt: None },
                Record::WorkStop(stop) => Effect::WorkStop { sid: stop.sid.as_str().to_owned(), phase: stop.phase, body: None },
                // A `meta` change: the only other record whose fold reads a body.
                _ => Effect::None,
            }
        }
        Err(e) => return Err(e.to_string()),
    };
    f.apply(effect, at);
    Ok(false)
}
