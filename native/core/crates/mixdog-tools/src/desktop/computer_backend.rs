//! The real `ComputerBackend`: the `computer` tool served by the resident `mixdog-computer`
//! helper (one process per backend, one JSON request per stdin line, one `@@MIXCU@@`-prefixed
//! reply line per request, the protocol the Node desktop speaks), plus the in-process screen
//! half in `computer_screen`.
//!
//! The action contract is Node's (`computer-bridge/action-schema.mjs`, in `computer_command`): the same cross-field
//! rules, the same translation of a tool call into host commands, the same limits and the same
//! recovery on a timeout or cancellation (the helper is killed and `--abort-cleanup` releases any
//! input it held). What the Node desktop host adds on top of the helper is one module per concern, each
//! called from here: `computer_act`, `computer_capture`, `computer_diagnose`, `computer_env` (the launch
//! environment), `computer_policy` (observation only), `computer_targets`, `computer_keys`,
//! `computer_frames`, `computer_reply`, `computer_settle`, `computer_verify`, `computer_zoom`,
//! `computer_ocr`, `computer_internal_windows`, `computer_lane` (the desktop's one keyboard and
//! pointer), `computer_user_control`, `computer_lease` and `computer_feedback` (the helper's side
//! lines) and `computer_abort`. The ones not ported yet keep this backend's earlier behaviour:
//! the actions they serve report `Unavailable`.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU32;
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

use super::computer_abort;
use super::computer_abort::RestorePoints;
use super::computer_budget::CommandBudget;
use super::computer_budget::InFlight;
use super::computer_budget::LiveProcess;
use super::computer_budget::LiveProcesses;
use super::computer_budget::Tally;
use super::computer_command::host_command;
use super::computer_command::text;
use super::computer_command::validate;
use super::computer_env;
use super::computer_env::EnvInputs;
use super::computer_feedback;
use super::computer_frames::FrameStore;
use super::computer_internal_windows;
use super::computer_lane;
use super::computer_lane::Lane;
use super::computer_lease;
use super::computer_linux;
use super::computer_policy;
use super::computer_recovery::lead_code as error_code;
use super::computer_reply;
use super::computer_screen::Screen;
use super::computer_settle;
use super::computer_targets;
use super::computer_user_control::UserControlState;
use super::computer_verify;
use super::computer_zoom;
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
pub(super) const COMMAND_TIMEOUT: Duration = Duration::from_millis(45_000);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 1_000_000;
const MAX_IMAGE_CHARS: usize = 24 * 1024 * 1024;
/// `client.mjs` `BRIDGE_UNAVAILABLE_MESSAGE`.
const BRIDGE_UNAVAILABLE_MESSAGE: &str = "computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings";
/// Process handles are unique per manager, and one manager can serve several backends.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

/// Commands the desktop host serves as reads (`computerActionsWith('hostRead')`): withheld while a
/// secret field may be focused.
pub(super) const HOST_READ_ACTIONS: [&str; 14] = [
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

/// How the helper is run.
#[derive(Clone, Debug)]
pub struct ComputerConfig {
    /// The `mixdog-computer` executable.
    pub binary: PathBuf,
    /// Names the helper's per-session state (held input, element refs).
    pub session_id: String,
    /// The daemon's data directory, under which the helper keeps its inactive-window ledger; `None` keeps none.
    pub data_dir: Option<PathBuf>,
    /// Pause after a background sequence step, in milliseconds.
    pub sequence_settle_ms: u64,
    /// Longest literal foreground text one call may type.
    pub max_foreground_text: usize,
}

impl ComputerConfig {
    pub fn new(binary: impl Into<PathBuf>, session_id: impl Into<String>) -> Self {
        Self { binary: binary.into(), session_id: session_id.into(), data_dir: None, sequence_settle_ms: 350, max_foreground_text: 4_000 }
    }
}

/// Whether observation-only mode is on (`desktop.computerObserveOnly`), read afresh on every call.
pub type ObserveOnly = Arc<dyn Fn() -> bool + Send + Sync>;

/// What the backends of one pool share: the desktop's one keyboard and pointer, the person's control of it, the live
/// observation-only setting and the pending-command budget.
#[derive(Clone)]
pub struct ComputerShared {
    pub lane: Arc<Lane>,
    pub user_control: Arc<UserControlState>,
    pub observe_only: ObserveOnly,
    /// The commands pending across the sessions (4 each, 32 in all).
    pub budget: Arc<CommandBudget>,
    /// The helper processes alive across the sessions (8 at most).
    pub live: Arc<LiveProcesses>,
    /// The helper requests in flight across the sessions (32 at most).
    pub in_flight: Arc<InFlight>,
}

impl Default for ComputerShared {
    /// A lane, a control and a budget of its own, observation only off.
    fn default() -> Self {
        Self { lane: Arc::default(), user_control: Arc::default(), observe_only: Arc::new(|| false), budget: Arc::default(), live: Arc::default(), in_flight: Arc::default() }
    }
}

/// A helper's `{"ok":false}` reply: its error text, and the `result` it carried (a capture's `capture_cleanup`, the codes of a
/// refusal), which the reply's readers keep.
#[derive(Clone, Debug, PartialEq)]
pub struct HelperFailure {
    pub text: String,
    pub result: Option<Map<String, Value>>,
}

impl HelperFailure {
    /// The tool's error: the code the text leads with, and the text.
    pub(super) fn into_error(self) -> ComputerError {
        host_error(&self.text)
    }
}

/// One request's reply: the helper's result, or its failure.
pub(super) type Reply = Result<Map<String, Value>, HelperFailure>;
pub(super) type Waiter = Box<dyn FnOnce(Reply) + Send>;
/// The requests in flight, by id.
pub(super) type Pending = Arc<Mutex<HashMap<i64, Waiter>>>;

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

/// Where the helper's output lines go: replies to the requests they answer, foreground-lease asks to the relay (which
/// answers on stdin outside the turn gate), pointer progress to the desktop's overlay.
struct Readers {
    pending: Pending,
    relay: computer_lease::Relay,
    pointer: computer_feedback::Pointer,
    /// Told once the helper's output has ended and its waiters are failed (`ProcessComputerBackend::watch_for_death`).
    gone: Arc<tokio::sync::Notify>,
    /// The helper counts as a live process until its output has ended.
    live: Option<LiveProcess>,
}

/// Hands one output line to its reader; any other line is the helper's own noise.
fn deliver(readers: &Readers, line: &str) {
    if let Some(body) = line.strip_prefix(computer_lease::LINE_MARKER) {
        readers.relay.on_line(body);
        return;
    }
    if let Some(body) = line.strip_prefix(computer_feedback::LINE_MARKER) {
        readers.pointer.on_line(body);
        return;
    }
    let Some(body) = line.strip_prefix(RESPONSE_MARKER) else { return };
    let (id, outcome) = if body.len() > MAX_RESPONSE_BYTES {
        // Too large to trust or parse; the id is still the number after `"id":`.
        let text = "computer_response_too_large: worker output exceeded byte limit".to_owned();
        (leading_id(body), Err(HelperFailure { text, result: None }))
    } else {
        match serde_json::from_str::<Value>(body) {
            Ok(value) => (value.get("id").and_then(Value::as_i64), envelope(value)),
            Err(_) => return,
        }
    };
    let waiter = id.and_then(|id| locked(&readers.pending).remove(&id));
    // What the desktop's lease owner did for the action joins the helper's own account (`worker-pool.ts`); a failed reply
    // drops them.
    let facts = id.and_then(|id| readers.relay.take_facts(id));
    let outcome = match (outcome, facts) {
        (Ok(mut result), Some(facts)) => {
            let mut lock = result.get("foreground_lock").and_then(Value::as_object).cloned().unwrap_or_default();
            lock.insert("host".into(), facts);
            result.insert("foreground_lock".into(), Value::Object(lock));
            Ok(result)
        }
        (outcome, _) => outcome,
    };
    if let Some(waiter) = waiter {
        waiter(outcome);
    }
}

/// The failure the requests waiting on a helper that exited get.
const HOST_EXITED_TEXT: &str = "computer_host_exited: the computer host stopped";

/// How long one `--abort-cleanup` run may take (`ABORT_CLEANUP_TIMEOUT_MS`, `host/lifecycle-abort.ts:21`).
const ABORT_CLEANUP_TIME_LIMIT: Duration = Duration::from_millis(7_000);

/// Replies in a row reporting `monitor_unresponsive` after which the helper is replaced.
const UNRESPONSIVE_LIMIT: u32 = 3;

/// Marks the host gone and fails every request still waiting on it.
fn fail_waiters(pending: &Pending, alive: &AtomicBool) {
    alive.store(false, Ordering::SeqCst);
    let orphans: Vec<Waiter> = locked(pending).drain().map(|(_, waiter)| waiter).collect();
    for waiter in orphans {
        waiter(Err(HelperFailure { text: HOST_EXITED_TEXT.into(), result: None }));
    }
}

/// Reads the helper's output events until it exits.
async fn pump(mut events: Box<dyn EventSource<ProcessEvent>>, mut readers: Readers, alive: Arc<AtomicBool>, exited: watch::Sender<bool>) {
    let mut lines = LineSplitter::default();
    let mut reading = true;
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } if reading => {
                let (complete, broken) = lines.push(&bytes);
                for line in complete {
                    deliver(&readers, &line);
                }
                if broken {
                    // Past a line that is not text the output is not trusted; keep draining the
                    // pipe until the process is gone.
                    reading = false;
                    fail_waiters(&readers.pending, &alive);
                }
            }
            ProcessEvent::Output { .. } => {}
            ProcessEvent::Exited { .. } => {
                if let Some(line) = reading.then(|| lines.finish()).flatten() {
                    deliver(&readers, &line);
                }
                break;
            }
        }
    }
    fail_waiters(&readers.pending, &alive);
    // Gone before anything that waited for the exit looks at the count.
    drop(readers.live.take());
    let _ = exited.send(true);
    readers.gone.notify_one();
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
    pub(super) config: ComputerConfig,
    pub(super) manager: Arc<dyn ProcessManager>,
    host: Mutex<Option<Host>>,
    /// One request starts the helper and is written at a time; the wait leaves on the request's cancel.
    turn: mixdog_rt::Gate,
    next_id: AtomicI64,
    screen: Screen,
    desktop: Option<Arc<dyn HostChannel>>,
    /// The Linux session the preflight reads; `None` where the platform is not Linux and nothing is probed.
    pub(super) linux: Option<LinuxSession>,
    /// A typed secret's field may still hold focus: reads are refused until the next action.
    secret_focus: AtomicBool,
    /// A visible execution is open: some action ran since the last `execution_end`, abort or
    /// release (`activeComputerExecutions`, `computer-bridge/client.mjs:368`).
    executing: AtomicBool,
    /// The session reached the helper and has not been aborted or released
    /// (`hostBoundComputerSessions`, `client.mjs:367`).
    bound: AtomicBool,
    observer: Option<Arc<dyn ExecutionObserver>>,
    /// Tags the input this backend's helpers inject, so their observer tells it from the person's: one value for the resident
    /// helper, each respawn of it and its `--abort-cleanup` run (`MIXDOG_COMPUTER_INPUT_MARKER`).
    marker: u32,
    shared: ComputerShared,
    /// The frames this backend's captures issued, which frame-bound coordinates are mapped through.
    pub(super) frames: FrameStore,
    /// What an `--abort-cleanup` run restores the pointer and focus to.
    restore_points: Mutex<RestorePoints>,
    /// Wakes `watch_for_death`: a helper's output ended, or the backend is dropped.
    gone: Arc<tokio::sync::Notify>,
    /// Consecutive helper replies that said the input observer does not answer (`monitor_unresponsive`).
    unresponsive: AtomicU32,
    /// The `--abort-cleanup` runs this backend has going (`cleanupJobs.has(sessionId)`): the pool reclaims no session that has one.
    cleaning: Arc<std::sync::atomic::AtomicUsize>,
    /// The windows this session has been told about, which the next command names the newcomers to.
    pub(super) arrivals: computer_settle::Arrivals,
}

/// The environment the Linux preflight reads, taken afresh for each action.
pub(super) struct LinuxSession {
    pub(super) env: Box<dyn Fn() -> computer_linux::Env + Send + Sync>,
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
    /// An action ran with no execution open. `observe_only` is the setting that action read.
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

    /// Runs under the lane, the person's control and the observation-only setting the pool's other sessions share.
    pub fn with_shared(mut self, shared: ComputerShared) -> Self {
        self.shared = shared;
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
            marker: computer_env::new_marker(),
            shared: ComputerShared::default(),
            frames: FrameStore::default(),
            restore_points: Mutex::default(),
            gone: Arc::default(),
            unresponsive: AtomicU32::new(0),
            cleaning: Arc::default(),
            arrivals: computer_settle::Arrivals::default(),
        }
    }

    /// Cleans up after a helper that exits by itself as soon as that is seen, not at the next command or the end of the
    /// execution (the sample's `runtime.py` releases at once). The cleanup runs under the turn and only takes a helper still
    /// marked dead, so it never races a restart: a newer live helper, or one a retire already took, is left alone. Ends with
    /// the backend.
    pub fn watch_for_death(self: &Arc<Self>) {
        // Outside a runtime nothing could run the cleanup; the next command or the end of the execution does it.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let backend = Arc::downgrade(self);
        let gone = self.gone.clone();
        runtime.spawn(async move {
            loop {
                gone.notified().await;
                let Some(backend) = backend.upgrade() else { break };
                let confirmed = backend.recover_dead_host().await;
                backend.pause_unless(confirmed);
            }
        });
    }

    /// Whether the session reached the helper and still owns state there.
    pub fn is_bound(&self) -> bool {
        self.bound.load(Ordering::SeqCst)
    }

    /// Whether a visible execution is open (a turn's commands have run and it has not settled).
    pub fn is_executing(&self) -> bool {
        self.executing.load(Ordering::SeqCst)
    }

    /// Whether a cleanup of this session is running now.
    pub fn is_cleaning(&self) -> bool {
        self.cleaning.load(Ordering::SeqCst) > 0
    }

    /// Whether observation-only mode is on now.
    pub(super) fn observe_only(&self) -> bool {
        (self.shared.observe_only)()
    }

    /// Whether a resident helper is running now (nothing is started to tell).
    pub fn has_live_host(&self) -> bool {
        locked(&self.host).as_ref().is_some_and(|host| host.alive.load(Ordering::SeqCst))
    }

    /// `session_abort` (`abortComputerSession`, `client.mjs:490-499`; the host side
    /// `lifecycle-abort.ts:runAbortCleanup`): the helper is stopped and a fresh `--abort-cleanup`
    /// process releases the input it held. True once the cleanup confirmed (exit 0); then the
    /// session no longer owns state in the helper. A cancelled `computer` call does this itself.
    pub async fn abort_session(&self) -> bool {
        self.close_execution();
        self.shared.lane.forget(&self.config.session_id);
        self.arrivals.forget();
        self.frames.forget_delivered();
        let confirmed = self.retire().await;
        if confirmed {
            self.bound.store(false, Ordering::SeqCst);
            self.shared.user_control.cleanup_confirmed(&self.config.session_id);
        }
        self.pause_unless(confirmed)
    }

    /// A cleanup the helper could not confirm hands the desktop to the user (`lifecycle-abort.ts:unconfirmedCleanup`); returns
    /// `confirmed`.
    pub(super) fn pause_unless(&self, confirmed: bool) -> bool {
        if !confirmed {
            self.shared.user_control.cleanup_unconfirmed(&self.config.session_id);
        }
        confirmed
    }

    /// `recoverLatchedCleanup` for this session: the helper is stopped and the cleanup run again; true when it confirmed.
    pub(super) async fn recover_cleanup(&self) -> bool {
        let confirmed = self.retire().await;
        if confirmed {
            self.bound.store(false, Ordering::SeqCst);
            self.shared.user_control.cleanup_confirmed(&self.config.session_id);
        }
        self.pause_unless(confirmed)
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
            // A helper that died on its own may have held input: its session is cleaned up from a fresh process, and one
            // that does not confirm ends the session as on a live helper (`session-lifecycle.ts` `confirmed === false`).
            return if self.recover_dead_host().await { true } else { self.abort_session().await };
        }
        let _lane = self.shared.lane.enter(computer_lane::Kind::Release, &CancellationToken::new()).await.ok();
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
        let _lane = self.shared.lane.enter(computer_lane::Kind::Release, &CancellationToken::new()).await.ok();
        let mut released = true;
        // Only the last session using the desktop restores its focus, from the windows the earlier ones held
        // (`restoreSessionDesktop`); an earlier one hands the windows it held on.
        let leaving = self.shared.lane.leave(&self.config.session_id);
        if locked(&self.host).as_ref().is_some_and(|host| host.alive.load(Ordering::SeqCst)) {
            let mut command = Map::new();
            command.insert("action".into(), json!("release_session"));
            command.insert("restore_focus".into(), json!(leaving.last));
            command.insert("handed_window_ids".into(), json!(leaving.handed));
            let reply = self.call(command, &CancellationToken::new()).await;
            released = reply.is_ok();
            if let (false, Ok(reply)) = (leaving.last, &reply) {
                let held = reply.get("held_window_ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
                self.shared.lane.hand_over(held.map(str::to_owned));
            }
        }
        self.abort_session().await && released
    }

    /// A run of the helper with `args`; it reads requests from stdin when `stdin_piped`. `abort` is the recovery env of an
    /// `--abort-cleanup` run.
    fn request(&self, args: Vec<String>, stdin_piped: bool, abort: Vec<(String, String)>) -> Result<SpawnRequest, ComputerError> {
        let ledger = self.config.data_dir.as_deref().map(|dir| computer_env::ledger_path(dir, &self.config.session_id, self.marker));
        self.request_for(args, stdin_piped, abort, self.marker, ledger)
    }

    /// `request` for a run with its own input `marker` and `ledger` (a sweep of the ledgers a dead core left).
    fn request_for(&self, args: Vec<String>, stdin_piped: bool, abort: Vec<(String, String)>, marker: u32, ledger_path: Option<PathBuf>) -> Result<SpawnRequest, ComputerError> {
        let cwd = std::env::current_dir().ok().and_then(AbsPath::new).ok_or_else(|| ComputerError::Unavailable {
            reason: "computer_backend_unavailable: the working directory is unreadable".into(),
        })?;
        let set = computer_env::helper_env(&EnvInputs {
            sequence_settle_ms: self.config.sequence_settle_ms,
            max_foreground_text: self.config.max_foreground_text,
            marker,
            ledger_path,
            host_lock_offered: computer_lease::owner_available(self.desktop.as_ref()),
            abort,
        });
        Ok(SpawnRequest {
            handle: ProcessHandle(format!("computer-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::SeqCst))),
            command: CommandSpec::Argv { program: self.config.binary.to_string_lossy().into_owned(), args },
            cwd,
            env: EnvSpec { inherit: true, set, remove: Vec::new() },
            pty: None,
            stdin_piped,
            output: OutputMode::Separate,
            owner: ProcessOwner::ComputerHelper,
            // A cleanup run is bounded as Node's (`lifecycle-abort.ts` `ABORT_CLEANUP_TIMEOUT_MS`): a hung one is killed and
            // reads as unconfirmed, and never holds the turn or a sweep.
            time_limit: (!stdin_piped).then_some(ABORT_CLEANUP_TIME_LIMIT),
        })
    }

    /// The resident helper, which reads requests from stdin. The ledger's folder is made first (`newPath` in
    /// `worker-ledgers.ts`): the helper opens the ledger without creating folders, and holds nothing it cannot record.
    fn resident(&self) -> Result<SpawnRequest, ComputerError> {
        if let Some(folder) = self.config.data_dir.as_deref().map(computer_env::ledger_folder) {
            let _ = std::fs::create_dir_all(folder);
        }
        self.request(Vec::new(), true, Vec::new())
    }

    /// `--abort-cleanup`: a fresh process that releases what the helper held and restores the session's restore points.
    fn cleanup(&self) -> Result<SpawnRequest, ComputerError> {
        let abort = computer_abort::env(&locked(&self.restore_points));
        self.request(vec!["--abort-cleanup".to_owned()], false, abort)
    }

    async fn spawn(&self) -> Result<Host, ComputerError> {
        let unavailable = |error: String| ComputerError::Unavailable {
            reason: format!("computer_backend_unavailable: cannot start {}: {error}", self.config.binary.display()),
        };
        self.sweep_leftover_ledgers().await;
        // A new process is refused while the cap of live ones is reached (`assertComputerWorkerCapacity`, `worker-pool.ts:182`).
        self.shared.live.assert_room()?;
        let request = self.resident()?;
        let handle = request.handle.clone();
        let live = self.shared.live.hold();
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
        let readers = Readers {
            pending: pending.clone(),
            relay: computer_lease::Relay::new(self.manager.clone(), handle.clone(), pending.clone(), self.desktop.clone()),
            pointer: computer_feedback::Pointer::new(self.desktop.clone(), &self.config.session_id),
            gone: self.gone.clone(),
            live: Some(live),
        };
        tokio::spawn(pump(events, readers, alive.clone(), done));
        Ok(Host { handle, pending, alive, exited })
    }

    /// Writes one request and returns the channel its reply arrives on.
    async fn send(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<oneshot::Receiver<Reply>, ComputerError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        command.insert("id".into(), json!(id));
        command.entry("session_id").or_insert_with(|| json!(self.config.session_id));
        // The elevation field belongs to the Windows helper alone; the Linux and macOS requests carry what Node sent, which always
        // names pointer_feedback (false on a read).
        let windows_helper = self.linux.is_none() && !cfg!(target_os = "macos");
        computer_policy::decorate(&mut command, self.observe_only(), windows_helper);
        if windows_helper {
            computer_feedback::decorate(&mut command, self.desktop.as_ref());
        } else {
            computer_feedback::mark(&mut command, self.desktop.as_ref());
        }
        let line = Value::Object(command).to_string();
        if line.len() > MAX_REQUEST_BYTES {
            return Err(ComputerError::InvalidInput {
                reason: "computer request exceeds byte limit; no input was dispatched".into(),
            });
        }
        let (reply, receive) = oneshot::channel();
        let _turn = self.turn.enter(cancel).await.map_err(|_| ComputerError::Cancelled)?;
        // The pool's in-flight cap counts dispatched requests, not ones still waiting for the turn, and refuses before a helper
        // is even started (`worker-pool.ts:270`).
        let slot = self.shared.in_flight.begin()?;
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
                    // It exited on its own, maybe holding input: released before a new helper starts.
                    self.run_cleanup().await;
                }
                let host = self.spawn().await?;
                let live = (host.handle.clone(), host.pending.clone());
                *locked(&self.host) = Some(host);
                live
            }
        };
        locked(&pending).insert(id, Box::new(move |outcome| {
            drop(slot);
            drop(reply.send(outcome));
        }));
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        if let Err(error) = self.manager.write_stdin(&handle, bytes).await {
            locked(&pending).remove(&id);
            let broken = locked(&self.host).take();
            if let Some(broken) = broken {
                broken.stop(&*self.manager).await;
                self.run_cleanup().await;
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
    pub(super) async fn retire(&self) -> bool {
        // Under the turn: a request that found no helper cannot start a new one under this marker and ledger while the
        // cleanup still runs.
        let _turn = self.turn.enter(&CancellationToken::new()).await;
        let host = locked(&self.host).take();
        if let Some(host) = host {
            host.stop(&*self.manager).await;
        }
        self.run_cleanup().await
    }

    /// One `--abort-cleanup` run with this session's restore points and ledger; true when it exited 0.
    async fn run_cleanup(&self) -> bool {
        let (_job, _live) = (Tally::up(&self.cleaning), self.shared.live.hold());
        match self.cleanup() {
            Ok(request) => run_to_exit(&*self.manager, request).await,
            Err(_) => false,
        }
    }

    /// A helper that exited by itself is stopped and cleaned up as a timeout's is. True when there was none or the cleanup
    /// confirmed. A live helper (a newer one) is left alone.
    async fn recover_dead_host(&self) -> bool {
        let _turn = self.turn.enter(&CancellationToken::new()).await;
        let dead = {
            let mut slot = locked(&self.host);
            if slot.as_ref().is_some_and(|host| !host.alive.load(Ordering::SeqCst)) { slot.take() } else { None }
        };
        let Some(dead) = dead else { return true };
        dead.stop(&*self.manager).await;
        self.run_cleanup().await
    }

    /// Recovers what a core that died left: every ledger under `<data>/computer/ledgers` is replayed by an `--abort-cleanup` run
    /// (`MIXDOG_ABORT_LEDGERS`, `worker-ledgers.ts:recover`) and the file removed once it confirmed. Once per data folder in this
    /// process, before the first helper starts: later ledgers there belong to helpers of this process. One that was not
    /// confirmed stays for the next start.
    async fn sweep_leftover_ledgers(&self) {
        static SWEPT: std::sync::OnceLock<tokio::sync::Mutex<std::collections::HashSet<PathBuf>>> = std::sync::OnceLock::new();
        let Some(data) = self.config.data_dir.as_deref() else { return };
        let mut swept = SWEPT.get_or_init(Default::default).lock().await;
        if !swept.insert(data.to_path_buf()) {
            return;
        }
        for (path, marker) in computer_env::leftover_ledgers(&computer_env::ledger_folder(data)) {
            let abort = vec![("MIXDOG_ABORT_LEDGERS".to_owned(), path.to_string_lossy().into_owned())];
            let Ok(request) = self.request_for(vec!["--abort-cleanup".to_owned()], false, abort, marker.unwrap_or(self.marker), None) else { continue };
            if run_to_exit(&*self.manager, request).await {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Runs the sweep of the ledgers a dead core left (`sweep_leftover_ledgers`) now, at the core's start, instead of before the
    /// first helper: windows a crashed daemon left without activation are restored before anyone uses `computer` again.
    pub async fn sweep_ledgers(&self) {
        self.sweep_leftover_ledgers().await;
    }

    /// Counts the replies that report the input observer unresponsive; true at the `UNRESPONSIVE_LIMIT`th in a row. A reply that
    /// reports it ready starts the count again, one that says nothing of it leaves it.
    fn observer_stuck(&self, reply: &Reply) -> bool {
        let named = |result: &Map<String, Value>| {
            if result.get("observer_ready") == Some(&Value::Bool(true)) {
                Some(false)
            } else {
                (result.get("observer_reason").and_then(Value::as_str) == Some("monitor_unresponsive")).then_some(true)
            }
        };
        let state = match reply {
            Ok(result) => named(result),
            // Only the text of an observation lost to the monitor: "original observation is unavailable (monitor_unresponsive)"
            // is also what a healthy helper says of a frame from before a respawn (another generation's observer).
            Err(failure) => failure
                .result
                .as_ref()
                .and_then(named)
                .or_else(|| failure.text.contains("input observation lost (monitor_unresponsive)").then_some(true)),
        };
        match state {
            Some(true) => {
                if self.unresponsive.fetch_add(1, Ordering::SeqCst) + 1 >= UNRESPONSIVE_LIMIT {
                    self.unresponsive.store(0, Ordering::SeqCst);
                    return true;
                }
                false
            }
            Some(false) => {
                self.unresponsive.store(0, Ordering::SeqCst);
                false
            }
            None => false,
        }
    }

    /// One helper round trip within `COMMAND_TIMEOUT`.
    pub(super) async fn call(&self, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        self.call_with(command, COMMAND_TIMEOUT, cancel).await
    }

    /// One helper round trip within `timeout`; the helper's own failure is the tool's error.
    pub(super) async fn call_with(&self, command: Map<String, Value>, timeout: Duration, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        self.exchange(command, timeout, cancel).await?.map_err(HelperFailure::into_error)
    }

    /// One helper round trip within `timeout`: its result, or its failure with the result it carried. Every reply passes the
    /// restore points, and a window list comes back without Mixdog's own windows.
    pub(super) async fn exchange(&self, command: Map<String, Value>, timeout: Duration, cancel: &CancellationToken) -> Result<Reply, ComputerError> {
        if cancel.is_cancelled() {
            return Err(ComputerError::Cancelled);
        }
        let lists_windows = matches!(text(&command, "action"), "list_windows" | "window_snapshot");
        let receive = self.send(command, cancel).await?;
        let mut reply = self.wait_reply(receive, timeout, cancel).await?;
        let carried = match &reply {
            Ok(result) => Some(result),
            Err(failure) => failure.result.as_ref(),
        };
        if let Some(result) = carried {
            locked(&self.restore_points).observe(result);
        }
        // The observer's hook thread is not restarted by the helper: one that keeps not answering is replaced.
        if self.observer_stuck(&reply) {
            let confirmed = self.retire().await;
            self.pause_unless(confirmed);
        }
        if lists_windows && let Ok(result) = &mut reply {
            computer_internal_windows::filter(self, result, cancel).await;
        }
        Ok(reply)
    }

    /// The reply of a sent command, within `timeout` and the request's cancel. Either one ending the wait retires the helper:
    /// a command it may still be running holds input.
    async fn wait_reply(&self, receive: oneshot::Receiver<Reply>, timeout: Duration, cancel: &CancellationToken) -> Result<Reply, ComputerError> {
        let scope = Scope::new().cancel(cancel).deadline(Some(Instant::now() + timeout));
        match scope.run(receive).await {
            Scoped::Cancelled => {
                // Node aborts the session when a call is cancelled (`client.mjs:113,407`).
                self.abort_session().await;
                Err(ComputerError::Cancelled)
            }
            // The command keeps its own error, as the worker's retire rejects it in Node (`worker-requests.ts:157`); the hold an
            // unconfirmed cleanup leaves refuses the next command.
            Scoped::DeadlineExceeded => {
                let confirmed = self.retire().await;
                self.pause_unless(confirmed);
                Err(ComputerError::Failed {
                    code: "computer_command_timeout".into(),
                    message: format!("computer_command_timeout: command exceeded {}ms; the input host was restarted", timeout.as_millis()),
                })
            }
            Scoped::Done(Err(_)) => {
                let confirmed = self.recover_dead_host().await;
                self.pause_unless(confirmed);
                Err(host_exited())
            }
            Scoped::Done(Ok(reply)) => {
                if matches!(&reply, Err(failure) if failure.result.is_none() && failure.text == HOST_EXITED_TEXT) {
                    let confirmed = self.recover_dead_host().await;
                    self.pause_unless(confirmed);
                }
                Ok(reply)
            }
        }
    }

    /// A single helper action: its result, settled against the windows it started from, shaped as the tool's reply.
    async fn single(&self, action: &str, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let before = computer_settle::before(self, action, &command, cancel).await?;
        let mut result = self.call(command, cancel).await?;
        computer_settle::after(self, action, before, &mut result, cancel).await?;
        computer_reply::single(action, &result)
    }

    /// A read the Node desktop host makes of the helper (`callPowerShell` with `read_only`): under `session`, or the backend's own.
    pub(super) async fn host_read(&self, action: &str, extra: Vec<(&str, Value)>, session: Option<&str>, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
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

    /// The desktop that serves the computer host's reads, or Node's refusal when none does (`client.mjs` `BRIDGE_UNAVAILABLE_MESSAGE`).
    fn desktop(&self) -> Result<&Arc<dyn HostChannel>, ComputerError> {
        match &self.desktop {
            Some(desktop) if desktop.serves(HostCapability::Computer) => Ok(desktop),
            _ => Err(bridge_unavailable()),
        }
    }

    /// One `host/computer/*` request to the desktop's computer host. The host's refusal is the text Node's client gives for a bridge
    /// reply of `{ ok: false, error }`; a request that outlives the client's timeout is `computer bridge timed out`.
    pub(super) async fn ask_desktop(&self, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, ComputerError> {
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
}

impl Drop for ProcessComputerBackend {
    fn drop(&mut self) {
        // Ends watch_for_death's task.
        self.gone.notify_one();
        let held = locked(&self.host).take();
        let Some(host) = held else { return };
        let manager = self.manager.clone();
        let cleanup = self.cleanup().ok();
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

/// A reply envelope: its `result` object, or its `error` text with the `result` an `ok:false` reply carried.
fn envelope(value: Value) -> Reply {
    let Value::Object(mut object) = value else { return Ok(Map::new()) };
    let result = match object.shift_remove("result") {
        Some(Value::Object(result)) => Some(result),
        _ => None,
    };
    if object.get("ok").and_then(Value::as_bool) == Some(false) {
        let text = object.get("error").and_then(Value::as_str).unwrap_or("computer host request failed").to_string();
        return Err(HelperFailure { text, result });
    }
    Ok(result.unwrap_or_default())
}

/// What Node's client answers when no desktop publishes the bridge: an error result of its own, with no recovery.
fn bridge_unavailable() -> ComputerError {
    ComputerError::Failed { code: REPORTED_CODE.into(), message: format!("Error: {BRIDGE_UNAVAILABLE_MESSAGE}") }
}

fn host_exited() -> ComputerError {
    ComputerError::Failed { code: "computer_host_exited".into(), message: "the computer host stopped".into() }
}

pub(super) fn unsupported(reason: &str) -> ComputerError {
    ComputerError::Unavailable { reason: reason.into() }
}

fn host_error(message: &str) -> ComputerError {
    let code = error_code(message);
    ComputerError::Failed { code: if code.is_empty() { "computer_failed".into() } else { code }, message: message.to_string() }
}

pub(super) fn text_of(result: &Map<String, Value>) -> String {
    match result.get("text") {
        Some(Value::String(text)) => text.clone(),
        _ => "OK".into(),
    }
}

/// Tool parts of one helper result: its text, and its image when it carries one
/// (`validateComputerReply` bounds both).
pub(super) fn parts_of(result: &Map<String, Value>) -> Result<Vec<ToolPart>, ComputerError> {
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

#[async_trait]
impl ComputerSecretHost for ProcessComputerBackend {
    async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
        // A handoff secret is typed through the host's router, which refuses input while "Observation only" is on (`find` is a read).
        if let Err(ComputerError::Failed { message, .. }) = computer_policy::admit(&command, self.observe_only()) {
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
        let mut command = host_command(request.action, input)?;
        // The host admits a command before anything of it is queued (`command-queue.ts` `budget.acquire`); the slot is held until it ends.
        let _slot = self.shared.budget.acquire(&self.config.session_id)?;
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
        // `trackComputerSession` (`client.mjs:366-371`) runs for each command sent.
        self.bound.store(true, Ordering::SeqCst);
        self.shared.lane.claim(&self.config.session_id);
        let observe_only = self.observe_only();
        if !self.executing.swap(true, Ordering::SeqCst) {
            if let Some(observer) = &self.observer {
                observer.began(observe_only);
            }
        }
        // The host's admission (`command-admission.ts` `assertCommandPreconditions`) checks the live setting first.
        computer_policy::admit(&command, observe_only)?;
        let name = text(&command, "action").to_string();
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
        // Every command of the host starts with a look at the windows that opened since the session's last one.
        let arrived = computer_settle::arrived_before(self, &name, &cancel).await?;
        computer_targets::resolve(self, &mut command, &cancel).await?;
        let _lane = self.shared.lane.enter(computer_lane::Kind::of(&command), &cancel).await?;
        // The person's hold on the desktop: a takeover refuses the command, a yield answers it, before anything is dispatched.
        let control = &self.shared.user_control;
        if let Some(held) = control.admit(self, &command, &cancel).await? {
            return Ok(held);
        }
        let issued = command.clone();
        let result = match name.as_str() {
            "sequence" => self.act(command, &cancel).await,
            "capture" => self.capture(command, asked_mode, &cancel).await,
            "zoom" => computer_zoom::zoom(self, command, &cancel).await,
            "list_history" => Err(unsupported("list kind=\"history\" needs the desktop host's action ledger")),
            "wait_for_user" => control.wait_for_user(self, &command, &cancel).await,
            "fill_saved_login" => Err(unsupported("saved_login needs the desktop host's secret store")),
            "verify" => computer_verify::run(self, command, &cancel).await,
            "diagnose" => self.diagnose(&command, &cancel).await,
            _ => self.single(&name, command, &cancel).await,
        };
        // The person's input that interrupted the command yields its session, a takeover code hands the desktop back.
        let result = control.settle(self, &issued, result).await;
        // The arrivals report reads the window list for app names: it runs after the lane is given back, as TS reported after
        // runForegroundExclusive returned (`command-attempt.ts`).
        drop(_lane);
        // The fallback's note follows a result that is not an error.
        let mut parts = result?;
        computer_settle::report_arrived(self, &name, arrived, &mut parts, &cancel).await?;
        if let Some(note) = note {
            parts.push(ToolPart::Text(note.into()));
        }
        Ok(parts)
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        computer_policy::admit_screen_input(self.observe_only())?;
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
        ComputerStatus { active, observe_only: self.observe_only(), controller: None }
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
    fn error_codes_and_replies() {
        assert_eq!(error_code("Error: Stale_Target: gone"), "stale_target");
        assert_eq!(error_code("no code here"), "");
        assert_eq!(error_code("capture_source_unavailable|x"), "capture_source_unavailable");
        let result = input(json!({"text":"hi","image_base64":"aGk="}));
        let parts = parts_of(&result).unwrap();
        assert_eq!(parts[0], ToolPart::Text("hi".into()));
        assert_eq!(parts[1], ToolPart::Image { mime: "image/png".into(), data: ImageData::Bytes(b"hi".to_vec()), width: None, height: None });
        assert!(parts_of(&input(json!({"image":{"data":"aGk=","mimeType":"image/gif"}}))).is_err());
        assert_eq!(envelope(json!({"id":1,"ok":false,"error":"x"})), Err(HelperFailure { text: "x".into(), result: None }));
        assert_eq!(leading_id("{\"id\": 42,\"ok\":true"), Some(42));
    }

    /// An `ok:false` reply keeps the `result` it carried (a capture's `capture_cleanup`), and its text is the error as before.
    #[test]
    fn a_failed_reply_keeps_the_result_it_carried() {
        let reply = envelope(json!({"id":1,"ok":false,"error":"capture_failed: x","result":{"capture_cleanup":{"status":"unconfirmed"}}}));
        let failure = reply.unwrap_err();
        assert_eq!(failure.text, "capture_failed: x");
        assert_eq!(failure.result.as_ref().and_then(|result| result.get("capture_cleanup")), Some(&json!({"status":"unconfirmed"})));
        assert_eq!(failure.into_error(), ComputerError::Failed { code: "capture_failed".into(), message: "capture_failed: x".into() });
        assert_eq!(envelope(json!({"id":2,"ok":true,"result":{"text":"a"}})), Ok(input(json!({"text":"a"}))));
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

    /// The readers of a helper with no desktop.
    fn readers(pending: &Pending) -> Readers {
        Readers {
            pending: pending.clone(),
            relay: computer_lease::Relay::new(Arc::new(Answering::default()), ProcessHandle("h".into()), pending.clone(), None),
            pointer: computer_feedback::Pointer::new(None, "s1"),
            gone: Arc::default(),
            live: None,
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
        pump(Box::new(events), readers(&pending), alive.clone(), done).await;
        assert!(!alive.load(Ordering::SeqCst));
        assert!(*exited.borrow());
        let outcomes = locked(&outcomes);
        assert_eq!(outcomes[0].0, 1);
        assert_eq!(outcomes[0].1.as_ref().unwrap().get("text"), Some(&json!("a")));
        assert_eq!(outcomes[1].0, 2);
        assert!(outcomes[1].1.as_ref().unwrap_err().text.starts_with("computer_host_exited"));
    }

    /// Foreground-lease and pointer lines go to their readers: neither answers nor fails the request in flight, even one that
    /// looks like its reply, and the reply that follows them is delivered.
    #[tokio::test]
    async fn side_lines_never_answer_or_fail_a_request() {
        use mixdog_core_api::domain::process::ExitStatus;
        use mixdog_core_api::domain::process::ProcessExit;

        let pending: Pending = Arc::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        locked(&pending).insert(1, Box::new(move |outcome| locked(&into).push(outcome)));
        let output = |seq, text: &str| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: text.as_bytes().to_vec() };
        let events = Script(
            [
                output(0, "@@MIXDOG_FGLOCK@@ acquire 1 1 0 200 5.000\n@@MIXDOG_POINTER@@{\"id\":1,\"ok\":false,\"error\":\"not a reply\"}\n"),
                output(1, "@@MIXDOG_FGLOCK@@{\"id\":1\n@@MIXCU@@{\"id\":1,\"ok\":true,\"result\":{\"text\":\"a\"}}\n"),
                ProcessEvent::Exited { seq: 2, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } },
            ]
            .into(),
        );
        let (done, _exited) = watch::channel(false);
        pump(Box::new(events), readers(&pending), Arc::new(AtomicBool::new(true)), done).await;
        // Had a side line answered or failed request 1, its waiter would hold that outcome and the reply would find none.
        let want: Vec<Reply> = vec![Ok(input(json!({"text":"a"})))];
        assert_eq!(*locked(&seen), want);
    }

    type Feeds = Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<ProcessEvent>>>;

    /// A helper that answers every request line `ok` (except a `hang`, a `fail` that carries a result, and a `chatty` that
    /// writes side lines first) and a cleanup run that exits 0, with no OS process behind it: the backend's own launch, write and
    /// reply code runs, on every platform. It keeps every start and every request line.
    #[derive(Default)]
    struct Answering {
        senders: Feeds,
        receivers: Mutex<HashMap<String, tokio::sync::mpsc::UnboundedReceiver<ProcessEvent>>>,
        seq: AtomicU64,
        spawned: Mutex<Vec<SpawnRequest>>,
        lines: Mutex<Vec<Value>>,
        /// The cleanup runs exit 1 instead of 0.
        failing_cleanup: AtomicBool,
        /// The helper takes every request and answers none of them.
        silent: AtomicBool,
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
            // A helper that already exited has no listener left.
            let _ = sender.send(event(seq));
        }

        fn say(&self, handle: &ProcessHandle, line: String) {
            self.emit(handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: format!("{line}\n").into_bytes() });
        }

        fn exit(seq: u64, killed: Option<mixdog_core_api::domain::process::KillReason>) -> ProcessEvent {
            Self::exit_with(seq, 0, killed)
        }

        fn exit_with(seq: u64, code: i32, killed: Option<mixdog_core_api::domain::process::KillReason>) -> ProcessEvent {
            use mixdog_core_api::domain::process::ExitStatus;
            use mixdog_core_api::domain::process::ProcessExit;
            ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(code), killed } }
        }
    }

    #[async_trait]
    impl ProcessManager for Answering {
        async fn spawn(&self, request: SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, ProcessError> {
            let (send, receive) = tokio::sync::mpsc::unbounded_channel();
            locked(&self.senders).insert(request.handle.0.clone(), send);
            locked(&self.receivers).insert(request.handle.0.clone(), receive);
            locked(&self.spawned).push(request.clone());
            if !request.stdin_piped {
                let code = i32::from(self.failing_cleanup.load(Ordering::SeqCst));
                self.emit(&request.handle, |seq| Self::exit_with(seq, code, None));
            }
            Ok(mixdog_core_api::domain::process::SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let receive = locked(&self.receivers).remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(Feed(receive)))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let request: Value = serde_json::from_slice(&bytes).expect("a request line");
            locked(&self.lines).push(request.clone());
            let id = &request["id"];
            match request["action"].as_str() {
                _ if self.silent.load(Ordering::SeqCst) => {}
                Some("hang") => {}
                Some("die") => self.emit(handle, |seq| Self::exit(seq, None)),
                Some("stuck") => self.say(
                    handle,
                    format!("{RESPONSE_MARKER}{}", json!({"id": id, "ok": true, "result": {"observer_ready": false, "observer_reason": "monitor_unresponsive"}})),
                ),
                Some("ready") => self.say(handle, format!("{RESPONSE_MARKER}{}", json!({"id": id, "ok": true, "result": {"observer_ready": true}}))),
                Some("fail") => self.say(
                    handle,
                    format!("{RESPONSE_MARKER}{}", json!({"id": id, "ok": false, "error": "capture_failed: x", "result": {"capture_cleanup": {"status": "unconfirmed"}}})),
                ),
                Some("chatty") => {
                    self.say(handle, format!("@@MIXDOG_FGLOCK@@ acquire {id} 1 0 200 5.000"));
                    self.say(handle, format!("@@MIXDOG_POINTER@@{}", json!({"id": id, "ok": false, "error": "not a reply"})));
                    self.say(handle, format!("{RESPONSE_MARKER}{}", json!({"id": id, "ok": true, "result": {"text": "ok"}})));
                }
                _ => self.say(handle, format!("{RESPONSE_MARKER}{}", json!({"id": id, "ok": true, "result": {"text": "ok"}}))),
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
        assert_eq!(backend.wait_reply(receive, COMMAND_TIMEOUT, &cancel).await, Err(ComputerError::Cancelled));
        assert_eq!(seen(), ["began:false", "ended"], "a cancelled call aborts the session");
    }

    /// A cleanup the helper cannot confirm (timeout, dead helper, abort) hands the desktop to the user, also once the session's
    /// execution has closed (no session is open here), while the command keeps its own error (`lifecycle-abort.ts:unconfirmedCleanup`).
    #[tokio::test]
    async fn an_unconfirmed_cleanup_hands_the_desktop_to_the_user() {
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let started = || {
            let manager = Arc::new(Answering::default());
            let control = Arc::new(UserControlState::default());
            let shared = ComputerShared { user_control: control.clone(), ..ComputerShared::default() };
            (ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared), manager, control)
        };
        let held = |control: &UserControlState| control.section().map(|section| section.reason);

        let (backend, manager, control) = started();
        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(backend.abort_session().await);
        assert_eq!(held(&control), None, "a confirmed cleanup holds nothing");

        manager.failing_cleanup.store(true, Ordering::SeqCst);
        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(!backend.abort_session().await);
        assert_eq!(held(&control).as_deref(), Some("input_cleanup_unconfirmed"));

        let (backend, manager, control) = started();
        backend.run(read(), CancellationToken::new()).await.unwrap();
        manager.failing_cleanup.store(true, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        let receive = backend.send(input(json!({"action":"hang"})), &cancel).await.unwrap();
        let waited = backend.wait_reply(receive, Duration::from_millis(50), &cancel).await;
        assert!(matches!(waited, Err(ComputerError::Failed { ref code, .. }) if code == "computer_command_timeout"), "{waited:?}");
        assert_eq!(held(&control).as_deref(), Some("input_cleanup_unconfirmed"));

        let (backend, manager, control) = started();
        backend.run(read(), CancellationToken::new()).await.unwrap();
        manager.failing_cleanup.store(true, Ordering::SeqCst);
        let error = backend.call(input(json!({"action":"die"})), &CancellationToken::new()).await.unwrap_err();
        assert!(matches!(&error, ComputerError::Failed { code, .. } if code == "computer_host_exited"), "{error:?}");
        assert_eq!(held(&control).as_deref(), Some("input_cleanup_unconfirmed"));
    }

    /// A cleanup that did not confirm stays latched: Resume retries it once and leaves the desktop with the person while it still
    /// does not confirm, and releases it when it does (`recoverLatchedCleanup`, `resumeByUser`).
    #[tokio::test]
    async fn a_latched_cleanup_is_recovered_before_resume() {
        let manager = Arc::new(Answering::default());
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let shared = ComputerShared { user_control: control.clone(), ..ComputerShared::default() };
        let backend = Arc::new(ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared));
        control.register("s1", Arc::downgrade(&backend));
        let read = ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        backend.run(read, CancellationToken::new()).await.unwrap();
        manager.failing_cleanup.store(true, Ordering::SeqCst);
        assert!(!backend.abort_session().await);
        assert!(control.is_latched());
        assert_eq!(control.section().map(|section| section.reason).as_deref(), Some("input_cleanup_unconfirmed"));
        assert!(!control.resume_verified(None).await, "the click alone does not clear it");
        assert!(control.is_latched() && control.section().is_some());
        manager.failing_cleanup.store(false, Ordering::SeqCst);
        assert!(control.resume_verified(None).await);
        assert!(!control.is_latched());
        assert_eq!(control.section(), None);
    }

    /// A session holds four commands pending (`createComputerCommandBudget`): the fifth concurrent one through `run` is refused with
    /// nothing queued, in the host's words, and a command that ended frees its slot.
    #[tokio::test]
    async fn the_fifth_concurrent_command_of_a_session_is_refused() {
        let manager = Arc::new(Answering::default());
        manager.silent.store(true, Ordering::SeqCst);
        let shared = ComputerShared::default();
        let backend = Arc::new(ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared.clone()));
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        let tokens: Vec<CancellationToken> = (0..4).map(|_| CancellationToken::new()).collect();
        let running: Vec<_> = tokens
            .iter()
            .map(|token| {
                let (backend, token) = (backend.clone(), token.clone());
                tokio::spawn(async move { backend.run(read(), token).await })
            })
            .collect();
        for _ in 0..500 {
            if shared.budget.pending_of("s1") == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(shared.budget.pending_of("s1"), 4, "four commands are pending");
        let sent = locked(&manager.lines).len();
        let fifth = backend.run(read(), CancellationToken::new()).await;
        assert!(
            matches!(&fifth, Err(ComputerError::Failed { code, message })
                if code == "computer_capacity_exhausted" && message == "computer_capacity_exhausted: pending command limit reached; no input was queued"),
            "{fifth:?}"
        );
        assert_eq!(locked(&manager.lines).len(), sent, "the refused command wrote nothing to the helper");
        assert_eq!(shared.budget.pending_of("s1"), 4, "a refused command takes no slot");
        for token in &tokens {
            token.cancel();
        }
        for task in running {
            assert!(task.await.unwrap().is_err(), "a cancelled command ends in an error");
        }
        assert_eq!(shared.budget.pending_of("s1"), 0, "the slots came back");
    }

    /// One marker per backend, in the helper's range: the resident helper, its `--abort-cleanup` run and the helper started
    /// again after the abort all carry it, so the cleanup releases exactly what the helper injected.
    #[tokio::test]
    async fn the_resident_helper_and_its_cleanup_carry_one_input_marker() {
        let manager = Arc::new(Answering::default());
        let data = tempfile::tempdir().unwrap();
        let config = ComputerConfig { data_dir: Some(data.path().to_path_buf()), ..ComputerConfig::new("helper", "s1") };
        let backend = ProcessComputerBackend::new(config, manager.clone());
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };
        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(backend.abort_session().await);
        backend.run(read(), CancellationToken::new()).await.unwrap();

        let spawned = locked(&manager.spawned).clone();
        let args = |request: &SpawnRequest| match &request.command {
            CommandSpec::Argv { args, .. } => args.clone(),
            other => panic!("an argv command, got {other:?}"),
        };
        assert_eq!(spawned.iter().map(args).collect::<Vec<_>>(), [vec![], vec!["--abort-cleanup".to_owned()], vec![]], "resident, cleanup, resident");
        let markers: Vec<Option<String>> = spawned
            .iter()
            .map(|request| request.env.set.iter().find(|(name, _)| name == "MIXDOG_COMPUTER_INPUT_MARKER").map(|(_, value)| value.clone()))
            .collect();
        let marker: i64 = markers[0].as_deref().expect("the resident helper carries the marker").parse().expect("a number");
        assert!((1..=i64::from(i32::MAX)).contains(&marker), "{marker}");
        assert!(markers.iter().all(|each| *each == markers[0]), "{markers:?}");
        // The ledger the resident helper records into is the one the cleanup run replays.
        let ledgers: Vec<Option<String>> = spawned
            .iter()
            .map(|request| request.env.set.iter().find(|(name, _)| name == "MIXDOG_COMPUTER_INACTIVE_LEDGER").map(|(_, value)| value.clone()))
            .collect();
        assert!(ledgers[0].is_some() && ledgers.iter().all(|each| *each == ledgers[0]), "{ledgers:?}");
        assert!(data.path().join("computer").join("ledgers").is_dir());
        // No desktop offers the lock here.
        assert!(spawned.iter().all(|request| request.env.set.iter().all(|(name, _)| name != "MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK")));
        // Every run is the computer helper's (its job lets the cursor watchdog break away); only the cleanup is time-limited.
        assert!(spawned.iter().all(|request| matches!(request.owner, ProcessOwner::ComputerHelper)));
        let limits: Vec<Option<Duration>> = spawned.iter().map(|request| request.time_limit).collect();
        assert_eq!(limits, [None, Some(ABORT_CLEANUP_TIME_LIMIT), None]);
    }

    /// The request a helper run is made from names the computer helper as its owner.
    #[test]
    fn a_helper_request_is_owned_by_the_computer_helper() {
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()));
        let request = backend.request(vec![], true, vec![]).unwrap();
        assert!(matches!(request.owner, ProcessOwner::ComputerHelper));
        assert_eq!(request.time_limit, None);
    }

    fn cleanup_args(spawned: &[SpawnRequest]) -> Vec<&'static str> {
        spawned
            .iter()
            .map(|request| match &request.command {
                CommandSpec::Argv { args, .. } if args.first().is_some_and(|arg| arg == "--abort-cleanup") => "cleanup",
                CommandSpec::Argv { .. } => "resident",
                _ => "other",
            })
            .collect()
    }

    async fn wait_dead(backend: &ProcessComputerBackend) {
        for _ in 0..1_000 {
            let dead = locked(&backend.host).as_ref().is_some_and(|host| !host.alive.load(Ordering::SeqCst));
            if dead {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("the helper did not register its exit");
    }

    /// A helper that exits while a request waits on it is cleaned up (`--abort-cleanup`) before the next one starts.
    #[tokio::test]
    async fn a_helper_that_exits_during_a_request_is_cleaned_up() {
        let manager = Arc::new(Answering::default());
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone());
        let cancel = CancellationToken::new();
        let error = backend.call(input(json!({"action":"die"})), &cancel).await.unwrap_err();
        assert!(matches!(&error, ComputerError::Failed { code, .. } if code == "computer_host_exited"), "{error:?}");
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup"]);
        backend.call(input(json!({"action":"clipboard_read"})), &cancel).await.unwrap();
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup", "resident"]);
    }

    /// A helper that exits between requests is cleaned up before its replacement starts, and when an execution ends.
    #[tokio::test]
    async fn a_helper_that_exits_between_requests_is_cleaned_up_before_a_respawn() {
        let manager = Arc::new(Answering::default());
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone());
        let cancel = CancellationToken::new();
        let exit_helper = || {
            let handle = locked(&manager.spawned).last().expect("a helper").handle.clone();
            manager.emit(&handle, |seq| Answering::exit(seq, None));
        };
        backend.call(input(json!({"action":"clipboard_read"})), &cancel).await.unwrap();
        exit_helper();
        wait_dead(&backend).await;
        backend.call(input(json!({"action":"clipboard_read"})), &cancel).await.unwrap();
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup", "resident"]);

        backend.executing.store(true, Ordering::SeqCst);
        exit_helper();
        wait_dead(&backend).await;
        assert!(backend.end_execution().await);
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup", "resident", "cleanup"]);
        assert!(!backend.has_live_host());
    }

    /// A helper that exits with no request waiting is cleaned up when its exit is seen, and once: the next command only starts
    /// the replacement.
    #[tokio::test]
    async fn a_helper_that_exits_while_idle_is_cleaned_up_when_it_is_seen() {
        let manager = Arc::new(Answering::default());
        let backend = Arc::new(ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()));
        backend.watch_for_death();
        let cancel = CancellationToken::new();
        backend.call(input(json!({"action":"clipboard_read"})), &cancel).await.unwrap();
        let handle = locked(&manager.spawned).last().expect("a helper").handle.clone();
        manager.emit(&handle, |seq| Answering::exit(seq, None));
        for _ in 0..1_000 {
            if cleanup_args(&locked(&manager.spawned)) == ["resident", "cleanup"] {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup"]);
        backend.call(input(json!({"action":"clipboard_read"})), &cancel).await.unwrap();
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup", "resident"]);
    }

    /// A helper whose observer keeps answering `monitor_unresponsive` is retired; one reply that says it is ready starts the count over.
    #[tokio::test]
    async fn a_helper_with_an_unresponsive_observer_is_retired() {
        let manager = Arc::new(Answering::default());
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone());
        let cancel = CancellationToken::new();
        for action in ["stuck", "stuck", "ready", "stuck", "stuck"] {
            backend.call(input(json!({"action": action})), &cancel).await.unwrap();
        }
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident"]);
        assert!(backend.has_live_host());
        backend.call(input(json!({"action":"stuck"})), &cancel).await.unwrap();
        assert_eq!(cleanup_args(&locked(&manager.spawned)), ["resident", "cleanup"]);
        assert!(!backend.has_live_host());
    }

    /// A failure's text counts toward the limit only when it says the observation was lost to the monitor; a frame from before a
    /// respawn ("original observation is unavailable (monitor_unresponsive)") is not the observer of this helper failing.
    #[test]
    fn only_a_lost_observation_text_counts_as_an_unresponsive_observer() {
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()));
        let failed = |text: &str| -> Reply { Err(HelperFailure { text: text.into(), result: None }) };
        let stale = "input_observation_unavailable: original observation is unavailable (monitor_unresponsive)";
        for _ in 0..UNRESPONSIVE_LIMIT + 1 {
            assert!(!backend.observer_stuck(&failed(stale)));
        }
        let lost = "input_observation_unavailable: input observation lost (monitor_unresponsive)";
        let stuck: Vec<bool> = (0..UNRESPONSIVE_LIMIT).map(|_| backend.observer_stuck(&failed(lost))).collect();
        assert_eq!(stuck, [false, false, true]);
    }

    /// The ledgers a dead core left are replayed once, before the first helper of this process starts, each with the marker its
    /// name carries, and removed once confirmed; a later backend on the same folder does not touch the ledgers there.
    #[tokio::test]
    async fn the_ledgers_a_dead_core_left_are_swept_before_the_first_helper() {
        let manager = Arc::new(Answering::default());
        let data = tempfile::tempdir().unwrap();
        let folder = computer_env::ledger_folder(data.path());
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("old-123.ledger"), b"x").unwrap();
        std::fs::write(folder.join("keep.txt"), b"x").unwrap();
        let config = ComputerConfig { data_dir: Some(data.path().to_path_buf()), ..ComputerConfig::new("helper", "s1") };
        let backend = ProcessComputerBackend::new(config.clone(), manager.clone());
        backend.call(input(json!({"action":"clipboard_read"})), &CancellationToken::new()).await.unwrap();

        let spawned = locked(&manager.spawned).clone();
        assert_eq!(cleanup_args(&spawned), ["cleanup", "resident"]);
        let env = |name: &str| spawned[0].env.set.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
        assert_eq!(env("MIXDOG_ABORT_LEDGERS"), Some(folder.join("old-123.ledger").to_string_lossy().into_owned()));
        assert_eq!(env("MIXDOG_COMPUTER_INPUT_MARKER").as_deref(), Some("123"));
        assert_eq!(env("MIXDOG_COMPUTER_INACTIVE_LEDGER"), None);
        assert!(!folder.join("old-123.ledger").exists() && folder.join("keep.txt").exists());

        std::fs::write(folder.join("live-9.ledger"), b"x").unwrap();
        let second = Arc::new(Answering::default());
        let other = ProcessComputerBackend::new(ComputerConfig { session_id: "s2".into(), ..config }, second.clone());
        other.call(input(json!({"action":"clipboard_read"})), &CancellationToken::new()).await.unwrap();
        assert_eq!(cleanup_args(&locked(&second.spawned)), ["resident"]);
        assert!(folder.join("live-9.ledger").exists());
    }

    /// A failed reply's `result` reaches the reader that asks for it, while `call` reports the failure's text as before.
    #[tokio::test]
    async fn a_helper_failure_reaches_the_caller_with_its_result() {
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()));
        let cancel = CancellationToken::new();
        let failure = backend.exchange(input(json!({"action":"fail"})), COMMAND_TIMEOUT, &cancel).await.unwrap().unwrap_err();
        assert_eq!(failure.result.as_ref().and_then(|result| result.get("capture_cleanup")), Some(&json!({"status":"unconfirmed"})));
        assert_eq!(
            backend.call(input(json!({"action":"fail"})), &cancel).await,
            Err(ComputerError::Failed { code: "capture_failed".into(), message: "capture_failed: x".into() })
        );
        assert!(backend.status().active, "a refusal leaves the helper running");
    }

    /// `list kind="apps"` is the helper's own `list_apps`, a read.
    #[tokio::test]
    async fn the_app_list_is_the_helpers_list_apps() {
        let manager = Arc::new(Answering::default());
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone());
        backend.run(ComputerRequest { action: ComputerAction::List, input: json!({"kind":"apps","query":"x"}) }, CancellationToken::new()).await.unwrap();
        let sent: Vec<Value> = locked(&manager.lines).iter().filter(|line| line["action"] != "window_snapshot").cloned().collect();
        assert_eq!(sent.iter().map(|line| line["action"].clone()).collect::<Vec<_>>(), [json!("list_apps")]);
        assert_eq!(sent[0]["query"], "x");
    }

    /// A helper that writes foreground-lease and pointer lines before its reply still answers the request with that reply.
    #[tokio::test]
    async fn side_lines_from_a_running_helper_are_consumed() {
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), Arc::new(Answering::default()));
        let result = backend.call(input(json!({"action":"chatty"})), &CancellationToken::new()).await.unwrap();
        assert_eq!(result.get("text"), Some(&json!("ok")));
        assert!(backend.status().active);
    }

    /// The observation-only setting is read on every call: turned on between two executions, the second opens observing only
    /// and its request goes to the helper as a read-only run, while the release that ends it never does.
    #[tokio::test]
    async fn the_observation_only_setting_is_read_on_every_call() {
        let manager = Arc::new(Answering::default());
        let edges = Arc::new(Edges::default());
        let on = Arc::new(AtomicBool::new(false));
        let setting = on.clone();
        let shared = ComputerShared { observe_only: Arc::new(move || setting.load(Ordering::SeqCst)), ..ComputerShared::default() };
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared).with_observer(edges.clone());
        let read = || ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) };

        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(!backend.status().observe_only);
        assert!(backend.end_execution().await);
        on.store(true, Ordering::SeqCst);
        backend.run(read(), CancellationToken::new()).await.unwrap();
        assert!(backend.status().observe_only);
        assert!(backend.end_execution().await);

        assert_eq!(*locked(&edges.0), ["began:false", "ended", "began:true", "ended"]);
        let read_only: Vec<(Value, Option<Value>)> = locked(&manager.lines)
            .iter()
            .filter(|line| line["action"] != "window_snapshot")
            .map(|line| (line["action"].clone(), line.get("read_only").cloned()))
            .collect();
        assert_eq!(
            read_only,
            [
                (json!("clipboard_read"), None),
                (json!("release_held_input"), None),
                (json!("clipboard_read"), Some(json!(true))),
                (json!("release_held_input"), None)
            ]
        );
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
            let ended = backend.wait_reply(receive, COMMAND_TIMEOUT, &cancel).await;

            assert_eq!(ended, Err(ComputerError::Cancelled));
            assert!(written(dir.path().join("cleanup")).is_some());
            assert!(!backend.status().active);
        }
    }
}
