//! The one process manager (DS §6): shell tool, background tasks, terminal
//! tabs, LSP servers, git, gh, formatters and skill scripts all spawn here.
//! Spawning runs on io-spawn inside a job object / process group; output is
//! read by one io-pty reader per child; kill is an O(1) tree kill issued
//! inline.

use std::time::Duration;

use async_trait::async_trait;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::TerminalTabId;
use mixdog_protocol::ThreadId;

use super::common::AbsPath;
use super::common::EventSource;
use mixdog_protocol::ToolCallId;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CommandSpec {
    Argv {
        program: String,
        args: Vec<String>,
    },
    /// Run through a shell; `shell` names the program (`None` = the
    /// configured default shell).
    Shell {
        script: String,
        shell: Option<String>,
    },
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct EnvSpec {
    pub inherit: bool,
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

/// Who owns a process; closing the owner applies the owner's rule (tabs
/// persist; tool processes follow run/abort rules).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ProcessOwner {
    Tool {
        thread_id: ThreadId,
        tool_call_id: ToolCallId,
    },
    TerminalTab {
        tab_id: TerminalTabId,
    },
    Lsp {
        root: AbsPath,
        language: String,
    },
    Internal,
    /// The computer helper: its job lets the helper's cursor watchdog break away and outlive it (Windows). `scope` is the automation
    /// scope it is started under, `None` for a helper no scope owns (a crash sweep, the remote screen's input process): the manager
    /// creates a scoped helper only while that scope holds, and registers it with the scope before a revocation can proceed.
    ComputerHelper {
        scope: Option<LaunchScope>,
    },
}

/// Serializes the creation of a process with the revocation of the scope it is created under (see
/// [`ProcessOwner::ComputerHelper`]).
pub trait LaunchAuthority: Send + Sync {
    /// The commit of one creation attempt: `None` once the scope is revoked, and then nothing may be created. While the commit lives a
    /// revocation waits, so it is held only across the synchronous creation and the registration of what was created, never across a
    /// wait, a sleep or a retry.
    fn begin(&self) -> Option<Box<dyn LaunchCommit + '_>>;
}

/// One creation attempt committed under a scope that still holds.
pub trait LaunchCommit {
    /// `handle` was created: the revocation that follows finds it by this exact handle.
    fn launched(&mut self, handle: &ProcessHandle);
}

/// The scope a computer helper is started under; equal only to itself.
#[derive(Clone)]
pub struct LaunchScope(pub std::sync::Arc<dyn LaunchAuthority>);

impl PartialEq for LaunchScope {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for LaunchScope {}

impl std::fmt::Debug for LaunchScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LaunchScope")
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OutputMode {
    /// stdout and stderr as separate streams.
    Separate,
    /// stderr folded into stdout in arrival order.
    Merged,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SpawnRequest {
    pub handle: ProcessHandle,
    pub command: CommandSpec,
    pub cwd: AbsPath,
    pub env: EnvSpec,
    /// `Some` runs under a PTY (output stream `Pty`).
    pub pty: Option<PtySize>,
    pub stdin_piped: bool,
    pub output: OutputMode,
    pub owner: ProcessOwner,
    /// Caller-requested run limit (a tool argument); ends with
    /// `KillReason::TimeLimit`. Not a liveness check.
    pub time_limit: Option<Duration>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SpawnedProcess {
    pub handle: ProcessHandle,
    pub pid: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OutputStream {
    Stdout,
    Stderr,
    Pty,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KillReason {
    Requested,
    TimeLimit,
    OwnerClosed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExitStatus {
    Code(i32),
    Signal(i32),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProcessExit {
    pub status: ExitStatus,
    pub killed: Option<KillReason>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ProcessEvent {
    /// `seq` increases by one per event of a handle, starting at 0.
    Output { seq: u64, stream: OutputStream, bytes: Vec<u8> },
    /// Last event.
    Exited { seq: u64, exit: ProcessExit },
}

impl ProcessEvent {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Output { seq, .. } | Self::Exited { seq, .. } => *seq,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProcessInfo {
    pub handle: ProcessHandle,
    pub pid: u32,
    pub owner: ProcessOwner,
    pub pty: Option<PtySize>,
    pub exit: Option<ProcessExit>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ProcessError {
    UnknownHandle,
    HandleInUse,
    /// The program does not exist (maps to `unavailable{capability}`).
    ProgramNotFound {
        program: String,
    },
    PermissionDenied,
    /// An explicitly configured live-process cap (`ProcessConfig::max_processes > 0`) was reached.
    LimitReached {
        limit: u32,
    },
    NotPty,
    StdinClosed,
    AlreadyExited,
    /// Events before `from_seq` left the replay ring.
    ReplayUnavailable {
        oldest: u64,
    },
    /// An admission queue is full; nothing was started or written. An admission fact, never
    /// an I/O failure.
    Overloaded {
        queue: ProcessQueue,
    },
    /// The scope the process was to be started under is revoked; nothing was created.
    Revoked,
    /// Cancellation attempted to stop a started process, but the root or a descendant still
    /// occupies its containment after forced-kill waits; ownership remains retained.
    CleanupIncomplete,
    Io {
        os_code: Option<i32>,
    },
}

/// The full queue of [`ProcessError::Overloaded`]. Callers act differently: a full spawn
/// queue answers the spawning request (`queueFull`), while a full input queue pauses the
/// sending connection's reader for `process/input` notifications (`Admit::Pause`) and
/// answers `queueFull` only to a `write_stdin` request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProcessQueue {
    /// The io-spawn lane queue (`spawn`).
    Spawn,
    /// The process's bounded stdin queue (`write_stdin`).
    Input,
}

#[async_trait]
pub trait ProcessManager: Send + Sync {
    /// Admits the spawn to the io-spawn lane queue (full: `Overloaded{Spawn}`; if a non-zero
    /// live-process cap is configured and reached: `LimitReached`), then creates the process on
    /// io-spawn; dropping the future abandons the wait. The manager is uncapped by default
    /// (`limits.maxProcesses == 0`); foreground shell concurrency is bounded by shell admission,
    /// and there is no per-session spawn limit.
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError>;
    /// [`spawn`](Self::spawn) and a subscription from the process's first event, made in one
    /// step: the subscription exists before the child can write a byte, so however late the
    /// caller is scheduled none of the output is lost (a subscriber holds the replay ring's
    /// reader back instead). The default subscribes after the spawn, for managers without a ring.
    async fn spawn_subscribed(&self, request: SpawnRequest) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
        let handle = request.handle.clone();
        let spawned = self.spawn(request).await?;
        Ok((spawned, self.subscribe_holding(&handle, Some(0))?))
    }
    /// [`spawn_subscribed`](Self::spawn_subscribed) that respects `cancel`: a queued spawn is
    /// abandoned promptly with [`ProcessError::Revoked`], and a launch already in progress is
    /// killed and waited until exit before returning [`ProcessError::Revoked`] (or
    /// [`ProcessError::CleanupIncomplete`] if the root or a descendant still occupies containment
    /// after forced-kill waits).
    async fn spawn_subscribed_cancellable(
        &self,
        request: SpawnRequest,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
        if cancel.is_cancelled() {
            return Err(ProcessError::Revoked);
        }
        match self.spawn_subscribed(request).await {
            Ok((spawned, mut events)) => {
                if cancel.is_cancelled() {
                    let _ = self.kill(&spawned.handle);
                    while let Some(event) = events.next().await {
                        if matches!(event, ProcessEvent::Exited { .. }) {
                            break;
                        }
                    }
                    return Err(ProcessError::Revoked);
                }
                Ok((spawned, events))
            }
            Err(_) if cancel.is_cancelled() => Err(ProcessError::Revoked),
            Err(error) => Err(error),
        }
    }
    /// Events from `from_seq` (replayed from the ring) or from the next one, for a live viewer. Once the process has ended or was
    /// killed, a viewer that lags by the ring bound no longer holds the reader back: the ring may overtake it, and the gap in the
    /// sequence numbers is the output it lost; the exit still reaches it.
    fn subscribe(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError>;
    /// [`subscribe`](Self::subscribe) for a consumer that returns the process's output as its result: like
    /// [`spawn_subscribed`](Self::spawn_subscribed)'s subscription it holds the reader back until it has taken the output, after
    /// the end, a kill and a shutdown too, so the ring never overtakes it; it must read to the exit or be dropped. Only a live
    /// viewer subscribes with [`subscribe`](Self::subscribe). A manager without a ring answers it as `subscribe`; a wrapper forwards it.
    fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError>;
    /// Non-blocking write; also serves `process/input` notifications.
    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError>;
    /// Writes the whole of `bytes`, of any size, waiting for room as the process reads (Node's `stdinWrite`, which hands
    /// the helper the whole string): never a part of it. Resolves once every byte is in the process's input; an error
    /// when that could not happen (a failed write, a process gone first), after which the caller must not close the input
    /// as if the whole had arrived. A manager without a bounded input queue writes as [`write_stdin`](Self::write_stdin).
    async fn write_stdin_whole(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.write_stdin(handle, bytes).await
    }
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError>;
    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError>;
    /// Tree kill; returns once the kill is issued, the exit follows as an event.
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError>;
    /// The gentle first stop of the tree, for a caller that escalates to [`kill`](Self::kill) when
    /// the exit does not come (Node's `child.kill()` and then `child.kill('SIGKILL')`): SIGTERM to
    /// the process group on Unix. Where the platform has no gentle stop (a Windows job object) it
    /// is the forced kill, and so is the default.
    fn terminate(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.kill(handle)
    }
    fn list(&self) -> Vec<ProcessInfo>;
    /// Hands a live process spawned ahead of its use (a parked shell standby, owned `Internal`) to `owner`, its run limit
    /// counted from now. A manager that cannot hand processes over refuses with `UnknownHandle`, and the caller spawns.
    fn claim(&self, handle: &ProcessHandle, owner: ProcessOwner, time_limit: Option<Duration>) -> Result<(), ProcessError> {
        let _ = (handle, owner, time_limit);
        Err(ProcessError::UnknownHandle)
    }
    /// Arms a run limit on an existing process, counted from now, without changing its owner.
    fn arm_time_limit(&self, handle: &ProcessHandle, limit: Duration) -> Result<(), ProcessError> {
        let _ = (handle, limit);
        Err(ProcessError::UnknownHandle)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use tokio::sync::Notify;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use super::*;

    struct TestEvents(mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for TestEvents {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    #[derive(Default)]
    struct DefaultCancelPm {
        spawn_entered: Notify,
        spawn_release: Notify,
        kill_entered: Notify,
        spawned: AtomicBool,
        killed: AtomicBool,
        tx: Mutex<Option<mpsc::UnboundedSender<ProcessEvent>>>,
    }

    #[async_trait]
    impl ProcessManager for DefaultCancelPm {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            Ok(SpawnedProcess { handle: request.handle, pid: 42 })
        }

        async fn spawn_subscribed(&self, request: SpawnRequest) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
            self.spawned.store(true, Ordering::SeqCst);
            let wait = self.spawn_release.notified();
            self.spawn_entered.notify_waiters();
            wait.await;
            let (tx, rx) = mpsc::unbounded_channel();
            *self.tx.lock().unwrap() = Some(tx);
            Ok((SpawnedProcess { handle: request.handle, pid: 42 }, Box::new(TestEvents(rx))))
        }

        fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Err(ProcessError::UnknownHandle)
        }

        fn subscribe_holding(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Err(ProcessError::UnknownHandle)
        }

        async fn write_stdin(&self, _handle: &ProcessHandle, _bytes: Vec<u8>) -> Result<(), ProcessError> {
            Ok(())
        }

        fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::NotPty)
        }

        fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.killed.store(true, Ordering::SeqCst);
            self.kill_entered.notify_waiters();
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    fn test_request(handle: &str) -> SpawnRequest {
        SpawnRequest {
            handle: ProcessHandle::from(handle),
            command: CommandSpec::Argv { program: "true".into(), args: Vec::new() },
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            env: EnvSpec::default(),
            pty: None,
            stdin_piped: true,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: None,
        }
    }

    #[tokio::test]
    async fn default_spawn_subscribed_cancellable_kills_and_drains_when_cancelled_mid_spawn() {
        let pm = Arc::new(DefaultCancelPm::default());

        // Pre-cancelled token must short-circuit without calling spawn_subscribed.
        let precancel = CancellationToken::new();
        precancel.cancel();
        let pre = pm.spawn_subscribed_cancellable(test_request("pre"), precancel).await;
        assert_eq!(pre.err(), Some(ProcessError::Revoked));
        assert!(!pm.spawned.load(Ordering::SeqCst));

        // Cancelling after spawn_subscribed starts must not drop it early: it waits, kills, and drains Exited.
        let cancel = CancellationToken::new();
        let entered = pm.spawn_entered.notified();
        let task = tokio::spawn({
            let pm = pm.clone();
            let cancel = cancel.clone();
            async move { pm.spawn_subscribed_cancellable(test_request("mid"), cancel).await }
        });
        entered.await;

        cancel.cancel();
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(!task.is_finished(), "default spawn_subscribed_cancellable must not drop an in-flight spawn_subscribed");

        let kill_wait = pm.kill_entered.notified();
        pm.spawn_release.notify_waiters();
        kill_wait.await;
        assert!(pm.killed.load(Ordering::SeqCst), "cancelled spawn must kill the returned process");

        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(!task.is_finished(), "default spawn_subscribed_cancellable must wait for ProcessEvent::Exited before returning");

        let tx = pm.tx.lock().unwrap().take().expect("event sender");
        tx.send(ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::Requested) } }).unwrap();

        let result = task.await.expect("spawn task joined");
        assert_eq!(result.err(), Some(ProcessError::Revoked));
    }
}
