//! The notices a session posts around an MCP sign-in and sign-out, against what the session
//! extensions API of Node posted (`fixtures/mcp-login-notices`, recorded by
//! `record-mcp-login-notices.mjs` from the real `createSessionExtensionsApi` at b6f10295a): for
//! each flow the order of the runtime call, the notice (text and tone) and the reply, and the
//! reply or the failure itself.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::OAuthState;
use mixdog_mcp::mcp_service::SessionToasts;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Log = Arc<Mutex<Vec<Value>>>;

/// What the flow's runtime method answers (`runtime` of the recording): a result, or a failure.
type Script = Arc<Mutex<Value>>;

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

/// The runtime method a flow reaches answers its script and logs its entry, as the recording's runtime did.
struct Runtime {
    config: Map<String, Value>,
    script: Script,
    log: Log,
}

impl Runtime {
    fn answer(&self, method: &str) -> Result<Value, String> {
        self.log.lock().unwrap().push(json!({ "runtime": method }));
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
        self.answer("beginMcpOAuthLogin")
    }

    async fn login_status(&self, _: &str, _: &Value) -> Result<Value, String> {
        self.answer("getMcpOAuthLoginStatus")
    }

    async fn cancel_login(&self, _: &str) -> Result<Value, String> {
        self.answer("cancelMcpOAuthLogin")
    }

    async fn complete_login(&self, _: &str, _: &str) -> Result<Value, String> {
        self.answer("completeMcpOAuthLogin")
    }

    async fn guard_sign_out(&self, _: &str) -> Box<dyn Send> {
        Box::new(())
    }

    /// The sign-out's one runtime effect: whether the provider confirmed the revocation.
    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        let answered = self.answer("signOutMcpServer")?;
        Ok(answered["revoked"] == true)
    }

    fn forget_account_health(&self, _: &str) {}

    async fn probe_auth(&self, _: &Value) -> Result<Value, String> {
        self.answer("probeMcpServerAuth")
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

/// The session's notices, in the shape the recording logged them: `{notice: {text, tone}}`, with the thread they went to.
struct Toasts {
    log: Log,
    threads: Mutex<Vec<String>>,
}

#[async_trait]
impl SessionToasts for Toasts {
    async fn toast(&self, thread: &str, text: &str, tone: &str) {
        self.threads.lock().unwrap().push(thread.to_owned());
        self.log.lock().unwrap().push(json!({ "notice": { "text": text, "tone": tone } }));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_sign_in_flow_posts_the_notices_and_replies_in_the_order_node_did() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/mcp-login-notices/golden.json")).expect("fixture");
    let mut config = Map::new();
    config.insert("mcpServers".to_owned(), json!({"linear": {"type": "http", "url": "https://linear.example/mcp"}}));
    for flow in golden["flows"].as_array().expect("flows") {
        let name = flow["name"].as_str().unwrap();
        let log: Log = Arc::default();
        let script: Script = Arc::new(Mutex::new(flow["runtime"].clone()));
        let toasts = Arc::new(Toasts { log: Arc::clone(&log), threads: Mutex::default() });
        let service = McpService::new(
            Arc::new(Config(config.clone())),
            Arc::new(Host(Arc::clone(&script))),
            Arc::new(Runtime { config: config.clone(), script, log: Arc::clone(&log) }),
            Arc::new(McpServerSecrets::new(Arc::new(Ops), Default::default())),
            std::env::temp_dir(),
            toasts.clone(),
        );
        let method: &'static str = Box::leak(format!("mcp/{}", flow["method"].as_str().unwrap()).into_boxed_str());
        let mut params = flow["params"].clone();
        params["threadId"] = json!("t1");
        let outcome = service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await;
        log.lock().unwrap().push(json!("return"));
        match (outcome, flow["error"].as_str()) {
            (Ok(Reply::Value(got)), None) => assert_eq!(got, flow["reply"], "{name}: reply"),
            (Err(CoreError::DomainError { message: Some(got), .. }), Some(expected)) => assert_eq!(&*got, expected, "{name}: failure"),
            (other, expected) => panic!("{name}: got {other:?}, Node error {expected:?}"),
        }
        assert_eq!(Value::Array(log.lock().unwrap().clone()), flow["events"], "{name}: runtime call, notice and return in order");
        let posted: Vec<String> = flow["events"].as_array().unwrap().iter().filter(|e| e.get("notice").is_some()).map(|_| "t1".to_owned()).collect();
        assert_eq!(*toasts.threads.lock().unwrap(), posted, "{name}: the notice goes to the session that asked");
    }
}
