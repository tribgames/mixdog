use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions, metadata};
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::process::ExitStatus;
#[cfg(unix)]
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};

#[cfg(windows)]
mod console_hosts;
mod wire;
use wire::*;
mod lifecycle;
use lifecycle::*;
mod requests;
use requests::*;
mod process;
use process::*;
mod output;
use output::*;
#[cfg(windows)]
mod winspawn;

#[cfg(windows)]
type ChildProcess = winspawn::WinProcess;
#[cfg(unix)]
type ChildProcess = Child;

/// A started command's root process and the parent's ends of its pipes.
struct StartedChild {
    process: ChildProcess,
    stdin: Option<Box<dyn Write + Send>>,
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
}

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
const KILL_VERIFY: Duration = Duration::from_millis(5_000);
#[cfg(windows)]
const LATE_EMPTY_POLL: Duration = Duration::from_millis(500);
#[cfg(windows)]
const LATE_VERIFY_DEADLINE: Duration = Duration::from_secs(60);
#[cfg(windows)]
const LATE_FAILURE_LIMIT: u32 = 10;
#[cfg(windows)]
const KEPT_WATCH: Duration = Duration::from_secs(60);

// Task Manager groups Processes rows by AppUserModelID; claiming the desktop app's
// (electron-builder.yml `appId`) lists the helper inside it.
#[cfg(windows)]
fn adopt_desktop_app_identity() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let app_id: Vec<u16> = "io.mixdog.desktop\0".encode_utf16().collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}
// On client EOF, queued events are given this long to be written.
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(2);
const DEFAULT_OUTPUT_LIMIT: usize = 100 * 1024 * 1024;
const TAIL_LIMIT: usize = 64 * 1024;
const SIZE_WATCHDOG_INTERVAL_MS: u64 = 5_000;

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
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

/// The child's kernel creation time as a FILETIME (100 ns ticks since 1601
/// UTC). Windows keeps a dead parent's pid in its children's parent links and
/// soon hands that pid to a new process; the runtime compares this time with
/// the process table's creation dates so those older processes are not taken
/// for this child's descendants.
#[cfg(windows)]
fn creation_filetime(child: &ChildProcess) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(child.as_raw_handle().cast(), &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

#[cfg(windows)]
fn start_child(req: &SpawnRequest, capture_files: Option<(File, File)>, control: &ProcessControl) -> std::io::Result<StartedChild> {
    use std::os::windows::io::AsHandle;
    let stdin = if req.stdin_pipe { Some(std::io::pipe()?) } else { None };
    let (stdout, stderr) = match capture_files {
        Some(_) => (None, None),
        None => (Some(std::io::pipe()?), Some(std::io::pipe()?)),
    };
    let env: Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> = req.env.as_ref().map(|env| env.iter().map(|(k, v)| (k.into(), v.into())).collect());
    let mut command_line = winspawn::quote_windows_arg(&req.program);
    for arg in &req.args {
        command_line.push(' ');
        command_line.push_str(&winspawn::quote_windows_arg(arg));
    }
    let cwd = req.cwd.as_deref().filter(|cwd| !cwd.is_empty()).map(std::path::Path::new);
    let process = winspawn::spawn(
        control.handle,
        &winspawn::Spawn {
            program: &req.program,
            command_line: &command_line,
            cwd,
            env: env.as_deref(),
            stdio: winspawn::Stdio::Handles {
                stdin: stdin.as_ref().map(|(read, _)| read.as_handle()),
                stdout: capture_files.as_ref().map(|(out_file, _)| out_file.as_handle()).or_else(|| stdout.as_ref().map(|(_, write)| write.as_handle())),
                stderr: capture_files.as_ref().map(|(_, err_file)| err_file.as_handle()).or_else(|| stderr.as_ref().map(|(_, write)| write.as_handle())),
            },
        },
    )?;
    // The ends the child owns close here (the pipe tuples drop their write halves), so each
    // reader ends with the child's tree.
    Ok(StartedChild {
        process,
        stdin: stdin.map(|(_, write)| Box::new(write) as Box<dyn Write + Send>),
        stdout: stdout.map(|(read, _)| Box::new(read) as Box<dyn Read + Send>),
        stderr: stderr.map(|(read, _)| Box::new(read) as Box<dyn Read + Send>),
    })
}

#[cfg(unix)]
fn start_child(req: &SpawnRequest, capture_files: Option<(File, File)>) -> std::io::Result<StartedChild> {
    let mut child = build_command(req, capture_files).spawn()?;
    Ok(StartedChild {
        stdin: child.stdin.take().map(|pipe| Box::new(pipe) as Box<dyn Write + Send>),
        stdout: child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        stderr: child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        process: child,
    })
}

#[cfg(unix)]
fn build_command(req: &SpawnRequest, capture_files: Option<(File, File)>) -> Command {
    let mut cmd = Command::new(&req.program);
    cmd.args(&req.args).stdin(if req.stdin_pipe { Stdio::piped() } else { Stdio::null() });
    match capture_files {
        Some((out_file, err_file)) => {
            cmd.stdout(Stdio::from(out_file)).stderr(Stdio::from(err_file));
        }
        None => {
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        }
    }
    if let Some(cwd) = req.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &req.env {
        cmd.env_clear();
        cmd.envs(env);
    }
    cmd.process_group(0);
    cmd
}

fn initial_task_state(req: &SpawnRequest, job_id: Option<String>, output_limit: usize, contained: bool) -> TaskState {
    TaskState {
        job_id,
        status: "running".to_string(),
        command: req.command.clone().unwrap_or_else(|| format!("{} {}", req.program, req.args.join(" "))),
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
        contained,
        tree: Tree::Open,
        reported: false,
        breakaway_unrestored: false,
    }
}

type Pump = (Arc<AtomicBool>, Option<thread::JoinHandle<()>>);

fn start_pump<R: Read + Send + 'static>(id: u64, kind: &'static str, pipe: Option<R>, managed: &Arc<ManagedProcess>, stream: bool, raw_output: bool) -> Pump {
    let done = Arc::new(AtomicBool::new(pipe.is_none()));
    let thread = pipe.map(|pipe| {
        let managed = Arc::clone(managed);
        let done = Arc::clone(&done);
        thread::spawn(move || {
            pump_pipe(id, kind, pipe, managed, stream, raw_output);
            done.store(true, Ordering::Release);
        })
    });
    (done, thread)
}

/// Wait up to 2s (200 x 10ms) for every pump to drain, then join only the
/// pumps that did.
fn join_drained_pumps(pumps: [Pump; 2]) {
    for _ in 0..200 {
        if pumps.iter().all(|(done, _)| done.load(Ordering::Acquire)) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    for (done, thread) in pumps {
        if done.load(Ordering::Acquire) {
            if let Some(thread) = thread {
                let _ = thread.join();
            }
        }
    }
}

fn emit_spawned(id: u64, child: &ChildProcess, contained: bool) {
    #[allow(unused_mut)]
    let mut spawned = json!({ "id": id, "event": "spawned", "pid": child.id() });
    #[cfg(windows)]
    if let Some(created) = creation_filetime(child) {
        // A string: FILETIME values exceed the integers JSON readers keep exact.
        spawned["creationTime"] = json!(created.to_string());
    }
    if contained {
        spawned["contained"] = json!(true);
    }
    emit(&spawned);
}

fn emit_root_exit(id: u64, status: &std::io::Result<ExitStatus>) {
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
}

fn run_spawn(req: SpawnRequest, manager: Arc<Manager>) {
    let id = req.id;
    // The id is reserved before anything is spawned: a request reusing the
    // id of a command still registered (running, or keeping survivors) is
    // refused and spawns nothing, so it never takes that command's place.
    if !manager.reserve(id) {
        spawn_error(id, format!("request id {id} was already used by a spawn in this session"));
        return;
    }
    let capture_files = open_capture_files(req.stdout_path.as_deref(), req.stderr_path.as_deref());
    let file_capture = capture_files.is_some();

    // Windows only; a POSIX command's process group is its only boundary.
    let contained = cfg!(windows) && req.contain;
    #[cfg(windows)]
    let control = match ProcessControl::create(contained) {
        Ok(control) => control,
        Err(error) => {
            spawn_io_error(id, error);
            return;
        }
    };

    #[cfg(windows)]
    let started = start_child(&req, capture_files, &control);
    #[cfg(unix)]
    let started = start_child(&req, capture_files);
    let StartedChild { process: mut child, stdin: stdin_handle, stdout: child_stdout, stderr: child_stderr } = match started {
        Ok(started) => started,
        Err(error) => {
            spawn_io_error(id, error);
            return;
        }
    };
    let pid = child.id();
    #[cfg(unix)]
    let control = ProcessControl { pid };

    let output_limit = if req.output_limit > 0 { req.output_limit } else { DEFAULT_OUTPUT_LIMIT };
    // A supplied job id tracks foreground work from spawn time without
    // changing its streaming behavior. `background` controls stream/retention;
    // identity and ownership are orthogonal.
    let job_id = req.job_id.clone().or_else(|| req.background.then(|| format!("job_{}_{}", now_ms(), id)));
    let managed = Arc::new(ManagedProcess {
        request_id: id,
        pid,
        control,
        state: Mutex::new(initial_task_state(&req, job_id.clone(), output_limit, contained)),
        done: AtomicBool::new(false),
        retained: AtomicBool::new(req.background),
        stdin: Mutex::new(stdin_handle),
    });
    // Registered once it runs in its job, until nothing is left to decide
    // about it. One registered after the shutdown reap's walk gets the reap's
    // decision here.
    if manager.register(id, &managed) {
        shutdown_held(&managed, &manager, &mut managed.lock_state());
    }
    if let Some(job_id) = &job_id {
        manager.lock_jobs().insert(job_id.clone(), Arc::clone(&managed));
    }

    emit_spawned(id, &child, contained);
    if job_id.is_some() {
        emit_task(id, "task_started", &managed);
    }
    arm_timeout(Arc::clone(&managed), req.timeout_ms);
    if file_capture {
        arm_output_size_watchdog(Arc::clone(&managed), req.stdout_path.clone().unwrap_or_default(), req.stderr_path.clone().unwrap_or_default());
    }

    // File capture leaves both handles None, so the pump threads below are
    // skipped and both drained flags start already satisfied.
    let stream = !req.background;
    let stdout_pump = start_pump(id, "stdout", child_stdout, &managed, stream, req.raw_output);
    let stderr_pump = start_pump(id, "stderr", child_stderr, &managed, stream, req.raw_output);

    let status = child.wait();
    if file_capture {
        refresh_capture_state(&managed, req.stdout_path.as_deref().unwrap_or(""), req.stderr_path.as_deref().unwrap_or(""), false);
    }
    let exited_on_its_own = {
        let state = managed.lock_state();
        let natural = status.is_ok() && !state.killed && !state.timed_out && state.status == "running";
        if !(natural && contained) {
            managed.done.store(true, Ordering::Release);
        }
        if natural && !contained {
            let _ = managed.preserve_descendants();
        }
        natural
    };
    emit_root_exit(id, &status);
    // The tree is settled beside the pump drain: neither waits on the other.
    thread::scope(|scope| {
        let tree = scope.spawn(|| settle_tree(&managed, &manager, exited_on_its_own));
        join_drained_pumps([stdout_pump, stderr_pump]);
        let _ = tree.join();
    });
    managed.done.store(true, Ordering::Release);
    finalize_process(id, &managed, &manager, status);
}

/// Settle the terminal state, publish the completion events, and release or
/// retain the job identity once the root process and its pumps are done.
fn finalize_process(id: u64, managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, status: std::io::Result<ExitStatus>) {
    {
        let mut state = managed.lock_state();
        settle_exit(&mut state, status);
        state.reported = true;
        deregister_held(manager, managed, &state);
    }
    let (exit_code, signal) = managed.state.lock().map(|state| (state.exit_code, state.signal.clone())).unwrap_or((None, None));
    if managed.snapshot().is_some() {
        emit_task(id, "task_complete", managed);
    }
    // Foreground identities exist only while the process is live. A promoted
    // or explicitly-background task is retained for later task read/list.
    if !managed.retained.load(Ordering::Acquire) {
        let job_id = managed.state.lock().ok().and_then(|state| state.job_id.clone());
        if let Some(job_id) = job_id {
            manager.lock_jobs().remove(&job_id);
            emit(&json!({ "id": id, "event": "task_released", "jobId": job_id }));
        }
    } else {
        prune_retained_jobs(manager);
    }
    let mut exit = json!({
        "id": id,
        "event": "exit",
        "code": exit_code,
        "signal": signal,
    });
    // The current tree (a late verdict may already have ended Killing), read
    // and queued in one hold: no tree event can fall between.
    let state = managed.lock_state();
    if state.contained {
        exit["treeOutcome"] = json!(state.tree.wire());
        if state.breakaway_unrestored {
            exit["breakawayRestored"] = json!(false);
        }
    }
    emit(&exit);
}

fn track(req: TrackRequest, manager: &Arc<Manager>) {
    let managed = manager.live_process(req.track);
    let Some(managed) = managed else {
        spawn_error(req.id, "native process is no longer running");
        return;
    };
    if let Ok(mut state) = managed.state.lock() {
        state.job_id = Some(req.job_id.clone());
        state.update_metadata(req.command, req.cwd, req.shell_type, req.owner_session_id, req.client_host_pid);
    }
    manager.lock_jobs().insert(req.job_id, Arc::clone(&managed));
    emit_task(req.id, "task_started", &managed);
}

fn promote(req: PromoteRequest, manager: &Arc<Manager>) {
    let managed = manager.job(&req.promote_task);
    let Some(managed) = managed else {
        spawn_error(req.id, format!("task not found: {}", req.promote_task));
        return;
    };
    managed.retained.store(true, Ordering::Release);
    if let Ok(mut state) = managed.state.lock() {
        state.update_metadata(req.command, req.cwd, req.shell_type, req.owner_session_id, req.client_host_pid);
    }
    arm_timeout(Arc::clone(&managed), req.timeout_ms);
    emit_task(req.id, "task_started", &managed);
}

fn main() {
    adopt_desktop_app_identity();
    #[cfg(unix)]
    close_inherited_file_descriptors();
    emit(&json!({
        "ready": true,
        "caps": {
            "stdinPipe": true,
            "trackedForeground": true,
            "promoteTask": true,
            "cancelOwner": true,
            "releaseTask": true,
            "fileCapture": true,
            // `contain` spawns: breakaway refused; `treeOutcome` on `exit` and
            // in task snapshots, `tree_empty` / `tree_unverified` events.
            "verifiedContainment": cfg!(windows)
        }
    }));
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
            Ok(WireRequest::StdinWrite { stdin_write, data, close }) => stdin_write_request(&manager, stdin_write, data, close),
            Ok(WireRequest::StdinClose { stdin_close }) => stdin_close_request(&manager, stdin_close),
            Ok(WireRequest::Cancel { cancel }) => cancel_request(&manager, cancel),
            Ok(WireRequest::Track(req)) => track(req, &manager),
            Ok(WireRequest::Promote(req)) => promote(req, &manager),
            Ok(WireRequest::CancelTask { id, cancel_task }) => cancel_task_request(&manager, id, &cancel_task),
            Ok(WireRequest::CancelOwner { id, cancel_owner_session }) => cancel_owner_request(&manager, id, &cancel_owner_session),
            Ok(WireRequest::ReleaseTask { id, release_task }) => release_task_request(&manager, id, release_task),
            Ok(WireRequest::TaskStatus { id, task_status }) => task_status_request(&manager, id, &task_status),
            Ok(WireRequest::TaskList { id, task_list }) => task_list_request(&manager, id, task_list),
            Err(error) => spawn_error(0, format!("bad request: {error}")),
        }
    }
    reap_on_shutdown(&manager);
    // What is queued goes out if the client still reads; one that stopped
    // reading cannot hold the exit.
    drain_output(SHUTDOWN_DRAIN);
}

fn reap_on_shutdown(manager: &Manager) {
    for managed in manager.close() {
        shutdown_held(&managed, manager, &mut managed.lock_state());
    }
}

fn shutdown_held(managed: &ManagedProcess, manager: &Manager, state: &mut TaskState) {
    if !state.contained {
        if !managed.retained.load(Ordering::Acquire) {
            managed.terminate();
        }
        return;
    }
    match state.tree {
        Tree::Open => {
            kill_running(managed, state);
        }
        Tree::Killing => managed.terminate(),
        Tree::Preserved => {
            release_held(managed, state);
            deregister_held(manager, managed, state);
            emit_tree(managed.request_id, state);
        }
        Tree::Empty | Tree::Unverified | Tree::Released => {}
    }
}

#[cfg(test)]
mod tests;
