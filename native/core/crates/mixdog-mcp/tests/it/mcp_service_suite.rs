//! The MCP methods of the runtime API over a config kept in memory: what adding, saving, removing and switching a server writes to the config and
//! asks of the process (reconnects, toggles, announcements), the refusals in the words users read, how a plugin's server is left alone, and what
//! signing out or starting a sign-in announces to the session that asked. (Node `session-runtime/mcp-api.mjs`, whose answers these keep.)

use std::path::PathBuf;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::config::Env;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_service::Incarnation;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::OAuthState;
use mixdog_mcp::mcp_service::SessionToasts;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::plugin_servers::Declared;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_mcp::plugins::DeclaredServer;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Log = Arc<Mutex<Vec<String>>>;

struct Config {
    agent: Mutex<Map<String, Value>>,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
        *self.agent.lock().unwrap() = after.clone();
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

struct Host {
    log: Log,
}

impl Host {
    fn note(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}

    async fn announce(&self, _: &str) {}

    async fn announce_without_invalidating(&self, _: &str) {}

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, enabled: bool, drop: &[String]) -> Value {
        self.note(format!("reconnect:{}:{enabled}:{}", only.unwrap_or("-"), drop.join(",")));
        json!({"status": "reconnected"})
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        self.note("reconnect-all".to_owned());
        json!({"status": "all"})
    }

    async fn schedule_mcp_toggle(&self, name: &str, enabled: bool) -> Value {
        self.note(format!("toggle:{name}:{enabled}"));
        json!({"status": "toggled"})
    }

    async fn publish_mcp_changes(&self, changes: &[(String, bool)]) {
        self.note(format!("publish:{}", changes.iter().map(|(n, e)| format!("{n}={e}")).collect::<Vec<_>>().join(",")));
    }

    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    fn invalidate_skills(&self) {}

    async fn flush_skills_save(&self) {}

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(PathBuf::from("/work"))
    }

    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(Value::Object(Map::new()))
    }

    async fn skills_status(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

struct Runtime {
    config: Arc<Config>,
    declared: Vec<Declared>,
    log: Log,
    login_state: &'static str,
    signed_in: bool,
    tools: Vec<Value>,
}

#[async_trait]
impl McpRuntime for Runtime {
    async fn scope_of_request(&self, _: Option<&str>) -> Result<Option<String>, String> {
        Ok(None)
    }

    async fn catalog(&self) -> Catalog {
        resolve_mcp_server_catalog(&Value::Object(self.config.agent()), &self.declared, "/work", "/data")
    }

    async fn status(&self) -> Value {
        let catalog = self.catalog().await;
        json!({"servers": catalog.servers.keys().map(|name| json!({"name": name})).collect::<Vec<_>>()})
    }

    async fn server_config(&self, name: &str) -> Result<Value, String> {
        self.catalog().await.servers.get(name).cloned().ok_or_else(|| format!("MCP server not configured: {name}"))
    }

    async fn plugins_status(&self) -> Value {
        Value::Null
    }

    async fn await_keychain_prewarm(&self) {}

    async fn reload_full_config(&self) {}

    async fn oauth_state(&self, cfg: &Value) -> Option<OAuthState> {
        cfg.get("url").map(|_| OAuthState { signed_in: self.signed_in, account: String::new() })
    }

    async fn begin_login(&self, name: &str, options: &Value) -> Result<Value, String> {
        self.log.lock().unwrap().push(format!("begin:{name}:{}", options["mode"].as_str().unwrap_or("")));
        Ok(json!({"state": self.login_state}))
    }

    async fn login_status(&self, _: &str, _: &Value) -> Result<Value, String> {
        Ok(Value::Null)
    }

    async fn cancel_login(&self, _: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }

    async fn complete_login(&self, _: &str, _: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }

    async fn guard_sign_out(&self, name: &str) -> Box<dyn Send> {
        self.log.lock().unwrap().push(format!("guard:{name}"));
        Box::new(())
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        self.log.lock().unwrap().push(format!("clear:{}", cfg["url"].as_str().unwrap_or("")));
        Ok(true)
    }

    fn forget_account_health(&self, _: &str) {}

    async fn probe_auth(&self, probe: &Value) -> Result<Value, String> {
        Ok(json!({"probed": probe}))
    }

    fn tools(&self) -> Vec<Value> {
        self.tools.clone()
    }
}

struct NoSecrets;

#[async_trait]
impl SecretOps for NoSecrets {
    async fn save_gmail_app_password(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn forget_gmail_app_password(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn save_oauth_client_secret(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        Ok(false)
    }
    async fn read_secret(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn write_secret(&self, _: &str, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    fn forget_account_health(&self, _: &str) {}
    fn configured_servers(&self) -> Map<String, Value> {
        Map::new()
    }
}

struct Session {
    log: Log,
}

#[async_trait]
impl Incarnation for Session {
    async fn toast(&self, text: &str, tone: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("toast:{tone}:{text}"));
        Ok(())
    }

    fn disposed(&self) -> bool {
        false
    }
}

struct Toasts {
    session: Arc<Session>,
    closed: bool,
}

impl SessionToasts for Toasts {
    fn closed(&self) -> bool {
        self.closed
    }

    fn incarnation(&self, thread: &str) -> Option<Arc<dyn Incarnation>> {
        (thread == "t1").then(|| self.session.clone() as Arc<dyn Incarnation>)
    }
}

struct Fixture {
    service: McpService,
    config: Arc<Config>,
    runtime: Arc<Runtime>,
    log: Log,
}

fn fixture(servers: Value, declared: Vec<Declared>, signed_in: bool, login_state: &'static str, closed: bool) -> Fixture {
    let log: Log = Arc::default();
    let agent = json!({"mcpServers": servers}).as_object().cloned().unwrap();
    let config = Arc::new(Config { agent: Mutex::new(agent) });
    let tools = vec![
        json!({"name": "mcp__gmail__send", "description": "Send mail", "annotations": {"readOnlyHint": false}, "mcpServerName": "gmail", "mcpToolName": "send"}),
        json!({"name": "mcp__gmail__read", "annotations": {"readOnlyHint": true}, "mcpServerName": "gmail", "mcpToolName": "read"}),
        json!({"name": "mcp__other__ping", "description": "x", "mcpServerName": "other", "mcpToolName": "ping"}),
        json!({"name": "mcp__gmail__bare", "mcpServerName": "gmail", "mcpToolName": "bare"}),
    ];
    let runtime = Arc::new(Runtime { config: config.clone(), declared, log: log.clone(), login_state, signed_in, tools });
    let env: Env = Env::default();
    let service = McpService::new(
        config.clone(),
        Arc::new(Host { log: log.clone() }),
        runtime.clone(),
        Arc::new(McpServerSecrets::new(Arc::new(NoSecrets), env)),
        Path::new("/home/user").to_path_buf(),
        Arc::new(Toasts { session: Arc::new(Session { log: log.clone() }), closed }),
    );
    Fixture { service, config, runtime, log }
}

async fn call(f: &Fixture, method: &'static str, params: Value) -> Result<Value, String> {
    match f.service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await {
        Ok(Reply::Value(value)) => Ok(value),
        Ok(_) => panic!("not a value"),
        Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
        Err(other) => panic!("{other:?}"),
    }
}

fn stored(f: &Fixture) -> Value {
    f.config.agent()["mcpServers"].clone()
}

fn plugin_declared() -> Vec<Declared> {
    let server = DeclaredServer { key: "tool".to_owned(), config: json!({"command": "node"}), source: PathBuf::from("/plugins/alpha/.mcp.json") };
    vec![Declared {
        plugin: json!({"id": "alpha-536a8a2d", "name": "alpha", "root": "/plugins/alpha", "enabled": true}),
        missing: false,
        format: "claude",
        servers: vec![server],
        errors: Vec::new(),
    }]
}

fn plain() -> Fixture {
    fixture(json!({"demo": {"type": "stdio", "command": "node", "args": ["s.js"]}, "remote": {"type": "http", "url": "https://x.example/mcp"}}), Vec::new(), true, "pending", false)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_added_server_is_stored_under_its_slug_and_connected_and_a_taken_name_is_refused() {
    let f = fixture(json!({}), Vec::new(), true, "pending", false);
    let added = call(&f, "mcp/addMcpServer", json!({"input": {"name": " New Server ", "command": "node", "args": "a.js"}})).await.unwrap();
    assert_eq!(added, json!({"name": "new-server", "status": {"status": "reconnected"}}));
    assert_eq!(stored(&f), json!({"new-server": {"type": "stdio", "command": "node", "args": ["a.js"]}}));
    assert_eq!(*f.log.lock().unwrap(), ["reconnect:new-server:true:"]);
    let again = call(&f, "mcp/addMcpServer", json!({"input": {"name": "new-server", "command": "other"}})).await;
    assert_eq!(again.unwrap_err(), "MCP server already exists: new-server");
    assert_eq!(call(&f, "mcp/addMcpServer", json!({"input": {"name": "x"}})).await.unwrap_err(), "MCP server command or URL is required");
    assert_eq!(call(&f, "mcp/addMcpServer", json!({"input": {"name": "c", "command": "x", "connector": "nonesuch"}})).await.unwrap_err(), "Unknown connector: nonesuch");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_server_keeps_what_the_edit_leaves_alone_and_a_rename_drops_the_old_name() {
    let f = plain();
    let saved = call(&f, "mcp/saveMcpServer", json!({"input": {"originalName": "demo", "name": "renamed", "timeoutMs": 2000}})).await.unwrap();
    assert_eq!(saved["name"], "renamed");
    assert_eq!(saved["source"], "config");
    let servers = stored(&f);
    assert!(servers.get("demo").is_none());
    assert_eq!(servers["renamed"]["command"], "node");
    assert_eq!(servers["renamed"]["args"], json!(["s.js"]));
    assert_eq!(servers["renamed"]["timeoutMs"].as_f64(), Some(2000.0));
    assert_eq!(*f.log.lock().unwrap(), ["reconnect:renamed:true:demo"]);

    assert_eq!(call(&f, "mcp/saveMcpServer", json!({"input": {"originalName": "ghost", "name": "ghost", "command": "x"}})).await.unwrap_err(), "MCP server not configured: ghost");
    assert_eq!(call(&f, "mcp/saveMcpServer", json!({"input": {"originalName": "renamed", "name": "remote", "command": "x"}})).await.unwrap_err(), "MCP server already exists: remote");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_server_leaves_the_config_and_is_dropped_from_the_process() {
    let f = plain();
    assert_eq!(call(&f, "mcp/removeMcpServer", json!({"name": "  "})).await.unwrap_err(), "MCP server name is required");
    assert_eq!(call(&f, "mcp/removeMcpServer", json!({"name": "ghost"})).await.unwrap_err(), "MCP server not configured: ghost");
    call(&f, "mcp/removeMcpServer", json!({"name": "demo"})).await.unwrap();
    assert_eq!(stored(&f), json!({"remote": {"type": "http", "url": "https://x.example/mcp"}}));
    assert_eq!(*f.log.lock().unwrap(), ["reconnect:-:true:demo"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn switching_a_server_off_and_on_writes_its_flag_and_schedules_the_toggle() {
    let f = plain();
    call(&f, "mcp/setMcpServerEnabled", json!({"name": "demo", "enabled": false})).await.unwrap();
    assert_eq!(stored(&f)["demo"]["enabled"], false);
    call(&f, "mcp/setMcpServerEnabled", json!({"name": "demo", "enabled": true})).await.unwrap();
    assert_eq!(stored(&f)["demo"]["enabled"], true);
    assert_eq!(*f.log.lock().unwrap(), ["toggle:demo:false", "publish:demo=false", "toggle:demo:true", "publish:demo=true"]);
    assert_eq!(call(&f, "mcp/setMcpServerEnabled", json!({"name": "ghost", "enabled": true})).await.unwrap_err(), "MCP server not configured: ghost");
    assert_eq!(call(&f, "mcp/setMcpServerEnabled", json!({"name": "", "enabled": true})).await.unwrap_err(), "MCP server name is required");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugins_server_cannot_be_edited_or_removed_but_can_be_switched_and_the_choice_is_the_plugins_intent() {
    let f = fixture(json!({}), plugin_declared(), true, "pending", false);
    let refused = "MCP server \"plugin-alpha-tool\" is provided by plugin \"alpha-536a8a2d\" (server \"tool\"); enable or disable it with set_mcp_enabled, or manage the plugin instead";
    assert_eq!(call(&f, "mcp/removeMcpServer", json!({"name": "plugin-alpha-tool"})).await.unwrap_err(), refused);
    assert_eq!(call(&f, "mcp/saveMcpServer", json!({"input": {"originalName": "plugin-alpha-tool", "name": "plugin-alpha-tool", "command": "x"}})).await.unwrap_err(), refused);
    assert_eq!(call(&f, "mcp/addMcpServer", json!({"input": {"name": "plugin-alpha-tool", "command": "x"}})).await.unwrap_err(), "MCP server already exists: plugin-alpha-tool (provided by plugin \"alpha-536a8a2d\")");

    call(&f, "mcp/setMcpServerEnabled", json!({"name": "plugin-alpha-tool", "enabled": false})).await.unwrap();
    assert_eq!(f.runtime.catalog().await.servers["plugin-alpha-tool"]["enabled"], false);
    assert_eq!(stored(&f), json!({}), "the user's own servers are not touched");
    call(&f, "mcp/setMcpServerEnabled", json!({"name": "plugin-alpha-tool", "enabled": true})).await.unwrap();
    assert_eq!(f.runtime.catalog().await.servers["plugin-alpha-tool"]["enabled"], true);
    assert_eq!(*f.log.lock().unwrap(), ["toggle:plugin-alpha-tool:false", "publish:plugin-alpha-tool=false", "toggle:plugin-alpha-tool:true", "publish:plugin-alpha-tool=true"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_clears_the_sign_in_reconnects_and_tells_the_session_that_asked() {
    let f = plain();
    let out = call(&f, "mcp/signOutMcpServer", json!({"name": "remote", "threadId": "t1"})).await.unwrap();
    assert_eq!(out, json!({"status": "reconnected", "revoked": true}));
    assert_eq!(*f.log.lock().unwrap(), ["guard:remote", "clear:https://x.example/mcp", "reconnect:remote:true:", "toast:info:mcp signed out: remote"]);
    assert_eq!(call(&f, "mcp/signOutMcpServer", json!({"name": "demo"})).await.unwrap_err(), "MCP server \"demo\" does not use OAuth sign-in");
    assert_eq!(call(&f, "mcp/signOutMcpServer", json!({"name": "ghost"})).await.unwrap_err(), "MCP server not configured: ghost");
    assert_eq!(call(&f, "mcp/signOutMcpServer", json!({"name": ""})).await.unwrap_err(), "MCP server name is required");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_that_waits_for_the_browser_is_announced_and_one_that_cannot_start_is_refused_in_words() {
    let f = plain();
    call(&f, "mcp/beginMcpOAuthLogin", json!({"name": "remote", "threadId": "t1", "options": {"mode": "connect"}})).await.unwrap();
    assert_eq!(*f.log.lock().unwrap(), ["begin:remote:connect", "toast:info:mcp sign-in started: remote"]);

    let settled = fixture(json!({"remote": {"type": "http", "url": "https://x.example/mcp"}}), Vec::new(), true, "done", false);
    call(&settled, "mcp/beginMcpOAuthLogin", json!({"name": "remote", "threadId": "t1"})).await.unwrap();
    assert_eq!(*settled.log.lock().unwrap(), ["begin:remote:"], "a login that already settled is not announced");

    let off = fixture(json!({"remote": {"type": "http", "url": "https://x.example/mcp", "enabled": false}}), Vec::new(), true, "pending", false);
    assert_eq!(call(&off, "mcp/beginMcpOAuthLogin", json!({"name": "remote"})).await.unwrap_err(), "MCP server is disabled: remote");
    let signed_out = fixture(json!({"remote": {"type": "http", "url": "https://x.example/mcp"}}), Vec::new(), false, "pending", false);
    assert_eq!(call(&signed_out, "mcp/beginMcpOAuthLogin", json!({"name": "remote", "options": {"mode": "switch"}})).await.unwrap_err(), "MCP server \"remote\" is not signed in");
    assert_eq!(call(&f, "mcp/beginMcpOAuthLogin", json!({"name": "demo"})).await.unwrap_err(), "MCP server \"demo\" does not use OAuth sign-in");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_session_service_refuses_an_announced_call_before_anything_runs() {
    let f = fixture(json!({"remote": {"type": "http", "url": "https://x.example/mcp"}}), Vec::new(), true, "pending", true);
    assert_eq!(call(&f, "mcp/signOutMcpServer", json!({"name": "remote"})).await.unwrap_err(), "session service is closed");
    assert!(f.log.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_auth_probe_needs_an_http_or_sse_config_and_passes_only_the_connection_fields() {
    let f = plain();
    assert_eq!(call(&f, "mcp/probeMcpServerAuth", json!({})).await.unwrap_err(), "MCP server config is required");
    assert_eq!(call(&f, "mcp/probeMcpServerAuth", json!({"cfg": {"type": "stdio", "command": "x"}})).await.unwrap_err(), "type must be 'http' or 'sse'");
    let probed = call(&f, "mcp/probeMcpServerAuth", json!({"cfg": {"type": "sse", "url": "https://x/s", "command": "ignored", "headers": {"A": "b"}}})).await.unwrap();
    assert_eq!(probed, json!({"probed": {"type": "sse", "url": "https://x/s", "headers": {"A": "b"}}}));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connectors_tools_are_listed_with_their_own_read_only_hint() {
    let f = plain();
    let tools = call(&f, "connector/listConnectorTools", json!({"connectorId": "gmail"})).await.unwrap();
    assert_eq!(
        tools,
        json!([
            {"name": "send", "description": "Send mail", "annotations": {"readOnlyHint": false}, "readOnly": false},
            {"name": "read", "description": "", "annotations": {"readOnlyHint": true}, "readOnly": true},
            {"name": "bare", "description": "", "annotations": {}, "readOnly": null},
        ])
    );
    assert_eq!(call(&f, "connector/listConnectorTools", json!({"connectorId": "nobody"})).await.unwrap(), json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_method_the_service_does_not_serve_is_unavailable() {
    let f = plain();
    let request = CoreRequest { method: Method("mcp/unheard"), params: json!({}), op: None, ctx: CallContext::internal("test") };
    assert!(matches!(f.service.call(request).await, Err(CoreError::CapabilityUnavailable { .. })));
}