//! The subscription route's model cache, one file per signed-in user: a fresh file answers without a fetch, a stale, damaged
//! or other-version one is fetched over and rewritten, and only a successful, non-empty fetch is written; a failed fetch
//! answers the route's public floor (`anthropic-oauth.mjs` `listModels`), never a kept roster.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::catalog::ModelSource;
use mixdog_ai::catalog::OauthModelCache;
use mixdog_ai::oauth::CredentialIo;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RosterIdentity;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

const HOUR: i64 = 60 * 60 * 1000;
const FETCHED_AT: i64 = 1_700_000_000_000;
fn identity() -> RosterIdentity {
    RosterIdentity { account: Some(mixdog_ai::catalog::account_fingerprint(&["user-1"])), ..Default::default() }
}

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

fn listed() -> Vec<ModelRecord> {
    let mut opus = ModelRecord::new("claude-opus-4-8");
    opus.display_name = Some("Claude Opus 4.8".into());
    opus.context_window = Some(200_000);
    opus.max_output_tokens = Some(32_000);
    let mut haiku = ModelRecord::new("claude-haiku-4-5");
    haiku.context_window = Some(200_000);
    vec![opus, haiku]
}

struct Fetch {
    calls: Arc<AtomicUsize>,
    answer: Option<Vec<ModelRecord>>,
}

#[async_trait]
impl ModelListing for Fetch {
    async fn roster_identity(&self) -> RosterIdentity {
        identity()
    }

    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.answer.clone().ok_or_else(|| ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

struct Setup {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
    source: ModelSource,
    cache: OauthModelCache,
}

/// A source over `answer` whose cache clock reads `now`.
fn setup(answer: Option<Vec<ModelRecord>>, now: i64) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || now));
    let calls = Arc::new(AtomicUsize::new(0));
    let source = ModelSource::new(ProviderId::from("anthropic-oauth"), Arc::new(Fetch { calls: calls.clone(), answer })).with_oauth_cache(cache.clone());
    Setup { dir, calls, source, cache }
}

impl Setup {
    fn path(&self) -> PathBuf {
        self.dir.path().join(format!("anthropic-oauth-models.{}.json", mixdog_ai::catalog::roster_key(&identity()).unwrap()))
    }

    fn fetches(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn file(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.path()).unwrap()).unwrap()
    }

    fn put(&self, text: &str) {
        std::fs::write(self.path(), text).unwrap();
    }
}

fn record(version: i64, fetched_at: Option<i64>, models: Value) -> String {
    let mut record = json!({ "version": version, "models": models, "account": mixdog_ai::catalog::roster_key(&identity()), "provenance": "fetched" });
    if let Some(at) = fetched_at {
        record["fetchedAt"] = json!(at);
    }
    record.to_string()
}

fn rows() -> Value {
    json!([{ "id": "claude-sonnet-4-6", "display": "Sonnet", "contextWindow": 200000, "outputTokens": 64000, "latest": true }])
}

#[tokio::test]
async fn the_first_listing_is_fetched_and_written_and_the_second_is_served_from_the_file() {
    let s = setup(Some(listed()), FETCHED_AT);
    let first = s.source.list().await.unwrap();
    let second = s.source.list().await.unwrap();
    assert_eq!(s.fetches(), 1);
    let ids = |rows: &[mixdog_ai::catalog::ModelRecord]| rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&first), ["claude-opus-4-8", "claude-haiku-4-5"]);
    assert_eq!(ids(&second), ids(&first));
    let file = s.file();
    assert_eq!((file["version"].clone(), file["fetchedAt"].clone()), (json!(2), json!(FETCHED_AT)));
    assert_eq!(file["models"][0]["id"], "claude-opus-4-8");
    assert_eq!(file["models"][0]["provider"], "anthropic-oauth");
    assert_eq!(file["models"][0]["contextWindow"], 200000);
}

#[tokio::test]
async fn a_cache_up_to_twenty_four_hours_old_is_fresh_and_one_millisecond_older_is_stale() {
    let fresh = setup(Some(listed()), FETCHED_AT + 24 * HOUR);
    fresh.put(&record(2, Some(FETCHED_AT), rows()));
    let rows_read = fresh.source.list().await.unwrap();
    assert_eq!((fresh.fetches(), rows_read[0].id.as_str()), (0, "claude-sonnet-4-6"), "served from the file, no fetch");
    assert_eq!(fresh.file()["fetchedAt"], FETCHED_AT, "a hit writes nothing");

    let stale = setup(Some(listed()), FETCHED_AT + 24 * HOUR + 1);
    stale.put(&record(2, Some(FETCHED_AT), rows()));
    stale.source.list().await.unwrap();
    assert_eq!(stale.fetches(), 1);
    assert_eq!(stale.file()["fetchedAt"], FETCHED_AT + 24 * HOUR + 1, "rewritten with the fetch time");
}

#[tokio::test]
async fn a_missing_damaged_or_other_version_file_is_no_cache() {
    let bodies = [
        None,
        Some("not json".to_owned()),
        Some(record(1, Some(FETCHED_AT), rows())),
        Some(record(2, None, rows())),
        Some(record(2, Some(FETCHED_AT), json!("x"))),
    ];
    for body in bodies {
        let s = setup(Some(listed()), FETCHED_AT);
        if let Some(body) = &body {
            s.put(body);
        }
        assert!(s.cache.load_for(&identity()).await.is_none(), "{body:?}");
        s.source.list().await.unwrap();
        assert_eq!(s.fetches(), 1, "{body:?}");
        assert_eq!(s.file()["version"], 2, "rewritten as a current file: {body:?}");
    }
}

#[tokio::test]
async fn an_empty_listing_answers_empty_and_is_not_kept() {
    let s = setup(Some(Vec::new()), FETCHED_AT);
    assert!(s.source.list().await.unwrap().is_empty());
    assert!(!s.path().exists(), "an empty answer is no roster");
    assert!(s.source.list().await.unwrap().is_empty());
    assert_eq!(s.fetches(), 2, "nothing was kept, so it is asked again");
}

/// The kept roster is not a failure's answer: the floor is (a source without the adapter's floor has the failure).
#[tokio::test]
async fn a_failed_fetch_shows_no_kept_roster_and_does_not_rewrite_it() {
    let s = setup(None, FETCHED_AT + 30 * HOUR);
    let stale = record(2, Some(FETCHED_AT), rows());
    s.put(&stale);
    assert!(s.source.listing().await.is_err(), "the previous discovery is not the answer");
    assert_eq!(s.fetches(), 1);
    assert_eq!(std::fs::read_to_string(s.path()).unwrap(), stale);
}
#[tokio::test]
async fn only_the_subscription_route_has_a_cache_file() {
    let dir = tempfile::tempdir().unwrap();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(|| FETCHED_AT));
    let listing = Arc::new(Fetch { calls: Arc::new(AtomicUsize::new(0)), answer: Some(listed()) });
    ModelSource::new(ProviderId::from("anthropic"), listing).with_oauth_cache(cache).list().await.unwrap();
    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "the API-key route keeps no roster file");
}
