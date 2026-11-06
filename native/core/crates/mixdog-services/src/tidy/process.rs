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
    /// issues the manager's tree kill and waits for the exit event, never blocking the runtime.
    pub async fn run(&self, bin: &str, args: &[String], options: RunOptions<'_>) -> ProcessResult {
        run_process(&self.0, bin, args, options).await
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
                Err(ProcessError::Overloaded { .. }) => tokio::time::sleep(Duration::from_millis(2)).await,
                Err(_) => return,
                Ok(()) => break,
            }
        }
    }
    let _ = processes.close_stdin(&handle);
}

async fn run_process(processes: &Arc<dyn ProcessManager>, bin: &str, args: &[String], options: RunOptions<'_>) -> ProcessResult {
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
    let never = CancellationToken::new();
    let cancel = options.cancel.unwrap_or(&never);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled(), if !killed => {
                killed = true;
                let _ = processes.kill(&handle);
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
                    break;
                }
                None => break,
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
    use std::sync::Mutex;

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

    /// The real manager, except that once a kill was issued the child's exit event is held back
    /// for `HOLD`: the kill is in flight for a known window.
    struct SlowExit {
        inner: Arc<dyn ProcessManager>,
        killed: Arc<std::sync::atomic::AtomicBool>,
    }

    struct HeldExit {
        inner: Box<dyn mixdog_core_api::domain::common::EventSource<ProcessEvent>>,
        killed: Arc<std::sync::atomic::AtomicBool>,
    }

    const HOLD: Duration = Duration::from_millis(400);

    #[async_trait::async_trait]
    impl mixdog_core_api::domain::common::EventSource<ProcessEvent> for HeldExit {
        async fn next(&mut self) -> Option<ProcessEvent> {
            let event = self.inner.next().await;
            if matches!(event, Some(ProcessEvent::Exited { .. })) && self.killed.load(Ordering::SeqCst) {
                tokio::time::sleep(HOLD).await;
            }
            event
        }
    }

    #[async_trait::async_trait]
    impl ProcessManager for SlowExit {
        async fn spawn(&self, request: SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, ProcessError> {
            self.inner.spawn(request).await
        }
        fn subscribe(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<ProcessEvent>>, ProcessError> {
            Ok(Box::new(HeldExit { inner: self.inner.subscribe(handle, from_seq)?, killed: self.killed.clone() }))
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
            self.killed.store(true, Ordering::SeqCst);
            self.inner.kill(handle)
        }
        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            self.inner.list()
        }
    }

    /// The cancel path used to wait for `taskkill` on the runtime thread: on this single-threaded
    /// runtime a ticker could not run for the whole kill. The exit is held for `HOLD`, so the
    /// ticker must keep sampling through that window.
    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_kills_the_child_without_stalling_the_runtime() {
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 60 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 60".into()]) };
        let real = Processes::for_tests();
        let processes = Processes::new(Arc::new(SlowExit { inner: real.0.clone(), killed: Arc::default() }), real.1);
        let cancel = CancellationToken::new();
        let killing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let gaps = Arc::new(Mutex::new(Vec::<Duration>::new()));
        let ticker = tokio::spawn({
            let (killing, gaps) = (killing.clone(), gaps.clone());
            async move {
                let mut last = std::time::Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    let now = std::time::Instant::now();
                    if killing.load(Ordering::SeqCst) {
                        gaps.lock().unwrap().push(now - last);
                    }
                    last = now;
                }
            }
        });
        let trigger = tokio::spawn({
            let (cancel, killing) = (cancel.clone(), killing.clone());
            async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                killing.store(true, Ordering::SeqCst);
                cancel.cancel();
            }
        });
        let mut options = RunOptions::new(dir.path());
        options.cancel = Some(&cancel);
        let started = std::time::Instant::now();
        let result = processes.run(bin, &args, options).await;
        let finished = started.elapsed();
        killing.store(false, Ordering::SeqCst);
        ticker.abort();
        trigger.await.unwrap();
        assert!(finished >= Duration::from_millis(500) + HOLD && finished < Duration::from_secs(20) && !result.timed_out);
        let gaps = gaps.lock().unwrap();
        // The kill is in flight for HOLD (400 ms): a blocked runtime takes no samples in it.
        assert!(gaps.len() >= 20, "only {} ticker samples while the kill was in flight", gaps.len());
        let longest = gaps.iter().max().copied().unwrap();
        assert!(longest < Duration::from_millis(150), "the runtime thread stalled for {longest:?} while the child was killed");
    }

    #[tokio::test]
    async fn map_limit_keeps_input_order() {
        let out = map_limit(vec![3u64, 1, 2], 2, |n| async move {
            tokio::time::sleep(Duration::from_millis(n * 10)).await;
            n * 2
        })
        .await;
        assert_eq!(out, vec![6, 2, 4]);
    }
}
