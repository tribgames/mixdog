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
use super::super::oauth_usage::RouteInfo;
use super::super::oauth_usage::UsageDeps;
use super::*;
use crate::oauth::CredentialIo;
use crate::registry::keys::Environment;
use crate::service::oauth_usage::OAuthUsage;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;

const TWIN: &str = include_str!("../../../../fixtures/usage-ports/usage-ports-twin.json");

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
    async fn ensure_auth(&self, _: &str, _: &str, force: bool) -> Result<Option<Value>, UsageError> {
        let mut refreshed = self.refreshed.lock().unwrap();
        *refreshed |= force;
        Ok(Some(if *refreshed && !self.forced.is_null() { self.forced.clone() } else { self.auth.clone() }))
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

struct Rig {
    usage: Arc<OAuthUsage>,
    net: Arc<Net>,
    history: Arc<History>,
    _dir: tempfile::TempDir,
}

fn rig(flow: &Value) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let net = Net::from(&flow["replies"]);
    let history = Arc::new(History::default());
    let env = Arc::new(Vars(HashMap::from([("MIXDOG_GROK_CLIENT_VERSION".to_owned(), "9.9.9".to_owned())])));
    let versions = ClientVersions::new(Net::from(&json!([])), dir.path().to_path_buf(), io(), env);
    let usage = OAuthUsage::new(UsageDeps {
        http: Arc::new(RoutedUsageHttp::new(net.clone())),
        source: Arc::new(Flow { auth: flow["auth"].clone(), forced: flow["forcedAuth"].clone(), refreshed: Mutex::new(false) }),
        grok: Arc::new(GrokVersionHeaders::new(versions)),
        history: history.clone(),
        store: AccountStore::new(dir.path().to_path_buf(), io()),
        io: io(),
        log: Arc::new(|_| {}),
        data_dir: dir.path().join("data"),
    });
    Rig { usage, net, history, _dir: dir }
}

fn assert_wire(at: &str, rig: &Rig, flow: &Value) {
    let seen = rig.net.seen.lock().unwrap();
    let exchanges = rig.net.exchanges.lock().unwrap();
    let want = flow["wire"].as_array().unwrap();
    assert_eq!(seen.len(), want.len(), "{at}: requests {:?}", seen.iter().map(|r| &r.url).collect::<Vec<_>>());
    for (i, (got, want)) in seen.iter().zip(want).enumerate() {
        assert_eq!(got.url, want["url"].as_str().unwrap(), "{at} #{i} url");
        assert_eq!(got.method, want["method"].as_str().unwrap(), "{at} #{i} method");
        let headers: Vec<(String, String)> = want["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect();
        assert_eq!(got.headers, headers, "{at} #{i} headers");
        assert_eq!(got.body, want["body"].as_str().unwrap_or("").as_bytes(), "{at} #{i} body");
        // Node's `fetchOptions`: no redirect, and the deadline it names covers head and body.
        assert_eq!(exchanges[i].redirect, Redirect::Error, "{at} #{i} redirect");
        assert_eq!(exchanges[i].liveness.total_deadline(), Some(Duration::from_millis(want["timeoutMs"].as_u64().unwrap())), "{at} #{i} timeout");
    }
}

#[tokio::test]
async fn the_usage_fetch_puts_nodes_requests_on_the_wire_and_hands_nodes_samples_to_the_history() {
    let twin: Value = serde_json::from_str(TWIN).unwrap();
    let mut reads = 0;
    for flow in twin["flows"].as_array().unwrap().iter().filter(|f| f["redeem"] != true) {
        let at = flow["name"].as_str().unwrap();
        let rig = rig(flow);
        let route = RouteInfo { provider: flow["provider"].as_str().unwrap().to_owned(), model: String::new(), account_id: flow["account"].as_str().unwrap().to_owned() };
        let got = rig.usage.fetch_snapshot(&route, true).await;
        assert_wire(at, &rig, flow);
        assert_eq!(got.is_none(), flow["snapshotNull"] == true, "{at}: reading");
        let windows: Vec<(String, f64)> = got
            .iter()
            .flat_map(|s| s["quotaWindows"].as_array().cloned().unwrap_or_default())
            .map(|w| (w["label"].as_str().unwrap().to_owned(), w["usedPct"].as_f64().unwrap_or(f64::NAN)))
            .collect();
        let want: Vec<(String, f64)> = flow["windows"].as_array().unwrap().iter().map(|w| (w["label"].as_str().unwrap().to_owned(), w["usedPct"].as_f64().unwrap_or(f64::NAN))).collect();
        assert_eq!(format!("{windows:?}"), format!("{want:?}"), "{at}: windows");
        // The clock differs from the recording's, so a sample is compared without its time; a reset
        // given relative to now (codex) differs with it.
        let samples = rig.history.0.lock().unwrap();
        let sent: Vec<&Value> = flow["history"].as_array().unwrap().iter().flat_map(|batch| batch.as_array().unwrap()).collect();
        assert_eq!(samples.len(), sent.len(), "{at}: samples");
        for (got, want) in samples.iter().zip(&sent) {
            assert_eq!((got.provider.as_str(), got.account.as_str(), got.label.as_str()), (want["provider"].as_str().unwrap(), want["account"].as_str().unwrap(), want["label"].as_str().unwrap()), "{at}");
            assert_eq!(got.used_pct, want["usedPct"].as_f64().unwrap(), "{at}");
            if flow["provider"] != "openai-oauth" {
                assert_eq!(got.reset_at, want["resetAt"].as_i64(), "{at}");
            }
        }
        reads += 1;
    }
    assert!(reads >= 15);
}

#[tokio::test]
async fn a_redeem_posts_nodes_body_with_nodes_headers_and_replays_once() {
    let twin: Value = serde_json::from_str(TWIN).unwrap();
    for flow in twin["flows"].as_array().unwrap().iter().filter(|f| f["redeem"] == true) {
        let at = flow["name"].as_str().unwrap();
        let mut seeded = flow.clone();
        seeded["auth"] = json!({ "access_token": "tok-o", "account_id": "acct-1" });
        seeded["forcedAuth"] = Value::Null;
        let rig = rig(&seeded);
        let revision = format!("v1:{}", "a".repeat(64));
        let got = rig.usage.consume_codex_reset_credit("acct-1", &revision, flow["key"].as_str().unwrap()).await;
        assert_wire(at, &rig, flow);
        match (got, flow.get("error")) {
            (Ok(done), None) => assert_eq!(Value::String(done.outcome.to_owned()), flow["value"], "{at}"),
            (Err(error), Some(want)) => assert_eq!(error.message, want.as_str().unwrap(), "{at}"),
            (other, _) => panic!("{at}: {other:?}"),
        }
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

/// The OAuth usage reads are `AbortSignal.timeout` fetches (`sites.oauthUsage`, `oauth-usage.mjs:247`): the read ends at
/// Node's window with the signal's own text.
#[tokio::test(start_paused = true)]
async fn an_oauth_usage_read_ends_as_nodes_does_when_its_timer_fires() {
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

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
    assert_transport("oauthUsage", &transport);
    assert_thrown("oauthUsage", &error.message);
}
/// The OpenCode Go status read is a bare `AbortController` timer (`sites.opencodeGoUsage`).
#[tokio::test(start_paused = true)]
async fn the_opencode_go_status_read_ends_as_nodes_does_when_its_timer_fires() {
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let transport = TimingOut::new();
    let source = ProviderUsageSource::new(store, transport.clone());
    let credentials = serde_json::from_value(json!({ "access_token": "a", "refresh_token": "r", "org_id": "o" })).unwrap();
    let error = source.opencode_status(&credentials).await.expect_err("never answers");
    assert_transport("opencodeGoUsage", &transport);
    assert_thrown("opencodeGoUsage", &error.message);
}

#[tokio::test]
async fn a_provider_without_a_signed_in_credential_fails_and_one_without_usage_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let source = ProviderUsageSource::new(store, Net::from(&json!([])));
    for provider in ["openai-oauth", "anthropic-oauth", "grok-oauth"] {
        assert!(source.ensure_auth(provider, "default", false).await.is_err(), "{provider}");
    }
    assert!(source.ensure_auth("cursor-oauth", "default", false).await.unwrap().is_none());
    assert!(source.provider_snapshot("cursor-oauth", "default").await.is_err());
}
