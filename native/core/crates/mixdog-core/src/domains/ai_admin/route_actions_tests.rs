//! The setup route actions against the Node recording (`fixtures/ai-admin/route-actions-twin.json`):
//! the chain receipt of `set_route` / `set_agent_route`, a session's return to its primary route
//! and the quota card's actions. The live sessions are a recording `RouteSetupSessions` that
//! answers what the recording knew; the route services under it are the real ones, so the route
//! they return is not compared (their own twins cover it) while the caller's own route switch is
//! asserted by the `follow` it makes.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::agent_route_service::AgentRouteSetter;
use super::agent_route_tests::{Facts, Published};
use super::hidden_agents::hidden_agents;
use super::route_actions::{CallerChain, RouteActions, RouteSetupSessions, SessionFacts};
use super::route_service_tests::rig;
use crate::config::AgentRoutes;
use crate::setup::{CallerScope, SetupActions, SetupCall, SetupCallers};

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/route-actions-twin.json")).unwrap()
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

fn message(error: PortError) -> String {
    match error {
        PortError::Failed { message, .. }
        | PortError::Unavailable { message, .. }
        | PortError::Refused { message, .. }
        | PortError::NotFound { message, .. } => message,
        PortError::Invalid { reason, .. } => reason,
        PortError::Denied(message) => message,
        PortError::Cancelled => "cancelled".into(),
    }
}

struct Callers(CallerScope);

#[async_trait]
impl SetupCallers for Callers {
    async fn scope(&self, _: &ThreadId) -> CallerScope {
        self.0.clone()
    }

    async fn is_heartbeat(&self, _: &ThreadId) -> bool {
        false
    }
}

struct Sessions {
    case: Value,
    controls: Mutex<Vec<Value>>,
}

impl Sessions {
    fn facts(&self, id: &str) -> Option<SessionFacts> {
        let row = self.case["sessions"].as_array().unwrap().iter().find(|s| s["id"] == id)?;
        if row["closed"] == json!(true) {
            return None;
        }
        Some(SessionFacts {
            id: id.to_owned(),
            acting_agent: row["actingAgent"].as_str().unwrap().to_owned(),
            current: obj(&row["current"]),
            hopped: row["hopped"] == json!(true),
            primary: obj(&row["primary"]),
        })
    }
}

#[async_trait]
impl RouteSetupSessions for Sessions {
    fn caller_chain(&self, _: &ThreadId, _: &Obj) -> Option<CallerChain> {
        let chain = &self.case["chain"];
        (!chain.is_null()).then(|| CallerChain { position: chain["position"].clone(), source_is_primary: chain["sourceIsPrimary"] == json!(true) })
    }

    fn session(&self, id: &str, _: &Obj) -> Option<SessionFacts> {
        self.facts(id)
    }

    fn agent_sessions(&self, agent: &str, _: &Obj) -> Vec<SessionFacts> {
        let ids = self.case["agentSessions"][agent].as_array().cloned().unwrap_or_default();
        ids.iter().filter_map(|id| self.facts(id.as_str().unwrap())).collect()
    }

    async fn control(&self, _: &ThreadId, session: &str, method: &str, input: Option<&Obj>) -> Result<Value, PortError> {
        self.controls.lock().unwrap().push(json!([session, method, input.map_or(Value::Null, |i| Value::Object(i.clone()))]));
        Ok(self.case["controlAnswer"].clone())
    }
}

#[tokio::test]
async fn the_setup_route_actions_match_node() {
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let scope = &case["caller"]["scope"];
        let scope = match scope["kind"].as_str().unwrap() {
            "human" => CallerScope::Human,
            "agent" => CallerScope::Agent { agent_id: scope["agentId"].as_str().unwrap().to_owned(), unattended: false },
            other => panic!("{other}"),
        };
        let thread = ThreadId::from(case["caller"]["id"].as_str().unwrap());
        let (service, _writer, log, dir) = rig(&json!({
            "config": case["config"],
            "live": { "provider": "anthropic", "model": "opus" },
            "meta": { "contextWindow": 400000, "id": "x", "maxContextWindow": 400000, "name": "Model X", "provider": "y", "supportsFastMode": true },
            "knows": {}, "fastTable": {}, "ultraTable": {},
        }))
        .await;
        let config = service.config.clone();
        let agents = Arc::new(AgentRouteSetter {
            routes: AgentRoutes::new(config.clone(), dir.path()),
            config: config.clone(),
            context: Arc::new(Facts {
                case: json!({ "known": ["openai", "anthropic", "google", "gemini"], "meta": null, "fastByProvider": {} }),
                config: config.clone(),
            }),
            publisher: Arc::new(Published::default()),
            hidden: hidden_agents(),
        });
        let sessions = Arc::new(Sessions { case: case.clone(), controls: Mutex::new(Vec::new()) });
        let actions = RouteActions { routes: Arc::new(service), agents, sessions: sessions.clone(), callers: Arc::new(Callers(scope)) };
        let args = &case["args"];
        let got = actions.run(&SetupCall { action: args["action"].as_str().unwrap(), args, thread: &thread }).await;
        let strip = |mut v: Value| {
            if let Some(o) = v.as_object_mut() {
                o.remove("route");
            }
            v
        };
        match (case.get("error"), got) {
            (Some(want), Err(e)) => assert_eq!(&json!(message(e)), want, "case {i}: {name}"),
            (None, Ok(v)) => {
                // `set_route` / `set_agent_route` answer the route the services return.
                let keep_route = !matches!(args["action"].as_str().unwrap(), "set_route" | "set_agent_route");
                let (got, want) = if keep_route { (v, case["value"].clone()) } else { (strip(v), strip(case["value"].clone())) };
                assert_eq!(got, want, "case {i}: {name}");
            }
            (want, got) => panic!("case {i}: {name}: wanted {want:?}, got {got:?}"),
        }
        let controls = Value::Array(sessions.controls.lock().unwrap().clone());
        assert_eq!(controls, case["effects"]["control"], "case {i}: {name} configure lane");
        let follows = log.lock().unwrap().follows.clone();
        let want = case["effects"]["setRoute"].as_array().unwrap();
        assert_eq!(follows.len(), want.len(), "case {i}: {name} own route switches");
        for (follow, call) in follows.iter().zip(want) {
            assert_eq!(
                (follow.switch_established, follow.defer_until_next_turn),
                (call["options"]["switchEstablished"] == json!(true), call["options"]["deferUntilNextTurn"] == json!(true)),
                "case {i}: {name} switch options"
            );
        }
    }
}
