//! The setup route actions against the Node recording (`fixtures/ai-admin/route-actions-twin.json`):
//! the chain receipt of `set_route` / `set_agent_route`, a session's return to its primary route
//! and the quota card's actions. The live sessions are a recording `RouteSetupSessions` and the
//! two route writes a recording `RouteWrites`, both answering as the recording's stubs did, so
//! the whole answer (the route it carries included) and every write and configure-lane call are
//! compared. The route services themselves have their own twins.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use mixdog_core_ports::ports::domain_sessions::CallerChain;
use super::route_actions::RouteActions;
use mixdog_core_ports::ports::domain_sessions::RouteSetupSessions;
use super::route_actions::RouteWrites;
use mixdog_core_ports::ports::domain_sessions::SessionFacts;
use super::route_service::SetRouteOptions;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_core_ports::ports::setup_actions::SetupCallers;

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
    async fn caller_chain(&self, _: &ThreadId, _: &Obj) -> Result<Option<CallerChain>, PortError> {
        let chain = &self.case["chain"];
        Ok((!chain.is_null()).then(|| CallerChain { position: chain["position"].clone(), source_is_primary: chain["sourceIsPrimary"] == json!(true) }))
    }

    async fn session(&self, id: &str, _: &Obj) -> Result<Option<SessionFacts>, PortError> {
        Ok(self.facts(id))
    }

    async fn agent_sessions(&self, agent: &str, _: &Obj) -> Result<Vec<SessionFacts>, PortError> {
        let ids = self.case["agentSessions"][agent].as_array().cloned().unwrap_or_default();
        Ok(ids.iter().filter_map(|id| self.facts(id.as_str().unwrap())).collect())
    }

    async fn control(&self, _: &ThreadId, session: &str, method: &str, input: Option<&Obj>) -> Result<Value, PortError> {
        self.controls.lock().unwrap().push(json!([session, method, input.map_or(Value::Null, |i| Value::Object(i.clone()))]));
        Ok(self.case["controlAnswer"].clone())
    }
}

/// The runtime facade's two writes, answering the route they were given.
struct Writes {
    writes: Mutex<Vec<Value>>,
}

#[async_trait]
impl RouteWrites for Writes {
    async fn set_route(&self, _: &ThreadId, route: &Obj, options: &SetRouteOptions) -> Result<Value, String> {
        // The options as the executor spelled them: only what was set.
        let mut spelled = Obj::new();
        if let Some(keep) = options.keep_main_model {
            spelled.insert("keepMainModel".into(), json!(keep));
        }
        for (key, on) in [
            ("sessionOnly", options.session_only),
            ("switchEstablished", options.follow.switch_established),
            ("deferUntilNextTurn", options.follow.defer_until_next_turn),
        ] {
            if on {
                spelled.insert(key.into(), json!(true));
            }
        }
        self.writes.lock().unwrap().push(json!({ "call": "setRoute", "route": route, "options": spelled }));
        Ok(Value::Object(route.clone()))
    }

    async fn set_agent_route(&self, agent: &str, route: &Obj) -> Result<Value, String> {
        self.writes.lock().unwrap().push(json!({ "call": "setAgentRoute", "agent": agent, "route": route }));
        Ok(Value::Object(route.clone()))
    }

    fn config(&self) -> Obj {
        Obj::new()
    }
}

#[tokio::test]
async fn the_setup_route_actions_match_node() {
    let schema = serde_json::from_str::<Value>(include_str!("../../../../mixdog-tools/src/orch/defs/setup.json")).unwrap()["inputSchema"].clone();
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let scope = &case["caller"]["scope"];
        let scope = match scope["kind"].as_str().unwrap() {
            "human" => CallerScope::Human,
            "agent" => CallerScope::Agent { agent_id: scope["agentId"].as_str().unwrap().to_owned(), unattended: false },
            other => panic!("{other}"),
        };
        let thread = ThreadId::from(case["caller"]["id"].as_str().unwrap());
        let sessions = Arc::new(Sessions { case: case.clone(), controls: Mutex::new(Vec::new()) });
        let writes = Arc::new(Writes { writes: Mutex::new(Vec::new()) });
        let actions = RouteActions { writes: writes.clone(), sessions: sessions.clone(), callers: Arc::new(Callers(scope)), schema: schema.clone() };
        let args = &case["args"];
        let got = actions.run(&SetupCall { action: args["action"].as_str().unwrap(), args, thread: &thread }).await;
        match (case.get("error"), got) {
            (Some(want), Err(e)) => assert_eq!(&json!(message(e)), want, "case {i}: {name}"),
            (None, Ok(v)) => assert_eq!(v, case["value"], "case {i}: {name}"),
            (want, got) => panic!("case {i}: {name}: wanted {want:?}, got {got:?}"),
        }
        assert_eq!(Value::Array(writes.writes.lock().unwrap().clone()), case["effects"]["writes"], "case {i}: {name} writes");
        let controls = Value::Array(sessions.controls.lock().unwrap().clone());
        assert_eq!(controls, case["effects"]["control"], "case {i}: {name} configure lane");
    }
}
