//! mixdog-supervisor: runs one Mixdog daemon at a time, for as long as that
//! daemon runs, and replaces it when its main thread stops answering.
//!
//!   mixdog-supervisor --freeze-limit-ms <ms> --log <daemon.log> -- <program> [args...]
//!
//! The daemon is this process's child, reached over its stdin/stdout only:
//!   to the daemon    "hello <nonce>\n"            once, first
//!                    "ping <nonce>\n"             at most one unanswered
//!   from the daemon  "ready <hello nonce>\n"      it serves (heard once)
//!                    "pong <nonce> <detail>\n"    written by its main thread
//! Every nonce is 128 fresh bits from the OS random source, and only the
//! daemon's main thread reads its stdin, so only that thread can answer: its
//! stdout also carries whatever else writes to its fd 1 (other threads, native
//! code, inheriting children), and a line that names no nonce this process is
//! waiting for is skipped (see read_daemon), however protocol-like it looks.
//! The launcher reads this process's stdout for as long as it likes:
//!   "spawned <pid>\n" per daemon, "ready\n" per daemon that serves
//! (a launcher that closed its end is no longer told anything).
//!
//! A daemon whose oldest unanswered ping is `--freeze-limit-ms` old, in awake
//! time (a system sleep counts for neither side), gets one bounded diagnostics
//! line, is killed and waited for, and a replacement starts with the same
//! command; the daemon's own OS lock lets the replacement in once the kernel
//! released it. Any other daemon exit ends this process with the same status:
//! restarting after a crash stays the launcher's job.
//!
//! The daemon never outlives this process, and that does not depend on its
//! main thread running: on Windows it is the only member of a kill-on-close
//! job whose one handle this process holds; on Linux PR_SET_PDEATHSIG(SIGKILL)
//! is set before exec; elsewhere (macOS has no parent-death signal) it gets
//! the read end of a pipe only this process writes, which a thread of the
//! daemon watches for EOF.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The next ping goes out this long after an answer, so a freeze is killed at
/// most this long past the limit.
const PING_INTERVAL_MS: u64 = 1_000;
/// Diagnostics never hold the kill back longer than this: a hung disk or a
/// stderr pipe nobody drains blocks a write for good.
const DIAGNOSTICS_BUDGET: Duration = Duration::from_secs(2);

struct Options {
    freeze_limit_ms: u64,
    log: PathBuf,
    program: String,
    args: Vec<String>,
}

fn parse_options() -> Result<Options, String> {
    let mut argv = std::env::args().skip(1);
    let mut freeze_limit_ms = None;
    let mut log = None;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--freeze-limit-ms" => {
                freeze_limit_ms = argv.next().and_then(|value| value.parse::<u64>().ok()).filter(|ms| *ms > 0)
            }
            "--log" => log = argv.next().map(PathBuf::from),
            "--version" => {
                println!("mixdog-supervisor {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--" => break,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Options {
        freeze_limit_ms: freeze_limit_ms.ok_or_else(|| "missing --freeze-limit-ms".to_string())?,
        log: log.ok_or_else(|| "missing --log".to_string())?,
        program: argv.next().ok_or_else(|| "missing daemon command".to_string())?,
        args: argv.collect(),
    })
}

enum Event {
    Ready(String),
    Pong(String, String),
    Exited,
}

/// 128 bits from the OS random source, as hex: a challenge only a reader of
/// the daemon's stdin can answer.
fn nonce() -> String {
    let mut bytes = [0u8; 16];
    platform::fill_random(&mut bytes).unwrap_or_else(|error| fail(format!("os random source: {error}")));
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An event of the daemon started as `generation`; a killed daemon's late
/// events carry an older one.
struct Tagged {
    generation: u64,
    event: Event,
}

struct Daemon {
    child: Child,
    stdin: ChildStdin,
    /// The nonce its "ready" must carry; cleared once heard.
    hello: Option<String>,
    _bound: platform::Bound,
}

/// A protocol line is far shorter; anything longer is not one.
const MAX_LINE_BYTES: u64 = 4_096;

fn parse_line(line: &[u8]) -> Option<Event> {
    let line = line.strip_suffix(b"\n")?;
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if let Some(token) = line.strip_prefix(b"ready ") {
        return Some(Event::Ready(std::str::from_utf8(token).ok()?.to_string()));
    }
    let rest = line.strip_prefix(b"pong ")?;
    let end = rest.iter().position(|byte| *byte == b' ').unwrap_or(rest.len());
    let token = std::str::from_utf8(&rest[..end]).ok()?.to_string();
    let detail = rest.get(end + 1..).unwrap_or_default();
    Some(Event::Pong(token, String::from_utf8_lossy(detail).into_owned()))
}

/// The daemon's fd 1 is not only the link's: its native code and the children
/// that inherit it write there too. So the stream is read as bytes, every line
/// that is not a protocol line (not UTF-8, too long, or anything else) is
/// skipped, and only its end stops the reading; the link starts each line it
/// writes on a fresh one, so a stray partial write never swallows an answer.
fn read_daemon(stdout: ChildStdout, generation: u64, events: Sender<Tagged>) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    // The previous chunk was cut at MAX_LINE_BYTES: this one is its tail.
    let mut inside_overlong = false;
    loop {
        line.clear();
        match (&mut reader).take(MAX_LINE_BYTES).read_until(b'\n', &mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
        let tail = inside_overlong;
        inside_overlong = line.last() != Some(&b'\n');
        if tail {
            continue;
        }
        let Some(event) = parse_line(&line) else { continue };
        if events.send(Tagged { generation, event }).is_err() {
            return;
        }
    }
}

fn start(
    options: &Options,
    platform: &platform::Platform,
    events: &Sender<Tagged>,
    generation: u64,
) -> std::io::Result<Daemon> {
    let mut command = Command::new(&options.program);
    command
        .args(&options.args)
        .env("MIXDOG_DAEMON_SUPERVISED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut bound = platform.prepare(&mut command)?;
    let mut child = command.spawn()?;
    if let Err(error) = platform.adopt(&child, &mut bound) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut stdin = child.stdin.take().expect("piped stdin");
    let hello = nonce();
    // A daemon that already exited fails this write; its exit event follows.
    let _ = writeln!(stdin, "hello {hello}").and_then(|()| stdin.flush());
    let stdout = child.stdout.take().expect("piped stdout");
    let reader = events.clone();
    thread::spawn(move || read_daemon(stdout, generation, reader));
    let waiter = platform::ExitWaiter::new(&child)?;
    let exited = events.clone();
    thread::spawn(move || {
        waiter.wait();
        let _ = exited.send(Tagged { generation, event: Event::Exited });
    });
    Ok(Daemon { child, stdin, hello: Some(hello), _bound: bound })
}

fn tell(launcher: &mut Option<std::io::Stdout>, line: &str) {
    if let Some(out) = launcher {
        if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
            *launcher = None;
        }
    }
}

/// UTC wall-clock time as daemon.log stamps it.
fn iso_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let rem = secs % 86_400;
    // Days since the epoch to a proleptic Gregorian date.
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60,
        now.subsec_millis()
    )
}

/// One line to daemon.log, then to stderr (the launcher's capture file, or a
/// pipe nobody may read), on a thread of its own; returns once both are
/// written or DIAGNOSTICS_BUDGET passed.
fn diagnose(log: &Path, detail: &str) {
    let line = format!("[{}] [daemon] freeze supervisor: {detail}\n", iso_now());
    let log = log.to_path_buf();
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log) {
            let _ = file.write_all(line.as_bytes());
        }
        let _ = std::io::stderr().write_all(line.as_bytes());
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(DIAGNOSTICS_BUDGET);
}

fn fail(message: String) -> ! {
    let _ = writeln!(std::io::stderr(), "[mixdog-supervisor] {message}");
    std::process::exit(2);
}

fn main() {
    let options = parse_options().unwrap_or_else(|error| fail(error));
    let platform = platform::Platform::new().unwrap_or_else(|error| fail(format!("lifetime binding: {error}")));
    let (events, inbox) = mpsc::channel();
    let mut launcher = Some(std::io::stdout());
    let mut generation = 0;
    let mut daemon = start(&options, &platform, &events, generation)
        .unwrap_or_else(|error| fail(format!("daemon spawn: {error}")));
    tell(&mut launcher, &format!("spawned {}", daemon.child.id()));

    let limit = options.freeze_limit_ms;
    // Pings sent, for the log.
    let mut seq = 0u64;
    // Awake time the one unanswered ping went out, and its nonce.
    let mut outstanding: Option<(u64, String)> = None;
    let mut next_ping_at = platform::awake_ms();
    let mut answered_at = next_ping_at;
    let mut last_detail = String::new();
    loop {
        let due = outstanding.as_ref().map_or(next_ping_at, |(sent_at, _)| sent_at + limit);
        let wait = Duration::from_millis(due.saturating_sub(platform::awake_ms()));
        let event = match inbox.recv_timeout(wait) {
            Ok(tagged) if tagged.generation != generation => continue,
            Ok(tagged) => Some(tagged.event),
            Err(RecvTimeoutError::Timeout) => None,
            // This thread holds a sender.
            Err(RecvTimeoutError::Disconnected) => unreachable!(),
        };
        let now = platform::awake_ms();
        match event {
            Some(Event::Ready(token)) => {
                if daemon.hello.as_deref() == Some(token.as_str()) {
                    daemon.hello = None;
                    tell(&mut launcher, "ready");
                }
            }
            Some(Event::Pong(token, detail)) => {
                if outstanding.as_ref().is_some_and(|(_, expected)| *expected == token) {
                    outstanding = None;
                    answered_at = now;
                    last_detail = detail;
                    next_ping_at = now + PING_INTERVAL_MS;
                }
            }
            Some(Event::Exited) => match daemon.child.wait() {
                Ok(status) => platform::exit_like(status),
                Err(error) => fail(format!("daemon wait: {error}")),
            },
            None => match outstanding.as_ref().map(|(sent_at, _)| *sent_at) {
                None if now >= next_ping_at => {
                    seq += 1;
                    let token = nonce();
                    // A daemon that exited fails this write; its exit event follows.
                    let _ = writeln!(daemon.stdin, "ping {token}").and_then(|()| daemon.stdin.flush());
                    outstanding = Some((now, token));
                }
                Some(sent_at) if now >= sent_at + limit => {
                    let pid = daemon.child.id();
                    diagnose(
                        &options.log,
                        &format!(
                            "daemon pid={pid} left ping {seq} unanswered for {}ms (limit {limit}ms); its last \
                             answer, {}ms ago: {} — killing it and starting a replacement",
                            now - sent_at,
                            now - answered_at,
                            if last_detail.is_empty() { "-" } else { &last_detail }
                        ),
                    );
                    let _ = daemon.child.kill();
                    let _ = daemon.child.wait();
                    generation += 1;
                    daemon = start(&options, &platform, &events, generation)
                        .unwrap_or_else(|error| fail(format!("replacement spawn: {error}")));
                    diagnose(
                        &options.log,
                        &format!("frozen daemon pid={pid} exited; replacement pid={} started", daemon.child.id()),
                    );
                    tell(&mut launcher, &format!("spawned {}", daemon.child.id()));
                    outstanding = None;
                    answered_at = platform::awake_ms();
                    last_detail.clear();
                    next_ping_at = answered_at;
                }
                _ => {}
            },
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, ExitStatus};
    use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE,
    };

    #[link(name = "ntdll")]
    extern "system" {
        // Resumes every thread of a process created suspended; std does not
        // expose the primary thread handle.
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn QueryUnbiasedInterruptTime(time: *mut u64) -> i32;
    }

    pub fn fill_random(bytes: &mut [u8]) -> std::io::Result<()> {
        use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        let status = unsafe {
            BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
        };
        if status < 0 {
            return Err(std::io::Error::other(format!("BCryptGenRandom failed (NTSTATUS 0x{status:08x})")));
        }
        Ok(())
    }

    /// Milliseconds of interrupt time without sleep and hibernation.
    pub fn awake_ms() -> u64 {
        let mut time = 0u64;
        unsafe { QueryUnbiasedInterruptTime(&mut time) };
        time / 10_000
    }

    /// The job every daemon joins. Its handle is never closed by hand: it
    /// closes with this process, and that close kills the member. Silent
    /// breakaway keeps the daemon's own children out of it, as a parent-death
    /// signal binds only the child it is set on.
    pub struct Platform {
        job: HANDLE,
    }

    pub type Bound = ();

    impl Platform {
        pub fn new() -> std::io::Result<Self> {
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self { job })
        }

        /// Created suspended, so it runs nothing before it is a member.
        pub fn prepare(&self, command: &mut Command) -> std::io::Result<Bound> {
            command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            Ok(())
        }

        pub fn adopt(&self, child: &Child, _: &mut Bound) -> std::io::Result<()> {
            let process: HANDLE = child.as_raw_handle().cast();
            if unsafe { AssignProcessToJobObject(self.job, process) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let status = unsafe { NtResumeProcess(process) };
            if status < 0 {
                return Err(std::io::Error::other(format!("NtResumeProcess failed (NTSTATUS 0x{status:08x})")));
            }
            Ok(())
        }
    }

    /// Waits on its own handle, so the Child stays with the main thread.
    pub struct ExitWaiter(HANDLE);

    unsafe impl Send for ExitWaiter {}

    impl ExitWaiter {
        pub fn new(child: &Child) -> std::io::Result<Self> {
            let mut handle: HANDLE = std::ptr::null_mut();
            let duplicated = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    child.as_raw_handle().cast(),
                    GetCurrentProcess(),
                    &mut handle,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if duplicated == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self(handle))
        }

        pub fn wait(self) {
            unsafe {
                WaitForSingleObject(self.0, INFINITE);
                CloseHandle(self.0);
            }
        }
    }

    pub fn exit_like(status: ExitStatus) -> ! {
        std::process::exit(status.code().unwrap_or(1))
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command, ExitStatus};

    /// Milliseconds of a clock that stops while the system sleeps.
    pub fn awake_ms() -> u64 {
        #[cfg(target_vendor = "apple")]
        let clock = libc::CLOCK_UPTIME_RAW;
        #[cfg(not(target_vendor = "apple"))]
        let clock = libc::CLOCK_MONOTONIC;
        let mut now: libc::timespec = unsafe { std::mem::zeroed() };
        unsafe { libc::clock_gettime(clock, &mut now) };
        now.tv_sec as u64 * 1_000 + now.tv_nsec as u64 / 1_000_000
    }

    #[cfg(not(target_os = "linux"))]
    pub fn fill_random(bytes: &mut [u8]) -> std::io::Result<()> {
        if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    // The libc crate binds no getentropy for musl, the Linux release target.
    #[cfg(target_os = "linux")]
    pub fn fill_random(bytes: &mut [u8]) -> std::io::Result<()> {
        let mut filled = 0;
        while filled < bytes.len() {
            let rest = &mut bytes[filled..];
            let read = unsafe { libc::getrandom(rest.as_mut_ptr().cast(), rest.len(), 0) };
            if read < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            filled += read as usize;
        }
        Ok(())
    }

    pub struct Platform;

    #[cfg(target_os = "linux")]
    pub type Bound = ();

    /// This process's end of the daemon's lifeline: closed with it.
    #[cfg(not(target_os = "linux"))]
    pub struct Bound {
        read: Option<std::os::fd::OwnedFd>,
        _write: std::os::fd::OwnedFd,
    }

    impl Platform {
        pub fn new() -> std::io::Result<Self> {
            Ok(Self)
        }

        /// SIGKILL, not SIGTERM: a frozen main thread never runs a handler.
        /// The fork is made from the main thread, which lives as long as this
        /// process (the signal follows the forking thread). A parent already
        /// gone before the prctl is caught by the getppid check.
        #[cfg(target_os = "linux")]
        pub fn prepare(&self, command: &mut Command) -> std::io::Result<Bound> {
            let parent = unsafe { libc::getpid() };
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
            Ok(())
        }

        /// Both ends close-on-exec here; only the daemon's copy of the read end
        /// survives its exec, and no process but this one ever has the write end.
        #[cfg(not(target_os = "linux"))]
        pub fn prepare(&self, command: &mut Command) -> std::io::Result<Bound> {
            use std::os::fd::FromRawFd;
            let mut fds = [0; 2];
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let (read, write) = unsafe {
                (std::os::fd::OwnedFd::from_raw_fd(fds[0]), std::os::fd::OwnedFd::from_raw_fd(fds[1]))
            };
            for fd in fds {
                if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            let read_fd = fds[0];
            command.env("MIXDOG_DAEMON_LIFELINE_FD", read_fd.to_string());
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(read_fd, libc::F_SETFD, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            Ok(Bound { read: Some(read), _write: write })
        }

        #[cfg(target_os = "linux")]
        pub fn adopt(&self, _: &Child, _: &mut Bound) -> std::io::Result<()> {
            Ok(())
        }

        #[cfg(not(target_os = "linux"))]
        pub fn adopt(&self, _: &Child, bound: &mut Bound) -> std::io::Result<()> {
            bound.read = None;
            Ok(())
        }
    }

    /// Waits without reaping, so the pid cannot be reused while the main
    /// thread may still kill it; the main thread reaps.
    pub struct ExitWaiter(libc::pid_t);

    impl ExitWaiter {
        pub fn new(child: &Child) -> std::io::Result<Self> {
            Ok(Self(child.id() as libc::pid_t))
        }

        pub fn wait(self) {
            loop {
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                let waited = unsafe {
                    libc::waitid(libc::P_PID, self.0 as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT)
                };
                if waited == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    return;
                }
            }
        }
    }

    /// The daemon's status as this process's own: the same code, or the same
    /// signal raised again.
    pub fn exit_like(status: ExitStatus) -> ! {
        if let Some(signal) = status.signal() {
            unsafe {
                libc::signal(signal, libc::SIG_DFL);
                libc::raise(signal);
            }
            std::process::exit(128 + signal);
        }
        std::process::exit(status.code().unwrap_or(1))
    }
}
