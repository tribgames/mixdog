//! Terminal tabs (DS §6.3): the tab layer over PTY handles of the one process manager. A tab is a
//! PTY process owned by `ProcessOwner::TerminalTab` plus what the Node `terminal-manager.ts` kept
//! beside it: the replay window, shell-integration markers and the activity they drive, the
//! size owner, and output flow control. No part of it arms a timer: focus and size ownership end
//! when a view unfocuses or its connection closes, and held-back marker text is released by the
//! next chunk or the end of the stream.

mod bridge;
mod integration;
mod markers;
mod profiles;
mod replay;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::TerminalTabId;
use tokio::sync::OnceCell;
use tokio::sync::watch;

pub use bridge::Action;
pub use bridge::BridgeBackend;
pub use bridge::BridgeOptions;
pub use bridge::ExecPolicy;
pub use bridge::TerminalBridge;
pub use bridge::TerminalBridgeHost;
pub use bridge::ToolText;
pub use bridge::Validated;
pub use bridge::render;
pub use bridge::terminal_command_input;
pub use bridge::validate_args;
pub use integration::Integration;
pub use integration::SpawnPlan;
pub use integration::SpawnProfile;
pub use integration::plan_shell_integration;
pub use markers::ActivityState;
pub use markers::ActivityTracker;
pub use markers::Marker;
pub use markers::MarkerScanner;
pub use markers::Utf8Decoder;
pub use profiles::ShellProfile;
pub use profiles::ShellProfileInfo;
pub use replay::REPLAY_BUFFER_LIMIT;
pub use replay::Replay;
pub use replay::ReplayBuffer;
pub use replay::cursor_epoch;

use crate::manager::ExitHook;
use crate::manager::LocalProcessManager;
use crate::manager::OutputFilter;
use crate::manager::SpawnOptions;

/// Variables of the daemon's own identity that a user-facing child must not inherit (the
/// environment scrub of `env-scrub.mjs`).
pub const CHILD_ENV_SCRUB: &[&str] = &[
    "MIXDOG_ROOT",
    "NODE_ENV",
    "MIXDOG_DAEMON_HOST",
    "MIXDOG_WORKER_MODE",
    "MIXDOG_DAEMON_SPAWNED_FOR",
    "MIXDOG_SUPERVISOR_PID",
    "MIXDOG_SERVER_PID",
    "ELECTRON_RUN_AS_NODE",
];

/// Who owns a PTY's size right now.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SizeOwner {
    pub cols: u16,
    pub rows: u16,
    pub owner: String,
}

/// Ownership of a PTY's size changed. `owner` is empty and the size zero when nobody owns it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SizeOwnerChange {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    pub owner: String,
}

/// Where tab changes go (sections `terminalActivity` and the size-owner notification). Called
/// under the tab's lock, so changes arrive in order: an implementation only enqueues.
pub trait TerminalEvents: Send + Sync {
    /// `None` = unknown (no integration, or the shell exited).
    fn activity(&self, id: &str, state: Option<ActivityState>);
    fn size_owner(&self, change: &SizeOwnerChange);
}

pub struct TerminalConfig {
    /// Mixdog's own directory for shell startup files; without it only file-less integrations
    /// (PowerShell, cmd) apply.
    pub shell_integration_dir: Option<PathBuf>,
    /// Environment variables a tab's shell must not inherit.
    pub env_remove: Vec<String>,
    pub replay_limit: usize,
    /// Wall clock in milliseconds; read once per spawn, for the cursor epoch.
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub events: Arc<dyn TerminalEvents>,
}

impl TerminalConfig {
    pub fn new(events: Arc<dyn TerminalEvents>) -> Self {
        Self {
            shell_integration_dir: None,
            env_remove: CHILD_ENV_SCRUB.iter().map(|v| (*v).to_owned()).collect(),
            replay_limit: REPLAY_BUFFER_LIMIT,
            now_ms: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64)
            }),
            events,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TerminalError {
    /// The manager was disposed.
    Disposed,
    /// The working directory is not an absolute path.
    InvalidCwd,
    Process(ProcessError),
}

/// `terminal/ensure` arguments beyond the tab id.
#[derive(Clone, Default, Debug)]
pub struct EnsureRequest {
    pub cwd: Option<String>,
    /// The resolved profile (see [`TerminalTabs::resolve_profile`]); `None` = the platform default.
    pub profile: Option<SpawnProfile>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

/// What a view gets on opening or reattaching to a tab.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Attached {
    pub id: String,
    pub replay: String,
    /// The size a connected view owns, which the opening view must follow.
    pub size_owner: Option<SizeOwner>,
}

/// One tab of a session's terminal, as the agent `terminal` tool sees it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SessionTab {
    pub tab: u32,
    pub id: String,
    pub shell: String,
    pub running: bool,
    pub cwd: Option<String>,
}

/// One open tab as the `terminalTabs` section lists it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TabEntry {
    pub id: String,
    pub shell: String,
    pub running: bool,
    pub cwd: Option<String>,
    pub size_owner: Option<SizeOwner>,
}

const SESSION_TERMINAL_PREFIX: &str = "session-terminal:";
const DEFAULT_COLS: u32 = 80;
const DEFAULT_ROWS: u32 = 24;

fn valid_id_chars(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len())
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `term_[A-Za-z0-9_-]{1,120}` or `session-terminal:<id>[:<n>]`.
fn requestable_id(id: &str) -> bool {
    if let Some(rest) = id.strip_prefix("term_") {
        return valid_id_chars(rest, 120);
    }
    let Some(rest) = id.strip_prefix(SESSION_TERMINAL_PREFIX) else {
        return false;
    };
    match rest.split_once(':') {
        None => valid_id_chars(rest, 120),
        Some((session, tab)) => {
            valid_id_chars(session, 120)
                && (1..=3).contains(&tab.len())
                && tab.bytes().all(|b| b.is_ascii_digit())
                && !tab.starts_with('0')
        }
    }
}

/// Shell label for a spawn path: `C:\...\pwsh.exe` -> `pwsh`.
fn shell_label(shell: &str) -> String {
    let file = shell.rsplit(['\\', '/']).next().unwrap_or(shell);
    let stem = if file.len() > 4 && file[file.len() - 4..].eq_ignore_ascii_case(".exe") {
        &file[..file.len() - 4]
    } else {
        file
    };
    if stem.is_empty() { shell.to_owned() } else { stem.to_owned() }
}

/// Slash-normalized, trailing-slash-free path; case-folded on Windows and macOS.
fn normalize_root(value: &str) -> String {
    let path = value.replace('\\', "/");
    let path = path.trim_end_matches('/');
    if cfg!(any(windows, target_os = "macos")) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

/// `path` is `root` or lies inside it (the rule `dispose_under` uses).
pub fn is_path_under_root(root: &str, path: &str) -> bool {
    let base = normalize_root(root);
    let target = if path.is_empty() { String::new() } else { normalize_root(path) };
    !base.is_empty()
        && !target.is_empty()
        && (target == base || target.starts_with(&format!("{base}/")))
}

fn clamp_size(value: u32, default: u32, max: u32) -> u16 {
    (if value == 0 { default } else { value }).clamp(2, max) as u16
}

struct TabState {
    buffer: ReplayBuffer,
    /// Present only when the shell runs Mixdog's integration.
    scanner: Option<MarkerScanner>,
    decoder: Utf8Decoder,
    activity: ActivityTracker,
    exited: bool,
    output_paused: bool,
    size: (u16, u16),
    /// The last size each connection reported for this tab.
    client_sizes: HashMap<String, (u16, u16)>,
    /// The connection that last focused the tab.
    owner: Option<String>,
}

struct Tab {
    id: String,
    handle: ProcessHandle,
    shell: String,
    cwd: Option<String>,
    /// Lock order, outermost first: `TerminalTabs::tabs`, `TerminalTabs::cursor_floors`,
    /// `Tab::pty_gate`, `Tab::state`. No code holds `state` while calling the process manager or
    /// taking an earlier lock: it copies what it needs out and drops the guard first.
    state: Mutex<TabState>,
    /// Serializes the calls that push `state` to the PTY (resize, flow control) so they land in
    /// the order the state changed; each re-reads the latest state under it. A call that blocks
    /// in the PTY holds this gate only, never `state`.
    pty_gate: Mutex<()>,
    events: Arc<dyn TerminalEvents>,
    manager: LocalProcessManager,
}

impl Tab {
    fn lock(&self) -> MutexGuard<'_, TabState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn gate(&self) -> MutexGuard<'_, ()> {
        self.pty_gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn publish(&self, change: Option<Option<ActivityState>>) {
        if let Some(state) = change {
            self.events.activity(&self.id, state);
        }
    }

    fn owner_of(state: &TabState) -> Option<SizeOwner> {
        let owner = state.owner.as_ref()?;
        let (cols, rows) = state.client_sizes.get(owner).copied().unwrap_or(state.size);
        Some(SizeOwner {
            cols,
            rows,
            owner: owner.clone(),
        })
    }

    fn announce(&self, before: Option<SizeOwner>, state: &TabState) {
        let after = Self::owner_of(state);
        if before == after {
            return;
        }
        self.events.size_owner(&SizeOwnerChange {
            id: self.id.clone(),
            cols: after.as_ref().map_or(0, |o| o.cols),
            rows: after.as_ref().map_or(0, |o| o.rows),
            owner: after.map(|o| o.owner).unwrap_or_default(),
        });
    }

    /// Applies the tab's current size to its PTY. Called without the state lock.
    fn sync_size(&self) {
        let _gate = self.gate();
        let ((cols, rows), exited) = {
            let state = self.lock();
            (state.size, state.exited)
        };
        if !exited {
            // A racing exit is not an error.
            let _ = self.manager.resize_pty(&self.handle, PtySize { cols, rows });
        }
    }

    /// Applies the tab's current output pause to its reader. Called without the state lock.
    fn sync_pause(&self) {
        let _gate = self.gate();
        let paused = self.lock().output_paused;
        let _ = self.manager.set_output_paused(&self.handle, paused);
    }

    fn running(&self) -> bool {
        !self.lock().exited
    }
}

/// Runs on the PTY's reader thread: markers out, bytes decoded to text, text into the replay
/// window. What it returns is what the feed carries, so feed events are always whole UTF-8.
struct TabFilter(Arc<Tab>);

impl OutputFilter for TabFilter {
    fn filter(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut state = self.0.lock();
        let decoded = state.decoder.push(bytes);
        let (text, markers) = match state.scanner.as_mut() {
            Some(scanner) => scanner.scan(&decoded),
            None => (decoded, Vec::new()),
        };
        state.buffer.append(&text);
        for marker in markers {
            let change = state.activity.marker(marker);
            self.0.publish(change);
        }
        text.into_bytes()
    }

    fn finish(&mut self) -> Vec<u8> {
        let mut state = self.0.lock();
        let mut text = state.scanner.as_mut().map(MarkerScanner::flush).unwrap_or_default();
        text.push_str(&state.decoder.finish());
        state.buffer.append(&text);
        text.into_bytes()
    }
}

enum Slot {
    /// A spawn for this id is under way; waiters are woken when the sender is dropped.
    Spawning(watch::Receiver<()>),
    Live(Arc<Tab>),
}

/// Holds the id's spawn slot; whatever the outcome, dropping it wakes the waiters.
struct SpawnGuard {
    tabs: Arc<Mutex<HashMap<String, Slot>>>,
    id: String,
    _done: watch::Sender<()>,
}

impl SpawnGuard {
    fn finish(self, tab: Option<Arc<Tab>>) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        match tab {
            Some(tab) => {
                tabs.insert(self.id.clone(), Slot::Live(tab));
            }
            None => {
                if matches!(tabs.get(&self.id), Some(Slot::Spawning(_))) {
                    tabs.remove(&self.id);
                }
            }
        }
    }
}

impl Drop for SpawnGuard {
    fn drop(&mut self) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(tabs.get(&self.id), Some(Slot::Spawning(_))) {
            tabs.remove(&self.id);
        }
    }
}

pub struct TerminalTabs {
    manager: LocalProcessManager,
    config: TerminalConfig,
    tabs: Arc<Mutex<HashMap<String, Slot>>>,
    cursor_floors: Mutex<HashMap<String, u64>>,
    sequence: AtomicU64,
    disposed: std::sync::atomic::AtomicBool,
    profiles: OnceCell<Vec<ShellProfile>>,
}

enum Claim {
    Reattach(Arc<Tab>),
    Wait(watch::Receiver<()>),
    Spawn {
        guard: SpawnGuard,
        prior: Option<Arc<Tab>>,
    },
}

impl TerminalTabs {
    pub fn new(manager: LocalProcessManager, config: TerminalConfig) -> Self {
        Self {
            manager,
            config,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            cursor_floors: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            disposed: std::sync::atomic::AtomicBool::new(false),
            profiles: OnceCell::new(),
        }
    }

    fn table(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
        self.tabs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn live(&self, id: &str) -> Option<Arc<Tab>> {
        match self.table().get(id) {
            Some(Slot::Live(tab)) => Some(Arc::clone(tab)),
            _ => None,
        }
    }

    fn running(&self, id: &str) -> Option<Arc<Tab>> {
        self.live(id).filter(|tab| tab.running())
    }

    fn all_tabs(&self) -> Vec<Arc<Tab>> {
        self.table()
            .values()
            .filter_map(|slot| match slot {
                Slot::Live(tab) => Some(Arc::clone(tab)),
                Slot::Spawning(_) => None,
            })
            .collect()
    }

    fn is_disposed(&self) -> bool {
        self.disposed.load(Ordering::Acquire)
    }

    // ----- profiles -------------------------------------------------------------------------

    async fn detected(&self) -> &Vec<ShellProfile> {
        self.profiles
            .get_or_init(|| profiles::detect(&self.manager))
            .await
    }

    /// Every shell found on this machine, for the terminal strip's picker.
    pub async fn profiles(&self) -> Vec<ShellProfileInfo> {
        profiles::list(self.detected().await)
    }

    /// Resolves a client-chosen profile id (see [`profiles::resolve`]).
    pub async fn resolve_profile(&self, id: &str) -> Option<SpawnProfile> {
        profiles::resolve(self.detected().await, id)
    }

    // ----- ensure / attach ------------------------------------------------------------------

    fn attached(&self, tab: &Tab) -> Attached {
        let state = tab.lock();
        Attached {
            id: tab.id.clone(),
            replay: state.buffer.read(),
            size_owner: Tab::owner_of(&state),
        }
    }

    fn claim(&self, id: &str) -> Claim {
        let mut table = self.table();
        let prior = match table.get(id) {
            Some(Slot::Live(tab)) if tab.running() => return Claim::Reattach(Arc::clone(tab)),
            Some(Slot::Spawning(rx)) => return Claim::Wait(rx.clone()),
            Some(Slot::Live(tab)) => Some(Arc::clone(tab)),
            None => None,
        };
        let (tx, rx) = watch::channel(());
        table.insert(id.to_owned(), Slot::Spawning(rx));
        Claim::Spawn {
            guard: SpawnGuard {
                tabs: Arc::clone(&self.tabs),
                id: id.to_owned(),
                _done: tx,
            },
            prior,
        }
    }

    /// Attaches to a PTY that is already running, never starting one: its id and replay, or
    /// `None` when it is not running (never started, exited, disposed). A spawn already under
    /// way for the id is waited for. Warm-ups use this; only a real open ensures.
    pub async fn attach(&self, id: &str) -> Option<Attached> {
        if self.is_disposed() || id.is_empty() {
            return None;
        }
        loop {
            let waiting = match self.table().get(id) {
                Some(Slot::Spawning(rx)) => Some(rx.clone()),
                _ => None,
            };
            match waiting {
                Some(mut rx) => {
                    let _ = rx.changed().await;
                }
                None => break,
            }
        }
        let tab = self.running(id)?;
        Some(self.attached(&tab))
    }

    /// Creates (or reuses) a PTY; the result carries the id and replay for reattach. Concurrent
    /// ensures for one id share a single spawn.
    pub async fn ensure(&self, id: Option<&str>, request: EnsureRequest) -> Result<Attached, TerminalError> {
        if self.is_disposed() {
            return Err(TerminalError::Disposed);
        }
        let requested = id.filter(|id| requestable_id(id));
        let tab_id = match requested {
            Some(id) => id.to_owned(),
            None => format!(
                "term_{}_{}",
                std::process::id(),
                self.sequence.fetch_add(1, Ordering::AcqRel) + 1
            ),
        };
        loop {
            match self.claim(&tab_id) {
                Claim::Reattach(tab) => return Ok(self.attached(&tab)),
                Claim::Wait(mut rx) => {
                    let _ = rx.changed().await;
                }
                Claim::Spawn { guard, prior } => {
                    let spawned = self.spawn_tab(&tab_id, prior, &request).await;
                    return match spawned {
                        Ok(tab) => {
                            let attached = self.attached(&tab);
                            guard.finish(Some(tab));
                            Ok(attached)
                        }
                        Err(error) => {
                            guard.finish(None);
                            Err(error)
                        }
                    };
                }
            }
        }
    }

    /// Waits until the previous process of `handle` is gone (a disposed tab's kill is issued
    /// inline but its exit arrives as an event), so the id can be reused at once.
    async fn wait_gone(&self, handle: &ProcessHandle) {
        if self.manager.info(handle).is_err() {
            return;
        }
        let Ok(mut events) = self.manager.subscribe(handle, None) else {
            return;
        };
        // Checked after subscribing: the exit is recorded before its event is published, so no
        // exit can fall between the check and the subscription.
        if self.manager.info(handle).is_ok_and(|info| info.exit.is_some()) {
            return;
        }
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                break;
            }
        }
    }

    /// Where a respawned tab's cursors start. Cursors start at a creation-time epoch, so a cursor
    /// issued before a restart (whose floors are gone) still falls below the oldest retained
    /// position. The prior tab's lock and `cursor_floors` are taken one after the other, never
    /// nested.
    fn start_cursor(&self, tab_id: &str, prior: Option<&Tab>) -> u64 {
        let from_prior = prior.map(|tab| tab.lock().buffer.cursor());
        let from_floors = self
            .cursor_floors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(tab_id)
            .copied();
        let floor = from_floors.into_iter().chain(from_prior).max();
        floor
            .map_or(0, |floor| floor + 1)
            .max(cursor_epoch((self.config.now_ms)()))
    }

    async fn spawn_tab(
        &self,
        tab_id: &str,
        prior: Option<Arc<Tab>>,
        request: &EnsureRequest,
    ) -> Result<Arc<Tab>, TerminalError> {
        let handle = ProcessHandle::from(tab_id);
        self.wait_gone(&handle).await;
        if self.is_disposed() {
            return Err(TerminalError::Disposed);
        }
        let shell = request.profile.clone().unwrap_or_else(|| SpawnProfile {
            path: if cfg!(windows) {
                "powershell.exe".to_owned()
            } else {
                std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "bash".to_owned())
            },
            ..SpawnProfile::default()
        });
        let plan = plan_shell_integration(
            &shell,
            self.config.shell_integration_dir.as_deref(),
            &|name| std::env::var(name).ok(),
            cfg!(windows),
        );
        let cwd = match request.cwd.as_deref().filter(|c| !c.is_empty()) {
            Some(cwd) => PathBuf::from(cwd),
            None => ["USERPROFILE", "HOME"]
                .iter()
                .find_map(|name| std::env::var_os(name).filter(|v| !v.is_empty()))
                .map(PathBuf::from)
                .or_else(|| std::env::current_dir().ok())
                .ok_or(TerminalError::InvalidCwd)?,
        };
        let cwd_text = request.cwd.clone().filter(|c| !c.is_empty());
        let cwd = AbsPath::new(cwd).ok_or(TerminalError::InvalidCwd)?;
        let cols = clamp_size(request.cols.unwrap_or(0), DEFAULT_COLS, 500);
        let rows = clamp_size(request.rows.unwrap_or(0), DEFAULT_ROWS, 200);

        let start = self.start_cursor(tab_id, prior.as_deref());
        let infer_start = plan.integration == Some(Integration::Cmd);
        let tab = Arc::new(Tab {
            id: tab_id.to_owned(),
            handle: handle.clone(),
            shell: shell_label(&shell.path),
            cwd: cwd_text,
            state: Mutex::new(TabState {
                buffer: ReplayBuffer::new(self.config.replay_limit, start),
                scanner: plan.integration.map(|_| MarkerScanner::default()),
                decoder: Utf8Decoder::default(),
                activity: ActivityTracker::new(infer_start),
                exited: false,
                output_paused: false,
                size: (cols, rows),
                client_sizes: HashMap::new(),
                owner: None,
            }),
            pty_gate: Mutex::new(()),
            events: Arc::clone(&self.config.events),
            manager: self.manager.clone(),
        });

        let mut set = plan.env.clone();
        set.retain(|(k, _)| k != "TERM");
        set.push(("TERM".to_owned(), "xterm-256color".to_owned()));
        let spawn = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv {
                program: plan.path.clone(),
                args: plan.args.clone(),
            },
            cwd,
            env: EnvSpec {
                inherit: true,
                set,
                remove: self.config.env_remove.clone(),
            },
            pty: Some(PtySize { cols, rows }),
            stdin_piped: true,
            output: OutputMode::Merged,
            owner: ProcessOwner::TerminalTab {
                tab_id: TerminalTabId::from(tab_id),
            },
            time_limit: None,
        };
        let on_exit: ExitHook = {
            let tab = Arc::clone(&tab);
            Box::new(move |exit| {
                let code = match exit.status {
                    ExitStatus::Code(code) => code,
                    ExitStatus::Signal(signal) => 128 + signal,
                };
                let line = format!("\r\n[process exited with code {code}]\r\n");
                let mut state = tab.lock();
                state.exited = true;
                state.output_paused = false;
                let change = state.activity.exit();
                tab.publish(change);
                state.buffer.append(&line);
                line.into_bytes()
            })
        };
        self.manager
            .spawn_with(
                spawn,
                SpawnOptions {
                    ring_bytes: Some(self.config.replay_limit),
                    filter: Some(Box::new(TabFilter(Arc::clone(&tab)))),
                    on_exit: Some(on_exit),
                },
            )
            .await
            .map_err(TerminalError::Process)?;
        Ok(tab)
    }

    // ----- reading --------------------------------------------------------------------------

    /// Read-only: the tabs of one session's terminal, ordered by tab number. Tab 1 is
    /// `session-terminal:<sessionId>`, tab n is `...:<n>`. Other sessions' terminals are never
    /// visible through this.
    pub fn session_tabs(&self, session_id: &str) -> Vec<SessionTab> {
        let base = format!("{SESSION_TERMINAL_PREFIX}{session_id}");
        let mut tabs: Vec<SessionTab> = self
            .all_tabs()
            .into_iter()
            .filter_map(|tab| {
                let number = if tab.id == base {
                    1
                } else {
                    let suffix = tab.id.strip_prefix(&format!("{base}:"))?;
                    let digits_ok = !suffix.is_empty()
                        && !suffix.starts_with('0')
                        && suffix.bytes().all(|b| b.is_ascii_digit());
                    if !digits_ok {
                        return None;
                    }
                    suffix.parse::<u32>().ok()?
                };
                Some(SessionTab {
                    tab: number,
                    id: tab.id.clone(),
                    shell: tab.shell.clone(),
                    running: tab.running(),
                    cwd: tab.cwd.clone(),
                })
            })
            .collect();
        tabs.sort_by_key(|tab| tab.tab);
        tabs
    }

    /// Read-only: output of one terminal after `since` (all retained output when omitted). It
    /// does not consume or alter the replay window.
    pub fn snapshot(&self, id: &str, since: Option<u64>) -> Option<Replay> {
        let tab = self.live(id)?;
        let state = tab.lock();
        Some(match since {
            None => Replay {
                text: state.buffer.read(),
                cursor: state.buffer.cursor(),
                reset: state.buffer.trimmed(),
            },
            Some(cursor) => state.buffer.read_since(cursor),
        })
    }

    /// Every open tab with who owns its size, ordered by id: the `terminalTabs` section.
    pub fn list_tabs(&self) -> Vec<TabEntry> {
        let mut entries: Vec<TabEntry> = self
            .all_tabs()
            .into_iter()
            .map(|tab| {
                let state = tab.lock();
                TabEntry {
                    id: tab.id.clone(),
                    shell: tab.shell.clone(),
                    running: !state.exited,
                    cwd: tab.cwd.clone(),
                    size_owner: Tab::owner_of(&state),
                }
            })
            .collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        entries
    }

    /// Every live tab whose activity is known.
    pub fn activity_snapshot(&self) -> Vec<(String, ActivityState)> {
        let mut states: Vec<(String, ActivityState)> = self
            .all_tabs()
            .into_iter()
            .filter_map(|tab| {
                let state = tab.lock();
                (!state.exited)
                    .then(|| state.activity.state())
                    .flatten()
                    .map(|s| (tab.id.clone(), s))
            })
            .collect();
        states.sort_by(|a, b| a.0.cmp(&b.0));
        states
    }

    /// Who owns this PTY's size right now, if anyone.
    pub fn size_owner(&self, id: &str) -> Option<SizeOwner> {
        let tab = self.live(id)?;
        let state = tab.lock();
        Tab::owner_of(&state)
    }

    // ----- input, size, focus, flow control -------------------------------------------------

    /// Types `data` into the tab; a missing or exited tab ignores it.
    pub fn write(&self, id: &str, data: &str) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let _ = self.manager.write_input(&tab.handle, data.as_bytes().to_vec());
        let mut state = tab.lock();
        if state.scanner.is_some() {
            let change = state.activity.input(data);
            tab.publish(change);
        }
    }

    /// A view reports its size. While a connection owns the tab's size (the last to focus it),
    /// resizes from any other connection are only remembered, not applied.
    pub fn resize(&self, id: &str, cols: u32, rows: u32, client: &str) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let cols = clamp_size(cols, DEFAULT_COLS, 500);
        let rows = clamp_size(rows, DEFAULT_ROWS, 200);
        let mut state = tab.lock();
        let before = Tab::owner_of(&state);
        state.client_sizes.insert(client.to_owned(), (cols, rows));
        if state.owner.as_deref().is_some_and(|owner| owner != client) {
            return;
        }
        state.size = (cols, rows);
        tab.announce(before, &state);
        drop(state);
        tab.sync_size();
    }

    /// A view focused (or left) a tab. Focusing clears `finished` and makes the connection the
    /// size owner; leaving does not give the size up (ownership passes on another focus or when
    /// the owner's connection closes).
    pub fn focus(&self, id: &str, client: &str, focused: bool) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let client = if client.is_empty() { "desktop" } else { client };
        let mut state = tab.lock();
        let change = state.activity.set_focus(client, focused);
        tab.publish(change);
        if !focused {
            return;
        }
        let before = Tab::owner_of(&state);
        state.owner = Some(client.to_owned());
        let reported = state.client_sizes.get(client).copied();
        if let Some(size) = reported {
            state.size = size;
        }
        tab.announce(before, &state);
        drop(state);
        if reported.is_some() {
            tab.sync_size();
        }
    }

    /// A connection closed: its focus and its size ownership end, on every tab.
    pub fn connection_closed(&self, client: &str) {
        for tab in self.all_tabs() {
            let mut state = tab.lock();
            state.client_sizes.remove(client);
            let change = state.activity.set_focus(client, false);
            tab.publish(change);
            if state.owner.as_deref() == Some(client) {
                let before = Tab::owner_of(&state);
                state.owner = None;
                tab.announce(before, &state);
            }
        }
    }

    /// Pauses the producer itself so a sustained flood backs up into the shell instead of
    /// growing without bound.
    pub fn pause_output(&self, id: &str) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let mut state = tab.lock();
        if state.output_paused {
            return;
        }
        state.output_paused = true;
        drop(state);
        tab.sync_pause();
    }

    pub fn resume_output(&self, id: &str) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let mut state = tab.lock();
        if !state.output_paused {
            return;
        }
        state.output_paused = false;
        drop(state);
        tab.sync_pause();
    }

    // ----- teardown -------------------------------------------------------------------------

    fn dispose_tab(&self, tab: &Tab) {
        let (was_paused, cursor) = {
            let mut state = tab.lock();
            let was_paused = std::mem::replace(&mut state.output_paused, false);
            state.exited = true;
            let change = state.activity.exit();
            tab.publish(change);
            let before = Tab::owner_of(&state);
            state.owner = None;
            state.client_sizes.clear();
            tab.announce(before, &state);
            (was_paused, state.buffer.cursor())
        };
        if was_paused {
            // A paused reader must be released before the kill, or the exit cannot arrive.
            tab.sync_pause();
        }
        self.cursor_floors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(tab.id.clone())
            .and_modify(|floor| *floor = (*floor).max(cursor))
            .or_insert(cursor);
        // Already gone is fine.
        let _ = self.manager.kill_with(&tab.handle, KillReason::Requested);
    }

    pub fn dispose(&self, id: &str) {
        let removed = {
            let mut table = self.table();
            match table.get(id) {
                Some(Slot::Live(_)) => table.remove(id),
                _ => None,
            }
        };
        if let Some(Slot::Live(tab)) = removed {
            self.dispose_tab(&tab);
        }
    }

    /// Disposes every tab whose cwd is `root` or inside it (a removed managed worktree), so no
    /// PTY keeps the directory locked. Returns the ids.
    pub fn dispose_under(&self, root: &str) -> Vec<String> {
        if normalize_root(root).is_empty() {
            return Vec::new();
        }
        let ids: Vec<String> = self
            .all_tabs()
            .into_iter()
            .filter(|tab| tab.cwd.as_deref().is_some_and(|cwd| is_path_under_root(root, cwd)))
            .map(|tab| tab.id.clone())
            .collect();
        for id in &ids {
            self.dispose(id);
        }
        ids
    }

    pub fn dispose_all(&self) {
        self.disposed.store(true, Ordering::Release);
        let tabs = self.all_tabs();
        self.table().clear();
        for tab in tabs {
            self.dispose_tab(&tab);
        }
    }
}

#[cfg(all(test, feature = "core-test"))]
mod lock_order {
    use std::sync::mpsc;
    use std::time::Duration;
    use std::time::Instant;

    use super::*;
    use crate::manager::ProcessConfig;

    struct Quiet;

    impl TerminalEvents for Quiet {
        fn activity(&self, _: &str, _: Option<ActivityState>) {}
        fn size_owner(&self, _: &SizeOwnerChange) {}
    }

    /// F30: with `cursor_floors` held by the test, a dispose and a respawn of one tab id both
    /// reach it. The dispose must have left the tab lock by then (a dispose that holds the tab
    /// lock while it waits for the floors is the inversion), and once the floors are released
    /// both finish.
    #[test]
    fn a_respawn_and_a_dispose_of_one_tab_id_do_not_deadlock() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let tabs = Arc::new(TerminalTabs::new(manager.clone(), TerminalConfig::new(Arc::new(Quiet))));
        let tab = Arc::new(Tab {
            id: "term_1".to_owned(),
            handle: ProcessHandle::from("term_1"),
            shell: "sh".to_owned(),
            cwd: None,
            state: Mutex::new(TabState {
                buffer: ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0),
                scanner: None,
                decoder: Utf8Decoder::default(),
                activity: ActivityTracker::new(false),
                exited: false,
                output_paused: false,
                size: (80, 24),
                client_sizes: HashMap::new(),
                owner: None,
            }),
            pty_gate: Mutex::new(()),
            events: Arc::new(Quiet),
            manager,
        });

        let floors = tabs.cursor_floors.lock().unwrap();
        let (done, finished) = mpsc::channel();
        let dispose = {
            let (tabs, tab, done) = (Arc::clone(&tabs), Arc::clone(&tab), done.clone());
            std::thread::spawn(move || {
                tabs.dispose_tab(&tab);
                done.send("dispose").unwrap();
            })
        };
        let respawn = {
            let (tabs, tab) = (Arc::clone(&tabs), Arc::clone(&tab));
            std::thread::spawn(move || {
                tabs.start_cursor("term_1", Some(&*tab));
                done.send("respawn").unwrap();
            })
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if tab.state.try_lock().is_ok_and(|state| state.exited) {
                break;
            }
            assert!(Instant::now() < deadline, "the dispose holds the tab lock while it waits for the floors");
            std::thread::yield_now();
        }
        drop(floors);
        for _ in 0..2 {
            finished.recv_timeout(Duration::from_secs(10)).expect("respawn and dispose finish");
        }
        dispose.join().unwrap();
        respawn.join().unwrap();
        assert!(tabs.cursor_floors.lock().unwrap().contains_key("term_1"));
    }
}
#[cfg(all(test, feature = "core-test"))]
mod bounded_waits {
    use std::time::Duration;

    use super::*;
    use crate::manager::ProcessConfig;

    struct Quiet;

    impl TerminalEvents for Quiet {
        fn activity(&self, _: &str, _: Option<ActivityState>) {}
        fn size_owner(&self, _: &SizeOwnerChange) {}
    }

    fn tabs_with(config: ProcessConfig) -> (Arc<TerminalTabs>, LocalProcessManager) {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, config);
        let tabs = Arc::new(TerminalTabs::new(manager.clone(), TerminalConfig::new(Arc::new(Quiet))));
        (tabs, manager)
    }

    /// The root exits at once but its grandchild keeps the output pipe for 60 s, so the
    /// pipe-end the exit used to wait for never comes. `wait_gone` ends through the process
    /// manager's bounded drain (`output_drain`), with no timer of its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_gone_ends_when_a_descendant_holds_the_pipe() {
        let (tabs, manager) = tabs_with(ProcessConfig {
            output_drain: Duration::from_millis(50),
            ..ProcessConfig::default()
        });
        let handle = ProcessHandle::from(format!("wait-gone-{}", std::process::id()));
        let command = if cfg!(windows) {
            CommandSpec::Shell {
                script: "$i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = 'ping'; \
                         $i.Arguments = '-n 60 127.0.0.1'; $i.UseShellExecute = $false; \
                         [void][System.Diagnostics.Process]::Start($i)"
                    .to_owned(),
                shell: Some("powershell".to_owned()),
            }
        } else {
            CommandSpec::Shell {
                script: "sleep 60 &".to_owned(),
                shell: None,
            }
        };
        manager
            .spawn(SpawnRequest {
                handle: handle.clone(),
                command,
                cwd: AbsPath::new(std::env::temp_dir()).expect("the temp dir is absolute"),
                env: EnvSpec {
                    inherit: true,
                    ..EnvSpec::default()
                },
                pty: None,
                stdin_piped: false,
                output: OutputMode::Merged,
                owner: ProcessOwner::Internal,
                time_limit: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), tabs.wait_gone(&handle))
            .await
            .expect("wait_gone ends although the pipe is still held");
        assert!(manager.info(&handle).unwrap().exit.is_some());
    }

    /// The spawner a waiter waits on goes away without finishing: the slot is released and the
    /// waiter ends, instead of waiting for a wake-up that never comes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_waiter_on_an_abandoned_spawn_is_released() {
        let (tabs, _manager) = tabs_with(ProcessConfig::default());
        let Claim::Spawn { guard, .. } = tabs.claim("term_1") else {
            panic!("the first claim spawns");
        };
        let waiter = {
            let tabs = Arc::clone(&tabs);
            tokio::spawn(async move { tabs.attach("term_1").await })
        };
        drop(guard);
        let attached = tokio::time::timeout(Duration::from_secs(10), waiter)
            .await
            .expect("the waiter is released")
            .unwrap();
        assert!(attached.is_none());
    }
}