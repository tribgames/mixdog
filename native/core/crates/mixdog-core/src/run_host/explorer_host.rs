//! The real [`ExplorerHost`]: the route the `explore` tool runs on and the read-only filesystem
//! tools, as Node's `runtime/explore/tool.mjs` takes them.
//!
//! - route: `resolveMaintenanceRoute({ agent: 'explore-agent', config, includeDefault: false })`,
//!   i.e. the saved `agents.explore` route (never Main's), none while Explore is switched off;
//!   then `initProviders(config.providers)` and `getProvider(route.provider)`. Explore runs its tools in
//!   Mixdog's loop, so a route an agent serves is refused (its settings refuse to save one).
//! - tools: `readOnlyFilesystemTools()`, one list for the process (identical schema bytes for
//!   every explorer).

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_agent::explorer::ExplorerHost;
use mixdog_agent::explorer::ExplorerRoute;
use mixdog_agent::tools::ToolSet;
use mixdog_ai::service::admin_route::{ensure_provider_enabled, provider_switched_off};
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_config::config::agent_disabled;
use mixdog_core_ports::ports::route_facts::{RouteFacts, RouteSender};
use mixdog_core_run::run_host::hop_host::ConfigSnapshot;
use serde_json::Map;
use serde_json::Value;

use crate::run_host::session_tools::readonly_filesystem_tools;
use crate::run_host::summary_host::trimmed;

/// The settings agent the hidden `explore-agent` runs on (`ROLE_BY_MAINT_KEY.explore`).
const EXPLORE_ROLE: &str = "explore";

/// What the tool answers when no route is saved.
pub const NO_MODEL: &str = "Explore has no model; pick one under Workflows → Built-in agents → Explore";

/// `normalizeMaintenanceCandidate` of a complete object route.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Candidate {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub fast: bool,
    pub model_parameters: Option<Value>,
}

#[derive(PartialEq, Debug)]
pub(crate) enum Chosen {
    NoModel,
    Route(Candidate),
    /// Node returns an array route as it is; it has no `provider`, so no provider is ready.
    Array,
}

/// `resolveMaintenanceRoute` for `explore-agent` over an agent config.
pub(crate) fn choose(config: &Map<String, Value>) -> Chosen {
    if agent_disabled(config, EXPLORE_ROLE) {
        return Chosen::NoModel;
    }
    match config.get("agents").and_then(|agents| agents.get(EXPLORE_ROLE)) {
        Some(Value::Object(route)) => {
            let (provider, model) = (trimmed(route.get("provider")), trimmed(route.get("model")));
            if provider.is_empty() || model.is_empty() {
                return Chosen::NoModel;
            }
            let effort = trimmed(route.get("effort"));
            Chosen::Route(Candidate {
                provider,
                model,
                effort: (!effort.is_empty()).then_some(effort),
                fast: route.get("fast") == Some(&Value::Bool(true)),
                model_parameters: route.get("modelParameters").filter(|p| p.is_object()).cloned(),
            })
        }
        Some(Value::Array(_)) => Chosen::Array,
        // No route, or a value that is no route (a preset name): the tool has no model.
        _ => Chosen::NoModel,
    }
}

pub struct ConfigExplorerHost {
    config: ConfigSnapshot,
    facts: Arc<dyn RouteFacts>,
    /// Bound once the pool exists: the pool holds the `explore` tool, which holds this host.
    tools: OnceLock<ToolSet>,
}

impl ConfigExplorerHost {
    pub fn new(config: ConfigSnapshot, facts: Arc<dyn RouteFacts>) -> Self {
        Self { config, facts, tools: OnceLock::new() }
    }

    /// Takes the read-only filesystem tools out of `pool`, the registry the session tool sets
    /// are built from (`tools(Services)`). Once, before the first query.
    pub fn bind(&self, pool: &[Arc<dyn Tool>]) {
        assert!(self.tools.set(ToolSet::new(readonly_filesystem_tools(pool))).is_ok(), "the explorer's tools are bound once");
    }
}

fn not_ready(provider: &str) -> String {
    format!("provider \"{provider}\" is not ready")
}

/// A route an agent serves runs the agent's own loop, which sends no request of Mixdog's: Explore's tools cannot run there.
fn on_agent(provider: &str, model: &str) -> String {
    format!("Explore cannot run on {provider}/{model}: an agent's route runs the agent's own loop, not Explore's tools. {NO_MODEL}")
}

#[async_trait]
impl ExplorerHost for ConfigExplorerHost {
    async fn route(&self) -> Result<ExplorerRoute, String> {
        let config = (self.config)();
        let chosen = match choose(&config) {
            Chosen::NoModel => return Err(NO_MODEL.to_owned()),
            chosen => chosen,
        };
        let Chosen::Route(route) = chosen else {
            let providers = config.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
            self.facts.sender(Some(&providers), "undefined").await?;
            return Err(not_ready("undefined"));
        };
        // A provider the user switched off is not there, though it may still be registered from before.
        if provider_switched_off(&config, &route.provider) {
            return Err(not_ready(&route.provider));
        }
        // As a turn's hop does: a key-only provider has no enabled entry in the stored map.
        let providers = ensure_provider_enabled(&config, &route.provider);
        let provider = match self.facts.sender(Some(&providers), &route.provider).await? {
            Some(RouteSender::Provider(provider)) => provider,
            Some(RouteSender::Agent(_)) => return Err(on_agent(&route.provider, &route.model)),
            None => return Err(not_ready(&route.provider)),
        };
        Ok(ExplorerRoute {
            model: route.model,
            provider,
            effort: route.effort,
            fast: route.fast,
            model_parameters: route.model_parameters,
            // The caller's thread: the explorer takes it from the call.
            owner_session_id: None,
        })
    }

    fn tools(&self) -> ToolSet {
        self.tools.get().expect("the explorer's tools are bound before a query").clone()
    }
}

#[cfg(test)]
mod key_provider_tests {
    use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::ProviderAdapter;
    use serde_json::json;

    use super::*;
    use crate::run_host::compaction_world::tests::facts_in;

    /// The host over `config`, its providers built by `registry`; the directory holds the facts' files.
    async fn host_over(config: Map<String, Value>, registry: Arc<ProviderRegistry>) -> (tempfile::TempDir, ConfigExplorerHost) {
        let dir = tempfile::tempdir().unwrap();
        let facts = facts_in(dir.path(), registry).await;
        (dir, ConfigExplorerHost::new(Arc::new(move || config.clone()), facts))
    }

    /// Builds a provider only from an entry the config enables, and only when its key is stored.
    struct StoredKey;

    #[async_trait]
    impl ProviderBuilder for StoredKey {
        async fn build(&self, name: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            if name != "openrouter" || config.get("enabled") != Some(&Value::Bool(true)) {
                return Err(format!("unknown enabled provider: {name}"));
            }
            Ok(Arc::new(MockProvider::new([])))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn an_api_key_provider_with_no_enabled_entry_resolves_on_a_cold_registry() {
        let config = json!({ "enabledAgents": ["explore"], "agents": { "explore": { "provider": "openrouter", "model": "some/model" } }, "providers": {} });
        let config = config.as_object().expect("config").clone();
        let (_dir, host) = host_over(config, Arc::new(ProviderRegistry::new(Arc::new(StoredKey)))).await;
        let route = host.route().await.expect("the explorer's provider is initialised from the stored key");
        assert_eq!(route.model, "some/model");
    }

    /// Explore runs its read-only tools in Mixdog's loop: a saved route an agent serves is refused, saying so, and
    /// no provider of that name is asked of the registry.
    #[tokio::test]
    async fn a_route_an_agent_serves_is_refused_without_asking_the_registry() {
        let config = json!({ "enabledAgents": ["explore"], "agents": { "explore": { "provider": "acp-agent", "model": "m" } }, "providers": {} });
        let config = config.as_object().expect("config").clone();
        let (_dir, host) = host_over(config, Arc::new(ProviderRegistry::new(Arc::new(StoredKey)))).await;
        assert_eq!(host.route().await.err(), Some(on_agent("acp-agent", "m")));
    }

    #[tokio::test]
    async fn an_explicitly_disabled_provider_stays_disabled_even_with_its_key_stored() {
        let config = json!({ "enabledAgents": ["explore"], "agents": { "explore": { "provider": "openrouter", "model": "some/model" } }, "providers": { "openrouter": { "enabled": false } } });
        let config = config.as_object().expect("config").clone();
        let (_dir, host) = host_over(config, Arc::new(ProviderRegistry::new(Arc::new(StoredKey)))).await;
        let error = host.route().await.err().expect("a provider the user switched off gives no route");
        assert_eq!(error, not_ready("openrouter"));
    }

    /// A provider registered while it was on and switched off since is not used: the registry still holds it, the route
    /// does not take it.
    #[tokio::test]
    async fn a_provider_switched_off_after_it_was_registered_gives_no_route() {
        let config = json!({ "enabledAgents": ["explore"], "agents": { "explore": { "provider": "openrouter", "model": "some/model" } }, "providers": {} });
        let config = Arc::new(std::sync::Mutex::new(config.as_object().expect("config").clone()));
        let registry = Arc::new(ProviderRegistry::new(Arc::new(StoredKey)));
        let dir = tempfile::tempdir().unwrap();
        let host = ConfigExplorerHost::new(
            Arc::new({
                let config = config.clone();
                move || config.lock().unwrap().clone()
            }),
            facts_in(dir.path(), registry.clone()).await,
        );
        host.route().await.expect("registered while on");
        config.lock().unwrap()["providers"] = json!({ "openrouter": { "enabled": false }, "anthropic": { "enabled": true } });
        assert!(registry.get("openrouter").await.is_some(), "still registered");
        assert_eq!(host.route().await.err(), Some(not_ready("openrouter")));
    }
}

#[cfg(test)]
mod tests {}
