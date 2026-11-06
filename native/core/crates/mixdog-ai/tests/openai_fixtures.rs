//! The OpenAI Responses codec against the recorded fixtures.

#![allow(
    clippy::disallowed_methods,
    reason = "test-only: reads recorded fixture files synchronously"
)]

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;
use serde_json::json;

struct Ctx;
impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
}

struct Facts;
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts::default()
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers/openai-responses-http-sse")
}

fn codex_codec(transport: TransportKind) -> OpenAiCodec {
    let identity = CodexIdentity {
        installation_id: "i".into(),
        user_agent: "ua".into(),
        version: "0.166.0".into(),
        beta_features: "remote_compaction_v2".into(),
    };
    OpenAiCodec::new(
        OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx)),
        transport,
    )
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "gpt-fixture".into(),
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
        options: RequestOptions {
            prompt_cache_key: Some("mixdog-codex".into()),
            ..Default::default()
        },
    }
}

fn recorded_body() -> String {
    let text = std::fs::read_to_string(fixtures().join("tool-call/request.json")).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    v["requests"][0]["bodyText"].as_str().unwrap().to_owned()
}

fn decode(dir: &str) -> (Vec<StreamEvent>, Option<mixdog_core_api::domain::provider::ProviderError>) {
    let sse = std::fs::read(fixtures().join(dir).join("response.sse")).unwrap();
    let mut decoder = codex_codec(TransportKind::Http1).decoder(&request());
    let mut events = Vec::new();
    // Small chunks exercise the framing across unit boundaries.
    for chunk in sse.chunks(7) {
        match decoder.feed(chunk) {
            Ok(mut e) => events.append(&mut e),
            Err(err) => return (events, Some(err)),
        }
    }
    match decoder.finish() {
        Ok(mut e) => {
            events.append(&mut e);
            (events, None)
        }
        Err(err) => (events, Some(err)),
    }
}

#[test]
fn http_body_matches_the_recording_byte_for_byte() {
    let wire = codex_codec(TransportKind::Http1).encode(&request()).unwrap();
    assert_eq!(String::from_utf8(wire.body).unwrap(), recorded_body());
    assert_eq!(wire.url, "https://chatgpt.com/backend-api/codex/responses");
}

#[test]
fn ws_frame_leads_with_type_and_has_no_stream() {
    let wire = codex_codec(TransportKind::WebSocket).encode(&request()).unwrap();
    let frame = String::from_utf8(wire.body).unwrap();
    assert!(frame.starts_with(r#"{"type":"response.create","model":"gpt-fixture""#));
    assert!(!frame.contains(r#""stream":"#));
    assert!(wire.headers.iter().any(|(k, v)| k == "OpenAI-Beta" && v.starts_with("responses_websockets=")));
}

#[test]
fn text_stream_completes_with_usage() {
    let (events, err) = decode("text");
    assert!(err.is_none());
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "The result is 42.");
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Usage(u) if u.input_tokens == 20 && u.output_tokens == 8)));
    assert!(matches!(events.last(), Some(StreamEvent::Completed { stop: None, .. })));
}

#[test]
fn tool_call_stream_yields_one_call_and_no_stop_reason() {
    let (events, err) = decode("tool-call");
    assert!(err.is_none());
    let calls: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ToolCallDone(c) => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_fx1");
    assert_eq!(calls[0].name, "lookup");
    assert_eq!(calls[0].arguments, json!({"key": "answer"}));
    assert!(matches!(events.last(), Some(StreamEvent::Completed { stop: None, .. })));
}

/// Every intercepted Responses recording (API key and OAuth, SSE and
/// WebSocket) decodes to exactly the recorded result, including
/// `stopReason: null` for a plain completion and for a tool call.
#[test]
fn intercepted_recordings_decode_to_the_recorded_results() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers-intercepted");
    let read_json = |p: PathBuf| -> Value { serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap() };
    let mut replayed = 0;
    for family in [
        "openai-responses-sse-direct",
        "openai-responses-ws",
        "openai-oauth-responses-sse",
        "openai-oauth-responses-ws",
    ] {
        for scenario in ["text", "tool-call"] {
            let dir = root.join(family).join(scenario);
            let exchange = read_json(dir.join("exchange.json"));
            let want = read_json(dir.join("result.json"));
            // The model exchange is the record that carries frames or an SSE body
            // for the responses path (the other records are model-list fetches).
            let record = exchange["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["frames"].is_array() || r["path"].as_str().is_some_and(|p| p.ends_with("/responses")))
                .unwrap_or_else(|| panic!("{family}/{scenario}: no responses record"));
            let websocket = record["frames"].is_array();
            let transport = if websocket { TransportKind::WebSocket } else { TransportKind::Http1 };
            let mut decoder = codex_codec(transport).decoder(&request());
            let mut events = Vec::new();
            if websocket {
                for frame in record["frames"].as_array().unwrap().iter().filter(|f| f["dir"] == "out") {
                    events.append(&mut decoder.feed(frame["text"].as_str().unwrap().as_bytes()).unwrap());
                }
            } else {
                events.append(&mut decoder.feed(record["served"].as_str().unwrap().as_bytes()).unwrap());
            }
            events.append(&mut decoder.finish().unwrap());

            let ok = &want["ok"];
            let text: String = events
                .iter()
                .filter_map(|e| match e {
                    StreamEvent::TextDelta(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(text, ok["content"].as_str().unwrap(), "{family}/{scenario} content");
            let calls: Vec<Value> = events
                .iter()
                .filter_map(|e| match e {
                    StreamEvent::ToolCallDone(c) => {
                        Some(json!({"id": c.id, "name": c.name, "arguments": c.arguments}))
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(Value::Array(calls), ok["toolCalls"], "{family}/{scenario} tool calls");
            let usage = events
                .iter()
                .find_map(|e| match e {
                    StreamEvent::Usage(u) => Some((u.input_tokens, u.output_tokens)),
                    _ => None,
                })
                .unwrap();
            assert_eq!(
                (json!(usage.0), json!(usage.1)),
                (ok["usage"]["inputTokens"].clone(), ok["usage"]["outputTokens"].clone()),
                "{family}/{scenario} usage"
            );
            // `stopReason: null` in the recording is `None`, never an inferred reason.
            assert_eq!(ok["stopReason"], Value::Null);
            let stop: Option<StopReason> = match events.last() {
                Some(StreamEvent::Completed { stop, .. }) => stop.clone(),
                other => panic!("{family}/{scenario}: last event {other:?}"),
            };
            assert_eq!(stop, None, "{family}/{scenario} stop reason");
            replayed += 1;
        }
    }
    assert_eq!(replayed, 8);
}

#[test]
fn stream_without_terminal_is_a_truncation_after_output() {
    let (_, err) = decode("truncated-no-completed");
    let err = err.expect("truncated stream must error");
    assert_eq!(err.kind, ErrorKind::Transient);
    assert!(err.exposure.text_emitted);
    assert_eq!(err.delivery, DeliveryState::Accepted);
}
