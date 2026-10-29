// Event emission, retention pruning, timeouts, pipe pumping and capture
// file handling for managed processes.

use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;

/// One item for the stdout writer: a line, or a marker it acknowledges once
/// everything queued before it was written (drain_output).
enum Out {
    Line(String),
    Drained(mpsc::Sender<()>),
}

/// The queue to the one thread that writes stdout (start_writer). Unbounded,
/// so an enqueue never waits on the client: an event emitted inside a
/// state-lock hold keeps transition order without ever blocking the hold.
/// Only ever locked for a non-blocking send.
static OUT: Mutex<Option<mpsc::Sender<Out>>> = Mutex::new(None);
/// Bytes queued and not yet written.
static QUEUED_BYTES: AtomicUsize = AtomicUsize::new(0);
/// Stream output (emit_output) waits while more than this is queued, as it
/// waited on a full stdout pipe when it wrote stdout itself: a fast command
/// with a slow client does not grow the queue without bound.
const OUTPUT_HIGH_WATER: usize = 8 * 1024 * 1024;

fn start_writer(mut sink: impl Write + Send + 'static) -> mpsc::Sender<Out> {
    let (queue, items) = mpsc::channel::<Out>();
    thread::spawn(move || {
        for item in items {
            match item {
                Out::Line(line) => {
                    let _ = writeln!(sink, "{line}");
                    let _ = sink.flush();
                    QUEUED_BYTES.fetch_sub(line.len(), Ordering::AcqRel);
                }
                Out::Drained(ack) => {
                    let _ = ack.send(());
                }
            }
        }
    });
    queue
}

fn enqueue(item: Out) {
    let mut out = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let queue = out.get_or_insert_with(|| start_writer(std::io::stdout()));
    let _ = queue.send(item);
}

/// Every emission: a non-blocking enqueue for the stdout writer.
pub(crate) fn emit(value: &serde_json::Value) {
    let line = value.to_string();
    QUEUED_BYTES.fetch_add(line.len(), Ordering::AcqRel);
    enqueue(Out::Line(line));
}

/// A command's stream output (pump_pipe, which holds no lock here): first
/// waits while the queue is past OUTPUT_HIGH_WATER.
pub(crate) fn emit_output(value: &serde_json::Value) {
    while QUEUED_BYTES.load(Ordering::Acquire) > OUTPUT_HIGH_WATER {
        thread::sleep(Duration::from_millis(2));
    }
    emit(value);
}

/// Wait up to `within` for everything queued so far to be written (shutdown:
/// a client that stopped reading cannot hold the exit).
pub(crate) fn drain_output(within: Duration) -> bool {
    let (ack, acked) = mpsc::channel();
    enqueue(Out::Drained(ack));
    acked.recv_timeout(within).is_ok()
}

/// Tests: the writer from here on writes to `sink`.
#[cfg(all(windows, test))]
pub(crate) fn replace_writer(sink: impl Write + Send + 'static) {
    *OUT.lock().unwrap_or_else(|e| e.into_inner()) = Some(start_writer(sink));
}

/// The snapshot is taken and its event queued in one state-lock hold, so it
/// is ordered with the tree events.
pub(crate) fn emit_task(id: u64, event: &str, managed: &ManagedProcess) {
    let state = managed.lock_state();
    if let Some(task) = state.snapshot(managed.request_id, managed.pid) {
        emit(&json!({ "id": id, "event": event, "task": task }));
    }
}

// Retained (promoted / background) tasks stay queryable after they finish, so
// the jobs map only ever grew: a long-lived daemon accumulated one entry per
// command for its whole life. Clients release explicitly (releaseTask), and
// this cap is the backstop for clients that never do. FINISHED jobs are
// dropped oldest-first; a live job is never pruned.
pub(crate) const RETAINED_JOB_LIMIT: usize = 256;

pub(crate) fn prune_retained_jobs(manager: &Arc<Manager>) {
    let mut jobs = manager.lock_jobs();
    if jobs.len() <= RETAINED_JOB_LIMIT {
        return;
    }
    let excess = jobs.len() - RETAINED_JOB_LIMIT;
    let mut finished: Vec<(u64, String)> = jobs
        .iter()
        .filter(|(_, managed)| managed.done.load(Ordering::Acquire))
        .map(|(job_id, managed)| {
            let finished_at = managed
                .state
                .lock()
                .ok()
                .and_then(|state| state.finished_at_ms)
                .unwrap_or(0);
            (finished_at, job_id.clone())
        })
        .collect();
    finished.sort_by_key(|(finished_at, _)| *finished_at);
    for (_, job_id) in finished.into_iter().take(excess) {
        jobs.remove(&job_id);
        emit(&json!({ "id": 0, "event": "task_released", "jobId": job_id }));
    }
}

pub(crate) fn arm_timeout(managed: Arc<ManagedProcess>, timeout_ms: u64) {
    if timeout_ms == 0 {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(timeout_ms));
        let mut state = managed.lock_state();
        if state.status == "running" && kill_running(&managed, &mut state) {
            state.timed_out = true;
            state.error = Some(format!("timed out after {timeout_ms} ms"));
        }
    });
}

/// The kill of a command over its output cap, under its state lock (`state`,
/// `killed` and the error already recorded). A contained command's only while
/// it runs (kill_running: never its kept survivors); an uncontained one's
/// process group / job as before, even after its root exited.
pub(crate) fn kill_over_cap(managed: &ManagedProcess, state: &mut TaskState) {
    if state.contained {
        kill_running(managed, state);
    } else {
        managed.terminate();
    }
}

pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let bits = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((bits >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(bits & 0x3f) as usize] as char);
        index += 3;
    }
    match bytes.len() - index {
        1 => {
            let bits = (bytes[index] as u32) << 16;
            out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let bits = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
            out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

pub(crate) fn pump_pipe(
    id: u64,
    kind: &'static str,
    mut pipe: impl Read,
    managed: Arc<ManagedProcess>,
    stream: bool,
    raw_output: bool,
) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let exceeded = managed
                    .state
                    .lock()
                    .map(|mut state| state.append(kind, &buf[..n]))
                    .unwrap_or(false);
                if stream {
                    if raw_output {
                        emit_output(&json!({
                            "id": id,
                            "event": kind,
                            "dataBase64": encode_base64(&buf[..n]),
                        }));
                    } else {
                        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                        emit_output(&json!({ "id": id, "event": kind, "text": text }));
                    }
                }
                if exceeded {
                    let mut state = managed.lock_state();
                    state.killed = true;
                    state.error = Some(format!("output exceeded {} byte cap", state.output_limit));
                    kill_over_cap(&managed, &mut state);
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

pub(crate) fn spawn_error(id: u64, error: impl std::fmt::Display) {
    emit(&json!({
        "id": id,
        "event": "error",
        "message": error.to_string(),
    }));
}

pub(crate) fn spawn_io_error(id: u64, error: std::io::Error) {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::WouldBlock => "EAGAIN",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::TimedOut => "ETIMEDOUT",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        _ => "EIO",
    };
    emit(&json!({
        "id": id,
        "event": "error",
        "code": code,
        "message": error.to_string(),
    }));
}

// Open the caller's capture files in append mode. BOTH must open for file
// capture to engage; a half-open pair falls back to pipes so a command never
// fails over capture plumbing alone.
pub(crate) fn open_capture_files(
    stdout_path: Option<&str>,
    stderr_path: Option<&str>,
) -> Option<(File, File)> {
    let out_path = stdout_path.filter(|path| !path.is_empty())?;
    let err_path = stderr_path.filter(|path| !path.is_empty())?;
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(out_path)
        .ok()?;
    let err = OpenOptions::new()
        .create(true)
        .append(true)
        .open(err_path)
        .ok()?;
    Some((out, err))
}

// Last `limit` bytes of a capture file, with its current size. Errors read as
// "nothing yet": a capture file that cannot be stat'd or opened must never
// take down the command it belongs to.
pub(crate) fn read_capture_tail(path: &str, limit: usize) -> (u64, Vec<u8>) {
    let size = match metadata(path) {
        Ok(meta) => meta.len(),
        Err(_) => return (0, Vec::new()),
    };
    if size == 0 {
        return (0, Vec::new());
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return (size, Vec::new()),
    };
    let want = limit as u64;
    let start = size.saturating_sub(want);
    if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
        return (size, Vec::new());
    }
    let mut buf = Vec::new();
    if file.take(want).read_to_end(&mut buf).is_err() {
        return (size, Vec::new());
    }
    (size, buf)
}

// File capture has no pump thread, so byte counts and the preview tails that
// completion envelopes render come from the files themselves. Returns true
// when the output cap is now exceeded — the same verdict pump_pipe reaches
// per chunk on the pipe path — and then, with `kill`, kills the command in the
// same hold.
pub(crate) fn refresh_capture_state(
    managed: &ManagedProcess,
    stdout_path: &str,
    stderr_path: &str,
    kill: bool,
) -> bool {
    let (out_bytes, out_tail) = read_capture_tail(stdout_path, TAIL_LIMIT);
    let (err_bytes, err_tail) = read_capture_tail(stderr_path, TAIL_LIMIT);
    match managed.state.lock() {
        Ok(mut state) => {
            state.stdout_bytes = out_bytes;
            state.stderr_bytes = err_bytes;
            state.stdout_tail = out_tail;
            state.stderr_tail = err_tail;
            let limit = state.output_limit as u64;
            if out_bytes.saturating_add(err_bytes) > limit && state.status == "running" {
                state.killed = true;
                state.error = Some(format!("output exceeded {} byte cap", state.output_limit));
                if kill {
                    kill_over_cap(managed, &mut state);
                }
                return true;
            }
            false
        }
        Err(_) => false,
    }
}

pub(crate) fn arm_output_size_watchdog(
    managed: Arc<ManagedProcess>,
    stdout_path: String,
    stderr_path: String,
) {
    thread::spawn(move || loop {
        if managed.done.load(Ordering::Acquire) {
            return;
        }
        if refresh_capture_state(&managed, &stdout_path, &stderr_path, true) {
            return;
        }
        thread::sleep(Duration::from_millis(SIZE_WATCHDOG_INTERVAL_MS));
    });
}
