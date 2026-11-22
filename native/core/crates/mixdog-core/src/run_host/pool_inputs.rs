//! The production inputs of `AgentPool` (the Agents pool list): [`PoolStore`] over the registry's worker
//! maps and the threads' headers, and [`PoolLive`] over the directory, the run progress cells, the
//! usage ledger's group tokens and the stall thresholds.

// Transparent callback/state names; existing ownership and call signatures are unchanged.
type EnvironmentLookup = dyn Fn(&str) -> Option<String> + Send + Sync;

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::watchdog::AgentKind;
use mixdog_agent::agent_tool::watchdog::stall_warn_ms;
use mixdog_core_agents::agents::HEADER_FIELDS;
use mixdog_core_agents::agents::PoolLive;
use mixdog_core_agents::agents::PoolStore;
use mixdog_core_agents::agents::RuntimeEntry;
use mixdog_core_agents::agents::SettleFix;
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

/// Whether the catalog row of a session holds `field` (`mixdog_store::worker::LISTED_FIELDS`).
const fn listed(field: &str) -> bool {
    let (field, mut at) = (field.as_bytes(), 0);
    while at < mixdog_store::worker::LISTED_FIELDS.len() {
        let held = mixdog_store::worker::LISTED_FIELDS[at].as_bytes();
        let mut same = held.len() == field.len();
        let mut byte = 0;
        while same && byte < held.len() {
            same = held[byte] == field[byte];
            byte += 1;
        }
        if same {
            return true;
        }
        at += 1;
    }
    false
}

// The pool's listing is one read of the index only while the catalog row holds every member it reads: one member the
// row lacks sends the listing to each session's record instead.
const _: () = {
    let mut at = 0;
    while at < HEADER_FIELDS.len() {
        assert!(listed(HEADER_FIELDS[at]), "the catalog row lacks a header member the agent pool reads");
        at += 1;
    }
};

impl RegistryPoolStore {
    pub fn new(registry: Arc<AgentRegistry>, directory: Arc<SessionDirectory>) -> Self {
        Self { registry, directory }
    }
}

#[async_trait]
impl PoolStore for RegistryPoolStore {
    async fn agent_index(&self) -> Option<Value> {
        self.registry.pool_index().await.ok().map(|(agents, _)| agents)
    }

    async fn lead_index(&self) -> Option<Value> {
        self.registry.pool_index().await.ok().map(|(_, leads)| leads)
    }

    async fn indexes(&self) -> Result<(Option<Value>, Option<Value>), String> {
        let (agents, leads) = self.registry.pool_index().await?;
        Ok((Some(agents), Some(leads)))
    }

    async fn headers(&self, session_ids: &[String]) -> Vec<Option<Row>> {
        let ids: Vec<ThreadId> = session_ids.iter().map(|id| ThreadId::from(id.as_str())).collect();
        self.directory.listed_fields_of(&ids, &HEADER_FIELDS).await
    }

    async fn listed_headers(&self, session_ids: &[String]) -> Result<Vec<Option<Row>>, String> {
        let ids: Vec<ThreadId> = session_ids.iter().map(|id| ThreadId::from(id.as_str())).collect();
        self.directory.try_listed_fields_of(&ids, &HEADER_FIELDS).await.map_err(|error| format!("a listed session's header could not be read: {error:?}"))
    }

    async fn settle_identities(&self, fixes: &[SettleFix]) -> Vec<Value> {
        self.registry.settle_identities(fixes)
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
    env: Arc<EnvironmentLookup>,
}

impl DirectoryPoolLive {
    pub fn new(
        directory: Arc<SessionDirectory>,
        liveness: Arc<RuntimeLiveness>,
        jobs: Arc<dyn WaitedJobs>,
        clock: Arc<dyn Clock>,
        shells: Arc<dyn AwaitedShells>,
        tokens: Arc<GroupUsageTokens>,
        env: Arc<EnvironmentLookup>,
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
    fn live_session(&self, session_id: &str) -> Option<Arc<mixdog_store::schema::record::Header>> {
        let handle = self.directory.handle(&ThreadId::from(session_id))?;
        Some(handle.live_header().header())
    }

    fn request_route(&self, session_id: &str) -> Option<Arc<Row>> {
        self.liveness.request_route(session_id)
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
        let kind = AgentKind { name: agent, hidden: hidden.is_some(), stall_cap_idle_seconds: agent.and_then(hidden_agent_stall_cap_idle_seconds) };
        stall_warn_ms(kind, &*self.env) as f64
    }
}
