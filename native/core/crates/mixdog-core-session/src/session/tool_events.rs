//! The close metric of `<data>/tool-events.log` (`lifecycle-barriers.mjs:_logSessionCloseMetric`
//! through `createAsyncLogAppender`): `append` only queues the line; one drain per file writes the
//! batch on a maintenance-lane job, and once the file would pass its cap it is cut down to its
//! last `KEEP` bytes (whole lines) before the next batch lands. Best effort: a failed write drops
//! its batch and never fails the close.

use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::TaskClass;
use mixdog_statefile::Opts;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::Clock;

/// `PLUGIN_LOG_MAX_BYTES` and `PLUGIN_LOG_KEEP_BYTES` (`mixdog-debug.cjs`).
const MAX_BYTES: u64 = 10 * 1024 * 1024;
const KEEP_BYTES: u64 = 2 * 1024 * 1024;
/// A wedged disk must not turn the queue into a memory leak.
const MAX_QUEUED_LINES: usize = 4096;
/// Other processes append to the same file; re-measure now and then.
const RESTAT_EVERY_DRAINS: u64 = 256;

#[derive(Default)]
struct Queue {
    lines: VecDeque<String>,
    /// The file's last known size.
    bytes: Option<u64>,
    drains: u64,
    running: bool,
    /// Woken when a drain ends with nothing left to write.
    #[cfg(test)]
    drained: Arc<tokio::sync::Notify>,
}

pub struct ToolEventsLog {
    path: PathBuf,
    io: MaintenanceIo,
    clock: Arc<dyn Clock>,
    queue: Arc<Mutex<Queue>>,
}

fn lock(queue: &Mutex<Queue>) -> MutexGuard<'_, Queue> {
    queue.lock().unwrap_or_else(|e| e.into_inner())
}

fn measure(lane: &InLane<MaintenanceIo>, path: &Path) -> u64 {
    mixdog_statefile::metadata(lane, path).map_or(0, |meta| meta.len())
}

/// Cuts the file to its last `KEEP_BYTES`, from a line boundary; returns the size left.
fn rotate(lane: &InLane<MaintenanceIo>, path: &Path) -> std::io::Result<u64> {
    let buffer = mixdog_statefile::read_content(path)?.unwrap_or_default();
    if buffer.len() as u64 <= MAX_BYTES {
        return Ok(buffer.len() as u64);
    }
    let mut tail = &buffer[buffer.len() - KEEP_BYTES as usize..];
    if let Some(newline) = tail.iter().position(|&b| b == b'\n')
        && newline + 1 < tail.len()
    {
        tail = &tail[newline + 1..];
    }
    mixdog_statefile::write_file(lane, path, tail, &Opts::default()).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(tail.len() as u64)
}

/// One batch (`drain`'s loop body): the new known size, or the failure.
fn write_batch(lane: &InLane<MaintenanceIo>, path: &Path, known: Option<u64>, restat: bool, chunk: &str) -> std::io::Result<u64> {
    let mut bytes = match known {
        Some(bytes) if !restat => bytes,
        _ => measure(lane, path),
    };
    let size = chunk.len() as u64;
    if bytes + size > MAX_BYTES {
        bytes = measure(lane, path);
        if bytes + size > MAX_BYTES {
            bytes = rotate(lane, path)?;
        }
    }
    mixdog_statefile::append_file(lane, path, chunk.as_bytes())?;
    Ok(bytes + size)
}

impl ToolEventsLog {
    pub fn new(data_dir: &Path, io: MaintenanceIo, clock: Arc<dyn Clock>) -> Self {
        Self { path: data_dir.join("tool-events.log"), io, clock, queue: Arc::new(Mutex::new(Queue::default())) }
    }

    /// `_logSessionCloseMetric(id, existing, closedAt, reason)`: the close of a session whose
    /// stored `header` is `existing`, landed at `closed_at_ms`. Called once the tombstone write
    /// was acknowledged: the line is stamped now, its `lifeMs` ends at the close.
    pub fn session_closed(&self, id: &str, header: &Header, reason: &str, closed_at_ms: i64) {
        let text = |key: &str| {
            header.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or("-").to_owned()
        };
        let created = header.get("createdAt").and_then(Value::as_f64).filter(|created| *created > 0.0);
        let life_ms = created.map_or(0.0, |created| closed_at_ms as f64 - created);
        let ts = mixdog_agent::agent_tool::stamp::iso_from_ms(self.clock.now_ms());
        self.append(format!(
            "[{ts}] [session-close] owner={} agent={} reason={reason} lifeMs={} id={id}\n",
            text("owner"),
            text("agent"),
            mixdog_js::number_to_string(life_ms),
        ));
    }

    fn append(&self, line: String) {
        let start = {
            let mut queue = lock(&self.queue);
            queue.lines.push_back(line);
            if queue.lines.len() > MAX_QUEUED_LINES {
                queue.lines.pop_front();
            }
            !std::mem::replace(&mut queue.running, true)
        };
        if start {
            let (path, io, queue) = (self.path.clone(), self.io, self.queue.clone());
            drop(mixdog_rt::spawn("tool-events-log", TaskClass::Work, drain(path, io, queue)));
        }
    }

    /// Resolves once everything queued so far has been written (or dropped).
    #[cfg(test)]
    pub async fn flush(&self) {
        let drained = lock(&self.queue).drained.clone();
        loop {
            let idle = drained.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if !lock(&self.queue).running {
                return;
            }
            idle.await;
        }
    }
}

async fn drain(path: PathBuf, io: MaintenanceIo, queue: Arc<Mutex<Queue>>) {
    let mut restat = {
        let mut state = lock(&queue);
        state.drains += 1;
        state.drains % RESTAT_EVERY_DRAINS == 0
    };
    loop {
        let (chunk, known) = {
            let mut state = lock(&queue);
            if state.lines.is_empty() {
                state.running = false;
                #[cfg(test)]
                state.drained.notify_waiters();
                return;
            }
            (state.lines.drain(..).collect::<String>(), state.bytes)
        };
        let target = path.clone();
        let wrote = match io.submit(&CancellationToken::new(), move |lane| write_batch(lane, &target, known, restat, &chunk)) {
            Ok(job) => job.await.ok().and_then(Result::ok),
            Err(_) => None,
        };
        restat = false;
        let mut state = lock(&queue);
        state.bytes = wrote;
        if wrote.is_none() {
            state.lines.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct At(i64);
    impl Clock for At {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    /// Lays `text` at `path` (its directories made) the way the daemon writes: on the lane.
    async fn put(path: &Path, text: &str) {
        let (path, text) = (path.to_owned(), text.to_owned());
        let io = mixdog_rt::testing::tokens().maintenance_io;
        io.submit(&CancellationToken::new(), move |lane| mixdog_statefile::append_file(lane, &path, text.as_bytes()).unwrap()).unwrap().await.unwrap();
    }

    fn text_of(path: &Path) -> String {
        String::from_utf8(mixdog_statefile::read_content(path).unwrap().unwrap()).unwrap()
    }

    fn log_at(dir: &Path, now: i64) -> ToolEventsLog {
        ToolEventsLog::new(dir, mixdog_rt::testing::tokens().maintenance_io, Arc::new(At(now)))
    }

    /// `lifecycle-barriers.mjs:_logSessionCloseMetric` as Node wrote it for each close of the
    /// recording (`record-shell-job-actions.mjs`): the `owner`/`agent` `-` when the record has
    /// none, `lifeMs` 0 without a creation time. Re-closing a tombstone writes no line, so no
    /// close reaches the log then.
    #[tokio::test]
    async fn a_close_appends_the_session_close_line_as_node_wrote_it() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/shell-job-actions/shell-job-actions.json")).expect("golden");
        let temp = tempfile::tempdir().unwrap();
        // The recorder froze Node's clock at this instant.
        let log = log_at(temp.path(), 1_767_323_045_678);
        let mut want = String::new();
        for close in golden["closes"].as_array().unwrap() {
            let line = close["line"].as_str().unwrap();
            if line.is_empty() {
                continue;
            }
            let Value::Object(header) = close["record"].clone() else { unreachable!() };
            log.session_closed(close["record"]["id"].as_str().unwrap(), &header, close["reason"].as_str().unwrap(), 1_767_323_045_678);
            want.push_str(line);
        }
        assert_eq!(want.lines().count(), 4);
        log.flush().await;
        assert_eq!(text_of(&temp.path().join("tool-events.log")), want);
    }

    /// `markSessionClosed` reads `closeTime` when the close lands and logs after the tombstone
    /// write is acknowledged: the line carries the time of the log, and `lifeMs` runs to the close.
    #[tokio::test]
    async fn the_line_is_stamped_at_the_log_and_its_life_ends_at_the_close() {
        let temp = tempfile::tempdir().unwrap();
        let log = log_at(temp.path(), 1_767_323_050_000);
        let mut header = Header::new();
        header.insert("createdAt".into(), serde_json::json!(1_767_323_000_000_i64));
        log.session_closed("sess_a", &header, "desktop-session-delete", 1_767_323_045_000);
        log.flush().await;
        assert_eq!(
            text_of(&temp.path().join("tool-events.log")),
            "[2026-01-02T03:04:10.000Z] [session-close] owner=- agent=- reason=desktop-session-delete lifeMs=45000 id=sess_a\n"
        );
    }

    /// `createAsyncLogAppender`: a file past its cap is cut to its last `KEEP` bytes from a line
    /// boundary before the next line lands.
    #[tokio::test]
    async fn a_file_past_its_cap_is_cut_to_its_tail_on_a_line_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tool-events.log");
        let line = "x".repeat(99) + "\n";
        put(&path, &line.repeat(MAX_BYTES as usize / line.len() + 1)).await;
        let log = log_at(temp.path(), 1_767_323_045_678);
        log.session_closed("sess_a", &Header::new(), "manual", 1_767_323_045_678);
        log.flush().await;
        let text = text_of(&path);
        assert!(text.len() as u64 <= KEEP_BYTES + 200, "{}", text.len());
        assert!(text.starts_with(&"x".repeat(99)), "starts on a whole line");
        assert!(text.ends_with("lifeMs=0 id=sess_a\n"));
    }
}