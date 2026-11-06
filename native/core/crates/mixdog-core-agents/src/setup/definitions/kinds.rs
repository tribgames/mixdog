use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::agents::AgentEffects;
use crate::agents::AgentEvidence;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_ports::ports::setup_actions::CallerScope;

struct Quiet;

#[async_trait]
impl AgentEvidence for Quiet {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

struct Effects;

#[async_trait]
impl AgentEffects for Effects {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
}

struct Callers;

#[async_trait]
impl SetupCallers for Callers {
    async fn scope(&self, _: &ThreadId) -> CallerScope {
        CallerScope::Human
    }
    async fn is_heartbeat(&self, _: &ThreadId) -> bool {
        false
    }
}

type Log = Arc<Mutex<Vec<Value>>>;

/// The recorder's stand-in services: the same canned world, every call logged.
struct Canned {
    world: Value,
    log: Log,
}

fn named(name: &Value) -> Value {
    if name.is_null() { json!({}) } else { json!({ "name": name }) }
}

fn domain(message: String) -> CoreError {
    CoreError::DomainError { domain: "canned".into(), code: None, message: Some(message.into()), detail: None }
}

#[async_trait]
impl DomainService for Canned {
    fn methods(&self) -> &'static [&'static str] {
        &[]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let p = &req.params;
        self.log.lock().unwrap().push(json!({ "method": req.method.as_str(), "params": p }));
        let text = |key: &str| p[key].as_str().unwrap_or_default().to_owned();
        let value = match req.method.as_str() {
            "config/getWorkflowPack" => {
                let name = text("workflowId");
                self.world["workflows"].get(&name).cloned().ok_or_else(|| domain(format!("workflow \"{name}\" not found")))?
            }
            "config/createWorkflow" => json!({ "created": p["payload"] }),
            "config/saveWorkflowPack" => json!({ "saved": p["payload"] }),
            "config/deleteWorkflow" => json!({ "id": p["workflowId"], "deleted": true, "revertedToBuiltIn": false }),
            "skills/skillContent" => {
                let name = text("name");
                let skill = self.world["skills"].get(&name).ok_or_else(|| domain(format!("skill not found: {name}")))?;
                json!({ "content": skill["content"], "name": name })
            }
            "skills/skillsStatus" => {
                json!({ "skills": self.world["skills"].as_object().unwrap().values().map(|s| s["row"].clone()).collect::<Vec<_>>() })
            }
            // `{ name: undefined }` is `{}` once serialised.
            "skills/addSkill" => json!({ "skill": named(&p["input"]["name"]), "status": {} }),
            "skills/saveSkill" => {
                let input = &p["input"];
                let name = if input.get("name").is_some() { &input["name"] } else { &input["originalName"] };
                json!({ "skill": named(name), "status": {} })
            }
            other => panic!("{other}"),
        };
        Ok(Reply::Value(value))
    }

    fn notify(&self, _: mixdog_core_api::ids::Method, _: Value, _: mixdog_core_api::ids::ConnectionId) -> mixdog_core_api::service::Admit {
        unreachable!("no notifications")
    }
}

#[tokio::test]
async fn the_workflow_and_skill_kinds_ask_what_the_recorded_node_handlers_asked() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/definition-kinds-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = Arc::new(
        AgentDefinitions::new(dir.path(), dir.path(), tokens.interactive_io, AgentRoutes::new(config, dir.path()), Arc::new(Quiet), Arc::new(|| Value::Null), dir.path().join("task"))
            .with_writes(tokens.durability_io, Arc::new(Effects), Arc::new(String::new)),
    );
    let log: Log = Arc::default();
    let canned = || Arc::new(Canned { world: twin["world"].clone(), log: log.clone() });
    let setup = DefinitionSetup::new(agents, Arc::new(Callers), canned(), canned());
    let thread = ThreadId::from("sess_task_1");

    let mut failures = Vec::new();
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() >= 400);
    for case in cases {
        log.lock().unwrap().clear();
        let call = SetupCall { action: case["args"]["action"].as_str().unwrap(), args: &case["args"], thread: &thread };
        let got = match setup.run(&call).await {
            Ok(value) => json!({ "ok": value }),
            Err(PortError::Failed { message, .. } | PortError::Denied(message)) => json!({ "error": message }),
            Err(other) => panic!("{other:?}"),
        };
        let want = if case.get("ok").is_some() { json!({ "ok": case["ok"] }) } else { json!({ "error": case["error"] }) };
        let calls = Value::Array(log.lock().unwrap().clone());
        if got != want || calls != case["calls"] {
            failures.push(format!("{}: answered {got} after {calls}; Node {want} after {}", case["args"], case["calls"]));
        }
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}
