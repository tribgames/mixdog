//! Where the model picker's rows come from (`model-picker/catalog-load.mjs`, `use-model-catalog-cache.mjs`): the UI caches, a
//! quick-then-full load or a forced refresh, the freshness policy that refreshes a stale cache in the background for the NEXT
//! open, the boot-time warm-up and `clearModelCaches`.

use serde_json::{Value, json};

use super::picker::ModelPickerOptions;
use crate::pickers::common::PickerHost;
use crate::slash::host::Tone;

/// Cached picker opens stay instant, but a catalog older than this is treated as stale: cached rows render immediately and a
/// background force refresh updates the cache for the next open.
pub const MODEL_CACHE_TTL_MS: u64 = 5 * 60 * 1000;

/// The boot-time warm-up runs this long after start.
pub const PREFETCH_DELAY_MS: u64 = 1500;

/// Which catalog a picker lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CatalogKind {
    /// Every provider's models (`store.listProviderModels`).
    #[default]
    Provider,
    /// The native web-search models (`store.listWebSearchModels`).
    WebSearch,
}

impl CatalogKind {
    /// The store method that lists it.
    pub fn method(self) -> &'static str {
        match self {
            CatalogKind::Provider => "listProviderModels",
            CatalogKind::WebSearch => "listWebSearchModels",
        }
    }
}

/// One cache (`{ models, at }`): `models` is `None` until a load filled it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CacheEntry {
    pub models: Option<Vec<Value>>,
    pub at: u64,
}

impl CacheEntry {
    fn rows(&self) -> &[Value] {
        self.models.as_deref().unwrap_or_default()
    }
}

/// The two catalog caches, the counter that orders concurrent opens and the generation that makes an invalidation stick.
#[derive(Clone, Debug, Default)]
pub struct ModelCatalogCaches {
    provider: CacheEntry,
    web_search: CacheEntry,
    /// `modelPickerRequestRef`: bumped by every open.
    pub request_seq: u64,
    /// `onboardingPrefetchSeqRef`: bumped on every provider-scope clear, so a stale in-flight listing cannot repopulate the
    /// cache after an invalidation.
    pub prefetch_seq: u64,
    ttl_refresh_in_flight: bool,
}

impl ModelCatalogCaches {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entry(&self, kind: CatalogKind) -> &CacheEntry {
        match kind {
            CatalogKind::Provider => &self.provider,
            CatalogKind::WebSearch => &self.web_search,
        }
    }

    fn entry_mut(&mut self, kind: CatalogKind) -> &mut CacheEntry {
        match kind {
            CatalogKind::Provider => &mut self.provider,
            CatalogKind::WebSearch => &mut self.web_search,
        }
    }

    /// Stores a listing as the cache of `kind` (`cacheRef.current = { models, at }`).
    pub fn store(&mut self, kind: CatalogKind, models: Option<Vec<Value>>, now_ms: u64) {
        *self.entry_mut(kind) = CacheEntry { models, at: now_ms };
    }

    /// `markModelCatalogStale()`: a saved route changes each row's remembered effort and Fast, never the catalog itself.
    /// Dropping the cached rows after a save forced the NEXT open to paint a "Loading models..." panel (the picker looked
    /// like it closed and reopened). Marking them stale keeps that open instant and lets the TTL path refresh in the
    /// background.
    pub fn mark_stale(&mut self) {
        for kind in [CatalogKind::Provider, CatalogKind::WebSearch] {
            let entry = self.entry_mut(kind);
            if entry.models.as_ref().is_some_and(|models| !models.is_empty()) {
                entry.at = 0;
            }
        }
    }

    /// `clearModelCaches(scope)` with scope `all`, `provider` or `webSearch`. Answers whether the provider catalog was cleared
    /// (the onboarding state's own provider models are then cleared by the caller).
    pub fn clear(&mut self, scope: &str) -> bool {
        let provider = scope == "all" || scope == "provider";
        if provider {
            self.provider = CacheEntry::default();
            self.prefetch_seq += 1;
        }
        if scope == "all" || scope == "webSearch" {
            self.web_search = CacheEntry::default();
        }
        provider
    }
}

/// The rows to paint, and what the background refresh needs to know.
#[derive(Clone, Debug)]
pub struct LoadedCatalog {
    pub kind: CatalogKind,
    pub models: Vec<Value>,
    /// The quick rows were painted and the full listing is still to be adopted.
    pub rendered_quick: bool,
    /// The cache the rows came from is older than the TTL.
    pub cache_is_stale: bool,
}

/// What a background refresh does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshKind {
    /// The quick rows were painted: list the full catalog and adopt it.
    AdoptFull,
    /// The cache was stale: force a listing and adopt it, one at a time.
    Ttl,
}

/// A background refresh, run by the host later through [`run_catalog_refresh`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CatalogRefresh {
    pub kind: CatalogKind,
    pub how: RefreshKind,
}

fn models_of(value: &Value) -> Option<Vec<Value>> {
    value.as_array().cloned()
}

fn list(host: &mut dyn PickerHost, kind: CatalogKind, params: Value) -> Result<Option<Vec<Value>>, String> {
    host.store_call(kind.method(), json!([params])).map(|value| models_of(&value))
}

/// `loadCatalog(options, paintLoading)`: resolves the rows to paint. `paint_loading` runs when a load is needed. `None` after
/// a reported load failure.
pub fn load_catalog(host: &mut dyn PickerHost, options: &ModelPickerOptions, paint_loading: &mut dyn FnMut(&mut dyn PickerHost)) -> Option<LoadedCatalog> {
    let kind = options.catalog;
    let mut models: Vec<Value> = host.model_caches().entry(kind).rows().to_vec();
    let mut rendered_quick = false;
    let mut full_load_pending = false;
    if models.is_empty() || options.refresh_models {
        paint_loading(host);
        let loaded = if !options.refresh_models && kind != CatalogKind::WebSearch {
            // The quick listing paints first; the full one is adopted afterwards for the next open.
            list(host, kind, json!({"quick": true})).and_then(|quick| {
                if quick.as_ref().is_some_and(|rows| !rows.is_empty()) {
                    rendered_quick = true;
                    full_load_pending = true;
                    Ok(quick)
                } else {
                    list(host, kind, json!({"force": false}))
                }
            })
        } else {
            list(host, kind, json!({"force": options.refresh_models}))
        };
        match loaded {
            Ok(rows) => {
                models = rows.clone().unwrap_or_default();
                let now = host.now_ms();
                host.model_caches().store(kind, rows, now);
            }
            Err(error) => {
                host.push_notice(&format!("could not list models: {error}"), Tone::Error);
                return None;
            }
        }
    }
    // Served straight from a non-empty UI cache: if that cache is older than the TTL, render the cached rows now and quietly
    // force a background refresh so the catalog can't drift stale. Never applies to the web-search cache (its own quick paths
    // refresh differently) or explicit refresh opens.
    let cache_at = host.model_caches().entry(kind).at;
    let cache_is_stale = !models.is_empty()
        && !options.refresh_models
        && kind != CatalogKind::WebSearch
        && !full_load_pending
        && host.now_ms().saturating_sub(cache_at) > MODEL_CACHE_TTL_MS;
    Some(LoadedCatalog { kind, models, rendered_quick, cache_is_stale })
}

/// `scheduleBackgroundRefresh(loaded)`: an open picker keeps the catalog it first rendered. Background refreshes only update
/// the cache, so fresh rows apply on the NEXT open (re-entry) instead of re-sorting the list mid-selection.
pub fn schedule_background_refresh(host: &mut dyn PickerHost, loaded: &LoadedCatalog) {
    if loaded.rendered_quick {
        host.schedule_catalog_refresh(CatalogRefresh { kind: loaded.kind, how: RefreshKind::AdoptFull });
    } else if loaded.cache_is_stale && !host.model_caches().ttl_refresh_in_flight {
        host.model_caches().ttl_refresh_in_flight = true;
        host.schedule_catalog_refresh(CatalogRefresh { kind: loaded.kind, how: RefreshKind::Ttl });
    }
}

/// Runs a scheduled refresh: the listing is adopted into the cache when it has rows, and a failure is dropped (the refresh is
/// advisory; the next open falls back to its own load).
pub fn run_catalog_refresh(host: &mut dyn PickerHost, job: CatalogRefresh) {
    let params = match job.how {
        RefreshKind::AdoptFull => json!({"force": false}),
        RefreshKind::Ttl => json!({"force": true}),
    };
    if let Ok(Some(fresh)) = list(host, job.kind, params) {
        if !fresh.is_empty() {
            let now = host.now_ms();
            host.model_caches().store(job.kind, Some(fresh), now);
        }
    }
    if job.how == RefreshKind::Ttl {
        host.model_caches().ttl_refresh_in_flight = false;
    }
}

/// The boot-time warm-up (`useModelCatalogCache`'s effect, run [`PREFETCH_DELAY_MS`] after start): the provider catalog and
/// the web-search catalog are listed once so those pickers open instantly from cache. Provider models load first so the
/// web-search catalog derives from the full runtime cache instead of the sparse quick rows. A listing that settles after an
/// invalidation (a provider-scope clear) is dropped.
pub fn prefetch_catalogs(host: &mut dyn PickerHost) {
    let seq = host.model_caches().prefetch_seq;
    if let Ok(Some(models)) = host.store_call("listProviderModels", json!([])).map(|value| models_of(&value)) {
        let caches = host.model_caches();
        let adopt = seq == caches.prefetch_seq && !models.is_empty() && caches.provider.models.is_none();
        if adopt {
            let now = host.now_ms();
            host.model_caches().store(CatalogKind::Provider, Some(models), now);
        }
    }
    if let Ok(Some(models)) = host.store_call("listWebSearchModels", json!([])).map(|value| models_of(&value)) {
        if !models.is_empty() && host.model_caches().web_search.models.is_none() {
            let now = host.now_ms();
            host.model_caches().store(CatalogKind::WebSearch, Some(models), now);
        }
    }
}
