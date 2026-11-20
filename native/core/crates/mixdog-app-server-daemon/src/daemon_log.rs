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
//!
//! The rotation rewrite goes through the atomic publisher instead of `writeFileSync` truncation:
//! the resulting bytes are the same.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
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

/// The topic logs this module keeps beside `daemon.log`, with the stderr prefix of the lines each takes
/// (`scheduler.mjs` `logSchedule`, `webhook/log.mjs` `logWebhook`).
pub const TOPIC_LOGS: [(&str, &str); 2] = [("schedule.log", "mixdog scheduler: "), ("webhook.log", "mixdog webhook: ")];

/// `rotateWorkerLogs` (`worker-bootstrap.mjs`): at start a topic log over 10 MiB is renamed to `<name>.1`, replacing the previous one.
pub fn rotate_topic_logs(lane: &InLane<MaintenanceIo>, data_dir: &std::path::Path) {
    for (name, _) in TOPIC_LOGS {
        let path = data_dir.join(name);
        if mixdog_statefile::metadata(lane, &path).is_ok_and(|meta| meta.len() > LOG_MAX_BYTES) {
            let _ = mixdog_statefile::rename_with_retry(lane, &path, &data_dir.join(format!("{name}.1")));
        }
    }
}

/// Attaches `<data>/schedule.log` and `<data>/webhook.log` to `log` and rotates the oversized ones, off the caller's thread.
pub fn attach_topic_logs(log: &DaemonLog, data_dir: &std::path::Path, lane: MaintenanceIo, cancel: &CancellationToken) {
    let dir = data_dir.to_path_buf();
    let _ = lane.submit(cancel, move |lane| rotate_topic_logs(lane, &dir));
    for (name, prefix) in TOPIC_LOGS {
        log.attach_topic_log(prefix, DaemonLog::new(data_dir.join(name), lane, cancel.clone()));
    }
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
    /// The memory worker's log (`memory-runtime-proxy.log`), flushed with this one.
    memory: Mutex<Option<DaemonLog>>,
    /// The topic logs (`schedule.log`, `webhook.log`): a Daemon stderr line starting with the prefix is also appended to its log.
    topics: Mutex<Vec<(&'static str, DaemonLog)>>,
}

/// The daemon log. Cloning shares the queue.
#[derive(Clone)]
pub struct DaemonLog {
    shared: Arc<Shared>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Epoch milliseconds of the system clock: what the log stamps its lines with.
pub fn system_now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
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

/// Boot marks made before file logging starts, written to the file when it does ([`DaemonLog::enable_file_logging`]).
static BOOT_MARKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

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

/// The two lines `announceDaemonReady` logs once the redirect is installed (daemon.mjs:856-857): the ready line (`ms` as `toFixed(0)`) and the profiler's `daemon-ready` mark
/// (`totalMs` rounded to one decimal, printed as a JS number: no `.0`).
pub fn ready_lines(port: u16, pid: u32, ms: f64) -> [String; 2] {
    [format!("ready port={port} pid={pid} in {ms:.0}ms"), format!("boot-phase phase=daemon-ready status=mark totalMs={}", (ms * 10.0).round() / 10.0)]
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
                memory: Mutex::new(None),
                topics: Mutex::new(Vec::new()),
            }),
        }
    }

    /// `enableFileLogging`: from the next line on, the file has the log and stderr none of it.
    pub fn enable_file_logging(&self) {
        locked(&self.shared.state).file_logging = true;
        // The boot's marks before this went to stderr only, which nothing keeps: they go to the file now, in order.
        let held = std::mem::take(&mut *BOOT_MARKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
        for line in held {
            self.append(&line);
        }
    }

    /// A boot step's mark: `boot-phase phase=<phase> status=mark totalMs=<ms since the first mark>`, so a slow start shows
    /// which step held it (the start had only its `daemon-ready` total before).
    pub fn boot_mark(&self, phase: &str) {
        static BOOT_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let start = *BOOT_START.get_or_init(std::time::Instant::now);
        let line = format!("boot-phase phase={phase} status=mark totalMs={}", start.elapsed().as_millis());
        if !locked(&self.shared.state).file_logging {
            let mut held = BOOT_MARKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if held.len() < 256 {
                held.push(format!("[daemon] {line}"));
            }
        }
        self.log(&line);
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

    /// `console.warn(line)` once `installRedirect` has run (the daemon's): `[console.warn] <line>`, the
    /// line bounded as the redirect bounds an argument, then as any log line, without the `[daemon]` tag
    /// (`fixtures/console-redirect/golden.json`, from the real redirect).
    pub fn console_warn(&self, line: &str) {
        self.console("warn", line);
    }

    /// `console.<method>(line)` once `installRedirect` has run, as [`Self::console_warn`] for any method.
    pub fn console(&self, method: &str, line: &str) {
        self.raw(&format!("[console.{method}] {}", bounded_text(line)));
    }

    /// The memory worker's stderr: `memory-runtime-proxy.log`, which the daemon's proxy appends `[<ISO>] <chunk>` rows to.
    /// `memory` is flushed whenever this log is.
    pub fn attach_memory_log(&self, memory: DaemonLog) {
        *locked(&self.shared.memory) = Some(memory);
    }

    /// `logSchedule` / `logWebhook` (`scheduler.mjs`, `webhook/log.mjs`): the scheduler and the webhook listener write each line to
    /// their stderr as `<prefix><msg>` and to their own file as `[<ISO>] <msg>`, whatever the stderr redirect. The Rust services emit
    /// the stderr line; this appends `<msg>` to `topic` (`<data>/schedule.log`, `<data>/webhook.log`) for every line with `prefix`.
    pub fn attach_topic_log(&self, prefix: &'static str, topic: DaemonLog) {
        locked(&self.shared.topics).push((prefix, topic));
    }

    /// The topic logs a Daemon stderr line belongs to, written off the caller (the lane drains them).
    fn route_topics(&self, line: &str) {
        for (prefix, topic) in locked(&self.shared.topics).iter() {
            if let Some(message) = line.strip_prefix(prefix) {
                topic.append(message);
            }
        }
    }

    /// Where the lines Node writes to its stderr go once the daemon runs (`mixdog_rt::node_log`): what `installRedirect`
    /// does with a `process.stderr.write` chunk or a `console` call, and the memory worker's stderr mirror.
    pub fn node_sink(&self) -> mixdog_rt::node_log::Sink {
        use mixdog_rt::node_log::Origin;
        let daemon = self.clone();
        let memory = locked(&self.shared.memory).clone().unwrap_or_else(|| self.clone());
        Arc::new(move |origin, channel, line| {
            if origin == Origin::Daemon {
                daemon.route_topics(line);
            }
            match (origin, channel.console_method()) {
                (Origin::MemoryWorker, _) => memory.raw(line),
                (Origin::Daemon, Some(method)) => daemon.console(method, line),
                (Origin::Daemon, None) => daemon.raw(line),
            }
        })
    }

    /// The destination of Node stderr lines while the daemon's own stderr is not redirected (before ready, and for good under
    /// `MIXDOG_DAEMON_ALLOW_STDERR=1`): the memory worker's stderr is a pipe the spawner mirrors into its proxy log whatever the daemon's
    /// readiness (`daemon-spawn.mjs:108-116`), and every daemon line is written bare to the descriptor.
    pub fn memory_sink(&self) -> mixdog_rt::node_log::Sink {
        use mixdog_rt::node_log::Origin;
        let daemon = self.clone();
        let memory = locked(&self.shared.memory).clone().unwrap_or_else(|| self.clone());
        Arc::new(move |origin, _, line| match origin {
            Origin::MemoryWorker => memory.raw(line),
            Origin::Daemon => {
                daemon.route_topics(line);
                (daemon.shared.stderr)(&mixdog_rt::node_log::bare(line));
            }
        })
    }

    /// `console_warn` as a seam a `Fn(&str)` consumer takes.
    pub fn console_warn_sink(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        let log = self.clone();
        Arc::new(move |line| log.console_warn(line))
    }

    /// `ResumeLog` for the quota-resume scheduler, and any other `Fn(&str)` log seam.
    pub fn line_log(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        let log = self.clone();
        Arc::new(move |line| log.log(line))
    }

    /// `flush`: returns once every line logged before the call is written (or lost to a failed
    /// write). A lane that refuses the drainer leaves the lines queued for the next line's try.
    pub async fn flush(&self) {
        let memory = locked(&self.shared.memory).clone();
        self.flush_own().await;
        if let Some(memory) = memory {
            memory.flush_own().await;
        }
        // The topic logs (`schedule.log`, `webhook.log`) are not waited for: Node appended them without awaiting anything at exit,
        // and a stuck write there must never hold the shutdown (its 5 s wait and 15 s backstop). A normal run still gets its lines
        // written in order by their own drainer.
    }

    /// Returns once every topic line logged before the call is written. Not part of [`Self::flush`], so no exit waits for it.
    #[cfg(test)]
    async fn flush_topics(&self) {
        let topics: Vec<DaemonLog> = locked(&self.shared.topics).iter().map(|(_, topic)| topic.clone()).collect();
        for topic in topics {
            topic.flush_own().await;
        }
    }

    async fn flush_own(&self) {
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
                guard.shared.take();
            })
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::mpsc;
    use std::time::Duration;


    use super::*;

    fn tokens() -> mixdog_rt::LaneTokens {
        mixdog_rt::testing::tokens()
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

    /// Scheduler and webhook stderr lines also land in `schedule.log` / `webhook.log` as `[<ISO>] <msg>` (the prefix dropped), before
    /// and after ready and under the stderr opt-out, and an oversized file is renamed to `<name>.1` at start (`rotateWorkerLogs`).
    #[tokio::test]
    async fn scheduler_and_webhook_lines_are_appended_to_their_own_files() {
        use mixdog_rt::node_log::Channel::Stderr;
        use mixdog_rt::node_log::Origin::Daemon;
        let dir = tempfile::tempdir().unwrap();
        let big = vec![b'x'; LOG_MAX_BYTES as usize + 1];
        mixdog_fsio::write(&mixdog_fsio::Unlaned, dir.path().join("schedule.log"), &big).unwrap();
        let sink: StderrSink = Arc::new(|_| {});
        let log = DaemonLog::with_parts(Arc::new(DiskLogFile::new(dir.path().join("daemon.log"))), tokens().maintenance_io, CancellationToken::new(), Arc::new(system_now_ms), sink);
        let cancel = CancellationToken::new();
        let lane = tokens().maintenance_io;
        let data = dir.path().to_path_buf();
        let rotated = lane.submit(&cancel, move |lane| rotate_topic_logs(lane, &data)).unwrap();
        rotated.await.unwrap();
        assert_eq!(mixdog_fsio::metadata(&mixdog_fsio::Unlaned, dir.path().join("schedule.log.1")).unwrap().len(), big.len() as u64);
        assert!(!mixdog_fsio::exists(&mixdog_fsio::Unlaned, dir.path().join("schedule.log")).unwrap());
        attach_topic_logs(&log, dir.path(), lane, &cancel);
        for node in [log.memory_sink(), log.node_sink()] {
            node(Daemon, Stderr, "mixdog scheduler: firing nightly");
            node(Daemon, Stderr, "mixdog webhook: rejected: unknown endpoint x");
            node(Daemon, Stderr, "[other] untouched");
        }
        log.flush().await;
        log.flush_topics().await;
        let read = |name: &str| String::from_utf8(mixdog_statefile::read_content(&dir.path().join(name)).unwrap().unwrap()).unwrap();
        assert_eq!(mask_stamps(&read("schedule.log")), "[<ISO>] firing nightly\n[<ISO>] firing nightly\n");
        assert_eq!(mask_stamps(&read("webhook.log")), "[<ISO>] rejected: unknown endpoint x\n[<ISO>] rejected: unknown endpoint x\n");
    }

    /// A topic log whose write never completes does not hold the exit: `flush` (the shutdown's wait) returns, and the daemon log's
    /// own lines are written.
    #[tokio::test]
    async fn a_topic_write_that_never_completes_does_not_hold_the_flush() {
        use mixdog_rt::node_log::Channel::Stderr;
        use mixdog_rt::node_log::Origin::Daemon;

        // The test lanes run a job inline on the thread that submits it, so the stuck write is driven from a thread of its own:
        // that thread is the lane's worker that never returns, and the test thread is the shutdown that must not wait for it.
        struct Stuck(Mutex<mpsc::Receiver<()>>, Mutex<mpsc::Sender<()>>);
        impl LogFile for Stuck {
            fn size(&self, _: &InLane<MaintenanceIo>) -> io::Result<u64> {
                Ok(0)
            }
            fn append(&self, _: &InLane<MaintenanceIo>, _: &[u8]) -> io::Result<()> {
                let _ = locked(&self.1).send(());
                let _ = locked(&self.0).recv();
                Ok(())
            }
            fn read_tail(&self, _: &InLane<MaintenanceIo>, _: u64, _: usize) -> io::Result<Vec<u8>> {
                Ok(Vec::new())
            }
            fn replace(&self, _: &InLane<MaintenanceIo>, _: &[u8]) -> io::Result<()> {
                Ok(())
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let (release, stuck) = mpsc::channel();
        let (started_tx, started) = mpsc::channel();
        let sink: StderrSink = Arc::new(|_| {});
        let log = DaemonLog::with_parts(Arc::new(DiskLogFile::new(dir.path().join("daemon.log"))), tokens().maintenance_io, CancellationToken::new(), Arc::new(system_now_ms), sink.clone());
        log.attach_topic_log("mixdog scheduler: ", DaemonLog::with_parts(Arc::new(Stuck(Mutex::new(stuck), Mutex::new(started_tx))), tokens().maintenance_io, CancellationToken::new(), Arc::new(system_now_ms), sink));
        log.enable_file_logging();
        let emitting = log.node_sink();
        let worker = std::thread::spawn(move || emitting(Daemon, Stderr, "mixdog scheduler: stuck"));
        started.recv().expect("the topic write started");
        log.log("daemon line");
        let flushed = mixdog_rt::time::timeout(Duration::from_secs(5), log.flush()).await;
        drop(release);
        worker.join().unwrap();
        assert!(flushed.is_ok(), "the flush waited for the stuck topic write");
        assert!(mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, dir.path().join("daemon.log")).unwrap().contains("[daemon] daemon line"));
    }

    /// The `[<ISO>] ` stamps of `text` replaced by `[<ISO>] `, each checked for the exact `toISOString` shape first.
    fn mask_stamps(text: &str) -> String {
        let shape = b"dddd-dd-ddTdd:dd:dd.dddZ";
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = if rest.starts_with('[') { Some(0) } else { rest.find("\n[").map(|i| i + 1) } {
            out.push_str(&rest[..at]);
            let body = &rest[at + 1..];
            let stamped = body.len() > 26
                && body.as_bytes()[..24].iter().zip(shape).all(|(b, s)| if *s == b'd' { b.is_ascii_digit() } else { b == s })
                && &body[24..26] == "] ";
            if stamped {
                out.push_str("[<ISO>] ");
                rest = &body[26..];
            } else {
                out.push('[');
                rest = body;
            }
        }
        out.push_str(rest);
        out
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
        mixdog_rt::time::timeout(Duration::from_secs(10), log.flush()).await.expect("flush must not hang");
    }


}
