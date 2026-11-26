//! The daemon's search host: a thread is its own session, a provider is the registry's, and the routes it reads are the stored
//! web-search route and the thread's Main route.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource, ProviderReadiness};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderAdapter, ProviderError, WireRequest};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{Config, ConfigLanes};
use mixdog_core_ports::ports::route::{LiveRoute, Route};
use mixdog_core_ports::ports::route_facts::{AgentAnswer, AgentAsk, CatalogFacts, RouteFacts, RouteSender};
use mixdog_rt::LaneToken as _;
use mixdog_tools::web::{ConfiguredSearchRoutes, SearchFamily, SearchHost, SearchProvider, SearchRoutes};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::model_list::ModelListService;
use super::web_search_host::RegistrySearchHost;
use super::web_search_models::{WebSearchModelsService, WebSearchRoutes};
use crate::domains::ai_account::collaborators::WebSearchModels;

/// The route provider an agent outside the loop serves (not web-search capable).
const AGENT: &str = "acp-agent";
const ANTIGRAVITY: &str = "acp-antigravity";
const ANTIGRAVITY_CLI: &str = "acp-antigravity-cli";

fn is_test_agent(provider: &str) -> bool {
    matches!(provider, AGENT | ANTIGRAVITY | ANTIGRAVITY_CLI)
}

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// Builds every provider as a scripted one, but none for an agent's route, as no family of the real builder serves one.
struct Builds;

#[async_trait]
impl ProviderBuilder for Builds {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if is_test_agent(name) {
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
        Ok(true)
    }
}

/// The route cell of every conversation.
struct Cells(HashMap<ThreadId, Route>);

impl LiveRoute for Cells {
    fn route(&self, thread: &ThreadId) -> Route {
        self.0.get(thread).cloned().unwrap_or_default()
    }
    fn adopt_held(&self, _: &ThreadId, _: &Route) {}
}

fn thread_of(index: usize) -> ThreadId {
    ThreadId::from(format!("thread-{index}").as_str())
}

/// The facts the composition hands the host: the catalog's, with an agent outside the loop serving [`AGENT`] (as
/// `mixdog_acp::routes::AgentRouteFacts` answers for one).
struct AgentFacts(Arc<dyn RouteFacts>);

#[async_trait]
impl RouteFacts for AgentFacts {
    fn is_known(&self, provider: &str, config: &Map<String, Value>) -> bool {
        is_test_agent(provider) || self.0.is_known(provider, config)
    }
    async fn ensure_ready(&self, config: &Map<String, Value>, provider: &str) -> Result<(), String> {
        if is_test_agent(provider) { Ok(()) } else { self.0.ensure_ready(config, provider).await }
    }
    fn model_meta(&self, provider: &str, model: &str) -> Value {
        if is_test_agent(provider) {
            let capable = matches!(provider, ANTIGRAVITY | ANTIGRAVITY_CLI) && !model.starts_with("gemini-pro-orchestrator");
            json!({ "id": model, "provider": provider, "runner": "acp", "supportsWebSearch": capable })
        } else {
            self.0.model_meta(provider, model)
        }
    }
    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        if is_test_agent(provider) { None } else { self.0.window_meta(provider, model, meta) }
    }
    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        is_test_agent(provider) || self.0.catalog_knows(model, provider)
    }
    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
        !is_test_agent(provider) && self.0.fast_capable(provider, meta, effort, params)
    }
    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
        !is_test_agent(provider) && self.0.ultrafast_capable(provider, meta)
    }
    async fn sender(&self, providers: Option<&Map<String, Value>>, provider: &str) -> Result<Option<RouteSender>, String> {
        if is_test_agent(provider) { Ok(Some(RouteSender::Agent(Arc::new(Unasked)))) } else { self.0.sender(providers, provider).await }
    }
    fn registered(&self, provider: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
        (!is_test_agent(provider)).then(|| self.0.registered(provider)).flatten()
    }
    fn init_error(&self, provider: &str) -> Option<String> {
        (!is_test_agent(provider)).then(|| self.0.init_error(provider)).flatten()
    }
    fn default_search_fallback(&self, config: &Map<String, Value>, main_provider: &str, main_model: &str) -> mixdog_ai::service::routes::DefaultSearchFallback {
        self.0.default_search_fallback(config, main_provider, main_model)
    }
}

/// An agent no hosted search asks anything.
struct Unasked;

#[async_trait]
impl AgentAsk for Unasked {
    async fn ask(&self, _: &str, _: &str, _: &str) -> Result<AgentAnswer, String> {
        unreachable!("a hosted search asks no agent")
    }
}

/// The host over a config whose agent section is `agent` and the given route cells; the directory
/// holds the config file for as long as the host lives.
async fn host(agent: Value, cells: HashMap<ThreadId, Route>) -> (tempfile::TempDir, Arc<RegistrySearchHost>) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let path = dir.path().join("mixdog-config.json");
    let bytes = serde_json::to_vec(&json!({ "agent": agent })).unwrap();
    let file = path.clone();
    tokens
        .durability_io
        .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &file, &bytes, &mixdog_statefile::Opts::default()))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
    let registry = Arc::new(ProviderRegistry::new(Arc::new(Builds)));
    let readiness = ProviderReadiness::new(registry.clone(), catalog.clone());
    let facts = Arc::new(AgentFacts(Arc::new(CatalogFacts { catalog: catalog.clone(), readiness, registry, config: config.clone() })));
    (dir, Arc::new(RegistrySearchHost { cells: Arc::new(Cells(cells)), config, catalog, facts }))
}

/// The default web-search route follows Main. A Main route an agent serves cannot search hosted, and is answered as a
/// Main route whose provider has no hosted search (`openrouter`) is: no candidate and the default route's sentence,
/// or the configured fallback; no provider of the agent's name is asked of the registry.
#[tokio::test]
async fn a_main_route_on_an_agent_searches_as_one_whose_provider_cannot() {
    let fallback = json!({ "webSearchRoute": { "provider": "default", "model": "default", "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }] } });
    for agent in [json!({}), fallback] {
        let mut answers = Vec::new();
        for provider in [AGENT, "openrouter"] {
            let cells = HashMap::from([(thread_of(1), json!({ "provider": provider, "model": "m" }).as_object().unwrap().clone())]);
            let (_dir, host) = host(agent.clone(), cells).await;
            let routes = ConfiguredSearchRoutes::new(host);
            let candidates = routes.candidates(&thread_of(1)).await.unwrap_or_else(|error| panic!("{provider}: {error}"));
            let candidates: Vec<(String, String)> = candidates.into_iter().map(|candidate| (candidate.provider, candidate.model)).collect();
            assert!(candidates.iter().all(|(searched, _)| searched != provider), "{provider} searched: {candidates:?}");
            answers.push((candidates, routes.no_candidate_message(&thread_of(1)).await.replace(provider, "<main>")));
        }
        assert_eq!(answers[0], answers[1], "{agent}");
    }
}

#[tokio::test]
async fn a_thread_is_its_own_session_and_a_provider_is_the_registrys() {
    let (_dir, host) = host(json!({ "webSearchRoute": { "provider": "openai", "model": "gpt-5.2" } }), HashMap::new()).await;
    assert_eq!(host.session_id(&thread_of(7)).as_deref(), Some("thread-7"));
    assert_eq!(host.stored_web_search_route(), json!({ "provider": "openai", "model": "gpt-5.2" }));
    assert!(matches!(host.provider("openai").await.unwrap(), Some(SearchProvider::Hosted(_))));
    assert!(matches!(host.provider(ANTIGRAVITY).await.unwrap(), Some(SearchProvider::Acp)));
    assert_eq!(host.main_route(&thread_of(7)), json!({}));
}

#[tokio::test]
async fn follows_main_resolves_antigravity_acp_routes_and_skips_own_orchestration() {
    for (provider, model) in [(ANTIGRAVITY, "gemini-3-flash"), (ANTIGRAVITY_CLI, "claude-opus-4-6")] {
        let cells = HashMap::from([(thread_of(1), json!({ "provider": provider, "model": model, "effort": "high" }).as_object().unwrap().clone())]);
        let (_dir, host) = host(json!({}), cells).await;
        let row = host.main_model_row(provider, model).await.unwrap().expect("route facts fallback row");
        assert_eq!(row["supportsWebSearch"], json!(true));
        assert!(matches!(host.provider(provider).await.unwrap(), Some(SearchProvider::Acp)));

        let routes = ConfiguredSearchRoutes::new(host);
        let candidates = routes.candidates(&thread_of(1)).await.unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].family, SearchFamily::Acp);
        assert_eq!((candidates[0].provider.as_str(), candidates[0].model.as_str()), (provider, model));
        assert_eq!(candidates[0].effort.as_deref(), Some("high"));
    }

    // Own-orchestration model on Main is rejected and falls back to the next route in the chain.
    let cells = HashMap::from([(thread_of(2), json!({ "provider": ANTIGRAVITY, "model": "gemini-pro-orchestrator" }).as_object().unwrap().clone())]);
    let (_dir, host) =
        host(json!({ "webSearchRoute": { "provider": "default", "model": "default", "fallbacks": [{ "provider": "openai", "model": "gpt-5.2" }] } }), cells)
            .await;
    let routes = ConfiguredSearchRoutes::new(host);
    let candidates = routes.candidates(&thread_of(2)).await.unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!((candidates[0].provider.as_str(), candidates[0].model.as_str()), ("openai", "gpt-5.2"));
}

#[tokio::test]
async fn web_search_models_offers_follows_main_for_capable_antigravity_acp_main_route() {
    let cells = HashMap::from([
        (thread_of(1), json!({ "provider": ANTIGRAVITY, "model": "gemini-3-flash" }).as_object().unwrap().clone()),
        (thread_of(2), json!({ "provider": ANTIGRAVITY, "model": "gemini-pro-orchestrator" }).as_object().unwrap().clone()),
    ]);
    let (_dir, host) = host(json!({}), cells).await;
    let list = Arc::new(ModelListService {
        catalog: host.catalog.clone(),
        config: host.config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::default(),
        host: None,
    });
    let service = WebSearchModelsService::new(
        host.catalog.clone(),
        host.config.clone(),
        list,
        WebSearchRoutes {
            cells: host.cells.clone(),
            main_route: Arc::new(|| json!({})),
            web_search_route: Arc::new(|| json!({ "provider": "default", "model": "default" })),
            facts: host.facts.clone(),
        },
    );

    let rows = service.list(Some(&thread_of(1)), false).await.unwrap();
    let default_row = rows.as_array().unwrap().iter().find(|r| r["provider"] == "default" && r["id"] == "default");
    let default_row = default_row.expect("Follows Main row offered for capable Antigravity ACP Main route");
    assert_eq!(default_row["description"], format!("Use current main model: {ANTIGRAVITY}/gemini-3-flash"));

    // Forced refresh with only Antigravity ACP ready (no enabled catalog providers) still keeps Follows Main.
    let forced = service.list(Some(&thread_of(1)), true).await.unwrap();
    let forced_default = forced.as_array().unwrap().iter().find(|r| r["provider"] == "default" && r["id"] == "default");
    assert_eq!(
        forced_default.expect("Follows Main row survives forced refresh")["description"],
        format!("Use current main model: {ANTIGRAVITY}/gemini-3-flash")
    );

    let blocked_rows = service.list(Some(&thread_of(2)), false).await.unwrap();
    assert!(
        blocked_rows.as_array().unwrap().iter().all(|r| r["provider"] != "default"),
        "Follows Main row must not be offered for an own-orchestration ACP Main model"
    );
}

#[tokio::test]
async fn cold_web_search_models_emits_no_bare_acp_row_when_agent_is_unready() {
    struct UnreadyAcpFacts(Arc<dyn RouteFacts>);
    #[async_trait]
    impl RouteFacts for UnreadyAcpFacts {
        fn is_known(&self, provider: &str, config: &Map<String, Value>) -> bool {
            is_test_agent(provider) || self.0.is_known(provider, config)
        }
        async fn ensure_ready(&self, config: &Map<String, Value>, provider: &str) -> Result<(), String> {
            if is_test_agent(provider) { Err("Antigravity is signed out".into()) } else { self.0.ensure_ready(config, provider).await }
        }
        fn model_meta(&self, provider: &str, model: &str) -> Value {
            if is_test_agent(provider) {
                json!({ "id": model, "provider": provider, "runner": "acp", "supportsWebSearch": false })
            } else {
                self.0.model_meta(provider, model)
            }
        }
        fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
            if is_test_agent(provider) { None } else { self.0.window_meta(provider, model, meta) }
        }
        fn catalog_knows(&self, model: &str, provider: &str) -> bool {
            is_test_agent(provider) || self.0.catalog_knows(model, provider)
        }
        fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
            !is_test_agent(provider) && self.0.fast_capable(provider, meta, effort, params)
        }
        fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
            !is_test_agent(provider) && self.0.ultrafast_capable(provider, meta)
        }
        async fn sender(&self, providers: Option<&Map<String, Value>>, provider: &str) -> Result<Option<RouteSender>, String> {
            if is_test_agent(provider) { Ok(None) } else { self.0.sender(providers, provider).await }
        }
        fn registered(&self, provider: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
            (!is_test_agent(provider)).then(|| self.0.registered(provider)).flatten()
        }
        fn init_error(&self, provider: &str) -> Option<String> {
            (!is_test_agent(provider)).then(|| self.0.init_error(provider)).flatten()
        }
    }

    let cells = HashMap::from([(thread_of(1), json!({ "provider": ANTIGRAVITY, "model": "gemini-3-flash" }).as_object().unwrap().clone())]);
    let (_dir, host) = host(json!({ "webSearchRoute": { "provider": ANTIGRAVITY, "model": "gemini-3-flash" } }), cells).await;
    let list = Arc::new(ModelListService {
        catalog: host.catalog.clone(),
        config: host.config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::default(),
        host: None,
    });
    let service = WebSearchModelsService::new(
        host.catalog.clone(),
        host.config.clone(),
        list,
        WebSearchRoutes {
            cells: host.cells.clone(),
            main_route: Arc::new(|| json!({})),
            web_search_route: Arc::new(|| json!({ "provider": ANTIGRAVITY, "model": "gemini-3-flash" })),
            facts: Arc::new(UnreadyAcpFacts(host.facts.clone())),
        },
    );

    let rows = service.list(Some(&thread_of(1)), false).await.unwrap();
    assert!(rows.as_array().unwrap().is_empty(), "unready ACP agent must emit neither Follows Main nor bare ACP rows: {rows}");
}

async fn host_with_snapshot(agent: Value, cells: HashMap<ThreadId, Route>, snapshot: CatalogSnapshot) -> (tempfile::TempDir, Arc<RegistrySearchHost>) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let path = dir.path().join("mixdog-config.json");
    let bytes = serde_json::to_vec(&json!({ "agent": agent })).unwrap();
    let file = path.clone();
    tokens
        .durability_io
        .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &file, &bytes, &mixdog_statefile::Opts::default()))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(snapshot, Vec::new(), metadata).await);
    let registry = Arc::new(ProviderRegistry::new(Arc::new(Builds)));
    let readiness = ProviderReadiness::new(registry.clone(), catalog.clone());
    let facts = Arc::new(AgentFacts(Arc::new(CatalogFacts { catalog: catalog.clone(), readiness, registry, config: config.clone() })));
    (dir, Arc::new(RegistrySearchHost { cells: Arc::new(Cells(cells)), config, catalog, facts }))
}

#[tokio::test]
async fn default_web_search_never_picks_another_provider_and_uses_same_provider_quick_model() {
    use mixdog_ai::catalog::ModelRecord;
    use mixdog_protocol::ProviderId;

    // Non-search Main provider never sweeps other configured/registered providers.
    let cells = HashMap::from([(thread_of(1), json!({ "provider": "openrouter", "model": "anthropic/claude-opus-4" }).as_object().unwrap().clone())]);
    let (_dir, no_sweep_host) = host_with_snapshot(
        json!({
            "providers": {
                "anthropic": { "enabled": true, "model": "claude-sonnet-4-5" },
                "openai": { "enabled": true, "model": "gpt-5.2" }
            }
        }),
        cells,
        CatalogSnapshot::default(),
    )
    .await;
    no_sweep_host.facts.ensure_ready(&no_sweep_host.config.agent(), "openai").await.unwrap();
    no_sweep_host.facts.ensure_ready(&no_sweep_host.config.agent(), "anthropic").await.unwrap();
    let routes = ConfiguredSearchRoutes::new(no_sweep_host);
    assert!(routes.candidates(&thread_of(1)).await.unwrap().is_empty());
    assert_eq!(
        routes.no_candidate_message(&thread_of(1)).await,
        "default web search route requires the current main model to support native web search (openrouter/anthropic/claude-opus-4)"
    );

    // Same-provider stand-in picks the quick model by rule regardless of catalog order, never another provider.
    for order in [&["gpt-5.2-codex", "gpt-5.2", "gpt-5-mini", "gpt-5.2-mini"][..], &["gpt-5.2-mini", "gpt-5-mini", "gpt-5.2", "gpt-5.2-codex"][..]] {
        let mut snapshot = CatalogSnapshot::default();
        snapshot.models.insert(ProviderId::from("openai-oauth"), order.iter().map(|id| ModelRecord::new(ProviderId::from("openai-oauth"), *id)).collect());
        let cells = HashMap::from([(thread_of(1), json!({ "provider": "openai-oauth", "model": "gpt-5.2-codex" }).as_object().unwrap().clone())]);
        let (_dir, same_host) = host_with_snapshot(
            json!({
                "providers": {
                    "anthropic": { "enabled": true, "model": "claude-sonnet-4-5" },
                    "openai-oauth": { "enabled": true, "model": "gpt-5.2" }
                }
            }),
            cells,
            snapshot,
        )
        .await;
        same_host.facts.ensure_ready(&same_host.config.agent(), "anthropic").await.unwrap();
        let routes = ConfiguredSearchRoutes::new(same_host);
        let candidates = routes.candidates(&thread_of(1)).await.unwrap();
        let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
        assert_eq!(pairs, [("openai-oauth", "gpt-5.2-mini", SearchFamily::Openai)], "{order:?}");
    }

    // Explicit webSearchRoute is used strictly as set even when other providers are configured.
    let cells = HashMap::from([(thread_of(2), json!({ "provider": "openrouter", "model": "anthropic/claude-opus-4" }).as_object().unwrap().clone())]);
    let (_dir, explicit_host) = host(
        json!({
            "webSearchRoute": { "provider": "gemini", "model": "gemini-2.5-flash" },
            "providers": {
                "openai": { "enabled": true, "model": "gpt-5.2" }
            }
        }),
        cells,
    )
    .await;
    let explicit_routes = ConfiguredSearchRoutes::new(explicit_host);
    let explicit_candidates = explicit_routes.candidates(&thread_of(2)).await.unwrap();
    let explicit_pairs: Vec<(&str, &str, SearchFamily)> = explicit_candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
    assert_eq!(explicit_pairs, [("gemini", "gemini-2.5-flash", SearchFamily::Gemini)]);
}

#[tokio::test]
async fn user_written_fallbacks_precede_automatic_same_provider_pick() {
    use mixdog_ai::catalog::ModelRecord;
    use mixdog_protocol::ProviderId;

    let mut snapshot = CatalogSnapshot::default();
    snapshot.models.insert(
        ProviderId::from("openai-oauth"),
        ["gpt-5.2-codex", "gpt-5.2", "gpt-5.2-mini"].iter().map(|id| ModelRecord::new(ProviderId::from("openai-oauth"), *id)).collect(),
    );
    let cells = HashMap::from([(thread_of(1), json!({ "provider": "openai-oauth", "model": "gpt-5.2-codex" }).as_object().unwrap().clone())]);
    let (_dir, fallback_host) = host_with_snapshot(
        json!({
            "webSearchRoute": {
                "provider": "default",
                "model": "default",
                "fallbacks": [{ "provider": "anthropic", "model": "claude-sonnet-4-5" }]
            },
            "providers": {
                "openai-oauth": { "enabled": true, "model": "gpt-5.2" }
            }
        }),
        cells,
        snapshot,
    )
    .await;
    let routes = ConfiguredSearchRoutes::new(fallback_host);
    let candidates = routes.candidates(&thread_of(1)).await.unwrap();
    let pairs: Vec<(&str, &str, SearchFamily)> = candidates.iter().map(|c| (c.provider.as_str(), c.model.as_str(), c.family)).collect();
    assert_eq!(pairs, [("anthropic", "claude-sonnet-4-5", SearchFamily::Anthropic), ("openai-oauth", "gpt-5.2-mini", SearchFamily::Openai)]);
}

#[tokio::test]
async fn default_web_search_adds_no_readiness_calls_for_other_providers() {
    use std::sync::Mutex;

    struct CountingFacts {
        inner: Arc<dyn RouteFacts>,
        ready_calls: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl RouteFacts for CountingFacts {
        fn is_known(&self, provider: &str, config: &Map<String, Value>) -> bool {
            self.inner.is_known(provider, config)
        }
        async fn ensure_ready(&self, config: &Map<String, Value>, provider: &str) -> Result<(), String> {
            self.ready_calls.lock().unwrap().push(provider.to_owned());
            self.inner.ensure_ready(config, provider).await
        }
        fn model_meta(&self, provider: &str, model: &str) -> Value {
            self.inner.model_meta(provider, model)
        }
        fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
            self.inner.window_meta(provider, model, meta)
        }
        fn catalog_knows(&self, model: &str, provider: &str) -> bool {
            self.inner.catalog_knows(model, provider)
        }
        fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
            self.inner.fast_capable(provider, meta, effort, params)
        }
        fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
            self.inner.ultrafast_capable(provider, meta)
        }
        async fn sender(&self, providers: Option<&Map<String, Value>>, provider: &str) -> Result<Option<RouteSender>, String> {
            self.inner.sender(providers, provider).await
        }
        fn registered(&self, provider: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
            self.inner.registered(provider)
        }
        fn init_error(&self, provider: &str) -> Option<String> {
            self.inner.init_error(provider)
        }
        fn default_search_fallback(
            &self,
            config: &Map<String, Value>,
            main_provider: &str,
            main_model: &str,
        ) -> mixdog_ai::service::routes::DefaultSearchFallback {
            self.inner.default_search_fallback(config, main_provider, main_model)
        }
    }

    let wrap = |base: &Arc<RegistrySearchHost>| {
        let ready_calls = Arc::new(Mutex::new(Vec::new()));
        let counted = Arc::new(RegistrySearchHost {
            cells: base.cells.clone(),
            config: base.config.clone(),
            catalog: base.catalog.clone(),
            facts: Arc::new(CountingFacts { inner: base.facts.clone(), ready_calls: ready_calls.clone() }),
        });
        (ConfiguredSearchRoutes::new(counted), ready_calls)
    };

    // Usable Main route: only Main is checked, never other configured providers.
    let cells = HashMap::from([(thread_of(1), json!({ "provider": "openai", "model": "gpt-5.2" }).as_object().unwrap().clone())]);
    let (_dir, base) = host(json!({ "providers": { "anthropic": { "enabled": true }, "gemini": { "enabled": true } } }), cells).await;
    let (routes, calls) = wrap(&base);
    let got = routes.candidates(&thread_of(1)).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(*calls.lock().unwrap(), vec!["openai".to_owned()]);

    // Explicit webSearchRoute: zero ensure_ready calls during candidate resolution.
    let cells = HashMap::from([(thread_of(2), json!({ "provider": "openrouter", "model": "m" }).as_object().unwrap().clone())]);
    let (_dir, base) = host(
        json!({
            "webSearchRoute": { "provider": "gemini", "model": "gemini-2.5-flash" },
            "providers": { "openai": { "enabled": true } }
        }),
        cells,
    )
    .await;
    let (routes, calls) = wrap(&base);
    let got = routes.candidates(&thread_of(2)).await.unwrap();
    assert_eq!(got.len(), 1);
    assert!(calls.lock().unwrap().is_empty(), "explicit route must not run readiness work: {:?}", *calls.lock().unwrap());

    // Non-search Main provider: zero ensure_ready calls for candidates + no_candidate_message.
    let cells = HashMap::from([(thread_of(3), json!({ "provider": "openrouter", "model": "m" }).as_object().unwrap().clone())]);
    let (_dir, base) = host(json!({ "providers": { "openai": { "enabled": true } } }), cells).await;
    let (routes, calls) = wrap(&base);
    assert!(routes.candidates(&thread_of(3)).await.unwrap().is_empty());
    let _ = routes.no_candidate_message(&thread_of(3)).await;
    assert!(calls.lock().unwrap().is_empty(), "non-search Main must not probe other providers: {:?}", *calls.lock().unwrap());
}
