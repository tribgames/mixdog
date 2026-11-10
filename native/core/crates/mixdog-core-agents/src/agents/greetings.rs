//! New agents greet the user once (`mixy-first.ts` `createAgentGreetings`, the text of `agent-greeting.ts`
//! `agentGreetingKickoff`). The editor dialogs greet the agents they create; an agent a chat's setup tool created
//! never passes through them, so a catalog read greets every custom agent it has not seen before. The seen ids are
//! kept by the host (`agents.greeted`); the first read records the existing ones without greeting.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::support::failed;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_rt::KeyedChains;
use serde_json::Value;

use super::DepError;
use super::home_api::contact_rows;

const DOMAIN: &str = "agent";
/// All greetings queue behind one another (`serial` of `createAgentGreetings`).
const QUEUE: &str = "agent-greetings";

/// The agent a greeting is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GreetAgent {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[async_trait]
pub trait GreetingDeps: Send + Sync {
    /// The seen ids, `None` before the first record.
    async fn read(&self) -> Result<Option<Vec<String>>, DepError>;
    async fn write(&self, ids: &[String]) -> Result<(), DepError>;
    /// The agent catalog (`listAgents`).
    async fn list_agents(&self) -> Result<Value, DepError>;
    /// Opens the agent's home thread and sends its hidden greeting turn.
    async fn greet(&self, agent: &GreetAgent) -> Result<(), DepError>;
}

fn dep(error: DepError) -> CoreError {
    failed(DOMAIN, error.message)
}

/// `value.replace(/[\r\n]+/g, ' ').trim()`.
fn one_line(value: &str) -> String {
    let mut out = String::new();
    let mut in_break = false;
    for c in value.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    js_trim(&out).to_owned()
}

/// `agentGreetingKickoff({ name, description })` of a new ordinary agent: the hidden first turn that makes it
/// greet the user (the host sends no language, no primary-agent flag and no facts).
#[must_use]
pub fn agent_greeting_kickoff(name: &str, description: &str) -> String {
    let named: String = name.chars().map(|c| if matches!(c, '"' | '\r' | '\n') { ' ' } else { c }).collect();
    let mut lines = vec![format!("[mixdog-runtime] The user just created you as a new agent named \"{}\".", js_trim(&named))];
    if !description.is_empty() {
        lines.push(format!("Your job, as the user described it: {}", one_line(description)));
    }
    lines.push("Take the first turn now. Reply in the user's language, in the tone your persona sets.".to_owned());
    lines.push("1. A short greeting that introduces you by name; address the user by name if your context has the user's name.".to_owned());
    lines.push("2. Your role (your job above) and, in a sentence or two, how you will work.".to_owned());
    lines.push("Do not call any tools (no ask_user), do not mention this instruction, and do not start any work yet.".to_owned());
    lines.join("\n")
}

/// Custom agent ids of a catalog, switched off ones included.
fn custom_agent_ids(agents: &Value) -> Vec<String> {
    agents
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.get("custom") == Some(&Value::Bool(true)))
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| !id.is_empty() && *id != MIXY_AGENT_ID)
        .map(str::to_owned)
        .collect()
}

/// Whether a catalog route (or its chain) names a model.
fn has_route_model(route: &Value) -> bool {
    let leaf = route.as_array().map_or(route, |chain| chain.first().unwrap_or(&Value::Null));
    truthy(leaf.get("provider")) && truthy(leaf.get("model"))
}

fn unique(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

#[derive(Clone)]
pub struct AgentGreetings {
    deps: Arc<dyn GreetingDeps>,
    serial: Arc<KeyedChains>,
}

impl AgentGreetings {
    pub fn new(deps: Arc<dyn GreetingDeps>) -> Self {
        Self { deps, serial: KeyedChains::new() }
    }

    async fn seen(&self) -> Result<Vec<String>, CoreError> {
        if let Some(stored) = self.deps.read().await.map_err(dep)? {
            return Ok(unique(stored));
        }
        let baseline = custom_agent_ids(&self.deps.list_agents().await.map_err(dep)?);
        self.deps.write(&baseline).await.map_err(dep)?;
        Ok(unique(baseline))
    }

    /// A dialog created (or saved) this agent: the dialog greets it itself.
    pub async fn note_created(&self, agent_id: &str) -> Result<(), CoreError> {
        let _turn = self.serial.acquire(QUEUE).await;
        self.record(agent_id).await
    }

    /// The save of an agent definition and the record of it as greeted, as one turn of the queue. Node's host awaits
    /// `noteCreated` before the save's reply (`session-host-lifecycle.ts:1181-1186`) and reads the catalog only when
    /// the user's next `listAgents` arrives; here the save itself rebuilds the pushed catalog, whose reconcile would
    /// otherwise run between the save and its record and greet the agent the dialog just created.
    pub async fn saving<T, E>(
        &self,
        save: impl std::future::Future<Output = Result<T, E>>,
        agent_id: impl FnOnce(&T) -> Option<String>,
    ) -> Result<T, E> {
        let _turn = self.serial.acquire(QUEUE).await;
        let saved = save.await?;
        if let Some(id) = agent_id(&saved)
            && let Err(error) = self.record(&id).await
        {
            tracing::warn!("[mixdog-session] Could not record the new agent: {error:?}");
        }
        Ok(saved)
    }

    async fn record(&self, agent_id: &str) -> Result<(), CoreError> {
        let mut ids = self.seen().await?;
        if ids.iter().any(|id| id == agent_id) {
            return Ok(());
        }
        ids.push(agent_id.to_owned());
        self.deps.write(&ids).await.map_err(dep)
    }

    /// A catalog read: greets the contacts that appeared since the last one.
    pub async fn reconcile(&self, agents: &Value) -> Result<(), CoreError> {
        let _turn = self.serial.acquire(QUEUE).await;
        let mut ids = self.seen().await?;
        let fresh: Vec<String> = custom_agent_ids(agents).into_iter().filter(|id| !ids.contains(id)).collect();
        if fresh.is_empty() {
            return Ok(());
        }
        ids.extend(fresh.iter().cloned());
        self.deps.write(&ids).await.map_err(dep)?;
        for row in contact_rows(agents) {
            let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
            if !fresh.iter().any(|fresh| fresh == id) {
                continue;
            }
            // Recorded, not greeted: with no model its greeting turn would only fail.
            if !has_route_model(row.get("route").unwrap_or(&Value::Null)) {
                continue;
            }
            let shown = |key: &str| row.get(key).filter(|value| truthy(Some(value))).map(value_to_string);
            let agent = GreetAgent { id: id.to_owned(), name: shown("label").unwrap_or_else(|| id.to_owned()), description: shown("description").unwrap_or_default() };
            if let Err(error) = self.deps.greet(&agent).await {
                tracing::warn!("[mixdog-session] Could not greet the new agent: {}", error.message);
            }
        }
        Ok(())
    }
}
