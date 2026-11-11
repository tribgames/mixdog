//! The files of a shell call: its job's output logs, hoisted scripts, tee files, launchers.
//! Every filesystem call runs as a lane job, never on an async worker, and never on io-maintenance
//! (whose two threads serve minutes-long background loops): a call's start on io-spawn, a job's
//! log appends on its own io-pty thread ([`LogWriter`]), a result's reads on io-interactive.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "lane job bodies are the sanctioned home of blocking file I/O (clippy.toml)"
)]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;

use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::PtyIo;
use mixdog_rt::SpawnIo;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::invocation::SkillRuntime;
use super::invocation::skill_launcher_dir;
use super::invocation::skill_launcher_files;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Creates (truncating) both logs of a job and their directory. Best effort: a log that cannot be
/// created fails its first append, which stops it.
fn create_logs(logs: &[PathBuf; 2]) {
    #[cfg(test)]
    write_gate::pass(&logs[0]);
    if let Some(dir) = logs[0].parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    for log in logs {
        let _ = std::fs::File::create(log);
    }
}

/// Unwritten log bytes one job may hold, the batch being written included, before its collector
/// waits for the writer: four of the process manager's merged output events (`mixdog-spawn`
/// `feed.rs` `MERGE_LIMIT`, 64 KiB). The job's capture itself stays within `jobs.rs` `MEMORY_CAP`.
pub const LOG_PENDING_CAP: usize = 256 * 1024;

/// How long a job's writer may make no progress (no batch written) before the job gives its logs
/// up: the io lanes' lease (`mixdog-rt exec.rs` `lane_lease`, 30 s for io-durability and
/// io-spawn), past which a lane counts a thread stuck in one filesystem call as wedged. It bounds
/// both the collector's wait for room and [`LogWriter::close`].
pub const LOG_STALL: std::time::Duration = std::time::Duration::from_secs(30);

/// How [`LogWriter::close`] ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogsClosed {
    /// Every byte given to the writer is in its log.
    Complete,
    /// A log lacks output from a byte on ([`LogWriter::gaps`]): a write failed, or the writer
    /// was given up after [`LOG_STALL`] without progress or at the close's deadline.
    Incomplete,
}

/// The writer of one job's two logs (stdout 0, stderr 1). The first drain creates the logs
/// ([`LogWriter::open`]); chunks are queued in arrival order and written in batches by a drain on
/// an io-pty thread (one thread per drain, no shared pool, so one job's slow disk never stalls
/// another's); one drain runs at a time per job, so each log keeps its order. A drain waits for an
/// io-pty thread rather than dropping output when the lane is at its live cap.
///
/// Every wait is bounded and tied to the job's own token (`stop`): a writer that makes no
/// progress for [`LOG_STALL`] while the collector waits for room, or that is not done by the
/// close's deadline, is given up ([`LogWriter::abandon`]): `stop` is cancelled, which takes a
/// drain still waiting for a thread out of the lane's queue, nothing more is written, and each
/// log that lacks output records from which byte ([`LogWriter::gaps`]); the job's results say so
/// (`Job::log_note`). A log whose write fails is not written again and records its gap the same
/// way. Every exit of a drain (done, panicked, never run) leaves the writer idle.
#[derive(Clone)]
pub struct LogWriter {
    lane: PtyIo,
    shared: Arc<Shared>,
}

struct Shared {
    logs: [PathBuf; 2],
    state: Mutex<WriterState>,
    /// Notified when a batch was written or the drain ended.
    progress: Notify,
    /// The job's log token: cancelled when the writer is given up.
    stop: CancellationToken,
}

#[derive(Default)]
struct WriterState {
    queued: Vec<(usize, Vec<u8>)>,
    /// Bytes queued or being written.
    bytes: usize,
    draining: bool,
    /// The logs were created (by the first drain).
    created: bool,
    stopped: [bool; 2],
    /// Bytes given to each log, and of those the bytes written to it.
    offered: [u64; 2],
    written: [u64; 2],
    /// Where each log's output stops being complete.
    gaps: [Option<u64>; 2],
    /// Given up: nothing more is written.
    abandoned: bool,
}

impl WriterState {
    /// Nothing more will be written: each log that lacks output given to it records its gap at
    /// the bytes it holds.
    fn note_gaps(&mut self) {
        for stream in 0..2 {
            if self.offered[stream] > self.written[stream] {
                self.gaps[stream].get_or_insert(self.written[stream]);
            }
        }
    }
}

/// Held by a drain from its submission to its end. Dropped any other way than [`DrainExit::done`]
/// (the drain panicked, its thread could not take the lane's priority, its submission failed or
/// was abandoned), it stops both logs, drops what was queued and leaves the writer idle.
struct DrainExit {
    shared: Option<Arc<Shared>>,
}

impl DrainExit {
    /// The drain found nothing queued, under the state's lock: the writer is idle.
    fn done(mut self, state: &mut WriterState) {
        state.draining = false;
        self.shared = None;
    }
}

impl Drop for DrainExit {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else { return };
        {
            let mut state = lock(&shared.state);
            state.draining = false;
            state.stopped = [true, true];
            state.queued.clear();
            state.bytes = 0;
            state.note_gaps();
        }
        shared.progress.notify_waiters();
    }
}

impl LogWriter {
    pub fn new(lane: PtyIo, stdout: &Path, stderr: &Path) -> Self {
        let shared = Shared {
            logs: [stdout.to_owned(), stderr.to_owned()],
            state: Mutex::new(WriterState::default()),
            progress: Notify::new(),
            stop: CancellationToken::new(),
        };
        Self { lane, shared: Arc::new(shared) }
    }

    /// Queues `bytes` for log `stream`, first waiting while the job holds [`LOG_PENDING_CAP`]
    /// unwritten bytes; after [`LOG_STALL`] without a batch written the writer is given up and
    /// the bytes are recorded as missing. Cancel-safe: dropped while it waits, it has queued
    /// nothing.
    pub async fn push(&self, stream: usize, bytes: Vec<u8>) {
        loop {
            let written = self.shared.progress.notified();
            tokio::pin!(written);
            written.as_mut().enable();
            {
                let mut state = lock(&self.shared.state);
                if state.stopped[stream] {
                    state.offered[stream] += bytes.len() as u64;
                    let at = state.written[stream];
                    state.gaps[stream].get_or_insert(at);
                    return;
                }
                if state.bytes == 0 || state.bytes + bytes.len() <= LOG_PENDING_CAP {
                    state.bytes += bytes.len();
                    state.offered[stream] += bytes.len() as u64;
                    state.queued.push((stream, bytes));
                    if std::mem::replace(&mut state.draining, true) {
                        return;
                    }
                    break;
                }
            }
            if mixdog_rt::time::timeout(LOG_STALL, written).await.is_err() {
                self.abandon();
            }
        }
        self.start_drain().await;
    }

    /// Gives the writer up: nothing more is written, a drain waiting for a thread leaves the
    /// lane's queue, and each log that lacks output records from which byte. A drain already in
    /// a filesystem call finishes that call on its own thread.
    fn abandon(&self) {
        {
            let mut state = lock(&self.shared.state);
            state.abandoned = true;
            state.stopped = [true, true];
            let dropped: usize = state.queued.drain(..).map(|(_, bytes)| bytes.len()).sum();
            state.bytes -= dropped;
            state.note_gaps();
        }
        self.shared.stop.cancel();
        self.shared.progress.notify_waiters();
    }

    /// Where each log (stdout, stderr) stops being complete: the bytes it holds of the output
    /// given to it, when that is less than all of it.
    pub fn gaps(&self) -> [Option<u64>; 2] {
        lock(&self.shared.state).gaps
    }

    /// Creates the logs, on the first drain. The job calls it once it is subscribed to the
    /// process's output, so output that comes meanwhile is queued, not lost.
    pub async fn open(&self) {
        if std::mem::replace(&mut lock(&self.shared.state).draining, true) {
            return;
        }
        self.start_drain().await;
    }

    /// Starts a drain (`draining` is already set), waiting for an io-pty thread when the lane is
    /// at its live cap, for at most [`LOG_STALL`] (then the writer is given up); the job's token
    /// also ends that wait when the writer is given up. A drain that cannot be started ends
    /// through its [`DrainExit`].
    async fn start_drain(&self) {
        let exit = DrainExit { shared: Some(self.shared.clone()) };
        let shared = self.shared.clone();
        let admission = self.lane.submit_wait(&self.shared.stop, move |_| drain(&shared, exit));
        // A saturated lane is not reported wedged, so its admission has its own deadline; the
        // dropped wait leaves the lane's queue and takes the drain's exit with it.
        if mixdog_rt::time::timeout(LOG_STALL, admission).await.is_err() {
            self.abandon();
        }
    }

    /// Waits until everything queued is written (or its log stopped), for at most `deadline`;
    /// a writer not done by then is given up. The outcome names whether the logs are whole.
    pub async fn close(&self, deadline: std::time::Duration) -> LogsClosed {
        let done = async {
            loop {
                let written = self.shared.progress.notified();
                tokio::pin!(written);
                written.as_mut().enable();
                {
                    let state = lock(&self.shared.state);
                    if !state.draining || state.abandoned {
                        return;
                    }
                }
                written.await;
            }
        };
        if mixdog_rt::time::timeout(deadline, done).await.is_err() {
            self.abandon();
        }
        if lock(&self.shared.state).gaps.iter().any(Option::is_some) { LogsClosed::Incomplete } else { LogsClosed::Complete }
    }

    /// Bytes queued or being written.
    #[cfg(test)]
    pub(crate) fn unwritten(&self) -> usize {
        lock(&self.shared.state).bytes
    }
}

/// Writes the queued chunks in batches, each log's run of a batch in one append, until nothing is
/// queued.
fn drain(shared: &Shared, exit: DrainExit) {
    if !lock(&shared.state).created {
        create_logs(&shared.logs);
        lock(&shared.state).created = true;
    }
    loop {
        let (batch, stopped) = {
            let mut state = lock(&shared.state);
            if state.queued.is_empty() {
                exit.done(&mut state);
                drop(state);
                shared.progress.notify_waiters();
                return;
            }
            (std::mem::take(&mut state.queued), state.stopped)
        };
        #[cfg(test)]
        write_gate::pass(&shared.logs[0]);
        let mut written = 0;
        let mut runs: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
        for (stream, bytes) in batch {
            written += bytes.len();
            if runs[stream].is_empty() {
                runs[stream] = bytes;
            } else {
                runs[stream].extend_from_slice(&bytes);
            }
        }
        let mut appended = [None; 2];
        for (stream, run) in runs.iter().enumerate() {
            if !run.is_empty() && !stopped[stream] {
                appended[stream] = Some(append(&shared.logs[stream], run).is_ok().then_some(run.len() as u64));
            }
        }
        {
            let mut state = lock(&shared.state);
            state.bytes -= written;
            for (stream, appended) in appended.into_iter().enumerate() {
                match appended {
                    Some(Some(len)) => state.written[stream] += len,
                    Some(None) => {
                        state.stopped[stream] = true;
                        let at = state.written[stream];
                        state.gaps[stream].get_or_insert(at);
                    }
                    None => {}
                }
            }
        }
        shared.progress.notify_waiters();
    }
}

fn append(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::OpenOptions::new().append(true).open(path).and_then(|mut file| file.write_all(bytes))
}

/// Holds the drains of the logs under a directory before each batch, until the test opens it.
#[cfg(test)]
pub(crate) mod write_gate {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Condvar;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Open or not, and how many times a drain reached it.
    #[derive(Default)]
    pub(crate) struct Gate {
        state: Mutex<(bool, usize)>,
        changed: Condvar,
        /// The drain panics here instead of waiting.
        panics: bool,
    }

    static GATES: Mutex<Vec<(PathBuf, Arc<Gate>)>> = Mutex::new(Vec::new());

    /// Gates the creation and the drains of the logs under `dir`.
    pub(crate) fn arm(dir: &Path) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        GATES.lock().unwrap().push((dir.to_owned(), gate.clone()));
        gate
    }

    /// Makes the drains of the logs under `dir` panic.
    pub(crate) fn arm_panicking(dir: &Path) -> Arc<Gate> {
        let gate = Arc::new(Gate { panics: true, ..Gate::default() });
        GATES.lock().unwrap().push((dir.to_owned(), gate.clone()));
        gate
    }

    pub(crate) fn pass(log: &Path) {
        let gate = GATES.lock().unwrap().iter().find(|(dir, _)| log.starts_with(dir)).map(|(_, gate)| gate.clone());
        if let Some(gate) = gate {
            assert!(!gate.panics, "a test makes this log drain fail");
            let mut state = gate.state.lock().unwrap();
            state.1 += 1;
            gate.changed.notify_all();
            let (_state, waited) = gate.changed.wait_timeout_while(state, GATE_WAIT, |state| !state.0).unwrap();
            assert!(!waited.timed_out(), "the test opens the log write gate within {GATE_WAIT:?}");
        }
    }

    /// The deadline of every wait at the gate.
    pub(crate) const GATE_WAIT: Duration = Duration::from_secs(60);

    impl Gate {
        /// Waits until drains have reached the gate `count` times.
        pub(crate) fn wait_reached(&self, count: usize) {
            let (state, waited) = self
                .changed
                .wait_timeout_while(self.state.lock().unwrap(), GATE_WAIT, |state| state.1 < count)
                .unwrap();
            assert!(!waited.timed_out(), "a log drain reaches the gate {count} time(s); it reached it {}", state.1);
        }

        pub(crate) fn open(&self) {
            self.state.lock().unwrap().0 = true;
            self.changed.notify_all();
        }
    }
}

static HOIST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A unique file name `mixdog-inline-<pid>-<uuid-shaped hex><extension>` in the temp directory.
fn hoist_file_name(extension: &str) -> String {
    use sha2::Digest;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = HOIST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let digest = sha2::Sha256::digest(format!("{}:{nanos}:{n}", std::process::id()));
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(
        "mixdog-inline-{}-{}-{}-{}-{}-{}{extension}",
        std::process::id(),
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Eight hex characters, unique per call (`randomUUID().slice(0, 8)`).
pub fn fresh_token() -> String {
    use sha2::Digest;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = HOIST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let digest = sha2::Sha256::digest(format!("tee:{}:{nanos}:{n}", std::process::id()));
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// Writes a hoisted script to a new file in the temp directory (the exclusive flag refuses a
/// name that exists). A PowerShell script gets a BOM: Windows PowerShell 5.1 reads UTF-8 without
/// one as the active ANSI code page.
pub async fn write_hoist_file(
    lane: SpawnIo,
    cancel: &CancellationToken,
    extension: &'static str,
    body: &str,
) -> Option<PathBuf> {
    let path = std::env::temp_dir().join(hoist_file_name(extension));
    let content = if extension == ".ps1" { format!("\u{feff}{body}") } else { body.to_owned() };
    let target = path.clone();
    let job = lane
        .submit(cancel, move |_| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .and_then(|mut file| file.write_all(content.as_bytes()))
        })
        .ok()?;
    matches!(job.await, Ok(Ok(()))).then_some(path)
}

/// The tail of a tee spill file (`readFilterTeeCapture`, at most `max_bytes`), BOM-sniffed:
/// Windows PowerShell 5.1 writes UTF-16LE, pwsh 7 UTF-8. `None` when missing, empty or unreadable.
pub async fn read_tee_tail(lane: InteractiveIo, cancel: &CancellationToken, path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::Read;
    use std::io::Seek;
    let path = path.to_owned();
    let job = lane
        .submit(cancel, move |_| -> Option<String> {
            let mut file = std::fs::File::open(&path).ok()?;
            let size = file.metadata().ok()?.len();
            if size == 0 {
                return None;
            }
            let mut bom = [0u8; 2];
            let read = file.read(&mut bom).ok()?;
            let utf16 = read == 2 && bom == [0xff, 0xfe];
            let mut start = size.saturating_sub(max_bytes);
            if utf16 && start % 2 == 1 {
                start += 1;
            }
            file.seek(std::io::SeekFrom::Start(start)).ok()?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).ok()?;
            super::invocation::decode_tee_capture(&bytes, utf16)
        })
        .ok()?;
    job.await.ok()?
}

/// The skill launchers of a runtime. Their directory and contents are built from the runtime's
/// `SkillRuntime` and data directory, which never change, so they are made once. The disk can
/// change, and a launcher is executed, so every call compares each file's contents (a few hundred
/// bytes) with what it must hold and writes again any that differs: a length or time stamp would
/// pass a replacement of the same length and time.
#[derive(Default)]
pub struct KeptLaunchers {
    plan: OnceLock<Arc<LauncherPlan>>,
}

struct LauncherPlan {
    dir: PathBuf,
    files: Vec<(String, String)>,
}

/// Writes (atomically) every launcher file whose content differs.
fn write_launchers(plan: &LauncherPlan) -> std::io::Result<()> {
    std::fs::create_dir_all(&plan.dir)?;
    for (name, content) in &plan.files {
        let file = plan.dir.join(name);
        if std::fs::read_to_string(&file).is_ok_and(|current| current == *content) {
            continue;
        }
        let temp = plan.dir.join(format!("{name}.tmp-{}", std::process::id()));
        std::fs::write(&temp, content.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::rename(&temp, &file)?;
    }
    Ok(())
}

/// Writes or refreshes the skill launcher files of the installation (best effort) and answers
/// their directory.
pub async fn ensure_launchers(
    lane: SpawnIo,
    cancel: &CancellationToken,
    kept: &KeptLaunchers,
    rt: &SkillRuntime,
    data_dir: &Path,
) -> PathBuf {
    let plan = kept
        .plan
        .get_or_init(|| {
            Arc::new(LauncherPlan {
                dir: PathBuf::from(skill_launcher_dir(rt, &data_dir.to_string_lossy())),
                files: skill_launcher_files(rt),
            })
        })
        .clone();
    let checked = plan.clone();
    if let Ok(job) = lane.submit(cancel, move |_| write_launchers(&checked)) {
        let _ = job.await;
    }
    plan.dir.clone()
}

/// Removes a file; best effort (an unconfirmed kill may keep it locked).
pub async fn remove_file(lane: impl LaneToken, cancel: &CancellationToken, path: &Path) {
    let path = path.to_owned();
    if let Ok(job) = lane.submit(cancel, move |_| std::fs::remove_file(&path)) {
        let _ = job.await;
    }
}

/// Creates a directory (and parents) for a session scratch folder. Best effort.
pub async fn create_dir(lane: SpawnIo, cancel: &CancellationToken, dir: &Path) {
    let dir = dir.to_owned();
    if let Ok(handle) = lane.submit(cancel, move |_| std::fs::create_dir_all(&dir)) {
        let _ = handle.await;
    }
}
