//! `account/listWebSearchModels`: Node's `collectWebSearchProviderModels` (`WebSearchModels` of the
//! account domain) over the resident [`CatalogService`] and the model list.
//!
//! Node builds this per runtime (`rt`): the Main route the quick rows follow (`rt.route`) and the
//! adopted cache belong to the session the call is addressed to. Here each conversation has its own
//! route cell (`route_cell::SessionRoutes`, written by every pick, tuning, reload sync and session
//! switch that writes `rt.route`), so the catalog, with its cache, is kept per request thread and reads
//! that thread's cell. A request that names no thread reads the live config route (`D-model-list-route-1`).
//!
//! The tiers and the adopted cache are the twin in `mixdog-ai`'s `service/web_search_models.rs`. What
//! Node reads from its registry is read here from the catalog snapshot: a provider's listing is its
//! models in the snapshot, its cached model info is the listing of that model, the live roster is
//! the catalog's roster and the revision is the snapshot's generation. A forced read asks every
//! provider again once, before the scan (Node refreshes each provider's own cache). There is no
//! per-route metadata map to fill (`meta.remember`): metadata is read from the catalog on demand.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::service::admin_models::{model_proxy_client_mode, provider_model_cache_row, sort_provider_models};
use mixdog_ai::service::model_listing::listing_value;
use mixdog_ai::service::routes::web_search_capable_for;
use mixdog_ai::service::web_search_models::{
    CatalogFacts, QuickFacts, WebSearchCatalog, hydrated_model, main_model_meta,
};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::LiveRoute;
use serde_json::{Map, Value};

use super::model_list::ModelListService;
use crate::domains::ai_account::collaborators::WebSearchModels;
use crate::domains::ai_account::failure::Failure;
use mixdog_core_config::config::Config;

/// The provider's listing row of `model` in the catalog snapshot: what Node reads as the provider's
/// cached model info (or, for a cold cache, its listing).
pub fn listed_row(catalog: &CatalogService, provider: &str, model: &str) -> Option<Value> {
    let snapshot = catalog.snapshot();
    let (_, records) = snapshot.models.iter().find(|(p, _)| p.as_str() == provider)?;
    records.iter().map(listing_value).find(|row| row.get("id").and_then(Value::as_str) == Some(model))
}

/// The live routes the rows follow.
pub struct WebSearchRoutes {
    /// `getRoute()` = `rt.route`: the route cell of every conversation (`route_cell::SessionRoutes`, the
    /// same `Arc` as the `LiveRoute` of the route services).
    pub cells: Arc<dyn LiveRoute>,
    /// A request that names no thread reads the live config route (`resolveRoute(getConfig(), {})` at the
    /// call; `D-model-list-route-1`): Rust has no control session to read it from.
    pub main_route: Arc<dyn Fn() -> Value + Send + Sync>,
    /// `getWebSearchRoute()` = `rt.webSearchRoute`: the web-search route state.
    pub web_search_route: Arc<dyn Fn() -> Value + Send + Sync>,
}

#[derive(Clone)]
struct Facts {
    catalog: Arc<CatalogService>,
    config: Config,
    list: Arc<ModelListService>,
    routes: Arc<WebSearchRoutes>,
    /// The conversation whose runtime asks.
    thread: Option<ThreadId>,
}

impl Facts {
    /// `displayConfig().providers`: the providers of the loaded config as the last load saw them.
    fn providers(&self) -> Vec<(String, Value)> {
        if let Some(host) = &self.list.host {
            return host.last_providers();
        }
        self.config
            .agent()
            .get("providers")
            .and_then(Value::as_object)
            .map_or_else(Vec::new, |m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    }

    fn listings(&self, name: &str) -> Option<Vec<Value>> {
        let snapshot = self.catalog.snapshot();
        let (_, records) = snapshot.models.iter().find(|(p, _)| p.as_str() == name)?;
        Some(records.iter().map(listing_value).collect())
    }
}

impl QuickFacts for Facts {
    fn route(&self) -> Value {
        match &self.thread {
            Some(thread) => Value::Object(self.routes.cells.route(thread)),
            None => (self.routes.main_route)(),
        }
    }

    fn display_providers(&self) -> Vec<(String, Value)> {
        self.providers()
    }

    fn display_web_search_route(&self) -> Value {
        self.config.agent().get("webSearchRoute").cloned().unwrap_or(Value::Null)
    }

    fn web_search_route_state(&self) -> Value {
        (self.routes.web_search_route)()
    }

    fn cached_models(&self, provider: &str) -> Vec<Value> {
        self.catalog.cached_models(provider)
    }

    fn models_dev(&self, provider: &str) -> Option<Map<String, Value>> {
        self.catalog.models_dev_models(provider)
    }

    fn hydrated(&self, provider: &str, model: &Value) -> Value {
        let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
        hydrated_model(provider, model, &self.catalog.model_meta(provider, id))
    }

    fn cache_row(&self, provider: &str, model: &Value) -> Value {
        let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
        let catalog_row = self.catalog.model_meta(provider, id);
        let web_search = web_search_capable_for(provider, id, Some(model), Some(&catalog_row));
        Value::Object(provider_model_cache_row(provider, model, web_search))
    }

    fn capable_for(&self, provider: &str, model: &Value) -> bool {
        let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
        web_search_capable_for(provider, id, Some(model), Some(&self.catalog.model_meta(provider, id)))
    }

    fn main_model_meta(&self) -> Option<Value> {
        let route = self.route();
        let provider = route.get("provider")?.as_str()?;
        let info = route.get("model").and_then(Value::as_str).and_then(|model| listed_row(&self.catalog, provider, model));
        main_model_meta(&route, info.as_ref())
    }

    fn sort(&self, mut rows: Vec<Value>) -> Vec<Value> {
        let route = self.route();
        sort_provider_models(&mut rows, route.get("provider").and_then(Value::as_str).unwrap_or_default());
        rows
    }
}

#[async_trait]
impl CatalogFacts for Facts {
    fn quick(&self) -> &dyn QuickFacts {
        self
    }

    fn client_mode(&self) -> bool {
        model_proxy_client_mode(&|name| std::env::var(name).ok())
    }

    fn revision(&self) -> f64 {
        self.catalog.snapshot().generation as f64
    }

    /// `caches.providerModelsCache.models`: the flattened catalog, once something was listed into it.
    fn models_cache(&self) -> Option<Vec<Value>> {
        let snapshot = self.catalog.snapshot();
        (snapshot.generation != 0 || !snapshot.status.is_empty()).then(|| self.list.cache_rows(&snapshot))
    }

    fn from_cache_rows(&self, rows: &[Value]) -> Vec<Value> {
        self.list.from_cache_rows(&self.catalog.snapshot(), rows)
    }

    async fn collect_provider_models(&self, force: bool) -> Result<Vec<Value>, String> {
        self.list.rows(force, false).await
    }

    /// `awaitKeychainPrewarm()` and `ensureFullConfig()`: the loaded config, read again (the keychain
    /// is read with it).
    async fn prepare(&self) -> Result<(), String> {
        self.list.refresh_providers().await
    }

    fn providers_config(&self) -> Vec<(String, Value)> {
        self.providers()
    }

    /// `ensureProvidersReady(config.providers)`: a failure is the load's (Node does not catch it).
    async fn ensure_providers_ready(&self) -> Result<(), String> {
        self.list.ensure_ready().await?;
        self.list.ready(false, None).await;
        Ok(())
    }

    fn can_list(&self, name: &str) -> bool {
        self.listings(name).is_some()
    }

    async fn refresh_models(&self, _: &str) -> Option<Result<Value, ()>> {
        None
    }

    async fn list_models(&self, name: &str) -> Result<Value, ()> {
        Ok(Value::Array(self.listings(name).unwrap_or_default()))
    }

    fn remember(&self, _: &str, _: &str, _: &Value) {}
}

pub struct WebSearchModelsService {
    catalog: Arc<CatalogService>,
    config: Config,
    list: Arc<ModelListService>,
    routes: Arc<WebSearchRoutes>,
    /// One catalog (its adopted cache and revision) per runtime.
    runtimes: Mutex<HashMap<Option<ThreadId>, Arc<WebSearchCatalog<Facts>>>>,
}

impl WebSearchModelsService {
    pub fn new(catalog: Arc<CatalogService>, config: Config, list: Arc<ModelListService>, routes: WebSearchRoutes) -> Self {
        Self { catalog, config, list, routes: Arc::new(routes), runtimes: Mutex::new(HashMap::new()) }
    }

    fn runtime(&self, thread: Option<&ThreadId>) -> Arc<WebSearchCatalog<Facts>> {
        let mut runtimes = self.runtimes.lock().unwrap_or_else(PoisonError::into_inner);
        runtimes
            .entry(thread.cloned())
            .or_insert_with(|| {
                let facts = Facts {
                    catalog: self.catalog.clone(),
                    config: self.config.clone(),
                    list: self.list.clone(),
                    routes: self.routes.clone(),
                    thread: thread.cloned(),
                };
                Arc::new(WebSearchCatalog::new(facts))
            })
            .clone()
    }

    /// `invalidateProviderCaches()` of one runtime: its adopted rows go (a saved route or a changed provider).
    pub fn invalidate(&self, thread: Option<&ThreadId>) {
        self.runtime(thread).invalidate();
    }
}

#[async_trait]
impl WebSearchModels for WebSearchModelsService {
    async fn list(&self, thread: Option<&ThreadId>, force: bool) -> Result<Value, Failure> {
        // A forced scan asks every provider again first; client mode asks through the shared catalog read.
        if force && !model_proxy_client_mode(&|name| std::env::var(name).ok()) {
            self.catalog.refresh().await;
        }
        self.runtime(thread).collect(force).await.map(Value::Array).map_err(Failure::error)
    }
}