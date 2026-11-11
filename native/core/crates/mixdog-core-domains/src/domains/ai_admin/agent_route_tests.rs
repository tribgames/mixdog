//! `setAgentRoute` against the Node recording (`fixtures/ai-admin/route-admin-twin.json`
//! `agentCases`) over the real `AgentRoutes` and `Config`; the catalog facts are the recorded ones.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{
    Obj, clean, ensure_provider_enabled, finish_chain_entry, resolve_route, start_chain_entry, window_meta_of,
};
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use mixdog_core_ports::ports::domain_sessions::AgentRoutePublisher;
use super::agent_route_service::AgentRouteSetter;
use mixdog_core_config::config::agent_routes::agent_editor_id;
use mixdog_core_config::config::hidden_agents::hidden_agents;
use super::chain::RouteContext;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/route-admin-twin.json")).unwrap()
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

pub(super) struct Facts {
    pub(super) case: Value,
    pub(super) config: Config,
}

impl Facts {
    fn known(&self, provider: &str, _: &Obj) -> bool {
        self.case["known"].as_array().unwrap().iter().any(|k| k.as_str() == Some(provider.trim()))
    }
}

#[async_trait]
impl RouteContext for Facts {
    fn resolve_main(&self) -> Result<Obj, String> {
        resolve_route(&self.config.agent(), &Obj::new(), &|p, c| self.known(p, c))
    }

    async fn resolve_chain_entry(&self, requested: &Obj, stored: &Obj) -> Result<Obj, String> {
        let config = self.config.agent();
        let selected = start_chain_entry(&config, requested, stored, &|p, c| self.known(p, c))?;
        let _providers = ensure_provider_enabled(&config, &clean(selected.get("provider")));
        let meta = self.case["meta"].clone();
        let meta = (!meta.is_null()).then_some(&meta);
        Ok(finish_chain_entry(selected, meta, window_meta_of(meta, None), |route| {
            self.case["fastByProvider"][clean(route.get("provider")).as_str()].as_bool().unwrap_or(false)
        }))
    }
}

#[derive(Default)]
pub(super) struct Published(pub(super) Mutex<Vec<Value>>);

#[async_trait]
impl AgentRoutePublisher for Published {
    async fn publish(&self, agent_id: &str, route: &Value) {
        self.0.lock().unwrap().push(json!({ "id": agent_id, "route": route }));
    }
}

#[test]
fn editor_ids_match_node() {
    for case in twin()["agentCases"].as_array().unwrap() {
        let want = case["oracle"]["editorId"].as_str().unwrap();
        assert_eq!(agent_editor_id(case["agentId"].as_str().unwrap()), want, "{}", case["agentId"]);
        assert_eq!(hidden_agents().contains(want), case["oracle"]["hidden"].as_bool().unwrap(), "{want}");
    }
}

#[tokio::test]
async fn set_agent_route_matches_node() {
    for (i, case) in twin()["agentCases"].as_array().unwrap().iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&mixdog_core_config::config::agent_routes::stored_file_of(&case["config"])).unwrap()).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let published = Arc::new(Published::default());
        let setter = AgentRouteSetter {
            routes: AgentRoutes::new(config.clone(), dir.path()),
            config: config.clone(),
            context: Arc::new(Facts { case: case.clone(), config: config.clone() }),
            publisher: published.clone(),
            hidden: hidden_agents(),
        };
        let got = match setter.set_agent_route(case["agentId"].as_str().unwrap(), &obj(&case["request"])).await {
            Ok(v) => json!({ "value": v }),
            Err(e) => json!({ "error": e }),
        };
        let want = match case.get("error") {
            Some(e) => json!({ "error": e }),
            None => json!({ "value": case["value"] }),
        };
        assert_eq!(got, want, "agent case {i}: {} {}", case["agentId"], case["request"]);
        let after = &case["after"];
        let id = case["oracle"]["editorId"].as_str().unwrap();
        if !id.is_empty() {
            let own = setter.routes.own_route(id).await.unwrap();
            let own = if own.as_object().is_some_and(|o| o.is_empty()) { Value::Null } else { own };
            assert_eq!(own, after["own"], "agent case {i} own route");
            assert_eq!(json!(setter.routes.is_disabled(id)), after["disabled"], "agent case {i} disabled");
        }
        assert_eq!(Value::Array(published.0.lock().unwrap().clone()), after["published"], "agent case {i} published");
    }
}
