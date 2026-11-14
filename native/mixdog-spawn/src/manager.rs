//! The one process manager (DS §6). Every child gets its own job object or process group, one
//! reader thread per output pipe (one for a PTY), one waiter thread, and, when it takes input,
//! one writer thread. All per-process state is private to the process: the shared table is
//! locked only to admit, look up and list, so one process's output, input or exit never waits on
//! another's.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::ProcessQueue;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::LaneToken;
use mixdog_rt::SpawnIo;
use tokio_util::sync::CancellationToken;

use crate::contain::Containment;
use crate::feed::Feed;
use crate::launch::Launch;
use crate::launch::environment;
use crate::pty;
use crate::pty::Pty;
use crate::pty::Root;

/// `limits.maxProcesses`, the replay ring and the other bounds of one manager.
#[derive(Clone, Debug)]
pub struct ProcessConfig {
    /// Live processes the manager admits (SPEC §3.1: 64).
    pub max_processes: u32,
    /// Replay ring of a process feed, and the most a subscriber may trail its reader.
    pub ring_bytes: usize,
    /// Exited processes kept for replay and `list`.
    pub retained_exits: usize,
    /// Input accepted but not yet written to a process.
    pub input_queue_bytes: usize,
    /// The shell a `CommandSpec::Shell` without a shell name runs under.
    pub default_shell: String,
    /// How long the exit waits for the output pipes after the root has ended. A descendant that
    /// inherited a pipe can hold it open long after the root is gone; once this has passed the
    /// exit is published with the output that arrived, and later output is dropped.
    pub output_drain: Duration,
}

impl Default for ProcessConfig {
    fn default() -> Self {
        Self {
            max_processes: 64,
            ring_bytes: 4 * 1024 * 1024,
            retained_exits: 256,
            input_queue_bytes: 1024 * 1024,
            output_drain: Duration::from_millis(2_000),
            default_shell: if cfg!(windows) {
                "powershell.exe".to_owned()
            } else {
                "/bin/sh".to_owned()
            },
        }
    }
}

/// Rewrites a PTY's output on its reader thread before it reaches the feed (the terminal tab
/// layer strips shell-integration markers and decodes text here).
pub trait OutputFilter: Send {
    fn filter(&mut self, bytes: &[u8]) -> Vec<u8>;
    /// Output still held back when the stream ends.
    fn finish(&mut self) -> Vec<u8>;
    /// The chunk the last `filter` or `finish` returned is entering the feed (its flow gate let it in): called under the feed's lock,
    /// never for a chunk the feed drops. True when something now waits for the pump to take exactly this chunk (a terminal tab's
    /// activity change): the feed keeps the chunk an event of its own (see [`crate::feed::Feed::admit`]).
    fn admitted(&mut self) -> bool {
        false
    }
}

/// Runs on the process's waiter thread once the root has ended and its output pipes are finished
/// or [`ProcessConfig::output_drain`] has passed (a [`NodePtyExit`] process: when node-pty raised its exit), before the exit event is
/// published. The bytes it returns are the feed's last output (the terminal
/// tab's "[process exited …]" line).
pub type ExitHook = Box<dyn FnOnce(&ProcessExit) -> Vec<u8> + Send>;

/// What a spawn needs beyond the domain request.
#[derive(Default)]
pub struct SpawnOptions {
    /// Replaces [`ProcessConfig::ring_bytes`] for this process.
    pub ring_bytes: Option<usize>,
    pub filter: Option<Box<dyn OutputFilter>>,
    pub on_exit: Option<ExitHook>,
    /// A terminal tab's exit, raised when node-pty raised it (see [`NodePtyExit`]) instead of after [`ProcessConfig::output_drain`].
    /// Only a Windows pseudo-console process uses it.
    pub node_pty_exit: Option<NodePtyExit>,
    /// The process is the framed scripted shell (`crate::scripted::in_place_of`): its output reaches the feed one whole scripted frame per output ([`frame_loop`]).
    #[cfg(feature = "scripted-shell")]
    pub scripted_frames: bool,
}

/// When node-pty (the copy Node's desktop loaded) raised a Windows terminal's `exit`, which Node's terminal manager answered with the
/// held text, `activity.exit()` and the exit line (terminal-manager.ts:378-384). node-pty raises `exit` only when its output socket
/// closes (windowsTerminal.js `_socket.on('close')`), and that socket closes:
/// - [`NODE_PTY_FLUSH`] after the shell's own end, the wait starting again with each chunk that arrives after the end
///   (windowsPtyAgent.js `_$onProcessExit`, `_flushDataAndCleanUp`, `FLUSH_DATA_INTERVAL`), with no upper bound; the pseudo console
///   stays open meanwhile (node-pty closes it only in `kill`, conpty.cc `PtyKill`), so a process the shell left behind can still write;
/// - [`NODE_PTY_EOF`] after the console's output ends, which on a kill (`ClosePseudoConsole`) comes once its last client has gone: the
///   output's end reaches node-pty through its conout worker's pipe, which libuv shuts down after its 50 ms end-of-file wait
///   (`eof_timeout`, src/win/pipe.c);
/// - after a kill, [`NODE_PTY_FLUSH`] after the kill at most (windowsConoutConnection.js `dispose`, `_drainDataAndClose`).
///
/// Node's recorded times (apps/mobile/fixtures/phone-terminal/exit-timing.json): 1001-1008 ms after the shell's end with output 0, 999
/// and 1000 ms before it; 999.7-1001 ms after the last output that came after the end; 48.9-50.6 ms after a killed shell's end. The
/// wait runs on `runtime`'s clock (a test's paused clock moves only when the test advances it).
pub struct NodePtyExit {
    pub runtime: tokio::runtime::Handle,
}

/// node-pty's `FLUSH_DATA_INTERVAL` (windowsPtyAgent.js, windowsConoutConnection.js).
pub const NODE_PTY_FLUSH: Duration = Duration::from_millis(1000);
/// libuv's `eof_timeout` on a Windows pipe (src/win/pipe.c), between the console's output end and node-pty's socket end.
pub const NODE_PTY_EOF: Duration = Duration::from_millis(50);

/// What a [`NodePtyExit`] wait has seen. Tests only.
#[cfg(feature = "core-test")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExitWait {
    /// The wait has begun (the root has ended).
    pub waiting: bool,
    /// Output bytes in the feed when the quiet wait last started again.
    pub quiet_from: u64,
    /// The output has ended.
    pub output_ended: bool,
}

struct Life {
    /// The root process has not exited. Descendants may outlive it, so this does not gate a kill.
    running: bool,
    killed: Option<KillReason>,
    /// The exit's kill reason is decided and fixed. A kill is accepted only before this, under
    /// the same lock, so an accepted kill is always in the published exit.
    finalized: bool,
}

/// Input accepted from callers and written to the process by its writer thread.
struct InputQueue {
    state: Mutex<InputState>,
    ready: Condvar,
    /// Raised whenever queued bytes leave the queue (written, or dropped at shutdown), for
    /// callers waiting for room.
    room: tokio::sync::Notify,
    cap: usize,
    /// Held by a write for all of its pieces (see `write_input_wait`); fair, so waiting writers go in arrival order.
    writer: Arc<tokio::sync::Mutex<()>>,
    /// Raised when the writer thread has written a chunk to the process, or stopped writing, for
    /// [`LocalProcessManager::write_input_whole`].
    written: tokio::sync::Notify,
}

/// `bytes` in pieces of at most `cap` bytes, each ending at a UTF-8 character boundary (a piece is cut inside a character only when
/// the character alone is longer than `cap`).
fn pieces(bytes: &[u8], cap: usize) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while rest.len() > cap {
        let mut end = cap;
        while end > 0 && (rest[end] & 0xC0) == 0x80 {
            end -= 1;
        }
        if end == 0 {
            end = cap;
        }
        let (piece, tail) = rest.split_at(end);
        out.push(piece);
        rest = tail;
    }
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

struct InputState {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closing: bool,
    dead: bool,
    /// No more writes are taken (a disposed terminal); the input stays open.
    refused: bool,
    /// Bytes ever queued, and ever written to the process: a write is in the process's input once
    /// `written` reaches the `queued` it left.
    queued: u64,
    written: u64,
    /// The writer thread's write failed (its OS error code, when it had one): nothing more is written.
    failed: Option<Option<i32>>,
}

impl InputQueue {
    fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(InputState {
                chunks: VecDeque::new(),
                bytes: 0,
                closing: false,
                dead: false,
                refused: false,
                queued: 0,
                written: 0,
                failed: None,
            }),
            ready: Condvar::new(),
            room: tokio::sync::Notify::new(),
            cap,
            writer: Arc::new(tokio::sync::Mutex::new(())),
            written: tokio::sync::Notify::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, InputState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn push(&self, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let mut state = self.lock();
        if state.closing || state.dead || state.refused || state.failed.is_some() {
            return Err(ProcessError::StdinClosed);
        }
        if state.bytes + bytes.len() > self.cap {
            return Err(ProcessError::Overloaded {
                queue: ProcessQueue::Input,
            });
        }
        state.bytes += bytes.len();
        state.queued += bytes.len() as u64;
        state.chunks.push_back(bytes);
        drop(state);
        self.ready.notify_one();
        Ok(())
    }

    fn close(&self) -> Result<(), ProcessError> {
        let mut state = self.lock();
        if state.closing || state.dead {
            return Err(ProcessError::StdinClosed);
        }
        state.closing = true;
        drop(state);
        self.ready.notify_one();
        // A write waiting for room ends with `StdinClosed` instead of holding the write side.
        self.room.notify_waiters();
        Ok(())
    }

    /// Refuses every later write, and ends a write waiting for room, without closing the process's input: what is queued is still written.
    fn refuse(&self) {
        self.lock().refused = true;
        self.room.notify_waiters();
    }

    /// The process is gone: nothing more is written.
    fn shutdown(&self) {
        let mut state = self.lock();
        state.dead = true;
        state.chunks.clear();
        state.bytes = 0;
        drop(state);
        self.ready.notify_one();
        self.room.notify_waiters();
        self.written.notify_waiters();
    }

    /// Resolves once every byte queued up to `mark` is written to the process; fails when the writer stopped before that
    /// (its write failed, or the process is gone).
    async fn written_to(&self, mark: u64) -> Result<(), ProcessError> {
        loop {
            let mut written = std::pin::pin!(self.written.notified());
            // Registered before the state is read, so a write finished in between is not missed.
            written.as_mut().enable();
            {
                let state = self.lock();
                if state.written >= mark {
                    return Ok(());
                }
                if let Some(os_code) = state.failed {
                    return Err(ProcessError::Io { os_code });
                }
                if state.dead {
                    return Err(ProcessError::StdinClosed);
                }
            }
            written.await;
        }
    }

    /// Writes what is queued until the input is closed or the process is gone. When a write fails and `end_tree` is given
    /// (a piped input), the process's tree is ended first and the input is let go (`sink` dropped, which the reader sees as
    /// the end of its input) only once the process is gone: a reader that took the end of a part of its input for the end
    /// of all of it would run that part.
    fn run(&self, mut sink: Box<dyn Write + Send>, end_tree: Option<Box<dyn FnOnce() + Send>>) {
        loop {
            let chunk = {
                let mut state = self.lock();
                loop {
                    if state.dead {
                        return;
                    }
                    if let Some(chunk) = state.chunks.pop_front() {
                        state.bytes -= chunk.len();
                        self.room.notify_waiters();
                        break chunk;
                    }
                    if state.closing {
                        return;
                    }
                    state = self.ready.wait(state).unwrap_or_else(|e| e.into_inner());
                }
            };
            if let Err(error) = sink.write_all(&chunk).and_then(|()| sink.flush()) {
                let Some(end_tree) = end_tree else {
                    self.lock().failed = Some(error.raw_os_error());
                    self.shutdown();
                    return;
                };
                {
                    let mut state = self.lock();
                    state.failed = Some(error.raw_os_error());
                    state.chunks.clear();
                    state.bytes = 0;
                }
                self.room.notify_waiters();
                self.written.notify_waiters();
                end_tree();
                // The process's exit shuts the queue (`dead`); the input stays open until then.
                let mut state = self.lock();
                while !state.dead {
                    state = self.ready.wait(state).unwrap_or_else(|e| e.into_inner());
                }
                drop(state);
                drop(sink);
                return;
            }
            self.lock().written += chunk.len() as u64;
            self.written.notify_waiters();
        }
    }
}

/// A process whose terminal was closed ([`LocalProcessManager::hang_up`]), held by itself, not by its handle (Node's dispose kills the
/// captured entry's own pty, terminal-manager.ts:543): a tab created again under the same id is a different process this never reaches.
pub struct HungUp(Arc<Proc>);

impl HungUp {
    /// Ends this process's tree; `AlreadyExited` once its exit is final.
    pub fn kill(&self) -> Result<(), ProcessError> {
        self.0.kill(KillReason::Requested)
    }
}

pub(crate) struct Proc {
    handle: ProcessHandle,
    pid: u32,
    /// Changes once at most: a process spawned ahead of its use is claimed by its user ([`ProcessManager::claim`]).
    owner: Mutex<ProcessOwner>,
    pty_size: Mutex<Option<PtySize>>,
    feed: Arc<Feed>,
    containment: Containment,
    pty: Option<Pty>,
    input: Option<Arc<InputQueue>>,
    life: Mutex<Life>,
    exit: OnceLock<ProcessExit>,
    exit_order: AtomicU64,
    /// When [`LocalProcessManager::hang_up`] closed the terminal, on the runtime clock of the caller.
    hung_up: Mutex<Option<tokio::time::Instant>>,
    #[cfg(feature = "core-test")]
    exit_wait: tokio::sync::watch::Sender<ExitWait>,
}

impl Proc {
    pub(crate) fn containment(&self) -> &Containment {
        &self.containment
    }

    /// Whether the root process has ended (its descendants may not have).
    pub(crate) fn root_ended(&self) -> bool {
        !self.life().running
    }

    fn life(&self) -> MutexGuard<'_, Life> {
        self.life.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn owner(&self) -> MutexGuard<'_, ProcessOwner> {
        self.owner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Tree kill, issued inline; the first reason wins. The exit follows as an event. The root's
    /// exit does not end the tree: until the exit is published (all output drained) a
    /// descendant may still hold the output pipes, and the kill still takes the whole job or
    /// process group.
    fn kill(&self, reason: KillReason) -> Result<(), ProcessError> {
        let mut life = self.life();
        if life.finalized {
            return Err(ProcessError::AlreadyExited);
        }
        life.killed.get_or_insert(reason);
        self.containment.kill();
        drop(life);
        #[cfg(feature = "core-test")]
        crate::testing::kill_window();
        // A stalled consumer must not keep a killed process's reader from reaching the end.
        self.feed.release_reader();
        Ok(())
    }

    /// The gentle first stop of an escalating one (`ProcessManager::terminate`): SIGTERM to the group on
    /// Unix, the forced kill where there is no gentle stop. The first reason wins, as for `kill`.
    fn terminate(&self, reason: KillReason) -> Result<(), ProcessError> {
        let mut life = self.life();
        if life.finalized {
            return Err(ProcessError::AlreadyExited);
        }
        life.killed.get_or_insert(reason);
        self.containment.terminate();
        Ok(())
    }

    fn info(&self) -> ProcessInfo {
        ProcessInfo {
            handle: self.handle.clone(),
            pid: self.pid,
            owner: self.owner().clone(),
            pty: *self.pty_size.lock().unwrap_or_else(|e| e.into_inner()),
            exit: self.exit.get().copied(),
        }
    }
}

enum Slot {
    Reserved,
    Live(Arc<Proc>),
}

struct Inner {
    config: ProcessConfig,
    spawn_io: SpawnIo,
    table: Mutex<HashMap<ProcessHandle, Slot>>,
    live: AtomicU32,
    exit_counter: AtomicU64,
    deadlines: OnceLock<Arc<Deadlines>>,
}

impl Inner {
    fn table(&self) -> MutexGuard<'_, HashMap<ProcessHandle, Slot>> {
        self.table.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lookup(&self, handle: &ProcessHandle) -> Result<Arc<Proc>, ProcessError> {
        match self.table().get(handle) {
            Some(Slot::Live(proc)) => Ok(Arc::clone(proc)),
            _ => Err(ProcessError::UnknownHandle),
        }
    }

    /// Reserves the handle and one of the live-process slots.
    fn admit(self: &Arc<Self>, handle: &ProcessHandle) -> Result<Admission, ProcessError> {
        let mut table = self.table();
        match table.get(handle) {
            Some(Slot::Reserved) => return Err(ProcessError::HandleInUse),
            Some(Slot::Live(proc)) if proc.exit.get().is_none() => {
                return Err(ProcessError::HandleInUse);
            }
            _ => {}
        }
        let limit = self.config.max_processes;
        self.live
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < limit).then_some(n + 1)
            })
            .map_err(|_| ProcessError::LimitReached { limit })?;
        self.prune_exited(&mut table);
        table.insert(handle.clone(), Slot::Reserved);
        Ok(Admission {
            inner: Arc::clone(self),
            handle: handle.clone(),
            committed: false,
        })
    }

    /// Drops the oldest exited processes beyond the retention bound.
    fn prune_exited(&self, table: &mut HashMap<ProcessHandle, Slot>) {
        let mut exited: Vec<(u64, ProcessHandle)> = table
            .iter()
            .filter_map(|(handle, slot)| match slot {
                // A process whose descendants still run stays: dropping it would end them. One whose descendants have
                // gone since its exit lets its job go now.
                Slot::Live(proc) if proc.exit.get().is_some() && proc.containment.release_if_empty() => {
                    Some((proc.exit_order.load(Ordering::Acquire), handle.clone()))
                }
                _ => None,
            })
            .collect();
        if exited.len() <= self.config.retained_exits {
            return;
        }
        exited.sort();
        let extra = exited.len() - self.config.retained_exits;
        for (_, handle) in exited.into_iter().take(extra) {
            table.remove(&handle);
        }
    }

    fn deadlines(&self) -> &Arc<Deadlines> {
        self.deadlines.get_or_init(Deadlines::start)
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        let table = self.table.get_mut().unwrap_or_else(|e| e.into_inner());
        for slot in table.values() {
            if let Slot::Live(proc) = slot {
                let _ = proc.kill(KillReason::OwnerClosed);
            }
        }
        if let Some(deadlines) = self.deadlines.get() {
            deadlines.close();
        }
    }
}

/// What a spawn holds while its caller awaits the answer. Dropped before the answer (the caller's
/// future was dropped), it tells the launch job the requester is gone and kills a child that is
/// already committed; the job kills one that commits later. Either way the child that nobody was
/// told about does not run on.
struct Abandon {
    inner: Arc<Inner>,
    handle: ProcessHandle,
    gone: CancellationToken,
    answered: bool,
}

impl Drop for Abandon {
    fn drop(&mut self) {
        self.gone.cancel();
        if !self.answered {
            let _ = self.inner.lookup(&self.handle).and_then(|proc| proc.kill(KillReason::Requested));
        }
    }
}

/// A reserved handle and live-process slot, released unless the spawn commits.
struct Admission {
    inner: Arc<Inner>,
    handle: ProcessHandle,
    committed: bool,
}

impl Admission {
    fn commit(mut self, proc: &Arc<Proc>) {
        self.committed = true;
        self.inner
            .table()
            .insert(self.handle.clone(), Slot::Live(Arc::clone(proc)));
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut table = self.inner.table();
        if matches!(table.get(&self.handle), Some(Slot::Reserved)) {
            table.remove(&self.handle);
        }
        self.inner.live.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Run limits (`SpawnRequest::time_limit`): one thread for every process that has one, started
/// on first use, asleep until the earliest deadline.
struct Deadlines {
    state: Mutex<DeadlineState>,
    wake: Condvar,
}

struct DeadlineState {
    entries: Vec<(Instant, Weak<Proc>)>,
    closed: bool,
}

impl Deadlines {
    fn start() -> Arc<Self> {
        let deadlines = Arc::new(Self {
            state: Mutex::new(DeadlineState {
                entries: Vec::new(),
                closed: false,
            }),
            wake: Condvar::new(),
        });
        let worker = Arc::clone(&deadlines);
        // Without its thread the run limits cannot fire; spawn failure is not recoverable here.
        let _ = thread::Builder::new()
            .name("process-deadlines".to_owned())
            .spawn(move || worker.run());
        deadlines
    }

    fn lock(&self) -> MutexGuard<'_, DeadlineState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn add(&self, at: Instant, proc: &Arc<Proc>) {
        self.lock().entries.push((at, Arc::downgrade(proc)));
        self.wake.notify_one();
    }

    fn close(&self) {
        self.lock().closed = true;
        self.wake.notify_one();
    }

    fn run(&self) {
        let mut state = self.lock();
        loop {
            if state.closed {
                return;
            }
            let now = Instant::now();
            let mut due = Vec::new();
            state.entries.retain(|(at, proc)| {
                let live = proc.upgrade().is_some_and(|p| p.exit.get().is_none());
                if live && *at <= now {
                    due.push(proc.clone());
                }
                live && *at > now
            });
            for proc in due {
                if let Some(proc) = proc.upgrade() {
                    let _ = proc.kill(KillReason::TimeLimit);
                }
            }
            let next = state.entries.iter().map(|(at, _)| *at).min();
            state = match next {
                Some(at) => {
                    self.wake
                        .wait_timeout(state, at.saturating_duration_since(Instant::now()))
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
    }
}

fn spawn_error(program: &str, error: &std::io::Error) -> ProcessError {
    match error.kind() {
        std::io::ErrorKind::NotFound => ProcessError::ProgramNotFound {
            program: program.to_owned(),
        },
        std::io::ErrorKind::PermissionDenied => ProcessError::PermissionDenied,
        _ => ProcessError::Io {
            os_code: error.raw_os_error(),
        },
    }
}

/// How long to wait before starting a Windows PowerShell again after the system refused it (`spawnShellWithRetry`,
/// `shell-spawn-retry.mjs`): a refused start (EPERM) is retried after 100, 300 and 700 ms, then reported. `None` for any other
/// program, platform or error, and once the three retries are spent.
fn denied_spawn_delay(program: &str, error: &std::io::Error, attempt: usize) -> Option<Duration> {
    const DELAYS_MS: [u64; 3] = [100, 300, 700];
    let name = program.to_ascii_lowercase();
    let powershell = name.contains("pwsh") || name.contains("powershell");
    let denied = error.kind() == std::io::ErrorKind::PermissionDenied;
    (cfg!(windows) && powershell && denied).then(|| DELAYS_MS.get(attempt).copied()).flatten().map(Duration::from_millis)
}

fn io_error(error: &std::io::Error) -> ProcessError {
    ProcessError::Io {
        os_code: error.raw_os_error(),
    }
}

struct Started {
    root: Root,
    pty: Option<Pty>,
    readers: Vec<(OutputStream, Box<dyn Read + Send>)>,
    writer: Option<Box<dyn Write + Send>>,
}

#[cfg(windows)]
fn start_piped(
    launch: &Launch,
    request: &SpawnRequest,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    containment: &Containment,
) -> std::io::Result<Started> {
    use std::os::windows::io::AsHandle;
    let stdin = if request.stdin_piped { Some(std::io::pipe()?) } else { None };
    let (out_read, out_write) = std::io::pipe()?;
    let mut readers: Vec<(OutputStream, Box<dyn Read + Send>)> = Vec::new();
    readers.push((OutputStream::Stdout, Box::new(out_read)));
    let err_write = match request.output {
        OutputMode::Merged => None,
        OutputMode::Separate => {
            let (err_read, err_write) = std::io::pipe()?;
            readers.push((OutputStream::Stderr, Box::new(err_read)));
            Some(err_write)
        }
    };
    #[cfg(feature = "core-test")]
    let created = crate::testing::created_window;
    #[cfg(not(feature = "core-test"))]
    let created = || {};
    let process = crate::winspawn::spawn_observed(
        containment.job(),
        &crate::winspawn::Spawn {
            program: launch.program(),
            command_line: &launch.command_line(),
            cwd: Some(request.cwd.as_path()),
            env: Some(env),
            stdio: crate::winspawn::Stdio::Handles {
                stdin: stdin.as_ref().map(|(read, _)| read.as_handle()),
                stdout: Some(out_write.as_handle()),
                stderr: Some(err_write.as_ref().unwrap_or(&out_write).as_handle()),
            },
        },
        created,
    )?;
    // The ends the child owns close here; the readers see the end of the stream when the tree is
    // gone.
    drop(out_write);
    drop(err_write);
    let writer = stdin.map(|(_, write)| Box::new(write) as Box<dyn Write + Send>);
    Ok(Started {
        root: Root::Win(process),
        pty: None,
        readers,
        writer,
    })
}

#[cfg(unix)]
fn start_piped(
    launch: &Launch,
    request: &SpawnRequest,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    containment: &Containment,
) -> std::io::Result<Started> {
    use std::process::Stdio;
    let mut cmd = launch.command(request.cwd.as_path(), env);
    cmd.stdin(if request.stdin_piped {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let (out_read, out_write) = std::io::pipe()?;
    let mut readers: Vec<(OutputStream, Box<dyn Read + Send>)> = Vec::new();
    match request.output {
        OutputMode::Merged => {
            cmd.stdout(out_write.try_clone()?);
            cmd.stderr(out_write);
            readers.push((OutputStream::Stdout, Box::new(out_read)));
        }
        OutputMode::Separate => {
            let (err_read, err_write) = std::io::pipe()?;
            cmd.stdout(out_write);
            cmd.stderr(err_write);
            readers.push((OutputStream::Stdout, Box::new(out_read)));
            readers.push((OutputStream::Stderr, Box::new(err_read)));
        }
    }
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    // The pipe ends `cmd` holds close here; the readers see the end of the stream when the tree
    // is gone.
    drop(cmd);
    containment.adopt(child.id());
    let writer = child
        .stdin
        .take()
        .map(|stdin| Box::new(stdin) as Box<dyn Write + Send>);
    Ok(Started {
        root: Root::Child(child),
        pty: None,
        readers,
        writer,
    })
}

/// The output pipes that have not reached their end yet, and the signal for the last one.
struct Drain {
    open: Mutex<usize>,
    done: Condvar,
    /// The same signal for an async wait.
    ended: tokio::sync::Notify,
}

impl Drain {
    fn new(pipes: usize) -> Arc<Self> {
        Arc::new(Self {
            open: Mutex::new(pipes),
            done: Condvar::new(),
            ended: tokio::sync::Notify::new(),
        })
    }

    fn finished(&self) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        *open -= 1;
        if *open == 0 {
            self.done.notify_all();
            self.ended.notify_waiters();
        }
    }

    fn is_done(&self) -> bool {
        *self.open.lock().unwrap_or_else(|e| e.into_inner()) == 0
    }

    /// Waits until every pipe has ended or `limit` has passed. A reader still blocked then is
    /// left to end on its own; the feed drops what it pushes after the exit.
    fn wait(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        while *open > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            open = self.done.wait_timeout(open, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

/// Counts a reader out of its [`Drain`] when its thread ends, however it ends.
struct Reading(Arc<Drain>);

impl Drop for Reading {
    fn drop(&mut self) {
        self.0.finished();
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    stream: OutputStream,
    feed: Arc<Feed>,
    mut filter: Option<Box<dyn OutputFilter>>,
    _reading: Reading,
) {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => match filter.as_mut() {
                Some(filter) => {
                    let bytes = filter.filter(&buffer[..n]);
                    feed.admit(stream, &bytes, || filter.admitted());
                }
                None => feed.push_output(stream, &buffer[..n]),
            },
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            // A closed pseudo-terminal reports an error where a pipe reports the end.
            Err(_) => break,
        }
    }
    if let Some(filter) = filter.as_mut() {
        let bytes = filter.finish();
        feed.admit(stream, &bytes, || filter.admitted());
    }
}

/// [`read_loop`] for the framed scripted shell: one whole frame per output, of any length (a real PTY's output never comes here). A
/// broken frame is the stand-in's error, written to stderr; the output ends there.
#[cfg(feature = "scripted-shell")]
fn frame_loop(
    mut frames: crate::scripted::Frames,
    stream: OutputStream,
    feed: Arc<Feed>,
    mut filter: Option<Box<dyn OutputFilter>>,
    _reading: Reading,
) {
    loop {
        match frames.next_frame() {
            Ok(Some(frame)) => match filter.as_mut() {
                Some(filter) => {
                    let bytes = filter.filter(&frame);
                    feed.admit(stream, &bytes, || filter.admitted());
                }
                None => feed.push_output(stream, &frame),
            },
            Ok(None) => break,
            Err(error) => {
                eprintln!("mixdog scripted shell: {error}");
                break;
            }
        }
    }
    if let Some(filter) = filter.as_mut() {
        let bytes = filter.finish();
        feed.admit(stream, &bytes, || filter.admitted());
    }
}

/// Waits for the root, then for the output to end (for at most [`ProcessConfig::output_drain`]; a [`NodePtyExit`] process: until
/// node-pty would have raised its exit), and publishes the exit as the last event.
fn wait_and_finish(
    inner: Arc<Inner>,
    proc: Arc<Proc>,
    mut root: Root,
    drain: Arc<Drain>,
    on_exit: Option<ExitHook>,
    node_pty_exit: Option<NodePtyExit>,
) {
    let status = root.wait();
    proc.life().running = false;
    // The root's pid, and the group id it named, are free for reuse from now on: a later signal to the
    // group is sent only after the process table shows the id still names our group.
    proc.containment.root_reaped();
    // The readers' flow gate opens before anything waits on them: a reader parked on a paused
    // or stalled consumer would never reach the end of its stream, and closing a ConPTY waits
    // for its output to be read. What is left in the OS buffers is small and goes into the ring.
    proc.feed.release_reader();
    // Closing a ConPTY can wait for its output to be read, and the close is what ends that
    // output; it runs beside the drain so a close that hangs is bounded by the same limit.
    let close = |proc: &Arc<Proc>| {
        let closing = Arc::clone(proc);
        let _ = thread::Builder::new().name("pty-close".to_owned()).spawn(move || {
            if let Some(pty) = &closing.pty {
                pty.close();
            }
        });
    };
    match node_pty_exit.filter(|_| cfg!(windows) && proc.pty.is_some()) {
        Some(rule) => {
            rule.runtime.block_on(node_pty_end(&proc, &drain));
            // node-pty left the console open; the exit drops what it writes from here (the feed is done after the exit), and the
            // console is closed so it does not outlive the tab.
            close(&proc);
        }
        None => {
            if proc.pty.is_some() {
                close(&proc);
            }
            drain.wait(inner.config.output_drain);
        }
    }
    if let Some(input) = &proc.input {
        input.shutdown();
    }
    // A pseudo console's host is the terminal's, closed above; a piped command's console host signals its own exit before
    // the exit is published, so it is never taken for a survivor.
    if proc.pty.is_none() {
        proc.containment.settle_exit();
    }
    // Read after the drain: a kill during it (descendants still holding the pipes) counts.
    // Fixing the reason and closing the door to kills is one step under the lifecycle lock; a
    // later kill returns `AlreadyExited`.
    let killed = {
        let mut life = proc.life();
        life.finalized = true;
        life.killed
    };
    #[cfg(feature = "core-test")]
    crate::testing::exit_window();
    let status = status.unwrap_or(mixdog_core_api::domain::process::ExitStatus::Code(-1));
    let exit = ProcessExit { status, killed };
    if let Some(hook) = on_exit {
        // An event of its own, made under the feed's lock: what the hook orders after the output before the exit (a tab's end) and
        // before its line keeps that place for the feed's consumer.
        proc.feed.push_last_output(OutputStream::Pty, || hook(&exit));
    }
    proc.exit_order
        .store(inner.exit_counter.fetch_add(1, Ordering::AcqRel), Ordering::Release);
    let _ = proc.exit.set(exit);
    // The slot is free before the exit is announced, so a caller that saw the exit can spawn.
    inner.live.fetch_sub(1, Ordering::AcqRel);
    // The record is kept for replay and `list`, its emptied job is not (Node keeps nothing of a child after its exit).
    proc.containment.release_if_empty();
    proc.feed.push_exit(exit);
}

/// Waits, from the root's end, until node-pty would have raised the terminal's exit (see [`NodePtyExit`]): [`NODE_PTY_FLUSH`] without
/// output, [`NODE_PTY_EOF`] after the output's end, or (once hung up) [`NODE_PTY_FLUSH`] after the hang-up, whichever comes first.
async fn node_pty_end(proc: &Proc, drain: &Drain) {
    let hung_up = *proc.hung_up.lock().unwrap_or_else(|e| e.into_inner());
    let mut quiet_from = tokio::time::Instant::now();
    let mut seen = proc.feed.pushed();
    let mut ended: Option<tokio::time::Instant> = None;
    loop {
        let pushed = proc.feed.changed().notified();
        let finished = drain.ended.notified();
        let mut pushed = std::pin::pin!(pushed);
        let mut finished = std::pin::pin!(finished);
        pushed.as_mut().enable();
        finished.as_mut().enable();
        let now = proc.feed.pushed();
        if now != seen {
            seen = now;
            quiet_from = tokio::time::Instant::now();
        }
        if ended.is_none() && drain.is_done() {
            ended = Some(tokio::time::Instant::now());
        }
        #[cfg(feature = "core-test")]
        proc.exit_wait.send_replace(ExitWait { waiting: true, quiet_from: seen, output_ended: ended.is_some() });
        let due = [Some(quiet_from + NODE_PTY_FLUSH), ended.map(|at| at + NODE_PTY_EOF), hung_up.map(|at| at + NODE_PTY_FLUSH)]
            .into_iter()
            .flatten()
            .min()
            .expect("the quiet wait is always due");
        tokio::select! {
            () = tokio::time::sleep_until(due) => return,
            () = pushed => {}
            () = finished => {}
        }
    }
}

/// Creates the process and its threads; runs on io-spawn.
fn launch_process(
    inner: &Arc<Inner>,
    admission: Admission,
    request: SpawnRequest,
    options: SpawnOptions,
    subscribe: bool,
) -> Result<(SpawnedProcess, Option<crate::feed::Subscription>), ProcessError> {
    let launch = Launch::of(&request.command, &inner.config.default_shell);
    let env = environment(&request.env);
    if !request.cwd.as_path().is_dir() {
        return Err(ProcessError::Io {
            os_code: Some(if cfg!(windows) { 3 } else { 2 }),
        });
    }
    let containment = Containment::create(crate::contain::breakaway_ok(&request.owner)).map_err(|e| io_error(&e))?;
    let mut attempt = 0;
    let started = loop {
        let result = match request.pty {
            Some(size) => {
                pty::spawn(&launch, request.cwd.as_path(), &env, size, &containment).map(|parts| {
                    Started {
                        root: parts.root,
                        pty: Some(parts.pty),
                        readers: vec![(OutputStream::Pty, parts.reader)],
                        writer: Some(parts.writer),
                    }
                })
            }
            None => start_piped(&launch, &request, &env, &containment),
        };
        match result {
            Err(error) => match denied_spawn_delay(launch.program(), &error, attempt) {
                Some(delay) => {
                    attempt += 1;
                    thread::sleep(delay);
                }
                None => return Err(spawn_error(launch.program(), &error)),
            },
            Ok(started) => break started,
        }
    };

    let Started {
        root,
        pty,
        readers,
        writer,
    } = started;
    let pid = root.pid();
    let feed = Feed::new(options.ring_bytes.unwrap_or(inner.config.ring_bytes));
    // Before the reader threads start, so it holds the first byte (see `spawn_subscribed`).
    let first = subscribe.then(|| feed.subscribe_oldest());
    let input = writer.is_some().then(|| InputQueue::new(inner.config.input_queue_bytes));
    let proc = Arc::new(Proc {
        handle: request.handle.clone(),
        pid,
        owner: Mutex::new(request.owner.clone()),
        pty_size: Mutex::new(request.pty),
        feed: Arc::clone(&feed),
        containment,
        pty,
        input: input.clone(),
        life: Mutex::new(Life {
            running: true,
            killed: None,
            finalized: false,
        }),
        exit: OnceLock::new(),
        exit_order: AtomicU64::new(0),
        hung_up: Mutex::new(None),
        #[cfg(feature = "core-test")]
        exit_wait: tokio::sync::watch::Sender::new(ExitWait::default()),
    });

    // One dedicated blocking-read thread per output pipe, not a job on the pooled io-pty lane:
    // up to `max_processes` of these block in `read` at once, and a pool smaller than that would
    // leave a live process's output unread behind other processes' idle reads.
    let mut filter = options.filter;
    let drain = Drain::new(readers.len());
    for (stream, reader) in readers {
        let feed = Arc::clone(&feed);
        let filter = filter.take();
        let reading = Reading(Arc::clone(&drain));
        #[cfg(feature = "scripted-shell")]
        let scripted = options.scripted_frames;
        let started = thread::Builder::new().name("io-pty-read".to_owned()).spawn(move || {
            #[cfg(feature = "scripted-shell")]
            if scripted {
                return frame_loop(crate::scripted::Frames::new(reader), stream, feed, filter, reading);
            }
            read_loop(reader, stream, feed, filter, reading)
        });
        if let Err(error) = started {
            let _ = proc.kill(KillReason::Requested);
            return Err(io_error(&error));
        }
    }
    if let (Some(input), Some(writer)) = (input, writer) {
        // A piped input whose write fails ends the tree before it is let go; a terminal's input stops as before.
        let end_tree: Option<Box<dyn FnOnce() + Send>> = proc.pty.is_none().then(|| {
            let proc = Arc::downgrade(&proc);
            Box::new(move || {
                if let Some(proc) = proc.upgrade() {
                    // A kill of a process whose exit is final is not an error: it is gone already.
                    let _ = proc.kill(KillReason::Requested);
                }
            }) as Box<dyn FnOnce() + Send>
        });
        let started = thread::Builder::new()
            .name("io-pty-write".to_owned())
            .spawn(move || input.run(writer, end_tree));
        if let Err(error) = started {
            let _ = proc.kill(KillReason::Requested);
            return Err(io_error(&error));
        }
    }
    let waiter = {
        let inner = Arc::clone(inner);
        let proc = Arc::clone(&proc);
        thread::Builder::new()
            .name("process-wait".to_owned())
            .spawn(move || wait_and_finish(inner, proc, root, drain, options.on_exit, options.node_pty_exit))
    };
    if let Err(error) = waiter {
        let _ = proc.kill(KillReason::Requested);
        return Err(io_error(&error));
    }
    if let Some(limit) = request.time_limit {
        inner.deadlines().add(Instant::now() + limit, &proc);
    }
    let handle = request.handle;
    admission.commit(&proc);
    Ok((SpawnedProcess { handle, pid }, first))
}

#[derive(Clone)]
pub struct LocalProcessManager {
    inner: Arc<Inner>,
}

impl LocalProcessManager {
    /// The process a handle names, live or retained after its exit.
    pub(crate) fn proc(&self, handle: &ProcessHandle) -> Result<Arc<Proc>, ProcessError> {
        self.inner.lookup(handle)
    }

    /// `spawn_io` is the io-spawn lane token the composition root hands to this module.
    pub fn new(spawn_io: SpawnIo, config: ProcessConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                spawn_io,
                table: Mutex::new(HashMap::new()),
                live: AtomicU32::new(0),
                exit_counter: AtomicU64::new(0),
                deadlines: OnceLock::new(),
            }),
        }
    }

    /// [`ProcessManager::spawn`] with the options only in-process callers (the terminal tabs) use.
    pub async fn spawn_with(
        &self,
        request: SpawnRequest,
        options: SpawnOptions,
    ) -> Result<SpawnedProcess, ProcessError> {
        Ok(self.launch(request, options, false).await?.0)
    }

    /// [`ProcessManager::spawn_subscribed`] with [`Self::spawn_with`]'s options.
    pub async fn spawn_subscribed_with(
        &self,
        request: SpawnRequest,
        options: SpawnOptions,
    ) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
        match self.launch(request, options, true).await? {
            (spawned, Some(first)) => Ok((spawned, Box::new(first))),
            (_, None) => unreachable!("a subscribed launch returns its subscription"),
        }
    }

    async fn launch(
        &self,
        request: SpawnRequest,
        options: SpawnOptions,
        subscribe: bool,
    ) -> Result<(SpawnedProcess, Option<crate::feed::Subscription>), ProcessError> {
        let admission = self.inner.admit(&request.handle)?;
        // Dropping this future abandons the wait: a job still queued is dropped unrun, and a child
        // the job commits meanwhile is killed (see `Abandon`), so a cancelled spawn leaves no child
        // that nobody owns.
        let mut abandon = Abandon {
            inner: Arc::clone(&self.inner),
            handle: request.handle.clone(),
            gone: CancellationToken::new(),
            answered: false,
        };
        let (inner, gone) = (Arc::clone(&self.inner), abandon.gone.clone());
        let job = self
            .inner
            .spawn_io
            .submit(&abandon.gone, move |_lane| {
                #[cfg(feature = "core-test")]
                crate::testing::launch_window();
                let spawned = launch_process(&inner, admission, request, options, subscribe)?;
                // Checked after the commit: a requester that left before it is found here, one that
                // leaves after it finds the child in the table (`Abandon::drop`).
                if gone.is_cancelled() {
                    let _ = inner.lookup(&spawned.0.handle).and_then(|proc| proc.kill(KillReason::Requested));
                }
                #[cfg(feature = "core-test")]
                crate::testing::answer_window();
                Ok(spawned)
            })
            .map_err(|_| ProcessError::Overloaded {
                queue: ProcessQueue::Spawn,
            })?;
        let answer = job.await;
        abandon.answered = true;
        answer.map_err(|_| ProcessError::Io { os_code: None })?
    }

    /// Pauses or resumes the reader of a PTY (terminal flow control): while paused, its output
    /// stays in the OS buffer and the child stalls against it.
    pub fn set_output_paused(
        &self,
        handle: &ProcessHandle,
        paused: bool,
    ) -> Result<(), ProcessError> {
        self.inner.lookup(handle)?.feed.set_paused(paused);
        Ok(())
    }

    /// Kills every live process whose owner `matches`; returns how many were killed. An owner
    /// that closes applies its own rule through this (tool processes die with their run, tabs
    /// persist).
    pub fn kill_where(&self, reason: KillReason, matches: impl Fn(&ProcessOwner) -> bool) -> usize {
        let procs: Vec<Arc<Proc>> = self
            .inner
            .table()
            .values()
            .filter_map(|slot| match slot {
                Slot::Live(proc) if matches(&proc.owner()) => Some(Arc::clone(proc)),
                _ => None,
            })
            .collect();
        procs.iter().filter(|p| p.kill(reason).is_ok()).count()
    }

    /// The non-blocking write behind `write_stdin` and the `process/input` notification: queues
    /// `bytes` for the process's writer thread.
    /// `Overloaded` while another write is in progress ([`Self::write_input_wait`]): the caller then waits behind it.
    pub fn write_input(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        let input = proc.input.as_ref().ok_or(ProcessError::StdinClosed)?;
        let Ok(_writing) = input.writer.try_lock() else {
            return Err(ProcessError::Overloaded { queue: ProcessQueue::Input });
        };
        input.push(bytes)
    }

    /// Queues `bytes` for the process, waiting for room when its input queue is full: the
    /// `process/input` notification is never dropped, and the connection reader that sent it
    /// stays paused for as long as this waits. Fails only when the process cannot take input. Input larger than the queue goes in
    /// pieces of at most its capacity, in order (Node's `pty.write` takes any length), so no input is refused for its size. The pieces are
    /// cut between UTF-8 characters, and the process's write side is held from the first piece to the last (writers take it in arrival
    /// order), so no other input lands between them: Node wrote the whole string in one `pty.write` (terminal-manager.ts:419).
    /// The whole string or nothing: a caller dropped while it waits for the write side writes nothing; once it has the write side the
    /// write is the process's own (a task holding it to the last piece), so a caller dropped after that (its connection closed, the call
    /// cancelled) never cuts it in half. Closing the input (`close_stdin`, as a disposal does) ends a write waiting for room.
    pub async fn write_input_wait(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.queue_input_whole(handle, bytes).await.map(|_| ())
    }

    /// [`Self::write_input_wait`], resolved once the writer thread has written every byte of it to the process: an error
    /// when it could not (the write failed, or the process is gone or its input closed first), so a caller never mistakes
    /// a part of `bytes` for all of it.
    pub async fn write_input_whole(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let (input, mark) = self.queue_input_whole(handle, bytes).await?;
        input.written_to(mark).await
    }

    /// Queues the whole of `bytes` (see [`Self::write_input_wait`]); the queue and the byte count queued up to its last
    /// piece.
    async fn queue_input_whole(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(Arc<InputQueue>, u64), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        let input = Arc::clone(proc.input.as_ref().ok_or(ProcessError::StdinClosed)?);
        let writing = Arc::clone(&input.writer).lock_owned().await;
        let queue = Arc::clone(&input);
        let write = mixdog_rt::spawn("process-input", mixdog_rt::TaskClass::Work, async move {
            let _writing = writing;
            for piece in pieces(&bytes, queue.cap.max(1)) {
                loop {
                    let mut room = std::pin::pin!(queue.room.notified());
                    // Registered before the push is tried, so room made in between is not missed.
                    room.as_mut().enable();
                    match queue.push(piece.to_vec()) {
                        Err(ProcessError::Overloaded { queue: ProcessQueue::Input }) => room.await,
                        Err(other) => return Err(other),
                        Ok(()) => break,
                    }
                }
            }
            // Read while the write side is still held: no other write has queued after this one.
            Ok(queue.lock().queued)
        });
        let mark = write.await.unwrap_or(Err(ProcessError::StdinClosed))?;
        Ok((input, mark))
    }

    /// Resolves with the output bytes pushed once the process's reader is parked at its feed's gate: held back by a consumer that trails by
    /// the ring bound, or by a paused feed. The reader's own signal; there is no deadline here, the caller bounds the wait. Tests only.
    #[cfg(feature = "core-test")]
    pub async fn output_blocked(&self, handle: &ProcessHandle) -> Result<u64, ProcessError> {
        let feed = Arc::clone(&self.inner.lookup(handle)?.feed);
        Ok(feed.blocked_pushed().await)
    }

    /// Output bytes the process's reader has put into its feed so far.
    pub fn output_pushed(&self, handle: &ProcessHandle) -> Result<u64, ProcessError> {
        Ok(self.inner.lookup(handle)?.feed.pushed())
    }

    /// The output offset reached so far, cut there (output after it comes in events of its own), given to `then` under the feed's lock:
    /// no output enters between the cut and what `then` does (see `Feed::mark_then`).
    pub(crate) fn output_mark_then<T>(&self, handle: &ProcessHandle, then: impl FnOnce(u64) -> T) -> Result<T, ProcessError> {
        Ok(self.inner.lookup(handle)?.feed.mark_then(then))
    }

    /// A subscription from the oldest event the ring still holds, with the output offset where its first event starts (more than zero
    /// when the ring has dropped the start of the output), taken in one step (see `Feed::subscribe_oldest`).
    pub(crate) fn subscribe_oldest(&self, handle: &ProcessHandle) -> Result<(Box<dyn EventSource<ProcessEvent>>, u64), ProcessError> {
        let subscription = self.inner.lookup(handle)?.feed.subscribe_oldest();
        let start = subscription.start();
        Ok((Box::new(subscription), start))
    }

    /// What the [`NodePtyExit`] wait of `handle` has seen, as it changes. Tests only.
    #[cfg(feature = "core-test")]
    pub fn exit_wait(&self, handle: &ProcessHandle) -> Result<tokio::sync::watch::Receiver<ExitWait>, ProcessError> {
        Ok(self.inner.lookup(handle)?.exit_wait.subscribe())
    }

    /// The feed of `handle`. Tests only.
    #[cfg(all(test, feature = "core-test"))]
    pub(crate) fn feed_of(&self, handle: &ProcessHandle) -> Result<Arc<crate::feed::Feed>, ProcessError> {
        Ok(Arc::clone(&self.inner.lookup(handle)?.feed))
    }

    /// Input accepted but not yet written to the process.
    pub fn input_backlog(&self, handle: &ProcessHandle) -> Result<usize, ProcessError> {
        let proc = self.inner.lookup(handle)?;
        Ok(proc.input.as_ref().map_or(0, |input| input.lock().bytes))
    }

    pub fn info(&self, handle: &ProcessHandle) -> Result<ProcessInfo, ProcessError> {
        Ok(self.inner.lookup(handle)?.info())
    }

    /// Processes admitted and not yet exited.
    pub fn live(&self) -> u32 {
        self.inner.live.load(Ordering::Acquire)
    }

    pub fn kill_with(&self, handle: &ProcessHandle, reason: KillReason) -> Result<(), ProcessError> {
        self.inner.lookup(handle)?.kill(reason)
    }

    /// Takes no more input for the process and ends a write waiting for room (it fails with `StdinClosed` and lets go of the write side);
    /// what is queued is still written and the input stays open. A disposed terminal takes no more writes (Node's `write` returns on a
    /// disposed entry, terminal-manager.ts:418).
    pub fn refuse_input(&self, handle: &ProcessHandle) {
        if let Some(input) = self.inner.lookup(handle).ok().and_then(|proc| proc.input.clone()) {
            input.refuse();
        }
    }

    /// Closes a PTY process's terminal, as node-pty's `kill` closes the pseudo console: on Windows the console's processes get its close
    /// and end with `STATUS_CONTROL_C_EXIT` themselves (a shell's own answer to a closed terminal). The close runs on a thread of its own
    /// (`ClosePseudoConsole` can wait for its output to be read). A process without a PTY is `NotPty`.
    /// Returns the hung-up process itself: its later kill ends that process's tree, never another process the handle names by then.
    pub fn hang_up(&self, handle: &ProcessHandle) -> Result<HungUp, ProcessError> {
        let proc = self.inner.lookup(handle)?;
        if proc.pty.is_none() {
            return Err(ProcessError::NotPty);
        }
        // node-pty's kill bounds when it raises the exit (see `NodePtyExit`).
        *proc.hung_up.lock().unwrap_or_else(|e| e.into_inner()) = Some(tokio::time::Instant::now());
        let closing = Arc::clone(&proc);
        thread::Builder::new()
            .name("pty-hangup".to_owned())
            .spawn(move || {
                if let Some(pty) = &closing.pty {
                    pty.close();
                }
            })
            .map_err(|error| ProcessError::Io { os_code: error.raw_os_error() })?;
        Ok(HungUp(proc))
    }
}

#[async_trait]
impl ProcessManager for LocalProcessManager {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.spawn_with(request, SpawnOptions::default()).await
    }

    async fn spawn_subscribed(
        &self,
        request: SpawnRequest,
    ) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
        self.spawn_subscribed_with(request, SpawnOptions::default()).await
    }

    fn subscribe(
        &self,
        handle: &ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let proc = self.inner.lookup(handle)?;
        Ok(Box::new(proc.feed.subscribe(from_seq)?))
    }

    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.write_input(handle, bytes)
    }

    async fn write_stdin_whole(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.write_input_whole(handle, bytes).await
    }

    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        if proc.pty.is_some() {
            return Err(ProcessError::NotPty);
        }
        proc.input.as_ref().ok_or(ProcessError::StdinClosed)?.close()
    }

    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        let pty = proc.pty.as_ref().ok_or(ProcessError::NotPty)?;
        if !proc.life().running {
            return Err(ProcessError::AlreadyExited);
        }
        pty.resize(size).map_err(|e| io_error(&e))?;
        *proc.pty_size.lock().unwrap_or_else(|e| e.into_inner()) = Some(size);
        Ok(())
    }

    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.kill_with(handle, KillReason::Requested)
    }

    fn terminate(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.lookup(handle)?.terminate(KillReason::Requested)
    }

    fn list(&self) -> Vec<ProcessInfo> {
        self.inner
            .table()
            .values()
            .filter_map(|slot| match slot {
                Slot::Live(proc) => Some(proc.info()),
                Slot::Reserved => None,
            })
            .collect()
    }

    fn claim(&self, handle: &ProcessHandle, owner: ProcessOwner, time_limit: Option<Duration>) -> Result<(), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        // Under the lifecycle lock: a process whose exit is final is not handed over.
        let life = proc.life();
        if life.finalized || !life.running {
            return Err(ProcessError::AlreadyExited);
        }
        *proc.owner() = owner;
        drop(life);
        if let Some(limit) = time_limit {
            self.inner.deadlines().add(Instant::now() + limit, &proc);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::mpsc;

    use super::InputQueue;
    use super::denied_spawn_delay;
    use super::pieces;

    /// `spawnShellWithRetry`: a refused PowerShell start waits 100, 300 and 700 ms and is then reported; nothing else is retried.
    #[test]
    fn a_refused_powershell_start_is_retried_three_times_on_windows_only() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        let delays: Vec<_> = (0..4).map(|n| denied_spawn_delay("pwsh.exe", &denied, n).map(|d| d.as_millis())).collect();
        if cfg!(windows) {
            assert_eq!(delays, [Some(100), Some(300), Some(700), None]);
            assert!(denied_spawn_delay("C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", &denied, 0).is_some());
        } else {
            assert_eq!(delays, [None, None, None, None]);
        }
        assert_eq!(denied_spawn_delay("pwsh.exe", &missing, 0), None);
        assert_eq!(denied_spawn_delay("bash.exe", &denied, 0), None);
    }

    /// A write to a piped input that fails part way ends the process's tree before the input is let go, and the input is let
    /// go only once the process is gone: the reader never sees an end of input after a part of what was written.
    #[test]
    fn a_write_that_fails_part_way_ends_the_tree_before_the_input_is_let_go() {
        /// Takes the first 4 bytes, then fails as a broken pipe does; records when it is dropped (the input closed).
        struct Breaks(Arc<Mutex<Vec<&'static str>>>, usize);
        impl Write for Breaks {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                if self.1 >= 4 {
                    return Err(std::io::Error::from_raw_os_error(232));
                }
                let n = buf.len().min(4 - self.1);
                self.1 += n;
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl Drop for Breaks {
            fn drop(&mut self) {
                self.0.lock().unwrap().push("input let go");
            }
        }
        let log = Arc::new(Mutex::new(Vec::new()));
        let input = InputQueue::new(1 << 20);
        input.push(b"0123456789".to_vec()).unwrap();
        input.close().unwrap();
        let (ended_tx, ended) = mpsc::channel();
        let end_log = Arc::clone(&log);
        let writer = {
            let input = Arc::clone(&input);
            let sink = Box::new(Breaks(Arc::clone(&log), 0));
            std::thread::spawn(move || {
                input.run(
                    sink,
                    Some(Box::new(move || {
                        end_log.lock().unwrap().push("tree ended");
                        ended_tx.send(()).unwrap();
                    })),
                );
            })
        };
        ended.recv_timeout(std::time::Duration::from_secs(60)).expect("the failed write ended the tree");
        // The process's exit, after which the input is let go.
        input.shutdown();
        writer.join().unwrap();
        assert_eq!(*log.lock().unwrap(), ["tree ended", "input let go"]);
    }

    /// Pieces end between characters: a two-byte and a four-byte character on a piece's edge go whole into the next piece; a character
    /// longer than the cap alone is the only cut inside one.
    #[test]
    fn input_pieces_end_between_characters() {
        let text = "aé😀b".as_bytes();
        assert_eq!(pieces(text, 2), vec![&b"a"[..], "é".as_bytes(), &[0xF0, 0x9F], &[0x98, 0x80], b"b"]);
        assert_eq!(pieces(text, 4), vec!["aé".as_bytes(), "😀".as_bytes(), b"b"]);
        assert_eq!(pieces(text, 8), vec![text]);
    }
}

/// A terminal tab's exit raised when node-pty raised it (`NodePtyExit`), on a paused clock only the tests move.
#[cfg(all(test, feature = "core-test", windows))]
mod node_pty_exit {
    use std::sync::mpsc;

    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::process::CommandSpec;
    use mixdog_core_api::domain::process::EnvSpec;

    use super::*;

    const DEADLINE: Duration = Duration::from_secs(60);

    /// `fut`'s value, or a failure naming `what` once [`DEADLINE`] has passed on the wall clock. The deadline waits on the blocking
    /// pool, which also keeps the paused clock from moving by itself meanwhile: only the test's `advance` moves it.
    async fn within<T>(what: &str, fut: impl std::future::Future<Output = T>) -> T {
        let (_alive, timer) = mpsc::channel::<()>();
        let deadline = tokio::task::spawn_blocking(move || {
            let _ = timer.recv_timeout(DEADLINE);
        });
        tokio::select! {
            value = fut => value,
            _ = deadline => panic!("never happened within {DEADLINE:?}: {what}"),
        }
    }

    /// A Windows PowerShell on a pseudo console running `script`, its exit hook telling `ended` when it runs.
    async fn shell(name: &str, script: &str) -> (LocalProcessManager, ProcessHandle, mpsc::Receiver<()>) {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let handle = ProcessHandle::from(format!("node-pty-exit-{name}-{}", std::process::id()));
        let (ended, end) = mpsc::channel();
        let mut args = vec!["-NoProfile".to_owned()];
        if !script.is_empty() {
            args.extend(["-Command".to_owned(), script.to_owned()]);
        }
        manager
            .spawn_with(
                SpawnRequest {
                    handle: handle.clone(),
                    command: CommandSpec::Argv { program: "powershell.exe".to_owned(), args },
                    cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                    env: EnvSpec { inherit: true, ..EnvSpec::default() },
                    pty: Some(PtySize { cols: 80, rows: 24 }),
                    stdin_piped: true,
                    output: OutputMode::Merged,
                    owner: ProcessOwner::Internal,
                    time_limit: None,
                },
                SpawnOptions {
                    on_exit: Some(Box::new(move |_| {
                        let _ = ended.send(());
                        Vec::new()
                    })),
                    node_pty_exit: Some(NodePtyExit { runtime: tokio::runtime::Handle::current() }),
                    ..SpawnOptions::default()
                },
            )
            .await
            .unwrap();
        (manager, handle, end)
    }

    async fn output_until(manager: &LocalProcessManager, handle: &ProcessHandle, text: &str) {
        let mut events = manager.subscribe(handle, Some(0)).unwrap();
        let mut seen = String::new();
        within(&format!("the shell wrote {text:?}"), async {
            while !seen.contains(text) {
                match events.next().await {
                    Some(ProcessEvent::Output { bytes, .. }) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                    other => panic!("output, not {other:?}"),
                }
            }
        })
        .await;
    }

    /// The exit hook has not run (`false`) or runs within the deadline (`true`).
    fn ended(end: &mpsc::Receiver<()>, expected: bool) {
        if expected {
            end.recv_timeout(DEADLINE).expect("the exit was raised");
        } else {
            assert_eq!(end.try_recv(), Err(mpsc::TryRecvError::Empty), "the exit was raised early");
        }
    }

    /// The shell writes, then ends `before` after that: its exit is raised [`NODE_PTY_FLUSH`] after its end, not counted from its
    /// output (Node: 1001-1008 ms after the end with output 0, 999 and 1000 ms before it, exit-timing.json).
    async fn a_natural_exit_comes_a_flush_after_the_end(before: Duration) {
        // A key read without echo: the console draws nothing more.
        let (manager, handle, end) = shell("natural", "[Console]::Out.Write('x'); $null = [Console]::ReadKey($true); exit 3").await;
        output_until(&manager, &handle, "x").await;
        tokio::time::advance(before).await;
        let mut wait = manager.exit_wait(&handle).unwrap();
        manager.write_input(&handle, b"k".to_vec()).unwrap();
        within("the shell ended", wait.wait_for(|wait| wait.waiting)).await.unwrap();
        tokio::time::advance(NODE_PTY_FLUSH - Duration::from_millis(1)).await;
        ended(&end, false);
        tokio::time::advance(Duration::from_millis(1)).await;
        ended(&end, true);
    }

    #[tokio::test(start_paused = true)]
    async fn a_natural_exit_with_output_right_before_it_comes_a_flush_after_the_end() {
        a_natural_exit_comes_a_flush_after_the_end(Duration::ZERO).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_natural_exit_with_output_999_ms_before_it_comes_a_flush_after_the_end() {
        a_natural_exit_comes_a_flush_after_the_end(Duration::from_millis(999)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_natural_exit_with_output_1000_ms_before_it_comes_a_flush_after_the_end() {
        a_natural_exit_comes_a_flush_after_the_end(Duration::from_millis(1000)).await;
    }

    /// Output after the shell's end (a process it left behind still writing) starts the wait again, each chunk: the exit is raised
    /// [`NODE_PTY_FLUSH`] after the last (Node: 999.7-1001 ms after the last output that came after the end, exit-timing.json).
    #[tokio::test(start_paused = true)]
    async fn output_after_the_end_starts_the_wait_again() {
        let (manager, handle, end) = shell("during", "[Console]::Out.Write('x'); $null = [Console]::ReadKey($true); exit 3").await;
        output_until(&manager, &handle, "x").await;
        let mut wait = manager.exit_wait(&handle).unwrap();
        manager.write_input(&handle, b"k".to_vec()).unwrap();
        within("the shell ended", wait.wait_for(|wait| wait.waiting)).await.unwrap();
        let feed = manager.feed_of(&handle).unwrap();
        for _ in 0..2 {
            tokio::time::advance(Duration::from_millis(500)).await;
            feed.push_output(OutputStream::Pty, b"y");
            let pushed = feed.pushed();
            within("the wait saw the chunk", wait.wait_for(|wait| wait.quiet_from == pushed)).await.unwrap();
        }
        tokio::time::advance(NODE_PTY_FLUSH - Duration::from_millis(1)).await;
        ended(&end, false);
        tokio::time::advance(Duration::from_millis(1)).await;
        ended(&end, true);
    }

    /// A killed shell (the terminal closed, as node-pty's `kill`): the exit is raised [`NODE_PTY_EOF`] after the console's output ends
    /// (Node: 48.9-50.6 ms after the killed shell's end, exit-timing.json).
    #[tokio::test(start_paused = true)]
    async fn a_killed_shells_exit_comes_an_eof_wait_after_its_output_ends() {
        let (manager, handle, end) = shell("kill", "").await;
        output_until(&manager, &handle, "PS ").await;
        let mut wait = manager.exit_wait(&handle).unwrap();
        let _hung = manager.hang_up(&handle).unwrap();
        within("the console's output ended", wait.wait_for(|wait| wait.output_ended)).await.unwrap();
        tokio::time::advance(NODE_PTY_EOF - Duration::from_millis(1)).await;
        ended(&end, false);
        tokio::time::advance(Duration::from_millis(1)).await;
        ended(&end, true);
    }

    /// The rule's two waits are the ones Node's recorded exits show (exit-timing.json, record-pty-exit-timing.mjs), each within 10 ms.
    #[test]
    fn the_waits_are_the_ones_node_recorded() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/mobile/fixtures/phone-terminal/exit-timing.json");
        let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let close = |measured: &serde_json::Value, rule: Duration, what: &str| {
            let measured = measured.as_f64().unwrap_or_else(|| panic!("{what} was recorded"));
            assert!((measured - rule.as_secs_f64() * 1000.0).abs() <= 10.0, "{what}: Node {measured} ms, the rule {rule:?}");
        };
        let cases = &recorded["cases"];
        for case in ["output 0 ms before the end", "output 999 ms before the end", "output 1000 ms before the end"] {
            for run in cases[case].as_array().unwrap() {
                close(&run["exitAfterProcessExit"], NODE_PTY_FLUSH, case);
            }
        }
        for run in cases["output after the end"].as_array().unwrap() {
            close(&run["exitAfterLastOutputAfterTheEnd"], NODE_PTY_FLUSH, "output after the end");
        }
        for run in cases["kill"].as_array().unwrap() {
            close(&run["exitAfterProcessExit"], NODE_PTY_EOF, "kill");
        }
    }
}
