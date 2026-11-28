//! Process-tree containment of a stdio server: a Windows job object (kill-on-close) or, on
//! Unix, the child's own process group (it leads a session of its own, which the core's warden
//! ends with the core). A forced shutdown ends the server and everything it started.
//! Termination is the OS exit; nothing here waits.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

#[cfg(any(windows, unix))]
use tokio::process::Child;

pub struct Containment {
    exited: AtomicBool,
    os: os::Handle,
}

#[cfg(test)]
thread_local! {
    /// Makes the next `attach` on this thread fail, as a job that refuses the process would.
    pub(crate) static FAIL_NEXT_ATTACH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl Containment {
    /// Puts `child` under containment. On Windows the child was created suspended (`CREATE_SUSPENDED`): it joins its job
    /// before it runs a single instruction, so nothing it starts is outside the job, and it is resumed here; a child that
    /// cannot join the job or be resumed is an error, and the job's close ends it.
    pub fn attach(child: &Child) -> std::io::Result<Self> {
        #[cfg(test)]
        if FAIL_NEXT_ATTACH.with(std::cell::Cell::take) {
            return Err(std::io::Error::other("attach failed (injected by the test)"));
        }
        #[cfg(windows)]
        let process = child.raw_handle();
        #[cfg(unix)]
        let process = child.id();
        Ok(Self { exited: AtomicBool::new(false), os: os::attach(process)? })
    }

    /// [`Self::attach`] for a `std` child (created suspended on Windows, leading its own group on Unix).
    pub fn attach_std(child: &std::process::Child) -> std::io::Result<Self> {
        #[cfg(windows)]
        let process = Some(std::os::windows::io::AsRawHandle::as_raw_handle(child));
        #[cfg(unix)]
        let process = Some(child.id());
        Ok(Self { exited: AtomicBool::new(false), os: os::attach(process)? })
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

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
    use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        /// Resumes every thread of a process created suspended (the same export mixdog-spawn resumes its children with).
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    /// The job handle as an integer so the owner is `Send + Sync`.
    pub(super) struct Handle(usize);

    pub(super) fn attach(process: Option<*mut c_void>) -> std::io::Result<Handle> {
        let process = process.ok_or_else(|| std::io::Error::other("child already exited"))?;
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
            let status = NtResumeProcess(process as HANDLE);
            if status < 0 {
                CloseHandle(job);
                return Err(std::io::Error::other(format!("the suspended process could not be resumed (NTSTATUS 0x{status:08x})")));
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
    /// The child's process-group id (the child leads its own group).
    pub(super) struct Handle(i32);

    pub(super) fn attach(pid: Option<u32>) -> std::io::Result<Handle> {
        pid.and_then(|pid| i32::try_from(pid).ok()).map(Handle).ok_or_else(|| std::io::Error::other("child already exited"))
    }

    pub(super) fn terminate(handle: &Handle) {
        // SAFETY: signalling the group this process created; never called after the exit.
        unsafe {
            libc::killpg(handle.0, libc::SIGKILL);
        }
    }

    pub(super) fn release(_handle: &Handle) {}
}
