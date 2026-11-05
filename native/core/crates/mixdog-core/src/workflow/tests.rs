//! The ten methods against the Node recording (`fixtures/workflow-config/scenarios.json`), over
//! the real `Config`, the real pack files and the real op scopes. What the host owns (Main
//! route, provider facts) answers as the recording's scenario states it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::DomainErrorDetail;
use serde_json::Value;
use serde_json::json;

use super::METHODS;
use super::WorkflowConfig;
use super::WorkflowHost;
use super::WorkflowPaths;
use super::ids::Doc;
use crate::config::Config;
use crate::config::ConfigLanes;
use crate::domains::support::testing::request;
use crate::domains::support::testing::scopes;
use crate::domains::support::testing::value;

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/workflow-config")
}

struct Host {
    main: Value,
    custom_agents: Vec<String>,
    capable: bool,
    adopted: Mutex<Vec<Value>>,
}

#[async_trait]
impl WorkflowHost for Host {
    async fn thread_mode_facts(&self, _thread_id: &str) -> Result<Value, CoreError> {
        Ok(Value::Null)
    }
    fn main_route(&self) -> Value {
        self.main.clone()
    }
    async fn adopt_lead_route(&self, selection: Value) {
        self.adopted.lock().unwrap().push(selection);
    }
    async fn custom_agent_ids(&self) -> Vec<String> {
        self.custom_agents.clone()
    }
    fn provider_available(&self, _provider: &str) -> bool {
        true
    }
    fn require_local_provider_management(&self) -> Result<(), String> {
        Ok(())
    }
    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn after_credential_change(&self) {}
    async fn ensure_providers_ready(&self, _providers: Doc) -> Result<(), String> {
        Ok(())
    }
    async fn lookup_model_meta(&self, _provider: &str, _model: &str) -> Option<Value> {
        None
    }
    fn web_search_capable(&self, _provider: &str, _meta: Option<&Value>) -> bool {
        self.capable
    }
    fn coerce_effort(&self, _provider: &str, _meta: Option<&Value>, _effort: &str) -> Option<String> {
        None
    }
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        false
    }
    fn web_search_route_saved(&self, _route: &Value) {}
}

fn method_name(name: &str) -> &'static str {
    METHODS.iter().copied().find(|full| full.strip_prefix("config/") == Some(name)).unwrap()
}

fn files_of(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(rel, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[tokio::test]
async fn methods_match_node() {
    let recording: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("scenarios.json")).unwrap()).unwrap();
    let now = recording["now"].as_str().unwrap().to_owned();
    for scenario in recording["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        for (path, text) in scenario["files"].as_object().unwrap() {
            let file = data.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text.as_str().unwrap()).unwrap();
        }
        std::fs::create_dir_all(&data).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let config_path = dir.path().join("cfg").join("mixdog-config.json");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(&config_path, serde_json::to_vec(&json!({ "agent": scenario["config"] })).unwrap()).unwrap();
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let host = Arc::new(Host {
            main: scenario["main"].as_object().map_or(json!({ "provider": "openai", "model": "main-model" }), |m| Value::Object(m.clone())),
            custom_agents: scenario["customAgents"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect(),
            capable: scenario["webSearch"]["capable"] == json!(true),
            adopted: Mutex::default(),
        });
        let paths = WorkflowPaths { root: fixtures().join("shipped"), data: data.clone() };
        let clock = now.clone();
        let service = WorkflowConfig::new(config.clone(), paths, host, scopes(dir.path(), "config").await, &tokens)
            .with_clock(Arc::new(move || clock.clone()));
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let method = step["method"].as_str().unwrap();
            let mut params = step["params"].clone();
            if params.is_null() {
                params = json!({});
            }
            let req = request(method_name(method), params, Some(i as u64 + 1));
            let got = match value(&*service, req).await {
                Ok(v) => json!({ "result": v }),
                Err(CoreError::DomainError { detail: Some(detail), .. }) => match *detail {
                    DomainErrorDetail::CommandFailed { message } => json!({ "error": message }),
                    other => panic!("{name} #{i} {method}: {other:?}"),
                },
                Err(other) => panic!("{name} #{i} {method}: {other:?}"),
            };
            let want = match step.get("error") {
                Some(e) => json!({ "error": e }),
                None => json!({ "result": step["result"] }),
            };
            assert_eq!(got, want, "{name} #{i} {method} {}", step["params"]);
            assert_eq!(Value::Object(config.agent()), step["config"], "{name} #{i} {method} config");
            let files: BTreeMap<String, String> = serde_json::from_value(step["files"].clone()).unwrap();
            assert_eq!(files_of(&data), files, "{name} #{i} {method} files");
        }
    }
}
