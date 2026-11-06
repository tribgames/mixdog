//! `thread/setWorkflow`, `thread/setOrchestrationMode`, `thread/setOutputStyle` and
//! `thread/switchContext` against the Node recording (`fixtures/thread-settings/`): the real
//! `createWorkflowAgentsApi` over a real config file and packs, and the runtime's real
//! `createContextSwitch` over recording deps. What the session answers is each scenario's.

#![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded packs and seeds config files on the test thread")]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;
use serde_json::Value;
use serde_json::json;

use super::WorkflowConfig;
use super::WorkflowHost;
use super::WorkflowPaths;
use super::ids::Doc;
use super::thread_settings::ContextSwitch;
use super::thread_settings::SessionSwitches;
use super::thread_settings::ThreadSettings;
use crate::config::Config;
use crate::config::ConfigLanes;
use crate::config::OutputStyles;

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/thread-settings")
}

fn recording(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(name)).unwrap()).unwrap()
}

struct Host;

#[async_trait]
impl WorkflowHost for Host {
    async fn thread_mode_facts(&self, _: &str) -> Result<Value, CoreError> {
        Ok(json!({}))
    }
    fn main_route(&self) -> Value {
        json!({})
    }
    async fn adopt_lead_route(&self, _: Value) {}
    async fn custom_agent_ids(&self) -> Vec<String> {
        Vec::new()
    }
    fn provider_available(&self, _: &str) -> bool {
        true
    }
    fn require_local_provider_management(&self) -> Result<(), String> {
        Ok(())
    }
    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn after_credential_change(&self) {}
    async fn ensure_providers_ready(&self, _: Doc) -> Result<(), String> {
        Ok(())
    }
    async fn lookup_model_meta(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn web_search_capable(&self, _: &str, _: Option<&Value>) -> bool {
        false
    }
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        false
    }
    fn web_search_route_saved(&self, _: &Value) {}
}

/// The session as a scenario states it.
struct Session {
    reach: Option<bool>,
    workflow: Option<Value>,
    mode: Option<Value>,
}

#[async_trait]
impl SessionSwitches for Session {
    async fn settings_reach(&self, _: &str) -> bool {
        self.reach != Some(false)
    }
    async fn switch_workflow(&self, _: &str, _: &str) -> Result<Option<Value>, String> {
        Ok(self.workflow.clone())
    }
    async fn switch_orchestration_mode(&self, _: &str, _: &str) -> Result<Option<Value>, String> {
        Ok(self.mode.clone())
    }
}

type Switched = (String, Option<String>, Option<Value>, bool);

#[derive(Default)]
struct Context {
    calls: Mutex<Vec<Switched>>,
}

#[async_trait]
impl ContextSwitch for Context {
    async fn switch_context(&self, thread: &str, cwd: Option<String>, desktop: Option<Value>, for_resume: bool) -> Result<(), String> {
        self.calls.lock().unwrap().push((thread.to_owned(), cwd, desktop, for_resume));
        Ok(())
    }
}

fn nullable(value: &Value) -> Option<Value> {
    Some(value.clone()).filter(|v| !v.is_null())
}

async fn open(dir: &Path, agent: &Value, root_keys: &Value) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.join("cfg").join("mixdog-config.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut root = root_keys.as_object().cloned().unwrap_or_default();
    root.insert("agent".into(), agent.clone());
    std::fs::write(&path, serde_json::to_vec(&Value::Object(root)).unwrap()).unwrap();
    Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap().0
}

struct Rig {
    service: ThreadSettings,
    config: Config,
    context: Arc<Context>,
    _dir: tempfile::TempDir,
}

async fn rig(scenario: &Value) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    for (path, text) in scenario["files"].as_object().unwrap() {
        let file = data.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text.as_str().unwrap()).unwrap();
    }
    std::fs::create_dir_all(&data).unwrap();
    let config = open(dir.path(), &scenario["config"], &scenario["rootKeys"]).await;
    let tokens = mixdog_rt::testing::tokens();
    let paths = WorkflowPaths { root: fixtures().join("shipped"), data: data.clone() };
    let workflow = WorkflowConfig::new(config.clone(), paths, Arc::new(Host), scopes(dir.path(), "config").await, &tokens);
    let context = Arc::new(Context::default());
    let service = ThreadSettings {
        workflow,
        styles: OutputStyles::new(config.clone(), fixtures().join("shipped/output-styles"), dir.path().join("cfg")),
        switches: Arc::new(Session { reach: scenario["reach"].as_bool(), workflow: nullable(&scenario["switchedWorkflow"]), mode: nullable(&scenario["switchedMode"]) }),
        context: context.clone(),
        ops: scopes(dir.path(), "thread").await,
    };
    Rig { service, config, context, _dir: dir }
}

fn method_of(name: &str) -> &'static str {
    match name {
        "setWorkflow" => super::thread_settings::SET_WORKFLOW,
        "setOrchestrationMode" => super::thread_settings::SET_ORCHESTRATION_MODE,
        "setOutputStyle" => super::thread_settings::SET_OUTPUT_STYLE,
        _ => super::thread_settings::SWITCH_CONTEXT,
    }
}

#[tokio::test]
async fn the_settings_methods_match_node() {
    for scenario in recording("settings-scenarios.json")["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let rig = rig(scenario).await;
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let method = step["method"].as_str().unwrap();
            let n = i as u64 + 1;
            let req = request(method_of(method), with_op(step["params"].clone(), n), Some(n));
            let got = match value(&rig.service, req).await {
                Ok(v) => json!({ "result": v }),
                Err(CoreError::DomainError { message: Some(message), detail: None, .. }) => json!({ "error": &*message }),
                Err(other) => panic!("{name} #{i} {method}: {other:?}"),
            };
            let want = match step.get("error") {
                Some(e) => json!({ "error": e }),
                None => json!({ "result": step["result"] }),
            };
            assert_eq!(got, want, "{name} #{i} {method} {}", step["params"]);
            assert_eq!(Value::Object(rig.config.agent()), step["agent"], "{name} #{i} {method} agent");
            let root: serde_json::Map<String, Value> =
                rig.config.full().iter().filter(|(k, _)| !matches!(k.as_str(), "agent" | "defaultsVersion")).map(|(k, v)| (k.clone(), v.clone())).collect();
            assert_eq!(Value::Object(root), step["root"], "{name} #{i} {method} root");
        }
    }
}

#[tokio::test]
async fn a_context_switch_hands_the_session_what_node_applies() {
    let dir = tempfile::tempdir().unwrap();
    for (i, case) in recording("context-switch.json")["cases"].as_array().unwrap().iter().enumerate() {
        let scenario = json!({ "files": {}, "config": {}, "rootKeys": {} });
        let rig = rig(&scenario).await;
        let mut params = json!({});
        if !case["input"].is_null() {
            params["input"] = case["input"].clone();
        }
        let req = request(method_of("switchContext"), with_op(params, 1), Some(1));
        let got = value(&rig.service, req).await.unwrap();
        assert_eq!(got, case["result"], "case {i}");
        let calls = rig.context.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        // The recording's `setDesktopSession`, `applyResolvedCwd` and the route reset (`setRoute`
        // runs only when the switch is not a resume) are the three things the port is handed.
        let recorded = case["calls"].as_array().unwrap();
        let arg = |name: &str| recorded.iter().find(|c| c[0] == name).map(|c| c[1].clone());
        let (_, cwd, desktop, for_resume) = &calls[0];
        assert_eq!(cwd.clone().map_or(Value::Null, Value::String), arg("applyResolvedCwd").unwrap(), "case {i} cwd");
        assert_eq!(desktop.clone().unwrap_or(Value::Null), arg("setDesktopSession").unwrap(), "case {i} desktop");
        assert_eq!(*for_resume, arg("setRoute").is_none(), "case {i} resume");
    }
    drop(dir);
}
