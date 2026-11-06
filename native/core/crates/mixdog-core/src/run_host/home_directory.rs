//! The home delivery's definitions (`HomeDirectory`) over the agent definitions: what Node's
//! `processDelivery` wires to `agentDefinitionPresence`, `readHomeAgent` and `readMixyExists`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::home_agent::HomeAgentKind;
use mixdog_core_rooms::rooms::home::Presence as Found;
use mixdog_services::bots::delivery::env::{HomeAgent, HomeDirectory, Presence};

/// [`HomeDirectory`] over the process's agent definitions.
pub struct DefinitionsDirectory {
    definitions: Arc<AgentDefinitions>,
}

impl DefinitionsDirectory {
    pub fn new(definitions: Arc<AgentDefinitions>) -> Self {
        Self { definitions }
    }
}

#[async_trait]
impl HomeDirectory for DefinitionsDirectory {
    /// The editor's per-id probe: `Deleted` only when proven gone, anything unreadable `Unknown`.
    async fn agent_presence(&self, agent_id: &str) -> Presence {
        match self.definitions.presence(&[agent_id.to_owned()]).await.ok().and_then(|mut found| found.remove(agent_id)) {
            Some(Found::Present) => Presence::Present,
            Some(Found::Deleted) => Presence::Deleted,
            Some(Found::Unknown) | None => Presence::Unknown,
        }
    }

    /// The daemon has no room store (rooms live in the desktop host): no room counts as deleted,
    /// as Node's default `roomPresence`.
    async fn room_presence(&self, _room_id: &str) -> Presence {
        Presence::Unknown
    }

    async fn home_agent(&self, agent_id: &str) -> HomeAgent {
        match self.definitions.home_agent(agent_id).await {
            Ok(HomeAgentKind::Bot) => HomeAgent::Bot,
            Ok(HomeAgentKind::None) => HomeAgent::None,
            Ok(HomeAgentKind::Unknown) | Err(_) => HomeAgent::Unknown,
        }
    }

    /// `readMixyExists`: the one rule. A rule that cannot be read answers yes, so a heartbeat
    /// report is never dropped on an unreadable definition.
    async fn mixy_exists(&self) -> bool {
        self.definitions.mixy_exists().await.unwrap_or(true)
    }
}

#[cfg(test)]
mod tests;
