//! `<data>/daemon.log`: the port of `src/standalone/daemon-log.mjs` `createDaemonLog`.
//!
//! Every line is `[<ISO>] [daemon] <line>\n`. Before [`DaemonLog::enable_file_logging`] a line goes
//! to the process's stderr (the spawner mirrors it into the file until ready); after, the file
//! has it. Lines wait in one queue of at most 512 KiB (a line that does not fit is counted, and the
//! next batch opens with `[<ISO>] [daemon] dropped N log line(s) under backpressure`). One drainer
//! job on the maintenance lane takes the whole queue as a batch, rotates when the batch would pass
//! 10 MiB (the file keeps its last 2 MiB), then appends it. A failed write loses its batch and
//! forgets the known size, so the next batch re-reads it.
//!
//! Two deliberate departures from the Node module, both forced by where the I/O may run:
//! - No 10 ms flush timer: the drainer job takes whatever is queued when it starts, and lines that
//!   arrive during a write form the next batch (the same coalescing under load).
//! - No `flushSync`/`installRedirect`: Rust has no `process.exit` path that skips the lane (the
//!   stop procedure awaits [`DaemonLog::flush`]), and stdout/stderr/console capture is a Node
//!   mechanism. [`DaemonLog::raw`] is what the redirect did with one chunk.
//! The rotation rewrite goes through the atomic publisher instead of `writeFileSync` truncation:
//! the resulting bytes are the same.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_agent::agent_tool::stamp::iso_from_ms;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use tokio::sync::Notify;

/// `PLUGIN_LOG_MAX_BYTES` (`mixdog-debug.cjs`).
const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// `PLUGIN_LOG_KEEP_BYTES`.
const LOG_KEEP_BYTES: u64 = 2 * 1024 * 1024;
/// `LOG_LINE_MAX_CHARS`, in UTF-16 units as JavaScript counts them.
const LINE_MAX_UNITS: usize = 16_384;
/// `LOG_QUEUE_MAX_BYTES`.
const QUEUE_MAX_BYTES: usize = 512 * 1024;

/// Epoch milliseconds, for the `[<ISO>]` stamp.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Where a line goes before the file takes over: the text with its newline.
pub type StderrSink = Arc<dyn Fn(&str) + Send + Sync>;

/// The log file as the drainer needs it. Each call runs on the maintenance lane.
pub trait LogFile: Send + Sync + 'static {
    /// `statSync(path).size`.
    fn size(&self, lane: &InLane<MaintenanceIo>) -> io::Result<u64>;
    /// `appendFile(path, bytes)`, the directory made first.
    fn append(&self, lane: &InLane<MaintenanceIo>, bytes: &[u8]) -> io::Result<()>;
    /// Up to `len` bytes from `offset`.
    fn read_tail(&self, lane: &InLane<MaintenanceIo>, offset: u64, len: usize) -> io::Result<Vec<u8>>;
    /// The whole file replaced by `bytes`.
    fn replace(&self, lane: &InLane<MaintenanceIo>, bytes: &[u8]) -> io::Result<()>;
}

/// The real file.
pub struct DiskLogFile {
    path: PathBuf,
}

impl DiskLogFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl LogFile for DiskLogFile {
    fn size(&self, lane: &InLane<MaintenanceIo>) -> io::Result<u64> {
        mixdog_statefile::metadata(lane, &self.path).map(|meta| meta.len())
    }

    fn append(&self, lane: &InLane<MaintenanceIo>, bytes: &[u8]) -> io::Result<()> {
        mixdog_statefile::append_file(lane, &self.path, bytes)
    }

    fn read_tail(&self, lane: &InLane<MaintenanceIo>, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        mixdog_statefile::read_range(lane, &self.path, offset, len)
    }

    fn replace(&self, lane: &InLane<MaintenanceIo>, bytes: &[u8]) -> io::Result<()> {
        let opts = mixdog_statefile::Opts { fsync: false, lock: false, ..mixdog_statefile::Opts::default() };
        mixdog_statefile::write_file(lane, &self.path, bytes, &opts).map(|_| ()).map_err(|error| io::Error::other(error.to_string()))
    }
}

#[derive(Default)]
struct State {
    file_logging: bool,
    queue: Vec<String>,
    queue_bytes: usize,
    dropped: u64,
    /// A drainer job is queued or running. Only that job writes, so batches land in order.
    scheduled: bool,
}

struct Shared {
    file: Arc<dyn LogFile>,
    lane: MaintenanceIo,
    cancel: CancellationToken,
    clock: Clock,
    stderr: StderrSink,
    state: Mutex<State>,
    /// `fileBytes`: the file's known size, `None` until read or after a failed write. Touched by
    /// the one drainer only.
    file_bytes: Mutex<Option<u64>>,
    /// Woken when the drainer finds nothing left (or never ran).
    idle: Notify,
}

/// The daemon log. Cloning shares the queue.
#[derive(Clone)]
pub struct DaemonLog {
    shared: Arc<Shared>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn system_now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `boundedText`: more than 16 384 UTF-16 units keeps the first 16 384 (a cut surrogate pair
/// becomes U+FFFD, as UTF-8 encoding turns a lone surrogate) and says how many were dropped.
fn bounded_text(text: &str) -> String {
    if text.len() <= LINE_MAX_UNITS {
        return text.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= LINE_MAX_UNITS {
        return text.to_owned();
    }
    format!("{}… [truncated {} chars]", String::from_utf16_lossy(&units[..LINE_MAX_UNITS]), units.len() - LINE_MAX_UNITS)
}

/// Disarms on the normal path; otherwise (the job was refused, dropped unstarted or panicked) it
/// lets the next line schedule a drainer again.
struct Scheduled {
    shared: Option<Arc<Shared>>,
}

impl Drop for Scheduled {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.take() {
            locked(&shared.state).scheduled = false;
            shared.idle.notify_waiters();
        }
    }
}

impl DaemonLog {
    /// The daemon's log at `path` (`<data>/daemon.log`): the system clock, the process's stderr
    /// before ready, the file's I/O on `lane`. `cancel` is the daemon's run token.
    pub fn new(path: PathBuf, lane: MaintenanceIo, cancel: CancellationToken) -> Self {
        let stderr: StderrSink = Arc::new(|text| {
            use std::io::Write;
            let _ = std::io::stderr().write_all(text.as_bytes());
        });
        Self::with_parts(Arc::new(DiskLogFile::new(path)), lane, cancel, Arc::new(system_now_ms), stderr)
    }

    pub fn with_parts(file: Arc<dyn LogFile>, lane: MaintenanceIo, cancel: CancellationToken, clock: Clock, stderr: StderrSink) -> Self {
        Self {
            shared: Arc::new(Shared {
                file,
                lane,
                cancel,
                clock,
                stderr,
                state: Mutex::new(State::default()),
                file_bytes: Mutex::new(None),
                idle: Notify::new(),
            }),
        }
    }

    /// `enableFileLogging`: from the next line on, the file has the log and stderr none of it.
    pub fn enable_file_logging(&self) {
        locked(&self.shared.state).file_logging = true;
    }

    /// `log(line)`.
    pub fn log(&self, line: &str) {
        let text = format!("[daemon] {line}");
        if !locked(&self.shared.state).file_logging {
            (self.shared.stderr)(&format!("{text}\n"));
            return;
        }
        self.append(&text);
    }

    /// One chunk of redirected stderr/stdout: trimmed at the end, empty ones ignored, and no
    /// `[daemon]` tag.
    pub fn raw(&self, chunk: &str) {
        // `trimEnd`: Unicode white space and the BOM, but not U+0085.
        let text = chunk.trim_end_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
        if !text.is_empty() {
            self.append(text);
        }
    }

    /// `ResumeLog` for the quota-resume scheduler, and any other `Fn(&str)` log seam.
    pub fn line_log(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        let log = self.clone();
        Arc::new(move |line| log.log(line))
    }

    /// `flush`: returns once every line logged before the call is written (or lost to a failed
    /// write). A lane that refuses the drainer leaves the lines queued for the next line's try.
    pub async fn flush(&self) {
        loop {
            let notified = self.shared.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let schedule = {
                let mut state = locked(&self.shared.state);
                if state.queue.is_empty() && state.dropped == 0 && !state.scheduled {
                    return;
                }
                // A cancelled run drops its drainer unstarted; asking again would be answered the same.
                if self.shared.cancel.is_cancelled() && !state.scheduled {
                    return;
                }
                !std::mem::replace(&mut state.scheduled, true)
            };
            if schedule && !self.submit_drainer() {
                return;
            }
            notified.await;
        }
    }

    fn append(&self, text: &str) {
        let line = format!("[{}] {}\n", iso_from_ms((self.shared.clock)()), bounded_text(text));
        let schedule = {
            let mut state = locked(&self.shared.state);
            if line.len() > QUEUE_MAX_BYTES || state.queue_bytes + line.len() > QUEUE_MAX_BYTES {
                state.dropped += 1;
            } else {
                state.queue_bytes += line.len();
                state.queue.push(line);
            }
            !std::mem::replace(&mut state.scheduled, true)
        };
        if schedule {
            self.submit_drainer();
        }
    }

    /// Queues the drainer job; `scheduled` is already set. A refused or cancelled job clears it
    /// (its [`Scheduled`] drops with the job).
    fn submit_drainer(&self) -> bool {
        let job_shared = self.shared.clone();
        let mut guard = Scheduled { shared: Some(self.shared.clone()) };
        self.shared
            .lane
            .submit(&self.shared.cancel, move |lane| {
                drain(lane, &job_shared);
                guard.shared = None;
            })
            .is_ok()
    }
}

/// The batch for the next write: the dropped-lines notice first, then the queue; `None` when
/// nothing waits, in which case the drainer ends (decided under the same lock).
fn take_batch(shared: &Shared) -> Option<String> {
    let mut state = locked(&shared.state);
    if state.queue.is_empty() && state.dropped == 0 {
        state.scheduled = false;
        return None;
    }
    let omitted = std::mem::take(&mut state.dropped);
    let mut rows = std::mem::take(&mut state.queue);
    state.queue_bytes = 0;
    if omitted > 0 {
        rows.insert(0, format!("[{}] [daemon] dropped {omitted} log line(s) under backpressure\n", iso_from_ms((shared.clock)())));
    }
    Some(rows.concat())
}

fn drain(lane: &InLane<MaintenanceIo>, shared: &Shared) {
    while let Some(batch) = take_batch(shared) {
        let mut known = locked(&shared.file_bytes);
        if write_batch(lane, shared.file.as_ref(), &mut known, batch.as_bytes()).is_err() {
            // A failed append or rotation may already have changed the file.
            *known = None;
        }
    }
    shared.idle.notify_waiters();
}

fn write_batch(lane: &InLane<MaintenanceIo>, file: &dyn LogFile, known: &mut Option<u64>, batch: &[u8]) -> io::Result<()> {
    let incoming = batch.len() as u64;
    rotate_if_needed(lane, file, known, incoming)?;
    file.append(lane, batch)?;
    *known = Some(known.unwrap_or(0) + incoming);
    Ok(())
}

fn rotate_if_needed(lane: &InLane<MaintenanceIo>, file: &dyn LogFile, known: &mut Option<u64>, incoming: u64) -> io::Result<()> {
    let current = *known.get_or_insert_with(|| file.size(lane).unwrap_or(0));
    if current + incoming <= LOG_MAX_BYTES {
        return Ok(());
    }
    let size = file.size(lane)?;
    *known = Some(size);
    let keep = size.min(LOG_KEEP_BYTES);
    let tail = file.read_tail(lane, size - keep, keep as usize)?;
    file.replace(lane, &tail)?;
    *known = Some(tail.len() as u64);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering::SeqCst;
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::Value;
    use sha2::Digest;
    use sha2::Sha256;

    use super::*;

    const GOLDEN: &str = include_str!("../../../fixtures/daemon-log/golden.json");

    fn tokens() -> mixdog_rt::LaneTokens {
        mixdog_rt::testing::tokens()
    }

    /// One `appendFile` as the Node recorder logged it.
    #[derive(Debug, PartialEq)]
    struct Append {
        bytes: usize,
        lines: usize,
        notice: Option<String>,
    }

    /// The real file, watched, gated at its first append and made to fail on request.
    struct Probe {
        disk: DiskLogFile,
        appends: Mutex<Vec<Append>>,
        count: AtomicUsize,
        gated: Mutex<bool>,
        entered: Mutex<mpsc::Sender<()>>,
        release: Mutex<mpsc::Receiver<()>>,
        /// `(nth append, lands its bytes first)`.
        fault: Option<(usize, bool)>,
    }

    impl LogFile for Probe {
        fn size(&self, lane: &InLane<MaintenanceIo>) -> io::Result<u64> {
            self.disk.size(lane)
        }

        fn append(&self, lane: &InLane<MaintenanceIo>, bytes: &[u8]) -> io::Result<()> {
            let nth = self.count.fetch_add(1, SeqCst) + 1;
            let text = String::from_utf8_lossy(bytes).into_owned();
            let first = text.split('\n').next().unwrap_or_default();
            let notice = (first.contains("] [daemon] dropped ") && first.ends_with("log line(s) under backpressure")).then(|| first.to_owned());
            locked(&self.appends).push(Append { bytes: bytes.len(), lines: text.matches('\n').count(), notice });
            if nth == 1 && *locked(&self.gated) {
                locked(&self.entered).send(()).unwrap();
                locked(&self.release).recv_timeout(Duration::from_secs(30)).unwrap();
            }
            if let Some((at, lands)) = self.fault
                && at == nth
            {
                if lands {
                    self.disk.append(lane, bytes)?;
                }
                return Err(io::Error::other("fixture append fault"));
            }
            self.disk.append(lane, bytes)
        }

        fn read_tail(&self, lane: &InLane<MaintenanceIo>, offset: u64, len: usize) -> io::Result<Vec<u8>> {
            self.disk.read_tail(lane, offset, len)
        }

        fn replace(&self, lane: &InLane<MaintenanceIo>, bytes: &[u8]) -> io::Result<()> {
            self.disk.replace(lane, bytes)
        }
    }

    fn build(parts: &Value) -> String {
        parts.as_array().unwrap().iter().map(|part| part[0].as_str().unwrap().repeat(part[1].as_u64().unwrap() as usize)).collect()
    }

    async fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<MaintenanceIo>) -> R + Send + 'static) -> R {
        mixdog_core_base::support::on_lane(tokens().maintenance_io, &CancellationToken::new(), job).await.unwrap()
    }

    async fn prefile(path: PathBuf, spec: &Value) {
        let bytes: Vec<u8> = match spec["patterned"].as_u64() {
            Some(size) => (0..size).map(|i| (i % 251) as u8).collect(),
            None => vec![spec["fill"].as_str().unwrap().as_bytes()[0]; spec["size"].as_u64().unwrap() as usize],
        };
        on_lane(move |lane| {
            mixdog_statefile::create_private_dir_all(lane, path.parent().unwrap()).unwrap();
            let opts = mixdog_statefile::Opts { fsync: false, ..mixdog_statefile::Opts::default() };
            mixdog_statefile::write_file(lane, &path, &bytes, &opts).unwrap();
        })
        .await;
    }

    /// Replays every scenario Node recorded against the real writer: the same bytes land in the
    /// file, the same writes are attempted (count, size, lines, the dropped-lines notice), the
    /// same lines reach stderr.
    #[tokio::test]
    async fn every_node_scenario_writes_the_same_file() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let limits = &golden["limits"];
        assert_eq!(limits["maxBytes"], LOG_MAX_BYTES);
        assert_eq!(limits["keepBytes"], LOG_KEEP_BYTES);
        assert_eq!(limits["lineMaxChars"], LINE_MAX_UNITS);
        assert_eq!(limits["queueMaxBytes"], QUEUE_MAX_BYTES);
        let base = golden["baseMs"].as_i64().unwrap();
        for (name, scenario) in golden["scenarios"].as_object().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("nested").join("daemon.log");
            if let Some(spec) = scenario.get("prefile") {
                prefile(path.clone(), spec).await;
            }
            let (entered_tx, entered) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let probe = Arc::new(Probe {
                disk: DiskLogFile::new(path.clone()),
                appends: Mutex::new(Vec::new()),
                count: AtomicUsize::new(0),
                gated: Mutex::new(false),
                entered: Mutex::new(entered_tx),
                release: Mutex::new(release_rx),
                fault: scenario.get("fault").map(|f| (f["append"].as_u64().unwrap() as usize, f["writes"].as_bool().unwrap())),
            });
            let ticks = Arc::new(AtomicI64::new(base));
            let clock: Clock = {
                let ticks = ticks.clone();
                Arc::new(move || ticks.fetch_add(1, SeqCst))
            };
            let rows = Arc::new(Mutex::new(Vec::<String>::new()));
            let stderr: StderrSink = {
                let rows = rows.clone();
                Arc::new(move |text| locked(&rows).push(text.to_owned()))
            };
            let log = DaemonLog::with_parts(probe.clone(), tokens().maintenance_io, CancellationToken::new(), clock, stderr);
            let mut held = None;
            // Node writes 10 ms after a line, so lines logged back to back share one append. The
            // inline test lane would drain each line at once; refusing the drainer keeps them queued
            // until the flush, which is the same window.
            let mut window = Some(mixdog_rt::testing::refuse_jobs_on_this_thread());
            for op in scenario["ops"].as_array().unwrap() {
                match op["op"].as_str().unwrap() {
                    "log" => {
                        let text = build(&op["parts"]);
                        if *locked(&probe.gated) && held.is_none() {
                            // The first write blocks inside the drain, on whichever thread ran it.
                            let log = log.clone();
                            held = Some(std::thread::spawn(move || log.log(&text)));
                        } else {
                            log.log(&text);
                        }
                    }
                    "enable" => log.enable_file_logging(),
                    "raw" => log.raw(op["chunk"].as_str().unwrap()),
                    "gate" => *locked(&probe.gated) = true,
                    "held" => entered.recv_timeout(Duration::from_secs(30)).unwrap(),
                    "release" => release_tx.send(()).unwrap(),
                    "flush" => {
                        window = None;
                        log.flush().await;
                        window = Some(mixdog_rt::testing::refuse_jobs_on_this_thread());
                    }
                    other => panic!("unknown op {other}"),
                }
            }
            drop(window);
            if let Some(thread) = held {
                thread.join().unwrap();
            }
            log.flush().await;

            let appends: Vec<Append> = scenario["appends"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| Append {
                    bytes: a["bytes"].as_u64().unwrap() as usize,
                    lines: a["lines"].as_u64().unwrap() as usize,
                    notice: a["notice"].as_str().map(str::to_owned),
                })
                .collect();
            assert_eq!(*locked(&probe.appends), appends, "{name}: writes");
            let stderr_rows: Vec<String> = scenario["stderrRows"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
            assert_eq!(*locked(&rows), stderr_rows, "{name}: stderr");
            let bytes = mixdog_statefile::read_content(&path).unwrap().unwrap_or_default();
            assert_eq!(bytes.len() as u64, scenario["fileBytes"].as_u64().unwrap(), "{name}: file size");
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), scenario["fileSha256"].as_str().unwrap(), "{name}: file digest");
            assert_eq!(bytes.first().map(|b| u64::from(*b)), scenario["firstByte"].as_u64(), "{name}: first byte");
            if let Some(text) = scenario["fileText"].as_str() {
                assert_eq!(String::from_utf8_lossy(&bytes), text, "{name}: file text");
            }
        }
    }

    /// Lines from many threads all land, each thread's in its own order.
    #[tokio::test]
    async fn concurrent_lines_land_once_and_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let log = DaemonLog::new(path.clone(), tokens().maintenance_io, CancellationToken::new());
        log.enable_file_logging();
        let threads: Vec<_> = (0..4)
            .map(|t| {
                let log = log.clone();
                std::thread::spawn(move || (0..50).for_each(|i| log.log(&format!("t{t} n{i}"))))
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        log.flush().await;
        let text = String::from_utf8(mixdog_statefile::read_content(&path).unwrap().unwrap()).unwrap();
        let mut seen: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for line in text.lines() {
            let (_, tail) = line.split_once("[daemon] ").unwrap();
            let (thread, n) = tail.split_once(" n").unwrap();
            seen.entry(thread.to_owned()).or_default().push(n.parse().unwrap());
        }
        assert_eq!(seen.len(), 4);
        for (thread, order) in seen {
            assert_eq!(order, (0..50).collect::<Vec<_>>(), "{thread}");
        }
    }

    /// A cancelled run leaves its drainer unstarted; flush returns instead of waiting on it.
    #[tokio::test]
    async fn flush_returns_when_the_lane_drops_the_drainer() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let log = DaemonLog::new(dir.path().join("daemon.log"), tokens().maintenance_io, cancel);
        log.enable_file_logging();
        log.log("never written");
        tokio::time::timeout(Duration::from_secs(10), log.flush()).await.expect("flush must not hang");
    }
}
