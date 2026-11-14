//! The shell jobs of one runtime: one job per spawned process, filled by a collector running on
//! an `mixdog-rt` lane from the process's event stream, written to its log files by a per-job
//! writer (`spill::LogWriter`), and registered in WP-PROC's `TaskRegistry` (`native/mixdog-spawn/src/tasks.rs`), which owns
//! the task rows and the shell-job strips. The jobs add what that registry does not hold: the
//! captured output with its read cursors and the model-facing text.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU32;
use std::time::Duration;

use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolNotify;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::PtyIo;
use mixdog_rt::SpawnIo;
use mixdog_rt::TaskClass;
use mixdog_spawn::tasks::TaskOutcome;
use mixdog_spawn::tasks::TaskRegistry as SpawnTasks;
use mixdog_spawn::tasks::TaskSpec;
use mixdog_spawn::tasks::TaskStatus as SpawnStatus;
use regex::Regex;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::codepage::Label;
use super::codepage::ShellStreamDecoder;
use super::codepage::Sniffer;
use super::codepage::WINDOW_CAP;
use super::codepage::aligned_offset;
use super::codepage::decode_shell_bytes;
use super::delivery::Piece;
use super::delivery::delivery_full_chars;
use super::delivery::edges_piece;
use super::delivery::fit_pieces;
use super::delivery::omission_marker;
use super::delivery::prepare_shell_text;
use super::delivery::text_piece;
use super::delivery::Omitted;
use super::spill;
use super::text::CarriageReturnFolder;
use super::text::count_newlines;
use super::text::escape_harness_tags;
use super::text::format_duration;
use super::text::format_kb;
use super::text::strip_ansi;
use super::wake::WakeHub;
use crate::policy::CommandPolicy;

/// Bytes kept in memory per stream; older bytes stay only in the spill log, apart from what a read of them needs
/// (`Stream::keep_dropped`).
const MEMORY_CAP: usize = 8 * 1024 * 1024;
/// `SHELL_OUTPUT_DISK_CAP` (`shell-exec-output.mjs`): the most a command may write to its two logs together; past it the process is
/// killed, so a runaway loop cannot fill the disk.
pub const OUTPUT_DISK_CAP: u64 = 100 * 1024 * 1024;
/// An unseen range up to this size is read whole; a longer one only at its two ends.
const FULL_READ_BYTES: usize = 64 * 1024;
const EDGE_READ_BYTES: usize = 16 * 1024;
/// How long a finished job stays readable.
const RETENTION_MS: u64 = mixdog_spawn::tasks::FINISHED_RETENTION_MS;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pushed to the owner when a detached job finishes. Awaited in the completing job's task, so a
/// slow consumer pushes back on the job instead of queueing behind it. `surface` is the
/// completion's execution surface (`"shell"`, `"agent"`), given by the caller as today's
/// `markCompletionEntry` meta `execution_surface`.
#[async_trait::async_trait]
pub trait TaskNotifier: Send + Sync {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String);
}

/// Decides, per call, whether an elevated launch (the exec policy's `Ask`) is approved. The
/// answer comes from the runtime, never from the model's arguments. An implementation that wants
/// a Mixdog prompt first asks `ctx.approvals`.
pub trait ElevationGate: Send + Sync {
    fn approved(&self, ctx: &ToolContext, command: &str) -> bool;
}

/// Node's `applyShellElevationGate`: elevated launches skip Mixdog's own prompt, the operating
/// system's elevation prompt is the user's confirmation. A deny is never lifted.
pub struct OsPromptElevation;

impl ElevationGate for OsPromptElevation {
    fn approved(&self, _: &ToolContext, _: &str) -> bool {
        true
    }
}

/// What a finished command left running (`result.descendants`): processes it started that outlive
/// its shell.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Survivors {
    /// Whether this process can still signal them (on Windows a re-parented process is visible
    /// but not signalable).
    pub reachable: bool,
}

/// Observation of the processes a finished command left behind (`lib/shell-descendants.mjs`),
/// provided by the process layer, which owns the process table.
#[async_trait::async_trait]
pub trait SurvivorWatch: Send + Sync {
    /// The survivors of the command run as `handle`, observed once it exited.
    fn survivors(&self, handle: &ProcessHandle) -> Option<Survivors>;
    /// Completes `true` when the last survivor has exited, `false` when `abort` is raised first
    /// (`waitForShellDescendants`).
    async fn wait_gone(&self, handle: &ProcessHandle, abort: &CancellationToken) -> bool;
    /// Terminates them; `true` when a re-observation found every one gone.
    async fn kill(&self, handle: &ProcessHandle) -> bool;
}

/// The process layer's own observation (`mixdog_spawn::survivors`), which lists a command's
/// survivors from its job object or process group and reports them gone from the operating
/// system's events; the method for method mapping that module documents.
#[async_trait::async_trait]
impl SurvivorWatch for mixdog_spawn::survivors::ProcessSurvivors {
    fn survivors(&self, handle: &ProcessHandle) -> Option<Survivors> {
        mixdog_spawn::survivors::ProcessSurvivors::survivors(self, handle).map(|report| Survivors { reachable: report.reachable })
    }

    async fn wait_gone(&self, handle: &ProcessHandle, abort: &CancellationToken) -> bool {
        mixdog_spawn::survivors::ProcessSurvivors::wait_gone(self, handle, abort).await
    }

    async fn kill(&self, handle: &ProcessHandle) -> bool {
        mixdog_spawn::survivors::ProcessSurvivors::kill(self, handle).await
    }
}

/// The lane tokens the shell and task tools run their file work on. A call's start (program
/// lookup, scratch and launcher directories, log files) is on `spawn`, beside the process
/// creation it prepares; a job's log appends drain on its own `pty` thread; a result's reads are
/// on `interactive` and its writes on `durability`. `maintenance` is left to background work.
#[derive(Clone, Copy)]
pub struct IoLanes {
    pub interactive: InteractiveIo,
    pub durability: DurabilityIo,
    pub maintenance: MaintenanceIo,
    pub spawn: SpawnIo,
    pub pty: PtyIo,
}

/// `shell-runtime.mjs`' `_configuredShell` and `_resolvedShell`. The default program is resolved
/// when first needed and kept until the setting changes (`setConfiguredShell` clears it), so a
/// PATH or install change is seen after a setting change, as in Node.
pub trait ShellSource: Send + Sync {
    /// `getConfiguredShell()`.
    fn configured(&self) -> String;
    /// The kept default program, `None` after a setting change (or before the first use).
    fn kept_default(&self) -> Option<String>;
    /// `resolveShell()` without a setting: probes the file system, so it runs in a lane job.
    fn resolve_default(&self) -> String;
    /// Keeps `program` unless the setting is no longer `configured` (a change during the probe
    /// leaves the cleared state; the next spawn probes again).
    fn keep_default(&self, configured: &str, program: String);
}

/// A shell source whose default never changes (hosts without a setting, tests).
pub struct FixedShell(pub String);

impl ShellSource for FixedShell {
    fn configured(&self) -> String {
        String::new()
    }
    fn kept_default(&self) -> Option<String> {
        Some(self.0.clone())
    }
    fn resolve_default(&self) -> String {
        self.0.clone()
    }
    fn keep_default(&self, _: &str, _: String) {}
}

#[derive(Clone)]
pub struct ExecConfig {
    pub tasks: Arc<SpawnTasks>,
    pub lanes: IoLanes,
    /// Where the output logs of every job are written.
    pub spill_dir: PathBuf,
    /// The data directory; session scratch directories live under `<data>/scratch`.
    pub data_dir: Option<PathBuf>,
    /// Directory of the skill launchers, put first on every model shell's PATH.
    pub skill_launcher_dir: Option<PathBuf>,
    pub notifier: Option<Arc<dyn TaskNotifier>>,
    /// Observes what a finished command left running; `None` tracks nothing.
    pub survivors: Option<Arc<dyn SurvivorWatch>>,
    pub wake: Arc<WakeHub>,
    pub policy: Arc<dyn CommandPolicy>,
    pub elevation: Arc<dyn ElevationGate>,
    /// The WHATWG label of the system OEM code page (CP949 → `euc-kr`), read once by the host at
    /// start with `codepage::oem_label(detect_oem_codepage())`; `None` off Windows.
    pub oem: Option<&'static str>,
    /// The runtime a skill script runs on (this daemon's executable and the skill entry); the
    /// PowerShell `mixdog-skill-node` function and the launcher files are built from it.
    pub skill_runtime: Option<super::invocation::SkillRuntime>,
    /// The "system shell" setting and the default program, both read at every spawn (see
    /// [`super::shell_choice::chosen_shell`]).
    pub shell: Arc<dyn ShellSource>,
    /// Tells whether a Node script body compiles as CommonJS (see [`super::hoist::ScriptSyntax`]).
    pub script_syntax: Arc<dyn super::hoist::ScriptSyntax>,
    /// The host is Windows (PowerShell hints, `Path` casing, UTF-8 Python variables).
    pub windows: bool,
    /// The default shell is PowerShell (the wmic rewrite applies).
    pub powershell: bool,
    /// PowerShell commands run in a warm standby when one is parked ([`super::standby`]); the process manager must hand
    /// processes over (`ProcessManager::claim`).
    pub warm_standby: bool,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// Task status as the `task` tool reports it (`shellJobTaskStatus`): a non-zero exit is the
/// command's own result and stays `completed`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

const SIGNAL_NAMES: [&str; 33] = [
    "", "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL",
    "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD",
    "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ",
    "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS", "",
];

/// Node's `os.constants.signals` on Windows.
const WINDOWS_SIGNALS: [(i32, &str); 11] = [
    (1, "SIGHUP"), (2, "SIGINT"), (3, "SIGQUIT"), (4, "SIGILL"), (22, "SIGABRT"), (8, "SIGFPE"),
    (9, "SIGKILL"), (11, "SIGSEGV"), (15, "SIGTERM"), (21, "SIGBREAK"), (28, "SIGWINCH"),
];

/// The name of signal `number` in Node's `os.constants.signals` of the host platform.
pub fn signal_name(number: i32) -> Option<&'static str> {
    if cfg!(windows) {
        return WINDOWS_SIGNALS.iter().find(|(n, _)| *n == number).map(|(_, name)| *name);
    }
    unix_signal_name(number)
}

pub(crate) fn unix_signal_name(number: i32) -> Option<&'static str> {
    usize::try_from(number)
        .ok()
        .and_then(|n| SIGNAL_NAMES.get(n))
        .copied()
        .filter(|name| !name.is_empty())
}

/// What the task rows and views report for how a process ended.
#[derive(Clone)]
pub struct ExitFacts {
    pub status: JobStatus,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub signal: Option<String>,
    pub error: Option<String>,
}

impl ExitFacts {
    /// A failed end with no exit of a process to tell (an exit never seen, an outcome lost to a restart), with `error`.
    fn failed(error: Option<String>) -> Self {
        Self { status: JobStatus::Failed, exit_code: None, timed_out: false, signal: None, error }
    }

    /// A command killed for writing past [`OUTPUT_DISK_CAP`] failed, and says so.
    fn mark_output_capped(&mut self) {
        self.status = JobStatus::Failed;
        self.error = Some(format!("output exceeded {OUTPUT_DISK_CAP} byte cap"));
    }

    /// What a job's ownership record keeps of its end, at `finished_ms` (`terminalRecord`).
    fn record(&self, finished_ms: u64) -> serde_json::Map<String, serde_json::Value> {
        let mut fields = serde_json::Map::new();
        fields.insert("status".into(), self.status.as_str().into());
        fields.insert("exitCode".into(), self.exit_code.into());
        fields.insert("timedOut".into(), self.timed_out.into());
        fields.insert("signal".into(), self.signal.clone().into());
        fields.insert("error".into(), self.error.clone().into());
        fields.insert("finishedAtMs".into(), finished_ms.into());
        fields
    }

    /// How a job's ownership record says it ended; `None` while it says the job runs.
    fn of_record(record: &serde_json::Map<String, serde_json::Value>) -> Option<Self> {
        let status = match record.get("status")?.as_str()? {
            "completed" => JobStatus::Completed,
            "failed" => JobStatus::Failed,
            "cancelled" => JobStatus::Cancelled,
            _ => return None,
        };
        let text = |key: &str| record.get(key).and_then(serde_json::Value::as_str).map(str::to_owned);
        Some(Self {
            status,
            exit_code: record.get("exitCode").and_then(serde_json::Value::as_i64).and_then(|code| i32::try_from(code).ok()),
            timed_out: record.get("timedOut").and_then(serde_json::Value::as_bool).unwrap_or(false),
            signal: text("signal"),
            error: text("error"),
        })
    }
}

pub fn exit_facts(exit: &ProcessExit) -> ExitFacts {
    let timed_out = exit.killed == Some(KillReason::TimeLimit);
    let signal = match exit.status {
        ExitStatus::Signal(n) => signal_name(n).map(str::to_owned),
        ExitStatus::Code(_) => None,
    };
    let exit_code = if timed_out {
        Some(mixdog_spawn::tasks::TIME_LIMIT_EXIT_CODE)
    } else if exit.killed.is_some() {
        Some(mixdog_spawn::tasks::KILLED_EXIT_CODE)
    } else {
        match exit.status {
            ExitStatus::Code(code) => Some(code),
            ExitStatus::Signal(_) => None,
        }
    };
    let status = if timed_out {
        JobStatus::Failed
    } else if exit.killed.is_some() {
        JobStatus::Cancelled
    } else if matches!(exit.status, ExitStatus::Code(_)) {
        JobStatus::Completed
    } else {
        JobStatus::Failed
    };
    let detail = exit_code.map_or(String::new(), |c| format!(" (exit {c})"));
    let error = (status == JobStatus::Failed).then(|| {
        if timed_out {
            format!("timed out before completing{detail}")
        } else if let Some(signal) = &signal {
            format!("terminated by signal {signal}{detail}")
        } else if let ExitStatus::Signal(n) = exit.status {
            format!("terminated by signal {n}{detail}")
        } else {
            "ended without an exit status".to_owned()
        }
    });
    ExitFacts { status, exit_code, timed_out, signal, error }
}

struct Cursor {
    offset: u64,
    /// Decodes the stream in its code page; holds the bytes of a character a read cut.
    decoder: ShellStreamDecoder,
    sniffer: Sniffer,
    /// The sniffer's firm decision was handed to the decoder.
    committed: bool,
    /// The introducer of an escape sequence cut by the end of the last read.
    ansi: String,
    fold: CarriageReturnFolder,
    /// What memory dropped of the unread range from `offset` (`Stream::keep_dropped`).
    dropped: Option<Dropped>,
}

impl Cursor {
    fn new(oem: Option<Label>) -> Self {
        Self {
            offset: 0,
            decoder: ShellStreamDecoder::new(oem, None),
            sniffer: Sniffer::new(oem),
            committed: false,
            ansi: String::new(),
            fold: CarriageReturnFolder::default(),
            dropped: None,
        }
    }
}

/// What a read from an offset memory no longer holds needs of the dropped bytes, which Node's `readRange` reads from the
/// log: the newlines before the offset and up to `EDGE_READ_BYTES` from it.
struct Dropped {
    lines_before: usize,
    head: Vec<u8>,
}

/// Appends to `head`, the bytes kept from absolute `at`, those of `dropped` (from absolute `from`) within
/// `EDGE_READ_BYTES` of `at`.
fn keep_head(head: &mut Vec<u8>, at: u64, from: u64, dropped: &[u8]) {
    let start = (at + head.len() as u64).max(from);
    let end = (at + EDGE_READ_BYTES as u64).min(from + dropped.len() as u64);
    if start < end {
        head.extend_from_slice(&dropped[(start - from) as usize..(end - from) as usize]);
    }
}

struct Stream {
    oem: Option<Label>,
    buf: Vec<u8>,
    /// Absolute offset of `buf[0]`.
    base: u64,
    cursor: Cursor,
    /// Newlines in the bytes before `base`.
    dropped_lines: usize,
    /// The stream's first `EDGE_READ_BYTES`, the head of a read from its start once memory dropped them.
    first: Vec<u8>,
    /// The offset of the stream's first non-ASCII byte and up to `WINDOW_CAP` bytes from it: the window its encoding is
    /// decided on, which `FileEncodingSniffer` reads from the log whatever memory dropped. Kept only with an OEM page.
    window: Option<(u64, Vec<u8>)>,
}

impl Stream {
    fn new(oem: Option<Label>) -> Self {
        Self {
            oem,
            buf: Vec::new(),
            base: 0,
            cursor: Cursor::new(oem),
            dropped_lines: 0,
            first: Vec::new(),
            window: None,
        }
    }

    fn end(&self) -> u64 {
        self.base + self.buf.len() as u64
    }

    fn push(&mut self, bytes: &[u8]) {
        self.extend_window(bytes);
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > MEMORY_CAP {
            let drop = self.buf.len() - MEMORY_CAP;
            self.keep_dropped(drop);
            self.buf.drain(..drop);
            self.base += drop as u64;
        }
    }

    /// Extends the encoding window with `bytes`, about to be appended.
    fn extend_window(&mut self, bytes: &[u8]) {
        if self.oem.is_none() {
            return;
        }
        let end = self.end();
        if let Some((_, window)) = &mut self.window {
            let room = WINDOW_CAP - window.len();
            window.extend_from_slice(&bytes[..bytes.len().min(room)]);
        } else if let Some(at) = bytes.iter().position(|b| *b >= 0x80) {
            self.window = Some((end + at as u64, bytes[at..bytes.len().min(at + WINDOW_CAP)].to_vec()));
        }
    }

    /// Keeps what a read from before `base` needs of the first `len` bytes, about to leave memory: their newlines, the
    /// stream's head and the head of the cursor's unread range.
    fn keep_dropped(&mut self, len: usize) {
        let (from, dropped) = (self.base, &self.buf[..len]);
        keep_head(&mut self.first, 0, from, dropped);
        let offset = self.cursor.offset;
        if offset < from + len as u64 {
            let before = self.dropped_lines;
            let kept = self.cursor.dropped.get_or_insert_with(|| Dropped {
                lines_before: before + count_newlines(&dropped[..offset.saturating_sub(from) as usize]),
                head: Vec::new(),
            });
            keep_head(&mut kept.head, offset, from, dropped);
        }
        self.dropped_lines += count_newlines(dropped);
    }

    fn slice(&self, from: u64, to: u64) -> &[u8] {
        let from = from.max(self.base);
        let to = to.max(from);
        &self.buf[(from - self.base) as usize..(to - self.base) as usize]
    }

    /// Newlines before `at`, which memory holds.
    fn lines_before(&self, at: u64) -> usize {
        self.dropped_lines + count_newlines(self.slice(self.base, at))
    }

    /// Up to `EDGE_READ_BYTES` from `start`; those memory dropped are what `dropped` kept of them.
    fn head(&self, start: u64, dropped: Option<&Dropped>) -> Vec<u8> {
        let end = start + EDGE_READ_BYTES as u64;
        match dropped {
            Some(kept) if start < self.base => [kept.head.as_slice(), self.slice(self.base, end)].concat(),
            _ => self.slice(start, end).to_vec(),
        }
    }

    /// Newlines in `[start, end)` (`countNewlinesInRange`); those before `base` are counted from what `dropped` kept.
    fn newlines(&self, start: u64, end: u64, dropped: Option<&Dropped>) -> usize {
        match dropped {
            Some(kept) if start < self.base => {
                self.dropped_lines.saturating_sub(kept.lines_before) + count_newlines(self.slice(self.base, end))
            }
            _ => count_newlines(self.slice(start, end)),
        }
    }

    /// The stream's encoding as `sniffer` decides it on the window (`FileEncodingSniffer.probe`).
    fn probe(&self, sniffer: &mut Sniffer, final_: bool) -> Option<Label> {
        match &self.window {
            Some((at, window)) => sniffer.probe(window, *at, final_),
            None => sniffer.probe(&[], self.end(), final_),
        }
    }
}

struct JobState {
    stdout: Stream,
    stderr: Stream,
    exit: Option<ProcessExit>,
    finished: bool,
    finished_ms: Option<u64>,
    /// The tool call returned while the process kept running.
    detached: bool,
    /// The unseen output at completion, returned once by the next read.
    completion_output: Option<String>,
    acknowledged: bool,
    /// A survivors task ended by `task cancel` (its registry state; the processes may still run, see `confirmed`).
    cancelled: bool,
    /// A survivors task whose observer returned its result (`run` resolved): only a natural end has one.
    survivor_result: bool,
    /// The survivors are confirmed gone (by the observer or by a kill's re-observation).
    confirmed: bool,
    /// When the command moved to the background; the task row starts there.
    promoted_ms: Option<u64>,
    /// When the process last wrote to stdout or stderr.
    last_output_ms: Option<u64>,
    /// The owner's user cycle when the command moved to the background (`stampShellJobCycle`).
    user_cycle: Option<u64>,
    /// The command wrote past [`OUTPUT_DISK_CAP`] and was killed for it.
    output_capped: bool,
}

impl JobState {
    fn new(oem: Option<Label>) -> Self {
        Self {
            stdout: Stream::new(oem),
            stderr: Stream::new(oem),
            exit: None,
            finished: false,
            finished_ms: None,
            detached: false,
            completion_output: None,
            acknowledged: false,
            cancelled: false,
            survivor_result: false,
            confirmed: false,
            promoted_ms: None,
            last_output_ms: None,
            user_cycle: None,
            output_capped: false,
        }
    }
}

pub struct Job {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub owner: ThreadId,
    pub handle: ProcessHandle,
    /// The job's own process (`record.pid` of `shell-job-records.mjs`; 0 for a job with none: survivors, a recovered record
    /// naming none), which the restart reconcile asks the operating system about.
    pub pid: u32,
    pub started_ms: u64,
    /// The run limit (0: none), to say how much of it was left when the task was promoted.
    pub time_limit_ms: u64,
    /// The turn review of the call that started the task: its end happens outside any call
    /// context but is still a boundary for the folder it ran in.
    pub review: Option<Arc<dyn TurnReviewApi>>,
    pub stdout_log: PathBuf,
    pub stderr_log: PathBuf,
    /// The writer of the two logs (none for a survivors task), read for what they lack.
    logs: Option<spill::LogWriter>,
    /// Waits that ran to their ceiling, so a repeated one can suggest a different move.
    pub wait_hits: AtomicU32,
    /// A task tracking the survivors of a finished command: it has no process of its own, no
    /// logs, and ends when the last survivor exits.
    pub survivors: bool,
    /// The launching call's completion hook (a worker turn's own queue), tried before the owner's
    /// default delivery.
    pub notify: Option<ToolNotify>,
    /// A job a runtime that is gone ran, read back from its ownership record (`recovered: true`): how the record says
    /// it ended.
    recovered: Option<ExitFacts>,
    state: Mutex<JobState>,
    settled: watch::Sender<bool>,
}

/// `shellCompletionInstruction` (`taskCompletionSummary` of the shell surface): the completion's
/// one-line statement, `Shell task <outcome> (exit <code|n/a>)`.
pub(super) fn completion_instruction(status: &str, exit_code: Option<i32>) -> String {
    let outcome = if status == "cancelled" { "was cancelled" } else { status };
    format!("Shell task {outcome} (exit {})", exit_code.map_or("n/a".to_owned(), |c| c.to_string()))
}

/// `normalizeOutputPath`: paths are shown with forward slashes.
pub fn shown_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn iso(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(i64::try_from(ms).unwrap_or(i64::MAX))
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// The label every task carries: the command with whitespace collapsed, at most 120 characters.
pub fn label_of(command: &str) -> String {
    mixdog_js::slice_utf16(&mixdog_js::js_words(command).collect::<Vec<_>>().join(" "), 120)
}

fn escape_field(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// How the task view and the cursors see one read.
#[derive(Clone, Default)]
pub struct ReadOptions {
    /// `output: "tail"`: a replay that never moves the cursors.
    pub tail: bool,
    pub terminal: bool,
    /// Prefix the progress digest of a job reported while still running.
    pub digest: bool,
    /// The silence warning of a job reported while still running (`Job::silence_note`).
    pub hung: Option<String>,
}

struct Range {
    piece: Piece,
    bytes: usize,
    lines: usize,
    text: String,
}

fn pending_ansi_start(value: &str) -> Option<usize> {
    for (at, c) in value.char_indices() {
        if c != '\u{1b}' {
            continue;
        }
        let rest = &value[at + 1..];
        let pending = if rest.is_empty() {
            true
        } else if let Some(body) = rest.strip_prefix('[') {
            let mut chars = body.chars().peekable();
            while chars.next_if(|c| ('0'..='?').contains(c)).is_some() {}
            while chars.next_if(|c| (' '..='/').contains(c)).is_some() {}
            chars.peek().is_none()
        } else if let Some(body) = rest.strip_prefix(']') {
            let chars: Vec<char> = body.chars().collect();
            let mut ok = true;
            for (i, c) in chars.iter().enumerate() {
                if *c == '\u{7}' || *c == '\u{9c}' || (*c == '\u{1b}' && chars.get(i + 1) == Some(&'\\')) {
                    ok = false;
                    break;
                }
            }
            ok
        } else {
            false
        };
        if pending {
            return Some(at);
        }
    }
    None
}

fn pending_ansi_introducer(sequence: &str) -> &'static str {
    if sequence.starts_with("\u{1b}]") {
        if sequence.ends_with('\u{1b}') { "\u{1b}]\u{1b}" } else { "\u{1b}]" }
    } else if sequence.starts_with("\u{1b}[") {
        "\u{1b}["
    } else {
        "\u{1b}"
    }
}

fn visible_text(cursor: &mut Cursor, text: &str) -> String {
    let value = format!("{}{text}", cursor.ansi);
    cursor.ansi.clear();
    match pending_ansi_start(&value) {
        None => strip_ansi(&value),
        Some(at) => {
            cursor.ansi = pending_ansi_introducer(&value[at..]).to_owned();
            strip_ansi(&value[..at])
        }
    }
}

fn decode_visible(cursor: &mut Cursor, bytes: &[u8], flush: bool) -> String {
    let mut text = cursor.decoder.write(bytes);
    if flush {
        text.push_str(&cursor.decoder.end());
    }
    let visible = visible_text(cursor, &text);
    prepare_shell_text(&visible, &mut cursor.fold)
}

fn aligned(stream: &Stream, at: u64, label: Option<Label>) -> u64 {
    aligned_offset(&stream.buf, stream.base, at, label.unwrap_or("utf-8"))
}

/// `readRange`: `[start, end)` of `stream`, read with `cursor`. Of a range that starts before memory's `base`, the head
/// and the newlines before `base` come from what the cursor kept as memory dropped them.
fn read_range(
    stream: &Stream,
    cursor: &mut Cursor,
    start: u64,
    end: u64,
    flush: bool,
    label: Option<Label>,
    path: &str,
) -> Range {
    let total = (end - start) as usize;
    if total <= FULL_READ_BYTES {
        let text = decode_visible(cursor, stream.slice(start, end), flush);
        return Range { piece: text_piece(&text, path), bytes: total, lines: count_newlines(&text), text };
    }
    let head_bytes = stream.head(start, cursor.dropped.as_ref());
    let head_text = decode_visible(cursor, &head_bytes, false);
    let tail_start = aligned(stream, end - EDGE_READ_BYTES as u64, label);
    cursor.decoder = ShellStreamDecoder::new(stream.oem, label);
    cursor.ansi.clear();
    cursor.fold = CarriageReturnFolder::default();
    let tail_text = decode_visible(cursor, stream.slice(tail_start, end), flush);
    let lines = stream.newlines(start, end, cursor.dropped.as_ref());
    Range {
        piece: edges_piece(&head_text, &tail_text, total, lines, path),
        bytes: total,
        lines,
        text: tail_text,
    }
}

static PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d{1,3}(?:\.\d+)?)\s?%").expect("static pattern"));
static ETA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:ETA|eta|remaining|left)\b[:=\s]*(\d+(?::\d{2}){1,2}|\d+(?:\.\d+)?\s?(?:h|m|s|min|sec)\b)")
        .expect("static pattern")
});

/// `MIXDOG_SHELL_OUTPUT_SILENCE_WARN_MS` (`resolveTimeoutMs`: a positive number, at least 1 s),
/// else the agent stall budget `STALL_TIMEOUT_S` (default 600 s).
pub fn silence_warn_ms() -> f64 {
    static WARN: LazyLock<f64> = LazyLock::new(|| {
        let abort_s = std::env::var("STALL_TIMEOUT_S")
            .ok()
            .and_then(|raw| super::delivery::parse_int_prefix(&raw))
            .filter(|n| *n > 0)
            .unwrap_or(600);
        let fallback = (abort_s as f64 * 1000.0).max(1_000.0);
        std::env::var("MIXDOG_SHELL_OUTPUT_SILENCE_WARN_MS")
            .ok()
            .filter(|raw| !raw.is_empty())
            .map(|raw| mixdog_js::string_to_number(&raw))
            .filter(|n| n.is_finite() && *n > 0.0)
            .map_or(fallback, |n| n.max(1_000.0))
    });
    *WARN
}

/// `formatDuration(ms, { mostSignificantOnly: true })`.
pub fn most_significant_duration(ms: u64) -> String {
    if ms < 1_000 {
        return String::new();
    }
    if ms < 60_000 {
        return format!("{}s", ms / 1000);
    }
    let (days, hours, minutes) = (ms / 86_400_000, (ms % 86_400_000) / 3_600_000, (ms % 3_600_000) / 60_000);
    if days > 0 {
        format!("{days}d")
    } else if hours > 0 {
        format!("{hours}h")
    } else {
        format!("{minutes}m")
    }
}

/// One waited task's silence (`{ taskId, silentMs, hung }`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaitedSilence {
    pub task_id: String,
    pub silent_ms: u64,
    pub hung: bool,
}

/// `waitedJobSilence`'s pick: the longest silence, the first of equals (Node compares with `>`), `hung` at the warn threshold.
pub fn quietest(silences: impl IntoIterator<Item = (String, u64)>, warn_ms: f64) -> Option<WaitedSilence> {
    let mut worst: Option<WaitedSilence> = None;
    for (task_id, silent_ms) in silences {
        if worst.as_ref().is_none_or(|w| silent_ms > w.silent_ms) {
            worst = Some(WaitedSilence { task_id, silent_ms, hung: silent_ms as f64 >= warn_ms });
        }
    }
    worst
}

/// `describeShellOutputSilence`: the warning for a silence at or past the threshold.
pub fn describe_silence(silent_ms: u64) -> Option<String> {
    (silent_ms as f64 >= silence_warn_ms()).then(|| {
        format!("no output for {} — may be hung; inspect or cancel", most_significant_duration(silent_ms))
    })
}

fn progress_digest(growth: &[Range], hung: Option<&str>) -> String {
    let bytes: usize = growth.iter().map(|g| g.bytes).sum();
    let lines: usize = growth.iter().map(|g| g.lines).sum();
    let text = growth.iter().map(|g| g.text.as_str()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
    let mut parts = Vec::new();
    if bytes > 0 {
        parts.push(format!("+{}, +{lines} lines since you last saw it", format_kb(bytes as u64)));
    } else if hung.is_none() {
        parts.push("no new output since you last saw it".to_owned());
    }
    if let Some(last) = text.split('\n').rev().find(|l| !mixdog_js::js_trim(l).is_empty()) {
        let shown = mixdog_js::slice_utf16(mixdog_js::js_trim(last), 200);
        parts.push(format!(
            "last line: {}",
            serde_json::to_string(&shown).unwrap_or_default()
        ));
    }
    if let Some(m) = PERCENT.captures_iter(&text).last() {
        if m[1].parse::<f64>().is_ok_and(|n| n <= 100.0) {
            parts.push(format!("{}%", &m[1]));
        }
    }
    if let Some(m) = ETA.captures_iter(&text).last() {
        parts.push(format!("ETA {}", mixdog_js::js_trim(&m[1])));
    }
    // A job quiet past the threshold is no longer reassured as "not an error".
    if let Some(hung) = hung {
        parts.push(hung.to_owned());
        return format!("[progress] {}", parts.join(" · "));
    }
    format!("[progress] {} — still running, not an error", parts.join(" · "))
}

impl Job {
    /// What the logs lack: a log whose write failed or stalled holds the output only up to the
    /// byte named, though the result points at it for the rest. `None` while both are whole.
    pub fn log_note(&self) -> Option<String> {
        let gaps = self.logs.as_ref()?.gaps();
        let lines: Vec<String> = [("stdout", gaps[0]), ("stderr", gaps[1])]
            .into_iter()
            .filter_map(|(name, gap)| {
                gap.map(|at| format!("[log incomplete] the {name} log lacks this command's output from byte {at} on: a write to it failed or stalled"))
            })
            .collect();
        (!lines.is_empty()).then(|| lines.join("\n"))
    }

    fn state(&self) -> MutexGuard<'_, JobState> {
        lock(&self.state)
    }

    pub fn status(&self) -> JobStatus {
        self.status_locked(&self.state())
    }

    /// How the job ended: its process's exit, or what the record of a recovered job says.
    fn end_of(&self, state: &JobState) -> Option<ExitFacts> {
        match &self.recovered {
            Some(end) => Some(end.clone()),
            None => state.exit.as_ref().map(|exit| self.facts_of(state, exit)),
        }
    }

    pub fn is_running(&self) -> bool {
        !self.state().finished
    }

    /// A survivors task cancelled whose processes are not yet confirmed gone: it keeps being terminated.
    pub(crate) fn termination_pending(&self) -> bool {
        let state = self.state();
        self.survivors && state.finished && state.cancelled && !state.confirmed
    }

    /// The result body of a survivors task read: it owns no output (its command's was delivered with the call, and its logs are not
    /// reopened). Node renders a body whenever a result object exists, and only a natural end has one (`readShellTaskOutput` with no
    /// log paths: `(no new output)`, `(no output)` for an explicit tail).
    pub(crate) fn survivor_body(&self, tail: bool) -> String {
        if !self.state().survivor_result {
            return String::new();
        }
        if tail { "(no output)" } else { "(no new output)" }.to_owned()
    }

    pub fn exit(&self) -> Option<ProcessExit> {
        self.state().exit
    }

    pub async fn settled(&self) {
        let mut rx = self.settled.subscribe();
        // The sender lives in `self`, so the wait ends only on the value.
        let _ = rx.wait_for(|done| *done).await;
    }

    /// Hands the running job to the background, stamped with the owner's current user `cycle`.
    /// `false` when it has already finished.
    pub fn detach(&self, now_ms: u64, cycle: u64) -> bool {
        {
            let mut state = self.state();
            if state.finished {
                return false;
            }
            state.detached = true;
            state.promoted_ms = Some(now_ms);
            state.user_cycle = Some(cycle);
        }
        // `publishShellJobRecord`: the record names the background task and its owner, so a runtime that does not hold the
        // job (after a restart) answers for it.
        if let Some(logs) = &self.logs {
            let mut fields = serde_json::Map::new();
            fields.insert("background".into(), true.into());
            fields.insert("ownerSessionId".into(), self.owner.as_str().into());
            fields.insert("command".into(), self.command.clone().into());
            fields.insert("cwd".into(), self.cwd.clone().into());
            fields.insert("pid".into(), self.pid.into());
            fields.insert("startedAtMs".into(), now_ms.into());
            logs.describe(fields);
        }
        true
    }

    /// Whether this job is a running background task that counts for `hasActiveBackgroundTasks`
    /// on the shell surface: it moved to the background (a foreground command is no task) or
    /// tracks a finished command's survivors. `awaited_only` leaves out the survivors (Node's
    /// `detached` tasks); `user_cycle` keeps only a task stamped with that cycle.
    fn counts_as_active(&self, awaited_only: bool, user_cycle: Option<u64>) -> bool {
        let state = self.state();
        (state.promoted_ms.is_some() || self.survivors)
            && !state.finished
            && !(awaited_only && self.survivors)
            && user_cycle.is_none_or(|cycle| state.user_cycle == Some(cycle))
    }

    /// The task started when it moved to the background, not when the process did.
    fn shown_started(&self, state: &JobState) -> u64 {
        state.promoted_ms.unwrap_or(self.started_ms)
    }

    /// `exit_facts`, with the cause of a time-limit kill saying how much of the limit was left at
    /// promotion (`timed out after 985 ms`).
    fn facts_of(&self, state: &JobState, exit: &ProcessExit) -> ExitFacts {
        let mut facts = exit_facts(exit);
        if let (true, Some(promoted)) = (facts.timed_out && self.time_limit_ms > 0, state.promoted_ms) {
            let left = self.time_limit_ms.saturating_sub(promoted.saturating_sub(self.started_ms));
            facts.error = Some(format!("timed out after {left} ms"));
        }
        if state.output_capped {
            facts.mark_output_capped();
        }
        facts
    }

    /// The capture of both streams that memory holds as text, for a foreground result: the whole of each stream unless
    /// memory dropped its start (see `spilled_pieces`).
    pub fn captured(&self) -> (String, String) {
        let state = self.state();
        let all = |s: &Stream| decode_shell_bytes(&s.buf, s.oem);
        (all(&state.stdout), all(&state.stderr))
    }

    /// Whether memory dropped the start of either stream: `captured` then holds only the end of it, and only the log the
    /// whole.
    pub fn spilled(&self) -> bool {
        let state = self.state();
        state.stdout.base > 0 || state.stderr.base > 0
    }

    /// The bytes both streams produced, those memory dropped included.
    pub fn captured_bytes(&self) -> usize {
        let state = self.state();
        (state.stdout.end() + state.stderr.end()) as usize
    }

    /// Both streams whole, read from their logs, for a capture whose start memory dropped (Node reads a spilled capture
    /// back from disk). `None` when a log lacks output or is not as long as its stream.
    pub async fn captured_from_logs(&self, lane: InteractiveIo, cancel: &CancellationToken) -> Option<(String, String)> {
        if self.log_note().is_some() {
            return None;
        }
        let (ends, oems) = {
            let state = self.state();
            ([state.stdout.end(), state.stderr.end()], [state.stdout.oem, state.stderr.oem])
        };
        let logs = spill::read_log_tails(lane, cancel, [self.stdout_log.clone(), self.stderr_log.clone()], usize::MAX).await;
        let whole = |index: usize| (logs[index].0 == 0 && logs[index].1.len() as u64 == ends[index]).then(|| decode_shell_bytes(&logs[index].1, oems[index]));
        Some((whole(0)?, whole(1)?))
    }

    /// Each stream whose start memory dropped, in the delivery shape of a foreground capture that spilled to its log
    /// (`shellLogPiece`): the whole stream read with a fresh cursor. `None` for a stream memory holds whole.
    pub fn spilled_pieces(&self) -> [Option<Piece>; 2] {
        let state = self.state();
        [(&state.stdout, &self.stdout_log), (&state.stderr, &self.stderr_log)].map(|(stream, log)| {
            (stream.base > 0).then(|| {
                let mut cursor = Cursor {
                    dropped: Some(Dropped { lines_before: 0, head: stream.first.clone() }),
                    ..Cursor::new(stream.oem)
                };
                let label = stream.probe(&mut cursor.sniffer, true);
                if let Some(label) = label {
                    cursor.decoder.force(label);
                }
                read_range(stream, &mut cursor, 0, stream.end(), true, label, &shown_path(log)).piece
            })
        })
    }

    /// Output not yet delivered, in the shared delivery shape (`readShellTaskOutput`). Moves the
    /// cursors unless `tail` replays.
    pub fn read_output(&self, options: ReadOptions) -> String {
        let mut state = self.state();
        let replay = options.tail;
        let mut growth = Vec::new();
        let mut sections: Vec<(String, Piece)> = Vec::new();
        let state = &mut *state;
        for (name, stream, log) in [
            ("stdout", &mut state.stdout, &self.stdout_log),
            ("stderr", &mut state.stderr, &self.stderr_log),
        ] {
            let path = shown_path(log);
            // A replay reads with a fresh cursor and leaves the stream's own where it was (Node's `readShellTaskOutput`
            // replays with a fresh map). Otherwise the stream's cursor is taken out for the read, which reads the stream
            // beside it, and put back moved.
            let mut cursor = if replay {
                Cursor::new(stream.oem)
            } else {
                std::mem::replace(&mut stream.cursor, Cursor::new(stream.oem))
            };
            let size = stream.end();
            // The encoding is decided once, firmly (or when the task is terminal); until then
            // only the ASCII prefix is read.
            let label = stream.probe(&mut cursor.sniffer, options.terminal);
            if let Some(label) = label {
                if !cursor.committed {
                    cursor.committed = true;
                    cursor.decoder.force(label);
                }
            }
            let read_end = if label.is_some() { size } else { cursor.sniffer.safe_end(size) };
            let mut start = cursor.offset;
            let mut earlier = String::new();
            if replay && read_end - start > FULL_READ_BYTES as u64 {
                start = aligned(stream, read_end - FULL_READ_BYTES as u64, label).min(read_end);
                earlier = omission_marker(&Omitted { lines: stream.lines_before(start), bytes: start as usize, path: &path });
                cursor.decoder = ShellStreamDecoder::new(stream.oem, label);
            }
            let flush = options.terminal && read_end == size;
            let mut range = read_range(stream, &mut cursor, start, read_end, flush, label, &path);
            // A read puts the stream's cursor back at `read_end`, which memory holds (an undecided encoding stops it within
            // its window), so nothing dropped is kept for it. A replay's cursor is dropped.
            if !replay {
                cursor.offset = read_end;
                cursor.dropped = None;
                stream.cursor = cursor;
            }
            let piece = std::mem::replace(&mut range.piece, Piece::empty());
            if !piece.is_empty() {
                let prefix = format!("[{name}]\n{}", if earlier.is_empty() { String::new() } else { format!("{earlier}\n") });
                sections.push((prefix, piece));
            }
            growth.push(range);
        }
        let fixed: usize = sections.iter().map(|(p, _)| mixdog_js::utf16_len(p)).sum::<usize>()
            + 2 * sections.len().saturating_sub(1);
        let (prefixes, pieces): (Vec<String>, Vec<Piece>) = sections.into_iter().unzip();
        let bodies = fit_pieces(&pieces, delivery_full_chars() - fixed as f64);
        let body = if prefixes.is_empty() {
            if replay { "(no output)" } else { "(no new output)" }.to_owned()
        } else {
            prefixes.iter().zip(bodies).map(|(prefix, body)| format!("{prefix}{body}")).collect::<Vec<_>>().join("\n\n")
        };
        escape_harness_tags(&if options.digest {
            format!("{}\n\n{body}", progress_digest(&growth, options.hung.as_deref()))
        } else {
            body
        })
    }

    pub fn acknowledged(&self) -> bool {
        self.state().acknowledged
    }

    pub fn acknowledge(&self) {
        self.state().acknowledged = true;
    }

    /// The remainder a finished job's completion notice carries, once.
    pub fn pending_completion_output(&self) -> Option<String> {
        let state = self.state();
        if state.finished && !state.acknowledged { state.completion_output.clone() } else { None }
    }

    /// `renderBackgroundTask`. `owner_tool`: the shell's own start notice; `result`: a task read.
    /// How long a running job has been silent, as a warning once past the threshold
    /// (`shellTaskSilenceNote`): derived on read from the last output, never fired by a timer.
    pub fn silence_note(&self, now_ms: u64) -> Option<String> {
        let state = self.state();
        if state.finished {
            return None;
        }
        describe_silence(self.silent_ms(&state, now_ms))
    }

    /// Milliseconds since the task last wrote output, floored at when it became a task.
    fn silent_ms(&self, state: &JobState, now_ms: u64) -> u64 {
        let since = state.last_output_ms.unwrap_or(0).max(self.shown_started(state));
        now_ms.saturating_sub(since)
    }

    pub fn render(&self, owner_tool: bool, body: Option<&str>) -> String {
        self.render_with(owner_tool, body, None)
    }

    /// `render`, with the silence warning of a running task read (`output_silence:`).
    pub fn render_with(&self, owner_tool: bool, body: Option<&str>, silence: Option<&str>) -> String {
        let (status, facts, finished_ms) = {
            let state = self.state();
            (self.status_locked(&state), self.end_of(&state), state.finished_ms)
        };
        let include_result = body.is_some();
        let mut lines = vec!["background task".to_owned(), format!("task_id: {}", self.id)];
        if !owner_tool {
            lines.push("surface: shell".into());
        }
        if !include_result {
            lines.push(format!("label: {}", label_of(&self.command)));
        }
        lines.push(format!("status: {}", status.as_str()));
        if let Some(facts) = &facts {
            if let Some(code) = facts.exit_code {
                lines.push(format!("exit_code: {code}"));
            }
            if facts.timed_out {
                lines.push("timed_out: true".into());
            }
            if let Some(signal) = &facts.signal {
                lines.push(format!("signal: {signal}"));
            }
        }
        lines.push(format!("started: {}", iso(self.shown_started(&self.state()))));
        if let Some(ms) = finished_ms {
            lines.push(format!("finished: {}", iso(ms)));
        }
        if let Some(error) = facts.as_ref().and_then(|f| f.error.as_ref()) {
            lines.push(format!("error: {error}"));
        } else if self.survivors && self.state().cancelled {
            // A survivors task has no exit of its own; Node's `cancelBackgroundTask(taskId, 'cancelled by task control')` is its error.
            lines.push("error: cancelled by task control".into());
        }
        if let Some(silence) = silence {
            lines.push(format!("output_silence: {silence}"));
        }
        if self.recovered.is_some() {
            lines.push("recovered: true".into());
        }
        if !self.survivors {
            lines.push(self.logs_line());
            lines.extend(self.log_note());
        }
        if let Some(body) = body {
            if !body.is_empty() {
                lines.push(String::new());
                lines.push(body.to_owned());
            } else if status == JobStatus::Completed {
                lines.push(String::new());
                lines.push("(no result body — use read for full output)".into());
            }
        }
        lines.join("\n")
    }

    fn status_locked(&self, state: &JobState) -> JobStatus {
        match (self.end_of(state), state.finished) {
            (Some(end), true) => end.status,
            (None, true) if self.survivors && state.cancelled => JobStatus::Cancelled,
            (None, true) if self.survivors => JobStatus::Completed,
            (None, true) => JobStatus::Failed,
            _ => JobStatus::Running,
        }
    }

    /// The two log paths collapsed to one line when they differ only by the stream name.
    fn logs_line(&self) -> String {
        let (out, err) = (shown_path(&self.stdout_log), shown_path(&self.stderr_log));
        match (out.strip_suffix(".stdout.log"), err.strip_suffix(".stderr.log")) {
            (Some(a), Some(b)) if a == b => format!("logs: {a}.{{stdout,stderr}}.log"),
            _ => format!("stdout: {out}\nstderr: {err}"),
        }
    }

    /// A detached job's end (`notifyToolCompletion`): the launching call's hook first, and only a
    /// declined delivery (`false`) falls back to the owner's notifier. The meta is the completion's
    /// identity the receiver files it under.
    async fn report_finished(&self, notifier: Option<&dyn TaskNotifier>, status: &str, notification: String) {
        if let Some(notify) = &self.notify {
            let exit_code = {
                let state = self.state();
                state.exit.and_then(|exit| self.facts_of(&state, &exit).exit_code)
            };
            let meta = serde_json::json!({
                "type": "shell_task_result",
                "execution_surface": "shell",
                "execution_id": self.id,
                "status": status,
                "instruction": completion_instruction(status, exit_code),
                "caller_session_id": self.owner.as_str(),
            });
            if notify.deliver(&notification, &meta) {
                return;
            }
        }
        if let Some(notifier) = notifier {
            notifier.finished(&self.owner, "shell", &self.id, status, notification).await;
        }
    }

    /// `renderShellCompletionNotice` for the survivors task that ended on its own.
    fn survivors_notification(&self) -> String {
        let flat = mixdog_js::js_words(&self.command).collect::<Vec<_>>().join(" ");
        let command = if mixdog_js::utf16_len(&flat) > 160 {
            format!("{}…", flat.chars().take(160).collect::<String>())
        } else {
            flat
        };
        let tail = if command.is_empty() { String::new() } else { format!(": {command}") };
        [
            "<task-notification>".to_owned(),
            format!("<task-id>{}</task-id>", escape_field(&self.id)),
            "<status>completed</status>".to_owned(),
            format!("<summary>{}</summary>", escape_field(&format!("{}{tail}", completion_instruction("completed", None)))),
            format!(
                "<result>\nRetrieve output with task read (task_id: {}) only if it has not already been received.\n</result>",
                self.id
            ),
            "</task-notification>".to_owned(),
        ]
        .join("\n")
    }

    /// The completion notification pushed to the owner (`renderShellCompletionEnvelope`).
    fn notification(&self, output: &str) -> String {
        let state = self.state();
        let Some(facts) = self.end_of(&state) else { return String::new() };
        let duration = state
            .finished_ms
            .map(|f| format_duration(f.saturating_sub(self.shown_started(&state))));
        let head = [
            facts.exit_code.map(|c| format!("exit code: {c}")),
            duration.map(|d| format!("duration: {d}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ");
        let result = [head.as_str(), output].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        let status = facts.status.as_str();
        let outcome = if facts.status == JobStatus::Cancelled { "was cancelled" } else { status };
        let detail = format!("exit {}", facts.exit_code.map_or("n/a".to_owned(), |c| c.to_string()));
        let flat = mixdog_js::js_words(&self.command).collect::<Vec<_>>().join(" ");
        let command = if mixdog_js::utf16_len(&flat) > 160 {
            format!("{}…", flat.chars().take(160).collect::<String>())
        } else {
            flat
        };
        let summary = format!(
            "Shell task {outcome} ({detail}){}",
            if command.is_empty() { String::new() } else { format!(": {command}") }
        );
        let mut out = vec![
            "<task-notification>".to_owned(),
            format!("<task-id>{}</task-id>", escape_field(&self.id)),
            format!("<status>{status}</status>"),
        ];
        if let Some(code) = facts.exit_code {
            out.push(format!("<exit-code>{code}</exit-code>"));
        }
        out.push(format!("<summary>{}</summary>", escape_field(&summary)));
        out.push(format!("<output-file>{}</output-file>", escape_field(&shown_path(&self.stdout_log))));
        if let Some(note) = self.log_note() {
            out.push(escape_field(&note));
        }
        if !result.is_empty() {
            out.push(format!("<result>\n{result}\n</result>"));
        }
        if let (JobStatus::Failed, Some(error)) = (facts.status, &facts.error) {
            out.push(format!("<error>{}</error>", escape_field(error)));
        }
        out.push("</task-notification>".into());
        out.join("\n")
    }
}

/// Node's `TERMINATION_RECHECK_MS` (`lib/shell-descendants.mjs`): the cadence of every termination re-check.
const TERMINATION_RECHECK: Duration = Duration::from_millis(5_000);

/// The error of a background job a runtime that is gone left running (`reconcileRecoveredShellJobCompletions`).
const OUTCOME_LOST: &str =
    "daemon restarted while this shell task was running; its outcome was lost. Re-run the command if the result is still needed.";

/// A job's ownership record, as a runtime that does not hold the job reads it (`readShellJobRecord`).
pub(crate) struct KeptJob {
    pub(crate) id: String,
    record: serde_json::Map<String, serde_json::Value>,
}

impl KeptJob {
    fn text(&self, key: &str) -> String {
        self.record.get(key).and_then(serde_json::Value::as_str).unwrap_or_default().to_owned()
    }

    fn number(&self, key: &str) -> Option<u64> {
        self.record.get(key).and_then(serde_json::Value::as_u64)
    }

    pub(crate) fn command(&self) -> String {
        self.text("command")
    }

    /// How the job ended; `None` while the record says it runs.
    pub(crate) fn end(&self) -> Option<ExitFacts> {
        ExitFacts::of_record(&self.record)
    }

    /// A background job's record that says the job runs: neither ended nor marked finished.
    fn left_running(&self) -> bool {
        self.background() && self.end().is_none() && self.record.get("state").and_then(serde_json::Value::as_str) == Some("running")
    }

    fn background(&self) -> bool {
        self.record.get("background").and_then(serde_json::Value::as_bool) == Some(true)
    }

    /// The process that wrote the record (`clientHostPid`).
    fn writer(&self) -> u32 {
        self.number("clientHostPid").and_then(|pid| u32::try_from(pid).ok()).unwrap_or(0)
    }

    /// The job's own process (`record.pid`): 0 when the record names none.
    fn job_pid(&self) -> u32 {
        self.number("pid").and_then(|pid| u32::try_from(pid).ok()).unwrap_or(0)
    }

    /// `recoveredTaskMatches` and the terminal record's life (`COMPLETED_SHELL_JOB_TTL_MS`): the record answers for a
    /// background job of `owner` that ended less than a finished job's retention ago, or that another process left
    /// running (one this process still writes is a job it runs).
    fn answers_for(&self, owner: &ThreadId, now_ms: u64) -> bool {
        let fresh = match self.end() {
            Some(_) => self.number("finishedAtMs").is_some_and(|at| now_ms.saturating_sub(at) < RETENTION_MS),
            None => self.writer() != std::process::id(),
        };
        self.background() && self.text("ownerSessionId") == owner.as_str() && fresh
    }
}

/// The jobs of one runtime.
pub struct ExecRuntime {
    pub(crate) config: ExecConfig,
    pub(crate) snapshots: super::snapshot::Snapshots,
    /// The skill launchers' directory and contents, made once.
    pub(crate) launchers: spill::KeptLaunchers,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    cycles: OnceLock<Arc<dyn OwnerCycles>>,
    /// Owner thread -> the shells a timeout reap stopped, until the owner's handoff reports them
    /// or its next turn starts (`stoppedJobs`, `turn-reap.mjs`).
    reaped: Mutex<HashMap<String, Vec<String>>>,
    /// Whether the expired logs of the spill directory were swept.
    swept: std::sync::atomic::AtomicBool,
    /// That sweep while it runs, awaited at shutdown.
    sweep: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The hoisted scripts and tee captures a command still uses, removed when it settles or, for
    /// a tree that never settled, at shutdown (`PENDING_ARTIFACT_PATHS`, `transport-artifacts.mjs`).
    artifacts: Mutex<Vec<PathBuf>>,
    pub(crate) standby: Arc<super::standby::Standby>,
}

/// The owner's user cycle (`currentUserCycle`): how many genuine prompts the session has seen.
pub trait OwnerCycles: Send + Sync {
    fn current(&self, owner: &ThreadId) -> u64;
}

impl ExecConfig {
    /// A copy sharing every handle, for a test that varies one setting.
    #[cfg(test)]
    pub(crate) fn clone_for_test(&self) -> Self {
        self.clone()
    }
}

impl ExecRuntime {
    pub fn new(config: ExecConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            jobs: Mutex::new(HashMap::new()),
            snapshots: super::snapshot::Snapshots::default(),
            launchers: spill::KeptLaunchers::default(),
            cycles: OnceLock::new(),
            reaped: Mutex::new(HashMap::new()),
            swept: std::sync::atomic::AtomicBool::new(false),
            sweep: Mutex::new(None),
            artifacts: Mutex::new(Vec::new()),
            standby: Arc::default(),
        })
    }

    /// The parked PowerShell standby's handle, for tests.
    pub fn parked_standby(&self) -> Option<ProcessHandle> {
        self.standby.parked()
    }

    /// The parked PowerShell standby's handle once one is parked, for tests; the caller bounds the wait.
    pub async fn wait_parked_standby(&self) -> ProcessHandle {
        self.standby.wait_parked().await
    }

    /// Shutdown: ends the parked PowerShell standby, removes the shell snapshots this runtime made, and the hoisted
    /// scripts and tee captures of commands that never settled (Node's exit hooks), once the log sweep has ended.
    pub async fn drain_snapshots(&self, cancel: &CancellationToken) {
        self.standby.end();
        let sweep = lock(&self.sweep).take();
        if let Some(sweep) = sweep {
            let _ = sweep.await;
        }
        self.snapshots.drain(self.config.lanes.maintenance, cancel).await;
        let pending = std::mem::take(&mut *lock(&self.artifacts));
        for path in pending {
            spill::remove_file(self.config.lanes.durability, cancel, &path).await;
        }
    }

    /// `path` stays in use until `job` settles; then it is removed (`cleanupArtifactAfter`). One
    /// that cannot be removed then is removed at shutdown.
    pub(crate) fn remove_when_settled(self: &Arc<Self>, job: &Arc<Job>, path: PathBuf, cancel: CancellationToken) {
        lock(&self.artifacts).push(path.clone());
        let (runtime, settled) = (self.clone(), job.clone());
        mixdog_rt::spawn("shell-artifact-cleanup", TaskClass::Work, async move {
            settled.settled().await;
            if spill::remove_file(runtime.config.lanes.durability, &cancel, &path).await {
                lock(&runtime.artifacts).retain(|pending| pending != &path);
            }
        });
    }

    /// Remembers the shells a timeout reap of `owner` stopped.
    pub(crate) fn note_reaped(&self, owner: &ThreadId, ids: Vec<String>) {
        if !ids.is_empty() {
            lock(&self.reaped).entry(owner.as_str().to_owned()).or_default().extend(ids);
        }
    }

    /// Hands out and forgets the shells a reap of `owner` stopped.
    pub(crate) fn take_reaped(&self, owner: &ThreadId) -> Vec<String> {
        lock(&self.reaped).remove(owner.as_str()).unwrap_or_default()
    }

    /// Where a job moved to the background reads its owner's user cycle. Set once, before jobs
    /// run; without it every owner is on cycle 0 (a session that has seen no prompt).
    pub fn set_cycles(&self, cycles: Arc<dyn OwnerCycles>) {
        let _ = self.cycles.set(cycles);
    }

    /// The owner's current user cycle.
    pub fn cycle_of(&self, owner: &ThreadId) -> u64 {
        self.cycles.get().map_or(0, |cycles| cycles.current(owner))
    }

    /// `hasActiveBackgroundTasks({ callerSessionId: owner, surface: 'shell', awaitedOnly, match })`.
    pub fn has_active(&self, owner: &ThreadId, awaited_only: bool, user_cycle: Option<u64>) -> bool {
        lock(&self.jobs).values().any(|job| &job.owner == owner && job.counts_as_active(awaited_only, user_cycle))
    }

    /// `otherSessionBackgroundShellJobCount` and the foreground side of `otherSessionShellHolders` (`task-tool.mjs`): the running
    /// shell work of every owner but `owner`, as (foreground commands, background tasks). A task tracking the survivors of a finished
    /// command is not a shell job of its own and is left out. Counts only; another session's command is never named.
    pub fn other_owner_shell_work(&self, owner: &ThreadId) -> (usize, usize) {
        let table = lock(&self.jobs);
        let running = table.values().filter(|job| &job.owner != owner && !job.survivors && !job.state().finished);
        running.fold((0, 0), |(foreground, background), job| {
            if job.state().promoted_ms.is_some() { (foreground, background + 1) } else { (foreground + 1, background) }
        })
    }

    /// `activeBackgroundTaskSessionIds({ surface: 'shell', awaitedOnly: true })`: the owner of every running awaited task, from one pass over
    /// the runtime's table. Node's task registry is process-wide, so a session that is not loaded but owns an awaited job is listed too.
    pub fn awaited_owners(&self) -> HashSet<ThreadId> {
        lock(&self.jobs).values().filter(|job| job.counts_as_active(true, None)).map(|job| job.owner.clone()).collect()
    }

    /// `waitedJobSilence(taskIds, { now })`: the quietest of the running tasks among `ids` (a task of any owner, as Node's registry is
    /// process-wide), in `ids` order.
    pub fn waited_silence(&self, ids: &[String], now_ms: u64) -> Option<WaitedSilence> {
        let table = lock(&self.jobs);
        let silences = ids.iter().filter_map(|id| {
            let job = table.get(id)?;
            job.counts_as_active(false, None).then(|| (id.clone(), job.silent_ms(&job.state(), now_ms)))
        });
        quietest(silences, silence_warn_ms())
    }

    pub fn now_ms(&self) -> u64 {
        (self.config.now_ms)()
    }

    /// Spawns the process, or claims the parked `standby` taken for it, registers the task and starts the collector on a
    /// lane. A standby that cannot be claimed is ended, unfed, and the process spawned.
    pub async fn start(
        self: &Arc<Self>,
        processes: &Arc<dyn ProcessManager>,
        request: SpawnRequest,
        standby: Option<ProcessHandle>,
        task_id: String,
        command: String,
        owner: ThreadId,
        time_limit_ms: u64,
        review: Option<Arc<dyn TurnReviewApi>>,
        notify: Option<ToolNotify>,
    ) -> Result<Arc<Job>, ProcessError> {
        let handle = request.handle.clone();
        let cwd = request.cwd.as_path().to_string_lossy().into_owned();
        let [stdout_log, stderr_log] = spill::log_paths(&self.config.spill_dir, &task_id);
        let logs = spill::LogWriter::new(self.config.lanes.pty, &stdout_log, &stderr_log);
        // The expired logs of ended jobs go once per runtime, started with the first job (Node starts it as the first
        // command spills), beside the command and never on its path (`sweepExpiredShellOutput`, started unawaited);
        // shutdown waits for it. It cannot take a log being written: it goes by the ownership record, which the
        // job's writer creates as running before its logs.
        if !self.swept.swap(true, std::sync::atomic::Ordering::AcqRel) {
            let (lane, dir) = (self.config.lanes.maintenance, self.config.spill_dir.clone());
            let sweep = mixdog_rt::spawn("shell-log-sweep", TaskClass::Work, async move {
                spill::sweep_expired(lane, &CancellationToken::new(), &dir).await;
            });
            *lock(&self.sweep) = Some(sweep);
        }
        let claimed = standby.filter(|parked| {
            let claimed = processes.claim(parked, request.owner.clone(), request.time_limit).is_ok();
            if !claimed {
                let _ = processes.kill(parked);
            }
            claimed
        });
        // Subscribed as part of the spawn, before the child can write, so its output is taken from
        // the first byte however late this task runs (the subscriber holds the replay ring's
        // reader back). The job's writer creates the logs on its own io-pty thread (`collect`
        // opens it); output that comes first waits in the writer's queue. The call's only
        // io-spawn job is the spawn.
        let (handle, source, pid) = match claimed {
            Some(parked) => {
                let source = processes.subscribe(&parked, Some(0))?;
                let pid = processes.list().into_iter().find(|info| info.handle == parked).map_or(0, |info| info.pid);
                (parked, source, pid)
            }
            None => {
                let (spawned, source) = processes.spawn_subscribed(request).await?;
                (handle, source, spawned.pid)
            }
        };
        let (settled, _) = watch::channel(false);
        let started_ms = self.now_ms();
        let oem = self.config.oem;
        let job = Arc::new(Job {
            id: task_id.clone(),
            command: command.clone(),
            cwd: cwd.clone(),
            owner: owner.clone(),
            handle: handle.clone(),
            pid,
            started_ms,
            time_limit_ms,
            review,
            stdout_log,
            stderr_log,
            logs: Some(logs.clone()),
            wait_hits: AtomicU32::new(0),
            survivors: false,
            notify,
            recovered: None,
            state: Mutex::new(JobState::new(oem)),
            settled,
        });
        self.purge_expired(started_ms);
        lock(&self.jobs).insert(task_id.clone(), job.clone());
        let _ = self.config.tasks.start(TaskSpec {
            task_id,
            surface: "shell".into(),
            op: "shell".into(),
            command,
            cwd,
            owner: Some(owner.as_str().to_owned()),
            foreground: true,
            process: Some(handle),
            started_at_ms: started_ms,
        });
        mixdog_rt::spawn(
            "shell-collect",
            TaskClass::Work,
            collect(job.clone(), source, self.clone(), logs, processes.clone()),
        );
        Ok(job)
    }

    fn purge_expired(&self, now: u64) {
        lock(&self.jobs).retain(|_, job| {
            let state = job.state();
            !state.finished || state.finished_ms.is_none_or(|f| now.saturating_sub(f) < RETENTION_MS)
        });
    }

    pub fn get(&self, owner: &ThreadId, id: &str) -> Option<Arc<Job>> {
        lock(&self.jobs).get(id).filter(|j| &j.owner == owner).cloned()
    }

    /// Jobs of `owner` in start order.
    pub fn list(&self, owner: &ThreadId) -> Vec<Arc<Job>> {
        let mut rows: Vec<_> = lock(&self.jobs).values().filter(|j| &j.owner == owner).cloned().collect();
        rows.sort_by(|a, b| (a.started_ms, &a.id).cmp(&(b.started_ms, &b.id)));
        rows
    }

    /// A finished command left processes running: they become a tracked task under the same id,
    /// finishing when the last of them exits (`trackSurvivingDescendants`). `None` without an
    /// observer or survivors.
    pub fn track_survivors(self: &Arc<Self>, job: &Job) -> Option<(Arc<Job>, Survivors)> {
        let watch = self.config.survivors.clone()?;
        let survivors = watch.survivors(&job.handle)?;
        self.release(&job.id);
        let (settled, _) = watch::channel(false);
        let tracked = Arc::new(Job {
            id: job.id.clone(),
            command: job.command.clone(),
            cwd: job.cwd.clone(),
            owner: job.owner.clone(),
            handle: job.handle.clone(),
            pid: 0,
            // The command's own start: Node's `trackSurvivingDescendants` hands its `startedAtMs` to the task.
            started_ms: job.started_ms,
            time_limit_ms: 0,
            review: job.review.clone(),
            stdout_log: job.stdout_log.clone(),
            stderr_log: job.stderr_log.clone(),
            logs: None,
            wait_hits: AtomicU32::new(0),
            survivors: true,
            notify: job.notify.clone(),
            recovered: None,
            state: Mutex::new(JobState::new(self.config.oem)),
            settled,
        });
        tracked.state().detached = true;
        lock(&self.jobs).insert(tracked.id.clone(), tracked.clone());
        let _ = self.config.tasks.start(TaskSpec {
            task_id: tracked.id.clone(),
            surface: "shell".into(),
            op: "shell".into(),
            command: tracked.command.clone(),
            cwd: tracked.cwd.clone(),
            owner: Some(tracked.owner.as_str().to_owned()),
            foreground: false,
            process: Some(tracked.handle.clone()),
            started_at_ms: tracked.started_ms,
        });
        let (runtime, watched) = (self.clone(), tracked.clone());
        mixdog_rt::spawn("shell-survivors", TaskClass::Work, async move {
            // The passive observation (`waitForShellDescendants`): the survivors are checked now and re-checked every
            // `TERMINATION_RECHECK_MS`. A cancel whose kill could not confirm them gone keeps terminating on every pass
            // (`sweep: () => cancelled`) while the row is held.
            // Node's `run` passes no abort signal and ignores the boolean `waitForShellDescendants` answers, which is
            // `false` only for an abort: this watch raises none, so whichever way the wait ends, the task ends.
            let never = CancellationToken::new();
            loop {
                match mixdog_rt::time::timeout(TERMINATION_RECHECK, watch.wait_gone(&watched.handle, &never)).await {
                    Ok(_) => break,
                    Err(_) if watched.termination_pending() && watch.kill(&watched.handle).await => break,
                    Err(_) => {}
                }
            }
            runtime.finish_survivors(&watched).await;
        });
        Some((tracked, survivors))
    }

    /// A cancel of a survivors task, before anything is signalled: its intent is latched and the registry state turns terminal
    /// (`cancelBackgroundTask` flips the status ahead of the kill's outcome), with the row held until the processes are
    /// confirmed gone. An exit event that arrives later can no longer mark the task completed. `false` when the task is
    /// already terminal.
    pub(crate) fn cancel_survivors_intent(&self, job: &Job) -> bool {
        let mut state = job.state();
        if state.finished {
            return false;
        }
        state.finished = true;
        state.finished_ms = Some(self.now_ms());
        state.cancelled = true;
        let _ = self.config.tasks.finish(&job.id, TaskOutcome { status: SpawnStatus::Cancelled, exit_code: None });
        let _ = self.config.tasks.set_termination_unconfirmed(&job.id, true);
        true
    }

    /// The survivors are confirmed gone (the observer saw the last one exit, or a kill's re-observation found none). A task still
    /// running ends as completed with its result and notifies its owner; one cancelled earlier ends its hold silently, as
    /// Node's `cancelBackgroundTask` leaves a task without `notifyOnCancel` unnotified. Idempotent.
    pub(crate) async fn finish_survivors(&self, job: &Job) {
        let natural = {
            let mut state = job.state();
            if state.confirmed {
                return;
            }
            state.confirmed = true;
            let natural = !state.finished;
            if natural {
                state.finished = true;
                state.finished_ms = Some(self.now_ms());
                state.survivor_result = true;
            }
            natural
        };
        if natural {
            self.finish_row(&job.id, TaskOutcome { status: SpawnStatus::Completed, exit_code: None });
        } else {
            let _ = self.config.tasks.set_termination_unconfirmed(&job.id, false);
        }
        // The tracked task's end, like `completeBackgroundTask`: its folder may have changed.
        super::settle::note_command_settled(job.review.as_ref(), &job.cwd);
        if natural {
            job.report_finished(self.config.notifier.as_deref(), "completed", job.survivors_notification()).await;
        }
        job.settled.send_replace(true);
    }
    /// A cancel of `job` could not confirm its processes gone: the row is held
    /// (`terminationUnconfirmed`) so the surfaces list it, the user may release it and a closed
    /// owner's hold is found. A job that has already ended is confirmed gone, so nothing is held.
    pub(crate) fn hold_unconfirmed(&self, job: &Job) {
        // The state lock orders this against the job's end: `finished` is set under it before
        // `finish_row` clears the hold, so a hold set here is always cleared by that end.
        let state = job.state();
        if !state.finished {
            let _ = self.config.tasks.set_termination_unconfirmed(&job.id, true);
        }
    }

    /// The job ended, so its processes are confirmed gone: a hold a cancel left on the row ends
    /// with it, and the row finishes.
    fn finish_row(&self, id: &str, outcome: TaskOutcome) {
        let _ = self.config.tasks.set_termination_unconfirmed(id, false);
        let _ = self.config.tasks.finish(id, outcome);
    }

    /// Forgets a finished foreground job; its row leaves the registry.
    pub fn release(&self, id: &str) {
        lock(&self.jobs).remove(id);
        let _ = self.config.tasks.release(id);
    }

    /// The background move: the row joins the strips.
    pub fn promote(&self, id: &str) {
        let _ = self.config.tasks.promote(id);
    }

    /// `readShellJobRecord` + `recoveredTaskMatches`: the record of `owner`'s background job `id`, which this runtime does not
    /// hold, kept by the runtime that ran it. `None` when there is none, it is another thread's, or the job ended longer
    /// ago than a finished job stays readable.
    pub(crate) async fn kept(&self, owner: &ThreadId, id: &str, cancel: &CancellationToken) -> Option<KeptJob> {
        let record = spill::read_record(self.config.lanes.interactive, cancel, &self.config.spill_dir, id).await?;
        let kept = KeptJob { id: id.to_owned(), record };
        kept.answers_for(owner, self.now_ms()).then_some(kept)
    }

    /// `listShellJobRecords`, for the task list: the kept records of `owner`'s background jobs this runtime does not hold.
    pub(crate) async fn kept_jobs(&self, owner: &ThreadId, cancel: &CancellationToken) -> Vec<KeptJob> {
        let within = Some(Duration::from_millis(RETENTION_MS));
        let records = spill::read_records(self.config.lanes.interactive, cancel, &self.config.spill_dir, within).await;
        let now = self.now_ms();
        let held = lock(&self.jobs);
        records
            .into_iter()
            .map(|(id, record)| KeptJob { id, record })
            .filter(|kept| !held.contains_key(&kept.id) && kept.answers_for(owner, now))
            .collect()
    }

    /// The job `kept` names, ended as `end`, as its record and the end of its logs keep it (`registerBackgroundTask` +
    /// `completeBackgroundTask` of a recovered record): finished, with no process behind it.
    pub(crate) async fn recovered_job(&self, kept: &KeptJob, end: ExitFacts, cancel: &CancellationToken) -> Job {
        let [stdout_log, stderr_log] = spill::log_paths(&self.config.spill_dir, &kept.id);
        let tails = spill::read_log_tails(self.config.lanes.interactive, cancel, [stdout_log.clone(), stderr_log.clone()], MEMORY_CAP).await;
        let mut state = JobState::new(self.config.oem);
        for (stream, (base, bytes)) in [&mut state.stdout, &mut state.stderr].into_iter().zip(tails) {
            stream.base = base;
            stream.push(&bytes);
        }
        state.finished = true;
        state.finished_ms = kept.number("finishedAtMs");
        let (settled, _) = watch::channel(true);
        Job {
            id: kept.id.clone(),
            command: kept.command(),
            cwd: kept.text("cwd"),
            owner: ThreadId::from(kept.text("ownerSessionId").as_str()),
            handle: ProcessHandle(kept.id.clone()),
            pid: 0,
            started_ms: kept.number("startedAtMs").unwrap_or(0),
            time_limit_ms: 0,
            review: None,
            stdout_log,
            stderr_log,
            logs: None,
            wait_hits: AtomicU32::new(0),
            survivors: false,
            notify: None,
            recovered: Some(end),
            state: Mutex::new(state),
            settled,
        }
    }

    /// `reconcileRecoveredShellJobCompletions`, once at start: every background job a runtime that is gone left running
    /// (its record says it runs, this runtime does not hold it, and the job's own process is gone) ends as
    /// failed, its record says so, and its owner gets the failed completion the way a finished background job's owner
    /// does, unless the job's own process still exists (`isPidAlive(record.pid)`: it survived the restart); a job of this
    /// runtime is held before its record is written. `alive` is whether a process exists.
    pub async fn reconcile_lost_jobs(&self, alive: &(dyn Fn(u32) -> bool + Sync)) {
        let cancel = CancellationToken::new();
        let records = spill::read_records(self.config.lanes.maintenance, &cancel, &self.config.spill_dir, None).await;
        for (id, record) in records {
            let mut kept = KeptJob { id, record };
            let held = lock(&self.jobs).contains_key(&kept.id);
            let survived = kept.job_pid() > 0 && alive(kept.job_pid());
            if !kept.left_running() || held || survived {
                continue;
            }
            let end = ExitFacts::failed(Some(OUTCOME_LOST.to_owned()));
            kept.record.extend(end.record(self.now_ms()));
            kept.record.insert("state".into(), "finished".into());
            spill::write_record(self.config.lanes.durability, &cancel, &self.config.spill_dir, &kept.id, kept.record.clone()).await;
            if kept.text("ownerSessionId").is_empty() {
                continue;
            }
            let job = self.recovered_job(&kept, end, &cancel).await;
            let output = job.read_output(ReadOptions { terminal: true, ..ReadOptions::default() });
            job.report_finished(self.config.notifier.as_deref(), JobStatus::Failed.as_str(), job.notification(&output)).await;
        }
    }
}

/// Fills the job from the process's events and hands each chunk to the job's log writer; the job
/// ends (its logs complete) once the writer has written everything it was given.
async fn collect(
    job: Arc<Job>,
    mut source: Box<dyn EventSource<ProcessEvent>>,
    runtime: Arc<ExecRuntime>,
    logs: spill::LogWriter,
    processes: Arc<dyn ProcessManager>,
) {
    let mut exit = None;
    logs.open().await;
    while let Some(event) = source.next().await {
        match event {
            ProcessEvent::Output { stream, bytes, .. } => {
                let index = usize::from(stream == OutputStream::Stderr);
                {
                    let mut state = job.state();
                    let target = if index == 1 { &mut state.stderr } else { &mut state.stdout };
                    target.push(&bytes);
                    state.last_output_ms = Some(runtime.now_ms());
                    if !state.output_capped && state.stdout.end() + state.stderr.end() > OUTPUT_DISK_CAP {
                        state.output_capped = true;
                        let _ = processes.kill(&job.handle);
                    }
                }
                logs.push(index, bytes).await;
            }
            ProcessEvent::Exited { exit: exited, .. } => {
                exit = Some(exited);
                break;
            }
        }
    }
    // Bounded: a log whose writes stall past it is given up, and the job's results say from
    // which byte it lacks output (`Job::log_note`).
    let _closed = logs.close(spill::LOG_STALL).await;
    // Nothing writes the logs after this: their ownership record, which also says how the job ended
    // (`completeShellJobRecord`), lets a sweep take them once they have aged. Bounded like the close: the job's end does not
    // wait on a record write that stalls.
    let end = exit.as_ref().map_or_else(|| ExitFacts::failed(None), |e| job.facts_of(&job.state(), e));
    logs.mark_finished(spill::LOG_STALL, end.record(runtime.now_ms())).await;
    job.state().exit = exit;
    let now = runtime.now_ms();
    let detached = {
        let mut state = job.state();
        state.finished = true;
        state.finished_ms = Some(now);
        state.detached
    };
    // Read once the job is finished, so no detach comes after it: a promotion that landed while the record was written
    // still counts in a time-limit kill's text (`facts_of`), as the job's later reads show it.
    let facts = job.exit().map(|e| job.facts_of(&job.state(), &e));
    let outcome = facts.as_ref().map_or(
        TaskOutcome { status: SpawnStatus::Failed, exit_code: None },
        |f| TaskOutcome {
            status: match f.status {
                JobStatus::Completed | JobStatus::Running => SpawnStatus::Completed,
                JobStatus::Failed => SpawnStatus::Failed,
                JobStatus::Cancelled => SpawnStatus::Cancelled,
            },
            exit_code: f.exit_code,
        },
    );
    runtime.finish_row(&job.id, outcome);
    if detached {
        // A background task's end is a boundary for the review of its folder (`completeBackgroundTask`).
        super::settle::note_command_settled(job.review.as_ref(), &job.cwd);
        let output = job.read_output(ReadOptions { terminal: true, ..ReadOptions::default() });
        job.state().completion_output = Some(output.clone());
        job.report_finished(runtime.config.notifier.as_deref(), job.status().as_str(), job.notification(&output)).await;
    }
    job.settled.send_replace(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_follows_node_and_a_non_zero_exit_stays_completed() {
        let exit = |status, killed| ProcessExit { status, killed };
        let f = exit_facts(&exit(ExitStatus::Code(3), None));
        assert_eq!((f.status, f.exit_code, f.error), (JobStatus::Completed, Some(3), None));
        let f = exit_facts(&exit(ExitStatus::Signal(9), Some(KillReason::TimeLimit)));
        assert_eq!((f.status, f.exit_code, f.timed_out), (JobStatus::Failed, Some(124), true));
        assert_eq!(f.error.as_deref(), Some("timed out before completing (exit 124)"));
        let f = exit_facts(&exit(ExitStatus::Signal(9), Some(KillReason::Requested)));
        assert_eq!((f.status, f.exit_code), (JobStatus::Cancelled, Some(137)));
        let f = exit_facts(&exit(ExitStatus::Signal(11), None));
        assert_eq!((f.status, f.exit_code, f.signal.as_deref()), (JobStatus::Failed, None, Some("SIGSEGV")));
        assert_eq!(f.error.as_deref(), Some("terminated by signal SIGSEGV"));
    }

    /// `SHELL_OUTPUT_DISK_CAP`: the kill for writing past the cap ends the job failed, with the cap named, whatever the kill's exit said.
    #[test]
    fn a_job_killed_for_its_output_cap_fails_naming_the_cap() {
        let mut f = exit_facts(&exit(ExitStatus::Signal(9), Some(KillReason::Requested)));
        assert_eq!(f.status, JobStatus::Cancelled);
        f.mark_output_capped();
        assert_eq!(f.status, JobStatus::Failed);
        assert_eq!(f.error.as_deref(), Some("output exceeded 104857600 byte cap"));
    }

    #[test]
    fn a_silent_job_is_reported_as_possibly_hung_in_the_digest() {
        assert_eq!(
            progress_digest(&[], Some("no output for 10m — may be hung; inspect or cancel")),
            "[progress] no output for 10m — may be hung; inspect or cancel"
        );
        assert_eq!(most_significant_duration(999), "");
        assert_eq!(most_significant_duration(59_999), "59s");
        assert_eq!(most_significant_duration(601_000), "10m");
        assert_eq!(most_significant_duration(7_300_000), "2h");
        assert_eq!(describe_silence(599_000), None);
    }

    #[test]
    fn the_quietest_waited_job_wins_and_the_first_of_equals_keeps_it() {
        let rows = |v: &[(&str, u64)]| v.iter().map(|(id, ms)| (id.to_string(), *ms)).collect::<Vec<_>>();
        assert_eq!(quietest(rows(&[]), 600_000.0), None);
        assert_eq!(quietest(rows(&[("a", 10), ("b", 30), ("c", 30)]), 600_000.0), Some(WaitedSilence { task_id: "b".into(), silent_ms: 30, hung: false }));
        assert_eq!(quietest(rows(&[("a", 600_000)]), 600_000.0), Some(WaitedSilence { task_id: "a".into(), silent_ms: 600_000, hung: true }));
    }

    /// The encoding is decided on the stream's first non-ASCII bytes even once memory dropped them, as Node's
    /// `FileEncodingSniffer` reads its window from the log.
    #[test]
    fn the_encoding_is_decided_on_first_bytes_memory_dropped() {
        let (mut stream, mut sniffer) = (Stream::new(Some("euc-kr")), Sniffer::new(Some("euc-kr")));
        stream.push(&[0xC7]);
        assert_eq!(stream.probe(&mut sniffer, false), None, "a cut character decides nothing");
        stream.push(&[0xD1, b'\n']);
        stream.push(&b"a".repeat(MEMORY_CAP));
        assert!(stream.base > 0, "memory dropped the stream's start");
        assert_eq!(stream.probe(&mut sniffer, false), Some("euc-kr"));
    }

    /// A stream's end counts the bytes memory dropped, which is what `captured_bytes` compares to the output cap.
    #[test]
    fn a_stream_ends_where_its_output_does_whatever_memory_dropped() {
        let mut stream = Stream::new(None);
        stream.push(&b"a".repeat(MEMORY_CAP + 10));
        assert_eq!((stream.base, stream.end()), (10, MEMORY_CAP as u64 + 10));
    }

    #[test]
    fn a_cut_escape_sequence_waits_for_the_next_chunk() {
        let mut cursor = Cursor::new(None);
        assert_eq!(decode_visible(&mut cursor, b"ab\x1b[3", false), "ab");
        assert_eq!(decode_visible(&mut cursor, b"1mcd", false), "cd");
        let mut cursor = Cursor::new(None);
        let bytes = "é".as_bytes();
        assert_eq!(decode_visible(&mut cursor, &bytes[..1], false), "");
        assert_eq!(decode_visible(&mut cursor, &bytes[1..], false), "é");
    }
}
