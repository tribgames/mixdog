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
}

/// Runs on the process's waiter thread once the root has ended and its output pipes are finished
/// or [`ProcessConfig::output_drain`] has passed, before the exit event is published. The bytes it returns are the feed's last output (the terminal
/// tab's "[process exited …]" line).
pub type ExitHook = Box<dyn FnOnce(&ProcessExit) -> Vec<u8> + Send>;

/// What a spawn needs beyond the domain request.
#[derive(Default)]
pub struct SpawnOptions {
    /// Replaces [`ProcessConfig::ring_bytes`] for this process.
    pub ring_bytes: Option<usize>,
    pub filter: Option<Box<dyn OutputFilter>>,
    pub on_exit: Option<ExitHook>,
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
}

struct InputState {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closing: bool,
    dead: bool,
}

impl InputQueue {
    fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(InputState {
                chunks: VecDeque::new(),
                bytes: 0,
                closing: false,
                dead: false,
            }),
            ready: Condvar::new(),
            room: tokio::sync::Notify::new(),
            cap,
        })
    }

    fn lock(&self) -> MutexGuard<'_, InputState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn push(&self, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let mut state = self.lock();
        if state.closing || state.dead {
            return Err(ProcessError::StdinClosed);
        }
        if state.bytes + bytes.len() > self.cap {
            return Err(ProcessError::Overloaded {
                queue: ProcessQueue::Input,
            });
        }
        state.bytes += bytes.len();
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
        Ok(())
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
    }

    fn run(&self, mut sink: Box<dyn Write + Send>) {
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
            if sink.write_all(&chunk).and_then(|()| sink.flush()).is_err() {
                self.shutdown();
                return;
            }
        }
    }
}

pub(crate) struct Proc {
    handle: ProcessHandle,
    pid: u32,
    owner: ProcessOwner,
    pty_size: Mutex<Option<PtySize>>,
    feed: Arc<Feed>,
    containment: Containment,
    pty: Option<Pty>,
    input: Option<Arc<InputQueue>>,
    life: Mutex<Life>,
    exit: OnceLock<ProcessExit>,
    exit_order: AtomicU64,
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
            owner: self.owner.clone(),
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
                // A process whose descendants still run stays: dropping it would end them.
                Slot::Live(proc) if proc.exit.get().is_some() && !proc.containment.occupied() => {
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    // The pipe ends `cmd` holds close here; the readers see the end of the stream when the tree
    // is gone.
    drop(cmd);
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        if let Err(error) = containment.adopt_and_resume(child.as_raw_handle().cast()) {
            let _ = child.kill();
            return Err(error);
        }
    }
    #[cfg(unix)]
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
}

impl Drain {
    fn new(pipes: usize) -> Arc<Self> {
        Arc::new(Self {
            open: Mutex::new(pipes),
            done: Condvar::new(),
        })
    }

    fn finished(&self) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        *open -= 1;
        if *open == 0 {
            self.done.notify_all();
        }
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
                Some(filter) => feed.push_output(stream, &filter.filter(&buffer[..n])),
                None => feed.push_output(stream, &buffer[..n]),
            },
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            // A closed pseudo-terminal reports an error where a pipe reports the end.
            Err(_) => break,
        }
    }
    if let Some(filter) = filter.as_mut() {
        feed.push_output(stream, &filter.finish());
    }
}

/// How long one kill of a command's tree is given to empty its job or group, and how many kills
/// are issued before the exit is announced anyway.
const KILL_ROUND: Duration = Duration::from_secs(2);
const KILL_ROUNDS: u32 = 3;

/// Waits for the root, then for the output to end (for at most [`ProcessConfig::output_drain`]),
/// and publishes the exit as the last event.
fn wait_and_finish(
    inner: Arc<Inner>,
    proc: Arc<Proc>,
    mut root: Root,
    drain: Arc<Drain>,
    on_exit: Option<ExitHook>,
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
    // A killed command's tree is gone before anything waits on its output or its exit is
    // announced: a caller that saw the exit may remove what a survivor still held open.
    if proc.life().killed.is_some() {
        proc.containment.settle_killed(KILL_ROUND, KILL_ROUNDS);
    }
    // Closing a ConPTY can wait for its output to be read, and the close is what ends that
    // output; it runs beside the drain so a close that hangs is bounded by the same limit.
    if proc.pty.is_some() {
        let closing = Arc::clone(&proc);
        let _ = thread::Builder::new().name("pty-close".to_owned()).spawn(move || {
            if let Some(pty) = &closing.pty {
                pty.close();
            }
        });
    }
    drain.wait(inner.config.output_drain);
    if let Some(input) = &proc.input {
        input.shutdown();
    }
    // Read after the drain: a kill during it (descendants still holding the pipes) counts.
    // Fixing the reason and closing the door to kills is one step under the lifecycle lock; a
    // later kill returns `AlreadyExited`.
    let killed = {
        let mut life = proc.life();
        life.finalized = true;
        life.killed
    };
    if killed.is_some() {
        proc.containment.settle_killed(KILL_ROUND, KILL_ROUNDS);
    }
    #[cfg(feature = "core-test")]
    crate::testing::exit_window();
    let status = status.unwrap_or(mixdog_core_api::domain::process::ExitStatus::Code(-1));
    let exit = ProcessExit { status, killed };
    if let Some(hook) = on_exit {
        proc.feed.push_output(OutputStream::Pty, &hook(&exit));
    }
    proc.exit_order
        .store(inner.exit_counter.fetch_add(1, Ordering::AcqRel), Ordering::Release);
    let _ = proc.exit.set(exit);
    // The slot is free before the exit is announced, so a caller that saw the exit can spawn.
    inner.live.fetch_sub(1, Ordering::AcqRel);
    proc.feed.push_exit(exit);
}

/// Creates the process and its threads; runs on io-spawn.
fn launch_process(
    inner: &Arc<Inner>,
    admission: Admission,
    request: SpawnRequest,
    options: SpawnOptions,
) -> Result<SpawnedProcess, ProcessError> {
    let launch = Launch::of(&request.command, &inner.config.default_shell);
    let env = environment(&request.env);
    if !request.cwd.as_path().is_dir() {
        return Err(ProcessError::Io {
            os_code: Some(if cfg!(windows) { 3 } else { 2 }),
        });
    }
    let containment = Containment::create().map_err(|e| io_error(&e))?;
    let started = match request.pty {
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
    }
    .map_err(|e| spawn_error(launch.program(), &e))?;

    let Started {
        root,
        pty,
        readers,
        writer,
    } = started;
    let pid = root.pid();
    let feed = Feed::new(options.ring_bytes.unwrap_or(inner.config.ring_bytes));
    let input = writer.is_some().then(|| InputQueue::new(inner.config.input_queue_bytes));
    let proc = Arc::new(Proc {
        handle: request.handle.clone(),
        pid,
        owner: request.owner.clone(),
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
        let started = thread::Builder::new()
            .name("io-pty-read".to_owned())
            .spawn(move || read_loop(reader, stream, feed, filter, reading));
        if let Err(error) = started {
            let _ = proc.kill(KillReason::Requested);
            return Err(io_error(&error));
        }
    }
    if let (Some(input), Some(writer)) = (input, writer) {
        let started = thread::Builder::new()
            .name("io-pty-write".to_owned())
            .spawn(move || input.run(writer));
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
            .spawn(move || wait_and_finish(inner, proc, root, drain, options.on_exit))
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
    Ok(SpawnedProcess { handle, pid })
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
                let spawned = launch_process(&inner, admission, request, options)?;
                // Checked after the commit: a requester that left before it is found here, one that
                // leaves after it finds the child in the table (`Abandon::drop`).
                if gone.is_cancelled() {
                    let _ = inner.lookup(&spawned.handle).and_then(|proc| proc.kill(KillReason::Requested));
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
                Slot::Live(proc) if matches(&proc.owner) => Some(Arc::clone(proc)),
                _ => None,
            })
            .collect();
        procs.iter().filter(|p| p.kill(reason).is_ok()).count()
    }

    /// The non-blocking write behind `write_stdin` and the `process/input` notification: queues
    /// `bytes` for the process's writer thread.
    pub fn write_input(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        proc.input
            .as_ref()
            .ok_or(ProcessError::StdinClosed)?
            .push(bytes)
    }

    /// Queues `bytes` for the process, waiting for room when its input queue is full: the
    /// `process/input` notification is never dropped, and the connection reader that sent it
    /// stays paused for as long as this waits. Fails only when the process cannot take input.
    pub async fn write_input_wait(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let proc = self.inner.lookup(handle)?;
        let input = proc.input.as_ref().ok_or(ProcessError::StdinClosed)?;
        loop {
            let mut room = std::pin::pin!(input.room.notified());
            // Registered before the push is tried, so room made in between is not missed.
            room.as_mut().enable();
            match input.push(bytes.clone()) {
                Err(ProcessError::Overloaded { queue: ProcessQueue::Input }) => room.await,
                other => return other,
            }
        }
    }

    /// Output bytes the process's reader has put into its feed so far.
    pub fn output_pushed(&self, handle: &ProcessHandle) -> Result<u64, ProcessError> {
        Ok(self.inner.lookup(handle)?.feed.pushed())
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
}

#[async_trait]
impl ProcessManager for LocalProcessManager {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.spawn_with(request, SpawnOptions::default()).await
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
}
