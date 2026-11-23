//! The actor's ordered outbox: every accepted change in accept order. A durable entry is
//! encoded on cpu-interactive (completions arrive in any order) and handed to the
//! `DurabilityTask` strictly in order (the reorder buffer, RL §5.6).
//!
//! The show rule (Node's: an item is shown when it exists; durability decides only what survives a failure). An entry
//! goes out in two steps, each in accept order. It is *shown* (applied to the acked state, its notes published) once it
//! exists in its final form (a view-only entry at once, a record once encoded) and every entry before it is shown,
//! unless a failure of its save would withdraw it ([`withdrawn_on_failure`]: its caller hears the failure and its change
//! is undone), in which case it is shown only once durable. It is *settled* (its rows numbered, its effects run: replies,
//! acks, a draft's removal) once it and every entry before it are durable, or held by a failed barrier, as before the
//! rule. So the feed never shows an event before one it follows; a failed save withdraws nothing it showed (what was
//! shown is held, shown, and written again by the next save, as Node keeps its session in memory); and the log, a prefix
//! of the accepted sequence, is a prefix of what was shown, which is what a crash replays.

use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_protocol::ApprovalResolution;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::{ApprovalPhase, QueueAction, RunPhase};
use serde_json::Value;
use tokio::sync::oneshot;

use super::SessionLimits;
use super::frames::Note;
use super::run::RunError;
use super::seams::CommitRecord;
use super::seams::EncodedRecord;
use super::state::Change;

/// Which part of the durability window a record uses (RL §6.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    Normal,
    /// Run status, approval records, steer dequeues: the control reserve.
    Control,
}

/// The record's kind as the log tags it.
fn record_kind(record: &Record) -> &'static str {
    match record {
        Record::Session(_) => "session",
        Record::Meta(_) => "meta",
        Record::Item(_) => "item",
        Record::Amend(_) => "amend",
        Record::Rewind(_) => "rewind",
        Record::Compacted(_) => "compacted",
        Record::Run(_) => "run",
        Record::Approval(_) => "approval",
        Record::Queue(_) => "queue",
        Record::Op(_) => "op",
        Record::Checkpoint(_) => "checkpoint",
        Record::ModelSwitch(_) => "model_switch",
        Record::Draft(_) => "draft",
        Record::WorkStop(_) => "work_stop",
    }
}

fn conversation_record(record: &Record) -> bool {
    match record {
        Record::Item(_) | Record::Amend(_) | Record::Rewind(_) | Record::Compacted(_) | Record::Run(_) | Record::Queue(_) => true,
        Record::Approval(approval) => approval.phase == ApprovalPhase::Requested,
        _ => false,
    }
}

pub(crate) enum Stage {
    Encoding,
    Encoded(EncodedRecord),
    /// Handed to the durability task; the encoding is kept for a retry should its barrier fail.
    Handed(EncodedRecord),
    /// Its barrier failed and it stays, in its place, to be handed again by a retry: released unsaved ([`Entry::held`]), or
    /// kept whole and unreleased ([`Outbox::keep`]).
    Held(EncodedRecord),
    Acked(u64),
}

pub(crate) struct Durable {
    pub record: Arc<Record>,
    pub class: Class,
    pub stage: Stage,
    pub bytes: usize,
    /// The unit this record is written in: every record of one request's plan, committed together or not at all.
    pub unit: u64,
    /// A failed write keeps the unit, unreleased, for the next one (Node's recorder keeps a failed batch's bytes).
    pub retain: bool,
    /// Whether the record still counts in the window (a held or kept one no longer does: it waits for the next write).
    counted: bool,
    /// The record's number on the outbox's [`mixdog_rt::WriteMarks`].
    #[cfg(any(test, feature = "test-support"))]
    pub mark: u64,
}

/// One unit handed to the durability task: its records in accept order.
pub(crate) struct HandedUnit {
    pub records: Vec<(u64, CommitRecord, usize)>,
}

/// What happens when an entry is released, or fails.
pub(crate) enum Effect {
    Reply {
        op: Option<OpId>,
        tx: Option<oneshot::Sender<Result<Reply, CoreError>>>,
        value: Value,
    },
    /// The reply to a change Node keeps in memory when its save fails (a heir's creation and carried conversation, an
    /// internal row or header change): it is answered once released, durable or held, and failed only by a rollback.
    Kept {
        tx: Option<oneshot::Sender<Result<Reply, CoreError>>>,
        value: Value,
    },
    /// The receipt of a change its caller counts only once it is stored (a worker release, `thread/header/patch` with
    /// `stored`): answered at the journal barrier of its own record, never while the record is held unsaved, and with
    /// the failure of that barrier when it fails, whoever asked. `op` is the operation its record carries.
    Stored {
        op: Option<OpId>,
        tx: Option<oneshot::Sender<Result<Reply, CoreError>>>,
        value: Value,
    },
    /// The run's input rows are durable.
    InputDurable,
    ItemAck(oneshot::Sender<Result<(), RunError>>),
    /// A close's or delete's mark is durable: told as [`Effect::ItemAck`] is, but a failed save fails it rather than
    /// holding it (`closeSession` answers `false` when its tombstone does not land).
    MarkAck(oneshot::Sender<Result<(), RunError>>),
    /// Publish the server request (its `requested` record is durable).
    PublishApproval(PendingServerRequest),
    /// The resolution record is durable.
    Resolved(ApprovalId, ApprovalResolution),
    /// A history mutation is durable: recompute the prompt-history session part over the
    /// remaining lineage, and republish the merged list when `publish`.
    RecomputePrompts {
        publish: bool,
    },
    /// A failed turn's end is released: its quota settlement begins (`beginQuotaSettlement`), then the Goal
    /// settles with `settle` (`onGoalTurnSettled`'s detail).
    TurnClosed {
        turn: TurnId,
        settle: Value,
    },
    /// Told once the frames of the pump that released this entry are published: the caller sees its change as a client does.
    /// An entry whose record failed to be stored is told that failure instead; its change is never shown.
    AfterPublish(oneshot::Sender<Result<(), CoreError>>),
    /// A conditional header patch, decided against these header keys as projected: when a record ahead of it fails its
    /// barrier, its caller hears `conflict` and computes it again instead of the failure.
    Decided(Vec<String>),
    /// A write of the run's draft file, in order with its records: it starts once every record before it is durable (or
    /// held), and no record after it is handed on before it ([`Outbox::handoff`]), so the draft and the log together hold a
    /// prefix of what the run produced, as when each waited for the one before. `Some`: the run's own step, told once written.
    Draft(super::turn_draft::DraftWrite, Option<oneshot::Sender<Result<(), RunError>>>),
}

pub(crate) struct Entry {
    pub id: u64,
    pub durable: Option<Durable>,
    pub change: Change,
    /// Notes known at accept time; release adds the ones derived from acked state, an item record's `item/completed` among
    /// them (built from the item as the state holds it once the entry is applied, never before).
    pub notes: Vec<Note>,
    pub effects: Vec<Effect>,
    /// The rows a page of the record reads once it is stored, as the log holds it: the record's unit for the positioned
    /// subscriptions. Empty for a record that shows none and for a view-only entry.
    pub unit: Vec<mixdog_protocol::ThreadItem>,
    /// The entry this view-only one stands on: it is dropped with that entry when the record fails to encode.
    pub needs: Option<u64>,
    /// Released before it was durable (its barrier failed, [`Outbox::hold`]): its change is in the acked state and its
    /// effects ran; it stays only to be written, in order, by a retry.
    pub held: bool,
    /// Shown before it was settled (the show rule): its change is in the acked state and its notes are published; it
    /// stays, with its effects, until it settles.
    pub shown: bool,
}

/// An outbox entry whose failure a client hears: a request's own record, a close's mark, a toast its caller waits on, or
/// a queued prompt (refused, so a retry is a new submission).
pub(crate) fn answers_a_client(entry: &Entry) -> bool {
    entry.effects.iter().any(|effect| {
        matches!(effect, Effect::Reply { op, tx, .. } if op.is_some() || tx.is_some())
            || matches!(effect, Effect::MarkAck(_) | Effect::AfterPublish(_) | Effect::Stored { .. })
    }) || matches!(&entry.change, Change::Record { record, .. } if matches!(&**record, Record::Queue(queue) if queue.action == QueueAction::Enqueue))
}

/// A failure of the entry's save withdraws it rather than holding it: its caller hears the failure (a client's request, a
/// turn's start, a conditional patch), or its unit is kept unreleased for the next write (`retain`). Such an entry is
/// shown only once durable; any other is shown as soon as it exists.
fn withdrawn_on_failure(entry: &Entry) -> bool {
    answers_a_client(entry)
        || entry.effects.iter().any(|effect| matches!(effect, Effect::InputDurable | Effect::Decided(_)))
        || entry.durable.as_ref().is_some_and(|durable| durable.retain)
}

/// The entry holds a turn's terminal record.
fn closes_turn(entry: &Entry) -> bool {
    matches!(&entry.change, Change::Record { record, .. } if matches!(&**record, Record::Run(run) if !matches!(run.phase, RunPhase::Started | RunPhase::Attempt)))
}

/// What [`Outbox::pop_ready`] gives the actor next.
pub(crate) enum Ready {
    /// Shown and settled at once: applied and published, its effects run, at its ordinal if it holds a record.
    Release(Entry, Option<u64>),
    /// Shown now, before it settles: its change and notes (no effects); the entry stays in its place.
    Show(Entry),
    /// Shown earlier (or held by a failed barrier) and settled now: its rows get the ordinal, its remaining effects run.
    Settle(Entry, Option<u64>),
}

#[derive(Default)]
struct Usage {
    records: usize,
    bytes: usize,
}

pub(crate) struct Outbox {
    entries: VecDeque<Entry>,
    next_id: u64,
    limits: SessionLimits,
    normal: Usage,
    reserve: Usage,
    /// The unit records pushed now join ([`Self::begin_unit`]), and whether it is retained on a failed write.
    unit: Option<(u64, bool)>,
    /// A drained prompt's dequeue and the start record it shows with ([`Self::pair`]): `None` while the start is not accepted yet.
    paired: Option<(u64, Option<u64>)>,
    /// Every durable record numbered as it is accepted ([`Self::push`]) and reported once: written when the store acked it
    /// ([`Self::acked`]), failed when it left uncommitted ([`Self::note_failed`], or the outbox dropped with it still open).
    /// The replay barrier reads these without the actor ([`super::SessionDirectory::durability_settled`]).
    #[cfg(any(test, feature = "test-support"))]
    marks: Arc<mixdog_rt::WriteMarks>,
}

impl Outbox {
    pub fn new(limits: SessionLimits) -> Self {
        Self {
            entries: VecDeque::new(),
            next_id: 1,
            limits,
            normal: Usage::default(),
            reserve: Usage::default(),
            unit: None,
            paired: None,
            #[cfg(any(test, feature = "test-support"))]
            marks: Arc::new(mixdog_rt::WriteMarks::new("the thread's records")),
        }
    }

    /// The records pushed until [`Self::end_unit`] are one unit (one request's plan): handed on and written together.
    pub fn begin_unit(&mut self, retain: bool) {
        self.unit = Some((self.next_id, retain));
    }

    pub fn end_unit(&mut self) {
        self.unit = None;
    }

    /// The entry `id` (a drained prompt's dequeue) is shown with its turn's start, not before: it waits until [`Self::pair_with`]
    /// names the start record and that record is shown or acked, or until [`Self::unpair_pending`]. Only its showing waits (the
    /// projected queue changed at its accept); everything accepted after it is shown after it, as always.
    pub fn pair(&mut self, id: u64) {
        self.paired = Some((id, None));
    }

    /// The waiting dequeue's start record is `start`.
    pub fn pair_with(&mut self, start: u64) {
        if let Some((_, partner @ None)) = &mut self.paired {
            *partner = Some(start);
        }
    }

    /// The waiting dequeue's start is not coming (refused, or deferred behind other work): it is shown on its own.
    pub fn unpair_pending(&mut self) {
        if matches!(self.paired, Some((_, None))) {
            self.paired = None;
        }
    }

    /// Entry `id` went out: a pairing of it is over.
    fn unpaired(&mut self, id: u64) {
        if self.paired.is_some_and(|(paired, _)| paired == id) {
            self.paired = None;
        }
    }

    /// Entry `id` waits for its paired start: not accepted yet, or still neither showable nor acked. A start that is gone (its
    /// unit failed) holds nothing.
    fn paired_waits(&self, id: u64) -> bool {
        match self.paired {
            Some((paired, None)) => paired == id,
            Some((paired, Some(start))) if paired == id => self
                .index(start)
                .is_some_and(|index| !matches!(self.entries[index].durable, Some(Durable { stage: Stage::Acked(_), .. })) && !self.showable(index)),
            _ => false,
        }
    }

    /// An outbox numbering its durable records on `marks`: the thread's [`super::control::ControlCell::record_marks`].
    #[cfg(any(test, feature = "test-support"))]
    pub fn numbered_on(limits: SessionLimits, marks: Arc<mixdog_rt::WriteMarks>) -> Self {
        let mut outbox = Self::new(limits);
        outbox.marks = marks;
        outbox
    }

    /// The durable record of a removed entry left uncommitted.
    #[cfg(any(test, feature = "test-support"))]
    pub fn note_failed(&self, durable: &Durable, error: String) {
        self.marks.failed(durable.mark, error);
    }

    /// A record of `class` fits the window now.
    pub fn has_room(&self, class: Class) -> bool {
        let normal = self.normal.records < self.limits.window_records && self.normal.bytes < self.limits.window_bytes;
        match class {
            Class::Normal => normal,
            Class::Control => normal || (self.reserve.records < self.limits.reserve_records && self.reserve.bytes < self.limits.reserve_bytes),
        }
    }

    /// Producers (runs, sections) are read only while the normal window and the release
    /// backlog have room; otherwise their lane fills and they wait (RL §6.2).
    /// Every accepted record is released (durable or failed).
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The accepted records not yet acknowledged.
    #[cfg(any(test, feature = "test-support"))]
    pub fn unacked(&self) -> usize {
        self.normal.records + self.reserve.records
    }

    /// Held entries are released already: they count in neither the window nor the backlog.
    pub fn producer_room(&self) -> bool {
        self.entries.iter().filter(|entry| !entry.held).count() < self.limits.outbox_entries && self.has_room(Class::Normal)
    }

    /// Some entry was released unsaved and is not durable yet.
    pub fn has_unsaved(&self) -> bool {
        self.entries.iter().any(|entry| entry.held)
    }

    /// Accepted conversation records left by a failure, including retained units that have not been shown yet.
    /// Both held and retained records leave the window but keep their place until acknowledged.
    pub fn unsaved_conversation(&self) -> impl Iterator<Item = u64> + '_ {
        self.entries.iter().filter_map(|entry| {
            let durable = entry.durable.as_ref()?;
            (!durable.counted && !matches!(durable.stage, Stage::Acked(_)) && conversation_record(&durable.record)).then_some(entry.id)
        })
    }

    /// Capture attempted records that represent accepted data before failure handling removes entries. Retained units
    /// (room posts/imports) are accepted even if they have not been published. Refused turn starts are neither.
    pub fn attempted_conversation<'a>(&'a self, entries: &'a [u64]) -> impl Iterator<Item = u64> + 'a {
        entries.iter().copied().filter(|&id| {
            self.get(id).is_some_and(|entry| {
                entry.durable.as_ref().is_some_and(|durable| (durable.retain || entry.shown || entry.held) && conversation_record(&durable.record))
            })
        })
    }

    /// The last entry accepted.
    pub fn last_id(&self) -> Option<u64> {
        self.entries.back().map(|entry| entry.id)
    }

    /// Some record accepted at or before entry `id` is not stored yet.
    pub fn unwritten_through(&self, id: u64) -> bool {
        self.entries
            .iter()
            .take_while(|entry| entry.id <= id)
            .any(|entry| entry.durable.as_ref().is_some_and(|durable| !matches!(durable.stage, Stage::Acked(_))))
    }

    /// Some record a failed barrier left, held or kept, waits for a retry.
    pub fn awaits_retry(&self) -> bool {
        self.entries.iter().any(|entry| matches!(entry.durable, Some(Durable { stage: Stage::Held(_), .. })))
    }

    /// The ids of the unreleased entries not handed to a barrier whose effects match `waits`, in order.
    pub fn waiting(&self, waits: impl Fn(&Effect) -> bool) -> Vec<u64> {
        self.entries
            .iter()
            .filter(|entry| !entry.held && !matches!(entry.durable, Some(Durable { stage: Stage::Handed(_), .. })) && entry.effects.iter().any(&waits))
            .map(|entry| entry.id)
            .collect()
    }

    /// The ids of the entries handed to the barrier that failed, in order.
    pub fn handed(&self) -> Vec<u64> {
        self.entries.iter().filter(|entry| matches!(entry.durable, Some(Durable { stage: Stage::Handed(_), .. }))).map(|entry| entry.id).collect()
    }

    /// The handed entry `id` failed its barrier: it waits for a retry, out of the window. The first time, it is
    /// released unsaved: what it shows (none when it was shown already, a view-only copy: its change and notes)
    /// and its effects are returned for the caller to apply.
    pub fn hold(&mut self, id: u64) -> Option<(Option<Entry>, Vec<Effect>)> {
        let index = self.index(id)?;
        let entry = &mut self.entries[index];
        let durable = entry.durable.as_mut()?;
        let Stage::Handed(encoded) = std::mem::replace(&mut durable.stage, Stage::Encoding) else {
            unreachable!("only a handed entry fails its barrier");
        };
        durable.stage = Stage::Held(encoded);
        if std::mem::replace(&mut entry.held, true) {
            return None;
        }
        let (class, bytes, counted) = (durable.class, durable.bytes, std::mem::replace(&mut durable.counted, false));
        let unshown = (!entry.shown).then(|| Entry {
            id: entry.id,
            durable: None,
            change: entry.change.clone(),
            notes: std::mem::take(&mut entry.notes),
            effects: Vec::new(),
            unit: Vec::new(),
            needs: None,
            held: false,
            shown: false,
        });
        let released = (unshown, std::mem::take(&mut entry.effects));
        if counted {
            let usage = self.usage(class);
            usage.records -= 1;
            usage.bytes -= bytes;
        }
        Some(released)
    }

    /// The handed entry `id` of a retained unit failed its barrier: it stays in its place, unreleased and out of the window, and
    /// goes again with the next write ([`Self::handoff`]).
    pub fn keep(&mut self, id: u64) {
        let Some(index) = self.index(id) else { return };
        let Some(durable) = self.entries[index].durable.as_mut() else { return };
        if let Stage::Handed(encoded) = &durable.stage {
            durable.stage = Stage::Held(encoded.clone());
        }
        if std::mem::replace(&mut durable.counted, false) {
            let (class, bytes) = (durable.class, durable.bytes);
            let usage = self.usage(class);
            usage.records -= 1;
            usage.bytes -= bytes;
        }
    }

    /// The ids of the handed entries of retained units, in order.
    pub fn handed_retained(&self) -> Vec<u64> {
        self.entries.iter().filter(|entry| matches!(entry.durable, Some(Durable { stage: Stage::Handed(_), retain: true, .. }))).map(|entry| entry.id).collect()
    }

    /// The unit `id` belongs to, when it holds a record.
    pub fn unit_of(&self, id: u64) -> Option<u64> {
        self.get(id)?.durable.as_ref().map(|durable| durable.unit)
    }

    fn usage(&mut self, class: Class) -> &mut Usage {
        match class {
            Class::Normal => &mut self.normal,
            Class::Control => &mut self.reserve,
        }
    }

    /// Appends an entry; a durable one must fit ([`Self::has_room`]).
    pub fn push(&mut self, durable: Option<(Arc<Record>, Class)>, change: Change, notes: Vec<Note>, effects: Vec<Effect>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let durable = durable.map(|(record, class)| {
            // A control record taken while the normal window has room counts there.
            let class = if class == Class::Control && self.has_room(Class::Normal) { Class::Normal } else { class };
            self.usage(class).records += 1;
            let (unit, retain) = self.unit.unwrap_or((id, false));
            Durable {
                record,
                class,
                stage: Stage::Encoding,
                bytes: 0,
                unit,
                retain,
                counted: true,
                #[cfg(any(test, feature = "test-support"))]
                mark: self.marks.accept(),
            }
        });
        self.entries.push_back(Entry { id, durable, change, notes, effects, unit: Vec::new(), needs: None, held: false, shown: false });
        id
    }

    /// A view-only entry that stands on the entry `needs` (a record accepted before it): if that record cannot be
    /// encoded, this entry goes with it ([`Self::remove_needing`]).
    pub fn push_after(&mut self, needs: u64, change: Change, notes: Vec<Note>, effects: Vec<Effect>) -> u64 {
        let id = self.push(None, change, notes, effects);
        if let Some(entry) = self.get_mut(id) {
            entry.needs = Some(needs);
        }
        id
    }

    fn index(&self, id: u64) -> Option<usize> {
        self.entries.binary_search_by_key(&id, |entry| entry.id).ok()
    }

    /// The entry `id` is not released (durable or failed) yet.
    pub fn contains(&self, id: u64) -> bool {
        self.index(id).is_some()
    }

    pub fn get(&self, id: u64) -> Option<&Entry> {
        self.entries.get(self.index(id)?)
    }

    pub fn last_mut(&mut self) -> Option<&mut Entry> {
        self.entries.back_mut()
    }

    /// The id the next entry pushed gets.
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// The last entry holding a record, if it was pushed at `from` or after.
    pub fn last_durable_mut(&mut self, from: u64) -> Option<&mut Entry> {
        self.entries.iter_mut().rev().take_while(|entry| entry.id >= from).find(|entry| entry.durable.is_some())
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Entry> {
        let index = self.index(id)?;
        self.entries.get_mut(index)
    }

    /// Records an encode result; the bytes now count in the window. `stored`: the record as the log holds it when that
    /// differs from the one accepted, which the log is then handed. `unit`: [`Entry::unit`].
    pub fn encoded(&mut self, id: u64, encoded: EncodedRecord, stored: Option<Record>, unit: Vec<mixdog_protocol::ThreadItem>) {
        let bytes = encoded.bytes();
        let Some(entry) = self.get_mut(id) else {
            return;
        };
        entry.unit = unit;
        let Some(durable) = entry.durable.as_mut() else {
            return;
        };
        if let Some(stored) = stored {
            durable.record = Arc::new(stored);
        }
        durable.bytes = bytes;
        durable.stage = Stage::Encoded(encoded);
        let class = durable.class;
        self.usage(class).bytes += bytes;
    }

    /// The next whole units in accept order, every record of each encoded, at most `room` units (one message of the
    /// durability lane each), stopping at the first unit still encoding, and at the first held record unless this is a
    /// `retry` (a held record goes before every record after it). A unit is handed on whole, however many records it
    /// holds (a whole inherited conversation), so the store writes it as one commit.
    ///
    /// The order invariant: this outbox is the one owner of every record not yet durable, and the log takes records only
    /// from here, in accept order. A record a failed barrier leaves stays at its place ([`Stage::Held`]): released unsaved
    /// (a turn's rows, [`Self::hold`]) or kept unreleased (a retained unit, [`Self::keep`]), never moved to another keeper.
    /// Nothing accepted after it is handed before it is handed again, the store keeps nothing of a failed write
    /// (`durability.rs`), and every batch is a prefix of what is handed, so what the log holds is always the accepted
    /// sequence less what was failed to its waiter, whatever fails, retries, arrives meanwhile or closes; a crash loses what
    /// was not written, never reorders it, and a close whose write fails keeps the session open with everything not written
    /// held (`SessionActor::close_undone`, the close rule).
    pub fn handoff(&mut self, room: usize, retry: bool) -> Vec<HandedUnit> {
        let end = self.handable_end(room, retry);
        let mut out: Vec<HandedUnit> = Vec::new();
        let mut last_unit = None;
        for entry in self.entries.iter_mut().take(end) {
            let Some(durable) = entry.durable.as_mut() else {
                continue;
            };
            if !matches!(durable.stage, Stage::Encoded(_) | Stage::Held(_)) {
                continue;
            }
            let (Stage::Encoded(encoded) | Stage::Held(encoded)) = std::mem::replace(&mut durable.stage, Stage::Encoding) else {
                unreachable!("matched Encoded or Held");
            };
            durable.stage = Stage::Handed(encoded.clone());
            if last_unit != Some(durable.unit) {
                out.push(HandedUnit { records: Vec::new() });
                last_unit = Some(durable.unit);
            }
            out.last_mut().expect("pushed").records.push((entry.id, CommitRecord { record: durable.record.clone(), encoded }, durable.bytes));
        }
        out
    }

    /// The units that can go: the entries up to the returned index (exclusive) whose records are all encoded.
    fn handable_end(&self, room: usize, retry: bool) -> usize {
        let mut end = 0;
        let mut units = 0;
        let mut current: Option<u64> = None;
        let mut index = 0;
        while index < self.entries.len() {
            let Some(durable) = &self.entries[index].durable else {
                // A run's own draft step still to start: what follows it waits for it (`Effect::Draft` with its ack, as
                // `SessionActor::draft_fenced` holds it once queued); the units before it are whole. A committed-row marker
                // (no ack) keeps its place among the draft writes but holds back no record.
                if self.entries[index].effects.iter().any(|effect| matches!(effect, Effect::Draft(_, Some(_)))) {
                    end = index;
                    current = None;
                    break;
                }
                index += 1;
                continue;
            };
            match &durable.stage {
                Stage::Handed(_) | Stage::Acked(_) => {
                    index += 1;
                    continue;
                }
                Stage::Encoding => break,
                Stage::Held(_) if !retry => break,
                Stage::Encoded(_) | Stage::Held(_) => {}
            }
            if current != Some(durable.unit) {
                // The unit before this one is whole.
                end = index;
                if units == room {
                    current = None;
                    break;
                }
                units += 1;
                current = Some(durable.unit);
            }
            index += 1;
        }
        // Reached the end with a unit whose records are all encoded (a unit never grows after its step).
        if current.is_some() && index == self.entries.len() {
            end = index;
        }
        end
    }

    pub fn acked(&mut self, id: u64, ordinal: u64) {
        let Some(entry) = self.get_mut(id) else {
            return;
        };
        let Some(durable) = entry.durable.as_mut() else {
            return;
        };
        durable.stage = Stage::Acked(ordinal);
        #[cfg(any(test, feature = "test-support"))]
        let mark = durable.mark;
        let (class, bytes, counted) = (durable.class, durable.bytes, std::mem::replace(&mut durable.counted, false));
        #[cfg(any(test, feature = "test-support"))]
        self.marks.written(mark);
        if counted {
            let usage = self.usage(class);
            usage.records -= 1;
            usage.bytes -= bytes;
        }
    }

    /// Removes the entries of the unit `id` belongs to, none of them handed off yet (one of its records could not be
    /// encoded): a unit is written whole or not at all.
    pub fn remove_unit(&mut self, id: u64) -> Vec<Entry> {
        let Some(unit) = self.index(id).and_then(|index| self.entries[index].durable.as_ref()).map(|durable| durable.unit) else {
            return self.remove(id).into_iter().collect();
        };
        let ids: Vec<u64> =
            self.entries.iter().filter(|entry| entry.durable.as_ref().is_some_and(|durable| durable.unit == unit)).map(|entry| entry.id).collect();
        ids.into_iter().filter_map(|id| self.remove(id)).collect()
    }

    /// The next step of the show rule (the module doc), if one can be taken now.
    ///
    /// Settling first: an acked front entry settles, held or shown or neither; else the first entry whose effects have not
    /// run (the held ones before it ran theirs at the failure) settles once it is view-only or acked. Then showing: the
    /// first entry neither shown nor held is shown once it exists in its final form (view-only, or every record of its unit
    /// encoded) and no failure would withdraw it or its unit ([`withdrawn_on_failure`]).
    pub fn pop_ready(&mut self) -> Option<Ready> {
        let front = self.entries.front()?;
        if let Some(Durable { stage: Stage::Acked(ordinal), .. }) = &front.durable
            && !self.paired_waits(front.id)
        {
            let ordinal = Some(*ordinal);
            let entry = self.entries.pop_front()?;
            self.unpaired(entry.id);
            return Some(if entry.held || entry.shown { Ready::Settle(entry, ordinal) } else { Ready::Release(entry, ordinal) });
        }
        if let Some(index) = self.entries.iter().position(|entry| !entry.held)
            && !self.paired_waits(self.entries[index].id)
        {
            let settles = match &self.entries[index].durable {
                None => Some(None),
                Some(Durable { stage: Stage::Acked(ordinal), .. }) => Some(Some(*ordinal)),
                Some(_) => None,
            };
            if let Some(ordinal) = settles {
                let entry = self.entries.remove(index)?;
                self.unpaired(entry.id);
                return Some(if entry.shown { Ready::Settle(entry, ordinal) } else { Ready::Release(entry, ordinal) });
            }
        }
        let index = self.entries.iter().position(|entry| !entry.held && !entry.shown)?;
        if !self.showable(index) || self.paired_waits(self.entries[index].id) {
            return None;
        }
        let id = self.entries[index].id;
        self.unpaired(id);
        let entry = &mut self.entries[index];
        entry.shown = true;
        Some(Ready::Show(Entry {
            id: entry.id,
            durable: None,
            change: entry.change.clone(),
            notes: std::mem::take(&mut entry.notes),
            effects: Vec::new(),
            unit: Vec::new(),
            needs: None,
            held: false,
            shown: false,
        }))
    }

    /// The entry [`Self::pop_ready`] gives next, when it is a turn's terminal record, stored. An entry's id is never
    /// given to another, so what was noted of one terminal record is never read as noted of a later one.
    pub fn closes_turn_next(&self) -> Option<u64> {
        let acked = |entry: &Entry| matches!(entry.durable, Some(Durable { stage: Stage::Acked(_), .. }));
        let next = match self.entries.front() {
            Some(front) if acked(front) => Some(front),
            _ => self.entries.iter().find(|entry| !entry.held).filter(|entry| acked(entry)),
        };
        next.filter(|entry| closes_turn(entry)).map(|entry| entry.id)
    }

    /// The entry at `index` exists in its final form and no failure would withdraw it: it is view-only, or every record of its
    /// unit is encoded (its rows are known) and none of them is withdrawn on failure (a unit is written, failed or held whole).
    fn showable(&self, index: usize) -> bool {
        let entry = &self.entries[index];
        // A turn's terminal record is shown once it is stored (or held by a failed barrier): the turn is told ended
        // only after its last output and its end, stored before it, went out as the log holds them. A compaction that
        // shows a divider likewise: what is released after it (the runtime leaving `compacting`) follows the divider.
        let divides =
            matches!(&entry.change, Change::Record { record, .. } if matches!(&**record, Record::Compacted(compacted) if compacted.silent != Some(true)));
        if closes_turn(entry) || divides {
            return false;
        }
        let Some(unit) = entry.durable.as_ref().map(|durable| durable.unit) else {
            return !withdrawn_on_failure(entry);
        };
        self.entries
            .iter()
            .filter(|other| other.durable.as_ref().is_some_and(|durable| durable.unit == unit))
            .all(|other| !withdrawn_on_failure(other) && !matches!(other.durable, Some(Durable { stage: Stage::Encoding, .. })))
    }

    /// A barrier failed: every unreleased entry fails with it (RL §6.1).
    pub fn fail_all(&mut self) -> Vec<Entry> {
        self.paired = None;
        self.normal = Usage::default();
        self.reserve = Usage::default();
        self.entries.drain(..).collect()
    }

    /// Removes one entry whose record could not be encoded (it was never handed off).
    pub fn remove(&mut self, id: u64) -> Option<Entry> {
        let index = self.index(id)?;
        let entry = self.entries.remove(index)?;
        if let Some(durable) = &entry.durable
            && durable.counted
        {
            let (class, bytes) = (durable.class, durable.bytes);
            let usage = self.usage(class);
            usage.records -= 1;
            usage.bytes -= bytes;
        }
        Some(entry)
    }

    /// Removes the view-only entries standing on `id`, which could not be encoded.
    pub fn remove_needing(&mut self, id: u64) -> Vec<Entry> {
        let (gone, kept): (Vec<_>, Vec<_>) = self.entries.drain(..).partition(|entry| entry.needs == Some(id));
        self.entries = kept.into();
        gone
    }

    /// What the attempted batch holds, for the diagnostic log: its units and each record's kind, in accept order
    /// (never a body).
    pub fn batch_summary(&self, entries: &[u64]) -> (Vec<u64>, Vec<&'static str>) {
        let mut units: Vec<u64> = Vec::new();
        let mut kinds = Vec::new();
        for durable in entries.iter().filter_map(|&id| self.get(id)?.durable.as_ref()) {
            if units.last() != Some(&durable.unit) {
                units.push(durable.unit);
            }
            kinds.push(record_kind(&durable.record));
        }
        (units, kinds)
    }

    /// The records not yet stored, in accept order.
    pub fn unsaved_records(&self) -> impl Iterator<Item = &Arc<Record>> {
        self.entries
            .iter()
            .filter_map(|entry| entry.durable.as_ref())
            .filter(|durable| !matches!(durable.stage, Stage::Acked(_)))
            .map(|durable| &durable.record)
    }

    /// The records accepted and not yet released, stored or not, in accept order.
    pub fn records(&self) -> impl Iterator<Item = &Record> {
        self.entries.iter().filter_map(|entry| entry.durable.as_ref().map(|durable| &*durable.record))
    }

    /// The run `rid`'s draft steps still waiting for their turn are covered by a whole write of its draft that goes now (a
    /// redaction): they write nothing, so no clear value lands after it; their waiters are told when they would have been.
    pub fn drop_drafts(&mut self, rid: &str) {
        use super::turn_draft::DraftWrite;
        for entry in &mut self.entries {
            entry.effects = std::mem::take(&mut entry.effects)
                .into_iter()
                .filter_map(|effect| match effect {
                    Effect::Draft(DraftWrite::Append { rid: run, .. } | DraftWrite::Replace { rid: run, .. }, ack) if run == rid => ack.map(Effect::ItemAck),
                    effect => Some(effect),
                })
                .collect();
        }
    }

    /// The changes not yet in the acked state, in accept order (a held or shown entry's is there already).
    pub fn changes(&self) -> impl Iterator<Item = &Change> {
        self.entries.iter().filter(|entry| !entry.held && !entry.shown).map(|entry| &entry.change)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_store::schema::record::RunRecord;

    fn terminal(outbox: &mut Outbox, turn: &str, ordinal: u64) -> u64 {
        let record = Arc::new(Record::Run(RunRecord {
            rid: mixdog_store::schema::bounded::Text::try_from(turn).expect("a short id"),
            phase: RunPhase::Completed,
            attribution: None,
            attempt: None,
            end: None,
            at: None,
            op: None,
            detail: None,
        }));
        let change = Change::Record { record: record.clone(), display: super::super::state::Display::None };
        let id = outbox.push(Some((record, Class::Normal)), change, Vec::new(), Vec::new());
        outbox.acked(id, ordinal);
        id
    }

    /// A stored terminal record withdrawn by a failure leaves nothing noted of it for the next turn's: the next one is
    /// named as a record of its own, so its close is marked on the line anew.
    #[test]
    fn a_withdrawn_terminal_record_is_not_the_next_turns() {
        let mut outbox = Outbox::new(SessionLimits::default());
        assert_eq!(outbox.closes_turn_next(), None);
        let first = terminal(&mut outbox, "t1", 4);
        assert_eq!(outbox.closes_turn_next(), Some(first));
        assert_eq!(outbox.fail_all().len(), 1);
        assert_eq!(outbox.closes_turn_next(), None, "the withdrawn record closes nothing");
        let second = terminal(&mut outbox, "t2", 4);
        assert_eq!(outbox.closes_turn_next(), Some(second));
        assert_ne!(first, second, "what was marked for the first is not marked for the second");
        outbox.fail_all();
    }
}

/// The actor ended (a shutdown, an unwind) with records it accepted not yet acked: they are not committed by anyone now.
/// A clean unload ends only once the outbox is empty, so this fails nothing then.
#[cfg(any(test, feature = "test-support"))]
impl Drop for Outbox {
    fn drop(&mut self) {
        self.marks.abandon("the thread ended before the record was committed");
    }
}
