//! The production [`BridgeFeatures`] and [`McpSurface`] of the MCP composition (`compose_mcp`).
//!
//! [`BridgeFiles`] is `bridgePresent` of `builtin-features.mjs` over `readBridgeDiscovery`
//! (`runtime/bridge-discovery.mjs`): the desktop publishes `<id>-bridge.json` while the bridge is
//! up, and the file counts only while it is fresh, well-formed and its writer is alive.
//! [`DaemonMcpSurface`] answers what the session layer answers the MCP side in Node.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core::run_host::config_hosts::ThreadHeaders;
use mixdog_core_session::session::UserCwd;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use mixdog_mcp::mcp_glue::McpSurface;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::SpawnIo;
use mixdog_rt::TaskClass;
use mixdog_tools::orch::status::ToolSurfaceStatus;
use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use serde_json::Value;

use crate::compose_domains::ConfigExtensions;
use crate::compose_domains::EnvReader;
use crate::compose_mcp::BridgeFeatures;

/// `DISCOVERY_MAX_AGE_MS`: the bridge heartbeat touches the file every 60 s; anything older is a
/// crash leftover.
const MAX_AGE_MS: f64 = 5.0 * 60_000.0;
/// `RELOAD_DEBOUNCE_MS` of `watched-file-cache.mjs`: one replace brings several events, the file
/// is read once.
const RELOAD_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(50);
/// The id of the one watch this module holds on the core's `FolderWatcher`.
const WATCH_ID: &str = "mcp.bridge";
const FEATURES: [&str; 4] = ["browser", "computer", "terminal", "visualize"];

/// `bridgeDiscoveryDirectory()`: an isolated profile's `MIXDOG_BRIDGE_DISCOVERY_DIR`, else
/// `MIXDOG_DATA_DIR`, else `<MIXDOG_HOME or ~/.mixdog>/data` (`||`: an empty value counts as unset).
pub fn discovery_dir(env: &EnvReader, home: &Path) -> PathBuf {
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    if let Some(dir) = set("MIXDOG_BRIDGE_DISCOVERY_DIR").or_else(|| set("MIXDOG_DATA_DIR")) {
        return PathBuf::from(dir);
    }
    set("MIXDOG_HOME").map_or_else(|| home.join(".mixdog"), PathBuf::from).join("data")
}

/// An advertisement as read: the file's mtime (`stat.mtimeMs`) and its JSON.
#[derive(Clone, PartialEq)]
enum Advert {
    Missing,
    Read { mtime_ms: f64, parsed: Value },
}

/// What a read of the file found: only a file that is not there reads as missing; one that cannot
/// be read, or holds no JSON, is a failure (the copy keeps the last advertisement).
enum Loaded {
    Advert(Advert),
    Failed,
}

/// One entry of the watched copy (`createWatchedFileCache`).
struct Slot {
    advert: Advert,
    /// The last read failed: the entry keeps what it had (nothing, for a first read that failed,
    /// which Node's `bridgePresent` reads as "not up") and a read of it is itself the event.
    failed: bool,
    /// A re-read is due after the debounce.
    timer: bool,
    loading: bool,
    /// An event arrived during a read: it may postdate what that read saw.
    again: bool,
}

/// The watch of the discovery folder.
struct Watching {
    watcher: Arc<FolderWatcher>,
    /// The folder watched: the discovery folder, or the nearest ancestor that could be.
    at: Option<PathBuf>,
}

/// `bridgePresent(file)` for the four desktop bridges, over a copy of each file kept current by
/// the core's one file watch (`FolderWatcher`): a warm read touches no filesystem, a watch event
/// re-reads the file after a 50 ms debounce, nothing is polled.
pub struct BridgeFiles {
    dir: PathBuf,
    io: MaintenanceIo,
    slots: Mutex<HashMap<&'static str, Slot>>,
    watching: Mutex<Option<Watching>>,
    /// `Date.now()` in milliseconds.
    now_ms: Box<dyn Fn() -> f64 + Send + Sync>,
    /// Counts the reads taken into the copy; a test waits on it instead of polling.
    applied: tokio::sync::watch::Sender<u64>,
}

/// The sink the core's `FolderWatcher` must be built with (composed with its other sinks): keeps
/// only this module's watch.
struct BridgeSink(std::sync::Weak<BridgeFiles>);

impl ChangeSink for BridgeSink {
    fn changed(&self, watch_id: &str, paths: Vec<String>, _kind: ChangeKind) {
        if watch_id != WATCH_ID {
            return;
        }
        if let Some(files) = self.0.upgrade() {
            files.heard(&paths);
        }
    }
}

fn system_now_ms() -> f64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

fn load(lane: &InLane<MaintenanceIo>, path: &Path) -> Loaded {
    let missing = |kind: std::io::ErrorKind| matches!(kind, std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory);
    let meta = match mixdog_statefile::metadata(lane, path) {
        Ok(meta) => meta,
        Err(error) if missing(error.kind()) => return Loaded::Advert(Advert::Missing),
        Err(_) => return Loaded::Failed,
    };
    let bytes = match mixdog_statefile::read_content(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Loaded::Advert(Advert::Missing),
        Err(error) if missing(error.kind()) => return Loaded::Advert(Advert::Missing),
        Err(_) => return Loaded::Failed,
    };
    let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) else { return Loaded::Failed };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0);
    Loaded::Advert(Advert::Read { mtime_ms, parsed })
}

/// `processAlive(pid)`: true unless the pid is known not to exist.
fn process_alive(pid: f64) -> bool {
    if pid.fract() != 0.0 || !pid.is_finite() || pid <= 0.0 {
        return true;
    }
    // `process.kill` refuses a pid beyond int32 with an error that is not `ESRCH`.
    if pid > f64::from(i32::MAX) {
        return true;
    }
    mixdog_statefile::process_exists(pid as u32)
}

fn field<'a>(parsed: &'a Value, key: &str) -> Option<&'a Value> {
    parsed.as_object().and_then(|object| object.get(key))
}

/// `Number(parsed?.key)`: `undefined` is NaN.
fn number(parsed: &Value, key: &str) -> f64 {
    field(parsed, key).map_or(f64::NAN, to_number)
}

fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

impl BridgeFiles {
    /// Nothing is watched or read until [`Self::start`]; a bridge asked about before that is not up.
    pub fn new(dir: PathBuf, io: MaintenanceIo) -> Arc<Self> {
        Self::new_at(dir, io, Box::new(system_now_ms))
    }

    fn new_at(dir: PathBuf, io: MaintenanceIo, now_ms: Box<dyn Fn() -> f64 + Send + Sync>) -> Arc<Self> {
        let slot = || Slot { advert: Advert::Missing, failed: false, timer: false, loading: false, again: false };
        let slots = FEATURES.iter().map(|id| (*id, slot())).collect();
        Arc::new(Self { dir, io, slots: Mutex::new(slots), watching: Mutex::new(None), now_ms, applied: tokio::sync::watch::channel(0).0 })
    }

    #[cfg(test)]
    fn applied(&self) -> tokio::sync::watch::Receiver<u64> {
        self.applied.subscribe()
    }

    /// The sink the core's `FolderWatcher` must be built with (compose it with its other sinks).
    pub fn sink(self: &Arc<Self>) -> Arc<dyn ChangeSink> {
        Arc::new(BridgeSink(Arc::downgrade(self)))
    }

    /// Watches the discovery folder on `watcher`, then reads the four files once (the cold read
    /// of the watched copy: watch first, so a change after the read is never missed).
    pub async fn start(self: &Arc<Self>, watcher: Arc<FolderWatcher>) {
        *self.watching() = Some(Watching { watcher, at: None });
        self.attach();
        for id in FEATURES {
            let loaded = Self::read(self.io, self.dir.join(format!("{id}-bridge.json"))).await;
            self.apply(id, loaded);
        }
    }

    fn watching(&self) -> std::sync::MutexGuard<'_, Option<Watching>> {
        self.watching.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Points the watch at the discovery folder or, while that cannot be watched (it does not
    /// exist yet), the nearest ancestor that can: an event there names the folder, and the next
    /// re-read tries the folder again.
    fn attach(&self) {
        let mut watching = self.watching();
        let Some(held) = watching.as_mut() else { return };
        if held.at.as_deref() == Some(self.dir.as_path()) {
            return;
        }
        held.watcher.unwatch(WATCH_ID);
        held.at = std::iter::successors(Some(self.dir.as_path()), |dir| dir.parent())
            .find(|dir| held.watcher.watch(WATCH_ID, dir, false).is_ok())
            .map(Path::to_path_buf);
    }

    /// The watch delivered a batch. On the folder itself only the files named are re-read; on an
    /// ancestor, or after lost events, every file is.
    fn heard(self: &Arc<Self>, paths: &[String]) {
        let on_folder = self.watching().as_ref().is_some_and(|held| held.at.as_deref() == Some(self.dir.as_path()));
        let named = |id: &str| {
            let file = format!("{id}-bridge.json");
            paths.iter().any(|path| Path::new(path).file_name().is_some_and(|name| *name == *file))
        };
        for id in FEATURES {
            if !on_folder || paths.is_empty() || named(id) {
                self.schedule(id);
            }
        }
    }

    /// `scheduleReread`: one re-read per debounce window.
    fn schedule(self: &Arc<Self>, id: &'static str) {
        {
            let mut slots = self.slots();
            let Some(slot) = slots.get_mut(id) else { return };
            if slot.timer {
                return;
            }
            slot.timer = true;
        }
        let files = Arc::clone(self);
        mixdog_rt::spawn("bridge-discovery", TaskClass::Work, async move {
            tokio::time::sleep(RELOAD_DEBOUNCE).await;
            files.reread(id).await;
        });
    }

    /// The re-read of a file after its debounce: an event during a read reads again.
    async fn reread(self: &Arc<Self>, id: &'static str) {
        self.attach();
        loop {
            {
                let mut slots = self.slots();
                let Some(slot) = slots.get_mut(id) else { return };
                slot.timer = false;
                if slot.loading {
                    slot.again = true;
                    return;
                }
                slot.loading = true;
            }
            let loaded = Self::read(self.io, self.dir.join(format!("{id}-bridge.json"))).await;
            let again = self.apply(id, loaded);
            if !again {
                return;
            }
            if let Some(slot) = self.slots().get_mut(id) {
                slot.timer = true;
            }
            tokio::time::sleep(RELOAD_DEBOUNCE).await;
        }
    }

    /// Takes a read's result: a failed read keeps what the entry had. Answers whether an event
    /// arrived while it ran.
    fn apply(&self, id: &'static str, loaded: Loaded) -> bool {
        let mut slots = self.slots();
        let Some(slot) = slots.get_mut(id) else { return false };
        match loaded {
            Loaded::Advert(advert) => {
                slot.advert = advert;
                slot.failed = false;
            }
            Loaded::Failed => {
                slot.failed = true;
                tracing::warn!(feature = id, "the bridge discovery file could not be read");
            }
        }
        slot.loading = false;
        let again = std::mem::take(&mut slot.again);
        drop(slots);
        self.applied.send_modify(|reads| *reads += 1);
        again
    }

    async fn read(io: MaintenanceIo, path: PathBuf) -> Loaded {
        match io.submit(&CancellationToken::new(), move |lane| load(lane, &path)) {
            Ok(job) => job.await.unwrap_or(Loaded::Failed),
            Err(_) => Loaded::Failed,
        }
    }

    fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<&'static str, Slot>> {
        self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `discoveryDetail(..).discovery !== null` of the copy.
    fn up(&self, copy: &Advert) -> bool {
        let Advert::Read { mtime_ms, parsed } = copy else { return false };
        if (self.now_ms)() - mtime_ms >= MAX_AGE_MS {
            return false;
        }
        let port = number(parsed, "port");
        let token = field(parsed, "token").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
        if number(parsed, "version") != 1.0 || !is_integer(port) || port <= 0.0 || port > 65_535.0 || token.is_empty() {
            return false;
        }
        let pid = field(parsed, "pid").filter(|value| truthy(value)).map_or(0.0, to_number);
        process_alive(pid)
    }

    /// `demandReread`: an entry whose last load failed, or whose folder could not be watched at
    /// all, may be behind the file; a read of it answers what it holds and schedules one re-read.
    fn demand(self: &Arc<Self>, id: &'static str) {
        let blind = self.watching().as_ref().is_none_or(|held| held.at.is_none());
        let due = self.slots().get(id).is_some_and(|slot| (slot.failed || blind) && !slot.loading && !slot.timer);
        if due {
            self.schedule(id);
        }
    }
}

/// [`BridgeFiles`] shared: a read of an entry may have to schedule a re-read, which needs the `Arc`.
pub struct SharedBridgeFiles(pub Arc<BridgeFiles>);

impl BridgeFeatures for SharedBridgeFiles {
    fn present(&self, feature: &str) -> bool {
        let Some(id) = FEATURES.iter().find(|id| **id == feature) else { return false };
        let answer = self.0.slots().get(id).is_some_and(|slot| self.0.up(&slot.advert));
        self.0.demand(id);
        answer
    }
}

/// Opens a URL in the user's default browser (`openInBrowser`, `runtime/shared/open-url.mjs`).
pub struct UrlOpener {
    io: SpawnIo,
    system_root: Option<String>,
    wsl: bool,
}

/// The program and arguments to try, in order.
fn candidates(url: &str, windows: bool, macos: bool, wsl: bool, system_root: &str) -> Vec<(String, Vec<String>)> {
    let own = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    if windows {
        return vec![(format!("{system_root}\\System32\\rundll32.exe"), vec!["url.dll,FileProtocolHandler".to_owned(), url.to_owned()])];
    }
    if macos {
        return vec![("open".to_owned(), vec![url.to_owned()])];
    }
    if wsl {
        let quoted = format!("'{}'", url.replace('\'', "''"));
        let mut command = own(&["-NoProfile", "-NonInteractive", "-Command"]);
        command.push(format!("Start-Process -FilePath {quoted}"));
        return vec![("wslview".to_owned(), vec![url.to_owned()]), ("powershell.exe".to_owned(), command)];
    }
    vec![("xdg-open".to_owned(), vec![url.to_owned()])]
}

impl UrlOpener {
    /// `system_root` is `SystemRoot || WINDIR` of the environment; `wsl` is `isWSL()`.
    pub fn new(io: SpawnIo, system_root: Option<String>, wsl: bool) -> Arc<Self> {
        Arc::new(Self { io, system_root, wsl })
    }

    /// `isWSL()`: `WSL_DISTRO_NAME` / `WSL_INTEROP`, else a Microsoft kernel in `/proc/version`.
    pub fn is_wsl(env: &EnvReader) -> bool {
        if !cfg!(target_os = "linux") {
            return false;
        }
        if ["WSL_DISTRO_NAME", "WSL_INTEROP"].iter().any(|name| env(name).is_some_and(|value| !value.is_empty())) {
            return true;
        }
        mixdog_statefile::read_content(Path::new("/proc/version"))
            .ok()
            .flatten()
            .map(|bytes| String::from_utf8_lossy(&bytes).to_lowercase())
            .is_some_and(|text| text.contains("microsoft") || text.contains("wsl"))
    }

    /// `openInBrowser`: best effort and non-blocking. Each candidate is spawned detached with its
    /// output ignored (`mixdog_spawn::detached`); one that cannot start (Node's `error` event or
    /// a throw) gives way to the next, one that started is left alone whatever its exit.
    pub fn open(&self, url: &str) {
        let list = candidates(url, cfg!(windows), cfg!(target_os = "macos"), self.wsl, self.system_root.as_deref().unwrap_or("C:\\Windows"));
        let job = self.io.submit(&CancellationToken::new(), move |_lane| {
            for (program, args) in list {
                if mixdog_spawn::detached::spawn_detached(&program, &args).is_ok() {
                    return;
                }
            }
        });
        if let Err(error) = job {
            tracing::warn!(?error, "the browser could not be opened: the spawn lane is full");
        }
    }
}

/// The session layer's answers to the MCP side.
pub struct DaemonMcpSurface {
    cwd: UserCwd,
    headers: Arc<dyn ThreadHeaders>,
    surface: Arc<dyn ToolSurfaceStatus>,
    extensions: Arc<ConfigExtensions>,
    announce: Arc<dyn Fn() + Send + Sync>,
    opener: Arc<UrlOpener>,
    generation: mixdog_core::run_host::surface_host::SurfaceGeneration,
}

impl DaemonMcpSurface {
    /// `cwd` reads `user-cwd.txt` of the data folder; `announce` is `announceStoredStateChange('plugins')`
    /// (`McpInputs`' `PluginSeams.announce`).
    pub fn new(
        cwd: UserCwd,
        headers: Arc<dyn ThreadHeaders>,
        surface: Arc<dyn ToolSurfaceStatus>,
        extensions: Arc<ConfigExtensions>,
        announce: Arc<dyn Fn() + Send + Sync>,
        opener: Arc<UrlOpener>,
        generation: mixdog_core::run_host::surface_host::SurfaceGeneration,
    ) -> Arc<Self> {
        Arc::new(Self { cwd, headers, surface, extensions, announce, opener, generation })
    }
}

#[async_trait]
impl McpSurface for DaemonMcpSurface {
    /// `rt.currentCwd`: the thread's own folder, else the explicit session folder, else the
    /// process's.
    async fn current_cwd(&self, thread: Option<&str>) -> Result<PathBuf, String> {
        let scoped = match thread {
            // `Ok(None)`: no such thread; an `Err` read never ran and says nothing about it.
            Some(id) => self
                .headers
                .header(&id.into())
                .await
                .map_err(|error| error.to_string())?
                .and_then(|header| header.get("cwd").and_then(Value::as_str).map(str::to_owned)),
            None => None,
        };
        // A read that did not run (lane full or wedged) is the caller's error, not "no saved cwd".
        match self.cwd.explicit_cwd(scoped.as_deref()).await.map_err(|error| error.to_string())? {
            Some(dir) => Ok(PathBuf::from(dir)),
            None => std::env::current_dir().map_err(|error| error.to_string()),
        }
    }

    /// `session.mcpScopeId`: what the thread's stored header names, which a spawned child takes from
    /// the session that spawned it (`spawn-plan.mjs:108`) and a session from its own seed.
    async fn thread_scope(&self, thread: &str) -> Result<Option<String>, String> {
        let header = self.headers.header(&thread.into()).await.map_err(|error| error.to_string())?;
        Ok(header
            .and_then(|header| header.get("mcpScopeId").and_then(Value::as_str).map(|scope| mixdog_js::js_trim(scope).to_owned()))
            .filter(|scope| !scope.is_empty()))
    }

    /// `invalidatePreSessionToolSurface()`: the core builds a session's tool surface from its
    /// sources on every call and keeps no copy before the session exists, so there is nothing to
    /// drop (the same ruling as `DaemonFeatureEffects::invalidate_pre_session_tool_surface`); the
    /// surface generation moves, as Node's does.
    async fn refresh_surface(&self) {
        self.generation.bump();
    }

    /// `getTools().map(t => t.name)`: the live surface's tool names (`StatusSurface::listed`: eager
    /// tools, deferred catalog, late deferred catalog; each once).
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        self.surface.surface(None).await.map(|surface| surface.listed).map_err(|error| error.to_string())
    }

    fn open_browser(&self, url: &str) {
        self.opener.open(url);
    }

    fn announce_plugins(&self) {
        (self.announce)();
    }

    async fn flush_skills_save(&self) {
        self.extensions.flush_skills_save().await;
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures are written straight to a temp dir")]
mod tests {
    use serde_json::Map;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../tests/golden/bridge.json")).unwrap()
    }

    /// The environment of one recorded case, folders under `base`.
    fn env_of(case: &Value, base: &Path) -> (EnvReader, PathBuf) {
        let mut vars: HashMap<String, String> = HashMap::new();
        let folder = |name: &str| base.join(name);
        let where_ = case["where"].as_str().unwrap();
        let dir = match where_ {
            "discovery" => folder("discovery"),
            "data" => folder("data"),
            _ => folder("home").join("data"),
        };
        match where_ {
            "discovery" => {
                vars.insert("MIXDOG_BRIDGE_DISCOVERY_DIR".into(), folder("discovery").to_string_lossy().into_owned());
                vars.insert("MIXDOG_HOME".into(), folder("unused-home").to_string_lossy().into_owned());
            }
            "data" => {
                vars.insert("MIXDOG_DATA_DIR".into(), folder("data").to_string_lossy().into_owned());
                vars.insert("MIXDOG_HOME".into(), folder("unused-home").to_string_lossy().into_owned());
            }
            _ => {
                vars.insert("MIXDOG_HOME".into(), folder("home").to_string_lossy().into_owned());
            }
        }
        for (name, value) in case["env"].as_object().unwrap() {
            vars.insert(name.clone(), value.as_str().unwrap().replace("{other}", &folder("other").to_string_lossy()));
        }
        (Arc::new(move |name| vars.get(name).cloned()), dir)
    }

    fn lay_out(case: &Value, dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let now = std::time::SystemTime::now();
        for (file, entry) in case["files"].as_object().unwrap() {
            let path = dir.join(file);
            std::fs::write(&path, entry["text"].as_str().unwrap().replace("{alive}", &std::process::id().to_string())).unwrap();
            let age = std::time::Duration::from_secs(entry["ageSec"].as_u64().unwrap());
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(now - age).unwrap();
        }
        for folder in case["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(dir.join(folder.as_str().unwrap())).unwrap();
        }
    }

    struct Doc(Map<String, Value>);

    #[async_trait]
    impl mixdog_mcp::extension_service::ExtensionConfig for Doc {
        fn agent(&self) -> Map<String, Value> {
            self.0.clone()
        }
        async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
            Ok(())
        }
        fn set_disabled_skills(&self, _: &[String]) {}
    }

    /// Every recorded case: the four ids Node's `builtinFeatureActive` answers, which is the
    /// feature switch first, then (visualize) its module toggle, then the bridge file.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_bridges_found_up_are_the_ones_node_finds_up() {
        use mixdog_mcp::skill_catalog::SkillSettingsSource;
        let g = golden();
        let tokens = mixdog_rt::testing::tokens();
        for case in g["cases"].as_array().unwrap() {
            let base = tempfile::tempdir().unwrap();
            let (env, dir) = env_of(case, base.path());
            lay_out(case, &dir);
            let found = discovery_dir(&env, &base.path().join("no-home"));
            // The files lie in `dir`; a non-empty discovery variable names another folder to read.
            let read_from = case["env"]["MIXDOG_BRIDGE_DISCOVERY_DIR"].as_str().filter(|set| !set.is_empty()).map_or_else(|| dir.clone(), |set| PathBuf::from(set.replace("{other}", &base.path().join("other").to_string_lossy())));
            assert_eq!(found, read_from, "{}: the folder", case["name"]);
            let bridges = started(found, tokens.maintenance_io).await;
            let agent = case["config"].as_object().cloned().unwrap_or_default();
            let settings = crate::compose_mcp::ConfigSkillSettings::new(Arc::new(Doc(agent)), env, bridges);
            let active = settings.current().gate.active_features;
            for id in FEATURES {
                assert_eq!(active.contains(id), case["answer"][id].as_bool().unwrap(), "{}: {id}", case["name"]);
            }
        }
    }

    #[test]
    fn the_default_folder_is_under_the_home() {
        let env: EnvReader = Arc::new(|_| None);
        assert_eq!(discovery_dir(&env, Path::new("/h")), Path::new("/h").join(".mixdog").join("data"));
    }

    /// A started copy over a real `FolderWatcher`.
    async fn started(dir: PathBuf, io: MaintenanceIo) -> Arc<SharedBridgeFiles> {
        let files = BridgeFiles::new(dir, io);
        let watcher = Arc::new(FolderWatcher::new(files.sink()).unwrap());
        files.start(watcher).await;
        Arc::new(SharedBridgeFiles(files))
    }

    /// Waits until the answer for `browser` is `want`, woken by each read the copy takes in (the
    /// receiver is made before the answer is looked at, so no read is missed).
    async fn browser_becomes(bridges: &SharedBridgeFiles, want: bool) {
        let mut applied = bridges.0.applied();
        while bridges.present("browser") != want {
            applied.changed().await.expect("the copy is alive");
        }
    }

    fn advert() -> String {
        format!(r#"{{"version":1,"port":9,"token":"t","pid":{}}}"#, std::process::id())
    }

    /// A change of a watched file reaches the copy through the watch, with nobody asking for it;
    /// a removal does too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_watch_keeps_the_copy_current() {
        let base = tempfile::tempdir().unwrap();
        let bridges = started(base.path().to_path_buf(), mixdog_rt::testing::tokens().maintenance_io).await;
        assert!(!bridges.present("browser"));
        std::fs::write(base.path().join("browser-bridge.json"), advert()).unwrap();
        browser_becomes(&bridges, true).await;
        assert!(!bridges.present("computer"));
        std::fs::remove_file(base.path().join("browser-bridge.json")).unwrap();
        browser_becomes(&bridges, false).await;
        assert!(!bridges.present("nothing"));
    }

    /// A folder that does not exist yet is followed from the nearest ancestor: when it appears
    /// the watch moves onto it and the files in it are read.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_folder_created_later_is_followed() {
        let base = tempfile::tempdir().unwrap();
        let dir = base.path().join("later");
        let bridges = started(dir.clone(), mixdog_rt::testing::tokens().maintenance_io).await;
        assert!(!bridges.present("browser"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("browser-bridge.json"), advert()).unwrap();
        browser_becomes(&bridges, true).await;
    }

    #[test]
    fn the_browser_is_opened_by_the_platform_opener() {
        assert_eq!(candidates("http://x/?a=1", true, false, false, "C:\\W"), vec![("C:\\W\\System32\\rundll32.exe".to_owned(), vec!["url.dll,FileProtocolHandler".to_owned(), "http://x/?a=1".to_owned()])]);
        assert_eq!(candidates("u", false, true, false, "").first().map(|c| c.0.as_str()), Some("open"));
        assert_eq!(candidates("u", false, false, false, "").first().map(|c| c.0.as_str()), Some("xdg-open"));
        let wsl = candidates("it's", false, false, true, "");
        assert_eq!(wsl.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), ["wslview", "powershell.exe"]);
        assert_eq!(wsl[1].1[3], "Start-Process -FilePath 'it''s'");
    }
}
