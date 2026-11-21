//! Where a native helper binary is: the one resolver for `mixdog-graph` and `mixdog-computer`.
//!
//! Node resolves each as follows, and so does this:
//! - graph (`code-graph/graph-binary.mjs` `_graphBinaryPath`): `MIXDOG_GRAPH_BIN` when it names an
//!   existing file, then a local cargo build (`native/mixdog-graph/target/release/`), then the
//!   package's `native-tools/`, then a binary a verified download cached (`findCachedGraphBinary`).
//! - computer (`apps/desktop/src/main/index.ts:356`, where the desktop's main process picks its
//!   helper): `MIXDOG_COMPUTER_BIN` as given (even a name that is no file: the spawn fails on it), else the bundled `native-tools/mixdog-computer`
//!   of the package root, else the one beside the packaged core (`<core dir>/../native-tools`, where the desktop installs it, for a core
//!   the desktop did not start and so gave no variable), else the local cargo build (`native/mixdog-computer/target/release/`). Unlike Node, which keeps a
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
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::Weak;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_core_config::config::ComputerBackendChoice;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::computer_backend;
use mixdog_core_session::session::secret_input::ComputerSecretHosts;
use mixdog_core_session::session::shell_jobs::OwnedShells;
use mixdog_core_session::session::turn_snapshots::TurnSnapshots;
use mixdog_protocol::ComputerBackendSection;
use mixdog_protocol::ComputerCleanupState;
use mixdog_protocol::ComputerSection;
use mixdog_protocol::ComputerSessionMode;
use mixdog_protocol::ComputerSessionSection;
use mixdog_protocol::SectionName;
use mixdog_rt::InteractiveIo;
use mixdog_rt::TimerHandle;
use mixdog_tools::desktop::computer_authority::Authority;
use mixdog_tools::desktop::computer_authority::AuthoritySwitch;
use mixdog_tools::desktop::computer_authority::DesktopRevocation;
use mixdog_tools::desktop::computer_authority::RevocationCleanup;
use mixdog_tools::desktop::computer_authority::RevocationReport;
use mixdog_tools::desktop::computer_authority::ScopedDesktop;
use mixdog_tools::desktop::computer_authority::revoke_at_desktop_reports;
use mixdog_tools::desktop::computer_backend::ComputerConfig;
use mixdog_tools::desktop::computer_backend::ComputerShared;
use mixdog_tools::desktop::computer_backend::ExecutionObserver;
use mixdog_tools::desktop::computer_backend::ObserveOnly;
use mixdog_tools::desktop::computer_backend::ProcessComputerBackend;
use mixdog_tools::desktop::computer_backend::revoke_launched;
use mixdog_tools::desktop::computer_budget::MAX_LIVE_HELPERS;
use mixdog_tools::desktop::computer_desktop_host::ComputerBlobs as HostBlobs;
use mixdog_tools::desktop::computer_desktop_host::DesktopHostBackend;
use mixdog_tools::desktop::computer_lane::Lane;
use mixdog_tools::desktop::computer_pointer::PointerHold;
use mixdog_tools::desktop::computer_pointer::PointerHost;
use mixdog_tools::desktop::computer_user_control::UserControlState;
use mixdog_tools::state::secrets::ComputerSecretHost;
use serde_json::Map;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

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
    /// The packaged desktop's layout, found from the core executable: `resources/core/<core>` and `resources/native-tools/<tool>`.
    BesideCore,
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
            Self::Computer => &[Step::Env, Step::Package, Step::BesideCore, Step::LocalBuild],
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
    /// The directory of the running core executable; the packaged desktop keeps its helpers in `../native-tools` of it, which the
    /// package root of a core that did not start from that package does not reach.
    exe_dir: Option<PathBuf>,
}

/// The session a request without one belongs to (`request.session_id || 'default'`,
/// `apps/desktop/src/main/computer/backend/worker-pool.ts:70`).
const DEFAULT_SESSION: &str = "default";

/// `DEFERRED_SESSION_RELEASE_MS` (`computer-bridge/client.mjs:41`).
const IDLE_RELEASE: Duration = Duration::from_secs(2 * 60);

/// `SHUTDOWN_SESSION_RELEASE_TIMEOUT_MS` (`client.mjs:43`).
const SHUTDOWN_RELEASE: Duration = Duration::from_secs(5);

/// How long `session_abort` waits for the desktop's own computer host (`SESSION_ABORT_TIMEOUT_MS` of the client).
const HOST_ABORT: Duration = Duration::from_secs(15);

/// How long `execution_end` waits for the desktop's own computer host (`EXECUTION_END_TIMEOUT_MS` of the client).
const HOST_EXECUTION_END: Duration = Duration::from_secs(3);

/// How long `session_release` waits for the desktop's own computer host (`SESSION_RELEASE_TIMEOUT_MS` of the client).
const HOST_RELEASE: Duration = Duration::from_secs(60);

/// How long the helper may take to give the cursor back; a helper that does not answer restores it itself (its watchdog).
const CURSOR_RELEASE: Duration = Duration::from_secs(5);

/// The cap on live helper processes (`MAX_COMPUTER_WORKERS`, `worker-capacity.ts:6`).
const MAX_RESIDENT_HELPERS: usize = MAX_LIVE_HELPERS;

/// From this many live helpers on, a session idle for `IDLE_PRESSURE` is reclaimed; below it, one idle for `IDLE_STALE`
/// (`WORKER_PRESSURE_COUNT`, `WORKER_IDLE_PRESSURE_MS`, `WORKER_IDLE_STALE_MS`, `lifecycle-worker-reclaim.ts:18-23`).
const PRESSURE_COUNT: usize = MAX_RESIDENT_HELPERS * 3 / 4;
const IDLE_PRESSURE: Duration = Duration::from_secs(5);
const IDLE_STALE: Duration = Duration::from_secs(300);

/// Decorates a session's backend as it is made.
pub type WrapBackend = Arc<dyn Fn(&str, Arc<dyn ComputerBackend>) -> Arc<dyn ComputerBackend> + Send + Sync>;

/// `desktop.computerBackend` as it applies on this platform.
fn chosen_backend(config: &Config) -> ComputerBackendChoice {
    let mut desktop = Map::new();
    if let Some(stored) = config.get("desktop.computerBackend") {
        desktop.insert("computerBackend".to_owned(), stored);
    }
    let mut document = Map::new();
    document.insert("desktop".to_owned(), Value::Object(desktop));
    computer_backend(&document)
}

/// What serves a `computer` call, as an availability decision found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComputerRoute {
    /// The resident helper at this path.
    Helper(PathBuf),
    /// The desktop's own computer host (`desktop.computerBackend`, or no helper and a desktop that serves it).
    DesktopHost,
}

/// One availability decision ([`ComputerSessionPool::availability_now`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerAvailability {
    /// `desktop.computerControl`.
    pub enabled: bool,
    /// What would serve a call; `None` when nothing does.
    pub route: Option<ComputerRoute>,
}

impl ComputerAvailability {
    pub fn available(&self) -> bool {
        self.enabled && self.route.is_some()
    }
}

/// What switching Computer Use off answered ([`ComputerSessionPool::stop_revoked`]). Confirmed only when every revoked scope's
/// closure is known at every executor: the desktop reported each scope's admission closed with no executor left unknown (or no
/// desktop serves), and each helper reported its admission closed or exited. The reports are the executors' own, kept in meaning.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OffReport {
    pub confirmed: bool,
    /// Each executor's latest acknowledgement, by scope.
    pub reports: Vec<ExecutorReport>,
}

/// The name the desktop's report of a scope is kept under.
const DESKTOP_EXECUTOR: &str = "desktop";

/// The cleanup across every executor report of `authorities`.
fn off_cleanup(authorities: &[Authority]) -> RevocationCleanup {
    let cleanups: Vec<RevocationCleanup> =
        authorities.iter().flat_map(|authority| authority.revocation_reports().into_iter().map(|(_, report)| report.cleanup)).collect();
    if cleanups.contains(&RevocationCleanup::Unconfirmed) {
        RevocationCleanup::Unconfirmed
    } else if cleanups.contains(&RevocationCleanup::Pending) {
        RevocationCleanup::Pending
    } else {
        RevocationCleanup::Complete
    }
}

/// One executor's acknowledgement of one revoked scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutorReport {
    pub scope: u64,
    /// `desktop`, or `helper <handle>`.
    pub executor: String,
    pub report: RevocationReport,
}

impl OffReport {
    /// The cleanup across every executor: unconfirmed once one says so, pending while one is, complete otherwise.
    pub fn cleanup(&self) -> RevocationCleanup {
        let cleanups = self.reports.iter().map(|executor| executor.report.cleanup);
        if cleanups.clone().any(|cleanup| cleanup == RevocationCleanup::Unconfirmed) {
            RevocationCleanup::Unconfirmed
        } else if cleanups.clone().any(|cleanup| cleanup == RevocationCleanup::Pending) {
            RevocationCleanup::Pending
        } else {
            RevocationCleanup::Complete
        }
    }

    /// The executors whose closure is not known, as the reports name them.
    pub fn unknown_executors(&self) -> Vec<String> {
        self.reports.iter().flat_map(|executor| executor.report.unknown_executors.iter().cloned()).collect()
    }
}

/// One command running now.
struct Running {
    id: u64,
    session: String,
    mode: ComputerSessionMode,
    windows: Vec<String>,
}

#[derive(Default)]
struct PresenceState {
    /// The sessions with an open execution, oldest first, and whether each opened observing only.
    open: Vec<(String, bool)>,
    running: Vec<Running>,
    next: u64,
    /// What was published last: an unchanged section is not published again.
    last: Option<ComputerSection>,
}

/// How a command reaches the screen, and the windows it names. A command is foreground when it sends input through the desktop's one
/// keyboard and pointer (`delivery: "foreground"`) or works the person's windows and clipboard (`FOREGROUND_ACTIONS` of the lane);
/// the windows are `window_id` / `window_ids` of the call or of a step of its `actions`.
fn classify(request: &ComputerRequest) -> (ComputerSessionMode, Vec<String>) {
    let empty = Map::new();
    let input = request.input.as_object().unwrap_or(&empty);
    let delivered = input.get("delivery").and_then(Value::as_str) == Some("foreground");
    let foreground = match request.action {
        ComputerAction::Act | ComputerAction::Capture => delivered,
        ComputerAction::Window => input.get("operation").and_then(Value::as_str) != Some("terminate"),
        ComputerAction::Clipboard | ComputerAction::Launch | ComputerAction::SavedLogin => true,
        ComputerAction::List | ComputerAction::Diagnose | ComputerAction::Verify | ComputerAction::WaitForUser | ComputerAction::Menu => false,
    };
    let mut windows: Vec<String> = Vec::new();
    let mut note = |source: &Map<String, Value>| {
        let single = source.get("window_id").and_then(Value::as_str);
        let several = source.get("window_ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
        for window in single.into_iter().chain(several).map(str::trim).filter(|window| !window.is_empty()) {
            if !windows.iter().any(|known| known == window) {
                windows.push(window.to_owned());
            }
        }
    };
    note(input);
    for step in input.get("actions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
        note(step);
    }
    (if foreground { ComputerSessionMode::Foreground } else { ComputerSessionMode::Background }, windows)
}

fn session_key(session: &str) -> String {
    let id = session.trim();
    if id.is_empty() { DEFAULT_SESSION.to_owned() } else { id.to_owned() }
}

/// What a session finds where no helper exists and the desktop's computer host is not attached.
fn no_host() -> ComputerError {
    ComputerError::Unavailable { reason: "computer use is unavailable: no helper is installed and no desktop serves the computer host".to_owned() }
}

/// The backend of a session that found `MAX_RESIDENT_HELPERS` helpers resident (`assertComputerWorkerCapacity`), or no helper and no
/// desktop host: its commands are refused in Node's words, with nothing started or sent.
struct Refusing(ComputerError);

/// The refusal of a session that found `MAX_RESIDENT_HELPERS` helpers resident.
struct AtCapacity;

impl AtCapacity {
    fn refusal() -> ComputerError {
        ComputerError::Failed {
            code: "computer_capacity_exhausted".into(),
            message: format!("computer_capacity_exhausted: {MAX_RESIDENT_HELPERS} workers are still live; release an idle session before retrying"),
        }
    }
}

#[async_trait]
impl ComputerBackend for Refusing {
    async fn run(&self, _: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        Err(self.0.clone())
    }

    fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
        Err(self.0.clone())
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        Ok(0)
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        None
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        Err(self.0.clone())
    }

    fn screen_source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        Err(self.0.clone())
    }

    fn status(&self) -> ComputerStatus {
        ComputerStatus { active: false, observe_only: false, controller: None }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::collections::HashSet;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerRequest;
    use mixdog_core_api::state::SectionChange;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::collections::BTreeSet;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;
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

    fn paths(env: &[(&str, &str)], present: &[PathBuf], cached: Option<PathBuf>) -> Arc<NativeToolPaths> {
        Arc::new(raw_paths(env, present, cached))
    }

    fn raw_paths(env: &[(&str, &str)], present: &[PathBuf], cached: Option<PathBuf>) -> NativeToolPaths {
        let vars: HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        NativeToolPaths::new(
            Arc::new(move |name| vars.get(name).cloned()),
            PathBuf::from("/pkg"),
            Arc::new(Present(present.iter().cloned().collect())),
            Some(Arc::new(Cache(cached))),
        )
        .with_exe_dir(None)
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

    #[tokio::test]
    async fn the_computer_helper_carries_the_platforms_executable_name() {
        let tool = NativeTool::Computer;
        let (name, other) = if cfg!(windows) { ("mixdog-computer.exe", "mixdog-computer") } else { ("mixdog-computer", "mixdog-computer.exe") };
        let (package, build) = (PathBuf::from("/pkg/native-tools"), PathBuf::from("/pkg/native/mixdog-computer/target/release"));
        assert_eq!(paths(&[], &[package.join(name), build.join(name)], None).resolve(tool).await, Some(package.join(name)));
        assert_eq!(paths(&[], &[build.join(name)], None).resolve(tool).await, Some(build.join(name)));
        assert_eq!(paths(&[], &[package.join(other), build.join(other)], None).resolve(tool).await, None, "the other platform's file name is not the helper");
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

    /// The sessions the published sections list, one list per change that showed.
    fn listed(published: &Published) -> Vec<Vec<String>> {
        let mut seen: Vec<Vec<String>> = Vec::new();
        for section in computer_values(published) {
            let sessions: Vec<String> = section.sessions.iter().map(|session| session.session_thread_id.as_str().to_owned()).collect();
            if seen.last() != Some(&sessions) {
                seen.push(sessions);
            }
        }
        seen
    }

    /// Whether every path exists, as a flag the test turns.
    struct Flag(Arc<std::sync::atomic::AtomicBool>);

    #[async_trait]
    impl PathExists for Flag {
        async fn exists(&self, _: &Path) -> bool {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// A core that was given no `MIXDOG_COMPUTER_BIN` finds the helper the packaged desktop keeps beside its core
    /// (`resources/core/<core>`, `resources/native-tools/<helper>`), after the variable and the package root.
    #[tokio::test]
    async fn a_core_with_no_variable_finds_the_helper_beside_the_packaged_core() {
        let tool = NativeTool::Computer;
        let beside = PathBuf::from("/app/resources/native-tools").join(tool.file_name());
        let with = |env: &[(&str, &str)], present: &[PathBuf]| raw_paths(env, present, None).with_exe_dir(Some(PathBuf::from("/app/resources/core")));
        assert_eq!(with(&[], &[beside.clone()]).resolve(tool).await, Some(beside.clone()));
        assert_eq!(with(&[], &[beside.clone(), bundled(tool)]).resolve(tool).await, Some(bundled(tool)), "the package root comes first");
        assert_eq!(
            with(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[beside.clone(), bundled(tool)]).resolve(tool).await,
            Some(PathBuf::from("/x/c")),
            "the variable first of all"
        );
        assert_eq!(with(&[], &[beside.clone(), built(tool)]).resolve(tool).await, Some(beside), "beside the core comes before a local build");
        assert_eq!(with(&[], &[]).resolve(tool).await, None);
        assert_eq!(
            raw_paths(&[], &[PathBuf::from("/app/resources/native-tools").join(tool.file_name())], None).resolve(tool).await,
            None,
            "no executable directory, no such place"
        );
    }

    /// A process manager that counts the helpers it is asked to start and never answers: a helper that is starting.
    #[derive(Default)]
    struct Starting {
        spawned: std::sync::atomic::AtomicUsize,
        begun: tokio::sync::Notify,
    }

    #[async_trait]
    impl ProcessManager for Starting {
        async fn spawn(
            &self,
            _: mixdog_core_api::domain::process::SpawnRequest,
        ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
            self.spawned.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.begun.notify_one();
            std::future::pending().await
        }
        fn subscribe_holding(
            &self,
            handle: &mixdog_protocol::ProcessHandle,
            from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            self.subscribe(handle, from_seq)
        }
        fn subscribe(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            unreachable!("nothing was spawned")
        }
        async fn write_stdin(&self, _: &mixdog_protocol::ProcessHandle, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn close_stdin(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn resize_pty(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: mixdog_core_api::domain::process::PtySize,
        ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn kill(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    /// A process manager whose launches wait in its queue until the test lets them go, and then create as the real manager does: only
    /// under a scope that still holds, registered with it.
    #[derive(Default)]
    struct Queued {
        asked: std::sync::atomic::AtomicUsize,
        created: std::sync::atomic::AtomicUsize,
        queued: tokio::sync::Notify,
        go: tokio::sync::Notify,
    }

    /// The desktop host's session commands wait as long as the client's own limits did.
    #[test]
    fn the_host_session_commands_keep_the_clients_limits() {
        assert_eq!((HOST_ABORT, HOST_EXECUTION_END, HOST_RELEASE), (Duration::from_secs(15), Duration::from_secs(3), Duration::from_secs(60)));
    }

    struct Shells(Mutex<Vec<String>>);

    impl OwnedShells for Shells {
        fn cancel_owned(&self, owner: &ThreadId) {
            self.0.lock().unwrap_or_else(PoisonError::into_inner).push(owner.as_str().to_owned());
        }
    }

    struct Snapshots(Mutex<Vec<String>>);

    impl TurnSnapshots for Snapshots {
        fn turn_settled(&self, thread: &ThreadId) {
            self.0.lock().unwrap_or_else(PoisonError::into_inner).push(thread.as_str().to_owned());
        }
        fn runtime_stopped(&self, _: &ThreadId) {}
        fn dispose(&self) {}
    }

    /// A process manager whose spawn never answers: the helper of a session is stuck.
    struct Stuck(tokio::sync::Notify);

    #[async_trait]
    impl ProcessManager for Stuck {
        async fn spawn(
            &self,
            _: mixdog_core_api::domain::process::SpawnRequest,
        ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
            self.0.notify_one();
            std::future::pending().await
        }
        fn subscribe_holding(
            &self,
            handle: &mixdog_protocol::ProcessHandle,
            from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            self.subscribe(handle, from_seq)
        }
        fn subscribe(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            unreachable!("nothing was spawned")
        }
        async fn write_stdin(&self, _: &mixdog_protocol::ProcessHandle, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn close_stdin(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn resize_pty(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: mixdog_core_api::domain::process::PtySize,
        ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn kill(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    fn manager() -> Arc<dyn ProcessManager> {
        let tokens = mixdog_rt::testing::tokens();
        Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()))
    }

    /// A data folder for the helpers these tests start: each one makes its ledger folder there.
    fn data_dir() -> PathBuf {
        std::env::temp_dir().join("mixdog-computer-sessions-test")
    }

    /// A Linux desktop with every capability ready, for the tests that drive the stand-in helper: the host's own, read by a Linux machine's
    /// preflight, would refuse every action (no display on a runner) or probe through the process manager before the helper starts.
    /// Other platforms keep their own path.
    fn on_linux_desktop(mut settings: ComputerSettings) -> ComputerSettings {
        if cfg!(target_os = "linux") {
            settings.linux_desktop = true;
        }
        settings
    }

    /// Observation only off.
    fn settings() -> ComputerSettings {
        ComputerSettings::new(data_dir(), Arc::new(|| false), mixdog_rt::testing::tokens().interactive_io)
    }

    /// The `computer` section (SPEC R40) follows the sessions' open executions: the pill shows while an agent
    /// drives the desktop. An action opens a session's execution (the helper cannot start here, but the action
    /// reached it); a second session opens beside the first, not instead of it; each settled turn closes its own.
    #[tokio::test]
    async fn the_computer_section_follows_the_open_executions() {
        let published = Arc::new(Published::default());
        let pool =
            paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), published.clone(), on_linux_desktop(settings())).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };

        assert!(pool.backend("a").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.backend("b").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.backend("a").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.end_execution("a").await);
        assert!(pool.end_execution("b").await);
        assert!(!pool.end_execution("b").await, "an ended execution publishes nothing again");
        assert_eq!(
            listed(&published),
            [vec!["a".to_owned()], vec!["a".to_owned(), "b".to_owned()], vec!["b".to_owned()], Vec::<String>::new()],
            "b opening beside a lists both, a's second action opens nothing, a closing leaves b, b closing leaves none"
        );
        let last = computer_values(&published).pop().expect("a section");
        assert_eq!(
            (last.active, last.backend, last.cleanup_state, last.idle_resume_seconds, last.lane),
            (false, mixdog_protocol::ComputerBackendSection::Helper, mixdog_protocol::ComputerCleanupState::Ready, 5, None)
        );
    }

    /// A session's row names the windows, the mode and the phase of the command running now, and drops them when it ends.
    #[test]
    fn a_running_command_shows_its_windows_mode_and_phase() {
        let presence = Arc::new(ComputerPresence::new(quiet(), &ComputerShared::default(), ComputerBackendSection::Helper));
        let observer = SessionPresence { presence: presence.clone(), session: "a".to_owned() };
        observer.began(false);
        let click = ComputerRequest {
            action: ComputerAction::Act,
            input: json!({"window_id": "w1", "delivery": "foreground", "actions": [{"type": "click", "x": 1, "y": 2}]}),
        };
        let running = RunningCommand::begin(&presence, "a", &click);
        let row = |presence: &ComputerPresence| presence.section(&presence.state()).sessions.remove(0);
        let shown = row(&presence);
        assert_eq!(
            (shown.window_ids, shown.mode, shown.phase),
            (vec!["w1".to_owned()], Some(ComputerSessionMode::Foreground), Some("active_foreground".to_owned()))
        );
        assert!(presence.is_running("a") && !presence.is_running("b"));
        drop(running);
        let idle = row(&presence);
        assert_eq!((idle.window_ids, idle.mode, idle.phase), (Vec::new(), None, None));
        let background = ComputerRequest { action: ComputerAction::Capture, input: json!({"window_id": "w2"}) };
        let (mode, windows) = classify(&background);
        assert_eq!((mode, windows), (ComputerSessionMode::Background, vec!["w2".to_owned()]));
    }

    /// At most `MAX_RESIDENT_HELPERS` helper processes are live: a new session is refused in Node's words, however
    /// recently the others settled, until one has sat idle past the pressure limit and is reclaimed, and its process has ended.
    /// The fake helper path never starts a process, so the live ones are held by the test.
    #[tokio::test]
    async fn the_ninth_session_is_refused_until_an_idle_one_is_reclaimed() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), on_linux_desktop(settings())).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        for n in 0..MAX_RESIDENT_HELPERS {
            let _ = pool.backend(&format!("s{n}")).run(read(), CancellationToken::new()).await;
        }
        let mut live: Vec<_> = (0..MAX_RESIDENT_HELPERS).map(|_| pool.shared.live.hold()).collect();
        let refused = pool.backend("late").run(read(), CancellationToken::new()).await;
        assert!(
            matches!(&refused, Err(ComputerError::Failed { code, message }) if code == "computer_capacity_exhausted"
                && message == "computer_capacity_exhausted: 8 workers are still live; release an idle session before retrying"),
            "{refused:?}"
        );
        assert!(pool.end_execution("s3").await);
        assert!(pool.backend("late").run(read(), CancellationToken::new()).await.is_err());
        assert!(!pool.entries().contains_key("late"), "a session that settled a moment ago keeps its helper");
        pool.entries().get_mut("s3").expect("resident").used = Instant::now() - IDLE_PRESSURE * 2;
        let _ = pool.backend("late").run(read(), CancellationToken::new()).await;
        assert!(!pool.entries().contains_key("s3"), "the idle session was reclaimed");
        assert!(!pool.entries().contains_key("late"), "its process has not ended yet, so there is still no slot");
        // The reclaimed session's cleanup run (a process of the fake path that cannot start) has ended before its slot is looked at.
        tokio::time::sleep(Duration::from_millis(100)).await;
        live.pop();
        let _ = pool.backend("late").run(read(), CancellationToken::new()).await;
        assert!(pool.entries().contains_key("late"), "the ended process made room");
        drop(live);
    }

    /// Below the pressure count an idle session is kept for five minutes, then reclaimed by the next request of any session;
    /// one with a pending command is not.
    #[tokio::test]
    async fn an_idle_session_is_reclaimed_after_five_minutes() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), on_linux_desktop(settings())).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let _live = pool.shared.live.hold();
        for id in ["old", "busy", "fresh"] {
            let _ = pool.backend(id).run(read(), CancellationToken::new()).await;
        }
        for id in ["old", "busy", "fresh"] {
            assert!(pool.end_execution(id).await);
        }
        let _pending = pool.shared.budget.acquire("busy").expect("a slot");
        for id in ["old", "busy"] {
            pool.entries().get_mut(id).expect("resident").used = Instant::now() - IDLE_STALE * 2;
        }
        pool.entries().get_mut("fresh").expect("resident").used = Instant::now() - IDLE_PRESSURE * 2;
        let _ = pool.backend("other").run(read(), CancellationToken::new()).await;
        let entries = pool.entries();
        assert!(entries.contains_key("busy") && entries.contains_key("fresh"), "a pending command and a recent use are kept");
        assert!(!entries.contains_key("old"), "five idle minutes reclaim it");
    }

    /// The sessions read the observation-only setting on every call: turned on between two executions, the second opens
    /// observing only, and the section says so.
    #[tokio::test]
    async fn the_observation_only_setting_is_read_on_every_call() {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering;

        let published = Arc::new(Published::default());
        let on = Arc::new(AtomicBool::new(false));
        let setting = on.clone();
        let settings =
            on_linux_desktop(ComputerSettings::new(data_dir(), Arc::new(move || setting.load(Ordering::SeqCst)), mixdog_rt::testing::tokens().interactive_io));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), published.clone(), settings).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };

        assert!(pool.backend("a").run(read(), CancellationToken::new()).await.is_err());
        assert!(!pool.backend("a").status().observe_only);
        assert!(pool.end_execution("a").await);
        on.store(true, Ordering::SeqCst);
        assert!(pool.backend("a").run(read(), CancellationToken::new()).await.is_err());
        assert!(pool.backend("a").status().observe_only);
        let observing: Vec<(bool, Vec<bool>)> = computer_values(&published)
            .into_iter()
            .map(|section| (section.observe_only, section.sessions.iter().map(|session| session.observe_only).collect()))
            .collect();
        let mut changes = observing.clone();
        changes.dedup();
        assert_eq!(changes, [(false, vec![false]), (false, vec![]), (true, vec![true])], "opened, ended, opened observing only");
    }

    /// The desktop's "Observation only" reaches every session's backend: while it is on, an input is refused in Node's words and a
    /// read still goes to the helper (which cannot start here).
    #[tokio::test]
    async fn the_sessions_refuse_input_while_observation_only_is_on() {
        let settings = on_linux_desktop(ComputerSettings::new(data_dir(), Arc::new(|| true), mixdog_rt::testing::tokens().interactive_io));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings).await;
        let write = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"write","text":"x"}) };
        let refused = pool.backend("a").run(write, CancellationToken::new()).await;
        assert!(matches!(refused, Err(ComputerError::Failed { ref code, .. }) if code == "observation_only"), "{refused:?}");
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let read = pool.backend("a").run(read, CancellationToken::new()).await;
        assert!(!matches!(read, Err(ComputerError::Failed { ref code, .. }) if code == "observation_only"), "a read is admitted: {read:?}");
    }

    /// The pool exists whether or not a helper is found at start; what it can serve follows the helper as it is found, and the
    /// tool's own question ("can `computer` run now") follows the pool.
    #[tokio::test]
    async fn the_pool_can_serve_when_the_helper_is_found_now_and_not_only_at_start() {
        let tool = NativeTool::Computer;
        let found = paths(&[], &[bundled(tool)], None).computer_sessions(manager(), plain(), quiet(), settings()).await;
        assert!(found.can_serve() && found.helper_resolvable() && found.is_available());
        let given = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[PathBuf::from("/x/c")], None).computer_sessions(manager(), plain(), quiet(), settings()).await;
        assert!(given.can_serve());
        let none = paths(&[], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await;
        assert!(!none.can_serve() && !none.is_available() && !ComputerSessions::available(&*none));
    }

    /// Where the helper is is read when it is asked, not carried from an event: a helper placed on disk is not seen until the next ask
    /// (`probe`, which a listing and a `computer` call make), and one removed is not offered after it.
    #[tokio::test]
    async fn a_helper_placed_or_removed_is_read_at_the_next_ask() {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering;

        let there = Arc::new(AtomicBool::new(false));
        let resolver =
            Arc::new(NativeToolPaths::new(Arc::new(|_: &str| None::<String>), PathBuf::from("/pkg"), Arc::new(Flag(there.clone())), None).with_exe_dir(None));
        let pool = resolver.computer_sessions(manager(), plain(), quiet(), settings()).await;
        assert!(!pool.can_serve() && !ComputerSessions::available(&*pool));
        there.store(true, Ordering::SeqCst);
        assert!(!pool.helper_resolvable(), "nothing has asked yet");
        assert!(pool.probe().await && pool.can_serve() && ComputerSessions::available(&*pool), "the ask finds it");
        there.store(false, Ordering::SeqCst);
        assert!(pool.helper_resolvable(), "until the next listing");
        // A call does not read the listing's resolution: its own decision finds the helper gone and the call is refused.
        assert_eq!(pool.availability_now().await.route, None);
        let refused = ComputerSessions::backend_now(&*pool, "a")
            .await
            .run(ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) }, CancellationToken::new())
            .await;
        assert!(matches!(&refused, Err(ComputerError::Unavailable { .. })), "{refused:?}");
        there.store(true, Ordering::SeqCst);
        assert!(matches!(pool.availability_now().await.route, Some(ComputerRoute::Helper(_))), "and one placed since the listing");
    }

    /// Computer Use switched off between two commands: the next command of a session, one made through a backend handed out before, and
    /// a secret fill are refused with Node's words; `stop_all` forgets every session and stops its helper.
    #[tokio::test]
    async fn switching_computer_use_off_refuses_the_next_command_and_releases_the_sessions() {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering;

        let on = Arc::new(AtomicBool::new(true));
        let mut settings = settings();
        let flag = on.clone();
        settings.enabled = Arc::new(move || flag.load(Ordering::SeqCst));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let words = "Error: computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings";

        let held = pool.backend("a");
        let reached = held.run(read(), CancellationToken::new()).await;
        assert!(!matches!(&reached, Err(ComputerError::Failed { message, .. }) if message == words), "on: the command reaches the helper: {reached:?}");
        assert!(pool.entries().contains_key("a") && pool.is_available());

        let fill = pool.secret_host(&ThreadId::from("a")).expect("on: a fill is obtained");
        let find = || serde_json::from_value::<Map<String, Value>>(json!({"action":"find","window_id":"w1"})).unwrap();

        on.store(false, Ordering::SeqCst);
        pool.stop_all().await;
        assert!(pool.entries().is_empty(), "every session is forgotten");
        assert!(!pool.is_available() && !ComputerSessions::available(&*pool));
        let refused = pool.backend("a").run(read(), CancellationToken::new()).await;
        assert!(matches!(&refused, Err(ComputerError::Failed { message, .. }) if message == words), "{refused:?}");
        assert!(pool.secret_host(&ThreadId::from("a")).is_none(), "no fill is obtained with Computer Use off");

        // Switched on again (the adoption of the setting reopens the pool): what `stop_all` released is revoked for good (a held
        // backend, a fill obtained before); new sessions serve.
        on.store(true, Ordering::SeqCst);
        pool.reopen();
        let again = held.run(read(), CancellationToken::new()).await;
        assert!(matches!(&again, Err(ComputerError::Failed { message, .. }) if message == words), "a revoked backend stays closed: {again:?}");
        let filled = fill.execute(find()).await;
        assert!(matches!(&filled, Err(text) if text.contains("computer use is unavailable")), "a revoked fill stays closed: {filled:?}");
        assert!(pool.is_available() && pool.secret_host(&ThreadId::from("b")).is_some(), "a new session serves again");
    }

    #[async_trait]
    impl ProcessManager for Queued {
        async fn spawn(
            &self,
            request: mixdog_core_api::domain::process::SpawnRequest,
        ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
            use mixdog_core_api::domain::process::ProcessError;
            use mixdog_core_api::domain::process::ProcessOwner;
            self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.queued.notify_one();
            self.go.notified().await;
            let ProcessOwner::ComputerHelper { scope: Some(scope) } = &request.owner else { panic!("a helper is launched under its scope") };
            let Some(mut commit) = scope.0.begin() else { return Err(ProcessError::Revoked) };
            commit.launched(&request.handle);
            self.created.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(mixdog_core_api::domain::process::SpawnedProcess { handle: request.handle, pid: 1 })
        }
        fn subscribe_holding(
            &self,
            handle: &mixdog_protocol::ProcessHandle,
            from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            self.subscribe(handle, from_seq)
        }
        fn subscribe(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            Err(mixdog_core_api::domain::process::ProcessError::UnknownHandle)
        }
        async fn write_stdin(&self, _: &mixdog_protocol::ProcessHandle, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn close_stdin(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn resize_pty(
            &self,
            _: &mixdog_protocol::ProcessHandle,
            _: mixdog_core_api::domain::process::PtySize,
        ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn kill(&self, _: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }
        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    struct NoBlobs;

    #[async_trait]
    impl HostBlobs for NoBlobs {
        async fn read(&self, _: &str) -> Result<Vec<u8>, ComputerError> {
            Err(ComputerError::Unavailable { reason: "no blob".into() })
        }
    }

    fn desktop_host_settings() -> ComputerSettings {
        let mut settings = settings();
        settings.backend = Arc::new(|| ComputerBackendChoice::DesktopHost);
        settings.host_blobs = Some(Arc::new(NoBlobs));
        settings
    }

    fn clipboard_read() -> ComputerRequest {
        ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) }
    }

    #[tokio::test]
    async fn the_desktop_host_backend_obeys_the_same_switch() {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::AtomicUsize;
        use std::sync::atomic::Ordering;

        #[derive(Default)]
        struct Desk(AtomicUsize);

        #[async_trait]
        impl HostChannel for Desk {
            async fn request(
                &self,
                _: mixdog_core_api::HostCapability,
                _: mixdog_core_api::ids::Method,
                _: Value,
            ) -> Result<Value, mixdog_core_api::HostError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::CapabilityUnavailable {
                    capability: "desktopHost".into(),
                    detail: "noClaimant".into(),
                }))
            }

            fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
                Ok(())
            }
        }

        let on = Arc::new(AtomicBool::new(true));
        let mut settings = desktop_host_settings();
        let flag = on.clone();
        settings.enabled = Arc::new(move || flag.load(Ordering::SeqCst));
        let pool = paths(&[], &[], None).computer_sessions(manager(), plain(), quiet(), settings).await;
        assert!(pool.can_serve() && !pool.helper_resolvable(), "the desktop host chosen serves with no helper");
        let desk = Arc::new(Desk::default());
        pool.attach_desktop(desk.clone());
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };

        let _ = pool.backend("a").run(read(), CancellationToken::new()).await;
        assert!(desk.0.load(Ordering::SeqCst) >= 1, "on: the command went to the desktop's host");

        let held = pool.backend("a");
        let fill = pool.secret_host(&ThreadId::from("a")).expect("on: a fill is obtained");
        on.store(false, Ordering::SeqCst);
        pool.stop_all().await;
        assert!(pool.entries().is_empty());
        let asked = desk.0.load(Ordering::SeqCst);
        let refused = pool.backend("a").run(read(), CancellationToken::new()).await;
        assert!(
            matches!(&refused, Err(ComputerError::Failed { message, .. }) if message.contains("computer use is unavailable; open the Mixdog desktop app")),
            "{refused:?}"
        );
        assert_eq!(desk.0.load(Ordering::SeqCst), asked, "off: nothing is sent to the desktop");

        // Switched on again, what `stop_all` released stays revoked: a held backend and a fill obtained before send nothing to the host.
        on.store(true, Ordering::SeqCst);
        let again = held.run(read(), CancellationToken::new()).await;
        assert!(matches!(&again, Err(ComputerError::Failed { message, .. }) if message.contains("computer use is unavailable")), "{again:?}");
        let find = serde_json::from_value::<Map<String, Value>>(json!({"action":"find","window_id":"w1"})).unwrap();
        let filled = fill.execute(find).await;
        assert!(matches!(&filled, Err(text) if text.contains("computer use is unavailable")), "{filled:?}");
        assert_eq!(desk.0.load(Ordering::SeqCst), asked, "revoked: nothing is sent to the desktop");
    }

    /// Answers `host/computer/revokeScopes` with `answer` (the scopes it was asked for put in), refuses everything else.
    struct RevokeAnswer(fn(&[u64]) -> Value);

    #[async_trait]
    impl HostChannel for RevokeAnswer {
        async fn request(
            &self,
            _: mixdog_core_api::HostCapability,
            method: mixdog_core_api::ids::Method,
            params: Value,
        ) -> Result<Value, mixdog_core_api::HostError> {
            if method.as_str() == "host/computer/revokeScopes" {
                let scopes: Vec<u64> = params["scopes"].as_array().unwrap().iter().filter_map(Value::as_u64).collect();
                return Ok((self.0)(&scopes));
            }
            Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::CapabilityUnavailable {
                capability: "desktopHost".into(),
                detail: "methodNotServed".into(),
            }))
        }

        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    async fn off_answered_by(answer: fn(&[u64]) -> Value) -> (OffReport, Option<ComputerCleanupState>) {
        let published = Arc::new(Published::default());
        let pool = paths(&[], &[], None).computer_sessions(manager(), plain(), published.clone(), desktop_host_settings()).await;
        pool.attach_desktop(Arc::new(RevokeAnswer(answer)));
        let _ = pool.backend("a").run(clipboard_read(), CancellationToken::new()).await;
        let report = pool.stop_all().await;
        (report, computer_values(&published).pop().map(|section| section.cleanup_state))
    }

    #[tokio::test]
    async fn an_answer_to_the_revocation_without_reports_leaves_off_unconfirmed_and_latched() {
        let (older, cleanup) = off_answered_by(|scopes| json!({ "revoked": scopes.len() })).await;
        assert!(!older.confirmed, "an answer without reports states no scope's closure");
        // The scope had desktop work and no report of it came: its desktop closure and cleanup are unknown, never fabricated.
        assert!(older.reports.iter().all(|entry| !entry.report.admission_closed && entry.report.cleanup == RevocationCleanup::Unconfirmed));
        assert_eq!(cleanup, Some(ComputerCleanupState::Failed), "unconfirmed, latched");
    }

    #[tokio::test]
    async fn off_answered_with_every_scopes_report_carries_the_desktops_facts_by_scope() {
        let (reported, cleanup) = off_answered_by(|scopes| {
            let reports: Vec<Value> = scopes
                .iter()
                .map(|scope| json!({"scope": scope, "admission": "closed", "unfinished_at_closure": 1, "unfinished": 1, "cleanup": "pending"}))
                .collect();
            json!({ "revoked": scopes.len(), "reports": reports })
        })
        .await;
        assert!(reported.confirmed, "every scope reported closed");
        assert_eq!(reported.reports.len(), 1);
        let desktop = &reported.reports[0];
        assert_eq!(desktop.executor, "desktop");
        assert!(desktop.report.admission_closed);
        assert_eq!((desktop.report.unfinished_at_closure, desktop.report.cleanup), (Some(1), RevocationCleanup::Pending));
        assert_eq!(reported.cleanup(), RevocationCleanup::Pending, "a call handed over before Off may still complete");
        assert!(reported.unknown_executors().is_empty());
        assert_ne!(cleanup, Some(ComputerCleanupState::Failed));
    }

    #[tokio::test]
    async fn an_executor_whose_closure_is_unknown_leaves_off_unconfirmed() {
        let (unknown, _) = off_answered_by(|scopes| {
            let reports: Vec<Value> = scopes
                .iter()
                .map(|scope| json!({"scope": scope, "admission": "unconfirmed", "unfinished_at_closure": 0, "unfinished": 0, "cleanup": "pending", "unknown_executors": ["renderer"]}))
                .collect();
            json!({ "revoked": scopes.len(), "reports": reports })
        })
        .await;
        assert!(!unknown.confirmed, "an executor whose closure is unknown");
        assert_eq!(unknown.unknown_executors(), ["renderer"]);
    }

    /// One desktop process over successive connections: the claim generation is the connection's; each connection serves the
    /// scopes it was sent work for, and its revocation reports only those (complete), as `computer-scope.ts` does.
    #[derive(Default)]
    struct Reconnecting {
        generation: AtomicU64,
        /// When not 0: a second claim that takes `host/computer/command` (input) only; every other method goes to `generation`.
        input_claim: AtomicU64,
        served: Mutex<BTreeMap<u64, BTreeSet<u64>>>,
    }

    impl Reconnecting {
        /// The claim a request of `method` is dispatched to (the one selection, as `Outgoing`'s).
        fn select(&self, method: mixdog_core_api::ids::Method) -> u64 {
            match self.input_claim.load(Ordering::SeqCst) {
                input if input != 0 && method.as_str() == "host/computer/command" => input,
                _ => self.generation.load(Ordering::SeqCst),
            }
        }
    }

    #[async_trait]
    impl HostChannel for Reconnecting {
        fn claim_generation(&self, _: mixdog_core_api::HostCapability, method: mixdog_core_api::ids::Method) -> Option<u64> {
            Some(self.select(method))
        }

        async fn request(
            &self,
            _: mixdog_core_api::HostCapability,
            method: mixdog_core_api::ids::Method,
            params: Value,
        ) -> Result<Value, mixdog_core_api::HostError> {
            let generation = self.select(method);
            let mut served = self.served.lock().unwrap();
            let mine = served.entry(generation).or_default();
            if method.as_str() == "host/computer/revokeScopes" {
                let reports: Vec<Value> = params["scopes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_u64)
                    .filter(|scope| mine.contains(scope))
                    .map(|scope| json!({"scope": scope, "revision": 1, "admission": "closed", "unfinished_at_closure": 0, "unfinished": 0, "cleanup": "complete"}))
                    .collect();
                return Ok(json!({ "revoked": params["scopes"].as_array().unwrap().len(), "reports": reports }));
            }
            if let Some(scope) = params.get("automationScope").and_then(Value::as_u64) {
                mine.insert(scope);
            }
            Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::CapabilityUnavailable {
                capability: "desktopHost".into(),
                detail: "methodNotServed".into(),
            }))
        }

        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    /// Connection A serves scope S and ends before it ever reported S, the same desktop reconnects as B (a new claim, a fresh scopes
    /// map), Off: B does not report S, and even a report of S from B could not count. Scope T, served only by B, settles complete.
    #[tokio::test]
    async fn a_scope_served_by_a_claim_that_ended_is_unconfirmed_and_one_served_by_the_new_claim_settles() {
        let pool = paths(&[], &[], None).computer_sessions(manager(), plain(), Arc::new(Published::default()), desktop_host_settings()).await;
        let desk = Arc::new(Reconnecting::default());
        desk.generation.store(1, Ordering::SeqCst);
        pool.attach_desktop(desk.clone());
        // A (claim 1) is sent session "s"'s work, then ends before reporting anything; B (claim 2) connects and serves session "t".
        let _ = pool.backend("s").run(clipboard_read(), CancellationToken::new()).await;
        desk.generation.store(2, Ordering::SeqCst);
        pool.desktop_detached();
        let _ = pool.backend("t").run(clipboard_read(), CancellationToken::new()).await;
        let report = pool.stop_all().await;
        assert!(!report.confirmed, "S's closure at the claim that took its work is not known");
        let desktop_cleanup = |served_by_b: bool| {
            let served = desk.served.lock().unwrap();
            let scope = *served.get(&if served_by_b { 2 } else { 1 }).unwrap().iter().next().unwrap();
            report.reports.iter().find(|entry| entry.scope == scope && entry.executor == DESKTOP_EXECUTOR).map(|entry| entry.report.cleanup)
        };
        assert_eq!(desktop_cleanup(false), Some(RevocationCleanup::Unconfirmed), "S: unconfirmed, never B's complete");
        assert_eq!(desktop_cleanup(true), Some(RevocationCleanup::Complete), "T, served only by B: complete");
    }

    /// Two claims at once, split by method: scope U's input goes to claim A and is unfinished, its cursor to claim B, which the
    /// revocation selects; B truthfully reports U complete, and U is still unconfirmed, because its work under A is not B's to report.
    #[tokio::test]
    async fn a_scope_whose_input_and_cursor_went_to_two_claims_is_unconfirmed() {
        let desk = Arc::new(Reconnecting::default());
        desk.generation.store(2, Ordering::SeqCst);
        // Input on claim A (3), the cursor and the revocation on claim B (2).
        desk.input_claim.store(3, Ordering::SeqCst);
        let split = Authority::default();
        let scoped = ScopedDesktop::wrap(desk.clone(), split.clone());
        let computer = mixdog_core_api::HostCapability::Computer;
        let _ = scoped.request(computer, mixdog_core_api::ids::Method("host/computer/command"), json!({})).await;
        let _ = scoped.request(computer, mixdog_core_api::ids::Method("host/computer/cursorPrepare"), json!({})).await;
        {
            let served = desk.served.lock().unwrap();
            assert!(served[&3].contains(&split.id()) && served[&2].contains(&split.id()), "the input went to A, the cursor to B");
        }
        split.revoke();
        assert_eq!(revoke_at_desktop_reports(&*desk, &[split.clone()], DESKTOP_EXECUTOR).await, DesktopRevocation::Unconfirmed);
        assert_eq!(split.revocation_reports()[0].1.cleanup, RevocationCleanup::Unconfirmed, "never B's complete for A's unfinished input");
    }

    /// A real close of a session cancels its shells and releases its helper state, as Node's
    /// teardown stops both under one gate; another session keeps its state.
    #[tokio::test]
    async fn closing_a_session_releases_its_computer_state_with_its_shells() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await;
        let _ = (pool.backend("closing"), pool.backend("other"));
        let shells = Arc::new(Shells(Mutex::default()));
        let reaping = ReapingShells::new(shells.clone(), pool.clone());
        reaping.cancel_owned(&ThreadId::from("closing"));
        assert_eq!(*shells.0.lock().unwrap_or_else(PoisonError::into_inner), vec!["closing".to_owned()]);
        reaping.released().await;
        assert!(!pool.entries().contains_key("closing"));
        assert!(pool.entries().contains_key("other"));
    }

    /// A settled turn arms its session's idle release when the session reached the helper; a
    /// session that never did owns nothing there.
    #[tokio::test]
    async fn a_settled_turn_arms_the_idle_release_of_a_session_that_reached_the_helper() {
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), on_linux_desktop(settings())).await;
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
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await;
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

    /// Where the switch is read is where a command is handed to the helper, not where a call enters: a command and a secret fill that were
    /// admitted while Computer Use was on, and wait behind a helper that is starting, are refused when the switch has gone off by the time
    /// they would go on, and start no helper of their own.
    #[tokio::test(start_paused = true)]
    async fn a_command_and_a_fill_admitted_before_the_switch_and_still_waiting_are_refused_and_spawn_nothing() {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering;

        use mixdog_core_session::session::testing::awaiting;

        let _held = mixdog_core_session::session::testing::HeldClock::hold();
        let on = Arc::new(AtomicBool::new(true));
        let mut settings = on_linux_desktop(settings());
        let flag = on.clone();
        settings.enabled = Arc::new(move || flag.load(Ordering::SeqCst));
        let starting = Arc::new(Starting::default());
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(starting.clone(), plain(), quiet(), settings).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let find = serde_json::from_value::<Map<String, Value>>(json!({"action":"find","window_id":"w1"})).unwrap();

        // The first command is starting the helper (and holds the helper's turn); a command and a fill of the same session queue behind it.
        let first = pool.backend("a");
        let mut starter = tokio::spawn(async move { first.run(read(), CancellationToken::new()).await });
        awaiting(|| "the first command to start the helper".to_owned(), starting.begun.notified()).await;
        let (queued, fill) = (pool.backend("a"), pool.secret_host(&ThreadId::from("a")).expect("a fill while on"));
        let waiting = tokio::spawn(async move { queued.run(read(), CancellationToken::new()).await });
        let filling = tokio::spawn(async move { fill.execute(find).await });
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert!(!waiting.is_finished() && !filling.is_finished(), "admitted and waiting");

        // The switch goes off and the starting helper's call ends: what was waiting now comes to the point where it would act.
        on.store(false, Ordering::SeqCst);
        starter.abort();
        let _ = (&mut starter).await;
        let command = awaiting(|| "the waiting command to end".to_owned(), waiting).await.expect("the command task");
        assert!(matches!(&command, Err(ComputerError::Failed { message, .. }) if message.contains("computer use is unavailable")), "{command:?}");
        let fill = awaiting(|| "the waiting fill to end".to_owned(), filling).await.expect("the fill task");
        assert!(matches!(&fill, Err(text) if text.contains("computer use is unavailable")), "{fill:?}");
        assert_eq!(starting.spawned.load(Ordering::SeqCst), 1, "no helper was started for what waited");
    }

    /// A helper launch already queued when Computer Use goes off reaches its creation after the revocation: nothing is created, the
    /// command is refused in Node's words, and the stop of the revoked session starts no process (no cleanup run). The interleaving is
    /// held by the manager's queue, not by time.
    #[tokio::test]
    async fn a_helper_launch_queued_before_off_creates_nothing_and_the_stop_starts_no_cleanup() {
        use std::sync::atomic::Ordering;

        use mixdog_core_session::session::testing::awaiting;

        let queued = Arc::new(Queued::default());
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(queued.clone(), plain(), quiet(), on_linux_desktop(settings())).await;
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let backend = pool.backend("a");
        let command = tokio::spawn(async move { backend.run(read(), CancellationToken::new()).await });
        awaiting(|| "the helper launch to be queued".to_owned(), queued.queued.notified()).await;

        let revoked = pool.revoke_all();
        assert!(pool.backend("b").run(read(), CancellationToken::new()).await.is_err(), "off makes no new session");
        let stopped = awaiting(|| "the revoked sessions to stop".to_owned(), pool.stop_revoked(revoked)).await;
        assert!(stopped.confirmed, "nothing was running, so the stop is confirmed");
        queued.go.notify_one();
        let refused = awaiting(|| "the queued command to end".to_owned(), command).await.expect("the command task");
        assert!(matches!(&refused, Err(ComputerError::Failed { message, .. }) if message.contains("computer use is unavailable")), "{refused:?}");
        assert_eq!(queued.created.load(Ordering::SeqCst), 0, "no helper was created");
        assert_eq!(queued.asked.load(Ordering::SeqCst), 1, "no cleanup process was asked for");
    }

    /// A desktop that does not confirm the revocation (an older one without `host/computer/revokeScopes`) leaves off unconfirmed, also
    /// with a desktop-host session and no helper: the section says stopping while the revocation is asked, then an unconfirmed
    /// cleanup, never ready. Ordered by the desktop's answer, not by time.
    #[tokio::test]
    async fn a_desktop_that_does_not_confirm_the_revocation_shows_off_as_stopping_then_unconfirmed() {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering;

        use mixdog_core_session::session::testing::awaiting;
        use mixdog_protocol::ComputerCleanupState;
        use tokio::sync::Notify;

        /// Refuses every request as a desktop that does not serve it would; once armed, the next request waits for `go` first.
        #[derive(Default)]
        struct OldDesk {
            armed: AtomicBool,
            asked: Notify,
            go: Notify,
        }

        #[async_trait]
        impl HostChannel for OldDesk {
            async fn request(
                &self,
                _: mixdog_core_api::HostCapability,
                _: mixdog_core_api::ids::Method,
                _: Value,
            ) -> Result<Value, mixdog_core_api::HostError> {
                if self.armed.swap(false, Ordering::SeqCst) {
                    self.asked.notify_one();
                    self.go.notified().await;
                }
                Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::CapabilityUnavailable {
                    capability: "desktopHost".into(),
                    detail: "methodNotServed".into(),
                }))
            }

            fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
                Ok(())
            }
        }

        let published = Arc::new(Published::default());
        let pool = paths(&[], &[], None).computer_sessions(manager(), plain(), published.clone(), desktop_host_settings()).await;
        let desk = Arc::new(OldDesk::default());
        pool.attach_desktop(desk.clone());
        let _ = pool.backend("a").run(clipboard_read(), CancellationToken::new()).await;
        let cleanup = || computer_values(&published).pop().map(|section| section.cleanup_state);

        desk.armed.store(true, Ordering::SeqCst);
        let stopping = pool.clone();
        let stop = tokio::spawn(async move { stopping.stop_all().await });
        awaiting(|| "the revocation to be asked of the desktop".to_owned(), desk.asked.notified()).await;
        assert_eq!(cleanup(), Some(ComputerCleanupState::Pending), "stopping while the desktop has not answered");
        desk.go.notify_one();
        let stopped = awaiting(|| "the stop to end".to_owned(), stop).await.expect("the stop task");
        assert!(!stopped.confirmed, "the desktop did not confirm");
        assert_eq!(cleanup(), Some(ComputerCleanupState::Failed), "off stays unconfirmed, not ready");
        let states: Vec<ComputerCleanupState> = computer_values(&published).into_iter().map(|section| section.cleanup_state).collect();
        let from = states.iter().position(|state| *state == ComputerCleanupState::Pending).expect("a stopping section");
        assert!(!states[from..].contains(&ComputerCleanupState::Ready), "never ready between stopping and unconfirmed: {states:?}");
    }

    /// Reports each revoked scope closed, its cleanup pending, at revision 2. Its claim generation is what the test sets.
    #[derive(Default)]
    struct PendingDesk(AtomicU64);

    #[async_trait]
    impl HostChannel for PendingDesk {
        fn claim_generation(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method) -> Option<u64> {
            Some(self.0.load(Ordering::SeqCst))
        }

        async fn request(
            &self,
            _: mixdog_core_api::HostCapability,
            method: mixdog_core_api::ids::Method,
            params: Value,
        ) -> Result<Value, mixdog_core_api::HostError> {
            if method.as_str() != "host/computer/revokeScopes" {
                return Err(mixdog_core_api::HostError::Core(mixdog_core_api::CoreError::CapabilityUnavailable {
                    capability: "desktopHost".into(),
                    detail: "methodNotServed".into(),
                }));
            }
            let reports: Vec<Value> = params["scopes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|scope| json!({"scope": scope, "revision": 2, "admission": "closed", "unfinished_at_closure": 1, "unfinished": 1, "cleanup": "pending"}))
                .collect();
            Ok(json!({ "revoked": reports.len(), "reports": reports }))
        }

        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    /// A desktop-host session switched off against a desktop that confirms the closure but reports its cleanup pending.
    async fn pending_off() -> (Arc<ComputerSessionPool>, Arc<Published>, u64, Arc<PendingDesk>) {
        let published = Arc::new(Published::default());
        let pool = paths(&[], &[], None).computer_sessions(manager(), plain(), published.clone(), desktop_host_settings()).await;
        let desk = Arc::new(PendingDesk::default());
        pool.attach_desktop(desk.clone());
        let _ = pool.backend("a").run(clipboard_read(), CancellationToken::new()).await;
        let report = pool.stop_all().await;
        assert!(report.confirmed);
        assert_eq!(report.cleanup(), RevocationCleanup::Pending);
        let scope = report.reports[0].scope;
        (pool, published, scope, desk)
    }

    fn cleanup_state(published: &Published) -> Option<ComputerCleanupState> {
        computer_values(published).pop().map(|section| section.cleanup_state)
    }

    /// Off confirmed while the desktop still reports a scope's cleanup pending: the section stays pending (never ready) after the
    /// stop; a pushed report older than the one held (a stale revision) changes nothing; only the desktop's newer pushed report of
    /// a complete cleanup publishes ready. Nothing is asked again, and no time passes.
    #[tokio::test]
    async fn a_pending_cleanup_at_off_stays_pending_until_a_pushed_report_settles_it() {
        use mixdog_core_session::session::testing::awaiting;

        let (pool, published, scope, _desk) = pending_off().await;
        assert_eq!(cleanup_state(&published), Some(ComputerCleanupState::Pending), "not ready while the desktop's cleanup is pending");
        let states: Vec<ComputerCleanupState> = computer_values(&published).into_iter().map(|section| section.cleanup_state).collect();
        let from = states.iter().position(|state| *state == ComputerCleanupState::Pending).expect("a stopping section");
        assert!(!states[from..].contains(&ComputerCleanupState::Ready), "never ready between stopping and pending: {states:?}");
        // A push older than the answer (revision 1 < 2) is stale.
        pool.desktop_scope_report(json!({"scope": scope, "revision": 1, "admission": "closed", "cleanup": "complete"}));
        tokio::task::yield_now().await;
        assert_eq!(cleanup_state(&published), Some(ComputerCleanupState::Pending), "a stale report changes nothing");
        pool.desktop_scope_report(json!({"scope": scope, "revision": 3, "admission": "closed", "cleanup": "complete"}));
        awaiting(|| "the pushed report to settle the cleanup".to_owned(), async {
            while cleanup_state(&published) != Some(ComputerCleanupState::Ready) {
                tokio::task::yield_now().await;
            }
        })
        .await;
    }

    /// The desktop's claim ending while a scope's cleanup is pending: unconfirmed, latched.
    #[tokio::test]
    async fn the_desktops_claim_ending_with_a_pending_cleanup_latches_it_unconfirmed() {
        use mixdog_core_session::session::testing::awaiting;

        let (pool, published, _, desk) = pending_off().await;
        pool.desktop_detached();
        tokio::task::yield_now().await;
        assert_eq!(cleanup_state(&published), Some(ComputerCleanupState::Pending), "another connection ending, the claim unchanged: nothing here");
        desk.0.store(7, Ordering::SeqCst);
        pool.desktop_detached();
        awaiting(|| "the detached desktop to latch the cleanup".to_owned(), async {
            while cleanup_state(&published) != Some(ComputerCleanupState::Failed) {
                tokio::task::yield_now().await;
            }
        })
        .await;
    }

    /// Node bounds each shutdown release (`client.mjs:761`): a helper that never answers is given up on after the timeout, so `release_all` ends and the stop steps after it
    /// (memory, PostgreSQL) still run. The clock is paused and held, so the timeout elapses only by the test's own advance.
    #[tokio::test(start_paused = true)]
    async fn a_stuck_helper_release_ends_at_the_shutdown_timeout() {
        use mixdog_core_session::session::testing::{HeldClock, awaiting};

        let _held = HeldClock::hold();
        let stuck = Arc::new(Stuck(tokio::sync::Notify::new()));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(stuck.clone(), plain(), quiet(), on_linux_desktop(settings())).await;
        let backend = pool.backend("stuck");
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let mut call = tokio::spawn(async move { backend.run(read, CancellationToken::new()).await });
        // The call's spawn is the helper that never answers; a call that ends without spawning it is the failure.
        awaiting(|| "the call to spawn the helper".to_owned(), async {
            tokio::select! {
                biased;
                () = stuck.0.notified() => {}
                ended = &mut call => panic!("the call ended without spawning the helper: {ended:?}"),
            }
        })
        .await;
        assert!(pool.entries().get("stuck").is_some_and(|entry| entry.process.is_bound()));
        // The test polls the release itself, so its timeout is armed against the clock as it stands before any advance.
        let mut release = std::pin::pin!(pool.release_all());
        assert!(futures::poll!(release.as_mut()).is_pending(), "the stuck helper's release waits");
        tokio::time::advance(SHUTDOWN_RELEASE - Duration::from_millis(1)).await;
        assert!(futures::poll!(release.as_mut()).is_pending(), "the release is given its whole bound");
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(awaiting(|| "the stuck release to end at the timeout".to_owned(), release).await, 0, "the stuck release is unconfirmed");
        assert!(!pool.entries().contains_key("stuck"), "the session's state goes anyway");
        call.abort();
    }
}

impl NativeToolPaths {
    pub fn new(env: EnvReader, root: PathBuf, exists: Arc<dyn PathExists>, cached: Option<Arc<dyn CachedNativeTool>>) -> Self {
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
        Self { env, root, exists, cached, exe_dir }
    }

    /// The core executable's directory, where it is not the running process's own.
    pub fn with_exe_dir(mut self, exe_dir: Option<PathBuf>) -> Self {
        self.exe_dir = exe_dir;
        self
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
                Step::BesideCore => match &self.exe_dir {
                    Some(dir) => match dir.parent() {
                        Some(resources) => self.present(resources.join("native-tools").join(tool.file_name())).await,
                        None => None,
                    },
                    None => None,
                },
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
    /// `manager`, one helper state per session (or the desktop's computer host where `settings` choose it). The pool exists whether or not
    /// a place has the helper now: what it can serve is read live ([`ComputerSessionPool::can_serve`]), the helper is looked for again
    /// ([`ComputerSessionPool::probe`]) at each listing and each `computer` call. `wrap` decorates each session's backend as it is made (the secret
    /// redaction of that session and the human-only lock); `settings` is what the helpers read from the daemon.
    pub async fn computer_sessions(
        self: &Arc<Self>,
        manager: Arc<dyn ProcessManager>,
        wrap: WrapBackend,
        publisher: Arc<dyn StatePublisher>,
        settings: ComputerSettings,
    ) -> Arc<ComputerSessionPool> {
        let binary = self.resolve(NativeTool::Computer).await;
        let pool = Arc::new(ComputerSessionPool::new(binary, self.clone(), manager, wrap, publisher, settings));
        // The pointer holds exist before the first session's helper does, so every helper shares them.
        let _holds = pool.pointer_hold();
        pool
    }

    async fn present(&self, path: PathBuf) -> Option<PathBuf> {
        self.exists.exists(&path).await.then_some(path)
    }
}

/// What the sessions' helpers read from the daemon: its data directory (each helper's ledger lives under it), the live
/// observation-only setting and the backend that serves a new session.
pub struct ComputerSettings {
    pub data_dir: PathBuf,
    pub io: InteractiveIo,
    pub observe_only: ObserveOnly,
    /// `desktop.computerBackend`, read when a session's first request makes its state: a change reaches the sessions made after it.
    pub backend: Arc<dyn Fn() -> ComputerBackendChoice + Send + Sync>,
    /// The stored images the desktop's computer host names in its replies. Without them the desktop host backend is not offered and
    /// the helper serves every session.
    pub host_blobs: Option<Arc<dyn HostBlobs>>,
    /// `desktop.computerControl`, read at every command: Computer Use switched off refuses the next command of every session, where
    /// Node's bridge answered "unavailable" once the setting stopped it.
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// A test's Linux desktop for the helpers, taken as probed: the host's own would decide whether the stand-in helper is reached.
    #[cfg(any(test, feature = "test-support"))]
    pub linux_desktop: bool,
}

impl ComputerSettings {
    /// The resident helper serves every session; Computer Use is on.
    pub fn new(data_dir: PathBuf, observe_only: ObserveOnly, io: InteractiveIo) -> Self {
        Self {
            data_dir,
            io,
            observe_only,
            backend: Arc::new(|| ComputerBackendChoice::Helper),
            host_blobs: None,
            enabled: Arc::new(|| true),
            #[cfg(any(test, feature = "test-support"))]
            linux_desktop: false,
        }
    }

    /// `desktop.computerObserveOnly` and `desktop.computerBackend` of `config`, read again on every call, so a change in Settings
    /// reaches the next call of every session (the backend, the next session made).
    pub fn from_config(data_dir: PathBuf, config: Config, host_blobs: Option<Arc<dyn HostBlobs>>, io: InteractiveIo) -> Self {
        let observing = config.clone();
        let control = config.clone();
        Self {
            data_dir,
            io,
            observe_only: Arc::new(move || observing.desktop_settings().computer_observe_only),
            backend: Arc::new(move || chosen_backend(&config)),
            host_blobs,
            enabled: Arc::new(move || control.desktop_settings().computer_control),
            #[cfg(any(test, feature = "test-support"))]
            linux_desktop: false,
        }
    }
}

/// What serves one session: its own helper process, or the desktop's computer host (`host/computer/command`).
#[derive(Clone)]
enum Process {
    Helper(Arc<ProcessComputerBackend>),
    Host(HostSession),
}

#[derive(Clone)]
struct HostSession {
    backend: Arc<DesktopHostBackend>,
    /// The host runs the commands, so the session's open execution is the pool's own record.
    presence: Arc<SessionPresence>,
}

impl Process {
    fn is_bound(&self) -> bool {
        match self {
            Self::Helper(process) => process.is_bound(),
            Self::Host(host) => host.backend.status().active,
        }
    }

    fn has_live_host(&self) -> bool {
        matches!(self, Self::Helper(process) if process.has_live_host())
    }

    fn is_executing(&self) -> bool {
        match self {
            Self::Helper(process) => process.is_executing(),
            Self::Host(host) => host.presence.is_open(),
        }
    }

    fn is_cleaning(&self) -> bool {
        matches!(self, Self::Helper(process) if process.is_cleaning())
    }

    fn helper_pid(&self) -> Option<u32> {
        match self {
            Self::Helper(process) => process.helper_pid(),
            Self::Host(_) => None,
        }
    }

    fn secret_host(&self) -> Arc<dyn ComputerSecretHost> {
        match self {
            Self::Helper(process) => process.clone(),
            Self::Host(host) => host.backend.clone(),
        }
    }

    async fn abort(&self) -> bool {
        match self {
            Self::Helper(process) => process.abort_session().await,
            Self::Host(host) => {
                let confirmed = host.backend.session_control("session_abort", Map::new(), HOST_ABORT).await;
                host.presence.ended();
                confirmed
            }
        }
    }

    async fn end_execution(&self) -> bool {
        match self {
            Self::Helper(process) => process.end_execution().await,
            Self::Host(host) => {
                if !host.presence.is_open() {
                    return false;
                }
                let confirmed = host.backend.session_control("execution_end", Map::new(), HOST_EXECUTION_END).await;
                host.presence.ended();
                confirmed
            }
        }
    }

    async fn release(&self) -> bool {
        match self {
            Self::Helper(process) => process.release_session().await,
            Self::Host(host) => {
                let confirmed = host.backend.session_control("session_release", Map::new(), HOST_RELEASE).await;
                host.presence.ended();
                confirmed
            }
        }
    }
}

/// The sessions [`ComputerSessionPool::revoke_all`] revoked, still to be stopped.
pub struct Revoked(Vec<(Process, Authority)>);

async fn settle_off(authorities: Vec<Authority>, settling: Arc<Mutex<Vec<Authority>>>, control: Arc<UserControlState>, pending: OffPending) {
    let mut watches: Vec<_> = authorities.iter().map(Authority::watch_reports).collect();
    loop {
        match off_cleanup(&authorities) {
            RevocationCleanup::Complete => break,
            RevocationCleanup::Unconfirmed => {
                control.cleanup_unconfirmed(DEFAULT_SESSION);
                break;
            }
            RevocationCleanup::Pending => {}
        }
        let _ = futures::future::select_all(watches.iter_mut().map(|watch| Box::pin(watch.changed()))).await;
    }
    forget_settled(&settling, &authorities);
    drop(pending);
}

fn forget_settled(settling: &Mutex<Vec<Authority>>, authorities: &[Authority]) {
    settling.lock().unwrap_or_else(PoisonError::into_inner).retain(|held| !authorities.iter().any(|done| done.id() == held.id()));
}

/// The revocation request: the claim it selects is the one whose reports of a scope count.
const REVOKE_SCOPES: mixdog_core_api::ids::Method = mixdog_core_api::ids::Method(mixdog_tools::desktop::computer_authority::REVOKE_SCOPES_METHOD);

struct Entry {
    process: Process,
    backend: Arc<dyn ComputerBackend>,
    /// The armed idle release (`deferComputerSessionRelease`).
    idle: Option<TimerHandle>,
    /// When the session last asked for its helper (`workerLastUsedAt`).
    used: Instant,
    /// The session's scope, which its backends act under; revoked for good when Computer Use is switched off.
    authority: Authority,
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
///
/// A session made while `desktop.computerBackend` is `desktopHost` (Windows) has no helper of its own: its commands go to the
/// desktop's computer host, and the lifecycle above is sent to that host as session-level commands.
pub struct ComputerSessionPool {
    /// `None` where no place has the helper now; only the desktop host can then serve. Looked for again as the machine changes.
    binary: Mutex<Option<PathBuf>>,
    /// Where the helper is looked for at each ask.
    resolver: Arc<NativeToolPaths>,
    /// `desktop.computerControl`, read where a command is handed over and where a helper starts, and at every secret fill.
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    manager: Arc<dyn ProcessManager>,
    wrap: WrapBackend,
    data_dir: PathBuf,
    io: InteractiveIo,
    /// The desktop's one keyboard and pointer, the person's control of it and the observation-only setting, which every
    /// session's backend shares.
    shared: ComputerShared,
    entries: Mutex<HashMap<String, Entry>>,
    presence: Arc<ComputerPresence>,
    choose: Arc<dyn Fn() -> ComputerBackendChoice + Send + Sync>,
    host_blobs: Option<Arc<dyn HostBlobs>>,
    /// The desktop whose computer host takes the screen captures (`host/computer/*`); bound once the host channel exists. The sessions
    /// get it scoped ([`ScopedDesktop`]); the pool itself uses it unscoped only to revoke scopes there.
    desktop: OnceLock<Arc<dyn HostChannel>>,
    /// Where the sessions' scopes are made: closed while Computer Use is off.
    switch: AuthoritySwitch,
    /// Scopes `revoke_all` revoked whose session no entry held any more, for `stop_revoked`.
    orphans: Mutex<Vec<Authority>>,
    /// The revoked scopes from their stop until their cleanup settled: where the desktop's pushed reports are applied.
    settling: Arc<Mutex<Vec<Authority>>>,
    #[cfg(any(test, feature = "test-support"))]
    linux_desktop: bool,
}

struct ComputerPresence {
    publisher: Arc<dyn StatePublisher>,
    state: Mutex<PresenceState>,
    /// The person's hold on the desktop, which the section carries beside the open executions.
    control: Arc<UserControlState>,
    /// The foreground lane, whose queue and phase the section carries.
    lane: Arc<Lane>,
    /// The helpers whose cleanup the section reports.
    helpers: Mutex<HashMap<String, Weak<ProcessComputerBackend>>>,
    backend: ComputerBackendSection,
    /// The holds of the sessions' pointers; dropped when the person takes the desktop.
    pointer: OnceLock<Arc<PointerHold>>,
    /// Stops of revoked scopes not finished yet (`ComputerSessionPool::stop_revoked`): the section says stopping meanwhile.
    stops: std::sync::atomic::AtomicUsize,
    /// Stops whose closure was confirmed while an executor still reported its cleanup pending: the section keeps the cleanup
    /// pending (never ready) until a later report settles it.
    off_pending: std::sync::atomic::AtomicUsize,
}

/// One stop whose cleanup is still pending at an executor, shown as a pending cleanup until it is dropped.
struct OffPending(Arc<ComputerPresence>);

impl OffPending {
    fn new(presence: &Arc<ComputerPresence>) -> Self {
        presence.off_pending.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        presence.republish();
        Self(presence.clone())
    }
}

impl Drop for OffPending {
    fn drop(&mut self) {
        self.0.off_pending.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.0.republish();
    }
}

/// One stop of revoked scopes in progress, shown in the section as a pending cleanup until it is dropped.
struct Stopping<'a>(&'a ComputerPresence);

impl Drop for Stopping<'_> {
    fn drop(&mut self) {
        self.0.stops.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.0.republish();
    }
}

impl ComputerPresence {
    fn stopping(&self) -> Stopping<'_> {
        self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.republish();
        Stopping(self)
    }

    fn new(publisher: Arc<dyn StatePublisher>, shared: &ComputerShared, backend: ComputerBackendSection) -> Self {
        let presence = Self {
            publisher,
            state: Mutex::default(),
            control: shared.user_control.clone(),
            lane: shared.lane.clone(),
            helpers: Mutex::default(),
            backend,
            pointer: OnceLock::new(),
            stops: std::sync::atomic::AtomicUsize::new(0),
            off_pending: std::sync::atomic::AtomicUsize::new(0),
        };
        // What the section says before anything happened, so that a change that shows nothing publishes nothing.
        let idle = presence.section(&PresenceState::default());
        presence.state().last = Some(idle);
        presence
    }

    fn state(&self) -> MutexGuard<'_, PresenceState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the end-of-run cleanup is done: latched as unconfirmed, still running in a helper, in the stop of revoked scopes, or
    /// at an executor whose report of a revoked scope says pending, or none of these (ready: complete).
    fn cleanup_state(&self) -> ComputerCleanupState {
        if self.control.is_latched() {
            return ComputerCleanupState::Failed;
        }
        if self.stops.load(std::sync::atomic::Ordering::SeqCst) > 0 || self.off_pending.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            return ComputerCleanupState::Pending;
        }
        let helpers = self.helpers.lock().unwrap_or_else(PoisonError::into_inner);
        if helpers.values().filter_map(Weak::upgrade).any(|helper| helper.is_cleaning()) { ComputerCleanupState::Pending } else { ComputerCleanupState::Ready }
    }

    fn section(&self, state: &PresenceState) -> ComputerSection {
        let latest = state.open.last();
        ComputerSection {
            active: latest.is_some(),
            observe_only: latest.is_some_and(|(_, observe_only)| *observe_only),
            controller: None,
            sessions: state
                .open
                .iter()
                .map(|(session, observe_only)| {
                    let running: Vec<&Running> = state.running.iter().filter(|command| command.session == *session).collect();
                    let mut window_ids: Vec<String> = Vec::new();
                    for window in running.iter().flat_map(|command| command.windows.iter()) {
                        if !window_ids.contains(window) {
                            window_ids.push(window.clone());
                        }
                    }
                    let mode = running.last().map(|command| command.mode);
                    let phase = mode.map(|mode| {
                        let word = if mode == ComputerSessionMode::Foreground { "active_foreground" } else { "active_background" };
                        word.to_owned()
                    });
                    ComputerSessionSection { session_thread_id: ThreadId::from(session.as_str()), observe_only: *observe_only, window_ids, mode, phase }
                })
                .collect(),
            session_thread_id: latest.map(|(session, _)| ThreadId::from(session.as_str())),
            user_control: self.control.section(),
            lane: self.lane.section(),
            backend: self.backend,
            cleanup_state: self.cleanup_state(),
            idle_resume_seconds: self.control.idle_resume_seconds(),
        }
    }

    /// Publishes the section when it differs from the one published last.
    fn publish(&self, state: &mut PresenceState) {
        let section = self.section(state);
        if state.last.as_ref() == Some(&section) {
            return;
        }
        self.publisher.publish(SectionName::Computer, None, change_of(&section));
        state.last = Some(section);
    }

    /// Publishes the section again after a change of the person's hold.
    fn republish(&self) {
        let mut state = self.state();
        self.publish(&mut state);
    }

    fn is_running(&self, session: &str) -> bool {
        self.state().running.iter().any(|command| command.session == session)
    }

    fn command_began(&self, session: &str, mode: ComputerSessionMode, windows: Vec<String>) -> u64 {
        let mut state = self.state();
        state.next += 1;
        let id = state.next;
        state.running.push(Running { id, session: session.to_owned(), mode, windows });
        self.publish(&mut state);
        id
    }

    fn command_ended(&self, id: u64) {
        let mut state = self.state();
        state.running.retain(|command| command.id != id);
        self.publish(&mut state);
    }
}

/// One session's edges into [`ComputerPresence`].
struct SessionPresence {
    presence: Arc<ComputerPresence>,
    session: String,
}

impl SessionPresence {
    fn is_open(&self) -> bool {
        self.presence.state().open.iter().any(|(session, _)| *session == self.session)
    }
}

impl ExecutionObserver for SessionPresence {
    fn began(&self, observe_only: bool) {
        self.presence.control.session_began(&self.session);
        let mut state = self.presence.state();
        state.open.retain(|(session, _)| *session != self.session);
        state.open.push((self.session.clone(), observe_only));
        self.presence.publish(&mut state);
    }

    fn cleanup_changed(&self) {
        self.presence.republish();
    }

    fn ended(&self) {
        self.presence.control.session_ended(&self.session);
        let mut state = self.presence.state();
        let before = state.open.len();
        state.open.retain(|(session, _)| *session != self.session);
        if state.open.len() != before {
            self.presence.publish(&mut state);
        }
    }
}

/// A command of a session running: the session's row names its windows, its mode and its phase until the command ends, however it
/// ends (a dropped call included).
struct RunningCommand {
    presence: Arc<ComputerPresence>,
    id: u64,
}

impl RunningCommand {
    fn begin(presence: &Arc<ComputerPresence>, session: &str, request: &ComputerRequest) -> Self {
        let (mode, windows) = classify(request);
        Self { presence: presence.clone(), id: presence.command_began(session, mode, windows) }
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        self.presence.command_ended(self.id);
    }
}

/// A session's backend as the tool sees it: the commands it runs are the presence's running commands, and, where the desktop host
/// runs them, the first of them opens the session's execution (a helper's own backend reports that edge itself).
struct ReportingBackend {
    inner: Arc<dyn ComputerBackend>,
    presence: Arc<ComputerPresence>,
    session: String,
    host: Option<(Arc<SessionPresence>, ObserveOnly)>,
    authority: Authority,
}

#[async_trait]
impl ComputerBackend for ReportingBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        // The first look, so that a refused command opens no execution and makes no presence. The backends look again where the command
        // is handed to the helper or the host, which is the check that binds.
        self.authority.check()?;
        let _running = RunningCommand::begin(&self.presence, &self.session, &request);
        if let Some((session, observe_only)) = &self.host
            && !session.is_open()
        {
            session.began(observe_only());
        }
        self.inner.run(request, cancel).await
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        self.inner.inject(input)
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        self.inner.release_input()
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        self.inner.input_desktop()
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        self.inner.displays()
    }

    fn screen_source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        self.inner.screen_source(display)
    }

    fn status(&self) -> ComputerStatus {
        self.inner.status()
    }
}

/// What the pointer holds act on: the sessions' presence and helpers.
struct PoolPointerHost {
    pool: Weak<ComputerSessionPool>,
}

#[async_trait]
impl PointerHost for PoolPointerHost {
    /// The `computer` section has no per-session pointer field: the arrow follows the hold, and `release_cursor_theme` gives the
    /// cursor back, so there is no presence to change here.
    fn release_pointer(&self, _session: &str) {}

    fn is_running(&self, session: &str) -> bool {
        self.pool.upgrade().is_some_and(|pool| pool.presence.is_running(&session_key(session)))
    }

    async fn release_cursor_theme(&self, session: &str) {
        let Some(pool) = self.pool.upgrade() else { return };
        let process = pool.entries().get(&session_key(session)).map(|entry| entry.process.clone());
        // Only a helper that is running is told (nothing is started), and its failure is swallowed: its watchdog gives the cursor back.
        let Some(Process::Helper(helper)) = process.filter(Process::has_live_host) else { return };
        let mut command = Map::new();
        command.insert("action".to_owned(), Value::String("release_cursor_theme".to_owned()));
        let _ = mixdog_rt::time::timeout(CURSOR_RELEASE, helper.execute(command)).await;
    }
}

impl ComputerSessionPool {
    pub fn new(
        binary: Option<PathBuf>,
        resolver: Arc<NativeToolPaths>,
        manager: Arc<dyn ProcessManager>,
        wrap: WrapBackend,
        publisher: Arc<dyn StatePublisher>,
        settings: ComputerSettings,
    ) -> Self {
        let shared = ComputerShared { observe_only: settings.observe_only, ..ComputerShared::default() };
        let section_backend = if settings.host_blobs.is_some() && (settings.backend)() == ComputerBackendChoice::DesktopHost {
            ComputerBackendSection::DesktopHost
        } else {
            ComputerBackendSection::Helper
        };
        let presence = Arc::new(ComputerPresence::new(publisher, &shared, section_backend));
        let published = Arc::downgrade(&presence);
        shared.user_control.on_change(Arc::new(move || {
            if let Some(presence) = published.upgrade() {
                presence.republish();
                // The person's hold ends the sessions' pointer holds without a release: the helpers restore the cursor themselves.
                if presence.control.section().is_some()
                    && let Some(hold) = presence.pointer.get()
                {
                    hold.paused();
                }
            }
        }));
        // The queue behind the desktop's one keyboard and pointer changes between command events: the section shows it as it does.
        let queued = Arc::downgrade(&presence);
        shared.lane.on_change(Arc::new(move || {
            if let Some(presence) = queued.upgrade() {
                presence.republish();
            }
        }));
        // The ledgers a crashed core left are replayed now rather than at the first session's first helper: the windows it left
        // without activation are restored before anyone uses `computer`. A session's first helper waits for this sweep.
        if let (Some(binary), Ok(runtime)) = (&binary, tokio::runtime::Handle::try_current()) {
            let mut config = ComputerConfig::new(binary.clone(), "ledger-sweep");
            config.data_dir = Some(settings.data_dir.clone());
            let sweeper = ProcessComputerBackend::new(config, manager.clone(), settings.io);
            let _sweep = runtime.spawn(async move { sweeper.sweep_ledgers().await });
        }
        Self {
            binary: Mutex::new(binary),
            resolver,
            switch: AuthoritySwitch::new(settings.enabled.clone()),
            orphans: Mutex::default(),
            settling: Arc::default(),
            enabled: settings.enabled,
            manager,
            wrap,
            data_dir: settings.data_dir,
            io: settings.io,
            shared,
            entries: Mutex::new(HashMap::new()),
            presence,
            choose: settings.backend,
            host_blobs: settings.host_blobs,
            desktop: OnceLock::new(),
            #[cfg(any(test, feature = "test-support"))]
            linux_desktop: settings.linux_desktop,
        }
    }

    fn binary(&self) -> Option<PathBuf> {
        self.binary.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Whether `computer` can run now and over what, decided from what is true now: the helper resolved afresh (the file system is
    /// asked, nothing remembered is read), the setting, the backend `desktop.computerBackend` chose and whether a desktop serves the
    /// computer host. Each consumer takes its own decision; a call is served over the route its decision named.
    pub async fn availability_now(&self) -> ComputerAvailability {
        let helper = self.resolver.resolve(NativeTool::Computer).await;
        let desktop = self.desktop.get().is_some_and(|desktop| desktop.serves(mixdog_core_api::HostCapability::Computer));
        let route = match (helper, self.wants_host()) {
            (_, true) | (None, false) => (self.host_blobs.is_some() && desktop).then_some(ComputerRoute::DesktopHost),
            (Some(binary), false) => Some(ComputerRoute::Helper(binary)),
        };
        ComputerAvailability { enabled: (self.enabled)(), route }
    }

    /// The availability decision of a listing that is followed by synchronous reads ([`Self::can_serve`], `Tool::runnable`, the feature
    /// gate): the helper it resolved is what those reads answer until the next listing. A call does not read it: it decides for
    /// itself ([`ComputerSessions::backend_now`]). True when something can serve.
    pub async fn probe(&self) -> bool {
        let found = self.resolver.resolve(NativeTool::Computer).await;
        *self.binary.lock().unwrap_or_else(PoisonError::into_inner) = found;
        self.can_serve()
    }

    /// Whether the helper was there at the last ask ([`Self::probe`]), for the reads that cannot wait on the file system.
    pub fn helper_resolvable(&self) -> bool {
        self.binary().is_some()
    }

    /// `desktop.computerBackend` asks for the desktop's own computer host (Windows) and the core can reach its images.
    fn wants_host(&self) -> bool {
        self.host_blobs.is_some() && (self.choose)() == ComputerBackendChoice::DesktopHost
    }

    /// Whether this core has anything that can serve a command now: a helper, or the desktop host the setting chose. Read live.
    pub fn can_serve(&self) -> bool {
        self.helper_resolvable() || self.wants_host()
    }

    /// Whether `computer` can run now: Computer Use is switched on and something can serve ([`Self::can_serve`]).
    pub fn is_available(&self) -> bool {
        (self.enabled)() && self.can_serve()
    }

    /// Computer Use was switched off, applied where the setting is adopted (before the change is acknowledged): no scope is made from now
    /// on, every session's scope is revoked (a command that was admitted and still waits, a preparation in progress, a backend someone
    /// kept find it revoked where they would act, and switching on again does not reopen it), and the sessions are forgotten with their
    /// idle releases. Synchronous; what is to be stopped is returned for [`Self::stop_revoked`].
    pub fn revoke_all(&self) -> Revoked {
        let revoked = self.switch.close();
        let mut entries = self.entries();
        let stopped: Vec<(Process, Authority)> = entries
            .drain()
            .map(|(_, mut entry)| {
                entry.authority.revoke();
                if let Some(timer) = entry.idle.take() {
                    let _disarmed = timer.cancel();
                }
                (entry.process, entry.authority)
            })
            .collect();
        drop(entries);
        // The scopes of backends no entry holds any more (a call still running on a session released meanwhile) are stopped too.
        let orphans = revoked.into_iter().filter(|authority| !stopped.iter().any(|(_, kept)| kept.id() == authority.id()));
        self.orphans().extend(orphans);
        Revoked(stopped)
    }

    /// Computer Use switched on again: new scopes are made for the sessions that ask; revoked ones stay revoked.
    pub fn reopen(&self) {
        self.switch.open();
    }

    /// The stop of what [`Self::revoke_all`] revoked: each scope is revoked at the desktop (which answers once its contexts of those
    /// scopes refuse), and each helper process created under one is revoked on its control path, releases what it held and exits
    /// (`ProcessComputerBackend::revoke_and_stop`; no cleanup process, no focus restore). True once every executor acknowledged or
    /// exited ([`OffReport::confirmed`]); not while the desktop did not report every scope's closure, or an executor reported its
    /// admission unconfirmed. A helper that does not answer keeps this waiting: stopping, not stopped. The section shows it: a pending
    /// cleanup while the stop runs, and an unconfirmed one (latched like a helper's unconfirmed cleanup, until Resume) when it ends
    /// unconfirmed, also where no helper ran (a desktop-host session), or when an executor reported its cleanup unconfirmed.
    pub async fn stop_revoked(&self, Revoked(revoked): Revoked) -> OffReport {
        let orphans = std::mem::take(&mut *self.orphans());
        if revoked.is_empty() && orphans.is_empty() {
            return OffReport { confirmed: true, reports: Vec::new() };
        }
        let _stopping = self.presence.stopping();
        // An orphan's helpers have no session left to record a cleanup on; they are revoked all the same.
        let control = self.shared.user_control.clone();
        let unowned = futures::future::join_all(orphans.iter().map(|authority| {
            let control = control.clone();
            revoke_launched(
                self.manager.clone(),
                authority,
                Arc::default(),
                Arc::new(move |released: bool| {
                    if !released {
                        control.cleanup_unconfirmed(DEFAULT_SESSION);
                    }
                }),
            )
        }));
        let authorities: Vec<Authority> = revoked.iter().map(|(_, authority)| authority.clone()).chain(orphans.iter().cloned()).collect();
        // Registered before the desktop is asked: a report it pushes before its answer arrives is applied, and the answer, older,
        // is then stale (revision order).
        self.settling.lock().unwrap_or_else(PoisonError::into_inner).extend(authorities.iter().cloned());
        let desktop = async {
            match self.desktop.get() {
                // Each scope's desktop report is kept on it only from the claim that took all its desktop work.
                Some(desktop) => revoke_at_desktop_reports(&**desktop, &authorities, DESKTOP_EXECUTOR).await != DesktopRevocation::Unconfirmed,
                None => true,
            }
        };
        let helpers = futures::future::join_all(revoked.iter().map(|(process, _)| async move {
            match process {
                Process::Helper(helper) => helper.revoke_and_stop().await,
                Process::Host(host) => {
                    host.presence.ended();
                    true
                }
            }
        }));
        let (desktop, helpers, unowned) = futures::future::join3(desktop, helpers, unowned).await;
        let confirmed = desktop && helpers.into_iter().chain(unowned).all(|stopped| stopped);
        let report = OffReport {
            confirmed,
            reports: authorities
                .iter()
                .flat_map(|authority| {
                    authority.revocation_reports().into_iter().map(|(executor, report)| ExecutorReport { scope: authority.id(), executor, report })
                })
                .collect(),
        };
        self.conclude_stop(&report, authorities);
        report
    }

    /// What the section shows once the stop ended: unconfirmed is latched, a pending cleanup waits for a later report, otherwise
    /// the scopes are settled and no report of theirs is applied any more.
    fn conclude_stop(&self, report: &OffReport, authorities: Vec<Authority>) {
        if !report.confirmed || report.cleanup() == RevocationCleanup::Unconfirmed {
            // Latched before the stop leaves the section, so it goes from stopping to unconfirmed, never through ready.
            self.shared.user_control.cleanup_unconfirmed(DEFAULT_SESSION);
            forget_settled(&self.settling, &authorities);
        } else if report.cleanup() == RevocationCleanup::Pending {
            // Taken before the stop leaves the section, so it goes from stopping to pending, never through ready; a later report
            // settles it.
            let pending = OffPending::new(&self.presence);
            tokio::spawn(settle_off(authorities, self.settling.clone(), self.shared.user_control.clone(), pending));
        } else {
            forget_settled(&self.settling, &authorities);
        }
    }

    /// The Computer claimant pushed a revoked scope's report (`host/computer/scopeReport`): kept on the scope when every request of
    /// its desktop work went to the claim serving now and the report is newer than the one it holds (the answer to the revocation,
    /// or an earlier push), which wakes the wait for its cleanup to settle; a report from a later claim of a scope whose work went to
    /// an earlier one leaves it unconfirmed.
    pub fn desktop_scope_report(&self, report: Value) {
        let report = RevocationReport::from_json(&report);
        let serving = self.desktop.get().and_then(|desktop| desktop.claim_generation(mixdog_core_api::HostCapability::Computer, REVOKE_SCOPES));
        let settling = self.settling.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(authority) = settling.iter().find(|authority| Some(authority.id()) == report.scope) {
            authority.record_desktop(DESKTOP_EXECUTOR, Some(report), Some(serving));
        }
    }

    /// A connection ended: each settling scope whose desktop work went to a claim other than the one serving now (the claim of that
    /// connection is gone), and whose desktop cleanup is not complete, is unconfirmed there for good. Other scopes are untouched.
    pub fn desktop_detached(&self) {
        let current = self.desktop.get().and_then(|desktop| desktop.claim_generation(mixdog_core_api::HostCapability::Computer, REVOKE_SCOPES));
        let settling = self.settling.lock().unwrap_or_else(PoisonError::into_inner).clone();
        for authority in settling {
            authority.desktop_claim_now(DESKTOP_EXECUTOR, current);
        }
    }

    /// [`Self::revoke_all`] and [`Self::stop_revoked`].
    pub async fn stop_all(&self) -> OffReport {
        let revoked = self.revoke_all();
        self.stop_revoked(revoked).await
    }

    fn orphans(&self) -> MutexGuard<'_, Vec<Authority>> {
        self.orphans.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The person's hold on the desktop, which the pill's Resume and Stop (`computer/userControl`) act on.
    pub fn user_control(&self) -> Arc<UserControlState> {
        self.shared.user_control.clone()
    }

    /// The holds of the sessions' pointers between their commands, which `computer/pointerReleased` ends and the person's hold of
    /// the desktop drops. One per pool.
    pub fn pointer_hold(self: &Arc<Self>) -> Arc<PointerHold> {
        self.presence.pointer.get_or_init(|| Arc::new(PointerHold::new(Arc::new(PoolPointerHost { pool: Arc::downgrade(self) })))).clone()
    }

    /// Binds the desktop channel the sessions' backends ask for screen captures; the first binding stands, and only sessions made after it use it.
    pub fn attach_desktop(&self, desktop: Arc<dyn HostChannel>) {
        let _ = self.desktop.set(desktop);
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn reclaim_idle(&self, entries: &mut HashMap<String, Entry>, keep: &str) {
        let limit = if self.shared.live.count() >= PRESSURE_COUNT { IDLE_PRESSURE } else { IDLE_STALE };
        let budget = &self.shared.budget;
        let idle: Vec<String> = entries
            .iter()
            .filter(|(id, entry)| {
                id.as_str() != keep
                    && (entry.process.is_bound() || entry.process.has_live_host())
                    && !entry.process.is_executing()
                    && !entry.process.is_cleaning()
                    && !budget.is_pending(id)
                    && entry.used.elapsed() >= limit
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            let Some(mut entry) = entries.remove(&id) else { continue };
            if let Some(timer) = entry.idle.take() {
                let _disarmed = timer.cancel();
            }
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let process = entry.process;
                runtime.spawn(async move { process.release().await });
            }
        }
    }

    /// The state of a session that has none yet: the desktop host's when `desktop.computerBackend` says so (Windows) or no helper
    /// exists, and the desktop is attached; else the resident helper's.
    fn make_entry(&self, key: &str, binary: Option<PathBuf>) -> Result<Entry, ComputerError> {
        let wants_host = self.wants_host();
        let observer = Arc::new(SessionPresence { presence: self.presence.clone(), session: key.to_owned() });
        // A new scope, refused while Computer Use is off: a session made after it was switched on again never holds an older scope.
        let authority = self.switch.scope()?;
        // Every desktop request of the session names its scope and stops at its revocation (capture, zoom, lease, feedback, commands).
        let scoped = self.desktop.get().map(|desktop| ScopedDesktop::wrap(desktop.clone(), authority.clone()));
        let (process, backend, host) = match (&binary, wants_host) {
            (_, true) | (None, _) => {
                let (Some(desktop), Some(blobs)) = (scoped, &self.host_blobs) else { return Err(no_host()) };
                let host = Arc::new(DesktopHostBackend::new(desktop, blobs.clone(), key, self.shared.observe_only.clone()).with_authority(authority.clone()));
                let session = HostSession { backend: host.clone(), presence: observer };
                (Process::Host(session.clone()), (self.wrap)(key, host), Some(session.presence))
            }
            (Some(binary), false) => {
                if self.shared.live.count() >= MAX_RESIDENT_HELPERS {
                    return Err(AtCapacity::refusal());
                }
                let mut config = ComputerConfig::new(binary.clone(), key);
                config.data_dir = Some(self.data_dir.clone());
                // The helpers read the pixels of a display from the core's blob store and keep the pointer between a session's commands.
                let shared = ComputerShared { blobs: self.host_blobs.clone(), pointer_hold: self.presence.pointer.get().cloned(), ..self.shared.clone() };
                let mut helper = ProcessComputerBackend::new(config, self.manager.clone(), self.io)
                    .with_shared(shared)
                    .with_observer(observer)
                    .with_authority(authority.clone());
                if let Some(desktop) = scoped {
                    helper = helper.with_desktop(desktop);
                }
                #[cfg(any(test, feature = "test-support"))]
                if self.linux_desktop {
                    helper = helper.with_ready_linux_desktop();
                }
                let helper = Arc::new(helper);
                self.shared.user_control.register(key, Arc::downgrade(&helper));
                self.presence.helpers.lock().unwrap_or_else(PoisonError::into_inner).insert(key.to_owned(), Arc::downgrade(&helper));
                helper.watch_for_death();
                (Process::Helper(helper.clone()), (self.wrap)(key, helper), None)
            }
        };
        let backend = Arc::new(ReportingBackend {
            inner: backend,
            presence: self.presence.clone(),
            session: key.to_owned(),
            host: host.map(|session| (session, self.shared.observe_only.clone())),
            authority: authority.clone(),
        });
        Ok(Entry { process, backend, idle: None, used: Instant::now(), authority })
    }

    /// The session's state and its (decorated) backend; a use disarms a pending idle release. A refusal for a new
    /// session when `MAX_RESIDENT_HELPERS` helper processes are live (not sessions: one that has not started a helper, or whose
    /// helper ended, takes no slot) and none could be reclaimed.
    fn entry_for(&self, session: &str) -> Result<(Process, Arc<dyn ComputerBackend>), ComputerError> {
        self.entry_with(session, self.binary())
    }

    /// [`Self::entry_for`], a new session's state made over `binary` (the helper an availability decision resolved).
    fn entry_with(&self, session: &str, binary: Option<PathBuf>) -> Result<(Process, Arc<dyn ComputerBackend>), ComputerError> {
        let key = session_key(session);
        let mut entries = self.entries();
        self.reclaim_idle(&mut entries, &key);
        // A session whose scope was revoked is never served again: a new state with a new scope replaces it, and the old one is stopped
        // as a revocation stops it.
        if let Some(stale) = entries.get(&key).filter(|entry| entry.authority.is_revoked()).map(|entry| entry.process.clone())
            && let Process::Helper(helper) = stale
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move { helper.revoke_and_stop().await });
        }
        entries.retain(|_, entry| !entry.authority.is_revoked());
        if !entries.contains_key(&key) {
            let made = self.make_entry(&key, binary)?;
            entries.insert(key.clone(), made);
        }
        let Some(entry) = entries.get_mut(&key) else { return Err(no_host()) };
        entry.used = Instant::now();
        if let Some(timer) = entry.idle.take() {
            let _disarmed = timer.cancel();
        }
        Ok((entry.process.clone(), entry.backend.clone()))
    }

    /// The process id of `session`'s resident helper; `None` when the session has none running (nothing is started to tell).
    pub fn helper_pid(&self, session: &str) -> Option<u32> {
        self.entries().get(&session_key(session))?.process.helper_pid()
    }

    /// `abortComputerSession(id)`: the session's helper is stopped and cleaned up from a fresh process. True when the cleanup
    /// confirmed; false for a session that never reached the helper.
    pub async fn abort(&self, session: &str) -> bool {
        let process = self.entries().get(&session_key(session)).map(|entry| entry.process.clone());
        match process {
            Some(process) => process.abort().await,
            None => false,
        }
    }

    /// The windows of the desktop with their owning processes, as the authorization names them (`listAuthorizationWindows`), read through
    /// `session`'s helper.
    pub async fn authorization_windows(&self, session: &str) -> Result<Vec<serde_json::Value>, ComputerError> {
        match self.entry_for(session)?.0 {
            Process::Helper(process) => process.authorization_windows().await,
            // The window list is the desktop's, not a session's: a session the desktop's host serves has no helper, so a helper of
            // its own reads it once and ends with the read.
            Process::Host(_) => {
                let Some(binary) = self.binary() else {
                    return Err(ComputerError::Unavailable { reason: "no computer helper is installed to read the windows".to_owned() });
                };
                let mut config = ComputerConfig::new(binary, "computer-settings");
                config.data_dir = Some(self.data_dir.clone());
                ProcessComputerBackend::new(config, self.manager.clone(), self.io).authorization_windows().await
            }
        }
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
        entry.process.release().await
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
        let outcomes = futures::future::join_all(
            bound.iter().map(|id| async move { mixdog_rt::time::timeout(SHUTDOWN_RELEASE, self.release(id)).await.unwrap_or(false) }),
        )
        .await;
        outcomes.into_iter().filter(|released| *released).count()
    }

    /// `endComputerExecution(id)`: the turn's execution ends, the helper stays warm, and the session's held pointer is the person's
    /// again. False for a session with no open execution.
    pub async fn end_execution(&self, session: &str) -> bool {
        let key = session_key(session);
        let process = self.entries().get(&key).map(|entry| entry.process.clone());
        let Some(process) = process else { return false };
        let ended = process.end_execution().await;
        if let Some(hold) = self.presence.pointer.get() {
            hold.turn_ended(&key).await;
        }
        ended
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
    #[cfg(any(test, feature = "test-support"))]
    releases: Mutex<Vec<tokio::task::JoinHandle<bool>>>,
}

impl OwnedShells for ReapingShells {
    fn cancel_owned(&self, owner: &ThreadId) {
        self.shells.cancel_owned(owner);
        let (computer, session) = (self.computer.clone(), owner.as_str().to_owned());
        let _release = tokio::spawn(async move { computer.release(&session).await });
        #[cfg(any(test, feature = "test-support"))]
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
    #[cfg(any(test, feature = "test-support"))]
    settlements: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl TurnSnapshots for SettlingSnapshots {
    fn turn_begun(&self, thread: &ThreadId) {
        self.snapshots.turn_begun(thread);
    }

    fn turn_settled(&self, thread: &ThreadId) {
        let (computer, session) = (self.computer.clone(), thread.as_str().to_owned());
        let _settlement = tokio::spawn(async move {
            computer.end_execution(&session).await;
            computer.defer_release(&session);
        });
        #[cfg(any(test, feature = "test-support"))]
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

#[async_trait]
impl ComputerSessions for ComputerSessionPool {
    /// The call's own availability decision ([`ComputerSessionPool::availability_now`]): refused in Node's words when Computer Use is
    /// off or nothing serves, else the session's backend, a new session's made over the route the decision named.
    async fn backend_now(&self, session: &str) -> Arc<dyn ComputerBackend> {
        let decided = self.availability_now().await;
        let made = match (decided.enabled, decided.route) {
            (false, _) => Err(mixdog_tools::desktop::computer_backend::bridge_unavailable()),
            (true, None) => Err(no_host()),
            (true, Some(ComputerRoute::Helper(binary))) => self.entry_with(session, Some(binary)),
            (true, Some(ComputerRoute::DesktopHost)) => self.entry_with(session, None),
        };
        match made {
            Ok((_, backend)) => backend,
            Err(refusal) => Arc::new(Refusing(refusal)),
        }
    }

    fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
        match self.entry_for(session) {
            Ok((_, backend)) => backend,
            Err(refusal) => Arc::new(Refusing(refusal)),
        }
    }

    fn available(&self) -> bool {
        self.is_available()
    }
}

/// The secret fill drives the helper of the thread's own session, the one state its `computer`
/// calls use (the desktop host's, where that serves the session).
impl ComputerSecretHosts for ComputerSessionPool {
    fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>> {
        // A fill types into the desktop as a command does: with Computer Use off there is no desktop control to fill with.
        if !(self.enabled)() {
            return None;
        }
        Some(self.entry_for(thread.as_str()).ok()?.0.secret_host())
    }
}

impl ReapingShells {
    pub fn new(shells: Arc<dyn OwnedShells>, computer: Arc<ComputerSessionPool>) -> Self {
        Self {
            shells,
            computer,
            #[cfg(any(test, feature = "test-support"))]
            releases: Mutex::default(),
        }
    }

    /// Returns once every release started so far has ended.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    async fn released(&self) {
        let tasks = std::mem::take(&mut *self.releases.lock().unwrap_or_else(PoisonError::into_inner));
        for task in tasks {
            mixdog_core_session::session::testing::awaiting(|| "a session's computer release to end".to_owned(), task)
                .await
                .expect("a session's computer release");
        }
    }
}

impl SettlingSnapshots {
    pub fn new(snapshots: Arc<dyn TurnSnapshots>, computer: Arc<ComputerSessionPool>) -> Self {
        Self {
            snapshots,
            computer,
            #[cfg(any(test, feature = "test-support"))]
            settlements: Mutex::default(),
        }
    }

    /// Returns once every settlement started so far has ended.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    async fn settled(&self) {
        let tasks = std::mem::take(&mut *self.settlements.lock().unwrap_or_else(PoisonError::into_inner));
        for task in tasks {
            mixdog_core_session::session::testing::awaiting(|| "a turn's computer settlement to end".to_owned(), task)
                .await
                .expect("a turn's computer settlement");
        }
    }
}
