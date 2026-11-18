//! The plugin registry as the plugin methods use it, over a plugin folder written to a temp dir: an empty registry, adding a local
//! plugin, switching it off and on, updating, reloading, removing it, and what each refusal says; and the host effects each change
//! has, in order (the config save, the skills flush, the reconnect of the plugin servers, the surface announcement).

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
use mixdog_mcp::extension_service::PluginsService;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &[String], _: Duration) -> Result<String, String> {
        Err("git is not used for local sources".to_owned())
    }
}

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

    async fn save_agent(&self, _before: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
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

impl Host {
    fn push(&self, event: &str) {
        self.log.lock().unwrap().push(event.to_owned());
    }
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {
        self.push("connect:{\"reconcile\":true}");
        self.announce("plugins").await;
    }

    async fn announce(&self, kind: &str) {
        if kind != "mcp" {
            self.push("invalidateSkills");
        }
        self.push("surface");
    }

    async fn announce_without_invalidating(&self, _: &str) {
        self.push("surface");
    }

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        Value::Null
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        Value::Null
    }

    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    fn invalidate_skills(&self) {
        self.push("invalidateSkills");
    }

    async fn flush_skills_save(&self) {
        self.push("flushSkills");
    }

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(self.cwd.clone())
    }

    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(Value::Object(Map::new()))
    }

    async fn skills_status(&self, _: Option<&str>) -> Value {
        json!({"skills": []})
    }
}

struct Registry {
    base: PathBuf,
    log: Log,
    service: PluginsService,
}

fn registry() -> (tempfile::TempDir, Registry) {
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().to_path_buf();
    let log: Log = Arc::default();
    let config = Arc::new(Config { agent: Mutex::new(Map::new()), log: Arc::clone(&log) });
    let host = Arc::new(Host { log: Arc::clone(&log), cwd: base.join("work") });
    let admin = Arc::new(PluginAdmin::new(base.join("data"), Arc::new(NoGit), Arc::new(|| {})));
    let service = PluginsService::new(admin, Arc::new(DeclarationCache::new()), config, host, mixdog_rt::testing::tokens().maintenance_io);
    (scratch, Registry { base, log, service })
}

impl Registry {
    /// A local plugin folder `<base>/src/<folder>` whose manifest names it `name` and whose `.mcp.json` declares one stdio server.
    fn plugin_folder(&self, folder: &str, name: &str, title: &str) -> String {
        let root = self.base.join("src").join(folder);
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::write(root.join(".claude-plugin").join("plugin.json"), json!({"name": name, "title": title}).to_string()).unwrap();
        std::fs::write(root.join(".mcp.json"), json!({"mcpServers": {"search": {"command": "node", "args": ["server.js"]}}}).to_string()).unwrap();
        root.to_string_lossy().into_owned()
    }

    async fn call(&self, method: &'static str, params: Value) -> Result<Value, String> {
        self.log.lock().unwrap().clear();
        let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") };
        match self.service.call(request).await {
            Ok(Reply::Value(value)) => Ok(value),
            Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
            other => panic!("{method}: {other:?}"),
        }
    }

    fn events(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

fn position(events: &[String], event: &str) -> usize {
    events.iter().position(|seen| seen == event).unwrap_or_else(|| panic!("{event} not in {events:?}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_registry_has_no_plugins_and_names_where_it_keeps_them() {
    let (_scratch, registry) = registry();
    let status = registry.call("plugins/pluginsStatus", json!({})).await.unwrap();
    let data = registry.base.join("data").join("plugins");
    assert_eq!(
        status,
        json!({"count": 0, "plugins": [], "missing": [], "roots": {"registry": data.join("registry.json").to_string_lossy(), "installed": data.join("installed").to_string_lossy()}})
    );
    assert!(registry.events().is_empty(), "reading the status changes nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_plugin_is_added_by_its_folder_and_the_host_reconnects_and_announces_it() {
    let (_scratch, registry) = registry();
    let source = registry.plugin_folder("alpha", "alpha-plugin", "Alpha");
    let added = registry.call("plugins/addPlugin", json!({"source": source})).await.unwrap();
    let plugin = &added["plugin"];
    assert_eq!((plugin["name"].as_str(), plugin["title"].as_str(), plugin["sourceType"].as_str()), (Some("alpha-plugin"), Some("Alpha"), Some("local")));
    assert_eq!((plugin["managed"].clone(), plugin["enabled"].clone(), plugin["exists"].clone()), (json!(false), json!(true), json!(true)));
    assert_eq!(plugin["root"], source.as_str());
    assert_eq!(added["status"]["count"], 1);
    assert_eq!(added["status"]["plugins"][0]["name"], "alpha-plugin");
    let events = registry.events();
    assert!(position(&events, "connect:{\"reconcile\":true}") < position(&events, "surface"), "{events:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_is_switched_off_and_on_by_name_and_the_status_follows() {
    let (_scratch, registry) = registry();
    registry.call("plugins/addPlugin", json!({"source": registry.plugin_folder("alpha", "alpha-plugin", "Alpha")})).await.unwrap();
    let off = registry.call("plugins/setPluginEnabled", json!({"plugin": "alpha-plugin", "enabled": false})).await.unwrap();
    assert_eq!((off["plugin"]["enabled"].clone(), off["status"]["plugins"][0]["enabled"].clone()), (json!(false), json!(false)));
    assert!(registry.events().contains(&"surface".to_owned()));
    let on = registry.call("plugins/setPluginEnabled", json!({"plugin": "alpha-plugin", "enabled": true})).await.unwrap();
    assert_eq!((on["plugin"]["enabled"].clone(), on["status"]["plugins"][0]["enabled"].clone()), (json!(true), json!(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn updating_and_reloading_keep_the_plugin_and_announce_the_change() {
    let (_scratch, registry) = registry();
    registry.call("plugins/addPlugin", json!({"source": registry.plugin_folder("alpha", "alpha-plugin", "Alpha")})).await.unwrap();
    let updated = registry.call("plugins/updatePlugin", json!({"plugin": {"name": "alpha-plugin"}})).await.unwrap();
    assert_eq!((updated["plugin"]["name"].as_str(), updated["status"]["count"].as_u64()), (Some("alpha-plugin"), Some(1)));
    assert!(registry.events().contains(&"connect:{\"reconcile\":true}".to_owned()));
    let reloaded = registry.call("plugins/reloadPlugins", json!({})).await.unwrap();
    assert_eq!((reloaded["count"].as_u64(), reloaded["plugins"][0]["name"].as_str()), (Some(1), Some("alpha-plugin")));
    let events = registry.events();
    assert!(position(&events, "connect:{\"reconcile\":true}") < position(&events, "surface"), "{events:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_plugin_leaves_the_registry_and_what_cannot_be_done_is_refused_in_words() {
    let (_scratch, registry) = registry();
    registry.call("plugins/addPlugin", json!({"source": registry.plugin_folder("alpha", "alpha-plugin", "Alpha")})).await.unwrap();
    let removed = registry.call("plugins/removePlugin", json!({"plugin": "alpha-plugin"})).await.unwrap();
    assert_eq!((removed["plugin"]["removed"].clone(), removed["status"]["count"].clone()), (json!(true), json!(0)));
    assert!(registry.events().contains(&"surface".to_owned()));
    assert_eq!(registry.call("plugins/pluginsStatus", json!({})).await.unwrap()["count"], 0);

    assert_eq!(registry.call("plugins/removePlugin", json!({"plugin": "ghost"})).await.unwrap_err(), "plugin not registered: ghost");
    assert!(registry.events().is_empty(), "a refused removal announces nothing");
    assert_eq!(registry.call("plugins/updatePlugin", json!({"plugin": {}})).await.unwrap_err(), "plugin not registered: [object Object]");
    assert_eq!(registry.call("plugins/addPlugin", json!({"source": ""})).await.unwrap_err(), "plugin URL/path is required");
    assert!(registry.events().is_empty());
}
