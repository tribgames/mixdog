//! Process-tree containment: one Windows job object or one POSIX process group per child, so a
//! kill is one O(1) call that takes the whole tree.

use mixdog_core_api::domain::process::ExitStatus;

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::io;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::sync::Weak;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use tokio::sync::Notify;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::IO::CreateIoCompletionPort;
    use windows_sys::Win32::System::IO::GetQueuedCompletionStatus;
    use windows_sys::Win32::System::IO::OVERLAPPED;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_ASSOCIATE_COMPLETION_PORT;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JobObjectAssociateCompletionPortInformation;
    use windows_sys::Win32::System::JobObjects::JobObjectBasicAccountingInformation;
    use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
    use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
    use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    use windows_sys::Win32::System::Threading::INFINITE;

    /// `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` (winnt.h), which windows-sys does not export: the
    /// last process of a job ended.
    const JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO: u32 = 4;

    /// The exit code a terminated job's processes report.
    pub(crate) const KILL_EXIT_CODE: u32 = 137;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    /// The one completion port every watched job reports to, and the job each message is for.
    /// A job's "last member gone" arrives as a message, so nothing polls the job.
    struct Port {
        handle: HANDLE,
        watchers: Mutex<HashMap<usize, Weak<Notify>>>,
        next_key: AtomicUsize,
    }

    unsafe impl Send for Port {}
    unsafe impl Sync for Port {}

    fn port() -> Option<&'static Port> {
        static PORT: OnceLock<Option<Port>> = OnceLock::new();
        PORT.get_or_init(|| {
            let handle = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
            if handle.is_null() {
                return None;
            }
            std::thread::Builder::new()
                .name("job-port".to_owned())
                .spawn(move || {
                    let port = port().expect("the port exists before its thread runs");
                    loop {
                        let mut message = 0u32;
                        let mut key = 0usize;
                        let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
                        let ok = unsafe {
                            GetQueuedCompletionStatus(port.handle, &mut message, &mut key, &mut overlapped, INFINITE)
                        };
                        if ok == 0 && overlapped.is_null() {
                            return;
                        }
                        if message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO {
                            let watcher = port.watchers.lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
                            if let Some(notify) = watcher.and_then(|w| w.upgrade()) {
                                notify.notify_waiters();
                            }
                        }
                    }
                })
                .ok()?;
            Some(Port {
                handle,
                watchers: Mutex::new(HashMap::new()),
                next_key: AtomicUsize::new(1),
            })
        })
        .as_ref()
    }

    /// A job object. Dropping the last handle kills whatever is still in it.
    pub(crate) struct Containment {
        job: HANDLE,
        /// Set when the job first reports to the port: its key and the signal for "no members".
        watch: OnceLock<(usize, Arc<Notify>)>,
    }

    unsafe impl Send for Containment {}
    unsafe impl Sync for Containment {}

    impl Containment {
        pub(crate) fn create() -> io::Result<Self> {
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set == 0 {
                let error = io::Error::last_os_error();
                unsafe { CloseHandle(job) };
                return Err(error);
            }
            Ok(Self {
                job,
                watch: OnceLock::new(),
            })
        }

        /// Processes of the job still running.
        fn active(&self) -> u32 {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let ok = unsafe {
                QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    std::ptr::addr_of_mut!(info).cast(),
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 { 0 } else { info.ActiveProcesses }
        }

        /// Whether any process of the job is still running.
        pub(crate) fn occupied(&self) -> bool {
            self.active() > 0
        }

        /// What is left in the job: `Some(reachable)` while any process runs, `None` when empty.
        /// Everything in a job can be ended with the job.
        pub(crate) fn remaining(&self) -> Option<bool> {
            self.occupied().then_some(true)
        }

        /// Starts reporting this job to the completion port (once) and returns the signal that
        /// is raised whenever its last process ends. `None` if the port is unavailable.
        fn signal(&self) -> Option<Arc<Notify>> {
            if let Some((_, notify)) = self.watch.get() {
                return Some(Arc::clone(notify));
            }
            let port = port()?;
            let key = port.next_key.fetch_add(1, Ordering::Relaxed);
            let notify = Arc::new(Notify::new());
            port.watchers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, Arc::downgrade(&notify));
            let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                CompletionKey: key as *mut std::ffi::c_void,
                CompletionPort: port.handle,
            };
            let set = unsafe {
                SetInformationJobObject(
                    self.job,
                    JobObjectAssociateCompletionPortInformation,
                    std::ptr::addr_of!(association).cast(),
                    std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                )
            };
            if set == 0 {
                port.watchers.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                return None;
            }
            let _ = self.watch.set((key, Arc::clone(&notify)));
            Some(notify)
        }

        /// Whether this job can be watched for its last process ending.
        pub(crate) fn watchable(&self) -> bool {
            self.signal().is_some()
        }

        /// Completes when no process of the job is running; wakes on the port's message.
        pub(crate) async fn wait_empty(&self) {
            let Some(notify) = self.signal() else { return };
            loop {
                let mut notified = std::pin::pin!(notify.notified());
                // Registered before the count is read, so the last exit in between is not missed.
                notified.as_mut().enable();
                if !self.occupied() {
                    return;
                }
                notified.await;
            }
        }

        /// Puts a process created suspended into the job, then lets it run: it cannot start
        /// anything before it is a member.
        pub(crate) fn adopt_and_resume(&self, process: HANDLE) -> io::Result<()> {
            #[cfg(feature = "core-test")]
            if crate::testing::take_adoption_failure() {
                return Err(io::Error::other("injected job assignment failure"));
            }
            if unsafe { AssignProcessToJobObject(self.job, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let status = unsafe { NtResumeProcess(process) };
            if status < 0 {
                return Err(io::Error::other(format!(
                    "the suspended process could not be resumed (NTSTATUS 0x{status:08x})"
                )));
            }
            Ok(())
        }

        pub(crate) fn kill(&self) {
            unsafe { TerminateJobObject(self.job, KILL_EXIT_CODE) };
        }

        /// A job object has no gentle stop: the first stop is the forced one, so only the Unix path
        /// of an escalating stop differs.
        pub(crate) fn terminate(&self) {
            self.kill();
        }
    }

    impl Drop for Containment {
        fn drop(&mut self) {
            if let (Some((key, _)), Some(port)) = (self.watch.get(), port()) {
                port.watchers.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
            }
            unsafe { CloseHandle(self.job) };
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicI32;
    use std::sync::atomic::Ordering;

    /// The group of a child started as its own group leader (`setsid` or `process_group(0)`).
    pub(crate) struct Containment {
        group: AtomicI32,
        /// The group was seen empty. Its id may be reused by an unrelated group from then on, so
        /// nothing is sent to it or asked of it again.
        emptied: AtomicBool,
    }

    impl Containment {
        pub(crate) fn create() -> std::io::Result<Self> {
            Ok(Self {
                group: AtomicI32::new(0),
                emptied: AtomicBool::new(false),
            })
        }

        pub(crate) fn adopt(&self, pid: u32) {
            self.group.store(pid as i32, Ordering::Release);
        }

        pub(crate) fn kill(&self) {
            self.signal(libc::SIGKILL);
        }

        /// SIGTERM to the group: the gentle first stop of an escalating one (`kill` is the second).
        pub(crate) fn terminate(&self) {
            self.signal(libc::SIGTERM);
        }

        fn signal(&self, signal: libc::c_int) {
            let group = self.group.load(Ordering::Acquire);
            if group > 0 && !self.emptied.load(Ordering::Acquire) {
                unsafe { libc::kill(-group, signal) };
            }
        }

        /// Existence probe of the group (signal 0): `Some(reachable)` while it has members
        /// (`false` when the kernel refuses us the signal), `None` once it has none.
        fn probe(&self) -> Option<bool> {
            let group = self.group.load(Ordering::Acquire);
            if group <= 0 || self.emptied.load(Ordering::Acquire) {
                return None;
            }
            if unsafe { libc::kill(-group, 0) } == 0 {
                return Some(true);
            }
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
                return Some(false);
            }
            self.emptied.store(true, Ordering::Release);
            None
        }

        /// Whether the group still has a member (a zombie awaiting its reaper counts).
        pub(crate) fn occupied(&self) -> bool {
            self.probe().is_some()
        }

        /// What is left in the group: `Some(reachable)` while a live process remains, else `None`.
        pub(crate) fn remaining(&self) -> Option<bool> {
            #[cfg(target_os = "linux")]
            {
                let group = self.group.load(Ordering::Acquire);
                if group <= 0 || linux::live_members(group).is_empty() {
                    return None;
                }
            }
            self.probe()
        }

        /// Whether the end of the group can be waited for by event (Linux: one pidfd per member).
        pub(crate) fn watchable(&self) -> bool {
            #[cfg(target_os = "linux")]
            {
                linux::pidfd_supported()
            }
            #[cfg(not(target_os = "linux"))]
            {
                false
            }
        }

        /// Completes when no live process is left in the group, woken by the members' exits.
        pub(crate) async fn wait_empty(&self) {
            #[cfg(target_os = "linux")]
            {
                let group = self.group.load(Ordering::Acquire);
                if group > 0 {
                    linux::wait_group_empty(group).await;
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use std::os::fd::AsRawFd;
        use std::os::fd::FromRawFd;
        use std::os::fd::OwnedFd;
        use std::sync::Arc;

        /// The live (not zombie) processes whose process group is `group`.
        pub(super) fn live_members(group: i32) -> Vec<u32> {
            let Ok(dir) = std::fs::read_dir("/proc") else {
                return Vec::new();
            };
            dir.filter_map(|entry| {
                let pid: u32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
                let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
                // The command name may hold spaces and parentheses: the fields follow the last ')'.
                let rest = &stat[stat.rfind(')')? + 2..];
                let mut fields = rest.split(' ');
                let state = fields.next()?;
                fields.next()?;
                let pgrp: i32 = fields.next()?.parse().ok()?;
                (pgrp == group && state != "Z" && state != "X").then_some(pid)
            })
            .collect()
        }

        fn pidfd_open(pid: u32) -> Option<OwnedFd> {
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
            (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as i32) })
        }

        pub(super) fn pidfd_supported() -> bool {
            pidfd_open(std::process::id()).is_some()
        }

        /// Wakes the blocked waiter when the future that started it is dropped.
        struct Cancel(Arc<OwnedFd>);

        impl Drop for Cancel {
            fn drop(&mut self) {
                let one = 1u64.to_ne_bytes();
                unsafe { libc::write(self.0.as_raw_fd(), one.as_ptr().cast(), one.len()) };
            }
        }

        pub(super) async fn wait_group_empty(group: i32) {
            let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
            if raw < 0 {
                return;
            }
            let cancel = Arc::new(unsafe { OwnedFd::from_raw_fd(raw) });
            let (done, finished) = tokio::sync::oneshot::channel();
            let waiter_fd = Arc::clone(&cancel);
            let spawned = std::thread::Builder::new().name("group-wait".to_owned()).spawn(move || {
                block_until_empty(group, waiter_fd.as_raw_fd());
                let _ = done.send(());
            });
            if spawned.is_err() {
                return;
            }
            let _wake_on_drop = Cancel(cancel);
            let _ = finished.await;
        }

        fn block_until_empty(group: i32, cancel: i32) {
            loop {
                let members = live_members(group);
                if members.is_empty() {
                    return;
                }
                let mut watched: Vec<OwnedFd> = Vec::new();
                let mut fds = vec![libc::pollfd {
                    fd: cancel,
                    events: libc::POLLIN,
                    revents: 0,
                }];
                for pid in members {
                    // A member that vanished since the scan has no pidfd; the next scan drops it.
                    if let Some(fd) = pidfd_open(pid) {
                        fds.push(libc::pollfd {
                            fd: fd.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        });
                        watched.push(fd);
                    }
                }
                if watched.is_empty() {
                    continue;
                }
                let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
                if ready > 0 && fds[0].revents != 0 {
                    return;
                }
            }
        }
    }
}

pub(crate) use imp::Containment;

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::process::CommandExt;
    use std::os::unix::process::ExitStatusExt;
    use std::time::Duration;

    use super::Containment;

    /// The gentle stop is SIGTERM and a child that ignores it lives; the forced one is SIGKILL.
    #[test]
    fn terminate_is_sigterm_and_kill_is_sigkill() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
            .process_group(0)
            .spawn()
            .unwrap();
        let containment = Containment::create().unwrap();
        containment.adopt(child.id());
        std::thread::sleep(Duration::from_millis(300));
        containment.terminate();
        std::thread::sleep(Duration::from_millis(300));
        assert!(child.try_wait().unwrap().is_none(), "a child that ignores SIGTERM is still there");
        containment.kill();
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    }
}

/// How a finished root process ended.
pub(crate) fn exit_status(status: std::process::ExitStatus) -> ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return ExitStatus::Signal(signal);
        }
    }
    ExitStatus::Code(status.code().unwrap_or(-1))
}
