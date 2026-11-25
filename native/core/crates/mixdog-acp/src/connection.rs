//! One agent process and the JSON-RPC it speaks: a message per line on its stdin and stdout.
//! The process runs under the process manager (job object / process group), so its whole tree
//! ends with one kill and with the daemon.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::command::spawn_form;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::agents::lock;
use crate::files::TextFiles;

/// How much of the agent's stderr is kept for an error message.
const STDERR_TAIL_BYTES: usize = 4096;

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(0);

/// A JSON-RPC error the agent answered with.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

impl RpcError {
    /// Textual detail carried in `data`, where present (`String` verbatim, other non-null JSON serialized).
    pub fn data_text(&self) -> Option<String> {
        match &self.data {
            Value::Null => None,
            Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
            Value::String(_) => None,
            other => Some(other.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Fault {
    /// The program is not on this machine.
    NotFound,
    /// The process could not be started.
    Start(String),
    Rpc(RpcError),
    /// The process ended; the text is the end of its stderr.
    Closed(String),
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("the agent's program was not found"),
            Self::Start(detail) => write!(f, "the agent could not be started: {detail}"),
            Self::Rpc(error) => f.write_str(&error.message),
            Self::Closed(tail) if tail.trim().is_empty() => f.write_str("the agent process ended"),
            Self::Closed(tail) => write!(f, "the agent process ended: {}", tail.trim()),
        }
    }
}

/// What the agent sends that is not the answer to an awaited request, in the order it wrote it.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// The answer to a request sent with [`Connection::send`]: it takes its place among the
    /// notifications written before it.
    Response {
        id: u64,
        result: Result<Value, RpcError>,
    },
    /// A call of a Mixdog tool the agent made through the session's MCP server: it takes its place among what
    /// the agent wrote, so the turn that reads the one reads the other.
    Tool(crate::mcp::ToolAsk),
}

pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub cwd: AbsPath,
}

/// A temporary folder of a process's own, cleared away once the process has exited, however it ended: what it unpacked
/// there goes with it.
pub struct Temp {
    pub folder: AbsPath,
    pub files: Arc<dyn TextFiles>,
}

impl Temp {
    /// The variables a program finds its temporary folder by.
    fn env(&self) -> [(String, String); 3] {
        let folder = self.folder.as_path().to_string_lossy().into_owned();
        ["TEMP", "TMP", "TMPDIR"].map(|name| (name.to_owned(), folder.clone()))
    }
}

/// Removes `folder`, which `kind` names, with all it holds. A folder that cannot be removed now is left to the sweep of the
/// daemon's next start.
pub(crate) async fn remove_folder(files: &dyn TextFiles, folder: AbsPath, kind: &str) {
    if let Err(error) = files.remove_folder(folder.clone()).await {
        tracing::warn!("[acp] {kind} {} was not removed: {error}", folder.as_path().display());
    }
}

/// What [`remove_folder`] names a server's temporary folder.
pub(crate) const TEMP_FOLDER: &str = "the agent's temporary folder";

/// What a program run to its exit left.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ran {
    pub stdout: String,
    /// The end of what it wrote to stderr.
    pub stderr: String,
    /// `None` for a process a signal ended.
    pub code: Option<i32>,
}

impl Ran {
    /// What a failed run says of itself: the end of its stderr, else the last line of its stdout, else its exit code.
    pub fn said(&self) -> String {
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_owned();
        }
        match (self.stdout.lines().map(str::trim).rfind(|line| !line.is_empty()), self.code) {
            (Some(line), _) => line.to_owned(),
            (None, Some(code)) => format!("it exited with code {code}"),
            (None, None) => "it was ended by a signal".to_owned(),
        }
    }
}

fn keep_tail(tail: &mut String, bytes: &[u8]) {
    tail.push_str(&String::from_utf8_lossy(bytes));
    let excess = tail.len().saturating_sub(STDERR_TAIL_BYTES);
    if excess > 0 {
        let cut = (excess..tail.len()).find(|at| tail.is_char_boundary(*at)).unwrap_or(tail.len());
        tail.drain(..cut);
    }
}

fn start_fault(error: ProcessError) -> Fault {
    match error {
        ProcessError::ProgramNotFound { .. } => Fault::NotFound,
        other => Fault::Start(format!("{other:?}")),
    }
}

fn spawn_request(launch: Launch, stdin_piped: bool) -> SpawnRequest {
    let (program, args) = spawn_form(&launch.program, &launch.args);
    SpawnRequest {
        handle: ProcessHandle(format!("acp-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::Relaxed))),
        command: CommandSpec::Argv { program, args },
        cwd: launch.cwd,
        // The CLI is the user's own program: it needs the user's environment (PATH, proxy, home, keyring session).
        env: EnvSpec { inherit: true, set: launch.env, remove: launch.env_remove },
        pty: None,
        stdin_piped,
        output: OutputMode::Separate,
        owner: ProcessOwner::Internal,
        time_limit: None,
    }
}

/// A process with its stdin piped, and its events to the exit. The caller owns ending it.
pub async fn spawn_piped(processes: &Arc<dyn ProcessManager>, launch: Launch) -> Result<(ProcessHandle, Box<dyn EventSource<ProcessEvent>>), Fault> {
    let request = spawn_request(launch, true);
    let handle = request.handle.clone();
    let (_, events) = processes.spawn_subscribed(request).await.map_err(start_fault)?;
    Ok((handle, events))
}

/// Runs `launch` to its exit. A future dropped before the exit, and a process whose events end without one,
/// leave no process behind.
pub async fn run_to_exit(processes: &Arc<dyn ProcessManager>, launch: Launch) -> Result<Ran, Fault> {
    let request = spawn_request(launch, false);
    let handle = request.handle.clone();
    let (_, mut events) = processes.spawn_subscribed(request).await.map_err(start_fault)?;
    let mut ended = KillUnlessExited { processes: processes.clone(), handle, exited: false };
    let mut stdout = Vec::new();
    let mut ran = Ran::default();
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => stdout.extend_from_slice(&bytes),
            ProcessEvent::Output { bytes, .. } => keep_tail(&mut ran.stderr, &bytes),
            ProcessEvent::Exited { exit, .. } => {
                ended.exited = true;
                ran.code = match exit.status {
                    ExitStatus::Code(code) => Some(code),
                    ExitStatus::Signal(_) => None,
                };
                break;
            }
        }
    }
    ran.stdout = String::from_utf8_lossy(&stdout).into_owned();
    if ended.exited { Ok(ran) } else { Err(Fault::Closed(ran.stderr)) }
}

/// A future dropped before its process exited leaves no process behind.
struct KillUnlessExited {
    processes: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    exited: bool,
}

impl Drop for KillUnlessExited {
    fn drop(&mut self) {
        if !self.exited {
            let _ = self.processes.kill(&self.handle);
        }
    }
}

type Waiting = HashMap<u64, oneshot::Sender<Result<Value, Fault>>>;

pub struct Connection {
    processes: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    next_id: AtomicU64,
    waiting: Mutex<Waiting>,
    /// The ids of the requests sent with [`Connection::send`] that the agent has not answered yet.
    sent: Mutex<HashSet<u64>>,
    /// Fired by the reader once the process has exited, before it fails the waiting requests.
    exited: CancellationToken,
    stderr: Mutex<String>,
    /// Who is told each whole line the process writes to stderr.
    stderr_lines: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    /// Why this client ended the process itself.
    broken: Mutex<Option<String>>,
}

fn rpc_error(error: &Value) -> RpcError {
    RpcError {
        code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
        message: error.get("message").and_then(Value::as_str).unwrap_or("the agent reported an error").to_owned(),
        data: error.get("data").cloned().unwrap_or(Value::Null),
    }
}

impl Connection {
    /// Starts the agent; what it sends unasked arrives on the returned channel, which ends with the process.
    pub async fn start(processes: Arc<dyn ProcessManager>, launch: Launch) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Incoming>), Fault> {
        Self::start_in(processes, launch, None).await
    }

    /// [`Connection::start`], the process given `temp` as its temporary folder: the folder is cleared away once the
    /// process has exited, before [`Connection::exited`] fires.
    pub async fn start_in(
        processes: Arc<dyn ProcessManager>,
        mut launch: Launch,
        temp: Option<Temp>,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Incoming>), Fault> {
        launch.env.extend(temp.iter().flat_map(Temp::env));
        let request = spawn_request(launch, true);
        let handle = request.handle.clone();
        let events = match processes.spawn_subscribed(request).await {
            Ok((_, events)) => events,
            Err(error) => {
                if let Some(temp) = temp {
                    remove_folder(temp.files.as_ref(), temp.folder, TEMP_FOLDER).await;
                }
                return Err(start_fault(error));
            }
        };
        let connection = Arc::new(Self {
            processes,
            handle,
            next_id: AtomicU64::new(1),
            waiting: Mutex::default(),
            sent: Mutex::default(),
            exited: CancellationToken::new(),
            stderr: Mutex::default(),
            stderr_lines: Mutex::default(),
            broken: Mutex::default(),
        });
        let (tx, rx) = mpsc::unbounded_channel();
        drop(mixdog_rt::spawn("acp.read", TaskClass::Work, read(Arc::downgrade(&connection), events, tx, temp)));
        Ok((connection, rx))
    }

    pub fn handle(&self) -> &ProcessHandle {
        &self.handle
    }

    /// Fires once the process has exited.
    pub fn exited(&self) -> &CancellationToken {
        &self.exited
    }

    /// Each whole line the process writes to stderr, trimmed, from the earliest one of the kept end of its stderr on; the
    /// channel ends with the process.
    pub fn stderr_lines(&self) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let tail = lock(&self.stderr);
        let whole = tail.rfind('\n').map_or("", |end| &tail[..end]);
        for line in whole.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let _ = tx.send(line.to_owned());
        }
        let mut told = lock(&self.stderr_lines);
        if !self.exited.is_cancelled() {
            told.push(tx);
        }
        drop(told);
        rx
    }

    /// The process wrote `bytes` to stderr, after the unfinished line `line`.
    fn stderr_written(&self, line: &mut Vec<u8>, bytes: &[u8]) {
        let mut tail = lock(&self.stderr);
        keep_tail(&mut tail, bytes);
        let mut told = lock(&self.stderr_lines);
        for byte in bytes {
            if *byte != b'\n' {
                line.push(*byte);
                continue;
            }
            let text = String::from_utf8_lossy(&std::mem::take(line)).trim().to_owned();
            if !text.is_empty() {
                told.retain(|tx| tx.send(text.clone()).is_ok());
            }
        }
    }

    /// The fault of a process that ended, with the end of what it wrote to stderr.
    pub fn closed(&self) -> Fault {
        Fault::Closed(lock(&self.broken).clone().unwrap_or_else(|| lock(&self.stderr).clone()))
    }

    /// A write to an agent that stopped reading its stdin ends with the process.
    async fn write(&self, message: Value) -> Result<(), Fault> {
        let mut line = message.to_string().into_bytes();
        line.push(b'\n');
        tokio::select! {
            biased;
            () = self.exited.cancelled() => Err(self.closed()),
            written = self.processes.write_stdin_whole(&self.handle, line) => written.map_err(|_| self.closed()),
        }
    }

    /// The agent broke the protocol in a way that leaves a request without its answer: the process is ended,
    /// which fails everything that waits on it.
    fn break_off(&self, why: &str) {
        tracing::warn!("[acp] the agent's process is ended: {why}");
        lock(&self.broken).get_or_insert_with(|| why.to_owned());
        self.kill();
    }

    /// A request whose answer this call waits for.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, Fault> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&self.waiting).insert(id, tx);
        // The reader fails what waits only after it fired the token: a request entered after that is failed here.
        if self.exited.is_cancelled() {
            lock(&self.waiting).remove(&id);
            return Err(self.closed());
        }
        if let Err(fault) = self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            lock(&self.waiting).remove(&id);
            return Err(fault);
        }
        rx.await.unwrap_or_else(|_| Err(self.closed()))
    }

    /// A request whose answer arrives as [`Incoming::Response`], after every notification the agent wrote before it.
    pub async fn send(&self, method: &str, params: Value) -> Result<u64, Fault> {
        let id = self.reserve();
        self.send_as(id, method, params).await.map(|()| id)
    }

    /// The id of a request sent next with [`Connection::send_as`]: the reader can be told whose answer it is before the
    /// agent can answer it.
    pub fn reserve(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// [`Connection::send`] under the id [`Connection::reserve`] gave.
    pub async fn send_as(&self, id: u64, method: &str, params: Value) -> Result<(), Fault> {
        lock(&self.sent).insert(id);
        if let Err(fault) = self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            lock(&self.sent).remove(&id);
            return Err(fault);
        }
        Ok(())
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), Fault> {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    /// The answer to a request of the agent's.
    pub async fn respond(&self, id: Value, result: Result<Value, RpcError>) {
        let message = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": error.code, "message": error.message } }),
        };
        // An agent that is gone has nobody to answer.
        let _ = self.write(message).await;
    }

    /// Ends the process tree; the exit follows on the channel.
    pub fn kill(&self) {
        let _ = self.processes.kill(&self.handle);
    }

    /// Ends the process as the end of its input ends it, so it clears away what it made: its stdin is closed, and a
    /// process still running after `grace` is ended by force. Resolves once it has exited.
    pub async fn close_gracefully(&self, grace: std::time::Duration) {
        if !self.exited.is_cancelled() {
            let _ = self.processes.close_stdin(&self.handle);
            if mixdog_rt::time::timeout(grace, self.exited.cancelled()).await.is_err() {
                tracing::warn!("[acp] the agent's process did not end within {} s of the end of its input: it is ended", grace.as_secs());
                self.kill();
            }
        }
        self.exited.cancelled().await;
    }

    fn dispatch(&self, message: Value, out: &mpsc::UnboundedSender<Incoming>) {
        let method = message.get("method").and_then(Value::as_str).map(str::to_owned);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let incoming = match (method, message.get("id")) {
            (Some(method), Some(id)) if !id.is_null() => Incoming::Request { id: id.clone(), method, params },
            (Some(method), _) => Incoming::Notification { method, params },
            (None, Some(id)) => {
                let result = match message.get("error") {
                    Some(error) if !error.is_null() => Err(rpc_error(error)),
                    _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let waiter = id.as_u64().and_then(|id| lock(&self.waiting).remove(&id));
                match (waiter, id.as_u64().filter(|id| lock(&self.sent).remove(id))) {
                    (Some(waiter), _) => {
                        let _ = waiter.send(result.map_err(Fault::Rpc));
                        return;
                    }
                    (None, Some(id)) => Incoming::Response { id, result },
                    // An answer to no request of this client: the request it was meant for would wait for ever.
                    (None, None) => return self.break_off("it answered a request this client never made"),
                }
            }
            (None, None) => return,
        };
        let _ = out.send(incoming);
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if !self.exited.is_cancelled() {
            self.kill();
        }
    }
}

/// Reads the process to its exit, then clears away its temporary folder. It holds the connection only while it handles
/// an event: a connection nobody holds any more is dropped, which ends the process, and the exit ends this.
async fn read(
    connection: std::sync::Weak<Connection>,
    mut events: Box<dyn EventSource<ProcessEvent>>,
    out: mpsc::UnboundedSender<Incoming>,
    temp: Option<Temp>,
) {
    let mut line: Vec<u8> = Vec::new();
    let mut err_line: Vec<u8> = Vec::new();
    let mut exited = false;
    while let Some(event) = events.next().await {
        let Some(connection) = connection.upgrade() else { continue };
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => {
                for byte in bytes {
                    if byte != b'\n' {
                        line.push(byte);
                        continue;
                    }
                    let text = std::mem::take(&mut line);
                    if text.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    match serde_json::from_slice::<Value>(&text) {
                        Ok(message) => connection.dispatch(message, &out),
                        Err(error) => tracing::warn!("[acp] a line of the agent's output is not JSON: {error}"),
                    }
                }
            }
            ProcessEvent::Output { bytes, .. } => connection.stderr_written(&mut err_line, &bytes),
            ProcessEvent::Exited { .. } => {
                exited = true;
                break;
            }
        }
    }
    let connection = connection.upgrade();
    // A source that ended without the exit tells nothing of the process: it is ended here.
    if let Some(connection) = connection.as_ref().filter(|_| !exited) {
        connection.kill();
    }
    if let Some(temp) = temp {
        remove_folder(temp.files.as_ref(), temp.folder, TEMP_FOLDER).await;
    }
    let Some(connection) = connection else { return };
    connection.exited.cancel();
    lock(&connection.stderr_lines).clear();
    let waiting: Vec<_> = lock(&connection.waiting).drain().collect();
    for (_, waiter) in waiting {
        let _ = waiter.send(Err(connection.closed()));
    }
}
