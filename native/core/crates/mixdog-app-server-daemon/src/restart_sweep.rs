//! `sweepRestartFailures` (`agent-tool.mjs:107`): `recoverStaleWorkerRows({ deadOnly: true })` and `notifyRestartFailures()`. The
//! host runs it for a `recoverAgentWorkers` call and as the first step of every agent maintenance pass
//! ([`AgentRegistry::keep_deadlines`](mixdog_core_session::session::agent_registry::AgentRegistry::keep_deadlines)).

use std::sync::Arc;
use std::sync::Weak;

use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_core_session::session::Clock;
use mixdog_core_session::session::agent_registry::AgentRegistry;
use mixdog_core_session::session::agent_registry::LiveSessions;
use mixdog_core_session::session::agent_registry::ReapWindow;
use mixdog_core_session::session::agent_registry::restart::Liveness;
use mixdog_core_session::session::agent_registry::restart::RestartSweep;
use mixdog_core_session::session::agent_registry::restart::notify_restart_failures;

pub struct RestartSweeper {
    pub registry: Weak<AgentRegistry>,
    pub late: Arc<LateDirectory>,
    pub reap: Arc<dyn ReapWindow>,
    pub clock: Arc<dyn Clock>,
    pub board: JobBoard,
}

impl RestartSweeper {
    /// `recoverStaleWorkerRows({ deadOnly: true })`: the rows whose worker process died settle as failed.
    pub async fn settle(&self) {
        let (Some(registry), Some(directory)) = (self.registry.upgrade(), self.late.directory()) else { return };
        let live = Liveness {
            probe: &crate::os_probe::OsProbe,
            own_pid: u64::from(std::process::id()),
            running: &|id| LiveSessions::running(&*directory, id),
            reap: &*self.reap,
            now_ms: self.clock.now_ms(),
        };
        if let Err(error) = registry.recover_stale_worker_rows(true, &live).await {
            tracing::warn!(%error, "[agent] restart settlement failed");
        }
    }

    /// `notifyRestartFailures()`: the owners of the rows a restart ended are told, once each.
    pub async fn notify(&self) {
        let (Some(registry), Some(directory)) = (self.registry.upgrade(), self.late.directory()) else { return };
        let stamp = mixdog_agent::agent_tool::stamp::iso_from_ms(self.clock.now_ms());
        if let Err(error) = notify_restart_failures(&registry, &*directory, &self.board, &stamp).await {
            tracing::warn!(%error, "[agent] restart notices failed");
        }
    }
}

#[async_trait::async_trait]
impl RestartSweep for RestartSweeper {
    async fn sweep(&self) {
        self.settle().await;
        self.notify().await;
    }
}
