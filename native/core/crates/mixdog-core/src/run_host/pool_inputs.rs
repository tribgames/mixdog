//! The production inputs of `AgentPool` (the Agents pool list): [`PoolStore`] over the registry's worker
//! maps and the threads' headers, and [`PoolLive`] over the directory, the run progress cells, the
//! usage ledger's group tokens and the stall thresholds.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::watchdog::AgentKind;
use mixdog_agent::agent_tool::watchdog::stall_warn_ms;
use mixdog_core_agents::agents::PoolLive;
use mixdog_core_agents::agents::PoolStore;
use mixdog_core_agents::agents::RuntimeEntry;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::hidden_agents::hidden_agent;
use mixdog_core_config::config::hidden_agents::hidden_agent_stall_cap_idle_seconds;
use mixdog_core_run::run_host::progress::WaitedJobs;
use mixdog_core_session::session::Clock;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::agent_registry::AgentRegistry;
use mixdog_core_session::session::agent_registry::Row;
use mixdog_services::task_reports::runtime_state::RuntimeLiveness;
use serde_json::Value;
use serde_json::json;

use super::group_usage_tokens::GroupUsageTokens;

/// `PoolStore`: the worker index documents as the registry holds them, and a session's header.
pub struct RegistryPoolStore {
    registry: Arc<AgentRegistry>,
    directory: Arc<SessionDirectory>,
}

impl RegistryPoolStore {
    pub fn new(registry: Arc<AgentRegistry>, directory: Arc<SessionDirectory>) -> Self {
        Self { registry, directory }
    }
}

#[async_trait]
impl PoolStore for RegistryPoolStore {
    async fn agent_index(&self) -> Option<Value> {
        Some(self.registry.pool_index().await.0)
    }

    async fn lead_index(&self) -> Option<Value> {
        Some(self.registry.pool_index().await.1)
    }

    /// One answer per id, in order; `None` for a session that is not stored.
    ///
    /// The header a loaded session holds, else its stored record: a listing reads every worker the index names, and
    /// opening each of them would load every session of the profile to list them.
    async fn headers(&self, session_ids: &[String]) -> Vec<Option<Row>> {
        let ids: Vec<ThreadId> = session_ids.iter().map(|id| ThreadId::from(id.as_str())).collect();
        futures::future::join_all(ids.iter().map(|id| self.directory.stored_header(id))).await
    }
}

/// `activeBackgroundTaskSessionIds({ surface: 'shell', awaitedOnly: true })`.
pub trait AwaitedShells: Send + Sync {
    fn awaited_owners(&self) -> HashSet<String>;
}

/// `PoolLive` over the daemon's own turn activity.
pub struct DirectoryPoolLive {
    directory: Arc<SessionDirectory>,
    liveness: Arc<RuntimeLiveness>,
    jobs: Arc<dyn WaitedJobs>,
    clock: Arc<dyn Clock>,
    shells: Arc<dyn AwaitedShells>,
    tokens: Arc<GroupUsageTokens>,
    /// `process.env` (`STALL_TIMEOUT_S`).
    env: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

impl DirectoryPoolLive {
    pub fn new(
        directory: Arc<SessionDirectory>,
        liveness: Arc<RuntimeLiveness>,
        jobs: Arc<dyn WaitedJobs>,
        clock: Arc<dyn Clock>,
        shells: Arc<dyn AwaitedShells>,
        tokens: Arc<GroupUsageTokens>,
        env: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    ) -> Self {
        Self { directory, liveness, jobs, clock, shells, tokens, env }
    }
}

impl PoolLive for DirectoryPoolLive {
    fn now(&self) -> f64 {
        self.clock.now_ms() as f64
    }

    fn running(&self) -> HashSet<String> {
        self.liveness.in_flight_session_activity().working
    }

    fn awaiting_shell(&self) -> HashSet<String> {
        self.shells.awaited_owners()
    }

    /// `_liveSessions.get(id)`: the header of a session this process holds.
    fn live_session(&self, session_id: &str) -> Option<Value> {
        let handle = self.directory.handle(&ThreadId::from(session_id))?;
        Some(Value::Object((*handle.live_header().header()).clone()))
    }

    /// `runtimeState.get(id)`: the run's liveness record, and whether its turn holds a controller that
    /// has not been aborted. `lastTransportAt` is the send time once the transport answered
    /// (`waitingForTransport` is that same fact read the other way).
    fn runtime_entry(&self, session_id: &str) -> Option<RuntimeEntry> {
        let thread = ThreadId::from(session_id);
        let handle = self.directory.handle(&thread)?;
        let live = self.directory.worker_live(&thread, self.clock.now_ms(), &*self.jobs);
        let mut record = Row::new();
        if let Some(stage) = &live.runtime_stage {
            record.insert("stage".into(), json!(stage));
        }
        if let Some(runtime) = &live.runtime {
            record.insert("lastProgressAt".into(), json!(runtime.last_progress_at));
            record.insert("lastStreamDeltaAt".into(), json!(runtime.last_stream_delta_at));
            record.insert("toolStartedAt".into(), json!(runtime.tool_started_at));
            record.insert("askStartedAt".into(), json!(runtime.ask_started_at));
            if let Some(tool) = &runtime.last_tool_call {
                record.insert("lastToolCall".into(), json!(tool));
            }
        }
        if let Some(snapshot) = &live.snapshot {
            record.insert("requestSentAt".into(), json!(snapshot.model_request_started_at));
            record.insert("lastTransportAt".into(), json!(if snapshot.waiting_for_transport { 0 } else { snapshot.model_request_started_at }));
        }
        record.insert("taskWaits".into(), json!(u32::from(live.task_waiting)));
        Some(RuntimeEntry { liveness: record, controller_live: handle.controller_live() })
    }

    fn ledger_tokens(&self, groups: &[(String, Vec<String>)]) -> HashMap<String, String> {
        self.tokens.tokens(groups)
    }

    /// `resolveAgentStallThresholds(agent).warn * 1000`.
    fn stall_warn_ms(&self, agent: Option<&str>) -> f64 {
        let hidden = agent.filter(|name| !name.is_empty()).and_then(hidden_agent);
        let kind = AgentKind {
            name: agent,
            hidden: hidden.is_some(),
            stall_cap_idle_seconds: agent.and_then(hidden_agent_stall_cap_idle_seconds),
        };
        stall_warn_ms(kind, &*self.env) as f64
    }
}
