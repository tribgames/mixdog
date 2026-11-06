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

mod agent_routes;
mod agent_store;
mod browser_permissions;
mod network_proxy_store;
pub mod patch;
mod settings;
mod desktop;
mod notifications;
mod output_style;
mod schema;
mod seams;
mod service;

pub use seams::ConfigFeatureGate;
pub use service::ConfigService;
pub(crate) use service::set_worktree_settings;
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
pub use settings::NoEffects;
pub use settings::Settings;
pub use settings::SettingsEffects;
pub use settings::SettingsEnv;
pub(crate) use agent_routes::bot_migration;
pub(crate) use agent_routes::is_store_bot;
pub use agent_routes::AgentRoutes;
pub use agent_routes::MIXY_RUNTIME_ID;
pub use agent_routes::RouteHome;
pub use desktop::ActivityRailPins;
pub use desktop::DesktopSettings;
pub use desktop::SessionRetention;
pub use desktop::browser_cookie_auto_import;
pub use desktop::desktop_settings;
pub use desktop::session_retention;

use crate::state::change_of;

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
];

#[derive(Debug)]
pub enum ConfigError {
    /// `-32602 invalidParams{path, expected}`.
    InvalidParams { path: String, expected: String },
    /// The file exists but is not a JSON object; nothing is replaced, so nothing is lost.
    Parse(String),
    Io(std::io::Error),
    /// The lane's queue is full: the caller answers `overloaded` at once.
    Overloaded(LaneFull),
    /// The job was dropped before it finished (shutdown).
    Stopped,
    /// A caller's change refused the edit with its own error, which `core_error` returns as is.
    Rejected(mixdog_core_api::CoreError),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::InvalidParams { path, expected } => {
                write!(f, "invalid value for {path}: expected {expected}")
            }
            ConfigError::Parse(message) => write!(f, "mixdog-config.json is not valid: {message}"),
            ConfigError::Io(error) => write!(f, "mixdog-config.json: {error}"),
            ConfigError::Overloaded(full) => full.fmt(f),
            ConfigError::Stopped => f.write_str("the config job was dropped before it finished"),
            ConfigError::Rejected(error) => write!(f, "{error:?}"),
        }
    }
}

impl std::error::Error for ConfigError {}

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
    /// Opens the file (absent = empty document). An unreadable or non-object file is an error:
    /// a later write must never overwrite a document that could not be read. Publishes the
    /// current subtrees; the returned warnings are those of the opened document.
    pub async fn open(
        path: impl Into<PathBuf>,
        publisher: Arc<dyn StatePublisher>,
        lanes: ConfigLanes,
    ) -> Result<(Self, Vec<ConfigWarning>), ConfigError> {
        let path = path.into();
        let read_path = path.clone();
        let doc = on_lane(lanes.read, move |lane| read_file(lane, &read_path)).await??;
        let warnings = warnings_of(&doc);
        let raised = warnings.iter().map(|w| w.path.clone()).collect();
        let shared = Shared {
            path,
            doc: ArcSwap::from_pointee(doc),
            keys: schema::registry(),
            publisher,
            writer: Mutex::new(raised),
            generation: AtomicU64::new(0),
            changed: tokio::sync::watch::channel(0).0,
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
        Ok((config, warnings))
    }

    /// Ticks after every installed document (write or external reload), for services that
    /// derive a view from the config and push it when it changes.
    pub fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.shared.changed.subscribe()
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
        self.reload().await?;
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
        loop {
            let seen = self.shared.generation.load(Ordering::Acquire);
            let path = self.shared.path.clone();
            let next = on_lane(self.lanes.read, move |lane| read_file(lane, &path)).await??;
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
        let mut raised = lock(&self.writer);
        let current = self.doc.load_full();
        let mut next = (*current).clone();
        change(&mut next)?;
        if next == *current {
            return Ok(Applied::default());
        }
        persist(lane, &self.path, &next)?;
        Ok(self.install(&mut raised, &current, next))
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
        let remove = edit.value.is_null() && matches!(key.kind, schema::Kind::Any);
        if !remove && !schema::accepts(key.kind, &edit.value) {
            return Err(invalid(schema::expected(key.kind)));
        }
        let parts: Vec<&str> = path.split('.').collect();
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
                .map_err(|max| invalid(format!("at most {max} site exceptions")))?;
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
        if remove || key.default.as_ref() == Some(&edit.value) {
            remove_in(doc, &parts);
        } else {
            set_in(doc, &parts, edit.value.clone());
        }
        Ok(())
    }
}

/// `desktop.activityRailPins`: the revision is assigned inside the write transaction; the
/// default list is never stored, the revision alone keeps ordering.
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
            expected: "a revision below 2^53".into(),
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
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Doc::new()),
        Err(error) => return Err(error.into()),
    };
    match mixdog_statefile::parse_json_text(&bytes) {
        Ok(Value::Object(doc)) => Ok(doc),
        Ok(_) => Err(ConfigError::Parse("the top level is not an object".into())),
        Err(error) => Err(ConfigError::Parse(error.to_string())),
    }
}

/// `writeJsonAtomicSync(configPath(), data, { fsyncDir: true, mode: 0o600, secret: true })`
/// under `<config>.lock`, the lock Node's own config writers take (`mixdog-statefile`).
fn persist(lane: &InLane<DurabilityIo>, path: &Path, doc: &Doc) -> Result<(), ConfigError> {
    let opts = mixdog_statefile::Opts { fsync_dir: true, secret: true, ..mixdog_statefile::Opts::default() };
    let written = mixdog_statefile::with_lock(lane, path, &mixdog_statefile::LockOpts::default(), || {
        mixdog_statefile::write_json(lane, path, &Value::Object(doc.clone()), &opts)
    });
    match written {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(std::io::Error::other(error.to_string()).into()),
        Err(error) => Err(std::io::Error::other(error.to_string()).into()),
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
