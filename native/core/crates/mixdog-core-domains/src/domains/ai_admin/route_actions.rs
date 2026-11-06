//! The setup route actions (`executor.mjs` `set_route`, `set_agent_route`, and
//! `setup-tool/session-route-actions.mjs`): the Lead and agent route edits with their chain
//! receipt, a session's return to its primary route, and the quota-card actions on another
//! session. The routes are [`RouteService`] and [`AgentRouteSetter`]; the live sessions, their
//! fallback position and the daemon's configure lane are [`RouteSetupSessions`] (WP-SESSION).

use mixdog_core_ports::ports::domain_sessions::{RouteSetupSessions, SessionFacts};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, clean, truthy};
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::agent_route_service::AgentRouteSetter;
use super::route_service::{RouteService, SetRouteOptions};
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_core_ports::ports::setup_actions::SetupCallers;

/// The two route writes of the runtime facade (`rt.setRoute`, `rt.setAgentRoute`) and the
/// config they read.
#[async_trait]
pub trait RouteWrites: Send + Sync {
    async fn set_route(&self, thread: &ThreadId, route: &Obj, options: &SetRouteOptions) -> Result<Value, String>;
    async fn set_agent_route(&self, agent: &str, route: &Obj) -> Result<Value, String>;
    fn config(&self) -> Obj;
}

/// The writes over the route services.
pub struct ServiceWrites {
    pub routes: Arc<RouteService>,
    pub agents: Arc<AgentRouteSetter>,
}

#[async_trait]
impl RouteWrites for ServiceWrites {
    async fn set_route(&self, thread: &ThreadId, route: &Obj, options: &SetRouteOptions) -> Result<Value, String> {
        self.routes.set_route(thread, route, options).await
    }

    async fn set_agent_route(&self, agent: &str, route: &Obj) -> Result<Value, String> {
        self.agents.set_agent_route(agent, route).await
    }

    fn config(&self) -> Obj {
        self.routes.config.agent()
    }
}

pub struct RouteActions {
    pub writes: Arc<dyn RouteWrites>,
    pub sessions: Arc<dyn RouteSetupSessions>,
    pub callers: Arc<dyn SetupCallers>,
    /// The `setup` tool's input schema: the executor validates every call against it first
    /// (`validateSetupInput`), the route's own shape included.
    pub schema: Value,
}

const ACTIONS: [&str; 6] = [
    "set_route",
    "set_agent_route",
    "reset_route_fallback",
    "continue_in_model",
    "schedule_quota_resume",
    "cancel_quota_resume",
];

const LEAF_FIELDS: [&str; 6] = ["effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"];

fn fail(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "route".into(), message: message.into() }
}

fn require_text(args: &Value, field: &str) -> Result<String, PortError> {
    let text = clean(args.get(field));
    if text.is_empty() { Err(fail(format!("{field} is required"))) } else { Ok(text) }
}

/// `routeInput` of the executor: the fields a route edit may carry.
fn route_input(source: &Value) -> Obj {
    let mut next = Obj::new();
    let has = |key: &str| source.get(key).is_some();
    if !clean(source.get("provider")).is_empty() || has("provider") {
        next.insert("provider".into(), json!(clean(source.get("provider"))));
    }
    for key in ["model", "effort"] {
        let text = clean(source.get(key));
        if !text.is_empty() {
            next.insert(key.into(), json!(text));
        }
    }
    for key in ["fast", "autoEffort"] {
        if let Some(Value::Bool(b)) = source.get(key) {
            next.insert(key.into(), json!(b));
        }
    }
    if has("modelParameters") {
        next.insert("modelParameters".into(), source["modelParameters"].clone());
    }
    for key in ["contextPercent", "contextTokens", "disabled"] {
        if has(key) {
            next.insert(key.into(), source[key].clone());
        }
    }
    if let Some(list) = source.get("fallbacks").and_then(Value::as_array) {
        next.insert("fallbacks".into(), Value::Array(list.iter().map(|entry| Value::Object(route_input(entry))).collect()));
    }
    next
}

/// `routeLeaf`: the switchable fields of a route.
fn route_leaf(route: &Value) -> Obj {
    let text = |key: &str| if truthy(route.get(key)) { route[key].clone() } else { json!("") };
    let mut leaf = Obj::new();
    leaf.insert("provider".into(), text("provider"));
    leaf.insert("model".into(), text("model"));
    for key in LEAF_FIELDS {
        match route.get(key) {
            None | Some(Value::Null) => {}
            Some(value) => {
                leaf.insert(key.into(), value.clone());
            }
        }
    }
    leaf
}

fn model_of(route: &Obj) -> Value {
    let text = |key: &str| if truthy(route.get(key)) { route[key].clone() } else { json!("") };
    json!({ "provider": text("provider"), "model": text("model") })
}

/// JS template interpolation of a route entry's provider or model.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn pair(entry: &Value) -> String {
    format!("{}/{}", js_text(entry.get("provider")), js_text(entry.get("model")))
}

impl RouteActions {
    /// `chainReceipt`: whether the calling conversation now follows the saved chain.
    async fn receipt(&self, thread: &ThreadId, route: &Value, owner_kind: &str, owner_agent: Option<&str>) -> Obj {
        let mut out = Obj::new();
        let Some(saved) = route.get("fallbacks").and_then(Value::as_array) else { return out };
        let config = self.writes.config();
        let Some(chain) = self.sessions.caller_chain(thread, &config).await else { return out };
        let position = &chain.position;
        let kind_matches = position["kind"] == json!(owner_kind)
            && (owner_kind != "bot" || position.get("agent").and_then(Value::as_str) == owner_agent);
        let follows = position["chainFrom"] == json!("settings") && chain.source_is_primary && kind_matches;
        let followed: Vec<String> = position["fallbacks"].as_array().map(|l| l.iter().map(pair).collect()).unwrap_or_default();
        let saved: Vec<String> = saved.iter().map(pair).collect();
        out.insert("appliedToCurrentSession".into(), json!(follows && saved == followed));
        out.insert("currentSession".into(), position.clone());
        out
    }

    async fn assert_agent(&self, thread: &ThreadId, agent: &str, action: &str) -> Result<(), PortError> {
        match self.callers.scope(thread).await {
            CallerScope::Agent { agent_id, .. } if agent.trim() != agent_id => {
                Err(PortError::Denied(format!("This thread manages only its own agent's settings (setup {action})")))
            }
            _ => Ok(()),
        }
    }

    /// `createSessionTargets().target`: an open session this thread may act on.
    async fn target(&self, thread: &ThreadId, args: &Value, action: &str, other: bool) -> Result<SessionFacts, PortError> {
        let caller = thread.as_str();
        let given = clean(args.get("sessionId"));
        let id = if given.is_empty() { caller.to_owned() } else { given };
        if id.is_empty() {
            return Err(fail("sessionId is required"));
        }
        if other && id == caller {
            return Err(fail(format!("{action} applies to another session: this one is running the setup call")));
        }
        let config = self.writes.config();
        let session = self.sessions.session(&id, &config).await.ok_or_else(|| fail(format!("session {id} not found")))?;
        self.assert_agent(thread, &session.acting_agent, action).await?;
        Ok(session)
    }

    async fn reset_route_fallback(&self, thread: &ThreadId, args: &Value) -> Result<Value, PortError> {
        if args.get("sessionId").is_some() && args.get("agent").is_some() {
            return Err(fail("Pass sessionId or agent, not both"));
        }
        let config = self.writes.config();
        let targets = if args.get("agent").is_some() {
            let agent = clean(args.get("agent"));
            if agent.is_empty() {
                return Err(fail("agent is required"));
            }
            self.assert_agent(thread, &agent, "reset_route_fallback").await?;
            self.sessions.agent_sessions(&agent, &config).await
        } else {
            vec![self.target(thread, args, "reset_route_fallback", false).await?]
        };
        let (mut reset, mut unchanged) = (Vec::new(), Vec::new());
        for session in targets {
            if !session.hopped {
                unchanged.push(json!({ "sessionId": session.id, "current": Value::Object(session.current.clone()) }));
                continue;
            }
            let route = route_leaf(&Value::Object(session.primary.clone()));
            // The session's own model pick, from its next turn: the switch restarts its chain.
            if session.id == thread.as_str() {
                let options = SetRouteOptions {
                    session_only: true,
                    follow: FollowOptions { switch_established: true, defer_until_next_turn: true, ..FollowOptions::default() },
                    ..SetRouteOptions::default()
                };
                self.writes.set_route(thread, &route, &options).await.map_err(fail)?;
            } else {
                self.sessions.control(thread, &session.id, "setRoute", Some(&route)).await?;
            }
            reset.push(json!({ "sessionId": session.id, "from": model_of(&session.current), "to": model_of(&route) }));
        }
        let mut out = json!({ "scope": "session", "reset": reset });
        if !unchanged.is_empty() {
            out["alreadyOnPrimary"] = Value::Array(unchanged);
        }
        Ok(out)
    }

    async fn continue_in_model(&self, thread: &ThreadId, args: &Value) -> Result<Value, PortError> {
        let session = self.target(thread, args, "continue_in_model", true).await?;
        let route = route_leaf(args.get("route").unwrap_or(&Value::Null));
        let answer = self.sessions.control(thread, &session.id, "continueSessionInModel", Some(&route)).await?;
        Ok(json!({
            "scope": "session",
            "sessionId": session.id,
            "continued": answer != json!(false),
            "route": model_of(&route),
            "note": "The stopped turn is not resent: the user resumes it from that conversation (Resume, or a new message).",
        }))
    }

    async fn quota_resume(&self, thread: &ThreadId, args: &Value, action: &str, method: &str, key: &str) -> Result<Value, PortError> {
        let session = self.target(thread, args, action, true).await?;
        let answer = self.sessions.control(thread, &session.id, method, None).await?;
        Ok(json!({ "scope": "session", "sessionId": session.id, key: answer == json!(true) }))
    }
}

#[async_trait]
impl SetupActions for RouteActions {
    fn actions(&self) -> &'static [&'static str] {
        &ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let (thread, args) = (call.thread, call.args);
        // The executor validates every call first; a route that is not the shape it copies
        // (a chain that is no list, an entry that is no object) is refused with its text.
        mixdog_tools::orch::setup_input::validate(args, &self.schema).map_err(|error| PortError::Invalid {
            field: "setup".into(),
            reason: match error.code {
                ToolErrorCode::InvalidArgs { reason, .. } => reason,
                _ => error.message_for_model,
            },
        })?;
        match call.action {
            "set_route" => {
                let source = args.get("route").unwrap_or(&Value::Null);
                let options = SetRouteOptions { keep_main_model: Some(false), ..SetRouteOptions::default() };
                let next = self.writes.set_route(thread, &route_input(source), &options).await.map_err(fail)?;
                let mut out = Obj::new();
                out.insert("route".into(), next);
                out.extend(self.receipt(thread, source, "lead", None).await);
                Ok(Value::Object(out))
            }
            "set_agent_route" => {
                self.assert_agent(thread, clean(args.get("agent")).as_str(), "set_agent_route").await?;
                let agent = require_text(args, "agent")?;
                let source = args.get("route").unwrap_or(&Value::Null);
                let route = self.writes.set_agent_route(&agent, &route_input(source)).await.map_err(fail)?;
                let mut out = Obj::new();
                out.insert("agent".into(), json!(agent));
                out.insert("route".into(), route);
                out.extend(self.receipt(thread, source, "bot", Some(&agent)).await);
                Ok(Value::Object(out))
            }
            "reset_route_fallback" => self.reset_route_fallback(thread, args).await,
            "continue_in_model" => self.continue_in_model(thread, args).await,
            "schedule_quota_resume" => self.quota_resume(thread, args, "schedule_quota_resume", "scheduleQuotaResume", "scheduled").await,
            "cancel_quota_resume" => self.quota_resume(thread, args, "cancel_quota_resume", "cancelQuotaResume", "cancelled").await,
            other => Err(PortError::Unavailable { capability: format!("setup.{other}"), message: format!("setup {other} is not a route action") }),
        }
    }
}
