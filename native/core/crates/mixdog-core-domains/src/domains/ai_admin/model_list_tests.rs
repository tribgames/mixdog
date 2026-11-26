//! `model/list`: a snapshot the provider listing produced reaches the rows, and a cold placeholder schedules the load that replaces it.

#![allow(clippy::disallowed_methods, reason = "test setup: writes the catalog cache files on the test thread")]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::{CatalogSnapshot, ModelSource, ModelsDevSource};
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

pub(super) struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
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
    // The catalog says this model takes no mid-conversation effort update.
    assert_eq!(stated["autoEffortCapable"], json!(false));
    // A row that states no effort levels gives the judge no ladder to move along, and the id alone never makes a route
    // Auto-capable (`hydrate_provider_model_row`).
    assert_eq!(silent["autoEffortCapable"], json!(false));
}

struct NeverListed;

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

/// The gates of a runtime that is up and idle.
struct IdleGates;

impl super::model_warmup::WarmupMarks for IdleGates {
    fn profile(&self, _: &str, _: Option<serde_json::Value>) {}
}

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
}

#[async_trait]
impl mixdog_ai::catalog::ListedRows for NeverListed {
    async fn list_rows(&self) -> Result<Vec<Arc<Value>>, ()> {
        Err(())
    }
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
    let warmup =
        super::model_warmup::ModelWarmup::new(super::model_warmup::WarmupConfig { enabled: true, delay: std::time::Duration::ZERO, before_first_turn: false });
    warmup.bind(service.clone(), Arc::new(IdleGates)).unwrap();
    assert!(service.warm_needed(), "nothing is loaded or loading yet");
    assert_eq!(catalog.model_meta("p", "mock-model"), json!({ "id": "mock-model", "provider": "p" }), "the cold placeholder");
    warmup.settle().await;
    let row = catalog.model_meta("p", "mock-model");
    assert!(!service.warm_needed(), "the miss scheduled the warm-up, which loaded the catalog");
    assert_eq!(row["display"], "mock-model", "the load's row replaced the placeholder: {row}");
}

#[tokio::test]
async fn model_list_serves_fresh_disk_catalogs_without_downloading_and_refreshes_stale_or_missing() {
    use mixdog_ai::catalog::{LITELLM_CACHE_FILE, ListingLookup, MODELS_DEV_CACHE_FILE, REFRESH_AFTER};
    use mixdog_ai::transport::http::BodyStream;
    use mixdog_core_api::domain::provider::{ModelListing, ModelRecord, TransportFault};

    const DISK_MODELS_DEV: &str =
        r#"{"openai":{"models":{"gpt-m":{"name":"GPT Disk","limit":{"context":200000,"output":8000},"cost":{"input":1.5,"output":6.0}}}}}"#;
    const FRESH_MODELS_DEV: &str =
        r#"{"openai":{"models":{"gpt-m":{"name":"GPT Fresh","limit":{"context":200000,"output":8000},"cost":{"input":1.5,"output":6.0}}}}}"#;
    const DISK_LITELLM: &str = r#"{"openai/gpt-x":{"max_input_tokens":128000,"max_output_tokens":4096,"mode":"chat","input_cost_per_token":0.0000025,"output_cost_per_token":0.00001}}"#;
    const FRESH_LITELLM: &str = r#"{"openai/gpt-x":{"max_input_tokens":256000,"max_output_tokens":4096,"mode":"chat","input_cost_per_token":0.0000025,"output_cost_per_token":0.00001}}"#;

    struct OnceBody(Option<bytes::Bytes>);
    #[async_trait]
    impl BodyStream for OnceBody {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    struct CatalogHttp(std::sync::Mutex<Vec<String>>);
    #[async_trait]
    impl HttpSend for CatalogHttp {
        async fn send(&self, request: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            self.0.lock().unwrap().push(request.url.clone());
            let body = if request.url.contains("models.dev") {
                FRESH_MODELS_DEV
            } else if request.url.contains("litellm") {
                FRESH_LITELLM
            } else {
                panic!("unexpected catalog URL: {}", request.url);
            };
            Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(OnceBody(Some(bytes::Bytes::from_static(body.as_bytes())))) })
        }
    }

    struct EnrichingListing(ListingLookup);
    #[async_trait]
    impl ModelListing for EnrichingListing {
        async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
            self.0.load_models_dev().await;
            Ok(self.0.enrich_listed("openai", vec![ModelRecord::new("gpt-m"), ModelRecord::new("gpt-x")]))
        }
    }

    async fn run_case(fetched_at: Option<u64>) -> (Vec<String>, Vec<Value>, Arc<CatalogService>) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(at) = fetched_at {
            std::fs::write(dir.path().join(MODELS_DEV_CACHE_FILE), format!("{{\"fetchedAt\":{at},\"data\":{DISK_MODELS_DEV}}}\n")).unwrap();
            std::fs::write(dir.path().join(LITELLM_CACHE_FILE), format!("{{\"fetchedAt\":{at},\"data\":{DISK_LITELLM}}}\n")).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let http = Arc::new(CatalogHttp(std::sync::Mutex::new(Vec::new())));
        let catalog = Arc::new(CatalogService::composed(CatalogSnapshot::default(), Vec::new(), http.clone(), dir.path().to_path_buf(), io).await);
        let lookup = catalog.listing_lookup();
        catalog.set_sources(vec![ModelSource::new("openai".into(), Arc::new(EnrichingListing(lookup)))]);
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let service = ModelListService {
            catalog: catalog.clone(),
            config,
            primary_provider: Arc::new(|| "openai".to_owned()),
            unsupported: Arc::new(UnsupportedEfforts::default()),
            host: None,
        };
        let rows = service.rows(false, false).await.unwrap();
        let mut asked = http.0.lock().unwrap().clone();
        asked.sort();
        (asked, rows, catalog)
    }

    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let find = |rows: &[Value], id: &str| rows.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("{id} in {rows:?}")).clone();

    // Younger than 6 h: no catalog download, model/list serves from the disk copies.
    let (asked, rows, _) = run_case(Some(now.saturating_sub(60_000))).await;
    assert!(asked.is_empty(), "fresh disk catalogs should not download: {asked:?}");
    assert_eq!(find(&rows, "gpt-m")["display"], "GPT Disk");
    assert_eq!(find(&rows, "gpt-x")["contextWindow"], json!(128_000));

    // Older than 6 h: downloads both catalogs and serves the refreshed metadata.
    let stale_at = now.saturating_sub(REFRESH_AFTER.as_millis() as u64 + 1_000);
    let (asked, rows, catalog) = run_case(Some(stale_at)).await;
    assert_eq!(asked.len(), 2, "stale disk catalogs must refresh both tables: {asked:?}");
    assert_eq!(find(&rows, "gpt-m")["display"], "GPT Fresh");
    let refreshed_x = catalog.listing_lookup().enrich_listed("openai", vec![ModelRecord::new("gpt-x")]).remove(0);
    assert_eq!(refreshed_x.context_window, Some(256_000));

    // Missing disk copies: downloads both catalogs and serves the refreshed metadata.
    let (asked, rows, catalog) = run_case(None).await;
    assert_eq!(asked.len(), 2, "missing disk catalogs must refresh both tables: {asked:?}");
    assert_eq!(find(&rows, "gpt-m")["display"], "GPT Fresh");
    let refreshed_x = catalog.listing_lookup().enrich_listed("openai", vec![ModelRecord::new("gpt-x")]).remove(0);
    assert_eq!(refreshed_x.context_window, Some(256_000));
}
