use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::service::routes::{DefaultSearchFallback, is_web_search_capable_provider};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_tools::web::SearchHost;
use mixdog_tools::web::SearchProvider;
use serde_json::Value;

use super::chain::{RouteFacts, RouteSender};
use super::web_search_models::listed_row;

pub struct RegistrySearchHost {
    /// `getRoute()` = `rt.route`: the route cell of every conversation (the one `LiveRoute` of the
    /// route services).
    pub cells: Arc<dyn LiveRoute>,
    pub config: Config,
    pub catalog: Arc<CatalogService>,
    /// What a route's provider is: readied, and who sends on it.
    pub facts: Arc<dyn RouteFacts>,
}

impl RegistrySearchHost {
    /// `ensureProvidersReady(ensureProviderEnabled(cfg, provider))`.
    async fn ready(&self, provider: &str) -> Result<(), String> {
        self.facts.ensure_ready(&self.config.agent(), provider).await
    }
}

#[async_trait]
impl SearchHost for RegistrySearchHost {
    fn main_route(&self, thread: &ThreadId) -> Value {
        Value::Object(self.cells.route(thread))
    }

    /// `ensureFullConfig().webSearchRoute`.
    fn stored_web_search_route(&self) -> Value {
        self.config.agent().get("webSearchRoute").cloned().unwrap_or(Value::Null)
    }

    /// `loadMainCatalogRow`, with the provider's cache and its listing both read from the
    /// snapshot, so one lookup answers `getCachedModelInfo(model) || listModels().find(..)`,
    /// falling back to `RouteFacts::model_meta` for ACP routes that are not in the provider catalog.
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
        if !is_web_search_capable_provider(provider) {
            return Ok(None);
        }
        self.ready(provider).await?;
        Ok(listed_row(&self.catalog, provider, model).or_else(|| self.facts.catalog_knows(model, provider).then(|| self.facts.model_meta(provider, model))))
    }

    /// `getModelMetadataSync(model, provider)`.
    fn catalog_row(&self, provider: &str, model: &str) -> Option<Value> {
        self.catalog.sync_meta(model, provider).map(Value::Object)
    }

    async fn provider(&self, provider: &str) -> Result<Option<SearchProvider>, String> {
        self.ready(provider).await?;
        Ok(match self.facts.sender(None, provider).await? {
            Some(RouteSender::Provider(adapter)) => Some(SearchProvider::Hosted(adapter)),
            Some(RouteSender::Agent(_)) => Some(SearchProvider::Acp),
            None => None,
        })
    }

    /// A conversation's session id is its thread id (`TurnScope.caller_session_id`).
    fn session_id(&self, thread: &ThreadId) -> Option<String> {
        Some(thread.as_str().to_owned())
    }

    fn default_search_fallback(&self, main_provider: &str, main_model: &str) -> DefaultSearchFallback {
        self.facts.default_search_fallback(&self.config.agent(), main_provider, main_model)
    }
}
