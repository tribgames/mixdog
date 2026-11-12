//! The agent trace: Node's `appendAgentTrace` writer (`agent-trace-io.mjs`) and the two record
//! builders the usage and compaction call sites need (`logLlmCall` in `usage-log.mjs`,
//! `traceAgentCompact` in `agent-trace-format.mjs`), byte for byte.
//!
//! Layout: `record` builds the rows (pure), `config` resolves paths and gates from the process
//! environment the way Node does, `spool` is the buffered, rotating JSONL file, and `AgentTrace`
//! ties the local trace spool and the `tool-failures.jsonl` spool together.
//!
//! No clock, timer or thread lives here: every call takes `now_ms` (the owner's clock), `append*`
//! only queues and answers whether a flush is due (100 lines / 1000 ms for the trace, 50 lines /
//! 1000 ms for the failures log), and `flush` does the blocking file work, so the owner runs it as
//! a job on a blocking lane. The memory service's `trace_events` table (Node's second sink, via
//! `/admin/trace-record`) is reached through `RowSink`; mixdog-services implements it.

mod builders;
mod config;
mod record;
mod spool;
mod text;
mod tool;
mod watchdog;

pub use builders::*;
pub use config::TraceConfig;
pub use record::build_row;
pub use record::compact_meta_record;
pub use record::truthy;
pub use record::usage_record;
pub use spool::Warning;
pub use tool::*;
pub use watchdog::*;
pub use text::slice_utf16;
pub use text::stringify;

use serde_json::Map;
use serde_json::Value;
use spool::Kind;
use spool::Spool;

/// Node's second sink: every row `appendAgentTrace` builds also goes to the memory service's
/// `trace_events` store (`/admin/trace-record`), whether or not the local file is written.
pub trait RowSink: Send + Sync {
    fn row(&self, row: &Map<String, Value>, now_ms: i64);
}

/// The agent trace writer: `agent-trace.jsonl` and `tool-failures.jsonl` under one config.
pub struct AgentTrace {
    disabled: bool,
    local: Option<Spool>,
    failures: Option<Spool>,
    sink: Option<std::sync::Arc<dyn RowSink>>,
    slow_tool: SlowTool,
}

impl AgentTrace {
    pub fn new(config: &TraceConfig) -> Self {
        Self::with_sink(config, None)
    }

    pub fn with_sink(config: &TraceConfig, sink: Option<std::sync::Arc<dyn RowSink>>) -> Self {
        Self {
            sink,
            slow_tool: config.slow_tool.clone(),
            disabled: config.agent_trace_disable,
            local: config.local.as_ref().map(|local| {
                Spool::new(
                    local.path.clone(),
                    100,
                    config.rotate_keep,
                    config.rotate_check_ms,
                    // An explicit sink is shared by many short-lived writers: append-only.
                    !local.explicit,
                    Kind::Trace,
                )
            }),
            failures: config.failure_path.as_ref().map(|path| {
                Spool::new(
                    path.clone(),
                    50,
                    config.rotate_keep,
                    config.rotate_check_ms,
                    true,
                    Kind::Failures,
                )
            }),
        }
    }

    /// `appendAgentTrace(record)`. Returns true when the trace spool is due for `flush`.
    pub fn append(&self, record: &Map<String, Value>, now_ms: i64) -> bool {
        if self.disabled {
            return false;
        }
        if self.local.is_none() && self.sink.is_none() {
            return false;
        }
        let row = build_row(record, now_ms);
        if let Some(sink) = &self.sink {
            sink.row(&row, now_ms);
        }
        self.local.as_ref().is_some_and(|local| local.push(&stringify(&Value::Object(row)), now_ms))
    }

    /// `traceAgentTool`: the `tool` row, the `tool_slow` row and the failure row, in that order.
    /// True when a spool is due for `flush`.
    pub fn tool(&self, args: &Map<String, Value>, now_ms: i64) -> bool {
        let records = tool_records(args, &self.slow_tool, now_ms);
        let mut due = self.append(&records.tool, now_ms);
        if let Some(slow) = &records.slow {
            due |= self.append(slow, now_ms);
        }
        if let Some(failure) = records.failure.as_ref().filter(|_| !self.disabled) {
            due |= self.append_tool_failure(failure, now_ms);
        }
        due
    }

    /// `traceAgentToolFailure(args)` (the failed call's row of `tool-failures.jsonl`; `args` are the
    /// call-site fields of `tool_failure_row`). Nothing is built when the log is off. True when the
    /// failures spool is due for `flush`.
    pub fn tool_failure(&self, args: &Map<String, Value>, now_ms: i64) -> bool {
        if self.disabled || self.failures.is_none() {
            return false;
        }
        tool_failure_row(args, now_ms).is_some_and(|row| self.append_tool_failure(&row, now_ms))
    }

    /// `recordAgentWatchdogAbort`: the `stall_abort` trace row and the `stall_abort` row of
    /// `tool-failures.jsonl` (see `watchdog_abort_records` for the fields of `args`). True when a
    /// spool is due for `flush`.
    pub fn watchdog_abort(&self, args: &Map<String, Value>, now_ms: i64) -> bool {
        let Some(abort) = watchdog_abort_records(args, now_ms) else {
            return false;
        };
        let mut due = self.append(&abort.trace, now_ms);
        if !self.disabled {
            due |= self.append_tool_failure(&abort.failure, now_ms);
        }
        due
    }

    /// `traceCacheBreak(record)`'s row (see `cache_break_payload` for the fields of `record`). True when the trace spool
    /// is due for `flush`.
    pub fn cache_break(&self, record: &Map<String, Value>, now_ms: i64) -> bool {
        self.append(&cache_break_trace_record(record), now_ms)
    }

    /// `_appendToolFailureRow(row)`: the row is written as given. True when due for `flush`.
    pub fn append_tool_failure(&self, row: &Value, now_ms: i64) -> bool {
        match &self.failures {
            Some(failures) => failures.push(&stringify(row), now_ms),
            None => false,
        }
    }

    /// Whether either spool has reached its line count or age.
    pub fn due(&self, now_ms: i64) -> bool {
        self.local.as_ref().is_some_and(|s| s.due(now_ms))
            || self.failures.as_ref().is_some_and(|s| s.due(now_ms))
    }

    /// Writes what both spools hold (Node's flush, `drainAgentTrace` and the exit hook). The
    /// returned warnings are Node's warn-once stderr lines; a failed write drops its chunk.
    pub fn flush(&self, now_ms: i64) -> Vec<Warning> {
        let mut warnings = Vec::new();
        for spool in [&self.local, &self.failures].into_iter().flatten() {
            warnings.extend(spool.flush(now_ms));
        }
        warnings
    }
}
