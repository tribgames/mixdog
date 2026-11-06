//! The migration state machine (SM §11.5): plan, convert, verify, dispose, complete —
//! resumed from `manifest.json` + the journal after any crash, deterministic at every
//! step. `Migrator::run` is the whole of `mixdogd`'s `Migrating` state.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_store::schema::migration::COMPLETE_FORMAT;
use mixdog_store::schema::migration::COMPLETE_PATH;
use mixdog_store::schema::migration::Complete;
use mixdog_store::schema::migration::CompleteKinds;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::Counts;
use mixdog_store::schema::migration::ItemKey;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::JOURNAL_PATH;
use mixdog_store::schema::migration::JournalRecord;
use mixdog_store::schema::migration::KeyEntry;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::MANIFEST_PATH;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::Phase;
use mixdog_store::schema::migration::PhaseEntry;
use mixdog_store::schema::migration::PlanEntry;
use mixdog_store::schema::migration::QUARANTINE_DIR;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::QuarantineReason;
use mixdog_store::schema::migration::QuarantinedEntry;
use mixdog_store::schema::migration::QuarantinedSource;
use mixdog_store::schema::migration::REASON_FILE;
use mixdog_store::schema::migration::REASON_FORMAT;
use mixdog_store::schema::migration::STAGE_DIR;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::VerifiedEntry;
use mixdog_store::schema::bounded::Text;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::BlobStatuses;
use crate::framework::FaultHook;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::journal::Journal;
use crate::plan::PlanSink;
use crate::plan::escape_key;

/// `migration/stage/counts.json`: the completion counts between disposal and
/// `complete.json` (internal to a run, removed with the stage).
const COUNTS_FILE: &str = "counts.json";

#[derive(Clone)]
pub struct MigrateOptions {
    /// Session items converted at once (SM §11.5: 4).
    pub workers: usize,
    pub fault: Option<FaultHook>,
}

impl Default for MigrateOptions {
    fn default() -> Self {
        Self {
            workers: 4,
            fault: None,
        }
    }
}

/// Every kind group of the product, in planning order (sessions first: the shared
/// sources and the profile's session metadata name session items).
pub fn product_drivers(
    projector: Arc<dyn crate::index::IndexProjector>,
    office: crate::session::context_blobs::OfficeExtractor,
) -> Vec<Arc<dyn ItemDriver>> {
    let profile = Arc::new(crate::desktop_profile::DesktopProfileDriver::new());
    vec![
        Arc::new(crate::session::SessionDriver::new(vec![profile.clone()], office)),
        Arc::new(crate::stores::StoresDriver),
        Arc::new(crate::ledger::LedgerDriver),
        Arc::new(crate::index::IndexDriver::new(projector)),
        profile,
    ]
}

pub struct Migrator {
    roots: MigrationRoots,
    drivers: Vec<Arc<dyn ItemDriver>>,
    options: MigrateOptions,
}

/// The quarantine folder name of a code (`QuarantineCode`'s serde name).
pub fn code_name(code: QuarantineCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// `<D>/quarantine/<code>/<escaped key>/`.
pub fn quarantine_dir(data: &Path, code: QuarantineCode, key: &str) -> std::path::PathBuf {
    data.join(QUARANTINE_DIR)
        .join(code_name(code))
        .join(escape_key(key))
}

struct Shared<'a> {
    roots: &'a MigrationRoots,
    manifest: &'a Manifest,
    manifest_sha256: &'a str,
    fault: Option<&'a FaultHook>,
    blobs: &'a BlobStatuses,
    journal: &'a Mutex<Journal>,
}

impl Shared<'_> {
    fn cx<'b>(&'b self, states: &'b BTreeMap<String, ItemState>) -> ItemContext<'b> {
        ItemContext {
            roots: self.roots,
            manifest: self.manifest,
            manifest_sha256: self.manifest_sha256,
            fault: self.fault,
            blobs: self.blobs,
            states,
        }
    }

    fn fault(&self, point: &str) -> Result<()> {
        match self.fault {
            Some(hook) => hook(point),
            None => Ok(()),
        }
    }

    fn record(&self, point: &str, record: JournalRecord) -> Result<()> {
        self.fault(&format!("journal:{point}:before"))?;
        self.journal.lock().expect("journal").append(record)?;
        self.fault(&format!("journal:{point}:after"))
    }
}

fn key(item: &ManifestItem) -> ItemKey {
    item.key.clone()
}

impl Migrator {
    pub fn new(
        roots: MigrationRoots,
        drivers: Vec<Arc<dyn ItemDriver>>,
        options: MigrateOptions,
    ) -> Self {
        Self {
            roots,
            drivers,
            options,
        }
    }

    fn driver(&self, item: &ManifestItem) -> Result<&Arc<dyn ItemDriver>> {
        self.drivers
            .iter()
            .find(|d| d.owns(item))
            .ok_or_else(|| Blocked::journal(format!("no driver for {}", item.key.as_str())))
    }

    fn fault(&self, point: &str) -> Result<()> {
        match &self.options.fault {
            Some(hook) => hook(point),
            None => Ok(()),
        }
    }

    /// Runs (or resumes) the migration to its completion marker.
    pub fn run(&self) -> Result<Complete> {
        let data = &self.roots.data;
        if let Some(bytes) = durable::read_optional(&data.join(COMPLETE_PATH))? {
            durable::remove_dir_all(&data.join(STAGE_DIR))?;
            return serde_json::from_slice(&bytes)
                .map_err(|e| Blocked::journal(format!("complete.json: {e}")));
        }
        let (manifest, manifest_sha256, journal) = self.open_or_plan()?;
        let journal = Mutex::new(journal);
        let blobs = BlobStatuses::default();
        let shared = Shared {
            roots: &self.roots,
            manifest: &manifest,
            manifest_sha256: &manifest_sha256,
            fault: self.options.fault.as_ref(),
            blobs: &blobs,
            journal: &journal,
        };
        self.convert(&shared)?;
        if !journal.lock().expect("journal").verified_all() {
            shared.record(
                "verified_all",
                JournalRecord::Phase(PhaseEntry {
                    phase: Phase::VerifiedAll,
                }),
            )?;
        }
        // Counted before disposal (a dangling count may read a source disposal removes),
        // kept in the stage until `complete.json` carries it.
        let counts_path = data.join(STAGE_DIR).join(COUNTS_FILE);
        let kinds: CompleteKinds = match durable::read_optional(&counts_path)? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| Blocked::journal(format!("{COUNTS_FILE}: {e}")))?,
            None => {
                let kinds = self.counts(&shared)?;
                self.fault("counts:before")?;
                durable::publish_file(&counts_path, &serde_json::to_vec(&kinds).expect("counts encode"))?;
                self.fault("counts:after")?;
                kinds
            }
        };
        self.dispose(&shared)?;
        let complete = Complete {
            format: COMPLETE_FORMAT,
            manifest_sha256: manifest_sha256.clone(),
            journal_end_ordinal: journal.lock().expect("journal").next_ordinal(),
            kinds,
        };
        self.fault("complete:before")?;
        durable::publish_file(
            &data.join(COMPLETE_PATH),
            &serde_json::to_vec(&complete).expect("complete encodes"),
        )?;
        self.fault("complete:after")?;
        durable::remove_dir_all(&data.join(STAGE_DIR))?;
        Ok(complete)
    }

    fn open_or_plan(&self) -> Result<(Manifest, String, Journal)> {
        let data = &self.roots.data;
        let manifest_path = data.join(MANIFEST_PATH);
        let journal_path = data.join(JOURNAL_PATH);
        if let Some(sha) = Journal::plan_of(&journal_path)? {
            let bytes = durable::read(&manifest_path)?;
            if durable::sha256_hex(&bytes) != sha {
                return Err(Blocked::journal("manifest.json does not match the journal's plan"));
            }
            let manifest: Manifest = serde_json::from_slice(&bytes)
                .map_err(|e| Blocked::journal(format!("manifest.json: {e}")))?;
            let journal = Journal::open(&journal_path, &manifest)?
                .ok_or_else(|| Blocked::journal("journal vanished"))?;
            return Ok((manifest, sha, journal));
        }
        // Nothing was converted: plan afresh (an earlier manifest is replaced).
        durable::remove_dir_all(&data.join(STAGE_DIR))?;
        let mut sink = PlanSink::new(&self.roots);
        for driver in &self.drivers {
            driver.plan(&self.roots, &mut sink)?;
        }
        let manifest = sink.into_manifest(&self.roots);
        let bytes = serde_json::to_vec(&manifest).expect("manifest encodes");
        let sha = durable::sha256_hex(&bytes);
        if durable::read_optional(&manifest_path)?.as_deref() != Some(bytes.as_slice()) {
            self.fault("manifest:before")?;
            durable::publish_file(&manifest_path, &bytes)?;
            self.fault("manifest:after")?;
        }
        self.fault("journal:plan:before")?;
        let journal = Journal::create(
            &journal_path,
            PlanEntry {
                manifest_sha256: Text::try_from(sha.as_str()).map_err(Blocked::journal)?,
                items: manifest.items.len() as u64,
            },
            &manifest,
        )?;
        self.fault("journal:plan:after")?;
        Ok((manifest, sha, journal))
    }

    fn states(&self, shared: &Shared<'_>) -> BTreeMap<String, ItemState> {
        let journal = shared.journal.lock().expect("journal");
        shared
            .manifest
            .items
            .iter()
            .filter_map(|i| {
                journal.progress(i.key.as_str()).map(|p| {
                    // A disposed item is reported by the outcome it was disposed with.
                    let state = match (p.state, &p.digest) {
                        (ItemState::Disposed, Some(_)) => ItemState::Verified,
                        (ItemState::Disposed, None) => ItemState::Quarantined,
                        (state, _) => state,
                    };
                    (i.key.as_str().to_string(), state)
                })
            })
            .collect()
    }

    fn convert(&self, shared: &Shared<'_>) -> Result<()> {
        let mut waves: BTreeMap<Wave, Vec<&ManifestItem>> = BTreeMap::new();
        for item in &shared.manifest.items {
            waves
                .entry(self.driver(item)?.wave(item))
                .or_default()
                .push(item);
        }
        for (wave, items) in waves {
            let states = self.states(shared);
            let cx = shared.cx(&states);
            let workers = if wave == Wave::Sessions {
                self.options.workers.max(1)
            } else {
                1
            };
            if workers == 1 {
                for item in items {
                    self.drive(shared, &cx, item)?;
                }
                continue;
            }
            let next = AtomicUsize::new(0);
            let stop = AtomicBool::new(false);
            let failure: Mutex<Option<Blocked>> = Mutex::new(None);
            std::thread::scope(|scope| {
                for _ in 0..workers {
                    scope.spawn(|| {
                        while !stop.load(Ordering::Relaxed) {
                            let i = next.fetch_add(1, Ordering::Relaxed);
                            let Some(item) = items.get(i) else { break };
                            if let Err(e) = self.drive(shared, &cx, item) {
                                stop.store(true, Ordering::Relaxed);
                                failure.lock().expect("failure").get_or_insert(e);
                            }
                        }
                    });
                }
            });
            if let Some(e) = failure.into_inner().expect("failure") {
                return Err(e);
            }
        }
        Ok(())
    }

    /// Writes `reason.json`, withdraws a published target, then journals `quarantined`.
    fn quarantine(
        &self,
        shared: &Shared<'_>,
        cx: &ItemContext<'_>,
        item: &ManifestItem,
        code: QuarantineCode,
        detail: String,
    ) -> Result<()> {
        let k = item.key.as_str();
        let reason = QuarantineReason {
            format: REASON_FORMAT,
            key: k.to_string(),
            code,
            expected: code.expected(),
            detail,
            sources: item
                .sources
                .iter()
                .map(|s| QuarantinedSource {
                    root: s.root,
                    path: s.path.clone(),
                    sha256: s.sha256.clone(),
                })
                .collect(),
        };
        let dir = quarantine_dir(&self.roots.data, code, k);
        shared.fault(&format!("reason:{k}:before"))?;
        durable::publish_file(
            &dir.join(REASON_FILE),
            &serde_json::to_vec(&reason).expect("reason encodes"),
        )?;
        shared.fault(&format!("reason:{k}:after"))?;
        self.driver(item)?.withdraw(cx, item)?;
        durable::remove_dir_all(&cx.stage_dir(k))?;
        shared.record(
            &format!("quarantined:{k}"),
            JournalRecord::Quarantined(QuarantinedEntry {
                key: key(item),
                code,
            }),
        )
    }

    fn drive(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        let driver = self.driver(item)?;
        let k = item.key.as_str();
        loop {
            let progress = shared
                .journal
                .lock()
                .expect("journal")
                .progress(k)
                .cloned()
                .ok_or_else(|| Blocked::journal(format!("{k} not journaled")))?;
            match (item.contract, progress.state) {
                (_, ItemState::Verified | ItemState::Quarantined | ItemState::Disposed) => {
                    return Ok(());
                }
                (Contract::Retire, ItemState::Planned) | (_, ItemState::Published) => {
                    match driver.verify(cx, item)? {
                        Verdict::Verified { digest } => shared.record(
                            &format!("verified:{k}"),
                            JournalRecord::Verified(VerifiedEntry {
                                key: key(item),
                                digest,
                            }),
                        )?,
                        Verdict::Quarantine { code, detail } => {
                            self.quarantine(shared, cx, item, code, detail)?
                        }
                    }
                }
                (_, ItemState::Planned) => {
                    durable::remove_dir_all(&cx.stage_dir(k))?;
                    match driver.stage(cx, item)? {
                        Staged::Output {
                            output_sha256,
                            replaced_surrogates,
                        } if item.contract != Contract::Retain => shared.record(
                            &format!("staged:{k}"),
                            JournalRecord::Staged(StagedEntry {
                                key: key(item),
                                output_sha256: Text::try_from(output_sha256)
                                    .map_err(Blocked::journal)?,
                                replaced_surrogates,
                            }),
                        )?,
                        Staged::Output { .. } => {
                            return Err(Blocked::journal(format!("{k}: a retain item staged output")));
                        }
                        Staged::Quarantine { code, detail } => {
                            self.quarantine(shared, cx, item, code, detail)?
                        }
                    }
                }
                (_, ItemState::Staged) => {
                    let staged = progress
                        .staged
                        .ok_or_else(|| Blocked::journal(format!("{k} staged without entry")))?;
                    shared.fault(&format!("publish:{k}:before"))?;
                    driver.publish(cx, item, &staged)?;
                    shared.fault(&format!("publish:{k}:after"))?;
                    shared.record(
                        &format!("published:{k}"),
                        JournalRecord::Published(KeyEntry { key: key(item) }),
                    )?;
                }
            }
        }
    }

    fn rehash(&self, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<Vec<std::path::PathBuf>> {
        let mut present = Vec::new();
        for source in &item.sources {
            let path = cx.source_path(source)?;
            if !durable::exists(&path)? {
                continue;
            }
            let (size, sha) = durable::hash_file(&path)?;
            if size != source.size || sha != source.sha256 {
                return Err(Blocked::SourceChanged { path });
            }
            present.push(path);
        }
        Ok(present)
    }

    fn dispose(&self, shared: &Shared<'_>) -> Result<()> {
        let states = self.states(shared);
        let cx = shared.cx(&states);
        for item in &shared.manifest.items {
            let k = item.key.as_str();
            let progress = shared
                .journal
                .lock()
                .expect("journal")
                .progress(k)
                .cloned()
                .ok_or_else(|| Blocked::journal(format!("{k} not journaled")))?;
            let driver = self.driver(item)?;
            match progress.state {
                ItemState::Disposed => continue,
                ItemState::Verified => {
                    if !driver.keeps_sources(item) {
                        for path in self.rehash(&cx, item)? {
                            shared.fault(&format!("delete:{k}:before"))?;
                            durable::remove_file(&path)?;
                        }
                    }
                }
                ItemState::Quarantined => {
                    let code = progress
                        .quarantined
                        .ok_or_else(|| Blocked::journal(format!("{k} without code")))?;
                    let dir = quarantine_dir(&self.roots.data, code, k);
                    let present = self.rehash(&cx, item)?;
                    let names = quarantine_names(item);
                    for (source, name) in item.sources.iter().zip(&names) {
                        let path = cx.source_path(source)?;
                        if present.contains(&path) {
                            shared.fault(&format!("move:{k}:before"))?;
                            durable::create_dir_all(&dir)?;
                            durable::durable_rename(&path, &dir.join(name))?;
                        }
                    }
                    // Shared files this item read (pending entries, worker rows) travel
                    // with it as copies, so the export holds everything it was made of.
                    for file in cx.shared_for(k) {
                        let path = cx.source_path(file)?;
                        if let Some(bytes) = durable::read_optional(&path)? {
                            let name = format!("shared-{}", file.path.replace('/', "%2F"));
                            durable::publish_file(&dir.join(name), &bytes)?;
                        }
                    }
                }
                other => {
                    return Err(Blocked::journal(format!("{k} is {other:?} at disposal")));
                }
            }
            shared.record(
                &format!("disposed:{k}"),
                JournalRecord::Disposed(KeyEntry { key: key(item) }),
            )?;
        }
        // A shared file goes once every consumer is disposed, unless one keeps it.
        let by_key: BTreeMap<&str, &ManifestItem> = shared
            .manifest
            .items
            .iter()
            .map(|i| (i.key.as_str(), i))
            .collect();
        for file in &shared.manifest.shared {
            let mut keep = false;
            for consumer in &file.consumers {
                let item = by_key
                    .get(consumer.as_str())
                    .ok_or_else(|| Blocked::journal(format!("unknown consumer {consumer}")))?;
                keep |= self.driver(item)?.keeps_sources(item);
            }
            if keep {
                continue;
            }
            let path = cx.source_path(&file.file)?;
            if !durable::exists(&path)? {
                continue;
            }
            let (size, sha) = durable::hash_file(&path)?;
            if size != file.file.size || sha != file.file.sha256 {
                return Err(Blocked::SourceChanged { path });
            }
            shared.fault(&format!("delete-shared:{}:before", file.file.path))?;
            durable::remove_file(&path)?;
        }
        Ok(())
    }

    fn counts(&self, shared: &Shared<'_>) -> Result<CompleteKinds> {
        let states = self.states(shared);
        let cx = shared.cx(&states);
        let zero = Counts {
            verified: 0,
            quarantined_expected: 0,
            quarantined_unexpected: 0,
            retired: 0,
            retained: 0,
            dangling: 0,
        };
        let mut kinds = CompleteKinds {
            data: zero,
            desktop_profile: zero,
        };
        let journal = shared.journal.lock().expect("journal");
        for item in &shared.manifest.items {
            let counts = match item.group {
                KindGroup::Data => &mut kinds.data,
                KindGroup::DesktopProfile => &mut kinds.desktop_profile,
            };
            let progress = journal
                .progress(item.key.as_str())
                .ok_or_else(|| Blocked::journal("item not journaled"))?;
            match progress.quarantined {
                Some(code) if !code.expected() => counts.quarantined_unexpected += 1,
                Some(_) if item.contract == Contract::Retain => counts.retained += 1,
                Some(_) => counts.quarantined_expected += 1,
                None if item.contract == Contract::Retire => counts.retired += 1,
                None => {
                    counts.verified += 1;
                    counts.dangling += self.driver(item)?.dangling(&cx, item)?;
                }
            }
        }
        Ok(kinds)
    }
}

pub mod cli;
#[cfg(test)]
pub(crate) mod tests;

/// The names the sources of `item` get in its quarantine folder: base names, or the
/// escaped relative path for all of them when two base names collide.
fn quarantine_names(item: &ManifestItem) -> Vec<String> {
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let bases: Vec<String> = item.sources.iter().map(|s| base(&s.path)).collect();
    let unique: BTreeSet<&String> = bases.iter().collect();
    if unique.len() == bases.len() {
        bases
    } else {
        item.sources.iter().map(|s| escape_key(&s.path)).collect()
    }
}
