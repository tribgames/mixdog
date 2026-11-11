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
/// The exit status of a process whose main thread panicked.
pub const PANIC_EXIT_CODE: i32 = 101;

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

/// `installDaemonExitRecorder`'s `write`, for one process.
pub struct ExitRecorder {
    dir: PathBuf,
    pid: u32,
    started_ms: i64,
    located: Mutex<Option<PathBuf>>,
}

impl ExitRecorder {
    pub fn new(dir: PathBuf, pid: u32, started_ms: i64) -> Self {
        Self { dir, pid, started_ms, located: Mutex::new(None) }
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
        let exit = json!({
            "reason": bounded(reason),
            "code": code,
            "signal": null,
            "error": error.map(bounded),
            "at": at,
            "uptimeMs": uptime,
        });
        // Re-read: the launcher may have updated the sidecar since it was found.
        let Some(mut next) = read_record(file) else { return false };
        if open(&next) {
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
/// The newest panic's text, from the hook: the one that ends the process is the last before the exit.
static LAST_PANIC: Mutex<Option<String>> = Mutex::new(None);

/// This core's recorder over `data_dir`'s captures: the earlier lost boots are settled, and every panic is noted (the
/// default hook still writes it to fd 2, the capture file) for the exit it may end in. Once per process.
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
        *LAST_PANIC.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(panic_text(info));
        previous(info);
    }));
}

/// A panic unwound out of `serve`: the process ends with [`PANIC_EXIT_CODE`] (`uncaughtExceptionMonitor` + `exit`).
pub fn record_fatal_panic() {
    let error = LAST_PANIC.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if let Some(recorder) = RECORDER.get() {
        let reason = format!("fatal panic ({})", describe_exit(Some(PANIC_EXIT_CODE)));
        recorder.write(&reason, Some(PANIC_EXIT_CODE), error.as_deref(), now_ms());
    }
}

/// `serve` failed: the process ends with `code`.
pub fn record_fatal_error(code: i32, error: &str) {
    if let Some(recorder) = RECORDER.get() {
        recorder.write(&format!("fatal error ({})", describe_exit(Some(code))), Some(code), Some(error), now_ms());
    }
}

/// `mixdogd serve` over `run`: a panic that unwinds out of it and an error it returns are recorded before the
/// process ends; answers the exit status (0, 1, or [`PANIC_EXIT_CODE`]).
pub fn serve_recorded<E: std::fmt::Display>(run: impl FnOnce() -> Result<(), E> + std::panic::UnwindSafe) -> i32 {
    match std::panic::catch_unwind(run) {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            let error = error.to_string();
            eprintln!("mixdogd: {error}");
            record_fatal_error(1, &error);
            1
        }
        Err(_) => {
            record_fatal_panic();
            PANIC_EXIT_CODE
        }
    }
}

/// The release procedure ends the process with `code` (`process.on('exit')`).
pub fn record_exit(code: i32) {
    if let Some(recorder) = RECORDER.get() {
        recorder.write(&describe_exit(Some(code)), Some(code), None, now_ms());
    }
}

#[cfg(test)]
#[path = "crash_record_tests.rs"]
mod tests;
