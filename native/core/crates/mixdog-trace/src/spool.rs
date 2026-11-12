//! One buffered, rotating JSONL file: Node's `_appendLocalTrace` / `_flushLocalTrace` /
//! `_rotateLocalTraceIfNeeded` (and the same shapes for `tool-failures.jsonl`).

// Sanctioned home of the trace's blocking file work: `flush` runs as a job on a blocking lane
// (see the crate docs), never on RT-C/RT-W.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the trace spool's flush is blocking file I/O run on a blocking lane"
)]

use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

/// Test hooks (feature `flush-probe`) for the spool file at one path: `writing` runs with each chunk just before it is
/// appended (a test holds the flush there), `blocked` runs when a flush finds another flush writing and waits for it.
#[cfg(feature = "flush-probe")]
pub mod flush_probe {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Mutex;

    pub trait Probe: Send + Sync {
        fn blocked(&self);
        fn writing(&self, chunk: &str);
    }

    static PROBES: Mutex<Vec<(PathBuf, Arc<dyn Probe>)>> = Mutex::new(Vec::new());

    pub fn install(path: &Path, probe: Arc<dyn Probe>) {
        PROBES.lock().unwrap_or_else(|poison| poison.into_inner()).push((path.to_path_buf(), probe));
    }

    pub(super) fn get(path: &Path) -> Option<Arc<dyn Probe>> {
        let probes = PROBES.lock().unwrap_or_else(|poison| poison.into_inner());
        probes.iter().find(|(probe_path, _)| probe_path == path).map(|(_, probe)| probe.clone())
    }
}

/// Rotate above this size (Node `_LOCAL_TRACE_MAX_BYTES`).
const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Age after which queued lines are due (Node `_LOCAL_TRACE_FLUSH_MS` / `_TOOL_FAILURE_FLUSH_MS`).
const FLUSH_MS: i64 = 1000;

/// A warn-once stderr line of Node's (`warnAgentOnce(key, message)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    pub key: String,
    pub message: String,
}

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Trace,
    Failures,
}

impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Kind::Trace => "agent-trace",
            Kind::Failures => "tool-failure-log",
        }
    }

    fn spool_warning(self) -> (&'static str, &'static str) {
        match self {
            Kind::Trace => ("local-spool", "local spool failed"),
            Kind::Failures => ("append", "append failed"),
        }
    }

}

struct State {
    lines: Vec<String>,
    first_queued_ms: Option<i64>,
    last_rotate_check_ms: i64,
}

pub(crate) struct Spool {
    path: PathBuf,
    flush_lines: usize,
    keep: usize,
    check_ms: i64,
    rotates: bool,
    kind: Kind,
    state: Mutex<State>,
    /// Held for the whole of a flush: the chunk taken and the append that writes it.
    writing: Mutex<()>,
}

impl Spool {
    /// `rotates` false keeps the file append-only (an explicit trace path).
    pub(crate) fn new(
        path: PathBuf,
        flush_lines: usize,
        keep: usize,
        check_ms: i64,
        rotates: bool,
        kind: Kind,
    ) -> Self {
        Self {
            path,
            flush_lines,
            keep,
            check_ms,
            rotates,
            kind,
            state: Mutex::new(State {
                lines: Vec::new(),
                first_queued_ms: None,
                last_rotate_check_ms: 0,
            }),
            writing: Mutex::new(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    /// Queues one line (without its newline); true when a flush is due.
    pub(crate) fn push(&self, line: &str, now_ms: i64) -> bool {
        let mut state = self.lock();
        state.lines.push(format!("{line}\n"));
        state.first_queued_ms.get_or_insert(now_ms);
        Self::due_of(&state, self.flush_lines, now_ms)
    }

    pub(crate) fn due(&self, now_ms: i64) -> bool {
        Self::due_of(&self.lock(), self.flush_lines, now_ms)
    }

    fn due_of(state: &State, flush_lines: usize, now_ms: i64) -> bool {
        state.lines.len() >= flush_lines
            || state
                .first_queued_ms
                .is_some_and(|first| now_ms - first >= FLUSH_MS)
    }

    fn warning(&self, name: &str, text: &str, error: &std::io::Error) -> Warning {
        Warning {
            key: format!("{}:{name}", self.kind.prefix()),
            message: format!("[{}] {text} ({error})", self.kind.prefix()),
        }
    }

    pub(crate) fn flush(&self, now_ms: i64) -> Vec<Warning> {
        // One write at a time, as Node keeps one in flight: a second flusher that took the next chunk must not reach the
        // file before the chunk ahead of it.
        #[cfg(feature = "flush-probe")]
        if matches!(self.writing.try_lock(), Err(std::sync::TryLockError::WouldBlock)) {
            if let Some(probe) = flush_probe::get(&self.path) {
                probe.blocked();
            }
        }
        let _writing = self.writing.lock().unwrap_or_else(|poison| poison.into_inner());
        let chunk = {
            let mut state = self.lock();
            state.first_queued_ms = None;
            if state.lines.is_empty() {
                return Vec::new();
            }
            std::mem::take(&mut state.lines).concat()
        };
        let mut warnings = Vec::new();
        let (spool_name, spool_text) = self.kind.spool_warning();
        if let Err(error) = ensure_parent(&self.path) {
            warnings.push(self.warning(spool_name, spool_text, &error));
            return warnings;
        }
        if self.rotates {
            warnings.extend(self.maybe_rotate(now_ms));
        }
        #[cfg(feature = "flush-probe")]
        if let Some(probe) = flush_probe::get(&self.path) {
            probe.writing(&chunk);
        }
        if let Err(error) = append(&self.path, chunk.as_bytes()) {
            warnings.push(self.warning(spool_name, spool_text, &error));
        }
        warnings
    }

    /// Stat check at most once per `check_ms` (the first flush always checks).
    fn maybe_rotate(&self, now_ms: i64) -> Option<Warning> {
        let mut state = self.lock();
        if state.last_rotate_check_ms != 0 && now_ms - state.last_rotate_check_ms < self.check_ms {
            return None;
        }
        state.last_rotate_check_ms = now_ms;
        drop(state);
        let size = fs::metadata(&self.path).ok()?.len();
        if size <= MAX_BYTES {
            return None;
        }
        // Both files rotate through `_rotateLocalTraceIfNeeded`, whose one handler warns under the trace's key.
        self.rotate().err().map(|error| Warning {
            key: "agent-trace:local-rotate".to_owned(),
            message: format!("[agent-trace] local rotate failed ({error})"),
        })
    }

    /// `.N-1 -> .N` … `.1 -> .2`, live -> `.1`; the oldest generation is overwritten.
    fn rotate(&self) -> std::io::Result<()> {
        for generation in (1..self.keep).rev() {
            let source = numbered(&self.path, generation);
            if source.exists() {
                fs::rename(&source, numbered(&self.path, generation + 1))?;
            }
        }
        fs::rename(&self.path, numbered(&self.path, 1))
    }
}

fn numbered(path: &Path, generation: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{generation}"));
    PathBuf::from(name)
}

fn ensure_parent(path: &Path) -> std::io::Result<()> {
    let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(());
    };
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(parent)
}

fn append(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    // The mode applies on creation only; Windows ignores POSIX bits.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(bytes)
}
