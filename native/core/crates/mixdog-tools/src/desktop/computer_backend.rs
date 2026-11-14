//! The real `ComputerBackend`: the `computer` tool served by the resident `mixdog-computer`
//! helper (one process per backend, one JSON request per stdin line, one `@@MIXCU@@`-prefixed
//! reply line per request, the protocol the Node desktop speaks), plus the in-process screen
//! half in `computer_screen`.
//!
//! The action contract is Node's (`computer-bridge/action-schema.mjs`): the same cross-field
//! rules, the same translation of a tool call into host commands, the same limits and the same
//! recovery on a timeout or cancellation (the helper is killed and `--abort-cleanup` releases any
//! input it held). What the Node desktop host adds on top of the helper (the permission prompt,
//! overlay, history ledger, saved-login secrets, zoom frame store) is not here;
//! those actions report `Unavailable`.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use futures::future::FutureExt;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
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
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;
use mixdog_js::utf16_len;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::Scope;
use mixdog_rt::Scoped;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::computer_gnome;
use super::computer_linux;
use super::computer_recovery::lead_code as error_code;
use super::computer_screen::Screen;
use crate::state::secrets::ComputerSecretHost;

pub(crate) const RESPONSE_MARKER: &str = "@@MIXCU@@";
/// The code of a failure whose message is the host's own reply text (`{"ok":false,…}`), which Node returns as an error result as it
/// is, with no `Error:` line and no recovery.
pub(crate) const REPORTED_CODE: &str = "computer_reported";
/// What the model reads when the helper cannot be started, in Node's words. The error rides the
/// bridge reply as is, so the text is Node's: `child_process.spawn` reports ENOENT, EACCES,
/// EAGAIN, EMFILE and ENFILE asynchronously, which `watchHostWorker` words as
/// `computer host failed to start: spawn <path> <CODE>`; any other code is thrown synchronously
/// and reaches the caller as the bare `spawn <CODE>` (no path). `None` for a refusal that is not
/// an OS spawn failure (a full queue, the process limit).
///
/// Codes: a missing program is ENOENT and a refused one EACCES (the spawn manager's own
/// classification); Windows error 193 (a file that is not an executable) is libuv's EFTYPE; any
/// other OS code libuv has no name for here is UNKNOWN.
fn node_spawn_message(binary: &Path, error: &ProcessError) -> Option<String> {
    let path = binary.display();
    match error {
        ProcessError::ProgramNotFound { .. } => Some(format!("computer host failed to start: spawn {path} ENOENT")),
        ProcessError::PermissionDenied => Some(format!("computer host failed to start: spawn {path} EACCES")),
        ProcessError::Io { os_code } => {
            let code = if cfg!(windows) && *os_code == Some(193) { "EFTYPE" } else { "UNKNOWN" };
            Some(format!("spawn {code}"))
        }
        _ => None,
    }
}

/// Per-command ceiling for one helper round trip (Node `COMMAND_TIMEOUT_MS`).
const COMMAND_TIMEOUT: Duration = Duration::from_millis(45_000);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 1_000_000;
const MAX_IMAGE_CHARS: usize = 24 * 1024 * 1024;
const DEFAULT_DELIVERY: &str = "background";
/// The session a call without one belongs to.
const DEFAULT_SESSION: &str = "default";
/// `client.mjs` `BRIDGE_UNAVAILABLE_MESSAGE`.
const BRIDGE_UNAVAILABLE_MESSAGE: &str = "computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings";
/// Process handles are unique per manager, and one manager can serve several backends.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

/// Helper actions that only read (`computerActionsWith('nativeRead')`).
const READ_ACTIONS: [&str; 19] = [
    "list_windows",
    "window_snapshot",
    "related_windows",
    "snapshot",
    "find",
    "clipboard_read",
    "wait",
    "window_bounds",
    "window_capture",
    "validate_background_input",
    "window_predicates",
    "accessibility_probe",
    "window_integrity",
    "input_recovery_state",
    "input_idle_state",
    "ocr_image",
    "ocr_status",
    "process_fate",
    "list_installed_apps",
];
/// Commands the desktop host serves as reads (`computerActionsWith('hostRead')`): withheld while a
/// secret field may be focused.
const HOST_READ_ACTIONS: [&str; 14] = [
    "list_windows",
    "snapshot",
    "find",
    "clipboard_read",
    "wait",
    "window_bounds",
    "window_predicates",
    "list_apps",
    "list_history",
    "capture",
    "screenshot",
    "zoom",
    "verify",
    "wait_for_user",
];
/// Helper actions that keep the session's element refs (`retainNativeRefs`): the reads plus
/// the ones that hand input back.
const RETAIN_REF_ACTIONS: [&str; 5] =
    ["release_session", "release_cursor_theme", "release_held_input", "release_sequence_holds", "restore_input_state"];

/// `OBSERVE_ONLY_ALLOWED_ACTIONS` (`computerActionsWith('observeOnly')`) among the commands `run` sends: the helper's and the
/// host's reads and `diagnose` (the lifecycle actions of that set never pass through `run`).
fn observe_only_admits(action: &str) -> bool {
    action == "diagnose" || READ_ACTIONS.contains(&action) || HOST_READ_ACTIONS.contains(&action)
}

/// `isObserveOnly()`: whether the desktop's "Observation only" setting (`desktop.computerObserveOnly`) is on now. The user's
/// setting, read live; not [`ComputerConfig::observe_only`], the backend's static helper flag.
pub type ObserveOnlySetting = Arc<dyn Fn() -> bool + Send + Sync>;

/// How the helper is run.
#[derive(Clone, Debug)]
pub struct ComputerConfig {
    /// The `mixdog-computer` executable.
    pub binary: PathBuf,
    /// Names the helper's per-session state (held input, element refs).
    pub session_id: String,
    /// Tags input this process injects so the helper's observer can tell it from the user's.
    pub input_marker: Option<String>,
    /// Refuse every mutation (the helper's `read_only` run). A static flag of this backend, which nothing in the core turns on;
    /// it is not the user's "Observation only" setting, which is the live [`ObserveOnlySetting`] (`with_observe_only_setting`).
    pub observe_only: bool,
    /// Pause after a background sequence step, in milliseconds.
    pub sequence_settle_ms: u64,
    /// Longest literal foreground text one call may type.
    pub max_foreground_text: usize,
}

impl ComputerConfig {
    pub fn new(binary: impl Into<PathBuf>, session_id: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            session_id: session_id.into(),
            input_marker: None,
            observe_only: false,
            sequence_settle_ms: 350,
            max_foreground_text: 4_000,
        }
    }
}

type Waiter = Box<dyn FnOnce(Result<Map<String, Value>, String>) + Send>;
type Pending = Arc<Mutex<HashMap<i64, Waiter>>>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Host {
    handle: ProcessHandle,
    pending: Pending,
    alive: Arc<AtomicBool>,
    /// Turns true once the process has exited and `pump` has failed its waiters.
    exited: watch::Receiver<bool>,
}

impl Host {
    /// Kills the helper and waits for its exit, so a cleanup run that follows starts after it.
    async fn stop(mut self, manager: &dyn ProcessManager) {
        let _ = manager.kill(&self.handle);
        let _ = self.exited.wait_for(|exited| *exited).await.is_ok();
    }
}

/// Splits the helper's stdout into lines the way `BufRead::lines` does.
#[derive(Default)]
struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    /// The lines `bytes` completes, and whether one of them was not UTF-8 (`lines()` fails
    /// there, which ends the host's output).
    fn push(&mut self, bytes: &[u8]) -> (Vec<String>, bool) {
        let mut lines = Vec::new();
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            self.partial.extend_from_slice(&rest[..at]);
            rest = &rest[at + 1..];
            if self.partial.last() == Some(&b'\r') {
                self.partial.pop();
            }
            match String::from_utf8(std::mem::take(&mut self.partial)) {
                Ok(line) => lines.push(line),
                Err(_) => return (lines, true),
            }
        }
        self.partial.extend_from_slice(rest);
        (lines, false)
    }

    /// The unterminated last line, at the end of the output.
    fn finish(&mut self) -> Option<String> {
        if self.partial.is_empty() {
            return None;
        }
        String::from_utf8(std::mem::take(&mut self.partial)).ok()
    }
}

/// Hands one output line to the request it answers.
fn deliver(pending: &Pending, line: &str) {
    let Some(body) = line.strip_prefix(RESPONSE_MARKER) else { return };
    let (id, outcome) = if body.len() > MAX_RESPONSE_BYTES {
        // Too large to trust or parse; the id is still the number after `"id":`.
        (leading_id(body), Err("computer_response_too_large: worker output exceeded byte limit".into()))
    } else {
        match serde_json::from_str::<Value>(body) {
            Ok(value) => (value.get("id").and_then(Value::as_i64), envelope(value)),
            Err(_) => return,
        }
    };
    let waiter = id.and_then(|id| locked(pending).remove(&id));
    if let Some(waiter) = waiter {
        waiter(outcome);
    }
}

/// Marks the host gone and fails every request still waiting on it.
fn fail_waiters(pending: &Pending, alive: &AtomicBool) {
    alive.store(false, Ordering::SeqCst);
    let orphans: Vec<Waiter> = locked(pending).drain().map(|(_, waiter)| waiter).collect();
    for waiter in orphans {
        waiter(Err("computer_host_exited: the computer host stopped".into()));
    }
}

/// Reads the helper's output events until it exits.
async fn pump(
    mut events: Box<dyn EventSource<ProcessEvent>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    exited: watch::Sender<bool>,
) {
    let mut lines = LineSplitter::default();
    let mut reading = true;
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } if reading => {
                let (complete, broken) = lines.push(&bytes);
                for line in complete {
                    deliver(&pending, &line);
                }
                if broken {
                    // Past a line that is not text the output is not trusted; keep draining the
                    // pipe until the process is gone.
                    reading = false;
                    fail_waiters(&pending, &alive);
                }
            }
            ProcessEvent::Output { .. } => {}
            ProcessEvent::Exited { .. } => {
                if let Some(line) = reading.then(|| lines.finish()).flatten() {
                    deliver(&pending, &line);
                }
                break;
            }
        }
    }
    fail_waiters(&pending, &alive);
    let _ = exited.send(true);
}

/// Runs a process to its exit; true when it exited with code 0 (the cleanup's confirmation).
async fn run_to_exit(manager: &dyn ProcessManager, request: SpawnRequest) -> bool {
    let handle = request.handle.clone();
    if manager.spawn(request).await.is_err() {
        return false;
    }
    let Ok(mut events) = manager.subscribe(&handle, Some(0)) else { return false };
    while let Some(event) = events.next().await {
        if let ProcessEvent::Exited { exit, .. } = event {
            return matches!(exit.status, mixdog_core_api::domain::process::ExitStatus::Code(0));
        }
    }
    false
}

pub struct ProcessComputerBackend {
    config: ComputerConfig,
    manager: Arc<dyn ProcessManager>,
    host: Mutex<Option<Host>>,
    /// One request starts the helper and is written at a time; the wait leaves on the request's cancel.
    turn: mixdog_rt::Gate,
    next_id: AtomicI64,
    screen: Screen,
    desktop: Option<Arc<dyn HostChannel>>,
    /// The Linux session the preflight reads; `None` where the platform is not Linux and nothing is probed.
    linux: Option<LinuxSession>,
    /// A typed secret's field may still hold focus: reads are refused until the next action.
    secret_focus: AtomicBool,
    /// A visible execution is open: some action ran since the last `execution_end`, abort or
    /// release (`activeComputerExecutions`, `computer-bridge/client.mjs:368`).
    executing: AtomicBool,
    /// The session reached the helper and has not been aborted or released
    /// (`hostBoundComputerSessions`, `client.mjs:367`).
    bound: AtomicBool,
    observer: Option<Arc<dyn ExecutionObserver>>,
    /// The user's "Observation only" setting (`desktop.computerObserveOnly`), read live at each action's admission and before each
    /// `act` step; `None` admits every action. Distinct from the static `config.observe_only`.
    observe_only_setting: Option<ObserveOnlySetting>,
}

/// The environment the Linux preflight reads, taken afresh for each action.
struct LinuxSession {
    env: Box<dyn Fn() -> computer_linux::Env + Send + Sync>,
}

impl LinuxSession {
    /// The machine this process runs on; no session on any other platform.
    #[cfg(not(test))]
    fn of_host() -> Option<Self> {
        cfg!(target_os = "linux").then(|| Self { env: Box::new(|| std::env::vars().collect()) })
    }

    /// A test names its platform through `with_linux_session`: the host's own would silently decide whether it runs.
    #[cfg(test)]
    fn of_host() -> Option<Self> {
        None
    }
}

/// Told when this session's visible execution opens and closes: the edges of `executing`, which the
/// computer-use pill follows (`beginCommand` / `endExecution` of Node's coordinator).
pub trait ExecutionObserver: Send + Sync {
    /// An action ran with no execution open. `observe_only` is the backend's static `ComputerConfig::observe_only`, not the
    /// user's live "Observation only" (Node's pill does not read that setting either).
    fn began(&self, observe_only: bool);
    /// The open execution ended: `execution_end`, an abort, a release or a cancelled call.
    fn ended(&self);
}

impl ProcessComputerBackend {
    /// Reports the execution's edges to `observer`.
    pub fn with_observer(mut self, observer: Arc<dyn ExecutionObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// Refuses every action but a read while `setting` reads on (the desktop's "Observation only").
    pub fn with_observe_only_setting(mut self, setting: ObserveOnlySetting) -> Self {
        self.observe_only_setting = Some(setting);
        self
    }

    /// Runs the Linux preflight against `env` whatever the platform this test runs on is.
    #[cfg(test)]
    pub(crate) fn with_linux_session(mut self, env: computer_linux::Env) -> Self {
        self.linux = Some(LinuxSession { env: Box::new(move || env.clone()) });
        self
    }

    /// The desktop whose computer host takes the screen captures and reports the displays (`host/computer/*`). Without one a
    /// capture of a screen is refused as Node's client refuses with no bridge.
    pub fn with_desktop(mut self, desktop: Arc<dyn HostChannel>) -> Self {
        self.desktop = Some(desktop);
        self
    }

    fn close_execution(&self) -> bool {
        let was_open = self.executing.swap(false, Ordering::SeqCst);
        if was_open {
            if let Some(observer) = &self.observer {
                observer.ended();
            }
        }
        was_open
    }

    /// `isObserveOnly()`: the desktop's "Observation only" as it reads now; off without a setting.
    fn observing_only(&self) -> bool {
        self.observe_only_setting.as_ref().is_some_and(|on| on())
    }

    /// `assertObservationInputAllowed` (desktop `observation-policy.ts`): while "Observation only" is on, `action` is refused in
    /// Node's words unless it is a read.
    fn assert_observation_input_allowed(&self, action: &str) -> Result<(), ComputerError> {
        if self.observing_only() && !observe_only_admits(action) {
            return Err(ComputerError::Failed {
                code: "observation_only".into(),
                message: format!("observation_only: Computer Use is observing only, so '{action}' input is blocked. Turn off \"Observation only\" in Settings to allow input."),
            });
        }
        Ok(())
    }

    /// The helper runs under `manager`; it starts on the first action and restarts after a
    /// timeout or cancellation.
    pub fn new(config: ComputerConfig, manager: Arc<dyn ProcessManager>) -> Self {
        Self {
            observer: None,
            config,
            manager,
            host: Mutex::new(None),
            turn: mixdog_rt::Gate::new(),
            next_id: AtomicI64::new(1),
            screen: Screen::default(),
            desktop: None,
            linux: LinuxSession::of_host(),
            secret_focus: AtomicBool::new(false),
            executing: AtomicBool::new(false),
            bound: AtomicBool::new(false),
            observe_only_setting: None,
        }
    }

    /// Whether the session reached the helper and still owns state there.
    pub fn is_bound(&self) -> bool {
        self.bound.load(Ordering::SeqCst)
    }

    /// `session_abort` (`abortComputerSession`, `client.mjs:490-499`; the host side
    /// `lifecycle-abort.ts:runAbortCleanup`): the helper is stopped and a fresh `--abort-cleanup`
    /// process releases the input it held. True once the cleanup confirmed (exit 0); then the
    /// session no longer owns state in the helper. A cancelled `computer` call does this itself.
    pub async fn abort_session(&self) -> bool {
        self.close_execution();
        let confirmed = self.retire().await;
        if confirmed {
            self.bound.store(false, Ordering::SeqCst);
        }
        confirmed
    }

    /// `execution_end` (`endComputerExecution`, `client.mjs:505-512`; the host side
    /// `session-lifecycle.ts:endComputerExecution`) at a turn's settlement: held keys and buttons
    /// go up (`release_held_input`) while the helper and its element refs stay warm for a
    /// follow-up turn. Sent only when an execution is open. A release the helper cannot confirm
    /// ends the session instead (`session-lifecycle.ts` `confirmed === false`). False when there
    /// was nothing to end or the fallback abort did not confirm.
    pub async fn end_execution(&self) -> bool {
        if !self.close_execution() {
            return false;
        }
        if !locked(&self.host).as_ref().is_some_and(|host| host.alive.load(Ordering::SeqCst)) {
            return true;
        }
        let mut command = Map::new();
        command.insert("action".into(), json!("release_held_input"));
        match self.call(command, &CancellationToken::new()).await {
            Ok(_) => true,
            Err(_) => self.abort_session().await,
        }
    }

    /// `session_release` (`releaseComputerSession`, `lifecycle-abort.ts:releaseComputerSession`):
    /// a live helper first drops the session's refs, restores its focus and lets go of held input
    /// (`release_session`), then the session is aborted whatever that answered.
    pub async fn release_session(&self) -> bool {
        let mut released = true;
        if locked(&self.host).as_ref().is_some_and(|host| host.alive.load(Ordering::SeqCst)) {
            let mut command = Map::new();
            command.insert("action".into(), json!("release_session"));
            released = self.call(command, &CancellationToken::new()).await.is_ok();
        }
        self.abort_session().await && released
    }

    /// A run of the helper with `args`; it reads requests from stdin when `stdin_piped`.
    fn request(&self, args: Vec<String>, stdin_piped: bool) -> Result<SpawnRequest, ComputerError> {
        let cwd = std::env::current_dir().ok().and_then(AbsPath::new).ok_or_else(|| ComputerError::Unavailable {
            reason: "computer_backend_unavailable: the working directory is unreadable".into(),
        })?;
        let mut set = vec![
            ("MIXDOG_COMPUTER_READ_ACTIONS".to_owned(), READ_ACTIONS.join(",")),
            (
                "MIXDOG_COMPUTER_RETAIN_REF_ACTIONS".to_owned(),
                READ_ACTIONS.iter().chain(RETAIN_REF_ACTIONS.iter()).copied().collect::<Vec<_>>().join(","),
            ),
            ("MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS".to_owned(), self.config.sequence_settle_ms.to_string()),
            ("MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT".to_owned(), self.config.max_foreground_text.to_string()),
        ];
        if let Some(marker) = &self.config.input_marker {
            set.push(("MIXDOG_COMPUTER_INPUT_MARKER".to_owned(), marker.clone()));
        }
        Ok(SpawnRequest {
            handle: ProcessHandle(format!("computer-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::SeqCst))),
            command: CommandSpec::Argv { program: self.config.binary.to_string_lossy().into_owned(), args },
            cwd,
            env: EnvSpec { inherit: true, set, remove: Vec::new() },
            pty: None,
            stdin_piped,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: None,
        })
    }

    async fn spawn(&self) -> Result<Host, ComputerError> {
        let unavailable = |error: String| ComputerError::Unavailable {
            reason: format!("computer_backend_unavailable: cannot start {}: {error}", self.config.binary.display()),
        };
        let request = self.request(Vec::new(), true)?;
        let handle = request.handle.clone();
        self.manager.spawn(request).await.map_err(|error| match node_spawn_message(&self.config.binary, &error) {
            Some(text) => ComputerError::Unavailable { reason: text },
            None => unavailable(format!("{error:?}")),
        })?;
        let events = match self.manager.subscribe(&handle, Some(0)) {
            Ok(events) => events,
            Err(error) => {
                let _ = self.manager.kill(&handle);
                return Err(unavailable(format!("{error:?}")));
            }
        };
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (done, exited) = watch::channel(false);
        tokio::spawn(pump(events, pending.clone(), alive.clone(), done));
        Ok(Host { handle, pending, alive, exited })
    }

    /// Writes one request and returns the channel its reply arrives on.
    async fn send(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<oneshot::Receiver<Result<Map<String, Value>, String>>, ComputerError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        command.insert("id".into(), json!(id));
        command.entry("session_id").or_insert_with(|| json!(self.config.session_id));
        if self.config.observe_only {
            command.insert("read_only".into(), json!(true));
        }
        let line = Value::Object(command).to_string();
        if line.len() > MAX_REQUEST_BYTES {
            return Err(ComputerError::InvalidInput {
                reason: "computer request exceeds byte limit; no input was dispatched".into(),
            });
        }
        let (reply, receive) = oneshot::channel();
        let _turn = self.turn.enter(cancel).await.map_err(|_| ComputerError::Cancelled)?;
        let live = locked(&self.host)
            .as_ref()
            .filter(|host| host.alive.load(Ordering::SeqCst))
            .map(|host| (host.handle.clone(), host.pending.clone()));
        let (handle, pending) = match live {
            Some(live) => live,
            None => {
                let dead = locked(&self.host).take();
                if let Some(dead) = dead {
                    dead.stop(&*self.manager).await;
                }
                let host = self.spawn().await?;
                let live = (host.handle.clone(), host.pending.clone());
                *locked(&self.host) = Some(host);
                live
            }
        };
        locked(&pending).insert(id, Box::new(move |outcome| drop(reply.send(outcome))));
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        if let Err(error) = self.manager.write_stdin(&handle, bytes).await {
            locked(&pending).remove(&id);
            let broken = locked(&self.host).take();
            if let Some(broken) = broken {
                broken.stop(&*self.manager).await;
            }
            return Err(ComputerError::Failed {
                code: "computer_host_write_failed".into(),
                message: format!("the computer host did not take the request: {error:?}"),
            });
        }
        Ok(receive)
    }

    /// Stops the helper and releases whatever input it held, from a fresh process. True when that
    /// cleanup confirmed.
    async fn retire(&self) -> bool {
        let host = locked(&self.host).take();
        if let Some(host) = host {
            host.stop(&*self.manager).await;
        }
        match self.request(vec!["--abort-cleanup".to_owned()], false) {
            Ok(request) => run_to_exit(&*self.manager, request).await,
            Err(_) => false,
        }
    }

    async fn call(&self, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        if cancel.is_cancelled() {
            return Err(ComputerError::Cancelled);
        }
        let receive = self.send(command, cancel).await?;
        self.wait_reply(receive, cancel).await
    }

    /// The reply of a sent command, within `COMMAND_TIMEOUT` and the request's cancel. Either
    /// one ending the wait retires the helper: a command it may still be running holds input.
    async fn wait_reply(
        &self,
        receive: oneshot::Receiver<Result<Map<String, Value>, String>>,
        cancel: &CancellationToken,
    ) -> Result<Map<String, Value>, ComputerError> {
        let scope = Scope::new().cancel(cancel).deadline(Some(Instant::now() + COMMAND_TIMEOUT));
        match scope.run(receive).await {
            Scoped::Cancelled => {
                // Node aborts the session when a call is cancelled (`client.mjs:113,407`).
                self.abort_session().await;
                Err(ComputerError::Cancelled)
            }
            Scoped::DeadlineExceeded => {
                self.retire().await;
                Err(ComputerError::Failed {
                    code: "computer_command_timeout".into(),
                    message: format!("computer_command_timeout: command exceeded {}ms; the input host was restarted", COMMAND_TIMEOUT.as_millis()),
                })
            }
            Scoped::Done(Err(_)) => Err(host_exited()),
            Scoped::Done(Ok(Err(message))) => Err(host_error(&message)),
            Scoped::Done(Ok(Ok(result))) => Ok(result),
        }
    }

    async fn act(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let steps = match command.shift_remove("steps") {
            Some(Value::Array(steps)) => steps,
            _ => Vec::new(),
        };
        let delivery = command.get("delivery").and_then(Value::as_str).unwrap_or(DEFAULT_DELIVERY).to_string();
        let observe = command.shift_remove("capture_after_mode");
        let target: Map<String, Value> =
            ["window_id", "app"].iter().filter_map(|key| command.get(*key).map(|v| ((*key).to_string(), v.clone()))).collect();
        let mut messages = Vec::new();
        for step in steps {
            let Value::Object(mut step) = step else { continue };
            // Node runs every step back through admission and checks again right before each input transport
            // (`input-dispatch.ts`): "Observation only" turned on mid-sequence stops the steps left. Node reports the refused
            // step as a failed row; here, as for any failed step, the error ends the call.
            self.assert_observation_input_allowed(text(&step, "action"))?;
            for (key, value) in &target {
                step.entry(key.clone()).or_insert_with(|| value.clone());
            }
            step.insert("delivery".into(), json!(delivery));
            step.insert("session_id".into(), json!(self.config.session_id));
            // A background step on an exact window goes through the helper's sequence step,
            // which reports the windows it opened or closed; everything else is the action itself.
            let request = if delivery == "background" && step.contains_key("window_id") {
                let mut request = Map::new();
                request.insert("action".into(), json!("sequence_step"));
                request.insert("delivery".into(), json!("background"));
                request.insert("step".into(), Value::Object(step));
                request
            } else {
                step
            };
            let result = self.call(request, cancel).await?;
            let inner = result.get("step_result").and_then(Value::as_object).unwrap_or(&result);
            messages.push(text_of(inner));
        }
        let mut payload = json!({
            "ok": true,
            "action": "act",
            "message": messages.join("; "),
            "goal_verified": false,
            "verdict": { "decision": "verify_fresh_state" },
        });
        let mut parts = Vec::new();
        if target.contains_key("window_id") || target.contains_key("app") {
            let mut capture = Map::new();
            capture.insert("action".into(), json!("capture"));
            capture.extend(target);
            if let Some(mode) = observe {
                capture.insert("mode".into(), mode);
            }
            payload["capture_after"] = json!({ "ok": true, "action": "capture" });
            let observed = self.capture(capture, "", cancel).await?;
            parts.push(ToolPart::Text(payload.to_string()));
            parts.extend(observed);
            return Ok(parts);
        }
        parts.push(ToolPart::Text(payload.to_string()));
        Ok(parts)
    }

    /// A read the Node desktop host makes of the helper (`callPowerShell` with `read_only`): under `session`, or the backend's own.
    async fn host_read(&self, action: &str, extra: Vec<(&str, Value)>, session: Option<&str>, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        let mut command = Map::new();
        command.insert("action".into(), json!(action));
        for (key, value) in extra {
            command.insert(key.into(), value);
        }
        if let Some(session) = session {
            command.insert("session_id".into(), json!(session));
        }
        command.insert("read_only".into(), json!(true));
        command.insert("pointer_feedback".into(), json!(false));
        self.call(command, cancel).await
    }

    /// Every command of the host starts with a read of the windows through its arrivals worker; the answer is not used here.
    async fn peek_arrivals(&self, cancel: &CancellationToken) -> Result<(), ComputerError> {
        match self.host_read("window_snapshot", Vec::new(), Some(computer_gnome::ARRIVALS_SESSION_ID), cancel).await {
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            _ => Ok(()),
        }
    }

    /// The desktop that serves the computer host's reads, or Node's refusal when none does (`client.mjs` `BRIDGE_UNAVAILABLE_MESSAGE`).
    fn desktop(&self) -> Result<&Arc<dyn HostChannel>, ComputerError> {
        match &self.desktop {
            Some(desktop) if desktop.serves(HostCapability::Computer) => Ok(desktop),
            _ => Err(bridge_unavailable()),
        }
    }

    /// One `host/computer/*` request to the desktop's computer host. The host's refusal is the text Node's client gives for a bridge
    /// reply of `{ ok: false, error }`; a request that outlives the client's timeout is `computer bridge timed out`.
    async fn ask_desktop(&self, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, ComputerError> {
        let desktop = self.desktop()?;
        match desktop.request_scoped(HostCapability::Computer, Method(method), params, cancel).await {
            Ok(value) => Ok(value),
            Err(_) if cancel.is_cancelled() => Err(ComputerError::Cancelled),
            Err(HostError::Rpc { message, .. }) => Err(host_error(&message)),
            Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if &*detail == "timedOut" => {
                Err(ComputerError::Failed { code: REPORTED_CODE.into(), message: "Error: computer bridge timed out".into() })
            }
            Err(HostError::Core(_)) => Err(bridge_unavailable()),
        }
    }

    /// The capture of a screen: the command Node's client posts to the bridge goes to the desktop's computer host
    /// (`host/computer/capture`), which takes the pixels, fits them to the capture budget and encodes them; the reply is the one the
    /// tool returns.
    ///
    /// `asked_mode` is the call's own `mode`: the reply text carries it (`args.input?.mode || 'state'`), not the one a Linux fallback rewrote.
    async fn capture_screen(&self, command: &Map<String, Value>, asked_mode: &str, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let mode = if asked_mode.is_empty() { "state" } else { asked_mode };
        let mut posted = command.clone();
        // A call without a session sends none (the pool names it `default`).
        if self.config.session_id != DEFAULT_SESSION {
            posted.insert("session_id".into(), json!(self.config.session_id));
        }
        let reply = self.ask_desktop("host/computer/capture", json!({ "command": posted }), cancel).await?;
        screen_parts(&reply, mode)
    }

    /// `diagnose` on a Linux session: the host's report of the windows, accessibility, OCR, input observation, displays and the
    /// probed capabilities (`inspect.ts` `diagnoseComputer`).
    async fn diagnose(&self, linux: &LinuxSession, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        self.peek_arrivals(cancel).await?;
        let probe = |outcome: Result<Map<String, Value>, ComputerError>| match outcome {
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            Err(ComputerError::Failed { message, .. }) => Ok(Err(message)),
            Err(other) => Ok(Err(format!("{other:?}"))),
            Ok(result) => Ok(Ok(result)),
        };
        let windows = match self.host_read("list_windows", Vec::new(), None, cancel).await {
            Ok(result) => Some(computer_gnome::window_rows(&result)),
            Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
            Err(_) => None,
        };
        let requested = text(command, "window_id").to_owned();
        let target = match &windows {
            Some(windows) if requested.is_empty() => windows.iter().find(|window| window.focused),
            Some(windows) => windows.iter().find(|window| window.id == requested),
            None => None,
        };
        let accessibility = match target {
            Some(target) => Some(probe(self.host_read("accessibility_probe", vec![("window_id", json!(target.id))], None, cancel).await)?),
            None => None,
        };
        let ocr_language = command.get("ocr_language").and_then(Value::as_str);
        let ocr = probe(self.host_read("ocr_status", vec![("ocr_language", json!(ocr_language))], None, cancel).await)?;
        let input = probe(self.host_read("input_idle_state", Vec::new(), None, cancel).await)?;
        let readiness = computer_gnome::readiness(self.manager.clone(), (linux.env)()).await;
        let displays = self.ask_desktop("host/computer/displays", json!({}), cancel).await?;
        let report = computer_gnome::Diagnosis {
            requested_window_id: &requested,
            ocr_language,
            windows,
            accessibility,
            ocr,
            input,
            displays: &displays,
            readiness: &readiness,
            // `observeOnly: isObserveOnly()`: the report's input_mode is the live setting's.
            observe_only: self.config.observe_only || self.observing_only(),
        };
        Ok(vec![ToolPart::Text(computer_gnome::diagnose_text(&report))])
    }

    /// `capture`: the accessibility snapshot, plus the window's pixels unless the mode is `ax`.
    async fn capture(&self, mut command: Map<String, Value>, asked_mode: &str, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        if command.contains_key("screen") {
            return self.capture_screen(&command, asked_mode, cancel).await;
        }
        let mode = command.shift_remove("mode").and_then(|mode| mode.as_str().map(str::to_string)).unwrap_or_else(|| "state".into());
        let mut parts = Vec::new();
        let mut window = command.get("window_id").cloned();
        if mode != "vision" {
            command.insert("action".into(), json!("snapshot"));
            let snapshot = self.call(command.clone(), cancel).await?;
            window = snapshot.get("window_id").cloned().or(window);
            parts.extend(parts_of(&snapshot)?);
        }
        if mode != "ax" {
            command.insert("action".into(), json!("window_capture"));
            if let Some(window) = window {
                command.insert("window_id".into(), window);
                command.shift_remove("app");
            }
            let image = self.call(command, cancel).await?;
            let mut image_parts = parts_of(&image)?;
            if mode != "vision" {
                image_parts.retain(|part| matches!(part, ToolPart::Image { .. }));
            }
            parts.extend(image_parts);
        }
        Ok(parts)
    }
}

impl Drop for ProcessComputerBackend {
    fn drop(&mut self) {
        let held = locked(&self.host).take();
        let Some(host) = held else { return };
        let manager = self.manager.clone();
        let cleanup = self.request(vec!["--abort-cleanup".to_owned()], false).ok();
        // A drop cannot await: the stop and the cleanup run on the runtime, if there is one.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    host.stop(&*manager).await;
                    if let Some(request) = cleanup {
                        run_to_exit(&*manager, request).await;
                    }
                });
            }
            Err(_) => {
                let _ = manager.kill(&host.handle);
            }
        }
    }
}

fn leading_id(body: &str) -> Option<i64> {
    let rest = body.split("\"id\":").nth(1)?;
    js_trim_start(rest).split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// A reply envelope: its `result` object, or its `error` text.
fn envelope(value: Value) -> Result<Map<String, Value>, String> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(value.get("error").and_then(Value::as_str).unwrap_or("computer host request failed").to_string());
    }
    match value {
        Value::Object(mut object) => match object.shift_remove("result") {
            Some(Value::Object(result)) => Ok(result),
            _ => Ok(Map::new()),
        },
        _ => Ok(Map::new()),
    }
}

/// What Node's client answers when no desktop publishes the bridge: an error result of its own, with no recovery.
fn bridge_unavailable() -> ComputerError {
    ComputerError::Failed { code: REPORTED_CODE.into(), message: format!("Error: {BRIDGE_UNAVAILABLE_MESSAGE}") }
}

/// A screen capture's reply as the tool returns it (`computerToolResult`): the reply text in its canonical form, the image with the
/// size that text reports, and an error result when the text says the capture failed.
fn screen_parts(reply: &Value, mode: &str) -> Result<Vec<ToolPart>, ComputerError> {
    let Value::Object(reply) = reply else {
        return Err(ComputerError::Failed { code: "computer_invalid_reply".into(), message: "computer bridge returned invalid or oversized text".into() });
    };
    let mut parts = parts_of(reply)?;
    let raw = match &parts[0] {
        ToolPart::Text(text) if !text.is_empty() => text.clone(),
        _ => "OK".to_owned(),
    };
    let text = canonical_capture_text(&raw, mode);
    let size = reported_size(&text);
    if let Some(ToolPart::Image { width, height, .. }) = parts.get_mut(1) {
        (*width, *height) = size.map_or((None, None), |(w, h)| (Some(w), Some(h)));
    }
    // The host's own flag counts on its own, as in `computerToolResult`.
    if reply.get("isError") == Some(&json!(true)) || capture_failed(&text) {
        return Err(ComputerError::Failed { code: REPORTED_CODE.into(), message: text });
    }
    parts[0] = ToolPart::Text(text);
    Ok(parts)
}

/// `canonicalComputerResultText` for a capture (`result-canonical.mjs`): the action and mode are the call's, and the host's own
/// diagnostics stay out of what the model reads. A screen capture has no elements or OCR lines to render.
fn canonical_capture_text(text: &str, mode: &str) -> String {
    let Ok(Value::Object(mut value)) = serde_json::from_str::<Value>(text) else { return text.to_owned() };
    if !value.get("action").is_some_and(Value::is_string) {
        return text.to_owned();
    }
    value.insert("action".into(), json!("capture"));
    value.insert("mode".into(), json!(mode));
    let mut value = Value::Object(value);
    drop_host_diagnostics(&mut value);
    value.to_string()
}

fn drop_host_diagnostics(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(drop_host_diagnostics),
        Value::Object(fields) => {
            for field in ["timings_ms", "capture_attempts"] {
                fields.shift_remove(field);
            }
            fields.values_mut().for_each(drop_host_diagnostics);
        }
        _ => {}
    }
}

/// `computerImageDimensions`: the frame's real size, from the text's `width` and `height` (or its `observation`'s).
fn reported_size(text: &str) -> Option<(u32, u32)> {
    let value: Value = serde_json::from_str(text).ok()?;
    [Some(&value), value.get("observation")].into_iter().flatten().find_map(|frame| {
        let edge = |key: &str| frame.get(key).and_then(Value::as_f64).filter(|edge| *edge > 0.0 && edge.is_finite());
        Some((edge("width")? as u32, edge("height")? as u32))
    })
}

/// `canonicalComputerResultIsError` for a capture.
fn capture_failed(text: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|value| value.get("action") == Some(&json!("capture")) && value.get("ok") == Some(&json!(false)))
}

fn host_exited() -> ComputerError {
    ComputerError::Failed { code: "computer_host_exited".into(), message: "the computer host stopped".into() }
}

fn unsupported(reason: &str) -> ComputerError {
    ComputerError::Unavailable { reason: reason.into() }
}

fn host_error(message: &str) -> ComputerError {
    let code = error_code(message);
    ComputerError::Failed { code: if code.is_empty() { "computer_failed".into() } else { code }, message: message.to_string() }
}

fn text_of(result: &Map<String, Value>) -> String {
    match result.get("text") {
        Some(Value::String(text)) => text.clone(),
        _ => "OK".into(),
    }
}

/// Tool parts of one helper result: its text, and its image when it carries one
/// (`validateComputerReply` bounds both).
fn parts_of(result: &Map<String, Value>) -> Result<Vec<ToolPart>, ComputerError> {
    let invalid = |reason: &str| ComputerError::Failed { code: "computer_invalid_reply".into(), message: reason.into() };
    let text = text_of(result);
    if utf16_len(&text) > MAX_TEXT_CHARS {
        return Err(invalid("computer bridge returned invalid or oversized text"));
    }
    let mut parts = vec![ToolPart::Text(text)];
    let image = match (result.get("image_base64"), result.get("image")) {
        (Some(Value::String(data)), _) => Some(("image/png", data.as_str())),
        (_, Some(Value::Object(image))) => match (image.get("mimeType").and_then(Value::as_str), image.get("data").and_then(Value::as_str)) {
            (Some(mime @ ("image/png" | "image/jpeg")), Some(data)) => Some((mime, data)),
            _ => return Err(invalid("computer bridge returned an invalid or oversized image")),
        },
        _ => None,
    };
    if let Some((mime, data)) = image {
        if data.len() > MAX_IMAGE_CHARS {
            return Err(invalid("computer bridge returned an invalid or oversized image"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| invalid("computer bridge returned an invalid or oversized image"))?;
        parts.push(ToolPart::Image { mime: mime.into(), data: ImageData::Bytes(bytes), width: None, height: None });
    }
    Ok(parts)
}

// --- the tool contract (`computer-bridge/action-schema.mjs`) --------------------------------

fn has(input: &Map<String, Value>, key: &str) -> bool {
    input.contains_key(key)
}

fn text<'a>(input: &'a Map<String, Value>, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The rules beyond the tool's JSON schema (`validateComputerToolArgs`, minus the schema
/// itself and the per-step rules of `act.actions`, which the helper enforces on each step).
fn validate(action: ComputerAction, input: &Map<String, Value>) -> Result<(), String> {
    let name = action.wire_name();
    for field in ["window_id", "app", "frame_id"] {
        if let Some(Value::String(value)) = input.get(field)
            && js_trim(value).is_empty()
        {
            return Err(format!("Computer Use {name} {field} must not be empty"));
        }
    }
    if matches!(action, ComputerAction::Act | ComputerAction::Window | ComputerAction::Menu | ComputerAction::Verify | ComputerAction::SavedLogin)
        && ["window_id", "app"].iter().filter(|key| has(input, key)).count() != 1
    {
        return Err(format!("Computer Use {name} requires exactly one of window_id or app"));
    }
    match action {
        ComputerAction::Capture => capture_error(input),
        ComputerAction::List => list_error(input),
        ComputerAction::Menu => menu_error(input),
        ComputerAction::Verify => verify_error(input),
        ComputerAction::Act => {
            if input.get("actions").and_then(Value::as_array).is_none_or(Vec::is_empty) {
                Err("Computer Use action \"act\" requires input field(s): actions".into())
            } else {
                Ok(())
            }
        }
        ComputerAction::Window => window_error(input),
        ComputerAction::Clipboard => clipboard_error(input),
        ComputerAction::Launch => launch_error(input),
        ComputerAction::SavedLogin => saved_login_error(input),
        ComputerAction::Diagnose | ComputerAction::WaitForUser => Ok(()),
    }
}

fn capture_error(input: &Map<String, Value>) -> Result<(), String> {
    let mode = input.get("mode").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("state");
    let targets = ["window_id", "app", "screen"].iter().filter(|key| has(input, key)).count();
    let include_ocr = input.get("include_ocr") == Some(&Value::Bool(true));
    let err = |message: &str| Err(format!("Computer Use {message}"));
    if targets > 1 {
        return err("capture accepts at most one of window_id, app, or screen");
    }
    if mode == "zoom" && (!has(input, "frame_id") || !has(input, "region")) {
        return err("capture mode=\"zoom\" requires input field(s): frame_id, region");
    }
    if mode == "zoom" && targets > 0 {
        return err("capture mode=\"zoom\" accepts frame_id and region instead of a window, app, or screen target");
    }
    if mode != "zoom" && (has(input, "frame_id") || has(input, "region")) {
        return err("capture frame_id/region requires mode=\"zoom\"");
    }
    if mode == "ax" && include_ocr {
        return err("capture include_ocr is unavailable with mode=\"ax\"");
    }
    if mode == "zoom" && has(input, "ocr_language") && !include_ocr {
        return err("capture mode=\"zoom\" reads text only with include_ocr");
    }
    if mode == "ax" && has(input, "image_output") {
        return err("capture image_output requires a mode that returns pixels");
    }
    if has(input, "screen") && mode != "vision" {
        return err("capture screen requires mode=\"vision\"");
    }
    Ok(())
}

fn list_error(input: &Map<String, Value>) -> Result<(), String> {
    let history = text(input, "kind") == "history";
    if has(input, "limit") && !history {
        return Err("Computer Use list limit applies to kind=\"history\"".into());
    }
    if has(input, "query") && history {
        return Err("Computer Use list query applies to kind=\"windows\" or kind=\"apps\"".into());
    }
    Ok(())
}

fn menu_error(input: &Map<String, Value>) -> Result<(), String> {
    let bad = input
        .get("path")
        .and_then(Value::as_array)
        .is_some_and(|path| path.iter().any(|segment| segment.as_str().is_none_or(|s| js_trim(s).is_empty())));
    if bad { Err("Computer Use menu path segments must be non-empty labels".into()) } else { Ok(()) }
}

fn verify_error(input: &Map<String, Value>) -> Result<(), String> {
    const ALLOWED: [&str; 4] = ["present", "absent", "title_contains", "window_exists"];
    for (index, predicate) in input.get("expect").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let n = index + 1;
        let Some(predicate) = predicate.as_object() else {
            return Err(format!("Computer Use verify predicate {n} must be an object"));
        };
        let extras: Vec<&str> = predicate.keys().map(String::as_str).filter(|k| !ALLOWED.contains(k)).collect();
        if !extras.is_empty() {
            return Err(format!("Computer Use verify predicate {n} does not accept field(s): {}", extras.join(", ")));
        }
        if predicate.len() != 1 {
            return Err(format!("Computer Use verify predicate {n} takes exactly one condition"));
        }
        let (key, value) = predicate.iter().next().ok_or_else(|| format!("Computer Use verify predicate {n} takes exactly one condition"))?;
        if key == "window_exists" {
            if !value.is_boolean() {
                return Err(format!("Computer Use verify predicate {n} window_exists must be a boolean"));
            }
        } else {
            let Some(value) = value.as_str() else {
                return Err(format!("Computer Use verify predicate {n} text must be a string"));
            };
            if js_trim(value).is_empty() {
                return Err(format!("Computer Use verify predicate {n} text must not be empty"));
            }
        }
    }
    Ok(())
}

fn window_error(input: &Map<String, Value>) -> Result<(), String> {
    if text(input, "operation") == "move" && !["x", "y", "width", "height"].iter().any(|key| has(input, key)) {
        return Err("Computer Use window operation=\"move\" requires x, y, width, or height".into());
    }
    Ok(())
}

fn clipboard_error(input: &Map<String, Value>) -> Result<(), String> {
    match text(input, "operation") {
        "write" if !has(input, "text") => Err("Computer Use clipboard operation=\"write\" requires input field: text".into()),
        "read" if has(input, "text") => Err("Computer Use clipboard operation=\"read\" does not accept input field: text".into()),
        _ => Ok(()),
    }
}

fn launch_error(input: &Map<String, Value>) -> Result<(), String> {
    let app = match input.get("app") {
        Some(Value::String(app)) => js_trim(app).to_string(),
        _ => String::new(),
    };
    if app.is_empty() {
        return Err("Computer Use launch app must not be empty".into());
    }
    let compile = |pattern: &str, flags: &str| JsRegex::new(pattern, flags);
    let http = compile(r"^https?://", "i")?.is_match(&app);
    if compile(r"[\r\n\0]|javascript:", "i")?.is_match(&app) || (!http && compile(r"&&|\|\|", "")?.is_match(&app)) {
        return Err("Computer Use launch app must be one executable, file, or URL without command syntax".into());
    }
    if !http
        && (compile(r#"(?:^|[\\/"'])\s*(?:cmd|powershell|pwsh|wt|wsl|bash|sh|zsh|fish|nu|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?(?:["'\s]|$)"#, "i")?
            .is_match(&app)
            || compile(r#"\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|appref-ms)(?:["']?\s*)$"#, "i")?.is_match(&app))
    {
        return Err("Computer Use launch blocks shells, script hosts, and shortcut files; use an exact non-shell executable, document, or URL".into());
    }
    Ok(())
}

fn saved_login_error(input: &Map<String, Value>) -> Result<(), String> {
    if js_trim(&text(input, "savedAccount")).is_empty() {
        return Err("Computer Use saved_login savedAccount must not be empty".into());
    }
    Ok(())
}

/// One `act.actions` entry as the host sequence step it becomes (`toHostSequenceStep`).
fn host_step(step: &Value, frame_id: Option<&Value>) -> Value {
    let Some(step) = step.as_object() else { return step.clone() };
    let mut out = step.clone();
    let kind = out.shift_remove("type").unwrap_or(Value::Null);
    let mut action = kind.clone();
    match kind.as_str() {
        Some("click") => {
            action = match text(step, "button") {
                "right" => json!("right_click"),
                "middle" => json!("middle_click"),
                _ => json!("click"),
            };
            out.shift_remove("button");
        }
        Some("move") => action = json!("mouse_move"),
        Some("set_value") => {
            if let Some(value) = out.shift_remove("value") {
                out.insert("text".into(), value);
            }
        }
        _ => {}
    }
    out.insert("action".into(), action);
    if let Some(frame) = frame_id
        && ["x", "y", "to_x", "to_y", "waypoints"].iter().any(|key| has(step, key))
    {
        out.insert("frame_id".into(), frame.clone());
    }
    Value::Object(out)
}

/// The helper command a tool call becomes (`toComputerHostCommand`).
fn host_command(action: ComputerAction, input: &Map<String, Value>) -> Map<String, Value> {
    let mut command = input.clone();
    let set = |command: &mut Map<String, Value>, name: &str| {
        command.insert("action".into(), json!(name));
    };
    match action {
        ComputerAction::List => {
            let name = match text(input, "kind") {
                "apps" => "list_apps",
                "history" => "list_history",
                _ => "list_windows",
            };
            set(&mut command, name);
            command.shift_remove("kind");
        }
        ComputerAction::Capture => {
            if text(input, "mode") == "zoom" {
                set(&mut command, "zoom");
                command.shift_remove("mode");
            } else {
                set(&mut command, "capture");
            }
        }
        ComputerAction::Menu => set(&mut command, "invoke_menu"),
        ComputerAction::Act => {
            set(&mut command, "sequence");
            let delivery = input.get("delivery").cloned().unwrap_or_else(|| json!(DEFAULT_DELIVERY));
            command.insert("delivery".into(), delivery);
            let frame = input.get("frame_id").filter(|frame| frame.as_str().is_none_or(|f| !f.is_empty()));
            let steps: Vec<Value> = input.get("actions").and_then(Value::as_array).into_iter().flatten().map(|step| host_step(step, frame)).collect();
            command.insert("steps".into(), Value::Array(steps));
            if let Some(mode) = input.get("observe").filter(|m| m.as_str().is_none_or(|m| !m.is_empty())) {
                command.insert("capture_after_mode".into(), mode.clone());
            }
            for key in ["observe", "actions", "frame_id"] {
                command.shift_remove(key);
            }
        }
        ComputerAction::Window => {
            let operation = text(input, "operation");
            let name = match operation {
                "focus" => "focus_window",
                "move" => "move_window",
                "close" => "close_window",
                "terminate" => "terminate_process",
                _ => {
                    command.insert("state".into(), json!(operation));
                    "window_state"
                }
            };
            set(&mut command, name);
            command.shift_remove("operation");
        }
        ComputerAction::Clipboard => {
            set(&mut command, if text(input, "operation") == "write" { "clipboard_write" } else { "clipboard_read" });
            command.shift_remove("operation");
        }
        ComputerAction::SavedLogin => {
            set(&mut command, "fill_saved_login");
            if let Some(account) = command.shift_remove("savedAccount") {
                command.insert("saved_account".into(), account);
            }
            command.insert("delivery".into(), json!("foreground"));
        }
        other => set(&mut command, other.wire_name()),
    }
    command
}

#[async_trait]
impl ComputerSecretHost for ProcessComputerBackend {
    async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
        // A handoff secret is typed through the host's router, which refuses input while "Observation only" is on (`find` is a read).
        if let Err(ComputerError::Failed { message, .. }) = self.assert_observation_input_allowed(text(&command, "action")) {
            return Err(message);
        }
        self.call(command, &CancellationToken::new()).await.map_err(|error| match error {
            ComputerError::Failed { message, .. } => message,
            ComputerError::Unavailable { reason } | ComputerError::InvalidInput { reason } => reason,
            ComputerError::Denied => "denied".to_owned(),
            ComputerError::Cancelled => "cancelled".to_owned(),
        })
    }

    fn arm_focus(&self) {
        self.secret_focus.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl ComputerBackend for ProcessComputerBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        // Node's client reads the bridge's discovery file before it validates, probes or dispatches anything; the calls that
        // end at the desktop's computer host (a capture of a screen, the Linux diagnose with its displays) are refused first here too.
        let reads_desktop = match request.action {
            ComputerAction::Capture => request.input.get("screen").is_some(),
            ComputerAction::Diagnose => self.linux.is_some(),
            _ => false,
        };
        if reads_desktop {
            self.desktop()?;
        }
        let Some(input) = request.input.as_object() else {
            return Err(ComputerError::InvalidInput {
                reason: format!("Computer Use action \"{}\" input must be an object", request.action.wire_name()),
            });
        };
        validate(request.action, input).map_err(|reason| ComputerError::InvalidInput { reason })?;
        let asked_mode = text(input, "mode");
        let mut command = host_command(request.action, input);
        // On Linux a default capture without window control becomes a full-screen capture, and an action whose own capability
        // (input device, window control, AT-SPI, ...) is missing is refused before anything is dispatched (`client.mjs:300,320`).
        let mut note = None;
        if let Some(session) = &self.linux {
            let env = (session.env)();
            let check = || {
                let (manager, env) = (self.manager.clone(), env.clone());
                async move { computer_linux::check_readiness(&env, &computer_linux::SystemProbes::new(manager, env.clone())).await }.boxed()
            };
            if let Some(fallback) = computer_linux::capture_fallback(&command, check).await {
                command = fallback.command;
                note = Some(fallback.note);
            }
            if let Some(refusal) = computer_linux::preflight(&command, check).await {
                return Err(ComputerError::Failed { code: refusal.code.into(), message: refusal.message });
            }
        }
        let name = text(&command, "action").to_string();
        // `assertObservationInputAllowed` at admission: while "Observation only" is on, anything but a read is refused before it
        // opens an execution or reaches the helper. Node's client has already tracked the session and its coordinator begun the
        // pill when its router refuses; this core refuses first, so a refused input leaves the session unbound and shows no pill.
        self.assert_observation_input_allowed(&name)?;
        // `trackComputerSession` (`client.mjs:366-371`) runs for each command sent.
        self.bound.store(true, Ordering::SeqCst);
        if !self.executing.swap(true, Ordering::SeqCst) {
            if let Some(observer) = &self.observer {
                observer.began(self.config.observe_only);
            }
        }
        // While a typed secret's field may hold focus no capture leaves the host: a read is
        // refused, and the next action (which moves on) lifts the hold.
        if self.secret_focus.load(Ordering::SeqCst) {
            if HOST_READ_ACTIONS.contains(&name.as_str()) {
                return Err(ComputerError::Failed {
                    code: "capture_withheld".into(),
                    message: "capture_withheld: a secret field may be focused; move focus (Tab or a click elsewhere) first".into(),
                });
            }
            self.secret_focus.store(false, Ordering::SeqCst);
        }
        let result = match name.as_str() {
            "sequence" => self.act(command, &cancel).await,
            "capture" => self.capture(command, asked_mode, &cancel).await,
            "zoom" => Err(unsupported("capture mode=\"zoom\" needs the desktop host's frame store")),
            "list_history" => Err(unsupported("list kind=\"history\" needs the desktop host's action ledger")),
            "wait_for_user" => Err(unsupported("wait_for_user needs the desktop host's user-wait service")),
            "fill_saved_login" => Err(unsupported("saved_login needs the desktop host's secret store")),
            "verify" => {
                command.insert("action".into(), json!("window_predicates"));
                parts_of(&self.call(command, &cancel).await?)
            }
            "diagnose" => match &self.linux {
                Some(linux) => self.diagnose(linux, &command, &cancel).await,
                None => {
                    let mut parts = Vec::new();
                    for probe in ["accessibility_probe", "ocr_status"] {
                        let mut probe_command = Map::new();
                        probe_command.insert("action".into(), json!(probe));
                        parts.extend(parts_of(&self.call(probe_command, &cancel).await?)?);
                    }
                    Ok(parts)
                }
            },
            "list_apps" => {
                command.insert("action".into(), json!("list_installed_apps"));
                parts_of(&self.call(command, &cancel).await?)
            }
            _ => parts_of(&self.call(command, &cancel).await?),
        };
        // The fallback's note follows a result that is not an error.
        result.map(|mut parts| {
            if let Some(note) = note {
                parts.push(ToolPart::Text(note.into()));
            }
            parts
        })
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        if self.config.observe_only {
            return Err(ComputerError::Denied);
        }
        self.screen.inject(input)
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        self.screen.release()
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        self.screen.input_desktop()
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        self.screen.displays()
    }

    fn screen_source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        self.screen.source(display)
    }

    fn status(&self) -> ComputerStatus {
        let active = locked(&self.host).as_ref().is_some_and(|host| host.alive.load(Ordering::SeqCst));
        ComputerStatus { active, observe_only: self.config.observe_only, controller: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The text the model reads for a helper that cannot start is Node's, recorded from the real
    /// `child_process.spawn` (`record-computer-spawn-error.mjs`): a missing file and a missing
    /// directory are asynchronous ENOENT with the path; a file that is not an executable is
    /// Windows' EFTYPE, thrown without one (the recording is Windows').
    #[test]
    fn a_helper_that_cannot_start_is_worded_as_nodes_spawn_error() {
        let golden: Value = serde_json::from_str(include_str!("golden/computer_spawn_error.json")).unwrap();
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap() {
            let error = match case["code"].as_str().unwrap() {
                "ENOENT" => ProcessError::ProgramNotFound { program: String::new() },
                "EFTYPE" if cfg!(windows) => ProcessError::Io { os_code: Some(193) },
                _ => continue,
            };
            let binary = PathBuf::from(case["binary"].as_str().unwrap().replace("<DIR>", "C:\\tmp"));
            let want = case["text"].as_str().unwrap().replace("<DIR>", "C:\\tmp");
            assert_eq!(node_spawn_message(&binary, &error), Some(want), "{}", case["name"]);
            checked += 1;
        }
        assert!(checked >= 2);
        // Node words an EACCES start like ENOENT (also asynchronous, with the path); a refusal
        // that is not an OS failure keeps the backend's own wording.
        assert_eq!(
            node_spawn_message(Path::new("/x/h"), &ProcessError::PermissionDenied).as_deref(),
            Some("computer host failed to start: spawn /x/h EACCES")
        );
        assert_eq!(node_spawn_message(Path::new("/x/h"), &ProcessError::LimitReached { limit: 1 }), None);
    }

    fn input(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn tool_calls_become_the_host_commands_node_sends() {
        let list = host_command(ComputerAction::List, &input(json!({"kind":"apps","query":"x"})));
        assert_eq!(Value::Object(list), json!({"action":"list_apps","query":"x"}));
        let window = host_command(ComputerAction::Window, &input(json!({"operation":"minimize","window_id":"w"})));
        assert_eq!(Value::Object(window), json!({"action":"window_state","state":"minimize","window_id":"w"}));
        let act = host_command(
            ComputerAction::Act,
            &input(json!({"window_id":"w","observe":"ax","frame_id":"f","actions":[
                {"type":"click","button":"right","x":1,"y":2},
                {"type":"set_value","value":"v","ref":"e1"},
                {"type":"move","x":3,"y":4}]})),
        );
        assert_eq!(
            Value::Object(act),
            json!({"action":"sequence","window_id":"w","delivery":"background","capture_after_mode":"ax","steps":[
                {"action":"right_click","x":1,"y":2,"frame_id":"f"},
                {"action":"set_value","text":"v","ref":"e1"},
                {"action":"mouse_move","x":3,"y":4,"frame_id":"f"}]})
        );
        let login = host_command(ComputerAction::SavedLogin, &input(json!({"savedAccount":"a","app":"b"})));
        assert_eq!(Value::Object(login), json!({"action":"fill_saved_login","saved_account":"a","app":"b","delivery":"foreground"}));
    }

    #[test]
    fn cross_field_rules_match_the_node_messages() {
        let err = |action, value: Value| validate(action, &input(value)).unwrap_err();
        assert_eq!(err(ComputerAction::Window, json!({"operation":"focus"})), "Computer Use window requires exactly one of window_id or app");
        assert_eq!(
            err(ComputerAction::Capture, json!({"mode":"zoom"})),
            "Computer Use capture mode=\"zoom\" requires input field(s): frame_id, region"
        );
        assert_eq!(err(ComputerAction::List, json!({"limit":3})), "Computer Use list limit applies to kind=\"history\"");
        assert!(err(ComputerAction::Launch, json!({"app":"powershell.exe"})).starts_with("Computer Use launch blocks shells"));
        assert!(err(ComputerAction::Launch, json!({"app":"a && b"})).ends_with("without command syntax"));
        assert!(validate(ComputerAction::Launch, &input(json!({"app":"https://example.com/a&&b"}))).is_ok());
        assert!(validate(ComputerAction::Capture, &input(json!({"window_id":"w"}))).is_ok());
    }

    #[test]
    fn error_codes_and_replies() {
        assert_eq!(error_code("Error: Stale_Target: gone"), "stale_target");
        assert_eq!(error_code("no code here"), "");
        assert_eq!(error_code("capture_source_unavailable|x"), "capture_source_unavailable");
        let result = input(json!({"text":"hi","image_base64":"aGk="}));
        let parts = parts_of(&result).unwrap();
        assert_eq!(parts[0], ToolPart::Text("hi".into()));
        assert_eq!(parts[1], ToolPart::Image { mime: "image/png".into(), data: ImageData::Bytes(b"hi".to_vec()), width: None, height: None });
        assert!(parts_of(&input(json!({"image":{"data":"aGk=","mimeType":"image/gif"}}))).is_err());
        assert_eq!(envelope(json!({"id":1,"ok":false,"error":"x"})), Err("x".into()));
        assert_eq!(leading_id("{\"id\": 42,\"ok\":true"), Some(42));
    }

    #[test]
    fn output_is_split_into_lines_like_buf_read_lines() {
        let mut lines = LineSplitter::default();
        assert_eq!(lines.push(b"one\r\ntw"), (vec!["one".to_owned()], false));
        assert_eq!(lines.push(b"o\n\nthr"), (vec!["two".to_owned(), String::new()], false));
        assert_eq!(lines.push(b"ee"), (Vec::<String>::new(), false));
        assert_eq!(lines.finish(), Some("three".to_owned()));
        assert_eq!(lines.finish(), None);
        let (done, broken) = lines.push(b"ok\n\xff\nlater\n");
        assert_eq!((done, broken), (vec!["ok".to_owned()], true));
    }

    struct Script(std::collections::VecDeque<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Script {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.pop_front()
        }
    }

    #[tokio::test]
    async fn replies_are_delivered_before_the_waiters_of_an_exited_host_are_failed() {
        use mixdog_core_api::domain::process::ExitStatus;
        use mixdog_core_api::domain::process::ProcessExit;

        let pending: Pending = Arc::default();
        let outcomes = Arc::new(Mutex::new(Vec::new()));
        for id in [1, 2] {
            let outcomes = outcomes.clone();
            locked(&pending).insert(id, Box::new(move |outcome| locked(&outcomes).push((id, outcome))));
        }
        let output = |seq, stream, text: &str| ProcessEvent::Output { seq, stream, bytes: text.as_bytes().to_vec() };
        let events = Script(
            [
                output(0, OutputStream::Stdout, "noise\n@@MIXCU@@{\"id\":1,\"ok\":tr"),
                output(1, OutputStream::Stderr, "ignored\n"),
                output(2, OutputStream::Stdout, "ue,\"result\":{\"text\":\"a\"}}\r\n"),
                ProcessEvent::Exited { seq: 3, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } },
            ]
            .into(),
        );
        let alive = Arc::new(AtomicBool::new(true));
        let (done, exited) = watch::channel(false);
        pump(Box::new(events), pending, alive.clone(), done).await;
        assert!(!alive.load(Ordering::SeqCst));
        assert!(*exited.borrow());
        let outcomes = locked(&outcomes);
        assert_eq!(outcomes[0].0, 1);
        assert_eq!(outcomes[0].1.as_ref().unwrap().get("text"), Some(&json!("a")));
        assert_eq!(outcomes[1].0, 2);
        assert!(outcomes[1].1.as_ref().unwrap_err().starts_with("computer_host_exited"));
    }

    type Feeds = Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<ProcessEvent>>>;

    /// A helper that answers every request line `ok` (except a `hang`) and a cleanup run that exits 0, with no OS
    /// process behind it: the backend's own launch, write and reply code runs, on every platform.
    #[derive(Default)]
    struct Answering {
        senders: Feeds,
        receivers: Mutex<HashMap<String, tokio::sync::mpsc::UnboundedReceiver<ProcessEvent>>>,
        seq: AtomicU64,
    }

    struct Feed(tokio::sync::mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Feed {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    impl Answering {
        fn emit(&self, handle: &ProcessHandle, event: impl FnOnce(u64) -> ProcessEvent) {
            let seq = self.seq.fetch_add(1, Ordering::SeqCst);
            let sender = locked(&self.senders).get(&handle.0).cloned().expect("a spawned handle");
            sender.send(event(seq)).expect("the pump is listening");
        }

        fn exit(seq: u64, killed: Option<mixdog_core_api::domain::process::KillReason>) -> ProcessEvent {
            use mixdog_core_api::domain::process::ExitStatus;
            use mixdog_core_api::domain::process::ProcessExit;
            ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(0), killed } }
        }
    }

    #[async_trait]
    impl ProcessManager for Answering {
        async fn spawn(&self, request: SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, ProcessError> {
            let (send, receive) = tokio::sync::mpsc::unbounded_channel();
            locked(&self.senders).insert(request.handle.0.clone(), send);
            locked(&self.receivers).insert(request.handle.0.clone(), receive);
            if !request.stdin_piped {
                self.emit(&request.handle, |seq| Self::exit(seq, None));
            }
            Ok(mixdog_core_api::domain::process::SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let receive = locked(&self.receivers).remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(Feed(receive)))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let request: Value = serde_json::from_slice(&bytes).expect("a request line");
            if request["action"] != "hang" {
                let reply = format!("{RESPONSE_MARKER}{}\n", json!({"id": request["id"], "ok": true, "result": {"text": "ok"}}));
                self.emit(handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: reply.into_bytes() });
            }
            Ok(())
        }

        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Err(ProcessError::StdinClosed)
        }

        fn resize_pty(&self, _: &ProcessHandle, _: mixdog_core_api::domain::process::PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::NotPty)
        }

        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.emit(handle, |seq| Self::exit(seq, Some(mixdog_core_api::domain::process::KillReason::Requested)));
            Ok(())
        }

        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    #[derive(Default)]
    struct Edges(Mutex<Vec<String>>);

    impl ExecutionObserver for Edges {
        fn began(&self, observe_only: bool) {
            locked(&self.0).push(format!("began:{observe_only}"));
        }
        fn ended(&self) {
            locked(&self.0).push("ended".into());
        }
    }

    /// The edges of an open execution, which the computer pill follows, with a helper that starts and answers: the
    /// first action opens it (a second inside it does not), and `execution_end`, an abort, a release and a
    /// cancelled call each close it once. Runs on Windows too: the helper is the manager's seam, not a shell script.
    #[tokio::test]
    async fn the_execution_edges_of_a_started_helper_reach_the_observer() {
        let edges = Arc::new(Edges::default());
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default())).with_observer(edges.clone());
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let seen = || std::mem::take(&mut *locked(&edges.0));

        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(backend.status().active, "the helper started and answered");
        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert_eq!(seen(), ["began:false"], "the second action runs inside the open execution");
        assert!(backend.end_execution().await);
        assert_eq!(seen(), ["ended"]);
        assert!(!backend.end_execution().await);
        assert_eq!(seen(), Vec::<String>::new(), "nothing was open");

        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(backend.abort_session().await);
        assert_eq!(seen(), ["began:false", "ended"]);

        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(backend.release_session().await);
        assert_eq!(seen(), ["began:false", "ended"]);

        backend.run(read(), CancellationToken::new()).await.unwrap();
        let cancel = CancellationToken::new();
        let receive = backend.send(input(json!({"action":"hang"})), &cancel).await.unwrap();
        cancel.cancel();
        assert_eq!(backend.wait_reply(receive, &cancel).await, Err(ComputerError::Cancelled));
        assert_eq!(seen(), ["began:false", "ended"], "a cancelled call aborts the session");
    }

    /// `assertObservationInputAllowed`: while the desktop's "Observation only" is on, an input is refused in Node's words before it
    /// opens an execution or starts the helper, and a read still runs; once it is off, the same input runs.
    #[tokio::test]
    async fn observation_only_refuses_input_at_admission() {
        let observing = Arc::new(AtomicBool::new(true));
        let edges = Arc::new(Edges::default());
        let setting = observing.clone();
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()))
            .with_observer(edges.clone())
            .with_observe_only_setting(Arc::new(move || setting.load(Ordering::SeqCst)));
        let write = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"write","text":"x"}) };

        assert_eq!(
            backend.run(write(), CancellationToken::new()).await,
            Err(ComputerError::Failed {
                code: "observation_only".into(),
                message: "observation_only: Computer Use is observing only, so 'clipboard_write' input is blocked. Turn off \"Observation only\" in Settings to allow input.".into(),
            })
        );
        assert!(!backend.is_bound() && !backend.status().active, "nothing reached the helper");
        assert!(locked(&edges.0).is_empty(), "no execution opened");
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        backend.run(read, CancellationToken::new()).await.unwrap();
        observing.store(false, Ordering::SeqCst);
        backend.run(write(), CancellationToken::new()).await.unwrap();
    }

    /// A secret typed by a handoff goes through `execute`, which `run` does not: "Observation only" refuses its `type` in Node's
    /// words and still admits its `find`.
    #[tokio::test]
    async fn observation_only_refuses_a_secret_type_but_admits_its_find() {
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()))
            .with_observe_only_setting(Arc::new(|| true));
        let command = |action: &str| input(json!({"action": action}));
        assert_eq!(
            ComputerSecretHost::execute(&backend, command("type")).await,
            Err("observation_only: Computer Use is observing only, so 'type' input is blocked. Turn off \"Observation only\" in Settings to allow input.".to_owned())
        );
        assert!(ComputerSecretHost::execute(&backend, command("find")).await.is_ok());
    }

    /// Node admits each `act` step again: "Observation only" turned on after the sequence was admitted refuses the next input
    /// step in Node's words, once the step before it has reached the helper.
    #[tokio::test]
    async fn observation_only_turned_on_mid_sequence_stops_the_steps_left() {
        // Off for the sequence's admission and its first step, on from the second step's check.
        let reads = Arc::new(AtomicU64::new(0));
        let counted = reads.clone();
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()))
            .with_observe_only_setting(Arc::new(move || counted.fetch_add(1, Ordering::SeqCst) >= 2));
        let act = ComputerRequest {
            action: ComputerAction::Act,
            input: json!({"window_id":"w","actions":[{"type":"key","keys":"a"},{"type":"click","x":1,"y":2}]}),
        };

        assert_eq!(
            backend.run(act, CancellationToken::new()).await,
            Err(ComputerError::Failed {
                code: "observation_only".into(),
                message: "observation_only: Computer Use is observing only, so 'click' input is blocked. Turn off \"Observation only\" in Settings to allow input.".into(),
            })
        );
        assert!(backend.is_bound() && backend.status().active, "the first step reached the helper");
        assert_eq!(reads.load(Ordering::SeqCst), 3, "the admission and each step read the setting");
    }

    #[cfg(unix)]
    mod host {
        use mixdog_rt::LaneToken;

        use super::*;

        /// Writes an executable script on the maintenance lane.
        async fn write_script(path: &std::path::Path, script: &'static str) {
            let (path, opts) = (path.to_path_buf(), mixdog_statefile::Opts { mode: 0o755, ..mixdog_statefile::Opts::default() });
            mixdog_rt::testing::tokens()
                .maintenance_io
                .submit_wait(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, script.as_bytes(), &opts).unwrap())
                .await
                .unwrap()
                .await
                .unwrap();
        }

        /// The text of a file the stand-in helper wrote; `None` while it is missing.
        fn written(path: std::path::PathBuf) -> Option<String> {
            mixdog_statefile::read_content(&path).unwrap().map(|bytes| String::from_utf8(bytes).unwrap())
        }

        /// A stand-in helper: answers each request with its id and echoes the action.
        async fn fake_host(dir: &std::path::Path) -> PathBuf {
            let path = dir.join("fake-host.sh");
            let script = r#"#!/bin/sh
if [ "$1" = "--abort-cleanup" ]; then echo cleaned > "$(dirname "$0")/cleanup"; exit 0; fi
while read -r line; do
  id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *hang*) sleep 30;;
    *) echo "@@MIXCU@@{\"id\":$id,\"ok\":true,\"result\":{\"text\":\"ok $line\"}}";;
  esac
done
"#;
            write_script(&path, script).await;
            path

        }

        /// A stand-in helper that also logs each request line it is sent.
        async fn logging_host(dir: &std::path::Path) -> PathBuf {
            let path = dir.join("logging-host.sh");
            let script = r#"#!/bin/sh
if [ "$1" = "--abort-cleanup" ]; then echo cleaned >> "$(dirname "$0")/cleanup"; exit 0; fi
while read -r line; do
  echo "$line" >> "$(dirname "$0")/log"
  id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  echo "@@MIXCU@@{\"id\":$id,\"ok\":true,\"result\":{\"text\":\"ok\"}}"
done
"#;
            write_script(&path, script).await;
            path

        }

        fn log(dir: &std::path::Path) -> String {
            written(dir.join("log")).unwrap_or_default()
        }

        /// `execution_end` lets go of held input and keeps the helper warm, and only when an
        /// execution is open; `session_abort` stops the helper and runs the cleanup; `session_release`
        /// drops the session's refs first. A session that was aborted owns nothing in the helper.
        #[tokio::test]
        async fn the_session_control_actions_follow_nodes_lifecycle() {
            let dir = tempfile::tempdir().unwrap();
            let tokens = mixdog_rt::testing::tokens();
            let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
            let backend = ProcessComputerBackend::new(ComputerConfig::new(logging_host(dir.path()).await, "s1"), manager);
            let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };

            assert!(!backend.end_execution().await, "nothing is open before the first action");
            assert!(!backend.is_bound());
            backend.run(read(), CancellationToken::new()).await.unwrap();
            assert!(backend.is_bound());
            assert!(backend.end_execution().await);
            assert!(log(dir.path()).lines().last().unwrap().contains("\"release_held_input\""), "{}", log(dir.path()));
            assert!(backend.status().active, "the helper stays warm for a follow-up turn");
            assert!(!backend.end_execution().await, "an ended execution is not ended twice");

            backend.run(read(), CancellationToken::new()).await.unwrap();
            assert!(backend.abort_session().await);
            assert!(written(dir.path().join("cleanup")).is_some());
            assert!(!backend.status().active);
            assert!(!backend.is_bound(), "an aborted session owns nothing in the helper");
            assert!(!backend.end_execution().await, "an abort closes the execution");

            backend.run(read(), CancellationToken::new()).await.unwrap();
            assert!(backend.release_session().await);
            let sent = log(dir.path());
            assert!(sent.lines().last().unwrap().contains("\"release_session\""), "{sent}");
            assert_eq!(written(dir.path().join("cleanup")).unwrap().lines().count(), 2);
            assert!(!backend.status().active && !backend.is_bound());
        }

        #[tokio::test]
        async fn runs_an_action_through_the_resident_host_and_cleans_up_on_cancel() {
            let dir = tempfile::tempdir().unwrap();
            let tokens = mixdog_rt::testing::tokens();
            let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
            let backend = ProcessComputerBackend::new(ComputerConfig::new(fake_host(dir.path()).await, "s1"), manager);
            let parts = backend
                .run(ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) }, CancellationToken::new())
                .await
                .unwrap();
            let ToolPart::Text(text) = &parts[0] else { panic!("text part") };
            assert!(text.contains("clipboard_read") && text.contains("\"session_id\":\"s1\""), "{text}");
            assert!(backend.status().active);

            let cancel = CancellationToken::new();
            let trip = cancel.clone();
            tokio::spawn(async move {
                mixdog_rt::time::sleep(Duration::from_millis(200)).await;
                trip.cancel();
            });
            let hung = backend
                .run(ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"write","text":"hang"}) }, cancel)
                .await;
            assert_eq!(hung, Err(ComputerError::Cancelled));
            assert!(written(dir.path().join("cleanup")).is_some());
            assert!(!backend.status().active);
        }

        /// The cancel fires while the command is in flight and the helper never answers: the wait
        /// ends as `Cancelled` (cancel is checked before the reply), and the helper is retired,
        /// which kills it and runs `--abort-cleanup`. No timing: the token is already fired when
        /// the wait starts.
        #[tokio::test]
        async fn a_cancel_during_the_wait_retires_the_helper() {
            let dir = tempfile::tempdir().unwrap();
            let tokens = mixdog_rt::testing::tokens();
            let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
            let backend = ProcessComputerBackend::new(ComputerConfig::new(fake_host(dir.path()).await, "s1"), manager);
            let cancel = CancellationToken::new();
            let receive = backend.send(input(json!({"action":"hang"})), &cancel).await.unwrap();
            assert!(backend.status().active);
            assert!(written(dir.path().join("cleanup")).is_none());

            cancel.cancel();
            let ended = backend.wait_reply(receive, &cancel).await;

            assert_eq!(ended, Err(ComputerError::Cancelled));
            assert!(written(dir.path().join("cleanup")).is_some());
            assert!(!backend.status().active);
        }
    }
}
