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
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use mixdog_core_ports::ports::domain_sessions::CallerChain;
use mixdog_core_ports::ports::domain_sessions::RouteSetupSessions;
use mixdog_core_ports::ports::domain_sessions::SessionFacts;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_agents::setup::LiveRoute;
use mixdog_core_agents::setup::RoutePositions;
use mixdog_core_run::run_host::hop_host::ConfigSnapshot;
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

/// `liveRouteFallbackPositions(config, row => row.sessionId !== caller.id && row.kind !== 'lead')`
/// for the `agents` status (`routePositionsStatus(...).sessions`): the fallback positions of the
/// bots and agents this process holds that follow a chain or have hopped. The state is the one
/// the run's route hops write, each thread's header (`routeFallback*`); nothing is tracked here.
pub struct SessionRoutePositions {
    directory: Arc<SessionDirectory>,
    bots: Arc<dyn BotRoutes + Send + Sync>,
    config: ConfigSnapshot,
}

impl SessionRoutePositions {
    /// `bots` and `config` are the ones the run's hops read (`HopDeps.bots`, `HopDeps.config`).
    pub fn new(directory: Arc<SessionDirectory>, bots: Arc<dyn BotRoutes + Send + Sync>, config: ConfigSnapshot) -> Self {
        Self { directory, bots, config }
    }

    /// `liveRouteFallbackPositions(config, row => row.sessionId !== caller.id && (row.kind === 'lead') === lead)`.
    async fn held(&self, caller: &ThreadId, lead: bool) -> Result<Vec<Value>, PortError> {
        let config = (self.config)();
        let mut rows = Vec::new();
        for handle in self.directory.loaded_handles() {
            let header = handle.cell.header.load_full();
            let closed = handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst) || header.get("closed") == Some(&Value::Bool(true));
            // Only a session with an agent hops (`advanceAgentRoute`).
            if closed || !truthy(header.get("agent")) {
                continue;
            }
            let mut session = (*header).clone();
            session.insert("id".into(), json!(handle.id.as_str()));
            let session = Value::Object(session);
            let position = route_fallback_position(&session, &config, &*self.bots).await.map_err(unavailable)?;
            let follows_chain = position["fallbacks"].as_array().is_some_and(|chain| !chain.is_empty());
            if !follows_chain && !route_fallback_hopped(&session) {
                continue;
            }
            if handle.id == *caller || (position["kind"] == "lead") != lead {
                continue;
            }
            rows.push(position);
        }
        Ok(rows)
    }

    /// `routePositionsStatus({ caller, config, keep })`: the calling session's own position when it
    /// has an agent (`session`), then the held ones `keep` selects (`sessions`).
    async fn status(&self, caller: &ThreadId, lead: bool) -> Result<Value, PortError> {
        let mut out = Map::new();
        if let Some(handle) = self.directory.handle(caller) {
            let mut session = (*handle.cell.header.load_full()).clone();
            if truthy(session.get("agent")) {
                session.insert("id".into(), json!(caller.as_str()));
                let position = route_fallback_position(&Value::Object(session), &(self.config)(), &*self.bots).await.map_err(unavailable)?;
                out.insert("session".into(), position);
            }
        }
        out.insert("sessions".into(), Value::Array(self.held(caller, lead).await?));
        Ok(Value::Object(out))
    }
}

#[async_trait]
impl RoutePositions for SessionRoutePositions {
    async fn others(&self, caller: &ThreadId) -> Result<Vec<Value>, PortError> {
        self.held(caller, false).await
    }
}

/// The `LiveRoute` the `summary` and `model` status domains read: the Lead preset's fallback
/// chain from the config, and where the held sessions are on their chains
/// ([`SessionRoutePositions`], the state the run's hops write). The route facade's own
/// properties (`rt.provider`, `rt.fastCapable`, `rt.effortOptions`, ...) are read off the
/// thread's live route cell, which `refresh_route_effort` fills from the provider registry's
/// catalog; nothing about effort or Fast is computed here.
pub struct SessionLiveRoute {
    positions: Arc<SessionRoutePositions>,
    cell: Arc<dyn mixdog_core_ports::ports::route::LiveRoute>,
}

impl SessionLiveRoute {
    /// `cell` is the route cell the route writer fills (`SessionRoutes`, `RouteCell`).
    pub fn new(positions: Arc<SessionRoutePositions>, cell: Arc<dyn mixdog_core_ports::ports::route::LiveRoute>) -> Self {
        Self { positions, cell }
    }
}

/// `value || fallback` of a facade getter.
fn or_value(value: Option<&Value>, fallback: Value) -> Value {
    value.filter(|v| truthy(Some(*v))).cloned().unwrap_or(fallback)
}

/// The runtime facade's getters over `state.route` (`runtime-facade.mjs:59-110`), as one object;
/// a getter that answers `undefined` leaves its key out, as the JSON of the facade does.
/// `session_context_percent` is `state.session?.contextPercent`.
fn facade_properties(route: &Obj, session_context_percent: Option<&Value>) -> Value {
    let mut out = Obj::new();
    for key in ["provider", "model"] {
        if let Some(value) = route.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("effort".into(), mixdog_core_ports::ports::route::facade_effort(route).cloned().unwrap_or(Value::Null));
    out.insert("fast".into(), Value::Bool(route.get("fast") == Some(&Value::Bool(true))));
    out.insert("autoEffort".into(), Value::Bool(route.get("autoEffort") != Some(&Value::Bool(false))));
    out.insert("fastCapable".into(), Value::Bool(route.get("fastCapable") == Some(&Value::Bool(true))));
    out.insert("modelParameters".into(), or_value(route.get("modelParameters"), json!({})));
    out.insert("effortOptions".into(), or_value(route.get("effortOptions"), json!([])));
    // `state.route?.contextPercent ?? state.session?.contextPercent ?? null`.
    let percent = [route.get("contextPercent"), session_context_percent].into_iter().flatten().find(|v| !v.is_null());
    out.insert("contextPercent".into(), percent.cloned().unwrap_or(Value::Null));
    out.insert("contextTokens".into(), or_value(route.get("contextTokens"), Value::Null));
    Value::Object(out)
}

#[async_trait]
impl LiveRoute for SessionLiveRoute {
    fn route(&self, thread: &ThreadId) -> Value {
        let route = self.cell.route(thread);
        let header = self.positions.directory.handle(thread).map(|handle| handle.cell.header.load_full());
        facade_properties(&route, header.as_ref().and_then(|header| header.get("contextPercent")))
    }

    /// `listPresets().find(preset => preset?.id === 'workflow-lead')?.fallbacks`; `listPresets` is
    /// the config's `presets` as they are.
    fn lead_fallbacks(&self) -> Value {
        let config = (self.positions.config)();
        let lead = config.get("presets").and_then(Value::as_array).and_then(|presets| presets.iter().find(|preset| preset.get("id") == Some(&json!("workflow-lead"))));
        lead.and_then(|preset| preset.get("fallbacks")).cloned().unwrap_or(Value::Null)
    }

    async fn positions(&self, thread: &ThreadId, lead: bool) -> Result<Value, PortError> {
        self.positions.status(thread, lead).await
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

    /// The thread's live route cell, holding one route for every thread.
    struct FixedRoute(Obj);
    impl mixdog_core_ports::ports::route::LiveRoute for FixedRoute {
        fn route(&self, _: &ThreadId) -> Obj {
            self.0.clone()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Obj) {}
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

    /// The facade's route getters read off the thread's route cell: a requested effort the model does not take is shown as the
    /// one it does (`high`), with the model's own options and the context percent; a route never refreshed shows its effort as
    /// asked and no options. The `model` status is printed from the same properties.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_route_facade_reads_the_route_cell_and_shows_the_effort_the_model_takes() {
        use mixdog_core_agents::setup::ModelStatus;
        use mixdog_core_agents::setup::StatusReader;
        let thread = ThreadId::from("sess_lead");
        let cases = [
            (
                "a route with an effort, not refreshed",
                json!({ "provider": "openai", "model": "gpt-5", "effort": "high" }),
                json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": false, "autoEffort": true, "fastCapable": false, "modelParameters": {},
                    "effortOptions": [], "contextPercent": null, "contextTokens": null }),
                json!([]),
            ),
            (
                "an effort the model does not take",
                json!({ "provider": "openai", "model": "gpt-5", "effort": "ultra", "fast": false, "fastCapable": false, "effectiveEffort": "high",
                    "effortOptions": [{ "value": "low", "label": "Low", "description": "" }, { "value": "high", "label": "High", "description": "current" }],
                    "contextPercent": 30, "contextDefaultPercent": 30, "selectedContextWindow": 272000, "modelDisplay": "GPT 5" }),
                json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": false, "autoEffort": true, "fastCapable": false, "modelParameters": {},
                    "effortOptions": [{ "value": "low", "label": "Low", "description": "" }, { "value": "high", "label": "High", "description": "current" }],
                    "contextPercent": 30, "contextTokens": null }),
                json!([{ "value": "low", "label": "Low", "description": "" }, { "value": "high", "label": "High", "description": "current" }]),
            ),
        ];
        for (name, route, facade, options) in cases {
            let rig = Rig::new();
            let directory = Arc::new(SessionDirectory::new(rig.deps()));
            let positions = Arc::new(SessionRoutePositions::new(directory, Arc::new(NoBots), Arc::new(Obj::new)));
            let live = Arc::new(SessionLiveRoute::new(positions, Arc::new(FixedRoute(obj(route)))));
            assert_eq!(live.route(&thread), facade, "{name}");
            let printed = ModelStatus::new(live).read("model", false, &thread).await.expect("model status");
            assert_eq!(printed["effortOptions"], options, "{name}");
            assert_eq!((&printed["route"]["effort"], &printed["route"]["model"]), (&facade["effort"], &facade["model"]), "{name}");
        }
    }
    /// What the held sessions say of their fallback chains to a caller outside them: a bot at home and an agent worker with a
    /// chain or a hop are listed in the order they were held, with the chain from the settings or from the session, the place
    /// they stand on and the next one; a closed session, one with no agent, a lead that never left its primary and a worker
    /// with no chain and no hop are not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn held_sessions_list_their_fallback_positions_in_the_order_held() {
        let failure = |provider: &str, model: &str, kind: &str, error: &str| json!({ "provider": provider, "model": model, "kind": kind, "error": error });
        let hopped_bot = |id: &str, extra: Value| {
            let mut session = json!({ "id": id, "owner": "user", "provider": "anthropic", "model": "opus", "routeFallbackIndex": 1,
                "routeFallbackPrimary": { "provider": "openai", "model": "gpt", "effort": "high" },
                "routeFallbackFailures": [failure("openai", "gpt", "quota_exhausted", "limit")] });
            session.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            session
        };
        let sessions = [
            hopped_bot("sess_home_helper", json!({ "agent": "helper" })),
            json!({ "id": "sess_worker_chain", "owner": "agent", "agent": "worker", "provider": "openai", "model": "gpt",
                "routeFallbacks": [{ "provider": "anthropic", "model": "opus" }, { "provider": "google", "model": "gemini" }] }),
            json!({ "id": "sess_worker_bare", "owner": "agent", "agent": "worker", "provider": "openai", "model": "gpt", "routeFallbacks": [] }),
            json!({ "id": "sess_worker_hopped", "owner": "agent", "agent": "worker", "provider": "openai", "model": "gpt", "routeFallbacks": [],
                "routeFallbackIndex": 1, "routeFallbackFailures": [failure("openai", "gpt", "rate_limit", "slow")] }),
            hopped_bot("sess_helper_closed", json!({ "agent": "helper", "closed": true })),
            hopped_bot("sess_noagent", json!({})),
            json!({ "id": "sess_lead_fresh", "owner": "user", "agent": "lead", "provider": "openai", "model": "gpt" }),
        ];
        let config = obj(json!({
            "default": "workflow-lead",
            "presets": [{ "id": "workflow-lead", "name": "WORKFLOW LEAD", "provider": "openai", "model": "gpt", "effort": "high",
                "fallbacks": [{ "provider": "anthropic", "model": "opus" }, { "provider": "google", "model": "gemini" }] }],
            "agents": { "helper": { "provider": "openai", "model": "gpt", "fallbacks": [{ "provider": "anthropic", "model": "opus" }, { "provider": "google", "model": "gemini" }] } }
        }));
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        for session in sessions {
            let id = session["id"].as_str().expect("id").to_owned();
            directory.create_with_id(ThreadId::from(id), obj(session), json!({})).await.expect("held");
        }
        let positions = SessionRoutePositions::new(directory, Arc::new(NoBots), Arc::new(move || config.clone()));
        let rows = positions.others(&ThreadId::from("sess_other")).await.expect("positions");
        let want = json!([
            { "sessionId": "sess_home_helper", "kind": "bot", "agent": "helper", "current": { "provider": "anthropic", "model": "opus" },
              "primary": { "provider": "openai", "model": "gpt" }, "onPrimary": false, "fallbackIndex": 1,
              "fallbacks": [{ "provider": "anthropic", "model": "opus" }, { "provider": "google", "model": "gemini" }], "chainFrom": "settings",
              "next": { "provider": "google", "model": "gemini" }, "failures": [failure("openai", "gpt", "quota_exhausted", "limit")] },
            { "sessionId": "sess_worker_chain", "kind": "agent", "agent": "worker", "current": { "provider": "openai", "model": "gpt" },
              "primary": { "provider": "openai", "model": "gpt" }, "onPrimary": true, "fallbackIndex": 0,
              "fallbacks": [{ "provider": "anthropic", "model": "opus" }, { "provider": "google", "model": "gemini" }], "chainFrom": "session",
              "next": { "provider": "anthropic", "model": "opus" }, "failures": [] },
            { "sessionId": "sess_worker_hopped", "kind": "agent", "agent": "worker", "current": { "provider": "openai", "model": "gpt" },
              "primary": { "provider": "openai", "model": "gpt" }, "onPrimary": true, "fallbackIndex": 1, "fallbacks": [], "chainFrom": "session",
              "next": null, "failures": [failure("openai", "gpt", "rate_limit", "slow")] },
        ]);
        assert_eq!(Value::Array(rows), want);
    }
    /// The `model` status over the held sessions, row by row: the Lead preset's chain on the route, the caller's own place (a Lead,
    /// a bot or a worker; none for a caller with no agent, one not held, or none), the other Lead conversations' places, and the
    /// agents' sessions beside it; each in the order the sessions were held (`loaded_handles` sorts by `loaded_seq`, the order
    /// they were loaded). A chain comes from the settings (the Lead preset, an agent's own) or from the session; a Lead preset with
    /// no chain, or none at all, gives the route no fallbacks and its sessions no "other Lead" rows; a bot's chain is its own
    /// configured route's whatever the Lead preset is (`owner_configured_route`, `route_chain.rs:174`), so its place stays "settings".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_model_status_table_lists_the_callers_place_and_the_others_by_the_rules() {
        use mixdog_core_agents::setup::ModelStatus;
        use mixdog_core_agents::setup::StatusReader;
        type Place = (&'static str, &'static str, &'static str, u64);
        struct Row {
            name: &'static str,
            caller: &'static str,
            config: &'static str,
            empty_facts: bool,
            held: &'static [&'static str],
            fallbacks: usize,
            session: Option<(&'static str, &'static str, &'static str, u64, Option<&'static str>)>,
            sessions: &'static [(&'static str, u64)],
            agents: &'static [Place],
        }
        const ALL: &[&str] = &["sess_lead_a", "sess_home_helper", "sess_lead_b", "sess_worker_chain", "sess_lead_closed", "sess_lead_plain", "sess_noagent"];
        const HELPER: Place = ("sess_home_helper", "bot", "settings", 1);
        const WORKER: Place = ("sess_worker_chain", "agent", "session", 0);
        const LEAD_A: (&str, &str, &str, u64, Option<&str>) = ("sess_lead_a", "lead", "settings", 1, Some("google"));
        const LEAD_NO_NEXT: (&str, &str, &str, u64, Option<&str>) = ("sess_lead_a", "lead", "settings", 1, None);
        const LEAD_B: (&str, &str, &str, u64, Option<&str>) = ("sess_lead_b", "lead", "settings", 0, Some("anthropic"));
        macro_rules! row {
            ($name:expr, $caller:expr, $config:expr, $empty_facts:expr, $held:expr, $fallbacks:expr, $session:expr, $sessions:expr, $agents:expr) => {
                Row { name: $name, caller: $caller, config: $config, empty_facts: $empty_facts, held: $held, fallbacks: $fallbacks, session: $session, sessions: $sessions, agents: $agents }
            };
        }
        let rows = [
            row!("a Lead caller with the Lead chain", "sess_lead_a", "chain", false, ALL, 2, Some(LEAD_A), &[("sess_lead_b", 0)], &[HELPER, WORKER]),
            row!("a fresh Lead caller", "sess_lead_b", "chain", false, ALL, 2, Some(LEAD_B), &[("sess_lead_a", 1)], &[HELPER, WORKER]),
            row!("a bot caller", "sess_home_helper", "chain", false, ALL, 2, Some(("sess_home_helper", "bot", "settings", 1, Some("google"))), &[("sess_lead_a", 1), ("sess_lead_b", 0)], &[WORKER]),
            row!("a worker caller", "sess_worker_chain", "chain", false, ALL, 2, Some(("sess_worker_chain", "agent", "session", 0, Some("anthropic"))), &[("sess_lead_a", 1), ("sess_lead_b", 0)], &[HELPER]),
            row!("a caller without an agent", "sess_noagent", "chain", false, ALL, 2, None, &[("sess_lead_a", 1), ("sess_lead_b", 0)], &[HELPER, WORKER]),
            row!("a caller that is not held", "sess_other", "chain", false, ALL, 2, None, &[("sess_lead_a", 1), ("sess_lead_b", 0)], &[HELPER, WORKER]),
            row!("no caller", "", "chain", false, ALL, 2, None, &[("sess_lead_a", 1), ("sess_lead_b", 0)], &[HELPER, WORKER]),
            row!("nothing held", "sess_lead_a", "chain", false, &[], 2, None, &[], &[]),
            row!("a Lead preset without a chain", "sess_lead_a", "bare", false, ALL, 0, Some(LEAD_NO_NEXT), &[], &[HELPER, WORKER]),
            row!("a Lead preset with an empty chain", "sess_lead_a", "empty", false, ALL, 0, Some(LEAD_NO_NEXT), &[], &[HELPER, WORKER]),
            row!("no Lead preset", "sess_lead_a", "none", false, ALL, 0, Some(LEAD_NO_NEXT), &[], &[HELPER, WORKER]),
            row!("a facade with nothing set", "sess_lead_a", "chain", true, ALL, 2, Some(LEAD_A), &[("sess_lead_b", 0)], &[HELPER, WORKER]),
            row!(
                "held in another order",
                "sess_lead_b",
                "chain",
                false,
                &["sess_noagent", "sess_lead_plain", "sess_lead_closed", "sess_worker_chain", "sess_lead_b", "sess_home_helper", "sess_lead_a"],
                2,
                Some(LEAD_B),
                &[("sess_lead_a", 1)],
                &[WORKER, HELPER]
            ),
        ];
        let chain = json!([{ "provider": "anthropic", "model": "opus" }, { "provider": "google", "model": "gemini" }]);
        let hopped = |id: &str, agent: Option<&str>, owner: &str, extra: Value| {
            let mut header = json!({ "id": id, "owner": owner, "provider": "anthropic", "model": "opus", "routeFallbackIndex": 1,
                "routeFallbackPrimary": { "provider": "openai", "model": "gpt", "effort": "high" },
                "routeFallbackFailures": [{ "provider": "openai", "model": "gpt", "kind": "quota_exhausted", "error": "limit" }] });
            if let Some(agent) = agent {
                header["agent"] = json!(agent);
            }
            header.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            header
        };
        let sessions = [
            hopped("sess_lead_a", Some("lead"), "user", json!({})),
            hopped("sess_home_helper", Some("helper"), "user", json!({})),
            json!({ "id": "sess_lead_b", "owner": "user", "agent": "lead", "provider": "openai", "model": "gpt" }),
            json!({ "id": "sess_worker_chain", "owner": "agent", "agent": "worker", "provider": "openai", "model": "gpt", "routeFallbacks": chain }),
            hopped("sess_lead_closed", Some("lead"), "user", json!({ "closed": true })),
            json!({ "id": "sess_lead_plain", "owner": "user", "agent": "lead", "provider": "openai", "model": "other" }),
            json!({ "id": "sess_noagent", "owner": "user", "provider": "openai", "model": "gpt" }),
        ];
        let preset = |extra: Value| {
            let mut preset = json!({ "id": "workflow-lead", "name": "WORKFLOW LEAD", "provider": "openai", "model": "gpt", "effort": "high" });
            preset.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            preset
        };
        let configs = |kind: &str| match kind {
            "chain" => json!({ "default": "workflow-lead", "presets": [preset(json!({ "fallbacks": chain }))], "agents": { "helper": { "provider": "openai", "model": "gpt", "fallbacks": chain } } }),
            "bare" => json!({ "default": "workflow-lead", "presets": [preset(json!({}))], "agents": { "helper": { "provider": "openai", "model": "gpt", "fallbacks": chain } } }),
            "empty" => json!({ "default": "workflow-lead", "presets": [preset(json!({ "fallbacks": [] }))], "agents": { "helper": { "provider": "openai", "model": "gpt", "fallbacks": chain } } }),
            _ => json!({ "default": "main", "presets": [{ "id": "main", "name": "Main", "provider": "openai", "model": "gpt" }], "agents": { "helper": { "provider": "openai", "model": "gpt", "fallbacks": chain } } }),
        };
        let facts = json!({ "provider": "openai", "model": "gpt", "effort": "high", "fast": true, "fastCapable": true, "autoEffort": false, "modelParameters": { "tier": "x" },
            "contextPercent": 34, "contextTokens": 1200, "effortOptions": ["low", "high"] });
        for row in rows {
            let rig = Rig::new();
            let directory = Arc::new(SessionDirectory::new(rig.deps()));
            for id in row.held {
                let header = sessions.iter().find(|session| session["id"] == *id).expect("a known session").clone();
                directory.create_with_id(ThreadId::from(*id), obj(header), json!({})).await.expect("held");
            }
            let config = obj(configs(row.config));
            let positions = Arc::new(SessionRoutePositions::new(directory, Arc::new(NoBots), Arc::new(move || config.clone())));
            let live = Arc::new(SessionLiveRoute::new(positions, Arc::new(FixedRoute(obj(if row.empty_facts { json!({}) } else { facts.clone() })))));
            let caller = ThreadId::from(row.caller);
            let printed = ModelStatus::new(live.clone()).read("model", false, &caller).await.expect("model status");
            let name = row.name;
            let fallbacks = printed["route"]["fallbacks"].as_array().map_or(0, Vec::len);
            assert_eq!(fallbacks, row.fallbacks, "{name}: the route's chain");
            assert_eq!(printed["route"]["provider"], if row.empty_facts { "" } else { "openai" }, "{name}: the route is the facade's");
            assert_eq!(printed["effortOptions"], if row.empty_facts { json!([]) } else { json!(["low", "high"]) }, "{name}");
            let place = |entry: &Value| {
                (
                    entry["sessionId"].as_str().unwrap().to_owned(),
                    entry["kind"].as_str().unwrap().to_owned(),
                    entry["chainFrom"].as_str().unwrap().to_owned(),
                    entry["fallbackIndex"].as_u64().unwrap(),
                    entry["next"]["provider"].as_str().map(str::to_owned),
                )
            };
            let want = row.session.map(|(id, kind, from, at, next)| (id.to_owned(), kind.to_owned(), from.to_owned(), at, next.map(str::to_owned)));
            assert_eq!((!printed["session"].is_null()).then(|| place(&printed["session"])), want, "{name}: the caller's own place");
            let others: Vec<(String, u64)> = printed["sessions"].as_array().expect("sessions").iter().map(|entry| (place(entry).0, place(entry).3)).collect();
            assert_eq!(others, row.sessions.iter().map(|(id, at)| ((*id).to_owned(), *at)).collect::<Vec<_>>(), "{name}: the other Lead conversations");
            let agents = live.positions(&caller, false).await.expect("agents positions");
            let listed: Vec<(String, String, String, u64)> = agents["sessions"].as_array().expect("agent sessions").iter().map(|entry| {
                let (id, kind, from, at, _) = place(entry);
                (id, kind, from, at)
            }).collect();
            assert_eq!(listed, row.agents.iter().map(|(id, kind, from, at)| ((*id).to_owned(), (*kind).to_owned(), (*from).to_owned(), *at)).collect::<Vec<_>>(), "{name}: the agents' sessions");
        }
    }


}
