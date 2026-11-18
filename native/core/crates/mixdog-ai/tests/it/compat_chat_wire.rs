//! The Chat Completions request the compat family and the local provider send, as literals: the endpoint, the body's shape and
//! key order, and how the local runtime's instructions are merged.

use mixdog_ai::providers::compat::CompatChatCodec;
use mixdog_ai::providers::compat::CompatConfig;
use mixdog_ai::providers::compat::CompatProfile;
use mixdog_ai::providers::compat::profile::CredentialKind;
use mixdog_ai::providers::local::merge_instructions;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;
use serde_json::json;

fn text(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

fn lookup() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}),
        defer_loading: false,
        freeform: None,
    }
}

fn groq() -> CompatChatCodec {
    CompatChatCodec::new(CompatProfile::plain("groq", "https://api.groq.com/v1", CredentialKind::StaticKey { reauth_on_401: false }), CompatConfig::default())
}

fn body(codec: &CompatChatCodec, request: &ModelRequest) -> Value {
    serde_json::from_slice(&codec.encode(request).expect("encodes").body).expect("a JSON body")
}

#[test]
fn a_chat_request_posts_to_the_chat_completions_endpoint_of_the_base_url() {
    let request = ModelRequest { model: "m".into(), messages: vec![text(Role::User, "hi")], tools: vec![], options: RequestOptions::default() };
    let wire = groq().encode(&request).expect("encodes");
    assert_eq!((wire.method.as_str(), wire.url.as_str()), ("POST", "https://api.groq.com/v1/chat/completions"));
}

#[test]
fn the_body_carries_the_model_messages_tools_and_the_streaming_flags_in_that_order() {
    let request = ModelRequest {
        model: "fixture-model".into(),
        messages: vec![text(Role::System, "You are a fixture assistant."), text(Role::User, "Look up the answer.")],
        tools: vec![lookup()],
        options: RequestOptions::default(),
    };
    let body = body(&groq(), &request);
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["messages"], json!([{"role": "system", "content": "You are a fixture assistant."}, {"role": "user", "content": "Look up the answer."}]));
    assert_eq!(
        body["tools"],
        json!([{"type": "function", "function": {"name": "lookup", "description": "Read a value", "parameters": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}}}])
    );
    assert_eq!((&body["stream"], &body["stream_options"]), (&json!(true), &json!({"include_usage": true})));
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    let at = |key: &str| keys.iter().position(|k| *k == key).unwrap_or_else(|| panic!("{key} missing in {keys:?}"));
    assert_eq!(at("model"), 0);
    assert!(at("messages") < at("tools") && at("tools") < at("stream") && at("stream") < at("stream_options"), "{keys:?}");
}

#[test]
fn a_tool_call_and_its_result_are_sent_as_an_assistant_call_then_a_tool_message() {
    let mut call = text(Role::Assistant, "");
    call.tool_calls = vec![ToolCall { id: "call_fx1".into(), name: "lookup".into(), arguments: json!({"key": "answer"}), native_type: None }];
    let mut result = text(Role::Tool, "42");
    result.tool_call_id = Some("call_fx1".into());
    let request = ModelRequest { model: "m".into(), messages: vec![text(Role::User, "go"), call, result], tools: vec![lookup()], options: RequestOptions::default() };
    let messages = body(&groq(), &request)["messages"].clone();
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["tool_calls"][0]["id"], "call_fx1");
    assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "lookup");
    assert_eq!(messages[1]["tool_calls"][0]["function"]["arguments"], "{\"key\":\"answer\"}", "arguments travel as JSON text");
    assert_eq!(messages[2], json!({"role": "tool", "tool_call_id": "call_fx1", "content": "42"}));
}

#[test]
fn an_empty_model_name_is_sent_as_the_profiles_default_model() {
    let profile = CompatProfile::plain("groq", "https://api.groq.com/v1", CredentialKind::StaticKey { reauth_on_401: false });
    let default = profile.default_model;
    let request = ModelRequest { model: String::new(), messages: vec![text(Role::User, "hi")], tools: vec![], options: RequestOptions::default() };
    let sent = body(&CompatChatCodec::new(profile, CompatConfig::default()), &request);
    assert_eq!(sent["model"], default);
}

#[test]
fn the_local_runtime_receives_every_instruction_as_one_leading_system_message() {
    let mut sent = json!({"messages": [
        {"role": "system", "content": "one"},
        {"role": "user", "content": "hi"},
        {"role": "developer", "content": [{"type": "text", "text": "two"}, {"type": "text", "text": "three"}]},
        {"role": "assistant", "content": "ok"},
    ]});
    merge_instructions(&mut sent).expect("text only");
    assert_eq!(sent["messages"], json!([
        {"role": "system", "content": "one\n\ntwo\n\nthree"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "ok"},
    ]));
}

#[test]
fn local_instructions_that_are_not_text_are_refused_and_a_body_without_any_is_unchanged() {
    let mut media = json!({"messages": [{"role": "system", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]});
    let refused = merge_instructions(&mut media).expect_err("media instructions");
    assert!(refused.message.contains("must contain text only"), "{}", refused.message);
    let mut plain = json!({"messages": [{"role": "user", "content": "hi"}]});
    let before = plain.clone();
    merge_instructions(&mut plain).expect("nothing to merge");
    assert_eq!(plain, before);
}