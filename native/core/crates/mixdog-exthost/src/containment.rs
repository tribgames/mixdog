//! Process containment: a Windows job object (kill-on-close) or a Unix process group around one
//! child, so ending a worker or the render browser ends everything it started (LibreOffice,
//! browser helpers). Termination is the OS exit; nothing here waits.

use std::process::ExitStatus;

use mixdog_core_api::domain::ext::ExtExit;

/// Only the child's owner (`owner::Owner`) calls [`kill_group`](Self::kill_group), and on Unix
/// always before the leader is reaped; nothing here signals on its own, not even on drop.
pub(crate) struct Containment {
    os: os::Handle,
}

impl Containment {
    /// Puts `child` (just spawned, from [`spawn_command`](crate::process::spawn_command)) under
    /// containment.
    pub(crate) fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
        Ok(Self { os: os::attach(child)? })
    }

    /// Kills the child and everything in its job or group. The caller (the owner) guarantees the
    /// leader is not yet reaped, so on Unix the group id cannot belong to anyone else.
    pub(crate) fn kill_group(&self) {
        os::terminate(&self.os);
    }

    /// Unix: whether the leader has exited and is still unreaped (a zombie).
    #[cfg(unix)]
    pub(crate) fn exited_unreaped(&self) -> bool {
        os::exited_unreaped(&self.os)
    }
}

/// Releasing the handle signals nothing on Unix. On Windows the job is kill-on-close, an
/// OS-enforced bound by handle rather than by pid, so it carries no reuse hazard.
impl Drop for Containment {
    fn drop(&mut self) {
        os::release(&self.os);
    }
}

pub(crate) fn exit_of(status: ExitStatus) -> ExtExit {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return ExtExit::Signal(signal);
        }
    }
    ExtExit::Code(status.code().unwrap_or(-1))
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
    use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;

    /// The job handle as an integer so the owner is `Send + Sync`.
    pub(super) struct Handle(usize);

    pub(super) fn attach(child: &tokio::process::Child) -> std::io::Result<Handle> {
        let process = child
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("child already exited"))?;
        // SAFETY: plain Win32 calls on handles created here and on the live child's handle.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job, process as HANDLE) == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Handle(job as usize))
        }
    }

    pub(super) fn terminate(handle: &Handle) {
        // SAFETY: the job handle is open until `release`.
        unsafe {
            TerminateJobObject(handle.0 as HANDLE, 1);
        }
    }

    pub(super) fn release(handle: &Handle) {
        // SAFETY: called once, from `Drop`; kill-on-close ends anything left in the job.
        unsafe {
            CloseHandle(handle.0 as HANDLE);
        }
    }
}

#[cfg(unix)]
mod os {
    /// The child's process-group id (the child is its own group leader).
    pub(super) struct Handle(i32);

    pub(super) fn attach(child: &tokio::process::Child) -> std::io::Result<Handle> {
        child
            .id()
            .map(|pid| Handle(pid as i32))
            .ok_or_else(|| std::io::Error::other("child already exited"))
    }

    pub(super) fn terminate(handle: &Handle) {
        // SAFETY: signalling the group this process created. The owner calls this only while the
        // leader is unreaped, so its pid, and the group id, cannot have been reused.
        unsafe {
            libc::killpg(handle.0, libc::SIGKILL);
        }
    }

    /// The group leader has exited and is still a zombie (`WNOWAIT` leaves it for the reap).
    pub(super) fn exited_unreaped(handle: &Handle) -> bool {
        // SAFETY: `siginfo_t` is plain data that `waitid` fills; `WNOWAIT | WNOHANG` neither
        // reaps nor blocks, and `handle.0` is our own child's pid.
        unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            let status = libc::waitid(
                libc::P_PID,
                handle.0 as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            );
            #[cfg(any(target_os = "linux", target_os = "android"))]
            let pid = info.si_pid();
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            let pid = info.si_pid;
            status == 0 && pid != 0
        }
    }

    pub(super) fn release(_handle: &Handle) {}
}
