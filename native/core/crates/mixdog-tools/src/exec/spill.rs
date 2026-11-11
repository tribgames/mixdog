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
use std::time::SystemTime;

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

/// Creates (truncating) both logs of a job and their directory. Best effort.
pub async fn create_logs(lane: SpawnIo, cancel: &CancellationToken, out: &Path, err: &Path) {
    let (out, err): (PathBuf, PathBuf) = (out.to_owned(), err.to_owned());
    let Ok(handle) = lane.submit(cancel, move |_| {
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::File::create(&out)?;
        std::fs::File::create(&err).map(drop)
    }) else {
        return;
    };
    let _ = handle.await;
}

/// Unwritten log bytes one job may hold, the batch being written included, before its collector
/// waits for the writer: four of the process manager's merged output events (`mixdog-spawn`
/// `feed.rs` `MERGE_LIMIT`, 64 KiB). The job's capture itself stays within `jobs.rs` `MEMORY_CAP`.
pub const LOG_PENDING_CAP: usize = 256 * 1024;

/// The writer of one job's two logs (stdout 0, stderr 1). Chunks are queued in arrival order and
/// written in batches by a drain on an io-pty thread (one thread per drain, no shared pool, so one
/// job's slow disk never stalls another's); one drain runs at a time per job, so each log keeps
/// its order. A log whose write fails is not written again, as a failed append stopped it before.
pub struct LogWriter {
    lane: PtyIo,
    shared: Arc<Shared>,
}

struct Shared {
    logs: [PathBuf; 2],
    state: Mutex<WriterState>,
    /// Notified when a batch was written or the drain ended.
    progress: Notify,
    /// The drains' token: a job's logs are written to the end whatever happens to its call.
    never: CancellationToken,
}

#[derive(Default)]
struct WriterState {
    queued: Vec<(usize, Vec<u8>)>,
    /// Bytes queued or being written.
    bytes: usize,
    draining: bool,
    stopped: [bool; 2],
}

impl LogWriter {
    pub fn new(lane: PtyIo, stdout: &Path, stderr: &Path) -> Self {
        let shared = Shared {
            logs: [stdout.to_owned(), stderr.to_owned()],
            state: Mutex::new(WriterState::default()),
            progress: Notify::new(),
            never: CancellationToken::new(),
        };
        Self { lane, shared: Arc::new(shared) }
    }

    /// Queues `bytes` for log `stream`, first waiting while the job holds [`LOG_PENDING_CAP`]
    /// unwritten bytes. Cancel-safe: dropped while it waits, it has queued nothing.
    pub async fn push(&self, stream: usize, bytes: Vec<u8>) {
        loop {
            let written = self.shared.progress.notified();
            tokio::pin!(written);
            written.as_mut().enable();
            {
                let mut state = lock(&self.shared.state);
                if state.stopped[stream] {
                    return;
                }
                if state.bytes == 0 || state.bytes + bytes.len() <= LOG_PENDING_CAP {
                    state.bytes += bytes.len();
                    state.queued.push((stream, bytes));
                    if std::mem::replace(&mut state.draining, true) {
                        return;
                    }
                    break;
                }
            }
            written.await;
        }
        self.start_drain();
    }

    /// Starts a drain. With no thread to be had (the io-pty lane at its live cap) the queued
    /// output is dropped and both logs stop, as a refused append stopped its log before.
    fn start_drain(&self) {
        let shared = self.shared.clone();
        if self.lane.submit(&self.shared.never, move |_| drain(&shared)).is_err() {
            let mut state = lock(&self.shared.state);
            state.stopped = [true, true];
            state.queued.clear();
            state.bytes = 0;
            state.draining = false;
            drop(state);
            self.shared.progress.notify_waiters();
        }
    }

    /// Waits until everything queued is written (or its log stopped): the logs are complete.
    pub async fn close(&self) {
        loop {
            let written = self.shared.progress.notified();
            tokio::pin!(written);
            written.as_mut().enable();
            if !lock(&self.shared.state).draining {
                return;
            }
            written.await;
        }
    }

    /// Bytes queued or being written.
    #[cfg(test)]
    pub(crate) fn unwritten(&self) -> usize {
        lock(&self.shared.state).bytes
    }
}

/// Writes the queued chunks in batches, each log's run of a batch in one append, until nothing is
/// queued.
fn drain(shared: &Shared) {
    loop {
        let (batch, stopped) = {
            let mut state = lock(&shared.state);
            if state.queued.is_empty() {
                state.draining = false;
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
        let mut failed = [false; 2];
        for (stream, run) in runs.iter().enumerate() {
            if !run.is_empty() && !stopped[stream] {
                failed[stream] = append(&shared.logs[stream], run).is_err();
            }
        }
        {
            let mut state = lock(&shared.state);
            state.bytes -= written;
            state.stopped[0] |= failed[0];
            state.stopped[1] |= failed[1];
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
    }

    static GATES: Mutex<Vec<(PathBuf, Arc<Gate>)>> = Mutex::new(Vec::new());

    /// Gates the drains of the logs under `dir`.
    pub(crate) fn arm(dir: &Path) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        GATES.lock().unwrap().push((dir.to_owned(), gate.clone()));
        gate
    }

    pub(super) fn pass(log: &Path) {
        let gate = GATES.lock().unwrap().iter().find(|(dir, _)| log.starts_with(dir)).map(|(_, gate)| gate.clone());
        if let Some(gate) = gate {
            let mut state = gate.state.lock().unwrap();
            state.1 += 1;
            gate.changed.notify_all();
            while !state.0 {
                state = gate.changed.wait(state).unwrap();
            }
        }
    }

    impl Gate {
        /// Waits until drains have reached the gate `count` times.
        pub(crate) fn wait_reached(&self, count: usize) {
            let (state, waited) = self
                .changed
                .wait_timeout_while(self.state.lock().unwrap(), Duration::from_secs(60), |state| state.1 < count)
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
/// `SkillRuntime` and data directory, which never change, so they are made once. Only the disk
/// can change: the length and modification time of each file as last written or found are kept,
/// and a call whose files still carry them reads nothing more; a file removed or rewritten since
/// no longer matches and is written again.
#[derive(Default)]
pub struct KeptLaunchers {
    plan: OnceLock<Arc<LauncherPlan>>,
    stamps: Mutex<Option<Vec<FileStamp>>>,
}

struct LauncherPlan {
    dir: PathBuf,
    files: Vec<(String, String)>,
}

type FileStamp = (u64, SystemTime);

fn stamps(plan: &LauncherPlan) -> Option<Vec<FileStamp>> {
    plan.files
        .iter()
        .map(|(name, _)| {
            let meta = std::fs::metadata(plan.dir.join(name)).ok()?;
            Some((meta.len(), meta.modified().ok()?))
        })
        .collect()
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
    let last = lock(&kept.stamps).clone();
    let checked = plan.clone();
    let job = lane.submit(cancel, move |_| {
        if last.is_some() && stamps(&checked) == last {
            return last;
        }
        write_launchers(&checked).ok()?;
        stamps(&checked)
    });
    if let Ok(job) = job {
        if let Ok(found) = job.await {
            *lock(&kept.stamps) = found;
        }
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
