//! What every reader of a route asks of the provider it names: whether it is ready, the model row the route resolves
//! to, the capability checks, and who sends a one-shot request on it. [`CatalogFacts`] answers over the PC's catalog,
//! readiness and provider registry; a route served by an agent outside the loop is answered by the facts that know
//! the agents, which wrap these, so no reader takes a route's provider id to the registry on its own.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogService, ProviderReadiness, is_known_provider};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_models::{is_selectable_llm_model, model_proxy_client_mode, provider_available};
use mixdog_ai::service::admin_route::{Obj, ensure_provider_enabled, provider_switched_off, window_meta_of};
use mixdog_ai::service::model_listing::listing_value;
use mixdog_ai::service::routes::{
    DefaultSearchFallback, DefaultSearchRoute, canonical_route_provider, pick_quick_web_search_model, web_search_capable_for, web_search_provider_family,
};
use mixdog_core_api::domain::provider::{ProviderAdapter, Usage};
use mixdog_core_config::config::Config;
use serde_json::Value;

/// What the route services ask of the provider catalog and readiness (Node's `lookupModelMeta`,
/// `ensureProvidersReady`, `isKnownProvider` and the capability checks), and who sends on a route.
#[async_trait]
pub trait RouteFacts: Send + Sync {
    /// `isKnownProvider(provider, config)`.
    fn is_known(&self, provider: &str, config: &Obj) -> bool;
    /// `ensureProvidersReady(ensureProviderEnabled(config, provider))`.
    async fn ensure_ready(&self, config: &Obj, provider: &str) -> Result<(), String>;
    /// Readiness for a specific route (`provider` + `model`). Providers whose routes are not scoped by model defer to
    /// [`Self::ensure_ready`]; an agent checks model admission alongside its CLI and account readiness.
    async fn ensure_route_ready(&self, config: &Obj, provider: &str, _model: &str) -> Result<(), String> {
        self.ensure_ready(config, provider).await
    }
    /// `lookupModelMeta(provider, model)`.
    fn model_meta(&self, provider: &str, model: &str) -> Value;
    /// `lookupModelMeta(provider, model, { allowFetch: true })`: a placeholder answer is replaced by what the
    /// provider lists now. Facts with nothing to list answer [`Self::model_meta`].
    async fn model_meta_fetching(&self, provider: &str, model: &str) -> Value {
        self.model_meta(provider, model)
    }
    /// The row whose windows size a route (`window_meta_of` over the cached provider row).
    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value>;
    /// `getModelMetadataSync(model, provider)` is non-null.
    fn catalog_knows(&self, model: &str, provider: &str) -> bool;
    /// `fastCapableFor(provider, meta, effort, params)`.
    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool;
    /// `ultrafastCapableFor(provider, meta)`.
    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool;
    /// Who sends on a route on `provider`: a one-shot request, or a run of the loop ([`RouteSender::adapter`]).
    /// `providers` are the entries the asking step initializes first (`initProviders(providers)`); `None` looks up what
    /// is there. `Ok(None)`: no provider is there to send. Facts that serve no route send nothing.
    async fn sender(&self, _providers: Option<&Obj>, _provider: &str) -> Result<Option<RouteSender>, String> {
        Ok(None)
    }
    /// The provider registered for a route on `provider` now, none built for the asking: what a reader of the provider's
    /// own declarations (its wires, its quota, its media) asks. A route an agent serves has none.
    fn registered(&self, _provider: &str) -> Option<Arc<dyn ProviderAdapter>> {
        None
    }
    /// Why the provider of a route could not be made ready, as its initialization recorded it.
    fn init_error(&self, _provider: &str) -> Option<String> {
        None
    }
    /// Same-product stand-in route (or failure reason) using already-known
    /// readiness when the default ("follow Main") route's Main model cannot
    /// run native web search itself. Never probes or runs readiness work.
    fn default_search_fallback(&self, _config: &Obj, _main_provider: &str, _main_model: &str) -> DefaultSearchFallback {
        DefaultSearchFallback::default()
    }
}

/// Who sends on a route: a one-shot request (a summary, a title, a heartbeat), or a run of the loop.
#[derive(Clone)]
pub enum RouteSender {
    /// The provider the registry holds for the route.
    Provider(Arc<dyn ProviderAdapter>),
    /// The agent that serves the route: it answers in a session of its own that holds nothing but the request.
    Agent(Arc<dyn AgentAsk>),
}

impl RouteSender {
    /// The provider a run in the loop sends on: an agent runs its own turns, so its route has none.
    pub fn adapter(self) -> Option<Arc<dyn ProviderAdapter>> {
        match self {
            Self::Provider(adapter) => Some(adapter),
            Self::Agent(_) => None,
        }
    }
}

/// The agent a route is served by, asked one question outside every conversation.
#[async_trait]
pub trait AgentAsk: Send + Sync {
    /// Asks `prompt` under the instructions `system`, on the route's `model`. `Err` tells why no answer was made.
    async fn ask(&self, model: &str, system: &str, prompt: &str) -> Result<AgentAnswer, String>;
}

/// An agent's answer to one question.
#[derive(Clone, Debug, Default)]
pub struct AgentAnswer {
    pub text: String,
    /// Why the agent stopped, in the protocol's word for it; `None` when it did not say.
    pub stop_reason: Option<String>,
    pub usage: Option<Usage>,
    /// The usage's input leaves its cache reads out.
    pub input_excludes_cache: bool,
}

/// [`RouteFacts`] over the PC's catalog, provider readiness and provider registry.
pub struct CatalogFacts {
    pub catalog: Arc<CatalogService>,
    pub readiness: Arc<ProviderReadiness>,
    pub registry: Arc<ProviderRegistry>,
    /// The provider entries a custom provider's own model rows come from.
    pub config: Config,
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
        self.readiness
            .ensure_providers_ready(Some(ensure_provider_enabled(config, provider)))
            .await
            .map(|_| ())
            .map_err(|e| mixdog_ai::service::error_text::route_ready_error_text(e.message))
    }

    fn model_meta(&self, provider: &str, model: &str) -> Value {
        self.catalog.model_meta_in(provider, model, self.config.agent().get("providers").and_then(|providers| providers.get(provider)))
    }

    async fn model_meta_fetching(&self, provider: &str, model: &str) -> Value {
        let agent = self.config.agent();
        self.catalog.model_meta_fetching(provider, model, agent.get("providers").and_then(|providers| providers.get(provider))).await
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

    async fn sender(&self, providers: Option<&Obj>, provider: &str) -> Result<Option<RouteSender>, String> {
        if let Some(providers) = providers {
            self.registry.init_providers(providers).await.map_err(|error| error.message)?;
        }
        Ok(self.registry.try_get(provider).await.map_err(|error| error.message)?.map(RouteSender::Provider))
    }

    fn registered(&self, provider: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.registry.registered_for_route(provider)
    }

    fn init_error(&self, provider: &str) -> Option<String> {
        self.registry.init_errors().remove(provider)
    }

    fn default_search_fallback(&self, config: &Obj, main_provider: &str, main_model: &str) -> DefaultSearchFallback {
        let provider = canonical_route_provider(main_provider);
        if !is_hosted_search_provider(&provider) || hosted_provider_switched_off(config, &provider) || self.registry.registered_for_route(&provider).is_none() {
            return DefaultSearchFallback::default();
        }
        let model = pick_hosted_search_model(&self.catalog, config, &provider, Some(main_model.trim()));
        DefaultSearchFallback { route: model.map(|model| DefaultSearchRoute { provider, model }), reason: None }
    }
}

fn is_hosted_search_provider(provider: &str) -> bool {
    let family = web_search_provider_family(provider);
    !family.is_empty() && family != "acp"
}

fn api_alias(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("openai-api"),
        "anthropic" => Some("anthropic-api"),
        "gemini" => Some("gemini-api"),
        "xai" => Some("xai-api"),
        _ => None,
    }
}

fn hosted_provider_switched_off(config: &Obj, provider: &str) -> bool {
    provider_switched_off(config, provider) || api_alias(provider).is_some_and(|alias| provider_switched_off(config, alias))
}

fn provider_entry<'a>(config: &'a Obj, provider: &str) -> Option<&'a Value> {
    let providers = config.get("providers")?.as_object()?;
    providers.get(provider).or_else(|| api_alias(provider).and_then(|alias| providers.get(alias)))
}

fn hosted_model_capable(catalog: &CatalogService, provider: &str, id: &str, row: Option<&Value>, skip_model: Option<&str>) -> bool {
    let id = id.trim();
    if id.is_empty() || skip_model == Some(id) {
        return false;
    }
    if let Some(row) = row
        && !is_selectable_llm_model(row)
    {
        return false;
    }
    let sync_meta = catalog.sync_meta(id, provider).map(Value::Object);
    web_search_capable_for(provider, id, row, sync_meta.as_ref())
}

fn pick_hosted_search_model(catalog: &CatalogService, config: &Obj, provider: &str, skip_model: Option<&str>) -> Option<String> {
    let mut capable: Vec<String> = Vec::new();
    let push = |capable: &mut Vec<String>, id: &str, row: Option<&Value>| {
        if hosted_model_capable(catalog, provider, id, row, skip_model) {
            let trimmed = id.trim().to_owned();
            if !capable.contains(&trimmed) {
                capable.push(trimmed);
            }
        }
    };
    let snapshot = catalog.snapshot();
    if let Some((_, records)) = snapshot.models.iter().find(|(p, _)| p.as_str() == provider) {
        for record in records {
            let row = listing_value(record);
            push(&mut capable, &record.id, Some(&row));
        }
    }
    for row in catalog.cached_models(provider) {
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            push(&mut capable, id, Some(&row));
        }
    }
    if capable.is_empty()
        && let Some(models) = catalog.models_dev_models(provider)
    {
        for (id, row) in models {
            let mut row_with_id = row.as_object().cloned().unwrap_or_default();
            row_with_id.entry("id".to_owned()).or_insert_with(|| Value::String(id.clone()));
            push(&mut capable, &id, Some(&Value::Object(row_with_id)));
        }
    }
    if let Some(configured) = provider_entry(config, provider).and_then(|entry| entry.get("model")).and_then(Value::as_str) {
        push(&mut capable, configured, None);
    }
    pick_quick_web_search_model(provider, &capable)
}
