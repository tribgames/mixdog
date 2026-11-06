//! The `agent/` domain service for the agent definitions and permissions: the definition reads
//! and edits of `workflow-agents-api/agent-editor.mjs`, the connector switches of
//! `agent-connectors.mjs` and the permission table and approval audit of `human-gate/store.mjs`.
//! The service claims exactly [`METHODS`]; the lead and home methods of `agent/` belong to the
//! service that owns Mixy's identity.
//!
//! A method's answer is what Node's action returns, `null` for none. A Node `Error` reaches the
//! caller as a domain error carrying its message.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_rooms::rooms::home::Presence;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::AgentConnectors;
use super::AgentDefinitions;
use super::AgentsError;
use super::SaveOptions;
use super::permissions::AgentPermissions;

const DOMAIN: &str = "agent";

pub const METHODS: &[&str] = &[
    "agent/agentDefinitionPresence",
    "agent/archivedAgentIdentities",
    "agent/getAgentDefinition",
    "agent/getAgentAvatarImage",
    "agent/saveAgentDefinition",
    "agent/deleteAgentDefinition",
    "agent/restoreAgentDefinition",
    "agent/purgeAgentDefinition",
    "agent/getAgentConnectors",
    "agent/getAgentAlwaysAllowedTools",
    "agent/getAgentConnectorTools",
    "agent/getAgentPermissions",
    "agent/setAgentConnectors",
    "agent/setAgentConnectorEnabled",
    "agent/setAgentConnectorToolPermission",
    "agent/setAgentPermission",
    "agent/recordAgentApprovalAudit",
];

pub struct AgentService {
    agents: Arc<AgentDefinitions>,
    connectors: AgentConnectors,
    permissions: AgentPermissions,
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

fn failed(error: AgentsError) -> CoreError {
    match error {
        AgentsError::Lane(error) => error,
        other => CoreError::DomainError { domain: DOMAIN.into(), code: None, message: Some(other.to_string().into()), detail: None },
    }
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| invalid(&format!("params.{key}"), "string"))
}

/// `Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []`.
fn ids(params: &Value) -> Vec<String> {
    params.get("agentIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn presence_text(presence: Presence) -> &'static str {
    match presence {
        Presence::Present => "present",
        Presence::Deleted => "deleted",
        Presence::Unknown => "unknown",
    }
}

/// `options?.noWiden` as the editor and the connector writers read it: any truthy value.
fn no_widen(params: &Value) -> bool {
    truthy(params.get("options").and_then(|options| options.get("noWiden")))
}

impl AgentService {
    pub fn new(agents: Arc<AgentDefinitions>, connectors: AgentConnectors, permissions: AgentPermissions) -> Self {
        Self { agents, connectors, permissions }
    }

    async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, CoreError> {
        let arg = |key: &str| params.get(key).unwrap_or(&Value::Null);
        match method {
            "agent/agentDefinitionPresence" => {
                let wanted = ids(params);
                let found = self.agents.presence(&wanted).await.map_err(failed)?;
                let mut out = Map::new();
                for id in wanted {
                    let shown = found.get(&id).copied().map_or("unknown", presence_text);
                    out.insert(id, json!(shown));
                }
                Ok(Value::Object(out))
            }
            "agent/archivedAgentIdentities" => {
                let mut out = Map::new();
                for id in ids(params) {
                    let who = self.agents.archived_identity(&id).await.map_err(failed)?;
                    out.insert(id, who.map_or(Value::Null, |who| json!({ "name": who.name, "avatar": who.avatar })));
                }
                Ok(Value::Object(out))
            }
            "agent/getAgentDefinition" => self.agents.get(text(params, "agentId")?).await.map_err(failed),
            "agent/getAgentAvatarImage" => self.agents.avatar_image(text(params, "agentId")?).await.map_err(failed),
            "agent/saveAgentDefinition" => {
                let payload = params.get("payload").and_then(Value::as_object).ok_or_else(|| invalid("params.payload", "object"))?;
                let options = SaveOptions { no_widen: no_widen(params), approved: None };
                self.agents.save_with(payload, options).await.map_err(failed)
            }
            "agent/deleteAgentDefinition" => self.agents.delete(text(params, "agentId")?).await.map_err(failed),
            "agent/restoreAgentDefinition" => self.agents.restore(text(params, "agentId")?).await.map_err(failed),
            "agent/purgeAgentDefinition" => self.agents.purge(text(params, "agentId")?).await.map_err(failed),
            "agent/getAgentConnectors" => self.connectors.list(text(params, "agentId")?).await.map_err(failed),
            "agent/getAgentAlwaysAllowedTools" => self.connectors.always_allowed(text(params, "agentId")?).await.map_err(failed),
            "agent/getAgentConnectorTools" => self.connectors.tools(text(params, "agentId")?).await.map_err(failed),
            "agent/getAgentPermissions" => self.permissions.table(arg("agentId")).await.map_err(failed),
            "agent/setAgentConnectors" => {
                self.connectors.set(text(params, "agentId")?, arg("connectors"), no_widen(params)).await.map_err(failed)
            }
            "agent/setAgentConnectorEnabled" => {
                self.connectors.set_enabled(text(params, "agentId")?, arg("connectorId"), arg("enabled"), no_widen(params)).await.map_err(failed)
            }
            "agent/setAgentConnectorToolPermission" => self
                .connectors
                .set_tool_permission(text(params, "agentId")?, arg("connectorId"), arg("toolName"), arg("permission"), no_widen(params))
                .await
                .map_err(failed),
            "agent/setAgentPermission" => {
                // The permission store judges `noWiden` strictly: only `true` counts.
                let strict = params.get("options").and_then(|options| options.get("noWiden")) == Some(&Value::Bool(true));
                self.permissions.set(arg("agentId"), arg("action"), arg("mode"), strict).await.map_err(failed)
            }
            "agent/recordAgentApprovalAudit" => {
                self.permissions.record_audit(arg("agentId"), arg("action"), arg("decision")).await.map_err(failed)
            }
            other => Err(mixdog_core_base::support::wrong_method(DOMAIN, other)),
        }
    }
}

#[async_trait]
impl DomainService for AgentService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
