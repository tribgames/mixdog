//! What the config domain's compaction/auto-clear and workflow/onboarding services reach outside
//! the config: [`CompactionHost`] and [`WorkflowHost`] over the session directory, the live route
//! cell, the context gauge, the agent definitions, and the provider catalog and readiness.
//!
//! The daemon holds no single "active session" as Node's runtime does (`rt.session`, `getRoute()`):
//! a thread's route lives in the route cell, and a run reads the config at its start
//! (`ConfigRunSeams::session_compaction` is `syncSessionCompaction`; the route surface builds the
//! cache options when a route is adopted). What Node does to its in-memory session on a settings
//! change therefore has no object to act on here, except where a thread is named:
//!
//! - `adoptSessionCompaction`: the next run adopts the saved record, so there is nothing to do.
//! - `invalidateContextStatusCache`: the named thread's gauge re-measures.
//! - `getRoute()`: the named thread's live route; without a thread, the route Node boots with,
//!   `resolveRoute(config, {})` (`resolveInitialConfigState`, `config-lifecycle.mjs:105`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::settings::Doc;
use mixdog_agent::compact::settings_service::CompactionHost;
use mixdog_ai::service::admin_models::model_proxy_client_mode;
use mixdog_ai::service::admin_models::provider_available;
use mixdog_ai::service::admin_route::resolve_route;
use mixdog_ai::service::routes::web_search_capable_for;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_config::workflow::WorkflowHost;
use mixdog_core_domains::domains::ai_account::admin::ProviderAdmin;
use mixdog_core_domains::domains::ai_account::collaborators::AuthRefresh;
use mixdog_core_domains::domains::ai_account::custom_config::normalize;
use mixdog_core_domains::domains::ai_admin::chain::CatalogFacts;
use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::route_session::ContextStatusCache;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The stored header of a thread (`SessionDirectory::stored_header`).
#[async_trait]
pub trait ThreadHeaders: Send + Sync {
    async fn header(&self, thread: &ThreadId) -> Option<Header>;
}

#[async_trait]
impl ThreadHeaders for SessionDirectory {
    async fn header(&self, thread: &ThreadId) -> Option<Header> {
        self.stored_header(thread).await
    }
}

/// `listCustomAgentIds()`.
#[async_trait]
pub trait CustomAgentIds: Send + Sync {
    async fn ids(&self) -> Vec<String>;
}

#[async_trait]
impl CustomAgentIds for AgentDefinitions {
    async fn ids(&self) -> Vec<String> {
        // An unreadable agents folder lists nothing, as Node's `listCustomAgentIds` does.
        self.custom_agent_ids().await.unwrap_or_default()
    }
}

/// `ensureProvidersReady(providers)`.
#[async_trait]
pub trait ProvidersReady: Send + Sync {
    async fn ensure(&self, providers: Map<String, Value>) -> Result<(), String>;
}

#[async_trait]
impl ProvidersReady for CatalogFacts {
    async fn ensure(&self, providers: Map<String, Value>) -> Result<(), String> {
        self.readiness.ensure_providers_ready(Some(providers)).await.map(|_| ()).map_err(|error| error.message)
    }
}

/// `process.env[name]`.
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct ConfigHosts {
    pub config: Config,
    pub headers: Arc<dyn ThreadHeaders>,
    pub routes: Arc<dyn LiveRoute>,
    pub gauge: Arc<dyn ContextStatusCache>,
    pub agents: Arc<dyn CustomAgentIds>,
    pub facts: Arc<dyn RouteFacts>,
    pub ready: Arc<dyn ProvidersReady>,
    pub refresh: Arc<dyn AuthRefresh>,
    pub env: Env,
}

impl ConfigHosts {
    /// `resolveRoute(config, {})`: the route a process boots with, from the saved config.
    fn boot_route(&self) -> Option<Map<String, Value>> {
        let config = self.config.agent();
        resolve_route(&config, &Map::new(), &|provider, full| self.facts.is_known(provider, full)).ok()
    }
}

impl CompactionHost for ConfigHosts {
    fn route_provider(&self, thread: Option<&ThreadId>) -> Option<String> {
        let route = match thread {
            Some(thread) => self.routes.route(thread),
            None => self.boot_route()?,
        };
        route.get("provider").and_then(Value::as_str).filter(|provider| !provider.is_empty()).map(str::to_owned)
    }

    fn adopt_session_compaction(&self, _thread: Option<&ThreadId>, _saved: &Doc) {}

    fn invalidate_context_status(&self, thread: Option<&ThreadId>) {
        if let Some(thread) = thread {
            self.gauge.invalidate(thread);
        }
    }

    fn refresh_lead_cache_opts(&self, _thread: Option<&ThreadId>, _agent: &Doc) {}
}

/// The row the provider catalog lists for a model, or `None` when it lists none
/// (`getModelMetadataSync(id, provider)` is null).
fn catalog_row(facts: &dyn RouteFacts, provider: &str, model: &str) -> Option<Value> {
    facts.catalog_knows(model, provider).then(|| facts.model_meta(provider, model))
}

#[async_trait]
impl WorkflowHost for ConfigHosts {
    async fn thread_mode_facts(&self, thread_id: &str) -> Result<Value, CoreError> {
        let thread = ThreadId::from(thread_id);
        let Some(header) = self.headers.header(&thread).await else {
            return Err(CoreError::ThreadNotFound { thread_id: thread });
        };
        let mut facts = Map::new();
        for key in ["orchestrationMode", "pendingOrchestrationMode", "workflow"] {
            if let Some(value) = header.get(key) {
                facts.insert(key.to_owned(), value.clone());
            }
        }
        Ok(Value::Object(facts))
    }

    fn main_route(&self) -> Value {
        self.boot_route().map_or(Value::Null, Value::Object)
    }

    /// The saved config is what every new run and route adoption reads; the daemon has no live
    /// Main route object to move.
    async fn adopt_lead_route(&self, _selection: Value) {}

    async fn custom_agent_ids(&self) -> Vec<String> {
        self.agents.ids().await
    }

    fn provider_available(&self, provider: &str) -> bool {
        let developer = self.config.agent().get("developer").cloned().unwrap_or(Value::Null);
        provider_available(provider, model_proxy_client_mode(&*self.env), &developer)
    }

    fn require_local_provider_management(&self) -> Result<(), String> {
        ProviderAdmin::require_local().map_err(|failure| failure.message().to_owned())
    }

    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String> {
        normalize(entry)
    }

    async fn after_credential_change(&self) {
        self.refresh.after_credential_change();
    }

    async fn ensure_providers_ready(&self, providers: Doc) -> Result<(), String> {
        self.ready.ensure(providers).await
    }

    async fn lookup_model_meta(&self, provider: &str, model: &str) -> Option<Value> {
        catalog_row(&*self.facts, provider, model)
    }

    fn web_search_capable(&self, provider: &str, meta: Option<&Value>) -> bool {
        // `clean(model?.id || model)`: the row's id when it is truthy, else the row itself, which
        // reads as `[object Object]`; a bare id is itself.
        let (id, row) = match meta {
            Some(Value::Object(row)) => {
                let truthy = match row.get("id") {
                    None | Some(Value::Null) | Some(Value::Bool(false)) => false,
                    Some(Value::String(text)) => !text.is_empty(),
                    Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
                    Some(_) => true,
                };
                let id = if truthy { mixdog_js::value_to_string(&row["id"]) } else { "[object Object]".to_owned() };
                (id, meta)
            }
            Some(Value::String(id)) => (id.clone(), None),
            _ => (String::new(), None),
        };
        let catalog = catalog_row(&*self.facts, provider, mixdog_js::js_trim(&id));
        web_search_capable_for(provider, &id, row, catalog.as_ref())
    }

    fn fast_capable(&self, provider: &str, meta: Option<&Value>, effort: Option<&str>, model_parameters: Option<&Value>) -> bool {
        let empty = json!({});
        self.facts.fast_capable(provider, meta.unwrap_or(&Value::Null), effort, model_parameters.unwrap_or(&empty))
    }

    /// The route state is the saved config; no provider cache is held apart from the catalog.
    fn web_search_route_saved(&self, _route: &Value) {}
}

#[cfg(test)]
mod tests;
