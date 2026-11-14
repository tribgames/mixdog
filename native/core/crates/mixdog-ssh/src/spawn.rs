//! Starting the system OpenSSH tools: the argument rewriting every spawn gets (`-F`, the attempt's identity file, the
//! askpass environment), the process spawner over the one process manager, the recording of each spawn in the
//! diagnostics ring, and the short `ssh <target> <command>` run with its capture cap and deadline.

use std::collections::BTreeMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mixdog_core_api::domain::common::{AbsPath, EventSource};
use mixdog_core_api::domain::process::{
    CommandSpec, EnvSpec, ExitStatus, OutputMode, OutputStream, ProcessError, ProcessEvent, ProcessManager, ProcessOwner,
    SpawnRequest,
};
use mixdog_protocol::ProcessHandle;
use mixdog_rt::{CancellationToken, LaneToken};
use mixdog_spawn::LocalProcessManager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch};

use crate::binary::{missing_client_message, ssh_tool_command};
use crate::command::{classify_failure, exec_args, stderr_tail_default, FailureClass, SshError, SshTarget};
use crate::context::{AttemptContext, ChildExit, PreparedSpawn, SshChild, SshEnv, SshSpawner};
use crate::diagnostics::SpawnTrace;

/// Bytes kept of what a short ssh run printed (both streams together).
pub const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
/// Bytes of one stdin write or one read of a pipe.
const CHUNK: usize = 64 * 1024;

/// `~` or `~/x` (either separator) in front of a path is this user's home folder.
fn expand_home(env: &SshEnv, path: &str) -> String {
    if path == "~" {
        return env.home.to_string_lossy().into_owned();
    }
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => env.home.join(rest.trim_start_matches(['/', '\\'])).to_string_lossy().into_owned(),
        None => path.to_owned(),
    }
}

fn prepend(list: &mut Vec<String>, items: impl IntoIterator<Item = String>) {
    let mut head: Vec<String> = items.into_iter().collect();
    head.append(list);
    *list = head;
}

/// What a spawn really runs: the resolved ssh binary, Mixdog's own config (`-F`), the attempt's identity file, and,
/// only while an interactive retry is running, the askpass environment with BatchMode off.
pub fn prepare_spawn(env: &SshEnv, command: &str, args: &[String], context: Option<&AttemptContext>) -> PreparedSpawn {
    let mut list = args.to_vec();
    let mut vars = None;
    if command == "ssh" {
        // The target's own generated config when there is one (resolved options, no forwards), else the generic
        // one; a caller that passes its own -F keeps it.
        let config_file = env.config_files.for_args(&list).or_else(|| env.config_files.generic());
        if let Some(file) = config_file {
            if !list.iter().any(|arg| arg == "-F") {
                prepend(&mut list, ["-F".to_owned(), file.to_string_lossy().into_owned()]);
            }
        }
        let identity = context.and_then(|attempt| attempt.settings.as_ref()).and_then(|settings| settings.identity_file.as_deref()).map(str::trim);
        if let Some(identity) = identity.filter(|file| !file.is_empty()) {
            prepend(&mut list, ["-i".to_owned(), expand_home(env, identity), "-o".to_owned(), "IdentitiesOnly=yes".to_owned()]);
        }
        if let Some(session) = context.and_then(|attempt| attempt.askpass.as_ref()).filter(|session| !session.closed()) {
            for arg in &mut list {
                if arg == "BatchMode=yes" {
                    *arg = "BatchMode=no".to_owned();
                }
            }
            // One login for the attempt's short commands: the first ssh keeps a master that the rest reuse. The
            // long-lived tunnel (-N) only joins one, so it never turns into a background master the supervisor
            // would lose.
            if let Some(control_dir) = session.control_dir().filter(|_| !env.platform.is_windows()) {
                let joins = list.iter().any(|arg| arg == "-N");
                for arg in &mut list {
                    if arg == "ControlMaster=no" {
                        if !joins {
                            *arg = "ControlMaster=auto".to_owned();
                        }
                    } else if arg == "ControlPath=none" {
                        *arg = format!("ControlPath={}/%C", control_dir.display());
                    }
                }
                if !joins {
                    prepend(&mut list, ["-o".to_owned(), "ControlPersist=30".to_owned()]);
                }
            }
            let mut merged: BTreeMap<String, String> = env.env.clone();
            merged.extend(session.env());
            merged.insert("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned());
            merged.insert("DISPLAY".to_owned(), env.var("DISPLAY").filter(|display| !display.is_empty()).unwrap_or("localhost:0").to_owned());
            vars = Some(merged);
        }
    }
    PreparedSpawn { command: ssh_tool_command(command, env), args: list, env: vars }
}

// ---- the process spawner ----

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(0);

/// Starts ssh processes under the one process manager: a job object / process group with a hidden console on
/// Windows, so the children end with this process, and a tree kill. Arguments are an array, never a shell string.
pub struct ProcessSpawner<L: LaneToken> {
    manager: Arc<LocalProcessManager>,
    lane: L,
}

impl<L: LaneToken> ProcessSpawner<L> {
    /// `lane` is the lane the tree kill is issued on (it is a call into the OS).
    pub fn new(manager: Arc<LocalProcessManager>, lane: L) -> Self {
        Self { manager, lane }
    }
}

fn process_error(error: &ProcessError, program: &str) -> io::Error {
    match error {
        ProcessError::ProgramNotFound { .. } => io::Error::new(io::ErrorKind::NotFound, format!("{program}: program not found")),
        ProcessError::PermissionDenied => io::Error::new(io::ErrorKind::PermissionDenied, format!("{program}: permission denied")),
        other => io::Error::other(format!("{program}: could not start ({other:?})")),
    }
}

fn signal_name(number: i32) -> String {
    match number {
        1 => "SIGHUP".to_owned(),
        2 => "SIGINT".to_owned(),
        9 => "SIGKILL".to_owned(),
        15 => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
    }
}

/// An `AsyncRead` over the chunks a driver task sends; the end of the channel is the end of the stream.
struct ChannelReader {
    chunks: mpsc::UnboundedReceiver<Vec<u8>>,
    pending: Vec<u8>,
    at: usize,
}

impl AsyncRead for ChannelReader {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if this.at < this.pending.len() {
                let count = buf.remaining().min(this.pending.len() - this.at);
                buf.put_slice(&this.pending[this.at..this.at + count]);
                this.at += count;
                return Poll::Ready(Ok(()));
            }
            match this.chunks.poll_recv(cx) {
                Poll::Ready(Some(chunk)) => {
                    this.pending = chunk;
                    this.at = 0;
                }
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// What the driver task of one child holds.
struct Driver<L: LaneToken> {
    manager: Arc<LocalProcessManager>,
    lane: L,
    request: SpawnRequest,
    program: String,
    stdout: mpsc::UnboundedSender<Vec<u8>>,
    stderr: mpsc::UnboundedSender<Vec<u8>>,
    stdin: DuplexStream,
    kill: watch::Receiver<bool>,
    exit: oneshot::Sender<io::Result<ChildExit>>,
}

/// The tree kill, as a lane job; a lane that refuses or drops it never ran it, and the child would run on with nobody
/// left to kill it, so the kill is then issued inline.
async fn kill_on_lane<L: LaneToken>(manager: Arc<LocalProcessManager>, lane: L, handle: ProcessHandle) {
    let job = {
        let (manager, handle) = (manager.clone(), handle.clone());
        lane.submit_wait(&CancellationToken::new(), move |_| {
            let _ = manager.kill(&handle);
        })
        .await
    };
    let ran = match job {
        Ok(job) => job.await.is_ok(),
        Err(_) => false,
    };
    if !ran {
        let _ = manager.kill(&handle);
    }
}

/// Feeds what the caller writes to the child's stdin in bounded writes and closes the input at the end of it.
async fn feed_stdin(manager: Arc<LocalProcessManager>, handle: ProcessHandle, mut input: DuplexStream) {
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        match input.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if manager.write_stdin_whole(&handle, buffer[..count].to_vec()).await.is_err() {
                    return;
                }
            }
        }
    }
    let _ = manager.close_stdin(&handle);
}

async fn drive<L: LaneToken>(driver: Driver<L>) {
    let Driver { manager, lane, request, program, stdout, stderr, stdin, mut kill, exit } = driver;
    let handle = request.handle.clone();
    let mut events = match manager.spawn_subscribed(request).await {
        Ok((_, events)) => events,
        Err(error) => {
            let _ = exit.send(Err(process_error(&error, &program)));
            return;
        }
    };
    tokio::spawn(feed_stdin(manager.clone(), handle.clone(), stdin));
    let mut kill_issued = false;
    let outcome = loop {
        tokio::select! {
            biased;
            _ = kill.changed(), if !kill_issued => {
                kill_issued = true;
                tokio::spawn(kill_on_lane(manager.clone(), lane, handle.clone()));
            }
            event = events.next() => match event {
                Some(ProcessEvent::Output { stream, bytes, .. }) => {
                    // A reader that is gone loses the bytes; the child is never left blocked on a full pipe.
                    let _ = if stream == OutputStream::Stderr { stderr.send(bytes) } else { stdout.send(bytes) };
                }
                Some(ProcessEvent::Exited { exit: done, .. }) => {
                    break Ok(match done.status {
                        ExitStatus::Code(code) => ChildExit { code: Some(code), signal: None },
                        ExitStatus::Signal(number) => ChildExit { code: None, signal: Some(signal_name(number)) },
                    });
                }
                None => break Err(io::Error::other(format!("{program}: the process ended without an exit"))),
            },
        }
    };
    let _ = exit.send(outcome);
}

/// A child under the process manager. Dropping it before it ended kills it.
struct ManagedChild {
    stdin: Option<DuplexStream>,
    stdout: Option<ChannelReader>,
    stderr: Option<ChannelReader>,
    exit: oneshot::Receiver<io::Result<ChildExit>>,
    outcome: Option<Result<ChildExit, (io::ErrorKind, String)>>,
    kill: watch::Sender<bool>,
}

#[async_trait]
impl SshChild for ManagedChild {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.stdin.take().map(|stream| Box::new(stream) as Box<dyn AsyncWrite + Send + Unpin>)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stdout.take().map(|reader| Box::new(reader) as Box<dyn AsyncRead + Send + Unpin>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stderr.take().map(|reader| Box::new(reader) as Box<dyn AsyncRead + Send + Unpin>)
    }

    async fn wait(&mut self) -> io::Result<ChildExit> {
        if self.outcome.is_none() {
            let settled = match (&mut self.exit).await {
                Ok(Ok(done)) => Ok(done),
                Ok(Err(error)) => Err((error.kind(), error.to_string())),
                Err(_) => Err((io::ErrorKind::Other, "the process driver ended without an answer".to_owned())),
            };
            self.outcome = Some(settled);
        }
        match &self.outcome {
            Some(Ok(done)) => Ok(done.clone()),
            Some(Err((kind, message))) => Err(io::Error::new(*kind, message.clone())),
            None => Err(io::Error::other("no outcome")),
        }
    }

    fn kill(&mut self) {
        self.kill.send_replace(true);
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if self.outcome.is_none() {
            self.kill.send_replace(true);
        }
    }
}

impl<L: LaneToken> SshSpawner for ProcessSpawner<L> {
    /// The process is created by a task on the current runtime: a start that fails (the tool is not installed) is
    /// the error of [`SshChild::wait`], as a failed start was the child's `error` event.
    fn spawn(&self, prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| io::Error::other("no async runtime to start ssh on"))?;
        let program = prepared.command.to_string_lossy().into_owned();
        let cwd = std::env::current_dir().ok().and_then(AbsPath::new).or_else(|| AbsPath::new(std::env::temp_dir())).ok_or_else(|| io::Error::other("no absolute working directory"))?;
        let env = match &prepared.env {
            Some(vars) => EnvSpec { inherit: false, set: vars.iter().map(|(key, value)| (key.clone(), value.clone())).collect(), remove: Vec::new() },
            None => EnvSpec { inherit: true, ..Default::default() },
        };
        let request = SpawnRequest {
            handle: ProcessHandle(format!("ssh-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::Relaxed))),
            command: CommandSpec::Argv { program: program.clone(), args: prepared.args.clone() },
            cwd,
            env,
            pty: None,
            stdin_piped: true,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: None,
        };
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel();
        let (stdin_writer, stdin_reader) = tokio::io::duplex(CHUNK);
        let (kill_tx, kill_rx) = watch::channel(false);
        let (exit_tx, exit_rx) = oneshot::channel();
        runtime.spawn(drive(Driver {
            manager: self.manager.clone(),
            lane: self.lane,
            request,
            program,
            stdout: stdout_tx,
            stderr: stderr_tx,
            stdin: stdin_reader,
            kill: kill_rx,
            exit: exit_tx,
        }));
        Ok(Box::new(ManagedChild {
            stdin: Some(stdin_writer),
            stdout: Some(ChannelReader { chunks: stdout_rx, pending: Vec::new(), at: 0 }),
            stderr: Some(ChannelReader { chunks: stderr_rx, pending: Vec::new(), at: 0 }),
            exit: exit_rx,
            outcome: None,
            kill: kill_tx,
        }))
    }
}

// ---- the recording of a spawn ----

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

type SharedTrace = Arc<Mutex<SpawnTrace>>;

fn with_trace(trace: &SharedTrace, work: impl FnOnce(&mut SpawnTrace)) {
    work(&mut trace.lock().unwrap_or_else(PoisonError::into_inner));
}

/// A stream that tells the trace what passes through it.
struct Tee {
    inner: Box<dyn AsyncRead + Send + Unpin>,
    trace: SharedTrace,
    stdout: bool,
}

impl AsyncRead for Tee {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(polled, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            let chunk = &buf.filled()[before..];
            let now = now_ms();
            if self.stdout {
                with_trace(&self.trace, |trace| trace.stdout(chunk, now));
            } else {
                with_trace(&self.trace, |trace| trace.stderr(chunk, now));
            }
        }
        polled
    }
}

/// An ssh child whose output, start failure and exit go to the diagnostics ring.
struct TracedChild {
    inner: Box<dyn SshChild>,
    trace: SharedTrace,
    ended: bool,
}

#[async_trait]
impl SshChild for TracedChild {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.inner.take_stdin()
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        let trace = self.trace.clone();
        self.inner.take_stdout().map(|inner| Box::new(Tee { inner, trace, stdout: true }) as Box<dyn AsyncRead + Send + Unpin>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        let trace = self.trace.clone();
        self.inner.take_stderr().map(|inner| Box::new(Tee { inner, trace, stdout: false }) as Box<dyn AsyncRead + Send + Unpin>)
    }

    async fn wait(&mut self) -> io::Result<ChildExit> {
        let waited = self.inner.wait().await;
        if !self.ended {
            self.ended = true;
            let now = now_ms();
            match &waited {
                Ok(done) => with_trace(&self.trace, |trace| trace.closed(done.code, done.signal.as_deref(), now)),
                Err(error) => with_trace(&self.trace, |trace| trace.start_failed(&error.to_string(), now)),
            }
        }
        waited
    }

    fn kill(&mut self) {
        self.inner.kill();
    }
}

/// Starts one OpenSSH tool as an attempt of `context` runs it (see [`prepare_spawn`]) and records it in the
/// diagnostics ring of the attempt's server.
pub fn spawn_ssh(env: &SshEnv, command: &str, args: &[String], context: Option<&AttemptContext>) -> io::Result<Box<dyn SshChild>> {
    let prepared = prepare_spawn(env, command, args, context);
    let key = context.and_then(|attempt| attempt.diagnostics_key.as_deref());
    let trace = env.diagnostics.trace_spawn(command, &prepared.args, key, now_ms());
    match env.spawner.spawn(&prepared) {
        Ok(inner) => Ok(Box::new(TracedChild { inner, trace: Arc::new(Mutex::new(trace)), ended: false })),
        Err(error) => {
            trace.start_failed(&error.to_string(), now_ms());
            Err(error)
        }
    }
}

// ---- the short exec ----

/// One short `ssh <target> <command>` run.
pub struct ExecOptions {
    pub target: SshTarget,
    /// Remote command line, interpreted by the login shell on the server.
    pub command: String,
    /// Bytes streamed to the remote command's stdin.
    pub input: Option<Vec<u8>>,
    /// Hard deadline: the ssh child is killed when it passes.
    pub timeout: Duration,
    pub context: Option<AttemptContext>,
}

/// What the remote command printed and its exit code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Reads a stream to its end; the bytes past the shared cap are dropped (a chunk that crosses it is kept whole), and
/// the reading goes on so the child never blocks on a full pipe.
async fn capture(stream: Option<Box<dyn AsyncRead + Send + Unpin>>, sink: &Mutex<Vec<u8>>, captured: &AtomicUsize) {
    let Some(mut stream) = stream else { return };
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(count) => {
                if captured.load(Ordering::Relaxed) < MAX_CAPTURE_BYTES {
                    captured.fetch_add(count, Ordering::Relaxed);
                    sink.lock().unwrap_or_else(PoisonError::into_inner).extend_from_slice(&buffer[..count]);
                }
            }
        }
    }
}

/// Writes the input and ends the child's stdin; a child that stopped reading is reported by its exit.
async fn feed(stdin: Option<Box<dyn AsyncWrite + Send + Unpin>>, input: Option<Vec<u8>>) {
    let Some(mut stdin) = stdin else { return };
    if let Some(bytes) = input {
        let _ = stdin.write_all(&bytes).await;
    }
    let _ = stdin.shutdown().await;
}

/// Runs one remote command over a fresh ssh connection. Resolves with the remote exit code; an `Err` when ssh itself
/// failed (exit 255, a start failure, the deadline).
pub async fn ssh_exec(env: &SshEnv, options: ExecOptions) -> Result<ExecOutput, SshError> {
    let args = exec_args(&options.target, &options.command);
    let mut child = spawn_ssh(env, "ssh", &args, options.context.as_ref())
        .map_err(|error| SshError::new(format!("Could not start ssh: {error}"), FailureClass::Terminal))?;
    let (stdout, stderr) = (Mutex::new(Vec::new()), Mutex::new(Vec::new()));
    let captured = AtomicUsize::new(0);
    let deadline = mixdog_rt::time::Instant::now() + options.timeout;
    let mut timed_out = false;
    {
        let (stdin_pipe, stdout_pipe, stderr_pipe) = (child.take_stdin(), child.take_stdout(), child.take_stderr());
        let streams = async {
            tokio::join!(feed(stdin_pipe, options.input), capture(stdout_pipe, &stdout, &captured), capture(stderr_pipe, &stderr, &captured));
        };
        tokio::pin!(streams);
        let in_time = tokio::select! {
            () = &mut streams => true,
            () = mixdog_rt::time::sleep_until(deadline) => false,
        };
        if !in_time {
            timed_out = true;
            // The streams end with the child: the tree kill closes every pipe, a grandchild's included.
            child.kill();
            streams.await;
        }
    }
    let exit = if timed_out {
        child.wait().await
    } else {
        match mixdog_rt::time::timeout_at(deadline, child.wait()).await {
            Ok(done) => done,
            Err(_) => {
                timed_out = true;
                child.kill();
                child.wait().await
            }
        }
    };
    let exit = match exit {
        Ok(done) => done,
        Err(error) => {
            let message = if error.kind() == io::ErrorKind::NotFound { missing_client_message("ssh") } else { format!("ssh failed to start: {error}") };
            return Err(SshError::new(message, FailureClass::Terminal));
        }
    };
    let err_text = String::from_utf8_lossy(&stderr.lock().unwrap_or_else(PoisonError::into_inner)).into_owned();
    let tail = stderr_tail_default(&err_text);
    let display = &options.target.display;
    if timed_out {
        let suffix = if tail.is_empty() { String::new() } else { format!("\n{tail}") };
        return Err(SshError::new(format!("ssh {display} timed out after {} ms.{suffix}", options.timeout.as_millis()), FailureClass::Transient).with_stderr(tail, None));
    }
    if exit.code.is_none() || exit.code == Some(255) {
        let reason = if !tail.is_empty() {
            tail.clone()
        } else if let Some(signal) = &exit.signal {
            format!("ssh exited on {signal}")
        } else {
            "ssh exited with status 255".to_owned()
        };
        return Err(SshError::new(format!("ssh {display} failed:\n{reason}"), classify_failure(&err_text)).with_stderr(tail, exit.code));
    }
    Ok(ExecOutput { exit_code: exit.code.unwrap_or_default(), stdout: String::from_utf8_lossy(&stdout.lock().unwrap_or_else(PoisonError::into_inner)).into_owned(), stderr: err_text })
}

#[cfg(test)]
#[path = "spawn_tests.rs"]
mod spawn_tests;
