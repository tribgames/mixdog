//! The contact bots, answered without waiting: `isContactAgentId(id, readAgentDefinitionKind(id))`
//! as the policy gate asks it on every call. Node reads the definition from disk on the spot; the
//! definitions here are read on the lane, so the answer is a snapshot taken by [`ContactIds::refresh`].

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::RwLock;

use super::AgentDefinitions;
use super::AgentsError;
use super::is_contact;

pub struct ContactIds {
    definitions: Arc<AgentDefinitions>,
    ids: RwLock<HashSet<String>>,
}

impl ContactIds {
    /// Empty until the first [`refresh`](Self::refresh): no one is a contact bot before the
    /// definitions have been read.
    pub fn new(definitions: Arc<AgentDefinitions>) -> Self {
        Self { definitions, ids: RwLock::new(HashSet::new()) }
    }

    /// Rereads every custom agent's kind. Called at start and whenever the definitions change
    /// (`AgentEffects::agents_changed`). A disabled agent still counts: Node's rule does not read
    /// the roster switch.
    pub async fn refresh(&self) -> Result<(), AgentsError> {
        let mut found = HashSet::new();
        for id in self.definitions.custom_agent_ids().await? {
            let kind = self.definitions.load(&id).await?.and_then(|definition| definition.kind);
            if is_contact(&id, kind.as_deref()) {
                found.insert(id);
            }
        }
        *self.ids.write().unwrap_or_else(std::sync::PoisonError::into_inner) = found;
        Ok(())
    }

    /// `isContactAgentId(id, kind)` over the last snapshot; the id is normalized as Node does
    /// (trimmed, lower-cased).
    pub fn is_contact_bot(&self, agent_id: &str) -> bool {
        let id = mixdog_js::js_trim(agent_id).to_lowercase();
        self.ids.read().unwrap_or_else(std::sync::PoisonError::into_inner).contains(&id)
    }
}
