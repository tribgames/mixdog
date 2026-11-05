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
    let cached = r.usage.read_cached(&RouteInfo { model: String::new(), ..route() }, false).unwrap();
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

#[tokio::test]
async fn a_credential_refused_after_refresh_drops_the_recorded_quota() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(100))));
    r.usage.fetch_snapshot(&route(), true).await.unwrap();
    r.http.queue(ANTHROPIC_URL, Ok((403, String::new())));
    r.http.queue(ANTHROPIC_URL, Ok((403, String::new())));
    assert!(r.usage.fetch_snapshot(&route(), true).await.is_none());
    assert!(r.store.pool("anthropic-oauth").await.unwrap().account(ID).unwrap().usage.is_none());
    // An empty answer is remembered: no request until the negative entry ages out.
    assert!(r.usage.fetch_snapshot(&route(), false).await.is_none());
    assert_eq!(r.http.urls().len(), 3);
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
fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-usage-{tag}-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn concurrent_cache_updates_all_land() {
    let dir = scratch_dir("lost");
    let path = dir.join("oauth-usage-cache.json");
    let writers: Vec<_> = (0..4)
        .map(|w| {
            let path = path.clone();
            std::thread::spawn(move || {
                for i in 0..15 {
                    update_disk_cache(&path, |routes| {
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
    update_disk_cache(&path, |routes| {
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
    assert!(update_disk_cache(&blocked, |_| {}).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}
