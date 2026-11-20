//! The API-key balance lookups against Node's own module (`record-api-usage.mjs`): every request each
//! lookup puts on the wire, what it makes of the answer, the cache file it keeps and its 5-minute /
//! 1-hour freshness, over the same scripted network, environment, keychain and clock.

use std::collections::HashMap;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;

use super::super::usage_ports::RoutedUsageHttp;
use super::*;
use crate::registry::keys::MemoryVault;
use crate::transport::Exchange;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;
use serde_json::json;

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
    text: String,
    fail: bool,
    used: bool,
}

/// The scripted network: a request is answered by the first unused reply for its URL; anything else
/// is a connection that never opens. Replies stay consumed across a flow's operations.
struct Net {
    replies: Mutex<Vec<Reply>>,
    seen: Mutex<Vec<(WireRequest, Exchange)>>,
}

#[async_trait]
impl HttpSend for Net {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let url = request.url.clone();
        self.seen.lock().unwrap().push((request, exchange));
        let mut replies = self.replies.lock().unwrap();
        match replies.iter_mut().find(|r| r.url == url && !r.used) {
            Some(reply) => {
                reply.used = true;
                if reply.fail {
                    return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
                }
                Ok(HttpResponse { status: reply.status, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from(reply.text.clone())))) })
            }
            None => Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent)),
        }
    }
}

struct Env(HashMap<String, String>);

impl Environment for Env {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

#[test]
fn money_reads_text_numbers_and_nested_forms() {
    let money = |v: Value| money_number(Some(&v));
    assert_eq!(money(serde_json::json!("$1,234.50")), Some(1234.5));
    assert_eq!(money(serde_json::json!({ "cents": 250 })), Some(2.5));
    assert_eq!(money(serde_json::json!({ "balance": { "usd": " 7.5 " } })), Some(7.5));
    assert_eq!(money(serde_json::json!({ "usd": 0, "cents": 5 })), Some(0.0));
    assert_eq!(money(serde_json::json!("many")), None);
    assert_eq!(money(serde_json::json!(true)), None);
}

// Test files go through the durability lane and `mixdog_statefile`, as the tree's other tests do.

/// An API-key lookup that outlives its timer ends 6.5 s in, with the text of an aborted request.
#[tokio::test(start_paused = true)]
async fn a_lookup_that_is_never_answered_ends_after_six_and_a_half_seconds() {
    use crate::transport::site_probe::TimingOut;

    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    let env: Arc<dyn Environment> =
        Arc::new(Env(HashMap::from([("XAI_MANAGEMENT_API_KEY".to_owned(), "k".to_owned()), ("XAI_TEAM_ID".to_owned(), "t".to_owned())])));
    let tokens = mixdog_rt::testing::tokens();
    let transport = TimingOut::new();
    let service = ApiUsageService::new(
        Arc::new(RoutedUsageHttp::following(transport.clone())),
        ApiKeyStore::new(vault.clone(), env.clone(), false),
        vault,
        env,
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        dir.path().to_path_buf(),
        Arc::new(|| 0),
    );
    let error = service.fetch("xai", true).await.err().expect("never answers");
    let seen = transport.seen();
    assert_eq!(seen[0].after, std::time::Duration::from_millis(6500));
    assert_eq!((seen[0].text.as_str(), error.message.as_str()), ("This operation was aborted", "This operation was aborted"));
}

// the lookups over a scripted network

const DEEPSEEK_URL: &str = "https://api.deepseek.com/user/balance";
const BALANCE: &str = r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"1.00"},{"currency":"USD","total_balance":"12.34567"}]}"#;

fn reply(status: u16, text: &str) -> Reply {
    Reply { url: DEEPSEEK_URL.to_owned(), status, text: text.to_owned(), fail: false, used: false }
}

struct Lookups {
    service: ApiUsageService,
    net: Arc<Net>,
    now: Arc<AtomicI64>,
    _dir: tempfile::TempDir,
}

fn lookups(replies: Vec<Reply>, env: &[(&str, &str)]) -> Lookups {
    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    let env: Arc<dyn Environment> = Arc::new(Env(env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()));
    let net = Arc::new(Net { replies: Mutex::new(replies), seen: Mutex::default() });
    let tokens = mixdog_rt::testing::tokens();
    let now = Arc::new(AtomicI64::new(1_700_000_000_000));
    let clock = now.clone();
    let service = ApiUsageService::new(
        Arc::new(RoutedUsageHttp::following(net.clone())),
        ApiKeyStore::new(vault.clone(), env.clone(), false),
        vault,
        env,
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        dir.path().to_path_buf(),
        Arc::new(move || clock.load(Ordering::SeqCst)),
    );
    Lookups { service, net, now, _dir: dir }
}

impl Lookups {
    fn asked(&self) -> usize {
        self.net.seen.lock().unwrap().len()
    }
}

const KEY: [(&str, &str); 1] = [("DEEPSEEK_API_KEY", "deepseek-test-key")];

#[tokio::test]
async fn a_deepseek_lookup_sends_the_key_and_reports_the_dollar_balance_to_four_places() {
    let l = lookups(vec![reply(200, BALANCE)], &KEY);
    let snapshot = l.service.fetch("deepseek", false).await.unwrap().expect("a snapshot");
    assert_eq!(snapshot["balance"]["remainingUsd"], 12.3457);
    assert_eq!((snapshot["balance"]["currency"].clone(), snapshot["available"].clone()), (json!("USD"), json!(true)));
    let seen = l.net.seen.lock().unwrap();
    let (request, exchange) = &seen[0];
    let bearer = request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.as_str());
    assert_eq!(bearer, Some("Bearer deepseek-test-key"));
    assert_eq!(exchange.liveness.total_deadline(), Some(Duration::from_millis(6_500)));
}

#[tokio::test]
async fn a_provider_without_a_key_has_no_snapshot_and_asks_nobody() {
    let l = lookups(vec![reply(200, BALANCE)], &[]);
    assert_eq!(l.service.fetch("deepseek", false).await.unwrap(), None);
    assert_eq!(l.asked(), 0);
}

#[tokio::test]
async fn a_snapshot_is_served_from_the_cache_for_five_minutes_and_a_forced_lookup_asks_again() {
    let l = lookups(vec![reply(200, BALANCE), reply(200, BALANCE), reply(200, BALANCE)], &KEY);
    l.service.fetch("deepseek", false).await.unwrap();
    l.now.fetch_add(5 * 60_000, Ordering::SeqCst);
    l.service.fetch("deepseek", false).await.unwrap();
    assert_eq!(l.asked(), 1, "exactly five minutes old is still live");
    l.now.fetch_add(1, Ordering::SeqCst);
    l.service.fetch("deepseek", false).await.unwrap();
    assert_eq!(l.asked(), 2, "a millisecond older is asked again");
    l.service.fetch("deepseek", true).await.unwrap();
    assert_eq!(l.asked(), 3, "force skips the cache");
}

#[tokio::test]
async fn a_stale_snapshot_is_still_offered_for_an_hour_when_staleness_is_allowed() {
    let l = lookups(vec![reply(200, BALANCE)], &KEY);
    l.service.fetch("deepseek", false).await.unwrap();
    l.now.fetch_add(30 * 60_000, Ordering::SeqCst);
    assert!(l.service.cached("deepseek", false).await.is_none());
    assert!(l.service.cached("deepseek", true).await.is_some());
    l.now.fetch_add(31 * 60_000, Ordering::SeqCst);
    assert!(l.service.cached("deepseek", true).await.is_none(), "an hour is the limit");
}

#[tokio::test]
async fn a_refusal_reads_as_an_unavailable_snapshot_that_is_not_cached() {
    let l = lookups(vec![reply(401, r#"{"error":{"message":"bad key"}}"#), reply(401, r#"{"error":{"message":"bad key"}}"#)], &KEY);
    let snapshot = l.service.fetch("deepseek", false).await.unwrap().expect("a snapshot");
    assert_eq!(snapshot["unavailable"]["status"], 401);
    assert_eq!(snapshot["unavailable"]["message"], "bad key");
    l.service.fetch("deepseek", false).await.unwrap();
    assert_eq!(l.asked(), 2, "an unavailable answer is asked again");
}

#[tokio::test]
async fn any_other_failure_is_the_callers_error() {
    let l = lookups(vec![reply(500, "{}")], &KEY);
    let error = l.service.fetch("deepseek", false).await.expect_err("a server error");
    assert_eq!((error.message.as_str(), error.status), ("usage fetch failed (500)", Some(500)));
}
