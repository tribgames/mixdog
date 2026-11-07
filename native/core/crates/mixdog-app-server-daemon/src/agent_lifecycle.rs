//! What the desktop host did for a new agent that is not the agent service's: greeting it. The seen ids are the config's
//! `agents.greeted` (the migrated `agent-greetings.json`, sorted and unique); the greeting is the hidden first turn of
//! the agent's home thread (`session-host-lifecycle.ts` `agentGreetings`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::AgentHomeSessions;
use mixdog_core_agents::agents::DepError;
use mixdog_core_agents::agents::GreetAgent;
use mixdog_core_agents::agents::GreetingDeps;
use mixdog_core_agents::agents::agent_greeting_kickoff;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_session::session::SessionDirectory;
use serde_json::Value;
use serde_json::json;

const NOT_ACCEPTED: &str = "The agent's home thread did not accept its greeting.";

pub struct SessionGreetingDeps {
    config: Config,
    agents: Arc<AgentDefinitions>,
    homes: AgentHomeSessions,
    directory: Arc<SessionDirectory>,
}

impl SessionGreetingDeps {
    pub fn new(config: Config, agents: Arc<AgentDefinitions>, homes: AgentHomeSessions, directory: Arc<SessionDirectory>) -> Self {
        Self { config, agents, homes, directory }
    }
}

#[async_trait]
impl GreetingDeps for SessionGreetingDeps {
    /// `agentGreetingsFileStore.read`: the string ids kept, `None` before the first record.
    async fn read(&self) -> Result<Option<Vec<String>>, DepError> {
        let doc = self.config.full();
        let seen = doc.get("agents").and_then(|agents| agents.get("greeted")).and_then(Value::as_array);
        Ok(seen.map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect()))
    }

    /// `agentGreetingsFileStore.write`: sorted and unique.
    async fn write(&self, ids: &[String]) -> Result<(), DepError> {
        let mut ids = ids.to_vec();
        ids.sort();
        ids.dedup();
        self.config
            .update(move |doc| {
                let agents = doc.entry("agents").or_insert_with(|| json!({}));
                if !agents.is_object() {
                    *agents = json!({});
                }
                agents["greeted"] = json!(ids);
                Ok(())
            })
            .await
            .map(drop)
            .map_err(|error| DepError::new(error.to_string()))
    }

    async fn list_agents(&self) -> Result<Value, DepError> {
        self.agents.catalog().await.map_err(|error| DepError::new(error.to_string()))
    }

    async fn greet(&self, agent: &GreetAgent) -> Result<(), DepError> {
        let opened = self.homes.open(&agent.id).await.map_err(|error| DepError::new(error.to_string()))?;
        let session = opened["sessionId"].as_str().unwrap_or_default();
        let prompt = agent_greeting_kickoff(&agent.name, &agent.description);
        match self.directory.wake_turn(&ThreadId::from(session), &prompt, &format!("agent-greeting:{}", agent.id), 0).await {
            Some(_) => Ok(()),
            None => Err(DepError::new(NOT_ACCEPTED)),
        }
    }
}
