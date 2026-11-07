//! The Muse Code plan usage against Node's own provider (`record-muse-code-usage.mjs`): the key
//! request, the windows read from `subs_usage`, the payload validation, and the cooldown and last good
//! reading bound to the signed-in credential, over the same scripted network and stepped clock.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::super::oauth_usage::UsageSource;
use super::super::usage_ports::ProviderUsageSource;
use super::*;
use crate::accounts::AccountStore;
use crate::oauth::CredentialIo;
use crate::oauth::pace::FakePace;
use crate::transport::Exchange;
use crate::transport::Redirect;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

const GOLDEN: &str = include_str!("../../../../fixtures/muse-code-usage/golden.json");

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

struct Reply {
    status: u16,
    text: String,
    fail: bool,
}

/// The scripted network: each request takes the next reply; none left is a connection that never opens.
struct Net {
    replies: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<(WireRequest, Exchange)>>,
}

#[async_trait]
impl HttpSend for Net {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push((request, exchange));
        match self.replies.lock().unwrap().pop_front() {
            Some(reply) if !reply.fail => Ok(HttpResponse { status: reply.status, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from(reply.text)))) }),
            _ => Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent)),
        }
    }
}

#[tokio::test]
async fn the_key_read_is_nodes_get_usage_snapshot() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let start = golden["now"].as_u64().unwrap();
    let flows = golden["flows"].as_array().unwrap();
    assert!(flows.len() >= 48);
    let mut snapshots = 0;
    for flow in flows {
        let name = flow["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let store = AccountStore::new(dir.path().to_path_buf(), io());
        let file = store.credential_file(PROVIDER_ID, "default").unwrap();
        create_dir(file.path().parent().unwrap());
        if !flow["creds"].is_null() {
            write_file(file.path(), flow["creds"].to_string().as_bytes());
        }
        let replies = flow["replies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Reply { status: r["status"].as_u64().unwrap_or(200) as u16, text: r["text"].as_str().map_or_else(|| r["body"].to_string(), str::to_owned), fail: r["fail"] == true })
            .collect();
        let net = Arc::new(Net { replies: Mutex::new(replies), seen: Mutex::default() });
        let pace = Arc::new(FakePace::default());
        pace.now.store(start, Ordering::SeqCst);
        // `Math.random()` is 0.5: the cooldown is exactly five minutes.
        let source = ProviderUsageSource::with_pace(store, net.clone(), pace.clone()).with_jitter(Arc::new(|| 0.5));
        for op in flow["ops"].as_array().unwrap() {
            let at = format!("{name} / {}", op["op"]);
            match op["op"].as_str().unwrap() {
                "advance" => {
                    pace.now.fetch_add(op["ms"].as_u64().unwrap(), Ordering::SeqCst);
                }
                "login" => write_file(file.path(), op["creds"].to_string().as_bytes()),
                "logout" => {
                    remove_file(file.path());
                }
                _ => {
                    let before = net.seen.lock().unwrap().len();
                    let got = source.provider_snapshot(PROVIDER_ID, "default").await;
                    let seen = net.seen.lock().unwrap();
                    let wire = op["wire"].as_array().unwrap();
                    assert_eq!(seen.len() - before, wire.len(), "{at}: requests");
                    for ((request, exchange), want) in seen[before..].iter().zip(wire) {
                        assert_eq!((request.url.as_str(), request.method.as_str()), (want["url"].as_str().unwrap(), want["method"].as_str().unwrap()), "{at}");
                        let headers: Vec<(String, String)> = want["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect();
                        assert_eq!(request.headers, headers, "{at}: headers");
                        assert_eq!(String::from_utf8_lossy(&request.body), want["body"].as_str().unwrap(), "{at}: body");
                        assert_eq!(exchange.redirect, Redirect::Error, "{at}");
                        assert_eq!(exchange.liveness.total_deadline(), Some(Duration::from_millis(want["timeoutMs"].as_u64().unwrap())), "{at}");
                    }
                    match (got, op.get("error")) {
                        (Ok(value), None) => assert_eq!(value.unwrap_or(Value::Null), op["value"], "{at}"),
                        (Err(error), Some(want)) => {
                            assert_eq!(error.message, want["message"].as_str().unwrap(), "{at}");
                            assert_eq!(error.status.map(u64::from), want["status"].as_u64(), "{at}: status");
                        }
                        (got, want) => panic!("{at}: {got:?} against {want:?}"),
                    }
                    snapshots += 1;
                }
            }
        }
    }
    assert!(snapshots >= 70, "{snapshots}");
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

fn create_dir(path: &std::path::Path) {
    let path = path.to_owned();
    on_lane(move |lane| mixdog_statefile::create_private_dir_all(lane, &path)).unwrap();
}

fn remove_file(path: &std::path::Path) {
    let path = path.to_owned();
    let _ = on_lane(move |lane| mixdog_statefile::remove_file(lane, &path));
}
