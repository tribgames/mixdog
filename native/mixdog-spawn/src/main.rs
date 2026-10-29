use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs::{metadata, File, OpenOptions};
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
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
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
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
// The root starts suspended and runs only once it is in its job.
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;
// A killed contained job is verified empty for this long before the command's
// completion is reported. One still occupied then is watched on (its kill
// re-issued) at LATE_EMPTY_POLL, for at most LATE_VERIFY_DEADLINE and
// LATE_FAILURE_LIMIT consecutive failed queries or kills; then it is reported
// unverified and its job handle is let go.
#[cfg(windows)]
const KILL_VERIFY: Duration = Duration::from_millis(5_000);
#[cfg(windows)]
const LATE_EMPTY_POLL: Duration = Duration::from_millis(500);
#[cfg(windows)]
const LATE_VERIFY_DEADLINE: Duration = Duration::from_secs(60);
#[cfg(windows)]
const LATE_FAILURE_LIMIT: u32 = 10;
// A root that exited on its own leaves its console host for a moment: the job
// is given this long to empty before what remains is taken for survivors.
#[cfg(windows)]
const EXIT_SETTLE: Duration = Duration::from_millis(500);
// Those survivors are kept in their job (breakaway still refused) and watched
// at LATE_EMPTY_POLL for at most KEPT_WATCH: a targeted cancel kills them
// through the job, an emptied job is reported, and at the deadline they are
// let go (breakaway allowed again, the handle closed, RELEASED reported).
#[cfg(windows)]
const KEPT_WATCH: Duration = Duration::from_secs(60);

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
// On client EOF, queued events are given this long to be written.
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(2);
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

/// The child's kernel creation time as a FILETIME (100 ns ticks since 1601
/// UTC). Windows keeps a dead parent's pid in its children's parent links and
/// soon hands that pid to a new process; the runtime compares this time with
/// the process table's creation dates so those older processes are not taken
/// for this child's descendants.
#[cfg(windows)]
fn creation_filetime(child: &Child) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe {
        GetProcessTimes(
            child.as_raw_handle().cast(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    (ok != 0).then(|| {
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
    })
}

/// The child command a spawn request describes: stdio wiring (capture files
/// when both opened, pipes otherwise), cwd, a replaced environment, and the
/// platform flags that keep the child windowless / in its own process group.
fn build_command(req: &SpawnRequest, capture_files: Option<(File, File)>) -> Command {
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
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

fn initial_task_state(
    req: &SpawnRequest,
    job_id: Option<String>,
    output_limit: usize,
    contained: bool,
) -> TaskState {
    TaskState {
        job_id,
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
        contained,
        tree: Tree::Open,
        reported: false,
        breakaway_unrestored: false,
    }
}

// A contained command's tree is ONE field, TaskState::tree (process.rs Tree),
// reported as `treeOutcome` on `exit` and in task snapshots; the final ones
// also as `tree_empty` / `tree_unverified` / `tree_released`. Every actor that
// moves it (a kill or cancel, settlement, the kept and late watchers, the
// shutdown reap) takes the command's state lock, re-checks the tree there,
// and performs the job action the transition implies (terminate,
// keep_survivors, restore breakaway, let the registry entry go) inside that
// same hold. No actor acts on a tree it read in an earlier hold, so any two
// of them are serialized by that lock, in whichever order they land.
//
//   Open ──kill──▶ Killing ──verified──▶ Empty | Unverified
//   Open ──root exited on its own──▶ Empty | Preserved | Released
//   Preserved ──targeted cancel──▶ Killing
//   Preserved ──watcher──▶ Empty | Released;  ──shutdown──▶ Released

/// The final tree's event, emitted in the hold that made it final. A
/// RELEASED one whose breakaway could not be restored says so
/// (`breakawayRestored: false`): its survivors stay in a job they cannot
/// leave.
fn emit_tree(id: u64, state: &TaskState) {
    let event = match state.tree {
        Tree::Empty => "tree_empty",
        Tree::Unverified => "tree_unverified",
        Tree::Released => "tree_released",
        _ => return,
    };
    let mut message = json!({ "id": id, "event": event });
    if state.breakaway_unrestored {
        message["breakawayRestored"] = json!(false);
    }
    emit(&message);
}

/// Under the state lock: let a contained job's survivors go (RELEASED): no
/// kill on close, breakaway allowed again, every kill refused. RELEASED is
/// final either way. A breakaway that could not be restored is recorded
/// (emit_tree, `exit`, task snapshots) and logged.
fn release_held(managed: &ManagedProcess, state: &mut TaskState) {
    if let Err(error) = managed.preserve_descendants() {
        state.breakaway_unrestored = true;
        eprintln!(
            "mixdog-spawn: request {}: breakaway could not be restored for the survivors let go \
             ({error}); they remain in a job they cannot leave",
            managed.request_id
        );
    }
    state.tree = Tree::Released;
}

/// Under the state lock (`state`): the registry lets the command go once
/// nothing is left to decide: its completion reported and, contained, its
/// tree final. Its job handle goes with the last reference.
fn deregister_held(manager: &Manager, managed: &ManagedProcess, state: &TaskState) {
    if !state.reported || (state.contained && !state.tree.is_final()) {
        return;
    }
    let mut live = manager.lock_live();
    if live
        .get(&managed.request_id)
        .is_some_and(|entry| std::ptr::eq(entry.as_ref(), managed))
    {
        live.remove(&managed.request_id);
    }
}

/// Every kill of a running command, under its state lock (`state`), the kill
/// issued in the same hold. Running: an uncontained command until its root
/// is done; a contained one while its tree is Open (the root runs, or exited
/// on its own and its job still settles), which the kill moves to Killing
/// (settle_tree verifies it). False, and nothing done, otherwise.
fn kill_running(managed: &ManagedProcess, state: &mut TaskState) -> bool {
    if state.contained {
        if state.tree != Tree::Open {
            return false;
        }
        state.tree = Tree::Killing;
    } else if managed.done.load(Ordering::Acquire) {
        return false;
    }
    state.killed = true;
    managed.terminate();
    true
}

/// A targeted cancel, by request id or (`by_task`) by job id: the command
/// while it runs, else the survivors a contained command left kept in its
/// job (kill_kept_held). One state-lock hold.
fn cancel_targeted(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, by_task: bool) {
    let mut state = managed.lock_state();
    if (!by_task || state.status == "running") && kill_running(managed, &mut state) {
        if by_task {
            state.status = "cancelled".to_string();
            state.error = Some("cancelled by task control".to_string());
        }
        return;
    }
    kill_kept_held(managed, manager, &mut state);
}

/// Under the state lock: survivors kept in their job (Preserved) are killed
/// through the job (kill on close again) and verified on their own thread,
/// like any contained kill. Nothing otherwise.
#[cfg(windows)]
fn kill_kept_held(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, state: &mut TaskState) {
    if state.tree != Tree::Preserved {
        return;
    }
    state.tree = Tree::Killing;
    managed.control.rearm();
    managed.terminate();
    let (managed, manager) = (Arc::clone(managed), Arc::clone(manager));
    thread::spawn(move || verify_kill(&managed, &manager));
}

#[cfg(not(windows))]
fn kill_kept_held(_: &Arc<ManagedProcess>, _: &Arc<Manager>, _: &mut TaskState) {}

/// Re-issue the kill of a command still being killed, under its state lock.
#[cfg(windows)]
fn rekill(managed: &ManagedProcess) {
    let state = managed.lock_state();
    if state.tree == Tree::Killing {
        managed.terminate();
    }
}

/// A killed contained job (Killing), verified empty: EMPTY within
/// KILL_VERIFY (its kill re-issued meanwhile), else it stays Killing
/// ("pending") under the bounded late verification (watch_late).
#[cfg(windows)]
fn verify_kill(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>) {
    managed.control.await_empty(KILL_VERIFY, || rekill(managed));
    let mut state = managed.lock_state();
    if state.tree != Tree::Killing {
        return;
    }
    if managed.control.active_processes() == Some(0) {
        state.tree = Tree::Empty;
        deregister_held(manager, managed, &state);
        return emit_tree(managed.request_id, &state);
    }
    drop(state);
    watch_late(
        Arc::clone(managed),
        Arc::clone(manager),
        LATE_EMPTY_POLL,
        LATE_VERIFY_DEADLINE,
        LATE_FAILURE_LIMIT,
    );
}

/// Watch survivors kept in their job (Preserved) at `poll` until a kill or
/// the shutdown reap took them over (the tree is no longer Preserved), the
/// job empties (EMPTY), or `deadline` passes (RELEASED: let go as an
/// uncontained command's survivors are). Each check is one state-lock hold
/// that acts inside it; on its verdict the registry entry, and with it the job
/// handle, is let go.
#[cfg(windows)]
fn watch_kept(
    managed: Arc<ManagedProcess>,
    manager: Arc<Manager>,
    poll: Duration,
    deadline: Duration,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let started = std::time::Instant::now();
        let id = managed.request_id;
        loop {
            thread::sleep(poll);
            pause(id, "watch_kept:check");
            let mut state = managed.lock_state();
            if state.tree != Tree::Preserved {
                return;
            }
            if managed.control.active_processes() == Some(0) {
                state.tree = Tree::Empty;
            } else if started.elapsed() >= deadline {
                release_held(&managed, &mut state);
            } else {
                continue;
            }
            deregister_held(&manager, &managed, &state);
            emit_tree(id, &state);
            drop(state);
            return pause(id, "watch_kept:decided");
        }
    })
}

/// Test builds: a named point at which a test can hold the thread that
/// reaches it (tests::gates), to drive one interleaving deterministically.
#[cfg(all(windows, test))]
fn pause(id: u64, point: &'static str) {
    tests::gates::pause(id, point);
}

#[cfg(all(windows, not(test)))]
#[inline(always)]
fn pause(_id: u64, _point: &'static str) {}

/// After the root's exit. A killed contained job must empty (verify_kill).
/// One whose root exited on its own is given EXIT_SETTLE to empty and stays
/// Open, so killable, meanwhile: a cancel, deadline or the shutdown reap that
/// lands then makes it a killed job (Killing), verified like any other.
/// Otherwise, decided in one state-lock hold: EMPTY; or its survivors, which a
/// natural exit never kills, are kept in the job (PRESERVED, watch_kept),
/// where a later targeted cancel still kills exactly them; or, when the job
/// cannot keep them, they are let go (RELEASED).
#[cfg(windows)]
fn settle_tree(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, exited_on_its_own: bool) {
    let control = &managed.control;
    if !control.contained {
        return;
    }
    let id = managed.request_id;
    if exited_on_its_own {
        control.await_empty(EXIT_SETTLE, || rekill(managed));
        pause(id, "settle:check");
        let mut state = managed.lock_state();
        if state.tree == Tree::Open {
            managed.done.store(true, Ordering::Release);
            if control.active_processes() == Some(0) {
                state.tree = Tree::Empty;
            } else if control.keep_survivors() {
                state.tree = Tree::Preserved;
                watch_kept(
                    Arc::clone(managed),
                    Arc::clone(manager),
                    LATE_EMPTY_POLL,
                    KEPT_WATCH,
                );
            } else {
                release_held(managed, &mut state);
            }
            emit_tree(id, &state);
            drop(state);
            return pause(id, "settle:decided");
        }
    } else {
        // Not on its own: a kill reached it (Killing already), or waiting on
        // it failed and nothing is known: killed now.
        kill_running(managed, &mut managed.lock_state());
    }
    verify_kill(managed, manager);
}

#[cfg(not(windows))]
fn settle_tree(_managed: &Arc<ManagedProcess>, _manager: &Arc<Manager>, _exited_on_its_own: bool) {}

/// The bounded late verification of a killed job that did not empty in time
/// (watch_late). Each check is given the job's process count (None when the
/// query failed) and, while members remain, re-issues the kill. It ends
/// EMPTY, or UNVERIFIED once `deadline` passed or `failure_limit` consecutive
/// queries or kills failed.
#[cfg(any(windows, test))]
struct LateCheck {
    started: std::time::Instant,
    deadline: Duration,
    failure_limit: u32,
    failures: u32,
}

#[cfg(any(windows, test))]
impl LateCheck {
    fn new(deadline: Duration, failure_limit: u32) -> Self {
        Self {
            started: std::time::Instant::now(),
            deadline,
            failure_limit,
            failures: 0,
        }
    }

    fn step(&mut self, active: Option<u32>, kill: impl FnOnce() -> bool) -> Option<Tree> {
        match active {
            Some(0) => return Some(Tree::Empty),
            Some(_) if kill() => self.failures = 0,
            _ => self.failures += 1,
        }
        (self.failures >= self.failure_limit || self.started.elapsed() >= self.deadline)
            .then_some(Tree::Unverified)
    }
}

/// A killed job still occupied after KILL_VERIFY, verified on its own thread.
/// Every check is one state-lock hold (and stops if the tree is no longer
/// Killing). On its verdict it reports EMPTY or UNVERIFIED and lets the
/// registry entry, and with it the job handle, go.
#[cfg(windows)]
fn watch_late(
    managed: Arc<ManagedProcess>,
    manager: Arc<Manager>,
    poll: Duration,
    deadline: Duration,
    failure_limit: u32,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut check = LateCheck::new(deadline, failure_limit);
        loop {
            let mut state = managed.lock_state();
            if state.tree != Tree::Killing {
                return;
            }
            let active = managed.control.active_processes();
            if let Some(tree) = check.step(active, || managed.control.terminate()) {
                state.tree = tree;
                deregister_held(&manager, &managed, &state);
                return emit_tree(managed.request_id, &state);
            }
            drop(state);
            thread::sleep(poll);
        }
    })
}

/// Fold the root process's exit into the task's terminal status, exit code
/// and signal. A timeout, cancellation, recorded error or kill outranks the
/// raw exit status.
fn settle_exit(state: &mut TaskState, status: std::io::Result<ExitStatus>) {
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

/// A pipe pump: its drained flag and its thread. The flag starts true when
/// there is no pipe to pump (file capture).
type Pump = (Arc<AtomicBool>, Option<thread::JoinHandle<()>>);

fn start_pump<R: Read + Send + 'static>(
    id: u64,
    kind: &'static str,
    pipe: Option<R>,
    managed: &Arc<ManagedProcess>,
    stream: bool,
    raw_output: bool,
) -> Pump {
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

fn run_spawn(req: SpawnRequest, manager: Arc<Manager>) {
    let id = req.id;
    // The id is reserved before anything is spawned: a request reusing the
    // id of a command still registered (running, or keeping survivors) is
    // refused and spawns nothing, so it never takes that command's place.
    if !manager.reserve(id) {
        spawn_error(
            id,
            format!("request id {id} was already used by a spawn in this session"),
        );
        return;
    }
    let capture_files = open_capture_files(req.stdout_path.as_deref(), req.stderr_path.as_deref());
    let file_capture = capture_files.is_some();
    let mut cmd = build_command(&req, capture_files);

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
    if let Err(error) = control.assign_and_resume(&child) {
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
        state: Mutex::new(initial_task_state(
            &req,
            job_id.clone(),
            output_limit,
            contained,
        )),
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
        manager
            .lock_jobs()
            .insert(job_id.clone(), Arc::clone(&managed));
    }

    #[allow(unused_mut)]
    let mut spawned = json!({ "id": id, "event": "spawned", "pid": pid });
    #[cfg(windows)]
    if let Some(created) = creation_filetime(&child) {
        // A string: FILETIME values exceed the integers JSON readers keep exact.
        spawned["creationTime"] = json!(created.to_string());
    }
    if contained {
        spawned["contained"] = json!(true);
    }
    emit(&spawned);
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
    // skipped and both drained flags start already satisfied.
    let stream = !req.background;
    let stdout_pump = start_pump(
        id,
        "stdout",
        child.stdout.take(),
        &managed,
        stream,
        req.raw_output,
    );
    let stderr_pump = start_pump(
        id,
        "stderr",
        child.stderr.take(),
        &managed,
        stream,
        req.raw_output,
    );

    let status = child.wait();
    // Final sizes and preview tails before the terminal snapshot: the watchdog
    // polls on an interval, so everything written since its last tick would
    // otherwise be missing from the completion envelope.
    if file_capture {
        refresh_capture_state(
            &managed,
            req.stdout_path.as_deref().unwrap_or(""),
            req.stderr_path.as_deref().unwrap_or(""),
            false,
        );
    }
    // From here no cancel or deadline kills an uncontained command: a root
    // that exited on its own leaves its survivors running, let go in this same
    // hold. A contained one stays killable while its tree is Open
    // (settle_tree), its job first checked for emptiness with breakaway still
    // refused, so nothing can leave it unseen before then.
    let exited_on_its_own = {
        let state = managed.lock_state();
        let natural =
            status.is_ok() && !state.killed && !state.timed_out && state.status == "running";
        if !(natural && contained) {
            managed.done.store(true, Ordering::Release);
        }
        if natural && !contained {
            let _ = managed.preserve_descendants();
        }
        natural
    };
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
fn finalize_process(
    id: u64,
    managed: &Arc<ManagedProcess>,
    manager: &Arc<Manager>,
    status: std::io::Result<ExitStatus>,
) {
    {
        let mut state = managed.lock_state();
        settle_exit(&mut state, status);
        state.reported = true;
        deregister_held(manager, managed, &state);
    }
    let (exit_code, signal) = managed
        .state
        .lock()
        .map(|state| (state.exit_code, state.signal.clone()))
        .unwrap_or((None, None));
    if managed.snapshot().is_some() {
        emit_task(id, "task_complete", managed);
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
        state.update_metadata(
            req.command,
            req.cwd,
            req.shell_type,
            req.owner_session_id,
            req.client_host_pid,
        );
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
            Ok(WireRequest::StdinWrite {
                stdin_write,
                data,
                close,
            }) => stdin_write_request(&manager, stdin_write, data, close),
            Ok(WireRequest::StdinClose { stdin_close }) => {
                stdin_close_request(&manager, stdin_close)
            }
            Ok(WireRequest::Cancel { cancel }) => cancel_request(&manager, cancel),
            Ok(WireRequest::Track(req)) => track(req, &manager),
            Ok(WireRequest::Promote(req)) => promote(req, &manager),
            Ok(WireRequest::CancelTask { id, cancel_task }) => {
                cancel_task_request(&manager, id, &cancel_task)
            }
            Ok(WireRequest::CancelOwner {
                id,
                cancel_owner_session,
            }) => cancel_owner_request(&manager, id, &cancel_owner_session),
            Ok(WireRequest::ReleaseTask { id, release_task }) => {
                release_task_request(&manager, id, release_task)
            }
            Ok(WireRequest::TaskStatus { id, task_status }) => {
                task_status_request(&manager, id, &task_status)
            }
            Ok(WireRequest::TaskList { id, task_list }) => {
                task_list_request(&manager, id, task_list)
            }
            Err(error) => spawn_error(0, format!("bad request: {error}")),
        }
    }
    reap_on_shutdown(&manager);
    // What is queued goes out if the client still reads; one that stopped
    // reading cannot hold the exit.
    drain_output(SHUTDOWN_DRAIN);
}

fn stdin_write_request(manager: &Manager, stdin_write: u64, data: String, close: bool) {
    let managed = manager.live_process(stdin_write);
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

fn stdin_close_request(manager: &Manager, stdin_close: u64) {
    let managed = manager.live_process(stdin_close);
    if let Some(managed) = managed {
        let _ = managed
            .stdin
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

// A request-id cancel reaches the command in whatever state it is registered:
// a finished contained command's kept survivors too, after its completion was
// reported.
fn cancel_request(manager: &Arc<Manager>, cancel: u64) {
    if let Some(managed) = manager.entry(cancel) {
        cancel_targeted(&managed, manager, false);
    }
}

fn cancel_task_request(manager: &Arc<Manager>, id: u64, cancel_task: &str) {
    let managed = manager
        .job(cancel_task)
        .or_else(|| manager.entry_of_job(cancel_task));
    if let Some(managed) = managed {
        cancel_targeted(&managed, manager, true);
    } else {
        spawn_error(id, format!("task not found: {cancel_task}"));
    }
}

// A session close kills its running commands only: the survivors a finished
// command left run on.
fn cancel_owner_request(manager: &Manager, id: u64, cancel_owner_session: &str) {
    let live: Vec<Arc<ManagedProcess>> = manager.lock_live().values().cloned().collect();
    let mut cancelled = 0usize;
    for managed in live {
        let mut state = managed.lock_state();
        if state.owner_session_id.as_deref() == Some(cancel_owner_session)
            && state.status == "running"
            && kill_running(&managed, &mut state)
        {
            state.status = "cancelled".to_string();
            state.error = Some("cancelled because the owning session closed".to_string());
            cancelled += 1;
        }
    }
    emit(&json!({ "id": id, "event": "owner_cancelled", "count": cancelled }));
}

fn release_task_request(manager: &Manager, id: u64, release_task: String) {
    // Drop a SETTLED task's retained slot. A live task keeps its
    // slot: releasing it would strand a running process with no
    // way left to observe or cancel it.
    let released = {
        let mut jobs = manager.lock_jobs();
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

fn task_status_request(manager: &Manager, id: u64, task_status: &str) {
    let managed = manager.job(task_status);
    if let Some(managed) = managed {
        emit_task(id, "task_status", &managed);
    } else {
        spawn_error(id, format!("task not found: {task_status}"));
    }
}

fn task_list_request(manager: &Manager, id: u64, task_list: bool) {
    if !task_list {
        spawn_error(id, "invalid task list request");
        return;
    }
    let tasks: Vec<TaskSnapshot> = manager
        .lock_jobs()
        .values()
        .filter_map(|managed| managed.snapshot())
        .collect();
    emit(&json!({ "id": id, "event": "task_list", "tasks": tasks }));
}

fn reap_on_shutdown(manager: &Manager) {
    // Shutdown reap, on client EOF. A child still bound to a FOREGROUND call
    // dies here: its caller is gone and nothing will ever read its result.
    // A RETAINED task is the opposite — the client promoted it on purpose and
    // owns cancelTask / cancelOwnerSession to end it deliberately. Killing
    // those here destroyed the very artifact the caller asked for: a server a
    // task required, left running by design, died the instant the agent
    // process exited (2026-08-23, pypi-server).
    //
    // Every registered command is decided once, under its state lock
    // (shutdown_held); one registered after this walk decides itself
    // (Manager::register).
    for managed in manager.close() {
        shutdown_held(&managed, manager, &mut managed.lock_state());
    }
}

/// The shutdown reap's decision for one command, under its state lock
/// (`state`), its job action in the same hold. A contained command, retained
/// or not, by its tree:
///  - Open (running, or settling and not yet preserved): killed, so it is
///    never preserved after the server is gone. A retained one's job would
///    kill it anyway as the server exits (kill on close);
///  - Killing: its kill re-issued;
///  - Preserved: its survivors outlive the server, as an uncontained
///    command's do: let go (breakaway allowed again, every kill refused),
///    RELEASED;
///  - final: nothing (Released survivors are let go already).
///
/// An uncontained command as before: killed unless retained.
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
mod tests {
    use super::*;

    const FOREVER: Duration = Duration::from_secs(3_600);

    /// Run a late check to its verdict, one check per `poll`: the verdict and
    /// how many checks it took.
    fn late(
        mut check: LateCheck,
        poll: Duration,
        mut active: impl FnMut() -> Option<u32>,
        mut kill: impl FnMut() -> bool,
    ) -> (Tree, u32) {
        let mut checks = 0;
        loop {
            checks += 1;
            if let Some(tree) = check.step(active(), &mut kill) {
                return (tree, checks);
            }
            thread::sleep(poll);
        }
    }

    #[test]
    fn late_verification_gives_up_after_repeated_failed_queries() {
        let verdict = late(LateCheck::new(FOREVER, 3), Duration::ZERO, || None, || true);
        assert_eq!(verdict, (Tree::Unverified, 3));
    }

    #[test]
    fn late_verification_gives_up_after_repeated_refused_kills() {
        let mut kills = 0;
        let (tree, _) = late(
            LateCheck::new(FOREVER, 3),
            Duration::ZERO,
            || Some(1),
            || {
                kills += 1;
                false
            },
        );
        assert_eq!(tree, Tree::Unverified);
        assert_eq!(kills, 3);
    }

    #[test]
    fn late_verification_gives_up_at_its_deadline_on_a_job_that_never_empties() {
        let started = std::time::Instant::now();
        let (tree, _) = late(
            LateCheck::new(Duration::from_millis(50), u32::MAX),
            Duration::from_millis(1),
            || Some(1),
            || true,
        );
        assert_eq!(tree, Tree::Unverified);
        assert!(started.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn late_verification_reports_a_job_that_empties() {
        let mut members = 3;
        let (tree, _) = late(
            LateCheck::new(FOREVER, 2),
            Duration::ZERO,
            || {
                members -= 1;
                Some(members)
            },
            || true,
        );
        assert_eq!(tree, Tree::Empty);
    }

    /// Hold points (main.rs `pause`). A test holds the thread that next
    /// reaches a point for one command: it learns when that thread got there,
    /// acts, then lets it go on — one interleaving of two actors, driven
    /// deterministically.
    #[cfg(windows)]
    pub(crate) mod gates {
        use std::sync::mpsc::{channel, Receiver, Sender};
        use std::sync::Mutex;
        use std::time::Duration;

        struct Gate {
            id: u64,
            point: &'static str,
            arrived: Sender<()>,
            release: Receiver<()>,
        }

        static GATES: Mutex<Vec<Gate>> = Mutex::new(Vec::new());

        pub(crate) struct Held {
            arrived: Receiver<()>,
            release: Sender<()>,
        }

        impl Held {
            /// Block until the held thread reached its point.
            pub(crate) fn reached(&self) {
                self.arrived
                    .recv_timeout(Duration::from_secs(30))
                    .expect("the thread reached its point");
            }

            /// Let it go on. Dropping a Held lets it go on too.
            pub(crate) fn release(self) {
                let _ = self.release.send(());
            }
        }

        pub(crate) fn hold(id: u64, point: &'static str) -> Held {
            let (arrived, arrived_rx) = channel();
            let (release_tx, release) = channel();
            GATES.lock().unwrap().push(Gate {
                id,
                point,
                arrived,
                release,
            });
            Held {
                arrived: arrived_rx,
                release: release_tx,
            }
        }

        pub(crate) fn pause(id: u64, point: &'static str) {
            let gate = {
                let mut gates = GATES.lock().unwrap_or_else(|e| e.into_inner());
                let at = gates
                    .iter()
                    .position(|gate| gate.id == id && gate.point == point);
                at.map(|at| gates.remove(at))
            };
            if let Some(gate) = gate {
                let _ = gate.arrived.send(());
                let _ = gate.release.recv();
            }
        }
    }

    /// A contained command whose root already exited on its own, leaving
    /// `member` running in its job: the moment settle_tree takes over.
    #[cfg(windows)]
    mod contained {
        use super::*;

        /// Killed (and reaped) when dropped: a process this test started.
        struct Member(Child);

        impl Drop for Member {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        fn exited_root_with_member(id: u64) -> (Arc<Manager>, Arc<ManagedProcess>, Member) {
            exited_root_with(id, "60")
        }

        /// `pings`: the member's lifetime in seconds, roughly.
        fn exited_root_with(id: u64, pings: &str) -> (Arc<Manager>, Arc<ManagedProcess>, Member) {
            let request: SpawnRequest = serde_json::from_value(json!({
                "id": id,
                "program": "ping",
                "contain": true,
                "ownerSessionId": "sess_kept",
            }))
            .unwrap();
            let control = ProcessControl::create(true).unwrap();
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            let member = Command::new(format!("{root}\\System32\\PING.EXE"))
                .args(["-n", pings, "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
                .spawn()
                .unwrap();
            control.assign_and_resume(&member).unwrap();
            let managed = Arc::new(ManagedProcess {
                request_id: id,
                pid: member.id(),
                control,
                state: Mutex::new(initial_task_state(
                    &request,
                    Some(format!("job_{id}")),
                    0,
                    true,
                )),
                done: AtomicBool::new(false),
                retained: AtomicBool::new(false),
                stdin: Mutex::new(None),
            });
            let manager = Arc::new(Manager::new());
            // As run_spawn: reserved, then registered.
            assert!(manager.reserve(id));
            assert!(!manager.register(id, &managed));
            (manager, managed, Member(member))
        }

        fn tree(managed: &ManagedProcess) -> Tree {
            managed.lock_state().tree
        }

        /// Whether the tree becomes `want` within 10 s.
        fn becomes(managed: &ManagedProcess, want: Tree) -> bool {
            (0..1_000).any(|_| {
                let reached = tree(managed) == want;
                if !reached {
                    thread::sleep(Duration::from_millis(10));
                }
                reached
            })
        }

        /// The command's completion reported, as finalize_process does.
        fn report(manager: &Manager, managed: &ManagedProcess) {
            let mut state = managed.lock_state();
            state.reported = true;
            deregister_held(manager, managed, &state);
        }

        /// Its root exited on its own and settlement kept its survivors in
        /// the job (as settle_tree decides), watched with a short deadline.
        fn preserved(
            manager: &Arc<Manager>,
            managed: &Arc<ManagedProcess>,
            deadline: Duration,
        ) -> thread::JoinHandle<()> {
            let mut state = managed.lock_state();
            assert!(managed.control.keep_survivors());
            managed.done.store(true, Ordering::Release);
            state.tree = Tree::Preserved;
            watch_kept(
                Arc::clone(managed),
                Arc::clone(manager),
                Duration::from_millis(5),
                deadline,
            )
        }

        fn settle_on_thread(
            manager: &Arc<Manager>,
            managed: &Arc<ManagedProcess>,
        ) -> thread::JoinHandle<()> {
            let (manager, managed) = (Arc::clone(manager), Arc::clone(managed));
            thread::spawn(move || settle_tree(&managed, &manager, true))
        }

        /// Still running a while later.
        fn alive(member: &mut Member) -> bool {
            thread::sleep(Duration::from_millis(300));
            member.0.try_wait().unwrap().is_none()
        }

        /// The survivors were let go: no kill on close, breakaway allowed
        /// again, and the server refuses to kill them.
        fn let_go(managed: &ManagedProcess) -> bool {
            managed.control.limit_flags() == JOB_OBJECT_LIMIT_BREAKAWAY_OK
                && !managed.control.terminate()
        }

        // The job counts a process out as it exits; its handle is signalled a
        // moment later.
        fn exits(member: &mut Member) -> bool {
            (0..100).any(|_| {
                thread::sleep(Duration::from_millis(10));
                member.0.try_wait().unwrap().is_some()
            })
        }

        /// Whether the registry lets request `id` go within 10 s.
        fn deregistered(manager: &Manager, id: u64) -> bool {
            (0..1_000).any(|_| {
                let gone = manager.entry(id).is_none();
                if !gone {
                    thread::sleep(Duration::from_millis(10));
                }
                gone
            })
        }

        #[test]
        fn a_cancel_that_lands_after_a_natural_exit_kills_and_verifies_the_job() {
            let (manager, managed, mut member) = exited_root_with_member(41);
            // The root exited on its own, so its tree is Open while it
            // settles: this cancel is not refused.
            cancel_request(&manager, 41);
            assert_eq!(tree(&managed), Tree::Killing);
            settle_tree(&managed, &manager, true);
            assert_eq!(tree(&managed), Tree::Empty);
            assert!(exits(&mut member), "the survivor died with the job");
        }

        #[test]
        fn a_cancel_after_the_command_was_reported_kills_its_kept_survivors_through_the_job() {
            let (manager, managed, mut member) = exited_root_with_member(42);
            settle_tree(&managed, &manager, true);
            assert_eq!(tree(&managed), Tree::Preserved);
            report(&manager, &managed);
            assert!(manager.entry(42).is_some(), "still registered: kept");
            cancel_request(&manager, 42);
            assert!(
                becomes(&managed, Tree::Empty),
                "verified empty: {:?}",
                tree(&managed)
            );
            assert!(exits(&mut member), "the survivor died with the job");
            assert!(deregistered(&manager, 42), "the job handle is let go");
        }

        #[test]
        fn a_task_cancel_after_the_command_was_reported_reaches_its_kept_survivors() {
            let (manager, managed, mut member) = exited_root_with_member(44);
            settle_tree(&managed, &manager, true);
            report(&manager, &managed);
            cancel_task_request(&manager, 99, "job_44");
            assert!(
                becomes(&managed, Tree::Empty),
                "verified empty: {:?}",
                tree(&managed)
            );
            assert!(exits(&mut member));
        }

        #[test]
        fn a_session_close_leaves_the_survivors_of_a_finished_command_running() {
            let (manager, managed, mut member) = exited_root_with_member(45);
            settle_tree(&managed, &manager, true);
            report(&manager, &managed);
            cancel_owner_request(&manager, 1, "sess_kept");
            assert!(alive(&mut member), "the survivor runs on");
            assert_eq!(tree(&managed), Tree::Preserved);
        }

        #[test]
        fn kept_survivors_that_exit_on_their_own_are_reported_empty() {
            // About a second: past the settle window, well inside the watch.
            let (manager, managed, mut member) = exited_root_with(46, "2");
            settle_tree(&managed, &manager, true);
            assert_eq!(tree(&managed), Tree::Preserved);
            report(&manager, &managed);
            assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
            assert!(exits(&mut member));
            assert!(deregistered(&manager, 46));
        }

        #[test]
        fn kept_survivors_are_let_go_at_the_watch_deadline() {
            let (manager, managed, mut member) = exited_root_with_member(47);
            report(&manager, &managed);
            let watcher = preserved(&manager, &managed, Duration::from_millis(50));
            watcher.join().unwrap();
            assert_eq!(tree(&managed), Tree::Released);
            assert!(manager.entry(47).is_none());
            assert_eq!(Arc::strong_count(&managed), 1, "the job handle is let go");
            assert!(let_go(&managed));
            cancel_request(&manager, 47);
            assert!(alive(&mut member), "the survivor runs on");
        }

        #[test]
        fn a_late_verification_that_cannot_kill_gives_up_and_lets_the_job_go() {
            let (manager, managed, mut member) = exited_root_with_member(43);
            report(&manager, &managed);
            // From now on the job kill is refused, so the member never leaves.
            managed.preserve_descendants().unwrap();
            managed.lock_state().tree = Tree::Killing;
            watch_late(
                Arc::clone(&managed),
                Arc::clone(&manager),
                Duration::from_millis(5),
                FOREVER,
                3,
            )
            .join()
            .unwrap();
            assert_eq!(tree(&managed), Tree::Unverified);
            assert!(manager.entry(43).is_none());
            assert_eq!(Arc::strong_count(&managed), 1, "the watcher let the job go");
            assert!(member.0.try_wait().unwrap().is_none(), "never claimed gone");
        }

        // ---- Each pair of actors that can race, in both orders. Every
        // ---- interleaving is held at a `pause` point, so it is exact.

        // settle vs shutdown: the reap lands while the job still settles.
        #[test]
        fn shutdown_while_the_tree_settles_kills_it_and_settlement_verifies_the_kill() {
            let (manager, managed, mut member) = exited_root_with_member(50);
            let held = gates::hold(50, "settle:check");
            let settling = settle_on_thread(&manager, &managed);
            held.reached();
            reap_on_shutdown(&manager);
            assert_eq!(tree(&managed), Tree::Killing, "killed by the reap");
            held.release();
            settling.join().unwrap();
            assert_eq!(tree(&managed), Tree::Empty, "never preserved after it");
            assert!(exits(&mut member));
        }

        // settle vs shutdown: settlement kept the survivors, then the reap.
        #[test]
        fn shutdown_after_settlement_kept_the_survivors_lets_them_go_never_kills_them() {
            let (manager, managed, mut member) = exited_root_with_member(51);
            let held = gates::hold(51, "settle:decided");
            let settling = settle_on_thread(&manager, &managed);
            held.reached();
            assert_eq!(tree(&managed), Tree::Preserved);
            reap_on_shutdown(&manager);
            assert_eq!(tree(&managed), Tree::Released);
            assert!(alive(&mut member), "the survivor outlives the server");
            assert!(let_go(&managed));
            held.release();
            settling.join().unwrap();
            assert!(alive(&mut member));
        }

        // watcher release vs shutdown: the watcher let the survivors go at
        // its deadline, then the reap (it used to see RELEASED and kill).
        #[test]
        fn shutdown_after_the_watcher_released_the_survivors_never_kills_them() {
            let (manager, managed, mut member) = exited_root_with_member(52);
            let held = gates::hold(52, "watch_kept:decided");
            let watcher = preserved(&manager, &managed, Duration::from_millis(50));
            held.reached();
            assert_eq!(tree(&managed), Tree::Released);
            reap_on_shutdown(&manager);
            assert!(alive(&mut member), "the survivor outlives the server");
            assert!(let_go(&managed));
            held.release();
            watcher.join().unwrap();
            assert!(alive(&mut member));
        }

        // watcher release vs shutdown: the reap lands first; past its
        // deadline the watcher finds the survivors no longer kept.
        #[test]
        fn shutdown_before_the_watcher_decides_lets_the_survivors_go_and_the_watcher_stands_down() {
            let (manager, managed, mut member) = exited_root_with_member(53);
            let held = gates::hold(53, "watch_kept:check");
            let watcher = preserved(&manager, &managed, Duration::ZERO);
            held.reached();
            reap_on_shutdown(&manager);
            assert_eq!(tree(&managed), Tree::Released);
            held.release();
            watcher.join().unwrap();
            assert_eq!(tree(&managed), Tree::Released);
            assert!(alive(&mut member), "the survivor outlives the server");
            assert!(let_go(&managed));
        }

        // watcher release vs cancel: released first, then the cancel.
        #[test]
        fn a_cancel_after_the_watcher_released_the_survivors_is_refused() {
            let (manager, managed, mut member) = exited_root_with_member(54);
            let held = gates::hold(54, "watch_kept:decided");
            let watcher = preserved(&manager, &managed, Duration::from_millis(50));
            held.reached();
            cancel_request(&manager, 54);
            cancel_task_request(&manager, 1, "job_54");
            assert_eq!(tree(&managed), Tree::Released);
            assert!(alive(&mut member), "let go: no longer the server's to kill");
            held.release();
            watcher.join().unwrap();
        }

        // watcher release vs cancel: the cancel lands first; past its
        // deadline the watcher finds the survivors being killed and stands
        // down instead of letting them go.
        #[test]
        fn a_cancel_before_the_watcher_decides_kills_through_the_job_and_the_watcher_stands_down() {
            let (manager, managed, mut member) = exited_root_with_member(55);
            let held = gates::hold(55, "watch_kept:check");
            let watcher = preserved(&manager, &managed, Duration::ZERO);
            held.reached();
            cancel_request(&manager, 55);
            assert_eq!(tree(&managed), Tree::Killing);
            held.release();
            watcher.join().unwrap();
            assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
            assert!(exits(&mut member));
        }

        // retained publication vs shutdown: a retained command's settlement
        // kept its survivors, then the reap (retained commands used to be
        // left out of its walk, their survivors stuck in the job).
        #[test]
        fn shutdown_after_a_retained_command_kept_its_survivors_lets_them_go() {
            let (manager, managed, mut member) = exited_root_with_member(56);
            managed.retained.store(true, Ordering::Release);
            let held = gates::hold(56, "settle:decided");
            let settling = settle_on_thread(&manager, &managed);
            held.reached();
            assert_eq!(tree(&managed), Tree::Preserved);
            reap_on_shutdown(&manager);
            assert_eq!(tree(&managed), Tree::Released);
            assert!(alive(&mut member), "the survivor outlives the server");
            assert!(let_go(&managed));
            held.release();
            settling.join().unwrap();
        }

        // retained publication vs shutdown: the reap lands while a retained
        // command's tree still settles: killed, never preserved after it.
        #[test]
        fn shutdown_while_a_retained_command_settles_kills_it() {
            let (manager, managed, mut member) = exited_root_with_member(57);
            managed.retained.store(true, Ordering::Release);
            let held = gates::hold(57, "settle:check");
            let settling = settle_on_thread(&manager, &managed);
            held.reached();
            reap_on_shutdown(&manager);
            assert_eq!(tree(&managed), Tree::Killing);
            held.release();
            settling.join().unwrap();
            assert_eq!(tree(&managed), Tree::Empty);
            assert!(exits(&mut member));
        }

        // cancel vs settle: the cancel lands at the settlement's decision.
        #[test]
        fn a_cancel_while_the_tree_settles_kills_it_and_settlement_verifies_the_kill() {
            let (manager, managed, mut member) = exited_root_with_member(58);
            let held = gates::hold(58, "settle:check");
            let settling = settle_on_thread(&manager, &managed);
            held.reached();
            cancel_request(&manager, 58);
            assert_eq!(tree(&managed), Tree::Killing);
            held.release();
            settling.join().unwrap();
            assert_eq!(tree(&managed), Tree::Empty);
            assert!(exits(&mut member));
        }

        // cancel vs settle: settlement kept the survivors, then the cancel.
        #[test]
        fn a_cancel_after_settlement_kept_the_survivors_kills_them_through_the_job() {
            let (manager, managed, mut member) = exited_root_with_member(59);
            let held = gates::hold(59, "settle:decided");
            let settling = settle_on_thread(&manager, &managed);
            held.reached();
            assert_eq!(tree(&managed), Tree::Preserved);
            cancel_request(&manager, 59);
            assert_eq!(tree(&managed), Tree::Killing);
            held.release();
            settling.join().unwrap();
            assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
            assert!(exits(&mut member));
        }

        // A spawn reusing the id of a command still registered (here keeping
        // survivors after it was reported) is refused before anything is
        // spawned, and the command keeps its place.
        #[test]
        fn a_spawn_reusing_a_registered_request_id_is_refused_and_spawns_nothing() {
            let (manager, managed, mut member) = exited_root_with_member(61);
            settle_tree(&managed, &manager, true);
            report(&manager, &managed);
            assert_eq!(tree(&managed), Tree::Preserved);
            let marker =
                std::env::temp_dir().join(format!("mixdog-spawn-dup-{}", std::process::id()));
            let _ = std::fs::remove_file(&marker);
            let request: SpawnRequest = serde_json::from_value(json!({
                "id": 61,
                "program": "cmd.exe",
                "args": ["/d", "/c", format!("type nul > {}", marker.display())],
            }))
            .unwrap();
            run_spawn(request, Arc::clone(&manager));
            assert!(!marker.exists(), "nothing was spawned");
            let _ = std::fs::remove_file(&marker);
            let entry = manager.entry(61).expect("the command keeps its place");
            assert!(Arc::ptr_eq(&entry, &managed));
            drop(entry);
            // A targeted cancel still reaches exactly it.
            cancel_request(&manager, 61);
            assert!(becomes(&managed, Tree::Empty), "{:?}", tree(&managed));
            assert!(exits(&mut member));
            assert!(deregistered(&manager, 61));
            assert!(!manager.reserve(61), "never reused, even once let go");
        }

        /// A spawn of `cmd.exe /c type nul > marker` under request `id`.
        fn marker_spawn(id: u64, marker: &std::path::Path) -> SpawnRequest {
            serde_json::from_value(json!({
                "id": id,
                "program": "cmd.exe",
                "args": ["/d", "/c", format!("type nul > {}", marker.display())],
            }))
            .unwrap()
        }

        // An id whose command finished and was let go by the registry is
        // still refused: its last events may still be on their way.
        #[test]
        fn a_request_id_freed_by_deregistration_is_still_refused() {
            let manager = Arc::new(Manager::new());
            let dir = std::env::temp_dir();
            let first = dir.join(format!("mixdog-spawn-id62a-{}", std::process::id()));
            let second = dir.join(format!("mixdog-spawn-id62b-{}", std::process::id()));
            run_spawn(marker_spawn(62, &first), Arc::clone(&manager));
            assert!(first.exists(), "the first spawn ran");
            assert!(manager.entry(62).is_none(), "and was let go");
            run_spawn(marker_spawn(62, &second), Arc::clone(&manager));
            let reused = second.exists();
            let _ = std::fs::remove_file(&first);
            let _ = std::fs::remove_file(&second);
            assert!(!reused, "the reused id is refused: nothing spawned");
        }

        /// A stdout that is not being read: every write blocks until opened.
        #[derive(Clone)]
        struct UnreadStdout {
            open: Arc<(Mutex<bool>, std::sync::Condvar)>,
            lines: Arc<Mutex<String>>,
        }

        impl Write for UnreadStdout {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let (open, opened) = &*self.open;
                let mut is_open = open.lock().unwrap();
                while !*is_open {
                    is_open = opened.wait(is_open).unwrap();
                }
                self.lines
                    .lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(buf));
                Ok(buf.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        fn finishes(thread: &thread::JoinHandle<()>, within: Duration) -> bool {
            let started = std::time::Instant::now();
            while !thread.is_finished() {
                if started.elapsed() >= within {
                    return false;
                }
                thread::sleep(Duration::from_millis(5));
            }
            true
        }

        // The client stops reading stdout. A watcher that lets survivors go
        // and the shutdown reap both decide at once, their events queued in
        // order, and no state lock is held on the writer's account.
        #[test]
        fn while_stdout_is_not_read_transitions_and_shutdown_decide_promptly() {
            let stdout = UnreadStdout {
                open: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
                lines: Arc::new(Mutex::new(String::new())),
            };
            output::replace_writer(stdout.clone());
            emit(&json!({ "id": 64, "event": "probe" })); // the writer is stuck on this
            let (manager_a, a, mut member_a) = exited_root_with_member(64);
            let (manager_b, b, mut member_b) = exited_root_with_member(65);
            let watcher = preserved(&manager_a, &a, Duration::from_millis(50));
            assert!(
                finishes(&watcher, Duration::from_secs(2)),
                "the watcher decided"
            );
            assert_eq!(tree(&a), Tree::Released);
            let _kept = preserved(&manager_b, &b, FOREVER);
            let reaping = {
                let manager_b = Arc::clone(&manager_b);
                thread::spawn(move || reap_on_shutdown(&manager_b))
            };
            assert!(
                finishes(&reaping, Duration::from_secs(2)),
                "the reap decided"
            );
            assert_eq!(tree(&b), Tree::Released);
            assert!(a.state.try_lock().is_ok() && b.state.try_lock().is_ok());
            assert!(alive(&mut member_a) && alive(&mut member_b));
            assert!(
                stdout.lines.lock().unwrap().is_empty(),
                "nothing written yet"
            );
            // The client reads again: everything goes out, in order.
            let (open, opened) = &*stdout.open;
            *open.lock().unwrap() = true;
            opened.notify_all();
            assert!(drain_output(Duration::from_secs(5)));
            output::replace_writer(std::io::stdout());
            let written = stdout.lines.lock().unwrap().clone();
            let at = |needle: &str| written.find(needle).unwrap_or(usize::MAX);
            let probe = at(r#""event":"probe""#);
            let released_a = at(r#"{"event":"tree_released","id":64}"#);
            let released_b = at(r#"{"event":"tree_released","id":65}"#);
            assert!(
                probe < released_a && released_a < released_b && released_b < usize::MAX,
                "{written}"
            );
        }

        // Restoring breakaway fails: the tree is still RELEASED (final, never
        // gone), and the failure is recorded for its event and snapshots.
        #[test]
        fn a_release_whose_breakaway_cannot_be_restored_stays_released_and_says_so() {
            let (manager, managed, mut member) = exited_root_with_member(63);
            managed
                .control
                .refuse_release
                .store(true, Ordering::Release);
            preserved(&manager, &managed, Duration::from_millis(50))
                .join()
                .unwrap();
            assert_eq!(tree(&managed), Tree::Released);
            assert!(managed.lock_state().breakaway_unrestored);
            let snapshot = managed.snapshot().unwrap();
            assert_eq!(snapshot.tree_outcome.as_deref(), Some("released"));
            assert_eq!(snapshot.breakaway_restored, Some(false));
            assert_ne!(
                managed.control.limit_flags(),
                JOB_OBJECT_LIMIT_BREAKAWAY_OK,
                "breakaway is not restored"
            );
            cancel_request(&manager, 63);
            reap_on_shutdown(&manager);
            assert_eq!(tree(&managed), Tree::Released, "final either way");
            assert!(alive(&mut member), "never killed once let go");
        }

        // A command registered after the reap's walk gets its decision.
        #[test]
        fn a_command_registered_after_the_shutdown_walk_is_decided_on_registration() {
            let (manager, managed, mut member) = exited_root_with_member(60);
            manager.lock_live().remove(&60);
            assert!(manager.close().is_empty());
            assert!(manager.register(60, &managed), "registered after the walk");
            shutdown_held(&managed, &manager, &mut managed.lock_state());
            assert_eq!(tree(&managed), Tree::Killing);
            assert!(exits(&mut member));
        }
    }
}
