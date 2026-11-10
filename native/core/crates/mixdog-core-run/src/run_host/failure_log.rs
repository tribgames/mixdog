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

/// The failures file of one data directory.
pub struct FailureWriter {
    trace: Arc<AgentTrace>,
    io: ToolIo,
    clock: Arc<dyn Clock>,
    /// The 1000 ms timer is armed (the first row of a batch arms it; a flush does not need it).
    armed: AtomicBool,
    /// One flush at a time, in the order they were asked for: the rows of a later chunk never overtake an earlier one.
    turn: tokio::sync::Mutex<()>,
    /// `warnAgentOnce`: each warning key is written to stderr once.
    warned: Mutex<HashSet<String>>,
}

impl FailureWriter {
    /// The writer of `data_dir`'s failures file, made on first use from the process environment (Node resolves
    /// `MIXDOG_TOOL_FAILURE_LOG_PATH` & co. once, at the first row).
    pub fn for_data_dir(data_dir: &Path, io: ToolIo, clock: Arc<dyn Clock>) -> Arc<Self> {
        let writers = WRITERS.get_or_init(Mutex::default);
        let mut writers = writers.lock().unwrap_or_else(PoisonError::into_inner);
        writers
            .entry(data_dir.to_path_buf())
            .or_insert_with(|| Arc::new(Self::new(&TraceConfig::from_env(data_dir, &|name| std::env::var(name).ok(), false), io, clock)))
            .clone()
    }

    pub fn new(config: &TraceConfig, io: ToolIo, clock: Arc<dyn Clock>) -> Self {
        Self {
            trace: Arc::new(AgentTrace::new(config)),
            io,
            clock,
            armed: AtomicBool::new(false),
            turn: tokio::sync::Mutex::new(()),
            warned: Mutex::new(HashSet::new()),
        }
    }

    /// `traceAgentToolFailure(args)` (the fields are `tool_failure_row`'s): queues the row and starts the flush
    /// that is due, on the durability lane.
    pub fn record(self: &Arc<Self>, args: &Map<String, Value>) {
        let due = self.trace.tool_failure(args, self.clock.now_ms());
        self.after_append(due);
    }

    /// `recordAgentWatchdogAbort(ctx)`: the `stall_abort` row of a stopped dispatch (`mixdog_trace::watchdog_abort_records` has the
    /// fields of `ctx`), queued behind the same buffer.
    pub fn record_watchdog_abort(self: &Arc<Self>, ctx: &Map<String, Value>) {
        let due = self.trace.watchdog_abort(ctx, self.clock.now_ms());
        self.after_append(due);
    }

    fn after_append(self: &Arc<Self>, due: bool) {
        if due {
            let me = Arc::clone(self);
            drop(mixdog_rt::spawn("tool-failures-flush", TaskClass::Work, async move { me.flush().await }));
        } else if !self.armed.swap(true, Ordering::AcqRel) {
            let me = Arc::clone(self);
            drop(mixdog_rt::spawn("tool-failures-timer", TaskClass::Work, async move {
                tokio::time::sleep(FLUSH_AFTER).await;
                me.armed.store(false, Ordering::Release);
                me.flush().await;
            }));
        }
    }

    /// Writes what is queued (the timer, a full batch, and the exit hook all come here).
    pub async fn flush(&self) {
        let _turn = self.turn.lock().await;
        let (trace, now) = (Arc::clone(&self.trace), self.clock.now_ms());
        let Ok(job) = self.io.durability.submit_wait(&CancellationToken::new(), move |_lane| trace.flush(now)).await else {
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
}
