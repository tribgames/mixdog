//! Process-tree containment: one Windows job object or one POSIX process group per child, so a
//! kill is one O(1) call that takes the whole tree.

use mixdog_core_api::domain::process::ExitStatus;

/// What one look at a command's tree found.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Seen {
    /// Something is still running; `reachable` is whether this process can signal it.
    Running { reachable: bool },
    /// Nothing is left.
    Gone,
    /// The tree could not be inspected: nothing is known.
    Unknown,
}

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

    /// Kill-and-wait rounds of a cancel before it reports what is left (`KILL_ROUNDS` of `lib/shell-descendants.mjs`).
    const KILL_ROUNDS: usize = 3;

    /// `TERMINATION_RECHECK_MS`: how often a job that cannot be asked or watched is asked again.
    const RECHECK: std::time::Duration = std::time::Duration::from_millis(5_000);

    /// How long one round waits for the job to empty.
    const KILL_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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

        /// Processes of the job still running; `None` when the job could not be asked.
        fn active(&self) -> Option<u32> {
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
            (ok != 0).then_some(info.ActiveProcesses)
        }

        /// Whether any process of the job might still be running: a job that could not be asked is not empty.
        pub(crate) fn occupied(&self) -> bool {
            self.active().is_none_or(|active| active > 0)
        }

        /// What is left in the job. Everything in a job can be ended with the job.
        pub(crate) fn observe(&self) -> super::Seen {
            match self.active() {
                Some(0) => super::Seen::Gone,
                Some(_) => super::Seen::Running { reachable: true },
                None => super::Seen::Unknown,
            }
        }

        /// A job is not named by a pid, so the root's exit changes nothing about it.
        pub(crate) fn root_reaped(&self) {}

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

        /// Completes when the job is seen empty; wakes on the port's message. A job that cannot be asked, or that
        /// cannot be watched, is not empty: no message will announce its end, so it is asked again every
        /// `RECHECK`, as Node does where it has no exit event (`TERMINATION_RECHECK_MS`).
        pub(crate) async fn wait_gone(&self) {
            let Some(notify) = self.signal() else {
                while self.observe() != super::Seen::Gone {
                    tokio::time::sleep(RECHECK).await;
                }
                return;
            };
            loop {
                let mut notified = std::pin::pin!(notify.notified());
                // Registered before the count is read, so the last exit in between is not missed.
                notified.as_mut().enable();
                match self.observe() {
                    super::Seen::Gone => return,
                    super::Seen::Running { .. } => notified.await,
                    super::Seen::Unknown => tokio::time::sleep(RECHECK).await,
                }
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

        /// Ends the job and waits, woken by the job's own message, for it to empty (`KILL_ROUNDS` times at most): there
        /// is no gentle first stop and no grace to give, only the operating system's time to end the processes.
        pub(crate) async fn cancel(&self) -> bool {
            for _ in 0..KILL_ROUNDS {
                self.kill();
                let _ = tokio::time::timeout(KILL_WAIT, self.wait_gone()).await;
                if !self.occupied() {
                    return true;
                }
            }
            false
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
    use std::sync::OnceLock;

    use crate::osproc::OsReader;
    use crate::osproc::OsSignals;
    use crate::osproc::TRACKING;
    use crate::osproc::TokioClock;
    use crate::tree::Observation;
    use crate::tree::Signal;
    use crate::tree::Tree;

    /// The tree of a child started as its own group leader (`setsid` or `process_group(0)`): one
    /// [`Tree`] follows it by identity, whether the group still has members or not.
    pub(crate) struct Containment {
        tree: OnceLock<Tree<OsReader, OsSignals, TokioClock>>,
    }

    impl Containment {
        pub(crate) fn create() -> std::io::Result<Self> {
            Ok(Self { tree: OnceLock::new() })
        }

        /// `pid` is our own child, just spawned and not yet reaped: the one moment its start token is
        /// known to be its own.
        pub(crate) fn adopt(&self, pid: u32) {
            let _ = self.tree.set(Tree::new(OsReader, OsSignals, TokioClock, pid, OsReader::identity(pid)));
        }

        /// The root has been reaped: its pid and group id are free for reuse from now on.
        pub(crate) fn root_reaped(&self) {
            if let Some(tree) = self.tree.get() {
                tree.root_reaped();
            }
        }

        pub(crate) fn kill(&self) {
            if let Some(tree) = self.tree.get() {
                tree.signal_group(Signal::Kill);
            }
        }

        /// SIGTERM to the group: the gentle first stop of an escalating one (`kill` is the second).
        pub(crate) fn terminate(&self) {
            if let Some(tree) = self.tree.get() {
                tree.signal_group(Signal::Term);
            }
        }

        /// Whether the group might still have a member, for how long a record is kept. It proves
        /// nothing about who owns the group.
        pub(crate) fn occupied(&self) -> bool {
            self.tree.get().is_some_and(Tree::group_may_be_occupied)
        }

        /// What is left of the tree.
        pub(crate) fn observe(&self) -> super::Seen {
            match self.tree.get().map(Tree::observe) {
                Some(Observation::Running(_)) => super::Seen::Running { reachable: true },
                Some(Observation::Unknown) => super::Seen::Unknown,
                Some(Observation::Gone) | None => super::Seen::Gone,
            }
        }

        /// Whether the survivors of this platform can be followed at all: it needs a process table.
        pub(crate) fn watchable(&self) -> bool {
            TRACKING
        }

        /// Completes when the tree is gone ([`Tree::wait_gone`]).
        pub(crate) async fn wait_gone(&self) {
            if let Some(tree) = self.tree.get() {
                tree.wait_gone().await;
            }
        }

        /// Ends the tree ([`Tree::cancel`]); `true` when a fresh look finds nothing left.
        pub(crate) async fn cancel(&self) -> bool {
            match self.tree.get() {
                Some(tree) => tree.cancel().await,
                None => true,
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
