//! The plugin methods and `config/setExtensionScope` replayed against what today's Node product
//! answered, saved and triggered (`tests/golden/pluginsapi.mjs` → `pluginsapi.json`): each step's
//! answer, the config it saved, the order of the host effects, and the config afterwards. The
//! golden carries Windows paths (the plugin ids hash them), so the replay runs only there.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out plugin folders")]

use crate::support;

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
    saves: Mutex<Vec<Value>>,
    log: Log,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _before: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
        *self.agent.lock().unwrap() = after.clone();
        self.saves.lock().unwrap().push(Value::Object(after.clone()));
        self.log.lock().unwrap().push("save".to_owned());
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

/// The host effects in the order Node's extension sync performs them.
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

    async fn skills_status(&self) -> Value {
        json!({"skills": [{"name": "deploy", "owner": {"kind": "plugin", "id": "x"}}, {"name": "other"}]})
    }
}

fn mask(base: &str, text: &str) -> String {
    let escaped = serde_json::to_string(base).unwrap();
    let text = text.replace(&escaped[1..escaped.len() - 1], "<BASE>");
    let text = regex::Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap().replace_all(&text, "<TS>").into_owned();
    let text = regex::Regex::new(r"\.corrupt-\d+").unwrap().replace_all(&text, ".corrupt-<N>").into_owned();
    regex::Regex::new(r"mixdog-tmp-[0-9a-f]+").unwrap().replace_all(&text, "mixdog-tmp-<H>").into_owned()
}

fn masked(base: &str, value: &Value) -> Value {
    serde_json::from_str(&mask(base, &value.to_string())).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn every_plugin_method_answers_saves_and_triggers_what_node_does() {
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().to_string_lossy().into_owned();
    let golden: Value = serde_json::from_str(&support::relocate(include_str!("../golden/pluginsapi.json"), &base)).unwrap();
    for (name, files) in golden["fixtures"].as_object().unwrap() {
        for (relative, text) in files.as_object().unwrap() {
            let file = Path::new(&base).join("src").join(name).join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text.as_str().unwrap()).unwrap();
        }
    }
    let escaped = serde_json::to_string(&base).unwrap();
    let initial: Value = serde_json::from_str(&golden["initialConfig"].to_string().replace("<BASE>", &escaped[1..escaped.len() - 1])).unwrap();
    let log: Log = Arc::default();
    let config = Arc::new(Config { agent: Mutex::new(initial.as_object().unwrap().clone()), saves: Mutex::default(), log: Arc::clone(&log) });
    let host = Arc::new(Host { log: Arc::clone(&log), cwd: Path::new(&base).join("proj1").join("sub") });
    let admin = Arc::new(PluginAdmin::new(Path::new(&base).join("data"), Arc::new(NoGit), Arc::new(|| {})));
    let service = PluginsService::new(
        admin,
        Arc::new(DeclarationCache::new()),
        config.clone(),
        host,
        mixdog_rt::testing::tokens().maintenance_io,
    );
    for step in golden["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        log.lock().unwrap().clear();
        config.saves.lock().unwrap().clear();
        let request = CoreRequest {
            method: Method(Box::leak(step["method"].as_str().unwrap().to_owned().into_boxed_str())),
            params: step["params"].clone(),
            op: None,
            ctx: CallContext::internal("test"),
        };
        let outcome = service.call(request).await;
        match (outcome, step["error"].as_str()) {
            (Err(CoreError::DomainError { message: Some(got), .. }), Some(expected)) => assert_eq!(mask(&base, &got), expected, "{name}: error"),
            (Ok(Reply::Value(got)), None) => assert_eq!(masked(&base, &got), step["result"], "{name}: answer"),
            (other, expected) => panic!("{name}: got {other:?}, Node error {expected:?}"),
        }
        let saves = Value::Array(config.saves.lock().unwrap().clone());
        assert_eq!(masked(&base, &saves), step["saves"], "{name}: saved configs");
        assert_eq!(json!(*log.lock().unwrap()), step["events"], "{name}: host effects in order");
        assert_eq!(masked(&base, &Value::Object(config.agent())), step["config"], "{name}: config afterwards");
    }
}
