//! The OAuth route's model cache against Node's `makeModelCache` rules: a fresh file answers without a fetch,
//! a stale, damaged or other-version one is fetched over and rewritten, and only a successful fetch is written.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ModelListing, ModelRecord, ProviderError, ReasoningOption};
use mixdog_protocol::ProviderId;
use serde_json::{Value, json};

use super::{CACHE_FILE, OauthModelCache};
use crate::catalog::ModelSource;
use crate::oauth::CredentialIo;

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;

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

fn fetched() -> Vec<ModelRecord> {
    let mut record = ModelRecord::new("claude-sonnet-4-6");
    record.display_name = Some("Claude Sonnet 4.6".to_owned());
    record.context_window = Some(1_000_000);
    record.max_output_tokens = Some(64_000);
    record.supports_reasoning = Some(true);
    record.efforts_stated = true;
    record.picker.reasoning_options = vec![ReasoningOption { kind: "effort".to_owned(), values: vec!["low".to_owned(), "high".to_owned()] }];
    record.reasoning_levels = vec!["low".to_owned(), "high".to_owned()];
    record.picker.tier = Some("version".to_owned());
    record.picker.latest = true;
    vec![record]
}

/// A row as Node's `_normalizeAnthropicModel` writes it into the cache.
fn node_row(id: &str) -> Value {
    json!({
        "id": id, "display": "Claude Cached", "family": "opus", "provider": "anthropic",
        "contextWindow": 500000, "outputTokens": 32000, "tier": "version", "latest": false,
        "supportsReasoning": true, "reasoningOptions": [{ "type": "effort", "values": ["low", "max"] }],
        "thinkingTypes": { "adaptive": true, "enabled": false }
    })
}

struct Fixture {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
    source: ModelSource,
}

fn fixture(answer: Option<Vec<ModelRecord>>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io).with_clock(Arc::new(|| NOW));
    let calls = Arc::new(AtomicUsize::new(0));
    let listing = Arc::new(Fetch { calls: calls.clone(), answer });
    let source = ModelSource::new(ProviderId::from("anthropic-oauth"), listing).with_oauth_cache(cache);
    Fixture { dir, calls, source }
}

impl Fixture {
    fn write(&self, record: Value) {
        std::fs::write(self.dir.path().join(CACHE_FILE), record.to_string()).unwrap();
    }

    fn read(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.dir.path().join(CACHE_FILE)).unwrap()).unwrap()
    }
}

fn ids(rows: &[crate::catalog::record::ModelRecord]) -> Vec<&str> {
    rows.iter().map(|r| r.id.as_str()).collect()
}

#[tokio::test]
async fn a_fresh_node_cache_answers_without_a_fetch_and_is_left_as_it_is() {
    let f = fixture(Some(fetched()));
    let record = json!({ "version": 2, "fetchedAt": NOW - HOUR, "models": [node_row("claude-opus-4-7")] });
    f.write(record.clone());
    let rows = f.source.list().await.unwrap();
    assert_eq!(ids(&rows), ["claude-opus-4-7"]);
    assert_eq!((rows[0].context_window, rows[0].output_tokens), (Some(500_000), Some(32_000)));
    assert_eq!(rows[0].display_name.as_deref(), Some("Claude Cached"));
    assert_eq!(f.calls.load(Ordering::SeqCst), 0, "a fresh cache is not fetched over");
    assert_eq!(f.read(), record, "a cache hit does not write");
}

#[tokio::test]
async fn the_ttl_is_strictly_greater_than_twenty_four_hours() {
    let f = fixture(Some(fetched()));
    f.write(json!({ "version": 2, "fetchedAt": NOW - 24 * HOUR, "models": [node_row("claude-opus-4-7")] }));
    assert_eq!(ids(&f.source.list().await.unwrap()), ["claude-opus-4-7"], "exactly 24 h old is still fresh");
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    f.write(json!({ "version": 2, "fetchedAt": NOW - 24 * HOUR - 1, "models": [node_row("claude-opus-4-7")] }));
    assert_eq!(ids(&f.source.list().await.unwrap()), ["claude-sonnet-4-6"], "a millisecond older is stale");
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_stale_cache_is_fetched_over_and_rewritten_in_nodes_shape() {
    let f = fixture(Some(fetched()));
    f.write(json!({ "version": 2, "fetchedAt": NOW - 25 * HOUR, "models": [node_row("claude-opus-4-7")] }));
    let rows = f.source.list().await.unwrap();
    assert_eq!(ids(&rows), ["claude-sonnet-4-6"]);
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    let written = f.read();
    assert_eq!((written["version"].clone(), written["fetchedAt"].clone()), (json!(2), json!(NOW)));
    let row = &written["models"][0];
    assert_eq!(row["id"], "claude-sonnet-4-6");
    assert_eq!(row["display"], "Claude Sonnet 4.6");
    assert_eq!((row["contextWindow"].clone(), row["outputTokens"].clone()), (json!(1_000_000), json!(64_000)));
    assert_eq!(row["reasoningOptions"], json!([{ "type": "effort", "values": ["low", "high"] }]));
    assert_eq!((row["family"].clone(), row["provider"].clone(), row["tier"].clone(), row["latest"].clone()), (json!("sonnet"), json!("anthropic"), json!("version"), json!(true)));
    // The next call within the day is the rewritten file's, not a second fetch.
    assert_eq!(ids(&f.source.list().await.unwrap()), ["claude-sonnet-4-6"]);
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn no_cache_a_damaged_one_or_another_version_is_fetched_over() {
    for body in [None, Some("not json".to_owned()), Some(json!({ "version": 1, "fetchedAt": NOW, "models": [node_row("claude-opus-4-7")] }).to_string()), Some(json!({ "version": 2, "models": [] }).to_string()), Some(json!({ "version": 2, "fetchedAt": NOW, "models": "x" }).to_string())] {
        let f = fixture(Some(fetched()));
        if let Some(body) = body {
            std::fs::write(f.dir.path().join(CACHE_FILE), body).unwrap();
        }
        assert_eq!(ids(&f.source.list().await.unwrap()), ["claude-sonnet-4-6"]);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.read()["fetchedAt"], json!(NOW));
    }
}

#[tokio::test]
async fn an_empty_fetch_is_written_and_then_answers_empty() {
    let f = fixture(Some(Vec::new()));
    assert!(f.source.list().await.unwrap().is_empty());
    assert_eq!(f.read()["models"], json!([]));
    assert!(f.source.list().await.unwrap().is_empty());
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_failed_fetch_does_not_fall_back_to_a_stale_cache_and_writes_nothing() {
    let f = fixture(None);
    let stale = json!({ "version": 2, "fetchedAt": NOW - 30 * HOUR, "models": [node_row("claude-opus-4-7")] });
    f.write(stale.clone());
    assert!(f.source.list().await.is_err(), "Node answers its offline floor here (the registry bridge's), never stale rows");
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.read(), stale);
}
#[tokio::test]
async fn a_record_survives_the_cache_unchanged() {
    let f = fixture(Some(fetched()));
    f.source.list().await.unwrap();
    let again = f.source.list().await.unwrap();
    let direct = ModelSource::new(ProviderId::from("anthropic-oauth"), Arc::new(Fetch { calls: Arc::new(AtomicUsize::new(0)), answer: Some(fetched()) }));
    assert_eq!(again, direct.list().await.unwrap());
}
#[tokio::test]
async fn the_registry_bridge_source_persists_its_fetch_and_only_the_oauth_route_has_a_cache() {
    use mixdog_core_api::domain::mock::MockProvider;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io).with_clock(Arc::new(|| NOW));
    let mut adapter = MockProvider::new([]);
    adapter.models = fetched();
    let adapter = Arc::new(adapter);
    let oauth = ModelSource::of_adapter(ProviderId::from("anthropic-oauth"), adapter.clone()).unwrap().with_oauth_cache(cache.clone());
    oauth.list().await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(dir.path().join(CACHE_FILE)).unwrap()).unwrap()["models"][0]["id"], "claude-sonnet-4-6");
    std::fs::remove_file(dir.path().join(CACHE_FILE)).unwrap();
    ModelSource::of_adapter(ProviderId::from("anthropic"), adapter).unwrap().with_oauth_cache(cache).list().await.unwrap();
    assert!(!dir.path().join(CACHE_FILE).exists(), "the API-key route never writes the OAuth route's file");
}