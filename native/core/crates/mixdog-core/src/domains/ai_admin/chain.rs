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

/// What the route services ask of the provider catalog and readiness (Node's `lookupModelMeta`,
/// `ensureProvidersReady`, `isKnownProvider` and the capability checks).
#[async_trait]
pub trait RouteFacts: Send + Sync {
    /// `isKnownProvider(provider, config)`.
    fn is_known(&self, provider: &str, config: &Obj) -> bool;
    /// `ensureProvidersReady(ensureProviderEnabled(config, provider))`.
    async fn ensure_ready(&self, config: &Obj, provider: &str) -> Result<(), String>;
    /// `lookupModelMeta(provider, model)`.
    fn model_meta(&self, provider: &str, model: &str) -> Value;
    /// The row whose windows size a route (`window_meta_of` over the cached provider row).
    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value>;
    /// `getModelMetadataSync(model, provider)` is non-null.
    fn catalog_knows(&self, model: &str, provider: &str) -> bool;
    /// `fastCapableFor(provider, meta, effort, params)`.
    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool;
    /// `ultrafastCapableFor(provider, meta)`.
    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool;
}

/// [`RouteFacts`] over the PC's catalog and provider readiness.
pub struct CatalogFacts {
    pub catalog: Arc<CatalogService>,
    pub readiness: Arc<ProviderReadiness>,
}

#[async_trait]
impl RouteFacts for CatalogFacts {
    /// `isKnownProvider(provider, config)` with the Developer-option gate of `providerAvailable`.
    fn is_known(&self, provider: &str, config: &Obj) -> bool {
        let developer = config.get("developer").cloned().unwrap_or(Value::Null);
        let client = model_proxy_client_mode(&|name| std::env::var(name).ok());
        is_known_provider(provider, &Value::Object(config.clone()), &|name| provider_available(name, client, &developer))
    }

    async fn ensure_ready(&self, config: &Obj, provider: &str) -> Result<(), String> {
        self.readiness.ensure_providers_ready(Some(ensure_provider_enabled(config, provider))).await.map(|_| ()).map_err(|e| e.message)
    }

    fn model_meta(&self, provider: &str, model: &str) -> Value {
        self.catalog.model_meta(provider, model)
    }

    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        let cached = self.catalog.cached_windows(provider, model).and_then(|w| serde_json::to_value(w).ok());
        window_meta_of(Some(meta), cached.as_ref()).cloned()
    }

    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.catalog.catalog_knows(model, provider)
    }

    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
        self.catalog.fast_capable(provider, meta, effort, params)
    }

    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
        self.catalog.ultrafast_capable(provider, meta)
    }
}

/// `resolveChainEntry(requested, stored)` against `config`.
pub async fn resolve_chain_entry(facts: &dyn RouteFacts, config: &Obj, requested: &Obj, stored: &Obj) -> Result<Obj, String> {
    let selected = start_chain_entry(config, requested, stored, &|p, c| facts.is_known(p, c))?;
    let provider = clean(selected.get("provider"));
    let model = clean(selected.get("model"));
    facts.ensure_ready(config, &provider).await?;
    let meta = facts.model_meta(&provider, &model);
    let window = facts.window_meta(&provider, &model, &meta);
    Ok(finish_chain_entry(selected, Some(&meta), window.as_ref(), |route| {
        let effort = route.get("effort").and_then(Value::as_str);
        let params = route.get("modelParameters").cloned().unwrap_or(Value::Null);
        facts.fast_capable(&clean(route.get("provider")), &meta, effort, &params)
    }))
}

/// The runtime's [`RouteContext`]: the live config over the route facts.
pub struct CatalogRouteContext {
    pub config: Config,
    pub facts: Arc<dyn RouteFacts>,
}

#[async_trait]
impl RouteContext for CatalogRouteContext {
    fn resolve_main(&self) -> Result<Obj, String> {
        resolve_route(&self.config.agent(), &Obj::new(), &|p, c| self.facts.is_known(p, c))
    }

    async fn resolve_chain_entry(&self, requested: &Obj, stored: &Obj) -> Result<Obj, String> {
        resolve_chain_entry(self.facts.as_ref(), &self.config.agent(), requested, stored).await
    }
}
