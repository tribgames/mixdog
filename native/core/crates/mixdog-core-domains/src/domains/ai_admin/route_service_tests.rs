//! The route service against the Node recording (`fixtures/ai-admin/route-service-twin.json`):
//! the adoption effects of `setRoute`, `setFast` and `setEffort` over the real `Config` file, with a
//! scripted catalog and recording route, refresh and session ports. What the session does with an
//! adopted route is `SessionRoutes`' (its own tests); here the exact `follow` / `tune` calls are
//! asserted.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, ensure_provider_enabled, window_meta_of};
use mixdog_core_api::domain::provider::{ModelListing, ModelRecord, ProviderError};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::chain::RouteFacts;
use super::model_list::ModelListService;
use super::model_list_tests::Offline;
use super::route_service::{FastValue, RouteService, SessionFollow, SetRouteOptions};
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelSource, ModelsDevSource};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::admin_models::developer_option_for_provider;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Followed;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteWriter;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/route-service-twin.json")).unwrap()
}

const KNOWN: [&str; 5] = ["openai", "openai-oauth", "anthropic", "anthropic-oauth", "gemini"];

#[derive(Default)]
pub(super) struct Log {
    ensured: Vec<Value>,
    route_states: Vec<Value>,
    refreshes: Vec<Value>,
    statusline: u32,
    pub(super) follows: Vec<FollowOptions>,
    tunes: u32,
    switches: u32,
}

struct Facts {
    case: Value,
    log: Arc<Mutex<Log>>,
}

#[async_trait]
impl RouteFacts for Facts {
    fn is_known(&self, provider: &str, _: &Obj) -> bool {
        KNOWN.contains(&provider.trim())
    }

    async fn ensure_ready(&self, config: &Obj, provider: &str) -> Result<(), String> {
        let keys: Vec<Value> = ensure_provider_enabled(config, provider).keys().map(|k| Value::from(k.as_str())).collect();
        self.log.lock().unwrap().ensured.push(Value::Array(keys));
        Ok(())
    }

    fn model_meta(&self, _: &str, _: &str) -> Value {
        self.case["meta"].clone()
    }

    fn window_meta(&self, _: &str, _: &str, meta: &Value) -> Option<Value> {
        window_meta_of(Some(meta), None).cloned()
    }

    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.case["knows"][format!("{provider}/{model}")].as_bool().unwrap_or(false)
    }

    fn fast_capable(&self, provider: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
        self.case["fastTable"][provider].as_bool().unwrap_or(false)
    }

    fn ultrafast_capable(&self, provider: &str, _: &Value) -> bool {
        self.case["ultraTable"][provider].as_bool().unwrap_or(false)
    }
}

pub(super) struct Writer {
    route: Mutex<Route>,
    log: Arc<Mutex<Log>>,
}

#[async_trait]
impl RouteWriter for Writer {
    fn route(&self, _: &ThreadId) -> Route {
        self.route.lock().unwrap().clone()
    }

    fn set_route_state(&self, _: &ThreadId, route: Route) {
        self.log.lock().unwrap().route_states.push(Value::Object(route.clone()));
        *self.route.lock().unwrap() = route;
    }

    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }

    async fn refresh_route_effort(&self, _: &ThreadId, meta: Option<Value>, guard_supersede: bool, lease: Option<u64>) -> Result<Option<Route>, PortError> {
        self.log.lock().unwrap().refreshes.push(json!({ "meta": meta, "expectedIsLive": guard_supersede, "lease": lease }));
        Ok(None)
    }

    fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {
        self.log.lock().unwrap().statusline += 1;
    }
}

struct Session {
    log: Arc<Mutex<Log>>,
    case: Value,
    writer: Arc<Writer>,
}

#[async_trait]
impl SessionFollow for Session {
    fn open_lease(&self, _: &ThreadId, origin: Option<u64>) -> u64 {
        origin.unwrap_or(0)
    }

    async fn follow(&self, _: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError> {
        self.log.lock().unwrap().follows.push(options.clone());
        Ok(Followed::default())
    }

    async fn tune(&self, _: &ThreadId) -> Result<(), PortError> {
        self.log.lock().unwrap().tunes += 1;
        Ok(())
    }

    // The conversation the recording addressed runs `continueSession`; a switch to another model
    // records a boundary (its clock reading is the recording's 0).
    async fn switch_now(&self, thread: &ThreadId) -> Result<Option<Value>, PortError> {
        self.log.lock().unwrap().switches += 1;
        let route = self.writer.route(thread);
        let held = &self.case["continueSession"];
        if route.get("provider") == Some(&held["provider"]) && route.get("model") == Some(&held["model"]) {
            return Ok(None);
        }
        Ok(Some(json!({ "provider": route.get("provider"), "modelId": route.get("model"), "at": 0 })))
    }
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

fn subset(doc: &Obj) -> Value {
    Value::Object(["default", "presets", "modelSettings"].iter().filter_map(|k| doc.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect())
}

pub(super) async fn rig(case: &Value) -> (RouteService, Arc<Writer>, Arc<Mutex<Log>>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["config"] })).unwrap()).unwrap();
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    // The model list reads the catalog the case recorded (`snapshot`), none when it records none.
    let snapshot: CatalogSnapshot = if case["snapshot"].is_null() { CatalogSnapshot::default() } else { serde_json::from_value(case["snapshot"].clone()).unwrap() };
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let catalog = Arc::new(CatalogService::cold_start(snapshot, Vec::new(), ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io)).await);
    let models = Arc::new(ModelListService {
        catalog,
        config: config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(UnsupportedEfforts::default()),
            host: None,
    });
    if !case["fileOverride"].is_null() {
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["fileOverride"] })).unwrap()).unwrap();
    }
    let log = Arc::new(Mutex::new(Log::default()));
    let writer = Arc::new(Writer { route: Mutex::new(obj(&case["live"])), log: log.clone() });
    let service = RouteService {
        config,
        facts: Arc::new(Facts { case: case.clone(), log: log.clone() }),
        writer: writer.clone(),
        session: Arc::new(Session { log: log.clone(), case: case.clone(), writer: writer.clone() }),
        models,
    };
    (service, writer, log, dir)
}

fn options(case: &Value) -> SetRouteOptions {
    let o = &case["options"];
    SetRouteOptions {
        keep_main_model: o.get("keepMainModel").and_then(Value::as_bool),
        only_if_empty: o["onlyIfEmpty"] == json!(true),
        session_only: o["sessionOnly"] == json!(true),
        validate_only: o["validateOnly"] == json!(true),
        follow: FollowOptions::default(),
    }
}

/// A default route with no model is refused before a thread exists, with the text Node's
/// `resolveMissingRouteModelForFirstTurn` throws (`fixtures/ai-admin/route-model-refusals.json`,
/// extracted from the Node source). Which text follows what Node's `collectProviderModels()`
/// answered over the recorded catalogs (`fixtures/ai-admin/model-list-service-twin.json`, Node's
/// real read): no row means "No provider models available", including a catalog whose providers
/// are all unavailable; any row means "No model selected". A route with a model is readied.
#[tokio::test]
async fn a_default_route_with_no_model_is_refused_with_the_texts_node_throws() {
    let thread = ThreadId::from("t");
    let refusals: Value = serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/route-model-refusals.json")).unwrap();
    let recorded: Value = serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/model-list-service-twin.json")).unwrap();
    // Catalogs whose every listed model sits under a Developer-gated provider (recorded with the
    // option off, so none is available) and catalogs Node answered rows for.
    let (mut unavailable, mut listed) = (0, 0);
    for (i, recording) in recorded["cases"].as_array().unwrap().iter().enumerate() {
        if matches!(recording["read"].as_str(), Some("force" | "warm-quick")) {
            continue;
        }
        let rows = recording["value"].as_array().unwrap().len();
        let providers_with_models: Vec<&str> =
            recording["snapshot"]["models"].as_object().unwrap().iter().filter(|(_, models)| !models.as_array().unwrap().is_empty()).map(|(name, _)| name.as_str()).collect();
        let in_catalog = providers_with_models.len();
        let case = json!({ "config": recording["config"], "snapshot": recording["snapshot"], "live": { "provider": "anthropic-oauth", "model": "" } });
        let (service, _writer, log, _dir) = rig(&case).await;
        let refused = service.ready_default(&thread).await.expect_err("a model-less route is refused");
        let text = if rows == 0 { "noProviderModels" } else { "noModelSelected" };
        assert_eq!(refused, refusals[text].as_str().unwrap(), "case {i}: {rows} rows, models under {in_catalog} providers");
        assert!(log.lock().unwrap().refreshes.is_empty(), "nothing is readied for it");
        let gated_only = in_catalog > 0 && recording["config"]["developer"].is_null() && providers_with_models.iter().all(|name| developer_option_for_provider(name).is_some());
        if rows == 0 && gated_only {
            unavailable += 1;
        }
        if rows > 0 {
            listed += 1;
        }
    }
    assert!(unavailable > 0 && listed > 0, "the recording covers catalog models with no provider available ({unavailable}) and the reverse ({listed})");
    let case = json!({ "config": {}, "live": { "provider": "anthropic-oauth", "model": "claude-x" } });
    let (service, _writer, log, _dir) = rig(&case).await;
    service.ready_default(&thread).await.expect("a route with a model is readied");
    assert_eq!(log.lock().unwrap().refreshes.len(), 1);
}

/// A provider listing held open by the test: it says it was asked, then answers nothing once released.
struct Gated {
    asked: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait]
impl ModelListing for Gated {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.asked.notify_one();
        self.release.notified().await;
        Ok(Vec::new())
    }
}

/// `route-resolution.mjs:28-30` (`route-resolution.test.mjs` "a model chosen while the catalog is
/// read is taken, not refused"): the model lands while the catalog read is held open, so the live
/// route read again afterwards has one and the refusal never happens. The gate is the listing
/// itself: the model is chosen only once the read is under way, and the read finishes only after.
#[tokio::test]
async fn a_model_chosen_while_the_catalog_is_read_is_taken_not_refused() {
    let thread = ThreadId::from("t");
    let case = json!({ "config": {}, "live": { "provider": "anthropic-oauth", "model": "" } });
    let (mut service, writer, log, dir) = rig(&case).await;
    let (asked, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let source = ModelSource::new(serde_json::from_value(json!("openai-oauth")).unwrap(), Arc::new(Gated { asked: asked.clone(), release: release.clone() }));
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), vec![source], ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io)).await);
    service.models = Arc::new(ModelListService {
        catalog,
        config: service.config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(UnsupportedEfforts::default()),
            host: None,
    });
    let pick = async {
        asked.notified().await;
        *writer.route.lock().unwrap() = obj(&json!({ "provider": "anthropic-oauth", "model": "claude-x" }));
        release.notify_one();
    };
    let (ready, ()) = tokio::join!(service.ready_default(&thread), pick);
    ready.expect("a model chosen during the catalog read stands");
    assert_eq!(log.lock().unwrap().refreshes.len(), 1, "the chosen route is readied");

    // Still no model once the read is done: refused, as before.
    *writer.route.lock().unwrap() = obj(&case["live"]);
    release.notify_one();
    let refused = service.ready_default(&thread).await.expect_err("still no model");
    assert!(refused.starts_with("No provider models available"), "{refused}");
}

#[tokio::test]
async fn the_adoption_effects_match_node() {
    let thread = ThreadId::from("t");
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let (service, writer, log, dir) = rig(case).await;
        let got = match case["kind"].as_str().unwrap() {
            "setRoute" => service.set_route(&thread, &obj(&case["request"]), &options(case)).await,
            "setFast" => {
                let value = match &case["setFastValue"] {
                    Value::String(_) => FastValue::Ultrafast,
                    Value::Bool(true) => FastValue::On,
                    _ => FastValue::Off,
                };
                service.set_fast(&thread, value).await.map(Value::Bool)
            }
            "continue" => {
                let id = case["continueSessionId"].as_str().unwrap();
                service.continue_session_in_model(&thread, id, &obj(&case["request"])).await
            }
            _ => service.set_effort(&thread, &case["effortValue"], false).await,
        };
        let got = match got {
            Ok(v) => json!({ "value": v }),
            Err(e) => json!({ "error": e }),
        };
        let want = match case.get("error") {
            Some(e) => json!({ "error": e }),
            None => json!({ "value": case["value"] }),
        };
        let label = format!("case {i}: {} {} {}", case["kind"], case["request"], case["options"]);
        assert_eq!(got, want, "{label}");
        assert_eq!(Value::Object(writer.route(&thread)), case["after"]["route"], "{label} route");
        let on_disk: Value = serde_json::from_slice(&std::fs::read(dir.path().join("mixdog-config.json")).unwrap()).unwrap();
        assert_eq!(subset(&obj(&on_disk["agent"])), case["after"]["file"], "{label} saved config");
        let log = log.lock().unwrap();
        assert_eq!(Value::Array(log.route_states.clone()), case["log"]["routeStates"], "{label} route states");
        assert_eq!(Value::Array(log.refreshes.clone()), case["log"]["refreshes"], "{label} refreshes");
        assert_eq!(Value::Array(log.ensured.clone()), case["log"]["ensured"], "{label} ensured");
        assert_eq!(log.statusline as u64, case["log"]["statusline"].as_u64().unwrap(), "{label} statusline");
        // The session half: an adopted unaddressed selection follows once; a tuning tunes once.
        let adopted = got["value"].is_object() && !options(case).validate_only && case["kind"] == "setRoute" && !log.refreshes.is_empty();
        assert_eq!(log.follows.len(), usize::from(adopted), "{label} follows");
        let tuning = case["kind"] == "setFast" || case["kind"] == "setEffort";
        assert_eq!(log.tunes, u32::from(tuning && got.get("value").is_some()), "{label} tunes");
        // A continue switches the conversation whenever its selection was adopted (the refresh
        // ran), and its return value says whether a boundary was recorded.
        let continued = case["kind"] == "continue" && !log.refreshes.is_empty();
        assert_eq!(log.switches, u32::from(continued), "{label} switches");
    }
}

#[tokio::test]
async fn an_addressed_selection_follows_under_the_lease_it_was_opened_with() {
    let case = twin()["cases"].as_array().unwrap().iter().find(|c| c["kind"] == "setRoute" && c.get("error").is_none() && c["options"] == json!({}) && c["request"]["model"].is_string()).unwrap().clone();
    let thread = ThreadId::from("t");
    let (service, _writer, log, _dir) = rig(&case).await;
    let opts = SetRouteOptions {
        follow: FollowOptions { switch_established: true, defer_until_next_turn: false, apply_to_current_session: false, lease: Some(0) },
        ..SetRouteOptions::default()
    };
    service.set_route(&thread, &obj(&case["request"]), &opts).await.unwrap();
    let follows = log.lock().unwrap().follows.clone();
    assert_eq!(follows.len(), 1);
    assert!(follows[0].switch_established && follows[0].lease == Some(0));
}
