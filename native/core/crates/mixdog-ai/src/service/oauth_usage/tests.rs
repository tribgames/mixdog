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
    posted: Mutex<Vec<Value>>,
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

    async fn post_json(&self, url: &str, h: &[(String, String)], body: &Value, t: Duration) -> Result<UsageResponse, UsageError> {
        self.posted.lock().unwrap().push(body.clone());
        self.get(url, h, t).await
    }
}

/// The credential stored for a slot now, as a source hands it to the request it authorises: Anthropic's login without
/// the file's envelope.
async fn stored_credential(store: &AccountStore, provider: &str, slot: &str) -> Option<UsageAuth> {
    let crate::oauth::Probe::Present(mut doc) = store.credential_file(provider, slot).unwrap().load_document().await else { return None };
    Some(UsageAuth::plain(doc.shift_remove("claudeAiOauth").unwrap_or(Value::Object(doc))))
}

/// A source that authorises each request with the slot's stored credential.
struct FakeSource {
    forced: Mutex<Vec<bool>>,
    store: AccountStore,
}

#[async_trait]
impl UsageSource for FakeSource {
    async fn ensure_auth(&self, provider: &str, account_id: &str, rejected: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
        self.forced.lock().unwrap().push(rejected.is_some());
        Ok(stored_credential(&self.store, provider, account_id).await)
    }
    async fn provider_snapshot(&self, _: &str, _: &str, _: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        Ok(None)
    }
}

struct NoGrok;

#[tokio::test]
async fn cursor_plan_cache_and_inflight_are_scoped_to_the_resolved_key() {
    use std::sync::atomic::{AtomicU8, Ordering};

    struct Keys {
        key: AtomicU8,
        gate: Arc<tokio::sync::Semaphore>,
    }
    struct Plan {
        key: u8,
        gate: Arc<tokio::sync::Semaphore>,
    }

    #[async_trait]
    impl CursorApiPlan for Plan {
        fn key_identity(&self) -> [u8; 32] {
            [self.key; 32]
        }
        async fn read(&self) -> Result<Value, UsageError> {
            if self.key == 1 {
                let _permit = self.gate.acquire().await.unwrap();
            }
            Ok(serde_json::json!({"provider":"cursor-api", "quotaWindows":[{"label":"API", "usedPct": self.key}]}))
        }
    }

    #[async_trait]
    impl UsageSource for Keys {
        async fn ensure_auth(&self, _: &str, _: &str, _: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
            Ok(None)
        }
        async fn provider_snapshot(&self, _: &str, _: &str, _: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
            Ok(None)
        }
        async fn cursor_api_plan(&self) -> Result<Option<Arc<dyn CursorApiPlan>>, UsageError> {
            Ok(Some(Arc::new(Plan { key: self.key.load(Ordering::SeqCst), gate: self.gate.clone() })))
        }
    }

    let rig = rig().await;
    let keys = Arc::new(Keys { key: AtomicU8::new(1), gate: Arc::new(tokio::sync::Semaphore::new(0)) });
    let service = service_over(&rig, keys.clone(), rig.dir.path().to_owned());
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
    /// What the service logged.
    logs: Arc<Mutex<Vec<String>>>,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    store.register("anthropic-oauth", ID, "A", false).await.unwrap();
    for slot in [ID, "default"] {
        store.credential_file("anthropic-oauth", slot).unwrap().save(&anthropic_login("tok", None)).await.unwrap();
    }
    store.credential_file("openai-oauth", ID).unwrap().save(&serde_json::json!({ "access_token": "tok", "refresh_token": "r" })).await.unwrap();
    let http = Arc::new(FakeHttp::default());
    let source = Arc::new(FakeSource { forced: Mutex::default(), store: store.clone() });
    let history = Arc::new(History::default());
    let logs = Arc::new(Mutex::new(Vec::new()));
    let logged = logs.clone();
    let usage = OAuthUsage::new(UsageDeps {
        http: http.clone(),
        source: source.clone(),
        grok: Arc::new(NoGrok),
        history: history.clone(),
        store: store.clone(),
        io: CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        log: Arc::new(move |line: &str| logged.lock().unwrap().push(line.to_owned())),
        data_dir: dir.path().join("data"),
    });
    Rig { usage, http, source, history, store, dir, logs }
}

/// A service over `source`, sharing the rig's network, history and accounts, caching under `data_dir`.
fn service_over(r: &Rig, source: Arc<dyn UsageSource>, data_dir: PathBuf) -> Arc<OAuthUsage> {
    OAuthUsage::new(UsageDeps {
        http: r.http.clone(),
        source,
        grok: Arc::new(NoGrok),
        history: r.history.clone(),
        store: r.store.clone(),
        io: r.usage.deps.io,
        log: Arc::new(|_| {}),
        data_dir,
    })
}

fn anthropic_login(access: &str, identity: Option<&str>) -> Value {
    let mut login = serde_json::json!({
        "claudeAiOauth": { "accessToken": access, "refreshToken": "r", "expiresAt": 4_102_444_800_000u64, "scopes": ["user:inference"] }
    });
    if let Some(id) = identity {
        login["claudeAiOauth"]["identity"] = serde_json::json!({ "id": id });
    }
    login
}

fn route() -> RouteInfo {
    RouteInfo { provider: "anthropic-oauth".into(), model: "claude-x".into(), account_id: ID.into() }
}

fn five_hour(pct: u32) -> String {
    format!(r#"{{"five_hour":{{"utilization":{pct},"resets_at":"2099-01-01T00:00:00Z"}}}}"#)
}

/// A window's kind is what its provider declares: Muse Code's sized window is rolling; its weekly window and Grok
/// Build's weekly `W` reset.
#[test]
fn a_reading_records_each_window_with_the_kind_its_provider_declares() {
    let muse = crate::service::usage_muse_code::snapshot(
        &serde_json::json!({ "subs_usage": { "window": { "used_percent": 40, "window_duration_mins": 300 }, "weekly": { "used_percent": 10 } } }),
        "",
        "",
        1,
    )
    .unwrap();
    let billing = serde_json::json!({ "currentPeriod": { "type": "WEEKLY" }, "weeklyLimit": 100, "used": 10 });
    let grok = serde_json::json!({ "quotaWindows": [norm::credit_window_from_billing(&billing, 0).unwrap()] });

    let kinds: Vec<(String, bool)> = [("muse-code-oauth", &muse), ("grok-build", &grok)]
        .into_iter()
        .flat_map(|(provider, snapshot)| quota_samples(provider, "acct", snapshot, 7))
        .map(|sample| (sample.label, sample.rolling))
        .collect();

    assert_eq!(kinds, [("5H".to_owned(), true), ("7D".to_owned(), false), ("W".to_owned(), false)]);
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
    r.usage.cache.saved().await;
    assert!(r.dir.path().join("data/gateway-oauth-usage-cache.json").exists());
}

/// The reading is served only for the sign-in it was measured under, decided where it is read: another user signing in on
/// the slot, or the credential deleted, leaves no cached reading for either reader and no negative answer standing in.
#[tokio::test]
async fn a_cached_reading_is_not_served_after_another_sign_in_or_a_deleted_credential() {
    let r = rig().await;
    let file = r.store.credential_file("anthropic-oauth", ID).unwrap();
    let slot = RouteInfo { model: String::new(), ..route() };
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    assert_eq!(r.usage.fetch_snapshot(&route(), false).await.unwrap()["quotaWindows"][0]["usedPct"], 40);
    assert_eq!(r.usage.read_cached(&slot, true).await.unwrap()["quotaWindows"][0]["usedPct"], 40);

    file.save(&anthropic_login("other-token", Some("user-2"))).await.unwrap();
    assert!(r.usage.read_cached(&slot, true).await.is_none(), "another user's sign-in on the slot");
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(7))));
    assert_eq!(r.usage.fetch_snapshot(&route(), false).await.unwrap()["quotaWindows"][0]["usedPct"], 7, "measured again, not served");
    assert_eq!(r.http.urls().len(), 2);

    file.remove().await.unwrap();
    assert!(r.usage.read_cached(&slot, true).await.is_none(), "a deleted credential");
    assert!(r.usage.fetch_snapshot(&route(), false).await.is_none(), "nothing is signed in to measure for");
    assert_eq!(r.http.urls().len(), 2);
}

/// A provider source that reports one meter (`used`, or nothing while negative) on the slot's stored credential and
/// counts its measurements.
struct Meter {
    used: std::sync::atomic::AtomicI64,
    calls: std::sync::atomic::AtomicU32,
    store: AccountStore,
}

#[async_trait]
impl UsageSource for Meter {
    async fn ensure_auth(&self, _: &str, _: &str, _: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
        Ok(None)
    }
    async fn provider_snapshot(&self, provider: &str, account_id: &str, sent: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        use std::sync::atomic::Ordering;
        *sent = stored_credential(&self.store, provider, account_id).await;
        self.calls.fetch_add(1, Ordering::SeqCst);
        let used = self.used.load(Ordering::SeqCst);
        Ok((used >= 0)
            .then(|| serde_json::json!({ "provider": provider, "quotaWindows": [{ "label": "5h", "usedPct": used, "resetAt": 4_070_908_800_000_i64 }] })))
    }
}

/// A service over [`Meter`], a slot of `provider` registered under `ID`, and the slot's credential file.
async fn metered(provider: &str, login: Value) -> (Arc<OAuthUsage>, Arc<Meter>, crate::oauth::CredentialFile, RouteInfo, tempfile::TempDir) {
    let r = rig().await;
    r.store.register(provider, ID, "A", false).await.unwrap();
    let file = r.store.credential_file(provider, ID).unwrap();
    file.save(&login).await.unwrap();
    let meter = Arc::new(Meter { used: 10.into(), calls: 0.into(), store: r.store.clone() });
    let usage = service_over(&r, meter.clone(), r.dir.path().to_owned());
    (usage, meter, file, RouteInfo { provider: provider.into(), model: String::new(), account_id: ID.into() }, r.dir)
}

fn used_of(reading: Option<Value>) -> Option<u64> {
    reading.as_ref().and_then(used)
}

#[tokio::test]
async fn a_command_code_reading_follows_the_account_its_key_belongs_to() {
    use std::sync::atomic::Ordering;
    let (usage, meter, file, route, _dir) = metered("command-code-oauth", serde_json::json!({ "apiKey": "k1", "userId": "u1", "userName": "n1" })).await;
    assert_eq!(used_of(usage.fetch_snapshot(&route, false).await), Some(10));
    assert_eq!(used_of(usage.read_cached(&route, true).await), Some(10));

    file.save(&serde_json::json!({ "apiKey": "k2", "userId": "u2", "userName": "n2" })).await.unwrap();
    meter.used.store(20, Ordering::SeqCst);
    assert!(usage.read_cached(&route, true).await.is_none(), "another user signed in on the slot");
    assert_eq!(used_of(usage.fetch_snapshot(&route, false).await), Some(20), "measured for the new account, not served");
    assert_eq!(meter.calls.load(Ordering::SeqCst), 2);

    file.save(&serde_json::json!({ "apiKey": "k3" })).await.unwrap();
    assert_eq!(used_of(usage.read_cached(&route, true).await), Some(20), "the same account under a new key keeps its reading");

    file.remove().await.unwrap();
    assert!(usage.read_cached(&route, true).await.is_none(), "a deleted credential");
}

#[tokio::test]
async fn a_cursor_reading_on_a_named_slot_survives_a_token_refresh_and_not_another_account_or_a_deleted_file() {
    let (usage, _meter, file, route, _dir) =
        metered("cursor-oauth", serde_json::json!({ "access_token": "t1", "refresh_token": "r", "email": "a@example.test" })).await;
    assert_eq!(used_of(usage.fetch_snapshot(&route, false).await), Some(10));

    file.save(&serde_json::json!({ "access_token": "t2" })).await.unwrap();
    assert_eq!(used_of(usage.read_cached(&route, true).await), Some(10), "a refreshed token is the same account");
    assert_eq!(used_of(usage.fetch_snapshot(&route, false).await), Some(10));

    file.save(&serde_json::json!({ "access_token": "t3", "email": "b@example.test" })).await.unwrap();
    assert!(usage.read_cached(&route, true).await.is_none(), "another account");

    file.remove().await.unwrap();
    assert!(usage.read_cached(&route, true).await.is_none(), "no environment override on a named slot: nothing is served");
}

#[tokio::test]
async fn an_empty_answer_of_one_account_does_not_stand_in_for_the_next() {
    use std::sync::atomic::Ordering;
    let (usage, meter, file, route, _dir) = metered("command-code-oauth", serde_json::json!({ "apiKey": "k1", "userId": "u1" })).await;
    meter.used.store(-1, Ordering::SeqCst);
    assert!(usage.fetch_snapshot(&route, false).await.is_none());
    assert!(usage.fetch_snapshot(&route, false).await.is_none());
    assert_eq!(meter.calls.load(Ordering::SeqCst), 1, "the empty answer stands for the account that gave it");

    file.save(&serde_json::json!({ "apiKey": "k2", "userId": "u2" })).await.unwrap();
    meter.used.store(30, Ordering::SeqCst);
    assert_eq!(used_of(usage.fetch_snapshot(&route, false).await), Some(30), "the next account is measured");
}

/// A source that stops each measurement twice until the test lets it go: before it reads the slot's stored credential,
/// and after it took that credential for the request, before the request goes out. Each stop is announced.
struct Switching {
    store: AccountStore,
    arrived: [tokio::sync::Semaphore; 2],
    gates: [tokio::sync::Semaphore; 2],
}

#[async_trait]
impl UsageSource for Switching {
    async fn ensure_auth(&self, provider: &str, account_id: &str, _: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
        self.arrived[0].add_permits(1);
        self.gates[0].acquire().await.expect("an open gate").forget();
        let sent = stored_credential(&self.store, provider, account_id).await;
        self.arrived[1].add_permits(1);
        self.gates[1].acquire().await.expect("an open gate").forget();
        Ok(sent)
    }
    async fn provider_snapshot(&self, _: &str, _: &str, _: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        Ok(None)
    }
}

/// A service over [`Switching`], its slot [`route`] signed in as `user-a`, and that account's and `user-b`'s logins.
async fn switching() -> (Rig, Arc<OAuthUsage>, Arc<Switching>, [Value; 2]) {
    let r = rig().await;
    let logins = [anthropic_login("token-a", Some("user-a")), anthropic_login("token-b", Some("user-b"))];
    r.store.credential_file("anthropic-oauth", ID).unwrap().save(&logins[0]).await.unwrap();
    let gates = || [tokio::sync::Semaphore::new(0), tokio::sync::Semaphore::new(0)];
    let source = Arc::new(Switching { store: r.store.clone(), arrived: gates(), gates: gates() });
    let usage = service_over(&r, source.clone(), r.dir.path().join("switching"));
    (r, usage, source, logins)
}

fn stamp_of(login: &Value) -> String {
    credential_stamp("anthropic-oauth", login["claudeAiOauth"].as_object().unwrap()).unwrap()
}

/// The stamps the slot's roster row holds its windows under.
async fn row_stamps(r: &Rig) -> Vec<Option<String>> {
    let row = r.store.pool("anthropic-oauth").await.unwrap().account(ID).unwrap().usage.clone();
    row.map_or_else(Vec::new, |usage| usage.windows.iter().map(|w| w.extra.get("credential").and_then(Value::as_str).map(str::to_owned)).collect())
}

/// Another user signs in on the slot while a measurement waits to authorise its request: the request goes out on that
/// account's credential, and its figures are recorded, cached and served as that account's alone. Nothing carries the
/// stamp of the account stored when the measurement began.
#[tokio::test]
async fn a_measurement_authorised_after_another_sign_in_is_the_new_accounts() {
    let (r, usage, source, [_, second]) = switching().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(70))));
    let measuring = tokio::spawn({
        let usage = usage.clone();
        async move { usage.fetch_snapshot(&route(), false).await }
    });
    source.arrived[0].acquire().await.unwrap().forget();
    r.store.credential_file("anthropic-oauth", ID).unwrap().save(&second).await.unwrap();
    source.gates[0].add_permits(1);
    source.gates[1].add_permits(1);

    let measured = measuring.await.unwrap().expect("the new account's reading");
    let own = stamp_of(&second);
    assert_eq!((used(&measured), measured[CREDENTIAL_STAMP].as_str()), (Some(70), Some(own.as_str())));
    assert_eq!(row_stamps(&r).await, [Some(own.clone())], "the roster row holds the new account's figures under its stamp");
    let served = usage.read_cached(&route(), true).await.expect("served for the account signed in");
    assert_eq!((used(&served), served[CREDENTIAL_STAMP].as_str()), (Some(70), Some(own.as_str())));
}

/// A measurement's request goes out on one account's credential and another user signs in on the slot before its answer
/// is taken: the figures are the replaced account's, so they reach neither the roster row, the history nor the cache, and
/// the caller is not given them as the slot's usage. The next reading is measured for the account signed in now.
#[tokio::test]
async fn a_reading_of_an_account_replaced_during_its_measurement_is_neither_recorded_nor_served() {
    let (r, usage, source, [_, second]) = switching().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    let measuring = tokio::spawn({
        let usage = usage.clone();
        async move { usage.fetch_snapshot(&route(), false).await }
    });
    source.gates[0].add_permits(1);
    source.arrived[1].acquire().await.unwrap().forget();
    r.store.credential_file("anthropic-oauth", ID).unwrap().save(&second).await.unwrap();
    source.gates[1].add_permits(1);

    assert!(measuring.await.unwrap().is_none(), "the replaced account's figures were given as the slot's");
    assert!(row_stamps(&r).await.is_empty(), "the roster row");
    assert!(r.history.0.lock().unwrap().is_empty(), "the history");
    assert!(usage.read_cached(&route(), true).await.is_none(), "the cache");

    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(7))));
    source.gates[0].add_permits(1);
    source.gates[1].add_permits(1);
    let next = usage.fetch_snapshot(&route(), false).await.expect("measured for the account signed in now");
    assert_eq!((used(&next), next[CREDENTIAL_STAMP].as_str()), (Some(7), Some(stamp_of(&second).as_str())));
    assert_eq!(row_stamps(&r).await, [Some(stamp_of(&second))]);
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
    assert_eq!(codex_reset_outcome(None).unwrap_err().message, "Unknown Codex reset outcome: missing");
}

#[tokio::test]
async fn the_reset_credit_that_expires_first_is_the_one_redeemed() {
    const OFFER: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
    const CONSUME: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
    // As the server lists them: the later one first, one already spent, one that never expires.
    let offer = r#"{"available_count":3,"credits":[
        {"id":"thirteen-days","status":"available","expires_at":4072032000},
        {"id":"spent","status":"redeemed","expires_at":4070000000},
        {"id":"never","status":"available"},
        {"id":"three-days","status":"available","expires_at":4071168000}]}"#;
    let shown =
        norm::normalize_codex_reset_credits(Some(&serde_json::from_str(offer).unwrap()), "", now_ms()).unwrap()["offerRevision"].as_str().unwrap().to_owned();
    let r = rig().await;
    r.http.queue(OFFER, Ok((200, offer.into())));
    r.http.queue(CONSUME, Ok((200, r#"{"code":"reset"}"#.into())));
    r.http.queue(OFFER, Ok((200, offer.into())));
    r.usage.consume_codex_reset_credit(ID, &shown, ID).await.unwrap();
    assert_eq!(*r.http.posted.lock().unwrap(), [serde_json::json!({ "redeem_request_id": ID, "credit_id": "three-days" })]);

    // An offer that names no credit leaves the choice to the server.
    let counted = r#"{"available_count":1,"credits":[{"status":"available","expires_at":4071168000}]}"#;
    let shown =
        norm::normalize_codex_reset_credits(Some(&serde_json::from_str(counted).unwrap()), "", now_ms()).unwrap()["offerRevision"].as_str().unwrap().to_owned();
    r.http.queue(OFFER, Ok((200, counted.into())));
    r.http.queue(CONSUME, Ok((200, r#"{"code":"reset"}"#.into())));
    r.http.queue(OFFER, Ok((200, counted.into())));
    r.usage.consume_codex_reset_credit(ID, &shown, ID).await.unwrap();
    assert_eq!(r.http.posted.lock().unwrap()[1], serde_json::json!({ "redeem_request_id": ID }));
}

#[tokio::test]
async fn a_reset_credit_is_spent_only_on_the_offer_that_was_shown() {
    const OFFER: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
    const CONSUME: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
    let offer = |count: u32| format!(r#"{{"available_count":{count},"credits":[{{"status":"available","expires_at":4070908800}}]}}"#);
    let shown = norm::normalize_codex_reset_credits(Some(&serde_json::from_str(&offer(1)).unwrap()), "", now_ms()).unwrap()["offerRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    let r = rig().await;
    r.http.queue(OFFER, Ok((200, offer(2))));
    let stale = r.usage.consume_codex_reset_credit(ID, &shown, ID).await.unwrap_err();
    assert_eq!(stale.message, "Codex reset offer changed; refresh and try again");
    assert!(!r.http.urls().contains(&CONSUME.to_owned()), "nothing was redeemed");

    r.http.queue(OFFER, Ok((200, offer(1))));
    r.http.queue(CONSUME, Ok((200, r#"{"code":"reset"}"#.into())));
    r.http.queue(OFFER, Ok((200, offer(0))));
    let done = r.usage.consume_codex_reset_credit(ID, &shown, ID).await.unwrap();
    assert_eq!(done.outcome, "reset");
}

/// One locked edit of a cache file's routes ([`update_json_atomic`]) as a durability-lane job.
fn cache_update(path: &std::path::Path, edit: impl FnOnce(&mut Obj) + Send + 'static) -> std::io::Result<()> {
    use mixdog_rt::LaneToken;
    let path = path.to_owned();
    let update = move |lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>| {
        update_json_atomic(lane, &path, |current| {
            let mut routes = current.as_ref().and_then(|c| c.get("routes")).and_then(Value::as_object).cloned().unwrap_or_default();
            edit(&mut routes);
            serde_json::json!({ "version": 1, "updatedAt": now_ms(), "routes": routes })
        })
    };
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(async { mixdog_rt::testing::tokens().durability_io.submit(&tokio_util::sync::CancellationToken::new(), update).unwrap().await.unwrap() })
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
    let leftovers: Vec<_> =
        std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.contains("tmp")).collect();
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
    let aside: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.to_string_lossy().contains(".corrupt-")).collect();
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
    let jwt = |sub: &str, nonce: &str| {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::json!({"sub": sub, "jti": nonce}).to_string());
        format!("eyJhbGciOiJIUzI1NiJ9.{payload}.sig")
    };
    let cursor_a = credential_stamp("cursor-oauth", &doc(serde_json::json!({"access_token": jwt("auth0|u1", "1")})));
    let cursor_b = credential_stamp("cursor-oauth", &doc(serde_json::json!({"access_token": jwt("auth0|u1", "2")})));
    let cursor_other = credential_stamp("cursor-oauth", &doc(serde_json::json!({"access_token": jwt("auth0|u2", "1")})));
    assert!(cursor_a.is_some() && cursor_a == cursor_b && cursor_a != cursor_other);
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

// The cache owner: what is served, what a measurement may publish, what the file is owed.

/// A point a lane job stops at, on its own thread, until the test lets it go.
#[derive(Default)]
struct Barrier {
    /// Reached, and open.
    state: Mutex<(bool, bool)>,
    changed: std::sync::Condvar,
}

impl Barrier {
    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn reached(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.0 {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn open(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

/// The stamp of the sign-in the rig stores for its anthropic slots: what a reading measured under it carries.
fn own_stamp() -> String {
    credential_stamp("anthropic-oauth", anthropic_login("tok", None)["claudeAiOauth"].as_object().unwrap()).unwrap()
}

/// The slot of [`route`] in the cache: the provider and the account.
fn slot() -> String {
    format!("anthropic-oauth\u{2}{ID}")
}

/// A reading as the cache file holds it.
fn held(provider: &str, account: &str, pct: u32, stamp: Option<&str>, cached_at: i64) -> Value {
    let mut reading = serde_json::json!({
        "provider": provider,
        "accountId": account,
        "cachedAt": cached_at,
        "quotaWindows": [{ "label": "5h", "usedPct": pct, "resetAt": 4_070_908_800_000_i64 }],
    });
    if let Some(stamp) = stamp {
        reading[CREDENTIAL_STAMP] = stamp.into();
    }
    reading
}

fn cache_file_of(r: &Rig) -> std::path::PathBuf {
    r.dir.path().join("data").join(CACHE_FILE)
}

fn write_routes(r: &Rig, routes: Value) {
    std::fs::create_dir_all(r.dir.path().join("data")).unwrap();
    std::fs::write(cache_file_of(r), serde_json::json!({ "version": 1, "updatedAt": 0, "routes": routes }).to_string()).unwrap();
}

fn routes_of(r: &Rig) -> Obj {
    let file: Value = serde_json::from_str(&std::fs::read_to_string(cache_file_of(r)).unwrap()).unwrap();
    file["routes"].as_object().cloned().unwrap()
}

fn used(reading: &Value) -> Option<u64> {
    reading["quotaWindows"][0]["usedPct"].as_u64()
}

/// The read lane's queue is full when the first cached reading is asked for: the owner's read of the file waits for
/// room and the reading the file holds is answered, never a miss.
#[tokio::test]
async fn the_first_cached_reading_asked_over_a_full_read_lane_waits_and_is_answered() {
    let r = rig().await;
    write_routes(&r, serde_json::json!({ slot(): held("anthropic-oauth", ID, 40, Some(&own_stamp()), now_ms()) }));
    let route = route();
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    let mut read = std::pin::pin!(r.usage.read_cached(&route, false));
    assert!(futures::poll!(read.as_mut()).is_pending(), "the read waits for the lane");
    drop(full);
    assert_eq!(used(&read.await.expect("the reading the file holds")), Some(40));
}

/// The owner's read of the file is stopped after it took the file's old bytes; an invalidation and a new measurement
/// start meanwhile. The read orders before both: what it took is not installed over the invalidation, and no lookup
/// (live, stale, the model and provider fallbacks, the bound one) returns the retired reading.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn the_read_of_the_file_at_start_orders_before_every_edit() {
    let r = rig().await;
    let now = now_ms();
    write_routes(
        &r,
        serde_json::json!({
            slot(): held("anthropic-oauth", ID, 11, Some(&own_stamp()), now),
            format!("{}\u{1}claude-x", slot()): held("anthropic-oauth", ID, 11, Some(&own_stamp()), now),
            "anthropic-oauth": held("anthropic-oauth", "default", 11, Some(&own_stamp()), now),
        }),
    );
    let barrier = Arc::new(Barrier::default());
    r.usage.cache.seams.lock().unwrap().after_seed_read = Some({
        let barrier = barrier.clone();
        Arc::new(move || barrier.stop())
    });
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(41))));

    let first = tokio::spawn({
        let usage = r.usage.clone();
        async move { usage.read_cached(&route(), false).await }
    });
    barrier.reached();
    let invalidating = tokio::spawn({
        let usage = r.usage.clone();
        async move { usage.invalidate("anthropic-oauth").await }
    });
    let measuring = tokio::spawn({
        let usage = r.usage.clone();
        async move { usage.fetch_snapshot(&route(), true).await }
    });
    barrier.open();
    first.await.unwrap();
    invalidating.await.unwrap();
    measuring.await.unwrap();

    let other_model = RouteInfo { model: "claude-y".into(), ..route() };
    let bare = RouteInfo { model: String::new(), ..route() };
    for (lookup, stale) in [(route(), false), (route(), true), (other_model, true), (bare, true)] {
        let found = r.usage.read_cached(&lookup, stale).await;
        assert!(found.as_ref().is_none_or(|reading| used(reading) == Some(41)), "{} (stale {stale}): {found:?}", lookup.model);
    }
    assert!(r.usage.read_bound("anthropic-oauth", &own_stamp()).await.is_none(), "the bound reading was retired with the provider");
    let default = RouteInfo { provider: "anthropic-oauth".into(), model: String::new(), account_id: "default".into() };
    assert!(r.usage.read_cached(&default, true).await.is_none());
    r.usage.cache.saved().await;
    assert!(routes_of(&r).values().all(|reading| used(reading) != Some(11)), "{:?}", routes_of(&r));
}

/// The first write of the cache file stops before the file's lock until the test lets it go.
fn hold_the_first_write(r: &Rig) -> Arc<Barrier> {
    let (barrier, armed) = (Arc::new(Barrier::default()), Arc::new(std::sync::atomic::AtomicBool::new(true)));
    r.usage.cache.seams.lock().unwrap().before_write = Some({
        let barrier = barrier.clone();
        Arc::new(move || {
            if armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
                barrier.stop();
            }
            Ok(())
        })
    });
    barrier
}

/// The write of the cache file is held. The measurement whose reading it is to save is complete without it: its
/// caller is answered, the reading is served to the next caller with no second request and the roster holds it. The
/// file gets the reading when the write goes on.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_held_cache_write_does_not_hold_the_measurement() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    let barrier = hold_the_first_write(&r);

    let measured = tokio::time::timeout(Duration::from_secs(30), r.usage.fetch_snapshot(&route(), false)).await;
    assert_eq!(measured.expect("the measurement waited for the cache file").as_ref().and_then(used), Some(40));
    barrier.reached();
    assert!(!cache_file_of(&r).exists(), "the write is held");
    assert_eq!(r.usage.fetch_snapshot(&route(), false).await.as_ref().and_then(used), Some(40));
    assert_eq!(r.http.urls().len(), 1, "the installed reading is the measurement");
    let pool = r.store.pool("anthropic-oauth").await.unwrap();
    assert_eq!(pool.account(ID).unwrap().usage.as_ref().unwrap().windows[0].used_pct, Some(40.0));

    barrier.open();
    r.usage.cache.saved().await;
    assert_eq!(routes_of(&r).get(&slot()).and_then(used), Some(40));
    assert_eq!(r.usage.cache.positions().0, r.usage.cache.positions().1, "nothing is left owed");
}

/// A save is stopped before the file's lock. The provider is invalidated and a new reading published meanwhile; then
/// the old save goes on. Memory reflects the invalidation at once, and the file ends with the new reading and no
/// retired bare or model entry.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_save_overtaken_by_an_invalidation_does_not_write_its_reading_back() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(41))));
    let barrier = hold_the_first_write(&r);
    assert_eq!(r.usage.fetch_snapshot(&route(), false).await.as_ref().and_then(used), Some(40));
    barrier.reached();

    let erasing = r.usage.cache.invalidate_provider("anthropic-oauth");
    assert!(r.usage.read_cached(&route(), true).await.is_none(), "memory reflects the invalidation at once");
    erasing.await.unwrap();
    let new_route = RouteInfo { model: "claude-y".into(), ..route() };
    assert_eq!(used(&r.usage.fetch_snapshot(&new_route, true).await.unwrap()), Some(41));

    barrier.open();
    r.usage.cache.saved().await;
    let routes = routes_of(&r);
    assert_eq!(routes.get(&slot()).and_then(used), Some(41), "{routes:?}");
    assert_eq!(routes.get(&format!("{}\u{1}claude-y", slot())).and_then(used), Some(41));
    assert!(!routes.contains_key(&format!("{}\u{1}claude-x", slot())), "the retired model entry is back: {routes:?}");
    assert_eq!(r.usage.cache.positions().0, r.usage.cache.positions().1, "nothing is left owed");
}

/// A credential source that holds each measurement until the test lets it through, in arrival order.
struct HeldSource {
    arrived: std::sync::atomic::AtomicUsize,
    gate: tokio::sync::Semaphore,
}

#[async_trait]
impl UsageSource for HeldSource {
    async fn ensure_auth(&self, _: &str, _: &str, _: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
        self.arrived.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.gate.acquire().await.expect("an open gate").forget();
        Ok(Some(UsageAuth::plain(serde_json::json!({"accessToken": "tok"}))))
    }
    async fn provider_snapshot(&self, _: &str, _: &str, _: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        Ok(None)
    }
}

/// A measurement is in flight, with a second caller waiting on it, when its provider is invalidated; another
/// measurement of the same route starts. The old one's completion, a reading or nothing, is not served, not
/// published, leaves no "measured nothing" mark and does not unlink the new flight; the new one publishes.
#[tokio::test]
async fn a_measurement_overtaken_by_an_invalidation_publishes_nothing_and_leaves_the_new_one_alone() {
    for old_answer in [five_hour(40), "{}".to_owned()] {
        let rig = rig().await;
        let source = Arc::new(HeldSource { arrived: Default::default(), gate: tokio::sync::Semaphore::new(0) });
        let usage = service_over(&rig, source.clone(), rig.dir.path().join("held"));
        let arrived = || source.arrived.load(std::sync::atomic::Ordering::SeqCst);
        rig.http.queue(ANTHROPIC_URL, Ok((200, old_answer.clone())));
        rig.http.queue(ANTHROPIC_URL, Ok((200, five_hour(41))));
        let route = route();

        let mut old = std::pin::pin!(usage.fetch_snapshot(&route, false));
        assert!(futures::poll!(old.as_mut()).is_pending());
        let mut joined = std::pin::pin!(usage.fetch_snapshot(&route, false));
        assert!(futures::poll!(joined.as_mut()).is_pending());
        assert_eq!(arrived(), 1, "the second caller shares the measurement");

        usage.invalidate("anthropic-oauth").await;
        let mut new = std::pin::pin!(usage.fetch_snapshot(&route, false));
        assert!(futures::poll!(new.as_mut()).is_pending());
        assert_eq!(arrived(), 2, "a measurement of the new epoch started");

        source.gate.add_permits(1);
        assert!(old.await.is_none(), "the overtaken measurement was served ({old_answer})");
        assert!(joined.await.is_none());
        assert!(usage.read_cached(&route, true).await.is_none(), "the overtaken measurement was published ({old_answer})");
        let mut third = std::pin::pin!(usage.fetch_snapshot(&route, false));
        assert!(futures::poll!(third.as_mut()).is_pending(), "the old completion left a mark that nothing was measured ({old_answer})");
        assert_eq!(arrived(), 2, "the old completion unlinked the new flight ({old_answer})");

        source.gate.add_permits(1);
        assert_eq!(new.await.as_ref().and_then(used), Some(41));
        assert_eq!(third.await.as_ref().and_then(used), Some(41));
        assert_eq!(usage.read_cached(&route, false).await.as_ref().and_then(used), Some(41), "the new measurement publishes");
    }
}

/// A credential source that holds each measurement at a gate of its own, numbered by arrival.
struct GatedSource {
    arrived: std::sync::atomic::AtomicUsize,
    gates: [tokio::sync::Semaphore; 2],
}

#[async_trait]
impl UsageSource for GatedSource {
    async fn ensure_auth(&self, _: &str, _: &str, _: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
        let turn = self.arrived.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.gates[turn].acquire().await.expect("an open gate").forget();
        Ok(Some(UsageAuth::plain(serde_json::json!({"accessToken": "tok"}))))
    }
    async fn provider_snapshot(&self, _: &str, _: &str, _: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        Ok(None)
    }
}

/// A measurement is in flight when its provider is invalidated; the measurement started after that completes first
/// and publishes. The old one then ends late, with a reading or with its sign-in's statement that it has no usage:
/// that completion changes nothing. Memory, the roster and the file keep the newer reading, the history holds the
/// newer sample alone, and the route is not measured again.
#[tokio::test]
async fn a_completion_overtaken_by_an_invalidation_changes_nothing_anywhere() {
    for old_answer in [five_hour(40), "{}".to_owned()] {
        let r = rig().await;
        let source = Arc::new(GatedSource { arrived: Default::default(), gates: [tokio::sync::Semaphore::new(0), tokio::sync::Semaphore::new(0)] });
        let usage = service_over(&r, source.clone(), r.dir.path().join("data"));
        let arrived = || source.arrived.load(std::sync::atomic::Ordering::SeqCst);
        // Answered in the order the measurements pass their gates: the newer one first.
        r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(41))));
        r.http.queue(ANTHROPIC_URL, Ok((200, old_answer.clone())));
        let route = route();

        let mut old = std::pin::pin!(usage.fetch_snapshot(&route, false));
        assert!(futures::poll!(old.as_mut()).is_pending());
        usage.invalidate("anthropic-oauth").await;
        let mut new = std::pin::pin!(usage.fetch_snapshot(&route, false));
        assert!(futures::poll!(new.as_mut()).is_pending());
        assert_eq!(arrived(), 2, "a measurement of the new epoch started");

        source.gates[1].add_permits(1);
        assert_eq!(new.await.as_ref().and_then(used), Some(41));
        source.gates[0].add_permits(1);
        assert_eq!(old.await.as_ref().and_then(used), Some(41), "the overtaken measurement serves what is current ({old_answer})");
        assert_eq!(r.http.urls().len(), 2, "both measurements were answered");

        assert_eq!(usage.read_cached(&route, false).await.as_ref().and_then(used), Some(41), "memory ({old_answer})");
        assert_eq!(usage.fetch_snapshot(&route, false).await.as_ref().and_then(used), Some(41));
        assert_eq!(arrived(), 2, "the newer reading is no longer the route's measurement ({old_answer})");
        let pool = r.store.pool("anthropic-oauth").await.unwrap();
        let recorded = pool.account(ID).unwrap().usage.as_ref().map(|usage| usage.windows[0].used_pct);
        assert_eq!(recorded, Some(Some(41.0)), "the roster ({old_answer})");
        let history: Vec<f64> = r.history.0.lock().unwrap().iter().map(|sample| sample.used_pct).collect();
        assert_eq!(history, [41.0], "the history ({old_answer})");
        usage.cache.saved().await;
        let routes = routes_of(&r);
        assert_eq!(routes.get(&slot()).and_then(used), Some(41), "the file ({old_answer}): {routes:?}");
        assert_eq!(routes.get(&format!("{}\u{1}claude-x", slot())).and_then(used), Some(41), "the file ({old_answer}): {routes:?}");
    }
}

/// A ticket of the measurement of [`route`] that would start now.
async fn ticket(r: &Rig) -> cache::Ticket {
    r.usage.cache.measuring(&route_key(&route()), &slot(), |_| async { None }.boxed()).await.0
}

/// A sign-in's readings of one slot are retired though they are dated in the future, as after the clock was moved
/// back: no time decides what is removed. They leave memory at once and the file with the erase; another sign-in's
/// and unstamped readings of the slot, another slot and another provider stay in the file. The sign-in is the one stored
/// for the slot, so what is served is decided by its credential file, as the retirement is.
#[tokio::test]
async fn a_stamped_retirement_removes_the_slots_matching_readings_whatever_their_date() {
    let r = rig().await;
    let ahead = now_ms() + 3_600_000;
    let own = own_stamp();
    let model = |name: &str| format!("{}\u{1}{name}", slot());
    write_routes(
        &r,
        serde_json::json!({
            slot(): held("anthropic-oauth", ID, 11, Some(&own), ahead),
            model("claude-x"): held("anthropic-oauth", ID, 11, Some(&own), ahead),
            model("claude-other"): held("anthropic-oauth", ID, 22, Some("another-sign-in"), ahead),
            model("claude-plain"): held("anthropic-oauth", ID, 33, None, ahead),
            "anthropic-oauth": held("anthropic-oauth", "default", 44, Some(&own), ahead),
            "openai-oauth": held("openai-oauth", "default", 55, Some("elsewhere"), ahead),
        }),
    );
    assert_eq!(r.usage.read_cached(&route(), true).await.as_ref().and_then(used), Some(11));
    r.usage.cache.retire_stamped(&ticket(&r).await, "nobody").expect("a current ticket").await.unwrap();
    assert_eq!(r.usage.read_cached(&route(), true).await.as_ref().and_then(used), Some(11), "a sign-in that measured none of them retires nothing");

    let erasing = r.usage.cache.retire_stamped(&ticket(&r).await, &own).expect("a current ticket");
    assert!(r.usage.read_cached(&route(), true).await.is_none(), "the stored sign-in's readings are gone; the others are not its own");
    erasing.await.unwrap();

    let routes = routes_of(&r);
    let mut kept: Vec<&str> = routes.keys().map(String::as_str).collect();
    kept.sort_unstable();
    let (other, plain) = (model("claude-other"), model("claude-plain"));
    let mut expected = vec!["anthropic-oauth", other.as_str(), plain.as_str(), "openai-oauth"];
    expected.sort_unstable();
    assert_eq!(kept, expected);
    let default = |provider: &str| RouteInfo { provider: provider.into(), model: String::new(), account_id: "default".into() };
    assert_eq!(r.usage.read_cached(&default("anthropic-oauth"), true).await.as_ref().and_then(used), Some(44));
    assert!(r.usage.read_cached(&default("openai-oauth"), true).await.is_none(), "no stored sign-in, nothing served");
}

/// A route another process wrote to the cache file after this one read it.
fn add_foreign_route(r: &Rig) {
    let mut routes = routes_of(r);
    routes.insert("openai-oauth".into(), held("openai-oauth", "default", 55, None, now_ms()));
    write_routes(r, Value::Object(routes));
}

/// A provider is invalidated while the durability lane's queue is full. The readings are gone at once and stay gone;
/// the erase waits for the lane, nothing is acknowledged until it wrote, and it then leaves the other routes of the
/// file alone.
#[tokio::test]
async fn an_erase_waiting_for_a_full_lane_is_owed_until_it_wrote() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    r.usage.fetch_snapshot(&route(), false).await.unwrap();
    r.usage.cache.saved().await;
    add_foreign_route(&r);

    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    let erasing = r.usage.cache.invalidate_provider("anthropic-oauth");
    full.met_by_a_submit().await;
    assert!(!erasing.is_finished(), "the erase waits for the lane");
    assert!(r.usage.read_cached(&route(), false).await.is_none() && r.usage.read_cached(&route(), true).await.is_none());
    let (acknowledged, position) = r.usage.cache.positions();
    assert!(acknowledged < position, "an erase that has not written was acknowledged");
    assert!(routes_of(&r).contains_key(&slot()), "the file is not yet written");

    drop(full);
    erasing.await.unwrap();
    assert_eq!(r.usage.cache.positions().0, position);
    let routes = routes_of(&r);
    assert_eq!(routes.keys().map(String::as_str).collect::<Vec<_>>(), ["openai-oauth"], "{routes:?}");
}

/// The file's write fails when a provider is invalidated. The failure is said, nothing is acknowledged, and the
/// readings stay gone for every reader though the file still holds them. The next save that succeeds writes the
/// outstanding erase with its own reading, in that order, and leaves the other routes of the file alone.
#[tokio::test]
async fn an_erase_whose_write_failed_is_written_with_the_next_save() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(41))));
    r.usage.fetch_snapshot(&route(), false).await.unwrap();
    r.usage.cache.saved().await;
    add_foreign_route(&r);

    let failing = Arc::new(std::sync::atomic::AtomicBool::new(true));
    r.usage.cache.seams.lock().unwrap().before_write = Some({
        let failing = failing.clone();
        Arc::new(move || if failing.load(std::sync::atomic::Ordering::SeqCst) { Err(std::io::Error::other("the disk is full")) } else { Ok(()) })
    });
    r.usage.invalidate("anthropic-oauth").await;
    assert!(r.logs.lock().unwrap().iter().any(|line| line.contains("Usage cache could not be cleared: the disk is full")), "{:?}", r.logs.lock().unwrap());
    let (acknowledged, position) = r.usage.cache.positions();
    assert!(acknowledged < position, "a failed write was acknowledged");
    assert!(routes_of(&r).contains_key(&slot()), "the file still holds the retired reading");
    assert!(r.usage.read_cached(&route(), false).await.is_none() && r.usage.read_cached(&route(), true).await.is_none());
    assert!(r.usage.read_cached(&RouteInfo { model: "claude-y".into(), ..route() }, true).await.is_none());

    failing.store(false, std::sync::atomic::Ordering::SeqCst);
    let other_model = RouteInfo { model: "claude-y".into(), ..route() };
    assert_eq!(r.usage.fetch_snapshot(&other_model, true).await.as_ref().and_then(used), Some(41));
    r.usage.cache.saved().await;
    let routes = routes_of(&r);
    let mut kept: Vec<&str> = routes.keys().map(String::as_str).collect();
    kept.sort_unstable();
    let (bare, model) = (slot(), format!("{}\u{1}claude-y", slot()));
    let mut expected = vec![bare.as_str(), model.as_str(), "openai-oauth"];
    expected.sort_unstable();
    assert_eq!(kept, expected, "the outstanding erase went with the save, and the other routes stay");
    assert_eq!(routes.get(&slot()).and_then(used), Some(41));
    let (acknowledged, position) = r.usage.cache.positions();
    assert_eq!(acknowledged, position);
}

/// The durability lane's queue is full when a reading is to be recorded: the roster write is refused. The reading is
/// not returned as measured and not cached, so the roster and the caches agree; with room again the next call measures
/// and records.
#[tokio::test]
async fn a_reading_whose_roster_write_was_refused_is_not_taken_as_recorded() {
    let r = rig().await;
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(40))));
    r.http.queue(ANTHROPIC_URL, Ok((200, five_hour(41))));
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    assert!(r.usage.fetch_snapshot(&route(), true).await.is_none(), "an unrecorded reading is a failed one");
    drop(full);
    assert!(r.store.pool("anthropic-oauth").await.unwrap().account(ID).unwrap().usage.is_none());
    assert!(r.usage.read_cached(&route(), false).await.is_none(), "nothing was cached for it");

    let snap = r.usage.fetch_snapshot(&route(), false).await.unwrap();
    assert_eq!(snap["quotaWindows"][0]["usedPct"], 41);
    let pool = r.store.pool("anthropic-oauth").await.unwrap();
    assert_eq!(pool.account(ID).unwrap().usage.as_ref().unwrap().windows[0].used_pct, Some(41.0));
}

#[tokio::test]
async fn a_codex_credit_reading_lifts_a_stale_quota_block_when_credits_are_enabled() {
    use crate::accounts::{AccountChange, BlockOptions, policy};

    const WHAM_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", "default", "Default", false).await.unwrap();
    r.store
        .credential_file("openai-oauth", "default")
        .unwrap()
        .save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref", "account_id": "acct" }))
        .await
        .unwrap();
    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let now = r.store.now_ms();
    let reset_at = now + 18_000_000;
    let block_quota = || async {
        r.store
            .block(
                "openai-oauth",
                "default",
                reset_at,
                "gpt-6.2-astra",
                BlockOptions { server_scheduled: true, quota: true, reset: true, ..BlockOptions::default() },
            )
            .await
            .unwrap();
    };
    let wham = |overage_reached: bool, spend_reached: bool| {
        serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 }
            },
            "credits": {
                "has_credits": true,
                "unlimited": false,
                "overage_limit_reached": overage_reached,
                "balance": "570.8442500000"
            },
            "spend_control": { "reached": spend_reached, "individual_limit": null }
        })
        .to_string()
    };
    let codex_route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-6.2-astra".into(), account_id: "default".into() };

    // Overage limit or spend control reached: credits cannot serve, so the quota block stays.
    block_quota().await;
    r.http.queue(WHAM_URL, Ok((200, wham(true, false))));
    r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(policy::account_exhausted(&row, now, "gpt-6.2-astra", true));

    r.http.queue(WHAM_URL, Ok((200, wham(false, true))));
    r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(policy::account_exhausted(&row, now, "gpt-6.2-astra", true));

    // Credit use off: available credits do not lift the quota block.
    r.store.change("openai-oauth", AccountChange { use_credits: Some(false), ..AccountChange::default() }).await.unwrap();
    r.http.queue(WHAM_URL, Ok((200, wham(false, false))));
    r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(policy::account_exhausted(&row, now, "gpt-6.2-astra", true));

    // Re-enabling credit use clears the stale quota block immediately.
    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(!policy::account_exhausted(&row, now, "gpt-6.2-astra", true));

    // With credit use already on, a fresh credit reading lifts a stale quota block recorded before credits were usable.
    r.store.clear_quota_state("openai-oauth", "default").await.unwrap();
    block_quota().await;
    r.http.queue(WHAM_URL, Ok((200, wham(false, false))));
    r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(row.blocks().is_empty());
    assert!(!policy::account_exhausted(&row, now, "gpt-6.2-astra", true));

    // Alongside a non-quota cooldown, only the quota block lifts; the cooldown stays until its own deadline.
    r.store.clear_quota_state("openai-oauth", "default").await.unwrap();
    block_quota().await;
    r.store
        .block("openai-oauth", "default", now + 60_000, "other-model", BlockOptions { server_scheduled: true, quota: false, ..BlockOptions::default() })
        .await
        .unwrap();
    r.http.queue(WHAM_URL, Ok((200, wham(false, false))));
    r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert_eq!(row.blocks().len(), 1);
    assert_eq!(row.blocks()[0].blocked_quota, None);
    assert_eq!(row.blocks()[0].blocked_until, now + 60_000);
    assert!(policy::account_exhausted(&row, now, "other-model", true));
    assert!(!policy::account_exhausted(&row, now + 60_000, "gpt-6.2-astra", true));
}

#[tokio::test]
async fn credits_cover_only_the_primary_codex_limit_and_leave_additional_model_buckets_blocked() {
    use crate::accounts::{AccountChange, BlockOptions, policy};
    use crate::service::quota_usable::reading_serves_model;

    const WHAM_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", "default", "Default", false).await.unwrap();
    r.store
        .credential_file("openai-oauth", "default")
        .unwrap()
        .save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref", "account_id": "acct" }))
        .await
        .unwrap();

    let now = r.store.now_ms();
    let reset_at = now + 18_000_000;
    let wham = serde_json::json!({
        "plan_type": "pro",
        "rate_limit": {
            "allowed": false,
            "limit_reached": true,
            "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 }
        },
        "additional_rate_limits": [{
            "limit_name": "gpt-5-codex-spark",
            "metered_feature": "codex_spark",
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 18000, "reset_at": reset_at / 1000 }
            }
        }],
        "credits": { "has_credits": true, "unlimited": false, "balance": "570.84425" }
    })
    .to_string();
    let codex_route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-6.2-astra".into(), account_id: "default".into() };

    r.store
        .block(
            "openai-oauth",
            "default",
            reset_at,
            "gpt-6.2-astra",
            BlockOptions { server_scheduled: true, quota: true, limit: "codex".into(), reset: true, ..BlockOptions::default() },
        )
        .await
        .unwrap();
    r.store
        .block(
            "openai-oauth",
            "default",
            reset_at,
            "gpt-5-codex-spark",
            BlockOptions { server_scheduled: true, quota: true, limit: "codex_spark".into(), reset: true, ..BlockOptions::default() },
        )
        .await
        .unwrap();

    // First read while credit use is off, then enable credit use and read again.
    r.http.queue(WHAM_URL, Ok((200, wham.clone())));
    let snap = r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    assert!(!reading_serves_model(Some(&snap), "gpt-5-codex-spark", true));
    assert!(reading_serves_model(Some(&snap), "gpt-6.2-astra", true));

    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(!policy::account_exhausted(&row, now, "gpt-6.2-astra", true));
    assert!(policy::account_exhausted(&row, now, "gpt-5-codex-spark", true));
    assert_eq!(row.blocks().len(), 1);
    assert_eq!(row.blocks()[0].blocked_model.as_deref(), Some("gpt-5-codex-spark"));

    // Even an unnamed block recorded without credit use stays blocked on the full additional-bucket model
    // across enabling credit use and fresh credit readings.
    r.store.change("openai-oauth", AccountChange { use_credits: Some(false), ..AccountChange::default() }).await.unwrap();
    r.store
        .block(
            "openai-oauth",
            "default",
            reset_at,
            "gpt-5-codex-spark",
            BlockOptions { server_scheduled: true, quota: true, reset: true, ..BlockOptions::default() },
        )
        .await
        .unwrap();
    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();
    r.http.queue(WHAM_URL, Ok((200, wham)));
    r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(policy::account_exhausted(&row, now, "gpt-5-codex-spark", true));
    assert!(!policy::account_exhausted(&row, now, "gpt-6.2-astra", true));
    assert_eq!(row.blocks().len(), 1);
    assert_eq!(row.blocks()[0].blocked_model.as_deref(), Some("gpt-5-codex-spark"));
    assert_eq!(row.blocks()[0].blocked_with_credits, None);
}

#[tokio::test]
async fn workspace_rate_limit_reached_types_prevent_credits_from_serving_or_lifting_blocks() {
    use crate::accounts::{AccountChange, BlockOptions, policy};
    use crate::service::quota_usable::{balance_has_credits, reading_serves_model};

    const WHAM_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", "default", "Default", false).await.unwrap();
    r.store
        .credential_file("openai-oauth", "default")
        .unwrap()
        .save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref", "account_id": "acct" }))
        .await
        .unwrap();
    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let now = r.store.now_ms();
    let reset_at = now + 18_000_000;
    let codex_route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-6.2-astra".into(), account_id: "default".into() };
    let wham = |reached_type: &str| {
        serde_json::json!({
            "plan_type": "team",
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 }
            },
            "rate_limit_reached_type": { "type": reached_type },
            "credits": { "has_credits": true, "unlimited": false, "balance": "570.84425" },
            "spend_control": { "reached": false }
        })
        .to_string()
    };

    r.store
        .block(
            "openai-oauth",
            "default",
            reset_at,
            "gpt-6.2-astra",
            BlockOptions { server_scheduled: true, quota: true, reset: true, ..BlockOptions::default() },
        )
        .await
        .unwrap();

    for reached_type in
        ["workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]
    {
        r.http.queue(WHAM_URL, Ok((200, wham(reached_type))));
        let snap = r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
        assert_eq!(snap["balance"]["workspaceLimitReached"], true, "{reached_type}");
        assert!(!balance_has_credits(snap.get("balance")), "{reached_type}");
        assert!(!reading_serves_model(Some(&snap), "gpt-6.2-astra", true), "{reached_type}");
        let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
        assert!(policy::account_exhausted(&row, now, "gpt-6.2-astra", true), "{reached_type}");
    }

    // A plain rate_limit_reached does not disable credits.
    r.http.queue(WHAM_URL, Ok((200, wham("rate_limit_reached"))));
    let snap = r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    assert!(balance_has_credits(snap.get("balance")));
    assert!(reading_serves_model(Some(&snap), "gpt-6.2-astra", true));
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert!(!policy::account_exhausted(&row, now, "gpt-6.2-astra", true));
}

#[tokio::test]
async fn anthropic_disabled_extra_usage_does_not_count_as_usable_credits_or_lift_blocks() {
    use crate::accounts::{AccountChange, BlockOptions, policy};
    use crate::service::quota_usable::{balance_has_credits, reading_serves_model};

    let r = rig().await;
    r.store.change("anthropic-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let now = r.store.now_ms();
    let reset_at = now + 3_600_000;
    r.store
        .block(
            "anthropic-oauth",
            ID,
            reset_at,
            "claude-sonnet-4-6",
            BlockOptions { server_scheduled: true, quota: true, limit: "five_hour".into(), reset: true, ..BlockOptions::default() },
        )
        .await
        .unwrap();

    let reading = |enabled: bool| {
        serde_json::json!({
            "five_hour": { "utilization": 100.0, "resets_at": "2030-01-02T03:04:05.000Z" },
            "extra_usage": { "is_enabled": enabled, "monthly_limit": 5000, "used_credits": 100, "currency": "USD" }
        })
        .to_string()
    };

    // Extra Usage off: monthly budget present on wire must not count as usable credit or lift the 5H block.
    r.http.queue(ANTHROPIC_URL, Ok((200, reading(false))));
    let snap = r.usage.fetch_snapshot(&route(), true).await.unwrap();
    assert!(snap["balance"].is_null());
    assert!(!balance_has_credits(snap.get("balance")));
    assert!(!reading_serves_model(Some(&snap), "claude-sonnet-4-6", true));
    let row = r.store.pool("anthropic-oauth").await.unwrap().account(ID).unwrap().clone();
    assert!(policy::account_exhausted(&row, now, "claude-sonnet-4-6", true));

    // Extra Usage enabled: positive remaining budget counts as usable credit and lifts the stale 5H block.
    r.http.queue(ANTHROPIC_URL, Ok((200, reading(true))));
    let snap = r.usage.fetch_snapshot(&route(), true).await.unwrap();
    assert!(balance_has_credits(snap.get("balance")));
    assert!(reading_serves_model(Some(&snap), "claude-sonnet-4-6", true));
    let row = r.store.pool("anthropic-oauth").await.unwrap().account(ID).unwrap().clone();
    assert!(!policy::account_exhausted(&row, now, "claude-sonnet-4-6", true));
}

#[tokio::test]
async fn unlimited_or_hidden_codex_credit_balances_still_count_as_usable_credits() {
    use crate::accounts::{AccountChange, BlockOptions, policy};
    use crate::service::quota_usable::{balance_has_credits, reading_serves_model};

    const WHAM_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", "default", "Default", false).await.unwrap();
    r.store
        .credential_file("openai-oauth", "default")
        .unwrap()
        .save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref", "account_id": "acct" }))
        .await
        .unwrap();
    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let now = r.store.now_ms();
    let reset_at = now + 18_000_000;
    let codex_route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-6.2-astra".into(), account_id: "default".into() };
    let wham = |credits: serde_json::Value| {
        serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 }
            },
            "credits": credits
        })
        .to_string()
    };

    for credits in [
        serde_json::json!({ "has_credits": true, "unlimited": false, "balance": null }),
        serde_json::json!({ "has_credits": true, "unlimited": false, "balance": "" }),
        serde_json::json!({ "has_credits": false, "unlimited": true, "balance": null }),
    ] {
        r.store.clear_quota_state("openai-oauth", "default").await.unwrap();
        r.store
            .block(
                "openai-oauth",
                "default",
                reset_at,
                "gpt-6.2-astra",
                BlockOptions { server_scheduled: true, quota: true, reset: true, ..BlockOptions::default() },
            )
            .await
            .unwrap();
        r.http.queue(WHAM_URL, Ok((200, wham(credits.clone()))));
        let snap = r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
        assert!(!snap["balance"].is_null(), "{credits}");
        assert!(balance_has_credits(snap.get("balance")), "{credits}");
        assert!(reading_serves_model(Some(&snap), "gpt-6.2-astra", true), "{credits}");
        let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
        assert!(!policy::account_exhausted(&row, now, "gpt-6.2-astra", true), "{credits}");
    }

    // No credits, not unlimited, null balance: does not count as usable credits.
    r.store.clear_quota_state("openai-oauth", "default").await.unwrap();
    r.store
        .block(
            "openai-oauth",
            "default",
            reset_at,
            "gpt-6.2-astra",
            BlockOptions { server_scheduled: true, quota: true, reset: true, ..BlockOptions::default() },
        )
        .await
        .unwrap();
    r.http.queue(WHAM_URL, Ok((200, wham(serde_json::json!({ "has_credits": false, "unlimited": false, "balance": null })))));
    let snap = r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
    assert_eq!(snap["balance"]["hasCredits"], false);
    assert!(!balance_has_credits(snap.get("balance")));
    let row = r.store.pool("openai-oauth").await.unwrap().account("default").unwrap().clone();
    assert_eq!(row.has_credits, Some(false));
    assert!(policy::account_exhausted(&row, now, "gpt-6.2-astra", true));
}

#[tokio::test]
async fn cursor_included_plan_balance_does_not_stamp_has_credits_or_lift_exhausted_api_block() {
    use crate::accounts::{AccountChange, BlockOptions, policy};
    use crate::service::quota_usable::{balance_has_credits, reading_serves_model, snapshot_has_credits};

    struct CursorSnapshots(Mutex<VecDeque<Value>>);

    #[async_trait]
    impl UsageSource for CursorSnapshots {
        async fn ensure_auth(&self, _: &str, _: &str, _: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
            Ok(None)
        }
        async fn provider_snapshot(&self, _: &str, _: &str, sent: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
            *sent = Some(UsageAuth::plain(serde_json::json!({ "access_token": "tok", "refresh_token": "ref" })));
            Ok(self.0.lock().unwrap().pop_front())
        }
    }

    let r = rig().await;
    r.store.register("cursor-oauth", "default", "Default", false).await.unwrap();
    r.store.credential_file("cursor-oauth", "default").unwrap().save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref" })).await.unwrap();
    r.store.change("cursor-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let now = r.store.now_ms();
    let reset_at = now + 3_600_000;
    let route = RouteInfo { provider: "cursor-oauth".into(), model: "claude-sonnet-4-6".into(), account_id: "default".into() };

    let snap_with_balance = |balance: Value| {
        serde_json::json!({
            "provider": "cursor-oauth",
            "source": "cursor-dashboard",
            "quotaWindows": [
                { "label": "Basic", "source": "cursor-dashboard", "usedPct": 10.0, "resetAt": reset_at, "models": ["auto", "default", "composer"] },
                { "label": "API", "source": "cursor-dashboard", "usedPct": 100.0, "resetAt": reset_at, "except": ["auto", "default", "composer"] }
            ],
            "balance": balance
        })
    };

    let snapshots = Arc::new(CursorSnapshots(Mutex::new(VecDeque::from([
        // 1. Included plan remainingUsd with hasCredits=false (onDemand disabled / $0 prepaid).
        snap_with_balance(serde_json::json!({ "source": "cursor-dashboard", "limitUsd": 20.0, "usedUsd": 5.0, "remainingUsd": 15.0, "hasCredits": false })),
        // 2. Legacy cached/synthetic cursor-dashboard balance with remainingUsd only (no hasCredits field).
        snap_with_balance(serde_json::json!({ "source": "cursor-dashboard", "limitUsd": 20.0, "usedUsd": 5.0, "remainingUsd": 15.0 })),
        // 3. Enabled onDemand overage credit (hasCredits=true).
        snap_with_balance(serde_json::json!({ "source": "cursor-dashboard", "limitUsd": 20.0, "usedUsd": 5.0, "remainingUsd": 15.0, "hasCredits": true })),
    ]))));
    let usage = service_over(&r, snapshots, r.dir.path().to_owned());

    // Cases 1 and 2 must NOT stamp has_credits = Some(true) or lift the exhausted API block.
    // Case 1 explicitly proves hasCredits=false -> Some(false); Case 2 has no credit verdict -> None.
    for (case, expected_state) in [("explicit hasCredits=false", Some(false)), ("legacy included remainingUsd only", None)] {
        r.store.clear_quota_state("cursor-oauth", "default").await.unwrap();
        r.store
            .block(
                "cursor-oauth",
                "default",
                reset_at,
                "claude-sonnet-4-6",
                BlockOptions { server_scheduled: true, quota: true, reset: true, ..BlockOptions::default() },
            )
            .await
            .unwrap();
        let snap = usage.fetch_snapshot(&route, true).await.unwrap();
        assert!(!balance_has_credits(snap.get("balance")), "{case}");
        assert!(!snapshot_has_credits("cursor-oauth", &snap), "{case}");
        assert!(!reading_serves_model(Some(&snap), "claude-sonnet-4-6", true), "{case}");
        let row = r.store.pool("cursor-oauth").await.unwrap().account("default").unwrap().clone();
        assert_eq!(row.has_credits, expected_state, "{case}");
        assert!(policy::account_exhausted(&row, now, "claude-sonnet-4-6", true), "{case}");
    }

    // Case 3: proven onDemand overage credits DO stamp has_credits and lift the exhausted API block.
    let snap = usage.fetch_snapshot(&route, true).await.unwrap();
    assert!(balance_has_credits(snap.get("balance")));
    assert!(snapshot_has_credits("cursor-oauth", &snap));
    assert!(reading_serves_model(Some(&snap), "claude-sonnet-4-6", true));
    let row = r.store.pool("cursor-oauth").await.unwrap().account("default").unwrap().clone();
    assert_eq!(row.has_credits, Some(true));
    assert!(!policy::account_exhausted(&row, now, "claude-sonnet-4-6", true));
}

#[tokio::test]
async fn anthropic_unlimited_extra_usage_counts_as_usable_credits_when_windows_are_full() {
    use crate::accounts::{AccountChange, policy};
    use crate::service::quota_usable::{balance_has_credits, reading_serves_model, snapshot_credit_state, snapshot_has_credits};

    let r = rig().await;
    r.store.change("anthropic-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let payload = serde_json::json!({
        "five_hour": { "utilization": 100.0, "resets_at": "2030-01-02T03:04:05.000Z" },
        "seven_day": { "utilization": 100.0, "resets_at": "2030-01-09T00:00:00.000Z" },
        "extra_usage": { "is_enabled": true, "monthly_limit": null, "used_credits": 1250, "utilization": null, "currency": "USD" }
    })
    .to_string();

    r.http.queue(ANTHROPIC_URL, Ok((200, payload)));
    let snap = r.usage.fetch_snapshot(&route(), true).await.unwrap();
    assert_eq!(snap["balance"]["unlimited"], true);
    assert_eq!(snap["balance"]["spentUsd"].as_f64(), Some(12.5));
    assert!(snap["balance"].get("budgetUsd").is_none());
    assert!(snap["balance"].get("remainingUsd").is_none());
    let extra_win = snap["quotaWindows"].as_array().unwrap().iter().find(|w| w["label"] == "EXTRA").unwrap();
    assert_eq!(extra_win["unlimited"], true);
    assert_eq!(extra_win["usedUsd"].as_f64(), Some(12.5));
    assert!(extra_win.get("limitUsd").is_none());
    assert!(extra_win.get("remainingUsd").is_none());

    assert!(balance_has_credits(snap.get("balance")));
    assert_eq!(snapshot_credit_state("anthropic-oauth", &snap), Some(true));
    assert!(snapshot_has_credits("anthropic-oauth", &snap));
    assert!(reading_serves_model(Some(&snap), "claude-sonnet-4-6", true));

    let row = r.store.pool("anthropic-oauth").await.unwrap().account(ID).unwrap().clone();
    assert_eq!(row.has_credits, Some(true));
    assert!(!policy::account_exhausted(&row, r.store.now_ms(), "claude-sonnet-4-6", true));
}

#[tokio::test]
async fn recorded_credit_depletion_exhausts_account_without_waiting_for_live_429() {
    use crate::accounts::{AccountChange, policy};

    const WHAM_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", "default", "Default", false).await.unwrap();
    r.store
        .credential_file("openai-oauth", "default")
        .unwrap()
        .save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref", "account_id": "acct" }))
        .await
        .unwrap();
    r.store.change("openai-oauth", AccountChange { use_credits: Some(true), ..AccountChange::default() }).await.unwrap();

    let now = r.store.now_ms();
    let reset_at = (now + 18_000_000) / 1000 * 1000;
    let codex_route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-6.2-astra".into(), account_id: "default".into() };

    for (case, body) in [
        (
            "overage_limit_reached",
            serde_json::json!({
                "plan_type": "team",
                "rate_limit": { "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 } },
                "credits": { "has_credits": true, "unlimited": false, "balance": "100", "overage_limit_reached": true }
            }),
        ),
        (
            "spend_control_reached",
            serde_json::json!({
                "plan_type": "team",
                "rate_limit": { "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 } },
                "credits": { "has_credits": true, "unlimited": false, "balance": "100" },
                "spend_control": { "reached": true }
            }),
        ),
        (
            "workspace_limit_reached",
            serde_json::json!({
                "plan_type": "team",
                "rate_limit": { "primary_window": { "used_percent": 100, "limit_window_seconds": 604800, "reset_at": reset_at / 1000 } },
                "credits": { "has_credits": true, "unlimited": false, "balance": "100" },
                "rate_limit_reached_type": { "type": "workspace_owner_credits_depleted" }
            }),
        ),
    ] {
        r.store.clear_quota_state("openai-oauth", "default").await.unwrap();
        r.http.queue(WHAM_URL, Ok((200, body.to_string())));
        let _snap = r.usage.fetch_snapshot(&codex_route, true).await.unwrap();
        let pool = r.store.pool("openai-oauth").await.unwrap();
        let row = pool.account("default").unwrap();
        assert_eq!(row.has_credits, Some(false), "{case}");
        assert!(row.blocks().is_empty(), "{case}: no 429 block exists yet");
        assert!(policy::account_exhausted(row, now, "gpt-6.2-astra", true), "{case}");
        assert_eq!(policy::accounts_reset_at(std::slice::from_ref(row), now, "gpt-6.2-astra", true), Some(reset_at), "{case}");
        assert_eq!(policy::account_limit(row, now, true), Some(policy::Limit::Account), "{case}");
        assert!(policy::choose_account(&pool, &Default::default(), now, "gpt-6.2-astra", None).is_none(), "{case}");
    }
}

#[tokio::test]
async fn multi_window_snapshot_expires_when_any_window_resets_while_preserving_stale_fallback() {
    const WHAM_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
    let r = rig().await;
    r.store.register("openai-oauth", "default", "Default", false).await.unwrap();
    r.store
        .credential_file("openai-oauth", "default")
        .unwrap()
        .save(&serde_json::json!({ "access_token": "tok", "refresh_token": "ref", "account_id": "acct" }))
        .await
        .unwrap();

    let now = now_ms();
    let elapsed_5h = (now - 5_000) / 1000 * 1000;
    let future_5h = (now + 5 * 3_600_000) / 1000 * 1000;
    let future_7d = (now + 5 * 86_400_000) / 1000 * 1000;

    let two_window = serde_json::json!({
        "provider": "openai-oauth",
        "cachedAt": now,
        "quotaWindows": [
            { "label": "5H", "usedPct": 100.0, "resetAt": elapsed_5h },
            { "label": "7D", "usedPct": 35.0, "resetAt": future_7d }
        ]
    });
    assert!(fresh(Some(&two_window), LIVE_CACHE_TTL_MS, now).is_none(), "elapsed 5H invalidates live freshness even while 7D is future");
    assert!(fresh(Some(&two_window), DISK_CACHE_TTL_MS, now).is_none(), "elapsed 5H invalidates disk freshness even while 7D is future");
    assert!(
        fresh_reading(Some(&two_window), STALE_DISK_CACHE_TTL_MS, now, true).is_some(),
        "stale fallback keeps a multi-window snapshot readable when offline"
    );

    let all_future = serde_json::json!({
        "provider": "openai-oauth",
        "cachedAt": now,
        "quotaWindows": [
            { "label": "5H", "usedPct": 0.0, "resetAt": future_5h },
            { "label": "7D", "usedPct": 35.0, "resetAt": future_7d }
        ]
    });
    assert!(fresh(Some(&all_future), LIVE_CACHE_TTL_MS, now).is_some());

    let codex_route = RouteInfo { provider: "openai-oauth".into(), model: "gpt-6.2-astra".into(), account_id: "default".into() };
    let expired_body = serde_json::json!({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": { "used_percent": 100, "limit_window_seconds": 18000, "reset_at": elapsed_5h / 1000 },
            "secondary_window": { "used_percent": 35, "limit_window_seconds": 604800, "reset_at": future_7d / 1000 }
        }
    });
    let rolled_body = serde_json::json!({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": { "used_percent": 0, "limit_window_seconds": 18000, "reset_at": future_5h / 1000 },
            "secondary_window": { "used_percent": 35, "limit_window_seconds": 604800, "reset_at": future_7d / 1000 }
        }
    });

    r.http.queue(WHAM_URL, Ok((200, expired_body.to_string())));
    r.http.queue(WHAM_URL, Ok((200, rolled_body.to_string())));

    let wham_calls = || r.http.urls().into_iter().filter(|u| u == WHAM_URL).count();

    let first = r.usage.fetch_snapshot(&codex_route, false).await.unwrap();
    assert_eq!(first["quotaWindows"][0]["usedPct"], 100.0);
    assert_eq!(wham_calls(), 1);
    assert!(r.usage.read_cached(&codex_route, false).await.is_none(), "non-stale cache lookup rejects elapsed 5H");
    let stale = r.usage.read_cached(&codex_route, true).await.expect("stale fallback remains available when offline");
    assert_eq!(stale["quotaWindows"][1]["usedPct"], 35.0);

    // Without force, fetch_snapshot must re-fetch live instead of serving the expired 5H reading for 60s.
    let second = r.usage.fetch_snapshot(&codex_route, false).await.unwrap();
    assert_eq!(wham_calls(), 2);
    assert_eq!(second["quotaWindows"][0]["usedPct"], 0.0);
    assert_eq!(r.usage.read_cached(&codex_route, false).await.unwrap()["quotaWindows"][0]["usedPct"], 0.0);

    // Once all windows are in the future, the live cache serves the snapshot without another HTTP call.
    let third = r.usage.fetch_snapshot(&codex_route, false).await.unwrap();
    assert_eq!(wham_calls(), 2);
    assert_eq!(third["quotaWindows"][0]["usedPct"], 0.0);
}
