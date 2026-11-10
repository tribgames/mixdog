//! `model/list` against the Node recording (`fixtures/ai-admin/model-list-service-twin.json`,
//! `benchmarks/rust-core/recorders/record-model-list-service.mjs`): Node's real
//! `collectProviderModels` over scripted providers, and the same models as the catalog snapshot
//! the Rust service reads. Every row, in order, must be Node's.

#![allow(clippy::disallowed_methods, reason = "test setup: writes the catalog cache files on the test thread")]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogSnapshot, ModelSource, ModelsDevSource};
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use super::model_list::{ListHost, ModelListService};
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, MemoryVault};
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/model-list-service-twin.json")).unwrap()
}

pub(super) struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(
        &self,
        _: WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(
            ErrorKind::Transient,
            DeliveryState::NotSent,
        ))
    }
}

#[tokio::test]
async fn model_list_matches_node() {
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let snapshot: CatalogSnapshot = serde_json::from_value(case["snapshot"].clone()).unwrap();
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(snapshot, Vec::new(), metadata).await);
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["config"] })).unwrap()).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let route = case["route"].as_str().unwrap().to_owned();
        let service = ModelListService {
            catalog,
            config,
            primary_provider: Arc::new(move || route.clone()),
            unsupported: Arc::new(UnsupportedEfforts::default()),
            host: None,
        };
        let (force, quick) = match case["read"].as_str().unwrap() {
            "force" => (true, false),
            "warm-quick" => (false, true),
            _ => (false, false),
        };
        let got = service.rows(force, quick).await.unwrap();
        let want = case["value"].as_array().unwrap();
        let label = format!("case {i} ({})", case["read"]);
        assert_eq!(got.len(), want.len(), "{label}: row count");
        for (n, (got, want)) in got.iter().zip(want).enumerate() {
            assert_eq!(got, want, "{label}: row {n} {}", want["id"]);
        }
    }
}

struct Listed(Vec<mixdog_core_api::domain::provider::ModelRecord>);

#[async_trait]
impl mixdog_core_api::domain::provider::ModelListing for Listed {
    async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
        Ok(self.0.clone())
    }
}

/// The service over a snapshot the providers' own listing code produced (`codex_record`): the
/// facts the picker rows read are the record's, not a recorded input.
#[tokio::test]
async fn a_snapshot_the_provider_listing_produced_reaches_the_rows() {
    let rows = [
        json!({ "slug": "gpt-5-codex", "display_name": "GPT 5.4", "description": "d54", "default_service_tier": "priority",
                "supports_reasoning_effort_updates": false, "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "high" }] }),
        json!({ "slug": "gpt-6-mini", "display_name": "GPT 5.5" }),
    ];
    let records: Vec<_> = rows.iter().map(|row| mixdog_ai::providers::openai::models::codex_record(row).unwrap()).collect();
    let source = ModelSource::new(serde_json::from_value(json!("openai-oauth")).unwrap(), Arc::new(Listed(records)));
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), vec![source], metadata).await);
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let service = ModelListService {
        catalog,
        config,
        primary_provider: Arc::new(|| "openai-oauth".to_owned()),
        unsupported: Arc::new(UnsupportedEfforts::default()),
            host: None,
    };
    let rows = service.rows(false, false).await.unwrap();
    let row = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("{id} in {rows:?}"));
    let (stated, silent) = (row("gpt-5-codex"), row("gpt-6-mini"));
    assert_eq!(stated["display"], "GPT 5.4");
    assert_eq!(stated["description"], "d54");
    assert_eq!(stated["tier"], "version");
    assert_eq!(stated["defaultServiceTier"], "priority");
    // The catalog says this model takes no mid-conversation effort update; the version rule
    // alone would have allowed it.
    assert_eq!(stated["autoEffortCapable"], json!(false));
    assert_eq!(silent["autoEffortCapable"], json!(true));
}

/// A provider of the recorded scenario: its `getCachedModelInfo` rows.
struct CachedRows(Vec<Arc<Value>>);

impl mixdog_ai::catalog::CachedModelInfo for CachedRows {
    fn cached_row(&self, model: &str) -> Option<Arc<Value>> {
        self.0.iter().find(|row| row["id"] == model).cloned()
    }
}

struct NeverListed;

#[async_trait]
impl mixdog_ai::catalog::ListedRows for NeverListed {
    async fn list_rows(&self) -> Result<Vec<Arc<Value>>, ()> {
        Err(())
    }
}

/// The listing of a recorded load scenario: its rows as the provider's typed records, and, when the scenario says so,
/// an invalidation (`invalidateProviderCaches`) taken inside `listModels()`.
struct LoadListing {
    rows: Vec<Value>,
    host: std::sync::OnceLock<ListHost>,
    invalidate_while_listing: bool,
}

#[async_trait]
impl mixdog_core_api::domain::provider::ModelListing for LoadListing {
    async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
        if self.invalidate_while_listing {
            self.host.get().expect("the host is set before the load").invalidate();
        }
        Ok(self
            .rows
            .iter()
            .map(|row| {
                let mut record = mixdog_core_api::domain::provider::ModelRecord::new(row["id"].as_str().unwrap());
                record.display_name = row["display"].as_str().map(str::to_owned);
                record.hidden = row["hidden"] == true;
                record.manual = row["manual"] == true;
                record.mode = row["mode"].as_str().map(str::to_owned);
                record
            })
            .collect())
    }
}

struct NoBuilds;

#[async_trait]
impl ProviderBuilder for NoBuilds {
    async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err("no provider is built in this test".into())
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// A builder whose providers are mocks: the registry prepares them as production does.
struct BuildsMock;

#[async_trait]
impl ProviderBuilder for BuildsMock {
    async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Ok(Arc::new(mixdog_core_api::domain::mock::MockProvider::new([])))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

struct NoEnv;
impl Environment for NoEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

/// Both full-load scenarios Node recorded (`oracles/model-meta.json`, from `7f633e730`, by
/// `record-model-meta.mjs`): a load remembers the rows of `rowsForEntry` only (empty ids and non-selectable models are
/// left out, a hidden selectable model is kept and leaves only the picker) over what a lookup had pinned, a model the
/// load skipped keeps answering its provider's cached row, and a load an invalidation overtook (the load sequence moved
/// during `listModels()`) remembers nothing. Every lookup is compared as the whole JSON object Node answered.
#[tokio::test]
async fn a_load_remembers_what_node_recorded() {
    let golden: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/providers/oracles/model-meta.json")).unwrap();
    let mut replayed = 0;
    for scenario in golden["scenarios"].as_array().unwrap() {
        if !scenario["ops"].as_array().unwrap().iter().any(|op| op["op"] == "load") {
            continue;
        }
        let name = scenario["name"].as_str().unwrap();
        let spec = &scenario["providers"]["p"];
        let listing = Arc::new(LoadListing {
            rows: spec["listRows"].as_array().unwrap().clone(),
            host: std::sync::OnceLock::new(),
            invalidate_while_listing: spec["duringList"] == "invalidate",
        });
        let source = ModelSource::new("p".into(), listing.clone());
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), vec![source], metadata).await);
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let builder: Arc<dyn ProviderBuilder> = Arc::new(NoBuilds);
        let readiness = ProviderReadiness::new(Arc::new(ProviderRegistry::new(builder.clone())), catalog.clone());
        let env: Arc<dyn Environment> = Arc::new(NoEnv);
        let keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false);
        let effective = Arc::new(EffectiveProviders::new(builder, keys, env));
        let host = ListHost::new(readiness, effective, config.clone(), Arc::new(Obj::new), serde_json::Map::new());
        assert!(listing.host.set(host.clone()).is_ok());
        let cached: Option<Vec<Arc<Value>>> = spec["cached"].as_array().map(|rows| rows.iter().cloned().map(Arc::new).collect());
        catalog.bind_providers(Arc::new(move |provider| {
            (provider == "p").then(|| mixdog_ai::catalog::RouteProvider {
                cached: cached.clone().map(|rows| Arc::new(CachedRows(rows)) as Arc<dyn mixdog_ai::catalog::CachedModelInfo>),
                listing: Some(Arc::new(NeverListed)),
            })
        }));
        let service = ModelListService {
            catalog: catalog.clone(),
            config,
            primary_provider: Arc::new(|| "p".to_owned()),
            unsupported: Arc::new(UnsupportedEfforts::default()),
            host: Some(host),
        };
        for op in scenario["ops"].as_array().unwrap() {
            let what = format!("{name}: {op}");
            match op["op"].as_str().unwrap() {
                "lookup" => {
                    let got = catalog.model_meta(op["provider"].as_str().unwrap(), op["model"].as_str().unwrap());
                    assert_eq!(got, op["expect"], "{what}");
                }
                "load" => {
                    service.ready(false, None).await;
                    // The catalog keeps each provider's rows sorted by id; the picker sorts them at read anyway.
                    let by_id = |mut rows: Vec<Value>| {
                        rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
                        rows
                    };
                    let picker: Vec<Value> = service
                        .cache_rows(&catalog.snapshot())
                        .iter()
                        .map(|row| json!({ "provider": row["provider"], "id": row["id"] }))
                        .collect();
                    assert_eq!(by_id(picker), by_id(op["expect"].as_array().unwrap().clone()), "{what}: the rows the load hands the picker");
                }
                other => panic!("{other}"),
            }
        }
        replayed += 1;
    }
    assert_eq!(replayed, 2, "both scenarios with a full load");
}

/// The gates of a runtime that is up and idle.
struct IdleGates;

impl super::model_warmup::WarmupGates for IdleGates {
    fn busy(&self) -> Option<&'static str> {
        None
    }
    fn closing(&self) -> bool {
        false
    }
    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(std::future::pending())
    }
    fn profile(&self, _: &str, _: &str) {}
}

/// A non-fetching miss schedules the provider-model warm-up (`scheduleProviderModelWarmup()`, `model-meta.mjs:67`, which
/// is `provider-warmups.mjs`'s warm: here `ModelWarmup`): the load it starts remembers the listed rows, which replace the
/// cold placeholder (`remember`). The registry builds the mock provider, which lists `mock-model` and caches no row.
#[tokio::test]
async fn a_cold_placeholder_schedules_the_load_that_replaces_it() {
    let listing = Arc::new(LoadListing { rows: Vec::new(), host: std::sync::OnceLock::new(), invalidate_while_listing: false });
    let source = ModelSource::new("p".into(), listing.clone());
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), vec![source], metadata).await);
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": { "providers": { "p": { "enabled": true } } } })).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let builder: Arc<dyn ProviderBuilder> = Arc::new(BuildsMock);
    let readiness = ProviderReadiness::new(Arc::new(ProviderRegistry::new(builder.clone())), catalog.clone());
    let env: Arc<dyn Environment> = Arc::new(NoEnv);
    let keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false);
    let effective = Arc::new(EffectiveProviders::new(builder, keys, env));
    let host = ListHost::new(readiness, effective, config.clone(), Arc::new(Obj::new), serde_json::Map::new());
    assert!(listing.host.set(host.clone()).is_ok());
    catalog.bind_providers(Arc::new(|provider| {
        (provider == "p").then(|| mixdog_ai::catalog::RouteProvider { cached: None, listing: Some(Arc::new(NeverListed)) })
    }));
    let service = ModelListService {
        catalog: catalog.clone(),
        config,
        primary_provider: Arc::new(|| "p".to_owned()),
        unsupported: Arc::new(UnsupportedEfforts::default()),
        host: Some(host),
    };
    let service = Arc::new(service);
    let warmup = super::model_warmup::ModelWarmup::new(super::model_warmup::WarmupConfig { enabled: true, delay: std::time::Duration::ZERO });
    warmup.bind(service.clone(), Arc::new(IdleGates)).unwrap();
    assert!(service.warm_needed(), "nothing is loaded or loading yet");
    assert_eq!(catalog.model_meta("p", "mock-model"), json!({ "id": "mock-model", "provider": "p" }), "the cold placeholder");
    warmup.settle().await;
    let row = catalog.model_meta("p", "mock-model");
    assert!(!service.warm_needed(), "the miss scheduled the warm-up, which loaded the catalog");
    assert_eq!(row["display"], "mock-model", "the load's row replaced the placeholder: {row}");
}