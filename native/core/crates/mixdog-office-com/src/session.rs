//! One host process and the client that talks to it. A session host is long-lived and speaks a line
//! protocol (one JSON request with a `requestId` per line in, JSON messages out); a one-shot host takes one JSON
//! payload on stdin and answers with its last stdout line. Both are driven the same way underneath: stdin is a channel
//! whose closing is the host's EOF, and a cancel or a timeout only ever sends that EOF, so the host's own `finally`
//! runs `Close-SessionState`. A host is never killed to cancel a call.

use std::collections::HashMap;
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_rt::TaskClass;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::ChildStderr;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::runtime::Handle;
use tokio::sync::OnceCell;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::cleanup;
use crate::identity::Identity;
use crate::sweep::Sweeper;

/// The `backend` every failure answer names.
pub(crate) const BACKEND: &str = "microsoft-office-com";

/// A session host's stderr is kept as this many trailing characters.
const STDERR_TAIL: usize = 16_000;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// A host program and its leading arguments (the host arguments follow them).
pub(crate) type HostCommand = (PathBuf, Vec<OsString>);

/// The first argument of the host, for both kinds of host.
const HOST_ARG: &str = "office-com-host";

/// The second argument of the host when it is a session host.
const SESSION_ARG: &str = "--session";

/// The argument that carries the data directory the host keeps its record of the application under.
const DATA_DIR_ARG: &str = crate::host::ledger::DATA_DIR_FLAG;

/// The arguments the host program is started with.
pub(crate) fn host_args(session: bool, data_dir: &Path) -> Vec<OsString> {
    let mut args = vec![OsString::from(HOST_ARG)];
    if session {
        args.push(OsString::from(SESSION_ARG));
    }
    args.push(OsString::from(DATA_DIR_ARG));
    args.push(data_dir.as_os_str().to_owned());
    args
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A host process that has been started: its pipes and the child itself.
pub(crate) struct Running {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

/// Starts `program args...` hidden, with piped stdio. The host is not tied to this process's lifetime: dropping its
/// handle never kills it, because the application it owns is only closed by the host's own cleanup. Runs as a spawn-io
/// lane job; `rt` is the runtime the pipes register with.
pub(crate) fn spawn_host(program: &Path, args: &[OsString], rt: &Handle) -> std::io::Result<Running> {
    let _entered = rt.enter();
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    #[cfg(windows)]
    let mut child = {
        // CREATE_NO_WINDOW, and CREATE_BREAKAWAY_FROM_JOB: the ext-host worker's job kills what it holds when the worker
        // ends, and a host killed that way never runs the cleanup that closes its document and quits its application.
        // A job that does not allow breakaway refuses the flag (ERROR_ACCESS_DENIED): the host then starts inside the job,
        // and the sweep of the next start is its only protection.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
        match command.spawn() {
            Ok(child) => child,
            Err(error) if error.raw_os_error() == Some(5) => {
                command.creation_flags(CREATE_NO_WINDOW);
                command.spawn()?
            }
            Err(error) => return Err(error),
        }
    };
    #[cfg(not(windows))]
    let mut child = command.spawn()?;
    let missing = |what: &str| std::io::Error::other(format!("host {what} was not piped"));
    let stdin = child.stdin.take().ok_or_else(|| missing("stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| missing("stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| missing("stderr"))?;
    Ok(Running { child, stdin, stdout, stderr })
}

/// What is known of the host process: whether it has exited (with its exit code, `None` when a signal ended it) and
/// whether its output streams have ended too.
#[derive(Clone, Copy, Debug, Default)]
struct HostState {
    exit: Option<Option<i32>>,
    closed: bool,
}

/// Settles when the host process is gone. A one-shot result may be returned while the host is still ending (the grace
/// period lapsed): callers that own files the host holds open wait on this.
pub struct HostExit(watch::Receiver<HostState>);

impl HostExit {
    /// Waits until the host has exited.
    pub async fn wait(mut self) {
        let _ = self.0.wait_for(|state| state.exit.is_some() || state.closed).await;
    }
}

/// How a client uses its host.
pub(crate) struct Attach {
    /// The session this client serves; empty for a one-shot host.
    pub(crate) session_id: String,
    /// A one-shot host's output is collected whole; a session host's lines are messages.
    pub(crate) one_shot: bool,
    pub(crate) sessions: Weak<Sessions>,
    pub(crate) grace: Duration,
    pub(crate) sweeper: Sweeper,
}

#[derive(Default)]
struct Shared {
    identity: Identity,
    pending: HashMap<String, oneshot::Sender<Value>>,
    stdout: String,
    stderr: String,
    closed: bool,
    closing: bool,
    /// Lines for the host's stdin; taking it away is the host's EOF.
    stdin: Option<mpsc::UnboundedSender<String>>,
}

pub(crate) struct HostClient {
    session_id: String,
    one_shot: bool,
    grace: Duration,
    sweeper: Sweeper,
    sessions: Weak<Sessions>,
    shared: Mutex<Shared>,
    state: watch::Receiver<HostState>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    cleanup: OnceCell<Value>,
}

impl HostClient {
    /// Takes over a started host: tasks feed its stdin, read its stdout and stderr and watch it exit.
    pub(crate) fn attach(running: Running, how: Attach) -> Arc<Self> {
        let Running { child, stdin, stdout, stderr } = running;
        let (lines, input) = mpsc::unbounded_channel();
        let (state_tx, state) = watch::channel(HostState::default());
        let (kill_tx, kill_rx) = oneshot::channel();
        let client = Arc::new(Self {
            session_id: how.session_id,
            one_shot: how.one_shot,
            grace: how.grace,
            sweeper: how.sweeper,
            sessions: how.sessions,
            shared: Mutex::new(Shared { stdin: Some(lines), ..Shared::default() }),
            state,
            kill: Mutex::new(Some(kill_tx)),
            cleanup: OnceCell::new(),
        });
        mixdog_rt::spawn("office.host.stdin", TaskClass::Work, write_lines(stdin, input));
        let out = mixdog_rt::spawn("office.host.stdout", TaskClass::Work, read_stdout(client.clone(), stdout));
        let err = mixdog_rt::spawn("office.host.stderr", TaskClass::Work, read_stderr(client.clone(), stderr));
        mixdog_rt::spawn("office.host.exit", TaskClass::Work, watch_exit(child, kill_rx, [out, err], state_tx, client.sweeper.clone()));
        if !client.one_shot {
            let watcher = client.clone();
            mixdog_rt::spawn("office.host.closed", TaskClass::Work, async move {
                watcher.wait_closed().await;
                // A host that left on its own (crashed, or exited after a failed finalize) fails what was waiting.
                if !watcher.is_closed() {
                    watcher.stop(&watcher.exit_reason());
                }
            });
        }
        client
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn is_closed(&self) -> bool {
        lock(&self.shared).closed
    }

    pub(crate) fn is_closing(&self) -> bool {
        lock(&self.shared).closing
    }

    pub(crate) fn identity(&self) -> Identity {
        lock(&self.shared).identity.clone()
    }

    pub(crate) fn stderr(&self) -> String {
        lock(&self.shared).stderr.clone()
    }

    pub(crate) fn stdout(&self) -> String {
        lock(&self.shared).stdout.clone()
    }

    /// The host's exit code; `None` while it runs or when a signal ended it.
    pub(crate) fn exit_code(&self) -> Option<i32> {
        self.state.borrow().exit.flatten()
    }

    /// Why a host that is gone failed what was waiting: what it said on stderr, else how it exited.
    fn exit_reason(&self) -> String {
        let stderr = self.stderr();
        let reason = stderr.trim();
        if !reason.is_empty() {
            return reason.to_owned();
        }
        let code = self.exit_code().map_or_else(|| "null".to_owned(), |code| code.to_string());
        format!("Microsoft Office session host exited with code {code}")
    }

    pub(crate) fn has_exited(&self) -> bool {
        self.state.borrow().exit.is_some()
    }

    pub(crate) fn host_exit(&self) -> HostExit {
        HostExit(self.state.clone())
    }

    /// Resolves once the host has exited and its output has ended.
    pub(crate) async fn wait_closed(&self) {
        let mut state = self.state.clone();
        let _ = state.wait_for(|state| state.closed).await;
    }

    /// Queues one line for the host's stdin; `false` when stdin has been closed.
    pub(crate) fn send(&self, line: String) -> bool {
        lock(&self.shared).stdin.as_ref().is_some_and(|stdin| stdin.send(line).is_ok())
    }

    /// The host's EOF: what is queued is written first.
    pub(crate) fn end_stdin(&self) {
        lock(&self.shared).stdin = None;
    }

    /// Ends the host process. Only a graceful close that outlasted its wait does this.
    pub(crate) fn kill(&self) {
        if let Some(kill) = lock(&self.kill).take() {
            let _ = kill.send(());
        }
    }

    /// Marks the client closed (its session is no longer reachable), answers every waiting request with a failure and
    /// sends the host its EOF, which runs the host's verified document cleanup, including an open that has not
    /// answered yet. The host is not killed: that would bypass its `finally` and orphan the COM application.
    pub(crate) fn stop(&self, error: &str) {
        let pending = {
            let mut shared = lock(&self.shared);
            if shared.closed {
                return;
            }
            shared.closed = true;
            shared.stdin = None;
            std::mem::take(&mut shared.pending)
        };
        if let Some(sessions) = self.sessions.upgrade() {
            sessions.forget(self);
        }
        let failure = json!({
            "ok": false,
            "backend": BACKEND,
            "error": if error.is_empty() { "Microsoft Office session host stopped" } else { error },
        });
        for (_, waiting) in pending {
            let _ = waiting.send(failure.clone());
        }
    }

    /// Marks the client closed without answering anyone: the end of a close that the host answered.
    pub(crate) fn mark_closed(&self) {
        lock(&self.shared).closed = true;
    }

    /// Asks the host to end through its stdin and waits the grace period for it to go. A host that does not exit in
    /// time is reported pending and left alone: nothing proves a shared or user document is safe to kill, and the host
    /// cleans up when its in-flight COM call returns. The outcome is computed once; later callers get the same
    /// answer. The work runs as its own task, so a caller that stops waiting does not interrupt it.
    pub(crate) fn drain_task(self: &Arc<Self>, error: &str) -> JoinHandle<Value> {
        lock(&self.shared).closing = true;
        let client = self.clone();
        let error = error.to_owned();
        mixdog_rt::spawn("office.host.drain", TaskClass::Work, async move {
            client.cleanup.get_or_init(|| client.drain_once(&error)).await.clone()
        })
    }

    pub(crate) async fn drain(self: &Arc<Self>, error: &str) -> Value {
        self.drain_task(error).await.unwrap_or_else(|_| cleanup::pending())
    }

    async fn drain_once(&self, error: &str) -> Value {
        // A host that was still running when asked to end fails what is waiting as any host that leaves does; one
        // that had already exited fails it with the reason the caller gave.
        let (exited, reason) = if self.has_exited() {
            (true, error.to_owned())
        } else {
            self.end_stdin();
            let exited = mixdog_rt::time::timeout(self.grace, self.wait_closed()).await.is_ok();
            (exited, self.exit_reason())
        };
        if !exited {
            return cleanup::pending();
        }
        let failures = cleanup::failure_lines(&self.stderr());
        self.stop(&reason);
        let clean_exit = self.exit_code().is_none_or(|code| code == 0);
        if !failures.is_empty() || !clean_exit {
            self.sweeper.request();
        }
        cleanup::finished(failures.is_empty() && clean_exit, failures)
    }

    /// Sends `payload` to the session host and answers with the host's reply (without its `requestId`). A cancel or a
    /// timeout drains the host first, so the failure carries the cleanup outcome.
    pub(crate) async fn request(self: &Arc<Self>, payload: &Value, timeout: Duration, cancel: &CancellationToken) -> Value {
        {
            let shared = lock(&self.shared);
            if shared.closed || shared.closing {
                return json!({"ok": false, "backend": BACKEND, "error": "Microsoft Office session host is unavailable"});
            }
        }
        let request_id = format!("office_request_{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
        let cancelled = "Microsoft Office operation was cancelled";
        if cancel.is_cancelled() {
            return self.fail_after_cleanup(cancelled, cancelled, true).await;
        }
        let (reply, answer) = oneshot::channel();
        lock(&self.shared).pending.insert(request_id.clone(), reply);
        let mut line = match payload {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        line.insert("requestId".to_owned(), Value::String(request_id.clone()));
        if !self.send(format!("{}\n", Value::Object(line))) {
            lock(&self.shared).pending.remove(&request_id);
            let message = "Microsoft Office session host input is closed";
            return self.fail_after_cleanup(message, message, false).await;
        }
        tokio::select! {
            reply = answer => reply.unwrap_or_else(|_| {
                json!({"ok": false, "backend": BACKEND, "error": "Microsoft Office session host stopped"})
            }),
            () = cancel.cancelled() => {
                lock(&self.shared).pending.remove(&request_id);
                self.fail_after_cleanup(cancelled, cancelled, true).await
            }
            () = mixdog_rt::time::sleep(timeout) => {
                lock(&self.shared).pending.remove(&request_id);
                let millis = timeout.as_millis();
                self.fail_after_cleanup(
                    &format!("Microsoft Office session timed out after {millis}ms"),
                    &format!("Microsoft Office operation timed out after {millis}ms"),
                    false,
                )
                .await
            }
        }
    }

    /// Drains the host for `reason` and answers a failure that says `message` and what the cleanup came to.
    async fn fail_after_cleanup(self: &Arc<Self>, reason: &str, message: &str, cancelled: bool) -> Value {
        let cleanup = self.drain(reason).await;
        let mut failure = Map::new();
        failure.insert("ok".to_owned(), Value::Bool(false));
        failure.insert("backend".to_owned(), Value::String(BACKEND.to_owned()));
        if cancelled {
            failure.insert("cancelled".to_owned(), Value::Bool(true));
        }
        failure.insert("error".to_owned(), Value::String(cleanup::cleanup_error(message, Some(&cleanup))));
        failure.insert("cleanup".to_owned(), cleanup);
        Value::Object(failure)
    }

    /// One line of a session host's stdout: its identity is taken in before the response is settled (an ownership
    /// notice can come before an open response or after cancellation removed the request), then the request it answers
    /// is resolved. Anything that is not a JSON object is ignored.
    fn on_message(&self, text: &str) {
        let Ok(Value::Object(mut message)) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let request_id = match message.get("requestId") {
            Some(Value::String(id)) => id.clone(),
            _ => String::new(),
        };
        let waiting = {
            let mut shared = lock(&self.shared);
            let Shared { identity, pending, .. } = &mut *shared;
            identity.accept(&self.session_id, &Value::Object(message.clone()));
            pending.remove(&request_id)
        };
        if let Some(waiting) = waiting {
            message.shift_remove("requestId");
            let _ = waiting.send(Value::Object(message));
        }
    }

    fn on_stderr(&self, text: &str) {
        let mut shared = lock(&self.shared);
        shared.stderr.push_str(text);
        if !self.one_shot {
            let excess = shared.stderr.chars().count().saturating_sub(STDERR_TAIL);
            if excess > 0 {
                let cut = shared.stderr.char_indices().nth(excess).map_or(0, |(at, _)| at);
                shared.stderr.drain(..cut);
            }
        }
    }
}

/// Writes queued lines to the host; when the queue is closed and empty, dropping stdin is the EOF.
async fn write_lines(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

async fn read_stdout(client: Arc<HostClient>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                if client.one_shot {
                    lock(&client.shared).stdout.push_str(&text);
                } else if !text.trim().is_empty() {
                    client.on_message(text.trim());
                }
            }
        }
    }
}

async fn read_stderr(client: Arc<HostClient>, mut stderr: ChildStderr) {
    let mut chunk = vec![0_u8; 8192];
    // A chunk can end inside a character: the bytes of an unfinished one wait for the next chunk.
    let mut carried: Vec<u8> = Vec::new();
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                carried.extend_from_slice(&chunk[..read]);
                let complete = match std::str::from_utf8(&carried) {
                    Ok(_) => carried.len(),
                    Err(error) if error.error_len().is_none() => error.valid_up_to(),
                    Err(_) => carried.len(),
                };
                let rest = carried.split_off(complete);
                client.on_stderr(&String::from_utf8_lossy(&carried));
                carried = rest;
            }
        }
    }
    if !carried.is_empty() {
        client.on_stderr(&String::from_utf8_lossy(&carried));
    }
}

/// Owns the child from start to exit. A kill request ends it; otherwise it only waits.
async fn watch_exit(
    mut child: Child,
    mut kill: oneshot::Receiver<()>,
    readers: [JoinHandle<()>; 2],
    state: watch::Sender<HostState>,
    sweeper: Sweeper,
) {
    let status = tokio::select! {
        status = child.wait() => status,
        Ok(()) = &mut kill => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    let code = status.ok().and_then(|status| status.code());
    state.send_modify(|state| state.exit = Some(code));
    // A host that left with a failure or a signal did not finish its cleanup: what it recorded is swept.
    if code != Some(0) {
        sweeper.request();
    }
    for reader in readers {
        let _ = reader.await;
    }
    state.send_modify(|state| state.closed = true);
}

#[derive(Default)]
struct SessionTable {
    clients: HashMap<String, Arc<HostClient>>,
    starting: HashSet<String>,
}

/// The live session hosts, by session id.
#[derive(Default)]
pub(crate) struct Sessions {
    table: Mutex<SessionTable>,
}

impl Sessions {
    pub(crate) fn get(&self, id: &str) -> Option<Arc<HostClient>> {
        lock(&self.table).clients.get(id).cloned()
    }

    pub(crate) fn all(&self) -> Vec<Arc<HostClient>> {
        lock(&self.table).clients.values().cloned().collect()
    }

    /// Reserves `id` for a host that is starting; `false` when the id is taken.
    pub(crate) fn reserve(&self, id: &str) -> bool {
        let mut table = lock(&self.table);
        if table.clients.contains_key(id) || table.starting.contains(id) {
            return false;
        }
        table.starting.insert(id.to_owned());
        true
    }

    /// Gives up a reservation whose host did not start.
    pub(crate) fn release(&self, id: &str) {
        lock(&self.table).starting.remove(id);
    }

    /// Turns a reservation into a live session.
    pub(crate) fn register(&self, client: Arc<HostClient>) {
        let mut table = lock(&self.table);
        table.starting.remove(client.session_id());
        table.clients.insert(client.session_id().to_owned(), client);
    }

    pub(crate) fn remove(&self, id: &str) {
        lock(&self.table).clients.remove(id);
    }

    fn forget(&self, client: &HostClient) {
        let mut table = lock(&self.table);
        if table.clients.get(client.session_id()).is_some_and(|held| std::ptr::eq(Arc::as_ptr(held), client)) {
            table.clients.remove(client.session_id());
        }
    }
}

#[cfg(test)]
mod host_args_tests {
    use super::*;

    #[test]
    fn the_host_arguments_name_the_kind_of_host_and_the_data_directory() {
        let dir = Path::new("/data/dir");
        assert_eq!(host_args(false, dir), ["office-com-host", "--data-dir", "/data/dir"].map(OsString::from));
        assert_eq!(host_args(true, dir), ["office-com-host", "--session", "--data-dir", "/data/dir"].map(OsString::from));
    }
}
