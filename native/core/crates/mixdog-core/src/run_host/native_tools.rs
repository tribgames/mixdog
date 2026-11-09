//! Where a native helper binary is: the one resolver for `mixdog-graph` and `mixdog-computer`.
//!
//! Node resolves each as follows, and so does this:
//! - graph (`code-graph/graph-binary.mjs` `_graphBinaryPath`): `MIXDOG_GRAPH_BIN` when it names an
//!   existing file, then a local cargo build (`native/mixdog-graph/target/release/`), then the
//!   package's `native-tools/`, then a binary a verified download cached (`findCachedGraphBinary`).
//! - computer (`apps/desktop/src/main/index.ts:356`, where the desktop's main process picks its
//!   helper): `MIXDOG_COMPUTER_BIN` as given (even a name that is no file: the spawn fails on it), else the bundled `native-tools/mixdog-computer`, else the
//!   local cargo build (`native/mixdog-computer/target/release/`). Unlike Node, which keeps a
//!   PowerShell worker on Windows, the Rust core runs Computer Use through this helper on every
//!   OS (decision D-DESKTOP), so Windows resolves it too.
//!
//! The packaged desktop sets those variables itself from its resources, so for it the first step
//! is the answer. `root` is the package root, the directory that holds `native/` and
//! `native-tools/`.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::secret_input::ComputerSecretHosts;
use mixdog_core_session::session::shell_jobs::OwnedShells;
use mixdog_core_session::session::turn_snapshots::TurnSnapshots;
use mixdog_rt::TimerHandle;
use mixdog_tools::state::secrets::ComputerSecretHost;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_rt::InteractiveIo;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_protocol::ComputerSection;
use mixdog_protocol::ComputerSessionSection;
use mixdog_protocol::SectionName;
use mixdog_tools::desktop::computer_backend::ComputerConfig;
use mixdog_tools::desktop::computer_backend::ExecutionObserver;
use mixdog_tools::desktop::computer_backend::ProcessComputerBackend;

use crate::run_host::run_seams::EnvReader;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NativeTool {
    Graph,
    Computer,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    Env,
    LocalBuild,
    Package,
    Cached,
}

impl NativeTool {
    fn env_name(self) -> &'static str {
        match self {
            Self::Graph => "MIXDOG_GRAPH_BIN",
            Self::Computer => "MIXDOG_COMPUTER_BIN",
        }
    }

    fn stem(self) -> &'static str {
        match self {
            Self::Graph => "mixdog-graph",
            Self::Computer => "mixdog-computer",
        }
    }

    /// The order Node tries the places in.
    fn steps(self) -> &'static [Step] {
        match self {
            Self::Graph => &[Step::Env, Step::LocalBuild, Step::Package, Step::Cached],
            Self::Computer => &[Step::Env, Step::Package, Step::LocalBuild],
        }
    }

    fn file_name(self) -> String {
        format!("{}{}", self.stem(), if cfg!(windows) { ".exe" } else { "" })
    }
}

/// Whether a path exists (`existsSync`).
#[async_trait]
pub trait PathExists: Send + Sync {
    async fn exists(&self, path: &Path) -> bool;
}

/// Existence through the file service on the interactive lane.
pub struct FileServiceExists {
    pub files: Arc<dyn FileService>,
    pub lane: InteractiveIo,
}

#[async_trait]
impl PathExists for FileServiceExists {
    async fn exists(&self, path: &Path) -> bool {
        match AbsPath::new(path.to_owned()) {
            Some(abs) => self.files.stat(self.lane, abs).await.is_ok(),
            None => false,
        }
    }
}

/// A binary an earlier verified download left in the data directory (`findCachedGraphBinary`).
#[async_trait]
pub trait CachedNativeTool: Send + Sync {
    async fn find(&self, tool: NativeTool) -> Option<PathBuf>;
}

pub struct NativeToolPaths {
    env: EnvReader,
    root: PathBuf,
    exists: Arc<dyn PathExists>,
    /// `None` where nothing downloads native tools.
    cached: Option<Arc<dyn CachedNativeTool>>,
}

impl NativeToolPaths {
    pub fn new(env: EnvReader, root: PathBuf, exists: Arc<dyn PathExists>, cached: Option<Arc<dyn CachedNativeTool>>) -> Self {
        Self { env, root, exists, cached }
    }

    /// The absolute path of `tool`, or `None` when no place has it.
    pub async fn resolve(&self, tool: NativeTool) -> Option<PathBuf> {
        for step in tool.steps() {
            let found = match step {
                Step::Env => match (self.env)(tool.env_name()).filter(|value| !value.is_empty()) {
                    // Node's `computerNativeBinary` hands the variable to the spawn as given, so a
                    // name that is not a file fails there instead of falling to the next place.
                    Some(path) if tool == NativeTool::Computer => Some(PathBuf::from(path)),
                    Some(path) if self.exists.exists(Path::new(&path)).await => Some(PathBuf::from(path)),
                    _ => None,
                },
                Step::LocalBuild => self.present(self.root.join("native").join(tool.stem()).join("target").join("release").join(tool.file_name())).await,
                Step::Package => self.present(self.root.join("native-tools").join(tool.file_name())).await,
                Step::Cached => match &self.cached {
                    Some(cache) => cache.find(tool).await,
                    None => None,
                },
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// The `computer` tool's per-session backends: the resolved `mixdog-computer` helper run under
    /// `manager`, one helper state per session, or `None` where no place has it (the tool is then
    /// not registered). `wrap` decorates each session's backend as it is made (the secret
    /// redaction of that session).
    pub async fn computer_sessions(
        &self,
        manager: Arc<dyn ProcessManager>,
        wrap: WrapBackend,
        publisher: Arc<dyn StatePublisher>,
    ) -> Option<Arc<ComputerSessionPool>> {
        let binary = self.resolve(NativeTool::Computer).await?;
        Some(Arc::new(ComputerSessionPool::new(binary, manager, wrap, publisher)))
    }

    async fn present(&self, path: PathBuf) -> Option<PathBuf> {
        self.exists.exists(&path).await.then_some(path)
    }
}

/// The session a request without one belongs to (`request.session_id || 'default'`,
/// `apps/desktop/src/main/computer/backend/worker-pool.ts:70`).
const DEFAULT_SESSION: &str = "default";

/// `DEFERRED_SESSION_RELEASE_MS` (`computer-bridge/client.mjs:41`).
const IDLE_RELEASE: Duration = Duration::from_secs(2 * 60);

/// `SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS` (`client.mjs:43`).
const SHUTDOWN_RELEASE: Duration = Duration::from_secs(5);

/// Decorates a session's backend as it is made.
pub type WrapBackend = Arc<dyn Fn(&str, Arc<dyn ComputerBackend>) -> Arc<dyn ComputerBackend> + Send + Sync>;

struct Entry {
    process: Arc<ProcessComputerBackend>,
    backend: Arc<dyn ComputerBackend>,
    /// The armed idle release (`deferComputerSessionRelease`).
    idle: Option<TimerHandle>,
}

/// One `mixdog-computer` helper per session, made on the session's first request. Node's host
/// keeps the helper's state (held input, element refs, window claims) per request `session_id`;
/// a state is dropped when:
/// - the session closes: [`Self::release`] (`releaseComputerSession(closingSessionId)` in a real
///   teardown, `session-runtime/lifecycle/teardown/runtime-stops.mjs:68-71`);
/// - the session has been idle for two minutes after a turn settled: [`Self::defer_release`]
///   (`deferComputerSessionRelease`, `turn/turn-run/turn-settle.mjs:79`, delay
///   `client.mjs:41`, armed only for a session that reached the helper, `client.mjs:702-703`; a
///   later use disarms it, `client.mjs:698`);
/// - the process ends: dropping the pool drops every backend, whose drop runs the helper's
///   `--abort-cleanup` (`releaseAllComputerSessions`, `client.mjs:751-768`).
pub struct ComputerSessionPool {
    binary: PathBuf,
    manager: Arc<dyn ProcessManager>,
    wrap: WrapBackend,
    entries: Mutex<HashMap<String, Entry>>,
    presence: Arc<ComputerPresence>,
}

/// The sessions with an open execution, oldest first, and the `computer` section that says so (SPEC R40): the pill
/// the desktop shows while an agent drives the desktop. Node's coordinator keeps a session present from its first
/// command (`beginCommand`) until the turn settles (`endExecution`) and its snapshot lists every one of them
/// (`coordinator.ts` `snapshot().activities`); the section lists them all, and names the latest in its own fields.
struct ComputerPresence {
    publisher: Arc<dyn StatePublisher>,
    open: Mutex<Vec<(String, bool)>>,
}

impl ComputerPresence {
    fn publish(&self, open: &[(String, bool)]) {
        let latest = open.last();
        let section = ComputerSection {
            active: latest.is_some(),
            observe_only: latest.is_some_and(|(_, observe_only)| *observe_only),
            controller: None,
            sessions: open
                .iter()
                .map(|(session, observe_only)| ComputerSessionSection {
                    session_thread_id: ThreadId::from(session.as_str()),
                    observe_only: *observe_only,
                })
                .collect(),
            session_thread_id: latest.map(|(session, _)| ThreadId::from(session.as_str())),
        };
        self.publisher.publish(SectionName::Computer, None, change_of(&section));
    }
}

/// One session's edges into [`ComputerPresence`].
struct SessionPresence {
    presence: Arc<ComputerPresence>,
    session: String,
}

impl ExecutionObserver for SessionPresence {
    fn began(&self, observe_only: bool) {
        let mut open = self.presence.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.retain(|(session, _)| *session != self.session);
        open.push((self.session.clone(), observe_only));
        self.presence.publish(&open);
    }

    fn ended(&self) {
        let mut open = self.presence.open.lock().unwrap_or_else(PoisonError::into_inner);
        let before = open.len();
        open.retain(|(session, _)| *session != self.session);
        if open.len() != before {
            self.presence.publish(&open);
        }
    }
}

fn session_key(session: &str) -> String {
    let id = session.trim();
    if id.is_empty() { DEFAULT_SESSION.to_owned() } else { id.to_owned() }
}

impl ComputerSessionPool {
    pub fn new(binary: PathBuf, manager: Arc<dyn ProcessManager>, wrap: WrapBackend, publisher: Arc<dyn StatePublisher>) -> Self {
        Self { binary, manager, wrap, entries: Mutex::new(HashMap::new()), presence: Arc::new(ComputerPresence { publisher, open: Mutex::default() }) }
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The session's helper and its (decorated) backend; a use disarms a pending idle release.
    fn entry_for(&self, session: &str) -> (Arc<ProcessComputerBackend>, Arc<dyn ComputerBackend>) {
        let key = session_key(session);
        let mut entries = self.entries();
        let entry = entries.entry(key.clone()).or_insert_with(|| {
            let observer = Arc::new(SessionPresence { presence: self.presence.clone(), session: key.clone() });
            let process = Arc::new(
                ProcessComputerBackend::new(ComputerConfig::new(self.binary.clone(), key.as_str()), self.manager.clone()).with_observer(observer),
            );
            let backend = (self.wrap)(&key, process.clone());
            Entry { process, backend, idle: None }
        });
        if let Some(timer) = entry.idle.take() {
            let _disarmed = timer.cancel();
        }
        (entry.process.clone(), entry.backend.clone())
    }

    /// `releaseComputerSession(id)`: the helper is told to release the session (`release_session`),
    /// stopped and cleaned up, and the session's state is dropped. A call still running keeps its
    /// backend until it ends. False when the session never reached the helper or the release was
    /// not confirmed.
    pub async fn release(&self, session: &str) -> bool {
        let removed = self.entries().remove(&session_key(session));
        let Some(mut entry) = removed else { return false };
        if let Some(timer) = entry.idle.take() {
            let _disarmed = timer.cancel();
        }
        entry.process.release_session().await
    }

    /// `releaseAllComputerSessions` (`bridge-clients.mjs`), which the daemon's shutdown awaits after its sessions closed: every pending idle release is
    /// cancelled, then each session that reached the helper is released, all at once. Returns how many releases the helper confirmed. Each release is bounded by
    /// `SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS` (`client.mjs:761`) and one that does not end in time counts as unconfirmed, so a stuck helper cannot hold the stop steps
    /// after this one (they share the `closeDataHandles` budget). The release dropped on expiry takes its backend with it, whose drop runs the helper's `--abort-cleanup`.
    pub async fn release_all(&self) -> usize {
        let bound: Vec<String> = {
            let mut entries = self.entries();
            for entry in entries.values_mut() {
                if let Some(timer) = entry.idle.take() {
                    let _disarmed = timer.cancel();
                }
            }
            entries.iter().filter(|(_, entry)| entry.process.is_bound()).map(|(id, _)| id.clone()).collect()
        };
        let outcomes = futures::future::join_all(bound.iter().map(|id| async move { tokio::time::timeout(SHUTDOWN_RELEASE, self.release(id)).await.unwrap_or(false) })).await;
        outcomes.into_iter().filter(|released| *released).count()
    }

    /// `endComputerExecution(id)`: the turn's execution ends, the helper stays warm. False for a
    /// session with no open execution.
    pub async fn end_execution(&self, session: &str) -> bool {
        let process = self.entries().get(&session_key(session)).map(|entry| entry.process.clone());
        match process {
            Some(process) => process.end_execution().await,
            None => false,
        }
    }

    /// `deferComputerSessionRelease(id)`: releases the session after two idle minutes. False for a
    /// session that never reached the helper, or was aborted since (it owns nothing there). Must
    /// run inside the runtime: the release is a task.
    pub fn defer_release(self: &Arc<Self>, session: &str) -> bool {
        let key = session_key(session);
        let mut entries = self.entries();
        let Some(entry) = entries.get_mut(&key).filter(|entry| entry.process.is_bound()) else { return false };
        if let Some(timer) = entry.idle.take() {
            let _disarmed = timer.cancel();
        }
        let (pool, runtime, id) = (Arc::downgrade(self), tokio::runtime::Handle::current(), key.clone());
        entry.idle = Some(mixdog_rt::ticker().register(Instant::now() + IDLE_RELEASE, move || {
            if let Some(pool) = pool.upgrade() {
                runtime.spawn(async move { pool.release(&id).await });
            }
        }));
        true
    }
}

/// The shells of a closing session and its computer helper go together: Node's teardown stops
/// both under the one `teardownReapsWork && closingSessionId` gate (`runtime-stops.mjs:53-71`:
/// `shutdownShellJobs` and `releaseComputerSession(closingSessionId)`). Every real close in the
/// session layer cancels the owner's shells through `OwnedShells::cancel_owned`
/// (`close.rs:104` `stop_session_work`, used by `SessionClose`, `AgentSessions` and the context
/// switch; `purge.rs:292` for a delete), so the computer release rides that one seam. An unload
/// (a `keepBackgroundWork` eviction in Node) never cancels shells, so it leaves the helper state
/// to the idle release, as Node does. Pass this wherever
/// the composition passes the `ShellControl` as `Arc<dyn OwnedShells>`.
pub struct ReapingShells {
    shells: Arc<dyn OwnedShells>,
    computer: Arc<ComputerSessionPool>,
    /// The releases still running, for the tests to await.
    #[cfg(test)]
    releases: Mutex<Vec<tokio::task::JoinHandle<bool>>>,
}

impl ReapingShells {
    pub fn new(shells: Arc<dyn OwnedShells>, computer: Arc<ComputerSessionPool>) -> Self {
        Self {
            shells,
            computer,
            #[cfg(test)]
            releases: Mutex::default(),
        }
    }

    /// Returns once every release started so far has ended.
    #[cfg(test)]
    async fn released(&self) {
        let tasks = std::mem::take(&mut *self.releases.lock().unwrap_or_else(PoisonError::into_inner));
        for task in tasks {
            task.await.expect("a session's computer release");
        }
    }
}

impl OwnedShells for ReapingShells {
    fn cancel_owned(&self, owner: &ThreadId) {
        self.shells.cancel_owned(owner);
        let (computer, session) = (self.computer.clone(), owner.as_str().to_owned());
        let _release = tokio::spawn(async move { computer.release(&session).await });
        #[cfg(test)]
        self.releases.lock().unwrap_or_else(PoisonError::into_inner).push(_release);
    }
}

/// A turn's settlement ends its computer execution and arms the idle release: Node's `settleTurn`
/// runs `releaseComputerUse` (`endComputerExecution`, then `deferComputerSessionRelease`,
/// `turn-settle.mjs:70-82`) immediately before `turn.releaseWorkspace()` (`:97`), and the session
/// calls `TurnSnapshots::turn_settled` at that same point (actor `run_ended`). Pass this as
/// `SessionDeps.snapshots`, around the `WorktreeTurnSnapshots`.
pub struct SettlingSnapshots {
    snapshots: Arc<dyn TurnSnapshots>,
    computer: Arc<ComputerSessionPool>,
    /// The settlements still running, for the tests to await.
    #[cfg(test)]
    settlements: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl SettlingSnapshots {
    pub fn new(snapshots: Arc<dyn TurnSnapshots>, computer: Arc<ComputerSessionPool>) -> Self {
        Self {
            snapshots,
            computer,
            #[cfg(test)]
            settlements: Mutex::default(),
        }
    }

    /// Returns once every settlement started so far has ended.
    #[cfg(test)]
    async fn settled(&self) {
        let tasks = std::mem::take(&mut *self.settlements.lock().unwrap_or_else(PoisonError::into_inner));
        for task in tasks {
            task.await.expect("a turn's computer settlement");
        }
    }
}

impl TurnSnapshots for SettlingSnapshots {
    fn turn_settled(&self, thread: &ThreadId) {
        let (computer, session) = (self.computer.clone(), thread.as_str().to_owned());
        let _settlement = tokio::spawn(async move {
            computer.end_execution(&session).await;
            computer.defer_release(&session);
        });
        #[cfg(test)]
        self.settlements.lock().unwrap_or_else(PoisonError::into_inner).push(_settlement);
        self.snapshots.turn_settled(thread);
    }

    fn runtime_stopped(&self, thread: &ThreadId) {
        self.snapshots.runtime_stopped(thread);
    }

    fn dispose(&self) {
        self.snapshots.dispose();
    }
}

impl ComputerSessions for ComputerSessionPool {
    fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
        self.entry_for(session).1
    }
}

/// The secret fill drives the helper of the thread's own session, the one state its `computer`
/// calls use.
impl ComputerSecretHosts for ComputerSessionPool {
    fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>> {
        Some(self.entry_for(thread.as_str()).0)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::collections::HashMap;

    use mixdog_core_api::state::SectionChange;
    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerRequest;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    struct Present(HashSet<PathBuf>);

    #[async_trait]
    impl PathExists for Present {
        async fn exists(&self, path: &Path) -> bool {
            self.0.contains(path)
        }
    }

    struct Cache(Option<PathBuf>);

    #[async_trait]
    impl CachedNativeTool for Cache {
        async fn find(&self, _: NativeTool) -> Option<PathBuf> {
            self.0.clone()
        }
    }

    fn paths(env: &[(&str, &str)], present: &[PathBuf], cached: Option<PathBuf>) -> NativeToolPaths {
        let vars: HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        NativeToolPaths::new(
            Arc::new(move |name| vars.get(name).cloned()),
            PathBuf::from("/pkg"),
            Arc::new(Present(present.iter().cloned().collect())),
            Some(Arc::new(Cache(cached))),
        )
    }

    fn built(tool: NativeTool) -> PathBuf {
        PathBuf::from("/pkg/native").join(tool.stem()).join("target/release").join(tool.file_name())
    }

    fn bundled(tool: NativeTool) -> PathBuf {
        PathBuf::from("/pkg/native-tools").join(tool.file_name())
    }

    #[tokio::test]
    async fn the_graph_binary_is_looked_for_in_nodes_order() {
        let tool = NativeTool::Graph;
        let cached = Some(PathBuf::from("/data/graph-bin/mixdog-graph-1"));
        let everything = [PathBuf::from("/x/graph"), built(tool), bundled(tool)];
        assert_eq!(paths(&[("MIXDOG_GRAPH_BIN", "/x/graph")], &everything, cached.clone()).resolve(tool).await, Some(PathBuf::from("/x/graph")));
        // An override that names nothing is skipped, not an error.
        assert_eq!(paths(&[("MIXDOG_GRAPH_BIN", "/x/gone")], &everything, cached.clone()).resolve(tool).await, Some(built(tool)));
        assert_eq!(paths(&[], &everything[2..], cached.clone()).resolve(tool).await, Some(bundled(tool)));
        assert_eq!(paths(&[], &[], cached.clone()).resolve(tool).await, cached);
        assert_eq!(paths(&[], &[], None).resolve(tool).await, None);
    }

    #[tokio::test]
    async fn the_computer_helper_has_no_download() {
        let tool = NativeTool::Computer;
        let cached = Some(PathBuf::from("/data/never"));
        let all = [PathBuf::from("/x/c"), bundled(tool), built(tool)];
        assert_eq!(paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &all, cached.clone()).resolve(tool).await, Some(PathBuf::from("/x/c")));
        assert_eq!(paths(&[], &all[1..], cached.clone()).resolve(tool).await, Some(bundled(tool)));
        assert_eq!(paths(&[], &all[2..], cached.clone()).resolve(tool).await, Some(built(tool)));
        assert_eq!(paths(&[], &[], cached).resolve(tool).await, None, "the computer helper is never taken from the graph cache");
    }

    /// Node uses `MIXDOG_COMPUTER_BIN` as given: one that names no file is the answer, and the
    /// spawn fails on it, rather than the bundled helper being used instead.
    #[tokio::test]
    async fn a_computer_override_naming_no_file_is_used_as_given() {
        let tool = NativeTool::Computer;
        let all = [bundled(tool), built(tool)];
        assert_eq!(paths(&[("MIXDOG_COMPUTER_BIN", "/x/gone")], &all, None).resolve(tool).await, Some(PathBuf::from("/x/gone")));
        assert_eq!(paths(&[("MIXDOG_COMPUTER_BIN", "")], &all, None).resolve(tool).await, Some(bundled(tool)), "an empty value is unset");
    }

    fn manager() -> Arc<dyn ProcessManager> {
        let tokens = mixdog_rt::testing::tokens();
        Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()))
    }

    fn plain() -> WrapBackend {
        Arc::new(|_: &str, inner: Arc<dyn ComputerBackend>| inner)
    }

    /// Every `computer` publication, in order.
    #[derive(Default)]
    struct Published(Mutex<Vec<(SectionName, Option<String>, SectionChange)>>);

    impl StatePublisher for Published {
        fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
            self.0.lock().unwrap_or_else(PoisonError::into_inner).push((section, key, change));
        }
    }

    fn quiet() -> Arc<dyn StatePublisher> {
        Arc::new(Published::default())
    }

    fn computer_values(published: &Published) -> Vec<mixdog_protocol::ComputerSection> {
        published
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(section, key, change)| {
                assert_eq!((*section, key.as_deref()), (SectionName::Computer, None));
                let SectionChange::Set(bytes) = change else { panic!("a small section value is inline") };
                serde_json::from_slice(bytes).unwrap()
            })
            .collect()
    }

    /// The `computer` section (SPEC R40) follows the sessions' open executions: the pill shows while an agent
    /// drives the desktop. An action opens a session's execution (the helper cannot start here, but the action
    /// reached it); a second session opens beside the first, not instead of it; each settled turn closes its own.
    #[tokio::test]
    async fn the_computer_section_follows_the_open_executions() {
        let published = Arc::new(Published::default());
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), published.clone()).await.expect("helper");
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        // `open` is every session with an open execution, oldest first; the section's own fields name the last.
        let section = |open: &[&str]| mixdog_protocol::ComputerSection {
            active: !open.is_empty(),
            observe_only: false,
            controller: None,
            sessions: open
                .iter()
                .map(|session| ComputerSessionSection { session_thread_id: ThreadId::from(*session), observe_only: false })
                .collect(),
            session_thread_id: open.last().map(|session| ThreadId::from(*session)),
        };

        assert!(pool.backend("a").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.backend("b").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.backend("a").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.end_execution("a").await);
        assert!(pool.end_execution("b").await);
        assert!(!pool.end_execution("b").await, "an ended execution publishes nothing again");
        assert_eq!(
            computer_values(&published),
            [section(&["a"]), section(&["a", "b"]), section(&["b"]), section(&[])],
            "b opening beside a lists both, a's second action opens nothing, a closing leaves b, b closing leaves none"
        );
    }

    /// The sessions exist exactly when the helper does, wherever Node's order finds it.
    #[tokio::test]
    async fn the_computer_sessions_are_built_only_where_the_helper_is() {
        let tool = NativeTool::Computer;
        assert!(paths(&[], &[bundled(tool)], None).computer_sessions(manager(), plain(), quiet()).await.is_some());
        assert!(paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[PathBuf::from("/x/c")], None).computer_sessions(manager(), plain(), quiet()).await.is_some());
        assert!(paths(&[], &[], None).computer_sessions(manager(), plain(), quiet()).await.is_none());
    }

    struct Shells(Mutex<Vec<String>>);

    impl OwnedShells for Shells {
        fn cancel_owned(&self, owner: &ThreadId) {
            self.0.lock().unwrap_or_else(PoisonError::into_inner).push(owner.as_str().to_owned());
        }
    }

    /// A real close of a session cancels its shells and releases its helper state, as Node's
    /// teardown stops both under one gate; another session keeps its state.
    #[tokio::test]
    async fn closing_a_session_releases_its_computer_state_with_its_shells() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet()).await.expect("helper");
        let _ = (pool.backend("closing"), pool.backend("other"));
        let shells = Arc::new(Shells(Mutex::default()));
        let reaping = ReapingShells::new(shells.clone(), pool.clone());
        reaping.cancel_owned(&ThreadId::from("closing"));
        assert_eq!(*shells.0.lock().unwrap_or_else(PoisonError::into_inner), vec!["closing".to_owned()]);
        reaping.released().await;
        assert!(!pool.entries().contains_key("closing"));
        assert!(pool.entries().contains_key("other"));
    }

    struct Snapshots(Mutex<Vec<String>>);

    impl TurnSnapshots for Snapshots {
        fn turn_settled(&self, thread: &ThreadId) {
            self.0.lock().unwrap_or_else(PoisonError::into_inner).push(thread.as_str().to_owned());
        }
        fn runtime_stopped(&self, _: &ThreadId) {}
        fn dispose(&self) {}
    }

    /// A settled turn arms its session's idle release when the session reached the helper; a
    /// session that never did owns nothing there.
    #[tokio::test]
    async fn a_settled_turn_arms_the_idle_release_of_a_session_that_reached_the_helper() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet()).await.expect("helper");
        let backend = pool.backend("used");
        // The helper cannot start, but the action reached it: the session is bound.
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        assert!(backend.run(read, CancellationToken::new()).await.is_err());
        let snapshots = Arc::new(Snapshots(Mutex::default()));
        let settling = SettlingSnapshots::new(snapshots.clone(), pool.clone());
        settling.turn_settled(&ThreadId::from("never"));
        settling.turn_settled(&ThreadId::from("used"));
        assert_eq!(snapshots.0.lock().unwrap_or_else(PoisonError::into_inner).len(), 2, "the workspace release still runs");
        settling.settled().await;
        assert!(pool.entries().get("used").is_some_and(|entry| entry.idle.is_some()));
        assert!(!pool.entries().contains_key("never"), "a session that never reached the helper owns nothing there");
    }

    /// Node keeps the helper's state per request session: two threads never share a backend, a
    /// thread keeps its own across calls, a request naming no thread is the `default` session, and
    /// a released session starts over with fresh state.
    #[tokio::test]
    async fn two_threads_get_separate_helper_state() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet()).await.expect("helper");
        let (a, b) = (pool.backend("thread-a"), pool.backend("thread-b"));
        assert!(!Arc::ptr_eq(&a, &b), "separate threads, separate state");
        assert!(Arc::ptr_eq(&a, &pool.backend("thread-a")), "a thread keeps its state");
        assert!(Arc::ptr_eq(&pool.backend(""), &pool.backend("default")), "no thread is the default session");
        assert!(!Arc::ptr_eq(&a, &pool.backend("")));
        // The secret fill drives the helper of the same session its tool calls use.
        assert!(pool.secret_host(&ThreadId::from("thread-b")).is_some());
        // The fake helper path cannot run its cleanup, so the release is unconfirmed; the state goes anyway.
        assert!(!pool.release("thread-a").await);
        assert!(!pool.entries().contains_key("thread-a"));
        assert!(!pool.release("thread-a").await, "release is idempotent");
        assert!(!Arc::ptr_eq(&a, &pool.backend("thread-a")), "a released session starts over");
        assert!(Arc::ptr_eq(&b, &pool.backend("thread-b")), "another thread's state is untouched");
        assert!(!pool.defer_release("never-used"), "a session that never reached the helper owns nothing");
    }

    /// A process manager whose spawn never answers: the helper of a session is stuck.
    struct Stuck(tokio::sync::Notify);

    #[async_trait]
    impl ProcessManager for Stuck {
        async fn spawn(&self, _: mixdog_core_api::domain::process::SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
            self.0.notify_one();
            std::future::pending().await
        }
        fn subscribe(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: Option<u64>,
        ) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>, mixdog_core_api::domain::process::ProcessError> {
            unreachable!("nothing was spawned")
        }
        async fn write_stdin(&self, _: &mixdog_protocol::ProcessHandle, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn close_stdin(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn resize_pty(&self, _: &mixdog_protocol::ProcessHandle, _: mixdog_core_api::domain::process::PtySize) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn kill(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    /// Node bounds each shutdown release (`client.mjs:761`): a helper that never answers is given up on after the timeout, so `release_all` ends and the stop steps after it
    /// (memory, PostgreSQL) still run. Paused time: the timeout elapses without a sleep.
    #[tokio::test(start_paused = true)]
    async fn a_stuck_helper_release_ends_at_the_shutdown_timeout() {
        let stuck = Arc::new(Stuck(tokio::sync::Notify::new()));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(stuck.clone(), plain(), quiet()).await.expect("helper");
        let backend = pool.backend("stuck");
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let mut call = tokio::spawn(async move { backend.run(read, CancellationToken::new()).await });
        // The call's spawn is the helper that never answers; a call that ends without spawning it is the failure.
        tokio::select! {
            biased;
            () = stuck.0.notified() => {}
            ended = &mut call => panic!("the call ended without spawning the helper: {ended:?}"),
        }
        assert!(pool.entries().get("stuck").is_some_and(|entry| entry.process.is_bound()));
        let started = tokio::time::Instant::now();
        assert_eq!(pool.release_all().await, 0, "the stuck release is unconfirmed");
        assert!(started.elapsed() >= SHUTDOWN_RELEASE, "the release was given its whole bound");
        assert!(!pool.entries().contains_key("stuck"), "the session's state goes anyway");
        call.abort();
    }
}
