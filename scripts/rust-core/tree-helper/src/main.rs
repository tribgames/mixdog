//! `treerun <parent-pid> args|shell <program> [args...]` runs the program as the root of a process
//! tree that is ended whole: when the program exits (what it left behind is ended too), when the process that started this
//! helper asks for it or dies, however it dies, and (POSIX) when the helper itself is told to stop with SIGTERM, SIGINT or
//! SIGHUP. The helper's exit code is the program's, unchanged (an NTSTATUS such as 0xC0000005 arrives as it is), except 70
//! when ending the tree failed (the reason is in the record and on stderr) and 128 + the signal when a signal stopped it.
//!
//! The record. It is written to index 4 of the helper's stdio, a pipe the parent reads to its end (POSIX: descriptor 4;
//! Windows: C runtime descriptor 4, which the parent passes in the startup information), never to a file: nothing of a run
//! stays on disk, whatever dies and when. The helper takes the pipe before anything else (close-on-exec, not inheritable),
//! so only the helper holds it and its end is the helper's exit. A helper started without it publishes nothing. The last
//! member is `"complete":true`, so a record cut short anywhere is incomplete to the reader. Before it: `launch` (the program could not be started: ENOENT,
//! EACCES, ELAUNCH, ETIMEDOUT, with `message`), `signal` (the program died of one), `escapes` (`checked`: nothing of the
//! program's tree outlived the run unnoticed; `undetectable`: macOS, which has no way to adopt a descendant that left the
//! group, so one that did cannot be found), `escaped_ended` (pids of descendants outside the group that were adopted and
//! ended) and `failure` (the tree could not be shown to be ended, naming what is left).
//!
//! A record is published when the program finished and when the parent asked for the tree to be ended (POSIX: one byte on
//! descriptor 3; the record then says what ending the tree found). None is published when the parent died (nobody is left
//! to read it), nor when a signal reached the helper at any moment before the record is in place: a signal caught while the
//! tree is being ended withholds it, and from the moment of publication on a signal ends the helper by its default action,
//! so the caller sees the helper die of it. A caller therefore takes the tree as ended only from a helper that exited by
//! itself with this run's complete record and no failure.
//!
//! The helper killed (SIGKILL, or any death no handler of the helper sees):
//! - Windows: the job closes with the helper's last handle and kill-on-close ends every member. That needs nothing of the
//!   helper's own code, so the caller's way of ending a tree there is to kill the helper.
//! - Linux and macOS: nothing ends the tree. The program's group is not signalled; descriptor 3 reports the death of the
//!   parent, not of the helper; and the descendants a subreaper adopted are re-parented to init (or the next subreaper up)
//!   when it dies, not ended. The caller sees a helper that died of a signal with no record: by the rule above the end of
//!   the tree is not established and the run fails.
//!
//! The tree is owned, never searched for by a number that could belong to another process:
//! - Windows: a job object with kill-on-close that the helper joins before it starts the program. Every descendant is in
//!   it, whatever exits first, and nothing else is; the job closes when the helper exits, however that comes. The job and
//!   the parent-watch handle are created non-inheritable, and tests/handles.rs shows the program holds neither.
//! - POSIX: the program leads a process group of its own. The helper learns that the program exited without reaping it
//!   (`waitid` with WNOWAIT), so its pid and group id still belong to it, signals the group, and only then reaps. The
//!   parent's death is EOF on descriptor 3, the parent's end of a socket pair (close-on-exec before anything else runs).
//! - Linux also: the helper is a child subreaper, so once the program has died every descendant that left the group is
//!   re-parented to the helper. A child of the helper cannot lose its pid to anyone else while the helper has not reaped
//!   it, so each is ended through that identity (pidfd, signal, reap) until `waitid(P_ALL)` answers ECHILD, under a
//!   deadline; the helper's own children are named by `/proc/self/task/*/children`, which lists only processes the helper
//!   itself owns (`waitid` names only children that have exited, so it cannot be what finds a living one).
//! - macOS also: a signal sent to a group does not show that its members ended, and macOS cannot adopt them. Once the leader
//!   is reaped, the helper waits until the group has no living member: `kill(-pgid, 0)` answers ESRCH (a zombie is not a
//!   member to it). Between two such checks it waits for the exit of a member the system lists for the group (a kqueue exit
//!   event per member), so each check follows an exit, under the deadline; a group still populated at the deadline is a
//!   failure naming its members.
//!
//! The spawn of the program runs on its own thread, so a parent's death, its request or a signal is seen while `spawn` is
//! blocked. What can block it is the exec itself (an executable on a filesystem that does not answer); the program is then
//! not yet known to the helper. The helper waits for the spawn for at most START_DEADLINE (TREE_END_DEADLINE from a stop
//! on). A spawn that returns in time is ended at once if a stop came. One that does not is a failure (launch ETIMEDOUT
//! with the failure in the record when one is published) and exit 70: Linux ends the helper's own children (the forked
//! child is one); elsewhere a forked child still inside exec is outside anything the helper owns, and the failure says so.
//!
//! `treerun --end-inside <dir> <pid>` ends one process that a run left behind, only if it is verified to be inside `dir`
//! on the very handle it then terminates (Windows: process handle, image path; Linux: pidfd, /proc exe link, still alive
//! after the read). macOS has no such handle: it answers 4 and ends nothing. A path or directory that cannot be resolved
//! is never "inside".
use std::ffi::OsString;
use std::io::Write;
use std::process::{exit, Child, Command, ExitStatus};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// How long ending a tree (and waiting for a blocked spawn after a stop) may take; what is still there afterwards is
/// reported by name.
const TREE_END_DEADLINE: Duration = Duration::from_secs(10);
/// How long the spawn of the program may take before the run fails: far beyond an exec on a loaded machine, and finite.
const START_DEADLINE: Duration = Duration::from_secs(60);

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// What ending the tree found and did.
struct Tree {
    escapes: &'static str,
    ended: Vec<u32>,
    failure: Vec<String>,
}

impl Tree {
    fn new() -> Tree {
        Tree { escapes: sys::ESCAPES, ended: Vec::new(), failure: Vec::new() }
    }
}

/// The record's body. `"complete":true` is its last member: a record cut short anywhere does not end with it.
fn record(launch: Option<(&str, String)>, signal: Option<i32>, tree: &Tree) -> String {
    let launch = launch.map_or("null".to_owned(), |(code, message)| format!("{},\"message\":{}", json_str(code), json_str(&message)));
    let signal = signal.map_or("null".to_owned(), |s| s.to_string());
    let ended = tree.ended.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let failure = if tree.failure.is_empty() { "null".to_owned() } else { json_str(&tree.failure.join("; ")) };
    format!(
        "{{\"launch\":{launch},\"signal\":{signal},\"escapes\":{},\"escaped_ended\":[{ended}],\"failure\":{failure},\"complete\":true}}",
        json_str(tree.escapes)
    )
}

/// Sends the record unless a signal reached the helper first. Arming comes before the check: a signal caught before the
/// arming is seen by the check, and one that comes after it ends the helper by its default action (both orders are
/// sequentially consistent, so no signal falls between them; one that ends the helper mid-write leaves a record without its
/// completion member). Err is the exit code: 128 + the signal, or 70 when the record cannot be sent.
fn publish(channel: Option<impl Write>, body: &str) -> Result<(), i32> {
    sys::arm_signals();
    if let Some(signal) = sys::caught_signal() {
        return Err(128 + signal);
    }
    let Some(mut channel) = channel else { return Ok(()) };
    channel.write_all(body.as_bytes()).and_then(|()| channel.flush()).map_err(|error| {
        eprintln!("treerun: could not send the record: {error}");
        70
    })
}

/// Where the record goes: the pipe at index 4 of the helper's stdio, when the parent passed one.
struct Out {
    channel: Option<std::fs::File>,
}

/// What ended the run.
#[derive(Clone, Copy)]
enum Stop {
    /// The program exited, or could not start: the run finished by itself.
    Finished,
    /// The parent asked for the tree to be ended (POSIX; on Windows the parent kills the helper and the job ends the tree).
    #[cfg(unix)]
    Asked,
    ParentGone,
    #[cfg(unix)]
    Signalled,
}

impl Stop {
    /// Whether a record is published: someone reads it, and no signal stopped the helper.
    fn publishes(self) -> bool {
        match self {
            Stop::ParentGone => false,
            #[cfg(unix)]
            Stop::Signalled => false,
            _ => true,
        }
    }
}

/// Ends the helper: publishes the record when the stop calls for one, and exits with `code`, 128 + a signal caught at any
/// time before the record was in place, or 70 when something could not be ended.
fn finish(out: &Out, stop: Stop, launch: Option<(&str, String)>, signal: Option<i32>, tree: &Tree, code: i32) -> ! {
    if stop.publishes() {
        match publish(out.channel.as_ref(), &record(launch, signal, tree)) {
            Ok(()) => leave(code, tree),
            Err(code) => leave(code, tree),
        }
    }
    leave(sys::caught_signal().map_or(code, |signal| 128 + signal), tree)
}

fn launch_failed(out: &Out, message: String) -> ! {
    finish(out, Stop::Finished, Some(("ELAUNCH", message)), None, &Tree::new(), 126)
}

/// Exits: what could not be ended is said, and changes the status.
fn leave(code: i32, tree: &Tree) -> ! {
    for failure in &tree.failure {
        eprintln!("treerun: {failure}");
    }
    exit(if tree.failure.is_empty() { code } else { 70 });
}

/// Whether `path` lies inside `dir`, by whole path components (`/a/bc` is not inside `/a/b`) and after both are resolved
/// (a symlinked or differently written root, a `\\?\` prefix or an 8.3 name is the same directory). Fails closed: a path
/// that cannot be resolved (an executable that was deleted, a directory that is gone) is an error, never "inside". macOS
/// has no `--end-inside`, so only the tests use it there.
#[cfg(any(windows, target_os = "linux", test))]
fn inside(path: &std::path::Path, dir: &std::path::Path) -> Result<bool, String> {
    let resolved = |p: &std::path::Path| p.canonicalize().map_err(|e| format!("{} cannot be resolved: {e}", p.display()));
    Ok(resolved(path)?.starts_with(resolved(dir)?))
}

enum Event {
    /// The spawn of the program returned.
    Started(std::io::Result<Child>),
    /// The program exited; Windows has its status already, POSIX reaps it after the group is signalled.
    Exited(Result<Option<ExitStatus>, String>),
    ParentGone,
    /// The parent asked for the tree to be ended (POSIX: a byte on descriptor 3).
    #[cfg(unix)]
    Asked,
    /// A termination signal reached the helper (POSIX); which one is `sys::caught_signal`.
    #[cfg(unix)]
    Signalled,
}

impl Event {
    /// The stop this event is; the spawn's own event is none.
    fn stop(&self) -> Option<Stop> {
        match self {
            Event::Started(_) => None,
            Event::Exited(_) => Some(Stop::Finished),
            Event::ParentGone => Some(Stop::ParentGone),
            #[cfg(unix)]
            Event::Asked => Some(Stop::Asked),
            #[cfg(unix)]
            Event::Signalled => Some(Stop::Signalled),
        }
    }
}

/// Waits for the spawn to return until `deadline`. The first stop that arrives meanwhile is kept in `stop` and brings the
/// deadline to TREE_END_DEADLINE from then at the latest. None: the spawn did not return in time.
fn await_started(rx: &Receiver<Event>, mut deadline: Instant, stop: &mut Option<Stop>) -> Option<std::io::Result<Child>> {
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Started(result)) => return Some(result),
            Ok(event) => {
                if stop.is_none() {
                    *stop = event.stop();
                    deadline = deadline.min(Instant::now() + TREE_END_DEADLINE);
                }
            }
            Err(_) => return None,
        }
    }
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|a| a == "--end-inside") {
        let (Some(dir), Some(pid)) = (args.get(1), args.get(2).and_then(|p| p.to_string_lossy().parse::<u32>().ok())) else {
            eprintln!("usage: treerun --end-inside <dir> <pid>");
            exit(64);
        };
        exit(sys::end_inside(&dir.to_string_lossy(), pid));
    }
    // First thing in run mode, before any thread or spawn exists: descriptors 3 (POSIX) and 4 become close-on-exec / not
    // inheritable, so no program this helper starts, and nothing that program starts, can hold the parent channel or the
    // record pipe open.
    let channel = sys::take_parent_channel();
    let out = Out { channel: sys::take_record_channel() };
    if args.len() < 3 {
        eprintln!("usage: treerun <parent-pid> args|shell <program> [args...]");
        exit(64);
    }
    let parent_pid: u32 = args[0].to_string_lossy().parse().unwrap_or_else(|_| {
        eprintln!("treerun: parent pid is not a number");
        exit(64);
    });

    let (tx, rx) = mpsc::channel();
    // Before the program exists: a signal, a request or a parent that dies from here on is seen, and the program never
    // holds the channel.
    if let Err(message) = sys::watch_signals(tx.clone()) {
        launch_failed(&out, message);
    }
    if let Err(message) = sys::watch_parent(channel, parent_pid, tx.clone()) {
        launch_failed(&out, message);
    }
    let _jail = match sys::Jail::new() {
        Ok(jail) => jail,
        Err(message) => launch_failed(&out, format!("could not create the job: {message}")),
    };

    let mut command = if args[1] == "shell" { sys::shell_command(&args[2]) } else { Command::new(&args[2]) };
    if args[1] != "shell" {
        command.args(&args[3..]);
    }
    sys::prepare(&mut command);
    let tx_spawn = tx.clone();
    thread::spawn(move || {
        let _ = tx_spawn.send(Event::Started(command.spawn()));
    });

    let mut stop = None;
    let Some(started) = await_started(&rx, Instant::now() + START_DEADLINE, &mut stop) else {
        let message = format!(
            "starting the program did not return within its deadline ({} s, {} s once a stop arrived)",
            START_DEADLINE.as_secs(),
            TREE_END_DEADLINE.as_secs()
        );
        let mut tree = Tree::new();
        tree.failure.push(message.clone());
        sys::end_unstarted(&mut tree, Instant::now() + TREE_END_DEADLINE);
        finish(&out, stop.unwrap_or(Stop::Finished), Some(("ETIMEDOUT", message)), None, &tree, 70);
    };
    let child = match started {
        Ok(child) => child,
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "ELAUNCH",
            };
            finish(&out, stop.unwrap_or(Stop::Finished), Some((code, error.to_string())), None, &Tree::new(), 127);
        }
    };
    let program = child.id();
    let held = sys::adopt(child, tx.clone());

    // A stop that came while the spawn ran ends the tree at once; otherwise the first event decides.
    let (stop, waited) = match stop {
        Some(stop) => (stop, None),
        None => match rx.recv().expect("the senders live in this function") {
            Event::Exited(waited) => (Stop::Finished, Some(waited)),
            other => (other.stop().expect("the spawn's event came once, so every later event is a stop"), None),
        },
    };
    // The program exited, the parent asked or is gone, or a signal came: either way nothing of the tree may stay.
    let (reaped, mut tree) = sys::end_tree(held, program, waited.is_some());
    let status = match waited {
        None => None,
        Some(Ok(Some(status))) => Some(status),
        Some(Ok(None)) => reaped,
        Some(Err(message)) => {
            tree.failure.push(format!("waiting for the program failed: {message}"));
            None
        }
    };
    finish(&out, stop, None, status.as_ref().and_then(sys::signal_of), &tree, status.and_then(|s| s.code()).unwrap_or(0));
}

#[cfg(windows)]
mod sys {
    use super::{Event, Tree};
    use std::process::{Child, Command, ExitStatus};
    use std::sync::mpsc::Sender;
    use std::thread;
    use win32job::{ExtendedLimitInfo, Job};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, INFINITE,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// Every descendant is in the job, so nothing can escape unnoticed.
    pub const ESCAPES: &str = "checked";

    /// The kill-on-close job the helper is a member of: its handle lives as long as the helper, so the job ends with it.
    pub struct Jail {
        _job: Job,
    }

    impl Jail {
        pub fn new() -> Result<Jail, String> {
            let mut limits = ExtendedLimitInfo::new();
            limits.limit_kill_on_job_close();
            let job = Job::create_with_limit_info(&limits).map_err(|e| e.to_string())?;
            job.assign_current_process().map_err(|e| e.to_string())?;
            Ok(Jail { _job: job })
        }
    }

    pub struct Held;

    pub fn shell_command(line: &std::ffi::OsString) -> Command {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd.exe");
        let mut raw = std::ffi::OsString::from("/d /s /c \"");
        raw.push(line);
        raw.push("\"");
        command.raw_arg(raw);
        command
    }

    /// The helper has no console (it is spawned detached); without CREATE_NO_WINDOW each console program it starts would
    /// create a console window host of its own, which costs ~150 ms per spawn.
    pub fn prepare(command: &mut Command) {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    /// Windows watches the parent by its process handle; there is no channel descriptor.
    pub fn take_parent_channel() -> Result<(), String> {
        Ok(())
    }

    /// The record pipe: C runtime descriptor 4, passed by the parent in the startup information (`lpReserved2` in the C
    /// runtime's layout, which libuv writes: a 32-bit count, a flag byte per descriptor, then a handle per descriptor, all
    /// unaligned), made not inheritable before the program starts. None when no open descriptor 4 was passed.
    pub fn take_record_channel() -> Option<std::fs::File> {
        use std::os::windows::io::FromRawHandle;
        use windows::Win32::Foundation::{SetHandleInformation, HANDLE_FLAGS, HANDLE_FLAG_INHERIT};
        use windows::Win32::System::Threading::{GetStartupInfoW, STARTUPINFOW};
        const FD: usize = 4;
        const FOPEN: u8 = 0x01;
        const HANDLE_SIZE: usize = std::mem::size_of::<usize>();
        let mut info = STARTUPINFOW::default();
        // SAFETY: GetStartupInfoW fills a valid local; lpReserved2 is read only within its cbReserved2 bytes, and the handle
        // it names is this process's own, owned by the returned file from here on.
        unsafe {
            GetStartupInfoW(&mut info);
            let (base, size) = (info.lpReserved2.cast_const(), usize::from(info.cbReserved2));
            if base.is_null() || size < 4 {
                return None;
            }
            let count = base.cast::<u32>().read_unaligned() as usize;
            if count <= FD || size < 4 + count + count * HANDLE_SIZE || *base.add(4 + FD) & FOPEN == 0 {
                return None;
            }
            let raw = base.add(4 + count + FD * HANDLE_SIZE).cast::<isize>().read_unaligned();
            if raw == 0 || raw == -1 {
                return None;
            }
            let handle = HANDLE(raw as *mut std::ffi::c_void);
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).ok()?;
            Some(std::fs::File::from_raw_handle(handle.0))
        }
    }

    /// No termination signals reach a detached, console-less helper; the parent ends it by killing it, and the job follows.
    pub fn watch_signals(_tx: Sender<Event>) -> Result<(), String> {
        Ok(())
    }

    pub fn caught_signal() -> Option<i32> {
        None
    }

    pub fn arm_signals() {}

    /// A process still inside a spawn that did not return is in the job (the helper joined it first): the job ends it.
    pub fn end_unstarted(_tree: &mut Tree, _deadline: std::time::Instant) {}

    pub fn adopt(mut child: Child, tx: Sender<Event>) -> Held {
        thread::spawn(move || {
            let _ = tx.send(Event::Exited(child.wait().map(Some).map_err(|e| e.to_string())));
        });
        Held
    }

    /// Sends ParentGone when the parent process has exited. A parent created after this helper is a stranger on a reused pid.
    pub fn watch_parent(_channel: Result<(), String>, pid: u32, tx: Sender<Event>) -> Result<(), String> {
        let on_gone = move || {
            let _ = tx.send(Event::ParentGone);
        };
        // SAFETY: handles opened here are owned by the thread and closed there (OpenProcess is called with bInheritHandle
        // false, so the handle is never inherited by the program); the FILETIME out-pointers are valid locals.
        thread::spawn(move || unsafe {
            let Ok(parent) = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return on_gone();
            };
            let (mut mine, mut theirs, mut ignored) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
            let own_ok = GetProcessTimes(GetCurrentProcess(), &mut mine, &mut ignored, &mut ignored, &mut ignored).is_ok();
            let their_ok = GetProcessTimes(parent, &mut theirs, &mut ignored, &mut ignored, &mut ignored).is_ok();
            let key = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
            if !(own_ok && their_ok && key(theirs) > key(mine)) {
                WaitForSingleObject(parent, INFINITE);
            }
            let _ = CloseHandle(parent);
            on_gone();
        });
        Ok(())
    }

    /// The job ends everything with the helper's exit.
    pub fn end_tree(_held: Held, _program: u32, _exited: bool) -> (Option<ExitStatus>, Tree) {
        (None, Tree::new())
    }

    pub fn signal_of(_status: &ExitStatus) -> Option<i32> {
        None
    }

    /// Ends the process only after its image path, read from the handle that is then terminated, lies inside `dir`.
    pub fn end_inside(dir: &str, pid: u32) -> i32 {
        // SAFETY: one process handle, opened, queried, terminated and closed here; the buffer and length are valid locals.
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) else {
                eprintln!("treerun: pid {pid} cannot be opened (gone, or not ours)");
                return 3;
            };
            let code = terminate_if_inside(process, dir, pid);
            let _ = CloseHandle(process);
            code
        }
    }

    unsafe fn terminate_if_inside(process: HANDLE, dir: &str, pid: u32) -> i32 {
        let mut buffer = [0u16; 32_768];
        let mut length = buffer.len() as u32;
        if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut length).is_err() {
            eprintln!("treerun: the image path of pid {pid} cannot be read");
            return 3;
        }
        let image = String::from_utf16_lossy(&buffer[..length as usize]);
        match super::inside(std::path::Path::new(&image), std::path::Path::new(dir)) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!("treerun: pid {pid} runs {image}, not inside {dir}");
                return 3;
            }
            Err(message) => {
                eprintln!("treerun: pid {pid} is not ended: {message}");
                return 3;
            }
        }
        if TerminateProcess(process, 1).is_err() {
            eprintln!("treerun: pid {pid} could not be terminated");
            return 70;
        }
        // Bounded: the exit of the very process that was terminated.
        if WaitForSingleObject(process, 30_000) != WAIT_OBJECT_0 {
            eprintln!("treerun: pid {pid} did not exit within 30 s of being terminated");
            return 70;
        }
        0
    }
}

#[cfg(unix)]
mod sys {
    use super::{Event, Tree, TREE_END_DEADLINE};
    use rustix::io::{fcntl_setfd, Errno, FdFlags};
    use rustix::process::{kill_process_group, waitid, Pid, Signal, WaitId, WaitIdOptions};
    use std::io::Read;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command, ExitStatus};
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
    use std::sync::mpsc::{self, Sender};
    use std::thread;
    use std::time::Instant;

    /// Linux adopts every descendant that leaves the group, so each is found and ended; macOS cannot, and says so.
    pub const ESCAPES: &str = if cfg!(target_os = "linux") { "checked" } else { "undetectable" };

    /// Linux: a child subreaper, so descendants whose starters die are re-parented to the helper, not to init.
    pub struct Jail;

    impl Jail {
        pub fn new() -> Result<Jail, String> {
            #[cfg(target_os = "linux")]
            rustix::process::set_child_subreaper(Some(rustix::process::getpid())).map_err(|e| format!("PR_SET_CHILD_SUBREAPER: {e}"))?;
            Ok(Jail)
        }
    }

    /// The program, not yet reaped: while it is held, its pid and process group id cannot belong to anything else.
    pub struct Held(Child);

    impl Held {
        /// Reaps the program, waiting for its exit no longer than `deadline`.
        fn reap(self, deadline: Instant) -> Result<ExitStatus, String> {
            let pid = self.0.id();
            let mut child = self.0;
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || {
                let _ = tx.send(child.wait());
            });
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(error)) => Err(format!("waiting for the program (pid {pid}) failed: {error}")),
                Err(_) => Err(format!("the program (pid {pid}) did not exit within {} s of being killed", TREE_END_DEADLINE.as_secs())),
            }
        }
    }

    pub fn shell_command(line: &std::ffi::OsString) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(line);
        command
    }

    /// The program leads a process group of its own, so the whole group is signalled by its id.
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }

    /// The first termination signal the helper caught (0: none), set in the handler itself.
    static CAUGHT: AtomicI32 = AtomicI32::new(0);
    /// Set at publication: from then on a termination signal ends the helper by its default action.
    static ARMED: AtomicBool = AtomicBool::new(false);

    /// SIGTERM, SIGINT and SIGHUP become events: the helper ends its tree instead of dying with the tree running. The
    /// handler records the first signal before anything else sees it (the event that wakes the main thread is sent only
    /// after), and once the helper is armed it ends the helper by the signal's default action. The handlers are reset by
    /// exec, so the program starts with the default actions.
    pub fn watch_signals(tx: Sender<Event>) -> Result<(), String> {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        for signal in [SIGTERM, SIGINT, SIGHUP] {
            // SAFETY: the action only uses two atomics and emulate_default_handler, all async-signal-safe. It is registered
            // before the iterator's own action, so the signal is recorded before the wake-up is written.
            unsafe {
                signal_hook::low_level::register(signal, move || {
                    let _ = CAUGHT.compare_exchange(0, signal, Ordering::SeqCst, Ordering::SeqCst);
                    if ARMED.load(Ordering::SeqCst) {
                        let _ = signal_hook::low_level::emulate_default_handler(signal);
                    }
                })
            }
            .map_err(|e| format!("could not watch for termination signals: {e}"))?;
        }
        let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]).map_err(|e| format!("could not watch for termination signals: {e}"))?;
        thread::spawn(move || {
            for _ in signals.forever() {
                let _ = tx.send(Event::Signalled);
            }
        });
        Ok(())
    }

    pub fn caught_signal() -> Option<i32> {
        match CAUGHT.load(Ordering::SeqCst) {
            0 => None,
            signal => Some(signal),
        }
    }

    pub fn arm_signals() {
        ARMED.store(true, Ordering::SeqCst);
    }

    /// Linux: a forked child still inside a spawn that did not return is a child of the helper, ended through that.
    pub fn end_unstarted(_tree: &mut Tree, _deadline: Instant) {
        #[cfg(target_os = "linux")]
        adopted::end_all(_tree, 0, true, _deadline);
    }

    /// Waits for the program's exit without reaping it (WNOWAIT): the zombie keeps the pid and the group id.
    pub fn adopt(child: Child, tx: Sender<Event>) -> Held {
        let pid = Pid::from_raw(child.id() as i32).expect("a child's pid is positive");
        thread::spawn(move || {
            let waited = loop {
                match waitid(WaitId::Pid(pid), WaitIdOptions::EXITED | WaitIdOptions::NOWAIT) {
                    Err(Errno::INTR) => continue,
                    other => break other,
                }
            };
            let _ = tx.send(Event::Exited(waited.map(|_| None).map_err(|e| e.to_string())));
        });
        Held(child)
    }

    /// Takes descriptor 3, the parent's end of the socket pair it holds, and makes it close-on-exec.
    pub fn take_parent_channel() -> Result<std::fs::File, String> {
        // SAFETY: descriptor 3 is the socket the parent reserved at index 3 of this process's stdio; nothing else in this
        // process owns it, and it is owned by the returned file from here on.
        let fd = unsafe { OwnedFd::from_raw_fd(3) };
        fcntl_setfd(&fd, FdFlags::CLOEXEC).map_err(|e| format!("descriptor 3 (the parent channel) is not open: {e}"))?;
        Ok(std::fs::File::from(fd))
    }

    /// The record pipe, descriptor 4, made close-on-exec. None when the parent passed none.
    pub fn take_record_channel() -> Option<std::fs::File> {
        // SAFETY: descriptor 4 is only probed here; it is owned below only once it is known to be open, and then it is the
        // pipe the parent reserved at index 4 of this process's stdio, which nothing else in this process owns.
        if rustix::io::fcntl_getfd(unsafe { std::os::fd::BorrowedFd::borrow_raw(4) }).is_err() {
            return None;
        }
        // SAFETY: as above, descriptor 4 is open and nothing else owns it.
        let fd = unsafe { OwnedFd::from_raw_fd(4) };
        fcntl_setfd(&fd, FdFlags::CLOEXEC).ok()?;
        Some(std::fs::File::from(fd))
    }

    /// The parent channel: a byte is the parent asking for the tree to be ended (Asked); EOF before any byte is its death
    /// (ParentGone), as is a failed read (the parent cannot be watched any more).
    pub fn watch_parent(channel: Result<std::fs::File, String>, _pid: u32, tx: Sender<Event>) -> Result<(), String> {
        let mut socket = channel?;
        thread::spawn(move || {
            let mut byte = [0u8; 1];
            let event = loop {
                match socket.read(&mut byte) {
                    Ok(0) => break Event::ParentGone,
                    Ok(_) => break Event::Asked,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break Event::ParentGone,
                }
            };
            let _ = tx.send(event);
        });
        Ok(())
    }

    /// Signals the program's group while the program is still unreaped, reaps it, then (Linux) ends every adopted
    /// descendant. The group id is the program's own because the program is unreaped, and it was started in a group of its
    /// own, never the helper's. While the leader is unreaped the group is never empty (a zombie leader stays a member and
    /// the kernel still delivers to it), so ESRCH is an error. The one exception is a system whose group delivery skips
    /// zombies (macOS, unverified): ESRCH is accepted there only once the program is known to have exited.
    pub fn end_tree(held: Held, program: u32, exited: bool) -> (Option<ExitStatus>, Tree) {
        let mut tree = Tree::new();
        let deadline = Instant::now() + TREE_END_DEADLINE;
        match kill_process_group(Pid::from_raw(program as i32).expect("a child's pid is positive"), Signal::KILL) {
            Ok(()) => {}
            Err(Errno::SRCH) if exited && !cfg!(target_os = "linux") => {}
            Err(error) => tree.failure.push(format!("signalling the group of pid {program} failed: {error}")),
        }
        // Once the program has been reaped (it is waited for first, so the kernel has re-parented its children to the
        // helper before it counts as dead), every descendant outside the group that is still alive is a child of the helper.
        let status = match held.reap(deadline) {
            Ok(status) => Some(status),
            Err(message) => {
                tree.failure.push(message);
                None
            }
        };
        #[cfg(target_os = "linux")]
        adopted::end_all(&mut tree, program, status.is_some(), deadline);
        // The group's other members were signalled, not shown ended. On Linux every member whose parent died is the helper's
        // own child by now and was ended and reaped above; elsewhere the group itself must be seen empty.
        #[cfg(not(target_os = "linux"))]
        if status.is_some() {
            if let Err(message) = group::wait_empty(Pid::from_raw(program as i32).expect("a child's pid is positive"), deadline) {
                tree.failure.push(message);
            }
        }
        (status, tree)
    }

    /// macOS: waits for a process group to have no living member, event by event.
    #[cfg(target_os = "macos")]
    mod group {
        use super::{Errno, Instant};
        use rustix::event::kqueue::{kevent, kqueue, Event, EventFilter, EventFlags, ProcessEvents};
        use rustix::process::{test_kill_process_group, Pid};
        use std::mem::MaybeUninit;
        use std::time::Duration;

        /// The pids the system lists in group `pgid` (zombies included; they are not waited for, as `kill` skips them).
        fn members(pgid: i32) -> Result<Vec<i32>, String> {
            let mut buffer = vec![0 as libc::pid_t; 4096];
            let size = (buffer.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
            // SAFETY: the buffer is valid for `size` bytes and outlives the call.
            let count = unsafe { libc::proc_listpgrppids(pgid, buffer.as_mut_ptr().cast(), size) };
            if count < 0 {
                return Err(format!("the members of the group of pid {pgid} cannot be listed: {}", std::io::Error::last_os_error()));
            }
            buffer.truncate(count as usize);
            Ok(buffer)
        }

        /// Until `kill(-pgid, 0)` answers ESRCH, waits for the exit of a listed member; each check follows an exit. A group
        /// still populated at the deadline, or one whose living members no listing names, is an error naming what is known.
        pub fn wait_empty(group: Pid, deadline: Instant) -> Result<(), String> {
            let pgid = group.as_raw_nonzero().get();
            let queue = kqueue().map_err(|e| format!("waiting for the group of pid {pgid} to empty: kqueue failed: {e}"))?;
            loop {
                match test_kill_process_group(group) {
                    Err(Errno::SRCH) => return Ok(()),
                    Err(error) => return Err(format!("asking whether the group of pid {pgid} is empty failed: {error}")),
                    Ok(()) => {}
                }
                let listed = members(pgid)?;
                if listed.is_empty() {
                    // The last member can have exited between the probe and the listing. With no member listed, none is
                    // left to start another, so a second probe decides: empty now, or members no listing names.
                    return match test_kill_process_group(group) {
                        Err(Errno::SRCH) => Ok(()),
                        Err(error) => Err(format!("asking whether the group of pid {pgid} is empty failed: {error}")),
                        Ok(()) => Err(format!("the group of pid {pgid} has living members that the system does not list")),
                    };
                }
                let mut watched = 0;
                for pid in listed.iter().filter_map(|pid| Pid::from_raw(*pid)) {
                    let change = Event::new(EventFilter::Proc { pid, flags: ProcessEvents::EXIT }, EventFlags::ADD | EventFlags::ONESHOT, std::ptr::null_mut());
                    let mut none: [MaybeUninit<Event>; 0] = [];
                    // SAFETY: the change names a process, not a descriptor; the queue outlives the call.
                    match unsafe { kevent(&queue, &[change], &mut none, Some(Duration::ZERO)) } {
                        Ok(_) => watched += 1,
                        // Exited (or a zombie) since the listing: the next check sees it.
                        Err(Errno::SRCH) => {}
                        Err(error) => return Err(format!("watching member pid {} of the group of pid {pgid} failed: {error}", pid.as_raw_nonzero())),
                    }
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(format!("the group of pid {pgid} still has members {listed:?} at the deadline after SIGKILL"));
                }
                if watched == 0 {
                    continue;
                }
                let mut fired = [MaybeUninit::<Event>::uninit()];
                // SAFETY: as above.
                match unsafe { kevent(&queue, &[], &mut fired, Some(left)) } {
                    Ok(([], _)) => {
                        return Err(format!("the group of pid {pgid} still has members {listed:?} at the deadline after SIGKILL"))
                    }
                    Ok(_) | Err(Errno::INTR) => {}
                    Err(error) => return Err(format!("waiting for a member of the group of pid {pgid} to exit failed: {error}")),
                }
            }
        }
    }

    /// No other POSIX system is built for; one that is cannot show its group empty, and says so.
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    mod group {
        use super::{Instant, Pid};

        pub fn wait_empty(group: Pid, _deadline: Instant) -> Result<(), String> {
            Err(format!("this system has no way to show that the group of pid {} is empty", group.as_raw_nonzero()))
        }
    }

    #[cfg(target_os = "linux")]
    mod adopted {
        use super::{Errno, Instant, Signal, Tree};
        use rustix::event::{poll, PollFd, PollFlags};
        use rustix::fs::Timespec;
        use rustix::process::{pidfd_open, pidfd_send_signal, waitid, Pid, PidfdFlags, WaitId, WaitIdOptions};
        use std::collections::BTreeSet;
        use std::os::fd::AsFd;

        /// The helper's own unreaped children, from every live thread (a child belongs to the thread that forked it, or to
        /// the thread it was re-parented to). A kernel without CONFIG_PROC_CHILDREN cannot answer: that is an error, never "none".
        fn own_children() -> Result<Vec<u32>, String> {
            let mut pids = BTreeSet::new();
            for task in std::fs::read_dir("/proc/self/task").map_err(|e| format!("/proc/self/task cannot be read: {e}"))? {
                let dir = task.map_err(|e| format!("/proc/self/task cannot be read: {e}"))?.path();
                match std::fs::read_to_string(dir.join("children")) {
                    Ok(text) => {
                        for word in text.split_whitespace() {
                            pids.insert(word.parse::<u32>().map_err(|e| format!("{} is not a pid list: {e}", dir.join("children").display()))?);
                        }
                    }
                    // The thread ended between the listing and the read.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound && !dir.exists() => {}
                    Err(error) => return Err(format!("{} cannot be read ({error}): this kernel cannot list the helper's own children", dir.join("children").display())),
                }
            }
            Ok(pids.into_iter().collect())
        }

        /// Whether the helper has no child at all, living or dead, in any of its threads: `waitid(P_ALL)` answers ECHILD.
        fn childless() -> Result<bool, String> {
            match waitid(WaitId::All, WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT) {
                Err(Errno::CHILD) => Ok(true),
                Ok(_) => Ok(false),
                Err(error) => Err(format!("asking whether the helper still has children failed: {error}")),
            }
        }

        /// Ends the children of the helper other than the program until none is left or the deadline passes. Ending one
        /// re-parents its own children to the helper, so the listing is read again until it is empty. The listing names
        /// them, and the kernel's ECHILD is what says none is left: a child that moved between the helper's threads while
        /// they were read can be missing from one listing, never from the next (`program_reaped` false: the program is
        /// still a child, so only the listing can answer, and the run has already failed).
        pub fn end_all(tree: &mut Tree, program: u32, program_reaped: bool, deadline: Instant) {
            loop {
                let children: Vec<u32> = match own_children() {
                    Ok(all) => all.into_iter().filter(|pid| *pid != program).collect(),
                    Err(message) => {
                        tree.failure.push(message);
                        return;
                    }
                };
                if children.is_empty() {
                    match (program_reaped, childless()) {
                        (false, _) | (true, Ok(true)) => return,
                        (true, Ok(false)) => {}
                        (true, Err(message)) => return tree.failure.push(message),
                    }
                }
                if Instant::now() >= deadline {
                    tree.failure.push(if children.is_empty() {
                        "a child of the helper that no listing of its threads names is still there at the deadline".to_owned()
                    } else {
                        format!("descendants {children:?} of the program are still alive at the deadline")
                    });
                    return;
                }
                for pid in children {
                    end_one(tree, pid, deadline);
                }
            }
        }

        /// One adopted child, through a pidfd: it is unreaped, so the pid is its own until this function reaps it.
        fn end_one(tree: &mut Tree, pid: u32, deadline: Instant) {
            let Some(target) = Pid::from_raw(pid as i32) else { return };
            let pidfd = match pidfd_open(target, PidfdFlags::empty()) {
                Ok(fd) => fd,
                Err(error) => return tree.failure.push(format!("adopted descendant pid {pid} cannot be opened: {error}")),
            };
            if let Err(error) = pidfd_send_signal(&pidfd, Signal::KILL) {
                return tree.failure.push(format!("adopted descendant pid {pid} could not be signalled: {error}"));
            }
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                let timeout = Timespec { tv_sec: left.as_secs() as i64, tv_nsec: i64::from(left.subsec_nanos()) };
                let mut fds = [PollFd::new(&pidfd, PollFlags::IN)];
                match poll(&mut fds, Some(&timeout)) {
                    Err(Errno::INTR) => continue,
                    Err(error) => return tree.failure.push(format!("waiting for adopted descendant pid {pid} failed: {error}")),
                    Ok(0) => return tree.failure.push(format!("adopted descendant pid {pid} is still alive at the deadline after SIGKILL")),
                    Ok(_) => break,
                }
            }
            match waitid(WaitId::PidFd(pidfd.as_fd()), WaitIdOptions::EXITED) {
                Ok(_) => tree.ended.push(pid),
                Err(error) => tree.failure.push(format!("adopted descendant pid {pid} could not be reaped: {error}")),
            }
        }
    }

    pub fn signal_of(status: &ExitStatus) -> Option<i32> {
        status.signal()
    }

    #[cfg(target_os = "linux")]
    pub fn end_inside(dir: &str, pid: u32) -> i32 {
        use rustix::event::{poll, PollFd, PollFlags};
        use rustix::process::{pidfd_open, pidfd_send_signal, PidfdFlags};
        let Some(target) = Pid::from_raw(pid as i32) else { return 3 };
        let Ok(pidfd) = pidfd_open(target, PidfdFlags::empty()) else {
            eprintln!("treerun: pid {pid} cannot be opened (gone)");
            return 3;
        };
        let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe")) else {
            eprintln!("treerun: the executable of pid {pid} cannot be read");
            return 3;
        };
        // A pidfd becomes readable when its process exits: still unreadable now means the process was alive for the whole
        // read, so /proc/<pid> described the process this descriptor names.
        let mut fds = [PollFd::new(&pidfd, PollFlags::IN)];
        let now = rustix::fs::Timespec { tv_sec: 0, tv_nsec: 0 };
        if poll(&mut fds, Some(&now)) != Ok(0) {
            eprintln!("treerun: pid {pid} exited while it was being verified");
            return 3;
        }
        let dir = std::path::Path::new(dir);
        match super::inside(&exe, dir) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!("treerun: pid {pid} runs {}, not inside {}", exe.display(), dir.display());
                return 3;
            }
            Err(message) => {
                eprintln!("treerun: pid {pid} is not ended: {message}");
                return 3;
            }
        }
        match pidfd_send_signal(&pidfd, Signal::KILL) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("treerun: pid {pid} could not be signalled: {error}");
                70
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn end_inside(dir: &str, pid: u32) -> i32 {
        eprintln!("treerun: pid {pid} may be inside {dir}; this system has no handle to verify and end it by, so nothing is ended");
        4
    }
}

#[cfg(test)]
mod tests {
    use super::{await_started, inside, json_str, record, Event, Stop, Tree};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// A fresh directory under the system temp directory, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("treerun-test-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_record_ends_with_its_completion_member_in_every_shape() {
        let failed = Tree { escapes: "checked", ended: vec![7], failure: vec!["pid 7 is still alive".into()] };
        for body in [record(None, None, &Tree::new()), record(None, Some(9), &Tree::new()), record(Some(("ENOENT", "no such file".into())), None, &failed)] {
            assert!(body.ends_with(",\"complete\":true}"), "{body}");
        }
    }

    #[test]
    fn the_record_carries_the_launch_signal_escapes_and_failure() {
        let tree = Tree { escapes: "checked", ended: Vec::new(), failure: Vec::new() };
        assert_eq!(record(None, None, &tree), r#"{"launch":null,"signal":null,"escapes":"checked","escaped_ended":[],"failure":null,"complete":true}"#);
        assert_eq!(record(None, Some(9), &tree), r#"{"launch":null,"signal":9,"escapes":"checked","escaped_ended":[],"failure":null,"complete":true}"#);
        assert_eq!(
            record(Some(("EACCES", "denied".into())), None, &tree),
            r#"{"launch":"EACCES","message":"denied","signal":null,"escapes":"checked","escaped_ended":[],"failure":null,"complete":true}"#
        );
        let adopted = Tree { escapes: "undetectable", ended: vec![11, 12], failure: vec!["a".into(), "b".into()] };
        assert_eq!(
            record(None, None, &adopted),
            r#"{"launch":null,"signal":null,"escapes":"undetectable","escaped_ended":[11,12],"failure":"a; b","complete":true}"#
        );
    }

    #[test]
    fn strings_are_escaped_so_a_message_cannot_end_the_record_early() {
        assert_eq!(json_str("a\"b\\c\n\u{1}"), r#""a\"b\\c\u000a\u0001""#);
        let body = record(Some(("ELAUNCH", "\",\"complete\":true}".into())), None, &Tree::new());
        assert_eq!(body.matches("\"complete\":true}").count(), 1, "{body}");
    }

    #[test]
    fn a_spawn_that_does_not_return_is_given_up_at_its_deadline() {
        // The spawn's sender stays alive and never sends: the wait must end by its deadline alone.
        let (tx, rx) = mpsc::channel::<Event>();
        let deadline = Instant::now() + Duration::from_millis(300);
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stop = None;
            let started = await_started(&rx, deadline, &mut stop);
            let _ = done_tx.send((started.is_none(), stop.is_none(), Instant::now()));
        });
        let (timed_out, no_stop, at) = done_rx.recv_timeout(Duration::from_secs(30)).expect("the wait for a spawn that never returns did not end within 30 s: it has no deadline");
        drop(tx);
        assert!(timed_out && no_stop);
        assert!(at >= deadline, "the wait gave up before its deadline");
    }

    #[test]
    fn a_stop_during_the_spawn_is_kept_and_the_spawn_still_awaited() {
        let (tx, rx) = mpsc::channel::<Event>();
        tx.send(Event::ParentGone).unwrap();
        tx.send(Event::Started(Err(std::io::Error::from(std::io::ErrorKind::NotFound)))).unwrap();
        let mut stop = None;
        let started = await_started(&rx, Instant::now() + Duration::from_secs(30), &mut stop);
        assert!(matches!(started, Some(Err(_))));
        assert!(matches!(stop, Some(Stop::ParentGone)));
    }

    /// A signal caught while the tree was being ended (after the program's exit was seen) withholds the record: the
    /// helper exits 128 + the signal and the caller finds no record. The signal is real: sent to this process and caught
    /// by the helper's own handlers.
    #[cfg(unix)]
    #[test]
    fn a_signal_caught_before_publication_withholds_the_record() {
        let (tx, rx) = mpsc::channel();
        super::sys::watch_signals(tx).unwrap();
        rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::TERM).unwrap();
        assert!(matches!(rx.recv_timeout(Duration::from_secs(30)).expect("the SIGTERM sent to this process was not seen within 30 s"), Event::Signalled));
        let mut sent = Vec::new();
        assert_eq!(super::publish(Some(&mut sent), &record(None, None, &Tree::new())), Err(143));
        assert!(sent.is_empty(), "no record after a signal");
    }

    #[test]
    fn a_path_in_the_directory_is_inside_and_a_sibling_sharing_its_prefix_is_not() {
        let root = Scratch::new("prefix");
        let (dir, sibling) = (root.0.join("profile"), root.0.join("profile-other"));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(dir.join("bin").join("core"), "").unwrap();
        std::fs::write(sibling.join("core"), "").unwrap();
        assert_eq!(inside(&dir.join("bin").join("core"), &dir), Ok(true));
        assert_eq!(inside(&sibling.join("core"), &dir), Ok(false));
        assert_eq!(inside(&dir, &dir.join("bin")), Ok(false), "the parent is not inside its child");
    }

    #[test]
    fn a_path_or_directory_that_cannot_be_resolved_is_an_error_never_inside() {
        let root = Scratch::new("gone");
        let dir = root.0.join("profile");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(inside(&dir.join("deleted-core"), &dir).is_err());
        assert!(inside(&dir, &root.0.join("no-such-profile")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_root_is_the_directory_it_points_at() {
        let root = Scratch::new("link");
        let real = root.0.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("core"), "").unwrap();
        let link = root.0.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // the kernel reports the resolved path of a running executable; the caller may hold the linked one, or the reverse
        assert_eq!(inside(&real.join("core"), &link), Ok(true));
        assert_eq!(inside(&link.join("core"), &real), Ok(true));
        let sibling = root.0.join("real-other");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("core"), "").unwrap();
        assert_eq!(inside(&sibling.join("core"), &link), Ok(false));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_differing_in_case_slashes_or_the_verbatim_prefix_are_the_same_directory() {
        let root = Scratch::new("case");
        let dir = root.0.join("Profile");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("core.exe"), "").unwrap();
        let plain = dir.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
        assert_eq!(inside(&dir.join("core.exe"), &PathBuf::from(plain.to_uppercase())), Ok(true));
        assert_eq!(inside(&dir.join("core.exe"), &PathBuf::from(plain.replace('\\', "/"))), Ok(true));
        let verbatim = PathBuf::from(format!(r"\\?\{plain}"));
        assert_eq!(inside(&PathBuf::from(format!(r"{plain}\core.exe")), &verbatim), Ok(true), "a plain path in a verbatim directory");
        assert_eq!(inside(&PathBuf::from(format!(r"\\?\{plain}\core.exe")), &PathBuf::from(&plain)), Ok(true), "a verbatim path in a plain directory");
        let sibling = root.0.join("Profile-other");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("core.exe"), "").unwrap();
        assert_eq!(inside(&PathBuf::from(format!(r"\\?\{}", sibling.join("core.exe").to_string_lossy().trim_start_matches(r"\\?\"))), &verbatim), Ok(false));
    }
}
