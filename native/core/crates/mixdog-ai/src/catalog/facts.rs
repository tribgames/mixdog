//! Model facts the route layer asks the catalog for, Node-shaped:
//! `lookupModelMeta` (`provider-models/model-meta.mjs`), `getModelMetadataSync`
//! truthiness, `fastCapableFor` / `ultrafastCapableFor`
//! (`runtime-core/model-capabilities.mjs`), `openAiDirectSupportsFast` /
//! `Ultrafast`, `supportsAnthropicFastMode`, `modelSupportsServiceTier` and
//! `cachedRouteWindows` (`runtime-core/route-context-state.mjs`).
//!
//! Every read is one load of the resident snapshot; none refreshes. The rows
//! come from the Rust catalog, so a fact the catalog record does not carry
//! (the `fastPricing` / `ultrafastPricing` rate columns) is absent, and the
//! documented-id fallback decides, exactly as for a row silent on it.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::record::Capability;
use super::record::ModelRecord;
use super::lookup::enrich_model;
use super::record::Thinking;
use super::lookup::Obj;
use super::rosters::CachedWindows;
use super::service::CatalogService;
use super::route_meta::RouteProvider;
use crate::service::admin_route::clean;
use crate::service::admin_route::truthy;

const FAST_CAPABLE_PROVIDERS: [&str; 6] =
    ["anthropic", "anthropic-oauth", "openai", "openai-oauth", "cursor-oauth", "cursor-api"];

fn flag(c: Capability) -> Option<bool> {
    match c {
        Capability::Yes => Some(true),
        Capability::No => Some(false),
        Capability::Unknown => None,
    }
}

/// A catalog record as the row `lookupModelMeta` hands the route layer: the
/// fields it states, camelCase, undeclared ones left out.
fn row_of(record: &ModelRecord) -> Value {
    let mut row = serde_json::Map::new();
    row.insert("id".into(), json!(record.id));
    row.insert("provider".into(), json!(record.provider.as_str()));
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            row.insert(key.into(), value);
        }
    };
    put("displayName", record.display_name.as_ref().map(|v| json!(v)));
    put("family", record.family.as_ref().map(|v| json!(v)));
    put("contextWindow", record.context_window.map(|v| json!(v)));
    put("outputTokens", record.output_tokens.map(|v| json!(v)));
    put("inputCostPerM", record.rates.input.map(|v| json!(v)));
    put("outputCostPerM", record.rates.output.map(|v| json!(v)));
    put("cacheReadCostPerM", record.rates.cache_read.map(|v| json!(v)));
    put("cacheWriteCostPerM", record.rates.cache_write.map(|v| json!(v)));
    put("supportsVision", flag(record.vision).map(Value::Bool));
    put("supportsFunctionCalling", flag(record.function_calling).map(Value::Bool));
    put("supportsReasoning", flag(record.reasoning).map(Value::Bool));
    put("supportsFastMode", flag(record.fast_mode).map(Value::Bool));
    let levels: &[String] = if record.reasoning_efforts.is_empty() {
        match &record.thinking {
            Thinking::Levels(levels) => levels,
            _ => &[],
        }
    } else {
        &record.reasoning_efforts
    };
    if !levels.is_empty() {
        put("reasoningOptions", Some(json!([{"type": "effort", "values": levels}])));
    }
    Value::Object(row)
}

/// `modelMetaByRoute` with `placeholderKeys` (`createModelMetaIndex`): the first answer for a (provider, model) is
/// pinned until a full load remembers the listed row, a fetching lookup replaces a placeholder, or the registry's
/// catalog revision moves and the memo is cleared.
#[derive(Default)]
pub(super) struct MetaMemo {
    /// `observedCatalogRevision`.
    revision: u64,
    rows: HashMap<String, Arc<Value>>,
   /// Keys holding only the bare-id placeholder: a fetching lookup replaces them.
    placeholders: HashSet<String>,
}

impl MetaMemo {
    /// `syncCatalogRevision`'s clearing of `modelMetaByRoute` and `placeholderKeys`.
    pub(super) fn observe(&mut self, revision: u64) {
        if std::mem::replace(&mut self.revision, revision) != revision {
            self.clear();
        }
    }

    pub(super) fn clear(&mut self) {
        self.rows.clear();
        self.placeholders.clear();
    }
}

/// `modelMetaKey`.
fn meta_key(provider: &str, model: &str) -> String {
    format!("{}\n{}", clean(Some(&Value::from(provider))), clean(Some(&Value::from(model))))
}

fn placeholder(provider: &str, model: &str) -> Value {
    json!({"id": model, "provider": provider})
}

/// `{ ...cached, id: cached.id || modelId, provider: providerId }`.
fn normalized(cached: &Value, model: &str, provider: &str) -> Value {
    let mut row = cached.as_object().cloned().unwrap_or_default();
    if !truthy(row.get("id")) {
        row.insert("id".into(), json!(model));
    }
    row.insert("provider".into(), json!(provider));
    Value::Object(row)
}

/// `String(model?.id || model || '').trim()` for a route row or a bare id.
fn model_id(model: &Value) -> String {
    let id = if truthy(model.get("id")) { model.get("id") } else { Some(model) };
    clean(id)
}

/// `modelSupportsServiceTier`: the tier is listed, an additional speed tier,
/// or the model's default.
fn supports_service_tier(model: &Value, tier: &str) -> bool {
    if tier.is_empty() || !model.is_object() {
        return false;
    }
    let listed = |key: &str| model.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    listed("serviceTiers").iter().any(|t| t.get("id").and_then(Value::as_str) == Some(tier))
        || listed("additionalSpeedTiers").iter().any(|t| t.as_str() == Some(tier))
        || model.get("defaultServiceTier").and_then(Value::as_str) == Some(tier)
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// `(?:-\d{4}-\d{2}-\d{2})?$` over what follows a matched id prefix.
fn dated_or_end(rest: &str) -> bool {
    let mut parts = rest.split('-');
    rest.is_empty()
        || (parts.next() == Some("")
            && parts.next().is_some_and(|p| digits(p, 4))
            && parts.next().is_some_and(|p| digits(p, 2))
            && parts.next().is_some_and(|p| digits(p, 2))
            && parts.next().is_none())
}

/// `-\d{4}` right after an id prefix, or the end of the id.
fn year_or_end(rest: &str) -> bool {
    rest.is_empty() || rest.strip_prefix('-').is_some_and(|r| r.len() >= 4 && r.as_bytes()[..4].iter().all(u8::is_ascii_digit))
}

/// `PRE_CATALOG_GPT_56_PLUS` or `PRE_CATALOG_EARLIER_FAST`.
fn documented_fast(id: &str) -> bool {
    const PLUS: [&str; 7] =
        ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
    PLUS.iter().any(|base| id.strip_prefix(base).is_some_and(dated_or_end))
        || id
            .strip_prefix("gpt-5.")
            .is_some_and(|tail| ["5", "4", "4-mini"].iter().any(|v| tail.strip_prefix(v).is_some_and(year_or_end)))
}

/// `PRE_CATALOG_ULTRAFAST`.
fn documented_ultrafast(id: &str) -> bool {
    ["gpt-6-astra", "gpt-6.1-sol"].iter().any(|base| id.strip_prefix(base).is_some_and(dated_or_end))
}

/// `KNOWN_FAST_MODE_MODELS`: `^claude-opus-(?:4-8|5)(?:$|[-@])`.
fn known_anthropic_fast(id: &str) -> bool {
    id.strip_prefix("claude-opus-").is_some_and(|tail| {
        ["4-8", "5"]
            .iter()
            .any(|v| tail.strip_prefix(v).is_some_and(|r| r.is_empty() || r.starts_with(['-', '@'])))
    })
}

/// `SNAPSHOT_SUFFIX` removed: `-\d{4}-\d{2}-\d{2}$`.
fn without_snapshot(id: &str) -> &str {
    let Some(cut) = id.len().checked_sub(11) else { return id };
    match id.get(cut..) {
        Some(tail) if tail.starts_with('-') && dated_or_end(tail) => &id[..cut],
        _ => id,
    }
}

impl CatalogService {
    fn record_of<R>(&self, provider: &str, model: &str, read: impl FnOnce(&ModelRecord) -> R) -> Option<R> {
        let snapshot = self.snapshot();
        snapshot.models_of(&ProviderId::from(provider)).iter().find(|r| r.id == model).map(read)
    }

    /// The provider's listed row of the model, enriched from the catalog layers (`enrichModels`), or the bare
    /// `{id, provider}` placeholder when the provider lists no such model. Not the route memo: the rows a listing
    /// itself builds (`providerModelCacheRow`, the web-search scan) read the listing as it is now.
    pub fn listed_meta(&self, provider: &str, model: &str) -> Value {
        match self.record_of(provider, model, row_of) {
            Some(listed) => self.with_lookup(|lookup| enrich_model(lookup, &listed)),
            None => json!({"id": model, "provider": provider}),
        }
    }

    /// `lookupModelMeta(provider, model)` (`provider-models/model-meta.mjs`): the memo's answer for the route, which
    /// the first lookup pins (see [`MetaMemo`]).
    pub fn model_meta(&self, provider: &str, model: &str) -> Value {
        self.model_meta_in(provider, model, None)
    }

    /// [`Self::model_meta`] with the provider's config entry, which a caller may hold: the rows a custom provider's
    /// config states are the provider's own (`CustomListing` stores them from the moment it is built), so the memo
    /// reads them from the provider and the entry adds nothing.
    pub fn model_meta_in(&self, provider: &str, model: &str, _entry: Option<&Value>) -> Value {
        let key = meta_key(provider, model);
        let mut memo = self.memo();
        if let Some(meta) = memo.rows.get(&key) {
            return (**meta).clone();
        }
        let mut warm = false;
        let meta = match self.route_provider(provider) {
            Some(RouteProvider { listing: Some(_), cached }) => match cached.and_then(|cached| cached.cached_row(model)) {
                // `typeof providerImpl.getCachedModelInfo === 'function'` and it answers.
                Some(cached) => Arc::new(normalized(&cached, model, provider)),
                None => {
                    // Not fetching: the bare placeholder, which a fetching lookup replaces.
                    memo.placeholders.insert(key.clone());
                    warm = true;
                    Arc::new(placeholder(provider, model))
                }
            },
            // No provider, or none with `listModels`: the fallback is pinned for good.
            _ => Arc::new(placeholder(provider, model)),
        };
        memo.rows.insert(key, meta.clone());
        drop(memo);
        // `scheduleProviderModelWarmup()`: the load that follows replaces the placeholder (`remember`).
        if warm {
            self.schedule_warmup();
        }
        (*meta).clone()
    }

    /// `lookupModelMeta(provider, model, { allowFetch: true })`: a pinned row stands (a placeholder does not); the
    /// provider's cached row, else what its `listModels()` returns in this call (`models.find(m => m.id === model)`,
    /// the row unchanged) or the fallback. That answer is pinned only while the registry's catalog revision and the
    /// provider-models load sequence are the ones the fetch began under (`snapshotIsCurrent`); a listing that throws
    /// answers the fallback and pins nothing.
    pub async fn model_meta_fetching(&self, provider: &str, model: &str, _entry: Option<&Value>) -> Value {
        let key = meta_key(provider, model);
        let (revision, seq) = {
            let memo = self.memo();
            if let Some(meta) = memo.rows.get(&key).filter(|_| !memo.placeholders.contains(&key)) {
                return (**meta).clone();
            }
            (self.catalog_revision(), self.load_seq())
        };
        let listing = match self.route_provider(provider) {
            Some(RouteProvider { listing: Some(listing), cached }) => {
                if let Some(cached) = cached.and_then(|cached| cached.cached_row(model)) {
                    let meta = Arc::new(normalized(&cached, model, provider));
                    self.memo().rows.insert(key, meta.clone());
                    return (*meta).clone();
                }
                listing
            }
            _ => {
                let meta = Arc::new(placeholder(provider, model));
                self.memo().rows.insert(key, meta.clone());
                return (*meta).clone();
            }
        };
        let Ok(rows) = listing.list_rows().await else { return placeholder(provider, model) };
        let meta = rows
            .into_iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(model))
            .unwrap_or_else(|| Arc::new(placeholder(provider, model)));
        let mut memo = self.memo();
        if revision == self.catalog_revision() && seq == self.load_seq() {
            memo.placeholders.remove(&key);
            memo.rows.insert(key, meta.clone());
        }
        (*meta).clone()
    }

    /// `providerImpl.getCachedModelInfo(model)` asked of the registered provider itself, outside the memo (the step
    /// judge's ladder asks every provider this way): `None` for a provider without the function or without the row.
    pub fn cached_row(&self, provider: &str, model: &str) -> Option<Arc<Value>> {
        self.route_provider(provider)?.cached?.cached_row(model)
    }

    /// `meta.remember(provider, model, meta)`: the row replaces what the route memo holds.
    pub fn remember_meta(&self, provider: &str, model: &str, meta: Value) {
        let key = meta_key(provider, model);
        let mut memo = self.memo();
        memo.placeholders.remove(&key);
        memo.rows.insert(key, Arc::new(meta));
    }

    /// `modelMetaByRoute.clear()` of `invalidateProviderCaches` (the placeholder keys stay, as in Node).
    pub fn forget_route_meta(&self) {
        self.memo().rows.clear();
    }

    /// The route memo, dropped first when the registry's catalog revision moved (`syncCatalogRevision`).
    fn memo(&self) -> std::sync::MutexGuard<'_, MetaMemo> {
        let mut memo = self.meta.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        memo.observe(self.catalog_revision());
        memo
    }

    /// `getModelMetadataSync(id, provider)`: the merged catalog metadata.
    pub fn sync_meta(&self, id: &str, provider: &str) -> Option<Obj> {
        if id.is_empty() {
            return None;
        }
        self.with_lookup(|lookup| lookup.lookup(id, provider, None))
    }

    /// Whether the catalog has metadata for the model, which is what
    /// `set-route.mjs:57` asks (`getModelMetadataSync(model, provider)` is non-null).
    pub fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.sync_meta(model, provider).is_some()
    }

    /// The `supportsFastMode` the catalog declares for `provider`'s model.
    fn declared_fast(&self, provider: &str, id: &str) -> Option<bool> {
        self.sync_meta(id, provider)?.get("supportsFastMode").and_then(Value::as_bool)
    }

    /// `openAiCatalogMeta(model)`: the metadata of the id, else of the id
    /// without a dated snapshot suffix.
    fn openai_catalog_meta(&self, id: &str) -> Option<Obj> {
        let mut candidates = vec![id];
        if without_snapshot(id) != id {
            candidates.push(without_snapshot(id));
        }
        candidates.into_iter().filter(|c| !c.is_empty()).find_map(|c| self.sync_meta(c, "openai"))
    }

    /// `openAiDirectSupportsFast`: the catalog's declaration decides, a
    /// published Priority rate is the same declaration, and a row silent on
    /// Fast keeps the documented ids.
    fn openai_direct_fast(&self, model: &Value) -> bool {
        let id = model_id(model);
        if let Some(meta) = self.openai_catalog_meta(&id) {
            if let Some(declared) = meta.get("supportsFastMode").and_then(Value::as_bool) {
                return declared;
            }
            if truthy(meta.get("fastPricing")) {
                return true;
            }
        }
        documented_fast(&id)
    }

    /// `fastCapableFor(provider, model, effort, modelParameters)`.
    pub fn fast_capable(&self, provider: &str, model: &Value, effort: Option<&str>, params: &Value) -> bool {
        let p = clean(Some(&Value::from(provider)));
        if !FAST_CAPABLE_PROVIDERS.contains(&p.as_str()) {
            return false;
        }
        if p == "cursor-oauth" || p == "cursor-api" {
            return cursor_fast(model, effort, params);
        }
        if p == "openai-oauth" {
            return supports_service_tier(model, "priority");
        }
        if let Some(own) = model.get("supportsFastMode").and_then(Value::as_bool) {
            return own;
        }
        let id = model_id(model);
        if let Some(declared) = self.declared_fast(&p, &id) {
            return declared;
        }
        match p.as_str() {
            "openai" => self.openai_direct_fast(model),
            _ => self.supports_anthropic_fast_mode(&id),
        }
    }

    /// `supportsAnthropicFastMode(model)`: the catalog's declaration decides;
    /// the id pattern is the offline floor for a model it says nothing about.
    pub fn supports_anthropic_fast_mode(&self, model: &str) -> bool {
        let id = model.to_lowercase().replace('.', "-");
        !id.is_empty() && self.declared_fast("anthropic", &id).unwrap_or_else(|| known_anthropic_fast(&id))
    }

    /// `ultrafastCapableFor(provider, model)`.
    pub fn ultrafast_capable(&self, provider: &str, model: &Value) -> bool {
        match clean(Some(&Value::from(provider))).as_str() {
            "openai" => {
                let id = model_id(model);
                self.openai_catalog_meta(&id).is_some_and(|m| truthy(m.get("ultrafastPricing"))) || documented_ultrafast(&id)
            }
            "openai-oauth" => supports_service_tier(model, "ultrafast"),
            _ => false,
        }
    }

    /// `cachedRouteWindows(provider, model)`: the windows the provider's
    /// persisted roster row states, from the roster snapshot of the last refresh.
    pub fn cached_windows(&self, provider: &str, model: &str) -> Option<CachedWindows> {
        self.rosters.load().windows(provider, model)
    }
}

/// The Cursor branch of `fastCapableFor`: fast variants by effort and parameters.
fn cursor_fast(model: &Value, effort: Option<&str>, params: &Value) -> bool {
    let fast_efforts: Vec<String> = model
        .get("fastEfforts")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| clean(Some(v))).collect())
        .unwrap_or_default();
    if model.get("fastCapable") != Some(&Value::Bool(true)) && fast_efforts.is_empty() {
        return false;
    }
    let selected = clean(effort.map(Value::from).as_ref());
    if let Some(variants) = model.get("parameterVariants").and_then(Value::as_array).filter(|v| !v.is_empty()) {
        let empty = serde_json::Map::new();
        let parameters = params.as_object().unwrap_or(&empty);
        return variants.iter().any(|variant| {
            variant.get("fast").and_then(Value::as_str) == Some("true")
                && (selected.is_empty()
                    || !truthy(variant.get("effort"))
                    || clean(variant.get("effort")) == selected)
                && parameters
                    .iter()
                    .all(|(key, value)| !truthy(variant.get(key)) || clean(variant.get(key)) == clean(Some(value)))
        });
    }
    selected.is_empty() || fast_efforts.is_empty() || fast_efforts.contains(&selected)
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::catalog::lookup;
    use crate::catalog::CatalogSnapshot;
    use crate::catalog::ModelsDevSource;

    pub(in crate::catalog) struct Offline;
    #[async_trait::async_trait]
    impl crate::transport::http::HttpSend for Offline {
        async fn send(
            &self,
            _: mixdog_core_api::domain::provider::WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<
            crate::transport::http::HttpResponse,
            mixdog_core_api::domain::provider::ProviderError,
        > {
            Err(mixdog_core_api::domain::provider::ProviderError::new(
                mixdog_core_api::domain::provider::ErrorKind::Transient,
                mixdog_core_api::domain::provider::DeliveryState::NotSent,
            ))
        }
    }

    pub(in crate::catalog) fn io() -> crate::oauth::CredentialIo {
        let tokens = mixdog_rt::testing::tokens();
        crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
    }

    async fn service_in(dir: &std::path::Path, records: Vec<ModelRecord>) -> CatalogService {
        let mut snapshot = CatalogSnapshot::default();
        for record in records {
            snapshot.models.entry(record.provider.clone()).or_default().push(record);
        }
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io());
        CatalogService::cold_start(snapshot, Vec::new(), metadata).await
    }

    async fn service(records: Vec<ModelRecord>) -> CatalogService {
        let dir = tempfile::tempdir().unwrap();
        service_in(dir.path(), records).await
    }

    /// A service whose overlays and rosters are the recorded Node fixtures.
    async fn golden_service(records: Vec<ModelRecord>) -> CatalogService {
        golden_service_listing(records, Vec::new()).await
    }

    /// [`golden_service`] whose registered providers list through `sources`.
    async fn golden_service_listing(records: Vec<ModelRecord>, sources: Vec<crate::catalog::ModelSource>) -> CatalogService {
        use crate::catalog::ModelsDev;
        let dir = tempfile::tempdir().unwrap();
        let mut snapshot = CatalogSnapshot::default();
        for record in records {
            snapshot.models.entry(record.provider.clone()).or_default().push(record);
        }
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io());
        metadata.set_layer(ModelsDev::from_models_dev(lookup::fixtures::json(lookup::fixtures::MODELS_DEV)).unwrap());
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.path().to_path_buf(), io());
        litellm.set_layer(ModelsDev::from_litellm(lookup::fixtures::json(lookup::fixtures::LITELLM)));
        let service = CatalogService::cold_start(snapshot, sources, metadata).await.with_litellm(litellm).await;
        service.rosters.store(Arc::new(lookup::fixtures::rosters()));
        service
    }

    async fn write_roster(dir: &std::path::Path, file: &str, text: &str) {
        let (path, text) = (dir.join(file), text.to_owned());
        io().write_job(move |lane| {
            mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other)
        })
        .await
        .unwrap();
    }

    /// Node reads the roster file on every call (`readModelsFromCacheFile`): a service built before the file
    /// existed sees it at once, sees a rewrite at once, and holds nothing in between.
    #[tokio::test]
    async fn cached_windows_read_the_roster_file_on_every_call() {
        let dir = tempfile::tempdir().unwrap();
        let s = service_in(dir.path(), Vec::new()).await.with_rosters(dir.path().to_path_buf());
        assert!(s.cached_windows("openai-oauth", "gpt-5.5").is_none(), "no file yet");
        write_roster(dir.path(), "openai-oauth-models.json", r#"{"models":[{"id":"gpt-5.5","contextWindow":272000,"maxContextWindow":1000000}]}"#).await;
        let w = s.cached_windows("openai-oauth", "gpt-5.5").unwrap();
        assert_eq!(serde_json::to_value(w).unwrap(), json!({"contextWindow": 272000.0, "maxContextWindow": 1000000.0}));
        assert!(s.cached_windows("openai-oauth", "other").is_none());
        write_roster(dir.path(), "openai-oauth-models.json", r#"{"models":[{"id":"gpt-5.5","contextWindow":128000}]}"#).await;
        let w = s.cached_windows("openai-oauth", "gpt-5.5").unwrap();
        assert_eq!((w.context_window, w.max_context_window), (128000.0, 0.0), "the rewrite is what the next call reads");
        write_roster(dir.path(), "openai-oauth-models.json", "not json").await;
        assert!(s.cached_windows("openai-oauth", "gpt-5.5").is_none(), "a damaged file is no rows");
    }
    fn fast(provider: &str, id: &str, mode: Capability) -> ModelRecord {
        let mut r = ModelRecord::new(provider.into(), id);
        r.fast_mode = mode;
        r
    }

    #[test]
    fn documented_ids_match_the_node_patterns() {
        for id in ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-2025", "gpt-5.5-1234x", "gpt-6-sol-2026-01-02", "gpt-5.6-terra"] {
            assert!(documented_fast(id), "{id}");
        }
        for id in ["gpt-5.3", "gpt-5.5x", "gpt-5.4-mini-1", "gpt-6-sol-2026-01", "gpt-5.6", "xgpt-5.5"] {
            assert!(!documented_fast(id), "{id}");
        }
        assert!(documented_ultrafast("gpt-6.1-sol-2026-01-02"));
        assert!(!documented_ultrafast("gpt-6-luna"));
        assert!(known_anthropic_fast("claude-opus-4-8-20260101") && known_anthropic_fast("claude-opus-5@x"));
        assert!(!known_anthropic_fast("claude-opus-4-80") && !known_anthropic_fast("claude-opus-4-7"));
        assert_eq!(without_snapshot("gpt-5-2025-08-07"), "gpt-5");
        assert_eq!(without_snapshot("gpt-5-20250807"), "gpt-5-20250807");
    }

    #[tokio::test]
    async fn fast_capable_orders_the_declarations_as_node_does() {
        let s = golden_service(Vec::new()).await;
        let none = json!({});
        // The route row's own flag first.
        assert!(!s.fast_capable("anthropic", &json!({"id": "claude-opus-5", "supportsFastMode": false}), None, &none));
        assert!(s.fast_capable("anthropic-oauth", &json!({"id": "claude-nova-9", "supportsFastMode": true}), None, &none));
        // Then the catalog, then a published Priority rate, then the documented ids.
        assert!(s.fast_capable("anthropic", &json!({"id": "claude-opus-5"}), None, &none));
        assert!(!s.fast_capable("openai", &json!({"id": "gpt-5.2"}), None, &none));
        assert!(s.fast_capable("openai", &json!({"id": "gpt-5.4"}), None, &none));
        assert!(s.fast_capable("openai", &json!("gpt-5.4-mini"), None, &none));
        assert!(!s.fast_capable("openai", &json!({"id": "unknown"}), None, &none));
        assert!(!s.fast_capable("grok-oauth", &json!({"id": "x", "supportsFastMode": true}), None, &none));
        let tiers = json!({"id": "m", "serviceTiers": [{"id": "priority"}]});
        assert!(s.fast_capable("openai-oauth", &tiers, None, &none));
        assert!(!s.ultrafast_capable("openai-oauth", &tiers));
        assert!(s.ultrafast_capable("openai-oauth", &json!({"additionalSpeedTiers": ["ultrafast"]})));
        assert!(s.ultrafast_capable("openai", &json!({"id": "gpt-6-astra"})));
        assert!(!s.ultrafast_capable("anthropic", &json!({"id": "gpt-6-astra"})));
    }

    #[tokio::test]
    async fn cursor_fast_follows_variants_and_efforts() {
        let s = service(Vec::new()).await;
        let model = json!({"id": "c", "fastCapable": true, "fastEfforts": ["low", "high"]});
        assert!(s.fast_capable("cursor-oauth", &model, Some("high"), &json!({})));
        assert!(!s.fast_capable("cursor-oauth", &model, Some("medium"), &json!({})));
        assert!(s.fast_capable("cursor-api", &model, None, &json!({})));
        assert!(!s.fast_capable("cursor-oauth", &json!({"id": "c"}), None, &json!({})));
        let variants = json!({"id": "c", "fastCapable": true, "parameterVariants": [
            {"fast": "true", "effort": "high", "thinking": "on"},
            {"fast": "false", "effort": "low"}
        ]});
        assert!(s.fast_capable("cursor-oauth", &variants, Some("high"), &json!({"thinking": "on"})));
        assert!(!s.fast_capable("cursor-oauth", &variants, Some("high"), &json!({"thinking": "off"})));
        assert!(!s.fast_capable("cursor-oauth", &variants, Some("low"), &json!({})));
    }

    #[tokio::test]
    async fn meta_is_the_row_or_the_bare_placeholder() {
        let mut row = fast("openai", "gpt-5.5", Capability::Yes);
        row.context_window = Some(272_000);
        row.reasoning_efforts = vec!["low".into(), "high".into()];
        let s = golden_service(vec![row]).await;
        let meta = s.listed_meta("openai", "gpt-5.5");
        // The provider's listed limits stand; the catalog layers fill the rest.
        assert_eq!(meta["contextWindow"], 272_000);
        assert_eq!(meta["supportsFastMode"], true);
        assert_eq!(meta["supportsVision"], true);
        assert_eq!(meta["inputCostPerM"], 1.25);
        assert_eq!(meta["reasoningOptions"], json!([{"type": "effort", "values": ["low", "high"]}]));
        assert_eq!(s.listed_meta("openai", "nope"), json!({"id": "nope", "provider": "openai"}));
        assert_eq!(s.model_meta("openai", "nope"), json!({"id": "nope", "provider": "openai"}));
        assert!(s.catalog_knows("gpt-5.5", "openai"));
        assert!(!s.catalog_knows("gpt-5.5", "anthropic") && !s.catalog_knows("", "openai"));
        assert_eq!(s.cached_windows("openai-oauth", "gpt-5.5").unwrap().max_context_window, 1_000_000.0);
    }

    /// A row's own listed prices are the row's: the picker's meta for a known
    /// model carries the catalog's rate (`enrichModels`), and the ledger prices
    /// from the same lookup (`getModelMetadataSync`), which reads no listed price.
    #[tokio::test]
    async fn a_listed_price_never_moves_the_ledgers_cost() {
        let usage: crate::catalog::UsageArgs = serde_json::from_value(json!({
            "provider": "openai", "model": "gpt-5.5", "inputTokens": 1_000_000, "outputTokens": 0
        }))
        .unwrap();
        let plain = Arc::new(golden_service(Vec::new()).await).pricing().unwrap().price_usage(&usage);
        let mut row = fast("openai", "gpt-5.5", Capability::Yes);
        row.rates.input = Some(99.0);
        let s = Arc::new(golden_service(vec![row]).await);
        assert_eq!(s.listed_meta("openai", "gpt-5.5")["inputCostPerM"], 1.25);
        let priced = s.pricing().unwrap().price_usage(&usage);
        assert_eq!(priced.cost_usd, plain.cost_usd);
        assert_eq!(priced.cost_usd, Some(1.25));
    }

    /// Every (provider, model) of the Node golden: `catalog_knows`
    /// (`set-route.mjs:57`'s `getModelMetadataSync` truthiness),
    /// `fastCapableFor` and `ultrafastCapableFor`.
    #[tokio::test]
    async fn knowledge_and_fast_tiers_equal_node() {
        let s = golden_service(Vec::new()).await;
        let golden = lookup::fixtures::json(lookup::fixtures::GOLDEN);
        let none = json!({});
        let mut failures = Vec::new();
        for row in golden["rows"].as_array().unwrap() {
            let provider = row["provider"].as_str().unwrap();
            let id = row["id"].as_str().unwrap();
            let got = (s.catalog_knows(id, provider), s.fast_capable(provider, &json!({"id": id}), None, &none), s.ultrafast_capable(provider, &json!({"id": id})));
            let want = (row["known"].as_bool().unwrap(), row["fast"].as_bool().unwrap(), row["ultrafast"].as_bool().unwrap());
            if got != want {
                failures.push(format!("{provider:?} {id:?}: rust {got:?} node {want:?}"));
            }
        }
        assert!(failures.is_empty(), "{} differ; first:\n{}", failures.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
        // The golden must reach both answers of every check.
        let rows = golden["rows"].as_array().unwrap();
        for key in ["known", "fast", "ultrafast"] {
            assert!(rows.iter().any(|r| r[key] == true) && rows.iter().any(|r| r[key] == false), "{key}");
        }
    }

    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering::SeqCst;

    /// A scripted provider of the Node recorder (`record-model-meta.mjs`): `cached` is its `getCachedModelInfo` rows
    /// (present when the provider's class has the function), `list_rows` what `listModels()` returns.
    #[derive(Clone)]
    struct Scripted {
        listed: bool,
        cached: Option<Arc<std::sync::Mutex<Vec<Arc<Value>>>>>,
        list_rows: Vec<Arc<Value>>,
        throws: bool,
        during_list: Option<String>,
        calls: Arc<AtomicU64>,
        revision: Arc<AtomicU64>,
        seq: Arc<AtomicU64>,
    }

    impl super::super::CachedModelInfo for Scripted {
        fn cached_row(&self, model: &str) -> Option<Arc<Value>> {
            let rows = self.cached.as_ref()?.lock().unwrap();
            rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(model)).cloned()
        }
    }

    #[async_trait::async_trait]
    impl super::super::ListedRows for Scripted {
        async fn list_rows(&self) -> Result<Vec<Arc<Value>>, ()> {
            self.calls.fetch_add(1, SeqCst);
            match self.during_list.as_deref() {
                Some("bumpRevision") => drop(self.revision.fetch_add(1, SeqCst)),
                // `invalidateProviderCaches` inside the listing: the sequence moves (the memo it clears is
                // asserted by the top-level `invalidate` op).
                Some("invalidate") => drop(self.seq.fetch_add(1, SeqCst)),
                _ => {}
            }
            if self.throws { Err(()) } else { Ok(self.list_rows.clone()) }
        }
    }

    /// Every scenario Node's `lookupModelMeta` was recorded on (`oracles/model-meta.json`, produced by
    /// `benchmarks/rust-core/recorders/record-model-meta.mjs` from `b6f10295a`) answers the same here: the cold
    /// placeholder stays pinned across the startup listing, a provider with `getCachedModelInfo` answers its row
    /// normalized (`id`, `provider`) where one without it answers the marked placeholder and a fetch returns the listed
    /// row untouched, a throwing or superseded fetch pins nothing, and the revision / invalidation clear the memo. The
    /// scenarios with a full load are replayed where the load lives (`ai_admin/model_list_tests.rs`).
    #[tokio::test]
    async fn the_route_memo_answers_what_node_recorded() {
        let golden = crate::providers::listing_row::testing::fixture("oracles/model-meta.json");
        let rows = |value: &Value| -> Vec<Arc<Value>> { value.as_array().map(|a| a.iter().cloned().map(Arc::new).collect()).unwrap_or_default() };
        let mut replayed = 0;
        for scenario in golden["scenarios"].as_array().unwrap() {
            if scenario["ops"].as_array().unwrap().iter().any(|op| op["op"] == "load") {
                continue;
            }
            let name = scenario["name"].as_str().unwrap();
            let (revision, seq, calls) = (Arc::new(AtomicU64::new(1)), Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
            let mut providers: HashMap<String, Scripted> = HashMap::new();
            for (id, spec) in scenario["providers"].as_object().unwrap() {
                let cached = spec.get("cached").map(|c| Arc::new(std::sync::Mutex::new(rows(c))));
                let list_rows = spec.get("listRows").or(spec.get("cached")).map(&rows).unwrap_or_default();
                providers.insert(
                    id.clone(),
                    Scripted {
                        listed: spec["list"] == true,
                        cached,
                        list_rows,
                        throws: spec["throws"] == true,
                        during_list: spec["duringList"].as_str().map(str::to_owned),
                        calls: calls.clone(),
                        revision: revision.clone(),
                        seq: seq.clone(),
                    },
                );
            }
            let s = golden_service(Vec::new()).await;
            let (r, q, table) = (revision.clone(), seq.clone(), providers.clone());
            s.bind_revision(move || r.load(SeqCst));
            s.bind_load_seq(move || q.load(SeqCst));
            let warmups = Arc::new(AtomicU64::new(0));
            let scheduled = warmups.clone();
            s.bind_warmup(move || {
                scheduled.fetch_add(1, SeqCst);
            });
            s.bind_providers(Arc::new(move |name| {
                let p = table.get(name)?;
                Some(super::super::RouteProvider {
                    cached: p.cached.is_some().then(|| Arc::new(p.clone()) as Arc<dyn super::super::CachedModelInfo>),
                    listing: p.listed.then(|| Arc::new(p.clone()) as Arc<dyn super::super::ListedRows>),
                })
            }));
            for (n, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
                let what = format!("{name} op {n} {}", op["op"]);
                match op["op"].as_str().unwrap() {
                    "lookup" => {
                        let (provider, model) = (op["provider"].as_str().unwrap(), op["model"].as_str().unwrap());
                        let got = if op["allowFetch"] == true {
                            s.model_meta_fetching(provider, model, None).await
                        } else {
                            s.model_meta(provider, model)
                        };
                        assert_eq!(got, op["expect"], "{what} {provider}/{model}");
                    }
                    "startupListing" | "setCached" => {
                        *providers[op["provider"].as_str().unwrap()].cached.as_ref().unwrap().lock().unwrap() = rows(&op["rows"]);
                    }
                    "bumpRevision" => drop(revision.fetch_add(1, SeqCst)),
                    "invalidate" => {
                        seq.fetch_add(1, SeqCst);
                        s.forget_route_meta();
                    }
                    other => panic!("{what}: {other}"),
                }
                assert_eq!(calls.load(SeqCst), op["listCalls"], "{what}: listModels calls");
                assert_eq!(warmups.load(SeqCst), op["warmups"], "{what}: the warm-up is scheduled (scheduleProviderModelWarmup)");
            }
            replayed += 1;
        }
        assert_eq!(replayed, 9, "11 scenarios, 2 of them with a full load");
    }
    /// A record that kept no stored row is never a found `{ id }`: `stored_row` says `Null`, a store never holds it (the
    /// model is a cache miss, the marked placeholder), and a listing is searched like Node's `models.find(m => m?.id ===
    /// modelId)`: an unrelated rowless record never suppresses a hit, and a successful miss answers and pins the
    /// fallback (only a listing that throws pins nothing, as the recorded `placeholder-then-fetch-hit-empty-thrown` shows).
    #[tokio::test]
    async fn a_record_without_a_stored_row_is_not_a_candidate_of_the_find() {
        let plain = |id: &str| mixdog_core_api::domain::provider::ModelRecord::new(id);
        assert!(super::super::stored_row(&"p".into(), plain("m")).is_null());

        let store = Arc::new(super::super::RowStore::default());
        store.replace(vec![Arc::new(Value::Null), Arc::new(json!({"id": "kept"}))]);
        assert!(store.find("kept").is_some() && store.find("m").is_none());
        store.upsert(Arc::new(Value::Null));
        store.upsert(Arc::new(json!({"id": "kept", "name": "again"})));
        assert_eq!(store.find("kept").unwrap()["name"], "again");

        let mut enriched = plain("hit");
        enriched.enriched = mixdog_core_api::domain::provider::EnrichedRow(json!({"id": "hit", "supportsWebSearch": true}).as_object().cloned());
        let mut provider = mixdog_core_api::domain::mock::MockProvider::new([]);
        provider.models = vec![plain("rowless"), enriched];
        let adapter: Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter> = Arc::new(provider);
        let rows = super::super::AdapterRows { provider: "p".into(), adapter: adapter.clone() };
        assert_eq!(super::super::ListedRows::list_rows(&rows).await.unwrap().len(), 1, "the rowless record is not a candidate");

        let s = golden_service(Vec::new()).await;
        s.bind_providers(Arc::new(move |_| {
            Some(super::super::RouteProvider {
                cached: None,
                listing: Some(Arc::new(super::super::AdapterRows { provider: "p".into(), adapter: adapter.clone() })),
            })
        }));
        assert_eq!(s.model_meta_fetching("p", "hit", None).await, json!({"id": "hit", "supportsWebSearch": true}));
        assert_eq!(s.model_meta_fetching("p", "rowless", None).await, json!({"id": "rowless", "provider": "p"}));
        assert!(pinned(&s, "rowless"), "a successful miss pins the fallback");
    }

    fn pinned(s: &CatalogService, id: &str) -> bool {
        s.meta.lock().unwrap().rows.contains_key(&meta_key("p", id))
    }
    /// `cached_row` is `getCachedModelInfo` of the registered provider, outside the memo: the stored row as stored, and
    /// nothing for a provider without the function or the row.
    #[tokio::test]
    async fn the_cached_row_is_the_registered_providers_own() {
        let store = Arc::new(super::super::RowStore::default());
        store.replace(vec![Arc::new(json!({"id": "m", "supportsWebSearch": true}))]);
        struct Cached(Arc<super::super::RowStore>);
        impl super::super::CachedModelInfo for Cached {
            fn cached_row(&self, model: &str) -> Option<Arc<Value>> {
                self.0.find(model)
            }
        }
        let s = golden_service(Vec::new()).await;
        s.bind_providers(Arc::new(move |name| {
            Some(super::super::RouteProvider {
                cached: (name == "with").then(|| Arc::new(Cached(store.clone())) as Arc<dyn super::super::CachedModelInfo>),
                listing: None,
            })
        }));
        assert_eq!(s.cached_row("with", "m").as_deref(), Some(&json!({"id": "m", "supportsWebSearch": true})));
        assert!(s.cached_row("with", "other").is_none() && s.cached_row("without", "m").is_none() && s.cached_row("ghost", "m").is_none());
    }}
