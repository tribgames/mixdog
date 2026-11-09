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

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};

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
    /// The cache state; one lock, so an adoption cannot interleave with an invalidation.
    cache: Arc<Mutex<CacheState>>,
    /// Told whenever a load fills the cache.
    filled: Arc<tokio::sync::Notify>,
    /// Tests: one permit per caller that joined the load in flight, so a test waits for the reader instead of yielding.
    #[cfg(test)]
    pub(super) joined: Arc<tokio::sync::Semaphore>,
    /// Tests: runs inside `claim` between its ownership check and its sequence choice.
    #[cfg(test)]
    pub(super) claim_hook: Arc<Mutex<Option<Arc<dyn Fn(&ListHost) + Send + Sync>>>>,
}

/// One load every reader and warm shares (`caches.providerModelsPromise`): `Ok(false)` is a load that found no enabled provider
/// (or a warm that failed, which Node's `onFailed` turns into an empty answer for everyone joined to it).
type Load = Shared<BoxFuture<'static, Result<bool, String>>>;

struct Flight {
    id: u64,
    load: Load,
}

/// What `providerModelCaches` holds of a load.
struct CacheState {
    /// `caches.providerModelsPromise`: the load in flight, if any.
    flight: Option<Flight>,
    flights: u64,
    /// A full load completed (`caches.providerModelsCache.models` is set).
    loaded: bool,
    /// `caches.providerModelsLoadSeq`: a load that began under an older one is not adopted.
    seq: u64,
    /// The registry's catalog revision the cache was built under (`observedCatalogRevision`).
    observed: u64,
}

impl CacheState {
    /// `Object.assign(providerModelCaches, emptyModelCaches()); providerModelsLoadSeq += 1`.
    fn invalidate(&mut self) {
        self.reset();
        self.flight = None;
    }

    /// The cache goes and loads in flight are superseded, but the load in flight stays the one everyone joins: a load
    /// registers the providers it lists, which moves the revision under its own feet, and it must not stop being shared
    /// for that (Node drops the promise there, so a second reader starts a second load).
    fn reset(&mut self) {
        self.seq += 1;
        self.loaded = false;
    }

    /// `syncCatalogRevision`: the cache goes when the registry's catalog moved on.
    fn sync(&mut self, revision: u64) {
        if std::mem::replace(&mut self.observed, revision) != revision {
            self.reset();
        }
    }
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
        let cache = Arc::new(Mutex::new(CacheState { flight: None, flights: 0, loaded: false, seq: 0, observed: readiness.catalog_revision() }));
        // The catalog's fetching lookups pin only while this sequence stands (`snapshotIsCurrent`); read with the
        // revision synced, as `lookupModelMeta` reads it. Weak: the readiness owns the catalog that holds this.
        let (shared, owner) = (cache.clone(), Arc::downgrade(&readiness));
        readiness.bind_load_seq(move || {
            let mut cache = shared.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(readiness) = owner.upgrade() {
                cache.sync(readiness.catalog_revision());
            }
            cache.seq
        });
        Self {
            readiness,
            effective,
            config,
            route,
            last: Arc::new(Mutex::new(initial)),
            cache,
            filled: Arc::default(),
            #[cfg(test)]
            joined: Arc::new(tokio::sync::Semaphore::new(0)),
            #[cfg(test)]
            claim_hook: Arc::default(),
        }
    }

    /// Tests: the invalidation a concurrent caller makes, if it can take the cache lock now. `false`: the lock is held.
    #[cfg(test)]
    pub(super) fn invalidate_unless_locked(&self) -> bool {
        use std::sync::TryLockError;
        match self.cache.try_lock() {
            Ok(mut cache) => cache.invalidate(),
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().invalidate(),
            Err(TryLockError::WouldBlock) => return false,
        }
        true
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The provider-models cache is dropped and loads in flight are superseded.
    pub(super) fn invalidate(&self) {
        self.cache().invalidate();
    }

    /// `Array.isArray(caches.providerModelsCache.models)` after `syncCatalogRevision()`.
    fn loaded_now(&self) -> bool {
        let mut cache = self.cache();
        cache.sync(self.readiness.catalog_revision());
        cache.loaded
    }

    /// The sequence a load starts under, the revision synced first.
    pub(super) fn begin(&self) -> u64 {
        let mut cache = self.cache();
        cache.sync(self.readiness.catalog_revision());
        cache.seq
    }

    /// What a load takes after its preparation, under one hold of the cache lock: whether it still owns its sequence
    /// (`ownsLoad`), the revision synced (the preparation registered the providers it lists, which moved it), whether
    /// the cache is loaded then, and the sequence to adopt under. An invalidation cannot land between these steps:
    /// one that came first is seen by `owns` and the load keeps `started` (refused by `adopt`); one that comes after
    /// moves the sequence past the one taken here.
    pub(super) fn claim(&self, started: u64) -> (bool, u64) {
        let mut cache = self.cache();
        let owns = cache.seq == started;
        #[cfg(test)]
        {
            let hook = self.claim_hook.lock().unwrap_or_else(PoisonError::into_inner).clone();
            if let Some(hook) = hook {
                hook(self);
            }
        }
        cache.sync(self.readiness.catalog_revision());
        (cache.loaded, if owns { cache.seq } else { started })
    }

    /// `snapshotIsCurrent(revision, seq)`: the revision synced, no invalidation since the load took `seq`.
    pub(super) fn current(&self, seq: u64) -> bool {
        let mut cache = self.cache();
        cache.sync(self.readiness.catalog_revision());
        cache.seq == seq
    }

    /// `adoptProviderModelCache`: the revision is synced before the sequence is checked
    /// (`provider-models.mjs`), so a revision change during the load supersedes it; a load that is
    /// still current fills the cache, all under the one lock an invalidation takes.
    pub(super) fn adopt(&self, seq: u64) {
        let mut cache = self.cache();
        cache.sync(self.readiness.catalog_revision());
        if cache.seq == seq {
            cache.loaded = true;
            self.filled.notify_one();
        }
    }

    /// The providers of the last load, in configuration order.
    pub fn last_providers(&self) -> Vec<(String, Value)> {
        self.last.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Waits for the load in flight, if any; nothing when none runs.
    pub async fn settle_warm(&self) {
        let running = self.cache().flight.as_ref().map(|flight| flight.load.clone());
        if let Some(load) = running {
            // A failed load reported itself to its readers (and the log); there is nothing to add here.
            let _ = load.await;
        }
    }

    /// `caches.providerModelsPromise` is set.
    pub fn load_in_flight(&self) -> bool {
        self.cache().flight.is_some()
    }

    /// `startSharedLoad`: the load in flight, or a new one that every warm and reader joins. `load_secrets` is
    /// Node's `loadSecrets`: the load prepares the secrets first, and only such a load is adopted as the cache.
    /// `swallow` is `onFailed`: a failed load is logged and answers `Ok(false)` to everyone joined to it. The load's
    /// sequence is taken here, as `++providerModelsLoadSeq` is, before anything it prepares.
    fn shared_load(&self, catalog: &Arc<CatalogService>, load_secrets: bool, swallow: bool) -> Load {
        let mut cache = self.cache();
        if let Some(flight) = &cache.flight {
            #[cfg(test)]
            self.joined.add_permits(1);
            return flight.load.clone();
        }
        cache.sync(self.readiness.catalog_revision());
        let started = cache.seq;
        cache.flights += 1;
        let id = cache.flights;
        let (host, catalog) = (self.clone(), catalog.clone());
        let handle = mixdog_rt::spawn("model-list-load", mixdog_rt::TaskClass::Work, async move {
            let outcome = host.run_load(&catalog, load_secrets, started).await;
            // `.finally(() => if (caches.providerModelsPromise === promise) = null)`
            let mut cache = host.cache();
            if cache.flight.as_ref().is_some_and(|flight| flight.id == id) {
                cache.flight = None;
            }
            outcome
        });
        let load: Load = async move {
            match handle.await {
                Ok(Err(error)) if swallow => {
                    tracing::warn!(%error, "[provider-models] the warm load failed");
                    Ok(false)
                }
                Ok(outcome) => outcome,
                Err(error) => Err(error.to_string()),
            }
        }
        .boxed()
        .shared();
        cache.flight = Some(Flight { id, load: load.clone() });
        load
    }

    /// One load (`loadProviderModelsFresh`): the providers prepared, then the listings that are due, adopted when the
    /// load carries secrets. `started` is the sequence the load began under. A preparation moves the registry's
    /// revision (it registers the providers it lists), so a load still current after it carries the sequence forward
    /// (`ownsLoad`); one an invalidation superseded during the preparation keeps `started`, and `adopt` refuses it.
    /// `false`: no provider is enabled, nothing was loaded.
    async fn run_load(&self, catalog: &CatalogService, load_secrets: bool, started: u64) -> Result<bool, String> {
        if !self.prepare(load_secrets).await? {
            return Ok(false);
        }
        let (loaded, seq) = self.claim(started);
        if !loaded {
            catalog.refresh_due().await;
            if self.current(seq) {
                remember_loaded_rows(catalog);
            }
        }
        if load_secrets {
            self.adopt(seq);
        }
        Ok(true)
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

    /// `prepare` of the catalog load. A load with secrets reads the full config first (`awaitKeychainPrewarm();
    /// ensureFullConfig()`); one without prepares the providers of the runtime's config as it is at this moment
    /// (`config().providers`, which the config sync keeps current: the readiness holds it) and reads no secret.
    /// `false`: no provider is enabled, a fresh install has nothing to load (the registry refuses an all-disabled init
    /// by design).
    async fn prepare(&self, load_secrets: bool) -> Result<bool, String> {
        let providers = if load_secrets { Some(self.loaded().await?.providers) } else { None };
        match self.readiness.ensure_providers_ready(providers).await {
            Ok(_) => Ok(true),
            Err(error) if error.code == Some(NO_ENABLED_PROVIDERS) => Ok(false),
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
            self.remember_loaded(seq);
            self.adopt(seq);
            return;
        }
        if !loaded {
            self.catalog.refresh_due().await;
            self.remember_loaded(seq);
        }
        self.adopt(seq);
    }

    /// The load's rows go to the route memo while the load is current (`catalog-load.mjs` `remember`). A host
    /// without a provider registry has no cache sequence to outlive.
    fn remember_loaded(&self, seq: Option<u64>) {
        let current = match (&self.host, seq) {
            (Some(host), Some(seq)) => host.current(seq),
            _ => true,
        };
        if current {
            remember_loaded_rows(&self.catalog);
        }
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
                host.loaded_now()
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
        self.catalog.forget_route_meta();
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
        match &self.host {
            Some(host) if !force => {
                let snapshot = self.catalog.snapshot();
                if quick && !self.cache_loaded() {
                    // A quick read before any load answers from the profile and seeds the full load in the background
                    // (`warmProviderModelCache({ loadSecrets: true })`, joining a load already in flight).
                    self.warm_cache(true);
                    let Loaded { agent, providers } = host.loaded().await?;
                    return Ok(self.quick_rows(&snapshot, &providers, &agent, &(host.route)()));
                }
                // The one load in flight is joined, never raced (`startSharedLoad`); a read that finds none starts it.
                if !host.shared_load(&self.catalog, true, false).await? {
                    return Ok(Vec::new());
                }
            }
            Some(host) => {
                if !host.prepare(true).await? {
                    return Ok(Vec::new());
                }
                self.ready(force, provider).await;
            }
            None => self.ready(force, provider).await,
        }
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
    /// `warmProviderModelCache({ loadSecrets })`: the load in the background. Nothing starts when the cache is loaded
    /// or a load is in flight (Node's `models` / `promise` guard); a load without secrets runs but is never adopted.
    pub fn warm_cache(&self, load_secrets: bool) {
        let Some(host) = &self.host else { return };
        if self.cache_loaded() || host.load_in_flight() {
            return;
        }
        drop(host.shared_load(&self.catalog, load_secrets, true));
    }

    /// Waits for the load in flight, if any.
    pub async fn settle_warm(&self) {
        if let Some(host) = &self.host {
            host.settle_warm().await;
        }
    }

    /// Told whenever a load fills the cache; a host without a registry never loads, so never tells.
    pub fn filled(&self) -> Arc<tokio::sync::Notify> {
        self.host.as_ref().map_or_else(Arc::default, |host| host.filled.clone())
    }

    /// `Array.isArray(caches.providerModelsCache.models) || caches.providerModelsPromise`: nothing left for a warm to do.
    pub fn warm_needed(&self) -> bool {
        self.host.as_ref().is_some_and(|host| !self.cache_loaded() && !host.load_in_flight())
    }
    /// The catalog flattened into deduplicated cache rows; a hidden custom model leaves the picker.
    pub fn cache_rows(&self, snapshot: &CatalogSnapshot) -> Vec<Value> {
        loaded_rows(&self.catalog, snapshot)
            .into_iter()
            .filter(|row| row.get("hidden") != Some(&Value::Bool(true)))
            .map(Value::Object)
            .collect()
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

/// The rows of a load (`rowsForEntry` over every entry, deduplicated by provider and id): ids that are empty and
/// models that are not selectable are left out; a hidden custom model stays (it leaves the picker, not the load).
pub(super) fn loaded_rows(catalog: &CatalogService, snapshot: &CatalogSnapshot) -> Vec<Obj> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for (provider, records) in &snapshot.models {
        let name = provider.as_str();
        for record in records {
            let listing = listing_value(record);
            if record.id.is_empty() || !is_selectable_llm_model(&listing) {
                continue;
            }
            let catalog_row = catalog.listed_meta(name, &record.id);
            let web_search = web_search_capable_for(name, &record.id, Some(&listing), Some(&catalog_row));
            if seen.insert(format!("{name}:{}", record.id)) {
                rows.push(provider_model_cache_row(name, &listing, web_search));
            }
        }
    }
    rows
}

/// `if (meta.snapshotIsCurrent(revision, seq)) meta.remember(row.provider, row.id, row)` over the load's rows; the
/// caller says the load is still current. A hidden custom model's metadata still resolves for routes already on it.
fn remember_loaded_rows(catalog: &CatalogService) {
    for row in loaded_rows(catalog, &catalog.snapshot()) {
        let (Some(provider), Some(id)) = (row.get("provider").and_then(Value::as_str), row.get("id").and_then(Value::as_str)) else {
            continue;
        };
        let (provider, id) = (provider.to_owned(), id.to_owned());
        catalog.remember_meta(&provider, &id, Value::Object(row));
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
