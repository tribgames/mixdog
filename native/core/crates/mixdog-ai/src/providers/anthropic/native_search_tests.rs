//! A tool message carrying Node's native tool-search payload (the payloads `parseNativeToolSearchPayload`
//! made of recorded Skill results, `fixtures/native-tool-search/golden.json`) is lowered as Node's
//! `toAnthropicMessages` lowers it: a `tool_reference` for each loaded tool the request ships, the
//! result text otherwise.

use std::collections::HashSet;

use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::effort_tests::message_of;
use super::lowering::LowerContext;
use super::lowering::lower_messages;

#[test]
fn a_native_search_result_is_lowered_as_node_lowers_it() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/native-tool-search/golden.json")).expect("the golden is JSON");
    let owner = ProviderId::from("anthropic");
    let mut compared = 0;
    for case in golden["requests"].as_array().expect("requests").iter().filter(|case| case["wire"] == "anthropic") {
        let messages: Vec<_> = case["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .map(|node| {
                let mut message = message_of(node);
                message.native_tool_search = node.get("nativeToolSearch").cloned();
                message
            })
            .collect();
        let available: HashSet<String> = case["offered"].as_array().expect("offered").iter().map(|name| name.as_str().expect("name").to_owned()).collect();
        let cx = LowerContext { owner: &owner, own_provider: case["provider"].as_str().expect("provider"), available_tools: &available };
        let lowered = Value::Array(lower_messages(&messages, &cx).iter().map(|message| message.to_json()).collect());
        assert_eq!(lowered, case["messagesOut"], "{}", case["name"]);
        compared += 1;
    }
    assert_eq!(compared, 6);
}
