//! One agent process and the JSON-RPC it speaks: a message per line on its stdin and stdout.
//! The process runs under the process manager (job object / process group), so its whole tree
//! ends with one kill and with the daemon.

use std::collections::BTreeSet;
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
/// How much of one line of the agent's stderr is told: the rest of a longer line (a progress bar redrawn with `\r`) is
/// passed over.
const STDERR_LINE_BYTES: usize = 32 * 1024;
/// Upper bound on a single JSON-RPC stdout line frame from an agent process so a runaway line cannot OOM the daemon.
const MAX_STDOUT_LINE_BYTES: usize = 32 * 1024 * 1024;

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

/// Maximum abandoned request ids retained explicitly per connection; ids evicted past this cap
/// advance a monotonic watermark so valid late answers still never break off sibling sessions.
const MAX_ABANDONED_IDS: usize = 256;

#[derive(Default)]
struct AbandonedIds {
    ids: BTreeSet<u64>,
    evicted_through: u64,
}

impl AbandonedIds {
    fn insert(&mut self, id: u64) {
        if id == 0 || id <= self.evicted_through {
            return;
        }
        if !self.ids.insert(id) {
            return;
        }
        while self.ids.len() > MAX_ABANDONED_IDS {
            if let Some(oldest) = self.ids.pop_first() {
                self.evicted_through = self.evicted_through.max(oldest);
            }
        }
    }

    fn take(&mut self, id: u64) -> bool {
        if self.ids.remove(&id) {
            return true;
        }
        id > 0 && id <= self.evicted_through
    }

    fn clear(&mut self) {
        self.ids.clear();
        self.evicted_through = 0;
    }
}

#[derive(Default)]
struct Requests {
    waiting: Waiting,
    /// The ids of the requests sent with [`Connection::send`] that the agent has not answered yet.
    sent: HashSet<u64>,
    /// Bounded abandoned request ids plus monotonic eviction watermark whose late responses are silently dropped.
    abandoned: AbandonedIds,
}

enum DispatchResponse {
    Waiter(oneshot::Sender<Result<Value, Fault>>),
    Sent(u64),
    Abandoned,
    Unknown,
}

struct RequestGuard<'a> {
    connection: &'a Connection,
    id: u64,
    armed: bool,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let mut requests = lock(&self.connection.requests);
            if requests.waiting.remove(&self.id).is_some() && !self.connection.exited.is_cancelled() {
                requests.abandoned.insert(self.id);
            }
        }
    }
}

struct SendGuard<'a> {
    connection: &'a Connection,
    id: u64,
    armed: bool,
}

impl Drop for SendGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.connection.forget_sent(self.id);
        }
    }
}

/// Tells each who asks for them the whole line `line` of stderr.
fn tell_line(told: &mut Vec<mpsc::UnboundedSender<String>>, line: &[u8]) {
    let text = String::from_utf8_lossy(line).trim().to_owned();
    if !text.is_empty() {
        told.retain(|tx| tx.send(text.clone()).is_ok());
    }
}

pub struct Connection {
    processes: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    next_id: AtomicU64,
    /// Live (`waiting`, `sent`) and `abandoned` request maps guarded by one lock so transitions are atomic.
    requests: Mutex<Requests>,
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
            requests: Mutex::default(),
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
            if *byte == b'\n' {
                tell_line(&mut told, &std::mem::take(line));
            } else if line.len() < STDERR_LINE_BYTES {
                line.push(*byte);
            }
        }
    }

    /// A whole line the process wrote to stdout: a message, or a line that is none, which is passed over.
    fn stdout_line(&self, text: &[u8], out: &mpsc::UnboundedSender<Incoming>) {
        if text.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        match serde_json::from_slice::<Value>(text) {
            Ok(message) => self.dispatch(message, out),
            Err(error) => tracing::warn!("[acp] a line of the agent's output is not JSON: {error}"),
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

    /// The agent broke the protocol in a way that leaves a request without its answer, or stdin stalled past
    /// cancellation/refusal bounds: the process is ended, which fails everything that waits on it.
    pub(crate) fn break_off(&self, why: &str) {
        tracing::warn!("[acp] the agent's process is ended: {why}");
        lock(&self.broken).get_or_insert_with(|| why.to_owned());
        self.kill();
    }

    /// A request whose answer this call waits for.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, Fault> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut requests = lock(&self.requests);
            // The reader fails what waits only after it fired the token: a request entered after that is failed here.
            if self.exited.is_cancelled() {
                return Err(self.closed());
            }
            requests.waiting.insert(id, tx);
        }
        let mut guard = RequestGuard { connection: self, id, armed: true };
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let result = rx.await.unwrap_or_else(|_| Err(self.closed()));
        guard.armed = false;
        result
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
        lock(&self.requests).sent.insert(id);
        let mut guard = SendGuard { connection: self, id, armed: true };
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        guard.armed = false;
        Ok(())
    }

    /// Removes an abandoned prompt id from `sent` and records it as abandoned atomically under one lock so
    /// unanswered cancelled prompts never accumulate and late answers never break off sibling sessions.
    pub(crate) fn forget_sent(&self, id: u64) {
        let mut requests = lock(&self.requests);
        if requests.sent.remove(&id) && !self.exited.is_cancelled() {
            requests.abandoned.insert(id);
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn sent_len(&self) -> usize {
        lock(&self.requests).sent.len()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn waiting_len(&self) -> usize {
        lock(&self.requests).waiting.len()
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
            // The agent's answer to a line it could not read as a request (JSON-RPC's parse error, invalid request): it
            // answers no request of this client's, and the process goes on.
            (None, Some(id)) if id.is_null() => {
                if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
                    tracing::warn!("[acp] the agent reported an error of no request: {}", rpc_error(error).message);
                }
                return;
            }
            (None, Some(id)) => {
                let result = match message.get("error") {
                    Some(error) if !error.is_null() => Err(rpc_error(error)),
                    _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let outcome = id.as_u64().map(|id| {
                    let mut requests = lock(&self.requests);
                    if let Some(waiter) = requests.waiting.remove(&id) {
                        DispatchResponse::Waiter(waiter)
                    } else if requests.sent.remove(&id) {
                        DispatchResponse::Sent(id)
                    } else if requests.abandoned.take(id) {
                        DispatchResponse::Abandoned
                    } else {
                        DispatchResponse::Unknown
                    }
                });
                match outcome {
                    Some(DispatchResponse::Waiter(waiter)) => {
                        let _ = waiter.send(result.map_err(Fault::Rpc));
                        return;
                    }
                    Some(DispatchResponse::Sent(id)) => Incoming::Response { id, result },
                    Some(DispatchResponse::Abandoned) => return,
                    // An answer to no request of this client: the request it was meant for would wait for ever.
                    Some(DispatchResponse::Unknown) | None => return self.break_off("it answered a request this client never made"),
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
async fn read(connection: std::sync::Weak<Connection>, events: Box<dyn EventSource<ProcessEvent>>, out: mpsc::UnboundedSender<Incoming>, temp: Option<Temp>) {
    read_with_limit(connection, events, out, temp, MAX_STDOUT_LINE_BYTES).await;
}

async fn read_with_limit(
    connection: std::sync::Weak<Connection>,
    mut events: Box<dyn EventSource<ProcessEvent>>,
    out: mpsc::UnboundedSender<Incoming>,
    temp: Option<Temp>,
    max_stdout_line_bytes: usize,
) {
    let mut line: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut err_line: Vec<u8> = Vec::new();
    let mut exited = false;
    'reading: while let Some(event) = events.next().await {
        let Some(connection) = connection.upgrade() else { continue };
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => {
                for byte in bytes {
                    if byte == b'\n' {
                        connection.stdout_line(&std::mem::take(&mut line), &out);
                    } else if line.len() >= max_stdout_line_bytes {
                        oversized = true;
                        line.clear();
                        line.shrink_to_fit();
                        connection.break_off(&format!("it wrote a stdout frame exceeding {max_stdout_line_bytes} bytes"));
                        break 'reading;
                    } else {
                        line.push(byte);
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
    // What the process wrote last with no end of line after it is a whole line too, read before its exit fails what waits.
    if let Some(connection) = &connection {
        if !oversized {
            connection.stdout_line(&line, &out);
        }
        tell_line(&mut lock(&connection.stderr_lines), &err_line);
    }
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
    let waiting: Vec<_> = {
        let mut requests = lock(&connection.requests);
        requests.sent.clear();
        requests.abandoned.clear();
        requests.waiting.drain().collect()
    };
    for (_, waiter) in waiting {
        let _ = waiter.send(Err(connection.closed()));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use async_trait::async_trait;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnedProcess;

    use super::*;

    struct ScriptedEvents(mpsc::UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for ScriptedEvents {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    struct ScriptedProcesses {
        events: Mutex<Option<mpsc::UnboundedReceiver<ProcessEvent>>>,
        killed: Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait]
    impl ProcessManager for ScriptedProcesses {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            Ok(SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let rx = lock(&self.events).take().expect("single subscriber");
            Ok(Box::new(ScriptedEvents(rx)))
        }

        fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, _handle: &ProcessHandle, _bytes: Vec<u8>) -> Result<(), ProcessError> {
            Ok(())
        }

        fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }

        fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    /// A process that takes none of its input and writes nothing until it is ended.
    struct Stalled;

    struct Silent;

    #[async_trait]
    impl EventSource<ProcessEvent> for Silent {
        async fn next(&mut self) -> Option<ProcessEvent> {
            std::future::pending().await
        }
    }

    #[async_trait]
    impl ProcessManager for Stalled {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            Ok(SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Ok(Box::new(Silent))
        }

        fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, _handle: &ProcessHandle, _bytes: Vec<u8>) -> Result<(), ProcessError> {
            std::future::pending().await
        }

        fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
            Ok(())
        }

        fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    #[tokio::test]
    async fn dropped_request_and_forgotten_sent_ids_are_cleaned_up_without_breaking_on_late_answers() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let processes: Arc<dyn ProcessManager> = Arc::new(ScriptedProcesses { events: Mutex::new(Some(event_rx)), killed: killed.clone() });
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, mut incoming) =
            Connection::start(processes, Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd })
                .await
                .expect("connection");

        // Dropping a pending Connection::request immediately removes its entry from `waiting`.
        let req_fut = connection.request("session/new", json!({}));
        let _ = mixdog_rt::time::timeout(std::time::Duration::from_millis(10), req_fut).await;
        assert_eq!(connection.waiting_len(), 0, "dropped request must be removed from waiting");

        // Late answer for the dropped request id (1) must be ignored instead of killing the connection.
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        connection.dispatch(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }), &out_tx);
        assert!(!killed.load(Ordering::SeqCst), "late answer to dropped request must not kill connection");
        assert!(out_rx.try_recv().is_err());

        // Forgetting an abandoned prompt id removes it from `sent`, and a late answer for it is ignored.
        let prompt_id = connection.send("session/prompt", json!({})).await.expect("send");
        assert_eq!(connection.sent_len(), 1);
        connection.forget_sent(prompt_id);
        assert_eq!(connection.sent_len(), 0, "forgotten prompt id must be removed from sent");
        connection.dispatch(json!({ "jsonrpc": "2.0", "id": prompt_id, "result": { "stopReason": "cancelled" } }), &out_tx);
        assert!(!killed.load(Ordering::SeqCst), "late answer to forgotten prompt must not kill connection");
        assert!(out_rx.try_recv().is_err());

        // An answer to a truly unknown id still breaks off the connection.
        connection.dispatch(json!({ "jsonrpc": "2.0", "id": 99_999, "result": {} }), &out_tx);
        assert!(killed.load(Ordering::SeqCst), "bogus response id must still break off the connection");

        drop(event_tx);
        let _ = incoming.recv().await;
    }

    /// Abandoning >256 requests advances the monotonic eviction watermark so valid late answers for
    /// earlier evicted abandoned ids never break off sibling sessions, while live requests still resolve and
    /// unissued ids still break off the connection.
    #[tokio::test]
    async fn late_answers_after_more_than_256_abandoned_requests_never_break_connection() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let processes: Arc<dyn ProcessManager> = Arc::new(ScriptedProcesses { events: Mutex::new(Some(event_rx)), killed: killed.clone() });
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, mut incoming) =
            Connection::start(processes, Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd })
                .await
                .expect("connection");

        // Keep one live request open BEFORE abandoning >256 subsequent requests.
        let live_id = connection.send("session/prompt", json!({})).await.expect("live send");
        assert_eq!(live_id, 1);

        let total_abandoned = MAX_ABANDONED_IDS + 44;
        let mut abandoned_ids = Vec::with_capacity(total_abandoned);
        for _ in 0..total_abandoned {
            let id = connection.send("session/prompt", json!({})).await.expect("send");
            connection.forget_sent(id);
            abandoned_ids.push(id);
        }
        assert_eq!(connection.sent_len(), 1, "only live_id remains in sent");

        // Late answers for the earliest (evicted past MAX_ABANDONED_IDS) and latest abandoned ids must all be ignored.
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        for &id in &[abandoned_ids[0], abandoned_ids[1], abandoned_ids[20], abandoned_ids[total_abandoned - 1]] {
            connection.dispatch(json!({ "jsonrpc": "2.0", "id": id, "result": { "stopReason": "cancelled" } }), &out_tx);
            assert!(!killed.load(Ordering::SeqCst), "valid late answer for abandoned id {id} must not kill connection");
            assert!(out_rx.try_recv().is_err());
        }

        // The live request opened before the evicted watermark still delivers its response normally.
        connection.dispatch(json!({ "jsonrpc": "2.0", "id": live_id, "result": { "stopReason": "end_turn" } }), &out_tx);
        assert!(!killed.load(Ordering::SeqCst));
        assert!(matches!(out_rx.try_recv(), Ok(Incoming::Response { id, result: Ok(_) }) if id == live_id));

        // Unissued ids (0 or past issued range) still break off the connection.
        connection.dispatch(json!({ "jsonrpc": "2.0", "id": 0, "result": {} }), &out_tx);
        assert!(killed.load(Ordering::SeqCst), "id 0 must still break off the connection");

        drop(event_tx);
        let _ = incoming.recv().await;
    }

    /// Removing an id from `sent` and inserting it into `abandoned` happen under one lock,
    /// so a concurrent response dispatch can never fall between them and call `break_off`.
    #[tokio::test]
    async fn concurrent_forget_sent_and_dispatch_has_no_race_window() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let processes: Arc<dyn ProcessManager> = Arc::new(ScriptedProcesses { events: Mutex::new(Some(event_rx)), killed: killed.clone() });
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, mut incoming) =
            Connection::start(processes, Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd })
                .await
                .expect("connection");

        let rounds = 400u64;
        let mut ids = Vec::with_capacity(rounds as usize);
        for _ in 0..rounds {
            ids.push(connection.send("session/prompt", json!({})).await.expect("send"));
        }

        let (out_tx, _out_rx) = mpsc::unbounded_channel();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let conn_forget = connection.clone();
        let ids_forget = ids.clone();
        let b1 = barrier.clone();
        let t1 = std::thread::spawn(move || {
            b1.wait();
            for id in ids_forget {
                conn_forget.forget_sent(id);
            }
        });
        let conn_dispatch = connection.clone();
        let b2 = barrier.clone();
        let t2 = std::thread::spawn(move || {
            b2.wait();
            for id in ids {
                conn_dispatch.dispatch(json!({ "jsonrpc": "2.0", "id": id, "result": {} }), &out_tx);
            }
        });
        t1.join().expect("forget thread");
        t2.join().expect("dispatch thread");
        assert!(!killed.load(Ordering::SeqCst), "concurrent forget_sent and dispatch must never fall into a race window");

        drop(event_tx);
        let _ = incoming.recv().await;
    }

    #[tokio::test]
    async fn a_request_whose_call_is_dropped_leaves_no_answer_awaited() {
        let _ = mixdog_rt::testing::tokens();
        let cwd = AbsPath::new(std::env::temp_dir()).expect("an absolute folder");
        let launch = Launch { program: "agent".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd };
        let (connection, _incoming) = Connection::start(Arc::new(Stalled), launch).await.expect("the process starts");
        let limit = Duration::from_millis(20);
        assert!(mixdog_rt::time::timeout(limit, connection.request("initialize", json!({}))).await.is_err());
        let id = connection.reserve();
        assert!(mixdog_rt::time::timeout(limit, connection.send_as(id, "session/prompt", json!({}))).await.is_err());
        assert_eq!(connection.waiting_len(), 0, "the request's answer is awaited no more");
        assert_eq!(connection.sent_len(), 0, "the prompt's answer is awaited no more");
    }

    #[tokio::test]
    async fn oversized_stdout_frame_breaks_off_cleanly_without_unbounded_buffering() {
        let _ = mixdog_rt::testing::tokens();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let processes = Arc::new(ScriptedProcesses { events: Mutex::new(Some(event_rx)), killed: killed.clone() });
        let cwd = AbsPath::new(std::env::temp_dir()).expect("an absolute folder");
        let launch = Launch { program: "agent".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd };
        let (connection, _incoming) = Connection::start(processes, launch).await.expect("starts");

        // Feed an unterminated line larger than MAX_STDOUT_LINE_BYTES with NO newline and NO EOF:
        // the reader must fail fast and break off the connection immediately rather than waiting forever.
        let chunk = vec![b'x'; 1024 * 1024];
        for seq in 1..=33 {
            let _ = event_tx.send(ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: chunk.clone() });
        }

        mixdog_rt::time::timeout(Duration::from_secs(5), connection.exited().cancelled())
            .await
            .expect("connection must fail fast on unterminated oversized stdout frame");
        assert!(killed.load(Ordering::SeqCst), "oversized stdout frame must break off the connection");
        assert!(connection.closed().to_string().contains("frame"), "{}", connection.closed());
        drop(event_tx);
    }
}
