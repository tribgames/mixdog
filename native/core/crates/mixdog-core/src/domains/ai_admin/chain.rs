//! What the route services read of the world: the config document, the provider and model
//! facts, and `resolveChainEntry` / `resolveRoute` over them.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogService, ProviderReadiness, is_known_provider};
use mixdog_ai::service::admin_models::{model_proxy_client_mode, provider_available};
use mixdog_ai::service::admin_route::{
    Obj, clean, ensure_provider_enabled, finish_chain_entry, resolve_route, start_chain_entry, window_meta_of,
};
use serde_json::Value;

use crate::config::Config;

/// `resolveRoute(config, {})` and `resolveChainEntry` of one runtime.
#[async_trait]
pub trait RouteContext: Send + Sync {
    /// The route Main resolves to (`resolveRoute(getConfig(), {})`).
    fn resolve_main(&self) -> Result<Obj, String>;
    /// `resolveChainEntry(requested, stored)`.
    async fn resolve_chain_entry(&self, requested: &Obj, stored: &Obj) -> Result<Obj, String>;
}

/// The runtime's [`RouteContext`]: the live config, the catalog and the provider readiness.
pub struct CatalogRouteContext {
    pub config: Config,
    pub catalog: Arc<CatalogService>,
    pub readiness: Arc<ProviderReadiness>,
}

impl CatalogRouteContext {
    fn doc(&self) -> Obj {
        self.config.agent()
    }

    /// `isKnownProvider(provider, config)` with the Developer-option gate of `providerAvailable`.
    fn is_known(&self, provider: &str, config: &Obj) -> bool {
        let developer = config.get("developer").cloned().unwrap_or(Value::Null);
        let client = model_proxy_client_mode(&|name| std::env::var(name).ok());
        is_known_provider(provider, &Value::Object(config.clone()), &|name| provider_available(name, client, &developer))
    }
}

#[async_trait]
impl RouteContext for CatalogRouteContext {
    fn resolve_main(&self) -> Result<Obj, String> {
        resolve_route(&self.doc(), &Obj::new(), &|p, c| self.is_known(p, c))
    }

    async fn resolve_chain_entry(&self, requested: &Obj, stored: &Obj) -> Result<Obj, String> {
        let config = self.doc();
        let selected = start_chain_entry(&config, requested, stored, &|p, c| self.is_known(p, c))?;
        let provider = clean(selected.get("provider"));
        let model = clean(selected.get("model"));
        self.readiness
            .ensure_providers_ready(Some(ensure_provider_enabled(&config, &provider)))
            .await
            .map_err(|e| e.message)?;
        let meta = self.catalog.model_meta(&provider, &model);
        let cached = self.catalog.cached_windows(&provider, &model).and_then(|w| serde_json::to_value(w).ok());
        Ok(finish_chain_entry(selected, Some(&meta), window_meta_of(Some(&meta), cached.as_ref()), |route| {
            let effort = route.get("effort").and_then(Value::as_str);
            let params = route.get("modelParameters").cloned().unwrap_or(Value::Null);
            self.catalog.fast_capable(&clean(route.get("provider")), &meta, effort, &params)
        }))
    }
}
