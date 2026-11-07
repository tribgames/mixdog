//! The Gemini tool-acceptance rule against `fixtures/providers/gemini-tool-schema/cases.json`
//! (recorded by `record-gemini-tool-schema.mjs` from the real `geminiAcceptedTools`,
//! `geminiToolExclusion` and `toGeminiTools`).
//!
//! Every report is compared whole: the failure text is Ajv's wording (`compat::ajv_meta`), which
//! reaches the user and the model.

use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;

use super::tool_accept::Declarations;
use super::tool_accept::function_declarations;
use super::tool_accept::gemini_accepted_tools;
use super::tool_accept::gemini_tool_exclusion;
use crate::providers::compat::schema::ToolExclusion;

fn cases() -> Vec<Value> {
    let golden: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/providers/gemini-tool-schema/cases.json")).expect("json");
    golden["cases"].as_array().expect("cases").clone()
}

fn tools(case: &Value) -> Vec<ToolDefinition> {
    case["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| ToolDefinition {
            name: t["name"].as_str().expect("name").into(),
            description: t["description"].as_str().expect("description").into(),
            input_schema: t["inputSchema"].clone(),
            defer_loading: false,
        })
        .collect()
}

fn same_exclusion(id: &str, got: &ToolExclusion, want: &Value) {
    assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}: tool");
    assert_eq!(got.index as u64, want["index"].as_u64().unwrap(), "{id}: index");
    assert_eq!(got.pointer, want["pointer"].as_str().unwrap(), "{id}: pointer");
    assert_eq!(got.reason, want["reason"].as_str().unwrap(), "{id}: reason");
    assert_eq!(got.message, want["message"].as_str().unwrap(), "{id}: message");
}

fn same_exclusions(id: &str, got: &[ToolExclusion], want: &Value) {
    let want = want.as_array().expect("exclusions");
    assert_eq!(got.len(), want.len(), "{id}: excluded tools {got:?}");
    for (got, want) in got.iter().zip(want) {
        same_exclusion(id, got, want);
    }
}

#[test]
fn the_accepted_tools_are_the_ones_node_sends() {
    for case in cases() {
        let id = case["id"].as_str().unwrap();
        let input = tools(&case);
        let mut excluded = Vec::new();
        let kept = gemini_accepted_tools(&input, &mut |e| excluded.push(e));
        let want = case["accepted"]["tools"].as_array().unwrap();
        assert_eq!(kept.len(), want.len(), "{id}: kept tools");
        for (got, want) in kept.iter().zip(want) {
            assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}: kept order");
            assert_eq!(got.input_schema, want["inputSchema"], "{id}: schema of {}", got.name);
        }
        same_exclusions(id, &excluded, &case["accepted"]["excluded"]);
        let unchanged = kept.iter().zip(&input).all(|(got, was)| got.input_schema == was.input_schema);
        assert_eq!(kept.len() == input.len() && unchanged, case["accepted"]["sameList"].as_bool().unwrap(), "{id}: sameList");
    }
}

#[test]
fn the_one_tool_exclusion_is_the_one_node_answers() {
    for case in cases() {
        let id = case["id"].as_str().unwrap();
        let input = tools(&case);
        if input.len() != 1 {
            assert!(case["exclusion"].is_null(), "{id}");
            continue;
        }
        match (gemini_tool_exclusion(&input[0]), &case["exclusion"]) {
            (None, want) => assert!(want.is_null(), "{id}: Node excludes it"),
            (Some(got), want) => {
                assert!(!want.is_null(), "{id}: Node sends it, not {got:?}");
                same_exclusion(id, &got, want);
            }
        }
    }
}

#[test]
fn the_function_declarations_are_the_ones_node_builds() {
    for case in cases() {
        let id = case["id"].as_str().unwrap();
        let input = tools(&case);
        let mut excluded = Vec::new();
        let validated = function_declarations(&input, Declarations::Validated, &mut |e| excluded.push(e));
        assert_eq!(Value::Array(validated), case["validated"]["declarations"], "{id}: validated");
        same_exclusions(id, &excluded, &case["validated"]["excluded"]);
        let plain = function_declarations(&input, Declarations::Plain, &mut |e| panic!("{id}: plain reported {e:?}"));
        assert_eq!(Value::Array(plain), case["plain"], "{id}: plain");
    }
}
