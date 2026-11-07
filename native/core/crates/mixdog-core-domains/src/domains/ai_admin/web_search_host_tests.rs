//! The daemon's search host against the Node recording of the hosted search
//! (`fixtures/hosted-search/golden.json`, `benchmarks/rust-core/recorders/record-hosted-search.mjs`):
//! the recorded runtimes' Main route and stored web-search route, replayed through the real config,
//! readiness and registry, give each thread the candidates Node resolved for it. The cases that
//! consult a catalog row are `mixdog-tools`' (`hosted_native_tests.rs`), where the row is the
//! recording's.

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
use mixdog_tools::web::{ConfiguredSearchRoutes, SearchCandidate, SearchHost, SearchRoutes};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::web_search_host::RegistrySearchHost;

const GOLDEN: &str = include_str!("../../../../../fixtures/hosted-search/golden.json");

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

fn view(candidate: &SearchCandidate) -> Value {
    json!({
        "provider": candidate.provider,
        "model": candidate.model,
        "effort": candidate.effort,
        "fast": candidate.fast,
        "modelParameters": candidate.model_parameters,
        "toolType": candidate.tool_type,
    })
}

/// What the recording says `thread`'s search resolves to for `case`.
async fn expect(routes: &ConfiguredSearchRoutes, thread: &ThreadId, case: &Value) {
    let name = &case["name"];
    let got = routes.candidates(thread).await;
    match (&case["candidates"], &case["error"]) {
        (Value::Array(want), _) => {
            let want: Vec<Value> = want
                .iter()
                .map(|c| json!({ "provider": c["provider"], "model": c["model"], "effort": c["effort"], "fast": c["fast"], "modelParameters": c["modelParameters"], "toolType": c["toolType"] }))
                .collect();
            let got: Vec<Value> = got.unwrap_or_else(|error| panic!("{name}: {error}")).iter().map(view).collect();
            assert_eq!(got, want, "{name}");
            if want.is_empty() {
                assert_eq!(routes.no_candidate_message(thread).await, case["noCandidate"].as_str().unwrap(), "{name}");
            }
        }
        (_, Value::String(error)) => assert_eq!(&got.unwrap_err(), error, "{name}"),
        _ => panic!("{name}: no expectation"),
    }
}

/// The recorded route cases that read no catalog row.
fn route_cases() -> Vec<Value> {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    golden["routes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| ["cached", "listed", "global"].iter().all(|key| case.get(*key).is_none()))
        .cloned()
        .collect()
}

fn main_of(case: &Value) -> Route {
    case["main"].as_object().cloned().unwrap_or_default()
}

#[tokio::test]
async fn the_hosts_candidates_are_the_ones_node_resolves() {
    let cases = route_cases();
    assert!(cases.len() > 5);
    for case in &cases {
        let agent = match case.get("webSearchRoute") {
            Some(route) => json!({ "webSearchRoute": route }),
            None => json!({}),
        };
        let (_dir, host) = host(agent, HashMap::from([(thread_of(0), main_of(case))])).await;
        expect(&ConfiguredSearchRoutes::new(host), &thread_of(0), case).await;
    }
}

#[tokio::test]
async fn one_host_answers_each_thread_with_its_own_main_route() {
    // The recorded cases that differ only in their Main route share the stored route (none).
    let cases: Vec<Value> = route_cases().into_iter().filter(|case| case.get("webSearchRoute").is_none()).collect();
    assert!(cases.len() > 2);
    let cells = cases.iter().enumerate().map(|(index, case)| (thread_of(index), main_of(case))).collect();
    let (_dir, host) = host(json!({}), cells).await;
    let routes = ConfiguredSearchRoutes::new(host);
    for (index, case) in cases.iter().enumerate().rev() {
        expect(&routes, &thread_of(index), case).await;
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
