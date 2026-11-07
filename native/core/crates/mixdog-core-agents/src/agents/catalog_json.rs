//! The agent catalog as `listAgents` prints it (`workflow-agents-api/agent-editor.mjs`): the
//! rows of [`AgentDefinitions::rows`] with Node's keys in Node's order. A fixed service has no
//! `kind` or `avatar`; a custom agent has no `workflowSlot`. The setup tool's `agents` status
//! prints this list whole.

use super::*;

impl AgentRow {
    /// The row as `listAgents` returns it.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("label".into(), json!(self.label));
        out.insert("description".into(), json!(self.description));
        if self.fixed {
            out.insert("workflowSlot".into(), json!(FIXED_SLOTS.iter().find(|slot| slot.0 == self.id).map(|slot| slot.3)));
            out.insert("locked".into(), Value::Bool(true));
        } else {
            out.insert("custom".into(), Value::Bool(true));
        }
        out.insert("userOverride".into(), Value::Bool(self.user_override));
        out.insert("route".into(), self.route.clone());
        out.insert("routeConfigured".into(), Value::Bool(self.route_configured));
        if !self.fixed {
            out.insert("kind".into(), json!(self.kind));
        }
        out.insert("disabled".into(), Value::Bool(self.disabled));
        if !self.fixed {
            out.insert("avatar".into(), self.avatar.clone());
        }
        out.insert("definition".into(), self.definition.as_ref().map_or(Value::Null, definition_value));
        Value::Object(out)
    }
}

/// `loadAgentDefinition`'s object: `{ id, name, description, permission, frontmatter, kind, body, persona }`.
fn definition_value(definition: &AgentDefinition) -> Value {
    json!({
        "id": definition.id,
        "name": definition.name,
        "description": definition.description,
        "permission": definition.permission,
        "frontmatter": definition.frontmatter,
        "kind": definition.kind,
        "body": definition.body,
        "persona": definition.persona,
    })
}

impl AgentDefinitions {
    /// `listAgents()`: the fixed services, then every custom agent, as Node prints them.
    pub async fn catalog(&self) -> Result<Value, AgentsError> {
        Ok(Value::Array(self.rows().await?.iter().map(AgentRow::to_value).collect()))
    }
}