//! The plumbing of the replays of the per-test-file provider recordings (`fixtures/provider-<set>/cases.json`, recorded by
//! `benchmarks/rust-core/recorders/lib/provider-case-recorder.mjs` from `b6f10295a`): a stand-in endpoint that answers each
//! request of a case with the reply Node's loopback endpoint gave the same request, keeps what the product sent, and the
//! whole comparison of those requests with the ones Node's endpoint received (method, origin, path, every header in
//! arrival order, body bytes). The three headers the SDK stack fills with the recording host's OS, architecture and
//! Node version are compared as the recorder's marker on both sides (declared in the sets' manifests).

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use crate::transport::BodyStream;
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use crate::transport::node_http::Writer;

/// The text of `<set>/cases.json`.
pub(crate) fn cases(text: &str) -> Value {
    serde_json::from_str(text).expect("cases.json")
}

/// Node's `undefined` (the recorder's `{"$exact": "undefined"}`) as an absent field, at every depth.
pub(crate) fn without_undefined(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| v.get("$exact").and_then(Value::as_str) != Some("undefined"))
                .map(|(k, v)| (k.clone(), without_undefined(v)))
                .collect(),
        ),
        Value::Array(list) => Value::Array(list.iter().map(without_undefined).collect()),
        other => other.clone(),
    }
}

struct Chunks(VecDeque<Bytes>);

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front().map(Ok)
    }
}

/// Answers the n-th request with the n-th recorded reply and keeps every request as the product's client writes it.
pub(crate) struct Capture {
    replies: Mutex<VecDeque<Value>>,
    pub sent: Mutex<Vec<(WireRequest, Writer)>>,
}

impl Capture {
    /// One answer per request of the case, in the order Node's endpoint received them.
    pub fn new(case: &Value) -> Arc<Self> {
        let replies = case["requests"].as_array().into_iter().flatten().map(|r| r["reply"].clone()).collect();
        Arc::new(Self { replies: Mutex::new(replies), sent: Mutex::default() })
    }

    /// Every request sent so far in Node's recorded form (see [`request_record`]).
    pub fn records(&self) -> Vec<Value> {
        self.sent.lock().unwrap().iter().map(|(request, writer)| request_record(request, *writer)).collect()
    }
}

#[async_trait]
impl HttpSend for Capture {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let url = request.url.clone();
        // The socket warm-up is a raw `undici.request` the recorder's endpoint never sees (declared in the manifests).
        if request.method == "HEAD" {
            return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Chunks(VecDeque::new())) });
        }
        self.sent.lock().unwrap().push((request, exchange.writer));
        let reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| panic!("Node's endpoint answered no request {url}"));
        let mut headers = vec![("content-type".to_owned(), reply["contentType"].as_str().unwrap_or("text/event-stream").to_owned())];
        for (name, value) in reply["headers"].as_object().into_iter().flatten() {
            headers.push((name.clone(), value.as_str().unwrap().to_owned()));
        }
        let chunks: VecDeque<Bytes> = match reply["chunks"].as_array() {
            Some(list) => list.iter().map(|c| Bytes::from(c.as_str().unwrap().to_owned())).collect(),
            None => VecDeque::from([Bytes::from(reply["body"].as_str().unwrap_or_default().to_owned())]),
        };
        Ok(HttpResponse { status: reply["status"].as_u64().unwrap_or(200) as u16, headers, body: Box::new(Chunks(chunks)) })
    }
}

/// The marker the recorder writes for a header that carries the recording host.
fn host_header(name: &str, value: String) -> String {
    let lower = name.to_ascii_lowercase();
    if matches!(lower.as_str(), "x-stainless-os" | "x-stainless-arch" | "x-stainless-runtime-version") {
        format!("<recording host {lower}>")
    } else {
        value
    }
}

/// The request as Node's endpoint recorded it: the head the product's HTTP client writes for the recorder's plain-http
/// loopback (undici's `accept-encoding` follows the scheme it dials), the origin the product addressed, the body text.
pub(crate) fn request_record(request: &WireRequest, writer: Writer) -> Value {
    let product = url::Url::parse(&request.url).unwrap();
    let mut dialed = product.clone();
    dialed.set_scheme("http").unwrap();
    let (head, _) = crate::transport::node_http::head(request, &dialed, writer);
    let head = String::from_utf8(head).unwrap();
    let mut lines = head.split("\r\n").filter(|l| !l.is_empty());
    let mut first = lines.next().unwrap().split(' ');
    let (method, path) = (first.next().unwrap(), first.next().unwrap());
    let headers: Vec<Value> = lines
        .map(|line| {
            let (name, value) = line.split_once(": ").unwrap();
            json!([name.to_ascii_lowercase(), host_header(name, value.to_owned())])
        })
        .collect();
    json!({"method": method, "origin": product.origin().ascii_serialization(), "path": path, "headers": headers,
           "body": String::from_utf8_lossy(&request.body)})
}

/// Node's recorded requests of the case, in the form of [`request_record`].
pub(crate) fn recorded_requests(case: &Value) -> Vec<Value> {
    case["requests"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            // The SDK writes its names capitalised (`User-Agent`); the product's client writes the SDK's spelling too (as the Anthropic head does), so both are compared in lower case, as every
            // other wire replay compares them (a header name is case-insensitive, its place and value are compared).
            let headers: Vec<Value> = r["headers"].as_array().unwrap().iter().map(|h| json!([h[0].as_str().unwrap().to_ascii_lowercase(), h[1]])).collect();
            json!({"method": r["method"], "origin": r["origin"], "path": r["path"], "headers": headers, "body": r["body"]})
        })
        .collect()
}

/// The requests the product sent are Node's, whole, in order and count.
pub(crate) fn assert_same_requests(capture: &Capture, case: &Value) {
    let id = case["id"].as_str().unwrap();
    let (core, node) = (capture.records(), recorded_requests(case));
    assert_eq!(core.len(), node.len(), "{id}: the number of requests");
    for (n, (core, node)) in core.iter().zip(&node).enumerate() {
        assert_eq!(core, node, "{id}: request {n}");
    }
}
