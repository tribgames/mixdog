//! `capture-size-cases`, "provider preparation does not rescale an already bound computer frame": a computer frame Node
//! fitted with `computerCaptureSize` goes out of the Anthropic Messages request with its bytes and its media type
//! unchanged (Node `prepareAnthropicImages` returned the messages it was given). The core's preparation is the
//! codec's lowering of the request.

use std::sync::Arc;

use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::CacheStrategy;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_testkit::exact::Exact;
use serde_json::Value;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/capture-size-cases/golden.json");
const CASE: &str = "provider preparation does not rescale an already bound computer frame";

/// A recorded Anthropic user message of image parts as the neutral message the core lowers.
fn message_of(node: &Value) -> Message {
    assert_eq!(node["role"], "user", "recording: a user message");
    let parts = node["content"]
        .as_array()
        .expect("recording: content parts")
        .iter()
        .map(|part| {
            let source = &part["source"];
            assert_eq!((&part["type"], &source["type"]), (&Value::from("image"), &Value::from("base64")), "recording: a base64 image part");
            ContentPart::Image(ImageSource::Base64 {
                data: source["data"].as_str().expect("image data").to_owned(),
                mime_type: source["media_type"].as_str().expect("media type").to_owned(),
            })
        })
        .collect();
    Message::new(Role::User, Content::Parts(parts))
}

#[test]
fn provider_preparation_does_not_rescale_an_already_bound_computer_frame() {
    let golden = Exact::decode(&serde_json::from_str(&GOLDEN).expect("golden is JSON")).expect("golden decodes");
    let recorded = golden
        .get("cases")
        .as_array()
        .iter()
        .find(|case| case.get("case").as_str() == CASE)
        .unwrap_or_else(|| panic!("recording: no case {CASE:?}"))
        .get("observed");
    let input = recorded.get("input").to_plain().expect("plain input");

    let mut config = AnthropicConfig::new(Arc::new(|_: &str| None));
    // The recorded preparation saw messages without cache breakpoints; a session whose cache strategy leaves the
    // message layer unmarked sends exactly that.
    config.cache = CacheStrategy { system: None, tier3: None, messages: None };
    let codec = AnthropicCodec::new(Flavor::ApiKey, config);
    let request = ModelRequest {
        model: "claude-sonnet-4-5".to_owned(),
        messages: input.as_array().expect("recording: a message list").iter().map(message_of).collect(),
        tools: Vec::new(),
        options: RequestOptions::default(),
    };
    let wire = codec.encode(&request).expect("the request encodes");
    let body: Value = serde_json::from_slice(&wire.body).expect("the body is JSON");
    // `sentMetadata` is sharp's reading of the image bytes sent; they are the recorded frame's bytes, compared here.
    assert_eq!(Exact::plain(&body["messages"]), *recorded.get("messages"));
}
