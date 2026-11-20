//! The `agent/` methods as a connection calls them: a paired phone's calls are no-widen whatever they send, and a
//! standing allow is refused over remote access.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt as _;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_rt::{DurabilityIo, InLane, LaneToken as _};
use mixdog_tools::policy::FileGrantStore;
use serde_json::Value;
use serde_json::json;

use super::tests::writable;
use super::*;

struct Catalog;

#[async_trait]
impl ConnectorCatalog for Catalog {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(vec!["gmail".into()])
    }
    async fn tool_names(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(vec!["send".into()])
    }
    fn connector_of(&self, server: &str) -> Option<String> {
        (server == "gmail").then(|| "gmail".to_owned())
    }
}

/// A catalog whose installed connectors change while a test runs.
struct Live(std::sync::Mutex<Vec<String>>);

#[async_trait]
impl ConnectorCatalog for Live {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    async fn tool_names(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn connector_of(&self, _: &str) -> Option<String> {
        None
    }
}

#[tokio::test]
async fn a_connector_installed_while_an_edit_waits_is_not_enabled_by_migrating_a_legacy_policy() {
    let (_dir, agents) = writable(serde_json::json!({})).await;
    let agents = Arc::new(agents);
    agents.save(serde_json::json!({ "name": "Legacy", "body": "Body" }).as_object().unwrap()).await.unwrap();
    // A save refuses a legacy list; one only ever sits on disk.
    let data = dir_data(&agents);
    write(&data.join("agents/legacy/agent.json"), r#"{"connectors":["gmail"]}"#.as_bytes()).unwrap();
    let catalog = Arc::new(Live(std::sync::Mutex::new(vec!["gmail".into()])));
    let connectors = Arc::new(AgentConnectors::new(agents.clone(), catalog.clone()));
    // Another turn of the agent holds its queue; the edit starts behind it.
    let turn = lifecycle(&dir_data(&agents), "legacy").await;
    let edit = tokio::spawn({
        let connectors = connectors.clone();
        async move { connectors.set_enabled("legacy", &Value::String("gmail".into()), &Value::Bool(true), false).await }
    });
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    catalog.0.lock().unwrap().push("drive".into());
    drop(turn);
    edit.await.unwrap().unwrap();
    // `drive` was installed when the edit's turn came, and the legacy list never enabled it.
    let stored = agents.connector_policy("legacy").await.unwrap();
    assert!(stored.enabled("gmail"));
    assert!(!stored.enabled("drive"), "{:?}", stored.json());
}

// `unconstrained`: inside a tokio test the handle's oneshot would otherwise answer Pending once the task's coop budget is spent.
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

/// `std::fs::write`, through the statefile publication.
fn write(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let (path, body) = (path.to_owned(), body.to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other))
}

fn dir_data(agents: &AgentDefinitions) -> std::path::PathBuf {
    agents.folders.data.clone()
}

async fn service() -> (tempfile::TempDir, AgentService) {
    let (dir, agents) = writable(json!({})).await;
    let agents = Arc::new(agents);
    agents.save(json!({ "name": "Ada", "body": "Body" }).as_object().unwrap()).await.unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let data = dir_data(&agents);
    let connectors = AgentConnectors::new(agents.clone(), Arc::new(Catalog));
    connectors.set_tool_permission("ada", &json!("gmail"), &json!("send"), &json!("needs_approval"), false).await.unwrap();
    let grants = FileGrantStore::with_clock(data.join("human-gate"), tokens.interactive_io, tokens.durability_io, Arc::new(|| 1));
    let service = AgentService::new(agents, connectors, AgentPermissions::new(grants), lifecycle_tests::quiet_lifecycle());
    (dir, service)
}

async fn call(service: &AgentService, method: &'static str, params: Value, relay: bool) -> Result<Value, CoreError> {
    let ctx = if relay {
        CallContext::connection(mixdog_core_api::ids::ConnectionId(1), mixdog_protocol::Origin::Relay, CancellationToken::new())
    } else {
        CallContext::internal("agents")
    };
    match service.call(CoreRequest { method: Method(method), params, op: None, ctx }).await? {
        Reply::Value(value) => Ok(value),
        other => panic!("not a value reply: {other:?}"),
    }
}

fn message(error: CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_deref().unwrap_or("").to_owned(),
        other => panic!("not a domain error: {other:?}"),
    }
}

#[tokio::test]
async fn a_phone_cannot_create_a_standing_allow_over_remote_access() {
    let (_dir, service) = service().await;
    let params = json!({ "agentId": "ada", "action": "write", "mode": "allow" });
    let refused = call(&service, "agent/setAgentPermission", params, true).await.unwrap_err();
    assert_eq!(message(refused), "setAgentPermission cannot create a standing allow over remote access; use the desktop.");
}

#[tokio::test]
async fn a_phone_call_is_no_widen_whatever_options_it_sends_and_the_desktops_is_not() {
    let (_dir, service) = service().await;
    let widen = json!({ "agentId": "ada", "connectorId": "gmail", "toolName": "send", "permission": "auto", "options": { "noWiden": false } });
    let refused = call(&service, "agent/setAgentConnectorToolPermission", widen.clone(), true).await.unwrap_err();
    assert!(!message(refused).is_empty());
    // The same widening from the desktop is allowed.
    call(&service, "agent/setAgentConnectorToolPermission", widen, false).await.unwrap();
    // A phone may narrow.
    let narrow = json!({ "agentId": "ada", "connectorId": "gmail", "toolName": "send", "permission": "disabled" });
    call(&service, "agent/setAgentConnectorToolPermission", narrow, true).await.unwrap();
}

#[tokio::test]
async fn a_definition_saved_through_the_service_can_be_read_back_and_deleted() {
    let (_dir, service) = service().await;
    let saved = call(&service, "agent/saveAgentDefinition", json!({ "payload": { "name": "Bea", "body": "Be kind" } }), false).await.unwrap();
    assert_eq!(saved["id"], "bea");
    let got = call(&service, "agent/getAgentDefinition", json!({ "agentId": "bea" }), false).await.unwrap();
    assert!(got.to_string().contains("Be kind"), "{got}");
    let missing_payload = call(&service, "agent/saveAgentDefinition", json!({}), false).await.unwrap_err();
    assert!(matches!(missing_payload, CoreError::InvalidParams { .. }));
}
