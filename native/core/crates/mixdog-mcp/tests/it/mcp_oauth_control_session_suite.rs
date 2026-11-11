//! Replay of `fixtures/mcp-oauth-control-session-cases` (`record-mcp-oauth-control-session-cases.mjs`, b6f10295a): an MCP sign-in
//! begun, polled and pasted while Node's desktop replaced its control session between the calls. The core has no control session:
//! the sign-in registry is the process's own (`McpLogins`, reached by the `mcp/*` methods of `McpService`), so the replay sends the
//! same calls in the same order to one `McpService` and compares each answer's value whole. As in Node, the registry is real and the
//! MCP client is the recording's fake: its interactive connect announces the recorded authorize URL, a paste other than the
//! recorded callback is refused with the recorded sentence, and the plain reconnect answers one unconnected server.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::mock::LiveLoginSession;
use mixdog_core_api::feed_publisher::LoginFeeds;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::mcp_logins::LoginBackend;
use mixdog_mcp::mcp_logins::McpLogins;
use mixdog_mcp::mcp_logins::Started;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::OAuthState;
use mixdog_mcp::oauth::account::AccountMode;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_testkit::exact::Exact;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const CASE: &str = "a remote sign-in survives the control session being replaced between begin, status polls and the paste";

fn observed() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/mcp-oauth-control-session-cases/golden.json");
    let golden = Exact::decode(&serde_json::from_str::<Value>(text).expect("golden.json")).expect("exact");
    let found = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == CASE).cloned();
    found.expect("the recorded case").get("observed").clone()
}

/// The recording's `{ mcpServers: { fixture: { type: 'http', url } } }`.
fn servers() -> Map<String, Value> {
    let mut agent = Map::new();
    agent.insert("mcpServers".to_owned(), json!({ "fixture": { "type": "http", "url": "http://127.0.0.1:9/mcp" } }));
    agent
}

struct Config;

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        servers()
    }
    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Err("not used".to_owned())
    }
    fn set_disabled_skills(&self, _: &[String]) {}
}

/// The recording's fake MCP client, for what the core's host does with it: the reconnect after a sign-out connects without a login
/// (`connectConfiguredMcp` answers the server unconnected; Node's `name: options.only` was undefined there and is not in the JSON).
struct Host;

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}
    async fn announce(&self, _: &str) {}
    async fn announce_without_invalidating(&self, _: &str) {}
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        json!({ "servers": [{ "connected": false, "error": null }] })
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

/// The interactive connect of the recording's fake client: it announces the authorize URL, takes the recorded callback and refuses
/// any other paste with the recorded sentence (`completeMcpLogin`), leaving the sign-in waiting.
struct Paste {
    live: LiveLoginSession,
    callback: String,
    refusal: String,
}

#[async_trait]
impl LoginSession for Paste {
    fn state(&self) -> LoginState {
        self.live.state()
    }
    async fn next(&self) -> Option<LoginState> {
        self.live.next().await
    }
    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        let LoginInput::AuthorizationCode(pasted) = &input;
        if *pasted != self.callback {
            return Err(LoginError::Failed(LoginFailure::Failed { code: "invalid_paste".into(), message: self.refusal.clone() }));
        }
        self.live.provide(input).await
    }
    fn cancel(&self) {
        self.live.cancel();
    }
}

struct Backend {
    auth_url: String,
    callback: String,
    refusal: String,
}

#[async_trait]
impl LoginBackend for Backend {
    async fn start(&self, _: &str, _: AccountMode, _: bool) -> Result<Started, String> {
        let live = LiveLoginSession::new(LoginState::Starting);
        live.emit(LoginState::Authorize { url: self.auth_url.clone(), manual_url: None });
        Ok(Started::Browser(Box::new(Paste { live, callback: self.callback.clone(), refusal: self.refusal.clone() })))
    }
    /// The fake connect resolves connected once the callback was taken.
    async fn settle(&self, _: &str, _: AccountMode, _: bool, _: Option<String>) -> (bool, Option<String>) {
        (true, None)
    }
    fn open_browser(&self, _: &str) {}
    async fn completed(&self, _: &str) {}
}

/// The runtime around the real sign-in registry: the recording's server is an OAuth one not signed in
/// (`getMcpServerOAuthState: { signedIn: false }`), its status lists no server, and clearing its sign-in revokes nothing.
struct Runtime {
    logins: McpLogins,
}

#[async_trait]
impl McpRuntime for Runtime {
    async fn scope_of_request(&self, _: Option<&str>) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn catalog(&self) -> Catalog {
        resolve_mcp_server_catalog(&Value::Object(servers()), &[], "", "")
    }
    async fn status(&self) -> Value {
        json!({ "servers": [] })
    }
    async fn server_config(&self, name: &str) -> Result<Value, String> {
        Err(format!("MCP server not configured: {name}"))
    }
    async fn plugins_status(&self) -> Value {
        json!({ "plugins": [] })
    }
    async fn await_keychain_prewarm(&self) {}
    async fn reload_full_config(&self) {}
    async fn oauth_state(&self, _: &Value) -> Option<OAuthState> {
        Some(OAuthState { signed_in: false, account: String::new() })
    }
    async fn begin_login(&self, name: &str, options: &Value) -> Result<Value, String> {
        self.logins.begin(name, options).await
    }
    async fn login_status(&self, flow_id: &str, options: &Value) -> Result<Value, String> {
        self.logins.status(flow_id, options).await
    }
    async fn cancel_login(&self, flow_id: &str) -> Result<Value, String> {
        self.logins.cancel(flow_id).await
    }
    async fn complete_login(&self, flow_id: &str, callback_url: &str) -> Result<Value, String> {
        self.logins.complete(flow_id, callback_url).await
    }
    async fn guard_sign_out(&self, name: &str) -> Box<dyn Send> {
        Box::new(self.logins.cancel_server(name).await)
    }
    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        Ok(false)
    }
    fn forget_account_health(&self, _: &str) {}
    async fn probe_auth(&self, _: &Value) -> Result<Value, String> {
        Ok(json!({ "auth": "oauth" }))
    }
    fn tools(&self) -> Vec<Value> {
        Vec::new()
    }
}

#[derive(Default)]
struct Keychain(Mutex<Map<String, Value>>);

#[async_trait]
impl SecretOps for Keychain {
    async fn save_gmail_app_password(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn forget_gmail_app_password(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn save_oauth_client_secret(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).and_then(Value::as_str).map(str::to_owned))
    }
    async fn write_secret(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(value) => self.0.lock().unwrap().insert(account.to_owned(), json!(value)),
            None => self.0.lock().unwrap().remove(account),
        };
        Ok(())
    }
    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        Ok(false)
    }
    fn forget_account_health(&self, _: &str) {}
    fn configured_servers(&self) -> Map<String, Value> {
        resolve_mcp_server_catalog(&Value::Object(servers()), &[], "", "").servers
    }
}

struct NoToasts;

impl mixdog_mcp::mcp_service::SessionToasts for NoToasts {
    fn closed(&self) -> bool {
        false
    }
    fn incarnation(&self, _: &str) -> Option<Arc<dyn mixdog_mcp::mcp_service::Incarnation>> {
        None
    }
}

/// One `mcp/*` call: its value, or the refusal as Node's thrown `Error`.
async fn call(service: &McpService, method: &'static str, params: Value) -> Value {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") };
    match service.call(request).await {
        Ok(Reply::Value(value)) => json!({ "value": value }),
        Ok(_) => panic!("{method}: not a value"),
        Err(CoreError::DomainError { message: Some(message), .. }) => json!({ "threw": { "name": "Error", "message": message.to_string() } }),
        Err(other) => panic!("{method}: {other:?}"),
    }
}

/// The value of a recorded control answer (`invokeControlResult`'s `value`; its `result` / `snapshot` are the desktop control
/// session's envelope, which the core has no counterpart of: manifest `replay.normalised.controlEnvelope`), with the flow id masked.
fn value_of(recorded: &Exact) -> Value {
    recorded.get("value").to_plain().expect("a plain value")
}

fn masked(value: &Value, flow: &str) -> Value {
    serde_json::from_str(&value.to_string().replace(flow, "<flow>")).expect("masking keeps JSON")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sign_in_survives_between_begin_polls_and_the_paste_as_node_recorded() {
    let observed = observed();
    let text = |key: &str| observed.get(key).as_str().to_owned();
    let (auth_url, callback) = (text("authUrl"), text("callback"));
    let refusal = match observed.get("invalidPaste").get("threw") {
        Exact::Error { message, .. } => message.clone(),
        other => panic!("a recorded refusal: {other:?}"),
    };
    let feeds = Arc::new(LoginFeeds::new(Arc::new(MockScopedFeeds::new(MockLimits::default()))));
    let backend = Arc::new(Backend { auth_url, callback: callback.clone(), refusal: refusal.clone() });
    let runtime = Arc::new(Runtime { logins: McpLogins::new(backend, feeds) });
    let home = tempfile::tempdir().expect("home");
    let secrets = Arc::new(McpServerSecrets::new(Arc::new(Keychain::default()), Default::default()));
    let service = McpService::new(Arc::new(Config), Arc::new(Host), runtime, secrets, home.path().join("home"), Arc::new(NoToasts));

    let sign_out = call(&service, "mcp/signOutMcpServer", json!({ "name": "fixture" })).await;
    assert_eq!(sign_out["value"], value_of(observed.get("signOut")), "the sign-out");
    let begun = call(&service, "mcp/beginMcpOAuthLogin", json!({ "name": "fixture", "options": { "openBrowser": false } })).await;
    let flow = begun["value"]["flowId"].as_str().expect("a flow id").to_owned();
    assert_eq!(masked(&begun["value"], &flow), value_of(observed.get("begun")), "the begin");
    // Node's status read failed once and the desktop retried it on a new control session; the core's read has no session to lose.
    let status = call(&service, "mcp/mcpStatus", json!({})).await;
    assert_eq!(status["value"], value_of(observed.get("statusRead").get("value")), "the status read");
    let polled = call(&service, "mcp/getMcpOAuthLoginStatus", json!({ "flowId": flow })).await;
    assert_eq!(masked(&polled["value"], &flow), value_of(observed.get("statusAfterReplace")), "the status after the replacement");
    let invalid = call(&service, "mcp/completeMcpOAuthLogin", json!({ "flowId": flow, "callbackUrl": "garbage" })).await;
    assert_eq!(invalid, json!({ "threw": { "name": "Error", "message": refusal } }), "the invalid paste");
    let still = call(&service, "mcp/getMcpOAuthLoginStatus", json!({ "flowId": flow })).await;
    assert_eq!(masked(&still["value"], &flow), value_of(observed.get("statusAfterInvalidPaste")), "the status after the invalid paste");
    let corrected = call(&service, "mcp/completeMcpOAuthLogin", json!({ "flowId": flow, "callbackUrl": callback })).await;
    assert_eq!(masked(&corrected["value"], &flow), value_of(observed.get("correctedPaste")), "the corrected paste");
    let last = call(&service, "mcp/getMcpOAuthLoginStatus", json!({ "flowId": flow })).await;
    assert_eq!(masked(&last["value"], &flow), value_of(observed.get("finalStatus")), "the final status");
}
