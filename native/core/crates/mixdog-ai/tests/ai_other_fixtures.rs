//! The Devin, Cursor and Grok providers against the recordings of today's
//! Node product (`fixtures/providers-ai-other`, `providers-intercepted`):
//! request bytes equal (random UUIDs masked), and every recorded response
//! maps to the recorded content, tool calls, usage, stop reason or error.
#![allow(clippy::disallowed_methods, reason = "a test reads its fixture files directly")]

use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use mixdog_ai::providers::cursor::CursorAdapter;
use mixdog_ai::providers::cursor::auth::ApiKeyAccess;
use mixdog_ai::providers::devin::DevinAdapter;
use mixdog_ai::providers::devin::auth::StaticSessionToken;
use mixdog_ai::providers::devin::auth::StoredCredentials;
use mixdog_ai::providers::grok;
use mixdog_ai::transport::http::BidiOpen;
use mixdog_ai::transport::http::BodyStream;
use mixdog_ai::transport::http::FrameSink;
use mixdog_ai::transport::http::HttpResponse;
use mixdog_ai::transport::http::HttpSend;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

fn fixtures(set: &str, family: &str, scenario: &str, file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(set)
        .join(family)
        .join(scenario)
        .join(file);
    serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn scenarios(set: &str, family: &str) -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(set).join(family);
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn b64(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().unwrap_or_default()).unwrap()
}

fn request(model: &str) -> ModelRequest {
    ModelRequest {
        model: model.into(),
        messages: vec![
            Message::new(Role::System, Content::Text("You are a fixture assistant.".into())),
            Message::new(Role::User, Content::Text("Look up the answer.".into())),
        ],
        tools: vec![ToolDefinition {
            name: "lookup".into(),
            description: "Read a value".into(),
            input_schema: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}),
            defer_loading: false,
        }],
        options: RequestOptions::default(),
    }
}

/// Replaces every `8-4-4-4-12` UUID with `x`s: the product draws them at random.
fn mask_uuids(bytes: &[u8]) -> Vec<u8> {
    let shape = |w: &[u8]| {
        w.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
    };
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i + 36 <= out.len() {
        if shape(&out[i..i + 36]) {
            out[i..i + 36].fill(b'x');
            i += 36;
        } else {
            i += 1;
        }
    }
    out
}

fn gunzip_frame(body: &[u8]) -> Vec<u8> {
    assert_eq!(body[0] & 1, 1, "a gzip connect frame");
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(&body[5..]).read_to_end(&mut out).unwrap();
    out
}

struct Chunks(VecDeque<Bytes>, Option<TransportFault>);

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self.0.pop_front() {
            Some(chunk) => Some(Ok(chunk)),
            None => self.1.take().map(Err),
        }
    }
}

fn response(status: u16, chunks: Vec<Vec<u8>>, fault: Option<TransportFault>) -> HttpResponse {
    HttpResponse {
        status,
        headers: Vec::new(),
        body: Box::new(Chunks(chunks.into_iter().map(Bytes::from).collect(), fault)),
    }
}

/// Serves the recorded exchange: unary records by path, the Run stream by its frames.
struct Replay {
    records: Mutex<Vec<Value>>,
    sent: Mutex<Vec<(String, Vec<u8>)>>,
    /// The recording ends in a connection reset rather than a clean end of body.
    reset: bool,
}

impl Replay {
    fn new(scenario: &Value, reset: bool) -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(scenario["records"].as_array().unwrap().clone()),
            sent: Mutex::new(Vec::new()),
            reset,
        })
    }

    fn take(&self, path: &str, stream: bool) -> Option<Value> {
        let records = self.records.lock().unwrap();
        let at = records.iter().position(|r| {
            r["path"] == path && if stream { r.get("frames").is_some() && r.get("served").is_none() } else { r.get("served").is_some() }
        })?;
        Some(records[at].clone())
    }

    fn sent_to(&self, path: &str) -> Vec<Vec<u8>> {
        let sent = self.sent.lock().unwrap();
        sent.iter().filter(|(p, _)| p == path).map(|(_, b)| b.clone()).collect()
    }
}

fn path_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.find('/').map_or("/".to_owned(), |i| rest[i..].to_owned())
}

#[async_trait]
impl HttpSend for Replay {
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
        let path = path_of(&request.url);
        self.sent.lock().unwrap().push((path.clone(), request.body.clone()));
        // A request the Node run never made (a catalog it had cached) is refused.
        let Some(record) = self.take(&path, false) else {
            return Ok(response(404, Vec::new(), None));
        };
        let served = &record["served"];
        let status = served["status"].as_u64().unwrap_or(200) as u16;
        Ok(response(status, vec![b64(&served["bodyBase64"])], (self.reset && path.ends_with("GetChatMessage")).then_some(TransportFault::Reset)))
    }
}

struct Sink(Mutex<Vec<Vec<u8>>>);

impl FrameSink for Sink {
    fn send(&self, frame: Vec<u8>) -> Result<(), TransportFault> {
        self.0.lock().unwrap().push(frame);
        Ok(())
    }
}

#[async_trait]
impl BidiOpen for Replay {
    async fn open(&self, request: WireRequest, first: Vec<u8>) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        let path = path_of(&request.url);
        self.sent.lock().unwrap().push((path.clone(), first));
        let record = self.take(&path, true).unwrap_or_else(|| panic!("unrecorded stream {path}"));
        let mut chunks = Vec::new();
        for frame in record["frames"].as_array().unwrap() {
            let payload = b64(&frame["base64"]);
            match frame["dir"].as_str().unwrap() {
                "out" => {
                    let mut framed = vec![frame["flags"].as_u64().unwrap() as u8];
                    framed.extend((payload.len() as u32).to_be_bytes());
                    framed.extend(payload);
                    chunks.push(framed);
                }
                "out-raw" => chunks.push(payload),
                _ => {}
            }
        }
        let status = record["status"].as_u64().unwrap_or(200) as u16;
        Ok((response(status, chunks, None), Arc::new(Sink(Mutex::new(Vec::new())))))
    }
}

#[derive(Default, Debug)]
struct Outcome {
    content: String,
    reasoning: String,
    calls: Vec<(String, String, Value)>,
    usage: Option<Usage>,
    stop: Option<StopReason>,
    error: Option<ProviderError>,
}

impl Outcome {
    fn fold(&mut self, event: StreamEvent) {
        match event {
            StreamEvent::TextDelta(t) => self.content.push_str(&t),
            StreamEvent::ReasoningDelta(t) => self.reasoning.push_str(&t),
            StreamEvent::ToolCallDone(c) => self.calls.push((c.id, c.name, c.arguments)),
            StreamEvent::Usage(u) => self.usage = Some(u),
            StreamEvent::Completed { stop, .. } => self.stop = stop,
            _ => {}
        }
    }
}

async fn run(adapter: &dyn ProviderAdapter, request: ModelRequest) -> Outcome {
    let mut outcome = Outcome::default();
    let mut stream = match adapter.attempt(Arc::new(request)).await {
        Ok(stream) => stream,
        Err(error) => {
            outcome.error = Some(error);
            return outcome;
        }
    };
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => outcome.fold(event),
            Err(error) => {
                outcome.error = Some(error);
                break;
            }
        }
    }
    outcome
}

fn raw_of(usage: &Usage) -> &Value {
    usage.raw.as_ref().expect("usage carries the provider's own object")
}

fn devin_usage(usage: &Usage) -> Value {
    let raw = raw_of(usage);
    json!({
        "cacheWriteTokens": raw["cacheWriteTokens"],
        "cachedTokens": raw["cacheReadTokens"],
        "inputTokens": raw["inputTokens"],
        "outputTokens": raw["outputTokens"],
    })
}

/// Cursor reports the completion only; the input and cache sides are unknown.
fn cursor_usage(usage: &Usage) -> Value {
    let raw = raw_of(usage);
    let known = |flag: &str, value: u64| if raw[flag] == false { Value::Null } else { json!(value) };
    json!({
        "cacheWriteTokens": known("cache_tokens_known", usage.cache_write_tokens),
        "cachedTokens": known("cache_tokens_known", usage.cache_read_tokens),
        "inputTokens": known("input_tokens_known", usage.input_tokens),
        "outputTokens": usage.output_tokens,
    })
}

/// The Responses usage object names no cache split here, so the recording has none.
fn grok_usage(usage: &Usage) -> Value {
    let mut out = json!({"inputTokens": usage.input_tokens, "outputTokens": usage.output_tokens});
    if raw_of(usage)["input_tokens_details"]["cached_tokens"].is_number() {
        out["cachedTokens"] = json!(usage.cache_read_tokens);
    }
    out
}
/// Node-shaped usage of a Rust usage: a number where the wire reported it, `null`
/// where Node reported it unknown, no key where Node left it out.
type Project = fn(&Usage) -> Value;

fn assert_matches_result(name: &str, got: &Outcome, result: &Value, project: Project) {
    if let Some(ok) = result.get("ok") {
        assert!(got.error.is_none(), "{name}: unexpected error {:?}", got.error);
        assert_eq!(got.content, ok["content"].as_str().unwrap_or_default(), "{name}: content");
        let calls: Vec<_> = ok["toolCalls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["id"].as_str().unwrap().to_owned(), c["name"].as_str().unwrap().to_owned(), c["arguments"].clone()))
            .collect();
        assert_eq!(got.calls, calls, "{name}: tool calls");
        if let Some(reasoning) = ok["reasoningContent"].as_str() {
            assert_eq!(got.reasoning, reasoning, "{name}: reasoning");
        }
        // Node's `stopReason: null` (the wire named none) is `None`.
        let want = match ok["stopReason"].as_str() {
            Some("stop") => Some(StopReason::EndTurn),
            Some("tool_calls") => Some(StopReason::ToolUse),
            Some(other) => panic!("{name}: unmapped stop {other}"),
            None => None,
        };
        assert_eq!(got.stop, want, "{name}: stop");
        let usage = got.usage.as_ref().unwrap_or_else(|| panic!("{name}: no usage"));
        assert_eq!(project(usage), ok["usage"], "{name}: usage");
    } else {
        let want = &result["error"];
        let error = got.error.as_ref().unwrap_or_else(|| panic!("{name}: expected an error, got {got:?}"));
        if let Some(code) = want["code"].as_str() {
            assert_eq!(error.code.as_deref(), Some(code), "{name}: code");
        }
        let status = want["status"].as_u64().filter(|s| *s != 0).map(|s| s as u16);
        assert_eq!(error.status.filter(|s| *s != 0), status, "{name}: status");
        assert_eq!(error.reauth_required, want["reauthRequired"] == true, "{name}: reauth");
        if let Some(live) = want["liveTextEmitted"].as_bool() {
            assert_eq!(error.exposure.text_emitted, live, "{name}: text exposure");
        }
        assert_ne!(error.delivery, DeliveryState::NotSent, "{name}: the request was sent");
    }
}

fn devin_adapter(replay: &Arc<Replay>) -> DevinAdapter {
    let credentials = StoredCredentials {
        access_token: "devin-session-token$fixture-access-token".into(),
        refresh_token: None,
        expires_at: None,
        identity: None,
    };
    DevinAdapter::new(None, replay.clone(), Arc::new(StaticSessionToken(credentials)))
}

#[tokio::test]
async fn devin_recordings() {
    for scenario in scenarios("providers-ai-other", "devin-oauth") {
        let exchange = fixtures("providers-ai-other", "devin-oauth", &scenario, "exchange.json");
        let result = fixtures("providers-ai-other", "devin-oauth", &scenario, "result.json");
        let replay = Replay::new(&exchange, scenario.contains("reset"));
        let got = run(&devin_adapter(&replay), request("devin-fixture")).await;
        assert_matches_result(&scenario, &got, &result, devin_usage);
        for record in exchange["records"].as_array().unwrap() {
            let path = record["path"].as_str().unwrap();
            if !path.ends_with("GetChatMessage") && !path.ends_with("GetUserJwt") {
                continue;
            }
            let Some(sent) = replay.sent_to(path).into_iter().next() else { continue };
            let recorded = b64(&record["bodyBase64"]);
            let (sent, recorded) = if path.ends_with("GetChatMessage") {
                (gunzip_frame(&sent), gunzip_frame(&recorded))
            } else {
                (sent, recorded)
            };
            assert_eq!(mask_uuids(&sent), mask_uuids(&recorded), "{scenario}: {path} request bytes");
        }
    }
}

#[tokio::test]
async fn cursor_recordings() {
    // The run's heartbeat is armed on the core ticker.
    mixdog_rt::testing::tokens();
    for scenario in scenarios("providers-ai-other", "cursor-api") {
        let exchange = fixtures("providers-ai-other", "cursor-api", &scenario, "exchange.json");
        let result = fixtures("providers-ai-other", "cursor-api", &scenario, "result.json");
        let replay = Replay::new(&exchange, scenario.contains("reset"));
        let tokens = ApiKeyAccess::new(replay.clone(), "fixture-api-key".into());
        let adapter = CursorAdapter::new("cursor-api", None, None, replay.clone(), replay.clone(), Arc::new(tokens));
        let got = run(&adapter, request("cursor-fixture")).await;
        assert_matches_result(&scenario, &got, &result, cursor_usage);
        let run_record = exchange["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["path"] == "/agent.v1.AgentService/Run")
            .unwrap();
        let recorded = b64(&run_record["frames"][0]["base64"]);
        let sent = replay.sent_to("/agent.v1.AgentService/Run").into_iter().next().unwrap();
        assert_eq!(mask_uuids(&sent[5..]), mask_uuids(&recorded), "{scenario}: Run request bytes");
    }
}

#[test]
fn grok_recordings() {
    let wire_request = request("grok-4");
    let codec = grok::codec("1.0.70");
    let encoded = codec.encode(&wire_request).unwrap();
    for scenario in scenarios("providers-intercepted", "grok-oauth") {
        let exchange = fixtures("providers-intercepted", "grok-oauth", &scenario, "exchange.json");
        let result = fixtures("providers-intercepted", "grok-oauth", &scenario, "result.json");
        let record = exchange["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["path"] == "/v1/responses")
            .unwrap();
        assert_eq!(encoded.url, "https://cli-chat-proxy.grok.com/v1/responses", "{scenario}");
        assert_eq!(
            String::from_utf8(encoded.body.clone()).unwrap(),
            record["bodyText"].as_str().unwrap(),
            "{scenario}: request body"
        );
        let served = record["served"].as_str().unwrap_or_default();
        let status = record["status"].as_u64().unwrap_or(200) as u16;
        if status >= 400 {
            let error = codec.classify(&ErrorResponse {
                status: Some(status),
                headers: Vec::new(),
                body: served.as_bytes().to_vec(),
            });
            assert_eq!(error.status, result["error"]["status"].as_u64().map(|s| s as u16), "{scenario}");
            continue;
        }
        if result.get("ok").is_none() {
            continue; // recorder-aborted truncations carry no terminal to compare
        }
        let decoder = &mut codec.decoder(&request("fixture-model"));
        let mut got = Outcome::default();
        for chunk in served.as_bytes().chunks(11) {
            for event in decoder.feed(chunk).unwrap() {
                got.fold(event);
            }
        }
        for event in decoder.finish().unwrap() {
            got.fold(event);
        }
        assert_matches_result(&scenario, &got, &result, grok_usage);
    }
}
