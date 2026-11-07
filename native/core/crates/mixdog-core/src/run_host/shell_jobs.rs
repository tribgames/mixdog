//! The shell job table as the pool and the worker views read it: Node's `waitedJobSilence` and
//! `activeBackgroundTaskSessionIds({ surface: 'shell', awaitedOnly: true })` (`background-tasks.mjs`).
//! Node's task registry is process-wide, so both answer for tasks of sessions that are not loaded;
//! the runtime's table is too (`ExecRuntime::awaited_owners`, `waited_silence`).

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_agent::agent_tool::progress::ToolSilence;
use mixdog_core_run::run_host::progress::WaitedJobs;
use mixdog_tools::exec::ExecRuntime;

use super::pool_inputs::AwaitedShells;

pub struct ShellJobs(pub Arc<ExecRuntime>);

impl WaitedJobs for ShellJobs {
    fn silence(&self, ids: &[String], now_ms: i64) -> Option<ToolSilence> {
        let silence = self.0.waited_silence(ids, now_ms.max(0) as u64)?;
        Some(ToolSilence { task_id: silence.task_id, silent_ms: silence.silent_ms, hung: silence.hung })
    }
}

impl AwaitedShells for ShellJobs {
    fn awaited_owners(&self) -> HashSet<String> {
        self.0.awaited_owners().into_iter().map(|owner| owner.as_str().to_owned()).collect()
    }
}