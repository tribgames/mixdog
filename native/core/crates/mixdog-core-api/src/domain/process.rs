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
    Output {
        seq: u64,
        stream: OutputStream,
        bytes: Vec<u8>,
    },
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
    /// `limits.maxProcesses` reached.
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
    Io {
        os_code: Option<i32>,
    },
}

#[async_trait]
pub trait ProcessManager: Send + Sync {
    /// Waits for spawn admission (per-session and global permits), then
    /// creates the process on io-spawn; dropping the future abandons the wait.
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError>;
    /// Events from `from_seq` (replayed from the ring) or from the next one.
    fn subscribe(
        &self,
        handle: &ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError>;
    /// Non-blocking write; also serves `process/input` notifications.
    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>)
    -> Result<(), ProcessError>;
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError>;
    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError>;
    /// Tree kill; returns once the kill is issued, the exit follows as an event.
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError>;
    fn list(&self) -> Vec<ProcessInfo>;
}
