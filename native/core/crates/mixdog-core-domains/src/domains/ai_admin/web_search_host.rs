//! The host of the hosted web search (`createNativeWebSearch`'s `deps` of `session-runtime/boot/
//! providers.mjs:201-222`) over the daemon's resident services.
//!
//! Node builds `getRoute` / `getSession` per runtime (`rt.route`, `rt.session`), and a web search
//! reads the asking runtime's (`runtime-tool-routing.mjs`'s `runNativeWebSearch`). A daemon hosts
//! every conversation, so the asking call's thread picks the route cell and the session. What Node
//! reads from its registry and provider caches is read from the same places as the model list and
//! the web-search rows (`web_search_models`): a provider's cached model info is its listing of the
//! model in the catalog snapshot, and `getModelMetadataSync` is the catalog's merged metadata.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::ensure_provider_enabled;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_tools::web::SearchHost;
use serde_json::Value;

use super::web_search_models::listed_row;

pub struct RegistrySearchHost {
    /// `getRoute()` = `rt.route`: the route cell of every conversation (the one `LiveRoute` of the
    /// route services).
    pub cells: Arc<dyn LiveRoute>,
    pub config: Config,
    pub catalog: Arc<CatalogService>,
    pub readiness: Arc<ProviderReadiness>,
    pub registry: Arc<ProviderRegistry>,
}

impl RegistrySearchHost {
    /// `ensureProvidersReady(ensureProviderEnabled(cfg, provider))`.
    async fn ready(&self, provider: &str) -> Result<(), String> {
        let providers = ensure_provider_enabled(&self.config.agent(), provider);
        self.readiness.ensure_providers_ready(Some(providers)).await.map(|_| ()).map_err(|error| error.message)
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
    /// snapshot, so one lookup answers `getCachedModelInfo(model) || listModels().find(..)`.
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
        self.ready(provider).await?;
        Ok(listed_row(&self.catalog, provider, model))
    }

    /// `getModelMetadataSync(model, provider)`.
    fn catalog_row(&self, provider: &str, model: &str) -> Option<Value> {
        self.catalog.sync_meta(model, provider).map(Value::Object)
    }

    async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        self.ready(provider).await?;
        self.registry.try_get(provider).await.map_err(|error| error.message)
    }

    /// A conversation's session id is its thread id (`TurnScope.caller_session_id`).
    fn session_id(&self, thread: &ThreadId) -> Option<String> {
        Some(thread.as_str().to_owned())
    }
}
