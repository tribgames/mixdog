//! The service <-> helper graceful-shutdown channel.
//!
//! Each helper launch gets a pair of named, manual-reset events built from a
//! fresh unguessable token ([`crate::paths::shutdown_event_names`]): the service
//! signals **stop**; the helper, after it has released every pointer button and
//! key it holds, signals **ack** and exits. Both objects carry a protected
//! SYSTEM-only DACL ([`crate::security::SHUTDOWN_EVENT_SDDL`]), so no user
//! process can forge a stop or an acknowledgement, and the service refuses a
//! name that already exists, so nothing can pre-create (squat) the pair.
//!
//! The helper waits on the stop event in every blocking step it takes (pipe
//! accept, its loop sleep, a final linger), so it reacts within one loop
//! iteration. The service still bounds the whole exchange by the helper's
//! documented deadline ([`crate::helper::SHUTDOWN_DEADLINE`]) and only then
//! force-kills.
//!
//! The same channel carries three more signals:
//!
//! - **Session lock state** (service → helper): a SYSTEM-only, auto-reset
//!   event, `Global\MixdogSecureDesktop-session-<token>`, which the service
//!   sets when the SCM delivers `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK` for
//!   the helper's session (`SERVICE_CONTROL_SESSIONCHANGE`,
//!   https://learn.microsoft.com/windows/win32/api/winsvc/nc-winsvc-lphandler_function_ex).
//!   The helper re-reads the lock flag from WTS only then, instead of polling.
//! - **SAS request** (helper → service): a third SYSTEM-only, auto-reset event,
//!   `Global\MixdogSecureDesktop-sas-<token>`, which the helper sets when an
//!   authorized client asks for Ctrl+Alt+Del. `SendSAS` must run in a service
//!   (or a signed uiAccess app), so the helper cannot press it itself
//!   (https://learn.microsoft.com/windows/win32/api/sas/nf-sas-sendsas).
//! - **Service death** (parent watch): the helper also waits on a handle to
//!   the service process **that launched it**, in every wait that watches the
//!   stop event. A service that dies without signalling stop — a crash, or a
//!   `TerminateProcess` — therefore ends the helper the same graceful way, so
//!   an orphaned helper never keeps holding the pipe or locking the exe. A
//!   process handle is signalled when the process exits
//!   (https://learn.microsoft.com/windows/win32/sync/synchronization-objects).
//!
//!   The handle is bound to the launching **kernel object**, never looked up
//!   by process id. The service creates the helper suspended
//!   (`CREATE_SUSPENDED`: the primary thread "does not run until the
//!   ResumeThread function is called",
//!   https://learn.microsoft.com/windows/win32/procthread/process-creation-flags),
//!   duplicates a handle to **its own process** straight into the helper
//!   (`DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), helper, …,
//!   SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0)`; "the
//!   duplicate handle refers to the same object as the original handle",
//!   https://learn.microsoft.com/windows/win32/api/handleapi/nf-handleapi-duplicatehandle),
//!   writes the handle's value into the per-launch parent section
//!   ([`parent_section_name`]), and only then resumes the helper. Any failure
//!   in between terminates the never-run helper. The process handle
//!   `CreateProcessAsUser` returns has `PROCESS_ALL_ACCESS`, which includes
//!   the `PROCESS_DUP_HANDLE` the target of a duplication needs
//!   (https://learn.microsoft.com/windows/win32/procthread/process-security-and-access-rights).
//!   Neither page restricts duplicating into a process of another session.
//!
//!   Why a section carries the value: the command line is fixed when the
//!   process is created, before a handle can be duplicated into it, and the
//!   pipe hello comes from the user-mode app, not the service. `DuplicateHandle`
//!   leaves passing the value to "some form of interprocess communication (for
//!   example, a named pipe or shared memory)"; the section is that, with the
//!   same protected SYSTEM-only DACL and squat refusal as the events.
//!
//!   The rights are `SYNCHRONIZE` (wait for the exit) and
//!   `PROCESS_QUERY_LIMITED_INFORMATION`, which `GetProcessId` requires
//!   (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessid):
//!   the helper refuses a value that is not a process handle, or names a
//!   process other than the one the service recorded ([`launching_service`]).
//!   The id is only compared with the handle's **own** object, never used to
//!   open anything. No `PROCESS_DUP_HANDLE`, so the helper cannot turn the
//!   handle into wider access to the service (the escalation that page warns
//!   about). (An inherited handle is not possible here: `CreateProcessAsUser`
//!   says "You cannot inherit handles across sessions",
//!   https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw.)
//! - **Bootstrap release** (helper ↔ service): the helper is created inside a
//!   kill-on-close job ([`crate::launch::BootstrapJob`]), so a service that
//!   dies while the helper is still suspended — before the parent watch
//!   exists — takes the helper with it. Two more SYSTEM-only, manual-reset
//!   events end that phase: the helper sets
//!   `Global\MixdogSecureDesktop-armed-<token>` once it holds the verified
//!   parent handle, and waits — on that, stop, and the parent watch — for
//!   `Global\MixdogSecureDesktop-released-<token>` before it creates its pipe.
//!   The service disarms the job only after `armed`, and sets `released` only
//!   after the disarm ([`release_after_confirmation`]). So the helper serves
//!   nothing — no pipe, no client, no input — while a job kill could still
//!   end it, and from the release on, the service's death ends it through the
//!   graceful parent watch instead. Neither side waits with a timeout: each
//!   wait also watches the other side's stop or exit.

use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    DuplicateHandle, GetLastError, DUPLICATE_HANDLE_OPTIONS, ERROR_ALREADY_EXISTS, E_ACCESSDENIED,
    HANDLE, WAIT_OBJECT_0,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetCurrentProcessId, GetProcessId, OpenEventW, SetEvent,
    WaitForMultipleObjects, WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, SYNCHRONIZATION_SYNCHRONIZE,
};

use crate::launch::BootstrapJob;
use crate::paths::shutdown_event_names;
use crate::security::SHUTDOWN_EVENT_SDDL;
use crate::winutil::{wide, OwnedHandle, SecurityDescriptor};

fn millis(duration: Duration) -> u32 {
    duration.as_millis().min(u32::MAX as u128 - 1) as u32
}

/// Kernel-object name of one helper's SAS-request event, from its launch token.
pub fn sas_event_name(token: &str) -> String {
    format!(r"Global\MixdogSecureDesktop-sas-{token}")
}

/// Kernel-object name of one helper's session-lock-change event.
pub fn session_event_name(token: &str) -> String {
    format!(r"Global\MixdogSecureDesktop-session-{token}")
}

/// Kernel-object name of one helper's parent section, which carries the
/// value of the launching service's process handle in the helper.
pub fn parent_section_name(token: &str) -> String {
    format!(r"Global\MixdogSecureDesktop-parent-{token}")
}

/// Kernel-object name of the event a helper sets once its parent watch is
/// armed.
pub fn armed_event_name(token: &str) -> String {
    format!(r"Global\MixdogSecureDesktop-armed-{token}")
}

/// Kernel-object name of the event the service sets once it has disarmed the
/// helper's bootstrap job.
pub fn released_event_name(token: &str) -> String {
    format!(r"Global\MixdogSecureDesktop-released-{token}")
}

/// Disarm `job` and set `released` — but only once the helper has confirmed
/// its parent watch by setting `armed`. Before that the job is handed back
/// untouched (still armed). `released` is set only after the disarm
/// succeeded; a failed disarm drops the job armed, which terminates the
/// helper ([`BootstrapJob::disarm`]).
pub fn release_after_confirmation(
    armed: HANDLE,
    released: HANDLE,
    job: BootstrapJob,
) -> windows::core::Result<Option<BootstrapJob>> {
    if unsafe { WaitForSingleObject(armed, 0) } != WAIT_OBJECT_0 {
        return Ok(Some(job));
    }
    job.disarm()?;
    unsafe { SetEvent(released) }?;
    Ok(None)
}

mod mapping {
    // The four kernel32 section calls the parent hand-over needs, imported
    // directly; the crate does not enable the `Win32_System_Memory` feature.
    windows::core::link!("kernel32.dll" "system" fn CreateFileMappingW(file: *mut core::ffi::c_void, attributes: *const core::ffi::c_void, protect: u32, size_high: u32, size_low: u32, name: windows::core::PCWSTR) -> *mut core::ffi::c_void);
    windows::core::link!("kernel32.dll" "system" fn OpenFileMappingW(access: u32, inherit: i32, name: windows::core::PCWSTR) -> *mut core::ffi::c_void);
    windows::core::link!("kernel32.dll" "system" fn MapViewOfFile(mapping: *mut core::ffi::c_void, access: u32, offset_high: u32, offset_low: u32, bytes: usize) -> *mut core::ffi::c_void);
    windows::core::link!("kernel32.dll" "system" fn UnmapViewOfFile(base: *const core::ffi::c_void) -> i32);
}

const PAGE_READWRITE: u32 = 0x04;
const FILE_MAP_WRITE: u32 = 0x02;
const FILE_MAP_READ: u32 = 0x04;

/// Size of the parent record: the handle value (u64 LE) and the service's
/// process id (u32 LE), padded to 16 bytes.
pub const PARENT_RECORD_BYTES: usize = 16;

/// The parent record for a handle value `handle` in the helper, naming the
/// process `pid`.
pub fn encode_parent(handle: u64, pid: u32) -> [u8; PARENT_RECORD_BYTES] {
    let mut record = [0u8; PARENT_RECORD_BYTES];
    record[..8].copy_from_slice(&handle.to_le_bytes());
    record[8..12].copy_from_slice(&pid.to_le_bytes());
    record
}

/// `(handle value, pid)` from a parent record; `None` for a short record or
/// a zero handle or id (an unwritten section).
pub fn decode_parent(record: &[u8]) -> Option<(u64, u32)> {
    let handle = u64::from_le_bytes(record.get(..8)?.try_into().ok()?);
    let pid = u32::from_le_bytes(record.get(8..12)?.try_into().ok()?);
    (handle != 0 && pid != 0).then_some((handle, pid))
}

/// Map `bytes` of `section` with `access` and run `f` on the view.
fn with_view<R>(
    section: HANDLE,
    access: u32,
    bytes: usize,
    f: impl FnOnce(*mut u8) -> R,
) -> windows::core::Result<R> {
    let view = unsafe { mapping::MapViewOfFile(section.0, access, 0, 0, bytes) };
    if view.is_null() {
        return Err(windows::core::Error::from_thread());
    }
    let result = f(view as *mut u8);
    unsafe {
        mapping::UnmapViewOfFile(view);
    }
    Ok(result)
}

/// Duplicate a handle to this process into `helper` with exactly
/// `SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION`, not inheritable.
/// Returns the parent record naming it.
pub fn duplicate_parent(helper: HANDLE) -> windows::core::Result<[u8; PARENT_RECORD_BYTES]> {
    let mut target = HANDLE::default();
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetCurrentProcess(),
            helper,
            &mut target,
            (PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION).0,
            false,
            DUPLICATE_HANDLE_OPTIONS(0),
        )?;
    }
    Ok(encode_parent(target.0 as usize as u64, unsafe {
        GetCurrentProcessId()
    }))
}

/// Accept `handle` (a value in this process) as the launching service's
/// process handle only if it is a process handle whose own process id is the
/// recorded `pid` (`GetProcessId` fails on anything else). A refused value is
/// not closed: this process does not own a handle it could not verify.
pub fn launching_service(handle: u64, pid: u32) -> windows::core::Result<OwnedHandle> {
    let raw = HANDLE(handle as usize as *mut core::ffi::c_void);
    let actual = unsafe { GetProcessId(raw) };
    if actual == 0 {
        return Err(windows::core::Error::new(
            E_ACCESSDENIED,
            "the parent handle is not a queryable process handle",
        ));
    }
    if actual != pid {
        return Err(windows::core::Error::new(
            E_ACCESSDENIED,
            "the parent handle names another process",
        ));
    }
    OwnedHandle::new(raw).ok_or_else(windows::core::Error::from_thread)
}

/// The service's end: owns every event for one helper launch, and the parent
/// section.
pub struct ServiceEnd {
    stop: OwnedHandle,
    ack: OwnedHandle,
    sas: OwnedHandle,
    session: OwnedHandle,
    parent: OwnedHandle,
    armed: OwnedHandle,
    released: OwnedHandle,
}

/// Create the fresh, SYSTEM-only parent section, refusing an existing name.
/// The service runs in session 0, so creating it in the global namespace
/// needs no `SeCreateGlobalPrivilege`
/// (https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createfilemappingw).
fn create_section(
    name: &str,
    descriptor: &SecurityDescriptor,
) -> windows::core::Result<OwnedHandle> {
    let attributes = descriptor.attributes();
    let wname = wide(name);
    let invalid = -1isize as *mut core::ffi::c_void; // INVALID_HANDLE_VALUE: backed by the paging file
    let raw = unsafe {
        mapping::CreateFileMappingW(
            invalid,
            &attributes as *const _ as *const core::ffi::c_void,
            PAGE_READWRITE,
            0,
            PARENT_RECORD_BYTES as u32,
            PCWSTR(wname.as_ptr()),
        )
    };
    let already_existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let owned = OwnedHandle::new(HANDLE(raw)).ok_or_else(windows::core::Error::from_thread)?;
    if already_existed {
        return Err(ERROR_ALREADY_EXISTS.to_hresult().into());
    }
    Ok(owned)
}

/// Read the parent record from the section named for `token`.
fn read_parent(token: &str) -> windows::core::Result<[u8; PARENT_RECORD_BYTES]> {
    let wname = wide(&parent_section_name(token));
    let raw = unsafe { mapping::OpenFileMappingW(FILE_MAP_READ, 0, PCWSTR(wname.as_ptr())) };
    let section = OwnedHandle::new(HANDLE(raw)).ok_or_else(windows::core::Error::from_thread)?;
    with_view(section.get(), FILE_MAP_READ, PARENT_RECORD_BYTES, |view| {
        let mut record = [0u8; PARENT_RECORD_BYTES];
        unsafe { std::ptr::copy_nonoverlapping(view, record.as_mut_ptr(), PARENT_RECORD_BYTES) };
        record
    })
}

/// Create one fresh, SYSTEM-only named event, refusing a name that already
/// exists (an existing object could have been created by someone else).
fn create_event(
    name: &str,
    descriptor: &SecurityDescriptor,
    manual_reset: bool,
) -> windows::core::Result<OwnedHandle> {
    let attributes = descriptor.attributes();
    let wname = wide(name);
    let handle = unsafe {
        CreateEventW(
            Some(&attributes as *const _),
            manual_reset,
            false,
            PCWSTR(wname.as_ptr()),
        )
    }?;
    let already_existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let owned = OwnedHandle::new(handle).ok_or_else(windows::core::Error::from_thread)?;
    if already_existed {
        return Err(ERROR_ALREADY_EXISTS.to_hresult().into());
    }
    Ok(owned)
}

impl ServiceEnd {
    /// Create the event pair for `token` before the helper is launched.
    pub fn create(token: &str) -> windows::core::Result<Self> {
        let descriptor = SecurityDescriptor::from_sddl(SHUTDOWN_EVENT_SDDL)?;
        let (stop, ack) = shutdown_event_names(token);
        Ok(ServiceEnd {
            stop: create_event(&stop, &descriptor, true)?,
            ack: create_event(&ack, &descriptor, true)?,
            // Auto-reset: each wake of the service consumes one request.
            sas: create_event(&sas_event_name(token), &descriptor, false)?,
            session: create_event(&session_event_name(token), &descriptor, false)?,
            parent: create_section(&parent_section_name(token), &descriptor)?,
            // Manual-reset: each is set once per launch and stays set.
            armed: create_event(&armed_event_name(token), &descriptor, true)?,
            released: create_event(&released_event_name(token), &descriptor, true)?,
        })
    }

    /// The helper's parent-watch confirmation, for the service's monitor wait
    /// while the bootstrap job is armed.
    pub fn armed_handle(&self) -> HANDLE {
        self.armed.get()
    }

    /// Disarm the helper's bootstrap `job` and let it serve, once — and only
    /// once — it has confirmed its parent watch
    /// ([`release_after_confirmation`]). Returns the job, still armed, when the
    /// confirmation has not arrived.
    pub fn release_bootstrap(
        &self,
        job: BootstrapJob,
    ) -> windows::core::Result<Option<BootstrapJob>> {
        release_after_confirmation(self.armed.get(), self.released.get(), job)
    }

    /// Give the suspended `helper` its parent watch: duplicate this process's
    /// handle into it and record the value in the parent section. Called
    /// between the suspended creation and `ResumeThread`.
    pub fn hand_over_parent(&self, helper: HANDLE) -> windows::core::Result<()> {
        let record = duplicate_parent(helper)?;
        with_view(
            self.parent.get(),
            FILE_MAP_WRITE,
            PARENT_RECORD_BYTES,
            |view| unsafe {
                std::ptr::copy_nonoverlapping(record.as_ptr(), view, PARENT_RECORD_BYTES)
            },
        )
    }

    /// Tell the helper its session was locked or unlocked.
    pub fn notify_session_state(&self) {
        unsafe {
            let _ = SetEvent(self.session.get());
        }
    }

    /// The helper's SAS-request event, for the service's monitor wait.
    pub fn sas_handle(&self) -> HANDLE {
        self.sas.get()
    }

    /// Ask the helper to release everything it holds and exit.
    pub fn request_stop(&self) {
        unsafe {
            let _ = SetEvent(self.stop.get());
        }
    }

    /// Wait until the helper acknowledges or `process` exits (whichever comes
    /// first), then until `process` exits — all bounded by `deadline`, waking
    /// every `slice` to call `progress` (the SCM checkpoint). Returns whether
    /// the helper acknowledged, and whether the process has exited.
    pub fn wait_for_exit(
        &self,
        process: HANDLE,
        deadline: Instant,
        slice: Duration,
        mut progress: impl FnMut(),
    ) -> (bool, bool) {
        let mut acked = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = millis(remaining.min(slice));
            if !acked {
                let handles = [self.ack.get(), process];
                let result = unsafe { WaitForMultipleObjects(&handles, false, wait) };
                if result == WAIT_OBJECT_0 {
                    acked = true;
                    continue;
                }
                if result.0 == WAIT_OBJECT_0.0 + 1 {
                    // Exited without acknowledging (e.g. it crashed before it
                    // could release). The caller logs it; nothing is left to kill.
                    return (false, true);
                }
            } else if unsafe { WaitForSingleObject(process, wait) } == WAIT_OBJECT_0 {
                return (true, true);
            }
            if remaining.is_zero() {
                return (acked, false);
            }
            progress();
        }
    }
}

/// The helper's end: waits on stop (and on the service's exit), signals ack,
/// and raises SAS requests.
pub struct HelperEnd {
    stop: OwnedHandle,
    ack: OwnedHandle,
    sas: OwnedHandle,
    session: OwnedHandle,
    service: OwnedHandle,
    armed: OwnedHandle,
    released: OwnedHandle,
}

impl HelperEnd {
    /// Open the events the service created for `token`, and take the
    /// launching service's process handle the service duplicated into this
    /// process (its value read from the parent section) for the parent watch.
    pub fn open(token: &str) -> windows::core::Result<Self> {
        let record = read_parent(token)?;
        let (handle, pid) = decode_parent(&record).ok_or_else(|| {
            windows::core::Error::new(E_ACCESSDENIED, "the parent section was never written")
        })?;
        let (stop, ack) = shutdown_event_names(token);
        let open = |name: &str, access| -> windows::core::Result<OwnedHandle> {
            let wname = wide(name);
            let handle = unsafe { OpenEventW(access, false, PCWSTR(wname.as_ptr())) }?;
            OwnedHandle::new(handle).ok_or_else(windows::core::Error::from_thread)
        };
        Ok(HelperEnd {
            stop: open(&stop, SYNCHRONIZATION_SYNCHRONIZE)?,
            ack: open(&ack, EVENT_MODIFY_STATE)?,
            sas: open(&sas_event_name(token), EVENT_MODIFY_STATE)?,
            session: open(&session_event_name(token), SYNCHRONIZATION_SYNCHRONIZE)?,
            armed: open(&armed_event_name(token), EVENT_MODIFY_STATE)?,
            released: open(&released_event_name(token), SYNCHRONIZATION_SYNCHRONIZE)?,
            service: launching_service(handle, pid)?,
        })
    }

    /// Tell the service the parent watch is armed (this end holds the verified
    /// handle to the launching service), then wait until the service has
    /// disarmed the bootstrap job. Returns false — serve nothing — if stop is
    /// signalled or the service exits first, or the confirmation cannot be
    /// sent.
    pub fn confirm_parent_watch(&self) -> bool {
        if unsafe { SetEvent(self.armed.get()) }.is_err() {
            return false;
        }
        let handles = [self.released.get(), self.stop.get(), self.service.get()];
        unsafe { WaitForMultipleObjects(&handles, false, INFINITE) == WAIT_OBJECT_0 }
    }

    /// Whether the service relayed a lock / unlock of this session since the
    /// last call (consumes the auto-reset event).
    pub fn session_state_changed(&self) -> bool {
        unsafe { WaitForSingleObject(self.session.get(), 0) == WAIT_OBJECT_0 }
    }

    /// The handles whose signal means "stop": the stop event and the service
    /// process (signalled when it exits). For waits that must also wake on
    /// shutdown.
    pub fn stop_handles(&self) -> [HANDLE; 2] {
        [self.stop.get(), self.service.get()]
    }

    /// Whether the service has asked the helper to stop, or is gone.
    pub fn stop_requested(&self) -> bool {
        self.wait_stop(Duration::ZERO)
    }

    /// Whether the service process has exited (the parent watch fired).
    pub fn service_gone(&self) -> bool {
        unsafe { WaitForSingleObject(self.service.get(), 0) == WAIT_OBJECT_0 }
    }

    /// Sleep up to `timeout`, returning early (true) if stop is signalled or
    /// the service exits.
    pub fn wait_stop(&self, timeout: Duration) -> bool {
        let handles = self.stop_handles();
        let woke = unsafe { WaitForMultipleObjects(&handles, false, millis(timeout)) };
        woke == WAIT_OBJECT_0 || woke.0 == WAIT_OBJECT_0.0 + 1
    }

    /// Ask the service to press the secure attention sequence.
    pub fn request_sas(&self) {
        unsafe {
            let _ = SetEvent(self.sas.get());
        }
    }

    /// Tell the service every held input has been released and the helper is
    /// exiting. Called only after `release_all`.
    pub fn acknowledge(&self) {
        unsafe {
            let _ = SetEvent(self.ack.get());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parent_record_round_trips_and_an_unwritten_or_short_one_is_refused() {
        let record = encode_parent(0x1a4, 4242);
        assert_eq!(decode_parent(&record), Some((0x1a4, 4242)));
        assert_eq!(
            decode_parent(&[0u8; PARENT_RECORD_BYTES]),
            None,
            "an unwritten section"
        );
        assert_eq!(decode_parent(&encode_parent(0, 4242)), None, "no handle");
        assert_eq!(
            decode_parent(&encode_parent(0x1a4, 0)),
            None,
            "no process id"
        );
        assert_eq!(decode_parent(&record[..11]), None, "short");
    }

    /// A duplicate of this process's handle into itself, with `access`.
    fn own_process_handle(access: u32) -> HANDLE {
        let mut target = HANDLE::default();
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                GetCurrentProcess(),
                GetCurrentProcess(),
                &mut target,
                access,
                false,
                DUPLICATE_HANDLE_OPTIONS(0),
            )
            .unwrap();
        }
        target
    }

    #[test]
    fn the_duplicated_parent_handle_is_accepted_and_waits_on_the_service() {
        // The "helper" here is this process itself; the record names it.
        let record = duplicate_parent(unsafe { GetCurrentProcess() }).unwrap();
        let (handle, pid) = decode_parent(&record).unwrap();
        assert_eq!(pid, unsafe { GetCurrentProcessId() });
        let service = launching_service(handle, pid).unwrap();
        // A live process is not signalled.
        assert_ne!(
            unsafe { WaitForSingleObject(service.get(), 0) },
            WAIT_OBJECT_0
        );
    }

    fn unnamed_event() -> OwnedHandle {
        OwnedHandle::new(unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.unwrap())
            .unwrap()
    }

    #[test]
    fn the_bootstrap_job_is_disarmed_only_after_the_helper_confirms_its_parent_watch() {
        let (armed, released) = (unnamed_event(), unnamed_event());
        let (process, job) =
            crate::launch::start_stand_in(BootstrapJob::new().unwrap(), |_| Ok(())).unwrap();

        // No confirmation yet: the job comes back still armed, and the helper
        // is not released.
        let job = release_after_confirmation(armed.get(), released.get(), job)
            .unwrap()
            .expect("not confirmed");
        assert!(job.kills_on_close().unwrap());
        assert_ne!(
            unsafe { WaitForSingleObject(released.get(), 0) },
            WAIT_OBJECT_0
        );

        // The helper confirms: the job is disarmed (and its handle closed),
        // then the helper is released.
        unsafe { SetEvent(armed.get()) }.unwrap();
        assert!(release_after_confirmation(armed.get(), released.get(), job)
            .unwrap()
            .is_none());
        assert_eq!(
            unsafe { WaitForSingleObject(released.get(), 0) },
            WAIT_OBJECT_0
        );

        // Closing the disarmed job did not end the process: the test's own
        // termination code is the one it exits with.
        const OURS: u32 = 0x5EC;
        unsafe { windows::Win32::System::Threading::TerminateProcess(process.get(), OURS) }
            .unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(process.get(), INFINITE) },
            WAIT_OBJECT_0
        );
        let mut code = 0u32;
        unsafe { windows::Win32::System::Threading::GetExitCodeProcess(process.get(), &mut code) }
            .unwrap();
        assert_eq!(code, OURS);
    }

    #[test]
    fn a_value_that_is_not_the_recorded_process_handle_is_refused() {
        let own = unsafe { GetCurrentProcessId() };
        // An event, not a process.
        let event =
            OwnedHandle::new(unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.unwrap())
                .unwrap();
        assert!(launching_service(event.get().0 as usize as u64, own).is_err());
        // A process handle, but to a process other than the recorded one.
        let process = OwnedHandle::new(own_process_handle(
            (PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION).0,
        ))
        .unwrap();
        assert!(launching_service(process.get().0 as usize as u64, own.wrapping_add(4)).is_err());
        // A process handle without the query right cannot prove which process it is.
        let bare = OwnedHandle::new(own_process_handle(PROCESS_SYNCHRONIZE.0)).unwrap();
        assert!(launching_service(bare.get().0 as usize as u64, own).is_err());
        // Refusals did not close the handles they were shown.
        assert_ne!(
            unsafe { WaitForSingleObject(process.get(), 0) },
            windows::Win32::Foundation::WAIT_FAILED
        );
        assert_ne!(
            unsafe { WaitForSingleObject(event.get(), 0) },
            windows::Win32::Foundation::WAIT_FAILED
        );
    }
}
