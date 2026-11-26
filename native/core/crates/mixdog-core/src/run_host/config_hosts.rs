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
    /// `Ok(None)`: no such thread. `Err`: the read never ran, which says nothing about the thread.
    async fn header(&self, thread: &ThreadId) -> Result<Option<Header>, CoreError>;
}

#[async_trait]
impl ThreadHeaders for SessionDirectory {
    async fn header(&self, thread: &ThreadId) -> Result<Option<Header>, CoreError> {
        self.try_stored_header(thread).await
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

    fn provider_registered(&self, _provider: &str) -> bool {
        false
    }
}

#[async_trait]
impl ProvidersReady for CatalogFacts {
    async fn ensure(&self, providers: Map<String, Value>) -> Result<(), String> {
        self.readiness.ensure_providers_ready(Some(providers)).await.map(|_| ()).map_err(|error| error.message)
    }

    fn provider_registered(&self, provider: &str) -> bool {
        self.readiness.provider_registered(provider)
    }
}

/// `process.env[name]`.
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct ConfigHosts {
    pub config: Config,
    pub routes: Arc<dyn LiveRoute>,
    pub gauge: Arc<dyn ContextStatusCache>,
    pub agents: Arc<dyn CustomAgentIds>,
    pub facts: Arc<dyn RouteFacts>,
    pub ready: Arc<dyn ProvidersReady>,
    pub refresh: Arc<dyn AuthRefresh>,
    pub env: Env,
    /// Whether a route provider is an outside agent's (`WorkflowHost::agent_provider`).
    pub agent_providers: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// `surfaceGeneration`, moved when onboarding saves a Lead route (`onboarding.mjs:122`).
    pub surface: mixdog_core_base::surface::SurfaceGeneration,
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

    /// The saved `autoClear` this call follows is what `compaction_follow::follow` watches: the save ticks the config's changes and
    /// every loaded Lead thread's `providerCacheOpts` is re-derived there (as for any other writer of the section), so this
    /// call has nothing of its own to do.
    fn refresh_lead_cache_opts(&self, _thread: Option<&ThreadId>, _agent: &Doc) {}
}

/// The row the provider catalog lists for a model, or `None` when it lists none
/// (`getModelMetadataSync(id, provider)` is null).
fn catalog_row(facts: &dyn RouteFacts, provider: &str, model: &str) -> Option<Value> {
    facts.catalog_knows(model, provider).then(|| facts.model_meta(provider, model))
}

#[async_trait]
impl WorkflowHost for ConfigHosts {
    fn main_route(&self) -> Value {
        self.boot_route().map_or(Value::Null, Value::Object)
    }

    /// The saved config is what every new run and route adoption reads; the daemon has no live
    /// Main route object to move. The tool surface of an empty session is rebuilt: the surface
    /// generation moves (`deps.invalidatePreSessionToolSurface?.()`, `onboarding.mjs:122`).
    async fn adopt_lead_route(&self, _selection: Value) {
        self.surface.bump();
    }

    async fn custom_agent_ids(&self) -> Vec<String> {
        self.agents.ids().await
    }

    fn provider_available(&self, provider: &str) -> bool {
        let developer = self.config.agent().get("developer").cloned().unwrap_or(Value::Null);
        provider_available(provider, model_proxy_client_mode(&*self.env), &developer)
    }

    fn agent_provider(&self, provider: &str) -> bool {
        (self.agent_providers)(provider)
    }

    fn proxy_provider_registered(&self, provider: &str) -> bool {
        model_proxy_client_mode(&*self.env) && self.ready.provider_registered(provider)
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

    async fn ensure_agent_provider_ready(&self, provider: &str) -> Result<(), String> {
        self.facts.ensure_ready(&self.config.agent(), provider).await
    }

    /// `lookupModelMeta(provider, model, { allowFetch: true })` (`web-search-route.mjs:66`): never absent, the bare
    /// `{id, provider}` placeholder at worst.
    async fn lookup_model_meta(&self, provider: &str, model: &str) -> Option<Value> {
        Some(self.facts.model_meta_fetching(provider, model).await)
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
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::ConfigLanes;
    use mixdog_core_ports::ports::route::Route;
    use mixdog_core_ports::ports::route_facts::RouteSender;

    use super::*;

    struct NoLiveRoute;
    impl LiveRoute for NoLiveRoute {
        fn route(&self, _: &ThreadId) -> Route {
            Route::new()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    struct NoGauge;
    impl ContextStatusCache for NoGauge {
        fn invalidate(&self, _: &ThreadId) {}
    }

    struct NoAgents;
    #[async_trait]
    impl CustomAgentIds for NoAgents {
        async fn ids(&self) -> Vec<String> {
            Vec::new()
        }
    }

    struct NoRefresh;
    impl AuthRefresh for NoRefresh {
        fn after_credential_change(&self) {}
        fn custom_provider_removed(&self, _: &str) {}
        fn adopt_credentials(&self) {}
        fn after_usage_auth_change(&self) {}
        fn release_admission_cooldowns(&self) {}
        fn account_selection_changed(&self) {}
    }

    struct PanicCatalogReady;
    #[async_trait]
    impl ProvidersReady for PanicCatalogReady {
        async fn ensure(&self, _: Map<String, Value>) -> Result<(), String> {
            panic!("catalog readiness must not be called for ACP agent providers")
        }
    }

    struct AcpFacts {
        ready_calls: Mutex<Vec<String>>,
        ready_result: Result<(), String>,
    }

    #[async_trait]
    impl RouteFacts for AcpFacts {
        fn is_known(&self, provider: &str, _: &Map<String, Value>) -> bool {
            provider == "acp-antigravity"
        }
        async fn ensure_ready(&self, _: &Map<String, Value>, provider: &str) -> Result<(), String> {
            self.ready_calls.lock().unwrap().push(provider.to_owned());
            self.ready_result.clone()
        }
        fn model_meta(&self, provider: &str, model: &str) -> Value {
            json!({
                "id": model,
                "provider": provider,
                "runner": "acp",
                "supportsWebSearch": model != "gemini-pro-orchestrator",
            })
        }
        fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
            None
        }
        fn catalog_knows(&self, _: &str, provider: &str) -> bool {
            provider == "acp-antigravity"
        }
        fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
            false
        }
        fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
            false
        }
        async fn sender(&self, _: Option<&Map<String, Value>>, _: &str) -> Result<Option<RouteSender>, String> {
            Ok(None)
        }
        fn registered(&self, _: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
            None
        }
        fn init_error(&self, _: &str) -> Option<String> {
            None
        }
    }

    #[tokio::test]
    async fn config_hosts_routes_acp_web_search_readiness_and_meta_through_route_facts() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let path = dir.path().join("mixdog-config.json");
        #[allow(clippy::disallowed_methods, reason = "test setup writes config fixture")]
        std::fs::write(&path, br#"{"agent":{}}"#).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io })
            .await
            .unwrap();
        let facts = Arc::new(AcpFacts { ready_calls: Mutex::default(), ready_result: Ok(()) });
        let hosts = ConfigHosts {
            config,
            routes: Arc::new(NoLiveRoute),
            gauge: Arc::new(NoGauge),
            agents: Arc::new(NoAgents),
            facts: facts.clone(),
            ready: Arc::new(PanicCatalogReady),
            refresh: Arc::new(NoRefresh),
            env: Arc::new(|_| None),
            agent_providers: Arc::new(|p| p == "acp-antigravity"),
            surface: mixdog_core_base::surface::SurfaceGeneration::default(),
        };

        assert!(hosts.agent_provider("acp-antigravity"));
        hosts.ensure_agent_provider_ready("acp-antigravity").await.unwrap();
        assert_eq!(*facts.ready_calls.lock().unwrap(), ["acp-antigravity"]);

        let good = hosts.lookup_model_meta("acp-antigravity", "gemini-3-flash").await;
        assert!(hosts.web_search_capable("acp-antigravity", good.as_ref()));

        let orch = hosts.lookup_model_meta("acp-antigravity", "gemini-pro-orchestrator").await;
        assert!(!hosts.web_search_capable("acp-antigravity", orch.as_ref()));
    }
}
