//! `anthropic-api-key-fetch.test.mjs` and `lib/sse-framing.test.mjs`: Node's recorded sends and frames
//! (`fixtures/anthropic-request-gzip/golden.json`, `benchmarks/rust-core/recorders/record-anthropic-request-gzip.mjs`)
//! against the API-key adapter's `attempt` (its `post` compression, plain resend and process latch) and the
//! Anthropic decoder's SSE framing.

use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::providers::anthropic::{AnthropicAdapter, AnthropicCodec, AnthropicConfig, ApiKeySource, Flavor, ModelCaps};
use mixdog_ai::transport::{BodyStream, Exchange, HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{
    Content, Message, ModelRequest, ProviderAdapter, ProviderError, RequestOptions, Role, StreamEvent, TransportFault, WireCodec, WireRequest,
};
use serde_json::{Value, json};

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/anthropic-request-gzip/golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden")).expect("json")
}

struct Empty;
#[async_trait]
impl BodyStream for Empty {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        None
    }
}

/// The base fetch of Node's test: every send logged, answered with the scenario's next status.
struct Wire {
    statuses: Mutex<VecDeque<u16>>,
    sent: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        // A send past the recorded ones is answered and shows up in the compared sends.
        let status = self.statuses.lock().unwrap().pop_front().unwrap_or(200);
        Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Empty) })
    }
}

struct Key;
#[async_trait]
impl ApiKeySource for Key {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("fixture-key-not-a-credential".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.key().await
    }
}

fn config(base: &str, extra_headers: &Value) -> AnthropicConfig {
    let mut config = AnthropicConfig::new(Arc::new(|_: &str| Some(ModelCaps::default())));
    config.base_url = base.to_owned();
    if let Some(headers) = extra_headers.as_object() {
        config.extra_headers = headers.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
    }
    config
}

/// The test's two body sizes: a 16 KiB message, and a tiny one.
fn request(size: &str) -> ModelRequest {
    let text = if size == "large" { "x".repeat(16 * 1024) } else { "hi".to_owned() };
    ModelRequest {
        model: "claude-sonnet-4-6".into(),
        messages: vec![Message::new(Role::User, Content::Text(text))],
        tools: Vec::new(),
        options: RequestOptions::default(),
    }
}

fn header<'a>(request: &'a WireRequest, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|h| h.0.eq_ignore_ascii_case(name)).map(|h| h.1.as_str())
}

/// A send as Node's recorder describes it: its `Content-Encoding` and whether its body is the request's bytes
/// gzipped or as they are.
fn described(sent: &WireRequest, raw: &[u8]) -> Value {
    let body = if sent.body == raw {
        "plain"
    } else {
        let mut out = Vec::new();
        match flate2::read::GzDecoder::new(sent.body.as_slice()).read_to_end(&mut out) {
            Ok(_) if out == raw => "gzip",
            _ => "other",
        }
    };
    json!({ "encoding": header(sent, "content-encoding"), "body": body })
}

fn adapter(base: &str, scenario: &Value, wire: Arc<Wire>) -> AnthropicAdapter {
    let env = scenario["env"].as_str().map(str::to_owned);
    let settings: mixdog_ai::transport::preconnect::Setting =
        Arc::new(move |name: &str| if name == "MIXDOG_ANTHROPIC_REQ_GZIP" { env.clone() } else { None });
    AnthropicAdapter::api_key(config(base, &scenario["extraHeaders"]), wire, Arc::new(Key), mixdog_rt::testing::tokens().cpu_bulk)
        .with_settings(settings)
}

/// Whether the process latch is set: a large official send with no kill switch then goes out plain.
async fn latched() -> bool {
    let wire = Arc::new(Wire { statuses: Mutex::default(), sent: Mutex::default() });
    let probe = adapter("https://api.anthropic.com", &json!({}), wire.clone());
    let _ = probe.attempt(Arc::new(request("large"))).await;
    let sent = wire.sent.lock().unwrap();
    header(&sent[0], "content-encoding").is_none()
}

#[tokio::test]
async fn the_api_key_sends_compress_as_in_node() {
    let golden = golden();
    let scenarios = golden["gzip"].as_array().unwrap();
    for scenario in scenarios {
        // `anthropicGzipLatch.reset()` before each case, as the test's `beforeEach`.
        mixdog_ai::reset_process_state();
        let statuses = scenario["statuses"].as_array().unwrap().iter().map(|s| s.as_u64().unwrap() as u16).collect();
        let wire = Arc::new(Wire { statuses: Mutex::new(statuses), sent: Mutex::default() });
        let mut sends = Vec::new();
        for send in scenario["sends"].as_array().unwrap() {
            let base = send["base"].as_str().unwrap();
            let size = send["size"].as_str().unwrap();
            let adapter = adapter(base, scenario, wire.clone());
            let request = request(size);
            let raw = adapter.codec().encode(&request).expect("the request encodes").body;
            let before = wire.sent.lock().unwrap().len();
            let _ = adapter.attempt(Arc::new(request)).await;
            let sent: Vec<Value> = wire.sent.lock().unwrap()[before..].iter().map(|s| described(s, &raw)).collect();
            let status = scenario["statuses"][before + sent.len() - 1].clone();
            sends.push(json!({ "base": base, "size": size, "status": status, "sent": sent }));
        }
        let got = json!({
            "name": scenario["name"], "env": scenario["env"], "extraHeaders": scenario["extraHeaders"],
            "statuses": scenario["statuses"], "sends": sends, "latched": latched().await,
        });
        assert_eq!(&got, scenario, "{}", scenario["name"]);
    }
    mixdog_ai::reset_process_state();
    assert_eq!(scenarios.len(), 8);
}

/// The region that opens the text block the recorded deltas write to: the decoder drops a delta of no open block.
const OPEN: &str = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n";

#[test]
fn the_decoder_frames_the_regions_as_node() {
    let golden = golden();
    let codec = AnthropicCodec::new(Flavor::ApiKey, config("https://api.anthropic.com", &Value::Null));
    let mut decoder = codec.decoder(&request("small"));
    decoder.feed(OPEN.as_bytes()).expect("the block opens");
    let regions = golden["framing"].as_array().unwrap();
    for region in regions {
        let texts: Vec<String> = decoder
            .feed(region["region"].as_str().unwrap().as_bytes())
            .expect("the region decodes")
            .into_iter()
            .filter_map(|e| match e {
                StreamEvent::TextDelta(text) => Some(text),
                _ => None,
            })
            .collect();
        let node: Vec<String> = region["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["value"]["delta"]["text"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(texts, node, "{}", region["region"]);
    }
    assert_eq!(regions.len(), 3);
}
