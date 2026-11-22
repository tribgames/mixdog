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

use mixdog_store::fsio;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::frame::ScanEnd;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::JournalRecord;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::Phase;
use mixdog_store::schema::migration::PlanEntry;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::StagedEntry;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::frame;

/// What the journal says about one item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemProgress {
    pub state: ItemState,
    /// The source files journaled for an item the manifest lists without them.
    pub sources: Option<Vec<SourceFile>>,
    pub staged: Option<StagedEntry>,
    /// Set once the item was journaled `verified`.
    pub digest: Option<Option<Digest>>,
    /// Set once the item was journaled `quarantined`.
    pub quarantined: Option<QuarantineCode>,
    /// Set once the item was journaled `expired`: the time it was judged at, epoch milliseconds.
    pub expired: Option<u64>,
}

impl ItemProgress {
    fn planned() -> Self {
        Self { state: ItemState::Planned, sources: None, staged: None, digest: None, quarantined: None, expired: None }
    }
}

pub struct Journal {
    path: PathBuf,
    file: File,
    next_ordinal: u64,
    items: BTreeMap<String, ItemProgress>,
    verified_all: bool,
    /// The time of the first `expired` frame.
    judged_at: Option<u64>,
    /// The time of the `judged` phase: the judgement is closed.
    judged: Option<u64>,
    /// Why an append failed; every later append is refused.
    failed: Option<String>,
}

fn key_of(record: &JournalRecord) -> Option<&str> {
    match record {
        JournalRecord::Plan(_) | JournalRecord::Phase(_) => None,
        JournalRecord::Sources(e) => Some(e.key.as_str()),
        JournalRecord::Staged(e) => Some(e.key.as_str()),
        JournalRecord::Published(e) | JournalRecord::Disposed(e) => Some(e.key.as_str()),
        JournalRecord::Verified(e) => Some(e.key.as_str()),
        JournalRecord::Quarantined(e) => Some(e.key.as_str()),
        JournalRecord::Expired(e) => Some(e.key.as_str()),
    }
}

fn target_state(record: &JournalRecord) -> Option<ItemState> {
    Some(match record {
        JournalRecord::Plan(_) | JournalRecord::Phase(_) | JournalRecord::Sources(_) => return None,
        JournalRecord::Staged(_) => ItemState::Staged,
        JournalRecord::Published(_) => ItemState::Published,
        JournalRecord::Verified(_) => ItemState::Verified,
        JournalRecord::Quarantined(_) => ItemState::Quarantined,
        JournalRecord::Expired(_) => ItemState::Expired,
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
        Self::open(path, manifest)?.ok_or_else(|| Blocked::journal("journal vanished after creation"))
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
                let file = OpenOptions::new().write(true).open(path).map_err(|e| Blocked::io("open", path, e))?;
                file.set_len(offset).map_err(|e| Blocked::io("truncate", path, e))?;
                fsio::flush(&file).map_err(|e| Blocked::io("sync", path, e))?;
            }
            ScanEnd::Corrupt { offset, cause, .. } => {
                return Err(Blocked::journal(format!("journal damaged at byte {offset} ({cause:?})")));
            }
        }
        let mut journal = Self {
            path: path.to_path_buf(),
            file: OpenOptions::new().append(true).open(path).map_err(|e| Blocked::io("open", path, e))?,
            next_ordinal: 0,
            items: manifest.items.iter().map(|i| (i.key.as_str().to_string(), ItemProgress::planned())).collect(),
            verified_all: false,
            judged_at: None,
            judged: None,
            failed: None,
        };
        for committed in &frames {
            let record: JournalRecord =
                serde_json::from_slice(&bytes[committed.payload.clone()]).map_err(|e| Blocked::journal(format!("journal frame {}: {e}", committed.ordinal)))?;
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
                    if let Some((key, _)) =
                        self.items.iter().find(|(_, p)| !matches!(p.state, ItemState::Verified | ItemState::Quarantined | ItemState::Expired))
                    {
                        return Err(Blocked::journal(format!("verified_all before {key}")));
                    }
                    self.verified_all = true;
                }
                Phase::Judged => {
                    let at = phase.at.ok_or_else(|| Blocked::journal("a judged phase without its time"))?;
                    if self.judged.replace(at).is_some() {
                        return Err(Blocked::journal("a second judged phase"));
                    }
                }
            }
            return Ok(());
        }
        if let JournalRecord::Sources(entry) = record {
            self.takes_sources(entry.key.as_str())?;
            self.items.get_mut(entry.key.as_str()).expect("checked").sources = Some(entry.sources.clone());
            return Ok(());
        }
        let (Some(key), Some(to)) = (key_of(record), target_state(record)) else {
            return Err(Blocked::journal("a second plan frame"));
        };
        let progress = self.items.get_mut(key).ok_or_else(|| Blocked::journal(format!("journal names unknown item {key}")))?;
        if !progress.state.can_advance(to) {
            return Err(Blocked::journal(format!("{key}: {:?} → {to:?} is not a transition", progress.state)));
        }
        if to == ItemState::Expired && self.judged.is_some() {
            return Err(Blocked::journal(format!("{key}: expired after the judgement was closed")));
        }
        progress.state = to;
        match record {
            JournalRecord::Staged(e) => progress.staged = Some(e.clone()),
            JournalRecord::Verified(e) => progress.digest = Some(e.digest.clone()),
            JournalRecord::Quarantined(e) => progress.quarantined = Some(e.code),
            JournalRecord::Expired(e) => {
                progress.expired = Some(e.judged_at);
                self.judged_at.get_or_insert(e.judged_at);
            }
            _ => {}
        }
        Ok(())
    }

    /// An item's sources are journaled once, while nothing of it is staged: everything after reads them.
    fn takes_sources(&self, key: &str) -> Result<()> {
        let progress = self.items.get(key).ok_or_else(|| Blocked::journal(format!("journal names unknown item {key}")))?;
        if progress.state != ItemState::Planned || progress.sources.is_some() {
            return Err(Blocked::journal(format!("{key}: sources journaled twice or after {:?}", progress.state)));
        }
        Ok(())
    }

    /// Validates, writes and syncs one frame, then applies it.
    pub fn append(&mut self, record: JournalRecord) -> Result<()> {
        match (key_of(&record), target_state(&record)) {
            (Some(key), None) => self.takes_sources(key)?,
            (Some(key), Some(to)) => {
                let from = self.items.get(key).ok_or_else(|| Blocked::journal(format!("unknown item {key}")))?.state;
                if !from.can_advance(to) {
                    return Err(Blocked::journal(format!("{key}: {from:?} → {to:?} is not a transition")));
                }
                if to == ItemState::Expired && self.judged.is_some() {
                    return Err(Blocked::journal(format!("{key}: expired after the judgement was closed")));
                }
            }
            _ if matches!(&record, JournalRecord::Phase(phase) if phase.phase == Phase::Judged) => {
                if self.judged.is_some() {
                    return Err(Blocked::journal("a second judged phase"));
                }
            }
            _ => {
                if let Some((key, _)) = self.items.iter().find(|(_, p)| !matches!(p.state, ItemState::Verified | ItemState::Quarantined | ItemState::Expired)) {
                    return Err(Blocked::journal(format!("verified_all before {key}")));
                }
            }
        }
        if let Some(failed) = &self.failed {
            return Err(Blocked::journal(format!("an earlier append failed ({failed}); the journal takes no frame until it is reopened")));
        }
        let bytes = frame::encode(self.next_ordinal, &payload(&record));
        if let Err(error) = self.write_frame(&bytes) {
            self.failed = Some(error.to_string());
            return Err(error);
        }
        self.next_ordinal += 1;
        self.apply(&record)
    }

    /// One frame written in two halves and synced. After a failure the file may hold part of it, or all of it unsynced: only
    /// a reopen, which cuts a torn tail and replays what is whole, knows where the next frame goes.
    fn write_frame(&mut self, bytes: &[u8]) -> Result<()> {
        let (first, second) = bytes.split_at(bytes.len() / 2);
        self.file.write_all(first).map_err(|e| Blocked::io("append", &self.path, e))?;
        durable::step(durable::Step::Append, &self.path, bytes);
        self.file.write_all(second).map_err(|e| Blocked::io("append", &self.path, e))?;
        fsio::flush_data(&self.file).map_err(|e| Blocked::io("sync", &self.path, e))
    }

    pub fn progress(&self, key: &str) -> Option<&ItemProgress> {
        self.items.get(key)
    }

    /// The time the first session journaled `expired` was judged at: a judgement cut before its `judged` phase is made
    /// again at it.
    pub fn judged_at(&self) -> Option<u64> {
        self.judged_at
    }

    /// The time of the `judged` phase: the judgement is made, and no session expires after it.
    pub fn judged(&self) -> Option<u64> {
        self.judged
    }

    pub fn verified_all(&self) -> bool {
        self.verified_all
    }

    /// The ordinal the next frame gets (= frames written).
    pub fn next_ordinal(&self) -> u64 {
        self.next_ordinal
    }
}

#[cfg(test)]
mod tests {
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::migration::Contract;
    use mixdog_store::schema::migration::ItemKey;
    use mixdog_store::schema::migration::ItemKind;
    use mixdog_store::schema::migration::KindGroup;
    use mixdog_store::schema::migration::MANIFEST_FORMAT;
    use mixdog_store::schema::migration::QuarantinedEntry;
    use mixdog_store::schema::migration::Roots;

    use super::*;

    /// An item's sources are journaled once and before it is staged; a reopened journal holds them.
    #[test]
    fn sources_are_journaled_once_and_only_while_the_item_is_planned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.000000");
        let item = |key: &str| crate::plan::item(key, KindGroup::Data, ItemKind::Session, Contract::Convert, Vec::new(), None).unwrap();
        let manifest = Manifest {
            format: MANIFEST_FORMAT,
            roots: Roots { data: String::new(), home: String::new(), profile: None },
            items: vec![item("session/a"), item("session/b")],
            shared: Vec::new(),
        };
        let plan = PlanEntry { manifest_sha256: Text::try_from("0".repeat(64).as_str()).unwrap(), items: 2 };
        let mut journal = Journal::create(&path, plan, &manifest).unwrap();
        let file =
            SourceFile { root: mixdog_store::schema::migration::Root::Data, path: "sessions/a.json".into(), size: 1, sha256: "1".repeat(64), secret: false };
        let sources = |key: &str| {
            JournalRecord::Sources(mixdog_store::schema::migration::SourcesEntry { key: ItemKey::try_from(key).unwrap(), sources: vec![file.clone()] })
        };
        journal.append(sources("session/a")).unwrap();
        assert!(journal.append(sources("session/a")).is_err(), "a second record of the same item");
        journal
            .append(JournalRecord::Quarantined(QuarantinedEntry { key: ItemKey::try_from("session/b").unwrap(), code: QuarantineCode::ParseError }))
            .unwrap();
        assert!(journal.append(sources("session/b")).is_err(), "a record after the item left `planned`");
        assert_eq!(journal.next_ordinal(), 3, "a refused record writes no frame");
        drop(journal);

        let reopened = Journal::open(&path, &manifest).unwrap().unwrap();
        let a = reopened.progress("session/a").unwrap();
        assert_eq!((a.state, a.sources.as_deref()), (ItemState::Planned, Some([file.clone()].as_slice())));
        assert_eq!(reopened.progress("session/b").unwrap().sources, None);
    }

    /// A failed append leaves the file's tail unknown: a later append, from this item's worker or another's, is refused
    /// instead of writing a frame after it, and a reopen replays only the whole frames.
    #[test]
    fn after_a_failed_append_the_journal_refuses_every_append_until_reopened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.000000");
        let item = |key: &str| crate::plan::item(key, KindGroup::Data, ItemKind::Session, Contract::Convert, Vec::new(), None).unwrap();
        let manifest = Manifest {
            format: MANIFEST_FORMAT,
            roots: Roots { data: String::new(), home: String::new(), profile: None },
            items: vec![item("session/a"), item("session/b")],
            shared: Vec::new(),
        };
        let plan = PlanEntry { manifest_sha256: Text::try_from("0".repeat(64).as_str()).unwrap(), items: 2 };
        let mut journal = Journal::create(&path, plan, &manifest).unwrap();
        let quarantined = |key: &str| JournalRecord::Quarantined(QuarantinedEntry { key: ItemKey::try_from(key).unwrap(), code: QuarantineCode::ParseError });
        let writable = std::mem::replace(&mut journal.file, std::fs::File::open(&path).unwrap());
        assert!(journal.append(quarantined("session/a")).is_err(), "a read-only handle refuses the write");
        journal.file = writable;
        let refused = journal.append(quarantined("session/b")).unwrap_err();
        assert!(refused.to_string().contains("an earlier append failed"), "{refused}");
        assert_eq!(journal.next_ordinal(), 1);
        drop(journal);

        let mut reopened = Journal::open(&path, &manifest).unwrap().unwrap();
        assert_eq!((reopened.next_ordinal(), reopened.progress("session/b").unwrap().state), (1, ItemState::Planned));
        reopened.append(quarantined("session/b")).unwrap();
        assert_eq!(reopened.progress("session/b").unwrap().state, ItemState::Quarantined);
    }
}
