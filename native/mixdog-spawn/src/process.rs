// Managed process bookkeeping: task state, platform process control and the
// manager registry.

use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSnapshot {
    pub(crate) job_id: String,
    pub(crate) request_id: u64,
    pub(crate) pid: u32,
    pub(crate) status: String,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) shell_type: Option<String>,
    pub(crate) owner_session_id: Option<String>,
    pub(crate) client_host_pid: Option<u32>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) signal: Option<String>,
    pub(crate) timed_out: bool,
    pub(crate) killed: bool,
    pub(crate) error: Option<String>,
    pub(crate) started_at_ms: u64,
    pub(crate) finished_at_ms: Option<u64>,
    pub(crate) stdout_bytes: u64,
    pub(crate) stderr_bytes: u64,
    pub(crate) stdout_preview: String,
    pub(crate) stderr_preview: String,
    pub(crate) contained: bool,
    pub(crate) tree_outcome: Option<String>,
    /// `false` only when the tree was RELEASED but breakaway could not be
    /// restored; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) breakaway_restored: Option<bool>,
}

pub(crate) struct TaskState {
    pub(crate) job_id: Option<String>,
    pub(crate) status: String,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) shell_type: Option<String>,
    pub(crate) owner_session_id: Option<String>,
    pub(crate) client_host_pid: Option<u32>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) signal: Option<String>,
    pub(crate) timed_out: bool,
    pub(crate) killed: bool,
    pub(crate) error: Option<String>,
    pub(crate) started_at_ms: u64,
    pub(crate) finished_at_ms: Option<u64>,
    pub(crate) stdout_bytes: u64,
    pub(crate) stderr_bytes: u64,
    pub(crate) stdout_tail: Vec<u8>,
    pub(crate) stderr_tail: Vec<u8>,
    pub(crate) merge_stderr: bool,
    pub(crate) output_limit: usize,
    /// Spawned into a job it cannot break away from (see ProcessControl).
    pub(crate) contained: bool,
    /// A contained command's tree. The one field every kill, settlement,
    /// watcher and the shutdown reap decide on, always under this state lock
    /// and together with the job action the transition implies (main.rs).
    pub(crate) tree: Tree,
    /// Its completion was reported (finalize_process): with a final tree,
    /// nothing is left to decide and the registry lets it go.
    pub(crate) reported: bool,
    /// RELEASED, but breakaway could not be restored (main.rs release_held):
    /// the survivors stay in a job they cannot leave.
    pub(crate) breakaway_unrestored: bool,
}

/// What became of a contained command's tree (TaskState::tree). An
/// uncontained command's stays Open: nothing about its tree is established.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum Tree {
    /// The root runs, or exited on its own and its job is still settling: a
    /// kill terminates the job. Not on the wire (`treeOutcome` null).
    Open,
    /// Killed; the job is being verified empty. Wire: "pending".
    Killing,
    /// The root exited on its own and the job's survivors are kept in it (no
    /// kill on close, breakaway still refused): only a targeted cancel kills
    /// them, through the job. Wire: "preserved".
    Preserved,
    /// Final, verified: every process of the job exited. Wire: "empty".
    Empty,
    /// Final: killed, never verified empty; the job is let go. Wire:
    /// "unverified".
    Unverified,
    /// Final: the survivors were let go (breakaway allowed again, every kill
    /// refused). Wire: "released".
    Released,
}

impl Tree {
    pub(crate) fn wire(self) -> Option<&'static str> {
        match self {
            Tree::Open => None,
            Tree::Killing => Some("pending"),
            Tree::Preserved => Some("preserved"),
            Tree::Empty => Some("empty"),
            Tree::Unverified => Some("unverified"),
            Tree::Released => Some("released"),
        }
    }

    pub(crate) fn is_final(self) -> bool {
        matches!(self, Tree::Empty | Tree::Unverified | Tree::Released)
    }
}

impl TaskState {
    pub(crate) fn update_metadata(
        &mut self,
        command: Option<String>,
        cwd: Option<String>,
        shell_type: Option<String>,
        owner_session_id: Option<String>,
        client_host_pid: Option<u32>,
    ) {
        if let Some(command) = command {
            self.command = command;
        }
        if let Some(cwd) = cwd {
            self.cwd = cwd;
        }
        if shell_type.is_some() {
            self.shell_type = shell_type;
        }
        if owner_session_id.is_some() {
            self.owner_session_id = owner_session_id;
        }
        if client_host_pid.is_some() {
            self.client_host_pid = client_host_pid;
        }
    }

    pub(crate) fn append(&mut self, kind: &str, bytes: &[u8]) -> bool {
        let (tail, total) = if kind == "stderr" && !self.merge_stderr {
            (&mut self.stderr_tail, &mut self.stderr_bytes)
        } else {
            (&mut self.stdout_tail, &mut self.stdout_bytes)
        };
        *total = total.saturating_add(bytes.len() as u64);
        tail.extend_from_slice(bytes);
        if tail.len() > TAIL_LIMIT {
            tail.drain(..tail.len() - TAIL_LIMIT);
        }
        self.stdout_bytes
            .saturating_add(self.stderr_bytes)
            .gt(&(self.output_limit as u64))
    }

    pub(crate) fn snapshot(&self, request_id: u64, pid: u32) -> Option<TaskSnapshot> {
        Some(TaskSnapshot {
            job_id: self.job_id.clone()?,
            request_id,
            pid,
            status: self.status.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            shell_type: self.shell_type.clone(),
            owner_session_id: self.owner_session_id.clone(),
            client_host_pid: self.client_host_pid,
            exit_code: self.exit_code,
            signal: self.signal.clone(),
            timed_out: self.timed_out,
            killed: self.killed,
            error: self.error.clone(),
            started_at_ms: self.started_at_ms,
            finished_at_ms: self.finished_at_ms,
            stdout_bytes: self.stdout_bytes,
            stderr_bytes: self.stderr_bytes,
            stdout_preview: String::from_utf8_lossy(&self.stdout_tail).into_owned(),
            stderr_preview: String::from_utf8_lossy(&self.stderr_tail).into_owned(),
            contained: self.contained,
            tree_outcome: self.tree.wire().map(str::to_string),
            breakaway_restored: self.breakaway_unrestored.then_some(false),
        })
    }
}

/// Poll cadence of a job-emptiness check.
#[cfg(windows)]
const EMPTY_POLL: Duration = Duration::from_millis(5);
/// While a killed job is not yet empty its kill is re-issued at this cadence:
/// a member may have been creating a process while the previous kill ran.
#[cfg(windows)]
const REKILL_INTERVAL: Duration = Duration::from_millis(100);

/// Every command runs in its own job object, assigned while the root is still
/// suspended (see `assign_and_resume`), so nothing it starts is created
/// outside the job. A CONTAINED job also refuses breakaway: no descendant can
/// leave it, so an empty job proves the whole tree is gone. An uncontained one
/// keeps `JOB_OBJECT_LIMIT_BREAKAWAY_OK` for programs that start children with
/// CREATE_BREAKAWAY_FROM_JOB, and proves nothing about those children.
#[cfg(windows)]
pub(crate) struct ProcessControl {
    pub(crate) handle: HANDLE,
    pub(crate) contained: bool,
    pub(crate) preserve_descendants: Mutex<bool>,
    /// Tests: make restoring breakaway fail, as a refused
    /// SetInformationJobObject would.
    #[cfg(test)]
    pub(crate) refuse_release: AtomicBool,
}

#[cfg(windows)]
unsafe impl Send for ProcessControl {}
#[cfg(windows)]
unsafe impl Sync for ProcessControl {}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    // Resumes every thread of the process behind `process`. Long-standing
    // ntdll export (debuggers and Process Explorer rely on it).
    fn NtResumeProcess(process: HANDLE) -> i32;
}

/// Resume a process created suspended, through the process handle `Child`
/// holds. std does not expose the primary thread handle CreateProcess returns
/// (`ChildExt::main_thread_handle` is nightly-only), and finding the thread in
/// a system-wide thread snapshot cost 31 ms per spawn idle and 51 ms (p50) /
/// 74 ms (p95) under full CPU load on a 6k-thread host; this costs ~2 µs.
#[cfg(windows)]
fn resume_suspended(child: &Child) -> std::io::Result<()> {
    let status = unsafe { NtResumeProcess(child.as_raw_handle().cast()) };
    if status < 0 {
        return Err(std::io::Error::other(format!(
            "the suspended process could not be resumed (NTSTATUS 0x{status:08x})"
        )));
    }
    Ok(())
}

#[cfg(windows)]
impl ProcessControl {
    pub(crate) fn create(contained: bool) -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = if contained {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        } else {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        };
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(handle) };
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            handle,
            contained,
            preserve_descendants: Mutex::new(false),
            #[cfg(test)]
            refuse_release: AtomicBool::new(false),
        })
    }

    /// Put a child created suspended (build_command) into the job, then let it
    /// run: it cannot start anything before it is a member.
    pub(crate) fn assign_and_resume(&self, child: &Child) -> std::io::Result<()> {
        let assigned =
            unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle().cast()) };
        if assigned == 0 {
            return Err(std::io::Error::last_os_error());
        }
        resume_suspended(child)
    }

    /// Kill every process in the job. False when no kill was issued: the
    /// descendants are preserved, or the OS refused it.
    pub(crate) fn terminate(&self) -> bool {
        let preserve_descendants = self
            .preserve_descendants
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *preserve_descendants {
            return false;
        }
        unsafe { TerminateJobObject(self.handle, 137) != 0 }
    }

    /// Processes currently in the job; None when the query fails.
    pub(crate) fn active_processes(&self) -> Option<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        (queried != 0).then_some(info.ActiveProcesses)
    }

    /// Wait up to `within` for the job to be confirmed empty. While members
    /// remain, `rekill` runs every REKILL_INTERVAL: it re-issues the kill
    /// only if, under the command's state lock, the command is being killed.
    pub(crate) fn await_empty(&self, within: Duration, rekill: impl Fn()) {
        let started = std::time::Instant::now();
        let mut killed_at = started;
        while self.active_processes() != Some(0) && started.elapsed() < within {
            if killed_at.elapsed() >= REKILL_INTERVAL {
                rekill();
                killed_at = std::time::Instant::now();
            }
            thread::sleep(EMPTY_POLL);
        }
    }

    fn set_limits(&self, flags: u32) -> bool {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = flags;
        unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        }
    }

    /// The survivors are no longer the server's: no kill when the handle
    /// closes, breakaway allowed again, and every later kill refused. Err
    /// when the job's limits could not be changed: breakaway is not restored.
    pub(crate) fn preserve_descendants(&self) -> std::io::Result<()> {
        let mut preserve_descendants = self
            .preserve_descendants
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *preserve_descendants {
            return Ok(());
        }
        #[cfg(test)]
        if self.refuse_release.load(Ordering::Acquire) {
            return Err(std::io::Error::from_raw_os_error(5));
        }
        if !self.set_limits(JOB_OBJECT_LIMIT_BREAKAWAY_OK) {
            return Err(std::io::Error::last_os_error());
        }
        *preserve_descendants = true;
        Ok(())
    }

    /// A contained job's survivors are kept running but stay in the job:
    /// no kill when the handle closes, breakaway still refused, so the job
    /// remains the exact membership a later kill and its verification use.
    pub(crate) fn keep_survivors(&self) -> bool {
        self.set_limits(0)
    }

    /// Those survivors are being killed: kill on close again.
    pub(crate) fn rearm(&self) -> bool {
        self.set_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    }

    /// Tests: the limit flags a transition left the job with.
    #[cfg(test)]
    pub(crate) fn limit_flags(&self) -> u32 {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(queried, 0, "the job's limits are readable");
        limits.BasicLimitInformation.LimitFlags
    }
}

#[cfg(windows)]
impl Drop for ProcessControl {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(unix)]
pub(crate) struct ProcessControl {
    pub(crate) pid: u32,
}

/// Grace between SIGTERM and SIGKILL of a command's process group: long
/// enough for a server or build tool to flush and exit, short enough that a
/// cancellation still reads as immediate.
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_millis(1_000);
#[cfg(unix)]
const TERMINATE_POLL: Duration = Duration::from_millis(25);

#[cfg(unix)]
impl ProcessControl {
    /// SIGTERM the whole group, then SIGKILL whatever of it is still alive
    /// once the grace passes. The escalation stops as soon as the group is
    /// empty, so it never signals a group id that no longer names ours.
    pub(crate) fn terminate(&self) {
        let group = -(self.pid as i32);
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        thread::spawn(move || {
            let deadline = std::time::Instant::now() + TERMINATE_GRACE;
            while std::time::Instant::now() < deadline {
                thread::sleep(TERMINATE_POLL);
                if unsafe { libc::kill(group, 0) } != 0 {
                    return;
                }
            }
            unsafe {
                libc::kill(group, libc::SIGKILL);
            }
        });
    }

    pub(crate) fn preserve_descendants(&self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) struct ManagedProcess {
    pub(crate) request_id: u64,
    pub(crate) pid: u32,
    pub(crate) control: ProcessControl,
    pub(crate) state: Mutex<TaskState>,
    pub(crate) done: AtomicBool,
    pub(crate) retained: AtomicBool,
    pub(crate) stdin: Mutex<Option<std::process::ChildStdin>>,
}

impl ManagedProcess {
    /// Every kill path. Whether a Windows kill took effect is decided by the
    /// job's emptiness after the root exit (run_spawn), not by this call.
    pub(crate) fn terminate(&self) {
        let _ = self.control.terminate();
    }

    pub(crate) fn preserve_descendants(&self) -> std::io::Result<()> {
        self.control.preserve_descendants()
    }

    pub(crate) fn snapshot(&self) -> Option<TaskSnapshot> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.snapshot(self.request_id, self.pid))
    }

    /// The state lock, recovered from poisoning: every tree transition takes
    /// it, and a panic elsewhere must not leave a job undecided.
    pub(crate) fn lock_state(&self) -> MutexGuard<'_, TaskState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) struct Manager {
    /// THE registry: every command, by request id, from spawn until nothing
    /// is left to decide about it (its completion reported and, contained,
    /// its tree final; main.rs deregister_held), whatever it is meanwhile:
    /// running, retained, settling, keeping survivors. Kills, cancels and the
    /// shutdown reap all reach a command through it. Never held while an
    /// entry's state lock is taken; an entry's state lock may be held while
    /// this one is taken.
    pub(crate) live: Mutex<HashMap<u64, Arc<ManagedProcess>>>,
    /// Every request id a spawn ever took this session (reserve); never
    /// removed, so an id is never reused, not even after its command was let
    /// go while its last events are still on their way. Only ever locked
    /// under the `live` lock.
    used_ids: Mutex<HashSet<u64>>,
    /// Set under the `live` lock when the shutdown reap takes its walk: a
    /// command registered after that decides itself (register).
    closed: AtomicBool,
    /// Task identities (job id → command) for task status/list/cancel; not a
    /// lifecycle registry.
    pub(crate) jobs: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

impl Manager {
    pub(crate) fn new() -> Self {
        Self {
            live: Mutex::new(HashMap::new()),
            used_ids: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// The registry. A poisoned registry is recovered: a panic elsewhere must
    /// not make live processes unreachable.
    pub(crate) fn lock_live(&self) -> MutexGuard<'_, HashMap<u64, Arc<ManagedProcess>>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Take request id `id` for a spawn, before anything is spawned, for the
    /// rest of the session. False, and nothing taken, when a spawn already
    /// took it (a failed one too: its error reply used it) or a command is
    /// registered under it.
    pub(crate) fn reserve(&self, id: u64) -> bool {
        let live = self.lock_live();
        !live.contains_key(&id)
            && self
                .used_ids
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id)
    }

    /// Register a command under its reserved id. True when the shutdown reap
    /// already took its walk: the caller then applies the reap's decision
    /// itself.
    pub(crate) fn register(&self, id: u64, managed: &Arc<ManagedProcess>) -> bool {
        let mut live = self.lock_live();
        live.insert(id, Arc::clone(managed));
        self.closed.load(Ordering::Acquire)
    }

    /// Close the registry for the shutdown reap: every command registered so
    /// far; any later one decides itself (register).
    pub(crate) fn close(&self) -> Vec<Arc<ManagedProcess>> {
        let live = self.lock_live();
        self.closed.store(true, Ordering::Release);
        live.values().cloned().collect()
    }

    /// The tracked-task registry, recovered from poisoning the same way.
    pub(crate) fn lock_jobs(&self) -> MutexGuard<'_, HashMap<String, Arc<ManagedProcess>>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The registered command of request `id`, in whatever state.
    pub(crate) fn entry(&self, id: u64) -> Option<Arc<ManagedProcess>> {
        self.lock_live().get(&id).cloned()
    }

    /// The registered command whose task id is `job_id`.
    pub(crate) fn entry_of_job(&self, job_id: &str) -> Option<Arc<ManagedProcess>> {
        let entries: Vec<Arc<ManagedProcess>> = self.lock_live().values().cloned().collect();
        entries
            .into_iter()
            .find(|managed| managed.lock_state().job_id.as_deref() == Some(job_id))
    }

    /// The command of request `id` while its completion is not yet reported.
    pub(crate) fn live_process(&self, id: u64) -> Option<Arc<ManagedProcess>> {
        self.entry(id)
            .filter(|managed| !managed.lock_state().reported)
    }

    /// The tracked task `job_id`.
    pub(crate) fn job(&self, job_id: &str) -> Option<Arc<ManagedProcess>> {
        self.lock_jobs().get(job_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed() -> Arc<ManagedProcess> {
        #[cfg(windows)]
        let control = ProcessControl::create(false).expect("job object");
        // Never terminated here, so the pid is never signalled.
        #[cfg(unix)]
        let control = ProcessControl { pid: 0 };
        Arc::new(ManagedProcess {
            request_id: 7,
            pid: 0,
            control,
            state: Mutex::new(TaskState {
                job_id: Some("job_7".to_string()),
                status: "running".to_string(),
                command: String::new(),
                cwd: String::new(),
                shell_type: None,
                owner_session_id: None,
                client_host_pid: None,
                exit_code: None,
                signal: None,
                timed_out: false,
                killed: false,
                error: None,
                started_at_ms: 0,
                finished_at_ms: None,
                stdout_bytes: 0,
                stderr_bytes: 0,
                stdout_tail: Vec::new(),
                stderr_tail: Vec::new(),
                merge_stderr: false,
                output_limit: 0,
                contained: false,
                tree: Tree::Open,
                reported: false,
                breakaway_unrestored: false,
            }),
            done: AtomicBool::new(false),
            retained: AtomicBool::new(false),
            stdin: Mutex::new(None),
        })
    }

    #[test]
    fn lookups_recover_a_poisoned_registry() {
        let manager = Arc::new(Manager::new());
        manager.live.lock().unwrap().insert(7, managed());
        manager
            .jobs
            .lock()
            .unwrap()
            .insert("job_7".to_string(), managed());
        let poisoner = Arc::clone(&manager);
        let _ = thread::spawn(move || {
            let _live = poisoner.live.lock().unwrap();
            let _jobs = poisoner.jobs.lock().unwrap();
            panic!("poison both registries");
        })
        .join();
        assert!(manager.live.is_poisoned() && manager.jobs.is_poisoned());
        assert_eq!(manager.live_process(7).map(|m| m.request_id), Some(7));
        assert!(manager.job("job_7").is_some());
        assert!(manager.live_process(8).is_none());
        assert!(manager.job("job_8").is_none());
    }
}
