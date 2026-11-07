//! The real [`ExplorerHost`]: the route the `explore` tool runs on and the read-only filesystem
//! tools, as Node's `runtime/explore/tool.mjs` takes them.
//!
//! - route: `resolveMaintenanceRoute({ agent: 'explore-agent', config, includeDefault: false })`,
//!   i.e. the saved `agents.explore` route (never Main's), none while Explore is switched off;
//!   then `initProviders(config.providers)` and `getProvider(route.provider)`.
//! - tools: `readOnlyFilesystemTools()`, one list for the process (identical schema bytes for
//!   every explorer).

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_agent::explorer::ExplorerHost;
use mixdog_agent::explorer::ExplorerRoute;
use mixdog_agent::tools::ToolSet;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_config::config::agent_disabled;
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
    registry: Arc<ProviderRegistry>,
    /// Bound once the pool exists: the pool holds the `explore` tool, which holds this host.
    tools: OnceLock<ToolSet>,
}

impl ConfigExplorerHost {
    pub fn new(config: ConfigSnapshot, registry: Arc<ProviderRegistry>) -> Self {
        Self { config, registry, tools: OnceLock::new() }
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

#[async_trait]
impl ExplorerHost for ConfigExplorerHost {
    async fn route(&self) -> Result<ExplorerRoute, String> {
        let config = (self.config)();
        let chosen = match choose(&config) {
            Chosen::NoModel => return Err(NO_MODEL.to_owned()),
            chosen => chosen,
        };
        let providers = config.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        self.registry.init_providers(&providers).await.map_err(|error| error.message)?;
        let Chosen::Route(route) = chosen else {
            return Err(not_ready("undefined"));
        };
        let Some(provider) = self.registry.get(&route.provider).await else {
            return Err(not_ready(&route.provider));
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
mod tests {
    use serde_json::json;

    use super::*;

    /// `resolveMaintenanceRoute({ agent: 'explore-agent', config, includeDefault: false })`, run
    /// in Node on these configs (`fixtures/tool-pool/explore-route.json`).
    #[test]
    fn the_route_is_the_saved_explore_route_as_node_resolves_it() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/tool-pool/explore-route.json")).expect("fixture");
        for case in golden["routes"].as_array().expect("routes") {
            let stored = mixdog_core_config::config::agent_routes::stored_file_of(&case["config"]);
            let config = stored["agent"].as_object().expect("config");
            let route = &case["route"];
            let want = match route {
                Value::Null | Value::String(_) => Chosen::NoModel,
                Value::Array(_) => Chosen::Array,
                _ => Chosen::Route(Candidate {
                    provider: route["provider"].as_str().expect("provider").to_owned(),
                    model: route["model"].as_str().expect("model").to_owned(),
                    effort: route.get("effort").and_then(Value::as_str).map(str::to_owned),
                    fast: route["fast"] == json!(true),
                    model_parameters: route.get("modelParameters").cloned(),
                }),
            };
            assert_eq!(choose(config), want, "{}", case["name"]);
        }
    }
}
