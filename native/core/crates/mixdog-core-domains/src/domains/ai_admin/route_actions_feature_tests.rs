//! The setup route actions: the chain receipt of `set_route` / `set_agent_route`, a session's return to its primary route, and
//! the quota card's actions on another session.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::domain_sessions::{CallerChain, RouteSetupSessions, SessionFacts};
use mixdog_core_ports::ports::setup_actions::{CallerScope, SetupActions, SetupCall, SetupCallers};
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::route_actions::{RouteActions, RouteWrites};
use super::route_service::SetRouteOptions;

fn obj(value: Value) -> Obj {
    value.as_object().cloned().unwrap()
}

fn message(error: PortError) -> String {
    match error {
        PortError::Failed { message, .. } | PortError::Unavailable { message, .. } => message,
        PortError::Invalid { reason, .. } => reason,
        PortError::Denied(message) => message,
        other => panic!("{other:?}"),
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
    chain: Option<CallerChain>,
    /// (id, acting agent, hopped)
    rows: Vec<(&'static str, &'static str, bool)>,
    control_answer: Value,
    controls: Mutex<Vec<Value>>,
}

impl Sessions {
    fn facts(&self, id: &str) -> Option<SessionFacts> {
        let (id, agent, hopped) = *self.rows.iter().find(|row| row.0 == id)?;
        Some(SessionFacts {
            id: id.to_owned(),
            acting_agent: agent.to_owned(),
            current: obj(json!({ "provider": "anthropic", "model": "fallback-model" })),
            hopped,
            primary: obj(json!({ "provider": "openai", "model": "primary-model", "effort": "high", "extra": "dropped" })),
        })
    }
}

#[async_trait]
impl RouteSetupSessions for Sessions {
    async fn caller_chain(&self, _: &ThreadId, _: &Obj) -> Result<Option<CallerChain>, PortError> {
        Ok(self.chain.clone())
    }
    async fn session(&self, id: &str, _: &Obj) -> Result<Option<SessionFacts>, PortError> {
        Ok(self.facts(id))
    }
    async fn agent_sessions(&self, agent: &str, _: &Obj) -> Result<Vec<SessionFacts>, PortError> {
        Ok(self.rows.iter().filter(|row| row.1 == agent).filter_map(|row| self.facts(row.0)).collect())
    }
    async fn control(&self, _: &ThreadId, session: &str, method: &str, input: Option<&Obj>) -> Result<Value, PortError> {
        self.controls.lock().unwrap().push(json!([session, method, input.map_or(Value::Null, |i| Value::Object(i.clone()))]));
        Ok(self.control_answer.clone())
    }
}

#[derive(Default)]
struct Writes(Mutex<Vec<Value>>);

#[async_trait]
impl RouteWrites for Writes {
    async fn set_route(&self, _: &ThreadId, route: &Obj, options: &SetRouteOptions) -> Result<Value, String> {
        self.0.lock().unwrap().push(json!({
            "call": "setRoute", "route": route, "keepMainModel": options.keep_main_model, "sessionOnly": options.session_only,
            "switchEstablished": options.follow.switch_established, "defer": options.follow.defer_until_next_turn
        }));
        Ok(Value::Object(route.clone()))
    }
    async fn set_agent_route(&self, agent: &str, route: &Obj) -> Result<Value, String> {
        self.0.lock().unwrap().push(json!({ "call": "setAgentRoute", "agent": agent, "route": route }));
        Ok(Value::Object(route.clone()))
    }
    fn config(&self) -> Obj {
        Obj::new()
    }
}

fn rig(scope: CallerScope, sessions: Sessions) -> (RouteActions, Arc<Writes>, Arc<Sessions>) {
    let schema = serde_json::from_str::<Value>(include_str!("../../../../mixdog-tools/src/orch/defs/setup.json")).unwrap()["inputSchema"].clone();
    let (writes, sessions) = (Arc::new(Writes::default()), Arc::new(sessions));
    (RouteActions { writes: writes.clone(), sessions: sessions.clone(), callers: Arc::new(Callers(scope)), schema }, writes, sessions)
}

fn sessions(rows: Vec<(&'static str, &'static str, bool)>) -> Sessions {
    Sessions { chain: None, rows, control_answer: json!(true), controls: Mutex::default() }
}

async fn run(actions: &RouteActions, caller: &str, args: Value) -> Result<Value, String> {
    let thread = ThreadId::from(caller);
    let action = args["action"].as_str().unwrap().to_owned();
    actions.run(&SetupCall { action: &action, args: &args, thread: &thread }).await.map_err(message)
}

#[tokio::test]
async fn set_route_writes_the_fields_a_route_may_carry_as_an_explicit_main_model_choice() {
    let (actions, writes, _) = rig(CallerScope::Human, sessions(vec![]));
    let answer = run(&actions, "t", json!({ "action": "set_route", "route": { "provider": " openai ", "model": " gpt-5 ", "effort": "high", "fast": true } })).await.unwrap();
    let route = json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": true });
    assert_eq!(answer, json!({ "route": route }), "no chain edited, no receipt");
    assert_eq!(*writes.0.lock().unwrap(), [json!({ "call": "setRoute", "route": route, "keepMainModel": false, "sessionOnly": false, "switchEstablished": false, "defer": false })]);
}

#[tokio::test]
async fn a_saved_chain_is_reported_as_applied_only_when_the_caller_follows_it_from_settings() {
    let position = json!({ "kind": "lead", "chainFrom": "settings", "fallbacks": [{ "provider": "anthropic", "model": "b" }] });
    let route = json!({ "provider": "openai", "model": "a", "fallbacks": [{ "provider": "anthropic", "model": "b" }] });
    let mut following = sessions(vec![]);
    following.chain = Some(CallerChain { position: position.clone(), source_is_primary: true });
    let (actions, _, _) = rig(CallerScope::Human, following);
    let answer = run(&actions, "t", json!({ "action": "set_route", "route": route })).await.unwrap();
    assert_eq!((answer["appliedToCurrentSession"].clone(), answer["currentSession"].clone()), (json!(true), position.clone()));

    let mut other_chain = sessions(vec![]);
    other_chain.chain = Some(CallerChain { position, source_is_primary: true });
    let (actions, _, _) = rig(CallerScope::Human, other_chain);
    let changed = json!({ "provider": "openai", "model": "a", "fallbacks": [{ "provider": "anthropic", "model": "other" }] });
    assert_eq!(run(&actions, "t", json!({ "action": "set_route", "route": changed })).await.unwrap()["appliedToCurrentSession"], false, "the caller follows a different chain");

    let mut not_primary = sessions(vec![]);
    not_primary.chain = Some(CallerChain { position: json!({ "kind": "lead", "chainFrom": "settings", "fallbacks": [] }), source_is_primary: false });
    let (actions, _, _) = rig(CallerScope::Human, not_primary);
    let empty = json!({ "provider": "openai", "model": "a", "fallbacks": [] });
    assert_eq!(run(&actions, "t", json!({ "action": "set_route", "route": empty })).await.unwrap()["appliedToCurrentSession"], false, "its chain does not start from the saved primary");
}

#[tokio::test]
async fn an_agent_thread_may_set_only_its_own_agents_route() {
    let (actions, writes, _) = rig(CallerScope::Agent { agent_id: "worker".into(), unattended: false }, sessions(vec![]));
    let denied = run(&actions, "t", json!({ "action": "set_agent_route", "agent": "reviewer", "route": { "provider": "openai", "model": "m" } })).await.unwrap_err();
    assert_eq!(denied, "This thread manages only its own agent's settings (setup set_agent_route)");
    assert!(writes.0.lock().unwrap().is_empty());
    let own = run(&actions, "t", json!({ "action": "set_agent_route", "agent": " worker ", "route": { "provider": "openai", "model": "m" } })).await.unwrap();
    assert_eq!(own["agent"], "worker");
    assert_eq!(writes.0.lock().unwrap()[0]["agent"], "worker");
}

#[tokio::test]
async fn an_agent_route_needs_an_agent_name() {
    let (actions, _, _) = rig(CallerScope::Human, sessions(vec![]));
    assert_eq!(run(&actions, "t", json!({ "action": "set_agent_route", "agent": "  ", "route": { "provider": "openai", "model": "m" } })).await.unwrap_err(), "agent is required");
}

#[tokio::test]
async fn resetting_a_session_that_hopped_returns_it_to_its_primary_route() {
    let (actions, writes, sessions) = rig(CallerScope::Human, sessions(vec![("me", "lead", true), ("s2", "lead", true), ("s3", "lead", false)]));
    let own = run(&actions, "me", json!({ "action": "reset_route_fallback" })).await.unwrap();
    assert_eq!(own, json!({ "scope": "session", "reset": [{ "sessionId": "me", "from": { "provider": "anthropic", "model": "fallback-model" }, "to": { "provider": "openai", "model": "primary-model" } }] }));
    assert_eq!(
        *writes.0.lock().unwrap(),
        [json!({ "call": "setRoute", "route": { "provider": "openai", "model": "primary-model", "effort": "high" }, "keepMainModel": null, "sessionOnly": true, "switchEstablished": true, "defer": true })],
        "the session's own pick, from its next turn, with only the switchable fields"
    );

    let other = run(&actions, "me", json!({ "action": "reset_route_fallback", "sessionId": "s2" })).await.unwrap();
    assert_eq!(other["reset"][0]["sessionId"], "s2");
    assert_eq!(sessions.controls.lock().unwrap()[0], json!(["s2", "setRoute", { "provider": "openai", "model": "primary-model", "effort": "high" }]));

    let idle = run(&actions, "me", json!({ "action": "reset_route_fallback", "sessionId": "s3" })).await.unwrap();
    assert_eq!(idle, json!({ "scope": "session", "reset": [], "alreadyOnPrimary": [{ "sessionId": "s3", "current": { "provider": "anthropic", "model": "fallback-model" } }] }));
}

#[tokio::test]
async fn resetting_names_one_target_and_refuses_what_it_cannot_find() {
    let (actions, _, _) = rig(CallerScope::Human, sessions(vec![("me", "lead", true)]));
    assert_eq!(run(&actions, "me", json!({ "action": "reset_route_fallback", "sessionId": "me", "agent": "lead" })).await.unwrap_err(), "Pass sessionId or agent, not both");
    assert_eq!(run(&actions, "me", json!({ "action": "reset_route_fallback", "agent": "  " })).await.unwrap_err(), "agent is required");
    assert_eq!(run(&actions, "me", json!({ "action": "reset_route_fallback", "sessionId": "s9" })).await.unwrap_err(), "session s9 not found");
    let by_agent = run(&actions, "me", json!({ "action": "reset_route_fallback", "agent": "lead" })).await.unwrap();
    assert_eq!(by_agent["reset"][0]["sessionId"], "me");
}

#[tokio::test]
async fn continuing_in_a_model_and_the_quota_resume_apply_to_another_session_only() {
    let (actions, _, sessions) = rig(CallerScope::Human, self::sessions(vec![("me", "lead", false), ("s2", "lead", false)]));
    let refused = "applies to another session: this one is running the setup call";
    assert_eq!(run(&actions, "me", json!({ "action": "continue_in_model", "sessionId": "me", "route": { "provider": "openai", "model": "m" } })).await.unwrap_err(), format!("continue_in_model {refused}"));
    assert_eq!(run(&actions, "me", json!({ "action": "schedule_quota_resume", "sessionId": "me" })).await.unwrap_err(), format!("schedule_quota_resume {refused}"));

    let continued = run(&actions, "me", json!({ "action": "continue_in_model", "sessionId": "s2", "route": { "provider": "openai", "model": "m", "effort": "low" } })).await;
    let continued = continued.unwrap();
    assert_eq!(continued["continued"], true);
    assert_eq!(continued["route"], json!({ "provider": "openai", "model": "m" }));
    assert_eq!(sessions.controls.lock().unwrap()[0][1], "continueSessionInModel");

    assert_eq!(run(&actions, "me", json!({ "action": "schedule_quota_resume", "sessionId": "s2" })).await.unwrap(), json!({ "scope": "session", "sessionId": "s2", "scheduled": true }));
    assert_eq!(run(&actions, "me", json!({ "action": "cancel_quota_resume", "sessionId": "s2" })).await.unwrap(), json!({ "scope": "session", "sessionId": "s2", "cancelled": true }));
}
