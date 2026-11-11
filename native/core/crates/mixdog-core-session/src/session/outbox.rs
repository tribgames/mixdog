//! The actor's ordered outbox: every accepted change in accept order. A durable entry is
//! encoded on cpu-interactive (completions arrive in any order), handed to the
//! `DurabilityTask` strictly in order (the reorder buffer, RL §5.6), and released — applied to
//! the acked state, published, its replies sent — only when it and every entry before it are
//! acked. View-only entries (sections, deltas) are released in the same order, so the feed
//! never shows an event before one it follows.

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

pub(crate) enum Stage {
    Encoding,
    Encoded(EncodedRecord),
    /// Handed to the durability task; the encoding is kept for a retry should its barrier fail.
    Handed(EncodedRecord),
    /// Its barrier failed and it was released unsaved ([`Entry::held`]): handed again only by a retry.
    Held(EncodedRecord),
    Acked(u64),
}

pub(crate) struct Durable {
    pub record: Arc<Record>,
    pub class: Class,
    pub stage: Stage,
    pub bytes: usize,
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
    RecomputePrompts { publish: bool },
    /// A failed turn's end is released: its quota settlement begins (`beginQuotaSettlement`), then the Goal
    /// settles with `settle` (`onGoalTurnSettled`'s detail).
    TurnClosed { turn: TurnId, settle: Value },
    /// Told once the frames of the pump that released this entry are published: the caller sees its change as a client does.
    /// An entry whose record failed to be stored is told that failure instead; its change is never shown.
    AfterPublish(oneshot::Sender<Result<(), CoreError>>),
}

pub(crate) struct Entry {
    pub id: u64,
    pub durable: Option<Durable>,
    pub change: Change,
    /// Notes known at accept or encode time; release adds the ones derived from acked state.
    pub notes: Vec<Note>,
    pub effects: Vec<Effect>,
    /// The entry this view-only one stands on: it is dropped with that entry when the record fails to encode.
    pub needs: Option<u64>,
    /// Released before it was durable (its barrier failed, [`Outbox::hold`]): its change is in the acked state and its
    /// effects ran; it stays only to be written, in order, by a retry.
    pub held: bool,
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
}

impl Outbox {
    pub fn new(limits: SessionLimits) -> Self {
        Self {
            entries: VecDeque::new(),
            next_id: 1,
            limits,
            normal: Usage::default(),
            reserve: Usage::default(),
        }
    }

    /// A record of `class` fits the window now.
    pub fn has_room(&self, class: Class) -> bool {
        let normal = self.normal.records < self.limits.window_records
            && self.normal.bytes < self.limits.window_bytes;
        match class {
            Class::Normal => normal,
            Class::Control => {
                normal
                    || (self.reserve.records < self.limits.reserve_records
                        && self.reserve.bytes < self.limits.reserve_bytes)
            }
        }
    }

    /// Producers (runs, sections) are read only while the normal window and the release
    /// backlog have room; otherwise their lane fills and they wait (RL §6.2).
    /// Every accepted record is released (durable or failed).
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Held entries are released already: they count in neither the window nor the backlog.
    pub fn producer_room(&self) -> bool {
        self.entries.iter().filter(|entry| !entry.held).count() < self.limits.outbox_entries && self.has_room(Class::Normal)
    }

    /// Some entry was released unsaved and is not durable yet.
    pub fn has_unsaved(&self) -> bool {
        self.entries.iter().any(|entry| entry.held)
    }

    /// Some held entry waits for a retry (none of them is handed).
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
        self.entries
            .iter()
            .filter(|entry| matches!(entry.durable, Some(Durable { stage: Stage::Handed(_), .. })))
            .map(|entry| entry.id)
            .collect()
    }

    /// The handed entry `id` failed its barrier: it waits for a retry, out of the window. The first time, it is
    /// released unsaved: its change, notes and effects are returned for the caller to apply.
    pub fn hold(&mut self, id: u64) -> Option<(Change, Vec<Note>, Vec<Effect>)> {
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
        let (class, bytes) = (durable.class, durable.bytes);
        let released = (entry.change.clone(), std::mem::take(&mut entry.notes), std::mem::take(&mut entry.effects));
        let usage = self.usage(class);
        usage.records -= 1;
        usage.bytes -= bytes;
        Some(released)
    }

    fn usage(&mut self, class: Class) -> &mut Usage {
        match class {
            Class::Normal => &mut self.normal,
            Class::Control => &mut self.reserve,
        }
    }

    /// Appends an entry; a durable one must fit ([`Self::has_room`]).
    pub fn push(
        &mut self,
        durable: Option<(Arc<Record>, Class)>,
        change: Change,
        notes: Vec<Note>,
        effects: Vec<Effect>,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let durable = durable.map(|(record, class)| {
            // A control record taken while the normal window has room counts there.
            let class = if class == Class::Control && self.has_room(Class::Normal) {
                Class::Normal
            } else {
                class
            };
            self.usage(class).records += 1;
            Durable {
                record,
                class,
                stage: Stage::Encoding,
                bytes: 0,
            }
        });
        self.entries.push_back(Entry {
            id,
            durable,
            change,
            notes,
            effects,
            needs: None,
            held: false,
        });
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

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Entry> {
        let index = self.index(id)?;
        self.entries.get_mut(index)
    }

    /// Records an encode result; the bytes now count in the window.
    pub fn encoded(&mut self, id: u64, encoded: EncodedRecord) {
        let bytes = encoded.bytes();
        let Some(entry) = self.get_mut(id) else {
            return;
        };
        let Some(durable) = entry.durable.as_mut() else {
            return;
        };
        durable.bytes = bytes;
        durable.stage = Stage::Encoded(encoded);
        let class = durable.class;
        self.usage(class).bytes += bytes;
    }

    /// The next encoded records in accept order, stopping at the first still encoding, and at the first held one
    /// unless this is a `retry` (a held record goes before every record after it).
    pub fn handoff(&mut self, retry: bool) -> Vec<(u64, CommitRecord, usize)> {
        let mut out = Vec::new();
        for entry in &mut self.entries {
            let Some(durable) = entry.durable.as_mut() else {
                continue;
            };
            match &durable.stage {
                Stage::Encoding => break,
                Stage::Held(_) if !retry => break,
                Stage::Encoded(_) | Stage::Held(_) => {
                    let (Stage::Encoded(encoded) | Stage::Held(encoded)) = std::mem::replace(&mut durable.stage, Stage::Encoding) else {
                        unreachable!("matched Encoded or Held");
                    };
                    durable.stage = Stage::Handed(encoded.clone());
                    out.push((
                        entry.id,
                        CommitRecord {
                            record: durable.record.clone(),
                            encoded,
                        },
                        durable.bytes,
                    ));
                }
                Stage::Handed(_) | Stage::Acked(_) => {}
            }
        }
        out
    }

    pub fn acked(&mut self, id: u64, ordinal: u64) {
        let Some(entry) = self.get_mut(id) else {
            return;
        };
        let held = entry.held;
        let Some(durable) = entry.durable.as_mut() else {
            return;
        };
        durable.stage = Stage::Acked(ordinal);
        if held {
            return;
        }
        let (class, bytes) = (durable.class, durable.bytes);
        let usage = self.usage(class);
        usage.records -= 1;
        usage.bytes -= bytes;
    }

    /// The front entry if it can be released: view-only, or acked. Behind entries released unsaved and not yet
    /// durable, the first other entry is released when it is view-only: it shows after them, as it was accepted.
    pub fn pop_ready(&mut self) -> Option<(Entry, Option<u64>)> {
        let ordinal = match &self.entries.front()?.durable {
            None => None,
            Some(Durable {
                stage: Stage::Acked(ordinal),
                ..
            }) => Some(*ordinal),
            Some(_) if self.entries[0].held => {
                let index = self.entries.iter().position(|entry| !entry.held)?;
                if self.entries[index].durable.is_some() {
                    return None;
                }
                return self.entries.remove(index).map(|entry| (entry, None));
            }
            Some(_) => return None,
        };
        self.entries.pop_front().map(|entry| (entry, ordinal))
    }

    /// A barrier failed: every unreleased entry fails with it (RL §6.1).
    pub fn fail_all(&mut self) -> Vec<Entry> {
        self.normal = Usage::default();
        self.reserve = Usage::default();
        self.entries.drain(..).collect()
    }

    /// Removes one entry whose record could not be encoded (it was never handed off).
    pub fn remove(&mut self, id: u64) -> Option<Entry> {
        let index = self.index(id)?;
        let entry = self.entries.remove(index)?;
        if let Some(durable) = &entry.durable {
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

    /// The records not yet stored, in accept order.
    pub fn unsaved_records(&self) -> impl Iterator<Item = &Arc<Record>> {
        self.entries.iter().filter_map(|entry| entry.durable.as_ref()).filter(|durable| !matches!(durable.stage, Stage::Acked(_))).map(|durable| &durable.record)
    }

    /// The unreleased changes in accept order (a held entry's is released).
    pub fn changes(&self) -> impl Iterator<Item = &Change> {
        self.entries.iter().filter(|entry| !entry.held).map(|entry| &entry.change)
    }
}
