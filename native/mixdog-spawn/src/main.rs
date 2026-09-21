use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::{metadata, File, OpenOptions};
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
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

mod wire;
use wire::*;
mod process;
use process::*;
mod output;
use output::*;

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

// Task Manager groups its Processes rows by AppUserModelID, so a helper with no
// identity of its own lists itself beside the app that spawned it rather than
// inside it. Claim the desktop app's AUMID (electron-builder.yml `appId`); see
// mixdog-graph/src/main.rs for the full account. Cosmetic and best-effort.
#[cfg(windows)]
fn adopt_desktop_app_identity() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let app_id: Vec<u16> = "io.mixdog.desktop\0".encode_utf16().collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}
const DEFAULT_OUTPUT_LIMIT: usize = 100 * 1024 * 1024;
const TAIL_LIMIT: usize = 64 * 1024;
// File capture has no pump thread counting bytes, so the output cap is
// enforced by polling file sizes. Short enough to catch a runaway writer in
// seconds, long enough that two stat calls per interval cost nothing.
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn run_spawn(req: SpawnRequest, manager: Arc<Manager>) {
    let id = req.id;
    let capture_files = open_capture_files(req.stdout_path.as_deref(), req.stderr_path.as_deref());
    let file_capture = capture_files.is_some();
    let mut cmd = Command::new(&req.program);
    cmd.args(&req.args).stdin(if req.stdin_pipe {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    match capture_files {
        Some((out_file, err_file)) => {
            cmd.stdout(Stdio::from(out_file))
                .stderr(Stdio::from(err_file));
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
    // A supplied job id tracks foreground work from spawn time without
    // changing its streaming behavior. `background` controls stream/retention;
    // identity and ownership are orthogonal.
    let job_id = req
        .job_id
        .clone()
        .or_else(|| req.background.then(|| format!("job_{}_{}", now_ms(), id)));
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
        retained: AtomicBool::new(req.background),
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
    if file_capture {
        arm_output_size_watchdog(
            Arc::clone(&managed),
            req.stdout_path.clone().unwrap_or_default(),
            req.stderr_path.clone().unwrap_or_default(),
        );
    }

    // File capture leaves both handles None, so the pump threads below are
    // skipped and out_done/err_done start already satisfied.
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
    // Final sizes and preview tails before the terminal snapshot: the watchdog
    // polls on an interval, so everything written since its last tick would
    // otherwise be missing from the completion envelope.
    if file_capture {
        refresh_capture_state(
            &managed,
            req.stdout_path.as_deref().unwrap_or(""),
            req.stderr_path.as_deref().unwrap_or(""),
        );
    }
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
    // Foreground identities exist only while the process is live. A promoted
    // or explicitly-background task is retained for later task read/list.
    if !managed.retained.load(Ordering::Acquire) {
        let job_id = managed
            .state
            .lock()
            .ok()
            .and_then(|state| state.job_id.clone());
        if let Some(job_id) = job_id {
            manager
                .jobs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&job_id);
            emit(&json!({ "id": id, "event": "task_released", "jobId": job_id }));
        }
    } else {
        prune_retained_jobs(&manager);
    }
    emit(&json!({
        "id": id,
        "event": "exit",
        "code": exit_code,
        "signal": signal,
    }));
}

fn track(req: TrackRequest, manager: &Arc<Manager>) {
    let managed = manager
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&req.track)
        .cloned();
    let Some(managed) = managed else {
        spawn_error(req.id, "native process is no longer running");
        return;
    };
    if let Ok(mut state) = managed.state.lock() {
        state.job_id = Some(req.job_id.clone());
        state.update_metadata(
            req.command,
            req.cwd,
            req.shell_type,
            req.owner_session_id,
            req.client_host_pid,
        );
    }
    manager
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.job_id, Arc::clone(&managed));
    emit_task(req.id, "task_started", &managed);
}

fn promote(req: PromoteRequest, manager: &Arc<Manager>) {
    let managed = manager
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&req.promote_task)
        .cloned();
    let Some(managed) = managed else {
        spawn_error(req.id, format!("task not found: {}", req.promote_task));
        return;
    };
    managed.retained.store(true, Ordering::Release);
    if let Ok(mut state) = managed.state.lock() {
        state.update_metadata(
            req.command,
            req.cwd,
            req.shell_type,
            req.owner_session_id,
            req.client_host_pid,
        );
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
            "fileCapture": true
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
            Ok(WireRequest::Track(req)) => track(req, &manager),
            Ok(WireRequest::Promote(req)) => promote(req, &manager),
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
            Ok(WireRequest::CancelOwner {
                id,
                cancel_owner_session,
            }) => {
                let live: Vec<Arc<ManagedProcess>> = manager
                    .live
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .cloned()
                    .collect();
                let mut cancelled = 0usize;
                for managed in live {
                    if let Ok(mut state) = managed.state.lock() {
                        if state.owner_session_id.as_deref() != Some(cancel_owner_session.as_str())
                            || managed.done.load(Ordering::Acquire)
                            || state.status != "running"
                        {
                            continue;
                        }
                        state.killed = true;
                        state.status = "cancelled".to_string();
                        state.error =
                            Some("cancelled because the owning session closed".to_string());
                        managed.terminate();
                        cancelled += 1;
                    }
                }
                emit(&json!({ "id": id, "event": "owner_cancelled", "count": cancelled }));
            }
            Ok(WireRequest::ReleaseTask { id, release_task }) => {
                // Drop a SETTLED task's retained slot. A live task keeps its
                // slot: releasing it would strand a running process with no
                // way left to observe or cancel it.
                let released = {
                    let mut jobs = manager.jobs.lock().unwrap_or_else(|e| e.into_inner());
                    match jobs.get(&release_task) {
                        Some(managed) if managed.done.load(Ordering::Acquire) => {
                            jobs.remove(&release_task);
                            true
                        }
                        _ => false,
                    }
                };
                if released {
                    emit(&json!({ "id": id, "event": "task_released", "jobId": release_task }));
                } else {
                    emit(&json!({
                        "id": id,
                        "event": "task_release_declined",
                        "jobId": release_task,
                    }));
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
    // Shutdown reap, on client EOF. A child still bound to a FOREGROUND call
    // dies here: its caller is gone and nothing will ever read its result.
    // A RETAINED task is the opposite — the client promoted it on purpose and
    // owns cancelTask / cancelOwnerSession to end it deliberately. Killing
    // those here destroyed the very artifact the caller asked for: a server a
    // task required, left running by design, died the instant the agent
    // process exited (2026-08-23, pypi-server).
    let live: Vec<Arc<ManagedProcess>> = manager
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    for managed in live {
        if managed.retained.load(Ordering::Acquire) {
            continue;
        }
        managed.terminate();
    }
}
