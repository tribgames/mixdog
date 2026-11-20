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
use mixdog_rt::LaneToken as _;
use mixdog_tools::web::SearchHost;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::web_search_host::RegistrySearchHost;

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// Builds every provider as a scripted one.
struct Builds;

#[async_trait]
impl ProviderBuilder for Builds {
    async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
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
    (dir, Arc::new(RegistrySearchHost { cells: Arc::new(Cells(cells)), config, catalog, readiness, registry }))
}




#[tokio::test]
async fn a_thread_is_its_own_session_and_a_provider_is_the_registrys() {
    let (_dir, host) = host(json!({ "webSearchRoute": { "provider": "openai", "model": "gpt-5.2" } }), HashMap::new()).await;
    assert_eq!(host.session_id(&thread_of(7)).as_deref(), Some("thread-7"));
    assert_eq!(host.stored_web_search_route(), json!({ "provider": "openai", "model": "gpt-5.2" }));
    assert!(host.provider("openai").await.unwrap().is_some());
    assert_eq!(host.main_route(&thread_of(7)), json!({}));
}


