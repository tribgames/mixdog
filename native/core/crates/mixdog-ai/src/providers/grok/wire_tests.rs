//! The Grok request against Node's own: `wire/node_wire.json` is what the real `GrokOAuthProvider` of b6f10295a put on
//! the wire (url, headers and the whole body) for the recorded messages, tools and send options, written by
//! `wire/record.mjs`. Nothing is left out of the comparison: every header the recording holds is expected, and no
//! other header may be present.

use std::sync::Arc;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;

use super::GrokRewriter;
use super::codec;
use super::sdk_headers_for;
use crate::providers::connect::rewrite::RewriteCodec;

fn recording() -> Value {
    serde_json::from_str(include_str!("wire/node_wire.json")).unwrap()
}

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

/// The recorded Node inputs as the Rust request, so both sides send the same conversation.
fn request(recorded: &Value) -> ModelRequest {
    let send = &recorded["send"];
    let messages = recorded["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let role = match m["role"].as_str().unwrap() {
                "system" => Role::System,
                "user" => Role::User,
                "assistant" => Role::Assistant,
                _ => Role::Tool,
            };
            let mut message = Message::new(role, Content::Text(text(&m["content"])));
            for call in m["toolCalls"].as_array().into_iter().flatten() {
                message.tool_calls.push(ToolCall { id: text(&call["id"]), name: text(&call["name"]), arguments: call["arguments"].clone(), native_type: None });
            }
            message.tool_call_id = m["toolCallId"].as_str().map(str::to_owned);
            message
        })
        .collect();
    let tools = recorded["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| ToolDefinition { name: text(&t["name"]), description: text(&t["description"]), input_schema: t["inputSchema"].clone(), defer_loading: false, freeform: None })
        .collect();
    let options = RequestOptions {
        session_id: Some(text(&send["sessionId"])),
        prompt_cache_key: Some(text(&send["promptCacheKey"])),
        iteration: send["iteration"].as_u64().unwrap() as u32,
        ..RequestOptions::default()
    };
    ModelRequest { model: text(&send["model"]), messages, tools, options }
}

fn sorted(pairs: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut pairs: Vec<_> = pairs.into_iter().map(|(k, v)| (k.to_lowercase(), v)).collect();
    pairs.sort();
    pairs
}

/// Url, headers and body the Rust codec makes for the recorded request. The platform headers are those of the host Node
/// ran on, which the recording names.
fn encode(recorded: &Value, request_id: fn() -> String) -> (String, Vec<(String, String)>, Value) {
    let version = "1.0.70";
    let host = &recorded["host"];
    let rewriter = GrokRewriter { client_version: version.into(), user_id: Arc::new(|| None), request_id, sdk_headers: sdk_headers_for(host["platform"].as_str().unwrap(), host["arch"].as_str().unwrap(), host["version"].as_str().unwrap()) };
    let wire = RewriteCodec::new(codec(version), rewriter).encode(&request(recorded)).unwrap();
    (wire.url, sorted(wire.headers), serde_json::from_slice(&wire.body).unwrap())
}

#[test]
fn the_grok_request_is_what_node_sent_url_headers_and_whole_body() {
    let recorded = recording();
    assert_eq!(recorded["node"], "b6f10295a");
    let (url, headers, body) = encode(&recorded, || "rec-request-id".to_owned());
    let node = &recorded["request"];
    assert_eq!(url, node["url"].as_str().unwrap());
    let want = sorted(node["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), text(v))));
    assert_eq!(headers, want);
    assert_eq!(body, node["body"]);
}
