//! The `agents` status reader: what the setup tool's status shows of the agents.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::agents::AgentEvidence;

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

/// The config service as the reader asks it: the calling thread's mode, the shared bot order.
struct ConfigService {
    mode: String,
    order: Value,
}

#[async_trait]
impl DomainCalls for ConfigService {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        match method {
            "config/getOrchestrationMode" => {
                assert_eq!(params, json!({ "threadId": "sess_a" }));
                Ok(json!(self.mode))
            }
            "config/getBotOrder" => Ok(json!({ "order": self.order })),
            other => panic!("unexpected domain call {other}"),
        }
    }
}

struct Held(Vec<Value>);

#[async_trait]
impl RoutePositions for Held {
    async fn others(&self, caller: &ThreadId) -> Result<Vec<Value>, PortError> {
        assert_eq!(caller.as_str(), "sess_a");
        Ok(self.0.clone())
    }
}

async fn agents() -> (tempfile::TempDir, Arc<AgentDefinitions>) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(
        dir.path().join("shipped"),
        dir.path().join("data"),
        tokens.interactive_io,
        AgentRoutes::new(config, dir.path().join("data")),
        Arc::new(NoEvidence),
        Arc::new(|| Value::Null),
        dir.path().join("task"),
    );
    (dir, Arc::new(agents))
}

async fn status(held: Vec<Value>, mode: &str, order: Value) -> Value {
    let (_dir, agents) = agents().await;
    let reader = AgentsStatus::new(agents, Arc::new(ConfigService { mode: mode.to_owned(), order }), Arc::new(Held(held)));
    reader.read("agents", false, &ThreadId::from("sess_a")).await.unwrap()
}

#[tokio::test]
async fn the_status_lists_the_catalog_mode_bot_order_and_held_sessions_in_that_order() {
    let held = vec![json!({ "sessionId": "sess_b", "kind": "bot" }), json!({ "sessionId": "sess_c", "kind": "agent" })];
    let got = status(held.clone(), "balanced", json!(["a"])).await;
    let keys: Vec<&String> = got.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["agents", "orchestrationMode", "orchestrationModes", "botOrder", "sessions"]);
    assert_eq!(got["orchestrationMode"], "balanced");
    assert_eq!(got["orchestrationModes"], json!(["none", "focused", "balanced", "swarm"]));
    assert_eq!(got["botOrder"], json!(["a"]));
    assert_eq!(got["sessions"], json!(held), "the held sessions are given whole and in the order the route owner gave them");
    assert!(got["agents"].is_array() || got["agents"].is_object());
}

#[tokio::test]
async fn a_bot_order_the_config_does_not_give_reads_as_null() {
    let (_dir, agents) = agents().await;
    struct NoOrder;
    #[async_trait]
    impl DomainCalls for NoOrder {
        async fn call(&self, method: &'static str, _: Value) -> Result<Value, CoreError> {
            Ok(if method == "config/getBotOrder" { json!({}) } else { json!("none") })
        }
    }
    let reader = AgentsStatus::new(agents, Arc::new(NoOrder), Arc::new(Held(Vec::new())));
    let got = reader.read("agents", false, &ThreadId::from("sess_a")).await.unwrap();
    assert_eq!(got["botOrder"], Value::Null);
    assert_eq!(got["sessions"], json!([]));
}

#[tokio::test]
async fn another_domain_is_not_this_readers() {
    let (_dir, agents) = agents().await;
    let reader = AgentsStatus::new(agents, Arc::new(ConfigService { mode: "none".into(), order: json!([]) }), Arc::new(Held(Vec::new())));
    assert!(reader.read("models", false, &ThreadId::from("sess_a")).await.is_err());
}
