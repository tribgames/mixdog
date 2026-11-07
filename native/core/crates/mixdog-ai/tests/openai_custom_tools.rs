//! A freeform tool (`apply_patch`) goes out of the Responses request as Node's `custom` tool
//! (`fixtures/custom-tool-wire/golden.json`, `record-custom-tool-wire.mjs`: the real
//! `buildRequestBody` on the Codex route and the public API route): the tools array, key order
//! included, and which tools were left out.

use std::sync::Arc;
use std::sync::Mutex;

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
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::ToolExclusionSink;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::tool::Freeform;
use serde_json::Value;

const GOLDEN: &str = include_str!("../../../fixtures/custom-tool-wire/golden.json");

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

/// The catalog's word on native tool search for every model of the case.
struct Facts(bool);
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts { native_tool_search: Some(self.0), ..ModelFacts::default() }
    }
}

fn codec(provider: &str, native_tool_search: bool) -> OpenAiCodec {
    let facts = Arc::new(Facts(native_tool_search));
    let config = match provider {
        "openai-oauth" => {
            let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "0.166.0".into(), beta_features: "remote_compaction_v2".into() };
            OpenAiConfig::codex(false, false, identity, facts, Arc::new(Ctx))
        }
        _ => OpenAiConfig::api_key(false, facts, Arc::new(Ctx)),
    };
    OpenAiCodec::new(config, TransportKind::Http1)
}

#[test]
fn a_freeform_tool_is_sent_as_nodes_custom_tool() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden is JSON");
    let tools: Vec<ToolDefinition> = golden["inputs"]
        .as_array()
        .expect("inputs")
        .iter()
        .map(|tool| ToolDefinition {
            name: tool["name"].as_str().expect("name").to_owned(),
            description: tool["description"].as_str().expect("description").to_owned(),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: false,
            freeform: Freeform::from_definition(tool),
        })
        .collect();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let left_out: Arc<Mutex<Vec<(String, usize, String, String)>>> = Arc::default();
        let sink = left_out.clone();
        let request = ModelRequest {
            model: case["model"].as_str().expect("model").to_owned(),
            messages: vec![
                Message::new(Role::System, Content::Text("You are a fixture assistant.".into())),
                Message::new(Role::User, Content::Text("Patch the file.".into())),
            ],
            tools: tools.clone(),
            options: RequestOptions {
                on_tool_excluded: Some(ToolExclusionSink(Arc::new(move |report| {
                    sink.lock().expect("sink").push((report.name, report.index, report.pointer, report.reason));
                }))),
                ..RequestOptions::default()
            },
        };
        let wire = codec(case["provider"].as_str().expect("provider"), case["nativeToolSearch"].as_bool().expect("flag"))
            .encode(&request)
            .expect("the request encodes");
        let body: Value = serde_json::from_slice(&wire.body).expect("the body is JSON");
        assert_eq!(serde_json::to_string(&body["tools"]).unwrap(), serde_json::to_string(&case["tools"]).unwrap(), "{name}: tools");
        let recorded: Vec<(String, usize, String, String)> = case["excluded"]
            .as_array()
            .expect("excluded")
            .iter()
            .map(|e| {
                (
                    e["name"].as_str().expect("name").to_owned(),
                    usize::try_from(e["index"].as_u64().expect("index")).unwrap(),
                    e["pointer"].as_str().expect("pointer").to_owned(),
                    e["reason"].as_str().expect("reason").to_owned(),
                )
            })
            .collect();
        assert_eq!(*left_out.lock().unwrap(), recorded, "{name}: tools left out");
    }
}
