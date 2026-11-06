//! The shell jobs of one runtime: one job per spawned process, filled by a collector running on
//! an `mixdog-rt` lane from the process's event stream, spilled to log files through lane jobs,
//! and registered in WP-PROC's `TaskRegistry` (`native/mixdog-spawn/src/tasks.rs`), which owns
//! the task rows and the shell-job strips. The jobs add what that registry does not hold: the
//! captured output with its read cursors and the model-facing text.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU32;

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
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
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

/// Bytes kept in memory per stream; older bytes stay only in the spill log.
const MEMORY_CAP: usize = 8 * 1024 * 1024;
/// An unseen range up to this size is read whole; a longer one only at its two ends.
const FULL_READ_BYTES: usize = 64 * 1024;
const EDGE_READ_BYTES: usize = 16 * 1024;
/// How long a finished job stays readable.
const RETENTION_MS: u64 = mixdog_spawn::tasks::FINISHED_RETENTION_MS;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pushed to the owner when a detached job finishes. Awaited in the completing job's task, so a
/// slow consumer pushes back on the job instead of queueing behind it.
#[async_trait::async_trait]
pub trait TaskNotifier: Send + Sync {
    async fn finished(&self, owner: &ThreadId, task_id: &str, status: &str, notification: String);
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
    /// Completes when the last survivor has exited.
    async fn wait_gone(&self, handle: &ProcessHandle);
    /// Terminates them; `true` when a re-observation found every one gone.
    async fn kill(&self, handle: &ProcessHandle) -> bool;
}

/// The lane tokens the shell and task tools run their file work on.
#[derive(Clone, Copy)]
pub struct IoLanes {
    pub interactive: InteractiveIo,
    pub durability: DurabilityIo,
    pub maintenance: MaintenanceIo,
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
    /// The resolved shell's program path (`/bin/bash`): bash and zsh get the environment snapshot.
    pub shell_path: String,
    /// The default shell's program name (`powershell.exe`, `pwsh`): Windows PowerShell 5.1 has no
    /// `&&`, PowerShell 7 does.
    pub shell_name: String,
    /// Tells whether a Node script body compiles as CommonJS (see [`super::hoist::ScriptSyntax`]).
    pub script_syntax: Arc<dyn super::hoist::ScriptSyntax>,
    /// The host is Windows (PowerShell hints, `Path` casing, UTF-8 Python variables).
    pub windows: bool,
    /// The default shell is PowerShell (the wmic rewrite applies).
    pub powershell: bool,
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
pub struct ExitFacts {
    pub status: JobStatus,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub signal: Option<String>,
    pub error: Option<String>,
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
        }
    }
}

struct Stream {
    oem: Option<Label>,
    buf: Vec<u8>,
    /// Absolute offset of `buf[0]`.
    base: u64,
    cursor: Cursor,
}

impl Stream {
    fn new(oem: Option<Label>) -> Self {
        Self { oem, buf: Vec::new(), base: 0, cursor: Cursor::new(oem) }
    }

    fn end(&self) -> u64 {
        self.base + self.buf.len() as u64
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > MEMORY_CAP {
            let drop = self.buf.len() - MEMORY_CAP;
            self.buf.drain(..drop);
            self.base += drop as u64;
        }
    }

    fn slice(&self, from: u64, to: u64) -> &[u8] {
        let from = from.max(self.base);
        let to = to.max(from);
        &self.buf[(from - self.base) as usize..(to - self.base) as usize]
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
    /// A survivors task ended by `task cancel`.
    cancelled: bool,
    /// When the command moved to the background; the task row starts there.
    promoted_ms: Option<u64>,
    /// When the process last wrote to stdout or stderr.
    last_output_ms: Option<u64>,
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
            promoted_ms: None,
            last_output_ms: None,
        }
    }
}

pub struct Job {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub owner: ThreadId,
    pub handle: ProcessHandle,
    pub started_ms: u64,
    /// The run limit (0: none), to say how much of it was left when the task was promoted.
    pub time_limit_ms: u64,
    pub stdout_log: PathBuf,
    pub stderr_log: PathBuf,
    /// Waits that ran to their ceiling, so a repeated one can suggest a different move.
    pub wait_hits: AtomicU32,
    /// A task tracking the survivors of a finished command: it has no process of its own, no
    /// logs, and ends when the last survivor exits.
    pub survivors: bool,
    state: Mutex<JobState>,
    settled: watch::Sender<bool>,
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

fn read_range(stream: &mut Stream, start: u64, end: u64, flush: bool, label: Option<Label>, path: &str) -> Range {
    let total = (end - start) as usize;
    if total <= FULL_READ_BYTES {
        let bytes = stream.slice(start, end).to_vec();
        let text = decode_visible(&mut stream.cursor, &bytes, flush);
        return Range { piece: text_piece(&text, path), bytes: total, lines: count_newlines(&text), text };
    }
    let head_bytes = stream.slice(start, start + EDGE_READ_BYTES as u64).to_vec();
    let head_text = decode_visible(&mut stream.cursor, &head_bytes, false);
    let tail_start = aligned(stream, end - EDGE_READ_BYTES as u64, label);
    stream.cursor.decoder = ShellStreamDecoder::new(stream.oem, label);
    stream.cursor.ansi.clear();
    stream.cursor.fold = CarriageReturnFolder::default();
    let tail_bytes = stream.slice(tail_start, end).to_vec();
    let tail_text = decode_visible(&mut stream.cursor, &tail_bytes, flush);
    let lines = count_newlines(&String::from_utf8_lossy(stream.slice(start, end)));
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
    fn state(&self) -> MutexGuard<'_, JobState> {
        lock(&self.state)
    }

    pub fn status(&self) -> JobStatus {
        let state = self.state();
        match (&state.exit, state.finished) {
            (Some(exit), true) => self.facts_of(&state, exit).status,
            (None, true) if self.survivors && state.cancelled => JobStatus::Cancelled,
            (None, true) if self.survivors => JobStatus::Completed,
            (None, true) => JobStatus::Failed,
            _ => JobStatus::Running,
        }
    }

    pub fn is_running(&self) -> bool {
        !self.state().finished
    }

    pub fn exit(&self) -> Option<ProcessExit> {
        self.state().exit
    }

    pub async fn settled(&self) {
        let mut rx = self.settled.subscribe();
        // The sender lives in `self`, so the wait ends only on the value.
        let _ = rx.wait_for(|done| *done).await;
    }

    /// Hands the running job to the background. `false` when it has already finished.
    pub fn detach(&self, now_ms: u64) -> bool {
        let mut state = self.state();
        if state.finished {
            return false;
        }
        state.detached = true;
        state.promoted_ms = Some(now_ms);
        true
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
        facts
    }

    /// The whole capture of both streams as text, for a foreground result.
    pub fn captured(&self) -> (String, String) {
        let state = self.state();
        let all = |s: &Stream| decode_shell_bytes(&s.buf, s.oem);
        (all(&state.stdout), all(&state.stderr))
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
            if replay {
                stream.cursor = Cursor::new(stream.oem);
            }
            let size = stream.end();
            // The encoding is decided once, firmly (or when the task is terminal); until then
            // only the ASCII prefix is read.
            let label = stream.cursor.sniffer.probe(&stream.buf, stream.base, options.terminal);
            if let Some(label) = label {
                if !stream.cursor.committed {
                    stream.cursor.committed = true;
                    stream.cursor.decoder.force(label);
                }
            }
            let read_end = if label.is_some() { size } else { stream.cursor.sniffer.safe_end(size) };
            let mut start = stream.cursor.offset.max(stream.base);
            let mut earlier = String::new();
            if replay && read_end - start > FULL_READ_BYTES as u64 {
                start = aligned(stream, read_end - FULL_READ_BYTES as u64, label).min(read_end);
                let lines = count_newlines(&String::from_utf8_lossy(stream.slice(0, start)));
                earlier = omission_marker(&Omitted { lines, bytes: start as usize, path: &path });
                stream.cursor.decoder = ShellStreamDecoder::new(stream.oem, label);
            }
            let flush = options.terminal && read_end == size;
            let mut range = read_range(stream, start, read_end, flush, label, &path);
            stream.cursor.offset = read_end;
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
        let since = state.last_output_ms.unwrap_or(0).max(self.shown_started(&state));
        describe_silence(now_ms.saturating_sub(since))
    }

    pub fn render(&self, owner_tool: bool, body: Option<&str>) -> String {
        self.render_with(owner_tool, body, None)
    }

    /// `render`, with the silence warning of a running task read (`output_silence:`).
    pub fn render_with(&self, owner_tool: bool, body: Option<&str>, silence: Option<&str>) -> String {
        let (status, facts, finished_ms) = {
            let state = self.state();
            (self.status_locked(&state), state.exit.as_ref().map(|e| self.facts_of(&state, e)), state.finished_ms)
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
        }
        if let Some(silence) = silence {
            lines.push(format!("output_silence: {silence}"));
        }
        if !self.survivors {
            lines.push(self.logs_line());
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
        match (&state.exit, state.finished) {
            (Some(exit), true) => self.facts_of(&state, exit).status,
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

    /// `renderShellCompletionNotice` for the survivors task.
    fn survivors_notification(&self, status: &str) -> String {
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
            format!("<status>{status}</status>"),
            format!(
                "<summary>{}</summary>",
                escape_field(&format!(
                    "Shell task {} (exit n/a){tail}",
                    if status == "cancelled" { "was cancelled" } else { status }
                ))
            ),
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
        let Some(exit) = state.exit else { return String::new() };
        let facts = self.facts_of(&state, &exit);
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

/// The jobs of one runtime.
pub struct ExecRuntime {
    pub(crate) config: ExecConfig,
    pub(crate) snapshots: super::snapshot::Snapshots,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
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
        Arc::new(Self { config, jobs: Mutex::new(HashMap::new()), snapshots: super::snapshot::Snapshots::default() })
    }

    pub fn now_ms(&self) -> u64 {
        (self.config.now_ms)()
    }

    /// Spawns the process, registers the task and starts the collector on a lane.
    pub async fn start(
        self: &Arc<Self>,
        processes: &Arc<dyn ProcessManager>,
        request: SpawnRequest,
        task_id: String,
        command: String,
        owner: ThreadId,
        time_limit_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Arc<Job>, ProcessError> {
        let handle = request.handle.clone();
        let cwd = request.cwd.as_path().to_string_lossy().into_owned();
        let stdout_log = self.config.spill_dir.join(format!("{task_id}.stdout.log"));
        let stderr_log = self.config.spill_dir.join(format!("{task_id}.stderr.log"));
        // A log that cannot be created is simply not offered to the model.
        spill::create_logs(self.config.lanes.maintenance, cancel, &stdout_log, &stderr_log).await;
        processes.spawn(request).await?;
        let source = processes.subscribe(&handle, Some(0))?;
        let (settled, _) = watch::channel(false);
        let started_ms = self.now_ms();
        let oem = self.config.oem;
        let job = Arc::new(Job {
            id: task_id.clone(),
            command: command.clone(),
            cwd: cwd.clone(),
            owner: owner.clone(),
            handle: handle.clone(),
            started_ms,
            time_limit_ms,
            stdout_log,
            stderr_log,
            wait_hits: AtomicU32::new(0),
            survivors: false,
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
            collect(job.clone(), source, self.clone(), cancel.clone()),
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
            started_ms: self.now_ms(),
            time_limit_ms: 0,
            stdout_log: job.stdout_log.clone(),
            stderr_log: job.stderr_log.clone(),
            wait_hits: AtomicU32::new(0),
            survivors: true,
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
            watch.wait_gone(&watched.handle).await;
            runtime.finish_survivors(&watched, false).await;
        });
        Some((tracked, survivors))
    }

    /// The last survivor exited (or was terminated).
    pub(crate) async fn finish_survivors(&self, job: &Job, cancelled: bool) {
        let now = self.now_ms();
        {
            let mut state = job.state();
            if state.finished {
                return;
            }
            state.finished = true;
            state.finished_ms = Some(now);
            state.cancelled = cancelled;
        }
        let status = if cancelled { SpawnStatus::Cancelled } else { SpawnStatus::Completed };
        let _ = self.config.tasks.finish(&job.id, TaskOutcome { status, exit_code: None });
        if let Some(notifier) = &self.config.notifier {
            let word = if cancelled { "cancelled" } else { "completed" };
            notifier.finished(&job.owner, &job.id, word, job.survivors_notification(word)).await;
        }
        job.settled.send_replace(true);
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
}

async fn collect(
    job: Arc<Job>,
    mut source: Box<dyn EventSource<ProcessEvent>>,
    runtime: Arc<ExecRuntime>,
    cancel: CancellationToken,
) {
    let lanes = runtime.config.lanes;
    let mut spilling = [true, true];
    while let Some(event) = source.next().await {
        match event {
            ProcessEvent::Output { stream, bytes, .. } => {
                let (index, log) = if stream == OutputStream::Stderr { (1, &job.stderr_log) } else { (0, &job.stdout_log) };
                {
                    let mut state = job.state();
                    let target = if index == 1 { &mut state.stderr } else { &mut state.stdout };
                    target.push(&bytes);
                    state.last_output_ms = Some(runtime.now_ms());
                }
                if spilling[index] {
                    spilling[index] = spill::append(lanes.maintenance, &cancel, log, bytes).await;
                }
            }
            ProcessEvent::Exited { exit, .. } => {
                job.state().exit = Some(exit);
                break;
            }
        }
    }
    let now = runtime.now_ms();
    let detached = {
        let mut state = job.state();
        state.finished = true;
        state.finished_ms = Some(now);
        state.detached
    };
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
    let _ = runtime.config.tasks.finish(&job.id, outcome);
    if detached {
        let output = job.read_output(ReadOptions { terminal: true, ..ReadOptions::default() });
        job.state().completion_output = Some(output.clone());
        if let Some(notifier) = &runtime.config.notifier {
            let status = job.status();
            notifier.finished(&job.owner, &job.id, status.as_str(), job.notification(&output)).await;
        }
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
