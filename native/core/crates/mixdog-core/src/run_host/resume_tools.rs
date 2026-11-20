//! `_prepareResumeTools(session, preset)` (Node `session/manager/session-tool-surface.mjs:127-160`):
//! the tool list a stored session resolves to now, with the spec it was resolved from. A route
//! change refills the session's tools from it (`resetSessionForRouteChange`,
//! `session-lifecycle.mjs:459-461`): this is the [`PrepareTools`] of `AiRouteFacts`.
//!
//! The skills are collected inside the call, as Node's `collectPromptSkillsCached` collects when its
//! cache is stale (`skill-catalog.mjs:390-416`): [`SkillsListed::any_for`] reads the one catalog
//! cache and collects again after an invalidation, so a route change right after a skill write sees
//! it.
//!
//! Node's agent-runtime profile branch (`:131-139`, `profile.tools` for a `profileId`) is not
//! ported: `setAgentRuntime()` has no live caller (`session-lifecycle.mjs:260-262`), so it never
//! fires.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::agent_variants::agent_definitions;
use super::agent_variants::bind_agent_docs;
use super::reactions::REACTION_TOOL_NAME;
use super::route_surface::PrepareTools;
use super::route_surface::PreparedTools;
use super::route_surface::is_agent_owner;
use super::rules::RulesPolicy;
use super::session_tools::Resolve;
use super::session_tools::SessionMcp;
use super::session_tools::SkillsListed;
use super::session_tools::header_scope;
use super::session_tools::resolve;
use super::session_tools::session_doc;
use super::tool_surface::truthy;

/// The producer: the registered tools, the connected servers' tools and the skill catalog.
pub struct ResumeTools {
    /// Every registered tool (the `SessionToolBuilder` pool).
    pub pool: Vec<Arc<dyn Tool>>,
    pub mcp: Arc<dyn SessionMcp>,
    /// `collectPromptSkillsCached(cwd).length > 0` (`mcp_seams::CatalogSkillsListed`).
    pub skills: Arc<dyn SkillsListed>,
    /// `getHiddenAgent` and `delegationDisabled`.
    pub policy: Arc<dyn RulesPolicy>,
}

/// `reactionDisabled(source, ownerIsAgent)` (`session-tool-surface.mjs:33-36`): the react tool
/// belongs to a bot's home chat or its seat in a room, decided by the session's id.
pub(super) fn reaction_disabled(session: &Value, owner_is_agent: bool) -> bool {
    let id = session.get("id").map(value_to_string).unwrap_or_default();
    owner_is_agent || !(agent_id_of_home_session(&id).is_some() || room_member_of_session(&id).is_some())
}

/// The session's working folder (empty when it has none).
pub(super) fn header_cwd(header: &Header) -> PathBuf {
    header.get("cwd").and_then(Value::as_str).map(PathBuf::from).unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| items.iter().map(value_to_string).collect())
}


impl ResumeTools {
    /// `_prepareResumeTools(session, session.preset || 'full')`, the call a route change makes. A
    /// skill list that cannot be collected is the error, never "no skills".
    pub async fn prepare_tools(&self, header: &Header) -> Result<PreparedTools, String> {
        let skills_listed = self.skills_listed(&header_cwd(header)).await?;
        self.prepare_tools_with(header, skills_listed)
    }

    /// `collectPromptSkillsCached(cwd).length > 0`: the one outside read of `prepare_tools_with`.
    pub async fn skills_listed(&self, cwd: &std::path::Path) -> Result<bool, String> {
        self.skills.any_for(cwd).await
    }

    /// `prepare_tools` over a skill listing already collected: synchronous and pure.
    pub fn prepare_tools_with(&self, header: &Header, skills_listed: bool) -> Result<PreparedTools, String> {
        let session = Value::Object(header.clone());
        let owner_is_agent = is_agent_owner(&session);
        let cwd = header_cwd(header);
        // `ownerIsAgent ? 'full' : preset || session.preset || 'full'`, with `preset` itself
        // `session.preset || 'full'`.
        let tool_spec = match header.get("preset") {
            _ if owner_is_agent => json!("full"),
            Some(preset) if truthy(Some(preset)) => preset.clone(),
            _ => json!("full"),
        };
        // `honoredSchemaAllowlist`: an agent worker's allowlist binds only a hidden role.
        let agent = header.get("agent").and_then(Value::as_str);
        let schema_allowed = strings(header.get("schemaAllowedTools")).filter(|_| !owner_is_agent || self.policy.hidden_agent(agent));
        let mut disallowed = strings(header.get("disallowedTools")).unwrap_or_default();
        if self.policy.delegation_disabled(&session, owner_is_agent) {
            disallowed.push("agent".into());
        }
        if reaction_disabled(&session, owner_is_agent) {
            disallowed.push(REACTION_TOOL_NAME.into());
        }
        let model = header.get("model").and_then(Value::as_str).map_or("", js_trim);
        // `_getMcpTools(session.mcpScopeId, cwd)`: the servers registered under the session's scope
        // (`normalizeMcpScopeId`: empty is the default one), in the hub under that scope.
        let scope = header_scope(header);
        let tools = resolve(
            &self.pool,
            self.mcp.tools(scope, &cwd),
            &Resolve {
                tool_spec: Some(&tool_spec),
                model,
                skills_listed,
                agent_owned: owner_is_agent,
                schema_allowed: schema_allowed.as_deref(),
                disallowed: &disallowed,
            },
        );
        // The tool's stored entry, publisher included: a connected MCP tool carries its server and its own name for the tool,
        // shortened or not (`mcpServerTools`, `mcp/client.mjs:1641-1646` held them for a shortened name only).
        let docs: Vec<Value> = tools.iter().map(|tool| session_doc(&self.pool, tool)).collect();
        // `bindAgentOwner` (`finalizeSessionToolList`, `tool-resolution.mjs:72-75`): an agent's
        // session holds the agent text of `git` and `task` (`Tool::agent_spec`).
        let docs = if owner_is_agent { bind_agent_docs(docs, &agent_definitions(&self.pool)) } else { docs };
        Ok(PreparedTools { tools: Value::Array(docs), tool_spec })
    }
}

fn kept_on_error(prepared: Result<PreparedTools, String>) -> Option<PreparedTools> {
    prepared
        .inspect_err(|error| tracing::warn!(%error, "[session] route change kept the stored tools"))
        .ok()
}

#[async_trait]
impl PrepareTools for ResumeTools {
    /// A skill list that cannot be collected keeps the stored tools and says why.
    async fn prepare(&self, header: &Header) -> Option<PreparedTools> {
        kept_on_error(self.prepare_tools(header).await)
    }

    async fn skills_listed(&self, cwd: &std::path::Path) -> Result<bool, String> {
        ResumeTools::skills_listed(self, cwd).await
    }

    fn prepare_with(&self, header: &Header, skills_listed: bool) -> Option<PreparedTools> {
        kept_on_error(self.prepare_tools_with(header, skills_listed))
    }
}

#[cfg(test)]
mod tests {
}


