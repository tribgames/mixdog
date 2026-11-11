//! stdio transport: one child process, newline-delimited JSON on its stdin/stdout. The child
//! is created on the spawn lane; the process-group leader is killed as a group.

use mixdog_rt::InLane;
use mixdog_rt::Liveness;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::LaneToken;
use mixdog_rt::SpawnIo;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::containment::Containment;
use crate::cross_spawn;
use crate::cross_spawn::Launch;
use crate::transport::CloseCause;
use crate::transport::Incoming;
use crate::transport::IncomingRx;
use crate::transport::IncomingTx;
use crate::transport::Transport;
use crate::transport::TransportError;

/// Length of the stderr tail kept for error messages.
const STDERR_TAIL_CHARS: usize = 4096;

pub struct StdioSpec<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a BTreeMap<String, String>,
    pub cwd: Option<&'a str>,
    pub shutdown_grace: Duration,
}

pub struct StdioTransport {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    shutdown: CancellationToken,
    tail: Arc<Mutex<String>>,
}

/// The `cmd.exe /d /s /c "<line>"` of a command cross-spawn hands to the shell: the line is already
/// escaped, so it goes on the command line as it is.
fn shell_command(file: &str, args: &[String]) -> Command {
    let mut command = Command::new(file);
    #[cfg(windows)]
    {
        for arg in args {
            command.raw_arg(arg);
        }
    }
    #[cfg(not(windows))]
    {
        command.args(args);
    }
    command
}

/// Starts the server the way Node's SDK does ([`cross_spawn`]); a failed start reads as Node's
/// `spawn <command> <code>`.
fn start(lane: &InLane<SpawnIo>, command: &str, args: &[String], cwd: Option<&str>, env: &BTreeMap<String, String>) -> Result<Child, TransportError> {
    let (shown, mut process) = match cross_spawn::parse(lane, command, args, cwd, env) {
        Launch::Direct { shown, program, args } => {
            let mut process = Command::new(program);
            process.args(args);
            (shown, process)
        }
        Launch::Shell { file, args } => (file.clone(), shell_command(&file, &args)),
    };
    process
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    #[cfg(unix)]
    process.process_group(0);
    #[cfg(windows)]
    process.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    process.spawn().map_err(|source| TransportError::Spawn {
        file: shown,
        code: crate::uv_error::error_code(&source).unwrap_or("UNKNOWN"),
        source,
    })
}

fn push_tail(tail: &Mutex<String>, chunk: &str) {
    let mut guard = tail.lock().unwrap_or_else(|e| e.into_inner());
    guard.push_str(chunk);
    let excess = guard.chars().count().saturating_sub(STDERR_TAIL_CHARS);
    if excess > 0 {
        let cut = guard.char_indices().nth(excess).map_or(guard.len(), |(i, _)| i);
        guard.drain(..cut);
    }
}

/// Ends the whole tree (job object / process group); the direct kill covers a failed attach.
fn kill_tree(child: &mut Child, containment: Option<&Containment>) {
    if let Some(containment) = containment {
        containment.terminate();
    }
    let _ = child.start_kill();
}

impl StdioTransport {
    pub async fn spawn(io: SpawnIo, spec: StdioSpec<'_>) -> Result<(Self, IncomingRx), TransportError> {
        // Resolving the command and creating the process block, so both run on the spawn lane; the
        // child registers with this runtime's reactor.
        let runtime = tokio::runtime::Handle::current();
        let (command, args, cwd, env) =
            (spec.command.to_owned(), spec.args.to_vec(), spec.cwd.map(str::to_owned), spec.env.clone());
        let job = io
            .submit(&CancellationToken::new(), move |lane| {
                let _entered = runtime.enter();
                start(lane, &command, &args, cwd.as_deref(), &env)
            })
            .map_err(|_| TransportError::LaneFull)?;
        let mut child = job.await.map_err(|_| TransportError::Closed)??;

        let containment = Containment::attach(&child).ok();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        let (outgoing, outgoing_rx) = mpsc::unbounded_channel();
        let shutdown = CancellationToken::new();
        let tail = Arc::new(Mutex::new(String::new()));

        if let Some(stdin) = stdin {
            mixdog_rt::spawn("mcp.stdio.write", TaskClass::Work, write_loop(stdin, outgoing_rx, shutdown.clone()));
        }
        let reader = stdout.map(|out| {
            mixdog_rt::spawn("mcp.stdio.read", TaskClass::Work, read_loop(out, incoming_tx.clone()))
        });
        let stderr_reader = stderr.map(|err| {
            mixdog_rt::spawn("mcp.stdio.stderr", TaskClass::Work, stderr_loop(err, tail.clone()))
        });
        mixdog_rt::spawn(
            "mcp.stdio.supervise",
            TaskClass::Work,
            supervise(
                child,
                containment,
                shutdown.clone(),
                spec.shutdown_grace,
                (reader, stderr_reader),
                tail.clone(),
                incoming_tx,
            ),
        );
        Ok((Self { outgoing, shutdown, tail }, incoming_rx))
    }
}

async fn write_loop(
    mut stdin: tokio::process::ChildStdin,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    shutdown: CancellationToken,
) {
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            line = rx.recv() => {
                let Some(line) = line else { break };
                if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn read_loop(stdout: tokio::process::ChildStdout, tx: IncomingTx) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let trimmed = line.trim_ascii();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_slice::<Value>(trimmed) {
            Ok(message) => {
                if tx.send(Incoming::Message(message)).is_err() {
                    return;
                }
            }
            Err(error) => tracing::warn!(%error, "mcp stdio: line is not JSON"),
        }
    }
}

async fn stderr_loop(mut stderr: tokio::process::ChildStderr, tail: Arc<Mutex<String>>) {
    let mut buf = [0u8; 2048];
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => push_tail(&tail, &String::from_utf8_lossy(&buf[..n])),
        }
    }
}

async fn supervise(
    mut child: Child,
    containment: Option<Containment>,
    shutdown: CancellationToken,
    grace: Duration,
    (reader, stderr_reader): (Option<tokio::task::JoinHandle<()>>, Option<tokio::task::JoinHandle<()>>),
    tail: Arc<Mutex<String>>,
    tx: IncomingTx,
) {
    let status = tokio::select! {
        status = child.wait() => status,
        () = shutdown.cancelled() => {
            // stdin is closed by the writer; a well-behaved server exits within the grace.
            match mixdog_rt::time::timeout(grace, child.wait()).await {
                Ok(status) => status,
                Err(_) => {
                    kill_tree(&mut child, containment.as_ref());
                    child.wait().await
                }
            }
        }
    };
    if let Some(containment) = &containment {
        containment.mark_exited();
    }
    // Messages the child wrote before exiting are delivered before `Closed`.
    if let Some(reader) = reader {
        let _ = mixdog_rt::time::timeout(grace, reader).await;
    }
    // The tail is complete only once stderr was read to its end.
    // A descendant that keeps the pipe open ends the wait by abort, so the reader neither outlives
    // this task nor races the snapshot below.
    if let Some(mut stderr_reader) = stderr_reader
        && mixdog_rt::time::timeout(grace, &mut stderr_reader).await.is_err()
    {
        stderr_reader.abort();
        let _ = stderr_reader.await;
    }
    let reason = match status {
        Ok(status) => format!("process exited: {status}"),
        Err(error) => format!("process wait failed: {error}"),
    };
    let stderr_tail = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let _ = tx.send(Incoming::Closed(CloseCause { reason, stderr_tail }));
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn send(&self, message: Value, _liveness: Liveness) -> Result<(), TransportError> {
        let mut bytes =
            serde_json::to_vec(&message).map_err(|e| TransportError::Request(e.to_string()))?;
        bytes.push(b'\n');
        self.outgoing.send(bytes).map_err(|_| TransportError::Closed)
    }

    async fn close(&self) {
        self.shutdown.cancel();
    }

    fn stderr_tail(&self) -> String {
        self.tail.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
