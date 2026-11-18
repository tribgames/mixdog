//! A Responses stream that is cut says which route and transport it was on: the API-key route and the subscription
//! (Codex) route name themselves differently, and each names its WebSocket and its HTTP/SSE form.

use std::sync::Arc;

use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec;
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

fn request() -> ModelRequest {
    ModelRequest {
        model: "gpt-5".into(),
        messages: vec![Message::new(Role::User, Content::Text("go".into()))],
        tools: vec![],
        options: RequestOptions::default(),
    }
}

/// The error text of a stream that starts a tool call and is then cut by the output limit.
fn cut_text(codec: &OpenAiCodec, transport: TransportKind) -> String {
    let mut decoder = codec.decoder(&request());
    let frames = [
        json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "lookup"}}),
        json!({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []}}),
    ];
    let mut message = None;
    for frame in frames {
        let bytes = if transport == TransportKind::WebSocket { frame.to_string() } else { format!("data: {frame}\n\n") };
        if let Err(error) = decoder.feed(bytes.as_bytes()) {
            message = Some(error.message);
        }
    }
    message.expect("a cut stream")
}

fn api_key() -> OpenAiConfig {
    OpenAiConfig::api_key(true, Arc::new(Facts), Arc::new(Ctx))
}

fn codex() -> OpenAiConfig {
    let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() };
    OpenAiConfig::codex(false, identity, Arc::new(Facts), Arc::new(Ctx))
}

#[test]
fn a_cut_stream_names_its_route_and_its_transport() {
    let cases = [
        (api_key(), TransportKind::WebSocket, "OpenAI WS"),
        (api_key(), TransportKind::Http1, "OpenAI HTTP fallback"),
        (codex(), TransportKind::WebSocket, "OpenAI OAuth WS"),
        (codex(), TransportKind::Http1, "OpenAI OAuth HTTP fallback"),
    ];
    for (config, transport, label) in cases {
        let codec = OpenAiCodec::new(config, transport);
        assert_eq!(cut_text(&codec, transport), format!("{label} response.incomplete (max_output_tokens) with tool call in flight"), "{label}");
    }
}

#[test]
fn a_codec_reports_the_labels_of_its_route() {
    let api = OpenAiCodec::new(api_key(), TransportKind::WebSocket);
    assert_eq!((api.ws_label(), api.http_label()), ("OpenAI WS", "OpenAI HTTP fallback"));
    let oauth = OpenAiCodec::new(codex(), TransportKind::WebSocket);
    assert_eq!((oauth.ws_label(), oauth.http_label()), ("OpenAI OAuth WS", "OpenAI OAuth HTTP fallback"));
}
