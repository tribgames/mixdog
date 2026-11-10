//! The subscription route's whole request sequence against Node's recording
//! (`fixtures/wire-anthropic-gemini/anthropic.json`, recorded by
//! `benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs` from `AnthropicOAuthProvider.send`
//! with the network replaced by a recorder, at `b6f10295a`): per model family a first turn, a tool-result
//! turn, a long thread, a resumed and a compacted thread, tail reminders, and the requests Node never
//! threads. Each send's requests (url, every header, the whole body with a gzip body decoded) are
//! compared with what `AnthropicAdapter::attempt` puts on the wire when the recorded answers come back;
//! the model's capabilities are an input: what Node's capability functions answered for a catalog that lists the
//! models by id (`capabilities` in the recording), which the product's `CatalogCaps` reproduces
//! (`mixdog-core` `the_anthropic_wire_models_get_nodes_catalog_answers`); no body field is read for them.

use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use flate2::read::GzDecoder;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use tokio::sync::oneshot;
use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::AnthropicAdapter;
use super::AnthropicConfig;
use super::ModelCaps;
use super::effort_tests::tool_of;
use super::tests::MemoryStore;
use super::tests::cpu_bulk;
use crate::transport::BodyStream;
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
pub(crate) fn recording(file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire-anthropic-gemini").join(file);
    let text = std::fs::read_to_string(path).expect("recorded scenarios");
    mixdog_js::fixture_tools::parse_golden(&text).expect("json")
}

fn message_of(recorded: &Value) -> Message {
    let role = match recorded["role"].as_str().expect("role") {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("{other}"),
    };
    let mut message = Message::new(role, Content::Text(recorded["content"].as_str().expect("content").into()));
    message.cache_tier = match recorded["cacheTier"].as_str() {
        Some("tier3") => Some(CacheTier::Tier3),
        Some("env") => Some(CacheTier::Env),
        _ => None,
    };
    for call in recorded["toolCalls"].as_array().into_iter().flatten() {
        message.tool_calls.push(ToolCall {
            id: call["id"].as_str().expect("id").into(),
            name: call["name"].as_str().expect("name").into(),
            arguments: call["arguments"].clone(),
            native_type: None,
        });
    }
    message.tool_call_id = recorded["toolCallId"].as_str().map(str::to_owned);
    if recorded["meta"]["source"] == "tail-reminder" {
        message.source = Some(MessageSource::TailReminder);
    }
    message.turn_reminder = recorded["turnReminder"].as_str().map(str::to_owned);
    message.assistant_blocks = recorded.get("assistantBlocks").filter(|blocks| !blocks.is_null()).cloned();
    message
}

fn options_of(recorded: &Value) -> RequestOptions {
    RequestOptions {
        session_id: recorded["sessionId"].as_str().map(str::to_owned),
        request_kind: recorded["requestKind"].as_str().map(str::to_owned),
        shared_cache_prefix_count: recorded["sharedCachePrefixCount"].as_u64().map(|count| count as usize),
        ..RequestOptions::default()
    }
}

/// The catalog's capabilities of a model, as the recording holds Node's answers for the same catalog (a catalog that
/// lists the models by id only: the release-generation floor decides). They are inputs, taken from the functions the
/// request builder asks, never from a recorded body; the product's catalog gives the same answers
/// (`mixdog-core` `the_anthropic_wire_models_get_nodes_catalog_answers`).
fn caps_of_catalog(capabilities: &Value, model: &str) -> Option<ModelCaps> {
    let node = capabilities.get(model)?;
    let flag = |key: &str| node[key].as_bool().expect("a recorded flag");
    let mut effort_levels = Vec::new();
    if flag("supportsEffort") {
        effort_levels.extend(["low", "medium", "high"].map(str::to_owned));
        if flag("supportsXhighEffort") {
            effort_levels.push("xhigh".to_owned());
        }
        if flag("supportsMaxEffort") {
            effort_levels.push("max".to_owned());
        }
    }
    Some(ModelCaps {
        // `shouldIncludeEffortBeta`: effort support and adaptive thinking together.
        adaptive_thinking: flag("effortBeta"),
        manual_thinking: !flag("adaptiveOnly"),
        ladder_stated: false,
        effort_levels,
        max_output_tokens: node["declaredOutputTokens"].as_u64().map(|v| v as u32),
        fast_mode: false,
        context_window: None,
        thinking_display_updates: flag("progressUpdates"),
    })
}

/// Everything of a request the recording holds: method, url, every header as a (lowercase name, value) pair with
/// duplicates kept, the `content-encoding` value, whether the body was gzip bytes, and the body's decompressed text.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Seen {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub content_encoding: Option<String>,
    pub compressed: bool,
    pub body: String,
}

fn content_encoding(headers: &[(String, String)]) -> Option<String> {
    headers.iter().find(|(name, _)| name == "content-encoding").map(|(_, value)| value.clone())
}

pub(crate) fn seen_of_recorded(request: &Value) -> Seen {
    let headers: Vec<(String, String)> = request["headers"]
        .as_array()
        .expect("headers")
        .iter()
        .map(|pair| (pair[0].as_str().expect("header name").to_lowercase(), pair[1].as_str().expect("header value").to_owned()))
        .collect();
    assert_eq!(request["contentEncoding"].as_str().map(str::to_owned), content_encoding(&headers), "the recorded content-encoding is the recorded header");
    Seen {
        method: request["method"].as_str().expect("method").to_owned(),
        url: request["url"].as_str().expect("url").to_owned(),
        content_encoding: content_encoding(&headers),
        compressed: request["compressed"].as_bool().expect("compressed"),
        headers,
        body: request["body"].as_str().expect("body").to_owned(),
    }
}

pub(crate) fn seen_of_sent(request: &WireRequest) -> Seen {
    let headers: Vec<(String, String)> = request.headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
    // The gzip magic, as the recorder reads it: the compressed bytes themselves may differ (another compressor), their content may not.
    let compressed = request.body.starts_with(&[0x1f, 0x8b]);
    let body = if compressed {
        let mut text = String::new();
        GzDecoder::new(request.body.as_slice()).read_to_string(&mut text).expect("a gzip body");
        text
    } else {
        String::from_utf8(request.body.clone()).expect("utf8")
    };
    Seen { method: request.method.clone(), url: request.url.clone(), content_encoding: content_encoding(&headers), compressed, headers, body }
}

/// The headers as a list of pairs with duplicates kept. Their order is not compared yet (a pending user decision shared
/// with the OpenAI wire work), so both sides are put in one order first.
pub(crate) fn header_pairs(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut pairs = headers.to_vec();
    pairs.sort();
    pairs
}

/// The first path at which two parsed bodies differ.
fn first_difference(want: &Value, got: &Value, path: &str) -> Option<String> {
    match (want, got) {
        (Value::Object(a), Value::Object(b)) => a
            .keys()
            .chain(b.keys())
            .find_map(|key| match (a.get(key), b.get(key)) {
                (Some(x), Some(y)) => first_difference(x, y, &format!("{path}.{key}")),
                (x, y) => Some(format!("{path}.{key}: Node {} / Rust {}", x.map_or("absent".into(), short), y.map_or("absent".into(), short))),
            }),
        (Value::Array(a), Value::Array(b)) => (0..a.len().max(b.len())).find_map(|i| match (a.get(i), b.get(i)) {
            (Some(x), Some(y)) => first_difference(x, y, &format!("{path}[{i}]")),
            (x, y) => Some(format!("{path}[{i}]: Node {} / Rust {}", x.map_or("absent".into(), short), y.map_or("absent".into(), short))),
        }),
        _ if want == got => None,
        _ => Some(format!("{path}: Node {} / Rust {}", short(want), short(got))),
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.len() > 120 { format!("{}…", text.chars().take(120).collect::<String>()) } else { text }
}

/// Why `got` is not `want`, or nothing when they are equal.
pub(crate) fn mismatch(want: &Seen, got: &Seen) -> Option<String> {
    let mut what = Vec::new();
    if want.method != got.method || want.url != got.url {
        what.push(format!("request line: Node {} {} / Rust {} {}", want.method, want.url, got.method, got.url));
    }
    let (node_headers, rust_headers) = (header_pairs(&want.headers), header_pairs(&got.headers));
    if node_headers != rust_headers {
        what.push(format!("headers: Node {node_headers:?} / Rust {rust_headers:?}"));
    }
    if want.content_encoding != got.content_encoding || want.compressed != got.compressed {
        what.push(format!(
            "encoding: Node {:?} compressed {} / Rust {:?} compressed {}",
            want.content_encoding, want.compressed, got.content_encoding, got.compressed
        ));
    }
    if want.body != got.body {
        let parsed = |text: &str| serde_json::from_str::<Value>(text).expect("json body");
        match first_difference(&parsed(&want.body), &parsed(&got.body), "body") {
            Some(path) => what.push(path),
            None => what.push("body: the same JSON in another key order or spelling".to_owned()),
        }
    }
    (!what.is_empty()).then(|| what.join("; "))
}

/// A reply body that arrives in pieces: the first at once, the rest when its gate opens (at once when it has none).
/// Dropping it signals `done`, which is how the test knows the background read of `message_stop` has ended.
struct Pieces {
    first: Option<Bytes>,
    gate: Option<oneshot::Receiver<()>>,
    rest: VecDeque<Bytes>,
    done: Option<oneshot::Sender<()>>,
}

#[async_trait]
impl BodyStream for Pieces {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        if let Some(chunk) = self.first.take() {
            return Some(Ok(chunk));
        }
        if let Some(gate) = self.gate.take() {
            // A gate dropped unopened ends the wait too: the test is over with the reply.
            let _ = gate.await;
        }
        self.rest.pop_front().map(Ok)
    }
}

impl Drop for Pieces {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
    }
}

/// The background read of one split reply: its gate (when the reply is held) and its end.
pub(crate) struct Background {
    release: Option<oneshot::Sender<()>>,
    done: oneshot::Receiver<()>,
}

impl Background {
    /// Opens the gate of a held reply and waits for its read to end.
    async fn finish(mut self, what: &str) {
        if let Some(gate) = self.release.take() {
            let _ = gate.send(());
        }
        tokio::time::timeout(Duration::from_secs(10), self.done)
            .await
            .unwrap_or_else(|_| panic!("{what}: the background read of message_stop did not end within 10 s"))
            .unwrap_or_else(|_| panic!("{what}: the reply body was lost before its read ended"));
    }
}

/// Answers each request with the next recorded reply (a body, or the pieces of a split one) and keeps what was sent.
struct Wire {
    replies: Mutex<VecDeque<Value>>,
    sent: Mutex<Vec<WireRequest>>,
    background: Mutex<Vec<Background>>,
}

impl Wire {
    fn new() -> Arc<Self> {
        Arc::new(Self { replies: Mutex::default(), sent: Mutex::default(), background: Mutex::default() })
    }
}

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        let Some(reply) = self.replies.lock().unwrap().pop_front() else {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = "no recorded reply for this request".into();
            return Err(error);
        };
        let status = reply["status"].as_u64().expect("status") as u16;
        let body = match reply["chunks"].as_array() {
            None => Pieces { first: Some(Bytes::from(reply["body"].as_str().expect("reply body").to_owned())), gate: None, rest: VecDeque::new(), done: None },
            Some(chunks) => {
                let mut pieces: VecDeque<Bytes> = chunks.iter().map(|c| Bytes::from(c.as_str().expect("chunk").to_owned())).collect();
                let first = pieces.pop_front();
                let (done_tx, done_rx) = oneshot::channel();
                let (release, gate) = if reply["hold"] == true {
                    let (tx, rx) = oneshot::channel();
                    (Some(tx), Some(rx))
                } else {
                    (None, None)
                };
                self.background.lock().unwrap().push(Background { release, done: done_rx });
                Pieces { first, gate, rest: pieces, done: Some(done_tx) }
            }
        };
        Ok(HttpResponse { status, headers: vec![], body: Box::new(body) })
    }
}

#[tokio::test]
async fn every_recorded_send_puts_the_requests_node_sent_on_the_wire() {
    let document = recording("anthropic.json");
    let scenarios = document["scenarios"].as_array().expect("scenarios");
    assert_eq!(scenarios.len(), 41);
    let mut differences = Vec::new();
    for scenario in scenarios {
        let id = scenario["id"].as_str().expect("id");
        let model = scenario["model"].as_str().expect("model");
        let sends = scenario["sends"].as_array().expect("sends");
        let catalog = document["capabilities"].clone();
        let tools: Vec<_> = scenario["tools"].as_array().expect("tools").iter().map(tool_of).collect();
        let http = Wire::new();
        let store = MemoryStore::signed_in();
        let mut config = AnthropicConfig::new(Arc::new(move |model: &str| caps_of_catalog(&catalog, model)));
        config.threads = Arc::new(super::threads::Threads::default());
        let adapter = AnthropicAdapter::oauth(config, http.clone(), store.session(http.clone()), false, cpu_bulk());
        // Confirmations held back until the send after them is over.
        let mut late: Vec<Background> = Vec::new();
        for (n, send) in sends.iter().enumerate() {
            let what = format!("{id} #{n}");
            let wanted = send["requests"].as_array().expect("requests");
            let before = http.sent.lock().unwrap().len();
            *http.replies.lock().unwrap() = send["replies"].as_array().expect("replies").iter().cloned().collect();
            let mut options = options_of(&send["opts"]);
            options.send_group = Some(what.clone());
            let request = Arc::new(ModelRequest {
                model: model.to_owned(),
                // The messages as the agent hands them over: already paired (see the recorder).
                messages: send.get("pairedMessages").unwrap_or(&send["messages"]).as_array().expect("messages").iter().map(message_of).collect(),
                tools: tools.clone(),
                options,
            });
            // The loop's retry: a failed attempt is made again while the recorded replies last.
            loop {
                let failed = match adapter.attempt(request.clone()).await {
                    Err(error) => Some(error.message),
                    Ok(mut stream) => {
                        let mut failed = None;
                        while let Some(item) = stream.next().await {
                            if let Err(error) = item {
                                failed = Some(error.message);
                                break;
                            }
                        }
                        failed
                    }
                };
                match failed {
                    None => break,
                    Some(_) if !http.replies.lock().unwrap().is_empty() => {}
                    Some(message) => {
                        differences.push(format!("{what}: Rust's last attempt failed: {message}"));
                        break;
                    }
                }
            }
            let sent = http.sent.lock().unwrap().clone();
            if sent.len() - before != wanted.len() {
                differences.push(format!("{what}: Node sent {} request(s), Rust {}", wanted.len(), sent.len() - before));
            } else {
                for (i, (got, want)) in sent[before..].iter().zip(wanted).enumerate() {
                    if let Some(why) = mismatch(&seen_of_recorded(want), &seen_of_sent(got)) {
                        differences.push(format!("{what} request {i}: {why}"));
                    }
                }
            }
            // Node awaits the confirmation of a send before the next one unless the recording holds it back.
            let fresh: Vec<Background> = http.background.lock().unwrap().drain(..).collect();
            let held = send["receipt"] == "after";
            let earlier = std::mem::take(&mut late);
            if held {
                late = fresh;
            } else {
                for background in fresh {
                    background.finish(&what).await;
                }
            }
            for background in earlier {
                background.finish(&what).await;
            }
        }
        for background in late {
            background.finish(id).await;
        }
    }
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.join("\n"));
}
