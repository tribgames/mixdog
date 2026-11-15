//! Foreground input to a window above this process's integrity, run by a
//! one-action worker started through UAC: this same executable relaunched
//! with `--elevated-request` (elevated-launcher.ts runElevatedRequest,
//! elevated-requests.ts; the worker side is the bootstrap of
//! elevated-program.ts).
//!
//! The launcher stages the request in a fresh directory and starts the worker
//! with the `runas` verb. The environment does not cross UAC, so everything
//! the worker needs travels on its command line: the token, the request's
//! SHA-256, the input marker, the ledger path and this process's identity.
//! The response file leads with the token and the worker's own identity, so
//! it is accepted only from the process that was started.

use super::native::Process;
use super::process::creation_time;
use crate::protocol::{Obj, Req};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use std::sync::Arc;
use crate::elevated_launch::Cancellation;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Security::Cryptography::{
    BCryptGenRandom, BCryptHash, BCRYPT_SHA256_ALG_HANDLE, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, GetProcessId,
    WaitForSingleObject, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
use windows::Win32::System::JobObjects::{CreateJobObjectW, SetInformationJobObject,
    AssignProcessToJobObject, JobObjectExtendedLimitInformation,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

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

/// The worker's answer to a foreground request; always Some on Windows.
pub fn run(req: &Req) -> Option<Result<Obj, String>> {
    Some(launch(req))
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
    token.len() >= 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Process identity: id and creation FILETIME.
#[derive(Clone, Copy, Debug, PartialEq)]
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
    if pid == 0 { return Err("process identity query requires a positive PID".into()); }
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
    dotnet_ticks(creation_time(process.0)).map(Some)
        .ok_or_else(|| "process identity query failed: creation time is unavailable".into())
}

/// Whether a process's identity is the one expected. A creation time that
/// could not be read (0 on either side) leaves the id alone to decide.
fn same_identity(expected: Identity, actual: Identity) -> bool {
    expected.pid == actual.pid
        && (expected.created == 0 || actual.created == 0 || expected.created == actual.created)
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
    Err(body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("privileged_worker_failed: structured response is missing")
        .to_string())
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

fn launch(req: &Req) -> Result<Obj, String> {
    let id = req.int("id").unwrap_or(0);
    let token = new_token()?;
    let dir = std::env::temp_dir().join(format!("mixdog-elevated-{token}"));
    let request = format!("{}\n", req.0).into_bytes();
    let launch = Launch {
        dir: dir.clone(),
        token,
        request_sha256: sha256_hex(&request)?,
        marker: crate::config::host_input_marker(),
        // The worker records its own holds in a ledger of its own: its
        // supervisor replays only that one, never this host's live ledger.
        ledger: crate::config::inactive_ledger().map(|_| dir.join(WORKER_LEDGER_FILE)),
        parent: own_identity(),
    };
    std::fs::create_dir(&dir)
        .and_then(|()| std::fs::write(dir.join(REQUEST_FILE), &request))
        .map_err(|error| format!("privileged_worker_unavailable: request could not be staged: {error}"))?;
    let outcome = run_worker(&launch, id);
    // A worker that never confirmed its stop keeps the cancel file it may
    // still read. One that exited leaves its ledger to this host: what it
    // could not clear is handed to this host's own ledger first.
    if !matches!(&outcome, Err(error) if error.starts_with("privileged_worker_cleanup_unconfirmed")) {
        let adopted = launch.ledger.as_deref().is_none_or(super::ledger::adopt);
        if adopted {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    outcome
}

fn run_worker(launch: &Launch, id: i64) -> Result<Obj, String> {
    let (process, worker) = start(launch)?;
    let exit = wait(&process, &launch.dir.join(CANCEL_FILE), &launch.token)?;
    match std::fs::read_to_string(launch.dir.join(RESPONSE_FILE)) {
        Ok(text) => read_response(&text, &launch.token, worker, id),
        Err(_) => Err(missing_response(exit)),
    }
}

/// Desktop-owned one-shot launch. The desktop owns the supplied ledger: this
/// path never adopts or deletes it. The receipt is sent only after waiting on
/// the exact process handle returned by ShellExecuteExW.
pub fn launch_pipe(message: Value, cancelled: Arc<Cancellation>) -> i32 {
    let mut stopped = true; // No child exists until start succeeds.
    let mut staged: Option<PathBuf> = None;
    let outcome = (|| -> Result<Value, String> {
        let request = message.get("request").filter(|value| value.is_object())
            .ok_or("privileged worker request is not an object")?;
        let id = request.get("id").and_then(Value::as_i64).ok_or(INCOMPLETE)?;
        let marker = message.get("inputMarker").and_then(Value::as_str)
            .and_then(|value| value.parse::<i64>().ok()).ok_or(INCOMPLETE)?;
        let ledger = message.get("inactiveLedger").and_then(Value::as_str)
            .filter(|value| !value.is_empty()).ok_or(INCOMPLETE)?;
        let token = new_token()?;
        let dir = std::env::temp_dir().join(format!("mixdog-elevated-{token}"));
        let bytes = format!("{request}\n").into_bytes();
        let launch = Launch { dir: dir.clone(), token, request_sha256: sha256_hex(&bytes)?,
            marker: Some(marker), ledger: Some(PathBuf::from(ledger)), parent: own_identity() };
        std::fs::create_dir(&dir).map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
        staged = Some(dir.clone());
        std::fs::write(dir.join(REQUEST_FILE), bytes).map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
        cancelled.arm(dir.join(CANCEL_FILE))?;
        if cancelled.requested() { return Err("privileged_worker_cancelled".into()); }
        stopped = false;
        let (process, worker) = match start(&launch) {
            Ok(child) => child,
            Err(error) => {
                stopped = error.starts_with("privileged_worker_cancelled: UAC consent was declined");
                return Err(error);
            }
        };
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
            if error.contains("cleanup_unconfirmed") { stopped = false; }
            return Err(format!("privileged_worker_failed: {error}"));
        }
        Ok(body)
    })();
    cancelled.disarm();
    if stopped {
        if let Some(dir) = staged { let _ = std::fs::remove_dir_all(dir); }
    }
    let (receipt, code) = match outcome {
        Ok(response) => (json!({"kind":"result", "stopped":stopped, "response":response}), 0),
        Err(error) => (json!({"kind":"result", "stopped":stopped, "error":error}), 1),
    };
    crate::elevated_launch::emit(receipt);
    code
}

/// ShellExecuteExW with the `runas` verb on this executable; the process
/// handle and the identity of the worker it started.
fn start(launch: &Launch) -> Result<(Process, Identity), String> {
    let program = std::env::current_exe()
        .map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
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
                return Err(
                    "privileged_worker_cleanup_unconfirmed: elevated input did not acknowledge cancellation".into(),
                );
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

// --- worker -----------------------------------------------------------------

/// Why a running worker must stop (Test-Cancelled).
fn stop_reason(
    now: Instant,
    deadline: Instant,
    cancel_requested: bool,
    parent_alive: bool,
) -> Option<&'static str> {
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

/// The elevated worker: authenticates its launch and request, vets the
/// request with `validate`, serves the one action with `serve` while a
/// supervisor watches for cancellation, and writes the response file.
/// Returns the process exit code.
pub fn worker(
    args: &[String],
    validate: fn(&Req) -> Result<(), String>,
    _serve: fn(&str) -> Value,
) -> i32 {
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or(i64::MAX);
        if now >= expires {
            return refuse("computer_policy_expired: authorization expired before elevated input".into());
        }
        deadline = deadline.min(started + Duration::from_millis((expires - now) as u64));
    }
    if let Err(error) = validate(&req) {
        return refuse(error);
    }
    let body = supervise_input(&line, &launch, deadline);
    let _ = std::fs::write(
        launch.dir.join(RESPONSE_FILE),
        response_text(&launch.token, me, &body),
    );
    0
}

/// The elevated supervisor never dispatches input itself. On cancellation it
/// stops and waits for the input process BEFORE releasing its owned input.
fn supervise_input(line: &str, launch: &Launch, deadline: Instant) -> Value {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::os::windows::process::CommandExt;
    use std::os::windows::io::AsRawHandle;
    // Non-inheritable handle; losing this supervisor kills its input child.
    let job = match input_job() {
        Ok(job) => job,
        Err(error) => return json!({"worker_error":error}),
    };
    let mut child = match std::env::current_exe().and_then(|program|
        Command::new(program).arg("--elevated-input")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()) {
        Ok(child) => child,
        Err(error) => return json!({"worker_error":format!("privileged worker could not start: {error}")}),
    };
    // The child blocks reading its pipe before constructing any input host.
    // Nothing is written until assignment succeeds: this is the containment
    // barrier, including when the supervisor dies between spawn and assign.
    if let Err(error) = unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) } {
        let _ = child.kill();
        let stopped = wait_input_stop(&mut child);
        return json!({"worker_error":if stopped {
            format!("privileged_worker_unavailable: input containment failed: {error}")
        } else { "privileged_worker_cleanup_unconfirmed: input containment failed".into() }});
    }
    let mut input = child.stdin.take().expect("piped input");
    let request = format!("{line}\n").into_bytes();
    let writer = std::thread::spawn(move || input.write_all(&request));
    let output = child.stdout.take().expect("piped output");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take((crate::elevated_launch::MAX_REQUEST + 1) as u64).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    let clock = Instant::now();
    let reason = match supervise_wait(&mut child,
        || stop_reason(Instant::now(), deadline, launch.dir.join(CANCEL_FILE).exists(), parent_alive(launch.parent)).map(str::to_owned),
        || clock.elapsed(), || std::thread::sleep(POLL)) {
        Ok(reason) => reason,
        Err(error) => return json!({"worker_error":error}),
    };
    // The process handle proved exit. Cleanup still runs after a failed write,
    // missing response or cancellation, and failure cannot become success.
    let released = crate::platform::release_owned_input();
    let recovered = crate::platform::recover_inactive_ledger();
    if let Err(error) = released.and(recovered) {
        return json!({"worker_error":format!("privileged_worker_cleanup_unconfirmed: {error}")});
    }
    if let Some(reason) = reason { return json!({"worker_error":reason}); }
    if !matches!(writer.join(), Ok(Ok(()))) {
        return json!({"worker_error":"privileged worker request could not be written"});
    }
    match reader.join() {
        Ok(Ok(bytes)) if bytes.len() <= crate::elevated_launch::MAX_REQUEST =>
            serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_|
                json!({"worker_error":"privileged worker host returned no structured response"})),
        _ => json!({"worker_error":"privileged worker host returned no structured response"}),
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
    fn stop(&mut self) { let _ = self.kill(); }
}

/// Testable process supervision: a stop request is never a stop receipt.
fn supervise_wait(child: &mut impl InputControl, mut cancelled: impl FnMut() -> Option<String>,
    mut elapsed: impl FnMut() -> Duration, mut pause: impl FnMut()) -> Result<Option<String>, String> {
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
    let job = Process(unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| format!("privileged_worker_unavailable: {error}"))?);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation,
        &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) }
        .map_err(|error| format!("privileged_worker_unavailable: {error}"))?;
    Ok(job)
}

fn wait_input_stop(child: &mut std::process::Child) -> bool {
    let started = Instant::now();
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) { return true; }
        if started.elapsed() >= Duration::from_secs(5) { return false; }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER: Identity = Identity { pid: 4242, created: 133_750_000_000_000_000 };
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEF_-0123456789";

    struct FakeInput { polls: usize, stopped: bool, acknowledges: bool }
    impl InputControl for FakeInput {
        fn exited(&mut self) -> Result<bool, String> {
            self.polls += 1;
            Ok(self.stopped && self.acknowledges && self.polls >= 3)
        }
        fn stop(&mut self) { self.stopped = true; }
    }

    #[test]
    fn cancellation_waits_for_actual_child_exit_before_allowing_cleanup() {
        let mut child = FakeInput { polls: 0, stopped: false, acknowledges: true };
        let answer = supervise_wait(&mut child, || Some("privileged_worker_cancelled".into()),
            || Duration::ZERO, || {});
        assert_eq!(answer.unwrap(), Some("privileged_worker_cancelled".into()));
        assert!(child.stopped && child.polls >= 3);
    }

    #[test]
    fn an_unacknowledged_kill_cannot_become_a_stop_receipt() {
        let mut child = FakeInput { polls: 0, stopped: false, acknowledges: false };
        let clock = std::cell::Cell::new(0);
        let answer = supervise_wait(&mut child, || Some("privileged_worker_cancelled".into()),
            || Duration::from_secs(clock.get()), || clock.set(clock.get() + 1));
        assert_eq!(answer.unwrap_err(), "privileged_worker_cleanup_unconfirmed");
        assert!(child.stopped);
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
        assert_eq!(
            sha256_hex(b"abc").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
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
        assert_eq!(
            read_response(&text, "another-token", WORKER, 9).unwrap_err(),
            "privileged_worker_rejected: response authentication failed"
        );
        let other = Identity { pid: 7, ..WORKER };
        assert_eq!(
            read_response(&text, TOKEN, other, 9).unwrap_err(),
            "privileged_worker_rejected: response identity mismatch"
        );
        assert_eq!(
            read_response(&text, TOKEN, WORKER, 10).unwrap_err(),
            "privileged_worker_rejected: response id mismatch"
        );
        assert_eq!(
            read_response(TOKEN, TOKEN, WORKER, 9).unwrap_err(),
            "privileged_worker_rejected: response identity mismatch"
        );
    }

    #[test]
    fn a_workers_refusal_and_the_hosts_own_error_keep_their_text() {
        let refusal = response_text(TOKEN, WORKER, &json!({ "worker_error": "no way" }));
        assert_eq!(
            read_response(&refusal, TOKEN, WORKER, 9).unwrap_err(),
            "privileged_worker_failed: no way"
        );
        let failed = response_text(
            TOKEN,
            WORKER,
            &json!({ "id": 9, "ok": false, "error": "window_id is stale" }),
        );
        assert_eq!(read_response(&failed, TOKEN, WORKER, 9).unwrap_err(), "window_id is stale");
    }

    #[test]
    fn a_missing_response_is_classified_by_the_exit_code() {
        assert_eq!(missing_response(1223), "privileged_worker_cancelled: UAC consent was declined");
        assert_eq!(missing_response(0), "privileged_worker_unavailable: elevated worker returned no response");
        assert_eq!(
            missing_response(3),
            "privileged_worker_launcher_failed: elevated worker exited with code 3"
        );
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
}
