//! Per-action input unions and the Claude bridge schema against
//! `fixtures/providers/action-input-union/cases.json` (recorded by
//! `record-action-input-union.mjs` from the real `flattenActionInputUnion`,
//! `advertiseActionInputUnion`, `actionInputUnionFor`, `claudeBridgeInputSchema` and
//! `toGeminiTools({ claudeBridge: true })`). Failure text is compared whole.

use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;

use super::action_input::action_input_union_for;
use super::action_input::advertise_action_input_union;
use super::action_input::flatten_action_input_union;
use super::compat::schema::Problem;
use super::compat::schema::claude_bridge_input_schema;
use super::google::tool_accept::Declarations;
use super::google::tool_accept::claude_bridge_tool_exclusion;
use super::google::tool_accept::function_declarations;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/providers/action-input-union/cases.json")).expect("recorded cases")
}

fn section(name: &str) -> Vec<Value> {
    golden()[name].as_array().expect("section").clone()
}

/// Every union the recording advertised, in its order (the computer tool's first, as its
/// constructor registers it): the registry the Node answers came from.
fn register_computer() {
    for case in section("flatten") {
        advertise_action_input_union(&case["nested"]);
    }
}

#[test]
fn the_flat_projection_is_the_one_node_advertises() {
    for case in section("flatten") {
        let got = flatten_action_input_union(&case["nested"]);
        // The registry is keyed by the flat schema's text, so key order counts.
        assert_eq!(got.to_string(), case["flat"].to_string(), "{}", case["nested"]);
    }
}

#[test]
fn the_registry_answers_the_nested_union_for_its_flat_projection() {
    for case in section("registry") {
        if case["registered"] == Value::Bool(true) {
            let flat = advertise_action_input_union(&case["nested"]);
            assert_eq!(flat.to_string(), case["flat"].to_string());
            assert_eq!(action_input_union_for(&case["flat"]), case["nested"], "{}", case["flat"]);
            // A changed flat schema is not the registered one.
            let mut changed = case["flat"].clone();
            changed["properties"]["input"]["description"] = Value::String("changed".into());
            assert_eq!(action_input_union_for(&changed), changed);
        } else {
            assert_eq!(action_input_union_for(&case["flat"]), case["flat"], "{}", case["flat"]);
        }
    }
}

#[test]
fn the_claude_bridge_schema_is_the_one_node_builds() {
    register_computer();
    for case in section("bridge") {
        let want = &case["result"];
        let got = claude_bridge_input_schema(&action_input_union_for(&case["schema"]));
        match got {
            Ok(schema) => assert_eq!(&schema, &want["schema"], "{}", case["schema"]),
            Err(Problem { pointer, reason }) => {
                assert_eq!(pointer, want["pointer"].as_str().expect("a failure"), "{}", case["schema"]);
                assert_eq!(reason, want["reason"].as_str().expect("a failure"), "{}", case["schema"]);
            }
        }
    }
}

#[test]
fn a_claude_models_declarations_are_the_ones_node_builds() {
    register_computer();
    for case in section("declarations") {
        let id = case["id"].as_str().expect("id");
        let tools: Vec<ToolDefinition> = case["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| ToolDefinition {
                name: t["name"].as_str().expect("name").into(),
                description: t["description"].as_str().expect("description").into(),
                input_schema: t["inputSchema"].clone(),
                defer_loading: false,
                freeform: None,
            })
            .collect();
        let mut excluded = Vec::new();
        let got = function_declarations(&tools, Declarations::ClaudeBridge, &mut |e| excluded.push(e));
        assert_eq!(Value::Array(got), case["declarations"], "{id}");
        let want = case["excluded"].as_array().expect("excluded");
        assert_eq!(excluded.len(), want.len(), "{id}: {excluded:?}");
        for (got, want) in excluded.iter().zip(want) {
            assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}");
            assert_eq!(got.index as u64, want["index"].as_u64().unwrap(), "{id}");
            assert_eq!(got.pointer, want["pointer"].as_str().unwrap(), "{id}");
            assert_eq!(got.reason, want["reason"].as_str().unwrap(), "{id}");
            assert_eq!(got.message, want["message"].as_str().unwrap(), "{id}");
        }
        // The route rule answers for each tool what the declarations left out.
        for tool in &tools {
            let left_out = excluded.iter().find(|e| e.name == tool.name);
            match (claude_bridge_tool_exclusion(tool), left_out) {
                (None, None) => {}
                (Some(got), Some(want)) => assert_eq!((got.pointer, got.reason), (want.pointer.clone(), want.reason.clone()), "{id}: {}", tool.name),
                (got, want) => panic!("{id}: {}: {got:?} against {want:?}", tool.name),
            }
        }
    }
}
