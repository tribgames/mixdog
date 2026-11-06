//! The contact bots: `isContactAgentId(id, readAgentDefinitionKind(id))` as the policy gate asks
//! it on every call (`human-gate/gate.mjs:131`). Nothing is cached: each call reads the
//! definition's kind afresh on the definitions lane.

use std::sync::Arc;

use super::AgentDefinitions;
use super::is_contact;

pub struct ContactIds {
    definitions: Arc<AgentDefinitions>,
}

impl ContactIds {
    pub fn new(definitions: Arc<AgentDefinitions>) -> Self {
        Self { definitions }
    }

    /// An unreadable definition has no kind, as Node's read that throws gives `null`.
    pub async fn is_contact_bot(&self, agent_id: &str) -> bool {
        let kind = self.definitions.definition_kind(agent_id).await.unwrap_or(None);
        is_contact(agent_id, kind.as_deref())
    }
}
