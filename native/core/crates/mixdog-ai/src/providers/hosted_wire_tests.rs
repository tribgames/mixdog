//! A provider's own web search on the wire, per provider, against Node's recordings (`fixtures/provider-wire/hosted-search`):
//! the request `sendCandidate` makes (native-web-search.mjs:63-77) is built as the hosted sender builds it, with the tool
//! read by the production reader ([`super::hosted::web_search_from_node`]), and sent by the provider the production
//! builder builds from the recorded configuration over the recorder's hub; every request is compared whole with Node's,
//! the recorded answer (the search call, its sources and a citation as each wire reports them) whole with Node's result,
//! and the stream callbacks in order.

#[cfg(node_twin)]
use std::sync::Arc;

#[cfg(node_twin)]
use mixdog_core_api::domain::provider::Content;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::Message;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ModelRequest;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::RequestOptions;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::Role;
#[cfg(node_twin)]
use serde_json::Value;

#[cfg(node_twin)]
use super::anthropic::ModelCaps;
#[cfg(node_twin)]
use super::google::traits::ModelTraits;
#[cfg(node_twin)]
use super::google::traits::ThinkingControl;
#[cfg(node_twin)]
use super::hosted::web_search_from_node;
#[cfg(node_twin)]
use super::openai::config::CodexIdentity;
#[cfg(node_twin)]
use super::openai::config::ModelFacts;
#[cfg(node_twin)]
use super::openai::config::ModelFactsSource;
#[cfg(node_twin)]
use super::wire_fixtures::Hub;
#[cfg(node_twin)]
use super::wire_fixtures::Inputs;
#[cfg(node_twin)]
use super::wire_fixtures::Recorded;
#[cfg(node_twin)]
use super::wire_fixtures::assert_same_events;
#[cfg(node_twin)]
use super::wire_fixtures::assert_same_requests;
#[cfg(node_twin)]
use super::wire_fixtures::assert_same_result;
#[cfg(node_twin)]
use super::wire_fixtures::attempt;
#[cfg(node_twin)]
use super::wire_fixtures::built;
#[cfg(node_twin)]
use super::wire_fixtures::core_result;
#[cfg(node_twin)]
use super::wire_fixtures::load;
#[cfg(node_twin)]
use super::wire_fixtures::node_result;
#[cfg(node_twin)]
use super::wire_fixtures::scenarios;

#[cfg(node_twin)]
/// The catalog row of gpt-5.2: reasoning with summaries, verbosity, a 24 h cache lifetime.
struct Gpt;
#[cfg(node_twin)]
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

#[cfg(node_twin)]
struct Gemini;
#[cfg(node_twin)]
impl ModelTraits for Gemini {
    fn is_gemini_family(&self, model: &str) -> bool {
        model.starts_with("gemini")
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

/// What the recorder's providers read beside their configuration: Node's catalog for claude-sonnet-4-6 (adaptive
/// thinking with effort, 16k output), the Gemini traits, the gpt-5.2 row, and the recording machine's Codex identity
/// (its OS in the user agent; declared in the manifest).
#[cfg(node_twin)]
pub(crate) fn inputs() -> Inputs {
    Inputs {
        caps: Arc::new(|_: &str| {
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
        }),
        traits: Arc::new(Gemini),
        facts: Arc::new(Gpt),
        codex: CodexIdentity {
            installation_id: "i".into(),
            user_agent: "codex_cli_rs/0.166.0 (Windows 10.0.26300; x86_64) unknown".into(),
            version: "0.166.0".into(),
            beta_features: "remote_compaction_v2".into(),
        },
    }
}

/// The hosted sender's request (`request_of`, mixdog-tools `web/hosted_sender.rs`) for Node's send arguments.
#[cfg(node_twin)]
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

#[cfg(node_twin)]
#[tokio::test]
async fn every_provider_sends_its_hosted_search_as_node_does() {
    let names = scenarios("hosted-search");
    assert_eq!(names.len(), 7, "{names:?}");
    for name in names {
        let recorded = load("hosted-search", &name);
        let hub = Hub::new(&recorded);
        let (adapter, _dir) = built(&recorded, hub.clone(), inputs()).await;
        let request = Arc::new(request(&recorded));
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        // Drawn per send: Antigravity's request id (`agent-<randomUUID>`).
        let drawn: &[&str] = if name == "antigravity-oauth" { &["requestId"] } else { &[] };
        assert_same_requests(&hub.sent(), &recorded, drawn, &name);
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
    }
}
