//! The route service over a real config file and scripted catalog, route, refresh and session ports: a model chosen while the catalog is read is taken, and a
//! default route with no model is told to choose one when the catalog lists models.

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
use super::route_service::{LiveControls, RouteService, SessionFollow};
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelSource, ModelsDevSource};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Followed;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteWriter;

/// The directory's live control threads, as the test publishes them.
#[derive(Default)]
struct Controls(Mutex<Vec<ThreadId>>);

impl LiveControls for Controls {
    fn sync_live(&self, sync: &mut dyn FnMut(&ThreadId)) {
        for thread in self.0.lock().unwrap().clone() {
            sync(&thread);
        }
    }
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
    /// The next route refresh fails (the last step of ready_control).
    refresh_fails: std::sync::atomic::AtomicBool,
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
        if self.refresh_fails.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(PortError::Failed { capability: "route".into(), message: "refused".into() });
        }
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

    async fn has_session(&self, _: &ThreadId) -> Result<bool, PortError> {
        Ok(true)
    }

    async fn seat(&self, _: &ThreadId) -> Result<(), PortError> {
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

pub(super) async fn rig(case: &Value) -> (RouteService, Arc<Writer>, Arc<Mutex<Log>>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["config"] })).unwrap()).unwrap();
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    // The model list reads the catalog the case recorded (`snapshot`), none when it records none.
    let snapshot: CatalogSnapshot =
        if case["snapshot"].is_null() { CatalogSnapshot::default() } else { serde_json::from_value(case["snapshot"].clone()).unwrap() };
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
    let writer = Arc::new(Writer { route: Mutex::new(obj(&case["live"])), log: log.clone(), refresh_fails: Default::default() });
    let service = RouteService {
        config,
        facts: Arc::new(Facts { case: case.clone(), log: log.clone() }),
        writer: writer.clone(),
        session: Arc::new(Session { log: log.clone(), case: case.clone(), writer: writer.clone() }),
        models,
        controls: Arc::new(Controls::default()),
    };
    (service, writer, log, dir)
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

#[tokio::test]
async fn a_model_chosen_while_the_catalog_is_read_is_taken_not_refused() {
    let thread = ThreadId::from("t");
    let case = json!({ "config": {}, "live": { "provider": "anthropic-oauth", "model": "" } });
    let (mut service, writer, log, dir) = rig(&case).await;
    let (asked, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let source = ModelSource::new(serde_json::from_value(json!("openai-oauth")).unwrap(), Arc::new(Gated { asked: asked.clone(), release: release.clone() }));
    let catalog = Arc::new(
        CatalogService::cold_start(CatalogSnapshot::default(), vec![source], ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io)).await,
    );
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

struct Lists(Vec<ModelRecord>);

#[async_trait]
impl ModelListing for Lists {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.0.clone())
    }
}

/// A default route with no model is refused before a thread exists: "No provider models available" when the catalog lists none
/// (the first test above), "No model selected" when it lists some and the route names none.
#[tokio::test]
async fn a_default_route_with_no_model_is_told_to_choose_one_when_the_catalog_lists_models() {
    let thread = ThreadId::from("t");
    let case = json!({ "config": {}, "live": { "provider": "anthropic-oauth", "model": "" } });
    let (mut service, _writer, log, dir) = rig(&case).await;
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let record = mixdog_ai::providers::openai::models::codex_record(&json!({ "slug": "gpt-5-codex", "display_name": "GPT 5" })).unwrap();
    let source = ModelSource::new(serde_json::from_value(json!("openai-oauth")).unwrap(), Arc::new(Lists(vec![record])));
    let catalog = Arc::new(
        CatalogService::cold_start(CatalogSnapshot::default(), vec![source], ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io)).await,
    );
    service.models = Arc::new(ModelListService {
        catalog,
        config: service.config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(UnsupportedEfforts::default()),
        host: None,
    });
    let refused = service.ready_default(&thread).await.expect_err("a model-less route is refused");
    assert_eq!(refused, "No model selected. Choose a model with /model first.");
    assert!(log.lock().unwrap().refreshes.is_empty(), "nothing is readied for it");
}

/// The control session carries the desktop's thread-less calls (settings reads, image resizes): a Lead route whose
/// provider cannot be readied (an agent not installed) still starts it, on that route as it is.
#[tokio::test]
async fn a_control_session_starts_on_a_lead_route_that_cannot_be_readied() {
    let thread = ThreadId::from("t");
    let case = json!({ "config": {}, "live": { "provider": "acp-antigravity", "model": "gemini-4-neon" } });
    let (service, writer, log, _dir) = rig(&case).await;
    writer.refresh_fails.store(true, std::sync::atomic::Ordering::SeqCst);
    service.ready_control(&thread).await.expect("the control session starts");
    assert_eq!(log.lock().unwrap().refreshes.len(), 1, "the route was offered to be readied");
    assert_eq!(writer.route(&thread), obj(&case["live"]), "the route stands as it is");
}
