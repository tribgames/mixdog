//! The core's own exit record (`daemon-exit-record.mjs`). The launcher opens a capture for each boot in
//! `<data>/daemon-crash` (`spawn-capture.mjs`: the core's fd 2 in `<stem>.err.log`, the lifecycle in `<stem>.json`),
//! but it learns the exit only while it is alive itself, and it usually is not (the desktop app or the terminal
//! closes first). So the core writes what it knows into its own sidecar: a panic that ends the process (the reason,
//! with the panic's message, place and thread), a fatal error out of `serve`, and every exit the release procedure
//! makes. The next core settles the boots that ended without running any of these (killed from outside, an abort, a
//! power loss) as `unrecorded-termination`, so no capture stays silent.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the record is written by the exiting thread, with no runtime left"
)]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `CAPTURE_DIR_NAME` (`daemon-crash-capture/paths.mjs`).
const CAPTURE_DIR_NAME: &str = "daemon-crash";
const REASON_MAX_CHARS: usize = 512;
/// The exit status of a process a panic ended: Node's after an uncaught exception (`onFatalError` → `process.exit(1)`).
pub const PANIC_EXIT_CODE: i32 = 1;

/// `daemonCrashCaptureDir({ dataDir })`.
pub fn capture_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(CAPTURE_DIR_NAME)
}

/// `CAPTURE_RECORD_RE`: `daemon-<yyyymmdd>-<hhmmss>-<launcher pid>-<4 hex>.json`.
fn is_capture_record(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else { return false };
    let parts: Vec<&str> = stem.split('-').collect();
    let digits = |s: &str, n: Option<usize>| !s.is_empty() && n.is_none_or(|n| s.len() == n) && s.bytes().all(|b| b.is_ascii_digit());
    matches!(parts.as_slice(), ["daemon", day, time, pid, nonce]
        if digits(day, Some(8)) && digits(time, Some(6)) && digits(pid, None)
            && nonce.len() == 4 && nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `describeExit(code, null)`.
pub fn describe_exit(code: Option<i32>) -> String {
    let Some(code) = code else { return "exit not observed".to_owned() };
    match code as u32 {
        0x4001_0004 => "terminated externally (DBG_TERMINATE_PROCESS 0x40010004: process-tree/job termination by its parent)".to_owned(),
        0x4001_0005 => "terminated by Ctrl+C (DBG_CONTROL_C 0x40010005)".to_owned(),
        0xC000_013A => "terminated by Ctrl+C / console close (STATUS_CONTROL_C_EXIT 0xC000013A)".to_owned(),
        0 => "exited normally (code 0)".to_owned(),
        _ => format!("exited with code {code}"),
    }
}

/// `boundedReason`: whitespace runs as one space, at most 512 characters.
fn bounded(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(REASON_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

fn read_record(file: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_slice(&std::fs::read(file).ok()?).ok()? {
        Value::Object(record) => Some(record),
        _ => None,
    }
}

fn open(record: &Map<String, Value>) -> bool {
    record.get("exitedAt").is_none_or(|at| at.is_null() || at == "")
}

/// `findCaptureRecordFor(pid)`: the newest still-open sidecar the launcher published for `pid`.
pub fn find_capture_record_for(dir: &Path, pid: u32) -> Option<PathBuf> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| is_capture_record(name))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    names.into_iter().map(|name| dir.join(name)).find(|file| {
        read_record(file).is_some_and(|record| record.get("pid").and_then(Value::as_u64) == Some(u64::from(pid)) && open(&record))
    })
}

/// `writeJsonAtomicSync`: a reader never sees a half-written document.
fn write_atomic(file: &Path, record: &Map<String, Value>) -> std::io::Result<()> {
    let staged = file.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut out = std::fs::File::create(&staged)?;
    out.write_all(&serde_json::to_vec(record).map_err(std::io::Error::other)?)?;
    out.sync_all()?;
    drop(out);
    std::fs::rename(&staged, file)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `process.memoryUsage()`'s `rss` and `heapUsed`: the working set, and the memory the process allocated for itself
/// (its private bytes; a native process has no garbage-collected heap, this is what its allocations hold).
#[cfg(windows)]
fn memory() -> (Option<u64>, Option<u64>) {
    use windows_sys::Win32::System::ProcessStatus::GetProcessMemoryInfo;
    use windows_sys::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: a plain query of the current process into an out struct of the declared size.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) == 0 {
            return (None, None);
        }
        (Some(counters.WorkingSetSize as u64), Some(counters.PagefileUsage as u64))
    }
}

/// `/proc/self/statm`: resident and data pages; elsewhere neither is known.
#[cfg(not(windows))]
fn memory() -> (Option<u64>, Option<u64>) {
    let Ok(statm) = std::fs::read_to_string("/proc/self/statm") else { return (None, None) };
    let pages: Vec<u64> = statm.split_whitespace().filter_map(|n| n.parse().ok()).collect();
    // SAFETY: sysconf has no preconditions.
    let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096);
    (pages.get(1).map(|n| n * page), pages.get(5).map(|n| n * page))
}

/// `installDaemonExitRecorder`'s `write`, for one process.
pub struct ExitRecorder {
    dir: PathBuf,
    pid: u32,
    started_ms: i64,
    located: Mutex<Option<PathBuf>>,
    /// The `exitedAt` this core filled in (the launcher had not): while the sidecar still holds it, a later write of this
    /// core states the later exit. In Node the first write is the one before the process ends; here a panic the runtime
    /// caught is written when it happens and the process can still end later.
    filled: Mutex<Option<String>>,
}

impl ExitRecorder {
    pub fn new(dir: PathBuf, pid: u32, started_ms: i64) -> Self {
        Self { dir, pid, started_ms, located: Mutex::new(None), filled: Mutex::new(None) }
    }

    /// The exit block in this process's sidecar; the launcher's own fields are filled when it never saw the exit
    /// (its later write keeps this block). False when no sidecar names this process.
    pub fn write(&self, reason: &str, code: Option<i32>, error: Option<&str>, at_ms: i64) -> bool {
        let mut located = self.located.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if located.is_none() {
            *located = find_capture_record_for(&self.dir, self.pid);
        }
        let Some(file) = located.as_ref() else { return false };
        let at = mixdog_agent::agent_tool::stamp::iso_from_ms(at_ms);
        let uptime = (at_ms - self.started_ms).max(0);
        let (rss, heap_used) = memory();
        let exit = json!({
            "reason": bounded(reason),
            "code": code,
            "signal": null,
            "error": error.map(bounded),
            "at": at,
            "uptimeMs": uptime,
            "rssBytes": rss,
            "heapUsedBytes": heap_used,
        });
        // Re-read: the launcher may have updated the sidecar since it was found.
        let Some(mut next) = read_record(file) else { return false };
        let mut filled = self.filled.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let ours = filled.as_ref().is_some_and(|at| next.get("exitedAt").and_then(Value::as_str) == Some(at.as_str()));
        if open(&next) || ours {
            *filled = Some(at.clone());
            next.insert("exitedAt".into(), json!(at));
            next.insert("exitCode".into(), json!(code));
            next.insert("exitSignal".into(), Value::Null);
            next.insert("uptimeMs".into(), json!(uptime));
        }
        if next.get("exitReason").and_then(Value::as_str).is_none_or(str::is_empty) {
            next.insert("exitReason".into(), exit["reason"].clone());
        }
        next.insert("daemonExit".into(), exit);
        write_atomic(file, &next).is_ok()
    }
}

/// `reconcileLostDaemonCaptures`: earlier boots whose core is gone, with no exit time and no record of their own,
/// are marked as ended without an exit hook. Only sidecars are edited; nothing is deleted. Answers how many.
pub fn reconcile_lost(dir: &Path, self_pid: u32, alive: &dyn Fn(u32) -> bool, at_ms: i64) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut marked = 0;
    for name in entries.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).filter(|name| is_capture_record(name)) {
        let file = dir.join(name);
        let Some(mut record) = read_record(&file) else { continue };
        let pid = record.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok()).unwrap_or(0);
        let set = |key: &str| record.get(key).is_some_and(|v| !v.is_null() && v != "");
        if record.get("kind") != Some(&json!("mixdog-daemon-crash-capture")) || pid == 0 || pid == self_pid {
            continue;
        }
        if set("exitedAt") || set("daemonExit") || set("exitReason") || alive(pid) {
            continue;
        }
        record.insert(
            "exitReason".into(),
            json!("unrecorded-termination: the daemon ended without running any exit hook and its launcher recorded no exit (externally killed, e.g. terminated with the launcher process tree)"),
        );
        record.insert("exitReconciledAt".into(), json!(mixdog_agent::agent_tool::stamp::iso_from_ms(at_ms)));
        if write_atomic(&file, &record).is_ok() {
            marked += 1;
        }
    }
    marked
}

/// `<message> at <file:line:col> (thread <name>)` for a panic.
pub fn panic_text(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    let message = payload.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "Box<dyn Any>".to_owned());
    let at = info.location().map(|l| format!(" at {}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
    let thread = std::thread::current();
    format!("panicked{at}: {message} (thread {})", thread.name().unwrap_or("<unnamed>"))
}

static RECORDER: OnceLock<ExitRecorder> = OnceLock::new();

/// Why the next exit happens (`installDaemonExitRecorder`'s `pending`): its reason, code and error.
struct Pending {
    reason: String,
    error: Option<String>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
/// The newest panic's text (`daemon.mjs` `fatalExit.detail`): a stop after it names it, whatever ends the process.
static FATAL: Mutex<Option<String>> = Mutex::new(None);

fn lock<T>(slot: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write(reason: &str, code: i32, error: Option<&str>) {
    if let Some(recorder) = RECORDER.get() {
        recorder.write(reason, Some(code), error, now_ms());
    }
}

/// This core's recorder over `data_dir`'s captures: the earlier lost boots are settled, and every panic, on any thread and
/// whether or not the runtime catches it, is written into the boot's sidecar when it happens (`uncaughtExceptionMonitor`;
/// the default hook still writes it to fd 2, the capture file). Once per process.
pub fn install(data_dir: &Path, alive: &dyn Fn(u32) -> bool) {
    let dir = capture_dir(data_dir);
    let pid = std::process::id();
    let now = now_ms();
    if RECORDER.set(ExitRecorder::new(dir.clone(), pid, now)).is_err() {
        return;
    }
    reconcile_lost(&dir, pid, alive, now);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        note_panic(&panic_text(info));
        previous(info);
    }));
}

/// The install the process makes before anything of its start-up can fail (Node: daemon.mjs:157, at module load; a fatal
/// boot error is recorded at :1347). The data folder is `resolvePluginData()`'s, which does not read the JS runtime, so
/// even a start whose runtime cannot be resolved leaves its record. No data folder, no record.
pub fn install_for_process() {
    let Some(paths) = mixdog_store::paths::Paths::from_process(Path::new("")) else { return };
    let alive = |pid: u32| crate::verdict::ProcessTable::query(&crate::verdict::OsProcessTable, u64::from(pid)).is_ok_and(|info| info.is_some());
    install(&paths.data_dir, &alive);
    crate::stale_temps::reclaim_at_start(&paths.data_dir, &alive);
}

/// `uncaughtExceptionMonitor(error, 'uncaughtException')`: the panic is the pending reason and is written at once.
fn note_panic(text: &str) {
    *lock(&FATAL) = Some(text.to_owned());
    let reason = "fatal uncaughtException";
    *lock(&PENDING) = Some(Pending { reason: reason.to_owned(), error: Some(text.to_owned()) });
    write(reason, PANIC_EXIT_CODE, Some(text));
}

/// `settleExit(reason, code)` (`exitRecorder.setReason`): the stop the release procedure runs names its reason; after a
/// panic it carries the panic (`shutdown: <reason> (fatal uncaught exception)`, with its text). Answers `code`.
pub fn settle_exit(reason: &str, code: i32) -> i32 {
    let pending = match lock(&FATAL).clone() {
        Some(detail) => Pending { reason: format!("shutdown: {reason} (fatal uncaught exception)"), error: Some(detail) },
        None => Pending { reason: format!("shutdown: {reason}"), error: None },
    };
    *lock(&PENDING) = Some(pending);
    code
}

/// `mixdogd serve` over `run`. A panic that unwinds out of it is `onFatalError('uncaught exception')` (written, then the
/// stop it ends in, exit 1); an error it returns is `main().catch` (`shutdown('fatal boot error', 2)`). Answers the exit
/// status, recorded as the process exit is.
pub fn serve_recorded<E: std::fmt::Display>(run: impl FnOnce() -> Result<(), E> + std::panic::UnwindSafe) -> i32 {
    let code = match std::panic::catch_unwind(run) {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            // Not `eprintln!`: with a launcher's pipe gone a failed write would panic and replace this end's record.
            let _ = writeln!(std::io::stderr(), "mixdogd: {error}");
            settle_exit("fatal boot error", 2)
        }
        Err(_) => {
            let detail = lock(&FATAL).clone();
            write("fatal uncaught exception", PANIC_EXIT_CODE, detail.as_deref());
            settle_exit("fatal uncaught exception", PANIC_EXIT_CODE)
        }
    };
    record_exit(code);
    code
}

/// The process ends with `code` (`process.on('exit')`): the pending reason with the exit described, or the exit alone.
pub fn record_exit(code: i32) {
    let pending = lock(&PENDING).take();
    let (reason, error) = match pending {
        Some(pending) => (format!("{} ({})", pending.reason, describe_exit(Some(code))), pending.error),
        None => (describe_exit(Some(code)), None),
    };
    write(&reason, code, error.as_deref());
}

#[cfg(test)]
#[path = "crash_record_tests.rs"]
mod tests;
