//! The label Node puts in front of a cut Responses stream's text, per route and transport: `_wsErrLabel` and `httpLabel`
//! run in Node (`golden/stream_progress.json`), the text the codec's decoder gives asserted whole.

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture file synchronously")]

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

fn golden() -> Value {
    let path = format!("{}/../../fixtures/agent/compact/golden/stream_progress.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "gpt-5".into(),
        messages: vec![Message::new(Role::User, Content::Text("go".into()))],
        tools: vec![],
        options: RequestOptions::default(),
    }
}

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

#[test]
fn a_cut_responses_stream_says_what_node_says_on_every_route() {
    let labels = &golden()["labels"];
    let identity = || CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() };
    for transport in [TransportKind::Http1, TransportKind::WebSocket] {
        let (api_key, codex) = match transport {
            TransportKind::WebSocket => (&labels["apiKeyWs"], &labels["codexWs"]),
            _ => (&labels["apiKeyHttp"], &labels["codexHttp"]),
        };
        let cases = [
            (OpenAiConfig::api_key(true, Arc::new(Facts), Arc::new(Ctx)), api_key),
            (OpenAiConfig::codex(false, false, identity(), Arc::new(Facts), Arc::new(Ctx)), codex),
        ];
        for (config, label) in cases {
            let text = cut_text(&OpenAiCodec::new(config, transport), transport);
            assert_eq!(text, format!("{} response.incomplete (max_output_tokens) with tool call in flight", label.as_str().expect("label")));
        }
    }
}