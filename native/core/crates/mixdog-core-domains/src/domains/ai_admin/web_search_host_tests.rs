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
use mixdog_tools::web::{ConfiguredSearchRoutes, SearchHost, SearchRoutes};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::web_search_host::RegistrySearchHost;

/// The route provider an agent outside the loop serves.
const AGENT: &str = "acp-agent";

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
        if name == AGENT {
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
        provider == AGENT || self.0.is_known(provider, config)
    }
    async fn ensure_ready(&self, config: &Map<String, Value>, provider: &str) -> Result<(), String> {
        if provider == AGENT { Ok(()) } else { self.0.ensure_ready(config, provider).await }
    }
    fn model_meta(&self, provider: &str, model: &str) -> Value {
        if provider == AGENT { json!({ "id": model, "provider": provider, "runner": "acp" }) } else { self.0.model_meta(provider, model) }
    }
    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        if provider == AGENT { None } else { self.0.window_meta(provider, model, meta) }
    }
    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        provider == AGENT || self.0.catalog_knows(model, provider)
    }
    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
        provider != AGENT && self.0.fast_capable(provider, meta, effort, params)
    }
    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
        provider != AGENT && self.0.ultrafast_capable(provider, meta)
    }
    async fn sender(&self, providers: Option<&Map<String, Value>>, provider: &str) -> Result<Option<RouteSender>, String> {
        if provider == AGENT { Ok(Some(RouteSender::Agent(Arc::new(Unasked)))) } else { self.0.sender(providers, provider).await }
    }
    fn registered(&self, provider: &str) -> Option<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>> {
        (provider != AGENT).then(|| self.0.registered(provider)).flatten()
    }
    fn init_error(&self, provider: &str) -> Option<String> {
        (provider != AGENT).then(|| self.0.init_error(provider)).flatten()
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
    assert!(host.provider("openai").await.unwrap().is_some());
    assert_eq!(host.main_route(&thread_of(7)), json!({}));
}
