//! `setAgentRoute`: saving, clearing, switching off and switching on an agent's own route, and what each answers and publishes.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::agent_routes::stored_file_of;
use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes};
use mixdog_core_ports::ports::domain_sessions::AgentRoutePublisher;
use serde_json::{Value, json};

use super::agent_route_service::AgentRouteSetter;
use super::chain::RouteContext;

struct Context;

#[async_trait]
impl RouteContext for Context {
    fn resolve_main(&self) -> Result<Obj, String> {
        Ok(json!({ "provider": "openai-oauth", "model": "main-model" }).as_object().unwrap().clone())
    }
    async fn resolve_chain_entry(&self, requested: &Obj, _: &Obj) -> Result<Obj, String> {
        Ok(requested.clone())
    }
}

#[derive(Default)]
struct Published(Mutex<Vec<Value>>);

#[async_trait]
impl AgentRoutePublisher for Published {
    async fn publish(&self, agent_id: &str, route: &Value) {
        self.0.lock().unwrap().push(json!({ "id": agent_id, "provider": route["provider"], "model": route["model"] }));
    }
}

async fn rig() -> (AgentRouteSetter, Arc<Published>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&stored_file_of(&json!({}))).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let published = Arc::new(Published::default());
    let setter = AgentRouteSetter {
        routes: AgentRoutes::new(config.clone(), dir.path()),
        config,
        context: Arc::new(Context),
        publisher: published.clone(),
        hidden: HashSet::from(["maintainer".to_owned()]),
    };
    (setter, published, dir)
}

fn request(value: Value) -> Obj {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn an_agent_that_does_not_exist_or_is_internal_has_no_route_to_set() {
    let (setter, _, _dir) = rig().await;
    assert_eq!(setter.set_agent_route("   ", &request(json!({ "provider": "openai", "model": "m" }))).await.unwrap_err(), "unknown agent \"   \"");
    assert_eq!(
        setter.set_agent_route("maintainer", &request(json!({ "provider": "openai", "model": "m" }))).await.unwrap_err(),
        "agent \"maintainer\" is internal and has no configurable route"
    );
}

#[tokio::test]
async fn a_saved_route_is_stored_answered_and_published_once() {
    let (setter, published, _dir) = rig().await;
    let saved = setter.set_agent_route("reviewer", &request(json!({ "provider": "openai", "model": "gpt-5" }))).await.unwrap();
    assert_eq!((saved["provider"].clone(), saved["model"].clone()), (json!("openai"), json!("gpt-5")));
    let own = setter.routes.own_route("reviewer").await.unwrap();
    assert_eq!((own["provider"].clone(), own["model"].clone()), (json!("openai"), json!("gpt-5")));
    assert_eq!(*published.0.lock().unwrap(), [json!({ "id": "reviewer", "provider": "openai", "model": "gpt-5" })]);

    setter.set_agent_route("reviewer", &request(json!({ "provider": "openai", "model": "gpt-5" }))).await.unwrap();
    assert_eq!(published.0.lock().unwrap().len(), 1, "the chats already run this route");
}

#[tokio::test]
async fn a_route_needs_a_provider_and_a_model() {
    let (setter, _, _dir) = rig().await;
    assert_eq!(setter.set_agent_route("reviewer", &request(json!({ "provider": "openai" }))).await.unwrap_err(), "agent route requires provider and model");
}

#[tokio::test]
async fn naming_only_a_model_keeps_the_stored_provider() {
    let (setter, _, _dir) = rig().await;
    setter.set_agent_route("reviewer", &request(json!({ "provider": "openai", "model": "gpt-5" }))).await.unwrap();
    let changed = setter.set_agent_route("reviewer", &request(json!({ "model": "gpt-6" }))).await.unwrap();
    assert_eq!((changed["provider"].clone(), changed["model"].clone()), (json!("openai"), json!("gpt-6")));
}

#[tokio::test]
async fn clearing_the_provider_makes_the_agent_follow_main_again() {
    let (setter, published, _dir) = rig().await;
    setter.set_agent_route("reviewer", &request(json!({ "provider": "openai", "model": "gpt-5" }))).await.unwrap();
    let cleared = setter.set_agent_route("reviewer", &request(json!({ "provider": "" }))).await.unwrap();
    assert_eq!((cleared["provider"].clone(), cleared["model"].clone(), cleared["inherited"].clone()), (json!("openai-oauth"), json!("main-model"), json!(true)));
    assert_eq!(setter.routes.own_route("reviewer").await.unwrap().as_object().unwrap().get("provider"), None);
    assert_eq!(published.0.lock().unwrap().last().unwrap(), &json!({ "id": "reviewer", "provider": "openai-oauth", "model": "main-model" }), "the chats move to Main's route");
}

#[tokio::test]
async fn switching_an_agent_off_keeps_its_route_and_switching_it_on_answers_whether_it_inherits() {
    async fn toggle(setter: &AgentRouteSetter, id: &str, disabled: bool) -> Value {
        let params = json!({ "threadId": "control", "agentId": id, "route": { "disabled": disabled } });
        mixdog_app_protocol::boundary::validate::check("route/set", Some(&params)).expect("the desktop toggle passes the wire boundary");
        setter.set_agent_route(id, params["route"].as_object().unwrap()).await.unwrap()
    }

    let (setter, published, dir) = rig().await;
    // A migrated non-representative bot keeps its route in the bot store, apart from the Off flag.
    let bots = dir.path().join("bots");
    std::fs::create_dir(&bots).unwrap();
    std::fs::write(bots.join("migration.json"), br#"{"version":1,"bots":["reviewer"]}"#).unwrap();
    setter.set_agent_route("reviewer", &request(json!({ "provider": "openai", "model": "gpt-5" }))).await.unwrap();
    let original = setter.routes.own_route("reviewer").await.unwrap();
    let off = toggle(&setter, "reviewer", true).await;
    assert_eq!((off["id"].clone(), off["disabled"].clone(), off["provider"].clone()), (json!("reviewer"), json!(true), json!("openai")));
    assert!(setter.routes.is_disabled("reviewer"));
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (reopened, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let persisted = AgentRoutes::new(reopened, dir.path());
    assert!(persisted.is_disabled("reviewer"));
    assert_eq!(persisted.own_route("reviewer").await.unwrap(), original);

    let on = toggle(&setter, "reviewer", false).await;
    assert_eq!((on["disabled"].clone(), on["inherited"].clone()), (json!(false), json!(false)), "it keeps its own route");
    assert!(!setter.routes.is_disabled("reviewer"));
    assert_eq!(setter.routes.own_route("reviewer").await.unwrap(), original);
    toggle(&setter, "lead", true).await;
    assert!(!setter.routes.is_disabled("lead"), "the representative cannot be turned off");
    assert_eq!(published.0.lock().unwrap().len(), 1, "neither flag write publishes a model change");

    let (fresh, _, _dir2) = rig().await;
    let on = toggle(&fresh, "reviewer", false).await;
    assert_eq!(on["inherited"], true, "with no route of its own it follows Main");
}

#[tokio::test]
async fn only_if_empty_leaves_a_route_the_agent_already_has() {
    let (setter, published, _dir) = rig().await;
    setter.set_agent_route("reviewer", &request(json!({ "provider": "openai", "model": "gpt-5" }))).await.unwrap();
    let kept = setter.set_agent_route("reviewer", &request(json!({ "provider": "anthropic", "model": "claude-x", "onlyIfEmpty": true }))).await.unwrap();
    assert_eq!((kept["skipped"].clone(), kept["id"].clone(), kept["provider"].clone()), (json!(true), json!("reviewer"), json!("openai")));
    assert_eq!(published.0.lock().unwrap().len(), 1);
}
