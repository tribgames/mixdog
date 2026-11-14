//! The phone's screen input, served by the resident `mixdog-computer --screen-input` process (Node: `screen-input-host.ts`
//! `createScreenInputHost`, with the pointer mapping of `screen-input-dispatch.ts` and the timeouts of `screen-timeouts.ts`).
//! The process injects through Computer Use's own checked `SendInput` transport and ownership receipt and watches which
//! desktop takes input; no Electron, PowerShell or C# is involved.
//!
//! Line protocol, ASCII, one command per line on the process's stdin (`native/mixdog-computer/src/screen_input.rs`):
//!   `m <id> <x> <y>`                       absolute move, desktop pixels
//!   `b <id> <l|r|m> <0|1> [<x> <y>]`       button up/down, optionally at a point
//!   `w <id> <x> <y> <dx> <dy>`             wheel at a point, wheel units (+ = down/right)
//!   `k <id> <vk> <scan> <ext 0|1> <0|1>`   key up/down
//!   `t <id> <base64 utf-8>`                literal text
//!   `c <id>`                               cursor position -> `ok <id> <x> <y>`
//!   `q`                                    release everything the process holds, exit
//! Its stdout: the first `desktop` line, then `ready <windows session id>`, then `desktop <name|-> <consent 0|1> <logonui
//! 0|1>` on change, `ok <id> ...` / `err <id> <code>` per command and `released` once it let go on `q` or end of stdin.
//!
//! - Ordered: every call takes its turn of one queue, so a release always follows the command it must undo and a run of
//!   input (`apply_all`, a `screen-keys` combo) is never interleaved with another.
//! - Released: `release_all` lifts every key and button this side holds; `stop` sends `q`; the process lifting what it holds on
//!   end of stdin means a core that dies never leaves a key or button down. A process that ends without saying `released`
//!   (a crash, a kill for a missed acknowledgment) is followed by `mixdog-computer --abort-cleanup` under the same input
//!   marker, which lifts what its ownership receipt records. The cleanups of one process finish before the next starts.
//! - Bounded: a command that is not acknowledged within [`SCREEN_COMMAND_TIMEOUT`] retires the process (whatever it did
//!   later would be unordered against the releases that follow), a start within [`START_TIMEOUT`], a stop within
//!   [`STOP_TIMEOUT`] (then it is retired), a cleanup within [`ABORT_CLEANUP_TIMEOUT`].
//! - Geometry: pointer and wheel points are video pixels of one geometry generation; [`ScreenGeometry`] (implemented by the
//!   screen source) maps them to physical desktop pixels, and an input of another generation is refused.
//!
//! Where the secure desktop (a UAC prompt, the lock screen) has the input, this process cannot inject; the watcher
//! ([`ScreenInput::desktop_watch`], [`InputDesktop::secure_up`]) tells the session, which switches input to the secure-desktop
//! helper of `computer_screen` and back.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::PointerButton;
use mixdog_core_api::domain::computer::ScreenInput as InputOp;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::computer_env;

/// The helper's mode for the remote screen's input.
pub const SCREEN_INPUT_MODE: &str = "--screen-input";
/// The longest literal text one command carries, in UTF-16 units (`MAX_REMOTE_SCREEN_TEXT`).
pub const MAX_REMOTE_SCREEN_TEXT: usize = 256;
/// The acknowledgment deadline per command: Computer Use's per-command ceiling (`SCREEN_COMMAND_TIMEOUT_MS`).
pub const SCREEN_COMMAND_TIMEOUT: Duration = Duration::from_millis(45_000);
/// How long the process has to say `ready`.
pub const START_TIMEOUT: Duration = Duration::from_millis(30_000);
/// How long a `q` has to end the process before it is retired; the stop waits at most twice this.
pub const STOP_TIMEOUT: Duration = Duration::from_millis(4_000);
/// The bound of one `--abort-cleanup` run, and the budget a quit has to lift what the process held.
pub const ABORT_CLEANUP_TIMEOUT: Duration = Duration::from_millis(5_000);
/// The longest line the process may write.
const MAX_LINE_BYTES: usize = 64 * 1024;

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------------------------------------------
// Errors

/// A failed input: the process's code (`out_of_bounds`, `protocol_error`, ...) or this side's (`host_unavailable`,
/// `host_unresponsive`, `host_exited`, `host_killed`, `start_failed`, `start_timeout`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenInputError {
    pub code: String,
}

impl ScreenInputError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

impl std::fmt::Display for ScreenInputError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "remote screen input {}", self.code)
    }
}

impl std::error::Error for ScreenInputError {}

impl From<ScreenInputError> for ComputerError {
    fn from(error: ScreenInputError) -> Self {
        ComputerError::Failed { message: error.to_string(), code: error.code }
    }
}

type Reply = Result<Vec<String>, ScreenInputError>;

// ---------------------------------------------------------------------------------------------------------------
// Geometry and the viewer's input

/// The locked geometry of the shared display, as the screen source holds it.
pub trait ScreenGeometry: Send + Sync {
    /// The live geometry generation: input made for another one is refused.
    fn generation(&self) -> u64;
    /// A video-pixel point (fractions allowed) -> the physical desktop pixel under it; `None` outside the frame.
    fn to_physical(&self, point: (f64, f64)) -> Option<(i32, i32)>;
}

/// A key by Windows virtual-key code and set-1 scan code; `extended` is the E0 prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub vk: u32,
    pub scan: u32,
    pub extended: bool,
}

/// What a viewer sends (`RemoteScreenInput`). Pointer and wheel points are video pixels of the locked geometry; wheel deltas
/// follow `WheelEvent`'s sign in Windows wheel units (120 = one notch).
#[derive(Clone, Debug, PartialEq)]
pub enum RemoteInput {
    Move { x: f64, y: f64 },
    Button { button: PointerButton, down: bool, x: f64, y: f64 },
    Wheel { x: f64, y: f64, dx: i32, dy: i32 },
    Key { key: Key, down: bool },
    /// An atomic combo: the keys pressed in order, then released in reverse, as one step.
    Keys(Vec<Key>),
    Text(String),
    /// Releases every key and button this viewer holds.
    Release,
}

fn key_op(key: Key, down: bool) -> InputOp {
    InputOp::Key { vk: key.vk, scan: key.scan, extended: key.extended, down }
}

/// The commands one input produces, or `None` when it cannot be applied now: a pointer or wheel of another geometry
/// generation, a point outside the frame, or a zero wheel (the phone retries after the next geometry acknowledgment). A
/// button up is always deliverable, or a press made before a geometry change could never be lifted: unmapped, it releases in
/// place. `Keys` yields its key downs in order (`ScreenInput::apply_remote` presses and releases them as one step); `Release`
/// yields none.
pub fn screen_input_ops(input: &RemoteInput, geometry: &dyn ScreenGeometry, generation: u64) -> Option<Vec<InputOp>> {
    let point = |x: f64, y: f64| {
        if geometry.generation() != generation {
            return None;
        }
        geometry.to_physical((x, y))
    };
    match input {
        RemoteInput::Move { x, y } => point(*x, *y).map(|(x, y)| vec![InputOp::Move { x, y }]),
        RemoteInput::Button { button, down, x, y } => match point(*x, *y) {
            Some(at) => Some(vec![InputOp::Button { button: *button, down: *down, at: Some(at) }]),
            None if !down => Some(vec![InputOp::Button { button: *button, down: false, at: None }]),
            None => None,
        },
        RemoteInput::Wheel { x, y, dx, dy } => {
            if *dx == 0 && *dy == 0 {
                return None;
            }
            point(*x, *y).map(|(x, y)| vec![InputOp::Wheel { x, y, dx: *dx, dy: *dy }])
        }
        RemoteInput::Key { key, down } => Some(vec![key_op(*key, *down)]),
        RemoteInput::Keys(keys) => Some(keys.iter().map(|key| key_op(*key, true)).collect()),
        RemoteInput::Text(text) => Some(vec![InputOp::Text(text.clone())]),
        RemoteInput::Release => Some(Vec::new()),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The wire

enum Command<'a> {
    Input(&'a InputOp),
    Cursor,
}

fn button_code(button: PointerButton) -> char {
    match button {
        PointerButton::Left => 'l',
        PointerButton::Right => 'r',
        PointerButton::Middle => 'm',
    }
}

/// One command's line, without its newline. Literal text over [`MAX_REMOTE_SCREEN_TEXT`] UTF-16 units is refused here as the
/// process refuses it.
fn format_command(id: u64, command: &Command<'_>) -> Result<String, ScreenInputError> {
    Ok(match command {
        Command::Cursor => format!("c {id}"),
        Command::Input(InputOp::Move { x, y }) => format!("m {id} {x} {y}"),
        Command::Input(InputOp::Button { button, down, at }) => {
            let head = format!("b {id} {} {}", button_code(*button), u8::from(*down));
            match at {
                Some((x, y)) => format!("{head} {x} {y}"),
                None => head,
            }
        }
        Command::Input(InputOp::Wheel { x, y, dx, dy }) => format!("w {id} {x} {y} {dx} {dy}"),
        Command::Input(InputOp::Key { vk, scan, extended, down }) => {
            format!("k {id} {vk} {scan} {} {}", u8::from(*extended), u8::from(*down))
        }
        Command::Input(InputOp::Text(text)) => {
            if text.encode_utf16().count() > MAX_REMOTE_SCREEN_TEXT {
                return Err(ScreenInputError::new("protocol_error"));
            }
            format!("t {id} {}", base64::engine::general_purpose::STANDARD.encode(text.as_bytes()))
        }
    })
}

/// The input desktop as the watcher sees it. `name` is `None` when the input desktop cannot be opened (the secure desktop).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputDesktop {
    pub name: Option<String>,
    pub consent: bool,
    pub logon_ui: bool,
}

impl InputDesktop {
    /// The input is on the secure desktop (an elevation prompt or the sign-in screen), which this process cannot reach.
    pub fn secure_up(&self) -> bool {
        self.name.is_none() || self.consent || self.logon_ui
    }
}

/// `desktop`'s body: `<name|-> <0|1> <0|1>`.
fn parse_desktop(rest: &str) -> Option<InputDesktop> {
    let mut fields = rest.split(' ');
    let (name, consent, logon) = (fields.next()?, fields.next()?, fields.next()?);
    if fields.next().is_some() || name.is_empty() {
        return None;
    }
    let flag = |text: &str| match text {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    };
    Some(InputDesktop {
        name: (name != "-").then(|| name.to_owned()),
        consent: flag(consent)?,
        logon_ui: flag(logon)?,
    })
}

/// Splits the process's output into lines; a line past [`MAX_LINE_BYTES`] is an error.
#[derive(Default)]
struct Lines {
    partial: Vec<u8>,
}

impl Lines {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, ()> {
        let mut lines = Vec::new();
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            self.partial.extend_from_slice(&rest[..at]);
            rest = &rest[at + 1..];
            if self.partial.last() == Some(&b'\r') {
                self.partial.pop();
            }
            if self.partial.len() > MAX_LINE_BYTES {
                return Err(());
            }
            lines.push(String::from_utf8_lossy(&std::mem::take(&mut self.partial)).into_owned());
        }
        self.partial.extend_from_slice(rest);
        if self.partial.len() > MAX_LINE_BYTES {
            return Err(());
        }
        Ok(lines)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The process

/// How the process is run: the helper binary, the input marker tagging what it injects (distinct from Computer Use's, so its
/// takeover guard reads phone input as a person's; the same marker runs the `--abort-cleanup`), and the folder it starts in.
#[derive(Clone, Debug)]
pub struct ScreenInputConfig {
    pub binary: PathBuf,
    pub cwd: AbsPath,
    pub marker: u32,
}

impl ScreenInputConfig {
    /// With a fresh marker.
    pub fn new(binary: PathBuf, cwd: AbsPath) -> Self {
        Self { binary, cwd, marker: computer_env::new_marker() }
    }
}

struct Run {
    id: u64,
    handle: ProcessHandle,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    ready: bool,
    /// The process said `released`: it let go of what it held on `q` or end of stdin.
    released: bool,
    /// Killed by this side: the cleanup after it is already arranged.
    retired: bool,
    /// Becomes true when the process's output has ended.
    gone: watch::Receiver<bool>,
}

#[derive(Default)]
struct State {
    run: Option<Run>,
    runs: u64,
    next_id: u64,
    stopping: bool,
    /// Presses sent and not yet lifted, in the order they were made: `(hold key, the command that lifts it)`.
    held: Vec<(String, InputOp)>,
    session: Option<u32>,
}

struct Inner {
    manager: Arc<dyn ProcessManager>,
    config: ScreenInputConfig,
    state: Mutex<State>,
    /// One start at a time.
    starting: AsyncMutex<()>,
    /// One writer at a time, so ids and lines reach the process in order.
    writer: AsyncMutex<()>,
    /// The queue input, releases and cursor reads take their turn in.
    turn: AsyncMutex<()>,
    desktop: watch::Sender<Option<InputDesktop>>,
    /// Counts the exits this side did not ask for (a crash, or a kill for a missed acknowledgment).
    exits: watch::Sender<u32>,
    /// The `--abort-cleanup` runs under way.
    cleanups: watch::Sender<usize>,
}

fn hold_of(op: &InputOp) -> Option<(String, bool, InputOp)> {
    match op {
        InputOp::Button { button, down, .. } => Some((
            format!("btn:{}", button_code(*button)),
            *down,
            InputOp::Button { button: *button, down: false, at: None },
        )),
        InputOp::Key { vk, scan, extended, down } => Some((
            format!("key:{vk}:{scan}:{}", u8::from(*extended)),
            *down,
            InputOp::Key { vk: *vk, scan: *scan, extended: *extended, down: false },
        )),
        _ => None,
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn request(&self, args: Vec<String>, stdin_piped: bool, env: (&str, String), time_limit: Option<Duration>) -> SpawnRequest {
        SpawnRequest {
            handle: ProcessHandle(format!("screen-input-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::SeqCst))),
            command: CommandSpec::Argv { program: self.config.binary.to_string_lossy().into_owned(), args },
            cwd: self.config.cwd.clone(),
            env: EnvSpec { inherit: true, set: vec![(env.0.to_owned(), env.1)], remove: Vec::new() },
            pty: None,
            stdin_piped,
            output: OutputMode::Separate,
            owner: ProcessOwner::ComputerHelper,
            time_limit,
        }
    }

    /// Resolves once no `--abort-cleanup` run is under way.
    async fn wait_cleanups(&self) {
        let mut cleanups = self.cleanups.subscribe();
        let _ = cleanups.wait_for(|count| *count == 0).await;
    }

    /// `mixdog-computer --abort-cleanup` under this input marker: lifts the keys and buttons a process that ended without
    /// releasing left down (the ownership receipt outlives it). Bounded; never fails.
    async fn abort_cleanup(&self) {
        let request = self.request(
            vec!["--abort-cleanup".to_owned()],
            false,
            ("MIXDOG_COMPUTER_INPUT_MARKER", self.config.marker.to_string()),
            Some(ABORT_CLEANUP_TIMEOUT),
        );
        let handle = request.handle.clone();
        let run = async {
            let Ok((_, mut events)) = self.manager.spawn_subscribed(request).await else { return };
            while let Some(event) = events.next().await {
                if matches!(event, ProcessEvent::Exited { .. }) {
                    return;
                }
            }
        };
        if mixdog_rt::time::timeout(ABORT_CLEANUP_TIMEOUT, run).await.is_err() {
            let _ = self.manager.kill(&handle);
        }
    }

    /// Runs the abort cleanup as a task, once the process is gone (or after [`STOP_TIMEOUT`]).
    fn spawn_cleanup(self: &Arc<Self>, gone: Option<watch::Receiver<bool>>) {
        self.cleanups.send_modify(|count| *count += 1);
        let inner = self.clone();
        tokio::spawn(async move {
            if let Some(mut gone) = gone {
                let _ = mixdog_rt::time::timeout(STOP_TIMEOUT, async { gone.wait_for(|gone| *gone).await.is_ok() }).await;
            }
            inner.abort_cleanup().await;
            inner.cleanups.send_modify(|count| *count -= 1);
        });
    }

    /// Kills the process, and once it is gone runs the abort cleanup for what it held. One cleanup per process: a second
    /// retire (the stop deadline after a missed acknowledgment) kills again and shares the first one's.
    fn retire(self: &Arc<Self>, run_id: u64) {
        let (handle, gone) = {
            let mut state = self.state();
            let Some(run) = state.run.as_mut().filter(|run| run.id == run_id) else { return };
            let first = !run.retired;
            run.retired = true;
            (run.handle.clone(), first.then(|| run.gone.clone()))
        };
        let _ = self.manager.kill(&handle);
        if gone.is_some() {
            self.spawn_cleanup(gone);
        }
    }

    fn fail_pending(&self, code: &str) {
        let waiting: Vec<_> = {
            let mut state = self.state();
            match state.run.as_mut() {
                Some(run) => run.pending.drain().map(|(_, waiter)| waiter).collect(),
                None => Vec::new(),
            }
        };
        for waiter in waiting {
            let _ = waiter.send(Err(ScreenInputError::new(code)));
        }
    }

    fn on_line(&self, run_id: u64, line: &str, ready: &mut Option<oneshot::Sender<Result<(), ScreenInputError>>>) {
        if line == "released" {
            if let Some(run) = self.state().run.as_mut().filter(|run| run.id == run_id) {
                run.released = true;
            }
            return;
        }
        if let Some(rest) = line.strip_prefix("ready") {
            let session = match rest.strip_prefix(' ') {
                None if rest.is_empty() => Some(None),
                Some(digits) if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) => digits.parse::<u32>().ok().map(Some),
                _ => None,
            };
            if let Some(session) = session {
                {
                    let mut state = self.state();
                    state.session = session;
                    if let Some(run) = state.run.as_mut().filter(|run| run.id == run_id) {
                        run.ready = true;
                    }
                }
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Ok(()));
                }
            }
            return;
        }
        if let Some(rest) = line.strip_prefix("desktop ") {
            if let Some(desktop) = parse_desktop(rest) {
                self.desktop.send_replace(Some(desktop));
            }
            return;
        }
        let (ok, body) = if let Some(body) = line.strip_prefix("ok ") {
            (true, body)
        } else if let Some(body) = line.strip_prefix("err ") {
            (false, body)
        } else {
            return;
        };
        let (id, fields) = match body.split_once(' ') {
            Some((id, fields)) => (id, Some(fields)),
            None => (body, None),
        };
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return;
        }
        let Ok(id) = id.parse::<u64>() else { return };
        let waiter = {
            let mut state = self.state();
            state.run.as_mut().filter(|run| run.id == run_id).and_then(|run| run.pending.remove(&id))
        };
        let Some(waiter) = waiter else { return };
        let fields = fields.filter(|fields| !fields.is_empty());
        let _ = waiter.send(if ok {
            Ok(fields.map(|fields| fields.split(' ').map(str::to_owned).collect()).unwrap_or_default())
        } else {
            Err(ScreenInputError::new(fields.unwrap_or("input_failed")))
        });
    }

    /// The process's output ended: everything waiting on it fails, what it held is no longer held, and an end without a
    /// `released` (and not by this side's retire) is followed by the abort cleanup.
    fn on_exit(self: &Arc<Self>, run_id: u64, ready: &mut Option<oneshot::Sender<Result<(), ScreenInputError>>>, gone: &watch::Sender<bool>) {
        let finished = {
            let mut state = self.state();
            if state.run.as_ref().is_some_and(|run| run.id == run_id) {
                state.session = None;
                state.held.clear();
                state.run.take().map(|run| (run, state.stopping))
            } else {
                None
            }
        };
        let _ = gone.send(true);
        if let Some(ready) = ready.take() {
            let _ = ready.send(Err(ScreenInputError::new("start_failed")));
        }
        let Some((run, stopping)) = finished else { return };
        self.desktop.send_replace(None);
        for (_, waiter) in run.pending {
            let _ = waiter.send(Err(ScreenInputError::new("host_exited")));
        }
        if !run.ready {
            return;
        }
        if !run.released && !run.retired {
            self.spawn_cleanup(None);
        }
        if !stopping {
            self.exits.send_modify(|count| *count += 1);
        }
    }

    /// Reads the process's output until it ends.
    async fn pump(
        self: Arc<Self>,
        run_id: u64,
        mut events: Box<dyn EventSource<ProcessEvent>>,
        mut ready: Option<oneshot::Sender<Result<(), ScreenInputError>>>,
        gone: watch::Sender<bool>,
    ) {
        let mut lines = Lines::default();
        let mut reading = true;
        while let Some(event) = events.next().await {
            match event {
                ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } if reading => match lines.push(&bytes) {
                    Ok(complete) => {
                        for line in complete {
                            self.on_line(run_id, &line, &mut ready);
                        }
                    }
                    Err(()) => {
                        // A line past the bound: the output is not trusted any more.
                        reading = false;
                        self.retire(run_id);
                    }
                },
                ProcessEvent::Output { .. } => {}
                ProcessEvent::Exited { .. } => break,
            }
        }
        self.on_exit(run_id, &mut ready, &gone);
    }

    /// One command, acknowledged: the `ok` fields. Not acknowledged within [`SCREEN_COMMAND_TIMEOUT`] retires the process.
    async fn command(self: &Arc<Self>, command: &Command<'_>) -> Reply {
        let (run_id, handle, id) = {
            let mut state = self.state();
            let stopping = state.stopping;
            let id = state.next_id + 1;
            match state.run.as_ref() {
                Some(run) if !stopping && !run.retired => {
                    let (run_id, handle) = (run.id, run.handle.clone());
                    state.next_id = id;
                    (run_id, handle, id)
                }
                _ => return Err(ScreenInputError::new("host_unavailable")),
            }
        };
        let line = format_command(id, command)?;
        let answer = {
            let _writing = self.writer.lock().await;
            let (reply, answer) = oneshot::channel();
            {
                let mut state = self.state();
                match state.run.as_mut().filter(|run| run.id == run_id) {
                    Some(run) => {
                        run.pending.insert(id, reply);
                    }
                    None => return Err(ScreenInputError::new("host_unavailable")),
                }
            }
            if self.manager.write_stdin_whole(&handle, format!("{line}\n").into_bytes()).await.is_err() {
                if let Some(run) = self.state().run.as_mut() {
                    run.pending.remove(&id);
                }
                return Err(ScreenInputError::new("host_unavailable"));
            }
            answer
        };
        match mixdog_rt::time::timeout(SCREEN_COMMAND_TIMEOUT, answer).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(ScreenInputError::new("host_exited")),
            Err(_) => {
                if let Some(run) = self.state().run.as_mut() {
                    run.pending.remove(&id);
                }
                self.retire(run_id);
                Err(ScreenInputError::new("host_unresponsive"))
            }
        }
    }

    /// One input through the process; a press is held before it is sent (a down whose delivery is uncertain is still
    /// released), a lift forgets its press once acknowledged.
    async fn send_input(self: &Arc<Self>, op: &InputOp) -> Result<(), ScreenInputError> {
        let hold = hold_of(op);
        if let Some((key, true, release)) = &hold {
            let mut state = self.state();
            match state.held.iter_mut().find(|(held, _)| held == key) {
                Some(entry) => entry.1 = release.clone(),
                None => state.held.push((key.clone(), release.clone())),
            }
        }
        self.command(&Command::Input(op)).await?;
        if let Some((key, false, _)) = hold {
            self.state().held.retain(|(held, _)| *held != key);
        }
        Ok(())
    }

    fn holds(&self, key: &str) -> bool {
        self.state().held.iter().any(|(held, _)| held == key)
    }
}

/// The phone's screen input: one `mixdog-computer --screen-input` process, its ordered commands, its release and its
/// desktop watcher.
pub struct ScreenInput {
    inner: Arc<Inner>,
}

impl ScreenInput {
    pub fn new(manager: Arc<dyn ProcessManager>, config: ScreenInputConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                manager,
                config,
                state: Mutex::new(State::default()),
                starting: AsyncMutex::new(()),
                writer: AsyncMutex::new(()),
                turn: AsyncMutex::new(()),
                desktop: watch::channel(None).0,
                exits: watch::channel(0).0,
                cleanups: watch::channel(0).0,
            }),
        }
    }

    /// Starts the process and resolves once it serves (`ready`); a start while it runs resolves at once. The cleanups of an
    /// earlier process finish first, so they cannot lift what this one holds.
    pub async fn start(&self) -> Result<(), ScreenInputError> {
        let inner = &self.inner;
        let _starting = inner.starting.lock().await;
        if inner.state().run.as_ref().is_some_and(|run| !run.retired) {
            return Ok(());
        }
        inner.state().stopping = false;
        inner.wait_cleanups().await;
        if inner.state().stopping {
            return Err(ScreenInputError::new("start_failed"));
        }
        let request = inner.request(
            vec![SCREEN_INPUT_MODE.to_owned()],
            true,
            ("MIXDOG_SCREEN_INPUT_MARKER", inner.config.marker.to_string()),
            None,
        );
        let handle = request.handle.clone();
        let Ok((_, events)) = inner.manager.spawn_subscribed(request).await else {
            return Err(ScreenInputError::new("start_failed"));
        };
        let (gone_sender, gone) = watch::channel(false);
        let (ready_sender, ready) = oneshot::channel();
        let run_id = {
            let mut state = inner.state();
            state.runs += 1;
            let id = state.runs;
            state.run = Some(Run { id, handle, pending: HashMap::new(), ready: false, released: false, retired: false, gone });
            id
        };
        tokio::spawn(inner.clone().pump(run_id, events, Some(ready_sender), gone_sender));
        match mixdog_rt::time::timeout(START_TIMEOUT, ready).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(ScreenInputError::new("start_failed")),
            Err(_) => {
                inner.retire(run_id);
                Err(ScreenInputError::new("start_timeout"))
            }
        }
    }

    /// The process serves and is not being stopped.
    pub fn alive(&self) -> bool {
        let state = self.inner.state();
        !state.stopping && state.run.as_ref().is_some_and(|run| !run.retired)
    }

    /// The Windows session the process runs in (reported at `ready`).
    pub fn session(&self) -> Option<u32> {
        self.inner.state().session
    }

    /// Where a command lands now: the process's session and the input desktop's name, lower-cased. `None` while either is
    /// unknown or the input desktop is unreadable (the secure desktop is up).
    pub fn identity(&self) -> Option<DesktopIdentity> {
        let session = self.session()?;
        let name = self.inner.desktop.borrow().as_ref()?.name.clone().filter(|name| !name.is_empty())?;
        Some(DesktopIdentity { session, desktop: name.to_lowercase() })
    }

    /// The input-desktop watcher: the desktop and whether an elevation prompt or the sign-in screen is up, on every change;
    /// `None` while no process runs.
    pub fn desktop_watch(&self) -> watch::Receiver<Option<InputDesktop>> {
        self.inner.desktop.subscribe()
    }

    /// Counts the exits this side did not ask for (a crash, or a kill for a missed acknowledgment).
    pub fn exit_watch(&self) -> watch::Receiver<u32> {
        self.inner.exits.subscribe()
    }

    /// One command in its turn: a move, button, wheel, key or literal text in desktop pixels. Resolves once the process
    /// acknowledged it.
    pub async fn apply(&self, op: &InputOp) -> Result<(), ScreenInputError> {
        let _turn = self.inner.turn.lock().await;
        self.inner.send_input(op).await
    }

    /// A plan in order, as one turn. `live` is re-read before each command: once it fails nothing more is sent and the
    /// outcome is `Rejected` (a stop, revoke or geometry change that landed while the plan waited).
    pub async fn apply_all(&self, ops: &[InputOp], live: &(dyn Fn() -> bool + Sync)) -> Result<InputOutcome, ScreenInputError> {
        let _turn = self.inner.turn.lock().await;
        for op in ops {
            if !live() {
                return Ok(InputOutcome::Rejected);
            }
            self.inner.send_input(op).await?;
        }
        Ok(InputOutcome::Applied)
    }

    /// A viewer's input mapped through `geometry` (see [`screen_input_ops`]) and applied: `Rejected` when it cannot be applied
    /// now (stale geometry generation, a point outside the frame, a zero wheel, `live` false). `Release` lifts everything held.
    /// A `Keys` combo presses each key in order and releases them in reverse as one turn; a key this side already holds stays
    /// held (neither pressed nor released), and `live` is read before each press, never before a release.
    pub async fn apply_remote(
        &self,
        input: &RemoteInput,
        geometry: &dyn ScreenGeometry,
        generation: u64,
        live: &(dyn Fn() -> bool + Sync),
    ) -> Result<InputOutcome, ScreenInputError> {
        let Some(ops) = screen_input_ops(input, geometry, generation) else { return Ok(InputOutcome::Rejected) };
        let pointed = matches!(input, RemoteInput::Move { .. } | RemoteInput::Button { down: true, .. } | RemoteInput::Wheel { .. });
        let live_now = || live() && (!pointed || geometry.generation() == generation);
        match input {
            RemoteInput::Release => self.release_all().await.map(|_| InputOutcome::Applied),
            RemoteInput::Keys(_) => self.press_combo(&ops, &live_now).await,
            _ => self.apply_all(&ops, &live_now).await,
        }
    }

    async fn press_combo(&self, downs: &[InputOp], live: &(dyn Fn() -> bool + Sync)) -> Result<InputOutcome, ScreenInputError> {
        let _turn = self.inner.turn.lock().await;
        let inner = &self.inner;
        let mut pressed: Vec<(String, InputOp)> = Vec::new();
        let mut outcome = Ok(InputOutcome::Applied);
        for down in downs {
            let Some((key, true, release)) = hold_of(down) else { continue };
            if !live() {
                outcome = Ok(InputOutcome::Rejected);
                break;
            }
            if inner.holds(&key) {
                continue;
            }
            pressed.push((key, release));
            if let Err(error) = inner.send_input(down).await {
                outcome = Err(error);
                break;
            }
        }
        // Released in reverse, whatever happened to the presses; one that a release point already lifted is skipped.
        for (key, release) in pressed.iter().rev() {
            if inner.holds(key) {
                if let Err(error) = inner.send_input(release).await {
                    outcome = Err(error);
                }
            }
        }
        outcome
    }

    /// The cursor position in desktop pixels, read in its turn behind the input before it.
    pub async fn cursor(&self) -> Result<(i32, i32), ScreenInputError> {
        let _turn = self.inner.turn.lock().await;
        let fields = self.inner.command(&Command::Cursor).await?;
        match fields.as_slice() {
            [x, y] => Ok((
                x.parse().map_err(|_| ScreenInputError::new("protocol_error"))?,
                y.parse().map_err(|_| ScreenInputError::new("protocol_error"))?,
            )),
            _ => Err(ScreenInputError::new("protocol_error")),
        }
    }

    /// Lifts every key and button this side holds, in the order they were pressed, and returns how many there were. A lift
    /// the process cannot take is reported once all were tried; what a dead process held is lifted by its `released` or the
    /// abort cleanup, not here. Nothing held sends nothing.
    pub async fn release_all(&self) -> Result<u32, ScreenInputError> {
        let _turn = self.inner.turn.lock().await;
        let held: Vec<(String, InputOp)> = self.inner.state().held.clone();
        let mut failure = None;
        for (_, release) in &held {
            if let Err(error) = self.inner.send_input(release).await {
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(held.len() as u32),
        }
    }

    /// Releases what the process holds, then ends it: `q`, end of stdin, and when it does not end within [`STOP_TIMEOUT`] it
    /// is retired (killed, then the abort cleanup). Resolves once the process and every cleanup are done, at most about
    /// two stop timeouts plus a cleanup.
    pub async fn stop(&self) {
        let inner = &self.inner;
        let running = {
            let mut state = inner.state();
            state.stopping = true;
            state.run.as_ref().map(|run| (run.handle.clone(), run.gone.clone()))
        };
        let Some((handle, mut gone)) = running else {
            inner.wait_cleanups().await;
            return;
        };
        // Already closed: end of stdin releases the same way.
        let _ = inner.manager.write_stdin(&handle, b"q\n".to_vec()).await;
        let _ = inner.manager.close_stdin(&handle);
        let ended = mixdog_rt::time::timeout(STOP_TIMEOUT, async { gone.wait_for(|gone| *gone).await.is_ok() }).await.is_ok();
        let mut forced = false;
        if !ended {
            forced = true;
            let run_id = inner.state().run.as_ref().map(|run| run.id);
            if let Some(run_id) = run_id {
                inner.retire(run_id);
            }
            // A process that never reports its exit does not hold the stop: its cleanup runs once its own wait ends.
            let _ = mixdog_rt::time::timeout(STOP_TIMEOUT, async { gone.wait_for(|gone| *gone).await.is_ok() }).await;
        }
        if forced || *inner.cleanups.borrow() > 0 {
            inner.wait_cleanups().await;
        }
    }

    /// Ends the process at once, without its release-on-quit: Windows does not lift input a killed process injected, so the
    /// abort cleanup follows with its marker. Every command waiting fails with `host_killed`; resolves once every cleanup
    /// is done (bounded, never fails).
    pub async fn kill(&self) {
        let inner = &self.inner;
        let run_id = inner.state().run.as_ref().map(|run| run.id);
        if let Some(run_id) = run_id {
            inner.fail_pending("host_killed");
            inner.retire(run_id);
        }
        inner.wait_cleanups().await;
    }
}

// ---------------------------------------------------------------------------------------------------------------


#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mixdog_core_api::domain::process::ExitStatus;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessExit;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnedProcess;
    use tokio::sync::mpsc;

    use super::*;

    // -----------------------------------------------------------------------------------------------------------
    // A fake `mixdog-computer --screen-input`

    struct Events(mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Events {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    #[derive(Clone, Copy)]
    struct Behaviour {
        /// Says `desktop default 0 0` and `ready 3` at spawn.
        auto_ready: bool,
        /// Acknowledges every command line.
        answer: bool,
        /// Answers every command with `err <id> <code>`.
        error: Option<&'static str>,
        /// Says `released` and exits when its stdin closes.
        release_on_eof: bool,
        /// The `--abort-cleanup` run exits at once.
        cleanup_exits: bool,
        /// Exits before it says `ready`.
        exit_on_spawn: bool,
    }

    impl Behaviour {
        fn serving() -> Self {
            Self { auto_ready: true, answer: true, error: None, release_on_eof: true, cleanup_exits: true, exit_on_spawn: false }
        }
    }

    struct FakeRun {
        request: SpawnRequest,
        tx: mpsc::UnboundedSender<ProcessEvent>,
        rx: Option<mpsc::UnboundedReceiver<ProcessEvent>>,
        written: Vec<String>,
        stdin_closed: bool,
        killed: bool,
        exited: bool,
        seq: u64,
    }

    impl FakeRun {
        fn say(&mut self, text: &str) {
            let seq = self.seq;
            self.seq += 1;
            let _ = self.tx.send(ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: text.as_bytes().to_vec() });
        }

        fn exit(&mut self, status: ExitStatus) {
            let seq = self.seq;
            self.seq += 1;
            self.exited = true;
            let _ = self.tx.send(ProcessEvent::Exited { seq, exit: ProcessExit { status, killed: None } });
        }
    }

    struct Fake {
        runs: Mutex<Vec<FakeRun>>,
        behaviour: Behaviour,
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl Fake {
        fn say(&self, at: usize, text: &str) {
            lock(&self.runs)[at].say(text);
        }
        fn exit(&self, at: usize, status: ExitStatus) {
            lock(&self.runs)[at].exit(status);
        }
        fn spawned(&self) -> usize {
            lock(&self.runs).len()
        }
        fn written(&self, at: usize) -> Vec<String> {
            lock(&self.runs)[at].written.clone()
        }
        fn killed(&self, at: usize) -> bool {
            lock(&self.runs)[at].killed
        }
        fn closed(&self, at: usize) -> bool {
            lock(&self.runs)[at].stdin_closed
        }
        fn args(&self, at: usize) -> Vec<String> {
            match &lock(&self.runs)[at].request.command {
                CommandSpec::Argv { args, .. } => args.clone(),
                CommandSpec::Shell { .. } => Vec::new(),
            }
        }
        fn env(&self, at: usize, name: &str) -> Option<String> {
            lock(&self.runs)[at].request.env.set.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
        }
    }

    #[async_trait]
    impl ProcessManager for Fake {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            let (tx, rx) = mpsc::unbounded_channel();
            let handle = request.handle.clone();
            let args = match &request.command {
                CommandSpec::Argv { args, .. } => args.clone(),
                CommandSpec::Shell { .. } => Vec::new(),
            };
            let mut run =
                FakeRun { request, tx, rx: Some(rx), written: Vec::new(), stdin_closed: false, killed: false, exited: false, seq: 0 };
            if args == [SCREEN_INPUT_MODE] {
                if self.behaviour.exit_on_spawn {
                    run.exit(ExitStatus::Code(1));
                } else if self.behaviour.auto_ready {
                    run.say("desktop default 0 0\nready 3\n");
                }
            } else if args == ["--abort-cleanup"] && self.behaviour.cleanup_exits {
                run.exit(ExitStatus::Code(0));
            }
            lock(&self.runs).push(run);
            Ok(SpawnedProcess { handle, pid: 1 })
        }

        fn subscribe(
            &self,
            handle: &ProcessHandle,
            _from_seq: Option<u64>,
        ) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let mut runs = lock(&self.runs);
            let run = runs.iter_mut().find(|run| run.request.handle == *handle).ok_or(ProcessError::UnknownHandle)?;
            let rx = run.rx.take().ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(Events(rx)))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let mut runs = lock(&self.runs);
            let run = runs.iter_mut().find(|run| run.request.handle == *handle).ok_or(ProcessError::UnknownHandle)?;
            if run.exited || run.stdin_closed {
                return Err(ProcessError::StdinClosed);
            }
            for line in String::from_utf8_lossy(&bytes).lines() {
                run.written.push(line.to_owned());
                if line == "q" {
                    continue;
                }
                let id = line.split(' ').nth(1).unwrap_or("0").to_owned();
                if let Some(code) = self.behaviour.error {
                    run.say(&format!("err {id} {code}\n"));
                } else if self.behaviour.answer {
                    run.say(&if line.starts_with("c ") { format!("ok {id} 10 20\n") } else { format!("ok {id}\n") });
                }
            }
            Ok(())
        }

        fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            let mut runs = lock(&self.runs);
            let run = runs.iter_mut().find(|run| run.request.handle == *handle).ok_or(ProcessError::UnknownHandle)?;
            run.stdin_closed = true;
            if self.behaviour.release_on_eof {
                run.say("released\n");
                run.exit(ExitStatus::Code(0));
            }
            Ok(())
        }

        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }

        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            let mut runs = lock(&self.runs);
            let run = runs.iter_mut().find(|run| run.request.handle == *handle).ok_or(ProcessError::UnknownHandle)?;
            if run.exited {
                return Err(ProcessError::AlreadyExited);
            }
            run.killed = true;
            run.exit(ExitStatus::Signal(9));
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    fn setup(behaviour: Behaviour) -> (Arc<Fake>, ScreenInput) {
        let fake = Arc::new(Fake { runs: Mutex::new(Vec::new()), behaviour });
        let config = ScreenInputConfig {
            binary: PathBuf::from("mixdog-computer"),
            cwd: AbsPath::new(std::env::temp_dir()).expect("an absolute temp dir"),
            marker: 77,
        };
        let input = ScreenInput::new(fake.clone(), config);
        (fake, input)
    }

    async fn started(behaviour: Behaviour) -> (Arc<Fake>, ScreenInput) {
        let (fake, input) = setup(behaviour);
        input.start().await.expect("the fake serves");
        (fake, input)
    }

    /// A geometry that doubles every video pixel; a point past the frame is outside.
    struct Grid {
        generation: u64,
        width: f64,
        height: f64,
    }

    impl ScreenGeometry for Grid {
        fn generation(&self) -> u64 {
            self.generation
        }
        fn to_physical(&self, (x, y): (f64, f64)) -> Option<(i32, i32)> {
            (x >= 0.0 && y >= 0.0 && x <= self.width && y <= self.height).then(|| ((x * 2.0) as i32, (y * 2.0) as i32))
        }
    }

    fn grid() -> Grid {
        Grid { generation: 4, width: 100.0, height: 50.0 }
    }

    const ALWAYS: &(dyn Fn() -> bool + Sync) = &|| true;

    const CTRL: Key = Key { vk: 0xa2, scan: 0x1d, extended: false };
    const LETTER_C: Key = Key { vk: 0x43, scan: 0x2e, extended: false };

    fn key_down(vk: u32, scan: u32) -> InputOp {
        InputOp::Key { vk, scan, extended: false, down: true }
    }

    // -----------------------------------------------------------------------------------------------------------
    // The wire

    #[test]
    fn every_command_is_written_as_the_process_reads_it() {
        let line = |op: InputOp| format_command(7, &Command::Input(&op)).expect("formats");
        assert_eq!(line(InputOp::Move { x: -7, y: 42 }), "m 7 -7 42");
        assert_eq!(line(InputOp::Button { button: PointerButton::Left, down: true, at: None }), "b 7 l 1");
        assert_eq!(line(InputOp::Button { button: PointerButton::Right, down: false, at: Some((1, 2)) }), "b 7 r 0 1 2");
        assert_eq!(line(InputOp::Button { button: PointerButton::Middle, down: true, at: Some((0, 0)) }), "b 7 m 1 0 0");
        assert_eq!(line(InputOp::Wheel { x: 0, y: 0, dx: 0, dy: -120 }), "w 7 0 0 0 -120");
        assert_eq!(line(InputOp::Key { vk: 65, scan: 30, extended: true, down: false }), "k 7 65 30 1 0");
        assert_eq!(line(InputOp::Key { vk: 65, scan: 30, extended: false, down: true }), "k 7 65 30 0 1");
        assert_eq!(line(InputOp::Text("a b\n\u{e9}llo".into())), "t 7 YSBiCsOpbGxv");
        assert_eq!(format_command(7, &Command::Cursor).expect("formats"), "c 7");
    }

    #[test]
    fn literal_text_is_bounded_in_utf16_units() {
        let text = |text: String| format_command(1, &Command::Input(&InputOp::Text(text)));
        assert!(text("x".repeat(MAX_REMOTE_SCREEN_TEXT)).is_ok());
        assert_eq!(text("x".repeat(MAX_REMOTE_SCREEN_TEXT + 1)), Err(ScreenInputError::new("protocol_error")));
        // An astral character is two UTF-16 units.
        assert!(text("\u{1F600}".repeat(MAX_REMOTE_SCREEN_TEXT / 2)).is_ok());
        assert!(text("\u{1F600}".repeat(MAX_REMOTE_SCREEN_TEXT / 2 + 1)).is_err());
    }

    #[test]
    fn the_desktop_line_reads_a_name_and_two_flags() {
        assert_eq!(parse_desktop("Default 0 0"), Some(InputDesktop { name: Some("Default".into()), consent: false, logon_ui: false }));
        assert_eq!(parse_desktop("Winlogon 1 1"), Some(InputDesktop { name: Some("Winlogon".into()), consent: true, logon_ui: true }));
        assert_eq!(parse_desktop("- 0 0"), Some(InputDesktop { name: None, consent: false, logon_ui: false }));
        for bad in ["", "Default", "Default 0", "Default 2 0", "Default 0 x", "Default 0 0 0", " 0 0"] {
            assert_eq!(parse_desktop(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_secure_desktop_is_up_when_unreadable_or_prompting() {
        let desktop = |name: Option<&str>, consent, logon_ui| InputDesktop { name: name.map(str::to_owned), consent, logon_ui };
        assert!(!desktop(Some("default"), false, false).secure_up());
        assert!(desktop(None, false, false).secure_up());
        assert!(desktop(Some("default"), true, false).secure_up());
        assert!(desktop(Some("Winlogon"), false, true).secure_up());
    }

    #[test]
    fn output_is_split_into_lines_across_chunks_and_a_long_line_is_refused() {
        let mut lines = Lines::default();
        assert_eq!(lines.push(b"ready 3\r\nok 1").expect("lines"), vec!["ready 3".to_owned()]);
        assert_eq!(lines.push(b" 5 6\n\n").expect("lines"), vec!["ok 1 5 6".to_owned(), String::new()]);
        assert!(lines.push(&vec![b'x'; MAX_LINE_BYTES + 1]).is_err());
    }

    // -----------------------------------------------------------------------------------------------------------
    // The viewer's input through the geometry

    #[test]
    fn pointer_input_is_mapped_through_the_locked_geometry() {
        let grid = grid();
        let ops = |input: RemoteInput, generation: u64| screen_input_ops(&input, &grid, generation);
        assert_eq!(ops(RemoteInput::Move { x: 10.0, y: 20.0 }, 4), Some(vec![InputOp::Move { x: 20, y: 40 }]));
        assert_eq!(
            ops(RemoteInput::Button { button: PointerButton::Left, down: true, x: 1.0, y: 2.0 }, 4),
            Some(vec![InputOp::Button { button: PointerButton::Left, down: true, at: Some((2, 4)) }])
        );
        assert_eq!(
            ops(RemoteInput::Wheel { x: 100.0, y: 50.0, dx: 0, dy: 120 }, 4),
            Some(vec![InputOp::Wheel { x: 200, y: 100, dx: 0, dy: 120 }])
        );
    }

    #[test]
    fn input_of_another_geometry_generation_or_off_the_frame_is_refused() {
        let grid = grid();
        let ops = |input: RemoteInput, generation: u64| screen_input_ops(&input, &grid, generation);
        assert_eq!(ops(RemoteInput::Move { x: 10.0, y: 20.0 }, 3), None);
        assert_eq!(ops(RemoteInput::Move { x: 100.5, y: 20.0 }, 4), None);
        assert_eq!(ops(RemoteInput::Move { x: -1.0, y: 0.0 }, 4), None);
        assert_eq!(ops(RemoteInput::Button { button: PointerButton::Left, down: true, x: 1.0, y: 2.0 }, 3), None);
        assert_eq!(ops(RemoteInput::Wheel { x: 1.0, y: 2.0, dx: 0, dy: 0 }, 4), None);
        assert_eq!(ops(RemoteInput::Wheel { x: 1.0, y: 2.0, dx: 0, dy: 120 }, 3), None);
    }

    #[test]
    fn a_button_up_is_always_deliverable() {
        let grid = grid();
        let up = RemoteInput::Button { button: PointerButton::Right, down: false, x: 500.0, y: 500.0 };
        assert_eq!(
            screen_input_ops(&up, &grid, 3),
            Some(vec![InputOp::Button { button: PointerButton::Right, down: false, at: None }])
        );
    }

    #[test]
    fn keys_text_and_release_do_not_depend_on_the_geometry() {
        let grid = grid();
        assert_eq!(screen_input_ops(&RemoteInput::Key { key: CTRL, down: true }, &grid, 0), Some(vec![key_down(0xa2, 0x1d)]));
        assert_eq!(
            screen_input_ops(&RemoteInput::Keys(vec![CTRL, LETTER_C]), &grid, 0),
            Some(vec![key_down(0xa2, 0x1d), key_down(0x43, 0x2e)])
        );
        assert_eq!(screen_input_ops(&RemoteInput::Text("hi".into()), &grid, 0), Some(vec![InputOp::Text("hi".into())]));
        assert_eq!(screen_input_ops(&RemoteInput::Release, &grid, 0), Some(Vec::new()));
    }

    // -----------------------------------------------------------------------------------------------------------
    // The process

    #[tokio::test(start_paused = true)]
    async fn a_start_waits_for_ready_and_reports_the_session_and_the_desktop() {
        let (fake, input) = setup(Behaviour::serving());
        assert!(!input.alive());
        input.start().await.expect("serves");
        assert!(input.alive());
        assert_eq!(input.session(), Some(3));
        assert_eq!(input.identity(), Some(DesktopIdentity { session: 3, desktop: "default".into() }));
        assert_eq!(fake.args(0), vec![SCREEN_INPUT_MODE.to_owned()]);
        assert_eq!(fake.env(0, "MIXDOG_SCREEN_INPUT_MARKER").as_deref(), Some("77"));
        // A start while it runs spawns nothing.
        input.start().await.expect("already serving");
        assert_eq!(fake.spawned(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_process_that_never_says_ready_is_retired_after_the_start_budget() {
        let (fake, input) = setup(Behaviour { auto_ready: false, ..Behaviour::serving() });
        assert_eq!(input.start().await, Err(ScreenInputError::new("start_timeout")));
        assert!(fake.killed(0));
        input.inner.wait_cleanups().await;
        assert_eq!(fake.args(1), vec!["--abort-cleanup".to_owned()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_process_that_exits_before_ready_fails_the_start() {
        let (fake, input) = setup(Behaviour { exit_on_spawn: true, ..Behaviour::serving() });
        assert_eq!(input.start().await, Err(ScreenInputError::new("start_failed")));
        assert!(!input.alive());
        // It never served, so nothing it held needs a cleanup.
        assert_eq!(fake.spawned(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn commands_reach_the_process_in_order_with_their_ids() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply(&InputOp::Move { x: 10, y: 20 }).await.expect("acknowledged");
        input.apply(&InputOp::Button { button: PointerButton::Left, down: true, at: Some((10, 20)) }).await.expect("acknowledged");
        input.apply(&InputOp::Text("a b\n\u{e9}llo".into())).await.expect("acknowledged");
        assert_eq!(fake.written(0), ["m 1 10 20", "b 2 l 1 10 20", "t 3 YSBiCsOpbGxv"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_of_input_is_never_interleaved_with_another() {
        let (fake, input) = started(Behaviour::serving()).await;
        let first = [InputOp::Move { x: 1, y: 1 }, InputOp::Move { x: 2, y: 2 }];
        let second = [InputOp::Move { x: 3, y: 3 }, InputOp::Move { x: 4, y: 4 }];
        let (a, b) = tokio::join!(input.apply_all(&first, ALWAYS), input.apply_all(&second, ALWAYS));
        assert_eq!((a, b), (Ok(InputOutcome::Applied), Ok(InputOutcome::Applied)));
        assert_eq!(fake.written(0), ["m 1 1 1", "m 2 2 2", "m 3 3 3", "m 4 4 4"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_stops_when_it_may_no_longer_run() {
        let (fake, input) = started(Behaviour::serving()).await;
        let calls = AtomicU64::new(0);
        let live = || calls.fetch_add(1, Ordering::SeqCst) < 1;
        let ops = [InputOp::Move { x: 1, y: 1 }, InputOp::Move { x: 2, y: 2 }];
        assert_eq!(input.apply_all(&ops, &live).await, Ok(InputOutcome::Rejected));
        assert_eq!(fake.written(0), ["m 1 1 1"]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_error_reply_carries_the_process_code() {
        let (_fake, input) = started(Behaviour { error: Some("out_of_bounds"), ..Behaviour::serving() }).await;
        assert_eq!(input.apply(&InputOp::Move { x: 1, y: 1 }).await, Err(ScreenInputError::new("out_of_bounds")));
        // The process is still serving: a refusal is not a failure of the process.
        assert!(input.alive());
    }

    #[tokio::test(start_paused = true)]
    async fn the_cursor_is_read_behind_the_input_before_it() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply(&InputOp::Move { x: 1, y: 1 }).await.expect("acknowledged");
        assert_eq!(input.cursor().await, Ok((10, 20)));
        assert_eq!(fake.written(0), ["m 1 1 1", "c 2"]);
    }

    #[tokio::test(start_paused = true)]
    async fn text_over_the_bound_is_refused_before_it_is_sent() {
        let (fake, input) = started(Behaviour::serving()).await;
        let result = input.apply(&InputOp::Text("x".repeat(MAX_REMOTE_SCREEN_TEXT + 1))).await;
        assert_eq!(result, Err(ScreenInputError::new("protocol_error")));
        assert!(fake.written(0).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_sent_before_the_process_serves() {
        let (_fake, input) = setup(Behaviour::serving());
        assert_eq!(input.apply(&InputOp::Move { x: 1, y: 1 }).await, Err(ScreenInputError::new("host_unavailable")));
    }

    #[tokio::test(start_paused = true)]
    async fn remote_input_of_a_stale_generation_is_rejected_unsent() {
        let (fake, input) = started(Behaviour::serving()).await;
        let grid = grid();
        let stale = input.apply_remote(&RemoteInput::Move { x: 5.0, y: 5.0 }, &grid, 3, ALWAYS).await;
        assert_eq!(stale, Ok(InputOutcome::Rejected));
        let current = input.apply_remote(&RemoteInput::Move { x: 5.0, y: 5.0 }, &grid, 4, ALWAYS).await;
        assert_eq!(current, Ok(InputOutcome::Applied));
        let denied = input.apply_remote(&RemoteInput::Move { x: 6.0, y: 6.0 }, &grid, 4, &|| false).await;
        assert_eq!(denied, Ok(InputOutcome::Rejected));
        assert_eq!(fake.written(0), ["m 1 10 10"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_press_made_before_a_geometry_change_can_still_be_lifted() {
        let (fake, input) = started(Behaviour::serving()).await;
        let down = RemoteInput::Button { button: PointerButton::Left, down: true, x: 5.0, y: 5.0 };
        input.apply_remote(&down, &grid(), 4, ALWAYS).await.expect("pressed");
        let after = Grid { generation: 5, ..grid() };
        let up = RemoteInput::Button { button: PointerButton::Left, down: false, x: 5.0, y: 5.0 };
        assert_eq!(input.apply_remote(&up, &after, 4, ALWAYS).await, Ok(InputOutcome::Applied));
        assert_eq!(fake.written(0), ["b 1 l 1 10 10", "b 2 l 0"]);
        assert_eq!(input.release_all().await, Ok(0));
    }

    // -----------------------------------------------------------------------------------------------------------
    // Release

    #[tokio::test(start_paused = true)]
    async fn release_all_lifts_every_held_key_and_button_in_press_order() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply(&InputOp::Button { button: PointerButton::Left, down: true, at: Some((1, 1)) }).await.expect("pressed");
        input.apply(&key_down(65, 30)).await.expect("pressed");
        assert_eq!(input.release_all().await, Ok(2));
        assert_eq!(fake.written(0)[2..], ["b 3 l 0", "k 4 65 30 0 0"]);
        // Idempotent: nothing held sends nothing.
        assert_eq!(input.release_all().await, Ok(0));
        assert_eq!(fake.written(0).len(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn a_lifted_key_is_no_longer_held() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply(&key_down(65, 30)).await.expect("pressed");
        input.apply(&InputOp::Key { vk: 65, scan: 30, extended: false, down: false }).await.expect("lifted");
        assert_eq!(input.release_all().await, Ok(0));
        assert_eq!(fake.written(0).len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_release_request_from_the_viewer_lifts_everything() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply(&key_down(65, 30)).await.expect("pressed");
        let outcome = input.apply_remote(&RemoteInput::Release, &grid(), 0, ALWAYS).await;
        assert_eq!(outcome, Ok(InputOutcome::Applied));
        assert_eq!(fake.written(0)[1], "k 2 65 30 0 0");
    }

    #[tokio::test(start_paused = true)]
    async fn a_key_combo_presses_in_order_and_releases_in_reverse() {
        let (fake, input) = started(Behaviour::serving()).await;
        let combo = RemoteInput::Keys(vec![CTRL, LETTER_C]);
        assert_eq!(input.apply_remote(&combo, &grid(), 0, ALWAYS).await, Ok(InputOutcome::Applied));
        assert_eq!(fake.written(0), ["k 1 162 29 0 1", "k 2 67 46 0 1", "k 3 67 46 0 0", "k 4 162 29 0 0"]);
        assert_eq!(input.release_all().await, Ok(0));
    }

    #[tokio::test(start_paused = true)]
    async fn a_combo_leaves_a_key_the_viewer_already_holds_held() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply_remote(&RemoteInput::Key { key: CTRL, down: true }, &grid(), 0, ALWAYS).await.expect("pressed");
        let combo = RemoteInput::Keys(vec![CTRL, LETTER_C]);
        assert_eq!(input.apply_remote(&combo, &grid(), 0, ALWAYS).await, Ok(InputOutcome::Applied));
        assert_eq!(fake.written(0)[1..], ["k 2 67 46 0 1", "k 3 67 46 0 0"]);
        assert_eq!(input.release_all().await, Ok(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_combo_that_may_not_run_presses_nothing_more_but_still_releases() {
        let (fake, input) = started(Behaviour::serving()).await;
        // Read before each press: the first passes, the second refuses.
        let calls = AtomicU64::new(0);
        let live = || calls.fetch_add(1, Ordering::SeqCst) < 1;
        let combo = RemoteInput::Keys(vec![CTRL, LETTER_C]);
        assert_eq!(input.apply_remote(&combo, &grid(), 0, &live).await, Ok(InputOutcome::Rejected));
        assert_eq!(fake.written(0), ["k 1 162 29 0 1", "k 2 162 29 0 0"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_sends_q_and_closes_stdin_and_runs_no_cleanup_after_a_release() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.stop().await;
        assert_eq!(fake.written(0), ["q"]);
        assert!(fake.closed(0));
        assert!(!input.alive());
        assert_eq!(input.session(), None);
        assert_eq!(*input.desktop_watch().borrow(), None);
        // It said `released`: nothing was left down, so no cleanup ran.
        assert_eq!(fake.spawned(), 1);
        assert_eq!(*input.exit_watch().borrow(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_process_that_ignores_q_is_retired_and_cleaned_up_within_the_stop_budget() {
        let (fake, input) = started(Behaviour { release_on_eof: false, ..Behaviour::serving() }).await;
        input.stop().await;
        assert!(fake.killed(0));
        assert_eq!(fake.spawned(), 2);
        assert_eq!(fake.args(1), vec!["--abort-cleanup".to_owned()]);
        assert_eq!(fake.env(1, "MIXDOG_COMPUTER_INPUT_MARKER").as_deref(), Some("77"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_process_that_dies_without_releasing_is_followed_by_the_abort_cleanup() {
        let (fake, input) = started(Behaviour::serving()).await;
        input.apply(&key_down(65, 30)).await.expect("pressed");
        let mut exits = input.exit_watch();
        fake.exit(0, ExitStatus::Signal(9));
        exits.changed().await.expect("the exit is reported");
        input.inner.wait_cleanups().await;
        assert_eq!(*exits.borrow(), 1);
        assert_eq!(fake.args(1), vec!["--abort-cleanup".to_owned()]);
        assert_eq!(fake.env(1, "MIXDOG_COMPUTER_INPUT_MARKER").as_deref(), Some("77"));
        // What it held died with it: the cleanup lifts it, this side holds nothing.
        assert!(!input.alive());
        assert_eq!(input.release_all().await, Ok(0));
    }

    #[tokio::test(start_paused = true)]
    async fn a_command_waiting_when_the_process_dies_fails() {
        let (fake, input) = started(Behaviour { answer: false, ..Behaviour::serving() }).await;
        let died = async {
            tokio::task::yield_now().await;
            fake.exit(0, ExitStatus::Signal(9));
        };
        let (result, ()) = tokio::join!(input.apply(&InputOp::Move { x: 1, y: 1 }), died);
        assert_eq!(result, Err(ScreenInputError::new("host_exited")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_command_not_acknowledged_in_time_retires_the_process() {
        let (fake, input) = started(Behaviour { answer: false, ..Behaviour::serving() }).await;
        let result = input.apply(&InputOp::Move { x: 1, y: 1 }).await;
        assert_eq!(result, Err(ScreenInputError::new("host_unresponsive")));
        assert!(fake.killed(0));
        assert!(!input.alive());
        assert_eq!(input.apply(&InputOp::Move { x: 2, y: 2 }).await, Err(ScreenInputError::new("host_unavailable")));
        input.inner.wait_cleanups().await;
        assert_eq!(fake.args(1), vec!["--abort-cleanup".to_owned()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_kill_fails_what_waits_and_runs_the_cleanup_before_it_returns() {
        let (fake, input) = started(Behaviour { answer: false, ..Behaviour::serving() }).await;
        let killing = async {
            tokio::task::yield_now().await;
            input.kill().await;
        };
        let (result, ()) = tokio::join!(input.apply(&InputOp::Move { x: 1, y: 1 }), killing);
        assert_eq!(result, Err(ScreenInputError::new("host_killed")));
        assert!(fake.killed(0));
        assert_eq!(fake.spawned(), 2);
        assert_eq!(*input.inner.cleanups.borrow(), 0);
    }

    // -----------------------------------------------------------------------------------------------------------
    // The desktop watcher

    #[tokio::test(start_paused = true)]
    async fn the_watcher_reports_the_secure_desktop_and_its_return() {
        let (fake, input) = started(Behaviour::serving()).await;
        let mut watch = input.desktop_watch();
        assert_eq!(watch.borrow().as_ref().map(InputDesktop::secure_up), Some(false));
        fake.say(0, "desktop - 1 0\n");
        watch.changed().await.expect("a change");
        assert_eq!(watch.borrow().as_ref().map(InputDesktop::secure_up), Some(true));
        assert_eq!(input.identity(), None);
        fake.say(0, "desktop Winlogon 0 1\n");
        watch.changed().await.expect("a change");
        assert_eq!(watch.borrow().as_ref().map(InputDesktop::secure_up), Some(true));
        fake.say(0, "desktop Default 0 0\n");
        watch.changed().await.expect("a change");
        assert_eq!(watch.borrow().as_ref().map(InputDesktop::secure_up), Some(false));
        assert_eq!(input.identity(), Some(DesktopIdentity { session: 3, desktop: "default".into() }));
    }

    #[tokio::test(start_paused = true)]
    async fn lines_that_are_not_understood_are_ignored() {
        let (fake, input) = started(Behaviour::serving()).await;
        fake.say(0, "desktop nonsense\nok x\nerr\nready x\nok 99 1\nnoise\n");
        let mut watch = input.desktop_watch();
        fake.say(0, "desktop Other 0 0\n");
        watch.changed().await.expect("the next valid line is read");
        assert_eq!(watch.borrow().as_ref().and_then(|desktop| desktop.name.clone()).as_deref(), Some("Other"));
        assert_eq!(input.session(), Some(3));
    }

    #[test]
    fn a_failed_input_becomes_a_computer_error_with_its_code() {
        let error: ComputerError = ScreenInputError::new("out_of_bounds").into();
        assert_eq!(
            error,
            ComputerError::Failed { code: "out_of_bounds".into(), message: "remote screen input out_of_bounds".into() }
        );
    }
}
