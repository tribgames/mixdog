//! Worktree setup: the commands that prepare a freshly created managed worktree (its
//! dependency installs) run one after another, each in its own folder of the worktree
//! (Node `setup-commands.mjs`).
//!
//! The run never fails for what a command does: the report says how it ended (`completed`,
//! `failed`, `timed-out`, `cancelled`) and the first command that does not complete ends it.
//! Nothing here touches the worktree itself, so a failed setup leaves the checkout exactly as
//! the commands left it. Each command's output (stdout and stderr, interleaved) is kept within
//! a byte cap: past it the start and the end stay and the middle is dropped. A command over its
//! time limit, or a run whose token is cancelled, has its whole process tree killed by the
//! process manager.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_js::js_trim_end;
use mixdog_js::utf16_len;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::CancellationToken;
use mixdog_scm::worktree::dependencies::SetupCommand;
use serde_json::Value;
use serde_json::json;

pub const WORKTREE_SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const WORKTREE_SETUP_OUTPUT_BYTES: usize = 16 * 1024;
pub const WORKTREE_SETUP_ELISION: &str = "\n… output truncated …\n";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const TAIL_LINES: usize = 20;
const TAIL_CHARS: usize = 2000;

/// The last lines of a command's output, for a compact report.
pub fn output_tail(output: &str) -> String {
    let lines: Vec<&str> = js_trim_end(output).split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    let joined = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
    let length = utf16_len(&joined);
    if length <= TAIL_CHARS {
        return joined;
    }
    // `slice(-2000)` by UTF-16 units; a cut inside a surrogate pair leaves its low half, which
    // the output encoding writes as U+FFFD.
    let mut skip = length - TAIL_CHARS;
    let mut out = String::from("…");
    for c in joined.chars() {
        let width = c.len_utf16();
        if skip >= width {
            skip -= width;
        } else if skip > 0 {
            skip = 0;
            out.push('\u{fffd}');
        } else {
            out.push(c);
        }
    }
    out
}

/// A byte-capped output window that keeps the first and the last half of the cap once the
/// output outgrows it.
pub struct OutputWindow {
    head: Vec<u8>,
    tail: Vec<u8>,
    head_limit: usize,
    tail_limit: usize,
    limit: u64,
    total: u64,
}

impl OutputWindow {
    pub fn new(limit: usize) -> Self {
        let head_limit = limit / 2;
        Self { head: Vec::new(), tail: Vec::new(), head_limit, tail_limit: limit - head_limit, limit: limit as u64, total: 0 }
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        let mut rest = chunk;
        if self.head.len() < self.head_limit {
            let take = (self.head_limit - self.head.len()).min(rest.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.is_empty() {
            return;
        }
        self.tail.extend_from_slice(rest);
        if self.tail.len() > self.tail_limit {
            let excess = self.tail.len() - self.tail_limit;
            self.tail.drain(..excess);
        }
    }

    pub fn truncated(&self) -> bool {
        self.total > self.limit
    }

    pub fn text(&self) -> String {
        if self.total <= self.limit {
            let mut all = self.head.clone();
            all.extend_from_slice(&self.tail);
            return String::from_utf8_lossy(&all).into_owned();
        }
        format!("{}{WORKTREE_SETUP_ELISION}{}", String::from_utf8_lossy(&self.head), String::from_utf8_lossy(&self.tail))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupStatus {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

impl SetupStatus {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::TimedOut => "timed-out",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SetupStep {
    pub command: String,
    /// Where it ran, for display.
    pub label: Option<String>,
    pub status: SetupStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// Capped output (middle elided when `truncated`).
    pub output: String,
    pub truncated: bool,
}

impl SetupStep {
    fn to_value(&self) -> Value {
        json!({
            "command": self.command,
            "label": self.label,
            "status": self.status.wire(),
            "exitCode": self.exit_code,
            "durationMs": self.duration_ms,
            "output": self.output,
            "truncated": self.truncated,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SetupReport {
    pub status: SetupStatus,
    pub total: usize,
    pub steps: Vec<SetupStep>,
    /// The commands a stop left unrun.
    pub pending: Vec<SetupCommand>,
}

fn command_value(command: &SetupCommand) -> Value {
    let env = command.env.as_ref().map(|pairs| {
        Value::Object(pairs.iter().map(|(name, value)| (name.clone(), json!(value))).collect())
    });
    json!({
        "command": command.command,
        "file": command.file,
        "args": command.args,
        "cwd": command.cwd.to_string_lossy(),
        "label": command.label,
        "env": env,
    })
}

/// The live state a run reports: one `Running` at each start and at most every 200 ms while
/// output arrives, and finally the report.
#[derive(Clone, Debug, PartialEq)]
pub enum SetupEvent {
    Running { index: usize, total: usize, command: String, label: String, output: String, truncated: bool },
    Final(SetupReport),
}

impl SetupEvent {
    /// Node's event object.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Running { index, total, command, label, output, truncated } => json!({
                "status": "running",
                "index": index,
                "total": total,
                "command": command,
                "label": label,
                "output": output,
                "truncated": truncated,
            }),
            Self::Final(report) => json!({
                "status": report.status.wire(),
                "total": report.total,
                "steps": report.steps.iter().map(SetupStep::to_value).collect::<Vec<_>>(),
                "pending": report.pending.iter().map(command_value).collect::<Vec<_>>(),
                "final": true,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RunOptions {
    pub timeout: Duration,
    pub output_bytes: usize,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self { timeout: WORKTREE_SETUP_TIMEOUT, output_bytes: WORKTREE_SETUP_OUTPUT_BYTES }
    }
}

/// Runs setup commands through the one process manager.
pub struct SetupRunner {
    processes: Arc<dyn ProcessManager>,
    next: AtomicU64,
    prefix: String,
}

/// A Windows `.cmd` / `.bat` shim cannot be spawned without a shell.
fn needs_shell(file: &str) -> bool {
    if file.is_empty() {
        return true;
    }
    if !cfg!(windows) {
        return false;
    }
    let lower = file.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// The variables `overrides` set (`Some`) or remove (`None`) on top of the inherited
/// environment; on Windows names are case-insensitive, so every spelling of a name goes first.
fn env_of(overrides: Option<&[(String, Option<String>)]>) -> EnvSpec {
    let mut env = EnvSpec { inherit: true, set: Vec::new(), remove: Vec::new() };
    let Some(overrides) = overrides else { return env };
    let inherited: Vec<String> = std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()).collect();
    for (name, value) in overrides {
        for key in &inherited {
            let same = key == name || (cfg!(windows) && key.to_uppercase() == name.to_uppercase());
            if same && !(value.is_some() && key == name) {
                env.remove.push(key.clone());
            }
        }
        if let Some(value) = value {
            env.set.push((name.clone(), value.clone()));
        }
    }
    env
}

impl SetupRunner {
    pub fn new(processes: Arc<dyn ProcessManager>) -> Self {
        Self { processes, next: AtomicU64::new(0), prefix: format!("worktree-setup-{}", std::process::id()) }
    }

    /// Runs `commands` in order and reports how it ended; never fails.
    pub async fn run(
        &self,
        commands: Vec<SetupCommand>,
        cancel: &CancellationToken,
        options: &RunOptions,
        on_progress: &mut dyn FnMut(SetupEvent),
    ) -> SetupReport {
        let total = commands.len();
        let mut steps = Vec::new();
        let mut status = SetupStatus::Completed;
        for (index, entry) in commands.iter().enumerate() {
            if cancel.is_cancelled() {
                status = SetupStatus::Cancelled;
                break;
            }
            let running = |output: String, truncated: bool| SetupEvent::Running {
                index,
                total,
                command: entry.command.clone(),
                label: entry.label.clone(),
                output,
                truncated,
            };
            on_progress(running(String::new(), false));
            let mut last: Option<Instant> = None;
            let step = self
                .run_command(entry, cancel, options, &mut |window: &OutputWindow| {
                    let now = Instant::now();
                    if last.is_some_and(|at| now.duration_since(at) < PROGRESS_INTERVAL) {
                        return;
                    }
                    last = Some(now);
                    on_progress(running(window.text(), window.truncated()));
                })
                .await;
            let ended = step.status;
            steps.push(step);
            if ended != SetupStatus::Completed {
                status = ended;
                break;
            }
        }
        let pending = commands[steps.len()..].to_vec();
        let report = SetupReport { status, total, steps, pending };
        on_progress(SetupEvent::Final(report.clone()));
        report
    }

    /// One command to its end; never fails.
    async fn run_command(
        &self,
        entry: &SetupCommand,
        cancel: &CancellationToken,
        options: &RunOptions,
        progress: &mut dyn FnMut(&OutputWindow),
    ) -> SetupStep {
        let started = Instant::now();
        let mut output = OutputWindow::new(options.output_bytes);
        let label = (!entry.label.is_empty()).then(|| entry.label.clone());
        let step = |output: &OutputWindow, status: SetupStatus, exit_code: Option<i32>| SetupStep {
            command: entry.command.clone(),
            label: label.clone(),
            status,
            exit_code,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            output: output.text(),
            truncated: output.truncated(),
        };
        let Some(cwd) = AbsPath::new(&entry.cwd) else {
            output.append(format!("the folder {} is not an absolute path\n", entry.cwd.display()).as_bytes());
            return step(&output, SetupStatus::Failed, None);
        };
        let command = if needs_shell(&entry.file) {
            CommandSpec::Shell { script: entry.command.clone(), shell: None }
        } else {
            CommandSpec::Argv { program: entry.file.clone(), args: entry.args.clone() }
        };
        let handle = ProcessHandle(format!("{}-{}", self.prefix, self.next.fetch_add(1, Ordering::Relaxed)));
        let request = SpawnRequest {
            handle: handle.clone(),
            command,
            cwd,
            env: env_of(entry.env.as_deref()),
            pty: None,
            stdin_piped: false,
            output: OutputMode::Merged,
            owner: ProcessOwner::Internal,
            time_limit: Some(options.timeout),
        };
        let subscribed = match self.processes.spawn(request).await {
            Ok(_) => self.processes.subscribe(&handle, Some(0)),
            Err(error) => Err(error),
        };
        let mut events = match subscribed {
            Ok(events) => events,
            Err(error) => {
                output.append(spawn_message(&error, &entry.file).as_bytes());
                return step(&output, SetupStatus::Failed, None);
            }
        };
        let mut cancelled = false;
        let exit = loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !cancelled => {
                    cancelled = true;
                    let _ = self.processes.kill(&handle);
                }
                event = events.next() => match event {
                    Some(ProcessEvent::Output { bytes, .. }) => {
                        output.append(&bytes);
                        progress(&output);
                    }
                    Some(ProcessEvent::Exited { exit, .. }) => break Some(exit),
                    None => break None,
                },
            }
        };
        let Some(exit) = exit else {
            output.append(b"the process ended without an exit\n");
            return step(&output, SetupStatus::Failed, None);
        };
        let code = match exit.status {
            mixdog_core_api::domain::process::ExitStatus::Code(code) => Some(code),
            mixdog_core_api::domain::process::ExitStatus::Signal(_) => None,
        };
        step(&output, end_status(cancelled, exit.killed, code), code)
    }
}

/// Whichever stop came first names the end, as the exit code only says how it died: the process
/// manager keeps the first kill reason, so a cancel after the time limit fired still reads as
/// timed out.
fn end_status(cancel_requested: bool, killed: Option<KillReason>, code: Option<i32>) -> SetupStatus {
    if killed == Some(KillReason::TimeLimit) {
        SetupStatus::TimedOut
    } else if cancel_requested || killed.is_some() {
        SetupStatus::Cancelled
    } else if code == Some(0) {
        SetupStatus::Completed
    } else {
        SetupStatus::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_stop_names_the_end_even_when_a_cancel_was_also_requested() {
        // The limit killed it first, then the cancel arrived: timed out, whatever the order of
        // the later signals.
        assert_eq!(end_status(true, Some(KillReason::TimeLimit), None), SetupStatus::TimedOut);
        assert_eq!(end_status(false, Some(KillReason::TimeLimit), None), SetupStatus::TimedOut);
        assert_eq!(end_status(true, Some(KillReason::Requested), None), SetupStatus::Cancelled);
        assert_eq!(end_status(true, None, Some(0)), SetupStatus::Cancelled);
        assert_eq!(end_status(false, None, Some(0)), SetupStatus::Completed);
        assert_eq!(end_status(false, None, Some(2)), SetupStatus::Failed);
    }
}

fn spawn_message(error: &ProcessError, file: &str) -> String {
    match error {
        ProcessError::ProgramNotFound { program } => format!("spawn {program} ENOENT\n"),
        other => format!("spawn {file} failed: {other:?}\n"),
    }
}
