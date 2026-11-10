//! A scripted MCP service for the tests that replay a recorded sign-in flow (`fixtures/mcp-login-notices`,
//! `fixtures/mcp-login-notice-failures`): the real [`McpService`] over a config of one server, `linear`, whose runtime answers
//! the flow's script and logs its entry, as the recordings' runtime did. A runtime that is parked tells when it was entered
//! and answers only when released, so a test acts in the middle of the awaited action by signals.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::extension_service::ExtensionConfig;
use crate::extension_service::ExtensionHost;
use crate::mcp_secrets::McpServerSecrets;
use crate::mcp_secrets::SecretOps;
use crate::mcp_service::McpRuntime;
use crate::mcp_service::McpService;
use crate::mcp_service::OAuthState;
use crate::mcp_service::SessionToasts;
use crate::plugin_servers::Catalog;
use crate::plugin_servers::resolve_mcp_server_catalog;

/// The ordered events of a flow, in the recordings' shape.
pub type Log = Arc<Mutex<Vec<Value>>>;

/// What the flow's runtime method answers (`runtime` of the recording): `{result}` or `{throws}`.
pub type Script = Arc<Mutex<Value>>;

/// A runtime action held in the middle: `entered` is told when it began, and it answers when `go` is told.
#[derive(Default)]
pub struct Park {
    pub entered: tokio::sync::Notify,
    pub go: tokio::sync::Notify,
}

/// The config of one HTTP server, `linear`.
pub fn config() -> Map<String, Value> {
    let mut config = Map::new();
    config.insert("mcpServers".to_owned(), json!({"linear": {"type": "http", "url": "https://linear.example/mcp"}}));
    config
}

/// The service over `script`, its runtime parked by `park` when given, and `toasts` as the sessions.
pub fn service(script: Script, log: Log, park: Option<Arc<Park>>, toasts: Arc<dyn SessionToasts>) -> McpService {
    let config = config();
    McpService::new(
        Arc::new(Config(config.clone())),
        Arc::new(Host(Arc::clone(&script))),
        Arc::new(Runtime { config, script, log, park }),
        Arc::new(McpServerSecrets::new(Arc::new(Ops), Default::default())),
        std::env::temp_dir(),
        toasts,
    )
}

struct Config(Map<String, Value>);

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.0.clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

/// The sign-out's reconnect answers the status the flow's runtime scripted.
struct Host(Script);

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}
    async fn announce(&self, _: &str) {}
    async fn announce_without_invalidating(&self, _: &str) {}

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        let mut status = self.0.lock().unwrap()["result"].as_object().cloned().unwrap_or_default();
        status.shift_remove("revoked");
        Value::Object(status)
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        json!({})
    }

    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        json!({})
    }

    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        json!({})
    }

    fn invalidate_skills(&self) {}
    async fn flush_skills_save(&self) {}

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(std::env::temp_dir())
    }

    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(Value::Object(Map::new()))
    }

    async fn skills_status(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

struct Runtime {
    config: Map<String, Value>,
    script: Script,
    log: Log,
    park: Option<Arc<Park>>,
}

impl Runtime {
    async fn answer(&self, method: &str) -> Result<Value, String> {
        self.log.lock().unwrap().push(json!({ "runtime": method }));
        if let Some(park) = &self.park {
            park.entered.notify_one();
            park.go.notified().await;
        }
        let script = self.script.lock().unwrap();
        match script["throws"].as_str() {
            Some(message) => Err(message.to_owned()),
            None => Ok(script["result"].clone()),
        }
    }
}

#[async_trait]
impl McpRuntime for Runtime {
    async fn scope_of_request(&self, _: Option<&str>) -> Result<Option<String>, String> {
        Ok(None)
    }

    async fn catalog(&self) -> Catalog {
        resolve_mcp_server_catalog(&Value::Object(self.config.clone()), &[], "", "")
    }

    async fn status(&self) -> Value {
        json!({"servers": []})
    }

    async fn server_config(&self, name: &str) -> Result<Value, String> {
        Err(format!("MCP server not configured: {name}"))
    }

    async fn plugins_status(&self) -> Value {
        json!({"plugins": []})
    }

    async fn await_keychain_prewarm(&self) {}
    async fn reload_full_config(&self) {}

    async fn oauth_state(&self, _: &Value) -> Option<OAuthState> {
        Some(OAuthState { signed_in: true, account: String::new() })
    }

    async fn begin_login(&self, _: &str, _: &Value) -> Result<Value, String> {
        self.answer("beginMcpOAuthLogin").await
    }

    async fn login_status(&self, _: &str, _: &Value) -> Result<Value, String> {
        self.answer("getMcpOAuthLoginStatus").await
    }

    async fn cancel_login(&self, _: &str) -> Result<Value, String> {
        self.answer("cancelMcpOAuthLogin").await
    }

    async fn complete_login(&self, _: &str, _: &str) -> Result<Value, String> {
        self.answer("completeMcpOAuthLogin").await
    }

    async fn guard_sign_out(&self, _: &str) -> Box<dyn Send> {
        Box::new(())
    }

    /// The sign-out's one runtime effect: whether the provider confirmed the revocation.
    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        let answered = self.answer("signOutMcpServer").await?;
        Ok(answered["revoked"] == true)
    }

    fn forget_account_health(&self, _: &str) {}

    async fn probe_auth(&self, _: &Value) -> Result<Value, String> {
        self.answer("probeMcpServerAuth").await
    }

    fn tools(&self) -> Vec<Value> {
        Vec::new()
    }
}

struct Ops;

#[async_trait]
impl SecretOps for Ops {
    async fn save_gmail_app_password(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }

    async fn forget_gmail_app_password(&self, _: &str) -> Result<(), String> {
        Ok(())
    }

    async fn save_oauth_client_secret(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }

    async fn read_secret(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    async fn write_secret(&self, _: &str, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }

    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        Ok(false)
    }

    fn forget_account_health(&self, _: &str) {}

    fn configured_servers(&self) -> Map<String, Value> {
        Map::new()
    }
}
