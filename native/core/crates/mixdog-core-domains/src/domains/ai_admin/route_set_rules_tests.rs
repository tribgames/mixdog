//! `route/set` and `fast/set` over inline routes: what a selection asks of the runtime (the write's options, a session-only
//! request completed against the live route) and the paths through the real service that answer without a write or refuse.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::ModelsDevSource;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::window_meta_of;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_config::config::hidden_agents::hidden_agents;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Followed;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteWriter;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;

use super::agent_route_service::AgentRouteSetter;
use super::chain::RouteContext;
use super::chain::RouteFacts;
use super::model_list::ModelListService;
use super::route_service::LiveControls;
use super::route_service::RouteService;
use super::route_service::SessionFollow;
use super::route_set_service::FAST_SET;
use super::route_set_service::Plan;
use super::route_set_service::ROUTE_SET;
use super::route_set_service::RouteSetService;
use super::route_set_service::plan;

fn obj(value: Value) -> Obj {
    value.as_object().cloned().expect("an object")
}

fn written(selection: Value, selected: Value) -> (Obj, super::route_service::SetRouteOptions) {
    match plan(&obj(selection), &obj(selected)) {
        Plan::Write(requested, options) => (requested, options),
        Plan::Unchanged => panic!("a write"),
    }
}

#[test]
fn the_options_of_a_selection_are_taken_out_of_the_route_it_names() {
    let (requested, options) = written(
        json!({ "provider": "openai", "model": "gpt-5", "applyToCurrentSession": true, "keepMainModel": false, "onlyIfEmpty": true, "validateOnly": true }),
        json!({}),
    );
    assert_eq!(Value::Object(requested), json!({ "provider": "openai", "model": "gpt-5" }));
    assert_eq!(
        (options.follow.apply_to_current_session, options.keep_main_model, options.only_if_empty, options.validate_only, options.session_only),
        (true, Some(false), true, true, false)
    );
    assert!(options.follow.switch_established && options.follow.defer_until_next_turn, "a selection takes effect at the next turn");
    assert!(!options.follow.compact_before_switch, "a default write cannot compact a conversation");
}

#[test]
fn only_an_explicit_false_keeps_the_main_model_from_being_kept() {
    for (keep, want) in [(json!(false), Some(false)), (json!(true), Some(true)), (json!("no"), Some(true)), (Value::Null, Some(true))] {
        let (_, options) = written(json!({ "provider": "openai", "model": "m", "keepMainModel": keep }), json!({}));
        assert_eq!(options.keep_main_model, want, "{keep}");
    }
    let (_, options) = written(json!({ "provider": "openai", "model": "m" }), json!({}));
    assert_eq!((options.keep_main_model, options.follow.apply_to_current_session, options.only_if_empty), (Some(true), false, false));
}

fn live() -> Value {
    json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": false, "effortAuto": true })
}

#[test]
fn a_session_only_request_for_what_the_route_already_is_changes_nothing() {
    for selection in [
        json!({ "sessionOnly": true }),
        json!({ "sessionOnly": true, "effort": "high", "effortAuto": true }),
        json!({ "sessionOnly": true, "provider": "openai", "model": "gpt-5", "fast": false, "effortAuto": true }),
    ] {
        assert!(matches!(plan(&obj(selection.clone()), &obj(live())), Plan::Unchanged), "{selection}");
    }
    let (requested, _) = written(json!({ "sessionOnly": true, "effort": "high" }), live());
    assert_eq!(requested["effortAuto"], false, "an explicit concrete effort turns Auto off even when it matches the saved fallback level");
}

#[test]
fn a_session_only_request_for_the_same_model_is_completed_with_the_routes_other_settings() {
    let (requested, options) = written(json!({ "sessionOnly": true, "effort": "low" }), live());
    assert_eq!(Value::Object(requested), json!({ "effort": "low", "fast": false, "effortAuto": false, "provider": "openai", "model": "gpt-5" }));
    assert!(options.session_only);
    let (requested, _) = written(json!({ "sessionOnly": true, "provider": "anthropic", "model": "claude-x" }), live());
    assert_eq!(
        Value::Object(requested),
        json!({ "provider": "anthropic", "model": "claude-x" }),
        "another model is selected as named: it takes its own saved settings, not the ones the live model had"
    );
    let (requested, _) = written(json!({ "sessionOnly": true, "fast": true }), live());
    assert_eq!(requested["fast"], true);
    assert_eq!(requested["effortAuto"], true, "changing fast keeps the live route's Auto setting");
}

#[test]
fn a_session_only_request_for_a_session_that_runs_another_model_is_a_write_even_when_the_route_matches() {
    let selected = json!({ "provider": "openai", "model": "gpt-5", "sessionProvider": "anthropic", "sessionModel": "claude-x", "effort": "high" });
    assert!(matches!(plan(&obj(json!({ "sessionOnly": true })), &obj(selected)), Plan::Write(..)));
}

#[test]
fn a_session_only_request_with_a_key_beyond_its_five_is_a_write() {
    assert!(matches!(plan(&obj(json!({ "sessionOnly": true, "contextPercent": 50 })), &obj(live())), Plan::Write(..)));
}

/// What the world answers: the model row the catalog holds and which providers can go fast.
struct Facts {
    meta: Value,
    fast: bool,
}

#[async_trait]
impl RouteFacts for Facts {
    fn is_known(&self, _: &str, _: &Obj) -> bool {
        true
    }
    async fn ensure_ready(&self, _: &Obj, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn model_meta(&self, _: &str, _: &str) -> Value {
        self.meta.clone()
    }
    fn window_meta(&self, _: &str, _: &str, meta: &Value) -> Option<Value> {
        window_meta_of(Some(meta), None).cloned()
    }
    fn catalog_knows(&self, _: &str, _: &str) -> bool {
        true
    }
    fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
        self.fast
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
}

/// The live route of the one thread, and how often a session was asked to follow.
struct Writer {
    route: Mutex<Route>,
}

#[async_trait]
impl RouteWriter for Writer {
    fn route(&self, _: &ThreadId) -> Route {
        self.route.lock().unwrap().clone()
    }
    fn set_route_state(&self, _: &ThreadId, route: Route) {
        *self.route.lock().unwrap() = route;
    }
    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }
    async fn refresh_route_effort(&self, _: &ThreadId, _: Option<Value>, _: bool, _: Option<u64>) -> Result<Option<Route>, PortError> {
        Ok(None)
    }
    fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {}
}

#[derive(Default)]
struct Session {
    follows: Mutex<Vec<FollowOptions>>,
    selected: Mutex<Option<Route>>,
}

#[async_trait]
impl SessionFollow for Session {
    async fn tuning_pick(&self, _: &ThreadId) -> Result<Option<Route>, PortError> {
        Ok(self.selected.lock().unwrap().clone())
    }
    fn open_lease(&self, _: &ThreadId, origin: Option<u64>) -> u64 {
        origin.unwrap_or(0)
    }
    async fn follow(&self, _: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError> {
        self.follows.lock().unwrap().push(options.clone());
        Ok(Followed::default())
    }
    async fn tune(&self, _: &ThreadId) -> Result<(), PortError> {
        Ok(())
    }
    async fn has_session(&self, _: &ThreadId) -> Result<bool, PortError> {
        Ok(true)
    }
    async fn seat(&self, _: &ThreadId) -> Result<(), PortError> {
        Ok(())
    }
    async fn switch_now(&self, _: &ThreadId) -> Result<Option<Value>, PortError> {
        Ok(None)
    }
}

struct NoControls;

impl LiveControls for NoControls {
    fn sync_live(&self, _: &mut dyn FnMut(&ThreadId)) {}
}

struct Offline;

#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// The Main route agents inherit, and the chain entries that resolve to themselves.
struct Agents;

#[async_trait]
impl RouteContext for Agents {
    fn resolve_main(&self) -> Result<Obj, String> {
        Ok(obj(json!({ "provider": "anthropic", "model": "claude-x" })))
    }
    async fn resolve_chain_entry(&self, entry: &Obj, _: &Obj) -> Result<Obj, String> {
        Ok(super::agent_route_feature_tests::resolved_entry(entry))
    }
    async fn ensure_ready(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn sender(&self, _: &str) -> Result<Option<super::chain::RouteSender>, String> {
        Ok(None)
    }
}

/// What the agents' chats were told: the agent and the route it takes from its next turn.
#[derive(Default)]
struct Published(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl mixdog_core_ports::ports::domain_sessions::AgentRoutePublisher for Published {
    async fn publish(&self, agent: &str, route: &Value) {
        self.0.lock().unwrap().push((agent.to_owned(), route.clone()));
    }
}

struct Rig {
    service: RouteSetService,
    session: Arc<Session>,
    published: Arc<Published>,
    agent_routes: AgentRoutes,
    file: std::path::PathBuf,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

impl Rig {
    /// The `agent` section of the config file as it is on disk now.
    fn saved_agent(&self) -> Value {
        let file: Value = serde_json::from_slice(&std::fs::read(&self.file).unwrap()).unwrap();
        file["agent"].clone()
    }
}

/// The real route service over the real config file, with the live route `live`, the model row `meta` and whether the model can go fast.
async fn build(meta: Value, fast: bool) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let catalog = Arc::new(
        CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io)).await,
    );
    let models = Arc::new(ModelListService {
        catalog,
        config: config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(UnsupportedEfforts::default()),
        host: None,
    });
    let session = Arc::new(Session::default());
    let routes = RouteService {
        config: config.clone(),
        facts: Arc::new(Facts { meta, fast }),
        writer: Arc::new(Writer { route: Mutex::new(obj(live())) }),
        session: session.clone(),
        models,
        controls: Arc::new(NoControls),
    };
    let published = Arc::new(Published::default());
    let agents = AgentRouteSetter {
        routes: AgentRoutes::new(config.clone(), dir.path()),
        config: config.clone(),
        context: Arc::new(Agents),
        publisher: published.clone(),
        hidden: hidden_agents(),
    };
    let ops = scopes(state.path(), "route").await;
    let agent_routes = AgentRoutes::new(config.clone(), dir.path());
    Rig {
        service: RouteSetService { routes: Arc::new(routes), agents: Arc::new(agents), ops },
        session,
        published,
        agent_routes,
        file: path,
        _dirs: (dir, state),
    }
}

fn text(error: CoreError) -> String {
    format!("{error:?}")
}

#[tokio::test]
async fn a_session_only_request_for_what_the_route_already_is_answers_the_live_route_and_follows_nothing() {
    let rig = build(Value::Null, false).await;
    let params = with_op(json!({ "threadId": "t", "route": { "sessionOnly": true, "effort": "high", "effortAuto": true } }), 1);
    let answer = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect("an answer");
    assert_eq!(answer, live());
    assert!(rig.session.follows.lock().unwrap().is_empty(), "nothing was written, so no session followed");
}

#[tokio::test]
async fn a_route_that_is_not_an_object_is_an_invalid_request() {
    let rig = build(Value::Null, false).await;
    let params = with_op(json!({ "threadId": "t", "route": "openai/gpt-5" }), 1);
    let error = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect_err("refused");
    assert!(matches!(error, CoreError::InvalidParams { .. }), "{error:?}");
}

#[tokio::test]
async fn fast_cannot_be_turned_on_for_a_model_the_catalog_says_has_no_fast_mode() {
    let resolved = json!({ "id": "gpt-5", "provider": "openai", "contextWindow": 400000 });
    let rig = build(resolved, false).await;
    let params = with_op(json!({ "threadId": "t", "on": true }), 1);
    let error = value(&rig.service, request(FAST_SET, params, Some(1))).await.expect_err("refused");
    assert!(text(error).contains("fast mode is not available for openai/gpt-5"));
    let before = rig.saved_agent();
    let params = with_op(json!({ "threadId": "t", "route": { "provider": "openai", "model": "gpt-5", "fast": true, "applyToCurrentSession": true } }), 2);
    let error = value(&rig.service, request(ROUTE_SET, params, Some(2))).await.expect_err("the picker must not silently stage Standard");
    assert!(text(error).contains("fast mode is not available"));
    assert_eq!(rig.saved_agent(), before);
    assert!(rig.session.follows.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_repeated_op_answers_the_first_outcome_without_asking_again() {
    let resolved = json!({ "id": "gpt-5", "provider": "openai", "contextWindow": 400000 });
    let rig = build(resolved, false).await;
    let params = with_op(json!({ "threadId": "t", "on": true }), 7);
    let first = value(&rig.service, request(FAST_SET, params.clone(), Some(7))).await.expect_err("refused");
    let second = value(&rig.service, request(FAST_SET, params, Some(7))).await.expect_err("refused again");
    assert_eq!(text(first), text(second));
}
fn gpt_5_row() -> Value {
    json!({ "id": "gpt-5", "provider": "openai", "contextWindow": 400000 })
}

#[tokio::test]
async fn an_explicit_tune_after_a_hop_saves_the_fallback_not_the_previous_cell_model() {
    let rig = build(gpt_5_row(), true).await;
    let thread = ThreadId::from("t");
    *rig.session.selected.lock().unwrap() = Some(obj(json!({ "provider": "openai", "model": "fallback", "effort": "high", "effortAuto": false })));
    rig.service.routes.set_effort(&thread, &json!("low"), false).await.unwrap();
    assert!(rig.service.routes.set_fast(&thread, super::route_service::FastValue::On).await.unwrap());
    let saved = rig.saved_agent();
    let settings = &saved["modelSettings"]["openai/fallback"];
    assert_eq!((&settings["effort"], &settings["fast"], &settings["effortAuto"]), (&json!("low"), &json!(true), &json!(false)));
    assert!(saved["modelSettings"].get("openai/gpt-5").is_none());
}

#[tokio::test]
async fn a_selection_saves_the_models_own_settings_and_the_session_follows_it_without_the_main_model_changing() {
    let rig = build(gpt_5_row(), false).await;
    let params = with_op(json!({ "threadId": "t", "route": { "provider": "openai", "model": "gpt-5", "effort": "low" } }), 1);
    let answer = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect("an answer");
    assert_eq!(
        (&answer["provider"], &answer["model"], &answer["effort"]),
        (&json!("openai"), &json!("gpt-5"), &json!("low")),
        "the live route is the selection"
    );
    let saved = rig.saved_agent();
    assert_eq!(
        saved["modelSettings"],
        json!({ "openai/gpt-5": { "effort": "low", "fast": false, "effortAuto": true, "modelParameters": {} } }),
        "the model's settings are saved under provider/model with explicit effortAuto"
    );
    assert!(saved.get("presets").is_none() && saved.get("default").is_none(), "a selection keeps the Main model unless it says otherwise: {saved}");
    assert_eq!(rig.session.follows.lock().unwrap().len(), 1, "the addressed session follows the saved route once");
}

#[tokio::test]
async fn a_selection_that_does_not_keep_the_main_model_makes_it_the_lead_preset_and_the_default() {
    let rig = build(gpt_5_row(), false).await;
    let route = json!({ "provider": "openai", "model": "gpt-5", "effort": "low", "keepMainModel": false });
    let params = with_op(json!({ "threadId": "t", "route": route }), 1);
    value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect("an answer");
    let saved = rig.saved_agent();
    assert_eq!(saved["default"], "workflow-lead");
    assert_eq!(
        saved["presets"],
        json!([{ "id": "workflow-lead", "name": "WORKFLOW LEAD", "type": "agent", "provider": "openai", "model": "gpt-5", "effort": "low", "fast": false, "effortAuto": true, "tools": "full" }])
    );
    assert_eq!(saved["modelSettings"]["openai/gpt-5"]["effort"], "low");
    assert_eq!(saved["modelSettings"]["openai/gpt-5"]["effortAuto"], true);
}

#[tokio::test]
async fn effort_auto_states_survive_tuning_changes() {
    for (label, initial) in [("auto", true), ("manual", false)] {
        let rig = build(gpt_5_row(), true).await;
        let thread = ThreadId::from("t");
        let live_route = obj(json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": false, "effortAuto": initial }));
        rig.service.routes.writer.set_route_state(&thread, live_route);

        rig.service.routes.set_fast(&thread, super::route_service::FastValue::On).await.expect("set_fast");
        let after_fast = rig.service.routes.writer.route(&thread);
        assert_eq!(after_fast["effortAuto"], json!(initial), "set_fast live route preserves {label}");
        assert_eq!(rig.saved_agent()["modelSettings"]["openai/gpt-5"]["effortAuto"], json!(initial), "set_fast modelSettings preserves {label}");

        let params = with_op(json!({ "threadId": "t", "route": { "fast": false } }), 2);
        let answer = value(&rig.service, request(ROUTE_SET, params, Some(2))).await.expect("route/set fast");
        assert_eq!(answer["effortAuto"], json!(initial), "ROUTE_SET fast toggle preserves {label}");
        assert_eq!(rig.saved_agent()["modelSettings"]["openai/gpt-5"]["effortAuto"], json!(initial), "ROUTE_SET modelSettings preserves {label}");
    }
}

#[tokio::test]
async fn set_effort_auto_enables_auto_effort_and_explicit_level_disables_it() {
    let rig = build(gpt_5_row(), false).await;
    let thread = ThreadId::from("t");
    let explicit = rig.service.routes.set_effort(&thread, &json!("low"), false).await.unwrap();
    assert_eq!((&explicit["effort"], &explicit["effortAuto"]), (&json!("low"), &json!(false)), "the live route afterwards");
    let saved_explicit = rig.saved_agent();
    assert_eq!(saved_explicit["modelSettings"]["openai/gpt-5"]["effort"], "low");
    assert_eq!(saved_explicit["modelSettings"]["openai/gpt-5"]["effortAuto"], false);

    let auto = rig.service.routes.set_effort(&thread, &json!("auto"), false).await.unwrap();
    assert_eq!(auto["effortAuto"], json!(true), "the live route afterwards");
    let saved_auto = rig.saved_agent();
    assert_eq!(saved_auto["modelSettings"]["openai/gpt-5"]["effortAuto"], true);

    // A fast-only selection against an Auto route must keep Auto on even though complete_request copies live effort.
    let fast_rig = build(gpt_5_row(), true).await;
    let params = with_op(json!({ "threadId": "t", "route": { "fast": true } }), 2);
    let answer = value(&fast_rig.service, request(ROUTE_SET, params, Some(2))).await.expect("fast toggle");
    assert_eq!((&answer["fast"], &answer["effortAuto"]), (&json!(true), &json!(true)));
}

#[tokio::test]
async fn a_session_only_change_writes_nothing_to_the_config_file() {
    let rig = build(gpt_5_row(), false).await;
    let before = rig.saved_agent();
    let params = with_op(json!({ "threadId": "t", "route": { "sessionOnly": true, "effort": "low" } }), 1);
    let answer = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect("an answer");
    assert_eq!(answer["effort"], "low", "the live route took it");
    assert_eq!(rig.saved_agent(), before, "the file is as it was");
    assert_eq!(rig.session.follows.lock().unwrap().len(), 1, "the session follows the new live route");
}

#[tokio::test]
async fn a_validate_only_selection_answers_the_live_route_and_changes_nothing() {
    let rig = build(gpt_5_row(), false).await;
    let before = rig.saved_agent();
    let params = with_op(json!({ "threadId": "t", "route": { "provider": "openai", "model": "gpt-5", "validateOnly": true } }), 1);
    assert_eq!(value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect("an answer"), live());
    assert_eq!(rig.saved_agent(), before);
    assert!(rig.session.follows.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_agents_route_is_saved_for_the_agent_and_its_chats_are_told_once_per_change() {
    let rig = build(gpt_5_row(), false).await;
    let set = |op: u64| with_op(json!({ "agentId": "bench", "route": { "provider": "openai", "model": "gpt-5" } }), op);
    let first = value(&rig.service, request(ROUTE_SET, set(1), Some(1))).await.expect("an answer");
    assert_eq!((&first["provider"], &first["model"]), (&json!("openai"), &json!("gpt-5")));
    let own = rig.agent_routes.own_route("bench").await.unwrap();
    assert_eq!((&own["provider"], &own["model"]), (&json!("openai"), &json!("gpt-5")), "the agent holds its own route now");
    assert_eq!(rig.published.0.lock().unwrap().len(), 1, "it left the Main route it inherited, so its chats are told");
    assert_eq!(rig.published.0.lock().unwrap()[0].0, "bench");
    value(&rig.service, request(ROUTE_SET, set(2), Some(2))).await.expect("an answer");
    assert_eq!(rig.published.0.lock().unwrap().len(), 1, "the same route again tells nobody");
    assert!(rig.session.follows.lock().unwrap().is_empty(), "an agent's route moves no session");
}

#[tokio::test]
async fn an_agent_route_chosen_only_if_empty_leaves_the_route_the_agent_has() {
    let rig = build(gpt_5_row(), false).await;
    let first = with_op(json!({ "agentId": "bench", "route": { "provider": "openai", "model": "gpt-5" } }), 1);
    value(&rig.service, request(ROUTE_SET, first, Some(1))).await.expect("an answer");
    let second = with_op(json!({ "agentId": "bench", "route": { "provider": "anthropic", "model": "claude-y", "onlyIfEmpty": true } }), 2);
    let answer = value(&rig.service, request(ROUTE_SET, second, Some(2))).await.expect("an answer");
    assert_eq!((&answer["model"], &answer["skipped"], &answer["id"]), (&json!("gpt-5"), &json!(true), &json!("bench")), "the answer is the route it keeps");
    assert_eq!(rig.agent_routes.own_route("bench").await.unwrap()["model"], "gpt-5");
}

#[tokio::test]
async fn an_internal_agent_and_a_nameless_one_have_no_route_to_set() {
    let rig = build(gpt_5_row(), false).await;
    let internal = hidden_agents().into_iter().next().expect("an internal agent");
    for (agent, wanted) in [(internal.as_str(), "is internal and has no configurable route"), ("  ", "")] {
        let params = with_op(json!({ "agentId": agent, "route": { "provider": "openai", "model": "gpt-5" } }), 1);
        let error = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.expect_err("refused");
        assert!(text(error).contains(wanted), "{agent:?}");
    }
    assert!(rig.published.0.lock().unwrap().is_empty());
}
