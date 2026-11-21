//! Terminal tabs (DS §6.3): the tab layer over PTY handles of the one process manager. A tab is a
//! PTY process owned by `ProcessOwner::TerminalTab` plus what the Node `terminal-manager.ts` kept
//! beside it: the replay window, shell-integration markers and the activity they drive, the
//! size owner, and output flow control. The size owner is Node's claim model: a view that claims
//! the size (a phone) holds it for [`SIZE_OWNER_LEASE`] unless it renews, the newest claim owns,
//! a claim of zero size releases it, and a resize without a claim is ignored while any claim
//! stands. The timers here run on the core ticker: the size lease, a view's focus lease (30 s, renewed
//! by the renderer's 10 s heartbeat, or ended by an unfocus or the connection closing), and the 50 ms
//! after which marker text held back with no further chunk is released (the next chunk or the end of
//! the stream releases it too).

mod bridge;
mod claims;
#[cfg(feature = "lease-clock")]
mod clock_control;
mod integration;
mod markers;
mod profiles;
mod replay;
mod tab;

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
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
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
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
pub use claims::{HELD_FLUSH, SIZE_OWNER_LEASE};
pub use integration::Integration;
pub use integration::SpawnPlan;
pub use integration::SpawnProfile;
pub use integration::plan_shell_integration;
pub use markers::ActivityState;
pub use markers::ActivityTracker;
pub use markers::FOCUS_LEASE;
pub use markers::Marker;
pub use markers::MarkerScanner;
pub use markers::Utf8Decoder;
pub use profiles::ShellProfile;
pub use profiles::ShellProfileInfo;
pub use replay::REPLAY_BUFFER_LIMIT;
pub use replay::Replay;
pub use replay::ReplayBuffer;
pub use replay::cursor_epoch;
pub use tab::PumpPoint;

use crate::feed::Feed;
use crate::manager::ExitHook;
use crate::manager::LocalProcessManager;
use crate::manager::NodePtyExit;
use crate::manager::SpawnOptions;
use claims::Claims;
#[cfg(feature = "lease-clock")]
use claims::ManualLeaseClock;
use tab::{RelayOrder, Tab, TabFilter, TabState};

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
    /// The tab's size claims were dropped by its disposal. Node announces no owner change for that (`forgetSizeClaims`), so this
    /// is no `size_owner` event: it only lets a consumer that holds the owners forget them, in the order of the other changes.
    fn size_claims_forgotten(&self, id: &str);
    /// Resolves once every change enqueued before it has reached the clients; `None` when the changes go out as they are enqueued.
    fn published(&self) -> Option<Published> {
        None
    }
}

/// Resolves once the changes enqueued before it have reached the clients (see [`TerminalEvents::published`]).
pub type Published = tokio::sync::oneshot::Receiver<()>;

/// How the relay feed's pump tells a tab where it is; what it returns is a publication the pump waits for before it goes on.
pub type PumpTell = Arc<dyn Fn(PumpPoint) -> Option<Published> + Send + Sync>;

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
    /// Tests only: tabs run over pipes, not a PTY (which adds sequences of its own), so the bytes a scripted child writes are
    /// exactly the bytes the replay window holds. See `crate::scripted`.
    #[cfg(feature = "core-test")]
    pub piped: bool,
    /// Tests only: told the id whose claim gate a caller found taken, just before it waits for it. A test holds an
    /// announcement under the gate and waits for this signal, so "the call waits for the gate" is an event, not a quiet period.
    #[cfg(feature = "core-test")]
    pub gate_waiting: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// The manual lease clock (see [`LeaseClockSetting`]); [`TerminalConfig::new`] takes it from the environment.
    #[cfg(feature = "lease-clock")]
    pub lease_clock: Option<LeaseClockSetting>,
}

/// Where the manual lease clock publishes its port and the run's secret a client must send first. A core started for a replay gets it
/// from `MIXDOG_TERMINAL_LEASE_CLOCK` (the directory) and `MIXDOG_TERMINAL_LEASE_CLOCK_SECRET`; a test passes its own, so tests in one
/// process do not share it.
#[cfg(feature = "lease-clock")]
#[derive(Clone, Debug)]
pub struct LeaseClockSetting {
    pub dir: PathBuf,
    /// Without a secret no client moves the clock.
    pub secret: Option<String>,
}

#[cfg(feature = "lease-clock")]
impl LeaseClockSetting {
    pub fn from_env() -> Option<Self> {
        let dir = std::env::var_os("MIXDOG_TERMINAL_LEASE_CLOCK")?;
        let secret = std::env::var(clock_control::SECRET_VAR).ok().filter(|s| !s.is_empty());
        Some(Self { dir: PathBuf::from(dir), secret })
    }
}

impl TerminalConfig {
    pub fn new(events: Arc<dyn TerminalEvents>) -> Self {
        Self {
            shell_integration_dir: None,
            env_remove: CHILD_ENV_SCRUB.iter().map(|v| (*v).to_owned()).collect(),
            replay_limit: REPLAY_BUFFER_LIMIT,
            now_ms: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)),
            events,
            #[cfg(feature = "core-test")]
            piped: false,
            #[cfg(feature = "core-test")]
            gate_waiting: None,
            #[cfg(feature = "lease-clock")]
            lease_clock: LeaseClockSetting::from_env(),
        }
    }

    fn pty_size(&self, cols: u16, rows: u16) -> Option<PtySize> {
        #[cfg(feature = "core-test")]
        if self.piped {
            return None;
        }
        Some(PtySize { cols, rows })
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
    /// The lone low surrogate Node's replay starts with when its window cut a non-BMP character, which `replay` cannot hold: it
    /// precedes `replay` ([`ReplayBuffer::read_window`]).
    pub replay_lead: Option<u16>,
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
/// How long a disposed tab's shell has to end after its terminal closed before its tree is ended: node-pty's own bound on the same step
/// (`windowsPtyAgent.js` `_getConsoleProcessList`, lines 213-217 of @homebridge/node-pty-prebuilt-multiarch 0.13: the console's process
/// list is awaited 5000 ms, then the shell's pid is killed).
const HANG_UP_GRACE: std::time::Duration = std::time::Duration::from_millis(5000);
const DEFAULT_COLS: u32 = 80;
const DEFAULT_ROWS: u32 = 24;

fn valid_id_chars(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
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
            valid_id_chars(session, 120) && (1..=3).contains(&tab.len()) && tab.bytes().all(|b| b.is_ascii_digit()) && !tab.starts_with('0')
        }
    }
}

/// Shell label for a spawn path: `C:\...\pwsh.exe` -> `pwsh`.
fn shell_label(shell: &str) -> String {
    let file = shell.rsplit(['\\', '/']).next().unwrap_or(shell);
    let stem = if file.len() > 4 && file[file.len() - 4..].eq_ignore_ascii_case(".exe") { &file[..file.len() - 4] } else { file };
    if stem.is_empty() { shell.to_owned() } else { stem.to_owned() }
}

/// Slash-normalized, trailing-slash-free path; case-folded on Windows and macOS.
fn normalize_root(value: &str) -> String {
    let path = value.replace('\\', "/");
    let path = path.trim_end_matches('/');
    if cfg!(any(windows, target_os = "macos")) { path.to_lowercase() } else { path.to_owned() }
}

/// `path` is `root` or lies inside it (the rule `dispose_under` uses).
pub fn is_path_under_root(root: &str, path: &str) -> bool {
    let base = normalize_root(root);
    let target = if path.is_empty() { String::new() } else { normalize_root(path) };
    !base.is_empty() && !target.is_empty() && (target == base || target.starts_with(&format!("{base}/")))
}

/// A relative `cwd` is taken against the core's working directory, as node-pty's spawn took it against Node's.
fn resolve_cwd(cwd: &str) -> Result<PathBuf, TerminalError> {
    let cwd = PathBuf::from(cwd);
    if cwd.is_absolute() {
        return Ok(cwd);
    }
    Ok(std::env::current_dir().map_err(|_| TerminalError::InvalidCwd)?.join(cwd))
}

fn default_profile() -> SpawnProfile {
    SpawnProfile {
        path: if cfg!(windows) {
            "powershell.exe".to_owned()
        } else {
            std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "bash".to_owned())
        },
        ..SpawnProfile::default()
    }
}

fn start_dir(request: &EnsureRequest) -> Result<PathBuf, TerminalError> {
    match request.cwd.as_deref().filter(|c| !c.is_empty()) {
        Some(cwd) => resolve_cwd(cwd),
        None => ["USERPROFILE", "HOME"]
            .iter()
            .find_map(|name| std::env::var_os(name).filter(|v| !v.is_empty()))
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or(TerminalError::InvalidCwd),
    }
}

fn clamp_size(value: u32, default: u32, max: u32) -> u16 {
    (if value == 0 { default } else { value }).clamp(2, max) as u16
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

/// Input a tab's queue was full for (see [`TerminalTabs::write`]). One per connection at most: the notification that made it pauses its
/// connection's reader until it is written, so what a connection can leave here is one message, bounded by the transport's frame limit.
/// Node had no bound (node-pty queues whatever `pty.write` is given, so a phone typing faster than the shell reads grew the desktop's
/// memory without end); here the queue's capacity and that one paused message are the most a connection holds.
pub struct PendingInput {
    manager: LocalProcessManager,
    tab: Arc<Tab>,
    bytes: Vec<u8>,
}

impl PendingInput {
    /// Waits for room in the tab's input queue and writes the input; a tab that has gone meanwhile takes nothing, as Node's killed pty did.
    pub async fn finish(self) {
        let _ = self
            .manager
            .write_input_wait_on_admission(&self.tab.handle, self.bytes, |bytes| {
                TerminalTabs::note_input(&self.tab, std::str::from_utf8(bytes).expect("terminal input is UTF-8"));
            })
            .await;
    }
}

pub struct TerminalTabs {
    manager: LocalProcessManager,
    config: TerminalConfig,
    tabs: Arc<Mutex<HashMap<String, Slot>>>,
    claims: Arc<Claims>,
    cursor_floors: Mutex<HashMap<String, u64>>,
    sequence: AtomicU64,
    /// Creation order of tabs (their `seq`).
    created: AtomicU64,
    disposed: std::sync::atomic::AtomicBool,
    profiles: OnceCell<Vec<ShellProfile>>,
}

enum Claim {
    Reattach(Arc<Tab>),
    Wait(watch::Receiver<()>),
    Spawn { guard: SpawnGuard, prior: Option<Arc<Tab>> },
}

impl TerminalTabs {
    pub fn new(manager: LocalProcessManager, config: TerminalConfig) -> Self {
        let tabs = Arc::new(Mutex::new(HashMap::new()));
        let claims = Arc::new(Claims {
            map: Mutex::new(HashMap::new()),
            gates: std::array::from_fn(|_| Mutex::new(())),
            tabs: Arc::clone(&tabs),
            events: Arc::clone(&config.events),
            epoch: AtomicU64::new(0),
            #[cfg(feature = "lease-clock")]
            manual: config.lease_clock.as_ref().map(|setting| ManualLeaseClock { now: Mutex::new(std::time::Duration::ZERO), secret: setting.secret.clone() }),
            #[cfg(feature = "core-test")]
            gate_waiting: config.gate_waiting.clone(),
        });
        #[cfg(feature = "lease-clock")]
        if let Some(setting) = &config.lease_clock {
            Claims::serve_manual_clock(&claims, setting.dir.clone());
        }
        Self {
            manager,
            claims,
            config,
            tabs,
            cursor_floors: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            created: AtomicU64::new(0),
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
        self.profiles.get_or_init(|| profiles::detect(&self.manager)).await
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
        let (replay_lead, replay) = tab.lock().buffer.read_window();
        Attached { id: tab.id.clone(), replay, replay_lead, size_owner: self.claims.owner_of(&tab.id) }
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
        Claim::Spawn { guard: SpawnGuard { tabs: Arc::clone(&self.tabs), id: id.to_owned(), _done: tx }, prior }
    }

    /// Attaches to a PTY that is already running, never starting one: its id and replay, or
    /// `None` when it is not running (never started, exited, disposed). A spawn already under
    /// way for the id is waited for. Warm-ups use this; only a real open ensures.
    pub async fn attach(&self, id: &str) -> Option<Attached> {
        let tab = self.settled_running(id).await?;
        Some(self.attached(&tab))
    }

    /// [`Self::attach`] with the replay read under the lock that appends the tab's output, together with the feed's output offset at that
    /// moment: `hold` runs under that lock with the offset (a hold on the feed's pump takes effect before any later output is admitted).
    /// What the replay holds is then exactly the output up to the offset, which a subscription made once the pump has published up to it
    /// neither repeats nor misses.
    pub async fn attach_cut<H>(&self, id: &str, hold: impl FnOnce(u64) -> H) -> Option<(Attached, u64, H)> {
        let tab = self.settled_running(id).await?;
        // Cut under the feed's lock (lock order: the feed's state, then `Tab::state`): no output is admitted between the replay read and
        // the hold, and the cut seals the feed's last event, so output admitted later is never merged into an event the pump has not
        // taken yet (such an event would end past the hold and keep the pump short of the offset). The feed's offset is the pump's.
        let read = |offset: Option<u64>| {
            let state = tab.lock();
            let (lead, replay) = state.buffer.read_window();
            let at = offset.unwrap_or(state.emitted);
            (lead, replay, at)
        };
        let mut hold = Some(hold);
        let cut = tab.manager.output_mark_then(&tab.handle, |offset| {
            let (lead, replay, at) = read(Some(offset));
            (lead, replay, at, (hold.take().expect("the hold is taken once"))(at))
        });
        let (replay_lead, replay, emitted, held) = match cut {
            Ok(cut) => cut,
            // The process is gone from the manager (its feed has ended): no more output comes.
            Err(_) => {
                let (lead, replay, at) = read(None);
                (lead, replay, at, (hold.take().expect("the hold is taken once"))(at))
            }
        };
        let attached = Attached { id: tab.id.clone(), replay, replay_lead, size_owner: self.claims.owner_of(&tab.id) };
        Some((attached, emitted, held))
    }

    async fn settled_running(&self, id: &str) -> Option<Arc<Tab>> {
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
        self.running(id)
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
            None => format!("term_{}_{}", std::process::id(), self.sequence.fetch_add(1, Ordering::AcqRel) + 1),
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
        let from_floors = self.cursor_floors.lock().unwrap_or_else(|e| e.into_inner()).get(tab_id).copied();
        let floor = from_floors.into_iter().chain(from_prior).max();
        floor.map_or(0, |floor| floor + 1).max(cursor_epoch((self.config.now_ms)()))
    }

    async fn spawn_tab(&self, tab_id: &str, prior: Option<Arc<Tab>>, request: &EnsureRequest) -> Result<Arc<Tab>, TerminalError> {
        let handle = ProcessHandle::from(tab_id);
        self.wait_gone(&handle).await;
        if self.is_disposed() {
            return Err(TerminalError::Disposed);
        }
        let shell = request.profile.clone().unwrap_or_else(default_profile);
        let plan = plan_shell_integration(&shell, self.config.shell_integration_dir.as_deref(), &|name| std::env::var(name).ok(), cfg!(windows));
        let cwd = AbsPath::new(start_dir(request)?).ok_or(TerminalError::InvalidCwd)?;
        let cols = clamp_size(request.cols.unwrap_or(0), DEFAULT_COLS, 500);
        let rows = clamp_size(request.rows.unwrap_or(0), DEFAULT_ROWS, 200);

        let start = self.start_cursor(tab_id, prior.as_deref());
        let seq = prior.as_ref().map_or_else(|| self.created.fetch_add(1, Ordering::AcqRel) + 1, |prior| prior.seq);
        let tab = Arc::new(Tab {
            id: tab_id.to_owned(),
            seq,
            handle: handle.clone(),
            shell: shell_label(&shell.path),
            cwd: request.cwd.clone().filter(|c| !c.is_empty()),
            state: Mutex::new(TabState {
                buffer: ReplayBuffer::new(self.config.replay_limit, start),
                scanner: plan.integration.map(|_| MarkerScanner::default()),
                decoder: Utf8Decoder::default(),
                activity: ActivityTracker::new(plan.integration == Some(Integration::Cmd)),
                exited: false,
                paused_by: BTreeSet::new(),
                size: (cols, rows),
                emitted: 0,
                order: None,
                held_gen: 0,
                held_timer: None,
                flushing: false,
            }),
            pty_gate: Mutex::new(()),
            flushed: Condvar::new(),
            events: Arc::clone(&self.config.events),
            manager: self.manager.clone(),
        });

        let mut set = plan.env.clone();
        set.retain(|(k, _)| k != "TERM");
        set.push(("TERM".to_owned(), "xterm-256color".to_owned()));
        let spawn = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv { program: plan.path.clone(), args: plan.args.clone() },
            cwd,
            env: EnvSpec { inherit: true, set, remove: self.config.env_remove.clone() },
            pty: self.config.pty_size(cols, rows),
            stdin_piped: true,
            output: OutputMode::Merged,
            owner: ProcessOwner::TerminalTab { tab_id: TerminalTabId::from(tab_id) },
            time_limit: None,
        };
        let on_exit: ExitHook = {
            let tab = Arc::clone(&tab);
            Box::new(move |exit| tab.exited(exit))
        };
        #[allow(unused_mut)]
        let mut spawn = spawn;
        #[allow(unused_mut)]
        let mut options = SpawnOptions {
            ring_bytes: Some(self.config.replay_limit),
            replays_after_exit: true,
            filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
            on_exit: Some(on_exit),
            // The tab's exit comes when Node's node-pty raised it, on this runtime's clock.
            node_pty_exit: Some(NodePtyExit { runtime: tokio::runtime::Handle::current() }),
            ..SpawnOptions::default()
        };
        #[cfg(feature = "scripted-shell")]
        {
            options.scripted_frames = crate::scripted::in_place_of(&mut spawn);
        }
        self.manager.spawn_with(spawn, options).await.map_err(TerminalError::Process)?;
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
                    let digits_ok = !suffix.is_empty() && !suffix.starts_with('0') && suffix.bytes().all(|b| b.is_ascii_digit());
                    if !digits_ok {
                        return None;
                    }
                    suffix.parse::<u32>().ok()?
                };
                Some(SessionTab { tab: number, id: tab.id.clone(), shell: tab.shell.clone(), running: tab.running(), cwd: tab.cwd.clone() })
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
            None => Replay { text: state.buffer.read(), cursor: state.buffer.cursor(), reset: state.buffer.trimmed() },
            Some(cursor) => state.buffer.read_since(cursor),
        })
    }

    /// Every open tab with who owns its size, ordered by id: the `terminalTabs` section.
    pub fn list_tabs(&self) -> Vec<TabEntry> {
        let mut entries: Vec<TabEntry> = self
            .all_tabs()
            .into_iter()
            .map(|tab| {
                let running = !tab.lock().exited;
                TabEntry { id: tab.id.clone(), shell: tab.shell.clone(), running, cwd: tab.cwd.clone(), size_owner: self.claims.owner_of(&tab.id) }
            })
            .collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        entries
    }

    /// Every live tab whose activity is known, in creation order (Node's `activitySnapshot`).
    pub fn activity_snapshot(&self) -> Vec<(String, ActivityState)> {
        let mut states: Vec<(u64, String, ActivityState)> = self
            .all_tabs()
            .into_iter()
            .filter_map(|tab| {
                let state = tab.lock();
                (!state.exited).then(|| state.activity.state()).flatten().map(|s| (tab.seq, tab.id.clone(), s))
            })
            .collect();
        states.sort_by_key(|(seq, ..)| *seq);
        states.into_iter().map(|(_, id, state)| (id, state)).collect()
    }

    /// Where the tab `id` stands in creation order, if it is open.
    pub fn creation_order(&self, id: &str) -> Option<u64> {
        self.live(id).map(|tab| tab.seq)
    }

    /// Orders the activity changes of the live tab `id` after its output on the relay feed (see [`RelayOrder`]): returns what the feed's
    /// pump calls with the bytes of output it has taken so far (`u64::MAX` when it ends). Called by whoever starts that pump, once.
    pub fn relay_order(&self, id: &str) -> Option<PumpTell> {
        let tab = self.live(id)?;
        tab.lock().order = Some(RelayOrder::default());
        Some(Arc::new(move |at| tab.pumped(at)))
    }

    /// Who owns this PTY's size right now, if anyone.
    pub fn size_owner(&self, id: &str) -> Option<SizeOwner> {
        self.claims.owner_of(id)
    }

    /// Holds the size-claim gate of `id` on a thread of its own until the returned sender goes; returns once it is held. Tests only.
    #[cfg(test)]
    pub(crate) fn hold_claim_gate(&self, id: &str) -> std::sync::mpsc::Sender<()> {
        let (claims, id) = (Arc::clone(&self.claims), id.to_owned());
        let (held, taken) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _gate = claims.gate(&id);
            held.send(()).unwrap();
            let _ = released.recv();
        });
        taken.recv_timeout(std::time::Duration::from_secs(60)).expect("the gate holder took the claim gate within 60 s");
        release
    }

    // ----- input, size, focus, flow control -------------------------------------------------

    /// Types `data` into the tab; a missing or exited tab ignores it. Input the tab's queue has no room for yet is not dropped (Node's
    /// `pty.write` queued whatever it was given): it comes back as a [`PendingInput`] whose `finish` waits for room and writes it.
    #[must_use = "input the queue could not take yet is written by `PendingInput::finish`"]
    pub fn write(&self, id: &str, data: &str) -> Option<PendingInput> {
        let tab = self.running(id)?;
        let bytes = data.as_bytes().to_vec();
        match self.manager.write_input(&tab.handle, bytes.clone()) {
            Ok(()) => {
                Self::note_input(&tab, data);
                None
            }
            Err(ProcessError::Overloaded { .. }) => Some(PendingInput { manager: self.manager.clone(), tab, bytes }),
            _ => None,
        }
    }

    /// Unlike pane keystrokes, a tool-submitted command needs an acknowledgement that the PTY took all its input.
    pub async fn write_command(&self, id: &str, data: &str, admitted: impl FnOnce()) -> Result<(), ProcessError> {
        let tab = self.running(id).ok_or(ProcessError::AlreadyExited)?;
        self.manager
            .write_input_whole_on_admission(&tab.handle, data.as_bytes().to_vec(), |_| {
                admitted();
                Self::note_input(&tab, data);
            })
            .await
    }

    fn note_input(tab: &Tab, data: &str) {
        let mut state = tab.lock();
        if state.scanner.is_some() {
            let change = state.activity.input(data);
            tab.publish_after_output(&mut state, change);
        }
    }

    /// A view reports its size (`terminal-manager.ts` `resize`). `client` is the connection of a
    /// phone claiming the size, empty for any other view (the desktop's pane, a phone that does not
    /// claim). A claim sets the PTY size, renews its lease, and the newest claim owns; a claim of
    /// zero size releases that connection's claim; any other view's resize is ignored while a claim
    /// stands.
    pub fn resize(&self, id: &str, cols: u32, rows: u32, client: &str) {
        if !client.is_empty() && !(cols > 0 && rows > 0) {
            self.claims.release(id, client, None);
            return;
        }
        let cols = clamp_size(cols, DEFAULT_COLS, 500);
        let rows = clamp_size(rows, DEFAULT_ROWS, 200);
        if client.is_empty() {
            self.claims.resize_unclaimed(id, cols, rows);
        } else {
            self.claims.claim(id, client, cols, rows);
        }
    }

    /// A view focused (or left) a tab; focusing clears `finished`. Focus is activity only: the size
    /// owner is whoever claimed it with [`Self::resize`].
    pub fn focus(&self, id: &str, client: &str, focused: bool) {
        self.focus_with(id, client, focused, None);
    }

    fn focus_with(&self, id: &str, client: &str, focused: bool, ticker: Option<&mixdog_rt::Ticker>) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let client = if client.is_empty() { "desktop" } else { client };
        let mut state = tab.lock();
        let change = state.activity.set_focus(client, focused);
        if focused {
            // A repeated focus is the renewal: the view's lease starts again.
            let (weak, who) = (Arc::downgrade(&tab), client.to_owned());
            state.activity.lease_focus(client, |epoch| {
                Some(ticker.unwrap_or_else(|| mixdog_rt::ticker()).register(std::time::Instant::now() + FOCUS_LEASE, move || {
                    if let Some(tab) = weak.upgrade() {
                        drop(mixdog_rt::spawn("terminal-focus-lease", mixdog_rt::TaskClass::Work, async move {
                            tab.lock().activity.lapse_focus(&who, epoch);
                        }));
                    }
                }))
            });
        }
        tab.publish(&mut state, change);
    }

    /// A connection closed: its focus ends on every tab and the pause it held is released (a connection that died paused would
    /// otherwise leave the shell stopped for good). Its size claims are not released: Node's lease lapses them (a phone that
    /// reconnects holds a new connection id).
    pub fn connection_closed(&self, client: &str) {
        for tab in self.all_tabs() {
            let mut state = tab.lock();
            let change = state.activity.set_focus(client, false);
            tab.publish(&mut state, change);
            let released = state.paused_by.remove(client) && state.paused_by.is_empty();
            drop(state);
            if released {
                tab.sync_pause();
            }
        }
    }

    /// `client` pauses the producer itself so a sustained flood backs up into the shell instead of growing without bound. The
    /// producer stays paused until every connection that paused it has resumed or closed.
    pub fn pause_output(&self, id: &str, client: &str) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let mut state = tab.lock();
        let first = state.paused_by.is_empty();
        if !state.paused_by.insert(client.to_owned()) || !first {
            return;
        }
        drop(state);
        tab.sync_pause();
    }

    pub fn resume_output(&self, id: &str, client: &str) {
        let Some(tab) = self.running(id) else {
            return;
        };
        let mut state = tab.lock();
        if !state.paused_by.remove(client) || !state.paused_by.is_empty() {
            return;
        }
        drop(state);
        tab.sync_pause();
    }

    // ----- teardown -------------------------------------------------------------------------

    fn dispose_tab(&self, tab: &Tab) {
        let (was_paused, cursor) = {
            let mut state = tab.lock();
            let was_paused = !std::mem::take(&mut state.paused_by).is_empty();
            state.exited = true;
            if let Some(timer) = state.held_timer.take() {
                timer.cancel();
            }
            let change = state.activity.exit();
            tab.publish(&mut state, change);
            (was_paused, state.buffer.cursor())
        };
        self.claims.forget_held(&tab.id);
        if was_paused {
            // A paused reader must be released before the kill, or the exit cannot arrive.
            tab.sync_pause();
        }
        self.cursor_floors.lock().unwrap_or_else(|e| e.into_inner()).entry(tab.id.clone()).and_modify(|floor| *floor = (*floor).max(cursor)).or_insert(cursor);
        self.end_process(&tab.handle);
    }

    /// Ends a disposed tab's process as node-pty's `kill` did on Windows: its terminal is closed, so the shell ends with its own answer to
    /// that (`STATUS_CONTROL_C_EXIT`: the exit line Node's phone saw, golden.json, every `[process exited with code -1073741510]`); the
    /// tree is ended once the shell has exited (what it started may outlive the console), or after [`HANG_UP_GRACE`] if it has not.
    /// The tree ended is the disposed process's own, captured here: never a process created under the same id since.
    /// Elsewhere, and for a tab whose terminal cannot be closed, the tree is ended at once.
    fn end_process(&self, handle: &ProcessHandle) {
        // A write waiting for room in the tab's input ends now (Node's dispose leaves no write behind); already closed or gone is fine.
        self.manager.refuse_input(handle);
        // Already gone is fine.
        let events = if cfg!(windows) { self.manager.subscribe(handle, None).ok() } else { None };
        let hung = events.as_ref().and_then(|_| self.manager.hang_up(handle).ok());
        let (Some(mut events), Some(hung)) = (events, hung) else {
            let _ = self.manager.kill_with(handle, KillReason::Requested);
            return;
        };
        mixdog_rt::spawn("terminal-hang-up", mixdog_rt::TaskClass::Work, async move {
            let _ = tokio::time::timeout(HANG_UP_GRACE, async {
                while let Some(event) = events.next().await {
                    if matches!(event, ProcessEvent::Exited { .. }) {
                        return;
                    }
                }
            })
            .await;
            let _ = hung.kill();
        });
    }

    /// The whole disposal (the tab's removal, its activity end, the forgetting of its claims and the kill) holds the id's claim
    /// gate, so a claim of the same id runs wholly before it (its owner announced, then the end) or wholly after it (the claim
    /// stands on an id with no tab): Node's two serialisations (terminal-manager.ts:455, :536), nothing in between.
    pub fn dispose(&self, id: &str) {
        let _gate = self.claims.gate(id);
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
        let ids: Vec<String> =
            self.all_tabs().into_iter().filter(|tab| tab.cwd.as_deref().is_some_and(|cwd| is_path_under_root(root, cwd))).map(|tab| tab.id.clone()).collect();
        for id in &ids {
            self.dispose(id);
        }
        ids
    }

    pub fn dispose_all(&self) {
        self.disposed.store(true, Ordering::Release);
        // Each tab goes as a single dispose does, its removal under its gate, so no claim or owner read sees it half gone.
        for tab in self.all_tabs() {
            self.dispose(&tab.id);
        }
        self.table().clear();
    }
}

#[cfg(all(test, feature = "core-test"))]
mod bounded_waits;
#[cfg(all(test, feature = "core-test"))]
mod lock_order;

#[cfg(test)]
mod relative_cwd;

#[cfg(all(test, feature = "core-test"))]
mod held_flush;
