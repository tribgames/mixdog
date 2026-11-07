//! The skills service against what the skill methods of today's Node runtime API answered
//! (`tests/golden/skillsapi.mjs` → `skillsapi.json`): each step's answer or error, the host effects
//! in order, the disabled list, and every file in the data folder afterwards. The golden carries
//! Windows paths, so the replay runs only there.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out skill folders")]

use std::path::Path;
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
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillGate;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_service::SkillsService;
use mixdog_mcp::skills_watch::SkillsWatch;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Log = Arc<Mutex<Vec<String>>>;

struct Config {
    agent: Mutex<Map<String, Value>>,
    writes: Mutex<Vec<Vec<String>>>,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }

    fn set_disabled_skills(&self, names: &[String]) {
        self.agent.lock().unwrap().insert("skills".to_owned(), json!({"disabled": names}));
        self.writes.lock().unwrap().push(names.to_vec());
    }
}

struct Host {
    log: Log,
    cwd: PathBuf,
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}

    async fn announce(&self, kind: &str) {
        self.log.lock().unwrap().push(format!("announce:{kind}"));
    }

    async fn announce_without_invalidating(&self, kind: &str) {
        self.log.lock().unwrap().push(format!("announce:{kind}:keep"));
    }

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(vec!["read".to_owned(), "bash".to_owned()])
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
        self.log.lock().unwrap().push("invalidateSkills".to_owned());
    }

    async fn flush_skills_save(&self) {
        self.log.lock().unwrap().push("flushSkills".to_owned());
    }

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(self.cwd.clone())
    }

    async fn skills_status(&self) -> Value {
        Value::Null
    }
}

/// What Node's settings said when the golden was recorded: `beta` switched off, `gamma` limited
/// to one project (the status decoration reads the scopes from the config).
struct Settings(SkillSettings);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.clone()
    }
}

fn mask(base: &str, text: &str) -> String {
    let escaped = serde_json::to_string(base).unwrap();
    text.replace(&escaped[1..escaped.len() - 1], "<BASE>")
}

fn unmask(base: &str, value: &Value) -> Value {
    let escaped = serde_json::to_string(base).unwrap();
    serde_json::from_str(&value.to_string().replace("<BASE>", &escaped[1..escaped.len() - 1])).unwrap()
}

fn tree(dir: &Path, root: &Path, base: &str, out: &mut Map<String, Value>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            tree(&path, root, base, out);
        } else if !name.contains(".mixdog-tmp-") && !name.ends_with(".lock") {
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
            out.insert(relative, Value::String(mask(base, &text)));
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_skill_method_answers_and_leaves_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/skillsapi.json")).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().to_string_lossy().into_owned();
    let data = Path::new(&base).join("data");
    std::fs::create_dir_all(Path::new(&base).join("proj1").join("sub")).unwrap();
    std::fs::create_dir_all(Path::new(&base).join("proj2")).unwrap();
    std::fs::write(Path::new(&base).join("afile"), "x").unwrap();
    for (relative, text) in golden["fixtures"].as_object().unwrap() {
        let file = data.join("skills").join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text.as_str().unwrap()).unwrap();
    }
    let proj1 = Path::new(&base).join("proj1").to_string_lossy().into_owned();
    let config_value = json!({"extensionScopes": {"skills": {"gamma": [proj1]}}});
    let mut agent = config_value.as_object().unwrap().clone();
    agent.insert("skills".to_owned(), json!({"disabled": ["beta"]}));
    let config = Arc::new(Config { agent: Mutex::new(agent), writes: Mutex::default() });
    let log: Log = Arc::default();
    let host = Arc::new(Host { log: Arc::clone(&log), cwd: Path::new(&base).join("proj1").join("sub") });
    let settings = SkillSettings {
        gate: SkillGate { disabled: ["beta".to_owned()].into_iter().collect(), active_features: Default::default() },
        scopes: ExtensionScopes::from_config(&config_value["extensionScopes"]),
    };
    let tokens = mixdog_rt::testing::tokens();
    let root = SkillRoot { dir: data.join("skills"), source: SkillSource::Global, plugin: None };
    let settings: Arc<dyn SkillSettingsSource> = Arc::new(Settings(settings));
    let catalog = SkillCatalog::new(data.clone(), tokens.maintenance_io.clone(), Arc::new(move |_| vec![root.clone()]), Arc::clone(&settings), &SkillsWatch::new());
    let service = SkillsService::new(catalog, settings, config.clone(), host, tokens.maintenance_io, tokens.durability_io, data.clone());
    for step in golden["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        log.lock().unwrap().clear();
        config.writes.lock().unwrap().clear();
        let request = CoreRequest {
            method: Method(Box::leak(step["method"].as_str().unwrap().to_owned().into_boxed_str())),
            params: unmask(&base, &step["params"]),
            op: None,
            ctx: CallContext::internal("test"),
        };
        match (service.call(request).await, step["error"].as_str()) {
            (Err(CoreError::DomainError { message: Some(got), .. }), Some(expected)) => assert_eq!(mask(&base, &got), expected, "{name}: error"),
            (Ok(Reply::Value(got)), None) => assert_eq!(serde_json::from_str::<Value>(&mask(&base, &got.to_string())).unwrap(), step["result"], "{name}: answer"),
            (other, expected) => panic!("{name}: got {other:?}, Node error {expected:?}"),
        }
        assert_eq!(json!(*log.lock().unwrap()), step["events"], "{name}: host effects in order");
        assert_eq!(json!(*config.writes.lock().unwrap()), step["disabledWrites"], "{name}: disabled list writes");
        let mut files = Map::new();
        tree(&data.join("skills"), &data, &base, &mut files);
        let mut overrides = Map::new();
        if data.join("skill-tool-dependencies").is_dir() {
            tree(&data.join("skill-tool-dependencies"), &data, &base, &mut overrides);
        }
        let mut overrides: Vec<Value> = overrides.into_values().collect();
        overrides.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        files.insert("overrides".to_owned(), Value::Array(overrides));
        assert_eq!(Value::Object(files), step["files"], "{name}: files afterwards");
    }
}
