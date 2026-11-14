//! Terminal tabs (DS §6.3): the tab layer over PTY handles of the one process manager. A tab is a
//! PTY process owned by `ProcessOwner::TerminalTab` plus what the Node `terminal-manager.ts` kept
//! beside it: the replay window, shell-integration markers and the activity they drive, the
//! size owner, and output flow control. The size owner is Node's claim model: a view that claims
//! the size (a phone) holds it for [`SIZE_OWNER_LEASE`] unless it renews, the newest claim owns,
//! a claim of zero size releases it, and a resize without a claim is ignored while any claim
//! stands. The lease is the one timer here (on the core ticker); focus ends when a view unfocuses
//! or its connection closes, and held-back marker text is released by the next chunk or the end
//! of the stream.

mod bridge;
#[cfg(feature = "lease-clock")]
mod clock_control;
mod integration;
mod markers;
mod profiles;
mod replay;

use std::collections::HashMap;
use std::collections::VecDeque;
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
use crate::manager::NodePtyExit;
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
            now_ms: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64)
            }),
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
    /// Bytes of output the feed has admitted so far (its absolute output offset).
    emitted: u64,
    /// Set once the tab's relay feed pumps its output (see [`RelayOrder`]).
    order: Option<RelayOrder>,
}

/// The order of a tab's activity changes against its output on the relay feed. Node, for each chunk its PTY read: appended the text and
/// called the output listeners at once (terminal-manager.ts:347-350, `emit`), the relay pushing it into its 16 ms buffer
/// (remote-relay-push-lanes.ts:89,101); then applied the chunk's markers (terminal-manager.ts:368-370), whose change the activity
/// listener broadcast at once (terminal-manager.ts:341, remote-relay-push-lanes.ts:148). A paused PTY read nothing (`pty.pause()`,
/// terminal-manager.ts:499-505), so no text and no marker of it went anywhere. So a change follows its text's insertion into the relay
/// buffer, never its transmission, and nothing waits on a paused consumer.
///
/// The core's rule from that: a chunk is read when its feed admits it ([`TabFilter::admitted`], under the feed's flow gate, Node's
/// pause), and only then are its markers applied; the relay buffer lives in the feed's pump, so the change waits here until the pump has
/// taken the output admitted before it, and then goes. Every waiting change is thus for output already in the feed, which the pump
/// reads whether or not the producer is paused. `emitted` and `taken` are both the feed's absolute output offset (the pump starts
/// counting at its first event's offset).
///
/// The shell's end is the one change that waits for the pump to reach its exit line rather than for output to be taken: Node ran its
/// exit handler (terminal-manager.ts:378-384) on its own event, never inside a call such as a claim's resize-and-announce
/// (terminal-manager.ts:485-488), so the end followed whatever that call published, and the exit line followed the end. The pump reaches
/// the exit line only once a claim's hold lets it (the line is an event of its own, after the hold's cut), so the end goes then.
#[derive(Default)]
struct RelayOrder {
    /// The feed's output offset the pump has taken up to.
    taken: u64,
    /// Changes waiting, each with the output it follows.
    waiting: VecDeque<(u64, Option<ActivityState>)>,
    /// The shell's end, with the offset where its exit line starts.
    end: Option<(u64, Option<ActivityState>)>,
    /// A change went at once (it followed no output the pump had not taken): the next output waits to see it published before it enters
    /// the relay buffer, as Node's later output always followed its synchronous broadcast.
    unpublished: bool,
}

/// Where the relay feed's pump is, as it tells a terminal tab (see [`RelayOrder`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PumpPoint {
    /// About to put the output event starting at this offset into the relay buffer (no hold keeps it back any more).
    Reaching(u64),
    /// Has put the output up to this offset into the relay buffer (`u64::MAX`: the pump ended).
    Taken(u64),
}

struct Tab {
    id: String,
    /// Creation order, kept by a respawn of the same id (Node's `terminals` map keeps the key's place).
    seq: u64,
    handle: ProcessHandle,
    shell: String,
    cwd: Option<String>,
    /// Lock order, outermost first: `TerminalTabs::tabs`, `TerminalTabs::cursor_floors`,
    /// `Tab::pty_gate`, the process feed's state (the reader admitting a chunk, [`TabFilter::admitted`]), `Tab::state`. No code holds
    /// `state` while calling the process manager or taking an earlier lock: it copies what it needs out and drops the guard first.
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

    /// Publishes a change now, after the changes still waiting for the pump (see [`RelayOrder`]).
    fn publish(&self, state: &mut TabState, change: Option<Option<ActivityState>>) {
        if let Some(order) = state.order.as_mut() {
            for (_, waiting) in order.waiting.drain(..) {
                self.events.activity(&self.id, waiting);
                order.unpublished = true;
            }
        }
        if let Some(activity) = change {
            self.events.activity(&self.id, activity);
            if let Some(order) = state.order.as_mut() {
                order.unpublished = true;
            }
        }
    }

    /// Publishes a change the output or input caused once the pump has taken the output written before it (see [`RelayOrder`]).
    fn publish_after_output(&self, state: &mut TabState, change: Option<Option<ActivityState>>) {
        let Some(activity) = change else { return };
        let emitted = state.emitted;
        match state.order.as_mut() {
            Some(order) if order.taken < emitted || !order.waiting.is_empty() => order.waiting.push_back((emitted, activity)),
            Some(order) => {
                self.events.activity(&self.id, activity);
                order.unpublished = true;
            }
            None => self.events.activity(&self.id, activity),
        }
    }

    /// Counts output the feed admitted.
    fn emitted(state: &mut TabState, bytes: usize) {
        state.emitted += bytes as u64;
    }

    /// The shell ended (the process manager's exit hook): as Node's exit handler (terminal-manager.ts:378-384), the held marker text is
    /// out already (the reader's `finish`), the tab's end follows the output before it (as any change the output causes, see
    /// [`RelayOrder`]), and the exit line is the last output. Returns that line.
    fn exited(&self, exit: &ProcessExit) -> Vec<u8> {
        let code = match exit.status {
            ExitStatus::Code(code) => code,
            ExitStatus::Signal(signal) => 128 + signal,
        };
        let line = format!("\r\n[process exited with code {code}]\r\n");
        let mut state = self.lock();
        state.exited = true;
        state.output_paused = false;
        let change = state.activity.exit();
        let emitted = state.emitted;
        match (change, state.order.as_mut()) {
            (Some(activity), Some(order)) => order.end = Some((emitted, activity)),
            (change, _) => self.publish_after_output(&mut state, change),
        }
        state.buffer.append(&line);
        Tab::emitted(&mut state, line.len());
        line.into_bytes()
    }

    /// Where the relay feed's pump is: the changes that follow no more output than it has taken go, and the shell's end once the pump
    /// reaches its exit line (or ends). The end is published before the pump goes on with the exit line: Node broadcast
    /// `activity.exit()` and then emitted the line (terminal-manager.ts:378-384), so a client never got the line first. A change that
    /// goes once the pump has taken its chunk's text also reaches the clients before the relay buffer sends that text: Node applied the
    /// marker synchronously after emitting the chunk into its 16 ms buffer, so the buffer's flush always came after the change. The
    /// returned publication (of whatever went here) is what the pump waits for.
    fn pumped(&self, at: PumpPoint) -> Option<Published> {
        let mut state = self.lock();
        let order = state.order.as_mut()?;
        let (taken, reached) = match at {
            PumpPoint::Reaching(offset) => (order.taken.max(offset), offset),
            PumpPoint::Taken(taken) => (taken, if taken == u64::MAX { u64::MAX } else { 0 }),
        };
        order.taken = taken;
        // Output about to enter the relay buffer follows every change that already went at once.
        let mut went = matches!(at, PumpPoint::Reaching(_)) && std::mem::take(&mut order.unpublished);
        while order.waiting.front().is_some_and(|(after, _)| *after <= taken) {
            let (_, activity) = order.waiting.pop_front().expect("a waiting change");
            self.events.activity(&self.id, activity);
            went = true;
        }
        if order.waiting.is_empty() && order.end.is_some_and(|(line, _)| line <= reached) {
            let (_, activity) = order.end.take().expect("the end waits");
            self.events.activity(&self.id, activity);
            went = true;
        }
        if went { self.events.published() } else { None }
    }

    /// The pump has taken `taken` bytes of output (tests name it so).
    #[cfg(test)]
    fn taken(&self, taken: u64) {
        let _ = self.pumped(PumpPoint::Taken(taken));
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

/// Runs on the PTY's reader thread: markers out, bytes decoded to text; once the feed admits the text, text into the replay window and
/// the markers applied (see [`RelayOrder`]). What it returns is what the feed carries, so feed events are always whole UTF-8.
struct TabFilter {
    tab: Arc<Tab>,
    /// The chunk the last `filter` or `finish` returned, and its markers: applied to the tab when the feed admits it.
    text: String,
    markers: Vec<Marker>,
}

impl TabFilter {
    fn new(tab: Arc<Tab>) -> Self {
        Self { tab, text: String::new(), markers: Vec::new() }
    }
}

impl OutputFilter for TabFilter {
    fn filter(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut state = self.tab.lock();
        let decoded = state.decoder.push(bytes);
        let (text, markers) = match state.scanner.as_mut() {
            Some(scanner) => scanner.scan(&decoded),
            None => (decoded, Vec::new()),
        };
        self.text = text;
        self.markers = markers;
        self.text.as_bytes().to_vec()
    }

    fn finish(&mut self) -> Vec<u8> {
        let mut state = self.tab.lock();
        let mut text = state.scanner.as_mut().map(MarkerScanner::flush).unwrap_or_default();
        text.push_str(&state.decoder.finish());
        self.text = text;
        self.markers.clear();
        self.text.as_bytes().to_vec()
    }

    fn admitted(&mut self) -> bool {
        let mut state = self.tab.lock();
        let text = std::mem::take(&mut self.text);
        state.buffer.append(&text);
        Tab::emitted(&mut state, text.len());
        let mut changed = false;
        for marker in self.markers.drain(..) {
            let change = state.activity.marker(marker);
            changed |= change.is_some();
            self.tab.publish_after_output(&mut state, change);
        }
        changed
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

/// How long a size claim holds without being renewed (`SIZE_OWNER_LEASE_MS`): a phone renews every
/// 10 s while it shows the terminal, so a claim that stops renewing (a lost connection) lapses
/// and the PC fits its own pane again.
/// How many gates the operations on claims are spread over (an id always takes the same one).
const GATES: usize = 16;
pub const SIZE_OWNER_LEASE: std::time::Duration = std::time::Duration::from_secs(30);

struct SizeClaim {
    client: String,
    cols: u16,
    rows: u16,
    lease: Option<mixdog_rt::TimerHandle>,
    /// Which arming of the lease is current: a lapse of an older arming is ignored.
    epoch: u64,
    /// On the manual lease clock (debug builds only), when this claim lapses.
    #[cfg(feature = "lease-clock")]
    due: Option<std::time::Duration>,
}

/// The lease clock a replay steps by hand. It exists in debug builds only, and only when
/// `MIXDOG_TERMINAL_LEASE_CLOCK=<directory>` is set: the leases then lapse exactly when [`Claims::advance`]
/// moves time past them, instead of on the ticker. A release build has neither the clock nor the switch.
#[cfg(feature = "lease-clock")]
struct ManualLeaseClock {
    now: Mutex<std::time::Duration>,
    secret: Option<String>,
}

/// Per tab id, the connections claiming its size, oldest claim first; the newest claim owns.
/// Claims belong to the id, not to a running process (Node's `sizeClaims`): a claim made before
/// the tab exists stands, and only a dispose forgets it.
struct Claims {
    map: Mutex<HashMap<String, Vec<SizeClaim>>>,
    /// Orders the operations on one id from the change of its claims to the end of its announcement. Node does this by being one thread:
    /// a claim changes the map, fits the PTY and tells its listeners before any other call runs. The map's own lock is held only to change
    /// the map, so a PTY fit that blocks holds back the ids that share its gate, not every tab.
    gates: [Mutex<()>; GATES],
    tabs: Arc<Mutex<HashMap<String, Slot>>>,
    events: Arc<dyn TerminalEvents>,
    epoch: AtomicU64,
    #[cfg(feature = "lease-clock")]
    manual: Option<ManualLeaseClock>,
    #[cfg(feature = "core-test")]
    gate_waiting: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

/// How many ids one connection may hold a size claim on at once. Node bounds nothing (`sizeClaims`, terminal-manager.ts:455): a
/// client renewing claims on arbitrary ids kept a map entry and a timer alive for each. A phone claims the tabs it shows; a claim
/// beyond this many is ignored, as a claim on a tab that is gone would be.
const MAX_CLAIMS_PER_CLIENT: usize = 256;

impl Claims {
    /// Moves the manual lease clock on by `by` and ends, in the order of their lapse, every claim now due. Returns
    /// how many lapsed; without the manual clock nothing is done.
    #[cfg(feature = "lease-clock")]
    fn advance(&self, by: std::time::Duration) -> usize {
        let Some(clock) = &self.manual else {
            return 0;
        };
        let now = {
            let mut now = clock.now.lock().unwrap_or_else(|e| e.into_inner());
            *now += by;
            *now
        };
        let mut lapsed = 0;
        loop {
            let next = self
                .lock()
                .iter()
                .flat_map(|(id, list)| list.iter().filter_map(move |c| c.due.filter(|due| *due <= now).map(|due| (due, id.clone(), c.client.clone(), c.epoch))))
                .min();
            let Some((_, id, client, epoch)) = next else {
                return lapsed;
            };
            self.release(&id, &client, Some(epoch));
            lapsed += 1;
        }
    }

    /// The replay's handle on the manual clock, with no wire method (the method table is shared with release builds): a loopback
    /// socket whose port is written to `<dir>/port`. A client sends `advance <ms>\n`; the clock steps by `ms`, ends every claim then due,
    /// and answers `lapsed <n>\n` (`n` claims ended), so the answer is the completion signal. Each connection has a thread of its own.
    #[cfg(feature = "lease-clock")]
    fn serve_manual_clock(claims: &Arc<Self>, dir: std::path::PathBuf) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("the manual lease clock binds a loopback port");
        let port = listener.local_addr().expect("the bound port").port();
        std::fs::write(dir.join("port.tmp"), port.to_string()).and_then(|()| std::fs::rename(dir.join("port.tmp"), dir.join("port"))).expect("the manual lease clock publishes its port");
        let claims = Arc::downgrade(claims);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                // A connection of its own thread: one that leaves a line unfinished cannot hold back another's advance request.
                let claims = claims.clone();
                std::thread::spawn(move || Self::serve_manual_clock_connection(&claims, stream));
            }
        });
    }

    /// One control connection, served on its own thread: a client that leaves a line unfinished holds only its own connection.
    #[cfg(feature = "lease-clock")]
    fn serve_manual_clock_connection(claims: &std::sync::Weak<Self>, stream: std::net::TcpStream) {
        use clock_control::{Ended, IDLE_DEADLINE, LINE_DEADLINE, WRITE_DEADLINE};
        let Ok(reader) = stream.try_clone() else { return };
        let mut stream = stream;
        let mut lines = std::io::BufReader::new(reader);
        // Any local process can reach a loopback port: only a client that knows the run's secret (set by the test that started
        // this core) moves the clock. Without a secret nobody does.
        let Some(secret) = claims.upgrade().and_then(|claims| claims.manual.as_ref().map(|manual| manual.secret.clone())) else { return };
        let mut admitted = false;
        loop {
            let answer = match clock_control::read_command(&mut lines, IDLE_DEADLINE, LINE_DEADLINE) {
                Ok(line) if !admitted => {
                    if secret.as_deref().is_some_and(|secret| line.trim_end() == format!("secret {secret}")) {
                        admitted = true;
                        "admitted\n".to_owned()
                    } else {
                        let _ = clock_control::answer(&mut stream, "refused: the first line must be `secret <the run's secret>`\n", WRITE_DEADLINE);
                        return;
                    }
                }
                Ok(line) => match (line.strip_prefix("advance ").and_then(|ms| ms.trim().parse::<u64>().ok()), claims.upgrade()) {
                    (Some(ms), Some(claims)) => format!("lapsed {}\n", claims.advance(std::time::Duration::from_millis(ms))),
                    _ => "refused\n".to_owned(),
                },
                Err(Ended::Closed) => return,
                Err(Ended::Refused(message)) => {
                    // The client is told what was awaited and the connection ends (its thread and sockets are released).
                    let _ = clock_control::answer(&mut stream, &format!("refused: {message}\n"), WRITE_DEADLINE);
                    eprintln!("mixdog lease clock: {message}; the control connection was closed");
                    return;
                }
            };
            if let Err(message) = clock_control::answer(&mut stream, &answer, WRITE_DEADLINE) {
                eprintln!("mixdog lease clock: {message}; the control connection was closed");
                return;
            }
        }
    }
    #[cfg(feature = "lease-clock")]
    fn due_at(&self) -> Option<std::time::Duration> {
        self.manual.as_ref().map(|clock| *clock.now.lock().unwrap_or_else(|e| e.into_inner()) + SIZE_OWNER_LEASE)
    }

    fn gate(&self, id: &str) -> MutexGuard<'_, ()> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hasher);
        let gate = &self.gates[hasher.finish() as usize % GATES];
        #[cfg(feature = "core-test")]
        if let Some(waiting) = &self.gate_waiting {
            match gate.try_lock() {
                Ok(guard) => return guard,
                Err(std::sync::TryLockError::Poisoned(e)) => return e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => waiting(id),
            }
        }
        gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<SizeClaim>>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn owner_in(list: &[SizeClaim]) -> Option<SizeOwner> {
        list.last().map(|claim| SizeOwner {
            cols: claim.cols,
            rows: claim.rows,
            owner: claim.client.clone(),
        })
    }

    /// The owner once every change of the id's claims under way has fitted the PTY and been announced (read under the id's gate):
    /// an attach never shows an owner whose fit and announcement are still to come.
    fn owner_of(&self, id: &str) -> Option<SizeOwner> {
        let _gate = self.gate(id);
        self.lock().get(id).and_then(|list| Self::owner_in(list))
    }

    /// Fits the running tab's PTY to `cols` x `rows`; a missing or exited tab is left alone.
    fn apply_size(&self, id: &str, cols: u16, rows: u16) {
        let tab = match self.tabs.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            Some(Slot::Live(tab)) => Arc::clone(tab),
            _ => return,
        };
        if !tab.running() {
            return;
        }
        tab.lock().size = (cols, rows);
        tab.sync_size();
    }

    /// Applies and announces the new effective owner when it differs. Called under the id's gate,
    /// so the PTY sizes and the announcements keep the order of the changes.
    fn changed(&self, id: &str, before: Option<SizeOwner>, after: Option<SizeOwner>) {
        if before == after {
            return;
        }
        if let Some(owner) = &after {
            self.apply_size(id, owner.cols, owner.rows);
        }
        self.events.size_owner(&SizeOwnerChange {
            id: id.to_owned(),
            cols: after.as_ref().map_or(0, |o| o.cols),
            rows: after.as_ref().map_or(0, |o| o.rows),
            owner: after.map(|o| o.owner).unwrap_or_default(),
        });
    }

    fn arm(self: &Arc<Self>, id: &str, client: &str, epoch: u64) -> Option<mixdog_rt::TimerHandle> {
        #[cfg(feature = "lease-clock")]
        if self.manual.is_some() {
            return None;
        }
        let claims = Arc::downgrade(self);
        let (id, client) = (id.to_owned(), client.to_owned());
        // The ticker's callback only hands the lapse to a task: releasing fits a PTY.
        Some(mixdog_rt::ticker().register(std::time::Instant::now() + SIZE_OWNER_LEASE, move || {
            if let Some(claims) = claims.upgrade() {
                drop(mixdog_rt::spawn("terminal-size-lease", mixdog_rt::TaskClass::Work, async move {
                    claims.release(&id, &client, Some(epoch));
                }));
            }
        }))
    }

    /// `client` claims (or renews its claim on) the size; a renewal keeps the claim's place in the order.
    fn claim(self: &Arc<Self>, id: &str, client: &str, cols: u16, rows: u16) {
        let _gate = self.gate(id);
        let (before, after) = {
        let mut map = self.lock();
        let renewing = map.get(id).is_some_and(|list| list.iter().any(|claim| claim.client == client));
        if !renewing && map.values().filter(|list| list.iter().any(|claim| claim.client == client)).count() >= MAX_CLAIMS_PER_CLIENT {
            return;
        }
        let list = map.entry(id.to_owned()).or_default();
        let before = Self::owner_in(list);
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let lease = self.arm(id, client, epoch);
        #[cfg(feature = "lease-clock")]
        let due = self.due_at();
        match list.iter_mut().find(|claim| claim.client == client) {
            Some(claim) => {
                if let Some(old) = claim.lease.take() {
                    let _ = old.cancel();
                }
                claim.cols = cols;
                claim.rows = rows;
                claim.lease = lease;
                claim.epoch = epoch;
                #[cfg(feature = "lease-clock")]
                {
                    claim.due = due;
                }
            }
            None => list.push(SizeClaim {
                client: client.to_owned(),
                cols,
                rows,
                lease,
                epoch,
                #[cfg(feature = "lease-clock")]
                due,
            }),
        }
        let after = Self::owner_in(list);
        (before, after)
        };
        self.changed(id, before, after);
    }

    /// Ends `client`'s claim: by its own release (`epoch` none) or by its lease lapsing.
    fn release(&self, id: &str, client: &str, epoch: Option<u64>) {
        let _gate = self.gate(id);
        let (before, after) = {
        let mut map = self.lock();
        let Some(list) = map.get_mut(id) else {
            return;
        };
        let Some(at) = list.iter().position(|claim| claim.client == client) else {
            return;
        };
        if epoch.is_some_and(|epoch| epoch != list[at].epoch) {
            return;
        }
        let before = Self::owner_in(list);
        if let Some(lease) = list.remove(at).lease {
            let _ = lease.cancel();
        }
        let after = Self::owner_in(list);
        if list.is_empty() {
            map.remove(id);
        }
        (before, after)
        };
        self.changed(id, before, after);
    }

    /// A resize no phone claimed: ignored while any claim stands.
    fn resize_unclaimed(&self, id: &str, cols: u16, rows: u16) {
        let _gate = self.gate(id);
        if self.lock().contains_key(id) {
            return;
        }
        self.apply_size(id, cols, rows);
    }

    /// The tab was disposed: its claims go with it, and no owner change is announced (Node's `forgetSizeClaims`,
    /// terminal-manager.ts:490, emits nothing). The caller holds the id's gate for the whole disposal, so a claim made right
    /// after is queued behind it and is not undone by it.
    fn forget_held(&self, id: &str) {
        let Some(list) = self.lock().remove(id) else {
            return;
        };
        for claim in list {
            if let Some(lease) = claim.lease {
                let _ = lease.cancel();
            }
        }
        self.events.size_claims_forgotten(id);
    }
}

/// Input a tab's queue was full for (see [`TerminalTabs::write`]). One per connection at most: the notification that made it pauses its
/// connection's reader until it is written, so what a connection can leave here is one message, bounded by the transport's frame limit.
/// Node had no bound (node-pty queues whatever `pty.write` is given, so a phone typing faster than the shell reads grew the desktop's
/// memory without end); here the queue's capacity and that one paused message are the most a connection holds.
pub struct PendingInput {
    manager: LocalProcessManager,
    handle: ProcessHandle,
    bytes: Vec<u8>,
}

impl PendingInput {
    /// Waits for room in the tab's input queue and writes the input; a tab that has gone meanwhile takes nothing, as Node's killed pty did.
    pub async fn finish(self) {
        let _ = self.manager.write_input_wait(&self.handle, self.bytes).await;
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
    Spawn {
        guard: SpawnGuard,
        prior: Option<Arc<Tab>>,
    },
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
            manual: config
                .lease_clock
                .as_ref()
                .map(|setting| ManualLeaseClock { now: Mutex::new(std::time::Duration::ZERO), secret: setting.secret.clone() }),
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
        let (replay_lead, replay) = tab.lock().buffer.read_window();
        Attached {
            id: tab.id.clone(),
            replay,
            replay_lead,
            size_owner: self.claims.owner_of(&tab.id),
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
        let attached = Attached {
            id: tab.id.clone(),
            replay,
            replay_lead,
            size_owner: self.claims.owner_of(&tab.id),
        };
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
        let seq = prior
            .as_ref()
            .map_or_else(|| self.created.fetch_add(1, Ordering::AcqRel) + 1, |prior| prior.seq);
        let tab = Arc::new(Tab {
            id: tab_id.to_owned(),
            seq,
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
                emitted: 0,
                order: None,
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
            pty: self.config.pty_size(cols, rows),
            stdin_piped: true,
            output: OutputMode::Merged,
            owner: ProcessOwner::TerminalTab {
                tab_id: TerminalTabId::from(tab_id),
            },
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
                let running = !tab.lock().exited;
                TabEntry {
                    id: tab.id.clone(),
                    shell: tab.shell.clone(),
                    running,
                    cwd: tab.cwd.clone(),
                    size_owner: self.claims.owner_of(&tab.id),
                }
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
                (!state.exited)
                    .then(|| state.activity.state())
                    .flatten()
                    .map(|s| (tab.seq, tab.id.clone(), s))
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
        let pending = match self.manager.write_input(&tab.handle, bytes.clone()) {
            Err(ProcessError::Overloaded { .. }) => Some(PendingInput { manager: self.manager.clone(), handle: tab.handle.clone(), bytes }),
            _ => None,
        };
        let mut state = tab.lock();
        if state.scanner.is_some() {
            let change = state.activity.input(data);
            tab.publish_after_output(&mut state, change);
        }
        pending
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
        let Some(tab) = self.running(id) else {
            return;
        };
        let client = if client.is_empty() { "desktop" } else { client };
        let mut state = tab.lock();
        let change = state.activity.set_focus(client, focused);
        tab.publish(&mut state, change);
    }

    /// A connection closed: its focus ends on every tab. Its size claims are not released: Node's
    /// lease lapses them (a phone that reconnects holds a new connection id).
    pub fn connection_closed(&self, client: &str) {
        for tab in self.all_tabs() {
            let mut state = tab.lock();
            let change = state.activity.set_focus(client, false);
            tab.publish(&mut state, change);
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
            tab.publish(&mut state, change);
            (was_paused, state.buffer.cursor())
        };
        self.claims.forget_held(&tab.id);
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
        // Each tab goes as a single dispose does, its removal under its gate, so no claim or owner read sees it half gone.
        for tab in self.all_tabs() {
            self.dispose(&tab.id);
        }
        self.table().clear();
    }
}

#[cfg(all(test, feature = "core-test"))]
mod lock_order {
    use std::sync::mpsc;
    use std::time::Duration;
    use std::time::Instant;

    use mixdog_core_api::domain::process::OutputStream;

    use super::*;
    use crate::manager::ProcessConfig;

    struct Quiet;

    impl TerminalEvents for Quiet {
        fn activity(&self, _: &str, _: Option<ActivityState>) {}
        fn size_owner(&self, _: &SizeOwnerChange) {}
        fn size_claims_forgotten(&self, _: &str) {}
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
            seq: 1,
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
                emitted: 0,
                order: None,
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

    struct Recorded(Mutex<Vec<Option<ActivityState>>>);

    impl TerminalEvents for Recorded {
        fn activity(&self, _: &str, state: Option<ActivityState>) {
            self.0.lock().unwrap().push(state);
        }
        fn size_owner(&self, _: &SizeOwnerChange) {}
        fn size_claims_forgotten(&self, _: &str) {}
    }

    /// A tab of a shell with integration whose relay feed pumps (`relay_order`), publishing to `events`.
    fn relay_tab(events: Arc<dyn TerminalEvents>, manager: LocalProcessManager, handle: &str) -> Arc<Tab> {
        Arc::new(Tab {
            id: handle.to_owned(),
            seq: 1,
            handle: ProcessHandle::from(handle),
            shell: "pwsh".to_owned(),
            cwd: None,
            state: Mutex::new(TabState {
                buffer: ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0),
                scanner: Some(MarkerScanner::default()),
                decoder: Utf8Decoder::default(),
                activity: ActivityTracker::new(false),
                exited: false,
                output_paused: false,
                size: (80, 24),
                emitted: 0,
                order: Some(RelayOrder::default()),
            }),
            pty_gate: Mutex::new(()),
            events,
            manager,
        })
    }

    /// With the relay feed pumping (`relay_order`), a change a chunk's marker causes goes once the pump has taken that chunk's text, not
    /// before (Node emitted the text into its relay buffer and then applied the marker); a change published directly goes after it.
    #[test]
    fn a_marker_change_waits_for_the_pump_to_take_its_chunk() {
        let events = Arc::new(Recorded(Mutex::new(Vec::new())));
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_1");
        let seen = || events.0.lock().unwrap().clone();
        let mut filter = TabFilter::new(Arc::clone(&tab));
        let text = filter.filter(b"PS> \x1b]697;P\x07");
        assert_eq!(text, b"PS> ");
        filter.admitted();
        assert_eq!(seen(), Vec::new(), "the prompt's change waits for its text to be taken");
        tab.taken(3);
        assert_eq!(seen(), Vec::new(), "part of the text is not enough");
        tab.taken(4);
        assert_eq!(seen(), vec![Some(ActivityState::Idle)]);
        let _ = filter.filter(b"x\r\n\x1b]697;C\x07");
        filter.admitted();
        tab.publish(&mut tab.lock(), Some(Some(ActivityState::Finished)));
        assert_eq!(seen(), vec![Some(ActivityState::Idle), Some(ActivityState::Running), Some(ActivityState::Finished)], "a direct change goes after the waiting ones");
        tab.taken(u64::MAX);
        assert_eq!(seen().len(), 3, "nothing goes twice");
    }

    /// Events whose publication is asked for: each `published` is counted (the pump waits on what it returns).
    struct Publishing(Mutex<(Vec<Option<ActivityState>>, usize)>);

    impl TerminalEvents for Publishing {
        fn activity(&self, _: &str, state: Option<ActivityState>) {
            self.0.lock().unwrap().0.push(state);
        }
        fn size_owner(&self, _: &SizeOwnerChange) {}
        fn size_claims_forgotten(&self, _: &str) {}
        fn published(&self) -> Option<Published> {
            self.0.lock().unwrap().1 += 1;
            let (done, published) = tokio::sync::oneshot::channel();
            let _ = done.send(());
            Some(published)
        }
    }

    /// A change the pump releases by taking its chunk is one the pump waits to see published before it goes on (and so before the relay
    /// buffer sends that chunk's text, as Node's flush came after its synchronous broadcast); a take that releases nothing gives no wait.
    #[test]
    fn the_pump_waits_for_the_change_its_take_released() {
        let events = Arc::new(Publishing(Mutex::new((Vec::new(), 0))));
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_wait");
        let mut filter = TabFilter::new(Arc::clone(&tab));
        let prompt = filter.filter(b"PS> \x1b]697;P\x07").len() as u64;
        filter.admitted();
        assert!(tab.pumped(PumpPoint::Taken(prompt - 1)).is_none(), "nothing went, nothing to wait for");
        assert!(tab.pumped(PumpPoint::Taken(prompt)).is_some(), "the prompt's change went: the pump waits for its publication");
        assert_eq!(*events.0.lock().unwrap(), (vec![Some(ActivityState::Idle)], 1));
        let more = filter.filter(b"x").len() as u64;
        filter.admitted();
        assert!(tab.pumped(PumpPoint::Taken(prompt + more)).is_none(), "output without a change gives no wait");
    }

    /// A chunk holding only a marker changes the tab at once (no output of it to follow); the output read after it waits, before it enters
    /// the relay buffer, until that change is published: Node broadcast the change synchronously, so its later output never went first.
    #[test]
    fn output_after_a_change_that_went_at_once_waits_for_its_publication() {
        let events = Arc::new(Publishing(Mutex::new((Vec::new(), 0))));
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_direct");
        let mut filter = TabFilter::new(Arc::clone(&tab));
        assert_eq!(filter.filter(b"\x1b]697;C\x07").len(), 0, "the start marker's chunk carries no output");
        filter.admitted();
        assert_eq!(*events.0.lock().unwrap(), (vec![Some(ActivityState::Running)], 0), "the change went at once");
        let text = filter.filter(b"lane-cmd-1\r\n").len() as u64;
        filter.admitted();
        assert!(tab.pumped(PumpPoint::Reaching(0)).is_some(), "the output after it waits for its publication");
        assert_eq!(events.0.lock().unwrap().1, 1);
        assert!(tab.pumped(PumpPoint::Taken(text)).is_none(), "taking the output releases nothing more");
        assert!(tab.pumped(PumpPoint::Reaching(text)).is_none(), "a change waits for its publication once");
    }

    /// The shell's end follows the output before it, as Node's exit handler ordered it (terminal-manager.ts:378-384: held text out,
    /// `activity.exit()` broadcast, then the exit line emitted): the tab's end waits until the pump has taken the output admitted before
    /// the exit, and the exit line comes after it.
    #[test]
    fn the_tabs_end_follows_the_output_before_the_exit() {
        let events = Arc::new(Recorded(Mutex::new(Vec::new())));
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let tab = relay_tab(Arc::clone(&events) as Arc<dyn TerminalEvents>, manager, "term_end");
        let seen = || events.0.lock().unwrap().clone();
        let mut filter = TabFilter::new(Arc::clone(&tab));
        let prompt = filter.filter(b"PS> \x1b]697;P\x07").len() as u64;
        filter.admitted();
        tab.taken(prompt);
        assert_eq!(seen(), vec![Some(ActivityState::Idle)]);
        let last = filter.filter(b"bye\r\n").len() as u64;
        filter.admitted();
        let line = tab.exited(&ProcessExit { status: ExitStatus::Code(0), killed: None });
        assert_eq!(seen(), vec![Some(ActivityState::Idle)], "the tab's end waits for the output written before the exit");
        tab.taken(prompt + last);
        assert_eq!(seen(), vec![Some(ActivityState::Idle)], "the tab's end waits for the pump to reach the exit line, not only for the output before it");
        tab.pumped(PumpPoint::Reaching(prompt + last));
        assert_eq!(seen(), vec![Some(ActivityState::Idle), None], "the tab's end goes when the pump reaches the exit line, before the line");
        assert_eq!(tab.lock().emitted, prompt + last + line.len() as u64, "the exit line is the last output");
    }

    /// What the reader took from the pseudo-terminal and the pump, one log in order.
    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        Change(Option<ActivityState>),
        /// The pump told the tab it has taken the output up to this offset.
        Taken(u64),
    }

    struct Logged {
        log: Mutex<Vec<Seen>>,
        changed: std::sync::Condvar,
    }

    impl Logged {
        fn new() -> Arc<Self> {
            Arc::new(Self { log: Mutex::new(Vec::new()), changed: std::sync::Condvar::new() })
        }

        fn push(&self, seen: Seen) {
            self.log.lock().unwrap().push(seen);
            self.changed.notify_all();
        }

        /// The log once `done` holds of it; the deadline only names what never came.
        fn until(&self, what: &str, done: impl Fn(&[Seen]) -> bool) -> Vec<Seen> {
            let log = self.log.lock().unwrap();
            let (log, waited) = self.changed.wait_timeout_while(log, Duration::from_secs(60), |log| !done(log)).unwrap();
            assert!(!waited.timed_out(), "never seen: {what}; seen {:?}", *log);
            log.clone()
        }
    }

    impl TerminalEvents for Logged {
        fn activity(&self, _: &str, state: Option<ActivityState>) {
            self.push(Seen::Change(state));
        }
        fn size_owner(&self, _: &SizeOwnerChange) {}
        fn size_claims_forgotten(&self, _: &str) {}
    }

    fn piped(handle: &ProcessHandle, script: &str, posix: &str) -> SpawnRequest {
        let command = if cfg!(windows) {
            CommandSpec::Argv { program: "powershell".to_owned(), args: vec!["-NoProfile".to_owned(), "-Command".to_owned(), script.to_owned()] }
        } else {
            CommandSpec::Argv { program: "sh".to_owned(), args: vec!["-c".to_owned(), posix.to_owned()] }
        };
        SpawnRequest {
            handle: handle.clone(),
            command,
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            env: EnvSpec { inherit: true, ..EnvSpec::default() },
            pty: None,
            stdin_piped: true,
            output: OutputMode::Merged,
            owner: ProcessOwner::Internal,
            time_limit: None,
        }
    }

    fn pump(manager: &LocalProcessManager, tab: &Arc<Tab>, logged: &Arc<Logged>) -> Arc<crate::service::ProcessFeeds> {
        let feeds = crate::service::ProcessFeeds::new(
            manager.clone(),
            Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())),
        );
        let (tab, logged) = (Arc::clone(tab), Arc::clone(logged));
        let held = feeds.open_terminal(&tab.id.clone(), move || {
            Some(Arc::new(move |at: PumpPoint| {
                if let PumpPoint::Taken(taken) = at {
                    logged.push(Seen::Taken(taken));
                }
                tab.pumped(at)
            }) as PumpTell)
        });
        drop(held);
        feeds
    }

    /// C3 (a): the pump subscribed on an empty ring (`evicted` false) or after the ring dropped the start (true); then a paused producer
    /// holds a chunk at the gate, a claim's hold goes in, and the producer resumes while the hold stands. The chunk enters the feed but
    /// the pump stops for the hold: its change does not go. Once the hold ends the pump takes the chunk at its absolute offset (the
    /// feed's own count, the tab's `emitted`), and the change goes then.
    async fn a_claim_holds_a_resumed_producers_chunk(evicted: bool) {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_resumed_{evicted}_{}", std::process::id()));
        let logged = Logged::new();
        let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        manager
            .spawn_with(
                piped(
                    &handle,
                    "$null = [Console]::In.ReadLine(); [Console]::Out.Write(('x' * 70000) + [char]27 + ']697;P' + [char]7); \
                     $null = [Console]::In.ReadLine(); [Console]::Out.Write('z' + [char]27 + ']697;C' + [char]7); $null = [Console]::In.ReadLine()",
                    "read a; printf '%070000d\\033]697;P\\007' 0; read b; printf 'z\\033]697;C\\007'; read c",
                ),
                SpawnOptions { ring_bytes: Some(1024), filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
            )
            .await
            .unwrap();
        let feeds = if evicted {
            let mut watch = manager.subscribe(&handle, None).unwrap();
            manager.write_input(&handle, b"1\n".to_vec()).unwrap();
            let mut read = 0;
            while read < 70000 {
                match tokio::time::timeout(Duration::from_secs(60), watch.next()).await.expect("the first write arrives within 60 s") {
                    Some(ProcessEvent::Output { bytes, .. }) => read += bytes.len(),
                    other => panic!("the first write, not {other:?}"),
                }
            }
            drop(watch);
            assert!(matches!(manager.subscribe(&handle, Some(0)), Err(ProcessError::ReplayUnavailable { .. })), "the ring dropped the start");
            let feeds = pump(&manager, &tab, &logged);
            logged.until("the first write's change", |log| log.contains(&Seen::Change(Some(ActivityState::Idle))));
            feeds
        } else {
            assert_eq!(manager.output_pushed(&handle).unwrap(), 0, "the ring is empty when the pump subscribes");
            let feeds = pump(&manager, &tab, &logged);
            // The first write goes unread here: its marker's change is not what this checks.
            manager.write_input(&handle, b"1\n".to_vec()).unwrap();
            logged.until("the first write's change", |log| log.contains(&Seen::Change(Some(ActivityState::Idle))));
            feeds
        };
        let before = manager.output_pushed(&handle).unwrap();
        manager.set_output_paused(&handle, true).unwrap();
        manager.write_input(&handle, b"2\n".to_vec()).unwrap();
        tokio::time::timeout(Duration::from_secs(60), manager.output_blocked(&handle)).await.expect("the producer parked the chunk at the gate").unwrap();
        let held = feeds.hold_new_output(handle.as_str()).expect("the feed exists");
        let mut stops = feeds.stops_of(handle.as_str());
        let stopped = *stops.borrow_and_update();
        manager.set_output_paused(&handle, false).unwrap();
        tokio::time::timeout(Duration::from_secs(60), stops.wait_for(|stops| *stops > stopped)).await.expect("the pump stopped for the hold").unwrap();
        let total = manager.output_pushed(&handle).unwrap();
        assert!(total > before, "the resumed chunk entered the feed");
        let log = logged.log.lock().unwrap().clone();
        assert!(!log.contains(&Seen::Change(Some(ActivityState::Running))), "the held chunk's change went: {log:?}");
        assert!(log.iter().all(|seen| !matches!(seen, Seen::Taken(taken) if *taken > before)), "the pump took held output: {log:?}");
        drop(held);
        let log = logged.until("the resumed chunk's change", |log| log.contains(&Seen::Change(Some(ActivityState::Running))));
        let at = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Running))).unwrap();
        assert_eq!(log[..at].last(), Some(&Seen::Taken(total)), "the change goes when the pump takes the chunk, at the feed's offset: {log:?}");
        let _ = manager.kill(&handle);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_claim_holds_a_resumed_producers_chunk_after_an_empty_ring() {
        a_claim_holds_a_resumed_producers_chunk(false).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_claim_holds_a_resumed_producers_chunk_after_an_eviction() {
        a_claim_holds_a_resumed_producers_chunk(true).await;
    }

    /// The pump starts after the ring dropped the start of the output (more than one event's worth went by before anyone read): it
    /// counts from its first event's offset, the feed's own offset the tab counted too, so the last marker's change goes when the pump
    /// takes the chunk it came in, not only when the pump ends.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_pump_counts_from_its_first_event_after_an_evicted_prefix() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_evicted_{}", std::process::id()));
        let logged = Logged::new();
        let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        let (exited, exit) = std::sync::mpsc::channel();
        manager
            .spawn_with(
                piped(
                    &handle,
                    "[Console]::Out.Write(('x' * 70000) + [char]27 + ']697;P' + [char]7)",
                    "printf '%070000d\\033]697;P\\007' 0",
                ),
                SpawnOptions {
                    ring_bytes: Some(1024),
                    filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
                    on_exit: Some(Box::new(move |_| {
                        let _ = exited.send(());
                        Vec::new()
                    })),
                    ..SpawnOptions::default()
                },
            )
            .await
            .unwrap();
        exit.recv_timeout(Duration::from_secs(60)).expect("the process printed and ended");
        assert!(matches!(manager.subscribe(&handle, Some(0)), Err(ProcessError::ReplayUnavailable { .. })), "the ring dropped the start");
        let total = manager.output_pushed(&handle).unwrap();
        pump(&manager, &tab, &logged);
        let log = logged.until("the pump's end", |log| log.contains(&Seen::Taken(u64::MAX)));
        let change = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Idle))).expect("the prompt's change went");
        assert_eq!(log[..change].last(), Some(&Seen::Taken(total)), "the change goes when the pump has taken the whole output: {log:?}");
    }

    /// The ring drops the oldest event the pump would start at between finding it and subscribing there (the producer, unsubscribed,
    /// evicts it: the feed's refusal seam pushes output at exactly that point). The pump finds and subscribes in one step, so it keeps
    /// pumping: a later chunk's change goes when the pump takes that chunk, not at a pump's end.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_eviction_while_the_pump_subscribes_does_not_end_it() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_evicting_{}", std::process::id()));
        let logged = Logged::new();
        let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        manager
            .spawn_with(
                piped(
                    &handle,
                    "$null = [Console]::In.ReadLine(); [Console]::Out.Write(('x' * 70000) + [char]27 + ']697;P' + [char]7); \
                     $null = [Console]::In.ReadLine(); [Console]::Out.Write('z' + [char]27 + ']697;C' + [char]7); $null = [Console]::In.ReadLine()",
                    "read a; printf '%070000d\\033]697;P\\007' 0; read b; printf 'z\\033]697;C\\007'; read c",
                ),
                SpawnOptions { ring_bytes: Some(1024), filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
            )
            .await
            .unwrap();
        // The first write, all in the feed (read as it comes, so the reader never waits on this reader).
        let mut watch = manager.subscribe(&handle, None).unwrap();
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        let mut read = 0;
        while read < 70000 {
            match tokio::time::timeout(Duration::from_secs(60), watch.next()).await.expect("the first write arrives within 60 s") {
                Some(ProcessEvent::Output { bytes, .. }) => read += bytes.len(),
                other => panic!("the first write, not {other:?}"),
            }
        }
        drop(watch);
        assert!(matches!(manager.subscribe(&handle, Some(0)), Err(ProcessError::ReplayUnavailable { .. })), "the ring dropped the start");
        let feed = manager.feed_of(&handle).unwrap();
        let (seam_feed, mut producer) = (Arc::clone(&feed), TabFilter::new(Arc::clone(&tab)));
        feed.on_refused(move || {
            let bytes = producer.filter(&[b'y'; 2048]);
            seam_feed.admit(OutputStream::Stdout, &bytes, || producer.admitted());
        });
        pump(&manager, &tab, &logged);
        logged.until("the first write's change", |log| log.contains(&Seen::Change(Some(ActivityState::Idle))));
        manager.write_input(&handle, b"2\n".to_vec()).unwrap();
        let log = logged.until("the later chunk's change", |log| log.contains(&Seen::Change(Some(ActivityState::Running))));
        let at = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Running))).unwrap();
        let total = manager.output_pushed(&handle).unwrap();
        assert_eq!(log[..at].last(), Some(&Seen::Taken(total)), "the later chunk's change goes when the pump takes it: {log:?}");
        let _ = manager.kill(&handle);
    }

    /// The exit line is an event of its own: with the output before the exit unread when the shell ends (the pump not yet running), the
    /// tab's end goes once the pump has taken that output and before it takes the exit line (Node: the text, `activity.exit()`, then the
    /// exit line, terminal-manager.ts:378-384), however the feed merged the output before it.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_tabs_end_goes_between_the_output_before_the_exit_and_the_exit_line() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_exit_line_{}", std::process::id()));
        let logged = Logged::new();
        let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        let mut request = piped(&handle, "[Console]::Out.Write('x' + [char]27 + ']697;P' + [char]7)", "printf 'x\\033]697;P\\007'");
        request.pty = Some(PtySize { cols: 80, rows: 24 });
        let ending = Arc::clone(&tab);
        manager
            .spawn_with(
                request,
                SpawnOptions {
                    filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))),
                    on_exit: Some(Box::new(move |exit| ending.exited(exit))),
                    ..SpawnOptions::default()
                },
            )
            .await
            .unwrap();
        let feed = manager.feed_of(&handle).unwrap();
        tokio::time::timeout(Duration::from_secs(60), feed.ended()).await.expect("the shell ended within 60 s");
        let total = manager.output_pushed(&handle).unwrap();
        let line = match manager.info(&handle).unwrap().exit.expect("the shell ended").status {
            ExitStatus::Code(code) => format!("\r\n[process exited with code {code}]\r\n").len() as u64,
            ExitStatus::Signal(signal) => format!("\r\n[process exited with code {}]\r\n", 128 + signal).len() as u64,
        };
        pump(&manager, &tab, &logged);
        let log = logged.until("the pump's end", |log| log.contains(&Seen::Taken(u64::MAX)));
        let end = log.iter().position(|seen| *seen == Seen::Change(None)).expect("the tab's end went");
        let taken = log[..end].iter().rev().find(|seen| matches!(seen, Seen::Taken(_)));
        assert_eq!(taken, Some(&Seen::Taken(total - line)), "the tab's end goes once the output before the exit is taken: {log:?}");
        assert_eq!(log.get(end + 1), Some(&Seen::Taken(total)), "the exit line is taken after the tab's end: {log:?}");
    }

    /// Three reads enter the feed before the pump takes any (a loaded machine: run 9 of the terminal replay, term_ph2_i2's screen clear and
    /// prompt sent as one frame before its `idle`): the screen clear, the prompt's marker with the prompt, and more output. Node took each
    /// read on its own (its text, then its markers), so the pump takes the read before the marker's, then the marker's read, publishes
    /// its change, and only then takes the output after it.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_pump_takes_a_markers_read_apart_from_the_reads_around_it() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_reads_{}", std::process::id()));
        let logged = Logged::new();
        let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        manager
            .spawn_with(
                piped(&handle, "$null = [Console]::In.ReadLine()", "read a"),
                SpawnOptions { filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
            )
            .await
            .unwrap();
        let feed = manager.feed_of(&handle).unwrap();
        let mut producer = TabFilter::new(Arc::clone(&tab));
        let mut read = |bytes: &[u8]| {
            let text = producer.filter(bytes);
            feed.admit(OutputStream::Stdout, &text, || producer.admitted());
            text.len() as u64
        };
        let clear = read(b"\x1b[2J\x1b[H");
        let prompt = read(b"\x1b]697;P\x07PS> ");
        let after = read(b"x");
        pump(&manager, &tab, &logged);
        let log = logged.until("the pump took every read", |log| log.contains(&Seen::Taken(clear + prompt + after)));
        assert_eq!(
            log,
            vec![
                Seen::Taken(clear),
                Seen::Taken(clear + prompt),
                Seen::Change(Some(ActivityState::Idle)),
                Seen::Taken(clear + prompt + after)
            ],
            "each read is taken on its own, the marker's change right after its read"
        );
        let _ = manager.kill(&handle);
    }

    /// A chunk the paused producer holds at the feed's gate has not been read (Node's paused PTY read nothing): its marker is not applied,
    /// so a change published meanwhile goes alone; once resumed, the chunk enters the feed and its change follows when the pump takes it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_paused_producers_chunk_changes_nothing_until_it_enters_the_feed() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("term_paused_{}", std::process::id()));
        let logged = Logged::new();
        let tab = relay_tab(Arc::clone(&logged) as Arc<dyn TerminalEvents>, manager.clone(), handle.as_str());
        manager
            .spawn_with(
                piped(
                    &handle,
                    "$null = [Console]::In.ReadLine(); [Console]::Out.Write('x' + [char]27 + ']697;P' + [char]7); $null = [Console]::In.ReadLine()",
                    "read a; printf 'x\\033]697;P\\007'; read b",
                ),
                SpawnOptions { filter: Some(Box::new(TabFilter::new(Arc::clone(&tab)))), ..SpawnOptions::default() },
            )
            .await
            .unwrap();
        pump(&manager, &tab, &logged);
        manager.set_output_paused(&handle, true).unwrap();
        manager.write_input(&handle, b"go\n".to_vec()).unwrap();
        tokio::time::timeout(Duration::from_secs(60), manager.output_blocked(&handle))
            .await
            .expect("the reader reached the paused gate with the chunk")
            .unwrap();
        tab.publish(&mut tab.lock(), Some(Some(ActivityState::Finished)));
        let changes = |log: &[Seen]| log.iter().filter(|seen| matches!(seen, Seen::Change(_))).cloned().collect::<Vec<_>>();
        assert_eq!(changes(&logged.until("the direct change", |log| !changes(log).is_empty())), vec![Seen::Change(Some(ActivityState::Finished))], "the held chunk's marker was applied before the chunk was read");
        manager.set_output_paused(&handle, false).unwrap();
        let log = logged.until("the chunk's change", |log| changes(log).len() == 2);
        assert_eq!(changes(&log), vec![Seen::Change(Some(ActivityState::Finished)), Seen::Change(Some(ActivityState::Idle))]);
        let at = log.iter().position(|seen| *seen == Seen::Change(Some(ActivityState::Idle))).unwrap();
        assert!(matches!(log[..at].last(), Some(Seen::Taken(taken)) if *taken != u64::MAX), "the change went when the pump took its chunk: {log:?}");
        let _ = manager.kill(&handle);
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
        fn size_claims_forgotten(&self, _: &str) {}
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