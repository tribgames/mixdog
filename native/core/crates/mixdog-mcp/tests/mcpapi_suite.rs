//! The MCP service against what the MCP methods of today's Node runtime API answered
//! (`tests/golden/mcpapi.mjs` → `mcpapi.json`): each step's answer or error, the configs it saved,
//! the effects it had on the process in order (reconnects, toggles, announcements, keychain and
//! sign-out calls), and the config afterwards. The golden carries Windows paths (the plugin ids
//! hash them), so the replay runs only there.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out plugin folders")]

mod support;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::OAuthState;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::plugin_servers::Declared;
use mixdog_mcp::plugin_servers::declarations_of;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_rt::LaneToken;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &[String], _: Duration) -> Result<String, String> {
        Err("git is not used for local sources".to_owned())
    }
}

type Log = Arc<Mutex<Vec<String>>>;

struct Config {
    agent: Mutex<Map<String, Value>>,
    saves: Mutex<Vec<Value>>,
    log: Log,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
        *self.agent.lock().unwrap() = after.clone();
        self.saves.lock().unwrap().push(Value::Object(after.clone()));
        self.log.lock().unwrap().push("save".to_owned());
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

struct Host {
    log: Log,
    cwd: PathBuf,
}

impl Host {
    fn push(&self, event: String) {
        self.log.lock().unwrap().push(event);
    }
}

fn changes_json(changes: &[(String, bool)]) -> String {
    json!(changes.iter().map(|(name, enabled)| json!({"name": name, "enabled": enabled})).collect::<Vec<_>>()).to_string()
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}

    async fn announce(&self, _: &str) {}

    async fn announce_without_invalidating(&self, _: &str) {}

    async fn tool_names(&self) -> Vec<String> {
        Vec::new()
    }

    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, enabled: bool, drop: &[String]) -> Value {
        self.push(format!("reconnect:{}", json!({"only": only, "enabled": enabled, "drop": drop})));
        json!({"servers": [], "reconnected": only})
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        self.push("reconnectAll".to_owned());
        json!({"servers": [], "reconnected": "all"})
    }

    async fn schedule_mcp_toggle(&self, name: &str, enabled: bool) -> Value {
        self.push(format!("toggle:{name}:{enabled}"));
        json!({"servers": [], "toggled": name, "enabled": enabled})
    }

    async fn publish_mcp_changes(&self, changes: &[(String, bool)]) {
        self.push(format!("publish:mcp:{}", changes_json(changes)));
    }

    async fn announce_mcp_changes(&self, changes: &[(String, bool)]) {
        self.push(format!("announce:mcp:{}", changes_json(changes)));
    }

    async fn connect_configured_mcp(&self, only: &str, enabled: bool) -> Value {
        self.push(format!("connect:{only}:{enabled}"));
        json!({"connected": only})
    }

    fn invalidate_skills(&self) {}

    async fn flush_skills_save(&self) {
        self.push("flushSkills".to_owned());
    }

    async fn current_cwd(&self, _: Option<&str>) -> PathBuf {
        self.cwd.clone()
    }

    async fn skills_status(&self) -> Value {
        Value::Null
    }
}

struct World {
    config: Arc<Config>,
    declared: Vec<Declared>,
    plugins_status: Value,
    data_dir: String,
    cwd: String,
    log: Log,
    /// The MCP tool definitions the current step runs with.
    tools: Mutex<Vec<Value>>,
}

impl World {
    fn catalog(&self) -> Catalog {
        let config = Value::Object(self.config.agent());
        resolve_mcp_server_catalog(&config, &self.declared, &self.cwd, &self.data_dir)
    }
}

struct Runtime(Arc<World>);

#[async_trait]
impl McpRuntime for Runtime {
    async fn catalog(&self) -> Catalog {
        self.0.catalog()
    }

    async fn status(&self) -> Value {
        let catalog = self.0.catalog();
        let rows: Vec<Value> = catalog
            .servers
            .iter()
            .map(|(name, cfg)| {
                let mut row = json!({"name": name, "enabled": cfg.get("enabled") != Some(&json!(false))});
                if let Some(owner) = catalog.entries.get(name).and_then(|e| e.get("owner")).filter(|o| o.is_object()) {
                    row["owner"] = json!({"kind": "plugin", "id": owner["id"]});
                }
                row
            })
            .collect();
        json!({"servers": rows})
    }

    async fn server_config(&self, name: &str) -> Result<Value, String> {
        let catalog = self.0.catalog();
        let server = catalog.servers.get(name.trim()).ok_or_else(|| format!("MCP server not configured: {}", name.trim()))?;
        Ok(json!({"name": name, "enabled": server.get("enabled") != Some(&json!(false))}))
    }

    async fn plugins_status(&self) -> Value {
        self.0.plugins_status.clone()
    }

    async fn await_keychain_prewarm(&self) {
        self.0.log.lock().unwrap().push("prewarm".to_owned());
    }

    async fn reload_full_config(&self) {
        self.0.log.lock().unwrap().push("reload".to_owned());
    }

    async fn oauth_state(&self, cfg: &Value) -> Option<OAuthState> {
        let url = cfg.get("url").and_then(Value::as_str).unwrap_or_default();
        url.starts_with("http").then(|| OAuthState { signed_in: url.contains("signed.example"), account: String::new() })
    }

    async fn begin_login(&self, _: &str, _: &Value) -> Result<Value, String> {
        Err("not recorded".to_owned())
    }

    async fn login_status(&self, _: &str, _: &Value) -> Result<Value, String> {
        Err("not recorded".to_owned())
    }

    async fn cancel_login(&self, _: &str) -> Result<Value, String> {
        Err("not recorded".to_owned())
    }

    async fn complete_login(&self, _: &str, _: &str) -> Result<Value, String> {
        Err("not recorded".to_owned())
    }

    async fn guard_sign_out(&self, _: &str) -> Box<dyn Send> {
        Box::new(())
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        let name = cfg.get("name").and_then(Value::as_str).unwrap_or("undefined");
        self.0.log.lock().unwrap().push(format!("clear:{name}:true"));
        Ok(name == "revoker")
    }

    fn forget_account_health(&self, _: &str) {}

    async fn probe_auth(&self, probe: &Value) -> Result<Value, String> {
        Ok(json!({"auth": "oauth", "probe": probe}))
    }

    fn tools(&self) -> Vec<Value> {
        self.0.tools.lock().unwrap().clone()
    }
}

struct Ops(Arc<World>);

#[async_trait]
impl SecretOps for Ops {
    async fn save_gmail_app_password(&self, email: &str, password: &str) -> Result<(), String> {
        self.0.log.lock().unwrap().push(format!("gmailSave:{email}:{password}"));
        if password.starts_with("bad") { Err("GMAIL_APP_PASSWORD_REJECTED: no".to_owned()) } else { Ok(()) }
    }

    async fn forget_gmail_app_password(&self, email: &str) -> Result<(), String> {
        self.0.log.lock().unwrap().push(format!("gmailForget:{email}"));
        Ok(())
    }

    async fn save_oauth_client_secret(&self, url: &str, secret: &str) -> Result<(), String> {
        self.0.log.lock().unwrap().push(format!("clientSecret:{url}:{secret}"));
        Ok(())
    }

    async fn read_secret(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    async fn write_secret(&self, _: &str, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        let name = cfg.get("name").and_then(Value::as_str).unwrap_or("undefined");
        self.0.log.lock().unwrap().push(format!("clear:{name}:true"));
        Ok(name == "revoker")
    }

    fn forget_account_health(&self, _: &str) {}

    fn configured_servers(&self) -> Map<String, Value> {
        self.0.catalog().servers
    }
}

fn mask(base: &str, text: &str) -> String {
    let escaped = serde_json::to_string(base).unwrap();
    let text = text.replace(&escaped[1..escaped.len() - 1], "<BASE>");
    regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap().replace_all(&text, "<UUID>").into_owned()
}

fn unmask(base: &str, value: &Value) -> Value {
    let escaped = serde_json::to_string(base).unwrap();
    serde_json::from_str(&value.to_string().replace("<BASE>", &escaped[1..escaped.len() - 1])).unwrap()
}

fn masked(base: &str, value: &Value) -> Value {
    serde_json::from_str(&mask(base, &value.to_string())).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn every_mcp_method_answers_saves_and_triggers_what_node_does() {
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().to_string_lossy().into_owned();
    let golden: Value = serde_json::from_str(&support::relocate(include_str!("golden/mcpapi.json"), &base)).unwrap();
    for (name, files) in golden["fixtures"].as_object().unwrap() {
        for (relative, text) in files.as_object().unwrap() {
            let file = Path::new(&base).join("src").join(name).join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text.as_str().unwrap()).unwrap();
        }
    }
    std::fs::create_dir_all(Path::new(&base).join("data")).unwrap();
    let data_dir = Path::new(&base).join("data");
    let admin = Arc::new(PluginAdmin::new(data_dir.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let declarations = Arc::new(DeclarationCache::new());
    let tokens = mixdog_rt::testing::tokens();
    // The registry: the three fixture plugins, added the way the recorder added them.
    let sources: Vec<String> = ["alpha", "beta", "empty"].iter().map(|n| Path::new(&base).join("src").join(n).to_string_lossy().into_owned()).collect();
    let (admin_job, declarations_job) = (Arc::clone(&admin), Arc::clone(&declarations));
    let job = tokens
        .maintenance_io
        .submit_wait(&CancellationToken::new(), move |lane| {
            for source in &sources {
                admin_job.add_plugin(lane, &json!(source), None).unwrap();
            }
            let rows = admin_job.list_registered_plugins(lane).unwrap();
            let declared = declarations_of(&rows, &|root| declarations_job.load(lane, root));
            (declared, admin_job.status(lane).unwrap())
        })
        .await
        .unwrap();
    let (declared, plugins_status) = job.await.unwrap();
    let log: Log = Arc::default();
    let initial = unmask(&base, &golden["initialConfig"]);
    let config = Arc::new(Config { agent: Mutex::new(initial.as_object().unwrap().clone()), saves: Mutex::default(), log: Arc::clone(&log) });
    let cwd = Path::new(&base).join("proj1").join("sub");
    let world = Arc::new(World {
        config: Arc::clone(&config),
        declared,
        plugins_status,
        data_dir: data_dir.to_string_lossy().into_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        log: Arc::clone(&log),
        tools: Mutex::default(),
    });
    let env = std::env::vars().collect();
    let secrets = Arc::new(McpServerSecrets::new(Arc::new(Ops(Arc::clone(&world))), env));
    let host = Arc::new(Host { log: Arc::clone(&log), cwd });
    let service = McpService::new(config.clone(), host, Arc::new(Runtime(Arc::clone(&world))), secrets, Path::new(&base).join("home"));
    for step in golden["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        log.lock().unwrap().clear();
        config.saves.lock().unwrap().clear();
        *world.tools.lock().unwrap() = step["params"]["tools"].as_array().cloned().unwrap_or_default();
        let request = CoreRequest {
            method: Method(Box::leak(step["method"].as_str().unwrap().to_owned().into_boxed_str())),
            params: unmask(&base, &step["params"]),
            op: None,
            ctx: CallContext::internal("test"),
        };
        let outcome = service.call(request).await;
        // Key order is part of what is stored, so compare the text JSON.stringify writes.
        let same = |got: &Value, expected: &Value, what: &str| {
            let (got, expected) = (mixdog_js::json_stringify_indent(got, 1), mixdog_js::json_stringify_indent(expected, 1));
            assert!(got == expected, "{name}: {what}\n got  {got}\n node {expected}");
        };
        match (outcome, step["error"].as_str()) {
            (Err(CoreError::DomainError { message: Some(got), .. }), Some(expected)) => assert_eq!(mask(&base, &got), expected, "{name}: error"),
            (Ok(Reply::Value(got)), None) => same(&masked(&base, &got), &step["result"], "answer"),
            (other, expected) => panic!("{name}: got {other:?}, Node error {expected:?}"),
        }
        let saves = Value::Array(config.saves.lock().unwrap().clone());
        same(&masked(&base, &saves), &step["saves"], "saved configs");
        assert_eq!(masked(&base, &json!(*log.lock().unwrap())), step["events"], "{name}: effects in order");
        same(&masked(&base, &Value::Object(config.agent())), &step["config"], "config afterwards");
    }
}
