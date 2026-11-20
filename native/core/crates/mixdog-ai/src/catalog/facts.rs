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
        if let Some(row) = self.route_provider(provider).and_then(|route| route.cached).and_then(|cached| cached.cached_row(model)) {
            return Some(row);
        }
        // `openai-oauth.mjs` `getCachedModelInfo(model)` is `findCachedCodexModel(model)`: the saved Codex roster's row
        // (an expired file too), which is where an account's models carry their reasoning levels.
        if provider == "openai-oauth" {
            return self.rosters.load().row(provider, model).map(Arc::new);
        }
        None
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
    async fn write_roster(dir: &std::path::Path, file: &str, text: &str) {
        let (path, text) = (dir.join(file), text.to_owned());
        io().write_job(move |lane| {
            mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other)
        })
        .await
        .unwrap();
    }
    /// Node reads the roster file on every call (`readModelsFromCacheFile`): a service built before the file
    /// existed sees it at once, sees a rewrite at once, and holds nothing in between. The file is the one of the identity
    /// the listings noted, and only a roster fetched for it is read.
    #[tokio::test]
    async fn cached_windows_read_the_roster_file_on_every_call() {
        let dir = tempfile::tempdir().unwrap();
        let s = service_in(dir.path(), Vec::new()).await.with_rosters(dir.path().to_path_buf());
        s.roster_accounts.note(super::super::oauth_cache::Roster::Codex, Some("acct-1"));
        let file = super::super::oauth_cache::Roster::Codex.keyed_file("acct-1");
        assert!(s.cached_windows("openai-oauth", "gpt-5.5").is_none(), "no file yet");
        write_roster(dir.path(), "openai-oauth-models.json", r#"{"models":[{"id":"gpt-5.5","contextWindow":64000}]}"#).await;
        assert!(s.cached_windows("openai-oauth", "gpt-5.5").is_none(), "the 1.4.5 file names no account and is not read");
        write_roster(dir.path(), &file, r#"{"account":"acct-1","provenance":"fetched","models":[{"id":"gpt-5.5","contextWindow":272000,"maxContextWindow":1000000}]}"#).await;
        let w = s.cached_windows("openai-oauth", "gpt-5.5").unwrap();
        assert_eq!(serde_json::to_value(w).unwrap(), json!({"contextWindow": 272000.0, "maxContextWindow": 1000000.0}));
        assert!(s.cached_windows("openai-oauth", "other").is_none());
        write_roster(dir.path(), &file, r#"{"account":"acct-1","provenance":"fetched","models":[{"id":"gpt-5.5","contextWindow":128000}]}"#).await;
        let w = s.cached_windows("openai-oauth", "gpt-5.5").unwrap();
        assert_eq!((w.context_window, w.max_context_window), (128000.0, 0.0), "the rewrite is what the next call reads");
        write_roster(dir.path(), &file, "not json").await;
        assert!(s.cached_windows("openai-oauth", "gpt-5.5").is_none(), "a damaged file is no rows");
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


}
