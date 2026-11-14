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
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::Weak;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::tool::ToolPart;
use tokio_util::sync::CancellationToken;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::HostChannel;
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
use mixdog_protocol::ComputerBackendSection;
use mixdog_protocol::ComputerCleanupState;
use mixdog_protocol::ComputerSection;
use mixdog_protocol::ComputerSessionMode;
use mixdog_protocol::ComputerSessionSection;
use mixdog_protocol::SectionName;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ComputerBackendChoice;
use mixdog_core_config::config::computer_backend;
use serde_json::Map;
use serde_json::Value;
use mixdog_tools::desktop::computer_budget::MAX_LIVE_HELPERS;
use mixdog_tools::desktop::computer_backend::ComputerConfig;
use mixdog_tools::desktop::computer_backend::ComputerShared;
use mixdog_tools::desktop::computer_backend::ExecutionObserver;
use mixdog_tools::desktop::computer_backend::ObserveOnly;
use mixdog_tools::desktop::computer_backend::ProcessComputerBackend;
use mixdog_tools::desktop::computer_desktop_host::ComputerBlobs as HostBlobs;
use mixdog_tools::desktop::computer_desktop_host::DesktopHostBackend;
use mixdog_tools::desktop::computer_lane::Lane;
use mixdog_tools::desktop::computer_pointer::PointerHold;
use mixdog_tools::desktop::computer_pointer::PointerHost;
use mixdog_tools::desktop::computer_user_control::UserControlState;

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
    /// `manager`, one helper state per session (or the desktop's computer host where `settings` choose it), or `None` where no
    /// place has the helper and the host is not chosen (the tool is then not registered). `wrap` decorates each session's backend as it is made (the secret
    /// redaction of that session and the human-only lock); `settings` is what the helpers read from the daemon.
    pub async fn computer_sessions(
        &self,
        manager: Arc<dyn ProcessManager>,
        wrap: WrapBackend,
        publisher: Arc<dyn StatePublisher>,
        settings: ComputerSettings,
    ) -> Option<Arc<ComputerSessionPool>> {
        let binary = self.resolve(NativeTool::Computer).await;
        // Without the helper only the desktop's computer host can serve, and only where `desktop.computerBackend` asks for it.
        let host_serves = settings.host_blobs.is_some() && (settings.backend)() == ComputerBackendChoice::DesktopHost;
        if binary.is_none() && !host_serves {
            return None;
        }
        Some(Arc::new(ComputerSessionPool::new(binary, manager, wrap, publisher, settings)))
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

/// How long a session-level command (`execution_end`, `session_abort`, `session_release`) waits for the desktop's own computer host
/// (`SESSION_ABORT_TIMEOUT_MS` of the client).
const HOST_CONTROL: Duration = Duration::from_secs(15);

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

/// What the sessions' helpers read from the daemon: its data directory (each helper's ledger lives under it), the live
/// observation-only setting and the backend that serves a new session.
pub struct ComputerSettings {
    pub data_dir: PathBuf,
    pub observe_only: ObserveOnly,
    /// `desktop.computerBackend`, read when a session's first request makes its state: a change reaches the sessions made after it.
    pub backend: Arc<dyn Fn() -> ComputerBackendChoice + Send + Sync>,
    /// The stored images the desktop's computer host names in its replies. Without them the desktop host backend is not offered and
    /// the helper serves every session.
    pub host_blobs: Option<Arc<dyn HostBlobs>>,
}

impl ComputerSettings {
    /// The resident helper serves every session.
    pub fn new(data_dir: PathBuf, observe_only: ObserveOnly) -> Self {
        Self { data_dir, observe_only, backend: Arc::new(|| ComputerBackendChoice::Helper), host_blobs: None }
    }

    /// `desktop.computerObserveOnly` and `desktop.computerBackend` of `config`, read again on every call, so a change in Settings
    /// reaches the next call of every session (the backend, the next session made).
    pub fn from_config(data_dir: PathBuf, config: Config, host_blobs: Option<Arc<dyn HostBlobs>>) -> Self {
        let observing = config.clone();
        Self {
            data_dir,
            observe_only: Arc::new(move || observing.desktop_settings().computer_observe_only),
            backend: Arc::new(move || chosen_backend(&config)),
            host_blobs,
        }
    }
}

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
                let confirmed = host.backend.session_control("session_abort", Map::new(), HOST_CONTROL).await;
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
                let confirmed = host.backend.session_control("execution_end", Map::new(), HOST_CONTROL).await;
                host.presence.ended();
                confirmed
            }
        }
    }

    async fn release(&self) -> bool {
        match self {
            Self::Helper(process) => process.release_session().await,
            Self::Host(host) => {
                let confirmed = host.backend.session_control("session_release", Map::new(), HOST_CONTROL).await;
                host.presence.ended();
                confirmed
            }
        }
    }
}

struct Entry {
    process: Process,
    backend: Arc<dyn ComputerBackend>,
    /// The armed idle release (`deferComputerSessionRelease`).
    idle: Option<TimerHandle>,
    /// When the session last asked for its helper (`workerLastUsedAt`).
    used: Instant,
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
    /// `None` where no place has the helper and only the desktop host serves.
    binary: Option<PathBuf>,
    manager: Arc<dyn ProcessManager>,
    wrap: WrapBackend,
    data_dir: PathBuf,
    /// The desktop's one keyboard and pointer, the person's control of it and the observation-only setting, which every
    /// session's backend shares.
    shared: ComputerShared,
    entries: Mutex<HashMap<String, Entry>>,
    presence: Arc<ComputerPresence>,
    choose: Arc<dyn Fn() -> ComputerBackendChoice + Send + Sync>,
    host_blobs: Option<Arc<dyn HostBlobs>>,
    /// The desktop whose computer host takes the screen captures (`host/computer/*`); bound once the host channel exists.
    desktop: OnceLock<Arc<dyn HostChannel>>,
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

/// The sessions with an open execution, oldest first, and the `computer` section that says so (SPEC R40): the pill
/// the desktop shows while an agent drives the desktop. Node's coordinator keeps a session present from its first
/// command (`beginCommand`) until the turn settles (`endExecution`) and its snapshot lists every one of them
/// (`coordinator.ts` `snapshot().activities`); the section lists them all, and names the latest in its own fields. A session's row
/// also carries the windows, the mode and the phase of the commands running now.
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
}

impl ComputerPresence {
    fn new(publisher: Arc<dyn StatePublisher>, shared: &ComputerShared, backend: ComputerBackendSection) -> Self {
        let presence = Self {
            publisher,
            state: Mutex::default(),
            control: shared.user_control.clone(),
            lane: shared.lane.clone(),
            helpers: Mutex::default(),
            backend,
            pointer: OnceLock::new(),
        };
        // What the section says before anything happened, so that a change that shows nothing publishes nothing.
        let idle = presence.section(&PresenceState::default());
        presence.state().last = Some(idle);
        presence
    }

    fn state(&self) -> MutexGuard<'_, PresenceState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the end-of-run cleanup is done: latched as unconfirmed, still running in a helper, or neither.
    fn cleanup_state(&self) -> ComputerCleanupState {
        if self.control.is_latched() {
            return ComputerCleanupState::Failed;
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

/// A session's backend as the tool sees it: the commands it runs are the presence's running commands, and, where the desktop host
/// runs them, the first of them opens the session's execution (a helper's own backend reports that edge itself).
struct ReportingBackend {
    inner: Arc<dyn ComputerBackend>,
    presence: Arc<ComputerPresence>,
    session: String,
    host: Option<(Arc<SessionPresence>, ObserveOnly)>,
}

#[async_trait]
impl ComputerBackend for ReportingBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
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
    pub fn new(binary: Option<PathBuf>, manager: Arc<dyn ProcessManager>, wrap: WrapBackend, publisher: Arc<dyn StatePublisher>, settings: ComputerSettings) -> Self {
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
        // The ledgers a crashed core left are replayed now rather than at the first session's first helper: the windows it left
        // without activation are restored before anyone uses `computer`. A session's first helper waits for this sweep.
        if let (Some(binary), Ok(runtime)) = (&binary, tokio::runtime::Handle::try_current()) {
            let mut config = ComputerConfig::new(binary.clone(), "ledger-sweep");
            config.data_dir = Some(settings.data_dir.clone());
            let sweeper = ProcessComputerBackend::new(config, manager.clone());
            let _sweep = runtime.spawn(async move { sweeper.sweep_ledgers().await });
        }
        Self {
            binary,
            manager,
            wrap,
            data_dir: settings.data_dir,
            shared,
            entries: Mutex::new(HashMap::new()),
            presence,
            choose: settings.backend,
            host_blobs: settings.host_blobs,
            desktop: OnceLock::new(),
        }
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

    /// Every request reclaims the helpers of sessions that sat idle (`reapIdleSessionWorkers`, which Node runs on each request and
    /// on its heartbeat; here only a request can): after five minutes, after five seconds once `PRESSURE_COUNT` helpers are live.
    /// Never one with an open execution, a command pending or a cleanup running, and never `keep`, the session asking. Each is
    /// released as `release` does, which aborts it fully when it still owes input. The core holds no window target leases (the
    /// desktop coordinator's are the TypeScript host's), so none exempts a session here.
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
    fn make_entry(&self, key: &str) -> Result<Entry, ComputerError> {
        let wants_host = self.host_blobs.is_some() && (self.choose)() == ComputerBackendChoice::DesktopHost;
        let observer = Arc::new(SessionPresence { presence: self.presence.clone(), session: key.to_owned() });
        let (process, backend, host) = match (&self.binary, wants_host) {
            (_, true) | (None, _) => {
                let (Some(desktop), Some(blobs)) = (self.desktop.get(), &self.host_blobs) else { return Err(no_host()) };
                let host = Arc::new(DesktopHostBackend::new(desktop.clone(), blobs.clone(), key, self.shared.observe_only.clone()));
                let session = HostSession { backend: host.clone(), presence: observer };
                (Process::Host(session.clone()), (self.wrap)(key, host), Some(session.presence))
            }
            (Some(binary), false) => {
                if self.shared.live.count() >= MAX_RESIDENT_HELPERS {
                    return Err(AtCapacity::refusal());
                }
                let mut config = ComputerConfig::new(binary.clone(), key);
                config.data_dir = Some(self.data_dir.clone());
                let mut helper = ProcessComputerBackend::new(config, self.manager.clone()).with_shared(self.shared.clone()).with_observer(observer);
                if let Some(desktop) = self.desktop.get() {
                    helper = helper.with_desktop(desktop.clone());
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
        });
        Ok(Entry { process, backend, idle: None, used: Instant::now() })
    }

    /// The session's state and its (decorated) backend; a use disarms a pending idle release. A refusal for a new
    /// session when `MAX_RESIDENT_HELPERS` helper processes are live (not sessions: one that has not started a helper, or whose
    /// helper ended, takes no slot) and none could be reclaimed.
    fn entry_for(&self, session: &str) -> Result<(Process, Arc<dyn ComputerBackend>), ComputerError> {
        let key = session_key(session);
        let mut entries = self.entries();
        self.reclaim_idle(&mut entries, &key);
        if !entries.contains_key(&key) {
            let made = self.make_entry(&key)?;
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
            Process::Host(_) => Err(ComputerError::Unavailable { reason: "no helper serves this session: the desktop's computer host answers for its windows".to_owned() }),
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
        let outcomes = futures::future::join_all(bound.iter().map(|id| async move { mixdog_rt::time::timeout(SHUTDOWN_RELEASE, self.release(id)).await.unwrap_or(false) })).await;
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

/// What a session finds where no helper exists and the desktop's computer host is not attached.
fn no_host() -> ComputerError {
    ComputerError::Unavailable { reason: "computer use is unavailable: no helper is installed and no desktop serves the computer host".to_owned() }
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
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    async fn released(&self) {
        let tasks = std::mem::take(&mut *self.releases.lock().unwrap_or_else(PoisonError::into_inner));
        for task in tasks {
            mixdog_core_session::session::testing::awaiting(|| "a session's computer release to end".to_owned(), task).await.expect("a session's computer release");
        }
    }
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
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    async fn settled(&self) {
        let tasks = std::mem::take(&mut *self.settlements.lock().unwrap_or_else(PoisonError::into_inner));
        for task in tasks {
            mixdog_core_session::session::testing::awaiting(|| "a turn's computer settlement to end".to_owned(), task).await.expect("a turn's computer settlement");
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

impl ComputerSessions for ComputerSessionPool {
    fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
        match self.entry_for(session) {
            Ok((_, backend)) => backend,
            Err(refusal) => Arc::new(Refusing(refusal)),
        }
    }
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

/// The secret fill drives the helper of the thread's own session, the one state its `computer`
/// calls use (the desktop host's, where that serves the session).
impl ComputerSecretHosts for ComputerSessionPool {
    fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>> {
        Some(self.entry_for(thread.as_str()).ok()?.0.secret_host())
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

    /// The helper is the file cargo writes, which `prepare-runtime.mjs` stages under the same name
    /// (`computerNativeFileName`): `native-tools/mixdog-computer.exe` in the Windows package and
    /// `target/release/mixdog-computer.exe` in a Windows dev build, extensionless elsewhere. The
    /// other platform's name is not the helper.
    #[tokio::test]
    async fn the_computer_helper_carries_the_platforms_executable_name() {
        let tool = NativeTool::Computer;
        let (name, other) = if cfg!(windows) { ("mixdog-computer.exe", "mixdog-computer") } else { ("mixdog-computer", "mixdog-computer.exe") };
        let (package, build) = (PathBuf::from("/pkg/native-tools"), PathBuf::from("/pkg/native/mixdog-computer/target/release"));
        assert_eq!(paths(&[], &[package.join(name), build.join(name)], None).resolve(tool).await, Some(package.join(name)));
        assert_eq!(paths(&[], &[build.join(name)], None).resolve(tool).await, Some(build.join(name)));
        assert_eq!(paths(&[], &[package.join(other), build.join(other)], None).resolve(tool).await, None, "the other platform's file name is not the helper");
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

    /// A data folder for the helpers these tests start: each one makes its ledger folder there.
    fn data_dir() -> PathBuf {
        std::env::temp_dir().join("mixdog-computer-sessions-test")
    }

    /// Observation only off.
    fn settings() -> ComputerSettings {
        ComputerSettings::new(data_dir(), Arc::new(|| false))
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

    /// The `computer` section (SPEC R40) follows the sessions' open executions: the pill shows while an agent
    /// drives the desktop. An action opens a session's execution (the helper cannot start here, but the action
    /// reached it); a second session opens beside the first, not instead of it; each settled turn closes its own.
    #[tokio::test]
    async fn the_computer_section_follows_the_open_executions() {
        let published = Arc::new(Published::default());
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), published.clone(), settings()).await.expect("helper");
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
        let click = ComputerRequest { action: ComputerAction::Act, input: json!({"window_id": "w1", "delivery": "foreground", "actions": [{"type": "click", "x": 1, "y": 2}]}) };
        let running = RunningCommand::begin(&presence, "a", &click);
        let row = |presence: &ComputerPresence| presence.section(&presence.state()).sessions.remove(0);
        let shown = row(&presence);
        assert_eq!((shown.window_ids, shown.mode, shown.phase), (vec!["w1".to_owned()], Some(ComputerSessionMode::Foreground), Some("active_foreground".to_owned())));
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
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await.expect("helper");
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
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await.expect("helper");
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
        let settings = ComputerSettings::new(data_dir(), Arc::new(move || setting.load(Ordering::SeqCst)));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), published.clone(), settings).await.expect("helper");
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
        let settings = ComputerSettings::new(data_dir(), Arc::new(|| true));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings).await.expect("helper");
        let write = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"write","text":"x"}) };
        let refused = pool.backend("a").run(write, CancellationToken::new()).await;
        assert!(matches!(refused, Err(ComputerError::Failed { ref code, .. }) if code == "observation_only"), "{refused:?}");
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let read = pool.backend("a").run(read, CancellationToken::new()).await;
        assert!(!matches!(read, Err(ComputerError::Failed { ref code, .. }) if code == "observation_only"), "a read is admitted: {read:?}");
    }

    /// The sessions exist exactly when the helper does, wherever Node's order finds it.
    #[tokio::test]
    async fn the_computer_sessions_are_built_only_where_the_helper_is() {
        let tool = NativeTool::Computer;
        assert!(paths(&[], &[bundled(tool)], None).computer_sessions(manager(), plain(), quiet(), settings()).await.is_some());
        assert!(paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[PathBuf::from("/x/c")], None).computer_sessions(manager(), plain(), quiet(), settings()).await.is_some());
        assert!(paths(&[], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await.is_none());
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
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await.expect("helper");
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
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await.expect("helper");
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
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(manager(), plain(), quiet(), settings()).await.expect("helper");
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
    /// (memory, PostgreSQL) still run. The clock is paused and held, so the timeout elapses only by the test's own advance.
    #[tokio::test(start_paused = true)]
    async fn a_stuck_helper_release_ends_at_the_shutdown_timeout() {
        use mixdog_core_session::session::testing::{HeldClock, awaiting};

        let _held = HeldClock::hold();
        let stuck = Arc::new(Stuck(tokio::sync::Notify::new()));
        let pool = paths(&[("MIXDOG_COMPUTER_BIN", "/x/c")], &[], None).computer_sessions(stuck.clone(), plain(), quiet(), settings()).await.expect("helper");
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
