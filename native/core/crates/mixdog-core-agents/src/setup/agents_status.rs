//! The `agents` domain of the setup tool's `status` action (`setup-tool/executor.mjs`
//! `SETUP_STATUS_READERS.agents`): the agent catalog, the orchestration mode of the calling
//! conversation, the shared bot order and the fallback positions of the bots and agents that are
//! running. Registered with `SetupService::with_status`; the dispatcher prepends `domain`.
//! Objects are built in Node's key order.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::DomainCalls;
use super::StatusReader;
use crate::agents::AgentDefinitions;

/// `ORCHESTRATION_MODES`.
const ORCHESTRATION_MODES: [&str; 4] = ["none", "focused", "balanced", "swarm"];

/// `routePositionsStatus({ caller, config, keep: (row) => row.kind !== 'lead' }).sessions`: the
/// fallback positions (`routeFallbackPosition` rows) of the sessions this process holds that
/// follow a chain or have hopped, bots and agents only, never the calling session. The route
/// owner's state; the rows are printed as they come.
#[async_trait]
pub trait RoutePositions: Send + Sync {
    async fn others(&self, caller: &ThreadId) -> Result<Vec<Value>, PortError>;
}

pub struct AgentsStatus {
    agents: Arc<AgentDefinitions>,
    domains: Arc<dyn DomainCalls>,
    positions: Arc<dyn RoutePositions>,
}

impl AgentsStatus {
    pub fn new(agents: Arc<AgentDefinitions>, domains: Arc<dyn DomainCalls>, positions: Arc<dyn RoutePositions>) -> Self {
        Self { agents, domains, positions }
    }

    async fn get(&self, method: &'static str, params: Value) -> Result<Value, PortError> {
        self.domains.call(method, params).await.map_err(|error| PortError::Failed { capability: "setup".into(), message: error.to_string() })
    }
}

#[async_trait]
impl StatusReader for AgentsStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["agents"]
    }

    async fn read(&self, domain: &str, _detail: bool, thread: &ThreadId) -> Result<Value, PortError> {
        if domain != "agents" {
            return Err(PortError::Unavailable { capability: format!("setup.status.{domain}"), message: format!("{domain} is not the agents status domain") });
        }
        let agents = self.agents.catalog().await.map_err(|error| PortError::Failed { capability: "setup".into(), message: error.to_string() })?;
        let mode = self.get("config/getOrchestrationMode", json!({ "threadId": thread.as_str() })).await?;
        let order = self.get("config/getBotOrder", json!({})).await?;
        let mut out = Map::new();
        out.insert("agents".into(), agents);
        out.insert("orchestrationMode".into(), mode);
        out.insert("orchestrationModes".into(), json!(ORCHESTRATION_MODES));
        out.insert("botOrder".into(), order.get("order").cloned().unwrap_or(Value::Null));
        out.insert("sessions".into(), Value::Array(self.positions.others(thread).await?));
        Ok(Value::Object(out))
    }
}

#[cfg(test)]
mod tests;