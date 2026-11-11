//! `history/tool-failures.jsonl`: the host side of Node's failure log. Node's `agent-trace-io.mjs` keeps one
//! module-level buffer per process (`_appendToolFailureRow`: appended at 50 lines or after 1000 ms, flushed
//! by the `beforeExit`/`exit` hooks); here that is one [`FailureWriter`] per data directory, shared by every run
//! of the process, over `mixdog_trace::AgentTrace` (the rows, the file, its rotation and its warnings). A run
//! reports its failed calls through [`RunFailureLog`], which adds the facts only the run's host knows (the
//! thread, the agent, the working directory).

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_agent::env::Clock;
use mixdog_agent::env::FailedCall;
use mixdog_agent::env::ToolFailureLog;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_trace::AgentTrace;
use mixdog_trace::TraceConfig;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `_TOOL_FAILURE_FLUSH_MS`: how long a queued row waits for company before it is written.
const FLUSH_AFTER: Duration = Duration::from_millis(1000);

static WRITERS: OnceLock<Mutex<HashMap<PathBuf, Arc<FailureWriter>>>> = OnceLock::new();

#[derive(Default)]
struct Turn {
    running: bool,
    /// A lane job of the running flush is queued or writing.
    job_live: bool,
    /// The running flush's task was cancelled while its lane job lived: the job's end gives the turn up.
    orphaned: bool,
    /// The flushes asked for while one runs: one more flush, started after they asked, writes what they queued.
    waiting: Vec<tokio::sync::oneshot::Sender<()>>,
}

impl Turn {
    /// Gives the turn up and lets go of the flushes that waited on it, which then take the turn themselves.
    fn give_up(&mut self) {
        self.running = false;
        self.orphaned = false;
        self.waiting.clear();
    }
}

/// The running flush's hold on the turn. Dropped before it finished (its task was cancelled), it gives the turn up, but not
/// before its lane job ended: a job the lane already has still writes its chunk, and the next flush must not overtake it.
struct Running<'a> {
    writer: &'a FailureWriter,
    served: Vec<tokio::sync::oneshot::Sender<()>>,
    finished: bool,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let mut turn = self.writer.turn.lock().unwrap_or_else(PoisonError::into_inner);
            if turn.job_live {
                turn.orphaned = true;
            } else {
                turn.give_up();
            }
        }
    }
}

/// The end of a flush's lane job, whether the lane ran it or dropped it unrun.
struct JobEnd(Arc<Mutex<Turn>>);

impl Drop for JobEnd {
    fn drop(&mut self) {
        let mut turn = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        turn.job_live = false;
        if turn.orphaned {
            turn.give_up();
        }
    }
}

/// The failures file of one data directory.
pub struct FailureWriter {
    trace: Arc<AgentTrace>,
    io: ToolIo,
    clock: Arc<dyn Clock>,
    /// The 1000 ms timer is armed (the first row of a batch arms it; a flush does not need it).
    armed: AtomicBool,
    /// One flush on the lane at a time, in the order they were asked for: the rows of a later chunk never overtake an earlier one,
    /// and a flush asked for meanwhile waits here, never on a lane worker.
    turn: Arc<Mutex<Turn>>,
    /// Test-only: lane jobs submitted, and what a test does on the lane right after a job wrote its chunk.
    #[cfg(test)]
    submitted: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    on_lane: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// `warnAgentOnce`: each warning key is written to stderr once.
    warned: Mutex<HashSet<String>>,
    /// Test-only: told the kind of each record once its rows are in the queue (`with_appended`).
    #[cfg(feature = "test-support")]
    appended: Option<Arc<dyn Fn(&'static str) + Send + Sync>>,
    /// Test-only: the 1000 ms timer is held (it is never started), so queued rows reach the file only through a flush.
    #[cfg(any(feature = "test-support", feature = "replay-controls"))]
    timer_held: bool,
    /// Replay-only (`replay-controls`): the file the held writer reports to, and the rows queued while its timer is held.
    #[cfg(feature = "replay-controls")]
    held_report: Option<(PathBuf, std::sync::atomic::AtomicUsize)>,
}

impl FailureWriter {
    /// The writer of `data_dir`'s failures file, made on first use from the process environment (Node resolves
    /// `MIXDOG_TOOL_FAILURE_LOG_PATH` & co. once, at the first row).
    pub fn for_data_dir(data_dir: &Path, io: ToolIo, clock: Arc<dyn Clock>) -> Arc<Self> {
        let writers = WRITERS.get_or_init(Mutex::default);
        let mut writers = writers.lock().unwrap_or_else(PoisonError::into_inner);
        writers
            .entry(data_dir.to_path_buf())
            .or_insert_with(|| Arc::new(Self::replay_held(Self::new(&TraceConfig::from_env(data_dir, &|name| std::env::var(name).ok(), false), io, clock))))
            .clone()
    }

    /// A build with `replay-controls` (an explicit opt-in: no ordinary build, debug or release, has it) whose environment names a file
    /// in `MIXDOG_FAILURE_FLUSH_HELD` holds the 1000 ms timer of every writer it makes, so a queued row reaches the file only through a
    /// full batch or the exit flush, and writes to that file the number of rows queued while held, after each append: the replay of
    /// `record-tool-failures.mjs` reads it before it stops the core, to know the row is queued and not written.
    #[cfg(feature = "replay-controls")]
    fn replay_held(writer: Self) -> Self {
        match std::env::var_os("MIXDOG_FAILURE_FLUSH_HELD").filter(|value| !value.is_empty()) {
            Some(file) => Self { timer_held: true, held_report: Some((PathBuf::from(file), std::sync::atomic::AtomicUsize::new(0))), ..writer },
            None => writer,
        }
    }

    #[cfg(not(feature = "replay-controls"))]
    fn replay_held(writer: Self) -> Self {
        writer
    }

    pub fn new(config: &TraceConfig, io: ToolIo, clock: Arc<dyn Clock>) -> Self {
        Self {
            trace: Arc::new(AgentTrace::new(config)),
            io,
            clock,
            armed: AtomicBool::new(false),
            turn: Arc::default(),
            #[cfg(test)]
            submitted: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            on_lane: Mutex::new(None),
            warned: Mutex::new(HashSet::new()),
            #[cfg(feature = "test-support")]
            appended: None,
            #[cfg(any(feature = "test-support", feature = "replay-controls"))]
            timer_held: false,
            #[cfg(feature = "replay-controls")]
            held_report: None,
        }
    }

    /// The writer of `data_dir` the process's exit flush ([`flush_all`]) reaches, made as [`FailureWriter::for_data_dir`] makes it
    /// (with `env` for the process environment) but with its 1000 ms timer held: a test sees whether a queued row is written by the
    /// exit flush alone.
    #[cfg(feature = "test-support")]
    pub fn register_with_timer_held(data_dir: &Path, env: &dyn Fn(&str) -> Option<String>, io: ToolIo, clock: Arc<dyn Clock>) -> Arc<Self> {
        let config = TraceConfig::from_env(data_dir, env, false);
        let writer = Arc::new(Self { timer_held: true, ..Self::new(&config, io, clock) });
        let writers = WRITERS.get_or_init(Mutex::default);
        writers.lock().unwrap_or_else(PoisonError::into_inner).insert(data_dir.to_path_buf(), Arc::clone(&writer));
        writer
    }

    /// A writer that tells `appended` the kind of each record (`"tool_failure"`, `"stall_abort"`) as soon as its append has
    /// queued its rows (none when the trace is off), before anything else happens: a test orders the append against other events.
    #[cfg(feature = "test-support")]
    pub fn with_appended(config: &TraceConfig, io: ToolIo, clock: Arc<dyn Clock>, appended: Arc<dyn Fn(&'static str) + Send + Sync>) -> Self {
        Self { appended: Some(appended), ..Self::new(config, io, clock) }
    }

    fn timer_is_held(&self) -> bool {
        #[cfg(any(feature = "test-support", feature = "replay-controls"))]
        return self.timer_held;
        #[cfg(not(any(feature = "test-support", feature = "replay-controls")))]
        false
    }

    /// `replay-controls`: the count of rows queued while held, written whole to the report file (temp file, then rename).
    #[cfg(feature = "replay-controls")]
    fn report_held(&self) {
        if let Some((file, queued)) = &self.held_report {
            let count = queued.fetch_add(1, Ordering::AcqRel) + 1;
            let temp = file.with_extension("tmp");
            if std::fs::write(&temp, count.to_string()).is_ok() {
                let _ = std::fs::rename(&temp, file);
            }
        }
    }

    #[cfg(feature = "test-support")]
    fn tell_appended(&self, kind: &'static str) {
        if let Some(appended) = &self.appended {
            appended(kind);
        }
    }

    /// `traceAgentToolFailure(args)` (the fields are `tool_failure_row`'s): queues the row and starts the flush
    /// that is due, on the durability lane.
    pub fn record(self: &Arc<Self>, args: &Map<String, Value>) {
        let due = self.trace.tool_failure(args, self.clock.now_ms());
        #[cfg(feature = "test-support")]
        self.tell_appended("tool_failure");
        self.after_append(due);
    }

    /// `recordAgentWatchdogAbort(ctx)`: the `stall_abort` rows of a stopped turn (`mixdog_trace::watchdog_abort_records` has the
    /// fields of `ctx`), queued behind the same buffers.
    pub fn record_watchdog_abort(self: &Arc<Self>, ctx: &Map<String, Value>) {
        let due = self.trace.watchdog_abort(ctx, self.clock.now_ms());
        #[cfg(feature = "test-support")]
        self.tell_appended("stall_abort");
        self.after_append(due);
    }

    fn after_append(self: &Arc<Self>, due: bool) {
        if due {
            let me = Arc::clone(self);
            drop(mixdog_rt::spawn("tool-failures-flush", TaskClass::Work, async move { me.flush().await }));
        } else if self.timer_is_held() {
            #[cfg(feature = "replay-controls")]
            self.report_held();
        } else if !self.armed.swap(true, Ordering::AcqRel) {
            let me = Arc::clone(self);
            drop(mixdog_rt::spawn("tool-failures-timer", TaskClass::Work, async move {
                mixdog_rt::time::sleep(FLUSH_AFTER).await;
                me.armed.store(false, Ordering::Release);
                me.flush().await;
            }));
        }
    }

    /// Writes what is queued (the timer, a full batch, and the exit hook all come here).
    pub async fn flush(&self) {
        loop {
            let waited = {
                let mut turn = self.turn.lock().unwrap_or_else(PoisonError::into_inner);
                if turn.running {
                    let (asked, served) = tokio::sync::oneshot::channel();
                    turn.waiting.push(asked);
                    Some(served)
                } else {
                    turn.running = true;
                    None
                }
            };
            match waited {
                // Served by the flush that started after this one asked. A sender that is gone means the running flush was
                // cancelled: take the turn.
                Some(served) => {
                    if served.await.is_ok() {
                        return;
                    }
                }
                None => break,
            }
        }
        let mut running = Running { writer: self, served: Vec::new(), finished: false };
        loop {
            self.flush_once().await;
            for served in running.served.drain(..) {
                let _ = served.send(());
            }
            let asked_meanwhile = {
                let mut turn = self.turn.lock().unwrap_or_else(PoisonError::into_inner);
                if turn.waiting.is_empty() {
                    turn.running = false;
                    None
                } else {
                    Some(std::mem::take(&mut turn.waiting))
                }
            };
            match asked_meanwhile {
                Some(asked) => running.served = asked,
                None => {
                    running.finished = true;
                    return;
                }
            }
        }
    }

    /// One lane job that writes what is queued.
    async fn flush_once(&self) {
        let (trace, now) = (Arc::clone(&self.trace), self.clock.now_ms());
        #[cfg(test)]
        let on_lane = {
            self.submitted.fetch_add(1, Ordering::AcqRel);
            self.on_lane.lock().unwrap_or_else(PoisonError::into_inner).clone()
        };
        let end = {
            self.turn.lock().unwrap_or_else(PoisonError::into_inner).job_live = true;
            JobEnd(Arc::clone(&self.turn))
        };
        let Ok(job) = self
            .io
            .durability
            .submit_wait(&CancellationToken::new(), move |_lane| {
                let _end = end;
                let warnings = trace.flush(now);
                #[cfg(test)]
                if let Some(on_lane) = on_lane {
                    on_lane();
                }
                warnings
            })
            .await
        else {
            return;
        };
        let Ok(warnings) = job.await else {
            return;
        };
        for warning in warnings {
            if self.warned.lock().unwrap_or_else(PoisonError::into_inner).insert(warning.key) {
                mixdog_rt::node_stderr!("{}", warning.message);
            }
        }
    }
}

#[cfg(test)]
#[path = "failure_log_tests.rs"]
mod tests;

/// Flushes every writer of the process (the exit hook: `process.on('exit', _flushToolFailuresSync)`).
pub async fn flush_all() {
    let writers: Vec<Arc<FailureWriter>> = WRITERS
        .get()
        .map(|writers| writers.lock().unwrap_or_else(PoisonError::into_inner).values().cloned().collect())
        .unwrap_or_default();
    for writer in writers {
        writer.flush().await;
    }
}

/// One run's failed calls, with the thread, agent and working directory they belong to.
pub struct RunFailureLog {
    writer: Arc<FailureWriter>,
    session_id: String,
    agent: Option<String>,
    cwd: String,
}

impl RunFailureLog {
    pub fn new(writer: Arc<FailureWriter>, session_id: &str, agent: Option<&str>, cwd: &str) -> Self {
        Self { writer, session_id: session_id.to_owned(), agent: agent.map(str::to_owned), cwd: cwd.to_owned() }
    }
}

impl ToolFailureLog for RunFailureLog {
    fn failed(&self, call: FailedCall) {
        let FailedCall { iteration, tool_name, tool_kind, tool_ms, tool_args, model, result_text } = call;
        let args = json!({
            "sessionId": self.session_id,
            "iteration": iteration,
            "toolName": tool_name,
            "toolKind": tool_kind,
            "toolMs": tool_ms,
            "toolArgs": tool_args,
            "agent": self.agent,
            "model": model,
            "cwd": self.cwd,
            "resultText": result_text,
            "resultKind": "error",
        });
        if let Value::Object(args) = args {
            self.writer.record(&args);
        }
    }

    fn stall_abort(&self, ctx: Map<String, Value>) {
        self.writer.record_watchdog_abort(&ctx);
    }
}
