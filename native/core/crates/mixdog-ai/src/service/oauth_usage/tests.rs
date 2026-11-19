#![allow(clippy::disallowed_methods, reason = "test fixtures on a scratch directory")]

use std::collections::HashMap;
use std::collections::VecDeque;

use super::*;
use crate::oauth::CredentialIo;

const ID: &str = "11111111-1111-4111-8111-111111111111";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/api/oauth/usage";

#[derive(Default)]
struct FakeHttp {
    replies: Mutex<HashMap<String, VecDeque<Result<(u16, String), String>>>>,
    calls: Mutex<Vec<(String, Vec<(String, String)>)>>,
}

impl FakeHttp {
    fn queue(&self, url: &str, reply: Result<(u16, String), String>) {
        self.replies.lock().unwrap().entry(url.to_owned()).or_default().push_back(reply);
    }

    fn urls(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|c| c.0.clone()).collect()
    }
}

#[async_trait]
impl UsageHttp for FakeHttp {
    async fn get(&self, url: &str, headers: &[(String, String)], _: Duration) -> Result<UsageResponse, UsageError> {
        self.calls.lock().unwrap().push((url.to_owned(), headers.to_vec()));
        let reply = self.replies.lock().unwrap().get_mut(url).and_then(VecDeque::pop_front);
        match reply.unwrap_or(Err("no reply scripted".into())) {
            Ok((status, body)) => Ok(UsageResponse { status, body }),
            Err(e) => Err(UsageError::new(e)),
        }
    }

    async fn post_json(&self, url: &str, h: &[(String, String)], _: &Value, t: Duration) -> Result<UsageResponse, UsageError> {
        self.get(url, h, t).await
    }
}

struct FakeSource {
    forced: Mutex<Vec<bool>>,
}

#[async_trait]
impl UsageSource for FakeSource {
    async fn ensure_auth(&self, _: &str, _: &str, force: bool) -> Result<Option<Value>, UsageError> {
        self.forced.lock().unwrap().push(force);
        Ok(Some(serde_json::json!({"accessToken": "tok"})))
    }
    async fn provider_snapshot(&self, _: &str, _: &str) -> Result<Option<Value>, UsageError> {
        Ok(None)
    }
}

struct NoGrok;

#[tokio::test]
async fn cursor_plan_cache_and_inflight_are_scoped_to_the_resolved_key() {
    use std::sync::atomic::{AtomicU8, Ordering};

    struct Keys { key: AtomicU8, gate: Arc<tokio::sync::Semaphore> }
    struct Plan { key: u8, gate: Arc<tokio::sync::Semaphore> }

    #[async_trait]
    impl CursorApiPlan for Plan {
        fn key_identity(&self) -> [u8; 32] { [self.key; 32] }
        async fn read(&self) -> Result<Value, UsageError> {
            if self.key == 1 { let _permit = self.gate.acquire().await.unwrap(); }
            Ok(serde_json::json!({"provider":"cursor-api", "quotaWindows":[{"label":"API", "usedPct": self.key}]}))
        }
    }

    #[async_trait]
    impl UsageSource for Keys {
        async fn ensure_auth(&self, _: &str, _: &str, _: bool) -> Result<Option<Value>, UsageError> { Ok(None) }
        async fn provider_snapshot(&self, _: &str, _: &str) -> Result<Option<Value>, UsageError> { Ok(None) }
        async fn cursor_api_plan(&self) -> Result<Option<Arc<dyn CursorApiPlan>>, UsageError> {
            Ok(Some(Arc::new(Plan { key: self.key.load(Ordering::SeqCst), gate: self.gate.clone() })))
        }
    }

    let rig = rig().await;
    let keys = Arc::new(Keys { key: AtomicU8::new(1), gate: Arc::new(tokio::sync::Semaphore::new(0)) });
    let service = OAuthUsage::new(UsageDeps {
        http: rig.http.clone(), source: keys.clone(), grok: Arc::new(NoGrok), history: rig.history.clone(),
        store: rig.store.clone(), io: rig.usage.deps.io, log: Arc::new(|_| {}), data_dir: rig.dir.path().to_owned(),
    });
    let route = RouteInfo { provider: "cursor-api".into(), model: "m".into(), account_id: "default".into() };
    let mut old = std::pin::pin!(service.fetch_snapshot(&route, false));
    assert!(futures::poll!(old.as_mut()).is_pending());
    keys.key.store(2, Ordering::SeqCst);
    assert!(service.read_cached(&route, true).await.is_none());
    let new = service.fetch_snapshot(&route, false).await.unwrap();
    assert_eq!(new["quotaWindows"][0]["usedPct"], 2);
    keys.gate.add_permits(1);
    assert!(old.await.is_none());
    assert_eq!(service.read_cached(&route, false).await.unwrap()["quotaWindows"][0]["usedPct"], 2);
    keys.key.store(3, Ordering::SeqCst);
    assert!(service.read_cached(&route, true).await.is_none());
}

#[async_trait]
impl GrokClient for NoGrok {
    async fn warm(&self) {}
    fn headers(&self) -> Vec<(String, String)> {
        Vec::new()
    }
}

#[derive(Default)]
struct History(Mutex<Vec<QuotaSample>>);

#[async_trait]
impl QuotaHistory for History {
    async fn record(&self, samples: Vec<QuotaSample>) -> Result<(), String> {
        self.0.lock().unwrap().extend(samples);
        Ok(())
    }
}

struct Rig {
    usage: Arc<OAuthUsage>,
    http: Arc<FakeHttp>,
    source: Arc<FakeSource>,
    history: Arc<History>,
    store: AccountStore,
    dir: tempfile::TempDir,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(
        dir.path().to_path_buf(),
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    store.register("anthropic-oauth", ID, "A", false).await.unwrap();
    let http = Arc::new(FakeHttp::default());
    let source = Arc::new(FakeSource { forced: Mutex::default() });
    let history = Arc::new(History::default());
    let usage = OAuthUsage::new(UsageDeps {
        http: http.clone(),
        source: source.clone(),
        grok: Arc::new(NoGrok),
        history: history.clone(),
        store: store.clone(),
        io: CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        log: Arc::new(|_| {}),
        data_dir: dir.path().join("data"),
    });
    Rig { usage, http, source, history, store, dir }
}

fn route() -> RouteInfo {
    RouteInfo { provider: "anthropic-oauth".into(), model: "claude-x".into(), account_id: ID.into() }
}

fn five_hour(pct: u32) -> String {
    format!(r#"{{"five_hour":{{"utilization":{pct},"resets_at":"2099-01-01T00:00:00Z"}}}}"#)
}

#[tokio::test]
async fn a_reading_is_recorded_cached_and_served_without_a_second_request() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    let snap = r.usage.fetch_snapshot(&route(), false).await.unwrap();
    assert_eq!(snap["quotaWindows"][0]["usedPct"], 40);
    assert_eq!((snap["accountId"].as_str(), snap["model"].as_str()), (Some(ID), Some("claude-x")));

    let pool = r.store.pool("anthropic-oauth").await.unwrap();
    assert_eq!(pool.account(ID).unwrap().usage.as_ref().unwrap().windows[0].used_pct, Some(40.0));
    assert_eq!(r.history.0.lock().unwrap().len(), 1);

    let again = r.usage.fetch_snapshot(&route(), false).await.unwrap();
    assert_eq!(again["quotaWindows"][0]["usedPct"], 40);
    assert_eq!(r.http.urls(), vec![ANTHROPIC_URL]);
    // The disk cache serves a fresh process.
    let cached = r.usage.read_cached(&RouteInfo { model: String::new(), ..route() }, false).await.unwrap();
    assert_eq!(cached["quotaWindows"][0]["usedPct"], 40);
    assert!(r.dir.path().join("data/gateway-oauth-usage-cache.json").exists());
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_once_and_asked_again() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((401, String::new())));
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(10))));
    assert!(r.usage.fetch_snapshot(&route(), true).await.is_some());
    assert_eq!(*r.source.forced.lock().unwrap(), vec![false, true]);
}

/// Codex's stored meters are not bound to the sign-in that measured them, so a refused credential's reading must go. A
/// provider whose meters are bound (`uses_bound_plan_evidence`, anthropic-oauth among them) keeps its reading: another
/// sign-in's stamp never matches it, so it steers nothing that credential did not measure.
#[tokio::test]
async fn a_credential_refused_after_refresh_drops_the_recorded_quota() {
    const WHAM: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", ID, "A", false).await.unwrap();
    let route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-x".into(), account_id: ID.into() };
    r.http.queue(WHAM, Ok((200, r#"{"rate_limit":{"primary_window":{"used_percent":100,"reset_at":4070908800}}}"#.into())));
    r.usage.fetch_snapshot(&route, true).await.unwrap();
    assert!(r.store.pool("openai-oauth").await.unwrap().account(ID).unwrap().usage.is_some());
    r.http.queue(WHAM, Ok((403, String::new())));
    r.http.queue(WHAM, Ok((403, String::new())));
    assert!(r.usage.fetch_snapshot(&route, true).await.is_none());
    assert!(r.store.pool("openai-oauth").await.unwrap().account(ID).unwrap().usage.is_none());
    // An empty answer is remembered: no request until the negative entry ages out.
    assert!(r.usage.fetch_snapshot(&route, false).await.is_none());
    assert_eq!(r.http.urls().iter().filter(|url| *url == WHAM).count(), 3);
}

#[tokio::test]
async fn other_providers_and_api_key_routes_have_no_reading() {
    let r = rig().await;
    let none = RouteInfo { provider: "openai".into(), ..route() };
    assert!(r.usage.fetch_snapshot(&none, true).await.is_none());
    assert!(r.http.urls().is_empty());
}

#[tokio::test]
async fn the_reset_credit_redeem_checks_its_arguments_then_replays_once() {
    let r = rig().await;
    let bad = r.usage.consume_codex_reset_credit(ID, "v1:abc", "x").await.unwrap_err();
    assert_eq!(bad.message, "Codex reset offer revision is invalid");
    let rev = format!("v1:{}", "a".repeat(64));
    let bad = r.usage.consume_codex_reset_credit(ID, &rev, "nope").await.unwrap_err();
    assert_eq!(bad.message, "Codex reset idempotency key is invalid");
    assert!(is_uuid_v1_to_5("123e4567-e89b-42d3-a456-426614174000"));
    assert!(!is_uuid_v1_to_5("123e4567-e89b-62d3-a456-426614174000"));
    assert_eq!(codex_reset_outcome(Some(&Value::from("no_credit"))).unwrap(), "noCredit");
    assert_eq!(
        codex_reset_outcome(None).unwrap_err().message,
        "Unknown Codex reset outcome: missing"
    );
}
/// [`update_disk_cache`] as a durability-lane job.
fn cache_update(path: &std::path::Path, edit: impl FnOnce(&mut Obj) + Send + 'static) -> std::io::Result<()> {
    use mixdog_rt::LaneToken;
    let path = path.to_owned();
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
        mixdog_rt::testing::tokens()
            .durability_io
            .submit(&tokio_util::sync::CancellationToken::new(), move |lane| update_disk_cache(lane, &path, edit))
            .unwrap()
            .await
            .unwrap()
    })
}

fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-usage-{tag}-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn concurrent_cache_updates_all_land() {
    let dir = scratch_dir("lost");
    let path = dir.join("oauth-usage-cache.json");
    let start = Arc::new(std::sync::Barrier::new(4));
    let writers: Vec<_> = (0..4)
        .map(|w| {
            let path = path.clone();
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                for i in 0..15 {
                    cache_update(&path, move |routes| {
                        // Holds the read-modify-write open so unlocked writers overlap.
                        std::thread::sleep(Duration::from_millis(2));
                        routes.insert(format!("w{w}-{i}"), Value::from(i));
                    })
                    .unwrap();
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let routes = read_json_file(&path).unwrap()["routes"].as_object().unwrap().clone();
    assert_eq!(routes.len(), 60, "an unlocked read-modify-write loses updates");
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_damaged_cache_is_kept_aside_and_an_unreadable_one_is_an_error() {
    let dir = scratch_dir("damaged");
    let path = dir.join("oauth-usage-cache.json");
    std::fs::write(&path, "{ not json").unwrap();
    cache_update(&path, |routes| {
        routes.insert("a".into(), Value::from(1));
    })
    .unwrap();
    assert_eq!(read_json_file(&path).unwrap()["routes"]["a"], 1);
    let aside: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().contains(".corrupt-"))
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read_to_string(&aside[0]).unwrap(), "{ not json");
    // A directory where the file belongs cannot be read: an error, not an empty cache.
    let blocked = dir.join("blocked.json");
    std::fs::create_dir(&blocked).unwrap();
    assert!(cache_update(&blocked, |_| {}).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_damaged_cache_is_replaced_by_its_valid_backup() {
    let dir = scratch_dir("backup");
    let path = dir.join("oauth-usage-cache.json");
    std::fs::write(&path, "{ not json").unwrap();
    std::fs::write(dir.join("oauth-usage-cache.json.bak"), r#"{"version":1,"routes":{"old":{"x":1}}}"#).unwrap();
    cache_update(&path, |routes| {
        routes.insert("new".into(), Value::from(2));
    })
    .unwrap();
    let routes = read_json_file(&path).unwrap()["routes"].as_object().unwrap().clone();
    assert_eq!(routes.keys().cloned().collect::<Vec<_>>(), ["old", "new"]);
    // An unparsable backup restores nothing.
    std::fs::write(&path, "{ not json").unwrap();
    std::fs::write(dir.join("oauth-usage-cache.json.bak"), "also bad").unwrap();
    cache_update(&path, |_| {}).unwrap();
    assert!(read_json_file(&path).unwrap()["routes"].as_object().unwrap().is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The reading the cache-warm gate takes of a provider without a roster: the stored snapshot of the
/// `default` account, as its quota windows and the moment it was cached; no reading is none.
#[tokio::test]
async fn the_gate_reads_the_stored_reading_of_a_provider_without_a_roster() {
    use crate::warmer::gate::UsageSnapshots;

    let r = rig().await;
    assert!(UsageSnapshots::cached(&*r.usage, "anthropic-oauth").await.is_none(), "nothing stored yet");
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    let default = RouteInfo { provider: "anthropic-oauth".into(), model: "claude-x".into(), account_id: "default".into() };
    r.usage.fetch_snapshot(&default, false).await.unwrap();
    let (windows, cached_at) = UsageSnapshots::cached(&*r.usage, "anthropic-oauth").await.expect("the stored reading");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].used_pct, Some(40.0));
    assert!(cached_at > 0, "the moment it was cached");
    assert!(UsageSnapshots::cached(&*r.usage, "openai-oauth").await.is_none(), "another provider has none");
}

/// The admission read is bound to the sign-in the reading was measured under: that credential's stamp gets it; another
/// credential's, another provider's and an unstamped reading get none.
#[tokio::test]
async fn the_admission_read_is_bound_to_the_credential_it_was_measured_under() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    let default = RouteInfo { provider: "anthropic-oauth".into(), model: String::new(), account_id: "default".into() };
    r.usage.fetch_snapshot(&default, false).await.unwrap();

    let own = credential_stamp("anthropic-oauth", serde_json::json!({"access_token": "tok"}).as_object().unwrap()).unwrap();
    let (windows, _) = r.usage.read_bound("anthropic-oauth", &own).await.expect("the reading of this sign-in");
    assert_eq!(windows[0].used_pct, Some(40.0));

    let other = credential_stamp("anthropic-oauth", serde_json::json!({"access_token": "someone else"}).as_object().unwrap()).unwrap();
    assert!(r.usage.read_bound("anthropic-oauth", &other).await.is_none(), "another credential's reading is not this one's");
    assert!(r.usage.read_bound("openai-oauth", &own).await.is_none(), "another service has none");
}

/// A credential with no OAuth access token (an API key) has no stamp, so it never gates on a subscription reading; the
/// stamp follows the account identity over a rotating token.
#[test]
fn an_api_key_has_no_credential_stamp_and_an_identity_outlasts_its_token() {
    let doc = |v: Value| v.as_object().unwrap().clone();
    assert!(credential_stamp("anthropic-oauth", &doc(serde_json::json!({"apiKey": "sk-x"}))).is_none());
    assert!(credential_stamp("anthropic-oauth", &doc(serde_json::json!({"key": "sk-x", "account_id": "a"}))).is_none());
    let first = credential_stamp("anthropic-oauth", &doc(serde_json::json!({"access_token": "t1", "account_id": "a"})));
    let rotated = credential_stamp("anthropic-oauth", &doc(serde_json::json!({"access_token": "t2", "account_id": "a"})));
    assert!(first.is_some() && first == rotated);
    assert_ne!(first, credential_stamp("anthropic-oauth", &doc(serde_json::json!({"access_token": "t1", "account_id": "b"}))));
    let nested = credential_stamp("anthropic-oauth", &doc(serde_json::json!({"claudeAiOauth": {"accessToken": "t1", "accountId": "a"}})));
    assert_eq!(first, nested);
}

/// The observed percent is kept as it is; the credit the provider states is left beside it as separate evidence.
#[test]
fn a_stated_remaining_credit_is_kept_beside_the_observed_percent() {
    let window = |extra: Value| {
        let mut w = serde_json::json!({"label": "7D", "usedPct": 100.0});
        w.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        w
    };
    let read = |extra: Value| snapshot_windows(&serde_json::json!({"quotaWindows": [window(extra)], "cachedAt": 1})).unwrap().0.remove(0);
    let with_credit = read(serde_json::json!({"remainingUsd": 0.4}));
    assert_eq!(with_credit.used_pct, Some(100.0), "the percent is not rewritten");
    assert_eq!(with_credit.extra.get(crate::accounts::REMAINING).and_then(Value::as_f64), Some(0.4));
    assert_eq!(read(serde_json::json!({"remainingCredits": 0})).extra.get(crate::accounts::REMAINING).and_then(Value::as_f64), Some(0.0));
    assert!(read(serde_json::json!({})).extra.get(crate::accounts::REMAINING).is_none());
}

/// A reading carries the credential its own request used: the stamp made by the source that sent it.
#[tokio::test]
async fn a_reading_carries_the_stamp_of_the_credential_that_sent_it() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    let default = RouteInfo { provider: "anthropic-oauth".into(), model: String::new(), account_id: "default".into() };
    let snap = r.usage.fetch_snapshot(&default, false).await.unwrap();
    let sent = credential_stamp("anthropic-oauth", serde_json::json!({"accessToken": "tok"}).as_object().unwrap());
    assert_eq!(snap[CREDENTIAL_STAMP].as_str(), sent.as_deref());
}

/// A withdrawn limit retires only the cached readings of the sign-in that measured them: another credential's reading
/// and an unstamped one stay.
#[tokio::test]
async fn a_withdrawn_meter_retires_only_the_readings_of_its_own_credential() {
    let r = rig().await;
    let reading = |stamp: Option<&str>| {
        let mut v = serde_json::json!({"quotaWindows": [{"label": "5H", "usedPct": 100.0}], "cachedAt": 1});
        if let Some(s) = stamp {
            v[CREDENTIAL_STAMP] = Value::String(s.into());
        }
        v
    };
    {
        let mut c = r.usage.caches();
        c.memory.insert("p".into(), reading(Some("mine")));
        c.memory.insert("p\u{1}m".into(), reading(Some("mine")));
        c.memory.insert("q".into(), reading(Some("mine")));
        c.memory.insert("p\u{2}acct".into(), reading(Some("mine")));
    }
    assert!(!r.usage.retire_cached("p", "someone else").await, "another credential matches nothing");
    assert!(r.usage.retire_cached("p", "mine").await);
    let c = r.usage.caches();
    assert!(!c.memory.contains_key("p") && !c.memory.contains_key("p\u{1}m"), "the slot's own readings are gone");
    assert!(c.memory.contains_key("q") && c.memory.contains_key("p\u{2}acct"), "another provider's and another account's stay");
}

/// An empty or unreadable usage cache file is no reading.
#[tokio::test]
async fn the_gate_reads_an_empty_usage_cache_as_no_reading() {
    use crate::warmer::gate::UsageSnapshots;

    let r = rig().await;
    let data = r.dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("gateway-oauth-usage-cache.json"), "").unwrap();
    assert!(UsageSnapshots::cached(&*r.usage, "anthropic-oauth").await.is_none());
}
