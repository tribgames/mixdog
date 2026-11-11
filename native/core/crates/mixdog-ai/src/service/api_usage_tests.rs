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
use crate::transport::Redirect;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/api-usage/golden.json");

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

/// The API-key lookups are bare `fetch` calls under an `AbortController` timer (`sites.apiUsage`, `api-usage.mjs:82`).
#[tokio::test(start_paused = true)]
async fn a_lookup_ends_as_nodes_does_when_its_timer_fires() {
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

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
    assert_transport("apiUsage", &transport);
    assert_thrown("apiUsage", &error.message);
}

#[tokio::test]
async fn the_lookups_are_nodes_api_usage() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let now = Arc::new(AtomicI64::new(golden["now"].as_i64().unwrap()));
    let flows = golden["flows"].as_array().unwrap();
    assert!(flows.len() >= 75);
    // The key-precedence cases: several env names at once, remote-client mode, the session key.
    assert!(flows.iter().any(|f| f["name"].as_str().unwrap().starts_with("session key: remote-client")));
    let mut ops_checked = 0;
    for flow in flows {
        let name = flow["name"].as_str().unwrap();
        now.store(golden["now"].as_i64().unwrap(), Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        if !flow["seed"].is_null() {
            write_file(&dir.path().join("api-usage-cache.json"), flow["seed"].to_string().as_bytes());
        }
        let vault = Arc::new(MemoryVault::default());
        for (account, value) in flow["secrets"].as_object().unwrap() {
            vault.set(account, value.as_str().unwrap()).await.unwrap();
        }
        let env: Arc<dyn Environment> = Arc::new(Env(flow["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()));
        let replies = flow["replies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Reply {
                url: r["url"].as_str().unwrap().to_owned(),
                status: r["status"].as_u64().unwrap_or(200) as u16,
                text: r["text"].as_str().map_or_else(|| r["body"].to_string(), str::to_owned),
                fail: r["fail"] == true,
                used: false,
            })
            .collect();
        let net = Arc::new(Net { replies: Mutex::new(replies), seen: Mutex::default() });
        let tokens = mixdog_rt::testing::tokens();
        let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let clock = now.clone();
        let service = ApiUsageService::new(
            Arc::new(RoutedUsageHttp::following(net.clone())),
            // `MIXDOG_MODEL_PROXY=client` of the flow: a remote-client server holds no agent key (and no other guard).
            ApiKeyStore::new(vault.clone(), env.clone(), flow["remote"] == true),
            vault,
            env,
            io(),
            dir.path().to_path_buf(),
            Arc::new(move || clock.load(Ordering::SeqCst)),
        );
        let provider = flow["provider"].as_str().unwrap();
        for op in flow["ops"].as_array().unwrap() {
            let at = format!("{name} / {}", op["op"]);
            match op["op"].as_str().unwrap() {
                "advance" => {
                    now.fetch_add(op["ms"].as_i64().unwrap(), Ordering::SeqCst);
                    continue;
                }
                "fetch" => {
                    let before = net.seen.lock().unwrap().len();
                    let got = service.fetch(provider, op["force"] == true).await;
                    let seen = net.seen.lock().unwrap();
                    let wire = op["wire"].as_array().unwrap();
                    assert_eq!(seen.len() - before, wire.len(), "{at}: requests {:?}", seen[before..].iter().map(|(r, _)| &r.url).collect::<Vec<_>>());
                    for ((got, exchange), want) in seen[before..].iter().zip(wire) {
                        assert_eq!((got.url.as_str(), got.method.as_str()), (want["url"].as_str().unwrap(), want["method"].as_str().unwrap()), "{at}");
                        let headers: Vec<(String, String)> = want["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect();
                        assert_eq!(got.headers, headers, "{at}: headers");
                        // Node's bare `fetch`: redirects followed, 6.5 s over head and body.
                        assert_eq!(exchange.redirect, Redirect::Follow, "{at}");
                        assert_eq!(exchange.liveness.total_deadline(), Some(Duration::from_millis(6_500)), "{at}");
                    }
                    match (got, op.get("error")) {
                        (Ok(value), None) => assert_eq!(value.unwrap_or(Value::Null), op["value"], "{at}"),
                        (Err(error), Some(want)) => {
                            assert_eq!(error.message, want["message"].as_str().unwrap(), "{at}");
                            assert_eq!(error.status.map(u64::from), want["status"].as_u64(), "{at}: status");
                        }
                        (got, want) => panic!("{at}: {got:?} against {want:?}"),
                    }
                }
                _ => {
                    let allow_stale = op.get("allowStale").is_none_or(|stale| stale != false);
                    let got = service.cached(provider, allow_stale).await.unwrap_or(Value::Null);
                    assert_eq!(got, op["value"], "{at}");
                }
            }
            ops_checked += 1;
        }
        // The cache file the run left.
        let stored = read_file(&dir.path().join("api-usage-cache.json")).map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap());
        match (&stored, flow["stored"].is_null()) {
            (None, true) => {}
            (Some(stored), false) => {
                let mut want = flow["stored"].clone();
                // `updatedAt` is the clock of the last write.
                let mut got = stored.clone();
                for doc in [&mut want, &mut got] {
                    if let Some(map) = doc.as_object_mut() {
                        map.shift_remove("updatedAt");
                    }
                }
                assert_eq!(got, want, "{name}: cache file");
            }
            other => panic!("{name}: cache file {other:?}"),
        }
    }
    assert!(ops_checked >= 90, "{ops_checked}");
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
fn on_lane<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
    use futures::FutureExt as _;
    use mixdog_rt::LaneToken as _;
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

fn write_file(path: &std::path::Path, body: &[u8]) {
    let (path, body) = (path.to_owned(), body.to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())).unwrap();
}

fn read_file(path: &std::path::Path) -> Option<Vec<u8>> {
    mixdog_statefile::read_content(path).unwrap()
}
