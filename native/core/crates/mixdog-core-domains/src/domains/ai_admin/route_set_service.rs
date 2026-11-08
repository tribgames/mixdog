//! `route/set` and `fast/set`: the model route and Fast mode of a thread, an agent or the default.
//!
//! The desktop's `setModelRoute` / `setRoute` (`tui/session/session-api/routes-write.mjs`
//! `createRouteWrite.setRoute`), `setAgentRoute` and `setFast` (`settings.mjs`) in one method each.
//! The adoption is [`RouteService`] and [`AgentRouteSetter`]; this is the wire half: which of the
//! request's keys are options of the write (`applyToCurrentSession`, `keepMainModel`,
//! `sessionOnly`, `onlyIfEmpty`) and which are the selection, and the completion of a
//! session-only request against the selected route.
//!
//! A request that names neither a thread nor an agent writes the runtime's route before any
//! session exists (Node's `rt.route` with no `getSession()`): its route lives in the
//! [`PRE_SESSION`] cell and no session follows it.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_app_protocol::v2::params::{FastSetParams, RouteSetParams};
use mixdog_core_api::call::{CoreRequest, Reply};
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::{ConnectionId, Method, ThreadId};
use mixdog_core_api::service::{Admit, DomainService};
use mixdog_core_base::support::{OpScopes, decode, failed, invalid, wrong_method};
use mixdog_core_ports::ports::route::{FollowOptions, Followed};
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use super::agent_route_service::AgentRouteSetter;
use super::route_service::{FastValue, RouteService, SessionFollow, SetRouteOptions};

pub const ROUTE_SET: &str = "route/set";
pub const FAST_SET: &str = "fast/set";

const DOMAIN: &str = "route";

/// The route cell of the runtime before any session (a request naming no thread).
pub const PRE_SESSION: &str = "";

/// The keys of a `route/set` selection that are options of the write, not part of the route.
const OPTION_KEYS: [&str; 4] = ["applyToCurrentSession", "keepMainModel", "sessionOnly", "onlyIfEmpty"];

/// The keys a session-only request may carry (`SESSION_ONLY_KEYS`).
const SESSION_ONLY_KEYS: [&str; 5] = ["provider", "model", "effort", "fast", "autoEffort"];

/// [`SessionFollow`] that leaves the [`PRE_SESSION`] cell alone: with no session there is
/// nothing to follow, tune or switch.
pub struct PreSessionAware {
    pub inner: Arc<dyn SessionFollow>,
}

fn pre_session(thread: &ThreadId) -> bool {
    thread.as_str() == PRE_SESSION
}

#[async_trait]
impl SessionFollow for PreSessionAware {
    fn open_lease(&self, thread: &ThreadId, origin: Option<u64>) -> u64 {
        if pre_session(thread) { origin.unwrap_or(0) } else { self.inner.open_lease(thread, origin) }
    }

    async fn follow(&self, thread: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError> {
        if pre_session(thread) { Ok(Followed::default()) } else { self.inner.follow(thread, options).await }
    }

    async fn tune(&self, thread: &ThreadId) -> Result<(), PortError> {
        if pre_session(thread) { Ok(()) } else { self.inner.tune(thread).await }
    }

    async fn switch_now(&self, thread: &ThreadId) -> Result<Option<Value>, PortError> {
        if pre_session(thread) { Ok(None) } else { self.inner.switch_now(thread).await }
    }
}

pub struct RouteSetService {
    pub routes: Arc<RouteService>,
    pub agents: Arc<AgentRouteSetter>,
    pub ops: OpScopes,
}

/// JavaScript truthiness of the values a route holds.
fn truthy_of(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn clean(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// `completeSessionOnlyRequest(request, selected)`: the request completed against the selected
/// route, `None` when it asks for nothing the route does not already have and the session
/// already runs that model (`unchanged`).
fn complete_session_only(request: &Obj, selected: &Obj) -> Option<Obj> {
    let named = truthy_of(request.get("provider")) || truthy_of(request.get("model"));
    let mut target = request.clone();
    if !named {
        target.insert("provider".into(), selected.get("provider").cloned().unwrap_or(Value::Null));
        target.insert("model".into(), selected.get("model").cloned().unwrap_or(Value::Null));
    }
    let same_model = target.get("provider") == selected.get("provider") && target.get("model") == selected.get("model");
    if !same_model {
        return Some(target);
    }
    let session_on_target = !truthy_of(selected.get("sessionModel"))
        || (selected.get("sessionProvider") == target.get("provider") && selected.get("sessionModel") == target.get("model"));
    let selected_fast = selected.get("fast") == Some(&Value::Bool(true));
    let selected_auto = selected.get("autoEffort") != Some(&Value::Bool(false));
    let unchanged = session_on_target
        && request.keys().all(|key| SESSION_ONLY_KEYS.contains(&key.as_str()))
        && request.get("effort").is_none_or(|e| Some(e) == selected.get("effort"))
        && request.get("fast").is_none_or(|f| f == &Value::Bool(selected_fast))
        && request.get("autoEffort").is_none_or(|a| a == &Value::Bool(selected_auto));
    if unchanged {
        return None;
    }
    let mut completed = Obj::new();
    if truthy_of(selected.get("effort")) {
        completed.insert("effort".into(), selected["effort"].clone());
    }
    completed.insert("fast".into(), Value::Bool(selected_fast));
    completed.insert("autoEffort".into(), Value::Bool(selected_auto));
    completed.extend(target);
    Some(completed)
}

/// What a `route/set` selection asks of the route service.
#[derive(Debug)]
pub(super) enum Plan {
    /// A session-only request for what the route already is.
    Unchanged,
    /// The selection without the write's options, and those options.
    Write(Obj, SetRouteOptions),
}

/// `setRoute(opts)` of `createRouteWrite`: the options the selection carries, the selection
/// itself, and a session-only request completed against the `selected` (live) route.
pub(super) fn plan(selection: &Obj, selected: &Obj) -> Plan {
    let flag = |key: &str| selection.get(key) == Some(&Value::Bool(true));
    let session_only = flag("sessionOnly");
    let mut requested = selection.clone();
    for key in OPTION_KEYS {
        requested.shift_remove(key);
    }
    if session_only {
        match complete_session_only(&requested, selected) {
            Some(completed) => requested = completed,
            None => return Plan::Unchanged,
        }
    }
    let options = SetRouteOptions {
        keep_main_model: Some(selection.get("keepMainModel") != Some(&Value::Bool(false))),
        only_if_empty: flag("onlyIfEmpty"),
        session_only,
        validate_only: false,
        follow: FollowOptions { apply_to_current_session: flag("applyToCurrentSession"), switch_established: true, defer_until_next_turn: true, lease: None },
    };
    Plan::Write(requested, options)
}

impl RouteSetService {
    fn live(&self, thread: &ThreadId) -> Obj {
        self.routes.writer.route(thread)
    }

    async fn route_set(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: RouteSetParams = decode(req)?;
        let selection = params.route.as_object().ok_or_else(|| invalid("route", "an object"))?;
        // An agent's route is the agent's, whatever thread the call is addressed to: Node's `setAgentRoute(agentId, route)` never reads
        // the session it is called on, and the desktop addresses every call it makes with no session to its control thread.
        if let Some(agent) = params.agent_id.as_deref() {
            return self.agents.set_agent_route(agent, selection).await.map_err(|m| failed(DOMAIN, m));
        }
        let thread = params.thread_id.unwrap_or_else(|| ThreadId::from(PRE_SESSION));
        match plan(selection, &self.live(&thread)) {
            Plan::Unchanged => Ok(Value::Object(self.live(&thread))),
            Plan::Write(requested, options) => self.routes.set_route(&thread, &requested, &options).await.map_err(|m| failed(DOMAIN, m)),
        }
    }

    async fn fast_set(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: FastSetParams = decode(req)?;
        let thread = params.thread_id.unwrap_or_else(|| ThreadId::from(PRE_SESSION));
        let value = if params.on { FastValue::On } else { FastValue::Off };
        self.routes.set_fast(&thread, value).await.map(Value::Bool).map_err(|m| failed(DOMAIN, m))
    }

    fn thread_of(req: &CoreRequest) -> ThreadId {
        ThreadId::from(clean(req.params.get("threadId")))
    }
}

#[async_trait]
impl DomainService for RouteSetService {
    fn methods(&self) -> &'static [&'static str] {
        &[ROUTE_SET, FAST_SET]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let thread = Self::thread_of(&req);
        match req.method.as_str() {
            ROUTE_SET => self.ops.run(&req, None, || self.route_set(&req), || async { Ok(Value::Object(self.live(&thread))) }).await,
            FAST_SET => {
                self.ops
                    .run(&req, None, || self.fast_set(&req), || async { Ok(Value::Bool(self.live(&thread).get("fast") == Some(&Value::Bool(true)))) })
                    .await
            }
            other => Err(wrong_method("route", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
