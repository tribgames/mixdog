//! The rosters of the OAuth routes that keep one on disk, through their real adapters with a scripted HTTP answer: what the
//! listing returns is what a later read of the file returns (every field the adapter or the picker reads survives), a
//! fresh file is served without another request, and when the next fetch fails the previous roster stays on the compat
//! routes and the failure is Grok's answer (1.4.5's `makeModelCache` + `listModels`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::catalog::ModelRecord;
use mixdog_ai::catalog::ModelSource;
use mixdog_ai::catalog::OauthModelCache;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::compat::adapter::ApiKeySource;
use mixdog_ai::providers::compat::adapter::CompatAdapter;
use mixdog_ai::providers::compat::chat::CompatChatCodec;
use mixdog_ai::providers::compat::chat::CompatConfig;
use mixdog_ai::providers::compat::profile::CompatProfile;
use mixdog_ai::providers::compat::profile::ListingShape;
use mixdog_ai::providers::connect::rewrite::StaticCredential;
use mixdog_ai::providers::grok::listing::GrokListing;
use mixdog_ai::providers::grok::listing::SeedEffortRule;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

const HOUR: i64 = 60 * 60 * 1000;
const T0: i64 = 1_800_000_000_000;

struct Body(Option<Vec<u8>>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(|b| Ok(Bytes::from(b)))
    }
}

/// Answers each request with the next scripted (status, body); the last answer repeats.
struct Answers {
    script: Mutex<Vec<(u16, Vec<u8>)>>,
    sent: Mutex<usize>,
}

impl Answers {
    fn new(script: Vec<(u16, Value)>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(script.into_iter().map(|(s, b)| (s, b.to_string().into_bytes())).collect()), sent: Mutex::new(0) })
    }

    /// The roster answered from now on; what a later listing meets instead of the first answer.
    fn now_refuses(&self) {
        let mut script = self.script.lock().unwrap();
        script.clear();
        script.push((500, b"{}".to_vec()));
    }

    /// The credential is refused from now on.
    fn now_rejects_the_key(&self) {
        let mut script = self.script.lock().unwrap();
        script.clear();
        script.push((401, b"{}".to_vec()));
    }

    fn requests(&self) -> usize {
        *self.sent.lock().unwrap()
    }
}

/// Answers by the bearer a request carries: each account has its own roster.
struct ByBearer(Vec<(String, Value)>);

#[async_trait]
impl HttpSend for ByBearer {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let bearer = request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("authorization")).map(|(_, value)| value.clone()).unwrap_or_default();
        let (_, body) = self.0.iter().find(|(key, _)| bearer == format!("Bearer {key}")).expect("a known bearer");
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Body(Some(body.to_string().into_bytes()))) })
    }
}

/// The key the account holds: the first read is the one the identity is sampled with, the next ones are another account's.
struct Switching(std::sync::atomic::AtomicUsize);

#[async_trait]
impl ApiKeySource for Switching {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok(if self.0.fetch_add(1, Ordering::SeqCst) == 0 { "key-a" } else { "key-b" }.into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.key().await
    }
}

struct Fixed(&'static str);

#[async_trait]
impl ApiKeySource for Fixed {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok(self.0.into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.key().await
    }
}

/// The one file of `dir` that is a route's roster (`<stem>.<key>.json`).
fn written_path(dir: &std::path::Path, plain: &str) -> std::path::PathBuf {
    let stem = format!("{}.", plain.trim_end_matches(".json"));
    let found: Vec<_> = std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().path()).filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(&stem)).collect();
    assert_eq!(found.len(), 1, "{plain}: one roster file per identity, found {found:?}");
    found.into_iter().next().unwrap()
}

#[async_trait]
impl HttpSend for Answers {
    async fn send(&self, _request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        *self.sent.lock().unwrap() += 1;
        let script = self.script.lock().unwrap();
        let (status, body) = script[0].clone();
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Body(Some(body))) })
    }
}

struct Key;

#[async_trait]
impl ApiKeySource for Key {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("the-key".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        Ok("the-key".into())
    }
}

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

fn compat(profile: CompatProfile, http: Arc<Answers>) -> Arc<dyn ProviderAdapter> {
    let config = CompatConfig::for_profile(&profile);
    Arc::new(CompatAdapter::new(CompatChatCodec::new(profile, config), http, Some(Arc::new(Key))))
}

/// One roster through its real listing: written, read back whole, served fresh without a request; when the next fetch fails
/// it is kept (`keeps`) or the failure is the answer, and the file is not rewritten.
async fn lives_through(provider: &str, file: &str, version: i64, source: impl Fn(OauthModelCache) -> ModelSource, http: Arc<Answers>, keeps: bool) {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(T0));
    let read_clock = clock.clone();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst)));
    let source = source(cache);

    let fetched = source.list().await.unwrap_or_else(|e| panic!("{provider}: {e:?}"));
    assert!(!fetched.is_empty(), "{provider}: the scripted answer lists models");
    let requests = http.requests();
    let written: Value = serde_json::from_slice(&std::fs::read(written_path(dir.path(), file)).unwrap()).unwrap();
    assert_eq!((written["version"].clone(), written["fetchedAt"].clone()), (json!(version), json!(T0)), "{provider}: {file}");

    // Within the TTL: served from the file, with no request, and every field the listing carried is still there.
    clock.store(T0 + HOUR, Ordering::SeqCst);
    let served = source.list().await.unwrap();
    assert_eq!(http.requests(), requests, "{provider}: a fresh roster is not fetched again");
    let as_json = |rows: &[ModelRecord]| rows.iter().map(|row| serde_json::to_value(row).unwrap()).collect::<Vec<_>>();
    assert_eq!(as_json(&served), as_json(&fetched), "{provider}: the roster read back is the roster listed");

    // Past the TTL the fetch fails: the previous roster stays in use (or the failure is the answer) and on disk.
    clock.store(T0 + 30 * HOUR, Ordering::SeqCst);
    http.now_refuses();
    let answer = source.list().await;
    if keeps {
        let kept = answer.unwrap_or_else(|e| panic!("{provider}: the previous roster stays when the fetch fails: {e:?}"));
        assert_eq!(as_json(&kept), as_json(&fetched), "{provider}");
    } else {
        assert!(answer.is_err(), "{provider}: the failure is the answer");
    }
    let after: Value = serde_json::from_slice(&std::fs::read(written_path(dir.path(), file)).unwrap()).unwrap();
    assert_eq!(after, written, "{provider}: a failed fetch does not rewrite the file");
}

fn with_cache(provider: &'static str, adapter: Arc<dyn ProviderAdapter>) -> impl Fn(OauthModelCache) -> ModelSource {
    move |cache| ModelSource::of_adapter(ProviderId::from(provider), adapter.clone()).expect("a listing adapter").with_oauth_cache(cache)
}

#[tokio::test]
async fn mimo_lists_its_roster_and_the_file_returns_it_whole() {
    let profile = CompatProfile::mimo_oauth();
    let body = json!({"data": [
        {"id": "mimo-v2-pro", "name": "MiMo V2 Pro", "context_window": 256_000, "max_output_tokens": 32_000, "created": 1_700_000_000},
        {"id": "mimo-v2-flash", "display_name": "MiMo V2 Flash", "context_window": 128_000},
    ]});
    let http = Answers::new(vec![(200, body)]);
    lives_through("mimo-oauth", "mimo-oauth-models.json", 1, with_cache("mimo-oauth", compat(profile, http.clone())), http, true).await;
}

#[tokio::test]
async fn command_code_lists_its_roster_and_the_file_returns_it_whole() {
    let body = json!({"data": [
        {"id": "cc-sonnet", "name": "Sonnet", "context_window": 200_000, "max_output_tokens": 64_000},
        {"id": "cc-gpt", "name": "GPT", "context_window": 400_000},
    ]});
    let http = Answers::new(vec![(200, body)]);
    lives_through("command-code-oauth", "command-code-oauth-models.json", 1, with_cache("command-code-oauth", compat(CompatProfile::command_code_oauth(), http.clone())), http, true).await;
}

#[tokio::test]
async fn muse_code_lists_its_roster_and_the_file_returns_it_whole() {
    let body = json!({"data": [
        {"id": "muse-a", "name": "Muse A", "context_window": 128_000, "max_output_tokens": 16_000, "created": 1_700_000_000},
        {"id": "muse-b", "display_name": "Muse B"},
    ]});
    let http = Answers::new(vec![(200, body)]);
    lives_through("muse-code-oauth", "muse-code-oauth-models.json", 1, with_cache("muse-code-oauth", compat(CompatProfile::muse_code_oauth(), http.clone())), http, true).await;
}

#[tokio::test]
async fn opencode_go_lists_the_console_config_and_the_file_returns_it_whole_with_prices_and_wires() {
    let profile = CompatProfile::opencode_go();
    let ListingShape::ConsoleConfig { provider_key, .. } = profile.listing.shape else { panic!("OpenCode Go reads the console config") };
    let config = json!({"providers": {provider_key: {"package": "@ai-sdk/openai-compatible", "models": {
        "model-one": {
            "name": " Model One ",
            "limit": {"context": 200_000, "output": 8_000},
            "cost": {"input": 1.5, "output": 6.0, "cache": {"read": 0.15, "write": 1.875}},
            "capabilities": {"reasoning": {"supported": true, "effort": ["low", "high"]}},
        },
        "model-two": {"package": "@ai-sdk/openai", "limit": {"context": 100_000, "output": 4_000}},
    }}}});
    let http = Answers::new(vec![(200, config)]);
    lives_through("opencode-go-oauth", "opencode-go-oauth-models.json", 1, with_cache("opencode-go-oauth", compat(profile, http.clone())), http, true).await;
}

/// A credential that names the user its token belongs to (a real Grok token carries the claim).
struct GrokUser(StaticCredential);

#[async_trait]
impl mixdog_ai::providers::connect::rewrite::Credential for GrokUser {
    async fn header(&self, force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        self.0.header(force_refresh).await
    }
    fn account_of(&self, _header: &(String, String)) -> Option<String> {
        Some("grok-user".to_owned())
    }
}

#[tokio::test]
async fn grok_lists_its_catalogs_and_the_file_returns_them_whole() {
    let body = json!({"data": [
        {"id": "grok-4.7", "name": "Grok 4.7", "context_window": 256_000, "reasoning_effort": ["low", "medium", "high"]},
        {"id": "grok-build-fast", "context_window": 128_000},
    ]});
    let http = Answers::new(vec![(200, body)]);
    let listing = {
        let http = http.clone();
        move |cache: OauthModelCache| {
            let listing = GrokListing::new(
                http.clone(),
                Arc::new(GrokUser(StaticCredential(Some(("authorization".to_owned(), "Bearer fixture-grok-access".to_owned()))))),
                mixdog_ai::providers::grok::codec("1.0.70"),
                "1.0.70".into(),
                Arc::new(SeedEffortRule),
                ListingLookup::new(),
            );
            ModelSource::new(ProviderId::from("grok-oauth"), Arc::new(listing) as Arc<dyn ModelListing>).with_oauth_cache(cache)
        }
    };
    lives_through("grok-oauth", "grok-oauth-models.json", 2, listing, http, false).await;
}

fn mimo_roster(flash_window: u64) -> Value {
    json!({"data": [{"id": "mimo-v2.6-pro", "display_name": "MiMo Pro"}, {"id": "mimo-v2.6-flash", "context_window": flash_window, "max_output_tokens": 700}]})
}

fn mimo_with(http: Arc<dyn HttpSend>, key: Arc<dyn ApiKeySource>) -> Arc<CompatAdapter> {
    let profile = CompatProfile::mimo_oauth();
    let config = CompatConfig::for_profile(&profile);
    Arc::new(CompatAdapter::new(CompatChatCodec::new(profile, config), http, Some(key)))
}

fn mimo_source(adapter: &Arc<CompatAdapter>, cache: OauthModelCache) -> ModelSource {
    ModelSource::of_adapter(ProviderId::from("mimo-oauth"), adapter.clone() as Arc<dyn ProviderAdapter>).expect("a listing adapter").with_oauth_cache(cache)
}

/// The credential changes between the identity being sampled and the request being authorised: the answer is the second
/// account's, and it is stored and attributed as the second account's, never the first's.
#[tokio::test]
async fn a_roster_fetched_with_the_switched_in_key_is_stored_under_that_key_alone() {
    let dir = tempfile::tempdir().unwrap();
    let http: Arc<dyn HttpSend> = Arc::new(ByBearer(vec![
        ("key-a".into(), json!({"data": [{"id": "mimo-v2.6-pro"}]})),
        ("key-b".into(), json!({"data": [{"id": "mimo-v2.6-flash"}]})),
    ]));
    let adapter = mimo_with(http.clone(), Arc::new(Switching(Default::default())));
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(|| T0));
    let rows = mimo_source(&adapter, cache).list().await.unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["mimo-v2.6-flash"], "B's answer is B's");

    let key_of = |key: &'static str| {
        let listing = mimo_with(http.clone(), Arc::new(Fixed(key)));
        async move { mixdog_ai::catalog::roster_key(&listing.models().unwrap().roster_identity().await).unwrap() }
    };
    let (a, b) = (key_of("key-a").await, key_of("key-b").await);
    let roster = mixdog_ai::catalog::Roster::Mimo;
    assert!(!dir.path().join(roster.keyed_file(&a)).exists(), "nothing was stored for the account that was sampled");
    let stored: Value = serde_json::from_slice(&std::fs::read(dir.path().join(roster.keyed_file(&b))).unwrap()).unwrap();
    assert_eq!((stored["account"].clone(), stored["models"][0]["id"].clone()), (json!(b), json!("mimo-v2.6-flash")));
}

/// After a seed fallback the picker and the adapter's cached-row reader describe the same roster: the last one fetched, with
/// the limits the discovery found, in the process that fetched it and in a fresh one that only has the file.
#[tokio::test]
async fn the_picker_and_the_cached_row_reader_agree_after_a_seed_fallback() {
    use mixdog_ai::catalog::CachedModelInfo;
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(T0));
    let cache = |clock: Arc<AtomicI64>| OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || clock.load(Ordering::SeqCst)));
    let http = Answers::new(vec![(200, mimo_roster(5000))]);
    let adapter = mimo_with(http.clone(), Arc::new(Fixed("the-key")));
    let source = mimo_source(&adapter, cache(clock.clone()));
    let fetched = source.listing().await.unwrap();
    assert!(fetched.stale.is_none());

    // The next fetch fails: the seed would be the adapter's answer, the file holds the discovery.
    clock.store(T0 + 30 * HOUR, Ordering::SeqCst);
    http.now_refuses();
    let kept = source.listing().await.unwrap();
    assert!(kept.stale.is_some(), "the picker is told this is the last good list");
    let flash = kept.rows.iter().find(|r| r.id == "mimo-v2.6-flash").expect("the discovered model stays");
    assert_eq!(flash.context_window, Some(5000));
    let cached = adapter.cached_row("mimo-v2.6-flash").expect("the cached row of the discovered model");
    assert_eq!(cached["contextWindow"], json!(5000), "the cached-row reader says what the picker shows");

    // A fresh process: the adapter has fetched nothing, the file is all there is.
    let fresh = mimo_with(http.clone(), Arc::new(Fixed("the-key")));
    let again = mimo_source(&fresh, cache(clock)).listing().await.unwrap();
    assert!(again.stale.is_some());
    assert_eq!(again.rows.iter().find(|r| r.id == "mimo-v2.6-flash").unwrap().context_window, Some(5000));
    assert_eq!(fresh.cached_row("mimo-v2.6-flash").expect("described from the file")["contextWindow"], json!(5000));
}

/// A rejected key is heard as such (1.4.5's `isUnauthorized`), not shown as an ordinary list that happens to be old.
#[tokio::test]
async fn a_rejected_mimo_key_is_surfaced_and_the_discovery_stays_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(T0));
    let read_clock = clock.clone();
    let http = Answers::new(vec![(200, mimo_roster(5000))]);
    let adapter = mimo_with(http.clone(), Arc::new(Fixed("the-key")));
    let source = mimo_source(&adapter, OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst))));
    source.list().await.unwrap();
    let before = std::fs::read(written_path(dir.path(), "mimo-oauth-models.json")).unwrap();
    clock.store(T0 + 30 * HOUR, Ordering::SeqCst);
    http.now_rejects_the_key();
    let error = source.list().await.expect_err("the rejection is the answer");
    assert_eq!(error.kind, mixdog_core_api::domain::provider::ErrorKind::Auth);
    assert_eq!(std::fs::read(written_path(dir.path(), "mimo-oauth-models.json")).unwrap(), before);
}