//! `thread/setWorkflow`, `thread/setOrchestrationMode` and `thread/switchContext` over a real config file and real packs:
//! what is saved, what the thread's session is asked to switch, and what the caller is told.

#![allow(clippy::disallowed_methods, reason = "test setup: seeds config files and packs on the test thread")]

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
use super::thread_settings::SET_ORCHESTRATION_MODE;
use super::thread_settings::SET_WORKFLOW;
use super::thread_settings::SWITCH_CONTEXT;
use super::thread_settings::SessionSwitches;
use super::thread_settings::ThreadSettings;
use crate::config::Config;
use crate::config::ConfigLanes;
use crate::config::OutputStyles;

struct Host;

#[async_trait]
impl WorkflowHost for Host {
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

/// The thread's session: whether a change reaches it now, and what a session-scoped switch answers (none: no conversation).
struct Session {
    reach: bool,
    mode: Option<Value>,
}

#[async_trait]
impl SessionSwitches for Session {
    async fn settings_reach(&self, _: &str) -> bool {
        self.reach
    }
    async fn switch_workflow(&self, _: &str, _: &str) -> Result<Option<Value>, String> {
        Ok(None)
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

struct Rig {
    service: ThreadSettings,
    config: Config,
    context: Arc<Context>,
    data: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

async fn rig(reach: bool, mode: Option<Value>) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("cfg").join("mixdog-config.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
    let config = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap().0.with_origin(crate::tool_modules::Origin::Given);
    let paths = WorkflowPaths { root: dir.path().join("package"), data: data.clone() };
    let workflow = WorkflowConfig::new(config.clone(), paths, Arc::new(Host), scopes(dir.path(), "config").await, &tokens);
    let context = Arc::new(Context::default());
    let service = ThreadSettings {
        workflow,
        styles: OutputStyles::new(config.clone(), dir.path().join("package/output-styles"), dir.path().join("cfg")),
        switches: Arc::new(Session { reach, mode }),
        context: context.clone(),
        ops: scopes(dir.path(), "thread").await,
    };
    Rig { service, config, context, data, _dir: dir }
}

async fn call(rig: &Rig, method: &'static str, params: Value, n: u64) -> Result<Value, String> {
    match value(&rig.service, request(method, with_op(params, n), Some(n))).await {
        Ok(value) => Ok(value),
        Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
        Err(other) => panic!("{other:?}"),
    }
}

fn write_pack(data: &Path, id: &str) {
    let file = data.join("workflows").join(id).join("WORKFLOW.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, format!("---\nname: {id}\ndescription: the {id} workflow\n---\nsteps")).unwrap();
}

#[tokio::test]
async fn a_mode_outside_the_known_ones_is_refused_and_nothing_is_saved() {
    let rig = rig(true, None).await;
    let error = call(&rig, SET_ORCHESTRATION_MODE, json!({ "threadId": "t1", "mode": "chaos" }), 1).await.unwrap_err();
    assert!(error.starts_with("orchestration mode must be one of ") && error.contains("balanced"), "{error}");
    assert!(rig.config.agent().get("orchestrationMode").is_none());
}

#[tokio::test]
async fn a_chosen_mode_is_saved_and_tells_whether_the_session_follows_it_now() {
    let rig = rig(true, None).await;
    let answer = call(&rig, SET_ORCHESTRATION_MODE, json!({ "threadId": "t1", "mode": "focused" }), 1).await.unwrap();
    assert_eq!(answer, json!({ "mode": "focused", "appliedToCurrentSession": true }));
    assert_eq!(rig.config.agent()["orchestrationMode"], json!("focused"));

    let later = self::rig(false, None).await;
    let answer = call(&later, SET_ORCHESTRATION_MODE, json!({ "threadId": "t1", "mode": "swarm" }), 1).await.unwrap();
    assert_eq!(answer["appliedToCurrentSession"], json!(false), "a session that rebuilds later is told so");
}

#[tokio::test]
async fn a_session_scoped_mode_is_switched_on_the_session_and_not_saved_as_the_default() {
    let switched = json!({ "appliedToCurrentSession": true, "mode": "none" });
    let rig = rig(true, Some(switched.clone())).await;
    let params = json!({ "threadId": "t1", "mode": "none", "options": { "scope": "session" } });
    assert_eq!(call(&rig, SET_ORCHESTRATION_MODE, params, 1).await.unwrap(), switched);
    assert!(rig.config.agent().get("orchestrationMode").is_none());
}

#[tokio::test]
async fn a_workflow_that_is_not_installed_is_refused_by_name() {
    let rig = rig(true, None).await;
    let error = call(&rig, SET_WORKFLOW, json!({ "threadId": "t1", "workflowId": "ghost" }), 1).await.unwrap_err();
    assert_eq!(error, "workflow \"ghost\" not found");
}

#[tokio::test]
async fn an_installed_workflow_becomes_the_active_one() {
    let rig = rig(true, None).await;
    write_pack(&rig.data, "flow");
    let answer = call(&rig, SET_WORKFLOW, json!({ "threadId": "t1", "workflowId": "flow" }), 1).await.unwrap();
    assert_eq!(answer["appliedToCurrentSession"], json!(true));
    assert_eq!(rig.config.agent()["workflow"]["active"], json!("flow"));
}

#[tokio::test]
async fn a_context_switch_hands_the_session_its_folder_desktop_session_and_resume_flag() {
    let rig = rig(true, None).await;
    let input = json!({ "cwd": "/work/a", "desktopSession": { "id": "d1" }, "forResume": true });
    assert_eq!(call(&rig, SWITCH_CONTEXT, json!({ "threadId": "t1", "input": input }), 1).await.unwrap(), json!(true));
    assert_eq!(call(&rig, SWITCH_CONTEXT, json!({ "threadId": "t1" }), 2).await.unwrap(), json!(true));
    let calls = rig.context.calls.lock().unwrap().clone();
    assert_eq!(calls[0], ("t1".to_owned(), Some("/work/a".to_owned()), Some(json!({ "id": "d1" })), true));
    assert_eq!(calls[1], ("t1".to_owned(), None, None, false), "no input switches to nothing in particular");
}
