//! The LocalSystem Windows service (`mixdog-secure-desktop service`).
//!
//! Registered demand-start and off by default, it is the only component that
//! can place a SYSTEM process in the interactive session. Its entire job is
//! lifecycle: keep exactly one helper running in the active console session,
//! relaunch it when the console session changes or the helper exits, and tear
//! it down on stop. Capture, injection, and the app pipe all live in the
//! helper; the service owns none of them and opens no pipe or socket itself.
//!
//! Teardown is graceful: the service signals the helper's stop event, waits for
//! its acknowledgement (sent after it released every held key and button) and
//! for the process to exit, and force-kills only after the helper's documented
//! shutdown deadline ([`crate::shutdown`]).
//!
//! **Bootstrap.** Each helper is created suspended inside a kill-on-close job
//! that only the service holds ([`crate::launch::BootstrapJob`]), so a
//! service that dies mid-launch takes the never-run helper with it. The
//! monitor loop disarms the job only after the helper confirms its parent
//! watch, and the helper serves nothing until then ([`crate::shutdown`]).
//!
//! The helper follows the input desktop (Default <-> Winlogon) on its own, so
//! the service reacts only to *session* changes (fast path via
//! `SERVICE_CONTROL_SESSIONCHANGE`, plus a one-second poll as a backstop).
//!
//! **Supervision is the SCM's.** A helper that exits on its own (a crash, or a
//! fatal error such as unreadable state) or cannot be launched is a failure
//! of the service: it stops the helper's session work and reports
//! `SERVICE_STOPPED` with a non-zero exit code. The install configures the
//! SCM's failure actions (restart after 60 s, at most 3 times, count reset
//! after a day) with the non-crash-failure flag, under which "the failure
//! actions are queued if … it enters the SERVICE_STOPPED state but the
//! dwWin32ExitCode member … is not ERROR_SUCCESS"
//! (https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_failure_actions_flag).
//! So a crash loop is paced and bounded by Windows, and logs one line per
//! failure — there is no backoff or log limiter of our own.
//!
//! **Lock state.** `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK` arrive with
//! `SERVICE_CONTROL_SESSIONCHANGE`; the service relays them to the helper
//! through its session event ([`crate::shutdown`]), so nobody polls WTS.
//!
//! **Ctrl+Alt+Del.** The helper asks for the secure attention sequence through
//! its SYSTEM-only SAS event ([`crate::shutdown`]); the service performs it
//! with `SendSAS(FALSE)` from `sas.dll` ([`perform_sas`]), enabling software
//! SAS only temporarily and only when nobody configured it, under an
//! ownership marker that a restart also resolves
//! ([`crate::security::send_sas_under_policy`]).

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use windows::core::{s, w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{FreeLibrary, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Security::{RevertToSelf, TokenImpersonation};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
use windows::Win32::System::Services::{
    RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW, SERVICE_ACCEPT_SESSIONCHANGE,
    SERVICE_ACCEPT_STOP, SERVICE_CONTROL_SESSIONCHANGE, SERVICE_CONTROL_STOP, SERVICE_RUNNING,
    SERVICE_STATUS, SERVICE_STATUS_CURRENT_STATE, SERVICE_STATUS_HANDLE, SERVICE_STOPPED,
    SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetExitCodeProcess, SetEvent, SetThreadToken, TerminateProcess,
    WaitForMultipleObjects,
};

use crate::helper::SHUTDOWN_DEADLINE;
use crate::launch::{self, BootstrapJob, DESKTOP_DEFAULT};
use crate::security::{
    generate_shutdown_token, restore_software_sas, send_sas_under_policy, InstallState, SasCleanup,
    SasPolicyStore, SasSent, SOFTWARE_SAS_POLICY_KEY, SOFTWARE_SAS_POLICY_VALUE,
};
use crate::shutdown::ServiceEnd;
use crate::winutil::{self, wide, OwnedHandle};
use crate::{log, paths};

const SERVICE_START_PENDING: SERVICE_STATUS_CURRENT_STATE = SERVICE_STATUS_CURRENT_STATE(2);
const SERVICE_STOP_PENDING: SERVICE_STATUS_CURRENT_STATE = SERVICE_STATUS_CURRENT_STATE(3);
const SERVICE_ACCEPT_SHUTDOWN: u32 = 4;
const SERVICE_CONTROL_SHUTDOWN: u32 = 5;
const SERVICE_CONTROL_INTERROGATE: u32 = 4;
const STILL_ACTIVE: u32 = 259;
const NO_ACTIVE_SESSION: u32 = 0xFFFF_FFFF;

static STOP: AtomicBool = AtomicBool::new(false);
static WAKE_EVENT: AtomicUsize = AtomicUsize::new(0);
static STATUS_HANDLE: AtomicUsize = AtomicUsize::new(0);
static CHECKPOINT: AtomicU32 = AtomicU32::new(0);

/// The monitor loop's poll backstop, also the slice in which a helper shutdown
/// wait reports SCM progress.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The `dwWaitHint` of the service's single `SERVICE_START_PENDING`, before
/// it creates its wake event and reports `SERVICE_RUNNING`. Microsoft's
/// service sample uses exactly this pattern and value —
/// `ReportSvcStatus( SERVICE_START_PENDING, NO_ERROR, 3000 )`, then an
/// event, then `SERVICE_RUNNING`
/// (https://learn.microsoft.com/windows/win32/services/writing-a-servicemain-function).
/// Exported so the installer's start wait follows the same hint.
pub const SERVICE_START_WAIT_HINT_MS: u32 = 3000;

/// `ERROR_SERVICE_SPECIFIC_ERROR`: the service's own failure, detailed in
/// `dwServiceSpecificExitCode`
/// (https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_status).
const ERROR_SERVICE_SPECIFIC_ERROR: u32 = 1066;
/// `dwServiceSpecificExitCode` when no helper could be launched (a helper's
/// own exit code is reported otherwise).
const LAUNCH_FAILED: u32 = u32::MAX;

/// `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`: the `dwEventType` of a
/// `SERVICE_CONTROL_SESSIONCHANGE` for a lock / unlock
/// (https://learn.microsoft.com/windows/win32/termserv/wm-wtssession-change).
const WTS_SESSION_LOCK: u32 = 0x7;
const WTS_SESSION_UNLOCK: u32 = 0x8;

/// A lock / unlock was delivered and not yet relayed to the helper.
static LOCK_CHANGED: AtomicBool = AtomicBool::new(false);

/// `dwWaitHint` while stopping: the longest the service may take, which is the
/// helper's documented shutdown deadline (force-kill happens only after it).
fn stop_wait_hint() -> u32 {
    SHUTDOWN_DEADLINE.as_millis() as u32
}

/// Dispatch into the SCM. Blocks until the service stops. Fails only when run
/// outside the SCM (e.g. from a shell), which the caller reports.
pub fn run() -> i32 {
    let mut name = wide(paths::SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: PWSTR(name.as_mut_ptr()),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    match unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } {
        Ok(()) => 0,
        Err(error) => {
            log::event("service", &format!("dispatcher failed: {error}"));
            1
        }
    }
}

/// Report status to the SCM. Pending states carry an increasing checkpoint so a
/// waiter (the uninstaller) sees progress while the helper is shut down; any
/// other state resets it.
fn set_status(state: SERVICE_STATUS_CURRENT_STATE, controls: u32, wait_hint: u32) {
    report_status(state, controls, wait_hint, None);
}

/// [`set_status`], with `failure` (a service-specific code) reported as
/// `ERROR_SERVICE_SPECIFIC_ERROR` — which makes the SCM apply the failure
/// actions on `SERVICE_STOPPED`.
fn report_status(state: SERVICE_STATUS_CURRENT_STATE, controls: u32, wait_hint: u32, failure: Option<u32>) {
    let handle = SERVICE_STATUS_HANDLE(STATUS_HANDLE.load(Ordering::SeqCst) as *mut core::ffi::c_void);
    if handle.is_invalid() {
        return;
    }
    let pending = state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING;
    let checkpoint = if pending { CHECKPOINT.fetch_add(1, Ordering::SeqCst) + 1 } else {
        CHECKPOINT.store(0, Ordering::SeqCst);
        0
    };
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: controls,
        dwWin32ExitCode: if failure.is_some() { ERROR_SERVICE_SPECIFIC_ERROR } else { 0 },
        dwServiceSpecificExitCode: failure.unwrap_or(0),
        dwCheckPoint: checkpoint,
        dwWaitHint: wait_hint,
    };
    unsafe {
        let _ = SetServiceStatus(handle, &status);
    }
}

fn wake() {
    let raw = WAKE_EVENT.load(Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let _ = SetEvent(HANDLE(raw as *mut core::ffi::c_void));
        }
    }
}

unsafe extern "system" fn control_handler(
    control: u32,
    event_type: u32,
    _event_data: *mut core::ffi::c_void,
    _context: *mut core::ffi::c_void,
) -> u32 {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            STOP.store(true, Ordering::SeqCst);
            set_status(SERVICE_STOP_PENDING, 0, stop_wait_hint());
            wake();
        }
        SERVICE_CONTROL_SESSIONCHANGE => {
            // A console connect/disconnect: re-evaluate which session to
            // serve. A lock / unlock is relayed to the helper (whose session
            // it concerns is re-checked by the helper's own WTS query).
            if event_type == WTS_SESSION_LOCK || event_type == WTS_SESSION_UNLOCK {
                LOCK_CHANGED.store(true, Ordering::SeqCst);
            }
            wake();
        }
        SERVICE_CONTROL_INTERROGATE => {
            let running = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_SESSIONCHANGE;
            set_status(SERVICE_RUNNING, running, 0);
        }
        _ => {}
    }
    0 // NO_ERROR
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
    let name = wide(paths::SERVICE_NAME);
    let handle = match RegisterServiceCtrlHandlerExW(PCWSTR(name.as_ptr()), Some(control_handler), None) {
        Ok(handle) => handle,
        Err(error) => {
            log::event("service", &format!("register handler failed: {error}"));
            return;
        }
    };
    STATUS_HANDLE.store(handle.0 as usize, Ordering::SeqCst);
    set_status(SERVICE_START_PENDING, 0, SERVICE_START_WAIT_HINT_MS);

    // Auto-reset event used to break the poll wait on stop / session change.
    let event = match CreateEventW(None, false, false, PCWSTR::null()) {
        Ok(event) => event,
        Err(error) => {
            log::event("service", &format!("create event failed: {error}"));
            set_status(SERVICE_STOPPED, 0, 0);
            return;
        }
    };
    WAKE_EVENT.store(event.0 as usize, Ordering::SeqCst);

    let running = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_SESSIONCHANGE;
    set_status(SERVICE_RUNNING, running, 0);
    log::event("service", "started");

    // A software-SAS value this service set and could not remove (it crashed
    // in between, or the removal failed) is resolved before anything else.
    match recover_software_sas() {
        Ok(SasCleanup::Nothing) => {}
        Ok(outcome) => log::event("service", &format!("software SAS marker resolved at start: {outcome:?}")),
        Err(error) => log::event("service", &format!("software SAS marker unresolved at start: {error}")),
    }

    // The session policy needs the installing user's SID. Without readable
    // install state the service can prove nothing about who owns a console
    // session, so it serves none (fails closed).
    let installing_sid = std::fs::read_to_string(paths::state_file())
        .ok()
        .and_then(|text| InstallState::from_json(&text).ok())
        .map(|state| state.user_sid);
    if installing_sid.is_none() {
        log::event("service", "install state unavailable; no session will be served");
    }

    // The delegation pipe server (app-delegated enroll/revoke) runs on its own
    // thread for the service's lifetime, gated per request by the stored
    // policy; it is stopped and joined after the monitor loop returns. It is
    // started only when the installing user is known (its pipe DACL needs the
    // SID), matching the session policy above.
    let delegation = installing_sid.clone().map(|sid| std::thread::spawn(move || crate::delegation::serve(&sid)));

    let verdict = monitor_loop(event, installing_sid.as_deref());

    if let Some(thread) = delegation {
        crate::delegation::request_stop();
        let _ = thread.join();
    }

    match verdict {
        None => {
            set_status(SERVICE_STOPPED, 0, 0);
            log::event("service", "stopped");
        }
        Some(code) => {
            log::event(
                "service",
                &format!("stopped on a helper failure (service-specific code {code}); the SCM's failure actions apply"),
            );
            report_status(SERVICE_STOPPED, 0, 0, Some(code));
        }
    }
}

/// Whether the active console session may be served. The logon / sign-in screen
/// (no interactive user) is allowed — it is a valid target and exposes no other
/// user's desktop. Once a user is signed in, only the installing user's own
/// session is served, so a fast user switch to another account is denied.
fn session_allowed(active: u32, installing_sid: &str) -> bool {
    match winutil::session_user_sid(active) {
        None => true,
        Some(user) => user.eq_ignore_ascii_case(installing_sid),
    }
}

fn process_alive(process: &OwnedHandle) -> bool {
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(process.get(), &mut code).is_ok() && code == STILL_ACTIVE }
}

/// One running helper: its process, the console session it serves, the
/// service's end of its shutdown channel, and — until the helper has
/// confirmed its parent watch — the armed bootstrap job it runs in. Dropping
/// a `Helper` whose job is still armed terminates it through the job.
struct Helper {
    process: OwnedHandle,
    session: u32,
    channel: ServiceEnd,
    bootstrap: Option<BootstrapJob>,
}

/// Launch a helper into `session` with a fresh shutdown channel. The events are
/// created before the process so the helper can always open them. The helper
/// is created suspended inside a kill-on-close job, and while it is still
/// suspended it gets a handle to this service process for its parent watch
/// ([`ServiceEnd::hand_over_parent`], [`crate::launch`], [`crate::shutdown`]).
fn launch_helper(session: u32) -> Result<Helper, String> {
    let token = generate_shutdown_token();
    let channel = ServiceEnd::create(&token).map_err(|error| format!("shutdown channel: {error}"))?;
    let (process, job) = launch::launch_in_session(session, DESKTOP_DEFAULT, &["helper", &token], |helper| {
        channel.hand_over_parent(helper)
    })
    .map_err(|error| error.to_string())?;
    Ok(Helper { process, session, channel, bootstrap: Some(job) })
}

fn exit_code(process: &OwnedHandle) -> Option<u32> {
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(process.get(), &mut code) }.ok().map(|()| code)
}

// ---- Ctrl+Alt+Del ------------------------------------------------------------

/// `HKEY_LOCAL_MACHINE`: the predefined key `(HKEY)(ULONG_PTR)(LONG)0x80000002`,
/// sign-extended to pointer width.
fn hkey_local_machine() -> *mut core::ffi::c_void {
    (0x8000_0002u32 as i32) as isize as *mut core::ffi::c_void
}

const ERROR_FILE_NOT_FOUND: i32 = 2;
const RRF_RT_REG_DWORD: u32 = 0x10;
const REG_DWORD: u32 = 4;

mod registry {
    // The three advapi32 registry calls the SAS policy needs, imported
    // directly; the crate does not enable the `Win32_System_Registry` feature.
    windows::core::link!("advapi32.dll" "system" fn RegGetValueW(hkey: *mut core::ffi::c_void, subkey: windows::core::PCWSTR, value: windows::core::PCWSTR, flags: u32, kind: *mut u32, data: *mut core::ffi::c_void, size: *mut u32) -> i32);
    windows::core::link!("advapi32.dll" "system" fn RegSetKeyValueW(hkey: *mut core::ffi::c_void, subkey: windows::core::PCWSTR, value: windows::core::PCWSTR, kind: u32, data: *const core::ffi::c_void, size: u32) -> i32);
    windows::core::link!("advapi32.dll" "system" fn RegDeleteKeyValueW(hkey: *mut core::ffi::c_void, subkey: windows::core::PCWSTR, value: windows::core::PCWSTR) -> i32);
}

/// The current `SoftwareSASGeneration` DWORD, `None` when it is absent
/// (`RegGetValueW`, https://learn.microsoft.com/windows/win32/api/winreg/nf-winreg-reggetvaluew).
pub fn software_sas_generation() -> Result<Option<u32>, String> {
    let key = wide(SOFTWARE_SAS_POLICY_KEY);
    let value = wide(SOFTWARE_SAS_POLICY_VALUE);
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        registry::RegGetValueW(
            hkey_local_machine(),
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut _,
            &mut size,
        )
    };
    match status {
        0 => Ok(Some(data)),
        ERROR_FILE_NOT_FOUND => Ok(None),
        code => Err(format!("reading {SOFTWARE_SAS_POLICY_VALUE} failed ({code})")),
    }
}

fn set_software_sas_generation(data: u32) -> Result<(), String> {
    let key = wide(SOFTWARE_SAS_POLICY_KEY);
    let value = wide(SOFTWARE_SAS_POLICY_VALUE);
    let status = unsafe {
        registry::RegSetKeyValueW(
            hkey_local_machine(),
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            REG_DWORD,
            &data as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if status == 0 { Ok(()) } else { Err(format!("setting {SOFTWARE_SAS_POLICY_VALUE} failed ({status})")) }
}

fn delete_software_sas_generation() -> Result<(), String> {
    let key = wide(SOFTWARE_SAS_POLICY_KEY);
    let value = wide(SOFTWARE_SAS_POLICY_VALUE);
    let status =
        unsafe { registry::RegDeleteKeyValueW(hkey_local_machine(), PCWSTR(key.as_ptr()), PCWSTR(value.as_ptr())) };
    if status == 0 || status == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("removing {SOFTWARE_SAS_POLICY_VALUE} failed ({status})"))
    }
}

/// Call `SendSAS(FALSE)` with the thread impersonating a SYSTEM token whose
/// session is `session`. `SendSAS` must run in a service (or a signed uiAccess
/// app), and a service's call "simulates a SAS on the session associated with
/// the impersonated token" (https://learn.microsoft.com/windows/win32/api/sas/nf-sas-sendsas)
/// — so the service, in session 0, impersonates its own token retargeted to
/// the console session the helper serves. `sas.dll` is loaded from System32
/// only (`LOAD_LIBRARY_SEARCH_SYSTEM32`) and released afterwards.
fn send_sas_in_session(session: u32) -> Result<(), String> {
    let token = launch::session_token(session, TokenImpersonation)
        .map_err(|error| format!("session token: {error}"))?;
    unsafe {
        let module = LoadLibraryExW(w!("sas.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
            .map_err(|error| format!("sas.dll unavailable: {error}"))?;
        let result = match GetProcAddress(module, s!("SendSAS")) {
            None => Err("sas.dll has no SendSAS".to_string()),
            Some(proc) => {
                let send_sas: unsafe extern "system" fn(windows::core::BOOL) = std::mem::transmute(proc);
                match SetThreadToken(None, Some(token.get())) {
                    Ok(()) => {
                        send_sas(false.into());
                        let _ = RevertToSelf();
                        Ok(())
                    }
                    Err(error) => Err(format!("impersonation failed: {error}")),
                }
            }
        };
        let _ = FreeLibrary(module);
        result
    }
}

/// The service's ownership marker for a `SoftwareSASGeneration` value it set:
/// in the protected state directory, which only SYSTEM and Administrators
/// can write. Never creates that directory.
fn sas_marker_file() -> PathBuf {
    paths::state_dir().join("sas-policy-marker.json")
}

/// The live registry value and the marker file.
struct SystemSasPolicy;

impl SasPolicyStore for SystemSasPolicy {
    fn value(&mut self) -> Result<Option<u32>, String> {
        software_sas_generation()
    }

    fn set_value(&mut self, data: u32) -> Result<(), String> {
        set_software_sas_generation(data)
    }

    fn delete_value(&mut self) -> Result<(), String> {
        delete_software_sas_generation()
    }

    fn marker(&mut self) -> Result<Option<String>, String> {
        match std::fs::read(sas_marker_file()) {
            // Undecodable bytes are not a marker of ours; lossy keeps them
            // from wedging every later attempt.
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("reading the SAS policy marker failed: {error}")),
        }
    }

    fn write_marker(&mut self, text: &str) -> Result<(), String> {
        // Flushed to disk (`FlushFileBuffers`) before the value is set, so no
        // crash can leave our value without the marker naming it.
        let write = || -> std::io::Result<()> {
            let mut file = std::fs::File::create(sas_marker_file())?;
            file.write_all(text.as_bytes())?;
            file.sync_all()
        };
        write().map_err(|error| format!("writing the SAS policy marker failed: {error}"))
    }

    fn clear_marker(&mut self) -> Result<(), String> {
        match std::fs::remove_file(sas_marker_file()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("removing the SAS policy marker failed: {error}")),
        }
    }
}

/// Resolve a marker a previous run left (crash between setting and removing,
/// or a failed removal): remove the value only if it still holds what this
/// service wrote. Run at service start; also callable by uninstall before the
/// state directory (and the marker in it) is removed.
pub fn recover_software_sas() -> Result<SasCleanup, String> {
    restore_software_sas(&mut SystemSasPolicy)
}

/// Press Ctrl+Alt+Del in `session` under the software-SAS policy rules of
/// [`send_sas_under_policy`]. Returns how it was sent.
fn perform_sas(session: u32) -> Result<String, String> {
    let sent = send_sas_under_policy(&mut SystemSasPolicy, || send_sas_in_session(session))?;
    Ok(match sent {
        SasSent::AsConfigured => "sent (software SAS already allowed for services)".into(),
        SasSent::Temporarily(Ok(SasCleanup::Removed)) => {
            "sent under a temporary SoftwareSASGeneration=1, since removed".into()
        }
        SasSent::Temporarily(Ok(other)) => format!(
            "sent under a temporary SoftwareSASGeneration=1; not removed, it no longer held our value ({other:?})"
        ),
        SasSent::Temporarily(Err(error)) => format!(
            "sent under a temporary SoftwareSASGeneration=1, but removing it failed ({error}); \
             the marker is kept and retried at the next Ctrl+Alt+Del or service start"
        ),
    })
}

/// Stop a helper gracefully: signal it to release everything it holds and
/// exit, wait for its acknowledgement and for the process to exit, and
/// force-kill only once the helper's documented [`SHUTDOWN_DEADLINE`] has
/// passed. While the service itself is stopping, each wait slice reports SCM
/// progress.
fn stop_helper(helper: Helper, reason: &str) {
    if !process_alive(&helper.process) {
        log::event("service", &format!("helper already exited ({reason})"));
        return;
    }
    helper.channel.request_stop();
    let deadline = Instant::now() + SHUTDOWN_DEADLINE;
    let (acked, exited) =
        helper
            .channel
            .wait_for_exit(helper.process.get(), deadline, POLL_INTERVAL, || {
                if STOP.load(Ordering::SeqCst) {
                    set_status(SERVICE_STOP_PENDING, 0, stop_wait_hint());
                }
            });
    let session = helper.session;
    match (acked, exited) {
        (true, true) => log::event(
            "service",
            &format!("helper in session {session} released input and exited ({reason})"),
        ),
        (false, true) => log::event(
            "service",
            &format!("helper in session {session} exited without acknowledging ({reason})"),
        ),
        (_, false) => {
            unsafe {
                let _ = TerminateProcess(helper.process.get(), 0);
            }
            log::event(
                "service",
                &format!(
                    "helper in session {session} force-killed after the {}s shutdown deadline \
                     (acknowledged={acked}) ({reason})",
                    SHUTDOWN_DEADLINE.as_secs()
                ),
            );
        }
    }
    // Dropping `helper` closes the process handle, its events, and a
    // bootstrap job that was never released.
}

/// Keep one helper alive in the active console session — but only while that
/// session is permitted by the policy — until stop. When the console switches
/// to a session that is not permitted (e.g. a different user after a fast user
/// switch), any running helper is stopped, revoking capture and control. Every
/// stop — revoke, relaunch into a new session, service stop — goes through
/// [`stop_helper`]: graceful first, force-kill only after the deadline. A
/// helper that exits on its own, or a failed launch, ends the loop with the
/// service-specific failure code, for the SCM's failure actions to take over;
/// the helper's SAS requests and lock notifications are served in between.
/// Returns `None` on an orderly stop.
fn monitor_loop(event: HANDLE, installing_sid: Option<&str>) -> Option<u32> {
    let mut helper: Option<Helper> = None;
    let mut failure = None;

    while !STOP.load(Ordering::SeqCst) {
        let active = unsafe { WTSGetActiveConsoleSessionId() };
        let has_session = active != NO_ACTIVE_SESSION && active != 0;
        let allowed = has_session
            && installing_sid.is_some_and(|sid| session_allowed(active, sid));

        if allowed {
            if helper.as_ref().is_some_and(|running| running.session != active) {
                if let Some(previous) = helper.take() {
                    stop_helper(previous, "relaunching for the active console session");
                }
            }
            if helper.as_ref().is_some_and(|running| !process_alive(&running.process)) {
                if let Some(exited) = helper.take() {
                    let code = exit_code(&exited.process);
                    log::event(
                        "service",
                        &format!(
                            "helper in session {} exited on its own (code {})",
                            exited.session,
                            code.map_or("unknown".into(), |code| code.to_string())
                        ),
                    );
                    failure = Some(code.unwrap_or(LAUNCH_FAILED));
                    break;
                }
            }
            if helper.is_none() {
                match launch_helper(active) {
                    Ok(launched) => {
                        log::event("service", &format!("helper launched in session {active}"));
                        helper = Some(launched);
                    }
                    Err(error) => {
                        log::event("service", &format!("helper launch failed: {error}"));
                        failure = Some(LAUNCH_FAILED);
                        break;
                    }
                }
            }
        } else if let Some(running) = helper.take() {
            // The serviced session is no longer permitted: revoke now.
            let session = running.session;
            stop_helper(running, &format!("session {session} no longer permitted"));
        }

        // Poll backstop in case a session-change control was missed. A helper
        // still in its bootstrap wakes the loop by confirming its parent
        // watch (it serves nothing before its release, so it cannot ask for
        // SAS yet); a released helper wakes it with a SAS request.
        let mut handles = vec![event];
        if let Some(running) = helper.as_ref() {
            handles.push(if running.bootstrap.is_some() {
                running.channel.armed_handle()
            } else {
                running.channel.sas_handle()
            });
        }
        let woke = unsafe { WaitForMultipleObjects(&handles, false, POLL_INTERVAL.as_millis() as u32) };
        if LOCK_CHANGED.swap(false, Ordering::SeqCst) {
            if let Some(running) = helper.as_ref() {
                running.channel.notify_session_state();
            }
        }
        if woke.0 == WAIT_OBJECT_0.0 + 1 {
            let mut bootstrap_failed = false;
            if let Some(running) = helper.as_mut() {
                if let Some(job) = running.bootstrap.take() {
                    match running.channel.release_bootstrap(job) {
                        Ok(pending) => {
                            if pending.is_none() {
                                log::event(
                                    "service",
                                    &format!(
                                        "helper in session {} armed its parent watch; bootstrap job disarmed",
                                        running.session
                                    ),
                                );
                            }
                            running.bootstrap = pending;
                        }
                        Err(error) => {
                            // A failed disarm dropped the job still armed,
                            // terminating the helper through it; a failed
                            // release leaves it waiting, so it is stopped.
                            log::event("service", &format!("bootstrap release failed: {error}"));
                            bootstrap_failed = true;
                        }
                    }
                } else {
                    // One line per request: each is a user action under a grant.
                    match perform_sas(running.session) {
                        Ok(how) => log::event("service", &format!("Ctrl+Alt+Del in session {}: {how}", running.session)),
                        Err(error) => log::event("service", &format!("Ctrl+Alt+Del not sent: {error}")),
                    }
                }
            }
            if bootstrap_failed {
                if let Some(failed) = helper.take() {
                    stop_helper(failed, "bootstrap release failed");
                }
                failure = Some(LAUNCH_FAILED);
                break;
            }
        }
    }

    if let Some(running) = helper.take() {
        stop_helper(running, "service stopping");
    }
    failure
}
