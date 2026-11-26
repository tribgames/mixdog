//! The migration state machine (SM §11.5): plan, convert, verify, dispose, complete —
//! resumed from `manifest.json` + the journal after any crash, deterministic at every
//! step. `Migrator::run` is the whole of `mixdogd`'s `Migrating` state.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_store::schema::bounded::Text;
use mixdog_store::schema::migration::COMPLETE_FORMAT;
use mixdog_store::schema::migration::COMPLETE_PATH;
use mixdog_store::schema::migration::Complete;
use mixdog_store::schema::migration::CompleteKinds;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::Counts;
use mixdog_store::schema::migration::ExpiredEntry;
use mixdog_store::schema::migration::ItemKey;
use mixdog_store::schema::migration::ItemKind;
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
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::SourcesEntry;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::VerifiedEntry;

use crate::desktop_profile::supplement;
use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::BlobStatuses;
use crate::framework::FaultHook;
use crate::framework::ItemContext;
use crate::framework::ItemDriver;
use crate::framework::MigrationRoots;
use crate::framework::Retention;
use crate::framework::Staged;
use crate::framework::Verdict;
use crate::framework::Wave;
use crate::framework::map_on_threads;
use crate::framework::on_threads;
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
    /// Set by a core that serves while the sessions convert: a session the product's retention deletes is settled
    /// `expired` and its sources are removed without converting it.
    pub retention: Option<Arc<dyn Retention>>,
}

impl Default for MigrateOptions {
    fn default() -> Self {
        Self { workers: 4, fault: None, verified: None, retention: None }
    }
}

/// Every kind group of the product, in planning order (sessions first: the shared
/// sources and the profile's session metadata name session items).
pub fn product_drivers(projector: Arc<dyn crate::index::IndexProjector>, office: crate::session::context_blobs::OfficeExtractor) -> Vec<Arc<dyn ItemDriver>> {
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
    /// Told when a session is asked for ([`Self::next_asked`]).
    asked_for: std::sync::Condvar,
}

/// How a session stopped being one still to settle, as [`Waiting::watch`] tells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settled {
    /// Converted, verified and handed to [`MigrateOptions::verified`].
    Verified,
    /// Set aside under `quarantine/`: no conversation was made of it.
    Quarantined,
    /// Removed unconverted by the product's retention ([`Retention`]), or not one the plan holds.
    Removed,
}

/// Told of the sessions that settle ([`Waiting::watch`]).
pub type SettledWatch = Arc<dyn Fn(&[String], Settled) + Send + Sync>;

#[derive(Default)]
struct WaitingState {
    /// Session ids not yet verified or quarantined.
    open: BTreeSet<String>,
    watch: Option<SettledWatch>,
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

    /// Tells `watch` of every session that settles from now on: once each, on the thread that settled it, once it is no longer
    /// one still to settle and before anyone waiting on it is told. A run that ends early tells it nothing of the sessions it
    /// leaves. Returns the sessions still to settle as the watch begins.
    pub fn watch(&self, watch: SettledWatch) -> Vec<String> {
        let mut state = self.state();
        state.watch = Some(watch);
        state.open.iter().cloned().collect()
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
        self.asked_for.notify_all();
        true
    }

    /// A session a converter claimed goes back to waiting its turn; it stays asked for.
    fn defer(&self, session: &str) {
        self.state().claimed.remove(session);
    }

    /// The sessions deferred are asked for again, ahead of the rest.
    fn again(&self, sessions: Vec<String>) {
        let mut state = self.state();
        for session in sessions.into_iter().rev() {
            if state.open.contains(&session) && !state.claimed.contains(&session) && !state.asked.contains(&session) {
                state.asked.push_front(session);
            }
        }
        self.asked_for.notify_all();
    }

    fn awaited_in(state: &WaitingState) -> BTreeSet<String> {
        state.told.keys().chain(&state.claimed).chain(&state.asked).cloned().collect()
    }

    /// The sessions someone waits for or a converter is on.
    fn awaited(&self) -> BTreeSet<String> {
        Self::awaited_in(&self.state())
    }

    /// Settles `expired` as never to be converted, in one step with the opens, when `still` holds of the sessions awaited
    /// now: they stop being sessions still to settle before any other open is answered. An open therefore either was
    /// seen by the verdict `still` stands for, or is told there is no such session. `false`, with nothing settled, when
    /// `still` does not hold: the verdict is to be given again. The opens are held for `still` alone, not for a verdict.
    fn expire(&self, expired: &BTreeSet<String>, still: impl FnOnce(&BTreeSet<String>) -> bool) -> bool {
        let (removed, watch) = {
            let mut state = self.state();
            if !still(&Self::awaited_in(&state)) {
                return false;
            }
            let removed: Vec<String> = expired.iter().filter(|id| state.open.remove(*id)).cloned().collect();
            (removed, state.watch.clone())
        };
        if let Some(watch) = watch.filter(|_| !removed.is_empty()) {
            watch(&removed, Settled::Removed);
        }
        true
    }

    fn pop_asked(state: &mut WaitingState) -> Option<String> {
        while let Some(session) = state.asked.pop_front() {
            if state.open.contains(&session) && state.claimed.insert(session.clone()) {
                return Some(session);
            }
        }
        None
    }

    /// The next session asked for that no converter is on, claimed.
    fn asked(&self) -> Option<String> {
        Self::pop_asked(&mut self.state())
    }

    /// [`Self::asked`], waiting for a session to be asked for until `stop` is set and [`Self::wake`] called.
    fn next_asked(&self, stop: &std::sync::atomic::AtomicBool) -> Option<String> {
        let mut state = self.state();
        loop {
            if let Some(session) = Self::pop_asked(&mut state) {
                return Some(session);
            }
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            state = self.asked_for.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Wakes every [`Self::next_asked`].
    fn wake(&self) {
        let _state = self.state();
        self.asked_for.notify_all();
    }

    /// Claims `session` for the calling converter; `false` when another is on it or it is settled.
    fn claim(&self, session: &str) -> bool {
        let mut state = self.state();
        state.open.contains(session) && state.claimed.insert(session.to_owned())
    }

    fn settled(&self, session: &str, how: Settled) {
        let (told, watch) = {
            let mut state = self.state();
            let was_open = state.open.remove(session);
            state.claimed.remove(session);
            (state.told.remove(session).unwrap_or_default(), state.watch.clone().filter(|_| was_open))
        };
        if let Some(watch) = watch {
            watch(&[session.to_owned()], how);
        }
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
#[allow(clippy::large_enum_variant, reason = "Keep the public migration result and ownership of pending work without an extra allocation")]
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
    quarantine_reasons: QuarantineReasons,
    waiting: Arc<Waiting>,
    late: LateSources,
    judged: Judged,
}

/// The header each session was judged by, as far as the retention reads it: the purge of one settled `expired` takes it
/// from here, and a run that resumes at disposal reads it again.
type Judged = Mutex<BTreeMap<String, serde_json::Map<String, serde_json::Value>>>;

impl Back {
    fn shared(&self) -> Shared<'_> {
        Shared {
            roots: &self.migrator.roots,
            manifest: &self.manifest,
            manifest_sha256: &self.manifest_sha256,
            fault: self.migrator.options.fault.as_ref(),
            workers: self.migrator.options.workers.max(1),
            blobs: &self.blobs,
            quarantine_reasons: &self.quarantine_reasons,
            journal: &self.journal,
            waiting: Some(&self.waiting),
            late: &self.late,
            judged: &self.judged,
        }
    }

    /// The sessions still to settle, and the way to ask for one ahead of the rest.
    pub fn waiting(&self) -> Arc<Waiting> {
        self.waiting.clone()
    }

    /// Whether a session left is an agent home's history, whose conversion waits for a serving core's bot classification.
    pub fn has_pending_home_history(&self) -> bool {
        self.waiting.pending().iter().any(|id| !mixdog_store::agent_mode::agent_id_of_home_session(id).is_empty())
    }

    /// Project only the winning history of each home that has not finished
    /// conversion. The caller need not load payloads, archives or checkpoints.
    pub fn home_evidence<T>(&self, mut summarize: impl FnMut(&mixdog_store::schema::record::Header, &[serde_json::Value]) -> T) -> Result<BTreeMap<String, T>> {
        use crate::session::source::{Fail, JSON_SUFFIX, LOG_SUFFIX, header_and_messages};

        let shared = self.shared();
        let states = self.migrator.states(&shared);
        let cx = shared.cx(&states);
        let mut homes = BTreeMap::new();
        for item in &self.manifest.items {
            let k = item.key.as_str();
            if !matches!(states.get(k), Some(ItemState::Planned | ItemState::Staged | ItemState::Published)) {
                continue;
            }
            let Some(id) = k.strip_prefix("session/") else { continue };
            let agent = mixdog_store::agent_mode::agent_id_of_home_session(id);
            if agent.is_empty() {
                continue;
            }
            // Read by the sources its conversion will read: journaled here when no converter has reached it.
            let item = shared.with_sources(item)?;
            if item.sources.is_empty() {
                continue;
            }
            let file = |suffix| {
                let rel = format!("sessions/{id}{suffix}");
                item.sources.iter().find(|file| file.path == rel)
            };
            let json = file(JSON_SUFFIX).map(|source| cx.read_source(source)).transpose()?;
            let log = file(LOG_SUFFIX).map(|source| cx.open_source(source)).transpose()?;
            let mut replaced = 0;
            let (header, messages) = match header_and_messages(id, json.as_deref(), log, &mut replaced) {
                Ok(read) => read,
                Err(Fail::Blocked(error)) => return Err(error),
                // Its conversion reads the same and quarantines it: a damaged home is no evidence.
                Err(Fail::Quarantine(..)) => continue,
            };
            homes.insert(agent, summarize(&header, &messages));
        }
        Ok(homes)
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
    serde_json::to_value(code).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// `<D>/quarantine/<code>/<escaped key>/`.
pub fn quarantine_dir(data: &Path, code: QuarantineCode, key: &str) -> std::path::PathBuf {
    data.join(QUARANTINE_DIR).join(code_name(code)).join(escape_key(key))
}

type QuarantineReasons = BTreeMap<String, Vec<(QuarantineCode, PathBuf)>>;

/// Index the reason locations once, not once per planned session. A directory
/// with only a publication temp is not a committed reason.
fn quarantine_reasons(data: &Path) -> Result<QuarantineReasons> {
    let root = data.join(QUARANTINE_DIR);
    let mut reasons = QuarantineReasons::new();
    for (name, is_dir) in durable::list_dir(&root)? {
        if !is_dir {
            continue;
        }
        let dir = root.join(&name);
        let Ok(code) = serde_json::from_value::<QuarantineCode>(serde_json::Value::String(name)) else {
            continue;
        };
        if code == QuarantineCode::SessionDamage {
            continue;
        }
        for (key, is_dir) in durable::list_dir(&dir)? {
            if is_dir {
                reasons.entry(key.clone()).or_default().push((code, dir.join(key).join(REASON_FILE)));
            }
        }
    }
    Ok(reasons)
}

fn quarantined_sources(item: &ManifestItem) -> Vec<QuarantinedSource> {
    item.sources.iter().map(|s| QuarantinedSource { root: s.root, path: s.path.clone(), sha256: s.sha256.clone() }).collect()
}

struct Shared<'a> {
    roots: &'a MigrationRoots,
    manifest: &'a Manifest,
    manifest_sha256: &'a str,
    fault: Option<&'a FaultHook>,
    workers: usize,
    blobs: &'a BlobStatuses,
    quarantine_reasons: &'a QuarantineReasons,
    journal: &'a Mutex<Journal>,
    waiting: Option<&'a Waiting>,
    late: &'a LateSources,
    judged: &'a Judged,
}

/// The journaled sources of the items with `late_sources`, each behind a lock of its own: an item's files are hashed and
/// journaled once, by whichever thread first needs them (its converter, or another session's that reads its header),
/// while the others hash theirs.
#[derive(Default)]
struct LateSources(Mutex<BTreeMap<String, LateSource>>);

/// One item's journaled sources, once they are hashed.
type LateSource = Arc<Mutex<Option<Arc<Vec<SourceFile>>>>>;

/// The header fields read of each session for the retention judgement, with whether something else is bound to it.
type ReadHeaders = BTreeMap<String, (serde_json::Map<String, serde_json::Value>, bool)>;

impl crate::framework::SourceRecords for Shared<'_> {
    fn sources_of(&self, item: &ManifestItem) -> Result<Arc<Vec<SourceFile>>> {
        if item.late_sources.is_empty() {
            return Ok(Arc::new(item.sources.clone()));
        }
        let k = item.key.as_str();
        let cell = self.late.0.lock().expect("late sources").entry(k.to_owned()).or_default().clone();
        let mut slot = cell.lock().expect("an item's sources");
        if let Some(sources) = &*slot {
            return Ok(sources.clone());
        }
        let journaled = self.journal.lock().expect("journal").progress(k).ok_or_else(|| Blocked::journal(format!("{k} not journaled")))?.sources.clone();
        let sources = match journaled {
            Some(sources) => sources,
            None => {
                let mut sources = Vec::with_capacity(item.late_sources.len());
                for file in &item.late_sources {
                    let (size, sha256) = durable::hash_file(&self.roots.resolve(file.root, &file.path)?)?;
                    sources.push(SourceFile { root: file.root, path: file.path.clone(), size, sha256, secret: false });
                }
                self.record(&format!("sources:{k}"), JournalRecord::Sources(SourcesEntry { key: key(item), sources: sources.clone() }))?;
                sources
            }
        };
        Ok(slot.insert(Arc::new(sources)).clone())
    }
}

impl Shared<'_> {
    fn cx<'b>(&'b self, states: &'b BTreeMap<String, ItemState>) -> ItemContext<'b> {
        ItemContext {
            roots: self.roots,
            manifest: self.manifest,
            manifest_sha256: self.manifest_sha256,
            fault: self.fault,
            workers: self.workers,
            blobs: self.blobs,
            states,
            recorded: Some(self),
        }
    }

    /// `item` as its steps take it: an item with `late_sources` carries the journaled sources as its `sources` (hashed
    /// and journaled here when they are not yet).
    fn with_sources<'i>(&self, item: &'i ManifestItem) -> Result<std::borrow::Cow<'i, ManifestItem>> {
        use crate::framework::SourceRecords as _;
        if item.late_sources.is_empty() {
            return Ok(std::borrow::Cow::Borrowed(item));
        }
        let sources = self.sources_of(item)?;
        Ok(std::borrow::Cow::Owned(ManifestItem { sources: (*sources).clone(), ..item.clone() }))
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
    pub fn new(roots: MigrationRoots, drivers: Vec<Arc<dyn ItemDriver>>, options: MigrateOptions) -> Self {
        Self { roots, drivers, options }
    }

    fn driver(&self, item: &ManifestItem) -> Result<&Arc<dyn ItemDriver>> {
        self.drivers.iter().find(|d| d.owns(item)).ok_or_else(|| Blocked::journal(format!("no driver for {}", item.key.as_str())))
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
        self.front_with(&|| {})
    }

    /// [`Self::front`], calling `on_converting` once before earlier-version data is actually converted.
    /// A start with nothing to convert never calls `on_converting`.
    pub fn front_with(&self, on_converting: &dyn Fn()) -> Result<Front> {
        let announced = std::cell::Cell::new(false);
        let converting = || {
            if !announced.replace(true) {
                on_converting();
            }
        };
        crate::legacy_blobs::import_on_with(&self.roots.data, &|point| self.fault(point), &converting, self.options.workers.max(1))?;
        let result = self.front_inner(&converting)?;
        crate::desktop_profile::connection_adoption::run_with_progress(&self.roots.data, &|point| self.fault(point), &converting)?;
        Ok(result)
    }

    fn front_inner(&self, on_converting: &dyn Fn()) -> Result<Front> {
        let data = &self.roots.data;
        // A publication a kill cut leaves its tmp file here (the main and the late pass publish into this directory); it goes before the marker is read, and the run publishes the name again under a new tmp.
        durable::sweep_tmp(data.join(MANIFEST_PATH).parent().expect("the migration dir"))?;
        let Some(bytes) = durable::read_optional(&data.join(COMPLETE_PATH))? else {
            self.supplement(self.roots.profile.clone(), on_converting)?;
            return self.begin(self.roots.clone(), Pass::First, on_converting);
        };
        let complete: Complete = serde_json::from_slice(&bytes).map_err(|e| Blocked::journal(format!("complete.json: {e}")))?;
        match self.late_profile(&complete)? {
            Some(profile) => {
                self.supplement(Some(profile.clone()), on_converting)?;
                self.begin(MigrationRoots { profile: Some(profile), ..self.roots.clone() }, Pass::Late(complete.kinds.data), on_converting)
            }
            None => {
                // Generation 2: the profile files the first pass did not list, for the profile the migration completed with.
                if self.roots.profile.is_some() {
                    self.supplement(self.completed_profile()?, on_converting)?;
                }
                durable::remove_dir_all(&data.join(STAGE_DIR))?;
                Ok(Front::Complete(complete))
            }
        }
    }

    /// Brings `profile` to generation 2 of the profile move (a no-op when none is named or the marker is current).
    fn supplement(&self, profile: Option<PathBuf>, on_converting: &dyn Fn()) -> Result<()> {
        let Some(profile) = profile else { return Ok(()) };
        let roots = MigrationRoots { profile: Some(profile), ..self.roots.clone() };
        supplement::run_with_progress(&roots, &|point| self.fault(point), on_converting).map(drop)
    }

    /// The profile a completed migration moved: the late manifest's when a late pass ran, else the first manifest's.
    fn completed_profile(&self) -> Result<Option<PathBuf>> {
        let data = &self.roots.data;
        let bytes = match durable::read_optional(&data.join(LATE_MANIFEST_PATH))? {
            Some(bytes) => bytes,
            None => durable::read(&data.join(MANIFEST_PATH))?,
        };
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| Blocked::journal(format!("manifest: {e}")))?;
        Ok(manifest.roots.profile.map(PathBuf::from))
    }

    fn begin(&self, roots: MigrationRoots, pass: Pass, on_converting: &dyn Fn()) -> Result<Front> {
        let migrator = Migrator::new(roots, self.drivers.clone(), self.options.clone());
        let (manifest, manifest_sha256, journal) = migrator.open_or_plan(&pass)?;
        let quarantine_reasons = quarantine_reasons(&migrator.roots.data)?;
        let waiting = Waiting::default();
        waiting.state().open = manifest
            .items
            .iter()
            .filter_map(|item| item.key.as_str().strip_prefix("session/").map(|id| (item, id)))
            .filter(|(item, _)| {
                journal.progress(item.key.as_str()).is_some_and(|p| matches!(p.state, ItemState::Planned | ItemState::Staged | ItemState::Published))
            })
            .map(|(_, id)| id.to_owned())
            .collect();
        let back = Back {
            migrator,
            pass,
            manifest,
            manifest_sha256,
            journal: Mutex::new(journal),
            blobs: BlobStatuses::default(),
            quarantine_reasons,
            waiting: Arc::new(waiting),
            late: LateSources::default(),
            judged: Judged::default(),
        };
        let has_front_work = back.manifest.items.iter().try_fold(false, |found, item| -> Result<bool> {
            if found || !back.migrator.driver(item)?.wave(item).before_serving() {
                return Ok(found);
            }
            let settled = back
                .journal
                .lock()
                .expect("journal")
                .progress(item.key.as_str())
                .is_some_and(|p| matches!(p.state, ItemState::Verified | ItemState::Quarantined | ItemState::Expired | ItemState::Disposed));
            Ok(!settled)
        })?;
        if has_front_work {
            on_converting();
        }
        back.migrator.convert(&back.shared(), Wave::before_serving)?;
        Ok(Front::Pending(back))
    }

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
            let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| Blocked::journal(format!("late-manifest.json: {e}")))?;
            let profile = manifest.roots.profile.as_deref().ok_or_else(|| Blocked::journal("late-manifest.json names no profile"))?;
            return Ok(Some(PathBuf::from(profile)));
        }
        let base = durable::read(&data.join(MANIFEST_PATH))?;
        if !completed(&base) {
            return Err(Blocked::journal("complete.json names no manifest"));
        }
        let base: Manifest = serde_json::from_slice(&base).map_err(|e| Blocked::journal(format!("manifest.json: {e}")))?;
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
            shared.record("verified_all", JournalRecord::Phase(PhaseEntry { phase: Phase::VerifiedAll, at: None }))?;
        }
        // Counted before disposal (a dangling count may read a source disposal removes),
        // kept in the stage until `complete.json` carries it.
        let counts_path = data.join(STAGE_DIR).join(COUNTS_FILE);
        let mut kinds: CompleteKinds = match durable::read_optional(&counts_path)? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| Blocked::journal(format!("{COUNTS_FILE}: {e}")))?,
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
        durable::publish_file(&data.join(COMPLETE_PATH), &serde_json::to_vec(&complete).expect("complete encodes"))?;
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
            let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| Blocked::journal(format!("manifest.json: {e}")))?;
            let journal = Journal::open(&journal_path, &manifest)?.ok_or_else(|| Blocked::journal("journal vanished"))?;
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
            PlanEntry { manifest_sha256: Text::try_from(sha.as_str()).map_err(Blocked::journal)?, items: manifest.items.len() as u64 },
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
                        (ItemState::Disposed, None) if p.expired.is_some() => ItemState::Expired,
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
            let named = item.sources.iter().map(|source| (source.root, &source.path)).chain(item.late_sources.iter().map(|source| (source.root, &source.path)));
            named.filter_map(|(root, path)| durable::modified(&shared.roots.resolve(root, path).ok()?)).max()
        };
        items.sort_by_cached_key(|item| std::cmp::Reverse(newest(item)));
    }

    /// Drives one item, and tells the hook of a session it leaves verified.
    fn settle(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        self.drive(shared, cx, item)?;
        let Some(id) = item.key.as_str().strip_prefix("session/") else {
            return Ok(());
        };
        let state = shared.journal.lock().expect("journal").progress(item.key.as_str()).map(|p| p.state);
        if let Some(hook) = self.options.verified.as_ref().filter(|_| state == Some(ItemState::Verified)) {
            hook(id);
        }
        if let Some(waiting) = shared.waiting {
            let how = match state {
                Some(ItemState::Verified) => Settled::Verified,
                Some(ItemState::Quarantined) => Settled::Quarantined,
                _ => Settled::Removed,
            };
            waiting.settled(id, how);
        }
        Ok(())
    }

    /// The next session asked for first that no converter is on, claimed.
    fn asked<'i>(shared: &'i Shared<'_>, waiting: &Waiting) -> Option<&'i ManifestItem> {
        while let Some(id) = waiting.asked() {
            let key = format!("session/{id}");
            match shared.manifest.items.binary_search_by(|item| item.key.as_str().cmp(&key)) {
                Ok(at) => return Some(&shared.manifest.items[at]),
                Err(_) => waiting.settled(&id, Settled::Removed),
            }
        }
        None
    }

    /// The retention judgement of the sessions, made once and before any of them converts: every session still planned
    /// that the product's retention deletes ([`Retention`]) is journaled `expired`, then the `judged` phase closes the
    /// judgement with its time, whatever the verdicts. Before the phase only a session that is opened and that no verdict
    /// can delete converts ([`Retention::candidate`]). A run that finds the phase judges nothing, on whatever day it runs;
    /// one cut before it judges again, at the time of the first verdict when there is one. Each session's header is read
    /// once, by the sources its conversion would read. A session whose deletion is more than removing its own files
    /// ([`RetentionFacts::bound`], or one a goal, a connector conversation or a worktree names) is never settled here: it
    /// converts and is left to the product's retention. So is one a person has asked for: an open is either seen by the
    /// verdict, which then keeps the session and its tree, or finds the session already gone ([`Waiting::expire`]).
    /// Opens are served at every moment of it ([`Self::while_serving`]): one of a session no verdict can delete waits
    /// for nothing here, neither the verdict nor the withdrawal of the expired sessions' rows; one of a candidate is
    /// served as soon as the phase is journaled.
    fn judge(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, items: &[&ManifestItem]) -> Result<()> {
        let Some(retention) = &self.options.retention else { return Ok(()) };
        let state = |item: &ManifestItem| shared.journal.lock().expect("journal").progress(item.key.as_str()).map(|p| p.state);
        let of_state = |wanted: ItemState| -> Vec<String> {
            items.iter().filter(|item| state(item) == Some(wanted)).filter_map(|item| item.key.as_str().strip_prefix("session/")).map(str::to_owned).collect()
        };
        let linked = crate::stores::linked_session_ids(cx)?;
        let fields = retention.fields();
        let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
        let read: Mutex<ReadHeaders> = Mutex::default();
        let next = AtomicUsize::new(0);
        // The candidates asked for that wait for the judgement to close, in the order they were asked for; `None` once
        // it is closed.
        let judged = shared.journal.lock().expect("journal").judged().is_some();
        let deferred: Mutex<Option<Vec<String>>> = Mutex::new((!judged).then(Vec::new));
        let facts_of = |item: &ManifestItem, id: &str| -> Result<()> {
            if read.lock().expect("retention facts").contains_key(id) || matches!(state(item), None | Some(ItemState::Quarantined | ItemState::Disposed)) {
                return Ok(());
            }
            let item = shared.with_sources(item)?;
            if let Some(facts) = self.driver(&item)?.retention_facts(cx, &item, &fields)? {
                let bound = facts.bound || linked.contains(id);
                read.lock().expect("retention facts").insert(id.to_owned(), (facts.header, bound));
            }
            Ok(())
        };
        // A session someone opens. One that no verdict can delete waits for nothing of the judgement; a candidate waits
        // for it to close, and is kept by it.
        let opened = |item: &ManifestItem| -> Result<()> {
            let Some(id) = item.key.as_str().strip_prefix("session/") else { return Ok(()) };
            if deferred.lock().expect("deferred opens").is_some() {
                facts_of(item, id)?;
                let candidate = read.lock().expect("retention facts").get(id).is_some_and(|(header, _)| retention.candidate(id, header));
                if candidate && let Some(deferred) = deferred.lock().expect("deferred opens").as_mut() {
                    deferred.push(id.to_owned());
                    if let Some(waiting) = shared.waiting {
                        waiting.defer(id);
                    }
                    return Ok(());
                }
            }
            self.settle(shared, cx, item)
        };
        if judged {
            return self.while_serving(shared, &opened, || {
                retention.unlisted(&of_state(ItemState::Expired));
                Ok(())
            });
        }
        on_threads(
            self.options.workers.max(1),
            || match shared.waiting.and_then(|waiting| Self::asked(shared, waiting)) {
                Some(item) => Some((item, true)),
                None => items.get(next.fetch_add(1, Ordering::Relaxed)).map(|item| (*item, false)),
            },
            |(item, asked)| match item.key.as_str().strip_prefix("session/") {
                Some(_) if asked => opened(item),
                Some(id) => facts_of(item, id),
                None => Ok(()),
            },
        )?;
        // Every session is read: the verdict, its record and the withdrawal of the rows, while the opens are served.
        self.while_serving(shared, &opened, || {
            let facts = read.lock().expect("retention facts").clone();
            let now = shared.journal.lock().expect("journal").judged_at().unwrap_or_else(|| retention.now_ms());
            // Converted, or on the way, by a run of before the judgement existed: in use.
            let converted: BTreeSet<String> = [ItemState::Staged, ItemState::Published, ItemState::Verified].into_iter().flat_map(&of_state).collect();
            let planned: BTreeSet<String> = of_state(ItemState::Planned).into_iter().collect();
            let headers: BTreeMap<String, serde_json::Map<String, serde_json::Value>> =
                facts.iter().map(|(id, (header, _))| (id.clone(), header.clone())).collect();
            let verdict = |awaited: &BTreeSet<String>| -> BTreeSet<String> {
                let held: BTreeSet<String> = converted.union(awaited).cloned().collect();
                let mut expired = retention.expired(&headers, &held, now);
                expired.retain(|id| planned.contains(id) && !held.contains(id) && facts.get(id).is_some_and(|(_, bound)| !*bound));
                expired
            };
            // Only a candidate asked for changes a verdict: the sessions no verdict reads come and go meanwhile.
            let candidates = |awaited: &BTreeSet<String>| -> BTreeSet<String> {
                awaited.iter().filter(|id| headers.get(*id).is_some_and(|header| retention.candidate(id, header))).cloned().collect()
            };
            let expired = match shared.waiting {
                Some(waiting) => loop {
                    let seen = waiting.awaited();
                    let expired = verdict(&seen);
                    if waiting.expire(&expired, |awaited| candidates(awaited) == candidates(&seen)) {
                        break expired;
                    }
                },
                None => verdict(&BTreeSet::new()),
            };
            for id in &expired {
                let k = format!("session/{id}");
                let Ok(at) = shared.manifest.items.binary_search_by(|item| item.key.as_str().cmp(&k)) else { continue };
                shared.record(&format!("expired:{k}"), JournalRecord::Expired(ExpiredEntry { key: key(&shared.manifest.items[at]), judged_at: now }))?;
            }
            shared.record("judged", JournalRecord::Phase(PhaseEntry { phase: Phase::Judged, at: Some(now) }))?;
            // The judgement is closed: the candidates that waited for it are served now, ahead of the rows' withdrawal.
            let waited = deferred.lock().expect("deferred opens").take().unwrap_or_default();
            if let Some(waiting) = shared.waiting {
                waiting.again(waited);
            }
            let settled = of_state(ItemState::Expired);
            retention.unlisted(&settled);
            let mut judged = shared.judged.lock().expect("judged headers");
            for id in settled {
                if let Some((header, _)) = facts.get(&id) {
                    judged.insert(id, header.clone());
                }
            }
            Ok(())
        })
    }

    /// Runs `work` while the sessions asked for are served by `opened` on the converters' threads: nobody who opens a
    /// session waits for `work`. Without a serving core there is nobody to ask, and `work` runs alone.
    fn while_serving(&self, shared: &Shared<'_>, opened: &(impl Fn(&ManifestItem) -> Result<()> + Sync), work: impl FnOnce() -> Result<()>) -> Result<()> {
        let Some(waiting) = shared.waiting else { return work() };
        struct Stop<'a>(&'a std::sync::atomic::AtomicBool, &'a Waiting);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
                self.1.wake();
            }
        }
        let stop = std::sync::atomic::AtomicBool::new(false);
        let failure: Mutex<Option<Blocked>> = Mutex::new(None);
        let done = std::thread::scope(|scope| {
            for _ in 0..self.options.workers.max(1) {
                scope.spawn(|| {
                    while let Some(id) = waiting.next_asked(&stop) {
                        let key = format!("session/{id}");
                        let served = match shared.manifest.items.binary_search_by(|item| item.key.as_str().cmp(&key)) {
                            Ok(at) => opened(&shared.manifest.items[at]),
                            Err(_) => {
                                waiting.settled(&id, Settled::Removed);
                                Ok(())
                            }
                        };
                        if let Err(error) = served {
                            failure.lock().expect("failure").get_or_insert(error);
                            let _stop = Stop(&stop, waiting);
                            break;
                        }
                    }
                });
            }
            let _stop = Stop(&stop, waiting);
            work()
        });
        done?;
        match failure.into_inner().expect("failure") {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The next item a converter of the session wave takes: a session asked for first, else the next of `items` in order
    /// that no other converter is on.
    fn take<'i>(&self, shared: &'i Shared<'_>, waiting: &Waiting, items: &[&'i ManifestItem], next: &AtomicUsize) -> Option<&'i ManifestItem> {
        loop {
            if let Some(item) = Self::asked(shared, waiting) {
                return Some(item);
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
        let workers = if wave == Wave::Sessions { self.options.workers.max(1) } else { 1 };
        let waiting = shared.waiting.filter(|_| wave == Wave::Sessions);
        if wave == Wave::Sessions {
            self.judge(shared, &cx, items)?;
        }
        let next = AtomicUsize::new(0);
        on_threads(
            workers,
            || match waiting {
                Some(waiting) => self.take(shared, waiting, items, &next),
                None => items.get(next.fetch_add(1, Ordering::Relaxed)).copied(),
            },
            |item| self.settle(shared, &cx, item),
        )
    }

    /// Writes `reason.json`, withdraws a published target, then journals `quarantined`.
    fn quarantine(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem, code: QuarantineCode, detail: String) -> Result<()> {
        let k = item.key.as_str();
        let reason =
            QuarantineReason { format: REASON_FORMAT, key: k.to_string(), code, expected: code.expected(), detail, sources: quarantined_sources(item) };
        let dir = quarantine_dir(&self.roots.data, code, k);
        shared.fault(&format!("reason:{k}:before"))?;
        durable::publish_file(&dir.join(REASON_FILE), &serde_json::to_vec(&reason).expect("reason encodes"))?;
        shared.fault(&format!("reason:{k}:after"))?;
        self.finish_quarantine(shared, cx, item, code)
    }

    fn quarantine_intent(shared: &Shared<'_>, item: &ManifestItem) -> Result<Option<QuarantineCode>> {
        let k = item.key.as_str();
        let Some(paths) = shared.quarantine_reasons.get(&escape_key(k)) else {
            return Ok(None);
        };
        let mut intent = None;
        for (code, path) in paths {
            let Some(bytes) = durable::read_optional(path)? else { continue };
            let reason: QuarantineReason = serde_json::from_slice(&bytes).map_err(|error| Blocked::journal(format!("{}: {error}", path.display())))?;
            if intent.is_some()
                || reason.format != REASON_FORMAT
                || reason.key != k
                || reason.code != *code
                || reason.expected != code.expected()
                || reason.sources != quarantined_sources(item)
            {
                return Err(Blocked::journal(format!("{}: quarantine reason does not match the active item", path.display())));
            }
            intent = Some(*code);
        }
        Ok(intent)
    }

    fn finish_quarantine(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem, code: QuarantineCode) -> Result<()> {
        let k = item.key.as_str();
        self.driver(item)?.withdraw(cx, item)?;
        // A resumed withdrawal can need its stage (for example, the rows it
        // deletes). Leave cleanup to the normal pass once disposition is durable.
        shared.record(&format!("quarantined:{k}"), JournalRecord::Quarantined(QuarantinedEntry { key: key(item), code }))
    }

    fn drive(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        let driver = self.driver(item)?;
        // A session's files are hashed and journaled here, before its first step: every step below, of this run or of
        // one that resumes it, reads the item by those sources.
        let item = shared.with_sources(item)?;
        let item = &*item;
        let k = item.key.as_str();
        loop {
            let progress = shared.journal.lock().expect("journal").progress(k).cloned().ok_or_else(|| Blocked::journal(format!("{k} not journaled")))?;
            if matches!(progress.state, ItemState::Planned | ItemState::Published)
                && let Some(code) = Self::quarantine_intent(shared, item)?
            {
                return self.finish_quarantine(shared, cx, item, code);
            }
            match (item.contract, progress.state) {
                (_, ItemState::Verified | ItemState::Quarantined | ItemState::Expired | ItemState::Disposed) => {
                    return Ok(());
                }
                (Contract::Retire, ItemState::Planned) | (_, ItemState::Published) => match driver.verify(cx, item)? {
                    Verdict::Verified { digest } => {
                        shared.record(&format!("verified:{k}"), JournalRecord::Verified(VerifiedEntry { key: key(item), digest }))?
                    }
                    Verdict::Quarantine { code, detail } => self.quarantine(shared, cx, item, code, detail)?,
                },
                (_, ItemState::Planned) => {
                    durable::remove_dir_all(&cx.stage_dir(k))?;
                    match driver.stage(cx, item)? {
                        Staged::Output { output_sha256, replaced_surrogates } if item.contract != Contract::Retain => shared.record(
                            &format!("staged:{k}"),
                            JournalRecord::Staged(StagedEntry {
                                key: key(item),
                                output_sha256: Text::try_from(output_sha256).map_err(Blocked::journal)?,
                                replaced_surrogates,
                            }),
                        )?,
                        Staged::Output { .. } => {
                            return Err(Blocked::journal(format!("{k}: a retain item staged output")));
                        }
                        Staged::Quarantine { code, detail } => self.quarantine(shared, cx, item, code, detail)?,
                    }
                }
                (_, ItemState::Staged) => {
                    let staged = progress.staged.ok_or_else(|| Blocked::journal(format!("{k} staged without entry")))?;
                    shared.fault(&format!("publish:{k}:before"))?;
                    driver.publish(cx, item, &staged)?;
                    shared.fault(&format!("publish:{k}:after"))?;
                    shared.record(&format!("published:{k}"), JournalRecord::Published(KeyEntry { key: key(item) }))?;
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
        // Finishing a session settled `expired` is the product's deletion of it, which only the serving core can do: a
        // run without it disposes of nothing, and the next start of the core finishes the migration.
        if self.options.retention.is_none() {
            let journal = shared.journal.lock().expect("journal");
            let left = shared.manifest.items.iter().filter(|item| journal.progress(item.key.as_str()).is_some_and(|p| p.state == ItemState::Expired)).count();
            if left > 0 {
                return Err(Blocked::journal(format!(
                    "{left} sessions were settled as expired by the serving core, which alone removes what it kept of them: start the core to finish the migration"
                )));
            }
        }
        // A session item shares no source and no quarantine folder with any other item, so the sessions (the bulk of the
        // bytes hashed again here) are disposed of side by side; the rest, which includes the catalog database and its
        // journal files, one after another in key order.
        let (sessions, rest): (Vec<&ManifestItem>, Vec<&ManifestItem>) = shared.manifest.items.iter().partition(|item| item.kind == ItemKind::Session);
        for item in rest {
            self.dispose_item(shared, &cx, item)?;
        }
        let next = AtomicUsize::new(0);
        on_threads(self.options.workers.max(1), || sessions.get(next.fetch_add(1, Ordering::Relaxed)).copied(), |item| self.dispose_item(shared, &cx, item))?;
        self.dispose_shared_files(shared, &cx)
    }

    fn dispose_item(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        let item = shared.with_sources(item)?;
        let item = &*item;
        let k = item.key.as_str();
        let progress = shared.journal.lock().expect("journal").progress(k).cloned().ok_or_else(|| Blocked::journal(format!("{k} not journaled")))?;
        let driver = self.driver(item)?;
        match progress.state {
            ItemState::Disposed => return Ok(()),
            ItemState::Verified => {
                // Sources kept are the target, or a database that is not Mixdog's.
                if !(driver.keeps_sources(item) || crate::stores::keeps_catalog_item(item, &self.roots.data)) {
                    self.remove_sources(shared, cx, item)?;
                }
            }
            ItemState::Expired => {
                // The product's deletion of what it keeps of the session outside these files goes first, and only while
                // every source is there: a run cut after it began removing them has done this.
                let retention =
                    self.options.retention.as_ref().ok_or_else(|| Blocked::journal(format!("{k}: an expired session is disposed of by the serving core")))?;
                let mut whole = true;
                for source in &item.sources {
                    whole &= durable::exists(&cx.source_path(source)?)?;
                }
                if whole {
                    let id = k.strip_prefix("session/").unwrap_or(k);
                    let judged = shared.judged.lock().expect("judged headers").get(id).cloned();
                    let header = match judged {
                        Some(header) => Some(header),
                        None => {
                            let fields = retention.fields();
                            let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
                            driver.retention_facts(cx, item, &fields)?.map(|facts| facts.header)
                        }
                    };
                    let header = header.ok_or_else(|| Blocked::journal(format!("{k}: the header it was judged by no longer reads")))?;
                    shared.fault(&format!("purge:{k}:before"))?;
                    retention.purge(id, &header).map_err(|error| Blocked::journal(format!("{k}: {error}")))?;
                }
                self.remove_sources(shared, cx, item)?;
            }
            ItemState::Quarantined => {
                let code = progress.quarantined.ok_or_else(|| Blocked::journal(format!("{k} without code")))?;
                let dir = quarantine_dir(&self.roots.data, code, k);
                let names = quarantine_names(item);
                let mut kept_all = true;
                for (source, name) in item.sources.iter().zip(&names) {
                    if driver.keeps_quarantined_source(cx, item, source) {
                        continue;
                    }
                    kept_all = false;
                    self.quarantine_source(shared, cx, item, source, name, &dir)?;
                }
                // Shared files this item read (pending entries, worker rows) travel
                // with it as copies, so the export holds everything it was made of.
                if !kept_all {
                    for file in cx.shared_for(k) {
                        let path = cx.source_path(file)?;
                        if let Some(bytes) = durable::read_optional(&path)? {
                            let name = format!("shared-{}", file.path.replace('/', "%2F"));
                            durable::publish_file(&dir.join(name), &bytes)?;
                        }
                    }
                }
            }
            other => {
                return Err(Blocked::journal(format!("{k} is {other:?} at disposal")));
            }
        }
        shared.record(&format!("disposed:{k}"), JournalRecord::Disposed(KeyEntry { key: key(item) }))
    }

    /// Deletes `item`'s sources, each only as planned: by size and hash when a core serves, by `rehash` otherwise.
    fn remove_sources(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem) -> Result<()> {
        let k = item.key.as_str();
        if self.core_serves() {
            for source in &item.sources {
                shared.fault(&format!("delete:{k}:before"))?;
                durable::remove_if_planned(&cx.source_path(source)?, source.size, &source.sha256)?;
            }
        } else {
            for path in self.rehash(cx, item)? {
                shared.fault(&format!("delete:{k}:before"))?;
                durable::remove_file(&path)?;
            }
        }
        Ok(())
    }

    fn dispose_shared_files(&self, shared: &Shared<'_>, cx: &ItemContext<'_>) -> Result<()> {
        let by_key: BTreeMap<&str, &ManifestItem> = shared.manifest.items.iter().map(|i| (i.key.as_str(), i)).collect();
        for file in &shared.manifest.shared {
            let mut keep = false;
            for consumer in &file.consumers {
                let item = by_key.get(consumer.as_str()).ok_or_else(|| Blocked::journal(format!("unknown consumer {consumer}")))?;
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

    fn quarantine_source(&self, shared: &Shared<'_>, cx: &ItemContext<'_>, item: &ManifestItem, source: &SourceFile, name: &str, dir: &Path) -> Result<()> {
        use mixdog_store::fsio;

        let k = item.key.as_str();
        let path = cx.source_path(source)?;
        let target = dir.join(name);
        let expected = (source.size, source.sha256.clone());
        if durable::exists(&target)? {
            if durable::hash_file(&target)? != expected {
                return Err(Blocked::TargetConflict { key: k.to_owned(), path: target });
            }
        } else {
            let stage = cx.stage_dir(k).join("quarantine-copy").join(name);
            let stage_dir = stage.parent().expect("quarantine stage parent");
            // Retry from the checked bytes before consulting the live name:
            // they may be the only surviving copy of the planned original.
            if durable::exists(&stage)? && durable::hash_file(&stage)? == expected {
                durable::sync_file(&stage)?;
            } else {
                if !self.core_serves() && !durable::exists(&path)? {
                    return Ok(());
                }
                shared.fault(&format!("move:{k}:before"))?;
                if !self.core_serves() {
                    if durable::hash_file(&path)? != expected {
                        return Err(Blocked::SourceChanged { path });
                    }
                    durable::create_dir_all(dir)?;
                    durable::step(durable::Step::Rename, &target, &[]);
                    match fsio::rename_replace(&path, &target) {
                        Ok(()) => {
                            durable::step(durable::Step::SyncDir, &target, &[]);
                            return fsio::sync_rename_parents(&path, &target).map_err(Blocked::fsio);
                        }
                        Err(error) if error.source.kind() == std::io::ErrorKind::CrossesDevices => {}
                        Err(error) => return Err(Blocked::fsio(error)),
                    }
                }

                // With a serving writer, renaming the live name after hashing
                // it could move the writer's replacement instead.
                durable::create_dir_all(stage_dir)?;
                if !durable::stage_copy(&path, &stage, source.secret, self.core_serves())? {
                    return Ok(());
                }
                if durable::hash_file(&stage)? != expected {
                    if self.core_serves() {
                        return Ok(());
                    }
                    return Err(Blocked::SourceChanged { path });
                }
            }
            durable::sync_dir(stage_dir)?;
            shared.fault(&format!("quarantine-copy:{k}:{name}:verified"))?;
            durable::create_dir_all(dir)?;
            durable::durable_rename(&stage, &target)?;
        }
        // An exact target can be from an interrupted copy (even if the
        // original is now aside). Never remove a source that has since changed.
        durable::sync_dir(dir)?;
        if let Some(parent) = path.parent().filter(|parent| *parent != dir)
            && durable::exists(parent)?
        {
            durable::sync_dir(parent)?;
        }
        durable::remove_if_planned(&path, source.size, &source.sha256)
    }

    fn counts(&self, shared: &Shared<'_>) -> Result<CompleteKinds> {
        let states = self.states(shared);
        let cx = shared.cx(&states);
        let zero = Counts { verified: 0, quarantined_expected: 0, quarantined_unexpected: 0, retired: 0, retained: 0, dangling: 0, expired: 0 };
        let mut kinds = CompleteKinds { data: zero, desktop_profile: zero };
        // Counting a session's dangling references reads it whole, so the verified items are counted side by side first.
        let verified: Vec<&ManifestItem> = {
            let journal = shared.journal.lock().expect("journal");
            shared
                .manifest
                .items
                .iter()
                .filter(|item| {
                    item.contract != Contract::Retire && journal.progress(item.key.as_str()).is_some_and(|p| p.quarantined.is_none() && p.expired.is_none())
                })
                .collect()
        };
        let dangling = map_on_threads(self.options.workers.max(1), &verified, |item| self.driver(item)?.dangling(&cx, item))?;
        let dangling: BTreeMap<&str, u64> = verified.iter().map(|item| item.key.as_str()).zip(dangling).collect();
        let journal = shared.journal.lock().expect("journal");
        for item in &shared.manifest.items {
            let counts = match item.group {
                KindGroup::Data => &mut kinds.data,
                KindGroup::DesktopProfile => &mut kinds.desktop_profile,
            };
            let progress = journal.progress(item.key.as_str()).ok_or_else(|| Blocked::journal("item not journaled"))?;
            if progress.expired.is_some() {
                counts.expired += 1;
                continue;
            }
            match progress.quarantined {
                Some(code) if !code.expected() => counts.quarantined_unexpected += 1,
                Some(_) if item.contract == Contract::Retain => counts.retained += 1,
                Some(_) => counts.quarantined_expected += 1,
                None if item.contract == Contract::Retire => counts.retired += 1,
                None => {
                    counts.verified += 1;
                    counts.dangling += dangling.get(item.key.as_str()).copied().unwrap_or_default();
                }
            }
        }
        Ok(kinds)
    }
}

pub mod cli;
#[cfg(test)]
mod registry_import_tests;
#[cfg(test)]
mod retention_tests;
#[cfg(test)]
#[path = "run/migration_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
mod watch_tests {
    use super::*;

    fn ids(sessions: &[&str]) -> Vec<String> {
        sessions.iter().map(|session| (*session).to_owned()).collect()
    }

    /// A serving core withdraws the row of a session set aside, and counts what has settled, by what the watch is told: of each
    /// session once, after it has stopped being one still to settle (so the count read then includes it) and before the open
    /// waiting on it goes on; of nothing a run that ends early leaves, which stays to convert at the next start.
    #[test]
    fn a_watch_is_told_each_session_once_as_it_settles_and_nothing_a_run_left() {
        let waiting = Arc::new(Waiting::default());
        waiting.state().open = ids(&["a", "b", "c", "d"]).into_iter().collect();
        type Told = Vec<(Vec<String>, Settled, Vec<String>)>;
        let told: Arc<Mutex<Told>> = Arc::default();
        let pending = {
            let (told, weak) = (told.clone(), Arc::downgrade(&waiting));
            waiting.watch(Arc::new(move |sessions: &[String], how| {
                let still = weak.upgrade().map(|waiting| waiting.pending()).unwrap_or_default();
                told.lock().unwrap().push((sessions.to_vec(), how, still));
            }))
        };
        assert_eq!(pending, ids(&["a", "b", "c", "d"]));
        let opened = Arc::new(Mutex::new(Vec::new()));
        let (seen, at_open) = (told.clone(), opened.clone());
        assert!(waiting.first("b", Box::new(move || at_open.lock().unwrap().push(seen.lock().unwrap().len()))));
        waiting.settled("a", Settled::Verified);
        waiting.settled("b", Settled::Quarantined);
        waiting.settled("b", Settled::Quarantined);
        assert!(waiting.expire(&BTreeSet::from(["c".to_owned()]), |_| true));
        waiting.ended();
        assert_eq!(
            *told.lock().unwrap(),
            [
                (ids(&["a"]), Settled::Verified, ids(&["b", "c", "d"])),
                (ids(&["b"]), Settled::Quarantined, ids(&["c", "d"])),
                (ids(&["c"]), Settled::Removed, ids(&["d"])),
            ],
            "each once, none of what the run left"
        );
        assert_eq!(*opened.lock().unwrap(), [2], "the open of b went on once the watch had been told of it");
    }
}

/// Leave the reason, shared exports and generated source names in separate
/// namespaces. Preserve the old names when they are already unambiguous.
fn quarantine_names(item: &ManifestItem) -> Vec<String> {
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let bases: Vec<String> = item.sources.iter().map(|s| base(&s.path)).collect();
    let canonical = |name: &str| name.trim_end_matches([' ', '.']).to_ascii_lowercase();
    let unique: BTreeSet<String> = bases.iter().map(|name| canonical(name)).collect();
    let mut names = if unique.len() == bases.len() { bases } else { item.sources.iter().map(|s| escape_key(&s.path)).collect() };
    let mut used = BTreeSet::new();
    for (index, name) in names.iter_mut().enumerate() {
        let folded = canonical(name);
        if folded == REASON_FILE || folded.starts_with("shared-") || folded.starts_with("source-") || !used.insert(folded) {
            *name = format!("source-{index}");
        }
    }
    names
}
