//! The production usage ports against Node's own requests (`record-usage-ports.mjs`): the same
//! fetches, byte for byte (URL, method, header order and spelling, body, timeout), the same
//! readings, and the same samples handed to the quota history.

use std::collections::HashMap;

use bytes::Bytes;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::TransportFault;

use super::super::oauth_usage::QuotaHistory;
use super::super::oauth_usage::QuotaSample;
use super::super::oauth_usage::UsageDeps;
use super::*;
use crate::oauth::CredentialIo;
use crate::registry::keys::Environment;
use crate::service::oauth_usage::OAuthUsage;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;

#[path = "usage_provider_reads_tests.rs"]
mod provider_reads;

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

struct Reply {
    url: String,
    status: u16,
    body: String,
    fail: bool,
    used: bool,
}

/// The scripted network: a request is answered by the first unused reply for its URL; anything else
/// is a connection that never opens.
struct Net {
    replies: Mutex<Vec<Reply>>,
    seen: Mutex<Vec<WireRequest>>,
    /// The deadline and redirect rule each request went out under.
    exchanges: Mutex<Vec<Exchange>>,
}

impl Net {
    fn from(replies: &Value) -> Arc<Self> {
        let replies = replies
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Reply {
                url: r["url"].as_str().unwrap().to_owned(),
                status: r["status"].as_u64().unwrap_or(200) as u16,
                body: match &r["body"] {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                },
                fail: r["fail"] == true,
                used: false,
            })
            .collect();
        Arc::new(Self { replies: Mutex::new(replies), seen: Mutex::new(Vec::new()), exchanges: Mutex::new(Vec::new()) })
    }
}

#[async_trait]
impl HttpSend for Net {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let url = request.url.clone();
        self.seen.lock().unwrap().push(request);
        self.exchanges.lock().unwrap().push(exchange);
        let mut replies = self.replies.lock().unwrap();
        match replies.iter_mut().find(|r| r.url == url && !r.used) {
            Some(reply) if !reply.fail => {
                reply.used = true;
                Ok(HttpResponse { status: reply.status, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from(reply.body.clone())))) })
            }
            Some(reply) => {
                reply.used = true;
                Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
            }
            None => Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent)),
        }
    }
}

/// The injected provider of the recording: `auth`, and `forced` once a refresh was asked for.
struct Flow {
    auth: Value,
    forced: Value,
    refreshed: Mutex<bool>,
}

#[async_trait]
impl UsageSource for Flow {
    async fn ensure_auth(&self, _: &str, _: &str, rejected: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError> {
        let mut refreshed = self.refreshed.lock().unwrap();
        *refreshed |= rejected.is_some();
        Ok(Some(UsageAuth::plain(if *refreshed && !self.forced.is_null() { self.forced.clone() } else { self.auth.clone() })))
    }

    async fn provider_snapshot(&self, _: &str, _: &str) -> Result<Option<Value>, UsageError> {
        Ok(None)
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

struct Vars(HashMap<String, String>);

impl Environment for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

#[tokio::test]
async fn a_refusal_of_the_transport_reads_as_nodes_fetch_failed_or_timeout() {
    /// Refuses with the message the link gives for the exchange's surface, or with none of the link's (a route the
    /// proxy policy could not decide: no typed fault).
    struct Refusing(Option<TransportFault>);

    #[async_trait]
    impl HttpSend for Refusing {
        async fn send(&self, _: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
            let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Ambiguous);
            error.message = "no route".to_owned();
            if let Some(fault) = &self.0 {
                error.transport = Some(fault.clone());
                error.message = exchange.surface.timeout_text(Duration::from_secs(1)).unwrap();
            }
            Err(error)
        }
    }

    let http: Arc<dyn HttpSend> = Arc::new(Refusing(None));
    // No typed fault: Node's `fetch failed`.
    let undecided = RoutedUsageHttp::new(http).get("https://x.test/a", &[], Duration::from_secs(1)).await.err().unwrap();
    assert_eq!((undecided.message.as_str(), undecided.status), ("fetch failed", None));
}

#[tokio::test]
async fn a_provider_without_a_signed_in_credential_fails_and_one_without_usage_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let source = ProviderUsageSource::new(store, Net::from(&json!([])));
    for provider in ["openai-oauth", "anthropic-oauth", "grok-oauth"] {
        assert!(source.ensure_auth(provider, "default", None).await.is_err(), "{provider}");
    }
    assert!(source.ensure_auth("cursor-oauth", "default", None).await.unwrap().is_none());
    assert!(source.provider_snapshot("cursor-oauth", "default").await.is_err());
}

#[tokio::test]
async fn anthropic_usage_refresh_uses_the_daemons_claude_client_identity() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let store = AccountStore::new(dir.path().to_path_buf(), io);
    store
        .credential_file("anthropic-oauth", "default")
        .unwrap()
        .save(&json!({
            "claudeAiOauth": {
                "accessToken": "fixture-before-refresh",
                "refreshToken": "fixture-refresh",
                "scopes": ["user:inference"]
            }
        }))
        .await
        .unwrap();
    let net = Net::from(&json!([{
        "url": "https://platform.claude.com/v1/oauth/token",
        "body": {"access_token": "fixture-after-refresh", "expires_in": 3600}
    }]));
    let env = Vars(HashMap::from([("MIXDOG_CLI_VERSION".to_owned(), "2.9.120".to_owned())]));
    let versions = ClientVersions::new(net.clone(), dir.path().to_path_buf(), io, Arc::new(env));
    let source = ProviderUsageSource::new(store, net.clone()).with_versions(versions);
    let refused = source.ensure_auth("anthropic-oauth", "default", None).await.unwrap().unwrap();
    assert_eq!(refused.doc["accessToken"], "fixture-before-refresh");
    let auth = source.ensure_auth("anthropic-oauth", "default", Some(&refused)).await.unwrap().unwrap();
    assert_eq!(auth.doc["accessToken"], "fixture-after-refresh");
    let seen = net.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "POST");
    assert!(seen[0].headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("user-agent") && value == "claude-cli/2.9.120 (external, sdk-cli)"));
}

/// Two usage readings of one account overlap a login change: the first is sent on one login, the second on the login
/// stored after it, and both are refused. Each retry hands back the credential its own request carried. The first
/// one's names a login that is no longer stored, so it is handed the stored one as it is and nothing is spent; the
/// second one's refreshes the login it was sent on, once.
#[tokio::test]
async fn overlapping_readings_across_a_login_change_each_answer_for_their_own_login() {
    let logins: [(&str, &str, &str, fn(&str, &str) -> Value); 2] = [
        (
            "anthropic-oauth",
            "accessToken",
            "https://platform.claude.com/v1/oauth/token",
            |access, refresh| json!({ "claudeAiOauth": { "accessToken": access, "refreshToken": refresh } }),
        ),
        (
            "openai-oauth",
            "access_token",
            "https://auth.openai.com/oauth/token",
            |access, refresh| json!({ "access_token": access, "refresh_token": refresh, "account_id": "acct" }),
        ),
    ];
    for (provider, field, token_url, login) in logins {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        let file = store.credential_file(provider, "default").unwrap();
        file.save(&login("fixture-first", "fixture-first-refresh")).await.unwrap();
        let net = Net::from(&json!([{
            "url": token_url,
            "body": {"access_token": "fixture-refreshed", "refresh_token": "fixture-third-refresh", "expires_in": 3600}
        }]));
        let source = ProviderUsageSource::new(store, net.clone());
        let first = source.ensure_auth(provider, "default", None).await.unwrap().unwrap();
        assert_eq!(first.doc[field], "fixture-first", "{provider}");
        file.save(&login("fixture-second", "fixture-second-refresh")).await.unwrap();
        let second = source.ensure_auth(provider, "default", None).await.unwrap().unwrap();
        assert_eq!(second.doc[field], "fixture-second", "{provider}");

        let retried = source.ensure_auth(provider, "default", Some(&first)).await.unwrap().unwrap();
        assert_eq!(retried.doc[field], "fixture-second", "{provider}");
        assert!(net.seen.lock().unwrap().is_empty(), "{provider}: the second login's grant was spent for the first reading's refusal");

        let retried = source.ensure_auth(provider, "default", Some(&second)).await.unwrap().unwrap();
        assert_eq!(retried.doc[field], "fixture-refreshed", "{provider}");
        {
            let seen = net.seen.lock().unwrap();
            assert_eq!(seen.len(), 1, "{provider}");
            assert!(String::from_utf8_lossy(&seen[0].body).contains("fixture-second-refresh"), "{provider}: the second reading's own grant");
        }

        // The first reading's refusal arriving last of all finds the refreshed login and leaves it alone.
        let last = source.ensure_auth(provider, "default", Some(&first)).await.unwrap().unwrap();
        assert_eq!(last.doc[field], "fixture-refreshed", "{provider}");
        assert_eq!(net.seen.lock().unwrap().len(), 1, "{provider}");
    }
}

/// The Grok proxy refuses the token a usage reading was sent with. The refusal is the reading's answer, so the retry
/// behind a refused credential runs: the sign-in that reading carried is refreshed, once, and the reading is taken on
/// the new token.
#[tokio::test]
async fn a_grok_usage_reading_the_proxy_refuses_is_retried_on_the_refreshed_sign_in() {
    const BILLING: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
    const TOKEN: &str = "https://auth.x.ai/oauth2/token";

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let store = AccountStore::new(dir.path().to_path_buf(), io());
    store
        .credential_file("grok-oauth", "default")
        .unwrap()
        .save(&json!({ "access_token": "fixture-grok-first", "refresh_token": "fixture-grok-refresh", "token_endpoint": TOKEN, "user_id": "user-1" }))
        .await
        .unwrap();
    let net = Net::from(&json!([
        { "url": BILLING, "status": 401, "body": "" },
        { "url": TOKEN, "body": { "access_token": "fixture-grok-second", "refresh_token": "fixture-grok-refresh-2", "expires_in": 3600 } },
        { "url": BILLING, "body": {
            "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY", "end": 1_900_000_000 }, "weeklyLimit": { "val": 200 }, "used": { "val": 50 } } }
    ]));
    let versions = ClientVersions::new(net.clone(), dir.path().to_path_buf(), io(), Arc::new(Vars(HashMap::new())));
    let usage = OAuthUsage::new(UsageDeps {
        http: Arc::new(RoutedUsageHttp::new(net.clone())),
        source: Arc::new(ProviderUsageSource::new(store.clone(), net.clone())),
        grok: Arc::new(GrokVersionHeaders::new(versions)),
        history: Arc::new(History::default()),
        store,
        io: io(),
        log: Arc::new(|_| {}),
        data_dir: dir.path().join("data"),
    });
    let route = crate::service::oauth_usage::RouteInfo { provider: "grok-oauth".into(), model: String::new(), account_id: "default".into() };
    let reading = usage.fetch_snapshot(&route, true).await.expect("the reading taken on the refreshed sign-in");
    assert_eq!(reading["quotaWindows"][0]["usedPct"].as_f64(), Some(25.0));

    // Only the usage and token requests: the proxy warm-up and the probes of other hosts are not counted.
    let seen = net.seen.lock().unwrap();
    let bearers: Vec<&str> = seen
        .iter()
        .filter(|request| request.url == BILLING)
        .filter_map(|request| request.headers.iter().find(|(name, _)| name == "Authorization").map(|(_, value)| value.as_str()))
        .collect();
    assert_eq!(bearers, ["Bearer fixture-grok-first", "Bearer fixture-grok-second"]);
    let exchanges: Vec<&WireRequest> = seen.iter().filter(|request| request.url == TOKEN).collect();
    assert_eq!(exchanges.len(), 1);
    assert!(String::from_utf8_lossy(&exchanges[0].body).contains("fixture-grok-refresh"), "the refused reading's own sign-in is refreshed");
}

#[tokio::test]
async fn cursor_api_plan_read_exchanges_the_configured_key_without_a_registered_adapter() {
    use crate::providers::cursor::{API_URL, auth::EXCHANGE_URL};
    use crate::registry::keys::MemoryVault;

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let net = Net::from(&json!([
        {"url": EXCHANGE_URL, "body": {"accessToken": "fixture-cursor-bearer"}},
        {"url": format!("{API_URL}{}", usage_cursor::USAGE_PATH), "body": ""},
        {"url": format!("{API_URL}{}", usage_cursor::PLAN_PATH), "body": ""}
    ]));
    let keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), Arc::new(Vars(HashMap::new())), false);
    let source = ProviderUsageSource::new(store, net.clone())
        .with_cursor_api(keys, Arc::new(|| KeyConfig { api_key: Some("fixture-cursor-key".into()), api_key_env: None }));
    let reading = source.provider_snapshot("cursor-api", "default").await.unwrap().unwrap();
    assert_eq!(reading["provider"], "cursor-api");
    let seen = net.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    for (idx, expected) in ["Bearer fixture-cursor-key", "Bearer fixture-cursor-bearer", "Bearer fixture-cursor-bearer"].into_iter().enumerate() {
        assert!(seen[idx].headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("authorization") && value == expected));
    }
}

/// An OAuth usage read that is never answered ends 4.5 s in with the text of a timed-out signal.
#[tokio::test(start_paused = true)]
async fn an_oauth_usage_read_ends_after_four_and_a_half_seconds_when_never_answered() {
    use crate::transport::site_probe::TimingOut;

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let transport = TimingOut::new();
    let versions = ClientVersions::new(Net::from(&json!([])), dir.path().to_path_buf(), io(), Arc::new(Vars(HashMap::new())));
    let usage = OAuthUsage::new(UsageDeps {
        http: Arc::new(RoutedUsageHttp::new(transport.clone())),
        source: Arc::new(Flow { auth: json!({ "access_token": "a", "account_id": "x" }), forced: Value::Null, refreshed: Mutex::new(false) }),
        grok: Arc::new(GrokVersionHeaders::new(versions)),
        history: Arc::new(History::default()),
        store: AccountStore::new(dir.path().to_path_buf(), io()),
        io: io(),
        log: Arc::new(|_| {}),
        data_dir: dir.path().join("data"),
    });
    let error = usage.fetch_codex_reset_credits("default").await.err().expect("never answers");
    let seen = transport.seen();
    assert_eq!(seen[0].after, std::time::Duration::from_millis(4500));
    let text = "The operation was aborted due to timeout";
    assert_eq!((seen[0].text.as_str(), error.message.as_str()), (text, text));
}
/// The OpenCode Go status read is a bare abort timer: it ends 6.5 s in with the text of an aborted request.
#[tokio::test(start_paused = true)]
async fn the_opencode_go_status_read_ends_after_six_and_a_half_seconds_when_never_answered() {
    use crate::transport::site_probe::TimingOut;

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let transport = TimingOut::new();
    let source = ProviderUsageSource::new(store, transport.clone());
    let credentials = serde_json::from_value(json!({ "access_token": "a", "refresh_token": "r", "org_id": "o" })).unwrap();
    let error = source.opencode_status(&credentials).await.expect_err("never answers");
    let seen = transport.seen();
    assert_eq!(seen[0].after, std::time::Duration::from_millis(6500));
    assert_eq!((seen[0].text.as_str(), error.message.as_str()), ("This operation was aborted", "This operation was aborted"));
}
