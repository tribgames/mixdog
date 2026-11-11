//! The model lists against the Node recording (`fixtures/model-lists/node-model-lists.json`,
//! `benchmarks/rust-core/recorders/model-lists/record.mjs`): Node's real `listProviderModels` (the quick
//! read of a cold cache, then the full read) and `listWebSearchModels` for ten profiles, each in an isolated
//! daemon whose model endpoints are a local fake and whose models.dev / LiteLLM catalogs are seeded.
//!
//! The Rust side is the production pipeline over the same profile and the same fake endpoint: config load,
//! provider defaults, the real `DefaultProviderBuilder` (the Anthropic and custom-provider adapters list
//! through a fake `HttpSend` that serves the recording's endpoint bodies), readiness, the registry's
//! adapters handed to the catalog through `ModelSource::of_adapter`, quick rows, hydration, sort and the
//! web-search tiers. Every row, in order, must be Node's.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ListingLookup, ProviderReadiness};
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

/// The Node recording; a profile's `baseURL`s name the recorder's loopback endpoint.
pub(super) fn recording() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/model-lists/node-model-lists.json")).unwrap()
}

/// Node's recording of a default route naming an OAuth provider (model-lists-statusline): the reads after its statusline-usage warm-up, and the reads before it (the warm-up delayed).
pub(super) fn statusline_recording() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/model-lists-statusline/node-model-lists.json")).unwrap()
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
    /// The production builder the registry and the loaded config read the credentials through.
    pub(super) builder: Arc<dyn ProviderBuilder>,
    /// The account store that builder holds (the same files).
    pub(super) accounts: AccountStore,
    pub(super) env: Arc<dyn Environment>,
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

/// [`rig`] whose catalog stamps retry times with `clock` (milliseconds since the epoch) instead of the wall clock.
pub(super) async fn rig_on(scenario: &Value, seeds: &Value, fail: bool, clock: Option<Arc<dyn Fn() -> u64 + Send + Sync>>) -> Rig {
    rig_paced(scenario, seeds, fail, clock, None).await
}

/// [`rig_on`] whose account store reads credential expiry on `pace`'s clock (the wall clock without one).
pub(super) async fn rig_paced(
    scenario: &Value,
    seeds: &Value,
    fail: bool,
    clock: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
    pace: Option<Arc<dyn mixdog_ai::oauth::Pace>>,
) -> Rig {
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
    let listing = ListingLookup::new();
    // The composition the daemon runs (`build_catalog`): models.dev, LiteLLM and the roster files of the data directory.
    let composed = CatalogService::composed(CatalogSnapshot::default(), Vec::new(), Arc::new(Offline), dir.path().to_path_buf(), io()).await;
    let composed = match clock {
        Some(clock) => composed.with_clock(clock),
        None => composed,
    };
    let catalog = Arc::new(composed.with_listing_lookup(listing.clone()));
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
    let accounts = match pace {
        Some(pace) => accounts.with_clock(pace),
        None => accounts,
    };
    let (rig_accounts, rig_env) = (accounts.clone(), env.clone());
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
        }),
        fail,
    });
    let rig_builder = builder.clone();
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
    Rig { config, catalog, registry, readiness, effective, builder: rig_builder, accounts: rig_accounts, env: rig_env, loaded, service, host, endpoint, gate, arrived, hits, vault_gate, vault_arrived, secret_reads, rewarms, _dir: dir }
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

    /// The endpoint's request log.
    pub(super) fn requests(&self) -> tokio::sync::watch::Receiver<Vec<Value>> {
        self.endpoint.requests.subscribe()
    }

    /// From now on the endpoint answers `routes` (a recorded `serveCatalog` call): a provider's catalog moves on its own.
    pub(super) fn serve(&self, routes: &Value) {
        *self.endpoint.routes.lock().unwrap() = routes.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    }
}

/// A recorded profile read quick, full and web-search with nothing between the reads (no stored change, no warm-up).
pub(super) fn three_reads(scenario: &Value) -> bool {
    let actions = scenario["calls"].as_array().unwrap().iter().map(|c| c["action"].as_str().unwrap());
    actions.eq(["listProviderModels", "listProviderModels", "listWebSearchModels"])
}

pub(super) fn node_calls(scenario: &Value) -> [&Value; 3] {
    let calls = scenario["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 3, "{}: quick, full and web-search reads", scenario["name"]);
    [&calls[0]["value"], &calls[1]["value"], &calls[2]["value"]]
}

pub(super) fn assert_rows(what: &str, got: &[Value], want: &Value) {
    let want = want.as_array().unwrap_or_else(|| panic!("{what}: Node recorded no list"));
    let ids = |rows: &[Value]| rows.iter().map(|r| format!("{}:{}", r["provider"], r["id"])).collect::<Vec<_>>();
    assert_eq!(ids(got), ids(want), "{what}: rows in order");
    for (row, node) in got.iter().zip(want) {
        assert_eq!(row, node, "{what}: {}:{}", node["provider"], node["id"]);
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
async fn the_quick_rows_are_nodes_for_every_profile() {
    let recording = recording();
    for scenario in recording["scenarios"].as_array().unwrap().iter().filter(|s| three_reads(s)) {
        let name = scenario["name"].as_str().unwrap();
        let rig = rig(scenario, &recording["seeds"], false).await;
        // A row marked `catalogComplete` means Node's daemon had finished its boot load before this first read
        // (a provider with no key fails its listing at once and answers its floor): the catalog is loaded here too.
        if node_calls(scenario)[0].get(0).is_some_and(|row| row["catalogComplete"] == true) {
            rig.service.rows(false, false).await.unwrap();
        }
        let rows = rig.service.rows(false, true).await.unwrap();
        assert_rows(&format!("{name}: quick"), &rows, node_calls(scenario)[0]);
        rig.host.settle_warm().await;
    }
}

#[tokio::test]
async fn the_full_and_web_search_reads_are_nodes_after_the_registry_hands_over_its_sources() {
    let recording = recording();
    let mut searched = 0;
    for scenario in recording["scenarios"].as_array().unwrap().iter().filter(|s| three_reads(s)) {
        let name = scenario["name"].as_str().unwrap();
        let [_, full, search] = node_calls(scenario);
        let rig = rig(scenario, &recording["seeds"], false).await;
        // Node's read order: the quick read first, which warms the catalog, then the full read.
        rig.service.rows(false, true).await.unwrap();
        rig.host.settle_warm().await;
        let rows = rig.service.rows(false, false).await.unwrap();
        assert_rows(&format!("{name}: full"), &rows, full);
        let registered = rig.registry.names();
        let listed: Vec<String> = rig.catalog.snapshot().models.iter().map(|(p, _)| p.as_str().to_owned()).collect();
        assert_eq!(listed.iter().all(|p| registered.contains(p)), true, "{name}: every catalog source is a registered provider");
        assert_eq!(registered.iter().all(|p| listed.contains(p)), true, "{name}: every registered provider is a catalog source");
        let found = web_search(&rig).list(None, false).await.unwrap();
        assert_rows(&format!("{name}: web search"), found.as_array().unwrap(), search);
        searched += search.as_array().unwrap().len();
    }
    assert!(searched > 0, "a recorded profile has a non-empty web-search list");
}

#[tokio::test]
async fn a_custom_providers_discovered_models_list_as_node_lists_them() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-discovery").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    let rows = rig.service.rows(false, false).await.unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    // `disc-b` is discovered and hidden by its override; `m1` is configured and not discovered.
    assert_eq!(ids, ["disc-a", "disc-c", "m1"]);
    assert_rows("custom-discovery: full", &rows, node_calls(scenario)[1]);
}

// Node's `custom-discovery-update` recording: quick, full, `updateCustomProviderModel` (hides `disc-a`, which ends in
// `invalidateProviderCaches`), quick, full. The cold quick read answers from the profile, the full read loads the
// catalog, and the quick read after the change is cold again: the cache and the shared catalog were dropped.
#[tokio::test]
async fn a_quick_read_after_a_provider_change_answers_as_node_does() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-discovery-update").unwrap();
    let calls = scenario["calls"].as_array().unwrap();
    assert_eq!(calls.iter().map(|c| c["action"].as_str().unwrap()).collect::<Vec<_>>(), ["listProviderModels", "listProviderModels", "updateCustomProviderModel", "listProviderModels", "listProviderModels"]);
    let rig = rig(scenario, &recording["seeds"], false).await;
    // The hook the daemon binds (`compose_flip.rs`): the model list drops its cache with the readiness' invalidation.
    let service = rig.service.clone();
    rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok().then_some(()).unwrap();
    let read = |quick| rig.service.rows(false, quick);
    assert_rows("quick", &read(true).await.unwrap(), &calls[0]["value"]);
    rig.host.settle_warm().await;
    assert_rows("full", &read(false).await.unwrap(), &calls[1]["value"]);
    // Loaded: a quick read is the loaded catalog, marked complete (what the cold read could not say).
    assert!(read(true).await.unwrap().iter().all(|row| row["catalogComplete"] == json!(true)));
    // The daemon\'s sync follows a stored change into the loaded config and the readiness.
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let [provider, model, patch] = [0, 1, 2].map(|i| calls[2]["args"][i].clone());
    rig.config
        .update_agent(move |doc| {
            let mut providers = doc.get("providers").and_then(Value::as_object).cloned().unwrap();
            let entry = providers.get_mut(provider.as_str().unwrap()).unwrap();
            entry["modelOverrides"][model.as_str().unwrap()]["hidden"] = patch["hidden"].clone();
            doc.insert("providers".into(), Value::Object(providers));
            Ok(())
        })
        .await
        .unwrap();
    sync.applied.wait_for(|applied| *applied >= 1).await.unwrap();
    // `refresh.afterCredentialChange()`: `applyConfigChange` rebuilds the registered provider over the stored change,
    // then `invalidateProviderCaches` drops every cache.
    let record = rig.loaded.get()["providers"].as_object().cloned().unwrap();
    rig.registry.sync_providers(&record, None).await.unwrap();
    rig.readiness.reinit_providers().await.unwrap();
    assert_rows("quick after the change", &read(true).await.unwrap(), &calls[3]["value"]);
    rig.host.settle_warm().await;
    assert_rows("full after the change", &read(false).await.unwrap(), &calls[4]["value"]);
    stop.cancel();
    sync.task.await.unwrap();
}

#[tokio::test]
async fn a_profile_with_no_enabled_provider_lists_nothing_and_registers_nothing() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "defaults").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    assert!(rig.service.rows(false, false).await.unwrap().is_empty());
    assert!(rig.registry.names().is_empty());
    assert_eq!(web_search(&rig).list(None, false).await.unwrap(), json!([]));
}

#[tokio::test]
async fn a_failed_provider_load_reaches_the_callers_as_node_rejects_it() {
    let recording = recording();
    let scenario = json!({ "agent": { "providers": { "openai-oauth": { "enabled": true } } } });
    let rig = rig(&scenario, &recording["seeds"], true).await;
    let error = rig.service.rows(false, false).await.unwrap_err();
    assert!(error.contains("boom"), "{error}");
    match web_search(&rig).list(None, true).await {
        Err(Failure::Error(message)) => assert!(message.contains("boom"), "{message}"),
        other => panic!("the web-search load must reject with the readiness failure: {other:?}"),
    }
}

#[tokio::test]
async fn the_sync_task_hands_each_config_change_to_the_readiness_and_the_loaded_config() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-manual").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
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
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-manual").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    rig.host.ensure_ready().await.unwrap();
    let outcome = rig.catalog.refresh().await;
    let refreshed: Vec<&str> = outcome.refreshed.iter().map(|p| p.as_str()).collect();
    assert_eq!(refreshed, ["custom-aaaa"]);
}

// A quick read starts the warm load; the endpoint holds it between its preparation and `adopt` while something else
// moves the cache's state, so the order is the test's, not the scheduler's. The load that listed under the old state must
// not fill the new one. The gate is closed before the quick read and opened by `finish`; the startup catalog refresh is past
// (a load joins it during its preparation, where the gate would hold the refresh instead).
async fn warm_parked() -> Rig {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-discovery").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
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

#[tokio::test]
async fn an_undisturbed_warm_load_fills_the_cache() {
    let rig = warm_parked().await;
    assert!(finish(&rig).await);
}
