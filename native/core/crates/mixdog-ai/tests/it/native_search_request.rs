//! A tool message carrying Node's native tool-search payload (the payloads `parseNativeToolSearchPayload`
//! made of recorded Skill results, `fixtures/native-tool-search/golden.json`) goes out of the Responses
//! request as Node's `buildRequestBody` sends it: the `input` array, key order included.

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
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/native-tool-search/golden.json");

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
        ModelFacts { native_tool_search: Some(true), ..ModelFacts::default() }
    }
}

/// A recorded Node transcript message as the neutral message.
fn message_of(node: &Value) -> Message {
    let text = node["content"].as_str().expect("text content").to_owned();
    match node["role"].as_str().expect("role") {
        "user" => Message::new(Role::User, Content::Text(text)),
        "assistant" => {
            let mut message = Message::new(Role::Assistant, Content::Text(text));
            message.tool_calls = node["toolCalls"]
                .as_array()
                .expect("calls")
                .iter()
                .map(|call| ToolCall {
                    id: call["id"].as_str().expect("id").to_owned(),
                    name: call["name"].as_str().expect("name").to_owned(),
                    arguments: call["arguments"].clone(),
                    native_type: None,
                })
                .collect();
            message
        }
        "tool" => {
            let mut message = Message::new(Role::Tool, Content::Text(text));
            message.tool_call_id = Some(node["toolCallId"].as_str().expect("call id").to_owned());
            message.native_tool_search = node.get("nativeToolSearch").cloned();
            message
        }
        other => panic!("role {other}"),
    }
}

fn eager(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_owned(),
        description: format!("{name} tool"),
        input_schema: serde_json::json!({"type": "object", "properties": {}}),
        defer_loading: false,
        freeform: None,
    }
}

#[test]
fn a_native_search_result_is_lowered_as_node_lowers_it() {
    let golden: Value = serde_json::from_str(&GOLDEN).expect("the golden is JSON");
    let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "0.166.0".into(), beta_features: "remote_compaction_v2".into() };
    let codec = OpenAiCodec::new(OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx)), TransportKind::Http1);
    let mut compared = 0;
    for case in golden["requests"].as_array().expect("requests").iter().filter(|case| case["wire"] == "openai") {
        let request = ModelRequest {
            model: "gpt-6-astra".to_owned(),
            messages: case["messages"].as_array().expect("messages").iter().map(message_of).collect(),
            tools: vec![eager("Skill"), eager("read")],
            options: RequestOptions::default(),
        };
        let wire = codec.encode(&request).expect("the request encodes");
        let body: Value = serde_json::from_slice(&wire.body).expect("the body is JSON");
        assert_eq!(serde_json::to_string(&body["input"]).unwrap(), serde_json::to_string(&case["input"]).unwrap(), "{}", case["name"]);
        compared += 1;
    }
    assert_eq!(compared, 3);
}
