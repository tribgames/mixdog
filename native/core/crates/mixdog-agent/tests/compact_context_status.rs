//! The `/context` gauge equals Node's `contextStatusForSession` (fixtures/context-status/golden.json,
//! recorded by benchmarks/rust-core/recorders/record-context-status.mjs at a fixed clock).

mod compact_support;

use compact_support::node_message;
use compact_support::node_row;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::Route;
use mixdog_agent::compact::pressure::StatusInput;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::context_status;
use mixdog_agent::compact::tool_schema::RequestTools;
use mixdog_agent::compact::tool_schema::ToolAnnotations;
use mixdog_agent::compact::tool_schema::tool_schema_breakdown;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

struct NoImages;
impl ImageIdentities for NoImages {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

struct RebuiltRows;
impl MessageRows for RebuiltRows {
    fn row(&self, message: &AgentMessage) -> Value {
        node_row(message)
    }
}

fn definitions(tools: &[Value]) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|t| ToolDefinition {
            name: t["name"].as_str().expect("name").to_owned(),
            description: t["description"].as_str().expect("description").to_owned(),
            input_schema: t["inputSchema"].clone(),
            defer_loading: t["deferLoading"] == Value::Bool(true),
        })
        .collect()
}

#[test]
fn status_equals_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/context-status/golden.json")).expect("golden json");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        // The golden keeps Node's own key order, which the tool-schema signature hashes.
        let Some(header) = case["header"].as_object() else {
            assert!(case["status"].is_null(), "{name}: no session has no status");
            continue;
        };
        let messages: Vec<AgentMessage> = case["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &RebuiltRows };
        let wire = case["requestTools"].as_array().expect("requestTools");
        let prefix = case["nativePrefix"].as_u64().expect("nativePrefix") as usize;
        let request_defined = definitions(&wire[prefix..]);
        let session_defined = definitions(case["tools"].as_array().expect("tools"));
        let request_tools = RequestTools { native: &wire[..prefix], defined: &request_defined };
        let breakdown = tool_schema_breakdown(&request_tools, &|_| ToolAnnotations::default());
        assert_eq!(breakdown, case["breakdown"], "{name}: tool schema breakdown");
        let input = StatusInput {
            session: header,
            route: Route {
                provider: case["route"]["provider"].as_str().expect("provider"),
                model: case["route"]["model"].as_str().expect("model"),
                context_window: case["route"]["contextWindow"].clone(),
            },
            cwd: case["cwd"].clone(),
            mode: case["mode"].clone(),
            messages: &messages,
            active: case["active"].as_bool().expect("active"),
            request_tools,
            session_tools: RequestTools { native: &[], defined: &session_defined },
            tool_breakdown: &breakdown,
            agent_mode: case["agentMode"].as_bool().expect("agentMode"),
            meter: &meter,
            signer: &signer,
        };
        assert_eq!(context_status(&input), case["status"], "{name}");
        compared += 1;
    }
    assert_eq!(compared, 14);
}
