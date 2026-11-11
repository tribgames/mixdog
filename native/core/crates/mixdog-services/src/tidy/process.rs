//! Child-process helpers for the tidy engines. Every spawn goes through [`Processes::run`], which
//! hands the child to the one process manager (job object / process group, tree kill, the
//! io-spawn lane): argument arrays only (never a shell string), a run limit the manager enforces,
//! and capped stdout/stderr buffers. Engine binaries and file paths are untrusted input, so no
//! value ever reaches a shell parser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::command::spawn_form;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::{CommandSpec, EnvSpec, ExitStatus, KillReason, OutputMode, OutputStream, ProcessError, ProcessEvent, ProcessManager, ProcessOwner, SpawnRequest};
use mixdog_protocol::ProcessHandle;
use mixdog_rt::DurabilityIo;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_PROCESS_TIMEOUT: Duration = Duration::from_secs(90);
pub const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct ProcessResult {
    /// `-1` when the process could not start or was killed.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Both streams as the chunks arrived, the last `max_capture` bytes: the log a caller that
    /// quotes the child's whole output (Node appends every `data` chunk of either stream to one
    /// string) must show in arrival order.
    pub combined: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub error: String,
    /// The spawn error's kind, e.g. `NotFound`.
    pub error_code: String,
}

pub struct RunOptions<'a> {
    pub cwd: &'a Path,
    pub env: Option<&'a HashMap<String, String>>,
    pub input: Option<Vec<u8>>,
    pub timeout: Duration,
    pub cancel: Option<&'a CancellationToken>,
    pub max_capture: usize,
}

impl<'a> RunOptions<'a> {
    pub fn new(cwd: &'a Path) -> Self {
        Self { cwd, env: None, input: None, timeout: DEFAULT_PROCESS_TIMEOUT, cancel: None, max_capture: MAX_CAPTURE_BYTES }
    }
}

// The PATH/PATHEXT lookup and the `.cmd`/`.bat` shim form are the shared ones.
pub use mixdog_core_api::domain::command::{PathIndex, which};

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(0);
/// Bytes of one stdin write; the manager's input queue is bounded.
const STDIN_CHUNK: usize = 64 * 1024;

/// What the tidy engines run on, handed in at construction (the tidy tool, the install job's
/// resolver) and passed down to each call that spawns or hashes: the one process manager every
/// child runs under, and the durability lane engine binaries are hashed on.
#[derive(Clone)]
pub struct Processes(Arc<dyn ProcessManager>, DurabilityIo);

impl Processes {
    pub fn new(manager: Arc<dyn ProcessManager>, durability: DurabilityIo) -> Self {
        Self(manager, durability)
    }

    pub fn durability(&self) -> DurabilityIo {
        self.1
    }

    /// The shared manager, for children that outlive one call (a model server).
    pub fn manager(&self) -> Arc<dyn ProcessManager> {
        self.0.clone()
    }

    /// The real manager over the test lane backend. One per call: each test runs its own runtime.
    #[cfg(test)]
    pub fn for_tests() -> Self {
        use mixdog_spawn::{LocalProcessManager, ProcessConfig};
        let tokens = mixdog_rt::testing::tokens();
        Self(Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())), tokens.durability_io)
    }

    /// [`which`] as a lane job: the PATH lookup lists directories.
    pub async fn which(&self, name: &str, env: Option<&HashMap<String, String>>) -> Option<PathBuf> {
        let (name, env) = (name.to_owned(), env.cloned());
        crate::lane::on_lane(self.1, move || which(&name, env.as_ref(), None)).await.ok().flatten()
    }

    /// Spawns `bin` with `args` and collects its output. A failed spawn is reported, never
    /// thrown, so one broken engine cannot abort the multiplexer. Cancelling `options.cancel`
    /// issues the manager's tree kill from the durability lane and waits for the exit event, never
    /// blocking the runtime. A kill the lane refuses is issued inline instead, and dropping the run
    /// (a runtime shutdown included) kills a child whose end was not confirmed, so neither leaves the
    /// child running.
    pub async fn run(&self, bin: &str, args: &[String], options: RunOptions<'_>) -> ProcessResult {
        run_process(&self.0, self.1, bin, args, options).await
    }
}

fn spawn_failure(error: ProcessError, program: &str) -> ProcessResult {
    let (message, kind) = match error {
        ProcessError::ProgramNotFound { .. } => (format!("{program}: program not found"), "NotFound"),
        ProcessError::PermissionDenied => (format!("{program}: permission denied"), "PermissionDenied"),
        other => (format!("{program}: could not start ({other:?})"), "Other"),
    };
    ProcessResult { code: -1, error: message, error_code: kind.to_owned(), ..Default::default() }
}

/// Feeds `input` to the child's stdin in bounded writes, then closes it. A child that exits
/// without reading its input reports through its exit status.
async fn feed_stdin(processes: Arc<dyn ProcessManager>, handle: ProcessHandle, input: Vec<u8>) {
    for chunk in input.chunks(STDIN_CHUNK) {
        loop {
            match processes.write_stdin(&handle, chunk.to_vec()).await {
                Err(ProcessError::Overloaded { .. }) => mixdog_rt::time::sleep(Duration::from_millis(2)).await,
                Err(_) => return,
                Ok(()) => break,
            }
        }
    }
    let _ = processes.close_stdin(&handle);
}

/// The child's owner for one run. Unless the run saw the child's exit or a kill take, dropping it
/// (an early return, a dropped future, a runtime shutdown) kills the child inline: a queued kill
/// task cannot promise that, as a shutdown drops it before it submits its job.
struct KillOnDrop {
    processes: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    settled: bool,
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self.processes.kill(&self.handle);
        }
    }
}

async fn run_process(processes: &Arc<dyn ProcessManager>, lane: DurabilityIo, bin: &str, args: &[String], options: RunOptions<'_>) -> ProcessResult {
    let (program, argv) = spawn_form(bin, args);
    let Some(cwd) = AbsPath::new(std::path::absolute(options.cwd).unwrap_or_else(|_| options.cwd.to_owned())) else {
        return ProcessResult { code: -1, error: format!("working directory {} is not absolute", options.cwd.display()), error_code: "InvalidInput".into(), ..Default::default() };
    };
    let handle = ProcessHandle(format!("tidy-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::Relaxed)));
    let env = match options.env {
        Some(env) => EnvSpec { inherit: false, set: env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(), remove: Vec::new() },
        None => EnvSpec { inherit: true, ..Default::default() },
    };
    let request = SpawnRequest {
        handle: handle.clone(),
        command: CommandSpec::Argv { program: program.clone(), args: argv },
        cwd,
        env,
        pty: None,
        stdin_piped: options.input.is_some(),
        output: OutputMode::Separate,
        owner: ProcessOwner::Internal,
        time_limit: (!options.timeout.is_zero()).then_some(options.timeout),
    };
    if let Err(error) = processes.spawn(request).await {
        return spawn_failure(error, &program);
    }
    let mut owner = KillOnDrop { processes: processes.clone(), handle: handle.clone(), settled: false };
    let mut events = match processes.subscribe(&handle, Some(0)) {
        Ok(events) => events,
        Err(error) => return spawn_failure(error, &program),
    };
    if let Some(input) = options.input.clone() {
        tokio::spawn(feed_stdin(processes.clone(), handle.clone(), input));
    }
    let cap = options.max_capture;
    let (mut stdout, mut stderr, mut combined, mut truncated) = (Vec::new(), Vec::new(), Vec::new(), false);
    let mut exit = None;
    let mut killed = false;
    // The kill in flight. Dropping a JoinHandle detaches the task, it does not cancel it: a run that
    // ends first leaves the job to answer AlreadyExited (the handle is never reused). Only a runtime
    // shutdown cancels the task, which is why owner, not this task, guarantees the kill.
    let mut kill: Option<tokio::task::JoinHandle<std::io::Result<Result<(), ProcessError>>>> = None;
    let never = CancellationToken::new();
    let cancel = options.cancel.unwrap_or(&never);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled(), if !killed => {
                killed = true;
                // The kill is a call into the OS; it runs on a lane, not on this thread. A lane that
                // refuses the job (full, wedged) or drops it never ran it, and the child would run on
                // with nobody left to kill it, so the kill is then issued below, inline: a brief block
                // beats a lost cancel (the lane-refusal rule: on_lane reports it as an error).
                let (processes, handle) = (processes.clone(), handle.clone());
                kill = Some(tokio::spawn(crate::lane::on_lane(lane, move || processes.kill(&handle))));
            }
            answer = async {
                match kill.as_mut() {
                    // A job the lane refused, or a task that panicked, never ran the kill.
                    Some(kill) => match kill.await { Ok(Ok(answer)) => answer, _ => processes.kill(&handle) },
                    None => std::future::pending().await,
                }
            }, if kill.is_some() => {
                kill = None;
                // The exit follows as an event; a kill that failed for any other reason leaves
                // nothing to wait for.
                match answer {
                    Ok(()) | Err(ProcessError::AlreadyExited) => owner.settled = true,
                    Err(error) => return ProcessResult { code: -1, error: format!("{program}: could not be killed ({error:?})"), error_code: "Other".into(), ..Default::default() },
                }
            }
            event = events.next() => match event {
                Some(ProcessEvent::Output { stream, bytes, .. }) => {
                    // Keep draining so the child never blocks on a full pipe.
                    let sink = if stream == OutputStream::Stderr { &mut stderr } else { &mut stdout };
                    let room = cap.saturating_sub(sink.len());
                    truncated |= bytes.len() > room;
                    sink.extend_from_slice(&bytes[..bytes.len().min(room)]);
                    combined.extend_from_slice(&bytes);
                    if combined.len() > cap {
                        combined.drain(..combined.len() - cap);
                    }
                }
                Some(ProcessEvent::Exited { exit: done, .. }) => {
                    exit = Some(done);
                    owner.settled = true;
                    break;
                }
                None => {
                    owner.settled = true;
                    break;
                }
            },
        }
    }
    let timed_out = exit.is_some_and(|e| e.killed == Some(KillReason::TimeLimit));
    ProcessResult {
        code: match exit.map(|e| e.status) {
            Some(ExitStatus::Code(code)) => code,
            _ => -1,
        },
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        combined: String::from_utf8_lossy(&combined).into_owned(),
        timed_out,
        truncated,
        error: if timed_out { format!("timed out after {}ms", options.timeout.as_millis()) } else { String::new() },
        error_code: String::new(),
    }
}

/// Bounded-concurrency map that preserves input order and never rejects early.
pub async fn map_limit<T, R, F, Fut>(items: Vec<T>, limit: usize, worker: F) -> Vec<R>
where
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    use futures::stream::{self, StreamExt};
    stream::iter(items.into_iter().map(worker)).buffered(limit.max(1)).collect().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[tokio::test]
    async fn output_is_captured_and_a_missing_binary_is_reported_not_thrown() {
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "echo hi & echo err 1>&2 & exit 3".into()]) } else { ("sh", vec!["-c".into(), "echo hi; echo err >&2; exit 3".into()]) };
        let result = Processes::for_tests().run(bin, &args, RunOptions::new(dir.path())).await;
        assert_eq!(result.code, 3);
        assert_eq!(result.stdout.trim(), "hi");
        assert_eq!(result.stderr.trim(), "err");
        let missing = Processes::for_tests().run("definitely-not-a-binary-xyz", &[], RunOptions::new(dir.path())).await;
        assert_eq!((missing.code, missing.error_code.as_str()), (-1, "NotFound"));
    }

    #[tokio::test]
    async fn a_timeout_kills_the_child_and_output_is_capped() {
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 30 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 30".into()]) };
        let mut options = RunOptions::new(dir.path());
        options.timeout = Duration::from_millis(300);
        let started = std::time::Instant::now();
        let result = Processes::for_tests().run(bin, &args, options).await;
        assert!(result.timed_out && started.elapsed() < Duration::from_secs(10));
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "echo 0123456789".into()]) } else { ("sh", vec!["-c".into(), "echo 0123456789".into()]) };
        let mut options = RunOptions::new(dir.path());
        options.max_capture = 4;
        let capped = Processes::for_tests().run(bin, &args, options).await;
        assert_eq!((capped.stdout.as_str(), capped.truncated), ("0123", true));
    }

    /// Cancelling kills the child through the real manager, and neither the kill nor the wait
    /// for the exit may hold the runtime's only thread. The manager's two test seams hold the
    /// kill (tree signalled, kill not yet returned) and then the exit finalizer (exit fixed, not
    /// yet published); at each hold a task spawned meanwhile has to run before the hold is
    /// released. A cancel path that runs the kill, or waits for it or for the exit, on the
    /// runtime thread never lets that task run, so the hold is never released and the test
    /// hangs. The lane backend is the real pooled one (the test backend runs lane jobs inline on
    /// the submitting thread, which would put the kill back on the runtime thread). The seams and
    /// the installed backend are process-wide, so this test needs a process of its own (nextest).
    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_kills_the_child_without_stalling_the_runtime() {
        async fn a_task_runs() {
            let (ran, saw) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _ = ran.send(());
            });
            saw.await.unwrap();
        }
        let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(2)).unwrap();
        let lane = tokens.durability_io;
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 60 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 60".into()]) };
        mixdog_spawn::testing::arm_kill_window();
        mixdog_spawn::testing::arm_exit_window();
        let cancel = CancellationToken::new();
        let mut options = RunOptions::new(dir.path());
        options.cancel = Some(&cancel);
        let processes = Processes::new(Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default())), lane);
        let run = processes.run(bin, &args, options);
        let drive = async {
            cancel.cancel();
            crate::lane::on_lane(lane, mixdog_spawn::testing::wait_kill_window_entered).await.unwrap();
            a_task_runs().await;
            mixdog_spawn::testing::release_kill_window();
            crate::lane::on_lane(lane, mixdog_spawn::testing::wait_exit_window_entered).await.unwrap();
            a_task_runs().await;
            mixdog_spawn::testing::release_exit_window();
        };
        let (result, ()) = tokio::join!(run, drive);
        assert!(!result.timed_out);
    }

    /// A lane that refuses the kill job must not lose the cancel: the kill is then issued inline,
    /// so the run returns having ended the child (a non-zero status), not hung on a child that runs out its own 60 s.
    #[tokio::test(flavor = "current_thread")]
    async fn a_kill_the_lane_refuses_is_issued_inline_and_the_run_returns() {
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 60 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 60".into()]) };
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut options = RunOptions::new(dir.path());
        options.cancel = Some(&cancel);
        let tokens = mixdog_rt::testing::tokens();
        let manager = Arc::new(RefusesAfterSpawn { inner: mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()), refusing: std::sync::Mutex::new(None) });
        let result = Processes::new(manager, tokens.durability_io).run(bin, &args, options).await;
        assert_ne!(result.code, 0, "the child must end by the kill, not by its own exit: {result:?}");
        assert!(result.error.is_empty() && !result.timed_out, "{result:?}");
    }

    /// The real manager, except that once a child is spawned the lane refuses every job from this
    /// thread (a full or wedged lane): only the cancel's kill job meets the refusal.
    struct RefusesAfterSpawn {
        inner: mixdog_spawn::LocalProcessManager,
        refusing: std::sync::Mutex<Option<mixdog_rt::testing::RefuseJobs>>,
    }

    #[async_trait::async_trait]
    impl ProcessManager for RefusesAfterSpawn {
        async fn spawn(&self, request: SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, ProcessError> {
            let spawned = self.inner.spawn(request).await?;
            *self.refusing.lock().unwrap() = Some(mixdog_rt::testing::refuse_jobs_on_this_thread());
            Ok(spawned)
        }
        fn subscribe(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<ProcessEvent>>, ProcessError> {
            self.inner.subscribe(handle, from_seq)
        }
        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            self.inner.write_stdin(handle, bytes).await
        }
        fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.inner.close_stdin(handle)
        }
        fn resize_pty(&self, handle: &ProcessHandle, size: mixdog_core_api::domain::process::PtySize) -> Result<(), ProcessError> {
            self.inner.resize_pty(handle, size)
        }
        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.inner.kill(handle)
        }
        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            self.inner.list()
        }
    }
    /// A runtime shutdown drops the queued kill task before it submits its lane job, and the run's
    /// future with it. The child must still end: the run's owner kills it as it drops.
    #[test]
    fn dropping_the_run_before_its_kill_job_is_submitted_still_kills_the_child() {
        use futures::FutureExt;
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 60 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 60".into()]) };
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut options = RunOptions::new(dir.path());
        options.cancel = Some(&cancel);
        let processes = Processes::for_tests();
        let manager = processes.manager();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let entered = rt.enter();
        let mut run = Box::pin(processes.run(bin, &args, options));
        // Polled by hand and the runtime never driven: once the child is up, the cancel has queued
        // the kill task, and nothing can run it. (The test backend runs the spawn inline, so the
        // run owns the child as soon as it is listed; the spawn still in flight is the test below.)
        while manager.list().is_empty() {
            assert!(run.as_mut().now_or_never().is_none());
        }
        assert!(run.as_mut().now_or_never().is_none());
        let child = manager.list().remove(0);
        assert!(child.exit.is_none(), "the child is still running");
        let mut events = manager.subscribe(&child.handle, Some(0)).unwrap();
        drop(entered);
        drop(rt);
        drop(run);
        let exit = futures::executor::block_on(async {
            loop {
                if let ProcessEvent::Exited { exit, .. } = events.next().await.expect("the child's exit is published") {
                    break exit;
                }
            }
        });
        assert_eq!(exit.killed, Some(KillReason::Requested));
        assert!(manager.list()[0].exit.is_some());
    }
    /// A run dropped while its spawn is in flight on a lane thread (a caller that goes away, a
    /// runtime shutdown) must not leave the child it creates running with nobody holding it. The
    /// spawn is parked at two seams, so each side of the commit is hit exactly, with no timing:
    /// - `before_launch`: the run is dropped before the child exists, so only the launch job, which
    ///   looks after committing whether the requester is still there, can kill it.
    /// - otherwise: the run is dropped after that look, with the child committed and the requester
    ///   not yet told, so only the spawn's own drop can kill it.
    /// The lane backend is the real pooled one (the test backend runs the spawn inline), and the
    /// seams and backend are process-wide, so each of these needs a process of its own (nextest).
    fn the_child_ends_when_the_run_is_dropped_during_its_spawn(before_launch: bool) {
        use futures::FutureExt;
        use mixdog_spawn::testing as seam;
        let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(2)).unwrap();
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 30 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 30".into()]) };
        let manager: Arc<dyn ProcessManager> = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let processes = Processes::new(manager.clone(), tokens.durability_io);
        seam::arm_answer_window();
        if before_launch {
            seam::arm_launch_window();
        }
        let mut run = Box::pin(processes.run(bin, &args, RunOptions::new(dir.path())));
        assert!(run.as_mut().now_or_never().is_none(), "the spawn is in flight");
        let mut run = Some(run);
        if before_launch {
            seam::wait_launch_window_entered();
            assert!(manager.list().is_empty(), "no child is committed yet");
            run = None;
            seam::release_launch_window();
            seam::wait_answer_window_entered();
        } else {
            seam::wait_answer_window_entered();
        }
        let child = manager.list().remove(0);
        let mut events = manager.subscribe(&child.handle, Some(0)).unwrap();
        drop(run);
        seam::release_answer_window();
        let exit = futures::executor::block_on(async {
            loop {
                if let ProcessEvent::Exited { exit, .. } = events.next().await.expect("the child's exit is published") {
                    break exit;
                }
            }
        });
        assert_eq!(exit.killed, Some(KillReason::Requested));
    }
    #[test]
    fn a_run_dropped_before_its_child_is_committed_still_ends_the_child() {
        the_child_ends_when_the_run_is_dropped_during_its_spawn(true);
    }
    #[test]
    fn a_run_dropped_after_its_child_is_committed_still_ends_the_child() {
        the_child_ends_when_the_run_is_dropped_during_its_spawn(false);
    }
    #[tokio::test(start_paused = true)]
    async fn map_limit_keeps_input_order() {
        let out = map_limit(vec![3u64, 1, 2], 2, |n| async move {
            mixdog_rt::time::sleep(Duration::from_millis(n * 10)).await;
            n * 2
        })
        .await;
        assert_eq!(out, vec![6, 2, 4]);
    }
}
