//! Wire parity with Node (`b6f10295a`): what the Rust core hands its transports, equal to what Node's provider classes
//! hand theirs. The scenarios (`benchmarks/terminal-bench-2.1/analysis/parity/scenarios.json`) and the session document
//! (the core's own system texts, tools and ids) are run through the production builder (`builder_env`, the real adapters
//! and codecs), with the transport seams ([`HttpSend`], [`WsDial`]) replaced by recorders that keep, in order, every
//! handshake, frame and request the adapter hands them: send-time headers (credentials, content-encoding) and the body
//! as it is handed over. The expectation is Node's recording of the same scenarios (`node-wire-capture.mjs`, `exact:
//! true` manifest), never hand-written.
//!
//! `MIXDOG_WIRE_RUST_OUT=<file>` writes the recording of all four providers, which `wire-compare.mjs` lists against a
//! fresh Node recording.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::catalog::ModelRecord;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::transport::ws::{ConnectError, Message as WsMessage};
use mixdog_ai::transport::{BodyStream, Exchange, HttpResponse, HttpSend, WsDial, WsSocket};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, LinkLiveness, TransportKeepalive, TransportKind};
use mixdog_core_api::domain::provider::{
    CacheTier, Content, DeliveryState, ErrorKind, Message, ModelRequest, ProviderError, RequestOptions, Role, ToolCall,
    ToolDefinition, TransportFault, WireRequest,
};
use mixdog_protocol::ProviderId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;

use super::fixture_fs;
use super::builder_env::builder_env;
use super::process::HostInfo;
use super::process_tests::world;

const SESSION: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/session.json");
const SCENARIOS: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/scenarios.json");
const NODE: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/node-recording.json");

/// The fake credentials of `fake-credentials.mjs`.
const FAKE: &str = "fake-credential-not-a-secret";
const FAR: u64 = 4_102_444_800_000;

// ---- the recorders -------------------------------------------------------------------------------

enum Dial {
    Accept,
    Refuse(u16, String),
}

/// What the scripted server answers: a dial is accepted or refused, each frame sent is answered with the next list of
/// events, each HTTP request with the next list (as SSE).
#[derive(Default)]
struct Script {
    dials: VecDeque<Dial>,
    replies: VecDeque<Vec<Value>>,
    http: VecDeque<Vec<Value>>,
}

#[derive(Default)]
struct Wire {
    traffic: Mutex<Vec<Value>>,
    script: Mutex<Script>,
}

impl Wire {
    fn record(&self, entry: Value) {
        self.traffic.lock().unwrap().push(entry);
    }
}

fn pairs(headers: impl IntoIterator<Item = (String, String)>) -> Value {
    Value::Array(headers.into_iter().map(|(name, value)| json!([name, value])).collect())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The request as `fetch` received it: the headers as given and the body as sent (its length, sha256 and decoded text).
fn http_record(request: &WireRequest) -> Value {
    let encoding = request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("content-encoding")).map(|(_, value)| value.as_str());
    let decoded = match encoding {
        Some("gzip") => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(request.body.as_slice()).read_to_end(&mut out).expect("a gzip body");
            out
        }
        Some("zstd") => zstd::decode_all(request.body.as_slice()).expect("a zstd body"),
        _ => request.body.clone(),
    };
    let body = (!request.body.is_empty()).then(|| {
        json!({ "encoding": encoding, "bytes": request.body.len(), "sha256": sha256(&request.body), "text": String::from_utf8(decoded).expect("a UTF-8 body") })
    });
    json!({ "kind": "http", "method": request.method, "url": request.url, "headers": pairs(request.headers.clone()), "body": body })
}

fn sse(events: &[Value]) -> Bytes {
    Bytes::from(events.iter().map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap())).collect::<String>())
}

struct VecBody(VecDeque<Bytes>);

#[async_trait]
impl BodyStream for VecBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front().map(Ok)
    }
}

struct Recorder(Arc<Wire>);

#[async_trait]
impl HttpSend for Recorder {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        self.0.record(http_record(&request));
        let Some(events) = self.0.script.lock().unwrap().http.pop_front() else {
            return Err(ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent));
        };
        Ok(HttpResponse { status: 200, headers: vec![("content-type".into(), "text/event-stream".into())], body: Box::new(VecBody([sse(&events)].into())) })
    }
}

struct NeverAlive;

impl TransportKeepalive for NeverAlive {
    fn kind(&self) -> TransportKind {
        TransportKind::WebSocket
    }
    fn arm(&self, _: &KeepaliveSchedule) -> Result<(), TransportFault> {
        Ok(())
    }
    fn liveness(&self) -> LinkLiveness {
        LinkLiveness::Alive
    }
    fn may_start_response(&self) -> bool {
        true
    }
}

struct Socket {
    wire: Arc<Wire>,
    pending: Mutex<VecDeque<WsMessage>>,
}

#[async_trait]
impl WsSocket for Socket {
    async fn send(&self, message: WsMessage) -> Result<(), TransportFault> {
        self.wire.record(json!({ "kind": "ws-frame", "text": message.to_text().expect("a text frame") }));
        let events = self.wire.script.lock().unwrap().replies.pop_front().unwrap_or_default();
        self.pending.lock().unwrap().extend(events.iter().map(|event| WsMessage::text(event.to_string())));
        Ok(())
    }
    async fn recv(&mut self) -> Option<Result<WsMessage, TransportFault>> {
        self.pending.lock().unwrap().pop_front().map(Ok)
    }
    fn link(&self) -> Arc<dyn TransportKeepalive> {
        Arc::new(NeverAlive)
    }
}

/// The header names the websocket library puts on an upgrade request for `uri` on its own.
fn bare_upgrade(uri: &tokio_tungstenite::tungstenite::http::Uri) -> Vec<String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    uri.to_string().into_client_request().unwrap().headers().keys().map(|n| n.as_str().to_owned()).collect()
}

#[async_trait]
impl WsDial for Recorder {
    async fn dial(&self, request: Request) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        // The handshake as the provider code wrote it: the websocket library adds its own headers to the url's request
        // (Node's `ws`: `initAsClient`, `websocket.js:773-779`; here `ws_request`'s `into_client_request`), so
        // the library's share is what a bare request for the same url holds, one occurrence per name; everything else
        // is the provider's and is compared whole.
        let mut library = bare_upgrade(request.uri());
        let headers = request
            .headers()
            .iter()
            .filter(|(name, _)| match library.iter().position(|n| n == name.as_str()) {
                Some(at) => {
                    library.swap_remove(at);
                    false
                }
                None => true,
            })
            .map(|(name, value)| (name.as_str().to_owned(), value.to_str().unwrap().to_owned()));
        self.0.record(json!({ "kind": "ws-handshake", "url": request.uri().to_string(), "headers": pairs(headers) }));
        match self.0.script.lock().unwrap().dials.pop_front().unwrap_or(Dial::Accept) {
            Dial::Accept => Ok((Box::new(Socket { wire: self.0.clone(), pending: Mutex::default() }), Response::builder().status(101).body(None).unwrap())),
            Dial::Refuse(status, body) => Err(ConnectError::Rejected(Response::builder().status(status).body(Some(body.into_bytes())).unwrap())),
        }
    }
}

// ---- the scenarios -------------------------------------------------------------------------------

fn text(value: &Value) -> String {
    value.as_str().expect("a string").to_owned()
}

/// A scenario message in Node's shape (`{role, content, toolCalls, toolCallId}`).
fn message(node: &Value) -> Message {
    let role = match node["role"].as_str().unwrap() {
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        _ => Role::User,
    };
    let mut message = Message::new(role, Content::Text(text(&node["content"])));
    message.tool_call_id = node.get("toolCallId").map(text);
    for call in node.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
        message.tool_calls.push(ToolCall { id: text(&call["id"]), name: text(&call["name"]), arguments: call["arguments"].clone(), native_type: None });
    }
    message
}

/// The request one scenario sends, as the core assembles it (`HostRunParts::request_parts`): the session's four system
/// messages (the third `Tier3`, the fourth `Env`), the session's tools, the thread's identity, the provider's cache key.
fn request(session: &Value, scenario: &Value, model: &str) -> ModelRequest {
    let system = session["system"].as_array().unwrap();
    assert_eq!(system.len(), 4, "base rules, stable context, session marker, environment");
    let mut messages: Vec<Message> = system
        .iter()
        .zip([None, None, Some(CacheTier::Tier3), Some(CacheTier::Env)])
        .map(|(body, tier)| {
            let mut message = Message::new(Role::System, Content::Text(text(body)));
            message.cache_tier = tier;
            message
        })
        .collect();
    messages.extend(scenario["messages"].as_array().unwrap().iter().map(message));
    let tools = session["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| ToolDefinition {
            name: text(&tool["name"]),
            description: text(&tool["description"]),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: tool["deferLoading"] == true,
            freeform: None,
        })
        .collect();
    let thread = text(&session["threadId"]);
    let mut options = RequestOptions { session_id: Some(thread.clone()), ..RequestOptions::default() };
    if scenario["provider"] == "openai-oauth" {
        options.prompt_cache_key = Some("mixdog-codex".into());
        options.thread = Some(super::assemble::wire_thread(thread.as_str().into(), Some(text(&scenario["turnId"]).as_str().into())));
    }
    ModelRequest { model: model.into(), messages, tools, options }
}

/// Every scenario through the production adapters; the recording per scenario, in Node's shape.
async fn record_all() -> Vec<Value> {
    let session: Value = serde_json::from_str(SESSION).unwrap();
    let doc: Value = serde_json::from_str(SCENARIOS).unwrap();
    let now = doc["nowMs"].as_u64().unwrap();
    let node: Value = serde_json::from_str(NODE).unwrap();
    assert_eq!(node["manifest"]["exact"], true, "the recording is Node's, exact");

    let model = "gpt-6.1-sol";
    let records = vec![ModelRecord::new(ProviderId::from("openai-oauth"), model)];
    let mut w = world(&[("MIXDOG_DISABLE_LIVE_CLI_VERSIONS", "1")], json!({}), records).await;
    w.services.installation_id = text(&session["installationId"]);
    w.services.host = HostInfo::from_node(session["host"]["type"].as_str().unwrap(), session["host"]["release"].as_str().unwrap(), session["host"]["arch"].as_str().unwrap());
    let data = w.services.plugin_data.clone();
    let credentials = [
        ("anthropic-oauth-credentials.json", json!({ "claudeAiOauth": { "accessToken": FAKE, "refreshToken": FAKE, "expiresAt": FAR, "scopes": ["user:inference"] } })),
        ("openai-oauth.json", json!({ "access_token": FAKE, "refresh_token": FAKE, "account_id": "fake", "expires_at": FAR })),
        ("grok-oauth.json", json!({ "access_token": FAKE, "refresh_token": FAKE, "expires_at": FAR })),
    ];
    for (file, body) in credentials {
        fixture_fs::write(data.join(file), body.to_string());
    }

    let wire = Arc::new(Wire::default());
    let mut env = builder_env(&w.services);
    env.http = Arc::new(Recorder(wire.clone()));
    env.dial = Arc::new(Recorder(wire.clone()));
    env.openai_context = Arc::new(SessionContext::with_sources(move || now, || "0".repeat(32)));
    let builder = DefaultProviderBuilder::new(env);
    let config = |provider: &str| if provider == "gemini" { json!({ "enabled": true, "apiKey": FAKE }) } else { json!({ "enabled": true }) };

    let mut out = Vec::new();
    let mut openai = None;
    for scenario in doc["scenarios"].as_array().unwrap() {
        let provider = scenario["provider"].as_str().unwrap();
        let model = match provider {
            "openai-oauth" => "gpt-6.1-sol",
            "anthropic-oauth" => "claude-opus-5-5",
            "gemini" => "gemini-3.8-flash",
            _ => "grok-4.7",
        };
        *wire.traffic.lock().unwrap() = Vec::new();
        *wire.script.lock().unwrap() = Script {
            dials: scenario["dials"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|dial| if dial["accept"] == false { Dial::Refuse(dial["status"].as_u64().unwrap() as u16, text(&dial["body"])) } else { Dial::Accept })
                .collect(),
            replies: scenario["ws"].as_array().into_iter().flatten().map(|events| events.as_array().unwrap().clone()).collect(),
            http: scenario["http"].as_array().into_iter().flatten().map(|events| events.as_array().unwrap().clone()).collect(),
        };
        let adapter = if provider == "openai-oauth" {
            if scenario["fresh"] == true || openai.is_none() {
                openai = Some(builder.build(provider, &config(provider)).await.unwrap());
            }
            openai.clone().unwrap()
        } else {
            builder.build(provider, &config(provider)).await.unwrap()
        };
        let attempt = adapter.attempt(Arc::new(request(&session, scenario, model))).await;
        let mut error = None;
        match attempt {
            Ok(mut stream) => {
                while let Some(event) = stream.next().await {
                    if let Err(failure) = event {
                        error = Some(failure.message);
                        break;
                    }
                }
            }
            Err(failure) => error = Some(failure.message),
        }
        assert!(scenario["expectError"] == true || error.is_none(), "{}: the send failed: {error:?}", scenario["id"]);
        out.push(json!({ "id": scenario["id"], "provider": provider, "model": model, "traffic": wire.traffic.lock().unwrap().clone() }));
    }
    if let Ok(path) = std::env::var("MIXDOG_WIRE_RUST_OUT") {
        fixture_fs::write(path, serde_json::to_string_pretty(&json!({ "scenarios": out })).unwrap());
    }
    out
}

// ---- the comparison ------------------------------------------------------------------------------

/// Header names are case-insensitive and the order of headers carries no meaning: both sides as sorted `(lowercase name, value)`.
fn headers(list: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = list.as_array().unwrap().iter().map(|pair| (text(&pair[0]).to_ascii_lowercase(), text(&pair[1]))).collect();
    out.sort();
    out
}

/// Where two texts first differ, with the text around it.
fn first_difference(node: &str, rust: &str) -> String {
    let at = node.bytes().zip(rust.bytes()).position(|(a, b)| a != b).unwrap_or(node.len().min(rust.len()));
    let around = |s: &str| s.get(at.saturating_sub(40)..(at + 80).min(s.len())).unwrap_or("").to_owned();
    format!("differ at byte {at} (node {} bytes, rust {} bytes)\n  node: {}\n  rust: {}", node.len(), rust.len(), around(node), around(rust))
}

fn compare(id: &str, node: &[Value], rust: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    let kinds = |list: &[Value]| list.iter().map(|r| text(&r["kind"])).collect::<Vec<_>>();
    if kinds(node) != kinds(rust) {
        return vec![format!("{id}: the transports saw {:?} in Node, {:?} in Rust", kinds(node), kinds(rust))];
    }
    for (index, (n, r)) in node.iter().zip(rust).enumerate() {
        let at = format!("{id}[{index}] {}", text(&n["kind"]));
        match n["kind"].as_str().unwrap() {
            "ws-frame" => {
                if n["text"] != r["text"] {
                    out.push(format!("{at}: {}", first_difference(n["text"].as_str().unwrap(), r["text"].as_str().unwrap())));
                }
            }
            _ => {
                for key in ["method", "url"] {
                    if n.get(key) != r.get(key) {
                        out.push(format!("{at}: {key} {:?} in Node, {:?} in Rust", n.get(key), r.get(key)));
                    }
                }
                if headers(&n["headers"]) != headers(&r["headers"]) {
                    out.push(format!("{at}: headers\n  node: {:?}\n  rust: {:?}", headers(&n["headers"]), headers(&r["headers"])));
                }
                if n["kind"] == "http" {
                    for key in ["encoding", "bytes", "sha256"] {
                        if n["body"][key] != r["body"][key] {
                            out.push(format!("{at}: body {key} {} in Node, {} in Rust", n["body"][key], r["body"][key]));
                        }
                    }
                    if n["body"]["text"] != r["body"]["text"] {
                        out.push(format!("{at}: body text {}", first_difference(n["body"]["text"].as_str().unwrap_or(""), r["body"]["text"].as_str().unwrap_or(""))));
                    }
                }
            }
        }
    }
    out
}

/// Every difference between Node's recording and Rust's for the scenarios of `provider`.
async fn differences(provider: &str) -> Vec<String> {
    let rust = record_all().await;
    let node: Value = serde_json::from_str(NODE).unwrap();
    let mut out = Vec::new();
    let mut seen = 0;
    for node_scenario in node["scenarios"].as_array().unwrap().iter().filter(|s| s["provider"] == provider) {
        let rust_scenario = rust.iter().find(|s| s["id"] == node_scenario["id"]).expect("Rust ran every scenario of Node's recording");
        out.extend(compare(&text(&node_scenario["id"]), node_scenario["traffic"].as_array().unwrap(), rust_scenario["traffic"].as_array().unwrap()));
        seen += 1;
    }
    assert!(seen > 0, "Node's recording holds scenarios of {provider}");
    out
}

#[tokio::test]
async fn every_openai_request_equals_nodes_recording() {
    let differences = differences("openai-oauth").await;
    assert!(differences.is_empty(), "{} differences from Node's recording:\n{}", differences.len(), differences.join("\n"));
}
