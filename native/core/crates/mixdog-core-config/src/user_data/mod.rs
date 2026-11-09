//! The user-data guard (`runtime/shared/user-data-guard.mjs`): what keeps a user's settings when
//! `mixdog-config.json` is lost or damaged.
//!
//! - The data dir carries an init marker, `.mixdog-user-data.json` (`{ instanceId, dataDir, createdAt }`), created beside
//!   the first config write; it ties the backups to this incarnation of the dir, so a recreated profile at the same path
//!   starts fresh.
//! - Every config write is wrapped in snapshots (`backup_user_data`): the config and `schedules/`, `webhooks/`,
//!   `workflows/` (a migration names more folders) are copied to
//!   `<backup root>/scope-<hash of the data dir>/<iso-ms>-<seq>-<reason>/`, each with a `backup.json` manifest written last,
//!   and the newest forty are kept.
//! - A config that is missing or malformed in an initialized dir is restored from the newest structurally complete backup of
//!   this dir and incarnation (`load_latest_config`); dirs that predate the marker are recovered from the older
//!   unscoped layout (`legacy_evidence`).
//!
//! The on-disk layout is Node's, byte for byte: the TUI reads the same backups at boot to pick its theme before the core
//! answers (`src/tui/theme-config.mjs`).
//!
//! Every file call runs under the proof of the lane job it is made in, through `mixdog_statefile`.

mod backup;
mod marker;
mod names;
mod restore;

use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

pub use backup::BackupResult;
pub use restore::LegacyEvidence;

/// The config file the guard protects, and the only file it copies besides the folders below.
pub const CONFIG_FILE: &str = "mixdog-config.json";
/// The data-dir folders every snapshot carries.
pub(crate) const USER_DATA_DIRS: [&str; 3] = ["schedules", "webhooks", "workflows"];
/// `BOT_SPLIT_BACKUP_DIRS`: what a one-time migration's snapshot also carries (`bot-split-migration.mjs`).
pub const BOT_SPLIT_BACKUP_DIRS: [&str; 2] = ["agents", "bots"];
/// Written into every backup; a backup without one (legacy, or interrupted mid-copy) is never restored.
pub(crate) const BACKUP_MANIFEST: &str = "backup.json";
/// `USER_DATA_INIT_MARKER`: lives inside the data dir.
pub const INIT_MARKER: &str = ".mixdog-user-data.json";

/// Why a guard call failed. A transient failure (anything but an absent or non-JSON file) must never pass for "no
/// backup": it is thrown, never skipped.
#[derive(Debug)]
pub enum GuardError {
    /// A `SyntaxError`: a damaged marker, or a file that is not JSON.
    Syntax(String),
    Io(io::Error),
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::Syntax(message) => f.write_str(message),
            GuardError::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for GuardError {}

impl From<io::Error> for GuardError {
    fn from(error: io::Error) -> Self {
        GuardError::Io(error)
    }
}

impl From<mixdog_statefile::PublishFailure> for GuardError {
    fn from(failure: mixdog_statefile::PublishFailure) -> Self {
        GuardError::Io(failure.error)
    }
}

impl GuardError {
    /// `isAbsentBackupError`: absent, not a backup, or not JSON is no backup; any other failure is transient.
    pub(super) fn is_absent(&self) -> bool {
        match self {
            GuardError::Syntax(_) => true,
            GuardError::Io(error) => error.kind() == io::ErrorKind::NotFound || error.kind() == io::ErrorKind::NotADirectory,
        }
    }
}

/// The environment the guard reads on every call, as Node reads `process.env` and `os.homedir()`.
pub struct Env {
    var: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
    home: Option<PathBuf>,
}

impl Env {
    /// The process environment and its home directory.
    pub fn process() -> Self {
        Self { var: Box::new(|name| std::env::var(name).ok()), home: std::env::home_dir() }
    }

    /// An environment of its own: `var` answers a variable, `home` is `os.homedir()`.
    pub fn new(var: impl Fn(&str) -> Option<String> + Send + Sync + 'static, home: Option<PathBuf>) -> Self {
        Self { var: Box::new(var), home }
    }

    /// `process.env.NAME || …`: an empty value counts as unset.
    fn set(&self, name: &str) -> Option<String> {
        (self.var)(name).filter(|value| !value.is_empty())
    }

    fn mixdog_home(&self) -> io::Result<PathBuf> {
        match self.set("MIXDOG_HOME") {
            Some(home) => Ok(PathBuf::from(home)),
            None => Ok(self.home.clone().ok_or_else(|| io::Error::other("no home directory"))?.join(".mixdog")),
        }
    }

    /// `getBackupRoot()`.
    fn backup_root(&self) -> io::Result<PathBuf> {
        if let Some(root) = self.set("MIXDOG_USER_DATA_BACKUP_ROOT") {
            return Ok(PathBuf::from(root));
        }
        let home = match self.set("MIXDOG_HOME").or_else(|| self.set("MIXDOG_CONFIG_DIR")) {
            Some(home) => PathBuf::from(home),
            None => self.mixdog_home()?,
        };
        Ok(join(&home, &["backups", "user-data"]))
    }

    /// The root older builds kept their one unscoped ring in, ignoring `MIXDOG_HOME`.
    fn legacy_root(&self) -> io::Result<PathBuf> {
        if let Some(root) = self.set("MIXDOG_USER_DATA_BACKUP_ROOT") {
            return Ok(PathBuf::from(root));
        }
        let home = match self.set("MIXDOG_CONFIG_DIR") {
            Some(home) => PathBuf::from(home),
            None => self.home.clone().ok_or_else(|| io::Error::other("no home directory"))?.join(".mixdog"),
        };
        Ok(join(&home, &["backups", "user-data"]))
    }

    fn skips_backups(&self) -> bool {
        matches!((self.var)("MIXDOG_SKIP_USER_DATA_BACKUP").as_deref(), Some("1" | "true"))
    }

    fn quiet(&self) -> bool {
        (self.var)("MIXDOG_SETUP_QUIET").as_deref() == Some("1")
    }
}

/// `path.normalize`: `.` and `..` folded, one separator, `\` on Windows.
fn fold(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut depth = 0_usize;
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if depth > 0 {
                    out.pop();
                    depth -= 1;
                } else if !out.has_root() {
                    out.push("..");
                }
            }
            Component::Normal(name) => {
                out.push(name);
                depth += 1;
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.join(base, ...parts)`.
fn join(base: &Path, parts: &[&str]) -> PathBuf {
    let mut joined = base.to_path_buf();
    joined.extend(parts);
    fold(&joined)
}

/// `path.resolve(p)`: absolute against the working directory, folded.
fn resolve(path: &Path) -> PathBuf {
    let joined = std::env::current_dir().unwrap_or_default().join(path);
    fold(&std::path::absolute(&joined).unwrap_or(joined))
}

/// `normalizeDataDir(dataDir)`: resolved, and lower-cased where paths are case-insensitive (Windows).
pub(crate) fn normalize_data_dir(data_dir: &Path) -> String {
    let full = resolve(data_dir).to_string_lossy().into_owned();
    if cfg!(windows) { mixdog_js::js_to_lowercase(&full) } else { full }
}

/// The first sixteen hex digits of the SHA-256 of `text`.
pub(crate) fn hash16(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// `JSON.parse(readFileSync(path, 'utf8'))`: a missing file is `NotFound`, text that is not JSON a `Syntax` error.
fn read_json(path: &Path) -> Result<Value, GuardError> {
    let bytes = mixdog_statefile::read_content(path)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    mixdog_js::json_parse(&String::from_utf8_lossy(&bytes)).map_err(|error| GuardError::Syntax(error.to_string()))
}

/// What the guard keeps between calls in a process (module-level state in Node).
#[derive(Default)]
struct State {
    counter: names::Counter,
    /// Data dirs whose first scoped snapshot is known to exist (`ensuredDataDirs`).
    ensured: HashSet<String>,
    /// `restoreLookupCache`: keyed by data dir.
    restore: HashMap<String, RestoreHit>,
    /// `legacyEvidenceCache`: keyed by data dir.
    legacy: HashMap<String, LegacyHit>,
}

struct RestoreHit {
    root: PathBuf,
    instance_id: String,
    config: Option<Value>,
}

struct LegacyHit {
    roots: String,
    evidence: Option<LegacyEvidence>,
}

/// The guard of one process: its environment, clock, id source and log, and what it remembers.
pub struct UserData {
    env: Env,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    new_id: Box<dyn Fn() -> String + Send + Sync>,
    log: Box<dyn Fn(&str) + Send + Sync>,
    state: Mutex<State>,
}

impl UserData {
    /// The process's guard: the process environment, the wall clock, random ids, and the log of the daemon. Every
    /// `Config` of the process shares it, as the Node module's state is shared.
    pub fn process() -> Arc<Self> {
        static PROCESS: OnceLock<Arc<UserData>> = OnceLock::new();
        PROCESS
            .get_or_init(|| {
                Arc::new(Self::new(
                    Env::process(),
                    || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64),
                    || uuid::Uuid::new_v4().to_string(),
                    |line| tracing::warn!("{line}"),
                ))
            })
            .clone()
    }

    /// A guard over its own environment, `Date.now()`, `randomUUID()` and log (one line per call, without its newline);
    /// replays of a Node recording fix all four.
    pub fn new(
        env: Env,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
        new_id: impl Fn() -> String + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self { env, clock: Box::new(clock), new_id: Box::new(new_id), log: Box::new(log), state: Mutex::default() }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Writes one line to stderr, as Node does.
    pub(crate) fn line(&self, text: &str) {
        (self.log)(text);
    }

    /// `scopeDirFor(dataDir)`: the data dir's own folder of backups. The `scope-` prefix sorts after the timestamped
    /// legacy entries, so an older build pruning the root as one ring keeps it.
    fn scope_dir(&self, data_dir: &Path) -> io::Result<PathBuf> {
        let id = hash16(&normalize_data_dir(data_dir));
        Ok(join(&self.env.backup_root()?, &[&format!("{}{id}", names::SCOPE_PREFIX)]))
    }

    /// Whether a readable config still owes the data dir its first snapshot (`ensureUserDataInitialized` would act): this
    /// process has not settled it, and backups are not switched off.
    pub fn needs_ensure(&self, data_dir: &Path) -> bool {
        !data_dir.as_os_str().is_empty() && !self.env.skips_backups() && !self.state().ensured.contains(&normalize_data_dir(data_dir))
    }

    fn forget(&self, key: &str) {
        let mut state = self.state();
        state.restore.remove(key);
        state.legacy.remove(key);
    }
}
