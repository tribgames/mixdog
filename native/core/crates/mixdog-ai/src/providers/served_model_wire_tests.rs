//! The model a compatible provider's answer names, against Node's recordings (`fixtures/provider-wire/served-model`,
//! recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs` through each provider's own Node class): Node
//! reports `response.model || useModel` (openai-compat-chat-send.mjs:321, chunk-events.mjs:56; Muse Code always sends
//! Responses). Each recorded answer is decoded by the provider's real codec and compared whole with Node's result.

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec;

use super::compat::CompatChatCodec;
use super::compat::CompatConfig;
use super::compat::CompatProfile;
use super::compat::responses::CompatResponsesCodec;
use super::wire_fixtures::assert_same_result;
use super::wire_fixtures::core_result;
use super::wire_fixtures::load;
use super::wire_fixtures::node_result;
use super::wire_fixtures::scenarios;

fn codec(provider: &str) -> Box<dyn WireCodec> {
    let chat = |profile: CompatProfile| -> Box<dyn WireCodec> { Box::new(CompatChatCodec::new(profile, CompatConfig::default())) };
    match provider {
        "xai" => chat(CompatProfile::xai()),
        "deepseek" => chat(CompatProfile::deepseek()),
        "openrouter" => chat(CompatProfile::openrouter()),
        "mimo-oauth" => chat(CompatProfile::mimo_oauth()),
        "command-code-oauth" => chat(CompatProfile::command_code_oauth()),
        "opencode-go-oauth" => chat(CompatProfile::opencode_go()),
        "muse-code-oauth" => Box::new(CompatResponsesCodec::new(CompatProfile::muse_code_oauth(), CompatConfig::default(), TransportKind::Http1)),
        other => panic!("no codec for {other}"),
    }
}

#[test]
fn every_compatible_provider_reports_the_model_that_answered() {
    let names = scenarios("served-model");
    assert_eq!(names.len(), 7, "{names:?}");
    for name in names {
        let recorded = load("served-model", &name);
        let model = recorded.input["model"].as_str().unwrap();
        let request = ModelRequest {
            model: model.to_owned(),
            messages: recorded.input["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| {
                    let role = if m["role"] == "system" { Role::System } else { Role::User };
                    Message::new(role, Content::Text(m["content"].as_str().unwrap().to_owned()))
                })
                .collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let posts = recorded.posts("");
        assert_eq!(posts.len(), 1, "{name}: one send");
        let codec = codec(&name);
        let mut decoder = codec.decoder(&request);
        let mut events = decoder.feed(posts[0]["served"].as_str().unwrap().as_bytes()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        events.extend(decoder.finish().unwrap_or_else(|e| panic!("{name}: {e:?}")));
        assert_same_result(&core_result(&events, model), &node_result(&recorded.result), &format!("{name}: result"));
    }
}
