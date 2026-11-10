//! The `Config` actor over `mixdog-config.json` (DS §3, SPEC R14, R30).
//!
//! One document, always whole: every read, every published view and the model catalog are built
//! from the full config (secrets included), and a write is applied to a copy of that same full
//! document. No API replaces the document with a part of it, which is how the catalog went blind
//! to its credentials (#327). Reads are lock-free (`ArcSwap`); writers are serialized by the
//! `Config` key, persist atomically (write, fsync, rename) and publish only after the file is
//! durable. The service runs its own file work as lane jobs, so no caller can block a runtime
//! thread: opening and reloading read on the io-interactive lane, writes (and installing a
//! reload) run on the io-durability lane. The file functions take the lane's `InLane` proof.
//!
//! Only the subtrees in [`PUBLISHED_SUBTREES`] reach clients through the `config` section; the
//! rest of the document (provider credentials among it) is never serialized to a client.

pub mod agent_routes;
mod agent_store;
mod canonical;
mod guard;
mod separation;
mod desktop_separation;
pub(crate) use separation::source_mode;
mod storage;
mod browser_permissions;
mod network_proxy_store;
pub mod patch;
mod settings;
mod desktop;
mod notifications;
pub mod output_style;
pub mod hidden_agents;
mod schema;
pub mod seams;
mod service;
pub mod secret_changes;
mod watch;

pub use secret_changes::AnnouncingStore;
pub use secret_changes::SecretChanges;
pub use seams::ConfigFeatureGate;
pub use service::ConfigService;
pub use watch::ConfigWatcher;
pub use service::set_worktree_settings;
pub use seams::ConfigLocalProviderSettings;
pub use seams::ConfigVoiceEnabled;
pub use seams::ConfigVoiceSettings;
pub use seams::ConfigWorktreeSettings;
pub use seams::LocalCatalogRefresh;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use arc_swap::ArcSwap;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::ConfigWriteMode;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneToken;
use serde_json::Map;
use serde_json::Value;

pub use output_style::OutputStyles;
pub use settings::{normalize_profile, PROFILE_EXPERIENCE_LEVELS, PROFILE_LANGUAGES};
pub use settings::NoEffects;
pub(crate) use settings::save_and_adopt;
pub use settings::Settings;
pub use settings::SettingsEffects;
pub use settings::SettingsEnv;
pub use agent_routes::agent_disabled;
pub use agent_routes::bot_migration;
pub use agent_routes::is_store_bot;
pub use agent_routes::DEFAULT_MIXY_NAME;
pub use agent_routes::mixy_display_name;
pub use agent_routes::mixy_identity_dir;
pub use agent_routes::AgentRoutes;
pub use agent_routes::MIXY_RUNTIME_ID;
pub use agent_routes::RouteHome;
pub use desktop::ActivityRailPins;
pub use desktop::DesktopSettings;
pub use desktop::SessionRetention;
pub use desktop::browser_cookie_auto_import;
pub use desktop::desktop_settings;
pub use desktop::session_retention;

use mixdog_core_base::state::change_of;

use crate::user_data::UserData;

/// The file section Node's agent config (`readSection('agent')`) lives in.
pub const AGENT_SECTION: &str = "agent";

/// Top-level keys projected into the `config` section (one section key per subtree), each with
/// the Node consumer that reads it today. A subtree with no desktop consumer is not published;
/// its owner reads it through [`Config::get`].
pub const PUBLISHED_SUBTREES: &[&str] = &[
    // `desktopSettingsFromConfig`, activity-rail pins, browser cookie auto-import, session
    // retention (`settings-store.ts`), and `turnNotifications` (`desktop-service.ts`).
    "desktop",
    // `agent.autoClear` / `agent.compaction` in `desktopSettingsFromConfig`, and the
    // orchestration default (`orchestration-mode-watch.ts`).
    "agent",
    // Notification preferences: the storage half of `notification-preferences.ts`, which this
    // store absorbs (DS §3).
    "notifications",
    // The quota auto-resume switch (`getQuotaAutoResume`; written with `config/value/write`, `desktop-services.md` A2/D1).
    "quotaAutoResume",
];

#[derive(Debug)]
pub enum ConfigError {
    /// `-32602 invalidParams{path, expected}`.
    InvalidParams { path: String, expected: String },
    /// The file exists but is not a JSON object; nothing is replaced, so nothing is lost.
    Parse(String),
    Io(std::io::Error),
    /// The atomic write of the file failed at one `fs` call; the step is what lets a caller word
    /// the error as Node throws it.
    Publish(mixdog_statefile::PublishFailure),
    /// The lane's queue is full: the caller answers `overloaded` at once.
    Overloaded(LaneFull),
    /// The job was dropped before it finished (shutdown).
    Stopped,
    /// A caller's change refused the edit with its own error, which `core_error` returns as is.
    Rejected(mixdog_core_api::CoreError),
    /// The user-data guard refused: a damaged init marker, or a lost config with no backup to start a write from. `code`
    /// is Node's `err.code` (`EUSERDATARECOVERY`).
    UserData { code: Option<&'static str>, message: String },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::InvalidParams { path, expected } => {
                write!(f, "invalid value for {path}: expected {expected}")
            }
            ConfigError::Parse(message) => write!(f, "mixdog-config.json is not valid: {message}"),
            ConfigError::Io(error) => write!(f, "mixdog-config.json: {error}"),
            ConfigError::Publish(failure) => write!(f, "mixdog-config.json: {}", failure.error),
            ConfigError::Overloaded(full) => full.fmt(f),
            ConfigError::Stopped => f.write_str("the config job was dropped before it finished"),
            ConfigError::Rejected(error) => write!(f, "{error:?}"),
            ConfigError::UserData { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for ConfigError {}

impl ConfigError {
    /// The text Node's `error.message` carries for the same failure: a failed file step is `<CODE>: <description>,
    /// <syscall> '<path>'` (`EEXIST: file already exists, mkdir '<data>/backups'`).
    pub fn node_message(&self) -> String {
        use mixdog_core_base::support::FsFailure;
        use mixdog_core_base::support::FsStep;
        use mixdog_statefile::Step;
        let ConfigError::Publish(failure) = self else { return self.to_string() };
        let step = match &failure.step {
            Step::Mkdir(dir) => FsStep::Mkdir(dir.clone()),
            Step::Open(file) => FsStep::Open(file.clone()),
            Step::Read => FsStep::Read,
            Step::Write | Step::Other => FsStep::Write,
            Step::Fsync => FsStep::Fsync,
            Step::Rename(from, to) => FsStep::Rename(from.clone(), to.clone()),
        };
        // `io_failure` takes the error by value; the OS code (or else the kind) is all it reads.
        let error = failure.error.raw_os_error().map_or_else(|| std::io::Error::from(failure.error.kind()), std::io::Error::from_raw_os_error);
        match mixdog_core_base::support::io_failure("config", &FsFailure { error, step }) {
            mixdog_core_api::CoreError::DomainError { message: Some(message), .. } => message.to_string(),
            _ => self.to_string(),
        }
    }
}

impl From<std::io::Error> for ConfigError {
    fn from(error: std::io::Error) -> Self {
        ConfigError::Io(error)
    }
}

/// A stored value the core refuses to act on (`configWarning`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigWarning {
    pub path: String,
    pub message: String,
}

/// One edit of `config/value/write` / `config/batchWrite`.
#[derive(Debug, Clone)]
pub struct ConfigEdit {
    pub path: String,
    pub value: Value,
    pub mode: ConfigWriteMode,
}

/// What a write or reload changed.
#[derive(Debug, Default, PartialEq)]
pub struct Applied {
    /// Published subtrees whose value changed, each published once.
    pub changed: Vec<&'static str>,
    /// Warnings that were not raised by the previous document.
    pub warnings: Vec<ConfigWarning>,
}

type Doc = Map<String, Value>;

/// The lanes a `Config` runs its file work on, handed over by the composition root.
#[derive(Clone, Copy, Debug)]
pub struct ConfigLanes {
    /// Reads of the file (open, reload).
    pub read: InteractiveIo,
    /// Atomic writes, and installing what a reload read.
    pub write: DurabilityIo,
}

/// A cheap handle: clones share one document and one writer.
#[derive(Clone)]
pub struct Config {
    shared: Arc<Shared>,
    lanes: ConfigLanes,
}

struct Shared {
    path: PathBuf,
    /// The user-data guard over this config's data dir.
    guard: Arc<guard::Guard>,
    doc: ArcSwap<Doc>,
    keys: Vec<schema::Key>,
    publisher: Arc<dyn StatePublisher>,
    /// Serializes writers and reloads (the `Config` key); holds the warnings already raised.
    writer: Mutex<BTreeSet<String>>,
    /// Counts installed documents, so a reload that read the file before a write landed knows
    /// its read is stale.
    generation: AtomicU64,
    /// The generation again, for services that follow the document (`Config::changes`).
    changed: tokio::sync::watch::Sender<u64>,
    /// What runs inside each adoption ([`Config::on_adoption`]), by registration id.
    adoptions: Mutex<Vec<(u64, Adoption)>>,
    next_adoption: AtomicU64,
}

type Adoption = Arc<dyn Fn() + Send + Sync>;

/// A registration of [`Config::on_adoption`]; dropping it ends the hook (Node's unsubscribe when its runtime is disposed).
#[must_use = "the hook ends when the guard is dropped"]
pub struct AdoptionGuard {
    shared: std::sync::Weak<Shared>,
    id: u64,
}

impl Drop for AdoptionGuard {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            lock(&shared.adoptions).retain(|(id, _)| *id != self.id);
        }
    }
}

/// Runs `job` on `lane`; a full queue answers [`ConfigError::Overloaded`] at once.
async fn on_lane<L: LaneToken, R: Send + 'static>(
    lane: L,
    job: impl FnOnce(&InLane<L>) -> R + Send + 'static,
) -> Result<R, ConfigError> {
    lane.submit(&CancellationToken::new(), job)
        .map_err(ConfigError::Overloaded)?
        .await
        .map_err(|_| ConfigError::Stopped)
}

impl Config {
    /// Opens the file (absent = empty document; the document is the canonical one, so a retired
    /// key of an old install is never seen). An unreadable or non-object file is an error:
    /// a later write must never overwrite a document that could not be read. Publishes the
    /// current subtrees; the returned warnings are those of the opened document.
    pub async fn open(
        path: impl Into<PathBuf>,
        publisher: Arc<dyn StatePublisher>,
        lanes: ConfigLanes,
    ) -> Result<(Self, Vec<ConfigWarning>), ConfigError> {
        Self::open_guarded(path, publisher, lanes, UserData::process()).await
    }

    /// [`Config::open`] over a user-data guard of its own (its environment, clock, ids and log).
    ///
    /// The file is read as Node's first `readAll` reads it: a readable one settles the data dir's first snapshot; a missing
    /// one in an initialized dir, or a malformed one (kept aside as `<file>.corrupt-<ms>`), is restored from the newest
    /// complete backup of the dir and saved again (`user_data`).
    pub async fn open_guarded(
        path: impl Into<PathBuf>,
        publisher: Arc<dyn StatePublisher>,
        lanes: ConfigLanes,
        user_data: Arc<UserData>,
    ) -> Result<(Self, Vec<ConfigWarning>), ConfigError> {
        let path = path.into();
        let guard = Arc::new(guard::Guard::new(path.clone(), user_data));
        let doc = guard.read(lanes, false).await?;
        Ok(Self::assemble(path, guard, doc, publisher, lanes))
    }

    /// A handle over the file's document without the opening read, for replaying Node's `updateConfig` alone (which
    /// does not run `readConfig` first).
    #[cfg(test)]
    fn open_unread(path: PathBuf, publisher: Arc<dyn StatePublisher>, lanes: ConfigLanes, user_data: Arc<UserData>) -> Self {
        let guard = Arc::new(guard::Guard::new(path.clone(), user_data));
        // The in-memory document stands for the file while it is intact; a lost or damaged file is settled by the baseline.
        let doc = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Self::assemble(path, guard, doc, publisher, lanes).0
    }

    fn assemble(
        path: PathBuf,
        guard: Arc<guard::Guard>,
        doc: Doc,
        publisher: Arc<dyn StatePublisher>,
        lanes: ConfigLanes,
    ) -> (Self, Vec<ConfigWarning>) {
        let warnings = warnings_of(&doc);
        let raised = warnings.iter().map(|w| w.path.clone()).collect();
        let shared = Shared {
            path,
            guard,
            doc: ArcSwap::from_pointee(doc),
            keys: schema::registry(),
            publisher,
            writer: Mutex::new(raised),
            generation: AtomicU64::new(0),
            changed: tokio::sync::watch::channel(0).0,
            adoptions: Mutex::default(),
            next_adoption: AtomicU64::new(0),
        };
        let current = shared.doc.load();
        for name in PUBLISHED_SUBTREES {
            if let Some(value) = current.get(*name) {
                shared.publish(name, Some(value));
            }
        }
        drop(current);
        let config = Self {
            shared: Arc::new(shared),
            lanes,
        };
        (config, warnings)
    }

    /// Ticks after every installed document (write or external reload), for services that
    /// derive a view from the config and push it when it changes.
    pub fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.shared.changed.subscribe()
    }

    /// `hook` runs inside every adoption of a document (a write or an external reload), once for each adopted document, in the
    /// serialized order the documents are installed, after the document is the current one and before the write that caused it
    /// is acknowledged: Node's `adoptFullConfig` runs its dependents synchronously the same way. The hook must not write the
    /// config. It lasts until the guard is dropped.
    pub fn on_adoption(&self, hook: impl Fn() + Send + Sync + 'static) -> AdoptionGuard {
        let id = self.shared.next_adoption.fetch_add(1, Ordering::Relaxed);
        lock(&self.shared.adoptions).push((id, Arc::new(hook)));
        AdoptionGuard { shared: Arc::downgrade(&self.shared), id }
    }

    /// A change that is not in the document (a stored secret changed: [`SecretChanges`]) ticks
    /// [`Config::changes`] like an installed document does, so the services that follow the
    /// config have one signal to follow.
    pub(crate) fn announce_change(&self) {
        let generation = self.shared.generation.fetch_add(1, Ordering::Release) + 1;
        self.shared.changed.send_replace(generation);
    }

    /// Counts the documents installed so far; the `revision` of a write reply.
    pub fn revision(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    /// The whole document, secrets included.
    pub fn full(&self) -> Arc<Doc> {
        self.shared.doc.load_full()
    }

    /// The agent config: the `agent` section of the file, which holds the flat config the
    /// settings code of Node reads and writes (`providers`, `modules`, `recap`, `profile`,
    /// `compaction`, `autoClear`, `worktree`, …). Empty when the file has none.
    pub fn agent(&self) -> Doc {
        self.shared.doc.load().get(AGENT_SECTION).and_then(Value::as_object).cloned().unwrap_or_default()
    }

    /// The agent section as `loadConfig` reads it before it merges anything onto it:
    /// `canonicalizeAgentStorage` against the openai-oauth catalog saved beside the file
    /// (retired local providers and fields dropped, incomplete or superseded routes migrated,
    /// `providers` and `webSearchRoute` always present, …). The catalog is read as a lane job.
    pub async fn loaded_agent(&self) -> Result<Doc, ConfigError> {
        #[cfg(feature = "count-work")]
        crate::work::agent_rebuilt();
        let agent = self.agent();
        let dir = self.shared.path.parent().map(Path::to_path_buf).unwrap_or_default();
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        on_lane(self.lanes.read, move |_lane| {
            let catalog = storage::saved_catalog(&dir).unwrap_or_default();
            storage::canonical_agent_storage(&agent, &catalog, now_ms)
        })
        .await
    }

    /// `readSection('agent').instructionFiles`: the stored setting as written (`None` when the
    /// file has none); the caller normalises it, as Node does.
    pub fn stored_instruction_files(&self) -> Option<Value> {
        self.shared.doc.load().get(AGENT_SECTION)?.get("instructionFiles").cloned()
    }

    /// Edits the agent config under the same transaction as every other writer; every other
    /// section and key of the file stays. A section that did not exist is not created for an
    /// edit that leaves it empty.
    pub async fn update_agent(
        &self,
        change: impl FnOnce(&mut Doc) -> Result<(), ConfigError> + Send + 'static,
    ) -> Result<Applied, ConfigError> {
        self.update(move |doc| {
            let existing = doc.get(AGENT_SECTION).and_then(Value::as_object).cloned();
            let mut agent = existing.clone().unwrap_or_default();
            change(&mut agent)?;
            if existing.is_some() || !agent.is_empty() {
                doc.insert(AGENT_SECTION.into(), Value::Object(agent));
            }
            Ok(())
        })
        .await
    }

    /// `saveConfigAndAdopt`'s write: the stored form of `after` against that of `before`
    /// (what this writer started from), applied to the agent section in one transaction, so a
    /// field another writer changed meanwhile survives. `lead_fill` is a conditional Lead fill:
    /// its `default`/`presets` changes are skipped while a Lead route is already stored.
    /// Nothing is written when nothing differs.
    pub async fn save_agent_config(&self, before: &Doc, after: &Doc, lead_fill: bool) -> Result<Applied, ConfigError> {
        let mut changes = patch::create_config_patch(before, after);
        if lead_fill {
            changes = patch::guard_lead_fill(changes);
        }
        if !changes.is_empty() {
            let seeds = patch::seed_changes(after, &changes);
            changes.extend(seeds);
        }
        self.save_agent_patch(changes).await
    }

    /// Applies `changes` to the agent section (`saveConfigPatchAsync`); an empty patch writes
    /// nothing.
    pub async fn save_agent_patch(&self, changes: Vec<patch::ConfigChange>) -> Result<Applied, ConfigError> {
        if changes.is_empty() {
            return Ok(Applied::default());
        }
        self.update_agent(move |agent| {
            *agent = patch::apply_config_patch(agent, &changes);
            Ok(())
        })
        .await
    }

    /// `reloadFullConfig`: re-reads the file (a change another process made reaches the document
    /// and is published) and answers the agent config. Writes here are durable before they
    /// answer, so there is no pending edit to lay back on the reloaded document.
    pub async fn reload_full_config(&self) -> Result<Doc, ConfigError> {
        self.reload_read(false).await?;
        Ok(self.agent())
    }

    /// `confirmLeadFill(filled)`, the config half: re-reads the file and answers the Lead route
    /// it now holds when that differs from `filled` by provider and model (another process wrote
    /// one after the fill's re-read, so the fill's patch skipped it); `None` when the file's
    /// Lead route is `filled` itself or there is none. The caller replaces its Main route only
    /// while that still is `filled` (`adoptFillWinner`).
    pub async fn confirm_lead_fill(&self, filled: &Value) -> Result<Option<Value>, ConfigError> {
        let agent = self.reload_full_config().await?;
        let text = |route: &Value, key: &str| {
            mixdog_js::js_trim(&route.get(key).map(mixdog_js::value_to_string).filter(|_| !route[key].is_null()).unwrap_or_default())
                .to_owned()
        };
        let Some(winner) = patch::lead_route(&agent) else { return Ok(None) };
        if text(&winner, "model").is_empty()
            || (text(&winner, "provider") == text(filled, "provider") && text(&winner, "model") == text(filled, "model"))
        {
            return Ok(None);
        }
        Ok(Some(winner))
    }

    pub fn get(&self, path: &str) -> Option<Value> {
        let doc = self.shared.doc.load();
        let mut parts = path.split('.');
        let mut node = doc.get(parts.next()?)?;
        for part in parts {
            node = node.as_object()?.get(part)?;
        }
        Some(node.clone())
    }

    pub fn desktop_settings(&self) -> DesktopSettings {
        desktop_settings(&self.shared.doc.load())
    }

    pub fn session_retention(&self) -> Option<SessionRetention> {
        session_retention(&self.shared.doc.load())
    }

    pub fn activity_rail_pins(&self) -> Option<ActivityRailPins> {
        desktop::activity_rail_pins(self.shared.doc.load().get("desktop")?.get("activityRailPins"))
    }

    /// Boot: Node's notification store, on its first load with no document, writes one stamped `migratedAt: now`
    /// (`notification-preferences.ts:228`). Without it nothing reads the stamp as anything but 0, and every
    /// paired phone app would start from bot chats only. Run once after `open`, like `separate_defaults`: the
    /// golden-tested `open` itself writes nothing. An existing subtree is left as it is.
    pub async fn stamp_notifications(&self, now_ms: i64) -> Result<Applied, ConfigError> {
        self.update(move |doc| {
            if get_in(doc, &["notifications"]).is_none() {
                set_in(doc, &["notifications", "migratedAt"], Value::from(now_ms));
            }
            Ok(())
        })
        .await
    }

    /// `config/value/write`.
    pub async fn write(
        &self,
        path: &str,
        value: Value,
        mode: ConfigWriteMode,
    ) -> Result<Applied, ConfigError> {
        self.batch_write(&[ConfigEdit {
            path: path.to_owned(),
            value,
            mode,
        }])
        .await
    }

    /// `config/batchWrite`: all edits validate and apply, or none does.
    pub async fn batch_write(&self, edits: &[ConfigEdit]) -> Result<Applied, ConfigError> {
        let shared = self.shared.clone();
        let edits = edits.to_vec();
        self.update(move |doc| {
            for edit in &edits {
                shared.apply_edit(doc, edit)?;
            }
            Ok(())
        })
        .await
    }

    /// `batch_write`, answering also the named top-level subtrees of the document it saved (those present), read
    /// inside the same locked update.
    pub async fn batch_write_saved(
        &self,
        edits: &[ConfigEdit],
        subtrees: &'static [&'static str],
    ) -> Result<(Applied, serde_json::Map<String, Value>), ConfigError> {
        let shared = self.shared.clone();
        let edits = edits.to_vec();
        on_lane(self.lanes.write, move |lane| {
            let applying = shared.clone();
            shared.update_viewed(
                lane,
                move |doc| {
                    for edit in &edits {
                        applying.apply_edit(doc, edit)?;
                    }
                    Ok(())
                },
                |doc| {
                    subtrees
                        .iter()
                        .filter_map(|name| doc.get(*name).map(|v| ((*name).to_owned(), v.clone())))
                        .collect()
                },
            )
        })
        .await?
    }

    /// A typed in-process writer (catalog, accounts, …) edits the full document under the same
    /// transaction as the wire writes; `change` sees and keeps every key.
    pub async fn update(
        &self,
        change: impl FnOnce(&mut Doc) -> Result<(), ConfigError> + Send + 'static,
    ) -> Result<Applied, ConfigError> {
        let shared = self.shared.clone();
        on_lane(self.lanes.write, move |lane| shared.update_on(lane, change)).await?
    }

    /// Republishes an external edit of the file (called by the file watcher). Our own writes
    /// reload to an identical document and publish nothing. An invalid file keeps the current
    /// document and is reported.
    pub async fn reload(&self) -> Result<Applied, ConfigError> {
        self.reload_read(true).await
    }

    /// [`Config::reload`]; `in_pass` is a read of the change notification pass (the watch), where a file that does not
    /// parse is a write in progress. An explicit reload (`reload_full_config`) is a plain read, which keeps a damaged file
    /// aside and restores the last backup. A lost file in an initialized dir is restored in both.
    async fn reload_read(&self, in_pass: bool) -> Result<Applied, ConfigError> {
        loop {
            let seen = self.shared.generation.load(Ordering::Acquire);
            let next = self.shared.guard.read(self.lanes, in_pass).await?;
            let shared = self.shared.clone();
            let installed =
                on_lane(self.lanes.write, move |_| shared.install_read(seen, next)).await?;
            // A write landed between the read and the install: read again.
            if let Some(applied) = installed {
                return Ok(applied);
            }
        }
    }
}

impl Shared {
    fn update_on(
        &self,
        lane: &InLane<DurabilityIo>,
        change: impl FnOnce(&mut Doc) -> Result<(), ConfigError>,
    ) -> Result<Applied, ConfigError> {
        self.update_viewed(lane, change, |_| ()).map(|(applied, ())| applied)
    }

    /// `update_on`, plus `view` of the document the update left, taken under the same writer lock: Node's
    /// `updateConfigAsync` returned the saved config from the locked update itself.
    fn update_viewed<T>(
        &self,
        lane: &InLane<DurabilityIo>,
        change: impl FnOnce(&mut Doc) -> Result<(), ConfigError>,
        view: impl FnOnce(&Doc) -> T,
    ) -> Result<(Applied, T), ConfigError> {
        let mut raised = lock(&self.writer);
        let current = self.doc.load_full();
        // `updateConfig`: under the file's lock, from what `readAllForRmW` settles on (the document while the file is
        // intact), the edit is applied and the canonical result written between its snapshots.
        let written = self.guard.locked(lane, |baseline| {
            let mut next = baseline.doc.unwrap_or_else(|| (*current).clone());
            let fresh = next.is_empty();
            change(&mut next)?;
            // `writeAll`: a save writes the canonical document, whatever the edit put back.
            let mut next = canonical::canonicalize(next);
            // A file created by this code is born separated: the first write into an empty config stamps the current version.
            if fresh && !next.contains_key(separation::DEFAULTS_VERSION_KEY) {
                next.insert(separation::DEFAULTS_VERSION_KEY.into(), Value::from(2));
            }
            // Node writes (and snapshots) even when the edit changed nothing.
            self.guard.write(lane, &next, "post-config-write")?;
            Ok(Some(next))
        })?;
        match written {
            // The view is of the document that was written, taken while the writer lock is still held.
            Some(next) if next != *current => {
                let seen = view(&next);
                Ok((self.install(&mut raised, &current, next), seen))
            }
            Some(next) => Ok((Applied::default(), view(&next))),
            None => Ok((Applied::default(), view(&current))),
        }
    }

    /// `None` when a document was installed since `seen`, so `next` may be stale.
    fn install_read(&self, seen: u64, next: Doc) -> Option<Applied> {
        let mut raised = lock(&self.writer);
        if self.generation.load(Ordering::Acquire) != seen {
            return None;
        }
        let current = self.doc.load_full();
        if next == *current {
            return Some(Applied::default());
        }
        Some(self.install(&mut raised, &current, next))
    }

    fn install(&self, raised: &mut BTreeSet<String>, current: &Doc, next: Doc) -> Applied {
        let warnings = warnings_of(&next);
        let now: BTreeSet<String> = warnings.iter().map(|w| w.path.clone()).collect();
        let fresh = warnings
            .into_iter()
            .filter(|w| !raised.contains(&w.path))
            .collect();
        *raised = now;
        let changed: Vec<&'static str> = PUBLISHED_SUBTREES
            .iter()
            .copied()
            .filter(|name| current.get(*name) != next.get(*name))
            .collect();
        for name in &changed {
            self.publish(name, next.get(*name));
        }
        self.doc.store(Arc::new(next));
        // Called outside the registry's lock, so a hook's guard can drop meanwhile; the writer lock the caller holds keeps
        // every document's hooks before the next install.
        let hooks: Vec<Adoption> = lock(&self.adoptions).iter().map(|(_, hook)| hook.clone()).collect();
        for hook in hooks {
            hook();
        }
        let generation = self.generation.fetch_add(1, Ordering::Release) + 1;
        self.changed.send_replace(generation);
        Applied {
            changed,
            warnings: fresh,
        }
    }

    fn publish(&self, subtree: &str, value: Option<&Value>) {
        let change = value.map_or(SectionChange::Removed, change_of);
        self.publisher
            .publish(SectionName::Config, Some(subtree.to_owned()), change);
    }

    fn apply_edit(&self, doc: &mut Doc, edit: &ConfigEdit) -> Result<(), ConfigError> {
        let path = edit.path.as_str();
        let invalid = |expected: String| ConfigError::InvalidParams {
            path: path.to_owned(),
            expected,
        };
        let key = schema::lookup(&self.keys, path)
            .ok_or_else(|| invalid("a known config key".into()))?;
        // Node's store, on its first load with no file, writes the document with `migratedAt: now`
        // (`notification-preferences.ts:228`): devices paired before it keep the plain default, later ones
        // start from bot chats. The first write into an unwritten subtree is that load.
        if parts_of(path).first() == Some(&"notifications")
            && path != "notifications"
            && path != "notifications.migratedAt"
            && get_in(doc, &["notifications"]).is_none()
        {
            set_in(doc, &["notifications", "migratedAt"], Value::from(epoch_ms()));
        }
        let wants = |kind: schema::Kind| std::mem::discriminant(&kind) == std::mem::discriminant(&key.kind);
        let parts: Vec<&str> = path.split('.').collect();
        if matches!(edit.mode, ConfigWriteMode::MergePatch | ConfigWriteMode::MergePatchBots) {
            if !wants(schema::Kind::NotificationDevice) {
                return Err(invalid("a notifications.devices.<id> path".into()));
            }
            let merged = notifications::merge_device(
                get_in(doc, &parts),
                &edit.value,
                edit.mode == ConfigWriteMode::MergePatchBots,
            )
            .map_err(invalid)?;
            set_in(doc, &parts, merged);
            return Ok(());
        }
        if edit.mode == ConfigWriteMode::SetConversation {
            if !wants(schema::Kind::NotificationOverrides) {
                return Err(invalid("the notifications.overrides path".into()));
            }
            let now = epoch_ms();
            let next = notifications::set_conversation(get_in(doc, &parts), &edit.value, now).map_err(invalid)?;
            set_in(doc, &parts, next);
            return Ok(());
        }
        let remove = edit.value.is_null() && matches!(key.kind, schema::Kind::Any);
        if !remove && !schema::accepts(key.kind, &edit.value) {
            return Err(invalid(match key.kind {
                schema::Kind::CookieAutoImport => schema::cookie_auto_import_error(&edit.value).into(),
                kind => schema::expected(kind),
            }));
        }
        if matches!(key.kind, schema::Kind::Pins) {
            return write_pins(doc, &edit.value, edit.mode, path);
        }
        if matches!(key.kind, schema::Kind::CookieAutoImport) {
            let stored = schema::cookie_auto_import(&edit.value).expect("accepted by the schema");
            set_in(doc, &parts, stored);
            return Ok(());
        }
        if let Some(stored) = schema::stored_notifications(key.kind, &edit.value) {
            set_in(doc, &parts, stored);
            return Ok(());
        }
        if matches!(key.kind, schema::Kind::BrowserPermissions) {
            let stored = browser_permissions::storable(&edit.value, get_in(doc, &parts))
                .map_err(|max| invalid(format!("Site permissions hold at most {max} exceptions. Remove some sites first.")))?;
            match stored {
                Some(stored) => set_in(doc, &parts, stored),
                None => remove_in(doc, &parts),
            }
            return Ok(());
        }
        if edit.mode == ConfigWriteMode::InitializeIfMissing && get_in(doc, &parts).is_some() {
            return Ok(());
        }
        // A control that is already on predates its install marker: keep that fact before the
        // control can be turned off, so off never turns back into Install.
        if let ["desktop", control @ ("computerControl" | "browserControl")] = parts[..] {
            let marker = control.replace("Control", "Installed");
            let installed = get_in(doc, &["desktop", &marker]) == Some(&Value::Bool(true))
                || get_in(doc, &["desktop", control]) == Some(&Value::Bool(true));
            if installed {
                set_in(doc, &["desktop", &marker], Value::Bool(true));
            }
        }
        if path == "agent.compaction.auto" {
            retire_legacy_compaction(doc);
        }
        if remove || key.default.as_ref() == Some(&edit.value) {
            remove_in(doc, &parts);
        } else {
            set_in(doc, &parts, edit.value.clone());
        }
        Ok(())
    }
}

/// `Date.now()`: milliseconds from the epoch, negative for a clock set before it.
fn epoch_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

fn parts_of(path: &str) -> Vec<&str> {
    path.split('.').collect()
}

/// `DesktopSettingsStore.update('autoCompact')`: before `auto` is stored, the retired compaction
/// keys go and their canonical successors take their values (`summaryModel` from `semanticModel`,
/// `memoryTimeoutMs` from `recallMemoryTimeoutMs`), so a legacy value cannot override `auto`.
fn retire_legacy_compaction(doc: &mut Doc) {
    const RETIRED: [&str; 17] = [
        "enabled",
        "type",
        "compactType",
        "compact_type",
        "semantic",
        "semanticModel",
        "prune",
        "tailTurns",
        "recallMemoryTimeoutMs",
        "recallIngestLimit",
        "recallChunkLimit",
        "recallLimit",
        "recallCycle1BatchSize",
        "recallRowsPerSession",
        "recallWindowSize",
        "recallConcurrency",
        "recallCycle1DeadlineMs",
    ];
    // JavaScript truthiness of a stored value.
    let set = |value: Option<&Value>| match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    };
    let Some(compaction) = doc
        .get_mut("agent")
        .and_then(Value::as_object_mut)
        .and_then(|agent| agent.get_mut("compaction"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for (canonical, retired) in [("summaryModel", "semanticModel"), ("memoryTimeoutMs", "recallMemoryTimeoutMs")] {
        if !set(compaction.get(canonical)) && set(compaction.get(retired)) {
            let carried = compaction[retired].clone();
            compaction.insert(canonical.to_owned(), carried);
        }
    }
    for key in RETIRED {
        compaction.shift_remove(key);
    }
}

/// `desktop.activityRailPins`: the revision is assigned inside the write transaction; the/// default list is never stored, the revision alone keeps ordering.
fn write_pins(
    doc: &mut Doc,
    value: &Value,
    mode: ConfigWriteMode,
    path: &str,
) -> Result<(), ConfigError> {
    let pins = schema::normalize_pins(value).expect("accepted by the key schema");
    let previous = desktop::activity_rail_pins(get_in(doc, &["desktop", "activityRailPins"]));
    if mode == ConfigWriteMode::InitializeIfMissing && previous.is_some() {
        return Ok(());
    }
    let revision = previous.map_or(0, |p| p.revision) + 1;
    if revision > (1 << 53) - 1 {
        return Err(ConfigError::InvalidParams {
            path: path.to_owned(),
            expected: "Activity rail pin revision is exhausted.".into(),
        });
    }
    let is_default = pins == schema::DEFAULT_ACTIVITY_RAIL_PINS;
    let stored = if is_default {
        serde_json::json!({ "revision": revision })
    } else {
        serde_json::json!({ "pins": pins, "revision": revision })
    };
    set_in(doc, &["desktop", "activityRailPins"], stored);
    Ok(())
}

fn warnings_of(doc: &Doc) -> Vec<ConfigWarning> {
    let mut warnings = Vec::new();
    if session_retention(doc).is_some() {
        return warnings;
    }
    for key in ["sessionAutoArchiveDays", "sessionAutoDeleteDays"] {
        let choices = if key == "sessionAutoArchiveDays" {
            schema::SESSION_AUTO_ARCHIVE_DAY_CHOICES
        } else {
            schema::SESSION_AUTO_DELETE_DAY_CHOICES
        };
        let stored = get_in(doc, &["desktop", key]);
        if stored.is_some_and(|v| !v.as_i64().is_some_and(|n| choices.contains(&n))) {
            warnings.push(ConfigWarning {
                path: format!("desktop.{key}"),
                message: format!(
                    "desktop.{key} is not one of {choices:?}; session retention is paused"
                ),
            });
        }
    }
    warnings
}

fn get_in<'a>(doc: &'a Doc, parts: &[&str]) -> Option<&'a Value> {
    let (first, rest) = parts.split_first()?;
    let mut node = doc.get(*first)?;
    for part in rest {
        node = node.as_object()?.get(*part)?;
    }
    Some(node)
}

fn set_in(doc: &mut Doc, parts: &[&str], value: Value) {
    let (last, parents) = parts.split_last().expect("a path has a segment");
    let mut node = doc;
    for part in parents {
        let child = node
            .entry((*part).to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !child.is_object() {
            *child = Value::Object(Map::new());
        }
        node = child.as_object_mut().expect("just made an object");
    }
    node.insert((*last).to_owned(), value);
}

/// Removes the value and the objects it leaves empty below the top level (a top-level subtree
/// stays, as a default-valued write leaves `desktop: {}`).
fn remove_in(doc: &mut Doc, parts: &[&str]) {
    fn go(node: &mut Doc, parts: &[&str], top: bool) {
        let (first, rest) = parts.split_first().expect("a path has a segment");
        if rest.is_empty() {
            // Shifting keeps the user's key order.
            node.shift_remove(*first);
            return;
        }
        // A stored non-object where a subtree belongs is replaced, as a write to it would.
        let Some(slot) = node.get_mut(*first) else {
            return;
        };
        if !slot.is_object() {
            *slot = Value::Object(Map::new());
        }
        let child = slot.as_object_mut().expect("just made an object");
        go(child, rest, false);
        if child.is_empty() && !top {
            node.shift_remove(*first);
        }
    }
    go(doc, parts, true);
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[allow(clippy::disallowed_methods, reason = "an io-interactive job body: the proof says it runs there")]
fn read_file(_lane: &InLane<InteractiveIo>, path: &Path) -> Result<Doc, ConfigError> {
    #[cfg(feature = "count-work")]
    crate::work::file_read();
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Doc::new()),
        Err(error) => return Err(error.into()),
    };
    match mixdog_statefile::parse_json_text(&bytes) {
        Ok(Value::Object(doc)) => Ok(canonical::canonicalize(doc)),
        Ok(_) => Err(ConfigError::Parse("the top level is not an object".into())),
        Err(error) => Err(ConfigError::Parse(error.to_string())),
    }
}

/// `writeJsonAtomicSync(configPath(), data, { lock: false, fsyncDir: true, mode: 0o600, secret: true })`. The caller holds
/// `<config>.lock`, the lock Node's own config writers take (`mixdog-statefile`): the guard's `locked`.
fn write_file(lane: &InLane<DurabilityIo>, path: &Path, doc: &Doc) -> Result<(), ConfigError> {
    let opts = mixdog_statefile::Opts { fsync_dir: true, secret: true, ..mixdog_statefile::Opts::default() };
    let bytes = mixdog_statefile::json_bytes(&Value::Object(doc.clone()), &opts);
    mixdog_statefile::write_file_stepped(lane, path, &bytes, &opts).map(|_| ()).map_err(ConfigError::Publish)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
#[cfg(test)]
mod guard_replay;
