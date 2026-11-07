//! The model lists against the Node recording (`fixtures/model-lists/node-model-lists.json`,
//! `benchmarks/rust-core/recorders/model-lists/record.mjs`): Node's real `listProviderModels` (the quick
//! read of a cold cache, then the full read) and `listWebSearchModels` for four profiles, each in an
//! isolated daemon. The Rust side is the production pipeline over a registry whose providers are fake
//! adapters behind the real `ModelSource::of_adapter`: config load, provider defaults, readiness, source
//! hand-over, catalog, quick rows, hydration and sort. Every row, in order, must be Node's.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::CredentialState;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource, ProviderReadiness};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::custom::listing::manual_rows;
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, MemoryVault};
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::service::admin_route::{Obj, resolve_route};
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{Config, ConfigLanes};
use mixdog_core_ports::ports::route::{LiveRoute, Route};
use mixdog_protocol::ProviderId;
use serde_json::{Value, json};

use super::model_list::{ListHost, ModelListService};
use super::model_list_tests::Offline;
use super::provider_sync::spawn_provider_sync;
use super::web_search_models::{WebSearchModelsService, WebSearchRoutes};
use crate::domains::ai_account::collaborators::WebSearchModels;
use crate::domains::ai_account::custom_config::normalize;
use crate::domains::ai_account::failure::Failure;

/// The Node recording; its custom providers' `baseURL` is the recorder's loopback stub.
fn recording() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/model-lists/node-model-lists.json")).unwrap()
}

/// The providers a profile can name that Node's route resolution knows.
const KNOWN: [&str; 3] = ["custom-aaaa", "custom-bbbb", "anthropic-oauth"];

/// A builder whose adapters are `MockProvider`s listing what a custom provider lists when its
/// discovery answers nothing: its configured (manual) models under their overrides. `fail` makes
/// every build refuse.
struct FakeBuilder {
    fail: bool,
}

#[async_trait]
impl ProviderBuilder for FakeBuilder {
    async fn build(&self, name: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if self.fail {
            return Err("boom: the provider cannot be built".to_owned());
        }
        let mut provider = MockProvider::new([]);
        provider.id = ProviderId::from(name);
        if config.get("type").and_then(Value::as_str) == Some("custom") {
            provider.models = manual_rows(&normalize(config)?);
        }
        Ok(Arc::new(provider))
    }

    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    fn available(&self, name: &str) -> bool {
        !["mimo-oauth", "cursor-oauth", "devin-oauth", "antigravity-oauth"].contains(&name)
    }

    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }

    async fn oauth_credential_state(&self, _: &str) -> Result<CredentialState, String> {
        Ok(CredentialState::Absent)
    }
}

struct NoEnv;
impl Environment for NoEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

struct NoCells;
impl LiveRoute for NoCells {
    fn route(&self, _: &ThreadId) -> Route {
        Route::new()
    }
    fn adopt_held(&self, _: &ThreadId, _: &Route) {}
}

struct Rig {
    config: Config,
    catalog: Arc<CatalogService>,
    registry: Arc<ProviderRegistry>,
    readiness: Arc<ProviderReadiness>,
    effective: Arc<EffectiveProviders>,
    service: Arc<ModelListService>,
    host: ListHost,
    _dir: tempfile::TempDir,
}

/// The profile `agent` as the stored section of a fresh config, and the production pipeline over it.
async fn rig(agent: &Value, fail: bool) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let stored = agent.as_object().cloned().unwrap();
    config
        .update_agent(move |doc| {
            doc.clear();
            doc.extend(stored);
            Ok(())
        })
        .await
        .unwrap();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
    let builder: Arc<dyn ProviderBuilder> = Arc::new(FakeBuilder { fail });
    let registry = Arc::new(ProviderRegistry::new(builder.clone()));
    let readiness = ProviderReadiness::new(registry.clone(), catalog.clone());
    let env: Arc<dyn Environment> = Arc::new(NoEnv);
    let effective = Arc::new(EffectiveProviders::new(builder, ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false), env));
    let initial = effective.load(&config.loaded_agent().await.unwrap(), true).await.unwrap();
    readiness.set_providers(initial.clone());
    let route = {
        let config = config.clone();
        Arc::new(move || resolve_route(&config.agent(), &Obj::new(), &|provider, _| KNOWN.contains(&provider)).unwrap_or_default())
    };
    let host = ListHost::new(readiness.clone(), effective.clone(), config.clone(), route.clone(), initial);
    let service = Arc::new(ModelListService {
        catalog: catalog.clone(),
        config: config.clone(),
        primary_provider: Arc::new(move || route().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned()),
        unsupported: Arc::new(UnsupportedEfforts::default()),
        host: Some(host.clone()),
    });
    Rig { config, catalog, registry, readiness, effective, service, host, _dir: dir }
}

/// Node's profile with the recorder's stub address replaced by a valid, unused one.
fn agent_of(scenario: &Value) -> Value {
    serde_json::from_str(&scenario["agent"].to_string().replace("__BASE_URL__", "http://127.0.0.1:9/v1")).unwrap()
}

fn node_calls(scenario: &Value) -> [&Value; 3] {
    let calls = scenario["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 3, "{}: quick, full and web-search reads", scenario["name"]);
    [&calls[0]["value"], &calls[1]["value"], &calls[2]["value"]]
}

fn assert_rows(what: &str, got: &[Value], want: &Value) {
    let want = want.as_array().unwrap_or_else(|| panic!("{what}: Node recorded no list"));
    let ids = |rows: &[Value]| rows.iter().map(|r| format!("{}:{}", r["provider"], r["id"])).collect::<Vec<_>>();
    assert_eq!(ids(got), ids(want), "{what}: rows in order");
    for (row, node) in got.iter().zip(want) {
        assert_eq!(row, node, "{what}: {}:{}", node["provider"], node["id"]);
    }
}

fn web_search(rig: &Rig) -> WebSearchModelsService {
    WebSearchModelsService::new(
        rig.catalog.clone(),
        rig.config.clone(),
        rig.service.clone(),
        WebSearchRoutes {
            cells: Arc::new(NoCells),
            main_route: Arc::new(|| json!({})),
            web_search_route: Arc::new(|| Value::Null),
        },
    )
}

#[tokio::test]
async fn the_quick_rows_are_nodes_for_every_profile() {
    let recording = recording();
    for scenario in recording["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let rig = rig(&agent_of(scenario), false).await;
        let rows = rig.service.rows(false, true).await.unwrap();
        assert_rows(&format!("{name}: quick"), &rows, node_calls(scenario)[0]);
        rig.host.settle_warm().await;
    }
}

#[tokio::test]
async fn the_full_and_web_search_reads_are_nodes_after_the_registry_hands_over_its_sources() {
    let recording = recording();
    for scenario in recording["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let [_, full, search] = node_calls(scenario);
        let rig = rig(&agent_of(scenario), false).await;
        // Node's read order: the quick read first, which warms the catalog, then the full read.
        rig.service.rows(false, true).await.unwrap();
        rig.host.settle_warm().await;
        let rows = rig.service.rows(false, false).await.unwrap();
        assert_rows(&format!("{name}: full"), &rows, full);
        let enabled_custom = rig.registry.names().iter().any(|n| n.starts_with("custom-"));
        let listed: Vec<String> = rig.catalog.snapshot().models.iter().map(|(p, _)| p.as_str().to_owned()).collect();
        assert_eq!(listed.iter().any(|p| p.starts_with("custom-")), enabled_custom, "{name}: the registered custom provider is a catalog source");
        let listed = web_search(&rig).list(None, false).await.unwrap();
        assert_rows(&format!("{name}: web search"), listed.as_array().unwrap(), search);
    }
}

#[tokio::test]
async fn a_profile_with_no_enabled_provider_lists_nothing_and_registers_nothing() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "defaults").unwrap();
    let rig = rig(&agent_of(scenario), false).await;
    assert!(rig.service.rows(false, false).await.unwrap().is_empty());
    assert!(rig.registry.names().is_empty());
    // The web-search load awaits readiness outside any `try`, but it only asks for it when a search
    // provider is enabled.
    assert_eq!(web_search(&rig).list(None, false).await.unwrap(), json!([]));
}

#[tokio::test]
async fn a_failed_provider_load_reaches_the_callers_as_node_rejects_it() {
    let agent = json!({ "providers": { "openai-oauth": { "enabled": true } } });
    let rig = rig(&agent, true).await;
    let error = rig.service.rows(false, false).await.unwrap_err();
    assert!(error.contains("boom"), "{error}");
    match web_search(&rig).list(None, true).await {
        Err(Failure::Error(message)) => assert!(message.contains("boom"), "{message}"),
        other => panic!("the web-search load must reject with the readiness failure: {other:?}"),
    }
}

#[tokio::test]
async fn the_sync_task_hands_each_config_change_to_the_readiness() {
    let agent = json!({ "providers": { "custom-aaaa": { "type": "custom", "schemaVersion": 2, "name": "Alpha", "protocol": "openai-chat", "baseURL": "http://127.0.0.1:9/v1", "auth": "none", "enabled": true, "modelOverrides": { "m1": { "manual": true } } } } });
    let rig = rig(&agent, false).await;
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), stop.clone());
    // A second provider is stored: the readiness, asked for its own config, now starts both.
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
    let rig = rig(&agent_of(scenario), false).await;
    rig.host.ensure_ready().await.unwrap();
    let outcome = rig.catalog.refresh().await;
    let refreshed: Vec<&str> = outcome.refreshed.iter().map(|p| p.as_str()).collect();
    assert_eq!(refreshed, ["custom-aaaa"]);
}