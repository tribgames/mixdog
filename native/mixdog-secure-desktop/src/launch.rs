//! Launch the session helper as SYSTEM inside the active console session, on a
//! chosen desktop.
//!
//! The service runs as LocalSystem. To put a SYSTEM process in the interactive
//! session it duplicates its own token into a primary token, retargets that
//! duplicate's session id to the active console session, and calls
//! `CreateProcessAsUserW` with `lpDesktop = "winsta0\default"`. Running the
//! helper as SYSTEM (rather than the logged-in user) is deliberate: only a
//! SYSTEM process in the console session may attach to the `Winlogon` desktop,
//! which is the whole point of capturing UAC and the lock screen. The privilege
//! enables are the ones `CreateProcessAsUser` with a session-retargeted token
//! requires; LocalSystem holds them, so enabling only switches them on.
//!
//! The helper's token is SYSTEM, but **not** all of SYSTEM's privileges: every
//! privilege except [`HELPER_KEPT_PRIVILEGES`] is removed from the duplicate
//! before the process is created (`AdjustTokenPrivileges` with
//! `SE_PRIVILEGE_REMOVED`, which takes a privilege out of the token for good:
//! https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-adjusttokenprivileges).
//! The helper needs SYSTEM's *identity* (the `Winlogon` desktop's DACL admits
//! SYSTEM), not its privileges; a token without `SeTcbPrivilege`,
//! `SeDebugPrivilege`, `SeAssignPrimaryTokenPrivilege`, backup/restore,
//! take-ownership, driver loading and the rest cannot be turned into a
//! general-purpose SYSTEM foothold if the pipe-facing code is ever subverted.
//!
//! **Bootstrap job.** The helper is created inside a fresh kill-on-close job
//! ([`BootstrapJob`]) that is assigned at creation — it is the
//! `PROC_THREAD_ATTRIBUTE_JOB_LIST` of the `STARTUPINFOEX` — so from the
//! instant the helper exists until the service disarms the job, the helper
//! lives only as long as the service's job handle. The service holds the only
//! one, and "open handles to kernel objects are closed automatically when a
//! process terminates"
//! (https://learn.microsoft.com/windows/win32/procthread/terminating-a-process):
//! a service that dies at any point of the suspended launch takes the helper
//! with it. The job is disarmed only after the running helper has confirmed
//! its parent watch ([`crate::shutdown`]); from then on the parent watch ends
//! the helper gracefully instead.

use std::os::windows::ffi::OsStrExt;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, GetTokenInformation, LookupPrivilegeNameW,
    LookupPrivilegeValueW, SecurityImpersonation, SetTokenInformation, TokenPrimary,
    TokenPrivileges, TokenSessionId, LUID_AND_ATTRIBUTES, SE_ASSIGNPRIMARYTOKEN_NAME,
    SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED, SE_PRIVILEGE_REMOVED, SE_TCB_NAME,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ALL_ACCESS,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_TYPE,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, UpdateProcThreadAttribute,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTUPINFOEXW, STARTUPINFOW,
};

use crate::winutil::OwnedHandle;

/// The ordinary interactive desktop.
pub const DESKTOP_DEFAULT: &str = r"winsta0\default";

mod jobs {
    // The job-object calls the bootstrap job needs, imported directly; the
    // crate does not enable the `Win32_System_JobObjects` feature.
    windows::core::link!("kernel32.dll" "system" fn CreateJobObjectW(attributes: *const core::ffi::c_void, name: windows::core::PCWSTR) -> *mut core::ffi::c_void);
    windows::core::link!("kernel32.dll" "system" fn QueryInformationJobObject(job: *mut core::ffi::c_void, class: i32, information: *mut core::ffi::c_void, length: u32, returned: *mut u32) -> i32);
    windows::core::link!("kernel32.dll" "system" fn SetInformationJobObject(job: *mut core::ffi::c_void, class: i32, information: *const core::ffi::c_void, length: u32) -> i32);
    #[cfg(test)]
    windows::core::link!("kernel32.dll" "system" fn IsProcessInJob(process: *mut core::ffi::c_void, job: *mut core::ffi::c_void, result: *mut i32) -> i32);
}

/// `JobObjectExtendedLimitInformation`, the information class of a
/// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`
/// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject).
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: "Causes all processes associated with
/// the job to terminate when the last handle to the job is closed"; it
/// "requires use of a JOBOBJECT_EXTENDED_LIMIT_INFORMATION structure"
/// (https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

/// `JOBOBJECT_BASIC_LIMIT_INFORMATION` (winnt.h). Only `LimitFlags` is used;
/// "all limits are inactive" in a new job
/// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw).
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct BasicLimits {
    _per_process_user_time_limit: i64,
    _per_job_user_time_limit: i64,
    limit_flags: u32,
    _minimum_working_set_size: usize,
    _maximum_working_set_size: usize,
    _active_process_limit: u32,
    _affinity: usize,
    _priority_class: u32,
    _scheduling_class: u32,
}

/// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` (winnt.h); its `IO_COUNTERS` is six
/// `ULONGLONG` counters.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    _io: [u64; 6],
    _process_memory_limit: usize,
    _job_memory_limit: usize,
    _peak_process_memory_used: usize,
    _peak_job_memory_used: usize,
}

fn query_limits(job: HANDLE) -> windows::core::Result<ExtendedLimits> {
    let mut limits = ExtendedLimits::default();
    let ok = unsafe {
        jobs::QueryInformationJobObject(
            job.0,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut limits as *mut ExtendedLimits as *mut core::ffi::c_void,
            std::mem::size_of::<ExtendedLimits>() as u32,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(windows::core::Error::from_thread());
    }
    Ok(limits)
}

fn set_limits(job: HANDLE, limits: &ExtendedLimits) -> windows::core::Result<()> {
    let ok = unsafe {
        jobs::SetInformationJobObject(
            job.0,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            limits as *const ExtendedLimits as *const core::ffi::c_void,
            std::mem::size_of::<ExtendedLimits>() as u32,
        )
    };
    if ok == 0 {
        return Err(windows::core::Error::from_thread());
    }
    Ok(())
}

/// A fresh kill-on-close job that holds one helper from its creation until
/// the service disarms it. This handle is the job's only one: `CreateJobObject`
/// without attributes gives a handle that "cannot be inherited"
/// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw),
/// and "only named job objects can be opened"
/// (https://learn.microsoft.com/windows/win32/procthread/job-objects). Dropping
/// it while armed — a failed launch, a failed disarm, or the service's own
/// death closing it — terminates the helper, suspended or not.
///
/// One job per launch: "All processes associated with a job must run in the
/// same session. A job is associated with the session of the first process to
/// be assigned to the job" (CreateJobObject, same page), and the helper is the
/// only process ever assigned, so a job created in session 0 holds a helper in
/// the console session.
pub struct BootstrapJob {
    job: OwnedHandle,
}

impl BootstrapJob {
    /// A new unnamed job whose only limit is kill-on-close.
    pub fn new() -> windows::core::Result<Self> {
        let raw = unsafe { jobs::CreateJobObjectW(std::ptr::null(), PCWSTR::null()) };
        let job = OwnedHandle::new(HANDLE(raw)).ok_or_else(windows::core::Error::from_thread)?;
        let limits = ExtendedLimits {
            basic: BasicLimits {
                limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        set_limits(job.get(), &limits)?;
        Ok(BootstrapJob { job })
    }

    fn handle(&self) -> HANDLE {
        self.job.get()
    }

    /// Whether closing the job would still terminate its processes.
    #[cfg(test)]
    pub fn kills_on_close(&self) -> windows::core::Result<bool> {
        Ok(
            query_limits(self.handle())?.basic.limit_flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                != 0,
        )
    }

    /// Clear kill-on-close and close the handle, leaving the helper running.
    /// The limits are changed the documented way — "call the
    /// QueryInformationJobObject function to obtain the current limits, modify
    /// these limits, and then call SetInformationJobObject"
    /// (https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject).
    /// The helper stays in the job — "the association cannot be broken"
    /// (https://learn.microsoft.com/windows/win32/procthread/job-objects) — but
    /// it is a job with no limits and no open handle, so nothing can act on the
    /// helper through it. On failure the job is dropped still armed, which
    /// terminates the helper.
    pub fn disarm(self) -> windows::core::Result<()> {
        let mut limits = query_limits(self.handle())?;
        limits.basic.limit_flags &= !JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        set_limits(self.handle(), &limits)
    }
}

/// A one-entry `PROC_THREAD_ATTRIBUTE_LIST`: `PROC_THREAD_ATTRIBUTE_JOB_LIST`,
/// "a list of job handles to be assigned to the child process", here just the
/// bootstrap job
/// (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
/// The value "must persist until the attribute list is destroyed using the
/// DeleteProcThreadAttributeList function", so the list owns it.
struct JobAttributeList {
    /// Pointer-aligned storage for the opaque list.
    list: Vec<usize>,
    /// The attribute's value: the job handle, at a stable address.
    jobs: Box<HANDLE>,
}

impl JobAttributeList {
    fn new(job: &BootstrapJob) -> windows::core::Result<Self> {
        // Sizing call: "First, call this function with the dwAttributeCount
        // parameter set to the maximum number of attributes you will be using
        // and the lpAttributeList to NULL"; it fails, reporting the size
        // (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-initializeprocthreadattributelist).
        let mut size = 0usize;
        let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
        if size == 0 {
            return Err(windows::core::Error::from_thread());
        }
        let mut list = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        unsafe {
            InitializeProcThreadAttributeList(
                Some(LPPROC_THREAD_ATTRIBUTE_LIST(
                    list.as_mut_ptr() as *mut core::ffi::c_void
                )),
                1,
                None,
                &mut size,
            )?;
        }
        // Initialized: from here on `Drop` deletes it.
        let built = JobAttributeList {
            list,
            jobs: Box::new(job.handle()),
        };
        unsafe {
            UpdateProcThreadAttribute(
                built.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(&*built.jobs as *const HANDLE as *const core::ffi::c_void),
                std::mem::size_of::<HANDLE>(),
                None,
                None,
            )?;
        }
        Ok(built)
    }

    fn raw(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.list.as_ptr() as *mut core::ffi::c_void)
    }
}

impl Drop for JobAttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.raw()) };
    }
}

/// The creation flags of a helper launch: no console, created suspended
/// (`CREATE_SUSPENDED`: the primary thread "does not run until the
/// ResumeThread function is called"), and `EXTENDED_STARTUPINFO_PRESENT`: "the
/// lpStartupInfo parameter specifies a STARTUPINFOEX structure"
/// (https://learn.microsoft.com/windows/win32/procthread/process-creation-flags),
/// which carries the job list.
const LAUNCH_FLAGS: PROCESS_CREATION_FLAGS = PROCESS_CREATION_FLAGS(
    CREATE_NO_WINDOW.0 | DETACHED_PROCESS.0 | CREATE_SUSPENDED.0 | EXTENDED_STARTUPINFO_PRESENT.0,
);

/// Create a process with `create` — handed a `STARTUPINFOEX` whose attribute
/// list assigns `job`, and [`LAUNCH_FLAGS`] — let `before_resume` prepare the
/// still-suspended process, then resume it. Returns the process handle and the
/// still-armed job. On any failure the job is dropped armed, so the process,
/// which never ran, is terminated through it.
fn start_in_job(
    job: BootstrapJob,
    desktop: PWSTR,
    create: impl FnOnce(
        &STARTUPINFOW,
        PROCESS_CREATION_FLAGS,
        &mut PROCESS_INFORMATION,
    ) -> windows::core::Result<()>,
    before_resume: impl FnOnce(HANDLE) -> windows::core::Result<()>,
) -> windows::core::Result<(OwnedHandle, BootstrapJob)> {
    let attributes = JobAttributeList::new(&job)?;
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
            lpDesktop: desktop,
            ..Default::default()
        },
        lpAttributeList: attributes.raw(),
    };
    let mut info = PROCESS_INFORMATION::default();
    create(&startup.StartupInfo, LAUNCH_FLAGS, &mut info)?;
    let thread = OwnedHandle::new(info.hThread);
    let process = OwnedHandle::new(info.hProcess).ok_or_else(windows::core::Error::from_thread)?;
    before_resume(process.get())?;
    let thread = thread.ok_or_else(windows::core::Error::from_thread)?;
    // `ResumeThread` returns `(DWORD)-1` on failure
    // (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread).
    if unsafe { ResumeThread(thread.get()) } == u32::MAX {
        return Err(windows::core::Error::from_thread());
    }
    Ok((process, job))
}

/// A stand-in for the helper in tests: `cmd.exe /c exit 0` started through
/// [`start_in_job`], given a second suspend count so the launch's
/// `ResumeThread` leaves it suspended — it never runs a single instruction.
#[cfg(test)]
pub(crate) fn start_stand_in(
    job: BootstrapJob,
    before_resume: impl FnOnce(HANDLE) -> windows::core::Result<()>,
) -> windows::core::Result<(OwnedHandle, BootstrapJob)> {
    use windows::Win32::System::Threading::{CreateProcessW, SuspendThread};
    let root = std::env::var("SystemRoot").map_err(|_| windows::core::Error::from_thread())?;
    let image = wide_z(&format!(r"{root}\System32\cmd.exe"));
    let mut command = wide_z("cmd.exe /c exit 0");
    start_in_job(
        job,
        PWSTR::null(),
        |startup, flags, info| unsafe {
            CreateProcessW(
                PCWSTR(image.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                false,
                flags,
                None,
                PCWSTR::null(),
                startup,
                info,
            )?;
            if SuspendThread(info.hThread) == u32::MAX {
                return Err(windows::core::Error::from_thread());
            }
            Ok(())
        },
        before_resume,
    )
}

fn wide_z(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn enable_privilege(token: HANDLE, name: PCWSTR) {
    unsafe {
        let mut luid = LUID::default();
        if LookupPrivilegeValueW(PCWSTR::null(), name, &mut luid).is_err() {
            return;
        }
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        // Best effort: LocalSystem already holds these; a failure here is not
        // fatal and the subsequent CreateProcessAsUser surfaces any real
        // shortfall.
        let _ = AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None);
    }
}

/// The only privileges the helper's token keeps:
///
/// - `SeChangeNotifyPrivilege` (bypass traverse checking): path lookups — the
///   state file, the log, its own image — go through directories the token may
///   not list.
/// - `SeImpersonatePrivilege`: `ImpersonateNamedPipeClient` gives an
///   impersonation-level token only to a caller holding it, and the
///   per-connection identity check reads the client's user from that token.
///
/// Everything else the helper does needs SYSTEM's identity, not a privilege:
/// opening and switching to the input desktop, `SendInput`, GDI capture,
/// creating its pipe, opening the service's events and parent section, and
/// querying WTS. Removing a privilege that some step still turns out to need
/// shows up on the hardware test as that step failing, never as a widened grant.
pub const HELPER_KEPT_PRIVILEGES: [&str; 2] = ["SeChangeNotifyPrivilege", "SeImpersonatePrivilege"];

/// Whether the helper's token keeps the privilege named `name`.
pub fn helper_keeps_privilege(name: &str) -> bool {
    HELPER_KEPT_PRIVILEGES
        .iter()
        .any(|kept| kept.eq_ignore_ascii_case(name))
}

/// The service's own (LocalSystem) token duplicated as `kind` (a primary token
/// for `CreateProcessAsUserW`, or an impersonation token for a thread) and
/// retargeted to `session_id`. Retargeting needs `SeTcbPrivilege`, which is
/// enabled on the process token first.
pub fn session_token(session_id: u32, kind: TOKEN_TYPE) -> windows::core::Result<OwnedHandle> {
    unsafe {
        let mut raw_token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID
                | TOKEN_ADJUST_PRIVILEGES,
            &mut raw_token,
        )?;
        let token = OwnedHandle::new(raw_token).ok_or_else(windows::core::Error::from_thread)?;

        enable_privilege(token.get(), SE_TCB_NAME);
        enable_privilege(token.get(), SE_ASSIGNPRIMARYTOKEN_NAME);
        enable_privilege(token.get(), SE_INCREASE_QUOTA_NAME);

        let mut raw_dup = HANDLE::default();
        DuplicateTokenEx(
            token.get(),
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            kind,
            &mut raw_dup,
        )?;
        let dup = OwnedHandle::new(raw_dup).ok_or_else(windows::core::Error::from_thread)?;

        let session = session_id;
        SetTokenInformation(
            dup.get(),
            TokenSessionId,
            &session as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )?;
        Ok(dup)
    }
}

/// The name of a privilege LUID (`SeTcbPrivilege`, …).
unsafe fn privilege_name(luid: &LUID) -> Option<String> {
    // 128 UTF-16 units: well above the longest privilege constant
    // (`SeDelegateSessionUserImpersonatePrivilege`, 39 characters).
    let mut buffer = [0u16; 128];
    let mut length = buffer.len() as u32;
    LookupPrivilegeNameW(
        PCWSTR::null(),
        luid,
        Some(PWSTR(buffer.as_mut_ptr())),
        &mut length,
    )
    .ok()?;
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

/// Remove from `token` every privilege the helper does not keep
/// ([`HELPER_KEPT_PRIVILEGES`]). Fails rather than launch a helper holding
/// privileges it was meant to lose. Returns the names removed.
fn strip_privileges(token: HANDLE) -> windows::core::Result<Vec<String>> {
    unsafe {
        let mut needed = 0u32;
        // Sizing call: expected to fail with ERROR_INSUFFICIENT_BUFFER.
        let _ = GetTokenInformation(token, TokenPrivileges, None, 0, &mut needed);
        if needed == 0 {
            return Err(windows::core::Error::from_thread());
        }
        // u32-backed so the LUID_AND_ATTRIBUTES array is aligned.
        let mut current = vec![0u32; (needed as usize).div_ceil(4)];
        GetTokenInformation(
            token,
            TokenPrivileges,
            Some(current.as_mut_ptr() as *mut _),
            needed,
            &mut needed,
        )?;
        let held = &*(current.as_ptr() as *const TOKEN_PRIVILEGES);
        let entries =
            std::slice::from_raw_parts(held.Privileges.as_ptr(), held.PrivilegeCount as usize);

        let mut removed = Vec::new();
        let mut removals = Vec::new();
        for entry in entries {
            let name = privilege_name(&entry.Luid).ok_or_else(windows::core::Error::from_thread)?;
            if !helper_keeps_privilege(&name) {
                removals.push(LUID_AND_ATTRIBUTES {
                    Luid: entry.Luid,
                    Attributes: SE_PRIVILEGE_REMOVED,
                });
                removed.push(name);
            }
        }
        if removals.is_empty() {
            return Ok(removed);
        }
        // TOKEN_PRIVILEGES is a count followed by a variable-length array.
        let words = 1 + removals.len() * std::mem::size_of::<LUID_AND_ATTRIBUTES>() / 4;
        let mut request = vec![0u32; words];
        let header = request.as_mut_ptr() as *mut TOKEN_PRIVILEGES;
        (*header).PrivilegeCount = removals.len() as u32;
        std::ptr::copy_nonoverlapping(
            removals.as_ptr(),
            (*header).Privileges.as_mut_ptr(),
            removals.len(),
        );
        AdjustTokenPrivileges(token, false, Some(header), 0, None, None)?;
        // AdjustTokenPrivileges succeeds with ERROR_NOT_ALL_ASSIGNED when it
        // changed only some of them; every one listed must be gone.
        if windows::Win32::Foundation::GetLastError() != windows::Win32::Foundation::ERROR_SUCCESS {
            return Err(windows::core::Error::from_thread());
        }
        Ok(removed)
    }
}

/// Launch this executable again with `args`, as SYSTEM with only
/// [`HELPER_KEPT_PRIVILEGES`], in `session_id`, on `desktop`
/// (`winsta0\default` or `winsta0\winlogon`). Returns the process handle so
/// the service can monitor and terminate it, and the still-armed
/// [`BootstrapJob`] the helper runs in.
///
/// `CreateProcessAsUser` takes "a STARTUPINFO or STARTUPINFOEX structure"; "To
/// set extended attributes, use a STARTUPINFOEX structure and specify
/// EXTENDED_STARTUPINFO_PRESENT"
/// (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw).
/// The process is created suspended inside the job; `before_resume` gets its
/// handle (`PROCESS_ALL_ACCESS`,
/// https://learn.microsoft.com/windows/win32/procthread/process-security-and-access-rights)
/// to prepare it — the parent hand-over — and only then is it resumed. If any
/// step fails the job is dropped armed and the never-run process is
/// terminated through it.
pub fn launch_in_session(
    session_id: u32,
    desktop: &str,
    args: &[&str],
    before_resume: impl FnOnce(HANDLE) -> windows::core::Result<()>,
) -> windows::core::Result<(OwnedHandle, BootstrapJob)> {
    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
    let exe = exe.to_string_lossy().to_string();

    let dup = session_token(session_id, TokenPrimary)?;
    strip_privileges(dup.get())?;

    let mut command = format!("\"{exe}\"");
    for arg in args {
        command.push(' ');
        command.push_str(arg);
    }
    let mut command_wide = wide_z(&command);
    let mut desktop_wide = wide_z(desktop);

    start_in_job(
        BootstrapJob::new()?,
        PWSTR(desktop_wide.as_mut_ptr()),
        |startup, flags, info| unsafe {
            CreateProcessAsUserW(
                Some(dup.get()),
                PCWSTR::null(),
                Some(PWSTR(command_wide.as_mut_ptr())),
                None,
                None,
                false,
                flags,
                None,
                PCWSTR::null(),
                startup,
                info,
            )
        },
        before_resume,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use windows::Win32::Foundation::{
        DuplicateHandle, DUPLICATE_SAME_ACCESS, E_FAIL, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
    };

    /// How long a test waits for a termination it expects: the helper's own
    /// shutdown deadline, the bound the service gives any helper exit.
    fn deadline_ms() -> u32 {
        crate::helper::SHUTDOWN_DEADLINE.as_millis() as u32
    }

    /// A handle of this process's own to `process`, outliving the launch's.
    fn keep(process: HANDLE) -> OwnedHandle {
        let mut kept = HANDLE::default();
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process,
                GetCurrentProcess(),
                &mut kept,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
            .unwrap();
        }
        OwnedHandle::new(kept).unwrap()
    }

    /// Terminate a stand-in with a code of the test's own and check that the
    /// test was the one that ended it (a job kill would have come first).
    fn end_stand_in(process: &OwnedHandle) {
        const OURS: u32 = 0x5EC;
        unsafe { TerminateProcess(process.get(), OURS) }.unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(process.get(), deadline_ms()) },
            WAIT_OBJECT_0
        );
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(process.get(), &mut code) }.unwrap();
        assert_eq!(code, OURS, "nothing had terminated it before");
    }

    #[test]
    fn the_job_list_assigns_the_job_at_creation_before_the_process_runs() {
        let job = BootstrapJob::new().unwrap();
        assert!(job.kills_on_close().unwrap());
        let job_handle = job.handle();
        let in_job = Cell::new(false);
        let (process, job) = start_stand_in(job, |process| {
            let mut result = 0i32;
            assert_ne!(
                unsafe { jobs::IsProcessInJob(process.0, job_handle.0, &mut result) },
                0
            );
            in_job.set(result != 0);
            Ok(())
        })
        .unwrap();
        assert!(
            in_job.get(),
            "in the job while still suspended, before any hand-over or resume"
        );
        assert!(
            job.kills_on_close().unwrap(),
            "still armed after the launch"
        );
        end_stand_in(&process);
    }

    #[test]
    fn a_failure_before_the_confirmation_terminates_the_process_through_the_job() {
        // A hand-over that fails: the launch returns the error, and the
        // never-resumed process dies with the job it was created in.
        let kept = Cell::new(None);
        let result = start_stand_in(BootstrapJob::new().unwrap(), |process| {
            kept.set(Some(keep(process)));
            Err(windows::core::Error::new(E_FAIL, "hand-over failed"))
        });
        assert!(result.is_err());
        let process = kept.take().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(process.get(), deadline_ms()) },
            WAIT_OBJECT_0,
            "terminated through the job"
        );

        // A launch that succeeded but whose job is closed while still armed —
        // what the service's death does to its handle.
        let (process, job) = start_stand_in(BootstrapJob::new().unwrap(), |_| Ok(())).unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(process.get(), 0) },
            WAIT_TIMEOUT,
            "alive while the job is held"
        );
        drop(job);
        assert_eq!(
            unsafe { WaitForSingleObject(process.get(), deadline_ms()) },
            WAIT_OBJECT_0,
            "terminated through the job"
        );
    }

    #[test]
    fn a_disarmed_job_no_longer_kills_and_its_closing_leaves_the_process_alone() {
        let (process, job) = start_stand_in(BootstrapJob::new().unwrap(), |_| Ok(())).unwrap();
        // A second handle to the same job, to read its limits after `disarm`
        // closed the bootstrap's own.
        let mut second = HANDLE::default();
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                job.handle(),
                GetCurrentProcess(),
                &mut second,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
            .unwrap();
        }
        let second = OwnedHandle::new(second).unwrap();
        job.disarm().unwrap();
        assert_eq!(
            query_limits(second.get()).unwrap().basic.limit_flags
                & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            0
        );
        drop(second); // the job's last handle
        end_stand_in(&process);
    }
}
