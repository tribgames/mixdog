//! The OAuth route's model cache against what Node's own provider did: `node-oauth-model-cache.json` is recorded by
//! `benchmarks/rust-core/recorders/oauth-model-cache` (the real `AnthropicOAuthProvider.listModels` against a loopback
//! stand-in for `/v1/models`): the `anthropic-oauth-models.json` it wrote, the rows it returned, the requests that
//! reached the endpoint with no cache, a fresh one and a stale one, and the context state a session sized from that
//! file gets (`resolveRouteContextState`). A fresh file answers without a fetch, a stale, damaged or other-version one
//! is fetched over and rewritten, and only a successful fetch is written.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ModelListing, ModelRecord, ProviderError};
use mixdog_protocol::ProviderId;
use serde_json::{Value, json};

use super::{CACHE_FILE, OauthModelCache, record_of_row};
use crate::catalog::modelsdev_source::read_file;
use crate::catalog::{CatalogService, CatalogSnapshot, ModelSource, ModelsDevSource};
use crate::oauth::CredentialIo;
use crate::service::admin_route::resolve_route_context_state;

const HOUR: i64 = 60 * 60 * 1000;

fn recorded() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/oauth-model-cache/node-oauth-model-cache.json")).unwrap()
}

/// The file Node left, verbatim.
fn node_file() -> Value {
    recorded()["cold"]["cacheFile"].clone()
}

fn fetched_at() -> i64 {
    node_file()["fetchedAt"].as_i64().unwrap()
}

/// What the adapter lists for the recorded endpoint body: the recorded rows as records.
fn listed() -> Vec<ModelRecord> {
    node_file()["models"].as_array().unwrap().iter().filter_map(record_of_row).collect()
}

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

/// File I/O as lane jobs, as the code under test does it.
async fn put(path: PathBuf, text: String) {
    io().write_job(move |lane| mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other))
        .await
        .unwrap();
}

async fn get(path: PathBuf) -> Option<Vec<u8>> {
    io().read_job(move |_| Ok(read_file(&path))).await.unwrap()
}

/// A listing that counts its fetches and answers rows, or a transport failure.
struct Fetch {
    calls: Arc<AtomicUsize>,
    answer: Option<Vec<ModelRecord>>,
}

#[async_trait]
impl ModelListing for Fetch {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.answer.clone().ok_or_else(|| ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
    source: ModelSource,
}

/// A source over `answer` whose clock reads `now`.
fn fixture(answer: Option<Vec<ModelRecord>>, now: i64) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || now));
    let calls = Arc::new(AtomicUsize::new(0));
    let listing = Arc::new(Fetch { calls: calls.clone(), answer });
    let source = ModelSource::new(ProviderId::from("anthropic-oauth"), listing).with_oauth_cache(cache);
    Fixture { dir, calls, source }
}

impl Fixture {
    fn path(&self) -> PathBuf {
        self.dir.path().join(CACHE_FILE)
    }

    async fn write(&self, record: &Value) {
        put(self.path(), record.to_string()).await;
    }

    async fn read(&self) -> Value {
        serde_json::from_slice(&get(self.path()).await.unwrap()).unwrap()
    }

    fn fetches(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn ids(rows: &[crate::catalog::record::ModelRecord]) -> Vec<&str> {
    rows.iter().map(|r| r.id.as_str()).collect()
}

fn node_ids(rows: &Value) -> Vec<String> {
    rows.as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn nodes_no_cache_run_is_one_fetch_then_a_hit_and_so_is_ours() {
    let node = recorded();
    assert_eq!(node["cold"]["hits"], 1);
    let f = fixture(Some(listed()), fetched_at());
    let first = f.source.list().await.unwrap();
    let second = f.source.list().await.unwrap();
    assert_eq!(f.fetches() as u64, node["cold"]["hits"].as_u64().unwrap());
    assert_eq!(ids(&first), node_ids(&node["cold"]["first"]));
    assert_eq!(ids(&second), node_ids(&node["cold"]["second"]));
    // What Node wrote after that fetch is what we write for the same listing, key for key.
    assert_eq!(f.read().await, node_file());
}

#[tokio::test]
async fn a_fresh_node_cache_answers_without_a_fetch_and_is_left_as_it_is() {
    let node = recorded();
    assert_eq!(node["fresh"]["hits"], 0);
    let f = fixture(Some(Vec::new()), fetched_at() + HOUR);
    f.write(&node_file()).await;
    let rows = f.source.list().await.unwrap();
    assert_eq!(f.fetches(), 0, "Node's request count for a fresh cache");
    assert_eq!(ids(&rows), node_ids(&node["fresh"]["first"]));
    for (row, node_row) in rows.iter().zip(node["fresh"]["first"].as_array().unwrap()) {
        assert_eq!(row.display_name.as_deref(), node_row["display"].as_str());
        assert_eq!((row.context_window, row.output_tokens), (node_row["contextWindow"].as_u64(), node_row["outputTokens"].as_u64()));
        assert_eq!(row.picker.tier.as_deref(), node_row["tier"].as_str());
        assert_eq!(row.picker.latest, node_row["latest"].as_bool().unwrap());
    }
    assert_eq!(f.read().await, node_file(), "a cache hit does not write");
}

#[tokio::test]
async fn a_stale_node_cache_is_fetched_over_as_nodes_is() {
    let node = recorded();
    assert_eq!(node["stale"]["hits"], 1);
    let f = fixture(Some(listed()), fetched_at() + 25 * HOUR);
    f.write(&node_file()).await;
    let rows = f.source.list().await.unwrap();
    assert_eq!(f.fetches() as u64, node["stale"]["hits"].as_u64().unwrap());
    assert_eq!(ids(&rows), node_ids(&node["stale"]["first"]));
    let written = f.read().await;
    assert_eq!(written["fetchedAt"], json!(fetched_at() + 25 * HOUR), "rewritten with the fetch time");
    assert_eq!(written["models"], node_file()["models"]);
}

#[tokio::test]
async fn the_ttl_is_strictly_greater_than_twenty_four_hours() {
    let f = fixture(Some(listed()), fetched_at() + 24 * HOUR);
    f.write(&node_file()).await;
    f.source.list().await.unwrap();
    assert_eq!(f.fetches(), 0, "exactly 24 h old is still fresh");
    let f = fixture(Some(listed()), fetched_at() + 24 * HOUR + 1);
    f.write(&node_file()).await;
    f.source.list().await.unwrap();
    assert_eq!(f.fetches(), 1, "a millisecond older is stale");
}

#[tokio::test]
async fn no_cache_a_damaged_one_or_another_version_is_fetched_over() {
    let node = node_file();
    let mut other_version = node.clone();
    other_version["version"] = json!(1);
    let mut no_stamp = node.clone();
    no_stamp.as_object_mut().unwrap().shift_remove("fetchedAt");
    let mut not_an_array = node.clone();
    not_an_array["models"] = json!("x");
    for body in [None, Some("not json".to_owned()), Some(other_version.to_string()), Some(no_stamp.to_string()), Some(not_an_array.to_string())] {
        let f = fixture(Some(listed()), fetched_at());
        if let Some(body) = body {
            put(f.path(), body).await;
        }
        f.source.list().await.unwrap();
        assert_eq!(f.fetches(), 1);
        assert_eq!(f.read().await, node, "rewritten as Node's file");
    }
}

#[tokio::test]
async fn an_empty_fetch_is_written_and_then_answers_empty() {
    let f = fixture(Some(Vec::new()), fetched_at());
    assert!(f.source.list().await.unwrap().is_empty());
    assert_eq!(f.read().await["models"], json!([]));
    assert!(f.source.list().await.unwrap().is_empty());
    assert_eq!(f.fetches(), 1);
}

#[tokio::test]
async fn a_failed_fetch_does_not_fall_back_to_a_stale_cache_and_writes_nothing() {
    let f = fixture(None, fetched_at() + 30 * HOUR);
    f.write(&node_file()).await;
    assert!(f.source.list().await.is_err(), "Node answers its offline floor here (the registry bridge's), never stale rows");
    assert_eq!(f.fetches(), 1);
    assert_eq!(f.read().await, node_file());
}

#[tokio::test]
async fn a_record_survives_the_cache_unchanged() {
    let f = fixture(Some(listed()), fetched_at());
    f.source.list().await.unwrap();
    let again = f.source.list().await.unwrap();
    let direct = ModelSource::new(ProviderId::from("anthropic-oauth"), Arc::new(Fetch { calls: Arc::new(AtomicUsize::new(0)), answer: Some(listed()) }));
    assert_eq!(again, direct.list().await.unwrap());
}

#[tokio::test]
async fn the_registry_bridge_source_persists_its_fetch_and_only_the_oauth_route_has_a_cache() {
    use mixdog_core_api::domain::mock::MockProvider;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CACHE_FILE);
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(fetched_at));
    let mut adapter = MockProvider::new([]);
    adapter.models = listed();
    let adapter = Arc::new(adapter);
    let oauth = ModelSource::of_adapter(ProviderId::from("anthropic-oauth"), adapter.clone()).unwrap().with_oauth_cache(cache.clone());
    oauth.list().await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&get(path.clone()).await.unwrap()).unwrap(), node_file());
    let gone = path.clone();
    io().write_job(move |lane| mixdog_statefile::remove_file(lane, &gone)).await.unwrap();
    ModelSource::of_adapter(ProviderId::from("anthropic"), adapter).unwrap().with_oauth_cache(cache).list().await.unwrap();
    assert!(get(path).await.is_none(), "the API-key route never writes the OAuth route's file");
}

struct Offline;

#[async_trait]
impl crate::transport::http::HttpSend for Offline {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _: crate::transport::Exchange,
    ) -> Result<crate::transport::http::HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// The context state Rust sizes a route to from the roster the service holds, against what Node's
/// `resolveRouteContextState` made of the same file.
fn assert_node_route_states(service: &CatalogService, states: &Value) {
    assert!(!states.as_array().unwrap().is_empty());
    for entry in states.as_array().unwrap() {
        let (provider, model) = (entry["route"]["provider"].as_str().unwrap(), entry["route"]["model"].as_str().unwrap());
        let windows = service.cached_windows(provider, model);
        let meta = windows.map(|w| json!({ "contextWindow": w.context_window, "maxContextWindow": w.max_context_window }));
        let state = resolve_route_context_state(entry["route"].as_object().unwrap(), meta.as_ref());
        let node = &entry["state"];
        assert_eq!(
            (state.context_percent, state.context_default_percent, state.selected_context_window),
            (node["contextPercent"].as_f64(), node["contextDefaultPercent"].as_f64(), node["selectedContextWindow"].as_f64()),
            "{provider} {model}"
        );
    }
}

#[tokio::test]
async fn a_listing_that_wrote_the_cache_is_what_cached_windows_reads_after_the_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(fetched_at));
    let listing = Arc::new(Fetch { calls: Arc::new(AtomicUsize::new(0)), answer: Some(listed()) });
    let source = ModelSource::new(ProviderId::from("anthropic-oauth"), listing).with_oauth_cache(cache);
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io());
    let service = CatalogService::cold_start(CatalogSnapshot::default(), vec![source], metadata).await.with_rosters(dir.path().to_path_buf());
    assert!(service.cached_windows("anthropic-oauth", "claude-opus-4-8").is_none(), "nothing written yet");
    service.refresh().await;
    assert_node_route_states(&service, &recorded()["cold"]["routeStates"]);
}