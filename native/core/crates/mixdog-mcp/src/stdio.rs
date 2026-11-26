//! stdio transport: one child process, newline-delimited JSON on its stdin/stdout. The child
//! is created on the spawn lane; the process-group leader is killed as a group.

use mixdog_rt::InLane;
use mixdog_rt::Liveness;
use mixdog_tools::exec::codepage::ShellStreamDecoder;
use mixdog_tools::exec::codepage::host_oem;
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

use crate::config::LogQueue;
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
    /// The server's name in its stderr log lines.
    pub name: &'a str,
    /// Values scrubbed from its stderr besides the credential shapes.
    pub secrets: &'a [String],
    /// The configured `stderr` option: `ignore` leaves no pipe; anything else, `inherit` included, is piped and redacted.
    pub stderr: &'a str,
    /// Where its stderr lines are logged; none while `MIXDOG_QUIET_MCP_LOG` quiets the client's log (`mcpLog`).
    pub log: Option<Arc<LogQueue>>,
}

pub struct StdioTransport {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    shutdown: CancellationToken,
    stopped: CancellationToken,
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
fn start(
    lane: &InLane<SpawnIo>,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    stderr: std::process::Stdio,
) -> Result<(Child, Containment), TransportError> {
    let (shown, mut process) = match cross_spawn::parse(lane, command, args, cwd, env) {
        Launch::Direct { shown, program, args } => {
            let mut process = Command::new(program);
            process.args(args);
            (shown, process)
        }
        Launch::Shell { file, args } => (file.clone(), shell_command(&file, &args)),
    };
    process.env_clear().envs(env);
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    spawn_contained(process, &shown, stderr).map_err(|(error, _child)| error)
}

/// Creates `process` with piped stdio and puts it under containment. A tree that cannot be contained is not started: the
/// server would outlive its kill. The child of a failed attach (never resumed) is ended and handed back with the error.
#[allow(clippy::result_large_err, reason = "Preserve child ownership on attach failure without a new allocation in the cleanup path")]
fn spawn_contained(mut process: Command, shown: &str, stderr: std::process::Stdio) -> Result<(Child, Containment), (TransportError, Option<Child>)> {
    process.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(stderr).kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    // CREATE_NO_WINDOW | CREATE_SUSPENDED: the child joins its job before it runs (`Containment::attach`).
    #[cfg(windows)]
    process.creation_flags(0x0800_0000 | 0x0000_0004);
    let spawn_error =
        |source: std::io::Error| TransportError::Spawn { file: shown.to_owned(), code: crate::uv_error::error_code(&source).unwrap_or("UNKNOWN"), source };
    let mut child = process.spawn().map_err(|source| (spawn_error(source), None))?;
    match Containment::attach(&child) {
        Ok(containment) => Ok((child, containment)),
        Err(source) => {
            let _ = child.start_kill();
            Err((spawn_error(source), Some(child)))
        }
    }
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

/// How long a killed leader is given to exit before the close settles without it.
const KILL_SETTLE: Duration = Duration::from_secs(5);

/// Resolves once the leader exited, with whether its tree may still be signalled. On Windows the job handle names the tree,
/// reaped or not. On Unix the leader is left unreaped: its zombie keeps the process-group id from being reused until
/// [`Child::wait`] reaps it, so the group signalled meanwhile is still this server's.
#[cfg(windows)]
async fn leader_exited(child: &mut Child) -> bool {
    let _ = child.wait().await;
    true
}

#[cfg(unix)]
async fn leader_exited(child: &mut Child) -> bool {
    // Reaped already (or never started): its group id may belong to anyone now.
    let Some(pid) = child.id() else { return false };
    // Registered before the first look, so an exit between a look and the wait still wakes it.
    let mut exits = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).ok();
    loop {
        // `siginfo_t` holds a raw pointer, so it must not live across the await below (the future is spawned and must be `Send`).
        let state = {
            // SAFETY: an all-zero `siginfo_t` is a valid value of the plain C struct.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: `info` is a valid out-parameter; `WNOWAIT` leaves the child waitable, `WNOHANG` returns at once.
            let looked = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
            if looked != 0 { Err(std::io::Error::last_os_error().raw_os_error()) } else { Ok(info.si_signo == libc::SIGCHLD) }
        };
        match state {
            Err(Some(libc::EINTR)) => continue,
            Err(_) => return false,
            Ok(true) => return true,
            Ok(false) => {}
        }
        // Without the signal (not registered, or its stream ended) the next look comes after a short pause.
        let woke = match exits.as_mut() {
            Some(exits) => exits.recv().await.is_some(),
            None => false,
        };
        if !woke {
            mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl StdioTransport {
    pub async fn spawn(io: SpawnIo, spec: StdioSpec<'_>) -> Result<(Self, IncomingRx), TransportError> {
        // Resolving the command and creating the process block, so both run on the spawn lane; the
        // child registers with this runtime's reactor.
        let runtime = tokio::runtime::Handle::current();
        let (command, args, cwd, env) = (spec.command.to_owned(), spec.args.to_vec(), spec.cwd.map(str::to_owned), spec.env.clone());
        // `inherit` is piped as well: the child's stderr reaches the daemon's only through the redaction of `StderrSink`.
        let stderr = if spec.stderr == "ignore" { std::process::Stdio::null() } else { std::process::Stdio::piped() };
        let job = io
            .submit(&CancellationToken::new(), move |lane| {
                let _entered = runtime.enter();
                start(lane, &command, &args, cwd.as_deref(), &env, stderr)
            })
            .map_err(|_| TransportError::LaneFull)?;
        let (mut child, containment) = job.await.map_err(|_| TransportError::Closed)??;
        let containment = Some(containment);
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
        let reader = stdout.map(|out| mixdog_rt::spawn("mcp.stdio.read", TaskClass::Work, read_loop(out, incoming_tx.clone())));
        let stderr_reader = stderr.map(|err| {
            let sink = StderrSink::new(spec.name, spec.secrets.to_vec(), tail.clone(), spec.log.clone());
            mixdog_rt::spawn("mcp.stdio.stderr", TaskClass::Work, stderr_loop(err, sink))
        });
        let stopped = CancellationToken::new();
        let stopped_on_exit = stopped.clone().drop_guard();
        let supervising = supervise(child, containment, shutdown.clone(), spec.shutdown_grace, (reader, stderr_reader), tail.clone(), incoming_tx);
        mixdog_rt::spawn("mcp.stdio.supervise", TaskClass::Work, async move {
            let _stopped_on_exit = stopped_on_exit;
            supervising.await;
        });
        Ok((Self { outgoing, shutdown, stopped, tail }, incoming_rx))
    }
}

async fn write_loop(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::UnboundedReceiver<Vec<u8>>, shutdown: CancellationToken) {
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

/// Line buffer capacity kept between reads; anything larger is returned to the allocator after the line is parsed.
const LINE_RETAIN_BYTES: usize = 64 * 1024;

fn reset_line_buffer(line: &mut Vec<u8>) {
    line.clear();
    if line.capacity() > LINE_RETAIN_BYTES {
        *line = Vec::new();
    }
}

async fn read_next_line<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>, line: &mut Vec<u8>) -> std::io::Result<usize> {
    reset_line_buffer(line);
    reader.read_until(b'\n', line).await
}

async fn read_loop(stdout: tokio::process::ChildStdout, tx: IncomingTx) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        match read_next_line(&mut reader, &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let trimmed = line.trim_ascii();
        if trimmed.is_empty() {
            reset_line_buffer(&mut line);
            continue;
        }
        match serde_json::from_slice::<Value>(trimmed) {
            Ok(message) => {
                reset_line_buffer(&mut line);
                if tx.send(Incoming::Message(message)).is_err() {
                    return;
                }
            }
            Err(error) => {
                reset_line_buffer(&mut line);
                tracing::warn!(%error, "mcp stdio: line is not JSON");
            }
        }
    }
}

/// How much of an unfinished stderr line is held for its end before it is let out at a word boundary.
const STDERR_LINE_CHARS: usize = 8192;

struct Redactor {
    secrets: Vec<String>,
    /// Text not let out yet, as written.
    held: String,
    /// Characters held back after any cut.
    keep: usize,
    /// An overlong word was dropped and its rest has not arrived yet: it is dropped too.
    dropping: bool,
    /// Bytes at the start of `held` that belong to a dropped word: never let out.
    hidden: usize,
}

/// The last `n` characters of `text`.
fn last_chars(text: &str, n: usize) -> &str {
    let count = text.chars().count();
    text.char_indices().nth(count.saturating_sub(n)).map_or("", |(at, _)| &text[at..])
}

impl Redactor {
    fn new(secrets: Vec<String>) -> Self {
        let keep = secrets.iter().filter(|secret| secret.contains(char::is_whitespace)).map(|secret| secret.chars().count()).max().unwrap_or(0);
        Self { secrets, held: String::new(), keep, dropping: false, hidden: 0 }
    }

    /// The end of the last white space, past the hidden lead-in and before byte `limit`, that no credential range covers
    /// (only a newline when `line`): where a release may end.
    fn cut_before(&self, limit: usize, ranges: &[std::ops::Range<usize>], line: bool) -> Option<usize> {
        self.held[..limit]
            .char_indices()
            .rev()
            .take_while(|(at, _)| *at >= self.hidden)
            .find(|(at, c)| (if line { *c == '\n' } else { c.is_whitespace() }) && !ranges.iter().any(|r| r.contains(at)))
            .map(|(at, c)| at + c.len_utf8())
    }

    /// Lets out what is held up to `cut`, redacted with `ranges` and without the hidden lead-in; what stays held begins
    /// after white space and hides nothing.
    fn release(&mut self, cut: usize, ranges: &[std::ops::Range<usize>]) -> String {
        let out = crate::config::redact(&self.held, self.hidden, cut, ranges);
        self.held.drain(..cut);
        if self.held.capacity() > LINE_RETAIN_BYTES && self.held.len() <= LINE_RETAIN_BYTES {
            self.held.shrink_to(LINE_RETAIN_BYTES);
        }
        self.hidden = 0;
        out
    }

    /// The byte offset in what is held that a cut may not pass: `keep` characters stay after it.
    fn limit(&self) -> usize {
        let total = self.held.chars().count();
        if total <= self.keep {
            return 0;
        }
        self.held.char_indices().nth(total - self.keep).map_or(self.held.len(), |(at, _)| at)
    }

    /// The scrubbed text `chunk` lets out.
    fn push(&mut self, mut chunk: &str) -> String {
        if self.dropping {
            // All that is held is the dropped word's lead-in: the word's rest joins it, and its last `keep` characters
            // stay held, hidden.
            let word_end = chunk.find(char::is_whitespace);
            self.held.push_str(&chunk[..word_end.unwrap_or(chunk.len())]);
            self.held = last_chars(&self.held, self.keep).to_owned();
            self.hidden = self.held.len();
            let Some(at) = word_end else { return String::new() };
            self.dropping = false;
            chunk = &chunk[at..];
        }
        self.held.push_str(chunk);
        // Held text may continue: a short secret at its very end is in a range, so no cut falls in it and it stays held
        // until what follows it decides.
        let ranges = crate::config::secret_ranges(&self.held, &self.secrets);
        let mut out = match self.cut_before(self.limit(), &ranges, true) {
            Some(cut) => self.release(cut, &ranges),
            None => String::new(),
        };
        while self.held.chars().count() > STDERR_LINE_CHARS.max(2 * self.keep) {
            let ranges = crate::config::secret_ranges(&self.held, &self.secrets);
            if let Some(cut) = self.cut_before(self.limit(), &ranges, false) {
                out.push_str(&self.release(cut, &ranges));
                continue;
            }
            // One word fills what may be held: it cannot be told apart from a credential still arriving. It ends at the
            // first white space no credential covers; its last `keep` characters stay held, hidden.
            out.push_str("[truncated]");
            let word_end = self.held[self.hidden..]
                .char_indices()
                .find(|(at, c)| c.is_whitespace() && !ranges.iter().any(|r| r.contains(&(self.hidden + at))))
                .map_or(self.held.len(), |(at, _)| self.hidden + at);
            let rest = self.held.split_off(word_end);
            self.held = last_chars(&self.held, self.keep).to_owned();
            self.hidden = self.held.len();
            self.dropping = rest.is_empty();
            self.held.push_str(&rest);
            if self.dropping {
                break;
            }
        }
        out
    }

    /// What is still held, at the stream's end, where a short secret at the very end is a whole value; the hidden lead-in
    /// of a dropped word is never let out.
    fn finish(&mut self) -> String {
        let ranges = crate::config::secret_ranges(&self.held, &self.secrets);
        let out = crate::config::redact(&self.held, self.hidden, self.held.len(), &ranges);
        self.held.clear();
        self.hidden = 0;
        self.dropping = false;
        out
    }
}

/// One server's stderr into its tail and its log, if it has one (`client-transport.mjs` stdioTransport): both get only
/// redacted text, and the log is a queue the reader never waits on.
struct StderrSink {
    name: String,
    redactor: Redactor,
    tail: Arc<Mutex<String>>,
    log: Option<Arc<LogQueue>>,
}

impl StderrSink {
    fn new(name: &str, secrets: Vec<String>, tail: Arc<Mutex<String>>, log: Option<Arc<LogQueue>>) -> Self {
        Self { name: name.to_owned(), redactor: Redactor::new(secrets), tail, log }
    }

    fn write(&mut self, decoded: &str) {
        let text = self.redactor.push(decoded);
        self.take(&text);
    }

    fn end(&mut self, decoded: &str) {
        let mut text = self.redactor.push(decoded);
        text.push_str(&self.redactor.finish());
        self.take(&text);
    }

    fn take(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        push_tail(&self.tail, text);
        if let Some(log) = &self.log {
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                log.line(&format!("[mcp:{}:stderr] {line}", self.name));
            }
        }
    }
}

async fn stderr_loop(mut stderr: tokio::process::ChildStderr, mut sink: StderrSink) {
    let mut buf = [0u8; 2048];
    let mut decoder = ShellStreamDecoder::new(host_oem(), None);
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => {
                sink.end(&decoder.end());
                return;
            }
            Ok(n) => sink.write(&decoder.write(&buf[..n])),
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
    let exited = await_leader_exit(&mut child, containment.as_ref(), &shutdown, grace).await;
    // A wrapper that exits promptly leaves its descendants behind: the tree ends with the connection (`shutdownStdioChild`).
    // On Unix this runs before the leader is reaped, while its zombie still holds the group id.
    if let (Some(containment), Some(signalable)) = (&containment, exited) {
        if signalable {
            containment.terminate();
        }
        containment.mark_exited();
    }
    // Bounded too: a leader whose exit could not be confirmed (a failed `waitid`) may not be reapable at once.
    let reason = match exited {
        Some(_) => match mixdog_rt::time::timeout(KILL_SETTLE, child.wait()).await {
            Ok(Ok(status)) => format!("process exited: {status}"),
            Ok(Err(error)) => format!("process wait failed: {error}"),
            Err(_) => "process exit was not confirmed".to_owned(),
        },
        None => "process did not exit after its kill".to_owned(),
    };
    // A leader that outlived its kill is left to the containment's drop and then the child's (`kill_on_drop`), in that
    // order: the group is signalled before anything can reap the leader.
    drop(containment);
    drop(child);
    drain_readers(reader, stderr_reader, grace).await;
    let stderr_tail = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let _ = tx.send(Incoming::Closed(CloseCause { reason, stderr_tail }));
}

/// `Some(group may be signalled)` once the leader exited; `None`: it outlived its kill.
async fn await_leader_exit(child: &mut Child, containment: Option<&Containment>, shutdown: &CancellationToken, grace: Duration) -> Option<bool> {
    tokio::select! {
        signalable = leader_exited(child) => Some(signalable),
        () = shutdown.cancelled() => {
            // stdin is closed by the writer; a well-behaved server exits within the grace.
            match mixdog_rt::time::timeout(grace, leader_exited(child)).await {
                Ok(signalable) => Some(signalable),
                Err(_) => {
                    kill_tree(child, containment);
                    mixdog_rt::time::timeout(KILL_SETTLE, leader_exited(child)).await.ok()
                }
            }
        }
    }
}

async fn drain_readers(reader: Option<tokio::task::JoinHandle<()>>, stderr_reader: Option<tokio::task::JoinHandle<()>>, grace: Duration) {
    // Messages the child wrote before exiting are delivered before `Closed`.
    if let Some(reader) = reader {
        let _ = mixdog_rt::time::timeout(grace, reader).await;
    }
    // The tail is complete only once stderr was read to its end. A descendant that keeps the pipe open ends the wait by
    // abort, so the reader neither outlives this task nor races the snapshot below; the reader never blocks (its log
    // lines go to their own thread), so the aborted task ends at once, and the wait for it is bounded all the same.
    if let Some(mut stderr_reader) = stderr_reader
        && mixdog_rt::time::timeout(grace, &mut stderr_reader).await.is_err()
    {
        stderr_reader.abort();
        let _ = mixdog_rt::time::timeout(grace, stderr_reader).await;
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn send(&self, message: Value, _liveness: Liveness) -> Result<(), TransportError> {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| TransportError::Request(e.to_string()))?;
        bytes.push(b'\n');
        self.outgoing.send(bytes).map_err(|_| TransportError::Closed)
    }

    async fn close(&self) {
        self.shutdown.cancel();
        self.stopped.cancelled().await;
    }

    fn stderr_tail(&self) -> String {
        self.tail.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::containment::FAIL_NEXT_ATTACH;

    /// A child that starts a grandchild (holding the child's stdout) at once, then prints `ready` and stays alive.
    fn starts_a_grandchild() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.raw_arg("/d /c \"start /b ping -n 100 127.0.0.1 & echo ready & ping -n 100 127.0.0.1 >nul\"");
            command
        }
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 100 & echo ready; wait"]);
            command
        }
    }

    /// A child that starts a grandchild at its first instruction is ended, grandchild included, when its containment
    /// ends: the grandchild holds the child's stdout, so the pipe reaches its end only once every process of the tree is
    /// gone.
    #[tokio::test]
    async fn a_child_that_starts_a_grandchild_at_once_ends_with_its_job() {
        let Ok((mut child, containment)) = spawn_contained(starts_a_grandchild(), "grandchild", std::process::Stdio::piped()) else {
            panic!("the start failed");
        };
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        mixdog_rt::time::timeout(Duration::from_secs(30), async {
            loop {
                line.clear();
                assert!(stdout.read_line(&mut line).await.unwrap() > 0, "the child ended before it said ready");
                if line.trim() == "ready" {
                    break;
                }
            }
        })
        .await
        .expect("the child says ready (its grandchild runs) in 30 s");
        containment.terminate();
        let mut rest = Vec::new();
        mixdog_rt::time::timeout(Duration::from_secs(30), stdout.read_to_end(&mut rest))
            .await
            .expect("the grandchild ended with the job: its end of the stdout pipe closed in 30 s")
            .unwrap();
        mixdog_rt::time::timeout(Duration::from_secs(30), child.wait()).await.expect("the child ended in 30 s").unwrap();
    }

    /// A log of this test's own, and the lines it gets.
    fn own_log() -> (Arc<LogQueue>, std::sync::mpsc::Receiver<String>) {
        let (into, lines) = std::sync::mpsc::channel();
        let log = LogQueue::start(move |line| {
            let _ = into.send(line.to_owned());
        })
        .expect("the log's thread starts");
        (log, lines)
    }

    /// A credential split across reads, a configured secret and a URL secret alike, is redacted whole in the tail and in
    /// every log line, however the output is cut: at a read, at a line's end, or by an overlong line.
    #[test]
    fn a_secret_split_across_reads_reaches_neither_the_tail_nor_the_log() {
        let (log_queue, lines) = own_log();
        let tail = Arc::new(Mutex::new(String::new()));
        let mut sink = StderrSink::new("srv", vec!["sk-live-0123456789".to_owned()], tail.clone(), Some(log_queue));
        for chunk in ["fetch https://api.example/v1?tok", "en=abc123def&x=1 key=sk-live-01", "23456789 done\n", "and ?access_tok", "en=zzz999"] {
            sink.write(chunk);
        }
        sink.end("");
        let mut log = Vec::new();
        while log.len() < 2 {
            log.push(lines.recv_timeout(Duration::from_secs(10)).expect("both lines are logged in 10 s"));
        }
        let tail = tail.lock().unwrap().clone();
        for text in log.iter().chain([&tail]) {
            for leaked in ["abc123def", "sk-live-01", "zzz999"] {
                assert!(!text.contains(leaked), "{leaked:?} reached {text:?}");
            }
        }
        assert_eq!(
            log,
            ["[mcp:srv:stderr] fetch https://api.example/v1?token=[redacted]&x=1 key=[redacted] done", "[mcp:srv:stderr] and ?access_token=[redacted]"]
        );

        let mut redactor = Redactor::new(vec!["sk-live-0123456789".to_owned()]);
        let mut out = redactor.push(&format!("{}sk-live-01", "word ".repeat(2000)));
        assert!(!out.is_empty(), "an overlong line is let out before its end");
        out.push_str(&redactor.push("23456789\n"));
        out.push_str(&redactor.push(&format!("{}?token=abc", "x".repeat(9000))));
        out.push_str(&redactor.push("def rest\n"));
        out.push_str(&redactor.finish());
        for leaked in ["sk-live-01", "abc", "def"] {
            assert!(!out.contains(leaked), "{leaked:?} was let out");
        }
        assert!(out.ends_with(" rest\n"), "{}", &out[out.len() - 40..]);
    }

    /// A configured secret spanning lines (a private key) is held across its newlines until it can be matched whole, and a
    /// word too long to hold is dropped, never let out in part: URL user info whose `@` comes later never leaks.
    #[test]
    fn a_multiline_secret_and_an_overlong_word_are_never_let_out_in_part() {
        let key = "-----BEGIN KEY-----\nabc123\n-----END KEY-----";
        let (log_queue, lines) = own_log();
        let tail = Arc::new(Mutex::new(String::new()));
        let mut sink = StderrSink::new("srv", vec![key.to_owned()], tail.clone(), Some(log_queue));
        for chunk in ["key: -----BEGIN KEY-----\n", "abc123\n-----END", " KEY-----\ndone\n"] {
            sink.write(chunk);
            for line in lines.try_iter() {
                assert!(!line.contains("BEGIN") && !line.contains("abc123"), "{line:?} was logged");
            }
        }
        sink.end("");
        assert_eq!(*tail.lock().unwrap(), "key: [redacted]\ndone\n");
        let mut log = Vec::new();
        while log.len() < 2 {
            log.push(lines.recv_timeout(Duration::from_secs(10)).expect("both lines are logged in 10 s"));
        }
        assert_eq!(log, ["[mcp:srv:stderr] key: [redacted]", "[mcp:srv:stderr] done"]);

        let mut redactor = Redactor::new(Vec::new());
        let mut out = redactor.push(&format!("connect https://user:{}", "p".repeat(9000)));
        out.push_str(&redactor.push("@host.example failed\n"));
        out.push_str(&redactor.finish());
        assert!(!out.contains("user") && !out.contains("ppp"), "{out}");
        assert_eq!(out, "connect [truncated] failed\n");
    }

    /// A dropped overlong word keeps what a secret holding white space needs: one that begins at the word's end and
    /// continues in the next read (`Bearer` | ` abc12345`) is still redacted, and nothing of the word is let out.
    #[test]
    fn a_dropped_word_still_completes_a_secret_that_spans_its_end() {
        let (log_queue, lines) = own_log();
        let tail = Arc::new(Mutex::new(String::new()));
        let mut sink = StderrSink::new("srv", vec!["Bearer abc12345".to_owned()], tail.clone(), Some(log_queue));
        sink.write(&format!("{}Bearer", "x".repeat(9000)));
        sink.write(" abc12345\n");
        sink.write("next\n");
        sink.end("");
        let tail = tail.lock().unwrap().clone();
        assert!(!tail.contains("abc12345") && !tail.contains("xxx"), "{tail}");
        assert_eq!(tail, "[truncated][redacted]\nnext\n");
        let mut log = Vec::new();
        while log.len() < 2 {
            log.push(lines.recv_timeout(Duration::from_secs(10)).expect("the lines are logged in 10 s"));
        }
        assert_eq!(log, ["[mcp:srv:stderr] [truncated]", "[mcp:srv:stderr] [redacted]"]);
        assert!(lines.recv_timeout(Duration::from_secs(1)).is_ok_and(|line| line == "[mcp:srv:stderr] next"));

        // The same word without the secret: the following text is let out, nothing of the word.
        let mut redactor = Redactor::new(vec!["Bearer abc12345".to_owned()]);
        let mut out = redactor.push(&format!("{}Bearer", "x".repeat(9000)));
        out.push_str(&redactor.push(" other\n"));
        out.push_str(&redactor.finish());
        assert_eq!(out, "[truncated] other\n");
    }

    /// A configured secret replaced inside a dropped word's lead-in hides nothing that follows it in that word: the rest of
    /// an overlong PostgreSQL URI (`:dbpass@db`, its scheme long gone) is never let out, only what follows the word.
    #[test]
    fn nothing_of_a_dropped_word_is_let_out_whatever_is_redacted_in_it() {
        let secrets = vec!["knownkey".to_owned(), "Bearer abc12345".to_owned()];
        let mut redactor = Redactor::new(secrets.clone());
        let mut out = redactor.push(&format!("connect postgres://{}knownkey", "u".repeat(9000)));
        out.push_str(&redactor.push(":dbpass@db"));
        out.push_str(&redactor.push("/app failed\n"));
        out.push_str(&redactor.finish());
        assert!(!out.contains("dbpass") && !out.contains("uuu") && !out.contains("knownkey"), "{out}");
        assert_eq!(out, "connect [truncated] failed\n");

        // The same URI in one read, and the rest of the word arriving with what follows it.
        let mut redactor = Redactor::new(secrets);
        let mut out = redactor.push(&format!("connect postgres://{}knownkey:db", "u".repeat(9000)));
        out.push_str(&redactor.push("pass@db failed\n"));
        out.push_str(&redactor.finish());
        assert_eq!(out, "connect [truncated] failed\n");
    }

    /// A short secret that begins with a line break and ends the text before a `.` is held whole until the stream's end
    /// decides it: what is let out is what scrubbing the whole text gives.
    #[test]
    fn a_short_multiline_secret_at_the_end_is_not_split_before_it_is_decided() {
        let secrets = vec!["\nabc".to_owned()];
        let text = "login:\nabc.";
        let mut redactor = Redactor::new(secrets.clone());
        let mut out = redactor.push(text);
        out.push_str(&redactor.finish());
        assert_eq!(out, crate::config::scrub(text, &secrets));
        assert_eq!(out, "login:[redacted].");
    }

    /// A short secret split from what follows it by a read is decided only once that text arrives: the `2` of a split
    /// `-32000` is left alone, and a `2` that stands alone is redacted, at a line's end or at the stream's.
    #[test]
    fn a_short_secret_is_decided_across_reads() {
        let mut redactor = Redactor::new(vec!["2".to_owned()]);
        let mut out = String::new();
        for chunk in ["MCP error -3", "2000: closed x 2", "\nretry 2"] {
            out.push_str(&redactor.push(chunk));
        }
        out.push_str(&redactor.finish());
        assert_eq!(out, "MCP error -32000: closed x [redacted]\nretry [redacted]");
    }

    /// Without a log (`MIXDOG_QUIET_MCP_LOG`) the tail is kept all the same.
    #[test]
    fn a_quiet_log_still_keeps_the_tail() {
        let tail = Arc::new(Mutex::new(String::new()));
        let mut sink = StderrSink::new("srv", Vec::new(), tail.clone(), None);
        sink.write("boom\n");
        sink.end("last words");
        assert_eq!(*tail.lock().unwrap(), "boom\nlast words");
    }

    #[tokio::test]
    async fn stdio_line_buffer_returns_capacity_after_an_oversized_line() {
        let huge = format!("{{\"payload\":\"{}\"}}\n{{\"ok\":true}}\n", "a".repeat(512 * 1024));
        let mut reader = BufReader::new(std::io::Cursor::new(huge.into_bytes()));
        let mut line = Vec::new();
        let n = read_next_line(&mut reader, &mut line).await.unwrap();
        assert!(n > 512 * 1024);
        assert!(line.capacity() >= 512 * 1024);
        reset_line_buffer(&mut line);
        assert!(line.capacity() <= LINE_RETAIN_BYTES, "capacity stayed at {}", line.capacity());
        let n2 = read_next_line(&mut reader, &mut line).await.unwrap();
        assert!(n2 > 0);
        assert!(line.capacity() <= LINE_RETAIN_BYTES, "capacity stayed at {}", line.capacity());
    }

    /// A child that floods stderr and ignores its closed stdin, with a log whose writer blocks until the test releases it:
    /// the close still settles (the grace, then the kill), as the reader never waits on the log.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_close_settles_while_the_log_sink_blocks() {
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let log = LogQueue::start(move |_| {
            let _ = gate.lock().unwrap().recv();
        })
        .expect("the log's thread starts");
        #[cfg(windows)]
        let (command, args) =
            ("cmd", vec!["/d".to_owned(), "/c".to_owned(), "(for /l %i in (1,1,3000) do @echo noise %i 1>&2) & ping -n 60 127.0.0.1 >nul".to_owned()]);
        #[cfg(unix)]
        let (command, args) = ("sh", vec!["-c".to_owned(), "i=0; while [ $i -lt 3000 ]; do echo noise $i >&2; i=$((i+1)); done; sleep 60".to_owned()]);
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let spec = StdioSpec {
            command,
            args: &args,
            env: &env,
            cwd: None,
            shutdown_grace: Duration::from_secs(1),
            name: "flood",
            secrets: &[],
            stderr: "pipe",
            log: Some(log),
        };
        let (transport, _incoming) = StdioTransport::spawn(mixdog_rt::testing::tokens().spawn_io, spec).await.expect("the child starts");
        mixdog_rt::time::timeout(Duration::from_secs(30), async {
            while !transport.stderr_tail().contains("noise") {
                mixdog_rt::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the child writes to stderr in 30 s");
        let closed = mixdog_rt::time::timeout(Duration::from_secs(20), transport.close()).await;
        drop(release);
        closed.expect("the close settles in 20 s");
    }

    /// The leader of a tree is seen to exit before it is reaped: its zombie still holds the group id while the group is
    /// signalled, so the signal reaches its own descendants and no stranger.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn the_tree_is_ended_while_its_exited_leader_is_unreaped() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 100 & echo $!; exit 0"]);
        let Ok((mut child, containment)) = spawn_contained(command, "leader", std::process::Stdio::piped()) else {
            panic!("the start failed");
        };
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        let grandchild: i32 = line.trim().parse().expect("the grandchild's pid");
        let leader = child.id().unwrap() as i32;
        assert!(mixdog_rt::time::timeout(Duration::from_secs(30), leader_exited(&mut child)).await.expect("the leader exits in 30 s"));
        // SAFETY: signal 0 only asks whether the process exists.
        assert_eq!(unsafe { libc::kill(leader, 0) }, 0, "the exited leader is not reaped yet");
        containment.terminate();
        containment.mark_exited();
        mixdog_rt::time::timeout(Duration::from_secs(30), async {
            // SAFETY: signal 0 only asks whether the process exists.
            while unsafe { libc::kill(grandchild, 0) } == 0 {
                mixdog_rt::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the grandchild ended with its group in 30 s");
        assert!(child.wait().await.unwrap().success());
    }

    /// A child the job refuses is not started: the start fails and the child, created suspended and never resumed, is
    /// ended.
    #[tokio::test]
    async fn a_failed_attach_fails_the_start_with_the_child_ended() {
        FAIL_NEXT_ATTACH.with(|fail| fail.set(true));
        let (error, child) = match spawn_contained(starts_a_grandchild(), "grandchild", std::process::Stdio::piped()) {
            Ok(_) => panic!("a child that could not be contained was started"),
            Err(failed) => failed,
        };
        assert!(matches!(error, TransportError::Spawn { .. }), "{error:?}");
        let mut child = child.expect("the child was created");
        mixdog_rt::time::timeout(Duration::from_secs(30), child.wait()).await.expect("the child of a failed attach ended in 30 s, not left suspended").unwrap();
    }
}
