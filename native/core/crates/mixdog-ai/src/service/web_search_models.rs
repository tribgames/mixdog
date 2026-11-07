//! The native web-search model list: Node's `collectWebSearchProviderModels`
//! (`session-runtime/provider-models/web-search-catalog.mjs`) with the quick rows it falls back to
//! (`quick-model-rows/web-search-rows.mjs`, `quick-web-search-models.mjs`) and the catalog-revision
//! rule that drops its cache (`provider-models/model-meta.mjs` `syncCatalogRevision`).
//!
//! Four tiers answer a read, as in Node: a forced scan of the enabled providers; the adopted cache;
//! the rows of the provider-models cache (a catalog read already made); else the quick rows (live
//! rosters, else the public catalog's newest, plus the configured and current routes). Only the
//! scan and the quick rows are adopted. Client mode (`MIXDOG_MODEL_PROXY=client`) has no cache of
//! its own: the desktop-backed catalog is read each time.
//!
//! Everything a tier reads that has an owner of its own is behind [`QuickFacts`] / [`CatalogFacts`]
//! (the row builder, hydration, sort, capability check, rosters, the registry); the golden
//! (`fixtures/web-search-models`) fixes the orchestration over scripted ones.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_js::time::date_parse;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::admin_models::is_selectable_llm_model;
use super::routes::WEB_SEARCH_DEFAULT_MODEL;
use super::routes::WEB_SEARCH_DEFAULT_PROVIDER;
use super::routes::clean;
use super::routes::is_web_search_capable_provider;
use super::routes::normalize_web_search_provider_id;
use super::routes::normalize_web_search_route_config;
use super::routes::truthy;

const QUICK_ROWS_PER_PROVIDER: usize = 5;
const DEFAULT_TOOL_TYPE: &str = "web_search";

/// What the quick rows read.
pub trait QuickFacts: Send + Sync {
    /// `getRoute()`: the Main route.
    fn route(&self) -> Value;
    /// `displayConfig().providers`, in configuration order.
    fn display_providers(&self) -> Vec<(String, Value)>;
    /// `displayConfig().webSearchRoute`.
    fn display_web_search_route(&self) -> Value;
    /// `getWebSearchRoute()`.
    fn web_search_route_state(&self) -> Value;
    /// `providerCachedModelsSync(provider)`: the provider's live roster.
    fn cached_models(&self, provider: &str) -> Vec<Value>;
    /// `getModelsDevProviderModelsSync(provider)`.
    fn models_dev(&self, provider: &str) -> Option<Map<String, Value>>;
    /// `hydratedModel(provider, model)`.
    fn hydrated(&self, provider: &str, model: &Value) -> Value;
    /// `providerModelCacheRow(provider, model)`.
    fn cache_row(&self, provider: &str, model: &Value) -> Value;
    /// `webSearchCapableFor(provider, model)`.
    fn capable_for(&self, provider: &str, model: &Value) -> bool;
    /// `currentMainWebSearchModelMeta()`.
    fn main_model_meta(&self) -> Option<Value>;
    /// `sortProviderModels(rows)`.
    fn sort(&self, rows: Vec<Value>) -> Vec<Value>;
}

/// `currentMainWebSearchModelMeta`: the Main route over the provider's catalog row for it.
pub fn main_model_meta(route: &Value, catalog_row: Option<&Value>) -> Option<Value> {
    truthy(route.get("provider"))?;
    let model = truthy(route.get("model"))?;
    let mut out = catalog_row.and_then(Value::as_object).cloned().unwrap_or_default();
    for (key, value) in route.as_object()? {
        out.insert(key.clone(), value.clone());
    }
    out.insert("id".into(), model.clone());
    out.insert("display".into(), model.clone());
    out.insert("name".into(), model.clone());
    Some(Value::Object(out))
}

const CUSTOM_DECLARED_FIELDS: [&str; 9] = [
    "supportsVision",
    "supportsReasoning",
    "reasoningOptions",
    "reasoningLevels",
    "reasoningContentField",
    "providerName",
    "hidden",
    "manual",
    "customReasoning",
];

/// `hydratedModel(provider, model)` over `meta`, the offline catalog metadata of the model.
pub fn hydrated_model(provider: &str, model: &Value, meta: &Value) -> Value {
    let model_id = clean(Some(truthy(model.get("id")).unwrap_or(model)));
    let base = if model.is_object() { model.clone() } else { json!({ "id": model_id }) };
    let flag = |key: &str| base.get(key) == Some(&Value::Bool(true)) || meta.get(key) == Some(&Value::Bool(true));
    let first = |key: &str| truthy(meta.get(key)).or_else(|| truthy(base.get(key))).cloned().unwrap_or(Value::Null);
    let mut out = base.as_object().cloned().unwrap_or_default();
    out.insert("contextWindow".into(), first("contextWindow"));
    out.insert("outputTokens".into(), first("outputTokens"));
    for key in ["supportsWebSearch", "supportsFunctionCalling", "supportsPromptCaching", "supportsReasoning"] {
        out.insert(key.into(), Value::Bool(flag(key)));
    }
    let options = match base.get("reasoningOptions") {
        Some(Value::Array(own)) if !own.is_empty() => Value::Array(own.clone()),
        _ => truthy(meta.get("reasoningOptions")).cloned().unwrap_or_else(|| json!([])),
    };
    out.insert("reasoningOptions".into(), options);
    out.insert(
        "reasoningContentField".into(),
        truthy(base.get("reasoningContentField")).or_else(|| truthy(meta.get("reasoningContentField"))).cloned().unwrap_or(Value::Null),
    );
    // A custom provider's effective row is authoritative: every field it states wins over the metadata.
    if provider.starts_with("custom-") && base.is_object() {
        let mut declared = Map::new();
        for key in CUSTOM_DECLARED_FIELDS {
            if let Some(value) = base.get(key) {
                declared.insert(key.to_owned(), value.clone());
            }
        }
        if declared.contains_key("reasoningLevels") && !declared.contains_key("reasoningOptions") {
            declared.insert("reasoningOptions".into(), json!([]));
        }
        out.extend(declared);
    }
    Value::Object(out)
}

/// `quickWebSearchModels(provider, models)`: the newest rows of the public catalog.
pub fn quick_web_search_models(models: Option<&Map<String, Value>>) -> Vec<Value> {
    let Some(models) = models else { return Vec::new() };
    let mut rows: Vec<(f64, Value)> = models
        .iter()
        .map(|(id, row)| {
            let name = truthy(row.get("name")).cloned().unwrap_or_else(|| Value::String(id.clone()));
            let release = truthy(row.get("release_date")).cloned().unwrap_or(Value::Null);
            let at = release.as_str().map_or(0.0, |text| {
                let at = date_parse(text);
                if at.is_nan() { 0.0 } else { at }
            });
            (at, json!({ "id": id, "display": name, "releaseDate": release }))
        })
        .collect();
    // Newest first; a stable sort keeps the catalog's order among equals.
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    rows.into_iter().take(QUICK_ROWS_PER_PROVIDER).map(|(_, row)| row).collect()
}

fn provider_of(row: &Value) -> String {
    normalize_web_search_provider_id(row.get("provider").and_then(Value::as_str).unwrap_or(""))
}

fn tagged(mut row: Value, provider: String) -> Value {
    let tool = truthy(row.get("webSearchToolType")).cloned().unwrap_or_else(|| DEFAULT_TOOL_TYPE.into());
    if let Some(object) = row.as_object_mut() {
        object.insert("provider".into(), provider.into());
        object.insert("webSearchCapable".into(), true.into());
        object.insert("webSearchToolType".into(), tool);
    }
    row
}

/// `addDefaultWebSearchModel`: the "Default" row that follows the Main model.
pub fn add_default(facts: &dyn QuickFacts, rows: &mut Vec<Value>, seen: &mut HashSet<String>) {
    let route = facts.route();
    let Some(main) = facts.main_model_meta() else { return };
    if !facts.capable_for(route.get("provider").and_then(Value::as_str).unwrap_or(""), &main) {
        return;
    }
    if !seen.insert(format!("{WEB_SEARCH_DEFAULT_PROVIDER}:{WEB_SEARCH_DEFAULT_MODEL}")) {
        return;
    }
    let text = |key: &str| route.get(key).and_then(Value::as_str).unwrap_or("undefined").to_owned();
    rows.push(json!({
        "id": WEB_SEARCH_DEFAULT_MODEL,
        "provider": WEB_SEARCH_DEFAULT_PROVIDER,
        "display": "Default",
        "name": "Default",
        "description": format!("Use current main model: {}/{}", text("provider"), text("model")),
        "supportsWebSearch": true,
        "webSearchCapable": true,
        "webSearchToolType": DEFAULT_TOOL_TYPE,
        "mode": "chat",
    }));
}

/// `addQuickWebSearchModel`.
pub fn add_quick(facts: &dyn QuickFacts, rows: &mut Vec<Value>, seen: &mut HashSet<String>, provider: &str, model: &Value) {
    let provider_name = normalize_web_search_provider_id(provider);
    let model_id = clean(Some(truthy(model.get("id")).unwrap_or(model)));
    if provider_name.is_empty() || model_id.is_empty() || !is_web_search_capable_provider(&provider_name) {
        return;
    }
    let key = format!("{provider_name}:{model_id}");
    if seen.contains(&key) {
        return;
    }
    let resolved = facts.hydrated(&provider_name, model);
    let exact = |field: &str| resolved.get(field) == Some(&Value::Bool(true));
    let text = |first: &str, second: &str| {
        truthy(resolved.get(first)).or_else(|| truthy(resolved.get(second))).cloned().unwrap_or_else(|| Value::String(model_id.clone()))
    };
    let mut arg = Map::new();
    arg.insert("id".into(), model_id.clone().into());
    arg.insert("name".into(), text("name", "display"));
    arg.insert("display".into(), text("display", "name"));
    arg.insert("contextWindow".into(), truthy(resolved.get("contextWindow")).cloned().unwrap_or(Value::Null));
    arg.insert("outputTokens".into(), truthy(resolved.get("outputTokens")).cloned().unwrap_or(Value::Null));
    arg.insert("latest".into(), exact("latest").into());
    // Only what the source row itself declares; the capability check adds the catalog's row and the id fallback.
    if let Some(flag) = model.get("supportsWebSearch").filter(|v| v.is_boolean()) {
        arg.insert("supportsWebSearch".into(), flag.clone());
    }
    for key in ["supportedTools", "tools"] {
        if let Some(list) = model.get(key).filter(|v| v.is_array()) {
            arg.insert(key.into(), list.clone());
        }
    }
    if let Some(caps) = model.get("capabilities").filter(|v| v.is_object() || v.is_array()) {
        arg.insert("capabilities".into(), caps.clone());
    }
    arg.insert("supportsFunctionCalling".into(), exact("supportsFunctionCalling").into());
    arg.insert("supportsPromptCaching".into(), exact("supportsPromptCaching").into());
    arg.insert("supportsReasoning".into(), exact("supportsReasoning").into());
    if let Some(levels) = resolved.get("reasoningLevels").filter(|v| v.is_array()) {
        arg.insert("reasoningLevels".into(), levels.clone());
    }
    arg.insert("reasoningOptions".into(), resolved.get("reasoningOptions").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([])));
    arg.insert("reasoningContentField".into(), truthy(resolved.get("reasoningContentField")).cloned().unwrap_or(Value::Null));
    arg.insert("mode".into(), "chat".into());
    let row = facts.cache_row(&provider_name, &Value::Object(arg));
    if row.get("supportsWebSearch") != Some(&Value::Bool(true)) {
        return;
    }
    seen.insert(key);
    rows.push(tagged(row, provider_name));
}

/// `webSearchModelsFromRows`: the rows that can search, provider ids normalized, sorted.
pub fn rows_from(facts: &dyn QuickFacts, rows: &[Value]) -> Vec<Value> {
    let kept = rows
        .iter()
        .filter(|row| row.get("supportsWebSearch") == Some(&Value::Bool(true)))
        .map(|row| tagged(row.clone(), provider_of(row)))
        .collect();
    facts.sort(kept)
}

/// `webSearchRowsWithDefault`: the default row first, then the rows once each.
pub fn rows_with_default(facts: &dyn QuickFacts, rows: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    add_default(facts, &mut out, &mut seen);
    for row in rows {
        let provider = provider_of(row);
        let model = clean(Some(truthy(row.get("id")).or_else(|| truthy(row.get("model"))).unwrap_or(&Value::Null)));
        if provider == WEB_SEARCH_DEFAULT_PROVIDER && model.to_lowercase() == WEB_SEARCH_DEFAULT_MODEL {
            continue;
        }
        let key = format!("{provider}:{model}");
        if provider.is_empty() || model.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(row.clone());
    }
    out
}

/// `quickWebSearchProviderModelRows`.
pub fn quick_provider_rows(facts: &dyn QuickFacts) -> Vec<Value> {
    let route = facts.route();
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    add_default(facts, &mut rows, &mut seen);
    for (name, config) in facts.display_providers() {
        let provider = normalize_web_search_provider_id(&name);
        if truthy(config.get("enabled")).is_none() || !is_web_search_capable_provider(&provider) {
            continue;
        }
        let cached = facts.cached_models(&provider);
        let quick = if cached.is_empty() { quick_web_search_models(facts.models_dev(&provider).as_ref()) } else { cached };
        for model in &quick {
            add_quick(facts, &mut rows, &mut seen, &provider, model);
        }
    }
    let none = json!({});
    let configured = [facts.display_web_search_route(), facts.web_search_route_state()]
        .iter()
        .find_map(|candidate| normalize_web_search_route_config(candidate, &none).ok().flatten());
    if let Some(route_config) = configured {
        let (provider, model) = (route_config.get("provider"), route_config.get("model"));
        if let (Some(provider), Some(model)) = (truthy(provider), truthy(model)) {
            let id = json!({ "id": model, "display": model });
            add_quick(facts, &mut rows, &mut seen, provider.as_str().unwrap_or_default(), &id);
        }
    }
    if let Some(main) = facts.main_model_meta() {
        let provider = route.get("provider").and_then(Value::as_str).unwrap_or("");
        if facts.capable_for(provider, &main) {
            add_quick(facts, &mut rows, &mut seen, provider, &main);
        }
    }
    rows_from(facts, &rows)
}

/// What the catalog tiers read.
#[async_trait]
pub trait CatalogFacts: Send + Sync {
    fn quick(&self) -> &dyn QuickFacts;
    /// `modelProxyClientMode()`.
    fn client_mode(&self) -> bool;
    /// `catalogRevision(reg())`.
    fn revision(&self) -> f64;
    /// `caches.providerModelsCache.models`.
    fn models_cache(&self) -> Option<Vec<Value>>;
    /// `rows.providerModelsFromCacheRows(rows)`.
    fn from_cache_rows(&self, rows: &[Value]) -> Vec<Value>;
    /// `collectProviderModels({ force })`; `Err` is its rejection.
    async fn collect_provider_models(&self, force: bool) -> Result<Vec<Value>, String>;
    /// `awaitKeychainPrewarm()` and `ensureFullConfig()`; `Err` is a throw, which nothing catches.
    async fn prepare(&self) -> Result<(), String>;
    /// `config().providers`, in configuration order.
    fn providers_config(&self) -> Vec<(String, Value)>;
    /// `ensureProvidersReady(config().providers)`; `Err` is a rejection, which nothing catches
    /// (`loadWebSearchProviderModelsFresh` awaits it outside any `try`).
    async fn ensure_providers_ready(&self) -> Result<(), String>;
    /// Whether `reg().getProvider(name)` has a `listModels`.
    fn can_list(&self, name: &str) -> bool;
    /// `provider._refreshModelCache()`; `None` when the provider has none. `Err` is a throw.
    async fn refresh_models(&self, name: &str) -> Option<Result<Value, ()>>;
    /// `provider.listModels()`. `Err` is a throw.
    async fn list_models(&self, name: &str) -> Result<Value, ()>;
    /// `meta.remember(provider, id, row)`.
    fn remember(&self, provider: &str, id: &str, row: &Value);
}

struct State {
    models: Option<Vec<Value>>,
    revision: f64,
}

/// `createWebSearchCatalog`: the adopted cache and the revision it was built under.
pub struct WebSearchCatalog<F: CatalogFacts> {
    facts: F,
    state: Mutex<State>,
}

impl<F: CatalogFacts> WebSearchCatalog<F> {
    pub fn new(facts: F) -> Self {
        let revision = facts.revision();
        Self { facts, state: Mutex::new(State { models: None, revision }) }
    }

    /// The rows adopted by the last read.
    pub fn cached(&self) -> Option<Vec<Value>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).models.clone()
    }

    /// `invalidateProviderCaches()`: the adopted rows go.
    pub fn invalidate(&self) {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).models = None;
    }

    /// `syncCatalogRevision()`: a catalog that moved on drops the cache.
    fn sync_revision(&self) {
        let now = self.facts.revision();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if now != state.revision {
            state.revision = now;
            state.models = None;
        }
    }

    fn adopt(&self, rows: Vec<Value>) -> Vec<Value> {
        let out = self.facts.from_cache_rows(&rows);
        self.state.lock().unwrap_or_else(PoisonError::into_inner).models = Some(rows);
        out
    }

    /// `enabledWebSearchProviderConfig`, as names: enabled, search-capable, one per normalized id.
    async fn enabled_providers(&self) -> Result<Vec<String>, String> {
        self.facts.prepare().await?;
        let mut names: Vec<String> = Vec::new();
        for (name, config) in self.facts.providers_config() {
            let provider = normalize_web_search_provider_id(&name);
            if truthy(config.get("enabled")).is_none() || !is_web_search_capable_provider(&provider) {
                continue;
            }
            if !names.contains(&provider) {
                names.push(provider);
            }
        }
        Ok(names)
    }

    /// One provider's search-capable rows; a failing listing yields none.
    async fn scan_provider(&self, name: &str, force: bool) -> Vec<Value> {
        if !self.facts.can_list(name) {
            return Vec::new();
        }
        let mut models = None;
        if force {
            if let Some(Ok(refreshed)) = self.facts.refresh_models(name).await {
                models = Some(refreshed);
            }
        }
        let listed = match models.filter(Value::is_array) {
            Some(listed) => listed,
            None => match self.facts.list_models(name).await {
                Ok(listed) => listed,
                Err(()) => return Vec::new(),
            },
        };
        let Some(listed) = listed.as_array() else { return Vec::new() };
        let mut out = Vec::new();
        for model in listed {
            if truthy(model.get("id")).is_none() || !is_selectable_llm_model(model) {
                continue;
            }
            let row = self.facts.quick().cache_row(name, model);
            if row.get("supportsWebSearch") != Some(&Value::Bool(true)) {
                continue;
            }
            out.push(tagged(row.clone(), provider_of(&row)));
            self.facts.remember(name, &clean(model.get("id")), &row);
        }
        out
    }

    /// `loadWebSearchProviderModelsFresh`.
    async fn fresh(&self, force: bool) -> Result<Vec<Value>, String> {
        let quick = self.facts.quick();
        if self.facts.client_mode() {
            let models = self.facts.collect_provider_models(force).await?;
            return Ok(rows_with_default(quick, &rows_from(quick, &models)));
        }
        let names = self.enabled_providers().await?;
        if names.is_empty() {
            return Ok(Vec::new());
        }
        self.facts.ensure_providers_ready().await?;
        let scans = futures::future::join_all(names.iter().map(|name| self.scan_provider(name, force))).await;
        let mut results = Vec::new();
        let mut seen = HashSet::new();
        add_default(quick, &mut results, &mut seen);
        for row in scans.into_iter().flatten() {
            let key = format!("{}:{}", provider_of(&row), row.get("id").and_then(Value::as_str).unwrap_or_default());
            if seen.insert(key) {
                results.push(row);
            }
        }
        Ok(results)
    }

    /// `collectWebSearchProviderModels({ force })`.
    pub async fn collect(&self, force: bool) -> Result<Vec<Value>, String> {
        let quick = self.facts.quick();
        if self.facts.client_mode() {
            // The main catalog owns caching in client mode; no second cache pins an offline projection.
            let rows = self.fresh(force).await?;
            return Ok(self.facts.from_cache_rows(&rows));
        }
        self.sync_revision();
        if force {
            let rows = self.fresh(true).await?;
            return Ok(self.adopt(rows));
        }
        if let Some(cached) = self.cached() {
            return Ok(self.facts.from_cache_rows(&rows_with_default(quick, &cached)));
        }
        if let Some(models) = self.facts.models_cache() {
            return Ok(self.adopt(rows_with_default(quick, &rows_from(quick, &models))));
        }
        Ok(self.adopt(rows_with_default(quick, &quick_provider_rows(quick))))
    }
}

#[cfg(test)]
#[path = "web_search_models_tests.rs"]
mod tests;
