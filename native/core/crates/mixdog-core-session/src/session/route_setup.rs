//! The setup route actions' session side (`RouteSetupSessions`): the sessions held here, their
//! fallback position and primary route (Node `setup-tool/session-route-actions.mjs`,
//! `executor.mjs` `chainReceipt`), and the daemon's configure lane that reaches another session
//! (`daemon-session-control/route-control.mjs`).
//!
//! A session is its acked header with its id, read as Node reads the live object. The reads are
//! async so that a stored thread and the agent's home thread can come from disk
//! (`mgr.getSession`, `loadSession`); for now only a thread this process has loaded is found.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use mixdog_core_ports::ports::domain_sessions::CallerChain;
use mixdog_core_ports::ports::domain_sessions::RouteSetupSessions;
use mixdog_core_ports::ports::domain_sessions::SessionFacts;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_run::run_host::route_chain::RouteReadUnavailable;
use mixdog_core_ports::ports::domain_sessions::Obj;
use mixdog_core_run::run_host::route_chain::primary_route;
use mixdog_core_run::run_host::route_chain::resolve_session_mode;
use mixdog_core_run::run_host::route_chain::route_fallback_hopped;
use mixdog_core_run::run_host::route_chain::route_fallback_position;
use mixdog_core_run::run_host::route_chain::same_route_model;
use mixdog_core_run::run_host::route_chain::session_chain_source;
use mixdog_core_run::run_host::route_chain::session_route_primary;

/// One core method on another thread (the session protocol's configure lane): the
/// composition answers it over the core's own method table.
#[async_trait]
pub trait CoreCalls: Send + Sync {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError>;
}

pub struct SessionRouteSetup {
    directory: Arc<SessionDirectory>,
    bots: Arc<dyn BotRoutes + Send + Sync>,
    core: Arc<dyn CoreCalls>,
}

impl SessionRouteSetup {
    pub fn new(directory: Arc<SessionDirectory>, bots: Arc<dyn BotRoutes + Send + Sync>, core: Arc<dyn CoreCalls>) -> Self {
        Self { directory, bots, core }
    }

    /// The session record of a loaded thread (its header with its id); `None` otherwise.
    fn load(&self, id: &str) -> Option<Value> {
        let handle = self.directory.handle(&ThreadId::from(id))?;
        let mut session = (*handle.cell.header.load_full()).clone();
        session.insert("id".into(), json!(id));
        Some(Value::Object(session))
    }

    fn open(&self, id: &str) -> Option<Value> {
        self.load(id).filter(|session| session.get("closed") != Some(&Value::Bool(true)))
    }

    async fn facts(&self, session: &Value, config: &Obj) -> Result<SessionFacts, PortError> {
        let mut current = Obj::new();
        for key in ["provider", "model"] {
            if let Some(value) = session.get(key) {
                current.insert(key.into(), value.clone());
            }
        }
        Ok(SessionFacts {
            id: session["id"].as_str().unwrap_or_default().to_owned(),
            acting_agent: acting_agent_of(session),
            current,
            hopped: route_fallback_hopped(session),
            primary: primary_route(session, config, &*self.bots).await.map_err(unavailable)?,
        })
    }
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

/// `actingAgentOf` (`session-route-actions.mjs:42`):
/// `resolveSessionMode({ session }).agentId || clean(session?.agent)`.
fn acting_agent_of(session: &Value) -> String {
    let (_, agent) = resolve_session_mode(session);
    if agent.is_empty() { clean(session.get("agent")) } else { agent }
}

fn session_error(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "session".into(), message: message.into() }
}

/// A bot route read that never ran: the route source is unknown, so no position is guessed.
fn unavailable(error: RouteReadUnavailable) -> PortError {
    session_error(error.to_string())
}

/// `ROUTE_FIELDS`, and `routeFields(input)`: only route fields cross, provider and model required.
fn route_fields(input: Option<&Obj>) -> Result<Obj, PortError> {
    const ROUTE_FIELDS: [&str; 8] =
        ["provider", "model", "effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"];
    let mut route = Obj::new();
    for key in ROUTE_FIELDS {
        if let Some(value) = input.and_then(|i| i.get(key)).filter(|v| !v.is_null()) {
            route.insert(key.into(), value.clone());
        }
    }
    if !truthy(route.get("provider")) || !truthy(route.get("model")) {
        return Err(session_error("session: route provider and model are required"));
    }
    Ok(route)
}

#[async_trait]
impl RouteSetupSessions for SessionRouteSetup {
    /// `chainReceipt`: nothing for a caller without its own `agent`.
    async fn caller_chain(&self, thread: &ThreadId, config: &Obj) -> Result<Option<CallerChain>, PortError> {
        let Some(caller) = self.load(thread.as_str()) else { return Ok(None) };
        if !truthy(caller.get("agent")) {
            return Ok(None);
        }
        let position = route_fallback_position(&caller, config, &*self.bots).await.map_err(unavailable)?;
        let source = session_chain_source(&caller, config, &*self.bots).await.map_err(unavailable)?;
        let primary = session_route_primary(&caller);
        Ok(Some(CallerChain { position, source_is_primary: same_route_model(source.as_ref(), Some(&primary)) }))
    }

    async fn session(&self, id: &str, config: &Obj) -> Result<Option<SessionFacts>, PortError> {
        let Some(session) = self.open(id) else { return Ok(None) };
        Ok(Some(self.facts(&session, config).await?))
    }

    /// The agent's chats held here (home, room seats), then its home thread.
    async fn agent_sessions(&self, agent: &str, config: &Obj) -> Result<Vec<SessionFacts>, PortError> {
        let mut sessions: Vec<Value> = self
            .directory
            .loaded_ids()
            .iter()
            .filter_map(|id| self.open(id.as_str()))
            .filter(|session| resolve_session_mode(session).1 == agent)
            .collect();
        if let Some(home) = agent_home_session_id(agent)
            && !sessions.iter().any(|s| s["id"] == json!(home))
            && let Some(stored) = self.open(&home)
        {
            sessions.push(stored);
        }
        let mut facts = Vec::with_capacity(sessions.len());
        for session in &sessions {
            facts.push(self.facts(session, config).await?);
        }
        Ok(facts)
    }

    /// `routeControl`: one route method on another session, through the configure lane.
    async fn control(&self, caller: &ThreadId, session: &str, method: &str, input: Option<&Obj>) -> Result<Value, PortError> {
        let id = mixdog_js::js_trim(session);
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return Err(session_error("session: session_id is required for action=route"));
        }
        if id == caller.as_str() {
            return Err(session_error("session: route control must target another session"));
        }
        let op = uuid::Uuid::now_v7().to_string();
        let (target, params) = match method {
            "setRoute" => {
                let mut route = route_fields(input)?;
                route.insert("sessionOnly".into(), json!(true));
                ("route/set", json!({ "opId": op, "threadId": id, "route": route }))
            }
            "continueSessionInModel" => {
                ("thread/continueInModel", json!({ "opId": op, "threadId": id, "route": route_fields(input)? }))
            }
            "scheduleQuotaResume" => ("thread/quotaResume/schedule", json!({ "opId": op, "threadId": id })),
            "cancelQuotaResume" => ("thread/quotaResume/cancel", json!({ "opId": op, "threadId": id })),
            other => return Err(session_error(format!("session: unsupported route method \"{other}\""))),
        };
        self.core.call(target, params).await.map_err(mixdog_core_ports::ports::threads::port_error)
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::session::testing::Rig;

    struct NoBots;
    #[async_trait]
    impl BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }

    #[derive(Default)]
    struct Calls(Mutex<Vec<(String, Value)>>);
    #[async_trait]
    impl CoreCalls for Calls {
        async fn call(&self, method: &'static str, mut params: Value) -> Result<Value, CoreError> {
            params.as_object_mut().unwrap().shift_remove("opId");
            self.0.lock().unwrap().push((method.to_owned(), params));
            Ok(json!(true))
        }
    }

    fn obj(value: Value) -> Obj {
        value.as_object().cloned().unwrap()
    }

    /// `createSessionTargets` / `routeControl` over the sessions held here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sessions_held_here_and_the_configure_lane() {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let header = |value: Value| obj(value);
        directory
            .create_with_id(ThreadId::from("sess_home_scout"), header(json!({ "provider": "openai", "model": "gpt-a" })), json!({}))
            .await
            .expect("home");
        directory
            .create_with_id(ThreadId::from("sess_w1"), header(json!({ "owner": "agent", "agent": " reviewer ", "closed": true })), json!({}))
            .await
            .expect("worker");
        let calls = Arc::new(Calls::default());
        let setup = SessionRouteSetup::new(directory.clone(), Arc::new(NoBots), calls.clone());
        let config = Obj::new();

        let home = setup.session("sess_home_scout", &config).await.unwrap().expect("held");
        assert_eq!((home.acting_agent.as_str(), home.hopped), ("scout", false));
        assert_eq!(Value::Object(home.current), json!({ "provider": "openai", "model": "gpt-a" }));
        assert!(setup.session("sess_w1", &config).await.unwrap().is_none(), "a closed session is not found");
        assert!(setup.session("sess_missing", &config).await.unwrap().is_none());
        let ids: Vec<String> = setup.agent_sessions("scout", &config).await.unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["sess_home_scout"]);
        assert!(setup.caller_chain(&ThreadId::from("sess_home_scout"), &config).await.unwrap().is_none(), "no own agent, no chain");

        let caller = ThreadId::from("sess_lead");
        let route = obj(json!({ "provider": "anthropic", "model": "claude-x", "fast": null, "extra": 1 }));
        assert_eq!(setup.control(&caller, "sess_home_scout", "setRoute", Some(&route)).await.unwrap(), json!(true));
        setup.control(&caller, "sess_home_scout", "continueSessionInModel", Some(&route)).await.unwrap();
        setup.control(&caller, "sess_home_scout", "cancelQuotaResume", None).await.unwrap();
        assert_eq!(
            calls.0.lock().unwrap().clone(),
            [
                ("route/set".to_owned(), json!({ "threadId": "sess_home_scout", "route": { "provider": "anthropic", "model": "claude-x", "sessionOnly": true } })),
                ("thread/continueInModel".to_owned(), json!({ "threadId": "sess_home_scout", "route": { "provider": "anthropic", "model": "claude-x" } })),
                ("thread/quotaResume/cancel".to_owned(), json!({ "threadId": "sess_home_scout" })),
            ]
        );
        let refused = |r: Result<Value, PortError>| match r {
            Err(PortError::Failed { message, .. }) => message,
            other => panic!("{other:?}"),
        };
        assert_eq!(refused(setup.control(&caller, "sess_lead", "setRoute", Some(&route)).await), "session: route control must target another session");
        assert_eq!(refused(setup.control(&caller, "a b", "setRoute", Some(&route)).await), "session: session_id is required for action=route");
        assert_eq!(refused(setup.control(&caller, "s2", "retry", None).await), "session: unsupported route method \"retry\"");
        assert_eq!(
            refused(setup.control(&caller, "s2", "setRoute", Some(&obj(json!({ "provider": "x" })))).await),
            "session: route provider and model are required"
        );
    }
}
