//! `treerun <result-file> <parent-pid> args|shell <program> [args...]` runs the program as the root of a process tree that
//! is ended whole: when the program exits (what it left behind is ended too) and when the process that started this helper
//! dies, however it dies. The helper's exit code is the program's, unchanged (an NTSTATUS such as 0xC0000005 arrives as it
//! is). Everything else travels in the result file, which the helper writes last and which ends with `"complete":true`:
//! `launch` (the program could not be started: ENOENT, EACCES, ELAUNCH, with `message`) and `signal` (the program died of
//! one). A parent that finds no complete file knows the helper died before it reported.
//!
//! The tree is owned, never searched for:
//! - Windows: a job object with kill-on-close that the helper joins before it starts the program. Every descendant is in
//!   it, whatever exits first, and nothing else is; the job closes when the helper exits, however that comes.
//! - POSIX: the program leads a process group of its own. The helper learns that the program exited without reaping it
//!   (`waitid` with WNOWAIT), so its pid and group id still belong to it, signals the group, and only then reaps. A
//!   descendant that made its own session or group is outside the group: nothing here goes looking for it by a number.
//!   The parent's death is EOF on descriptor 3, the parent's end of a socket pair (close-on-exec, read from before the
//!   program is started).
//!
//! `treerun --end-inside <dir> <pid>` ends one process that a run left behind, only if it is verified to be inside `dir`
//! on the very handle it then terminates (Windows: process handle, image path; Linux: pidfd, /proc exe link, still alive
//! after the read). macOS has no such handle: it answers 4 and ends nothing.
use std::ffi::OsString;
use std::process::{exit, Command, ExitStatus};
use std::sync::mpsc;

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

/// The result file's body. `"complete":true` is its last member: a file cut short anywhere does not end with it.
fn record(launch: Option<(&str, String)>, signal: Option<i32>) -> String {
    let launch = launch.map_or("null".to_owned(), |(code, message)| format!("{},\"message\":{}", json_str(code), json_str(&message)));
    let signal = signal.map_or("null".to_owned(), |s| s.to_string());
    format!("{{\"launch\":{launch},\"signal\":{signal},\"complete\":true}}")
}

fn report(path: &OsString, launch: Option<(&str, String)>, signal: Option<i32>) {
    if let Err(error) = std::fs::write(path, record(launch, signal)) {
        eprintln!("treerun: could not write {}: {error}", path.to_string_lossy());
        exit(70);
    }
}

/// Whether `path` lies inside `dir`, by whole path components (`/a/bc` is not inside `/a/b`) and after both are resolved
/// (a symlinked or differently written root is the same directory). A path that no longer exists, such as the executable
/// of a process whose file was deleted, is resolved through its nearest existing ancestor.
fn inside(path: &std::path::Path, dir: &std::path::Path) -> bool {
    fn resolved(p: &std::path::Path) -> std::path::PathBuf {
        let mut missing = Vec::new();
        let mut at = p;
        loop {
            if let Ok(real) = at.canonicalize() {
                return missing.iter().rev().fold(real, |path, name| path.join(name));
            }
            match (at.parent(), at.file_name()) {
                (Some(parent), Some(name)) => {
                    missing.push(name);
                    at = parent;
                }
                _ => return p.to_path_buf(),
            }
        }
    }
    resolved(path).starts_with(resolved(dir))
}

enum Event {
    /// The program exited; Windows has its status already, POSIX reaps it after the group is signalled.
    Exited(Option<ExitStatus>),
    ParentGone,
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
    // Before the program exists: a parent that dies from here on is seen, and the program never holds the channel.
    let tx_parent = tx.clone();
    if let Err(message) = sys::watch_parent(channel, parent_pid, move || {
        let _ = tx_parent.send(Event::ParentGone);
    }) {
        report(&result, Some(("ELAUNCH", message)), None);
        exit(126);
    }
    let _jail = match sys::Jail::new() {
        Ok(jail) => jail,
        Err(message) => {
            report(&result, Some(("ELAUNCH", format!("could not create the job: {message}"))), None);
            exit(126);
        }
    };

    let mut command = if args[2] == "shell" { sys::shell_command(&args[3]) } else { Command::new(&args[3]) };
    if args[2] != "shell" {
        command.args(&args[4..]);
    }
    sys::prepare(&mut command);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "ELAUNCH",
            };
            report(&result, Some((code, error.to_string())), None);
            exit(127);
        }
    };
    let program = child.id();
    let held = sys::watch_program(child, tx);

    let event = rx.recv().expect("the watchers outlive main");
    // The program exited or the parent is gone: either way nothing of the tree may stay.
    sys::end_tree(program);
    match event {
        Event::ParentGone => exit(0),
        Event::Exited(status) => {
            let Some(status) = status.or_else(|| held.reap()) else {
                eprintln!("treerun: waiting for the program failed");
                exit(70);
            };
            report(&result, None, sys::signal_of(&status));
            exit(status.code().unwrap_or(0));
        }
    }
}

#[cfg(windows)]
mod sys {
    use super::Event;
    use std::process::{Child, Command, ExitStatus};
    use std::sync::mpsc::Sender;
    use std::thread;
    use win32job::{ExtendedLimitInfo, Job};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, INFINITE,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// The kill-on-close job the helper is a member of: its handle lives as long as the helper, so the job ends with it.
    pub struct Jail(#[allow(dead_code)] Job);

    impl Jail {
        pub fn new() -> Result<Jail, String> {
            let mut limits = ExtendedLimitInfo::new();
            limits.limit_kill_on_job_close();
            let job = Job::create_with_limit_info(&limits).map_err(|e| e.to_string())?;
            job.assign_current_process().map_err(|e| e.to_string())?;
            Ok(Jail(job))
        }
    }

    pub struct Held;

    impl Held {
        pub fn reap(self) -> Option<ExitStatus> {
            None
        }
    }

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

    pub fn watch_program(mut child: Child, tx: Sender<Event>) -> Held {
        thread::spawn(move || {
            let _ = tx.send(Event::Exited(child.wait().ok()));
        });
        Held
    }

    /// Calls `on_gone` when the parent process has exited. A parent created after this helper is a stranger on a reused pid.
    pub fn watch_parent(_channel: Result<(), String>, pid: u32, on_gone: impl FnOnce() + Send + 'static) -> Result<(), String> {
        // SAFETY: handles opened here are owned by the thread and closed there; the FILETIME out-pointers are valid locals.
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
    pub fn end_tree(_program: u32) {}

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
        if !super::inside(std::path::Path::new(&image), std::path::Path::new(dir)) {
            eprintln!("treerun: pid {pid} runs {image}, not inside {dir}");
            return 3;
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
    use super::Event;
    use rustix::io::{fcntl_setfd, FdFlags};
    use rustix::process::{kill_process_group, waitid, Pid, Signal, WaitId, WaitIdOptions};
    use std::io::Read;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command, ExitStatus};
    use std::sync::mpsc::Sender;
    use std::thread;

    pub struct Jail;

    impl Jail {
        pub fn new() -> Result<Jail, String> {
            Ok(Jail)
        }
    }

    /// The program, not yet reaped: while it is held, its pid and process group id cannot belong to anything else.
    pub struct Held(Child);

    impl Held {
        pub fn reap(mut self) -> Option<ExitStatus> {
            self.0.wait().ok()
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

    /// Waits for the program's exit without reaping it (WNOWAIT): the zombie keeps the pid and the group id.
    pub fn watch_program(child: Child, tx: Sender<Event>) -> Held {
        let pid = Pid::from_raw(child.id() as i32).expect("a child's pid is positive");
        thread::spawn(move || {
            let _ = waitid(WaitId::Pid(pid), WaitIdOptions::EXITED | WaitIdOptions::NOWAIT);
            let _ = tx.send(Event::Exited(None));
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

    /// Signals the program's group while the program is still unreaped (its group id is therefore still its own). It is
    /// never the helper's own group: the program was started in a group of its own.
    pub fn end_tree(program: u32) {
        if let Some(pid) = Pid::from_raw(program as i32) {
            let _ = kill_process_group(pid, Signal::KILL);
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
        if poll(&mut fds, Some(&now)).map_or(true, |ready| ready != 0) {
            eprintln!("treerun: pid {pid} exited while it was being verified");
            return 3;
        }
        let dir = std::path::Path::new(dir);
        if !super::inside(&exe, dir) {
            eprintln!("treerun: pid {pid} runs {}, not inside {}", exe.display(), dir.display());
            return 3;
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
    use super::{inside, json_str, record};
    use std::path::{Path, PathBuf};

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
        for body in [record(None, None), record(None, Some(9)), record(Some(("ENOENT", "no such file".into())), None)] {
            assert!(body.ends_with(",\"complete\":true}"), "{body}");
        }
    }

    #[test]
    fn the_record_carries_launch_and_signal() {
        assert_eq!(record(None, None), r#"{"launch":null,"signal":null,"complete":true}"#);
        assert_eq!(record(None, Some(9)), r#"{"launch":null,"signal":9,"complete":true}"#);
        assert_eq!(
            record(Some(("EACCES", "denied".into())), None),
            r#"{"launch":"EACCES","message":"denied","signal":null,"complete":true}"#
        );
    }

    #[test]
    fn strings_are_escaped_so_a_message_cannot_end_the_record_early() {
        assert_eq!(json_str("a\"b\\c\n\u{1}"), r#""a\"b\\c\u000a\u0001""#);
        let body = record(Some(("ELAUNCH", "\",\"complete\":true}".into())), None);
        assert_eq!(body.matches("\"complete\":true}").count(), 1, "{body}");
    }

    #[test]
    fn a_path_in_the_directory_is_inside_and_a_sibling_sharing_its_prefix_is_not() {
        let root = Scratch::new("prefix");
        let (dir, sibling) = (root.0.join("profile"), root.0.join("profile-other"));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(dir.join("bin").join("core"), "").unwrap();
        std::fs::write(sibling.join("core"), "").unwrap();
        assert!(inside(&dir.join("bin").join("core"), &dir));
        assert!(!inside(&sibling.join("core"), &dir));
        assert!(!inside(&dir, &dir.join("bin")), "the parent is not inside its child");
    }

    #[test]
    fn a_path_that_no_longer_exists_is_resolved_through_its_existing_ancestor() {
        let root = Scratch::new("gone");
        let dir = root.0.join("profile");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(inside(&dir.join("deleted-core"), &dir));
        assert!(!inside(&root.0.join("profile-deleted"), &dir));
        assert!(!inside(Path::new("/"), &dir));
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
        assert!(inside(&real.join("core"), &link));
        assert!(inside(&link.join("core"), &real));
        let sibling = root.0.join("real-other");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("core"), "").unwrap();
        assert!(!inside(&sibling.join("core"), &link));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_differ_only_in_case_or_form_are_the_same_directory() {
        let root = Scratch::new("case");
        let dir = root.0.join("Profile");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("core.exe"), "").unwrap();
        let swapped = PathBuf::from(dir.to_string_lossy().to_uppercase());
        assert!(inside(&dir.join("core.exe"), &swapped));
        assert!(inside(&dir.join("core.exe"), &PathBuf::from(dir.to_string_lossy().replace('\\', "/"))));
    }
}