//! The `explore` tool's runner over the real host: [`AgentExplorer`] with the environment Node's
//! `runExplorer` (`runtime/explore/explorer.mjs:39-87`) gives its loop.
//!
//! Node drives `agentLoop(provider, messages, model, tools, null, cwd, { signal, session: policy, .. })`
//! directly: no session record, so no steering, hooks, compaction or transcript (`explorer.mjs:1-3`,
//! `compaction: { auto: false }` :57), no `onToolProgress` and no approval callback (the options at
//! :64-80 carry neither), and the retry path is the process's own. Rust's [`AgentExplorer::standalone`]
//! is exactly that run environment (`one_shot::isolated`: the clock, jitter, retry wait and decider
//! only), so no `RunEnv` is built here; what the process supplies is the [`ToolEnv`].
//!
//! The tool environment is the same plumbing every session run shares (`assemble.rs` `ToolEnv`:
//! the file and process services and the I/O lanes), with Node's explorer differences:
//! - progress is dropped (`DroppedProgress`): the loop is given no progress callback;
//! - approvals answer unavailable (`NoApprovals`): the schema allowlist is the execution allowlist
//!   (`pre-dispatch-deny.mjs`, `explorer.mjs:51-52`) and holds read-only tools only;
//! - the read-only I/O deadline every session run has (`agentLoop`'s calls pass `executeTool`'s
//!   `runReadOnlyIoWithDeadline`), and no completion hook;
//! - the thread and the cwd are placeholders: `AgentExplorer::explore` replaces both per query from
//!   the calling thread and its cwd (`explorer.rs`, `tool_env.thread_id = run.thread`), as
//!   `runExplorer({ cwd })`.

use std::sync::Arc;

use mixdog_agent::env::Clock;
use mixdog_agent::explorer::{AgentExplorer, ExplorerHost};
use mixdog_agent::tools::ToolEnv;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::{SurfaceKind, ToolIo};
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::TurnId;

use crate::run_host::retry::{RandomJitter, TimerWait};
use crate::run_host::summary_host::{DroppedProgress, NoApprovals};

/// What the process supplies the explorer's tool plumbing with: the services the session runs use.
pub struct ExplorerEnv {
    pub clock: Arc<dyn Clock>,
    /// The cwd a query starts from, until `explore` replaces it with the caller's.
    pub cwd: AbsPath,
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub io: ToolIo,
}

impl ExplorerEnv {
    pub fn tool_env(&self) -> ToolEnv {
        ToolEnv {
            thread_id: ThreadId::from(""),
            turn_id: TurnId::from("explore"),
            cwd: self.cwd.clone(),
            surface: SurfaceKind::Lead,
            io: self.io,
            approvals: Arc::new(NoApprovals(self.clock.clone())),
            files: self.files.clone(),
            processes: self.processes.clone(),
            progress: Arc::new(DroppedProgress),
            deadline_of: Some(mixdog_agent::tools::read_only_io_deadline()),
            notify: None,
            review: None,
        }
    }

    /// The `explore` tool's runner over `host` (the `ConfigExplorerHost` of the process).
    pub fn explorer(&self, host: Arc<dyn ExplorerHost>) -> AgentExplorer {
        AgentExplorer::standalone(host, self.clock.clone(), Arc::new(RandomJitter), Arc::new(TimerWait), Arc::new(StandardRetryDecider), self.tool_env())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::mock::{MockFileService, MockProcessManager};

    use super::*;

    struct Fixed(i64);

    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn env() -> ExplorerEnv {
        let tokens = mixdog_rt::testing::tokens();
        ExplorerEnv {
            clock: Arc::new(Fixed(42)),
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        }
    }

    #[test]
    fn an_explorer_runs_the_lead_surface_with_the_shared_lanes_the_read_only_deadline_and_no_hook() {
        let env = env();
        let tool_env = env.tool_env();
        assert_eq!(tool_env.surface, SurfaceKind::Lead);
        assert_eq!(tool_env.cwd, env.cwd);
        assert!(tool_env.deadline_of.is_some() && tool_env.notify.is_none());
    }
}