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
//! Alive or stalled by the machine is not stuck. A machine short of memory or
//! disk can keep a live main thread from answering for minutes: it sits in
//! the kernel on a page-in or a write, shows no CPU and no completed I/O, and
//! killing it loses every agent and shell job it holds (and its replacement
//! would stall the same way). What tells it from a deadlock is the thread
//! itself: one the machine holds waits in the kernel for memory or a transfer,
//! one that is deadlocked waits on a user-mode lock, one that spins runs. The
//! rule, applied at the limit and at every look after it, over the window
//! since the previous look (the first look is taken `min(5 s, limit / 2)`
//! after the ping, so an answered ping costs no reading at all):
//!
//!  1. ANY change of the daemon's own counters means alive: user or kernel
//!     CPU time (children it reaped included), I/O operations, I/O bytes,
//!     page faults.
//!  2. ANY change of the counters of a descendant seen at both looks means
//!     alive: a daemon that waits for children that do the work is working.
//!     A process is its pid plus its start time, so one that exited (and a
//!     pid handed out again) is neither credit nor debt.
//!  3. Its main thread waiting on the machine at both looks means stalled by
//!     the machine, not stuck: Windows Waiting with reason Executive (where
//!     the I/O manager waits for a synchronous transfer and the memory manager
//!     for a hard page-in), a page or pool wait, a kernel-only lock (the file
//!     system's ERESOURCE held across a flush), or Transition (stack paged
//!     out); Linux state D; macOS TH_STATE_UNINTERRUPTIBLE. The log also
//!     counts its other threads in such waits.
//!  4. Otherwise (nothing moves and its main thread waits on a user-mode lock,
//!     an event, its event loop, or runs; or it cannot be read) it is stuck:
//!     killed at the limit.
//!
//! Every reading is one unprivileged snapshot: Windows NtQuerySystemInformation
//! (SystemProcessInformation: every process's counters, parent, start time,
//! and every thread's state and wait reason); Linux /proc/<pid>/stat + io and
//! /proc/<pid>/task/*/stat; macOS proc_pidinfo (TASKINFO, TBSDINFO,
//! LISTTHREADS + THREADINFO).
//!
//! Measured on Windows 11 (32 GiB, Samsung 990 NVMe; the disk saturated by a
//! process with 48 concurrent 8 MiB write + fdatasync loops), node children,
//! one snapshot every ~15 ms, 300 snapshots per row; "pairs" are successive
//! snapshots, "on the machine" is clause 3:
//!
//!   case                                main thread seen                       counters / pairs on the machine
//!   (a) random 4 KiB hard page-ins of   Executive 280, Running 18, Ready 1,    faults +11 523, changed in 299 of 299
//!       a cold mapped file, saturated   Standby 1                              pairs; on the machine at both 260
//!   (a) same, disk quiet                Executive 249, Running 45, other 6     faults +19 925; 201
//!   (a) 64 MiB writeSync + fsyncSync    Executive 187, WrResource 54,          changed in 86 of 299 pairs; on the
//!       loop, saturated                 Running 56, Standby 2, WrFastMutex 1   machine at both 134
//!   (a) 2 GiB heap, EmptyWorkingSet     Running 278, Ready 22                  faults +4.9 M (soft: 11 GiB free, the
//!       every 200 ms, saturated                                                pages come back from standby), 294 of 299
//!   (a) a synchronous read that never   Executive 300                          flat; on the machine at both 299
//!       completes (a named pipe)
//!   (b) Atomics.wait for ever           WrAlertByThreadId 300                  flat; 0
//!   (c) for (;;) {}                     Running 292, Ready 8                   CPU +4.5 s, changed in 278; 0
//!   (d) idle event loop                 WrQueue 300                            flat; 0
//!   node's other threads, every row     UserRequest, WrUserRequest, WrQueue,   never on the machine
//!                                       WrAlertByThreadId
//!
//! Linux (WSL2 6.6 kernel, ext4 on a virtual disk saturated by four
//! `dd conv=fsync` loops, busybox children, 200 snapshots at ~10 ms): 4 KiB
//! O_DIRECT reads D 199/200; one 12 MiB `dd conv=fsync` D 43/44 with counters
//! changed in 1 of 43 pairs; `flock` on a held lock S 200; `sleep` S 200; a
//! shell spinning R 200, CPU +2 s. macOS is not measured (no such machine).
//!
//! So a disk-stalled thread is caught by counters while transfers complete
//! and by its kernel wait while one does not, and no user-mode wait, spin or
//! idle loop ever reads as one; the memory-based machine reading this
//! replaces (available memory, system page-ins) is gone, since a starved
//! machine says nothing about whether this daemon waits on it. A system-wide
//! disk signal (PDH PhysicalDisk % Idle Time) is not read for the same
//! reason, and because a PDH query loads performance providers that can
//! themselves block. A real disk could not be held for seconds here without
//! privilege (job I/O rate control returns ERROR_INVALID_FUNCTION), so the
//! suite holds the same kernel wait with a synchronous read that never
//! completes. That is also the rule's blind spot: a main thread blocked for
//! good on a synchronous read of a pipe or a dead share looks like a disk
//! stall and lives to the cap.
//!
//! An extension is `limit / 2` from the look, then the daemon is looked at
//! again. Every look logs its numbers and which clause decided. Readings run
//! on a thread of their own, one at a time; a reading the machine holds up
//! is waited for, never past the cap.
//!
//! The hard cap is `--freeze-cap-ms` (default 2.5 × the limit, 300 s for the
//! default limit) after the unanswered ping went out: whatever the process
//! does, and whatever reading is still on its way, it is killed then. So a
//! main thread in an endless loop (CPU advances for ever) and one held by the
//! machine for ever are both gone 300 s after the ping, 180 s later than a
//! deadlock: the stall that motivated this lasted over the limit with a 46 s
//! replacement gap, so the cap leaves room for several such stalls while
//! bounding the outage at five minutes. A cap below ~2 × the limit would kill
//! the daemon the first extension was meant to spare.
//!
//! The suite's instruments and its one seam (MIXDOG_SUPERVISOR_STALL_READINGS:
//! every reading hangs) exist only with the cargo feature "suite".
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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The next ping goes out this long after an answer, so a freeze is killed at
/// most this long past the limit.
const PING_INTERVAL_MS: u64 = 1_000;
/// The first look at an unanswered ping comes this long after it (at most
/// half the limit), so the process table is read only for a ping that hangs.
const BASELINE_DELAY_MS: u64 = 5_000;
/// Diagnostics never hold the kill back longer than this: a hung disk or a
/// stderr pipe nobody drains blocks a write for good.
const DIAGNOSTICS_BUDGET: Duration = Duration::from_secs(2);
/// Readings that have not come back, over every daemon this supervisor ran:
/// a reading that never returns outlives the daemon it was of.
static READINGS_OUT: AtomicUsize = AtomicUsize::new(0);
/// One reading may still be finishing for a daemon just replaced. A second
/// that has not returned means readings hang on this machine: no further
/// thread is spent on one, and a daemon that cannot be read gets no time
/// past the limit.
const READINGS_OUT_LIMIT: usize = 2;

/// What the OS reports a process has done so far; only changes matter. A
/// counter is compared for any change, never for growth, and differenced with
/// wrapping arithmetic in its own width: Windows keeps page faults in 32 bits,
/// and a counter that wrapped inside a window still reads as an advance.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counters {
    /// User + kernel CPU time.
    cpu_ms: u64,
    /// I/O operations (syscalls on Unix) and the bytes they moved, 0 when the OS does not say.
    io_ops: u64,
    io_bytes: u64,
    /// Page faults (soft ones included), modulo 2^32.
    faults: u32,
}

impl Counters {
    fn advanced_since(&self, before: &Counters) -> bool {
        self != before
    }

    /// What was done between `before` and this reading.
    fn since(&self, before: &Counters) -> Counters {
        Counters {
            cpu_ms: self.cpu_ms.wrapping_sub(before.cpu_ms),
            io_ops: self.io_ops.wrapping_sub(before.io_ops),
            io_bytes: self.io_bytes.wrapping_sub(before.io_bytes),
            faults: self.faults.wrapping_sub(before.faults),
        }
    }

    fn add(&mut self, other: &Counters) {
        self.cpu_ms = self.cpu_ms.wrapping_add(other.cpu_ms);
        self.io_ops = self.io_ops.wrapping_add(other.io_ops);
        self.io_bytes = self.io_bytes.wrapping_add(other.io_bytes);
        self.faults = self.faults.wrapping_add(other.faults);
    }
}

impl std::fmt::Display for Counters {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cpu +{}ms, io +{} ops / +{} bytes, faults +{}", self.cpu_ms, self.io_ops, self.io_bytes, self.faults)
    }
}

/// A process is its pid and its start time together: a pid the OS hands out
/// again is another process.
type Identity = (u32, u64);

/// One thread of the daemon at a reading.
pub struct ThreadState {
    main: bool,
    /// As the OS names it: "Waiting/WrPageIn", "D", "uninterruptible", ...
    name: String,
    /// Waiting in the kernel on the machine (see platform::on_machine).
    on_machine: bool,
}

/// The daemon's threads at one reading.
#[derive(Clone, Debug, Default)]
pub struct Threads {
    main: String,
    main_on_machine: bool,
    /// Threads waiting on the machine, of all its threads.
    on_machine: u32,
    total: u32,
}

impl Threads {
    /// None when the main thread is not among them.
    fn of(states: &[ThreadState]) -> Option<Threads> {
        let main = states.iter().find(|thread| thread.main)?;
        Some(Threads {
            main: main.name.clone(),
            main_on_machine: main.on_machine,
            on_machine: states.iter().filter(|thread| thread.on_machine).count() as u32,
            total: states.len() as u32,
        })
    }
}

/// The daemon and its descendants at one instant.
#[derive(Clone, Debug)]
pub struct Reading {
    own: Counters,
    tree: Vec<(Identity, Counters)>,
    threads: Threads,
}

/// A process in the OS's table.
pub struct Proc {
    pid: u32,
    ppid: u32,
    /// Start time in the OS's own unit (only compared within one OS).
    start: u64,
    counters: Counters,
}

/// `root` and its descendants found by parent pid in `all`. A child is never
/// older than its parent, so a process whose parent's pid was handed out again
/// is not adopted.
fn reading(root: u32, all: &[Proc], threads: Threads) -> Option<Reading> {
    let mut found = vec![all.iter().find(|process| process.pid == root)?];
    let mut next = 0;
    while next < found.len() {
        let parent = found[next];
        next += 1;
        for process in all {
            if process.ppid == parent.pid
                && process.pid != parent.pid
                && process.start >= parent.start
                && !found.iter().any(|known| known.pid == process.pid)
            {
                found.push(process);
            }
        }
    }
    Some(Reading {
        own: found[0].counters,
        tree: found[1..].iter().map(|process| ((process.pid, process.start), process.counters)).collect(),
        threads,
    })
}

/// The daemon's reading, off the main loop (see `main`).
fn read(pid: u32) -> Option<Reading> {
    // The suite's stand-in for a reading the machine holds up for good.
    #[cfg(feature = "suite")]
    if std::env::var_os("MIXDOG_SUPERVISOR_STALL_READINGS").is_some() {
        loop {
            thread::park();
        }
    }
    let (all, states) = platform::snapshot(pid)?;
    reading(pid, &all, Threads::of(&states)?)
}

const OWN_ADVANCE: &str = "its own counters advance";
const TREE_ADVANCE: &str = "its descendants' counters advance";
const MAIN_ON_MACHINE: &str = "its main thread waits in the kernel on the machine";

/// Why the daemon is to be given more time between two readings (None: it is
/// stuck), and the numbers behind it.
fn judge(before: &Reading, after: &Reading, window_ms: u64) -> (Option<&'static str>, String) {
    let (mut survived, mut advanced, mut work) = (0, 0, Counters::default());
    for (identity, counters) in &after.tree {
        let Some((_, earlier)) = before.tree.iter().find(|(known, _)| known == identity) else { continue };
        survived += 1;
        if counters.advanced_since(earlier) {
            advanced += 1;
            work.add(&counters.since(earlier));
        }
    }
    let reason = if after.own.advanced_since(&before.own) {
        Some(OWN_ADVANCE)
    } else if advanced > 0 {
        Some(TREE_ADVANCE)
    } else if before.threads.main_on_machine && after.threads.main_on_machine {
        Some(MAIN_ON_MACHINE)
    } else {
        None
    };
    let numbers = format!(
        "own[{}] tree[{} procs, {survived} survived, {advanced} advanced: {work}] main thread[{} -> {}] \
         threads on the machine[{} -> {} of {}] over {window_ms}ms",
        after.own.since(&before.own),
        after.tree.len(),
        before.threads.main,
        after.threads.main,
        before.threads.on_machine,
        after.threads.on_machine,
        after.threads.total
    );
    (reason, numbers)
}

/// The suite's instruments (cargo feature "suite"; a product build has none).
#[cfg(feature = "suite")]
mod suite {
    /// `--threads <pid> <samples> <interval-ms>`: every thread state seen,
    /// counted, then the main thread's, then the own counters' changes.
    pub fn sample(pid: u32, samples: u32, interval_ms: u64) {
        use std::collections::BTreeMap;
        let mut all = BTreeMap::new();
        let mut main = BTreeMap::new();
        let mut first = None;
        let mut last = None;
        let (mut seen, mut advanced, mut stalled_pairs) = (0, 0, 0);
        let mut previous: Option<crate::Reading> = None;
        for _ in 0..samples {
            if let Some((processes, states)) = crate::platform::snapshot(pid) {
                for state in &states {
                    let key = format!("{}{}", state.name, if state.on_machine { " [machine]" } else { "" });
                    *all.entry(key.clone()).or_insert(0u32) += 1;
                    if state.main {
                        *main.entry(key).or_insert(0u32) += 1;
                    }
                }
                if let Some(reading) =
                    crate::Threads::of(&states).and_then(|threads| crate::reading(pid, &processes, threads))
                {
                    seen += 1;
                    if let Some(before) = &previous {
                        if reading.own.advanced_since(&before.own) {
                            advanced += 1;
                        }
                        if before.threads.main_on_machine && reading.threads.main_on_machine {
                            stalled_pairs += 1;
                        }
                    }
                    first.get_or_insert(reading.own);
                    last = Some(reading.own);
                    previous = Some(reading);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }
        println!("readings {seen}, own counters changed between {advanced}, main on the machine at both of {stalled_pairs}");
        if let (Some(first), Some(last)) = (first, last) {
            println!("own over the run: {}", last.since(&first));
        }
        for (name, count) in &main {
            println!("main {count:>6}  {name}");
        }
        for (name, count) in &all {
            println!("all  {count:>6}  {name}");
        }
    }
}

struct Options {
    freeze_limit_ms: u64,
    /// Awake time after the unanswered ping at which the daemon is killed whatever it does.
    freeze_cap_ms: u64,
    log: PathBuf,
    program: String,
    args: Vec<String>,
}

fn parse_options() -> Result<Options, String> {
    let mut argv = std::env::args().skip(1);
    let mut freeze_limit_ms = None;
    let mut freeze_cap_ms = None;
    let mut log = None;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--freeze-limit-ms" => {
                freeze_limit_ms = argv.next().and_then(|value| value.parse::<u64>().ok()).filter(|ms| *ms > 0)
            }
            "--freeze-cap-ms" => {
                freeze_cap_ms = argv.next().and_then(|value| value.parse::<u64>().ok()).filter(|ms| *ms > 0)
            }
            "--log" => log = argv.next().map(PathBuf::from),
            #[cfg(feature = "suite")]
            "--threads" => {
                let mut number = || argv.next().and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
                let (pid, samples, interval_ms) = (number(), number(), number());
                suite::sample(pid as u32, samples as u32, interval_ms);
                std::process::exit(0);
            }
            #[cfg(all(feature = "suite", windows))]
            "--empty-working-set" => {
                let pid = argv.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
                match platform::empty_working_set(pid) {
                    Ok(()) => std::process::exit(0),
                    Err(error) => fail(format!("EmptyWorkingSet({pid}): {error}")),
                }
            }
            #[cfg(all(feature = "suite", windows))]
            "--cold-file" => {
                let path = argv.next().unwrap_or_default();
                let mib = argv.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
                match platform::cold_file(&path, mib) {
                    Ok(()) => std::process::exit(0),
                    Err(error) => fail(format!("cold file {path}: {error}")),
                }
            }
            "--version" => {
                println!("mixdog-supervisor {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--" => break,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let freeze_limit_ms = freeze_limit_ms.ok_or_else(|| "missing --freeze-limit-ms".to_string())?;
    Ok(Options {
        freeze_limit_ms,
        freeze_cap_ms: freeze_cap_ms.unwrap_or(freeze_limit_ms.saturating_mul(5) / 2).max(freeze_limit_ms),
        log: log.ok_or_else(|| "missing --log".to_string())?,
        program: argv.next().ok_or_else(|| "missing daemon command".to_string())?,
        args: argv.collect(),
    })
}

enum Event {
    Ready(String),
    Pong(String, String),
    Exited,
    /// The reading asked for on behalf of ping `seq`; None when the daemon could not be read.
    Read(u64, Option<Reading>),
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

/// The ping the daemon has not answered yet.
struct Pending {
    seq: u64,
    /// Awake time it went out.
    sent_at: u64,
    token: String,
    /// Awake time of the next reading: the baseline, the limit, then each extension.
    look_at: u64,
    /// Awake time at which it is killed whatever any reading says.
    cap_at: u64,
    /// Awake time the reading on its way was asked for.
    asked_at: u64,
    /// The last reading (None: unreadable) and when it was asked for; None before the baseline.
    look: Option<(u64, Option<Reading>)>,
    /// Why it was last given more time.
    extended_for: Option<&'static str>,
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
fn diagnose(log: &Path, detail: &str, budget: Duration) {
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
    let _ = finished.recv_timeout(budget);
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
    let baseline_delay = (limit / 2).min(BASELINE_DELAY_MS);
    // Pings sent, for the log.
    let mut seq = 0u64;
    let cap = options.freeze_cap_ms;
    // The one unanswered ping.
    let mut outstanding: Option<Pending> = None;
    // The ping whose reading is on its way. Readings run on a thread of their
    // own, one at a time: one the machine holds up never holds up the cap,
    // and never piles up others behind it.
    let mut reading: Option<u64> = None;
    let mut next_ping_at = platform::awake_ms();
    let mut answered_at = next_ping_at;
    let mut last_detail = String::new();
    loop {
        let due = match &outstanding {
            None => next_ping_at,
            Some(pending) if reading.is_some() => pending.cap_at,
            Some(pending) => pending.look_at.min(pending.cap_at),
        };
        let wait = Duration::from_millis(due.saturating_sub(platform::awake_ms()));
        let event = match inbox.recv_timeout(wait) {
            Ok(tagged) if tagged.generation != generation => continue,
            Ok(tagged) => Some(tagged.event),
            Err(RecvTimeoutError::Timeout) => None,
            // This thread holds a sender.
            Err(RecvTimeoutError::Disconnected) => unreachable!(),
        };
        let now = platform::awake_ms();
        // Every arm but a verdict to kill goes round again; that one says why.
        let why = match event {
            Some(Event::Ready(token)) => {
                if daemon.hello.as_deref() == Some(token.as_str()) {
                    daemon.hello = None;
                    tell(&mut launcher, "ready");
                }
                continue;
            }
            Some(Event::Pong(token, detail)) => {
                if outstanding.as_ref().is_some_and(|pending| pending.token == token) {
                    outstanding = None;
                    answered_at = now;
                    last_detail = detail;
                    next_ping_at = now + PING_INTERVAL_MS;
                }
                continue;
            }
            Some(Event::Exited) => match daemon.child.wait() {
                Ok(status) => platform::exit_like(status),
                Err(error) => fail(format!("daemon wait: {error}")),
            },
            Some(Event::Read(of, result)) => {
                if reading == Some(of) {
                    reading = None;
                }
                let Some(pending) = outstanding.as_mut().filter(|pending| pending.seq == of) else { continue };
                let at = pending.asked_at;
                let Some((before_at, before)) = pending.look.take() else {
                    // The baseline: the next reading at the limit, a full baseline delay later at the earliest.
                    pending.look = Some((at, result));
                    pending.look_at = (pending.sent_at + limit).max(now + baseline_delay);
                    continue;
                };
                let verdict = match (&before, &result) {
                    (Some(before), Some(after)) => match judge(before, after, at.saturating_sub(before_at).max(1)) {
                        (Some(reason), numbers) => Ok((reason, numbers)),
                        (None, numbers) => {
                            Err(format!("no progress, and its main thread waits on nothing the machine owes it: {numbers}"))
                        }
                    },
                    _ => Err("no progress: the daemon could not be read".to_string()),
                };
                match verdict {
                    Ok((reason, numbers)) => {
                        // More time, from this look, never past the cap.
                        let until = now.saturating_add((limit / 2).max(1)).min(pending.cap_at);
                        pending.look = Some((at, result));
                        pending.look_at = until;
                        pending.extended_for = Some(reason);
                        diagnose(
                            &options.log,
                            &format!(
                                "daemon pid={} left ping {} unanswered for {}ms (limit {limit}ms) but is still \
                                 alive, {reason}: {numbers}; giving it until {}ms (cap {cap}ms)",
                                daemon.child.id(),
                                pending.seq,
                                now - pending.sent_at,
                                until - pending.sent_at
                            ),
                            DIAGNOSTICS_BUDGET.min(Duration::from_millis(pending.cap_at.saturating_sub(now))),
                        );
                        continue;
                    }
                    Err(why) => why,
                }
            }
            None => match outstanding.as_mut() {
                None if now >= next_ping_at => {
                    seq += 1;
                    let token = nonce();
                    // A daemon that exited fails this write; its exit event follows.
                    let _ = writeln!(daemon.stdin, "ping {token}").and_then(|()| daemon.stdin.flush());
                    outstanding = Some(Pending {
                        seq,
                        sent_at: now,
                        token,
                        look_at: now + baseline_delay,
                        cap_at: now.saturating_add(cap),
                        asked_at: now,
                        look: None,
                        extended_for: None,
                    });
                    continue;
                }
                Some(pending) if now >= pending.cap_at => format!(
                    "hard cap {cap}ms reached ({})",
                    match (pending.extended_for, reading) {
                        (_, Some(_)) => "a reading of the daemon is still on its way",
                        (Some(reason), None) => reason,
                        (None, None) => "-",
                    }
                ),
                Some(pending) if reading.is_none() && now >= pending.look_at => {
                    if READINGS_OUT.load(Ordering::SeqCst) >= READINGS_OUT_LIMIT {
                        let at_limit = pending.sent_at.saturating_add(limit);
                        if now < at_limit {
                            pending.look_at = at_limit;
                            continue;
                        }
                        "no progress: the daemon could not be read (earlier readings never returned)".to_string()
                    } else {
                        pending.asked_at = now;
                        reading = Some(pending.seq);
                        let (of, pid, events) = (pending.seq, daemon.child.id(), events.clone());
                        let tagged = generation;
                        READINGS_OUT.fetch_add(1, Ordering::SeqCst);
                        thread::spawn(move || {
                            let result = read(pid);
                            READINGS_OUT.fetch_sub(1, Ordering::SeqCst);
                            let _ = events.send(Tagged { generation: tagged, event: Event::Read(of, result) });
                        });
                        continue;
                    }
                }
                _ => continue,
            },
        };
        // Only a verdict to kill gets here.
        let pending = outstanding.take().expect("a kill is about an unanswered ping");
        let pid = daemon.child.id();
        // The kill comes before its log line: the cap is a promise, and a log
        // the machine holds up must not add its budget to it.
        let _ = daemon.child.kill();
        diagnose(
            &options.log,
            &format!(
                "daemon pid={pid} left ping {} unanswered for {}ms (limit {limit}ms); its last answer, {}ms ago: \
                 {} — killing it and starting a replacement ({why})",
                pending.seq,
                now - pending.sent_at,
                now - answered_at,
                if last_detail.is_empty() { "-" } else { &last_detail }
            ),
            DIAGNOSTICS_BUDGET,
        );
        let _ = daemon.child.wait();
        generation += 1;
        // A reading of the killed daemon is dropped with its generation.
        reading = None;
        daemon = start(&options, &platform, &events, generation)
            .unwrap_or_else(|error| fail(format!("replacement spawn: {error}")));
        diagnose(
            &options.log,
            &format!("frozen daemon pid={pid} exited; replacement pid={} started", daemon.child.id()),
            DIAGNOSTICS_BUDGET,
        );
        tell(&mut launcher, &format!("spawned {}", daemon.child.id()));
        answered_at = platform::awake_ms();
        last_detail.clear();
        next_ping_at = answered_at;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counters(cpu_ms: u64, faults: u32) -> Counters {
        Counters { cpu_ms, faults, ..Counters::default() }
    }

    fn reading(own: Counters, tree: &[(Identity, Counters)], main_on_machine: bool) -> Reading {
        let threads = Threads { main: "-".into(), main_on_machine, on_machine: 0, total: 1 };
        Reading { own, tree: tree.to_vec(), threads }
    }

    #[test]
    fn a_32_bit_counter_that_wraps_still_advances() {
        let before = counters(0, u32::MAX - 2);
        let after = counters(0, 5);
        assert!(after.advanced_since(&before));
        assert_eq!(after.since(&before).faults, 8);
        assert!(!before.advanced_since(&before));
    }

    #[test]
    fn a_survivor_that_advances_counts_when_a_bigger_one_exits() {
        let own = counters(50, 7);
        let before = reading(own, &[((10, 1), counters(10_000, 0)), ((11, 2), counters(100, 0))], false);
        let after = reading(own, &[((11, 2), counters(200, 0))], false);
        let (reason, numbers) = judge(&before, &after, 1_000);
        assert_eq!(reason, Some(TREE_ADVANCE));
        assert!(numbers.contains("tree[1 procs, 1 survived, 1 advanced: cpu +100ms"), "{numbers}");
    }

    #[test]
    fn a_pid_handed_out_again_is_another_process() {
        let own = counters(50, 7);
        let before = reading(own, &[((10, 1), counters(100, 0))], false);
        let after = reading(own, &[((10, 9), counters(5, 0))], false);
        assert_eq!(judge(&before, &after, 1_000).0, None);
    }

    #[test]
    fn the_main_thread_must_wait_on_the_machine_at_both_looks() {
        let own = counters(50, 7);
        let held = reading(own, &[], true);
        let free = reading(own, &[], false);
        assert_eq!(judge(&held, &held, 1_000).0, Some(MAIN_ON_MACHINE));
        assert_eq!(judge(&free, &held, 1_000).0, None);
        assert_eq!(judge(&held, &free, 1_000).0, None);
    }

    #[test]
    fn a_process_older_than_its_parent_is_not_its_child() {
        let process = |pid, ppid, start| Proc { pid, ppid, start, counters: Counters::default() };
        // 7 is the daemon (started at 100); 8 is its child; 9 names pid 7 as
        // parent but started before it (its parent was an earlier pid 7).
        let all = [process(7, 1, 100), process(8, 7, 150), process(9, 7, 50), process(10, 8, 160)];
        let threads = Threads::default();
        let found = super::reading(7, &all, threads).expect("the daemon is in the table");
        let pids: Vec<u32> = found.tree.iter().map(|((pid, _), _)| *pid).collect();
        assert_eq!(pids, [8, 10]);
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
        fn NtQuerySystemInformation(class: u32, buffer: *mut core::ffi::c_void, length: u32, returned: *mut u32) -> i32;
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

    /// SYSTEM_PROCESS_INFORMATION, as NtQuerySystemInformation class 5 lays it out.
    #[repr(C)]
    struct SystemProcess {
        next: u32,
        thread_count: u32,
        _private_working_set: i64,
        _hard_faults: u32,
        _threads_peak: u32,
        _cycles: u64,
        create_time: i64,
        user_time: i64,
        kernel_time: i64,
        _name: [usize; 2],
        _base_priority: i32,
        pid: usize,
        ppid: usize,
        _handles: u32,
        _session: u32,
        _key: usize,
        _virtual: [usize; 2],
        page_faults: u32,
        _memory: [usize; 9],
        /// Read, write, other operations; then read, write, other bytes.
        io: [i64; 6],
    }

    /// SYSTEM_THREAD_INFORMATION, one per thread right after its process.
    #[repr(C)]
    struct SystemThread {
        _kernel_time: i64,
        _user_time: i64,
        create_time: i64,
        _wait_time: u32,
        _start: usize,
        _client: [usize; 2],
        _priority: i32,
        _base_priority: i32,
        _switches: u32,
        state: u32,
        wait_reason: u32,
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(
        std::mem::size_of::<SystemProcess>() == 256 && std::mem::size_of::<SystemThread>() == 80
    );

    /// KTHREAD_STATE.
    const STATES: [&str; 10] = [
        "Initialized", "Ready", "Running", "Standby", "Terminated", "Waiting", "Transition", "DeferredReady",
        "GateWaitObsolete", "WaitingForProcessInSwap",
    ];
    const WAITING: u32 = 5;
    /// KWAIT_REASON.
    const REASONS: [&str; 42] = [
        "Executive", "FreePage", "PageIn", "PoolAllocation", "DelayExecution", "Suspended", "UserRequest",
        "WrExecutive", "WrFreePage", "WrPageIn", "WrPoolAllocation", "WrDelayExecution", "WrSuspended",
        "WrUserRequest", "WrEventPair", "WrQueue", "WrLpcReceive", "WrLpcReply", "WrVirtualMemory", "WrPageOut",
        "WrRendezvous", "WrKeyedEvent", "WrTerminated", "WrProcessInSwap", "WrCpuRateControl", "WrCalloutStack",
        "WrKernel", "WrResource", "WrPushLock", "WrMutex", "WrQuantumEnd", "WrDispatchInt", "WrPreempted",
        "WrYieldExecution", "WrFastMutex", "WrGuardedMutex", "WrRundown", "WrAlertByThreadId",
        "WrDeferredPreempt", "WrPhysicalFault", "WrIoRing", "WrMdlCache",
    ];

    /// A thread the machine holds: in a kernel wait for memory or for a
    /// transfer (a hard page-in and a synchronous read or write both wait as
    /// Executive, measured), on a lock only kernel code takes (the file
    /// system's ERESOURCE held across a flush, measured as WrResource and
    /// WrFastMutex), or with its stack or process swapped out. A thread
    /// blocked on a user-mode lock, an event, a sleep or its completion port
    /// waits as UserRequest, WrAlertByThreadId, WrKeyedEvent, DelayExecution
    /// or WrQueue instead; one running or ready is not waiting.
    fn on_machine(state: u32, reason: u32) -> bool {
        match state {
            // Transition, WaitingForProcessInSwap.
            6 | 9 => true,
            WAITING => matches!(reason, 0..=3 | 7..=10 | 18 | 19 | 23 | 27 | 28 | 34 | 35 | 39),
            _ => false,
        }
    }

    /// Every process and every thread in the system at one instant, without
    /// privilege (SystemProcessInformation).
    fn system_processes() -> Option<Vec<u64>> {
        const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
        let mut buffer = vec![0u64; 1 << 17];
        loop {
            let mut needed = 0u32;
            let bytes = (buffer.len() * 8) as u32;
            let status = unsafe { NtQuerySystemInformation(5, buffer.as_mut_ptr().cast(), bytes, &mut needed) };
            match status {
                STATUS_INFO_LENGTH_MISMATCH => buffer = vec![0u64; (needed.max(bytes) as usize) / 8 * 2],
                status if status < 0 => return None,
                _ => return Some(buffer),
            }
        }
    }

    /// Every process, and the threads of `pid` (its main thread the oldest).
    pub fn snapshot(pid: u32) -> Option<(Vec<crate::Proc>, Vec<crate::ThreadState>)> {
        use std::mem::size_of;
        let buffer = system_processes()?;
        let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), buffer.len() * 8) };
        let at = |offset: usize, size: usize| (offset + size <= bytes.len()).then(|| bytes[offset..].as_ptr());
        let (mut all, mut threads) = (Vec::new(), Vec::new());
        let mut offset = 0;
        loop {
            let process: SystemProcess = unsafe { std::ptr::read_unaligned(at(offset, size_of::<SystemProcess>())?.cast()) };
            let [read_ops, write_ops, other_ops, read_bytes, write_bytes, other_bytes] = process.io.map(|value| value as u64);
            all.push(crate::Proc {
                pid: process.pid as u32,
                ppid: process.ppid as u32,
                start: process.create_time as u64,
                counters: crate::Counters {
                    // 100 ns ticks.
                    cpu_ms: (process.user_time as u64 + process.kernel_time as u64) / 10_000,
                    io_ops: read_ops + write_ops + other_ops,
                    io_bytes: read_bytes + write_bytes + other_bytes,
                    faults: process.page_faults,
                },
            });
            if process.pid as u32 == pid {
                for index in 0..process.thread_count as usize {
                    let place = offset + size_of::<SystemProcess>() + index * size_of::<SystemThread>();
                    threads.push(unsafe { std::ptr::read_unaligned::<SystemThread>(at(place, size_of::<SystemThread>())?.cast()) });
                }
            }
            if process.next == 0 {
                break;
            }
            offset += process.next as usize;
        }
        let main = (0..threads.len()).min_by_key(|index| threads[*index].create_time);
        let states = threads
            .iter()
            .enumerate()
            .map(|(index, thread)| crate::ThreadState {
                main: Some(index) == main,
                name: match (STATES.get(thread.state as usize), REASONS.get(thread.wait_reason as usize)) {
                    (Some(state), Some(reason)) if thread.state == WAITING => format!("{state}/{reason}"),
                    (Some(state), _) => state.to_string(),
                    _ => format!("state {}/{}", thread.state, thread.wait_reason),
                },
                on_machine: on_machine(thread.state, thread.wait_reason),
            })
            .collect();
        Some((all, states))
    }

    /// The suite's file of `mib` MiB that no cache holds: written around the
    /// cache (FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH), so every
    /// page of it a process maps comes in from the disk.
    #[cfg(feature = "suite")]
    pub fn cold_file(path: &str, mib: usize) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .custom_flags(0x2000_0000 | 0x8000_0000)
            .open(path)?;
        let layout = std::alloc::Layout::from_size_align(1 << 20, 4_096).expect("a valid layout");
        let chunk = unsafe { std::slice::from_raw_parts_mut(std::alloc::alloc(layout), layout.size()) };
        for index in 0..mib {
            chunk.fill((index % 251) as u8 + 1);
            file.write_all(chunk)?;
        }
        Ok(())
    }

    /// The suite's EmptyWorkingSet of one of its own processes.
    #[cfg(feature = "suite")]
    pub fn empty_working_set(pid: u32) -> std::io::Result<()> {
        use windows_sys::Win32::System::ProcessStatus::K32EmptyWorkingSet;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA};
        let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, 0, pid) };
        if process.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let emptied = unsafe { K32EmptyWorkingSet(process) };
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(process) };
        if emptied == 0 {
            return Err(error);
        }
        Ok(())
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

    /// One process (None when it is gone or refused).
    #[cfg(target_os = "linux")]
    fn read_process(pid: u32) -> Option<crate::Proc> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // After the ")" closing the command name: state is field 3, ppid 4,
        // minflt 10, majflt 12, utime 14, stime 15, cutime 16, cstime 17,
        // starttime 22.
        let fields: Vec<u64> = stat[stat.rfind(')')? + 1..]
            .split_whitespace()
            .skip(1)
            .map(|field| field.parse::<u64>().unwrap_or(0))
            .collect();
        let field = |number: usize| fields.get(number - 4).copied();
        let ticks = field(14)? + field(15)? + field(16)? + field(17)?;
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
        // /proc/<pid>/io may be unreadable (hidepid, ptrace restrictions): the rest then decides.
        let (mut io_ops, mut io_bytes) = (0, 0);
        if let Ok(io) = std::fs::read_to_string(format!("/proc/{pid}/io")) {
            for line in io.lines() {
                let Some((name, value)) = line.split_once(':') else { continue };
                let value = value.trim().parse::<u64>().unwrap_or(0);
                match name {
                    "syscr" | "syscw" => io_ops += value,
                    "rchar" | "wchar" => io_bytes += value,
                    _ => {}
                }
            }
        }
        let counters = crate::Counters {
            cpu_ms: ticks * 1_000 / hz,
            io_ops,
            io_bytes,
            faults: (field(10)? + field(12)?) as u32,
        };
        Some(crate::Proc { pid, ppid: field(4)? as u32, start: field(22)?, counters })
    }

    /// The state letter of one thread's stat.
    #[cfg(target_os = "linux")]
    fn thread_state(stat: &str) -> Option<String> {
        Some(stat[stat.rfind(')')? + 1..].split_whitespace().next()?.to_string())
    }

    /// Every process, and the threads of `pid` (its main thread's id is its
    /// pid). The machine holds a thread in state D, an uninterruptible sleep:
    /// a page-in, a disk transfer, reclaim; a lock, a sleep or a poll is S,
    /// a runnable thread R.
    #[cfg(target_os = "linux")]
    pub fn snapshot(pid: u32) -> Option<(Vec<crate::Proc>, Vec<crate::ThreadState>)> {
        let mut states = Vec::new();
        for entry in std::fs::read_dir(format!("/proc/{pid}/task")).ok()?.flatten() {
            let Some(tid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
            let Some(state) = std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/stat"))
                .ok()
                .and_then(|stat| thread_state(&stat))
            else {
                continue;
            };
            states.push(crate::ThreadState { main: tid == pid, on_machine: state == "D", name: state });
        }
        let all = std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()))
            .filter_map(read_process)
            .collect();
        Some((all, states))
    }

    #[cfg(target_vendor = "apple")]
    fn read_process(pid: u32) -> Option<crate::Counters> {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        let read = unsafe {
            libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), size)
        };
        if read != size {
            return None;
        }
        // Mach absolute time, not nanoseconds, on Apple silicon.
        let mut base = libc::mach_timebase_info { numer: 0, denom: 0 };
        if unsafe { libc::mach_timebase_info(&mut base) } != 0 || base.denom == 0 {
            return None;
        }
        let ns = (u128::from(info.pti_total_user) + u128::from(info.pti_total_system)) * u128::from(base.numer)
            / u128::from(base.denom);
        Some(crate::Counters {
            cpu_ms: (ns / 1_000_000) as u64,
            io_ops: (info.pti_syscalls_unix.max(0) as u64) + (info.pti_pageins.max(0) as u64),
            io_bytes: 0,
            faults: info.pti_faults as u32,
        })
    }

    /// Every process, by proc_listpids + PROC_PIDTBSDINFO (parent, start time) + PROC_PIDTASKINFO.
    #[cfg(target_vendor = "apple")]
    fn processes() -> Vec<crate::Proc> {
        // PROC_ALL_PIDS
        let bytes = unsafe { libc::proc_listpids(1, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0 as libc::c_int; bytes as usize / std::mem::size_of::<libc::c_int>() + 64];
        let filled = unsafe {
            libc::proc_listpids(1, 0, pids.as_mut_ptr().cast(), (pids.len() * std::mem::size_of::<libc::c_int>()) as libc::c_int)
        };
        pids.truncate(filled.max(0) as usize / std::mem::size_of::<libc::c_int>());
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let mut all = Vec::new();
        for pid in pids.into_iter().filter(|pid| *pid > 0) {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let read = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size)
            };
            if read != size {
                continue;
            }
            let Some(counters) = read_process(pid as u32) else { continue };
            all.push(crate::Proc {
                pid: pid as u32,
                ppid: info.pbi_ppid,
                start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
                counters,
            });
        }
        all
    }

    /// Every process, and the threads of `pid`: PROC_PIDLISTTHREADS lists
    /// them in the order the task queued them, so its main thread first. The
    /// machine holds a thread whose run state is TH_STATE_UNINTERRUPTIBLE (4):
    /// a page-in, a disk transfer; a lock or a sleep is TH_STATE_WAITING (3).
    #[cfg(target_vendor = "apple")]
    pub fn snapshot(pid: u32) -> Option<(Vec<crate::Proc>, Vec<crate::ThreadState>)> {
        const NAMES: [&str; 6] = ["state 0", "running", "stopped", "waiting", "uninterruptible", "halted"];
        // sys/proc_info.h; the libc crate does not bind it.
        const PROC_PIDLISTTHREADS: libc::c_int = 6;
        let mut handles = vec![0u64; 4_096];
        let bytes = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                PROC_PIDLISTTHREADS,
                0,
                handles.as_mut_ptr().cast(),
                (handles.len() * std::mem::size_of::<u64>()) as libc::c_int,
            )
        };
        if bytes <= 0 {
            return None;
        }
        handles.truncate(bytes as usize / std::mem::size_of::<u64>());
        let size = std::mem::size_of::<libc::proc_threadinfo>() as libc::c_int;
        let mut states = Vec::new();
        for (index, handle) in handles.iter().enumerate() {
            let mut info: libc::proc_threadinfo = unsafe { std::mem::zeroed() };
            let read = unsafe {
                libc::proc_pidinfo(
                    pid as libc::c_int,
                    libc::PROC_PIDTHREADINFO,
                    *handle,
                    (&mut info as *mut libc::proc_threadinfo).cast(),
                    size,
                )
            };
            if read != size {
                continue;
            }
            let state = info.pth_run_state;
            states.push(crate::ThreadState {
                main: index == 0,
                name: NAMES.get(state as usize).map_or_else(|| format!("state {state}"), |name| name.to_string()),
                on_machine: state == 4,
            });
        }
        Some((processes(), states))
    }

    /// No reader here: the daemon is killed at the limit as before.
    #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
    pub fn snapshot(_: u32) -> Option<(Vec<crate::Proc>, Vec<crate::ThreadState>)> {
        None
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
