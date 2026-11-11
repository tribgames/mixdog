//! The Cursor plan-usage read against Node's own provider (`record-cursor-usage.mjs`): the two requests
//! it puts on the wire, what its protobuf codec makes of each scripted answer (well-formed, malformed,
//! enveloped), the rows `normalizeCursorUsage` builds, and each way a call fails.

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

use super::*;
use crate::transport::Exchange;
use crate::transport::Redirect;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/cursor-usage/golden.json");

/// The usage read that outlives its timer reads as the real Node call did (`sites.cursorUsageCall`): `callCursorUnary`'s own
/// timer, labelled `Cursor request`.
#[tokio::test(start_paused = true)]
async fn a_read_that_outlives_its_timer_reads_as_nodes() {
    use crate::transport::site_probe::{TimingOut, assert_thrown, assert_window};

    let transport = TimingOut::new();
    let reading = CursorUsage::new(PROVIDER_ID, transport.clone(), None, Live::from("1.0.0"), Arc::new(Token));
    let error = reading.read().await.expect_err("never answers");
    assert_window("cursorUsageCall", &transport);
    assert_thrown("cursorUsageCall", &error.message);
}

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// The scripted dashboard: each path is answered as the flow says; an unscripted path never connects.
struct Net {
    usage: Value,
    plan: Value,
    seen: Mutex<Vec<(WireRequest, Exchange)>>,
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

#[async_trait]
impl HttpSend for Net {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let answer = if request.url.ends_with(USAGE_PATH) { &self.usage } else { &self.plan };
        self.seen.lock().unwrap().push((request, exchange));
        if answer["reset"] == true {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
        }
        let headers = answer["headers"].as_object().map_or_else(Vec::new, |h| h.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect());
        let status = answer["status"].as_u64().unwrap_or(200) as u16;
        Ok(HttpResponse { status, headers, body: Box::new(Body(Some(Bytes::from(unhex(answer["hex"].as_str().unwrap_or("")))))) })
    }
}

struct Token;

#[async_trait]
impl AccessToken for Token {
    async fn access_token(&self, _force_refresh: bool) -> Result<String, ProviderError> {
        Ok("cursor-token-1".to_owned())
    }
}

#[tokio::test]
async fn the_plan_usage_read_is_nodes_get_usage_snapshot() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let version = golden["clientVersion"].as_str().unwrap().to_owned();
    let flows = golden["flows"].as_array().unwrap();
    assert!(flows.len() >= 50);
    for flow in flows {
        let name = flow["name"].as_str().unwrap();
        let net = Arc::new(Net { usage: flow["usage"].clone(), plan: flow["plan"].clone(), seen: Mutex::default() });
        let reading = CursorUsage::new(PROVIDER_ID, net.clone(), None, Live::from(version.as_str()), Arc::new(Token));
        let got = reading.read().await;

        // The two calls run together: their order on the wire is not a fact.
        let mut seen: Vec<_> = net.seen.lock().unwrap().iter().map(|(r, e)| (r.clone(), *e)).collect();
        seen.sort_by(|a, b| a.0.url.cmp(&b.0.url));
        let wire = flow["seen"].as_array().unwrap();
        assert_eq!(seen.len(), wire.len(), "{name}");
        for ((request, exchange), want) in seen.iter().zip(wire) {
            assert_eq!(request.url, format!("{API_URL}{}", want["path"].as_str().unwrap()), "{name}");
            assert_eq!(request.method, want["method"].as_str().unwrap(), "{name}");
            assert_eq!(request.body.len() as u64, want["bodyBytes"].as_u64().unwrap(), "{name}: body");
            let mut headers = request.headers.clone();
            for header in &mut headers {
                if header.0 == "x-request-id" {
                    header.1 = "<uuid>".to_owned();
                }
            }
            let want_headers: Vec<(String, String)> = want["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect();
            assert_eq!(headers, want_headers, "{name}: headers");
            assert_eq!(exchange.redirect, Redirect::Manual, "{name}");
            assert_eq!(exchange.liveness.total_deadline(), Some(std::time::Duration::from_secs(5)), "{name}: timeout");
        }
        match (got, flow.get("error")) {
            (Ok(snapshot), None) => assert_eq!(snapshot, flow["snapshot"], "{name}"),
            (Err(error), Some(want)) => {
                assert_eq!(error.message, want["message"].as_str().unwrap(), "{name}");
                assert_eq!(error.status.map(u64::from), want["status"].as_u64(), "{name}: status");
            }
            (got, want) => panic!("{name}: {got:?} against {want:?}"),
        }
    }
}
