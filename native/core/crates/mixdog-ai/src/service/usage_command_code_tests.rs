//! The command-code plan usage against Node's own provider (`record-command-code-usage.mjs`): the
//! request it puts on the wire, the windows it reads, and each way the call fails.

use std::sync::Arc;
use std::sync::Mutex;

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
use crate::transport::Exchange;
use crate::transport::Redirect;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

const GOLDEN: &str = include_str!("../../../../fixtures/command-code-usage/golden.json");

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// The one scripted answer of a flow, and the requests it saw.
struct Net {
    status: u16,
    text: String,
    fail: bool,
    seen: Mutex<Vec<WireRequest>>,
    /// The deadline and redirect rule each request went out under.
    exchanges: Mutex<Vec<Exchange>>,
}

#[async_trait]
impl HttpSend for Net {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        self.exchanges.lock().unwrap().push(exchange);
        if self.fail {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
        }
        Ok(HttpResponse { status: self.status, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from(self.text.clone())))) })
    }
}

fn without_fetched_at(snapshot: Option<Value>) -> Option<Value> {
    snapshot.map(|mut snapshot| {
        snapshot.as_object_mut().unwrap().shift_remove("fetchedAt");
        snapshot
    })
}

#[tokio::test]
async fn the_credits_read_is_nodes_get_usage_snapshot() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let flows = golden["flows"].as_array().unwrap();
    assert!(flows.len() >= 30);
    for flow in flows {
        let name = flow["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let store = AccountStore::new(dir.path().to_path_buf(), io());
        if !flow["creds"].is_null() {
            let file = store.credential_file(PROVIDER_ID, "default").unwrap();
            create_dir(file.path().parent().unwrap());
            write_file(file.path(), flow["creds"].to_string().as_bytes());
        }
        let reply = &flow["reply"];
        let net = Arc::new(Net { status: reply["status"].as_u64().unwrap() as u16, text: reply["text"].as_str().unwrap_or("").to_owned(), fail: reply["fail"] == true, seen: Mutex::default(), exchanges: Mutex::default() });
        let source = ProviderUsageSource::new(store, net.clone());
        let got = source.provider_snapshot(PROVIDER_ID, "default").await;

        let seen = net.seen.lock().unwrap();
        let wire = flow["wire"].as_array().unwrap();
        assert_eq!(seen.len(), wire.len(), "{name}: requests");
        for (got, want) in seen.iter().zip(wire) {
            assert_eq!((got.url.as_str(), got.method.as_str()), (want["url"].as_str().unwrap(), want["method"].as_str().unwrap()), "{name}");
            let headers: Vec<(String, String)> = want["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect();
            assert_eq!(got.headers, headers, "{name}: headers");
            assert_eq!(want["redirect"], "error", "{name}");
        }
        for (got, want) in net.exchanges.lock().unwrap().iter().zip(wire) {
            assert_eq!(got.redirect, Redirect::Error, "{name}: redirect");
            assert_eq!(got.liveness.total_deadline(), Some(std::time::Duration::from_millis(want["timeoutMs"].as_u64().unwrap())), "{name}: timeout");
        }
        match (got, flow.get("error")) {
            (Ok(snapshot), None) => assert_eq!(without_fetched_at(snapshot), without_fetched_at(Some(flow["snapshot"].clone()).filter(|s| !s.is_null())), "{name}"),
            (Err(error), Some(want)) => {
                assert_eq!(error.message, want["message"].as_str().unwrap(), "{name}");
                assert_eq!(error.status.map(u64::from), want["status"].as_u64(), "{name}: status");
            }
            (got, want) => panic!("{name}: {got:?} against {want:?}"),
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
