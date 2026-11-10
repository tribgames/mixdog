//! `treerun <result-file> <parent-pid> args|shell <program> [args...]` runs the program as the root of a process tree
//! that is ended whole: when the program exits (its leftovers are ended too), and when the parent that started this helper
//! dies, however it dies. The helper's exit code is the program's, unchanged (an NTSTATUS such as 0xC0000005 arrives as
//! it is). What is not an exit code travels in the result file: the program could not be started
//! (`{"launch":"ENOENT","message":..}`), it died of a signal (`{"signal":9}`), or members of the tree outlived the kill
//! (`{"leftover":[pids]}`). The file is written only in those cases, so its absence means a plain exit code.
//!
//! Identity of the tree's members:
//! - Windows: a job object with kill-on-close that the helper joins before it starts the program. Every descendant is in
//!   it, whatever exits first, and nothing else is; the job is closed by the helper's exit however that comes.
//! - POSIX: the program leads its own process group, and every process that inherited the `MIXDOG_TREE_MARK` environment
//!   variable (unique per run) is ended too, which reaches a descendant that made its own session or group. Each is
//!   identified by pid and start time, read in one scan and compared again at the kill. A process that clears its
//!   environment before it forks escapes the mark. The parent's death is EOF on file descriptor 3, the parent's end of a
//!   socket pair that the parent holds.
//!
//! `treerun --members <mark>` lists, one pid per line, the processes that carry the mark (POSIX).
use std::ffi::OsString;
use std::process::{exit, Command};
use std::sync::mpsc;
use std::thread;

const MARK_VAR: &str = "MIXDOG_TREE_MARK";

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

fn report(path: &OsString, body: &str) {
    if let Err(error) = std::fs::write(path, body) {
        eprintln!("treerun: could not write {}: {error}", path.to_string_lossy());
        exit(70);
    }
}

enum Event {
    Program(std::io::Result<std::process::ExitStatus>),
    ParentGone,
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|a| a == "--members") {
        let mark = args.get(1).map(|m| m.to_string_lossy().into_owned()).unwrap_or_default();
        for (pid, _) in sys::marked(&mark) {
            println!("{pid}");
        }
        return;
    }
    if args.len() < 4 {
        eprintln!("usage: treerun <result-file> <parent-pid> args|shell <program> [args...]");
        exit(64);
    }
    let result = args[0].clone();
    let parent_pid: u32 = args[1].to_string_lossy().parse().unwrap_or_else(|_| {
        eprintln!("treerun: parent pid is not a number");
        exit(64);
    });
    let mark = std::env::var(MARK_VAR).unwrap_or_default();

    let jail = match sys::Jail::new() {
        Ok(jail) => jail,
        Err(message) => {
            report(&result, &format!("{{\"launch\":\"ELAUNCH\",\"message\":{}}}", json_str(&format!("could not create the job: {message}"))));
            exit(126);
        }
    };

    let mut command = if args[2] == "shell" { sys::shell_command(&args[3]) } else { Command::new(&args[3]) };
    if args[2] != "shell" {
        command.args(&args[4..]);
    }
    sys::prepare(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "ELAUNCH",
            };
            report(&result, &format!("{{\"launch\":\"{code}\",\"message\":{}}}", json_str(&format!("{error}"))));
            exit(127);
        }
    };
    let program_pid = child.id();

    let (tx, rx) = mpsc::channel();
    let tx_parent = tx.clone();
    thread::spawn(move || {
        let _ = tx.send(Event::Program(child.wait()));
    });
    thread::spawn(move || {
        sys::wait_parent(parent_pid);
        let _ = tx_parent.send(Event::ParentGone);
    });

    let event = rx.recv().expect("the watchers outlive main");
    // The program exited or the parent is gone: either way nothing of the tree may stay.
    let leftover = sys::end_tree(&jail, program_pid, &mark);
    match event {
        Event::ParentGone => exit(0),
        Event::Program(status) => {
            let status = status.unwrap_or_else(|error| {
                eprintln!("treerun: waiting for the program failed: {error}");
                exit(70);
            });
            if !leftover.is_empty() {
                report(&result, &format!("{{\"leftover\":[{}]}}", leftover.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",")));
            } else if let Some(signal) = sys::signal_of(&status) {
                report(&result, &format!("{{\"signal\":{signal}}}"));
            }
            exit(status.code().unwrap_or(0));
        }
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, ExitStatus};

    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
        fn GetProcessTimes(process: Handle, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: 144 bytes, LimitFlags at offset 16.
    #[repr(C)]
    struct ExtendedLimits {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        rest: [u8; 124],
    }

    /// The kill-on-close job the helper is a member of: its handle lives as long as the helper, so the job ends with it.
    pub struct Jail(#[allow(dead_code)] usize);

    impl Jail {
        pub fn new() -> Result<Jail, String> {
            // SAFETY: plain Win32 calls on handles created here; the info struct matches the documented layout.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job.is_null() {
                    return Err(format!("CreateJobObjectW failed: {}", GetLastError()));
                }
                let mut info = ExtendedLimits { per_process_user_time: 0, per_job_user_time: 0, limit_flags: 0x2000, rest: [0; 124] };
                if SetInformationJobObject(job, 9, (&mut info as *mut ExtendedLimits).cast(), std::mem::size_of::<ExtendedLimits>() as u32) == 0 {
                    return Err(format!("SetInformationJobObject failed: {}", GetLastError()));
                }
                if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                    return Err(format!("AssignProcessToJobObject failed: {}", GetLastError()));
                }
                Ok(Jail(job as usize))
            }
        }
    }

    pub fn shell_command(line: &std::ffi::OsString) -> Command {
        let mut command = Command::new("cmd.exe");
        let mut raw = std::ffi::OsString::from("/d /s /c \"");
        raw.push(line);
        raw.push("\"");
        command.raw_arg(raw);
        command
    }

    /// The helper has no console (it is spawned detached); without this each console program it starts would create a console
    /// window host of its own, which costs ~150 ms per spawn.
    pub fn prepare(command: &mut Command) {
        command.creation_flags(0x0800_0000);
    }

    /// Returns when the parent process has exited. A parent created after this helper is a stranger on a reused pid.
    pub fn wait_parent(pid: u32) {
        // SAFETY: handles opened here are closed here; FILETIME out-pointers are valid locals.
        unsafe {
            let parent = OpenProcess(0x0010_0000 | 0x1000, 0, pid);
            if parent.is_null() {
                return;
            }
            let (mut mine, mut theirs, mut ignored) = (FileTime::default(), FileTime::default(), FileTime::default());
            let own_ok = GetProcessTimes(GetCurrentProcess(), &mut mine, &mut ignored, &mut ignored, &mut ignored);
            let their_ok = GetProcessTimes(parent, &mut theirs, &mut ignored, &mut ignored, &mut ignored);
            let key = |t: FileTime| (u64::from(t.high) << 32) | u64::from(t.low);
            if own_ok != 0 && their_ok != 0 && key(theirs) > key(mine) {
                CloseHandle(parent);
                return;
            }
            WaitForSingleObject(parent, 0xFFFF_FFFF);
            CloseHandle(parent);
        }
    }

    /// The job ends everything with the helper's exit; nothing is left to report.
    pub fn end_tree(_jail: &Jail, _program: u32, _mark: &str) -> Vec<u32> {
        Vec::new()
    }

    pub fn signal_of(_status: &ExitStatus) -> Option<i32> {
        None
    }

    pub fn marked(_mark: &str) -> Vec<(u32, String)> {
        eprintln!("treerun --members: POSIX only; a Windows tree is a job object");
        std::process::exit(2);
    }
}

#[cfg(unix)]
mod sys {
    use std::io::Read;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Command, ExitStatus};

    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGKILL: i32 = 9;

    pub struct Jail;

    impl Jail {
        pub fn new() -> Result<Jail, String> {
            Ok(Jail)
        }
    }

    pub fn shell_command(line: &std::ffi::OsString) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(line);
        command
    }

    /// The program leads a process group of its own, so the whole group can be signalled by its id.
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }

    /// Returns on EOF of file descriptor 3: the parent's end of the socket pair closed.
    pub fn wait_parent(_pid: u32) {
        // SAFETY: descriptor 3 is the socket the parent passed; it is owned by this thread from here on.
        let mut socket = unsafe { <std::fs::File as std::os::unix::io::FromRawFd>::from_raw_fd(3) };
        let mut buffer = [0u8; 64];
        // EOF and a failed read both mean the parent cannot be watched any more.
        while let Ok(n) = socket.read(&mut buffer) {
            if n == 0 {
                break;
            }
        }
    }

    pub fn signal_of(status: &ExitStatus) -> Option<i32> {
        status.signal()
    }

    /// Ends the program's process group, then every process that carries the mark, until none is left; answers the pids
    /// that could not be ended.
    pub fn end_tree(_jail: &Jail, program: u32, mark: &str) -> Vec<u32> {
        // SAFETY: signalling a process group by id.
        unsafe {
            kill(-(program as i32), SIGKILL);
        }
        let mut remaining = Vec::new();
        for _ in 0..200 {
            remaining = marked(mark);
            if remaining.is_empty() {
                break;
            }
            for (pid, start) in &remaining {
                // The identity is pid and start time: a pid that now has another start time is somebody else's.
                if start_time(*pid).as_deref() == Some(start.as_str()) {
                    // SAFETY: signalling one process by pid, identity just compared.
                    unsafe {
                        kill(*pid as i32, SIGKILL);
                    }
                }
            }
        }
        remaining.into_iter().map(|(pid, _)| pid).collect()
    }

    #[cfg(target_os = "linux")]
    fn carries(environ: &[u8], mark: &str) -> bool {
        let wanted = format!("{}={mark}", super::MARK_VAR);
        environ.split(|b| *b == 0).any(|entry| entry == wanted.as_bytes())
    }

    #[cfg(target_os = "linux")]
    fn start_time(pid: u32) -> Option<String> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Fields after the parenthesised name: state is the first, start time the twentieth.
        stat.rsplit_once(')')?.1.split_whitespace().nth(19).map(str::to_owned)
    }

    /// The pids (with start times) of the processes of this user that carry the mark, other than this helper.
    #[cfg(target_os = "linux")]
    pub fn marked(mark: &str) -> Vec<(u32, String)> {
        let me = std::process::id();
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        let mut found = Vec::new();
        for entry in dir.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            if pid == me {
                continue;
            }
            // Another user's environ is unreadable, and so is a zombie's: neither is ours to end.
            let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else { continue };
            if carries(&environ, mark) {
                if let Some(start) = start_time(pid) {
                    found.push((pid, start));
                }
            }
        }
        found
    }

    #[cfg(not(target_os = "linux"))]
    fn start_time(pid: u32) -> Option<String> {
        let out = Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!text.is_empty()).then_some(text)
    }

    /// macOS: `ps -E` appends each process's environment to its command line; the lstart column is five words.
    #[cfg(not(target_os = "linux"))]
    pub fn marked(mark: &str) -> Vec<(u32, String)> {
        let me = std::process::id();
        let Ok(out) = Command::new("ps").args(["-E", "-ww", "-A", "-o", "pid=,lstart=,command="]).output() else { return Vec::new() };
        let wanted = format!("{}={mark}", super::MARK_VAR);
        let mut found = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let words: Vec<&str> = line.split_whitespace().collect();
            let Some(pid) = words.first().and_then(|w| w.parse::<u32>().ok()) else { continue };
            if pid == me || words.len() < 7 || !words[6..].iter().any(|w| *w == wanted) {
                continue;
            }
            found.push((pid, words[1..6].join(" ")));
        }
        found
    }
}
