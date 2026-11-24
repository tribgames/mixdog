//! What the route services read of the world: the config document, the provider and model
//! facts, and `resolveChainEntry` / `resolveRoute` over them.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, clean, finish_chain_entry, resolve_route, start_chain_entry};

use serde_json::Value;

use mixdog_core_config::config::Config;
pub use mixdog_core_ports::ports::route_facts::{CatalogFacts, RouteFacts, RouteSender};

/// `resolveRoute(config, {})` and `resolveChainEntry` of one runtime.
#[async_trait]
pub trait RouteContext: Send + Sync {
    /// The route Main resolves to (`resolveRoute(getConfig(), {})`).
    fn resolve_main(&self) -> Result<Obj, String>;
    /// `resolveChainEntry(requested, stored)`.
    async fn resolve_chain_entry(&self, requested: &Obj, stored: &Obj) -> Result<Obj, String>;
    /// [`RouteFacts::ensure_ready`] of `provider` against the runtime's config.
    async fn ensure_ready(&self, provider: &str) -> Result<(), String>;
    /// [`RouteFacts::sender`] of `provider` as it is now, nothing initialized first.
    async fn sender(&self, provider: &str) -> Result<Option<RouteSender>, String>;
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

    async fn ensure_ready(&self, provider: &str) -> Result<(), String> {
        self.facts.ensure_ready(&self.config.agent(), provider).await
    }

    async fn sender(&self, provider: &str) -> Result<Option<RouteSender>, String> {
        self.facts.sender(None, provider).await
    }
}
