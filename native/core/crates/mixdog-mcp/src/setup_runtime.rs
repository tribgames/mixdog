//! [`SetupRuntime`] over the services of this crate: each `setup` action asks for what the
//! runtime API method of the same name does (Node's `rt.addMcpServer`, `rt.setDisabledSkills`,
//! `rt.addPlugin`, …), so the MCP, skills and plugins services answer it as they answer a client.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use serde_json::Value;
use serde_json::json;

use crate::setup_actions::SetupRuntime;

/// The setup actions' runtime: the MCP service (which also serves the connectors), the skills
/// service and the plugins service (which also serves `config/setExtensionScope`).
pub struct ServiceSetupRuntime {
    mcp: Arc<dyn DomainService>,
    skills: Arc<dyn DomainService>,
    plugins: Arc<dyn DomainService>,
}

impl ServiceSetupRuntime {
    pub fn new(mcp: Arc<dyn DomainService>, skills: Arc<dyn DomainService>, plugins: Arc<dyn DomainService>) -> Self {
        Self { mcp, skills, plugins }
    }
}

/// The message of a failed call, as Node's `Error.message`.
fn message_of(error: CoreError) -> String {
    match error {
        CoreError::DomainError { message: Some(message), .. } => message.to_string(),
        other => other.to_string(),
    }
}

async fn call(service: &dyn DomainService, method: &'static str, params: Value) -> Result<Value, String> {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("setup") };
    match service.call(request).await.map_err(message_of)? {
        Reply::Value(value) => Ok(value),
        _ => Err(format!("{method} did not answer a value")),
    }
}

#[async_trait]
impl SetupRuntime for ServiceSetupRuntime {
    async fn add_mcp_server(&self, input: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/addMcpServer", json!({"input": input})).await
    }

    async fn save_mcp_server(&self, input: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/saveMcpServer", json!({"input": input})).await
    }

    async fn remove_mcp_server(&self, name: &str) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/removeMcpServer", json!({"name": name})).await
    }

    async fn set_mcp_server_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/setMcpServerEnabled", json!({"name": name, "enabled": enabled})).await
    }

    async fn reconnect_mcp(&self, name: Option<&str>) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/reconnectMcp", name.map_or_else(|| json!({}), |n| json!({"name": n}))).await
    }

    async fn mcp_status(&self) -> Value {
        call(self.mcp.as_ref(), "mcp/mcpStatus", json!({})).await.unwrap_or_else(|_| json!({}))
    }

    async fn mcp_server_config(&self, name: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/getMcpServerConfig", json!({"name": name})).await
    }

    async fn set_disabled_skills(&self, names: &[String]) -> Result<Value, String> {
        call(self.skills.as_ref(), "skills/setDisabledSkills", json!({"names": names})).await
    }

    async fn set_extension_scope(&self, kind: &str, name: &str, projects: &[String]) -> Result<Value, String> {
        call(self.plugins.as_ref(), "config/setExtensionScope", json!({"kind": kind, "name": name, "projects": projects})).await
    }

    async fn add_plugin(&self, source: &str) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/addPlugin", json!({"source": source})).await
    }

    async fn update_plugin(&self, name: &str) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/updatePlugin", json!({"plugin": name})).await
    }

    async fn set_plugin_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/setPluginEnabled", json!({"plugin": name, "enabled": enabled})).await
    }

    async fn remove_plugin(&self, name: &str) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/removePlugin", json!({"plugin": name})).await
    }

    async fn plugins_status(&self) -> Value {
        call(self.plugins.as_ref(), "plugins/pluginsStatus", json!({})).await.unwrap_or_else(|_| json!({}))
    }

    async fn enable_plugin_mcp(&self, plugin: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/enablePluginMcp", json!({"plugin": plugin})).await
    }
}
