//! The numbers a compaction reports before it summarizes anything equal Node's
//! `runSessionCompaction` (fixtures/compaction-plan/golden.json, recorded by
//! benchmarks/rust-core/recorders/record-compaction-plan.mjs): the plan of an automatic pass (its
//! `below threshold` / `no_token_reduction` result, or none), and the budget a forced pass asks for.

use crate::compact_support;

use compact_support::node_message;
use compact_support::node_row;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::COMPACT_NO_WINDOW;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::Route;
use mixdog_agent::compact::pressure::StatusInput;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::compaction_plan;
use mixdog_agent::compact::pressure::forced_target_budget;
use mixdog_agent::compact::tool_schema::RequestTools;
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
            freeform: None,
        })
        .collect()
}

#[test]
fn the_plan_numbers_equal_nodes() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/compaction-plan/golden.json")).expect("golden json");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let mut differ = Vec::new();
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let header = case["header"].as_object().expect("header");
        let messages: Vec<AgentMessage> = case["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &RebuiltRows };
        let wire = case["requestTools"].as_array().expect("requestTools");
        let prefix = case["nativePrefix"].as_u64().expect("nativePrefix") as usize;
        let request_defined = definitions(&wire[prefix..]);
        let session_defined = definitions(case["tools"].as_array().expect("tools"));
        let input = StatusInput {
            session: header,
            route: Route { provider: header.get("provider").and_then(Value::as_str).unwrap_or(""), model: header.get("model").and_then(Value::as_str).unwrap_or(""), context_window: Value::Null },
            cwd: Value::Null,
            mode: Value::Null,
            messages: &messages,
            active: true,
            request_tools: RequestTools { native: &wire[..prefix], defined: &request_defined },
            session_tools: RequestTools { native: &[], defined: &session_defined },
            tool_breakdown: &Value::Null,
            agent_mode: false,
            meter: &meter,
            signer: &signer,
        };
        // An automatic pass: no plan is Node's null; a pass under its trigger answers `below threshold`;
        // a pass over it only gets as far as the reduction preview here.
        let node = &case["result"]["value"];
        let got = match compaction_plan(&input, true, false).expect("an automatic pass never refuses") {
            None => Value::Null,
            Some(plan) => plan.below_threshold().unwrap_or_else(|| plan.no_token_reduction()),
        };
        if &got != node {
            differ.push(format!("{name}: Rust {got}, Node {node}"));
        }
        // A forced pass: the budget it asks for, and its refusal without a window.
        let forced = forced_target_budget(&input).map_or(Value::Null, mixdog_js::json_number);
        if forced != case["forcedBudget"] {
            differ.push(format!("{name}: forced budget Rust {forced}, Node {}", case["forcedBudget"]));
        }
        match compaction_plan(&input, false, true) {
            Err(message) => {
                if message != COMPACT_NO_WINDOW {
                    differ.push(format!("{name}: refusal {message}"));
                }
            }
            Ok(plan) => {
                let plan = plan.expect("a forced pass has a plan");
                if case["forcedBudget"].is_number() && mixdog_js::json_number(plan.budget) != case["forcedBudget"] {
                    differ.push(format!("{name}: plan budget {} vs forced {}", plan.budget, case["forcedBudget"]));
                }
            }
        }
        compared += 1;
    }
    assert_eq!(compared, 24, "the recorded cases");
    assert!(differ.is_empty(), "{} differ: {}", differ.len(), differ.iter().take(6).cloned().collect::<Vec<_>>().join(" ; "));
}

