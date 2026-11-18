//! The request a user-defined (`custom-<id>`) provider sends: the family codec of its protocol encodes it, then the provider's
//! own shaping is layered over it. Extra body fields (the provider's, then the model's over them) go before the stream flags
//! on the Chat wire, never replace a field the app owns; headers layer provider then model, never carry credentials; a
//! Responses request is keyed on the session.

use std::sync::Arc;

use mixdog_ai::catalog::CachedModelInfo;
use mixdog_ai::providers::compat::chat::CustomReplay;
use mixdog_ai::providers::connect::rewrite::Rewriter;
use mixdog_ai::providers::custom::CustomRequestConfig;
use mixdog_ai::providers::custom::CustomRewriter;
use mixdog_ai::providers::custom::Protocol;
use mixdog_ai::providers::custom::ReasoningSource;
use mixdog_ai::providers::custom::chat_codec;
use mixdog_ai::providers::custom::responses_codec;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// A provider that holds no model rows: nothing is known of any model's reasoning.
struct NoRows;

impl CachedModelInfo for NoRows {
    fn cached_row(&self, _: &str) -> Option<Arc<Value>> {
        None
    }
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

fn model_request(options: RequestOptions) -> ModelRequest {
    ModelRequest { model: "m1".into(), messages: vec![Message::new(Role::User, Content::Text("hi".into()))], tools: vec![], options }
}

fn rewriter(wire: Protocol, config: CustomRequestConfig) -> CustomRewriter {
    CustomRewriter { config, wire, reasoning: ReasoningSource { rows: Arc::new(NoRows), configured: None, base_url: "http://gw.example/v1".into() } }
}

fn chat(request: &ModelRequest) -> WireRequest {
    chat_codec("custom-abc", "http://gw.example/v1/", CustomReplay(Arc::new(|_| false))).encode(request).expect("encodes")
}

fn body_of(wire: &WireRequest) -> Map<String, Value> {
    object(serde_json::from_slice(&wire.body).expect("a JSON body"))
}

fn header<'a>(wire: &'a WireRequest, name: &str) -> Option<&'a str> {
    wire.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

#[test]
fn a_chat_request_goes_to_the_chat_completions_endpoint_under_the_configured_base_url() {
    let wire = chat(&model_request(RequestOptions::default()));
    assert_eq!((wire.method.as_str(), wire.url.as_str()), ("POST", "http://gw.example/v1/chat/completions"), "the trailing slash of the base url is dropped");
}

#[test]
fn a_provider_with_no_shaping_sends_the_codecs_request_as_it_is() {
    let request = model_request(RequestOptions::default());
    let encoded = chat(&request);
    let sent = rewriter(Protocol::OpenaiChat, CustomRequestConfig::default()).rewrite(encoded.clone(), &request).expect("rewrites");
    assert_eq!(sent.body, encoded.body);
    assert_eq!(sent.headers, encoded.headers);
}

#[test]
fn extra_body_fields_layer_provider_then_model_and_go_before_the_stream_flags() {
    let request = model_request(RequestOptions::default());
    let encoded = chat(&request);
    let config = CustomRequestConfig {
        request_body: object(json!({ "top_k": 5, "min_p": 0.1 })),
        model_body: object(json!({ "m1": { "top_k": 9 }, "other": { "min_p": 0.9 } })),
        ..CustomRequestConfig::default()
    };
    let sent = rewriter(Protocol::OpenaiChat, config).rewrite(encoded.clone(), &request).expect("rewrites");
    let body = body_of(&sent);
    assert_eq!((body["top_k"].clone(), body["min_p"].clone()), (json!(9), json!(0.1)), "the model's fields win over the provider's; another model's are not used");
    let keys: Vec<&String> = body.keys().collect();
    let position = |key: &str| keys.iter().position(|k| *k == key).unwrap_or_else(|| panic!("{key} in {keys:?}"));
    assert!(position("messages") < position("top_k") && position("top_k") < position("stream"), "{keys:?}");
    assert_eq!(body["messages"], body_of(&encoded)["messages"], "the app's own fields are as encoded");
}

#[test]
fn a_field_the_app_owns_is_never_replaced_by_the_configured_body() {
    let request = model_request(RequestOptions::default());
    let encoded = chat(&request);
    let config = CustomRequestConfig { request_body: object(json!({ "model": "evil", "messages": [], "stream": false, "tools": [] })), ..CustomRequestConfig::default() };
    let sent = rewriter(Protocol::OpenaiChat, config).rewrite(encoded.clone(), &request).expect("rewrites");
    assert_eq!(body_of(&sent), body_of(&encoded));
}

#[test]
fn headers_layer_provider_then_model_and_a_model_header_never_carries_credentials() {
    let request = model_request(RequestOptions::default());
    let encoded = chat(&request);
    let config = CustomRequestConfig {
        headers: vec![("X-Team".into(), "alpha".into()), ("X-Mode".into(), "base".into())],
        model_headers: vec![("m1".into(), vec![("x-mode".into(), "tuned".into()), ("Authorization".into(), "Bearer stolen".into()), ("Host".into(), "evil".into())]), ("other".into(), vec![("X-Other".into(), "1".into())])],
        ..CustomRequestConfig::default()
    };
    let sent = rewriter(Protocol::OpenaiChat, config).rewrite(encoded.clone(), &request).expect("rewrites");
    assert_eq!(header(&sent, "X-Team"), Some("alpha"));
    assert_eq!(header(&sent, "X-Mode"), Some("tuned"), "the model's header replaces the provider's, whatever the case of the name");
    assert_eq!(sent.headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case("x-mode")).count(), 1);
    assert_eq!(header(&sent, "Authorization"), header(&encoded, "Authorization"), "credentials belong to the API key field");
    assert_eq!(header(&sent, "Host"), header(&encoded, "Host"));
    assert_eq!(header(&sent, "X-Other"), None);
}

#[test]
fn a_responses_request_is_keyed_on_the_session_in_its_body_and_headers() {
    let options = RequestOptions { session_id: Some("session-1".into()), ..RequestOptions::default() };
    let request = model_request(options);
    let encoded = responses_codec("custom-abc", "http://gw.example/v1").encode(&request).expect("encodes");
    assert_eq!(encoded.url, "http://gw.example/v1/responses");
    let sent = rewriter(Protocol::OpenaiResponses, CustomRequestConfig::default()).rewrite(encoded, &request).expect("rewrites");
    let key = body_of(&sent)["prompt_cache_key"].as_str().expect("a cache key").to_owned();
    assert!(!key.is_empty());
    assert_eq!((header(&sent, "session-id"), header(&sent, "x-client-request-id")), (Some(key.as_str()), Some(key.as_str())), "the same identity as headers");

    let anonymous = model_request(RequestOptions::default());
    let encoded = responses_codec("custom-abc", "http://gw.example/v1").encode(&anonymous).expect("encodes");
    let sent = rewriter(Protocol::OpenaiResponses, CustomRequestConfig::default()).rewrite(encoded, &anonymous).expect("rewrites");
    assert_eq!(header(&sent, "session-id"), None, "a request with no session has no identity to send");
}

#[test]
fn a_body_that_is_not_json_is_refused_before_it_is_sent() {
    let request = model_request(RequestOptions::default());
    let mut encoded = chat(&request);
    encoded.body = b"not json".to_vec();
    let config = CustomRequestConfig { request_body: object(json!({ "top_k": 5 })), ..CustomRequestConfig::default() };
    let error = rewriter(Protocol::OpenaiChat, config).rewrite(encoded, &request).err().expect("refused");
    assert_eq!(error.kind, ErrorKind::InvalidRequest);
    assert_eq!(error.message, "[custom-provider] request body is not JSON");
}
