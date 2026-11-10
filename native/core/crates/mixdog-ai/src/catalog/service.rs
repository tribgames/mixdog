//! The catalog as the daemon runs it: one handle owning the snapshot, the
//! model sources built from the full config, and the models.dev source. The
//! cold start serves the cached metadata without the network; every refresh
//! lists the sources and loads models.dev concurrently, then publishes the
//! listings as they are; models.dev stays its own layer, read by
//! [`CatalogService::traits`] and the metadata lookup. Reads never refresh.

use std::path::PathBuf;
use std::sync::Arc;

use arc_swap::ArcSwap;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_protocol::ProviderId;

use super::CatalogTraits;
use super::ListingLookup;
use super::ModelSource;
use super::ModelsDev;
use super::lookup::Lookup;
use super::record::Capability;
use super::rosters::Rosters;
use super::route_meta::RouteProvider;
use super::route_meta::RouteProviders;
use crate::oauth::CredentialIo;
use crate::transport::http::HttpSend;
use super::ModelsDevSource;
use super::ProviderCatalog;
use super::RefreshOutcome;
use super::store::Ask;
use super::store::CatalogSnapshot;

pub struct CatalogService {
    catalog: Arc<ProviderCatalog>,
    /// The listings a refresh asks: the registered providers' (`set_sources`).
    sources: ArcSwap<Vec<ModelSource>>,
    metadata: Arc<ModelsDevSource>,
    /// The live-roster files, read from the data directory on every lookup.
    pub(super) rosters: ArcSwap<Rosters>,
    /// The LiteLLM price table, the metadata lookup's base layer.
    litellm: Option<Arc<ModelsDevSource>>,
    /// The tables adapters run their listing steps against.
    listing: ListingLookup,
    /// The revision the price audit last judged (lastAuditedRevision).
    pub(super) audited: std::sync::Mutex<Option<String>>,
    /// Told when the startup catalog refresh the readiness observed has settled, failed or not
    /// (`rt.wakeDeferredWarmups()` in `provider-readiness.mjs`'s `settle`).
    settled: std::sync::Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    /// The startup refresh the readiness observed has not settled (`rt.startupProviderCatalogRefreshPending`). A state,
    /// not an event: a background job scheduled after the refresh began, or after it settled, reads the same answer.
    /// It holds the id of the refresh that owns the flag (the latest observed; 0: nothing pending), so only that one
    /// clears it.
    startup_pending: std::sync::atomic::AtomicU64,
    /// `modelMetaByRoute` and its placeholder keys (`lookupModelMeta`).
    pub(super) meta: std::sync::Mutex<super::facts::MetaMemo>,
    /// `catalogRevision(reg())`, bound by the readiness that owns the registry; 0 until bound.
    revision: arc_swap::ArcSwapOption<Box<dyn Fn() -> u64 + Send + Sync>>,
    /// The revision the last full listing began under (`sharedCatalogKey`'s revision half); none before the first.
    listed_revision: std::sync::Mutex<Option<u64>>,
    /// `caches.providerModelsLoadSeq`, bound by the provider-models cache that owns it; 0 until bound.
    load_seq: arc_swap::ArcSwapOption<Box<dyn Fn() -> u64 + Send + Sync>>,
    /// `reg().getProvider`, bound by the readiness that owns the registry.
    providers: arc_swap::ArcSwapOption<RouteProviders>,
    /// `scheduleProviderModelWarmup`, bound by the provider-models cache that performs the warm-up.
    warmup: arc_swap::ArcSwapOption<Box<dyn Fn() + Send + Sync>>,
}

impl CatalogService {
    /// Cold start: `initial` is the snapshot restored from disk (or empty).
    /// The cached models.dev file, however old, is applied at once so
    /// `catalog_wire` and `outputs_text` carry data before the first refresh.
    pub async fn cold_start(
        initial: CatalogSnapshot,
        sources: Vec<ModelSource>,
        metadata: Arc<ModelsDevSource>,
    ) -> Self {
        let catalog = Arc::new(ProviderCatalog::new(initial));
        metadata.warm_from_disk().await;
        let service = Self {
            catalog,
            sources: ArcSwap::from_pointee(sources),
            metadata,
            rosters: ArcSwap::from_pointee(Rosters::default()),
            litellm: None,
            listing: ListingLookup::new(),
            audited: std::sync::Mutex::new(None),
            settled: std::sync::Mutex::new(Vec::new()),
            startup_pending: std::sync::atomic::AtomicU64::new(0),
            meta: std::sync::Mutex::default(),
            revision: arc_swap::ArcSwapOption::empty(),
            listed_revision: std::sync::Mutex::new(None),
            load_seq: arc_swap::ArcSwapOption::empty(),
            providers: arc_swap::ArcSwapOption::empty(),
            warmup: arc_swap::ArcSwapOption::empty(),
        };
        service.publish_listing();
        service
    }

    /// Binds `catalogRevision(reg())`: the provider registry's catalog revision. The route-meta memo is dropped
    /// whenever it moves (`syncCatalogRevision`).
    pub fn bind_revision(&self, revision: impl Fn() -> u64 + Send + Sync + 'static) {
        let revision: Box<dyn Fn() -> u64 + Send + Sync> = Box::new(revision);
        let observed = revision();
        self.revision.store(Some(Arc::new(revision)));
        self.meta.lock().unwrap_or_else(std::sync::PoisonError::into_inner).observe(observed);
    }

    pub(super) fn catalog_revision(&self) -> u64 {
        self.revision.load().as_ref().map_or(0, |revision| revision())
    }

    /// Binds `reg().getProvider(name)`: the registered providers as the route-meta memo asks about them.
    pub fn bind_providers(&self, providers: RouteProviders) {
        self.providers.store(Some(Arc::new(providers)));
    }

    /// Binds `scheduleProviderModelWarmup`: what a non-fetching route-meta miss asks the provider-models cache to do (load
    /// the catalog, so the placeholder is replaced by the load's rows).
    pub fn bind_warmup(&self, warmup: impl Fn() + Send + Sync + 'static) {
        let warmup: Box<dyn Fn() + Send + Sync> = Box::new(warmup);
        self.warmup.store(Some(Arc::new(warmup)));
    }

    pub(super) fn schedule_warmup(&self) {
        if let Some(warmup) = self.warmup.load().as_ref() {
            warmup();
        }
    }

    /// `reg().getProvider(name)`; `None` when none is registered (or none is bound).
    pub(super) fn route_provider(&self, name: &str) -> Option<RouteProvider> {
        (self.providers.load().as_ref()?)(name)
    }

    /// Binds `caches.providerModelsLoadSeq`, the sequence the provider-models cache above the catalog keeps (read with
    /// the registry revision synced, as `lookupModelMeta` reads it). 0 until bound.
    pub fn bind_load_seq(&self, seq: impl Fn() -> u64 + Send + Sync + 'static) {
        let seq: Box<dyn Fn() -> u64 + Send + Sync> = Box::new(seq);
        self.load_seq.store(Some(Arc::new(seq)));
    }

    pub(super) fn load_seq(&self) -> u64 {
        self.load_seq.load().as_ref().map_or(0, |seq| seq())
    }


    /// The catalog as the daemon composes it, the one place that decides which layers it has: cold-started
    /// from `initial`, with the models.dev table, the LiteLLM table (`litellm-catalog.json`, fetched and cached
    /// as models.dev is) and the roster files, all in the plugin data directory `data_dir`.
    pub async fn composed(
        initial: CatalogSnapshot,
        sources: Vec<ModelSource>,
        http: Arc<dyn HttpSend>,
        data_dir: PathBuf,
        io: CredentialIo,
    ) -> Self {
        let metadata = ModelsDevSource::new(http.clone(), data_dir.clone(), io);
        let litellm = ModelsDevSource::litellm(http, data_dir.clone(), io);
        Self::cold_start(initial, sources, metadata).await.with_litellm(litellm).await.with_rosters(data_dir)
    }
    /// Shares `handle` (already given to the adapters) as this service's
    /// listing tables, so adapters built before the service see them.
    pub fn with_listing_lookup(mut self, handle: ListingLookup) -> Self {
        self.listing = handle;
        self.publish_listing();
        self
    }

    pub fn listing_lookup(&self) -> ListingLookup {
        self.listing.clone()
    }

    fn publish_listing(&self) {
        self.listing.publish(
            self.litellm.as_ref().and_then(|s| s.current()),
            self.metadata.current(),
            self.rosters.load_full(),
        );
    }

    /// Adds the LiteLLM price table (a [`ModelsDevSource::litellm`] source):
    /// its cached copy is warmed now, and every refresh loads it with models.dev.
    pub async fn with_litellm(mut self, source: Arc<ModelsDevSource>) -> Self {
        source.warm_from_disk().await;
        self.litellm = Some(source);
        self.publish_listing();
        self
    }

    /// Runs `read` over the resident overlay tables and the roster files (what
    /// `getModelMetadataSync` reads); no I/O, never waits on a refresh.
    pub(super) fn with_lookup<R>(&self, read: impl FnOnce(&Lookup<'_>) -> R) -> R {
        static EMPTY: std::sync::LazyLock<serde_json::Value> = std::sync::LazyLock::new(|| serde_json::json!({}));
        let litellm = self.litellm.as_ref().and_then(|s| s.current());
        let models_dev = self.metadata.current();
        let rosters = self.rosters.load();
        read(&Lookup {
            litellm: litellm.as_deref().map_or(&EMPTY, ModelsDev::projected),
            models_dev: models_dev.as_deref().map_or(&EMPTY, ModelsDev::projected),
            rosters: &rosters,
        })
    }

    /// `(LiteLLM, models.dev)` fetch times, only when both tables are
    /// resident: the one place that decides a catalog is warm.
    pub(super) fn warm_stamps(&self) -> Option<(u64, u64)> {
        let litellm = self.litellm.as_ref().filter(|s| s.current().is_some())?;
        self.metadata.current()?;
        Some((litellm.cache_at(), self.metadata.cache_at()))
    }

    /// Reads the providers' live-roster files from `data_dir` on every lookup (`readModelsFromCacheFile`), so a
    /// file another process writes is seen by the next one; nothing is held between lookups.
    pub fn with_rosters(self, data_dir: PathBuf) -> Self {
        self.rosters.store(Arc::new(Rosters::in_dir(data_dir)));
        self.publish_listing();
        self
    }
    /// Registers `notify` to run each time the startup catalog refresh the readiness observed settles. Node wakes every
    /// parked background warm-up then (`settle`, `provider-readiness.mjs:154-158`), a failed refresh included.
    pub fn on_refresh_settled(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        self.settled.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(notify);
    }

    /// The startup catalog refresh the readiness observed is running (`rt.startupProviderCatalogRefreshPending`).
    pub fn refresh_in_flight(&self) -> bool {
        self.startup_pending.load(std::sync::atomic::Ordering::SeqCst) != 0
    }

    /// The readiness observed startup refresh `refresh` (an id from 1), which has not settled: it owns the flag now.
    pub fn mark_startup_refresh_pending(&self, refresh: u64) {
        self.startup_pending.store(refresh, std::sync::atomic::Ordering::SeqCst);
    }

    /// Startup refresh `refresh` settled. Only the latest observed one settles the flag (`isLatest()`,
    /// provider-readiness.mjs:152-157): when it still owns it, nothing is pending, then the parked warm-ups are woken; a
    /// superseded one changes nothing. Node checks and clears in one synchronous step; here the check and the clear are
    /// one compare-and-set on the owner, so a refresh observed in between keeps its flag.
    pub fn settle_startup_refresh(&self, refresh: u64) {
        // Before the callbacks, so the wake they give finds nothing pending.
        let ordering = std::sync::atomic::Ordering::SeqCst;
        if self.startup_pending.compare_exchange(refresh, 0, ordering, ordering).is_ok() {
            self.refresh_settled();
        }
    }

    /// Replaces the wall clock that stamps a failed listing's retry time (a test on virtual time).
    pub fn with_clock(mut self, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Arc::get_mut(&mut self.catalog).expect("the catalog is not shared before the service is").set_clock(now_ms);
        self
    }

    fn refresh_settled(&self) {
        // The callbacks run outside the lock: one of them may register another.
        let notify: Vec<_> = self.settled.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        for callback in notify {
            callback();
        }
    }

    /// The listing source of a registered adapter, wired to this service's data directory (the Anthropic
    /// OAuth route's model cache lives there); `None` for an adapter that lists no models.
    pub fn model_source(&self, provider: ProviderId, adapter: Arc<dyn ProviderAdapter>) -> Option<ModelSource> {
        ModelSource::of_adapter(provider, adapter).map(|source| source.with_oauth_cache(self.metadata.oauth_model_cache()))
    }

    /// The catalog readers hold.
    pub fn catalog(&self) -> Arc<ProviderCatalog> {
        self.catalog.clone()
    }

    /// The traits of `provider`'s models: its catalog rows, and the models.dev
    /// layer for what a row does not state.
    pub fn traits(&self, provider: ProviderId) -> CatalogTraits {
        CatalogTraits::new(self.catalog.clone(), provider).with_models_dev(self.metadata.clone())
    }

    /// `getCachedModelInfo(model) ?? getModelMetadataSync(model, provider)` marks prompt caching:
    /// the model's catalog row when `provider` lists it (a row is the cached info, so its flag
    /// decides even when it states none), else the resident tables.
    pub fn prompt_caching(&self, provider: &str, model: &str) -> bool {
        let snapshot = self.catalog.snapshot();
        match snapshot.models_of(&ProviderId::from(provider)).iter().find(|record| record.id == model) {
            Some(record) => record.prompt_caching == Capability::Yes,
            None => self.listing.supports_prompt_caching(provider, model),
        }
    }

    /// `providerCachedModelsSync(provider)` (`provider-catalog-cache.mjs:86`): the provider's
    /// live-roster rows, each id once, read from the data directory.
    pub fn cached_models(&self, provider: &str) -> Vec<serde_json::Value> {
        self.rosters.load().cached_models(provider)
    }

    /// `getModelsDevProviderModelsSync(provider)` (`model-catalog.mjs:438`): the resident
    /// models.dev rows of one provider; `None` while the catalog is cold.
    pub fn models_dev_models(&self, provider: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
        self.listing.models_dev_models(provider)
    }

    pub fn snapshot(&self) -> Arc<CatalogSnapshot> {
        self.catalog.snapshot()
    }

    /// Replaces the listings a refresh asks. Node's catalog load walks the providers the registry
    /// holds (`sharedProviderCatalog(reg())`), so the readiness hands over the registered ones
    /// after each initialization.
    pub fn set_sources(&self, sources: Vec<ModelSource>) {
        self.sources.store(Arc::new(sources));
    }

    /// One refresh: model listings and models.dev (fetched only when its
    /// cache is stale or a retry is due), published as one snapshot.
    pub async fn refresh(&self) -> RefreshOutcome {
        self.refresh_asking(Ask::All).await
    }

    /// A non-forced refresh: asks only the providers that are due (never
    /// listed, or failed with their backoff passed), or every provider once the registry's catalog revision moved
    /// since the last full listing began (`sharedProviderCatalog` keys its answer by `catalogRevision(reg())`).
    pub async fn refresh_due(&self) -> RefreshOutcome {
        self.refresh_asking(Ask::Due).await
    }

    /// A provider-scoped forced refresh (`catalog-load.mjs` `prepare`, `forceRefresh && provider`):
    /// only the providers whose id `wanted` names are asked (`providerRows`: the ids that equal
    /// it once reduced to lowercase letters and digits, else the ids that contain it); every other
    /// provider keeps what it loaded.
    pub async fn refresh_matching(&self, wanted: &str) -> RefreshOutcome {
        let only: Vec<ModelSource> = {
            let sources = self.sources.load_full();
            let ids: Vec<&str> = sources.iter().map(|s| s.provider().as_str()).collect();
            let names = matching_providers(&ids, wanted);
            sources.iter().filter(|s| names.contains(&s.provider().as_str())).cloned().collect()
        };
        let outcome = self.catalog.refresh_asking(&only, Ask::All).await;
        self.publish_listing();
        outcome
    }

    /// `refreshProviderCatalogsOnStartup`'s listing: every registered provider asked again, no metadata table.
    pub async fn refresh_providers(&self) -> RefreshOutcome {
        let sources = self.sources.load_full();
        self.catalog.refresh_asking(&sources, Ask::All).await
    }

    /// `warmCatalogsInBackground`'s loads: the LiteLLM and models.dev tables (fetched only when stale or a retry is due),
    /// no provider listing.
    pub async fn refresh_metadata(&self) {
        let litellm = async {
            if let Some(source) = &self.litellm {
                source.load(false).await;
            }
        };
        futures::future::join(self.metadata.load(false), litellm).await;
        self.publish_listing();
    }

    /// An auth/account change: the rows listed under the previous account are
    /// dropped (`invalidateSharedProviderCatalog`).
    pub fn invalidate_accounts(&self) {
        self.catalog.invalidate_accounts();
    }

    async fn refresh_asking(&self, ask: Ask) -> RefreshOutcome {
        let revision = self.catalog_revision();
        let ask = {
            let mut listed = self.listed_revision.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let moved = listed.is_some_and(|listed| listed != revision);
            *listed = Some(revision);
            if moved { Ask::All } else { ask }
        };
        let litellm = async {
            if let Some(source) = &self.litellm {
                source.load(false).await;
            }
        };
        let sources = self.sources.load_full();
        let (outcome, _, ()) = futures::future::join3(
            self.catalog.refresh_asking(&sources, ask),
            self.metadata.load(false),
            litellm,
        )
        .await;
        self.publish_listing();
        outcome
    }
}

/// `norm(value)` of `model-select.mjs`: lower-cased, reduced to ASCII letters and digits.
fn norm(value: &str) -> String {
    value.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

/// `providerRows(rows, provider)` over provider ids: the ids that equal `wanted` once normalized,
/// else the ids that contain it; every id when `wanted` is empty.
fn matching_providers<'a>(ids: &[&'a str], wanted: &str) -> Vec<&'a str> {
    if wanted.is_empty() {
        return ids.to_vec();
    }
    let wanted = norm(wanted);
    let exact: Vec<&str> = ids.iter().copied().filter(|id| norm(id) == wanted).collect();
    if !exact.is_empty() {
        return exact;
    }
    ids.iter().copied().filter(|id| norm(id).contains(&wanted)).collect()
}

#[cfg(test)]
mod matching_tests {
    use super::matching_providers;

    #[test]
    fn a_name_picks_the_exact_provider_else_the_ones_containing_it() {
        let ids = ["openai", "openai-oauth", "anthropic"];
        assert_eq!(matching_providers(&ids, "OpenAI"), ["openai"]);
        assert_eq!(matching_providers(&ids, "oauth"), ["openai-oauth"]);
        assert_eq!(matching_providers(&ids, "zzz"), Vec::<&str>::new());
        assert_eq!(matching_providers(&ids, ""), ids);
    }
}
