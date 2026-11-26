//! Two production seams of the agent tool's assembly (`mixdog_agent::agent_tool::assemble`):
//!
//! - [`ModelListCatalog`]: `AgentParts.catalog`, the agent tool's model listing. It is the
//!   rows of the `model/list` service (`ModelListService::rows`), mapped to `ModelRow`.
//! - [`LateBoardNotifier`]: the `TaskNotifier` of `JobBoard::new`. A finished agent job reaches
//!   its owner through the session notification;
//!   the session directory is that delivery (`impl TaskNotifier for SessionDirectory`), and the
//!   board is built before the directory exists, so it goes through the late directory.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::model_select::{ListOptions, ModelCatalog, ModelRow};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::ai_admin::model_list::ModelListService;
use mixdog_tools::exec::TaskNotifier;
use serde_json::Value;

use mixdog_core_run::run_host::route_chain::{BotRoutes, route_candidates};

use super::compose_parts::LateDirectory;
use super::late::Bound;

/// `ModelCatalog` over the `model/list` rows. `ListOptions.provider` scopes a forced refresh to
/// the providers it names, as Node's `collectProviderModels({ force, provider })` does.
pub struct ModelListCatalog {
    pub models: Arc<ModelListService>,
    /// The registry's own state: what a built-in provider's init set aside is read from it, and nothing is started.
    pub registry: Arc<ProviderRegistry>,
    /// An ACP agent route's state: `None` when the provider is no agent's, `Some(None)` when the agent can run, else why not.
    pub agent_state: Arc<AgentState>,
    /// The bots' own routes: a bot's route is the stored one, not the config's.
    pub bots: Arc<dyn BotRoutes>,
}

/// The state of the ACP agent a provider id names.
pub type AgentState = dyn Fn(&str) -> Option<Option<String>> + Send + Sync;

/// `{ provider, id, display, catalogComplete }` of a `collectProviderModels` row.
fn model_row(row: &Value) -> ModelRow {
    let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    ModelRow {
        provider: text("provider"),
        id: text("id"),
        display: text("display"),
        catalog_complete: row.get("catalogComplete") == Some(&Value::Bool(true)),
        row: row.clone(),
    }
}

#[async_trait]
impl ModelCatalog for ModelListCatalog {
    async fn list(&self, options: ListOptions) -> Result<Vec<ModelRow>, String> {
        Ok(self.models.rows_for(options.force, options.quick, options.provider.as_deref()).await?.iter().map(model_row).collect())
    }

    async fn agent_provider(&self, agent: &str) -> Option<String> {
        let config = self.models.config.agent();
        let candidates = route_candidates(&config, agent, &*self.bots).await.ok()?;
        let route = candidates.iter().find_map(|candidate| {
            if candidate.is_object() {
                mixdog_agent::agent_tool::flow::preset::normalize_agent_route(Some(candidate)).map(Value::Object)
            } else {
                mixdog_core_config::config::agent_routes::route_of(&config, candidate)
                    .or_else(|| mixdog_agent::agent_tool::flow::preset::resolve_agent_route_candidate(&config, candidate))
            }
        })?;
        route.get("provider").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned)
    }

    async fn provider_state(&self, provider: &str) -> Option<String> {
        if let Some(state) = (self.agent_state)(provider) {
            return state;
        }
        let cause = self.registry.init_errors().get(provider).cloned();
        let switched_off = mixdog_ai::service::admin_route::provider_switched_off(&self.models.config.agent(), provider);
        // A provider the registry holds, or has not built yet, runs; one its init set aside or the user switched off does not.
        (self.registry.registered(provider).is_none() && (cause.is_some() || switched_off))
            .then(|| mixdog_ai::service::error_text::provider_unavailable_text(provider, cause.as_deref(), switched_off))
    }
}

/// The board's `TaskNotifier` through the late directory. The directory is bound once after
/// `TurnPath::new`; the composition verifies this cell (`verify_bound`) before the listener
/// accepts, and no job can finish before then, so a read of the verified cell expects it.
pub struct LateBoardNotifier(pub Arc<LateDirectory>);

impl Bound for LateBoardNotifier {
    fn cell(&self) -> &'static str {
        "agent board notifier"
    }

    fn is_bound(&self) -> bool {
        self.0.is_bound()
    }
}

#[async_trait]
impl TaskNotifier for LateBoardNotifier {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        let directory = self.0.directory().expect("the agent board notifier is verified bound before jobs run");
        directory.finished(owner, surface, task_id, status, notification).await;
    }

    async fn finished_at_hop(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String, hop: u32) {
        let directory = self.0.directory().expect("the agent board notifier is verified bound before jobs run");
        directory.finished_at_hop(owner, surface, task_id, status, notification, hop).await;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_model_row_keeps_what_the_picker_matches_on() {
        let whole = json!({ "provider": "p", "id": "m", "display": "M", "catalogComplete": true, "other": 1 });
        let row = model_row(&whole);
        assert_eq!(row, ModelRow { provider: "p".into(), id: "m".into(), display: "M".into(), catalog_complete: true, row: whole });
        assert!(!model_row(&json!({ "provider": "p", "id": "m" })).catalog_complete);
    }

    /// Builds a provider for every name but Cursor, which has no account signed in.
    struct CursorSignedOut;

    #[async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for CursorSignedOut {
        async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
            if name == "cursor-oauth" {
                return Err("not signed in — run /login".into());
            }
            Ok(Arc::new(mixdog_core_api::domain::mock::MockProvider::new([])))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(true)
        }
    }
    /// One bot, `scout`, with a route of its own.
    struct Scout;
    #[async_trait]
    impl BotRoutes for Scout {
        async fn bot_route(&self, id: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok((id == "scout").then(|| Some(json!({ "provider": "google", "model": "gemini" }))))
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn the_catalog_reports_a_signed_out_providers_state_and_the_agents_saved_provider() {
        use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
        use mixdog_ai::oauth::CredentialIo;
        use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
        use mixdog_core_api::mock::MockStatePublisher;
        use mixdog_core_config::config::{Config, ConfigLanes};

        struct Offline;
        #[async_trait]
        impl mixdog_ai::transport::http::HttpSend for Offline {
            async fn send(
                &self,
                _: mixdog_core_api::domain::provider::WireRequest,
                _: mixdog_ai::transport::Exchange,
            ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
                Err(mixdog_core_api::domain::provider::ProviderError::new(
                    mixdog_core_api::domain::provider::ErrorKind::Transient,
                    mixdog_core_api::domain::provider::DeliveryState::NotSent,
                ))
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        let path = dir.path().join("mixdog-config.json");
        crate::run_host::fixture_fs::write(
            &path,
            serde_json::to_vec(&json!({ "agent": {
                "presets": [{ "id": "light", "name": "light", "provider": "openai", "model": "gpt-mini" }],
                "agents": { "writer": { "provider": "cursor-oauth", "model": "m" }, "reader": "light" }
            } }))
            .unwrap(),
        );
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let models = Arc::new(ModelListService {
            catalog,
            config,
            primary_provider: Arc::new(String::new),
            unsupported: Arc::new(UnsupportedEfforts::default()),
            host: None,
        });
        let registry = Arc::new(ProviderRegistry::new(Arc::new(CursorSignedOut)));
        let providers = json!({ "anthropic": { "enabled": true }, "cursor-oauth": { "enabled": true } });
        registry.init_providers(providers.as_object().unwrap()).await.unwrap();
        let catalog = ModelListCatalog { models, registry, agent_state: Arc::new(|_| None), bots: Arc::new(Scout) };
        assert_eq!(catalog.agent_provider("writer").await.as_deref(), Some("cursor-oauth"));
        assert_eq!(catalog.agent_provider("reader").await.as_deref(), Some("openai"), "a route given as a preset name");
        assert_eq!(catalog.agent_provider("scout").await.as_deref(), Some("google"), "a bot's own route");
        let state = catalog.provider_state("cursor-oauth").await.expect("the set-aside provider cannot run");
        assert!(state.contains("not signed in"), "{state}");
        assert_eq!(catalog.provider_state("anthropic").await, None);
    }

    #[test]
    fn an_unbound_directory_is_reported_by_the_cell() {
        let cell = LateBoardNotifier(Arc::new(LateDirectory::default()));
        assert_eq!(crate::run_host::late::require(&[&cell]).unwrap_err().cell, "agent board notifier");
    }
}
