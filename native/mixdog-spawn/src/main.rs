use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[cfg(unix)]
fn close_inherited_file_descriptors() {
    #[cfg(target_os = "linux")]
    unsafe {
        if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) == 0 {
            return;
        }
    }

    let upper = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let upper = if upper > 3 { upper } else { 65_536 };
    for fd in 3..upper {
        unsafe {
            libc::close(fd as libc::c_int);
        }
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_OUTPUT_LIMIT: usize = 100 * 1024 * 1024;
const TAIL_LIMIT: usize = 64 * 1024;

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("SIG{signal}"),
    }
    .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnRequest {
    id: u64,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    background: bool,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    timeout_ms: u64,
    #[serde(default)]
    output_limit: usize,
    #[serde(default)]
    merge_stderr: bool,
    #[serde(default)]
    raw_output: bool,
    // Keep the child's stdin as a writable pipe (warm shell standby feeds the
    // script text after spawn). Default false preserves Stdio::null().
    #[serde(default)]
    stdin_pipe: bool,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    shell_type: Option<String>,
    #[serde(default)]
    owner_session_id: Option<String>,
    #[serde(default)]
    client_host_pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdoptRequest {
    id: u64,
    adopt: u64,
    job_id: String,
    #[serde(default)]
    timeout_ms: u64,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell_type: Option<String>,
    #[serde(default)]
    owner_session_id: Option<String>,
    #[serde(default)]
    client_host_pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireRequest {
    Spawn(SpawnRequest),
    Cancel {
        cancel: u64,
    },
    Adopt(AdoptRequest),
    StdinWrite {
        #[serde(rename = "stdinWrite")]
        stdin_write: u64,
        data: String,
        // Atomically close (EOF) after the write. A separate close message
        // could race ahead of the async write thread and hand the child an
        // empty stdin.
        #[serde(default)]
        close: bool,
    },
    StdinClose {
        #[serde(rename = "stdinClose")]
        stdin_close: u64,
    },
    CancelTask {
        id: u64,
        #[serde(rename = "cancelTask")]
        cancel_task: String,
    },
    TaskStatus {
        id: u64,
        #[serde(rename = "taskStatus")]
        task_status: String,
    },
    TaskList {
        id: u64,
        #[serde(rename = "taskList")]
        task_list: bool,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskSnapshot {
    job_id: String,
    request_id: u64,
    pid: u32,
    status: String,
    command: String,
    cwd: String,
    shell_type: Option<String>,
    owner_session_id: Option<String>,
    client_host_pid: Option<u32>,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    killed: bool,
    error: Option<String>,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    stdout_bytes: u64,
    stderr_bytes: u64,
    stdout_preview: String,
    stderr_preview: String,
}

struct TaskState {
    job_id: Option<String>,
    status: String,
    command: String,
    cwd: String,
    shell_type: Option<String>,
    owner_session_id: Option<String>,
    client_host_pid: Option<u32>,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    killed: bool,
    error: Option<String>,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    stdout_bytes: u64,
    stderr_bytes: u64,
    stdout_tail: Vec<u8>,
    stderr_tail: Vec<u8>,
    merge_stderr: bool,
    output_limit: usize,
}

impl TaskState {
    fn append(&mut self, kind: &str, bytes: &[u8]) -> bool {
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

    fn snapshot(&self, request_id: u64, pid: u32) -> Option<TaskSnapshot> {
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
struct ProcessControl {
    handle: HANDLE,
    preserve_descendants: Mutex<bool>,
}

#[cfg(windows)]
unsafe impl Send for ProcessControl {}
#[cfg(windows)]
unsafe impl Sync for ProcessControl {}

#[cfg(windows)]
impl ProcessControl {
    fn create() -> std::io::Result<Self> {
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

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        let assigned =
            unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle().cast()) };
        if assigned == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) {
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

    fn preserve_descendants(&self) {
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
struct ProcessControl {
    pid: u32,
}

#[cfg(unix)]
impl ProcessControl {
    fn terminate(&self) {
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }

    fn preserve_descendants(&self) {}
}

struct ManagedProcess {
    request_id: u64,
    pid: u32,
    control: ProcessControl,
    state: Mutex<TaskState>,
    done: AtomicBool,
    stdin: Mutex<Option<std::process::ChildStdin>>,
}

impl ManagedProcess {
    fn terminate(&self) {
        self.control.terminate();
    }

    fn preserve_descendants(&self) {
        self.control.preserve_descendants();
    }

    fn snapshot(&self) -> Option<TaskSnapshot> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.snapshot(self.request_id, self.pid))
    }
}

struct Manager {
    live: Mutex<HashMap<u64, Arc<ManagedProcess>>>,
    jobs: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

impl Manager {
    fn new() -> Self {
        Self {
            live: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        }
    }
}

fn emit(value: &serde_json::Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn emit_task(id: u64, event: &str, managed: &ManagedProcess) {
    if let Some(task) = managed.snapshot() {
        emit(&json!({ "id": id, "event": event, "task": task }));
    }
}

fn arm_timeout(managed: Arc<ManagedProcess>, timeout_ms: u64) {
    if timeout_ms == 0 {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(timeout_ms));
        if let Ok(mut state) = managed.state.lock() {
            if managed.done.load(Ordering::Acquire) || state.status != "running" {
                return;
            }
            state.timed_out = true;
            state.killed = true;
            state.error = Some(format!("timed out after {timeout_ms} ms"));
            managed.terminate();
        }
    });
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let bits = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((bits >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(bits & 0x3f) as usize] as char);
        index += 3;
    }
    match bytes.len() - index {
        1 => {
            let bits = (bytes[index] as u32) << 16;
            out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let bits = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
            out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn pump_pipe(
    id: u64,
    kind: &'static str,
    mut pipe: impl Read,
    managed: Arc<ManagedProcess>,
    stream: bool,
    raw_output: bool,
) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let exceeded = managed
                    .state
                    .lock()
                    .map(|mut state| state.append(kind, &buf[..n]))
                    .unwrap_or(false);
                if stream {
                    if raw_output {
                        emit(&json!({
                            "id": id,
                            "event": kind,
                            "dataBase64": encode_base64(&buf[..n]),
                        }));
                    } else {
                        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                        emit(&json!({ "id": id, "event": kind, "text": text }));
                    }
                }
                if exceeded {
                    if let Ok(mut state) = managed.state.lock() {
                        state.killed = true;
                        state.error =
                            Some(format!("output exceeded {} byte cap", state.output_limit));
                    }
                    managed.terminate();
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn spawn_error(id: u64, error: impl std::fmt::Display) {
    emit(&json!({
        "id": id,
        "event": "error",
        "message": error.to_string(),
    }));
}

fn spawn_io_error(id: u64, error: std::io::Error) {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::WouldBlock => "EAGAIN",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::TimedOut => "ETIMEDOUT",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        _ => "EIO",
    };
    emit(&json!({
        "id": id,
        "event": "error",
        "code": code,
        "message": error.to_string(),
    }));
}

fn run_spawn(req: SpawnRequest, manager: Arc<Manager>) {
    let id = req.id;
    let mut cmd = Command::new(&req.program);
    cmd.args(&req.args)
        .stdin(if req.stdin_pipe {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = req.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &req.env {
        cmd.env_clear();
        cmd.envs(env);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    cmd.process_group(0);

    #[cfg(windows)]
    let control = match ProcessControl::create() {
        Ok(control) => control,
        Err(error) => {
            spawn_io_error(id, error);
            return;
        }
    };

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            spawn_io_error(id, error);
            return;
        }
    };
    let pid = child.id();
    let stdin_handle = child.stdin.take();

    #[cfg(windows)]
    if let Err(error) = control.assign(&child) {
        let _ = child.kill();
        spawn_io_error(id, error);
        return;
    }
    #[cfg(unix)]
    let control = ProcessControl { pid };

    let output_limit = if req.output_limit > 0 {
        req.output_limit
    } else {
        DEFAULT_OUTPUT_LIMIT
    };
    let job_id = req.background.then(|| {
        req.job_id
            .clone()
            .unwrap_or_else(|| format!("job_{}_{}", now_ms(), id))
    });
    let managed = Arc::new(ManagedProcess {
        request_id: id,
        pid,
        control,
        state: Mutex::new(TaskState {
            job_id: job_id.clone(),
            status: "running".to_string(),
            command: req
                .command
                .clone()
                .unwrap_or_else(|| format!("{} {}", req.program, req.args.join(" "))),
            cwd: req.cwd.clone().unwrap_or_default(),
            shell_type: req.shell_type.clone(),
            owner_session_id: req.owner_session_id.clone(),
            client_host_pid: req.client_host_pid,
            exit_code: None,
            signal: None,
            timed_out: false,
            killed: false,
            error: None,
            started_at_ms: now_ms(),
            finished_at_ms: None,
            stdout_bytes: 0,
            stderr_bytes: 0,
            stdout_tail: Vec::new(),
            stderr_tail: Vec::new(),
            merge_stderr: req.merge_stderr,
            output_limit,
        }),
        done: AtomicBool::new(false),
        stdin: Mutex::new(stdin_handle),
    });
    manager
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, Arc::clone(&managed));
    if let Some(job_id) = &job_id {
        manager
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job_id.clone(), Arc::clone(&managed));
    }

    emit(&json!({ "id": id, "event": "spawned", "pid": pid }));
    if job_id.is_some() {
        emit_task(id, "task_started", &managed);
    }
    arm_timeout(Arc::clone(&managed), req.timeout_ms);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stream = !req.background;
    let raw_output = req.raw_output;
    let out_done = Arc::new(AtomicBool::new(stdout.is_none()));
    let err_done = Arc::new(AtomicBool::new(stderr.is_none()));
    let out_thread = stdout.map(|pipe| {
        let managed = Arc::clone(&managed);
        let done = Arc::clone(&out_done);
        thread::spawn(move || {
            pump_pipe(id, "stdout", pipe, managed, stream, raw_output);
            done.store(true, Ordering::Release);
        })
    });
    let err_thread = stderr.map(|pipe| {
        let managed = Arc::clone(&managed);
        let done = Arc::clone(&err_done);
        thread::spawn(move || {
            pump_pipe(id, "stderr", pipe, managed, stream, raw_output);
            done.store(true, Ordering::Release);
        })
    });

    let status = child.wait();
    if let Ok(state) = managed.state.lock() {
        managed.done.store(true, Ordering::Release);
        if status.is_ok() && !state.killed && !state.timed_out && state.status == "running" {
            managed.preserve_descendants();
        }
    } else {
        managed.done.store(true, Ordering::Release);
    }
    let root_code = status.as_ref().ok().and_then(|exit| exit.code());
    #[cfg(unix)]
    let root_signal = status.as_ref().ok().and_then(|exit| {
        use std::os::unix::process::ExitStatusExt;
        exit.signal().map(signal_name)
    });
    #[cfg(not(unix))]
    let root_signal: Option<String> = None;
    emit(&json!({
        "id": id,
        "event": "root_exit",
        "code": root_code,
        "signal": root_signal,
    }));
    for _ in 0..200 {
        if out_done.load(Ordering::Acquire) && err_done.load(Ordering::Acquire) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    if out_done.load(Ordering::Acquire) {
        if let Some(thread) = out_thread {
            let _ = thread.join();
        }
    }
    if err_done.load(Ordering::Acquire) {
        if let Some(thread) = err_thread {
            let _ = thread.join();
        }
    }
    if let Ok(mut state) = managed.state.lock() {
        state.finished_at_ms = Some(now_ms());
        match status {
            Ok(exit) => {
                state.exit_code = exit.code();
                // Unix: a signal death has code()==None; surface the signal
                // name so the JS contract (killed => result.signal) holds.
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if state.signal.is_none() {
                        if let Some(signal) = exit.signal() {
                            state.signal = Some(signal_name(signal));
                        }
                    }
                }
                if state.timed_out {
                    state.status = "failed".to_string();
                    state.exit_code = Some(124);
                } else if state.status == "cancelled" {
                    state.exit_code = Some(137);
                    #[cfg(unix)]
                    if state.signal.is_none() {
                        state.signal = Some("SIGKILL".to_string());
                    }
                } else if state.error.is_some() {
                    state.status = "failed".to_string();
                    state.exit_code = Some(137);
                } else if state.killed {
                    state.status = "cancelled".to_string();
                    state.exit_code = Some(137);
                    #[cfg(unix)]
                    if state.signal.is_none() {
                        state.signal = Some("SIGKILL".to_string());
                    }
                } else {
                    state.status = if exit.success() {
                        "completed".to_string()
                    } else {
                        "failed".to_string()
                    };
                }
            }
            Err(error) => {
                state.status = "failed".to_string();
                state.error = Some(error.to_string());
            }
        }
    }
    manager
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    let (exit_code, signal) = managed
        .state
        .lock()
        .map(|state| (state.exit_code, state.signal.clone()))
        .unwrap_or((None, None));
    if managed.snapshot().is_some() {
        emit_task(id, "task_complete", &managed);
    }
    emit(&json!({
        "id": id,
        "event": "exit",
        "code": exit_code,
        "signal": signal,
    }));
}

fn adopt(req: AdoptRequest, manager: &Arc<Manager>) {
    let managed = manager
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&req.adopt)
        .cloned();
    let Some(managed) = managed else {
        spawn_error(req.id, "native process is no longer running");
        return;
    };
    if let Ok(mut state) = managed.state.lock() {
        state.job_id = Some(req.job_id.clone());
        if let Some(command) = req.command {
            state.command = command;
        }
        if let Some(cwd) = req.cwd {
            state.cwd = cwd;
        }
        if req.shell_type.is_some() {
            state.shell_type = req.shell_type;
        }
        if req.owner_session_id.is_some() {
            state.owner_session_id = req.owner_session_id;
        }
        if req.client_host_pid.is_some() {
            state.client_host_pid = req.client_host_pid;
        }
    }
    manager
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.job_id, Arc::clone(&managed));
    arm_timeout(Arc::clone(&managed), req.timeout_ms);
    emit_task(req.id, "task_started", &managed);
}

fn main() {
    #[cfg(unix)]
    close_inherited_file_descriptors();
    emit(&json!({ "ready": true, "caps": { "stdinPipe": true } }));
    let manager = Arc::new(Manager::new());
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<WireRequest>(&line) {
            Ok(WireRequest::Spawn(req)) => {
                let manager = Arc::clone(&manager);
                thread::spawn(move || run_spawn(req, manager));
            }
            Ok(WireRequest::StdinWrite {
                stdin_write,
                data,
                close,
            }) => {
                let managed = manager
                    .live
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&stdin_write)
                    .cloned();
                if let Some(managed) = managed {
                    // Write off the wire thread: a stalled child pipe must not
                    // block request processing.
                    thread::spawn(move || {
                        let mut stdin = managed.stdin.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(handle) = stdin.as_mut() {
                            let _ = handle.write_all(data.as_bytes());
                            let _ = handle.flush();
                        }
                        if close {
                            let _ = stdin.take();
                        }
                    });
                }
            }
            Ok(WireRequest::StdinClose { stdin_close }) => {
                let managed = manager
                    .live
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&stdin_close)
                    .cloned();
                if let Some(managed) = managed {
                    let _ = managed
                        .stdin
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take();
                }
            }
            Ok(WireRequest::Cancel { cancel }) => {
                if let Some(managed) = manager
                    .live
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&cancel).cloned())
                {
                    if let Ok(mut state) = managed.state.lock() {
                        if !managed.done.load(Ordering::Acquire) {
                            state.killed = true;
                            managed.terminate();
                        }
                    }
                }
            }
            Ok(WireRequest::Adopt(req)) => adopt(req, &manager),
            Ok(WireRequest::CancelTask { id, cancel_task }) => {
                let managed = manager
                    .jobs
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&cancel_task).cloned());
                if let Some(managed) = managed {
                    if let Ok(mut state) = managed.state.lock() {
                        if !managed.done.load(Ordering::Acquire) && state.status == "running" {
                            state.killed = true;
                            state.status = "cancelled".to_string();
                            state.error = Some("cancelled by task control".to_string());
                            managed.terminate();
                        }
                    }
                } else {
                    spawn_error(id, format!("task not found: {cancel_task}"));
                }
            }
            Ok(WireRequest::TaskStatus { id, task_status }) => {
                let managed = manager
                    .jobs
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&task_status).cloned());
                if let Some(managed) = managed {
                    emit_task(id, "task_status", &managed);
                } else {
                    spawn_error(id, format!("task not found: {task_status}"));
                }
            }
            Ok(WireRequest::TaskList { id, task_list }) => {
                if !task_list {
                    spawn_error(id, "invalid task list request");
                    continue;
                }
                let tasks: Vec<TaskSnapshot> = manager
                    .jobs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .filter_map(|managed| managed.snapshot())
                    .collect();
                emit(&json!({ "id": id, "event": "task_list", "tasks": tasks }));
            }
            Err(error) => spawn_error(0, format!("bad request: {error}")),
        }
    }
    let live: Vec<Arc<ManagedProcess>> = manager
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    for managed in live {
        managed.terminate();
    }
}
