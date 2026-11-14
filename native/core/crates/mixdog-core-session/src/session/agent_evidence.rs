//! [`AgentEvidence`] over the session store and the routine records:
//! - `home_greeted` / `home_chatted`: `homeThreadEvidence(dataDir, agentId)`
//!   (`runtime/shared/agent-kind.mjs`) of the agent's home thread `sess_home_<id>`: its stored
//!   messages (the model context, Node's `session.messages`), a user message holding the creation
//!   greeting at a line start, or a user message the user wrote (not blank, not a runtime turn).
//!   A missing, deleted or unreadable thread holds nothing.
//! - `mixy_owns_routines`: `mixyOwnsRoutines()` (`session-runtime/routine-owner.mjs`): a stored
//!   schedule or webhook whose owner is Mixy (ownerless or invalid owners are); a listing that
//!   fails is the error. Node answers false without a Postgres cluster; the Rust routine rows live
//!   in the core state store, which holds none in that case.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_core_api::ids::ThreadId;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;
use mixdog_services::bots::RoutineKind;
use mixdog_services::bots::RoutineRecords;
use mixdog_services::bots::ids::MIXY_AGENT_ID;
use mixdog_services::bots::ids::schedule_owner_agent_id;
use serde_json::Value;

use super::SessionDirectory;
use super::run::read_context;

const RUNTIME_MARKER: &str = "[mixdog-runtime]";
/// The creation greeting's opening (`CREATION_GREETING`: `(^|\n)` before it).
const CREATION_GREETING: &str = "[mixdog-runtime] The user just created you as ";

pub struct SessionAgentEvidence {
    directory: Arc<SessionDirectory>,
    routines: Arc<dyn RoutineRecords>,
}

impl SessionAgentEvidence {
    /// `routines` is the routine runtime's records (`StoreRoutineRecords` over the schedule and
    /// webhook stores).
    pub fn new(directory: Arc<SessionDirectory>, routines: Arc<dyn RoutineRecords>) -> Self {
        Self { directory, routines }
    }

    /// `(greeted, chatted)` of the agent's home thread.
    async fn home(&self, agent_id: &str) -> (bool, bool) {
        let session = mixdog_store::agent_mode::agent_home_session_id(agent_id);
        if session.is_empty() {
            return (false, false);
        }
        let deps = self.directory.deps();
        // Absent, deleted or unreadable: it proves nothing.
        let messages = read_context(&deps.store, &deps.lanes, &ThreadId::from(session.as_str())).await.unwrap_or_default();
        let (mut greeted, mut chatted) = (false, false);
        for (_, message) in &messages {
            if message.get("role").and_then(Value::as_str) != Some("user") {
                continue;
            }
            let text = message_text(message.get("content"));
            if text.starts_with(CREATION_GREETING) || text.contains(&format!("\n{CREATION_GREETING}")) {
                greeted = true;
            } else if !js_trim(&text).is_empty() && !js_trim_start(&text).starts_with(RUNTIME_MARKER) {
                chatted = true;
            }
        }
        (greeted, chatted)
    }
}

/// `messageText(content)`: a string, or the array's string parts and part texts joined by lines.
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.as_str(),
                _ => part.get("text").and_then(Value::as_str).unwrap_or(""),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[async_trait]
impl AgentEvidence for SessionAgentEvidence {
    async fn home_greeted(&self, agent_id: &str) -> bool {
        self.home(agent_id).await.0
    }

    async fn home_chatted(&self, agent_id: &str) -> bool {
        self.home(agent_id).await.1
    }

    async fn home_thread_route(&self, agent_id: &str) -> Option<Value> {
        let session = mixdog_store::agent_mode::agent_home_session_id(agent_id);
        let header = self.directory.stored_header(&ThreadId::from(session.as_str())).await?;
        let text = |key: &str| header.get(key).and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned();
        let (provider, model) = (text("provider"), text("model"));
        (!provider.is_empty() && !model.is_empty()).then(|| serde_json::json!({ "provider": provider, "model": model }))
    }

    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        // Both lists are read before deciding: either failing fails the answer (`Promise.all`).
        let schedules = self.routines.list(RoutineKind::Schedule).await?;
        let webhooks = self.routines.list(RoutineKind::Webhook).await?;
        Ok(schedules.iter().chain(&webhooks).any(|row| schedule_owner_agent_id(Some(&row.owner_agent_id)) == MIXY_AGENT_ID))
    }
}

#[cfg(test)]
#[path = "agent_evidence_tests.rs"]
mod tests;
