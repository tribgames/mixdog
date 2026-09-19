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
}

impl TaskState {
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
        })
    }
}

#[cfg(windows)]
pub(crate) struct ProcessControl {
    pub(crate) handle: HANDLE,
    pub(crate) preserve_descendants: Mutex<bool>,
}

#[cfg(windows)]
unsafe impl Send for ProcessControl {}
#[cfg(windows)]
unsafe impl Sync for ProcessControl {}

#[cfg(windows)]
impl ProcessControl {
    pub(crate) fn create() -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
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
            preserve_descendants: Mutex::new(false),
        })
    }

    pub(crate) fn assign(&self, child: &Child) -> std::io::Result<()> {
        let assigned =
            unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle().cast()) };
        if assigned == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(crate) fn terminate(&self) {
        let preserve_descendants = self
            .preserve_descendants
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *preserve_descendants {
            return;
        }
        unsafe {
            TerminateJobObject(self.handle, 137);
        }
    }

    pub(crate) fn preserve_descendants(&self) {
        let mut preserve_descendants = self
            .preserve_descendants
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *preserve_descendants {
            return;
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let configured = unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured != 0 {
            *preserve_descendants = true;
        }
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

#[cfg(unix)]
impl ProcessControl {
    pub(crate) fn terminate(&self) {
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }

    pub(crate) fn preserve_descendants(&self) {}
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
    pub(crate) fn terminate(&self) {
        self.control.terminate();
    }

    pub(crate) fn preserve_descendants(&self) {
        self.control.preserve_descendants();
    }

    pub(crate) fn snapshot(&self) -> Option<TaskSnapshot> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.snapshot(self.request_id, self.pid))
    }
}

pub(crate) struct Manager {
    pub(crate) live: Mutex<HashMap<u64, Arc<ManagedProcess>>>,
    pub(crate) jobs: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

impl Manager {
    pub(crate) fn new() -> Self {
        Self {
            live: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        }
    }
}
