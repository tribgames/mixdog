//! The MCP, skills, plugins and connectors `setup` actions through `McpSetup` over the real MCP
//! service (`ServiceSetupRuntime`): what a call saves, which effects the process gets, and the
//! answer. The skills and plugins services are recorders at the `DomainService` seam: the test
//! checks which method and parameters the action reaches them with.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core::setup::McpSetup;
use mixdog_core::setup::SetupActions;
use mixdog_core::setup::SetupCall;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::OAuthState;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_mcp::setup_runtime::ServiceSetupRuntime;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Log = Arc<Mutex<Vec<String>>>;

struct Config {
    agent: Mutex<Map<String, Value>>,
    log: Log,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
        *self.agent.lock().unwrap() = after.clone();
        self.log.lock().unwrap().push("save".to_owned());
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

struct Host {
    log: Log,
    cwd: PathBuf,
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}
    async fn announce(&self, _: &str) {}
    async fn announce_without_invalidating(&self, _: &str) {}

    async fn tool_names(&self) -> Vec<String> {
        Vec::new()
    }

    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, enabled: bool, _: &[String]) -> Value {
        self.log.lock().unwrap().push(format!("reconnect:{}:{enabled}", only.unwrap_or("")));
        json!({"servers": [{"name": only, "enabled": enabled, "connected": true}], "connectedCount": 1})
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        self.log.lock().unwrap().push("reconnectAll".to_owned());
        json!({"servers": [], "connectedCount": 0})
    }

    async fn schedule_mcp_toggle(&self, name: &str, enabled: bool) -> Value {
        self.log.lock().unwrap().push(format!("toggle:{name}:{enabled}"));
        json!({"servers": [{"name": name, "enabled": enabled}], "connectedCount": 0})
    }

    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, only: &str, _: bool) -> Value {
        json!({"connected": only})
    }

    fn invalidate_skills(&self) {}
    async fn flush_skills_save(&self) {}

    async fn current_cwd(&self, _: Option<&str>) -> PathBuf {
        self.cwd.clone()
    }

    async fn skills_status(&self) -> Value {
        Value::Null
    }
}

struct Runtime {
    config: Arc<Config>,
    dir: String,
}

impl Runtime {
    fn catalog_now(&self) -> Catalog {
        resolve_mcp_server_catalog(&Value::Object(self.config.agent()), &[], &self.dir, &self.dir)
    }
}

#[async_trait]
impl McpRuntime for Runtime {
    fn catalog(&self) -> Catalog {
        self.catalog_now()
    }

    fn status(&self) -> Value {
        let rows: Vec<Value> = self.catalog_now().servers.iter().map(|(name, cfg)| json!({"name": name, "enabled": cfg.get("enabled") != Some(&json!(false)), "transport": cfg.get("type")})).collect();
        json!({"servers": rows, "connectedCount": 0})
    }

    fn server_config(&self, name: &str) -> Result<Value, String> {
        let catalog = self.catalog_now();
        let config = catalog.servers.get(name.trim()).ok_or_else(|| format!("MCP server not configured: {}", name.trim()))?;
        Ok(json!({"name": name.trim(), "source": "config", "enabled": config.get("enabled") != Some(&json!(false)), "config": config}))
    }

    fn plugins_status(&self) -> Value {
        json!({"plugins": []})
    }

    async fn await_keychain_prewarm(&self) {}
    fn reload_full_config(&self) {}

    fn oauth_state(&self, _: &Value) -> Option<OAuthState> {
        None
    }

    async fn begin_login(&self, _: &str, _: &Value) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn login_status(&self, _: &str, _: &Value) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn cancel_login(&self, _: &str) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn complete_login(&self, _: &str, _: &str) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn guard_sign_out(&self, _: &str) -> Box<dyn Send> {
        Box::new(())
    }

    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        Ok(false)
    }

    fn forget_account_health(&self, _: &str) {}

    async fn probe_auth(&self, _: &Value) -> Result<Value, String> {
        Err("unused".to_owned())
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

/// A service that records the calls it gets and answers `{"plugin": {"id": <plugin>}}`.
struct Recorder {
    methods: &'static [&'static str],
    /// Methods that fail with `registry unreadable`.
    failing: &'static [&'static str],
    seen: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl DomainService for Recorder {
    fn methods(&self) -> &'static [&'static str] {
        self.methods
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.seen.lock().unwrap().push((req.method.as_str().to_owned(), req.params.clone()));
        if self.failing.contains(&req.method.as_str()) {
            return Err(CoreError::DomainError { domain: "plugins".into(), code: None, message: Some("registry unreadable".into()), detail: None });
        }
        Ok(Reply::Value(match req.method.as_str() {
            "skills/setDisabledSkills" => json!({"disabled": req.params["names"]}),
            "config/setExtensionScope" => json!({"skills": [{"name": req.params["name"]}]}),
            "plugins/pluginsStatus" => json!({"plugins": [{"id": "p1", "name": "alpha"}]}),
            _ => json!({"plugin": {"id": req.params["plugin"], "source": req.params["source"]}}),
        }))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

struct Fixture {
    setup: McpSetup,
    config: Arc<Config>,
    log: Log,
    skills: Arc<Recorder>,
    plugins: Arc<Recorder>,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let log: Log = Arc::default();
    let config = Arc::new(Config { agent: Mutex::default(), log: Arc::clone(&log) });
    let host = Arc::new(Host { log: Arc::clone(&log), cwd: dir.path().to_path_buf() });
    let runtime = Arc::new(Runtime { config: Arc::clone(&config), dir: dir.path().to_string_lossy().into_owned() });
    let secrets = Arc::new(McpServerSecrets::new(Arc::new(Ops), std::env::vars().collect()));
    let mcp = Arc::new(McpService::new(config.clone(), host, runtime, secrets, dir.path().join("home")));
    let skills = Arc::new(Recorder { methods: &["skills/setDisabledSkills"], failing: &[], seen: Mutex::default() });
    let plugins = Arc::new(Recorder {
        methods: &["plugins/addPlugin", "plugins/updatePlugin", "plugins/setPluginEnabled", "plugins/removePlugin", "plugins/pluginsStatus", "config/setExtensionScope"],
        failing: &[],
        seen: Mutex::default(),
    });
    let setup = McpSetup::new(Arc::new(ServiceSetupRuntime::new(mcp, skills.clone(), plugins.clone())));
    Fixture { setup, config, log, skills, plugins, _dir: dir }
}

async fn run(f: &Fixture, args: Value) -> Result<Value, String> {
    let thread = ThreadId::from("s");
    let action = args["action"].as_str().unwrap().to_owned();
    f.setup.run(&SetupCall { action: &action, args: &args, thread: &thread }).await.map_err(|e| match e {
        PortError::Failed { message, .. } => message,
        other => format!("{other:?}"),
    })
}

#[tokio::test]
async fn servers_are_added_edited_toggled_and_removed_through_the_mcp_service() {
    let f = fixture();
    let added = run(&f, json!({"action": "add_mcp_server", "server": {"name": "srv", "command": "node", "args": ["a.js"]}})).await.unwrap();
    assert_eq!(added["name"], "srv");
    assert_eq!(f.config.agent()["mcpServers"]["srv"]["command"], "node");
    assert!(f.log.lock().unwrap().contains(&"save".to_owned()));

    let public = run(&f, json!({"action": "get_mcp_server", "name": "srv"})).await.unwrap();
    assert_eq!(public["argumentCount"], 1);
    assert_eq!(public["hiddenFields"], json!(["command", "args"]));

    run(&f, json!({"action": "set_mcp_enabled", "name": "srv", "enabled": false})).await.unwrap();
    assert!(f.log.lock().unwrap().contains(&"toggle:srv:false".to_owned()));

    run(&f, json!({"action": "remove_mcp_server", "name": "srv"})).await.unwrap();
    assert!(f.config.agent()["mcpServers"].get("srv").is_none());

    let all = run(&f, json!({"action": "reconnect_mcp"})).await.unwrap();
    assert_eq!(all["mcp"]["connectedCount"], 0);
    assert!(f.log.lock().unwrap().contains(&"reconnectAll".to_owned()));
}

#[tokio::test]
async fn a_failure_of_the_service_is_the_message_node_throws() {
    let f = fixture();
    assert_eq!(run(&f, json!({"action": "get_mcp_server", "name": "ghost"})).await.unwrap_err(), "MCP server not configured: ghost");
    assert_eq!(
        run(&f, json!({"action": "add_mcp_server", "server": {"name": "w", "url": "ftp://x.example/"}})).await.unwrap_err(),
        "MCP URL must use HTTP(S) or WS(S)"
    );
    assert!(run(&f, json!({"action": "connect_connector", "connector": "nope"})).await.unwrap_err().starts_with("connector must be one of airtable, "));
}

#[tokio::test]
async fn a_failing_status_read_is_the_failure_not_an_empty_status() {
    let failing = Arc::new(Recorder {
        methods: &["mcp/mcpStatus", "plugins/pluginsStatus"],
        failing: &["mcp/mcpStatus", "plugins/pluginsStatus"],
        seen: Mutex::default(),
    });
    let skills = Arc::new(Recorder { methods: &[], failing: &[], seen: Mutex::default() });
    let setup = McpSetup::new(Arc::new(ServiceSetupRuntime::new(failing.clone(), skills, failing.clone())));
    let thread = ThreadId::from("s");
    for args in [json!({"action": "enable_plugin_mcp", "name": "alpha"}), json!({"action": "connect_connector", "connector": "notion"})] {
        let action = args["action"].as_str().unwrap().to_owned();
        let error = setup.run(&SetupCall { action: &action, args: &args, thread: &thread }).await.unwrap_err();
        assert!(matches!(&error, PortError::Failed { message, .. } if message == "registry unreadable"), "{action}: {error:?}");
    }
}

#[tokio::test]
async fn skills_and_plugins_actions_reach_their_services_with_the_runtime_api_parameters() {
    let f = fixture();
    let skills = run(&f, json!({"action": "set_disabled_skills", "skills": [" a ", "", "b"]})).await.unwrap();
    assert_eq!(skills, json!({"disabled": ["a", "b"]}));
    assert_eq!(*f.skills.seen.lock().unwrap(), vec![("skills/setDisabledSkills".to_owned(), json!({"names": ["a", "b"]}))]);

    assert_eq!(run(&f, json!({"action": "add_plugin", "source": " ./p "})).await.unwrap()["plugin"], json!({"id": null, "source": "./p"}));
    run(&f, json!({"action": "set_plugin_enabled", "name": "alpha", "enabled": false})).await.unwrap();
    run(&f, json!({"action": "update_plugin", "name": "alpha"})).await.unwrap();
    run(&f, json!({"action": "remove_plugin", "name": "alpha"})).await.unwrap();
    let scope = run(&f, json!({"action": "set_extension_scope", "kind": "skills", "name": "deploy", "projects": [" /a "]})).await.unwrap();
    assert_eq!(scope, json!({"skills": [{"name": "deploy"}]}));
    let seen = f.plugins.seen.lock().unwrap();
    let calls: Vec<(&str, &Value)> = seen.iter().map(|(m, p)| (m.as_str(), p)).collect();
    assert_eq!(
        calls,
        vec![
            ("plugins/addPlugin", &json!({"source": "./p"})),
            ("plugins/setPluginEnabled", &json!({"plugin": "alpha", "enabled": false})),
            ("plugins/updatePlugin", &json!({"plugin": "alpha"})),
            ("plugins/removePlugin", &json!({"plugin": "alpha"})),
            ("config/setExtensionScope", &json!({"kind": "skills", "name": "deploy", "projects": ["/a"]})),
        ]
    );
}

