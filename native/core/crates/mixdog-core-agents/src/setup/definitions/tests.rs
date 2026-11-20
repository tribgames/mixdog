use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
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

mod actions;

/// Nothing is said about the chats or the routines: the recorder ran with none.
struct NoEvidence;

#[async_trait]
impl AgentEvidence for NoEvidence {
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

/// The agent golden never names the workflow or skill kinds.
struct Unused;

#[async_trait]
impl mixdog_core_api::service::DomainService for Unused {
    fn methods(&self) -> &'static [&'static str] {
        &[]
    }
    async fn call(&self, _: mixdog_core_api::CoreRequest) -> Result<mixdog_core_api::Reply, CoreError> {
        panic!("a workflow or skill service was called by the agent golden")
    }
    fn notify(&self, _: mixdog_core_api::ids::Method, _: Value, _: mixdog_core_api::ids::ConnectionId) -> mixdog_core_api::service::Admit {
        unreachable!("no notifications")
    }
}

/// Remembers the routes a save sent to the route setter.
#[derive(Default)]
struct NoEffects(std::sync::Mutex<Vec<Value>>);

#[async_trait]
impl AgentEffects for NoEffects {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, id: &str, route: &Value) -> Result<(), String> {
        self.0.lock().unwrap().push(json!({ "id": id, "route": route }));
        Ok(())
    }
    async fn delete_owned_routines(&self, _: &str) -> Result<crate::agents::OwnedRoutines, String> {
        Ok(crate::agents::OwnedRoutines::default())
    }
}

/// The recorder's three sessions: Mixy's chat, a coding task and a contact's chat.
struct Callers;

#[async_trait]
impl SetupCallers for Callers {
    async fn scope(&self, _: &ThreadId) -> CallerScope {
        CallerScope::Human
    }
    async fn is_heartbeat(&self, _: &ThreadId) -> bool {
        false
    }
    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        Ok(match thread.as_str() {
            "sess_home_ada" => "ada".into(),
            _ => "lead".into(),
        })
    }
    async fn agent_mode(&self, thread: &ThreadId) -> bool {
        thread.as_str() != "sess_task_1"
    }
}





#[tokio::test]
async fn a_route_sent_with_a_save_goes_to_the_route_setter_after_the_files() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let effects = Arc::new(NoEffects::default());
    let agents = AgentDefinitions::new(dir.path(), dir.path(), tokens.interactive_io, AgentRoutes::new(config, dir.path()), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.path().join("task"))
        .with_writes(tokens.durability_io, effects.clone(), Arc::new(String::new));
    let route = json!({ "provider": "openai", "model": "gpt-6" });
    let payload = json!({ "name": "Routed", "body": "Body", "route": route }).as_object().unwrap().clone();
    let view = agents.save(&payload).await.unwrap();
    assert_eq!(view["id"], "routed");
    assert_eq!(*effects.0.lock().unwrap(), vec![json!({ "id": "routed", "route": route })]);
    // A falsy route is no route.
    let payload = json!({ "id": "routed", "body": "Body", "route": null }).as_object().unwrap().clone();
    agents.save(&payload).await.unwrap();
    assert_eq!(effects.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_name_that_is_no_text_is_an_unknown_agent_not_the_id_undefined() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = Arc::new(
        AgentDefinitions::new(dir.path(), dir.path(), tokens.interactive_io, AgentRoutes::new(config, dir.path()), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.path().join("task"))
            .with_writes(tokens.durability_io, Arc::new(NoEffects::default()), Arc::new(String::new)),
    );
    // An agent that really is called "undefined" and one called "null" exist.
    for id in ["undefined", "null"] {
        agents.save(json!({ "id": id, "body": "Body" }).as_object().unwrap()).await.unwrap();
    }
    let setup = DefinitionSetup::new(agents, Arc::new(Callers), Arc::new(Unused), Arc::new(Unused));
    let thread = ThreadId::from("sess_task_1");
    for (action, args, text) in [
        ("read_definition", json!({ "definitionKind": "agent" }), "undefined"),
        ("read_definition", json!({ "definitionKind": "agent", "name": null }), "null"),
        ("delete_definition", json!({ "definitionKind": "agent" }), "undefined"),
        ("delete_definition", json!({ "definitionKind": "agent", "name": null }), "null"),
    ] {
        let call = SetupCall { action, args: &args, thread: &thread };
        match setup.run(&call).await {
            Err(PortError::Failed { message, .. }) => assert_eq!(message, format!("unknown agent \"{text}\""), "{action} {args}"),
            other => panic!("{action} {args}: {other:?}"),
        }
    }
}


