//! The model-list rig: a profile's production pipeline (config load, provider defaults, the real `DefaultProviderBuilder` over a fake
//! `HttpSend` endpoint, readiness, the registry's adapters handed to the catalog, quick rows, hydration, sort and the web-search
//! tiers) with seeded models.dev / LiteLLM catalogs, and its feature tests.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ProviderReadiness};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::pace::SystemPace;
use mixdog_ai::providers::google::traits::{ModelTraits, ThinkingControl};
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::providers::openai::config::{CodexIdentity, NoFacts};
use mixdog_ai::registry::builder::{BuilderEnv, DefaultProviderBuilder};
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, MemoryVault, SecretVault, VaultError};
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::service::admin_route::{Obj, resolve_route};
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::transport::http::{BodyStream, HttpResponse, HttpSend};
use mixdog_ai::transport::{Exchange, KeepaliveDialer, KeepaliveSchedule, ReqwestLink};
use mixdog_core_api::domain::provider::{ProviderAdapter, ProviderError, TransportFault, WireRequest};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{Config, ConfigLanes};
use mixdog_core_ports::ports::route::{LiveRoute, Route};
use serde_json::{Value, json};

use super::model_list::{ListHost, ModelListService};
use super::model_list_tests::Offline;
use super::provider_sync::{LoadedConfig, load_config, spawn_provider_sync};
use super::web_search_models::{WebSearchModelsService, WebSearchRoutes};
use crate::domains::ai_account::collaborators::WebSearchModels;
use crate::domains::ai_account::failure::Failure;

/// The catalogs a profile starts from: none.
pub(super) fn seeds() -> Value {
    json!({ "modelsDev": {}, "litellm": {} })
}

/// A profile with no provider enabled.
pub(super) fn defaults() -> Value {
    json!({ "agent": {}, "stub": {} })
}

/// One custom provider that lists only the models its config names.
pub(super) fn custom_manual() -> Value {
    json!({
        "agent": {
            "providers": { "custom-aaaa": {
                "type": "custom", "schemaVersion": 2, "name": "Alpha", "protocol": "openai-chat", "baseURL": "__BASE_URL__/v1", "auth": "none", "enabled": true,
                "modelOverrides": {
                    "m1": { "manual": true, "name": "Model One", "contextWindow": 64000, "maxOutputTokens": 4096 },
                    "m2": { "manual": true, "reasoning": { "levels": ["low", "high"] } },
                    "m3": { "manual": true, "hidden": true },
                    "m4": { "manual": true, "supportsVision": false }
                }
            } },
            "presets": [{ "id": "p1", "name": "P1", "provider": "custom-aaaa", "model": "m1", "effort": "high" }],
            "default": "p1"
        },
        "stub": {}
    })
}

/// One custom provider whose endpoint lists `disc-a`, `disc-b` and `disc-c`; the config hides `disc-b` and names `m1`.
pub(super) fn custom_discovery() -> Value {
    json!({
        "agent": {
            "providers": { "custom-dddd": {
                "type": "custom", "schemaVersion": 2, "name": "Delta", "protocol": "openai-chat", "baseURL": "__BASE_URL__/c/v1", "auth": "none", "enabled": true,
                "modelOverrides": { "disc-b": { "hidden": true }, "m1": { "manual": true, "name": "Manual One" } }
            } },
            "presets": [{ "id": "d1", "name": "D1", "provider": "custom-dddd", "model": "disc-a" }],
            "default": "d1"
        },
        "stub": { "/c/v1/models": { "object": "list", "data": [
            { "id": "disc-a", "object": "model", "owned_by": "fixture" },
            { "id": "disc-b", "object": "model", "owned_by": "fixture" },
            { "id": "disc-c", "object": "model", "owned_by": "fixture", "context_length": 131072 }
        ] } }
    })
}

/// The providers a profile can name that Node's route resolution knows.
const KNOWN: [&str; 9] = [
    "custom-aaaa",
    "custom-bbbb",
    "custom-dddd",
    "custom-dddddddd-dddd-dddd-dddd-dddddddddddd",
    "anthropic-oauth",
    // The providers of the catalog-refresh-start recording.
    "custom-0a0a0a0a-0000-4000-8000-00000000000a",
    "custom-0b0b0b0b-0000-4000-8000-00000000000b",
    "custom-0c0c0c0c-0000-4000-8000-00000000000c",
    "custom-0e0e0e0e-0000-4000-8000-00000000000e",
];
const GATED: [&str; 4] = ["mimo-oauth", "cursor-oauth", "devin-oauth", "antigravity-oauth"];
/// Where the recorder's endpoint is, and a valid, unused address for the Rust profile.
const ENDPOINT: &str = "http://127.0.0.1:9";

/// The local fake model endpoint: GET of a recorded path answers its body, any other path an empty list.
struct Endpoint {
    /// What it answers; a test swaps it to move a provider's catalog without any mutation.
    routes: std::sync::Mutex<BTreeMap<String, Value>>,
    /// Every request waits here until the gate is open; a test closes it to hold a load in flight.
    gate: tokio::sync::watch::Receiver<bool>,
    /// One permit per request that reached the gate.
    arrived: Arc<tokio::sync::Semaphore>,
    /// Every request that reached the endpoint.
    hits: Arc<std::sync::atomic::AtomicUsize>,
    /// Every request that reached the endpoint, in order: method, URL (the endpoint as `__BASE_URL__`), the headers the
    /// adapter set and the body (`null` when empty).
    requests: tokio::sync::watch::Sender<Vec<Value>>,
}

struct Body(Option<bytes::Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let reply = |status: u16, body: Value| HttpResponse {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Box::new(Body(Some(body.to_string().into()))),
        };
        // Anything but the recorded endpoint is unreachable, as the recorded Node processes' fetch of other hosts was.
        let Some(path) = request.url.strip_prefix(ENDPOINT) else { return Ok(reply(503, json!({}))) };
        // A custom provider's connection warm-up is a raw `undici.request` in Node, which the recorder's fetch hook did not
        // see: answered, not one of the requests.
        if request.method == "HEAD" {
            return Ok(reply(200, json!({})));
        }
        let body = if request.body.is_empty() { Value::Null } else { Value::String(String::from_utf8_lossy(&request.body).into_owned()) };
        let logged = json!({ "method": request.method, "url": format!("__BASE_URL__{path}"), "headers": request.headers, "body": body });
        self.requests.send_modify(|log| log.push(logged));
        self.arrived.add_permits(1);
        self.hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.gate.clone().wait_for(|open| *open).await.expect("the gate outlives the rig");
        let path = path.split('?').next().unwrap_or(path);
        let answer = self.routes.lock().unwrap().get(path).cloned().unwrap_or_else(|| json!({ "object": "list", "data": [] }));
        // `{ "__status": n }` is that HTTP status with an empty object.
        match answer.get("__status").and_then(Value::as_u64) {
            Some(status) => Ok(reply(status as u16, json!({}))),
            None => Ok(reply(200, answer)),
        }
    }
}

/// The keychain of the rig: every secret read is counted, and a closed gate holds it (a load held in its preparation).
struct WatchedVault {
    inner: MemoryVault,
    gate: tokio::sync::watch::Receiver<bool>,
    arrived: Arc<tokio::sync::Semaphore>,
    reads: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait]
impl SecretVault for WatchedVault {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.arrived.add_permits(1);
        self.gate.clone().wait_for(|open| *open).await.expect("the gate outlives the rig");
        self.inner.get(account).await
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        self.inner.set(account, value).await
    }
    async fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.inner.delete(account).await
    }
}

struct Vars(HashMap<String, String>);
impl Environment for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

struct Traits;
impl ModelTraits for Traits {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

/// The production builder over the fake endpoint; `fail` makes every build refuse.
struct Builder {
    inner: DefaultProviderBuilder,
    fail: bool,
}

#[async_trait]
impl ProviderBuilder for Builder {
    async fn build(&self, name: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if self.fail {
            return Err("boom: the provider cannot be built".to_owned());
        }
        self.inner.build(name, config).await
    }
    async fn custom_key_ids(&self, name: &str) -> Result<Vec<String>, String> {
        self.inner.custom_key_ids(name).await
    }
    fn available(&self, name: &str) -> bool {
        !GATED.contains(&name)
    }
    async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
        self.inner.oauth_credentials_usable(name).await
    }
    async fn oauth_credential_state(&self, name: &str) -> Result<mixdog_ai::accounts::CredentialState, String> {
        self.inner.oauth_credential_state(name).await
    }
    async fn oauth_credential_expiry(&self, name: &str) -> Option<f64> {
        self.inner.oauth_credential_expiry(name).await
    }
    fn credential_inputs(&self) -> Vec<std::path::PathBuf> {
        self.inner.credential_inputs()
    }
}

struct NoCells;
impl LiveRoute for NoCells {
    fn route(&self, _: &ThreadId) -> Route {
        Route::new()
    }
    fn adopt_held(&self, _: &ThreadId, _: &Route) {}
}

/// A file written through the durability lane, as the tree's tests do.
fn put(path: &Path, body: &str) {
    use futures::FutureExt as _;
    use mixdog_rt::LaneToken as _;
    let (path, body) = (path.to_owned(), body.as_bytes().to_vec());
    tokio::task::unconstrained(
        mixdog_rt::testing::tokens()
            .durability_io
            .submit(&mixdog_rt::CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default()))
            .unwrap(),
    )
    .now_or_never()
    .expect("the test backend runs the job inline")
    .unwrap()
    .unwrap();
}

pub(super) struct Rig {
    pub(super) config: Config,
    pub(super) catalog: Arc<CatalogService>,
    pub(super) registry: Arc<ProviderRegistry>,
    pub(super) readiness: Arc<ProviderReadiness>,
    pub(super) effective: Arc<EffectiveProviders>,
    pub(super) loaded: Arc<LoadedConfig>,
    pub(super) service: Arc<ModelListService>,
    pub(super) host: ListHost,
    /// The fake provider endpoint, whose answers a test may swap.
    endpoint: Arc<Endpoint>,
    /// Closing it holds the endpoint's requests; `arrived` counts those held.
    pub(super) gate: tokio::sync::watch::Sender<bool>,
    pub(super) arrived: Arc<tokio::sync::Semaphore>,
    pub(super) hits: Arc<std::sync::atomic::AtomicUsize>,
    /// The keychain: closing the gate holds its reads, `vault_arrived` has one permit per read that reached it, and
    /// `secret_reads` counts them.
    pub(super) vault_gate: tokio::sync::watch::Sender<bool>,
    pub(super) vault_arrived: Arc<tokio::sync::Semaphore>,
    pub(super) secret_reads: Arc<std::sync::atomic::AtomicUsize>,
    /// The re-warms a settled startup refresh started, once [`Rig::bind_rewarm`] bound them.
    pub(super) rewarms: Arc<std::sync::atomic::AtomicUsize>,
    pub(super) _dir: tempfile::TempDir,
}

/// One recorded profile's pipeline; `fail` makes the provider builds refuse.
pub(super) async fn rig(scenario: &Value, seeds: &Value, fail: bool) -> Rig {
    rig_on(scenario, seeds, fail, None).await
}

/// [`rig`] whose catalog stamps retry times on `clock` instead of the wall clock.
pub(super) async fn rig_on(scenario: &Value, seeds: &Value, fail: bool, clock: Option<Arc<dyn Fn() -> u64 + Send + Sync>>) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    // The catalogs Node's daemon was seeded with (fresh, so no fetch is due).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    put(&dir.path().join("modelsdev-catalog.json"), &format!("{{\"fetchedAt\":{now},\"data\":{}}}\n", seeds["modelsDev"]));
    put(&dir.path().join("litellm-catalog.json"), &format!("{{\"fetchedAt\":{now},\"data\":{}}}\n", seeds["litellm"]));
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agent: Value = serde_json::from_str(&scenario["agent"].to_string().replace("__BASE_URL__", ENDPOINT)).unwrap();
    let stored = agent.as_object().cloned().unwrap();
    config
        .update_agent(move |doc| {
            doc.clear();
            doc.extend(stored);
            Ok(())
        })
        .await
        .unwrap();
    // The composition the daemon runs (`build_catalog`): models.dev, LiteLLM and the roster files of the data directory.
    let catalog = CatalogService::composed(CatalogSnapshot::default(), Vec::new(), Arc::new(Offline), dir.path().to_path_buf(), io()).await;
    let catalog = Arc::new(match clock {
        Some(clock) => catalog.with_clock(clock),
        None => catalog,
    });
    let listing = catalog.listing_lookup();
    // `__DATA_DIR__` in a value is this rig's data directory.
    let data_dir = dir.path().to_string_lossy().into_owned();
    let env_vars: HashMap<String, String> = scenario["env"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().replace("__DATA_DIR__", &data_dir))).collect())
        .unwrap_or_default();
    let env: Arc<dyn Environment> = Arc::new(Vars(env_vars));
    let (vault_gate, vault_gate_rx) = tokio::sync::watch::channel(true);
    let vault_arrived = Arc::new(tokio::sync::Semaphore::new(0));
    let secret_reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let vault = WatchedVault { inner: MemoryVault::default(), gate: vault_gate_rx, arrived: vault_arrived.clone(), reads: secret_reads.clone() };
    let keys = ApiKeyStore::new(Arc::new(vault), env.clone(), false);
    let accounts = AccountStore::new(dir.path().join("accounts"), io()).with_env(env.clone());
    let (gate, gate_rx) = tokio::sync::watch::channel(true);
    let arrived = Arc::new(tokio::sync::Semaphore::new(0));
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let endpoint = Arc::new(Endpoint {
        routes: std::sync::Mutex::new(scenario["stub"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()),
        gate: gate_rx,
        arrived: arrived.clone(),
        hits: hits.clone(),
        requests: tokio::sync::watch::channel(Vec::new()).0,
    });
    let link = Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap());
    let builder: Arc<dyn ProviderBuilder> = Arc::new(Builder {
        inner: DefaultProviderBuilder::new(BuilderEnv {
            http: endpoint.clone(),
            bidi: link,
            dial: Arc::new(KeepaliveDialer::new(KeepaliveSchedule::SPEC)),
            keys: keys.clone(),
            accounts,
            anthropic_caps: Arc::new(|_| None),
            google_traits: Arc::new(Traits),
            route_traits: Arc::new(|_| None),
            openai_facts: Arc::new(NoFacts),
            openai_context: Arc::new(SessionContext::new()),
            codex_identity: CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() },
            pace: Arc::new(SystemPace),
            gzip_lane: tokens.cpu_bulk,
            client_version: "1.0.0".into(),
            client_versions: None,
            grok_client_version: None,
            cursor_client_version: None,
            antigravity_client_version: "1.0.0".into(),
            listing,
            env: env.clone(),
            home_dir: dir.path().to_path_buf(),
            io: io(),
            gated_off: Arc::new(|name| GATED.contains(&name)),
            local: None,
        }),
        fail,
    });
    let registry = Arc::new(ProviderRegistry::new(builder.clone()));
    let readiness = ProviderReadiness::new(registry.clone(), catalog.clone());
    let effective = Arc::new(EffectiveProviders::new(builder, keys, env));
    let loaded = Arc::new(LoadedConfig::new(load_config(&config, &effective).await.unwrap()));
    let initial = loaded.get().get("providers").and_then(Value::as_object).cloned().unwrap();
    readiness.set_providers(initial.clone());
    let route: Arc<dyn Fn() -> Obj + Send + Sync> = {
        let loaded = loaded.clone();
        Arc::new(move || resolve_route(&loaded.get(), &Obj::new(), &|provider, _| KNOWN.contains(&provider)).unwrap_or_default())
    };
    let host = ListHost::new(readiness.clone(), effective.clone(), config.clone(), route.clone(), initial);
    let service = Arc::new(ModelListService {
        catalog: catalog.clone(),
        config: config.clone(),
        primary_provider: Arc::new(move || route().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned()),
        unsupported: Arc::new(UnsupportedEfforts::default()),
        host: Some(host.clone()),
    });
    let rewarms = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    Rig {
        config,
        catalog,
        registry,
        readiness,
        effective,
        loaded,
        service,
        host,
        endpoint,
        gate,
        arrived,
        hits,
        vault_gate,
        vault_arrived,
        secret_reads,
        rewarms,
        _dir: dir,
    }
}

impl Rig {
    /// Binds the re-warm as the daemon does (`compose_flip.rs`: the model list's secrets-carrying warm), counted.
    pub(super) fn bind_rewarm(&self) {
        let (service, rewarms) = (Arc::downgrade(&self.service), self.rewarms.clone());
        let bound = self.readiness.bind_rewarm(Arc::new(move || {
            rewarms.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(service) = service.upgrade() {
                service.warm_cache(true);
            }
        }));
        assert!(bound.is_ok(), "the re-warm is bound once");
    }

    /// Past the startup catalog refresh: it ran and settled, its completion included, a first load was adopted, and then the
    /// registry revision moved, so the next load lists every provider again at the endpoint (`sharedProviderCatalog` keys its
    /// answer by the revision), where a test can hold it. The endpoint arrivals so far are spent.
    pub(super) async fn past_startup_refresh(&self) {
        self.readiness.ensure_providers_ready(None).await.unwrap();
        self.readiness.settle_refreshes().await;
        self.service.rows(false, false).await.unwrap();
        self.readiness.invalidate_provider_caches(true);
        while let Ok(permit) = self.arrived.try_acquire() {
            permit.forget();
        }
    }

    /// From now on the endpoint answers `routes` (a recorded `serveCatalog` call): a provider's catalog moves on its own.
    pub(super) fn serve(&self, routes: &Value) {
        *self.endpoint.routes.lock().unwrap() = routes.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    }
}

pub(super) fn web_search(rig: &Rig) -> WebSearchModelsService {
    WebSearchModelsService::new(
        rig.catalog.clone(),
        rig.config.clone(),
        rig.service.clone(),
        WebSearchRoutes { cells: Arc::new(NoCells), main_route: Arc::new(|| json!({})), web_search_route: Arc::new(|| Value::Null) },
    )
}

#[tokio::test]
async fn a_custom_providers_discovered_models_list_with_the_configured_ones_and_without_the_hidden() {
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    let rows = rig.service.rows(false, false).await.unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    // `disc-b` is discovered and hidden by its override; `m1` is configured and not discovered.
    assert_eq!(ids, ["disc-a", "disc-c", "m1"]);
}

#[tokio::test]
async fn a_profile_with_no_enabled_provider_lists_nothing_and_registers_nothing() {
    let rig = rig(&defaults(), &seeds(), false).await;
    assert!(rig.service.rows(false, false).await.unwrap().is_empty());
    assert!(rig.registry.names().is_empty());
    assert_eq!(web_search(&rig).list(None, false).await.unwrap(), json!([]));
}

#[tokio::test]
async fn a_failed_provider_load_reaches_the_callers_as_the_error_of_the_load() {
    let scenario = json!({ "agent": { "providers": { "openai-oauth": { "enabled": true } } } });
    let rig = rig(&scenario, &seeds(), true).await;
    let error = rig.service.rows(false, false).await.unwrap_err();
    assert!(error.contains("boom"), "{error}");
    match web_search(&rig).list(None, true).await {
        Err(Failure::Error(message)) => assert!(message.contains("boom"), "{message}"),
        other => panic!("the web-search load must reject with the readiness failure: {other:?}"),
    }
}

#[tokio::test]
async fn the_sync_task_hands_each_config_change_to_the_readiness_and_the_loaded_config() {
    let rig = rig(&custom_manual(), &seeds(), false).await;
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    // A second provider is stored: the loaded config and the readiness' own config now hold it.
    rig.config
        .update_agent(|doc| {
            let mut providers = doc.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
            providers.insert(
                "custom-cccc".into(),
                json!({ "type": "custom", "schemaVersion": 2, "name": "Gamma", "protocol": "openai-chat", "baseURL": "http://127.0.0.1:9/v1", "auth": "none", "enabled": true, "modelOverrides": { "g1": { "manual": true } } }),
            );
            doc.insert("providers".into(), Value::Object(providers));
            Ok(())
        })
        .await
        .unwrap();
    sync.applied.wait_for(|applied| *applied >= 1).await.unwrap();
    assert!(rig.loaded.get()["providers"].get("custom-cccc").is_some(), "the loaded config follows the change");
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    let names = rig.registry.names();
    assert!(names.contains("custom-aaaa") && names.contains("custom-cccc"), "{names:?}");
    stop.cancel();
    sync.task.await.unwrap();
}

#[tokio::test]
async fn the_registered_providers_listings_are_the_catalogs_sources() {
    let rig = rig(&custom_manual(), &seeds(), false).await;
    rig.host.ensure_ready().await.unwrap();
    let outcome = rig.catalog.refresh().await;
    let refreshed: Vec<&str> = outcome.refreshed.iter().map(|p| p.as_str()).collect();
    assert_eq!(refreshed, ["custom-aaaa"]);
}

async fn warm_parked() -> Rig {
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    rig.past_startup_refresh().await;
    rig.gate.send_replace(false);
    rig.service.rows(false, true).await.unwrap();
    rig.arrived.acquire().await.unwrap().forget();
    rig
}

async fn finish(rig: &Rig) -> bool {
    rig.gate.send_replace(true);
    rig.host.settle_warm().await;
    rig.service.cache_loaded()
}

#[tokio::test]
async fn a_warm_load_overtaken_by_an_invalidation_does_not_fill_the_new_cache() {
    let rig = warm_parked().await;
    rig.service.invalidate();
    assert!(!finish(&rig).await);
}

#[tokio::test]
async fn a_warm_load_overtaken_by_a_registry_revision_change_does_not_fill_the_cache() {
    // No invalidation hook is bound: only the revision moves (`model-meta.mjs` `syncCatalogRevision`, run before the sequence check).
    let rig = warm_parked().await;
    rig.readiness.invalidate_provider_caches(true);
    assert!(!finish(&rig).await);
}

// The path an outside caller takes to register a provider: `ensure_providers_ready` with a config naming one more.
#[tokio::test]
async fn a_warm_load_overtaken_by_an_outside_registration_does_not_fill_the_cache() {
    let rig = warm_parked().await;
    let mut providers = rig.loaded.get()["providers"].as_object().cloned().unwrap();
    let mut second = providers["custom-dddd"].clone();
    second["name"] = json!("Echo");
    providers.insert("custom-eeee".into(), second);
    let before = rig.readiness.catalog_revision();
    rig.readiness.ensure_providers_ready(Some(providers)).await.unwrap();
    assert!(rig.readiness.catalog_revision() > before, "the registration moved the registry revision");
    assert!(!finish(&rig).await);
}

/// After a partial load with one provider failing, a read made once that provider's retry time passed asks it again exactly
/// once however many readers find it so, answers without waiting for that listing, and hands out a retry time ahead of now.
#[tokio::test]
async fn a_read_past_a_failed_providers_retry_time_asks_it_once_without_waiting() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let scenario = json!({
        "agent": {
            "providers": {
                "custom-dddd": { "type": "custom", "schemaVersion": 2, "name": "Delta", "protocol": "openai-chat", "baseURL": "__BASE_URL__/c/v1", "auth": "none", "enabled": true },
                "custom-bbbb": { "type": "custom", "schemaVersion": 2, "name": "Bravo", "protocol": "openai-chat", "baseURL": "__BASE_URL__/b/v1", "auth": "none", "enabled": true }
            },
            "presets": [{ "id": "d1", "name": "D1", "provider": "custom-dddd", "model": "disc-a" }],
            "default": "d1"
        },
        "stub": {
            "/c/v1/models": { "object": "list", "data": [{ "id": "disc-a", "object": "model", "owned_by": "fixture" }] },
            "/b/v1/models": { "__status": 503 }
        }
    });
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let now = clock.clone();
    let rig = rig_on(&scenario, &seeds(), false, Some(Arc::new(move || now.load(Ordering::SeqCst)))).await;
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    rig.readiness.settle_refreshes().await;
    rig.service.rows(false, false).await.unwrap();
    rig.service.rows(false, false).await.unwrap();
    assert!(rig.service.cache_loaded(), "the partial answer is adopted");
    let failing = mixdog_protocol::ProviderId::from("custom-bbbb");
    assert!(matches!(rig.catalog.snapshot().status.get(&failing), Some(mixdog_ai::catalog::ProviderStatus::Missing { .. })));
    while let Ok(permit) = rig.arrived.try_acquire() {
        permit.forget();
    }

    let at = clock.fetch_add(mixdog_ai::catalog::RETRY_AFTER_MS, Ordering::SeqCst) + mixdog_ai::catalog::RETRY_AFTER_MS;
    rig.gate.send_replace(false);
    let reads = futures::future::join(rig.service.rows(false, false), rig.service.rows(false, false));
    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(10), reads).await.expect("a read waited for the held listing");
    let third = rig.service.rows(false, false).await.unwrap();
    for rows in [first.unwrap(), second.unwrap(), third] {
        assert!(!rows.is_empty());
        for row in &rows {
            assert!(row["catalogRetryAt"].as_f64().is_some_and(|retry_at| retry_at > at as f64), "{row}");
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), rig.arrived.acquire()).await.expect("the provider was not asked again").unwrap().forget();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(rig.arrived.try_acquire().is_err(), "the provider was asked more than once");
    let asked = rig.endpoint.requests.borrow().last().map(|request| request["url"].clone());
    assert_eq!(asked, Some(json!("__BASE_URL__/b/v1/models")));
    rig.gate.send_replace(true);
}

#[tokio::test]
async fn an_undisturbed_warm_load_fills_the_cache() {
    let rig = warm_parked().await;
    assert!(finish(&rig).await);
}
