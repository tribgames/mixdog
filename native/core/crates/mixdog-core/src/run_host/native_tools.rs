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
use mixdog_rt::TimerHandle;
use mixdog_tools::state::secrets::ComputerSecretHost;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_rt::InteractiveIo;
use mixdog_tools::desktop::computer_backend::ComputerConfig;
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
    pub async fn computer_sessions(&self, manager: Arc<dyn ProcessManager>, wrap: WrapBackend) -> Option<Arc<ComputerSessionPool>> {
        let binary = self.resolve(NativeTool::Computer).await?;
        Some(Arc::new(ComputerSessionPool::new(binary, manager, wrap)))
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
}

fn session_key(session: &str) -> String {
    let id = session.trim();
    if id.is_empty() { DEFAULT_SESSION.to_owned() } else { id.to_owned() }
}

impl ComputerSessionPool {
    pub fn new(binary: PathBuf, manager: Arc<dyn ProcessManager>, wrap: WrapBackend) -> Self {
        Self { binary, manager, wrap, entries: Mutex::new(HashMap::new()) }
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The session's helper and its (decorated) backend; a use disarms a pending idle release.
    fn entry_for(&self, session: &str) -> (Arc<ProcessComputerBackend>, Arc<dyn ComputerBackend>) {
        let key = session_key(session);
        let mut entries = self.entries();
        let entry = entries.entry(key.clone()).or_insert_with(|| {
            let process = Arc::new(ProcessComputerBackend::new(ComputerConfig::new(self.binary.clone(), key.as_str()), self.manager.clone()));
            let backend = (self.wrap)(&key, process.clone());
            Entry { process, backend, idle: None }
        });
        if let Some(timer) = entry.idle.take() {
            let _disarmed = timer.cancel();
        }
        (entry.process.clone(), entry.backend.clone())
    }

    /// `releaseComputerSession(id)`: the session's helper state is dropped now. A call still
    /// running keeps its backend until it ends. False when the session never reached the helper.
    pub fn release(&self, session: &str) -> bool {
        let removed = self.entries().remove(&session_key(session));
        match removed {
            Some(mut entry) => {
                if let Some(timer) = entry.idle.take() {
                    let _disarmed = timer.cancel();
                }
                true
            }
            None => false,
        }
    }

    /// `deferComputerSessionRelease(id)`: releases the session after two idle minutes. False for a
    /// session that never reached the helper (it owns nothing there).
    pub fn defer_release(self: &Arc<Self>, session: &str) -> bool {
        let key = session_key(session);
        let mut entries = self.entries();
        let Some(entry) = entries.get_mut(&key) else { return false };
        if let Some(timer) = entry.idle.take() {
            let _disarmed = timer.cancel();
        }
        let pool = Arc::downgrade(self);
        let id = key.clone();
        entry.idle = Some(mixdog_rt::ticker().register(Instant::now() + IDLE_RELEASE, move || {
            if let Some(pool) = pool.upgrade() {
                pool.release(&id);
            }
        }));
        true
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

    /// The sessions exist exactly when the helper does, wherever Node's order finds it.
    #[tokio::test]
    async fn the_computer_sessions_are_built_only_where_the_helper_is() {
        let tool = NativeTool::Computer;
        assert!(paths(&[], &[bundled(tool)], None).computer_sessions(manager(), plain()).await.is_some());
        assert!(paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[PathBuf::from("/x/c")], None).computer_sessions(manager(), plain()).await.is_some());
        assert!(paths(&[], &[], None).computer_sessions(manager(), plain()).await.is_none());
    }

    /// Node keeps the helper's state per request session: two threads never share a backend, a
    /// thread keeps its own across calls, a request naming no thread is the `default` session, and
    /// a released session starts over with fresh state.
    #[tokio::test]
    async fn two_threads_get_separate_helper_state() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain()).await.expect("helper");
        let (a, b) = (pool.backend("thread-a"), pool.backend("thread-b"));
        assert!(!Arc::ptr_eq(&a, &b), "separate threads, separate state");
        assert!(Arc::ptr_eq(&a, &pool.backend("thread-a")), "a thread keeps its state");
        assert!(Arc::ptr_eq(&pool.backend(""), &pool.backend("default")), "no thread is the default session");
        assert!(!Arc::ptr_eq(&a, &pool.backend("")));
        // The secret fill drives the helper of the same session its tool calls use.
        assert!(pool.secret_host(&ThreadId::from("thread-b")).is_some());
        assert!(pool.release("thread-a"));
        assert!(!pool.release("thread-a"), "release is idempotent");
        assert!(!Arc::ptr_eq(&a, &pool.backend("thread-a")), "a released session starts over");
        assert!(Arc::ptr_eq(&b, &pool.backend("thread-b")), "another thread's state is untouched");
        assert!(!pool.defer_release("never-used"), "a session that never reached the helper owns nothing");
    }
}
