//! One boot's spawn capture (`spawn-capture.mjs`): the launcher hands the core an append file for fd 2 instead of a pipe, so
//! native fatal output (a panic's text, an abort's) lands in a file even when the launcher is long gone; a JSON sidecar records
//! the correlated lifecycle (pid, spawn, ready and exit times, exit code or signal) as far as the launcher can observe it; and
//! new stderr bytes are mirrored into the launcher's log once per lifecycle event.
//!
//! Not ported: `noteReplaced` (a supervisor that killed a frozen Node main thread and started a replacement on the same fd 2; it
//! has no caller in the launcher, and the Rust core has no such supervisor) and `heapFlags` from `execArgv` (a native core has no
//! V8 heap flags: the field stays in the sidecar, empty, as it is for every Node boot without them).

use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStderr;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;

use serde::Serialize;
use serde_json::Value;

use super::exit_record::describe_exit;
use super::paths::capture_dir;
use super::paths::process_capture_dir;
use super::process_runs;
use super::retention::prune_crash_captures;

/// Bounded search for an unused boot identity; the raw capture is created exclusively, so an existing artifact can never be
/// adopted or overwritten.
const CAPTURE_ID_ATTEMPTS: u32 = 8;
/// One mirrored drain per lifecycle event; a crashing core must never push megabytes of native text through the launcher's log.
const MIRROR_MAX_BYTES: u64 = 16 * 1024;
const MESSAGE_MAX_CHARS: usize = 512;
/// Bytes of fd 2 a failure summary scans (the newest ones when larger).
const SUMMARY_SCAN_MAX_BYTES: u64 = 256 * 1024;
/// Node's uncaught-error report (`TypeError: ...`, `Error [ERR_...]: ...`), V8's fatal abort and the daemon's own `fatal boot
/// error` log line, and for the Rust core its panic report (`thread 'main' panicked at ...`) and the line `mixdogd serve`
/// prints for an error it returns (`mixdogd: ...`).
const STDERR_ERROR_LINE: &str = r"\b[A-Z][A-Za-z]*Error\b(?: \[[A-Z0-9_]+\])?:|^Error\b|FATAL ERROR|(?<!non-)\bfatal\b|\bpanicked\b|^mixdogd:";

/// The launcher's log sink: one line per call.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
/// `Date.now()`: milliseconds since the epoch.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Four lower-case hex digits that make a boot's identity unique within one second.
pub type Nonce = Arc<dyn Fn() -> String + Send + Sync>;

/// What a boot's capture is opened with.
#[derive(Clone)]
pub struct CaptureOptions {
    pub launcher: String,
    pub log: Log,
    /// The capture directory itself; else `<data_dir>/daemon-crash`; else the process's data folder.
    pub dir: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub launcher_pid: u32,
    pub now: Clock,
    /// Whether earlier completed boots are pruned first (`pruneDaemonCrashCaptures`).
    pub prune: bool,
    pub nonce: Nonce,
}

impl CaptureOptions {
    pub fn new(launcher: &str) -> Self {
        Self {
            launcher: launcher.to_owned(),
            log: Arc::new(|_| {}),
            dir: None,
            data_dir: None,
            launcher_pid: std::process::id(),
            now: Arc::new(now_ms),
            prune: true,
            nonce: Arc::new(random_nonce),
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn random_nonce() -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let mixed = nanos ^ std::process::id().rotate_left(16) ^ COUNTER.fetch_add(0x9E37, Ordering::Relaxed).wrapping_mul(0x85EB_CA6B);
    format!("{:04x}", (mixed ^ (mixed >> 16)) & 0xffff)
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    // Days since 1970-01-01 to a civil date (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// `stamp(ms)`: `yyyymmdd-hhmmss`.
fn stamp(ms: i64) -> String {
    let at = iso(ms);
    format!("{}{}{}-{}{}{}", &at[0..4], &at[5..7], &at[8..10], &at[11..13], &at[14..16], &at[17..19])
}

/// `boundedMessage`: whitespace runs as one space, at most 512 characters.
fn bounded(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(MESSAGE_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

/// The sidecar `<stem>.json`, key for key as `beginDaemonSpawnCapture` builds it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecord {
    pub kind: String,
    pub launcher: String,
    pub launcher_pid: u32,
    pub pid: Option<u32>,
    pub detached: Option<bool>,
    pub heap_flags: Vec<String>,
    pub stderr_file: Option<String>,
    pub spawned_at: String,
    pub ready_at: Option<String>,
    pub exited_at: Option<String>,
    pub ready: bool,
    pub exit_code: Option<i64>,
    pub exit_signal: Option<String>,
    pub uptime_ms: Option<i64>,
    pub stderr_bytes: u64,
    pub error: Option<String>,
    /// The core's own exit block, kept when the core wrote one into the sidecar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_exit: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
}

/// What a launcher that gave up on this boot needs to name its cause (`summarize`).
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureSummary {
    pub pid: Option<u32>,
    pub ready: bool,
    pub spawned_at: String,
    pub exited_at: Option<String>,
    pub exit_code: Option<i64>,
    pub exit_signal: Option<String>,
    pub exit_reason: Option<String>,
    pub uptime_ms: Option<i64>,
    pub error: Option<String>,
    pub stderr_error_line: Option<String>,
    pub stderr_last_line: Option<String>,
    pub stderr_path: Option<PathBuf>,
}

struct State {
    record: CaptureRecord,
    log: Log,
    now: Clock,
    nonce: Nonce,
    started_ms: i64,
    stem: Option<String>,
    capture_path: Option<PathBuf>,
    record_path: Option<PathBuf>,
    /// The launcher's copy of the fd 2 file until released.
    write_file: Option<File>,
    /// Bytes already mirrored into the launcher's log.
    read_offset: u64,
    /// The capture was dropped as uninteresting.
    removed: bool,
    /// What a fallback stderr pipe delivered (its newest bytes).
    pipe_text: String,
    drain: Option<JoinHandle<()>>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A boot's capture. Clones share it (the exit watcher holds one).
#[derive(Clone)]
pub struct SpawnCapture {
    state: Arc<Mutex<State>>,
}

/// An atomic write of the sidecar: a pruner reading it concurrently never sees a half-written document and concludes the boot
/// is dead. The temp is named as `writeJsonAtomicSync` names it (`<file>.mixdog-tmp-<hex>`), which retention reclaims when its
/// writer is gone.
fn write_json_atomic(file: &Path, record: &CaptureRecord) -> std::io::Result<()> {
    use std::io::Write;
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let tag = format!("{}{:04x}", random_nonce(), COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff);
    let mut staged = file.as_os_str().to_owned();
    staged.push(format!(".mixdog-tmp-{tag}"));
    let staged = PathBuf::from(staged);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = (|| {
        let mut out = options.open(&staged)?;
        out.write_all(&serde_json::to_vec(record).map_err(std::io::Error::other)?)?;
        out.sync_all()
    })();
    let renamed = written.and_then(|()| std::fs::rename(&staged, file));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    renamed
}

/// One boot's identity and the files it owns.
struct Files {
    file: File,
    stem: String,
    capture_path: PathBuf,
    record_path: PathBuf,
}

/// EXCLUSIVE create: a colliding identity must never adopt, reuse or overwrite somebody else's evidence.
fn allocate_files(dir: &Path, started_ms: i64, launcher_pid: u32, nonce: &Nonce) -> std::io::Result<Files> {
    let mut attempt = 1;
    loop {
        let stem = format!("daemon-{}-{launcher_pid}-{}", stamp(started_ms), nonce());
        let capture_path = dir.join(format!("{stem}.err.log"));
        let record_path = dir.join(format!("{stem}.json"));
        let created = std::fs::OpenOptions::new().append(true).create_new(true).open(&capture_path).and_then(|file| {
            if record_path.exists() {
                // A sidecar without its raw file still owns this identity.
                drop(file);
                let _ = std::fs::remove_file(&capture_path);
                return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
            }
            Ok(file)
        });
        match created {
            Ok(file) => return Ok(Files { file, stem, capture_path, record_path }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < CAPTURE_ID_ATTEMPTS => attempt += 1,
            Err(error) => return Err(error),
        }
    }
}

impl State {
    fn persist(&self) {
        if self.removed {
            return;
        }
        if let Some(path) = &self.record_path {
            // Diagnostics are best effort.
            let _ = write_json_atomic(path, &self.record);
        }
    }

    fn size(&self) -> u64 {
        self.capture_path.as_ref().and_then(|path| std::fs::metadata(path).ok()).map_or(0, |meta| meta.len())
    }

    fn close_write_file(&mut self) {
        self.write_file = None;
    }

    fn open(&mut self, dir: &Path, prune: bool, launcher_pid: u32) {
        let opened = (|| {
            std::fs::create_dir_all(dir)?;
            if prune {
                prune_crash_captures(dir, &process_runs);
            }
            allocate_files(dir, self.started_ms, launcher_pid, &self.nonce)
        })();
        match opened {
            Ok(files) => {
                self.write_file = Some(files.file);
                self.record.stderr_file = Some(format!("{}.err.log", files.stem));
                self.stem = Some(files.stem);
                self.capture_path = Some(files.capture_path);
                self.record_path = Some(files.record_path);
                // Claim ownership before the fork: a concurrent launcher pruning this directory must see a launch in progress, not
                // an orphan raw file.
                self.persist();
            }
            Err(error) => self.unavailable(&error.to_string()),
        }
    }

    fn unavailable(&mut self, why: &str) {
        self.close_write_file();
        self.capture_path = None;
        self.record_path = None;
        self.record.stderr_file = None;
        (self.log)(&format!("daemon crash capture unavailable: {}", bounded(why)));
    }

    fn mirror_text(&self, text: &str) {
        for line in text.split('\n') {
            let row = line.trim_end();
            if !row.is_empty() {
                (self.log)(row);
            }
        }
    }

    /// Mirror only the bytes not mirrored yet, so one line never reaches the launcher's log twice across ready, exit and
    /// timeout drains.
    fn mirror(&mut self) {
        let Some(path) = self.capture_path.clone().filter(|_| !self.removed) else { return };
        let size = self.size();
        if size <= self.read_offset {
            return;
        }
        let mut skipped = 0;
        if size - self.read_offset > MIRROR_MAX_BYTES {
            skipped = size - self.read_offset - MIRROR_MAX_BYTES;
            self.read_offset = size - MIRROR_MAX_BYTES;
        }
        let mut buffer = Vec::new();
        let read = File::open(&path).and_then(|mut file| {
            file.seek(SeekFrom::Start(self.read_offset))?;
            file.take(size - self.read_offset).read_to_end(&mut buffer)
        });
        if read.is_err() {
            return;
        }
        self.read_offset += buffer.len() as u64;
        if skipped > 0 {
            (self.log)(&format!("daemon stderr: skipped {skipped} earlier byte(s), full text in {}", path.display()));
        }
        self.mirror_text(&String::from_utf8_lossy(&buffer));
    }

    fn note_ready(&mut self) {
        if self.record.ready {
            return;
        }
        self.record.ready = true;
        self.record.ready_at = Some(iso((self.now)()));
        self.mirror();
        self.persist();
    }

    fn note_exit(&mut self, code: Option<i64>, signal: Option<&str>) {
        self.close_write_file();
        if self.record.exited_at.is_some() {
            return;
        }
        let at = (self.now)();
        self.record.exited_at = Some(iso(at));
        self.record.exit_code = code;
        self.record.exit_signal = signal.map(str::to_owned);
        self.record.uptime_ms = Some((at - self.started_ms).max(0));
        self.record.stderr_bytes = self.size();
        // The core may have written its own exit block into this sidecar; keep it (this write replaces the whole document) and
        // never leave a bare exit.
        let written = self
            .record_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if let Some(written) = written {
            if let Some(exit) = written.get("daemonExit").filter(|exit| !exit.is_null()) {
                self.record.daemon_exit = Some(exit.clone());
            }
            if let Some(reason) = written.get("exitReason").and_then(Value::as_str).filter(|reason| !reason.is_empty()) {
                self.record.exit_reason = Some(reason.to_owned());
            }
        }
        if self.record.exit_reason.is_none() {
            self.record.exit_reason = Some(describe_exit(code.map(|code| code as i32), signal));
        }
        self.mirror();
        // A contender that lost the singleton claim exits 0 with nothing to say: keeping a file per losing spawn would bury the
        // boots that do matter.
        let uninteresting = !self.record.ready && code == Some(0) && signal.is_none() && self.record.stderr_bytes == 0 && self.record.error.is_none();
        if uninteresting {
            self.remove();
        } else {
            self.persist();
        }
        let record = &self.record;
        let capture = match &self.capture_path {
            Some(path) if !self.removed => format!(" capture={}", path.display()),
            _ => String::new(),
        };
        (self.log)(&format!(
            "daemon exit pid={} code={} signal={} ready={} uptimeMs={} stderrBytes={}{capture}",
            record.pid.map_or_else(|| "?".to_owned(), |pid| pid.to_string()),
            record.exit_code.map_or_else(|| "-".to_owned(), |code| code.to_string()),
            record.exit_signal.as_deref().unwrap_or("-"),
            u8::from(record.ready),
            record.uptime_ms.unwrap_or(0),
            record.stderr_bytes,
        ));
    }

    fn remove(&mut self) {
        self.removed = true;
        for file in [&self.capture_path, &self.record_path].into_iter().flatten() {
            let _ = std::fs::remove_file(file);
        }
    }

    fn note_spawn_error(&mut self, error: &str) {
        self.close_write_file();
        if self.record.error.is_none() {
            self.record.error = Some(bounded(error));
        }
        if self.record.pid.is_none() && self.record.exited_at.is_none() {
            // No child ever existed: this boot is terminal, so the sidecar must not look like a launch still in progress.
            self.record.exited_at = Some(iso((self.now)()));
            self.record.stderr_bytes = self.size();
            if self.record.stderr_bytes == 0 {
                // Nothing was ever written to fd 2: keep the record, drop the empty file.
                if let Some(path) = self.capture_path.take() {
                    let _ = std::fs::remove_file(path);
                }
                self.record.stderr_file = None;
            }
        }
        // A child that did spawn keeps its lifecycle open: `note_exit` still fills in the code or signal.
        self.persist();
    }

    /// The core's fd 2 as text: the capture file (its newest bytes when large) or, when fd 2 fell back to a pipe, what that pipe
    /// delivered.
    fn stderr_text(&self) -> String {
        let Some(path) = self.capture_path.as_ref().filter(|_| !self.removed) else { return self.pipe_text.clone() };
        let read = File::open(path).and_then(|mut file| {
            let size = file.metadata()?.len();
            let length = size.min(SUMMARY_SCAN_MAX_BYTES);
            file.seek(SeekFrom::Start(size - length))?;
            let mut buffer = Vec::new();
            file.take(length).read_to_end(&mut buffer)?;
            Ok(buffer)
        });
        read.map_or_else(|_| self.pipe_text.clone(), |bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    fn summary(&self) -> CaptureSummary {
        let lines: Vec<String> = self.stderr_text().lines().map(|line| line.trim().to_owned()).filter(|line| !line.is_empty()).collect();
        let pattern = mixdog_js::JsRegex::new_static(STDERR_ERROR_LINE, "");
        let error_line = lines.iter().find(|line| pattern.is_match(line));
        let record = &self.record;
        CaptureSummary {
            pid: record.pid,
            ready: record.ready,
            spawned_at: record.spawned_at.clone(),
            exited_at: record.exited_at.clone(),
            exit_code: record.exit_code,
            exit_signal: record.exit_signal.clone(),
            exit_reason: record.exit_reason.clone(),
            uptime_ms: record.uptime_ms,
            error: record.error.clone(),
            stderr_error_line: error_line.map(|line| bounded(line)),
            stderr_last_line: lines.last().map(|line| bounded(line)),
            stderr_path: if self.removed { None } else { self.capture_path.clone() },
        }
    }
}

impl SpawnCapture {
    /// `beginDaemonSpawnCapture`: opens one boot's capture before the core is started. When it cannot be opened the capture is
    /// unavailable (said once to the log) and the core's stderr is a pipe, so boot diagnostics still reach the launcher's log.
    pub fn begin(options: CaptureOptions) -> Self {
        let started_ms = (options.now)();
        let record = CaptureRecord {
            kind: "mixdog-daemon-crash-capture".to_owned(),
            launcher: options.launcher.clone(),
            launcher_pid: options.launcher_pid,
            pid: None,
            detached: None,
            heap_flags: Vec::new(),
            stderr_file: None,
            spawned_at: iso(started_ms),
            ready_at: None,
            exited_at: None,
            ready: false,
            exit_code: None,
            exit_signal: None,
            uptime_ms: None,
            stderr_bytes: 0,
            error: None,
            daemon_exit: None,
            exit_reason: None,
        };
        let mut state = State {
            record,
            log: options.log.clone(),
            now: options.now.clone(),
            nonce: options.nonce.clone(),
            started_ms,
            stem: None,
            capture_path: None,
            record_path: None,
            write_file: None,
            read_offset: 0,
            removed: false,
            pipe_text: String::new(),
            drain: None,
        };
        let dir = options.dir.clone().or_else(|| options.data_dir.as_deref().map(capture_dir)).or_else(process_capture_dir);
        match dir {
            Some(dir) => state.open(&dir, options.prune, options.launcher_pid),
            None => state.unavailable("no data folder"),
        }
        Self { state: Arc::new(Mutex::new(state)) }
    }

    /// What the launcher puts in the core's stderr: the capture file (the child keeps its own duplicate for its whole life,
    /// independent of the launcher), else a pipe.
    pub fn stderr_stdio(&self) -> Stdio {
        let file = lock(&self.state).write_file.as_ref().and_then(|file| file.try_clone().ok());
        file.map_or_else(Stdio::piped, Stdio::from)
    }

    pub fn stem(&self) -> Option<String> {
        lock(&self.state).stem.clone()
    }

    pub fn capture_path(&self) -> Option<PathBuf> {
        lock(&self.state).capture_path.clone()
    }

    pub fn record_path(&self) -> Option<PathBuf> {
        lock(&self.state).record_path.clone()
    }

    /// `track`: records the child's identity. The launcher's copy of the capture file is closed; when fd 2 fell back to a
    /// pipe, `stderr` is drained until the stream itself ends (cutting at ready or at exit would drop the lines in flight).
    pub fn track(&self, pid: Option<u32>, detached: bool, stderr: Option<ChildStderr>) {
        let mut state = lock(&self.state);
        state.record.pid = pid.filter(|pid| *pid != 0);
        state.record.detached = Some(detached);
        state.close_write_file();
        state.persist();
        if let Some(path) = &state.capture_path {
            let who = pid.map_or_else(|| "?".to_owned(), |pid| pid.to_string());
            (state.log)(&format!("daemon crash capture pid={who} file={}", path.display()));
        }
        if let Some(mut stderr) = stderr {
            let shared = self.state.clone();
            state.drain = Some(std::thread::spawn(move || {
                let mut chunk = [0u8; 4096];
                while let Ok(read) = stderr.read(&mut chunk) {
                    if read == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
                    let mut state = lock(&shared);
                    // No capture file to read back: keep the newest bytes for the summary.
                    state.pipe_text.push_str(&text);
                    let keep = SUMMARY_SCAN_MAX_BYTES as usize;
                    if state.pipe_text.len() > keep {
                        let mut cut = state.pipe_text.len() - keep;
                        while !state.pipe_text.is_char_boundary(cut) {
                            cut += 1;
                        }
                        state.pipe_text.replace_range(..cut, "");
                    }
                    state.mirror_text(&text);
                }
            }));
        }
    }

    /// Tracks the spawned child and keeps a lifetime watcher on it, so a later exit is still correlated to this pid, boot time
    /// and ready state. The watcher adds no lifetime dependency: it ends with the launcher, as the detached core outlives it.
    pub fn attach(&self, mut child: Child, detached: bool) {
        self.track(Some(child.id()), detached, child.stderr.take());
        let capture = self.clone();
        std::thread::spawn(move || {
            if let Ok(status) = child.wait() {
                #[cfg(unix)]
                let signal = std::os::unix::process::ExitStatusExt::signal(&status).map(super::exit_record::signal_name);
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                // Node reports a Windows exit status unsigned (`0xC000013A` is 3221225786).
                let code = status.code().map(|code| if cfg!(windows) { i64::from(code as u32) } else { i64::from(code) });
                capture.note_exit(code, signal.as_deref());
            }
        });
    }

    pub fn note_ready(&self) {
        lock(&self.state).note_ready();
    }

    pub fn note_exit(&self, code: Option<i64>, signal: Option<&str>) {
        lock(&self.state).note_exit(code, signal);
    }

    /// Records a spawn failure. Idempotent.
    pub fn note_spawn_error(&self, error: &str) {
        lock(&self.state).note_spawn_error(error);
    }

    pub fn mirror(&self) {
        lock(&self.state).mirror();
    }

    /// Waits until a fallback stderr pipe has ended; immediate when fd 2 is captured to a file.
    pub fn wait_drained(&self) {
        let drain = lock(&self.state).drain.take();
        if let Some(drain) = drain {
            let _ = drain.join();
        }
    }

    /// Drops the launcher's own copy of the capture file without recording anything.
    pub fn release(&self) {
        lock(&self.state).close_write_file();
    }

    pub fn snapshot(&self) -> CaptureRecord {
        lock(&self.state).record.clone()
    }

    pub fn summary(&self) -> CaptureSummary {
        lock(&self.state).summary()
    }
}
