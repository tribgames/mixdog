//! The connector switches of an agent: Node's `workflow-agents-api/agent-connectors.mjs`
//! (`getAgentConnectors`, `setAgentConnectors`, `setAgentConnectorEnabled`,
//! `setAgentConnectorToolPermission`, `getAgentAlwaysAllowedTools`, `getAgentConnectorTools`).
//! The policy itself is read and written by [`AgentDefinitions`], which keeps every other key of
//! the agent's files; this module derives each edit from the policy stored when its turn comes.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::connectors::group_id;
use mixdog_mcp::connectors::tool_default_asks;
use mixdog_mcp::permissions::ConnectorPolicy;
use mixdog_mcp::permissions::Permission;
use mixdog_mcp::permissions::SELF_MCP_SERVER;
use mixdog_mcp::permissions::parse_connector_policy;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::AgentDefinitions;
use super::AgentsError;
use super::connectors::Parsed;
use super::connectors::Stored;
use super::connectors::assert_not_widened;
use super::connectors::stored_policy;
use super::connectors::tool_entries;

/// What the MCP service knows of the connectors: the installed ones and their tools.
#[async_trait]
pub trait ConnectorCatalog: Send + Sync {
    /// `listConnectors().map(({ id }) => id)`: the installed connectors, in listing order.
    async fn installed(&self) -> Result<Vec<String>, String>;
    /// `listConnectorTools(connectorId).map(({ name }) => name)`: the tools the connected server
    /// offers.
    async fn tool_names(&self, connector_id: &str) -> Result<Vec<String>, String>;
    /// `serverConnector(server)`: the catalog connector a configured server connects.
    fn connector_of(&self, server: &str) -> Option<String>;
}

/// [`ConnectorCatalog`] over the MCP service (`mcp/mcpStatus`, `connector/listConnectorTools`)
/// and the connector policy's record of which catalog connector each server connects.
pub struct McpConnectors {
    mcp: Arc<dyn DomainService>,
    policy: Arc<ConnectorPolicy>,
}

impl McpConnectors {
    pub fn new(mcp: Arc<dyn DomainService>, policy: Arc<ConnectorPolicy>) -> Self {
        Self { mcp, policy }
    }

    async fn ask(&self, method: &'static str, params: Value) -> Result<Value, String> {
        let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("agents") };
        match self.mcp.call(request).await {
            Ok(Reply::Value(value)) => Ok(value),
            Ok(_) => Err(format!("{method} did not answer a value")),
            Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
            Err(other) => Err(other.to_string()),
        }
    }
}

#[async_trait]
impl ConnectorCatalog for McpConnectors {
    async fn installed(&self) -> Result<Vec<String>, String> {
        let status = self.ask("mcp/mcpStatus", json!({})).await?;
        Ok(status
            .get("servers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|row| row.get("name").map_or_else(String::new, mixdog_js::value_to_string))
            .collect())
    }

    async fn tool_names(&self, connector_id: &str) -> Result<Vec<String>, String> {
        let tools = self.ask("connector/listConnectorTools", json!({ "connectorId": connector_id })).await?;
        Ok(tools
            .as_array()
            .into_iter()
            .flatten()
            .map(|tool| tool.get("name").map_or_else(String::new, mixdog_js::value_to_string))
            .collect())
    }

    fn connector_of(&self, server: &str) -> Option<String> {
        self.policy.connector_of(server)
    }
}

fn refused(message: impl Into<String>) -> AgentsError {
    AgentsError::Refused(message.into())
}

/// `requireId`: a string, trimmed, that is not empty.
fn require_id(value: &Value, label: &str) -> Result<String, AgentsError> {
    let id = value.as_str().map_or("", mixdog_js::js_trim);
    if id.is_empty() { Err(refused(format!("{label} is required"))) } else { Ok(id.to_owned()) }
}

/// `CONNECTOR_PERMISSIONS.join(', ')`.
const PERMISSIONS: &str = "auto, needs_approval, disabled";

pub struct AgentConnectors {
    agents: Arc<AgentDefinitions>,
    catalog: Arc<dyn ConnectorCatalog>,
}

impl AgentConnectors {
    pub fn new(agents: Arc<AgentDefinitions>, catalog: Arc<dyn ConnectorCatalog>) -> Self {
        Self { agents, catalog }
    }

    /// `switches(policy)`: each installed connector and whether the policy has it on.
    async fn switches(&self, stored: &Stored) -> Result<Value, AgentsError> {
        let installed = self.catalog.installed().await.map_err(refused)?;
        Ok(Value::Array(installed.iter().map(|id| json!({ "id": id, "enabled": stored.enabled(id) })).collect()))
    }

    /// `getAgentConnectors(agentId)`: `[{ id, enabled }]`.
    pub async fn list(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let stored = self.agents.connector_policy(agent_id).await?;
        self.switches(&stored).await
    }

    /// `editPolicy`: an edit derived from the policy stored when its turn in the agent's write
    /// queue comes, so two edits started together never undo each other, and the remote no-widen
    /// check judges that same policy.
    async fn edit(
        &self,
        agent_id: &str,
        no_widen: bool,
        derive: impl FnOnce(Vec<String>, Map<String, Value>) -> (Vec<String>, Map<String, Value>) + Send,
    ) -> Result<Stored, AgentsError> {
        // Node reads the installed connectors inside the turn (`editablePolicyOf(stored)`): a
        // connector installed while this edit waited is not enabled by migrating a legacy policy.
        self.agents
            .update_connector_policy_with(agent_id, self.catalog.installed(), move |stored, installed| {
                let (off, tools) = stored.editable(&installed);
                let (off, tools) = derive(off, tools);
                if no_widen {
                    let after = json!({ "off": off, "tools": tools });
                    assert_not_widened(stored.before().as_ref(), Some(&after), None)?;
                }
                Ok(stored_policy(off, &tools).unwrap_or(Value::Null))
            })
            .await
    }

    /// `setAgentConnectorEnabled`: switch one connector on or off for the agent; answers its
    /// switches.
    pub async fn set_enabled(&self, agent_id: &str, connector_id: &Value, enabled: &Value, no_widen: bool) -> Result<Value, AgentsError> {
        let id = require_id(connector_id, "connector id")?;
        let Value::Bool(enabled) = *enabled else { return Err(refused("enabled must be a boolean")) };
        self.edit(agent_id, no_widen, move |off, tools| {
            let off = if enabled {
                off.into_iter().filter(|entry| *entry != id).collect()
            } else {                off.into_iter().chain([id]).collect()
            };
            (off, tools)
        })
        .await?;
        self.list(agent_id).await
    }

    /// `setAgentConnectorToolPermission`: one tool's permission; `permission` null drops the
    /// tool's entry, so the tool is on its default again. Answers the policy.
    pub async fn set_tool_permission(
        &self,
        agent_id: &str,
        connector_id: &Value,
        tool_name: &Value,
        permission: &Value,
        no_widen: bool,
    ) -> Result<Value, AgentsError> {
        if !permission.is_null() && permission.as_str().is_none_or(|name| Permission::parse(name).is_none()) {
            return Err(refused(format!("permission must be one of {PERMISSIONS}")));
        }
        let server = require_id(connector_id, "connector id")?;
        let tool = require_id(tool_name, "tool name")?;
        // The accounts of one connector (`gmail`, `gmail-2`…) share the permission, stored once
        // under the connector's id; an entry an account kept of its own for this tool goes in the
        // same write.
        let group = group_id(&server);
        let permission = permission.clone();
        let stored = self
            .edit(agent_id, no_widen, move |off, tools| {
                let mut kept = Map::new();
                for id in mixdog_js::js_object_keys(&tools) {
                    let entries = &tools[id];
                    if *id == group || group_id(id) != group {
                        kept.insert(id.clone(), entries.clone());
                        continue;
                    }
                    let mut rest = entries.as_object().cloned().unwrap_or_default();
                    rest.shift_remove(&tool);
                    kept.insert(id.clone(), Value::Object(rest));
                }
                let mut own = kept.get(&group).and_then(Value::as_object).cloned().unwrap_or_default();
                if permission.is_null() {
                    own.shift_remove(&tool);
                } else {
                    own.insert(tool.clone(), permission);
                }
                kept.insert(group, Value::Object(own));
                (off, kept)
            })
            .await?;
        Ok(stored.json())
    }

    /// `getAgentAlwaysAllowedTools`: `[{ connector, tool }]`, the connector tools this agent may
    /// run without asking (an explicit `auto` entry in its own policy).
    pub async fn always_allowed(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let tools = self.agents.connector_policy(agent_id).await?.tools();
        let mut rows: Vec<(String, String)> = Vec::new();
        for connector in mixdog_js::js_object_keys(&tools) {
            let own = tools[connector].as_object().cloned().unwrap_or_default();
            for tool in mixdog_js::js_object_keys(&own) {
                if own[tool].as_str() == Some("auto") {
                    rows.push((connector.clone(), tool.clone()));
                }
            }
        }
        rows.sort_by(|a, b| mixdog_js::locale_compare(&a.0, &b.0).then_with(|| mixdog_js::locale_compare(&a.1, &b.1)));
        Ok(Value::Array(rows.into_iter().map(|(connector, tool)| json!({ "connector": connector, "tool": tool })).collect()))
    }

    /// `getAgentConnectorTools`: `[{ connector, tool, permission, explicit }]`, each installed
    /// connector's tools (the connected server's own, and any the agent's policy names) with the
    /// permission the agent has for the tool itself, so a connector switched off does not change
    /// it, and whether that is an entry of its own policy rather than the tool's default.
    pub async fn tools(&self, agent_id: &str) -> Result<Value, AgentsError> {
        let stored = self.agents.connector_policy(agent_id).await?;
        let installed = self.catalog.installed().await.map_err(refused)?;
        let (_, tools) = stored.editable(&installed);
        let mut rows = Vec::new();
        for connector in &installed {
            let group = group_id(connector);
            let mut names: Vec<String> = Vec::new();
            let mut add = |name: String| {
                if !names.contains(&name) {
                    names.push(name);
                }
            };
            for name in self.catalog.tool_names(connector).await.map_err(refused)? {
                add(name);
            }
            for account in mixdog_js::js_object_keys(&tools).into_iter().filter(|id| group_id(id) == group) {
                for name in tools[account].as_object().into_iter().flat_map(mixdog_js::js_object_keys) {
                    add(name.clone());
                }
            }
            for tool in names {
                let permission = self.permission(&tools, connector, &tool);
                let explicit = !tool_entries(&tools, &group, &tool).is_empty();
                rows.push(json!({ "connector": connector, "tool": tool, "permission": permission.name(), "explicit": explicit }));
            }
        }
        Ok(Value::Array(rows))
    }

    /// `connectorToolPermission({ off: [], tools }, { mcpServerName, mcpToolName })`.
    fn permission(&self, tools: &Map<String, Value>, connector: &str, tool: &str) -> Permission {
        let server = mixdog_js::js_trim(connector);
        if server.is_empty() || server == SELF_MCP_SERVER {
            return Permission::Auto;
        }
        if let Some(own) = tool_entries(tools, &group_id(server), tool).first() {
            return *own;
        }
        if tool_default_asks(self.catalog.connector_of(server).as_deref(), tool) { Permission::NeedsApproval } else { Permission::Auto }
    }

    /// `setAgentConnectors`: replace the agent's connector policy (`Null` removes it); with
    /// `no_widen` the replacement may not give any tool more authority than the stored policy.
    /// Answers the policy.
    pub async fn set(&self, agent_id: &str, connectors: &Value, no_widen: bool) -> Result<Value, AgentsError> {
        let given = connectors.clone();
        let stored = self
            .agents
            .update_connector_policy(agent_id, move |stored| {
                if no_widen {
                    let after = if given.is_null() {
                        None
                    } else {
                        parse_connector_policy(Some(&given))?;
                        Parsed::of_field(&given).map(|policy| policy.json())
                    };
                    assert_not_widened(stored.before().as_ref(), after.as_ref(), None)?;
                }
                Ok(given)
            })
            .await?;
        Ok(stored.json())
    }
}
