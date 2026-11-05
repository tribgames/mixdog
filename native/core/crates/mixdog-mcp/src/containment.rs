//! Process-tree containment of a stdio server: a Windows job object (kill-on-close) or, on
//! Unix, the child's own process group. A forced shutdown ends the server and everything it
//! started. Termination is the OS exit; nothing here waits.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use tokio::process::Child;

pub struct Containment {
    exited: AtomicBool,
    os: os::Handle,
}

impl Containment {
    /// Puts `child` (just spawned) under containment.
    pub fn attach(child: &Child) -> std::io::Result<Self> {
        Ok(Self { exited: AtomicBool::new(false), os: os::attach(child)? })
    }

    /// Kills the child and everything in its job or group. A no-op once the exit was observed:
    /// a recycled process-group id must never be signalled.
    pub fn terminate(&self) {
        if !self.exited.load(Ordering::Acquire) {
            os::terminate(&self.os);
        }
    }

    pub fn mark_exited(&self) {
        self.exited.store(true, Ordering::Release);
    }
}

impl Drop for Containment {
    fn drop(&mut self) {
        self.terminate();
        os::release(&self.os);
    }
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;

    use tokio::process::Child;
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

    pub(super) fn attach(child: &Child) -> std::io::Result<Handle> {
        let process = child.raw_handle().ok_or_else(|| std::io::Error::other("child already exited"))?;
        // SAFETY: plain Win32 calls on a job created here and on the live child's handle.
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
    use tokio::process::Child;

    /// The child's process-group id (the child leads its own group).
    pub(super) struct Handle(i32);

    pub(super) fn attach(child: &Child) -> std::io::Result<Handle> {
        child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .map(Handle)
            .ok_or_else(|| std::io::Error::other("child already exited"))
    }

    pub(super) fn terminate(handle: &Handle) {
        // SAFETY: signalling the group this process created; never called after the exit.
        unsafe {
            libc::killpg(handle.0, libc::SIGKILL);
        }
    }

    pub(super) fn release(_handle: &Handle) {}
}
