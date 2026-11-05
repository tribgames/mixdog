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
    Handed,
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
    /// The run's input rows are durable.
    InputDurable,
    ItemAck(oneshot::Sender<Result<(), RunError>>),
    /// Publish the server request (its `requested` record is durable).
    PublishApproval(PendingServerRequest),
    /// The resolution record is durable.
    Resolved(ApprovalId, ApprovalResolution),
    /// A history mutation is durable: recompute the prompt-history session part over the
    /// remaining lineage, and republish the merged list when `publish`.
    RecomputePrompts { publish: bool },
}

pub(crate) struct Entry {
    pub id: u64,
    pub durable: Option<Durable>,
    pub change: Change,
    /// Notes known at accept or encode time; release adds the ones derived from acked state.
    pub notes: Vec<Note>,
    pub effects: Vec<Effect>,
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
    pub fn producer_room(&self) -> bool {
        self.entries.len() < self.limits.outbox_entries && self.has_room(Class::Normal)
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
        });
        id
    }

    fn index(&self, id: u64) -> Option<usize> {
        self.entries.binary_search_by_key(&id, |entry| entry.id).ok()
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

    /// The next encoded records in accept order, stopping at the first still encoding.
    pub fn handoff(&mut self) -> Vec<(u64, CommitRecord, usize)> {
        let mut out = Vec::new();
        for entry in &mut self.entries {
            let Some(durable) = entry.durable.as_mut() else {
                continue;
            };
            match &durable.stage {
                Stage::Encoding => break,
                Stage::Encoded(_) => {
                    let Stage::Encoded(encoded) =
                        std::mem::replace(&mut durable.stage, Stage::Handed)
                    else {
                        unreachable!("matched Encoded");
                    };
                    out.push((
                        entry.id,
                        CommitRecord {
                            record: durable.record.clone(),
                            encoded,
                        },
                        durable.bytes,
                    ));
                }
                Stage::Handed | Stage::Acked(_) => {}
            }
        }
        out
    }

    pub fn acked(&mut self, id: u64, ordinal: u64) {
        let Some(entry) = self.get_mut(id) else {
            return;
        };
        let Some(durable) = entry.durable.as_mut() else {
            return;
        };
        durable.stage = Stage::Acked(ordinal);
        let (class, bytes) = (durable.class, durable.bytes);
        let usage = self.usage(class);
        usage.records -= 1;
        usage.bytes -= bytes;
    }

    /// The front entry if it can be released: view-only, or acked.
    pub fn pop_ready(&mut self) -> Option<(Entry, Option<u64>)> {
        let ordinal = match &self.entries.front()?.durable {
            None => None,
            Some(Durable {
                stage: Stage::Acked(ordinal),
                ..
            }) => Some(*ordinal),
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

    /// The unreleased changes in accept order.
    pub fn changes(&self) -> impl Iterator<Item = &Change> {
        self.entries.iter().map(|entry| &entry.change)
    }
}
