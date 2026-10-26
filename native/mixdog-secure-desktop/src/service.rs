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
//! The helper follows the input desktop (Default <-> Winlogon) on its own, so
//! the service reacts only to *session* changes (fast path via
//! `SERVICE_CONTROL_SESSIONCHANGE`, plus a one-second poll as a backstop).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
use windows::Win32::System::Services::{
    RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW, SERVICE_ACCEPT_SESSIONCHANGE,
    SERVICE_ACCEPT_STOP, SERVICE_CONTROL_SESSIONCHANGE, SERVICE_CONTROL_STOP, SERVICE_RUNNING,
    SERVICE_STATUS, SERVICE_STATUS_CURRENT_STATE, SERVICE_STATUS_HANDLE, SERVICE_STOPPED,
    SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetExitCodeProcess, SetEvent, TerminateProcess, WaitForSingleObject,
};

use crate::helper::SHUTDOWN_DEADLINE;
use crate::launch::{self, DESKTOP_DEFAULT};
use crate::security::{generate_shutdown_token, InstallState};
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
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
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
    _event_type: u32,
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
            // A console connect/disconnect: re-evaluate which session to serve.
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
    set_status(SERVICE_START_PENDING, 0, 3000);

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

    monitor_loop(event, installing_sid.as_deref());

    set_status(SERVICE_STOPPED, 0, 0);
    log::event("service", "stopped");
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

/// One running helper: its process, the console session it serves, and the
/// service's end of its shutdown channel.
struct Helper {
    process: OwnedHandle,
    session: u32,
    channel: ServiceEnd,
}

/// Launch a helper into `session` with a fresh shutdown channel. The events are
/// created before the process so the helper can always open them.
fn launch_helper(session: u32) -> Result<Helper, String> {
    let token = generate_shutdown_token();
    let channel = ServiceEnd::create(&token).map_err(|error| format!("shutdown channel: {error}"))?;
    let process = launch::launch_in_session(session, DESKTOP_DEFAULT, &["helper", &token])
        .map_err(|error| error.to_string())?;
    Ok(Helper { process, session, channel })
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
    // Dropping `helper` closes the process handle and both events.
}

/// Keep one helper alive in the active console session — but only while that
/// session is permitted by the policy — until stop. When the console switches
/// to a session that is not permitted (e.g. a different user after a fast user
/// switch), any running helper is stopped, revoking capture and control. Every
/// stop — revoke, relaunch into a new session, service stop — goes through
/// [`stop_helper`]: graceful first, force-kill only after the deadline.
fn monitor_loop(event: HANDLE, installing_sid: Option<&str>) {
    let mut helper: Option<Helper> = None;

    while !STOP.load(Ordering::SeqCst) {
        let active = unsafe { WTSGetActiveConsoleSessionId() };
        let has_session = active != NO_ACTIVE_SESSION && active != 0;
        let allowed = has_session
            && installing_sid.is_some_and(|sid| session_allowed(active, sid));

        if allowed {
            let needs_launch = match helper.as_ref() {
                None => true,
                Some(running) => running.session != active || !process_alive(&running.process),
            };
            if needs_launch {
                if let Some(previous) = helper.take() {
                    stop_helper(previous, "relaunching for the active console session");
                }
                match launch_helper(active) {
                    Ok(launched) => {
                        log::event("service", &format!("helper launched in session {active}"));
                        helper = Some(launched);
                    }
                    Err(error) => {
                        log::event("service", &format!("helper launch failed: {error}"));
                    }
                }
            }
        } else if let Some(running) = helper.take() {
            // The serviced session is no longer permitted: revoke now.
            let session = running.session;
            stop_helper(running, &format!("session {session} no longer permitted"));
        }

        // Poll backstop in case a session-change control was missed.
        unsafe {
            WaitForSingleObject(event, POLL_INTERVAL.as_millis() as u32);
        }
    }

    if let Some(running) = helper.take() {
        stop_helper(running, "service stopping");
    }
}
