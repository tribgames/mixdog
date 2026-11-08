//! The migration journal (FORMAT.md §10.5): `migration/journal.000000`, frames from
//! ordinal 0, payloads `JournalRecord`. Created whole by `publish_file` with its `plan`
//! frame, then appended one synced frame per transition (the append barrier). Reopening
//! drops a torn tail (an append that was never acknowledged) and refuses damage.

// The migration is a sanctioned blocking-I/O home (RL §13): it runs once, before the
// runtime, on its own thread.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "one-time migration: the journal's append handle and torn-tail truncation on the migration thread"
)]

use std::collections::BTreeMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::frame::ScanEnd;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::JournalRecord;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::Phase;
use mixdog_store::schema::migration::PlanEntry;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::StagedEntry;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::frame;

/// What the journal says about one item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemProgress {
    pub state: ItemState,
    pub staged: Option<StagedEntry>,
    /// Set once the item was journaled `verified`.
    pub digest: Option<Option<Digest>>,
    /// Set once the item was journaled `quarantined`.
    pub quarantined: Option<QuarantineCode>,
}

impl ItemProgress {
    fn planned() -> Self {
        Self {
            state: ItemState::Planned,
            staged: None,
            digest: None,
            quarantined: None,
        }
    }
}

pub struct Journal {
    path: PathBuf,
    file: File,
    next_ordinal: u64,
    items: BTreeMap<String, ItemProgress>,
    verified_all: bool,
}

fn key_of(record: &JournalRecord) -> Option<&str> {
    match record {
        JournalRecord::Plan(_) | JournalRecord::Phase(_) => None,
        JournalRecord::Staged(e) => Some(e.key.as_str()),
        JournalRecord::Published(e) | JournalRecord::Disposed(e) => Some(e.key.as_str()),
        JournalRecord::Verified(e) => Some(e.key.as_str()),
        JournalRecord::Quarantined(e) => Some(e.key.as_str()),
    }
}

fn target_state(record: &JournalRecord) -> Option<ItemState> {
    Some(match record {
        JournalRecord::Plan(_) | JournalRecord::Phase(_) => return None,
        JournalRecord::Staged(_) => ItemState::Staged,
        JournalRecord::Published(_) => ItemState::Published,
        JournalRecord::Verified(_) => ItemState::Verified,
        JournalRecord::Quarantined(_) => ItemState::Quarantined,
        JournalRecord::Disposed(_) => ItemState::Disposed,
    })
}

fn payload(record: &JournalRecord) -> Vec<u8> {
    serde_json::to_vec(record).expect("journal records always encode")
}

impl Journal {
    /// Creates the journal with its `plan` frame (whole file through `publish_file`).
    pub fn create(path: &Path, plan: PlanEntry, manifest: &Manifest) -> Result<Self> {
        let record = JournalRecord::Plan(plan);
        durable::publish_file(path, &frame::encode(0, &payload(&record)))?;
        Self::open(path, manifest)?
            .ok_or_else(|| Blocked::journal("journal vanished after creation"))
    }

    /// Replays an existing journal against its manifest; `None` when there is none.
    pub fn open(path: &Path, manifest: &Manifest) -> Result<Option<Self>> {
        let Some(bytes) = durable::read_optional(path)? else {
            return Ok(None);
        };
        let (frames, end) = frame::scan(&bytes, 0);
        match end {
            ScanEnd::Clean => {}
            ScanEnd::Torn { offset } => {
                durable::step(durable::Step::Truncate, path, &[]);
                let file = OpenOptions::new()
                    .write(true)
                    .open(path)
                    .map_err(|e| Blocked::io("open", path, e))?;
                file.set_len(offset)
                    .map_err(|e| Blocked::io("truncate", path, e))?;
                file.sync_all().map_err(|e| Blocked::io("sync", path, e))?;
            }
            ScanEnd::Corrupt { offset, cause, .. } => {
                return Err(Blocked::journal(format!(
                    "journal damaged at byte {offset} ({cause:?})"
                )));
            }
        }
        let mut journal = Self {
            path: path.to_path_buf(),
            file: OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(|e| Blocked::io("open", path, e))?,
            next_ordinal: 0,
            items: manifest
                .items
                .iter()
                .map(|i| (i.key.as_str().to_string(), ItemProgress::planned()))
                .collect(),
            verified_all: false,
        };
        for committed in &frames {
            let record: JournalRecord = serde_json::from_slice(&bytes[committed.payload.clone()])
                .map_err(|e| Blocked::journal(format!("journal frame {}: {e}", committed.ordinal)))?;
            if committed.ordinal == 0 {
                match &record {
                    JournalRecord::Plan(plan) if plan.items == manifest.items.len() as u64 => {}
                    _ => return Err(Blocked::journal("journal does not start with the manifest's plan")),
                }
            } else {
                journal.apply(&record)?;
            }
            journal.next_ordinal = committed.ordinal + 1;
        }
        if journal.next_ordinal == 0 {
            return Err(Blocked::journal("journal holds no plan frame"));
        }
        Ok(Some(journal))
    }

    /// The `plan` frame's manifest digest.
    pub fn plan_of(path: &Path) -> Result<Option<String>> {
        let Some(bytes) = durable::read_optional(path)? else {
            return Ok(None);
        };
        let (frames, _) = frame::scan(&bytes, 0);
        let Some(first) = frames.first() else {
            return Err(Blocked::journal("journal holds no plan frame"));
        };
        match serde_json::from_slice(&bytes[first.payload.clone()]) {
            Ok(JournalRecord::Plan(plan)) => Ok(Some(plan.manifest_sha256.as_str().to_string())),
            _ => Err(Blocked::journal("journal does not start with a plan")),
        }
    }

    fn apply(&mut self, record: &JournalRecord) -> Result<()> {
        if let JournalRecord::Phase(phase) = record {
            match phase.phase {
                Phase::VerifiedAll => {
                    if let Some((key, _)) = self.items.iter().find(|(_, p)| {
                        !matches!(p.state, ItemState::Verified | ItemState::Quarantined)
                    }) {
                        return Err(Blocked::journal(format!("verified_all before {key}")));
                    }
                    self.verified_all = true;
                }
            }
            return Ok(());
        }
        let (Some(key), Some(to)) = (key_of(record), target_state(record)) else {
            return Err(Blocked::journal("a second plan frame"));
        };
        let progress = self
            .items
            .get_mut(key)
            .ok_or_else(|| Blocked::journal(format!("journal names unknown item {key}")))?;
        if !progress.state.can_advance(to) {
            return Err(Blocked::journal(format!(
                "{key}: {:?} → {to:?} is not a transition",
                progress.state
            )));
        }
        progress.state = to;
        match record {
            JournalRecord::Staged(e) => progress.staged = Some(e.clone()),
            JournalRecord::Verified(e) => progress.digest = Some(e.digest.clone()),
            JournalRecord::Quarantined(e) => progress.quarantined = Some(e.code),
            _ => {}
        }
        Ok(())
    }

    /// Validates, writes and syncs one frame, then applies it.
    pub fn append(&mut self, record: JournalRecord) -> Result<()> {
        match (key_of(&record), target_state(&record)) {
            (Some(key), Some(to)) => {
                let from = self
                    .items
                    .get(key)
                    .ok_or_else(|| Blocked::journal(format!("unknown item {key}")))?
                    .state;
                if !from.can_advance(to) {
                    return Err(Blocked::journal(format!(
                        "{key}: {from:?} → {to:?} is not a transition"
                    )));
                }
            }
            _ => {
                if let Some((key, _)) = self.items.iter().find(|(_, p)| {
                    !matches!(p.state, ItemState::Verified | ItemState::Quarantined)
                }) {
                    return Err(Blocked::journal(format!("verified_all before {key}")));
                }
            }
        }
        let bytes = frame::encode(self.next_ordinal, &payload(&record));
        let (first, second) = bytes.split_at(bytes.len() / 2);
        self.file
            .write_all(first)
            .map_err(|e| Blocked::io("append", &self.path, e))?;
        durable::step(durable::Step::Append, &self.path, &bytes);
        self.file
            .write_all(second)
            .map_err(|e| Blocked::io("append", &self.path, e))?;
        self.file
            .sync_data()
            .map_err(|e| Blocked::io("sync", &self.path, e))?;
        self.next_ordinal += 1;
        self.apply(&record)
    }

    pub fn progress(&self, key: &str) -> Option<&ItemProgress> {
        self.items.get(key)
    }

    pub fn verified_all(&self) -> bool {
        self.verified_all
    }

    /// The ordinal the next frame gets (= frames written).
    pub fn next_ordinal(&self) -> u64 {
        self.next_ordinal
    }
}
