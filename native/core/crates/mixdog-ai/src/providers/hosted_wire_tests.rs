//! A provider's own web search on the wire, per provider, against Node's recordings (`fixtures/provider-wire/hosted-search`):
//! the request `sendCandidate` makes (native-web-search.mjs:63-77) is built as the hosted sender builds it, with the tool
//! read by the production reader ([`super::hosted::web_search_from_node`]), encoded by the provider's real codec and
//! compared with the bytes Node sent; the recorded answer (the search call, its sources and a citation as each wire
//! reports them) is decoded by the same codec and compared whole with Node's result.

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;

use super::anthropic::AnthropicCodec;
use super::anthropic::AnthropicConfig;
use super::anthropic::Flavor;
use super::anthropic::ModelCaps;
use super::google::auth::antigravity::ENDPOINT;
use super::google::codec::GEMINI_ORIGIN;
use super::google::codec::GoogleCodec;
use super::google::traits::ModelTraits;
use super::google::traits::ThinkingControl;
use super::hosted::web_search_from_node;
use super::openai::codec::OpenAiCodec;
use super::openai::config::CodexIdentity;
use super::openai::config::ModelFacts;
use super::openai::config::ModelFactsSource;
use super::openai::config::OpenAiConfig;
use super::openai::config::WireContext;
use super::wire_fixtures::Recorded;
use super::wire_fixtures::assert_same_result;
use super::wire_fixtures::core_result;
use super::wire_fixtures::load;
use super::wire_fixtures::node_result;
use super::wire_fixtures::scenarios;

struct Ctx;
impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _: &str, _: &str) -> Option<String> {
        None
    }
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

/// The catalog row of gpt-5.2: reasoning with summaries, verbosity, a 24 h cache lifetime.
struct Gpt;
impl ModelFactsSource for Gpt {
    fn facts(&self, _: &str) -> ModelFacts {
        ModelFacts {
            reasoning: Some(true),
            reasoning_summaries: Some(true),
            verbosity: Some(true),
            native_tool_search: Some(true),
            prompt_cache: super::openai::config::PromptCacheLifetime::Retention24h,
            ..ModelFacts::default()
        }
    }
}

struct Gemini;
impl ModelTraits for Gemini {
    fn is_gemini_family(&self, model: &str) -> bool {
        model.starts_with("gemini")
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

fn anthropic_config(base: &str) -> AnthropicConfig {
    let mut config = AnthropicConfig::new(Arc::new(|_: &str| {
        Some(ModelCaps {
            adaptive_thinking: true,
            manual_thinking: false,
            ladder_stated: false,
            effort_levels: vec!["low".into(), "medium".into(), "high".into()],
            max_output_tokens: Some(16384),
            fast_mode: false,
            context_window: None,
            thinking_display_updates: false,
        })
    }));
    config.base_url = base.to_owned();
    config
}

fn codec(provider: &str) -> Box<dyn WireCodec> {
    let codex = || CodexIdentity {
        installation_id: "i".into(),
        user_agent: "ua".into(),
        version: "0.166.0".into(),
        beta_features: "b".into(),
    };
    match provider {
        "openai" => Box::new(OpenAiCodec::new(OpenAiConfig::api_key(true, Arc::new(Gpt), Arc::new(Ctx)), TransportKind::Http1)),
        "openai-oauth" => {
            Box::new(OpenAiCodec::new(OpenAiConfig::codex(false, false, codex(), Arc::new(Gpt), Arc::new(Ctx)), TransportKind::Http1))
        }
        "anthropic" => Box::new(AnthropicCodec::new(Flavor::ApiKey, anthropic_config("https://api.anthropic.com"))),
        "anthropic-oauth" => Box::new(AnthropicCodec::new(Flavor::OAuth, anthropic_config("https://api.anthropic.com"))),
        "gemini" => Box::new(GoogleCodec::gemini(GEMINI_ORIGIN, Arc::new(Gemini))),
        "antigravity-oauth" => Box::new(GoogleCodec::antigravity(ENDPOINT, "fixture-project", "2.19.1", Arc::new(Gemini))),
        "grok-oauth" => super::grok::codec(super::grok::CLIENT_VERSION_FLOOR).into_box(),
        other => panic!("no codec for {other}"),
    }
}

trait IntoBox {
    fn into_box(self) -> Box<dyn WireCodec>;
}

impl IntoBox for Arc<dyn WireCodec> {
    fn into_box(self) -> Box<dyn WireCodec> {
        struct Shared(Arc<dyn WireCodec>);
        impl WireCodec for Shared {
            fn transport(&self) -> TransportKind {
                self.0.transport()
            }
            fn encode(&self, request: &ModelRequest) -> Result<mixdog_core_api::domain::provider::WireRequest, mixdog_core_api::domain::provider::ProviderError> {
                self.0.encode(request)
            }
            fn decoder(&self, request: &ModelRequest) -> Box<dyn mixdog_core_api::domain::provider::WireDecoder> {
                self.0.decoder(request)
            }
            fn classify(&self, response: &mixdog_core_api::domain::provider::ErrorResponse) -> mixdog_core_api::domain::provider::ProviderError {
                self.0.classify(response)
            }
        }
        Box::new(Shared(self))
    }
}

/// The hosted sender's request (`request_of`, mixdog-tools `web/hosted_sender.rs`) for Node's send arguments.
fn request(recorded: &Recorded) -> ModelRequest {
    let input = &recorded.input;
    let opts = &input["opts"];
    let provider = input["provider"].as_str().unwrap();
    let text = |m: &Value| m["content"].as_str().unwrap().to_owned();
    let messages = input["messages"].as_array().unwrap();
    let include: Vec<String> = opts["nativeInclude"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
    ModelRequest {
        model: input["model"].as_str().unwrap().to_owned(),
        messages: vec![Message::new(Role::System, Content::Text(text(&messages[0]))), Message::new(Role::User, Content::Text(text(&messages[1])))],
        tools: Vec::new(),
        options: RequestOptions {
            session_id: Some(opts["sessionId"].as_str().unwrap().to_owned()),
            effort: opts["effort"].as_str().map(str::to_owned),
            fast: opts["fast"].as_bool().unwrap(),
            tool_choice: Some(opts["toolChoice"].as_str().unwrap().to_owned()),
            model_parameters: Some(opts["modelParameters"].clone()),
            hosted_tools: opts["nativeTools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| web_search_from_node(tool, provider.starts_with("anthropic"), &include))
                .collect(),
            ..RequestOptions::default()
        },
    }
}

fn decoded(codec: &dyn WireCodec, request: &ModelRequest, served: &str) -> Vec<StreamEvent> {
    let mut decoder = codec.decoder(request);
    let mut events = decoder.feed(served.as_bytes()).expect("recorded stream");
    events.extend(decoder.finish().expect("recorded stream ends"));
    events
}

/// The JSON of a body with the given top-level keys removed, for the fields a send draws at random.
fn without(body: &str, keys: &[&str]) -> Value {
    let mut value: Value = serde_json::from_str(body).unwrap();
    for key in keys {
        value.as_object_mut().unwrap().shift_remove(*key);
    }
    value
}

#[test]
fn every_provider_sends_its_hosted_search_as_node_does() {
    let names = scenarios("hosted-search");
    assert_eq!(names.len(), 7, "{names:?}");
    for name in names {
        let recorded = load("hosted-search", &name);
        let codec = codec(&name);
        let request = request(&recorded);
        let wire = codec.encode(&request).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let posts = recorded.posts("");
        assert_eq!(posts.len(), 1, "{name}: one send");
        let post = posts[0];
        assert_eq!(wire.url, format!("{}{}", post["origin"].as_str().unwrap(), post["path"].as_str().unwrap()), "{name}: url");
        let sent = String::from_utf8(wire.body).unwrap();
        let node = post["bodyText"].as_str().unwrap();
        match name.as_str() {
            // Drawn per send: Antigravity's request id (`agent-<randomUUID>`).
            "antigravity-oauth" => assert_eq!(without(&sent, &["requestId"]), without(node, &["requestId"]), "{name}: body"),
            _ => assert_eq!(sent, node, "{name}: body bytes"),
        }
        let events = decoded(codec.as_ref(), &request, post["served"].as_str().unwrap());
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
    }
}
