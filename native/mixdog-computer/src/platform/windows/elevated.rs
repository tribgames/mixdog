//! The environment does not cross UAC, so everything the worker needs travels
//! on its command line: the token, the request's SHA-256, the input marker,
//! the ledger path and this process's identity.

use super::native::Process;
use super::process::creation_time;
use crate::elevated_launch::Cancellation;
use crate::protocol::{Obj, Req};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{ERROR_CANCELLED, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Security::Cryptography::{BCRYPT_SHA256_ALG_HANDLE, BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom, BCryptHash};
use windows::Win32::Storage::FileSystem::{
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, GetProcessId, INFINITE, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForMultipleObjects, WaitForSingleObject,
};
use windows::Win32::UI::Shell::{SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::core::{HSTRING, PCWSTR};

/// How long the launcher waits before it asks the worker to cancel.
const LAUNCHER_DEADLINE: Duration = Duration::from_secs(120);
/// How long a cancelled worker has to stop before its cleanup is unconfirmed.
const CANCEL_GRACE: Duration = Duration::from_secs(6);
/// The worker's own deadline, inside the launcher's.
const WORKER_DEADLINE: Duration = Duration::from_secs(110);
const POLL: Duration = Duration::from_millis(50);

const REQUEST_FILE: &str = "request.json";
const RESPONSE_FILE: &str = "response.txt";
const CANCEL_FILE: &str = "cancel";
/// The elevated worker's own no-activate and shield ledger, in the launch folder.
const WORKER_LEDGER_FILE: &str = "worker.ledger";
const INCOMPLETE: &str = "privileged worker environment is incomplete";

/// The launcher's grant: the worker's input child admits nothing before it.
const GRANT_FILE: &str = "grant";
/// The launcher's revocation of the worker's scope.
const REVOKE_FILE: &str = "revoke";
/// The supervisor's acknowledgement: the input child closed admission, or exited.
const CLOSED_FILE: &str = "closed";
use crate::platform::{ELEVATED_GRANT_LINE as GRANT_LINE, ELEVATED_REVOKE_LINE as REVOKE_LINE, ELEVATED_REVOKED_LINE as REVOKED_LINE};

/// The worker's answer to a foreground request; always Some on Windows.
pub fn run(scope: &crate::port::Scope, req: &Req) -> Option<Result<Obj, String>> {
    Some(launch(scope, req))
}

/// The launching executor's fence of one worker, registered with its scope before anything is staged. The fence owns the
/// worker's admission word (`port::windows::shared`, created fresh before the launch): the worker's input child maps it and
/// admits each call by one compare-exchange that succeeds only while it is open; the grant opens it (never once closed: a
/// worker that finishes launching after Off is never granted); the revocation closes it with one `fetch_or` that reads the
/// child's admitted unfinished calls. Safety is decided by that word alone: the grant, revoke and closed files only wake the
/// supervisor's relay. The fence also owns the supervisor's process handle for its whole life; the end of the worker's
/// cleanup is observed there and in the report the child left, never inferred.
pub(crate) struct WorkerFence {
    dir: PathBuf,
    token: String,
    word: crate::port::windows::shared::SharedWord,
    /// The supervisor's process, owned for the fence's whole life.
    process: std::sync::OnceLock<WorkerProcess>,
    /// The worker's cleanup once it ended, kept in memory before its directory (and the report in it) is removed.
    ended_cleanup: std::sync::OnceLock<crate::port::Cleanup>,
}

/// A started supervisor's process handle.
struct WorkerProcess(Process);

// SAFETY: a process handle is waited on and queried from any thread; it is closed once, on drop.
unsafe impl Send for WorkerProcess {}
// SAFETY: as above; the handle is only read.
unsafe impl Sync for WorkerProcess {}

impl WorkerFence {
    /// Creates the worker's admission word fresh; an error starts no worker.
    fn new(dir: PathBuf, token: String) -> Result<WorkerFence, String> {
        let word = crate::port::windows::shared::create(&token)?;
        Ok(WorkerFence { dir, token, word, process: std::sync::OnceLock::new(), ended_cleanup: std::sync::OnceLock::new() })
    }

    /// Takes the started supervisor's process for good, then opens the worker's admission unless it was closed (a late grant
    /// never reopens it). The handle the launcher waits on is the fence's.
    fn adopt_and_grant(&self, process: Process) -> (&Process, bool) {
        let process = &self.process.get_or_init(|| WorkerProcess(process)).0;
        let granted = crate::port::grant_word(crate::port::AdmissionWord::word(&self.word));
        if granted {
            // Only wakes the relay; the word decides.
            let _ = std::fs::write(self.dir.join(GRANT_FILE), &self.token);
        }
        (process, granted)
    }

    /// The supervisor's process ended, observed on its handle.
    fn exited(&self) -> bool {
        // SAFETY: the handle is open with SYNCHRONIZE for the fence's whole life.
        self.process.get().is_some_and(|process| unsafe { WaitForSingleObject((process.0).0, 0) } == WAIT_OBJECT_0)
    }

    /// The worker's exit was observed (a stop it did not confirm keeps its directory, read live): its cleanup is settled now,
    /// before the directory with the child's report is removed. Complete only on positive evidence: the worker answered with no
    /// worker failure (`answered`) and the child's last report (written at its end, `host::elevated::input`) says its cleanup
    /// completed. A worker failure, a crash, a missing response or an exit without that report: unconfirmed.
    fn ended(&self, answered: bool) {
        use crate::port::Cleanup;
        let completed = self.child_report().as_ref().and_then(|report| report.get("cleanup")).and_then(Value::as_str) == Some("complete");
        let _ = self.ended_cleanup.set(if answered && completed { Cleanup::Complete } else { Cleanup::Unconfirmed });
    }

    /// The child's last report, relayed by the supervisor (the token, then the report's JSON).
    fn child_report(&self) -> Option<Value> {
        let text = std::fs::read_to_string(self.dir.join(CLOSED_FILE)).ok()?;
        let (token, report) = text.split_once('\n')?;
        (token == self.token).then(|| serde_json::from_str(report).ok()).flatten()
    }
}

impl crate::port::Endpoint for WorkerFence {
    fn close(&self) -> usize {
        let unfinished = crate::port::close_word(crate::port::AdmissionWord::word(&self.word));
        // Wakes the relay, which tells the child to release what it holds; the word is already closed.
        let _ = std::fs::write(self.dir.join(REVOKE_FILE), &self.token);
        unfinished
    }

    /// Complete once the worker was never started, or its last report says so; unconfirmed when it ended without saying so
    /// (its receipts stay its own: the unelevated parent cannot release into an elevated target); pending while it runs.
    fn cleanup(&self) -> crate::port::Cleanup {
        use crate::port::Cleanup;
        let granted = crate::port::AdmissionWord::word(&self.word).load(std::sync::atomic::Ordering::SeqCst) & crate::port::word::OPEN != 0;
        if !granted || self.process.get().is_none() {
            return Cleanup::Complete;
        }
        if let Some(cleanup) = self.ended_cleanup.get() {
            return *cleanup;
        }
        match self.child_report().as_ref().and_then(|report| report.get("cleanup")).and_then(Value::as_str) {
            Some("complete") => Cleanup::Complete,
            Some("unconfirmed") => Cleanup::Unconfirmed,
            _ if self.exited() => Cleanup::Unconfirmed,
            _ => Cleanup::Pending,
        }
    }
}

// --- authentication ---------------------------------------------------------

/// SHA-256 as lowercase hex (Get-Sha256Hex of elevated-program.ts).
fn sha256_hex(bytes: &[u8]) -> Result<String, String> {
    let mut digest = [0u8; 32];
    // SAFETY: the buffers are valid for the lengths given; the algorithm is
    // the system's SHA-256 pseudo handle.
    let status = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, bytes, &mut digest) };
    if status.is_err() {
        return Err(format!("privileged_worker_unavailable: SHA-256 failed ({:#x})", status.0));
    }
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A random token of 43 URL-safe characters (the nonce of runElevatedRequest,
/// there randomBytes(24).toString('base64url')).
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    // SAFETY: the buffer is valid for its length.
    let status = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status.is_err() {
        return Err(format!("privileged_worker_unavailable: random token failed ({:#x})", status.0));
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The token shape the worker accepts (`^[A-Za-z0-9_-]{32,}$`).
fn token_valid(token: &str) -> bool {
    token.len() >= 32 && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Process identity: id and creation FILETIME.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    pid: u32,
    created: i64,
}

impl Identity {
    /// `pid:created`, the text form both the command line and the response
    /// file carry.
    fn parse(text: &str) -> Option<Identity> {
        let (pid, created) = text.split_once(':')?;
        Some(Identity { pid: pid.parse().ok()?, created: created.parse().ok()? })
    }
}

fn own_identity() -> Identity {
    // SAFETY: the pseudo handle needs no close.
    let (pid, created) = unsafe { (GetCurrentProcessId(), creation_time(GetCurrentProcess())) };
    Identity { pid, created }
}

const FILETIME_TO_DOTNET_TICKS: i64 = 504_911_232_000_000_000;
fn dotnet_ticks(filetime: i64) -> Option<i64> {
    (filetime > 0).then(|| filetime.checked_add(FILETIME_TO_DOTNET_TICKS)).flatten()
}

/// A read-only identity query. Access denied is never reported as a missing PID.
pub fn process_start_ticks(pid: u32) -> Result<Option<i64>, String> {
    if pid == 0 {
        return Err("process identity query requires a positive PID".into());
    }
    // SAFETY: only query rights, no mutation or inherited handle.
    let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(handle) => Process(handle),
        Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(None),
        Err(error) => return Err(format!("process identity query failed: {error}")),
    };
    match unsafe { WaitForSingleObject(process.0, 0) } {
        WAIT_OBJECT_0 => return Ok(None),
        WAIT_TIMEOUT => {}
        _ => return Err("process identity query failed: process state is unavailable".into()),
    }
    dotnet_ticks(creation_time(process.0)).map(Some).ok_or_else(|| "process identity query failed: creation time is unavailable".into())
}

/// Whether a process's identity is the one expected. A creation time that
/// could not be read (0 on either side) leaves the id alone to decide.
fn same_identity(expected: Identity, actual: Identity) -> bool {
    expected.pid == actual.pid && (expected.created == 0 || actual.created == 0 || expected.created == actual.created)
}

/// What the worker needs from its launcher, as command-line arguments.
#[derive(Debug, PartialEq)]
struct Launch {
    dir: PathBuf,
    token: String,
    request_sha256: String,
    marker: Option<i64>,
    ledger: Option<PathBuf>,
    parent: Identity,
}

impl Launch {
    fn quoted(value: &Path) -> String {
        format!("\"{}\"", value.display())
    }

    /// The worker's command line after the program name.
    fn command_line(&self) -> String {
        let mut line = format!(
            "--elevated-request {} --token {} --sha256 {} --parent {}:{}",
            Self::quoted(&self.dir),
            self.token,
            self.request_sha256,
            self.parent.pid,
            self.parent.created
        );
        if let Some(marker) = self.marker {
            line.push_str(&format!(" --marker {marker}"));
        }
        if let Some(ledger) = &self.ledger {
            line.push_str(&format!(" --ledger {}", Self::quoted(ledger)));
        }
        line
    }

    /// The arguments after `--elevated-request`: the directory, then
    /// `--name value` pairs.
    fn parse(args: &[String]) -> Result<Launch, String> {
        let mut args = args.iter();
        let dir = PathBuf::from(args.next().ok_or(INCOMPLETE)?);
        let (mut token, mut sha, mut marker, mut ledger, mut parent) = (None, None, None, None, None);
        while let Some(name) = args.next() {
            let value = args.next().ok_or(INCOMPLETE)?;
            match name.as_str() {
                "--token" => token = Some(value.clone()),
                "--sha256" => sha = Some(value.to_ascii_lowercase()),
                "--marker" => marker = value.parse::<i64>().ok(),
                "--ledger" => ledger = Some(PathBuf::from(value)),
                "--parent" => parent = Identity::parse(value),
                _ => return Err(INCOMPLETE.into()),
            }
        }
        let (Some(token), Some(request_sha256), Some(parent)) = (token, sha, parent) else {
            return Err(INCOMPLETE.into());
        };
        if !token_valid(&token) {
            return Err("privileged worker token is malformed".into());
        }
        Ok(Launch { dir, token, request_sha256, marker, ledger, parent })
    }
}

// --- response file ----------------------------------------------------------

/// The response file: the token, the worker's identity, then one JSON body.
fn response_text(token: &str, worker: Identity, body: &Value) -> String {
    format!("{token}\n{}:{}\n{body}\n", worker.pid, worker.created)
}

/// Authenticates a response file against the token and the process that was
/// started, then reads the reply it carries (assertElevatedReceipt,
/// parseElevatedResponse).
fn authenticated_body(text: &str, token: &str, worker: Identity, id: i64) -> Result<Value, String> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    let claimed = lines.next().unwrap_or_default();
    let identity = lines.next().and_then(Identity::parse);
    if claimed != token {
        return Err("privileged_worker_rejected: response authentication failed".into());
    }
    if !identity.is_some_and(|actual| same_identity(worker, actual)) {
        return Err("privileged_worker_rejected: response identity mismatch".into());
    }
    let body: Value = serde_json::from_str(lines.collect::<Vec<_>>().join("\n").trim())
        .map_err(|_| "privileged_worker_failed: structured response is missing".to_string())?;
    if body.get("worker_error").and_then(Value::as_str).is_none() && body.get("id").and_then(Value::as_i64) != Some(id) {
        return Err("privileged_worker_rejected: response id mismatch".into());
    }
    Ok(body)
}

fn read_response(text: &str, token: &str, worker: Identity, id: i64) -> Result<Obj, String> {
    let body = authenticated_body(text, token, worker, id)?;
    if let Some(error) = body.get("worker_error").and_then(Value::as_str) {
        return Err(format!("privileged_worker_failed: {error}"));
    }
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(match body.get("result") {
            Some(Value::Object(result)) => result.clone(),
            _ => Obj::new(),
        });
    }
    Err(body.get("error").and_then(Value::as_str).unwrap_or("privileged_worker_failed: structured response is missing").to_string())
}

/// Why there is no response file (elevatedLauncherFailure).
fn missing_response(exit_code: u32) -> String {
    match exit_code {
        1223 => "privileged_worker_cancelled: UAC consent was declined".into(),
        0 => "privileged_worker_unavailable: elevated worker returned no response".into(),
        code => format!("privileged_worker_launcher_failed: elevated worker exited with code {code}"),
    }
}

// --- launcher ---------------------------------------------------------------

fn launch(scope: &crate::port::Scope, req: &Req) -> Result<Obj, String> {
    let id = req.int("id").unwrap_or(0);
    let token = new_token()?;
    let dir = std::env::temp_dir().join(format!("mixdog-elevated-{token}"));
    let fence = Arc::new(WorkerFence::new(dir.clone(), token.clone())?);
    // Fenced before anything is staged: a closed scope starts no worker. The fence stays registered for good, so a later
    // revocation reads the worker again.
    if !scope.fence(fence.clone()) {
        return Err(crate::port::REVOKED.into());
    }
    let (outcome, unconfirmed) = launch_fenced(req, id, token, dir, &fence);
    // The worker ended (or never started), or its stop went unconfirmed: its cleanup state changed.
    scope.notify();
    // A supervisor still live after an unconfirmed stop is observed until its end: its later child reports and its exit are
    // published through the scope like every other executor's change.
    if let Some(tail) = unconfirmed {
        let (fence, scope) = (fence.clone(), scope.clone());
        std::thread::spawn(move || watch_unconfirmed(&fence, &tail, || scope.notify()));
    }
    outcome
}

/// What the observation of a live supervisor needs of its launch, once `launch` returned.
struct Unconfirmed {
    dir: PathBuf,
    token: String,
    ledger: Option<PathBuf>,
    worker: Identity,
    id: i64,
    /// The child's report as `launch` last read it: a later one is a change to publish.
    reported: Option<Value>,
}

/// Observes a supervisor whose stop went unconfirmed: each change in its directory that changes the child's report is published
/// (`changed`); its exit settles the fence's cleanup (positive evidence only: an authenticated answer and a complete child
/// report), hands its ledger to this host's own, removes its directory and is published. It waits on the process handle and the
/// directory's change notification; nothing is inferred from elapsed time.
fn watch_unconfirmed(fence: &WorkerFence, tail: &Unconfirmed, changed: impl Fn()) {
    let Some(process) = fence.process.get().map(|process| (process.0).0) else { return };
    // SAFETY: a change notification on the launch directory, closed below.
    let notification =
        unsafe { FindFirstChangeNotificationW(&HSTRING::from(tail.dir.as_os_str()), false, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE) }.ok();
    // A report that landed between `launch`'s last read and this registration is published now; later ones on the notification.
    let mut reported = tail.reported.clone();
    let now = fence.child_report();
    if now != reported {
        reported = now;
        changed();
    }
    loop {
        let handles: Vec<HANDLE> = std::iter::once(process).chain(notification).collect();
        // SAFETY: both handles stay open for the wait (the process handle for the fence's whole life).
        let woke = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        if woke == WAIT_OBJECT_0 {
            break;
        }
        if woke.0 != WAIT_OBJECT_0.0 + 1 {
            // The wait itself failed: only the process's end is left to observe.
            // SAFETY: the process handle is open.
            unsafe { WaitForSingleObject(process, INFINITE) };
            break;
        }
        let now = fence.child_report();
        if now != reported {
            reported = now;
            changed();
        }
        if let Some(notification) = notification {
            // SAFETY: the notification handle is open.
            let _ = unsafe { FindNextChangeNotification(notification) };
        }
    }
    if let Some(notification) = notification {
        // SAFETY: opened above, closed once.
        let _ = unsafe { FindCloseChangeNotification(notification) };
    }
    let answered = std::fs::read_to_string(tail.dir.join(RESPONSE_FILE))
        .ok()
        .is_some_and(|text| authenticated_body(&text, &tail.token, tail.worker, tail.id).is_ok_and(|body| body.get("worker_error").is_none()));
    fence.ended(answered);
    if tail.ledger.as_deref().is_none_or(super::ledger::adopt) {
        let _ = std::fs::remove_dir_all(&tail.dir);
    }
    changed();
}

fn launch_fenced(req: &Req, id: i64, token: String, dir: PathBuf, fence: &WorkerFence) -> (Result<Obj, String>, Option<Unconfirmed>) {
    let request = format!("{}\n", req.0).into_bytes();
    let request_sha256 = match sha256_hex(&request) {
        Ok(digest) => digest,
        Err(error) => return (Err(error), None),
    };
    let launch = Launch {
        dir: dir.clone(),
        token,
        request_sha256,
        marker: crate::config::host_input_marker(),
        // The worker records its own holds in a ledger of its own: its
        // supervisor replays only that one, never this host's live ledger.
        ledger: crate::config::inactive_ledger().map(|_| dir.join(WORKER_LEDGER_FILE)),
        parent: own_identity(),
    };
    if let Err(error) = std::fs::create_dir(&dir).and_then(|()| std::fs::write(dir.join(REQUEST_FILE), &request)) {
        return (Err(format!("privileged_worker_unavailable: request could not be staged: {error}")), None);
    }
    let (outcome, end) = run_worker(&launch, id, fence);
    if let WorkerEnd::Exited { answered } = end {
        fence.ended(answered);
    }
    if let WorkerEnd::StopUnconfirmed { worker } = end {
        let Launch { dir, token, ledger, .. } = launch;
        return (outcome, Some(Unconfirmed { dir, token, ledger, worker, id, reported: fence.child_report() }));
    }
    let adopted = launch.ledger.as_deref().is_none_or(super::ledger::adopt);
    if adopted {
        let _ = std::fs::remove_dir_all(&dir);
    }
    (outcome, None)
}

/// How a worker run ended, as observed (never read from an error's words).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WorkerEnd {
    /// No worker process was started.
    NotStarted,
    /// It did not acknowledge its cancellation: still live, observed through the fence until it ends (`watch_unconfirmed`).
    StopUnconfirmed { worker: Identity },
    /// Its exit was observed; `answered`: its authenticated response carried no worker failure.
    Exited { answered: bool },
}

/// Starts the worker, grants it (unless the fence closed meanwhile: then it stays pending until it reads the revoke file), and
/// waits for its exit holding nothing.
fn run_worker(launch: &Launch, id: i64, fence: &WorkerFence) -> (Result<Obj, String>, WorkerEnd) {
    let (process, worker) = match start(launch) {
        Ok(started) => started,
        Err(error) => return (Err(error), WorkerEnd::NotStarted),
    };
    let (process, _) = fence.adopt_and_grant(process);
    // An unconfirmed stop leaves the supervisor live: the fence keeps its handle and stays registered with the scope, which
    // observes its end there.
    let exit = match wait(process, &launch.dir.join(CANCEL_FILE), &launch.token) {
        Ok(exit) => exit,
        Err(error) => return (Err(error), WorkerEnd::StopUnconfirmed { worker }),
    };
    let text = std::fs::read_to_string(launch.dir.join(RESPONSE_FILE)).ok();
    let answered = text.as_deref().is_some_and(|text| authenticated_body(text, &launch.token, worker, id).is_ok_and(|body| body.get("worker_error").is_none()));
    let outcome = match text {
        Some(text) => read_response(&text, &launch.token, worker, id),
        None => Err(missing_response(exit)),
    };
    (outcome, WorkerEnd::Exited { answered })
}

/// Desktop-owned one-shot launch. The desktop owns the supplied ledger: this
/// path never adopts or deletes it. The receipt is sent only after waiting on
/// the exact process handle returned by ShellExecuteExW.
pub fn launch_pipe(message: Value, cancelled: Arc<Cancellation>) -> i32 {
    let mut stopped = true; // No child exists until start succeeds.
    let mut staged: Option<PathBuf> = None;
    let outcome = (|| -> Result<Value, String> {
        let (request, id, marker, ledger) = pipe_message(&message)?;
        let token = new_token()?;
        let dir = std::env::temp_dir().join(format!("mixdog-elevated-{token}"));
        let bytes = format!("{request}\n").into_bytes();
        let launch = Launch {
            dir: dir.clone(),
            token,
            request_sha256: sha256_hex(&bytes)?,
            marker: Some(marker),
            ledger: Some(PathBuf::from(ledger)),
            parent: own_identity(),
        };
        std::fs::create_dir(&dir).map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
        staged = Some(dir.clone());
        std::fs::write(dir.join(REQUEST_FILE), bytes).map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
        // The worker's admission word, created fresh before the launch; the cancellation closes it directly.
        let word: Arc<dyn crate::port::AdmissionWord> = Arc::new(crate::port::windows::shared::create(&launch.token)?);
        cancelled.fence(word)?;
        cancelled.arm(dir.join(CANCEL_FILE))?;
        if cancelled.requested() {
            return Err("privileged_worker_cancelled".into());
        }
        stopped = false;
        let (process, worker) = match start(&launch) {
            Ok(child) => child,
            Err(error) => {
                stopped = error.starts_with("privileged_worker_cancelled: UAC consent was declined");
                return Err(error);
            }
        };
        // A worker that finished launching after the cancellation is never granted: the word was closed first, and a late
        // grant never reopens it. The grant file only wakes the relay.
        if cancelled.grant() {
            let _ = std::fs::write(dir.join(GRANT_FILE), &launch.token);
        }
        if let Some(ticks) = dotnet_ticks(worker.created) {
            crate::elevated_launch::emit(json!({"kind":"identity", "pid":worker.pid, "startTicks":ticks.to_string()}));
        }
        let exit = wait_controlled(&process, &dir.join(CANCEL_FILE), &launch.token, &cancelled)?;
        // Supervisor exit alone is not a receipt that its input child stopped
        // and cleanup ran (it could have crashed). Require its authenticated
        // body before releasing the desktop's held job or ledger.
        let text = std::fs::read_to_string(dir.join(RESPONSE_FILE)).map_err(|_| missing_response(exit))?;
        let body = authenticated_body(&text, &launch.token, worker, id)?;
        stopped = true;
        if let Some(error) = body.get("worker_error").and_then(Value::as_str) {
            if error.contains("cleanup_unconfirmed") {
                stopped = false;
            }
            return Err(format!("privileged_worker_failed: {error}"));
        }
        Ok(body)
    })();
    cancelled.disarm();
    if stopped {
        if let Some(dir) = staged {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    let (receipt, code) = match outcome {
        Ok(response) => (json!({"kind":"result", "stopped":stopped, "response":response}), 0),
        Err(error) => (json!({"kind":"result", "stopped":stopped, "error":error}), 1),
    };
    crate::elevated_launch::emit(receipt);
    code
}

fn pipe_message(message: &Value) -> Result<(&Value, i64, i64, &str), String> {
    let request = message.get("request").filter(|value| value.is_object()).ok_or("privileged worker request is not an object")?;
    let id = request.get("id").and_then(Value::as_i64).ok_or(INCOMPLETE)?;
    let marker = message.get("inputMarker").and_then(Value::as_str).and_then(|value| value.parse::<i64>().ok()).ok_or(INCOMPLETE)?;
    let ledger = message.get("inactiveLedger").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or(INCOMPLETE)?;
    Ok((request, id, marker, ledger))
}

/// ShellExecuteExW with the `runas` verb on this executable; the process
/// handle and the identity of the worker it started.
fn start(launch: &Launch) -> Result<(Process, Identity), String> {
    let program = std::env::current_exe().map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
    let file = HSTRING::from(program.as_os_str());
    let parameters = HSTRING::from(launch.command_line());
    let verb = HSTRING::from("runas");
    let mut request = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: the request points at strings that outlive the call.
    if let Err(error) = unsafe { ShellExecuteExW(&mut request) } {
        return Err(if error.code() == ERROR_CANCELLED.to_hresult() {
            missing_response(1223)
        } else {
            format!("privileged_worker_launcher_failed: {}", error.message().trim())
        });
    }
    if request.hProcess.is_invalid() {
        return Err("privileged_worker_unavailable: elevated worker returned no handle".into());
    }
    let process = Process(request.hProcess);
    // SAFETY: a valid process handle; the creation time reads 0 when the
    // handle does not allow it.
    let identity = unsafe { Identity { pid: GetProcessId(process.0), created: creation_time(process.0) } };
    Ok((process, identity))
}

/// Waits for the worker to exit; at the deadline asks it to cancel through
/// the cancel file, and gives it a grace period before the stop is reported
/// unconfirmed. The exit code.
fn wait(process: &Process, cancel_file: &Path, token: &str) -> Result<u32, String> {
    wait_controlled(process, cancel_file, token, &Cancellation::default())
}

fn wait_controlled(process: &Process, cancel_file: &Path, token: &str, cancelled: &Cancellation) -> Result<u32, String> {
    let started = Instant::now();
    let mut cancelled_at: Option<Instant> = None;
    loop {
        // SAFETY: the handle is open with SYNCHRONIZE.
        if unsafe { WaitForSingleObject(process.0, POLL.as_millis() as u32) } == WAIT_OBJECT_0 {
            return Ok(exit_code(process.0));
        }
        match cancelled_at {
            None if started.elapsed() >= LAUNCHER_DEADLINE || cancelled.requested() => {
                let _ = std::fs::write(cancel_file, token);
                cancelled_at = Some(Instant::now());
            }
            Some(at) if at.elapsed() >= CANCEL_GRACE => {
                return Err("privileged_worker_cleanup_unconfirmed: elevated input did not acknowledge cancellation".into());
            }
            _ => {}
        }
    }
}

fn exit_code(process: HANDLE) -> u32 {
    let mut code = 1u32;
    // SAFETY: a valid out pointer; the worker has exited.
    let _ = unsafe { GetExitCodeProcess(process, &mut code) };
    code
}

fn stop_reason(now: Instant, deadline: Instant, cancel_requested: bool, parent_alive: bool) -> Option<&'static str> {
    (now >= deadline || cancel_requested || !parent_alive).then_some("privileged_worker_cancelled")
}

fn parent_alive(parent: Identity) -> bool {
    Process::open(parent.pid, (PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE).0).is_some_and(|process| {
        let running = unsafe { WaitForSingleObject(process.0, 0) } == WAIT_TIMEOUT;
        live_parent(parent, Identity { pid: parent.pid, created: creation_time(process.0) }, running)
    })
}

fn live_parent(expected: Identity, actual: Identity, running: bool) -> bool {
    running && expected.created > 0 && actual.created > 0 && same_identity(expected, actual)
}

pub fn worker(args: &[String], validate: fn(&Req) -> Result<(), String>) -> i32 {
    let launch = match Launch::parse(args) {
        Ok(launch) => launch,
        Err(error) => {
            eprintln!("mixdog-computer elevated worker: {error}");
            return 1;
        }
    };
    let me = own_identity();
    let refuse = |error: String| -> i32 {
        let body = json!({ "worker_error": error });
        let _ = std::fs::write(launch.dir.join(RESPONSE_FILE), response_text(&launch.token, me, &body));
        1
    };
    if let Some(marker) = launch.marker {
        std::env::set_var("MIXDOG_COMPUTER_INPUT_MARKER", marker.to_string());
    }
    if let Some(ledger) = &launch.ledger {
        std::env::set_var("MIXDOG_COMPUTER_INACTIVE_LEDGER", ledger);
    }
    let started = Instant::now();
    let mut deadline = started + WORKER_DEADLINE;
    if !parent_alive(launch.parent) || launch.dir.join(CANCEL_FILE).exists() {
        return refuse("privileged_worker_cancelled".into());
    }
    let bytes = match std::fs::read(launch.dir.join(REQUEST_FILE)) {
        Ok(bytes) => bytes,
        Err(error) => return refuse(format!("privileged worker request is unreadable: {error}")),
    };
    if sha256_hex(&bytes).ok().as_deref() != Some(launch.request_sha256.as_str()) {
        return refuse("privileged worker request authentication failed".into());
    }
    let line = String::from_utf8_lossy(&bytes).trim().to_string();
    let req = match serde_json::from_str::<Value>(&line) {
        Ok(value @ Value::Object(_)) => Req(value),
        _ => return refuse("privileged worker request is not an object".into()),
    };
    if let Some(expires) = req.int("authorization_expires_at") {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(i64::MAX);
        if now >= expires {
            return refuse("computer_policy_expired: authorization expired before elevated input".into());
        }
        deadline = deadline.min(started + Duration::from_millis((expires - now) as u64));
    }
    if let Err(error) = validate(&req) {
        return refuse(error);
    }
    let body = supervise_input(&line, &launch, deadline);
    let _ = std::fs::write(launch.dir.join(RESPONSE_FILE), response_text(&launch.token, me, &body));
    0
}

/// The elevated supervisor never dispatches input itself. On cancellation it
/// stops and waits for the input process BEFORE releasing its owned input.
fn supervise_input(line: &str, launch: &Launch, deadline: Instant) -> Value {
    use std::io::{Read, Write};
    // Non-inheritable handle; losing this supervisor kills its input child.
    let job = match input_job() {
        Ok(job) => job,
        Err(error) => return json!({"worker_error":error}),
    };
    let mut child = match spawn_contained(&job) {
        Ok(child) => child,
        Err(error) => return json!({"worker_error":error}),
    };
    let mut input = child.stdin.take().expect("piped input");
    let request = admission_request(line, &launch.token);
    // The request, then the control lines; the end of this pipe is the child's revocation too.
    let (control, controls) = std::sync::mpsc::channel::<&'static str>();
    let writer = std::thread::spawn(move || {
        input.write_all(&request)?;
        input.flush()?;
        for line in controls {
            // A child that exited reads no more: its pipe's end is all that is left to say.
            if input.write_all(format!("{line}\n").as_bytes()).and_then(|()| input.flush()).is_err() {
                break;
            }
        }
        Ok::<_, std::io::Error>(())
    });
    let output = child.stdout.take().expect("piped output");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take((crate::elevated_launch::MAX_REQUEST + 1) as u64).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    // The child's reports of its closure and cleanup, the latest kept for the launcher (never discarded).
    let reported = Arc::new(std::sync::Mutex::new(None::<String>));
    let errors = child.stderr.take().expect("piped acknowledgements");
    let report = reported.clone();
    let acknowledgements = std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(errors).lines() {
            if let Some(json) = line.ok().and_then(|line| line.strip_prefix(REVOKED_LINE).map(str::to_owned)) {
                *report.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(json);
            }
        }
    });
    let mut relay = Relay { dir: &launch.dir, token: &launch.token, granted: false, revoked: false, reported: None };
    let clock = Instant::now();
    // Each poll relays the launcher's grant and revocation first; the waits between hold nothing.
    let reason = match supervise_wait(
        &mut child,
        || {
            relay.relay(&control, reported.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone());
            stop_reason(Instant::now(), deadline, launch.dir.join(CANCEL_FILE).exists(), parent_alive(launch.parent)).map(str::to_owned)
        },
        || clock.elapsed(),
        || std::thread::sleep(POLL),
    ) {
        Ok(reason) => reason,
        Err(error) => return json!({"worker_error":error}),
    };
    // Exited: nothing of the child can submit; its last report (read to the end of its pipe) is relayed.
    let _ = acknowledgements.join();
    relay.relay(&control, reported.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone());
    drop(control);
    settle_input(reason, writer, reader)
}

/// The input child, assigned to `job` before anything is written to it: it
/// blocks reading its pipe before constructing any input host, so the
/// assignment is the containment barrier, including when the supervisor dies
/// between spawn and assign.
fn spawn_contained(job: &Process) -> Result<std::process::Child, String> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut child = std::env::current_exe()
        .and_then(|program| {
            Command::new(program)
                .arg("--elevated-input")
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
        })
        .map_err(|error| format!("privileged worker could not start: {error}"))?;
    if let Err(error) = unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) } {
        let _ = child.kill();
        return Err(if wait_input_stop(&mut child) {
            format!("privileged_worker_unavailable: input containment failed: {error}")
        } else {
            "privileged_worker_cleanup_unconfirmed: input containment failed".into()
        });
    }
    Ok(child)
}

/// The request line with the admission token the child maps its admission word by.
fn admission_request(line: &str, token: &str) -> Vec<u8> {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(mut request)) => {
            request.insert("admission_token".into(), Value::String(token.to_string()));
            format!("{}\n", Value::Object(request))
        }
        _ => format!("{line}\n"),
    }
    .into_bytes()
}

/// The child has exited. Cleanup still runs after a failed write, missing
/// response or cancellation, and failure cannot become success.
fn settle_input(
    reason: Option<String>,
    writer: std::thread::JoinHandle<std::io::Result<()>>,
    reader: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Value {
    let released = crate::platform::release_owned_input();
    let recovered = crate::platform::recover_inactive_ledger();
    if let Err(error) = released.and(recovered) {
        return json!({"worker_error":format!("privileged_worker_cleanup_unconfirmed: {error}")});
    }
    if let Some(reason) = reason {
        return json!({"worker_error":reason});
    }
    if !matches!(writer.join(), Ok(Ok(()))) {
        return json!({"worker_error":"privileged worker request could not be written"});
    }
    match reader.join() {
        Ok(Ok(bytes)) if bytes.len() <= crate::elevated_launch::MAX_REQUEST => {
            serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({"worker_error":"privileged worker host returned no structured response"}))
        }
        _ => json!({"worker_error":"privileged worker host returned no structured response"}),
    }
}

/// The supervisor's relay to its input child: it only wakes it (the grant once, the revocation once, the cancel file counting
/// as one) and hands the child's latest report to the launcher. Safety is the shared admission word's, not this relay's.
struct Relay<'a> {
    dir: &'a Path,
    token: &'a str,
    granted: bool,
    revoked: bool,
    reported: Option<String>,
}

impl Relay<'_> {
    fn signed(&self, name: &str) -> bool {
        std::fs::read_to_string(self.dir.join(name)).is_ok_and(|text| text == self.token)
    }

    /// One poll: `report` is the child's latest report, if any.
    fn relay(&mut self, control: &std::sync::mpsc::Sender<&'static str>, report: Option<String>) {
        if !self.revoked && (self.signed(REVOKE_FILE) || self.dir.join(CANCEL_FILE).exists()) {
            self.revoked = true;
            let _ = control.send(REVOKE_LINE);
        } else if !self.revoked && !self.granted && self.signed(GRANT_FILE) {
            self.granted = true;
            let _ = control.send(GRANT_LINE);
        }
        if let Some(report) = report.filter(|report| self.reported.as_ref() != Some(report)) {
            let _ = std::fs::write(self.dir.join(CLOSED_FILE), format!("{}\n{report}", self.token));
            self.reported = Some(report);
        }
    }
}

trait InputControl {
    fn exited(&mut self) -> Result<bool, String>;
    fn stop(&mut self);
}
impl InputControl for std::process::Child {
    fn exited(&mut self) -> Result<bool, String> {
        self.try_wait().map(|status| status.is_some()).map_err(|error| error.to_string())
    }
    fn stop(&mut self) {
        let _ = self.kill();
    }
}

/// Testable process supervision: a stop request is never a stop receipt.
fn supervise_wait(
    child: &mut impl InputControl,
    mut cancelled: impl FnMut() -> Option<String>,
    mut elapsed: impl FnMut() -> Duration,
    mut pause: impl FnMut(),
) -> Result<Option<String>, String> {
    let mut reason = None;
    let mut stopping = None;
    loop {
        match child.exited() {
            Ok(true) => return Ok(reason),
            Err(error) => {
                reason = Some(format!("privileged_worker_cleanup_unconfirmed: {error}"));
                child.stop();
                stopping.get_or_insert_with(&mut elapsed);
            }
            Ok(false) => {}
        }
        if stopping.is_none() {
            if let Some(why) = cancelled() {
                reason = Some(why);
                child.stop();
                stopping = Some(elapsed());
            }
        }
        if stopping.is_some_and(|at| elapsed().saturating_sub(at) >= Duration::from_secs(5)) {
            return Err("privileged_worker_cleanup_unconfirmed".into());
        }
        pause();
    }
}

fn input_job() -> Result<Process, String> {
    // Process is the local CloseHandle RAII wrapper; it also owns job handles.
    let job = Process(unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|error| format!("privileged_worker_unavailable: {error}"))?);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) }
        .map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
    Ok(job)
}

fn wait_input_stop(child: &mut std::process::Child) -> bool {
    let started = Instant::now();
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if started.elapsed() >= Duration::from_secs(5) {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER: Identity = Identity { pid: 4242, created: 133_750_000_000_000_000 };
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEF_-0123456789";

    struct FakeInput {
        polls: usize,
        stopped: bool,
        acknowledges: bool,
    }
    impl InputControl for FakeInput {
        fn exited(&mut self) -> Result<bool, String> {
            self.polls += 1;
            Ok(self.stopped && self.acknowledges && self.polls >= 3)
        }
        fn stop(&mut self) {
            self.stopped = true;
        }
    }

    #[test]
    fn cancellation_waits_for_actual_child_exit_before_allowing_cleanup() {
        let mut child = FakeInput { polls: 0, stopped: false, acknowledges: true };
        let answer = supervise_wait(&mut child, || Some("privileged_worker_cancelled".into()), || Duration::ZERO, || {});
        assert_eq!(answer.unwrap(), Some("privileged_worker_cancelled".into()));
        assert!(child.stopped && child.polls >= 3);
    }

    #[test]
    fn an_unacknowledged_kill_cannot_become_a_stop_receipt() {
        let mut child = FakeInput { polls: 0, stopped: false, acknowledges: false };
        let clock = std::cell::Cell::new(0);
        let answer =
            supervise_wait(&mut child, || Some("privileged_worker_cancelled".into()), || Duration::from_secs(clock.get()), || clock.set(clock.get() + 1));
        assert_eq!(answer.unwrap_err(), "privileged_worker_cleanup_unconfirmed");
        assert!(child.stopped);
    }

    #[test]
    fn the_input_request_carries_the_launch_token_and_a_non_object_line_passes_through() {
        let object = String::from_utf8(admission_request(r#"{"id":5}"#, TOKEN)).unwrap();
        let parsed: Value = serde_json::from_str(object.trim()).unwrap();
        assert_eq!((parsed["id"].as_i64(), parsed["admission_token"].as_str()), (Some(5), Some(TOKEN)));
        assert!(object.ends_with('\n'));
        assert_eq!(admission_request("not json", TOKEN), b"not json\n");
    }

    #[test]
    fn a_pipe_message_yields_its_request_marker_and_ledger_or_is_refused() {
        let message = json!({"request": {"id": 9}, "inputMarker": "77", "inactiveLedger": "C:\\ledger.txt"});
        let (request, id, marker, ledger) = pipe_message(&message).unwrap();
        assert_eq!((request["id"].as_i64(), id, marker, ledger), (Some(9), 9, 77, "C:\\ledger.txt"));
        assert_eq!(pipe_message(&json!({"request": 3})).unwrap_err(), "privileged worker request is not an object");
        assert_eq!(pipe_message(&json!({"request": {"id": 9}, "inputMarker": "x", "inactiveLedger": "l"})).unwrap_err(), INCOMPLETE);
        assert_eq!(pipe_message(&json!({"request": {"id": 9}, "inputMarker": "7", "inactiveLedger": ""})).unwrap_err(), INCOMPLETE);
    }

    fn sample_launch() -> Launch {
        Launch {
            dir: PathBuf::from(r"C:\Temp\mixdog-elevated-x"),
            token: TOKEN.into(),
            request_sha256: "00ff".repeat(16),
            marker: Some(77),
            ledger: Some(PathBuf::from(r"C:\Users\a b\ledger.txt")),
            parent: Identity { pid: 100, created: 5 },
        }
    }

    /// The program's split of a command line: quotes group, then drop.
    fn split(line: &str) -> Vec<String> {
        let mut parts = Vec::new();
        let (mut current, mut quoted) = (String::new(), false);
        for character in line.chars() {
            match character {
                '"' => quoted = !quoted,
                ' ' if !quoted => parts.push(std::mem::take(&mut current)),
                other => current.push(other),
            }
        }
        parts.push(current);
        parts
    }

    fn envelope(id: i64) -> Value {
        json!({ "id": id, "ok": true, "result": { "text": "typed" } })
    }

    #[test]
    fn sha256_matches_the_known_digest() {
        assert_eq!(sha256_hex(b"abc").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn process_time_conversion_preserves_ticks_and_refuses_unknown_identity() {
        assert_eq!(dotnet_ticks(0), None);
        assert_eq!(dotnet_ticks(-1), None);
        assert_eq!(dotnet_ticks(1), Some(504_911_232_000_000_001));
        assert_eq!(dotnet_ticks(133_750_000_000_000_000), Some(638_661_232_000_000_000));
        assert_eq!(dotnet_ticks(i64::MAX), None);
    }

    #[test]
    fn a_retained_handle_to_an_exited_parent_is_not_a_live_parent() {
        assert!(live_parent(WORKER, WORKER, true));
        assert!(!live_parent(WORKER, WORKER, false));
        assert!(!live_parent(WORKER, Identity { created: WORKER.created + 1, ..WORKER }, true));
        assert!(!live_parent(WORKER, Identity { created: 0, ..WORKER }, true));
    }

    #[test]
    fn authenticated_worker_error_and_failure_envelopes_are_not_fabricated_successes() {
        let cleanup = json!({"worker_error":"privileged_worker_cleanup_unconfirmed: input held"});
        assert_eq!(authenticated_body(&response_text(TOKEN, WORKER, &cleanup), TOKEN, WORKER, 4).unwrap(), cleanup);
        let refusal = json!({"id":4,"ok":false,"error":"computer_policy_expired"});
        assert_eq!(authenticated_body(&response_text(TOKEN, WORKER, &refusal), TOKEN, WORKER, 4).unwrap(), refusal);
        assert!(authenticated_body(&response_text(TOKEN, WORKER, &refusal), TOKEN, WORKER, 5).is_err());
    }

    #[test]
    fn a_new_token_has_the_accepted_shape_and_is_never_repeated() {
        let (first, second) = (new_token().unwrap(), new_token().unwrap());
        assert!(token_valid(&first) && first.len() == 43);
        assert_ne!(first, second);
    }

    #[test]
    fn a_token_must_be_long_and_url_safe() {
        assert!(token_valid(TOKEN));
        assert!(!token_valid("short"));
        assert!(!token_valid(&format!("{TOKEN}+")));
        assert!(!token_valid(&format!("{TOKEN} ")));
        assert!(!token_valid(""));
    }

    #[test]
    fn the_command_line_round_trips_through_the_parser() {
        let launch = sample_launch();
        // The first part is the mode, which main.rs has already consumed.
        let args = split(&launch.command_line());
        assert_eq!(args[0], "--elevated-request");
        assert_eq!(Launch::parse(&args[1..]).unwrap(), launch);
    }

    #[test]
    fn a_launch_without_its_token_hash_or_parent_is_refused() {
        let args = split(&sample_launch().command_line())[1..].to_vec();
        for name in ["--token", "--sha256", "--parent"] {
            let at = args.iter().position(|arg| arg == name).unwrap();
            let mut broken = args.clone();
            broken.drain(at..at + 2);
            assert_eq!(Launch::parse(&broken).unwrap_err(), INCOMPLETE);
        }
        let mut malformed = args.clone();
        let at = malformed.iter().position(|arg| arg == "--token").unwrap();
        malformed[at + 1] = "short".into();
        assert_eq!(Launch::parse(&malformed).unwrap_err(), "privileged worker token is malformed");
    }

    #[test]
    fn identity_needs_the_same_process_and_a_creation_time_that_agrees() {
        assert!(same_identity(WORKER, WORKER));
        assert!(!same_identity(WORKER, Identity { pid: 1, ..WORKER }));
        assert!(!same_identity(WORKER, Identity { created: WORKER.created + 1, ..WORKER }));
        // An unreadable creation time leaves the id to decide.
        assert!(same_identity(Identity { created: 0, ..WORKER }, WORKER));
    }

    #[test]
    fn a_response_from_the_started_worker_with_its_token_is_accepted() {
        let text = response_text(TOKEN, WORKER, &envelope(9));
        let result = read_response(&text, TOKEN, WORKER, 9).unwrap();
        assert_eq!(result.get("text"), Some(&json!("typed")));
    }

    #[test]
    fn a_response_is_rejected_for_a_wrong_token_identity_or_id() {
        let text = response_text(TOKEN, WORKER, &envelope(9));
        assert_eq!(read_response(&text, "another-token", WORKER, 9).unwrap_err(), "privileged_worker_rejected: response authentication failed");
        let other = Identity { pid: 7, ..WORKER };
        assert_eq!(read_response(&text, TOKEN, other, 9).unwrap_err(), "privileged_worker_rejected: response identity mismatch");
        assert_eq!(read_response(&text, TOKEN, WORKER, 10).unwrap_err(), "privileged_worker_rejected: response id mismatch");
        assert_eq!(read_response(TOKEN, TOKEN, WORKER, 9).unwrap_err(), "privileged_worker_rejected: response identity mismatch");
    }

    #[test]
    fn a_workers_refusal_and_the_hosts_own_error_keep_their_text() {
        let refusal = response_text(TOKEN, WORKER, &json!({ "worker_error": "no way" }));
        assert_eq!(read_response(&refusal, TOKEN, WORKER, 9).unwrap_err(), "privileged_worker_failed: no way");
        let failed = response_text(TOKEN, WORKER, &json!({ "id": 9, "ok": false, "error": "window_id is stale" }));
        assert_eq!(read_response(&failed, TOKEN, WORKER, 9).unwrap_err(), "window_id is stale");
    }

    #[test]
    fn a_missing_response_is_classified_by_the_exit_code() {
        assert_eq!(missing_response(1223), "privileged_worker_cancelled: UAC consent was declined");
        assert_eq!(missing_response(0), "privileged_worker_unavailable: elevated worker returned no response");
        assert_eq!(missing_response(3), "privileged_worker_launcher_failed: elevated worker exited with code 3");
    }

    #[test]
    fn a_worker_stops_on_the_deadline_a_cancel_file_or_a_lost_parent() {
        let now = Instant::now();
        let later = now + Duration::from_secs(5);
        assert_eq!(stop_reason(now, later, false, true), None);
        assert!(stop_reason(later, later, false, true).is_some());
        assert!(stop_reason(now, later, true, true).is_some());
        assert!(stop_reason(now, later, false, false).is_some());
    }

    fn fence_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mixdog-fence-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A process this test controls: it runs until its standard input closes.
    fn controlled_child() -> (std::process::Child, Process) {
        let child = std::process::Command::new("findstr.exe").arg("x").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).spawn().unwrap();
        let process = Process::open(child.id(), (PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE).0).unwrap();
        (child, process)
    }

    /// A token of its own for each test: the admission section's name is made from it.
    fn token(name: &str) -> String {
        format!("{TOKEN}-{name}-{}", std::process::id())
    }

    /// Off during the UAC prompt: the revocation closes the worker's word at once, and the worker that finishes launching
    /// afterwards is never granted (a late grant stays closed); its child maps the closed word and admits nothing.
    #[test]
    fn a_worker_that_finishes_launching_after_off_is_never_granted() {
        let dir = fence_dir("late");
        let token = token("late");
        let scope = crate::port::Scope::open(1);
        let fence = Arc::new(WorkerFence::new(dir.clone(), token.clone()).unwrap());
        assert!(scope.fence(fence.clone()));
        assert_eq!(scope.revoke().unfinished, 0, "nothing granted, nothing admitted");
        let (mut child, process) = controlled_child();
        assert!(!fence.adopt_and_grant(process).1, "the late start gets no grant");
        assert!(!dir.join(GRANT_FILE).exists());
        let worker = crate::port::Scope::shared(1, Box::new(crate::port::windows::shared::open(&token).unwrap()));
        assert!(!worker.grant());
        assert!(worker.check().is_err());
        drop(child.stdin.take());
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The supervisor suspended (no relay runs): the parent's closure alone closes the child's admission, the snapshot counts
    /// the child's call admitted just before (that one may still run), and its continuation cannot.
    #[test]
    fn the_parent_closes_the_child_without_its_supervisor() {
        let dir = fence_dir("suspended");
        let token = token("suspended");
        let scope = crate::port::Scope::open(1);
        let fence = Arc::new(WorkerFence::new(dir.clone(), token.clone()).unwrap());
        assert!(scope.fence(fence.clone()));
        let (mut child, process) = controlled_child();
        assert!(fence.adopt_and_grant(process).1);
        let worker = crate::port::Scope::shared(1, Box::new(crate::port::windows::shared::open(&token).unwrap()));
        let fake = crate::port::fake::FakePort::new(&worker);
        let pause = crate::port::fake::Pause::new();
        *fake.driver.inside.lock().unwrap() = Some(pause.clone());
        std::thread::scope(|threads| {
            // Admitted, then paused before it enters the API.
            let call = threads.spawn(|| fake.act_handed_over("click"));
            pause.reached.wait();
            assert_eq!(scope.revoke().unfinished, 1, "the child's admitted call is in the parent's snapshot");
            pause.resume.wait();
            assert_eq!(call.join().unwrap(), Ok(()), "that one call may run");
        });
        assert_eq!(fake.act("after"), Err(crate::port::REVOKED.to_string()), "its continuation cannot");
        assert_eq!(fake.driver.log(), ["click"]);
        assert_eq!(crate::port::Endpoint::cleanup(&*fence), crate::port::Cleanup::Pending);
        drop(child.stdin.take());
        let _ = child.wait();
        assert_eq!(crate::port::Endpoint::cleanup(&*fence), crate::port::Cleanup::Unconfirmed, "ended without a report");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The relay only wakes: the grant line once, the revoke line once (the cancel file counts), and the child's latest report
    /// handed to the launcher, which reads it as the worker's cleanup.
    #[test]
    fn the_relay_wakes_the_child_and_hands_its_report_on() {
        let dir = fence_dir("relay");
        let token = token("relay");
        let fence = WorkerFence::new(dir.clone(), token.clone()).unwrap();
        let (mut child, process) = controlled_child();
        assert!(fence.adopt_and_grant(process).1);
        let (control, controls) = std::sync::mpsc::channel();
        let mut relay = Relay { dir: &dir, token: &token, granted: false, revoked: false, reported: None };
        relay.relay(&control, None);
        assert_eq!(controls.try_iter().collect::<Vec<_>>(), [GRANT_LINE]);
        crate::port::Endpoint::close(&fence);
        relay.relay(&control, Some(r#"{"cleanup":"pending"}"#.into()));
        assert_eq!(controls.try_iter().collect::<Vec<_>>(), [REVOKE_LINE]);
        assert_eq!(crate::port::Endpoint::cleanup(&fence), crate::port::Cleanup::Pending);
        relay.relay(&control, Some(r#"{"cleanup":"complete"}"#.into()));
        assert_eq!(crate::port::Endpoint::cleanup(&fence), crate::port::Cleanup::Complete);
        drop(child.stdin.take());
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A supervisor whose stop went unconfirmed stays observed after `launch` returned: a later child report is published as the
    /// scope's updated report, and so is its exit (no authenticated answer: unconfirmed); its directory is then removed.
    #[test]
    fn an_unconfirmed_stop_is_observed_until_its_end_and_each_change_is_published() {
        use crate::port::Cleanup;
        let dir = fence_dir("unconfirmed");
        let token = token("unconfirmed");
        let scope = crate::port::Scope::open(1);
        let fence = Arc::new(WorkerFence::new(dir.clone(), token.clone()).unwrap());
        assert!(scope.fence(fence.clone()));
        let (mut child, process) = controlled_child();
        assert!(fence.adopt_and_grant(process).1);
        scope.revoke();
        assert!(scope.release_held(), "this side holds nothing; the worker's own holds are its own");
        let (published, reports) = std::sync::mpsc::channel();
        scope.on_report(move |report| {
            let _ = published.send(report.cleanup);
        });
        assert_eq!(scope.report().cleanup, Cleanup::Pending, "the supervisor is live and said nothing");
        let tail =
            Unconfirmed { dir: dir.clone(), token: token.clone(), ledger: None, worker: Identity { pid: child.id(), created: 0 }, id: 1, reported: None };
        let watcher = {
            let (fence, scope) = (fence.clone(), scope.clone());
            std::thread::spawn(move || watch_unconfirmed(&fence, &tail, || scope.notify()))
        };
        let (control, _controls) = std::sync::mpsc::channel();
        let mut relay = Relay { dir: &dir, token: &token, granted: true, revoked: true, reported: None };
        relay.relay(&control, Some(r#"{"cleanup":"complete"}"#.into()));
        assert_eq!(reports.recv().unwrap(), Cleanup::Complete, "the later child report is published");
        drop(child.stdin.take());
        let _ = child.wait();
        let last = reports.iter().find(|cleanup| *cleanup == Cleanup::Unconfirmed);
        assert_eq!(last, Some(Cleanup::Unconfirmed), "its exit, without an authenticated answer, is published as unconfirmed");
        watcher.join().unwrap();
        assert!(!dir.exists(), "its directory is removed once its end is settled");
        assert_eq!(scope.report().cleanup, Cleanup::Unconfirmed);
    }

    /// The fence's cache at a worker's end holds Complete only on positive evidence. A worker that answered and whose child
    /// reported its cleanup complete, its directory removed as the launcher does, then Off: complete. One that exited without
    /// that report, or whose answer was a worker failure: unconfirmed, also after its directory is gone.
    #[test]
    fn a_worker_end_is_complete_only_on_a_child_report_and_an_answer() {
        let ended = |name: &str, report: Option<&str>, answered: bool| {
            let dir = fence_dir(name);
            let token = token(name);
            let scope = crate::port::Scope::open(1);
            let fence = Arc::new(WorkerFence::new(dir.clone(), token.clone()).unwrap());
            assert!(scope.fence(fence.clone()));
            let (mut child, process) = controlled_child();
            assert!(fence.adopt_and_grant(process).1);
            if let Some(report) = report {
                let (control, _controls) = std::sync::mpsc::channel();
                let mut relay = Relay { dir: &dir, token: &token, granted: true, revoked: true, reported: None };
                relay.relay(&control, Some(report.into()));
            }
            drop(child.stdin.take());
            let _ = child.wait();
            fence.ended(answered);
            std::fs::remove_dir_all(&dir).unwrap();
            scope.revoke();
            assert!(scope.release_held());
            scope.report().cleanup
        };
        use crate::port::Cleanup;
        assert_eq!(ended("clean", Some(r#"{"cleanup":"complete"}"#), true), Cleanup::Complete);
        assert_eq!(ended("silent", None, true), Cleanup::Unconfirmed, "an exit without the child's report");
        assert_eq!(ended("failed", Some(r#"{"cleanup":"complete"}"#), false), Cleanup::Unconfirmed, "a worker failure");
        assert_eq!(ended("pending", Some(r#"{"cleanup":"pending"}"#), true), Cleanup::Unconfirmed, "ended while still pending");
    }
}
