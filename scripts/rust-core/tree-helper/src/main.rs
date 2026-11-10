//! `treerun <result-file> <parent-pid> args|shell <program> [args...]` runs the program as the root of a process tree that
//! is ended whole: when the program exits (what it left behind is ended too), when the process that started this helper
//! dies, however it dies, and (POSIX) when the helper itself is told to stop with SIGTERM, SIGINT or SIGHUP. The helper's
//! exit code is the program's, unchanged (an NTSTATUS such as 0xC0000005 arrives as it is), except 70 when ending the tree
//! failed (the reason is in the record and on stderr). Everything else travels in the result file, which is written to a
//! temporary file and renamed into place, so a reader sees all of it or none, and which ends with `"complete":true`:
//! `launch` (the program could not be started: ENOENT, EACCES, ELAUNCH, with `message`), `signal` (the program died of one),
//! `escapes` (`checked`: nothing of the program's tree outlived the run unnoticed; `undetectable`: macOS, which has no way to
//! adopt a descendant that left the group, so one that did cannot be found), `escaped_ended` (pids of descendants outside
//! the group that were adopted and ended) and `failure` (the tree could not be shown to be ended, naming what is left). A
//! helper ended by a signal or by its parent's death writes no record at all: a parent that finds none knows the run did
//! not finish.
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
//!
//! The spawn of the program runs on its own thread, so a parent's death or a signal is seen while `spawn` is blocked. What
//! can block it is the exec itself (an executable on a filesystem that does not answer); the program is then not yet known
//! to the helper. The helper waits for the spawn for at most the deadline below, ends the tree if it returns, and otherwise
//! exits 70 saying so: a forked child still inside exec is then outside anything the helper owns. The caller's own deadline
//! then reaches only the helper (it asks it to stop, and an unresponsive helper is killed and the run fails).
//!
//! `treerun --end-inside <dir> <pid>` ends one process that a run left behind, only if it is verified to be inside `dir`
//! on the very handle it then terminates (Windows: process handle, image path; Linux: pidfd, /proc exe link, still alive
//! after the read). macOS has no such handle: it answers 4 and ends nothing. A path or directory that cannot be resolved
//! is never "inside".
use std::ffi::OsString;
use std::process::{exit, Child, Command, ExitStatus};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// How long ending a tree (and waiting for a blocked spawn) may take; what is still there afterwards is reported by name.
const TREE_END_DEADLINE: Duration = Duration::from_secs(10);

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

/// The result file's body. `"complete":true` is its last member: a file cut short anywhere does not end with it.
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

/// Written beside the destination and renamed into place: a reader finds the whole record or no file.
fn write_record(path: &OsString, body: &str) -> std::io::Result<()> {
    let mut temp = path.clone();
    temp.push(".tmp");
    let written = std::fs::write(&temp, body).and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

fn report(path: &OsString, launch: Option<(&str, String)>, signal: Option<i32>, tree: &Tree) {
    if let Err(error) = write_record(path, &record(launch, signal, tree)) {
        eprintln!("treerun: could not write {}: {error}", path.to_string_lossy());
        exit(70);
    }
}

fn launch_failed(result: &OsString, message: String) -> ! {
    report(result, Some(("ELAUNCH", message)), None, &Tree::new());
    exit(126);
}

/// Leaves without a record (the parent died or a signal came): what could not be ended is said, and changes the status.
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
    /// A termination signal reached the helper (POSIX).
    #[cfg(unix)]
    Signalled(i32),
}

/// The spawn is still blocked when a stop arrives: waits for it, bounded.
fn await_started(rx: &Receiver<Event>) -> Option<std::io::Result<Child>> {
    let deadline = Instant::now() + TREE_END_DEADLINE;
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Started(result)) => return Some(result),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

fn stop_code(event: &Event) -> i32 {
    match event {
        #[cfg(unix)]
        Event::Signalled(signal) => 128 + signal,
        _ => 0,
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
    // First thing in run mode, before any thread or spawn exists: descriptor 3 becomes close-on-exec, so no program this
    // helper starts, and nothing that program starts, can hold the parent channel open.
    let channel = sys::take_parent_channel();
    if args.len() < 4 {
        eprintln!("usage: treerun <result-file> <parent-pid> args|shell <program> [args...]");
        exit(64);
    }
    let result = args[0].clone();
    let parent_pid: u32 = args[1].to_string_lossy().parse().unwrap_or_else(|_| {
        eprintln!("treerun: parent pid is not a number");
        exit(64);
    });

    let (tx, rx) = mpsc::channel();
    // Before the program exists: a signal or a parent that dies from here on is seen, and the program never holds the channel.
    if let Err(message) = sys::watch_signals(tx.clone()) {
        launch_failed(&result, message);
    }
    let tx_parent = tx.clone();
    if let Err(message) = sys::watch_parent(channel, parent_pid, move || {
        let _ = tx_parent.send(Event::ParentGone);
    }) {
        launch_failed(&result, message);
    }
    let _jail = match sys::Jail::new() {
        Ok(jail) => jail,
        Err(message) => launch_failed(&result, format!("could not create the job: {message}")),
    };

    let mut command = if args[2] == "shell" { sys::shell_command(&args[3]) } else { Command::new(&args[3]) };
    if args[2] != "shell" {
        command.args(&args[4..]);
    }
    sys::prepare(&mut command);
    let tx_spawn = tx.clone();
    thread::spawn(move || {
        let _ = tx_spawn.send(Event::Started(command.spawn()));
    });

    let started = {
        match rx.recv().expect("the senders live in this function") {
            Event::Started(result) => result,
            Event::Exited(_) => unreachable!("nothing waits on a program that was not started"),
            // The parent is gone or a signal came.
            stop => {
                let code = stop_code(&stop);
                match await_started(&rx) {
                    Some(Ok(child)) => {
                        let program = child.id();
                        let held = sys::adopt(child, tx.clone());
                        leave(code, &sys::end_tree(held, program, false).1);
                    }
                    Some(Err(_)) => exit(code),
                    None => {
                        eprintln!(
                            "treerun: starting the program did not return within {} s of a stop; a process still inside exec is not owned by this helper",
                            TREE_END_DEADLINE.as_secs()
                        );
                        exit(70);
                    }
                }
            }
        }
    };
    let child = match started {
        Ok(child) => child,
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "ELAUNCH",
            };
            report(&result, Some((code, error.to_string())), None, &Tree::new());
            exit(127);
        }
    };
    let program = child.id();
    let held = sys::adopt(child, tx.clone());

    let event = rx.recv().expect("the senders live in this function");
    // The program exited, the parent is gone or a signal came: either way nothing of the tree may stay.
    let (reaped, mut tree) = sys::end_tree(held, program, matches!(event, Event::Exited(_)));
    match event {
        Event::ParentGone => leave(0, &tree),
        #[cfg(unix)]
        Event::Signalled(signal) => leave(128 + signal, &tree),
        Event::Exited(waited) => {
            let status = match waited {
                Ok(Some(status)) => Some(status),
                Ok(None) => reaped,
                Err(message) => {
                    tree.failure.push(format!("waiting for the program failed: {message}"));
                    None
                }
            };
            report(&result, None, status.as_ref().and_then(sys::signal_of), &tree);
            leave(status.and_then(|s| s.code()).unwrap_or(0), &tree)
        }
        Event::Started(_) => unreachable!("the program was started once"),
    }
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

    /// No termination signals reach a detached, console-less helper; the parent ends it by killing it, and the job follows.
    pub fn watch_signals(_tx: Sender<Event>) -> Result<(), String> {
        Ok(())
    }

    pub fn adopt(mut child: Child, tx: Sender<Event>) -> Held {
        thread::spawn(move || {
            let _ = tx.send(Event::Exited(child.wait().map(Some).map_err(|e| e.to_string())));
        });
        Held
    }

    /// Calls `on_gone` when the parent process has exited. A parent created after this helper is a stranger on a reused pid.
    pub fn watch_parent(_channel: Result<(), String>, pid: u32, on_gone: impl FnOnce() + Send + 'static) -> Result<(), String> {
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

    /// SIGTERM, SIGINT and SIGHUP become events: the helper ends its tree instead of dying with the tree running. The
    /// handlers are reset by exec, so the program starts with the default actions.
    pub fn watch_signals(tx: Sender<Event>) -> Result<(), String> {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]).map_err(|e| format!("could not watch for termination signals: {e}"))?;
        thread::spawn(move || {
            for signal in signals.forever() {
                let _ = tx.send(Event::Signalled(signal));
            }
        });
        Ok(())
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

    /// Calls `on_gone` on EOF of the parent channel.
    pub fn watch_parent(channel: Result<std::fs::File, String>, _pid: u32, on_gone: impl FnOnce() + Send + 'static) -> Result<(), String> {
        let mut socket = channel?;
        thread::spawn(move || {
            let mut buffer = [0u8; 64];
            // EOF and a failed read both mean the parent cannot be watched any more.
            while let Ok(n) = socket.read(&mut buffer) {
                if n == 0 {
                    break;
                }
            }
            on_gone();
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
        (status, tree)
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
    use super::{inside, json_str, record, write_record, Tree};
    use std::path::PathBuf;

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
    fn the_record_carries_launch_signal_escapes_and_failure() {
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
    fn a_record_is_written_whole_or_not_at_all() {
        let root = Scratch::new("atomic");
        let target = root.0.join("result.json");
        let target_os = target.clone().into_os_string();
        write_record(&target_os, &record(None, None, &Tree::new())).unwrap();
        assert!(std::fs::read_to_string(&target).unwrap().ends_with(",\"complete\":true}"));
        assert!(!root.0.join("result.json.tmp").exists(), "the temporary file is renamed away");
        // A destination that cannot be replaced (a directory) fails and leaves no temporary file behind.
        let blocked = root.0.join("blocked");
        std::fs::create_dir_all(blocked.join("inner")).unwrap();
        assert!(write_record(&blocked.clone().into_os_string(), "{}").is_err());
        assert!(!root.0.join("blocked.tmp").exists());
        // A missing directory fails too, and a failed write leaves the earlier record untouched.
        assert!(write_record(&root.0.join("no-such-dir").join("r.json").into_os_string(), "{}").is_err());
        assert!(std::fs::read_to_string(&target).unwrap().contains("\"launch\":null"));
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
