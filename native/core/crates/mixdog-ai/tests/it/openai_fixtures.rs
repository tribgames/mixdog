//! The OpenAI Responses codec against the recorded fixtures.

#![allow(clippy::disallowed_methods, reason = "test-only: reads recorded fixture files synchronously")]

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

fn codex_codec(transport: TransportKind) -> OpenAiCodec {
    let identity =
        CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "0.166.0".into(), beta_features: "remote_compaction_v2".into() };
    OpenAiCodec::new(OpenAiConfig::codex(false, identity, Arc::new(Facts), Arc::new(Ctx)), transport)
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
            freeform: None,
        }],
        options: RequestOptions { prompt_cache_key: Some("mixdog-codex".into()), ..Default::default() },
    }
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
fn the_http_request_is_one_streamed_post_to_the_codex_responses_endpoint() {
    let wire = codex_codec(TransportKind::Http1).encode(&request()).unwrap();
    assert_eq!((wire.method.as_str(), wire.url.as_str()), ("POST", "https://chatgpt.com/backend-api/codex/responses"));
    let body: Value = serde_json::from_slice(&wire.body).unwrap();
    assert_eq!(body["model"], "gpt-fixture");
    assert_eq!(body["stream"], true);
    assert_eq!(body["instructions"], "You are a fixture assistant.");
    assert_eq!(body["prompt_cache_key"], "mixdog-codex");
    assert_eq!(body["input"][0]["role"], "user");
    assert_eq!(body["input"][0]["content"][0]["text"], "Look up the answer.");
    assert_eq!(body["tools"][0]["name"], "lookup");
    assert_eq!(body["tools"][0]["parameters"]["required"], json!(["key"]));
}

const MESSAGE_DONE: &str = r#"{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"The result is 42."}]}"#;
const CALL_DONE: &str = r#"{"type":"function_call","id":"fc_1","call_id":"call_fx1","name":"lookup","arguments":"{\"key\":\"answer\"}"}"#;

/// The events a Responses SSE stream decodes to, fed in small chunks so framing crosses unit boundaries.
fn decode_frames(frames: &[String]) -> (Vec<StreamEvent>, Option<mixdog_core_api::domain::provider::ProviderError>) {
    let sse: String = frames.iter().map(|frame| format!("data: {frame}\n\n")).collect();
    let mut decoder = codex_codec(TransportKind::Http1).decoder(&request());
    let mut events = Vec::new();
    for chunk in sse.as_bytes().chunks(7) {
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

fn text_frames() -> Vec<String> {
    vec![
        r#"{"type":"response.created","response":{"id":"resp_1","model":"gpt-fixture"}}"#.to_owned(),
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}"#.to_owned(),
        r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"The result is "}"#.to_owned(),
        r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"42."}"#.to_owned(),
        format!(r#"{{"type":"response.output_item.done","output_index":0,"item":{MESSAGE_DONE}}}"#),
    ]
}

#[test]
fn a_text_stream_completes_with_its_usage_and_no_inferred_stop_reason() {
    let mut frames = text_frames();
    frames.push(format!(
        r#"{{"type":"response.completed","response":{{"id":"resp_1","model":"gpt-fixture","status":"completed","usage":{{"input_tokens":20,"output_tokens":8}},"output":[{MESSAGE_DONE}]}}}}"#
    ));
    let (events, err) = decode_frames(&frames);
    assert!(err.is_none(), "{err:?}");
    let text: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
    assert_eq!(text, "The result is 42.");
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Usage(u) if u.input_tokens == 20 && u.output_tokens == 8)));
    assert!(matches!(events.last(), Some(StreamEvent::Completed { stop: None, .. })));
}

#[test]
fn a_tool_call_stream_yields_one_call_with_its_arguments_and_no_stop_reason() {
    let frames = vec![
        r#"{"type":"response.created","response":{"id":"resp_2","model":"gpt-fixture"}}"#.to_owned(),
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_fx1","name":"lookup","arguments":""}}"#.to_owned(),
        r#"{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"key\":\"answer\"}"}"#.to_owned(),
        format!(r#"{{"type":"response.output_item.done","output_index":0,"item":{CALL_DONE}}}"#),
        format!(
            r#"{{"type":"response.completed","response":{{"id":"resp_2","model":"gpt-fixture","status":"completed","usage":{{"input_tokens":12,"output_tokens":5}},"output":[{CALL_DONE}]}}}}"#
        ),
    ];
    let (events, err) = decode_frames(&frames);
    assert!(err.is_none(), "{err:?}");
    let calls: Vec<_> = events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(c) } else { None }).collect();
    assert_eq!(calls.len(), 1);
    assert_eq!((calls[0].id.as_str(), calls[0].name.as_str()), ("call_fx1", "lookup"));
    assert_eq!(calls[0].arguments, json!({"key": "answer"}));
    assert!(matches!(events.last(), Some(StreamEvent::Completed { stop: None, .. })));
}

#[test]
fn a_stream_without_its_terminal_frame_is_a_transient_truncation_that_shows_it_followed_output() {
    let (_, err) = decode_frames(&text_frames());
    let err = err.expect("a truncated stream must error");
    assert_eq!(err.kind, ErrorKind::Transient);
    assert!(err.exposure.text_emitted);
    assert_eq!(err.delivery, DeliveryState::Accepted);
}
