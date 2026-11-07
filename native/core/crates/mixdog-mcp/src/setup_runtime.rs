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

tokio::task_local! {
    /// The session whose setup action is running: the thread the action's `mcp/*` calls address.
    static SETUP_CALLER: String;
}

/// Runs `work` as the setup action of `thread`: its MCP calls act on that session's runtime, as the
/// setup tool's `rt.*` calls do in Node.
pub async fn as_caller<F: std::future::Future>(thread: &str, work: F) -> F::Output {
    SETUP_CALLER.scope(thread.to_owned(), work).await
}

/// `params` addressed to the running action's session (`threadId`); unchanged outside an action.
fn as_caller_params(mut params: Value) -> Value {
    if let Ok(thread) = SETUP_CALLER.try_with(Clone::clone) {
        params["threadId"] = json!(thread);
    }
    params
}

/// One call of `service` as the setup tool makes it (an internal caller); also the status readers' way in.
pub async fn call(service: &dyn DomainService, method: &'static str, params: Value) -> Result<Value, String> {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("setup") };
    match service.call(request).await.map_err(message_of)? {
        Reply::Value(value) => Ok(value),
        _ => Err(format!("{method} did not answer a value")),
    }
}

#[async_trait]
impl SetupRuntime for ServiceSetupRuntime {
    async fn add_mcp_server(&self, input: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/addMcpServer", as_caller_params(json!({"input": input}))).await
    }

    async fn save_mcp_server(&self, input: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/saveMcpServer", as_caller_params(json!({"input": input}))).await
    }

    async fn remove_mcp_server(&self, name: &str) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/removeMcpServer", as_caller_params(json!({"name": name}))).await
    }

    async fn set_mcp_server_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/setMcpServerEnabled", as_caller_params(json!({"name": name, "enabled": enabled}))).await
    }

    async fn reconnect_mcp(&self, name: Option<&str>) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/reconnectMcp", as_caller_params(name.map_or_else(|| json!({}), |n| json!({"name": n})))).await
    }

    async fn mcp_status(&self) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/mcpStatus", as_caller_params(json!({}))).await
    }

    async fn mcp_server_config(&self, name: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/getMcpServerConfig", as_caller_params(json!({"name": name}))).await
    }

    async fn set_disabled_skills(&self, names: &[String]) -> Result<Value, String> {
        call(self.skills.as_ref(), "skills/setDisabledSkills", json!({"names": names})).await
    }

    async fn set_extension_scope(&self, kind: &str, name: &str, projects: &[String]) -> Result<Value, String> {
        call(self.plugins.as_ref(), "config/setExtensionScope", as_caller_params(json!({"kind": kind, "name": name, "projects": projects}))).await
    }

    async fn add_plugin(&self, source: &str) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/addPlugin", as_caller_params(json!({"source": source}))).await
    }

    async fn update_plugin(&self, name: &str) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/updatePlugin", as_caller_params(json!({"plugin": name}))).await
    }

    async fn set_plugin_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/setPluginEnabled", as_caller_params(json!({"plugin": name, "enabled": enabled}))).await
    }

    async fn remove_plugin(&self, name: &str) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/removePlugin", as_caller_params(json!({"plugin": name}))).await
    }

    async fn plugins_status(&self) -> Result<Value, String> {
        call(self.plugins.as_ref(), "plugins/pluginsStatus", as_caller_params(json!({}))).await
    }

    async fn enable_plugin_mcp(&self, plugin: &Value) -> Result<Value, String> {
        call(self.mcp.as_ref(), "mcp/enablePluginMcp", as_caller_params(json!({"plugin": plugin}))).await
    }
}
