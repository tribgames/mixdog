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
    let preset_effort = route.get("preset").and_then(|preset| preset.get("effort"));
    let effort = [route.get("effectiveEffort"), route.get("effort"), preset_effort].into_iter().find(|v| truthy(*v)).flatten();
    out.insert("effort".into(), effort.cloned().unwrap_or(Value::Null));
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

    /// `routePositionsStatus({ caller, config, keep: kind !== 'lead' }).sessions` over the held
    /// sessions (`fixtures/route-positions`, Node's real `liveRouteFallbackPositions`): the
    /// rows, whole and in the order the sessions were held.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn held_sessions_answer_nodes_fallback_positions() {
        const GOLDEN: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/route-positions/golden.json"));
        let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
        let mut rows_checked = 0;
        for case in golden["cases"].as_array().expect("cases") {
            let rig = Rig::new();
            let directory = Arc::new(SessionDirectory::new(rig.deps()));
            for session in case["sessions"].as_array().expect("sessions") {
                let id = session["id"].as_str().expect("id");
                directory.create_with_id(ThreadId::from(id), obj(session.clone()), json!({})).await.expect("held");
            }
            let config = obj(case["config"].clone());
            let positions = SessionRoutePositions::new(directory, Arc::new(NoBots), Arc::new(move || config.clone()));
            let caller = ThreadId::from(case["caller"].as_str().unwrap_or_default());
            let rows = positions.others(&caller).await.expect("positions");
            assert_eq!(Value::Array(rows), case["rows"], "{}", case["name"]);
            rows_checked += case["rows"].as_array().expect("rows").len();
        }
        assert!(rows_checked >= 10, "the golden holds rows");
    }

    /// The facade's route getters (`fixtures/live-route-facade`, Node's real `createRuntimeFacade`
    /// over a route its real `refreshRouteEffort` filled) read off the thread's route cell: the
    /// properties whole, and the `model` status printed from them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_route_facade_properties_are_read_off_the_route_cell() {
        use mixdog_core_agents::setup::ModelStatus;
        use mixdog_core_agents::setup::StatusReader;
        const GOLDEN: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/live-route-facade/golden.json"));
        let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
        let thread = ThreadId::from("sess_lead");
        for case in golden["cases"].as_array().expect("cases") {
            let name = &case["name"];
            let rig = Rig::new();
            let directory = Arc::new(SessionDirectory::new(rig.deps()));
            if let Some(percent) = case["session"].get("contextPercent") {
                directory.create_with_id(thread.clone(), obj(json!({ "contextPercent": percent })), json!({})).await.expect("held");
            }
            let positions = Arc::new(SessionRoutePositions::new(directory, Arc::new(NoBots), Arc::new(Obj::new)));
            let live = Arc::new(SessionLiveRoute::new(positions, Arc::new(FixedRoute(obj(case["route"].clone())))));
            assert_eq!(live.route(&thread), case["facade"], "{name}");
            let printed = ModelStatus::new(live).read("model", false, &thread).await.expect("model status");
            assert_eq!((&printed["route"], &printed["effortOptions"]), (&case["model"]["route"], &case["model"]["effortOptions"]), "{name}");
        }
    }

    /// The `model` status domain over `SessionLiveRoute` (`fixtures/live-route`, Node's real setup
    /// executor over held sessions): the Lead preset's chain, the caller's own place, and the other
    /// Lead conversations' places, printed whole and in key order; and the `agents` domain's
    /// `sessions` beside it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_model_status_prints_what_nodes_setup_executor_did() {
        use mixdog_core_agents::setup::ModelStatus;
        use mixdog_core_agents::setup::StatusReader;
        const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/live-route/golden.json");
        let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
        for case in golden["cases"].as_array().expect("cases") {
            let name = &case["name"];
            let rig = Rig::new();
            let directory = Arc::new(SessionDirectory::new(rig.deps()));
            for session in case["sessions"].as_array().expect("sessions") {
                let id = session["id"].as_str().expect("id");
                directory.create_with_id(ThreadId::from(id), obj(session.clone()), json!({})).await.expect("held");
            }
            let config = obj(case["config"].clone());
            let positions = Arc::new(SessionRoutePositions::new(directory, Arc::new(NoBots), Arc::new(move || config.clone())));
            let facts = case["facts"].clone();
            let live = Arc::new(SessionLiveRoute::new(positions, Arc::new(FixedRoute(obj(facts)))));
            let caller = ThreadId::from(case["caller"].as_str().unwrap_or_default());
            let printed = ModelStatus::new(live.clone()).read("model", false, &caller).await.expect("model status");
            assert_eq!(serde_json::to_string(&printed).unwrap(), serde_json::to_string(&case["model"]).unwrap(), "{name}");
            let others = live.positions(&caller, false).await.expect("agents positions");
            assert_eq!(others["sessions"], case["agentsSessions"], "{name}");
        }
    }
}
