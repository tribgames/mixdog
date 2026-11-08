//! `model/list`: Node's `listProviderModels` (`collectProviderModels`, session-runtime/
//! provider-models.mjs) over the resident [`CatalogService`].
//!
//! Node keeps two caches under it: the process-wide provider catalog with its partial-answer
//! backoff (`provider-catalog-cache.mjs`) and the flattened rows (`providerModelsCache`). The
//! catalog snapshot already holds the first, with each provider's last-listing status
//! (`CatalogSnapshot::status`), so nothing is cached here: every read flattens the snapshot
//! again, which is what Node does with its cached rows (availability, saved settings and the
//! sort are applied at read time anyway).
//!
//! The rows are Node's: the listing object of every model (`listing_value`) goes through
//! `providerModelCacheRow`, hidden ones leave the picker, and the rest are hydrated with the
//! user's saved settings and sorted route-provider-first. A partial answer says so on every row
//! (`catalogPartial`, `catalogMissing`, `catalogRetryAt`); a quick read of a complete catalog is
//! marked `catalogComplete`. A forced read asks every provider again first.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ProviderReadiness};
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_ai::registry::providers::NO_ENABLED_PROVIDERS;
use mixdog_ai::effort::effort_items_for;
use mixdog_ai::service::admin_models::{
    HydrationFacts, hydrate_provider_model_row, is_selectable_llm_model, model_proxy_client_mode, provider_available,
    provider_model_cache_row, sort_provider_models, with_catalog_state,
};
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::effort_configuration::{UnsupportedEfforts, custom_auto_effort_capable, effort_configuration_mode};
use mixdog_ai::service::model_listing::listing_value;
use mixdog_ai::service::routes::web_search_capable_for;
use mixdog_app_protocol::v2::params::ModelListParams;
use mixdog_core_api::call::{CoreRequest, Reply};
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::{Admit, DomainService};
use serde_json::{Value, json};

use mixdog_core_config::config::Config;

const LIST: &str = "model/list";

pub struct ModelListService {
    pub catalog: Arc<CatalogService>,
    pub config: Config,
    /// The provider of the live route (`route().provider`): its models list first.
    pub primary_provider: Arc<dyn Fn() -> String + Send + Sync>,
    /// The models that rejected a mid-conversation effort update in this process.
    pub unsupported: Arc<UnsupportedEfforts>,
    /// The providers of the loaded config and the registry that serves them. `None` reads the
    /// catalog as it is (a host without a provider registry).
    pub host: Option<ListHost>,
}

/// What a read prepares before it lists (`prepare` of `provider-models/catalog-load.mjs`): the
/// providers of the loaded config, initialized in the registry, which hands the catalog its sources.
#[derive(Clone)]
pub struct ListHost {
    pub readiness: Arc<ProviderReadiness>,
    pub effective: Arc<EffectiveProviders>,
    /// The config whose canonical agent section the providers are merged onto.
    pub config: Config,
    /// `getRoute()`: the live Main route.
    pub route: Arc<dyn Fn() -> Obj + Send + Sync>,
    /// `config.providers` as the last load saw it (what the sync readers show).
    last: Arc<Mutex<serde_json::Map<String, Value>>>,
    /// The background load a quick read started (`warmProviderModelCache`).
    warm: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// A full load completed (`caches.providerModelsCache.models` is set).
    loaded: Arc<AtomicBool>,
    /// `caches.providerModelsLoadSeq`: a load that began under an older one is not adopted.
    seq: Arc<AtomicU64>,
    /// The registry's catalog revision the cache was built under (`observedCatalogRevision`).
    observed: Arc<AtomicU64>,
}

/// The loaded config's agent section and its providers.
pub struct Loaded {
    pub agent: Obj,
    pub providers: serde_json::Map<String, Value>,
}

impl ListHost {
    pub fn new(
        readiness: Arc<ProviderReadiness>,
        effective: Arc<EffectiveProviders>,
        config: Config,
        route: Arc<dyn Fn() -> Obj + Send + Sync>,
        initial: serde_json::Map<String, Value>,
    ) -> Self {
        let observed = Arc::new(AtomicU64::new(readiness.catalog_revision()));
        Self {
            readiness,
            effective,
            config,
            route,
            last: Arc::new(Mutex::new(initial)),
            warm: Arc::new(Mutex::new(None)),
            loaded: Arc::new(AtomicBool::new(false)),
            seq: Arc::new(AtomicU64::new(0)),
            observed,
        }
    }

    /// The provider-models cache is dropped and loads in flight are superseded
    /// (`Object.assign(providerModelCaches, emptyModelCaches()); providerModelsLoadSeq += 1`).
    fn invalidate(&self) {
        self.seq.fetch_add(1, Ordering::SeqCst);
        self.loaded.store(false, Ordering::SeqCst);
    }

    /// `syncCatalogRevision`: the cache goes when the registry's catalog moved on.
    fn sync_revision(&self) {
        let now = self.readiness.catalog_revision();
        if self.observed.swap(now, Ordering::SeqCst) != now {
            self.invalidate();
        }
    }

    /// The sequence a load starts under.
    fn begin(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    /// `adoptProviderModelCache`: a load that is still current fills the cache.
    fn adopt(&self, seq: u64) {
        if self.seq.load(Ordering::SeqCst) == seq {
            self.observed.store(self.readiness.catalog_revision(), Ordering::SeqCst);
            self.loaded.store(true, Ordering::SeqCst);
        }
    }

    /// The providers of the last load, in configuration order.
    pub fn last_providers(&self) -> Vec<(String, Value)> {
        self.last.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Waits for the background load a quick read started; nothing when none runs.
    pub async fn settle_warm(&self) {
        let running = self.warm.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(handle) = running {
            // A warm that panicked has nothing to report here; a failed one logged itself.
            let _ = handle.await;
        }
    }

    /// `loadConfig()`: the canonical agent section with the providers merged onto it.
    pub async fn loaded(&self) -> Result<Loaded, String> {
        let agent = self.config.loaded_agent().await.map_err(|error| error.to_string())?;
        let providers = self.effective.load(&agent, true).await?;
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) = providers.clone();
        Ok(Loaded { agent, providers })
    }

    /// `ensureProvidersReady(config.providers)`: the providers of the loaded config, initialized in
    /// the registry; every failure is the caller's, `NO_ENABLED_PROVIDERS` included.
    pub async fn ensure_ready(&self) -> Result<Loaded, String> {
        let loaded = self.loaded().await?;
        self.readiness.ensure_providers_ready(Some(loaded.providers.clone())).await.map_err(|error| error.message)?;
        Ok(loaded)
    }

    /// `prepare` of the catalog load. `None`: no provider is enabled, a fresh install has nothing to
    /// load (the registry refuses an all-disabled init by design).
    async fn prepare(&self) -> Result<Option<Loaded>, String> {
        let loaded = self.loaded().await?;
        match self.readiness.ensure_providers_ready(Some(loaded.providers.clone())).await {
            Ok(_) => Ok(Some(loaded)),
            Err(error) if error.code == Some(NO_ENABLED_PROVIDERS) => Ok(None),
            Err(error) => Err(error.message),
        }
    }
}
/// The facts row hydration reads, over the catalog and the effort modules.
struct RowFacts<'a> {
    catalog: &'a CatalogService,
    snapshot: &'a CatalogSnapshot,
    unsupported: &'a UnsupportedEfforts,
    config: &'a Obj,
}

impl HydrationFacts for RowFacts<'_> {
    fn fast_capable(&self, provider: &str, row: &Value) -> bool {
        self.catalog.fast_capable(provider, row, None, &json!({}))
    }

    fn ultrafast_capable(&self, provider: &str, row: &Value) -> bool {
        self.catalog.ultrafast_capable(provider, row)
    }

    fn effort_items(&self, provider: &str, row: &Value) -> Value {
        Value::Array(
            effort_items_for(provider, row, None, None)
                .into_iter()
                .map(|item| json!({ "value": item.value, "label": item.label, "description": item.description }))
                .collect(),
        )
    }

    fn effort_configuration_mode(&self, provider: &str, model: &str, opts: &Value) -> bool {
        // `codexModelSupportsEffortUpdates(id)`: the OAuth catalog's own statement for the model.
        let declared = |id: &str| {
            let (_, records) = self.snapshot.models.iter().find(|(p, _)| p.as_str() == "openai-oauth")?;
            records.iter().find(|r| r.id == id)?.supports_reasoning_effort_updates
        };
        effort_configuration_mode(provider, &Value::from(model), opts, self.unsupported, &declared).is_some()
    }

    fn custom_auto_effort_capable(&self, provider: &str, protocol: Option<&Value>, row: &Value) -> bool {
        custom_auto_effort_capable(provider, protocol, row)
    }

    /// `getProvider(provider)?.config`: the provider's entry of the configuration it was built from.
    fn provider_config(&self, provider: &str) -> Obj {
        self.config.get("providers").and_then(|p| p.get(provider)).and_then(Value::as_object).cloned().unwrap_or_default()
    }
}

impl ModelListService {
    /// The catalog before the first read: a snapshot nothing was listed into (the compiled-in
    /// generation) is listed now, as Node's first full read loads every provider.
    pub async fn ready(&self, force: bool, provider: Option<&str>) {
        // The revision is synced before the load begins, so a registration that moved it does not supersede this load.
        let loaded = self.cache_loaded();
        let seq = self.host.as_ref().map(ListHost::begin);
        if force {
            // `forceRefresh && provider` (`catalog-load.mjs` `prepare`): only the providers the
            // name matches are asked again.
            match provider.filter(|p| !p.is_empty()) {
                Some(provider) => self.catalog.refresh_matching(provider).await,
                None => self.catalog.refresh().await,
            };
            self.adopt(seq);
            return;
        }
        if !loaded {
            self.catalog.refresh_due().await;
        }
        self.adopt(seq);
    }

    /// The authoritative load ran (`providerModelsCache.models` is an array). A refresh with no source
    /// publishes a new generation too, so the snapshot cannot say whether the providers were ever asked.
    fn adopt(&self, seq: Option<u64>) {
        if let (Some(host), Some(seq)) = (&self.host, seq) {
            host.adopt(seq);
        }
    }

    /// `Array.isArray(caches.providerModelsCache.models)` after `syncCatalogRevision()`. A host without a
    /// provider registry has no cache of its own: the catalog is loaded once something was listed into it.
    pub fn cache_loaded(&self) -> bool {
        match &self.host {
            Some(host) => {
                host.sync_revision();
                host.loaded.load(Ordering::SeqCst)
            }
            None => {
                let snapshot = self.catalog.snapshot();
                snapshot.generation != 0 || !snapshot.status.is_empty()
            }
        }
    }

    /// `invalidateProviderCaches()`: the shared catalog starts a new epoch and the cache above it is dropped.
    pub fn invalidate(&self) {
        self.catalog.invalidate_accounts();
        if let Some(host) = &self.host {
            host.invalidate();
        }
    }

    /// `collectProviderModels({ force, quick })`.
    pub async fn rows(&self, force: bool, quick: bool) -> Result<Vec<Value>, String> {
        self.rows_for(force, quick, None).await
    }

    /// The providers of the loaded config, read again (`ensureFullConfig()` and the keychain
    /// prewarm of the web-search load); a no-op without a host.
    pub async fn refresh_providers(&self) -> Result<(), String> {
        match &self.host {
            Some(host) => host.loaded().await.map(|_| ()),
            None => Ok(()),
        }
    }

    /// `ensureProvidersReady(config.providers)` as the web-search load runs it, which does not
    /// catch (`web-search-catalog.mjs`, `loadWebSearchProviderModelsFresh`); a no-op without a host.
    pub async fn ensure_ready(&self) -> Result<(), String> {
        match &self.host {
            Some(host) => host.ensure_ready().await.map(|_| ()),
            None => Ok(()),
        }
    }

    /// `collectProviderModels({ force, quick, provider })`: `provider` scopes a forced refresh. `Err`
    /// is a provider load that failed, which Node's `collectProviderModels` rejects with.
    pub async fn rows_for(&self, force: bool, quick: bool, provider: Option<&str>) -> Result<Vec<Value>, String> {
        if let Some(host) = &self.host {
            let snapshot = self.catalog.snapshot();
            if quick && !force && !self.cache_loaded() {
                let seq = host.begin();
                // A quick read before any load answers from the profile and seeds the full load in
                // the background (`warmProviderModelCache`); a failed warm is logged and leaves the
                // cache empty, as its `onFailed` does (`provider-models.mjs`).
                let (warm, catalog) = (host.clone(), self.catalog.clone());
                let started = mixdog_rt::spawn("model-list-warm", mixdog_rt::TaskClass::Work, async move {
                    match warm.prepare().await {
                        Ok(Some(_)) => {
                            catalog.refresh_due().await;
                            warm.adopt(seq);
                        }
                        Ok(None) => {}
                        Err(error) => tracing::warn!(%error, "[provider-models] the warm load failed"),
                    }
                });
                *host.warm.lock().unwrap_or_else(PoisonError::into_inner) = Some(started);
                let Loaded { agent, providers } = host.loaded().await?;
                return Ok(self.quick_rows(&snapshot, &providers, &agent, &(host.route)()));
            }
            if host.prepare().await?.is_none() {
                return Ok(Vec::new());
            }
        }
        self.ready(force, provider).await;
        let snapshot = self.catalog.snapshot();
        let mut rows = self.from_cache_rows(&snapshot, &self.cache_rows(&snapshot));
        if snapshot.partial() {
            let missing: Vec<String> = snapshot.missing().iter().map(|id| id.as_str().to_owned()).collect();
            let retry_at = snapshot.retry_at().map_or(f64::NAN, |at| at as f64);
            return Ok(with_catalog_state(rows, Some((&missing, retry_at))));
        }
        // A quick answer from the loaded catalog already is the full catalog; saying so lets a
        // caller skip the full read it would otherwise follow up with.
        if quick && !force && snapshot.complete() {
            for row in &mut rows {
                if let Some(row) = row.as_object_mut() {
                    row.insert("catalogComplete".into(), Value::Bool(true));
                }
            }
        }
        Ok(rows)
    }
    /// The catalog flattened into deduplicated cache rows; a hidden custom model leaves the picker.
    pub fn cache_rows(&self, snapshot: &CatalogSnapshot) -> Vec<Value> {
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        for (provider, records) in &snapshot.models {
            let name = provider.as_str();
            for record in records {
                let listing = listing_value(record);
                if record.id.is_empty() || !is_selectable_llm_model(&listing) {
                    continue;
                }
                let catalog_row = self.catalog.model_meta(name, &record.id);
                let web_search = web_search_capable_for(name, &record.id, Some(&listing), Some(&catalog_row));
                let row = provider_model_cache_row(name, &listing, web_search);
                if !seen.insert(format!("{name}:{}", record.id)) || row.get("hidden") == Some(&Value::Bool(true)) {
                    continue;
                }
                rows.push(Value::Object(row));
            }
        }
        rows
    }

    /// `providerModelsFromCacheRows`: availability applied at read time, then hydrated and sorted.
    pub fn from_cache_rows(&self, snapshot: &CatalogSnapshot, rows: &[Value]) -> Vec<Value> {
        let config = self.config.agent();
        let developer = config.get("developer").cloned().unwrap_or(Value::Null);
        let client_mode = model_proxy_client_mode(&|name| std::env::var(name).ok());
        let facts = RowFacts { catalog: &self.catalog, snapshot, unsupported: &self.unsupported, config: &config };
        let mut rows: Vec<Value> = rows
            .iter()
            .filter(|row| provider_available(row.get("provider").and_then(Value::as_str).unwrap_or_default(), client_mode, &developer))
            .map(|row| hydrate_provider_model_row(&config, row, &facts))
            .collect();
        sort_provider_models(&mut rows, &(self.primary_provider)());
        rows
    }
}

fn invalid(expected: &str) -> CoreError {
    CoreError::InvalidParams { path: "params".into(), expected: expected.into() }
}

#[async_trait]
impl DomainService for ModelListService {
    fn methods(&self) -> &'static [&'static str] {
        &[LIST]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ModelListParams = serde_json::from_value(req.params).map_err(|e| invalid(&e.to_string()))?;
        // `refresh` is the setup tool's name for `force`.
        let force = params.force == Some(true) || params.refresh == Some(true);
        let rows = self
            .rows(force, params.quick == Some(true))
            .await
            .map_err(|message| CoreError::DomainError { domain: "providers".into(), code: None, message: Some(message.into()), detail: None })?;
        Ok(Reply::Value(Value::Array(rows)))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
