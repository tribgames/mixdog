//! The OpenCode Go plan usage against Node's own provider (`record-opencode-go-usage.mjs`): the
//! requests it puts on the wire (the status read and the refreshes), the meters it reads, the refresh
//! behind an expiring or rejected token, and each way the call fails.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

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

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/opencode-go-usage/golden.json");

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
/// is a connection that never opens.
struct Net {
    replies: Mutex<Vec<Reply>>,
    seen: Mutex<Vec<WireRequest>>,
    /// The deadline and redirect rule each request went out under.
    exchanges: Mutex<Vec<Exchange>>,
}

#[async_trait]
impl HttpSend for Net {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let url = request.url.clone();
        self.seen.lock().unwrap().push(request);
        self.exchanges.lock().unwrap().push(exchange);
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

fn without_fetched_at(mut snapshot: Value) -> Value {
    snapshot.as_object_mut().unwrap().shift_remove("fetchedAt");
    snapshot
}

#[tokio::test]
async fn the_status_read_is_nodes_get_usage_snapshot() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let now = golden["now"].as_u64().unwrap();
    let flows = golden["flows"].as_array().unwrap();
    assert!(flows.len() >= 30);
    for flow in flows {
        let name = flow["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let store = AccountStore::new(dir.path().to_path_buf(), io());
        let file = store.credential_file(PROVIDER_ID, "default").unwrap();
        if !flow["creds"].is_null() {
            create_dir(file.path().parent().unwrap());
            write_file(file.path(), flow["creds"].to_string().as_bytes());
        }
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
        let net = Arc::new(Net { replies: Mutex::new(replies), seen: Mutex::default(), exchanges: Mutex::default() });
        let pace = Arc::new(FakePace::default());
        pace.now.store(now, Ordering::SeqCst);
        let source = ProviderUsageSource::with_pace(store, net.clone(), pace);
        let got = source.provider_snapshot(PROVIDER_ID, "default").await;

        let seen = net.seen.lock().unwrap();
        let wire = flow["wire"].as_array().unwrap();
        assert_eq!(seen.len(), wire.len(), "{name}: requests {:?}", seen.iter().map(|r| &r.url).collect::<Vec<_>>());
        let exchanges = net.exchanges.lock().unwrap();
        for (i, (got, want)) in seen.iter().zip(wire).enumerate() {
            assert_eq!((got.url.as_str(), got.method.as_str()), (want["url"].as_str().unwrap(), want["method"].as_str().unwrap()), "{name}");
            let want_headers: Vec<(String, String)> = want["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect();
            if want["method"] == "GET" {
                assert_eq!(got.headers, want_headers, "{name}: status headers");
                // Node's status read: no redirect, 6.5 s over head and body.
                assert_eq!(exchanges[i].redirect, Redirect::Error, "{name}: redirect");
                assert_eq!(exchanges[i].liveness.total_deadline(), Some(std::time::Duration::from_millis(want["timeoutMs"].as_u64().unwrap())), "{name}: timeout");
            } else {
                // The refresh is the login flow's request: the same headers, spelled in lower case.
                let lower: Vec<(String, String)> = want_headers.into_iter().map(|(k, v)| (k.to_lowercase(), v)).collect();
                assert_eq!(got.headers, lower, "{name}: refresh headers");
                assert_eq!(String::from_utf8_lossy(&got.body), want["body"].as_str().unwrap(), "{name}: refresh body");
                assert_eq!(exchanges[i].redirect, Redirect::Error, "{name}: refresh redirect");
                // The Console''s own deadline (Node''s 20 s), not the token-exchange one.
                assert_eq!(exchanges[i].liveness.total_deadline(), Some(std::time::Duration::from_millis(want["timeoutMs"].as_u64().unwrap())), "{name}: refresh timeout");
            }
            assert_eq!(want["redirect"], "error", "{name}");
        }
        match (got, flow.get("error")) {
            (Ok(Some(snapshot)), None) => assert_eq!(without_fetched_at(snapshot), without_fetched_at(flow["snapshot"].clone()), "{name}"),
            (Err(error), Some(want)) => {
                assert_eq!(error.message, want["message"].as_str().unwrap(), "{name}");
                assert_eq!(error.status.map(u64::from), want["status"].as_u64(), "{name}: status");
            }
            (got, want) => panic!("{name}: {got:?} against {want:?}"),
        }
        // The stored sign-in after the run: a refresh rotated the pair, a failed one left it.
        if let Some(want) = flow["stored"].as_object() {
            let stored: Value = serde_json::from_slice(&read_file(file.path()).unwrap()).unwrap();
            for key in ["access_token", "refresh_token", "expires_at", "org_id", "org_name"] {
                assert_eq!(stored.get(key), want.get(key), "{name}: stored {key}");
            }
        }
    }
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

fn read_file(path: &std::path::Path) -> Option<Vec<u8>> {
    mixdog_statefile::read_content(path).unwrap()
}
