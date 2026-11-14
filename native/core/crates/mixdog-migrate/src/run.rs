//! The migration state machine (SM §11.5): plan, convert, verify, dispose, complete —
//! resumed from `manifest.json` + the journal after any crash, deterministic at every
//! step. `Migrator::run` is the whole of `mixdogd`'s `Migrating` state.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
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
use mixdog_store::schema::migration::LATE_JOURNAL_PATH;
use mixdog_store::schema::migration::LATE_MANIFEST_PATH;
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

use crate::desktop_profile::supplement;
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

/// Told the id of a session once its item is journaled `verified`, on the thread that converted it.
pub type VerifiedHook = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct MigrateOptions {
    /// Session items converted at once (SM §11.5: 4).
    pub workers: usize,
    pub fault: Option<FaultHook>,
    /// Set by a core that serves while the sessions convert ([`Back`]): it takes each session into its open index here.
    /// With it the sessions convert newest first (the ones a person reaches for), not in key order.
    pub verified: Option<VerifiedHook>,
}

impl Default for MigrateOptions {
    fn default() -> Self {
        Self {
            workers: 4,
            fault: None,
            verified: None,
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

/// Which migration a run drives to `complete.json`.
enum Pass {
    First,
    /// The late desktop-profile pass, carrying the data counts of the completed first pass.
    Late(Counts),
}

pub struct Migrator {
    roots: MigrationRoots,
    drivers: Vec<Arc<dyn ItemDriver>>,
    options: MigrateOptions,
}

/// The sessions a [`Back`] has still to settle, and the ones asked for ahead of the rest: a serving core lists every one of
/// them from its first start, and a person who opens one gets it converted next.
#[derive(Default)]
pub struct Waiting {
    state: Mutex<WaitingState>,
}

#[derive(Default)]
struct WaitingState {
    /// Session ids not yet verified or quarantined.
    open: BTreeSet<String>,
    /// The ones a converter is on.
    claimed: BTreeSet<String>,
    /// Asked for first, oldest request first.
    asked: std::collections::VecDeque<String>,
    /// What to run once a session is settled.
    told: BTreeMap<String, Vec<Box<dyn FnOnce() + Send>>>,
}

impl Waiting {
    fn state(&self) -> std::sync::MutexGuard<'_, WaitingState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The sessions still to settle.
    pub fn pending(&self) -> Vec<String> {
        self.state().open.iter().cloned().collect()
    }

    /// Asks for `session` ahead of the rest; `then` runs once it is settled (verified and handed to
    /// [`MigrateOptions::verified`], or quarantined) or once the run has ended without it. `false`, with `then` dropped
    /// unrun, when `session` is not one still to settle.
    pub fn first(&self, session: &str, then: Box<dyn FnOnce() + Send>) -> bool {
        let mut state = self.state();
        if !state.open.contains(session) {
            return false;
        }
        if !state.claimed.contains(session) && !state.asked.iter().any(|asked| asked == session) {
            state.asked.push_back(session.to_owned());
        }
        state.told.entry(session.to_owned()).or_default().push(then);
        true
    }

    /// The next session asked for that no converter is on, claimed.
    fn asked(&self) -> Option<String> {
        let mut state = self.state();
        while let Some(session) = state.asked.pop_front() {
            if state.open.contains(&session) && state.claimed.insert(session.clone()) {
                return Some(session);
            }
        }
        None
    }

    /// Claims `session` for the calling converter; `false` when another is on it or it is settled.
    fn claim(&self, session: &str) -> bool {
        let mut state = self.state();
        state.open.contains(session) && state.claimed.insert(session.to_owned())
    }

    fn settled(&self, session: &str) {
        let told = {
            let mut state = self.state();
            state.open.remove(session);
            state.claimed.remove(session);
            state.told.remove(session).unwrap_or_default()
        };
        told.into_iter().for_each(|then| then());
    }

    /// The run ended: nothing more is settled by it, and everyone waiting is told.
    fn ended(&self) {
        let told = {
            let mut state = self.state();
            state.open.clear();
            state.asked.clear();
            std::mem::take(&mut state.told)
        };
        told.into_values().flatten().for_each(|then| then());
    }
}

/// Where [`Migrator::front`] left the migration.
pub enum Front {
    /// Complete, now or by an earlier run.
    Complete(Complete),
    /// Everything a core waits for is settled; the sessions, their index, disposal and the marker are left.
    Pending(Back),
}

/// The rest of a migration whose front is settled: the sessions (one by one, each usable as soon as it is verified), the
/// index, the verification of the whole, disposal and `complete.json`. A core runs it while it serves; a run that ends
/// before the marker is resumed by the next [`Migrator::front`], as after any crash.
pub struct Back {
    migrator: Migrator,
    pass: Pass,
    manifest: Manifest,
    manifest_sha256: String,
    journal: Mutex<Journal>,
    blobs: BlobStatuses,
    waiting: Arc<Waiting>,
}

impl Back {
    fn shared(&self) -> Shared<'_> {
        Shared {
            roots: &self.migrator.roots,
            manifest: &self.manifest,
            manifest_sha256: &self.manifest_sha256,
            fault: self.migrator.options.fault.as_ref(),
            blobs: &self.blobs,
            journal: &self.journal,
            waiting: Some(&self.waiting),
        }
    }

    /// The sessions still to settle, and the way to ask for one ahead of the rest.
    pub fn waiting(&self) -> Arc<Waiting> {
        self.waiting.clone()
    }

    /// For each of `sessions`, the header keys its conversion takes from other kind groups ([`ItemDriver::listed_meta`]);
    /// none for a session whose keys cannot be read now (its conversion says why).
    pub fn listed_meta(&self, sessions: &[String]) -> Vec<serde_json::Map<String, serde_json::Value>> {
        let shared = self.shared();
        let states = self.migrator.states(&shared);
        let cx = shared.cx(&states);
        sessions
            .iter()
            .map(|session| {
                let mut all = serde_json::Map::new();
                for driver in &self.migrator.drivers {
                    all.extend(driver.listed_meta(&cx, session).unwrap_or_default());
                }
                all
            })
            .collect()
    }

    /// The session items the manifest plans: how many there are to take in.
    pub fn sessions(&self) -> usize {
        self.manifest.items.iter().filter(|item| item.key.as_str().starts_with("session/")).count()
    }

    /// Runs the rest to the completion marker.
    pub fn run(self) -> Result<Complete> {
        let Back { migrator, pass, .. } = &self;
        let pass = match pass {
            Pass::First => Pass::First,
            Pass::Late(counts) => Pass::Late(*counts),
        };
        migrator.finish(&self.shared(), pass)
    }
}

/// However a `Back` ends (run to the marker, blocked, or never run because its thread could not start), nothing more is
/// settled by it: everyone waiting on a session is told, so no open waits on a conversion that will not come.
impl Drop for Back {
    fn drop(&mut self) {
        self.waiting.ended();
    }
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
    waiting: Option<&'a Waiting>,
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
        match self.front()? {
            Front::Complete(complete) => Ok(complete),
            Front::Pending(back) => back.run(),
        }
    }

    /// Runs (or resumes) the part of the migration a core waits for before it serves: the plan, and every wave before the
    /// sessions (settings, stores, the ledger, the profile's tables). What is left is the returned [`Back`].
    pub fn front(&self) -> Result<Front> {
        let data = &self.roots.data;
        // A publication a kill cut leaves its tmp file here (the main and the late pass publish into this directory); it goes before the marker is read, and the run publishes the name again under a new tmp.
        durable::sweep_tmp(&data.join(MANIFEST_PATH).parent().expect("the migration dir"))?;
        let Some(bytes) = durable::read_optional(&data.join(COMPLETE_PATH))? else {
            self.supplement(self.roots.profile.clone())?;
            return self.begin(self.roots.clone(), Pass::First);
        };
        let complete: Complete = serde_json::from_slice(&bytes)
            .map_err(|e| Blocked::journal(format!("complete.json: {e}")))?;
        match self.late_profile(&complete)? {
            Some(profile) => {
                self.supplement(Some(profile.clone()))?;
                self.begin(MigrationRoots { profile: Some(profile), ..self.roots.clone() }, Pass::Late(complete.kinds.data))
            }
            None => {
                // Generation 2: the profile files the first pass did not list, for the profile the migration completed with.
                if self.roots.profile.is_some() {
                    self.supplement(self.completed_profile()?)?;
                }
                durable::remove_dir_all(&data.join(STAGE_DIR))?;
                Ok(Front::Complete(complete))
            }
        }
    }

    /// Brings `profile` to generation 2 of the profile move (a no-op when none is named or the marker is current).
    fn supplement(&self, profile: Option<PathBuf>) -> Result<()> {
        let Some(profile) = profile else { return Ok(()) };
        let roots = MigrationRoots { profile: Some(profile), ..self.roots.clone() };
        supplement::run_with(&roots, &|point| self.fault(point)).map(drop)
    }

    /// The profile a completed migration moved: the late manifest's when a late pass ran, else the first manifest's.
    fn completed_profile(&self) -> Result<Option<PathBuf>> {
        let data = &self.roots.data;
        let bytes = match durable::read_optional(&data.join(LATE_MANIFEST_PATH))? {
            Some(bytes) => bytes,
            None => durable::read(&data.join(MANIFEST_PATH))?,
        };
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|e| Blocked::journal(format!("manifest: {e}")))?;
        Ok(manifest.roots.profile.map(PathBuf::from))
    }

    fn begin(&self, roots: MigrationRoots, pass: Pass) -> Result<Front> {
        let migrator = Migrator::new(roots, self.drivers.clone(), self.options.clone());
        let (manifest, manifest_sha256, journal) = migrator.open_or_plan(&pass)?;
        let waiting = Waiting::default();
        waiting.state().open = manifest
            .items
            .iter()
            .filter_map(|item| item.key.as_str().strip_prefix("session/").map(|id| (item, id)))
            .filter(|(item, _)| journal.progress(item.key.as_str()).is_some_and(|p| matches!(p.state, ItemState::Planned | ItemState::Staged | ItemState::Published)))
            .map(|(_, id)| id.to_owned())
            .collect();
        let back = Back {
            migrator,
            pass,
            manifest,
            manifest_sha256,
            journal: Mutex::new(journal),
            blobs: BlobStatuses::default(),
            waiting: Arc::new(waiting),
        };
        back.migrator.convert(&back.shared(), Wave::before_serving)?;
        Ok(Front::Pending(back))
    }

    /// The profile a completed migration still has to migrate: one is named now and the
    /// migration was completed with none (the core or CLI ran standalone first). A migration that
    /// completed with a profile never takes another, so a different one named later is ignored
    /// and its files are never read, moved or deleted; the migrated `remote/*` is never
    /// overwritten. Once the late manifest is published every resume continues with its recorded
    /// profile, whatever the run names (even none).
    fn late_profile(&self, complete: &Complete) -> Result<Option<PathBuf>> {
        let data = &self.roots.data;
        let late = durable::read_optional(&data.join(LATE_MANIFEST_PATH))?;
        if late.is_none() && self.roots.profile.is_none() {
            return Ok(None);
        }
        let completed = |bytes: &[u8]| durable::sha256_hex(bytes) == complete.manifest_sha256;
        // A published late manifest is the commitment, even before the journal holds its plan.
        if let Some(bytes) = &late {
            if completed(bytes) {
                return Ok(None);
            }
            let manifest: Manifest = serde_json::from_slice(bytes)
                .map_err(|e| Blocked::journal(format!("late-manifest.json: {e}")))?;
            let profile = manifest
                .roots
                .profile
                .as_deref()
                .ok_or_else(|| Blocked::journal("late-manifest.json names no profile"))?;
            return Ok(Some(PathBuf::from(profile)));
        }
        let base = durable::read(&data.join(MANIFEST_PATH))?;
        if !completed(&base) {
            return Err(Blocked::journal("complete.json names no manifest"));
        }
        let base: Manifest = serde_json::from_slice(&base)
            .map_err(|e| Blocked::journal(format!("manifest.json: {e}")))?;
        if base.roots.profile.is_some() {
            return Ok(None);
        }
        Ok(self.roots.profile.clone())
    }

    /// The waves a core does not wait for, then verification of the whole, disposal and the completion marker.
    fn finish(&self, shared: &Shared<'_>, pass: Pass) -> Result<Complete> {
        let data = &self.roots.data;
        let (journal, manifest_sha256) = (shared.journal, shared.manifest_sha256);
        self.convert(shared, |wave| !wave.before_serving())?;
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
        let mut kinds: CompleteKinds = match durable::read_optional(&counts_path)? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| Blocked::journal(format!("{COUNTS_FILE}: {e}")))?,
            None => {
                let kinds = self.counts(shared)?;
                self.fault("counts:before")?;
                durable::publish_file(&counts_path, &serde_json::to_vec(&kinds).expect("counts encode"))?;
                self.fault("counts:after")?;
                kinds
            }
        };
        self.dispose(shared)?;
        // The late pass planned no data item: the data counts stay the first pass's.
        if let Pass::Late(data_counts) = pass {
            kinds.data = data_counts;
        }
        let complete = Complete {
            format: COMPLETE_FORMAT,
            manifest_sha256: manifest_sha256.to_owned(),
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

    fn open_or_plan(&self, pass: &Pass) -> Result<(Manifest, String, Journal)> {
        let data = &self.roots.data;
        let (manifest_path, journal_path) = match pass {
            Pass::First => (data.join(MANIFEST_PATH), data.join(JOURNAL_PATH)),
            Pass::Late(_) => (data.join(LATE_MANIFEST_PATH), data.join(LATE_JOURNAL_PATH)),
        };
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
            match pass {
                Pass::First => driver.plan(&self.roots, &mut sink)?,
                Pass::Late(_) => driver.plan_late(&self.roots, &mut sink)?,
            }
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

    /// Drives the items of the waves `which` picks, wave by wave.
    fn convert(&self, shared: &Shared<'_>, which: impl Fn(Wave) -> bool) -> Result<()> {
        let mut waves: BTreeMap<Wave, Vec<&ManifestItem>> = BTreeMap::new();
        for item in &shared.manifest.items {
            let wave = self.driver(item)?.wave(item);
            if which(wave) {
                waves.entry(wave).or_default().push(item);
            }
        }
        for (wave, mut items) in waves {
            if wave == Wave::Sessions && self.options.verified.is_some() {
                self.newest_first(shared, &mut items);
            }
            self.wave(shared, wave, &items)?;
        }
        Ok(())
    }

    /// Orders session items by their newest source, newest first (a source that is gone sorts last; ties keep key order).
    fn newest_first(&self, shared: &Shared<'_>, items: &mut [&ManifestItem]) {
        let newest = |item: &ManifestItem| {
            item.sources
                .iter()
                .filter_map(|source| durable::modified(&shared.roots.resolve(source.root, &source.path).ok()?))
                .max()
        };
        items.sort_by_cached_key(|item| std::cmp::Reverse(newest(item)));
    }

    /// Drives one item, and tells the hook of a session it leaves verified.
    fn settle(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        self.drive(shared, cx, item)?;
        let Some(id) = item.key.as_str().strip_prefix("session/") else {
            return Ok(());
        };
        let verified = shared.journal.lock().expect("journal").progress(item.key.as_str()).is_some_and(|p| p.state == ItemState::Verified);
        if let Some(hook) = self.options.verified.as_ref().filter(|_| verified) {
            hook(id);
        }
        if let Some(waiting) = shared.waiting {
            waiting.settled(id);
        }
        Ok(())
    }

    /// The next item a converter of the session wave takes: a session asked for first, else the next of `items` in order
    /// that no other converter is on.
    fn take<'i>(&self, shared: &'i Shared<'_>, waiting: &Waiting, items: &[&'i ManifestItem], next: &AtomicUsize) -> Option<&'i ManifestItem> {
        loop {
            if let Some(id) = waiting.asked() {
                let key = format!("session/{id}");
                match shared.manifest.items.binary_search_by(|item| item.key.as_str().cmp(&key)) {
                    Ok(at) => return Some(&shared.manifest.items[at]),
                    Err(_) => {
                        waiting.settled(&id);
                        continue;
                    }
                }
            }
            let item = *items.get(next.fetch_add(1, Ordering::Relaxed))?;
            match item.key.as_str().strip_prefix("session/") {
                // Settled by an earlier run, taken ahead of its turn, or another converter is on it.
                Some(id) if !waiting.claim(id) => continue,
                _ => return Some(item),
            }
        }
    }

    /// Drives `items` of one wave to `verified` or `quarantined`, over the item states as they are when it starts.
    fn wave(&self, shared: &Shared<'_>, wave: Wave, items: &[&ManifestItem]) -> Result<()> {
        let states = self.states(shared);
        let cx = shared.cx(&states);
        let workers = if wave == Wave::Sessions {
            self.options.workers.max(1)
        } else {
            1
        };
        let waiting = shared.waiting.filter(|_| wave == Wave::Sessions);
        if workers == 1 && waiting.is_none() {
            for item in items {
                self.settle(shared, &cx, item)?;
            }
            return Ok(());
        }
        let next = AtomicUsize::new(0);
        let stop = AtomicBool::new(false);
        let failure: Mutex<Option<Blocked>> = Mutex::new(None);
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    while !stop.load(Ordering::Relaxed) {
                        let item = match waiting {
                            Some(waiting) => self.take(shared, waiting, items, &next),
                            None => items.get(next.fetch_add(1, Ordering::Relaxed)).copied(),
                        };
                        let Some(item) = item else { break };
                        if let Err(e) = self.settle(shared, &cx, item) {
                            stop.store(true, Ordering::Relaxed);
                            failure.lock().expect("failure").get_or_insert(e);
                        }
                    }
                });
            }
        });
        match failure.into_inner().expect("failure") {
            Some(e) => Err(e),
            None => Ok(()),
        }
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
                if self.core_serves() {
                    continue;
                }
                return Err(Blocked::SourceChanged { path });
            }
            present.push(path);
        }
        Ok(present)
    }

    /// Whether a core serves while this run converts ([`MigrateOptions::verified`]). Every item was settled from the
    /// planned bytes; a file that differs from them at disposal is one that core has written since under the same name
    /// (a cache 1.4.5 kept and the core keeps too), so it is the core's and stays. With no core serving nothing but an
    /// earlier version can have written it, and the run is blocked.
    fn core_serves(&self) -> bool {
        self.options.verified.is_some()
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
                    if driver.keeps_sources(item) {
                        // The sources are the target.
                    } else if self.core_serves() {
                        for source in &item.sources {
                            shared.fault(&format!("delete:{k}:before"))?;
                            durable::remove_if_planned(&cx.source_path(source)?, source.size, &source.sha256)?;
                        }
                    } else {
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
            if self.core_serves() {
                // Also when the name is gone: a run that ended after it took the file aside left it there to be judged.
                shared.fault(&format!("delete-shared:{}:before", file.file.path))?;
                durable::remove_if_planned(&path, file.file.size, &file.file.sha256)?;
                continue;
            }
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
#[cfg(test)]
mod registry_import_tests;

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
