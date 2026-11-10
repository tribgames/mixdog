//! Runs one child to completion through the one `ProcessManager` (DS §6). git and `gh` are
//! spawned here and nowhere else in the crate, so spawn admission, the job object / process
//! group and tree kill are the manager's, not ours.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;

/// Output a child may produce before it is killed (git's own bound for list reads).
pub const DEFAULT_MAX_OUTPUT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ExecSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub stdin: Option<Vec<u8>>,
    /// A run limit the caller asked for; the child is tree-killed at it.
    pub time_limit: Option<Duration>,
    pub max_output: u64,
}

/// Node's `childEnvironment` (env-scrub.mjs `scrubRuntimeRootVars`): the host's own identity never reaches a child.
pub fn child_env_removed() -> Vec<String> {
    ["MIXDOG_ROOT", "NODE_ENV", "MIXDOG_DAEMON_HOST", "MIXDOG_WORKER_MODE", "MIXDOG_DAEMON_SPAWNED_FOR", "MIXDOG_SUPERVISOR_PID", "MIXDOG_SERVER_PID", "ELECTRON_RUN_AS_NODE"]
        .map(String::from)
        .to_vec()
}

impl ExecSpec {
    pub fn new(program: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env_set: Vec::new(),
            // Node's `childEnvironment` (env-scrub.mjs `scrubRuntimeRootVars`): the host's own identity never reaches a child.
            env_remove: child_env_removed(),
            stdin: None,
            time_limit: None,
            max_output: DEFAULT_MAX_OUTPUT,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ExecOutput {
    /// `None` when the child ended by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

pub struct Exec {
    processes: Arc<dyn ProcessManager>,
    next: AtomicU64,
    prefix: String,
}

impl Exec {
    pub fn new(processes: Arc<dyn ProcessManager>) -> Self {
        crate::seam::start();
        Self {
            processes,
            next: AtomicU64::new(0),
            prefix: format!("scm-{}", std::process::id()),
        }
    }

    fn handle(&self) -> ProcessHandle {
        ProcessHandle(format!(
            "{}-{}",
            self.prefix,
            self.next.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Spawns, feeds stdin, collects both streams until the exit event. `cancel` tree-kills
    /// the child and answers [`ScmFailure::Cancelled`]; the run limit answers `TimedOut`.
    pub async fn run(
        &self,
        spec: ExecSpec,
        cancel: &CancellationToken,
    ) -> Result<ExecOutput, ScmFailure> {
        let cwd = AbsPath::new(&spec.cwd)
            .ok_or_else(|| ScmFailure::invalid("cwd", "an absolute directory"))?;
        let attempt = crate::seam::attempt_begin(&spec.program, &spec.args, false, &spec.cwd, &spec.env_set, &spec.env_remove);
        let result = self.run_attempt(spec, cwd, cancel, &attempt).await;
        attempt.done(&match &result {
            Ok(out) => crate::seam::Ended::Code(out.code),
            Err(ScmFailure::TimedOut { .. }) => crate::seam::Ended::TimedOut,
            Err(ScmFailure::OutputTooLarge { .. }) => crate::seam::Ended::TooLarge,
            Err(_) => crate::seam::Ended::Cancelled,
        });
        result
    }

    async fn run_attempt(
        &self,
        spec: ExecSpec,
        cwd: AbsPath,
        cancel: &CancellationToken,
        attempt: &crate::seam::Attempt,
    ) -> Result<ExecOutput, ScmFailure> {
        let handle = self.handle();
        let stdin_piped = spec.stdin.is_some();
        let (time_limit, mut deadline) = crate::seam::run_limit(spec.time_limit, attempt);
        let program = spec.program.clone();
        // Node's runners word a deadline or an overflow with the command as `git status -z` (git-runner.ts gitTimeout).
        let command = command_label(&spec.program, &spec.args);
        let request = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv {
                program: spec.program,
                args: spec.args,
            },
            cwd,
            env: EnvSpec {
                inherit: true,
                set: spec.env_set,
                remove: spec.env_remove,
            },
            pty: None,
            stdin_piped,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit,
        };
        let spawned = self.processes.spawn(request).await;
        attempt.spawned(spawned.is_ok());
        spawned.map_err(|error| spawn_failure(error, &program))?;
        let mut events = self
            .processes
            .subscribe(&handle, Some(0))
            .map_err(|error| spawn_failure(error, &program))?;
        if let Some(input) = spec.stdin {
            // A child that exits before reading its input reports through its exit status.
            if !input.is_empty() {
                let _ = self.processes.write_stdin(&handle, input).await;
            }
            let _ = self.processes.close_stdin(&handle);
        }
        let mut out = ExecOutput::default();
        let mut exit = None;
        let mut killed = false;
        let mut cancelled = false;
        let mut too_large = false;
        // A virtual run limit (a replay's debug seam) reached: the child is killed here, as the process manager kills at a real one.
        let mut limit_reached = false;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !cancelled => {
                    cancelled = true;
                    let _ = self.processes.kill(&handle);
                }
                () = deadline.fired(), if !limit_reached => {
                    limit_reached = true;
                    let _ = self.processes.kill(&handle);
                }
                event = events.next() => match event {
                    Some(ProcessEvent::Output { stream, bytes, .. }) => {
                        match stream {
                            OutputStream::Stderr => out.stderr.extend_from_slice(&bytes),
                            OutputStream::Stdout | OutputStream::Pty => out.stdout.extend_from_slice(&bytes),
                        }
                        if !killed
                            && (out.stdout.len() + out.stderr.len()) as u64 > spec.max_output
                        {
                            too_large = true;
                            killed = true;
                            let _ = self.processes.kill(&handle);
                        }
                    }
                    Some(ProcessEvent::Exited { exit: done, .. }) => {
                        exit = Some(done);
                        break;
                    }
                    None => break,
                },
            }
        }
        if cancelled {
            return Err(ScmFailure::Cancelled);
        }
        if too_large {
            return Err(ScmFailure::OutputTooLarge {
                command,
                limit: spec.max_output,
            });
        }
        let exit = exit.ok_or_else(|| ScmFailure::Io {
            os_code: None,
            message: "process events ended without an exit".into(),
        })?;
        if limit_reached || exit.killed == Some(KillReason::TimeLimit) {
            return Err(ScmFailure::TimedOut {
                command,
                millis: spec.time_limit.map_or(0, |limit| limit.as_millis() as u64),
            });
        }
        out.code = match exit.status {
            ExitStatus::Code(code) => Some(code),
            ExitStatus::Signal(_) => None,
        };
        Ok(out)
    }
}

/// The program as the child was started with it (the resolved path of git, as `gitCommand()` gives it), then its arguments:
/// the words of run-child.mjs, `${command} ${args.join(' ')}`.
pub(crate) fn command_label(program: &str, args: &[String]) -> String {
    std::iter::once(program).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
}

fn spawn_failure(error: ProcessError, program: &str) -> ScmFailure {
    match error {
        ProcessError::ProgramNotFound { .. } => ScmFailure::Unavailable {
            capability: program.to_owned(),
        },
        // CreateProcess answers ERROR_BAD_EXE_FORMAT (193) or ERROR_EXE_MACHINE_TYPE_MISMATCH (216, what this Windows answers for a
        // text file named git.exe) for a file the loader cannot run; libuv has no name for either.
        ProcessError::Io { os_code: Some(193 | 216) } if cfg!(windows) => ScmFailure::Spawn { code: "UNKNOWN" },
        ProcessError::Io { os_code } => ScmFailure::Io {
            os_code,
            message: format!("could not start {program}"),
        },
        other => ScmFailure::Io {
            os_code: None,
            message: format!("could not start {program}: {other:?}"),
        },
    }
}
