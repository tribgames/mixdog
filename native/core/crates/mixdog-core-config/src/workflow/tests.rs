//! The ten methods against the Node recording (`fixtures/workflow-config/scenarios.json`), over
//! the real `Config`, the real pack files and the real op scopes. What the host owns (Main
//! route, provider facts) answers as the recording's scenario states it.

#![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded packs and seeds config files on the test thread")]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::METHODS;
use super::WorkflowConfig;
use super::WorkflowHost;
use super::WorkflowPaths;
use super::ids::Doc;
use crate::config::Config;
use crate::config::ConfigLanes;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/workflow-config")
}

struct Host {
    main: Mutex<Value>,
    custom_agents: Vec<String>,
    capable: bool,
    adopted: Mutex<Vec<Value>>,
}

#[async_trait]
impl WorkflowHost for Host {
    fn main_route(&self) -> Value {
        self.main.lock().unwrap().clone()
    }
    async fn adopt_lead_route(&self, selection: Value) {
        // The session resolves the selection into the live route (`modelParameters` included).
        let mut route = selection.clone();
        route.as_object_mut().unwrap().entry("modelParameters").or_insert(json!({}));
        *self.main.lock().unwrap() = route;
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
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        false
    }
    fn web_search_route_saved(&self, _route: &Value) {}
}

/// The recorder's `scrub`: the data dir reads `<data>` and every path separator `/`.
fn scrub(value: &Value, data: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(data, "<data>").replace('\\', "/")),
        Value::Array(items) => Value::Array(items.iter().map(|item| scrub(item, data)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), scrub(item, data))).collect()),
        other => other.clone(),
    }
}

/// Node's live config keeps the empty `modelParameters` of a Lead preset it adopted until the
/// next reload; `Config` holds the stored form, which drops it. The save's own answer carries
/// it (`adopted_status`); a later call's answer is compared without it.
fn without_empty_params(mut reply: Value) -> Value {
    if let Some(routes) = reply.pointer_mut("/result/workflowRoutes").and_then(Value::as_object_mut) {
        for route in routes.values_mut().filter_map(Value::as_object_mut) {
            if route.get("modelParameters") == Some(&json!({})) {
                route.shift_remove("modelParameters");
            }
        }
    }
    reply
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
        std::fs::write(&config_path, serde_json::to_vec(&crate::config::agent_routes::stored_file_of(&scenario["config"])).unwrap()).unwrap();
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let host = Arc::new(Host {
            main: Mutex::new(scenario["main"].as_object().map_or(json!({ "provider": "openai", "model": "main-model" }), |m| Value::Object(m.clone()))),
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
            let n = i as u64 + 1;
            let params = if method.starts_with("get") { params } else { with_op(params, n) };
            let req = request(method_name(method), params, Some(n));
            let got = match value(&*service, req).await {
                Ok(v) => json!({ "result": scrub(&v, &data.to_string_lossy()) }),
                Err(CoreError::DomainError { message: Some(message), detail: None, .. }) => json!({ "error": &*message }),
                Err(other) => panic!("{name} #{i} {method}: {other:?}"),
            };
            let want = match step.get("error") {
                Some(e) => json!({ "error": e }),
                None => json!({ "result": step["result"] }),
            };
            assert_eq!(without_empty_params(got), without_empty_params(want), "{name} #{i} {method} {}", step["params"]);
            // The recording's config is Node's in-memory agent section (nothing off unless it lists `disabledAgents`); `Config` holds
            // the stored delta form, which the seed above built the same way.
            let want_config = crate::config::agent_routes::stored_file_of(&step["config"])["agent"].clone();
            assert_eq!(scrub(&Value::Object(config.agent()), &data.to_string_lossy()), want_config, "{name} #{i} {method} config");
            let files: BTreeMap<String, String> = serde_json::from_value(step["files"].clone()).unwrap();
            assert_eq!(files_of(&data), files, "{name} #{i} {method} files");
        }
    }
}

/// The pushed sections hold what the session actions return (`listPresets`, `getWebSearchRoute`, `listWorkflows`,
/// `getOnboardingStatus`), and a pass pushes only the one whose value changed.
#[tokio::test]
async fn the_sections_push_the_values_of_the_actions_and_only_what_changed() {
    use mixdog_core_api::state::SectionChange;
    use mixdog_protocol::SectionName;

    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("root"), dir.path().join("data"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("cfg").join("mixdog-config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    std::fs::write(&config_path, serde_json::to_vec(&crate::config::agent_routes::stored_file_of(&json!({}))).unwrap()).unwrap();
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let host = Arc::new(Host { main: Mutex::new(json!({})), custom_agents: Vec::new(), capable: false, adopted: Mutex::default() });
    let service = WorkflowConfig::new(config.clone(), WorkflowPaths { root, data }, host, scopes(dir.path(), "config").await, &tokens);
    let publisher = MockStatePublisher::default();
    let mut last = [None, None, None, None];

    super::sections::push_changed(&service, &publisher, &mut last).await;
    let first = publisher.published();
    let sections: Vec<(SectionName, Option<String>)> = first.iter().map(|(section, key, _)| (*section, key.clone())).collect();
    assert_eq!(
        sections,
        [
            (SectionName::Presets, None),
            (SectionName::WebSearch, None),
            (SectionName::Workflows, None),
            (SectionName::Config, Some("onboarding".to_owned())),
        ]
    );
    let pushed = |change: &SectionChange| match change {
        SectionChange::Set(bytes) => serde_json::from_slice::<Value>(bytes).unwrap(),
        other => panic!("{other:?}"),
    };
    assert_eq!(pushed(&first[0].2), service.list_presets());
    assert_eq!(pushed(&first[1].2), service.web_search_route().unwrap());
    assert_eq!(pushed(&first[2].2), service.list_workflows().await.unwrap());
    assert_eq!(pushed(&first[3].2), service.onboarding_status().unwrap());
    assert!(pushed(&first[3].2).get("workflowRoutes").is_some(), "the status carries the route summary");

    super::sections::push_changed(&service, &publisher, &mut last).await;
    assert_eq!(publisher.published().len(), 4, "nothing changed, nothing is pushed");

    config
        .update_agent(|doc| {
            doc.insert("presets".into(), json!([{ "id": "mine", "provider": "openai", "model": "gpt-5" }]));
            Ok(())
        })
        .await
        .unwrap();
    super::sections::push_changed(&service, &publisher, &mut last).await;
    let after = publisher.published();
    assert!(after.len() > 4 && after[4].0 == SectionName::Presets, "a changed config pushes the presets again");
    assert!(pushed(&after[4].2).as_array().unwrap().iter().any(|preset| preset["id"] == "mine"));
}

/// `listWorkflows()` over the worlds of `fixtures/desktop/settings/workflow-list-twin.json`: the
/// real Node `listWorkflowPacks` and its mapping, on temp shipped and user folders.
#[tokio::test]
async fn the_catalog_lists_the_packs_as_node_does() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/workflow-list-twin.json");
    let twin: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(twin["cases"].as_array().unwrap().len(), 50);
    for case in twin["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let (root, data) = (dir.path().join("root"), dir.path().join("data"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        for file in case["files"].as_array().unwrap() {
            let base = if file["side"] == "root" { &root } else { &data };
            let target = base.join("workflows").join(file["path"].as_str().unwrap());
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, file["text"].as_str().unwrap()).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let config_path = dir.path().join("cfg").join("mixdog-config.json");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(&config_path, serde_json::to_vec(&crate::config::agent_routes::stored_file_of(&case["config"])).unwrap()).unwrap();
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let host = Arc::new(Host { main: Mutex::new(json!({})), custom_agents: Vec::new(), capable: false, adopted: Mutex::default() });
        let service = WorkflowConfig::new(config, WorkflowPaths { root, data }, host, scopes(dir.path(), "config").await, &tokens);
        let got = service.list_workflows().await.unwrap();
        // Key order is part of the text the model reads.
        assert_eq!(got.to_string(), case["result"].to_string(), "{} {}", case["world"], case["config"]);
    }
}