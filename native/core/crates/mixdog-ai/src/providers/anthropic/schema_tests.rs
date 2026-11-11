//! The Messages tool-schema rule and the wording of schema failures against
//! `fixtures/providers/schema-wording/cases.json` (recorded by `record-schema-wording.mjs` from
//! the real `sanitizeAnthropicInputSchema`, `wireInputSchema`, `geminiJsonSchemaProblem`,
//! `requestAnthropicTools` and `anthropicToolExclusion`).
//!
//! The failure text is compared whole, pointer and reason: it is the validator's (Ajv's, V8's)
//! words that the user and the model read, so Rust has to produce the same ones.

use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;

use super::anthropic_tool_exclusion;
use crate::providers::action_input::advertise_action_input_union;
use super::body::sanitize_input_schema;
use super::body::wire_tools;
use crate::providers::compat::schema::Problem;
use crate::providers::compat::schema::Rule;
use crate::providers::compat::schema::wire_input_schema;
use crate::providers::compat::schema::wire_problem;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/providers/schema-wording/cases.json")).expect("recorded cases")
}

fn section(name: &str) -> Vec<Value> {
    golden()[name].as_array().expect("section").clone()
}

fn problem_of(recorded: &Value) -> Problem {
    Problem {
        pointer: recorded["pointer"].as_str().expect("pointer").to_owned(),
        reason: recorded["reason"].as_str().expect("reason").to_owned(),
    }
}

#[test]
fn the_flattened_schema_is_the_one_node_builds() {
    for case in section("sanitize") {
        let got = sanitize_input_schema(&case["schema"]);
        // Key order is the wire order (the prompt cache is a byte prefix): compare the text.
        assert_eq!(got.to_string(), case["out"].to_string(), "{}", case["schema"]);
    }
}

#[test]
fn a_per_action_input_carries_the_allowed_input_text() {
    let cases = section("sanitize");
    let with_contract = cases.iter().filter(|c| c["out"]["properties"]["input"]["description"].as_str().is_some_and(|d| d.starts_with("Allowed input by action"))).count();
    assert!(with_contract >= 2, "the recording covers the action contract");
}

#[test]
fn schema_failures_are_worded_as_node_words_them() {
    for case in section("wire") {
        let schema = &case["schema"];
        for (rule, key) in [(Rule::Anthropic, "anthropic"), (Rule::OpenAi, "openai"), (Rule::Gemini, "gemini")] {
            let want = &case[key];
            match wire_input_schema(schema, rule) {
                Ok(got) => assert_eq!(&got, &want["schema"], "{key}: {schema}"),
                Err(got) => assert_eq!(got, problem_of(want), "{key}: {schema}"),
            }
        }
        let want = &case["geminiProblem"];
        let got = wire_problem(schema, Rule::Gemini);
        assert_eq!(got, (!want.is_null()).then(|| problem_of(want)), "gemini problem: {schema}");
    }
}

fn definitions(case: &Value) -> Vec<ToolDefinition> {
    case["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| ToolDefinition {
            name: t["name"].as_str().expect("name").into(),
            description: t["description"].as_str().expect("description").into(),
            input_schema: t["inputSchema"].clone(),
            defer_loading: t["deferLoading"] == Value::Bool(true),
            freeform: None,
        })
        .collect()
}

/// First-party Anthropic takes the nested per-action input alternatives a tool registered, for the
/// flat schema it advertises (`actionInputUnionFor`); a tool nothing registered keeps its schema.
#[test]
fn a_registered_union_goes_out_in_its_nested_form() {
    let unions: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/providers/action-input-union/cases.json")).expect("recorded cases");
    for case in unions["flatten"].as_array().expect("flatten") {
        advertise_action_input_union(&case["nested"]);
    }
    for case in unions["anthropic"].as_array().expect("anthropic") {
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
        let provider = case["provider"].as_str().expect("provider");
        let mut excluded = Vec::new();
        let got = wire_tools(&tools, provider, true, &mut |e| excluded.push(e));
        assert_eq!(&Value::Array(got), &case["sent"], "{provider}");
        assert!(excluded.is_empty() && case["excluded"].as_array().expect("excluded").is_empty(), "{provider}: {excluded:?}");
    }
}

#[test]
fn the_tools_sent_and_left_out_are_the_ones_node_sends() {
    for case in section("anthropic") {
        let id = format!("{} / {}", case["id"], case["provider"]);
        let tools = definitions(&case);
        let sent = case["sent"].as_array().expect("sent");
        let eager = sent.iter().any(|entry| entry.get("eager_input_streaming").is_some());
        let mut excluded = Vec::new();
        let got = wire_tools(&tools, case["provider"].as_str().expect("provider"), eager, &mut |e| excluded.push(e));
        assert_eq!(&Value::Array(got), &case["sent"], "{id}: sent");
        let want = case["excluded"].as_array().expect("excluded");
        assert_eq!(excluded.len(), want.len(), "{id}: excluded {excluded:?}");
        for (got, want) in excluded.iter().zip(want) {
            assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}");
            assert_eq!(got.index as u64, want["index"].as_u64().unwrap(), "{id}");
            assert_eq!(got.pointer, want["pointer"].as_str().unwrap(), "{id}");
            assert_eq!(got.reason, want["reason"].as_str().unwrap(), "{id}");
            assert_eq!(got.message, want["message"].as_str().unwrap(), "{id}");
        }
        for (tool, want) in tools.iter().zip(case["exclusions"].as_array().expect("exclusions")) {
            match (anthropic_tool_exclusion(tool, case["provider"].as_str().expect("provider")), want) {
                (None, want) => assert!(want.is_null(), "{id}: {}", tool.name),
                (Some(got), want) => {
                    assert_eq!(got.pointer, want["pointer"].as_str().unwrap(), "{id}: {}", tool.name);
                    assert_eq!(got.reason, want["reason"].as_str().unwrap(), "{id}: {}", tool.name);
                }
            }
        }
    }
}
