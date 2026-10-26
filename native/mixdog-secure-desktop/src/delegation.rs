//! App-delegated, unelevated enroll/revoke — the "approve once, then paired
//! phones auto-enroll" model.
//!
//! After a one-time elevated opt-in (`install` records a [delegation
//! policy](crate::security::DelegationPolicy) in the SYSTEM-only install
//! state), the genuine signed Mixdog app may enroll or revoke one phone key at
//! a time **without elevation**, by asking the always-on SYSTEM service over a
//! second, SYSTEM-owned named pipe. The app holds no bearer secret: it asks,
//! and the service decides against the stored policy.
//!
//! Two-sided authentication:
//! - **The app authenticates the service** by [`crate::ipc::connect`], which
//!   refuses to send anything unless the pipe's server process is SYSTEM — so a
//!   same-user squatter that pre-created the name while the service was down is
//!   rejected (and `FILE_FLAG_FIRST_PIPE_INSTANCE` stops a squatter while it is
//!   up).
//! - **The service authenticates the app** on each connection:
//!   `GetNamedPipeClientProcessId` (never a PID from the message) → a held
//!   `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` so the PID cannot be
//!   reused mid-check → `QueryFullProcessImageNameW` → `signature::verify_file`
//!   against the stored signer policy (full Authenticode + chain + revocation),
//!   plus the caller's token SID = the installing user and session = the active
//!   console session. Any failure is refused.
//!
//! Only two narrow operations exist — `enroll{key}` and `revoke{key}` — each
//! evaluated against the policy and applied through the same
//! [`crate::install::apply_delegated_key_change`] mutation the elevated paths
//! use. There is no generic "sign this" or "hand me the capability". The policy
//! is re-read from state on every request, so a security disable
//! ([`crate::install::disable_delegation`]) or a revoke takes effect at once,
//! across reconnect and reboot; re-enabling delegation needs elevation again.
//! Every delegated enrollment raises an on-PC notification in the console
//! session, so a silent addition is visible.
//!
//! Residual risk (documented fully in the crate README): a signature identifies
//! the EXE, not that the running process is uncompromised. A compromised but
//! still-signed app could enroll its own key and drive the secure desktop.
//! Approving delegation trusts the app as it runs on this PC. Per-phone keys
//! and signed-grant freshness/revocation still hold.

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_MODE, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSSendMessageW};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{MB_OK, MESSAGEBOX_RESULT};

use crate::winutil::{client_user_sid, wide, OwnedHandle, SecurityDescriptor};
use crate::service::NO_ACTIVE_SESSION;
use crate::{install, ipc, log, paths, security, signature};

/// The delegation pipe. Distinct from the control pipe
/// ([`crate::paths::PIPE_NAME`]); it carries only enroll/revoke requests.
pub const DELEGATION_PIPE_NAME: &str = r"\\.\pipe\mixdog-secure-desktop-delegate";

/// A hard ceiling on a request/reply frame. A request is an op plus one
/// base64url key (~90 bytes); 4 KiB is ample and refuses anything absurd
/// before allocating.
const MAX_FRAME: usize = 4096;

/// How often the server wakes to re-check [`STOP`] while waiting for a
/// connected client's bytes. This is a shutdown-responsiveness poll cadence,
/// not a timeout on any external wait: the request arrives in one write right
/// after connect, so the first poll almost always has it.
const STOP_POLL: Duration = Duration::from_millis(50);

/// Set on service stop so the server loop exits; [`request_stop`] also wakes a
/// blocked `ConnectNamedPipe` by self-connecting.
static STOP: AtomicBool = AtomicBool::new(false);

fn stopping() -> bool {
    STOP.load(Ordering::SeqCst)
}

/// Ask the server loop to exit (called from the service on stop) and unblock a
/// pending accept by connecting to the pipe once.
pub fn request_stop() {
    STOP.store(true, Ordering::SeqCst);
    let name = wide(DELEGATION_PIPE_NAME);
    // A best-effort self-connect to break `ConnectNamedPipe`; the loop then
    // sees `stopping()` and returns. Errors are ignored (nothing to wake).
    if let Ok(handle) = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    } {
        drop(OwnedHandle::new(handle));
    }
}

/// Why a delegated request was refused. Each maps to a stable reply reason the
/// client turns into a phone outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Denial {
    /// Delegation is off (never opted in, or disabled).
    Disabled,
    /// The caller is not the installing user, not in the console session, or
    /// its image is not the authorized signed app.
    Denied,
}

impl Denial {
    fn reason(self) -> &'static str {
        match self {
            Denial::Disabled => "disabled",
            Denial::Denied => "denied",
        }
    }
}

/// The framed request the app sends after the server-SYSTEM check.
#[derive(Debug, Serialize, Deserialize)]
struct Request {
    op: String,
    key: String,
}

/// The framed reply.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Reply {
    ok: bool,
    #[serde(default)]
    changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Reply {
    fn ok(changed: bool) -> Self {
        Reply { ok: true, changed, reason: None, error: None }
    }

    fn denied(denial: Denial, error: &str) -> Self {
        Reply { ok: false, changed: false, reason: Some(denial.reason().to_string()), error: Some(error.to_string()) }
    }
}

/// Decide whether a delegated caller may change the key set. Pure, so the gate
/// is unit-tested without a pipe: delegation must be enabled, the caller must
/// be the installing user in the active console session, and its image must be
/// the authorized signer. `signer_ok` is the result of the (impure) Authenticode
/// verification against the stored policy.
fn caller_allowed(
    enabled: bool,
    installing_sid: &str,
    serviced_session: u32,
    caller_sid: &str,
    caller_session: u32,
    signer_ok: bool,
) -> Result<(), Denial> {
    if !enabled {
        return Err(Denial::Disabled);
    }
    if !caller_sid.eq_ignore_ascii_case(installing_sid) {
        return Err(Denial::Denied);
    }
    if serviced_session == NO_ACTIVE_SESSION || caller_session != serviced_session {
        return Err(Denial::Denied);
    }
    if !signer_ok {
        return Err(Denial::Denied);
    }
    Ok(())
}

// ---- framing ----------------------------------------------------------------

/// Write a length-prefixed frame (4-byte big-endian length, then the bytes).
fn write_frame<W: Write>(writer: &mut W, bytes: &[u8]) -> io::Result<()> {
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}

/// Read exactly `buf.len()` bytes, treating a short read (peer closed) as an
/// error rather than a silent truncation.
fn read_exact_io<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        let read = reader.read(&mut buf[filled..])?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the peer closed the delegation pipe"));
        }
        filled += read;
    }
    Ok(())
}

/// Read one length-prefixed frame, refusing a length over [`MAX_FRAME`].
fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut length = [0u8; 4];
    read_exact_io(reader, &mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "delegation frame too large"));
    }
    let mut body = vec![0u8; length];
    read_exact_io(reader, &mut body)?;
    Ok(body)
}

// ---- client (unelevated app, run as `enroll/revoke --delegated`) ------------

/// Run one delegated op through the service's pipe and map the reply to an exit
/// code. The app runs this unelevated; [`crate::ipc::connect`] authenticates
/// the service is SYSTEM before a byte is sent.
pub fn request_key_change(op: &str, key: &str) -> i32 {
    let handle = match ipc::connect(DELEGATION_PIPE_NAME) {
        Ok(handle) => handle,
        Err(error) => {
            install::emit(json!({ "ok": false, "delegation": "unavailable", "error": error.to_string() }));
            return install::EXIT_DELEGATION_UNAVAILABLE;
        }
    };
    let request = Request { op: op.to_string(), key: key.to_string() };
    let body = serde_json::to_vec(&request).expect("a request always serializes");
    let mut io = ipc::PipeIo(handle.get());
    let reply = (|| -> io::Result<Reply> {
        write_frame(&mut io, &body)?;
        let frame = read_frame(&mut io)?;
        serde_json::from_slice::<Reply>(&frame).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    })();
    match reply {
        Ok(reply) if reply.ok => {
            install::emit(json!({ "ok": true, "delegated": true, "changed": reply.changed }));
            0
        }
        Ok(reply) => {
            let detail = reply.error.unwrap_or_else(|| "the delegated request was refused".into());
            install::emit(json!({ "ok": false, "delegation": reply.reason, "error": detail }));
            match reply.reason.as_deref() {
                Some("disabled") => install::EXIT_DELEGATION_DISABLED,
                _ => install::EXIT_DELEGATION_DENIED,
            }
        }
        Err(error) => {
            install::emit(json!({ "ok": false, "delegation": "unavailable", "error": error.to_string() }));
            install::EXIT_DELEGATION_UNAVAILABLE
        }
    }
}

// ---- server (the SYSTEM service's dedicated thread) -------------------------

/// Serve the delegation pipe until the service stops. The pipe DACL admits only
/// the installing user and SYSTEM ([`crate::security::pipe_sddl`]); every
/// connection is still authenticated per request. Logs and returns on a create
/// failure (a squatter owns the name, or an invalid SID): delegation is simply
/// unavailable then, and the client reports it.
pub fn serve(installing_sid: &str) {
    let Some(sddl) = security::pipe_sddl(installing_sid) else {
        log::event("delegation", "install state has an invalid user SID; delegation server not started");
        return;
    };
    log::event("delegation", "delegation server started");
    while !stopping() {
        let pipe = match create_pipe(&sddl) {
            Ok(pipe) => pipe,
            Err(error) => {
                log::event("delegation", &format!("create delegation pipe failed: {error}; server stopping"));
                return;
            }
        };
        // Block until a client connects or `request_stop` self-connects.
        let connected = unsafe { ConnectNamedPipe(pipe.get(), None) };
        if let Err(error) = connected {
            // ERROR_PIPE_CONNECTED (535) means a client beat us to it: still connected.
            const ERROR_PIPE_CONNECTED: i32 = 0x217;
            if error.code().0 & 0xFFFF != ERROR_PIPE_CONNECTED {
                unsafe { let _ = DisconnectNamedPipe(pipe.get()); }
                continue;
            }
        }
        if stopping() {
            unsafe { let _ = DisconnectNamedPipe(pipe.get()); }
            break;
        }
        serve_connection(&pipe, installing_sid);
        unsafe { let _ = DisconnectNamedPipe(pipe.get()); }
    }
    log::event("delegation", "delegation server stopped");
}

/// Create one blocking, single-instance, local-only delegation pipe with the
/// installing-user + SYSTEM DACL.
fn create_pipe(sddl: &str) -> Result<OwnedHandle, String> {
    let descriptor = SecurityDescriptor::from_sddl(sddl).map_err(|error| error.to_string())?;
    let attributes = descriptor.attributes();
    let name = wide(DELEGATION_PIPE_NAME);
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_FRAME as u32,
            MAX_FRAME as u32,
            0,
            Some(&attributes),
        )
    };
    OwnedHandle::new(handle).ok_or_else(|| "CreateNamedPipeW returned an invalid handle".to_string())
}

/// Authenticate the connected client, read its request, apply it against the
/// policy, and reply. Any failure is reported to the client as a denial; the
/// connection is never left to leak the key set.
fn serve_connection(pipe: &OwnedHandle, installing_sid: &str) {
    let mut io = ipc::PipeIo(pipe.get());
    let request = match read_frame_bounded(pipe) {
        Ok(frame) => match serde_json::from_slice::<Request>(&frame) {
            Ok(request) => request,
            Err(error) => {
                let _ = write_frame(&mut io, &reply_bytes(&Reply::denied(Denial::Denied, &format!("malformed request: {error}"))));
                return;
            }
        },
        Err(error) => {
            log::event("delegation", &format!("read request failed: {error}"));
            return;
        }
    };

    let reply = evaluate(pipe, installing_sid, &request);
    if let Err(error) = write_frame(&mut io, &reply_bytes(&reply)) {
        log::event("delegation", &format!("write reply failed: {error}"));
    }
}

fn reply_bytes(reply: &Reply) -> Vec<u8> {
    serde_json::to_vec(reply).expect("a reply always serializes")
}

/// Authenticate the caller and apply the op. The delegation policy is read from
/// state *now*, so a disable or policy change is seen at once.
fn evaluate(pipe: &OwnedHandle, installing_sid: &str, request: &Request) -> Reply {
    if request.op != "enroll" && request.op != "revoke" {
        return Reply::denied(Denial::Denied, "unknown delegated operation");
    }
    if security::decode_controller_key(&request.key).is_none() {
        return Reply::denied(Denial::Denied, "the controller key is not an uncompressed P-256 point");
    }

    // The policy as it stands now (disable is immediate).
    let (enabled, signer) = match load_delegation() {
        Some((enabled, signer)) => (enabled, signer),
        None => return Reply::denied(Denial::Disabled, "app delegation is not enabled"),
    };

    let caller_sid = client_user_sid(pipe.get());
    let caller_session = ipc::client_session_id(pipe);
    let serviced_session = unsafe { WTSGetActiveConsoleSessionId() };
    let signer_ok = signer
        .as_ref()
        .map(|policy| verify_caller_image(pipe, policy))
        .unwrap_or(false);

    match (caller_sid, caller_session) {
        (Some(caller_sid), Some(caller_session)) => {
            if let Err(denial) =
                caller_allowed(enabled, installing_sid, serviced_session, &caller_sid, caller_session, signer_ok)
            {
                log::event("delegation", &format!("refused a delegated {} ({denial:?})", request.op));
                return Reply::denied(denial, "the calling app could not be authenticated for delegation");
            }
        }
        _ => return Reply::denied(Denial::Denied, "the caller identity could not be determined"),
    }

    // `caller_allowed` passed, so a signer policy was present and verified.
    let Some(policy) = signer else {
        return Reply::denied(Denial::Denied, "no delegated app signer is recorded");
    };
    // The mutation re-checks the policy under the install lock, so a disable
    // that lands during this call is still honored.
    match install::apply_delegated_key_change(&request.op, &request.key, &policy) {
        Ok(changed) => {
            if changed && request.op == "enroll" {
                notify_enrollment(serviced_session);
            }
            log::event("delegation", &format!("delegated {} applied (changed={changed})", request.op));
            Reply::ok(changed)
        }
        Err(error) => Reply::denied(Denial::Denied, &error),
    }
}

/// The stored delegation state: `(enabled, Some(signer_policy))`, or `None` when
/// state is unreadable. A policy of `None` with `enabled` true never authorizes
/// (no recorded signer to match).
fn load_delegation() -> Option<(bool, Option<signature::SignerPolicy>)> {
    let text = std::fs::read_to_string(paths::state_file()).ok()?;
    let state = security::InstallState::from_json(&text).ok()?;
    let policy = state.delegation.authorized_signer().map(|(subject, eku)| signature::SignerPolicy {
        subject: subject.to_string(),
        profile_eku: eku.to_string(),
    });
    Some((state.delegation.enabled, policy))
}

/// Resolve the connected client's image path (held process handle, so the PID
/// cannot be reused mid-check) and verify it against the stored signer policy.
///
/// Limits (see the crate README, "What caller authentication does not check"):
/// this checks the EXE's **signer** only — not its location (a signed copy run
/// from elsewhere passes) and not Electron's `resources/` beside it (a modified
/// `app.asar` is not detected). Requests carry no replay nonce: an
/// authenticated caller may repeat one (`enroll`/`revoke` are idempotent); an
/// unauthenticated one is refused, since each request is authenticated afresh
/// from the pipe peer.
fn verify_caller_image(pipe: &OwnedHandle, policy: &signature::SignerPolicy) -> bool {
    let Some(pid) = ipc::client_pid(pipe) else {
        return false;
    };
    let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => match OwnedHandle::new(handle) {
            Some(process) => process,
            None => return false,
        },
        Err(_) => return false,
    };
    // 32 768 UTF-16 units: the extended-length path maximum (32 767) plus the
    // terminator, the longest image path `QueryFullProcessImageNameW` can return.
    let mut buffer = vec![0u16; 32 * 1024];
    let mut size = buffer.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(process.get(), PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size)
    }
    .is_err()
    {
        return false;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    match signature::verify_file_against(std::path::Path::new(&path), policy) {
        Ok(_) => true,
        Err(refusal) => {
            log::event("delegation", &format!("caller image refused: {}", refusal.message()));
            false
        }
    }
}

/// Raise an on-PC notification in the console session for a delegated
/// enrollment, so a silent addition is noticeable. Best-effort and
/// non-blocking (`bWait = FALSE`): a failure is logged, never fatal.
fn notify_enrollment(session: u32) {
    if session == NO_ACTIVE_SESSION {
        return;
    }
    let mut title = wide("Mixdog 원격 접근");
    let mut message = wide("새 휴대폰이 이 PC의 원격 접근 권한에 등록되었습니다.");
    let mut response = MESSAGEBOX_RESULT::default();
    let result = unsafe {
        WTSSendMessageW(
            None, // WTS_CURRENT_SERVER_HANDLE
            session,
            PWSTR(title.as_mut_ptr()),
            (title.len() * 2) as u32,
            PWSTR(message.as_mut_ptr()),
            (message.len() * 2) as u32,
            MB_OK,
            0,
            &mut response,
            false,
        )
    };
    if let Err(error) = result {
        log::event("delegation", &format!("enrollment notification failed: {error}"));
    }
}

/// Read one request frame — both the header and the body — so that **every**
/// read is cancellable by [`STOP`] and bounded by a deadline. A permitted
/// client that connects, announces a body, then withholds it (before auth)
/// cannot block the delegation thread or the service's shutdown join: each
/// wait polls `stopping()` and a [`FRAME_DEADLINE`](crate::helper::FRAME_DEADLINE)
/// deadline, and `ReadFile` is issued only once the bytes are already buffered,
/// so it never blocks. A closed peer, stop, or timeout drops the connection.
fn read_frame_bounded(pipe: &OwnedHandle) -> io::Result<Vec<u8>> {
    let deadline = Instant::now() + crate::helper::FRAME_DEADLINE;
    let mut io = ipc::PipeIo(pipe.get());
    wait_for_bytes(pipe, 4, deadline)?;
    let mut length = [0u8; 4];
    read_exact_io(&mut io, &mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "delegation frame too large"));
    }
    wait_for_bytes(pipe, length, deadline)?;
    let mut body = vec![0u8; length];
    read_exact_io(&mut io, &mut body)?;
    Ok(body)
}

/// Wait until at least `need` bytes are buffered on the pipe, cancellable by
/// `stopping()` and bounded by `deadline`. Polls `PeekNamedPipe` (which errors
/// on a broken pipe), so the following `ReadFile` of buffered bytes never blocks.
fn wait_for_bytes(pipe: &OwnedHandle, need: usize, deadline: Instant) -> io::Result<()> {
    loop {
        if stopping() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "service stopping"));
        }
        if peek_available(pipe.get())? as usize >= need {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "delegation request did not arrive in time"));
        }
        std::thread::sleep(STOP_POLL);
    }
}

/// Bytes currently buffered on the pipe without removing them. A broken pipe
/// (client closed) is an error.
fn peek_available(pipe: HANDLE) -> io::Result<u32> {
    let mut available = 0u32;
    unsafe { PeekNamedPipe(pipe, None, 0, None, Some(&mut available), None) }
        .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error.to_string()))?;
    Ok(available)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1-2-3-1001";

    #[test]
    fn delegation_is_refused_unless_every_condition_holds() {
        // The happy path: enabled, installing user, console session, trusted image.
        assert_eq!(caller_allowed(true, SID, 1, SID, 1, true), Ok(()));
        // Case-insensitive SID match (SIDs are compared case-insensitively).
        assert_eq!(caller_allowed(true, SID, 1, &SID.to_lowercase(), 1, true), Ok(()));
        // Disabled beats everything else.
        assert_eq!(caller_allowed(false, SID, 1, SID, 1, true), Err(Denial::Disabled));
        // A different user, the wrong session, or an untrusted image are each denied.
        assert_eq!(caller_allowed(true, SID, 1, "S-1-5-21-9-9-9-500", 1, true), Err(Denial::Denied));
        assert_eq!(caller_allowed(true, SID, 1, SID, 2, true), Err(Denial::Denied));
        assert_eq!(caller_allowed(true, SID, NO_ACTIVE_SESSION, SID, NO_ACTIVE_SESSION, true), Err(Denial::Denied));
        assert_eq!(caller_allowed(true, SID, 1, SID, 1, false), Err(Denial::Denied));
    }

    #[test]
    fn frames_round_trip_and_reject_oversize() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"hello").unwrap();
        assert_eq!(&buffer[..4], &5u32.to_be_bytes());
        let mut cursor = io::Cursor::new(buffer);
        assert_eq!(read_frame(&mut cursor).unwrap(), b"hello");
        // A length header over the cap is refused before reading a body.
        let mut oversize = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
        oversize.extend_from_slice(&[0u8; 8]);
        assert!(read_frame(&mut io::Cursor::new(oversize)).is_err());
        // A truncated body is an error, not a silent short read.
        let mut truncated = 10u32.to_be_bytes().to_vec();
        truncated.extend_from_slice(b"abc");
        assert!(read_frame(&mut io::Cursor::new(truncated)).is_err());
    }

    #[test]
    fn a_reply_serializes_with_only_the_fields_it_carries() {
        let ok = String::from_utf8(reply_bytes(&Reply::ok(true))).unwrap();
        assert!(ok.contains("\"ok\":true") && ok.contains("\"changed\":true"));
        assert!(!ok.contains("reason") && !ok.contains("error"));
        let denied = String::from_utf8(reply_bytes(&Reply::denied(Denial::Disabled, "off"))).unwrap();
        assert!(denied.contains("\"ok\":false") && denied.contains("\"reason\":\"disabled\""));
        assert!(denied.contains("\"error\":\"off\""));
    }
}
