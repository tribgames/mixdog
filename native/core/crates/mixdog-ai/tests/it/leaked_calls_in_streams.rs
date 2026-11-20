//! A model that writes its tool call as markup in the text of a streamed answer: through each provider's own decoder (the
//! one its codec hands out), the markup is not shown and a call for an offered tool comes out as a tool call; markup for a
//! tool that was not offered stays text.

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_ai::providers::compat::chat::ChatDecoder;
use mixdog_ai::providers::compat::profile::CompatProfile;
use mixdog_ai::providers::compat::profile::CredentialKind;
use mixdog_ai::providers::cursor::decoder::CursorDecoder;
use mixdog_ai::providers::cursor::request::BlobStore;
use mixdog_ai::providers::google::decode::DecodeDialect;
use mixdog_ai::providers::google::decode::GeminiDecoder;
use mixdog_ai::providers::google::decode::UsageStyle;
use mixdog_ai::providers::google::error::ErrorDialect;
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
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

const BEFORE: &str = "Let me look. ";
const CALL: &str = r#"<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>"#;

/// The text, split in two inside the markup.
fn pieces() -> [String; 2] {
    let text = format!("{BEFORE}{CALL}");
    let cut = BEFORE.len() + 20;
    [text[..cut].to_owned(), text[cut..].to_owned()]
}

fn request(tool: &str) -> ModelRequest {
    ModelRequest {
        model: "claude-sonnet-4-6".into(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
        tools: vec![ToolDefinition {
            name: tool.into(),
            description: String::new(),
            input_schema: json!({ "type": "object", "properties": {} }),
            defer_loading: false,
            freeform: None,
        }],
        options: RequestOptions::default(),
    }
}

fn known(tool: &str) -> HashSet<String> {
    [tool.to_owned()].into_iter().collect()
}

fn drive(decoder: &mut dyn WireDecoder, units: &[Vec<u8>]) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    for unit in units {
        events.extend(decoder.feed(unit).expect("the unit decodes"));
    }
    events.extend(decoder.finish().expect("the stream finishes"));
    events
}

fn sse(event: &Value) -> Vec<u8> {
    format!("data: {event}\n\n").into_bytes()
}

fn anthropic(tool: &str) -> Vec<StreamEvent> {
    let codec = AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(Arc::new(|_: &str| None)));
    let mut decoder = codec.decoder(&request(tool));
    let named = |event: Value| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap()).into_bytes();
    let mut units = vec![
        named(json!({ "type": "message_start", "message": { "model": "claude-sonnet-4-6", "usage": { "input_tokens": 1 } } })),
        named(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
    ];
    units.extend(pieces().iter().map(|p| named(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": p } }))));
    units.push(named(json!({ "type": "content_block_stop", "index": 0 })));
    units.push(named(json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 5 } })));
    units.push(named(json!({ "type": "message_stop" })));
    drive(decoder.as_mut(), &units)
}

fn chat(tool: &str) -> Vec<StreamEvent> {
    let profile = CompatProfile::plain("gateway", "https://gateway.invalid/v1", CredentialKind::StaticKey { reauth_on_401: false });
    let mut decoder = ChatDecoder::new(profile, ProviderId::from("gateway")).with_known_tools(known(tool));
    let chunk =
        |delta: Value, finish: Option<&str>| sse(&json!({ "id": "c1", "model": "m", "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] }));
    let [a, b] = pieces();
    let units = vec![chunk(json!({ "content": a }), None), chunk(json!({ "content": b }), None), chunk(json!({}), Some("stop")), b"data: [DONE]\n\n".to_vec()];
    drive(&mut decoder, &units)
}

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

fn responses(tool: &str) -> Vec<StreamEvent> {
    let identity = CodexIdentity { installation_id: "i".into(), user_agent: "codex/1".into(), version: "0.1.0".into(), beta_features: "none".into() };
    let codec = OpenAiCodec::new(OpenAiConfig::codex(false, identity, Arc::new(Facts), Arc::new(Ctx)), TransportKind::Http1);
    let mut decoder = codec.decoder(&request(tool));
    let [a, b] = pieces();
    let full = format!("{a}{b}");
    let units = vec![
        sse(&json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_1", "delta": a })),
        sse(&json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_1", "delta": b })),
        sse(
            &json!({ "type": "response.completed", "response": { "id": "r1", "model": "m", "status": "completed", "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 },
            "output": [{ "type": "message", "id": "msg_1", "role": "assistant", "content": [{ "type": "output_text", "text": full }] }] } }),
        ),
    ];
    drive(decoder.as_mut(), &units)
}

fn gemini(tool: &str) -> Vec<StreamEvent> {
    let mut decoder = GeminiDecoder::new(DecodeDialect {
        owner: ProviderId::from("gemini"),
        envelope: false,
        usage: UsageStyle::Inclusive,
        errors: ErrorDialect::gemini("Gemini REST streamGenerateContent"),
    })
    .with_known_tools(known(tool));
    let [a, b] = pieces();
    let chunk = |text: &str, finish: Option<&str>| {
        let mut candidate = json!({ "content": { "role": "model", "parts": [{ "text": text }] } });
        if let Some(finish) = finish {
            candidate["finishReason"] = finish.into();
        }
        format!("data: {}\r\n\r\n", json!({ "candidates": [candidate] })).into_bytes()
    };
    drive(&mut decoder, &[chunk(&a, None), chunk(&b, Some("STOP"))])
}

fn varint(mut value: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

fn field(number: u8, body: &[u8]) -> Vec<u8> {
    [vec![number << 3 | 2], varint(body.len()), body.to_vec()].concat()
}

/// One Connect frame carrying a server message whose interaction update is `update`.
fn frame(update: &[u8]) -> Vec<u8> {
    let payload = field(1, update);
    [vec![0], (payload.len() as u32).to_be_bytes().to_vec(), payload].concat()
}

fn cursor(tool: &str) -> Vec<StreamEvent> {
    let mut decoder = CursorDecoder::new(BlobStore::default(), Vec::new(), None).with_known_tools(known(tool));
    let text = |piece: &str| frame(&field(1, &field(1, piece.as_bytes())));
    let [a, b] = pieces();
    drive(&mut decoder, &[text(&a), text(&b), frame(&field(14, &[]))])
}

fn shown(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect()
}

fn calls(events: &[StreamEvent]) -> Vec<(String, Value, String)> {
    events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some((c.name.clone(), c.arguments.clone(), c.id.clone())) } else { None }).collect()
}

const PROVIDERS: [(&str, fn(&str) -> Vec<StreamEvent>); 5] =
    [("anthropic", anthropic), ("chat", chat), ("responses", responses), ("gemini", gemini), ("cursor", cursor)];

#[test]
fn a_leaked_call_in_the_text_of_each_providers_stream_comes_out_as_a_tool_call_and_the_markup_is_not_shown() {
    for (name, run) in PROVIDERS {
        let events = run("read");
        let found = calls(&events);
        assert_eq!(found.len(), 1, "{name}: {events:?}");
        assert_eq!((found[0].0.as_str(), &found[0].1), ("read", &json!({ "path": "a.txt" })), "{name}");
        assert!(found[0].2.contains("_leaked_"), "{name}: the id says it was recovered: {}", found[0].2);
        let text = shown(&events);
        assert_eq!(text.trim_end(), BEFORE.trim_end(), "{name}");
        assert!(!text.contains('<'), "{name}: {text}");
    }
}

#[test]
fn markup_for_a_tool_the_request_did_not_offer_stays_text_in_each_providers_stream() {
    for (name, run) in PROVIDERS {
        let events = run("write");
        assert!(calls(&events).is_empty(), "{name}: {events:?}");
        assert_eq!(shown(&events), format!("{BEFORE}{CALL}"), "{name}");
    }
}
