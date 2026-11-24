use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_tools::web::SearchHost;
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
    /// snapshot, so one lookup answers `getCachedModelInfo(model) || listModels().find(..)`.
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String> {
        self.ready(provider).await?;
        Ok(listed_row(&self.catalog, provider, model))
    }

    /// `getModelMetadataSync(model, provider)`.
    fn catalog_row(&self, provider: &str, model: &str) -> Option<Value> {
        self.catalog.sync_meta(model, provider).map(Value::Object)
    }

    /// A route an agent serves has no provider of Mixdog's to send a hosted search through: it is not there, as a
    /// provider the registry does not hold is not.
    async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        self.ready(provider).await?;
        Ok(match self.facts.sender(None, provider).await? {
            Some(RouteSender::Provider(adapter)) => Some(adapter),
            Some(RouteSender::Agent(_)) | None => None,
        })
    }

    /// A conversation's session id is its thread id (`TurnScope.caller_session_id`).
    fn session_id(&self, thread: &ThreadId) -> Option<String> {
        Some(thread.as_str().to_owned())
    }
}
