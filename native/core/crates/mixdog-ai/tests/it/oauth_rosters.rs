//! Every OAuth route that keeps a live roster on disk has its file, schema version and TTL as 1.4.5's `makeModelCache`
//! options gave them (`rosterProviders()`): written after a fetch, served while fresh, fetched again once expired; a failed
//! fetch keeps the compat routes' roster and is Grok's error (`grok-oauth.mjs` `listModels`); an Anthropic subscription's
//! roster is its account's, and another account's sign-in discards it.

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
use serde_json::json;

const HOUR: i64 = 60 * 60 * 1000;
const T0: i64 = 1_800_000_000_000;

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

struct Fetch {
    calls: Arc<AtomicUsize>,
    answer: Option<Vec<ModelRecord>>,
    identity: RosterIdentity,
}

#[async_trait]
impl ModelListing for Fetch {
    async fn roster_identity(&self) -> RosterIdentity {
        self.identity.clone()
    }
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.answer.clone().ok_or_else(|| ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

fn listed(id: &str) -> Vec<ModelRecord> {
    let mut row = ModelRecord::new(id);
    row.context_window = Some(200_000);
    row.supports_reasoning = Some(true);
    row.reasoning_levels = vec!["low".into(), "medium".into(), "high".into()];
    vec![row]
}

struct Rig {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
    source: ModelSource,
}

fn rig(dir: tempfile::TempDir, provider: &str, answer: Option<Vec<ModelRecord>>, now: i64, identity: RosterIdentity) -> Rig {
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || now));
    let calls = Arc::new(AtomicUsize::new(0));
    let source = ModelSource::new(ProviderId::from(provider), Arc::new(Fetch { calls: calls.clone(), answer, identity })).with_oauth_cache(cache);
    Rig { dir, calls, source }
}

fn who(account: &str) -> RosterIdentity {
    RosterIdentity { account: Some(mixdog_ai::catalog::account_fingerprint(&[account])), ..Default::default() }
}

/// `file` (a route's plain 1.4.5 name) as the identity's own file.
fn keyed(file: &str, identity: &RosterIdentity) -> String {
    format!("{}.{}.json", file.trim_end_matches(".json"), mixdog_ai::catalog::roster_key(identity).unwrap())
}

impl Rig {
    fn file(&self, name: &str, identity: &RosterIdentity) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.dir.path().join(keyed(name, identity))).unwrap()).unwrap()
    }
    fn fetches(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

/// One roster through its life: written with its schema version, fresh just inside its TTL, fetched again just past it,
/// and when that fetch fails the previous roster stays (`keeps`) or the failure is the answer; the file is not rewritten.
async fn lives_by_its_options(provider: &str, file: &str, version: i64, ttl_hours: i64, keeps: bool) {
    let me = who("acct-a");
    let first = rig(tempfile::tempdir().unwrap(), provider, Some(listed("model-a")), T0, me.clone());
    first.source.list().await.unwrap();
    let written = first.file(file, &me);
    assert_eq!((written["version"].clone(), written["fetchedAt"].clone()), (json!(version), json!(T0)), "{provider}: {file}");
    assert_eq!(written["models"][0]["id"], "model-a");
    assert_eq!(written["models"][0]["reasoningLevels"], json!(["low", "medium", "high"]), "{provider}: the levels survive the file");

    let inside = rig(first.dir, provider, Some(listed("model-b")), T0 + (ttl_hours - 1) * HOUR, me.clone());
    assert_eq!(inside.source.list().await.unwrap()[0].id, "model-a", "{provider}: fresh inside {ttl_hours} h");
    assert_eq!(inside.fetches(), 0);

    let past = rig(inside.dir, provider, Some(listed("model-b")), T0 + (ttl_hours + 1) * HOUR, me.clone());
    assert_eq!(past.source.list().await.unwrap()[0].id, "model-b", "{provider}: fetched again past {ttl_hours} h");
    assert_eq!(past.fetches(), 1);

    let failing = rig(past.dir, provider, None, T0 + (2 * ttl_hours + 4) * HOUR, me.clone());
    let answer = failing.source.list().await;
    if keeps {
        assert_eq!(answer.unwrap()[0].id, "model-b", "{provider}: the previous roster stays");
    } else {
        assert!(answer.is_err(), "{provider}: the failure is the answer");
    }
    assert_eq!(failing.file(file, &me)["models"][0]["id"], "model-b", "{provider}: and the file is not rewritten");
}

#[tokio::test]
async fn the_grok_roster_is_version_2_for_24_hours() {
    lives_by_its_options("grok-oauth", "grok-oauth-models.json", 2, 24, false).await;
}

#[tokio::test]
async fn the_mimo_roster_is_version_1_for_24_hours() {
    lives_by_its_options("mimo-oauth", "mimo-oauth-models.json", 1, 24, true).await;
}

#[tokio::test]
async fn the_command_code_roster_is_version_1_for_24_hours() {
    lives_by_its_options("command-code-oauth", "command-code-oauth-models.json", 1, 24, true).await;
}

#[tokio::test]
async fn the_opencode_go_roster_is_version_1_for_24_hours() {
    lives_by_its_options("opencode-go-oauth", "opencode-go-oauth-models.json", 1, 24, true).await;
}

#[tokio::test]
async fn the_muse_code_roster_is_version_1_for_24_hours() {
    lives_by_its_options("muse-code-oauth", "muse-code-oauth-models.json", 1, 24, true).await;
}

#[tokio::test]
async fn an_anthropic_subscriptions_roster_is_its_accounts() {
    let a = rig(tempfile::tempdir().unwrap(), "anthropic-oauth", Some(listed("claude-a")), T0, who("acct-a"));
    a.source.list().await.unwrap();
    assert_eq!(a.file("anthropic-oauth-models.json", &who("acct-a"))["version"], json!(2));

    let same = rig(a.dir, "anthropic-oauth", Some(listed("claude-x")), T0 + HOUR, who("acct-a"));
    assert_eq!(same.source.list().await.unwrap()[0].id, "claude-a");
    assert_eq!(same.fetches(), 0);

    let other = rig(same.dir, "anthropic-oauth", Some(listed("claude-b")), T0 + HOUR, who("acct-b"));
    assert_eq!(other.source.list().await.unwrap()[0].id, "claude-b", "another account is never served the first account's roster");
    assert_eq!(other.fetches(), 1);
    assert!(!other.dir.path().join(keyed("anthropic-oauth-models.json", &who("acct-a"))).exists(), "and the first account's list is discarded");
}
